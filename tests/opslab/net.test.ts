/**
 * 网络：连不上的时候，症状要能反推出是哪一层的问题
 *
 * 这一套用例的组织方式就是那张排查表：每一条对应一种症状，
 * 断言的是「这种情况下学员看到的是什么」。
 */
import { createCluster } from '../../src/lib/opslab/controllers';
import { candidatesFor, evaluate, inCidr, isIpv4 } from '../../src/lib/opslab/net';
import type { KubeObject } from '../../src/lib/opslab/apiserver';
import type { Source } from '../../src/lib/opslab/net';

const IMAGE = 'registry.corp.internal/portal:1.4';

const OFFICE: Source = { zone: 'office', label: 'jump-01', ip: '10.10.1.5' };
const inPod = (namespace: string, podName: string): Source =>
  ({ zone: 'cluster', namespace, podName, label: podName });

async function world(options: {
  namespaces?: string[];
  objects?: KubeObject[];
  images?: Record<string, any>;
  externalHosts?: Record<string, string[]>;
} = {}) {
  const cluster = createCluster({
    namespaces: options.namespaces ?? ['default', 'kube-system', 'payments'],
    images: options.images ?? { [IMAGE]: { listens: [8080], routes: { '/': 200, '/healthz': 200 } } },
    externalHosts: options.externalHosts ?? { 'harbor.corp.internal': ['10.10.0.20'] },
  });
  cluster.start();
  for (const object of options.objects ?? []) {
    const [group, version] = object.apiVersion.includes('/')
      ? object.apiVersion.split('/')
      : ['', object.apiVersion];
    const definition = cluster.scheme.resolveKind(group, version, object.kind)!;
    cluster.registry.create(
      definition,
      definition.namespaced ? object.metadata.namespace ?? 'default' : undefined,
      object
    );
  }
  await cluster.settle();
  return cluster;
}

const deployment = (name: string, namespace: string, labels: Record<string, string>) => ({
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: { name, namespace },
  spec: {
    replicas: 1,
    selector: { matchLabels: labels },
    template: {
      metadata: { labels },
      spec: { containers: [{ name: 'app', image: IMAGE, ports: [{ containerPort: 8080 }] }] },
    },
  },
} as unknown as KubeObject);

const service = (name: string, namespace: string, selector: Record<string, string>, clusterIP: string) => ({
  apiVersion: 'v1', kind: 'Service',
  metadata: { name, namespace },
  spec: { clusterIP, selector, ports: [{ port: 80, targetPort: 8080 }] },
} as unknown as KubeObject);

const policy = (name: string, namespace: string, spec: Record<string, unknown>) => ({
  apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
  metadata: { name, namespace }, spec,
} as unknown as KubeObject);

/** 第一个 Pod 的名字，用来当发起方 */
function firstPod(cluster: Awaited<ReturnType<typeof world>>, namespace: string): string {
  return cluster.registry.list(
    cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'pods' }),
    { namespace }
  ).items[0].metadata.name;
}

