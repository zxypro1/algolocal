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
import {
  KYVERNO_LABEL, KYVERNO_RESOURCES, createPsaValidator, digestOf, reviewWithKyverno,
} from '../admission';
import { DaemonSetController } from './daemonset';
import { ARGOCD_RESOURCES, ArgoCdController } from '../argocd';
import {
  ISTIOD_LABEL, MESH_RESOURCES, WAYPOINT_CLASS, ZTUNNEL_LABEL, isAmbient, traverseMesh,
  type MeshPeer, type MeshView,
} from '../mesh';
import {
  CLUSTERROLEBINDINGS, CLUSTERROLES, RBAC_RESOURCES, ROLEBINDINGS, ROLES, authorize,
} from '../rbac';
import { ESO_RESOURCES, ExternalSecretsController } from '../secrets';
import {
  OBSERVABILITY_RESOURCES, PrometheusController, evaluate as promqlEvaluate,
} from '../observability';
import { ROLLOUT_RESOURCES, RolloutController } from '../rollouts';
import { DISRUPTION_RESOURCES, PdbController, evictionVerdict } from '../disruption';
import {
  STORAGE_RESOURCES, StorageController, VolumeStore, createDefaultStorageClassDefaulter,
} from '../storage';
import {
  BackupStore, SNAPSHOT_RESOURCES, SnapshotController, VELERO_RESOURCES, VeleroController,
} from '../backup';
import { CORE_RESOURCES, EVENTS, NAMESPACES, NODES } from './resources';
import {
  DeploymentController,
  EndpointsController,
  NamespaceController,
  ImageSpec,
  KubeletController,
  NodePressureController,
  ReplicaSetController,
  SchedulerController,
} from './workloads';
import type { ImageBehavior, RegistryAuth } from './runtime';
import { Network, createNetwork, type Source, type Zone } from '../net';
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
  /**
   * Argo CD 去哪儿取仓库内容。
   *
   * 集群自己不认识 Git —— 这条由世界注入，和镜像解析、信任库一样。
   * 不给就是这个集群没装 GitOps。
   */
  gitSource?: import('../argocd').RepoResolver;
  /** 仓库有新提交时叫一声（webhook）。 */
  gitSubscribe?: (listener: () => void) => void;
  /**
   * token -> 身份。
   *
   * 一旦给了这张表，这个集群就开始鉴权：不在表里的 token 是匿名用户，
   * 而匿名用户什么都干不了。不给就是「这个世界不讲 RBAC」，
   * 所有请求都是 cluster-admin —— 前面十几关不必为此各配一套角色。
   */
  users?: Record<string, { username: string; groups?: string[] }>;
  /** 每个采集目标这一轮贡献哪些指标。由世界注入 —— 指标从集群状态里长出来。 */
  metrics?: import('../observability').MetricsSource;
  /** 去外部密钥库取值。由世界注入 —— 集群自己不认识 OpenBao。 */
  fetchSecret?: import('../secrets').SecretFetcher;
  /** 镜像签名库。由世界注入，和镜像仓库一样是集群外的东西。 */
  signatures?: import('../admission').SignatureStore;
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

  /**
   * 卷上的字节。
   *
   * 不放在 apiserver 里，因为它本来就不在那儿 —— PV 只是一条元数据记录，
   * 数据在存储后端上。这个区别是「备份了对象图，恢复出来是空盘」的根。
   */
  readonly volumes = new VolumeStore();

  /**
   * 备份桶。
   *
   * 同理，也不在 apiserver 里：集群整个没了，桶还在；反过来桶没了而
   * Backup 对象还在，`kubectl get backup` 照样显示 Completed。
   */
  readonly backups = new BackupStore();

  /** 监控。世界没配 metrics 就是 undefined。 */
  prometheus?: PrometheusController;
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
      ...CORE_RESOURCES, ...GATEWAY_RESOURCES, ...CERT_RESOURCES, ...ARGOCD_RESOURCES,
      ...MESH_RESOURCES, ...RBAC_RESOURCES, ...KYVERNO_RESOURCES, ...ESO_RESOURCES,
      ...OBSERVABILITY_RESOURCES, ...DISRUPTION_RESOURCES, ...ROLLOUT_RESOURCES,
      ...STORAGE_RESOURCES, ...SNAPSHOT_RESOURCES, ...VELERO_RESOURCES,
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
      ...(options.users
        ? {
            authenticate: (token) => {
              if (!token) return undefined;
              const found = options.users![token];
              if (!found) return undefined;
              return {
                username: found.username,
                groups: [...(found.groups ?? []), 'system:authenticated'],
              };
            },
            authorize: (user, attributes) => authorize({
              roles: () => this.registry.list(ROLES).items,
              roleBindings: () => this.registry.list(ROLEBINDINGS).items,
              clusterRoles: () => this.registry.list(CLUSTERROLES).items,
              clusterRoleBindings: () => this.registry.list(CLUSTERROLEBINDINGS).items,
            }, user, attributes),
          }
        : {}),
      /**
       * 驱逐前问一遍 PDB。
       *
       * 这是 `kubectl drain` 会在违反预算时停下来的原因 ——
       * 而 `kubectl delete pod` 走的是另一条路，谁也拦不住。
       */
      evict: (namespace, name) => {
        const pods = this.scheme.get({ group: '', version: 'v1', resource: 'pods' });
        const budgets = this.scheme.get({ group: 'policy', version: 'v1', resource: 'poddisruptionbudgets' });
        if (!pods || !budgets) return { allowed: true };
        const inNamespace = this.registry.list(pods, { namespace }).items;
        const pod = inNamespace.find((item) => item.metadata.name === name);
        if (!pod) return { allowed: true };
        return evictionVerdict(pod, this.registry.list(budgets).items, inNamespace);
      },
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
      policyEnforced: () => this.policyEnforced(),
      mesh: (input) => this.meshDecision(input),
      now,
    });

    // ClusterIP 在 apiserver 这一层分，不是控制器事后补的 ——
    // 这样 `kubectl expose` 之后紧跟 `kubectl get svc`，IP 已经在那儿了
    this.registry.addDefaulter(createServiceIpDefaulter({
      registry: this.registry, scheme: this.scheme, cidr: options.serviceCidr,
    }));

    // 同理：PVC 的 storageClassName 由 apiserver 补默认值，不是控制器事后写的
    this.registry.addDefaulter(createDefaultStorageClassDefaulter({
      registry: this.registry, scheme: this.scheme,
    }));

    /**
     * PodSecurity 是 apiserver 内置的准入，不是一个工作负载 ——
     * 真集群里也一样，它没法被卸载，只能靠命名空间标签开关。
     */
    /**
     * 顺序要紧：内置插件跑在 webhook 前面。
     *
     * 一个 Pod 同时违反 PSA 与 Kyverno 时，真集群报的是 PSA 那句话 ——
     * 反过来的话学员会以为「先去加个 owner 标签」，改完才发现还有特权容器。
     */
    this.registry.addValidator(createPsaValidator({
      namespace: (name) => {
        const namespaces = this.scheme.get({ group: '', version: 'v1', resource: 'namespaces' });
        if (!namespaces) return undefined;
        return this.registry.list(namespaces).items.find((item) => item.metadata.name === name);
      },
    }));

    /**
     * Kyverno 是集群里的一个工作负载。
     *
     * Deployment 停了策略就不再执行，而 `kubectl get cpol` 照样看得见 ——
     * 和 CNI、网格一样，这条约束在这里兑现。
     */
    this.registry.addValidator({
      name: 'kyverno',
      review: ({ definition, namespace, object }) => reviewWithKyverno({
        installed: () => this.kyvernoInstalled(),
        policies: () => {
          const policies = this.scheme.get({
            group: 'kyverno.io', version: 'v1', resource: 'clusterpolicies',
          });
          return policies ? this.registry.list(policies).items : [];
        },
        verifyImage: (image, publicKey) =>
          this.options.signatures?.verify(digestOf(image), publicKey) ?? false,
      }, { definition, object, namespace }).denied,
    });

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
  /**
   * 集群里有没有一个跑着的、会执行 NetworkPolicy 的 CNI。
   *
   * 判断依据是**镜像声明了什么**（`enforcesNetworkPolicy`），不是名字里有没有
   * cilium —— 宿主不认识任何具体的 CNI，和 Envoy Gateway、cert-manager 一样，
   * 它就是集群里的一个工作负载，卸载掉策略立刻失效。
   */
  policyEnforced(): boolean {
    /**
     * 世界压根没提过 CNI 就别管这件事。
     *
     * 只有当关卡的镜像表里出现 `enforcesNetworkPolicy` 时，「CNI 执不执行策略」
     * 才成为这个世界的一个维度；否则策略照常生效，前九关不用为此各装一个 CNI。
     */
    const modelsCni = Object.values(this.options.images ?? {})
      .some((behavior) => behavior?.enforcesNetworkPolicy !== undefined);
    if (!modelsCni) return true;

    const pods = this.scheme.get({ group: '', version: 'v1', resource: 'pods' });
    if (!pods) return false;
    return this.registry.list(pods).items.some((pod) => {
      if (((pod.status ?? {}) as any).phase !== 'Running') return false;
      const containers = ((pod.spec ?? {}) as any).containers ?? [];
      return containers.some((container: any) =>
        this.imageBehaviorOf(container.image)?.enforcesNetworkPolicy);
    });
  }

  /**
   * 一条连接过网格时发生了什么。
   *
   * 网络层不认识 Istio 的 CRD —— 它只拿到一句话和一个「拦没拦」。
   * 和 Envoy Gateway、cert-manager 一样，网格的控制面与数据面都是集群里的
   * 工作负载：istiod 或 ztunnel 不可用，这里直接返回 off。
   */
  private meshDecision(input: {
    source: Source; destination: KubeObject; port: number; method?: string; path?: string;
  }): { kind: string; detail: string; blocked?: boolean } | undefined {
    const view = this.meshView();
    if (!view) return undefined;
    const outcome = traverseMesh(view, this.meshPeerOf(input.source), this.meshPeerOfPod(input.destination), {
      port: input.port, method: input.method, path: input.path,
    });
    return {
      kind: outcome.kind,
      detail: outcome.detail,
      blocked: outcome.kind === 'denied' || outcome.kind === 'plaintext-rejected',
    };
  }

  /** 给 istioctl 用的只读视图。命令不改任何东西。 */
  istioView() {
    const mesh = this.meshView();
    if (!mesh) return undefined;
    const pods = this.scheme.get({ group: '', version: 'v1', resource: 'pods' })!;
    const namespaces = this.scheme.get({ group: '', version: 'v1', resource: 'namespaces' })!;
    const services = this.scheme.get({ group: '', version: 'v1', resource: 'services' })!;
    return {
      mesh,
      pods: (namespace?: string) => this.registry.list(pods, { namespace }).items,
      namespaces: () => this.registry.list(namespaces).items,
      services: (namespace?: string) => this.registry.list(services, { namespace }).items,
      peerOf: (pod: KubeObject) => this.meshPeerOfPod(pod),
    };
  }

  private meshView(): MeshView | undefined {
    const peerAuth = this.scheme.get({
      group: 'security.istio.io', version: 'v1', resource: 'peerauthentications',
    });
    const authz = this.scheme.get({
      group: 'security.istio.io', version: 'v1', resource: 'authorizationpolicies',
    });
    if (!peerAuth || !authz) return undefined;
    return {
      installed: () => this.meshInstalled(),
      hasWaypoint: (namespace) => this.hasWaypoint(namespace),
      peerAuthentications: () => this.registry.list(peerAuth).items,
      authorizationPolicies: () => this.registry.list(authz).items,
    };
  }

  /** istiod 与 ztunnel 都得在跑 —— 少一个网格就不成立 */
  private meshInstalled(): boolean {
    const deployments = this.scheme.get({ group: 'apps', version: 'v1', resource: 'deployments' });
    const daemonSets = this.scheme.get({ group: 'apps', version: 'v1', resource: 'daemonsets' });
    if (!deployments || !daemonSets) return false;
    const istiod = this.registry.list(deployments).items.some((item) =>
      item.metadata.labels?.[ISTIOD_LABEL.key] === ISTIOD_LABEL.value
      && (((item.status ?? {}) as any).availableReplicas ?? 0) > 0);
    const ztunnel = this.registry.list(daemonSets).items.some((item) =>
      item.metadata.labels?.[ZTUNNEL_LABEL.key] === ZTUNNEL_LABEL.value
      && (((item.status ?? {}) as any).numberReady ?? 0) > 0);
    return istiod && ztunnel;
  }

  /** 这个命名空间挂了 waypoint 没有。挂上才有 L7。 */
  private hasWaypoint(namespace: string): boolean {
    const gateways = this.scheme.get({
      group: 'gateway.networking.k8s.io', version: 'v1', resource: 'gateways',
    });
    if (!gateways) return false;
    return this.registry.list(gateways, { namespace }).items.some((gateway) =>
      ((gateway.spec ?? {}) as any).gatewayClassName === WAYPOINT_CLASS);
  }

  private meshPeerOf(source: Source): MeshPeer | undefined {
    if (source.zone !== 'cluster' || !source.podName || !source.namespace) return undefined;
    const pods = this.scheme.get({ group: '', version: 'v1', resource: 'pods' });
    if (!pods) return undefined;
    const pod = this.registry.list(pods, { namespace: source.namespace }).items
      .find((item) => item.metadata.name === source.podName);
    return pod ? this.meshPeerOfPod(pod) : undefined;
  }

  private meshPeerOfPod(pod: KubeObject): MeshPeer {
    const namespace = pod.metadata.namespace ?? 'default';
    const namespaces = this.scheme.get({ group: '', version: 'v1', resource: 'namespaces' });
    const object = namespaces
      ? this.registry.list(namespaces).items.find((item) => item.metadata.name === namespace)
      : undefined;
    return {
      namespace,
      labels: pod.metadata.labels ?? {},
      serviceAccount: ((pod.spec ?? {}) as any).serviceAccountName ?? 'default',
      enrolled: isAmbient(object),
    };
  }

  /** Kyverno 的控制面在不在 */
  private kyvernoInstalled(): boolean {
    const deployments = this.scheme.get({ group: 'apps', version: 'v1', resource: 'deployments' });
    if (!deployments) return false;
    return this.registry.list(deployments).items.some((item) =>
      item.metadata.labels?.[KYVERNO_LABEL.key] === KYVERNO_LABEL.value
      && (((item.status ?? {}) as any).availableReplicas ?? 0) > 0);
  }

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
      scheme: this.scheme,
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
      // 每个节点一份：CNI 的 agent、日志采集都是这个形状
      new DaemonSetController(context),
      new EndpointsController(context),
      // 删掉一个命名空间，里面的东西全部跟着没 —— 包括 PVC，也就包括数据
      new NamespaceController(context),
      // PDB 的状态。`kubectl get pdb` 里 ALLOWED DISRUPTIONS 那一列就是它写的。
      new PdbController(context),
      /**
       * 绑定与回收。静态绑定是控制面自带的，所以这个控制器无条件跑；
       * **动态供给**要看 CSI 驱动这个工作负载在不在（见 StorageController）。
       */
      new StorageController(context, { volumes: this.volumes }),
      // 快照：又一个工作负载。装了 CSI 驱动不等于装了它。
      new SnapshotController(context, { volumes: this.volumes }),
      // 备份。Backup 对象在集群里，备份内容在桶里 —— 所以 store 不在 registry 上。
      new VeleroController(context, { store: this.backups }),
      // 入口：控制器自己是集群里的一个工作负载，卸载掉 Gateway 就不再被 program
      new GatewayController(context),
      // 内网 PKI：同样是集群里的一个工作负载，卸载掉就不再签发
      new CertManagerController(context),
      // 监控：采集是定时拉的，所以采样之间发生的事看不见
      ...(this.options.metrics
        ? [(this.prometheus = new PrometheusController(context, this.options.metrics))]
        : []),
      /**
       * 渐进式发布。
       *
       * 分析用的是同一套 PromQL 求值器 —— 金丝雀的判据和告警的判据本来
       * 就该是同一个东西，不然「发布时看着没事、上线后告警响」。
       */
      ...(this.options.metrics
        ? [new RolloutController(context, {
            evaluate: (query) => {
              const prometheus = this.prometheus;
              if (!prometheus) return undefined;
              try {
                const results = promqlEvaluate(prometheus.tsdb, query, this.wallClock());
                return results[0]?.value;
              } catch {
                return undefined;
              }
            },
          })]
        : []),
      // 密钥：真值住在集群外面，这里只维护一份投影
      ...(this.options.fetchSecret
        ? [new ExternalSecretsController(context, { fetch: this.options.fetchSecret })]
        : []),
      // GitOps：仓库里那份 YAML 才是期望状态，集群里的对象是它的投影
      ...(this.options.gitSource
        ? [new ArgoCdController(context, {
            source: this.options.gitSource,
            subscribe: this.options.gitSubscribe,
          })]
        : []),
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
