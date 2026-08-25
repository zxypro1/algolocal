/**
 * Argo CD
 *
 * 三条最容易被误解的规则，这里逐条钉住：
 *  1. OutOfSync 不等于坏了 —— 它和 health 是两个维度；
 *  2. 没有 automated 就不会自己动，只报差异；
 *  3. selfHeal 才会把手改改回去。
 *
 * 还有一条架构约束：控制器自己是集群里的工作负载，停了就不同步。
 */
import { createOpsWorld } from '../../src/lib/opslab/lab';
import { seedRepository } from '../../src/lib/opslab/git';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const REPO = 'https://git.corp.internal/platform/apps';
const IMAGE = 'harbor.corp.internal/team/portal:1.4.0';

const PORTAL_YAML = (replicas: number) => [
  'apiVersion: apps/v1',
  'kind: Deployment',
  'metadata:',
  '  name: portal',
  '  namespace: shop',
  'spec:',
  `  replicas: ${replicas}`,
  '  selector:',
  '    matchLabels:',
  '      app: portal',
  '  template:',
  '    metadata:',
  '      labels:',
  '        app: portal',
  '    spec:',
  '      containers:',
  '      - name: web',
  `        image: ${IMAGE}`,
  '        ports:',
  '        - containerPort: 8080',
  '',
].join('\n');

const SERVICE_YAML = [
  'apiVersion: v1',
  'kind: Service',
  'metadata:',
  '  name: portal',
  '  namespace: shop',
  'spec:',
  '  selector:',
  '    app: portal',
  '  ports:',
  '  - port: 80',
  '    targetPort: 8080',
  '',
].join('\n');

const ARGOCD_DEPLOYMENT = {
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: {
    name: 'argocd-application-controller', namespace: 'argocd',
    labels: { 'app.kubernetes.io/name': 'argocd-application-controller' },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { 'app.kubernetes.io/name': 'argocd-application-controller' } },
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': 'argocd-application-controller' } },
      spec: { containers: [{ name: 'controller', image: 'quay.io/argoproj/argocd:v3.2.4' }] },
    },
  },
};

function application(syncPolicy?: Record<string, unknown>) {
  return {
    apiVersion: 'argoproj.io/v1alpha1', kind: 'Application',
    metadata: { name: 'portal', namespace: 'argocd' },
    spec: {
      project: 'default',
      source: { repoURL: REPO, path: 'apps', targetRevision: 'main' },
      destination: { server: 'https://kubernetes.default.svc', namespace: 'shop' },
      ...(syncPolicy ? { syncPolicy } : {}),
    },
  };
}

function worldSpec(objects: unknown[], files: Record<string, string>): OpsWorldSpec {
  return {
    namespaces: ['default', 'argocd', 'shop'],
    images: {
      [IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      'quay.io/argoproj/argocd:v3.2.4': { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
    },
    gitRepositories: [{ url: REPO, files }],
    objects: objects as never,
  };
}

const DEFAULT_FILES = { 'apps/portal.yaml': PORTAL_YAML(2), 'README.md': '# platform\n' };

async function build(syncPolicy?: Record<string, unknown>, files: Record<string, string> = DEFAULT_FILES) {
  return createOpsWorld({
    world: worldSpec([ARGOCD_DEPLOYMENT, application(syncPolicy)], files),
  });
}

/** 模拟平台组在别处推了一版，连带发出 webhook */
function push(
  world: Awaited<ReturnType<typeof build>>,
  files: Record<string, string>,
  message: string
): void {
  seedRepository(world.git.get(REPO)!, files, { message, timestamp: world.now() });
  world.git.notifyPush(REPO);
}

const app = (world: Awaited<ReturnType<typeof build>>): KubeObject =>
  world.cluster.registry.get(
    world.cluster.scheme.mustGet({ group: 'argoproj.io', version: 'v1alpha1', resource: 'applications' }),
    'argocd', 'portal'
  );

const deployment = (world: Awaited<ReturnType<typeof build>>): KubeObject | undefined => {
  try {
    return world.cluster.registry.get(
      world.cluster.scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' }),
      'shop', 'portal'
    );
  } catch {
    return undefined;
  }
};

describe('比对', () => {
  it('仓库里有、集群里没有 -> OutOfSync + Missing，而且不会自己动手', async () => {
    const world = await build();
    const status = app(world).status as any;
    expect(status.sync.status).toBe('OutOfSync');
    expect(status.health.status).toBe('Missing');
    expect(deployment(world)).toBeUndefined();
  });

  it('status.sync.revision 就是远端那个 commit', async () => {
    const world = await build();
    const bare = world.git.get(REPO)!;
    expect((app(world).status as any).sync.revision).toBe(bare.refs.main);
  });

  it('仓库连不上时说的是 ComparisonError，不是 OutOfSync', async () => {
    const world = await createOpsWorld({
      world: {
        ...worldSpec([ARGOCD_DEPLOYMENT, {
          ...application(),
          spec: { ...application().spec, source: { repoURL: 'https://git.corp.internal/nope/nope', path: 'apps' } },
        }], DEFAULT_FILES),
      },
    });
    const status = app(world).status as any;
    expect(status.sync.status).toBe('Unknown');
    expect(status.conditions[0].type).toBe('ComparisonError');
    expect(status.conditions[0].message).toContain('repository not accessible');
  });

  it('path 指错了会直接说出来 —— 不会静默同步 0 个对象', async () => {
    const world = await createOpsWorld({
      world: worldSpec([ARGOCD_DEPLOYMENT, {
        ...application(),
        spec: { ...application().spec, source: { repoURL: REPO, path: 'manifests', targetRevision: 'main' } },
      }], DEFAULT_FILES),
    });
    const status = app(world).status as any;
    expect(status.conditions[0].message).toContain('app path does not exist: manifests');
  });
});

describe('自动同步', () => {
  it('automated 打开之后对象被建出来，最终 Synced + Healthy', async () => {
    const world = await build({ automated: {} });
    const status = app(world).status as any;
    expect(deployment(world)).toBeDefined();
    expect(status.sync.status).toBe('Synced');
    expect(status.health.status).toBe('Healthy');
  });

  it('同一个仓库里的多个文件都会被 apply', async () => {
    const world = await build({ automated: {} }, {
      'apps/portal.yaml': PORTAL_YAML(2),
      'apps/service.yaml': SERVICE_YAML,
    });
    const services = world.cluster.registry.list(
      world.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'services' }), { namespace: 'shop' }
    );
    expect(services.items.map((item) => item.metadata.name)).toContain('portal');
    expect((app(world).status as any).resources).toHaveLength(2);
  });

  it('path 之外的文件不管 —— README 不是 manifest', async () => {
    const world = await build({ automated: {} });
    expect((app(world).status as any).resources).toHaveLength(1);
  });

  it('仓库有了新提交，集群跟着走', async () => {
    const world = await build({ automated: { selfHeal: true } });
    expect((deployment(world)!.spec as any).replicas).toBe(2);

    push(world, { 'apps/portal.yaml': PORTAL_YAML(4) }, 'scale to 4');
    await world.run('true');
    expect((deployment(world)!.spec as any).replicas).toBe(4);
  });
});

