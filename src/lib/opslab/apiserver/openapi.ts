/**
 * OpenAPI v3
 *
 * 不是可选项：kubectl 1.27 之后 `apply` / `create` 默认要做校验，第一件事就是
 * 去 `/openapi/v3` 拉 schema。拉不到就直接失败，报
 * 「failed to download openapi」—— 也就是说不提供它，`kubectl apply` 根本用不了。
 *
 * 这里从 scheme 生成文档。默认给的是**宽松** schema（`x-kubernetes-preserve-unknown-fields`），
 * 字段级的对错交给服务端的 fieldValidation 去判 —— 那也是真集群 1.27 之后
 * 实际把关的地方。需要更严的关卡，可以在 ResourceDefinition 上挂自己的 schema。
 */
import { ResourceDefinition } from './scheme';

export interface OpenApiSchema {
  [key: string]: unknown;
}

/** `/openapi/v3` 的根文档：告诉客户端每个 group-version 的文档在哪 */
export function openApiRoot(definitions: ResourceDefinition[]): unknown {
  const paths: Record<string, { serverRelativeURL: string }> = {};
  for (const groupVersion of groupVersions(definitions)) {
    const segment = groupVersion.group
      ? `apis/${groupVersion.group}/${groupVersion.version}`
      : `api/${groupVersion.version}`;
    paths[segment] = {
      // hash 用来做客户端缓存。内容不变它就不变，所以直接拿资源清单算。
      serverRelativeURL: `/openapi/v3/${segment}?hash=${hashOf(groupVersion.resources)}`,
    };
  }
  return { paths };
}

/** 某个 group-version 的 OpenAPI 文档 */
export function openApiDocument(
  group: string,
  version: string,
  definitions: ResourceDefinition[]
): unknown {
  const schemas: Record<string, unknown> = {};
  for (const definition of definitions) {
    schemas[schemaName(definition)] = definition.schema ?? permissiveSchema(definition);
    schemas[`${schemaName(definition)}List`] = listSchema(definition);
  }
  const paths: Record<string, unknown> = {};
  for (const definition of definitions) Object.assign(paths, pathsFor(definition));

  return {
    openapi: '3.0.0',
    info: { title: 'Kubernetes', version: 'unversioned' },
    paths,
    components: { schemas },
  };
}

/**
 * 每个资源的 REST 路径。
 *
 * 光有 components.schemas 不够：kubectl 在 apply 之前还要确认「这个 GVK 的
 * PATCH 接口支不支持 fieldValidation 参数」，它是**在 paths 里翻 PATCH 操作**
 * 找的（见 cli-runtime 的 queryParamVerifierV3）。paths 空着的话它会退回去拉
 * OpenAPI v2 —— 那玩意儿是 protobuf 编码的，我们给不了，于是整条 apply 就废了。
 */
function pathsFor(definition: ResourceDefinition): Record<string, unknown> {
  const prefix = definition.group
    ? `/apis/${definition.group}/${definition.version}`
    : `/api/${definition.version}`;
  const collection = definition.namespaced
    ? `${prefix}/namespaces/{namespace}/${definition.resource}`
    : `${prefix}/${definition.resource}`;
  const item = `${collection}/{name}`;
  const gvk = { group: definition.group, version: definition.version, kind: definition.kind };

  const operation = (verb: string, parameters: unknown[]) => ({
    tags: [`${definition.group || 'core'}_${definition.version}`],
    operationId: `${verb}${definition.group ? capitalize(definition.group.split('.')[0]) : ''}${capitalize(definition.version)}${definition.kind}`,
    'x-kubernetes-group-version-kind': gvk,
    'x-kubernetes-action': verb,
    parameters,
    responses: { 200: { description: 'OK' } },
  });

  return {
    [collection]: {
      get: operation('list', [QUERY.limit, QUERY.continueToken, QUERY.labelSelector, QUERY.fieldSelector, QUERY.watch]),
      post: operation('post', [QUERY.dryRun, QUERY.fieldManager, QUERY.fieldValidation]),
      parameters: definition.namespaced ? [PATH.namespace] : [],
    },
    [item]: {
      get: operation('get', []),
      put: operation('put', [QUERY.dryRun, QUERY.fieldManager, QUERY.fieldValidation]),
      patch: operation('patch', [QUERY.dryRun, QUERY.fieldManager, QUERY.fieldValidation, QUERY.force]),
      delete: operation('delete', [QUERY.dryRun, QUERY.gracePeriod, QUERY.propagationPolicy]),
      parameters: definition.namespaced ? [PATH.namespace, PATH.name] : [PATH.name],
    },
  };
}

