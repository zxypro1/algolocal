/**
 * Velero
 *
 * 备份要备两样：**对象图**和**字节**。Velero 自己只管前者 —— 把选中的对象
 * 序列化进对象存储；后者要靠卷快照，而快照要靠 CSI。两件事之间的接缝，
 * 就是「备份显示 Completed，恢复出来是一个空盘」的所在。
 *
 * 这里刻意保留了真 Velero 最难受的那个行为：**没有可用的卷快照类时，
 * 备份照样 Completed**，只是多一条 warning。备份系统报绿，数据不在里面。
 */
import type { KubeObject, ResourceDefinition } from '../apiserver';
import {
  Controller, ControllerContext, Informer, isNotFound, objectKey, splitKey,
} from '../controllers/framework';
import { DEPLOYMENTS, EVENTS } from '../controllers/resources';
import { ignoreConflict, updateStatusIfChanged } from '../controllers/workloads';
import { PERSISTENTVOLUMECLAIMS } from '../storage';
import { parseDuration } from '../observability';
import { VOLUMESNAPSHOTCLASSES, VOLUMESNAPSHOTCONTENTS, VOLUMESNAPSHOTS } from './resources';

export const BACKUPS: ResourceDefinition = {
  group: 'velero.io', version: 'v1', resource: 'backups',
  singular: 'backup', kind: 'Backup', namespaced: true, subresources: ['status'],
};

export const RESTORES: ResourceDefinition = {
  group: 'velero.io', version: 'v1', resource: 'restores',
  singular: 'restore', kind: 'Restore', namespaced: true, subresources: ['status'],
};

export const BACKUPSTORAGELOCATIONS: ResourceDefinition = {
  group: 'velero.io', version: 'v1', resource: 'backupstoragelocations',
  singular: 'backupstoragelocation', kind: 'BackupStorageLocation', namespaced: true,
  shortNames: ['bsl'], subresources: ['status'],
};

export const VELERO_RESOURCES: ResourceDefinition[] = [BACKUPS, RESTORES, BACKUPSTORAGELOCATIONS];

/** Velero 自己。它也只是集群里的一个 Deployment。 */
export const VELERO_LABEL = { key: 'app.kubernetes.io/name', value: 'velero' };

/**
 * 让 Velero 认得的卷快照类。
 *
 * 真 Velero 靠这个标签挑快照类。少打这个标签，备份里就没有卷数据 ——
 * 而它**不报错**，只在 warnings 里加一。
 */
export const CSI_CLASS_LABEL = { key: 'velero.io/csi-volumesnapshot-class', value: 'true' };

/** 打了这个标签的对象不进备份 */
export const EXCLUDE_LABEL = 'velero.io/exclude-from-backup';

/** 默认保留期。真 Velero 也是 720h。 */
const DEFAULT_TTL = '720h';

/**
 * 备份仓库。
 *
 * 备份**不在集群里**。集群里只有一个 Backup 对象（一条记录），
 * 内容在对象存储的桶里。这个区别有实际后果：集群整个没了，备份还在；
 * 反过来，桶没了而 Backup 对象还在，`kubectl get backup` 照样显示 Completed。
 */
export interface StoredBackup {
  items: KubeObject[];
  /** `namespace/pvc` -> VolumeSnapshotContent 的名字 */
  snapshots: Record<string, string>;
  namespaces: string[];
}

export class BackupStore {
  private data = new Map<string, StoredBackup>();

  put(name: string, backup: StoredBackup): void {
    this.data.set(name, JSON.parse(JSON.stringify(backup)));
  }

  get(name: string): StoredBackup | undefined {
    const found = this.data.get(name);
    return found ? (JSON.parse(JSON.stringify(found)) as StoredBackup) : undefined;
  }

  drop(name: string): void {
    this.data.delete(name);
  }

  names(): string[] {
    return [...this.data.keys()].sort();
  }
}

export interface VeleroOptions {
  store: BackupStore;
}

