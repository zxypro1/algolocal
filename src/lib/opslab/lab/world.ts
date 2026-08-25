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

  // 先声明，下面 createCluster 要用；仓库对象在它之后才建得出来
  let lookupPushedImage: (image: string) => ReturnType<typeof behaviorOfImage> | undefined = () => undefined;

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
    externalHosts: {
      // 私有仓库这些内网服务，办公网与集群都该解析得到
      ...Object.fromEntries((spec.registries ?? []).map((registry, index) => [
        registry.host, [`10.10.0.${20 + index}`],
      ])),
      ...(spec.externalHosts ?? {}),
    },
    addressPools: spec.addressPools,
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

  // 镜像解析装好之后才让控制器跑起来，免得先起来的 kubelet 查到一张空表
  cluster.start();

  const applets = options.runtime
    ? await installClusterCli({
      machine,
      runtime: options.runtime,
      apiServer: cluster.apiServer,
      endpoints: spec.endpoints,
      now: () => cluster.wallClock(),
    })
    : [];

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
