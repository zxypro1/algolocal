/**
 * 列出某个 OpenAI 兼容端点上可用的模型。
 *
 * 设置页用它把「模型 id」从一个要用户自己去别处抄的输入框，变成一个下拉框。
 * 走服务端而不是浏览器直连，是因为本地服务（LM Studio 等）默认只监听
 * 127.0.0.1，而且多半没开 CORS —— 浏览器直接 fetch 会被拦下。
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { normalizeCompatibleEndpoint } from '../../src/lib/server/aiProvider';

const TIMEOUT_MS = 10_000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { endpoint, apiKey } = (req.body || {}) as { endpoint?: string; apiKey?: string };
  const base = normalizeCompatibleEndpoint(endpoint || '');
  if (!base) {
    return res.status(400).json({ error: 'An endpoint is required.' });
  }

  // 这个路由按定义就是「去请求用户填的地址」，但也别让它变成一个万能的
  // 服务端探测器：限定 http/https，挡掉 file:、gopher: 之类的协议。
  // 部署成公网服务时这里应该再加一层内网地址白名单/黑名单。
  let target: URL;
  try {
    target = new URL(`${base}/models`);
  } catch {
    return res.status(400).json({ error: `Not a valid URL: ${base}` });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only http and https endpoints are supported.' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(target, {
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
    const aborted = error?.name === 'AbortError';
    return res.status(502).json({
      error: aborted
        ? `No response from ${base} within ${TIMEOUT_MS / 1000}s.`
        : `Could not reach ${base}: ${error?.message || String(error)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}
