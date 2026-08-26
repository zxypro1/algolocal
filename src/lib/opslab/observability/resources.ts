/**
 * Prometheus Operator 与 OTel 的 CRD
 *
 * `ServiceMonitor` 是采集配置：按标签选中一批 Service，去它们后面的 Pod 上拉。
 * 它最容易出的问题不是写错，而是**没被 Prometheus 选中** —— Prometheus 自己
 * 也有一个 `serviceMonitorSelector`，两边对不上就一条指标都采不到，
 * 而两边看起来都很正常。
 */
import type { ResourceDefinition } from '../apiserver';

export const SERVICEMONITORS: ResourceDefinition = {
  group: 'monitoring.coreos.com', version: 'v1', resource: 'servicemonitors',
  singular: 'servicemonitor', kind: 'ServiceMonitor', namespaced: true, shortNames: ['smon'],
};

export const PROMETHEUSRULES: ResourceDefinition = {
  group: 'monitoring.coreos.com', version: 'v1', resource: 'prometheusrules',
  singular: 'prometheusrule', kind: 'PrometheusRule', namespaced: true, shortNames: ['promrule'],
};

export const PROMETHEUSES: ResourceDefinition = {
  group: 'monitoring.coreos.com', version: 'v1', resource: 'prometheuses',
  singular: 'prometheus', kind: 'Prometheus', namespaced: true, shortNames: ['prom'],
  subresources: ['status'],
};

export const OBSERVABILITY_RESOURCES: ResourceDefinition[] = [
  SERVICEMONITORS, PROMETHEUSRULES, PROMETHEUSES,
];

/** Prometheus 自己。没有它，ServiceMonitor 与 PrometheusRule 都只是声明。 */
export const PROMETHEUS_LABEL = { key: 'app.kubernetes.io/name', value: 'prometheus' };
