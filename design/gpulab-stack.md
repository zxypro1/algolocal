# gpulab 技术选型清单

> 这个领域半年就能翻篇。选型集中在这一个文件，各关的 primer 从它取值，
> 每个发布周期复核一次这里就够。
>
> **上次核实：2026-08-26**（npm 版本与许可证从 registry 直查；
> GPU 生态状态经联网核实，来源逐条写在表里）

## 复核清单

逐条确认三件事：**这个东西还在用吗** / **版本变了吗** / **有没有被更新的方案取代**。
改动后更新本文件的「上次核实」日期与对应行。

---

## 一、教学内容的技术栈

学员在关卡里会见到、会敲、会写的东西。选型要贴近 2026 年大型 AI 基础设施团队的真实用法。

| 领域 | 选型 | 版本 / 状态 | 依据与来源 |
| --- | --- | --- | --- |
| 工具链 | **CUDA Toolkit 13.3**（`nvcc` / `ncu` / `nsys` / `compute-sanitizer`） | 13.3 于 2026-05 发布，13.2.2 于 2026-07，13.4 开发者预览 2026-07 | CUDA 13.0 起铺垫 tile-based programming，13.3 在 NVCC 与 NVRTC 里都加了 tile 编程支持。<https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html> · <https://developer.nvidia.com/blog/whats-new-and-important-in-cuda-toolkit-13-0/> |
| 主建模架构 | **Hopper H100（SM90，compute capability 9.0）** | 现役主力，文档最全 | 64 warp/SM、64K 个 32 位寄存器（256KB）/SM、228KB 共享内存/SM、单 block 最多 227KB、32 block/SM。<https://docs.nvidia.com/cuda/hopper-tuning-guide/index.html> · <https://docs.nvidia.com/cuda/cuda-programming-guide/05-appendices/compute-capabilities.html> |
| 第二建模架构 | **Blackwell B200 / B300（SM100 / SM103）** | 2024 / 2025 出货，2026 年新集群主力 | 引入 TMEM（Tensor Memory，靠近 tensor core 的程序员可管理暂存）、`tcgen05` 取代 `wgmma`、数据搬运与 matmul 全异步。B300 为 288GB HBM3e / 8 TB/s / 15 PFLOPS 稠密 FP4。<https://pytorch.org/blog/flexattention-flashattention-4-fast-and-flexible/> · <https://www.nvidia.com/en-us/data-center/technologies/blackwell-architecture/> |
| 路线图（只在 primer 提一句） | Rubin VR200（2026）→ Rubin Ultra（2027）→ Feynman（2028） | Rubin 2026 年进入量产 | 224 SM、288GB HBM4、约 22 TB/s、约 50 PFLOPS FP4；第三代 Transformer Engine 加了 NVFP4 的两级微块缩放。**这些数字来自二手报道，不作为建模依据，只在延伸阅读里提。**<https://www.nextplatform.com/compute/2026/03/19/driving-down-the-ai-system-roadmap-with-nvidia/5210195> · <https://introl.com/blog/nvidia-rubin-full-production-ces-2026-ai-infrastructure> |
| 注意力算子 | **FlashAttention-4**（前置：FA2 的分块 + online softmax 思路） | 2026-03-05 发布 | Tri Dao 等（Princeton / Together AI / Meta / NVIDIA / Colfax）。Blackwell 上 1613 TFLOPs/s、71% 硬件利用率，比 cuDNN 9.13 快 1.3×、比 Triton 快 2.7×。**关键教学点**：SFU 没跟上 tensor core，softmax 的 `exp()` 变得和矩阵乘一样贵，于是要在两个 tile 之间 ping-pong。<https://pytorch.org/blog/flexattention-flashattention-4-fast-and-flexible/> · <https://modal.com/blog/reverse-engineer-flash-attention-4> |
| 内核编写方式 | **CUDA C++ 为主**；primer 里讲清 Triton / CuTe DSL / Gluon / Helion 各占什么位置 | CuTe DSL 2026 年夏季毕业出 beta | 生态实际分层：`torch.compile` 的融合走 Triton；FA4 因为 Blackwell 的 TMA/TMEM 需要 tile 级控制而**从 Triton 退回 CuTe DSL**；CUTLASS 4.x 的 Python DSL 编译比 C++ 模板快 20–30×。<https://pytorch.org/blog/flexattention-flashattention-4-fast-and-flexible/> · <https://docs.nvidia.com/cutlass/latest/media/docs/pythonDSL/functionality.html> |
| 量化 | **NVFP4** 为主，**MXFP4** 作对照；FP8（E4M3）作过渡 | Blackwell 原生支持两种 | 都是 E2M1 布局，差别在缩放粒度：**NVFP4 = 16 元素块 + FP8(E4M3) 块缩放 + 张量级全局缩放；MXFP4 = 32 元素块 + E8M0 缩放**。NVFP4 相对 FP8 省约 1.8× 显存，实测 2–3× 出词吞吐。常见部署组合：MXFP4 W4A16、MXFP4 W4A4、NVFP4 W4A4KV4。<https://arxiv.org/pdf/2512.02010> · <https://arxiv.org/pdf/2606.07618> |
| 推理引擎语义 | **vLLM V1 调度器**：连续批处理、PagedAttention、前缀缓存、chunked prefill、CUDA Graph、prefill/decode 分离 | vLLM V1 架构 | 调度单位是**一个 decode step 而不是一个请求**（iteration-level scheduling），比静态批处理提升 10–23×。KV 块默认 16 token，`free_block_queue` 管池子，`req_to_blocks` 做映射；前缀按块哈希进 `cached_block_hash_to_block`。<https://vllm.ai/blog/2025-09-05-anatomy-of-vllm> |
| 前缀复用 | vLLM 的哈希前缀缓存；**SGLang 的 RadixAttention** 作对照 | — | SGLang 把缓存前缀组织成树，请求之间互相复用，提示重叠重的负载上优势明显 |
| 集合通信 | **NCCL**（`ncclAllReduce` / `ReduceScatter` / `AllGather` / `Broadcast` / `Send` / `Recv` / `GroupStart` / `GroupEnd`） | — | 性能口径用 nccl-tests 的 **algbw / busbw**：`busbw = algbw × 2(n-1)/n`（AllReduce）、`× (n-1)/n`（AllGather / ReduceScatter）、`× 1`（Broadcast / Reduce）。<https://github.com/NVIDIA/nccl-tests/blob/master/doc/PERFORMANCE.md> |
| MoE 通信 | **NCCL EP**（`ncclEpDispatch` / `ncclEpCombine`），前身 **DeepEP** | 2026 论文，NCCL Device API 上重写 | 两种模式：LL（低延迟，给 decode）与 HT（高吞吐，给训练与 prefill）。DeepEP 用 NVSHMEM + IBGDA 做设备发起的稀疏 all-to-all。<https://arxiv.org/pdf/2603.13606> · <https://docs.vllm.ai/en/latest/serving/expert_parallel_deployment/> |
| 并行策略 | **DP / TP / PP / SP / CP / EP**（Megatron-Core 的六个维度） | Megatron Core 的 MoE 扩展技术报告 2026-03 | SP 沿序列维切激活，省激活显存且不增加通信；CP 是沿序列长度的并行。<https://github.com/NVIDIA/Megatron-LM> · <https://arxiv.org/pdf/2603.07685> |
| 互联 | 机内 **NVLink + NVSwitch**，机间 **InfiniBand NDR 400G / XDR 800G** | GB200 NVL72 为参照 | 单张 Blackwell 18 条 NVLink × 100 GB/s = 1.8 TB/s；NVL72 整机 130 TB/s；跨机 ConnectX-8 支持 XDR 800 Gb/s。scale-up 走 NVLink（张量并行），scale-out 走 IB（数据并行）。<https://www.nvidia.com/en-us/data-center/gb200-nvl72/> · <https://nebius.com/blog/posts/leveraging-nvidia-gb200-nvl72-gpu-interconnect> |
| 剖析器口径 | **Nsight Compute** 的分节与指标命名 | ncu 13.3 | 分节：GPU Speed Of Light Throughput / Memory Workload Analysis / Compute Workload Analysis / Instruction Statistics / Launch Statistics / Occupancy / Scheduler Statistics / Warp State Statistics。命名规则 `unit__(subunit)_(pipestage)_quantity_(qualifiers)`。<https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html> |
| 正确性工具 | **compute-sanitizer** 的 `memcheck` / `racecheck` / `synccheck` | — | 见 gpulab.md「竞态检测」一节 —— 在确定性模拟器里这不是锦上添花，是**必须做**的 |

