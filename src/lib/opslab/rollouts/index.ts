/**
 * 渐进式发布
 *
 * Deployment 的滚动更新只关心「新的起来了没有」，不关心「新的好不好」。
 * Rollout 把发布过程本身写成 steps：放多少流量、停多久、看哪条指标。
 * 分析失败时**自动回到稳定版本**，不需要人介入。
 */
export { ROLLOUTS, ANALYSISTEMPLATES, ANALYSISRUNS, ROLLOUT_RESOURCES, ROLLOUTS_LABEL } from './resources';
export { RolloutController, checkCondition } from './controller';
export type { AnalysisEvaluator, RolloutsOptions } from './controller';
