/**
 * apiserver HTTP 面的回归测试
 *
 * 真 kubectl 通过被拦截的 fetch 打进来，所以路由形状、discovery 内容、
 * 表格列、错误码都要和真集群对得上。表格那部分尤其要紧 ——
 * spike 时踩过：不实现服务端渲染，kubectl get 只剩 NAME/AGE 两列。
 */
import { createStore } from '../../src/lib/opslab/store';
import {
  ApiServer,
  createApiServer,
  createScheme,
  humanDuration,
  KubeObject,
  parsePath,
  Registry,
  ResourceDefinition,
} from '../../src/lib/opslab/apiserver';

const PODS: ResourceDefinition = {
  group: '', version: 'v1', resource: 'pods', singular: 'pod', kind: 'Pod',
  namespaced: true, shortNames: ['po'], subresources: ['status'],
};
const NAMESPACES: ResourceDefinition = {
  group: '', version: 'v1', resource: 'namespaces', singular: 'namespace',
  kind: 'Namespace', namespaced: false, shortNames: ['ns'],
};
const DEPLOYMENTS: ResourceDefinition = {
  group: 'apps', version: 'v1', resource: 'deployments', singular: 'deployment',
  kind: 'Deployment', namespaced: true, shortNames: ['deploy'], subresources: ['status', 'scale'],
};

const TABLE_ACCEPT = 'application/json;as=Table;v=v1;g=meta.k8s.io,application/json';

function setup() {
  const store = createStore();
  const scheme = createScheme([PODS, NAMESPACES, DEPLOYMENTS]);
  let clock = Date.parse('2026-01-01T00:00:00Z');
  let uid = 0;
  const registry = new Registry({ store, scheme, now: () => clock, uid: () => `uid-${++uid}` });
  const server: ApiServer = createApiServer({ registry, scheme, now: () => clock });
  return { store, scheme, registry, server, tick: (ms: number) => { clock += ms; } };
}

const podObject = (name: string, extra: Record<string, unknown> = {}): KubeObject => ({
  apiVersion: 'v1', kind: 'Pod',
  metadata: { name },
  spec: { nodeName: 'node-1', containers: [{ name: 'app', image: 'nginx:1.0' }] },
  status: {
    phase: 'Running', podIP: '10.42.1.7',
    containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }],
  },
  ...extra,
});

async function body(response: Response): Promise<any> {
  return JSON.parse(await response.text());
}

describe('路径解析', () => {
  it('核心组与带组的资源', () => {
    expect(parsePath('/api/v1/pods')).toMatchObject({ group: '', version: 'v1', resource: 'pods' });
    expect(parsePath('/apis/apps/v1/deployments')).toMatchObject({ group: 'apps', version: 'v1', resource: 'deployments' });
  });

  it('命名空间前缀与资源名', () => {
    expect(parsePath('/api/v1/namespaces/default/pods')).toMatchObject({ namespace: 'default', resource: 'pods' });
    expect(parsePath('/api/v1/namespaces/default/pods/web')).toMatchObject({ namespace: 'default', resource: 'pods', name: 'web' });
    expect(parsePath('/api/v1/namespaces/default/pods/web/status')).toMatchObject({ subresource: 'status' });
  });

  it('namespaces 自己也是资源 —— /api/v1/namespaces/default 取的是那个对象', () => {
    // 这是 k8s 路由里最容易写错的一处
    expect(parsePath('/api/v1/namespaces/default')).toMatchObject({
      resource: 'namespaces', name: 'default', namespace: undefined,
    });
    expect(parsePath('/api/v1/namespaces')).toMatchObject({ resource: 'namespaces', name: undefined });
  });

  it('认不出来的路径返回 null', () => {
    expect(parsePath('/healthz')).toBeNull();
    expect(parsePath('/apis/apps')).toBeNull();
  });
});

describe('discovery', () => {
  it('/api 列出核心版本', async () => {
    const { server } = setup();
    expect(await body(await server.handle('/api'))).toMatchObject({ kind: 'APIVersions', versions: ['v1'] });
  });

  it('/apis 列出非核心组', async () => {
    const { server } = setup();
    const groups = await body(await server.handle('/apis'));
    expect(groups.kind).toBe('APIGroupList');
    expect(groups.groups.map((g: any) => g.name)).toEqual(['apps']);
    expect(groups.groups[0].preferredVersion).toEqual({ groupVersion: 'apps/v1', version: 'v1' });
  });

  it('/api/v1 列出资源、简称与是否带命名空间', async () => {
    const { server } = setup();
    const list = await body(await server.handle('/api/v1'));
    const pods = list.resources.find((r: any) => r.name === 'pods');
    expect(pods).toMatchObject({ name: 'pods', singularName: 'pod', namespaced: true, kind: 'Pod', shortNames: ['po'] });
    const namespaces = list.resources.find((r: any) => r.name === 'namespaces');
    expect(namespaces.namespaced).toBe(false);
  });

  it('子资源在 discovery 里是独立条目', async () => {
    const { server } = setup();
    const list = await body(await server.handle('/api/v1'));
    expect(list.resources.map((r: any) => r.name)).toContain('pods/status');
  });

  it('/version', async () => {
    const { server } = setup();
    expect(await body(await server.handle('/version'))).toMatchObject({ major: '1', minor: '36', gitVersion: 'v1.36.0' });
  });
});

