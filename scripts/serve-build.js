#!/usr/bin/env node
/**
 * 起「装出来的那一份」，并且**自己先验一遍再把地址交出来**。
 *
 * 为什么要有这个脚本：发版验收要在真实产物上点一遍工作台，而桌面端是
 * `electron-main.js` 里起一个 next() 服务、窗口去连它。想在没有 Electron 的
 * 情况下复现同一套渲染进程，就得手工起同样的服务 —— 而手工起有两个坑，
 * 两个都**不报错，只表现为「点了没反应」**，我们各踩过一次：
 *
 * 1. **服务活过了一次重新构建。** next() 在启动时读 `.next`，之后 BUILD_ID
 *    就钉死了。重新构建之后 BUILD_ID 变了，浏览器拿到的新 HTML 引用新 ID，
 *    而老服务只认老 ID —— `_buildManifest.js` 404，客户端路由永远补不完，
 *    页面停在「加载中」，这时候往终端里敲的任何命令都会**静静地等下去**。
 *    表现是「CLI 卡住」，而 CLI 根本没被调用。
 *
 * 2. **`public/` 下的文件是服务起来之后才放进去的。** next() 同样在启动时
 *    扫一遍 public，之后新增的文件一律 404。opslab 那个 142MB 的 CLI 正好
 *    是构建之外单独放进去的，最容易撞上。
 *
 * 所以这里做三件事：占着端口的旧服务先请走、起服务、**起完自己抓一遍关键
 * 资源**，全绿了才打印地址。没绿就非零退出 —— 宁可不给地址，也不要给一个
 * 会让人查半天的假环境。
 *
 * 用法：
 *   npm run build && node scripts/serve-build.js
 *   node scripts/serve-build.js --port 3210
 */
const { createServer } = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 3210;
const HOST = '127.0.0.1';

/** 关键资源：少了任何一条，某个工作台就是「点进去是死的」 */
function criticalAssets(buildId) {
  const list = [`/_next/static/${buildId}/_buildManifest.js`];
  // 只验真的摆在 public 下的那些 —— 没构建过的产物不该让整个脚本失败
  const optional = [
    '/opslab/opslab-cli.wasm',
    '/llmlab/llmlab-kernels.wasm',
    '/llmlab/pyodide/pyodide.asm.wasm',
    '/gpulab/tree-sitter-cuda.wasm',
  ];
  for (const url of optional) {
    if (fs.existsSync(path.join(ROOT, 'public', url.replace(/^\//, '')))) list.push(url);
  }
  return list;
}

function freePort(port) {
  try {
    const pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      console.log(`> 端口 ${port} 上还有旧服务（pid ${pid}），先请走`);
      try { process.kill(Number(pid), 'SIGKILL'); } catch { /* 已经没了 */ }
    }
    if (pids.length) execSync('sleep 1');
  } catch {
    // lsof 没有匹配就是非零退出，端口是空的
  }
}

async function main() {
  const buildIdPath = path.join(ROOT, '.next', 'BUILD_ID');
  if (!fs.existsSync(buildIdPath)) {
    console.error('✗ 没有 .next/BUILD_ID —— 先跑 `npm run build`');
    process.exit(1);
  }
  const buildId = fs.readFileSync(buildIdPath, 'utf8').trim();

  freePort(PORT);

  const next = require(path.join(ROOT, 'node_modules', 'next'));
  const app = next({ dev: false, hostname: HOST, port: PORT, dir: ROOT });
  await app.prepare();
  const handler = app.getRequestHandler();
  const server = createServer((req, res) => handler(req, res));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });

  const base = `http://${HOST}:${PORT}`;
  let bad = 0;
  for (const url of criticalAssets(buildId)) {
    const response = await fetch(`${base}${url}`, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    const ok = response.status === 200 || response.status === 206;
    if (!ok) bad += 1;
    console.log(`${ok ? '✓' : '✗'} ${response.status}  ${url}`);
  }

  if (bad) {
    console.error(`\n✗ ${bad} 个关键资源取不到 —— 这个环境验不了东西，先修好再用。`);
    console.error('  多半是 public/ 下的文件在服务起来之后才放进去的：把文件放好，再跑一次这个脚本。');
    server.close();
    process.exit(1);
  }

  console.log(`\n✓ BUILD_ID ${buildId}，关键资源齐了`);
  console.log(`✓ ${base}`);
  console.log('\n注意：**重新构建之后必须重跑这个脚本**，否则页面会停在「加载中」，');
  console.log('     而终端里敲什么都不会有反应（见文件顶部的说明）。');
}

main().catch((error) => {
  console.error('✗ 起不来：', error);
  process.exit(1);
});
