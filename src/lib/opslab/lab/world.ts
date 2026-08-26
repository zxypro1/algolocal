/**
 * 把世界装配起来
 *
 * 一个 ops 关卡跑起来需要：内存集群（etcd 语义 + apiserver + 控制器）、
 * 一台跳板机（文件系统 + shell + coreutils）、镜像仓库、以及真 CLI。
 * 这里按题目里的世界定义把它们接好，工作台和判定用的是**同一个**世界对象。
 */
import type {
  OpsImageSpec, OpsStageSpec, OpsWorldSpec,
} from '../../engineering/types';
import { Cluster, createCluster } from '../controllers';
import { Machine, createMachine, type CommandHandler } from '../machine';
import {
  ImageStore, Registry as ImageRegistry, RegistryNetwork, createDockerCommand,
  normalizeReference, parseReference, type Image,
} from '../machine/oci';
import type { ImageBehavior } from '../controllers';
import { baseImageOf, toolchainFor } from './toolchains';
import { createNetTools } from '../net';
import { parseChain } from '../crypto';
import { createOpensslCommand } from './openssl';
import { materializePki } from './pki';
import { GitNetwork, createGitCommand, parseCommit, readTree, seedRepository } from '../git';
import { createIstioctlCommand } from '../mesh';
import { SignatureStore, createCosignCommand } from '../admission';
import { OpenBao, createBaoCommand } from '../secrets';
import { createPromtoolCommand } from '../observability';
import { parseQuantity } from '../controllers';

/**
 * promtool 认哪些地址。
 *
 * 端口转发过来的、集群内的 Service 名，都指向同一个 Prometheus ——
 * 学员用哪种写法都该能查到。
 */
const PROMETHEUS_ADDRESSES = [
  'http://localhost:9090',
  'http://127.0.0.1:9090',
  'http://prometheus.monitoring.svc:9090',
  'http://prometheus.monitoring.svc.cluster.local:9090',
];
import { currentNamespaceOf } from './view';
import { DEFAULT_KUBECONFIG_PATH } from '../wasm';
import { createExecHandler } from './podshell';
import { CliRuntime, installClusterCli } from '../wasm';
import type { KubeObject } from '../apiserver';

export interface OpsWorldOptions {
  world?: OpsWorldSpec;
  stage?: OpsStageSpec;
  /** 真 CLI。不传就只有 shell 与 coreutils（单测里常这么用）。 */
  runtime?: CliRuntime;
}

export interface OpsWorld {
  cluster: Cluster;
  machine: Machine;
  images: ImageStore;
  registries: RegistryNetwork;
  /** 内网 Git 服务 */
  git: GitNetwork;
  /** 镜像签名 */
  signatures: SignatureStore;
  /** 内网密钥库。世界没声明就是 undefined。 */
  bao?: OpenBao;
  /** 装上的真 CLI 名字，如 ['kubectl','helm'] */
  applets: string[];
  /** 敲一条命令，然后让世界自己往前走到静止 */
  run(command: string): Promise<{ stdout: string; stderr: string; code: number }>;
  /** 世界的墙钟（毫秒） */
  now(): number;
}

const DEFAULT_START = '2026-03-02T09:00:00Z';
/** 集群默认「已经跑了 32 天」——接手的从来不是一个刚建好的集群 */
const DEFAULT_CLUSTER_AGE_MS = 32 * 24 * 60 * 60_000;
/** 初态对象默认「已经在那儿 6 小时」 */
const DEFAULT_OBJECT_AGE_MS = 6 * 60 * 60_000;