describe('资源读写', () => {
  it('POST 创建、GET 读回、DELETE 删掉', async () => {
    const { server } = setup();
    const created = await server.handle('/api/v1/namespaces/default/pods', {
      method: 'POST', body: JSON.stringify(podObject('web')),
    });
    expect(created.status).toBe(201);
    expect((await body(created)).metadata.uid).toBe('uid-1');

    const fetched = await server.handle('/api/v1/namespaces/default/pods/web');
    expect(fetched.status).toBe(200);
    expect((await body(fetched)).metadata.name).toBe('web');

    expect((await server.handle('/api/v1/namespaces/default/pods/web', { method: 'DELETE' })).status).toBe(200);
    expect((await server.handle('/api/v1/namespaces/default/pods/web')).status).toBe(404);
  });

  it('找不到时返回 404 与完整的 Status 对象', async () => {
    const { server } = setup();
    const response = await server.handle('/api/v1/namespaces/default/pods/nope');
    expect(response.status).toBe(404);
    expect(await body(response)).toMatchObject({
      kind: 'Status', apiVersion: 'v1', status: 'Failure',
      reason: 'NotFound', code: 404, message: 'pods "nope" not found',
    });
  });

  it('list 支持标签选择器与跨命名空间', async () => {
    const { server } = setup();
    await server.handle('/api/v1/namespaces/default/pods', { method: 'POST', body: JSON.stringify(podObject('web', { metadata: { name: 'web', labels: { app: 'web' } } })) });
    await server.handle('/api/v1/namespaces/other/pods', { method: 'POST', body: JSON.stringify(podObject('db', { metadata: { name: 'db', labels: { app: 'db' } } })) });

    // 跨命名空间的 list 按 (命名空间, 名字) 排，不是只按名字 ——
    // default/web 排在 other/db 前面，和真集群一致
    const all = await body(await server.handle('/api/v1/pods'));
    expect(all.items.map((i: any) => `${i.metadata.namespace}/${i.metadata.name}`))
      .toEqual(['default/web', 'other/db']);

    const filtered = await body(await server.handle('/api/v1/pods?labelSelector=app%3Dweb'));
    expect(filtered.items.map((i: any) => i.metadata.name)).toEqual(['web']);
  });

  it('status 子资源单独写，不动 spec', async () => {
    const { server } = setup();
    await server.handle('/api/v1/namespaces/default/pods', { method: 'POST', body: JSON.stringify(podObject('web')) });
    const current = await body(await server.handle('/api/v1/namespaces/default/pods/web'));

    await server.handle('/api/v1/namespaces/default/pods/web/status', {
      method: 'PUT',
      body: JSON.stringify({ ...current, status: { phase: 'Succeeded' } }),
    });
    const after = await body(await server.handle('/api/v1/namespaces/default/pods/web'));
    expect((after.status as any).phase).toBe('Succeeded');
    expect(after.metadata.generation).toBe(1);       // status 不 bump generation
  });

  it('冲突返回 409', async () => {
    const { server } = setup();
    await server.handle('/api/v1/namespaces/default/pods', { method: 'POST', body: JSON.stringify(podObject('web')) });
    const stale = await body(await server.handle('/api/v1/namespaces/default/pods/web'));
    await server.handle('/api/v1/namespaces/default/pods/web', {
      method: 'PUT', body: JSON.stringify({ ...stale, spec: { note: 'first' } }),
    });
    const response = await server.handle('/api/v1/namespaces/default/pods/web', {
      method: 'PUT', body: JSON.stringify({ ...stale, spec: { note: 'second' } }),
    });
    expect(response.status).toBe(409);
    expect((await body(response)).reason).toBe('Conflict');
  });

  it('请求体不是 JSON 时返回 400', async () => {
    const { server } = setup();
    const response = await server.handle('/api/v1/namespaces/default/pods', { method: 'POST', body: 'not json' });
    expect(response.status).toBe(400);
  });
});

