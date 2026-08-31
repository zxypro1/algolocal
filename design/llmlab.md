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
| 2 | WASM 算子核（C + clang）与构建链：25 个算子 × f32/f64 两份实例化、自写 exp/log、37KB 零 import 产物入库、`--check` 字节比对进 release.yml、打包白名单加闸门 | ✅ |
| 3 | JS 桥（张量 / 竞技场 / 计量）+ **TS 参考 transformer**：整模型 f64 梯度检验最差 1.47e-5，归纳任务 800 步 loss 2.834 → 1.238（信息论地板 1.213），两遍训练逐位一致 | ✅ |
| 4a | Pyodide 装配：本地资产（5 个文件 13.5MB）、离线、`PYTHONHASHSEED` 钉死、stdout、虚拟 FS、打包白名单 | ✅ |
| 4b | nanotorch（Tensor / 自动微分带 / nn.Module / AdamW）+ **竖切跑通**：Python 脚本 800 步 loss 2.837 → 1.245（地板 1.213），7.0 ms/步，跨实例逐位一致 | ✅ |

**这一段的完成标准是「竖切跑通」，不是「组件写完」。—— 已达成（2026-08-31）。**

### 实测：真产物上的数字（第 2 片，2026-08-31）

| 量 | 值 |
| --- | --- |
| `llmlab-kernels.wasm` | **36,999 字节**，零 import |
| sgemm 512×256×256（f32，SIMD） | **37.3 GFLOP/s**（原型手写 WAT 是 42，差在 tail 处理与更大的形状） |
| 重建 | 同一个钉死的 wasi-sdk 下**字节一致** |
| 梯度检验（f64，中心差分 h=1e-5） | rmsnorm / swiglu / attention / cross-entropy 四组全部 < 2e-3 |

**第 2 片自己抓到的一个 bug**：`ll_log` 的 Remez 系数分了奇偶两组，我把两组写反了。
表现是 log 的相对误差从 1e-16 掉到 **2e-4** —— 而前向的 loss 看着完全正常
（3.2 这种量级，谁也看不出少了几位）。是交叉熵那条对拍用例顶出来的。
这正是「每个算子都要对着一份直白的参考实现对拍」这条规矩的价值：
**数值上的错误不会让程序崩，只会让所有门槛量一个假的东西。**

### 实测：端到端第一次跑通（第 3 片，2026-08-31）

「浏览器里真的能训练」这件事，现在在**真产物**上有证据了 ——
不是原型的那份独立 JS 实现，而是 wasm 算子核 + 计量层 + 参考模型这一整条路。

| 量 | 值 |
| --- | --- |
| 整个模型的 f64 梯度检验 | 最差 **1.47e-5**（`layers.0.wk`），界 2e-3；20 个参数张量各抽 8 点 |
| 归纳任务（前半随机、后半照抄，vocab 16 / seq 16） | 800 步 loss **2.834 → 1.238**；均匀熵 2.773，信息论地板 **1.213** |
| 每步耗时（75k 参数，256 token/步） | **5.6 ms** |
| 反向 / 前向 FLOPs | **1.99** |
| 两遍训练 | loss 序列与 75,072 个权重**逐位一致** |

第二行是这一片最要紧的结果：**模型基本把归纳任务解掉了，离信息论地板只差 1.3%**。
这个任务的前半段是均匀随机的，bigram / unigram 原理上做不到 ——
loss 掉下来只可能来自注意力真的在工作。第 16 关那条「打穿 bigram 基线」的门槛，
形状就是这个。

**这一片自己抓到的一个错**：算理论地板时把预测位置数成了 `seqLen − 1` 而不是 `seqLen`，
地板算成 1.294，比模型实际达到的 1.229 还高。一个「跑出来比理论极限还好」的结果
本该立刻引起怀疑 —— 它确实引起了，然后发现是分母错了。
**门槛的分母也要有人验**，不能只验分子。

### 顺带发现：算法题那边的 Python 是走 CDN 的（第 4a 片）

`src/hooks/useWasmExecutor.ts` 里给**算法题**用的 Python 执行器，
是从 `cdn.jsdelivr.net` 现下 Pyodide 0.26.4 的。这与「100% 离线」的定位矛盾：
断网时那个语言选项直接不可用。

**不在这一片里顺手改** —— 它是另一个功能的路径，版本还要从 0.26 跳到 314
（Python 3.12 → 3.14），得回归整个题库的 Python 参考解。已经单独记成一条待办。
但值得写在这里：llmlab 把 Pyodide 打进包之后，那件事的成本从「引入一个 13.5MB 的依赖」
降到了「改一个 indexURL」。

### 第一段完成：竖切跑通了（2026-08-31）

一份学员形状的 Python → Pyodide → nanotorch → JS 桥 → wasm 算子核 → 真训练。

| 量 | 值 |
| --- | --- |
| 800 步 loss | **2.837 → 1.245**（均匀熵 2.773，信息论地板 **1.213**） |
| 每步耗时 | **7.0 ms**（75,072 参数，256 token/步） |
| 反向 / 前向 FLOPs | **2.01** |
| 参数量 | 75,072，**精确等于解析式** |
| 确定性 | 两个独立 Pyodide 实例跑同一份脚本，loss 序列逐位一致 |
| 禁用算子 | 精确计数，报得出是哪一个 |

学员那一份长这样（完整版在 `tests/llmlab/nanotorch.test.ts` 里）：

```python
class Block(nn.Module):
    def forward(self, x, cos, sin, b, s):
        x = x + self.attn(self.norm1(x), cos, sin, b, s)
        return x + self.mlp(self.norm2(x))
```

—— 和 nanoGPT 里那段是同一个形状。这正是选 Python 的全部理由。

### 这一片踩到的三个坑，都值得留档

**1. 竞技场的 mark 取早了。** AdamW 的梯度是懒分配的，于是落在了每步 `release`
的 mark 之后，第二步就被推平。表现是「没有 id 为 105 的张量」——
一个没有来历的数字，离出错的原因（mark 取在哪一行）已经很远。
**处理方式不是修那一处，是加一条守卫**：`release` 撞见非 activation 角色的张量
就当场报错并说清是哪一个。它随后立刻又抓到了第二个同类问题
（激活的梯度被标成了长期的 `grad` 角色）。

