/**
 * 备份与恢复
 *
 * 这一层只回答一个问题：**东西没了之后，能不能拿回来**。
 *
 * 拿回来要两样都在：对象图（PVC 的 YAML）和字节（盘上的数据）。
 * 只备份对象图的话，恢复出来是一个一模一样的空盘 —— 而 `kubectl get pvc`
 * 看不出空盘和满盘的区别，所以这个错误往往在最不能出错的那天才被发现。
 */
export {
  VOLUMESNAPSHOTS, VOLUMESNAPSHOTCONTENTS, VOLUMESNAPSHOTCLASSES,
  SNAPSHOT_RESOURCES, SNAPSHOT_CONTROLLER_LABEL,
} from './resources';
export { SnapshotController } from './snapshots';
export type { SnapshotOptions } from './snapshots';
export {
  BACKUPS, RESTORES, BACKUPSTORAGELOCATIONS, VELERO_RESOURCES, VELERO_LABEL,
  CSI_CLASS_LABEL, EXCLUDE_LABEL, BackupStore, VeleroController,
} from './velero';
export type { StoredBackup, VeleroOptions } from './velero';
export { createVeleroCommand } from './velerocli';
export type { VeleroCliOptions } from './velerocli';
