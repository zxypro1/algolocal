/**
 * 绑定与供给
 *
 * PVC 提交上来只是一句「我要 5Gi、要能读写」。把它变成一块真盘有两条路：
 *
 *   静态：管理员先建好 PV，控制器按容量和访问模式挑一块配上去。
 *         这条路是 kube-controller-manager 做的，控制面自带。
 *   动态：StorageClass 指定一个 provisioner，由**外部 CSI 驱动**现造一块。
 *         这条路是集群里的一个工作负载做的。驱动不在，PVC 就一直 Pending。
 *
 * 回收策略决定「PVC 没了之后那块盘怎么办」：`Delete` 连盘带数据一起删，
 * `Retain` 留着但转成 Released —— 而 Released 的 PV **不会**被下一个 PVC
 * 自动接手，得有人先把 claimRef 清掉。这是「我明明设了 Retain，
 * 为什么新的 PVC 还是 Pending」的答案。
 */
import type { Defaulter, KubeObject, Registry, Scheme } from '../apiserver';
import {
  Controller, ControllerContext, Informer, isNotFound, objectKey, splitKey,
} from '../controllers/framework';
import { DEPLOYMENTS, PODS } from '../controllers/resources';
import { ignoreConflict, updateStatusIfChanged } from '../controllers/workloads';
// 容量和 CPU/内存用的是同一套单位写法，解析也用同一份，免得两处对不上
import { parseQuantity } from '../controllers/runtime';
import {
  CSI_DRIVER_LABEL, DEFAULT_CLASS_ANNOTATION,
  PERSISTENTVOLUMECLAIMS, PERSISTENTVOLUMES, STORAGECLASSES,
} from './resources';
import type { VolumeStore } from './volumes';

export interface StorageOptions {
  volumes: VolumeStore;
}

/**
 * 默认 StorageClass 的准入。
 *
 * 真 apiserver 有一个内置插件叫 DefaultStorageClass：PVC 没写
 * `storageClassName` 时，它在**写进去之前**把默认类的名字补上。
 * 所以 `kubectl get pvc` 里那一列一开始就有值，不是控制器事后补的。
 * 注意它只在字段**缺失**时动手，写成空串是明确要求静态绑定，不补。
 */
export function createDefaultStorageClassDefaulter(options: {
  registry: Registry;
  scheme: Scheme;
}): Defaulter {
  return {
    matches: (definition) => definition.resource === 'persistentvolumeclaims',
    apply: (object) => {
      const spec = (object.spec ?? {}) as any;
      if (spec.storageClassName !== undefined) return;
      const definition = options.scheme.get({
        group: 'storage.k8s.io', version: 'v1', resource: 'storageclasses',
      });
      if (!definition) return;
      const fallback = options.registry.list(definition).items.find(
        (item) => item.metadata.annotations?.[DEFAULT_CLASS_ANNOTATION] === 'true'
      );
      if (!fallback) return;
      object.spec = { ...spec, storageClassName: fallback.metadata.name };
    },
  };
}

export class StorageController extends Controller {
  private claims: Informer;
  private volumes: Informer;
  private classes: Informer;
  private pods: Informer;
  private deployments: Informer;

  constructor(context: ControllerContext, private readonly options: StorageOptions) {
    super(context, 'persistentvolume');
    this.claims = new Informer(this.registry, PERSISTENTVOLUMECLAIMS);
    this.volumes = this.track(new Informer(this.registry, PERSISTENTVOLUMES));
    this.classes = this.track(new Informer(this.registry, STORAGECLASSES));
    this.pods = this.track(new Informer(this.registry, PODS));
    this.deployments = this.track(new Informer(this.registry, DEPLOYMENTS));
    this.watch(this.claims);
    // PV、StorageClass、Pod 任何一样变了，等着的 PVC 都值得再看一眼
    for (const informer of [this.volumes, this.classes, this.pods, this.deployments]) {
      informer.onChange(() => {
        for (const claim of this.claims.list()) this.enqueue(objectKey(claim));
      });
    }
  }

  /** 动态供给要有人干活。静态绑定不需要 —— 那是控制面自带的。 */
  private provisionerReady(): boolean {
    return this.deployments.list().some((deployment) => {
      if (deployment.metadata.labels?.[CSI_DRIVER_LABEL.key] !== CSI_DRIVER_LABEL.value) return false;
      return (((deployment.status ?? {}) as { availableReplicas?: number }).availableReplicas ?? 0) > 0;
    });
  }

