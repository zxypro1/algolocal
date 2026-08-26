/**
 * CustomResourceDefinition
 *
 * 一个 CRD 干的事只有一件：**让 apiserver 多认识一种类型**。
 * 认识之后，这种类型就自动拥有全套东西 —— REST 端点、watch、RBAC 里的
 * 资源名、`kubectl get` 能查、YAML 能 apply。这就是「Kubernetes 是一个
 * 通用的声明式 API 服务器」这句话的具体含义：控制器只是消费者，
 * 存储和分发是白送的。
 *
 * 反过来也要记住：**删 CRD 会连带删掉这个类型的所有对象**，
 * 和删命名空间一个量级。
 */
import type { ResourceDefinition } from '../apiserver';

export const CUSTOMRESOURCEDEFINITIONS: ResourceDefinition = {
  group: 'apiextensions.k8s.io', version: 'v1', resource: 'customresourcedefinitions',
  singular: 'customresourcedefinition', kind: 'CustomResourceDefinition', namespaced: false,
  shortNames: ['crd', 'crds'], subresources: ['status'],
};

export const CRD_RESOURCES: ResourceDefinition[] = [CUSTOMRESOURCEDEFINITIONS];
