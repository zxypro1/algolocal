# 从零实现一个 LLM 并完成预训练与后训练（llmlab）设计方案

> 状态：**设计已定稿，实施中**（八条全部拍板于 2026-08-31，见第十节）。
> 最后更新：2026-08-31。原型代码与可复跑的实测脚本在 [`llmproto/`](./llmproto/)，
> 技术选型的核实日期与来源见 [llmlab-stack.md](./llmlab-stack.md)。
>
> 放在 `design/` 而不是 `docs/`：后者是 GitHub Pages 的站点目录，
> `.github/workflows/deploy-pages.yml` 监听 `docs/**`，放进去会一并发布并触发部署。

## 这是什么

工程实战里的第三类新形态项目：**从零写一个 LLM，然后真的把它训出来。**

前半程从字节开始：BPE 分词 → 嵌入 → 自注意力 → 多头与 GQA → RoPE →
RMSNorm → SwiGLU → 完整 block → 带 KV cache 的自回归采样。
中段把它训起来：手写反向 → 自动微分 → AdamW → 调度与裁剪 → 数据打包 →
完整预训练循环 → 混合精度 → 激活重算 → 缩放定律 → MoE → Muon。
后半程做后训练：SFT → 数据配比与对齐税 → 奖励模型 → DPO →
长度偏置 → rollout 基础设施 → GRPO/RLVR → GRPO 的三个修正。

**和 gpulab（`llm-accelerator`）的关系是互补，不是重叠**：

| | gpulab | llmlab |
| --- | --- | --- |
| 一句话 | **让它跑得快** | **让它学会** |
| 学员写 | CUDA C 的 kernel 与宿主 | Python 的模型与训练循环 |
| 执行 | **模拟**一张 H100（warp 锁步 VM） | **真算**（WASM SIMD 算子核） |
| 门槛 | 访存字节、bank conflict、通信量 | 梯度检验、困惑度、KL、偏好准确率 |
| FlashAttention | 「这个 kernel 怎么写」 | 「为什么需要它」—— 峰值激活字节 |
| KV cache | 分页、碎片率、访存 | 每 token FLOPs 从 O(S) 降到 O(1) |
| 分布式 | 8 关（DP/TP/PP/EP） | **不做** |
| kernel 优化 | 全部内容 | **不做** |

两边在同一个交界面上各说各的那一半，学员两边都做完才拼得起完整的图。

---

## 一、判定标准：接口真实，实现可模拟

沿用 [opslab.md](./opslab.md) 与 [gpulab.md](./gpulab.md) 定下的地基，这里只写这个领域的具体含义。

**必须和真环境一致的**：

- 学员写的**语言与 API 形状**：`class Block(nn.Module)` / `def forward(self, x)` /
  `x.view(B, T, H, -1).transpose(1, 2)` / `F.softmax(s, dim=-1)` /
  `loss.backward()` / `optim.AdamW(params, lr=..., betas=(0.9, 0.95), weight_decay=0.1)`
- **算法本身**：BPE 的 merge 规则、RoPE 的旋转、AdamW 的偏差修正、
  DPO 的 loss、GRPO 的组内优势归一化 —— 全是真公式，不是简化版
- **术语与口径**：困惑度、`pass@k`、长度受控胜率、KL 散度、对齐税、
  容量因子 —— 用 HF / TRL / 论文里的原名
- **失败的样子**：warmup 不够就 loss 尖峰、DPO 会让答案越写越长、
  GRPO 不做 token 级 loss 就偏向短回答、SFT 会掉基础能力

一句话：**在这里写的每一行，换到 PyTorch 上照抄就能跑；
这里看到的每一个数，真训练里也是这么叫的。**

**必须提前说清的分叉**：

> **规模不可迁移。** 我们训的是 10 万到 100 万参数、语料几十万 token 的模型。
> 它学不会世界知识，跑不了 MMLU-Pro，也不会有涌现能力。
>
> 因此有一条硬规矩贯穿全案：
>
> **所有门槛只建立在「结构性计量」与「确定性重放下的学习效果」上，
> 绝不建立在墙钟时间上，也绝不建立在任何需要大模型才成立的现象上。**
>
> 结构性计量 = 给定实现后可以精确算出、与机器无关的量：
> 参数量、每 token 的 FLOPs、峰值激活字节、梯度检验的相对误差、
> KL 散度、偏好排序准确率、跨文档注意力泄漏数。
>
> 墙钟耗时只做两件事：**展示**（tokens/s、每步耗时），
> 以及**同一关内的相对比较**。

---

## 二、命门：浏览器里能不能**真的**训练（问题 1 的前半）

opslab 的命门是「真 kubectl 编成 WASM」，gpulab 的命门是「能不能在浏览器里执行 CUDA
并精确计量」。这个项目的命门是第三个：

> **能不能在浏览器里真的把一个 transformer 训到 loss 下降，
> 快到不难受、内存扛得住、而且两次跑逐位一致。**

这一轮做了原型回答它。以下全部是**本机实测**（darwin/arm64，Node v24.18.1，2026-08-31）。

### 结论一：反向是对的，但**梯度检验必须在 fp64 里做**

原型写了一个完整的 decoder-only transformer（RoPE + GQA + RMSNorm + SwiGLU + 权重共享），
**手写全部反向**，然后用中心差分做梯度检验：

| 精度 | 步长 | 全局最差相对误差 | 判读 |
| --- | --- | ---: | --- |
| fp32（`Float32Array` 存储） | 3e-3 | **4.99e-2** | 看起来像写错了 |
| fp64（`Float64Array` 存储） | 1e-5 | **6.79e-4** | 明显是对的 |

**同一份反向代码。** fp32 那个 5e-2 全是数值噪声：前向路径把激活量化到 fp32，
在数值导数上造出台阶，而 `wq`/`wk` 在初始化附近的梯度本来就小，
相对误差的分母也小，噪声被放得最大。

这条直接决定架构：**张量库必须支持 fp64 模式**，梯度检验关跑在 fp64 上。
不做这件事，第 9–11 关的门槛要么松到抓不住错，要么严到参考解自己都过不了。
（也顺带说明 gpulab「第九节：不主动检测就是假的」那条教训在这里的对应物是什么 ——
**不主动切 fp64，梯度检验就是假的**。）

### 结论二：纯 JS 的地板是 5 GFLOP/s，够但不够用

`Float32Array` 上手写 sgemm：

| 写法 | GFLOP/s |
| --- | ---: |
| 朴素 i-j-k | 2.8 |
| i-k-j（B 按行连续） | 3.0 |
| **4 行寄存器分块 + i-k-j** | **5.0** |

用这个核跑完整训练（前向 + 手写反向 + AdamW，全 JS）：

| 档位 | 参数 | tok/步 | ms/步 | 端到端有效 |
| --- | ---: | ---: | ---: | ---: |
| XS d=48 L=2 | 50,640 | 1024 | 103 | 2.9 GFLOP/s |
| S d=64 L=3 | 140,352 | 1024 | 274 | 3.0 GFLOP/s |
| M d=96 L=4 | 396,576 | 1024 | 749 | 3.0 GFLOP/s |

S 档 400 步要 **115 秒**。能训，但判定跑不起，学员也等不起。

### 结论三：**一个 504 字节的手写 WASM SIMD kernel 把地板抬了 9 倍**

用 `wabt`（构建期依赖）手写一段 `f32x4` 的 sgemm：

| 形状 | JS | **WASM SIMD** | 加速 |
| --- | ---: | ---: | ---: |
| 512×128×128 | 4.86 | **44.4** | 9.2× |
| 512×512×128 | 5.02 | **42.6** | 8.5× |
| 2048×256×256 | 5.01 | **42.2** | 8.4× |
| 256×256×256 | 3.91 | **42.3** | 10.8× |

逐元素与 JS 版最大差 1.8e-6（fp32 求和顺序不同，量级正确）。

把 sgemm 的三个变体（`NN` / `A^T B` 累加 / `A B^T`）都写成 WASM
（合计 1,276 字节），接回同一份训练循环：

