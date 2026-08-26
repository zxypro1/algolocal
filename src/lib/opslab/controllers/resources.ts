/**
 * 核心资源定义
 *
 * 这一批是「跑起一个服务」这条最短路径上必需的：
 * Namespace / Node / Pod / ReplicaSet / Deployment / Service / Endpoints / Event。
 * 字段与简称照抄真集群，`kubectl api-resources` 打出来要能对上。
 */
import type { ResourceDefinition } from '../apiserver';

export const NAMESPACES: ResourceDefinition = {
  group: '', version: 'v1', resource: 'namespaces', singular: 'namespace', kind: 'Namespace',
  namespaced: false, shortNames: ['ns'], subresources: ['status'],
};

export const NODES: ResourceDefinition = {
  group: '', version: 'v1', resource: 'nodes', singular: 'node', kind: 'Node',
  namespaced: false, shortNames: ['no'], subresources: ['status'],
};

export const PODS: ResourceDefinition = {
  group: '', version: 'v1', resource: 'pods', singular: 'pod', kind: 'Pod',
  namespaced: true, shortNames: ['po'], categories: ['all'],
  // eviction 必须出现在 discovery 里，否则 kubectl drain 会退回 delete，
  // 而 delete 不问 PDB
  subresources: ['status', 'eviction'],
};

export const SERVICES: ResourceDefinition = {
  group: '', version: 'v1', resource: 'services', singular: 'service', kind: 'Service',
  namespaced: true, shortNames: ['svc'], categories: ['all'], subresources: ['status'],
};

export const ENDPOINTS: ResourceDefinition = {
  group: '', version: 'v1', resource: 'endpoints', singular: 'endpoints', kind: 'Endpoints',
  namespaced: true, shortNames: ['ep'],
};

export const EVENTS: ResourceDefinition = {
  group: '', version: 'v1', resource: 'events', singular: 'event', kind: 'Event',
  namespaced: true, shortNames: ['ev'],
};

export const REPLICASETS: ResourceDefinition = {
  group: 'apps', version: 'v1', resource: 'replicasets', singular: 'replicaset', kind: 'ReplicaSet',
  namespaced: true, shortNames: ['rs'], categories: ['all'], subresources: ['status', 'scale'],
};

export const DEPLOYMENTS: ResourceDefinition = {
  group: 'apps', version: 'v1', resource: 'deployments', singular: 'deployment', kind: 'Deployment',
  namespaced: true, shortNames: ['deploy'], categories: ['all'], subresources: ['status', 'scale'],
};

export const CONFIGMAPS: ResourceDefinition = {
  group: '', version: 'v1', resource: 'configmaps', singular: 'configmap', kind: 'ConfigMap',
  namespaced: true, shortNames: ['cm'],
};

export const SECRETS: ResourceDefinition = {
  group: '', version: 'v1', resource: 'secrets', singular: 'secret', kind: 'Secret',
  namespaced: true, shortNames: [],
};

export const SERVICEACCOUNTS: ResourceDefinition = {
  group: '', version: 'v1', resource: 'serviceaccounts', singular: 'serviceaccount',
  kind: 'ServiceAccount', namespaced: true, shortNames: ['sa'],
};

export const NETWORKPOLICIES: ResourceDefinition = {
  group: 'networking.k8s.io', version: 'v1', resource: 'networkpolicies',
  singular: 'networkpolicy', kind: 'NetworkPolicy', namespaced: true, shortNames: ['netpol'],
};

export const INGRESSES: ResourceDefinition = {
  group: 'networking.k8s.io', version: 'v1', resource: 'ingresses',
  singular: 'ingress', kind: 'Ingress', namespaced: true, shortNames: ['ing'],
  subresources: ['status'],
};

export const INGRESSCLASSES: ResourceDefinition = {
  group: 'networking.k8s.io', version: 'v1', resource: 'ingressclasses',
  singular: 'ingressclass', kind: 'IngressClass', namespaced: false, shortNames: [],
};

export const DAEMONSETS: ResourceDefinition = {
  group: 'apps', version: 'v1', resource: 'daemonsets', singular: 'daemonset', kind: 'DaemonSet',
  namespaced: true, shortNames: ['ds'], categories: ['all'], subresources: ['status'],
};

export const CORE_RESOURCES: ResourceDefinition[] = [
  NAMESPACES, NODES, PODS, SERVICES, ENDPOINTS, EVENTS,
  CONFIGMAPS, SECRETS, SERVICEACCOUNTS,
  REPLICASETS, DEPLOYMENTS, DAEMONSETS,
  NETWORKPOLICIES, INGRESSES, INGRESSCLASSES,
];

/** Deployment 给自己的 ReplicaSet 打的标签，用来区分不同版本 */
export const POD_TEMPLATE_HASH = 'pod-template-hash';

/**
 * pod 模板的哈希。
 *
 * 真 k8s 用 FNV-1a 再做一次特殊编码；我们只要求「同样的模板得到同样的值、
 * 不同的模板不同」，并且**确定性** —— 值本身不必和真集群逐位一致，
 * 但同一份 manifest 在这里每次都得算出同一个后缀，否则回放就飘了。
 */
export function templateHash(template: unknown): string {
  const text = JSON.stringify(template ?? {});
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  // k8s 的后缀用的是一套不含元音的字母表，避免拼出脏字
  const alphabet = 'bcdfghjklmnpqrstvwxz2456789';
  let out = '';
  let value = hash;
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[value % alphabet.length];
    value = Math.floor(value / alphabet.length);
  }
  return out;
}

/** matchLabels 是否命中一组标签 */
export function matchesSelector(
  selector: { matchLabels?: Record<string, string> } | undefined,
  labels: Record<string, string> | undefined
): boolean {
  const wanted = selector?.matchLabels ?? {};
  const actual = labels ?? {};
  return Object.entries(wanted).every(([key, value]) => actual[key] === value);
}