const QUERY = {
  dryRun: { name: 'dryRun', in: 'query', schema: { type: 'string' }, uniqueItems: true },
  fieldManager: { name: 'fieldManager', in: 'query', schema: { type: 'string' }, uniqueItems: true },
  fieldValidation: { name: 'fieldValidation', in: 'query', schema: { type: 'string' }, uniqueItems: true },
  force: { name: 'force', in: 'query', schema: { type: 'boolean' }, uniqueItems: true },
  limit: { name: 'limit', in: 'query', schema: { type: 'integer' }, uniqueItems: true },
  continueToken: { name: 'continue', in: 'query', schema: { type: 'string' }, uniqueItems: true },
  labelSelector: { name: 'labelSelector', in: 'query', schema: { type: 'string' }, uniqueItems: true },
  fieldSelector: { name: 'fieldSelector', in: 'query', schema: { type: 'string' }, uniqueItems: true },
  watch: { name: 'watch', in: 'query', schema: { type: 'boolean' }, uniqueItems: true },
  gracePeriod: { name: 'gracePeriodSeconds', in: 'query', schema: { type: 'integer' }, uniqueItems: true },
  propagationPolicy: { name: 'propagationPolicy', in: 'query', schema: { type: 'string' }, uniqueItems: true },
};

const PATH = {
  namespace: { name: 'namespace', in: 'path', required: true, schema: { type: 'string' }, uniqueItems: true },
  name: { name: 'name', in: 'path', required: true, schema: { type: 'string' }, uniqueItems: true },
};

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * `io.k8s.api.apps.v1.Deployment` —— 真集群里的命名，学员 grep 得到。
 *
 * 内置组的规则是「去掉 `.k8s.io`，取第一段，前面加 `io.k8s.api.`」：
 * `rbac.authorization.k8s.io` → `io.k8s.api.rbac`，核心组（空串）→ `io.k8s.api.core`。
 * 自定义组（CRD）没有这个规则，按反向域名拼。
 */
export function schemaName(definition: ResourceDefinition): string {
  const group = definition.group;
  const prefix = !group
    ? 'io.k8s.api.core'
    : group.endsWith('.k8s.io')
      ? `io.k8s.api.${group.slice(0, -'.k8s.io'.length).split('.')[0]}`
      : group.includes('.')
        ? group.split('.').reverse().join('.')
        : `io.k8s.api.${group}`;
  return `${prefix}.${definition.version}.${definition.kind}`;
}

/**
 * 宽松 schema。
 *
 * 结构该有的都有（apiVersion / kind / metadata / spec / status），但不限制
 * 具体字段 —— 校验交给服务端。GVK 扩展一定要带，客户端是靠它把 YAML 里的
 * `apiVersion + kind` 对应到 schema 上的。
 */
function permissiveSchema(definition: ResourceDefinition): OpenApiSchema {
  return {
    type: 'object',
    description: `${definition.kind} in ${definition.group || 'core'}/${definition.version}`,
    'x-kubernetes-group-version-kind': [
      { group: definition.group, version: definition.version, kind: definition.kind },
    ],
    'x-kubernetes-preserve-unknown-fields': true,
    properties: {
      apiVersion: { type: 'string' },
      kind: { type: 'string' },
      metadata: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
      spec: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
      status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
    },
  };
}

function listSchema(definition: ResourceDefinition): OpenApiSchema {
  return {
    type: 'object',
    'x-kubernetes-group-version-kind': [
      { group: definition.group, version: definition.version, kind: `${definition.kind}List` },
    ],
    properties: {
      apiVersion: { type: 'string' },
      kind: { type: 'string' },
      metadata: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
      items: { type: 'array', items: { $ref: `#/components/schemas/${schemaName(definition)}` } },
    },
    required: ['items'],
  };
}

interface GroupVersion {
  group: string;
  version: string;
  resources: ResourceDefinition[];
}

function groupVersions(definitions: ResourceDefinition[]): GroupVersion[] {
  const map = new Map<string, GroupVersion>();
  for (const definition of definitions) {
    const key = `${definition.group}/${definition.version}`;
    const entry = map.get(key) ?? { group: definition.group, version: definition.version, resources: [] };
    entry.resources.push(definition);
    map.set(key, entry);
  }
  // 顺序稳定：核心组在前，其余按组名
  return [...map.values()].sort((a, b) =>
    a.group === b.group ? (a.version < b.version ? -1 : 1) : a.group === '' ? -1 : b.group === '' ? 1 : a.group < b.group ? -1 : 1
  );
}

/** 内容指纹。变了客户端就会重新拉，不变就用缓存。 */
function hashOf(definitions: ResourceDefinition[]): string {
  // 自定义 schema 也要算进去，否则改了 schema 客户端还在用缓存里的旧文档
  const source = definitions
    .map((definition) => `${definition.resource}:${definition.kind}:${JSON.stringify(definition.schema ?? null)}`)
    .sort()
    .join(',');
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
