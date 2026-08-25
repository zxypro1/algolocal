/**
 * 核心控制器：调度器、ReplicaSet、Deployment、Endpoints、kubelet
 *
 * 每一个都按真 k8s 的结构写：watch → 入队 → reconcile → 写 status。
 * 于是那些微妙的中间状态（Pending 一小会儿、observedGeneration 落后一拍、
 * Endpoints 里只有 Ready 的 Pod）自然就对，不用逐个去仿。
 */
import { Priority } from '../kernel';
import { ApiError, formatTimestamp, KubeObject, Registry, ResourceDefinition } from '../apiserver';
import {
  Controller,
  ControllerContext,
  Informer,
  isConflict,
  isNotFound,
  objectKey,
  splitKey,
} from './framework';
import {
  CONFIGMAPS,
  DEPLOYMENTS,
  ENDPOINTS,
  matchesSelector,
  NODES,
  PODS,
  POD_TEMPLATE_HASH,
  REPLICASETS,
  SECRETS,
  SERVICES,
  templateHash,
} from './resources';
import {
  canPullImage,
  exceedsMemoryLimit,
  livenessFailureMs,
  probeDelayMs,
  parseQuantity,
  probeSucceeds,
  qosClassOf,
  resolveEnv,
  resolveVolumes,
  type ConfigLookup,
  type ContainerSpec,
  type ImageBehavior,
  type Probe,
  type RegistryAuth,
} from './runtime';

/** 一次 reconcile 里改 status 时，冲突就放弃这一轮 —— 下一轮会带着新版本重来 */
export async function ignoreConflict(action: () => void): Promise<void> {
  try {
    action();
  } catch (error) {
    if (!isConflict(error) && !isNotFound(error)) throw error;
  }
}

/**
 * status 没变就不要写。
 *
 * 这不是省一次写那么简单 —— 无条件写 status 会触发自己的 informer，
 * informer 把自己重新入队，reconcile 再写一次，如此往复。因为整个过程
 * 不经过定时器，虚拟时间一点不走，于是变成一个纯微任务的死循环：
 * 进程转死，连 jest 的超时都报不出来（第一版就是这样，查了很久）。
 *
 * 真 k8s 的控制器同样是「比较后再写」，原因一样。
 */
export function updateStatusIfChanged(
  registry: Registry,
  definition: ResourceDefinition,
  namespace: string | undefined,
  name: string,
  nextStatus: unknown
): void {
  const latest = registry.get(definition, namespace, name);
  if (JSON.stringify(latest.status ?? null) === JSON.stringify(nextStatus ?? null)) return;
  registry.updateStatus(definition, namespace, name, { ...latest, status: nextStatus });
}

/* ------------------------------------------------------------------ */
/* 调度器                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把没有 nodeName 的 Pod 绑到某个节点上。
 *
 * 过滤：节点 Ready、可调度、资源装得下、nodeSelector 命中。
 * 打分：least-allocated（谁空谁得），同分按名字 —— 定序必须稳定，
 * 否则同一份 manifest 两次跑出来 Pod 落在不同节点上，回放就废了。
 */
export class SchedulerController extends Controller {
  private pods: Informer;
  private nodes: Informer;

  constructor(context: ControllerContext) {
    super(context, 'scheduler');
    this.pods = new Informer(this.registry, PODS);
    this.nodes = this.track(new Informer(this.registry, NODES));
    this.watch(this.pods);
    // 节点变了，所有待调度的 Pod 都值得再看一眼
    this.nodes.onChange(() => {
      for (const pod of this.pods.list()) {
        if (!(pod.spec as any)?.nodeName) this.queue.add(objectKey(pod));
      }
    });
  }

  protected async reconcile(key: string): Promise<void> {
    const { namespace, name } = splitKey(key);
    let pod: KubeObject;
    try {
      pod = this.registry.get(PODS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    const spec = (pod.spec ?? {}) as any;
    if (spec.nodeName) return;                       // 已经调度过了
    if (pod.metadata.deletionTimestamp) return;

    const candidates = this.nodes.list().filter((node) => this.fits(node, pod));
    if (candidates.length === 0) {
      let changed = false;
      await ignoreConflict(() => {
        const before = JSON.stringify(this.registry.get(PODS, namespace, name).status ?? null);
        updateStatusIfChanged(this.registry, PODS, namespace, name, {
          ...(pod.status as any),
          phase: 'Pending',
          conditions: [{
            type: 'PodScheduled', status: 'False', reason: 'Unschedulable',
            message: '0/' + this.nodes.list().length + ' nodes are available: insufficient resources or no matching node.',
          }],
        });
        changed = before !== JSON.stringify(this.registry.get(PODS, namespace, name).status ?? null);
      });
      // 状态没变就别再刷一条一样的事件出来
      if (!changed) return;
      this.context.recordEvent({
        object: pod, type: 'Warning', reason: 'FailedScheduling',
        message: `0/${this.nodes.list().length} nodes are available.`,
      });
      return;
    }

    const chosen = this.pick(candidates);
    await ignoreConflict(() => {
      const latest = this.registry.get(PODS, namespace, name);
      this.registry.update(PODS, namespace, name, {
        ...latest,
        spec: { ...(latest.spec as any), nodeName: chosen.metadata.name },
      });
    });
    this.context.recordEvent({
      object: pod, type: 'Normal', reason: 'Scheduled',
      message: `Successfully assigned ${namespace}/${name} to ${chosen.metadata.name}`,
    });
  }

  private fits(node: KubeObject, pod: KubeObject): boolean {
    const nodeSpec = (node.spec ?? {}) as any;
    const nodeStatus = (node.status ?? {}) as any;
    if (nodeSpec.unschedulable) return false;
    const ready = (nodeStatus.conditions ?? []).find((c: any) => c.type === 'Ready');
    if (ready?.status !== 'True') return false;

    const selector = (pod.spec as any)?.nodeSelector as Record<string, string> | undefined;
    if (selector && !Object.entries(selector).every(([k, v]) => node.metadata.labels?.[k] === v)) {
      return false;
    }
    return this.freeCpu(node) >= this.requestedCpu(pod);
  }

  /** 节点上还剩多少 CPU（毫核） */
  private freeCpu(node: KubeObject): number {
    const allocatable = parseCpu((node.status as any)?.allocatable?.cpu ?? '0');
    const used = this.pods
      .list()
      .filter((pod) => (pod.spec as any)?.nodeName === node.metadata.name)
      .reduce((sum, pod) => sum + this.requestedCpu(pod), 0);
    return allocatable - used;
  }

  private requestedCpu(pod: KubeObject): number {
    const containers: any[] = (pod.spec as any)?.containers ?? [];
    return containers.reduce((sum, c) => sum + parseCpu(c.resources?.requests?.cpu ?? '0'), 0);
  }

  /** least-allocated，同分按名字 —— 稳定定序是确定性的一部分 */
  private pick(candidates: KubeObject[]): KubeObject {
    return [...candidates].sort((a, b) => {
      const diff = this.freeCpu(b) - this.freeCpu(a);
      if (diff !== 0) return diff;
      return a.metadata.name < b.metadata.name ? -1 : 1;
    })[0];
  }
}

/** kubelet 重启崩溃容器的退避：10s 起步翻倍，封顶 5 分钟，和真 kubelet 一致 */
export function backoffOf(restarts: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, restarts - 1), 300_000);
}

