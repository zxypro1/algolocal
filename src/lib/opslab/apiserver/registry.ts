/**
 * REST 语义层
 *
 * 架在 etcd 语义存储上，负责 k8s 对象真正的那些规矩：默认值、uid、
 * resourceVersion 与乐观并发、generation 与 observedGeneration、
 * finalizer 与 deletionTimestamp、ownerReferences、分页、watch。
 *
 * 这一层刻意不碰「这个字段合不合法」——schema 校验是下一片的事，
 * 会接官方 OpenAPI + ajv。这里管的是**对象生命周期**，两者边界分清。
 */
import { Store, WatchEvent } from '../store';
import {
  alreadyExists,
  badRequest,
  conflict,
  invalid,
  notFound,
  tooOldResourceVersion,
} from './errors';
import { CompactedError } from '../store';
import { ResourceDefinition, Scheme, storageKey, storagePrefix } from './scheme';
import type {
  CreateOptions,
  DeleteOptions,
  KubeList,
  KubeObject,
  ListOptions,
  ObjectMeta,
  UpdateOptions,
  WatchEventOut,
} from './types';

/** k8s 用这两个 finalizer 表达级联删除的意图，GC 控制器认它们 */
export const FOREGROUND_DELETION = 'foregroundDeletion';
export const ORPHAN_DEPENDENTS = 'orphan';

export interface RegistryDeps {
  store: Store;
  scheme: Scheme;
  /** 当前时间，来自虚拟时钟 —— 不能用 Date.now，否则输出不可复现 */
  now: () => number;
  /** 生成 uid，来自确定性随机数 */
  uid: () => string;
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** k8s 的时间戳格式：RFC3339，秒级，不带毫秒 */
export function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 按逗号切分，但括号里的逗号不算。
 *
 * `env in (prod,staging)` 是合法选择器，直接 split(',') 会把它切成
 * `env in (prod` 和 `staging)` 两半。
 */
function splitClauses(selector: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      clauses.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  clauses.push(current);
  return clauses.map((c) => c.trim()).filter(Boolean);
}

/** `app=web,tier!=db,env in (prod,staging)` */
export function parseLabelSelector(selector: string): (labels: Record<string, string>) => boolean {
  const clauses = splitClauses(selector);
  const matchers = clauses.map((clause) => {
    let match = /^(.+?)\s+notin\s+\((.*)\)$/.exec(clause);
    if (match) {
      const values = match[2].split(',').map((v) => v.trim());
      return (labels: Record<string, string>) => !values.includes(labels[match![1].trim()]);
    }
    match = /^(.+?)\s+in\s+\((.*)\)$/.exec(clause);
    if (match) {
      const values = match[2].split(',').map((v) => v.trim());
      return (labels: Record<string, string>) => values.includes(labels[match![1].trim()]);
    }
    match = /^(.+?)!=(.*)$/.exec(clause);
    if (match) return (labels: Record<string, string>) => labels[match![1].trim()] !== match![2].trim();
    // k8s 里 `a==b` 和 `a=b` 等价，先试双等号免得被单等号切错
    match = /^(.+?)==(.*)$/.exec(clause);
    if (match) return (labels: Record<string, string>) => labels[match![1].trim()] === match![2].trim();
    match = /^(.+?)=(.*)$/.exec(clause);
    if (match) return (labels: Record<string, string>) => labels[match![1].trim()] === match![2].trim();
    if (clause.startsWith('!')) {
      const key = clause.slice(1).trim();
      return (labels: Record<string, string>) => labels[key] === undefined;
    }
    return (labels: Record<string, string>) => labels[clause] !== undefined;
  });
  return (labels) => matchers.every((m) => m(labels ?? {}));
}

/** `metadata.name=web,spec.nodeName=node-1` */
export function parseFieldSelector(selector: string): (object: KubeObject) => boolean {
  const clauses = splitClauses(selector);
  const matchers = clauses.map((clause) => {
    const negate = /^(.+?)!=(.*)$/.exec(clause);
    const equal = /^(.+?)=(.*)$/.exec(clause);
    const [path, expected, wantEqual] = negate
      ? [negate[1].trim(), negate[2].trim(), false]
      : equal
        ? [equal[1].trim(), equal[2].trim(), true]
        : [clause, '', true];
    return (object: KubeObject) => {
      const actual = path.split('.').reduce<any>((acc, part) => (acc == null ? acc : acc[part]), object);
      return wantEqual ? String(actual) === expected : String(actual) !== expected;
    };
  });
  return (object) => matchers.every((m) => m(object));
}

/** continue token 与真 apiserver 同形：base64 的 JSON，带上起始键与读的那一版 */
function encodeContinue(startAfter: string, revision: number): string {
  return Buffer.from(JSON.stringify({ start: startAfter, rv: revision })).toString('base64');
}

function decodeContinue(token: string): { start: string; rv: number } {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    if (typeof parsed.start !== 'string' || typeof parsed.rv !== 'number') throw new Error('shape');
    return parsed;
  } catch {
    throw badRequest('continue key is not valid: invalid continue token');
  }
}

