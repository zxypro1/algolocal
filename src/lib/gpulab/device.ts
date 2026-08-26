/**
 * 设备规格
 *
 * design/gpulab.md 定的是「**一套 ISA（Hopper）+ 两组硬件参数**」：
 * 学员写的 kernel 一个字不用改，换一组参数跑，就能看到瓶颈从访存挪到别处。
 * 第 16 关讲 FlashAttention-4 的 ping-pong 为什么必要，靠的就是这个 ——
 * tensor core 变快了而 SFU 没跟上，是 B200 上真实发生的事。
 *
 * 数字全部来自公开文档，出处逐条写在下面。**不写没有出处的数**：
 * 一个编出来的参数会让 roofline 上的每一条结论都不可信。
 */

export interface DeviceSpec {
  name: string;
  /** compute capability，比如 90 表示 sm_90 */
  computeCapability: number;

  /* ---- 占用率的硬限制 ---- */
  /** 一个 SM 最多驻留多少 warp */
  maxWarpsPerSm: number;
  /** 一个 SM 最多驻留多少 block */
  maxBlocksPerSm: number;
  /** 一个 SM 的寄存器堆有多少个 32 位寄存器 */
  registersPerSm: number;
  /** 一个线程最多能用多少寄存器，超了就溢出到 local memory */
  maxRegistersPerThread: number;
  /** 一个 SM 的共享内存字节数 */
  sharedMemoryPerSm: number;
  /** 单个 block 能申请的共享内存上限 */
  maxSharedMemoryPerBlock: number;
  /** 一个 block 最多多少线程 */
  maxThreadsPerBlock: number;

  /* ---- 规模 ---- */
  smCount: number;
  /** 显存带宽，字节每秒 */
  memoryBandwidth: number;
  memoryBytes: number;
}

/**
 * H100 SXM（Hopper，sm_90）—— **主建模架构**。
 *
 * 选它的理由见 design/gpulab.md「十五、拍板记录」第 2 条：文档最全、
 * 心智模型能一步步长出来、且覆盖绝大多数人的实际工作。
 *
 * 占用率相关的数字来自 CUDA 编程指南的 Compute Capabilities 附录与
 * Hopper Tuning Guide：64 warp/SM、64K 个 32 位寄存器/SM、
 * 228KB 共享内存/SM、单 block 最多 227KB、32 block/SM。
 * <https://docs.nvidia.com/cuda/hopper-tuning-guide/index.html>
 */
export const H100: DeviceSpec = {
  name: 'NVIDIA H100 SXM',
  computeCapability: 90,
  maxWarpsPerSm: 64,
  maxBlocksPerSm: 32,
  registersPerSm: 65536,
  maxRegistersPerThread: 255,
  sharedMemoryPerSm: 228 * 1024,
  maxSharedMemoryPerBlock: 227 * 1024,
  maxThreadsPerBlock: 1024,
  smCount: 132,
  memoryBandwidth: 3.35e12,
  memoryBytes: 80 * 1024 * 1024 * 1024,
};

/**
 * B200（Blackwell，sm_100）—— **第二组参数**，不是第二套 ISA。
 *
 * 学员写的还是 Hopper 那套 `wmma` + `cp.async`；换到这组参数上跑，
 * tensor core 快了而 SFU 没跟上，瓶颈自己挪位置。这正是 FA4 要在
 * 两个 tile 之间 ping-pong 的原因（PyTorch 官方博客的原话）。
 * <https://pytorch.org/blog/flexattention-flashattention-4-fast-and-flexible/>
 *
 * 占用率的那几条 Blackwell 与 Hopper 相同（都是 64 warp / 64K 寄存器）；
 * 共享内存与带宽按 B200 的公开规格。
 */
export const B200: DeviceSpec = {
  name: 'NVIDIA B200',
  computeCapability: 100,
  maxWarpsPerSm: 64,
  maxBlocksPerSm: 32,
  registersPerSm: 65536,
  maxRegistersPerThread: 255,
  sharedMemoryPerSm: 228 * 1024,
  maxSharedMemoryPerBlock: 227 * 1024,
  maxThreadsPerBlock: 1024,
  smCount: 148,
  memoryBandwidth: 8.0e12,
  memoryBytes: 180 * 1024 * 1024 * 1024,
};

export const DEVICES: Record<string, DeviceSpec> = { H100, B200 };

/* ------------------------------------------------------------------ */
/* 占用率                                                              */
/* ------------------------------------------------------------------ */

export interface OccupancyInput {
  threadsPerBlock: number;
  registersPerThread: number;
  sharedBytesPerBlock: number;
}

export interface Occupancy {
  /** 0~1。同时驻留的 warp 数除以 SM 能装下的最大 warp 数。 */
  theoretical: number;
  /** 一个 SM 上能同时驻留几个 block */
  blocksPerSm: number;
  /** 同时驻留多少 warp */
  warpsPerSm: number;
  /**
   * 到底是谁卡住了。
   *
   * 这一条比数字本身有用 —— 学员看到 `registers` 才知道该去减寄存器，
   * 看到 `shared` 才知道该去缩分块。ncu 的 Occupancy 分节也是这么给的。
   */
  limiter: 'registers' | 'shared' | 'blocks' | 'warps' | 'none';
}

/**
 * 理论占用率。
 *
 * 就是真 CUDA Occupancy Calculator 那套算法：分别算出寄存器、共享内存、
 * block 数、warp 数四条限制各自允许多少 block 驻留，取最小的那个。
 *
 * 寄存器数是估的（见 ir/compile.ts 的 estimateRegisters），所以这个值
 * 也是估的 —— 它用来展示与作宽松门槛，精确的那个门槛是 `local.bytes`。
 */
export function computeOccupancy(device: DeviceSpec, input: OccupancyInput): Occupancy {
  const warpsPerBlock = Math.ceil(input.threadsPerBlock / 32);
  if (warpsPerBlock === 0) {
    return { theoretical: 0, blocksPerSm: 0, warpsPerSm: 0, limiter: 'none' };
  }

  // 寄存器：按 warp 粒度分配，所以要先把每 warp 的用量向上取整
  const registersPerWarp = input.registersPerThread * 32;
  const byRegisters = registersPerWarp > 0
    ? Math.floor(Math.floor(device.registersPerSm / registersPerWarp) / warpsPerBlock)
    : device.maxBlocksPerSm;

  const byShared = input.sharedBytesPerBlock > 0
    ? Math.floor(device.sharedMemoryPerSm / input.sharedBytesPerBlock)
    : device.maxBlocksPerSm;

  const byWarps = Math.floor(device.maxWarpsPerSm / warpsPerBlock);
  const byBlocks = device.maxBlocksPerSm;

  const blocksPerSm = Math.max(0, Math.min(byRegisters, byShared, byWarps, byBlocks));

  let limiter: Occupancy['limiter'] = 'none';
  if (blocksPerSm === byRegisters && byRegisters < byWarps) limiter = 'registers';
  else if (blocksPerSm === byShared && byShared < byWarps) limiter = 'shared';
  else if (blocksPerSm === byBlocks && byBlocks < byWarps) limiter = 'blocks';
  else if (blocksPerSm === byWarps) limiter = 'warps';

  const warpsPerSm = blocksPerSm * warpsPerBlock;
  return {
    theoretical: warpsPerSm / device.maxWarpsPerSm,
    blocksPerSm,
    warpsPerSm,
    limiter,
  };
}