describe('DNS', () => {
  it('ndots:5 决定 search 域的展开顺序', () => {
    // 点数少于 5：先拼 search 域，最后才试自己
    expect(candidatesFor('portal', 'payments')).toEqual([
      'portal.payments.svc.cluster.local',
      'portal.svc.cluster.local',
      'portal.cluster.local',
      'portal',
    ]);
    /**
     * `portal.payments.svc.cluster.local` 有 4 个点，**少于 5**，所以它仍然
     * 被当成相对名：先去试 `portal.payments.svc.cluster.local.payments.svc.cluster.local`。
     * 这就是集群里 DNS 查询量异常高的那个经典原因，也是为什么讲究的写法
     * 要在末尾加一个点。
     */
    expect(candidatesFor('portal.payments.svc.cluster.local', 'payments')[0])
      .toBe('portal.payments.svc.cluster.local.payments.svc.cluster.local');
    expect(candidatesFor('portal.payments.svc.cluster.local.', 'payments'))
      .toEqual(['portal.payments.svc.cluster.local']);
    // 点数够 5 个才先试自己
    expect(candidatesFor('a.b.c.d.e.f', 'payments')[0]).toBe('a.b.c.d.e.f');
    // 绝对名不拼
    expect(candidatesFor('example.com.', 'payments')).toEqual(['example.com']);
  });

  it('Pod 里解析得到本命名空间的短名字', async () => {
    const cluster = await world({
      objects: [
        deployment('portal', 'payments', { app: 'portal' }),
        service('portal', 'payments', { app: 'portal' }, '10.96.1.10'),
      ],
    });
    const from = inPod('payments', firstPod(cluster, 'payments'));
    expect(cluster.network.resolve('portal', from).addresses).toEqual(['10.96.1.10']);
    expect(cluster.network.resolve('portal.payments.svc.cluster.local', from).addresses)
      .toEqual(['10.96.1.10']);
  });

  it('跨命名空间的短名字解析不出来 —— 要带命名空间', async () => {
    const cluster = await world({
      objects: [
        deployment('portal', 'payments', { app: 'portal' }),
        service('portal', 'payments', { app: 'portal' }, '10.96.1.10'),
        deployment('client', 'default', { app: 'client' }),
      ],
    });
    const from = inPod('default', firstPod(cluster, 'default'));
    expect(cluster.network.resolve('portal', from).kind).toBe('nxdomain');
    expect(cluster.network.resolve('portal.payments', from).addresses).toEqual(['10.96.1.10']);
  });

  it('办公网只解析得到世界里声明过的外部名字', async () => {
    const cluster = await world({
      objects: [
        deployment('portal', 'payments', { app: 'portal' }),
        service('portal', 'payments', { app: 'portal' }, '10.96.1.10'),
      ],
    });
    expect(cluster.network.resolve('harbor.corp.internal', OFFICE).addresses).toEqual(['10.10.0.20']);
    // 集群内的名字，办公网的 DNS 里没有
    expect(cluster.network.resolve('portal.payments.svc.cluster.local', OFFICE).kind).toBe('nxdomain');
  });

  it('IP 直接用，不查 DNS', () => {
    expect(isIpv4('10.96.1.10')).toBe(true);
    expect(isIpv4('portal')).toBe(false);
  });
});

describe('连不上的四种症状', () => {
  it('名字不存在 -> dns-failure', async () => {
    const cluster = await world();
    const result = cluster.network.connect(OFFICE, { host: 'nope.corp.internal', port: 80 });
    expect(result.kind).toBe('dns-failure');
  });

  it('办公网够不到 ClusterIP -> no-route', async () => {
    const cluster = await world({
      objects: [
        deployment('portal', 'payments', { app: 'portal' }),
        service('portal', 'payments', { app: 'portal' }, '10.96.1.10'),
      ],
    });
    const result = cluster.network.connect(OFFICE, { host: '10.96.1.10', port: 80 });
    expect(result.kind).toBe('no-route');
    expect(result.blockedBy).toBe('no route to host');
  });

  it('Service 有 VIP 但没有 Endpoints -> refused，不是超时', async () => {
    const cluster = await world({
      objects: [
        deployment('portal', 'payments', { app: 'portal' }),
        // selector 打错，一个后端都匹配不上
        service('portal', 'payments', { app: 'protal' }, '10.96.1.10'),
        deployment('client', 'payments', { app: 'client' }),
      ],
    });
    const from = inPod('payments', cluster.registry.list(
      cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'pods' }), { namespace: 'payments' }
    ).items.find((pod) => pod.metadata.labels?.app === 'client')!.metadata.name);

    const result = cluster.network.connect(from, { host: 'portal', port: 80 });
    expect(result.kind).toBe('refused');
    expect(result.blockedBy).toBe('no endpoints');
  });

  it('端口上没人听 -> refused', async () => {
    const cluster = await world({
      objects: [
        deployment('portal', 'payments', { app: 'portal' }),
        service('portal', 'payments', { app: 'portal' }, '10.96.1.10'),
        deployment('client', 'payments', { app: 'client' }),
      ],
    });
    const pods = cluster.registry.list(
      cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'pods' }), { namespace: 'payments' }
    ).items;
    const client = pods.find((pod) => pod.metadata.labels?.app === 'client')!;
    const portal = pods.find((pod) => pod.metadata.labels?.app === 'portal')!;

    const result = cluster.network.connect(
      inPod('payments', client.metadata.name),
      { host: (portal.status as any).podIP, port: 9999 }
    );
    expect(result.kind).toBe('refused');
    expect(result.hops[result.hops.length - 1].detail).toContain('没有人听');
  });

  it('一切正常 -> ok，带 HTTP 状态码', async () => {
    const cluster = await world({
      objects: [
        deployment('portal', 'payments', { app: 'portal' }),
        service('portal', 'payments', { app: 'portal' }, '10.96.1.10'),
        deployment('client', 'payments', { app: 'client' }),
      ],
    });
    const pods = cluster.registry.list(
      cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'pods' }), { namespace: 'payments' }
    ).items;
    const client = pods.find((pod) => pod.metadata.labels?.app === 'client')!;

    const result = cluster.network.connect(
      inPod('payments', client.metadata.name),
      { host: 'portal', port: 80, path: '/healthz' }
    );
    expect(result.kind).toBe('ok');
    expect(result.status).toBe(200);
    // 包路径：DNS -> Service -> Pod
    expect(result.hops.map((hop) => hop.at.split('/')[0])).toEqual(['dns', 'svc', 'pod']);
  });
});

