/**
 * 快照控制器
 *
 * 一次快照分两步，两步分属两个对象：VolumeSnapshot 是「我要一张」，
 * VolumeSnapshotContent 是「存储上真有这张」。控制器负责把前者变成后者，
 * 并且把那一刻的字节拷进快照里。
 *
 * 这里的字节和 PV 的字节放在同一个 VolumeStore 上，按名字区分
 * （`pvc-xxx` 是盘，`snapcontent-xxx` 是快照）—— 它们本来就是同一种东西：
 * 一堆存储后端上的字节，跟 apiserver 无关。
 */
import type { KubeObject } from '../apiserver';
import {
  Controller, ControllerContext, Informer, isNotFound, objectKey, splitKey,
} from '../controllers/framework';
import { DEPLOYMENTS } from '../controllers/resources';
import { ignoreConflict, updateStatusIfChanged } from '../controllers/workloads';
import { PERSISTENTVOLUMECLAIMS, PERSISTENTVOLUMES } from '../storage';
import type { VolumeStore } from '../storage';
import {
  SNAPSHOT_CONTROLLER_LABEL, VOLUMESNAPSHOTCLASSES, VOLUMESNAPSHOTCONTENTS, VOLUMESNAPSHOTS,
} from './resources';

export interface SnapshotOptions {
  volumes: VolumeStore;
}

export class SnapshotController extends Controller {
  private snapshots: Informer;
  private contents: Informer;
  private classes: Informer;
  private claims: Informer;
  private volumes: Informer;
  private deployments: Informer;

  constructor(context: ControllerContext, private readonly options: SnapshotOptions) {
    super(context, 'snapshot-controller');
    this.snapshots = new Informer(this.registry, VOLUMESNAPSHOTS);
    this.contents = this.track(new Informer(this.registry, VOLUMESNAPSHOTCONTENTS));
    this.classes = this.track(new Informer(this.registry, VOLUMESNAPSHOTCLASSES));
    this.claims = this.track(new Informer(this.registry, PERSISTENTVOLUMECLAIMS));
    this.volumes = this.track(new Informer(this.registry, PERSISTENTVOLUMES));
    this.deployments = this.track(new Informer(this.registry, DEPLOYMENTS));
    this.watch(this.snapshots);
    for (const informer of [this.claims, this.volumes, this.deployments]) {
      informer.onChange(() => {
        for (const snapshot of this.snapshots.list()) this.enqueue(objectKey(snapshot));
      });
    }
  }

  private installed(): boolean {
    return this.deployments.list().some((deployment) => {
      if (deployment.metadata.labels?.[SNAPSHOT_CONTROLLER_LABEL.key] !== SNAPSHOT_CONTROLLER_LABEL.value) {
        return false;
      }
      return (((deployment.status ?? {}) as { availableReplicas?: number }).availableReplicas ?? 0) > 0;
    });
  }

