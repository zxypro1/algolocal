/**
 * Cluster API
 *
 * 内网集群没有云厂商的弹性伸缩组，机器要么是人手装的，要么是 Cluster API
 * 声明出来的。它的形状和工作负载那一套**故意长得一样**：
 *
 *   Deployment        -> MachineDeployment
 *   ReplicaSet        -> MachineSet
 *   Pod               -> Machine        -> Node
 *
 * 这个对应关系本身就是要教的东西：机器也是声明出来的，改副本数就是加机器，
 * 而「加机器」这件事从此有了和滚动更新一样的语义（模板变了就换一批）。
 *
 * Machine 和 Node 是两个对象。Machine 是「我要一台机器」，Node 是「这台机器
 * 上的 kubelet 报到了」。中间隔着装机时间 —— 弹性伸缩里所有的等待都来自这段。
 */
import type { ResourceDefinition } from '../apiserver';

export const CLUSTERS: ResourceDefinition = {
  group: 'cluster.x-k8s.io', version: 'v1beta1', resource: 'clusters',
  singular: 'cluster', kind: 'Cluster', namespaced: true,
  shortNames: ['cl'], subresources: ['status'],
};

export const MACHINEDEPLOYMENTS: ResourceDefinition = {
  group: 'cluster.x-k8s.io', version: 'v1beta1', resource: 'machinedeployments',
  singular: 'machinedeployment', kind: 'MachineDeployment', namespaced: true,
  shortNames: ['md'], subresources: ['status', 'scale'],
};

export const MACHINESETS: ResourceDefinition = {
  group: 'cluster.x-k8s.io', version: 'v1beta1', resource: 'machinesets',
  singular: 'machineset', kind: 'MachineSet', namespaced: true,
  shortNames: ['ms'], subresources: ['status', 'scale'],
};

export const MACHINES: ResourceDefinition = {
  group: 'cluster.x-k8s.io', version: 'v1beta1', resource: 'machines',
  singular: 'machine', kind: 'Machine', namespaced: true,
  shortNames: ['ma'], subresources: ['status'],
};

/**
 * 基础设施那一侧。
 *
 * CAPI 自己不知道怎么造机器，造机器是 provider 的事。内网最常见的是
 * vSphere，所以这里用 CAPV 的模板类型 —— 机器的规格（几核几 G）写在它上面，
 * 而不是写在 MachineDeployment 上。这个分层解释了一个常见困惑：
 * 「我改了副本数，为什么新机器还是老规格」—— 规格不在你改的那个对象上。
 */
export const VSPHEREMACHINETEMPLATES: ResourceDefinition = {
  group: 'infrastructure.cluster.x-k8s.io', version: 'v1beta1',
  resource: 'vspheremachinetemplates',
  singular: 'vspheremachinetemplate', kind: 'VSphereMachineTemplate', namespaced: true,
  shortNames: ['vspheremachinetemplates'],
};

export const CAPI_RESOURCES: ResourceDefinition[] = [
  CLUSTERS, MACHINEDEPLOYMENTS, MACHINESETS, MACHINES, VSPHEREMACHINETEMPLATES,
];

/** 控制器自己。没有它，MachineDeployment 就只是一个对象，一台机器都不会出现。 */
export const CAPI_LABEL = { key: 'app.kubernetes.io/name', value: 'cluster-api' };

/** MachineSet 给自己的 Machine 打的标签 */
export const MACHINE_SET_LABEL = 'cluster.x-k8s.io/set-name';
/** Machine 属于哪个 MachineDeployment */
export const MACHINE_DEPLOYMENT_LABEL = 'cluster.x-k8s.io/deployment-name';
