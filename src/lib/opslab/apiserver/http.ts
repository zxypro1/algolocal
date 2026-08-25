/**
 * apiserver 的 HTTP 面
 *
 * 把 URL 与 Accept 头翻译成 registry 上的调用，再把结果按 kubectl 期望的形状发回去。
 * 真 kubectl（编译成 wasm 的那个）通过被拦截的 fetch 打到这里，
 * 所以这一层的路由形状、discovery 内容、错误码都要和真集群对得上。
 *
 * discovery 是 kubectl 启动时干的第一件事：先问 /api 和 /apis 有哪些组，
 * 再问每个 groupVersion 有哪些资源 —— `po` 能解析成 `pods`、
 * `kubectl api-resources` 能列出东西，都靠它。
 */
import { Registry } from './registry';
import { Scheme, ResourceDefinition } from './scheme';
import { ApiError, badRequest, notFound, toStatus } from './errors';
import { renderTable, wantsTable } from './tables';
import type { KubeObject, PropagationPolicy, WatchEventOut } from './types';

export interface ApiServerDeps {
  registry: Registry;
  scheme: Scheme;
  /** 当前时间，来自虚拟时钟 —— AGE 列要用 */
  now: () => number;
  /** 集群版本，出现在 /version 与 discovery 里 */
  version?: { major: string; minor: string; gitVersion: string };
}

interface ParsedPath {
  group: string;
  version: string;
  namespace?: string;
  resource: string;
  name?: string;
  subresource?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * 从 fetch 的 init 里取一个请求头。
 *
 * headers 的形态不定：Headers 实例、普通对象、二元组数组都可能 ——
 * Go 的 wasm 传过来的是普通对象，浏览器 fetch 里常见的是 Headers。
 * 头名大小写不敏感。
 */
function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as any;
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([key]: [string, string]) => String(key).toLowerCase() === wanted);
    return found?.[1];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value);
  }
  return undefined;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function statusResponse(error: unknown): Response {
  const status = toStatus(error);
  return json(status, status.code);
}

/**
 * 拆 REST 路径。
 *
 * 形状：
 *   /api/v1/pods
 *   /api/v1/namespaces/default/pods
 *   /api/v1/namespaces/default/pods/web
 *   /api/v1/namespaces/default/pods/web/status
 *   /apis/apps/v1/namespaces/default/deployments/web/scale
 *
 * 注意 `namespaces` 本身是个资源，`/api/v1/namespaces/default` 是「取名叫 default
 * 的 namespace 对象」，不是「default 命名空间下的什么」——这是 k8s 路由里
 * 最容易写错的一处。
 */
export function parsePath(pathname: string): ParsedPath | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  let index = 0;
  let group = '';
  let version = '';

  if (parts[0] === 'api') {
    version = parts[1];
    index = 2;
  } else if (parts[0] === 'apis') {
    if (parts.length < 3) return null;
    group = parts[1];
    version = parts[2];
    index = 3;
  } else {
    return null;
  }
  if (!version) return null;

  let namespace: string | undefined;
  // `/api/v1/namespaces/default/pods` 里的 namespaces 是路径前缀；
  // `/api/v1/namespaces/default` 里的 namespaces 是资源本身。
  if (parts[index] === 'namespaces' && parts.length > index + 2) {
    namespace = parts[index + 1];
    index += 2;
  }

  const resource = parts[index];
  if (!resource) return null;
  return {
    group,
    version,
    namespace,
    resource,
    name: parts[index + 1],
    subresource: parts[index + 2],
  };
}

export class ApiServer {
  private readonly registry: Registry;
  private readonly scheme: Scheme;
  private readonly now: () => number;
  private readonly version: { major: string; minor: string; gitVersion: string };
  /** 收到的请求，调试与测试用 */
  readonly requestLog: string[] = [];

  constructor(deps: ApiServerDeps) {
    this.registry = deps.registry;
    this.scheme = deps.scheme;
    this.now = deps.now;
    this.version = deps.version ?? { major: '1', minor: '36', gitVersion: 'v1.36.0' };
  }

  /** fetch 兼容的入口 —— 真 kubectl 就是通过它打进来的 */
  async handle(url: string, init: RequestInit = {}): Promise<Response> {
    const parsed = new URL(url, 'https://apiserver.opslab');
    const method = (init.method ?? 'GET').toUpperCase();
    this.requestLog.push(`${method} ${parsed.pathname}${parsed.search}`);

    try {
      return await this.route(parsed, method, init, headerOf(init, 'accept'));
    } catch (error) {
      return statusResponse(error);
    }
  }