export class VeleroController extends Controller {
  private backups: Informer;
  private restores: Informer;
  private locations: Informer;
  private snapshots: Informer;
  private contents: Informer;
  private snapshotClasses: Informer;
  private deployments: Informer;

  constructor(context: ControllerContext, private readonly options: VeleroOptions) {
    super(context, 'velero');
    this.backups = new Informer(this.registry, BACKUPS);
    this.restores = new Informer(this.registry, RESTORES);
    this.locations = this.track(new Informer(this.registry, BACKUPSTORAGELOCATIONS));
    this.snapshots = this.track(new Informer(this.registry, VOLUMESNAPSHOTS));
    this.contents = this.track(new Informer(this.registry, VOLUMESNAPSHOTCONTENTS));
    this.snapshotClasses = this.track(new Informer(this.registry, VOLUMESNAPSHOTCLASSES));
    this.deployments = this.track(new Informer(this.registry, DEPLOYMENTS));

    this.watch(this.backups, (_, key) => `backup/${key}`);
    this.watch(this.restores, (_, key) => `restore/${key}`);
    // 快照就绪、位置可用，都可能让一个卡住的备份继续
    for (const informer of [this.snapshots, this.deployments, this.locations]) {
      informer.onChange(() => {
        for (const backup of this.backups.list()) this.enqueue(`backup/${objectKey(backup)}`);
        for (const restore of this.restores.list()) this.enqueue(`restore/${objectKey(restore)}`);
      });
    }
  }

  private installed(): boolean {
    return this.deployments.list().some((deployment) => {
      if (deployment.metadata.labels?.[VELERO_LABEL.key] !== VELERO_LABEL.value) return false;
      return (((deployment.status ?? {}) as { availableReplicas?: number }).availableReplicas ?? 0) > 0;
    });
  }

  protected async reconcile(key: string): Promise<void> {
    if (!this.installed()) return;
    await this.validateLocations();

    const slash = key.indexOf('/');
    const kind = key.slice(0, slash);
    const { namespace, name } = splitKey(key.slice(slash + 1));
    if (kind === 'backup') return this.reconcileBackup(namespace, name);
    if (kind === 'restore') return this.reconcileRestore(namespace, name);
  }

  /**
   * 位置可用性。
   *
   * 真 Velero 每隔一分钟去桶里放一个探测文件。这里简化成「Velero 在跑
   * 而且配了桶就是可用」—— 要教的不是探测机制，是「位置不可用时备份直接失败，
   * 而失败信息在 BackupStorageLocation 上，不在 Backup 上」。
   */
  private async validateLocations(): Promise<void> {
    for (const location of this.locations.list()) {
      const bucket = ((location.spec ?? {}) as any)?.objectStorage?.bucket;
      await ignoreConflict(() => {
        updateStatusIfChanged(
          this.registry, BACKUPSTORAGELOCATIONS, location.metadata.namespace, location.metadata.name!,
          {
            phase: bucket ? 'Available' : 'Unavailable',
            lastValidationTime: new Date(this.context.now()).toISOString(),
            ...(bucket ? {} : { message: 'no bucket configured' }),
          }
        );
      });
    }
  }

  /* ---------------- 备份 ---------------- */

