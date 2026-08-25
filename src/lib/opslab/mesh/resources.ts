/**
 * Istio ambient 的对象
 *
 * ambient 模式下没有 sidecar：每个节点一个 ztunnel（DaemonSet）做 L4 —— mTLS
 * 与身份；需要 L7（按方法、按路径授权，重试，熔断）时再给命名空间或服务
 * 挂一个 waypoint 代理。
 *
 * 这个分层是 ambient 最容易踩的地方：**L7 的授权策略在没有 waypoint 的时候
 * 不生效**，而 apiserver 照样收下，`kubectl get` 照样看得见。和「没有 CNI 时
 * NetworkPolicy 是废纸」是同一类问题。
 */
import type { ResourceDefinition } from '../apiserver';

export const PEERAUTHENTICATIONS: ResourceDefinition = {
  group: 'security.istio.io', version: 'v1', resource: 'peerauthentications',
  singular: 'peerauthentication', kind: 'PeerAuthentication', namespaced: true,
  shortNames: ['pa'], subresources: ['status'],
};

export const AUTHORIZATIONPOLICIES: ResourceDefinition = {
  group: 'security.istio.io', version: 'v1', resource: 'authorizationpolicies',
  singular: 'authorizationpolicy', kind: 'AuthorizationPolicy', namespaced: true,
  shortNames: ['ap'], subresources: ['status'],
};

export const MESH_RESOURCES: ResourceDefinition[] = [PEERAUTHENTICATIONS, AUTHORIZATIONPOLICIES];

/** 命名空间打上这个标签，里面的 Pod 就进网格 */
export const AMBIENT_LABEL = { key: 'istio.io/dataplane-mode', value: 'ambient' };

/** ztunnel 与 istiod 各自的标识。没有它们，网格里什么都不发生。 */
export const ZTUNNEL_LABEL = { key: 'app', value: 'ztunnel' };
export const ISTIOD_LABEL = { key: 'app', value: 'istiod' };

/** waypoint 的 GatewayClass。挂上它，这个命名空间才有 L7。 */
export const WAYPOINT_CLASS = 'istio-waypoint';

/** SPIFFE：`spiffe://<trust domain>/ns/<ns>/sa/<serviceaccount>` */
export const TRUST_DOMAIN = 'cluster.local';

export function spiffeId(namespace: string, serviceAccount = 'default'): string {
  return `spiffe://${TRUST_DOMAIN}/ns/${namespace}/sa/${serviceAccount}`;
}
