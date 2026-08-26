/**
 * 装在机器上的 CUDA 工具链：`nvcc` / `ncu` / `compute-sanitizer` / `nvidia-smi`
 *
 * 学员的循环和真机上一样：
 *
 *     nvcc -o bench kernel.cu
 *     ./bench
 *     ncu ./bench
 *     compute-sanitizer --tool racecheck ./bench
 *
 * 命令名、常用 flag、输出的骨架都照真的来。报错文本做不到与 nvcc 逐字节
 * 一致（那是闭源的），这是 design/gpulab.md 里写明的一处 S4 分叉 ——
 * 但**位置、行号、以及「哪一行出错」是准的**。
 */
import type { CommandHandler, CommandResult } from '../../labkit/machine';
import { compileSource } from '../index';
import { CudaCompileError } from '../cuda/lower';
import { CudaSyntaxError } from '../cuda/parser';
import { KernelError } from '../vm/vm';
import { formatRaceReports } from '../vm/sanitizer';
import { formatNvidiaSmi, formatProfile } from './report';
import { materialize, toDim3, type BenchSpec, type GpuWorld, type LaunchSpec } from './world';

const CUDA_VERSION = '13.3';

/** 把参数里的 flag 与位置参数分开 */
function parseArgs(argv: string[]): { flags: Map<string, string | true>; positional: string[] } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq > 0) { flags.set(arg.slice(0, eq), arg.slice(eq + 1)); continue; }
    // `-o bench` / `--tool racecheck` 这种把下一个参数吃掉
    if ((arg === '-o' || arg === '--tool' || arg === '-arch' || arg === '--gpu-architecture')
        && i + 1 < argv.length) {
      flags.set(arg, argv[i + 1]);
      i += 1;
      continue;
    }
    flags.set(arg, true);
  }
  return { flags, positional };
}

function resolve(cwd: string, path: string): string {
  return path.startsWith('/') ? path : `${cwd.replace(/\/$/, '')}/${path}`;
}

/* ------------------------------------------------------------------ */
/* nvcc                                                                */
/* ------------------------------------------------------------------ */

/**
 * 编译。
 *
 * 报错格式贴 nvcc：`kernel.cu(12): error: ...`，下面把出错那一行原样打出来
 * 并用 `^` 指位置，最后一行是 `N error detected in the compilation of "..."`。
 * 学员在真机上见到的就是这个形状。
 */
export function createNvcc(world: GpuWorld): CommandHandler {
  return async ({ argv, cwd, vfs }) => {
    const { flags, positional } = parseArgs(argv);

    if (flags.has('--version') || flags.has('-V')) {
      return {
        stdout: [
          'nvcc: NVIDIA (R) Cuda compiler driver',
          'Copyright (c) 2005-2026 NVIDIA Corporation',
          `Cuda compilation tools, release ${CUDA_VERSION}`,
          '',
        ].join('\n'),
      };
    }

    const sources = positional.filter((path) => path.endsWith('.cu'));
    if (!sources.length) {
      return { stderr: 'nvcc fatal   : No input files specified\n', code: 1 };
    }

    const output = typeof flags.get('-o') === 'string' ? (flags.get('-o') as string) : 'a.out';
    const merged: string[] = [];

    for (const source of sources) {
      const path = resolve(cwd, source);
      if (!vfs.exists(path)) {
        return { stderr: `nvcc fatal   : Cannot open input file '${source}'\n`, code: 1 };
      }
      merged.push(vfs.readFile(path));
    }

    const text = merged.join('\n');
    const displayName = sources[0].split('/').pop() ?? sources[0];

    try {
      const kernels = await compileSource(text);
      world.artifacts.set(resolve(cwd, output), {
        path: resolve(cwd, output),
        kernels,
        sources: sources.map((source) => resolve(cwd, source)),
      });
      // 磁盘上留一个真的文件，`ls` / `cat` 看得见
      vfs.writeFile(resolve(cwd, output), `#!gpulab-binary\n${[...kernels.keys()].join('\n')}\n`);
      // 让 `./bench` 能敲。
      //
      // labkit 的 shell 只按名字查已注册的命令，不会去磁盘上找可执行文件 ——
      // 「执行 VFS 里的文件」是机器层该有的能力，但那是 labkit 的事，
      // 不该在 gpulab 这一片顺手改共享代码。这里按学员实际会敲的两种写法
      // 各注册一次，够用且不外溢。
      const basename = output.replace(/^\.\//, '').split('/').pop() ?? output;
      const runner = createBenchRunner(world, resolve(cwd, output));
      world.machine.install(`./${basename}`, runner);
      world.machine.install(basename, runner);
      return { code: 0 };
    } catch (error) {
      return { stderr: diagnose(error, text, displayName), code: 1 };
    }
  };
}

function diagnose(error: unknown, source: string, fileName: string): string {
  const lines = source.split('\n');
  let line = 0;
  let column = 1;
  let message = String((error as Error)?.message ?? error);

  if (error instanceof CudaCompileError || error instanceof CudaSyntaxError) {
    line = error.line;
    column = error.column;
    // 类里已经把 `行:列: ` 拼进 message 了，打印时去掉免得重复
    message = message.replace(/^\d+:\d+:\s*/, '');
  }

  const out: string[] = [];
  if (line > 0) {
    out.push(`${fileName}(${line}): error: ${message}`);
    const text = lines[line - 1];
    if (text !== undefined) {
      out.push(`      ${text.trim()}`);
      // `^` 对到 trim 之后的位置
      const lead = text.length - text.trimStart().length;
      out.push(`      ${' '.repeat(Math.max(0, column - 1 - lead))}^`);
    }
  } else {
    out.push(`nvcc error   : ${message}`);
  }
  out.push('');
  out.push(`1 error detected in the compilation of "${fileName}".`);
  out.push('');
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* 跑一个编出来的程序                                                   */
/* ------------------------------------------------------------------ */

export interface RunOptions {
  /** 开着 racecheck 跑 */
  racecheck?: boolean;
}

export class BenchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchError';
  }
}

