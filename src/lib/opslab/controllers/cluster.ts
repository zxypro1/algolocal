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
import { createServiceIpDefaulter } from './serviceip';
import { CORE_RESOURCES, EVENTS, NAMESPACES, NODES } from './resources';
import {
  DeploymentController,
  EndpointsController,
  ImageSpec,
  KubeletController,
  NodePressureController,
  ReplicaSetController,
  SchedulerController,
} from './workloads';
import type { ImageBehavior, RegistryAuth } from './runtime';
import { Network, createNetwork, type Zone } from '../net';
import {
  AddressPool, GATEWAY_RESOURCES, GatewayController, LoadBalancerController, resolveGateway,
} from '../gateway';
import { CERT_RESOURCES, CertManagerController } from '../certs';
import { parseChain, type Certificate } from '../crypto';

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
  /** 每个仓库要不要认证 —— 私有仓库没 imagePullSecret 就拉不下来 */
  registries?: Record<string, RegistryAuth>;
  /** 目录里没有时再问一次（学员自己 push 上去的镜像） */
  resolveImage?: (image: string) => ImageSpec | undefined;
  /** 集群外的名字，`harbor.corp.internal` 之类 */
  externalHosts?: Record<string, string[]>;
  /** Service 的 VIP 从哪个网段分。默认 10.96.0.0/12，和真集群一样。 */
  serviceCidr?: string;
  /** `kubectl exec` 落到哪。不给就是这个集群不支持 exec。 */
  exec?: import('../apiserver').ExecHandler;
  /** 客户端信任哪些根。办公网的机器读自己的 ca-certificates.crt。 */
  trustBundle?: (source: import('../net').Source) => Certificate[];
  /**
   * 负载均衡地址池。
   *
   * `loadBalancerClass` 决定从哪个池子分地址，也决定这个地址被暴露到哪个网段。
   * 内网入口与公网入口的分野在这里，不在 Gateway 自己身上。
   */
  addressPools?: AddressPool[];
  /**
   * 集群「已经跑了多久」。
   *
   * 节点和命名空间是世界的初态，不是刚刚建出来的。不给它们一个合理的年龄，
   * `kubectl get nodes` 的 AGE 列会显示 0s —— 一个跑了半年的生产集群
   * 节点年龄是 0 秒，一眼假。
   */
  clusterAgeMs?: number;
  extraResources?: ResourceDefinition[];
}

/** 不声明地址池时，只有一个内网池 —— 默认不该把东西暴露到公网 */
const DEFAULT_POOLS: AddressPool[] = [
  { loadBalancerClass: 'corp.internal/office-lb', cidrPrefix: '10.10.8', zones: ['office'] },
];

export class Cluster {
  readonly kernel: Kernel;
  readonly store: Store;
  readonly scheme: Scheme;
  readonly registry: Registry;
  readonly apiServer: ApiServer;
  /** 网络：DNS、Service 转发、NetworkPolicy 判定，全都读 apiserver 里的对象 */
  readonly network: Network;

  /** 由外面装上（createOpsWorld 会接一个 Pod 里的 shell 进来） */
  execHandler?: import('../apiserver').ExecHandler;
  private controllers: Controller[] = [];
  private uidSeq = 0;
  private started = false;
  /** 铺初态时把时钟往回拨这么多，让「本来就在」的东西有个合理年龄 */
  private backdate = 0;

  constructor(private readonly options: ClusterOptions = {}) {
    this.kernel = createKernel({ seed: options.seed ?? 1 });
    // 世界的起始时刻是一个偏移量，内核的时钟从 0 开始走
    const startTime = options.startTime ?? Date.parse('2026-01-01T00:00:00Z');
    const now = () => startTime + this.kernel.now() - this.backdate;

    this.store = createStore();
    this.scheme = createScheme([
      ...CORE_RESOURCES, ...GATEWAY_RESOURCES, ...CERT_RESOURCES,
      ...(options.extraResources ?? []),
    ]);
    this.registry = new Registry({
      store: this.store,
      scheme: this.scheme,
      now,
      uid: () => `uid-${String(++this.uidSeq).padStart(6, '0')}`,
    });
    this.apiServer = createApiServer({
      registry: this.registry, scheme: this.scheme, now,
      exec: (request, stdin) => {
        if (!this.execHandler) throw new Error('exec 没有接上');
        return this.execHandler(request, stdin);
      },
    });
    this.network = createNetwork({
      registry: this.registry,
      scheme: this.scheme,
      externalHosts: options.externalHosts,
      exposure: (address) => this.zonesOf(address),
      gatewayRoute: (address, request) =>
        resolveGateway({ registry: this.registry, scheme: this.scheme }, address, request),
      serverChain: (input) => this.serverChainOf(input),
      trustBundle: (source) => options.trustBundle?.(source) ?? [],
      imageOf: (image) => this.imageBehaviorOf(image),
      now,
    });

    // ClusterIP 在 apiserver 这一层分，不是控制器事后补的 ——
    // 这样 `kubectl expose` 之后紧跟 `kubectl get svc`，IP 已经在那儿了
    this.registry.addDefaulter(createServiceIpDefaulter({
      registry: this.registry, scheme: this.scheme, cidr: options.serviceCidr,
    }));

    this.seed();
  }

