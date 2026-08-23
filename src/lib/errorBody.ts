/**
 * 错误响应体里，哪些内容还值得给用户看。
 *
 * 服务端和客户端要用同一把尺子：两边各写一套的结果是，一段 250 字符的纯文本
 * 错误被服务端原样转发、又被客户端丢掉，用户最后只看到一个状态码。
 *
 * 规则：
 *   - HTML（反代和框架的错误页）丢掉 —— 那是一屏标签，没有一句是给人读的
 *   - 太长的丢掉 —— 真正的错误信息是一句话，不是一页
 *   - 其余留着 —— 例如 Next 自己的 `Body exceeded 1mb limit`
 */
const MAX_READABLE_LENGTH = 300;

export function looksLikeMarkup(body: string): boolean {
  return (body || '').trim().startsWith('<');
}

export function readableErrorBody(body: string): string {
  const text = (body || '').trim();
  if (!text || looksLikeMarkup(text)) return '';
  // 长的截断，不要整段丢掉：自建网关的报错可能是一段模板渲染栈，
  // 前 300 个字符里通常就有那句关键的话。
  return text.length > MAX_READABLE_LENGTH ? `${text.slice(0, MAX_READABLE_LENGTH)}…` : text;
}
