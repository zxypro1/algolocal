/**
 * Gateway API 的资源定义
 *
 * ingress-nginx 在 2026-03-24 退役之后，Gateway API 是入口的事实标准。
 * 它和 Ingress 最大的区别是**角色分离**：GatewayClass 由平台方提供，
 * Gateway 由集群管理员建（决定监听哪些端口、用什么证书、暴露到哪个网段），
 * HTTPRoute 由应用团队自己写（决定路径怎么分发）。
 *
 * 这个分离是第 8 关的骨架：学员要能说清楚哪一层归谁管。
 */
import type { ResourceDefinition } from '../apiserver';

const GROUP = 'gateway.networking.k8s.io';
const VERSION = 'v1';

export const GATEWAYCLASSES: ResourceDefinition = {
  group: GROUP, version: VERSION, resource: 'gatewayclasses',
  singular: 'gatewayclass', kind: 'GatewayClass', namespaced: false,
  shortNames: ['gc'], subresources: ['status'],
};

export const GATEWAYS: ResourceDefinition = {
  group: GROUP, version: VERSION, resource: 'gateways',
  singular: 'gateway', kind: 'Gateway', namespaced: true,
  shortNames: ['gtw'], subresources: ['status'],
};

export const HTTPROUTES: ResourceDefinition = {
  group: GROUP, version: VERSION, resource: 'httproutes',
  singular: 'httproute', kind: 'HTTPRoute', namespaced: true,
  shortNames: [], subresources: ['status'],
};

export const GRPCROUTES: ResourceDefinition = {
  group: GROUP, version: VERSION, resource: 'grpcroutes',
  singular: 'grpcroute', kind: 'GRPCRoute', namespaced: true,
  shortNames: [], subresources: ['status'],
};

/**
 * BackendTLSPolicy（v1alpha3）。
 *
 * **暂时不注册**：后端 TLS 还没实现，注册了就会出现「apply 成功但什么都没发生」
 * 这种最坏的情况。等做到那一步再加进 GATEWAY_RESOURCES。
 */
export const BACKENDTLSPOLICIES: ResourceDefinition = {
  group: GROUP, version: 'v1alpha3', resource: 'backendtlspolicies',
  singular: 'backendtlspolicy', kind: 'BackendTLSPolicy', namespaced: true,
  shortNames: ['btlspolicy'], subresources: ['status'],
};

/**
 * Envoy Gateway 自己的参数对象。
 *
 * GatewayClass 通过 `parametersRef` 指到它，里面写着「给这个 class 的 Gateway
 * 建出来的 LoadBalancer Service 长什么样」—— 用哪个 loadBalancerClass，
 * 也就决定了它被暴露到哪个网段。内网入口和公网入口的区别就在这一处，
 * 不在 Gateway 自己身上。
 */
export const ENVOYPROXIES: ResourceDefinition = {
  group: 'gateway.envoyproxy.io', version: 'v1alpha1', resource: 'envoyproxies',
  singular: 'envoyproxy', kind: 'EnvoyProxy', namespaced: true,
  shortNames: [], subresources: ['status'],
};

export const GATEWAY_RESOURCES: ResourceDefinition[] = [
  GATEWAYCLASSES, GATEWAYS, HTTPROUTES, GRPCROUTES, ENVOYPROXIES,
];
