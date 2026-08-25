/**
 * 容器起不来的四种样子
 *
 * 学员的排查能力，本质上就是「看到这个状态，知道该去哪儿找」。
 * 所以这四种失败**必须彼此可区分**，文本也要和真集群一样：
 *
 *   CreateContainerConfigError —— 配置凑不齐，别去看应用日志
 *   ImagePullBackOff          —— 镜像的事，跟应用代码无关
 *   CrashLoopBackOff          —— 进程真的起来又死了
 *   Running 但 0/1            —— 进程活着，只是探针不认它
 */
import { createCluster } from '../../src/lib/opslab/controllers';
import {
  canPullImage, dockerConfigCredentials, exceedsMemoryLimit, parseQuantity,
  probeSucceeds, qosClassOf, registryHostOf, resolveEnv, secretData,
} from '../../src/lib/opslab/controllers';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const IMAGE = 'harbor.corp.internal/team/portal:1.4.0';

const configMap = (name: string, data: Record<string, string>): KubeObject => ({
  apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: 'default' }, data,
} as KubeObject);

const secret = (name: string, stringData: Record<string, string>): KubeObject => ({
  apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: 'default' }, stringData,
} as KubeObject);

const lookupOf = (objects: KubeObject[]) => ({
  configMap: (namespace: string, name: string) =>
    objects.find((o) => o.kind === 'ConfigMap' && o.metadata.name === name),
  secret: (namespace: string, name: string) =>
    objects.find((o) => o.kind === 'Secret' && o.metadata.name === name),
});

describe('环境变量解析', () => {
  it('直接给值、从 ConfigMap 取、从 Secret 取', () => {
    const result = resolveEnv(
      {
        name: 'web', image: IMAGE,
        env: [
          { name: 'MODE', value: 'prod' },
          { name: 'DB_HOST', valueFrom: { configMapKeyRef: { name: 'app', key: 'db.host' } } },
          { name: 'DB_PASS', valueFrom: { secretKeyRef: { name: 'db', key: 'password' } } },
        ],
      },
      'default',
      lookupOf([configMap('app', { 'db.host': 'pg.internal' }), secret('db', { password: 's3cr3t' })])
    );
    expect(result.error).toBeUndefined();
    expect(result.env).toEqual({ MODE: 'prod', DB_HOST: 'pg.internal', DB_PASS: 's3cr3t' });
  });

  it('envFrom 把整份 ConfigMap 铺进去，prefix 生效', () => {
    const result = resolveEnv(
      { name: 'web', image: IMAGE, envFrom: [{ configMapRef: { name: 'app' }, prefix: 'APP_' }] },
      'default',
      lookupOf([configMap('app', { PORT: '8080', LOG: 'info' })])
    );
    expect(result.env).toEqual({ APP_PORT: '8080', APP_LOG: 'info' });
  });

  it('ConfigMap 不存在的报错文本和真 kubelet 一样', () => {
    const result = resolveEnv(
      { name: 'web', image: IMAGE, env: [{ name: 'X', valueFrom: { configMapKeyRef: { name: 'missing', key: 'k' } } }] },
      'default', lookupOf([])
    );
    expect(result.error).toBe('configmap "missing" not found');
  });

  it('key 不存在时说的是 key，不是 ConfigMap —— 两种问题查法不同', () => {
    const result = resolveEnv(
      { name: 'web', image: IMAGE, env: [{ name: 'X', valueFrom: { configMapKeyRef: { name: 'app', key: 'nope' } } }] },
      'default', lookupOf([configMap('app', { other: '1' })])
    );
    expect(result.error).toBe("couldn't find key nope in ConfigMap default/app");
  });

  it('optional 的引用缺了不算错', () => {
    const result = resolveEnv(
      { name: 'web', image: IMAGE, env: [{ name: 'X', valueFrom: { configMapKeyRef: { name: 'gone', key: 'k', optional: true } } }] },
      'default', lookupOf([])
    );
    expect(result.error).toBeUndefined();
    expect(result.env).toEqual({});
  });

  it('Secret 的值是 base64 的', () => {
    const encoded = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's' }, data: { token: btoa('abc') } } as KubeObject;
    expect(secretData(encoded)).toEqual({ token: 'abc' });
  });
});

