/**
 * 网络
 *
 * 读的全是 apiserver 里的对象（Service、Endpoints、Pod、NetworkPolicy），
 * 自己不存状态 —— 于是「改了策略之后立刻生效」是自然的，不需要谁去通知谁。
 *
 * 一次连接要过五关，每一关失败的症状都不同，这正是要教的东西：
 *
 *   1. 名字解析      → NXDOMAIN / 解析超时
 *   2. 地址可达性    → no route（办公网够不到 Pod IP）
 *   3. 网络策略      → 超时（丢包，不是拒绝）
 *   4. 有没有后端    → 连接被拒绝（Service 存在但 Endpoints 是空的）
 *   5. 应用怎么答    → HTTP 状态码
 */
import type { KubeObject, Registry, Scheme } from '../apiserver';
import type { ImageBehavior } from '../controllers/runtime';
import type { Certificate } from '../crypto';
import { verifyChain } from '../crypto';
import { CLUSTER_DOMAIN, isIpv4, resolve, type DnsView } from './dns';
import { evaluate, type PolicyPeer } from './policy';
import type { ConnectResult, Hop, Resolution, Source, Target, Zone } from './types';

export interface NetworkDeps {
  registry: Registry;
  scheme: Scheme;
  /** 集群外的名字：`harbor.corp.internal` -> ['10.10.0.20'] */
  externalHosts?: Record<string, string[]>;
  /** 镜像的行为：端口上有没有人听、HTTP 路径返回什么 */
  imageOf(image: string): ImageBehavior | undefined;
  now(): number;
  /**
   * 哪些地址能从哪些分区到达。
   *
   * Gateway 与 LoadBalancer 把集群里的服务暴露到某个分区，就是往这里加条目。
   * 不在表里的地址，办公网与外网都够不到 —— Pod IP 天然如此。
   */
  exposure?(address: string): Zone[];
  /**
   * 集群里现在有没有一个会执行 NetworkPolicy 的 CNI。
   *
   * 不给就当作「有」（单元测试里不必每次都装一个 CNI）。
   */
  policyEnforced?(): boolean;
  /**
   * 这个地址归不归某个 Gateway 管、这个请求该转到哪。
   *
   * 由集群注入，网络层自己不认识 Gateway 的 CRD —— 数据面只管「转给谁」。
   */
  /**
   * 客户端信任哪些根。
   *
   * 办公网的机器读 `/etc/ssl/certs/ca-certificates.crt`，Pod 读挂进去的 bundle。
   * 内网 CA 没装进信任库，就是 `unable to get local issuer certificate`。
   */
  trustBundle?(source: Source): Certificate[];
  /**
   * 服务端在这个端口上出示什么证书链。
   *
   * Gateway 的 HTTPS listener 从 `tls.certificateRefs` 指的 Secret 里拿，
   * 没配就是「这个端口不讲 TLS」。
   */
  serverChain?(input: { address: string; port: number; host: string }): Certificate[] | undefined;
  gatewayRoute?(address: string, request: { host: string; port: number; path: string }): {
    gateway: string;
    route?: string;
    backend?: { namespace: string; name: string; port: number };
    /**
     * 转发这一跳的数据面 Pod。
     *
     * Gateway 后面那段流量的源头不是办公网，而是 envoy 自己的 Pod ——
     * NetworkPolicy 看到的就是它。少了这一条，「只允许 Gateway 访问」
     * 这种再常见不过的策略在这里就写不出来。
     */
    proxyPod?: { namespace: string; name: string };
    status?: number;
    detail: string;
  } | undefined;
}

/** 连一次要多久（虚拟毫秒）。超时按 kube-proxy 的默认行为算。 */
const LATENCY = { dns: 2, hop: 1, app: 8 };
export const CONNECT_TIMEOUT_MS = 30_000;

export class Network {
  constructor(private readonly deps: NetworkDeps) {}

  /** Pod 的 resolv.conf，`kubectl exec ... cat /etc/resolv.conf` 就该打这个 */
  resolvConfOf(namespace: string): string {
    return [
      `search ${namespace}.svc.${CLUSTER_DOMAIN} svc.${CLUSTER_DOMAIN} ${CLUSTER_DOMAIN}`,
      'nameserver 10.96.0.10',
      'options ndots:5',
      '',
    ].join('\n');
  }

