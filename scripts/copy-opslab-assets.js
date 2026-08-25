#!/usr/bin/env node
/**
 * 把 opslab 需要的 WASM 资源从 node_modules 拷到 public/opslab/。
 *
 * tree-sitter 的运行时与 bash 语法都是 WASM 文件，浏览器要按 URL 去 fetch，
 * 不能靠打包器 import 进来。public/opslab/*.wasm 在 .gitignore 里，所以
 * 每次构建都要拷一遍 —— 少了它，终端一敲命令就报 404。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'opslab');

const ASSETS = [
  ['web-tree-sitter/web-tree-sitter.wasm', 'web-tree-sitter.wasm'],
  ['tree-sitter-bash/tree-sitter-bash.wasm', 'tree-sitter-bash.wasm'],
];

fs.mkdirSync(OUT_DIR, { recursive: true });

let copied = 0;
for (const [source, target] of ASSETS) {
  const from = path.join(ROOT, 'node_modules', source);
  const to = path.join(OUT_DIR, target);
  if (!fs.existsSync(from)) {
    console.error(`copy-opslab-assets: 找不到 ${source}，先跑 npm install`);
    process.exit(1);
  }
  // 已经一样就别动，免得每次构建都刷新 mtime
  if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) continue;
  fs.copyFileSync(from, to);
  copied += 1;
}

console.log(`copy-opslab-assets: ${copied} 个文件已更新（共 ${ASSETS.length} 个）`);