describe('手改之后会怎样', () => {
  /**
   * 有人手工改了副本数。
   *
   * 这里直接改对象而不是走 kubectl —— 这一组不需要真 CLI，
   * `kubectl scale` 那条路在关卡的反向验证里走过了。
   */
  async function drift(syncPolicy?: Record<string, unknown>) {
    const world = await build(syncPolicy ?? { automated: {} });
    const definition = world.cluster.scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' });
    const live = world.cluster.registry.get(definition, 'shop', 'portal');
    world.cluster.registry.update(definition, 'shop', 'portal', {
      ...live, spec: { ...(live.spec as any), replicas: 7 },
    });
    await world.cluster.settle();
    return world;
  }

  it('只开 automated 不开 selfHeal：手改留着，只是被标成 OutOfSync', async () => {
    const world = await drift({ automated: {} });
    expect((deployment(world)!.spec as any).replicas).toBe(7);
    expect((app(world).status as any).sync.status).toBe('OutOfSync');
    // 但服务是好的 —— OutOfSync 不等于坏了
    expect((app(world).status as any).health.status).toBe('Healthy');
  });

  it('开了 selfHeal：手改会被改回去', async () => {
    const world = await drift({ automated: { selfHeal: true } });
    expect((deployment(world)!.spec as any).replicas).toBe(2);
    expect((app(world).status as any).sync.status).toBe('Synced');
  });
});

describe('手动 sync', () => {
  it('写 operation 就同步一次，做完把 operation 摘掉', async () => {
    const world = await build();
    expect(deployment(world)).toBeUndefined();

    // argocd CLI 写的就是这个字段；关卡里学员敲的是 kubectl patch
    const definition = world.cluster.scheme.mustGet({
      group: 'argoproj.io', version: 'v1alpha1', resource: 'applications',
    });
    const live = world.cluster.registry.get(definition, 'argocd', 'portal');
    world.cluster.registry.update(definition, 'argocd', 'portal', {
      ...live, operation: { sync: {} },
    } as never);
    await world.cluster.settle();
    expect(deployment(world)).toBeDefined();
    expect((app(world).status as any).sync.status).toBe('Synced');
    expect((app(world).status as any).operationState.phase).toBe('Succeeded');
    expect((app(world) as any).operation).toBeUndefined();
  });
});

describe('prune', () => {
  it('仓库里删掉的对象，开了 prune 才会被删', async () => {
    const world = await build({ automated: { prune: true, selfHeal: true } }, {
      'apps/portal.yaml': PORTAL_YAML(2),
      'apps/service.yaml': SERVICE_YAML,
    });
    const services = () => world.cluster.registry.list(
      world.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'services' }), { namespace: 'shop' }
    ).items.map((item) => item.metadata.name);
    expect(services()).toContain('portal');

    push(world, { 'apps/portal.yaml': PORTAL_YAML(2) }, 'drop the service');
    await world.run('true');
    expect(services()).not.toContain('portal');
  });

  it('不是 Argo 建的对象不会被 prune 掉', async () => {
    const world = await build({ automated: { prune: true, selfHeal: true } });
    world.cluster.registry.create(
      world.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'configmaps' }), 'shop',
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: '手工建的', namespace: 'shop' }, data: {} } as never
    );
    await world.run('true');
    const maps = world.cluster.registry.list(
      world.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'configmaps' }), { namespace: 'shop' }
    );
    expect(maps.items.map((item) => item.metadata.name)).toContain('手工建的');
  });
});

describe('控制器自己是工作负载', () => {
  it('Deployment 缩到 0，同步就停了', async () => {
    const world = await build({ automated: { selfHeal: true } });
    expect(deployment(world)).toBeDefined();

    const definition = world.cluster.scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' });
    const controller = world.cluster.registry.get(definition, 'argocd', 'argocd-application-controller');
    world.cluster.registry.update(definition, 'argocd', 'argocd-application-controller', {
      ...controller, spec: { ...(controller.spec as any), replicas: 0 },
    });
    await world.cluster.settle();
    push(world, { 'apps/portal.yaml': PORTAL_YAML(9) }, 'scale to 9');
    await world.cluster.settle();
    // 控制器不在，新提交不会被同步下来
    expect((deployment(world)!.spec as any).replicas).toBe(2);
  });
});
