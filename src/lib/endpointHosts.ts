/**
 * 主机地址分类。放在 server 目录之外，因为设置页也要用同一套规则判断
 * 「用户填的是不是远程地址」—— 两边规则不一致就会出现「提示的是一回事、
 * 实际做的是另一回事」。纯函数，不碰任何 Node API。
 *
 * 注意这里有两种用途，别混：
 * - `isPrivateHostname`：**启发式**，用来决定补 http 还是 https、要不要提示补 Key。
 *   猜错了顶多是提示不准。
 * - `isPrivateIp`：**安全边界**，用在解析出 IP 之后。这个不能猜错。
 */

/** 一个已经是字面量 IP 的地址是否属于内网/回环/链路本地 */
export function isPrivateIp(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');

  // IPv4
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;  // 链路本地，云元数据在 169.254.169.254
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT 100.64/10
    return false;
  }

  // IPv6。IPv4-mapped 有 ::ffff:127.0.0.1 和 ::ffff:7f00:1 两种写法，
  // WHATWG URL 会把前者规范化成后者，所以两种都要认。
  if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '::') return true;
  const mapped = host.match(/^::ffff:(.+)$/);
  if (mapped) {
    const inner = mapped[1];
    if (inner.includes('.')) return isPrivateIp(inner);
    // 十六进制写法：::ffff:7f00:1 -> 127.0.0.1
    const groups = inner.split(':');
    if (groups.length === 2) {
      const high = parseInt(groups[0], 16);
      const low = parseInt(groups[1], 16);
      if (!Number.isNaN(high) && !Number.isNaN(low)) {
        const dotted = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
        return isPrivateIp(dotted);
      }
    }
  }
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;   // 唯一本地 fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;   // 链路本地 fe80::/10
  return false;
}

/** 内网后缀。单标签主机名（没有点）几乎必然是局域网里的机器。 */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home', '.internal', '.intranet'];

/**
 * 启发式：这个主机名看起来是不是本机 / 局域网。
 * 用来决定补什么协议、要不要提示填 Key —— 不作为安全边界。
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost') return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // 没有点的主机名不可能是公网域名（公网域名总得有 TLD），
  // 那就是 `gpu-box`、`nas` 这种局域网机器 —— 给它补 https 会直接连不上。
  if (!host.includes('.') && !host.includes(':')) return true;
  return isPrivateIp(host);
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
