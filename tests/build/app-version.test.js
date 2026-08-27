/**
 * 打包产物的版本号
 *
 * 这一组用例守的是一个真实发生过的事故：electron-builder.config.js 里手写了
 * `bundleShortVersion: '0.16.1'`，于是 v0.17.0 和 v0.17.1 两个 macOS 包的
 * 「关于」面板都显示 0.16.1。产物文件名、Release、官网全对，只有这一处不对，
 * 三次发版没人发现。
 *
 * **重点是这些用例得真的会拦。** 所以每条「通过」的用例旁边都配一条
 * 把版本号改错的用例 —— 否则这一整个文件可能只是在证明「函数不抛异常」。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkAppVersion, findAppBundles } = require('../../scripts/check-app-version');

/** 造一个只有 Info.plist 的假 .app —— 检查读的就是这个文件 */
function makeFakeApp(root, name, shortVersion) {
  const app = path.join(root, name);
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>${shortVersion}</string>
  <key>CFBundleVersion</key>
  <string>${shortVersion}</string>
</dict>
</plist>
`);
  return app;
}

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'appver-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('版本号一致性', () => {
  it('版本号对得上就通过', () => {
    makeFakeApp(path.join(tmp, 'mac-arm64'), 'AlgoLocal.app', '0.17.2');
    const result = checkAppVersion(tmp, '0.17.2');
    expect(result.ok).toBe(true);
    expect(result.checked).toHaveLength(1);
  });

  it('**版本号对不上就拦下来** —— 这正是 0.16.1 那次漏掉的情况', () => {
    makeFakeApp(path.join(tmp, 'mac-arm64'), 'AlgoLocal.app', '0.16.1');
    const result = checkAppVersion(tmp, '0.17.2');
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    // 报错要说得出两边分别是多少，否则排查还得自己去翻 plist
    expect(result.problems[0]).toContain('0.16.1');
    expect(result.problems[0]).toContain('0.17.2');
  });

  it('多架构里只要有一个不对就整体失败', () => {
    makeFakeApp(path.join(tmp, 'mac-arm64'), 'AlgoLocal.app', '0.17.2');
    makeFakeApp(path.join(tmp, 'mac-x64'), 'AlgoLocal.app', '0.17.1');
    const result = checkAppVersion(tmp, '0.17.2');
    expect(result.ok).toBe(false);
    expect(result.checked).toHaveLength(2);
    expect(result.problems).toHaveLength(1);
  });

  it('**一个 .app 都没找到时是失败，不是通过** —— 否则目录改名后这道检查就成了摆设', () => {
    const result = checkAppVersion(tmp, '0.17.2');
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('没找到任何 .app');
  });

  it('缺 Info.plist 会被指出来，而不是当成版本号为 undefined', () => {
    const app = path.join(tmp, 'mac-arm64', 'AlgoLocal.app');
    fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
    const result = checkAppVersion(tmp, '0.17.2');
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('Info.plist');
  });
});

describe('找 .app 这件事本身', () => {
  it('嵌在子目录里的也能找到（dist/mac-arm64/X.app）', () => {
    makeFakeApp(path.join(tmp, 'mac-arm64'), 'AlgoLocal.app', '1.0.0');
    expect(findAppBundles(tmp)).toHaveLength(1);
  });

  it('不存在的目录返回空而不是抛异常', () => {
    expect(findAppBundles(path.join(tmp, 'nope'))).toEqual([]);
  });

  it('不会把 .app 内部的目录再当成一个 .app', () => {
    makeFakeApp(path.join(tmp, 'mac-arm64'), 'AlgoLocal.app', '1.0.0');
    const inner = path.join(tmp, 'mac-arm64', 'AlgoLocal.app', 'Contents', 'Helper.app');
    fs.mkdirSync(inner, { recursive: true });
    // 顶层那个先命中就不再往里钻
    expect(findAppBundles(tmp)).toEqual([path.join(tmp, 'mac-arm64', 'AlgoLocal.app')]);
  });
});

describe('配置本身', () => {
  it('**electron-builder.config.js 里不许再出现写死的 bundleShortVersion**', () => {
    const config = fs.readFileSync(
      path.join(__dirname, '..', '..', 'electron-builder.config.js'), 'utf8'
    );
    // 注释里提到这两个名字是允许的（那段注释就是在讲不要写），只拦真正的赋值
    const assignments = config
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .filter((line) => /bundleShortVersion\s*:|bundleVersion\s*:/.test(line));
    expect(assignments).toEqual([]);
  });

  it('package.json 的版本号是三段式 —— 拼产物文件名要靠它', () => {
    const pkg = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', 'package.json'), 'utf8'
    ));
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
