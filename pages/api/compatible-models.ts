/**
 * 列出某个 OpenAI 兼容端点上可用的模型。
 *
 * 设置页用它把「模型 id」从一个要用户自己去别处抄的输入框，变成一个下拉框。
 * 走服务端而不是浏览器直连，是因为本地服务（LM Studio 等）默认只监听
 * 127.0.0.1，而且多半没开 CORS —— 浏览器直接 fetch 会被拦下。
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { normalizeCompatibleEndpoint } from '../../src/lib/server/aiProvider';
import { checkEndpointSyntax, guardedFetch } from '../../src/lib/server/endpointPolicy';

// 远程端点可能在地球另一端，10 秒对跨洋链路偏紧
const TIMEOUT_MS = 20_000;

/**
 * 远程端点失败的原因和本地不一样：DNS、证书、防火墙都可能。
 * 原样抛 fetch 的 "fetch failed" 对用户毫无帮助，这里翻译成能行动的说法。
 */
function describeNetworkError(error: any, base: string): string {
  if (error?.name === 'AbortError') {
    return `No response from ${base} within ${TIMEOUT_MS / 1000}s. If it is remote, check that it is reachable from this machine.`;
  }
  const code = error?.cause?.code || error?.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Cannot resolve the host in ${base}. Check the address for typos.`;
    case 'ECONNREFUSED':
      return `${base} refused the connection. Check the port, and that the server is running.`;
    case 'CERT_HAS_EXPIRED':
      return `The TLS certificate for ${base} has expired.`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `${base} uses a certificate this machine does not trust (self-signed or an unknown CA). Use a trusted certificate, or put the gateway behind one.`;
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `The TLS certificate for ${base} does not cover that hostname.`;
    default:
      return `Could not reach ${base}: ${error?.message || String(error)}`;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { endpoint, apiKey } = (req.body || {}) as { endpoint?: string; apiKey?: string };
  const base = normalizeCompatibleEndpoint(endpoint || '');
  if (!base) {
    return res.status(400).json({ error: 'An endpoint is required.' });
  }

  // 这个路由按定义就是「去请求用户填的地址」。桌面版和自托管下这没有问题
  // （用户本来就能直接 curl），公网部署则由 endpointPolicy 按环境变量拦内网。
  const verdict = checkEndpointSyntax(`${base}/models`);
  if (!verdict.ok) {
    return res.status(400).json({ error: verdict.reason });
  }
  const target = `${base}/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // guardedFetch 负责内网判定与逐跳校验重定向
    const response = await guardedFetch(target, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      return res.status(502).json({
        error: `The endpoint answered ${response.status}.`,
        detail: detail.slice(0, 300),
      });
    }

    const data = await response.json();
    // OpenAI 的形状是 { data: [{ id }] }；有些实现直接返回数组，两种都收
    const list = Array.isArray(data) ? data : data?.data;
    const models = Array.isArray(list)
      ? list.map((item: any) => (typeof item === 'string' ? item : item?.id)).filter(Boolean)
      : [];

    return res.status(200).json({ endpoint: base, models });
  } catch (error: any) {
    return res.status(502).json({ error: describeNetworkError(error, base) });
  } finally {
    clearTimeout(timer);
  }
}
