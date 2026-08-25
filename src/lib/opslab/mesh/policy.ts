/**
 * AuthorizationPolicy 的判定
 *
 * 规则本身不复杂，复杂的是**优先级**，而顺序错了会让人以为策略没生效：
 *
 *  1. 有 CUSTOM 动作的先走（我们不做外部授权，跳过）；
 *  2. 任何一条 DENY 命中 -> 拒绝；
 *  3. 没有任何 ALLOW 策略选中这个工作负载 -> 放行（默认允许）；
 *  4. 有 ALLOW 策略选中它：命中任意一条 -> 放行，否则 -> 拒绝。
 *
 * 第 3 条和第 4 条的差别是最要命的：给一个服务加**第一条** ALLOW 策略，
 * 等于同时把「其余全部拒绝」也打开了。很多人以为自己只是加了一条放行。
 */
import type { KubeObject } from '../apiserver';

export interface MeshRequest {
  /** 调用方的 SPIFFE 身份。不在网格里就是 undefined。 */
  principal?: string;
  sourceNamespace?: string;
  /** 目标端口 */
  port: number;
  method?: string;
  path?: string;
}

export interface MeshTarget {
  namespace: string;
  labels: Record<string, string>;
}

export interface AuthzDecision {
  allowed: boolean;
  /** 命中的策略，写进包路径里 */
  policy?: string;
  /** 判定为什么是这个结果 */
  reason: 'no-policy' | 'allow-matched' | 'allow-not-matched' | 'deny-matched';
  /** 这条判定需要 L7 信息（方法/路径），而没有 waypoint 就拿不到 */
  needsWaypoint?: boolean;
}

/** 选中这个工作负载的策略 */
export function policiesFor(policies: KubeObject[], target: MeshTarget): KubeObject[] {
  return policies.filter((policy) => {
    if (policy.metadata.namespace !== target.namespace) return false;
    const selector = ((policy.spec ?? {}) as any).selector?.matchLabels as Record<string, string> | undefined;
    if (!selector) return true;   // 不写 selector = 整个命名空间
    return Object.entries(selector).every(([key, value]) => target.labels[key] === value);
  });
}

/**
 * 判一次。
 *
 * `hasWaypoint` 决定 L7 条件算不算数：没有 waypoint 时 ztunnel 只看得到
 * L4（身份、端口），带 `methods` / `paths` 的规则**根本不会被求值** ——
 * 这正是 ambient 里最常见的「策略写了但没用」。
 */
export function evaluateAuthz(
  policies: KubeObject[],
  target: MeshTarget,
  request: MeshRequest,
  hasWaypoint: boolean
): AuthzDecision {
  const selected = policiesFor(policies, target);
  const denies = selected.filter((policy) => actionOf(policy) === 'DENY');
  const allows = selected.filter((policy) => actionOf(policy) === 'ALLOW');

  let needsWaypoint = false;
  for (const policy of denies) {
    const hit = matchesAny(policy, request, hasWaypoint);
    if (hit.l7Ignored) needsWaypoint = true;
    if (hit.matched) {
      return { allowed: false, policy: refOf(policy), reason: 'deny-matched', needsWaypoint };
    }
  }

  if (allows.length === 0) {
    return { allowed: true, reason: 'no-policy', needsWaypoint };
  }
  for (const policy of allows) {
    const hit = matchesAny(policy, request, hasWaypoint);
    if (hit.l7Ignored) needsWaypoint = true;
    if (hit.matched) {
      return { allowed: true, policy: refOf(policy), reason: 'allow-matched', needsWaypoint };
    }
  }
  return {
    allowed: false,
    policy: refOf(allows[0]),
    reason: 'allow-not-matched',
    needsWaypoint,
  };
}

function actionOf(policy: KubeObject): string {
  return ((policy.spec ?? {}) as any).action ?? 'ALLOW';
}

function refOf(policy: KubeObject): string {
  return `${policy.metadata.namespace}/${policy.metadata.name}`;
}

/** 策略里的 rules 是「或」：任意一条命中就算命中 */
function matchesAny(
  policy: KubeObject,
  request: MeshRequest,
  hasWaypoint: boolean
): { matched: boolean; l7Ignored: boolean } {
  const rules: any[] = ((policy.spec ?? {}) as any).rules ?? [];
  // 一条 rules 都没有：ALLOW 表示什么都不放行，DENY 表示全部拒绝
  if (rules.length === 0) {
    return { matched: actionOf(policy) === 'DENY', l7Ignored: false };
  }
  let l7Ignored = false;
  for (const rule of rules) {
    const outcome = matchesRule(rule, request, hasWaypoint);
    if (outcome.l7Ignored) l7Ignored = true;
    if (outcome.matched) return { matched: true, l7Ignored };
  }
  return { matched: false, l7Ignored };
}

/** rule 里的 from / to / when 之间是「与」，每一项内部是「或」 */
function matchesRule(
  rule: any,
  request: MeshRequest,
  hasWaypoint: boolean
): { matched: boolean; l7Ignored: boolean } {
  let l7Ignored = false;

  const from: any[] = rule.from ?? [];
  if (from.length > 0) {
    const ok = from.some((entry) => matchesSource(entry.source ?? {}, request));
    if (!ok) return { matched: false, l7Ignored };
  }

  const to: any[] = rule.to ?? [];
  if (to.length > 0) {
    let matchedTo = false;
    for (const entry of to) {
      const operation = entry.operation ?? {};
      const usesL7 = Boolean(operation.methods || operation.paths);
      if (usesL7 && !hasWaypoint) {
        // ztunnel 看不到 HTTP。这一条不是「不匹配」，是「压根没被求值」。
        l7Ignored = true;
        continue;
      }
      if (matchesOperation(operation, request)) { matchedTo = true; break; }
    }
    if (!matchedTo) return { matched: false, l7Ignored };
  }

  return { matched: true, l7Ignored };
}

function matchesSource(source: any, request: MeshRequest): boolean {
  const principals: string[] = source.principals ?? [];
  const namespaces: string[] = source.namespaces ?? [];
  if (principals.length > 0) {
    if (!request.principal) return false;
    if (!principals.some((entry) => globMatch(entry, request.principal!))) return false;
  }
  if (namespaces.length > 0) {
    if (!request.sourceNamespace) return false;
    if (!namespaces.some((entry) => globMatch(entry, request.sourceNamespace!))) return false;
  }
  return true;
}

function matchesOperation(operation: any, request: MeshRequest): boolean {
  const ports: string[] = operation.ports ?? [];
  if (ports.length > 0 && !ports.includes(String(request.port))) return false;
  const methods: string[] = operation.methods ?? [];
  if (methods.length > 0 && !methods.some((entry) => globMatch(entry, request.method ?? 'GET'))) return false;
  const paths: string[] = operation.paths ?? [];
  if (paths.length > 0 && !paths.some((entry) => globMatch(entry, request.path ?? '/'))) return false;
  return true;
}

/** Istio 的通配只支持前缀 `*x` 与后缀 `x*`，不是完整的 glob */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*')) return value.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}