export class Registry {
  private readonly store: Store;
  private readonly scheme: Scheme;
  private readonly now: () => number;
  private readonly nextUid: () => string;

  constructor(deps: RegistryDeps) {
    this.store = deps.store;
    this.scheme = deps.scheme;
    this.now = deps.now;
    this.nextUid = deps.uid;
  }

  /* ---------------- 读 ---------------- */

  get(definition: ResourceDefinition, namespace: string | undefined, name: string): KubeObject {
    this.assertScope(definition, namespace);
    const kv = this.store.get(storageKey(definition, namespace, name));
    if (!kv) throw notFound(definition.resource, name, definition.group);
    return this.decorate(kv.value as KubeObject, kv.modRevision);
  }

  list(definition: ResourceDefinition, options: ListOptions = {}): KubeList {
    const prefix = storagePrefix(definition, options.namespace);

    let startAfter: string | undefined;
    let atRevision: number | undefined;
    if (options.continue) {
      const cursor = decodeContinue(options.continue);
      startAfter = cursor.start;
      // 分页要读同一版快照，否则翻页期间的写会让结果错乱或重复
      atRevision = cursor.rv;
    } else if (options.resourceVersion && options.resourceVersion !== '0') {
      atRevision = Number(options.resourceVersion);
    }

    let result;
    try {
      result = this.store.range(prefix, {
        prefix: true,
        startAfter,
        revision: atRevision,
      });
    } catch (error) {
      if (error instanceof CompactedError) {
        throw tooOldResourceVersion(error.requiredRevision, error.compactRevision);
      }
      throw error;
    }

    let items = result.kvs.map((kv) => this.decorate(kv.value as KubeObject, kv.modRevision));

    if (options.labelSelector) {
      const matches = parseLabelSelector(options.labelSelector);
      items = items.filter((item) => matches(item.metadata.labels ?? {}));
    }
    if (options.fieldSelector) {
      const matches = parseFieldSelector(options.fieldSelector);
      items = items.filter(matches);
    }

    const listRevision = atRevision ?? result.revision;
    const meta: KubeList['metadata'] = { resourceVersion: String(listRevision) };

    if (options.limit && options.limit > 0 && items.length > options.limit) {
      const page = items.slice(0, options.limit);
      const last = page[page.length - 1];
      meta.continue = encodeContinue(
        storageKey(definition, last.metadata.namespace, last.metadata.name),
        listRevision
      );
      meta.remainingItemCount = items.length - page.length;
      items = page;
    }

    return {
      apiVersion: Scheme.toApiVersion(definition.group, definition.version),
      kind: `${definition.kind}List`,
      metadata: meta,
      items,
    };
  }

  /* ---------------- 写 ---------------- */

