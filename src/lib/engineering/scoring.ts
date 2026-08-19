/**
 * 把「测试通过率 + 工程指标 + 静态分析」折算成各维度得分
 *
 * 做题只有对/错，工程要看权衡：跑对了但把下游打挂（并发失控）、
 * 或者串行跑完（延迟爆炸）、或者写成一个 500 行的上帝函数，都不算做好。
 */
import type {
  DimensionKey,
  DimensionScore,
  DimensionWeights,
  GateResult,
  LabMetrics,
  QualityReport,
  ScoreCard,
  StageRunReport,
} from './types';
import { DIMENSION_KEYS } from './types';

const DEFAULT_WEIGHTS: Record<DimensionKey, number> = {
  correctness: 3,
  concurrency: 1.5,
  latency: 1.5,
  resilience: 1,
  encapsulation: 1.5,
  elegance: 1,
};

/** 未达标时给部分分：越接近门槛分越高 */
function partialCredit(result: GateResult): number {
  const { gate, actual } = result;
  if (result.passed) return 100;
  if (!Number.isFinite(actual)) return 0;

  switch (gate.op) {
    case 'lte':
    case 'lt': {
      if (actual <= 0) return 100;
      return Math.max(0, Math.min(95, Math.round((gate.value / actual) * 100)));
    }
    case 'gte':
    case 'gt': {
      if (gate.value <= 0) return 0;
      return Math.max(0, Math.min(95, Math.round((actual / gate.value) * 100)));
    }
    default:
      return 0;
  }
}

function gateScoreFor(dimension: DimensionKey, gates: GateResult[]): number | null {
  const relevant = gates.filter((result) => result.gate.dimension === dimension);
  if (relevant.length === 0) return null;
  const total = relevant.reduce((sum, result) => sum + partialCredit(result), 0);
  return Math.round(total / relevant.length);
}

function concurrencyFallback(metrics: LabMetrics): number {
  if (metrics.requests.total <= 1) return 100;
  if (metrics.maxConcurrency <= 1) return 55; // 完全串行
  if (metrics.requests.throttled > 0) return 65; // 并发失控被限流
  return 90;
}

function latencyFallback(metrics: LabMetrics): number {
  if (metrics.requests.total === 0) return 100;
  // 没有显式门槛时，用「实际耗时 / 完全串行耗时」粗略衡量并行收益
  const serialEstimate = metrics.samples.reduce(
    (sum, sample) => sum + Math.max(0, sample.endedAt - sample.startedAt),
    0
  );
  if (serialEstimate <= 0 || metrics.virtualElapsedMs <= 0) return 85;
  const speedup = serialEstimate / metrics.virtualElapsedMs;
  return Math.max(40, Math.min(100, Math.round(50 + speedup * 12)));
}

function resilienceFallback(metrics: LabMetrics): number {
  let score = 100;
  score -= Math.min(50, metrics.requests.throttled * 10);
  score -= Math.min(20, metrics.requests.duplicated * 2);
  const unrecovered = metrics.requests.failed - metrics.requests.retries;
  if (unrecovered > 0) score -= Math.min(25, unrecovered * 5);
  return Math.max(0, score);
}

function describe(zh: string, en: string) {
  return { zh, en };
}

export interface ScoreInput {
  report: StageRunReport;
  quality: QualityReport;
  weights?: DimensionWeights;
}