describe('服务端表格渲染', () => {
  it('不带 Accept 时返回普通列表', async () => {
    const { server } = setup();
    await server.handle('/api/v1/namespaces/default/pods', { method: 'POST', body: JSON.stringify(podObject('web')) });
    const list = await body(await server.handle('/api/v1/namespaces/default/pods'));
    expect(list.kind).toBe('PodList');
  });

  it('带 as=Table 时返回 Table，列与真集群一致', async () => {
    const { server, tick } = setup();
    await server.handle('/api/v1/namespaces/default/pods', { method: 'POST', body: JSON.stringify(podObject('web')) });
    tick(4 * 3600_000 + 12 * 60_000);              // 4h12m

    const table = await body(await server.handle('/api/v1/namespaces/default/pods', {
      headers: { Accept: TABLE_ACCEPT },
    }));
    expect(table.kind).toBe('Table');
    expect(table.columnDefinitions.filter((c: any) => c.priority === 0).map((c: any) => c.name))
      .toEqual(['Name', 'Ready', 'Status', 'Restarts', 'Age']);
    expect(table.columnDefinitions.filter((c: any) => c.priority === 1).map((c: any) => c.name))
      .toEqual(['IP', 'Node', 'Nominated Node', 'Readiness Gates']);
    expect(table.rows[0].cells).toEqual([
      'web', '1/1', 'Running', '0', '4h12m', '10.42.1.7', 'node-1', '<none>', '<none>',
    ]);
  });

  it('Accept 头是 Headers 实例时也认得出来', async () => {
    const { server } = setup();
    await server.handle('/api/v1/namespaces/default/pods', { method: 'POST', body: JSON.stringify(podObject('web')) });
    const table = await body(await server.handle('/api/v1/namespaces/default/pods', {
      headers: new Headers({ Accept: TABLE_ACCEPT }),
    }));
    expect(table.kind).toBe('Table');
  });

  it('正在删除的 Pod 显示 Terminating', async () => {
    const { server } = setup();
    await server.handle('/api/v1/namespaces/default/pods', {
      method: 'POST',
      body: JSON.stringify(podObject('web', { metadata: { name: 'web', finalizers: ['x'] } })),
    });
    await server.handle('/api/v1/namespaces/default/pods/web', { method: 'DELETE' });
    const table = await body(await server.handle('/api/v1/namespaces/default/pods', { headers: { Accept: TABLE_ACCEPT } }));
    expect(table.rows[0].cells[2]).toBe('Terminating');
  });

  it('没登记打印器的资源退化成 NAME + AGE', async () => {
    const store = createStore();
    const scheme = createScheme([{ group: '', version: 'v1', resource: 'widgets', singular: 'widget', kind: 'Widget', namespaced: true }]);
    const registry = new Registry({ store, scheme, now: () => 0, uid: () => 'u' });
    const server = createApiServer({ registry, scheme, now: () => 0 });
    await server.handle('/api/v1/namespaces/default/widgets', {
      method: 'POST', body: JSON.stringify({ apiVersion: 'v1', kind: 'Widget', metadata: { name: 'w' } }),
    });
    const table = await body(await server.handle('/api/v1/namespaces/default/widgets', { headers: { Accept: TABLE_ACCEPT } }));
    expect(table.columnDefinitions.map((c: any) => c.name)).toEqual(['Name', 'Age']);
  });
});

describe('humanDuration 与 k8s 一致', () => {
  const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
  it.each([
    [30 * S, '30s'],
    [90 * S, '1m30s'],
    [10 * M, '10m'],
    [4 * H + 12 * M, '4h12m'],
    [13 * H, '13h'],
    [3 * D + 4 * H, '3d4h'],
    [13 * D, '13d'],
    [400 * D, '1y35d'],
  ])('%i ms -> %s', (elapsed, expected) => {
    expect(humanDuration(0, elapsed as number)).toBe(expected);
  });

  it('未来的时间戳报 <invalid>，不是负数', () => {
    expect(humanDuration(1000, 0)).toBe('<invalid>');
  });
});

describe('watch 流', () => {
  it('每行一个 JSON 事件', async () => {
    const { server } = setup();
    const response = await server.handle('/api/v1/namespaces/default/pods?watch=true');
    expect(response.headers.get('content-type')).toBe('application/json');

    const reader = response.body!.getReader();
    await server.handle('/api/v1/namespaces/default/pods', { method: 'POST', body: JSON.stringify(podObject('web')) });

    const { value } = await reader.read();
    const line = new TextDecoder().decode(value).trim();
    const event = JSON.parse(line);
    expect(event.type).toBe('ADDED');
    expect(event.object.metadata.name).toBe('web');
    await reader.cancel();
  });
});

describe('确定性', () => {
  it('同一串请求重放 50 次，响应逐字节一致', async () => {
    const run = async () => {
      const { server } = setup();
      const out: string[] = [];
      const record = async (path: string, init?: RequestInit) => {
        const response = await server.handle(path, init);
        out.push(`${response.status} ${await response.text()}`);
      };
      await record('/api');
      await record('/apis');
      await record('/api/v1');
      for (const name of ['delta', 'alpha', 'charlie']) {
        await record('/api/v1/namespaces/default/pods', { method: 'POST', body: JSON.stringify(podObject(name)) });
      }
      await record('/api/v1/namespaces/default/pods', { headers: { Accept: TABLE_ACCEPT } });
      await record('/api/v1/namespaces/default/pods/nope');
      return out.join('\n');
    };
    const first = await run();
    for (let i = 0; i < 49; i += 1) expect(await run()).toBe(first);
  });
});
