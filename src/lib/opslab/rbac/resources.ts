/**
 * RBAC 的对象
 *
 * 四个类型，两两成对：`Role` / `ClusterRole` 说「能对什么做什么」，
 * `RoleBinding` / `ClusterRoleBinding` 说「谁拿到这套权限」。
 *
 * 最容易记混的是 RoleBinding 引用 ClusterRole 这种组合：权限的**范围**
 * 由 Binding 决定，不由 Role 决定。用 RoleBinding 绑一个 ClusterRole，
 * 拿到的只是那一个命名空间里的权限 —— 这正是「一套只读角色复用到每个
 * 命名空间」的标准做法。
 */
import type { ResourceDefinition } from '../apiserver';

export const ROLES: ResourceDefinition = {
  group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'roles',
  singular: 'role', kind: 'Role', namespaced: true, shortNames: [],
};

export const ROLEBINDINGS: ResourceDefinition = {
  group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'rolebindings',
  singular: 'rolebinding', kind: 'RoleBinding', namespaced: true, shortNames: [],
};

export const CLUSTERROLES: ResourceDefinition = {
  group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'clusterroles',
  singular: 'clusterrole', kind: 'ClusterRole', namespaced: false, shortNames: [],
};

export const CLUSTERROLEBINDINGS: ResourceDefinition = {
  group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'clusterrolebindings',
  singular: 'clusterrolebinding', kind: 'ClusterRoleBinding', namespaced: false, shortNames: [],
};

export const RBAC_RESOURCES: ResourceDefinition[] = [
  ROLES, ROLEBINDINGS, CLUSTERROLES, CLUSTERROLEBINDINGS,
];

/** 谁在发这个请求 */
export interface UserInfo {
  username: string;
  groups: string[];
  uid?: string;
}

/** 未认证的请求。真集群里这类请求只能碰 /healthz 之类。 */
export const ANONYMOUS: UserInfo = {
  username: 'system:anonymous',
  groups: ['system:unauthenticated'],
};

/** 绕过一切鉴权的身份。没有配 RBAC 的世界里，所有请求都是它。 */
export const CLUSTER_ADMIN: UserInfo = {
  username: 'kubernetes-admin',
  groups: ['system:masters', 'system:authenticated'],
};