export function computeScoreCard({ report, quality, weights }: ScoreInput): ScoreCard {
  const { metrics, gates, totals } = report;

  const passRate = totals.total > 0 ? totals.passed / totals.total : 0;
  const correctness = Math.round(passRate * 100);

  const concurrency = gateScoreFor('concurrency', gates) ?? concurrencyFallback(metrics);
  const latency = gateScoreFor('latency', gates) ?? latencyFallback(metrics);
  const resilience = gateScoreFor('resilience', gates) ?? resilienceFallback(metrics);

  /**
   * 「什么都没发生」不等于「做得很好」。
   *
   * 没有请求时，各个 fallback 都会返回 100，而 `virtualElapsedMs ≤ 360` 这类预算
   * 门槛在实际耗时为 0 时也会通过 —— 于是一份原样未动的骨架能拿到满分的并发、
   * 延迟、容错。这几项在没有可测数据时标成未测量，不进总分。
   */
  const hasActivity = metrics.requests.total > 0 || metrics.virtualElapsedMs > 0;
  const staticMeasured = quality.metrics.totalLines > 0;

  const measured: Record<DimensionKey, boolean> = {
    correctness: true,
    concurrency: hasActivity,
    latency: hasActivity,
    resilience: hasActivity,
    encapsulation: staticMeasured,
    elegance: staticMeasured,
  };

  const scores: Record<DimensionKey, { score: number; detail: { zh: string; en: string } }> = {
    correctness: {
      score: correctness,
      detail: describe(
        `${totals.passed}/${totals.total} 个验收用例通过`,
        `${totals.passed}/${totals.total} acceptance cases passed`
      ),
    },
    concurrency: {
      score: concurrency,
      detail: describe(
        `峰值并发 ${metrics.maxConcurrency}，被限流 ${metrics.requests.throttled} 次`,
        `Peak concurrency ${metrics.maxConcurrency}, throttled ${metrics.requests.throttled} times`
      ),
    },
    latency: {
      score: latency,
      detail: describe(
        `虚拟总耗时 ${metrics.virtualElapsedMs}ms`,
        `Virtual wall time ${metrics.virtualElapsedMs}ms`
      ),
    },
    resilience: {
      score: resilience,
      detail: describe(
        `失败 ${metrics.requests.failed} 次，重试 ${metrics.requests.retries} 次，重复请求 ${metrics.requests.duplicated} 次`,
        `${metrics.requests.failed} failures, ${metrics.requests.retries} retries, ${metrics.requests.duplicated} duplicate calls`
      ),
    },
    encapsulation: {
      score: quality.encapsulationScore,
      detail: describe(
        `${quality.metrics.fileCount} 个模块，最大出度 ${quality.metrics.maxFanOut}${quality.metrics.hasCycles ? '，存在循环依赖' : ''}`,
        `${quality.metrics.fileCount} modules, max fan-out ${quality.metrics.maxFanOut}${quality.metrics.hasCycles ? ', cycles detected' : ''}`
      ),
    },
    elegance: {
      score: quality.eleganceScore,
      detail: describe(
        `最长函数 ${quality.metrics.maxFunctionLines} 行，峰值圈复杂度 ${quality.metrics.maxCyclomatic}`,
        `Longest function ${quality.metrics.maxFunctionLines} lines, peak complexity ${quality.metrics.maxCyclomatic}`
      ),
    },
  };

  const dimensions: DimensionScore[] = DIMENSION_KEYS.map((key) => ({
    key,
    score: scores[key].score,
    weight: weights?.[key] ?? DEFAULT_WEIGHTS[key],
    detail: scores[key].detail,
    measured: measured[key],
  })).filter((dimension) => dimension.weight > 0);

  const counted = dimensions.filter((dimension) => dimension.measured);
  const weightSum = counted.reduce((sum, dimension) => sum + dimension.weight, 0) || 1;
  const weighted =
    counted.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0) / weightSum;

  /**
   * 工程分按验收通过率折算。
   *
   * 并发、延迟、容错讲的都是「这套能跑的东西表现如何」；实现是错的时候，这些数字
   * 不构成成绩。以前不折算，于是一份完全没写的骨架能拿 75 分（正确性 0，其余全 100），
   * 而参考实现才 89~100 —— 整个刻度挤在 75 到 100 之间，基本不区分好坏。
   */
  const total = Math.round(weighted * passRate);

  return { total, dimensions, passRate };
}
