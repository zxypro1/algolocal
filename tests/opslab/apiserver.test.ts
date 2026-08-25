/**
 * apiserver REST 语义的回归测试
 *
 * 这一层的规矩学员会直接撞上：改冲突了报什么、删不掉是因为什么、
 * 为什么 status 写了不算改 spec。所以报错文本也一并钉死 ——
 * 那是学员排查问题的全部线索。
 */
import { createStore, Store } from '../../src/lib/opslab/store';
import {
  ApiError,
  createScheme,
  FOREGROUND_DELETION,
  KubeObject,
  parseLabelSelector,
  Registry,
  ResourceDefinition,
  Scheme,
} from '../../src/lib/opslab/apiserver';

const PODS: ResourceDefinition = {
  group: '', version: 'v1', resource: 'pods', singular: 'pod', kind: 'Pod',
  namespaced: true, shortNames: ['po'],
};
const DEPLOYMENTS: ResourceDefinition = {
  group: 'apps', version: 'v1', resource: 'deployments', singular: 'deployment',
  kind: 'Deployment', namespaced: true, shortNames: ['deploy'],
};
const NAMESPACES: ResourceDefinition = {
  group: '', version: 'v1', resource: 'namespaces', singular: 'namespace',
  kind: 'Namespace', namespaced: false, shortNames: ['ns'],
};

function setup() {
  const store: Store = createStore();
  const scheme = createScheme([PODS, DEPLOYMENTS, NAMESPACES]);
  let clock = Date.parse('2026-01-01T00:00:00Z');
  let uidSeq = 0;
  const registry = new Registry({
    store,
    scheme,
    now: () => clock,
    uid: () => `uid-${++uidSeq}`,
  });
  return {
    store, scheme, registry,
    tick: (ms: number) => { clock += ms; },
  };
}

const pod = (name: string, extra: Partial<KubeObject> = {}): KubeObject => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name },
  spec: { containers: [{ name: 'app', image: 'nginx:1.0' }] },
  ...extra,
});

describe('创建', () => {
  it('补上 uid、创建时间、generation 与 resourceVersion', () => {
    const { registry } = setup();
    const created = registry.create(PODS, 'default', pod('web'));
    expect(created.metadata).toMatchObject({
      name: 'web',
      namespace: 'default',
      uid: 'uid-1',
      generation: 1,
      creationTimestamp: '2026-01-01T00:00:00Z',
    });
    expect(created.metadata.resourceVersion).toBe('1');
    expect(created.apiVersion).toBe('v1');
    expect(created.kind).toBe('Pod');
  });

  it('重名报 AlreadyExists，文本和真集群一致', () => {
    const { registry } = setup();
    registry.create(PODS, 'default', pod('web'));
    try {
      registry.create(PODS, 'default', pod('web'));
      throw new Error('应该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe(409);
      expect((error as ApiError).reason).toBe('AlreadyExists');
      expect((error as ApiError).message).toBe('pods "web" already exists');
    }
  });

  it('没有名字报 Invalid', () => {
    const { registry } = setup();
    expect(() => registry.create(PODS, 'default', pod('') as KubeObject))
      .toThrow(/Required value: name or generateName is required/);
  });

  it('创建时带 resourceVersion 会被拒绝', () => {
    const { registry } = setup();
    const candidate = pod('web');
    candidate.metadata.resourceVersion = '5';
    expect(() => registry.create(PODS, 'default', candidate))
      .toThrow(/must be empty on create/);
  });

  it('对象里的 namespace 和 URL 上的对不上会被拒绝', () => {
    const { registry } = setup();
    const candidate = pod('web');
    candidate.metadata.namespace = 'other';
    expect(() => registry.create(PODS, 'default', candidate))
      .toThrow(/does not match the namespace sent on the request/);
  });

  it('集群级资源不接受 namespace', () => {
    const { registry } = setup();
    expect(() => registry.create(NAMESPACES, 'default', { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'x' } }))
      .toThrow(/namespace is not allowed on a cluster-scoped resource/);
    const created = registry.create(NAMESPACES, undefined, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'x' } });
    expect(created.metadata.namespace).toBeUndefined();
  });

  it('dryRun 不落盘', () => {
    const { registry } = setup();
    registry.create(PODS, 'default', pod('web'), { dryRun: true });
    expect(() => registry.get(PODS, 'default', 'web')).toThrow(/pods "web" not found/);
  });
});