| 档位 | 参数 | tok/步 | JS ms/步 | **WASM ms/步** | 加速 | 有效 GFLOP/s | rss |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| XS d=48 L=2 | 50,640 | 1024 | 103.4 | **27.7** | 3.7× | 11.2 | 121 MB |
| S d=64 L=3 | 140,352 | 1024 | 274.2 | **65.1** | 4.2× | 13.3 | 165 MB |
| M d=96 L=4 | 396,576 | 1024 | 748.5 | **150.2** | 5.0× | 16.2 | 197 MB |
| L d=128 L=6 | 1,043,328 | 2048 | 4080.7 | **904.3** | 4.5× | 14.2 | 316 MB |

**而且这是个保守下界**：原型的 wasm 包装每次调用都把两个输入拷进 wasm 内存、
把输出拷回来。真实现里张量常驻 wasm 内存，这些拷贝全部消失。
另外目前只有 matmul 进了 wasm，softmax / RMSNorm / SwiGLU / 注意力 / AdamW
还全是 JS —— 它们现在占掉约 40% 的时间。两项都做完，预计还有 **2–3 倍**。

### 结论四：真的学得会

S 档（140k 参数），400 步，字符级、词表 26、语料 60KB：

| step | loss |
| ---: | ---: |
| 1 | 3.3236 |
| 25 | 2.2392 |
| 50 | 1.5916 |
| 100 | 0.4591 |
| 200 | 0.2376 |
| 400 | 0.2121 |

基线：均匀 3.258 / unigram 2.857 / **bigram 1.743**。
第 50 步就打穿了 bigram —— 也就是说**注意力真的开始起作用了**，
而这正是可以做成门槛的那件事（见第六节）。

（原型语料是模板文法生成的，太规整，所以 loss 掉到 0.21 有点假。
真出题时语料要更难，让 loss 停在 1.0–1.5 那个「明显学到了但远没学完」的区间。）

### 结论五：确定性是白拿的

同一配置跑两遍，40 步之后：

```
loss 序列相同：true
权重不同的元素：0 / 140352   最大差 0
```

**逐位一致。** 这条能成立是因为原型全程避开了 `Math.exp` 之外的不确定源，
而 `Math.exp` 恰恰是唯一的跨引擎风险（V8 与 JSC 的超越函数结果不一致 ——
gpulab 已经踩过，那边的解法是自己实现）。这里的解法更干净：
**超越函数一并放进 wasm**，同一个二进制在哪都算出同一个数。

### 结论六：Python 是可行的，代价是 13.9MB 与 0.8 秒

| 量 | 实测 |
| --- | ---: |
| `pyodide` 314.0.6 包体 | 13.9 MB（`pyodide.asm.wasm` 9.2MB + stdlib zip） |
| 冷启（不加载任何包） | **761 ms** |
| **Python → JS 每次调用** | **1.47 µs** |
| 纯 Python 三重循环 | 15.8 MFLOP/s |
| pyodide 里 numpy 的 f32 matmul | 3.0–4.9 GFLOP/s |

三个关键判读：

1. **调用开销可以忽略。** 一步训练大约 150 次算子调用 ⇒ 0.22 ms，
   相对 27–150 ms 的一步是噪声。所以「Python 写模型 + WASM 算」这个结构成立。
2. **绝不用 numpy。** 它比我们的 kernel 慢一个数量级（pyodide 用 Netlib 参考 BLAS，
   SIMD 与线程都关着），而且会引一个要从 CDN 下载的 2.9MB wheel —— 与离线优先冲突。
3. **学员代码必须向量化。** 纯 Python 循环比 JS 慢约 300 倍。
   这不是我们的限制，**现实里也是这条规矩** —— 没有人在 PyTorch 里逐元素写 for 循环。

### 训练规模的天花板

按实测 + 预计的 2–3 倍优化空间：

| 用途 | 预算 | 可用规模 |
| --- | --- | --- |
| **一条门槛的判定** | ≤ 30 s | 15 万参数 × 1024 tok × 400 步，或 40 万 × 1024 × 200 步 |
| **一关的完整判定**（含数值检验与多次重放） | ≤ 60 s | 同上，但训练只跑一次 |
| **学员在工作台里按一次「训练」** | 2–5 min | 40 万–100 万参数，600–1500 步 |
| **硬上限** | — | **约 100–200 万参数**。再往上每步逼近 1 秒，且注意力概率缓冲开始吃内存 |

那个内存上限值得单独说，因为它就是一整关的题眼：
B=16 / H=8 / S=128 时，注意力概率矩阵是 `16×8×128×128×4 = 8.4 MB` **每层**，
6 层就是 50 MB —— 而模型本身只有 4 MB。**FlashAttention 存在的理由，
在我们这个尺度上就已经是一个能量出来的数了**（第 17/18 关）。

语料规模：字符级词表 26–96，或小 BPE 词表 512–1024；语料 100 KB – 1 MB。
BPE 训练（512 次 merge × 10 万 token）在 Python 里约 6 秒 ——
**慢得很真实**，`tokenizers` 用 Rust 写正是因为这个，是个现成的教学时刻。

**结论：真训练可行，而且不需要任何妥协。这个项目不是模拟，是真的。**

---

## 三、学员写什么语言（问题 1 的后半）

### 结论：**Python，跑在 Pyodide 上，对着一个叫 `nanotorch` 的 PyTorch 子集写**

三条路都认真算过：

| | A. TypeScript | B. 自己写 Python 子集解释器 | **C. Pyodide（真 CPython）** |
| --- | --- | --- | --- |
| 接口保真 | 得自己发明一套 torch 风格 API，**没有人这么工作** | 高，但有子集边界 | **100%，写的就是能贴进 PyTorch 的代码** |
| 新增运行时 | 0 | tree-sitter-python + 约 4,000 行解释器 | **一个 npm 包，13.9MB 资产** |
| 冷启 | 0 | 约 0 | 761 ms（一次，可缓存） |
| 「未实现」风险 | 无 | **有，而且是 gpulab 记在案的风险** | **无** |
| 标准库 | JS 的 | 要自己补 `re` / `json` / `itertools`… | **全套 CPython stdlib 白拿** |
| 跨引擎确定性 | `Math.*` 有分叉，要自己实现超越函数 | 同左 | **同一个 wasm 二进制，天然一致** |
| 循环密集的关（BPE） | 最快 | 慢 | 慢（BPE 约 6 s —— 但现实里也慢） |
| 与仓库现状 | 最省事 | 中 | 需要接一条新资产链 |

**选 C。** 理由三条：

**理由一：这个项目的价值主张就是语言本身。** 学员做完之后能打开 nanoGPT、
minbpe、TRL 的源码直接读懂并改，是这个项目最大的回报。用 TS 写，
这个回报打七折 —— 算法学到了，但「我现在能改真项目了」这句话不成立。
gpulab 在同一个位置做过同样的取舍：为了接口真实，宁可自己写一整个 C 前端，
也不给学员一层 TS 绑定。这里的等价选择**便宜得多** —— Pyodide 是现成的包，
不是我们要写的编译器。

**理由二：Python 慢的地方，现实里也慢。** 纯 Python 循环比 JS 慢 300 倍，
所以学员必须向量化 —— 这正是 PyTorch 的第一课。BPE 训练要 6 秒 ——
这正是 HuggingFace 把 `tokenizers` 用 Rust 重写的原因。
**语言的性能特性本身就是教学内容**，换成 TS 反而把这一课抹掉了。

**理由三：确定性反而变好。** JS 的 `Math.exp` 在 V8 与 JSC 上结果不同，
gpulab 为此自己实现了全部超越函数。这里的算子核本来就在 wasm 里，
同一个二进制到哪都算同一个数，Python 侧只做控制流 —— 不确定源从源头就没有。

### `nanotorch`：分层与「学员写哪一层」

```
学员写的 ──►  model.py / train.py / sft.py / dpo.py / grpo.py
                     │  import nanotorch as nt
                     ▼
Python 层  ──►  nanotorch/  （**用 Python 写的，学员看得见、读得懂、前几关要自己实现一部分**）
                  tensor.py      Tensor、自动微分 tape、广播
                  nn.py          Module / Linear / Embedding / RMSNorm / MHA / Block
                  functional.py  softmax / cross_entropy / silu / rope
                  optim.py       AdamW / Muon / 学习率调度
                  data.py        分词器接口、packing、DataLoader
                     │  每个算子一次 js 调用（实测 1.47 µs）
                     ▼
JS 桥      ──►  张量常驻 wasm 内存的分配器 · 形状与 dtype · **全部计量在这一层**
                     ▼
WASM 核    ──►  sgemm 三变体 · softmax · rmsnorm · silu/swiglu · rope ·
                注意力（fwd/bwd）· adam · 规约 · gather/scatter · 超越函数
                fp32 / **fp64（梯度检验用）** / bf16 与 fp16 的位级模拟
```

