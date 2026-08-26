/**
 * 可观测性
 *
 * 采集是拉模型且定时的，于是「两次采样之间发生的事看不见」；
 * 告警是对 PromQL 表达式定时求值，于是「表达式写错了不会报错，只是永不触发」。
 * 这两条是这一层所有困惑的来源，也是这里要教的东西。
 */
export { Tsdb, seriesKey, matches, LOOKBACK_MS } from './tsdb';
export type { Labels, Matcher, Sample, Series } from './tsdb';
export { evaluate, parseDuration, counterDelta, PromqlError } from './promql';
export type { InstantValue } from './promql';
export {
  SERVICEMONITORS, PROMETHEUSRULES, PROMETHEUSES, OBSERVABILITY_RESOURCES, PROMETHEUS_LABEL,
} from './resources';
export { targetsOf } from './scrape';
export type { ScrapeTarget, ScrapeView } from './scrape';
export { PrometheusController, SCRAPE_INTERVAL_MS } from './controller';
export type { Alert, MetricsSource } from './controller';
export { createPromtoolCommand } from './promtool';
export type { PromtoolOptions } from './promtool';
