/**
 * gpu 工作台的会话状态
 *
 * 一个世界（机器 + 设备/集群 + 整套 CUDA 工具链），所有面板都从它取数据。
 * 和 ops 那边一样的定论：**单一数据源、单向数据流，面板之间不发消息**。
 * 在终端里 `nvcc` 一下，剖析面板上的数字就变了 —— 不是因为终端通知了它，
 * 而是因为两边看的本来就是同一台设备。
 *
 * 世界是个可变对象，React 看不见它内部的变化，所以每跑完一条命令就把
 * `revision` 加一，面板的投影挂在这个数上重算。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommandRecord } from '../lib/labkit/machine';
import { buildWorld, type GpuWorld, type GpuWorldSpec } from '../lib/gpulab/lab';
import type { GpuStageSpec } from '../lib/engineering/types';

export type GpuBootStatus = 'idle' | 'booting' | 'ready' | 'error';

export interface UseGpuWorkspaceOptions {
  /** 项目级的世界 */
  world?: GpuWorldSpec;
  /** 这一关的增量（文件、bench、以及集群关卡的世界覆盖） */
  stage?: GpuStageSpec;
  /** 关卡编号变了就重建世界 */
  stageKey: string;
  /** IDE 里的草稿，开局覆盖到机器磁盘上 */
  files?: Record<string, string>;
}

export interface GpuWorkspaceState {
  world: GpuWorld | null;
  /** 世界变过几次 —— 面板要重算什么，就把这个数放进依赖里 */
  revision: number;
  status: GpuBootStatus;
  error?: string;
  history: CommandRecord[];
  prompt: string;
  /** 这一关的源文件路径（IDE 的文件树） */
  sourcePaths: string[];
  /** 终端调它；返回要打印的文本（已转成 \r\n） */
  runCommand(line: string): Promise<string>;
  /** 编辑器保存：写回机器磁盘 */
  writeFile(path: string, content: string): void;
  readFile(path: string): string;
  /** 从头再来 */
  reboot(): void;
  /** 重置过几次。世界被推倒重来之后，挂在旧世界上的结论就该作废 */
  generation: number;
}

/**
 * 关卡的世界 = 项目级的世界 + 关卡级的覆盖。
 *
 * 集群关卡靠这个把卡数从 1 提到 8 —— 前 21 关是单卡的，
 * 让它们白白多出七张空转的卡没有任何好处。
 * 和 `tests/gpulab/stages.test.ts` 里判定时的合并方式必须一致，
 * 不然「工作台上跑通了、验收却挂」。
 */
export function mergeGpuWorld(
  world: GpuWorldSpec | undefined,
  stage: GpuStageSpec | undefined,
  files: Record<string, string>
): GpuWorldSpec {
  return {
    ...(world ?? {}),
    ...(stage?.world ?? {}),
    ...(stage?.sharedBytesPerBlock ? { sharedBytesPerBlock: stage.sharedBytesPerBlock } : {}),
    machine: {
      ...(world?.machine ?? {}),
      files: {
        ...(world?.machine?.files ?? {}),
        ...(stage?.files ?? {}),
        ...files,
      },
    },
    bench: stage?.bench ?? world?.bench,
  };
}

export function useGpuWorkspace(options: UseGpuWorkspaceOptions): GpuWorkspaceState {
  const { stageKey } = options;
  const [world, setWorld] = useState<GpuWorld | null>(null);
  const [status, setStatus] = useState<GpuBootStatus>('idle');
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [history, setHistory] = useState<CommandRecord[]>([]);

  /**
   * 建世界只在浏览器里做。
   *
   * CUDA 前端要加载 tree-sitter 的 wasm，SSR 阶段没有它 ——
   * 但**建世界本身是同步的**（和 ops 不同，那边要等真 CLI 的 wasm），
   * wasm 是第一次 `nvcc` 时才按需加载。所以这里不需要 async 边界，
   * 也就没有「世界还没好就渲染」的中间态。
   */
  useEffect(() => {
    setStatus('booting');
    setError(undefined);
    setHistory([]);
    try {
      const next = buildWorld(mergeGpuWorld(options.world, options.stage, options.files ?? {}));
      setWorld(next);
      setStatus('ready');
      setRevision((value) => value + 1);
    } catch (bootError) {
      setError(bootError instanceof Error ? bootError.message : String(bootError));
      setStatus('error');
    }
    // 只在换关卡或重置时重建。依赖里放对象会每次渲染都重建世界，
    // 那样学员敲进去的东西一眨眼就没了。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageKey, generation]);

  const runCommand = useCallback(async (line: string): Promise<string> => {
    if (!world) return '设备还没准备好\r\n';
    const record = await world.machine.exec(line);
    setHistory(world.machine.transcript().slice());
    setRevision((value) => value + 1);
    const text = [record.stdout, record.stderr].filter(Boolean).join('');
    return text.replace(/\n/g, '\r\n');
  }, [world]);

  const writeFile = useCallback((path: string, content: string) => {
    if (!world) return;
    world.machine.vfs.writeFile(path, content);
    // 改源码不改变设备状态，所以**不动 revision** ——
    // 动了的话每敲一个字符都会让剖析面板重算一遍上一次运行的指标
  }, [world]);

  const readFile = useCallback((path: string): string => {
    if (!world || !world.machine.vfs.exists(path)) return '';
    return world.machine.vfs.readFile(path);
  }, [world]);

  const reboot = useCallback(() => {
    setGeneration((value) => value + 1);
  }, []);

  const sourcePaths = useMemo(() => {
    const declared = options.stage?.bench?.sources ?? options.world?.bench?.sources ?? [];
    const fromFiles = Object.keys(options.stage?.files ?? {});
    // 声明过的源文件排在前面，其余（头文件之类）跟在后面
    return [...new Set([...declared, ...fromFiles])];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageKey]);

  // 提示符跟着 cwd 走，所以要挂在 revision 上重算
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prompt = useMemo(() => world?.machine.prompt() ?? '$ ', [world, revision]);

  return {
    world, revision, status, error, history, prompt, sourcePaths,
    runCommand, writeFile, readFile, reboot, generation,
  };
}