  /** 只查名字，不连。`dig` / `nslookup` 用它。 */
  resolve(name: string, source: Source): Resolution {
    return resolve(name, { view: this.dnsView(), source, dnsReachable: this.dnsReachable(source) });
  }

  /**
   * 连一次。
   *
   * 返回的 hops 是完整的包路径，拓扑的数据面层与 Hubble 的流日志都读它。
   */
  connect(source: Source, target: Target): ConnectResult {
    const hops: Hop[] = [];
    let elapsed = 0;

    // 1. 名字解析。`--resolve` 指定了地址就跳过这一步。
    let addresses: string[];
    if (target.address) {
      addresses = [target.address];
      hops.push({
        at: 'dns',
        detail: `${target.host} -> ${target.address}（--resolve，没查 DNS）`,
        verdict: 'forward',
        elapsedMs: 0,
      });
    } else if (isIpv4(target.host)) {
      addresses = [target.host];
    } else {
      const answer = this.resolve(target.host, source);
      elapsed += LATENCY.dns;
      hops.push({
        at: 'dns',
        detail: answer.addresses.length
          ? `${target.host} -> ${answer.addresses.join(',')}`
          : `${target.host}: NXDOMAIN（试过 ${answer.attempts.length} 个名字）`,
        verdict: answer.addresses.length ? 'forward' : 'drop',
        elapsedMs: LATENCY.dns,
      });
      if (answer.addresses.length === 0) {
        return {
          kind: 'dns-failure', hops, elapsedMs: elapsed,
          blockedBy: this.dnsReachable(source) ? 'NXDOMAIN' : 'DNS unreachable',
        };
      }
      addresses = answer.addresses;
    }

    const address = addresses[0];

    // 2. 这个分区够不够得到这个地址
    if (!this.reachable(source.zone, address)) {
      elapsed += LATENCY.hop;
      hops.push({
        at: `net/${source.zone}`,
        detail: `${address} 不在 ${source.zone} 能到达的范围里`,
        verdict: 'drop',
        elapsedMs: LATENCY.hop,
      });
      return { kind: 'no-route', hops, elapsedMs: elapsed, blockedBy: 'no route to host' };
    }

    // 3. 这个地址归不归某个 Gateway 管
    const gateway = this.deps.gatewayRoute?.(address, {
      host: target.headerHost ?? target.host,
      port: target.port,
      path: target.path ?? '/',
    });
    let serviceOverride: KubeObject | undefined;
    let portOverride: number | undefined;
    let policySource: Source = source;
    if (gateway) {
      elapsed += LATENCY.hop;
      hops.push({
        at: gateway.route ? `${gateway.gateway} -> httproute/${gateway.route}` : gateway.gateway,
        detail: gateway.detail,
        verdict: gateway.backend ? 'forward' : 'reject',
        elapsedMs: LATENCY.hop,
      });
      if (!gateway.backend) {
        // Gateway 活着，只是没有路由匹配上 —— 是 404 不是连不上
        return {
          kind: 'ok',
          status: gateway.status ?? 404,
          body: `${gateway.status ?? 404} ${gateway.detail}\n`,
          hops,
          elapsedMs: elapsed,
        };
      }
      serviceOverride = this.serviceByName(gateway.backend.namespace, gateway.backend.name);
      portOverride = gateway.backend.port;
      // 过了 Gateway 之后，这条连接的源头是 envoy 的 Pod
      if (gateway.proxyPod) {
        policySource = {
          zone: 'cluster',
          namespace: gateway.proxyPod.namespace,
          podName: gateway.proxyPod.name,
          label: gateway.proxyPod.name,
        };
      }
      if (!serviceOverride) {
        return {
          kind: 'ok', status: 503,
          body: '503 backend service not found\n',
          hops, elapsedMs: elapsed,
        };
      }
    }

    // 4. 目标是 Service 还是 Pod
    const service = serviceOverride ?? this.serviceByClusterIp(address);
    const servicePort = portOverride ?? target.port;
    const backends = service
      ? this.backendsOf(service, servicePort)
      : this.podByIp(address)
        ? [{ pod: this.podByIp(address)!, port: target.port }]
        : [];

    if (service) {
      elapsed += LATENCY.hop;
      hops.push({
        at: `svc/${service.metadata.namespace}/${service.metadata.name}`,
        detail: backends.length
          ? `${service.metadata.name}:${servicePort} -> ${backends.length} 个后端`
          : `${service.metadata.name}:${servicePort} 没有后端（Endpoints 为空）`,
        verdict: backends.length ? 'forward' : 'reject',
        elapsedMs: LATENCY.hop,
      });
      if (backends.length === 0) {
        // Service 有 VIP 但没有 Endpoints：kube-proxy 直接回 RST
        return { kind: 'refused', hops, elapsedMs: elapsed, blockedBy: 'no endpoints' };
      }
    }

    if (backends.length === 0) {
      elapsed += LATENCY.hop;
      hops.push({ at: `host/${address}`, detail: '没有这台主机', verdict: 'drop', elapsedMs: LATENCY.hop });
      return { kind: 'no-route', hops, elapsedMs: elapsed, blockedBy: 'no route to host' };
    }

    // 5. 网络策略。两端都要放行，被拒绝表现为丢包 -> 超时。
    const chosen = backends[0];
    const decision = evaluate(this.policies(), {
      source: this.peerOf(policySource),
      destination: this.peerOfPod(chosen.pod),
      port: chosen.port,
      protocol: 'TCP',
    });
    if (!decision.allowed) {
      hops.push({
        at: `policy/${decision.blockedBy}`,
        detail: '包被丢弃（NetworkPolicy 默认拒绝），表现为超时而不是拒绝',
        verdict: 'drop',
        elapsedMs: CONNECT_TIMEOUT_MS,
      });
      return {
        kind: 'timeout',
        hops,
        elapsedMs: elapsed + CONNECT_TIMEOUT_MS,
        blockedBy: decision.blockedBy,
      };
    }
    if (decision.egress.allowedBy || decision.ingress.allowedBy) {
      hops.push({
        at: 'policy',
        detail: [
          decision.egress.allowedBy && `egress 放行：${decision.egress.allowedBy}`,
          decision.ingress.allowedBy && `ingress 放行：${decision.ingress.allowedBy}`,
        ].filter(Boolean).join('；'),
        verdict: 'forward',
        elapsedMs: 0,
      });
    }

    // 6. TLS 握手。证书验不过就在这里断，还没到应用。
    if (target.tls) {
      const handshake = this.handshake(source, target, address, hops);
      if (handshake) return { ...handshake, elapsedMs: elapsed + handshake.elapsedMs };
      elapsed += LATENCY.hop;
    }

    // 7. 端口上有没有人听、应用怎么答
    return this.deliver(chosen.pod, chosen.port, target, hops, elapsed);
  }

