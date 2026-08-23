/**
 * 列出某个 OpenAI 兼容端点上可用的模型。
 *
 * 设置页用它把「模型 id」从一个要用户自己去别处抄的输入框，变成一个下拉框。
 * 走服务端而不是浏览器直连，是因为本地服务（LM Studio 等）默认只监听
 * 127.0.0.1，而且多半没开 CORS —— 浏览器直接 fetch 会被拦下。
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { normalizeCompatibleEndpoint } from '../../src/lib/server/aiProvider';
import { checkEndpointSyntax, describeNetworkError, guardedFetch } from '../../src/lib/server/endpointPolicy';

// 远程端点可能在地球另一端，10 秒对跨洋链路偏紧
const TIMEOUT_MS = 20_000;

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
    return res.status(502).json({ error: describeNetworkError(error, base, TIMEOUT_MS) });
  } finally {
    clearTimeout(timer);
  }
}