  create(
    definition: ResourceDefinition,
    namespace: string | undefined,
    object: KubeObject,
    options: CreateOptions = {}
  ): KubeObject {
    this.assertScope(definition, namespace);
    const candidate = clone(object);
    const meta = (candidate.metadata ?? (candidate.metadata = {} as ObjectMeta));

    if (!meta.name) {
      throw invalid(definition.kind, '', [
        { reason: 'FieldValueRequired', message: 'Required value: name or generateName is required', field: 'metadata.name' },
      ], definition.group);
    }
    if (meta.resourceVersion) {
      throw badRequest(
        `${definition.resource} "${meta.name}" is invalid: metadata.resourceVersion: Invalid value: ` +
          `"${meta.resourceVersion}": must be empty on create`
      );
    }
    if (definition.namespaced) {
      if (meta.namespace && meta.namespace !== namespace) {
        throw badRequest(
          `the namespace of the provided object does not match the namespace sent on the request`
        );
      }
      meta.namespace = namespace;
    } else if (meta.namespace) {
      throw badRequest(`the namespace of the provided object is not allowed on a cluster-scoped resource`);
    }

    const key = storageKey(definition, namespace, meta.name);
    if (this.store.get(key)) throw alreadyExists(definition.resource, meta.name, definition.group);

    meta.uid = meta.uid ?? this.nextUid();
    meta.creationTimestamp = formatTimestamp(this.now());
    meta.generation = 1;
    candidate.apiVersion = Scheme.toApiVersion(definition.group, definition.version);
    candidate.kind = definition.kind;
    delete meta.resourceVersion;
    delete meta.deletionTimestamp;

    if (options.dryRun) return this.decorate(candidate, this.store.revision);

    const kv = this.store.put(key, candidate);
    return this.decorate(kv.value as KubeObject, kv.modRevision);
  }

  /**
   * 整体替换。
   *
   * 三件事必须对：
   *  - 带了 resourceVersion 就要和库里的一致，否则 409（乐观并发）；
   *  - status 是子资源，主资源的 update 不许改它 —— 控制器和用户各写各的字段；
   *  - spec 变了才 +generation，metadata 或 status 变不算。
   */
  update(
    definition: ResourceDefinition,
    namespace: string | undefined,
    name: string,
    object: KubeObject,
    options: UpdateOptions = {}
  ): KubeObject {
    this.assertScope(definition, namespace);
    const key = storageKey(definition, namespace, name);
    const existingKv = this.store.get(key);
    if (!existingKv) throw notFound(definition.resource, name, definition.group);

    const existing = existingKv.value as KubeObject;
    const next = clone(object);
    const meta = (next.metadata ?? (next.metadata = {} as ObjectMeta));

    if (meta.name && meta.name !== name) {
      throw badRequest(
        `the name of the object (${meta.name}) does not match the name on the URL (${name})`
      );
    }
    if (meta.resourceVersion && meta.resourceVersion !== String(existingKv.modRevision)) {
      throw conflict(definition.resource, name, undefined, definition.group);
    }

    meta.name = name;
    meta.namespace = definition.namespaced ? namespace : undefined;
    if (!definition.namespaced) delete meta.namespace;
    // 这些字段由服务端说了算，客户端改不动
    meta.uid = existing.metadata.uid;
    meta.creationTimestamp = existing.metadata.creationTimestamp;
    meta.deletionTimestamp = existing.metadata.deletionTimestamp;
    next.apiVersion = Scheme.toApiVersion(definition.group, definition.version);
    next.kind = definition.kind;
    // status 归 status 子资源管
    next.status = existing.status;

    const specChanged = JSON.stringify(next.spec ?? null) !== JSON.stringify(existing.spec ?? null);
    meta.generation = (existing.metadata.generation ?? 1) + (specChanged ? 1 : 0);
    delete meta.resourceVersion;

    if (options.dryRun) return this.decorate(next, existingKv.modRevision);

    const result = this.store.txn(
      [{ key, target: 'MOD_REVISION', op: '=', value: existingKv.modRevision }],
      [{ type: 'put', key, value: next }]
    );
    if (!result.succeeded) throw conflict(definition.resource, name, undefined, definition.group);
    const kv = result.results[0] as { value: unknown; modRevision: number };
    return this.decorate(kv.value as KubeObject, kv.modRevision);
  }