**2. 注意力的输出形状写死了。** 写成 `(batch, seq, heads*head_dim)`，
而上游给的是摊平的 `(rows, dim)` —— 元素数一样、rank 不同，
残差那一步才挂。改成跟 `q` 同形。

**3. 相邻的整数种子给出相关的初始化。** 这个最值钱。
竖切第一版给同一个 block 的 wq/wk/wv/wo 发了 `seed+1..+4`，
xorshift32 只有一条周期，相邻种子落在上面的位置是相关的。
结果：400 步之后 loss 停在 **2.25**；种子在 JS 侧先过一遍 splitmix32 的
finalizer 之后，同样 400 步是 **1.44**，800 步 1.23。

**相关的初始化把学习速度砍掉了一大半，而表面上一切正常** ——
模型在学、loss 在降，只是慢，没有任何东西会报错。
而「给每个张量发一个相邻的整数种子」是任何人都会写的东西，学员一定会写
`seed=1, seed=2`。所以这是**我们 API 的坑，不是他的错**，堵在 `mixSeed` 里，
并配了一条回归用例（seed=1 与 seed=2 的相关系数必须 < 0.08）。

### 第二段 · 前 8 关（目标：一层 Transformer，从分词到解码）

| 片 | 内容 | 状态 |
| --- | --- | --- |
| 5 | 补齐第 3–8 关要的算子：拆开的注意力（`attn_scores` / `softmax_rows` / `attn_apply`，`Sq` 与 `Skv` 分开 → KV cache 白送）、采样（temperature / top-k / top-p，确定性）、bf16 / fp16 的位级模拟 | ✅ |
| 6 | 判定运行时：世界装配（语料 / 词表 / 机器盘）、`@llm/lab`、五个探针、`assertGatesAreStructural`（门槛读 `llm.timing.*` 当场报错） | ✅ |
| 7 | 工作台接上真运行时：训练 / 张量 / 样例三块面板，终端命令搬进可测的纯逻辑 | ✅ |
| 8 | 第 1–2 关（字节级 BPE、三条基线），并在**真浏览器**里点通整条判定 | ✅ |
| 9 | 第 3–4 关（单头因果自注意力、多头 + GQA） | ✅ |
| 10 | 第 5–8 关（RoPE、RMSNorm 与 pre-norm、SwiGLU 与完整 block、采样与 KV cache）+ `nn.ModuleList` / `nn.ParameterList` / `F.scale` / `F.norm` / `F.rms` | ✅ |

### 第三段 · 第 9–21 关（目标：让它学会）

| 片 | 内容 | 状态 |
| --- | --- | --- |
| 11 | 第 9–10 关（手写反向、自动微分引擎）+ `nt.no_grad` / `nt.enable_grad` / `nt.autograd.Function` / `F.gemm` / `F.one_hot` / `parameter(dtype=)` | ✅ |
| 12 | 第 11–12 关（整模型反向、AdamW）+ `F.sumsq` / `F.adamw_` / `Tensor.set_at_` | ✅ |
| 13 | 第 13–14 关（学习率调度、梯度裁剪与稳定性）+ `F.scale_`；修掉两处「只有真的跑训练循环才会暴露」的常驻张量 | ✅ |
| 14 | 第 15–16 关（数据打包与跨文档泄漏、完整预训练循环） | ✅ |
| 15 | 第 17–18 关（混合精度、激活重算）+ `Tensor.detach` / `nt.autograd.backward` / `nt.reset_peak` / `memory.currentActivationBytes` | ✅ |
| 16 | 第 19–20 关（缩放定律、MoE）+ **算子核 ABI 2 → 3**：`mul` / `row_scale` / `row_scale_bwd_s`，以及 `F.gather` / `F.scatter_add` | ✅ |
| 17 | 第 21 关（Muon）—— **第三段完成，21 关** | ✅ |

### 第四段 · 第 22–30 关（后训练）

| 片 | 内容 | 状态 |
| --- | --- | --- |
| 18 | 第 22–23 关（SFT、数据配比与对齐税）+ 后训练共用的算术世界 | ✅ |
| 19 | 第 24–25 关（奖励模型、DPO）+ **算子核 ABI 3 → 4**：`log_softmax_fwd` / `log_softmax_bwd` | ✅ |

### 实测：第 9–10 关（第 11 片，2026-09-01）

| 关 | 门槛 | 参考解实测 | 门槛 |
| --- | --- | --- | --- |
| 9 手写反向 | 前向与内建的差 | 0（12 位小数逐位相同） | ≤ 1e-12 |
| 9 手写反向 | **f64 中心差分的最大相对误差** | **2.01e-10** | ≤ 2e-3 |
| 9 手写反向 | 上游梯度为 3 时的缩放误差 | 5.55e-17 | ≤ 1e-12 |
| 10 引擎 | 与内建引擎的最大差 | **0**（逐位） | ≤ 1e-9 |
| 10 引擎 | **单节点 `_backward` 的最大调用次数** | **1** | = 1 |
| 10 引擎 | 菱形 vs 两条支路之和 | **0**（逐位） | ≤ 1e-9 |

**`2.01e-10` 这个数是第 9 关题面的论据。** 同一份反向在 f32 下量出来是 5e-2 量级
（这个项目在第 3 片实测过 4.99e-2），在 f64 下是 2e-10 —— 差了八个数量级。
中心差分的分子是两个几乎相等的数相减，灾难性抵消吃掉四五位有效数字，
fp32 的 7 位十进制剩不下什么。**梯度检验挂了先看精度，再看代码** ——
这句话现在有两个实测的数撑着。

### 这一段给 nanotorch 补的接口，每一条都是真 PyTorch 的表面

| 接口 | 对应 | 为什么非有不可 |
| --- | --- | --- |
| `nt.no_grad()` / `enable_grad()` | `torch.no_grad()` | 评测与生成循环里不建带，显存差好几倍 |
| `nt.autograd.Function` | `torch.autograd.Function` | 第 9 关「自己写反向」的载体；`forward` 自动跑在 no_grad 里 |
| `F.gemm(..., "nn"/"nt"/"tn")` | BLAS / cuBLAS 的三个转置标志 | 手写 matmul 反向要它，而这就是真实底层的样子 |
| `F.one_hot` | `torch.nn.functional.one_hot` | 交叉熵反向的 `(p − onehot)` |
| `parameter(dtype="f64")` | `model.double()` | 梯度检验必须在 f64 上做 |

