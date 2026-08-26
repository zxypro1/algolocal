/**
 * 一个够用的时序库
 *
 * Prometheus 的数据模型：一条序列由指标名加一组标签唯一确定，值按时间点存。
 * 这里保留的是这个模型本身，以及采样间隔带来的后果 —— 两次采样之间发生的事
 * 看不见，这是所有基于采样的监控共有的盲区，值得让学员撞一次。
 *
 * 不做的：远程写、压缩、乱序写入、直方图分位数的插值。
 */

export interface Labels {
  [name: string]: string;
}

export interface Sample {
  /** 虚拟墙钟，毫秒 */
  at: number;
  value: number;
}

export interface Series {
  name: string;
  labels: Labels;
  samples: Sample[];
}

/** 一条序列的身份：指标名 + 排序后的标签 */
export function seriesKey(name: string, labels: Labels): string {
  const parts = Object.entries(labels)
    .filter(([key]) => key !== '__name__')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return `${name}{${parts.join(',')}}`;
}

export class Tsdb {
  private readonly series = new Map<string, Series>();

  /** 采一个点。同一条序列按时间追加。 */
  append(name: string, labels: Labels, at: number, value: number): void {
    const key = seriesKey(name, labels);
    const found = this.series.get(key);
    if (found) {
      found.samples.push({ at, value });
      return;
    }
    this.series.set(key, { name, labels: { ...labels }, samples: [{ at, value }] });
  }

  all(): Series[] {
    return [...this.series.values()].sort((a, b) =>
      (seriesKey(a.name, a.labels) < seriesKey(b.name, b.labels) ? -1 : 1));
  }

  /** 按指标名与标签选择器取序列 */
  select(name: string, matchers: Matcher[] = []): Series[] {
    return this.all().filter((series) =>
      series.name === name && matchers.every((matcher) => matches(matcher, series.labels)));
  }

  /**
   * 某个时刻的瞬时值。
   *
   * 取的是**不晚于该时刻的最后一个点**，而且超过 5 分钟就当作没有数据 ——
   * 和 Prometheus 的 lookback delta 一致。这条决定了「目标挂了之后，
   * 它的指标还会在图上停留五分钟」。
   */
  valueAt(series: Series, at: number, lookbackMs = LOOKBACK_MS): number | undefined {
    let found: Sample | undefined;
    for (const sample of series.samples) {
      if (sample.at > at) break;
      found = sample;
    }
    if (!found) return undefined;
    return at - found.at <= lookbackMs ? found.value : undefined;
  }

  /** 一个时间窗里的点，用于 rate / increase */
  range(series: Series, at: number, windowMs: number): Sample[] {
    return series.samples.filter((sample) => sample.at > at - windowMs && sample.at <= at);
  }

  get size(): number {
    return this.series.size;
  }
}

/** Prometheus 默认的回看窗口 */
export const LOOKBACK_MS = 5 * 60_000;

export interface Matcher {
  label: string;
  op: '=' | '!=' | '=~' | '!~';
  value: string;
}

export function matches(matcher: Matcher, labels: Labels): boolean {
  const actual = labels[matcher.label] ?? '';
  switch (matcher.op) {
    case '=': return actual === matcher.value;
    case '!=': return actual !== matcher.value;
    // Prometheus 的正则是完全匹配，不是搜索 —— 这一条常被忘记
    case '=~': return new RegExp(`^(?:${matcher.value})$`).test(actual);
    case '!~': return !new RegExp(`^(?:${matcher.value})$`).test(actual);
    default: return false;
  }
}
