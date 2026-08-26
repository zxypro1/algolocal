/**
 * gpulab —— CUDA GPU 编程实战工作台
 *
 * 设计见 design/gpulab.md。这一层是给关卡与判定用的门面：
 * 一段 CUDA 源码进去，跑完之后的内存与指标出来。
 */
import { compileHost, compileKernel } from './ir/compile';
import { HostRuntime, type HostEnvironment } from './host/runtime';
import { HostRuntimeError } from './host/containers';
import { encode, type ExecutableKernel } from './ir/program';
import type { CompiledKernel } from './ir/types';
import { lowerTranslationUnit } from './cuda/lower';
import { parseCuda, type CudaParserOptions } from './cuda/parser';
import { flattenMetrics, staticMetricsOf, toMetrics, type GpuMetrics, type StaticMetrics } from './metrics';
import { H100, computeOccupancy, type DeviceSpec } from './device';
import { estimateTiming, roofline, type RooflinePoint, type TimingResult } from './timing';
import { LinearMemory } from './vm/memory';
import { RaceDetector, formatRaceReports, type SanitizerReport } from './vm/sanitizer';
import { dim3, emptyCounters, launchKernel, type Dim3, type GpuCounters, type LaunchConfig, type KernelArg } from './vm/vm';

export { CudaSyntaxError, parseCuda, resetCudaParser } from './cuda/parser';
export { CudaCompileError } from './cuda/lower';
export { KernelError, dim3, launchKernel } from './vm/vm';
export { LinearMemory, MemoryFault, SECTOR_BYTES, WARP_SIZE } from './vm/memory';
export { flattenMetrics, staticMetricsOf, toMetrics } from './metrics';
export { H100, B200, DEVICES, computeOccupancy } from './device';
export { estimateTiming, roofline, timingFor, H100_TIMING, B200_TIMING } from './timing';
export type { TimingResult, RooflinePoint, TimingSpec, UnitCycles } from './timing';
export type { DeviceSpec, Occupancy } from './device';
export type { StaticMetrics } from './metrics';
export { RaceDetector, formatRaceReports } from './vm/sanitizer';
export type { SanitizerReport, RaceReport } from './vm/sanitizer';
export type { GpuMetrics } from './metrics';
export type { CompiledKernel } from './ir/types';
export { encode } from './ir/program';
export type { ExecutableKernel } from './ir/program';
export type { Dim3, LaunchConfig, KernelArg, GpuCounters } from './vm/vm';
export { HostRuntimeError } from './host/containers';
export { Cluster, ClusterError, DEVICE_SPAN } from './cluster/cluster';
export type { CommMetrics, ClusterOptions } from './cluster/cluster';
export { runClusterHost } from './cluster/run';
export {
  NVLINK4, NVLINK5, PCIE5, IB_NDR, IB_XDR, SINGLE_NODE_8, TWO_NODE_16,
  linkBetween, nodeOf, transferSeconds,
} from './cluster/topology';
export type { ClusterSpec, LinkSpec, LinkKind } from './cluster/topology';
export { BUS_FACTOR } from './cluster/nccl';
export { formatPrintf } from './host/runtime';

/** 宿主程序跑完的结果 */
export interface HostRunResult {
  stdout: string;
}

/**
 * 编译一份源码。
 *
 * 一份源码里可以有 kernel、可以有 `int main()`，也可以两者都有 ——
 * 后半程那几关（KV cache、分页 KV、引擎组装、调度器）主要的逻辑就写在
 * 宿主侧，`main` 负责分配显存、管块表、按调度决定这一步起哪些 kernel。
 */
export interface CompiledProgram {
  kernels: Map<string, ExecutableKernel>;
  /** 有 `int main()` 才有；只有一组 kernel 的源码这里是 null */
  host: ExecutableKernel | null;
}

export async function compileProgram(
  source: string,
  options?: CudaParserOptions
): Promise<CompiledProgram> {
  const root = await parseCuda(source, options);
  const unit = lowerTranslationUnit(root);
  const kernels = new Map<string, ExecutableKernel>();
  for (const kernel of unit.kernels) {
    // 编码只做一次 —— 一关会 launch 很多次，每次重编是白费的
    kernels.set(kernel.name, encode(compileKernel(kernel, unit.functions)));
  }
  const host = unit.main ? encode(compileHost(unit.main, unit.functions)) : null;
  return { kernels, host };
}

