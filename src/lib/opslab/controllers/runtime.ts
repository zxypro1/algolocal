/**
 * 容器运行时的那些判断
 *
 * kubelet 在真正「起容器」之前要先把配置凑齐：环境变量从哪儿来、挂载的
 * ConfigMap 在不在、拉私有镜像的凭据对不对。凑不齐就是 `CreateContainerConfigError`
 * 或 `ImagePullBackOff` —— 第 4、5 关整两关就在这两个状态上。
 *
 * 起来之后还有探针和资源：探针指错端口就永远不 Ready，声明的内存超过 limit
 * 就 OOMKilled。这些都是纯函数，好单独验。
 */
import type { KubeObject } from '../apiserver';

export interface ContainerSpec {
  name: string;
  image: string;
  env?: Array<{
    name: string;
    value?: string;
    valueFrom?: {
      configMapKeyRef?: { name: string; key: string; optional?: boolean };
      secretKeyRef?: { name: string; key: string; optional?: boolean };
      fieldRef?: { fieldPath: string };
    };
  }>;
  envFrom?: Array<{
    configMapRef?: { name: string; optional?: boolean };
    secretRef?: { name: string; optional?: boolean };
    prefix?: string;
  }>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  readinessProbe?: Probe;
  livenessProbe?: Probe;
  startupProbe?: Probe;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  ports?: Array<{ containerPort: number; name?: string }>;
  securityContext?: { runAsNonRoot?: boolean; runAsUser?: number; readOnlyRootFilesystem?: boolean };
  lifecycle?: { preStop?: { exec?: { command: string[] }; httpGet?: HttpGet } };
}

export interface HttpGet {
  path?: string;
  port?: number | string;
  scheme?: string;
}

export interface Probe {
  httpGet?: HttpGet;
  tcpSocket?: { port: number | string };
  exec?: { command: string[] };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
}

/** 镜像里那个进程到底在干什么 —— 探针与 OOM 的判定都要问它 */
export interface ImageBehavior {
  /** 真正在听的端口 */
  listens?: number[];
  /** HTTP 路径 -> 状态码。没列出的路径按 404 算。 */
  routes?: Record<string, number>;
  /** 声明的内存占用，如 `220Mi`。超过 limit 就 OOMKilled。 */
  memoryUsage?: string;
  /** 收到 SIGTERM 会不会先摘流量再优雅退出 */
  handlesSigterm?: boolean;
  /** 以哪个 uid 跑（Dockerfile 里的 USER）。0 表示 root。 */
  runAsUser?: number;
}

/* ------------------------------------------------------------------ */
/* 配置解析                                                            */
/* ------------------------------------------------------------------ */

export interface ConfigLookup {
  configMap(namespace: string, name: string): KubeObject | undefined;
  secret(namespace: string, name: string): KubeObject | undefined;
}

export interface ConfigResult {
  env: Record<string, string>;
  /** 凑不齐时的报错，文本抄真 kubelet */
  error?: string;
}

/**
 * 把一个容器的环境变量凑齐。
 *
 * 引用不存在的 ConfigMap / Secret，或者 key 不存在，真 kubelet 会把 Pod 卡在
 * `CreateContainerConfigError` 并写一条 Event —— 而**不是**起来之后崩掉。
 * 这两种表现要分清楚，否则学员会去查应用日志，而问题根本不在应用里。
 */
export function resolveEnv(
  container: ContainerSpec,
  namespace: string,
  lookup: ConfigLookup
): ConfigResult {
  const env: Record<string, string> = {};

  for (const source of container.envFrom ?? []) {
    const prefix = source.prefix ?? '';
    if (source.configMapRef) {
      const found = lookup.configMap(namespace, source.configMapRef.name);
      if (!found) {
        if (source.configMapRef.optional) continue;
        return { env, error: `configmap "${source.configMapRef.name}" not found` };
      }
      for (const [key, value] of Object.entries((found.data ?? {}) as Record<string, string>)) {
        env[`${prefix}${key}`] = value;
      }
    }
    if (source.secretRef) {
      const found = lookup.secret(namespace, source.secretRef.name);
      if (!found) {
        if (source.secretRef.optional) continue;
        return { env, error: `secret "${source.secretRef.name}" not found` };
      }
      for (const [key, value] of Object.entries(secretData(found))) env[`${prefix}${key}`] = value;
    }
  }

  for (const entry of container.env ?? []) {
    if (entry.value !== undefined) { env[entry.name] = entry.value; continue; }

    const fromConfigMap = entry.valueFrom?.configMapKeyRef;
    if (fromConfigMap) {
      const found = lookup.configMap(namespace, fromConfigMap.name);
      if (!found) {
        if (fromConfigMap.optional) continue;
        return { env, error: `configmap "${fromConfigMap.name}" not found` };
      }
      const value = ((found.data ?? {}) as Record<string, string>)[fromConfigMap.key];
      if (value === undefined) {
        if (fromConfigMap.optional) continue;
        return {
          env,
          error: `couldn't find key ${fromConfigMap.key} in ConfigMap ${namespace}/${fromConfigMap.name}`,
        };
      }
      env[entry.name] = value;
      continue;
    }

    const fromSecret = entry.valueFrom?.secretKeyRef;
    if (fromSecret) {
      const found = lookup.secret(namespace, fromSecret.name);
      if (!found) {
        if (fromSecret.optional) continue;
        return { env, error: `secret "${fromSecret.name}" not found` };
      }
      const value = secretData(found)[fromSecret.key];
      if (value === undefined) {
        if (fromSecret.optional) continue;
        return {
          env,
          error: `couldn't find key ${fromSecret.key} in Secret ${namespace}/${fromSecret.name}`,
        };
      }
      env[entry.name] = value;
    }
  }

  return { env };
}

