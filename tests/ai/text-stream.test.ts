/**
 * 纯文本流（AI 题解）的错误通道。
 *
 * 这条路径的正文就是代码本身，错误只能夹在正文里送 —— 分隔符必须是代码里
 * 不可能出现的东西，否则一段正常的题解会被从中间截断、还报一个假错误。
 */
import { splitTextStreamError, TEXT_STREAM_ERROR_MARK } from '../../src/lib/textStreamProtocol';

describe('text stream error channel', () => {
  it('splits the error off the generated code', () => {
    const body = `function solve() {}${TEXT_STREAM_ERROR_MARK}the endpoint refused the connection`;
    expect(splitTextStreamError(body)).toEqual({
      text: 'function solve() {}',
      error: 'the endpoint refused the connection',
    });
  });

  it('leaves a clean answer untouched', () => {
    expect(splitTextStreamError('function solve() {}')).toEqual({
      text: 'function solve() {}',
      error: '',
    });
  });

  it('does not mistake prose about errors for the error channel', () => {
    // 旧的分隔符是可读的 `[error] `，模型完全写得出来 ——
    // 后果是这段题解从这里被截断
    const body = 'function solve() {}\n\n// prints\n\n[error] when the input is empty';
    expect(splitTextStreamError(body).error).toBe('');
    expect(splitTextStreamError(body).text).toBe(body);
  });

  it('takes the last mark, so an error is never swallowed by the answer', () => {
    const body = `code${TEXT_STREAM_ERROR_MARK}first${TEXT_STREAM_ERROR_MARK}second`;
    expect(splitTextStreamError(body).error).toBe('second');
  });
});