describe('NetworkPolicy', () => {
  const clientPolicy = (spec: Record<string, unknown>) => policy('deny', 'payments', spec);

  it('没有策略选中它时全通', () => {
    const decision = evaluate([], {
      source: { namespace: 'payments', labels: { app: 'client' } },
      destination: { namespace: 'payments', labels: { app: 'portal' } },
      port: 8080,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.ingress.isolated).toBe(false);
  });

  it('只写 podSelector 的空策略 = 该方向默认拒绝', () => {
    const decision = evaluate([clientPolicy({ podSelector: { matchLabels: { app: 'portal' } } })], {
      source: { namespace: 'payments', labels: { app: 'client' } },
      destination: { namespace: 'payments', labels: { app: 'portal' } },
      port: 8080,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.ingress.isolated).toBe(true);
  });

  it('按标签放行', () => {
    const allow = clientPolicy({
      podSelector: { matchLabels: { app: 'portal' } },
      ingress: [{ from: [{ podSelector: { matchLabels: { app: 'client' } } }], ports: [{ port: 8080 }] }],
    });
    const traffic = (app: string) => ({
      source: { namespace: 'payments', labels: { app } },
      destination: { namespace: 'payments', labels: { app: 'portal' } },
      port: 8080,
    });
    expect(evaluate([allow], traffic('client')).allowed).toBe(true);
    expect(evaluate([allow], traffic('stranger')).allowed).toBe(false);
  });

  it('端口不匹配也不放行', () => {
    const allow = clientPolicy({
      podSelector: { matchLabels: { app: 'portal' } },
      ingress: [{ from: [{ podSelector: { matchLabels: { app: 'client' } } }], ports: [{ port: 8080 }] }],
    });
    expect(evaluate([allow], {
      source: { namespace: 'payments', labels: { app: 'client' } },
      destination: { namespace: 'payments', labels: { app: 'portal' } },
      port: 9090,
    }).allowed).toBe(false);
  });

  it('两端都要放行 —— 只改一边是最常见的错', () => {
    const egressOnly = policy('egress-only', 'payments', {
      podSelector: { matchLabels: { app: 'client' } },
      policyTypes: ['Egress'],
      egress: [{ to: [{ podSelector: { matchLabels: { app: 'portal' } } }] }],
    });
    const ingressDeny = policy('ingress-deny', 'payments', {
      podSelector: { matchLabels: { app: 'portal' } },
      policyTypes: ['Ingress'],
    });
    const decision = evaluate([egressOnly, ingressDeny], {
      source: { namespace: 'payments', labels: { app: 'client' } },
      destination: { namespace: 'payments', labels: { app: 'portal' } },
      port: 8080,
    });
    expect(decision.egress.allowed).toBe(true);
    expect(decision.ingress.allowed).toBe(false);
    expect(decision.blockedBy).toContain('ingress:');
  });

  it('没写 namespaceSelector 时，podSelector 只在策略自己的命名空间里找', () => {
    const allow = policy('from-client', 'payments', {
      podSelector: { matchLabels: { app: 'portal' } },
      ingress: [{ from: [{ podSelector: { matchLabels: { app: 'client' } } }] }],
    });
    const from = (namespace: string) => ({
      source: { namespace, labels: { app: 'client' } },
      destination: { namespace: 'payments', labels: { app: 'portal' } },
      port: 8080,
    });
    expect(evaluate([allow], from('payments')).allowed).toBe(true);
    // 别的命名空间里同名同标签的 Pod 不该被放进来
    expect(evaluate([allow], from('other')).allowed).toBe(false);
  });

  it('namespaceSelector 认命名空间的标签', () => {
    const allow = policy('from-monitoring', 'payments', {
      podSelector: {},
      ingress: [{ from: [{ namespaceSelector: { matchLabels: { team: 'sre' } } }] }],
    });
    const from = (namespaceLabels: Record<string, string>) => ({
      source: { namespace: 'other', labels: {}, namespaceLabels },
      destination: { namespace: 'payments', labels: { app: 'portal' } },
      port: 8080,
    });
    expect(evaluate([allow], from({ team: 'sre' })).allowed).toBe(true);
    expect(evaluate([allow], from({ team: 'app' })).allowed).toBe(false);
  });

  it('ipBlock 与 except', () => {
    const allow = policy('from-office', 'payments', {
      podSelector: {},
      ingress: [{ from: [{ ipBlock: { cidr: '10.10.0.0/16', except: ['10.10.9.0/24'] } }] }],
    });
    const from = (ip: string) => ({
      source: { ip },
      destination: { namespace: 'payments', labels: {} },
      port: 8080,
    });
    expect(evaluate([allow], from('10.10.1.5')).allowed).toBe(true);
    expect(evaluate([allow], from('10.10.9.7')).allowed).toBe(false);
    expect(evaluate([allow], from('10.20.0.1')).allowed).toBe(false);
  });

  it.each([
    ['10.42.1.7', '10.42.0.0/16', true],
    ['10.43.1.7', '10.42.0.0/16', false],
    ['10.10.9.7', '10.10.9.0/24', true],
    ['1.2.3.4', '0.0.0.0/0', true],
  ])('%s 在不在 %s 里', (ip, cidr, expected) => {
    expect(inCidr(ip, cidr)).toBe(expected);
  });
});

describe('策略在集群里真的会拦住流量', () => {
  async function twoPods(policies: KubeObject[] = []) {
    const cluster = await world({
      objects: [
        deployment('portal', 'payments', { app: 'portal' }),
        service('portal', 'payments', { app: 'portal' }, '10.96.1.10'),
        deployment('client', 'payments', { app: 'client' }),
        ...policies,
      ],
    });
    const pods = cluster.registry.list(
      cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'pods' }), { namespace: 'payments' }
    ).items;
    return {
      cluster,
      from: inPod('payments', pods.find((pod) => pod.metadata.labels?.app === 'client')!.metadata.name),
    };
  }

  it('被策略拦住表现为超时，不是拒绝 —— 这是最要紧的一条', async () => {
    const { cluster, from } = await twoPods([
      policy('deny-all', 'payments', { podSelector: {}, policyTypes: ['Ingress'] }),
    ]);
    const result = cluster.network.connect(from, { host: 'portal', port: 80 });
    expect(result.kind).toBe('timeout');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(30_000);
    expect(result.hops[result.hops.length - 1].verdict).toBe('drop');
  });

  it('egress 策略忘了放行 DNS，症状是名字解析不了', async () => {
    const { cluster, from } = await twoPods([
      policy('egress-portal-only', 'payments', {
        podSelector: { matchLabels: { app: 'client' } },
        policyTypes: ['Egress'],
        egress: [{ to: [{ podSelector: { matchLabels: { app: 'portal' } } }] }],
      }),
    ]);
    // 用名字连：DNS 先挂
    expect(cluster.network.connect(from, { host: 'portal', port: 80 }).kind).toBe('dns-failure');
    // 直接用 ClusterIP 就通了 —— 这个对比正是定位 DNS 问题的钥匙
    expect(cluster.network.connect(from, { host: '10.96.1.10', port: 80 }).kind).toBe('ok');
  });

  it('放行了 DNS 之后一切正常', async () => {
    const { cluster, from } = await twoPods([
      policy('egress-ok', 'payments', {
        podSelector: { matchLabels: { app: 'client' } },
        policyTypes: ['Egress'],
        egress: [
          { to: [{ podSelector: { matchLabels: { app: 'portal' } } }] },
          {
            to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
            ports: [{ port: 53, protocol: 'UDP' }],
          },
        ],
      }),
    ]);
    const result = cluster.network.connect(from, { host: 'portal', port: 80 });
    expect(result.kind).toBe('ok');
  });
});