顺带修了引擎里的一处不一致：`Tensor.backward()` **原来不给起点播种**，
内建的 `cross_entropy` 反向把 `1/rows` 写死在里面，所以一直没露馅。
但 `autograd.Function` 在根节点上要读 `out.grad` —— 不播种就是 None，什么都不做。
改成和 PyTorch 一样每次都播 1.0。

### 第 10 关的一条门槛写错了，自己修的

「分叉点的梯度 = 两条路各自梯度之和」这条，第一版是把某条支路清零再重跑 loss，
两次的梯度相加去对菱形。**参考解当场挂在 0.025 上** ——
不是实现错了，是这条门槛在量一个不成立的等式：
交叉熵是非线性的，改了 `y` 就改了 `dL/dy`，三次跑的根本不是同一个数。

改成先从学员那次反向里取出 `dL/dy`，再拿**同一份** `dL/dy` 分别喂给两条支路。
这样才是那个真正成立的等式，实测逐位为 0。

**加法在固定上游梯度下才成立** —— 这本身就是链式法则的内容，
而我第一次写的时候把它用错了地方。

### 实测：前 8 关的门槛都量到了什么（第 10 片，2026-09-01）

参考解跑出来的实际值，对照各自的门槛 —— **余量都不小，没有一条是踩线过的**：

| 关 | 门槛 | 参考解实测 | 门槛 |
| --- | --- | --- | --- |
| 5 RoPE | cos / sin 表对 f64 参考 | 2.96e-8 | ≤ 2e-6 |
| 5 RoPE | **整段平移之后分数不变** | 5.59e-9 | ≤ 5e-5 |
| 5 RoPE | 一次前向转几次（q 和 k，不含 v） | 2 | = 2 |
| 6 归一化 | 整体 +1 之后输出的变化（LayerNorm 会是 0） | **1.280** | ≥ 0.05 |
| 6 归一化 | 16 层 / 2 层的残差流增长比 | **0.978** | ≤ 1.25 |
| 7 block | 参数量 | 46208 | = 46208 |
| 7 block | 支路清零后与输入不同的位置数 | **0 / 1024** | = 0 |
| 7 block | 每 token 前向 FLOPs ÷ 2N | **1.042** | ≤ 1.6 |
| 8 解码 | 带 cache 与不带 cache 不同的 token 数 | **0 / 12** | = 0 |
| 8 解码 | 不带 cache ÷ 带 cache 的 FLOPs | **7.26×** | ≥ 3.0 |

三个数值得单独说：

**`1.042`** —— 那条「前向约 `2N` FLOPs / token」的经验规律，在这里不是引用，
是量出来的。注意力那块 `O(S²)` 的项让它略高于 1，正好对得上。

**`0.978`** —— 第 6 关的理论说「乘 `1/sqrt(2L)` 之后残差流的增长与深度无关」。
实测 2 层是 1.243、16 层是 1.216，而**不带缩放的 16 层是 4.226**，
理论值 `sqrt(1+16) = 4.12`。理论、实测、门槛三者对得上，这一关才算是在教东西。

**`0 / 12`** —— 带 cache 与不带 cache 的解码结果**逐位相同**。
不是「差不多」，是一位不差,这条门槛能一次抓住三种错
（RoPE 没跟 offset、掩码没带 offset、追加时 batch 串位），
而这三种错都不报异常，生成出来的东西照样像句子。

### 这一段里两条自己修掉的「门槛没在量真东西」

**1. 第 3 关的误差界一开始写成 `1e-10`，参考解当场挂在 3.5e-7。**
是门槛错了不是实现错了:学员的实现跑在 fp32、参考跑在 f64，必然有差。
fp32 的 ε = 2⁻²³ ≈ 1.19e-7，K 项累加的界约 `√K·ε`，这一关 K ≈ 14，
于是界在 4.5e-7 上下。门槛改成 2e-6（约 6 倍余量），**推导写进了题面** ——
不写清楚的话，「差 1e-3 一定是算错了」和「差 1e-9 不可能跑在 fp32 上」
这两句话都说不出口。

**2. 第 8 关的 top-k 那条一开始只比「k=1 是不是等于贪心」。**
它过了，但过得没有意义:没训过的模型每一步的 argmax 往往是同一个 token，
实测贪心序列就是 `[4,4,4,...]`，于是一个「永远返回 4」的实现也能过。
改成**逐步重放**：把前缀重新算一遍 logits、取出真正的 top-k 集合，
再看采出来的那个在不在里面，并要求采样真的采出了多个不同的 token（实测 5 个）。

两条是同一件事的两面 —— **一条绿的门槛不等于一条有用的门槛**，
得知道它在什么情况下会红。

### 第 6 关顺带发现的一件事：初始化的尺度得跟着宽度走

第 6 关最早按惯例把权重的 `std` 写成 `0.02`，结果「深度效应」几乎量不出来：
16 层不带缩放的增长只有 1.09，带缩放是 1.004，差得不够一条门槛站得住。

原因是 `0.02` 是给 `dim = 768` 调的 —— `0.02 · sqrt(768) ≈ 0.55`。
搬到 `dim = 32` 上，每层支路的输出量级 `σ` 只有 0.11，
`sqrt(1 + L·σ²)` 里那一项根本没份量。改成 `std = dim^(−1/2)`（于是 `σ ≈ 1`）之后，
三个数变成 4.226 / 1.216 / 1.243，和理论一一对上。

这条也写进了题面 —— 它本身就是一个值得学的东西：
**照抄一个为别的宽度调好的常数，不会报错，只会让你看不见你想看的现象。**

### 实测：第 11–12 关（第 12 片，2026-09-01）