describe('读取与找不到', () => {
  it('找不到的报错文本和真集群一致', () => {
    const { registry } = setup();
    try {
      registry.get(PODS, 'default', 'nope');
      throw new Error('应该抛错');
    } catch (error) {
      const api = error as ApiError;
      expect(api.code).toBe(404);
      expect(api.message).toBe('pods "nope" not found');
      expect(api.status.details).toMatchObject({ name: 'nope', kind: 'pods' });
    }
  });

  it('列表按名字排序并带上 resourceVersion', () => {
    const { registry } = setup();
    for (const name of ['zeta', 'alpha', 'mid']) registry.create(PODS, 'default', pod(name));
    const list = registry.list(PODS, { namespace: 'default' });
    expect(list.items.map((i) => i.metadata.name)).toEqual(['alpha', 'mid', 'zeta']);
    expect(list.kind).toBe('PodList');
    expect(list.metadata.resourceVersion).toBe('3');
  });

  it('只列出指定命名空间', () => {
    const { registry } = setup();
    registry.create(PODS, 'default', pod('a'));
    registry.create(PODS, 'kube-system', pod('b'));
    expect(registry.list(PODS, { namespace: 'default' }).items.map((i) => i.metadata.name)).toEqual(['a']);
    expect(registry.list(PODS, {}).items.map((i) => i.metadata.name)).toEqual(['a', 'b']);
  });

  it('标签选择器', () => {
    const { registry } = setup();
    registry.create(PODS, 'default', pod('web', { metadata: { name: 'web', labels: { app: 'web', tier: 'front' } } }));
    registry.create(PODS, 'default', pod('db', { metadata: { name: 'db', labels: { app: 'db' } } }));
    const list = registry.list(PODS, { namespace: 'default', labelSelector: 'app=web' });
    expect(list.items.map((i) => i.metadata.name)).toEqual(['web']);
  });

  it('字段选择器', () => {
    const { registry } = setup();
    registry.create(PODS, 'default', pod('a', { spec: { nodeName: 'node-1' } }));
    registry.create(PODS, 'default', pod('b', { spec: { nodeName: 'node-2' } }));
    const list = registry.list(PODS, { namespace: 'default', fieldSelector: 'spec.nodeName=node-1' });
    expect(list.items.map((i) => i.metadata.name)).toEqual(['a']);
  });

  it('分页：continue 翻页且期间的写不会串进来', () => {
    const { registry } = setup();
    for (const name of ['a', 'b', 'c', 'd', 'e']) registry.create(PODS, 'default', pod(name));

    const page1 = registry.list(PODS, { namespace: 'default', limit: 2 });
    expect(page1.items.map((i) => i.metadata.name)).toEqual(['a', 'b']);
    expect(page1.metadata.continue).toBeDefined();
    expect(page1.metadata.remainingItemCount).toBe(3);

    // 翻页期间插入新对象，不应该出现在后续页里 —— 翻的是同一版快照
    registry.create(PODS, 'default', pod('aa'));

    const page2 = registry.list(PODS, { namespace: 'default', limit: 2, continue: page1.metadata.continue });
    expect(page2.items.map((i) => i.metadata.name)).toEqual(['c', 'd']);

    const page3 = registry.list(PODS, { namespace: 'default', limit: 2, continue: page2.metadata.continue });
    expect(page3.items.map((i) => i.metadata.name)).toEqual(['e']);
    expect(page3.metadata.continue).toBeUndefined();
  });

  it('坏掉的 continue token 报 BadRequest', () => {
    const { registry } = setup();
    expect(() => registry.list(PODS, { namespace: 'default', continue: 'garbage' }))
      .toThrow(/continue key is not valid/);
  });
});