  /**
   * 只写 status 子资源。
   *
   * 不动 spec、不 +generation —— 控制器每秒钟都在写 status，
   * 如果它也 bump generation，`observedGeneration` 就永远追不上，
   * 「这个 Deployment 收敛了没有」就没法判断了。
   */
  updateStatus(
    definition: ResourceDefinition,
    namespace: string | undefined,
    name: string,
    object: KubeObject,
    options: UpdateOptions = {}
  ): KubeObject {
    this.assertScope(definition, namespace);
    const key = storageKey(definition, namespace, name);
    const existingKv = this.store.get(key);
    if (!existingKv) throw notFound(definition.resource, name, definition.group);

    const existing = existingKv.value as KubeObject;
    if (object.metadata?.resourceVersion && object.metadata.resourceVersion !== String(existingKv.modRevision)) {
      throw conflict(definition.resource, name, undefined, definition.group);
    }

    const next = clone(existing);
    next.status = clone(object.status);

    if (options.dryRun) return this.decorate(next, existingKv.modRevision);

    const result = this.store.txn(
      [{ key, target: 'MOD_REVISION', op: '=', value: existingKv.modRevision }],
      [{ type: 'put', key, value: next }]
    );
    if (!result.succeeded) throw conflict(definition.resource, name, undefined, definition.group);
    const kv = result.results[0] as { value: unknown; modRevision: number };
    return this.decorate(kv.value as KubeObject, kv.modRevision);
  }

  /**
   * 删除。
   *
   * 有 finalizer 的对象删不掉 —— 只打上 deletionTimestamp，对象继续存在，
   * 等把 finalizer 一个个摘干净才真的消失。级联删除也是通过加 finalizer 表达意图，
   * 真正去删依赖对象的是 GC 控制器，apiserver 只负责记下这个意图。
   */
  delete(
    definition: ResourceDefinition,
    namespace: string | undefined,
    name: string,
    options: DeleteOptions = {}
  ): KubeObject {
    this.assertScope(definition, namespace);
    const key = storageKey(definition, namespace, name);
    const existingKv = this.store.get(key);
    if (!existingKv) throw notFound(definition.resource, name, definition.group);

    const existing = existingKv.value as KubeObject;
    const preconditions = options.preconditions;
    if (preconditions?.uid && preconditions.uid !== existing.metadata.uid) {
      throw conflict(
        definition.resource, name,
        `the UID in the precondition (${preconditions.uid}) does not match the UID in record (${existing.metadata.uid}). The object might have been deleted and then recreated`,
        definition.group
      );
    }
    if (preconditions?.resourceVersion && preconditions.resourceVersion !== String(existingKv.modRevision)) {
      throw conflict(definition.resource, name, undefined, definition.group);
    }

    const policy = options.propagationPolicy ?? 'Background';
    const finalizers = [...(existing.metadata.finalizers ?? [])];
    if (policy === 'Foreground' && !finalizers.includes(FOREGROUND_DELETION)) {
      finalizers.push(FOREGROUND_DELETION);
    }
    if (policy === 'Orphan' && !finalizers.includes(ORPHAN_DEPENDENTS)) {
      finalizers.push(ORPHAN_DEPENDENTS);
    }

    if (finalizers.length === 0) {
      const kv = this.store.delete(key)!;
      return this.decorate(kv.value as KubeObject, kv.modRevision);
    }

    // 有 finalizer：只标记，不真删
    const marked = clone(existing);
    marked.metadata.deletionTimestamp = marked.metadata.deletionTimestamp ?? formatTimestamp(this.now());
    marked.metadata.deletionGracePeriodSeconds = options.gracePeriodSeconds ?? 0;
    marked.metadata.finalizers = finalizers;

    const result = this.store.txn(
      [{ key, target: 'MOD_REVISION', op: '=', value: existingKv.modRevision }],
      [{ type: 'put', key, value: marked }]
    );
    if (!result.succeeded) throw conflict(definition.resource, name, undefined, definition.group);
    const kv = result.results[0] as { value: unknown; modRevision: number };
    return this.decorate(kv.value as KubeObject, kv.modRevision);
  }