export async function createOpsWorld(options: OpsWorldOptions = {}): Promise<OpsWorld> {
  const spec = options.world ?? {};
  const stage = options.stage ?? {};

  const clusterAgeMs = spec.clusterAgeDays !== undefined
    ? spec.clusterAgeDays * 24 * 60 * 60_000
    : DEFAULT_CLUSTER_AGE_MS;

  /**
   * 内网的密钥库。
   *
   * 和镜像仓库、Git 服务一样是**集群外**的东西 —— 这正是它存在的意义：
   * 密钥不在集群里，集群里只有一份由 ESO 维护的投影。
   */
  const bao = spec.secretStore ? new OpenBao(spec.secretStore.address) : undefined;
  if (bao && spec.secretStore) {
    for (const [name, rules] of Object.entries(spec.secretStore.policies ?? {})) {
      bao.addPolicy(name, { rules });
    }
    for (const [path, data] of Object.entries(spec.secretStore.data ?? {})) bao.write(path, data);
    for (const [token, policy] of Object.entries(spec.secretStore.tokens ?? {})) bao.addToken(token, policy);
    if (spec.secretStore.kubernetesRoles) bao.enableKubernetesAuth(spec.secretStore.kubernetesRoles);
  }

  // 镜像签名。和镜像仓库一样是集群外的东西，cosign 往里写，Kyverno 从里读。
  const signatures = new SignatureStore();
  const declaredImages = new Set(
    Object.keys(mergeImages(spec.images, stage.images)).map(normalizeReference)
  );

  // 先声明，下面 createCluster 要用；仓库对象在它之后才建得出来
  let lookupPushedImage: (image: string) => ReturnType<typeof behaviorOfImage> | undefined = () => undefined;

  /**
   * 内网服务的名字。
   *
   * 私有仓库、Git 服务这些，办公网与集群都该解析得到；不在这张表里的
   * 名字表现和真的 DNS 失败一样 —— 「写错了域名」和「服务挂了」要分得开。
   */
  const externalHosts: Record<string, string[]> = {
    ...Object.fromEntries((spec.registries ?? []).map((registry, index) => [
      registry.host, [`10.10.0.${20 + index}`],
    ])),
    ...Object.fromEntries((spec.gitRepositories ?? []).flatMap((repository, index) => {
      const host = GitNetwork.hostOf(repository.url);
      return host ? [[host, [`10.10.0.${40 + index}`]] as [string, string[]]] : [];
    })),
    ...(spec.externalHosts ?? {}),
  };

  const cluster = createCluster({
    seed: spec.seed ?? 1,
    startTime: Date.parse(spec.startTime ?? DEFAULT_START),
    nodes: spec.nodes,
    namespaces: spec.namespaces,
    images: mergeImages(spec.images, stage.images),
    // kubelet 拉私有镜像时要按这张表验凭据
    registries: Object.fromEntries((spec.registries ?? []).map((registry) => [
      registry.host,
      {
        requiresAuth: Object.keys(registry.users ?? {}).length > 0,
        users: registry.users,
      },
    ])),
    clusterAgeMs,
    resolveImage: (image) => lookupPushedImage(image),
    externalHosts,
    addressPools: spec.addressPools,
    users: spec.users,
    signatures,
    /**
     * 指标从集群状态里长出来。
     *
     * 这几个是排查真正用得上的：`up`（由 Prometheus 合成，见控制器）、
     * HTTP 请求计数与错误计数、容器内存。数值由镜像声明的行为决定，
     * 于是「注入一个故障」就是改镜像行为或改副本数，而不是伪造指标。
     */
    metrics: {
      sample: (target, at) => {
        void at;
        const pods = cluster.scheme.get({ group: '', version: 'v1', resource: 'pods' });
        const pod = pods && cluster.registry.list(pods, { namespace: target.namespace }).items
          .find((item) => item.metadata.name === target.pod);
        if (!pod) return [];
        const containers = ((pod.spec ?? {}) as any).containers ?? [];
        const behavior = cluster.imageBehaviorOf(containers[0]?.image);
        const out: Array<{ name: string; labels: Record<string, string>; value: number }> = [];

        /**
         * 请求计数是 counter，单调递增。
         *
         * 每一轮按「这个 Pod 已经跑了多久」算，于是它随时间线性增长，
         * `rate()` 出来是一个稳定的值 —— Pod 重启之后从头开始，
         * 正好让学员看到 counter 归零这件事。
         */
        const started = Date.parse(((pod.status ?? {}) as any).startTime ?? '') || cluster.wallClock();
        const seconds = Math.max(0, (cluster.wallClock() - started) / 1000);
        const rps = behavior?.requestsPerSecond ?? 10;
        out.push({ name: 'http_requests_total', labels: { code: '200' }, value: Math.floor(seconds * rps) });
        const errorRate = behavior?.errorRatio ?? 0;
        out.push({
          name: 'http_requests_total', labels: { code: '500' },
          value: Math.floor(seconds * rps * errorRate),
        });

        const memory = behavior?.memoryUsage ? parseQuantity(behavior.memoryUsage) : undefined;
        if (memory !== undefined) {
          out.push({ name: 'container_memory_working_set_bytes', labels: {}, value: memory });
        }
        const limit = containers[0]?.resources?.limits?.memory;
        if (limit) {
          out.push({ name: 'container_spec_memory_limit_bytes', labels: {}, value: parseQuantity(limit) });
        }
        return out;
      },
    },
    /**
     * ESO 去密钥库取值。
     *
     * 认证走 SecretStore 里写的那种方式：`kubernetes` 用 ServiceAccount 换
     * 令牌（集群里该用的），`tokenSecretRef` 直接从一个 Secret 里读静态令牌
     * （常见但不好 —— 那把令牌本身又是一个要保管的密钥）。
     */
    fetchSecret: ({ store, namespace, key, property }) => {
      if (!bao) return { error: 'no secret store configured in this world' };
      const provider = ((store.spec ?? {}) as any).provider?.vault ?? {};
      if (provider.server && provider.server !== bao.address) {
        return { error: `cannot connect to ${provider.server}: no such host` };
      }
      const auth = provider.auth ?? {};
      let token: string | undefined;
      if (auth.kubernetes) {
        const serviceAccount = auth.kubernetes.serviceAccountRef?.name ?? 'default';
        const login = bao.loginKubernetes(auth.kubernetes.role ?? '', `${namespace}/${serviceAccount}`);
        if ('error' in login) return { error: login.error };
        token = login.token;
      } else if (auth.tokenSecretRef) {
        const definition = cluster.scheme.get({ group: '', version: 'v1', resource: 'secrets' });
        const holder = definition && cluster.registry.list(definition, { namespace }).items
          .find((item) => item.metadata.name === auth.tokenSecretRef.name);
        const encoded = ((holder ?? {}) as any).data?.[auth.tokenSecretRef.key ?? 'token'];
        token = encoded ? atob(encoded) : undefined;
        if (!token) return { error: `token secret "${auth.tokenSecretRef.name}" not found or empty` };
      } else {
        return { error: 'no auth method configured on the SecretStore' };
      }

      const mount = provider.path ? `${provider.path}/` : '';
      const full = `${mount}${key}`;
      if (!bao.allows(token, full, 'read')) {
        return { error: `permission denied on ${full}` };
      }
      const data = bao.read(full);
      if (!data) return { error: `no value found at ${full}` };
      if (property) {
        if (data[property] === undefined) return { error: `key "${property}" not found at ${full}` };
        return { value: data[property] };
      }
      return { value: JSON.stringify(data) };
    },
    /**
     * Argo CD 从这里取仓库内容。
     *
     * 取的是**远端**而不是跳板机上那个克隆 —— GitOps 的期望状态住在
     * 远端仓库里，学员在本地改了不 push，集群就不该看见。
     */
    gitSubscribe: (listener) => git.onPush(() => listener()),
    gitSource: (url, revision) => {
      const bare = git.get(url);
      if (!bare) return { error: `repository not accessible: ${url}` };
      const branch = !revision || revision === 'HEAD' ? bare.head : revision;
      const head = bare.refs[branch];
      if (!head) return { error: `Unable to resolve '${revision}' to a commit SHA` };
      const commit = bare.objects.get(head);
      if (!commit || commit.type !== 'commit') return { error: `object not found: ${head}` };
      return { revision: head, files: readTree(bare.objects, parseCommit(commit.body).tree) };
    },
    /**
     * 跳板机信任哪些根。
     *
     * 读的是机器上那个文件，所以「把内网 CA 装进信任库」是一个学员做得到、
     * 也看得见的动作，而不是宿主替他决定的。
     */
    trustBundle: () => {
      const path = '/etc/ssl/certs/ca-certificates.crt';
      if (!machine.vfs.exists(path)) return [];
      try {
        return parseChain(machine.vfs.readFile(path));
      } catch {
        return [];
      }
    },
  });

  const machineSpec = spec.machine ?? {};
  const machine = createMachine({
    hostname: machineSpec.hostname ?? 'jump-01',
    user: machineSpec.user ?? 'root',
    cwd: machineSpec.cwd ?? '/root',
    files: { ...(machineSpec.files ?? {}), ...(stage.files ?? {}) },
    now: () => cluster.wallClock(),
  });

  const images = new ImageStore();

  // 内网的 Git 服务。关卡声明里那些仓库在世界起来之前就该在了。
  const git = new GitNetwork();
  for (const repository of spec.gitRepositories ?? []) {
    const bare = git.create(repository.url, {
      head: repository.branch ?? 'main',
      readOnly: repository.readOnly,
    });
    if (repository.files) {
      seedRepository(bare, repository.files, {
        message: repository.message ?? 'initial commit',
        // 仓库是「本来就在」的东西，提交时间按集群年龄之前算
        timestamp: cluster.wallClock() - DEFAULT_OBJECT_AGE_MS,
      });
    }
  }

  const registries = new RegistryNetwork();
  for (const registry of spec.registries ?? []) {
    registries.add(new ImageRegistry({
      host: registry.host,
      users: registry.users,
      projects: registry.projects,
      anonymousPull: registry.anonymousPull,
    }));
  }
  // 基础镜像：本地就有，FROM 得着，各自带着自己的工具链
  const toolchains: Record<string, Record<string, CommandHandler>> = {};
  for (const [reference, toolchain] of Object.entries(spec.baseImages ?? {})) {
    images.add(baseImageOf(reference, toolchain, new Date(cluster.wallClock()).toISOString()));
    toolchains[normalizeReference(reference)] = toolchainFor(toolchain);
  }

  // 网络工具。跳板机在办公网，够不到 Pod 网段与 ClusterIP —— 这是分区的意义。
  for (const [name, handler] of Object.entries(createNetTools({
    network: cluster.network,
    source: () => ({ zone: 'office', label: machineSpec.hostname ?? 'jump-01', ip: '10.10.1.5' }),
    advance: (ms) => { void cluster.advanceBy(ms); },
  }))) {
    machine.install(name, handler);
  }

  machine.install('openssl', createOpensslCommand());

  if (bao) {
    machine.install('bao', createBaoCommand({
      server: (address) => (address.replace(/\/+$/, '') === bao.address ? bao : undefined),
    }));
  }

  machine.install('promtool', createPromtoolCommand({
    tsdb: (address) => (PROMETHEUS_ADDRESSES.includes(address.replace(/\/+$/, ''))
      ? cluster.prometheus?.tsdb
      : undefined),
    now: () => cluster.wallClock(),
  }));

  machine.install('cosign', createCosignCommand({
    signatures,
    /**
     * 签之前先确认这个镜像存在。
     *
     * 三个来源：本地构建出来的、关卡声明过的、以及推到内网仓库里的。
     * 不存在的镜像 cosign 会直接报错 —— 不然「签了但签的是个不存在的东西」
     * 会一路混到准入那一层才炸。
     */
    hasImage: (image) => {
      if (images.get(image)) return true;
      if (declaredImages.has(normalizeReference(image))) return true;
      const parsed = parseReference(image);
      return Boolean(parsed && registries.has(parsed.registry));
    },
  }));

  machine.install('istioctl', createIstioctlCommand({
    view: () => cluster.istioView(),
    namespace: () => (machine.vfs.exists(DEFAULT_KUBECONFIG_PATH)
      ? currentNamespaceOf(machine.vfs.readFile(DEFAULT_KUBECONFIG_PATH))
      : 'default'),
  }));

  machine.install('git', createGitCommand({
    network: git,
    now: () => cluster.wallClock(),
    identity: spec.machine?.gitIdentity ?? { name: 'ops', email: 'ops@corp.internal' },
    // 名字解析不到的远端，表现和真的 DNS 失败一样
    resolves: (host) => Boolean(externalHosts[host]),
  }));

  machine.install('docker', createDockerCommand({
    store: images,
    network: registries,
    toolchains,
    now: () => cluster.wallClock(),
  }));

  /**
   * 学员自己 build + push 上去的镜像也要能部署。
   *
   * 行为从镜像自己的配置里推：EXPOSE 的端口就是它监听的端口，USER 就是它跑的
   * 身份。这样第 3 关写的 Dockerfile 会直接影响第 6 关探针配得对不对 ——
   * 两关之间的因果是真的，不是题面上说说。
   */
  lookupPushedImage = (image: string) => {
    const local = images.get(image);
    if (local) return behaviorOfImage(local);
    try {
      const parsed = parseReference(image);
      if (!registries.has(parsed.registry)) return undefined;
      return behaviorOfImage(registries.resolve(parsed.registry).pull(image));
    } catch {
      return undefined;
    }
  };

  // `kubectl exec` 落到 Pod 里那个 shell 上
  cluster.execHandler = createExecHandler(cluster);

  // 镜像解析装好之后才让控制器跑起来，免得先起来的 kubelet 查到一张空表
  cluster.start();

  const applets = options.runtime
    ? await installClusterCli({
      machine,
      runtime: options.runtime,
      apiServer: cluster.apiServer,
      // CLI 在轮询的时候世界也该往前走，否则 kubectl wait / drain 永远等不到
      advance: (ms) => cluster.advanceBy(ms),
      endpoints: spec.endpoints,
      now: () => cluster.wallClock(),
    })
    : [];

  /**
   * 内网 PKI。
   *
   * 在别的初态对象之前铺：Gateway 的 listener、cert-manager 的 issuer
   * 都可能引用这些 Secret。
   */
  const pki = materializePki(spec.pki, cluster.wallClock());
  if (pki.trustBundle) {
    machine.vfs.writeFile('/etc/ssl/certs/ca-certificates.crt', pki.trustBundle);
  }
  cluster.seedExisting(DEFAULT_OBJECT_AGE_MS, () => {
    for (const secret of pki.secrets) applyObject(cluster, secret);
  });

  // 世界的初态：项目级对象在前，关卡增量在后。它们是「本来就在」的东西，
  // 所以按 6 小时前建出来算，AGE 列才不会全是 0s。
  cluster.seedExisting(DEFAULT_OBJECT_AGE_MS, () => {
    for (const object of [...(spec.objects ?? []), ...(stage.objects ?? [])]) {
      applyObject(cluster, object as KubeObject);
    }
  });
  await cluster.settle();

  const world: OpsWorld = {
    cluster,
    machine,
    images,
    registries,
    git,
    signatures,
    bao,
    applets,
    now: () => cluster.wallClock(),
    async run(command: string) {
      const result = await machine.exec(command);
      // 命令跑完让控制器把该做的做完 —— 现实里时间也在走
      await cluster.settle({ maxVirtualMs: 10 * 60_000 });
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    },
  };

  // 布置现场：这些命令是「上一关留下的样子」，不算学员做的
  for (const command of stage.setupCommands ?? []) await world.run(command);

  return world;
}

