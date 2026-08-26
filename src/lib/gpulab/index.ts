/**
 * gpulab —— CUDA GPU 编程实战工作台
 *
 * 设计见 design/gpulab.md。这一层是给关卡与判定用的门面：
 * 一段 CUDA 源码进去，跑完之后的内存与指标出来。
 */
import { compileKernel } from './ir/compile';
import { encode, type ExecutableKernel } from './ir/program';
import type { CompiledKernel } from './ir/types';
import { lowerTranslationUnit } from './cuda/lower';
import { parseCuda, type CudaParserOptions } from './cuda/parser';
import { flattenMetrics, staticMetricsOf, toMetrics, type GpuMetrics, type StaticMetrics } from './metrics';
import { H100, computeOccupancy, type DeviceSpec } from './device';
import { LinearMemory } from './vm/memory';
import { RaceDetector, formatRaceReports, type SanitizerReport } from './vm/sanitizer';
import { emptyCounters, launchKernel, type Dim3, type GpuCounters, type LaunchConfig, type KernelArg } from './vm/vm';

export { CudaSyntaxError, parseCuda, resetCudaParser } from './cuda/parser';
export { CudaCompileError } from './cuda/lower';
export { KernelError, dim3, launchKernel } from './vm/vm';
export { LinearMemory, MemoryFault, SECTOR_BYTES, WARP_SIZE } from './vm/memory';
export { flattenMetrics, staticMetricsOf, toMetrics } from './metrics';
export { H100, B200, DEVICES, computeOccupancy } from './device';
export type { DeviceSpec, Occupancy } from './device';
export type { StaticMetrics } from './metrics';
export { RaceDetector, formatRaceReports } from './vm/sanitizer';
export type { SanitizerReport, RaceReport } from './vm/sanitizer';
export type { GpuMetrics } from './metrics';
export type { CompiledKernel } from './ir/types';
export { encode } from './ir/program';
export type { ExecutableKernel } from './ir/program';
export type { Dim3, LaunchConfig, KernelArg, GpuCounters } from './vm/vm';

/** 编译一份源码，返回里面所有的 kernel */
export async function compileSource(
  source: string,
  options?: CudaParserOptions
): Promise<Map<string, ExecutableKernel>> {
  const root = await parseCuda(source, options);
  const unit = lowerTranslationUnit(root);
  const kernels = new Map<string, ExecutableKernel>();
  for (const kernel of unit.kernels) {
    // 编码只做一次 —— 一关会 launch 很多次，每次重编是白费的
    kernels.set(kernel.name, encode(compileKernel(kernel)));
  }
  return kernels;
}

export interface DeviceOptions {
  /** 全局显存大小。默认 64MB —— 关卡的规模远小于此，超了就是题目出大了。 */
  globalBytes?: number;
  /** 每个 block 的共享内存上限。默认 48KB，和不显式提高时的 CUDA 一致。 */
  sharedBytesPerBlock?: number;
  /**
   * 用哪张卡的参数。默认 H100。
   *
   * 换成 B200 之后学员的 kernel 一个字都不用改 —— 变的只是占用率、
   * 带宽与各单元的吞吐比例。见 design/gpulab.md 拍板记录第 2 条。
   */
  device?: DeviceSpec;
  /**
   * 执行预算：跑到这么多条 warp 指令还没停就报错。
   *
   * 防的是学员写错的死循环。默认按「判定最多跑十来秒」定，
   * 关卡可以按自己的规模调小，好让出错时更快看到反馈。
   */
  maxWarpInsts?: number;
}

/**
 * 一台（模拟的）设备。
 *
 * 显存、分配器、指标都挂在它上面 —— 一次判定就是「建一台设备、
 * 拷数据进去、launch 几次、把结果拷出来看」。
 */
export class GpuDevice {
  readonly memory: LinearMemory;
  private readonly sharedCapacity: number;
  private readonly maxWarpInsts: number | undefined;
  readonly device: DeviceSpec;
  private lastStatic: StaticMetrics | null = null;
  private counters = emptyCounters();
  private lastSanitizer: SanitizerReport = { races: [], truncated: 0 };

  constructor(options: DeviceOptions = {}) {
    this.memory = new LinearMemory(options.globalBytes ?? 64 * 1024 * 1024, 'global');
    this.sharedCapacity = options.sharedBytesPerBlock ?? 48 * 1024;
    this.maxWarpInsts = options.maxWarpInsts;
    this.device = options.device ?? H100;
  }

  /** cudaMalloc：返回设备地址 */
  malloc(bytes: number): number {
    return this.memory.allocate(bytes);
  }

  /** 一次拷进去 count 个 float */
  copyIn(address: number, values: ArrayLike<number>): void {
    this.memory.writeFloats(address, values);
  }

