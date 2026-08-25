/**
 * Gateway 的转发决策
 *
 * 一个请求打到 Gateway 的地址上之后，要按 listener 的 hostname、HTTPRoute 的
 * hostnames 与 matches 一层层挑出后端。挑不到任何一条就是 404 —— 而**不是**
 * 连接失败：Gateway 是活的，只是没有路由匹配上。这个区别很重要，
 * 学员看到 404 就该去查路由，看到 connection refused 才去查 Gateway 本身。
 */
import type { KubeObject, Registry, Scheme } from '../apiserver';
import { GATEWAYS, HTTPROUTES } from './resources';

export interface GatewayLookup {
  registry: Registry;
  scheme: Scheme;
}

export interface GatewayDecision {
  /** 命中的 Gateway 与路由，写进包路径里 */
  gateway: string;
  route?: string;
  /** 转给哪个 Service */
  backend?: { namespace: string; name: string; port: number };
  /** 没有路由匹配，或者后端解析不了 */
  status?: number;
  detail: string;
}

/**
 * 这个地址是不是某个 Gateway 的，如果是，这个请求该转到哪。
 *
 * 返回 undefined 表示「这个地址不归任何 Gateway 管」，调用方按普通地址处理。
 */
export function resolveGateway(
  lookup: GatewayLookup,
  address: string,
  request: { host: string; port: number; path: string }
): GatewayDecision | undefined {
  const services = list(lookup, { group: '', version: 'v1', resource: 'services' });
  const owner = services.find((service) =>
    ((service.status ?? {}) as any)?.loadBalancer?.ingress?.some((entry: any) => entry.ip === address)
    && service.metadata.labels?.['gateway.envoyproxy.io/owning-gateway-name']
  );
  if (!owner) return undefined;

  const gatewayName = owner.metadata.labels!['gateway.envoyproxy.io/owning-gateway-name'];
  const gatewayNamespace = owner.metadata.labels!['gateway.envoyproxy.io/owning-gateway-namespace'];
  const reference = `gateway/${gatewayNamespace}/${gatewayName}`;

  let gateway: KubeObject;
  try {
    gateway = lookup.registry.get(GATEWAYS, gatewayNamespace, gatewayName);
  } catch {
    return { gateway: reference, status: 503, detail: 'Gateway 已经不在了' };
  }

  // Gateway 得先被 program 过。控制器没起来的话这里就停住。
  const programmed = ((gateway.status ?? {}) as any).conditions
    ?.find((entry: any) => entry.type === 'Programmed');
  if (programmed?.status !== 'True') {
    return { gateway: reference, status: 503, detail: 'Gateway 还没有被 program' };
  }

  const listener = ((gateway.spec ?? {}) as any).listeners?.find((entry: any) =>
    Number(entry.port) === request.port
    && (!entry.hostname || hostnameMatches(entry.hostname, request.host)));
  if (!listener) {
    return { gateway: reference, status: 404, detail: `${request.port} 端口上没有匹配的 listener` };
  }

  const routes = list(lookup, HTTPROUTES).filter((route) =>
    ((route.spec ?? {}) as any).parentRefs?.some((parent: any) =>
      parent.name === gatewayName
      && (parent.namespace ?? route.metadata.namespace) === gatewayNamespace
      && (!parent.sectionName || parent.sectionName === listener.name)));

  for (const route of sortByName(routes)) {
    const spec = (route.spec ?? {}) as any;
    const hostnames: string[] = spec.hostnames ?? [];
    if (hostnames.length > 0 && !hostnames.some((entry) => hostnameMatches(entry, request.host))) continue;

    for (const rule of bestFirst(spec.rules ?? [])) {
      if (!ruleMatches(rule, request.path)) continue;
      const backend = (rule.backendRefs ?? [])[0];
      if (!backend) {
        return {
          gateway: reference, route: routeRef(route), status: 500,
          detail: '规则匹配上了但没有 backendRef',
        };
      }
      return {
        gateway: reference,
        route: routeRef(route),
        backend: {
          namespace: backend.namespace ?? route.metadata.namespace ?? 'default',
          name: backend.name,
          port: Number(backend.port),
        },
        detail: `${request.path} -> ${backend.name}:${backend.port}`,
      };
    }
  }

  return {
    gateway: reference, status: 404,
    detail: `没有 HTTPRoute 匹配 ${request.host}${request.path}`,
  };
}

/** `*.corp.internal` 这种通配前缀，规则和 Gateway API 一样：只能整段通配 */
export function hostnameMatches(pattern: string, host: string): boolean {
  if (pattern === host) return true;
  if (!pattern.startsWith('*.')) return false;
  const suffix = pattern.slice(1);
  return host.endsWith(suffix) && host.slice(0, host.length - suffix.length).length > 0;
}

function ruleMatches(rule: any, path: string): boolean {
  const matches = rule.matches ?? [{ path: { type: 'PathPrefix', value: '/' } }];
  return matches.some((match: any) => {
    const spec = match.path ?? { type: 'PathPrefix', value: '/' };
    const value = spec.value ?? '/';
    if (spec.type === 'Exact') return path === value;
    if (spec.type === 'RegularExpression') {
      try { return new RegExp(value).test(path); } catch { return false; }
    }
    // PathPrefix 按「路径段」比，`/apix` 不该被 `/api` 匹配上
    return path === value || path.startsWith(value.endsWith('/') ? value : `${value}/`);
  });
}

/** 前缀长的规则优先，和 Gateway API 的优先级规则一致 */
function bestFirst(rules: any[]): any[] {
  return [...rules].sort((a, b) => prefixLengthOf(b) - prefixLengthOf(a));
}

function prefixLengthOf(rule: any): number {
  const matches = rule.matches ?? [];
  return Math.max(0, ...matches.map((match: any) => String(match.path?.value ?? '').length));
}

function sortByName(routes: KubeObject[]): KubeObject[] {
  // 顺序稳定，同样的世界每次挑出同一条
  return [...routes].sort((a, b) => routeRef(a) < routeRef(b) ? -1 : 1);
}

function routeRef(route: KubeObject): string {
  return `${route.metadata.namespace}/${route.metadata.name}`;
}

function list(
  lookup: GatewayLookup,
  definition: { group: string; version: string; resource: string }
): KubeObject[] {
  const found = lookup.scheme.get(definition);
  if (!found) return [];
  return lookup.registry.list(found).items;
}
