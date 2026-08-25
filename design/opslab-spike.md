# opslab 第二段 · Spike 结论

> 日期：2026-08-25 · 分支 `spike/opslab-kubectl-wasm`
> 目的：验证 [opslab.md](./opslab.md) 里「真 CLI 编 WASM」这条命门路线是否成立。

## 一句话结论

**成立，可以按原方案往下做。** 真 kubectl 编译成 WebAssembly 之后，
在浏览器里跑起来、打到内存里的 apiserver、输出与真集群逐字节一致，
并且一千次重放完全确定。代价比原估的大（下载 11MB 而不是 2–3MB），但在可接受范围内。

过程中发现一个**会致命的内存泄漏**（每条命令泄漏 68MB，约 150 条后标签页 OOM），已定位并修掉。

---

## 一、真 kubectl 能不能编成 WASM

**能，需要 6 处补丁。** 全部是同一个成因：上游用 `//go:build !windows` 表示「类 Unix」，
而 js/wasm 也满足 `!windows`，于是浏览器里不存在的东西被编了进来。

| 包 | 问题 | 补丁 |
| --- | --- | --- |
| `github.com/moby/term` | 终端 ioctl（`unix.Termios` / `TIOCGWINSZ`） | 排除 js + 一份空操作实现 |
| `k8s.io/kubectl/pkg/util/interrupt` | `syscall.SIGHUP` / `SIGQUIT` 不存在 | 拆出平台信号列表，js 只留 `os.Interrupt` |
| `k8s.io/kubectl/pkg/util` | `unix.Umask` | js 版返回 0 |
| `k8s.io/kubectl/pkg/util/term` | `unix.SIGWINCH` | js 版直接关掉 resize channel |
| `k8s.io/kubectl/pkg/cmd` | `syscall.Exec`（插件） | js 版明确报「不支持插件」 |
| `k8s.io/client-go/transport` | 浏览器里没有 socket | 换成走 `globalThis.fetch` 的 RoundTripper |

补丁全部脚本化在 `scripts/opslab-wasm-patches.sh`，
构建入口 `scripts/build-opslab-wasm.sh`（已验证可从零复现）。

**最后一条不只是补丁，是架构接缝**：client-go 在 js 上统一走宿主的 `fetch`，
我们把 `fetch` 指向内存里的 apiserver，真 kubectl 就把我们当成了一个集群。

---

## 二、体积：比原估大，但多 CLI 能摊薄

| 制品 | 原始 | gzip | brotli |
| --- | ---: | ---: | ---: |
| client-go 最小程序（无任何 kubectl 命令） | 51.3 MB | — | **5.51 MB** |
| kubectl 全量 | 116.0 MB | 18.8 MB | **11.11 MB** |
| kubectl + helm（同一个二进制） | 122.4 MB | — | **12.23 MB** |

三个数字说明了全部问题：

1. **client-go 是 5.5MB 的地板**，任何用它的 CLI 都躲不掉 —— 所以裁剪子命令省不了多少。
2. **原估的 2–3MB 是错的**，那个数字来自 Helm Playground，而 helm 比 kubectl 小得多。
3. **但多个 CLI 编进同一个二进制几乎完全摊薄**：加上 helm 只多了 1.12MB brotli，
   而单独编 helm 要再付一次 5.5MB 的地板。

**推论**：不要每个 CLI 一个 wasm，要做 **busybox 式的多合一二进制**。
按这个趋势，kubectl + helm + kustomize（kubectl 已自带）+ argocd + istioctl + cosign
估计落在 **15–18 MB brotli / 约 150 MB 原始**，而不是原方案担心的 40–80MB。

`-ldflags="-s -w" -trimpath` 只省了 5%（121.8 → 116.0MB），不是重点。

---

## 三、性能与内存

| 指标 | 数值 |
| --- | ---: |
| `WebAssembly.compile`（一次，可缓存复用） | 74–93 ms |
| `WebAssembly.instantiate`（每条命令） | 8–13 ms |
| 单条命令执行 | 46–170 ms |
| **浏览器里第一条命令**（含下载 + 编译） | **1414 ms** |
| **浏览器里后续每条命令** | **74 ms** |
| 每个实例的线性内存 | 68 MB（命令结束即释放） |
| 编译后模块常驻 | 约 127 MB |

**手感没问题**：冷启动一秒多，之后每条几十毫秒，和敲真 kubectl 差不多。

### 发现并修掉一个致命泄漏

第一次跑 1000 次重放时进程在约 150 次被 **SIGKILL（OOM）**。测下来 `external` 内存
每条命令稳定涨 **67.5 MB**，一路涨到 8GB。

成因：Go 退出后 wasm_exec 还留着一个排队的调度器 `setTimeout`，
那个闭包抓着 `go`，`go` 抓着实例，实例抓着 68MB 线性内存。
我原本写了清理，但 `_scheduledTimeouts` 是 **Map**，而我用 `Object.values()` 取值 ——
对 Map 恒返回空数组，等于一个都没清。

修好之后 `external` 从 8104 MB 降到稳定 **4 MB**，RSS 平在 440–470MB 不再增长。

> 这条值得写进实现规范：**每次运行结束必须显式断开 `go._inst` / `go.mem` /
> `_values` / `_goRefCounts` 并清空 `_scheduledTimeouts`（按 Map 遍历）。**

---

## 四、确定性

**1000 次重放，transcript 逐字节完全一致（1 个哈希，`04efa762f9989ba6`，2470 字节）。**

场景覆盖 11 条命令，含 `get` / `-o wide` / `-o name` / `-o yaml` / `-o jsonpath` /
`custom-columns` / `--sort-by` / `apply` / `api-resources` / NotFound 错误路径。

