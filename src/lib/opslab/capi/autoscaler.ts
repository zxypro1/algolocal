/**
 * cluster-autoscaler
 *
 * 它只做两件事，但两件都常被误解：
 *
 *   扩容：看到**调度不上**的 Pod，问一句「加一台这种机器，它能落上去吗」。
 *         能，就加；不能，就什么都不做 —— 加了也白加。所以一个请求 32 核的
 *         Pod 在最大 8 核的池子里会永远 Pending，而伸缩器一台机器都不会加。
 *         这不是坏了，这是它算出来「加了也没用」。
 *
 *   缩容：看到**利用率低**的节点，问一句「上面的 Pod 挪得走吗」。
 *         挪得走才缩。PDB、没有属主的 Pod、打了 safe-to-evict: "false" 的 Pod，
 *         任何一个都能把一台机器永远钉在那儿。「为什么半夜三点还有十台空机器」
 *         的答案通常就在这几条里。
 *
 * 还有一件事必须强调：**它管的是机器，不是副本**。它不会因为 CPU 高就给你
 * 加 Pod（那是 HPA），也不认识「负载」这个概念 —— 它只认调度器的结论。
 *
 * 哪些机器归它管，靠 MachineDeployment 上的两个注解。没打注解的机器组
 * 它**看都不看** —— 这是最常见的「伸缩器装了但不工作」。
 */
import type { KubeObject } from '../apiserver';
import {
  Controller, ControllerContext, Informer, isNotFound,
} from '../controllers/framework';
import { DEPLOYMENTS, NODES, PODS } from '../controllers/resources';
import { ignoreConflict, parseCpu } from '../controllers/workloads';
import { PODDISRUPTIONBUDGETS, evictionVerdict } from '../disruption';
import { MACHINEDEPLOYMENTS, MACHINES, MACHINE_DEPLOYMENT_LABEL } from './resources';

export const MIN_SIZE_ANNOTATION = 'cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size';
export const MAX_SIZE_ANNOTATION = 'cluster.x-k8s.io/cluster-api-autoscaler-node-group-max-size';
/** 打在 Machine 上：下一次缩容删这台 */
export const DELETE_MACHINE_ANNOTATION = 'cluster.x-k8s.io/delete-machine';
/** 打在 Pod 上：这台机器不许因为缩容被回收 */
export const SAFE_TO_EVICT_ANNOTATION = 'cluster-autoscaler.kubernetes.io/safe-to-evict';

export const AUTOSCALER_LABEL = { key: 'app.kubernetes.io/name', value: 'cluster-autoscaler' };

/** 伸缩器多久看一眼。真 CA 默认 10 秒。 */
export const SCAN_INTERVAL_MS = 10_000;
/** 一台机器闲多久才回收。真 CA 默认 10 分钟。 */
export const UNNEEDED_MS = 10 * 60_000;
/** 利用率低于这个就算闲着 */
export const UTILIZATION_THRESHOLD = 0.5;

interface NodeGroup {
  deployment: KubeObject;
  min: number;
  max: number;
  cpu: number;
  nodes: KubeObject[];
}

export class AutoscalerController extends Controller {
  private machineDeployments: Informer;
  private machines: Informer;
  private nodes: Informer;
  private pods: Informer;
  private budgets: Informer;
  private workloads: Informer;
  private timer: number;
  private stopped = false;
  /** 节点第一次被判定为「闲着」的时刻 */
  private unneededSince = new Map<string, number>();

