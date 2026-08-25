/**
 * Kyverno 的 CRD
 *
 * `ClusterPolicy` 是集群级的，`Policy` 是命名空间级的。这里只做前者 ——
 * 「公司的规矩」天然是全集群的，而两者的规则语法完全一样。
 */
import type { ResourceDefinition } from '../apiserver';

export const CLUSTERPOLICIES: ResourceDefinition = {
  group: 'kyverno.io', version: 'v1', resource: 'clusterpolicies',
  singular: 'clusterpolicy', kind: 'ClusterPolicy', namespaced: false,
  shortNames: ['cpol'], subresources: ['status'],
};

export const POLICYREPORTS: ResourceDefinition = {
  group: 'wgpolicyk8s.io', version: 'v1alpha2', resource: 'policyreports',
  singular: 'policyreport', kind: 'PolicyReport', namespaced: true,
  shortNames: ['polr'],
};

export const KYVERNO_RESOURCES: ResourceDefinition[] = [CLUSTERPOLICIES, POLICYREPORTS];

/** Kyverno 的控制面。没有它，策略一条都不执行。 */
export const KYVERNO_LABEL = { key: 'app.kubernetes.io/name', value: 'kyverno' };
