/**
 * DaemonSet
 *
 * 每个节点一个 Pod。CNI 的 agent、日志采集、节点监控都是这个形状 ——
 * 它们不是「跑几份」，而是「每台机器上都得有一份」。
 *
 * 和 Deployment 的区别不只是数量：DaemonSet 没有 ReplicaSet 这一层，
 * Pod 直接挂在 DaemonSet 下面，而且 Pod 的 `spec.nodeName` 是控制器写死的 ——
 * 调度器不参与。所以节点一多，Pod 立刻就跟上；节点被删，Pod 跟着走。
 */
import type { KubeObject } from '../apiserver';
import { Controller, ControllerContext, Informer, isConflict, isNotFound, splitKey } from './framework';
import { ignoreConflict, updateStatusIfChanged } from './workloads';
import { DAEMONSETS, NODES, PODS, matchesSelector } from './resources';

export class DaemonSetController extends Controller {
  private daemonSets: Informer;
  private pods: Informer;
  private nodes: Informer;

  constructor(context: ControllerContext) {
    super(context, 'daemonset');
    this.daemonSets = new Informer(this.registry, DAEMONSETS);
    this.pods = new Informer(this.registry, PODS);
    this.nodes = new Informer(this.registry, NODES);
    this.watch(this.daemonSets);
    this.watch(this.pods, (pod) => {
      const owner = (pod.metadata.ownerReferences ?? []).find((ref) => ref.kind === 'DaemonSet');
      return owner ? `${pod.metadata.namespace}/${owner.name}` : null;
    });
    // 节点变了，每个 DaemonSet 都要重新看一遍
    // 节点的 key 映不到 DaemonSet 上：一个节点变动牵动所有 DaemonSet
    this.nodes.onChange(() => { for (const key of this.allKeys()) this.enqueue(key); });
    this.track(this.nodes);
  }

  private allKeys(): string[] {
    return this.registry.list(DAEMONSETS).items
      .map((item) => `${item.metadata.namespace}/${item.metadata.name}`);
  }

  protected async reconcile(key: string): Promise<void> {
    const { namespace, name } = splitKey(key);
    let daemonSet: KubeObject;
    try {
      daemonSet = this.registry.get(DAEMONSETS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (daemonSet.metadata.deletionTimestamp) return;

    const spec = (daemonSet.spec ?? {}) as any;
    const template = spec.template ?? {};
    const targets = this.targetNodes(template.spec ?? {});
    const owned = this.ownedPods(daemonSet).filter((pod) => !pod.metadata.deletionTimestamp);
    const byNode = new Map(owned.map((pod) => [(pod.spec as any)?.nodeName, pod]));

    for (const node of targets) {
      if (!byNode.has(node.metadata.name)) this.createPod(daemonSet, node.metadata.name!);
    }
    // 节点没了（或者被打上了不匹配的标签）就把那台上的 Pod 收掉
    const wanted = new Set(targets.map((node) => node.metadata.name));
    for (const pod of owned) {
      const nodeName = (pod.spec as any)?.nodeName;
      if (!wanted.has(nodeName)) {
        try {
          this.registry.delete(PODS, pod.metadata.namespace, pod.metadata.name);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
    }

    const current = this.ownedPods(daemonSet).filter((pod) => !pod.metadata.deletionTimestamp);
    const ready = current.filter(isReady);
    await ignoreConflict(() => {
      const latest = this.registry.get(DAEMONSETS, namespace, name);
      updateStatusIfChanged(this.registry, DAEMONSETS, namespace, name, {
        currentNumberScheduled: current.length,
        desiredNumberScheduled: targets.length,
        numberMisscheduled: 0,
        numberReady: ready.length,
        numberAvailable: ready.length,
        updatedNumberScheduled: current.length,
        observedGeneration: latest.metadata.generation,
      });
    });
  }

  /**
   * 哪些节点该有这个 Pod。
   *
   * `nodeSelector` 是 DaemonSet 最常用的限定方式（「只在 ingress 节点上跑」）。
   * 真 k8s 还看 affinity 与 taint/toleration，这里先只做 nodeSelector ——
   * 教学上要区分的是「每个节点一份」和「跑几份」，不是调度器的全部规则。
   */
  private targetNodes(podSpec: { nodeSelector?: Record<string, string> }): KubeObject[] {
    const selector = podSpec.nodeSelector;
    return this.registry.list(NODES).items
      .filter((node) => matchesSelector(selector ? { matchLabels: selector } : undefined, node.metadata.labels))
      .sort((a, b) => (a.metadata.name! < b.metadata.name! ? -1 : 1));
  }

  private ownedPods(daemonSet: KubeObject): KubeObject[] {
    return this.registry
      .list(PODS, { namespace: daemonSet.metadata.namespace })
      .items.filter((pod) =>
        (pod.metadata.ownerReferences ?? []).some((ref) => ref.uid === daemonSet.metadata.uid)
      );
  }

  private createPod(daemonSet: KubeObject, nodeName: string): void {
    const spec = (daemonSet.spec ?? {}) as any;
    const template = spec.template ?? {};
    const suffix = this.kernel.random.suffix(5);
    const pod: KubeObject = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: `${daemonSet.metadata.name}-${suffix}`,
        namespace: daemonSet.metadata.namespace,
        labels: { ...(template.metadata?.labels ?? {}) },
        ownerReferences: [{
          apiVersion: 'apps/v1', kind: 'DaemonSet',
          name: daemonSet.metadata.name, uid: daemonSet.metadata.uid!,
          controller: true, blockOwnerDeletion: true,
        }],
      },
      // nodeName 是控制器直接写死的 —— DaemonSet 的 Pod 不经过调度器
      spec: { ...(template.spec ?? {}), nodeName },
      status: { phase: 'Pending' },
    };
    try {
      this.registry.create(PODS, daemonSet.metadata.namespace, pod);
      this.context.recordEvent({
        object: daemonSet, type: 'Normal', reason: 'SuccessfulCreate',
        message: `Created pod: ${pod.metadata.name}`,
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
}

function isReady(pod: KubeObject): boolean {
  const conditions: any[] = (pod.status as any)?.conditions ?? [];
  return conditions.some((entry) => entry.type === 'Ready' && entry.status === 'True');
}