  constructor(context: ControllerContext) {
    super(context, 'cluster-autoscaler');
    this.machineDeployments = this.track(new Informer(this.registry, MACHINEDEPLOYMENTS));
    this.machines = this.track(new Informer(this.registry, MACHINES));
    this.nodes = this.track(new Informer(this.registry, NODES));
    this.pods = this.track(new Informer(this.registry, PODS));
    this.budgets = this.track(new Informer(this.registry, PODDISRUPTIONBUDGETS));
    this.workloads = this.track(new Informer(this.registry, DEPLOYMENTS));

    /**
     * 伸缩器是**轮询**的，不是事件驱动的。
     *
     * 这一点有实际后果：从「Pod 变成 Pending」到「机器开始造」之间，
     * 最坏要等一整个扫描周期。加上装机时间，学员看到的那段空白是真的。
     */
    this.timer = this.kernel.setInterval(() => { void this.scan(); }, SCAN_INTERVAL_MS, {
      background: true,
      label: 'cluster-autoscaler:scan',
    });

    /**
     * 除了定时扫，Pod 一旦被判定为调度不上也立刻看一眼。
     *
     * 真 CA 只有定时那一路，两者的差别只是延迟。这里加这一路是因为
     * 这个世界的时间是被命令推着走的：不加的话，学员敲完 annotate 之后
     * 什么都不会发生，得再敲十条无关命令把时钟推过去 —— 那不是在教弹性，
     * 是在教怎么等。缩容仍然只走定时那一路，因为它本来就该等够时间。
     */
    this.pods.onChange((_key, pod) => {
      if (!pod) return;
      const status = (pod.status ?? {}) as any;
      if (status.phase !== 'Pending') return;
      const unschedulable = (status.conditions ?? []).some(
        (condition: any) => condition.type === 'PodScheduled' && condition.reason === 'Unschedulable'
      );
      if (unschedulable) this.enqueue('scale-up');
    });
  }

  stop(): void {
    this.stopped = true;
    this.kernel.clearTimer(this.timer);
    super.stop();
  }

  /** 定时那一路在 scan 里；这一路只管「有 Pod 调度不上」这一件事 */
  protected async reconcile(key: string): Promise<void> {
    if (key !== 'scale-up' || this.stopped || !this.installed()) return;
    const groups = this.groups();
    if (groups.length > 0) await this.scaleUp(groups);
  }

  private installed(): boolean {
    return this.workloads.list().some((deployment) => {
      if (deployment.metadata.labels?.[AUTOSCALER_LABEL.key] !== AUTOSCALER_LABEL.value) return false;
      return (((deployment.status ?? {}) as { availableReplicas?: number }).availableReplicas ?? 0) > 0;
    });
  }

  async scan(): Promise<void> {
    if (this.stopped || !this.installed()) return;
    const groups = this.groups();
    if (groups.length === 0) return;
    // 先扩后缩：一次扫描里两件事都做的话，刚加的机器不该马上被判定为闲着
    if (await this.scaleUp(groups)) return;
    await this.scaleDown(groups);
  }

  /**
   * 哪些机器组归它管。
   *
   * 没打 min/max 注解的 MachineDeployment 不在名单里 —— 伸缩器**看都不看**。
   * 「装了但不工作」十次有九次是这个。
   */
  private groups(): NodeGroup[] {
    const out: NodeGroup[] = [];
    for (const deployment of this.machineDeployments.list()) {
      const annotations = deployment.metadata.annotations ?? {};
      const min = Number(annotations[MIN_SIZE_ANNOTATION]);
      const max = Number(annotations[MAX_SIZE_ANNOTATION]);
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;

      const machines = this.machines.list().filter(
        (machine) => machine.metadata.namespace === deployment.metadata.namespace
          && machine.metadata.labels?.[MACHINE_DEPLOYMENT_LABEL] === deployment.metadata.name
      );
      const nodeNames = new Set(machines
        .map((machine) => ((machine.status ?? {}) as any)?.nodeRef?.name)
        .filter(Boolean) as string[]);
      const nodes = this.nodes.list().filter((node) => nodeNames.has(node.metadata.name!));
      out.push({ deployment, min, max, cpu: this.groupCpu(nodes), nodes });
    }
    return out;
  }

  /**
   * 这个组的机器有多大。
   *
   * 现有机器上量出来的。一台都没有时（组缩到 0）伸缩器就不知道该组机器
   * 多大了 —— 真 CA 也一样，从零扩容要另外在注解里声明容量。
   */
  private groupCpu(nodes: KubeObject[]): number {
    const values = nodes.map((node) => parseCpu(((node.status ?? {}) as any)?.allocatable?.cpu));
    return values.length > 0 ? Math.max(...values) : 0;
  }

  private unschedulable(): KubeObject[] {
    return this.pods.list().filter((pod) => {
      if ((pod.spec as any)?.nodeName) return false;
      if (pod.metadata.deletionTimestamp) return false;
      const status = (pod.status ?? {}) as any;
      if (status.phase !== 'Pending') return false;
      return (status.conditions ?? []).some(
        (condition: any) => condition.type === 'PodScheduled' && condition.reason === 'Unschedulable'
      );
    });
  }

