/**
 * 云端地址与开关
 *
 * 桌面端跑在 http://localhost:3000，云端 API 在 Vercel 上，是两个不同的源；
 * 网页版则是同一个源。这里统一解析成一个 base，调用方不必关心自己在哪。
 *
 * 默认值可以被覆盖，覆盖顺序是：构建期环境变量 > 用户在设置里填的地址 > 内置默认值。
 * 自建后端的人改设置就行，不需要重新编译。
 */

/** 官方部署地址。改这里等于改所有客户端的默认指向。 */
export const DEFAULT_CLOUD_BASE = 'https://algolocal.vercel.app';

const BASE_STORAGE_KEY = 'algolocal-cloud-base-v1';
const ENABLED_STORAGE_KEY = 'algolocal-cloud-enabled-v1';

function readLocalStorage(key: string): string | null {
  // 隐私模式下 localStorage 会直接抛，云端是可选功能，不值得为它崩一个页面
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* 存不进去就算了，本次会话内的内存状态仍然是对的 */
  }
}

function normalizeBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

/**
 * 页面本身就是从云端部署上打开的（网页版），这时用同源相对路径。
 *
 * 判据是「不是本地地址」而不是「等于官方域名」：自建部署的人换了域名，
 * 同源判断也应该继续成立。
 */
function isServedFromCloud(): boolean {
  if (typeof window === 'undefined') return false;
  const { hostname, protocol } = window.location;
  if (protocol === 'file:') return false;
  return !(hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1');
}

export function getCloudBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_CLOUD_API_BASE;
  if (fromEnv) return normalizeBase(fromEnv);

  const fromUser = readLocalStorage(BASE_STORAGE_KEY);
  if (fromUser) return normalizeBase(fromUser);

  if (isServedFromCloud()) return '';

  return DEFAULT_CLOUD_BASE;
}

export function setCloudBase(base: string | null): void {
  writeLocalStorage(BASE_STORAGE_KEY, base ? normalizeBase(base) : null);
}

/** 用户填过的自定义地址，没填返回 null（不返回默认值，设置页要区分这两者） */
export function getCustomCloudBase(): string | null {
  return readLocalStorage(BASE_STORAGE_KEY);
}

/**
 * 云端功能总开关，默认开。
 *
 * 关掉之后客户端一个请求都不会发，市场和账号入口整体隐藏。这是给
 * 完全不联网的使用场景准备的：与其让它们不停地探测失败，不如彻底藏起来。
 */
export function isCloudEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_CLOUD_DISABLED === '1') return false;
  return readLocalStorage(ENABLED_STORAGE_KEY) !== 'off';
}

export function setCloudEnabled(enabled: boolean): void {
  writeLocalStorage(ENABLED_STORAGE_KEY, enabled ? null : 'off');
}

export function cloudUrl(path: string): string {
  const base = getCloudBase();
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}
