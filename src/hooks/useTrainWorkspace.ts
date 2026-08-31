/**
 * train 工作台的会话状态
 *
 * 一个世界（算子核 + Python 会话 + 语料 + 日志），所有面板都从它取数据。
 * 和 ops / gpu 一样的定论：**单一数据源、单向数据流，面板之间不发消息**。
 * 在终端里 `python train.py` 之后，训练面板上的曲线变了 ——
 * 不是因为终端通知了它，而是两边看的本来就是同一个世界。
 *
 * 世界是个可变对象，React 看不见它内部的变化，所以每跑完一条命令就把
 * `revision` 加一，面板的投影挂在这个数上重算。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildWorld, mergeWorldSpec, type TrainWorld } from '../lib/llmlab/lab';
import type { TrainWorldSpec } from '../lib/llmlab/lab/spec';
import type { TrainStageSpec } from '../lib/engineering/types';
import type { TrainingLogView } from '../lib/llmlab/bridge';

export type TrainBootStatus = 'idle' | 'booting' | 'ready' | 'error';

export interface UseTrainWorkspaceOptions {
  /** 项目级的世界 */
  world?: TrainWorldSpec;
  /** 这一关的增量 */
  stage?: TrainStageSpec;
  /** 关卡编号变了就重建世界 */
  stageKey: string;
  /** IDE 里的草稿，开局覆盖到虚拟文件系统上 */
  files?: Record<string, string>;
}

export interface CommandRecord {
  command: string;
  output: string;
  ok: boolean;
}

export interface TrainWorkspaceState {
  world: TrainWorld | null;
  status: TrainBootStatus;
  error?: string;
  /** 世界变过几次 —— 面板要重算什么就把这个数放进依赖 */
  revision: number;
  /** 重建过几次 —— 终端与编辑器按它重挂 */
  generation: number;
  history: CommandRecord[];
  prompt: string;
  /** 这一关摆在盘上的源文件 */
  sourcePaths: string[];
  log: TrainingLogView;
  runCommand(line: string): Promise<string>;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  reboot(): void;
}

const EMPTY_LOG: TrainingLogView = {
  steps: [], scalars: {}, samples: [], attention: [], histograms: [], reported: {},
};

/** 浏览器里资产都在 public 下 */
const WASM_URL = '/llmlab/llmlab-kernels.wasm';
const PYODIDE_URL = '/llmlab/pyodide/';