describe('更新与乐观并发', () => {
  it('resourceVersion 对得上就更新成功', () => {
    const { registry } = setup();
    const created = registry.create(PODS, 'default', pod('web'));
    const next = { ...created, spec: { containers: [{ name: 'app', image: 'nginx:2.0' }] } };
    const updated = registry.update(PODS, 'default', 'web', next);
    expect((updated.spec as any).containers[0].image).toBe('nginx:2.0');
    expect(updated.metadata.resourceVersion).toBe('2');
  });

  it('中间被别人改过就 409，文本和真集群一致', () => {
    const { registry } = setup();
    const created = registry.create(PODS, 'default', pod('web'));
    // 别人先改了一版
    registry.update(PODS, 'default', 'web', { ...created, spec: { note: 'someone else' } });

    try {
      registry.update(PODS, 'default', 'web', { ...created, spec: { note: 'mine' } });
      throw new Error('应该抛错');
    } catch (error) {
      const api = error as ApiError;
      expect(api.code).toBe(409);
      expect(api.reason).toBe('Conflict');
      expect(api.message).toBe(
        'Operation cannot be fulfilled on pods "web": the object has been modified; ' +
          'please apply your changes to the latest version and try again'
      );
    }
  });

  it('不带 resourceVersion 就是无条件覆盖', () => {
    const { registry } = setup();
    registry.create(PODS, 'default', pod('web'));
    const blind = pod('web', { spec: { note: 'blind write' } });
    expect(() => registry.update(PODS, 'default', 'web', blind)).not.toThrow();
  });

  it('spec 变了才 +generation', () => {
    const { registry } = setup();
    const created = registry.create(PODS, 'default', pod('web'));
    expect(created.metadata.generation).toBe(1);

    // 只改标签
    const labelOnly = registry.update(PODS, 'default', 'web', {
      ...created,
      metadata: { ...created.metadata, labels: { a: 'b' } },
    });
    expect(labelOnly.metadata.generation).toBe(1);

    const specChange = registry.update(PODS, 'default', 'web', {
      ...labelOnly,
      spec: { containers: [{ name: 'app', image: 'nginx:2.0' }] },
    });
    expect(specChange.metadata.generation).toBe(2);
  });

  it('主资源的 update 改不动 status —— 那是子资源', () => {
    const { registry } = setup();
    const created = registry.create(PODS, 'default', pod('web'));
    registry.updateStatus(PODS, 'default', 'web', { ...created, status: { phase: 'Running' } });

    const sneaky = registry.get(PODS, 'default', 'web');
    const after = registry.update(PODS, 'default', 'web', {
      ...sneaky,
      status: { phase: 'Succeeded' },              // 想顺手改 status
      spec: { containers: [] },
    });
    expect((after.status as any).phase).toBe('Running');
  });

  it('写 status 不 +generation —— 否则 observedGeneration 永远追不上', () => {
    const { registry } = setup();
    const created = registry.create(PODS, 'default', pod('web'));
    const after = registry.updateStatus(PODS, 'default', 'web', { ...created, status: { phase: 'Running' } });
    expect(after.metadata.generation).toBe(1);
    expect((after.status as any).phase).toBe('Running');
  });

  it('改名字会被拒绝', () => {
    const { registry } = setup();
    const created = registry.create(PODS, 'default', pod('web'));
    expect(() => registry.update(PODS, 'default', 'web', {
      ...created,
      metadata: { ...created.metadata, name: 'renamed' },
    })).toThrow(/does not match the name on the URL/);
  });

  it('uid 与创建时间由服务端说了算，客户端改不动', () => {
    const { registry } = setup();
    const created = registry.create(PODS, 'default', pod('web'));
    const after = registry.update(PODS, 'default', 'web', {
      ...created,
      metadata: { ...created.metadata, uid: 'forged', creationTimestamp: '1999-01-01T00:00:00Z' },
    });
    expect(after.metadata.uid).toBe('uid-1');
    expect(after.metadata.creationTimestamp).toBe('2026-01-01T00:00:00Z');
  });
});

