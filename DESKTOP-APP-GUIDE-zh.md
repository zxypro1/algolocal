# 桌面应用构建指南

本指南介绍如何将离线算法练习构建为跨平台桌面应用，支持 Windows、macOS 和 Linux。

## 打包出来的是什么

一个自包含的软件包。拿到它的人不需要装 Node.js、Python 或任何开发工具。

里面是跑在 Electron 里的 Next.js + React 应用。代码在浏览器层通过 WebAssembly 执行：JavaScript 原生跑，TypeScript 先经 TypeScript 编译器转译，Python 跑在 Pyodide 上。

## 构建需要什么

只有从源码构建才需要：

- Node.js >= 18.x
- npm >= 8.x
- 平台特定要求：
  - macOS 构建：macOS 系统
  - Windows 构建：Windows 系统或 Wine
  - Linux 构建：Linux 系统或 Docker

## 构建应用

### 开发模式

```bash
npm install
npm run build
npm run electron:start
```

### 生产构建

#### macOS

```bash
./build-mac.sh
# 或
npm run dist:mac
```

输出文件：
- `dist/AlgoLocal-x.x.x-macOS-x64.dmg`（Intel）
- `dist/AlgoLocal-x.x.x-macOS-arm64.dmg`（Apple Silicon）

#### Windows

PowerShell：
```powershell
.\build-windows.ps1
# 或
npm run dist:win
```

命令提示符：
```cmd
build-windows.bat
```

输出文件：
- `dist/AlgoLocal-x.x.x-Windows-x64.exe`（安装版）
- `dist/AlgoLocal-x.x.x-Windows-Portable.exe`（便携版）

#### Linux

```bash
npm run dist:linux
```

输出文件：
- `dist/AlgoLocal-x.x.x-Linux.AppImage`
- `dist/AlgoLocal-x.x.x-Linux.deb`
- `dist/AlgoLocal-x.x.x-Linux.rpm`

#### 所有平台

```bash
npm run dist:all
```

## 支持的语言

| 语言 | 状态 | 实现方式 |
|------|------|---------|
| JavaScript | 支持 | 浏览器原生 |
| TypeScript | 支持 | TypeScript 编译器 |
| Python | 支持 | Pyodide (WASM) |

注意：需要原生编译器的语言（Java、C、C++、Go）在浏览器端 WASM 环境中不支持。

## 项目结构

```
.
├── electron-main.js          # Electron 主进程
├── electron-preload.js       # Electron 预加载脚本
├── electron-builder.config.js # 构建配置
├── build/
│   └── entitlements.mac.plist # macOS 权限配置
├── build-mac.sh              # macOS 构建脚本
├── build-windows.ps1         # Windows PowerShell 构建脚本
├── build-windows.bat         # Windows 批处理构建脚本
└── dist/                     # 构建输出目录
```

## 配置说明

### electron-builder.config.js

主要配置项：

- `appId`：应用程序标识符
- `productName`：应用显示名称
- `files`：打包文件列表
- `win/mac/linux`：各平台特定配置

### AI 服务商设置

桌面应用支持通过内置设置页面进行配置：

- DeepSeek
- OpenAI
- Qwen（通义千问）
- Claude（Anthropic）
- Ollama（本地部署）

配置存储在 `~/.offline-leet-practice/config.json`。

## 故障排除

### macOS：安全警告

首次打开应用时，macOS 可能显示安全警告。

解决方法：
1. 打开系统偏好设置 > 安全性与隐私
2. 点击"仍要打开"

或在终端执行：
```bash
xattr -cr "/Applications/AlgoLocal.app"
```

### Windows：SmartScreen 警告

Windows 可能对未签名的应用显示 SmartScreen 警告。

解决方法：点击"更多信息" > "仍要运行"

### 代码签名

对外分发建议做代码签名：macOS 需要 Apple Developer 证书，Windows 需要 EV 代码签名证书。

## 更新日志

### v0.0.9
- 迁移至纯 WASM 浏览器端代码执行
- 新增 TypeScript 支持
- 移除对服务器端执行的依赖
- 改进 Electron 构建配置
- 增强 AI 服务商设置页面

## 许可证

MIT License
