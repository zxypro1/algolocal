/**
 * 最小 apiserver：三个 GVK（v1/Namespace、v1/Pod、apps/v1/Deployment）
 *
 * spike 只要证明「真 kubectl 能把我们当成一个集群」，所以这里只实现 kubectl
 * 走 get / describe / apply 时真正会打的那几条路径：discovery、list、get、
 * create/patch。资源按名字排序 —— 确定性从这里开始。
 */
const enc = new TextEncoder();

export function createAPIServer(
  seed: Record<string, any[]> = {},
  { now = () => Date.now() }: { now?: () => number } = {}
) {
  // collection key: `${group}/${version}/${resource}` -> Map<ns/name, object>
  const store = new Map<string, Map<string, any>>();
  const key = (g: string, v: string, r: string) => `${g}/${v}/${r}`;
  const coll = (g: string, v: string, r: string) => {
    const k = key(g, v, r);
    if (!store.has(k)) store.set(k, new Map());
    return store.get(k)!;
  };
  let revision = 1;
  const log: string[] = [];

  const RESOURCES = [
    { group: '', version: 'v1', resource: 'namespaces', kind: 'Namespace', namespaced: false, short: ['ns'] },
    { group: '', version: 'v1', resource: 'pods', kind: 'Pod', namespaced: true, short: ['po'] },
    { group: 'apps', version: 'v1', resource: 'deployments', kind: 'Deployment', namespaced: true, short: ['deploy'] },
  ];

  for (const [k, objs] of Object.entries(seed)) {
    const [g, v, r] = k.split('/');
    for (const o of objs) put(g, v, r, o);
  }

  function put(g: string, v: string, r: string, obj: any) {
    const meta = obj.metadata || (obj.metadata = {});
    meta.uid = meta.uid || `uid-${meta.namespace || '_'}-${meta.name}`;
    meta.resourceVersion = String(++revision);
    meta.creationTimestamp = meta.creationTimestamp || '2026-01-01T00:00:00Z';
    coll(g, v, r).set(`${meta.namespace || '_'}/${meta.name}`, obj);
    return obj;
  }

  function listOf(g: string, v: string, r: string, ns?: string) {
    const info = RESOURCES.find(x => x.group === g && x.version === v && x.resource === r)!;
    const all = [...coll(g, v, r).entries()]
      .filter(([k]) => !ns || k.startsWith(ns + '/'))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))   // 稳定顺序：确定性的关键
      .map(([, o]) => o);
    return {
      apiVersion: g ? `${g}/${v}` : v,
      kind: info.kind + 'List',
      metadata: { resourceVersion: String(revision) },
      items: all,
    };
  }

  function json(body: unknown, status = 200) {
    return new Response(enc.encode(JSON.stringify(body)), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  function notFound(msg: string) {
    return json({ kind: 'Status', apiVersion: 'v1', status: 'Failure', message: msg, reason: 'NotFound', code: 404 }, 404);
  }

  // kubectl 默认的表格是**服务端**渲染的（Accept: ...as=Table;g=meta.k8s.io）。
  // 不实现它的话，kubectl 会退化成通用打印，只剩 NAME/AGE 两列 —— 和真集群不一样。
  // 列定义抄自 k8s 的 printers，AGE 由 kubectl 客户端按 creationTimestamp 算。
  // priority 1 的列只在 -o wide 时显示，和真 apiserver 一致
  const TABLE_COLUMNS = {
    pods: [
      { name: 'Name', type: 'string', format: 'name', description: 'Name' },
      { name: 'Ready', type: 'string', description: 'Ready containers' },
      { name: 'Status', type: 'string', description: 'Status' },
      { name: 'Restarts', type: 'string', description: 'Restarts' },
      { name: 'Age', type: 'string', description: 'Age' },
      { name: 'IP', type: 'string', priority: 1, description: 'Pod IP' },
      { name: 'Node', type: 'string', priority: 1, description: 'Node' },
      { name: 'Nominated Node', type: 'string', priority: 1, description: 'Nominated node' },
      { name: 'Readiness Gates', type: 'string', priority: 1, description: 'Readiness gates' },
    ],
    deployments: [
      { name: 'Name', type: 'string', format: 'name', description: 'Name' },
      { name: 'Ready', type: 'string', description: 'Ready' },
      { name: 'Up-to-date', type: 'string', description: 'Updated' },
      { name: 'Available', type: 'string', description: 'Available' },
      { name: 'Age', type: 'string', description: 'Age' },
    ],
    namespaces: [
      { name: 'Name', type: 'string', format: 'name', description: 'Name' },
      { name: 'Status', type: 'string', description: 'Status' },
      { name: 'Age', type: 'string', description: 'Age' },
    ],
  };

  // AGE 由 apiserver 算好再发给 kubectl（真集群也是这样），
  // 「现在」取自模拟世界的虚拟时钟 —— 于是快进时间时 AGE 会跟着动。
  function humanDuration(fromISO: string) {
    const ms = now() - Date.parse(fromISO);
    if (!Number.isFinite(ms) || ms < 0) return '<invalid>';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 && m < 10 ? `${m}m${s % 60}s` : `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 && h < 10 ? `${h}h${m % 60}m` : `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 365) return h % 24 && d < 10 ? `${d}d${h % 24}h` : `${d}d`;
    const y = Math.floor(d / 365);
    return d % 365 && y < 10 ? `${y}y${d % 365}d` : `${y}y`;
  }

  function rowFor(resource: string, o: any) {
    const age = humanDuration(o.metadata.creationTimestamp);
    if (resource === 'pods') {
      const cs: any[] = o.status?.containerStatuses || [];
      const ready = `${cs.filter((c: any) => c.ready).length}/${cs.length || (o.spec?.containers || []).length}`;
      const restarts = String(cs.reduce((n: number, c: any) => n + (c.restartCount || 0), 0));
      return [o.metadata.name, ready, o.status?.phase || 'Unknown', restarts, age,
              o.status?.podIP || '<none>', o.spec?.nodeName || '<none>', '<none>', '<none>'];
    }
    if (resource === 'deployments') {
      const st = o.status || {};
      return [o.metadata.name, `${st.readyReplicas || 0}/${o.spec?.replicas ?? 0}`,
              String(st.updatedReplicas || 0), String(st.availableReplicas || 0), age];
    }
    return [o.metadata.name, o.status?.phase || 'Active', age];
  }

  function tableFor(resource: string, list: any) {
    return {
      kind: 'Table', apiVersion: 'meta.k8s.io/v1',
      metadata: { resourceVersion: list.metadata.resourceVersion },
      columnDefinitions: ((TABLE_COLUMNS as any)[resource] || TABLE_COLUMNS.namespaces).map((c: any) => ({ priority: 0, ...c })),
      rows: list.items.map((o: any) => ({
        cells: rowFor(resource, o),
        object: { kind: 'PartialObjectMetadata', apiVersion: 'meta.k8s.io/v1', metadata: o.metadata },
      })),
    };
  }

  function wantsTable(init: any) {
    const h: any = init.headers || {};
    const accept = h.Accept || h.accept || (typeof h.get === 'function' ? h.get('accept') : '') || '';
    return String(accept).includes('as=Table');
  }

  async function handle(url: string, init: any = {}): Promise<Response> {
    const u = new URL(url, 'https://apiserver.opslab');
    const p = u.pathname;
    const method = (init.method || 'GET').toUpperCase();
    log.push(`${method} ${p}${u.search}`);

    if (p === '/api') return json({ kind: 'APIVersions', versions: ['v1'], serverAddressByClientCIDRs: [] });
    if (p === '/apis') {
      return json({
        kind: 'APIGroupList', apiVersion: 'v1',
        groups: [{
          name: 'apps',
          versions: [{ groupVersion: 'apps/v1', version: 'v1' }],
          preferredVersion: { groupVersion: 'apps/v1', version: 'v1' },
        }],
      });
    }
    if (p === '/api/v1' || p === '/apis/apps/v1') {
      const gv = p === '/api/v1' ? '' : 'apps';
      const rs = RESOURCES.filter(r => r.group === gv).map(r => ({
        name: r.resource, singularName: r.kind.toLowerCase(), namespaced: r.namespaced,
        kind: r.kind, verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'],
        shortNames: r.short,
      }));
      return json({ kind: 'APIResourceList', apiVersion: 'v1', groupVersion: p === '/api/v1' ? 'v1' : 'apps/v1', resources: rs });
    }
    // kubectl apply 会先取 OpenAPI 做客户端校验：先问 /openapi/v3，
    // v3 不可用才退回 /openapi/v2（protobuf 编码）。我们只提供 v3，
    // 正式实现里这里换成内置的官方 schema。
    if (p === '/openapi/v3') {
      return json({
        paths: {
          'api/v1': { serverRelativeURL: '/openapi/v3/api/v1?hash=opslab' },
          'apis/apps/v1': { serverRelativeURL: '/openapi/v3/apis/apps/v1?hash=opslab' },
        },
      });
    }
    if (p.startsWith('/openapi/v3/')) {
      const gv = p.slice('/openapi/v3/'.length);
      const defs: Record<string, unknown> = {};
      for (const r of RESOURCES) {
        const gvPath = r.group ? `apis/${r.group}/${r.version}` : `api/${r.version}`;
        if (gvPath !== gv) continue;
        const id = r.group
          ? `io.k8s.api.${r.group.split('.')[0]}.${r.version}.${r.kind}`
          : `io.k8s.api.core.${r.version}.${r.kind}`;
        defs[id] = {
          type: 'object',
          description: r.kind,
          properties: {
            apiVersion: { type: 'string' }, kind: { type: 'string' },
            metadata: { type: 'object' }, spec: { type: 'object' }, status: { type: 'object' },
          },
          'x-kubernetes-group-version-kind': [{ group: r.group, version: r.version, kind: r.kind }],
        };
      }
      return json({ openapi: '3.0.0', info: { title: 'opslab', version: 'v1.36.0' }, paths: {}, components: { schemas: defs } });
    }
    if (p.startsWith('/openapi')) return json({ kind: 'Status', code: 404, status: 'Failure' }, 404);
    if (p === '/version') return json({ major: '1', minor: '36', gitVersion: 'v1.36.0', platform: 'opslab/wasm' });

    // /api/v1/[namespaces/<ns>/]<resource>[/<name>]  |  /apis/apps/v1/...
    const m = p.match(/^\/(api\/v1|apis\/apps\/v1)(?:\/namespaces\/([^/]+))?\/([^/]+)(?:\/([^/]+))?$/);
    if (m) {
      const g = m[1] === 'api/v1' ? '' : 'apps';
      const v = 'v1';
      const ns = m[2];
      const resource = m[3];
      const name = m[4];
      if (resource === 'namespaces' && !name && !ns && method === 'GET') {
        const list = listOf('', 'v1', 'namespaces');
        return json(wantsTable(init) ? tableFor('namespaces', list) : list);
      }
      const info = RESOURCES.find(x => x.group === g && x.resource === resource);
      if (!info) return notFound(`the server could not find the requested resource`);

      if (method === 'GET' && !name) {
        const list = listOf(g, v, resource, ns);
        return json(wantsTable(init) ? tableFor(resource, list) : list);
      }
      if (method === 'GET' && name) {
        const o = coll(g, v, resource).get(`${ns || '_'}/${name}`);
        return o ? json(o) : notFound(`${resource} "${name}" not found`);
      }
      if (method === 'POST') {
        const obj = JSON.parse(new TextDecoder().decode(init.body));
        if (!obj.metadata.namespace && ns) obj.metadata.namespace = ns;
        return json(put(g, v, resource, obj), 201);
      }
      if (method === 'PATCH' || method === 'PUT') {
        const obj = JSON.parse(new TextDecoder().decode(init.body));
        const k = `${ns || '_'}/${name}`;
        const cur = coll(g, v, resource).get(k) || {};
        const merged = { ...cur, ...obj, metadata: { ...(cur.metadata || {}), ...(obj.metadata || {}) } };
        if (!merged.metadata.namespace && ns) merged.metadata.namespace = ns;
        merged.metadata.name = name;
        return json(put(g, v, resource, merged));
      }
      if (method === 'DELETE') {
        coll(g, v, resource).delete(`${ns || '_'}/${name}`);
        return json({ kind: 'Status', apiVersion: 'v1', status: 'Success' });
      }
    }
    return notFound(`the server could not find the requested resource (${p})`);
  }

  return { handle, log, store, listOf };
}
