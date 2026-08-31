#!/usr/bin/env node
/**
 * 把实验台需要的 WASM 资源从 node_modules 拷到 public/ 下。
 *
 * tree-sitter 的运行时与各语言语法都是 WASM 文件，浏览器要按 URL 去 fetch，
 * 不能靠打包器 import 进来。这些目录在 .gitignore 里，所以每次构建都要拷一遍 ——
 * 少了它，终端一敲命令就报 404。
 *
 * 按归属分目录：
 *   public/labkit/  两个实验台共用的地基（tree-sitter 运行时、shell 语法）
 *   public/gpulab/  gpulab 专用（CUDA 语法）
 *   public/opslab/  opslab 专用（Go 编出来的多合一 CLI，不由这个脚本管）
 *
 * 注意：**新增一行就要同时改 electron-builder.config.js**。那边的
 * `files` 与 `asarUnpack` 都是逐个文件的白名单（理由见那个文件里的注释），
 * 漏了的话开发机上一切正常、装出来的包一敲命令就死。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** [node_modules 里的相对路径, public 下的相对路径] */
const ASSETS = [
  ['web-tree-sitter/web-tree-sitter.wasm', 'labkit/web-tree-sitter.wasm'],
  ['tree-sitter-bash/tree-sitter-bash.wasm', 'labkit/tree-sitter-bash.wasm'],
  ['tree-sitter-cuda/tree-sitter-cuda.wasm', 'gpulab/tree-sitter-cuda.wasm'],
  /*
   * llmlab 的 Python 运行时。这五个就是 Pyodide 跑起来需要的全部
   * （13.53MB，brotli 之后 5.86MB —— 作参照，opslab 那个 wasm 是 142MB / 14MB）。
   *
   * **必须拷到本地，绝不能让它去 CDN 取。** 这个 app 是离线优先的，
   * 而 Pyodide 默认会从 cdn.jsdelivr.net 抓 indexURL 下的文件与 wheel。
   * `src/lib/llmlab/python/runtime.ts` 里把 indexURL 钉到这个目录，
   * 并且永不调用 loadPackage —— 那条路径一旦存在，断网环境下关卡直接开不了。
   */
  ['pyodide/pyodide.mjs', 'llmlab/pyodide/pyodide.mjs'],
  ['pyodide/pyodide.asm.mjs', 'llmlab/pyodide/pyodide.asm.mjs'],
  ['pyodide/pyodide.asm.wasm', 'llmlab/pyodide/pyodide.asm.wasm'],
  ['pyodide/python_stdlib.zip', 'llmlab/pyodide/python_stdlib.zip'],
  ['pyodide/pyodide-lock.json', 'llmlab/pyodide/pyodide-lock.json'],
];

let copied = 0;
for (const [source, target] of ASSETS) {
  const from = path.join(ROOT, 'node_modules', source);
  const to = path.join(ROOT, 'public', target);
  if (!fs.existsSync(from)) {
    console.error(`copy-lab-assets: 找不到 ${source}，先跑 npm install`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  // 已经一样就别动，免得每次构建都刷新 mtime
  if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(from).size) continue;
  fs.copyFileSync(from, to);
  copied += 1;
}

console.log(`copy-lab-assets: ${copied} 个文件已更新（共 ${ASSETS.length} 个）`);
