/**
 * Gateway API 与 Envoy Gateway
 *
 * 两件事要成立：
 *  1. 控制器是**集群里的一个工作负载**。把它卸载掉，Gateway 就不再被 program。
 *     第 8 关最后一步「旧控制器彻底下线」之所以判定得了，靠的就是这条。
 *  2. 内网入口与公网入口的分野在 `loadBalancerClass` 上，不在 Gateway 自己身上。
 */
import { createCluster } from '../../src/lib/opslab/controllers';
import { hostnameMatches } from '../../src/lib/opslab/gateway';
import type { KubeObject } from '../../src/lib/opslab/apiserver';
import type { Source } from '../../src/lib/opslab/net';

const IMAGE = 'harbor.corp.internal/team/portal:1.4.0';
const OFFICE: Source = { zone: 'office', label: 'jump-01', ip: '10.10.1.5' };
const INTERNET: Source = { zone: 'internet', label: 'outside', ip: '203.0.113.9' };

const POOLS = [
  { loadBalancerClass: 'corp.internal/office-lb', cidrPrefix: '10.10.8', zones: ['office'] as const },
  { loadBalancerClass: 'corp.internal/public-lb', cidrPrefix: '203.0.113', zones: ['office', 'internet'] as const },
];

/** Envoy Gateway 自己：一个跑在 envoy-gateway-system 里的 Deployment */
const controllerDeployment = () => ({
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: {
    name: 'envoy-gateway', namespace: 'envoy-gateway-system',
    labels: { 'app.kubernetes.io/name': 'envoy-gateway' },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { 'app.kubernetes.io/name': 'envoy-gateway' } },
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': 'envoy-gateway' } },
      spec: { containers: [{ name: 'controller', image: IMAGE }] },
    },
  },
} as unknown as KubeObject);

const envoyProxy = (name: string, loadBalancerClass: string) => ({
  apiVersion: 'gateway.envoyproxy.io/v1alpha1', kind: 'EnvoyProxy',
  metadata: { name, namespace: 'envoy-gateway-system' },
  spec: { provider: { kubernetes: { envoyService: { loadBalancerClass } } } },
} as unknown as KubeObject);

const gatewayClass = (name: string, parameters: string) => ({
  apiVersion: 'gateway.networking.k8s.io/v1', kind: 'GatewayClass',
  metadata: { name },
  spec: {
    controllerName: 'gateway.envoyproxy.io/gatewayclass-controller',
    parametersRef: {
      group: 'gateway.envoyproxy.io', kind: 'EnvoyProxy',
      name: parameters, namespace: 'envoy-gateway-system',
    },
  },
} as unknown as KubeObject);

const gateway = (name: string, className: string, hostname?: string) => ({
  apiVersion: 'gateway.networking.k8s.io/v1', kind: 'Gateway',
  metadata: { name, namespace: 'payments' },
  spec: {
    gatewayClassName: className,
    listeners: [{ name: 'http', port: 80, protocol: 'HTTP', hostname }],
  },
} as unknown as KubeObject);

const httpRoute = (name: string, options: {
  hostnames?: string[];
  rules: Array<{ path?: string; backend: string; port: number }>;
}) => ({
  apiVersion: 'gateway.networking.k8s.io/v1', kind: 'HTTPRoute',
  metadata: { name, namespace: 'payments' },
  spec: {
    parentRefs: [{ name: 'corp-gw', namespace: 'payments' }],
    hostnames: options.hostnames,
    rules: options.rules.map((rule) => ({
      matches: [{ path: { type: 'PathPrefix', value: rule.path ?? '/' } }],
      backendRefs: [{ name: rule.backend, port: rule.port }],
    })),
  },
} as unknown as KubeObject);

const app = (name: string) => [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace: 'payments' },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: { containers: [{ name: 'web', image: IMAGE, ports: [{ containerPort: 8080 }] }] },
      },
    },
  },
  {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name, namespace: 'payments' },
    spec: { clusterIP: `10.96.1.${name.length}`, selector: { app: name }, ports: [{ port: 80, targetPort: 8080 }] },
  },
] as unknown as KubeObject[];

async function world(objects: KubeObject[]) {
  const cluster = createCluster({
    namespaces: ['default', 'kube-system', 'payments', 'envoy-gateway-system'],
    images: { [IMAGE]: { listens: [8080], routes: { '/': 200, '/healthz': 200, '/api/orders': 200 } } },
    addressPools: POOLS as never,
  });
  cluster.start();
  for (const object of objects) {
    const [group, version] = object.apiVersion.includes('/')
      ? object.apiVersion.split('/')
      : ['', object.apiVersion];
    const definition = cluster.scheme.resolveKind(group, version, object.kind)!;
    if (!definition) throw new Error(`未注册：${object.apiVersion} ${object.kind}`);
    cluster.registry.create(
      definition,
      definition.namespaced ? object.metadata.namespace ?? 'default' : undefined,
      object
    );
  }
  await cluster.settle();
  return cluster;
}

