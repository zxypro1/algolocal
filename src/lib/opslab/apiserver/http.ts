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
import { ApiError, badRequest, forbidden, invalid, notFound, toStatus } from './errors';
import { renderTable, wantsTable, type TablePrinter } from './tables';
import type { KubeObject, PropagationPolicy, WatchEventOut } from './types';

export interface ApiServerDeps {
  registry: Registry;
  scheme: Scheme;
  /** 当前时间，来自虚拟时钟 —— AGE 列要用 */
  now: () => number;
  /** 集群版本，出现在 /version 与 discovery 里 */
  version?: { major: string; minor: string; gitVersion: string };
  /**
   * `kubectl exec` 真正执行命令的地方。
   *
   * apiserver 只负责协议，命令跑在哪、怎么跑，由集群那边说了算 ——
   * 和真集群把它转给 kubelet 是同一个分工。
   */
  exec?: ExecHandler;
  /**
   * 驱逐一个 Pod 之前问一句。
   *
   * 不给就是「这个集群不管 PDB」，驱逐等同于删除。
   */
  evict?(namespace: string | undefined, name: string):
    { allowed: true } | { allowed: false; message: string; pdb: string };
  /**
   * token -> 身份。不给就是「这个世界没配认证」，所有请求都是 cluster-admin。
   *
   * 真集群里这一步由 OIDC / 客户端证书 / ServiceAccount token 完成，形式不同，
   * 产物都是同一个东西：一个用户名加一组 group。
   */
  authenticate?(token: string | undefined): UserInfo | undefined;
  /** 鉴权。不给就是不鉴权。 */
  authorize?(user: UserInfo, attributes: ResourceAttributes): { allowed: boolean; reason: string };
  /**
   * CRD 自带的表格列。
   *
   * 内置类型的列写死在 tables.ts 里，CRD 的列由学员在 CRD 上声明 ——
   * `kubectl get sites` 打出来的东西是他们自己定的。
   */
  tablePrinter?(resource: string): TablePrinter | undefined;
}
import { openApiDocument, openApiRoot } from './openapi';
import type { PatchType } from './patch';
import { createExecSession, parseExecRequest, type ExecHandler } from './exec';
import type { StreamSession, UpgradeRequest } from '../net';
import { parseYaml } from '../yaml';
import {
  ANONYMOUS, CLUSTER_ADMIN, forbiddenMessage,
  type ResourceAttributes, type UserInfo,
} from '../rbac';

/**
 * HTTP 方法 -> RBAC 的 verb。
 *
 * 有两处不是一一对应：GET 不带名字是 list（带名字才是 get），
 * DELETE 不带名字是 deletecollection。规则里只写了 `get` 的人
 * 常常发现自己 list 不了。
 */
export function verbFor(method: string, parsed: ParsedPath, params: URLSearchParams): string {
  if (params.get('watch') === 'true' || params.get('watch') === '1') return 'watch';
  switch (method) {
    case 'GET': return parsed.name ? 'get' : 'list';
    case 'POST': return 'create';
    case 'PUT': return 'update';
    case 'PATCH': return 'patch';
    case 'DELETE': return parsed.name ? 'delete' : 'deletecollection';
    default: return method.toLowerCase();
  }
}

