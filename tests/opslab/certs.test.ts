/**
 * cert-manager：签出来的是真证书
 *
 * 「Certificate 是 Ready 的」和「这张证书真的验得过」是两件事，
 * 第 9 关要让学员分清。所以这里既验状态，也把 Secret 里的 PEM 掏出来真验一遍链。
 */
import { createCluster } from '../../src/lib/opslab/controllers';
import { caSecret, decodeSecret, parseDuration } from '../../src/lib/opslab/certs';
import { parseChain, verifyChain } from '../../src/lib/opslab/crypto';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-03-02T09:00:00Z');
const IMAGE = 'quay.io/jetstack/cert-manager-controller:v1.19.1';

const controllerDeployment = () => ({
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: {
    name: 'cert-manager', namespace: 'cert-manager',
    labels: { 'app.kubernetes.io/name': 'cert-manager' },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { 'app.kubernetes.io/name': 'cert-manager' } },
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': 'cert-manager' } },
      spec: { containers: [{ name: 'controller', image: IMAGE }] },
    },
  },
} as unknown as KubeObject);

const clusterIssuer = (name: string, secretName: string) => ({
  apiVersion: 'cert-manager.io/v1', kind: 'ClusterIssuer',
  metadata: { name },
  spec: { ca: { secretName } },
} as unknown as KubeObject);

const certificate = (name: string, spec: Record<string, unknown>) => ({
  apiVersion: 'cert-manager.io/v1', kind: 'Certificate',
  metadata: { name, namespace: 'payments' },
  spec,
} as unknown as KubeObject);

async function world(objects: KubeObject[]) {
  const cluster = createCluster({
    startTime: START,
    clusterAgeMs: 0,
    namespaces: ['default', 'kube-system', 'payments', 'cert-manager'],
    images: { [IMAGE]: { listens: [9402] } },
  });
  cluster.start();
  for (const object of objects) {
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

const secretsOf = (cluster: Awaited<ReturnType<typeof world>>, namespace: string) =>
  cluster.registry.list(
    cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'secrets' }), { namespace }
  ).items;

const certificateStatus = (cluster: Awaited<ReturnType<typeof world>>, name: string) =>
  (cluster.registry.get(
    cluster.scheme.mustGet({ group: 'cert-manager.io', version: 'v1', resource: 'certificates' }),
    'payments', name
  ).status ?? {}) as any;

const ROOT = caSecret({
  name: 'corp-root-ca', namespace: 'cert-manager',
  commonName: 'Corp Root CA', notBefore: START - 365 * DAY, notAfter: START + 365 * DAY,
});

describe('cert-manager 是集群里的一个工作负载', () => {
  it('没装：Certificate 停在 Ready=Unknown，没有 Secret', async () => {
    const cluster = await world([
      ROOT,
      clusterIssuer('corp-ca', 'corp-root-ca'),
      certificate('portal', {
        secretName: 'portal-tls', dnsNames: ['portal.corp.internal'],
        issuerRef: { name: 'corp-ca', kind: 'ClusterIssuer' },
      }),
    ]);
    expect(certificateStatus(cluster, 'portal').conditions[0].status).toBe('Unknown');
    expect(secretsOf(cluster, 'payments')).toHaveLength(0);
  });

  it('装上之后签出证书，Secret 是 kubernetes.io/tls 类型', async () => {
    const cluster = await world([
      controllerDeployment(),
      ROOT,
      clusterIssuer('corp-ca', 'corp-root-ca'),
      certificate('portal', {
        secretName: 'portal-tls', dnsNames: ['portal.corp.internal'],
        issuerRef: { name: 'corp-ca', kind: 'ClusterIssuer' },
      }),
    ]);
    expect(certificateStatus(cluster, 'portal').conditions[0].status).toBe('True');

    const secret = secretsOf(cluster, 'payments')[0];
    expect(secret.metadata.name).toBe('portal-tls');
    expect((secret as any).type).toBe('kubernetes.io/tls');
    expect(Object.keys(decodeSecret(secret)).sort()).toEqual(['ca.crt', 'tls.crt', 'tls.key']);
  });

  it('签出来的证书真的验得过 —— 状态 Ready 和「链是通的」是两件事', async () => {
    const cluster = await world([
      controllerDeployment(),
      ROOT,
      clusterIssuer('corp-ca', 'corp-root-ca'),
      certificate('portal', {
        secretName: 'portal-tls', dnsNames: ['portal.corp.internal', 'portal.payments.svc'],
        issuerRef: { name: 'corp-ca', kind: 'ClusterIssuer' },
      }),
    ]);
    const data = decodeSecret(secretsOf(cluster, 'payments')[0]);
    const chain = parseChain(data['tls.crt']);
    const roots = parseChain(data['ca.crt']);

    expect(verifyChain({ chain, roots, hostname: 'portal.corp.internal', now: START }).ok).toBe(true);
    expect(verifyChain({ chain, roots, hostname: 'portal.payments.svc', now: START }).ok).toBe(true);

    const wrong = verifyChain({ chain, roots, hostname: 'admin.corp.internal', now: START });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('certificate is valid for');
  });

  it('issuer 不存在时说得清清楚楚', async () => {
    const cluster = await world([
      controllerDeployment(),
      certificate('portal', {
        secretName: 'portal-tls', dnsNames: ['portal.corp.internal'],
        issuerRef: { name: 'ghost', kind: 'ClusterIssuer' },
      }),
    ]);
    const condition = certificateStatus(cluster, 'portal').conditions[0];
    expect(condition.status).toBe('False');
    expect(condition.reason).toBe('IssuerNotFound');
    expect(condition.message).toContain('ghost');
  });

  it('issuer 指的 Secret 不存在', async () => {
    const cluster = await world([
      controllerDeployment(),
      clusterIssuer('corp-ca', 'missing-ca'),
      certificate('portal', {
        secretName: 'portal-tls', dnsNames: ['portal.corp.internal'],
        issuerRef: { name: 'corp-ca', kind: 'ClusterIssuer' },
      }),
    ]);
    expect(certificateStatus(cluster, 'portal').conditions[0].reason).toBe('SecretMissing');
  });

  it('duration 决定有效期，status 里写着续期时间', async () => {
    const cluster = await world([
      controllerDeployment(),
      ROOT,
      clusterIssuer('corp-ca', 'corp-root-ca'),
      certificate('portal', {
        secretName: 'portal-tls', dnsNames: ['portal.corp.internal'],
        duration: '720h', renewBefore: '240h',
        issuerRef: { name: 'corp-ca', kind: 'ClusterIssuer' },
      }),
    ]);
    const status = certificateStatus(cluster, 'portal');
    expect(status.notAfter).toBe('2026-04-01T09:00:00Z');
    expect(status.renewalTime).toBe('2026-03-22T09:00:00Z');
  });

  it.each([
    ['2160h', 2160 * 3600_000],
    ['90d', 90 * DAY],
    ['30m', 30 * 60_000],
    [undefined, undefined],
    ['abc', undefined],
  ])('parseDuration(%s)', (value, expected) => {
    expect(parseDuration(value as string | undefined)).toBe(expected);
  });
});

