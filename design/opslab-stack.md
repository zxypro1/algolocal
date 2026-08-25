# opslab 技术选型清单

> 这个领域一年就能翻篇。选型集中在这一个文件，各关的 primer 从它取值，
> 每个发布周期复核一次这里就够，不必在几万行双语文案里找哪里写了过时的东西。
>
> **上次核实：2026-08-25**（npm 版本与许可证从 registry 直查；k8s 生态状态经联网核实）

## 复核清单

复核时逐条确认三件事：**这个项目还活着吗** / **版本变了吗** / **有没有被更新的方案取代**。
改动后更新本文件的「上次核实」日期与对应行。

---

## 一、教学内容的技术栈

学员在关卡里会见到、会敲、会写的东西。选型要贴近大型互联网企业 2026 年的真实用法。

| 领域 | 选型 | 版本 / 状态 | 依据与来源 |
| --- | --- | --- | --- |
| 集群基线 | Kubernetes **1.36**「Haru」+ containerd 2.x + `crictl` | 1.36 于 2026-04-22 发布 | 1.35 是最后一个支持 containerd 1.x 的版本，所以节点排障用 `crictl` 而非 `docker`。<https://kubernetes.io/releases/1.36/> |
| 南北向流量 | **Gateway API v1.4 + Envoy Gateway**；Ingress 仅作待迁移遗留物 | Gateway API v1.4 于 2025-10-06 发布 | **ingress-nginx 已于 2026-03-24 退役、仓库归档**；Ingress API 功能冻结；v1.4 Standard 通道已含 Gateway / HTTPRoute / GRPCRoute / BackendTLSPolicy。<https://opensource.googleblog.com/2026/02/the-end-of-an-era-transitioning-away-from-ingress-nginx.html> · <https://www.kubernetes.io/blog/2025/11/06/gateway-api-v1-4/> |
| CNI 与网络策略 | **Cilium** + NetworkPolicy / CiliumNetworkPolicy（L7、FQDN）+ Hubble | CNCF 2023 年底毕业 | GKE Dataplane V2、Azure CNI powered by Cilium 都基于它；2026 年新建集群 eBPF 是默认数据面 |
| 服务网格 | **Istio ambient**（istiod + ztunnel + waypoint） | 2026 年生产就绪 | 被预测年底占 Istio 新装机 50%+。Linkerd 因 2024 年 Buoyant 改协议引发治理争议、被 CNCF 移回孵化，不作首选 |
| 交付 | **Argo CD** + **Kustomize** + **Helm 4** | Argo CD 2022-12 毕业；Helm v4.1.4 于 2026-04-09 发布 | 2025 CNCF 调查：60% 的集群在用 Argo CD、97% 受访者跑生产；GitOps 采用率 91%；Helm 采用率 81% |
| 渐进式发布 | **Argo Rollouts** 金丝雀 + 分析模板 | 与 Argo CD 同批毕业 | 流量权重下发到 Gateway API 与网格 |
| 策略 | **PSA**（baseline/restricted）+ **Kyverno** + **VAP/CEL** | Kyverno 2024-11 CNCF 毕业 | PSP 在 1.25 已移除；多份 2026 调查显示 Kyverno 采用率已超 OPA Gatekeeper；MutatingAdmissionPolicy 在 1.36 转 GA |
| 供应链 | **Sigstore cosign** + SBOM，准入时 Kyverno 验签 | — | 2026 年公认组合；SLSA 提供构建来源等级 |
| 机密 | **External Secrets Operator** + **OpenBao** | — | ESO 是对接外部密钥库的标准；OpenBao 是 Vault 改 BUSL 后的开源 fork，对「内网自建」比商业 Vault 更贴切 |
| 可观测性 | **OpenTelemetry Collector** + **Prometheus** + **Loki** | — | OTel 是 CNCF 第二高速度项目、24000+ 贡献者；Prometheus 采用率 77% |
| 弹性 | HPA + **KEDA** + 拓扑分布约束 + PDB；**Karpenter**（第四期） | KEDA 已毕业；Karpenter 2023 年捐给 CNCF，**至今仍是 Sandbox** | HPA 缩容到零在 1.36 转 GA。Karpenter 需要一个 IaaS 层才有意义 |
| 备份 | **Velero** + CSI 快照 | — | k8s 备份恢复事实标准 |

### 明确不教

| 放弃 | 理由 |
| --- | --- |
| 直接编写 Envoy xDS / lua filter | 我们实现的是 Istio 暴露的语义，不是 Envoy 的全部配置面 |
| 阅读 Cilium 的 eBPF C 源码 / 自己写 eBPF 程序 | 不做 eBPF 虚拟机；教学重心放在策略与 Hubble 排查 |

---

## 二、实现依赖

许可证判断标准：**兼容 MIT 自托管、仍在维护、浏览器与 Electron 两端都能跑**。

### JS 依赖（npm registry 直查，2026-08-25）

