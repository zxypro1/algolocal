/**
 * Istio ambient
 *
 * 三条会让人卡住的规则，逐条钉住：
 *  1. 没有 istiod / ztunnel，网格里什么都不发生 —— CRD 还在，判定不生效；
 *  2. PeerAuthentication STRICT 拒明文，表现是连接被重置而不是超时；
 *  3. 带 methods/paths 的授权规则没有 waypoint 就不会被求值。
 */
import { createOpsWorld } from '../../src/lib/opslab/lab';
import { evaluateAuthz, globMatch, spiffeId, strictnessFor } from '../../src/lib/opslab/mesh';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const APP = 'harbor.corp.internal/team/portal:1.4.0';
const ISTIOD = 'docker.io/istio/pilot:1.28.1';
const ZTUNNEL = 'docker.io/istio/ztunnel:1.28.1';

function deployment(name: string, namespace: string, serviceAccount?: string) {
  return {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          ...(serviceAccount ? { serviceAccountName: serviceAccount } : {}),
          containers: [{ name: 'app', image: APP, ports: [{ containerPort: 8080 }] }],
        },
      },
    },
  };
}

const MESH_PLATFORM = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'istiod', namespace: 'istio-system', labels: { app: 'istiod' } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'istiod' } },
      template: {
        metadata: { labels: { app: 'istiod' } },
        spec: { containers: [{ name: 'discovery', image: ISTIOD }] },
      },
    },
  },
  {
    apiVersion: 'apps/v1', kind: 'DaemonSet',
    metadata: { name: 'ztunnel', namespace: 'istio-system', labels: { app: 'ztunnel' } },
    spec: {
      selector: { matchLabels: { app: 'ztunnel' } },
      template: {
        metadata: { labels: { app: 'ztunnel' } },
        spec: { containers: [{ name: 'ztunnel', image: ZTUNNEL }] },
      },
    },
  },
];

const WAYPOINT = {
  apiVersion: 'gateway.networking.k8s.io/v1', kind: 'Gateway',
  metadata: { name: 'waypoint', namespace: 'shop' },
  spec: {
    gatewayClassName: 'istio-waypoint',
    listeners: [{ name: 'mesh', port: 15008, protocol: 'HBONE' }],
  },
};

function spec(options: {
  ambient?: boolean; platform?: boolean; extra?: unknown[];
} = {}): OpsWorldSpec {
  return {
    namespaces: ['default', 'istio-system', 'outside'],
    images: {
      [APP]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [ISTIOD]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [ZTUNNEL]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
    },
    objects: [
      {
        apiVersion: 'v1', kind: 'Namespace',
        metadata: {
          name: 'shop',
          ...(options.ambient === false ? {} : { labels: { 'istio.io/dataplane-mode': 'ambient' } }),
        },
        status: { phase: 'Active' },
      },
      ...(options.platform === false ? [] : MESH_PLATFORM),
      deployment('portal', 'shop', 'portal'),
      deployment('ledger', 'shop', 'ledger'),
      deployment('scanner', 'outside'),
      {
        apiVersion: 'v1', kind: 'Service',
        metadata: { name: 'ledger', namespace: 'shop' },
        spec: { selector: { app: 'ledger' }, ports: [{ port: 80, targetPort: 8080 }] },
      },
      ...(options.extra ?? []),
    ] as never,
  };
}

async function build(options: Parameters<typeof spec>[0] = {}) {
  return createOpsWorld({ world: spec(options) });
}

function podOf(w: Awaited<ReturnType<typeof build>>, app: string, namespace: string): string {
  return w.cluster.registry.list(
    w.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'pods' }), { namespace }
  ).items.find((pod) => pod.metadata.labels?.app === app)!.metadata.name!;
}

function call(
  w: Awaited<ReturnType<typeof build>>,
  from: { app: string; namespace: string },
  target: { host: string; path?: string; method?: string }
) {
  return w.cluster.network.connect(
    { zone: 'cluster', namespace: from.namespace, podName: podOf(w, from.app, from.namespace), label: from.app },
    { host: target.host, port: 80, path: target.path ?? '/', method: target.method }
  );
}

describe('身份', () => {
  it('SPIFFE 就是命名空间加 ServiceAccount', () => {
    expect(spiffeId('shop', 'portal')).toBe('spiffe://cluster.local/ns/shop/sa/portal');
    expect(spiffeId('shop')).toBe('spiffe://cluster.local/ns/shop/sa/default');
  });

  it('网格里的调用带上调用方的身份', async () => {
    const w = await build();
    const result = call(w, { app: 'portal', namespace: 'shop' }, { host: 'ledger.shop.svc.cluster.local' });
    expect(result.kind).toBe('ok');
    const hop = result.hops.find((entry) => entry.at === 'mesh/ztunnel');
    expect(hop?.detail).toContain('spiffe://cluster.local/ns/shop/sa/portal');
    expect(hop?.detail).toContain('spiffe://cluster.local/ns/shop/sa/ledger');
  });
});

