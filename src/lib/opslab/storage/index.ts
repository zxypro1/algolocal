/**
 * 持久化存储
 *
 * 这一层要立住的是一件事：**数据不属于 Pod**。Pod 是可以随时被杀掉重建的，
 * 数据不是。中间隔着 PVC 和 PV 两层，正是为了让这两件事的生命周期分开。
 */
export {
  PERSISTENTVOLUMES, PERSISTENTVOLUMECLAIMS, STORAGECLASSES, STORAGE_RESOURCES,
  CSI_DRIVER_LABEL, DEFAULT_CLASS_ANNOTATION,
} from './resources';
export { StorageController, createDefaultStorageClassDefaulter } from './controller';
export type { StorageOptions } from './controller';
export { VolumeStore } from './volumes';
export type { VolumeContent } from './volumes';
