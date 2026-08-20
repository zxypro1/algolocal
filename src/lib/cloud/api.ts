/**
 * 云端接口的类型化封装
 *
 * 页面只调这里的函数，不直接拼路径。改接口时编译器会把所有调用点指出来。
 */
import { cloudFetch } from './client';
import { cloudUrl } from './config';
import type {
  AuthResult,
  CloudHealth,
  CloudUser,
  ListingDetail,
  ListingPage,
  ListingQuery,
  PublishRequest,
} from './types';

/* ------------------------------ 健康检查 ------------------------------ */

/** 探测用的超时要短：用户在等界面出来，不是在等一个坏掉的后端 */
export function fetchHealth(signal?: AbortSignal): Promise<CloudHealth> {
  return cloudFetch<CloudHealth>('/api/cloud/health', { auth: false, timeoutMs: 5000, signal });
}

/* -------------------------------- 账号 -------------------------------- */

export function register(input: { email: string; password: string; displayName: string }): Promise<AuthResult> {
  return cloudFetch<AuthResult>('/api/cloud/auth/register', { method: 'POST', body: input, auth: false, timeoutMs: 15000 });
}

export function login(input: { email: string; password: string }): Promise<AuthResult> {
  return cloudFetch<AuthResult>('/api/cloud/auth/login', { method: 'POST', body: input, auth: false, timeoutMs: 15000 });
}

export function logout(): Promise<void> {
  return cloudFetch<void>('/api/cloud/auth/logout', { method: 'POST' });
}

export function fetchMe(signal?: AbortSignal): Promise<{ user: CloudUser }> {
  return cloudFetch<{ user: CloudUser }>('/api/cloud/auth/me', { signal });
}

export function updateProfile(input: { displayName?: string; password?: string; currentPassword?: string }): Promise<{ user: CloudUser }> {
  return cloudFetch<{ user: CloudUser }>('/api/cloud/auth/me', { method: 'PATCH', body: input, timeoutMs: 15000 });
}

/**
 * GitHub 登录全程靠浏览器跳转完成，这里只负责拼出发地址。
 *
 * 不走 cloudFetch：整个流程要经过 github.com，用 fetch 会被 CORS 挡住，
 * 而且 OAuth 本来就需要用户能看见自己在给谁授权。
 */
export function githubStartUrl(redirectUri: string): string {
  const params = new URLSearchParams({ redirect_uri: redirectUri });
  return cloudUrl(`/api/cloud/auth/github/start?${params.toString()}`);
}

/* -------------------------------- 市场 -------------------------------- */

export function fetchListings(query: ListingQuery = {}, signal?: AbortSignal): Promise<ListingPage> {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  });
  const suffix = params.toString();
  return cloudFetch<ListingPage>(`/api/cloud/market${suffix ? `?${suffix}` : ''}`, { signal, timeoutMs: 12000 });
}

export function fetchListing(slug: string, signal?: AbortSignal): Promise<ListingDetail> {
  return cloudFetch<ListingDetail>(`/api/cloud/market/${encodeURIComponent(slug)}`, { signal, timeoutMs: 20000 });
}

export function publishListing(input: PublishRequest): Promise<{ listing: ListingDetail }> {
  return cloudFetch<{ listing: ListingDetail }>('/api/cloud/market/publish', {
    method: 'POST',
    body: input,
    // 一道工程题带隐藏用例和参考实现能到几百 KB，慢网络下 8 秒不够
    timeoutMs: 45000,
  });
}

export function deleteListing(slug: string): Promise<void> {
  return cloudFetch<void>(`/api/cloud/market/${encodeURIComponent(slug)}`, { method: 'DELETE', timeoutMs: 15000 });
}

export function starListing(slug: string, starred: boolean): Promise<{ starCount: number; starred: boolean }> {
  return cloudFetch<{ starCount: number; starred: boolean }>(`/api/cloud/market/${encodeURIComponent(slug)}/star`, {
    method: starred ? 'POST' : 'DELETE',
    timeoutMs: 10000,
  });
}

/** 下载会顺带记一次计数，所以是 POST 而不是 GET */
export function downloadListing(slug: string): Promise<ListingDetail> {
  return cloudFetch<ListingDetail>(`/api/cloud/market/${encodeURIComponent(slug)}/download`, {
    method: 'POST',
    timeoutMs: 30000,
  });
}

export function fetchMyListings(signal?: AbortSignal): Promise<{ items: ListingDetail[] }> {
  return cloudFetch<{ items: ListingDetail[] }>('/api/cloud/market/mine', { signal, timeoutMs: 15000 });
}