这个分层**和 PyTorch 自己的结构是同一个形状**（Python 前端 + C++ kernel），
不是我们为了偷懒发明的。三条直接好处：

1. **`nanotorch` 是 Python，学员能读它。** 第 10 关「自己写自动微分」不是
   凭空写，是把 `tensor.py` 里被挖空的那部分填回去。
2. **全部门槛的计量落在 JS 桥这一层**，学员碰不到，也绕不过 ——
   和 gpulab 把计量放在 VM 里是同一个做法。
3. **禁止捷径可以精确判定。** 每一关声明本关禁用哪些内建
   （第 3 关禁 `F.scaled_dot_product_attention`，第 12 关禁 `optim.AdamW`），
   桥这一层数调用次数，门槛写 `llm.builtins.forbiddenCalls === 0`。**这是精确值。**

### 学员不写的东西

沿用「能用库就用库」：语料与数据集、评测集与裁判 rubric、
可视化、检查点的序列化、以及**算子核**，全部由平台只读提供。
学员写的是模型、训练循环、损失函数与策略 —— 也就是真实工作里
一个训练工程师真正写的那些文件。

---

## 四、组件路由表

策略编号沿用 opslab.md：S1 真代码编 WASM / S2 成熟库 / S3 官方数据 + 薄实现 / S4 行为等价模拟。
最后一列写明每一处偏差在什么场景下学员会察觉。

| 组件 | | 怎么做 | 学员会在哪察觉 |
| --- | --- | --- | --- |
| Python 语言与标准库 | **S1** | 真 CPython 编成 wasm（Pyodide） | **察觉不到** |
| 张量与自动微分 | S3 | `nanotorch`，API 是 PyTorch 的严格子集 | 没实现的方法明确报「nanotorch 未提供」，并指出真 torch 里叫什么 |
| 矩阵乘与算子 | **S1** | 我们的 wasm SIMD 核，**真算真训** | **察觉不到**（fp32 求和顺序与 PyTorch 不同，位模式会差，误差在界内） |
| fp32 语义 | S3 | wasm f32 原生 | 察觉不到 |
| **fp64** | S3 | wasm f64 原生 | 只在梯度检验与参考实现里用 |
| bf16 / fp16 | S3 | 位级编解码 + 舍入，累加在 fp32 | 察觉不到；「fp16 溢出而 bf16 不溢出」是真算出来的 |
| 超越函数（`exp`/`log`/`tanh`/`erf`） | S3 | **自己实现，放进 wasm** | 察觉不到；修掉跨引擎不确定这个隐患（gpulab 的同一条教训） |
| 随机数 | S3 | 种子 PRNG（Philox 风格计数器式），dropout 与采样都走它 | 与 PyTorch 的数不同，但同样可复现；**逐位重放成立** |
| BPE 分词 | S4→S1 | 第 1 关学员自己写；之后用我们的参考实现 | 与 `tiktoken` 的 merge 表不同（语料不同），**算法一致** |
| 数据集 | S3 | 自造语料 + 自造指令/偏好数据，**方法照真配方** | 规模差几个数量级，题面写明 |
| 评测 | S3 | 口径照 IFEval / AlpacaEval-2（长度受控胜率）/ `pass@k`；裁判是固定 rubric 的确定性程序，不是 LLM | 没有真 LLM 裁判；**口径与偏差（长度偏置）一致** |
| 检查点 | S3 | 自定义二进制格式（fp16 权重），随项目发布 | 不能被 `torch.load` 读；格式在 primer 里讲清 |
| 训练可视化 | S2 | `recharts` 画 loss / 学习率 / 梯度范数；热图与直方图自绘 | 不适用 |
| 终端 | S2 | 复用 `WorkbenchTerminal`，跑 `python train.py` | 不是真 shell 的全部；coreutils 复用 labkit |
| 判定 | S3 | 隐藏用例是 **TS**，通过 `@llm/lab` 读 Python 侧的世界 | 学员看不到（与 `@gpu/lab` 同构） |

### 明确不做

| 放弃 | 理由 |
| --- | --- |
| WebGPU 后端 | 确定性直接没了（不同 GPU 的规约顺序不同），CI 也跑不了。**门槛的地基比速度重要** |
| 多线程（Worker + SharedArrayBuffer） | 需要 COOP/COEP 响应头，与 Electron `file://` 与 Pages 静态站都别扭；**留作第五期**，接缝在 wasm 核里 |
| numpy | 慢一个数量级 + 引 CDN 依赖（见 stack 文档的三条硬约束） |
| 真 PyTorch 权重互操作 | 要实现 pickle 与 zip 容器，服务不了任何一关 |
| 分布式训练 | gpulab 已经做了 8 关 |
| kernel 优化作为教学内容 | 同上 |

---

## 五、工作台形态（问题 5）

### 结论：新增 `workspace.kind = 'train'`

现有的 `code` 工作台不够（没有终端、没有 loss 曲线、没有张量可视化），
`gpu` 工作台也不合适（它的剖析面板是 ncu 指标，访存面板是 32B 扇区热图，
和「模型有没有在学」是两回事）。加一支的成本很低，路已经铺好了。

```ts
export type WorkspaceKind = 'code' | 'ops' | 'gpu' | 'train';

export interface TrainWorkspaceSpec {
  kind: 'train';
  world?: TrainWorldSpec;   // 语料、词表、模型档位、数据集、检查点，全项目共用
}
```

沿用 ops / gpu 的做法：**世界写在项目上，关卡只写增量**。

### 六块面板，按关卡阶段显隐

| 面板 | 内容 | 从哪一关开始 | 来源 |
| --- | --- | --- | --- |
| **任务** | 目标 / 清单 / 提示 / 常见坑 / 结果 | 1 | **复用** |
| **IDE** | `.py` 文件，Monaco 自带 Python 高亮 | 1 | **复用** |
| **终端** | `python train.py`、`python -m nanotorch.gradcheck`、`python eval.py`、`ls`、`head` | 1 | **复用 `WorkbenchTerminal` + labkit 的 shell** |
| **训练** | loss（train/val 双线）、学习率、梯度范数、tokens/s、步数、**每条门槛的实时值与目标值** | 2 | 新写 |
| **张量** | 注意力热图（选层选头）、激活与梯度直方图、逐层范数、参数量与显存分解 | 3 | 新写 |
| **样例** | 生成样例（按 logprob 着色）、SFT 前后对比、偏好对与 reward、rollout 与 advantage | 8 | 新写 |

面板通信沿用定论：**单一数据源、单向数据流，不做面板间消息**。

### 「张量」面板要能看见什么

这是这个项目区别于「照着教程敲一遍」的地方 —— 教程里你**看不见**这些：

1. **注意力热图**：选一层一个头，画出 S×S 的注意力矩阵。因果掩码写错时
   右上三角亮起来，一眼；induction head 学成之后，对角线偏移那条亮带会自己长出来。
2. **激活与梯度直方图**：pre-norm 去掉之后深层激活范数怎么爆的、
   梯度裁剪前后梯度范数分布怎么变的、bf16 与 fp16 的动态范围差在哪 ——
   全是直方图上一眼的事。
3. **逐层范数曲线**：残差流的范数随层数怎么长，这是 `1/sqrt(2L)` 那个初始化缩放
   存在的理由，也是它写错时唯一看得见的地方。
4. **参数量与显存分解**：嵌入占多少、注意力占多少、MLP 占多少、
   优化器状态占多少、激活占多少。第 17/18 关的门槛读的就是这几个数。

### 「样例」面板

后训练的一半内容是「输出变成什么样了」，而这件事不看样例是判断不了的。
面板做三种视图：单条生成（token 按 logprob 着色）、成对对比（SFT 前 / 后，
chosen / rejected），以及 rollout 组（GRPO 的一组采样，每条带 reward 与 advantage，
**advantage 的组内均值画在旁边** —— 归一化写错时它不是 0）。

### 「别漏掉 UI」这次是结构性防住的