  private async route(
    url: URL,
    method: string,
    init: RequestInit,
    accept: string | undefined
  ): Promise<Response> {
    const path = url.pathname;

    if (path === '/version') {
      return json({ ...this.version, platform: 'opslab/wasm', compiler: 'gc', goVersion: 'go1.27.0' });
    }
    if (path === '/api') {
      return json({ kind: 'APIVersions', versions: ['v1'], serverAddressByClientCIDRs: [] });
    }
    if (path === '/apis') return json(this.apiGroupList());
    if (path === '/api/v1') return json(this.apiResourceList('', 'v1'));

    const groupVersionMatch = /^\/apis\/([^/]+)\/([^/]+)$/.exec(path);
    if (groupVersionMatch) {
      return json(this.apiResourceList(groupVersionMatch[1], groupVersionMatch[2]));
    }

    const parsed = parsePath(path);
    if (!parsed) {
      return statusResponse(badRequest(`the server could not find the requested resource (${path})`));
    }

    const definition = this.scheme.get({
      group: parsed.group,
      version: parsed.version,
      resource: parsed.resource,
    });
    if (!definition) {
      return statusResponse(
        notFound('resources', parsed.resource, parsed.group)
      );
    }

    const params = url.searchParams;
    if (params.get('watch') === 'true' || params.get('watch') === '1') {
      return this.handleWatch(definition, parsed, params);
    }

    switch (method) {
      case 'GET':
        return parsed.name
          ? this.handleGetOne(definition, parsed, accept)
          : this.handleList(definition, parsed, params, accept);
      case 'POST':
        return this.handleCreate(definition, parsed, init, params);
      case 'PUT':
        return this.handleUpdate(definition, parsed, init, params);
      case 'DELETE':
        return this.handleDelete(definition, parsed, init, params);
      default:
        return statusResponse(badRequest(`method ${method} is not supported`));
    }
  }

  /* ---------------- discovery ---------------- */

