<div align="center">

<img src="./docs/icon.png" width="96" alt="AlgoLocal" />

# AlgoLocal

**离线编程练习：从 LeetCode 风格的算法题，到真实的工程项目。**

<p>
  <a href="https://github.com/zxypro1/algolocal/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/zxypro1/algolocal?style=flat-square&color=14c8ff" /></a>
  <a href="https://github.com/zxypro1/algolocal/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/zxypro1/algolocal/total?style=flat-square&color=14c8ff" /></a>
  <a href="https://github.com/zxypro1/algolocal/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/zxypro1/algolocal?style=flat-square&color=ff7a32" /></a>
  <img alt="Platforms" src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square" />
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
</p>

[English](./README.md) &nbsp;·&nbsp; [Español](./README.es-ES.md) &nbsp;·&nbsp; [官网](https://zxypro1.github.io/algolocal/zh/) &nbsp;·&nbsp; [讨论区](https://github.com/zxypro1/algolocal/discussions) &nbsp;·&nbsp; [Issues](https://github.com/zxypro1/algolocal/issues)

</div>

<br />

用 JavaScript、TypeScript 或 Python 刷 LeetCode（力扣）风格的算法题，再进入工程实战：多关卡的真实项目，按并发度、延迟、容错和代码质量评分。全部运行在你自己的机器上，AI 辅助可选，且由你自行配置服务商。

<img alt="做算法题，测试在浏览器里直接跑" src="./docs/screenshots/practice-zh.png" />

## 快速开始

### 桌面应用

无需任何运行时依赖。[下载最新版本](https://github.com/zxypro1/algolocal/releases/latest)：

| 平台 | 安装包 |
|---|---|
| macOS（Apple 芯片） | `AlgoLocal-*-macOS-arm64.dmg` |
| macOS（Intel） | `AlgoLocal-*-macOS-x64.dmg` |
| Windows（安装版） | `AlgoLocal-*-Windows-Setup.exe` |
| Windows（便携版） | `AlgoLocal-*-Windows-Portable.exe` |
| Linux（AppImage） | `AlgoLocal-*-Linux.AppImage` |
| Linux（Debian、Ubuntu） | `AlgoLocal-*-Linux.deb` |
| Linux（Fedora、RHEL） | `AlgoLocal-*-Linux.rpm` |

#### 在 macOS 上打开

安装包使用 ad-hoc 签名，没有 Apple Developer ID 证书，所以 macOS 无法验证开发者，第一次打开会被拦下。放行方式：

1. 把 **AlgoLocal** 拖进「应用程序」并双击，系统提示无法确认它不含恶意软件，点「完成」。
2. 打开 **系统设置 → 隐私与安全性**，下拉到「安全性」，点 AlgoLocal 旁边的 **仍要打开**，用触控 ID 或密码确认。

只需要做一次。macOS Sequoia（15）及以上已经移除了「右键 → 打开」的绕过方式，`xattr -rd com.apple.quarantine` 也既不必要也不管用。

要彻底去掉这个警告需要付费的 Apple Developer ID 证书并做公证。[从源码运行](#从源码运行)则不会遇到。

### 从源码运行

需要 Node.js 18 及以上、npm 8 及以上。

```bash
git clone https://github.com/zxypro1/algolocal.git
cd algolocal
npm install
npm run build
npm start
```

随后访问 http://localhost:3000。`start-local.bat`（Windows）与 `start-local.sh`（macOS、Linux）执行相同步骤，并在首次运行时可选地写入 AI 配置文件。

## 目录

- [快速开始](#快速开始)
- [特性](#特性)
- [两种练习模式](#两种练习模式)
- [语言支持](#语言支持)
- [AI 功能](#ai-功能)
- [使用](#使用)
- [开发](#开发)
- [项目结构](#项目结构)
- [文档](#文档)

## 特性

| 能力 | 说明 |
|---|---|
| 两种练习模式 | 算法题与多关卡工程实战项目 |
| 离线执行 | 代码通过 WebAssembly 在浏览器内运行，无服务端执行 |
| 数据本地 | 题库、草稿与统计均保存在本地 |
| AI 可选 | 题目生成、提示、题解与工程评审，使用你自己配置的服务商 |
| 编辑器 | Monaco，按「题目 + 语言」分别保存草稿 |
| 数据看板 | 按难度与标签的正确率、活跃热力图、最近尝试记录 |
| 平台 | Windows、macOS、Linux |

## 两种练习模式

### 算法题

标准的面试式练习：读题、实现函数、跑测试用例。内置 29 道题，题库可自行扩展。

### 工程实战

一道工程题是一个分关卡构建的小系统，在多文件工作区里完成。跑通只是必要条件，每一关还会度量它的运行表现。

<img alt="工程实战：多文件工作区、隐藏验收用例与工程指标门槛" src="./docs/screenshots/engineering-zh.png" />

| 组成 | 说明 |
|---|---|
| 工作区 | 文件树、多标签编辑器、只读契约文件，文件随关卡解锁 |
| 验收用例 | 隐藏测试用例，在 Web Worker 中执行 |
| 工程门槛 | 对实测指标的断言，例如峰值并发不超过 4、12 个请求 300ms 内完成 |
| 虚拟时钟 | `sleep(200)` 不消耗真实时间，但延迟与并发度仍可精确度量 |
| 评分 | 正确性、并发度、延迟、容错性、封装、优雅程度 |
| AI 评审 | 结合代码、最近一次运行与静态指标，按生产环境 PR 的标准给出评审 |

内置三个项目：

| 项目 | 涉及主题 |
|---|---|
| 高可用抓取管线 | 并发池、指数退避、缓存单飞、取消 |
| 事件驱动的订单流水线 | 事件总线、洋葱中间件、幂等、死信队列 |
| 有韧性的 API 网关 | 令牌桶、熔断器、超时预算 |

工程题也可以由 AI 生成。生成结果会先用其自带的参考实现执行一遍，通过后才入库。出题格式见[工程实战指南](./ENGINEERING-PRACTICE-GUIDE.md)。

## 语言支持

| 语言 | 执行方式 |
|---|---|
| JavaScript | 浏览器原生执行 |
| TypeScript | 先经 TypeScript 编译器转译再执行 |
| Python | Pyodide（编译为 WebAssembly 的 CPython） |

## AI 功能

四个功能共用一份服务商配置。

| 功能 | 说明 |
|---|---|
| 题目生成 | 由一句自然语言描述生成完整题目：题面、测试用例、初始模板、参考解法 |
| 题解生成 | 给出多种解法，附复杂度分析与取舍说明 |
| 聊天助手 | 基于编辑器中当前的代码答疑，不直接给出完整答案 |
| 工程评审 | 从并发安全、失败行为、模块边界与风格评审已完成的关卡 |

支持的服务商：DeepSeek、OpenAI、Claude、Qwen，以及通过 Ollama 运行的本地模型。详见 [AI_PROVIDER_GUIDE.md](./AI_PROVIDER_GUIDE.md)。

## 使用

算法题：

1. 选择题目与语言。
2. 在编辑器中实现解法。
3. 点击「提交并运行测试」，在浏览器内执行测试用例。
4. 查看结果与执行耗时，练习记录会进入数据看板。

工程实战：

1. 打开项目，阅读本关要求。
2. 在工作区中实现本关内容。
3. 点击「运行验收」，执行隐藏用例并评估工程门槛。
4. 查看用例结果、实测指标、评分，以及可选的 AI 评审。通关后解锁下一关。

配置与题库管理：

- AI 服务商在设置页配置（桌面端为应用菜单，浏览器端为 `/settings`）。桌面端配置保存在 `~/.offline-leet-practice/config.json`。
- 添加题目可通过「添加题目」页面、导入 JSON，或直接编辑 `public/problems.json`。详见 [MODIFY-PROBLEMS-GUIDE.md](./MODIFY-PROBLEMS-GUIDE.md)。

## 开发

| 命令 | 用途 |
|---|---|
| `npm run dev` | 开发服务器 |
| `npm run build` | 生产构建 |
| `npm run test:engineering` | 工程运行时与预置题目测试 |
| `npm run test:ai` | 服务商、流式协议与 JSON 解析测试 |
| `npm run test:editor` | 草稿持久化测试 |
| `npm run projects:build` | 把 `projects/definitions` 编译为 `projects.json` |
| `npm run projects:verify` | 用参考实现执行每一关 |
| `npm run dist:mac` / `dist:win` / `dist:linux` / `dist:all` | 桌面端打包，详见 [DESKTOP-APP-GUIDE-zh.md](./DESKTOP-APP-GUIDE-zh.md) |

技术栈：React 18、Next.js 13、TypeScript、Mantine v7、Monaco Editor、Electron。

## 项目结构

```
algolocal/
├── pages/
│   ├── api/                    # 题目、AI 与工程项目接口
│   ├── problems/[id].tsx       # 题目详情，含 AI 聊天与题解
│   ├── projects/               # 工程实战：列表、工作区、生成器
│   ├── generator.tsx           # AI 题目生成器
│   ├── stats.tsx               # 练习数据看板
│   ├── manage.tsx              # 题目管理
│   └── index.tsx               # 题目列表
├── src/
│   ├── components/             # React 组件
│   ├── hooks/                  # WASM 执行器、关卡运行器、AI 配置
│   ├── lib/engineering/        # 虚拟时钟、lab、模块运行时、用例框架、评分
│   ├── lib/server/             # AI 服务商、题库存储、提示词
│   └── workers/                # 关卡运行 Worker
├── projects/definitions/       # 工程实战题目源文件
├── public/
│   ├── problems.json           # 题库
│   └── projects.json           # 工程题库
├── electron-main.js
└── electron-builder.config.js
```

## 文档

| 文档 | 内容 |
|---|---|
| [ENGINEERING-PRACTICE-GUIDE.md](./ENGINEERING-PRACTICE-GUIDE.md) | 工程运行时的原理与出题方式 |
| [AI_PROVIDER_GUIDE.md](./AI_PROVIDER_GUIDE.md) | 服务商配置、模型、故障排查 |
| [MODIFY-PROBLEMS-GUIDE.md](./MODIFY-PROBLEMS-GUIDE.md) | 题目格式与离线编辑 |
| [DESKTOP-APP-GUIDE-zh.md](./DESKTOP-APP-GUIDE-zh.md) | 桌面端构建与打包 |

## 贡献

欢迎参与。最有价值的补充是算法题与工程实战项目；数据分析、界面与文档的改进同样欢迎。

## 许可证

MIT