function gatewayStatus(cluster: Awaited<ReturnType<typeof world>>) {
  return cluster.registry.get(
    cluster.scheme.mustGet({ group: 'gateway.networking.k8s.io', version: 'v1', resource: 'gateways' }),
    'payments', 'corp-gw'
  ).status as any;
}

describe('控制器是集群里的一个工作负载', () => {
  it('控制器没装：Gateway 停在 Programmed=Unknown，没有地址', async () => {
    const cluster = await world([
      envoyProxy('office', 'corp.internal/office-lb'),
      gatewayClass('envoy-internal', 'office'),
      gateway('corp-gw', 'envoy-internal'),
    ]);
    const status = gatewayStatus(cluster);
    expect(status.addresses).toEqual([]);
    expect(status.conditions.find((c: any) => c.type === 'Programmed').status).toBe('Unknown');
  });

  it('装上控制器之后被 program，并且拿到一个内网地址', async () => {
    const cluster = await world([
      controllerDeployment(),
      envoyProxy('office', 'corp.internal/office-lb'),
      gatewayClass('envoy-internal', 'office'),
      gateway('corp-gw', 'envoy-internal'),
    ]);
    const status = gatewayStatus(cluster);
    expect(status.conditions.find((c: any) => c.type === 'Programmed').status).toBe('True');
    expect(status.addresses[0].value).toMatch(/^10\.10\.8\./);
  });

  it('把控制器删掉，Gateway 退回 Programmed=Unknown', async () => {
    const cluster = await world([
      controllerDeployment(),
      envoyProxy('office', 'corp.internal/office-lb'),
      gatewayClass('envoy-internal', 'office'),
      gateway('corp-gw', 'envoy-internal'),
    ]);
    expect(gatewayStatus(cluster).conditions.find((c: any) => c.type === 'Programmed').status).toBe('True');

    cluster.registry.delete(
      cluster.scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' }),
      'envoy-gateway-system', 'envoy-gateway'
    );
    await cluster.settle();
    expect(gatewayStatus(cluster).conditions.find((c: any) => c.type === 'Programmed').status).toBe('Unknown');
  });

  it('别人的 GatewayClass 不插手', async () => {
    const cluster = await world([
      controllerDeployment(),
      {
        apiVersion: 'gateway.networking.k8s.io/v1', kind: 'GatewayClass',
        metadata: { name: 'nginx' },
        spec: { controllerName: 'k8s.io/ingress-nginx' },
      } as unknown as KubeObject,
      gateway('corp-gw', 'nginx'),
    ]);
    expect(gatewayStatus(cluster)).toBeUndefined();
  });
});

describe('地址与清理', () => {
  it('两个 Gateway 拿到不同的地址 —— 撞了路由会串到别人身上', async () => {
    const cluster = await world([
      controllerDeployment(),
      envoyProxy('office', 'corp.internal/office-lb'),
      gatewayClass('envoy-internal', 'office'),
      gateway('corp-gw', 'envoy-internal'),
      {
        apiVersion: 'gateway.networking.k8s.io/v1', kind: 'Gateway',
        metadata: { name: 'other-gw', namespace: 'payments' },
        spec: {
          gatewayClassName: 'envoy-internal',
          listeners: [{ name: 'http', port: 80, protocol: 'HTTP' }],
        },
      } as unknown as KubeObject,
    ]);
    const gateways = cluster.registry.list(
      cluster.scheme.mustGet({ group: 'gateway.networking.k8s.io', version: 'v1', resource: 'gateways' })
    ).items;
    const addresses = gateways.map((item) => (item.status as any).addresses[0].value);
    expect(addresses).toHaveLength(2);
    expect(new Set(addresses).size).toBe(2);
  });

  it('Gateway 删掉之后，它的 Service 也不在了', async () => {
    const cluster = await world([
      controllerDeployment(),
      envoyProxy('office', 'corp.internal/office-lb'),
      gatewayClass('envoy-internal', 'office'),
      gateway('corp-gw', 'envoy-internal'),
    ]);
    const services = cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'services' });
    expect(cluster.registry.list(services, { namespace: 'envoy-gateway-system' }).items).toHaveLength(1);

    cluster.registry.delete(
      cluster.scheme.mustGet({ group: 'gateway.networking.k8s.io', version: 'v1', resource: 'gateways' }),
      'payments', 'corp-gw'
    );
    await cluster.settle();
    expect(cluster.registry.list(services, { namespace: 'envoy-gateway-system' }).items).toHaveLength(0);
  });
});