| 关 | 门槛 | 参考解实测 | 门槛 |
| --- | --- | --- | --- |
| 11 整模型反向 | 参数量 / 张量数 | 6480 / 20 | = 6480 / = 20 |
| 11 整模型反向 | f64 梯度检验（20 个张量全覆盖） | **3.59e-8** | ≤ 2e-3 |
| 11 整模型反向 | 梯度全零的张量数 | 0 | = 0 |
| 11 整模型反向 | **反向 / 前向 FLOPs** | **2.017** | ≤ 2.2（理论 2） |
| 12 AdamW | 20 步之后与参考实现对不上的位置 | **0**（逐位） | = 0 |
| 12 AdamW | 第一步幅度与 lr 的相对差 | **2.4e-7** | ≤ 0.02 |
| 12 AdamW | 零梯度 100 步后一维参数的范数比 | **1.000** | ≥ 0.999 |
| 12 AdamW | 优化器状态 / 参数 字节比 | **2.000** | = 2 |

**`2.017`** 把 `6N` 那个式子补完了：前向 `2N`、反向 `4N`。
理论说反向是前向的两倍（每个矩阵乘要算 dX 和 dW），实测 2.017。

**`36.6%` 对 `100.0%`** —— 第 12 关那条「一维参数不衰减」的探针。
零梯度跑 100 步，只剩衰减在起作用：矩阵剩 36.6%，一维剩 100.0%。
而 `(1 − lr·λ)¹⁰⁰ = (1 − 0.01)¹⁰⁰ = 36.6%` —— **理论值和实测值完全一致**，
这也正是「把一维也衰减掉」的实现会落到的那个数。

**`2.4e-7`** 验的是偏差修正。恒定梯度下，修正做对了第一步的幅度恰好是一个 `lr`
（`m̂/√v̂ = ±1`）；不修正是 `0.1/0.2236 ≈ 0.447` 倍。两个数都写进了题面。

### 第 11 关：一个「优化」引入的假误差，查了三轮才找到

整模型的梯度检验第一版量出 **8.4e-3**（门槛 2e-3）。三轮排查：

1. 先怀疑初始化没跟着宽度走 —— `0.02` 是给 `dim=768` 调的，
   这个模型 `dim=16`。改成按扇入初始化（`std = fan_in^(−1/2)`）之后
   降到 1.35e-3，**勉强过了，但余量只有 1.5 倍**,这种「刚好过」本身就是信号。
2. 怀疑是中心差分的舍入。把步长从 1e-5 放大到 1e-4 —— **数字一动不动**。
   舍入误差随 1/h 走，不随 h 变的话就不是舍入。这一步排除了整条路。
3. 真正的原因在我自己写的那个优化里。

整模型有 6480 个参数，每次差分都把整块搬过语言边界太慢，
所以我只发**变化了的那一个元素**。而基准取错了：取的是「原始值」，
不是「Python 那边现在是什么」。

探针在 `(+h, −h)` 两次取值之后会把 JS 这边的元素还原，
**但那次还原后面没有跟一次 `loss()`** —— 于是 Python 那边永远停在 `−h` 上。
下一次比对时 JS 的值等于原始值，差分为空，那个 `−h` 就再也发不过去了。
**每查一个元素，模型就永久地偏一点**，160 个元素之后偏出一个假的误差。

改成拿「Python 那边现在的状态」当基准之后：**3.59e-8**，余量五万倍。

两条留给自己的话：
- **「刚好过」和「挂了」一样值得查。** 第 1 步之后它是绿的，但 1.5 倍余量
  在一个理论上该到 1e-8 的量上是说不通的。
- **为了快而做的增量同步，要同步的是对面的状态，不是自己的历史。**
  这个错在单个元素上完全正确，只有连着查很多个才暴露。

（按扇入初始化那条改动留下了 —— 它本身是对的，是第 6 关那条结论的直接应用，
只是它不是这次的病因。题面里的说法也相应改成了「残差流几乎不动」，
不再说「梯度检验量不准」。）

### 第 12 关：把内建实现换成报错的桩，记得换回来

第 12 关不许用 `nt.optim.AdamW`，所以判定把它替换成一个当场报错的桩。
但**判定自己还要拿它当参考跑一遍** —— 第一版忘了这件事，
换掉之后就再也没换回来，参考那一路直接撞上自己设的桩。

第 10 关那条「不许调 `Tensor.backward()`」用的是 `try / finally` 还原，
这一关一开始却没有。同一个套路第二次用就漏了一半,
所以现在两处都是「存一份、用完还回去」。

### 实测：第 13–14 关（第 13 片，2026-09-01）

这两关是**第一次真的在关卡里跑训练循环**（前面几关都是单步或纯数值），
于是也第一次踩到了只有训练循环才暴露的东西。

| 关 | 门槛 | 参考解实测 | 门槛 |
| --- | --- | --- | --- |
| 13 调度 | 60 个采样点上与参考公式的最大差 | **1.73e-18** | ≤ 1e-12 |
| 13 调度 | `step = warmup` 处与 base_lr 的差 | **0** | ≤ 1e-12 |
| 13 调度 | 300 步后最后 10 步平均 loss | **1.2856** | ≤ 1.45 |
| 13 调度 | 最终 loss / 信息论地板 | **1.060** | ≤ 1.2 |
| 14 裁剪 | 裁剪后的最大全局范数 | **1.0000000** | ≤ 1.000001 |
| 14 裁剪 | 裁剪前后夹角余弦与 1 的差 | **3.33e-16** | ≤ 1e-6 |
| 14 裁剪 | 因梯度非有限跳过的步数 | **1** | = 1 |
| 14 裁剪 | 结束时参数里非有限的个数 | **0** | = 0 |

**第 13 关的对照实验**（同模型、同数据、同 seed、300 步）：

```
带 warmup（20 步）    1.2856
不带 warmup           1.9635
信息论地板             1.2130
均匀（什么都没学）      2.7726
```

不带 warmup 的那一路**走了三分之二的路程就停住了**。
这两个数是先量出来才写进题面的 —— 定 1.45 这个门槛之前，
我先跑了 peak ∈ {0.01, 0.03, 0.06, 0.1} × warmup ∈ {0, 20} 八组，
0.06 和 0.1 两档两边都塌在均匀熵上（模型直接废了），
0.03 那一档差距最干净。**门槛是从测量里挑出来的，不是拍出来的。**

