/**
 * 主机地址分类。放在 server 目录之外，因为设置页也要用它判断
 * 「用户填的是不是远程地址」，好决定要不要提示补 API Key。
 * 纯函数，不碰任何 Node API。
 */

/** 回环、私有网段、链路本地（含云元数据地址）、以及 .local */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  // IPv6 回环与 IPv4-mapped 回环
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.startsWith('::ffff:')) return isPrivateHostname(host.slice(7));
  // IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1).map(Number);
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 链路本地，云厂商元数据端点就在 169.254.169.254
  if (a === 169 && b === 254) return true;
  return false;
}

/** 远程地址上不带鉴权基本一定是配漏了，UI 用它给个提醒 */
export function looksRemote(rawUrl: string): boolean {
  try {
    return !isPrivateHostname(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/** 明文 http 发到远程去，等于把 API Key 摊开在链路上 */
export function isInsecureRemote(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' && !isPrivateHostname(url.hostname);
  } catch {
    return false;
  }
}