describe('内网入口与公网入口', () => {
  const base = (loadBalancerClass: string) => [
    controllerDeployment(),
    envoyProxy('params', loadBalancerClass),
    gatewayClass('envoy-class', 'params'),
    gateway('corp-gw', 'envoy-class'),
    ...app('portal'),
    httpRoute('portal', { rules: [{ backend: 'portal', port: 80 }] }),
  ];

  it('内网 class：办公网通、外网不通', async () => {
    const cluster = await world(base('corp.internal/office-lb'));
    const address = gatewayStatus(cluster).addresses[0].value;

    expect(cluster.network.connect(OFFICE, { host: address, port: 80, path: '/' }).kind).toBe('ok');
    expect(cluster.network.connect(INTERNET, { host: address, port: 80, path: '/' }).kind).toBe('no-route');
  });

  it('公网 class：两边都通', async () => {
    const cluster = await world(base('corp.internal/public-lb'));
    const address = gatewayStatus(cluster).addresses[0].value;
    expect(address).toMatch(/^203\.0\.113\./);

    expect(cluster.network.connect(OFFICE, { host: address, port: 80, path: '/' }).kind).toBe('ok');
    expect(cluster.network.connect(INTERNET, { host: address, port: 80, path: '/' }).kind).toBe('ok');
  });
});

describe('路由', () => {
  async function routed(routes: KubeObject[]) {
    const cluster = await world([
      controllerDeployment(),
      envoyProxy('office', 'corp.internal/office-lb'),
      gatewayClass('envoy-internal', 'office'),
      gateway('corp-gw', 'envoy-internal'),
      ...app('portal'),
      ...app('orders'),
      ...routes,
    ]);
    return { cluster, address: gatewayStatus(cluster).addresses[0].value };
  }

  it('按路径前缀分发，长前缀优先', async () => {
    const { cluster, address } = await routed([
      httpRoute('portal', {
        rules: [
          { path: '/', backend: 'portal', port: 80 },
          { path: '/api', backend: 'orders', port: 80 },
        ],
      }),
    ]);
    const root = cluster.network.connect(OFFICE, { host: address, port: 80, path: '/' });
    expect(root.hops.some((hop) => hop.detail.includes('portal:80'))).toBe(true);

    const api = cluster.network.connect(OFFICE, { host: address, port: 80, path: '/api/orders' });
    expect(api.hops.some((hop) => hop.detail.includes('orders:80'))).toBe(true);
  });

  it('没有路由匹配是 404，不是连不上 —— 这两种要分得开', async () => {
    const { cluster, address } = await routed([
      httpRoute('portal', { hostnames: ['portal.corp.internal'], rules: [{ backend: 'portal', port: 80 }] }),
    ]);
    const wrongHost = cluster.network.connect(OFFICE, { host: address, port: 80, path: '/' });
    expect(wrongHost.kind).toBe('ok');
    expect(wrongHost.status).toBe(404);
  });

  it('后端 Service 不存在时，HTTPRoute 的 ResolvedRefs 说得清清楚楚', async () => {
    const { cluster } = await routed([
      httpRoute('broken', { rules: [{ backend: 'ghost', port: 80 }] }),
    ]);
    const route = cluster.registry.get(
      cluster.scheme.mustGet({ group: 'gateway.networking.k8s.io', version: 'v1', resource: 'httproutes' }),
      'payments', 'broken'
    );
    const resolved = ((route.status as any).parents[0].conditions as any[])
      .find((entry) => entry.type === 'ResolvedRefs');
    expect(resolved.status).toBe('False');
    expect(resolved.reason).toBe('BackendNotFound');
    expect(resolved.message).toContain('ghost');
  });

  it('listener 上挂了几条路由，写在 Gateway 的 status 里', async () => {
    const { cluster } = await routed([
      httpRoute('a', { rules: [{ backend: 'portal', port: 80 }] }),
      httpRoute('b', { rules: [{ path: '/api', backend: 'orders', port: 80 }] }),
    ]);
    expect(gatewayStatus(cluster).listeners[0].attachedRoutes).toBe(2);
  });
});

describe('hostname 通配', () => {
  it.each([
    ['portal.corp.internal', 'portal.corp.internal', true],
    ['*.corp.internal', 'portal.corp.internal', true],
    ['*.corp.internal', 'corp.internal', false],
    ['*.corp.internal', 'a.b.corp.internal', true],
    ['portal.corp.internal', 'other.corp.internal', false],
  ])('%s 匹配 %s', (pattern, host, expected) => {
    expect(hostnameMatches(pattern, host)).toBe(expected);
  });
});