describe('网格是集群里的工作负载', () => {
  it('没装 istiod / ztunnel 时，策略一条都不生效', async () => {
    const w = await build({
      platform: false,
      extra: [{
        apiVersion: 'security.istio.io/v1', kind: 'PeerAuthentication',
        metadata: { name: 'strict', namespace: 'shop' },
        spec: { mtls: { mode: 'STRICT' } },
      }],
    });
    // 网格外的调用方照样连得上 —— 因为根本没人在执行
    const result = call(w, { app: 'scanner', namespace: 'outside' }, { host: 'ledger.shop.svc.cluster.local' });
    expect(result.kind).toBe('ok');
    expect(result.hops.some((hop) => hop.at === 'mesh/ztunnel')).toBe(false);
  });
});

describe('PeerAuthentication', () => {
  const STRICT = {
    apiVersion: 'security.istio.io/v1', kind: 'PeerAuthentication',
    metadata: { name: 'strict', namespace: 'shop' },
    spec: { mtls: { mode: 'STRICT' } },
  };

  it('STRICT 之下，网格外的明文连接被重置 —— 不是超时', async () => {
    const w = await build({ extra: [STRICT] });
    const result = call(w, { app: 'scanner', namespace: 'outside' }, { host: 'ledger.shop.svc.cluster.local' });
    expect(result.kind).toBe('reset');
    expect(result.blockedBy).toBe('plaintext-rejected');
    expect(result.hops.find((hop) => hop.at === 'mesh/ztunnel')?.detail).toContain('STRICT');
  });

  it('网格里的调用不受影响', async () => {
    const w = await build({ extra: [STRICT] });
    expect(call(w, { app: 'portal', namespace: 'shop' }, { host: 'ledger.shop.svc.cluster.local' }).kind).toBe('ok');
  });

  it('PERMISSIVE 下明文照样通', async () => {
    const w = await build({
      extra: [{ ...STRICT, spec: { mtls: { mode: 'PERMISSIVE' } } }],
    });
    expect(call(w, { app: 'scanner', namespace: 'outside' }, { host: 'ledger.shop.svc.cluster.local' }).kind).toBe('ok');
  });

  it('带 selector 的策略压过不带 selector 的', () => {
    const wide = {
      apiVersion: 'security.istio.io/v1', kind: 'PeerAuthentication',
      metadata: { name: 'wide', namespace: 'shop' }, spec: { mtls: { mode: 'STRICT' } },
    } as KubeObject;
    const narrow = {
      apiVersion: 'security.istio.io/v1', kind: 'PeerAuthentication',
      metadata: { name: 'narrow', namespace: 'shop' },
      spec: { selector: { matchLabels: { app: 'ledger' } }, mtls: { mode: 'PERMISSIVE' } },
    } as KubeObject;
    const peer = { namespace: 'shop', labels: { app: 'ledger' }, serviceAccount: 'ledger', enrolled: true };
    expect(strictnessFor([wide, narrow], peer)).toEqual({ mtls: 'PERMISSIVE', policy: 'shop/narrow' });
  });
});

describe('AuthorizationPolicy', () => {
  const ALLOW_PORTAL = {
    apiVersion: 'security.istio.io/v1', kind: 'AuthorizationPolicy',
    metadata: { name: 'ledger', namespace: 'shop' },
    spec: {
      selector: { matchLabels: { app: 'ledger' } },
      action: 'ALLOW',
      rules: [{ from: [{ source: { principals: ['spiffe://cluster.local/ns/shop/sa/portal'] } }] }],
    },
  };

  it('第一条 ALLOW 策略同时把「其余全拒」打开了', async () => {
    const w = await build({ extra: [ALLOW_PORTAL, deployment('reports', 'shop', 'reports')] });
    expect(call(w, { app: 'portal', namespace: 'shop' }, { host: 'ledger.shop.svc.cluster.local' }).kind).toBe('ok');

    const denied = call(w, { app: 'reports', namespace: 'shop' }, { host: 'ledger.shop.svc.cluster.local' });
    expect(denied.kind).toBe('reset');
    expect(denied.blockedBy).toBe('denied');
    expect(denied.hops.find((hop) => hop.at === 'mesh/ztunnel')?.detail)
      .toContain('一旦有 ALLOW 策略选中目标，其余一律拒绝');
  });

  it('DENY 压过 ALLOW', () => {
    const allow = {
      metadata: { namespace: 'shop', name: 'allow' },
      spec: { action: 'ALLOW', rules: [{}] },
    } as unknown as KubeObject;
    const deny = {
      metadata: { namespace: 'shop', name: 'deny' },
      spec: { action: 'DENY', rules: [{ to: [{ operation: { ports: ['80'] } }] }] },
    } as unknown as KubeObject;
    const decision = evaluateAuthz([allow, deny], { namespace: 'shop', labels: {} }, { port: 80 }, false);
    expect(decision).toMatchObject({ allowed: false, reason: 'deny-matched', policy: 'shop/deny' });
  });

  it('没有策略选中就默认允许', () => {
    const other = {
      metadata: { namespace: 'shop', name: 'other' },
      spec: { selector: { matchLabels: { app: 'somethingelse' } }, action: 'ALLOW', rules: [] },
    } as unknown as KubeObject;
    expect(evaluateAuthz([other], { namespace: 'shop', labels: { app: 'ledger' } }, { port: 80 }, false))
      .toMatchObject({ allowed: true, reason: 'no-policy' });
  });

  it('Istio 的通配只认前缀和后缀', () => {
    expect(globMatch('*', 'anything')).toBe(true);
    expect(globMatch('spiffe://cluster.local/ns/shop/*', 'spiffe://cluster.local/ns/shop/sa/portal')).toBe(true);
    expect(globMatch('*.corp', 'a.corp')).toBe(true);
    expect(globMatch('a*c', 'abc')).toBe(false);
  });
});

