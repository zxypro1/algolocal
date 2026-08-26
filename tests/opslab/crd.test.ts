/**
 * CustomResourceDefinition
 *
 * 一个 CRD 干的事只有一件：让 apiserver 多认识一种类型。认识之后，
 * 存储、watch、`kubectl get`、YAML apply 全套白送 —— 这一组就是在钉这件事。
 *
 * 反过来那一半同样重要：删 CRD 会连带删掉这个类型的**所有对象**。
 */
import { createOpsWorld } from '../../src/lib/opslab/lab';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const CRDS = { group: 'apiextensions.k8s.io', version: 'v1', resource: 'customresourcedefinitions' } as const;
const SITES = { group: 'platform.corp.internal', version: 'v1', resource: 'sites' } as const;

const SITE_CRD = {
  apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition',
  metadata: { name: 'sites.platform.corp.internal' },
  spec: {
    group: 'platform.corp.internal',
    scope: 'Namespaced',
    names: { plural: 'sites', singular: 'site', kind: 'Site', shortNames: ['st'] },
    versions: [{
      name: 'v1', served: true, storage: true,
      subresources: { status: {} },
      additionalPrinterColumns: [
        { name: 'Host', type: 'string', jsonPath: '.spec.host' },
        { name: 'Ready', type: 'string', jsonPath: '.status.ready' },
      ],
    }],
  },
};

const site = (name: string, host: string) => ({
  apiVersion: 'platform.corp.internal/v1', kind: 'Site',
  metadata: { name, namespace: 'default' },
  spec: { host, service: { name: 'portal', port: 80 } },
});

function spec(objects: unknown[]): OpsWorldSpec {
  return { namespaces: ['default'], objects: objects as never };
}

async function build(objects: unknown[] = []) {
  const world = await createOpsWorld({ world: spec(objects) });
  await world.cluster.advanceBy(10_000);
  return world;
}

type World = Awaited<ReturnType<typeof build>>;

const apply = (w: World, definition: any, namespace: string | undefined, object: unknown) =>
  w.cluster.registry.create(w.cluster.scheme.mustGet(definition), namespace, object as KubeObject);

describe('注册一种新类型', () => {
  it('apply 一个 CRD 之后，这个类型就存在了', async () => {
    const w = await build();
    expect(w.cluster.scheme.get(SITES)).toBeUndefined();

    apply(w, CRDS, undefined, SITE_CRD);
    await w.cluster.advanceBy(5_000);

    const definition = w.cluster.scheme.get(SITES);
    expect(definition).toBeDefined();
    expect(definition!.kind).toBe('Site');
    expect(definition!.namespaced).toBe(true);
    expect(definition!.shortNames).toEqual(['st']);
    expect(definition!.subresources).toContain('status');
  });

  /**
   * kubectl 在 apply 一个自定义资源之前会看 discovery，
   * 而 discovery 里有没有它取决于 Established 有没有写上。
   * 「CRD 和 CR 写在同一个 YAML 里，一次 apply 报 no matches for kind」
   * 就是这半秒钟的时间差。
   */
  it('注册完会把 Established 写上，名字也接受了', async () => {
    const w = await build([SITE_CRD]);
    const crd = w.cluster.registry.get(w.cluster.scheme.mustGet(CRDS), undefined, 'sites.platform.corp.internal');
    const status = (crd.status ?? {}) as any;
    expect(status.conditions.map((condition: any) => [condition.type, condition.status]))
      .toEqual([['NamesAccepted', 'True'], ['Established', 'True']]);
    expect(status.acceptedNames.kind).toBe('Site');
    expect(status.storedVersions).toEqual(['v1']);
  });

  it('缺 group 或者没有版本：不注册，而且说得出为什么', async () => {
    const w = await build([{
      apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition',
      metadata: { name: 'broken.example.com' },
      spec: { scope: 'Namespaced', names: { plural: 'broken', kind: 'Broken' }, versions: [] },
    }]);
    const crd = w.cluster.registry.get(w.cluster.scheme.mustGet(CRDS), undefined, 'broken.example.com');
    const conditions = ((crd.status ?? {}) as any).conditions ?? [];
    expect(conditions[0]).toMatchObject({ type: 'NamesAccepted', status: 'False' });
  });

  it('注册之后就能存对象，watch 和 status 子资源都白送', async () => {
    const w = await build([SITE_CRD]);
    apply(w, SITES, 'default', site('portal', 'portal.corp.internal'));

    const definition = w.cluster.scheme.mustGet(SITES);
    const stored = w.cluster.registry.get(definition, 'default', 'portal');
    expect((stored.spec as any).host).toBe('portal.corp.internal');

    w.cluster.registry.updateStatus(definition, 'default', 'portal', {
      ...stored, status: { ready: true },
    });
    expect((w.cluster.registry.get(definition, 'default', 'portal').status as any).ready).toBe(true);
  });
});

describe('表格列', () => {
  it('kubectl get 打出来的列是 CRD 上声明的那些', async () => {
    const w = await build([SITE_CRD]);
    apply(w, SITES, 'default', site('portal', 'portal.corp.internal'));
    const definition = w.cluster.scheme.mustGet(SITES);
    const stored = w.cluster.registry.get(definition, 'default', 'portal');
    w.cluster.registry.updateStatus(definition, 'default', 'portal', { ...stored, status: { ready: true } });

    const response = await w.cluster.apiServer.handle(
      '/apis/platform.corp.internal/v1/namespaces/default/sites',
      { headers: { accept: 'application/json;as=Table;g=meta.k8s.io;v=v1' } }
    );
    const table = await response.json();
    expect(table.columnDefinitions.map((column: any) => column.name))
      .toEqual(['Name', 'Host', 'Ready', 'Age']);
    expect(table.rows[0].cells.slice(0, 3)).toEqual(['portal', 'portal.corp.internal', 'true']);
  });
});

describe('删掉 CRD', () => {
  /**
   * 这一步真集群里也是这样，而且没有回收站。
   * `kubectl delete crd` 属于该先深呼吸再敲回车的命令。
   */
  it('CRD 没了，这个类型的对象全部跟着没', async () => {
    const w = await build([SITE_CRD]);
    apply(w, SITES, 'default', site('portal', 'portal.corp.internal'));
    apply(w, SITES, 'default', site('reports', 'reports.corp.internal'));
    expect(w.cluster.registry.list(w.cluster.scheme.mustGet(SITES), {}).items).toHaveLength(2);

    w.cluster.registry.delete(w.cluster.scheme.mustGet(CRDS), undefined, 'sites.platform.corp.internal');
    await w.cluster.advanceBy(5_000);

    expect(w.cluster.scheme.get(SITES)).toBeUndefined();
  });
});