describe('拉私有镜像的凭据', () => {
  const registries = { 'harbor.corp.internal': { requiresAuth: true, users: { ci: 'pw' } } };

  const pullSecret = (name: string, username: string, password: string) => secret(name, {
    '.dockerconfigjson': JSON.stringify({
      auths: { 'harbor.corp.internal': { auth: btoa(`${username}:${password}`) } },
    }),
  });

  it('公共仓库不需要凭据', () => {
    expect(canPullImage({
      image: 'nginx:1.27', namespace: 'default', imagePullSecrets: [], registries, lookup: lookupOf([]),
    }).allowed).toBe(true);
  });

  it('私有仓库没给 imagePullSecret —— 401', () => {
    const result = canPullImage({
      image: IMAGE, namespace: 'default', imagePullSecrets: [], registries, lookup: lookupOf([]),
    });
    expect(result.allowed).toBe(false);
    expect(result.message).toContain('401 Unauthorized');
  });

  it('给了但密码不对，还是 401 —— kubelet 看不出区别，文本也不该有区别', () => {
    const wrong = pullSecret('harbor', 'ci', 'nope');
    expect(canPullImage({
      image: IMAGE, namespace: 'default', imagePullSecrets: [{ name: 'harbor' }],
      registries, lookup: lookupOf([wrong]),
    }).allowed).toBe(false);
  });

  it('凭据对就放行', () => {
    const good = pullSecret('harbor', 'ci', 'pw');
    expect(canPullImage({
      image: IMAGE, namespace: 'default', imagePullSecrets: [{ name: 'harbor' }],
      registries, lookup: lookupOf([good]),
    }).allowed).toBe(true);
  });

  it('认 docker config 的两种写法：auth 与 username/password', () => {
    const both = secret('s', {
      '.dockerconfigjson': JSON.stringify({
        auths: {
          'a.internal': { auth: btoa('u1:p1') },
          'https://b.internal/': { username: 'u2', password: 'p2' },
        },
      }),
    });
    expect(dockerConfigCredentials(both)).toEqual({
      'a.internal': { username: 'u1', password: 'p1' },
      'b.internal': { username: 'u2', password: 'p2' },
    });
  });

  it.each([
    ['nginx', 'docker.io'],
    ['bitnami/redis:7', 'docker.io'],
    ['harbor.corp.internal/team/app:v1', 'harbor.corp.internal'],
    ['localhost:5000/app', 'localhost:5000'],
  ])('%s 的仓库是 %s', (image, host) => {
    expect(registryHostOf(image)).toBe(host);
  });
});

describe('探针', () => {
  const behavior = { listens: [8080], routes: { '/healthz': 200, '/ready': 503 } };

  it('端口和路径都对才算过', () => {
    expect(probeSucceeds({ httpGet: { path: '/healthz', port: 8080 } }, behavior)).toBe(true);
  });

  it('端口写错 —— 进程活着，探针永远过不了', () => {
    expect(probeSucceeds({ httpGet: { path: '/healthz', port: 8081 } }, behavior)).toBe(false);
  });

  it('路径写错', () => {
    expect(probeSucceeds({ httpGet: { path: '/health', port: 8080 } }, behavior)).toBe(false);
  });

  it('路径返回 5xx 也算失败', () => {
    expect(probeSucceeds({ httpGet: { path: '/ready', port: 8080 } }, behavior)).toBe(false);
  });

  it('tcpSocket 只看端口', () => {
    expect(probeSucceeds({ tcpSocket: { port: 8080 } }, behavior)).toBe(true);
    expect(probeSucceeds({ tcpSocket: { port: 9090 } }, behavior)).toBe(false);
  });

  it('没配探针就算过', () => {
    expect(probeSucceeds(undefined, behavior)).toBe(true);
  });
});

describe('QoS 与资源', () => {
  it.each([
    ['都不写', [{}], 'BestEffort'],
    ['只写 requests', [{ requests: { cpu: '100m' } }], 'Burstable'],
    ['requests 与 limits 相等', [{ requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '1', memory: '1Gi' } }], 'Guaranteed'],
    ['limits 大于 requests', [{ requests: { cpu: '1' }, limits: { cpu: '2' } }], 'Burstable'],
    ['一个容器 Guaranteed 一个 BestEffort', [
      { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '1', memory: '1Gi' } }, {},
    ], 'Burstable'],
  ])('%s -> %s', (_label, resources, expected) => {
    const containers = (resources as any[]).map((r, i) => ({ name: `c${i}`, image: IMAGE, resources: r }));
    expect(qosClassOf(containers)).toBe(expected);
  });

  it.each([
    ['128Mi', 128 * 1024 * 1024],
    ['1Gi', 1024 ** 3],
    ['500M', 5e8],
    ['1000', 1000],
    ['250m', 0.25],
  ])('%s -> %s', (text, bytes) => {
    expect(parseQuantity(text)).toBeCloseTo(bytes as number, 5);
  });

  it('声明的内存超过 limit 才算会 OOM', () => {
    const container = { name: 'c', image: IMAGE, resources: { limits: { memory: '128Mi' } } };
    expect(exceedsMemoryLimit(container, { memoryUsage: '220Mi' })).toBe(true);
    expect(exceedsMemoryLimit(container, { memoryUsage: '64Mi' })).toBe(false);
    // 没写 limit 就不会被 OOMKill（会把节点吃垮，那是驱逐的事）
    expect(exceedsMemoryLimit({ name: 'c', image: IMAGE }, { memoryUsage: '4Gi' })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 端到端：这些判断在集群里真的会发生                                    */
/* ------------------------------------------------------------------ */

const DEPLOYMENT = (patch: Record<string, unknown> = {}, container: Record<string, unknown> = {}) => ({
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: { name: 'portal', namespace: 'default' },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: 'portal' } },
    template: {
      metadata: { labels: { app: 'portal' } },
      spec: { containers: [{ name: 'web', image: IMAGE, ...container }], ...patch },
    },
  },
} as unknown as KubeObject);