/** 只要 kernel 的那条老路 —— 大多数关卡与用例走这条 */
export async function compileSource(
  source: string,
  options?: CudaParserOptions
): Promise<Map<string, ExecutableKernel>> {
  return (await compileProgram(source, options)).kernels;
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
    this.counters.kernelLaunches += 1;
    this.launchInner(kernel, config, args);
  }

  /** 真正跑一遍，不动提交计数 —— graph 重放要绕开那一次自增 */
  private launchInner(
    kernel: CompiledKernel | ExecutableKernel, config: LaunchConfig, args: KernelArg[]
  ): void {
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
   * 跑一个宿主程序的 `main`。
   *
   * 宿主代码在 VM 里就是 grid 1 / block 1 的一个线程，**用的是另一台
   * 执行器实例**，它自己的指令数与访存不会算进 `gpu.*` 指标里 ——
   * 门槛量的是 GPU 干了多少活，宿主侧的 for 循环不该混进去。
   * 它起的每一个 kernel 才走正常的 `launch`，正常计量。
   */
  runHost(
    host: ExecutableKernel,
    kernels: Map<string, ExecutableKernel>,
    buffers: Array<{ address: number; length: number }> = [],
    options: { racecheck?: boolean } = {}
  ): HostRunResult {
    const output: string[] = [];
    const races: SanitizerReport['races'] = [];
    let truncated = 0;
    // 宿主的局部内存要能被 cudaMemcpy 读写，所以在外面开、传进去
    const hostLocal = new LinearMemory(
      Math.max(4, host.localBytes), 'local'
    );

    const environment: HostEnvironment = {
      cudaMalloc: (bytes) => this.malloc(bytes),
      // 我们的分配器是一路向前的游标，没有真正的回收。**故意如此**：
      // 显存峰值那个门槛量的就是「一共要过多少显存」，能回收就量不出
      // 分页 KV 相对于朴素预分配的差别了。cudaFree 仍然要写 ——
      // 不写在真卡上是泄漏，关卡的用例会检查配对。
      cudaFree: () => {},
      copy: (dst, src, bytes, kind) => {
        const from = kind === 1 || kind === 0 ? hostLocal : this.memory;
        const to = kind === 2 || kind === 0 ? hostLocal : this.memory;
        copyBytes(to, dst, from, src, bytes);
      },
      memset: (address, value, bytes) => {
        new Uint8Array(this.memory.bytes, address, bytes).fill(value & 0xff);
      },
      launch: (name, grid, block, args, line) => {
        const kernel = kernels.get(name);
        if (!kernel) {
          throw new HostRuntimeError(
            `第 ${line} 行：找不到 kernel \`${name}\` —— 编出来的有：${[...kernels.keys()].join(', ')}`
          );
        }
        // 开着 racecheck 时，宿主程序里起的**每一个** kernel 都要查。
        // 报告是累加的：一个引擎的一步会起好几个 kernel，
        // 只留最后一个的报告等于漏掉前面所有的竞态。
        if (options.racecheck) {
          const report = this.launchWithRacecheck(kernel, { grid, block }, args);
          races.push(...report.races);
          truncated += report.truncated;
        } else {
          this.launch(kernel, { grid, block }, args);
        }
      },
      // graph 重放：kernel 该跑的一个不少，但**提交只算一次**
      replay: (nodes) => {
        this.counters.kernelLaunches += 1;
        for (const node of nodes) {
          if (node.kind === 'copy') {
            environment.copy(node.dst, node.src, node.bytes, node.copyKind);
            continue;
          }
          const kernel = kernels.get(node.name);
          if (!kernel) {
            throw new HostRuntimeError(`graph 里的 kernel \`${node.name}\` 找不到了`);
          }
          this.launchInner(kernel, { grid: node.grid, block: node.block }, node.args);
        }
      },
      write: (text) => { output.push(text); },
      buffer: (index) => {
        const found = buffers[index];
        if (!found) {
          throw new HostRuntimeError(
            `没有第 ${index} 号缓冲区 —— 这一关声明了 ${buffers.length} 个（编号从 0 开始）`
          );
        }
        return found;
      },
    };

    const runtime = new HostRuntime(environment, host.strings ?? []);
    launchKernel(host, { grid: dim3(1), block: dim3(1) }, [], {
      memory: this.memory,
      sharedCapacity: this.sharedCapacity,
      maxWarpInsts: this.maxWarpInsts,
      host: runtime,
      localMemory: hostLocal,
    });
    if (options.racecheck) this.lastSanitizer = { races, truncated };
    return { stdout: output.join('') };
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
    // 静态指标和普通 launch 是同一份（同一个 kernel、同一个配置），
    // 也要填上 —— 否则 racecheck 跑完之后占用率与寄存器数会变成空的
    const threadsPerBlock = config.block.x * config.block.y * config.block.z;
    this.lastStatic = staticMetricsOf(this.device, kernel, threadsPerBlock);
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

  /**
   * 时序估算。
   *
   * **只用于展示与同关相对比较，不作门槛** —— 见 timing.ts 开头的说明。
   */
  timing(): TimingResult {
    return estimateTiming({
      counters: this.counters,
      device: this.device,
      occupancy: this.lastStatic?.occupancy.theoretical ?? 0,
    });
  }

  /** roofline 上的那个点 */
  roofline(): RooflinePoint {
    return roofline({
      counters: this.counters,
      device: this.device,
      occupancy: this.lastStatic?.occupancy.theoretical ?? 0,
      timing: this.timing(),
    });
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
   * 存 / 取一份计数器快照。
   *
   * 给 racecheck 那一遍用：它要在干净的设备上重跑一次，但**不能把
   * 真实那一遍的指标冲掉** —— 门槛读的是真实那一遍。
   */
  snapshotCounters(): GpuCounters {
    return { ...this.counters };
  }

  restoreCounters(snapshot: GpuCounters): void {
    this.counters = { ...snapshot };
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

/**
 * 在两个地址空间之间搬字节。
 *
 * 按 4 字节搬 —— 我们的两个空间都是 4 字节对齐分配的，
 * 而按字节搬会让一次 cudaMemcpy 慢上好几倍。
 */
function copyBytes(
  to: LinearMemory, dst: number, from: LinearMemory, src: number, bytes: number
): void {
  if (bytes < 0) throw new HostRuntimeError(`cudaMemcpy 的字节数是负的：${bytes}`);
  if (dst + bytes > to.capacity || src + bytes > from.capacity) {
    throw new HostRuntimeError(
      `cudaMemcpy 越界：搬 ${bytes} 字节，源在 ${src}、目标在 ${dst}`
    );
  }
  new Uint8Array(to.bytes, dst, bytes).set(new Uint8Array(from.bytes, src, bytes));
}
