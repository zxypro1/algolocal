/**
 * 学员自己写的 Operator，跑在这个集群上
 *
 * 两种工作台在这里合流：控制器的逻辑是**代码**，而它读写的是**真的 apiserver**。
 * 这一层做的事只有一件 —— 把学员写的那个函数接到 watch 事件上，
 * 并给它一个够用的客户端。
 *
 * 有三件事是刻意不替学员做的，因为它们正是这一关要教的：
 *
 *   1. 属主引用要自己挂。不挂的话删掉自定义资源，造出来的东西全变成孤儿。
 *   2. 要 watch 自己造出来的那些类型。不 watch 的话别人改坏了你不知道，
 *      「声明式」就退化成「创建时做一次」。
 *   3. status 要自己写，而且只在变了的时候写。每次都写一个新时间戳的话，
 *      写回去又触发一次 reconcile，世界永远静不下来。
 */
import type { KubeObject, ResourceDefinition } from '../apiserver';
import { createModuleRuntime } from '../../engineering/moduleRuntime';
import {
  Controller, ControllerContext, Informer, isNotFound, objectKey, splitKey,
} from '../controllers/framework';
import { DEPLOYMENTS } from '../controllers/resources';
import { ignoreConflict, updateStatusIfChanged } from '../controllers/workloads';
import { CUSTOMRESOURCEDEFINITIONS } from '../crd';

export interface OperatorOptions {
  /** 这个 Operator 的名字，同时也是它那个 Deployment 的 `app.kubernetes.io/name` */
  name: string;
  /** 它管的自定义资源的 kind */
  kind: string;
  /** 去哪儿取代码。返回 undefined 就是「文件还不在」。 */
  source(): string | undefined;
}

interface OperatorModule {
  reconcile?: (ctx: unknown) => unknown;
  watches?: string[];
}

/** 学员的代码抛异常时，把它变成对象上的一条事件，而不是把世界搞崩 */
export class OperatorError extends Error {}

export class OperatorController extends Controller {
  private crds: Informer;
  private deployments: Informer;
  /** kind -> informer，CRD 注册之后才建得起来。基类那个 informers 是数组，名字不能撞。 */
  private dynamic = new Map<string, Informer>();
  private loaded?: { source: string; module: OperatorModule };
  private logs: string[] = [];

  constructor(context: ControllerContext, private readonly options: OperatorOptions) {
    super(context, `operator:${options.name}`);
    this.crds = this.track(new Informer(this.registry, CUSTOMRESOURCEDEFINITIONS));
    this.deployments = this.track(new Informer(this.registry, DEPLOYMENTS));
    // CRD 注册进来之后才有得 watch；Operator 那个 Deployment 起来之后才该干活
    this.crds.onChange(() => this.sync());
    this.deployments.onChange(() => this.resync());
  }

  start(): void {
    super.start();
    this.sync();
  }

  stop(): void {
    for (const informer of this.dynamic.values()) informer.stop();
    this.dynamic.clear();
    super.stop();
  }

  /** 给判定看的：这个 Operator 打过哪些日志 */
  logLines(): string[] {
    return [...this.logs];
  }

  /**
   * 它是不是在跑。
   *
   * Operator 也是集群里的一个工作负载 —— 把它的 Deployment 缩到 0，
   * 自定义资源还在、`kubectl get` 照样查得到，但**没有人再让它们成真**。
   * 这是「CRD 只是数据结构，Operator 才是行为」最直观的演示。
   */
  private installed(): boolean {
    return this.deployments.list().some((deployment) => {
      if (deployment.metadata.labels?.['app.kubernetes.io/name'] !== this.options.name) return false;
      return (((deployment.status ?? {}) as { availableReplicas?: number }).availableReplicas ?? 0) > 0;
    });
  }

  private definitionFor(kind: string): ResourceDefinition | undefined {
    return this.context.scheme.list().find((item) => item.kind === kind);
  }

  private module(): OperatorModule | undefined {
    const source = this.options.source();
    if (source === undefined) return undefined;
    if (this.loaded?.source === source) return this.loaded.module;

    const runtime = createModuleRuntime({
      files: { 'operator.js': source },
      builtins: {},
      globals: {
        console: {
          log: (...args: unknown[]) => this.logs.push(args.map(String).join(' ')),
          error: (...args: unknown[]) => this.logs.push(`ERROR ${args.map(String).join(' ')}`),
        },
      },
    });
    const module = runtime.require('./operator.js') as OperatorModule;
    this.loaded = { source, module };
    return module;
  }

  /** 建立还缺的 informer。CRD 是后来才注册的，所以这一步要反复做。 */
  private sync(): void {
    let kinds: string[];
    try {
      kinds = [this.options.kind, ...(this.module()?.watches ?? [])];
    } catch {
      kinds = [this.options.kind];
    }
    let added = false;
    for (const kind of new Set(kinds)) {
      if (this.dynamic.has(kind)) continue;
      const definition = this.definitionFor(kind);
      if (!definition) continue;
      const informer = new Informer(this.registry, definition);
      informer.onChange((key, object) => this.route(kind, key, object));
      informer.start();
      this.dynamic.set(kind, informer);
      added = true;
    }
    if (added) this.resync();
  }

