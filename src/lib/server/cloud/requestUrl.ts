/**
 * 从请求里还原自己的外部地址
 *
 * OAuth 的 redirect_uri 必须和 GitHub 应用里登记的完全一致，所以不能写死 ——
 * 预览部署、自建域名、本地开发的 host 都不一样。Vercel 会把原始 host 放在
 * x-forwarded-* 里，直接用 req.headers.host 在多数情况下也对，但协议要看
 * x-forwarded-proto，否则预览环境会拼出一个 http:// 的回调地址。
 */
import type { NextApiRequest } from 'next';

function header(req: NextApiRequest, name: string): string | undefined {
  const value = req.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ? raw.split(',')[0].trim() : undefined;
}

export function externalOrigin(req: NextApiRequest): string {
  const explicit = process.env.CLOUD_PUBLIC_ORIGIN?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const host = header(req, 'x-forwarded-host') || req.headers.host || 'localhost:3000';
  const protocol = header(req, 'x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');

  return `${protocol}://${host}`;
}

export function callbackUrlFor(req: NextApiRequest): string {
  return `${externalOrigin(req)}/api/cloud/auth/github/callback`;
}