  /**
   * TLS 握手。
   *
   * 验不过就返回一个失败结果 —— 注意这时候**请求还没发出去**，
   * 所以应用日志里什么都不会有。这是排查证书问题时最容易走错的方向。
   */
  private handshake(
    source: Source,
    target: Target,
    address: string,
    hops: Hop[]
  ): (Omit<ConnectResult, 'elapsedMs'> & { elapsedMs: number }) | undefined {
    const serverName = target.serverName ?? target.headerHost ?? target.host;
    const chain = this.deps.serverChain?.({ address, port: target.port, host: serverName });

    if (!chain || chain.length === 0) {
      hops.push({
        at: `tls/${address}:${target.port}`,
        detail: '这个端口不讲 TLS',
        verdict: 'reject',
        elapsedMs: LATENCY.hop,
      });
      return {
        kind: 'reset', hops, elapsedMs: LATENCY.hop,
        blockedBy: 'wrong version number（对面不是 TLS 端口）',
      };
    }

    if (target.insecure) {
      hops.push({
        at: `tls/${serverName}`,
        detail: `跳过校验（-k），对面是 ${chain[0].subject.commonName}`,
        verdict: 'forward',
        elapsedMs: LATENCY.hop,
      });
      return undefined;
    }

    const result = verifyChain({
      chain,
      roots: this.deps.trustBundle?.(source) ?? [],
      hostname: serverName,
      now: this.deps.now(),
    });
    hops.push({
      at: `tls/${serverName}`,
      detail: result.ok
        ? `链验证通过（${result.path!.map((item) => item.subject.commonName).join(' <- ')}）`
        : result.error!,
      verdict: result.ok ? 'forward' : 'reject',
      elapsedMs: LATENCY.hop,
    });
    if (result.ok) return undefined;
    return { kind: 'reset', hops, elapsedMs: LATENCY.hop, blockedBy: result.error };
  }