/** `500m` -> 500，`2` -> 2000 */
export function parseCpu(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const text = String(value);
  if (text.endsWith('m')) return Number(text.slice(0, -1)) || 0;
  return (Number(text) || 0) * 1000;
}

/* ------------------------------------------------------------------ */
/* ReplicaSet                                                          */
/* ------------------------------------------------------------------ */

/** 让实际 Pod 数向 spec.replicas 收敛，并维护 status */
export class ReplicaSetController extends Controller {
  private replicaSets: Informer;
  private pods: Informer;

  constructor(context: ControllerContext) {
    super(context, 'replicaset');
    this.replicaSets = new Informer(this.registry, REPLICASETS);
    this.pods = new Informer(this.registry, PODS);
    this.watch(this.replicaSets);
    // Pod 变了要 reconcile 它的属主，不是 Pod 自己
    this.watch(this.pods, (pod) => {
      const owner = (pod.metadata.ownerReferences ?? []).find((ref) => ref.kind === 'ReplicaSet');
      return owner ? `${pod.metadata.namespace}/${owner.name}` : null;
    });
  }

  protected async reconcile(key: string): Promise<void> {
    const { namespace, name } = splitKey(key);
    let replicaSet: KubeObject;
    try {
      replicaSet = this.registry.get(REPLICASETS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (replicaSet.metadata.deletionTimestamp) return;

    const spec = (replicaSet.spec ?? {}) as any;
    const desired = spec.replicas ?? 1;
    const owned = this.ownedPods(replicaSet);
    const alive = owned.filter((pod) => !pod.metadata.deletionTimestamp);

    if (alive.length < desired) {
      for (let i = alive.length; i < desired; i += 1) this.createPod(replicaSet);
    } else if (alive.length > desired) {
      // 多出来的先删「最不成熟」的：没 Ready 的优先，其次按名字倒序
      const victims = [...alive]
        .sort((a, b) => {
          const aReady = isPodReady(a) ? 1 : 0;
          const bReady = isPodReady(b) ? 1 : 0;
          if (aReady !== bReady) return aReady - bReady;
          return a.metadata.name < b.metadata.name ? 1 : -1;
        })
        .slice(0, alive.length - desired);
      for (const victim of victims) {
        try {
          this.registry.delete(PODS, victim.metadata.namespace, victim.metadata.name);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
    }

    const current = this.ownedPods(replicaSet).filter((pod) => !pod.metadata.deletionTimestamp);
    const ready = current.filter(isPodReady);
    await ignoreConflict(() => {
      const latest = this.registry.get(REPLICASETS, namespace, name);
      updateStatusIfChanged(this.registry, REPLICASETS, namespace, name, {
        replicas: current.length,
        readyReplicas: ready.length,
        availableReplicas: ready.length,
        fullyLabeledReplicas: current.length,
        observedGeneration: latest.metadata.generation,
      });
    });
  }

  private ownedPods(replicaSet: KubeObject): KubeObject[] {
    return this.registry
      .list(PODS, { namespace: replicaSet.metadata.namespace })
      .items.filter((pod) =>
        (pod.metadata.ownerReferences ?? []).some((ref) => ref.uid === replicaSet.metadata.uid)
      );
  }

  private createPod(replicaSet: KubeObject): void {
    const spec = (replicaSet.spec ?? {}) as any;
    const template = spec.template ?? {};
    const suffix = this.kernel.random.suffix(5);
    const pod: KubeObject = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: `${replicaSet.metadata.name}-${suffix}`,
        namespace: replicaSet.metadata.namespace,
        labels: { ...(template.metadata?.labels ?? {}) },
        ownerReferences: [{
          apiVersion: 'apps/v1', kind: 'ReplicaSet',
          name: replicaSet.metadata.name, uid: replicaSet.metadata.uid!,
          controller: true, blockOwnerDeletion: true,
        }],
      },
      spec: { ...(template.spec ?? {}) },
      status: { phase: 'Pending' },
    };
    try {
      this.registry.create(PODS, replicaSet.metadata.namespace, pod);
      this.context.recordEvent({
        object: replicaSet, type: 'Normal', reason: 'SuccessfulCreate',
        message: `Created pod: ${pod.metadata.name}`,
      });
    } catch (error) {
      if (isConflict(error)) return;
      /**
       * 被准入拦下来了（PodSecurity、Kyverno…）。
       *
       * 这不是控制器的错，重试也没用 —— 记一条事件就停手。真集群里
       * `kubectl get deploy` 会一直显示 0/N，而原因只在 ReplicaSet 的
       * 事件里，这一条不记的话现场就彻底没线索了。
       */
      if (isForbidden(error)) {
        this.context.recordEvent({
          object: replicaSet, type: 'Warning', reason: 'FailedCreate',
          message: `Error creating: ${(error as Error).message}`,
        });
        return;
      }
      throw error;
    }
  }
}

/** 403：准入拒绝。重试没有意义，得让人看见。 */
function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && (error as ApiError).code === 403;
}

export function isPodReady(pod: KubeObject): boolean {
  const conditions: any[] = (pod.status as any)?.conditions ?? [];
  return conditions.some((c) => c.type === 'Ready' && c.status === 'True');
}

/* ------------------------------------------------------------------ */
/* Deployment                                                          */
/* ------------------------------------------------------------------ */

/**
 * 维护 ReplicaSet。
 *
 * 模板变了就建一个新 RS（名字带模板哈希），按 maxSurge / maxUnavailable
 * 一点点把副本从旧 RS 挪到新 RS —— 滚动更新期间可用副本数不掉到线下，
 * 正是学员要观察的东西。
 */
export class DeploymentController extends Controller {
  private deployments: Informer;
  private replicaSets: Informer;

