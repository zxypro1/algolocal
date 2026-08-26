/**
 * 学员自己写的 Operator
 *
 * 这一组钉的是 Operator 这件事本身的性质，不是某一段代码：
 *   1. 它是**声明式**的：改了自定义资源，造出来的东西跟着变
 *   2. 它**修偏差**：别人改坏了它造出来的东西，下一轮会改回去
 *   3. 属主引用是它的删除机制，不是它自己删
 *   4. 它是一个工作负载：停掉它，自定义资源还在，只是没人让它们成真
 */
import { createOpsWorld } from '../../src/lib/opslab/lab';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const OPERATOR_IMAGE = 'harbor.corp.internal/platform/site-operator:0.1';
const CRDS = { group: 'apiextensions.k8s.io', version: 'v1', resource: 'customresourcedefinitions' } as const;
const SITES = { group: 'platform.corp.internal', version: 'v1', resource: 'sites' } as const;
const CONFIGMAPS = { group: '', version: 'v1', resource: 'configmaps' } as const;

const SITE_CRD = {
  apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition',
  metadata: { name: 'sites.platform.corp.internal' },
  spec: {
    group: 'platform.corp.internal', scope: 'Namespaced',
    names: { plural: 'sites', singular: 'site', kind: 'Site' },
    versions: [{ name: 'v1', served: true, storage: true, subresources: { status: {} } }],
  },
};

const OPERATOR_DEPLOYMENT = {
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: {
    name: 'site-operator', namespace: 'default',
    labels: { 'app.kubernetes.io/name': 'site-operator' },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { 'app.kubernetes.io/name': 'site-operator' } },
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': 'site-operator' } },
      spec: { containers: [{ name: 'manager', image: OPERATOR_IMAGE }] },
    },
  },
};

/** 一个够小但完整的 Operator：Site -> ConfigMap */
const OPERATOR_CODE = `
exports.watches = ['Site', 'ConfigMap'];

exports.reconcile = (ctx) => {
  const site = ctx.object;
  ctx.apply({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: site.metadata.name + '-site',
      namespace: site.metadata.namespace,
      ownerReferences: [ctx.owner()],
    },
    data: { host: site.spec.host },
    spec: { host: site.spec.host },
  });
  ctx.setStatus({ ready: true, host: site.spec.host, observedGeneration: site.metadata.generation });
};
`;

/** 不 watch 附属类型的版本：别人改坏了它不知道 */
const BLIND_CODE = OPERATOR_CODE.replace("exports.watches = ['Site', 'ConfigMap'];", "exports.watches = ['Site'];");

/** 不挂属主引用的版本：删掉 Site 之后 ConfigMap 变成孤儿 */
const ORPHAN_CODE = OPERATOR_CODE.replace('ownerReferences: [ctx.owner()],', '');

function spec(objects: unknown[]): OpsWorldSpec {
  return {
    namespaces: ['default'],
    images: { [OPERATOR_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 } },
    objects: objects as never,
  };
}

async function build(code: string) {
  const world = await createOpsWorld({
    world: spec([SITE_CRD, OPERATOR_DEPLOYMENT]),
    stage: {
      files: { '/root/operator/site.js': code },
      operator: { path: '/root/operator/site.js', kind: 'Site', name: 'site-operator' },
    },
  });
  await world.cluster.advanceBy(30_000);
  return world;
}

type World = Awaited<ReturnType<typeof build>>;

const createSite = async (w: World, name: string, host: string) => {
  w.cluster.registry.create(w.cluster.scheme.mustGet(SITES), 'default', {
    apiVersion: 'platform.corp.internal/v1', kind: 'Site',
    metadata: { name, namespace: 'default' },
    spec: { host },
  } as KubeObject);
  await w.cluster.advanceBy(10_000);
};

const configMap = (w: World, name: string) => {
  try {
    return w.cluster.registry.get(w.cluster.scheme.mustGet(CONFIGMAPS), 'default', name);
  } catch {
    return undefined;
  }
};
const siteOf = (w: World, name: string) =>
  w.cluster.registry.get(w.cluster.scheme.mustGet(SITES), 'default', name);

