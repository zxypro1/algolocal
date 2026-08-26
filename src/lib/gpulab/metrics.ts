/**
 * 指标
 *
 * 门槛读的就是这棵树。命名**对齐 Nsight Compute**（见 design/gpulab.md
 * 第七节的对照表）—— 既是「接口真实」的一部分，也让学员拿这个名字去搜
 * 能搜到真东西。
 *
 * 这里只做一件事：把 VM 的原始计数器整理成带派生量的一棵树。
 * 派生量（比如 sectorsPerRequest）单独算，因为门槛写的是它而不是分子分母。
 */
import type { GpuCounters } from './vm/vm';
import { SECTOR_BYTES, WARP_SIZE } from './vm/memory';

export interface GpuMetrics {
  global: {
    loadRequests: number;
    storeRequests: number;
    loadSectors: number;
    storeSectors: number;
    /**
     * 每次 warp 级访存平均打到几个 32B 扇区。
     *
     * 对齐 ncu 的
     * `l1tex__average_t_sectors_per_request_pipe_lsu_mem_global_op_ld.ratio`。
     * 完全合并 = 4.0（32 个 lane × 4 字节 = 128 字节 = 4 个扇区），
     * 完全发散 = 32.0。这是第 2 关门槛的那个数。
     */
    sectorsPerRequest: number;
  };
  /**
   * L1 之下看到的字节数。
   *
   * **口径要说清楚**：这是扇区数 × 32，也就是「如果每次都打到 DRAM」的字节数。
   * 还没有 L2 / L1 的命中模型，所以它是上界而不是 ncu 的 `dram__bytes_read.sum`。
   * 缓存模型落地之前，门槛只用它来比「同一份数据被读了几遍」，
   * 那个用途下缓存的影响是次要的。
   */
  memory: {
    readBytes: number;
    writeBytes: number;
  };
  shared: {
    loadRequests: number;
    storeRequests: number;
    /**
     * 冲突路数，对齐 ncu 的
     * `l1tex__data_bank_conflicts_pipe_lsu_mem_shared_op_{ld,st}.sum`。
     * 无冲突时是 0。
     */
    bankConflicts: number;
  };
  warp: {
    /** 一条分支上 lane 分成两拨的次数 */
    divergentBranches: number;
    /** 活跃 lane 占比，0~1。全程不发散就是 1。 */
    activeLaneRatio: number;
    /** warp 级交换指令（`__shfl_*_sync`）条数 */
    shuffles: number;
    /**
     * warp 同步原语用错的次数。
     * 恒为 0 的硬门槛 —— 和 sanitizer 那几项一个性质。
     */
    syncErrors: number;
  };
  /**
   * 原子操作次数（按 lane 算）。
   *
   * 第 5 关的门槛读它：`atomics <= gridDim` 逼出 shuffle 规约，
   * 而不是每个线程都往同一个地址 atomicAdd。
   */
  atomics: number;
  inst: {
    /** warp 级指令条数 —— 执行预算看这个 */
    warpExecuted: number;
    /** 展开到 lane 的指令条数，对齐 ncu 的 `smsp__thread_inst_executed` */
    laneExecuted: number;
    fma: number;
    ldst: number;
  };
  launch: {
    blocks: number;
    warps: number;
    barriers: number;
  };
}

export function toMetrics(counters: GpuCounters): GpuMetrics {
  const globalRequests = counters.globalLoadRequests + counters.globalStoreRequests;
  const globalSectors = counters.globalLoadSectors + counters.globalStoreSectors;

  return {
    global: {
      loadRequests: counters.globalLoadRequests,
      storeRequests: counters.globalStoreRequests,
      loadSectors: counters.globalLoadSectors,
      storeSectors: counters.globalStoreSectors,
      sectorsPerRequest: globalRequests === 0 ? 0 : globalSectors / globalRequests,
    },
    memory: {
      readBytes: counters.globalLoadSectors * SECTOR_BYTES,
      writeBytes: counters.globalStoreSectors * SECTOR_BYTES,
    },
    shared: {
      loadRequests: counters.sharedLoadRequests,
      storeRequests: counters.sharedStoreRequests,
      bankConflicts: counters.sharedBankConflicts,
    },
    warp: {
      divergentBranches: counters.divergentBranches,
      activeLaneRatio:
        counters.warpInsts === 0 ? 0 : counters.laneInsts / (counters.warpInsts * WARP_SIZE),
      shuffles: counters.shuffles,
      syncErrors: counters.warpSyncErrors,
    },
    atomics: counters.atomics,
    inst: {
      warpExecuted: counters.warpInsts,
      laneExecuted: counters.laneInsts,
      fma: counters.instFma,
      ldst: counters.instLdSt,
    },
    launch: {
      blocks: counters.blocksLaunched,
      warps: counters.warpsLaunched,
      barriers: counters.barriers,
    },
  };
}

/**
 * 把指标摊平成 `gpu.` 前缀的路径，喂给现有的 MetricGate。
 *
 * `MetricGate.metric` 是 LabMetrics 上的一条路径，所以门槛写起来是
 * `{ metric: 'gpu.global.sectorsPerRequest', op: 'lte', value: 4.5 }`。
 */
export function flattenMetrics(metrics: GpuMetrics): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (prefix: string, value: unknown): void => {
    if (typeof value === 'number') {
      out[prefix] = value;
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(prefix ? `${prefix}.${key}` : key, child);
    }
  };
  walk('gpu', metrics);
  return out;
}
