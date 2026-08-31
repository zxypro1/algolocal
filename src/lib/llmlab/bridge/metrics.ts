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

  return {
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
