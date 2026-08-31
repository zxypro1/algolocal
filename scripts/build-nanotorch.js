#!/usr/bin/env node
/**
 * 把 nanotorch 的 .py 源码嵌进一个 TS 模块。
 *
 * ## 为什么要这一步
 *
 * nanotorch 是 Python，但它要在**浏览器里**被写进 Pyodide 的虚拟文件系统。
 * 三条路都试过一遍，选了第三条：
 *
 * | 路 | 问题 |
 * | --- | --- |
 * | 直接写成 TS 里的字符串常量 | .py 就不再是 .py 了：没有语法高亮、没法 lint、diff 难读 |
 * | 放 public/ 下运行时 fetch | 多五六个打包白名单条目，判定跑在 Worker 里还要多一轮往返 |
 * | **.py 源码 + 生成一个 TS 模块** | 多一个构建步骤，而这一步可以被测试盯住 |
 *
 * 生成物进仓库（几十 KB），和算子核的 .wasm 一个待遇：
 * 日常开发不需要跑这个脚本，改了 .py 才需要。
 * `tests/llmlab/nanotorch.test.ts` 会重新生成一遍并逐字节比对，
 * 所以「改了 .py 忘了重新生成」会当场红 —— 那种情况下代码看着是新的、跑的是旧的。
 *
 * 用法：
 *   node scripts/build-nanotorch.js            写入生成物
 *   node scripts/build-nanotorch.js --check    只比对，不写（CI 用）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src', 'lib', 'llmlab', 'python', 'nanotorch');
const OUT_FILE = path.join(ROOT, 'src', 'lib', 'llmlab', 'python', 'sources.generated.ts');

/** 收集 nanotorch 下的 .py，按名字排序 —— 顺序稳定，生成物才可复现 */
function collect() {
  const names = fs.readdirSync(SRC_DIR).filter((n) => n.endsWith('.py')).sort();
  if (names.length === 0) throw new Error(`${SRC_DIR} 下一个 .py 都没有`);
  return names.map((name) => [
    `nanotorch/${name}`,
    fs.readFileSync(path.join(SRC_DIR, name), 'utf8'),
  ]);
}

function render(entries) {
  const hash = crypto.createHash('sha256');
  for (const [name, content] of entries) hash.update(name).update('\0').update(content).update('\0');
  const digest = hash.digest('hex').slice(0, 16);

  const body = entries
    .map(([name, content]) => `  ${JSON.stringify(name)}: ${JSON.stringify(content)},`)
    .join('\n');

  return `/**
 * 由 scripts/build-nanotorch.js 生成 —— **不要手改这个文件**。
 *
 * 要改 nanotorch，改 src/lib/llmlab/python/nanotorch/*.py，
 * 然后跑一遍 \`node scripts/build-nanotorch.js\`。
 * 忘了跑的话 tests/llmlab/nanotorch.test.ts 会红。
 */

/** 路径 -> 源码。写进 Pyodide 的虚拟文件系统时按这个 key 落盘 */
export const NANOTORCH_SOURCES: Record<string, string> = {
${body}
};

/** 全部源码的指纹。判定报告里带上它，便于对齐「学员当时用的是哪一版」 */
export const NANOTORCH_HASH = ${JSON.stringify(digest)};
`;
}

const entries = collect();
const text = render(entries);
const check = process.argv.includes('--check');
const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;

if (check) {
  if (existing === text) {
    console.log(`✓ sources.generated.ts 与 ${entries.length} 个 .py 一致`);
  } else {
    console.error('✗ sources.generated.ts 过期了 —— 跑一遍 node scripts/build-nanotorch.js 并一起提交');
    process.exit(1);
  }
} else if (existing === text) {
  console.log(`sources.generated.ts 已经是最新的（${entries.length} 个文件）`);
} else {
  fs.writeFileSync(OUT_FILE, text, 'utf8');
  console.log(`✓ 写入 sources.generated.ts（${entries.length} 个文件）`);
}