gpulab 那次是 29 关全做完、测试全绿、包都发了才发现工作台一行没写。
现在有 `tests/engineering/workspace-dispatch.test.ts` 顶着：
**`projects.json` 里出现的每一种 kind，分发页里必须有对应分支。**
所以只要 `llm-from-scratch` 一进 `projects.json`，这条用例就会红，
直到 `pages/projects/[id].tsx` 真的接上 `TrainWorkspace`。

**但这条闸门只拦「组件不存在」，拦不住「组件是空壳」。** 所以再加一条自己的规矩：
**第一段的第一个 commit 就是「分发器 + 六块面板的骨架 + 一条能跑通的竖切」**，
关卡内容一关都还没有的时候，工作台已经能打开、能敲命令、能看到一条 loss 曲线。

---

## 六、门槛怎么成立（问题 2）

这是整个方案的判定地基。优化类题目最容易变成「我觉得我优化了」，
而训练类题目更糟 —— 最容易变成「它好像在学」。

### 三条规矩

**规矩一：门槛只建立在结构性计量与确定性重放上，绝不建立在墙钟时间上。**
（同 gpulab 第一节。这里连 `speedupVsBaseline` 那种例外都不留 ——
我们是真算，速度取决于学员的机器。）

**规矩二：学习效果类门槛必须满足两条。**

- 种子、语料、超参、步数、批大小**全部由平台固定**，写在只读文件里，学员改不了；
- 门槛卡在「参考实现的值」与「上一关 / 朴素实现的值」之间、靠近参考侧，
  **并且题面里把两个数都写出来**。学员看到的不是一个凭空的阈值，
  而是「bigram 基线 1.74，参考解 1.12，门槛 1.45」。

**规矩三：每个学习效果门槛旁边必须配一个结构性门槛。**
因为「loss 降到 1.45 以下」可以被一个碰巧能学的错实现蒙过去，
而「梯度检验 ≤ 1e-4」「因果泄漏 = 0」「参数量 = 解析式」不能。
两个一起卡，才是判定。

### 一条从 gpulab 借来的教训

> 「判定只查一个点时，一整类『偏移算错』的实现会全绿通过。」
> —— gpulab 实施回填第 5 条

在这里的对应物是**梯度检验的抽样强度**。只查一个参数张量的一个元素，
「某一层的某个矩阵梯度整个是错的」会全绿。所以门槛要同时卡两个数：
`llm.grad.maxRelError ≤ 界` **和** `llm.grad.checkedTensors == 全部张量数`，
每个张量至少抽 8 个元素（原型就是按这个抽的，正是它把 fp32/fp64 那件事顶出来的）。

### 指标清单

现有的 `MetricGate` 机制原样能用（`metric` 是 `LabMetrics` 上的路径），
给 `LabMetrics` 加一个 `llm` 字段即可 —— 和 gpulab 加 `gpu` 完全同一个做法。

#### A · 数值正确性

| 指标路径 | 精确吗 | 用来判什么 |
| --- | --- | --- |
| `llm.grad.maxRelError` | **精确**（fp64 中心差分，定义式） | **梯度检验的主门槛**。原型实测参考实现 6.8e-4，所以界取 **2e-3**；fp32 下这个数是 5e-2，**必须在 fp64 里跑** |
| `llm.grad.checkedTensors` / `.checkedElements` | **精确** | 防止「只查一个点」（见上） |
| `llm.forward.maxRelError` / `.maxUlpError` | **精确**（对 fp64 参考实现） | 每个算子关的正确性；界按 O(√K·ε) 推，写进题面 |
| `llm.determinism.bitIdentical` | **精确** | **恒等门槛**。同一份代码跑两遍，全部权重与 loss 序列逐位一致。原型实测 0/140352 |
| `llm.causality.leakBits` | **精确** | **恒等于 0**。平台探针：把第 t+1 个 token 换掉，第 t 个位置的 logits 必须一位不变。因果掩码写错唯一抓得住的方式 |
| `llm.nan.count` / `llm.inf.count` | **精确** | 恒为 0（除了故意演示溢出的那一关） |

#### B · 结构性计量

| 指标路径 | 精确吗 | 用来判什么 |
| --- | --- | --- |
| `llm.params.total` / `.active` / `.byModule` | **精确** | 参数量必须等于解析式。抓「少了残差」「多了一份 bias」「MoE 把总参数当成激活参数」 |
| `llm.flops.forwardPerToken` / `.backwardPerToken` | **精确**（算子层逐次累加） | **本项目的核心结构性门槛**，对应 gpulab 的 `dram.bytesRead`。抓「注意力写成 O(S³)」「反向重算了一遍前向」（界：反向 ≤ 前向 × 2.2） |
| `llm.flops.generatePerToken` | **精确** | **KV cache 关的主门槛**：从 O(S) 降到 O(1) |
| `llm.memory.peakActivationBytes` | **精确** | 激活重算关（降 ≥ 60%）、注意力显存关 |
| `llm.memory.optimizerStateBytes` | **精确** | AdamW 的 2× 状态、Muon 的 1× |
| `llm.builtins.forbiddenCalls` | **精确** | **禁止捷径的判据**，恒为 0。每关声明黑名单 |
| `llm.kernelCalls.byOp` | **精确** | 算子融合、少调一次 softmax 之类 |
| `llm.tokens.perStep` / `.padRatio` | **精确** | 数据打包效率；padding 比例过高说明没做 packing |
| `llm.attention.crossDocumentPairs` | **精确** | **恒等于 0**。打包之后跨文档注意力泄漏 —— 不检测的话学员永远不知道自己漏了 |
| `llm.loss.contributingPositions` | **精确** | SFT 的 loss mask：prompt 位置必须**一个都不贡献** |

#### C · 学习效果（精确算出，但仅在固定种子/数据/步数下）

| 指标路径 | 精确吗 | 用来判什么 |
| --- | --- | --- |
| `llm.loss.train` / `.val` / `.perplexity` | **精确**（给定种子） | 训练关的主门槛 |
| `llm.loss.vsBigram` | **精确** | **打穿 bigram 基线** —— 「注意力真的起作用了」的最干净证据。原型第 50 步做到 |
| `llm.eval.probeAccuracy` | **精确** | 合成探针任务（induction / 复制 / 括号匹配），bigram 模型做不到，只有注意力对了才会 |
| `llm.eval.formatCompliance` | **精确** | SFT 之后的格式合规率 |
| `llm.scaling.predictionRelError` | **精确** | 缩放定律关：用小档拟合、预测大档，看预测准不准 |
| `llm.train.lossSpikes` | **精确**（按定义计数） | warmup / 裁剪关 |

#### D · 后训练

| 指标路径 | 精确吗 | 用来判什么 |
| --- | --- | --- |
| `llm.pref.accuracy` | **精确** | 留出偏好对的排序准确率（DPO / RM 关） |
| `llm.rm.pairwiseAccuracy` / `.calibrationError` | **精确** | 奖励模型关；口径对 RewardBench v2 |
| `llm.kl.fromReference` | **精确**（同一批 prompt 上按定义算） | **DPO / GRPO 的上界门槛** —— 防止策略跑飞。这是后训练里最重要的一条 |
| `llm.dpo.implicitRewardMargin` | **精确** | chosen / rejected 的隐式奖励差 |
| `llm.rl.groupAdvantageMean` / `.advantageStd` | **精确** | **抓组内归一化写错**：均值必须 ≈ 0，标准差 ≈ 1 |
| `llm.rl.rewardMean` / `.verifierPassRate` | **精确** | RLVR 的可验证奖励 |
| `llm.length.meanCompletionTokens` | **精确** | **长度偏置**：胜率涨的同时长度不许失控 |
| `llm.length.controlledWinRate` | **精确** | 长度受控胜率，口径对 AlpacaEval-2 |
| `llm.alignmentTax.valLossDelta` | **精确** | **对齐税**：后训练之后基础 LM 能力掉了多少 |
| `llm.expert.loadImbalance` / `.droppedTokens` | **精确** | MoE 关；token 一个不许丢 |

#### E · 只作展示，绝不作门槛

| 指标 | 为什么不作门槛 |
| --- | --- |
| `llm.timing.msPerStep` / `.tokensPerSecond` | **墙钟。规矩一。** |
| 注意力熵、逐层激活范数、梯度范数曲线 | 是诊断信号，不是对错判据 |
| 生成样例的「好不好」 | 我们的模型太小，主观质量不构成门槛；只在 AI 复盘里作定性材料 |