  private requestedCpu(pod: KubeObject): number {
    const containers: any[] = (pod.spec as any)?.containers ?? [];
    return containers.reduce((sum, c) => sum + parseCpu(c.resources?.requests?.cpu ?? '0'), 0);
  }

  /**
   * 扩容。
   *
   * 先把装不下的 Pod 按「一台新机器能装多少」摞一摞，算出还差几台。
   * 装不进任何一台新机器的 Pod 直接被排除在外，并且记一条事件 ——
   * 这是伸缩器唯一会说话的时候，而绝大多数人从来没去看过这条事件。
   */
  private async scaleUp(groups: NodeGroup[]): Promise<boolean> {
    const pending = this.unschedulable();
    if (pending.length === 0) return false;
    let scaled = false;

    for (const group of groups) {
      if (group.cpu <= 0) continue;
      const current = (group.deployment.spec as any)?.replicas ?? 0;
      if (current >= group.max) {
        for (const pod of pending) {
          this.context.recordEvent({
            object: pod, type: 'Normal', reason: 'NotTriggerScaleUp',
            message: `pod didn't trigger scale-up: 1 max node group size reached`,
          });
        }
        continue;
      }

      // 摞箱子：每台新机器能装多少个装得下的 Pod
      const fits = pending.filter((pod) => this.requestedCpu(pod) <= group.cpu);
      for (const pod of pending) {
        if (fits.includes(pod)) continue;
        this.context.recordEvent({
          object: pod, type: 'Normal', reason: 'NotTriggerScaleUp',
          message: `pod didn't trigger scale-up: 1 Insufficient cpu`,
        });
      }
      if (fits.length === 0) continue;

      let needed = 0;
      let room = 0;
      for (const pod of [...fits].sort((a, b) => this.requestedCpu(b) - this.requestedCpu(a))) {
        const cost = this.requestedCpu(pod);
        if (cost > room) { needed += 1; room = group.cpu; }
        room -= cost;
      }

      /**
       * 已经在路上的机器要算数。
       *
       * 装机要好几分钟，这期间 Pod 一直是 Pending。不把在造的那些算进来的话，
       * 每一轮扫描都会再加一批 —— 等机器全起来，多出来一堆空机器，
       * 然后又被缩容一台台还回去。真 CA 把这些叫 upcoming nodes。
       */
      const ready = group.nodes.filter((node) => (((node.status ?? {}) as any).conditions ?? [])
        .some((condition: any) => condition.type === 'Ready' && condition.status === 'True')).length;
      const upcoming = Math.max(0, current - ready);
      const next = Math.min(group.max, current + Math.max(0, needed - upcoming));
      if (next === current) continue;

      await this.setReplicas(group.deployment, next);
      for (const pod of fits) {
        this.context.recordEvent({
          object: pod, type: 'Normal', reason: 'TriggeredScaleUp',
          message: `pod triggered scale-up: [{${group.deployment.metadata.name} ${current}->${next}}]`,
        });
      }
      scaled = true;
      // 刚加的机器还没起来，别让它马上被判定为闲着
      this.unneededSince.clear();
    }
    return scaled;
  }

  /**
   * 缩容。
   *
   * 三道门：利用率够低、闲得够久、上面的 Pod 挪得走。
   * 第三道最容易卡住 —— 而卡住的时候伸缩器是**沉默**的，
   * 只有它自己的日志里有一行。所以这里把原因记成事件，让它说得出话。
   */
  private async scaleDown(groups: NodeGroup[]): Promise<void> {
    const now = this.context.now();
    for (const group of groups) {
      const current = (group.deployment.spec as any)?.replicas ?? 0;
      if (current <= group.min) continue;

      /**
       * 先看最闲的那台。
       *
       * 一样闲的时候挑**后加的**：老机器上跑的东西更可能是已经稳定的，
       * 而且刚扩出来的那批本来就是为这一阵活加的。
       */
      const candidates = [...group.nodes].sort((a, b) => {
        const diff = this.utilization(a) - this.utilization(b);
        if (diff !== 0) return diff;
        return a.metadata.creationTimestamp! < b.metadata.creationTimestamp! ? 1 : -1;
      });

      for (const node of candidates) {
        const name = node.metadata.name!;
        const pods = this.podsOn(name);
        const utilization = this.utilization(node);
        if (utilization >= UTILIZATION_THRESHOLD) {
          this.unneededSince.delete(name);
          continue;
        }

        const blocker = this.blocker(pods);
        if (blocker) {
          this.unneededSince.delete(name);
          this.context.recordEvent({
            object: node, type: 'Normal', reason: 'ScaleDownBlocked', message: blocker,
          });
          continue;
        }

        const since = this.unneededSince.get(name) ?? now;
        this.unneededSince.set(name, since);
        if (now - since < UNNEEDED_MS) continue;

        await this.remove(group, name);
        this.unneededSince.delete(name);
        return;
      }
    }
  }