async function worldWith(options: {
  images?: Record<string, any>;
  registries?: Record<string, any>;
  objects?: KubeObject[];
  deployment?: KubeObject;
}) {
  const cluster = createCluster({
    images: options.images ?? { [IMAGE]: { listens: [8080], routes: { '/healthz': 200 } } },
    registries: options.registries,
  });
  cluster.start();
  const scheme = cluster.scheme;
  for (const object of options.objects ?? []) {
    const definition = scheme.resolveKind(
      object.apiVersion.includes('/') ? object.apiVersion.split('/')[0] : '',
      object.apiVersion.split('/').pop()!,
      object.kind
    )!;
    cluster.registry.create(definition, definition.namespaced ? 'default' : undefined, object);
  }
  if (options.deployment) {
    cluster.registry.create(
      scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' }),
      'default', options.deployment
    );
  }
  await cluster.settle();
  const pods = cluster.registry.list(scheme.mustGet({ group: '', version: 'v1', resource: 'pods' }));
  return { cluster, pod: pods.items[0] as any };
}

describe('集群里真的会这样', () => {
  it('引用不存在的 ConfigMap -> CreateContainerConfigError，不是 CrashLoop', async () => {
    const { pod } = await worldWith({
      deployment: DEPLOYMENT({}, {
        env: [{ name: 'DB', valueFrom: { configMapKeyRef: { name: 'app-config', key: 'db' } } }],
      }),
    });
    expect(pod.status.phase).toBe('Pending');
    expect(pod.status.containerStatuses[0].state.waiting).toEqual({
      reason: 'CreateContainerConfigError',
      message: 'configmap "app-config" not found',
    });
  });

  it('把 ConfigMap 建出来之后，快进一下它自己就起来了', async () => {
    const cluster = createCluster({ images: { [IMAGE]: {} } });
    cluster.start();
    const scheme = cluster.scheme;
    cluster.registry.create(
      scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' }), 'default',
      DEPLOYMENT({}, { env: [{ name: 'DB', valueFrom: { configMapKeyRef: { name: 'app-config', key: 'db' } } }] })
    );
    await cluster.settle();

    cluster.registry.create(
      scheme.mustGet({ group: '', version: 'v1', resource: 'configmaps' }), 'default',
      configMap('app-config', { db: 'pg.internal' })
    );
    // kubelet 是退避重试的，要给它时间
    await cluster.advanceBy(30_000);
    await cluster.settle();

    const pods = cluster.registry.list(scheme.mustGet({ group: '', version: 'v1', resource: 'pods' }));
    expect((pods.items[0].status as any).phase).toBe('Running');
  });

  it('私有仓库没凭据 -> ImagePullBackOff，报的是 401', async () => {
    const { pod, cluster } = await worldWith({
      registries: { 'harbor.corp.internal': { requiresAuth: true, users: { ci: 'pw' } } },
      deployment: DEPLOYMENT(),
    });
    expect(pod.status.containerStatuses[0].state.waiting.reason).toBe('ImagePullBackOff');

    const events = cluster.registry.list(
      cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'events' })
    ).items;
    expect(events.some((e) => String(e.message).includes('401 Unauthorized'))).toBe(true);
  });

  it('给对 imagePullSecret 就能拉下来', async () => {
    const { pod } = await worldWith({
      registries: { 'harbor.corp.internal': { requiresAuth: true, users: { ci: 'pw' } } },
      objects: [secret('harbor', {
        '.dockerconfigjson': JSON.stringify({
          auths: { 'harbor.corp.internal': { auth: btoa('ci:pw') } },
        }),
      })],
      deployment: DEPLOYMENT({ imagePullSecrets: [{ name: 'harbor' }] }),
    });
    expect(pod.status.phase).toBe('Running');
  });

  it('探针指错端口 -> Running 但 0/1，事件里说得清清楚楚', async () => {
    const { pod, cluster } = await worldWith({
      deployment: DEPLOYMENT({}, {
        readinessProbe: { httpGet: { path: '/healthz', port: 9090 }, initialDelaySeconds: 1 },
      }),
    });
    expect(pod.status.phase).toBe('Running');
    expect(pod.status.containerStatuses[0].ready).toBe(false);

    const events = cluster.registry.list(
      cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'events' })
    ).items;
    expect(events.some((e) => e.reason === 'Unhealthy' && String(e.message).includes('port 9090'))).toBe(true);
  });

  it('探针配对了就 Ready', async () => {
    const { pod } = await worldWith({
      deployment: DEPLOYMENT({}, {
        readinessProbe: { httpGet: { path: '/healthz', port: 8080 }, initialDelaySeconds: 1 },
      }),
    });
    expect(pod.status.containerStatuses[0].ready).toBe(true);
  });

  it('内存超过 limit -> OOMKilled，restartCount 涨', async () => {
    const { pod } = await worldWith({
      images: { [IMAGE]: { memoryUsage: '220Mi' } },
      deployment: DEPLOYMENT({}, { resources: { limits: { memory: '128Mi' }, requests: { memory: '128Mi' } } }),
    });
    expect(pod.status.containerStatuses[0].state.waiting.reason).toBe('CrashLoopBackOff');
    expect(pod.status.containerStatuses[0].lastState.terminated).toEqual({ exitCode: 137, reason: 'OOMKilled' });
    // 只写了 memory 没写 cpu，按真集群的规则这是 Burstable 不是 Guaranteed
    expect(pod.status.qosClass).toBe('Burstable');
  });

  it('QoS 写进 status，`kubectl describe` 看得到', async () => {
    const { pod } = await worldWith({ deployment: DEPLOYMENT() });
    expect(pod.status.qosClass).toBe('BestEffort');
  });
});

