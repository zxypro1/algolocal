# CUDA GPU 编程实战工作台（gpulab）设计方案

> 状态：**设计草案，等确认**。这一轮只做设计，未动代码。
> 最后更新：2026-08-26。技术选型的核实日期与来源见 [gpulab-stack.md](./gpulab-stack.md)。
>
> 放在 `design/` 而不是 `docs/`：后者是 GitHub Pages 的站点目录，
> `.github/workflows/deploy-pages.yml` 监听 `docs/**`，放进去会一并发布并触发部署。

## 这是什么

在工程实战里加入第二类新形态的项目：**用 CUDA 从零搭一个 LLM 加速引擎**。

前半程在**单张 GPU** 上，从「第一个 kernel」一路做到一个能跑的推理引擎：
访存合并 → 共享内存分块 → GEMM → 规约与归一化 → 注意力与 FlashAttention →
KV cache → 量化 → 算子融合 → 连续批处理调度。

后半程把同一个引擎**摊到一个 GPU 集群上**：p2p 与集合通信 → 数据并行 →
张量并行 → 流水线并行 → 通信计算重叠 → 专家并行 → 分离式部署与容错。

它需要的面板和 ops 形态不一样：终端、IDE、**性能剖析**、**访存行为可视化**、
后半程的**集群拓扑与通信时间线**。

---

## 一、判定标准：接口真实，实现可模拟

沿用 [opslab.md](./opslab.md) 定下的地基，这里只写这个领域的具体含义。

**必须和真卡一致的**：

- 学员写的**语法**：`__global__` / `__device__` / `__shared__` / `threadIdx` /
  `blockIdx` / `__syncthreads()` / `__shfl_xor_sync` / `<<<grid, block, smem, stream>>>`
- 学员敲的**命令**：`nvcc`、`./bench`、`ncu`、`compute-sanitizer`、`nvidia-smi`
- **指标的名字与口径**：`dram__bytes_read.sum`、bank conflict、achieved occupancy、
  busbw、MFU —— 用 Nsight Compute 与 nccl-tests 的原名
- **优化的因果关系**：改成合并访问，DRAM 字节真的下降；加 padding，bank conflict 真的归零；
  每线程多算几个输出，算术强度真的上去

一句话：**在这里学会的优化手法，换到真卡上原样成立；这里看到的指标，`ncu` 上也是这么叫的。**

**必须提前说清的分叉**：

> **模拟时间的绝对值不可迁移。** 我们的时序模型是「方向正确、量级可信」，
> 不是周期精确的硬件模型。因此有一条硬规矩贯穿全案：
>
> **所有门槛只建立在「结构性计量」上，绝不建立在模拟耗时的绝对值上。**
>
> 结构性计量 = 给定内存模型后可以精确算出、且与具体硬件型号无关的量：
> DRAM 传输字节、32B 扇区数、bank conflict 次数、发散分支数、
> 每线程寄存器数、峰值显存、通信字节、气泡率。这些数换到真卡上一个不差。
>
> 模拟耗时只做两件事：**展示**（roofline、时间线），
> 以及**同一关内的相对比较**（「比第 7 关那版快 3 倍以上」）。

---

## 二、和 opslab 最大的不同：这次没有真 CLI 可编

opslab 的命门是「真 kubectl 编成 WASM」，一次解决全部保真度问题。
这条路在 GPU 这边**走不通**：

| | opslab | gpulab |
| --- | --- | --- |
| 学员敲的工具 | kubectl / helm，**Go 写的开源软件** | nvcc / ncu，**闭源二进制** |
| 结果 | 编成 wasm，输出零误差 | 编不了，必须自己实现 |
| 学员写的东西 | YAML（声明，`yaml`@2 直接解析） | **CUDA C（要执行）** |

于是这个项目的命门换了一个：**能不能在浏览器里执行一段 CUDA，
并且在执行过程中把访存行为精确记下来，同时快到不难受。**

这一轮做了原型来回答它。

### 原型结论（2026-08-26，`scratchpad/cudaproto/`）

**结论一：解析没有问题。** `tree-sitter-cuda`@0.21.1（MIT）自带预编译 wasm，
和仓库现有的 `tree-sitter-bash` 完全同一条加载路径。喂一段带
`__global__` / `__restrict__` / `__shared__` / `extern __shared__` /
`#pragma unroll` / `fmaf` / `<<<dim3(8,8), dim3(32,32), 0, stream>>>` 的真实内核，
**0 个 ERROR 节点**，`kernel_call_syntax` 是一个正经的具名节点。

**结论二：执行预算比预想宽得多。** 关键在于**按 warp 锁步调度，而不是按线程**：
一条指令派发一次，内部对 32 个 lane 循环，解释开销被摊薄 32 倍。

手写「转译器应该生成的 JS」，跑朴素 sgemm 并对**每一次全局访存做 32 地址的合并分析**：

| 规模 | 耗时 | MAC 数 | warp 级访存请求 | 32B 扇区 |
| --- | ---: | ---: | ---: | ---: |
| N=128 | **23 ms** | 2.1 M | 0.13 M | 0.26 M |
| N=256 | **66 ms** | 16.8 M | 1.05 M | 2.11 M |
| N=512 | **508 ms** | 134.2 M | 8.40 M | 16.81 M |

**结论三：不必转译成 JS，写字节码 VM 就够。** 同规模下把内核编成扁平 IR、
用同样的 warp 锁步方式解释执行，只慢 **1.5 倍**（97ms vs 66ms）——
因为热点在「对 32 个 lane 做同一件事」，不在指令派发。

于是**选 VM 不选转译**，换来四样东西：单步与断点（可视化面板要）、
逐指令的精确计量、不依赖 `new Function`、以及对浮点与超越函数的完全控制。

**预算换算：约 2000 万条 warp 指令 / 秒。**
一个关卡的判定跑到 5000 万条 lane 指令量级仍在 2 秒内，
这就是关卡规模设计的硬约束（见「关卡规模」一节）。

---

## 三、分层架构

```
L3 引擎层   推理引擎：调度器 / KV 分页 / 批处理 / 量化 / 图捕获
            分布式：NCCL 语义 / 并行策略的宿主编排
                          ↓ 只能通过 CUDA Runtime API 与 NCCL API 访问
L2 设备层   GPU 模型：SM 调度 · warp 锁步 VM · 内存层次（RF/SMEM/L1/L2/DRAM）
            设备运行时：cudaMalloc / Memcpy / 流 / 事件 / 图
            互联：NVLink · NVSwitch · PCIe · InfiniBand
L1 机器层   VFS / 进程 / shell / coreutils      ←── 直接复用 opslab
            nvcc（我们的编译器）· ncu · compute-sanitizer · nvidia-smi
L0 内核     虚拟时钟 · 确定性调度 · 种子 RNG    ←── 直接复用 opslab
```

**能从 labkit 白拿的**（已上移，见 `src/lib/labkit/`）：`kernel/`（虚拟时钟、优先级定序、
settle / 死锁检测、种子 RNG）、`machine/`（VFS、tree-sitter shell、
30 个 coreutils）、`src/components/opslab/OpsTerminal.tsx`、拓扑视图的
「自算坐标 + `@xyflow/react` 渲染」那套做法、以及 `ops` 关卡的判定管线
（`runOpsStage` → `StageRunReport` → 结果面板 / 计分卡 / AI 评审 / 进度存档）。

估计**能省下 8,000 行左右**。这也是为什么值得把它做成同一个仓库里的第二个实验台，
而不是另起炉灶。

**两个时钟，分工明确**：

- **内核内的时间**：一次 kernel launch 里的周期，由时序模型算出来，是个纯函数，
  不上虚拟时钟。因为 SM 内部没有别的实体要跟它交互。
- **内核外的时间**：kernel launch、`cudaMemcpyAsync`、流与事件、NCCL 集合操作、
  多张卡各自的进度 —— **全部挂在复用来的 `VirtualClock` 上**。
  后半程「16 张卡同时算、同时通信、还要重叠」正是确定性并发调度器的用武之地，
  这一层几乎不用改。

---

## 四、组件路由表

策略编号沿用 opslab.md：S1 真代码编 WASM / S2 成熟库 / S3 官方数据 + 薄实现 / S4 行为等价模拟。
最后一列写明每一处模拟在什么场景下学员会察觉。

