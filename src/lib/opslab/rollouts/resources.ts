/**
 * Argo Rollouts 的 CRD
 *
 * `Rollout` 是 Deployment 的替代品，不是补充 —— 一个工作负载要么由
 * Deployment 管，要么由 Rollout 管。它多出来的是**发布过程本身可以被描述**：
 * 分几步、每步放多少流量、每步停多久、停的时候看什么指标。
 */
import type { ResourceDefinition } from '../apiserver';

export const ROLLOUTS: ResourceDefinition = {
  group: 'argoproj.io', version: 'v1alpha1', resource: 'rollouts',
  singular: 'rollout', kind: 'Rollout', namespaced: true,
  shortNames: ['ro'], categories: ['all'], subresources: ['status', 'scale'],
};

export const ANALYSISTEMPLATES: ResourceDefinition = {
  group: 'argoproj.io', version: 'v1alpha1', resource: 'analysistemplates',
  singular: 'analysistemplate', kind: 'AnalysisTemplate', namespaced: true, shortNames: ['at'],
};

export const ANALYSISRUNS: ResourceDefinition = {
  group: 'argoproj.io', version: 'v1alpha1', resource: 'analysisruns',
  singular: 'analysisrun', kind: 'AnalysisRun', namespaced: true,
  shortNames: ['ar'], subresources: ['status'],
};

export const ROLLOUT_RESOURCES: ResourceDefinition[] = [ROLLOUTS, ANALYSISTEMPLATES, ANALYSISRUNS];

/** 控制器自己。没有它，Rollout 就只是一个对象。 */
export const ROLLOUTS_LABEL = { key: 'app.kubernetes.io/name', value: 'argo-rollouts' };