  protected async reconcile(key: string): Promise<void> {
    if (!this.installed()) return;
    const { namespace, name } = splitKey(key);
    let snapshot: KubeObject;
    try {
      snapshot = this.registry.get(VOLUMESNAPSHOTS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return this.releaseFor(namespace, name);
      throw error;
    }
    if (snapshot.metadata.deletionTimestamp) return;

    const status = (snapshot.status ?? {}) as any;
    if (status.readyToUse) return;

    const spec = (snapshot.spec ?? {}) as any;

    /**
     * 预置快照（pre-provisioned）。
     *
     * 另一条路：content 已经在存储上了，VolumeSnapshot 只是把它认领回来。
     * 恢复走的就是这条 —— 备份留下的那张 content 还在，但它的主人
     * （原来那个命名空间里的 VolumeSnapshot）早就跟着命名空间一起没了。
     */
    const preprovisioned = spec.source?.volumeSnapshotContentName;
    if (preprovisioned) return this.adopt(snapshot, preprovisioned);

    const claimName = spec.source?.persistentVolumeClaimName;
    if (!claimName) {
      return this.fail(snapshot, 'Snapshot source must be a PersistentVolumeClaim');
    }

    let claim: KubeObject;
    try {
      claim = this.registry.get(PERSISTENTVOLUMECLAIMS, namespace, claimName);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return this.fail(snapshot, `Failed to get PVC ${namespace}/${claimName}: not found`);
    }

    /**
     * 源盘没绑上就拍不了。
     *
     * 这条看着显然，但它解释了一个真实的坑：备份脚本先建 PVC 再立刻拍快照，
     * 供给还没完成，快照直接失败 —— 而失败信息在 VolumeSnapshot 的
     * status.error 里，不在事件里，`kubectl get` 也看不见。
     */
    const volumeName = ((claim.spec ?? {}) as any).volumeName;
    if (((claim.status ?? {}) as any).phase !== 'Bound' || !volumeName) {
      return this.fail(snapshot, `PVC ${namespace}/${claimName} is not bound`);
    }

    const className = spec.volumeSnapshotClassName;
    const snapshotClass = className
      ? this.classes.list().find((item) => item.metadata.name === className)
      : this.classes.list().find(
        (item) => item.metadata.annotations?.['snapshot.storage.kubernetes.io/is-default-class'] === 'true'
      );
    if (!snapshotClass) {
      return this.fail(snapshot, className
        ? `Failed to get snapshot class with error volumesnapshotclass.snapshot.storage.k8s.io "${className}" not found`
        : 'Failed to get default snapshot class with error cannot find default snapshot class');
    }

    const contentName = `snapcontent-${snapshot.metadata.uid}`;
    const volume = this.volumes.list().find((item) => item.metadata.name === volumeName);
    const now = new Date(this.context.now()).toISOString();

    // 拍下来的是**这一刻**的字节。之后往盘里写什么都跟它无关了。
    this.options.volumes.copy(volumeName, contentName);

    try {
      this.registry.get(VOLUMESNAPSHOTCONTENTS, undefined, contentName);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.registry.create(VOLUMESNAPSHOTCONTENTS, undefined, {
        apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshotContent',
        metadata: { name: contentName },
        spec: {
          deletionPolicy: (snapshotClass as any).deletionPolicy ?? 'Delete',
          driver: (snapshotClass as any).driver ?? 'csi',
          source: { volumeHandle: volumeName },
          volumeSnapshotClassName: snapshotClass.metadata.name,
          volumeSnapshotRef: {
            apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshot',
            name, namespace, uid: snapshot.metadata.uid,
          },
        },
      } as KubeObject);
    }

    const restoreSize = ((volume?.spec ?? {}) as any)?.capacity?.storage
      ?? ((claim.status ?? {}) as any)?.capacity?.storage;

    await ignoreConflict(() => {
      updateStatusIfChanged(this.registry, VOLUMESNAPSHOTCONTENTS, undefined, contentName, {
        readyToUse: true, creationTime: now, restoreSize, snapshotHandle: contentName,
      });
      updateStatusIfChanged(this.registry, VOLUMESNAPSHOTS, namespace, name, {
        readyToUse: true,
        boundVolumeSnapshotContentName: contentName,
        creationTime: now,
        restoreSize,
      });
    });
  }

  /** 认领一张已经在存储上的 content */
  private async adopt(snapshot: KubeObject, contentName: string): Promise<void> {
    const namespace = snapshot.metadata.namespace;
    const name = snapshot.metadata.name!;
    let content: KubeObject;
    try {
      content = this.registry.get(VOLUMESNAPSHOTCONTENTS, undefined, contentName);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return this.fail(snapshot, `VolumeSnapshotContent "${contentName}" not found`);
    }

    await ignoreConflict(() => {
      const latest = this.registry.get(VOLUMESNAPSHOTCONTENTS, undefined, contentName);
      const spec = (latest.spec ?? {}) as any;
      // content 上的 ref 指回新的这张快照，否则两边对不上，谁也不认谁
      this.registry.update(VOLUMESNAPSHOTCONTENTS, undefined, contentName, {
        ...latest,
        spec: {
          ...spec,
          volumeSnapshotRef: {
            apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshot',
            name, namespace, uid: snapshot.metadata.uid,
          },
        },
      });
      updateStatusIfChanged(this.registry, VOLUMESNAPSHOTS, namespace, name, {
        readyToUse: true,
        boundVolumeSnapshotContentName: contentName,
        creationTime: ((content.status ?? {}) as any).creationTime
          ?? new Date(this.context.now()).toISOString(),
        restoreSize: ((content.status ?? {}) as any).restoreSize,
      });
    });
  }

  private async fail(snapshot: KubeObject, message: string): Promise<void> {
    await ignoreConflict(() => {
      updateStatusIfChanged(
        this.registry, VOLUMESNAPSHOTS, snapshot.metadata.namespace, snapshot.metadata.name!,
        {
          readyToUse: false,
          error: { message, time: new Date(this.context.now()).toISOString() },
        }
      );
    });
  }

  /**
   * VolumeSnapshot 没了，那张快照怎么办。
   *
   * `Delete` 连字节一起删，`Retain` 把 content 留下 —— 留下之后它是一张
   * **没有主人**的快照，`kubectl get volumesnapshot` 里再也看不到它，
   * 只有 `volumesnapshotcontent` 里还在。存储账单上也还在。
   */
  private releaseFor(namespace: string | undefined, name: string): void {
    for (const content of this.contents.list()) {
      const spec = (content.spec ?? {}) as any;
      const ref = spec.volumeSnapshotRef;
      if (!ref || ref.namespace !== namespace || ref.name !== name) continue;
      if ((spec.deletionPolicy ?? 'Delete') !== 'Delete') continue;
      this.options.volumes.drop(content.metadata.name!);
      try {
        this.registry.delete(VOLUMESNAPSHOTCONTENTS, undefined, content.metadata.name!);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  }
}
