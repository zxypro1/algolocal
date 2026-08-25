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
import { Machine, createMachine } from '../machine';
import {
  ImageStore, Registry as ImageRegistry, RegistryNetwork, createDockerCommand,
} from '../machine/oci';
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

export async function createOpsWorld(options: OpsWorldOptions = {}): Promise<OpsWorld> {
  const spec = options.world ?? {};
  const stage = options.stage ?? {};

  const cluster = createCluster({
    seed: spec.seed ?? 1,
    startTime: Date.parse(spec.startTime ?? DEFAULT_START),
    nodes: spec.nodes,
    namespaces: spec.namespaces,
    images: mergeImages(spec.images, stage.images),
  });
  cluster.start();

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
  machine.install('docker', createDockerCommand({
    store: images,
    network: registries,
    now: () => cluster.wallClock(),
  }));

  const applets = options.runtime
    ? await installClusterCli({
      machine,
      runtime: options.runtime,
      apiServer: cluster.apiServer,
      endpoints: spec.endpoints,
      now: () => cluster.wallClock(),
    })
    : [];

  // 世界的初态：项目级对象在前，关卡增量在后
  for (const object of [...(spec.objects ?? []), ...(stage.objects ?? [])]) {
    applyObject(cluster, object as KubeObject);
  }
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
