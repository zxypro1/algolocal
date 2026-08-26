/**
 * `@gpu/lab` —— GPU 关卡的隐藏用例能拿到的东西
 *
 * 和 `@ops/lab` 一个路子：判定读的是**工作台里那个世界**，不是另起一个
 * 干净的设备。学员在终端里编过、跑过的东西必须算数。
 *
 * 判定的三个证据来源：
 *  1. **终态** —— `buffer()` 把显存里的结果读回来；
 *  2. **行为探测** —— `sh()` / `build()` / `run()` 由平台自己跑，学员改不了；
 *  3. **过程指标** —— `metrics()`，也就是门槛读的那棵树。
 */
import type { GpuMetrics, StaticMetrics } from '../metrics';
import type { RooflinePoint, TimingResult } from '../timing';
import type { SanitizerReport } from '../vm/sanitizer';
import type { CommandRecord } from '../../labkit/machine';
import { ulpDistanceOf } from './numeric';
import { runBench } from './cli';
import type { GpuWorld } from './world';

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 一组数和参考值差多少 */
export interface Deviation {
  /** 最大绝对误差 */
  maxAbs: number;
  /**
   * 最大相对误差。分母用 `max(1, |expected|)`，
   * 避免参考值接近 0 时相对误差炸掉。
   */
  maxRel: number;
  /** 最大 ulp 距离 —— 在整个数值范围上是同一把尺子 */
  maxUlp: number;
  /** 第一个超出容差的下标，全在容差内就是 -1 */
  firstBadIndex: number;
  /** 有没有 NaN 或 Inf */
  hasNonFinite: boolean;
}

export interface GpuLabApi {
  /** 敲一条命令（平台身份） */
  sh(command: string): Promise<ShellResult>;
  /** `nvcc -o bench <世界里声明的源文件>` 的简写 */
  build(): Promise<ShellResult>;
  /** 跑 `./bench` */
  run(): Promise<ShellResult>;
  /** 编译 + 运行，任一步失败就抛 —— 用例里最常用的那条路 */
  buildAndRun(): Promise<void>;
  /** 开着 racecheck 再跑一遍 */
  racecheck(): Promise<SanitizerReport>;

  /** 门槛读的那棵指标树 */
  metrics(): GpuMetrics;
  /** 寄存器 / 共享内存 / 占用率 */
  staticMetrics(): StaticMetrics | null;
  /**
   * 时序估算。**只能用来做同关的相对比较**，不要写成绝对阈值的断言 ——
   * 这个模型没有真卡可校准，绝对值不可迁移。
   */
  timing(): TimingResult;
  /** roofline 上的那个点 */
  roofline(): RooflinePoint;

  /** 把一个缓冲区读回来 */
  buffer(name: string): Float32Array;
  bufferInts(name: string): Int32Array;

  /** 和参考值比一比 */
  compare(actual: ArrayLike<number>, expected: ArrayLike<number>): Deviation;

  /** 机器磁盘 */
  readFile(path: string): string | undefined;
  exists(path: string): boolean;
  /** 学员敲过的每一条命令 */
  transcript(): CommandRecord[];

  /** 需要更底层的东西时的出口 */
  world: GpuWorld;
}

export function createGpuLabModules(world: GpuWorld): Record<string, unknown> {
  return { '@gpu/lab': createGpuLabApi(world) };
}

export class GpuLabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpuLabError';
  }
}

export function createGpuLabApi(world: GpuWorld): GpuLabApi {
  const binary = '/root/bench';

  const build = async (): Promise<ShellResult> => {
    const sources = world.spec.bench?.sources ?? [];
    if (!sources.length) throw new GpuLabError('这一关没有声明要编译的源文件');
    return world.run(`nvcc -o bench ${sources.join(' ')}`);
  };

  return {
    sh: (command) => world.run(command),
    build,
    run: () => runBench(world, binary),

    async buildAndRun() {
      const compiled = await build();
      if (compiled.code !== 0) {
        throw new GpuLabError(`编译没通过：\n${compiled.stderr.trim()}`);
      }
      const ran = await runBench(world, binary);
      if (ran.code !== 0) {
        throw new GpuLabError(`跑挂了：\n${ran.stderr.trim()}`);
      }
    },

    racecheck: async () => {
      await runBench(world, binary, { racecheck: true });
      return world.gpu.sanitizerReport();
    },

    metrics: () => world.gpu.metrics(),
    staticMetrics: () => world.gpu.staticMetrics(),
    timing: () => world.gpu.timing(),
    roofline: () => world.gpu.roofline(),

    buffer(name) {
      const buffer = world.buffers.get(name);
      if (!buffer) {
        throw new GpuLabError(
          `没有叫 \`${name}\` 的缓冲区 —— 有的是：${[...world.buffers.keys()].join(', ') || '（还没跑过 ./bench）'}`
        );
      }
      return world.gpu.copyOut(buffer.address, buffer.length);
    },

    bufferInts(name) {
      const buffer = world.buffers.get(name);
      if (!buffer) throw new GpuLabError(`没有叫 \`${name}\` 的缓冲区`);
      return world.gpu.copyOutInts(buffer.address, buffer.length);
    },

    compare(actual, expected) {
      const length = Math.min(actual.length, expected.length);
      let maxAbs = 0;
      let maxRel = 0;
      let maxUlp = 0;
      let firstBadIndex = -1;
      let hasNonFinite = false;

      for (let i = 0; i < length; i += 1) {
        const a = actual[i];
        const b = expected[i];
        if (!Number.isFinite(a)) {
          hasNonFinite = true;
          if (firstBadIndex < 0) firstBadIndex = i;
          continue;
        }
        const abs = Math.abs(a - b);
        const rel = abs / Math.max(1, Math.abs(b));
        const ulp = ulpDistanceOf(Math.fround(a), Math.fround(b));
        if (abs > maxAbs) maxAbs = abs;
        if (rel > maxRel) { maxRel = rel; if (firstBadIndex < 0 && rel > 1e-3) firstBadIndex = i; }
        if (ulp > maxUlp) maxUlp = ulp;
      }

      return { maxAbs, maxRel, maxUlp, firstBadIndex, hasNonFinite };
    },

    readFile: (path) => (world.machine.vfs.exists(path) ? world.machine.vfs.readFile(path) : undefined),
    exists: (path) => world.machine.vfs.exists(path),
    transcript: () => world.machine.transcript(),

    world,
  };
}
