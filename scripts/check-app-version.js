#!/usr/bin/env node
/**
 * 断言打包产物报的版本号 == package.json 的版本号
 *
 * 为什么需要这道检查：v0.17.0 与 v0.17.1 两个 macOS 包的 Info.plist 里
 * `CFBundleShortVersionString` 都是 **0.16.1** —— electron-builder.config.js 里
 * 手写了一行 `bundleShortVersion: '0.16.1'`，package.json 涨了三个版本它都不动。
 * 产物文件名、Release、官网全都正确，唯独「关于」面板和访达里显示的是旧号，
 * 三次发版没人发现。硬编码的值会漂移，而漂移是悄无声息的。
 *
 * 所以这里不检查「配置里有没有写死」（写死的形式可以千变万化），
 * 而是检查**最终产物实际报出来的那个数**。产物怎么来的不重要，
 * 报错的号必须对得上。
 *
 * 用法：
 *   node scripts/check-app-version.js            # 扫 dist/ 下所有 .app
 *   node scripts/check-app-version.js <dist 目录>
 *
 * 找不到任何 .app 时会失败而不是悄悄通过 —— 「没东西可查」和「查过了没问题」
 * 必须分得开，否则这道防线会在某次目录改名之后变成一句空话。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** 从 Info.plist 里读一个键。优先 PlistBuddy（二进制 plist 也认），失败再退回 XML 正则。 */
function readPlistKey(plistPath, key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // 非 macOS，或者 PlistBuddy 不在：按 XML 读。二进制 plist 会读不到，返回 null。
    const xml = fs.readFileSync(plistPath, 'utf8');
    const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return m ? m[1] : null;
  }
}

/** 递归找 .app（只往下找两层，dist/mac-arm64/AlgoLocal.app 这种深度就够） */
function findAppBundles(distDir, depth = 0) {
  if (depth > 2 || !fs.existsSync(distDir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(distDir, entry.name);
    if (entry.name.endsWith('.app')) found.push(full);
    else found.push(...findAppBundles(full, depth + 1));
  }
  return found;
}

/**
 * 核心判定。返回 { ok, checked, problems }，不抛异常也不退出 ——
 * 这样用例可以直接喂一个假的 .app 进来验「它真的会拦」。
 */
function checkAppVersion(distDir, expectedVersion) {
  const apps = findAppBundles(distDir);
  const problems = [];
  const checked = [];

  if (apps.length === 0) {
    return {
      ok: false,
      checked,
      problems: [`在 ${distDir} 下没找到任何 .app —— 无从校验版本号。` +
        `如果打包目录改过名，请一并改这里，别让这道检查静默通过。`],
    };
  }

  for (const app of apps) {
    const plist = path.join(app, 'Contents', 'Info.plist');
    if (!fs.existsSync(plist)) {
      problems.push(`${app}: 没有 Contents/Info.plist`);
      continue;
    }
    const short = readPlistKey(plist, 'CFBundleShortVersionString');
    checked.push({ app, short });
    if (short !== expectedVersion) {
      problems.push(
        `${path.basename(app)}: Info.plist 的 CFBundleShortVersionString 是 ${short}，` +
        `package.json 是 ${expectedVersion}。` +
        `多半是 electron-builder.config.js 里又写死了 bundleShortVersion。`
      );
    }
  }

  return { ok: problems.length === 0, checked, problems };
}

function main() {
  const distDir = process.argv[2] || path.join(__dirname, '..', 'dist');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  // 只有 macOS 的产物里有 .app。别的平台上没东西可查，直接跳过并说清楚。
  if (process.platform !== 'darwin' && findAppBundles(distDir).length === 0) {
    console.log('check-app-version: 当前平台没有 .app 产物，跳过');
    return;
  }

  const { ok, checked, problems } = checkAppVersion(distDir, pkg.version);
  for (const item of checked) {
    console.log(`check-app-version: ${path.basename(item.app)} -> ${item.short}`);
  }
  if (!ok) {
    for (const p of problems) console.error(`::error::check-app-version: ${p}`);
    process.exit(1);
  }
  console.log(`check-app-version: ${checked.length} 个产物的版本号都是 ${pkg.version}`);
}

if (require.main === module) main();

module.exports = { checkAppVersion, findAppBundles, readPlistKey };