  private deliver(
    pod: KubeObject,
    port: number,
    target: Target,
    hops: Hop[],
    elapsed: number
  ): ConnectResult {
    const containers = ((pod.spec ?? {}) as any).containers ?? [];
    const behavior = this.deps.imageOf(containers[0]?.image) ?? {};
    const listens = behavior.listens ?? declaredPorts(containers);
    const podRef = `pod/${pod.metadata.namespace}/${pod.metadata.name}`;

    if (!isRunning(pod)) {
      hops.push({ at: podRef, detail: 'Pod 不在 Running', verdict: 'reject', elapsedMs: LATENCY.hop });
      return { kind: 'refused', hops, elapsedMs: elapsed + LATENCY.hop, blockedBy: 'pod not running' };
    }
    if (listens.length > 0 && !listens.includes(port)) {
      hops.push({
        at: podRef,
        detail: `${port} 端口上没有人听（它在听 ${listens.join(',')}）`,
        verdict: 'reject',
        elapsedMs: LATENCY.hop,
      });
      return { kind: 'refused', hops, elapsedMs: elapsed + LATENCY.hop, blockedBy: 'connection refused' };
    }

    const path = target.path ?? '/';
    const status = behavior.routes?.[path] ?? (behavior.routes ? 404 : 200);
    hops.push({
      at: podRef,
      detail: `${target.method ?? 'GET'} ${path} -> ${status}`,
      verdict: 'deliver',
      elapsedMs: LATENCY.app,
    });
    return {
      kind: 'ok',
      status,
      body: bodyFor(status, pod),
      hops,
      elapsedMs: elapsed + LATENCY.app,
    };
  }

  /* ---------------- 从 apiserver 里读出来的视图 ---------------- */

  private list(resource: string, namespace?: string): KubeObject[] {
    const definition = this.deps.scheme.get({ group: '', version: 'v1', resource });
    if (!definition) return [];
    return this.deps.registry.list(definition, { namespace }).items;
  }

  /**
   * 生效中的 NetworkPolicy。
   *
   * 注意是「生效中的」：没有会执行策略的 CNI 时，这里返回空 ——
   * 对象还在 apiserver 里，`kubectl get netpol` 照样看得见，但一个包都不拦。
   * 真集群里这正是最难查的一类问题：你以为加了防护，其实什么都没发生。
   */
  policies(): KubeObject[] {
    if (this.deps.policyEnforced && !this.deps.policyEnforced()) return [];
    const definition = this.deps.scheme.get({
      group: 'networking.k8s.io', version: 'v1', resource: 'networkpolicies',
    });
    if (!definition) return [];
    return this.deps.registry.list(definition).items;
  }

  private dnsView(): DnsView {
    return {
      service: (namespace, name) => {
        const found = this.list('services', namespace).find((item) => item.metadata.name === name);
        if (!found) return undefined;
        const spec = (found.spec ?? {}) as any;
        return {
          clusterIP: spec.clusterIP,
          externalName: spec.externalName,
          headless: spec.clusterIP === 'None' || (!spec.clusterIP && !spec.externalName),
        };
      },
      endpoints: (namespace, name) => {
        const found = this.list('endpoints', namespace).find((item) => item.metadata.name === name);
        return ((found?.subsets ?? []) as any[]).flatMap((subset) =>
          (subset.addresses ?? []).map((entry: any) => entry.ip)
        );
      },
      external: (name) => this.deps.externalHosts?.[name],
    };
  }

  private serviceByName(namespace: string, name: string): KubeObject | undefined {
    return this.list('services', namespace).find((item) => item.metadata.name === name);
  }

  private serviceByClusterIp(ip: string): KubeObject | undefined {
    return this.list('services').find((item) => ((item.spec ?? {}) as any).clusterIP === ip);
  }

  private podByIp(ip: string): KubeObject | undefined {
    return this.list('pods').find((item) => ((item.status ?? {}) as any).podIP === ip);
  }