describe('删除与 finalizer', () => {
  it('没有 finalizer 就直接删掉', () => {
    const { registry } = setup();
    registry.create(PODS, 'default', pod('web'));
    registry.delete(PODS, 'default', 'web');
    expect(() => registry.get(PODS, 'default', 'web')).toThrow(/not found/);
  });

  it('有 finalizer 的删不掉，只是被标上 deletionTimestamp', () => {
    const { registry, tick } = setup();
    registry.create(PODS, 'default', pod('web', {
      metadata: { name: 'web', finalizers: ['example.com/cleanup'] },
    }));
    tick(5000);
    const deleted = registry.delete(PODS, 'default', 'web');
    expect(deleted.metadata.deletionTimestamp).toBe('2026-01-01T00:00:05Z');

    // 对象还在
    const still = registry.get(PODS, 'default', 'web');
    expect(still.metadata.deletionTimestamp).toBeDefined();
    expect(still.metadata.finalizers).toEqual(['example.com/cleanup']);
  });

  it('摘掉最后一个 finalizer，对象才真的消失', () => {
    const { registry } = setup();
    registry.create(PODS, 'default', pod('web', {
      metadata: { name: 'web', finalizers: ['a', 'b'] },
    }));
    registry.delete(PODS, 'default', 'web');

    const afterFirst = registry.removeFinalizer(PODS, 'default', 'web', 'a');
    expect(afterFirst).not.toBeNull();
    expect(afterFirst!.metadata.finalizers).toEqual(['b']);

    const afterSecond = registry.removeFinalizer(PODS, 'default', 'web', 'b');
    expect(afterSecond).toBeNull();
    expect(() => registry.get(PODS, 'default', 'web')).toThrow(/not found/);
  });

  it('没标删除时摘 finalizer，对象继续活着', () => {
    const { registry } = setup();
    registry.create(PODS, 'default', pod('web', { metadata: { name: 'web', finalizers: ['a'] } }));
    const after = registry.removeFinalizer(PODS, 'default', 'web', 'a');
    expect(after).not.toBeNull();
    expect(after!.metadata.deletionTimestamp).toBeUndefined();
  });

  it('前台级联删除会加上 foregroundDeletion finalizer', () => {
    const { registry } = setup();
    registry.create(PODS, 'default', pod('web'));
    const deleted = registry.delete(PODS, 'default', 'web', { propagationPolicy: 'Foreground' });
    expect(deleted.metadata.finalizers).toContain(FOREGROUND_DELETION);
    expect(deleted.metadata.deletionTimestamp).toBeDefined();
  });

  it('uid 前置条件对不上会拒绝 —— 防的是「删到了重建后的同名对象」', () => {
    const { registry } = setup();
    registry.create(PODS, 'default', pod('web'));
    expect(() => registry.delete(PODS, 'default', 'web', { preconditions: { uid: 'stale-uid' } }))
      .toThrow(/The object might have been deleted and then recreated/);
  });
});

describe('watch', () => {
  it('ADDED / MODIFIED / DELETED 三种事件', () => {
    const { registry } = setup();
    const seen: string[] = [];
    registry.watch(PODS, { namespace: 'default' }, (e) => seen.push(`${e.type} ${e.object.metadata.name}`));

    const created = registry.create(PODS, 'default', pod('web'));
    registry.update(PODS, 'default', 'web', { ...created, spec: { note: 'changed' } });
    registry.delete(PODS, 'default', 'web');

    expect(seen).toEqual(['ADDED web', 'MODIFIED web', 'DELETED web']);
  });

  it('从 list 拿到的 resourceVersion 起 watch 不会漏事件', () => {
    const { registry } = setup();
    registry.create(PODS, 'default', pod('a'));
    const listed = registry.list(PODS, { namespace: 'default' });
    // watch 建立之前发生的变更
    registry.create(PODS, 'default', pod('b'));

    const seen: string[] = [];
    registry.watch(
      PODS,
      { namespace: 'default', resourceVersion: listed.metadata.resourceVersion },
      (e) => seen.push(`${e.type} ${e.object.metadata.name}`)
    );
    expect(seen).toEqual(['ADDED b']);
  });

  it('版本太老报 410 Gone，informer 收到后应当重新 list', () => {
    const { registry, store } = setup();
    registry.create(PODS, 'default', pod('a'));
    registry.create(PODS, 'default', pod('b'));
    store.compact(2);
    try {
      registry.watch(PODS, { namespace: 'default', resourceVersion: '1' }, () => {});
      throw new Error('应该抛错');
    } catch (error) {
      const api = error as ApiError;
      expect(api.code).toBe(410);
      expect(api.message).toMatch(/^too old resource version: 1 \(2\)$/);
    }
  });

  it('watch 支持标签选择器', () => {
    const { registry } = setup();
    const seen: string[] = [];
    registry.watch(PODS, { namespace: 'default', labelSelector: 'app=web' }, (e) => seen.push(e.object.metadata.name));
    registry.create(PODS, 'default', pod('web', { metadata: { name: 'web', labels: { app: 'web' } } }));
    registry.create(PODS, 'default', pod('db', { metadata: { name: 'db', labels: { app: 'db' } } }));
    expect(seen).toEqual(['web']);
  });
});

