# 打包与发布：踩过的坑

> 这份文档只记**已经真的发生过**的事故与陷阱，每条都带复现方式和当时的现象。
> 设计意图写在各自的 `design/<topic>.md` 里，这里只管「别再踩第二次」。

## 一、写死的版本号会漂移，而且是无声的

**现象。** v0.17.0 和 v0.17.1 两个 macOS 包，「关于」面板和访达里显示的版本都是
**0.16.1**。产物文件名（`AlgoLocal-0.17.1-macOS-arm64.dmg`）、GitHub Release、
官网中英文版本号、包内 `app.asar` 的 `package.json` 全部正确，只有 `Info.plist`
里的 `CFBundleShortVersionString` 不对。连着三次发版没人发现。

**根因。** `electron-builder.config.js` 的 `mac` 段手写了两行：

```js
bundleVersion: '1',
bundleShortVersion: '0.16.1',
```

不写这两个键时 electron-builder 会从 `package.json` 的 `version` 推导；一旦写死，
`package.json` 再怎么涨它都不动。

**为什么这么久没发现。** 发版验收查的是「资产齐不齐、链接能不能下、签名是不是
rejected 而不是 revoked、包里 wasm 在不在」—— 全是**外部可见**的东西。
`Info.plist` 里的版本号既不影响下载也不影响运行，只有点开「关于」才看得到。

**复现。**

```bash
npm run electron:pack
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
  dist/mac-arm64/AlgoLocal.app/Contents/Info.plist
```

**现在的防线。** `scripts/check-app-version.js` 在打包后断言产物报出的版本号等于
`package.json` 的版本号，接在 `electron:build*` / `electron:pack` 之后，
并在 `release.yml` 的 macOS 作业里、签名校验之前跑一遍。
`tests/build/app-version.test.js` 反向验证它真的会拦（喂一个 0.16.1 的假 `.app`
必须失败），并且直接扫配置文件，禁止再写回 `bundleShortVersion`。

**规则。** 凡是「本该从 `package.json` 推导」的值，一律不要手写。真要手写，
就同时加一条断言最终产物的检查 —— 检查要盯**产物实际报出来的数**，
而不是盯配置里有没有写死（写死的形式可以千变万化）。

Windows 与 Linux 那边没有 `Info.plist` 可查，同一条检查改为盯**安装包文件名**
里的版本号（`artifactName` 现在用 `${version}`，但它同样是一行随时能改成字面量的配置）。
这里有个刻意的不对称：**`.app` 找不到算失败，安装包一个都没有不算** ——
`electron-builder --dir` 只出目录不出安装包是正常的，而 macOS 上 `.app` 必然存在。

**同一类、但目前只能靠人的地方：** `docs/index.html` 与 `docs/zh/index.html`
里的版本号和 6 个下载链接是手改的。它没法做成构建期断言 —— bump 提交与 docs
提交之间本来就有一段两者不相等的窗口（docs 要等资产上传确认后才推）。
发版流程里「6 个文件名与 Release 资产逐个比对」这一步就是它的替代防线。

## 二、`asar extract-file` 会忽略第三个参数，直接写进当前目录

**现象。** 在仓库根目录跑：

```bash
npx asar extract-file /path/to/app.asar package.json /dev/stdout
```

意图是把包内的 `package.json` 打到标准输出看一眼。实际结果是**仓库根目录的
`package.json` 被覆盖**成包内那份 —— 而 electron-builder 打包时会剥掉
`scripts`、`devDependencies`、`keywords`，于是这三块凭空消失，
文件末尾的换行也没了。

**根因。** `asar extract-file <archive> <filename>` 只认两个参数，第三个被静默
忽略；它固定把内容写到**当前工作目录**下的同名文件。名字里的 `extract` 是
写文件，不是打印。

**正确写法。** 用 Node API，它返回 Buffer，不碰磁盘：

```js
const asar = require('@electron/asar');
const buf = asar.extractFile('/path/to/app.asar', 'package.json');
console.log(JSON.parse(buf.toString()).version);
```

真要用 CLI，先 `cd` 到一个临时目录再跑。

**顺带一提。** 这次是靠 `git status` 发现的 —— 覆盖发生在 tag 和构建之后，
已发布的产物没受影响。**在仓库里跑任何会写文件的第三方 CLI 之后，
顺手看一眼 `git status`。**
