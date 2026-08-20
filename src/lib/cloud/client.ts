/**
 * 云端请求的唯一出口
 *
 * 所有云端调用都必须走这里，原因是离线保证只在这一处实现：超时、
 * navigator.onLine 快速失败、401 自动登出、错误码归一化。散在各个页面里写
 * fetch 的话，总有一个地方会忘记设超时，然后在没网的环境里转圈转到天荒地老。
 */
import { cloudUrl, isCloudEnabled } from './config';
import { clearSession, getToken } from './session';
import type { CloudErrorCode } from './types';

export class CloudError extends Error {
  readonly code: CloudErrorCode | 'offline' | 'timeout' | 'disabled';
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: CloudError['code'],
    message: string,
    status = 0,
    details?: unknown
  ) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** 界面据此决定是显示「离线」还是显示一条真正的错误 */
  get isOffline(): boolean {
    return this.code === 'offline' || this.code === 'timeout' || this.code === 'disabled';
  }
}

export interface CloudFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  /** 毫秒，默认 8 秒。发布题目这种大 payload 的调用可以放宽。 */
  timeoutMs?: number;
  /** 带上 Authorization 头，默认带（有 token 才带） */
  auth?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 浏览器说自己离线时直接失败，不发请求。
 *
 * navigator.onLine 只能证否不能证有（连着的路由器不代表连着互联网），
 * 所以只用它做快速失败，不用它判断「在线」。
 */
function looksOffline(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.onLine === false;
}

function joinSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cancel: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort);
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancel: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
  };
}

export async function cloudFetch<T>(path: string, options: CloudFetchOptions = {}): Promise<T> {
  if (!isCloudEnabled()) {
    throw new CloudError('disabled', 'Cloud features are turned off');
  }
  if (looksOffline()) {
    throw new CloudError('offline', 'The device is offline');
  }

  const { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS, auth = true, signal } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const guard = joinSignals(timeoutMs, signal);

  let response: Response;
  try {
    response = await fetch(cloudUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: guard.signal,
      // 用 Authorization 头而不是 cookie，这里显式关掉凭据，免得触发多余的预检
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    if (guard.timedOut()) {
      throw new CloudError('timeout', `Request to ${path} timed out after ${timeoutMs}ms`);
    }
    if (signal?.aborted) throw error;
    throw new CloudError('offline', (error as Error)?.message || 'Network request failed');
  } finally {
    guard.cancel();
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const code: CloudErrorCode = parsed?.error?.code || mapStatus(response.status);
    const message: string = parsed?.error?.message || `${response.status} ${response.statusText}`;

    // token 过期或被撤销：本地登录态已经没有意义了，留着只会让每个请求都失败一次
    if (response.status === 401) clearSession();

    throw new CloudError(code, message, response.status, parsed?.error?.details);
  }

  return parsed as T;
}

function mapStatus(status: number): CloudErrorCode {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'cloud_disabled';
  return 'server_error';
}