  /** Service 后面挂着哪些 Ready 的 Pod，以及要打到它们的哪个端口 */
  private backendsOf(service: KubeObject, port: number): Array<{ pod: KubeObject; port: number }> {
    const spec = (service.spec ?? {}) as any;
    const mapping = (spec.ports ?? []).find((entry: any) => entry.port === port);
    if (!mapping) return [];
    const targetPort = Number(mapping.targetPort ?? mapping.port);

    const namespace = service.metadata.namespace;
    const endpoints = this.list('endpoints', namespace)
      .find((item) => item.metadata.name === service.metadata.name);
    const ips = ((endpoints?.subsets ?? []) as any[]).flatMap((subset) =>
      (subset.addresses ?? []).map((entry: any) => entry.ip)
    );
    return ips
      .map((ip) => this.podByIp(ip))
      .filter((pod): pod is KubeObject => Boolean(pod))
      .map((pod) => ({ pod, port: targetPort }));
  }

  private peerOf(source: Source): PolicyPeer {
    if (source.zone !== 'cluster' || !source.podName) {
      return { ip: source.ip ?? '10.10.0.1' };
    }
    const pod = this.list('pods', source.namespace)
      .find((item) => item.metadata.name === source.podName);
    return pod ? this.peerOfPod(pod) : { ip: source.ip };
  }

  private peerOfPod(pod: KubeObject): PolicyPeer {
    return {
      namespace: pod.metadata.namespace,
      labels: pod.metadata.labels,
      namespaceLabels: this.namespaceLabels(pod.metadata.namespace),
      ip: ((pod.status ?? {}) as any).podIP,
    };
  }

  private namespaceLabels(namespace?: string): Record<string, string> {
    if (!namespace) return {};
    const found = this.list('namespaces').find((item) => item.metadata.name === namespace);
    // 真集群会自动打上 kubernetes.io/metadata.name，很多策略靠它选命名空间
    return { 'kubernetes.io/metadata.name': namespace, ...(found?.metadata.labels ?? {}) };
  }

  /**
   * DNS 通不通。
   *
   * 写了 egress 策略却没放行 kube-system 的 53 端口，是这一层最常见的自伤。
   */
  private dnsReachable(source: Source): boolean {
    if (source.zone !== 'cluster' || !source.podName) return true;
    const decision = evaluate(this.policies(), {
      source: this.peerOf(source),
      destination: {
        namespace: 'kube-system',
        labels: { 'k8s-app': 'kube-dns' },
        namespaceLabels: this.namespaceLabels('kube-system'),
        ip: '10.96.0.10',
      },
      port: 53,
      protocol: 'UDP',
    });
    return decision.egress.allowed;
  }

  /** 这个分区够不够得到这个地址 */
  private reachable(zone: Zone, address: string): boolean {
    if (zone === 'cluster' || zone === 'node') return true;
    const exposed = this.deps.exposure?.(address) ?? [];
    if (exposed.includes(zone)) return true;
    // 办公网能到节点，到不了 Pod 网段与 ClusterIP —— 这是分区的意义所在
    if (zone === 'office') return this.nodeAddresses().includes(address) || this.isExternal(address);
    return this.isExternal(address);
  }

  private nodeAddresses(): string[] {
    return this.list('nodes').flatMap((node) =>
      (((node.status ?? {}) as any).addresses ?? [])
        .filter((entry: any) => entry.type === 'InternalIP')
        .map((entry: any) => entry.address)
    );
  }

  private isExternal(address: string): boolean {
    return Object.values(this.deps.externalHosts ?? {}).some((list) => list.includes(address));
  }
}

function isRunning(pod: KubeObject): boolean {
  return ((pod.status ?? {}) as any).phase === 'Running';
}

function declaredPorts(containers: any[]): number[] {
  return containers.flatMap((container) =>
    (container.ports ?? []).map((entry: any) => Number(entry.containerPort))
  ).filter((port: number) => Number.isFinite(port));
}

function bodyFor(status: number, pod: KubeObject): string {
  if (status >= 200 && status < 300) return `${pod.metadata.name}\n`;
  if (status === 404) return '404 page not found\n';
  return `HTTP ${status}\n`;
}

export function createNetwork(deps: NetworkDeps): Network {
  return new Network(deps);
}