  protected async reconcile(key: string): Promise<void> {
    const { namespace, name } = splitKey(key);
    let claim: KubeObject;
    try {
      claim = this.registry.get(PERSISTENTVOLUMECLAIMS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return this.reclaimFor(namespace, name);
      throw error;
    }
    if (claim.metadata.deletionTimestamp) return;

    const spec = (claim.spec ?? {}) as any;
    const status = (claim.status ?? {}) as any;
    if (status.phase === 'Bound' && spec.volumeName) return;

    const bound = spec.volumeName
      ? this.volumes.list().find((pv) => pv.metadata.name === spec.volumeName)
      : this.findMatch(claim);

    if (bound) return this.bind(claim, bound);

    const className = this.classNameOf(claim);
    const storageClass = className
      ? this.classes.list().find((item) => item.metadata.name === className)
      : undefined;

    /**
     * `storageClassName: ""` 是**明确要求静态绑定**，不是「用默认的」。
     * 这两者写法只差一对引号，行为完全相反。
     */
    if (spec.storageClassName === '') return this.pending(claim, 'no PersistentVolume matches this claim');
    if (!storageClass) {
      return this.pending(claim, className
        ? `storageclass.storage.k8s.io "${className}" not found`
        : 'no default StorageClass and no matching PersistentVolume');
    }

    /**
     * WaitForFirstConsumer：没有 Pod 用它就先不造。
     *
     * 云上的默认 StorageClass 基本都是这个模式 —— 盘要造在 Pod 落的那个
     * 可用区里，所以得先知道 Pod 去哪儿。「PVC 一直 Pending，但什么都没配错」
     * 十有八九就是它。
     */
    const mode = (storageClass.spec as any)?.volumeBindingMode
      ?? (storageClass as any).volumeBindingMode
      ?? 'Immediate';
    if (mode === 'WaitForFirstConsumer' && !this.claimed(claim)) {
      return this.pending(claim, 'waiting for first consumer to be created before binding');
    }

    if (!this.provisionerReady()) {
      const provisioner = (storageClass as any).provisioner ?? 'unknown';
      return this.pending(
        claim,
        `waiting for a volume to be created, either by external provisioner "${provisioner}"`
          + ' or manually by system administrator'
      );
    }

    await this.provision(claim, storageClass);
  }

  /** 有没有 Pod 引用了这个 PVC */
  private claimed(claim: KubeObject): boolean {
    return this.pods.list().some((pod) => {
      if (pod.metadata.namespace !== claim.metadata.namespace) return false;
      return ((pod.spec as any)?.volumes ?? []).some(
        (volume: any) => volume.persistentVolumeClaim?.claimName === claim.metadata.name
      );
    });
  }

  private classNameOf(claim: KubeObject): string | undefined {
    const requested = (claim.spec as any)?.storageClassName;
    if (typeof requested === 'string') return requested || undefined;
    const fallback = this.classes.list().find(
      (item) => item.metadata.annotations?.[DEFAULT_CLASS_ANNOTATION] === 'true'
    );
    return fallback?.metadata.name;
  }

  /**
   * 静态匹配。
   *
   * 真调度里还看节点亲和，这里只看三样：类、容量、访问模式。
   * 注意**已经 Released 的 PV 不参与匹配** —— 上一个 PVC 的 claimRef 还在
   * 上面，谁也接不走。
   */
  private findMatch(claim: KubeObject): KubeObject | undefined {
    const spec = (claim.spec ?? {}) as any;
    const wanted = parseQuantity(spec.resources?.requests?.storage);
    const modes: string[] = spec.accessModes ?? [];
    const className = this.classNameOf(claim);
    return this.volumes.list().find((pv) => {
      const pvSpec = (pv.spec ?? {}) as any;
      const phase = ((pv.status ?? {}) as any).phase;
      if (phase && phase !== 'Available') return false;
      if (pvSpec.claimRef) return false;
      if ((pvSpec.storageClassName || undefined) !== className) return false;
      if (parseQuantity(pvSpec.capacity?.storage) < wanted) return false;
      return modes.every((mode) => (pvSpec.accessModes ?? []).includes(mode));
    });
  }

  private async provision(claim: KubeObject, storageClass: KubeObject): Promise<void> {
    const spec = (claim.spec ?? {}) as any;
    const name = `pvc-${claim.metadata.uid}`;
    const body: KubeObject = {
      apiVersion: 'v1', kind: 'PersistentVolume',
      metadata: {
        name,
        annotations: { 'pv.kubernetes.io/provisioned-by': (storageClass as any).provisioner ?? 'csi' },
      },
      spec: {
        capacity: { storage: spec.resources?.requests?.storage ?? '1Gi' },
        accessModes: spec.accessModes ?? ['ReadWriteOnce'],
        persistentVolumeReclaimPolicy: (storageClass as any).reclaimPolicy ?? 'Delete',
        storageClassName: storageClass.metadata.name,
        csi: { driver: (storageClass as any).provisioner ?? 'csi', volumeHandle: name },
      },
      status: { phase: 'Available' },
    } as KubeObject;

    let created: KubeObject;
    try {
      created = this.registry.create(PERSISTENTVOLUMES, undefined, body);
    } catch {
      created = this.registry.get(PERSISTENTVOLUMES, undefined, name);
    }
    // 新盘是空的。这一句在这里，是为了让「盘存在」和「盘上有数据」分成两件事。
    if (!this.options.volumes.has(name)) this.options.volumes.write(name, {});
    this.context.recordEvent({
      object: claim, type: 'Normal', reason: 'ProvisioningSucceeded',
      message: `Successfully provisioned volume ${name}`,
    });
    await this.bind(claim, created);
  }

  private async bind(claim: KubeObject, volume: KubeObject): Promise<void> {
    const namespace = claim.metadata.namespace;
    const name = claim.metadata.name!;
    await ignoreConflict(() => {
      const latest = this.registry.get(PERSISTENTVOLUMES, undefined, volume.metadata.name!);
      const spec = (latest.spec ?? {}) as any;
      if (!spec.claimRef) {
        this.registry.update(PERSISTENTVOLUMES, undefined, latest.metadata.name!, {
          ...latest,
          spec: {
            ...spec,
            claimRef: {
              apiVersion: 'v1', kind: 'PersistentVolumeClaim',
              name, namespace, uid: claim.metadata.uid,
            },
          },
        });
      }
      updateStatusIfChanged(this.registry, PERSISTENTVOLUMES, undefined, latest.metadata.name!, {
        phase: 'Bound',
      });
    });

    await ignoreConflict(() => {
      const latest = this.registry.get(PERSISTENTVOLUMECLAIMS, namespace, name);
      const spec = (latest.spec ?? {}) as any;
      if (spec.volumeName !== volume.metadata.name) {
        this.registry.update(PERSISTENTVOLUMECLAIMS, namespace, name, {
          ...latest, spec: { ...spec, volumeName: volume.metadata.name },
        });
      }
      const pvSpec = (this.registry.get(PERSISTENTVOLUMES, undefined, volume.metadata.name!).spec ?? {}) as any;
      updateStatusIfChanged(this.registry, PERSISTENTVOLUMECLAIMS, namespace, name, {
        phase: 'Bound',
        accessModes: pvSpec.accessModes ?? spec.accessModes,
        capacity: pvSpec.capacity,
      });
    });
  }

  private async pending(claim: KubeObject, message: string): Promise<void> {
    const namespace = claim.metadata.namespace;
    const name = claim.metadata.name!;
    let changed = false;
    await ignoreConflict(() => {
      const before = JSON.stringify(this.registry.get(PERSISTENTVOLUMECLAIMS, namespace, name).status ?? null);
      updateStatusIfChanged(this.registry, PERSISTENTVOLUMECLAIMS, namespace, name, { phase: 'Pending' });
      changed = before !== JSON.stringify(
        this.registry.get(PERSISTENTVOLUMECLAIMS, namespace, name).status ?? null
      );
    });
    if (!changed) return;
    this.context.recordEvent({
      object: claim, type: 'Normal', reason: 'WaitForFirstConsumer', message,
    });
  }

  /**
   * PVC 没了：按回收策略处置那块盘。
   *
   * `Delete` 是**连数据一起**删。生产上这条最疼 —— 删一个 Helm release
   * 顺手带走 PVC，盘就跟着没了，而 apiserver 里再也查不到它存在过。
   */
  private reclaimFor(namespace: string | undefined, name: string): void {
    for (const volume of this.volumes.list()) {
      const spec = (volume.spec ?? {}) as any;
      const ref = spec.claimRef;
      if (!ref || ref.namespace !== namespace || ref.name !== name) continue;
      const policy = spec.persistentVolumeReclaimPolicy ?? 'Retain';
      if (policy === 'Delete') {
        this.options.volumes.drop(volume.metadata.name!);
        try {
          this.registry.delete(PERSISTENTVOLUMES, undefined, volume.metadata.name!);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        continue;
      }
      // Retain：盘和数据都留着，但 claimRef 还挂着，下一个 PVC 接不走
      updateStatusIfChanged(this.registry, PERSISTENTVOLUMES, undefined, volume.metadata.name!, {
        phase: 'Released',
      });
    }
  }
}
