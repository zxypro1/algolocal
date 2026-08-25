/**
 * 服务端 apply
 *
 * `PATCH ... Content-Type: application/apply-patch+yaml` —— 客户端把「我要的
 * 样子」整份发过来，服务端合并，并记下**哪些字段是谁写的**（managedFields）。
 *
 * 关键在最后那一句。有了归属，下一次 apply 少写了某个字段，服务端就知道
 * 「这个字段本来是我加的、现在我不要了」，于是删掉它 —— 客户端不必自己算差异。
 * 这正是 `helm upgrade` 能把上一版多出来的字段清掉的原因，也是
 * `kubectl apply --server-side` 相对 last-applied 注解的进步。
 *
 * 不做的部分：**冲突检测**。真 apiserver 会在两个 manager 抢同一个字段时报
 * 409 并要求 `--force-conflicts`。这里所有 apply 都当作带了 force。
 */
import type { KubeObject } from './types';

export interface FieldSet {
  [key: string]: FieldSet;
}

const PREFIX = 'f:';

/**
 * 一个对象声明了哪些字段。
 *
 * 真 k8s 的 FieldsV1 会给「有 merge key 的列表」拆成 `k:{"name":"web"}` 这种
 * 逐项归属。这里整个列表算一个字段 —— 于是「两个 manager 各往
 * containers 里加一个」这种情况我们分不开，但「apply 少写了一项就删掉」
 * 这个主要行为是对的。
 */
export function fieldSetOf(value: unknown): FieldSet {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: FieldSet = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[`${PREFIX}${key}`] = fieldSetOf(child);
  }
  return out;
}

/** 把 desired 合进 live。列表整体替换，映射逐键递归 —— 和 SSA 一致。 */
export function mergeApplied(live: unknown, desired: unknown): unknown {
  if (desired === null) return null;
  if (typeof desired !== 'object' || Array.isArray(desired)) return desired;
  if (typeof live !== 'object' || live === null || Array.isArray(live)) {
    return JSON.parse(JSON.stringify(desired));
  }
  const out: Record<string, unknown> = { ...(live as Record<string, unknown>) };
  for (const [key, value] of Object.entries(desired as Record<string, unknown>)) {
    out[key] = mergeApplied((live as Record<string, unknown>)[key], value);
  }
  return out;
}

/**
 * 上一次这个 manager 写过、这次不写了的字段，删掉。
 *
 * 没有这一步，`helm upgrade` 去掉一个 env 之后那个 env 会一直留在集群里，
 * 而 chart 里已经找不到它了 —— 最难查的一类「幽灵配置」。
 */
export function pruneUnowned(target: unknown, before: FieldSet, after: FieldSet): unknown {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return target;
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(before)) {
    const name = key.slice(PREFIX.length);
    if (!(key in after)) {
      delete out[name];
      continue;
    }
    const child = pruneUnowned(out[name], before[key], after[key]);
    if (child !== undefined) out[name] = child;
  }
  return out;
}

export interface ManagedFieldsEntry {
  manager: string;
  operation: 'Apply' | 'Update';
  apiVersion: string;
  time: string;
  fieldsType: 'FieldsV1';
  fieldsV1: FieldSet;
}

/** 取出某个 manager 上一次 apply 的字段集 */
export function ownedBy(object: KubeObject, manager: string): FieldSet {
  const entries = (object.metadata as unknown as { managedFields?: ManagedFieldsEntry[] }).managedFields ?? [];
  return entries.find((entry) => entry.manager === manager && entry.operation === 'Apply')?.fieldsV1 ?? {};
}

/** 记下这一次的归属，替换掉这个 manager 之前那条 */
export function recordOwnership(
  object: KubeObject,
  manager: string,
  apiVersion: string,
  time: string,
  fields: FieldSet
): ManagedFieldsEntry[] {
  const entries = ((object.metadata as unknown as { managedFields?: ManagedFieldsEntry[] }).managedFields ?? [])
    .filter((entry) => !(entry.manager === manager && entry.operation === 'Apply'));
  entries.push({ manager, operation: 'Apply', apiVersion, time, fieldsType: 'FieldsV1', fieldsV1: fields });
  return entries.sort((a, b) => (a.manager < b.manager ? -1 : a.manager > b.manager ? 1 : 0));
}

/**
 * apply 的时候哪些字段不算「客户端声明的」。
 *
 * 服务端自己写的东西不该被 prune 掉，也不该算进归属里。
 */
export function strippedForApply(object: KubeObject): KubeObject {
  const clone = JSON.parse(JSON.stringify(object)) as KubeObject;
  const metadata = clone.metadata as unknown as Record<string, unknown>;
  for (const key of ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields', 'selfLink']) {
    delete metadata[key];
  }
  delete (clone as Record<string, unknown>).status;
  return clone;
}