  /**
   * 一个事件该 reconcile 谁。
   *
   * 主类型的事件对应它自己；附属类型的事件顺着属主引用找回去 ——
   * 这也是为什么属主引用不只是为了删除：**没有它，控制器不知道
   * 这个被改坏的东西是谁的**，也就修不回去。
   */
  private route(kind: string, key: string, object: KubeObject | undefined): void {
    if (kind === this.options.kind) {
      this.queue.add(key);
      return;
    }
    const namespace = splitKey(key).namespace;
    const owner = (object?.metadata.ownerReferences ?? []).find((ref) => ref.kind === this.options.kind);
    if (owner) {
      this.queue.add(namespace ? `${namespace}/${owner.name}` : owner.name);
      return;
    }
    this.resync();
  }

  private resync(): void {
    const definition = this.definitionFor(this.options.kind);
    if (!definition) return;
    for (const object of this.registry.list(definition).items) this.queue.add(objectKey(object));
  }

  protected async reconcile(key: string): Promise<void> {
    if (!this.installed()) return;
    const definition = this.definitionFor(this.options.kind);
    if (!definition) return;

    let module: OperatorModule | undefined;
    try {
      module = this.module();
    } catch (error) {
      this.logs.push(`ERROR failed to load operator: ${(error as Error).message}`);
      return;
    }
    if (typeof module?.reconcile !== 'function') return;

    const { namespace, name } = splitKey(key);
    let object: KubeObject;
    try {
      object = this.registry.get(definition, namespace, name);
    } catch (error) {
      if (isNotFound(error)) return;                 // 删除交给属主引用，不用学员操心
      throw error;
    }
    if (object.metadata.deletionTimestamp) return;

    try {
      await module.reconcile(this.contextFor(definition, object));
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      this.logs.push(`ERROR reconcile ${key}: ${message}`);
      this.context.recordEvent({
        object, type: 'Warning', reason: 'ReconcileError', message,
      });
    }
  }

  /** 交给学员代码的那个客户端。刻意做得小：够写一个真 Operator，不多一个字。 */
  private contextFor(definition: ResourceDefinition, object: KubeObject): Record<string, unknown> {
    const resolve = (kind: string): ResourceDefinition => {
      const found = this.definitionFor(kind);
      if (!found) throw new OperatorError(`no kind "${kind}" registered in this cluster`);
      return found;
    };

    return {
      object: JSON.parse(JSON.stringify(object)) as KubeObject,
      name: object.metadata.name,
      namespace: object.metadata.namespace,

      /** 挂在自己造出来的东西上：属主没了它们跟着没 */
      owner: () => ({
        apiVersion: object.apiVersion,
        kind: object.kind,
        name: object.metadata.name,
        uid: object.metadata.uid,
        controller: true,
        blockOwnerDeletion: true,
      }),

      get: (kind: string, name: string, namespace?: string) => {
        try {
          const found = this.registry.get(resolve(kind), namespace ?? object.metadata.namespace, name);
          return JSON.parse(JSON.stringify(found));
        } catch (error) {
          if (isNotFound(error)) return undefined;
          throw error;
        }
      },

      list: (kind: string, namespace?: string) => this.registry
        .list(resolve(kind), { namespace: namespace ?? object.metadata.namespace }).items
        .map((item) => JSON.parse(JSON.stringify(item))),

      /**
       * 有就改，没有就建。
       *
       * 改的时候只覆盖 spec 和 metadata 里学员给的部分 —— 直接整体替换会
       * 把 apiserver 补上的字段（resourceVersion、集群分配的那些）抹掉，
       * 然后每次 reconcile 都「发现不一样」，无限重写。
       */
      apply: (body: KubeObject) => {
        const target = resolve(body.kind);
        const namespace = body.metadata?.namespace ?? object.metadata.namespace;
        const name = body.metadata?.name;
        if (!name) throw new OperatorError('apply() needs metadata.name');
        try {
          const existing = this.registry.get(target, namespace, name);
          const next = {
            ...existing,
            metadata: {
              ...existing.metadata,
              labels: body.metadata?.labels ?? existing.metadata.labels,
              annotations: body.metadata?.annotations ?? existing.metadata.annotations,
              ownerReferences: body.metadata?.ownerReferences ?? existing.metadata.ownerReferences,
            },
            spec: body.spec ?? existing.spec,
          } as KubeObject;
          if (JSON.stringify(next) === JSON.stringify(existing)) return existing;
          return this.registry.update(target, namespace, name, next);
        } catch (error) {
          if (!isNotFound(error)) throw error;
          return this.registry.create(target, namespace, {
            ...body,
            metadata: { ...(body.metadata ?? {}), name, namespace },
          } as KubeObject);
        }
      },

      delete: (kind: string, name: string, namespace?: string) => {
        try {
          this.registry.delete(resolve(kind), namespace ?? object.metadata.namespace, name);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      },

      /** 只在真的变了的时候才写。每次都写的话，写回去又触发一次 reconcile。 */
      setStatus: (patch: Record<string, unknown>) => {
        void ignoreConflict(() => {
          const latest = this.registry.get(definition, object.metadata.namespace, object.metadata.name!);
          updateStatusIfChanged(
            this.registry, definition, latest.metadata.namespace, latest.metadata.name!,
            { ...((latest.status ?? {}) as Record<string, unknown>), ...patch }
          );
        });
      },

      event: (reason: string, message: string, type: 'Normal' | 'Warning' = 'Normal') => {
        this.context.recordEvent({ object, type, reason, message });
      },

      log: (...args: unknown[]) => { this.logs.push(args.map(String).join(' ')); },
    };
  }
}
