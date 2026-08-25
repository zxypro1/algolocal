# 内网设施实战工作台（opslab）设计方案

> 状态：设计已定稿，实施中。
> 最后更新：2026-08-25。技术选型的核实日期与来源见 [opslab-stack.md](./opslab-stack.md)。
>
> 放在 `design/` 而不是 `docs/`：后者是 GitHub Pages 的站点目录，
> `.github/workflows/deploy-pages.yml` 监听 `docs/**`，把内部设计文档放进去会一并发布并触发部署。

## 这是什么

在工程实战里加入一类新形态的项目：**Kubernetes 企业级内网设施搭建**。
它至少需要四块面板：模拟内网机器的终端、IDE、内网设施拓扑图、任务描述。

因此工作台不能再是写死的「任务描述 + IDE」，要能按项目形态组合。

## 判定标准：接口真实，不是实现手写

这是整个方案的地基，先说清楚。

**必须和真集群一致的**：

- 学员敲的命令与参数（`kubectl` / `helm` / `kustomize` / `argocd` / `istioctl` / `crictl` 的真实子命令与 flag）
- 系统给出的输出与报错文本
- 资源的字段与语义、状态流转的因果关系
- YAML 的写法

一句话：**在这里学会的操作，换到真集群上原样能用；这里看到的信息，真集群上也是这么显示的。**

**不必从零手写的**：底层实现。能用现成库就用库，能用行为等价的模拟达到同样的可观察行为就模拟。
没有人需要我们自己写 TLS 握手、Go 模板引擎或 eBPF 虚拟机。

## 核心思路：真 CLI 编译成 WASM

学员真正接触的那一层是 CLI，而 CNCF 的 CLI 几乎全是 Go 写的，Go 能编译成 WebAssembly。

**把真的 `kubectl` / `helm` / `kustomize` / `argocd` / `istioctl` / `cosign` 编成 WASM，
让它们打到我们模拟的 API 上。** 真 kubectl 用 `net/http`，编到 `js/wasm` 后走浏览器 `fetch`，
我们提供一个拦截 fetch 的假传输层，把请求交给内存里的 apiserver。

于是每个 flag、每种 `-o` 输出格式、`--sort-by`、`-o jsonpath`、`kubectl explain`、
客户端 apply 的三方合并、每一条报错文本全是真的。仿一个 `kubectl get` 的列宽，
永远不如让真 kubectl 自己打。

