/**
 * cert-manager 的资源
 *
 * 内网 PKI 的日常形态：`Issuer` / `ClusterIssuer` 说「谁来签」，
 * `Certificate` 说「给谁签、签成什么样、放进哪个 Secret」，控制器把签好的
 * 证书写进一个 `kubernetes.io/tls` 类型的 Secret。Gateway 与应用只认那个 Secret。
 */
import type { ResourceDefinition } from '../apiserver';

const GROUP = 'cert-manager.io';
const VERSION = 'v1';

export const ISSUERS: ResourceDefinition = {
  group: GROUP, version: VERSION, resource: 'issuers',
  singular: 'issuer', kind: 'Issuer', namespaced: true,
  shortNames: [], subresources: ['status'],
};

export const CLUSTERISSUERS: ResourceDefinition = {
  group: GROUP, version: VERSION, resource: 'clusterissuers',
  singular: 'clusterissuer', kind: 'ClusterIssuer', namespaced: false,
  shortNames: [], subresources: ['status'],
};

export const CERTIFICATES: ResourceDefinition = {
  group: GROUP, version: VERSION, resource: 'certificates',
  singular: 'certificate', kind: 'Certificate', namespaced: true,
  shortNames: ['cert'], subresources: ['status'],
};

export const CERT_RESOURCES: ResourceDefinition[] = [ISSUERS, CLUSTERISSUERS, CERTIFICATES];
