/**
 * CSI 卷快照
 *
 * 三个对象对应三件事：`VolumeSnapshotClass` 说的是「谁来拍、拍完怎么处置」，
 * `VolumeSnapshot` 是应用侧提出的一次请求，`VolumeSnapshotContent` 是存储侧
 * 真正那张快照。中间这层间接和 PVC/PV 一模一样，原因也一样：请求的人和
 * 拥有数据的人不是同一个，生命周期也不该绑在一起。
 *
 * 快照是**时间点**。拍完之后往卷里再写什么，都跟这张快照无关了 ——
 * 这句话听起来是废话，但「备份跑完之后又写进去的数据也一并恢复了吧」
 * 是真实发生过的误解。
 */
import type { ResourceDefinition } from '../apiserver';

export const VOLUMESNAPSHOTCLASSES: ResourceDefinition = {
  group: 'snapshot.storage.k8s.io', version: 'v1', resource: 'volumesnapshotclasses',
  singular: 'volumesnapshotclass', kind: 'VolumeSnapshotClass', namespaced: false,
  shortNames: ['vsclass', 'vsclasses'],
};

export const VOLUMESNAPSHOTS: ResourceDefinition = {
  group: 'snapshot.storage.k8s.io', version: 'v1', resource: 'volumesnapshots',
  singular: 'volumesnapshot', kind: 'VolumeSnapshot', namespaced: true,
  shortNames: ['vs'], subresources: ['status'],
};

export const VOLUMESNAPSHOTCONTENTS: ResourceDefinition = {
  group: 'snapshot.storage.k8s.io', version: 'v1', resource: 'volumesnapshotcontents',
  singular: 'volumesnapshotcontent', kind: 'VolumeSnapshotContent', namespaced: false,
  shortNames: ['vsc', 'vscs'], subresources: ['status'],
};

export const SNAPSHOT_RESOURCES: ResourceDefinition[] = [
  VOLUMESNAPSHOTCLASSES, VOLUMESNAPSHOTS, VOLUMESNAPSHOTCONTENTS,
];

/**
 * 快照控制器。
 *
 * 它和 CSI 驱动是**两个**工作负载：驱动负责造盘，snapshot-controller 负责
 * 把 VolumeSnapshot 变成 VolumeSnapshotContent。装了驱动没装它，
 * `kubectl apply` 一个 VolumeSnapshot 会成功 —— 对象建出来了，
 * 然后永远 readyToUse: false，一个事件都没有。
 */
export const SNAPSHOT_CONTROLLER_LABEL = {
  key: 'app.kubernetes.io/name', value: 'snapshot-controller',
};