### 反向验证

沿用 ops / gpu 的规矩，**每一关都要有**：

- 跑参考解 → 全部用例与门槛必须**全绿**
- 跑起始代码 → 必须**挂**，而且挂在**预期的那一条**上（不能是「碰巧报错」）
- 埋了坑的关，还要额外验：把坑填上之后过、把坑还原之后挂
- `projects:verify` 进 CI

**这个项目多一条**：训练关的参考解跑一遍要 20–60 秒，29 关全量反向验证
是分钟级的 CI 作业。所以 `projects:verify` 要分层 ——
快检查（形状、参数量、禁用内建）每次跑，全量训练验证按夜间跑。

### 判定要跑几遍

- **一遍**：正常跑，拿 loss、指标、生成样例
- **一遍**：只跑 40 步，与第一遍的前 40 步逐位比对 → `determinism.bitIdentical`
- **一遍（fp64）**：只做梯度检验，**不进任何其他指标**

第三遍单独跑是因为 fp64 比 fp32 慢一倍多，挂在正常路径上会让每关都翻倍 ——
这也正是现实里 `torch.autograd.gradcheck` 的用法：它是个单独跑的工具，
不在训练循环里。

---

## 七、内容大纲（问题 3）

**30 关，4 期。** 依赖链是硬的：后一关解决前一关暴露出来的具体问题，
每关题面的开头就是「上一关你做完之后，那个数还是不对，因为……」。

场景：一家公司要自己训一个小语言模型 —— 从没有分词器开始，
到一个会跟随指令、会做可验证任务的模型。

### 期一 · 从字节到一次前向（第 1–8 关）

| # | 主题一句话 | 判定标准 | 门槛指标 |
| --- | --- | --- | --- |
| 01 | **字节级 BPE**：从字节开始训一张 merge 表 | 编解码往返一致；merge 序列与参考逐条相同 | `forbiddenCalls = 0`；压缩率 ≥ 阈值；词表大小 = 指定值；**往返一致率 = 100%**（含非法 UTF-8 字节） |
| 02 | **语言建模的地板**：unigram / bigram 计数模型与困惑度 | 概率归一、平滑正确 | `loss.val` 与解析式一致（这一关**立基线**，后面每一关都相对它）。原型实测 bigram = 1.743 |
| 03 | **单头因果自注意力**：QK^T、缩放、掩码、softmax、加权和 | 前向对齐 fp64 参考 | **`causality.leakBits = 0`**；`forward.maxRelError ≤ 1e-5`；`forbiddenCalls = 0`（禁 `F.scaled_dot_product_attention`） |
| 04 | **多头与 GQA**：形状体操，以及 KV head 少了之后省了什么 | 输出与「多个单头拼起来」一致 | **`params.total` = 解析式**；`memory.kvCacheBytes` 相对 MHA 降 = `n_kv/n_head` |
| 05 | **RoPE**：把位置编进旋转里 | 与 fp64 参考一致 | `forward.maxRelError ≤ 1e-5`；**平移不变性探针**：整段序列右移，注意力分数矩阵不变 |
| 06 | **RMSNorm 与 pre-norm 残差**（含 QK-norm） | 与 fp64 参考一致 | `forward.maxRelError ≤ 1e-5`；**去掉 norm 的对照必须发散**（`nan.count > 0`） |
| 07 | **SwiGLU 与完整 block**：把 5 件零件拼成一层 | 端到端前向正确 | **`params.total` = 解析式**；**`flops.forwardPerToken` = 解析式**（抓少了残差 / 多算一遍） |
| 08 | **自回归采样与 KV cache**：temperature / top-k / top-p | 采样分布正确；**带 cache 与不带 cache 的输出逐位一致** | **`flops.generatePerToken` 与序列长度无关**（不带 cache 是 O(S)）；`determinism.bitIdentical` |

### 期二 · 让它学会（第 9–17 关）

| # | 主题一句话 | 判定标准 | 门槛指标 |
| --- | --- | --- | --- |
| 09 | **手写一个算子的反向**：matmul + 交叉熵 | 数值梯度对得上 | **`grad.maxRelError ≤ 2e-3`（fp64）**；`grad.checkedElements ≥ 8×张量数` |
| 10 | **自动微分引擎**：tape、拓扑序、广播的反向 | 一组随机表达式的梯度与参考一致 | `grad.maxRelError ≤ 2e-3`；**同一个中间结果被用两次时梯度要相加**（探针） |
| 11 | **整个模型的反向**：把第 3–7 关全接上 | 全部参数张量梯度检验通过 | **`grad.checkedTensors` = 全部**；**`flops.backwardPerToken ≤ 2.2 × forwardPerToken`**（抓重复计算） |
| 12 | **AdamW**：偏差修正、解耦的权重衰减 | 给定梯度序列，更新与参考逐位一致 | `determinism.bitIdentical`；**1 维参数（norm 的 gain）不被衰减**（探针：跑 100 步后其范数未塌） |
| 13 | **学习率调度与 warmup** | 训练不炸 | **无 warmup 的对照必须挂**（`train.lossSpikes > 0`）；有 warmup 版 `loss.val ≤ 阈值` |
| 14 | **梯度裁剪与训练稳定性** | 全程无 NaN | `nan.count = 0`；`train.lossSpikes ≤ 1`；**裁剪后的梯度范数 ≤ clip**（探针） |
| 15 | **数据加载与打包**：document packing，别跨文档泄漏 | 每步 token 数恒定 | **`attention.crossDocumentPairs = 0`**；`tokens.padRatio ≤ 0.02`（朴素分句是 0.3+） |
| 16 | **完整预训练循环 + 验证集** | 收敛且不过拟合 | **`loss.val ≤ 阈值` 且 `< loss.vsBigram`**；`determinism.bitIdentical`；`eval.probeAccuracy ≥ 阈值`（bigram 做不到的合成任务） |
| 17 | **混合精度与显存**：bf16 位级模拟，以及注意力那 8.4MB | bf16 与 fp32 的 loss 差在界内 | `memory.peakActivationBytes` 记为 baseline；**fp16 对照必须溢出**；bf16 `loss.val` 与 fp32 差 ≤ 界 |

### 期三 · 规模与效率（第 18–21 关）

| # | 主题一句话 | 判定标准 | 门槛指标 |
| --- | --- | --- | --- |
| 18 | **激活重算**：拿算力换显存 | 梯度仍然正确 | **`memory.peakActivationBytes ≤ baseline × 0.4`**；**`flops.forwardPerToken ≤ baseline × 1.4`**（抓重算过头）；`grad.maxRelError ≤ 2e-3` |
| 19 | **缩放定律与超参**：跑一组小档，预测大档 | 拟合出的指数在合理区间 | **`scaling.predictionRelError ≤ 0.15`**（用小档拟合去预测一个没跑过的档，然后平台跑那一档对答案） |
| 20 | **MoE**：路由、top-k、容量因子、负载均衡损失 | token 一个不丢 | **`params.active` = 解析式且 `< params.total`**；`expert.droppedTokens = 0`；`expert.loadImbalance ≤ 1.3` |
| 21 | **Muon**：矩阵参数的正交化更新 | Newton–Schulz 收敛 | 同 token 预算下 **`loss.val ≤ AdamW 版 × 阈值`**（同模型同数据同步数，结构性比较）；嵌入与 1 维参数仍走 Adam（探针） |

### 期四 · 后训练（第 22–30 关）

