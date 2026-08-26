/**
 * PodDisruptionBudget 与驱逐
 *
 * PDB 管的是**自愿中断**：节点维护、缩容、手工驱逐。它管不了非自愿中断
 * （节点突然掉电、OOMKill、Pod 被抢占）—— 这条区分很要紧，因为很多人
 * 以为配了 PDB 就「不会少于 N 个副本」，其实 PDB 只是让**主动发起的**
 * 中断被拒绝，而不是拦住世界。
 *
 * 驱逐走的是 Pod 的 `eviction` 子资源，不是 delete。两者的区别就在这里：
 * delete 谁也拦不住，eviction 会先问 PDB。`kubectl drain` 用的是 eviction，
 * 所以它会在违反 PDB 时停下来 —— 而 `kubectl delete pod` 不会。
 */
import type { KubeObject } from '../apiserver';

export interface PdbStatus {
  currentHealthy: number;
  desiredHealthy: number;
  expectedPods: number;
  /** 还能再中断几个。0 表示这一刻谁都不许被驱逐。 */
  disruptionsAllowed: number;
}

/** 一条 PDB 对一批 Pod 的判断 */
export function evaluatePdb(pdb: KubeObject, pods: KubeObject[]): PdbStatus {
  const spec = (pdb.spec ?? {}) as any;
  const selected = pods.filter((pod) => matchesSelector(spec.selector, pod.metadata.labels));
  const healthy = selected.filter(isHealthy).length;
  const desired = desiredHealthyOf(spec, selected.length);
  return {
    currentHealthy: healthy,
    desiredHealthy: desired,
    expectedPods: selected.length,
    disruptionsAllowed: Math.max(0, healthy - desired),
  };
}

/**
 * `minAvailable` 与 `maxUnavailable` 换算成「至少要活着几个」。
 *
 * 百分比按**期望的副本数**算并向上取整（minAvailable）或向下取整
 * （maxUnavailable）—— 方向不同不是笔误，k8s 两边都往「更保守」取。
 */
export function desiredHealthyOf(spec: any, expected: number): number {
  if (spec.minAvailable !== undefined) {
    return resolve(spec.minAvailable, expected, Math.ceil);
  }
  if (spec.maxUnavailable !== undefined) {
    return Math.max(0, expected - resolve(spec.maxUnavailable, expected, Math.floor));
  }
  // 两个都不写：PDB 不起任何作用
  return 0;
}

function resolve(value: string | number, total: number, round: (value: number) => number): number {
  if (typeof value === 'number') return value;
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(String(value));
  if (percent) return round((Number(percent[1]) / 100) * total);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function matchesSelector(
  selector: { matchLabels?: Record<string, string> } | undefined,
  labels: Record<string, string> | undefined
): boolean {
  const wanted = selector?.matchLabels ?? {};
  const actual = labels ?? {};
  return Object.entries(wanted).every(([key, value]) => actual[key] === value);
}

/** Ready 才算 healthy。正在启动的那个不能拿来抵数。 */
export function isHealthy(pod: KubeObject): boolean {
  if (pod.metadata.deletionTimestamp) return false;
  const conditions: any[] = ((pod.status ?? {}) as any).conditions ?? [];
  return conditions.some((entry) => entry.type === 'Ready' && entry.status === 'True');
}

/**
 * 这个 Pod 现在能不能被驱逐。
 *
 * 任何一条选中它的 PDB 说不行就是不行。返回的消息一字不差抄真 apiserver ——
 * `kubectl drain` 会把它原样打出来，学员据此知道是被谁拦的。
 */
export function evictionVerdict(
  pod: KubeObject,
  pdbs: KubeObject[],
  podsInNamespace: KubeObject[]
): { allowed: true } | { allowed: false; message: string; pdb: string } {
  for (const pdb of pdbs) {
    if (pdb.metadata.namespace !== pod.metadata.namespace) continue;
    const spec = (pdb.spec ?? {}) as any;
    if (!matchesSelector(spec.selector, pod.metadata.labels)) continue;
    const status = evaluatePdb(pdb, podsInNamespace);
    if (status.disruptionsAllowed <= 0) {
      return {
        allowed: false,
        pdb: `${pdb.metadata.namespace}/${pdb.metadata.name}`,
        message: "Cannot evict pod as it would violate the pod's disruption budget.",
      };
    }
  }
  return { allowed: true };
}