原本最担心的 **Go map 迭代随机化没有造成问题** —— kubectl 的输出路径基本都显式排序过
（discovery 排序、YAML 序列化排序、表格按我们 apiserver 返回的顺序）。
我们这边的对应责任是：**apiserver 的 list 必须按名字稳定排序**，spike 里已经这么做了。

---

## 五、保真度：输出确实和真集群一样

```
$ kubectl get pods
NAME               READY   STATUS    RESTARTS   AGE
payments-7f4-2xk   1/1     Running   0          4h12m
portal-6c9-abc     1/1     Running   2          4h12m

$ kubectl get pods -o wide
NAME               READY   STATUS    RESTARTS   AGE     IP          NODE     NOMINATED NODE   READINESS GATES
payments-7f4-2xk   1/1     Running   0          4h12m   10.42.1.7   node-1   <none>           <none>

$ kubectl apply -f /root/infra/ledger.yaml --validate=false
deployment.apps/ledger created

$ kubectl get pod nope
Error from server (NotFound): pods "nope" not found
```

`-o yaml` 里连 `kubectl.kubernetes.io/last-applied-configuration` 都是真 kubectl 的 apply
逻辑自己写进去的 —— 三方合并的记账我们白拿。

### 两个必须自己实现对的地方

1. **服务端表格渲染**。`kubectl get` 的默认表格是 apiserver 渲染的
   （`Accept: application/json;as=Table;g=meta.k8s.io`）。不实现的话 kubectl 会退化成
   通用打印，只剩 NAME/AGE 两列。列定义要照抄 k8s 的 printers，
   `priority: 1` 的列只在 `-o wide` 显示。
2. **AGE 由服务端算**。真集群也是这样。这一点正好接上虚拟时钟 ——
   spike 里 `now()` 是注入的，所以快进时间时 AGE 会跟着动。

### 一个已知缺口

`kubectl apply` 的**客户端校验**还没通：kubectl 先取 `/openapi/v3`，
拿不到可用 schema 就退回 `/openapi/v2`（protobuf），于是报
`proto: cannot parse invalid wire-format data`。

我手搓的 v3 文档被 kubectl 拒绝了。**这不是路线问题** ——
方案本来就要内置官方 OpenAPI（`yannh/kubernetes-json-schema` / `kubectl-validate`），
手搓一个假的本来就不该指望它过。spike 用 `--validate=false` 绕过，
写入路径本身完全正常。第三段接入官方 schema 时一并解决。

---

## 六、xterm.js 三处都跑通

| 环境 | 结果 |
| --- | --- |
| `next dev` | ✅ 终端挂载正常（40 行），命令链路通 |
| `next build` | ✅ 编译通过，`/opslab-spike` 首屏 10.7 kB / 168 kB（xterm 懒加载，不进主包） |
| `electron-builder --dir` | ✅ 打包成功，xterm 与 `public/opslab/kubectl.wasm` 都在 asar 里 |

Electron 是在进程内跑一个真的 Next server 再 `loadURL`，所以 wasm 的加载路径和 Web 完全一致。

**打包上发现一处要改**：115MB 的 wasm 留在 asar 里，`WebAssembly.compileStreaming`
读不到真实文件，只能整份读进内存再编译。已在 `electron-builder.config.js` 的
`asarUnpack` 里加上 `public/opslab/*.wasm`。

桌面端体积代价：asar 未压缩 +115MB（安装包压缩后约 +19MB）。

---

## 七、golden 录制

`setup-envtest` 在 macOS 上可用，`list` 能列出 **v1.36.2 / v1.36.0 darwin/arm64** 的
apiserver + etcd 二进制 —— 即**作者本机录 golden 不需要 Docker**，与设计文档一致。
完整录制脚本留到第三段（那时才有真正需要对比的服务端文本）。

---

## 八、对设计的修订

| 原方案 | 修订 |
| --- | --- |
| 每个 CLI 一个 wasm，每个 2–3MB gzip | **一个多合一二进制**，总计约 15–18MB brotli |
| Go→WASM 管线约 6,000 行 | 不变，但要加上「实例生命周期管理」这一节（泄漏那条） |
| 体积预算「< 8MB 增量」 | 上调到 **约 20MB（brotli）**；桌面端 +115MB 未压缩 |
| conformance 作为正确性标尺 | 不变（加分项）；**服务端表格列定义**成为第三段的明确工作项 |

其余不变：分层架构、确定性内核、快照优先、golden 输出、容器路线 A。

---

## 九、产物

| 文件 | 说明 |
| --- | --- |
| `scripts/build-opslab-wasm.sh` | 从零构建 kubectl.wasm（已验证可复现） |
| `scripts/opslab-wasm-patches.sh` | 6 处 js/wasm 补丁，脚本化可重放 |
| `src/lib/opslab/vfs.ts` | Go wasm 的内存文件系统（kubectl 眼里的机器磁盘） |
| `src/lib/opslab/miniApiServer.ts` | 三个 GVK 的 apiserver，含服务端表格渲染 |
| `src/lib/opslab/kubectlWasm.ts` | 浏览器侧运行器（模块缓存、fetch 注入、实例回收） |
| `src/components/opslab/OpsTerminal.tsx` | xterm 终端组件 |
| `pages/opslab-spike.tsx` | 可玩 demo（`/opslab-spike`） |

**这些是 spike 代码，第三段会大幅重写**；留在仓库里是为了让结论可复核，
以及给第三段一个能跑的起点。

### 怎么自己跑一遍

```bash
bash scripts/build-opslab-wasm.sh   # 需要 Go；产出 public/opslab/kubectl.wasm（约 115MB，已 gitignore）
npm run dev                         # 打开 /opslab-spike
```
