/**
 * 集群拓扑
 *
 * ## 为什么要建三种链路
 *
 * 「scale-up 走 NVLink（张量并行），scale-out 走 InfiniBand（数据并行）」
 * 这条现实约束是后半程一半关卡的题眼。张量并行一旦跨了机，
 * `comm.bytesByLink.ib` 立刻暴增 —— 门槛直接抓得住，
 * 而这正是真实工程里最常见、代价也最大的一类配置错误。
 *
 * ## 参数从哪来
 *
 * 带宽与延迟来自公开的产品规格。它们是**参数化**的：
 * 换一代硬件改的是下面这张表，模型结构不用动。
 * 和 timing.ts 一样，这些数字用于**相对比较与结构性计量**，
 * 不作绝对耗时的门槛。
 */

export type LinkKind = 'nvlink' | 'pcie' | 'ib';

export interface LinkSpec {
  kind: LinkKind;
  /** 单向带宽，字节/秒 */
  bandwidth: number;
  /** 链路延迟，秒 */
  latency: number;
  /**
   * 每条消息的固定开销，秒。
   *
   * **这一项决定了「多发小消息」为什么慢**：第 23 关的梯度分桶、
   * 第 27 关的重叠粒度，代价都记在这里。
   */
  perMessage: number;
  /**
   * 有效带宽系数。
   *
   * 协议头、流控、纠错都要占带宽，标称值拿不满。
   * NVLink 约 0.85，IB 约 0.90。
   */
  efficiency: number;
}

/** NVLink 4（H100）：18 条 × 25 GB/s，单向 450 GB/s */
export const NVLINK4: LinkSpec = {
  kind: 'nvlink', bandwidth: 450e9, latency: 1.5e-6, perMessage: 0.5e-6, efficiency: 0.85,
};

/** NVLink 5（Blackwell）：18 × 50 GB/s，单向 900 GB/s */
export const NVLINK5: LinkSpec = {
  kind: 'nvlink', bandwidth: 900e9, latency: 1.5e-6, perMessage: 0.5e-6, efficiency: 0.85,
};

/** PCIe Gen5 x16 */
export const PCIE5: LinkSpec = {
  kind: 'pcie', bandwidth: 64e9, latency: 3e-6, perMessage: 1e-6, efficiency: 0.85,
};

/** InfiniBand NDR，400 Gb/s */
export const IB_NDR: LinkSpec = {
  kind: 'ib', bandwidth: 50e9, latency: 5e-6, perMessage: 2e-6, efficiency: 0.90,
};

/** InfiniBand XDR，800 Gb/s（ConnectX-8） */
export const IB_XDR: LinkSpec = {
  kind: 'ib', bandwidth: 100e9, latency: 5e-6, perMessage: 2e-6, efficiency: 0.90,
};

export interface ClusterSpec {
  /** 一共几张卡 */
  devices: number;
  /** 每台机器几张卡。机内走 NVLink，跨机走 IB */
  devicesPerNode: number;
  nvlink?: LinkSpec;
  ib?: LinkSpec;
  pcie?: LinkSpec;
}

/** 常见的一台 8 卡 H100 机器 */
export const SINGLE_NODE_8: ClusterSpec = {
  devices: 8, devicesPerNode: 8, nvlink: NVLINK4, ib: IB_NDR, pcie: PCIE5,
};

/** 两台 8 卡机，一共 16 张 —— 张量并行跨机的那些关用它 */
export const TWO_NODE_16: ClusterSpec = {
  devices: 16, devicesPerNode: 8, nvlink: NVLINK4, ib: IB_NDR, pcie: PCIE5,
};

export function nodeOf(device: number, spec: ClusterSpec): number {
  return Math.floor(device / spec.devicesPerNode);
}

/**
 * 两张卡之间走哪条链路。
 *
 * 同一台机器里走 NVLink，跨机走 IB。**没有第三种可能** ——
 * 这个二分正是「张量并行必须留在机内」那条约束的来源。
 */
export function linkBetween(a: number, b: number, spec: ClusterSpec): LinkSpec {
  if (a === b) throw new Error(`不能和自己通信：设备 ${a}`);
  if (nodeOf(a, spec) === nodeOf(b, spec)) {
    return spec.nvlink ?? PCIE5;
  }
  return spec.ib ?? IB_NDR;
}

/** 传一段字节要多久 */
export function transferSeconds(bytes: number, link: LinkSpec): number {
  const effective = link.bandwidth * link.efficiency;
  return link.perMessage + link.latency + bytes / effective;
}