  /** 这台机器上的请求量占了多少 */
  private utilization(node: KubeObject): number {
    const allocatable = parseCpu(((node.status ?? {}) as any)?.allocatable?.cpu);
    if (allocatable <= 0) return 1;
    const used = this.podsOn(node.metadata.name!)
      .reduce((sum, pod) => sum + this.requestedCpu(pod), 0);
    return used / allocatable;
  }

  private podsOn(nodeName: string): KubeObject[] {
    return this.pods.list().filter(
      (pod) => (pod.spec as any)?.nodeName === nodeName && !pod.metadata.deletionTimestamp
    );
  }

  /** 有没有东西钉住这台机器。返回一句人话，没有就是 undefined。 */
  private blocker(pods: KubeObject[]): string | undefined {
    const budgets = this.budgets.list();
    for (const pod of pods) {
      if (pod.metadata.annotations?.[SAFE_TO_EVICT_ANNOTATION] === 'false') {
        return `cannot scale down: pod ${pod.metadata.namespace}/${pod.metadata.name} `
          + 'has cluster-autoscaler.kubernetes.io/safe-to-evict: "false"';
      }
      // DaemonSet 的 Pod 不算 —— 它本来就跟着机器走
      const owners = pod.metadata.ownerReferences ?? [];
      if (owners.some((ref) => ref.kind === 'DaemonSet')) continue;
      if (owners.length === 0) {
        return `cannot scale down: pod ${pod.metadata.namespace}/${pod.metadata.name} `
          + 'is not backed by a controller and would not be recreated';
      }
      const inNamespace = this.pods.list().filter(
        (other) => other.metadata.namespace === pod.metadata.namespace
      );
      const verdict = evictionVerdict(pod, budgets, inNamespace);
      if (!verdict.allowed) {
        return `cannot scale down: ${verdict.message}`;
      }
    }
    return undefined;
  }

  /**
   * 指定删哪一台。
   *
   * 真 CA 的做法是在 Machine 上打一个 `delete-machine` 注解，再把副本数减一 ——
   * 不然减副本数只是「少一台」，具体少哪一台由 MachineSet 决定，
   * 很可能不是它算好的那台。
   */
  private async remove(group: NodeGroup, nodeName: string): Promise<void> {
    const machine = this.machines.list().find(
      (item) => ((item.status ?? {}) as any)?.nodeRef?.name === nodeName
    );
    if (machine) {
      await ignoreConflict(() => {
        const latest = this.registry.get(MACHINES, machine.metadata.namespace, machine.metadata.name!);
        this.registry.update(MACHINES, latest.metadata.namespace, latest.metadata.name!, {
          ...latest,
          metadata: {
            ...latest.metadata,
            annotations: { ...(latest.metadata.annotations ?? {}), [DELETE_MACHINE_ANNOTATION]: '' },
          },
        });
      });
    }
    const current = (group.deployment.spec as any)?.replicas ?? 0;
    await this.setReplicas(group.deployment, Math.max(group.min, current - 1));
  }

  private async setReplicas(deployment: KubeObject, replicas: number): Promise<void> {
    await ignoreConflict(() => {
      let latest: KubeObject;
      try {
        latest = this.registry.get(MACHINEDEPLOYMENTS, deployment.metadata.namespace, deployment.metadata.name!);
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      this.registry.update(MACHINEDEPLOYMENTS, latest.metadata.namespace, latest.metadata.name!, {
        ...latest, spec: { ...((latest.spec ?? {}) as any), replicas },
      });
    });
  }
}
