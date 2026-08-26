/**
 * 时序模型
 *
 * ## 这个模型是干什么用的，以及**不是**干什么用的
 *
 * design/gpulab.md 立的硬规矩：**所有门槛只建立在结构性计量上，
 * 绝不建立在模拟耗时的绝对值上。** 这个文件算出来的周期数只做两件事：
 *
 *   1. **展示** —— roofline 的纵坐标、剖析面板上那个「大概多久」；
 *   2. **同一关内的相对比较** —— 「比上一版快了几倍」。
 *
 * 它不是周期精确的硬件模型，也没打算是。没有真卡可校准，编一个看起来
 * 很精确的数字只会让 roofline 上的每条结论都不可信。
 *
 * ## 用的是什么模型
 *
 * 经典的 **interval / roofline 模型**：把一次 kernel 的工作按功能单元拆开，
 * 各算各的时间，能并行的取最大值，不能并行的相加。
 *
 *   计算侧 = max(ALU, FMA, SFU, TensorCore)   四个是独立单元，可以同时忙
 *   访存侧 = max(LSU, 共享内存, DRAM)
 *   总时间 = max(计算侧, 访存侧) × 延迟惩罚(占用率)
 *
 * **把四个计算单元分开是这个文件存在的主要理由。** 少了它，
 * 「tensor core 快到让 SFU 成为瓶颈」这件事就演不出来 —— 而那正是
 * FlashAttention-4 要在两个 tile 之间 ping-pong 的原因
 * （PyTorch 官方博客的原话：tensor core 变快了，SFU 没跟上）。
 *
 * ## 参数从哪来
 *
 * 每 SM 每周期的吞吐来自公开的架构白皮书与编程指南。它们是**参数化**的，
 * 将来如果能借到一张真卡跑一轮校准（见 design/gpulab.md 拍板记录第 7 条），
 * 改的就是下面这张表，模型结构不用动。
 */
import type { DeviceSpec } from './device';
import type { GpuCounters } from './vm/vm';

/** 一个 SM 每周期能干多少活 */
export interface SmThroughput {
  /** fp32 融合乘加，每周期多少个 lane */
  fma: number;
  /** 整数与其它简单运算 */
  alu: number;
  /**
   * 特殊功能单元：exp / log / rsqrt / sin。
   *
   * **它比 FMA 少一个数量级**，这不是笔误。softmax 里那个 `expf` 之所以
   * 能成为瓶颈，就是因为这个比例。
   */
  sfu: number;
  /** 访存单元：每周期能处理几条 warp 级访存请求 */
  lsu: number;
  /** 共享内存：每周期几条无冲突的 warp 请求 */
  shared: number;
  /** tensor core：每周期多少次 fp16 乘加 */
  tensor: number;
}

export interface TimingSpec {
  /** SM 频率，Hz */
  clock: number;
  throughput: SmThroughput;
  /** DRAM 每周期能搬多少字节（由带宽与频率算出来） */
  dramBytesPerCycle: number;
}

/**
 * H100 SXM 的吞吐。
 *
 * FMA / ALU：每 SM 128 个 fp32 lane（4 个分区 × 32）。
 * SFU：每 SM 16 个（每分区 4 个）。**是 FMA 的 1/8。**
 * LSU / 共享内存：每分区每周期一条 warp 请求，合起来 4。
 * Tensor core：第四代，每 SM 每周期 1024 次 fp16 乘加。
 * 频率取 boost 的 1.755 GHz；DRAM 3.35 TB/s 换算过来约 1900 字节/周期。
 */
export const H100_TIMING: TimingSpec = {
  clock: 1.755e9,
  throughput: { fma: 128, alu: 128, sfu: 16, lsu: 4, shared: 4, tensor: 1024 },
  dramBytesPerCycle: 3.35e12 / 1.755e9,
};

/**
 * B200 的吞吐 —— **只有 tensor core 与带宽变了，SFU 没动。**
 *
 * 这正是第 16 关要学员亲眼看到的事：同一份 FlashAttention 换到这组参数上，
 * 瓶颈会从访存挪到 SFU，因为 tensor core 快了一大截而 `expf` 还是那么快。
 */
export const B200_TIMING: TimingSpec = {
  clock: 1.965e9,
  throughput: { fma: 128, alu: 128, sfu: 16, lsu: 4, shared: 4, tensor: 4096 },
  dramBytesPerCycle: 8.0e12 / 1.965e9,
};

export function timingFor(device: DeviceSpec): TimingSpec {
  return device.computeCapability >= 100 ? B200_TIMING : H100_TIMING;
}

/** 各单元各自要多少周期 —— 剖析面板会把这张表画成柱状图 */
export interface UnitCycles {
  alu: number;
  fma: number;
  sfu: number;
  tensor: number;
  lsu: number;
  shared: number;
  dram: number;
}

export interface TimingResult {
  /** 估算的总周期数 */
  cycles: number;
  /** 换算成纳秒 */
  nanoseconds: number;
  units: UnitCycles;
  /**
   * 谁是瓶颈。
   *
   * 和 `ncu` 的 Speed Of Light 一节一个意思：先看清是算力还是带宽卡住，
   * 再决定往哪个方向优化。
   */
  bottleneck: keyof UnitCycles;
  /**
   * 延迟隐藏得怎么样，0~1。
   *
   * 占用率低时访存延迟盖不住，总时间要按这个系数放大。
   */
  latencyHiding: number;
}