export function useTrainWorkspace(options: UseTrainWorkspaceOptions): TrainWorkspaceState {
  const { stageKey } = options;
  const [world, setWorld] = useState<TrainWorld | null>(null);
  const [status, setStatus] = useState<TrainBootStatus>('idle');
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [history, setHistory] = useState<CommandRecord[]>([]);

  /*
   * 把最新的入参放进 ref。
   *
   * 世界只在换关卡 / 手动重启时重建，**不能挂在 files 上** ——
   * 学员每敲一个字 files 就是一个新对象，挂上去会一直重建世界，
   * 而重建一次要拉起 Pyodide（约 1 秒）。
   */
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let cancelled = false;
    setStatus('booting');
    setError(undefined);
    setWorld(null);

    (async () => {
      try {
        const current = optionsRef.current;
        const spec = mergeWorldSpec(current.world, {
          ...(current.stage?.world ?? {}),
          machine: {
            files: { ...(current.stage?.files ?? {}), ...(current.files ?? {}) },
          },
        });
        const response = await fetch(WASM_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`取算子核失败：HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();

        const built = await buildWorld({
          wasmBytes: bytes,
          python: { indexURL: PYODIDE_URL },
          spec,
          // 浏览器主线程编不动 37KB 的 wasm，走异步那条
          sync: false,
        });
        if (cancelled) return;

        for (const command of current.stage?.setupCommands ?? []) {
          await runIn(built, command);
        }
        setWorld(built);
        setStatus('ready');
        setHistory([]);
        setRevision((n) => n + 1);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    })();

    return () => { cancelled = true; };
  }, [stageKey, generation]);

  const runCommand = useCallback(async (line: string): Promise<string> => {
    if (!world) return '世界还没起来\r\n';
    const result = await runIn(world, line);
    setHistory((h) => [...h, { command: line, output: result, ok: true }]);
    setRevision((n) => n + 1);
    return result.replace(/\n/g, '\r\n');
  }, [world]);

  const readFile = useCallback((path: string): string => {
    if (!world) return '';
    try {
      return world.session.py.readFile(absolute(path));
    } catch {
      return '';
    }
  }, [world]);

  const writeFile = useCallback((path: string, content: string): void => {
    if (!world) return;
    world.session.py.writeFile(absolute(path), content);
  }, [world]);

  const sourcePaths = useMemo(() => {
    const files = { ...(options.stage?.files ?? {}) };
    return Object.keys(files).sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageKey]);

  const log = world ? world.rt.log.view() : EMPTY_LOG;
  const prompt = `${options.stage?.entry ? '' : ''}~ $ `;

  return {
    world, status, error, revision, generation, history, prompt, sourcePaths,
    log, runCommand, readFile, writeFile,
    reboot: () => setGeneration((n) => n + 1),
  };
}

function absolute(path: string): string {
  return path.startsWith('/') ? path : `/lab/${path}`;
}

/**
 * 一个很小的命令处理器。
 *
 * **不是一个真 shell，这个边界要说清。** 支持的是 `python <file>`、
 * `ls` / `cat` / `head` / `pwd` 这几条，而且它们都是**转给 Python 执行的** ——
 * 文件系统的主人是 Pyodide，让它自己回答比在 JS 里镜像一份可靠。
 *
 * 为什么不接 labkit 那套完整 shell（opslab / gpulab 用的那个）：
 * 它管的是自己的 VFS，而这里的文件全在 Pyodide 的 FS 里。桥接两套文件系统
 * 的工作量远大于收益 —— 这个项目里终端的作用是「跑我的脚本、看看盘上有什么」，
 * 不是学 shell。真要 shell，那是 opslab 的内容。
 */
async function runIn(world: TrainWorld, line: string): Promise<string> {
  const trimmed = line.trim();
  if (!trimmed) return '';
  const [cmd, ...args] = trimmed.split(/\s+/);

  try {
    switch (cmd) {
      case 'python':
      case 'python3': {
        if (!args[0]) return 'python: 要给一个脚本名\n';
        if (args[0] === '-m') {
          world.session.py.drainOutput();
          world.session.py.run(`import runpy; runpy.run_module(${JSON.stringify(args[1] ?? '')}, run_name="__main__")`);
          const out = world.session.py.drainOutput();
          return out.stdout + out.stderr;
        }
        const path = absolute(args[0]);
        const source = world.session.py.readFile(path);
        const out = world.session.runScript(args[0], source);
        world.revision += 1;
        return out.stdout + out.stderr;
      }
      case 'ls': {
        const dir = absolute(args[0] ?? '.').replace(/\/\.$/, '');
        return String(world.session.py.run(`
import os
"\\n".join(sorted(os.listdir(${JSON.stringify(dir)}))) + "\\n"
`));
      }
      case 'cat': {
        if (!args[0]) return 'cat: 要给一个文件名\n';
        return world.session.py.readFile(absolute(args[0]));
      }
      case 'head': {
        const n = args[0] === '-n' ? Number(args[1]) : 20;
        const file = args[0] === '-n' ? args[2] : args[0];
        if (!file) return 'head: 要给一个文件名\n';
        const text = world.session.py.readFile(absolute(file));
        return `${text.split('\n').slice(0, n).join('\n')}\n`;
      }
      case 'pwd':
        return '/lab\n';
      case 'help':
        return [
          '这个终端支持的命令（不是一个完整的 shell）：',
          '  python <文件>            跑你的脚本',
          '  python -m <模块>         跑一个模块',
          '  ls [目录] / cat <文件>   看看盘上有什么',
          '  head [-n N] <文件>       看开头几行',
          '',
        ].join('\n');
      default:
        return `${cmd}: 这个终端不支持这条命令。敲 help 看支持哪些。\n`;
    }
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n`;
  }
}