describe('scheme', () => {
  it('复数、单数、简称、带组名都能解析到同一个资源', () => {
    const scheme = createScheme([PODS, DEPLOYMENTS]);
    for (const name of ['pods', 'pod', 'po', 'Pods', 'PO']) {
      expect(scheme.resolve(name)?.kind).toBe('Pod');
    }
    expect(scheme.resolve('deploy')?.kind).toBe('Deployment');
    expect(scheme.resolve('deployments.apps')?.kind).toBe('Deployment');
  });

  it('解析结果稳定 —— 同名资源按组名定序，核心组优先', () => {
    const scheme = createScheme([
      { group: 'zzz', version: 'v1', resource: 'widgets', singular: 'widget', kind: 'ZWidget', namespaced: true },
      { group: '', version: 'v1', resource: 'widgets', singular: 'widget', kind: 'CoreWidget', namespaced: true },
      { group: 'aaa', version: 'v1', resource: 'widgets', singular: 'widget', kind: 'AWidget', namespaced: true },
    ]);
    for (let i = 0; i < 20; i += 1) expect(scheme.resolve('widgets')?.kind).toBe('CoreWidget');
  });

  it('groupVersions 稳定排序，核心组的 v1 在最前', () => {
    const scheme = createScheme([DEPLOYMENTS, PODS, NAMESPACES]);
    expect(scheme.groupVersions()).toEqual(['v1', 'apps/v1']);
  });

  it('apiVersion 的拆与合', () => {
    expect(Scheme.parseApiVersion('apps/v1')).toEqual({ group: 'apps', version: 'v1' });
    expect(Scheme.parseApiVersion('v1')).toEqual({ group: '', version: 'v1' });
    expect(Scheme.toApiVersion('apps', 'v1')).toBe('apps/v1');
    expect(Scheme.toApiVersion('', 'v1')).toBe('v1');
  });
});

describe('标签选择器语法', () => {
  it('等于、不等于、存在、不存在、in、notin', () => {
    const labels = { app: 'web', tier: 'front' };
    expect(parseLabelSelector('app=web')(labels)).toBe(true);
    expect(parseLabelSelector('app=db')(labels)).toBe(false);
    expect(parseLabelSelector('app!=db')(labels)).toBe(true);
    expect(parseLabelSelector('app')(labels)).toBe(true);
    expect(parseLabelSelector('!missing')(labels)).toBe(true);
    expect(parseLabelSelector('app in (web,db)')(labels)).toBe(true);
    expect(parseLabelSelector('app notin (web,db)')(labels)).toBe(false);
    expect(parseLabelSelector('app==web')(labels)).toBe(true);
    expect(parseLabelSelector('app=web,tier=front')(labels)).toBe(true);
    expect(parseLabelSelector('app=web,tier=back')(labels)).toBe(false);
    // 括号里的逗号不是子句分隔符 —— 直接 split(',') 会把这条切碎
    expect(parseLabelSelector('app in (web,db),tier=front')(labels)).toBe(true);
    expect(parseLabelSelector('app in (db,cache),tier=front')(labels)).toBe(false);
  });
});

describe('确定性', () => {
  it('同一串操作重放 100 次，输出逐字节一致', () => {
    const run = () => {
      const { registry } = setup();
      const log: string[] = [];
      registry.watch(PODS, {}, (e) => log.push(`${e.type} ${e.object.metadata.name}@${e.object.metadata.resourceVersion}`));

      for (const name of ['delta', 'alpha', 'charlie']) {
        registry.create(PODS, 'default', pod(name, { metadata: { name, labels: { batch: 'one' } } }));
      }
      const alpha = registry.get(PODS, 'default', 'alpha');
      registry.update(PODS, 'default', 'alpha', { ...alpha, spec: { note: 'updated' } });
      registry.updateStatus(PODS, 'default', 'alpha', { ...registry.get(PODS, 'default', 'alpha'), status: { phase: 'Running' } });
      registry.delete(PODS, 'default', 'delta');

      log.push(JSON.stringify(registry.list(PODS, { namespace: 'default' })));
      return log.join('\n');
    };
    const first = run();
    for (let i = 0; i < 99; i += 1) expect(run()).toBe(first);
  });
});
