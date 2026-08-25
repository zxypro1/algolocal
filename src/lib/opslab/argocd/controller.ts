/**
 * Argo CD 的 application controller
 *
 * 它做的事只有一件：把「仓库里那份 YAML」和「集群里的现状」比一比，
 * 然后按 syncPolicy 决定要不要动手。
 *
 * 三条最容易被误解的规则，这里都照真的实现：
 *  1. **OutOfSync 不等于坏了**。它只说明现状和仓库不一致，服务可能好好的。
 *     健康与否是另一个维度（`status.health`）。
 *  2. **没有 automated 就不会自己动**。它只把差异报出来，等人来 sync。
 *  3. **selfHeal 才会把手改改回去**。只开 automated 不开 selfHeal 的话，
 *     `kubectl edit` 改的东西会一直留着，直到仓库那边有新提交。
 *
 * 控制器自己是集群里的一个工作负载：Deployment 停了，同步就停了 ——
 * 和 Envoy Gateway、cert-manager 一样。
 */
import type { KubeObject, ResourceDefinition } from '../apiserver';
import {
  Controller, ControllerContext, Informer, isNotFound, objectKey, splitKey,
} from '../controllers/framework';
import { DEPLOYMENTS } from '../controllers/resources';
import { ignoreConflict, updateStatusIfChanged } from '../controllers/workloads';
import { parseYamlAll } from '../yaml';
import { APPLICATIONS, ARGOCD_LABEL, TRACKING_LABEL } from './resources';

/** 仓库在某个版本上的样子 */
export interface RepoSnapshot {
  revision: string;
  files: Record<string, string>;
}

export type RepoResolver = (url: string, revision: string) => RepoSnapshot | { error: string };

export interface ArgoCdOptions {
  /** 去哪儿取仓库内容。由世界注入 —— 集群自己不认识 Git。 */
  source: RepoResolver;
  /**
   * 仓库有新提交时叫一声。
   *
   * 这是 webhook。没有它就只能等轮询 —— 真集群里「push 完过了两分钟才生效」
   * 通常就是 webhook 没配。
   */
  subscribe?(listener: () => void): void;
}

/** Argo CD 默认的轮询间隔 */
export const POLL_INTERVAL_MS = 180_000;

interface Managed {
  definition: ResourceDefinition;
  namespace?: string;
  object: KubeObject;
}

interface ResourceStatus {
  group: string;
  version: string;
  kind: string;
  namespace?: string;
  name: string;
  status: string;
  health: string;
}

export class ArgoCdController extends Controller {
  private applications: Informer;
  private deployments: Informer;

  constructor(context: ControllerContext, private readonly options: ArgoCdOptions) {
    super(context, 'argocd-application-controller');
    this.applications = new Informer(this.registry, APPLICATIONS);
    this.deployments = this.track(new Informer(this.registry, DEPLOYMENTS));
    this.watch(this.applications);
    // 被管的工作负载变了，健康状态要跟着变
    this.deployments.onChange(() => this.enqueueAll());
    // webhook：仓库一有新提交就重新比对
    options.subscribe?.(() => this.enqueueAll());
    /**
     * 兜底轮询。
     *
     * 标成 background —— 它「永远有下一次」，算成前台的话世界就再也静不下来了。
     * 想看到轮询生效，把虚拟时钟往前推（advanceBy）就行，和真集群里等三分钟一样。
     */
    this.poll = this.kernel.setInterval(() => this.enqueueAll(), POLL_INTERVAL_MS, {
      background: true,
      label: 'argocd:poll',
    });
  }

  private poll: number;
  private stopped = false;

  stop(): void {
    // webhook 的订阅摘不掉（GitNetwork 只管发），所以这里立个旗子；
    // 轮询的定时器要显式清掉，不然换一个集群起来还有上一个在敲门
    this.stopped = true;
    this.kernel.clearTimer(this.poll);
    super.stop();
  }

  private enqueueAll(): void {
    if (this.stopped) return;
    for (const application of this.applications.list()) this.enqueue(objectKey(application));
  }

