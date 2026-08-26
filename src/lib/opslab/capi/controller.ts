/**
 * Cluster API 的两个控制器
 *
 * MachineDeployment -> MachineSet -> Machine，形状照抄 Deployment 那一套；
 * 再由 Machine 变出 Node。后半段是这一层真正的内容：**机器不是立刻就有的**。
 *
 * 一台机器从「声明出来」到「能接 Pod」要过三关：
 *
 *   Provisioning  provider 在造（克隆模板、开机）
 *   Provisioned   机器起来了，kubelet 还没报到 —— Node 对象已经存在，但 NotReady
 *   Running       kubelet 报到，Node Ready，调度器才看得见它
 *
 * 弹性伸缩里所有的等待都来自这两段。学员会看到 Pod 先 Pending，
 * 然后有台 NotReady 的机器出现，再过一会儿 Pod 才落上去。
 */
import type { KubeObject } from '../apiserver';
import {
  Controller, ControllerContext, Informer, isNotFound, objectKey, splitKey,
} from '../controllers/framework';
import { DEPLOYMENTS, NODES, PODS, templateHash } from '../controllers/resources';
import { ignoreConflict, updateStatusIfChanged } from '../controllers/workloads';
import {
  CAPI_LABEL, MACHINEDEPLOYMENTS, MACHINES, MACHINESETS,
  MACHINE_DEPLOYMENT_LABEL, MACHINE_SET_LABEL, VSPHEREMACHINETEMPLATES,
} from './resources';

/** 造机器要多久：克隆模板、开机 */
export const PROVISION_MS = 90_000;
/** 开机之后 kubelet 报到要多久 */
export const BOOTSTRAP_MS = 60_000;

export interface CapiOptions {
  /** 新机器的 IP 从这个网段里分 */
  subnet?: string;
}

/** 规格从 infra 模板上读，不在 MachineDeployment 上 */
function shapeOf(template: KubeObject | undefined): { cpu: string; memory: string } {
  const spec = ((template?.spec ?? {}) as any)?.template?.spec ?? {};
  const cpu = String(spec.numCPUs ?? 4);
  const memoryMiB = Number(spec.memoryMiB ?? 8192);
  return { cpu, memory: `${Math.round(memoryMiB / 1024)}Gi` };
}

export class MachineDeploymentController extends Controller {
  private deployments: Informer;
  private sets: Informer;
  private machines: Informer;
  private workloads: Informer;

  constructor(context: ControllerContext) {
    super(context, 'cluster-api');
    this.deployments = new Informer(this.registry, MACHINEDEPLOYMENTS);
    this.sets = this.track(new Informer(this.registry, MACHINESETS));
    this.machines = this.track(new Informer(this.registry, MACHINES));
    this.workloads = this.track(new Informer(this.registry, DEPLOYMENTS));
    this.watch(this.deployments);
    for (const informer of [this.sets, this.machines, this.workloads]) {
      informer.onChange(() => {
        for (const item of this.deployments.list()) this.enqueue(objectKey(item));
      });
    }
  }

  private installed(): boolean {
    return this.workloads.list().some((deployment) => {
      if (deployment.metadata.labels?.[CAPI_LABEL.key] !== CAPI_LABEL.value) return false;
      return (((deployment.status ?? {}) as { availableReplicas?: number }).availableReplicas ?? 0) > 0;
    });
  }

