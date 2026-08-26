/**
 * External Secrets Operator 的 CRD
 *
 * 两个对象：`SecretStore` 说「去哪儿取、用什么身份」，`ExternalSecret` 说
 * 「取哪几个、放进哪个 Secret」。集群里的 Secret 由控制器生成，人不该手写它 ——
 * 手写的那份下一次同步就被覆盖了。
 */
import type { ResourceDefinition } from '../apiserver';

export const SECRETSTORES: ResourceDefinition = {
  group: 'external-secrets.io', version: 'v1', resource: 'secretstores',
  singular: 'secretstore', kind: 'SecretStore', namespaced: true,
  shortNames: ['ss'], subresources: ['status'],
};

export const CLUSTERSECRETSTORES: ResourceDefinition = {
  group: 'external-secrets.io', version: 'v1', resource: 'clustersecretstores',
  singular: 'clustersecretstore', kind: 'ClusterSecretStore', namespaced: false,
  shortNames: ['css'], subresources: ['status'],
};

export const EXTERNALSECRETS: ResourceDefinition = {
  group: 'external-secrets.io', version: 'v1', resource: 'externalsecrets',
  singular: 'externalsecret', kind: 'ExternalSecret', namespaced: true,
  shortNames: ['es'], subresources: ['status'],
};

export const ESO_RESOURCES: ResourceDefinition[] = [
  SECRETSTORES, CLUSTERSECRETSTORES, EXTERNALSECRETS,
];

/** ESO 的控制面。没有它，ExternalSecret 就只是一条声明。 */
export const ESO_LABEL = { key: 'app.kubernetes.io/name', value: 'external-secrets' };
