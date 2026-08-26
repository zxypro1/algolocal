/**
 * `@ops/lab` —— ops 关卡的隐藏用例能拿到的东西
 *
 * 判定的三个证据来源都在这里：
 *  1. **终态** —— `get` / `list` / `events` 读收敛之后的对象图；
 *  2. **行为探测** —— `sh` / `kubectl` 由平台自己跑，学员改不了；
 *  3. **过程** —— `transcript` 是学员敲过的每一条命令。
 *
 * 判定读的世界和工作台是同一个 —— 不存在「判定时另起一个干净集群」，
 * 那样学员在终端里做的事就白做了。
 */
import type { KubeObject } from '../apiserver';
import type { CommandRecord } from '../../labkit/machine';
import type { Image } from '../oci';
import { imageRootfs } from '../oci';
import type { OpsWorld } from './world';

export interface OpsLabApi {
  /** 敲一条命令（平台身份），跑完等世界收敛 */
  sh(command: string): Promise<{ stdout: string; stderr: string; code: number }>;
  /** `kubectl(...)` 就是 `sh('kubectl ' + ...)`，只是少写几个字 */
  kubectl(args: string): Promise<{ stdout: string; stderr: string; code: number }>;

  /** 按 kind 取一个对象；没有就返回 undefined，而不是抛 */
  get(kind: string, name: string, namespace?: string): KubeObject | undefined;
  /** 按 kind 列对象，可按命名空间与标签过滤 */
  list(kind: string, options?: { namespace?: string; labels?: Record<string, string> }): KubeObject[];
  /** 集群事件，按发生顺序 */
  events(namespace?: string): KubeObject[];

  /** 学员敲过的每一条命令 */
  transcript(): CommandRecord[];

  /** 机器磁盘 */
  readFile(path: string): string | undefined;
  exists(path: string): boolean;

  /** 本地镜像库里的镜像；`layersOf` 能翻出历史层，查「密钥进没进镜像」 */
  image(reference: string): Image | undefined;
  imageFiles(reference: string): Record<string, string>;
  /** 所有层里出现过的文件内容，包括后来被删掉的 */
  layerContents(reference: string): string[];

  /** 把世界推到静止 */
  settle(): Promise<void>;
  /** 快进一段虚拟时间，用来看中间态 */
  advance(ms: number): Promise<void>;
  /** 虚拟墙钟（毫秒） */
  now(): number;

  /** 需要更底层的东西时的出口 */
  world: OpsWorld;
}

export function createOpsLabModules(world: OpsWorld): Record<string, unknown> {
  return { '@ops/lab': createOpsLabApi(world) };
}

export function createOpsLabApi(world: OpsWorld): OpsLabApi {
  const { cluster, machine } = world;

  const definitionOf = (kind: string) => {
    // 既认 `Deployment` 也认 `deployments` / `deploy`
    const byKind = cluster.scheme.list().find((item) => item.kind === kind);
    return byKind ?? cluster.scheme.resolve(kind);
  };

  const listOf = (kind: string, namespace?: string): KubeObject[] => {
    const definition = definitionOf(kind);
    if (!definition) return [];
    return cluster.registry.list(definition, {
      namespace: definition.namespaced ? namespace : undefined,
    }).items;
  };

  return {
    sh: (command) => world.run(command),
    kubectl: (args) => world.run(`kubectl ${args}`),

    get(kind, name, namespace) {
      const definition = definitionOf(kind);
      if (!definition) return undefined;
      try {
        return cluster.registry.get(
          definition,
          definition.namespaced ? namespace ?? 'default' : undefined,
          name
        );
      } catch {
        return undefined;
      }
    },

    list(kind, options = {}) {
      const items = listOf(kind, options.namespace);
      if (!options.labels) return items;
      return items.filter((item) =>
        Object.entries(options.labels!).every(
          ([key, value]) => item.metadata.labels?.[key] === value
        )
      );
    },

    events: (namespace) => listOf('Event', namespace),

    transcript: () => machine.transcript(),

    readFile: (path) => (machine.vfs.exists(path) ? machine.vfs.readFile(path) : undefined),
    exists: (path) => machine.vfs.exists(path),

    image: (reference) => world.images.get(reference),
    imageFiles(reference) {
      const image = world.images.get(reference);
      return image ? imageRootfs(image) : {};
    },
    layerContents(reference) {
      const image = world.images.get(reference);
      if (!image) return [];
      return image.layers.flatMap((layer) => Object.values(layer.files));
    },

    settle: () => cluster.settle(),
    advance: (ms) => cluster.advanceBy(ms),
    now: () => cluster.wallClock(),

    world,
  };
}
