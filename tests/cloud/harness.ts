/**
 * 直接调用 Next API 路由的最小外壳
 *
 * 不起 HTTP 服务：路由本身就是一个 (req, res) => void 的函数，伪造这两个对象
 * 就能把整条链路（方法分发、鉴权、仓储、错误映射）真的跑一遍。起服务只会
 * 让测试变慢，并且把端口占用变成一种新的失败模式。
 */
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';

export interface CallOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  token?: string;
}

export interface CallResult<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[]>;
}

export async function call<T = any>(handler: NextApiHandler, options: CallOptions = {}): Promise<CallResult<T>> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value])),
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const req = {
    method: options.method || 'GET',
    headers,
    query: options.query || {},
    body: options.body,
    url: '/api/test',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;

  let status = 200;
  let payload: any;
  let ended = false;
  const responseHeaders: Record<string, string | string[]> = {};

  const res = {
    get writableEnded() {
      return ended;
    },
    setHeader(name: string, value: string | string[]) {
      responseHeaders[name.toLowerCase()] = value;
      return res;
    },
    getHeader(name: string) {
      return responseHeaders[name.toLowerCase()];
    },
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      ended = true;
      return res;
    },
    send(value: unknown) {
      payload = value;
      ended = true;
      return res;
    },
    end() {
      ended = true;
      return res;
    },
    redirect(code: number, location?: string) {
      // Next 的 redirect 支持 (url) 和 (status, url) 两种写法
      if (typeof code === 'string') {
        responseHeaders.location = code;
        status = 302;
      } else {
        status = code;
        if (location) responseHeaders.location = location;
      }
      ended = true;
      return res;
    },
  } as unknown as NextApiResponse;

  await handler(req, res);

  return { status, body: payload as T, headers: responseHeaders };
}

/** 云端路由需要这两个环境变量才认为自己「配好了」 */
export function useMemoryCloud(): void {
  process.env.ALGOLOCAL_CLOUD_MEMORY = '1';
  process.env.AUTH_SECRET = 'test-secret-not-used-anywhere-real';
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  delete process.env.VERCEL;
}
