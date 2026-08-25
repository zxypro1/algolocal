/**
 * opslab 的代码必须能在浏览器里跑
 *
 * 测试跑在 Node 里，Node 有 Buffer、process、__dirname 这些全局，浏览器没有。
 * 于是「用了 Node 专属 API」这类错误在测试里完全看不出来，要到真在浏览器打开
 * 才炸 —— 而且往往是分页、快照这种不常走的路径，很晚才被发现。
 *
 * 这里直接扫源码。粗糙，但拦得住。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '../../src/lib/opslab');

/** 只在明确标了「Node 专用」的文件里允许 */
const NODE_ONLY_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\bBuffer\s*\./, why: 'Buffer 在浏览器 bundle 里是 undefined（webpack 5 不打 polyfill）；用 btoa/atob 或 TextEncoder' },
  { pattern: /\brequire\s*\(\s*['"]node:/, why: '不能直接 require node: 内置模块' },
  { pattern: /\bfrom\s+['"]node:/, why: '不能 import node: 内置模块' },
  { pattern: /\b__dirname\b/, why: '__dirname 在浏览器里不存在' },
  { pattern: /\bprocess\.cwd\s*\(/, why: 'process.cwd 在浏览器里不存在' },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('opslab 源码的浏览器安全性', () => {
  const files = walk(ROOT);

  it('扫到了文件（否则这个守卫等于没有）', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(NODE_ONLY_PATTERNS)('不使用 Node 专属 API：$why', ({ pattern, why }) => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      // 允许在注释里提到它们（上面那些说明就提到了 Buffer）
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (pattern.test(code)) offenders.push(path.relative(ROOT, file));
    }
    if (offenders.length > 0) {
      throw new Error(`${offenders.join(', ')} 用了 Node 专属 API —— ${why}`);
    }
  });
});