  copyOut(address: number, count: number): Float32Array {
    return this.memory.readFloats(address, count);
  }

  copyInInts(address: number, values: ArrayLike<number>): void {
    this.memory.writeInts(address, values);
  }

  copyOutInts(address: number, count: number): Int32Array {
    return this.memory.readInts(address, count);
  }

  /** 已经分配掉多少字节 —— 峰值显存那个门槛读它 */
  get usedBytes(): number {
    return this.memory.used;
  }

  launch(kernel: CompiledKernel | ExecutableKernel, config: LaunchConfig, args: KernelArg[]): void {
    const threadsPerBlock = config.block.x * config.block.y * config.block.z;
    this.lastStatic = staticMetricsOf(this.device, kernel, threadsPerBlock);
    const result = launchKernel(kernel, config, args, {
      memory: this.memory,
      sharedCapacity: this.sharedCapacity,
      maxWarpInsts: this.maxWarpInsts,
    });
    accumulate(this.counters, result.counters);
  }

  /**
   * 跑一遍 kernel，同时开着竞态检测。
   *
   * 分成两个方法而不是加个开关：**判定要两遍都跑** —— 一遍不带检测，
   * 拿干净的结果与指标；一遍带上，查竞态。这正是现实里用
   * compute-sanitizer 的方式（它太慢，不会挂在正常跑的路径上）。
   *
   * 注意这一遍会真的改写显存，所以调用方要么先跑它、要么接受结果被覆盖。
   */
  launchWithRacecheck(
    kernel: CompiledKernel | ExecutableKernel,
    config: LaunchConfig,
    args: KernelArg[]
  ): SanitizerReport {
    const detector = new RaceDetector({
      // 只盯已经分配出去的那部分显存，影子内存跟着题目规模走
      globalBytes: this.memory.used,
      sharedBytes: kernel.sharedBytes,
      blockDim: config.block,
      gridDim: config.grid,
    });
    launchKernel(kernel, config, args, {
      memory: this.memory,
      sharedCapacity: this.sharedCapacity,
      maxWarpInsts: this.maxWarpInsts,
      raceDetector: detector,
    });
    this.lastSanitizer = detector.result();
    return this.lastSanitizer;
  }

  /** 最近一次 launch 的静态指标（寄存器、共享内存、占用率） */
  staticMetrics(): StaticMetrics | null {
    return this.lastStatic;
  }

  /** 最近一次 racecheck 的结果；没跑过就是空的 */
  sanitizerReport(): SanitizerReport {
    return this.lastSanitizer;
  }

  /** compute-sanitizer 样子的文本输出 */
  formatSanitizerReport(kernelName: string): string {
    return formatRaceReports(this.lastSanitizer, kernelName);
  }

  /** 这台设备上到目前为止的全部指标 */
  metrics(): GpuMetrics {
    return toMetrics(this.counters);
  }

  /**
   * 摊平成 `gpu.` 路径，直接喂给 MetricGate。
   *
   * `gpu.sanitizer.races` 一并放进来 —— 第 3 关起它是恒为 0 的硬门槛。
   */
  flatMetrics(): Record<string, number> {
    const stat = this.lastStatic;
    return {
      ...flattenMetrics(this.metrics()),
      'gpu.sanitizer.races': this.lastSanitizer.races.length + this.lastSanitizer.truncated,
      'gpu.registers.perThread': stat?.registersPerThread ?? 0,
      'gpu.shared.bytesPerBlock': stat?.sharedBytesPerBlock ?? 0,
      'gpu.occupancy.theoretical': stat?.occupancy.theoretical ?? 0,
      'gpu.occupancy.warpsPerSm': stat?.occupancy.warpsPerSm ?? 0,
      'gpu.occupancy.blocksPerSm': stat?.occupancy.blocksPerSm ?? 0,
    };
  }

  resetMetrics(): void {
    this.counters = emptyCounters();
  }

  /**
   * 把设备恢复到刚开机的样子：显存清零、分配游标归零、指标清空。
   *
   * `./bench` 每次跑都要先做这个 —— 跑两遍必须得到同样的结果，
   * 否则「重放一致」这条门槛就不成立了。
   */
  reset(): void {
    this.memory.reset();
    this.counters = emptyCounters();
    this.lastSanitizer = { races: [], truncated: 0 };
    this.lastStatic = null;
  }
}

/** 每次 launch 的计数器累加到设备上 —— 一关可能 launch 很多次 */
function accumulate(total: GpuCounters, delta: GpuCounters): void {
  for (const key of Object.keys(total) as (keyof GpuCounters)[]) {
    total[key] += delta[key];
  }
}

export type { Dim3 as GpuDim3 };