/** apply 的载荷：先按 JSON 试，不行再按 YAML */
function parseYamlBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return parseYaml(raw);
  }
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
  private readonly exec?: ExecHandler;
  private readonly authenticate?: ApiServerDeps['authenticate'];
  private readonly authorizeFn?: ApiServerDeps['authorize'];
  private readonly evict?: ApiServerDeps['evict'];
  private readonly tablePrinter?: ApiServerDeps['tablePrinter'];
  /** 收到的请求，调试与测试用 */
  readonly requestLog: string[] = [];

  constructor(deps: ApiServerDeps) {
    this.registry = deps.registry;
    this.scheme = deps.scheme;
    this.now = deps.now;
    this.version = deps.version ?? { major: '1', minor: '36', gitVersion: 'v1.36.0' };
    this.exec = deps.exec;
    this.authenticate = deps.authenticate;
    this.authorizeFn = deps.authorize;
    this.evict = deps.evict;
    this.tablePrinter = deps.tablePrinter;
  }

  /**
   * `kubectl auth can-i`。
   *
   * SelfSubjectAccessReview 问的是「**我**能不能」，SubjectAccessReview 问的是
   * 「某某能不能」（后者本身需要权限，一般只有管理员用得了）。
   * 两者的回答都写在 `status.allowed` 里，HTTP 状态码永远是 201 ——
   * 「不允许」不是一个错误，是一个答案。
   */
  private async handleAccessReview(init: RequestInit, forOther: boolean): Promise<Response> {
    const raw = await this.readBodyRaw(init);
    let body: any;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return statusResponse(badRequest('the object provided is unrecognized'));
    }
    const requester = this.identify(init);
    const spec = body.spec ?? {};
    const subject: UserInfo = forOther
      ? { username: spec.user ?? 'system:anonymous', groups: spec.groups ?? [] }
      : requester;

    const attributes: ResourceAttributes = spec.resourceAttributes
      ? {
          verb: spec.resourceAttributes.verb ?? 'get',
          group: spec.resourceAttributes.group ?? '',
          resource: spec.resourceAttributes.resource,
          subresource: spec.resourceAttributes.subresource,
          namespace: spec.resourceAttributes.namespace,
          name: spec.resourceAttributes.name,
        }
      : {
          verb: spec.nonResourceAttributes?.verb ?? 'get',
          path: spec.nonResourceAttributes?.path ?? '/',
        };

    const result = this.authorizeFn
      ? this.authorizeFn(subject, attributes)
      : { allowed: true, reason: 'no authorizer configured' };

    return json({
      kind: forOther ? 'SubjectAccessReview' : 'SelfSubjectAccessReview',
      apiVersion: 'authorization.k8s.io/v1',
      metadata: { creationTimestamp: null },
      spec,
      status: { allowed: result.allowed, reason: result.reason },
    }, 201);
  }

  /**
   * 认证。
   *
   * 从 `Authorization: Bearer <token>` 取身份。没有配认证器的世界里，
   * 每个请求都是 cluster-admin —— 前面十几关不需要为此各配一套 RBAC。
   */
  private identify(init: RequestInit): UserInfo {
    if (!this.authenticate) return CLUSTER_ADMIN;
    const header = headerOf(init, 'authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    const user = this.authenticate(token) ?? ANONYMOUS;

    /**
     * `--as` / `--as-group`：冒充。
     *
     * 这是检查别人权限的标准做法 —— 管理员不用拿到对方的凭据，就能问
     * 「他到底能不能做这件事」。真集群里冒充本身也是一种权限
     * （对 users / groups 的 impersonate），不是谁都能用。
     */
    const impersonateUser = headerOf(init, 'impersonate-user');
    if (!impersonateUser) return user;
    const allowed = this.authorizeFn?.(user, {
      verb: 'impersonate', group: '', resource: 'users', name: impersonateUser,
    });
    if (allowed && !allowed.allowed) return user;   // 没这个权限就按自己的身份来，随后会被拒
    const groups = headerOf(init, 'impersonate-group');
    return {
      username: impersonateUser,
      groups: [...(groups ? groups.split(',').map((entry) => entry.trim()) : []), 'system:authenticated'],
    };
  }

  /**
   * 鉴权。允许就返回 undefined，拒绝就返回一个 403 响应。
   *
   * 消息一字不差抄真 apiserver —— 学员会把它直接搜出去，
   * 而这句话本身把「谁、想做什么、在哪个组、哪个命名空间」说全了。
   */
  private checkAccess(user: UserInfo, attributes: ResourceAttributes): Response | undefined {
    if (!this.authorizeFn) return undefined;
    const result = this.authorizeFn(user, attributes);
    if (result.allowed) return undefined;
    return statusResponse(forbidden(forbiddenMessage(user, attributes)));
  }

  /**
   * WebSocket 升级请求。
   *
   * `kubectl exec` 走的不是 fetch 而是这条路：真 gorilla 在 wasm 里做握手，
   * 宿主这边把它接到会话上。
   */
  openStream(request: UpgradeRequest): StreamSession | { status: number; reason: string; body: string } | undefined {
    const parsed = parseExecRequest(request);
    if (!parsed) {
      return { status: 404, reason: 'Not Found', body: JSON.stringify(toStatus(notFound('pods', '', ''))) };
    }
    if (!this.exec) {
      return {
        status: 400, reason: 'Bad Request',
        body: JSON.stringify({ kind: 'Status', status: 'Failure', message: 'exec is not supported by this server' }),
      };
    }
    if (parsed.command.length === 0) {
      return {
        status: 400, reason: 'Bad Request',
        body: JSON.stringify({ kind: 'Status', status: 'Failure', message: 'you must specify at least one command for the container' }),
      };
    }
    this.requestLog.push(`WS ${request.path}`);
    return createExecSession(parsed, this.exec);
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

    // kubectl 1.27 之后 apply / create 默认要拉这个做校验，拉不到就直接失败
    if (path === '/openapi/v3') return json(openApiRoot(this.scheme.list()));
    const openApiMatch = /^\/openapi\/v3\/(?:apis\/([^/]+)\/([^/]+)|api\/([^/]+))$/.exec(path);
    if (openApiMatch) {
      const group = openApiMatch[1] ?? '';
      const version = openApiMatch[2] ?? openApiMatch[3];
      const resources = this.scheme.listGroupVersion(group, version);
      if (resources.length === 0) {
        return statusResponse(notFound('openapi', `${group}/${version}`, ''));
      }
      return json(openApiDocument(group, version, resources));
    }

    const groupVersionMatch = /^\/apis\/([^/]+)\/([^/]+)$/.exec(path);
    if (groupVersionMatch) {
      return json(this.apiResourceList(groupVersionMatch[1], groupVersionMatch[2]));
    }

    // `kubectl auth can-i` 走这条路。它问的是「我能不能」，不是「给我」。
    if (path === '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews' && method === 'POST') {
      return this.handleAccessReview(init, false);
    }
    if (path === '/apis/authorization.k8s.io/v1/subjectaccessreviews' && method === 'POST') {
      return this.handleAccessReview(init, true);
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
    const user = this.identify(init);
    const denied = this.checkAccess(user, {
      verb: verbFor(method, parsed, params),
      group: parsed.group,
      resource: parsed.resource,
      subresource: parsed.subresource,
      namespace: parsed.namespace,
      name: parsed.name,
    });
    if (denied) return denied;

    if (params.get('watch') === 'true' || params.get('watch') === '1') {
      return this.handleWatch(definition, parsed, params);
    }

    /**
     * 驱逐。
     *
     * `POST .../pods/<name>/eviction` 和 delete 是两回事：delete 谁也拦不住，
     * eviction 会先问 PDB，违反就回 429。`kubectl drain` 用的是这条路，
     * 所以它会在 PDB 不允许时停下来等，而 `kubectl delete pod` 不会。
     */
    if (parsed.subresource === 'eviction' && method === 'POST' && parsed.name) {
      const verdict = this.evict?.(parsed.namespace, parsed.name);
      if (verdict && !verdict.allowed) {
        return json({
          kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure',
          code: 429, reason: 'TooManyRequests',
          message: verdict.message,
          details: {
            causes: [{
              reason: 'DisruptionBudget',
              message: `The disruption budget ${verdict.pdb} needs 1 more healthy pod(s)`,
            }],
          },
        }, 429);
      }
      this.registry.delete(definition, parsed.namespace, parsed.name);
      return json({ kind: 'Status', apiVersion: 'v1', status: 'Success', code: 201 }, 201);
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
      case 'PATCH':
        return this.handlePatch(definition, parsed, init, params);
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
      /**
       * 子资源在 discovery 里是独立条目，形如 `pods/status`。
       *
       * `eviction` 是个例外：它的 kind 是 `Eviction`、group 是 policy、
       * 动词只有 create。kubectl drain 就是靠在 discovery 里找到它
       * 才走驱逐这条路的 —— 找不到就退回 delete，于是 PDB 形同虚设。
       */
      const subs = (definition.subresources ?? []).map((sub) => (sub === 'eviction'
        ? {
            name: `${definition.resource}/eviction`,
            singularName: '',
            namespaced: definition.namespaced,
            group: 'policy',
            version: 'v1',
            kind: 'Eviction',
            verbs: ['create'],
          }
        : {
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
    if (parsed.subresource === 'scale') {
      return json(this.registry.getScale(definition, parsed.namespace, parsed.name!));
    }
    const object = this.registry.get(definition, parsed.namespace, parsed.name!);
    if (parsed.subresource === 'status') return json(object);
    if (parsed.subresource && parsed.subresource !== 'status') {
      return statusResponse(badRequest(`the server could not find the requested resource`));
    }
    if (wantsTable(accept)) {
      return json(renderTable(
        definition.resource, [object], object.metadata.resourceVersion!, this.now(),
        this.tablePrinter?.(definition.resource)
      ));
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
      return json(renderTable(
        definition.resource, list.items, list.metadata.resourceVersion, this.now(),
        this.tablePrinter?.(definition.resource)
      ));
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
    const updated = parsed.subresource === 'scale'
      ? this.registry.setScale(definition, parsed.namespace, parsed.name, body, options)
      : parsed.subresource === 'status'
        ? this.registry.updateStatus(definition, parsed.namespace, parsed.name, body, options)
        : this.registry.update(definition, parsed.namespace, parsed.name, body, options);
    return json(updated);
  }

  /**
   * PATCH。
   *
   * `kubectl apply` 对已存在的对象走的就是这条路 —— 「改完 manifest 再 apply
   * 一次」全靠它。patch 的种类由 Content-Type 决定，缺省是策略合并。
   */
  private async handlePatch(
    definition: ResourceDefinition,
    parsed: ParsedPath,
    init: RequestInit,
    params: URLSearchParams
  ): Promise<Response> {
    if (!parsed.name) return statusResponse(badRequest('name is required for patch'));
    const contentType = (headerOf(init, 'content-type') ?? '')
      .split(';')[0]
      .trim() as PatchType;
    const patchType = (contentType || 'application/strategic-merge-patch+json') as PatchType;

    const raw = await this.readBodyRaw(init);
    let patch: unknown;
    try {
      // apply 的载荷是 YAML（JSON 也是合法 YAML，客户端多半就发 JSON）
      patch = raw
        ? (patchType === 'application/apply-patch+yaml' ? parseYamlBody(raw) : JSON.parse(raw))
        : {};
    } catch {
      return statusResponse(badRequest('the object provided is unrecognized (must be of type Patch)'));
    }

    if (patchType === 'application/apply-patch+yaml') {
      const fieldManager = params.get('fieldManager');
      if (!fieldManager) {
        return statusResponse(invalid(definition.kind, parsed.name, [{
          reason: 'FieldValueRequired',
          message: 'Required value: is required for apply patch',
          field: 'metadata.fieldManager',
        }], definition.group));
      }
      const applied = this.registry.apply(
        definition, parsed.namespace, parsed.name, patch as never,
        { fieldManager, dryRun: params.getAll('dryRun').includes('All') }
      );
      return json(applied);
    }

    const patched = this.registry.patch(definition, parsed.namespace, parsed.name, patch, patchType, {
      dryRun: params.getAll('dryRun').includes('All'),
      subresource: parsed.subresource,
    });
    return json(patched);
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