describe('reconcile', () => {
  it('提交一个自定义资源，它造出该造的东西', async () => {
    const w = await build(OPERATOR_CODE);
    await createSite(w, 'portal', 'portal.corp.internal');

    const created = configMap(w, 'portal-site');
    expect(created).toBeDefined();
    expect((created!.spec as any).host).toBe('portal.corp.internal');
    expect((siteOf(w, 'portal').status as any).ready).toBe(true);
  });

  /**
   * 声明式的意思是「照着现在的 spec 收敛」，不是「创建时做一次」。
   * 改了 host，路由要跟着改 —— 这一条不过的 Operator 只是个安装脚本。
   */
  it('改了 spec，造出来的东西跟着变', async () => {
    const w = await build(OPERATOR_CODE);
    await createSite(w, 'portal', 'portal.corp.internal');

    const definition = w.cluster.scheme.mustGet(SITES);
    const live = w.cluster.registry.get(definition, 'default', 'portal');
    w.cluster.registry.update(definition, 'default', 'portal', {
      ...live, spec: { host: 'new.corp.internal' },
    } as KubeObject);
    await w.cluster.advanceBy(10_000);

    expect((configMap(w, 'portal-site')!.spec as any).host).toBe('new.corp.internal');
  });

  /**
   * 修偏差才是 Operator 的核心价值：别人手工改坏了它造出来的东西，
   * 下一轮 reconcile 要把它改回去。前提是**它 watch 了那个类型**。
   */
  it('别人改坏了它造出来的东西，下一轮改回去', async () => {
    const w = await build(OPERATOR_CODE);
    await createSite(w, 'portal', 'portal.corp.internal');

    const definition = w.cluster.scheme.mustGet(CONFIGMAPS);
    const live = w.cluster.registry.get(definition, 'default', 'portal-site');
    w.cluster.registry.update(definition, 'default', 'portal-site', {
      ...live, spec: { host: 'someone-edited-this' },
    } as KubeObject);
    await w.cluster.advanceBy(10_000);

    expect((configMap(w, 'portal-site')!.spec as any).host).toBe('portal.corp.internal');
  });

  it('不 watch 附属类型：改坏了就一直坏着', async () => {
    const w = await build(BLIND_CODE);
    await createSite(w, 'portal', 'portal.corp.internal');

    const definition = w.cluster.scheme.mustGet(CONFIGMAPS);
    const live = w.cluster.registry.get(definition, 'default', 'portal-site');
    w.cluster.registry.update(definition, 'default', 'portal-site', {
      ...live, spec: { host: 'someone-edited-this' },
    } as KubeObject);
    await w.cluster.advanceBy(60_000);

    expect((configMap(w, 'portal-site')!.spec as any).host).toBe('someone-edited-this');
  });
});

describe('删除', () => {
  it('挂了属主引用：删掉自定义资源，造出来的东西跟着没', async () => {
    const w = await build(OPERATOR_CODE);
    await createSite(w, 'portal', 'portal.corp.internal');
    expect(configMap(w, 'portal-site')).toBeDefined();

    w.cluster.registry.delete(w.cluster.scheme.mustGet(SITES), 'default', 'portal');
    await w.cluster.advanceBy(10_000);
    expect(configMap(w, 'portal-site')).toBeUndefined();
  });

  it('没挂属主引用：删掉之后留下一个没人管的孤儿', async () => {
    const w = await build(ORPHAN_CODE);
    await createSite(w, 'portal', 'portal.corp.internal');

    w.cluster.registry.delete(w.cluster.scheme.mustGet(SITES), 'default', 'portal');
    await w.cluster.advanceBy(10_000);
    expect(configMap(w, 'portal-site')).toBeDefined();
  });
});

describe('Operator 也是一个工作负载', () => {
  it('把它停掉：自定义资源还在，只是没人让它成真', async () => {
    const w = await build(OPERATOR_CODE);
    w.cluster.registry.delete(
      w.cluster.scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' }),
      'default', 'site-operator'
    );
    await w.cluster.advanceBy(30_000);

    await createSite(w, 'portal', 'portal.corp.internal');
    expect(siteOf(w, 'portal')).toBeDefined();
    expect(configMap(w, 'portal-site')).toBeUndefined();
    expect(siteOf(w, 'portal').status ?? {}).toEqual({});
  });

  it('CRD 还没建：Operator 空转，不报错', async () => {
    const world = await createOpsWorld({
      world: spec([OPERATOR_DEPLOYMENT]),
      stage: {
        files: { '/root/operator/site.js': OPERATOR_CODE },
        operator: { path: '/root/operator/site.js', kind: 'Site', name: 'site-operator' },
      },
    });
    await world.cluster.advanceBy(30_000);
    expect(world.cluster.scheme.get(SITES)).toBeUndefined();
  });
});

describe('学员代码出错', () => {
  it('抛异常不会把世界搞崩，而是变成对象上的一条事件', async () => {
    const w = await build('exports.reconcile = () => { throw new Error("boom"); };');
    await createSite(w, 'portal', 'portal.corp.internal');

    const events = w.cluster.registry.list(
      w.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'events' }), { namespace: 'default' }
    ).items;
    const failures = events.filter((event) => (event as any).reason === 'ReconcileError');
    expect(failures.length).toBeGreaterThan(0);
    expect(String((failures[0] as any).message)).toContain('boom');
  });
});
