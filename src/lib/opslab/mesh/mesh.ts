/**
 * 网格在数据面上做什么
 *
 * ambient 的分工：ztunnel（每节点一个）负责 L4 —— 把明文升级成 mTLS、
 * 校验对端身份、按身份与端口做授权；waypoint（按命名空间或服务挂）负责 L7。
 *
 * 三条会让人卡住的规则，这里都照真的实现：
 *
 *  1. **没有 ztunnel，什么都不发生**。istiod 和 ztunnel 是集群里的工作负载，
 *     卸载掉网格就消失，而 CRD 还在、`kubectl get` 还看得见。
 *  2. **PeerAuthentication STRICT 会拒明文**。网格外的调用方连不上网格里的
 *     服务，表现是连接被重置 —— 不是超时，因为 ztunnel 确实回了东西。
 *  3. **L7 授权没有 waypoint 就不生效**。带 methods / paths 的规则
 *     ztunnel 求值不了，于是那一条等于不存在。
 */
import type { KubeObject } from '../apiserver';
import { evaluateAuthz, type AuthzDecision, type MeshRequest } from './policy';
import { AMBIENT_LABEL, spiffeId } from './resources';

export interface MeshPeer {
  namespace: string;
  labels: Record<string, string>;
  serviceAccount: string;
  /** 在不在网格里 */
  enrolled: boolean;
}

export interface MeshView {
  /** 网格的控制面与数据面都在跑吗 */
  installed(): boolean;
  /** 这个命名空间有没有挂 waypoint */
  hasWaypoint(namespace: string): boolean;
  peerAuthentications(): KubeObject[];
  authorizationPolicies(): KubeObject[];
}

export type MeshOutcome =
  | { kind: 'off'; detail: string }
  | { kind: 'passthrough'; detail: string }
  | { kind: 'mtls'; detail: string; principal: string; decision: AuthzDecision }
  | { kind: 'plaintext-rejected'; detail: string; policy: string }
  | { kind: 'denied'; detail: string; policy?: string; decision: AuthzDecision };

/**
 * 一次连接经过网格时发生了什么。
 *
 * 返回的 detail 会原样进包路径 —— 学员看到的就是这句话，所以它得把
 * 「谁用什么身份访问谁、被哪条策略怎么判的」说完整。
 */
export function traverseMesh(
  view: MeshView,
  source: MeshPeer | undefined,
  destination: MeshPeer,
  request: { port: number; method?: string; path?: string }
): MeshOutcome {
  if (!view.installed()) {
    return { kind: 'off', detail: '网格没有在跑（istiod / ztunnel 不可用），流量按明文直连' };
  }
  if (!destination.enrolled) {
    return { kind: 'passthrough', detail: '目标不在网格里，ztunnel 不接管这条连接' };
  }

  const mode = strictnessFor(view.peerAuthentications(), destination);
  const meshed = Boolean(source?.enrolled);

  if (!meshed) {
    if (mode.mtls === 'STRICT') {
      return {
        kind: 'plaintext-rejected',
        policy: mode.policy ?? 'mesh default',
        detail: `明文连接被拒（PeerAuthentication ${mode.policy ?? 'mesh default'} = STRICT）`,
      };
    }
    return { kind: 'passthrough', detail: `调用方不在网格里，PERMISSIVE 下按明文放行` };
  }

  const principal = spiffeId(source!.namespace, source!.serviceAccount);
  const target = { namespace: destination.namespace, labels: destination.labels };
  const hasWaypoint = view.hasWaypoint(destination.namespace);
  const meshRequest: MeshRequest = {
    principal,
    sourceNamespace: source!.namespace,
    port: request.port,
    method: request.method,
    path: request.path,
  };
  const decision = evaluateAuthz(view.authorizationPolicies(), target, meshRequest, hasWaypoint);

  if (!decision.allowed) {
    return {
      kind: 'denied',
      policy: decision.policy,
      decision,
      detail: denialDetail(decision, principal),
    };
  }

  const peer = spiffeId(destination.namespace, destination.serviceAccount);
  const suffix = decision.policy
    ? `，${decision.policy} 放行`
    : '，没有 AuthorizationPolicy 选中它（默认允许）';
  const warning = decision.needsWaypoint
    ? '；注意：带 methods/paths 的规则没有 waypoint 求值不了，已被忽略'
    : '';
  return {
    kind: 'mtls',
    principal,
    decision,
    detail: `mTLS ${principal} -> ${peer}${suffix}${warning}`,
  };
}

function denialDetail(decision: AuthzDecision, principal: string): string {
  if (decision.reason === 'deny-matched') {
    return `${principal} 被 ${decision.policy} 明确拒绝（DENY）`;
  }
  const hint = decision.needsWaypoint
    ? '；这个命名空间没有 waypoint，带 methods/paths 的规则不会被求值'
    : '';
  return `${principal} 不匹配 ${decision.policy} 的任何一条 rule`
    + `，而一旦有 ALLOW 策略选中目标，其余一律拒绝${hint}`;
}

/**
 * 目标工作负载的 mTLS 模式。
 *
 * 优先级和真 Istio 一致：带 selector 的命名空间级策略 > 不带 selector 的
 * 命名空间级策略 > 网格默认（在 istio-system 里那条）。没有任何策略时，
 * ambient 的默认是 PERMISSIVE。
 */
export function strictnessFor(
  policies: KubeObject[],
  destination: MeshPeer
): { mtls: 'STRICT' | 'PERMISSIVE' | 'DISABLE'; policy?: string } {
  const candidates = policies.filter((policy) => {
    if (policy.metadata.namespace === 'istio-system') return true;
    if (policy.metadata.namespace !== destination.namespace) return false;
    const selector = ((policy.spec ?? {}) as any).selector?.matchLabels as Record<string, string> | undefined;
    if (!selector) return true;
    return Object.entries(selector).every(([key, value]) => destination.labels[key] === value);
  });

  const rank = (policy: KubeObject): number => {
    const selector = ((policy.spec ?? {}) as any).selector?.matchLabels;
    if (policy.metadata.namespace === 'istio-system') return 0;
    return selector ? 2 : 1;
  };
  const winner = [...candidates].sort((a, b) => rank(b) - rank(a))[0];
  if (!winner) return { mtls: 'PERMISSIVE' };
  const mode = ((winner.spec ?? {}) as any).mtls?.mode ?? 'PERMISSIVE';
  return { mtls: mode, policy: `${winner.metadata.namespace}/${winner.metadata.name}` };
}

/** 命名空间在不在 ambient 里 */
export function isAmbient(namespace: KubeObject | undefined): boolean {
  return namespace?.metadata.labels?.[AMBIENT_LABEL.key] === AMBIENT_LABEL.value;
}