第 14 关注入一次 `inf` 之后跳过一步，训练照常收敛到 **1.3557** ——
「跳过」这件事只有在模型确实还在学的前提下才验得到，
所以那条用例额外要求最后的 loss 明显低于均匀熵。

### 两个只有真的训练才会暴露的 bug

前面十二关都不跑训练循环 —— 要么单步，要么纯数值。
第 13 关第一次跑起来，**竞技场那条守卫连着抓了两个**：

**1. `F.causal_valid` 每次前向都新建一个 `role="data"` 的张量。**
`data` 是常驻角色，而它落在训练循环那个 mark 之后 ——
第二步的 `release` 当场报错。它之所以一直没露面，是因为竖切用的是
**融合的**注意力（`attn_fwd`），走不到 `causal_valid`；
而拆开的那条路（第 3 关起）在第 13 关之前从来没进过训练循环。
改成 `activation`,它本来就是每步按 (batch, heads, seq) 重算的一次性中间量。

**2. `RopeAttention` 每次前向重建 RoPE 表**，同样是 `role="data"`。
这一条更值得说：`rope_tables` 的文档里明明写着「整个训练里算一次就够」，
而 `parts.py` 里的实现每次前向都建一遍。**文档说对了，实现没照做**，
而在不跑训练的十二关里两者没有区别。
改成 `__init__` 里按 `max_seq` 建好（Llama 的 `rotary_emb` 就是这么挂的），
`offset == 0` 时直接用前 `seq` 行。

这两条的共同点：**守卫是对的，它们从第一天起就在那里等着**。
「release 会丢掉长期张量」这条错误信息直接点出了角色和张量名，
两次都是一眼定位。第 3 片写下那条守卫时的判断，在这里第二次收回报酬。

### 顺带：一个我差点写进题面的假因果

第 11 关的梯度检验调试时，我一度以为「误差偏大」是初始化没跟着宽度走造成的，
并把这句话写进了 `parts.py` 的文档字符串。
真实原因是判定里的增量同步（见第 12 片）。

改动本身留下了 —— 按扇入初始化是对的，是第 6 关那条结论的直接应用。
但**理由改掉了**：现在写的是「支路输出的量级只剩 0.08，残差流几乎不动」，
不再说「梯度检验量不准」。

**一句没被验证的因果，比一个没做的改动更贵** —— 它会被人照着推理下去。

### 实测：第 15–16 关（第 14 片，2026-09-01）

**期二（第 9–17 关）到这里差一关就满了**，而第 16 关是整条预训练链的收口。

| 关 | 门槛 | 参考解实测 | 门槛 |
| --- | --- | --- | --- |
| 15 打包 | token 一个不丢不重 | **1536 / 1536** | 全对 |
| 15 打包 | 填充率 | **0.00%**（一篇一块的对照 **31.4%**） | ≤ 2% |
| 15 打包 | 跨文档还有概率的位置对 | **0 / 16640** | = 0 |
| 15 打包 | 未来位置非零的个数 | **0** | = 0 |
| 16 预训练 | 留出集 loss | **1.604** | ≤ 1.90 |
| 16 预训练 | 验证 loss / bigram 基线 | **0.748** | ≤ 0.85 |
| 16 预训练 | 同 seed 两遍对不上的位置 | **0**（逐位） | = 0 |
| 16 预训练 | 评测里建了带的调用数 | **0** | = 0 |

**`0.748` 是这个项目到目前为止最有分量的一个数。**
字符语料上，bigram（只看前一个字符）的交叉熵是 2.144,
那是「只看一个字符」能做到的极限。95,680 个参数的模型跑 400 步之后是 1.604。
打穿 bigram 意味着模型**真的用上了更长的上下文**,
这是「注意力在工作」的直接证据，而不是「loss 在降」这种几乎不携带信息的说法。

三条基线一起看：均匀 3.912 / unigram 2.993 / bigram 2.144 / **模型 1.604**。

### 第 15 关：掩码换了一种表示

前面所有关的因果掩码都写成「每行能看到前多少个键」—— 一个**前缀长度**。
第 15 关第一次需要**区间**（「从第 3 列到第 5 列」），前缀长度表达不了。

所以换成**加性掩码**：不许看的位置加一个很大的负数，softmax 之后 `exp` 下溢成硬 0。
PyTorch 的 `attn_mask` 就是这个形式。两种表示各有各的位置 ——
前缀长度一行一个整数，加性掩码通用但要一整块 `[B,H,S,S]`。

这一关也是**第一次不需要动算子核就把新能力加进来**：
加性掩码走的是已有的 `F.add` + `F.softmax`，一行 C 都没改。

### 两条我自己写错的门槛，都是「没先量就写了数」

**1. 填充率的对照写成「超过 30%」，block_size 取 32 时实测只有 18.6%。**
不是实现错了，是我把设计文档里那个「0.3+」当成了不随配置变的常数。
换成 `block_size = 64`（也更接近真实,真实的块长是 1024 起）之后实测 31.4%,
数字对上了，而且这个块长本来就更合理。

**2. 「这几块里至少出现 5 个不同的文档编号」。**
4 块 × 32 = 128 个 token，而语料的句子中位数是 69 个字符 —— 装不下 5 篇。
更要紧的是**这条断言问错了问题**：跨文档泄漏的前提不是「出现了几篇」，
而是「**有几块横跨了边界**」。一块里只有一篇的话，
块对角掩码和普通因果掩码根本没区别，那一条就是白测的。
改成数「横跨边界的块数 ≥ 2」，实测 4 块里有 3 块横跨。

两条的共同点：**一个断言要先想清楚它在什么情况下会红。**
第一条是数字没量，第二条是问题问偏了 —— 后者更危险，
因为它绿着的时候什么都没保证。

### 第 16 关的一条门槛：评测有没有建带

「评测要在 `no_grad` 下跑」这件事，**数值上验不出来** ——
不加 `no_grad` 算出来的 loss 完全正确，唯一的代价是白建了一整条反向的带。
小模型上连耗时都看不出差别。

所以判定换了个查法：把 `F.embedding` 换成一个记账的包装，
记下评测过程里每次调用时 `is_grad_enabled()` 的值，要求**全部是 False**。
实测「调了 4 次前向，其中建带的 0 次」。