  /** 控制器在不在。这是「组件是工作负载」这条约束的兑现处。 */
  private installed(): boolean {
    return this.deployments.list().some((deployment) => {
      if (deployment.metadata.labels?.[ARGOCD_LABEL.key] !== ARGOCD_LABEL.value) return false;
      return (((deployment.status ?? {}) as { availableReplicas?: number }).availableReplicas ?? 0) > 0;
    });
  }

  protected async reconcile(key: string): Promise<void> {
    if (!this.installed()) return;
    const { namespace, name } = splitKey(key);
    let application: KubeObject;
    try {
      application = this.registry.get(APPLICATIONS, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (application.metadata.deletionTimestamp) return;

    const spec = (application.spec ?? {}) as any;
    const source = spec.source ?? {};
    const snapshot = this.options.source(source.repoURL ?? '', source.targetRevision ?? 'HEAD');
    if ('error' in snapshot) {
      await this.writeStatus(application, {
        sync: { status: 'Unknown' },
        health: { status: 'Unknown' },
        conditions: [{ type: 'ComparisonError', message: snapshot.error }],
      });
      return;
    }

    const desired = this.desiredObjects(snapshot, source.path ?? '', spec.destination ?? {});
    if ('error' in desired) {
      await this.writeStatus(application, {
        sync: { status: 'Unknown', revision: snapshot.revision },
        health: { status: 'Unknown' },
        conditions: [{ type: 'ComparisonError', message: desired.error }],
      });
      return;
    }

    const automated = spec.syncPolicy?.automated;
    // `operation` 是手动 sync 的入口 —— argocd CLI 写进去的就是这个字段
    const requested = Boolean((application as any).operation?.sync);

    if (automated || requested) {
      this.apply(desired.objects, {
        instance: application.metadata.name!,
        // 手动 sync 一定会把现状拉回仓库；自动同步要开了 selfHeal 才会
        selfHeal: Boolean(automated?.selfHeal) || requested,
      });
      if (automated?.prune || requested) {
        this.prune(application, desired.objects, previousKinds(application));
      }
    }

    const resources = desired.objects.map((managed) => this.statusOf(managed));
    const outOfSync = resources.some((entry) => entry.status !== 'Synced');
    await this.writeStatus(application, {
      sync: { status: outOfSync ? 'OutOfSync' : 'Synced', revision: snapshot.revision },
      health: { status: healthOf(resources) },
      resources,
      // 上一次同步的结果要留着 —— `argocd app history` 看的就是它，
      // 每次比对都把它抹掉的话，「上次是什么时候同步的」就永远查不到
      operationState: (requested || automated)
        ? {
            phase: 'Succeeded',
            finishedAt: new Date(this.context.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
            syncResult: { revision: snapshot.revision },
          }
        : (application.status as { operationState?: unknown } | undefined)?.operationState,
    });

    // 手动 sync 做完就把 operation 摘掉，和真 Argo 一样
    if (requested) {
      await ignoreConflict(() => {
        const latest = this.registry.get(APPLICATIONS, namespace, name) as Record<string, unknown>;
        if (!latest.operation) return;
        const next = { ...latest };
        delete next.operation;
        this.registry.update(APPLICATIONS, namespace, name, next as KubeObject);
      });
    }
  }

  /** 仓库里那一路径下的 manifest 变成对象 */
  private desiredObjects(
    snapshot: RepoSnapshot,
    path: string,
    destination: { namespace?: string }
  ): { objects: Managed[] } | { error: string } {
    const prefix = path === '' || path === '.' ? '' : `${path.replace(/\/$/, '')}/`;
    const matched = Object.entries(snapshot.files)
      .filter(([file]) => file.startsWith(prefix) && /\.ya?ml$/.test(file))
      .sort(([a], [b]) => (a < b ? -1 : 1));
    if (matched.length === 0) {
      return { error: `app path does not exist: ${path || '.'}` };
    }

    const objects: Managed[] = [];
    for (const [file, content] of matched) {
      let documents: unknown[];
      try {
        documents = parseYamlAll(content);
      } catch (error) {
        return { error: `Failed to load target state: ${file}: ${(error as Error).message}` };
      }
      for (const document of documents) {
        const object = document as KubeObject;
        if (!object?.apiVersion || !object.kind) continue;
        const [group, version] = splitApiVersion(object.apiVersion);
        const definition = this.context.scheme.resolveKind(group, version, object.kind);
        if (!definition) {
          return {
            error: `Failed to load target state: ${object.apiVersion}/${object.kind} `
              + 'is not registered in the cluster',
          };
        }
        const namespace = definition.namespaced
          ? object.metadata?.namespace ?? destination.namespace ?? 'default'
          : undefined;
        objects.push({ definition, namespace, object });
      }
    }
    return { objects };
  }

  private apply(objects: Managed[], options: { instance: string; selfHeal: boolean }): void {
    for (const managed of objects) {
      const { definition, namespace, object } = managed;
      const name = object.metadata?.name;
      if (!name) continue;

      let live: KubeObject | undefined;
      try {
        live = this.registry.get(definition, namespace, name);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }

      if (!live) {
        this.registry.create(definition, namespace, tracked(object, namespace, options.instance));
        continue;
      }

      /**
       * 每次同步都要落一次 tracking 标签，不只是建对象的时候。
       *
       * 这条决定了「接管」能不能发生：一个本来手工建出来的对象，被
       * Application 纳入之后要打上标签，prune 才认得它是自己的地盘。
       * 只在 create 时打的话，那些先有后管的对象永远删不掉。
       */
      const adopting = live.metadata.labels?.[TRACKING_LABEL] !== options.instance;
      const drifted = !matchesDesired(object.spec, live.spec);
      if (!adopting && !(options.selfHeal && drifted)) continue;

      this.registry.update(definition, namespace, name, {
        ...live,
        metadata: {
          ...live.metadata,
          labels: {
            ...live.metadata.labels,
            ...(options.selfHeal ? object.metadata?.labels : {}),
            [TRACKING_LABEL]: options.instance,
          },
        },
        // selfHeal：把现状拉回仓库的样子。手改的东西就是在这里被改回去的。
        // 合并而不是整体替换 —— 服务端补上的字段（ClusterIP 之类）不能被抹掉。
        spec: options.selfHeal && drifted ? mergeDesired(live.spec, object.spec) : live.spec,
      });
    }
  }

  /**
   * 仓库里删掉的对象，集群里也删掉。
   *
   * 只删自己建的（带 tracking 标签的），不然一个 Application 会把
   * 别人的东西也收走 —— 真 Argo 用同样的方式圈定自己的地盘。
   */
  private prune(application: KubeObject, objects: Managed[], previous: Set<string>): void {
    const wanted = new Set(objects.map((managed) =>
      `${managed.definition.resource}/${managed.namespace ?? ''}/${managed.object.metadata?.name}`));
    const instance = application.metadata.name;

    /**
     * 只扫这个 Application 碰过的资源类型。
     *
     * 「上一轮 status 里出现过的」加上「这一轮仓库里有的」——
     * 一个 kind 从仓库里整个消失时，它还在上一轮的 status 里，所以扫得到。
     * 不这么收窄的话每次同步都要把全集群所有类型 list 一遍。
     */
    const kinds = new Set([...previous, ...objects.map((managed) => managed.definition.resource)]);

    for (const definition of this.context.scheme.list()) {
      if (definition.resource === 'applications') continue;
      if (!kinds.has(definition.resource)) continue;
      let live: KubeObject[];
      try {
        live = this.registry.list(definition).items;
      } catch {
        continue;
      }
      for (const object of live) {
        if (object.metadata.labels?.[TRACKING_LABEL] !== instance) continue;
        const key = `${definition.resource}/${object.metadata.namespace ?? ''}/${object.metadata.name}`;
        if (wanted.has(key)) continue;
        try {
          this.registry.delete(definition, object.metadata.namespace, object.metadata.name);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
    }
  }

  private statusOf(managed: Managed): ResourceStatus {
    const { definition, namespace, object } = managed;
    const name = object.metadata?.name ?? '';
    const base = {
      group: definition.group, version: definition.version, kind: definition.kind,
      namespace, name,
    };
    let live: KubeObject;
    try {
      live = this.registry.get(definition, namespace, name);
    } catch {
      return { ...base, status: 'OutOfSync', health: 'Missing' };
    }
    const same = matchesDesired(object.spec, live.spec);
    return { ...base, status: same ? 'Synced' : 'OutOfSync', health: healthOfObject(definition, live) };
  }

  private async writeStatus(application: KubeObject, status: Record<string, unknown>): Promise<void> {
    await ignoreConflict(() => {
      updateStatusIfChanged(
        this.registry, APPLICATIONS,
        application.metadata.namespace, application.metadata.name!,
        status
      );
    });
  }
}

/* ------------------------------------------------------------------ */

/**
 * 仓库里写了的字段，集群里是不是就是那样。
 *
 * 只比对**仓库写了的**那些字段。服务端自己补上的东西（Service 的
 * ClusterIP、各种默认值）不算漂移 —— 否则每个对象一建出来就是 OutOfSync，
 * 这一栏就再也没有信息量了。真 Argo CD 做的是同一件事，
 * 只是它靠 last-applied 注解来判断哪些字段归自己管。
 *
 * 代价：仓库里**删掉**一个字段不会被认出来。真 Argo 靠 last-applied 能认，
 * 我们这里认不出。
 */
export function matchesDesired(desired: unknown, live: unknown): boolean {
  if (desired === null || desired === undefined) return true;
  if (Array.isArray(desired)) {
    if (!Array.isArray(live) || live.length !== desired.length) return false;
    return desired.every((item, index) => matchesDesired(item, live[index]));
  }
  if (typeof desired === 'object') {
    if (typeof live !== 'object' || live === null || Array.isArray(live)) return false;
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) => matchesDesired(value, (live as Record<string, unknown>)[key])
    );
  }
  return desired === live;
}

/** 把仓库写了的字段盖到现状上，其余保留 */
function mergeDesired(live: unknown, desired: unknown): unknown {
  if (desired === null || desired === undefined) return live;
  if (Array.isArray(desired)) return desired;
  if (typeof desired !== 'object') return desired;
  if (typeof live !== 'object' || live === null || Array.isArray(live)) return desired;
  const out: Record<string, unknown> = { ...(live as Record<string, unknown>) };
  for (const [key, value] of Object.entries(desired as Record<string, unknown>)) {
    out[key] = mergeDesired((live as Record<string, unknown>)[key], value);
  }
  return out;
}

/** 上一轮同步管过哪些资源类型 —— 从 status.resources 里读回来 */
function previousKinds(application: KubeObject): Set<string> {
  const resources = ((application.status ?? {}) as { resources?: Array<{ kind?: string }> }).resources ?? [];
  // status 里记的是 kind，prune 要按 resource 复数名对；两边都收着，
  // 命中判断用 resource，多一个 kind 不影响正确性
  return new Set(resources.map((entry) => pluralOf(entry.kind ?? '')));
}

/** Kind -> resource 的粗略复数化。只用于收窄扫描范围，判错了顶多多扫一类。 */
function pluralOf(kind: string): string {
  const lower = kind.toLowerCase();
  if (lower.endsWith('s')) return `${lower}es`;
  if (lower.endsWith('y')) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

function tracked(object: KubeObject, namespace: string | undefined, instance: string): KubeObject {
  return {
    ...object,
    metadata: {
      ...object.metadata,
      namespace: namespace ?? object.metadata?.namespace,
      labels: { ...(object.metadata?.labels ?? {}), [TRACKING_LABEL]: instance },
    },
  };
}

/** 一个 Application 的健康度取最差的那一个 */
function healthOf(resources: ResourceStatus[]): string {
  if (resources.some((entry) => entry.health === 'Missing')) return 'Missing';
  if (resources.some((entry) => entry.health === 'Degraded')) return 'Degraded';
  if (resources.some((entry) => entry.health === 'Progressing')) return 'Progressing';
  return 'Healthy';
}

function healthOfObject(definition: ResourceDefinition, live: KubeObject): string {
  if (definition.resource !== 'deployments') return 'Healthy';
  const spec = (live.spec ?? {}) as { replicas?: number };
  const status = (live.status ?? {}) as { availableReplicas?: number };
  return (status.availableReplicas ?? 0) >= (spec.replicas ?? 1) ? 'Healthy' : 'Progressing';
}

function splitApiVersion(apiVersion: string): [string, string] {
  const index = apiVersion.indexOf('/');
  return index < 0 ? ['', apiVersion] : [apiVersion.slice(0, index), apiVersion.slice(index + 1)];
}
