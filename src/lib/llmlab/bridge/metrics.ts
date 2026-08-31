/**
 * `LabMetrics.llm` 那棵树
 *
 * 门槛直接写路径，比如
 * `{ metric: 'llm.flops.backwardPerToken', op: 'lte', value: ... }` ——
 * `getMetricValue` 本来就会一层层走下去，不用改解析（同 gpulab 的 `gpu` 子树）。
 *
 * ## 一条铁律
 *
 * **`llm.timing.*` 只作展示，永远不许出现在门槛里。**
 * 我们是真算，耗时取决于学员的机器 —— 一个在旧笔记本上做对了的实现，
 * 不该因为机器慢而挂。gpulab 那边的同一条规矩是「不许用模拟耗时」，
 * 理由不同，结论一样。
 *
 * 每条指标下面标了「精确 / 估计」。**门槛只许建立在精确的那些上。**
 */
import type { ArenaStats } from './tensor';
import type { Meter, OpName, Phase } from './ops';

export interface LlmMetricTree {
  flops: Record<string, number>;
  memory: Record<string, number>;
  kernelCalls: Record<string, unknown>;
  builtins: Record<string, unknown>;
  params: Record<string, unknown>;
  tokens: Record<string, number>;
  [key: string]: unknown;
}

export interface BuildMetricsInput {
  meter: Meter;
  arena: ArenaStats;
  /**
   * 判定算出来、要给门槛读的值。
   *
   * 有一类量**只能由判定算**：分词器的压缩率、与 fp64 参考的最大误差、
   * 因果泄漏的位数、留出集上的困惑度。它们不是算子层能数出来的，
   * 而是隐藏用例主动去量的。
   *
   * 它们和计量树里那些数**一样硬** —— 因为算它们的是平台的代码，不是学员的。
   * 学员的 `nt.log.report(...)` 落在日志里，不落在这里。
   */
  published?: Record<string, unknown>;
  /** 参数量，按模块分。由模型自己报 —— 它才知道哪些张量是参数 */
  params?: { total: number; active?: number; byModule?: Record<string, number> };
  /** 墙钟，**只作展示** */
  timing?: { msPerStep?: number; tokensPerSecond?: number };
}

function phase(meter: Meter, name: Phase): { calls: number; flops: number } {
  return meter.byPhase.get(name) ?? { calls: 0, flops: 0 };
}

export function buildLlmMetrics(input: BuildMetricsInput): LlmMetricTree {
  const { meter, arena } = input;

  const forward = phase(meter, 'forward');
  const backward = phase(meter, 'backward');
  const optimizer = phase(meter, 'optimizer');
  const generate = phase(meter, 'generate');
  const other = phase(meter, 'other');

  const total = forward.flops + backward.flops + optimizer.flops + generate.flops + other.flops;
  const tokens = meter.tokens;
  const per = (x: number) => (tokens > 0 ? x / tokens : 0);

  const byOp: Record<string, number> = {};
  const flopsByOp: Record<string, number> = {};
  let calls = 0;
  for (const [op, counters] of meter.byOp) {
    byOp[op] = counters.calls;
    flopsByOp[op] = counters.flops;
    calls += counters.calls;
  }

  const forbiddenHits: Record<string, number> = {};
  for (const [op, n] of meter.forbiddenHits) forbiddenHits[op] = n;

  const tree: LlmMetricTree = {
    /* ---- 全部精确：算子层逐次累加，公式写在 ops.ts 每个方法旁边 ---- */
    flops: {
      total,
      forward: forward.flops,
      backward: backward.flops,
      optimizer: optimizer.flops,
      generate: generate.flops,
      forwardPerToken: per(forward.flops),
      backwardPerToken: per(backward.flops),
      /**
       * 反向与前向的比。
       *
       * 理论上约等于 2（每个 gemm 要算 dX 与 dW 两个）。
       * **明显超过 2 说明反向里重算了前向** —— 第 11 关的门槛读它。
       * 前向是 0 时返回 0，不返回 Infinity：门槛拿 Infinity 去比会得出
       * 一个没意义的「通过」。
       */
      backwardOverForward: forward.flops > 0 ? backward.flops / forward.flops : 0,
      generatePerToken: per(generate.flops),
    },

    /* ---- 全部精确：竞技场按分配记的 ---- */
    memory: {
      peakBytes: arena.peakBytes,
      currentBytes: arena.currentBytes,
      /** 只数 activation 那一类 —— 第 17/18 关的门槛读它 */
      peakActivationBytes: arena.peakActivationBytes,
      /**
       * **此刻**还占着的激活。
       *
       * 第 18 关（激活重算）读的是它，不是峰值 —— 重算省下来的是
       * 「前向结束之后为反向留着的那些」，而峰值里混着反向自己的临时量，
       * 那部分重算不但不省，还因为多算一遍而略高。
       * 量错了对象的话，一个完全正确的重算实现会显示成「没省」。
       */
      currentActivationBytes: arena.currentActivationBytes,
      paramBytes: arena.byRole.param,
      gradBytes: arena.byRole.grad,
      optimizerStateBytes: arena.byRole.optimizer,
      dataBytes: arena.byRole.data,
    },

    kernelCalls: { total: calls, byOp, flopsByOp },

    /**
     * 禁止捷径的判据。**精确**：学员的代码只能通过 Ops 碰到算子核，
     * 所以「有没有调不该调的东西」这件事在这里是数出来的，不是猜的。
     */
    builtins: {
      forbiddenCalls: meter.forbiddenCalls,
      forbiddenHits,
      forbidden: [...meter.forbidden],
    },

    params: {
      total: input.params?.total ?? 0,
      active: input.params?.active ?? input.params?.total ?? 0,
      byModule: input.params?.byModule ?? {},
    },

    tokens: { total: tokens },

    /**
     * ⚠️ 只作展示。见文件开头那条铁律 —— 任何门槛写到 `llm.timing.*`
     * 都是错的，出题时会被 verify-projects 拦下来。
     */
    timing: {
      msPerStep: input.timing?.msPerStep ?? 0,
      tokensPerSecond: input.timing?.tokensPerSecond ?? 0,
    },
  };

  // 判定发布的值按点号路径合进去，于是门槛写 `llm.tokenizer.compression` 就能读到
  for (const [path, value] of Object.entries(input.published ?? {})) {
    setPath(tree as Record<string, unknown>, path, value);
  }
  return tree;
}

/** 按 `a.b.c` 写进嵌套对象。中间不存在就建 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * 门槛的指标路径里，哪些是**不许**用的。
 *
 * 出题期的校验拿它比对 —— 与其在文档里写一句「别用 timing」，
 * 不如让写错的题目根本进不了库。
 */
export const FORBIDDEN_GATE_PREFIXES = ['llm.timing.'];

export function isForbiddenGateMetric(metric: string): boolean {
  return FORBIDDEN_GATE_PREFIXES.some((prefix) => metric.startsWith(prefix));
}

export type { OpName };
