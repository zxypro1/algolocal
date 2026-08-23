/**
 * 「这个地址允许请求吗」的唯一判定处。
 *
 * 部署形态决定风险，不是一刀切：
 *
 * - **桌面版（Electron）**：Next 服务跑在用户自己机器上，只有他能访问。
 *   他想请求哪个地址直接 curl 就行，拦他没有意义。
 * - **自托管**：运维者就是使用者，同上。
 * - **公网多租户部署**：这时才有真问题 —— 匿名访客可以把端点填成
 *   内网地址或云元数据地址，借服务端去探测内网。
 *
 * main 上目前只有前两种形态，所以默认放开。公网部署把
 * AI_ENDPOINT_BLOCK_PRIVATE_NETWORK 设成 1 打开拦截。
 *
 * 拦截**按解析出来的 IP 判断，不是按主机名字符串**。只比字符串的话，
 * `169.254.169.254.nip.io` 这种公网域名解析到内网、以及 `[::ffff:7f00:1]`
 * 这类等价写法，全都能绕过去 —— 攻击者不会照着你的正则写地址。
 */

import { promises as dns } from 'dns';
import { isPrivateHostname, isPrivateIp } from '../endpointHosts';

export { isPrivateHostname };

/** 公网部署把这个环境变量打开，就会拒绝内网/回环地址 */
export function blocksPrivateNetwork(): boolean {
  const flag = process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK;
  return flag === '1' || flag === 'true';
}

export interface EndpointCheck {
  ok: boolean;
  reason?: string;
}

const PRIVATE_REFUSED =
  'This deployment does not allow endpoints that resolve to private or loopback addresses. Use a public https endpoint.';

/** 只看协议。给不需要异步的调用点用（比如表单校验）。 */
export function checkEndpointSyntax(rawUrl: string): EndpointCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Not a valid URL: ${rawUrl}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https endpoints are supported.' };
  }
  return { ok: true };
}

/**
 * 完整检查：协议 + （开启拦截时）把主机名解析成 IP 再判断。
 *
 * 残留风险说明：解析和真正建连之间存在时间差，理论上可以 DNS rebinding。
 * 彻底堵住需要自定义 undici dispatcher 在每次建连时校验对端 IP；
 * 这里不引入这个依赖，而是把窗口缩到最小并在文档里写明。
 */
export async function checkEndpoint(rawUrl: string): Promise<EndpointCheck> {
  const syntax = checkEndpointSyntax(rawUrl);
  if (!syntax.ok) return syntax;
  if (!blocksPrivateNetwork()) return { ok: true };

  const url = new URL(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  // 字面量 IP 不用查 DNS
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) {
    return isPrivateIp(hostname) ? { ok: false, reason: PRIVATE_REFUSED } : { ok: true };
  }

  // localhost 这类名字有时不走 DNS，先按名字挡一道
  if (isPrivateHostname(hostname)) return { ok: false, reason: PRIVATE_REFUSED };

  try {
    const records = await dns.lookup(hostname, { all: true });
    // 任何一条解析结果落在内网就拒绝：多 A 记录里混一条内网地址是常见手法
    if (records.some((record) => isPrivateIp(record.address))) {
      return { ok: false, reason: PRIVATE_REFUSED };
    }
  } catch {
    return { ok: false, reason: `Cannot resolve the host in ${rawUrl}.` };
  }

  return { ok: true };
}

export interface GuardedFetchInit extends RequestInit {
  /** 最多跟随几跳重定向 */
  maxRedirects?: number;
}

/**
 * 带策略的 fetch。
 *
 * 重定向必须自己跟：交给 fetch 自动跟随的话，一个公网地址 302 到
 * 169.254.169.254 就把前面的检查整个绕过去了 —— 每一跳都要重新查。
 */
/**
 * 地址本身被策略拦下了（写错了、指向内网、绕太多跳）。
 *
 * 这属于「你填的配置不对」，和上游返回 4xx 是一类，不该以 500 的形式出现 ——
 * 尤其它的 message 本来就是写给用户看的那一句。
 */
export class EndpointPolicyError extends Error {
  status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'EndpointPolicyError';
  }
}

export async function guardedFetch(url: string, init: GuardedFetchInit = {}): Promise<Response> {
  const { maxRedirects = 5, ...rest } = init;
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const verdict = await checkEndpoint(current);
    if (!verdict.ok) throw new EndpointPolicyError(verdict.reason || 'This endpoint is not allowed.');

    const response = await fetch(current, {
      ...rest,
      // 开了拦截就自己跟重定向，好逐跳校验；没开就交给 fetch
      redirect: blocksPrivateNetwork() ? 'manual' : (rest.redirect ?? 'follow'),
    });

    if (!blocksPrivateNetwork()) return response;
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    current = new URL(location, current).toString();
  }

  throw new EndpointPolicyError(`Too many redirects from ${url}.`);
}

/**
 * 把 fetch 的传输层失败翻译成用户能照着改的一句话。
 *
 * 「fetch failed」对用户毫无帮助，而端点填错、服务没起、证书不受信任是本地
 * 模型场景里最常见的三种失败 —— 它们和上游返回的 4xx 一样，都是「你要改的
 * 是配置」，不该以一个 500 的形式出现。
 */
export function describeNetworkError(error: any, base: string, timeoutMs?: number): string {
  if (error?.name === 'AbortError') {
    const within = timeoutMs ? ` within ${Math.round(timeoutMs / 1000)}s` : '';
    return `No response from ${base}${within}. If it is remote, check that it is reachable from this machine.`;
  }
  const code = error?.cause?.code || error?.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Cannot resolve the host in ${base}. Check the address for typos.`;
    case 'ECONNREFUSED':
      return `${base} refused the connection. Check the port, and that the server is running.`;
    case 'ECONNRESET':
    // undici 对「连上了但对端把连接关了」用的是这个码。本地模型服务被 OOM
    // 杀掉、或者地址其实是个非 HTTP 服务时就是它。
    case 'UND_ERR_SOCKET':
      return `${base} closed the connection unexpectedly. Check that it is an OpenAI-compatible HTTP endpoint, and look at its own log.`;
    case 'CERT_HAS_EXPIRED':
      return `The TLS certificate for ${base} has expired.`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `${base} uses a certificate this machine does not trust (self-signed or an unknown CA). Use a trusted certificate, or put the gateway behind one.`;
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `The TLS certificate for ${base} does not cover that hostname.`;
    default: {
      // 「fetch failed」本身没有信息量，能带上底层原因就带上
      const detail = error?.cause?.message || error?.message || String(error);
      return `Could not reach ${base}: ${detail}`;
    }
  }
}
