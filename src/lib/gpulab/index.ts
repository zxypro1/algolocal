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
import { flattenMetrics, toMetrics, type GpuMetrics } from './metrics';
import { LinearMemory } from './vm/memory';
import { launchKernel, type Dim3, type GpuCounters, type LaunchConfig, type KernelArg } from './vm/vm';

export { CudaSyntaxError, parseCuda, resetCudaParser } from './cuda/parser';
export { CudaCompileError } from './cuda/lower';
export { KernelError, dim3, launchKernel } from './vm/vm';
export { LinearMemory, MemoryFault, SECTOR_BYTES, WARP_SIZE } from './vm/memory';
export { flattenMetrics, toMetrics } from './metrics';
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
  private counters = emptyTotals();

  constructor(options: DeviceOptions = {}) {
    this.memory = new LinearMemory(options.globalBytes ?? 64 * 1024 * 1024, 'global');
    this.sharedCapacity = options.sharedBytesPerBlock ?? 48 * 1024;
    this.maxWarpInsts = options.maxWarpInsts;
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
    const result = launchKernel(kernel, config, args, {
      memory: this.memory,
      sharedCapacity: this.sharedCapacity,
      maxWarpInsts: this.maxWarpInsts,
    });
    accumulate(this.counters, result.counters);
  }

  /** 这台设备上到目前为止的全部指标 */
  metrics(): GpuMetrics {
    return toMetrics(this.counters);
  }

  /** 摊平成 `gpu.` 路径，直接喂给 MetricGate */
  flatMetrics(): Record<string, number> {
    return flattenMetrics(this.metrics());
  }

  resetMetrics(): void {
    this.counters = emptyTotals();
  }
}

function emptyTotals(): GpuCounters {
  return {
    warpInsts: 0, laneInsts: 0, instFma: 0, instLdSt: 0,
    globalLoadRequests: 0, globalStoreRequests: 0,
    globalLoadSectors: 0, globalStoreSectors: 0,
    sharedLoadRequests: 0, sharedStoreRequests: 0, sharedBankConflicts: 0,
    divergentBranches: 0, activeLanes: 0,
    barriers: 0, blocksLaunched: 0, warpsLaunched: 0,
  };
}

/** 每次 launch 的计数器累加到设备上 —— 一关可能 launch 很多次 */
function accumulate(total: GpuCounters, delta: GpuCounters): void {
  for (const key of Object.keys(total) as (keyof GpuCounters)[]) {
    total[key] += delta[key];
  }
}

export type { Dim3 as GpuDim3 };