  private async reconcileBackup(namespace: string | undefined, name: string): Promise<void> {
    let backup: KubeObject;
    try {
      backup = this.registry.get(BACKUPS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) {
        this.options.store.drop(name);
        return;
      }
      throw error;
    }
    const status = (backup.status ?? {}) as any;
    if (status.phase && status.phase !== 'New' && status.phase !== 'InProgress') return;

    const spec = (backup.spec ?? {}) as any;
    const now = this.context.now();
    const startedAt = status.startTimestamp ?? new Date(now).toISOString();

    const locationName = spec.storageLocation ?? 'default';
    const location = this.locations.list().find(
      (item) => item.metadata.namespace === namespace && item.metadata.name === locationName
    );
    if (!location || ((location.status ?? {}) as any).phase !== 'Available') {
      return this.finishBackup(backup, {
        phase: 'Failed', startTimestamp: startedAt,
        completionTimestamp: new Date(now).toISOString(),
        failureReason: `backup storage location "${locationName}" is unavailable`,
      });
    }

    const namespaces = this.namespacesFor(spec);
    const items = this.collect(spec, namespaces);

    /**
     * 卷数据。
     *
     * `snapshotVolumes: false` 是明确说「只要对象图」。不写它就是要拍快照，
     * 但**拍不拍得成**取决于有没有一个打了 velero 标签的 VolumeSnapshotClass。
     * 没有的话这里加一条 warning 然后照样 Completed —— 真 Velero 就是这样。
     */
    const claims = items.filter((item) => item.kind === 'PersistentVolumeClaim');
    const snapshots: Record<string, string> = {};
    let warnings = 0;
    let attempted = 0;
    let pending = false;

    if (spec.snapshotVolumes !== false) {
      for (const claim of claims) {
        attempted += 1;
        const snapshotClass = this.snapshotClasses.list().find(
          (item) => item.metadata.labels?.[CSI_CLASS_LABEL.key] === CSI_CLASS_LABEL.value
        );
        if (!snapshotClass) {
          warnings += 1;
          continue;
        }
        const outcome = this.snapshotFor(backup, claim, snapshotClass);
        if (outcome === 'pending') { pending = true; continue; }
        if (outcome === 'failed') { warnings += 1; continue; }
        snapshots[`${claim.metadata.namespace}/${claim.metadata.name}`] = outcome;
      }
    }

    // 还有快照没拍完就先停在 InProgress，别急着说 Completed
    if (pending) {
      return this.finishBackup(backup, {
        phase: 'InProgress', startTimestamp: startedAt,
        progress: { totalItems: items.length, itemsBackedUp: items.length },
      });
    }

    this.options.store.put(name, { items, snapshots, namespaces });
    const ttl = spec.ttl ?? DEFAULT_TTL;
    await this.finishBackup(backup, {
      phase: 'Completed',
      startTimestamp: startedAt,
      completionTimestamp: new Date(now).toISOString(),
      expiration: new Date(now + parseDuration(String(ttl))).toISOString(),
      progress: { totalItems: items.length, itemsBackedUp: items.length },
      volumeSnapshotsAttempted: attempted,
      volumeSnapshotsCompleted: Object.keys(snapshots).length,
      warnings,
      errors: 0,
      formatVersion: '1.1.0',
    });
  }