### 明确不教

| 放弃 | 理由 |
| --- | --- |
| 手写 PTX / SASS | 我们建模到 CUDA C 的语义层，不做指令选择与调度。真实世界里也极少有人手写 SASS |
| C++ 模板元编程 / CUTLASS C++ 模板 | 内核用 C99 + CUDA 扩展的子集写。CUTLASS 的抽象在 primer 里讲，不要求学员写模板 |
| Triton / CuTe DSL 语法 | 第一期不做第二套语言。primer 里说明它们的位置与取舍，留作后续扩展 |
| 多进程 / MPI 启动 | 集群关卡里一个进程管所有 rank（NCCL 的 single-process-multi-device 用法），省掉进程模型 |
| 功耗、时钟频率抖动、ECC、MIG | 与「写出更快的内核」这条教学线无关 |

---

## 二、实现依赖

许可证判断标准：**兼容 MIT 自托管、仍在维护、浏览器与 Electron 两端都能跑**。

### JS 依赖（npm registry 直查，2026-08-26）

| 用途 | 包 | 版本 | 许可证 | 最后发布 | 判断 |
| --- | --- | --- | --- | --- | --- |
| CUDA 语法 | **`tree-sitter-cuda`** | 0.21.1 | MIT | 2025-09-18 | ✓ **采用** —— 包里**自带预编译的 `tree-sitter-cuda.wasm`**，和现有 `tree-sitter-bash` 完全同一条加载路径。原型已验证：`__global__` / `__shared__` / `__device__` / `extern __shared__` / `#pragma unroll` / `<<<grid, block, smem, stream>>>` 全部解析，**0 个 ERROR 节点**，且 `kernel_call_syntax` 是一个正经节点 |
| tree-sitter 运行时 | `web-tree-sitter` | 0.26.13 | MIT | 2026-08-23 | ✓ 仓库已在用，直接复用 |
| 终端 | `@xterm/xterm` + addons | 6.0.0 | MIT | 2025-12-22 | ✓ 复用 opslab 的 `OpsTerminal` |
| 拓扑渲染 | `@xyflow/react` | **钉 12.10.2** | MIT | — | ✓ 复用；12.11.x 自己是坏的（见 opslab.md），不要跟版本 |
| 图表 | `recharts` | 3.6.0 | MIT | — | ✓ 仓库已在用 —— roofline、时间线、带宽曲线 |
| 编辑器 | `@monaco-editor/react` | 4.7.0 | MIT | — | ✓ 仓库已在用；CUDA 高亮用 Monaco 的 cpp 再叠 CUDA 关键字 |
| 不可变快照 | `immutable` | 5.1.9 | MIT | 2026-06-29 | ◐ 备用；GPU 世界的快照面比 k8s 小得多，可能用不上 |