describe('L7 要有 waypoint', () => {
  const BY_METHOD = {
    apiVersion: 'security.istio.io/v1', kind: 'AuthorizationPolicy',
    metadata: { name: 'ledger-l7', namespace: 'shop' },
    spec: {
      selector: { matchLabels: { app: 'ledger' } },
      action: 'ALLOW',
      rules: [{
        from: [{ source: { principals: ['spiffe://cluster.local/ns/shop/sa/portal'] } }],
        to: [{ operation: { methods: ['GET'], paths: ['/balance*'] } }],
      }],
    },
  };

  it('没有 waypoint 时带 methods/paths 的规则求值不了，于是整条策略谁都不放行', async () => {
    const w = await build({ extra: [BY_METHOD] });
    const result = call(w, { app: 'portal', namespace: 'shop' }, {
      host: 'ledger.shop.svc.cluster.local', path: '/balance', method: 'GET',
    });
    expect(result.kind).toBe('reset');
    expect(result.hops.find((hop) => hop.at === 'mesh/ztunnel')?.detail).toContain('没有 waypoint');
  });

  it('挂上 waypoint 之后同一条策略开始按方法与路径判', async () => {
    const w = await build({ extra: [BY_METHOD, WAYPOINT] });
    const allowed = call(w, { app: 'portal', namespace: 'shop' }, {
      host: 'ledger.shop.svc.cluster.local', path: '/balance', method: 'GET',
    });
    expect(allowed.kind).toBe('ok');

    const wrongPath = call(w, { app: 'portal', namespace: 'shop' }, {
      host: 'ledger.shop.svc.cluster.local', path: '/admin', method: 'GET',
    });
    expect(wrongPath.kind).toBe('reset');
  });
});

describe('istioctl', () => {
  it('ztunnel-config workload 用 PROTOCOL 那一列说明谁进了网格', async () => {
    const w = await build();
    const result = await w.run('istioctl ztunnel-config workload');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('NAMESPACE');
    expect(result.stdout).toContain('PROTOCOL');
    const lines = result.stdout.split('\n');
    expect(lines.find((line) => line.includes('shop') && line.includes('portal'))).toContain('HBONE');
    expect(lines.find((line) => line.includes('outside'))).toContain('TCP');
  });

  it('x describe pod 把身份、mTLS 模式、命中的策略摆在一起', async () => {
    const w = await build({
      extra: [{
        apiVersion: 'security.istio.io/v1', kind: 'PeerAuthentication',
        metadata: { name: 'strict', namespace: 'shop' }, spec: { mtls: { mode: 'STRICT' } },
      }],
    });
    const result = await w.run(`istioctl x describe pod ${podOf(w, 'ledger', 'shop')} -n shop`);
    expect(result.stdout).toContain('spiffe://cluster.local/ns/shop/sa/ledger');
    expect(result.stdout).toContain('Workload mTLS mode: STRICT');
    expect(result.stdout).toContain('没有策略选中这个工作负载');
  });

  it('analyze 报出「L7 规则没有 waypoint」', async () => {
    const w = await build({
      extra: [{
        apiVersion: 'security.istio.io/v1', kind: 'AuthorizationPolicy',
        metadata: { name: 'l7', namespace: 'shop' },
        spec: { action: 'ALLOW', rules: [{ to: [{ operation: { paths: ['/x'] } }] }] },
      }],
    });
    const result = await w.run('istioctl analyze -n shop');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('IST0162');
    expect(result.stdout).toContain('没有挂 waypoint');
  });

  it('analyze 报出「STRICT 但命名空间没进网格」', async () => {
    const w = await build({
      ambient: false,
      extra: [{
        apiVersion: 'security.istio.io/v1', kind: 'PeerAuthentication',
        metadata: { name: 'strict', namespace: 'shop' }, spec: { mtls: { mode: 'STRICT' } },
      }],
    });
    const result = await w.run('istioctl analyze -n shop');
    expect(result.stdout).toContain('IST0163');
    expect(result.stdout).toContain('istio.io/dataplane-mode=ambient');
  });

  it('干净的时候明确说没问题', async () => {
    const w = await build();
    const result = await w.run('istioctl analyze -n shop');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No validation issues found');
  });

  it('控制面不在时 proxy-status 直接说连不上', async () => {
    const w = await build({ platform: false });
    const result = await w.run('istioctl proxy-status');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('istiod 不可用');
  });
});
