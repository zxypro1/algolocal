/**
 * GitHub OAuth
 *
 * 流程走的是「浏览器跳转 + 片段回传 token」：
 *   应用页 → /start（签一个 state） → GitHub → /callback（换 token、建会话）
 *   → 回到应用页，token 挂在 URL fragment 上。
 *
 * 选 fragment 而不是 query 是因为 fragment 不会被发到任何服务器，也不会进
 * 访问日志和 Referer。页面拿到之后立刻用 replaceState 抹掉。
 *
 * 桌面端和网页版走的是同一条路径：桌面端本身就是一个 Chromium 窗口，
 * 回跳到 http://localhost:3000/account 落在它自己的服务上。
 */
import { badRequest, forbidden } from './http';
import { readCloudConfig } from './env';

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';
const GITHUB_EMAILS = 'https://api.github.com/user/emails';

export interface GithubIdentity {
  githubId: string;
  login: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

/**
 * 回跳地址必须校验，否则这就是一个开放重定向 —— 攻击者构造一个指向自己域名的
 * redirect_uri，用户点一下就把 token 送过去了。
 */
export function assertAllowedRedirect(redirectUri: string, requestHost?: string): URL {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw badRequest('redirect_uri must be an absolute URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('redirect_uri must be http or https');
  }

  const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (isLoopback) return url; // 桌面端与本地开发

  if (requestHost && url.host === requestHost) return url; // 网页版自己

  const allowList = (process.env.CLOUD_ALLOWED_REDIRECTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowList.some((entry) => url.origin === entry || url.host === entry)) return url;

  throw forbidden(`redirect_uri "${url.origin}" is not allowed`);
}

export function authorizeUrl(state: string, callbackUrl: string): string {
  const config = readCloudConfig();
  if (!config.github) throw badRequest('GitHub sign-in is not configured on this server');

  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: callbackUrl,
    scope: 'read:user user:email',
    state,
    allow_signup: 'true',
  });
  return `${GITHUB_AUTHORIZE}?${params.toString()}`;
}

async function githubJson(url: string, init: RequestInit, timeoutMs = 10000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'AlgoLocal', ...(init.headers || {}) },
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw badRequest(`GitHub returned ${response.status}: ${parsed?.message || response.statusText}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function exchangeCode(code: string, callbackUrl: string): Promise<string> {
  const config = readCloudConfig();
  if (!config.github) throw badRequest('GitHub sign-in is not configured on this server');

  const payload = await githubJson(GITHUB_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
      redirect_uri: callbackUrl,
    }),
  });

  // GitHub 换 token 失败时照样返回 200，错误写在 body 里
  if (payload?.error) throw badRequest(`GitHub rejected the code: ${payload.error_description || payload.error}`);
  if (!payload?.access_token) throw badRequest('GitHub did not return an access token');

  return payload.access_token as string;
}

export async function fetchIdentity(accessToken: string): Promise<GithubIdentity> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const profile = await githubJson(GITHUB_USER, { headers });

  let email: string | null = profile?.email || null;
  if (!email) {
    // 用户把邮箱设为私密时 /user 不带 email，得单独问一次
    try {
      const emails = await githubJson(GITHUB_EMAILS, { headers });
      const primary = Array.isArray(emails)
        ? emails.find((entry: any) => entry?.primary && entry?.verified) || emails.find((entry: any) => entry?.verified)
        : null;
      email = primary?.email || null;
    } catch {
      email = null;
    }
  }

  return {
    githubId: String(profile.id),
    login: String(profile.login || ''),
    displayName: String(profile.name || profile.login || 'GitHub user'),
    email,
    avatarUrl: profile.avatar_url || null,
  };
}

/**
 * GitHub 账号没有公开邮箱时给一个占位地址。
 *
 * 用 @users.noreply.github.com 是因为它是 GitHub 官方的不可投递域名，
 * 不会误伤任何真实邮箱，也符合用户「不想暴露邮箱」的本意。
 */
export function fallbackEmail(identity: GithubIdentity): string {
  return identity.email || `${identity.githubId}+${identity.login || 'user'}@users.noreply.github.com`;
}