这是这个项目里「结构性计量」这条原则的又一个例子:
**量不到的东西就换一个能量到的东西量**，而不是把门槛降成「大概吧」。

### 实测：第 17–18 关（第 15 片，2026-09-01）

**期二（第 9–17 关）到第 17 关满了**，第 18 关是期三的第一关。

| 关 | 门槛 | 参考解实测 | 门槛 |
| --- | --- | --- | --- |
| 17 混合精度 | bf16 舍入的最大相对误差 | **3.813e-3** | ≤ 2⁻⁸ = 3.906e-3 |
| 17 混合精度 | 1e5 量级下 bf16 溢出的个数 | **0 / 64**（fp16 **64 / 64**） | = 0 |
| 17 混合精度 | 参数与其 bf16 版本的差（主权重完好） | **3.88e-3** | > 0 |
| 17 混合精度 | 250 步后 bf16 与 fp32 的 loss 差 | **0.0033** | ≤ 0.05 |
| 18 激活重算 | 前向留给反向的激活（重算 / 不重算） | **0.063**（2299 KB → 145 KB） | ≤ 0.4 |
| 18 激活重算 | 与不重算对不上的梯度 | **0 / 70048**（逐位） | = 0 |
| 18 激活重算 | 前向 FLOPs 的变化 | **0** | = 0 |
| 18 激活重算 | 反向 / 前向 | **2.004 → 2.997** | ≤ 3.6（理论 3） |

**`3.813e-3` 对 `2⁻⁸ = 3.906e-3`。** bf16 有 7 位显式尾数，
相对分辨率的上界就是 2⁻⁸。实测顶在界下面一点点,位级模拟是真的位级。

**`2.004 → 2.997`。** 重算多跑一整遍前向，而这一遍落在**反向阶段**，
所以前向 FLOPs 一点不变（实测差恰好 0），涨的是比值。
`6N → 8N` 这个说法在这里是量出来的。

**`0 / 70048`。** 重算跑的是同一串算子、同一个顺序，梯度**逐位相同**。
这条门槛抓的是「忘了 detach」——不 detach 的话新子图接回原图，
反向沿同一条路走两遍，**梯度正好翻倍**，而 loss 照样降
（等效学习率大了一倍），看起来完全正常。

### 第 18 关量错了对象，第一版显示成「没省」

第一版量的是 `memory.peakActivationBytes`。实测**峰值比 1.055** ——
重算之后峰值反而**更高**。

不是实现错了，是**量错了对象**。这个竞技场是按标记回退的，
反向自己的临时量在整步结束之前不会被放掉；峰值里混着这一部分，
而重算不但不省它，还因为多算一遍而略高。

该看的是「**前向刚结束、反向还没开始**那一刻还占着多少激活」——
那才是重算省下来的东西。为此给计量树加了 `memory.currentActivationBytes`，
判定把一步拆成 `step_forward` / `step_backward` 两次调用，在中间读一次。

换了对象之后：**2299 KB → 145 KB，比 0.063**。

**一个完全正确的实现，量错对象就会显示成「没省」** ——
而当时的第一反应是去怀疑实现。这条写进了 `metrics.ts` 里那个字段的文档。

### 第 17 关：不假装小模型上 fp16 会炸

设计文档里第 17 关那条门槛原本是「**fp16 对照必须溢出**」。
实测下来，这个模型上 **fp16 也能正常训**（250 步 loss 0.186，和 fp32、bf16 一个水平）——
激活和梯度都远够不到 65504。

所以没有制造一个假的失败，而是把「范围」单独拿出来量：
一组 `1e5 ~ 6.4e6` 的数，fp16 **64 个全溢**，bf16 **一个都不溢**。
题面里也明说了「这一关的模型太小，fp16 在这里也能训下来 ——
范围的问题要到真实尺度才出现」。

**门槛要么量到真东西，要么就换个能量到的东西量，不能演。**

### 这一段给 nanotorch 补的接口

| 接口 | 对应 | 用在哪 |
| --- | --- | --- |
| `Tensor.detach()` | `torch.Tensor.detach()` | 重算要从干净的叶子出发；Cast 要拷贝而不是就地改 |
| `nt.autograd.backward(y, grad)` | `torch.autograd.backward` | 起点不是标量的反向（重算那一遍） |
| `nt.reset_peak()` | —— | 量「这一段的峰值」，不把上一段的常数项算进来 |
| `memory.currentActivationBytes` | —— | 第 18 关的门槛读它 |

`detach()` 的角色固定成 `activation`，不跟着原张量走 ——
否则 `detach()` 一个参数会在训练循环里造出一个 `param` 角色的临时张量，
落在每步的 mark 之后，release 当场报错。这是写 Cast 时当场撞到的。

### 实测：第 19–20 关（第 16 片，2026-09-01）

| 关 | 门槛 | 参考解实测 | 门槛 |
| --- | --- | --- | --- |
| 19 缩放律 | 4 个拟合点上的 log 残差 RMS | **0.0227** | ≤ 0.04 |
| 19 缩放律 | **外推的相对误差** | **3.86%** | ≤ 15% |
| 19 缩放律 | 拟合出的指数 β | **0.386** | ≥ 0.15 |
| 20 MoE | 前馈 FLOPs / 同参数量的稠密前馈 | **0.521** | ≤ 0.6 |
| 20 MoE | 容量宽松时的丢弃数 | **0**（负载 14/16/15/19） | = 0 |
| 20 MoE | 容量收紧时的丢弃数 | **40** | ≥ 1 |
| 20 MoE | 辅助损失与参考公式的差 | **0**（逐位） | ≤ 1e-6 |

**`0.521` 对 `top_k / n_expert = 0.50`。** 多出来的 4% 是路由器和
gather/scatter 的开销 —— 这个数把「稀疏是真的」变成了一件量得出来的事，
而不是一句声明。

**`3.86%`。** 拿 D 从 1.8 万到 6 万这四个点，预测 D = 13.6 万处的 loss：
0.982 对 1.021。比最后一个拟合点远 2.3 倍、比第一个远 7.6 倍。

### 第 19 关：参数轴走不通，这件事本身进了题面

设计文档里第 19 关写的是「跑一组小档，预测大档」——**参数轴**。
实测下来，固定学习率、固定步数，四个宽度跑出来是：