describe('TLS 在网络里真的会被验', () => {
  const { createOpsWorld } = require('../../src/lib/opslab/lab');
  const GATEWAY_IMAGE = 'registry.k8s.io/gateway-api/envoy-gateway:v1.6.2';
  const APP_IMAGE = 'harbor.corp.internal/team/portal:1.4.0';

  /** 一个装好了 Envoy Gateway 与 cert-manager、门户跑在后面的世界 */
  async function tlsWorld(options: { trustCa?: boolean; listenerTls?: boolean; sanFor?: string } = {}) {
    const notBefore = START - 365 * DAY;
    const root = caSecret({
      name: 'corp-root-ca', namespace: 'cert-manager',
      commonName: 'Corp Root CA', notBefore, notAfter: START + 365 * DAY,
    });
    const rootPem = atob(((root as any).data)['ca.crt']);

    return createOpsWorld({
      world: {
        startTime: '2026-03-02T09:00:00Z',
        clusterAgeDays: 0,
        namespaces: ['default', 'kube-system', 'payments', 'cert-manager', 'envoy-gateway-system'],
        images: {
          [GATEWAY_IMAGE]: { listens: [18000] },
          [IMAGE]: { listens: [9402] },
          [APP_IMAGE]: { listens: [8080], routes: { '/': 200, '/healthz': 200 } },
        },
        addressPools: [
          { loadBalancerClass: 'corp.internal/office-lb', cidrPrefix: '10.10.8', zones: ['office'] },
        ],
        machine: {
          files: options.trustCa
            ? { '/etc/ssl/certs/ca-certificates.crt': rootPem }
            : { '/etc/ssl/certs/ca-certificates.crt': '' },
        },
      },
      stage: {
        objects: [
          root,
          controllerDeployment(),
          {
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
                spec: { containers: [{ name: 'c', image: GATEWAY_IMAGE }] },
              },
            },
          },
          {
            apiVersion: 'gateway.envoyproxy.io/v1alpha1', kind: 'EnvoyProxy',
            metadata: { name: 'internal', namespace: 'envoy-gateway-system' },
            spec: { provider: { kubernetes: { envoyService: { loadBalancerClass: 'corp.internal/office-lb' } } } },
          },
          {
            apiVersion: 'gateway.networking.k8s.io/v1', kind: 'GatewayClass',
            metadata: { name: 'envoy-internal' },
            spec: {
              controllerName: 'gateway.envoyproxy.io/gatewayclass-controller',
              parametersRef: {
                group: 'gateway.envoyproxy.io', kind: 'EnvoyProxy',
                name: 'internal', namespace: 'envoy-gateway-system',
              },
            },
          },
          clusterIssuer('corp-ca', 'corp-root-ca'),
          certificate('portal', {
            secretName: 'portal-tls',
            dnsNames: [options.sanFor ?? 'portal.corp.internal'],
            issuerRef: { name: 'corp-ca', kind: 'ClusterIssuer' },
          }),
          {
            apiVersion: 'gateway.networking.k8s.io/v1', kind: 'Gateway',
            metadata: { name: 'corp-gw', namespace: 'payments' },
            spec: {
              gatewayClassName: 'envoy-internal',
              listeners: options.listenerTls === false
                ? [{ name: 'http', port: 443, protocol: 'HTTP' }]
                : [{
                  name: 'https', port: 443, protocol: 'HTTPS',
                  hostname: 'portal.corp.internal',
                  tls: { mode: 'Terminate', certificateRefs: [{ name: 'portal-tls' }] },
                }],
            },
          },
          {
            apiVersion: 'gateway.networking.k8s.io/v1', kind: 'HTTPRoute',
            metadata: { name: 'portal', namespace: 'payments' },
            spec: {
              parentRefs: [{ name: 'corp-gw' }],
              hostnames: ['portal.corp.internal'],
              rules: [{ backendRefs: [{ name: 'portal', port: 80 }] }],
            },
          },
          {
            apiVersion: 'apps/v1', kind: 'Deployment',
            metadata: { name: 'portal', namespace: 'payments' },
            spec: {
              replicas: 1,
              selector: { matchLabels: { app: 'portal' } },
              template: {
                metadata: { labels: { app: 'portal' } },
                spec: { containers: [{ name: 'web', image: APP_IMAGE, ports: [{ containerPort: 8080 }] }] },
              },
            },
          },
          {
            apiVersion: 'v1', kind: 'Service',
            metadata: { name: 'portal', namespace: 'payments' },
            spec: { clusterIP: '10.96.1.10', selector: { app: 'portal' }, ports: [{ port: 80, targetPort: 8080 }] },
          },
        ] as never,
      },
    });
  }

  const addressOf = (world: any) => (world.cluster.registry.get(
    world.cluster.scheme.mustGet({ group: 'gateway.networking.k8s.io', version: 'v1', resource: 'gateways' }),
    'payments', 'corp-gw'
  ).status as any).addresses[0].value;

  it('CA 装进信任库之后，https 通', async () => {
    const world = await tlsWorld({ trustCa: true });
    const address = addressOf(world);
    const result = await world.run(
      `curl -s -o /dev/null -w %{http_code} --resolve portal.corp.internal:443:${address} https://portal.corp.internal/`
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('200');
  });

  it('CA 不在信任库里：curl (60) unable to get local issuer certificate', async () => {
    const world = await tlsWorld({ trustCa: false });
    const address = addressOf(world);
    const result = await world.run(
      `curl -s --resolve portal.corp.internal:443:${address} https://portal.corp.internal/`
    );
    expect(result.code).toBe(60);
    expect(result.stderr).toContain('unable to get local issuer certificate');
  });

  it('-k 跳过校验就通了 —— 但这只是把问题按住', async () => {
    const world = await tlsWorld({ trustCa: false });
    const address = addressOf(world);
    const result = await world.run(
      `curl -sk -o /dev/null -w %{http_code} --resolve portal.corp.internal:443:${address} https://portal.corp.internal/`
    );
    expect(result.stdout).toBe('200');
  });

  it('SAN 里没有这个名字', async () => {
    const world = await tlsWorld({ trustCa: true, sanFor: 'admin.corp.internal' });
    const address = addressOf(world);
    const result = await world.run(
      `curl -s --resolve portal.corp.internal:443:${address} https://portal.corp.internal/`
    );
    expect(result.code).toBe(60);
    expect(result.stderr).toContain('subjectAltName does not match');
  });

  it('对面根本不是 TLS 端口：报的是 35 不是 60', async () => {
    const world = await tlsWorld({ trustCa: true, listenerTls: false });
    const address = addressOf(world);
    const result = await world.run(
      `curl -s --resolve portal.corp.internal:443:${address} https://portal.corp.internal/`
    );
    expect(result.code).toBe(35);
  });

  it('openssl x509 打得出 SAN 与有效期', async () => {
    const world = await tlsWorld({ trustCa: true });
    await world.run(
      'kubectl get secret portal-tls -n payments -o jsonpath={.data.tls\\\\.crt} > /root/crt.b64'
        .replace('kubectl', 'true')
    );
    // 直接把 PEM 写进文件更直接
    const secret = world.cluster.registry.get(
      world.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'secrets' }),
      'payments', 'portal-tls'
    );
    world.machine.vfs.writeFile('/root/portal.pem', decodeSecret(secret)['tls.crt']);

    const dates = await world.run('openssl x509 -in /root/portal.pem -noout -dates');
    expect(dates.stdout).toContain('notBefore=Mar  2 09:00:00 2026 GMT');

    const san = await world.run('openssl x509 -in /root/portal.pem -noout -ext subjectAltName');
    expect(san.stdout).toContain('DNS:portal.corp.internal');
  });
});
