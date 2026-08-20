/**
 * 云端 API 路由的公共外壳
 *
 * 每个路由只写「这次要做什么」，方法分发、CORS、错误码映射、限流都在这里。
 * 把这些散回各个 handler 的后果是：总有一个接口在数据库没配的时候
 * 返回 500 加一段堆栈，而不是 503 加一句人话。
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type { CloudErrorBody, CloudErrorCode } from '../../cloud/types';
import { AuthError } from './auth';
import { readCloudConfig } from './env';
import { assertCloudReady, CloudDisabledError, getRepositories, type Repositories } from './repo';
import { SlugTakenError } from './repo/postgres';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: CloudErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const forbidden = (message = 'You do not have access to this resource') =>
  new HttpError(403, 'forbidden', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

export interface RouteContext {
  req: NextApiRequest;
  res: NextApiResponse;
  repositories: Repositories;
}

export type Route = (ctx: RouteContext) => Promise<unknown>;

export interface HandlerOptions {
  /**
   * 这个路由需不需要数据库。健康检查是唯一一个不需要的 ——
   * 它的职责恰恰是在数据库没配的时候如实说出来。
   */
  requireCloud?: boolean;
  /** 限流：每个窗口允许的次数。不设则不限流。 */
  rateLimit?: { windowMs: number; max: number; key?: string };
}

/* ------------------------------ CORS ------------------------------ */

function allowedOrigin(req: NextApiRequest): string {
  const configured = process.env.CLOUD_ALLOWED_ORIGINS?.trim();
  const origin = req.headers.origin;

  if (!configured || configured === '*') return '*';

  const allowList = configured.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (origin && allowList.includes(origin)) return origin;
  return allowList[0] || '*';
}

function applyCors(req: NextApiRequest, res: NextApiResponse): void {
  // 认证走 Authorization 头而不是 cookie，所以这里可以放开来源而不引入 CSRF 面。
  // 一旦哪天改用 cookie，这行必须跟着改成白名单 + Allow-Credentials。
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin(req));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* ----------------------------- 限流 ------------------------------ */

interface Bucket {
  count: number;
  resetAt: number;
}

const globalBuckets = globalThis as typeof globalThis & { __algolocalRateBuckets?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (globalBuckets.__algolocalRateBuckets ||= new Map());

export function clientIp(req: NextApiRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (raw) return raw.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * 进程内的滑动窗口。Serverless 上每个实例各算各的，所以它挡不住分布式爆破 ——
 * 它挡的是「同一个人手滑连点二十次注册」和最常见的脚本重放。真正的防线是
 * scrypt 的计算成本和 Vercel 自带的平台防护。
 */
export function checkRateLimit(key: string, windowMs: number, max: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    // 顺手清掉过期的桶，否则长期运行的实例上这个 Map 只增不减
    if (buckets.size > 2000) {
      for (const [entry, value] of Array.from(buckets.entries())) {
        if (value.resetAt <= now) buckets.delete(entry);
      }
    }
    return true;
  }

  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

export function resetRateLimits(): void {
  buckets.clear();
}

/* ---------------------------- 错误映射 ---------------------------- */

export function toErrorResponse(error: unknown): { status: number; body: CloudErrorBody } {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message, details: error.details } } };
  }

  if (error instanceof CloudDisabledError) {
    return {
      status: 503,
      body: {
        error: {
          code: 'cloud_disabled',
          message: `Cloud features are not configured on this server: ${error.reason}`,
        },
      },
    };
  }

  if (error instanceof AuthError) {
    const status = error.code === 'unauthorized' ? 401 : error.code === 'forbidden' ? 403 : error.code === 'conflict' ? 409 : 400;
    return { status, body: { error: { code: error.code, message: error.message } } };
  }

  if (error instanceof SlugTakenError) {
    return {
      status: 403,
      body: { error: { code: 'forbidden', message: `"${error.slug}" is already published by another account` } },
    };
  }

  // Postgres 唯一约束。走到这里说明先查后插之间有人抢先了，是并发而不是 bug。
  if ((error as any)?.code === '23505') {
    return { status: 409, body: { error: { code: 'conflict', message: 'That record already exists' } } };
  }

  console.error('[cloud] unhandled error:', error);
  return { status: 500, body: { error: { code: 'server_error', message: 'Something went wrong on the server' } } };
}

/* ---------------------------- 装配 ---------------------------- */

export function createHandler(
  routes: Partial<Record<'GET' | 'POST' | 'PATCH' | 'DELETE', Route>>,
  options: HandlerOptions = {}
) {
  const { requireCloud = true, rateLimit } = options;

  return async function handler(req: NextApiRequest, res: NextApiResponse) {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    const route = routes[req.method as keyof typeof routes];
    if (!route) {
      res.setHeader('Allow', [...Object.keys(routes), 'OPTIONS'].join(', '));
      res.status(405).json({ error: { code: 'bad_request', message: `${req.method} is not allowed here` } });
      return;
    }

    if (rateLimit) {
      const key = `${rateLimit.key || req.url || 'route'}:${clientIp(req)}`;
      if (!checkRateLimit(key, rateLimit.windowMs, rateLimit.max)) {
        res.setHeader('Retry-After', String(Math.ceil(rateLimit.windowMs / 1000)));
        res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests, try again shortly' } });
        return;
      }
    }

    try {
      const config = readCloudConfig();
      let repositories: Repositories;

      if (requireCloud) {
        assertCloudReady(config);
        repositories = getRepositories(config);
      } else {
        // 健康检查也想尽量报告真实状态，但拿不到仓储不算错误
        repositories = safeRepositories();
      }

      const result = await route({ req, res, repositories });

      if (res.writableEnded) return;
      if (result === undefined) {
        res.status(204).end();
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      if (res.writableEnded) return;
      const { status, body } = toErrorResponse(error);
      res.status(status).json(body);
    }
  };
}

function safeRepositories(): Repositories {
  try {
    return getRepositories();
  } catch {
    return null as unknown as Repositories;
  }
}

/* ---------------------------- 入参工具 ---------------------------- */

export function queryString(req: NextApiRequest, key: string): string | undefined {
  const value = req.query[key];
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || undefined;
}

export function queryInt(req: NextApiRequest, key: string, fallback: number, min: number, max: number): number {
  const raw = queryString(req, key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function requireBody<T>(req: NextApiRequest): T {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Expected a JSON object body');
  }
  return body as T;
}