| # | 主题一句话 | 判定标准 | 门槛指标 |
| --- | --- | --- | --- |
| 22 | **SFT**：chat template，loss 只算在 completion 上 | 学会跟随格式 | **`loss.contributingPositions` 中 prompt 位置 = 0**；`eval.formatCompliance ≥ 阈值` |
| 23 | **数据配比与对齐税**：混多少指令数据 | 两件事同时成立 | **`eval.formatCompliance ≥ 阈值` 且 `alignmentTax.valLossDelta ≤ 上界`** —— 只卡一个的话，学员会把另一个换掉 |
| 24 | **奖励模型**：Bradley-Terry 成对损失 | 排序正确 | **`rm.pairwiseAccuracy ≥ 阈值`**（留出集）；`rm.calibrationError ≤ 阈值` |
| 25 | **DPO**：不要 critic 的偏好优化 | 偏好方向正确且不跑飞 | **`pref.accuracy ≥ 阈值`**；**`kl.fromReference ≤ 上界`**；`dpo.implicitRewardMargin > 0` |
| 26 | **长度偏置**：DPO 会让答案越写越长 | 赢了但没靠变长赢 | **`length.controlledWinRate ≥ 阈值`** 且 **`length.meanCompletionTokens ≤ baseline × 1.2`** |
| 27 | **rollout 基础设施**：批量采样、停止条件、去重 | 采样正确且可复现 | `flops.generatePerToken` ≤ 解析上界（必须用上第 8 关的 KV cache）；`determinism.bitIdentical` |
| 28 | **GRPO + RLVR**：组内相对优势，无 critic | 可验证任务准确率上升 | **`rl.verifierPassRate ≥ 阈值`**；**`rl.groupAdvantageMean ≈ 0`（\|·\| ≤ 1e-5）**；`kl.fromReference ≤ 上界` |
| 29 | **GRPO 的三个修正**：clip-higher / token 级 loss / Dr.GRPO 的长度归一化 | 修正之后三个病都好 | **`length.meanCompletionTokens` 不再单调增**；`rl.verifierPassRate ≥ 第 28 关 + Δ`；短答案的更新不被放大（探针） |
| 30 | **收官**：从字节到一个会跟随指令的模型，全流程重跑 | 端到端跑通 | 前面各期的关键门槛在同一次运行里同时成立 |

### 依赖链是真的

几处刻意的埋线与回收：

- **第 2 关的 bigram 基线**是第 16 关门槛的分母。学员自己算出来的 1.74，
  后面每一关的 loss 都相对它读。
- **第 3 关的因果掩码**会在第 8 关被 KV cache 再验一次 ——
  掩码写错的实现，带 cache 与不带 cache 的输出对不上。
- **第 8 关的 KV cache** 是第 27 关 rollout 的前置。不做 cache，
  GRPO 的一轮采样在我们的预算里跑不完 —— 这不是人为设置的障碍，是真的跑不完。
- **第 11 关的梯度检验**在第 18 关（激活重算）被再跑一遍。
  重算写错的实现，前向对、loss 降、只有梯度检验挂。
- **第 15 关的跨文档泄漏**：起始代码把整个语料拼成一条流切窗口，
  在我们这儿**训练照样收敛**，只有 `crossDocumentPairs` 抓得到 ——
  和 gpulab 第 3 关那个「漏 `__syncthreads()` 却算对了」是同一类坑。
- **第 17 关的 8.4MB**：注意力概率缓冲比模型本身还大。
  这个数是学员自己看到的，于是「FlashAttention 为什么存在」不用讲。
- **第 23 关必须挂一次**：只优化格式合规率的做法，`alignmentTax` 门槛一定过不了。
- **第 26 关必须挂一次**：第 25 关做完的 DPO 模型，长度门槛就是过不了 ——
  这是第 26 关存在的理由。

### 关卡数的复核

30 关比 gpulab 的 29 关多一关，比 opslab 的 23 关多七关。审下来没有明显偏薄的：

- 第 2 关（基线）看着轻，但它是后面 14 条 loss 门槛的分母，**不能并进第 1 或第 3 关**
  —— 并进去就变成「顺手提一句」，而它需要学员自己算出来才有用。
- 第 9 / 10 / 11 三关都在讲反向，看着可以合并，实际是三件事：
  9 是**链式法则落到具体算子**，10 是**引擎**（tape、拓扑序、多次使用要相加），
  11 是**规模**（20 个张量全绿，以及反向 FLOPs 的 2.2 倍上界）。
  按 gpulab 立的判据 ——「一关如果有两个门槛，学员可能过了其中一个、
  却因为完全无关的原因挂了另一个，那它就该是两关」—— 这三关都该分开。
- 第 28 / 29 同理：28 是 GRPO 本身，29 是三个修正。合并的话学员会在
  「GRPO 没写对」和「长度偏置没修」之间分不清自己挂在哪。

**可能超载、出题时再看要不要拆的三关**：19（缩放定律，方法关，门槛偏软）、
23（配比 + 对齐税 + 评测，三件事）、29（三个修正）。先按一关写。

---

## 八、判定管线与世界

### 完全复用 ops / gpu 那一套

```
关卡的隐藏用例（TS）→ import '@llm/lab' → 读世界 → 断言 → StageRunReport
```

`@llm/lab` 的形状对着 `@gpu/lab` 抄：

```ts
export interface LlmLabApi {
  sh(cmd: string): Promise<{ stdout, stderr, code }>;      // 敲 python / ls / head
  run(path: string): Promise<PyRunResult>;                  // 跑学员的脚本
  train(spec: TrainSpec): Promise<TrainRun>;                // 平台自己发起一次训练
  gradcheck(spec: GradcheckSpec): Promise<GradcheckReport>; // fp64 那一遍
  generate(spec: GenerateSpec): Promise<Sample[]>;          // 平台自己采样
  evaluate(spec: EvalSpec): Promise<EvalReport>;            // 跑评测集
  metrics(): LlmMetrics;                                    // 全部计数器
  reference(name: string, args): Float64Array;              // fp64 参考实现
  probe: {                                                  // 平台探针
    causality(): number;                                    // 因果泄漏位数
    lossMask(): { promptPositions: number };
    determinism(runs: number): boolean;
  };
  world: TrainWorld;
}
```

**平台改动只有三处，都很小**（gpulab 已经把大部分路铺好了）：

1. `WorkspaceKind` 加 `'train'` 一支，`TrainWorkspaceSpec` / `TrainStageSpec` 两个类型，
   `pages/projects/[id].tsx` 加一个分支。
2. `LabMetrics` 加 `llm?: Record<string, unknown>` 子树 —— 和 `gpu` 那个字段一模一样，
   `getMetricValue` 本来就会一层层走下去，不用改解析。
3. `workspace.ts` 的 `labFilesOf` / `allProjectFiles` / `pruneDrafts` 要认 `stage.train.files`
   —— **这三处一处都不能漏**，漏了学员的 `.py` 草稿就存不住。
   （这正是 v0.18.0 那个 #108 修的问题，注释还留在 `workspace.ts` 里，照着做即可。）

### 世界里有什么

```
TrainWorldSpec = {
  corpus,        // 语料（预训练 / mid-training 两份配比不同的）
  tokenizer,     // 参考 BPE（第 1 关之后各关都用它，保证起点一致）
  arch,          // 模型档位（d / layers / heads / kv_heads / hidden / block）
  hparams,       // 种子、lr、batch、steps —— 只读，学员改不了
  checkpoints,   // 随项目发布的预训练权重（后训练各关的起点）
  datasets,      // SFT 指令集、偏好对、可验证任务集、评测集
  probes,        // 合成探针任务（induction / 复制 / 括号匹配）
}
```

**检查点必须随项目发布，不能现训。** 后训练的 9 关都要一个已经会说话的模型做起点，
现场训一遍要 30–60 秒 ×9。做法：参考实现训出来，权重存成 fp16 二进制
（15 万参数 ≈ 300 KB，40 万 ≈ 800 KB），放 `public/llmlab/`，
按 electron-builder 的白名单逐个列名。**这也是现实里的做法** ——
没有人为了做 SFT 先重新预训练一遍。

### golden 这次要什么

opslab 的 golden 来自真集群录制，gpulab 不需要 golden（结构性计量解析可推）。
这个项目介于两者之间：

| 要验的东西 | 怎么验 | 要外部依赖吗 |
| --- | --- | --- |
| 算子的数值正确性 | fp64 参考实现，仓库内算 | 不要 |
| 梯度 | fp64 中心差分，定义式 | 不要 |
| 参数量 / FLOPs / 显存 | **解析可推**，写成单元测试 | 不要 |
| 因果性、loss mask、跨文档泄漏 | 平台探针，构造已知错误必须被抓到 | 不要 |
| 确定性 | 千次重放逐位一致，进 CI | 不要 |
| **loss 阈值本身合不合理** | **录 baseline**：参考解与朴素解各跑一遍，两个数都写进题面 | 不要 |
| **算法实现与 PyTorch 是否等价** | ◐ **这一条需要外部** | **要 PyTorch** |

