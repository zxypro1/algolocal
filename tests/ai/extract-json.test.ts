/**
 * extractJson 的回归测试
 *
 * 我们要的 JSON 内部本来就带 markdown 和代码块（题面、mermaid 架构图、参考实现
 * 都是提示词明确要求的）。之前的围栏正则是懒惰匹配，会在内嵌代码块的第一个 ```
 * 处截断，把一段 ts 片段当成整个回复，于是解析失败、生成直接报错。
 */
import { extractJson } from '../../src/lib/server/aiProvider';

describe('extractJson', () => {
  it('parses a bare JSON response', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a fenced JSON response', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('keeps markdown code fences that live inside the JSON', () => {
    const brief = 'Step one:\n```ts\nconst a = 1;\n```\nDone.';
    const raw = JSON.stringify({ brief, id: 'x' });
    expect(extractJson<any>(raw).brief).toBe(brief);
  });

  it('handles a fenced response whose JSON contains fences', () => {
    const brief = 'Diagram:\n```mermaid\nflowchart LR\n  A --> B\n```\n';
    const raw = '```json\n' + JSON.stringify({ brief }) + '\n```';
    expect(extractJson<any>(raw).brief).toBe(brief);
  });

  it('tolerates prose around the JSON', () => {
    expect(extractJson<any>('Sure!\n{"a":2}\nHope that helps.')).toEqual({ a: 2 });
  });

  it('throws when there is no JSON at all', () => {
    expect(() => extractJson('no json here')).toThrow(/did not return valid JSON/);
  });
});
