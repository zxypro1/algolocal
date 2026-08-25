/**
 * PATCH
 *
 * 不是「锦上添花」的动词：`kubectl apply` 对已存在的对象走的就是 PATCH，
 * 而「改完 manifest 再 apply 一次」是这个产品里最常发生的一件事。
 * 除此之外 `kubectl patch` / `scale` / `label` / `annotate` / `set image` /
 * `rollout restart` 全都是 PATCH。
 *
 * 四种 content-type 里实现三种：
 *  - `application/json-patch+json`（RFC 6902，一串 op）
 *  - `application/merge-patch+json`（RFC 7386，null 表示删除）
 *  - `application/strategic-merge-patch+json`（k8s 自己的，列表按 merge key 合并）
 *
 * 第四种 `application/apply-patch+yaml`（服务端 apply，带 field manager 的
 * 所有权跟踪）明确不支持并报错 —— 那套东西的语义比前三种加起来还复杂，
 * 装作支持了只会让学员在「我明明改了为什么没生效」上耗掉一下午。
 */
import { badRequest } from './errors';

export type PatchType =
  | 'application/json-patch+json'
  | 'application/merge-patch+json'
  | 'application/strategic-merge-patch+json'
  | 'application/apply-patch+yaml';

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (value: Json): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 列表怎么合并。
 *
 * 真集群里这些是结构体上的 `patchStrategy:"merge" patchMergeKey:"name"` 标签。
 * 我们没有那些结构体，就把内置类型上的表抄下来 —— 按字段名匹配，不看深度，
 * 因为同名字段（`containers`、`env`…）在 Pod 模板嵌套的每一层语义都一样。
 *
 * 不在表里的列表整体替换，这也是没有 patchStrategy 标签时的真实行为
 * （比如 `tolerations`、`command`、`args`）。
 */
const MERGE_KEYS: Record<string, string> = {
  containers: 'name',
  initContainers: 'name',
  ephemeralContainers: 'name',
  volumes: 'name',
  volumeMounts: 'mountPath',
  env: 'name',
  envFrom: 'name',
  ports: 'containerPort',
  imagePullSecrets: 'name',
  hostAliases: 'ip',
  secrets: 'name',
  serviceAccounts: 'name',
  subsets: 'name',
  rules: 'host',
  conditions: 'type',
  taints: 'key',
  topologySpreadConstraints: 'topologyKey',
  managedFields: 'manager',
  ownerReferences: 'uid',
  finalizers: '',          // 字符串列表，按值合并
};

/** RFC 6902 */
export function applyJsonPatch(target: Json, operations: Json): Json {
  if (!Array.isArray(operations)) {
    throw badRequest('json patch must be an array of operations');
  }
  let document = clone(target);
  for (const raw of operations) {
    if (!isObject(raw) || typeof raw.op !== 'string' || typeof raw.path !== 'string') {
      throw badRequest('invalid json patch operation');
    }
    document = applyOperation(document, raw as { op: string; path: string; value?: Json; from?: string });
  }
  return document;
}

function applyOperation(
  document: Json,
  operation: { op: string; path: string; value?: Json; from?: string }
): Json {
  switch (operation.op) {
    case 'add': return setAt(document, parsePointer(operation.path), operation.value, true);
    case 'replace': {
      if (getAt(document, parsePointer(operation.path)) === undefined) {
        throw badRequest(`the server rejected our request due to an error in our request`);
      }
      return setAt(document, parsePointer(operation.path), operation.value, false);
    }
    case 'remove': return removeAt(document, parsePointer(operation.path));
    case 'copy': {
      const value = getAt(document, parsePointer(operation.from ?? ''));
      return setAt(document, parsePointer(operation.path), clone(value), true);
    }
    case 'move': {
      const value = getAt(document, parsePointer(operation.from ?? ''));
      const removed = removeAt(document, parsePointer(operation.from ?? ''));
      return setAt(removed, parsePointer(operation.path), clone(value), true);
    }
    case 'test': {
      const actual = getAt(document, parsePointer(operation.path));
      if (JSON.stringify(actual) !== JSON.stringify(operation.value)) {
        throw badRequest(`the server rejected our request due to an error in our request`);
      }
      return document;
    }
    default:
      throw badRequest(`Unexpected kind: ${operation.op}`);
  }
}

/** RFC 7386：对象递归合并，`null` 表示删除这个键 */
export function applyMergePatch(target: Json, patch: Json): Json {
  if (!isObject(patch)) return clone(patch);
  const base: JsonObject = isObject(target) ? { ...(target as JsonObject) } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else base[key] = applyMergePatch(base[key], value);
  }
  return base;
}