/**
 * 跑 `./bench`：按世界里的声明分配缓冲区、填数据、依次起 kernel。
 *
 * 每次跑都从头分配与填充 —— 跑两遍必须得到同样的结果，
 * 否则「重放一致」这条门槛就不成立了。
 */
export async function runBench(
  world: GpuWorld,
  binaryPath: string,
  options: RunOptions = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  const artifact = world.artifacts.get(binaryPath);
  if (!artifact) {
    return { stdout: '', stderr: `${binaryPath}: 还没编译，先跑 nvcc\n`, code: 127 };
  }
  const bench = world.spec.bench;
  if (!bench) {
    return { stdout: '', stderr: '这一关没有声明 bench，无法运行\n', code: 1 };
  }

  // racecheck 是**额外**跑的一遍，不能把真实那一遍的指标冲掉 ——
  // 门槛读的是真实那一遍。先存住，跑完再放回去。
  const preserved = options.racecheck ? world.gpu.snapshotCounters() : null;

  // 重新建一台干净的设备：显存内容、分配游标、指标全部归零
  world.gpu.reset();
  world.buffers.clear();

  const seed = world.spec.seed ?? 1;
  for (const buffer of bench.buffers) {
    const data = materialize(buffer, seed);
    const address = world.gpu.malloc(buffer.length * 4);
    if (buffer.type === 'int') world.gpu.copyInInts(address, data as Int32Array);
    else world.gpu.copyIn(address, data as Float32Array);
    world.buffers.set(buffer.name, {
      address, length: buffer.length, type: buffer.type ?? 'float',
    });
  }

  const startedAt = Date.now();
  const out: string[] = [];

  for (const launch of bench.launches) {
    const kernel = artifact.kernels.get(launch.kernel);
    if (!kernel) {
      return {
        stdout: out.join('\n'),
        stderr: `找不到 kernel \`${launch.kernel}\` —— 编出来的有：${[...artifact.kernels.keys()].join(', ')}\n`,
        code: 1,
      };
    }
    const args = launch.args.map((arg) => {
      if (typeof arg === 'number') return arg;
      const buffer = world.buffers.get(arg);
      if (!buffer) throw new BenchError(`bench 里引用了不存在的缓冲区 \`${arg}\``);
      return buffer.address;
    });

    try {
      if (options.racecheck) {
        world.gpu.launchWithRacecheck(kernel, {
          grid: toDim3(launch.grid), block: toDim3(launch.block),
        }, args);
      } else {
        world.gpu.launch(kernel, {
          grid: toDim3(launch.grid), block: toDim3(launch.block),
        }, args);
      }
    } catch (error) {
      const detail = error instanceof KernelError
        ? `${launch.kernel}: ${error.message}`
        : String((error as Error)?.message ?? error);
      return { stdout: out.join('\n'), stderr: `${detail}\n`, code: 1 };
    }
  }

  if (preserved) world.gpu.restoreCounters(preserved);
  world.lastRun = { artifact, launches: bench.launches, wallClockMs: Date.now() - startedAt };
  out.push(`launched ${bench.launches.length} kernel(s) on ${world.device.name}`);
  return { stdout: `${out.join('\n')}\n`, stderr: '', code: 0 };
}