| 组件 | | 怎么做 | 学员会在哪察觉 |
| --- | --- | --- | --- |
| CUDA 语法解析 | S2 | `tree-sitter-cuda`（MIT，自带 wasm，原型 0 error） | **察觉不到** |
| `nvcc` | S4 | 我们的前端：tree-sitter 树 → 类型检查 → 扁平 IR。诊断信息**我们写**，风格贴 nvcc 但不逐字节一致 | 报错文本与真 nvcc 不同；模板、C++ 类、`constexpr` 高级用法直接报「未实现」 |
| 内核执行 | S4 | warp 锁步字节码 VM（原型已量过预算） | 大规模问题跑不动；不支持递归深度过大与动态并行 |
| fp32 语义 | S3 | 每个浮点运算过 `Math.fround`；`fmaf` 用双精度乘加再舍入 | 极少数情况下 FMA 的双重舍入与真硬件差 1 ulp，**已知且写进文档** |
| `expf` / `logf` / `rsqrtf` / `tanhf` | S3 | **自己实现**，不用 JS 的 `Math.*` | 察觉不到；反而修掉一个隐患 —— V8 与 JSC 的超越函数结果不一致，直接用会毁掉确定性。顺带能真实现 `__expf` 这类 fast-math 变体，让「快但不准」在软件上也成立 |
| fp16 / bf16 / fp8 / fp4 | S3 | 显式的位级编解码 + 舍入，累加在 fp32 | 察觉不到；量化关卡的误差是真算出来的 |
| SM 调度与 occupancy | S3 | 按 [Hopper Tuning Guide](https://docs.nvidia.com/cuda/hopper-tuning-guide/index.html) 的硬限制建模：64 warp/SM、64K 寄存器/SM、228KB SMEM/SM、32 block/SM | 察觉不到；achieved occupancy 是真按 block 驻留算的 |
| 寄存器数 | S4 | 从 IR 的活跃区间估：标量局部变量算寄存器；**被动态下标访问的局部数组落到 local memory** | 不是真的寄存器分配器，数会偏。但「动态下标数组会溢出到 local memory」这条最重要的因果**是对的** |
| 全局访存合并 | S3 | 每条 warp 访存指令做 32 地址 → 32B 扇区去重，逐条计数 | **察觉不到** —— 这是本项目计量的核心，必须精确 |
| L1 / L2 | S4 | 按扇区的组相联 + LRU，容量按型号 | 替换策略不是真的（真卡的 L2 策略未公开），命中率会偏 |
| 共享内存与 bank conflict | S3 | 32 banks × 4 字节，按真规则算冲突路数（同 bank 不同地址才冲突，广播不冲突） | **察觉不到**；padding 与 swizzle 的效果和真卡一致 |
| warp 发散 | S3 | 活跃掩码 + IPDOM 重汇聚栈 | 察觉不到；Volta 起的独立线程调度不做（`__syncwarp()` 语义按保守实现） |
| warp 原语 | S3 | `__shfl_sync` 系列、`__ballot_sync`、`__activemask`、`__reduce_add_sync` 按真语义 | 察觉不到 |
| 屏障 | S3 | `__syncthreads()` / `__syncwarp()` / `bar.arrive` 语义，**发散屏障判死锁并报错** | 察觉不到 |
| 异步拷贝与流水 | S4 | `cp.async` / `memcpy_async` 的**语义**：发起、`commit`、`wait_group`，在时序模型里真的与计算重叠 | 不做 TMA 描述符的字节布局；Blackwell 的 TMEM 只做到「有这么一块空间、容量有限」 |
| Tensor Core | S4 | `wmma` 风格的 fragment API（`load_matrix_sync` / `mma_sync` / `store_matrix_sync`），一条 MMA 在时序模型里是一个高吞吐单元 | 不做 `tcgen05` 的实际指令编码；fragment 内的元素排布按我们的定义（真卡上这是未定义的实现细节，教学上正好） |
| 原子操作 | S3 | `atomicAdd` 等，含 fp32 的**不确定累加顺序** —— 但我们给一个确定的顺序并明确说明 | 真卡上 atomic 顺序不定所以结果不可复现；我们是可复现的。**这个差异必须讲**，否则学员学不到「为什么 atomic 版本的结果每次都不一样」 |
| 竞态检测 | S3 | 影子内存 + 屏障纪元，等价于 `compute-sanitizer --tool racecheck` | 见下文「六、竞态检测」—— 不做这个整套判定就是假的 |
| 越界检测 | S3 | 分配边界已知，等价于 `--tool memcheck` | 察觉不到；报错格式贴 compute-sanitizer |
| `ncu` 剖析 | S3 | 分节名与指标名照抄 Nsight Compute；数值来自我们的计数器 | 指标覆盖是子集，没实现的明确报「未实现」而不是编一个数 |
| 显存分配器 | S3 | `cudaMalloc` / `cudaFree` / 池化分配 + 碎片统计 | 察觉不到 |
| 流与事件 | S3 | 多流、`cudaStreamWaitEvent`、默认流语义，跑在虚拟时钟上 | 察觉不到 |
| CUDA Graph | S4 | 捕获 → 实例化 → 重放，收益体现在**省掉的启动开销** | 启动开销是参数化的 |
| NVLink / PCIe / IB | S4 | 每条链路的带宽 + 延迟 + 每消息开销；共享链路按带宽平分 | 没有拥塞控制、没有真 RDMA 语义；**但通信量与 busbw 是精确的** |
| NCCL | S3 | 真 API 形状 + 真算法（ring / tree / 双二叉树）；busbw 用 nccl-tests 的公式 | 不做 NCCL 的自动算法选择与调优表，算法由题目或学员指定 |
| 剖析面板 | S2 | `recharts` 画 roofline / 时间线 / 带宽；访存热图自绘 | 不适用 |
| 拓扑面板 | S2 | `@xyflow/react`**钉 12.10.2** + 自算坐标（沿用 opslab 的教训） | 不适用 |

---

## 五、工作台形态（问题 1）

### 结论：新增 `workspace.kind = 'gpu'`

现有的 `code` 工作台不够（没有终端、没有剖析、没有可视化），
`ops` 工作台也不合适（它的拓扑面板是集群对象图，事件流是 k8s Event）。
但 `WorkspaceKind` 这个联合类型加一支的成本极低 —— 第一段重构已经把路铺好了。

```ts
export type WorkspaceKind = 'code' | 'ops' | 'gpu';

export interface GpuWorkspaceSpec {
  kind: 'gpu';
  world?: GpuWorldSpec;   // 这台机器 / 这个集群长什么样，全项目共用
}
```

沿用 opslab 的做法：**世界写在项目上，关卡只写增量**。

### 六块面板，按关卡阶段显隐

| 面板 | 内容 | 从哪一关开始出现 |
| --- | --- | --- |
| **任务** | 目标 / 清单 / 提示 / 常见坑 / 结果 —— 直接复用 | 第 1 关 |
| **终端** | `nvcc -o bench bench.cu && ./bench`、`ncu ./bench`、`compute-sanitizer`、`nvidia-smi` —— 复用 `OpsTerminal` | 第 1 关 |
| **IDE** | `.cu` 文件，Monaco + cpp 语法叠 CUDA 关键字 —— 复用 | 第 1 关 |
| **剖析** | ncu 风格：Speed Of Light / Memory Workload / Occupancy / Warp State + roofline 图 | 第 2 关 |
| **访存** | 见下 | 第 2 关 |
| **集群** | GPU 拓扑图（NVLink / PCIe / IB 三种边）+ 通信时间线（nsys 风格泳道） | 第 20 关 |

面板通信沿用 opslab 的定论：**单一数据源、单向数据流，不做面板间消息**。

### 「访存」面板要能看见什么

这是这个项目区别于「在真卡上跑一跑」的地方 —— 真卡上你**看不见**这些：

1. **warp 访存热图**：选一条访存指令，画出这个 warp 的 32 个 lane 打到了哪些
   32B 扇区。合并的时候是 4 个连续格子，不合并的时候是 32 个散点。
   「为什么改一下下标 DRAM 字节就掉了 8 倍」在这张图上是一眼的事。
2. **共享内存 bank 视图**：32 个 bank 一行，冲突的那一路标红，鼠标停上去说
   「lane 3 和 lane 19 都打到 bank 7 的不同地址，这一条指令要发 2 路」。
   加了 `+1` padding 之后整行变绿。
3. **线程块 / warp 时间线**：哪些 block 驻留在哪个 SM 上、什么时候被屏障挡住、
   哪些 warp 在等访存。占用率低的时候图上是大片空白。
4. **单步**：VM 天生支持。停在某条指令上看 32 个 lane 的活跃掩码与寄存器值。

第 3 项和第 4 项是选 VM 而不是选转译的直接回报。

---

## 六、GPU 模拟器：真到什么程度（问题 2）

### 学员写什么

**真 CUDA C。** 具体是 **C99 子集 + CUDA 扩展**，不含 C++ 模板与类。

这不是妥协 —— 纯 C 风格的 kernel 是完全合法的 CUDA，
而且教材（《Programming Massively Parallel Processors》）与 NVIDIA 的入门样例就是这么写的。
模板与 CUTLASS 抽象在 primer 里讲清位置，不要求学员写。

支持的东西：函数、结构体、指针与指针算术、数组、`for` / `while` / `if` / `switch`、
`static` / `const` / `__restrict__`、`float` / `double` / `int` / `unsigned` /
`half` / `nv_bfloat16` / `__nv_fp8_e4m3` 及其向量类型（`float4` 等）、
`__global__` / `__device__` / `__host__` / `__shared__` / `__constant__` /
`__forceinline__`、`extern __shared__`、内建变量与内建函数、`#define` / `#pragma unroll`。

**宿主代码也是 C。** `cudaMalloc` / `cudaMemcpyAsync` / `cudaStreamCreate` /
`<<<>>>` / `ncclAllReduce` 全都是真 API 形状。一套 C 前端同时覆盖设备端与宿主端，
不引入第二种语言。详细论证见下一节。

### 宿主代码占多大比重（这里原先估错了）

初稿说「只有第 18/21/28 关是宿主为主」。逐关数了一遍，**是 12 关，整个后半程**：

| # | 主题 | 主体在哪 |
| --- | --- | --- |
| 01–14 | 从第一个 kernel 到算子融合 | **kernel**；宿主是平台给的只读样板 |
| 15 | 朴素注意力 | kernel + 宿主分配（OOM 发生在宿主侧的 `cudaMalloc`） |
| 16 | FlashAttention | **kernel** |
| 17 | KV cache 与 decode | 各半 —— 缓冲管理与逐步 launch 在宿主 |
| 18 | 分页 KV cache | **宿主为主** —— 块表、空闲链、前缀哈希 |
| 19 | 量化 | kernel 为主；宿主算缩放因子 |
| 20 | CUDA Graph 与引擎组装 | **宿主为主** |
| 21 | 连续批处理调度器 | **几乎纯宿主** |
| 22 | 手写 ring all-reduce | **宿主为主** + 一个小 reduce kernel |
| 23 | NCCL 与数据并行 | **宿主为主** |
| 24 | 张量并行 | **宿主为主**；kernel 复用第 9 / 11 关的 GEMM |
| 25 | 序列并行 | **纯宿主** |
| 26 | 流水线并行 1F1B | **纯宿主** |
| 27 | 通信计算重叠 | **纯宿主** |
| 28 | 专家并行 MoE | **宿主为主** + gather/scatter kernel |
| 29 | 分离式部署与容错 | **纯宿主** |

**17 关 kernel 为主，12 关宿主为主。** 这个比例决定了「宿主用什么语言」
不是一个边角问题，而是整个项目后 40% 的形态。

### 为什么最后仍然选全 C

**理由一：这三处用 TS 写不是「割裂」，是教反。**

1. **NCCL 是流序异步的，不是 `await` 的。** NVIDIA 自己的文档写得很清楚：
   单线程管多设备时**必须**用 group 语义，因为每个 NCCL 调用都可能阻塞、
   等其他 rank 到齐才把操作真正下到流上；在异步线程里插一个 CUDA 调用就能造出死锁。
   一个 `await gpu.allReduce(buf, n)` 把这些全抹平了 —— 而这些恰恰是现实里
   最常翻车的地方。<https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/usage/groups.html>
2. **分页 KV 的块表必须是设备可见的扁平 `int32` 数组** —— paged attention 的 kernel
   要在 GPU 上读它。用 TS 的 `Map<reqId, Block[]>` 写出来，学员学到的是一个字典；
   现实里每一步都要把它物化成连续数组上传，vLLM 的 input preparation 正因此成为热点，
   也是他们上 CUDA Graph 的原因之一。**用 C 的扁平数组写反而更真，不是更笨。**
3. **调度器的产物同样是一组要上传的张量**（slot mapping、seq lens、block tables）。
   TS 的 `Array.filter` 链会让人以为调度纯粹是 CPU 侧的逻辑，看不见每一步的拷贝开销。

**理由二：成本差比想象中小。**

CUDA Runtime API 那约 35 个函数（内存 / 设备 / 流 / 事件 / 图 / 错误 / launch）
**不管宿主用什么语言都要实现** —— TS 路线只是把它们暴露成 TS 函数。
所以「全 C」的真实增量只有 C 前端为宿主多出来的部分：

| 增量项 | 估算 |
| --- | ---: |
| 宿主堆（`malloc` / `free` / `realloc`）+ 指针边界检查 | 250 行 |
| libc 子集（`memcpy` / `memset` / `strlen` / `snprintf` / `printf` 格式化 / `qsort` / `rand`） | 400 行 |
| 函数指针（`qsort` 比较器、kernel 表） | 150 行 |
| **小计** | **≈ 800 行 TS** |

而 TS 路线要另付一套绑定面（device handle、内存视图、launch、流与事件、NCCL）
约 400–600 行，外加**永久**的双份文档、双份 starter 模板、双份判定读取方式。

**净差约 400 行，一次性。** 用 400 行换 11 关的接口真实，划算。

**理由三：C 的啰嗦有解，而且解法本身是对的。**

平台提供两样只读的东西（沿用现有 `code` 工程「只读基础设施文件 + starterFiles」的做法）：

- `containers.h`：`vec_i32` / `map_i64_i32`（开放寻址）/ `ring_u32`，约 200 行 C。
  真实的系统 C 代码就是这么写的，而且这份实现**本身值得读**。
- `main.c` 与 `engine.h`：参数解析、权重加载、计时、结果落盘全是只读样板。
  学员填的是签名明确的函数 —— `int schedule_step(EngineState*, ScheduleOut*)`、
  `int kv_alloc_blocks(KvPool*, int req, int n)`、`void tp_forward(Layer*, ...)`。

这样第 21 关学员真正写的是 150–250 行策略代码，不是 800 行 C 样板。

**被否掉的两条路**：把调度策略做成配置（YAML/JSON）—— 第 21 关的全部意义就是写策略，
做成配置等于把这一关掏空；放开一点 C++（引用、`auto`、成员函数）—— 滑坡到模板，
而 CUTLASS 那套模板我们已经明确不教。

### 怎么执行

**编译到扁平 IR，用 warp 锁步 VM 解释。** 原型已量过预算（第二节）。

执行模型：
```
grid → 按 occupancy 限制把 block 分配到 SM
  block → 拆成 warp（32 lane）
    warp → 取一条 IR 指令，对 32 个 lane 循环执行
      每条访存指令：算 32 个地址 → 合并分析 → 计数 → 真读写内存
      每条分支指令：算 32 个条件 → 更新活跃掩码 → 压 IPDOM 重汇聚栈
      每条屏障指令：挂起本 warp，全 block 到齐再放行
```

指令流同时**吐出一条 trace**，喂给独立的时序模型。这是
[Accel-Sim](https://github.com/accel-sim/gpgpu-sim_distribution) 的经典结构：
**功能模拟与时序模拟分离**。好处是时序模型可以做得比执行器复杂得多
（延迟隐藏、发射端口、访存流水）而不拖慢执行，坏处是没有反馈回路
（时序影响不了执行顺序）—— 对确定性来说反而是好事。

### 建模粒度：必须做 / 可以省

**必须做**（少一条，就有一类优化变成「自称生效」）：

| 建模项 | 少了它哪一关就塌了 |
| --- | --- |
| 线程 / warp / block / grid 层次 | 全部 |
| block → SM 调度，受 SMEM 与寄存器限制 | occupancy 关 |
| 全局访存的 32B 扇区合并 | 访存合并关、GEMM 关 |
| 共享内存 32 bank 冲突 | 转置关、GEMM 关 |
| 寄存器压力 → occupancy；动态下标数组 → local memory | 寄存器分块关 |
| warp 发散与活跃掩码 | 发散关、规约关 |
| `__syncthreads()` 语义（含发散死锁） | 所有用共享内存的关 |
| warp shuffle 与 ballot | 规约关、softmax 关 |
| 异步拷贝 + 多缓冲的**重叠** | 流水线 GEMM 关 |
| Tensor Core 作为高吞吐单元 | 混合精度关、注意力关 |
| fp16/bf16/fp8/fp4 的位级语义 | 量化关 |
| 显存容量与峰值统计 | FlashAttention 关、KV cache 关 |
| 流、事件、启动开销 | 引擎组装关、重叠关 |
| 链路带宽 / 延迟 / 共享 | 全部集群关 |

**可以省**（每一条都要在 primer 里写明「这里我们简化了」）：

| 省掉 | 代价 |
| --- | --- |
| PTX / SASS 的指令选择与调度 | 学员看不到「编译器把这里换成了 LDG.128」 |
| 真正的寄存器分配 | 寄存器数是估的，会偏；因果关系保留 |
| L1/L2 的真实替换策略 | 命中率会偏；不作为门槛，只作展示 |
| 指令 cache、TLB、常量 cache 的细节 | 无 |
| 时钟频率、功耗、热节流 | 无 |
| Volta 起的独立线程调度 | `__syncwarp()` 的边角行为不同 |
| 动态并行、统一内存的缺页 | 相关题目不出 |
| 纹理 / 表面内存 | 相关题目不出 |
| 多进程 / MPI | 集群用单进程多设备的 NCCL 用法 |

### 关卡规模的硬约束

预算是**约 2000 万条 warp 指令 / 秒**。判定要在 2 秒内跑完，
所以每关的判定负载控制在 **5000 万条 lane 指令**以内。换算成常见形状：

| 形状 | 可用规模 | 估算 |
| --- | --- | --- |
| 逐元素 kernel | 几百万元素 | 每元素约 5 条指令 |
| GEMM | **M=N=K=256**（默认），512 作压力测试 | 256³ 约 66–140 ms（原型实测） |
| 注意力 | batch 2 × head 8 × seq 512 × dim 64 | 与 256³ GEMM 同量级 |
| 集群关 | 张量本身缩小到上面这个量级，卡数 16 | 通信按字节数算，不逐元素跑 |

关卡设计要**让「有意思的结构」在这个尺度上就出现**：
一个 128×128 的分块 GEMM 已经能把 bank conflict、双缓冲、寄存器分块全部演出来。

---

## 七、门槛怎么成立（问题 2 的核心）

优化类题目最容易变成「我觉得我优化了」。这一节是整个方案的判定地基。

### 三个证据来源

沿用 opslab：**终态**（内存里的结果对不对）、**行为探测**（平台自己跑 `ncu`）、
**过程指标**（VM 记的计数器）。区别是这次第三类是主角。

### 指标清单

现有的 `MetricGate` 机制原样能用（`metric` 是 `LabMetrics` 上的路径），
需要给 `LabMetrics` 加一个 `gpu` 字段。**对齐 Nsight Compute 的命名**，
既是「接口真实」，也让学员搜得到。

| 我们的指标路径 | ncu 对应 | 精确吗 | 用来判什么 |
| --- | --- | --- | --- |
| `gpu.dram.bytesRead` / `bytesWritten` | `dram__bytes_read.sum` / `dram__bytes_write.sum` | **精确** | 访存合并、算子融合、FlashAttention 不物化中间矩阵 |
| `gpu.dram.sectors` | 同上 ÷ 32 | **精确** | 同上 |
| `gpu.global.sectorsPerRequest` | `l1tex__average_t_sectors_per_request_pipe_lsu_mem_global_op_ld.ratio` | **精确** | **合并访问的核心门槛**：完美合并 = 4.0，最坏 = 32.0 |
| `gpu.smem.bankConflicts` | `l1tex__data_bank_conflicts_pipe_lsu_mem_shared_op_ld.sum`（+`_op_st`） | **精确** | 转置的 padding、GEMM 的 swizzle |
| `gpu.smem.bytesPerBlock` | `launch__shared_mem_per_block` | **精确** | 分块尺寸是否超限 |
| `gpu.warp.divergentBranches` | 由 `sm__inst_executed` 与线程数推 | **精确** | 发散关、规约关 |
| `gpu.warp.activeLaneRatio` | warp execution efficiency | **精确** | 同上 |
| `gpu.occupancy.theoretical` | `launch__occupancy_limit_*` | **精确**（给定寄存器估计） | occupancy 关 |
| `gpu.occupancy.achieved` | `sm__warps_active.avg / sm__warps_max` | 依赖时序模型 | 只作展示与相对比较 |
| `gpu.registers.perThread` | `launch__registers_per_thread` | **估计值** | 只作展示；配套的 `gpu.local.bytes` 才作门槛 |
| `gpu.local.bytes` | local memory 流量 | **精确** | **寄存器溢出的硬证据**，比寄存器数可靠 |
| `gpu.inst.executed` / `.fma` / `.ldst` / `.mma` | `sm__inst_executed*` | **精确** | 指令数、算术强度 |
| `gpu.arithmeticIntensity` | FLOP / DRAM 字节 | **精确** | roofline 的横坐标；分块与融合的直接证据 |
| `gpu.memory.peakBytes` | — | **精确** | FlashAttention（不物化 S）、KV cache、激活重算 |
| `gpu.memory.fragmentationRatio` | — | **精确** | 分页 KV cache 关 |
| `gpu.kvcache.prefixHitRatio` | — | **精确** | 前缀缓存关 |
| `gpu.launches` / `gpu.launchOverheadNs` | — | **精确**（计数精确，单位开销参数化） | CUDA Graph 关 |
| `gpu.syncthreads` | — | **精确** | 「少同步一次」类优化 |
| `gpu.atomics` | — | **精确** | 规约关（atomic 版 vs shuffle 版） |
| `gpu.cycles` | — | **模型值** | **不作绝对门槛**；只做 `speedupVsBaseline` |
| `gpu.speedupVsBaseline` | — | 相对值 | 允许作门槛，因为分子分母跑在同一个模型上 |
| `gpu.numeric.maxRelError` / `.maxUlpError` | — | **精确** | 见第八节 |
| `gpu.sanitizer.races` / `.oob` / `.syncErrors` | compute-sanitizer | **精确** | **恒等于 0 的硬门槛** |

集群关卡追加：

| 指标路径 | 对应 | 用来判什么 |
| --- | --- | --- |
| `gpu.comm.bytes` / `.messages` | — | 并行策略的通信量（TP 每层两次 all-reduce 是躲不掉的） |
| `gpu.comm.bytesByLink.nvlink` / `.pcie` / `.ib` | — | **有没有把该走 NVLink 的流量放到 IB 上** —— 张量并行跨机的经典错误 |
| `gpu.comm.algbw` / `.busbw` | nccl-tests | 集合通信实现的效率，公式用官方的 |
| `gpu.pipeline.bubbleRatio` | — | 流水线并行的气泡率，1F1B 与 interleaved 的差别 |
| `gpu.overlap.ratio` | — | 通信与计算重叠了多少 |
| `gpu.mfu` | Model FLOPs Utilization | 端到端的总口径 |
| `gpu.memory.peakBytesPerRank` | — | 显存优化（ZeRO 式切分、激活重算） |
| `gpu.imbalance.maxOverMean` | — | 专家并行的负载不均 |

### 一条设计规矩

**每个门槛都要能回答「不这么优化会是多少」。**
出题时把 baseline（上一关的实现）跑一遍，把两组数都写进题面。
门槛卡在两者之间靠近优化侧的位置。学员看到的不是一个凭空的阈值，
而是「现在 32.0，做对了是 4.0，门槛 8.0」。

---

## 八、数值正确性怎么验（问题 2 的另一半）

### 三层

**第一层：参考实现跑在 fp64。**
每个算子的参考结果用双精度算，不用「另一份 fp32 实现」——
否则两边都有误差，比出来的东西没有意义。

**第二层：误差界按理论推，不拍脑袋。**
fp32 的机器精度 ε = 2⁻²³ ≈ 1.19e-7。K 项累加的相对误差界，
顺序累加是 O(K·ε)，树形/分块累加是 O(log K·ε)。所以：

```
maxRelError ≤ C · sqrt(K) · ε      // 经验界，C 取 4~8
```

具体到关卡：K=256 的 GEMM，界取 `2e-5`；FlashAttention 的 online softmax
因为要做重缩放，界放宽到 `5e-5`。**每关的界写在题面里，并说明它是怎么来的。**

**第三层：允许不同规约顺序，但不允许不确定。**
分块 GEMM、树形规约、FlashAttention 的 online 重缩放，
算出来的位模式和顺序累加一定不同 —— 这是对的，不能罚。
但**同一份代码跑两遍必须逐位相同**：

```
gpu.determinism.bitIdentical === true
```

这条是恒等门槛。跑两遍的结果不一致，说明有竞态（或者用了 atomic ——
那要看题目允不允许）。

### 顺带教对一件事

真卡上 `atomicAdd(float*)` 的结果每次都可能不同，这是 LLM 训练里
「同样的数据同样的种子，loss 曲线对不上」的常见来源。我们的模拟器是确定的，
所以要在 primer 里**明确讲**这个差异，并在相关关卡用一个「关掉确定性顺序」
的开关演示一次真实世界的样子。

---

## 九、竞态检测：不做这个整套判定就是假的

**这是本方案里最容易被忽略、但一旦漏掉就致命的一条。**

在 warp 锁步的确定性模拟器里，**一个有竞态的 kernel 会给出一个稳定的结果**——
因为所有 warp 在我们这里按固定顺序推进，真卡上的时序错位根本不会发生。
两种情况都很糟，实现时都验过：

1. **那个结果恰好是对的。** 典型是「后面的 warp 读前面 warp 刚写的」，
   在固定轮转顺序下永远读得到。学员跑一万遍都对，没有理由怀疑，
   然后带着一份真卡上会炸的代码出门。
2. **那个结果是错的。** 学员会把它当成逻辑 bug 去调，反复重跑也不会看到
   真硬件上那种「时好时坏」，于是学不到「这是竞态」这件事本身。

（初稿这里写的是「会正常出结果」，实现时发现要看访问模式：
漏屏障的转置在我们这儿会算错，而「后 warp 读前 warp」那种会算对。
两种都得靠主动检测才能揭穿，结论不变。）

不主动检测，「在这里学会的换到真卡上成立」就是空话。

所以必须主动检测，做法等价于 `compute-sanitizer --tool racecheck`：

- 共享内存与全局内存的每个字节配一份**影子**：`{ lastWriter: (blockId, warpId), epoch }`
- `epoch` 在每次 `__syncthreads()` 时递增（每个 block 一个计数器）
- 同一 epoch 内，warp A 写过的地址被 warp B 读或写 → **报竞态**，
  给出两条源码行号和线程坐标
- warp 内部按 lane 之间的冲突另算（同一条指令里两个 lane 写同一地址 = 写-写冲突）

配套的另外两个工具同样等价实现：

- `memcheck`：分配边界已知，越界访问直接抓，报「invalid __global__ read of size 4」
- `synccheck`：发散的 `__syncthreads()`（只有一部分 warp 到达屏障）判死锁并报错

**门槛**：`gpu.sanitizer.races === 0`、`gpu.sanitizer.oob === 0`、
`gpu.sanitizer.syncErrors === 0`，从第一个用共享内存的关卡起恒定生效。

**判定要跑两遍**：一遍不带检测，拿干净的结果与指标；一遍带上 racecheck 查竞态。
带检测的那一遍**不进指标**，否则每个门槛都会翻倍。这也正是现实里用
compute-sanitizer 的方式 —— 它慢两三倍，不会挂在正常跑的路径上。

命令行也给真的：终端里 `compute-sanitizer --tool racecheck ./bench` 能跑，
输出格式贴上游。**这既是判定，也是一关的教学内容**（第 3 关会故意让学员先写出一个竞态）。

---

## 十、后半程的 GPU 集群（问题 3）

### 规模与拓扑

默认世界：**2 个节点 × 8 张 GPU = 16 张**，可按关卡扩到 4×8 = 32。

```
节点 A                                  节点 B
┌──────────────────────────┐            ┌──────────────────────────┐
│ GPU 0..7                 │            │ GPU 0..7                 │
│   ↕ NVSwitch（全互联）    │            │   ↕ NVSwitch（全互联）    │
│   每卡 900 GB/s 双向      │            │                          │
│ ┌──────┐                 │            │                          │
│ │ CPU  │── PCIe Gen5 ────┤            │                          │
│ └──────┘   64 GB/s       │            │                          │
│   ↕ 8 × ConnectX NIC     │            │                          │
└────────┬─────────────────┘            └────────┬─────────────────┘
         └──── InfiniBand NDR 400 Gb/s ──────────┘
                （XDR 800 Gb/s 可选）
```

**为什么是这三种链路**：因为「scale-up 走 NVLink（张量并行），scale-out 走 IB
（数据并行）」这条现实约束，是后半程一半关卡的题眼。
把张量并行跨了机，`gpu.comm.bytesByLink.ib` 立刻暴增 —— 门槛直接抓得住。

### 链路建模

每条链路三个参数：**带宽**、**延迟**、**每消息固定开销**。

```
传输耗时 = 固定开销 + 延迟 + 字节数 / 有效带宽
```

- 有效带宽 = 标称带宽 × 效率因子（NVLink 0.85 / IB 0.90，参数化）
- 同一条链路上并发的多个传输**按带宽平分**（简化，不做拥塞控制）
- 全部挂在虚拟时钟上，多卡并发天然确定

参考数值（写在世界定义里，可按型号换）：

| 链路 | 带宽（单向） | 延迟 | 来源 |
| --- | ---: | ---: | --- |
| NVLink 4（H100，18 条 × 25 GB/s） | 450 GB/s | 1.5 µs | 单卡 900 GB/s 双向 |
| NVLink 5（Blackwell，18 × 50 GB/s） | 900 GB/s | 1.5 µs | 单卡 1.8 TB/s 双向 |
| PCIe Gen5 x16 | 64 GB/s | 3 µs | — |
| InfiniBand NDR | 50 GB/s（400 Gb/s） | 5 µs | — |
| InfiniBand XDR | 100 GB/s（800 Gb/s） | 5 µs | ConnectX-8 |

### 集合通信

**接口用 NCCL 的真形状**：

```c
ncclCommInitAll(comms, nDev, devs);
ncclGroupStart();
for (int i = 0; i < nDev; i++)
  ncclAllReduce(sendbuf[i], recvbuf[i], count, ncclFloat, ncclSum, comms[i], streams[i]);
ncclGroupEnd();
```

覆盖：`AllReduce` / `AllGather` / `ReduceScatter` / `Broadcast` / `Reduce` /
`Send` / `Recv` / `AllToAll`（通过 group 里的 send/recv 对），
以及 MoE 用的 `ncclEpDispatch` / `ncclEpCombine`（2026 年的真接口，见 stack 文档）。

**算法真做**：ring、tree、双二叉树。第 20 关让学员**自己用 p2p 拼一个 ring all-reduce**，
第 21 关再换成 NCCL —— 于是 `busbw` 那个 `2(n-1)/n` 的修正因子不是一个公式，
是他自己数出来的步数。

### 并行策略覆盖

| 策略 | 关卡 | 门槛抓什么 |
| --- | --- | --- |
| 数据并行 DP | 23 | 梯度 all-reduce 的通信量、busbw |
| 张量并行 TP（列并行 + 行并行） | 24 | 每层两次 all-reduce 的字节数；**必须留在机内** |
| 序列并行 SP | 25 | 激活显存下降，且通信量不增（all-reduce 拆成 reduce-scatter + all-gather） |
| 流水线并行 PP（1F1B / interleaved） | 26 | 气泡率、峰值显存 |
| 通信计算重叠 | 27 | 重叠率、MFU |
| 专家并行 EP（MoE all-to-all） | 28 | 通信量、负载不均、MFU |
| 上下文并行 CP | 选修 | 长序列的注意力切分 |

显存优化贯穿：激活重算、优化器状态切分（ZeRO 风格）、KV cache 的跨卡分布。

---

---

## 实施回填：设计与实现对不上的地方

29 关做完之后，把开发过程中发现的、与本文原有说法不符的地方记在这里。
**留着原文再补更正，而不是直接改掉** —— 哪一条当初想错了、为什么，
比一份看起来一直正确的文档有用。

### 1. GPipe 与 1F1B 的气泡率并不相同

原文（第 26 关那一行）写的是「朴素 GPipe 是 0.5+」，而写关卡时我一度
以为两者气泡率相同、1F1B 只赢在显存。**两个说法都不对。** 实测（P=8, M=32）：

| | 步数 | 气泡率 | 每卡显存 | 干活的格子 |
| --- | --- | --- | --- | --- |
| GPipe | 78 | 0.1795 = (P-1)/(M+P-1) | 8960 | 512 |
| 1F1B | 71 | 0.0986 = (P-1)/(2M+P-1) | 2816 | 512 |

教科书里「两者气泡率相同」的说法，是把一个 microbatch 的前向加反向
算成**一个**时间单位时才成立。按真实的步来数（前向一步、反向一步），
GPipe 的前向流水线要完全排空才开始反向，fill/drain 付了两次。

这个数是**数出来的**（`pipe_step()` 声明步边界，平台记每一步里
哪几张卡真的干了活），不是套的公式 —— 也正因为是数出来的，才发现原文错了。

### 2. 通信优化几乎从不降低通信总量

四期做下来最值钱的一条，原文没写：

| 关 | 总字节 | 消息数 | 分布 | 换来了什么 |
| --- | --- | --- | --- | --- |
| 22 手写 ring | 不变 | 涨 n 倍 | **摊开** | 瓶颈降 n/2 |
| 23 梯度分桶 | 不变 | **降** | 不变 | 每消息开销 |
| 25 序列并行 | **不变** | 不变 | 不变 | 显存与计算降 n 倍 |
| 27 重叠 | 不变 | 不变 | 不变 | **时机** |

四次通信优化，总量一次都没降。集合通信的总量由算法语义定死，
能动的只有分布、粒度、时机，以及用哪个集合操作把它接到别的优化上。

### 3. 通信必须按**设备端口**计量，不能按链路对

原文第十节写的是「同一条链路上并发的多个传输按带宽平分」。
按链路对记的话，「朴素 all-reduce 里 0 号卡是瓶颈」这件事**完全看不出来** ——
因为 0-1、0-2、0-3 是三条不同的链路，看起来是并行的。
真硬件上一张卡的 NVLink 端口带宽是总的，不管对面是谁都共享。
实现改成按卡记，并加了 `comm.maxDeviceBytes`。

### 4. 流的建模边界

第 27 关需要流。这个子集**即时执行**：kernel 在 launch 那一刻就跑完了，
流不改变执行顺序，也**不检测跨流的数据竞争**。流在这里的作用是记账 ——
平台据此回答「发起这次集合通信时，别的流上还有没有计算在飞」。

这条偏差写在 `cuda_runtime.h` 与第 27 关正文里。与其做半个能用的
竞争检测，不如把边界说清楚：真卡上漏建流间依赖，和第 3 关那个共享内存
竞态是同一类错误 —— 结果稳定地错，看起来像是算法不对。

### 5. 一个自己踩的坑：int 里存指针

第 22、23、27 关的参考解一度都用 `int buf[8]` 存设备指针，然后
`buf[d] + n` 做偏移。这是**正确的 C 语义**（int 不是指针，加法按字节），
但不是我要的意思。于是那三关的参考解在第一块之外全是错的 ——
而用例只检查每张卡的**第 0 个元素**，第 0 块两种算法落点相同，所以一路全绿。

是第 29 关的开发过程把它顶出来的。三关改用 `float* buf[8]`，
并把用例查全（整段求和、位置相关的填充、按散布位置做加权和）。
每一条都反向验证过：把类型改回 `int`，加强后的用例确实挂。

**这件事的教训不在指针语义上，在用例的强度上。** 判定只查一个点时，
一整类「偏移算错」的实现会全绿通过。

## 十一、内容大纲（问题 4）

29 关，4 期（21 关单卡 + 8 关集群）。**依赖链是硬的**：后一关解决前一关暴露出来的具体问题，
每关的题面开头就是「上一关你做完之后，`ncu` 里那个数字还是不对，因为……」。

场景：一家公司要自建 LLM 推理服务。第 1–21 关在一张 H100 上，第 22–29 关摊到 16 张卡。

| # | 主题 | 判定重点 | 门槛指标 | 期 |
| --- | --- | --- | --- | --- |
| 01 | 第一个 kernel —— 线程 / 块 / 网格与边界 | 结果正确；非整除的尾块不越界 | `sanitizer.oob = 0`；`inst.executed` 不超过朴素上限（防止一个线程串行做完全部） | 一 |
| 02 | 访存合并 —— 同一份拷贝，换个下标慢 8 倍 | 结果正确 | **`global.sectorsPerRequest ≤ 4.5`**（朴素版是 32）；`dram.bytesRead ≤ 理论值 × 1.1` | 一 |
| 03 | 共享内存与竞态 —— 矩阵转置的 tiling | 结果正确 | `sanitizer.races = 0`（起始代码故意漏一个 `__syncthreads()`）；`sectorsPerRequest ≤ 4.5` | 一 |
| 04 | bank conflict —— 同一份 tiling，加一列 padding | 结果正确 | **`smem.bankConflicts = 0`**（padding 前是 31 路）；`smem.bytesPerBlock ≤ 48KB` | 一 |
| 05 | warp 发散与 warp 原语 —— 块内规约 | 结果正确；误差界内 | **`warp.divergentBranches ≤ N`**；`atomics ≤ gridDim`（逼出 shuffle 规约而不是每线程 atomic） | 一 |
| 06 | occupancy 与寄存器压力 —— 为什么加了个局部数组就慢了 | 结果正确 | **`local.bytes = 0`**（动态下标数组必须消掉）；`occupancy.theoretical ≥ 0.5` | 一 |
| 07 | 朴素 GEMM —— 先跑通，看 roofline 落在哪 | 结果正确，`maxRelError ≤ 2e-5` | `arithmeticIntensity` 记录为 baseline（不设门槛，这一关是立标杆） | 二 |
| 08 | 共享内存分块 GEMM | 同上 | **`dram.bytesRead ≤ baseline / 8`**；`bankConflicts = 0` | 二 |
| 09 | 寄存器分块与线程粗化 —— 每线程算 4×4 | 同上 | **`arithmeticIntensity ≥ 8`**；`local.bytes = 0`；`speedupVsBaseline ≥ 3` | 二 |
| 10 | 双缓冲与异步拷贝 —— 让搬运和计算重叠 | 同上 | **`overlap.ratio ≥ 0.6`**；`syncthreads` 次数不增 | 二 |
| 11 | Tensor Core —— 混合精度 MMA 与累加精度 | `maxRelError ≤ 1e-2`（bf16 输入，fp32 累加） | **`inst.mma > 0` 且 `inst.fma` 降到阈值以下**；`speedupVsBaseline ≥ 4` | 二 |
| 12 | Softmax —— 数值稳定与两遍变一遍 | 无 inf/nan（输入含大值）；误差界内 | **`dram.bytesRead ≤ 2 × 张量字节`**（三遍变两遍或一遍）；`divergentBranches ≤ N` | 二 |
| 13 | LayerNorm / RMSNorm —— Welford 单遍与向量化访存 | 误差界内 | `dram.bytesRead ≤ 2 × 张量字节`；`sectorsPerRequest ≤ 4.5` | 二 |
| 14 | 算子融合 —— bias + GELU + residual 一趟做完 | 误差界内 | **`launches ≤ 1`**；`dram.bytesRead + bytesWritten ≤ 融合前的 1/3` | 二 |
| 15 | 朴素注意力 —— 亲手把显存打爆 | 小 seq 正确；大 seq **必须** OOM | `memory.peakBytes` 记录为 baseline（O(S²)） | 三 |
| 16 | FlashAttention —— 分块 + online softmax，不物化 S | 误差界内（`maxRelError ≤ 5e-5`） | **`memory.peakBytes ≤ O(S) 量级`**；`dram.bytesRead ≤ baseline / 10`；`bankConflicts = 0` | 三 |
| 17 | KV cache 与 decode —— 从 GEMM 到瘦长 GEMV | 结果正确 | **带宽利用率 ≥ 0.7**（decode 是访存瓶颈，不是算力瓶颈）；`arithmeticIntensity < 2`（认清自己） | 三 |
| 18 | 分页 KV cache —— 块表、前缀缓存 | 结果与连续版一致 | **`memory.fragmentationRatio ≤ 0.05`**（连续分配版是 0.4+）；`kvcache.prefixHitRatio ≥ 0.8` | 三 |
| 19 | 量化 —— FP8 与 NVFP4 微缩放块 | 相对 fp16 的输出困惑度退化在界内 | **`dram.bytesRead ≤ fp16 版 / 3.5`**；`numeric.maxRelError` 在题给界内 | 三 |
| 20 | CUDA Graph 与引擎组装 —— 单卡端到端 | 端到端输出与参考一致 | **`launchOverheadNs ≤ 总时间的 5%`**；`mfu ≥ 0.35`；吞吐门槛 | 三 |
| 21 | 连续批处理调度器 —— chunked prefill 与抢占 | 所有请求都完成且输出正确 | **TTFT p99 ≤ 阈值**；吞吐 ≥ 阈值；无饿死（每个请求的等待步数有上界） | 三 |
| 22 | 多卡与 p2p —— 手写 ring all-reduce | 结果与单卡一致 | **`comm.bytes` 恰好等于 `2(n-1)/n × S`**（写错成 all-gather 就超）；`busbw ≥ 阈值` | 四 |
| 23 | NCCL 与数据并行 —— 换成真接口，加梯度分桶 | 同上 | `busbw ≥ 手写版`；**`comm.messages ≤ 分桶数`**（不分桶会发几百条小消息） | 四 |
| 24 | 张量并行 —— 列并行 / 行并行，all-reduce 该放在哪 | 输出与单卡可比（误差界内） | **`comm.bytesByLink.ib = 0`**（TP 不许跨机）；**每层 all-reduce 次数 = 2**（先列后行才做得到，写反了是 4 次） | 四 |
| 25 | 序列并行 —— 把 all-reduce 拆成 reduce-scatter + all-gather | 输出与第 24 关一致 | **`memory.peakBytesPerRank` 较第 24 关降 ≥ 30%**；`comm.bytes` 不增（拆开不该变贵） | 四 |
| 26 | 流水线并行 —— 1F1B | 输出正确、干活的格子数不少 | **`pipeline.bubbleRatio ≤ 0.12`**（GPipe 实测 0.1795）；`memoryPeakBytes ≤ 4KB`（GPipe 8960） | 四 |
| 27 | 通信与计算重叠 —— 分块 + 多流 | 输出正确 | **`comm.overlapRatio ≥ 0.7`**（先算完再发是 0）；通信总量不变 | 四 |
| 28 | 专家并行 MoE —— 容量因子与重路由 | token 一个不丢 | `imbalance.maxOverMean ≤ 1.3`（严格按路由实测 2.758） | 四 |
| 29 | 分离式部署与容错 —— prefill/decode 分离，掉一张卡 | 掉卡后服务不中断，输出仍正确 | 恢复时间 ≤ 阈值；掉卡期间 SLO 违约请求数 ≤ 阈值 | 四 |

> 上表 29 行。原先的路径草稿是 26 关，写下来发现「连续批处理调度器」和
> 「分离式部署与容错」各自撑得起一关；后来复核又把「张量并行 / 序列并行」拆成两关。

### 关卡数的复核：为什么最后不压

初稿在这里提过「要压回 24 关就合并 12+13 与 22+23」。
**那是工期驱动的直觉，不是发现了薄关卡。** 认真审一遍，我自己提的两组合并一组都不成立：

| 提议合并 | 审下来 | 结论 |
| --- | --- | --- |
| 12 Softmax + 13 LayerNorm | 表面都是「沿最后一维规约」，实际教的是两套东西。12 教**数值稳定**（减最大值防 inf/nan）与**在线单遍规约**，而 online softmax 是**第 16 关 FlashAttention 的唯一前置**；13 教 **Welford 单遍方差**（和 online softmax 是不同的算法）、**向量化访存**（`float4`）、以及 RMSNorm 与 LayerNorm 的区别（现代 LLM 用 RMSNorm）。合并等于砍掉 Welford，或者压薄整条注意力线的地基 | **不合并** |
| 22 手写 ring + 23 NCCL | 22 的回报是学员**自己数出** `2(n-1)/n` —— 这个因子一旦是数出来的，后面六关的 busbw 门槛才是有意义的量而不是一个公式。23 的回报完全不同：NCCL 真 API 的形状（group 语义、流序异步）+ 梯度分桶（为什么按参数的**反向顺序**分桶、桶多大、25 MiB 这个默认值从哪来）。两件事塞一关会撑爆 | **不合并** |

再逐关扫一遍找薄的，**发现压力方向是反的** —— 有四关是超载而不是偏薄：

| # | 超载在哪 | 处理 |
| --- | --- | --- |
| 19 量化 | FP8 + NVFP4 + 微缩放块 + 校准，四件事 | 先按一关写，出题时看 goal 能不能一屏放下 |
| 20 CUDA Graph + 引擎组装 | 图捕获是一课，把整个引擎拼起来是期三的收官，是另一课 | 同上 |
| **24 TP + SP** | TP 本身就是集群部分最重的概念（列并行 / 行并行、为什么 MLP 先列后行才能只做一次 all-reduce、注意力头怎么切）；SP 是另一个独立优化（all-reduce 拆成 reduce-scatter + all-gather，通信量不变但激活显存降） | **已拆成第 24 / 25 两关 → 全项目 29 关** |
| 29 分离式部署 + 容错 | 两件事 | 先按一关写 |

**判据（建议写进出题规范）：一关如果有两个门槛，学员可能过了其中一个、
却因为完全无关的原因挂了另一个，那它就该是两关。**
按这条，24 明确该拆 —— 「TP 不许跨机」和「SP 后激活显存降 30%」是两件不相干的事。

**工期差**：内容部分在 7–9 个月里约占 3 个月，砍 4 关 ≈ 3 个月 × 4/28 ≈ **两周**，
占整个项目 4–5%。而且要砍的四关全在**期四**，是最后才做的 ——
现在砍不省任何工期，只是提前放弃了选项。

**已按此拆分**：第 24 关拆成「张量并行」与「序列并行」，原 25–28 关顺延为 26–29，
全项目 29 关。19 / 20 / 29 三关先按一关写，出题时再看要不要拆。

### 埋线与回收

沿用 opslab 的做法，几处故意的坑：

- 第 3 关的起始代码**漏一个 `__syncthreads()`**，而且在我们的模拟器里
  「跑出来是对的」—— 只有 racecheck 抓得到。这一关的真正内容就是这个。
- 第 6 关的起始代码里有个 `float tmp[8]` 被动态下标访问，于是溢出到 local memory。
  `ncu` 上看 occupancy 正常、指令数正常，只有 `local.bytes` 不对。
- 第 15 关**必须失败**：seq=4096 时朴素注意力 OOM。这是第 16 关存在的理由。
- 第 24 关的世界里，如果学员把 TP 组开成 16（跨机），
  拓扑图上 IB 那条边直接变红，`comm.bytesByLink.ib` 门槛挂掉。

---

## 十二、判定管线与反向验证

**完全复用 ops 那一套**，只换判定用的世界：

```
关卡的隐藏用例（TS）→ import '@gpu/lab' → 读世界 → 断言 → StageRunReport
```

`@gpu/lab` 的形状对着 `@ops/lab` 抄：

```ts
export interface GpuLabApi {
  sh(cmd: string): Promise<{ stdout, stderr, code }>;   // 敲 nvcc / ncu / compute-sanitizer
  compile(path: string): CompileResult;                  // 编译诊断
  launch(name: string, config, args): Promise<KernelRun>; // 平台自己发起一次执行
  metrics(): GpuMetrics;                                 // 全部计数器
  device(i: number): DeviceView;                         // 显存、驻留、分配
  memory(ptr, count, type): number[];                    // 读设备内存来对答案
  reference(name: string, args): Float64Array;           // fp64 参考实现
  transcript(): CommandRecord[];
  world: GpuWorld;
}
```

**一处必须新增的能力**：`runOpsStage` 现在**永远返回 `gates: []`** ——
ops 关卡不走指标门槛。gpulab 的门槛是主角，所以要把
`evaluateGates(...)`（`src/lib/engineering/runner.ts:164`）接进 gpu 的 runner，
并给 `LabMetrics` 加 `gpu` 子树。这是一处小而必要的平台改动。

**反向验证不变**：每关带一份 `referenceKernel`（参考的 `.cu`）与参考命令。
跑参考解 → 用例与门槛必须全绿；跑起始代码 → 必须挂。`projects:verify` 进 CI。

**golden 这次不一样**：opslab 的 golden 来自真集群录制。GPU 这边没有真卡，
但也**不需要**：

| 要验的东西 | 怎么验 | 要卡吗 |
| --- | --- | --- |
| 数值正确性 | fp64 参考实现，仓库内算 | 不要 |
| 结构性计量（DRAM 字节、bank conflict…） | **解析可推**：一个完美合并的拷贝必须恰好读 N×4 字节，写成单元测试 | 不要 |
| 竞态 / 越界检测 | 构造已知有竞态的 kernel，必须抓到 | 不要 |
| 时序模型 | **只能做相对校准** | 有卡更好 |

时序模型的校准是这个方案里唯一「没有真值」的地方。缓解办法有三条：
门槛不建立在它上面（第一节的硬规矩）；参数表对着
[Accel-Sim 公开的、经真机校准的配置](https://github.com/accel-sim/gpgpu-sim_distribution)取；
如果将来能借到一张卡，写一个校准脚本跑十来个已知 kernel 对一轮。

---

## 十三、工程量与分期（问题 5）

约 **26,500 行 TypeScript**（不含关卡内容），比 opslab 的 55,000 小一半，
主要因为 L0 + L1 白拿、而且没有 Go → WASM 管线。

| 层 | 估算 | 说明 |
| --- | ---: | --- |
| 复用 opslab（L0 内核 + 机器层 + 终端 + 判定管线） | **0** | 约省 8,000 行 |
| CUDA C 前端（tree-sitter → 类型检查 → IR） | 4,000 | 解析白拿，剩下是语义分析与降级 |
| warp 锁步 VM + 内存层次模型 | 5,000 | 核心；含合并分析、bank 冲突、发散栈、屏障 |
| 浮点与低精度（fround / 自写超越函数 / fp16 / bf16 / fp8 / fp4） | 1,200 | |
| 时序模型（SM 调度、发射、访存流水、Tensor Core） | 2,500 | trace-driven，与 VM 解耦 |
| sanitizer（racecheck / memcheck / synccheck） | 1,200 | 影子内存 + 纪元 |
| 设备运行时（malloc / memcpy / 流 / 事件 / 图 / 分配器） | 1,500 | |
| 互联与 NCCL（链路模型 + ring/tree 算法 + EP 原语） | 2,500 | |
| 剖析器与指标聚合（ncu 分节、roofline、指标树） | 1,800 | |
| UI 面板（剖析 / 访存热图 / bank 视图 / 时间线 / 集群拓扑） | 5,000 | 图表用 recharts，拓扑复用 xyflow 的做法 |
| 判定接入（`@gpu/lab`、gates 接进 gpu runner、世界装配） | 1,300 | |
| 内容工具（baseline 录制、误差界推导、反向验证脚本） | 1,000 | |
| **合计** | **≈ 26,000** | |

单人纯开发 **4–6 个月**，含 29 关内容约 **7–9 个月**；两人并行约 4 个月。

### 四段节奏

**第一段 · Spike（2–3 周）—— 命门验证**
这一轮的原型只验了解析与执行预算，还有三件事必须在动内容之前证明：

1. **端到端一条竖切**：一个真 `.cu` 文件 → 编译 → 执行 → 出正确结果 →
   出 DRAM 字节与 bank conflict 计数 → 一个门槛通过 / 失败。
   拿第 2 关（访存合并）当靶子，因为它最能验证「计量真的能证明优化生效」。
2. **确定性**：同一个 kernel 跑 1000 次，结果与全部计数器逐位一致
   （opslab 的教训：这是必须进 CI 的门禁）。
3. **竞态检测**：故意漏 `__syncthreads()` 的分块转置，必须被 racecheck 抓到，
   且报出正确的两条行号。**这一条不过，整个方案的教学价值不成立。**

**第二段 · 单卡核心（2–3 个月）**
VM 完整、内存层次、时序模型、sanitizer、nvcc 前端、ncu 面板、访存面板，
第 1–11 关（到 Tensor Core）。

**第三段 · 算子与引擎（2 个月）**
低精度、异步拷贝、显存分配器、流与图、第 12–21 关。

**第四段 · 集群（2 个月）**
互联模型、NCCL、并行策略、拓扑与通信时间线面板、第 22–29 关。

### 风险

| 风险 | 缓解 |
| --- | --- |
| **竞态检测做不对** —— 学员写出真卡上必错的 kernel 却全绿通过，方案的价值主张直接破产 | 第一段就验；影子内存 + 屏障纪元是成熟做法；用一组已知有/无竞态的 kernel 做回归 |
| **时序模型没有真值可校准** | 硬规矩：门槛不建立在模拟耗时上（第一节）。参数对 Accel-Sim 的公开配置 |
| 执行慢到不能忍 | 原型已量：256³ GEMM 66ms。关卡规模按「5000 万 lane 指令」上限设计；判定放 Web Worker |
| CUDA C 子集不够用，学员写正常代码却报「未实现」 | 每一关的参考解都必须只用子集内的语法；子集清单写进 primer；未实现的语法给**明确的**报错而不是解析失败 |
| 寄存器数是估的，occupancy 门槛可能不公平 | 寄存器数只作展示；门槛用 `local.bytes`（精确）与 `occupancy.theoretical`（给定估计后精确） |
| 浮点确定性 | 全部过 `Math.fround`；超越函数自己实现，不碰 JS 的 `Math.exp` |
| 上游漂移（这个领域半年翻篇） | 选型集中在 [gpulab-stack.md](./gpulab-stack.md)，标注核实日期与来源 |
| AI 生成这类项目 | 明确不支持，生成器继续只产 `kind: 'code'` |
| 与 opslab 抢工期 / 改到同一批文件 | 复用点是**只读复用**（kernel / machine / 判定管线），只有一处要动共享代码（gates 接进 runner），可以先单独提一个小 PR |

---

## 十四、已定的设计决策

| 决策 | 结论 |
| --- | --- |
| 工作台抽象 | `WorkspaceKind` 加 `'gpu'` 一支，六块面板按关卡显隐；不做布局 DSL |
| 学员写什么 | 真 CUDA C（C99 子集 + CUDA 扩展），设备端与宿主端同一套语言 |
| **宿主语言** | **全 CUDA C，不引入双语言**；啰嗦用「只读 `containers.h` + 只读骨架 + 填空函数」解决 |
| 怎么执行 | 编到扁平 IR，**warp 锁步字节码 VM**；不转译成 JS（只快 1.5 倍，却丢掉单步、可视化与确定性控制） |
| 解析 | `tree-sitter-cuda`（MIT，自带 wasm，原型 0 error），复用现有 web-tree-sitter 加载路径 |
| 功能 / 时序 | 分离（Accel-Sim 式 trace-driven），时序模型不反馈影响执行 |
| 门槛的地基 | **只用结构性计量**；模拟耗时只做展示与同关相对比较 |
| 指标命名 | 对齐 Nsight Compute 与 nccl-tests 的原名 |
| 数值正确性 | fp64 参考 + 理论误差界 + 「两遍逐位一致」的确定性门槛 |
| 竞态 | **必须做**，等价 compute-sanitizer 的三个 tool，门槛恒为 0 |
| 超越函数 | 自己实现，不用 JS `Math.*`（否则跨引擎不确定） |
| **关卡数** | **不压缩；第 24 关拆成 TP 与 SP 两关 → 全项目 29 关** |
| **建模架构** | **一套 ISA（Hopper SM90）+ 两组硬件参数（H100 / B200）**；不做 tcgen05 第二套 ISA |
| **Tensor Core** | 接口用 `wmma`；时序上把 **Tensor Core / SFU / LSU / ALU 分成四个独立单元**并允许异步重叠；TMEM 只做容量约束 |
| **Triton 子集** | **不做**。写进 primer，不写进工作台；IR 是将来要加时的正确接缝 |
| **时间线面板** | **做**，但只做「每卡 / 每流一条泳道」的甘特图，并进集群面板；kernel 内部的时间线归「访存」面板 |
| **真卡校准** | **值得做，但不是前置**。先把 `speedupVsBaseline` 降级成宽松门槛，让判定在没卡时也成立；再花约二十美元租一下午 H100 拟合时序参数 |
| **代码复用** | **移动，不抽象**：把 `opslab/kernel/`（630 行）与 `opslab/machine/` 里非 OCI 的部分（约 2543 行）原地上移到 `src/lib/labkit/`，单独一个零行为变化的 PR；`oci/` 留在 opslab |
| 集群规模 | 默认 2 节点 × 8 卡 = 16，可扩到 32；NVLink / PCIe / IB 三种链路 |
| 集合通信 | NCCL 真接口 + 真算法；第一关先让学员手写 ring |
| 代码位置 | `src/lib/gpulab/`，与 `src/lib/opslab/`、`src/lib/labkit/` 平级 |
| 项目 id | `llm-accelerator`（`projects/definitions/llm-accelerator.js`） |

---

## 十五、拍板记录

八条全部有推荐了。1 与 3 已经拍过，其余六条的论证记在这里。

### 1 · 宿主语言 —— 全 CUDA C ✅ 已定

初稿把宿主关卡数估成 3 关，实际是 **11 关（整个后半程）**；正因为量这么大，
才更不能用「个别关卡开个口子」搪塞。三条理由：TS 的 `await` 会把 NCCL 的流序异步与
group 死锁**教反**；分页 KV 的块表本来就该是设备可见的扁平数组，用 C 写更真；
净成本只差约 400 行。完整论证见「六、宿主代码占多大比重」。

### 3 · 关卡数 —— 不压，29 关 ✅ 已定

「压到 24」是工期驱动的直觉，不是发现了薄关卡，而且我自己提的两组合并一组都不成立。
逐关扫下来压力方向是反的：第 24 关（TP + SP）超载，**已拆成第 24 / 25 两关**，
原 25–28 顺延为 26–29。完整论证见「十一、关卡数的复核」。

### 2 · 建模架构 —— 一套 ISA，两组参数

**这条在决定什么**：不是「用哪张卡的性能数字」，而是**学员被教哪一套编程心智模型**。
Hopper 是「同步的 `wmma` + `cp.async` 双缓冲」；Blackwell 是「全异步 `tcgen05` +
TMEM + warp 专业化」—— 后者是一套明显更难的模型。

| 选项 | 得 | 失 |
| --- | --- | --- |
| A. Hopper 为唯一完整建模 | 文档公开完整可引用；心智模型可以一步步长出来；覆盖绝大多数人的实际工作 | 讲不清 FA4 为什么长成那样 |
| B. Blackwell 为主 | 最贴 2026 年新集群 | 学员一上来就面对 warp 专业化，「为什么需要它」变成被告知而不是被推导；`tcgen05` 细节大量来自逆向工程，与本方案「参数要有出处」的要求冲突 |
| **C. 一套 ISA（Hopper）+ 两组硬件参数** | A 的全部好处，且第 16 关能让学员**同一份 kernel 换一张卡跑**，亲眼看到瓶颈从访存移到 SFU | 不能手写 `tcgen05` —— 但几乎没人手写 |

**推荐 C。** 三条具体理由：

1. **依赖链论证**（这个项目的核心方法论）：Blackwell 的 warp 专业化之所以存在，
   是因为 Hopper 的模型在更快的 tensor core 面前不够用了。
   FA3 在 Blackwell 上**根本跑不了**（WGMMA 没了，换成 TCGEN05）——
   这是极好的教学时刻，但前提是学员先写过 Hopper 版。先教 Blackwell 等于先给答案。
2. **现实论证**：2026 年几乎没有人手写 `tcgen05`，那是 CUTLASS / FA4 的领域，
   真实工作流是用 CuTe DSL 或 Triton。建模一套几乎没人手写的 ISA 是典型的堆砌。
3. **出处论证**：[Hopper Tuning Guide](https://docs.nvidia.com/cuda/hopper-tuning-guide/index.html)
   是公开完整的；Blackwell 的 `tcgen05` 细节大量来自逆向工程
   （Modal 那篇标题就叫 "reverse-engineer"）。本方案要求参数有出处，Hopper 满足。

**「两组硬件参数」具体是什么**：世界定义里给第二档硬件 —— 更高的 MMA 吞吐、
**不变的 SFU 吞吐**、TMEM 容量。第 16 关学员把自己的 FlashAttention 换到 B200 上跑，
roofline 的瓶颈自己从访存挪到 SFU —— 于是 FA4 的 ping-pong 不是一个典故，
是他自己量出来的问题。**零新 ISA，纯参数。**

**影响到什么**：这条决定了第 11、16 关的形态；也决定了如果将来要做
「Blackwell warp 专业化」关卡，它是第五期的新增而不是第一期的返工。

### 4 · Tensor Core 建模层次 —— `wmma` 接口 + 四单元时序 + TMEM 容量

**这条在决定什么**：学员能不能亲身经历「tensor core 快到让别的东西成为瓶颈」——
这是现代内核优化的中心事实，也是 FA4 存在的理由。

推荐三点，合起来增量 **< 400 行**：

1. **学员写的接口只到 `wmma`**（`load_matrix_sync` / `mma_sync` / `store_matrix_sync`）。
   不做 `tcgen05`，也不做 PTX `mma.sync` 的 fragment 元素布局 ——
   **真硬件的 fragment 布局官方就是未定义的**，这正是 `wmma::fragment` 是不透明类型的原因；
   我们定义自己的布局，比假装存在一个「真布局」更诚实。
2. **时序模型里必须把 Tensor Core / SFU / LSU / ALU 分成四个独立单元**，
   各有各的吞吐，且允许异步重叠发射。这是**唯一**能承载主线的地方 ——
   没有它，第 11 关的「用上 tensor core 之后 FMA 指令数塌下去」只是个指令计数游戏，
   学员看不到紧接着「softmax 的 `exp()` 成了新瓶颈」。而这正是
   [PyTorch 官方博客](https://pytorch.org/blog/flexattention-flashattention-4-fast-and-flexible/)
   描述 FA4 的原话：tensor core 变快了，SFU 没跟上。
3. **TMEM 只建模成「一块容量有限、要显式分配释放的暂存空间」**（约 150 行）。
   第 16 关讲 FA4 的 backward「TMEM 装不下全部累加器，所以要精心流水」时，
   这个容量约束能**真的卡住**学员，而不是只在 primer 里说一句。

**影响到什么**：第 2 条（四单元异步发射）同时是「将来要做 Blackwell warp 专业化关卡」
的前置。选了它，那扇门是开着的；不选，将来要重做时序模型。

### 5 · Triton 子集 —— 不做

**这条在决定什么**：项目教一门语言还是两门。

**推荐不做**，理由不是省工期，而是**自相矛盾**：

- Triton 的编程模型是 **block 级而不是 thread 级** —— 学员不写 `threadIdx`，
  `tl.load` 直接搬一整块。这意味着它**恰好隐藏了本项目第 2–6 关的全部内容**：
  合并访问、bank conflict、发散、occupancy 全由编译器替你决定。
  在一个「用平台侧计量证明优化真的生效」的项目里，加一门「让编译器替你优化」的语言，
  是把自己的立论抽掉。
- 成本也不小：Python 子集前端约 2000 行 + Triton tile 语义降级到我们的 IR 约 1500 行，
  合计约 3500 行，只服务一两关。

**但 Triton 在 2026 年确实重要**（`torch.compile` 的融合全走 Triton，
Liger-Kernel 整个是 Triton），所以**写进 primer，不写进工作台**：
讲清 Triton / Gluon / Helion / CuTe DSL / CUTLASS C++ 各自在「抽象 ↔ 性能」上的位置，
并举一个有出处、能说明边界的例子 —— **FA4 从 Triton 退回 CuTe DSL，
是因为 Blackwell 的 TMA / TMEM 需要 tile 级控制，而 Triton 的抽象暴露不出来**。
这比让学员写 20 行 Triton 有价值得多：它回答的是「什么时候必须下到 CUDA C」，
而那正是这个项目存在的理由。

**影响到什么**：**IR 是正确的接缝**。将来真要加，Triton 降级到同一套 IR，
全部计量、可视化与门槛一行都不用改。所以这是「推迟」，不是「关门」。

### 6 · 时间线面板 —— 做，但只做泳道甘特图

**这条在决定什么**：`overlap.ratio = 0.42`、`pipeline.bubbleRatio = 0.38`
这两个数字，学员能不能看懂**为什么**是这个数。

**推荐做。** 理由：

- **1F1B 流水线调度本质上是一张图** —— 所有教材都用 warmup / steady / cooldown 的
  甘特图讲它。看不见图，学员就是在盲调一个数字，这跟「优化必须可见」的立论相悖。
- 覆盖面大：第 20、22–29 共 9 关，等于整个集群部分加上单卡的收官关。
- **成本低**：数据已经全在虚拟时钟上带着时间戳了，缺的只是渲染。
  约 800–1200 行含缩放、悬停、点击跳源码。

**边界**（这才是「不堆砌」的部分）：不做 nsys 的全部 —— 不做 CPU 侧采样、
不做 NVTX 树、不做完整 API trace。只做「每个 GPU / 每条流一条泳道，
kernel / memcpy / NCCL op 作为条带」。**并进集群面板，不新开第七块。**

**一处要澄清的**：kernel **内部**的时间线（block / warp 在 SM 上的驻留与阻塞）
不属于这个面板 —— 它已经在「访存」面板里了，第 10 关的双缓冲用的是那一个。
这块新面板管的是 kernel **之间**，所以它排在期三末尾（第 20 关）才需要，不占期一工期。

### 7 · 真卡校准 —— 值得做，但先让判定在没卡时也站得住

**这条在决定什么**：模拟耗时是「方向正确」还是「对着真值调过」。
因为硬规矩是门槛不建立在模拟时间上，所以它**不影响任何一条结构性门槛**。

**但这里有一个我要主动指出的漏洞**：第 9 关的 `speedupVsBaseline ≥ 3`
和第 11 关的 `≥ 4` 是仅有的两个例外 —— 它们是两个模拟时间的比值。
比值比绝对值稳健得多（系统性误差会抵消），但如果时序模型把 tensor core 吞吐
给错一个量级，比值也会翻车。

**推荐分两步，第一步不管有没有卡都要做**：

1. **把这两关的主门槛换成本来就精确的那些** —— 第 9 关用
   `arithmeticIntensity ≥ 8` 与 `local.bytes = 0`；第 11 关用 `inst.mma > 0`
   与 `inst.fma` 塌到阈值以下。`speedupVsBaseline` 降级成「展示 + 一个宽松到
   不可能被模型误差翻掉的门槛」（真值约 8 倍时门槛设 2）。
   这样一张卡都借不到，整套判定依然成立。
2. **然后去租一下午卡**。H100 按需 **$1.99–$3.29/hr**（市场均价约 $3），
   跑十来个已知 kernel（copy、朴素/padded 转置、朴素/分块/寄存器分块 GEMM、
   softmax、layernorm、flash attention、规约）拟合时序模型的约 10 个参数，
   一个下午 **十几到二十几美元**。

**定位**：和 opslab 的 golden 录制同一个性质 —— **出题期工具，
学员端与 CI 都不依赖**。排在第二段末尾，不是前置。

### 8 · 代码复用 —— 移动，不抽象

**这条在决定什么**：gpulab 是「从 opslab 里 import」（读起来像 GPU 项目依赖 K8s 项目），
还是两者都从一个中立的地方 import。

**推荐：把目录原地上移到 `src/lib/labkit/`，但不设计任何新抽象。**

数过的范围：

| 目录 | 行数 | 去向 |
| --- | ---: | --- |
| `opslab/kernel/`（VirtualClock、Priority、settle / 死锁检测、种子 RNG） | 630 | **已上移** → `labkit/kernel/` |
| `opslab/machine/` 的 `vfs.ts` + `shell/` + `machine.ts` + `index.ts` | 约 2543 | **已上移** → `labkit/machine/` |
| `opslab/machine/oci/`（Dockerfile、镜像、registry） | 1691 | **已提到** `opslab/oci/` —— k8s 专用 |
| 合计移动 | **约 3170** | |

**为什么是「移动」而不是「抽象」**：两个消费者是好抽象的最低样本量，
但**你是在建第二个消费者的过程中才知道该抽什么**。现在设计接口，等于在没有第二个
用例的情况下猜接缝，猜错的代价比不抽还高。opslab.md 自己已经做过一次同样的判断
（「先放仓库内，接口按将来能独立设计」）。移动是机械的、可逆的；
抽象是一个现在还做不了的设计承诺。

**时机很重要**：opslab 正在活跃开发（23 关刚合入，仓库里还有别的会话在改文件），
一个跨 3170 行的移动是合并冲突炸弹。所以：**作为 gpulab 第一段的第一个 commit，
单独一个 PR，不夹带任何其他改动，挑一个 opslab 没有在途大特性的窗口做。**
仓库里有 11 个文件 import 这两个目录，全部在 opslab 内部，改 import 路径即可，
没有跨项目的连带。

**影响到什么**：真正的抽象（比如把「实验台」做成一个可注册的东西）留到 gpulab
第二段结束、两个消费者都跑起来之后再提取 —— 那时接缝在哪里是量出来的，不是猜的。