/**
 * k8s 的策略合并。
 *
 * 和 merge patch 的区别只在**列表**：有 merge key 的列表按 key 逐项合并，
 * 而不是整体替换。这正是 `kubectl set image` 只换镜像、不把别的容器删掉的原因。
 *
 * 还支持两个指令：`$patch: replace` 强制整体替换，`$patch: delete` 删掉这一项。
 */
export function applyStrategicMergePatch(target: Json, patch: Json, field = ''): Json {
  if (!isObject(patch)) return clone(patch);

  if (patch.$patch === 'replace') {
    const copy = { ...patch };
    delete copy.$patch;
    return clone(copy);
  }

  const base: JsonObject = isObject(target) ? { ...(target as JsonObject) } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === '$patch') continue;
    if (value === null) { delete base[key]; continue; }

    // `$setElementOrder/containers` 只是排序提示，我们按 patch 里的顺序来就行
    if (key.startsWith('$setElementOrder/') || key.startsWith('$deleteFromPrimitiveList/')) continue;

    if (Array.isArray(value)) {
      base[key] = mergeList(base[key], value, key);
      continue;
    }
    base[key] = applyStrategicMergePatch(base[key], value, key);
  }
  return base;
}

function mergeList(target: Json, patch: Json[], field: string): Json {
  const mergeKey = MERGE_KEYS[field];
  if (mergeKey === undefined) return clone(patch);          // 没有策略 = 整体替换
  const existing = Array.isArray(target) ? [...target] : [];

  // 字符串列表（finalizers）按值合并
  if (mergeKey === '') {
    const merged = [...existing];
    for (const item of patch) if (!merged.includes(item as never)) merged.push(item);
    return merged;
  }

  const result = existing.map(clone);
  for (const item of patch) {
    if (!isObject(item)) { result.push(clone(item)); continue; }
    const identity = item[mergeKey];
    const index = result.findIndex((candidate) => isObject(candidate) && candidate[mergeKey] === identity);

    if (item.$patch === 'delete') {
      if (index >= 0) result.splice(index, 1);
      continue;
    }
    if (index >= 0) result[index] = applyStrategicMergePatch(result[index], item, field);
    else result.push(clone(item));
  }
  return result;
}

export function applyPatch(target: Json, patch: Json, type: PatchType): Json {
  switch (type) {
    case 'application/json-patch+json': return applyJsonPatch(target, patch);
    case 'application/merge-patch+json': return applyMergePatch(target, patch);
    case 'application/strategic-merge-patch+json': return applyStrategicMergePatch(target, patch);
    case 'application/apply-patch+yaml':
      // 走的是 Registry.apply（要 fieldManager 与 managedFields），不在这里
      throw badRequest('apply patches must go through server-side apply');
    default:
      throw badRequest(`Unsupported Media Type: ${String(type)}`);
  }
}

/* ------------------------------------------------------------------ */

/** RFC 6901 JSON Pointer */
function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw badRequest(`invalid json pointer: ${pointer}`);
  return pointer.slice(1).split('/').map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getAt(document: Json, path: string[]): Json {
  let current = document;
  for (const token of path) {
    if (Array.isArray(current)) current = current[Number(token)];
    else if (isObject(current)) current = current[token];
    else return undefined;
  }
  return current;
}

function setAt(document: Json, path: string[], value: Json, insert: boolean): Json {
  if (path.length === 0) return clone(value);
  const [head, ...rest] = path;

  if (Array.isArray(document)) {
    const list = [...document];
    const index = head === '-' ? list.length : Number(head);
    if (rest.length === 0) {
      if (insert) list.splice(index, 0, clone(value));
      else list[index] = clone(value);
    } else {
      list[index] = setAt(list[index], rest, value, insert);
    }
    return list;
  }

  const object: JsonObject = isObject(document) ? { ...(document as JsonObject) } : {};
  object[head] = rest.length === 0 ? clone(value) : setAt(object[head], rest, value, insert);
  return object;
}

function removeAt(document: Json, path: string[]): Json {
  if (path.length === 0) return undefined;
  const [head, ...rest] = path;

  if (Array.isArray(document)) {
    const list = [...document];
    const index = Number(head);
    if (rest.length === 0) list.splice(index, 1);
    else list[index] = removeAt(list[index], rest);
    return list;
  }

  const object: JsonObject = isObject(document) ? { ...(document as JsonObject) } : {};
  if (rest.length === 0) delete object[head];
  else object[head] = removeAt(object[head], rest);
  return object;
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