  /**
   * 这个端口上出示什么证书链。
   *
   * 从 Gateway 的 HTTPS listener 找到 `tls.certificateRefs` 指的 Secret，
   * 把 `tls.crt` 解出来。也就是说「证书配没配对」这件事完全由集群里的对象决定。
   */
  private serverChainOf(input: { address: string; port: number; host: string }): Certificate[] | undefined {
    const services = this.scheme.get({ group: '', version: 'v1', resource: 'services' });
    const gateways = this.scheme.get({
      group: 'gateway.networking.k8s.io', version: 'v1', resource: 'gateways',
    });
    const secrets = this.scheme.get({ group: '', version: 'v1', resource: 'secrets' });
    if (!services || !gateways || !secrets) return undefined;

    const owner = this.registry.list(services).items.find((service) =>
      ((service.status ?? {}) as any)?.loadBalancer?.ingress?.some((entry: any) => entry.ip === input.address)
      && service.metadata.labels?.['gateway.envoyproxy.io/owning-gateway-name']);
    if (!owner) return undefined;

    const gateway = this.registry.list(gateways).items.find(
      (item) => item.metadata.name === owner.metadata.labels!['gateway.envoyproxy.io/owning-gateway-name']
        && item.metadata.namespace === owner.metadata.labels!['gateway.envoyproxy.io/owning-gateway-namespace']
    );
    if (!gateway) return undefined;

    const listener = ((gateway.spec ?? {}) as any).listeners?.find(
      (entry: any) => Number(entry.port) === input.port && entry.protocol === 'HTTPS'
    );
    const reference = listener?.tls?.certificateRefs?.[0];
    if (!reference) return undefined;

    try {
      const secret = this.registry.get(
        secrets, reference.namespace ?? gateway.metadata.namespace, reference.name
      );
      const pem = atob((((secret as any).data ?? {})['tls.crt']) ?? '');
      return parseChain(pem);
    } catch {
      return undefined;
    }
  }

  /**
   * 这个地址被暴露到了哪些网段。
   *
   * 读的是 LoadBalancer Service 的 `spec.loadBalancerClass` —— 也就是说
   * 「内网还是公网」是集群里的一个对象说了算的，不是宿主写死的。
   */
  private zonesOf(address: string): Zone[] {
    const services = this.scheme.get({ group: '', version: 'v1', resource: 'services' });
    if (!services) return [];
    for (const service of this.registry.list(services).items) {
      const ingress = ((service.status ?? {}) as any)?.loadBalancer?.ingress ?? [];
      if (!ingress.some((entry: any) => entry.ip === address)) continue;
      const className = ((service.spec ?? {}) as any).loadBalancerClass;
      const pool = (this.options.addressPools ?? []).find(
        (item) => item.loadBalancerClass === className
      ) ?? (this.options.addressPools ?? [])[0];
      return (pool?.zones ?? ['office']) as Zone[];
    }
    return [];
  }

  /** 这个镜像的运行时行为：端口、路由、内存。网络与 kubelet 共用同一份。 */
  imageBehaviorOf(image: string | undefined): ImageBehavior | undefined {
    if (!image) return undefined;
    return this.options.images?.[image] ?? this.options.resolveImage?.(image);
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

  /** 节点清单。seed 和 start 都要用，只能有一处定义，否则两边会漂。 */
  private get nodeSpecs(): NodeSpec[] {
    return this.options.nodes ?? [{ name: 'node-1' }, { name: 'node-2' }, { name: 'node-3' }];
  }

  /** 建好命名空间与节点。这些是世界的初态，不是控制器造出来的。 */
  private seed(): void {
    this.backdate = this.options.clusterAgeMs ?? 0;
    try {
      this.seedInfrastructure();
    } finally {
      this.backdate = 0;
    }
  }

  /**
   * 按「世界本来就有」的时间铺一批对象。
   *
   * 关卡的初态对象（上一任留下的 Deployment 之类）也该用它，
   * 否则学员一进来就看到一个 0 秒前刚建出来的「历史遗留」。
   */
  seedExisting<T>(ageMs: number, run: () => T): T {
    this.backdate = ageMs;
    try {
      return run();
    } finally {
      this.backdate = 0;
    }
  }

  private seedInfrastructure(): void {
    const namespaces = this.options.namespaces ?? ['default', 'kube-system'];
    for (const name of namespaces) {
      this.registry.create(NAMESPACES, undefined, {
        apiVersion: 'v1', kind: 'Namespace',
        metadata: { name },
        status: { phase: 'Active' },
      });
    }

    const nodes = this.nodeSpecs;
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
      // 入口：控制器自己是集群里的一个工作负载，卸载掉 Gateway 就不再被 program
      new GatewayController(context),
      // 内网 PKI：同样是集群里的一个工作负载，卸载掉就不再签发
      new CertManagerController(context),
      new LoadBalancerController(context, this.options.addressPools ?? DEFAULT_POOLS),
      ...this.nodeSpecs.flatMap((node) => [
        new KubeletController(context, node.name, {
          images: this.options.images,
          registries: this.options.registries,
          resolveImage: this.options.resolveImage,
        }),
        new NodePressureController(node.name, context, this.options.images ?? {}),
      ]),
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