describe('节点内存不够时的驱逐', () => {
  const BIG = 'registry.corp.internal/hungry:1.0';
  const SMALL = 'registry.corp.internal/tidy:1.0';

  /** 一台 1Gi 的节点，放两个各吃 700Mi 的 Pod，必然装不下 */
  async function pressured(qos: { hungry?: Record<string, any>; tidy?: Record<string, any> }) {
    const cluster = createCluster({
      nodes: [{ name: 'node-1', cpu: '4', memory: '1Gi' }],
      images: {
        [BIG]: { memoryUsage: '700Mi' },
        [SMALL]: { memoryUsage: '700Mi' },
      },
    });
    cluster.start();
    const pods = cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'pods' });
    const make = (name: string, image: string, resources?: Record<string, any>) =>
      cluster.registry.create(pods, 'default', {
        apiVersion: 'v1', kind: 'Pod',
        metadata: { name, namespace: 'default' },
        spec: { containers: [{ name: 'app', image, ...(resources ? { resources } : {}) }] },
      } as unknown as KubeObject);

    make('hungry', BIG, qos.hungry);
    make('tidy', SMALL, qos.tidy);
    await cluster.settle();
    return {
      cluster,
      byName: Object.fromEntries(
        cluster.registry.list(pods, { namespace: 'default' }).items.map((p) => [p.metadata.name, p as any])
      ),
    };
  }

  it('BestEffort 先被赶走，写了 requests 的留下', async () => {
    const { byName } = await pressured({
      // hungry 一点资源都没声明 = BestEffort
      tidy: { requests: { memory: '700Mi', cpu: '500m' }, limits: { memory: '900Mi', cpu: '1' } },
    });
    expect(byName.hungry.status.phase).toBe('Failed');
    expect(byName.hungry.status.reason).toBe('Evicted');
    expect(byName.tidy.status.phase).toBe('Running');
  });

  it('驱逐消息里说清楚是内存不够、谁用了多少', async () => {
    const { byName } = await pressured({
      tidy: { requests: { memory: '700Mi' }, limits: { memory: '900Mi' } },
    });
    expect(byName.hungry.status.message).toContain('The node was low on resource: memory');
    expect(byName.hungry.status.message).toContain('was using 700Mi');
  });

  it('装得下就不动它们', async () => {
    const cluster = createCluster({
      nodes: [{ name: 'node-1', memory: '4Gi' }],
      images: { [BIG]: { memoryUsage: '700Mi' } },
    });
    cluster.start();
    const pods = cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'pods' });
    cluster.registry.create(pods, 'default', {
      apiVersion: 'v1', kind: 'Pod', metadata: { name: 'ok', namespace: 'default' },
      spec: { containers: [{ name: 'app', image: BIG }] },
    } as unknown as KubeObject);
    await cluster.settle();
    expect((cluster.registry.list(pods, { namespace: 'default' }).items[0].status as any).phase)
      .toBe('Running');
  });
});