/** 从 argv 里认出「要跑哪个程序」 —— `./bench` / `bench` / 绝对路径都认 */
function targetOf(cwd: string, positional: string[]): string | null {
  const target = positional.find((arg) => !arg.startsWith('-'));
  if (!target) return null;
  return resolve(cwd, target.replace(/^\.\//, ''));
}

export function createBenchRunner(world: GpuWorld, binaryPath: string): CommandHandler {
  return async () => runBench(world, binaryPath);
}

/* ------------------------------------------------------------------ */
/* ncu                                                                 */
/* ------------------------------------------------------------------ */

export function createNcu(world: GpuWorld): CommandHandler {
  return async ({ argv, cwd }): Promise<CommandResult> => {
    const { positional } = parseArgs(argv);
    const target = targetOf(cwd, positional);
    if (!target) {
      return { stderr: 'ncu: 要给一个可执行文件，比如 `ncu ./bench`\n', code: 1 };
    }

    const run = await runBench(world, target);
    if (run.code !== 0) return run;

    const artifact = world.artifacts.get(target)!;
    const bench = world.spec.bench!;
    const lines: string[] = [
      '==PROF== Connected to process 1',
    ];
    for (const launch of bench.launches) {
      lines.push(`==PROF== Profiling "${launch.kernel}" - 0: 0%....50%....100% - 1 pass`);
    }
    lines.push('==PROF== Disconnected from process 1');
    lines.push(`[1] ${target.split('/').pop()}`);

    const first = bench.launches[0];
    const kernel = artifact.kernels.get(first.kernel)!;
    lines.push(formatProfile({
      kernelName: first.kernel,
      signature: kernel.params.map((param) =>
        `${param.isPointer ? `${param.ty === 'f32' ? 'float' : 'int'} *` : param.ty === 'f32' ? 'float' : 'int'}`
      ).join(', '),
      device: world.device,
      metrics: world.gpu.metrics(),
      stat: world.gpu.staticMetrics(),
    }));
    lines.push('');
    return { stdout: `${lines.join('\n')}\n`, code: 0 };
  };
}

/* ------------------------------------------------------------------ */
/* compute-sanitizer                                                   */
/* ------------------------------------------------------------------ */

export function createComputeSanitizer(world: GpuWorld): CommandHandler {
  return async ({ argv, cwd }): Promise<CommandResult> => {
    const { flags, positional } = parseArgs(argv);
    const tool = typeof flags.get('--tool') === 'string' ? (flags.get('--tool') as string) : 'memcheck';
    const target = targetOf(cwd, positional);
    if (!target) {
      return {
        stderr: 'compute-sanitizer: 要给一个可执行文件，比如 `compute-sanitizer --tool racecheck ./bench`\n',
        code: 1,
      };
    }

    if (tool !== 'racecheck' && tool !== 'memcheck' && tool !== 'synccheck') {
      return { stderr: `compute-sanitizer: 暂不支持 --tool ${tool}（有 memcheck / racecheck / synccheck）\n`, code: 1 };
    }

    const run = await runBench(world, target, { racecheck: tool === 'racecheck' });

    // memcheck 与 synccheck 的检查在 VM 里是常开的：越界会抛、发散屏障会抛。
    // 所以跑挂了就是它们报出来的东西。
    if (run.code !== 0) {
      return {
        stdout: '========= COMPUTE-SANITIZER\n',
        stderr: `========= ${run.stderr.trim()}\n========= ERROR SUMMARY: 1 error\n`,
        code: 1,
      };
    }

    if (tool === 'racecheck') {
      const kernelName = world.spec.bench?.launches[0]?.kernel ?? 'kernel';
      const report = world.gpu.sanitizerReport();
      const text = formatRaceReports(report, kernelName);
      return {
        stdout: `${text}\n`,
        code: report.races.length ? 1 : 0,
      };
    }

    return {
      stdout: '========= COMPUTE-SANITIZER\n========= ERROR SUMMARY: 0 errors\n',
      code: 0,
    };
  };
}

/* ------------------------------------------------------------------ */
/* nvidia-smi                                                          */
/* ------------------------------------------------------------------ */

export function createNvidiaSmi(world: GpuWorld): CommandHandler {
  return async () => ({
    stdout: `${formatNvidiaSmi(world.device, world.gpu.usedBytes)}\n`,
    code: 0,
  });
}

/** 把整套工具链装到机器上 */
export function installToolchain(world: GpuWorld): void {
  world.machine.install('nvcc', createNvcc(world));
  world.machine.install('ncu', createNcu(world));
  world.machine.install('compute-sanitizer', createComputeSanitizer(world));
  world.machine.install('nvidia-smi', createNvidiaSmi(world));
  // `./bench` 走 shell 的「执行磁盘上的文件」路径，见 lab/index.ts
}

export type { BenchSpec, LaunchSpec };