describe('网络工具的输出与退出码', () => {
  const { createOpsWorld } = require('../../src/lib/opslab/lab');

  async function jumpHost(objects: KubeObject[] = []) {
    return createOpsWorld({
      world: {
        namespaces: ['default', 'kube-system', 'payments'],
        images: { [IMAGE]: { listens: [8080], routes: { '/': 200, '/healthz': 200, '/boom': 503 } } },
        registries: [{ host: 'harbor.corp.internal', users: { ci: 'pw' } }],
      },
      stage: { objects: objects as never },
    });
  }

  it('curl 解析不了名字：(6) Could not resolve host', async () => {
    const world = await jumpHost();
    const result = await world.run('curl -s http://nope.corp.internal/');
    expect(result.code).toBe(6);
    expect(result.stderr).toBe('curl: (6) Could not resolve host: nope.corp.internal\n');
  });

  it('curl 够不到 ClusterIP：(7) No route to host', async () => {
    const world = await jumpHost([
      deployment('portal', 'payments', { app: 'portal' }),
      service('portal', 'payments', { app: 'portal' }, '10.96.1.10'),
    ]);
    const result = await world.run('curl -s http://10.96.1.10/');
    expect(result.code).toBe(7);
    expect(result.stderr).toContain('No route to host');
  });

  it('dig +short 与完整输出', async () => {
    const world = await jumpHost();
    expect((await world.run('dig +short harbor.corp.internal')).stdout).toBe('10.10.0.20\n');

    const full = await world.run('dig harbor.corp.internal');
    expect(full.stdout).toContain(';; ANSWER SECTION:');
    expect(full.stdout).toContain('harbor.corp.internal.\t30\tIN\tA\t10.10.0.20');

    const missing = await world.run('dig nope.corp.internal');
    expect(missing.code).toBe(9);
    expect(missing.stdout).toContain('status: NXDOMAIN');
  });

  it('nc -z 报连接成功还是失败，-w 的参数不会被当成端口', async () => {
    const world = await jumpHost();
    const refused = await world.run('nc -z -w 2 10.96.1.10 80');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('10.96.1.10 port 80');
    expect(refused.stderr).toContain('No route to host');

    // 选项写在后面也要解析对
    const trailing = await world.run('nc -z 10.96.1.10 80 -w 2');
    expect(trailing.stderr).toContain('10.96.1.10 port 80');
  });

  it('ping 明确说不支持，并指出该用什么', async () => {
    const world = await jumpHost();
    const result = await world.run('ping harbor.corp.internal');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('curl');
    expect(result.stderr).toContain('nc -z');
  });

  it('curl -w %{http_code} 与 -o /dev/null', async () => {
    const world = await jumpHost();
    // 办公网到不了集群，但格式本身要对：先验一个能到的外部地址上的失败路径
    const result = await world.run("curl -s -o /dev/null -w '%{http_code}' http://nope/");
    expect(result.code).toBe(6);
  });

  it('超时会真的花掉虚拟时间', async () => {
    const world = await jumpHost([
      deployment('portal', 'payments', { app: 'portal' }),
      service('portal', 'payments', { app: 'portal' }, '10.96.1.10'),
      deployment('client', 'payments', { app: 'client' }),
      policy('deny-all', 'payments', { podSelector: {}, policyTypes: ['Ingress'] }),
    ]);
    const before = world.now();
    const pods = world.cluster.registry.list(
      world.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'pods' }),
      { namespace: 'payments' }
    ).items;
    const client = pods.find((pod: KubeObject) => pod.metadata.labels?.app === 'client')!;

    const result = world.cluster.network.connect(
      { zone: 'cluster', namespace: 'payments', podName: client.metadata.name, label: 'client' },
      { host: 'portal', port: 80 }
    );
    expect(result.kind).toBe('timeout');
    expect(world.now()).toBe(before);   // connect 自己不推时间，是工具推的
    expect(result.elapsedMs).toBeGreaterThanOrEqual(30_000);
  });
});