```
dim=16  loss 1.379      dim=32  loss 1.081
dim=24  loss 1.220      dim=48  loss 1.201      dim=64  loss 1.709
```

**大的反而更差。** 不是缩放律不成立,是**最优学习率随宽度变**，
而我给所有档位用了同一个。这正是 `µP`（最大更新参数化）存在的理由。

先试过的两条路都不行：
- 200 步：大模型欠训练，曲线不单调
- 600 步（归纳任务）：所有档位都撞到信息论地板，甚至更低 —— 40 个批次被背下来了

最后走**数据轴**：固定一个模型，恒定学习率，看 loss 随「看过多少 token」怎么降。
曲线天然单调，拟合干净（2.099 → 1.876 → 1.609 → 1.312 → 1.160 → 1.021），
一次训练 2.7 秒。

**而参数轴那组失败的数字写进了题面** —— 它比一句「缩放律要调超参」有用得多。

### 第 20 关：稀疏的对照组一开始比错了

第一版拿「同样 dim / 同样 hidden 的稠密前馈」当对照，量出来 MoE 是它的
**2.09 倍** —— 看起来完全不省。

不是实现错了。top_k=2 的 MoE 每个 token 走两个专家，
对着同样宽度的稠密前馈当然是两倍工作。

**MoE 省的是「同样多的参数，更少的算力」，不是「更少的参数」。**
所以对照必须是**同参数量**的稠密前馈,hidden 要乘 n_expert。
换过来之后：0.521，正好是 `top_k / n_expert` 加上一点路由开销。

这条和第 18 关那个「量错对象」是同一类错，一天里犯了两次：
**比值型的门槛，分母比分子更容易写错，而且写错了照样是个像模像样的数。**

### 算子核加了三个：ABI 2 → 3

第 20 关要真的做稀疏执行（不是「算了再掩」），缺两样东西：
逐行乘一个系数（路由权重）、以及把算完的结果放回原位。

| 算子 | 对应 | 为什么要 |
| --- | --- | --- |
| `mul` | `a * b` | 逐元素乘，GRPO 的 ratio×advantage 也要用 |
| `row_scale` | —— | 一行一个系数：路由权重 / SFT 掩码 / 优势加权 |
| `row_scale_bwd_s` | —— | 上面那个对系数的反向 |

`gather` / `scatter_add` 没有新增算子 —— 它们**就是** `embed_fwd` / `embed_bwd`。
区别只在语义：嵌入表是参数，而 MoE 里被取的是激活。反向都是散射累加。

重建之后 `--check` 确认与仓库里那份**字节一致**，ABI 从 2 提到 3
（两边对不上会当场炸）。产物从 37KB 涨到 **60KB**。

### 实测：第 21 关（第 17 片，2026-09-01）

| 门槛 | 参考解实测 | 门槛 |
| --- | --- | --- |
| 正交化之后 \|XᵀX − I\| 的最大元素 | **0.480** | ≤ 0.6 |
| 谱最宽那个形状上的偏差降幅 | **0.064**（7.362 → 0.470） | ≤ 0.2 |
| 动量缓冲跨步存活且非零 | **14 / 14** | 全部 |
| **同预算下 Muon / AdamW 的 loss** | **0.851**（1.081 → 0.920） | ≤ 0.95 |

四个形状的正交化：

```
32x32   正交化前 1.571  之后 0.426  降到 0.271
32x88   正交化前 0.885  之后 0.343  降到 0.387
88x32   正交化前 7.362  之后 0.470  降到 0.064
64x16   正交化前 5.646  之后 0.480  降到 0.085
```

**`0.48` 这个数不是「没收敛」。** 五步 Newton–Schulz 的三个系数
`(3.4445, −4.7750, 2.0315)` 不是为了收敛到精确正交调的，
而是为了「五步之内把奇异值挤进大致 [0.7, 1.3]」。
Muon 要的只是各方向步长差不多,精确正交要做 SVD，而 SVD 在 GPU 上不划算。
题面里明写了这一条，免得学员照着 1e-6 去调。

### 对照组第二次写错，还是同一类错

「正交化把偏差降下来了」这条，第一版拿**归一化之后的随机高斯矩阵**当对照，
量出来的降幅是 **1.14** —— 看起来 NS 什么也没做。

不是 NS 不行：**归一化之后的随机高斯矩阵本来就已经接近正交了。**
随机矩阵的奇异值谱很窄，所以对照本身就没偏多少，比值自然接近 1。

改成给每一列乘一个跨两个数量级的系数，把谱拉开之后：
32x32 降到 0.271，88x32 降到 0.064。

但还有第二层：**四个形状里，32x88 的对照只有 0.885**,
归一化之后的宽矩阵在它的短边上依然接近正交。
拿它当分母问「降了多少」问的不是同一个问题。
所以最终只在**谱最宽的那个形状**上问降幅，并且要求对照本身 > 2。

这是这一段里第三次在**分母**上出错（第 18 关量错对象、第 20 关对照组比错、
这里对照组不够偏）。**比值型的门槛，分子通常是对的，错都错在分母。**

### 第 21 关自己抓到的一个 bug

Muon 的动量缓冲第一版写成 `self._m[i] = F.add(self._m[i], g)` ——
这建的是一个**新的激活张量**，落在训练循环那个 mark 之后，
第二步的 release 把它推平，第三步读到一块已经回收的显存。
报错是「没有 id 为 24995 的张量」。

改成就地更新（`F.scale_` + `add_inplace`）。
**优化器状态必须一直是同一块内存** —— 这是它和激活最根本的区别，
而这一条现在有一个专门的用例盯着：三步之后动量缓冲的 handle 必须还是原来那些。

### 第三段完成（第 9–21 关）

反向传播、优化器、训练循环、数据、显存、缩放律、MoE、Muon。
到这里**预训练侧全部完成**,下一段是后训练（第 22–30 关）。

### 后训练用什么任务：可验证的算术

后训练的每一步都要能**判对错**,SFT 要判格式，DPO 要判偏好，
GRPO 要判答案。算术是最干净的可验证任务：`7+5=` 的答案只有一个，
不需要人标。这正是 `RLVR` 的前提。

