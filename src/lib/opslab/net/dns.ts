/**
 * 集群 DNS
 *
 * CoreDNS 的那套名字规则。看着琐碎，但「为什么 `curl portal` 在这个命名空间
 * 能通、换个命名空间就不通」这类问题全靠它，而且第 10 关有一个专门的坑：
 * egress 策略把 DNS 一起切断之后，症状是**名字解析失败**而不是连接超时，
 * 两者查法完全不同。
 *
 * `ndots:5` 是最容易踩的一条：Pod 的 resolv.conf 默认写着它，意思是
 * 「点数少于 5 的名字先当成相对名，挨个拼 search 域去试」。所以
 * `curl portal.payments.svc.cluster.local`（4 个点）会先试
 * `portal.payments.svc.cluster.local.payments.svc.cluster.local` —— 这就是
 * 集群里 DNS 查询量异常高的经典原因。
 */
import type { Resolution, Source } from './types';

export interface DnsView {
  /** 命名空间里的 Service：名字 -> ClusterIP（headless 时为 undefined） */
  service(namespace: string, name: string): { clusterIP?: string; externalName?: string; headless: boolean } | undefined;
  /** headless Service 背后的 Pod 地址 */
  endpoints(namespace: string, name: string): string[];
  /** 集群外的名字，由世界定义（`harbor.corp.internal` 之类） */
  external(name: string): string[] | undefined;
}

export const CLUSTER_DOMAIN = 'cluster.local';

/** Pod 的 resolv.conf 长这样，`kubectl exec ... cat /etc/resolv.conf` 打出来的就是它 */
export function resolvConf(namespace: string): string {
  return [
    'search '
      + `${namespace}.svc.${CLUSTER_DOMAIN} svc.${CLUSTER_DOMAIN} ${CLUSTER_DOMAIN}`,
    'nameserver 10.96.0.10',
    'options ndots:5',
    '',
  ].join('\n');
}

export interface ResolveOptions {
  view: DnsView;
  source: Source;
  /** DNS 本身通不通。egress 策略切断 53 端口时传 false。 */
  dnsReachable?: boolean;
}

/**
 * 解析一个名字。
 *
 * 集群里按 ndots + search 域来；集群外（办公网的跳板机）只查世界里声明过的
 * 外部名字，查不到就是 NXDOMAIN，和真的一样。
 */
export function resolve(name: string, options: ResolveOptions): Resolution {
  const { view, source } = options;
  const attempts: string[] = [];

  // IP 直接用，不查 DNS
  if (isIpv4(name)) {
    return { question: name, canonical: name, addresses: [name], attempts: [], kind: 'host' };
  }

  const inCluster = source.zone === 'cluster';
  if (!inCluster) {
    const external = view.external(name);
    return external
      ? { question: name, canonical: name, addresses: external, attempts: [name], kind: 'external' }
      : { question: name, addresses: [], attempts: [name], kind: 'nxdomain' };
  }

  if (options.dnsReachable === false) {
    // 查不到 DNS 服务器：症状是解析超时，不是「名字不存在」
    return { question: name, addresses: [], attempts: [name], kind: 'nxdomain' };
  }

  const namespace = source.namespace ?? 'default';
  for (const candidate of candidatesFor(name, namespace)) {
    attempts.push(candidate);
    const answer = lookupOne(candidate, view, namespace);
    if (answer) return { ...answer, question: name, attempts };
  }
  return { question: name, addresses: [], attempts, kind: 'nxdomain' };
}

/**
 * `ndots:5` 的展开顺序。
 *
 * 点数 < 5 的名字先拼 search 域再试自己；>= 5 的先试自己。绝对名（末尾带点）
 * 不拼。这个顺序决定了查询次数，也决定了「短名字在本命名空间能通、跨命名空间
 * 不通」的行为。
 */
export function candidatesFor(name: string, namespace: string): string[] {
  if (name.endsWith('.')) return [name.slice(0, -1)];

  const search = [
    `${namespace}.svc.${CLUSTER_DOMAIN}`,
    `svc.${CLUSTER_DOMAIN}`,
    CLUSTER_DOMAIN,
  ];
  const dots = (name.match(/\./g) ?? []).length;
  const suffixed = search.map((suffix) => `${name}.${suffix}`);
  return dots >= 5 ? [name, ...suffixed] : [...suffixed, name];
}

function lookupOne(
  candidate: string,
  view: DnsView,
  defaultNamespace: string
): Omit<Resolution, 'question' | 'attempts'> | undefined {
  const parts = candidate.split('.');

  // <svc>.<ns>.svc.cluster.local
  if (parts.length >= 5 && parts.slice(2).join('.') === `svc.${CLUSTER_DOMAIN}`) {
    return serviceAnswer(view, parts[1], parts[0], candidate);
  }
  // <svc>.<ns>
  if (parts.length === 2) {
    const found = serviceAnswer(view, parts[1], parts[0], candidate);
    if (found) return found;
  }
  // 裸名字：本命名空间
  if (parts.length === 1) {
    const found = serviceAnswer(view, defaultNamespace, parts[0], candidate);
    if (found) return found;
  }
  const external = view.external(candidate);
  return external ? { canonical: candidate, addresses: external, kind: 'external' } : undefined;
}

function serviceAnswer(
  view: DnsView,
  namespace: string,
  name: string,
  canonical: string
): Omit<Resolution, 'question' | 'attempts'> | undefined {
  const service = view.service(namespace, name);
  if (!service) return undefined;

  if (service.externalName) {
    const target = view.external(service.externalName);
    return { canonical, addresses: target ?? [], kind: 'external' };
  }
  if (service.headless) {
    // headless 直接回后端 Pod 的地址，没有 VIP —— StatefulSet 靠它做稳定寻址
    return { canonical, addresses: view.endpoints(namespace, name), kind: 'headless' };
  }
  return { canonical, addresses: service.clusterIP ? [service.clusterIP] : [], kind: 'service' };
}

export function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
