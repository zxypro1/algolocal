#!/usr/bin/env node
/**
 * 构建产物的体检。
 *
 * 起因是 v0.16.0：`@xterm/xterm` 的 ESM 产物里有「带名字的类表达式」
 * （`var X = class Name extends Error {}`），Next 13.5 的 SWC 压缩器把 extends
 * 的基类换成了 `null`，于是正式包里 `new Terminal()` 直接抛
 * `Super constructor null of anonymous class is not a constructor`，
 * 整个 ops 工作台的终端起不来。
 *
 * dev 不压缩，所以这个故障**只在正式构建里出现**，测试也照不到 ——
 * 唯一能挡住它的地方就是构建之后扫一眼产物。
 *
 * 这个脚本挂在 postbuild 上。发现问题就让构建失败，别让它再溜进安装包。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_CHUNK_DIR = path.join(ROOT, '.next', 'static', 'chunks');

/** 每条规则：在产物里出现就是 bug */
const FORBIDDEN = [
  {
    pattern: /extends\s+null\b/g,
    what: 'class extends null',
    why: '压缩器把某个类的基类吃掉了（见 next.config.js 里 xterm 那段注释）。'
      + '`new` 这个类会抛 "Super constructor null ... is not a constructor"。',
  },
];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/**
 * 扫一个目录，返回发现的问题。
 *
 * 单独抽出来是为了能被测试直接调 —— 一道永远返回「没问题」的闸门
 * 比没有闸门更糟，所以它自己也要被测。
 */
function inspect(chunkDir) {
  const files = walk(chunkDir);
  const problems = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const rule of FORBIDDEN) {
      rule.pattern.lastIndex = 0;
      const hits = source.match(rule.pattern);
      if (hits) problems.push({ file: path.relative(ROOT, file), rule, count: hits.length });
    }
  }
  return { files, problems };
}

module.exports = { inspect, FORBIDDEN };

// 直接跑才检查产物；被 require 时只导出函数
if (require.main === module) {
  const chunkDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CHUNK_DIR;
  const { files, problems } = inspect(chunkDir);

  if (files.length === 0) {
    console.error(`check-bundle: ${chunkDir} 下没有产物，先跑 next build`);
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error('\ncheck-bundle: 产物里发现了不该有的东西\n');
    for (const problem of problems) {
      console.error(`  ${problem.file}`);
      console.error(`    ${problem.count} 处 ${problem.rule.what}`);
      console.error(`    ${problem.rule.why}\n`);
    }
    process.exit(1);
  }

  console.log(`check-bundle: ${files.length} 个 chunk，没发现已知的产物级故障`);
}