词表 15 个 token（0-9、`+`、`-`、`=`、EOS、PAD），
模型 `dim=48, n_layer=2, n_head=4`，序列长 12。

**两个训练档位是量出来再定的：**

| 档位 | 配置 | 实测 |
| --- | --- | --- |
| SFT（第 22–23 关） | 加数 < 10，300 步 | 精确匹配 **100%**，1.6 秒 |
| RL 的起点（第 28 关） | 加数 < 20，100 步 | 精确匹配 **50%**,给 RL 留出空间 |

第二个档位是特意留的：**从 100% 出发的模型，RL 没有任何东西可学**。

### 实测：第 22–23 关（第 18 片，2026-09-01）

| 关 | 门槛 | 参考解实测 | 门槛 |
| --- | --- | --- | --- |
| 22 SFT | prompt 位置上梯度不为 0 的个数 | **0**（76 个屏蔽位全干净） | = 0 |
| 22 SFT | 与参考 mask 对不上的位置 | **0** | = 0 |
| 22 SFT | 按 mask 的 loss 与平台重算的差 | **0**（逐位） | ≤ 1e-6 |
| 22 SFT | 留出集精确匹配 | **100%** | ≥ 90% |
| 23 配比 | 混合比例的最大误差 | **0.000** | ≤ 0.02 |
| 23 配比 | 新能力：减法 | **97.9%** | ≥ 85% |
| 23 配比 | **对齐税**：加法掉了多少 | **2.1 个点** | ≤ 15 |
| 23 配比 | 全指令对照掉了多少 | **87.5 个点** | ≥ 30 |

**`87.5` 对 `2.1`。** 同一个起点（加法 100%），
全用减法数据微调之后加法只剩 **12.5%**;一半一半时加法还有 **97.9%**，
而减法一样到 97.9%。对齐税在这里不是一个概念，是一个量出来的数。

**`3.373` 对 `2.385`。** 第 22 关那条「cross_entropy 报的不是你要的数」——
同一批数据同一个模型，按 mask 算是 3.373，而 `cross_entropy` 返回 2.385
（把 prompt 与 padding 都平均进去了）。而且 SFT 越训，后者会**往上走**。
拿它当训练曲线，调参的方向是反的。

### 一个结构上的设计：两条门槛必须同时卡

第 23 关的四条门槛里，最要紧的是**「学会减法」和「别忘加法」同时成立**。

只卡前者，最省事的做法是全用减法数据；只卡后者，最省事的做法是一条都不加。
**只有两条一起卡，「配比」这个问题才存在。**

第四条门槛是给对照组的：全指令的那一路**必须真的塌掉**（≥ 30 个点）。
不卡这一条的话，某天任务变简单了、对齐税消失了，前三条照样全绿,
而这一关已经不在教任何东西了。

### 实测：第 24–25 关（第 19 片，2026-09-01）

| 关 | 门槛 | 参考解实测 | 门槛 |
| --- | --- | --- | --- |
| 24 奖励模型 | 与 `−log σ(Δ)` 参考的差 | **0**（逐位） | ≤ 1e-6 |
| 24 奖励模型 | 多补 padding 之后分数的变化 | **< 1e-6**（对照：读 padding 位差 > 1e-3） | ≤ 1e-6 |
| 24 奖励模型 | 留出集成对准确率 | ≥ 0.9 | ≥ 0.9 |
| 24 奖励模型 | 校准误差 | ≤ 0.15 | ≤ 0.15 |
| 25 DPO | 与 DPO 参考公式的差 | **0**（逐位） | ≤ 1e-6 |
| 25 DPO | 训练后参考模型被改动的参数 | **0** | = 0 |
| 25 DPO | 隐式奖励排序准确率 | ≥ 0.9 | ≥ 0.9 |
| 25 DPO | **好输出上的逐 token KL** | **0.561** | ≤ 0.8 |

### 一个贯穿两关的等价

`−log σ(Δ)` **就是两类 softmax 的交叉熵**。于是奖励模型和 DPO
在形状上是同一个东西,区别只在分数从哪来。两关都不必单独实现 sigmoid 及其反向，
而 chosen / rejected 交替排出来的 `[2n, 1]` 的扁平布局正好就是 `[n, 2]` 的 logits。

### β 的作用和直觉相反，这条是量出来的

「β 越大约束越紧」在**固定步数、固定学习率**下是错的。
损失对 Δ 的梯度是 `β·(1 − σ(β·Δ))`,早期 σ ≈ 0.5，梯度大小正比于 β。

```
β = 0.1   KL 0.841
β = 0.5   KL 1.353      ← 更大的 β，跑得更远
```

β 的约束要到收敛之后才体现（最优解里的 KL 罚项是 `1/β`）。
真正压住漂移的是步数和学习率：减半之后 **0.561**。三个数都写进了题面。

### KL 该在哪些序列上量：第四次栽在口径上

第一版在**所有** completion 位置上量 KL，得到 **2.64**。
不是策略跑飞了 —— **rejected 的概率正是 DPO 主动在压的**，
那个数越大恰恰说明 DPO 在起作用。拿它问「跑没跑飞」问的不是同一件事。

只在 **chosen** 上量：2.64 → 0.841。

这个项目里同类的错已经第四次：第 18 关量了峰值而不是留存、
第 20 关拿同宽度而不是同参数量的稠密做对照、第 21 关拿本来就接近正交的
随机矩阵做对照、这里拿被主动压低的那一半算 KL。
**比值和差值型的指标，错几乎总在「和谁比」上。**

顺带还发现起点不能太强：SFT 到 100% 的模型上 DPO 无事可做，只会一味锐化，
KL 反而更大（2.64）。换成 50% 那个档位之后才正常。

### 算子核：log_softmax（ABI 3 → 4）

DPO / GRPO 全都要 log-prob，而 `log(softmax(x))` 在小概率上会先下溢成 0
再变成 −inf。合成一步之后不必显式算出概率。

反向是 `dx_j = dout_j − exp(out_j)·Σ_k dout_k` ——
和 softmax 的反向长得像，但**求和项不带权重**。
写成 softmax 那一版的话前向照样对、梯度悄悄错，所以配了 f64 中心差分的用例。

产物 60,043 → **65,711 字节**，`--check` 字节一致。