export interface TimingInput {
  counters: GpuCounters;
  device: DeviceSpec;
  /** 理论占用率，0~1 */
  occupancy: number;
}

/**
 * 占用率不够时，访存延迟盖不住多少。
 *
 * 真硬件上一次 DRAM 访问要几百个周期，靠切换到别的 warp 来盖。
 * 驻留的 warp 越少能盖住的越少。这里用一条简单的饱和曲线：
 * 占用率 50% 以上基本盖得住，低于 25% 开始明显吃亏。
 *
 * 这是**模型里最粗的一处**，也是最需要真卡校准的一处。
 */
function latencyHidingOf(occupancy: number): number {
  if (occupancy <= 0) return 0.1;
  return Math.min(1, 0.15 + 1.7 * occupancy);
}

export function estimateTiming(input: TimingInput): TimingResult {
  const { counters, device, occupancy } = input;
  const spec = timingFor(device);
  const sms = device.smCount;
  const { throughput } = spec;

  // 指令按功能单元分派。ALU 是「剩下的那些」：总 lane 指令减掉已经归到别处的，
  // 再减掉**记账指令**。
  //
  // 减记账指令这一步是必须的：我们的 IR 故意不做优化，于是每个表达式都会
  // 产生一堆 const 与 mov，而真编译器把它们折叠进操作数、硬件上并不存在。
  // 不扣掉的话，任何 kernel 算出来都是「ALU 卡住」，瓶颈归因彻底失效。
  //
  // 这里**没有**扣掉循环计数与分支的开销，那些指令在硬件上是真的存在，
  // 只是真 nvcc 会展开定长循环把它们摊薄。所以一个循环体里只有一次运算的
  // kernel，在这个模型里会显示成受循环开销限制 —— 那其实是实话。
  const accounted = counters.instFma + counters.instLdSt + counters.instSfu
    + counters.instMma + counters.instBookkeeping;
  const instAlu = Math.max(0, counters.laneInsts - accounted);

  const perSm = (work: number, rate: number) => (rate > 0 ? work / (rate * sms) : 0);

  const units: UnitCycles = {
    alu: perSm(instAlu, throughput.alu),
    fma: perSm(counters.instFma, throughput.fma),
    sfu: perSm(counters.instSfu, throughput.sfu),
    tensor: perSm(counters.instMma, throughput.tensor),
    lsu: perSm(
      counters.globalLoadRequests + counters.globalStoreRequests,
      throughput.lsu
    ),
    // bank 冲突就是串行化：n 路冲突等于这条请求要发 n+1 次
    shared: perSm(
      counters.sharedLoadRequests + counters.sharedStoreRequests + counters.sharedBankConflicts,
      throughput.shared
    ),
    dram: spec.dramBytesPerCycle > 0
      ? (counters.globalLoadSectors + counters.globalStoreSectors) * 32 / spec.dramBytesPerCycle
      : 0,
  };

  // 计算侧的四个单元是独立的，可以同时忙；访存侧同理
  const compute = Math.max(units.alu, units.fma, units.sfu, units.tensor);
  const memory = Math.max(units.lsu, units.shared, units.dram);
  const latencyHiding = latencyHidingOf(occupancy);

  const cycles = Math.max(compute, memory) / latencyHiding;

  let bottleneck: keyof UnitCycles = 'alu';
  let worst = -1;
  for (const [name, value] of Object.entries(units) as Array<[keyof UnitCycles, number]>) {
    if (value > worst) { worst = value; bottleneck = name; }
  }

  return {
    cycles,
    nanoseconds: (cycles / spec.clock) * 1e9,
    units,
    bottleneck,
    latencyHiding,
  };
}

/**
 * roofline 上的一个点。
 *
 * 横坐标是算术强度（每从 DRAM 搬一个字节做多少次浮点运算），
 * 纵坐标是达到的算力。屋顶由两段组成：带宽限制的斜坡与算力限制的平台。
 */
export interface RooflinePoint {
  arithmeticIntensity: number;
  /** 达到的 FLOP/s */
  achieved: number;
  /** 这个算术强度下的理论上限 */
  ceiling: number;
  /** 距离屋顶还有多远，0~1 */
  efficiency: number;
  /** 拐点：算术强度到这里之后就不再受带宽限制 */
  ridgePoint: number;
}

export function roofline(input: TimingInput & { timing: TimingResult }): RooflinePoint {
  const { counters, device, timing } = input;
  const spec = timingFor(device);

  const bytes = (counters.globalLoadSectors + counters.globalStoreSectors) * 32;
  // FMA 算两次浮点运算；tensor core 的一次 mma 也是乘加
  const flops = counters.instFma * 2 + counters.instMma * 2;
  const intensity = bytes > 0 ? flops / bytes : 0;

  const peakFlops = spec.throughput.fma * 2 * device.smCount * spec.clock;
  const peakBandwidth = spec.dramBytesPerCycle * spec.clock;
  const ridgePoint = peakBandwidth > 0 ? peakFlops / peakBandwidth : 0;

  const ceiling = Math.min(peakFlops, intensity * peakBandwidth);
  const seconds = timing.nanoseconds / 1e9;
  const achieved = seconds > 0 ? flops / seconds : 0;

  return {
    arithmeticIntensity: intensity,
    achieved,
    ceiling,
    efficiency: ceiling > 0 ? Math.min(1, achieved / ceiling) : 0,
    ridgePoint,
  };
}