| 用途 | 包 | 版本 | 许可证 | 最后发布 | 判断 |
| --- | --- | --- | --- | --- | --- |
| 终端 | `@xterm/xterm` + `addon-fit` / `-search` / `-web-links` | 6.0.0 | MIT | 2025-12-22 | ✓ 采用 |
| YAML 1.2 | `yaml`（eemeli） | 2.9.0 | ISC | 2026-05-11 | ✓ 采用（保注释与格式，适合 IDE 联动） |
| YAML 备选 | `js-yaml` | 5.4.0 | MIT | 2026-08-25 | ◐ 也可；4.x 起即 YAML 1.2。**仓库现有的 3.14 是 1.1，必须升** |
| manifest 校验 | `ajv` + `ajv-formats` + [yannh/kubernetes-json-schema](https://github.com/yannh/kubernetes-json-schema) | 8.20.0 | MIT | 2026-04-24 | ✓ 采用；schema 从 k8s 官方 OpenAPI 生成，`kubeconform` 用的就是它 |
| k8s 类型 | `kubernetes-models` | 5.1.0 | MIT | 2026-05-12 | ✓ 采用（从官方 OpenAPI 生成的 TS 模型） |
| git | `isomorphic-git` | 1.41.9 | MIT | 2026-08-23 | ✓ 采用 —— 真 git 语义 |
| 证书 | `@peculiar/x509` + WebCrypto | 2.0.0 | MIT | 2026-03-23 | ✓ 采用 —— 真 X.509 生成与链验证 |
| CEL | `@marcbachmann/cel-js` | 8.0.0 | MIT | 2026-07-07 | ✓ 采用（零依赖，原 `cel-js` 作者推荐的接班实现）；不够就退到 cel-go WASM |
| PromQL 语法 | `@prometheus-io/lezer-promql` | 0.314.0 | Apache-2.0 | 2026-08-17 | ✓ 采用 —— **Prometheus 官方 UI 自己用的语法包**，求值器我们写 |
| shell 语法 | `sh-syntax` | 0.6.0 | MIT | 2026-07-08 | ✓ 采用 —— **mvdan/sh 编译的 WASM**，即 shfmt 的解析器 |
| Dockerfile | `dockerfile-ast` | 0.7.1 | MIT | 2025-07-21 | ✓ 采用（Red Hat 的 Dockerfile 语言服务器在用） |
| 拓扑渲染 | `@xyflow/react` | 12.11.3 | MIT | 2026-08-12 | ✓ 采用渲染与交互，**布局自己算**以保证稳定 |
| 拓扑布局备选 | `elkjs` | 0.12.0 | **EPL-2.0 OR GPL-3.0** | 2026-07-17 | ✗ **不用** —— 唯一非宽松许可证；且自动布局不稳定，与「变化可见」冲突 |
| JSONPath | `jsonpath-plus` | 10.4.0 | MIT | 2026-02-16 | ◐ 备用（真 kubectl 自带 jsonpath） |
| 编辑器 YAML | `monaco-yaml` | 5.5.1 | MIT | 2026-06-03 | ✓ 采用 —— IDE 里挂 k8s schema，边写边校验 |
| 层 / 包处理 | `tar-stream` + `fflate` | 3.2.0 / 0.8.3 | MIT | 2026-04-29 | ✓ 采用（OCI 层与 Helm chart 打包） |
| 不可变快照 | `immutable` | 5.1.9 | MIT | 2026-06-29 | ✓ 采用（结构共享，做世界快照） |
| Worker RPC | `comlink` | 4.4.2 | Apache-2.0 | 2024-11-07 | ◐ 可选；两年没更新但功能稳定，也可自己写 60 行 |
| WASM 缓存 | `idb-keyval` | 6.3.0 | Apache-2.0 | 2026-07-08 | ✓ 采用（缓存 Go CLI 的 wasm 制品） |

**许可证唯一的注意点**：`elkjs` 是 EPL-2.0 / GPL-3.0 双许可，已排除。
其余全部 MIT / ISC / Apache-2.0，与 MIT 自托管兼容。

### Go → WASM 制品

制品预构建后入库或挂 release，日常开发不需要本地装 Go；CI 单独一条交叉编译 job。

| 工具 | 为什么值得编 | 期次 |
| --- | --- | --- |
| `kubectl` | 学员 80% 的操作在这里。所有 flag、所有 `-o` 格式、`explain`、客户端 apply 合并、全部报错文本 —— 一次全对 | 一期 |
| `helm` | 真 Go 模板 + 真 sprig，学员能自己写 chart。Helm Playground 已验证可行 | 二期 |
| `kustomize` | overlay / patch / generator 语义边角多，用真的最省事 | 二期 |
| `argocd` CLI | `app diff` / `sync` 的输出格式很有辨识度 | 二期 |
| `istioctl` | `proxy-status` / `analyze` / `x describe` 是网格关卡的主要信息来源 | 三期 |
| `cosign` | 签名与验签的真实命令行与输出 | 三期 |
| `kubeconform` / `kubectl-validate` | 校验报错和上游一致（`kubectl-validate` 是 apiserver 作者用同一套代码写的） | 一期备选 |
| `velero` / `cilium` CLI | 按需 | 四期 |

### 出题期工具（只有关卡作者需要）

| 工具 | 用途 | 备注 |
| --- | --- | --- |
| `setup-envtest` | 跑真 kube-apiserver + etcd 录 golden，**无 Docker、无 kubelet** | macOS 可用；支持离线预下载 |
| `kwokctl --runtime=binary` | 真 apiserver + kwok 假 kubelet，补 Pod 生命周期 Event | 二进制下载只支持 Linux（darwin arm64 见 kwok#591） |
| `kind` | 完整集群，node image 要对应钉住的版本（`kindest/node:v1.36.x`） | 需要 Docker；可放 GitHub Actions |
