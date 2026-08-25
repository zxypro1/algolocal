/**
 * 把内核、存储、apiserver、控制器接成一个能跑的集群
 *
 * 这是工作台真正拿在手里的东西：`cluster.apiServer.handle` 喂给 kubectl，
 * `cluster.settle()` 把世界推到静止，`cluster.advanceBy()` 快进时间。
 */
import { Kernel, createKernel, Priority } from '../kernel';
import { createStore, Store } from '../store';
import {
  ApiServer,
  createApiServer,
  createScheme,
  KubeObject,
  Registry,
  ResourceDefinition,
  Scheme,
} from '../apiserver';
import { Controller, ControllerContext } from './framework';
import { CORE_RESOURCES, EVENTS, NAMESPACES, NODES } from './resources';
import {
  DeploymentController,
  EndpointsController,
  ImageSpec,
  KubeletController,
  ReplicaSetController,
  SchedulerController,
} from './workloads';

export interface NodeSpec {
  name: string;
  /** 可分配 CPU，如 `4` 或 `4000m` */
  cpu?: string;
  memory?: string;
  labels?: Record<string, string>;
  /** 打上之后调度器不再往这里放新 Pod */
  unschedulable?: boolean;
}

export interface ClusterOptions {
  seed?: number;
  /** 世界的起始时刻 */
  startTime?: number;
  nodes?: NodeSpec[];
  namespaces?: string[];
  /** 镜像目录：不在里面的镜像拉不到 */
  images?: Record<string, ImageSpec>;
  extraResources?: ResourceDefinition[];
}

export class Cluster {
  readonly kernel: Kernel;
  readonly store: Store;
  readonly scheme: Scheme;
  readonly registry: Registry;
  readonly apiServer: ApiServer;

  private controllers: Controller[] = [];
  private uidSeq = 0;
  private started = false;

  constructor(private readonly options: ClusterOptions = {}) {
    this.kernel = createKernel({ seed: options.seed ?? 1 });
    // 世界的起始时刻是一个偏移量，内核的时钟从 0 开始走
    const startTime = options.startTime ?? Date.parse('2026-01-01T00:00:00Z');
    const now = () => startTime + this.kernel.now();

    this.store = createStore();
    this.scheme = createScheme([...CORE_RESOURCES, ...(options.extraResources ?? [])]);
    this.registry = new Registry({
      store: this.store,
      scheme: this.scheme,
      now,
      uid: () => `uid-${String(++this.uidSeq).padStart(6, '0')}`,
    });
    this.apiServer = createApiServer({ registry: this.registry, scheme: this.scheme, now });

    this.seed();
  }

  /** 世界的墙钟：起始时刻 + 虚拟流逝 */
  wallClock(): number {
    return (this.options.startTime ?? Date.parse('2026-01-01T00:00:00Z')) + this.kernel.now();
  }

  private get context(): ControllerContext {
    return {
      kernel: this.kernel,
      registry: this.registry,
      now: () => this.wallClock(),
      recordEvent: (input) => this.recordEvent(input),
    };
  }

  /** 建好命名空间与节点。这些是世界的初态，不是控制器造出来的。 */
  private seed(): void {
    const namespaces = this.options.namespaces ?? ['default', 'kube-system'];
    for (const name of namespaces) {
      this.registry.create(NAMESPACES, undefined, {
        apiVersion: 'v1', kind: 'Namespace',
        metadata: { name },
        status: { phase: 'Active' },
      });
    }

    const nodes = this.options.nodes ?? [
      { name: 'node-1' }, { name: 'node-2' }, { name: 'node-3' },
    ];
    for (const node of nodes) {
      const cpu = node.cpu ?? '4';
      const memory = node.memory ?? '8Gi';
      this.registry.create(NODES, undefined, {
        apiVersion: 'v1', kind: 'Node',
        metadata: {
          name: node.name,
          labels: {
            'kubernetes.io/hostname': node.name,
            'kubernetes.io/os': 'linux',
            ...(node.labels ?? {}),
          },
        },
        spec: { unschedulable: node.unschedulable ?? false },
        status: {
          capacity: { cpu, memory, pods: '110' },
          allocatable: { cpu, memory, pods: '110' },
          conditions: [{ type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'kubelet is posting ready status' }],
          addresses: [{ type: 'InternalIP', address: `10.0.0.${nodes.indexOf(node) + 10}` }],
          nodeInfo: {
            kubeletVersion: 'v1.36.0',
            osImage: 'Debian GNU/Linux 12 (bookworm)',
            kernelVersion: '6.1.0-opslab',
            containerRuntimeVersion: 'containerd://2.0.0',
          },
        },
      });
    }
  }

  /**
   * 记一条 Event。
   *
   * 名字带上时间，同一个对象上的多条事件不会互相覆盖 ——
   * `kubectl describe` 底下那段事件列表就是从这里来的。
   */
  recordEvent(input: {
    object: KubeObject;
    type: 'Normal' | 'Warning';
    reason: string;
    message: string;
  }): void {
    const namespace = input.object.metadata.namespace ?? 'default';
    const name = `${input.object.metadata.name}.${this.kernel.now().toString(16)}${this.eventSeq++}`;
    try {
      this.registry.create(EVENTS, namespace, {
        apiVersion: 'v1', kind: 'Event',
        metadata: { name, namespace },
        type: input.type,
        reason: input.reason,
        message: input.message,
        involvedObject: {
          kind: input.object.kind,
          name: input.object.metadata.name,
          namespace: input.object.metadata.namespace,
          uid: input.object.metadata.uid,
        },
        count: 1,
      } as KubeObject);
    } catch {
      // 事件写不进去不该影响主流程
    }
  }

  private eventSeq = 0;

  /** 起所有控制器。调用之后世界开始自己动。 */
  start(): void {
    if (this.started) return;
    this.started = true;

    const context = this.context;
    this.controllers = [
      new SchedulerController(context),
      new ReplicaSetController(context),
      new DeploymentController(context),
      new EndpointsController(context),
      ...(this.options.nodes ?? [{ name: 'node-1' }, { name: 'node-2' }, { name: 'node-3' }]).map(
        (node) => new KubeletController(context, node.name, { images: this.options.images })
      ),
    ];
    for (const controller of this.controllers) controller.start();
  }

  /** 把世界推到静止 */
  settle(options?: { maxVirtualMs?: number }): Promise<void> {
    return this.kernel.settle(options);
  }

  /**
   * 快进一段虚拟时间。
   *
   * 只跑这段窗口内到期的东西，**不会**顺带把之后的也跑完 ——
   * 想看中间态就小步快进，想要终态就调 settle()。
   */
  advanceBy(ms: number): Promise<void> {
    return this.kernel.advanceBy(ms);
  }

  /** 当前虚拟时刻（毫秒，从世界起点算） */
  now(): number {
    return this.kernel.now();
  }

  stop(): void {
    for (const controller of this.controllers) controller.stop();
    this.controllers = [];
    this.started = false;
  }
}

export function createCluster(options?: ClusterOptions): Cluster {
  return new Cluster(options);
}

export { Priority };
