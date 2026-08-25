/**
 * 包路径
 *
 * 排查网络问题时最缺的东西是「这个包到底走到哪一步被拦下的」。
 * 网络层每次连接都留一条 trace，这里把它翻译成拓扑图上的一条路径。
 */
import { buildPacketPath, buildPacketPaths, buildTopology, createOpsWorld } from '../../src/lib/opslab/lab';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';

const IMAGE = 'harbor.corp.internal/team/portal:1.4.0';
const CILIUM = 'quay.io/cilium/cilium:v1.19.2';

function workload(name: string, namespace: string) {
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: { containers: [{ name: 'app', image: IMAGE, ports: [{ containerPort: 8080 }] }] },
      },
    },
  };
}

const WORLD: OpsWorldSpec = {
  namespaces: ['default', 'kube-system', 'shop'],
  images: {
    [IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
    [CILIUM]: { pullMs: 10, startupMs: 10, readyAfterMs: 10, enforcesNetworkPolicy: true },
  },
  objects: [
    {
      apiVersion: 'apps/v1', kind: 'DaemonSet',
      metadata: { name: 'cilium', namespace: 'kube-system' },
      spec: {
        selector: { matchLabels: { app: 'cilium' } },
        template: {
          metadata: { labels: { app: 'cilium' } },
          spec: { containers: [{ name: 'agent', image: CILIUM }] },
        },
      },
    },
    workload('portal', 'shop'),
    workload('ledger', 'shop'),
    {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: 'ledger', namespace: 'shop' },
      spec: { selector: { app: 'ledger' }, ports: [{ port: 80, targetPort: 8080 }] },
    },
  ] as never,
};

async function world(extra: unknown[] = []) {
  return createOpsWorld({ world: { ...WORLD, objects: [...(WORLD.objects ?? []), ...extra] as never } });
}

function podName(w: Awaited<ReturnType<typeof world>>, app: string): string {
  return w.cluster.registry.list(
    w.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'pods' }), { namespace: 'shop' }
  ).items.find((pod) => pod.metadata.labels?.app === app)!.metadata.name!;
}

describe('包路径', () => {
  it('每次连接都留一条 trace', async () => {
    const w = await world();
    expect(w.cluster.network.traces).toHaveLength(0);
    await w.run('curl -s -m 5 http://ledger.shop.svc.cluster.local');
    expect(w.cluster.network.traces).toHaveLength(1);
  });

  it('通的那条路：DNS -> Service -> Pod，每一跳都记下来', async () => {
    const w = await world();
    await w.run(`kubectl exec -n shop pod/${podName(w, 'portal')} -- true`);
    const from = { zone: 'cluster' as const, namespace: 'shop', podName: podName(w, 'portal'), label: 'portal' };
    w.cluster.network.connect(from, { host: 'ledger', port: 80, path: '/' });

    const path = buildPacketPaths(w.cluster)[0];
    expect(path.outcome).toBe('ok');
    expect(path.status).toBe(200);
    expect(path.steps.map((step) => step.at.split('/')[0])).toEqual(['dns', 'svc', 'pod']);
    // 累计耗时是单调不减的
    const times = path.steps.map((step) => step.elapsedMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('被策略拦下时，路径上明确有一跳是 drop', async () => {
    const w = await world([{
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: { name: 'deny-ledger', namespace: 'shop' },
      spec: { podSelector: { matchLabels: { app: 'ledger' } }, policyTypes: ['Ingress'] },
    }]);
    const from = { zone: 'cluster' as const, namespace: 'shop', podName: podName(w, 'portal'), label: 'portal' };
    w.cluster.network.connect(from, { host: 'ledger', port: 80, path: '/' });

    const path = buildPacketPaths(w.cluster)[0];
    expect(path.outcome).toBe('timeout');
    const dropped = path.steps.filter((step) => step.verdict === 'drop');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].at).toContain('policy/');
    expect(dropped[0].detail).toContain('超时');
  });

  it('能对上拓扑节点的跳带上 nodeId，对不上的（DNS、策略）不带', async () => {
    const w = await world();
    const from = { zone: 'cluster' as const, namespace: 'shop', podName: podName(w, 'portal'), label: 'portal' };
    w.cluster.network.connect(from, { host: 'ledger', port: 80, path: '/' });

    const graph = buildTopology(w.cluster, { namespace: 'shop' });
    const path = buildPacketPath(w.cluster.network.traces[0], graph);
    const byPrefix = Object.fromEntries(path.steps.map((step) => [step.at.split('/')[0], step.nodeId]));
    expect(byPrefix.dns).toBeUndefined();
    expect(byPrefix.svc).toBe('Service/shop/ledger');
    expect(byPrefix.pod).toBe(`Pod/shop/${podName(w, 'ledger')}`);
  });

  it('图上没有的节点不硬塞 nodeId', async () => {
    const w = await world();
    const from = { zone: 'cluster' as const, namespace: 'shop', podName: podName(w, 'portal'), label: 'portal' };
    w.cluster.network.connect(from, { host: 'ledger', port: 80, path: '/' });
    // 换一个命名空间的图，shop 里的对象都不在上面
    const graph = buildTopology(w.cluster, { namespace: 'default' });
    const path = buildPacketPath(w.cluster.network.traces[0], graph);
    expect(path.steps.every((step) => step.nodeId === undefined)).toBe(true);
  });

  it('DNS 查不到时路径就停在 dns 那一跳', async () => {
    const w = await world();
    const from = { zone: 'cluster' as const, namespace: 'shop', podName: podName(w, 'portal'), label: 'portal' };
    w.cluster.network.connect(from, { host: 'nope', port: 80, path: '/' });
    const path = buildPacketPaths(w.cluster)[0];
    expect(path.outcome).toBe('dns-failure');
    expect(path.steps).toHaveLength(1);
    expect(path.steps[0].verdict).toBe('drop');
  });

  it('最近的排在最前，而且只留最近若干条', async () => {
    const w = await world();
    const from = { zone: 'cluster' as const, namespace: 'shop', podName: podName(w, 'portal'), label: 'portal' };
    for (let i = 0; i < 30; i += 1) {
      w.cluster.network.connect(from, { host: 'ledger', port: 80, path: `/p${i}` });
    }
    const paths = buildPacketPaths(w.cluster);
    expect(paths.length).toBeLessThanOrEqual(24);
    expect(paths[0].to).toContain('/p29');
    expect(paths[0].id).toBeGreaterThan(paths[1].id);
  });

  it('源和目标写成人能读的样子', async () => {
    const w = await world();
    const from = { zone: 'cluster' as const, namespace: 'shop', podName: podName(w, 'portal'), label: 'portal' };
    w.cluster.network.connect(from, { host: 'ledger', port: 8443, path: '/health', tls: true });
    const path = buildPacketPaths(w.cluster)[0];
    expect(path.from).toBe(`pod/shop/${podName(w, 'portal')}`);
    expect(path.to).toBe('https://ledger:8443/health');
  });
});
