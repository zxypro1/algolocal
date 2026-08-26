/**
 * GVK / GVR 注册表
 *
 * apiserver 靠它回答三类问题：
 *  - discovery：`/api`、`/apis`、`/api/v1` 里该列出什么（kubectl 启动时先问这个，
 *    `po` 能解析成 `pods` 也是靠它）；
 *  - 路由：一个 URL 对应哪个资源、是不是带命名空间；
 *  - 存储：对象在 etcd 里落到哪个键。
 */
import { badRequest } from './errors';

export interface ResourceDefinition {
  /** 组名。核心组是空串 */
  group: string;
  version: string;
  /** 复数小写，URL 里那个，如 `pods` */
  resource: string;
  /** 单数小写，如 `pod` */
  singular: string;
  kind: string;
  namespaced: boolean;
  shortNames?: string[];
  /** `kubectl api-resources --categories=all` 用 */
  categories?: string[];
  verbs?: string[];
  /** 有哪些子资源，如 status / scale */
  subresources?: string[];
  /**
   * OpenAPI v3 的 schema。
   *
   * 不填就用一份宽松的（结构对、字段不限），够 kubectl 通过客户端校验。
   * 要考「字段写错被拒」的关卡自己挂一份严格的上来。
   */
  schema?: Record<string, unknown>;
}

const DEFAULT_VERBS = [
  'create', 'delete', 'deletecollection', 'get', 'list', 'patch', 'update', 'watch',
];

export interface GVR {
  group: string;
  version: string;
  resource: string;
}

export class Scheme {
  private byKey = new Map<string, ResourceDefinition>();

  register(definition: ResourceDefinition): void {
    const complete: ResourceDefinition = {
      verbs: DEFAULT_VERBS,
      shortNames: [],
      categories: [],
      subresources: [],
      ...definition,
    };
    this.byKey.set(this.key(complete), complete);
  }

  /**
   * 注销一个类型。CRD 被删掉时用。
   *
   * 真集群里删 CRD 会连带删掉这个类型的**所有对象**，而且这一步不可逆 ——
   * 删错一个 CRD 和删错一个命名空间是同一个量级的事故。
   */
  unregister(definition: { group: string; version: string; resource: string }): boolean {
    return this.byKey.delete(this.key(definition as ResourceDefinition));
  }

  registerAll(definitions: ResourceDefinition[]): void {
    for (const definition of definitions) this.register(definition);
  }

  private key(gvr: GVR): string {
    return `${gvr.group}/${gvr.version}/${gvr.resource}`;
  }

  get(gvr: GVR): ResourceDefinition | undefined {
    return this.byKey.get(this.key(gvr));
  }

  /** 找不到就抛 —— 调用方几乎总是想要这个行为 */
  mustGet(gvr: GVR): ResourceDefinition {
    const definition = this.get(gvr);
    if (!definition) {
      throw badRequest(`the server could not find the requested resource (${this.key(gvr)})`);
    }
    return definition;
  }

  /**
   * 按用户敲的名字找资源：复数、单数、简称、带组的全名都认。
   *
   * `kubectl get po` / `get pod` / `get pods` / `get pods.apps` 都要能落到同一个资源上。
   * 返回**排序稳定**的第一个匹配 —— 多个组里有同名资源时，核心组优先，
   * 其余按组名字典序，免得同一条命令在不同次运行里解析到不同资源。
   */
  /** 按 group/version/kind 找 —— 从 manifest（有 apiVersion + kind）反查资源时用 */
  resolveKind(group: string, version: string, kind: string): ResourceDefinition | undefined {
    for (const definition of this.list()) {
      if (definition.group === group && definition.version === version && definition.kind === kind) {
        return definition;
      }
    }
    return undefined;
  }

  resolve(name: string): ResourceDefinition | undefined {
    const lower = name.toLowerCase();
    const [head, ...groupParts] = lower.split('.');
    const wantedGroup = groupParts.length > 0 ? groupParts.join('.') : undefined;

    const candidates = this.list()
      .filter((definition) => {
        if (wantedGroup !== undefined && definition.group !== wantedGroup) return false;
        return (
          definition.resource === head ||
          definition.singular === head ||
          (definition.shortNames ?? []).includes(head)
        );
      })
      .sort((a, b) => {
        // 核心组（空串）排最前，其余按组名再按资源名
        if (a.group !== b.group) return a.group < b.group ? -1 : 1;
        return a.resource < b.resource ? -1 : 1;
      });

    return candidates[0];
  }

  /** 全部资源定义，按 (组, 版本, 资源) 稳定排序 */
  list(): ResourceDefinition[] {
    return [...this.byKey.values()].sort((a, b) => {
      if (a.group !== b.group) return a.group < b.group ? -1 : 1;
      if (a.version !== b.version) return a.version < b.version ? -1 : 1;
      return a.resource < b.resource ? -1 : 1;
    });
  }

  /** 某个 group/version 下的资源 */
  listGroupVersion(group: string, version: string): ResourceDefinition[] {
    return this.list().filter((d) => d.group === group && d.version === version);
  }

  /** 有哪些 groupVersion，稳定排序。核心组的 `v1` 排最前。 */
  groupVersions(): string[] {
    const seen = new Set<string>();
    for (const definition of this.list()) {
      seen.add(definition.group ? `${definition.group}/${definition.version}` : definition.version);
    }
    return [...seen].sort((a, b) => {
      const aCore = !a.includes('/');
      const bCore = !b.includes('/');
      if (aCore !== bCore) return aCore ? -1 : 1;
      return a < b ? -1 : 1;
    });
  }

  /** `apps/v1` -> { group: 'apps', version: 'v1' }；`v1` -> { group: '', version: 'v1' } */
  static parseApiVersion(apiVersion: string): { group: string; version: string } {
    const index = apiVersion.indexOf('/');
    if (index < 0) return { group: '', version: apiVersion };
    return { group: apiVersion.slice(0, index), version: apiVersion.slice(index + 1) };
  }

  static toApiVersion(group: string, version: string): string {
    return group ? `${group}/${version}` : version;
  }
}

/**
 * 对象在存储里的键。
 *
 * 形状照抄 k8s：`/registry/<resource>/<namespace>/<name>`，
 * 集群级资源没有命名空间那一段。前缀读因此天然支持「某个命名空间下的全部」。
 */
export function storageKey(definition: ResourceDefinition, namespace: string | undefined, name: string): string {
  return definition.namespaced
    ? `/registry/${definition.resource}/${namespace}/${name}`
    : `/registry/${definition.resource}/${name}`;
}

/** 某个资源（可选某个命名空间）的键前缀 */
export function storagePrefix(definition: ResourceDefinition, namespace?: string): string {
  if (!definition.namespaced) return `/registry/${definition.resource}/`;
  return namespace
    ? `/registry/${definition.resource}/${namespace}/`
    : `/registry/${definition.resource}/`;
}

export function createScheme(definitions: ResourceDefinition[] = []): Scheme {
  const scheme = new Scheme();
  scheme.registerAll(definitions);
  return scheme;
}
