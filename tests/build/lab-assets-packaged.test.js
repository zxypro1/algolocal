/**
 * 实验台的 wasm 资源必须同时进两张打包白名单
 *
 * ## 为什么要这条
 *
 * `electron-builder.config.js` 的 `files` 与 `asarUnpack` 都是**逐个文件**的白名单
 * （理由见那个文件里的注释：通配符会把别人工作区里遗留的旧产物一起打进包，
 * 早先那个 120MB 的 kubectl.wasm 就是这么混进去的）。
 *
 * 逐个列名的代价是**会漏**。而漏了的表现极其不友好：
 * 开发机上一切正常（Next 直接从 public/ 读），装出来的包里那个文件 404，
 * 工作台一进去就死。`scripts/copy-lab-assets.js` 顶上的注释专门写了
 * 「新增一行就要同时改 electron-builder.config.js」—— 但那是一句叮嘱，不是一道闸门。
 *
 * 这条用例把它变成闸门：**凡是会出现在 public/ 下的实验台 wasm，
 * 两张白名单里都必须有它。**
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

/**
 * 这个仓库预期会出现在 public/ 下的实验台资源，三个来源合起来。
 *
 * 收的是**所有扩展名**，不只是 .wasm —— Pyodide 那五个里有 .mjs / .zip / .json，
 * 而漏掉它们中的任何一个，Python 都起不来。第一版这里只匹配了 `.wasm`，
 * 正好在要加它们的前一刻发现这个洞。
 */
function expectedAssets() {
  const found = new Set();

  // 1. copy-lab-assets.js 从 node_modules 拷过去的那些
  const copy = fs.readFileSync(path.join(ROOT, 'scripts', 'copy-lab-assets.js'), 'utf8');
  const assetsBlock = copy.slice(copy.indexOf('const ASSETS'), copy.indexOf('let copied'));
  for (const match of assetsBlock.matchAll(/,\s*'([^']+)'\s*\]/g)) {
    found.add(`public/${match[1]}`);
  }

  // 2. 构建脚本产出的（opslab 的多合一 CLI）
  for (const name of fs.readdirSync(path.join(ROOT, 'scripts'))) {
    if (!name.endsWith('.sh')) continue;
    const source = fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
    const dir = source.match(/OUT_DIR="\$\{OUT_DIR:-([^}"]+)\}"/);
    const out = source.match(/OUT_NAME="\$\{OUT_NAME:-([^}"]+)\}"/);
    if (dir && out) found.add(`${dir[1].replace(/^\$ROOT\//, '')}/${out[1]}`);
  }

  // 3. 直接入库的（llmlab 的算子核只有几十 KB，所以是进仓库的）
  const tracked = execFileSync('git', ['ls-files', 'public'], { cwd: ROOT, encoding: 'utf8' });
  for (const line of tracked.split('\n')) {
    if (line.trim().endsWith('.wasm')) found.add(line.trim());
  }

  return [...found].sort();
}

/** 白名单里逐个列名的那些 public/ 资源 */
function listedAssets(config) {
  return [...config.matchAll(/'(public\/(?:labkit|gpulab|opslab|llmlab)\/[^']+)',/g)].map((m) => m[1]);
}

describe('实验台资源的打包白名单', () => {
  const config = fs.readFileSync(path.join(ROOT, 'electron-builder.config.js'), 'utf8');
  const assets = expectedAssets();

  it('三个实验台的资源都认出来了 —— 否则这条用例是空转的', () => {
    expect(assets.length).toBeGreaterThanOrEqual(9);
    for (const dir of ['public/labkit/', 'public/gpulab/', 'public/opslab/', 'public/llmlab/']) {
      expect(assets.some((asset) => asset.startsWith(dir))).toBe(true);
    }
    // Pyodide 那五个一个都不能少，少一个 Python 就起不来
    expect(assets.filter((a) => a.startsWith('public/llmlab/pyodide/'))).toHaveLength(5);
  });

  it.each(expectedAssets())('%s 在 files 白名单里', (asset) => {
    // 必须是**列进去**的那一行，不能只是被 `!` 排除掉
    expect(config).toContain(`'${asset}',`);
  });

  it.each(expectedAssets())('%s 在 asarUnpack 里', (asset) => {
    const unpack = config.slice(config.indexOf('asarUnpack:'));
    expect(unpack).toContain(`'${asset}'`);
  });

  /*
   * 反向：白名单里也不该留着已经没人用的路径 —— 那种残留会把一个
   * 早就删掉的文件继续打进包，或者（更常见）在重命名之后掩盖真正的缺失。
   */
  it('files 白名单里没有指向不存在也不会被产出的资源', () => {
    for (const item of listedAssets(config)) {
      const known = assets.includes(item) || fs.existsSync(path.join(ROOT, item));
      expect(known).toBe(true);
    }
  });
});
