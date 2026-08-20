/**
 * 文案插值
 *
 * 之前用的是 String.replace(字符串, ...)，只替换第一处：
 * 「通过了全部 {{total}} 个用例（{{passed}}/{{total}}）」会在界面上留下一个
 * 没被替换的 {{total}}。这个函数被全站的每一句文案调用，值得钉住。
 */
import fs from 'fs';
import path from 'path';

/**
 * 从 I18nContext 里把插值逻辑原样取出来测。
 *
 * 直接 import 那个模块会把整个 React 上下文和两份 locale JSON 一起拖进来，
 * 而这里要验的只是这一小段字符串处理。用源码求值而不是复制一份，是为了
 * 保证测的和线上跑的是同一段代码 —— 复制一份的话，改了实现测试还会是绿的。
 */
function interpolateFromSource(): (value: string, params: Record<string, string | number>) => string {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src', 'contexts', 'I18nContext.tsx'),
    'utf8'
  );

  const match = source.match(/return Object\.entries\(params\)\.reduce\(([\s\S]*?)\n {10}\);/);
  if (!match) throw new Error('The interpolation block moved — update this test to match.');

  // eslint-disable-next-line no-new-func
  return new Function(
    'value',
    'params',
    `return Object.entries(params).reduce(${match[1]}\n);`
  ) as (value: string, params: Record<string, string | number>) => string;
}

const interpolate = interpolateFromSource();

describe('translation interpolation', () => {
  it('replaces a single placeholder', () => {
    expect(interpolate('Found {{count}} problems', { count: 3 })).toBe('Found 3 problems');
  });

  it('replaces every occurrence of the same placeholder', () => {
    expect(
      interpolate('Passed all {{total}} cases ({{passed}}/{{total}})', { total: 3, passed: 3 })
    ).toBe('Passed all 3 cases (3/3)');
  });

  it('handles several placeholders', () => {
    expect(interpolate('{{a}} then {{b}} then {{a}}', { a: 'x', b: 'y' })).toBe('x then y then x');
  });

  it('leaves an unknown placeholder alone rather than blanking it', () => {
    expect(interpolate('Hello {{name}}', { other: 'x' })).toBe('Hello {{name}}');
  });

  it('does not let a value containing $& corrupt the output', () => {
    // 正则替换里 $& 有特殊含义，值是用户数据时会变成一次意外的自引用
    expect(interpolate('Deleted {{title}}', { title: 'a $& b' })).toBe('Deleted a $& b');
  });

  it('coerces numbers and leaves the rest of the string untouched', () => {
    expect(interpolate('{{n}} KB used', { n: 0 })).toBe('0 KB used');
  });
});
