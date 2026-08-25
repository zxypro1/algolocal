/**
 * Argo CD 的 CRD
 *
 * 字段照抄上游 —— `kubectl get app` 打出来的列、`-o yaml` 里的路径，
 * 都要和真集群一致，不然学员在这里学的读法带不走。
 */
import type { ResourceDefinition } from '../apiserver';

export const APPLICATIONS: ResourceDefinition = {
  group: 'argoproj.io', version: 'v1alpha1', resource: 'applications',
  singular: 'application', kind: 'Application', namespaced: true,
  shortNames: ['app'], subresources: ['status'],
};

export const APPPROJECTS: ResourceDefinition = {
  group: 'argoproj.io', version: 'v1alpha1', resource: 'appprojects',
  singular: 'appproject', kind: 'AppProject', namespaced: true,
  shortNames: ['appproj'], subresources: ['status'],
};

export const ARGOCD_RESOURCES: ResourceDefinition[] = [APPLICATIONS, APPPROJECTS];

/** 控制器自己的标签。没有可用的 Deployment，什么都不同步。 */
export const ARGOCD_LABEL = { key: 'app.kubernetes.io/name', value: 'argocd-application-controller' };

/** Argo 给自己管的对象打的标签，prune 靠它认领地盘 */
export const TRACKING_LABEL = 'app.kubernetes.io/instance';
