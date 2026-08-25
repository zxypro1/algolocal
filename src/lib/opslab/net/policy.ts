/**
 * NetworkPolicy 判定
 *
 * 三条容易被误解的规则，这里都按真语义实现：
 *
 * 1. **策略是「白名单开关」，不是「防火墙规则链」。** 没有任何策略选中一个 Pod
 *    时，它是全通的；一旦有策略选中它并声明了某个方向，那个方向就变成
 *    「默认拒绝 + 按规则放行」。
 * 2. **两端都要放行。** A 访问 B，要 A 的 egress 允许出去，且 B 的 ingress
 *    允许进来。只改一边是最常见的错。
 * 3. **拒绝表现为丢包，不是拒绝。** 所以症状是超时。
 *
 * 还有一个几乎人人踩一次的坑：写了 egress 策略却忘了放行 DNS（kube-system 的
 * 53 端口），结果所有名字都解析不了 —— 症状是「域名不存在」，看着完全不像
 * 网络策略的问题。第 10 关就考这个。
 */
import type { KubeObject } from '../apiserver';

export interface PolicyPeer {
  /** 发起方/接收方是 Pod 时 */
  namespace?: string;
  labels?: Record<string, string>;
  /** 命名空间自己的标签，namespaceSelector 要用 */
  namespaceLabels?: Record<string, string>;
  ip?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  /** 这个方向有没有被策略「接管」。没接管就是默认全通。 */
  isolated: boolean;
  /** 放行它的那条策略 */
  allowedBy?: string;
  /** 接管了这个方向、但没有一条规则匹配的策略们 */
  isolatedBy: string[];
}

export interface Traffic {
  source: PolicyPeer;
  destination: PolicyPeer;
  port: number;
  protocol?: string;
}

/**
 * 出方向：source 这个 Pod 允不允许连出去。
 *
 * 集群外发起的流量没有 egress 一说，直接放行。
 */
export function evaluateEgress(policies: KubeObject[], traffic: Traffic): PolicyDecision {
  if (!traffic.source.namespace) return { allowed: true, isolated: false, isolatedBy: [] };

  const selecting = policies.filter(
    (policy) => policy.metadata.namespace === traffic.source.namespace
      && matchesSelector(podSelectorOf(policy), traffic.source.labels)
      && directionsOf(policy).includes('Egress')
  );
  if (selecting.length === 0) return { allowed: true, isolated: false, isolatedBy: [] };

  for (const policy of selecting) {
    for (const rule of rulesOf(policy, 'egress')) {
      if (!portMatches(rule.ports, traffic)) continue;
      if (peerMatches(rule.to, traffic.destination, policy.metadata.namespace)) {
        return { allowed: true, isolated: true, allowedBy: nameOf(policy), isolatedBy: [] };
      }
    }
  }
  return { allowed: false, isolated: true, isolatedBy: selecting.map(nameOf) };
}

/** 入方向：destination 这个 Pod 允不允许被连 */
export function evaluateIngress(policies: KubeObject[], traffic: Traffic): PolicyDecision {
  if (!traffic.destination.namespace) return { allowed: true, isolated: false, isolatedBy: [] };

  const selecting = policies.filter(
    (policy) => policy.metadata.namespace === traffic.destination.namespace
      && matchesSelector(podSelectorOf(policy), traffic.destination.labels)
      && directionsOf(policy).includes('Ingress')
  );
  if (selecting.length === 0) return { allowed: true, isolated: false, isolatedBy: [] };

  for (const policy of selecting) {
    for (const rule of rulesOf(policy, 'ingress')) {
      if (!portMatches(rule.ports, traffic)) continue;
      if (peerMatches(rule.from, traffic.source, policy.metadata.namespace)) {
        return { allowed: true, isolated: true, allowedBy: nameOf(policy), isolatedBy: [] };
      }
    }
  }
  return { allowed: false, isolated: true, isolatedBy: selecting.map(nameOf) };
}

/** 两端都放行才通 */
export function evaluate(policies: KubeObject[], traffic: Traffic): {
  allowed: boolean;
  egress: PolicyDecision;
  ingress: PolicyDecision;
  blockedBy?: string;
} {
  const egress = evaluateEgress(policies, traffic);
  const ingress = evaluateIngress(policies, traffic);
  const blockedBy = !egress.allowed
    ? `egress:${egress.isolatedBy.join(',')}`
    : !ingress.allowed
      ? `ingress:${ingress.isolatedBy.join(',')}`
      : undefined;
  return { allowed: egress.allowed && ingress.allowed, egress, ingress, blockedBy };
}

/* ------------------------------------------------------------------ */

interface Rule {
  from?: unknown[];
  to?: unknown[];
  ports?: Array<{ port?: number | string; protocol?: string; endPort?: number }>;
}