**结论：这个项目一个新的运行时依赖都不需要加，除了 `tree-sitter-cuda`（MIT，自带 wasm）。**
没有 Go → WASM 管线，没有 136MB 的制品 —— 因为这次没有可编译的真 CLI 可用
（`nvcc` 是闭源的，`ncu` 也是）。

### 可以借鉴但不引入的东西

| 项目 | 许可证 | 为什么不引入 | 借鉴什么 |
| --- | --- | --- | --- |
| **GPGPU-Sim 4.0 / Accel-Sim** | BSD 3-clause（UBC 等），**与 MIT 兼容** | 是 C++ 学术模拟器，靠 NVBit 在**真卡上**抓 SASS trace 才能跑；把它 emscripten 过来的风险远大于自己写一个 VM | **架构**：功能模拟与时序模拟分离的 trace-driven 结构，正是我们要的；以及它公开的、经过真机校准的参数表可作为时序模型的参照。<https://github.com/accel-sim/gpgpu-sim_distribution> |
| LeetGPU / Tensara / cuda.live | 商业 / 各异 | 它们是**真卡上跑**的竞速平台（Tensara 60+ 题，LeetGPU 50+ 题），路线与我们相反 | 题目选型可以参考；但它们没有「平台侧计量证明优化生效」这一层 —— 只有墙钟时间 |

---

## 三、复核时最容易过期的三行

1. **FlashAttention 的版本**（FA4 2026-03 发布；下一版会不会又换 DSL）
2. **量化格式的行业默认**（NVFP4 vs MXFP4 的胜负；FP4 训练是否成为常规）
3. **建模架构**（H100 还是不是「最值得先学的那张卡」；Rubin 出货后要不要把 SM100 提为主）