  /**
   * 摘掉一个 finalizer；摘完最后一个而且已经标了删除时间，对象就真的消失。
   * 这是控制器清理完自己那摊事之后要做的动作。
   */
  removeFinalizer(
    definition: ResourceDefinition,
    namespace: string | undefined,
    name: string,
    finalizer: string
  ): KubeObject | null {
    const key = storageKey(definition, namespace, name);
    const existingKv = this.store.get(key);
    if (!existingKv) throw notFound(definition.resource, name, definition.group);

    const existing = existingKv.value as KubeObject;
    const remaining = (existing.metadata.finalizers ?? []).filter((f) => f !== finalizer);

    if (remaining.length === 0 && existing.metadata.deletionTimestamp) {
      this.store.delete(key);
      return null;                                  // 真的删掉了
    }

    const next = clone(existing);
    next.metadata.finalizers = remaining;
    const kv = this.store.put(key, next);
    return this.decorate(kv.value as KubeObject, kv.modRevision);
  }

  deleteCollection(definition: ResourceDefinition, options: ListOptions = {}): KubeObject[] {
    const listed = this.list(definition, options);
    return listed.items.map((item) =>
      this.delete(definition, item.metadata.namespace, item.metadata.name)
    );
  }

  /* ---------------- watch ---------------- */

  /**
   * 订阅变更。
   *
   * 传了 resourceVersion 就先补齐这之后错过的事件 ——
   * informer「先 list 拿到 rv，再从那一版 watch」不能漏事件。
   * 版本太老（已被压缩）时抛 410 Gone，informer 收到后应当丢掉缓存重新 list。
   */
  watch(
    definition: ResourceDefinition,
    options: { namespace?: string; resourceVersion?: string; labelSelector?: string },
    onEvent: (event: WatchEventOut) => void
  ): { cancel: () => void } {
    const prefix = storagePrefix(definition, options.namespace);
    const matchesLabels = options.labelSelector ? parseLabelSelector(options.labelSelector) : null;

    const startRevision =
      options.resourceVersion !== undefined && options.resourceVersion !== '0'
        ? Number(options.resourceVersion)
        : undefined;

    const emit = (event: WatchEvent) => {
      const object = this.decorate(
        (event.type === 'DELETE' ? event.prevKv?.value : event.kv.value) as KubeObject,
        event.kv.modRevision
      );
      if (matchesLabels && !matchesLabels(object.metadata.labels ?? {})) return;
      onEvent({
        type: event.type === 'DELETE' ? 'DELETED' : event.kv.version === 1 ? 'ADDED' : 'MODIFIED',
        object,
      });
    };

    try {
      return this.store.watch(prefix, { prefix: true, startRevision }, emit);
    } catch (error) {
      if (error instanceof CompactedError) {
        throw tooOldResourceVersion(error.requiredRevision, error.compactRevision);
      }
      throw error;
    }
  }

  /* ---------------- 内部 ---------------- */

  /** 把存储层的 modRevision 贴成对象的 resourceVersion */
  private decorate(object: KubeObject, revision: number): KubeObject {
    const copy = clone(object);
    copy.metadata = { ...copy.metadata, resourceVersion: String(revision) };
    return copy;
  }

  private assertScope(definition: ResourceDefinition, namespace: string | undefined): void {
    if (definition.namespaced && !namespace) {
      throw badRequest(`an empty namespace may not be set when a resource name is provided`);
    }
    if (!definition.namespaced && namespace) {
      throw badRequest(`namespace is not allowed on a cluster-scoped resource`);
    }
  }
}