先例：[Helm Playground](https://helm-playground.com/) 就是真 Helm 编成 WASM 在浏览器渲染 chart，
2.3MB gzip，含完整 sprig。

## 四条实现策略

| | 策略 | 保真度 | 代价 |
| --- | --- | --- | --- |
| S1 | 真代码编 WASM | 100%，零仿真误差 | 每个 2–3MB gzip；启动开销；Go 运行时的不确定性要驯服 |
| S2 | 成熟 JS 库 | 高（库本身就是标准实现） | 依赖体积；许可证要核 |
| S3 | 官方数据 + 薄实现 | 字段与报错一致 | 要跟版本 |
| S4 | 行为等价模拟 | 接口一致，内部不一致 | 有分叉点，必须逐条写明 |

## 分层架构

```
L3 生态层   argocd / istiod / kyverno / prometheus / envoy-gateway / cilium / rollouts
            —— 全部作为普通 Deployment 跑在 L2 上，宿主不特判
                          ↓ 只能通过 watch / list / apply 访问
L2 集群层   etcd 语义存储 · 请求链路（认证→授权→准入→schema/SSA）
            控制器框架（informer/workqueue） · 内置控制器 + kubelet
L1 机器层   VFS / 进程 / 信号 · POSIX shell · TCP/DNS/iptables · OCI 镜像 / 容器进程运行时
L0 内核     虚拟时钟 · 确定性并发调度器 · 种子 RNG · 结构共享快照
```

**关键约束：L3 只能通过 API 访问 L2。** Argo CD 不是宿主里的一个特判分支，
它是跑在容器里、通过 watch 感知变化、通过 apply 写回的普通控制器。
加一个新生态组件 = 注册 CRD + 写一个控制器，和在真集群里做的事一样。

这么做换来的是：控制器不需要「表现得像」真控制器，它就是按真控制器的写法写的，
于是竞态、`observedGeneration` 落后一拍、finalizer 卡住删除这些行为自然就对。

**L0 是最难的部分。** 几十个并发实体跑在一个虚拟时钟上还要完全确定，
否则重放与反向验证都不成立。这是分布式领域成熟的 deterministic simulation testing 技法
（FoundationDB → TigerBeetle / Antithesis）。现有的 `driveVirtualClock` 是单任务驱动，扛不住，
要重写，且必须第一期就写对。

## 组件路由表

原则是**可观察行为一致**。最后一列写明每一处模拟在什么场景下学员会察觉。

| 组件 | | 怎么做 | 学员会在哪察觉 |
| --- | --- | --- | --- |
| kubectl 全部子命令 | S1 | 真 kubectl 编 WASM | **察觉不到** |
| apiserver 对象语义 | S3 | 自己实现 REST + 存储 + watch；校验用官方 JSON Schema + ajv；`resourceVersion`、finalizer、ownerRef、级联删除、SSA 字段所有权都真做 | 冷门准入插件、审计日志格式、APF 不做 |
| 控制器与状态流转 | S3 | 按真控制器结构写；生命周期转换借鉴 [KWOK](https://kwok.sigs.k8s.io/) 的声明式 Stage 模型 | 转换耗时是参数化的 |
| Helm 渲染 | S1 | 真 helm 编 WASM | **察觉不到** |
| Kustomize | S1 | 真 kustomize 编 WASM | **察觉不到** |
| git 与 GitOps | S2 | `isomorphic-git`；Argo CD 的 reconcile / drift / sync 我们写，CLI 用真的 | 没有真远端服务器与 SSH 传输 |
| YAML | S2 | `yaml`@2（ISC），YAML 1.2 | **察觉不到**；顺带修掉 Norway problem |
| 证书 / PKI | S2 | `@peculiar/x509` + WebCrypto：真密钥、真签名、真链验证 | `openssl` 只做常用子命令 |
| TLS | S4 | 不做握手协议。做证书校验与错误映射：过期 / SAN 不符 / 链断 → 真 X.509 验证器判定 → 输出 `curl` 的真实报错原文 | 抓不到 TLS 记录层字节；不做 cipher 协商。**靠报错和失败时机学习的场景全部一致** |
| TCP / 网络 | S4 | 连接结果语义（refused / timeout / reset / no route）、DNS 解析链与 `ndots:5`、Service 与 NetworkPolicy 转发判定 | 没有拥塞控制与重传；性能压测类结论不可迁移 |
| Cilium / eBPF | S4 | **不做 eBPF 虚拟机**。做策略语义：NetworkPolicy / CNP 含 L7 与 FQDN 的放行判定、identity、`cilium monitor` 与 Hubble 流日志的真实输出 | 写不了自定义 eBPF 程序 |
| Istio ambient | S4 | 不做 HBONE 字节流。做可观察面：`istioctl proxy-status` / `x describe` / `analyze` 的真实输出、mTLS 状态、SPIFFE 身份（真证书）、授权判定与命中的策略名 | 抓不到 HTTP/2 CONNECT 帧。**「谁用什么身份访问谁、被哪条策略放行」全部一致** |
| 容器进程 | S4 | 沙箱里跑真进程（TS + `@container/os`）：真退出码、真日志、真监听端口、真信号处理 | 跑不了任意 ELF 二进制 |
| 镜像与 registry | S2+S4 | `dockerfile-ast` 解析，build 出真分层与摘要；registry 做 API 语义 | 产物不能被真 docker 导入 |
| cgroup / QoS | S4 | 内存超限真触发 OOMKill 并写 Event、CPU 限流真的让虚拟耗时变长、驱逐顺序真做 | 「打爆内存」是进程声明的分配量超过 limit |
| shell | S1+S3 | `sh-syntax`（mvdan/sh 的 WASM）解析；执行器、内置命令与 coreutils 我们写 | coreutils 只覆盖常用 flag |
| Prometheus | S2+S3 | 官方 `lezer-promql` 解析，求值器我们写；scrape、规则求值、告警状态机真做 | 复杂子查询与少数函数遇到会明确报「未实现」 |
| Kyverno / VAP | S2+S3 | `@marcbachmann/cel-js` 求值 CEL；策略匹配与拒绝消息我们写 | 高级 `foreach` 嵌套按需补 |
| 拓扑图 | S2 | `@xyflow/react` 渲染与交互；**坐标自己算**（区域固定泳道、节点内网格）保证稳定 | 不适用 |

**所有 S4 项的共同分叉点是同一个：协议字节层不可见。** 对「搭内网基础设施」这个教学目标，
这条分叉线在教学路径之外。

### 容器路线：沙箱进程，不跑真内核

浏览器里跑真 Linux 容器**技术上可行**（`container2wasm` 用 Bochs/TinyEMU 编成 WASM，
启动真内核再用 runc 起容器；CheerpX/WebVM 用 x86→WASM JIT）。这不是物理限制。

但它与三条地基冲突：虚拟时钟（指令级模拟慢一到两个数量级，「快进 60 秒」变成真的等）、
确定性重放（没有现成快照机制）、离线体积（每 pod 一个内核）。
另外 CheerpX 的许可证禁止组织使用与再分发，对 MIT 自托管的本项目直接出局。

按「操作与信息和现实一致」这条标准逐个通道推演，沙箱进程全部能对上（logs / exec / describe /
生命周期 / 优雅终止），唯一做不到的是「跑预编译的第三方二进制」，而没有任何一关需要它。
**结论：路线 A（沙箱进程），真内核方案撤销。**

## 判定与「信息一致」的保证

三个证据来源，全部由平台记录，学员改不了：

1. **终态** —— 重放命令、时钟收敛后的对象图
2. **行为探测** —— 平台自己跑的命令与请求
3. **过程指标** —— 模拟器记的计数器，喂给现有的 `MetricGate`

ops 关卡最终仍然产出一个 `StageRunReport`，结果面板、计分卡、AI 评审、进度存档全部复用。
隐藏用例仍是在同一个模块运行时里执行的 TS，多一个内建模块 `@ops/lab`。

反向验证不变：参考 manifest + 参考命令重放必须全绿，只有起始状态必须挂，`projects:verify` 进 CI。

### golden 输出录制

「输出和报错必须和真集群一样」需要一把可验证的尺子：

1. 作者在本地真集群上跑一遍这一关的参考命令
2. 录制脚本把每条命令的 stdout / stderr / 退出码存成 golden fixture，连同集群版本入库
3. 模拟器跑同一串命令，输出与 golden 逐字节 diff（时间戳、UID、随机后缀走归一化）
4. 差异条数进 CI 报告

**只在出题期需要真集群**，学员端和日常回归 CI 只重放已提交的 fixture。
只有钉住的 k8s 版本升级时才需要重录（手动或定时任务，跑在 Linux runner 上）。

需要活集群的范围比想象中窄：

- 走 S1 的真 CLI 输出 —— **不需要 golden**，它就是真的
- 纯客户端命令（`helm template`、`kustomize build`、`kubectl explain`、`--dry-run=client`）—— 不需要集群
- **服务端生成的文本**（apiserver 校验与准入拒绝、SSA 冲突、RBAC 拒绝、控制器与 kubelet 写的 Event、
  conditions 的 reason/message）—— 这才是 golden 的真正目标

免掉本地 Docker 的办法：

| 方式 | 覆盖 | 依赖 |
| --- | --- | --- |
| **envtest**（`setup-envtest`） | 真 kube-apiserver + etcd 二进制直接跑，无 Docker、无 kubelet。覆盖校验报错、准入、RBAC、SSA 冲突、defaulting、`explain` —— golden 的大头 | 两个下载的二进制；macOS 可用 |
| **kwokctl `--runtime=binary`** | 真 apiserver + etcd + kwok 假 kubelet，Pod 会真进 Running，补上生命周期 Event | 二进制下载只支持 Linux（darwin arm64 见 kwok#591），要放 Linux CI |
| **GitHub Actions 录制** | ubuntu runner 自带 Docker，`workflow_dispatch` 触发「录制第 N 关」 | 作者本地零依赖 |

推荐组合：本地 envtest 覆盖大头 + CI 上的 kwokctl / kind 覆盖 Pod 生命周期那一小部分。

顺带的对称性：kwokctl 的 binary runtime 就是「真 apiserver + 假 kubelet」，
正是我们要建的东西的参考实现。

## 内容大纲

场景：一家中型公司在自建机房上做内部平台。区域为 `office` / `dmz` / `app`（3 节点）/
`data` / `mgmt`（跳板机、Harbor、Git、OpenBao、监控）/ `internet`（基本全封）。

| # | 主题 | 判定重点 | 期 |
| --- | --- | --- | --- |
| 01 | 接手集群 —— kubeconfig / context / 跳板机可达性 | `get nodes` 三台 Ready；apiserver 未暴露到办公网 | 一 |
| 02 | 第一个工作负载 —— Deployment + Service（手工 apply，为第 12 关埋线） | 3 副本 Ready；按 service 名 curl 得 200；埋坑：selector 与 labels 不一致 | 一 |
| 03 | 把应用容器化 —— 写 Dockerfile、build、推 Harbor | 真 build 出分层镜像、摘要正确、非 root、不把密钥打进层 | 一 |
| 04 | 私有镜像仓库与拉取凭据 | ImagePullBackOff 归零；凭据不明文进 manifest | 一 |
| 05 | 配置与机密 —— ConfigMap / Secret | 配置正确注入、改配置触发滚动更新、Secret 未进 ConfigMap | 一 |
| 06 | 探针、优雅终止与自愈 —— 亲手写正确处理 SIGTERM 的容器 | 滚动更新期间零失败**且零 TCP RST**；readiness 在退出前先摘流量 | 一 |
| 07 | 资源、QoS 与驱逐 | 真打爆内存看 OOMKill；CPU 限流真的让 P99 变差；BestEffort 先被驱逐 | 一 |
| 08 | 从 Ingress 迁到 Gateway API —— 老门户跑在已退役的 ingress-nginx 上 | office 可达、internet 不可达、路由正确；旧控制器彻底下线 | 二 |
| 09 | 证书与 PKI —— 内网 CA、Gateway TLS、BackendTLSPolicy | 真链验证通过、SAN 匹配、有效期充足；埋坑：中间证书没带全 | 二 |
| 10 | 零信任网络 —— NetworkPolicy + CiliumNetworkPolicy L7 | 允许路径通、禁止路径超时、**没把 DNS 一起切断** | 二 |
| 11 | 用 CNP + Hubble 排查一次被误封的服务调用 | 从流日志定位到命中的策略，改对后放行 | 二 |
| 12 | 从手工到 GitOps —— Argo CD、App-of-Apps、亲手制造配置漂移 | 全部 Synced + Healthy；手工改集群后被自动纠正；**此后判定看 Git 仓库** | 二 |
| 13 | 自己写 Helm chart —— 模板、values、依赖、hooks、升级回滚 | 渲染结果正确；`--set` 与 `toYaml/nindent` 用对；升级可回滚 | 二 |
| 14 | 多环境 —— base + overlay、Helm 装第三方组件、ResourceQuota | 三套环境从同一 base 派生、差异只在 overlay；配额生效 | 二 |
| 15 | 身份与 RBAC —— OIDC、Role/Binding、ServiceAccount | `auth can-i` 矩阵；dev 对 prod 只读；无人用 cluster-admin 跑日常 | 三 |
| 16 | 服务网格：ambient 与 mTLS —— ztunnel、SPIFFE 身份 | 服务间真的走 mTLS 且双向验证；明文直连被拒；PeerAuthentication STRICT 生效 | 三 |
| 17 | 网格 L7：waypoint 与授权策略 —— 重试、熔断、L7 授权 | AuthorizationPolicy 按方法与路径生效；熔断在下游变慢时打开 | 三 |
| 18 | 策略即代码 —— PSA restricted + Kyverno + cosign 验签 | 违规 manifest 在准入被拒且报错可读；未签名镜像进不来 | 三 |
| 19 | 可观测性 —— OTel Collector、Prometheus、真 PromQL 告警规则 | 采集覆盖所有节点（含带污点的）；注入故障后告警真的按 PromQL 求值触发 | 三 |
| 20 | 渐进式发布与节点维护 —— Argo Rollouts 金丝雀 + cordon/drain/PDB | 坏版本自动回滚；全程零失败；PDB 未被违反；未强制 drain | 三 |
| 21 | 灾难恢复 —— Velero + CSI 快照 | 恢复后服务全 Ready、PVC 数据校验和一致 | 四 |
| 22 | 私有 IaaS 与弹性 —— Karpenter provider、Crossplane、Cluster API | 负载压上来真的有新节点加入；空闲后回收 | 四 |
| 23 | 写一个 Operator —— CRD + reconcile（两种工作台在此合流） | 沿用现有代码运行时的用例与门槛 | 四 |

## 规模与分期

约 **55,000 行 TypeScript**（不含关卡内容）。单人纯开发 8–12 个月，含内容约 1–1.3 人年；
三人并行约 5–6 个月。

| 层 | 全手写估算 | 用库后 | 怎么省下来的 |
| --- | --- | --- | --- |
| L0 确定性内核 | 2,000 | 2,000 | 不变 |
| 主机与 shell | 16,000 | 6,000 | `sh-syntax` 出语法树，只写执行器与 coreutils |
| 网络 | 21,500 | 5,000 | 砍掉 TCP 状态机、TLS 握手、HTTP/2 帧、eBPF VM |
| 密码学 | 3,500 | 800 | `@peculiar/x509` + WebCrypto |
| 容器与镜像 | 8,500 | 3,500 | `dockerfile-ast` + `tar-stream` |
| apiserver 与控制器 | 28,500 | 14,000 | 校验交给 ajv + 官方 schema；生命周期借鉴 KWOK |
| Go CLI → WASM 管线 | — | 6,000 | 新增：构建流水线、fetch 传输层、确定性驯服、懒加载 |
| 生态组件 | 55,800 | 12,000 | 真 CLI + 现成库，只写控制器与状态 |
| UI | 8,000 | 6,500 | `@xyflow/react` + `monaco-yaml` |
| 平台集成 | 3,000 | 3,000 | 不变 |
| golden 录制与回归 | 4,000 | 2,500 | 录制脚本 + 归一化 + diff |
| **合计** | **145,000** | **≈ 55,000** | 约为原估的 38% |

### 三段节奏

**第一段（已完成）· 零回归的工作区可组合化重构**
引入 `workspace.kind`，把写死的布局改成可组合。不含任何 K8s 内容，独立可合并。

**第二段 · Spike（3–4 周，不进主干）**

- **Go CLI → WASM 打通**：真 kubectl 编成 wasm，通过假 fetch 传输层打到一个只有三个 GVK
  的最小 apiserver，跑通 `get` / `describe` / `apply` / `-o yaml`。**这是整个方案的命门。**
- **确定性验证**：同一串命令跑一千次，输出逐字节一致（重点查 Go 的 map 迭代顺序）
- xterm.js 在 `next dev` / `next build` / `electron-builder` 三处跑通
- golden 录制脚本原型
- 产出：可行性结论 + 体积数字 + 一个能敲 `kubectl get pods` 的可玩 demo

**第三段 · 第一期完整实现（3–4 个月）**
L0 内核、shell、容器进程运行时、镜像与 registry、apiserver 与核心控制器、
真 kubectl 接入、四块面板、`@ops/lab` 判定、golden 回归进 CI、内容第 1–7 关。

后续第二/三/四期按上表的「期」列推进。

### 风险点

| 风险 | 缓解 |
| --- | --- |
| **Go WASM 的不确定性**（map 迭代随机化、goroutine 调度、时间） | 第二段头等任务；千次运行逐字节一致进 CI；必要时注入固定种子与假时钟；驯不服的 CLI 退回 S3 |
| **确定性并发调度器做不对** —— 一错，重放、反向验证、进度恢复全塌 | 第二段就验证；参考 FoundationDB / TigerBeetle 的成熟做法 |
| WASM 制品体积（6–8 个 CLI × 2–3MB gzip） | 按关卡懒加载、`idb-keyval` / Electron 磁盘缓存 |
| 新增 Go 构建链 | 制品预构建后入库或挂 release，日常开发不需要装 Go；CI 单独一条 job |
| 上游版本漂移（k8s 每年三个版本） | 选型与版本集中在 [opslab-stack.md](./opslab-stack.md)；schema 按版本取；CLI 制品钉版本号 |
| 出题成本 | 共享 `world-presets.js` 描述这家公司的内网，每关只写增量 |
| AI 生成这类项目 | 前三期明确不支持，生成器继续只产 `kind: 'code'` |

## 已定的设计决策

| 决策 | 结论 |
| --- | --- |
| 工作台抽象 | 项目定义加可选 `workspace.kind`，不做布局 DSL；缺省即现状 |
| 面板通信 | 单一数据源、单向数据流，不做面板间消息 |
| 架构 | 真 apiserver 对象模型 + 控制器循环；生态组件作为工作负载 |
| 容器 | 路线 A（沙箱真进程）；真 Linux 内核方案撤销 |
| eBPF | 不做虚拟机；第 11 关改为用 CNP + Hubble 排查 |
| Helm | 真 helm 编 WASM，学员能自己写 chart |
| 服务网格 | 做身份与策略面，不做数据面字节 |
| YAML | `yaml`@2（YAML 1.2）；现有 `js-yaml`@3.14 是 1.1，必须升 |
| 拓扑渲染 | `@xyflow/react` 渲染 + 自算坐标；`elkjs` 因许可证与布局不稳排除 |
| 拓扑交互 | 只读检查 + 点击插入命令，不做拖拽改状态 |
| 事件溯源 | 降级为快照优先（`immutable` 结构共享）；命令日志只做审计与时间轴回放 |
| 「执行轨迹」面板 | 换成「事件与变更流」：按虚拟时间排的集群 Event + 每条命令的变更集 |
| 评审维度 | `DimensionKey` 新增 `security` / `observability` / `deliverability`；ops 项目不给 `concurrency` 与 `encapsulation`（靠 `measured: false` 自动排除） |
| 正确性标尺 | golden 输出为主；上游 conformance 子集为加分项 |
| 代码位置 | 先放仓库内 `src/lib/opslab/`，接口按「将来能独立」设计 |
| Go 构建链 | 采纳 |
