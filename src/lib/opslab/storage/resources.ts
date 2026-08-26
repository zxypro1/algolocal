/**
 * 存储的三个对象
 *
 * `StorageClass` 说的是「怎么造」，`PersistentVolume` 是造出来的那块盘，
 * `PersistentVolumeClaim` 是应用提出的要求。应用只写 PVC，绑定由控制器做 ——
 * 这一层间接正是「Pod 不知道自己的数据落在哪台机器上」的来源。
 *
 * PV 和 PVC 都是核心组（v1），StorageClass 在 storage.k8s.io 里。
 * 这个区别有实际后果：`kubectl api-resources` 里它们分在不同的组，
 * RBAC 规则也要分开写。
 */
import type { ResourceDefinition } from '../apiserver';

export const PERSISTENTVOLUMES: ResourceDefinition = {
  group: '', version: 'v1', resource: 'persistentvolumes',
  singular: 'persistentvolume', kind: 'PersistentVolume', namespaced: false,
  shortNames: ['pv'], subresources: ['status'],
};

export const PERSISTENTVOLUMECLAIMS: ResourceDefinition = {
  group: '', version: 'v1', resource: 'persistentvolumeclaims',
  singular: 'persistentvolumeclaim', kind: 'PersistentVolumeClaim', namespaced: true,
  shortNames: ['pvc'], categories: ['all'], subresources: ['status'],
};

export const STORAGECLASSES: ResourceDefinition = {
  group: 'storage.k8s.io', version: 'v1', resource: 'storageclasses',
  singular: 'storageclass', kind: 'StorageClass', namespaced: false,
  shortNames: ['sc'],
};

export const STORAGE_RESOURCES: ResourceDefinition[] = [
  PERSISTENTVOLUMES, PERSISTENTVOLUMECLAIMS, STORAGECLASSES,
];

/**
 * 动态供给的那个组件。
 *
 * 静态绑定（管理员先建好 PV）是 kube-controller-manager 干的，控制面自带；
 * **动态供给**是外部 CSI 驱动干的，它是一个跑在集群里的工作负载。
 * 把它停掉，StorageClass 还在、PVC 还能提交，但永远停在 Pending ——
 * 真集群里这条最难查，因为所有对象看起来都正常。
 */
export const CSI_DRIVER_LABEL = { key: 'app.kubernetes.io/name', value: 'csi-driver' };

/** 默认 StorageClass 的标记 */
export const DEFAULT_CLASS_ANNOTATION = 'storageclass.kubernetes.io/is-default-class';