function mergeImages(
  base?: Record<string, OpsImageSpec>,
  extra?: Record<string, OpsImageSpec>
): Record<string, OpsImageSpec> {
  return { ...(base ?? {}), ...(extra ?? {}) };
}

/**
 * 往集群里塞一个对象。
 *
 * 走 registry 而不是直接写 store：默认值、uid、resourceVersion 这些
 * 都该按真规矩生成，否则初态和 apply 出来的对象长得不一样。
 */
function applyObject(cluster: Cluster, object: KubeObject): void {
  const [group, version] = splitApiVersion(object.apiVersion);
  const definition = cluster.scheme.resolveKind(group, version, object.kind);
  if (!definition) {
    throw new Error(`world 里有一个未注册的类型：${object.apiVersion} ${object.kind}`);
  }
  const namespace = definition.namespaced
    ? object.metadata?.namespace ?? 'default'
    : undefined;
  cluster.registry.create(definition, namespace, object);
}

function splitApiVersion(apiVersion: string): [string, string] {
  const index = apiVersion.indexOf('/');
  return index < 0 ? ['', apiVersion] : [apiVersion.slice(0, index), apiVersion.slice(index + 1)];
}


/** 从镜像自己的配置推出它的运行时行为 */
function behaviorOfImage(image: Image): OpsImageSpec & ImageBehavior {
  const ports = Object.keys(image.config.ExposedPorts ?? {})
    .map((entry) => Number(entry.split('/')[0]))
    .filter((port) => Number.isFinite(port));
  const user = image.config.User ?? '';
  return {
    pullMs: 400,
    startupMs: 600,
    readyAfterMs: 300,
    listens: ports.length ? ports : [8080],
    // 没别的信息时假定它是个正常的 HTTP 服务
    routes: { '/': 200, '/healthz': 200, '/readyz': 200 },
    runAsUser: /^\d+$/.test(user) ? Number(user) : 0,
  };
}