最后一条是这个项目唯一「没有仓库内真值」的地方：
我们的 DPO loss 和 TRL 的 DPO loss 是不是同一个式子？
我们的 AdamW 和 `torch.optim.AdamW` 在同样输入下是不是同一个更新？

**做法与 opslab 的 golden 录制同一个性质 —— 出题期工具，学员端与日常 CI 都不依赖**：
写一个 `scripts/record-torch-golden.py`，在有 PyTorch 的机器上（作者本地或一条
CI job）喂固定输入，把 PyTorch 的输出录成 fixture 入库；
我们的实现跑同一批输入，逐元素对到 fp32 容差内。覆盖约 20 个算子与 5 个 loss。
**这一步不做的话，「换到 PyTorch 上照抄就能跑」这句话没有证据。**

---

## 九、工程量与分期（问题 6）

约 **14,700 行**，比 gpulab 的 26,000 小四成 —— 因为没有指令集模拟器、
没有时序模型、没有 sanitizer，而且 Python 运行时是买来的。

| 层 | 估算 | 说明 |
| --- | ---: | --- |
| 复用 opslab / gpulab / labkit（内核、机器层、终端、判定管线、进度、AI 评审） | **0** | 约省 6,000 行 |
| WASM 算子核（约 25 个 kernel + 内存管理 + fp64/bf16/fp16） | 2,000 | 建议用 C 写，clang 编（见下） |
| JS 桥（张量常驻内存、分配器、形状与 dtype、**全部计量**） | 1,500 | |
| `nanotorch`（Python：Tensor / autograd / nn / functional / optim / data） | 2,500 | **学员要读它**，所以既是代码也是内容 |
| Pyodide 集成（加载、虚拟 FS、模块注入、stdout、确定性驯服、Worker） | 1,200 | |
| `@llm/lab` + runner + 指标树 + 探针 | 1,200 | 对着 `gpulab/lab/` 抄 |
| 语料与数据集构造（BPE 参考、语料生成、SFT / 偏好 / 可验证任务 / 评测集） | 1,000 | |
| 判定工具（fp64 参考、gradcheck、baseline 录制、torch golden 录制脚本） | 1,200 | |
| **UI 面板**（训练 / 张量 / 样例 + 工作台骨架 + 分发器） | 3,500 | **第一期，不是扩展** |
| 平台改动（`WorkspaceKind`、草稿三处、校验、打包白名单） | 600 | |
| **合计** | **≈ 14,700** | |

单人纯开发 **3–4 个月**，含 30 关内容约 **6–8 个月**；两人并行约 4 个月。

### 四段节奏

**第一段 · Spike（3 周）—— 命门与工作台一起立起来**

原型已经答了「能不能真训练」，还有五件事必须在动内容之前证明：

1. **端到端一条竖切**：一个学员写的 `.py` → Pyodide → `nanotorch` → wasm kernel →
   真训 300 步 loss 下降 → 一条门槛通过 / 失败 → 结果面板显示出来。
2. **工作台能打开。** 分发器 + 六块面板的骨架，**这是第一段的第一个 commit**。
   `tests/engineering/workspace-dispatch.test.ts` 会顶着，但它只拦「组件不存在」，
   所以自己再加一条：竖切跑通时截图存进 PR。
3. **确定性**：同一份代码跑 1000 遍，权重与 loss 逐位一致（进 CI 门禁）。
   原型已经在 Node 里验过 2 遍，缺的是浏览器 + Electron 两端 × 1000 遍。
4. **打包链路**：Pyodide 的 5 个运行时资产（实测大小见下）+ 我们的
   `llmlab-kernels.wasm` + `nanotorch` 源码，走通 `copy-lab-assets.js` →
   `electron-builder` 的 `files` / `asarUnpack` 白名单 →
   **装出来的包里断网能开关卡**。
   （opslab 的教训：这条不早验，会在发版验收时炸。）

   | 文件 | 原始 | brotli |
   | --- | ---: | ---: |
   | `pyodide.asm.wasm` | 9.60 MB | 3.11 MB |
   | `python_stdlib.zip` | 2.55 MB | 2.49 MB |
   | `pyodide.asm.mjs` | 1.25 MB | 0.23 MB |
   | `pyodide-lock.json` | 0.11 MB | 0.02 MB |
   | `pyodide.mjs` | 0.02 MB | 0.01 MB |
   | **合计** | **13.53 MB** | **5.86 MB** |

   作参照：opslab 现在就在包里带一个 **142 MB（14 MB brotli）** 的
   `opslab-cli.wasm`。这条链路本身是通的，我们要加的东西**比它小 2.4 倍**。
5. **梯度检验的 fp64 通路**：张量库的 fp64 模式与 fp32 模式共用一套算子声明。

产出：可行性结论 + 体积数字 + 一个能训一个小模型的可玩 demo。

**第二段 · 前向与工作台（2 个月）**
算子核全套、`nanotorch` 的 Tensor / nn / functional、分词器、
训练面板与张量面板、第 1–8 关。

**第三段 · 训练（2 个月）**
autograd、优化器、调度与裁剪、数据打包、混合精度、激活重算、
缩放定律、MoE、Muon、第 9–21 关。

**第四段 · 后训练（2 个月）**
SFT / RM / DPO / GRPO 与三个修正、rollout 基础设施、评测与裁判、
样例面板、第 22–30 关。

### 风险

| 风险 | 缓解 |
| --- | --- |
| **学习效果门槛太脆** —— 一个正确但写法不同的实现落在阈值另一边 | 规矩二（门槛卡在参考值与朴素值之间、留足余量、两个数都写进题面）+ 规矩三（每条效果门槛配一条结构性门槛）。出题时**必须**把参考解与至少两种合理的变体实现都跑一遍 |
| **Pyodide 的资产链在打包时掉链子** | 第一段第 4 项就验；白名单逐个列名（照 `electron-builder.config.js` 里现成的注释做）；加一条构建期断言：包里这 6 个文件必须在位 |
| **绝不能触发 CDN 下载** | 代码级禁止 `loadPackage`；加一条测试扫源码里的 `loadPackage` / `cdn.jsdelivr` 字面量 |
| 训练太慢，学员等不住 | 原型已量；关卡按「判定 ≤ 30 s」设计；判定放 Web Worker；算子核还有 2–3 倍余量没榨（elementwise 进 wasm、张量常驻） |
| **fp32 下梯度检验假阴/假阳** | **已在原型里踩到并解决**：梯度检验一律走 fp64，写进架构而不是写进注意事项 |
| 学员用 `import js` 绕过判定 | 判定跑在受限的 Worker 里，运行前把 `js` / `pyodide_js` 从模块表摘掉。这不是安全边界（作弊只坑自己），但门槛要默认诚实 |
| 与 PyTorch 的算法等价性没证据 | `record-torch-golden.py`，出题期工具（第九节）。**不做这一步，项目的核心承诺没有证据** |
| 上游漂移（这个领域三个月翻篇） | 选型集中在 [llmlab-stack.md](./llmlab-stack.md)，标注核实日期与来源 |
| 与 gpulab / opslab 抢工期或改到同一批文件 | 复用点全是**只读复用**；要动共享代码的只有三处（`WorkspaceKind`、`LabMetrics.llm`、`workspace.ts` 的三个函数），可以先单独提一个小 PR |
| AI 生成这类项目 | 明确不支持，生成器继续只产 `kind: 'code'` |

---

## 十、拍板记录（2026-08-31，八条全部已定）

**结论：八条全部按推荐拍板。** 1 与 2 是大的，逐条的论证留在下面 ——
哪一条当初怎么想的，比一份只写结论的表有用。

### 1 · 学员写 Python，跑 Pyodide ✅ 已定

**在决定什么**：这个项目的核心价值主张能不能成立 ——
「你在这里写的代码，贴进 PyTorch 就能跑」。

**推荐：是。** 论证见第三节。代价是 13.9 MB 资产 + 761 ms 冷启 + 一条新资产链；
换来的是接口 100% 保真、CPython 标准库白拿、跨引擎确定性反而变好。
**反对的理由只有一条**（仓库里其他 11 个项目都是 TS），
而 gpulab 已经开过这个先例 —— 它为了接口真实自己写了一整个 C 前端，
成本比这个高得多。