  private apiGroupList() {
    const groups = new Map<string, string[]>();
    for (const definition of this.scheme.list()) {
      if (!definition.group) continue;
      const versions = groups.get(definition.group) ?? [];
      if (!versions.includes(definition.version)) versions.push(definition.version);
      groups.set(definition.group, versions);
    }
    return {
      kind: 'APIGroupList',
      apiVersion: 'v1',
      groups: [...groups.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, versions]) => ({
          name,
          versions: versions.sort().map((version) => ({ groupVersion: `${name}/${version}`, version })),
          preferredVersion: { groupVersion: `${name}/${versions[0]}`, version: versions[0] },
        })),
    };
  }

  private apiResourceList(group: string, version: string) {
    const resources = this.scheme.listGroupVersion(group, version);
    const entries = resources.flatMap((definition) => {
      const base = {
        name: definition.resource,
        singularName: definition.singular,
        namespaced: definition.namespaced,
        kind: definition.kind,
        verbs: definition.verbs ?? [],
        ...(definition.shortNames?.length ? { shortNames: definition.shortNames } : {}),
        ...(definition.categories?.length ? { categories: definition.categories } : {}),
      };
      // 子资源在 discovery 里是独立条目，形如 `pods/status`
      const subs = (definition.subresources ?? []).map((sub) => ({
        name: `${definition.resource}/${sub}`,
        singularName: '',
        namespaced: definition.namespaced,
        kind: definition.kind,
        verbs: ['get', 'patch', 'update'],
      }));
      return [base, ...subs];
    });
    return {
      kind: 'APIResourceList',
      apiVersion: 'v1',
      groupVersion: Scheme.toApiVersion(group, version),
      resources: entries,
    };
  }

  /* ---------------- 资源读写 ---------------- */

  private handleGetOne(
    definition: ResourceDefinition,
    parsed: ParsedPath,
    accept: string | undefined
  ): Response {
    const object = this.registry.get(definition, parsed.namespace, parsed.name!);
    if (parsed.subresource === 'status') return json(object);
    if (parsed.subresource && parsed.subresource !== 'status') {
      return statusResponse(badRequest(`the server could not find the requested resource`));
    }
    if (wantsTable(accept)) {
      return json(renderTable(definition.resource, [object], object.metadata.resourceVersion!, this.now()));
    }
    return json(object);
  }

  private handleList(
    definition: ResourceDefinition,
    parsed: ParsedPath,
    params: URLSearchParams,
    accept: string | undefined
  ): Response {
    const list = this.registry.list(definition, {
      namespace: parsed.namespace,
      labelSelector: params.get('labelSelector') ?? undefined,
      fieldSelector: params.get('fieldSelector') ?? undefined,
      limit: params.get('limit') ? Number(params.get('limit')) : undefined,
      continue: params.get('continue') ?? undefined,
      resourceVersion: params.get('resourceVersion') ?? undefined,
    });

    if (wantsTable(accept)) {
      return json(renderTable(definition.resource, list.items, list.metadata.resourceVersion, this.now()));
    }
    return json(list);
  }

  private async handleCreate(
    definition: ResourceDefinition,
    parsed: ParsedPath,
    init: RequestInit,
    params: URLSearchParams
  ): Promise<Response> {
    const body = await this.readBody(init);
    const created = this.registry.create(definition, parsed.namespace, body, {
      dryRun: params.getAll('dryRun').includes('All'),
    });
    return json(created, 201);
  }

  private async handleUpdate(
    definition: ResourceDefinition,
    parsed: ParsedPath,
    init: RequestInit,
    params: URLSearchParams
  ): Promise<Response> {
    if (!parsed.name) return statusResponse(badRequest('name is required for update'));
    const body = await this.readBody(init);
    const options = { dryRun: params.getAll('dryRun').includes('All') };
    const updated = parsed.subresource === 'status'
      ? this.registry.updateStatus(definition, parsed.namespace, parsed.name, body, options)
      : this.registry.update(definition, parsed.namespace, parsed.name, body, options);
    return json(updated);
  }

  private async handleDelete(
    definition: ResourceDefinition,
    parsed: ParsedPath,
    init: RequestInit,
    params: URLSearchParams
  ): Promise<Response> {
    // 删除的选项既可能在查询串上，也可能在请求体里（kubectl 两种都用）
    let bodyOptions: any = {};
    try {
      const raw = await this.readBodyRaw(init);
      if (raw) bodyOptions = JSON.parse(raw);
    } catch {
      bodyOptions = {};
    }
    const propagationPolicy =
      (params.get('propagationPolicy') as PropagationPolicy | null) ??
      (bodyOptions.propagationPolicy as PropagationPolicy | undefined);

    if (!parsed.name) {
      const deleted = this.registry.deleteCollection(definition, {
        namespace: parsed.namespace,
        labelSelector: params.get('labelSelector') ?? undefined,
      });
      return json({
        apiVersion: Scheme.toApiVersion(definition.group, definition.version),
        kind: `${definition.kind}List`,
        metadata: {},
        items: deleted,
      });
    }

    const deleted = this.registry.delete(definition, parsed.namespace, parsed.name, {
      propagationPolicy,
      preconditions: bodyOptions.preconditions,
      gracePeriodSeconds: bodyOptions.gracePeriodSeconds,
    });
    return json(deleted);
  }

  /**
   * watch 是一条 chunked 流，每行一个 JSON 事件。
   *
   * kubectl `get -w` / informer 都靠它。流不会自己结束 ——
   * 调用方取消（AbortSignal）或订阅被 cancel 才停。
   */
  private handleWatch(
    definition: ResourceDefinition,
    parsed: ParsedPath,
    params: URLSearchParams
  ): Response {
    const encoder = new TextEncoder();
    let cancel: (() => void) | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const emit = (event: WatchEventOut) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            // 流已经关了，取消订阅免得继续往里写
            cancel?.();
          }
        };
        const watcher = this.registry.watch(
          definition,
          {
            namespace: parsed.namespace,
            resourceVersion: params.get('resourceVersion') ?? undefined,
            labelSelector: params.get('labelSelector') ?? undefined,
          },
          emit
        );
        cancel = watcher.cancel;
      },
      cancel: () => cancel?.(),
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    });
  }

  /* ---------------- 杂项 ---------------- */

  private async readBodyRaw(init: RequestInit): Promise<string> {
    const body = init.body as any;
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (body instanceof Uint8Array) return new TextDecoder().decode(body);
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
    if (typeof body.text === 'function') return body.text();
    return String(body);
  }

  private async readBody(init: RequestInit): Promise<KubeObject> {
    const raw = await this.readBodyRaw(init);
    if (!raw) throw badRequest('request body is required');
    try {
      return JSON.parse(raw) as KubeObject;
    } catch {
      throw badRequest('the request body is not valid JSON');
    }
  }
}

export function createApiServer(deps: ApiServerDeps): ApiServer {
  return new ApiServer(deps);
}
