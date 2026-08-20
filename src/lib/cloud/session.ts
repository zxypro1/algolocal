/**
 * 登录态的本地保存
 *
 * token 存在 localStorage 而不是 cookie：桌面端从 localhost 调 Vercel 是跨站，
 * 跨站 cookie 要 SameSite=None，还要处理 CSRF；用 Authorization 头两个问题都不存在。
 *
 * 代价是 XSS 能读到 token。这个应用本来就在同一个页面里执行用户自己写的代码，
 * 但那部分跑在 Worker/沙箱里，拿不到主页面的 localStorage；题面渲染走的是
 * DOMPurify。真正的兜底是 token 有有效期，且服务端可以按 session 撤销。
 */
import type { CloudUser } from './types';

const SESSION_KEY = 'algolocal-cloud-session-v1';

export interface StoredSession {
  token: string;
  expiresAt: string;
  user: CloudUser;
}

type Listener = (session: StoredSession | null) => void;

const listeners = new Set<Listener>();

/** 同一个标签页内的内存副本，避免每次读都解析一遍 JSON */
let cached: StoredSession | null | undefined;

function readRaw(): StoredSession | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.token || !parsed?.user?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isExpired(session: StoredSession | null): boolean {
  if (!session) return true;
  const at = Date.parse(session.expiresAt);
  if (Number.isNaN(at)) return false; // 服务端没给合法时间就交给服务端去判
  return at <= Date.now();
}

export function getSession(): StoredSession | null {
  if (cached === undefined) cached = readRaw();
  if (cached && isExpired(cached)) {
    clearSession();
    return null;
  }
  return cached;
}

export function getToken(): string | null {
  return getSession()?.token ?? null;
}

export function setSession(session: StoredSession | null): void {
  cached = session;
  try {
    if (typeof window !== 'undefined') {
      if (session) window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else window.localStorage.removeItem(SESSION_KEY);
    }
  } catch {
    /* 存不下也要通知订阅者，否则界面会和内存状态不一致 */
  }
  listeners.forEach((listener) => listener(session));
}

export function clearSession(): void {
  setSession(null);
}

export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试用：把模块内的缓存清掉，让下一次读重新走 localStorage */
export function resetSessionCache(): void {
  cached = undefined;
}