  constructor(context: ControllerContext) {
    super(context, 'deployment');
    this.deployments = new Informer(this.registry, DEPLOYMENTS);
    this.replicaSets = new Informer(this.registry, REPLICASETS);
    this.watch(this.deployments);
    this.watch(this.replicaSets, (rs) => {
      const owner = (rs.metadata.ownerReferences ?? []).find((ref) => ref.kind === 'Deployment');
      return owner ? `${rs.metadata.namespace}/${owner.name}` : null;
    });
  }

  protected async reconcile(key: string): Promise<void> {
    const { namespace, name } = splitKey(key);
    let deployment: KubeObject;
    try {
      deployment = this.registry.get(DEPLOYMENTS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (deployment.metadata.deletionTimestamp) return;

    const spec = (deployment.spec ?? {}) as any;
    const desired = spec.replicas ?? 1;
    const hash = templateHash(spec.template);
    const owned = this.ownedReplicaSets(deployment);
    const current = owned.find((rs) => rs.metadata.labels?.[POD_TEMPLATE_HASH] === hash)
      ?? this.createReplicaSet(deployment, hash);
    const old = owned.filter((rs) => rs.metadata.uid !== current.metadata.uid);

    const strategy = spec.strategy?.rollingUpdate ?? {};
    const maxSurge = resolveCount(strategy.maxSurge ?? '25%', desired, 1);
    const maxUnavailable = resolveCount(strategy.maxUnavailable ?? '25%', desired, 1);

    const oldReplicas = old.reduce((sum, rs) => sum + ((rs.spec as any)?.replicas ?? 0), 0);
    const currentReplicas = (current.spec as any)?.replicas ?? 0;

    /**
     * 可用副本数要**数活着的 Pod**，不能读 ReplicaSet 的 status.readyReplicas。
     *
     * RS 的 status 是异步写回的，一次 reconcile 里连着做几步决策时它是滞后的。
     * 早先按 status 算，结果同一瞬间里「以为还有 4 个 ready」，
     * 于是把旧 RS 一路缩到 0，新 Pod 却一个都还没就绪 —— 可用副本数掉到 0，
     * 正是 maxUnavailable 本该拦住的那种停机。
     */
    const availableNow = this.availablePods(deployment);

    /**
     * 已经下达但还没执行完的缩容。
     *
     * Deployment 把某个旧 RS 的 replicas 调小之后，真正去删 Pod 的是 RS 控制器，
     * 那是下一轮的事。同一瞬间里 Deployment 可能被自己的写触发反复 reconcile，
     * 每次都看到「Pod 还在、还 ready」，于是一路把旧 RS 缩到 0 —— 新 Pod
     * 一个没起来，服务就断了。把在途的缩容算进来，这一步才收得住。
     */
    const inFlightScaleDown = old.reduce((sum, rs) => {
      const intended = (rs.spec as any)?.replicas ?? 0;
      const alive = this.aliveOwnedPods(rs);
      return sum + Math.max(0, alive - intended);
    }, 0);

    /**
     * 先把旧 RS 里「本来就起不来」的那部分收掉。
     *
     * 一个旧 RS 声称要 3 个副本、实际一个 ready 的都没有（镜像拉不到、
     * 被准入拦下、探针一直不过），那 3 个名额纯粹是占着位置：缩掉它们
     * 不会让可用数下降一分。不做这一步的话，滚动更新会卡死 ——
     * 新版本要等旧版本腾位置，而旧版本永远腾不出来，因为它压根没起来。
     * 真 k8s 里这一步叫 cleanupUnhealthyReplicas。
     */
    for (const rs of old) {
      const intended = (rs.spec as any)?.replicas ?? 0;
      if (intended === 0) continue;
      const healthy = this.readyOf(rs);
      if (healthy >= intended) continue;
      this.scale(rs, healthy);
    }

    const oldReplicasNow = this.ownedReplicaSets(deployment)
      .filter((rs) => rs.metadata.uid !== current.metadata.uid)
      .reduce((sum, rs) => sum + ((rs.spec as any)?.replicas ?? 0), 0);

    // 先扩新的（不超过 desired + maxSurge）
    const surgeRoom = desired + maxSurge - (currentReplicas + oldReplicasNow);
    if (currentReplicas < desired && surgeRoom > 0) {
      this.scale(current, Math.min(desired, currentReplicas + surgeRoom));
    } else if (oldReplicasNow > 0) {
      // 再缩旧的，但一次最多缩到「可用数不低于 desired - maxUnavailable」为止
      const room = availableNow - inFlightScaleDown - (desired - maxUnavailable);
      if (room > 0) {
        const victim = old.find((rs) => ((rs.spec as any)?.replicas ?? 0) > 0);
        if (victim) {
          const replicas = (victim.spec as any)?.replicas ?? 0;
          this.scale(victim, Math.max(0, replicas - Math.min(room, replicas)));
        }
      }
    } else if (currentReplicas > desired) {
      this.scale(current, desired);
    }

    const refreshed = this.ownedReplicaSets(deployment);
    const totalReady = refreshed.reduce((sum, rs) => sum + this.readyOf(rs), 0);
    const totalReplicas = refreshed.reduce((sum, rs) => sum + ((rs.status as any)?.replicas ?? 0), 0);
    const updated = this.readyOf(refreshed.find((rs) => rs.metadata.uid === current.metadata.uid) ?? current);

    await ignoreConflict(() => {
      const latest = this.registry.get(DEPLOYMENTS, namespace, name);
      updateStatusIfChanged(this.registry, DEPLOYMENTS, namespace, name, {
        replicas: totalReplicas,
        readyReplicas: totalReady,
        availableReplicas: totalReady,
        updatedReplicas: updated,
        observedGeneration: latest.metadata.generation,
        conditions: [{
          type: 'Available',
          status: totalReady >= desired ? 'True' : 'False',
          reason: totalReady >= desired ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable',
        }],
      });
    });

    // 这里**不能**因为「还没收敛」就自己再排一次队。
    //
    // 收敛不了是常态：镜像拉不到、资源不够、探针一直不过 —— 这些恰恰是要教的场景。
    // 自我重排会让世界永远静不下来（前台定时器不断），settle() 撞预算超时。
    // 推进滚动更新的下一步本来就是事件驱动的：Pod 变 Ready → RS 的 status 变 →
    // 我们的 RS informer 收到 → 重新入队。不需要轮询。
  }

  /** 某个 ReplicaSet 名下还活着的 Pod 数 */
  private aliveOwnedPods(replicaSet: KubeObject): number {
    return this.registry
      .list(PODS, { namespace: replicaSet.metadata.namespace })
      .items.filter(
        (pod) =>
          !pod.metadata.deletionTimestamp &&
          (pod.metadata.ownerReferences ?? []).some((ref) => ref.uid === replicaSet.metadata.uid)
      ).length;
  }

  /** 这个 Deployment 名下真正就绪、且没在删除中的 Pod 数 */
  private availablePods(deployment: KubeObject): number {
    const owned = this.ownedReplicaSets(deployment);
    const uids = new Set(owned.map((rs) => rs.metadata.uid));
    return this.registry
      .list(PODS, { namespace: deployment.metadata.namespace })
      .items.filter(
        (pod) =>
          !pod.metadata.deletionTimestamp &&
          isPodReady(pod) &&
          (pod.metadata.ownerReferences ?? []).some((ref) => uids.has(ref.uid))
      ).length;
  }

  private readyOf(rs: KubeObject): number {
    return ((rs.status as any)?.readyReplicas ?? 0) as number;
  }

  private ownedReplicaSets(deployment: KubeObject): KubeObject[] {
    return this.registry
      .list(REPLICASETS, { namespace: deployment.metadata.namespace })
      .items.filter((rs) =>
        (rs.metadata.ownerReferences ?? []).some((ref) => ref.uid === deployment.metadata.uid)
      );
  }

  private createReplicaSet(deployment: KubeObject, hash: string): KubeObject {
    const spec = (deployment.spec ?? {}) as any;
    const template = spec.template ?? {};
    const replicaSet: KubeObject = {
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: {
        name: `${deployment.metadata.name}-${hash}`,
        namespace: deployment.metadata.namespace,
        labels: { ...(template.metadata?.labels ?? {}), [POD_TEMPLATE_HASH]: hash },
        ownerReferences: [{
          apiVersion: 'apps/v1', kind: 'Deployment',
          name: deployment.metadata.name, uid: deployment.metadata.uid!,
          controller: true, blockOwnerDeletion: true,
        }],
      },
      spec: {
        replicas: 0,
        selector: {
          matchLabels: { ...(spec.selector?.matchLabels ?? {}), [POD_TEMPLATE_HASH]: hash },
        },
        template: {
          ...template,
          metadata: {
            ...(template.metadata ?? {}),
            labels: { ...(template.metadata?.labels ?? {}), [POD_TEMPLATE_HASH]: hash },
          },
        },
      },
      status: {},
    };
    const created = this.registry.create(REPLICASETS, deployment.metadata.namespace, replicaSet);
    this.context.recordEvent({
      object: deployment, type: 'Normal', reason: 'ScalingReplicaSet',
      message: `Scaled up replica set ${created.metadata.name} to ${spec.replicas ?? 1}`,
    });
    return created;
  }

  private scale(replicaSet: KubeObject, replicas: number): void {
    if (((replicaSet.spec as any)?.replicas ?? 0) === replicas) return;
    ignoreConflict(() => {
      const latest = this.registry.get(REPLICASETS, replicaSet.metadata.namespace, replicaSet.metadata.name);
      this.registry.update(REPLICASETS, latest.metadata.namespace, latest.metadata.name, {
        ...latest,
        spec: { ...(latest.spec as any), replicas },
      });
    });
  }
}

/** `25%` / `1` -> 具体个数 */
export function resolveCount(value: string | number, total: number, fallback: number): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.endsWith('%')) {
    const percent = Number(value.slice(0, -1));
    if (!Number.isFinite(percent)) return fallback;
    return Math.max(1, Math.floor((total * percent) / 100));
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

/**
 * 维护 Service 的端点。
 *
 * **只收 Ready 的 Pod** —— 这条是「探针配错 → Service 没有端点 → 502」
 * 这个经典故障链的根，必须准确。
 */
export class EndpointsController extends Controller {
  private services: Informer;
  private pods: Informer;

  constructor(context: ControllerContext) {
    super(context, 'endpoints');
    this.services = new Informer(this.registry, SERVICES);
    this.pods = this.track(new Informer(this.registry, PODS));
    this.watch(this.services);
    // Pod 变了，命名空间里所有 Service 都要重算（谁选中它不好反查）
    this.pods.onChange((key) => {
      const { namespace } = splitKey(key);
      for (const service of this.services.list()) {
        if (service.metadata.namespace === namespace) this.queue.add(objectKey(service));
      }
    });
  }

  protected async reconcile(key: string): Promise<void> {
    const { namespace, name } = splitKey(key);
    let service: KubeObject;
    try {
      service = this.registry.get(SERVICES, namespace, name);
    } catch (error) {
      if (isNotFound(error)) {
        try { this.registry.delete(ENDPOINTS, namespace, name); } catch { /* 已经没了 */ }
        return;
      }
      throw error;
    }

    const selector = (service.spec as any)?.selector as Record<string, string> | undefined;
    const ready = selector
      ? this.registry
          .list(PODS, { namespace })
          .items.filter((pod) =>
            matchesSelector({ matchLabels: selector }, pod.metadata.labels) &&
            isPodReady(pod) &&
            !pod.metadata.deletionTimestamp &&
            (pod.status as any)?.podIP
          )
          .sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : 1))
      : [];

    const ports: any[] = (service.spec as any)?.ports ?? [];
    const subsets = ready.length > 0
      ? [{
          addresses: ready.map((pod) => ({
            ip: (pod.status as any).podIP,
            nodeName: (pod.spec as any)?.nodeName,
            targetRef: { kind: 'Pod', name: pod.metadata.name, namespace, uid: pod.metadata.uid },
          })),
          ports: ports.map((port) => ({
            name: port.name,
            port: port.targetPort ?? port.port,
            protocol: port.protocol ?? 'TCP',
          })),
        }]
      : [];

    const endpoints: KubeObject = {
      apiVersion: 'v1', kind: 'Endpoints',
      metadata: { name, namespace },
      subsets,
    };

    try {
      const existing = this.registry.get(ENDPOINTS, namespace, name);
      if (JSON.stringify((existing as any).subsets ?? []) === JSON.stringify(subsets)) return;
      await ignoreConflict(() => {
        this.registry.update(ENDPOINTS, namespace, name, { ...existing, subsets });
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await ignoreConflict(() => { this.registry.create(ENDPOINTS, namespace, endpoints); });
    }
  }
}

/* ------------------------------------------------------------------ */
/* kubelet                                                             */
/* ------------------------------------------------------------------ */

export interface ImageSpec extends ImageBehavior {
  /** 拉取耗时（虚拟毫秒） */
  pullMs?: number;
  /** 启动到进程就绪的耗时 */
  startupMs?: number;
  /** 没有就绪探针时，起来之后多久算 Ready */
  readyAfterMs?: number;
  /** 缺了这些环境变量就崩 */
  needsEnv?: string[];
}

export interface KubeletOptions {
  /** 镜像目录。不在目录里的镜像 = 拉不到，进 ImagePullBackOff */
  images?: Record<string, ImageSpec>;
  /** 每个仓库要不要认证。私有仓库没凭据就拉不下来。 */
  registries?: Record<string, RegistryAuth>;
  /**
   * 目录里没有时再问一次。
   *
   * 学员自己 `docker build` + `docker push` 上去的镜像不在题目写死的目录里，
   * 但它确实存在于仓库中 —— 「自己造的镜像部署不上去」会让第 3、4 关白做。
   */
  resolveImage?: (image: string) => ImageSpec | undefined;
}

/**
 * 每个节点上的 kubelet：推进落在自己身上的 Pod 的生命周期。
 *
 * 起一个容器要按顺序过四关，每一关失败的表现都不一样 —— 这四种表现分得清，
 * 才谈得上会排查：
 *
 *   1. 配置凑不齐（ConfigMap / Secret 缺了）→ `CreateContainerConfigError`
 *   2. 镜像拉不到（不存在，或私有仓库没凭据）→ `ImagePullBackOff`
 *   3. 起来就崩（缺环境变量、内存超 limit）→ `CrashLoopBackOff`
 *   4. 起来了但探针不过 → `Running` 但 `0/1`，日志里什么都看不出来
 *
 * 所有耗时都走虚拟时钟，所以「等 5 秒看它起来没」是一次快进，不是真的等。
 */
export class KubeletController extends Controller {
  private pods: Informer;
  private readonly images: Record<string, ImageSpec>;
  private readonly registries: Record<string, RegistryAuth>;
  private readonly resolveImage?: (image: string) => ImageSpec | undefined;
  /** 已经在推进中的 Pod，避免重复排定时器 */
  private advancing = new Set<string>();
  /** 每个 Pod 崩了几次，决定退避时长与 restartCount */
  private restartCount = new Map<string, number>();

  constructor(context: ControllerContext, private readonly nodeName: string, options: KubeletOptions = {}) {
    super(context, `kubelet:${nodeName}`);
    this.images = options.images ?? {};
    this.registries = options.registries ?? {};
    this.resolveImage = options.resolveImage;
    this.pods = new Informer(this.registry, PODS);
    this.watch(this.pods, (pod, key) => ((pod.spec as any)?.nodeName === nodeName ? key : null));
  }

  /** 这个镜像存不存在、它的行为是什么 */
  private imageOf(image: string | undefined): ImageSpec | undefined {
    if (image === undefined) return undefined;
    return this.images[image] ?? this.resolveImage?.(image);
  }

  /** ConfigMap / Secret 由 registry 直接读，不另开 informer —— 读的是同一份状态 */
  private get lookup(): ConfigLookup {
    return {
      configMap: (namespace, name) => this.tryGet(CONFIGMAPS, namespace, name),
      secret: (namespace, name) => this.tryGet(SECRETS, namespace, name),
    };
  }

  private tryGet(
    definition: ResourceDefinition,
    namespace: string,
    name: string
  ): KubeObject | undefined {
    try {
      return this.registry.get(definition, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  protected async reconcile(key: string): Promise<void> {
    const { namespace, name } = splitKey(key);
    let pod: KubeObject;
    try {
      pod = this.registry.get(PODS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) { this.advancing.delete(key); this.restartCount.delete(key); return; }
      throw error;
    }
    if ((pod.spec as any)?.nodeName !== this.nodeName) return;

    if (pod.metadata.deletionTimestamp) {
      this.advancing.delete(key);
      return;
    }
    const status = (pod.status ?? {}) as any;
    if (status.phase === 'Running' || status.phase === 'Failed' || status.phase === 'Succeeded') return;
    if (this.advancing.has(key)) return;
    this.advancing.add(key);

    const containers: ContainerSpec[] = (pod.spec as any)?.containers ?? [];
    const behavior = this.imageOf(containers[0]?.image) ?? {};

    // 1. 镜像在不在（题目写死的目录，或者学员自己推上去的）
    const missingImage = containers.find((c) => this.imageOf(c.image) === undefined);
    if (missingImage) {
      this.holdPending(key, pod, containers, {
        reason: 'ImagePullBackOff',
        message: `Back-off pulling image "${missingImage.image}"`,
        event: `Failed to pull image "${missingImage.image}": image not found in registry`,
      });
      return;
    }

    /**
     * 2. 私有仓库的凭据。
     *
     * 只查**要从仓库拉**的镜像。题目 `images` 目录里写着的那些，语义上是
     * 「节点上已经有了」（真集群里也常见：基础镜像预热过，或者 kubelet
     * 配了节点级凭据）。不这么分的话，每一关都得先教一遍 imagePullSecret，
     * 而那是第 4 关的事。
     */
    const denied = containers
      .filter((container) => !(container.image in this.images))
      .map((container) => canPullImage({
        image: container.image,
        namespace: namespace ?? 'default',
        imagePullSecrets: ((pod.spec as any)?.imagePullSecrets ?? []) as Array<{ name: string }>,
        registries: this.registries,
        lookup: this.lookup,
      }))
      .find((result) => !result.allowed);
    if (denied) {
      const pulled = containers.find((container) => !(container.image in this.images))!;
      this.holdPending(key, pod, containers, {
        reason: 'ImagePullBackOff',
        message: `Back-off pulling image "${pulled.image}"`,
        event: `Failed to pull image "${pulled.image}": ${denied.message}`,
      });
      return;
    }

    // 3. 配置凑不凑得齐
    const configError = this.configErrorOf(pod, containers, namespace ?? 'default');
    if (configError) {
      this.holdPending(key, pod, containers, {
        reason: 'CreateContainerConfigError',
        message: configError,
        event: `Error: ${configError}`,
      });
      return;
    }

    const pullMs = behavior.pullMs ?? 200;
    const startupMs = behavior.startupMs ?? 300;

    this.kernel.setTimeout(() => {
      ignoreConflict(() => {
        const latest = this.registry.get(PODS, namespace, name);
        if (latest.metadata.deletionTimestamp) return;
        updateStatusIfChanged(this.registry, PODS, namespace, name, {
          ...(latest.status as any),
          phase: 'Pending',
          qosClass: qosClassOf(containers),
          containerStatuses: containers.map((c) => ({
            name: c.name, ready: false, restartCount: this.restartCount.get(key) ?? 0,
            state: { waiting: { reason: 'ContainerCreating' } },
          })),
        });
      });
    }, pullMs, { priority: Priority.NODE, label: `${this.name}:creating:${key}` });

    // 4. 起来就崩：缺环境变量，或者声明的内存超过 limit
    const env: any[] = containers[0]?.env ?? [];
    const provided = new Set(env.map((e) => e.name));
    const missingEnv = (behavior.needsEnv ?? []).filter((needed) => !provided.has(needed));
    const oomContainer = containers.find((container) => exceedsMemoryLimit(container, behavior));

    if (missingEnv.length > 0 || oomContainer) {
      this.crashLoop(key, pod, containers, namespace ?? 'default', name, pullMs + startupMs, oomContainer
        ? {
          reason: 'OOMKilled', exitCode: 137,
          event: `Container ${oomContainer.name} exceeded its memory limit ` +
            `(${oomContainer.resources?.limits?.memory}) and was killed`,
        }
        : { reason: 'Error', exitCode: 1 });
      return;
    }

    // 5. Running
    this.kernel.setTimeout(() => {
      ignoreConflict(() => {
        const latest = this.registry.get(PODS, namespace, name);
        if (latest.metadata.deletionTimestamp) return;
        updateStatusIfChanged(this.registry, PODS, namespace, name, {
          ...(latest.status as any),
          phase: 'Running',
          qosClass: qosClassOf(containers),
          podIP: this.assignPodIp(latest),
          startTime: formatTimestamp(this.context.now()),
          containerStatuses: containers.map((c) => ({
            name: c.name, ready: false, restartCount: this.restartCount.get(key) ?? 0,
            state: { running: { startedAt: formatTimestamp(this.context.now()) } },
          })),
          conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
        });
      });
    }, pullMs + startupMs, { priority: Priority.NODE, label: `${this.name}:running:${key}` });

    // 6. 探针
    this.scheduleProbes(key, pod, containers, behavior, namespace ?? 'default', name, pullMs + startupMs);
  }

  /** 配置凑不齐时那条报错，文本抄真 kubelet */
  private configErrorOf(
    pod: KubeObject,
    containers: ContainerSpec[],
    namespace: string
  ): string | undefined {
    for (const container of containers) {
      const resolved = resolveEnv(container, namespace, this.lookup);
      if (resolved.error) return resolved.error;
    }
    return resolveVolumes(pod, namespace, this.lookup).error;
  }

  /**
   * 卡在 Pending 的那几种：拉不到镜像、配置凑不齐。
   *
   * 真 kubelet 会一直退避重试（ConfigMap 可能过一会儿就建出来了），
   * 所以重试定时器标成 background —— 静止判定不看它，但快进时间时照常重试。
   */
  private holdPending(
    key: string,
    pod: KubeObject,
    containers: ContainerSpec[],
    failure: { reason: string; message: string; event: string }
  ): void {
    const namespace = pod.metadata.namespace;
    const name = pod.metadata.name;
    const attempts = (this.restartCount.get(`${key}:pending`) ?? 0) + 1;
    this.restartCount.set(`${key}:pending`, attempts);

    ignoreConflict(() => {
      const latest = this.registry.get(PODS, namespace, name);
      updateStatusIfChanged(this.registry, PODS, namespace, name, {
        ...(latest.status as any),
        phase: 'Pending',
        qosClass: qosClassOf(containers),
        containerStatuses: containers.map((c) => ({
          name: c.name, ready: false, restartCount: 0,
          state: { waiting: { reason: failure.reason, message: failure.message } },
        })),
        conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
      });
    });

    if (attempts === 1) {
      this.context.recordEvent({
        object: pod, type: 'Warning',
        reason: failure.reason === 'CreateContainerConfigError' ? 'Failed' : 'Failed',
        message: failure.event,
      });
    }

    this.kernel.setTimeout(
      () => { this.advancing.delete(key); this.queue.add(key); },
      backoffOf(attempts),
      { priority: Priority.NODE, background: true, label: `${this.name}:retry:${key}` }
    );
  }

  /** 起来就崩：写 CrashLoopBackOff，排一个后台的重启定时器 */
  private crashLoop(
    key: string,
    pod: KubeObject,
    containers: ContainerSpec[],
    namespace: string,
    name: string,
    afterMs: number,
    failure: { reason: string; exitCode: number; event?: string }
  ): void {
    const restarts = (this.restartCount.get(key) ?? 0) + 1;
    this.restartCount.set(key, restarts);

    this.kernel.setTimeout(() => {
      ignoreConflict(() => {
        const latest = this.registry.get(PODS, namespace, name);
        if (latest.metadata.deletionTimestamp) return;
        updateStatusIfChanged(this.registry, PODS, namespace, name, {
          ...(latest.status as any),
          phase: 'Pending',
          qosClass: qosClassOf(containers),
          containerStatuses: containers.map((c) => ({
            name: c.name, ready: false, restartCount: restarts,
            state: {
              waiting: {
                reason: 'CrashLoopBackOff',
                message: `back-off ${backoffOf(restarts) / 1000}s restarting failed ` +
                  `container=${c.name} pod=${name}_${namespace}`,
              },
            },
            lastState: { terminated: { exitCode: failure.exitCode, reason: failure.reason } },
          })),
          conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
        });
      });
      if (restarts === 1) {
        this.context.recordEvent({
          object: pod, type: 'Warning', reason: 'BackOff',
          message: failure.event
            ?? `Back-off restarting failed container ${containers[0]?.name} in pod ${name}_${namespace}`,
        });
      }
      // 注意这里**不**清 advancing —— 清了的话，status 变化会经 informer
      // 立刻把这个 Pod 重新入队，前台链路马上又跑一遍，世界永远静不下来。
      // 只有下面那个后台退避定时器才有资格把它放出来。
      this.kernel.setTimeout(
        () => { this.advancing.delete(key); this.queue.add(key); },
        backoffOf(restarts),
        { priority: Priority.NODE, background: true, label: `${this.name}:restart:${key}` }
      );
    }, afterMs, { priority: Priority.NODE, label: `${this.name}:crash:${key}` });
  }

  /**
   * 探针。
   *
   * 就绪探针过不了，Pod 会一直是 `Running` 但 `0/1` —— 端口写错、路径写错
   * 都长这样，而应用日志里什么都看不出来。存活探针连续失败则重启容器。
   */
  private scheduleProbes(
    key: string,
    pod: KubeObject,
    containers: ContainerSpec[],
    behavior: ImageBehavior,
    namespace: string,
    name: string,
    runningAtMs: number
  ): void {
    const readiness = containers[0]?.readinessProbe;
    const liveness = containers[0]?.livenessProbe;
    const spec = this.imageOf(containers[0]?.image) ?? {};

    const readyOk = probeSucceeds(readiness, behavior);
    const liveOk = probeSucceeds(liveness, behavior);
    const readyAfter = readiness
      ? runningAtMs + probeDelayMs(readiness)
      : runningAtMs + (spec.readyAfterMs ?? 200);

    if (readyOk) {
      this.kernel.setTimeout(() => {
        ignoreConflict(() => {
          const latest = this.registry.get(PODS, namespace, name);
          if (latest.metadata.deletionTimestamp) return;
          const current = (latest.status ?? {}) as any;
          if (current.phase !== 'Running') return;
          updateStatusIfChanged(this.registry, PODS, namespace, name, {
            ...current,
            containerStatuses: (current.containerStatuses ?? []).map((c: any) => ({ ...c, ready: true })),
            conditions: [
              { type: 'Initialized', status: 'True' },
              { type: 'Ready', status: 'True' },
              { type: 'ContainersReady', status: 'True' },
              { type: 'PodScheduled', status: 'True' },
            ],
          });
        });
        if (!liveness || liveOk) this.advancing.delete(key);
      }, readyAfter, { priority: Priority.NODE, label: `${this.name}:ready:${key}` });
    } else {
      // 探针不过：留在 Running 但不 Ready，并把原因写成 Event
      this.kernel.setTimeout(() => {
        this.context.recordEvent({
          object: pod, type: 'Warning', reason: 'Unhealthy',
          message: `Readiness probe failed: ${describeProbe(readiness)}`,
        });
        this.advancing.delete(key);
      }, readyAfter, { priority: Priority.NODE, label: `${this.name}:unhealthy:${key}` });
    }

    if (liveness && !liveOk) {
      const restarts = (this.restartCount.get(key) ?? 0) + 1;
      this.restartCount.set(key, restarts);
      this.kernel.setTimeout(() => {
        this.context.recordEvent({
          object: pod, type: 'Warning', reason: 'Unhealthy',
          message: `Liveness probe failed: ${describeProbe(liveness)}`,
        });
        ignoreConflict(() => {
          const latest = this.registry.get(PODS, namespace, name);
          if (latest.metadata.deletionTimestamp) return;
          const current = (latest.status ?? {}) as any;
          updateStatusIfChanged(this.registry, PODS, namespace, name, {
            ...current,
            containerStatuses: (current.containerStatuses ?? []).map((c: any) => ({
              ...c, ready: false, restartCount: restarts,
              lastState: { terminated: { exitCode: 137, reason: 'Error' } },
            })),
            conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }],
          });
        });
        this.kernel.setTimeout(
          () => { this.advancing.delete(key); },
          1_000,
          { priority: Priority.NODE, background: true, label: `${this.name}:liveness:${key}` }
        );
      }, runningAtMs + livenessFailureMs(liveness), {
        priority: Priority.NODE, label: `${this.name}:livenessfail:${key}`,
      });
    }
  }

  /**
   * 给 Pod 分一个 IP。
   *
   * 用 uid 派生而不是递增计数器 —— 计数器会让「同一个世界重放两次」
   * 因为创建顺序的细微差别而分到不同 IP。
   */
  private assignPodIp(pod: KubeObject): string {
    const uid = pod.metadata.uid ?? pod.metadata.name;
    let hash = 2166136261;
    for (let i = 0; i < uid.length; i += 1) {
      hash ^= uid.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `10.42.${(hash >>> 8) % 256}.${(hash % 254) + 1}`;
  }
}

/* ------------------------------------------------------------------ */
/* 节点压力与驱逐                                                       */
/* ------------------------------------------------------------------ */

/**
 * 节点内存不够时把 Pod 赶走。
 *
 * 驱逐顺序按 QoS：BestEffort 先走，然后是用超了 requests 的 Burstable，
 * Guaranteed 最后。这不是我们编的策略，是 kubelet 的实际行为 ——
 * 第 7 关要学员亲眼看到「不写 requests 的那个先死」。
 *
 * 被驱逐的 Pod 变成 `Failed` 且 `reason: Evicted`，不会原地重启；
 * 上层的 ReplicaSet 会在别的节点上补一个，这也是真集群的样子。
 */
export class NodePressureController extends Controller {
  private pods: Informer;
  private nodes: Informer;

  constructor(
    private readonly nodeName: string,
    context: ControllerContext,
    private readonly images: Record<string, ImageSpec>
  ) {
    super(context, `eviction:${nodeName}`);
    this.pods = new Informer(this.registry, PODS);
    this.nodes = this.track(new Informer(this.registry, NODES));
    this.watch(this.pods, (pod, key) => ((pod.spec as any)?.nodeName === nodeName ? key : null));
  }

  protected async reconcile(): Promise<void> {
    const node = this.nodes.list().find((item) => item.metadata.name === this.nodeName);
    if (!node) return;
    const allocatable = parseQuantity((node.status as any)?.allocatable?.memory);
    if (!allocatable) return;

    const running = this.pods
      .list()
      .filter((pod) => (pod.spec as any)?.nodeName === this.nodeName)
      .filter((pod) => (pod.status as any)?.phase === 'Running')
      .filter((pod) => !pod.metadata.deletionTimestamp);

    let used = running.reduce((sum, pod) => sum + this.memoryOf(pod), 0);
    if (used <= allocatable) return;

    // 先走 BestEffort，再走超了 requests 的 Burstable，Guaranteed 最后
    const order: Record<string, number> = { BestEffort: 0, Burstable: 1, Guaranteed: 2 };
    const victims = [...running].sort((a, b) => {
      const byQos = order[qosOf(a)] - order[qosOf(b)];
      if (byQos !== 0) return byQos;
      // 同一档里超得越多越先走；再平手就按名字，保证可复现
      const overA = this.memoryOf(a) - requestedMemory(a);
      const overB = this.memoryOf(b) - requestedMemory(b);
      if (overA !== overB) return overB - overA;
      return a.metadata.name < b.metadata.name ? -1 : 1;
    });

    for (const pod of victims) {
      if (used <= allocatable) break;
      used -= this.memoryOf(pod);
      this.evict(pod, allocatable);
    }
  }

  private memoryOf(pod: KubeObject): number {
    const containers: ContainerSpec[] = (pod.spec as any)?.containers ?? [];
    return containers.reduce((sum, container) => {
      const declared = this.images[container.image]?.memoryUsage;
      // 镜像没声明用量就按它自己要的算
      return sum + (declared
        ? parseQuantity(declared)
        : parseQuantity(container.resources?.requests?.memory));
    }, 0);
  }

  private evict(pod: KubeObject, allocatable: number): void {
    const namespace = pod.metadata.namespace ?? 'default';
    ignoreConflict(() => {
      const latest = this.registry.get(PODS, namespace, pod.metadata.name);
      if ((latest.status as any)?.phase !== 'Running') return;
      updateStatusIfChanged(this.registry, PODS, namespace, pod.metadata.name, {
        ...(latest.status as any),
        phase: 'Failed',
        reason: 'Evicted',
        message:
          `The node was low on resource: memory. Threshold quantity: ${formatMi(allocatable)}, ` +
          `available: 0Mi. Container ${(pod.spec as any)?.containers?.[0]?.name} was using ` +
          `${formatMi(this.memoryOf(pod))}, request is ${formatMi(requestedMemory(pod))}.`,
        containerStatuses: ((latest.status as any)?.containerStatuses ?? []).map((c: any) => ({
          ...c, ready: false, state: { terminated: { exitCode: 137, reason: 'Evicted' } },
        })),
        conditions: [{ type: 'Ready', status: 'False', reason: 'PodFailed' }],
      });
    });
    this.context.recordEvent({
      object: pod, type: 'Warning', reason: 'Evicted',
      message: `The node was low on resource: memory. Container ${(pod.spec as any)?.containers?.[0]?.name} was using more than its request.`,
    });
  }
}

function qosOf(pod: KubeObject): string {
  return (pod.status as any)?.qosClass
    ?? qosClassOf(((pod.spec as any)?.containers ?? []) as ContainerSpec[]);
}

function requestedMemory(pod: KubeObject): number {
  const containers: ContainerSpec[] = (pod.spec as any)?.containers ?? [];
  return containers.reduce(
    (sum, container) => sum + parseQuantity(container.resources?.requests?.memory),
    0
  );
}

function formatMi(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}Mi`;
}

/** 探针失败的 Event 里那句描述，和真 kubelet 一个格式 */
function describeProbe(probe: Probe | undefined): string {
  if (probe?.httpGet) {
    return `HTTP probe failed with statuscode: 404 (GET ${probe.httpGet.path ?? '/'} on port ${probe.httpGet.port})`;
  }
  if (probe?.tcpSocket) {
    return `dial tcp: connect: connection refused (port ${probe.tcpSocket.port})`;
  }
  return 'command failed';
}