/** Secret 的值是 base64 的；`stringData` 是写入时的便利写法 */
export function secretData(secret: KubeObject): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries((secret.data ?? {}) as Record<string, string>)) {
    out[key] = decodeBase64(value);
  }
  for (const [key, value] of Object.entries((secret.stringData ?? {}) as Record<string, string>)) {
    out[key] = value;
  }
  return out;
}

/** 挂载引用的卷在不在。缺了同样是 CreateContainerConfigError。 */
export function resolveVolumes(
  pod: KubeObject,
  namespace: string,
  lookup: ConfigLookup
): { error?: string } {
  const volumes = ((pod.spec as { volumes?: Array<Record<string, any>> } | undefined)?.volumes) ?? [];
  for (const volume of volumes) {
    if (volume.configMap && !volume.configMap.optional) {
      if (!lookup.configMap(namespace, volume.configMap.name)) {
        return { error: `configmap "${volume.configMap.name}" not found` };
      }
    }
    if (volume.secret && !volume.secret.optional) {
      if (!lookup.secret(namespace, volume.secret.secretName)) {
        return { error: `secret "${volume.secret.secretName}" not found` };
      }
    }
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* 拉镜像的凭据                                                        */
/* ------------------------------------------------------------------ */

export interface RegistryAuth {
  /** 这个仓库要不要认证 */
  requiresAuth: boolean;
  /** 用户名 -> 密码 */
  users?: Record<string, string>;
}

/**
 * 能不能拉到这个镜像。
 *
 * 私有仓库 + 没有 imagePullSecret，真集群报的是 401；给了但密码不对，
 * 报的还是 401 —— 两种情况在 kubelet 这一层看不出区别，
 * 所以文本也不该有区别。
 */
export function canPullImage(input: {
  image: string;
  namespace: string;
  imagePullSecrets: Array<{ name: string }>;
  registries: Record<string, RegistryAuth>;
  lookup: ConfigLookup;
}): { allowed: boolean; message?: string } {
  const host = registryHostOf(input.image);
  const registry = input.registries[host];
  if (!registry?.requiresAuth) return { allowed: true };

  for (const reference of input.imagePullSecrets) {
    const secret = input.lookup.secret(input.namespace, reference.name);
    if (!secret) continue;
    const credentials = dockerConfigCredentials(secret)[host];
    if (!credentials) continue;
    if (registry.users?.[credentials.username] === credentials.password) return { allowed: true };
  }

  return {
    allowed: false,
    message:
      `failed to authorize: failed to fetch anonymous token: ` +
      `unexpected status from GET request to https://${host}/service/token: 401 Unauthorized`,
  };
}

/** `~/.docker/config.json` 那个结构，`kubectl create secret docker-registry` 产出的就是它 */
export function dockerConfigCredentials(
  secret: KubeObject
): Record<string, { username: string; password: string }> {
  const data = secretData(secret);
  const raw = data['.dockerconfigjson'] ?? data['.dockercfg'];
  if (!raw) return {};

  let parsed: { auths?: Record<string, { auth?: string; username?: string; password?: string }> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  const out: Record<string, { username: string; password: string }> = {};
  for (const [host, entry] of Object.entries(parsed.auths ?? {})) {
    if (entry.username && entry.password !== undefined) {
      out[normalizeHost(host)] = { username: entry.username, password: entry.password };
      continue;
    }
    if (!entry.auth) continue;
    const decoded = decodeBase64(entry.auth);
    const index = decoded.indexOf(':');
    if (index > 0) {
      out[normalizeHost(host)] = { username: decoded.slice(0, index), password: decoded.slice(index + 1) };
    }
  }
  return out;
}

/** `harbor.corp.internal/team/app:v1` -> `harbor.corp.internal` */
export function registryHostOf(image: string): string {
  const slash = image.indexOf('/');
  const head = slash < 0 ? '' : image.slice(0, slash);
  const hasRegistry = head !== '' && (head.includes('.') || head.includes(':') || head === 'localhost');
  return hasRegistry ? head : 'docker.io';
}

function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/* ------------------------------------------------------------------ */
/* 探针                                                                */
/* ------------------------------------------------------------------ */

/**
 * 探针过不过。
 *
 * 端口写错、路径写错都会让它永远失败 —— 而 Pod 是 Running 的，日志里
 * 什么也看不出来。这正是第 6 关要让学员亲自撞一次的东西。
 */
export function probeSucceeds(probe: Probe | undefined, behavior: ImageBehavior): boolean {
  if (!probe) return true;

  if (probe.httpGet) {
    const port = numericPort(probe.httpGet.port, behavior);
    if (port !== undefined && !(behavior.listens ?? [port]).includes(port)) return false;
    const path = probe.httpGet.path ?? '/';
    const status = behavior.routes?.[path] ?? (behavior.routes ? 404 : 200);
    return status >= 200 && status < 400;
  }

  if (probe.tcpSocket) {
    const port = numericPort(probe.tcpSocket.port, behavior);
    if (port === undefined) return false;
    return (behavior.listens ?? [port]).includes(port);
  }

  // exec 探针没有真进程可跑，按「镜像声明的行为」算：能听端口就算活着
  if (probe.exec) return (behavior.listens ?? []).length > 0 || !behavior.routes;

  return true;
}

/** 探针第一次判定要等多久（毫秒） */
export function probeDelayMs(probe: Probe | undefined): number {
  if (!probe) return 0;
  const initial = (probe.initialDelaySeconds ?? 0) * 1000;
  const period = (probe.periodSeconds ?? 10) * 1000;
  return initial + period;
}

/** 存活探针连续失败多少次才重启（毫秒） */
export function livenessFailureMs(probe: Probe | undefined): number {
  if (!probe) return 0;
  const period = (probe.periodSeconds ?? 10) * 1000;
  return probeDelayMs(probe) + period * ((probe.failureThreshold ?? 3) - 1);
}

function numericPort(port: number | string | undefined, behavior: ImageBehavior): number | undefined {
  if (typeof port === 'number') return port;
  if (port === undefined) return undefined;
  const parsed = Number(port);
  if (Number.isFinite(parsed)) return parsed;
  // 命名端口：镜像只声明了监听端口，取第一个
  return behavior.listens?.[0];
}

/* ------------------------------------------------------------------ */
/* 资源与 QoS                                                          */
/* ------------------------------------------------------------------ */

export type QosClass = 'Guaranteed' | 'Burstable' | 'BestEffort';

/**
 * QoS 等级。
 *
 * 规则和真集群一样：每个容器的 requests 与 limits 都写了且相等 → Guaranteed；
 * 一个都没写 → BestEffort；其余 → Burstable。节点内存紧张时按
 * BestEffort → Burstable → Guaranteed 的顺序驱逐。
 */
export function qosClassOf(containers: ContainerSpec[]): QosClass {
  let anyRequest = false;
  let allEqual = true;

  for (const container of containers) {
    const requests = container.resources?.requests ?? {};
    const limits = container.resources?.limits ?? {};
    const keys = new Set([...Object.keys(requests), ...Object.keys(limits)].filter(
      (key) => key === 'cpu' || key === 'memory'
    ));
    if (keys.size > 0) anyRequest = true;

    for (const key of ['cpu', 'memory']) {
      const request = requests[key];
      const limit = limits[key];
      if (limit === undefined) { allEqual = false; continue; }
      if (request !== undefined && parseQuantity(request) !== parseQuantity(limit)) allEqual = false;
    }
  }

  if (!anyRequest) return 'BestEffort';
  return allEqual ? 'Guaranteed' : 'Burstable';
}

/** `128Mi` / `1Gi` / `512M` / `1000000` -> 字节 */
export function parseQuantity(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const text = String(value).trim();
  const match = /^([0-9.]+)\s*([A-Za-z]*)$/.exec(text);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2];
  const factors: Record<string, number> = {
    '': 1, m: 0.001,
    k: 1e3, M: 1e6, G: 1e9, T: 1e12,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
  };
  return amount * (factors[unit] ?? 1);
}

/** 这个容器会不会被 OOMKill：声明的内存占用超过 limit 就会 */
export function exceedsMemoryLimit(container: ContainerSpec, behavior: ImageBehavior): boolean {
  const limit = container.resources?.limits?.memory;
  if (!limit || !behavior.memoryUsage) return false;
  return parseQuantity(behavior.memoryUsage) > parseQuantity(limit);
}

function decodeBase64(value: string): string {
  try {
    return atob(value);
  } catch {
    return '';
  }
}