**如果否**：退到 TypeScript + torch 形状的 API。省掉整条 Pyodide 链，
关卡内容一关都不用改，工期少约 1 个月。**代价是把这个项目从
「你能改真项目了」降级成「你懂原理了」。**

### 2 · 算子核用什么写 ✅ 已定：C + clang，产物进仓库

**在决定什么**：2,000 行 wasm 算子怎么产出，以及要不要引入一条原生工具链。

| 选项 | 得 | 失 |
| --- | --- | --- |
| A. 手写 WAT | **零工具链**（`wabt` 是纯 wasm 的 npm 包，构建期依赖）；原型已证明可行且快 | 25 个 kernel 的 WAT 约 2,000 行，可读性差，改起来疼 |
| **B. C + clang（wasi-sdk），产物入库** | 可读、好改、fp64/bf16 都自然 | 引入一条原生工具链 |
| C. AssemblyScript | 语法友好 | 又一条工具链，且 SIMD 支持不如 clang 直接 |

**推荐 B，但产物的处理方式和 opslab 相反。**

opslab 的 `opslab-cli.wasm` 有 **142 MB**，所以 `scripts/build-opslab-wasm.sh`
把它排除在仓库外（`.gitignore:15`），由 CI 单独一条 job 构建后挂到 release，
而作者本机要改它就得装 Go —— 这台机器现在就没装。

我们的算子核是**另一个数量级**：原型里三个 sgemm 变体编出来 **1,276 字节**，
25 个 kernel 撑死几十到一百 KB。所以：**C 源码与 `.wasm` 产物一起进仓库**，
再加一条 CI job 用钉死版本的 clang 重建并断言与仓库里那份**字节一致**。

这么做换来的是：日常开发（包括 `npm test`、包括别人来提 PR）
**完全不需要 clang**，而「只有作者的机器能改算子」这个失败模式也不成立 ——
产物在仓库里，可复现性由 CI 顶着。原型已经证明 A 也能跑，
所以这是「哪个更好维护」而不是「哪个可行」。

### 3 · 30 关，不压 ✅ 已定

**推荐：不压。** 逐关审过（第七节），没有明显偏薄的，
反倒有三关（19 / 23 / 29）是超载。压缩是工期驱动的直觉 ——
而要砍的关全在期四，现在砍不省任何工期，只是提前放弃了选项。

### 4 · 模型档位与语料 ✅ 已定

**推荐**：判定档 15 万参数（d=64, L=3, 词表 512 BPE，block=64，batch=16），
探索档 40 万（d=96, L=4）；语料 300 KB 左右、字符结构比原型的模板文法更难，
目标是让参考解的 val loss 停在 **1.0–1.5** 那个区间。

**理由**：15 万档实测 65 ms/步（还有 2–3 倍余量没榨），400 步 ≤ 30 s，
正好卡在一条门槛的预算里；40 万档 150 ms/步，学员按一次「训练」等 1–2 分钟，
能看着曲线降下去。

### 5 · 后训练用发布的检查点，不现训 ✅ 已定

**推荐：是。** 9 关后训练每关现训一个基座要 30–60 秒，纯浪费。
fp16 权重 300–800 KB，随项目发布。**现实里也没有人为了做 SFT 先重新预训练。**

### 6 · PyTorch golden 录制 ✅ 已定：做，排在第二段末尾

**推荐：做，但排在第二段末尾，不是前置。**
性质与 opslab 的 golden 录制、gpulab 的真卡校准完全一样 —— **出题期工具，
学员端与日常 CI 都不依赖**。覆盖约 20 个算子与 5 个 loss，
在有 PyTorch 的机器上跑一次，fixture 入库。

**但要主动指出一个漏洞**：不做这一步，「换到 PyTorch 上照抄就能跑」
这句话就只是我们自己说的。这是这个项目**唯一**没有仓库内真值的地方，
和 gpulab 的时序模型是同一个位置。

### 7 · 多线程留到第五期 ✅ 已定

**推荐：留。** Worker + SharedArrayBuffer 能再快 4–8 倍，
但要 COOP/COEP 响应头，与 Electron 的 `file://` 和 Pages 静态站都别扭。
**接缝在 wasm 核里**（按行切 M 维，确定性天然保持），将来要加不用返工。
先把单线程的 2–3 倍余量榨完 —— 那个不需要任何新东西。

### 8 · 项目 id 与目录 ✅ 已定

**推荐**：项目 id `llm-from-scratch`，定义文件 `projects/definitions/llm-from-scratch.js`，
代码 `src/lib/llmlab/`（与 `opslab/` `gpulab/` `labkit/` 平级），
组件 `src/components/llmlab/`，资产 `public/llmlab/`，
`WorkspaceKind` 那一支叫 `'train'`。

**这一次不做任何抽象。** 三个实验台跑起来之后接缝在哪是量出来的 ——
gpulab 那份文档里「移动，不抽象」那条论证在这里原样成立。
真要提取（比如把「实验台」做成可注册的东西），留到这个项目第二段结束之后。

---

## 十一、已定的设计决策

| 决策 | 结论 |
| --- | --- |
| 工作台抽象 | `WorkspaceKind` 加 `'train'` 一支，六块面板按关卡显隐；不做布局 DSL |
| **学员写什么** | **Python，对着 `nanotorch`（PyTorch 严格子集）写** |
| **怎么跑** | **Pyodide（真 CPython 编 wasm）**，不用 numpy，不碰 CDN |
| **算得多快** | **我们自己的 WASM SIMD 算子核**：实测 sgemm 42 GFLOP/s，端到端 11–16 GFLOP/s |
| **算子核怎么产出** | **C + clang（wasi-sdk）写，`.wasm` 产物与 C 源码一起进仓库**；CI 用钉死版本的 clang 重建并断言字节一致。与 opslab 相反（那个 142MB 的产物是 gitignore 掉的），因为我们的只有几十 KB —— 换来的是日常开发与外部 PR 都不需要装 clang |
| **是模拟还是真训** | **真训**。loss 真的降，梯度真的对，权重真的更新 |
| 张量库分层 | Python 前端（学员可读可改）+ JS 桥（全部计量）+ WASM 核 —— 同 PyTorch 自己的形状 |
| 梯度检验 | **必须跑在 fp64 上**（原型实测：fp32 下参考实现自己都过不了） |
| 门槛的地基 | 结构性计量 + 确定性重放下的学习效果；**墙钟只作展示** |
| 效果门槛的规矩 | 超参种子全部平台固定；门槛卡在参考值与朴素值之间；**每条效果门槛必须配一条结构性门槛** |
| 禁止捷径 | JS 桥数内建调用次数，`builtins.forbiddenCalls = 0` 是精确门槛 |
| 确定性 | 超越函数放进 wasm；`PYTHONHASHSEED` 钉死；千次重放进 CI |
| 后训练起点 | 随项目发布 fp16 检查点，不现训 |
| 与 PyTorch 的等价性 | golden 录制，出题期工具，第二段末尾 |
| 多线程 / WebGPU | 都不做；多线程的接缝留在 wasm 核里 |
| 关卡数 | **30 关，4 期，不压** |
| 代码位置 | `src/lib/llmlab/`，与 `opslab/` `gpulab/` `labkit/` 平级；**不做新抽象** |
| 项目 id | `llm-from-scratch` |
| **UI** | **第一期，而且是第一段的第一个 commit** |

---

## 十二、实施进度

每片一行，合并后回填。完整汇报只在每期结束时写。

### 第一段 · Spike（目标：竖切跑通）

| 片 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 平台接线与工作台分发：`WorkspaceKind` 加 `'train'`、`TrainWorkspaceSpec` / `TrainStageSpec`、`LabMetrics.llm`、草稿路径认 `stage.train.files`、分发页接上 `TrainWorkspace`（六块面板骨架，IDE 真能改文件）、原型入库、`tests/llmlab` 进测试清单 | ✅ |
| 2 | WASM 算子核（C + clang）与构建链 | — |
| 3 | JS 桥：张量常驻内存、分配器、计量层 | — |
| 4 | Pyodide 装配 + nanotorch 骨架 + **竖切：真训 300 步，一条门槛通过/失败** | — |

**这一段的完成标准是「竖切跑通」，不是「组件写完」。**