  protected async reconcile(key: string): Promise<void> {
    if (!this.installed()) return;
    const { namespace, name } = splitKey(key);
    let deployment: KubeObject;
    try {
      deployment = this.registry.get(MACHINEDEPLOYMENTS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (deployment.metadata.deletionTimestamp) return;

    const spec = (deployment.spec ?? {}) as any;
    const desired = spec.replicas ?? 1;
    const hash = templateHash(spec.template);
    const setName = `${name}-${hash}`;

    let set: KubeObject;
    try {
      set = this.registry.get(MACHINESETS, namespace, setName);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      set = this.registry.create(MACHINESETS, namespace, {
        apiVersion: 'cluster.x-k8s.io/v1beta1', kind: 'MachineSet',
        metadata: {
          name: setName, namespace,
          labels: { ...(deployment.metadata.labels ?? {}), [MACHINE_DEPLOYMENT_LABEL]: name },
          ownerReferences: [{
            apiVersion: 'cluster.x-k8s.io/v1beta1', kind: 'MachineDeployment',
            name, uid: deployment.metadata.uid!, controller: true, blockOwnerDeletion: true,
          }],
        },
        spec: {
          replicas: desired,
          clusterName: spec.clusterName,
          selector: { matchLabels: { [MACHINE_SET_LABEL]: setName } },
          template: spec.template,
        },
      } as KubeObject);
    }

    // 模板变了：新的拉起来，旧的缩到 0。真 CAPI 会按 maxSurge/maxUnavailable
    // 一台一台换，这里简化 —— 换机器的**节奏**不是这一关要教的东西。
    for (const other of this.ownedSets(deployment)) {
      if (other.metadata.name === setName) continue;
      await this.scaleSet(other, 0);
    }
    await this.scaleSet(set, desired);

    const machines = this.machinesOf(name, namespace);
    const ready = machines.filter((machine) => ((machine.status ?? {}) as any).phase === 'Running');
    await ignoreConflict(() => {
      updateStatusIfChanged(this.registry, MACHINEDEPLOYMENTS, namespace, name, {
        replicas: machines.length,
        readyReplicas: ready.length,
        availableReplicas: ready.length,
        updatedReplicas: machines.filter(
          (machine) => machine.metadata.labels?.[MACHINE_SET_LABEL] === setName
        ).length,
        phase: ready.length >= desired ? 'Running' : 'ScalingUp',
        selector: `${MACHINE_DEPLOYMENT_LABEL}=${name}`,
      });
    });
  }

  private ownedSets(deployment: KubeObject): KubeObject[] {
    return this.sets.list().filter((set) => (set.metadata.ownerReferences ?? [])
      .some((ref) => ref.uid === deployment.metadata.uid));
  }

  private machinesOf(deploymentName: string, namespace: string | undefined): KubeObject[] {
    return this.machines.list().filter(
      (machine) => machine.metadata.namespace === namespace
        && machine.metadata.labels?.[MACHINE_DEPLOYMENT_LABEL] === deploymentName
    );
  }

  private async scaleSet(set: KubeObject, replicas: number): Promise<void> {
    const namespace = set.metadata.namespace;
    const name = set.metadata.name!;
    const spec = (set.spec ?? {}) as any;
    if (spec.replicas !== replicas) {
      await ignoreConflict(() => {
        const latest = this.registry.get(MACHINESETS, namespace, name);
        this.registry.update(MACHINESETS, namespace, name, {
          ...latest, spec: { ...((latest.spec ?? {}) as any), replicas },
        });
      });
    }
  }
}

/**
 * MachineSet：把副本数变成一台台 Machine。
 *
 * 缩容时删哪一台是有讲究的：真 CAPI 默认删最新的那台（Newest），
 * 因为老机器上跑的东西更可能是「已经稳定的」。这里照做。
 */
export class MachineSetController extends Controller {
  private sets: Informer;
  private machines: Informer;
  private workloads: Informer;

  constructor(context: ControllerContext) {
    super(context, 'machineset');
    this.sets = new Informer(this.registry, MACHINESETS);
    this.machines = this.track(new Informer(this.registry, MACHINES));
    this.workloads = this.track(new Informer(this.registry, DEPLOYMENTS));
    this.watch(this.sets);
    this.machines.onChange(() => {
      for (const set of this.sets.list()) this.enqueue(objectKey(set));
    });
    this.workloads.onChange(() => {
      for (const set of this.sets.list()) this.enqueue(objectKey(set));
    });
  }

  private installed(): boolean {
    return this.workloads.list().some((deployment) => {
      if (deployment.metadata.labels?.[CAPI_LABEL.key] !== CAPI_LABEL.value) return false;
      return (((deployment.status ?? {}) as { availableReplicas?: number }).availableReplicas ?? 0) > 0;
    });
  }

  protected async reconcile(key: string): Promise<void> {
    if (!this.installed()) return;
    const { namespace, name } = splitKey(key);
    let set: KubeObject;
    try {
      set = this.registry.get(MACHINESETS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (set.metadata.deletionTimestamp) return;

    const spec = (set.spec ?? {}) as any;
    const desired = spec.replicas ?? 0;
    const owned = this.machines.list().filter(
      (machine) => machine.metadata.namespace === namespace
        && machine.metadata.labels?.[MACHINE_SET_LABEL] === name
        && !machine.metadata.deletionTimestamp
    );

    for (let index = owned.length; index < desired; index += 1) {
      this.createMachine(set, index);
    }
    /**
     * 缩容删哪一台。
     *
     * 先删打了 `delete-machine` 注解的 —— 伸缩器算好了要回收哪一台，
     * 光减副本数的话具体少哪台由这里说了算，很可能不是它挑的那台。
     * 剩下的按「最新的先删」：老机器上跑的东西更可能是已经稳定的。
     */
    const extra = owned
      .slice()
      .sort((a, b) => {
        const marked = (item: KubeObject) => (
          item.metadata.annotations?.['cluster.x-k8s.io/delete-machine'] !== undefined ? 0 : 1
        );
        const byMark = marked(a) - marked(b);
        if (byMark !== 0) return byMark;
        return a.metadata.creationTimestamp! < b.metadata.creationTimestamp! ? 1 : -1;
      })
      .slice(0, Math.max(0, owned.length - desired));
    for (const machine of extra) {
      try {
        this.registry.delete(MACHINES, namespace, machine.metadata.name!);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    const ready = owned.filter((machine) => ((machine.status ?? {}) as any).phase === 'Running');
    await ignoreConflict(() => {
      updateStatusIfChanged(this.registry, MACHINESETS, namespace, name, {
        replicas: owned.length,
        readyReplicas: ready.length,
        availableReplicas: ready.length,
        fullyLabeledReplicas: owned.length,
      });
    });
  }

  private createMachine(set: KubeObject, index: number): void {
    const namespace = set.metadata.namespace;
    const spec = (set.spec ?? {}) as any;
    const name = `${set.metadata.name}-${suffix(set.metadata.uid ?? '', index)}`;
    try {
      this.registry.create(MACHINES, namespace, {
        apiVersion: 'cluster.x-k8s.io/v1beta1', kind: 'Machine',
        metadata: {
          name, namespace,
          labels: {
            ...(spec.template?.metadata?.labels ?? {}),
            [MACHINE_SET_LABEL]: set.metadata.name!,
            [MACHINE_DEPLOYMENT_LABEL]: set.metadata.labels?.[MACHINE_DEPLOYMENT_LABEL] ?? '',
          },
          ownerReferences: [{
            apiVersion: 'cluster.x-k8s.io/v1beta1', kind: 'MachineSet',
            name: set.metadata.name!, uid: set.metadata.uid!,
            controller: true, blockOwnerDeletion: true,
          }],
        },
        spec: {
          clusterName: spec.clusterName,
          ...(spec.template?.spec ?? {}),
        },
      } as KubeObject);
    } catch (error) {
      // 同一刻两轮 reconcile 撞上，后一轮让给前一轮
      if (!isNotFound(error)) return;
      throw error;
    }
  }
}

/** 名字后缀：同一个 MachineSet 里稳定、可复现 */
function suffix(seed: string, index: number): string {
  const alphabet = 'bcdfghjklmnpqrstvwxz2456789';
  let hash = 2166136261;
  const text = `${seed}/${index}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  let out = '';
  let value = hash;
  for (let i = 0; i < 5; i += 1) {
    out += alphabet[value % alphabet.length];
    value = Math.floor(value / alphabet.length);
  }
  return out;
}

/**
 * Machine：一台机器的一生。
 *
 * 三段状态之外还有一件事要做对：**删机器要先把 Node 摘掉**。
 * 真 CAPI 删 Machine 时会先 cordon + drain 那个节点，再删机器。
 * 不这么做的话，Pod 会跟着机器一起消失，而不是被重新调度 ——
 * 「缩容把服务打断了」多半就是这条链子没接好。
 */
export class MachineController extends Controller {
  private machines: Informer;
  private templates: Informer;
  private workloads: Informer;
  private nodes: Informer;
  private wakeups = new Map<string, number>();
  private ips = new Map<string, string>();

  constructor(context: ControllerContext, private readonly options: CapiOptions = {}) {
    super(context, 'machine');
    this.machines = new Informer(this.registry, MACHINES);
    this.templates = this.track(new Informer(this.registry, VSPHEREMACHINETEMPLATES));
    this.workloads = this.track(new Informer(this.registry, DEPLOYMENTS));
    this.nodes = this.track(new Informer(this.registry, NODES));
    this.watch(this.machines);
    this.workloads.onChange(() => {
      for (const machine of this.machines.list()) this.enqueue(objectKey(machine));
    });
  }

  stop(): void {
    for (const id of this.wakeups.values()) this.kernel.clearTimer(id);
    this.wakeups.clear();
    super.stop();
  }

  private installed(): boolean {
    return this.workloads.list().some((deployment) => {
      if (deployment.metadata.labels?.[CAPI_LABEL.key] !== CAPI_LABEL.value) return false;
      return (((deployment.status ?? {}) as { availableReplicas?: number }).availableReplicas ?? 0) > 0;
    });
  }

  /** 同一台机器只挂一条唤醒定时器 */
  private wakeAfter(key: string, ms: number): void {
    const pending = this.wakeups.get(key);
    if (pending !== undefined) this.kernel.clearTimer(pending);
    this.wakeups.set(key, this.kernel.setTimeout(() => {
      this.wakeups.delete(key);
      this.enqueue(key);
    }, ms, { label: `machine:${key}` }));
  }

  protected async reconcile(key: string): Promise<void> {
    if (!this.installed()) return;
    const { namespace, name } = splitKey(key);
    let machine: KubeObject;
    try {
      machine = this.registry.get(MACHINES, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return this.removeNodeFor(key);
      throw error;
    }

    const status = (machine.status ?? {}) as any;
    const now = this.context.now();
    const createdAt = Date.parse(machine.metadata.creationTimestamp!);
    const age = now - createdAt;

    if (age < PROVISION_MS) {
      await this.setPhase(machine, { phase: 'Provisioning' });
      this.wakeAfter(key, PROVISION_MS - age);
      return;
    }

    const nodeName = status.nodeRef?.name ?? name;
    this.ips.set(key, this.ips.get(key) ?? this.nextIp());
    this.ensureNode(machine, nodeName, age >= PROVISION_MS + BOOTSTRAP_MS);

    if (age < PROVISION_MS + BOOTSTRAP_MS) {
      await this.setPhase(machine, {
        phase: 'Provisioned',
        nodeRef: { apiVersion: 'v1', kind: 'Node', name: nodeName },
        addresses: [{ type: 'InternalIP', address: this.ips.get(key) }],
      });
      this.wakeAfter(key, PROVISION_MS + BOOTSTRAP_MS - age);
      return;
    }

    await this.setPhase(machine, {
      phase: 'Running',
      nodeRef: { apiVersion: 'v1', kind: 'Node', name: nodeName },
      addresses: [{ type: 'InternalIP', address: this.ips.get(key) }],
      lastUpdated: new Date(now).toISOString(),
    });
  }

  private async setPhase(machine: KubeObject, status: Record<string, unknown>): Promise<void> {
    await ignoreConflict(() => {
      const latest = this.registry.get(MACHINES, machine.metadata.namespace, machine.metadata.name!);
      updateStatusIfChanged(
        this.registry, MACHINES, latest.metadata.namespace, latest.metadata.name!,
        { ...((latest.status ?? {}) as any), ...status }
      );
    });
  }

  private ensureNode(machine: KubeObject, nodeName: string, ready: boolean): void {
    const template = this.templates.list().find((item) => {
      const ref = ((machine.spec ?? {}) as any)?.infrastructureRef;
      return ref && item.metadata.name === ref.name && item.metadata.namespace === machine.metadata.namespace;
    });
    const shape = shapeOf(template);
    const conditions = [{
      type: 'Ready',
      status: ready ? 'True' : 'False',
      reason: ready ? 'KubeletReady' : 'KubeletNotReady',
      message: ready ? 'kubelet is posting ready status' : 'kubelet has not reported yet',
    }];

    try {
      const existing = this.registry.get(NODES, undefined, nodeName);
      updateStatusIfChanged(this.registry, NODES, undefined, nodeName, {
        ...((existing.status ?? {}) as any), conditions,
      });
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    this.registry.create(NODES, undefined, {
      apiVersion: 'v1', kind: 'Node',
      metadata: {
        name: nodeName,
        labels: {
          'kubernetes.io/hostname': nodeName,
          'kubernetes.io/os': 'linux',
          ...(machine.metadata.labels ?? {}),
        },
      },
      spec: { unschedulable: false, providerID: `vsphere://${nodeName}` },
      status: {
        capacity: { cpu: shape.cpu, memory: shape.memory, pods: '110' },
        allocatable: { cpu: shape.cpu, memory: shape.memory, pods: '110' },
        conditions,
        addresses: [{
          type: 'InternalIP',
          address: this.ips.get(`${machine.metadata.namespace}/${machine.metadata.name}`) ?? '10.0.1.1',
        }],
        nodeInfo: {
          kubeletVersion: 'v1.36.0',
          osImage: 'Debian GNU/Linux 12 (bookworm)',
          kernelVersion: '6.1.0-opslab',
          containerRuntimeVersion: 'containerd://2.0.0',
        },
      },
    } as KubeObject);
  }

  /**
   * 机器没了，节点也要跟着走。
   *
   * 上面的 Pod 先删掉 —— 机器都没了，Pod 不可能还在跑。删掉之后
   * 它们的属主（ReplicaSet 之类）会在别处重建，这正是缩容不该打断服务的原因。
   */
  private removeNodeFor(key: string): void {
    const { name } = splitKey(key);
    this.ips.delete(key);
    let node: KubeObject;
    try {
      node = this.registry.get(NODES, undefined, name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const pod of this.registry.list(PODS).items) {
      if ((pod.spec as any)?.nodeName !== name) continue;
      try {
        this.registry.delete(PODS, pod.metadata.namespace, pod.metadata.name!);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    this.registry.delete(NODES, undefined, node.metadata.name!);
  }

  private nextIp(): string {
    const prefix = this.options.subnet ?? '10.0.1';
    const used = new Set(this.ips.values());
    for (let host = 10; host < 250; host += 1) {
      const candidate = `${prefix}.${host}`;
      if (!used.has(candidate)) return candidate;
    }
    return `${prefix}.250`;
  }
}