function nameOf(policy: KubeObject): string {
  return `${policy.metadata.namespace}/${policy.metadata.name}`;
}

function podSelectorOf(policy: KubeObject): Record<string, string> | undefined {
  const spec = (policy.spec ?? {}) as { podSelector?: { matchLabels?: Record<string, string> } };
  return spec.podSelector?.matchLabels;
}

/**
 * 这条策略管哪些方向。
 *
 * `policyTypes` 没写时按内容推：有 `egress` 段就管出方向，否则只管入方向 ——
 * 注意「只写了 podSelector、什么规则都没有」的策略是**默认拒绝入方向**，
 * 这正是 deny-all 的标准写法。
 */
export function directionsOf(policy: KubeObject): string[] {
  const spec = (policy.spec ?? {}) as { policyTypes?: string[]; ingress?: unknown[]; egress?: unknown[] };
  if (spec.policyTypes?.length) return spec.policyTypes;
  return spec.egress ? ['Ingress', 'Egress'] : ['Ingress'];
}

function rulesOf(policy: KubeObject, direction: 'ingress' | 'egress'): Rule[] {
  const spec = (policy.spec ?? {}) as Record<string, Rule[] | undefined>;
  return spec[direction] ?? [];
}

/** `ports` 不写表示所有端口 */
function portMatches(ports: Rule['ports'], traffic: Traffic): boolean {
  if (!ports || ports.length === 0) return true;
  return ports.some((entry) => {
    if (entry.protocol && entry.protocol !== (traffic.protocol ?? 'TCP')) return false;
    if (entry.port === undefined) return true;
    const port = typeof entry.port === 'number' ? entry.port : Number(entry.port);
    if (!Number.isFinite(port)) return true;   // 命名端口，这里放行
    if (entry.endPort) return traffic.port >= port && traffic.port <= entry.endPort;
    return traffic.port === port;
  });
}

/** `from` / `to` 不写（或者是空数组）表示所有来源 */
function peerMatches(
  peers: unknown[] | undefined,
  peer: PolicyPeer,
  policyNamespace: string | undefined
): boolean {
  if (!peers || peers.length === 0) return true;
  return peers.some((entry) => singlePeerMatches(entry as Record<string, any>, peer, policyNamespace));
}

/**
 * 一条 peer。
 *
 * 同一个数组元素里的 `podSelector` 与 `namespaceSelector` 是**与**的关系
 * （「那个命名空间里的这些 Pod」），分成两个元素才是或 —— 这一处写反了，
 * 策略会宽松得多，而且不会报错。
 */
function singlePeerMatches(
  entry: Record<string, any>,
  peer: PolicyPeer,
  policyNamespace: string | undefined
): boolean {
  if (entry.ipBlock) {
    if (!peer.ip) return false;
    if (!inCidr(peer.ip, entry.ipBlock.cidr)) return false;
    return !(entry.ipBlock.except ?? []).some((cidr: string) => inCidr(peer.ip!, cidr));
  }

  if (entry.namespaceSelector) {
    const labels = entry.namespaceSelector.matchLabels as Record<string, string> | undefined;
    // 空的 namespaceSelector 表示「所有命名空间」
    if (labels && Object.keys(labels).length > 0) {
      if (!matchesSelector(labels, peer.namespaceLabels)) return false;
    }
  } else if (entry.podSelector) {
    /**
     * 没写 namespaceSelector 时，podSelector **只在策略自己的命名空间里**找。
     *
     * 漏了这一条，`from: [{podSelector: {app: client}}]` 会把所有命名空间里
     * 叫这个名字的 Pod 都放进来 —— 策略比写的人以为的宽得多，而且不报错。
     */
    if (peer.namespace !== policyNamespace) return false;
  }

  if (entry.podSelector) {
    const labels = entry.podSelector.matchLabels as Record<string, string> | undefined;
    if (labels && Object.keys(labels).length > 0 && !matchesSelector(labels, peer.labels)) {
      return false;
    }
  }
  return Boolean(entry.namespaceSelector || entry.podSelector);
}

export function matchesSelector(
  selector: Record<string, string> | undefined,
  labels: Record<string, string> | undefined
): boolean {
  if (!selector || Object.keys(selector).length === 0) return true;
  return Object.entries(selector).every(([key, value]) => labels?.[key] === value);
}

/** `10.42.0.0/16` 这种。只做 IPv4，够用。 */
export function inCidr(ip: string, cidr: string): boolean {
  const [network, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  if (!Number.isFinite(bits)) return ip === network;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(network) & mask);
}

function toInt(ip: string): number {
  return ip.split('.').reduce((total, part) => ((total << 8) + Number(part)) >>> 0, 0);
}