  /**
   * 给一个 PVC 拍快照，返回 content 的名字。
   *
   * 拍完之后要把 content 的回收策略改成 `Retain` —— 否则命名空间一删，
   * VolumeSnapshot 跟着没，content 和字节也跟着没，备份就成了一张白纸。
   * 真 Velero 的 CSI 插件做的就是这一手。
   */
  private snapshotFor(
    backup: KubeObject,
    claim: KubeObject,
    snapshotClass: KubeObject
  ): string | 'pending' | 'failed' {
    const namespace = claim.metadata.namespace;
    const name = `velero-${claim.metadata.name}-${backup.metadata.name}`;
    let snapshot: KubeObject;
    try {
      snapshot = this.registry.get(VOLUMESNAPSHOTS, namespace, name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.registry.create(VOLUMESNAPSHOTS, namespace, {
        apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshot',
        metadata: {
          name, namespace,
          labels: { 'velero.io/backup-name': backup.metadata.name! },
        },
        spec: {
          volumeSnapshotClassName: snapshotClass.metadata.name,
          source: { persistentVolumeClaimName: claim.metadata.name },
        },
      } as KubeObject);
      return 'pending';
    }

    const status = (snapshot.status ?? {}) as any;
    if (status.error) return 'failed';
    if (!status.readyToUse || !status.boundVolumeSnapshotContentName) return 'pending';

    const contentName = status.boundVolumeSnapshotContentName as string;
    const content = this.registry.get(VOLUMESNAPSHOTCONTENTS, undefined, contentName);
    const contentSpec = (content.spec ?? {}) as any;
    if (contentSpec.deletionPolicy !== 'Retain') {
      this.registry.update(VOLUMESNAPSHOTCONTENTS, undefined, contentName, {
        ...content, spec: { ...contentSpec, deletionPolicy: 'Retain' },
      });
    }
    return contentName;
  }

  private async finishBackup(backup: KubeObject, status: Record<string, unknown>): Promise<void> {
    await ignoreConflict(() => {
      updateStatusIfChanged(
        this.registry, BACKUPS, backup.metadata.namespace, backup.metadata.name!, status
      );
    });
  }

  private namespacesFor(spec: any): string[] {
    const included: string[] = spec.includedNamespaces ?? ['*'];
    const excluded: string[] = spec.excludedNamespaces ?? [];
    const all = this.registry
      .list(this.namespaceDefinition()).items
      .map((item) => item.metadata.name!)
      .filter((item) => !excluded.includes(item));
    if (included.includes('*')) return all.sort();
    return all.filter((item) => included.includes(item)).sort();
  }

  private namespaceDefinition(): ResourceDefinition {
    return this.context.scheme.mustGet({ group: '', version: 'v1', resource: 'namespaces' });
  }

  /**
   * 收集要备份的对象。
   *
   * 三条过滤，和真 Velero 一致：命名空间、资源类型、标签选择器。
   * 另外两类永远不进：事件（备份出来毫无意义），
   * 以及打了 `velero.io/exclude-from-backup` 的对象。
   */
  private collect(spec: any, namespaces: string[]): KubeObject[] {
    const included: string[] | undefined = spec.includedResources;
    const excluded: string[] = spec.excludedResources ?? [];
    const selector: Record<string, string> | undefined = spec.labelSelector?.matchLabels;
    const out: KubeObject[] = [];

    for (const definition of this.context.scheme.list()) {
      if (!definition.namespaced) continue;
      if (definition.resource === EVENTS.resource) continue;
      if (excluded.includes(definition.resource)) continue;
      if (included && !included.includes(definition.resource)) continue;

      for (const namespace of namespaces) {
        for (const object of this.registry.list(definition, { namespace }).items) {
          if (object.metadata.labels?.[EXCLUDE_LABEL] === 'true') continue;
          if (selector && !Object.entries(selector).every(
            ([k, v]) => object.metadata.labels?.[k] === v
          )) continue;
          out.push(JSON.parse(JSON.stringify(object)) as KubeObject);
        }
      }
    }
    return out;
  }

  /* ---------------- 恢复 ---------------- */

  private async reconcileRestore(namespace: string | undefined, name: string): Promise<void> {
    let restore: KubeObject;
    try {
      restore = this.registry.get(RESTORES, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    const status = (restore.status ?? {}) as any;
    if (status.phase && status.phase !== 'New') return;

    const spec = (restore.spec ?? {}) as any;
    const now = new Date(this.context.now()).toISOString();
    const stored = spec.backupName ? this.options.store.get(spec.backupName) : undefined;
    if (!stored) {
      return this.finishRestore(restore, {
        phase: 'Failed', startTimestamp: now, completionTimestamp: now,
        failureReason: `backup ${spec.backupName} not found`,
      });
    }

    const mapping: Record<string, string> = spec.namespaceMapping ?? {};
    const included: string[] | undefined = spec.includedNamespaces;
    let restored = 0;
    let warnings = 0;

    // 命名空间本身要先在
    for (const source of stored.namespaces) {
      if (included && !included.includes(source)) continue;
      const target = mapping[source] ?? source;
      this.ensureNamespace(target);
    }

    for (const item of stored.items) {
      const source = item.metadata.namespace!;
      if (included && !included.includes(source)) continue;
      const target = mapping[source] ?? source;
      const definition = this.context.scheme.list().find(
        (entry) => entry.kind === item.kind
          && entry.version === item.apiVersion.split('/').pop()
      );
      if (!definition) { warnings += 1; continue; }

      /**
       * Pod 不恢复。
       *
       * 真 Velero 会恢复 Pod，但由 Deployment 管的 Pod 恢复出来是多余的 ——
       * 控制器自己会造。这里索性不恢复，免得教出「恢复完有一堆孤儿 Pod」
       * 这种错觉。ReplicaSet 同理。
       */
      if (item.kind === 'Pod' || item.kind === 'ReplicaSet' || item.kind === 'Endpoints') continue;

      const body = this.sanitize(item, target, stored);
      try {
        this.registry.get(definition, target, item.metadata.name!);
        // 已经在了就跳过。这是 Velero 的默认策略，也是「恢复了但什么都没变」的原因。
        warnings += 1;
        continue;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      try {
        this.registry.create(definition, target, body);
        restored += 1;
      } catch {
        warnings += 1;
      }
    }

    await this.finishRestore(restore, {
      phase: warnings > 0 ? 'PartiallyFailed' : 'Completed',
      startTimestamp: now,
      completionTimestamp: now,
      progress: { totalItems: stored.items.length, itemsRestored: restored },
      warnings,
      errors: 0,
    });
  }

  private ensureNamespace(name: string): void {
    const definition = this.namespaceDefinition();
    try {
      this.registry.get(definition, undefined, name);
    } catch {
      this.registry.create(definition, undefined, {
        apiVersion: 'v1', kind: 'Namespace', metadata: { name },
        status: { phase: 'Active' },
      } as KubeObject);
    }
  }

  /**
   * 把对象洗干净再放回去。
   *
   * 备份下来的是**运行时**的样子：uid、resourceVersion、status，还有
   * PVC 上已经绑定的 volumeName 和 PV 上的 claimRef。原样放回去的话
   * 不是被 apiserver 拒绝，就是绑到一块根本不存在的盘上。
   *
   * PVC 还要多做一件事：把 dataSource 指到那张快照上，否则恢复出来是空盘。
   */
  private sanitize(item: KubeObject, targetNamespace: string, stored: StoredBackup): KubeObject {
    const body = JSON.parse(JSON.stringify(item)) as KubeObject;
    body.metadata = {
      name: body.metadata.name,
      namespace: targetNamespace,
      labels: body.metadata.labels,
      annotations: body.metadata.annotations,
    } as any;
    delete (body as any).status;

    if (body.kind === 'PersistentVolumeClaim') {
      const spec = (body.spec ?? {}) as any;
      delete spec.volumeName;
      const contentName = stored.snapshots[`${item.metadata.namespace}/${item.metadata.name}`];
      if (contentName) {
        const snapshotName = `${item.metadata.name}-restore`;
        this.adoptContent(contentName, targetNamespace, snapshotName);
        spec.dataSource = {
          apiGroup: 'snapshot.storage.k8s.io', kind: 'VolumeSnapshot', name: snapshotName,
        };
      }
      body.spec = spec;
    }
    return body;
  }

  /**
   * 备份留下的那张 content 还在存储上，但没有主人。
   * 建一张**预置**的 VolumeSnapshot 去认领它，PVC 才有得引用。
   */
  private adoptContent(contentName: string, namespace: string, snapshotName: string): void {
    try {
      this.registry.get(VOLUMESNAPSHOTS, namespace, snapshotName);
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    this.registry.create(VOLUMESNAPSHOTS, namespace, {
      apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshot',
      metadata: { name: snapshotName, namespace },
      spec: { source: { volumeSnapshotContentName: contentName } },
    } as KubeObject);
  }

  private async finishRestore(restore: KubeObject, status: Record<string, unknown>): Promise<void> {
    await ignoreConflict(() => {
      updateStatusIfChanged(
        this.registry, RESTORES, restore.metadata.namespace, restore.metadata.name!, status
      );
    });
  }
}
