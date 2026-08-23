/**
 * 纯文本流（AI 题解）里怎么报错。
 *
 * 这条路径没有 SSE 的事件通道：正文就是代码本身，一边收一边写进编辑器。
 * 头发出去之后再出错，只能把错误也写进正文里 —— 于是需要一个**代码里不可能
 * 出现**的分隔符。用 `[error]` 这种可读的写法看着舒服，但模型完全可能在解释
 * 里写出同样的字，后果是一段正常的题解被从那里截断、还报一个假错误。
 *
 * U+0000 不会出现在源码里，也不会出现在模型的输出里。
 */
export const TEXT_STREAM_ERROR_MARK = '\u0000[error] ';

/** 从纯文本流的正文里切出「正文」和「错误」两半 */
export function splitTextStreamError(body: string): { text: string; error: string } {
  const at = body.lastIndexOf(TEXT_STREAM_ERROR_MARK);
  if (at < 0) return { text: body, error: '' };
  return {
    text: body.slice(0, at),
    error: body.slice(at + TEXT_STREAM_ERROR_MARK.length).trim(),
  };
}
