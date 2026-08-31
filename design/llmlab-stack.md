# llmlab 技术选型清单

> 这个领域三个月就能翻篇。选型集中在这一个文件，各关的 primer 从它取值，
> 每个发布周期复核一次这里就够。
>
> **上次核实：2026-08-31**（npm 版本与体积从本地 registry 直查并实测；
> 生态状态经联网核实，来源逐条写在表里）

## 复核清单

逐条确认三件事：**这个东西还在用吗** / **版本变了吗** / **有没有被更新的方案取代**。
改动后更新本文件的「上次核实」日期与对应行。

---

## 一、教学内容的技术栈

学员在关卡里会写、会读、会调的东西。选型贴 2026 年从零训一个模型的真实做法。

### 1.1 模型架构

2026 年的共识是「一个 decoder block 长什么样」这件事已经收敛了：
**RoPE + GQA + SwiGLU + pre-norm RMSNorm + QK-norm + 不带 bias**，
Llama / Mistral / Gemma / Qwen / Phi 各自独立地收敛到同一套。
所以这个项目教的就是这一套，不教 GPT-2 的 LayerNorm + 绝对位置 + GELU
（只在第 2 关拿它当「为什么后来都改了」的对照）。

| 组件 | 选型 | 状态与依据 |
| --- | --- | --- |
| 位置编码 | **RoPE** | 绝对位置嵌入已被淘汰；RoPE 编码相对距离且外推性好，是上下文扩展的前提。<https://magazine.sebastianraschka.com/p/a-dream-of-spring-for-open-weight> |
| 注意力 | **GQA**（MHA 作第 3 关的起点，MLA 在 primer 里讲） | MHA 基本让位给 GQA。**2026 年的新变化：MLA（多头潜在注意力）在大规模上胜出** —— DeepSeek-V3 / Kimi K2 / LongCat 用它，把 KV 压成一个共享潜向量。我们教 GQA（够用、是 KV cache 关的地基），MLA 作为选修关或 primer。<https://magazine.sebastianraschka.com/p/visual-attention-variants> · <https://arxiv.org/pdf/2502.14837> |
| 激活 | **SwiGLU** | 已取代 GELU，同 FLOPs 下白拿质量 |
| 归一化 | **RMSNorm，pre-norm** | 现代 LLM 的默认；LayerNorm 只作对照 |
| 稳定性 | **QK-norm** | 已进入「共识核心块」。注意 MLA 里用不了 QK-norm（Q/K 在推理时只以展开形态瞬时存在） |
| 稀疏化 | **MoE** | 这个时代真正的架构故事：把 FFN 换成一堆专家、每 token 只路由到几个，于是**总参数（容量）与激活参数（每 token 算力）解耦**。做一关，不做通信（那是 gpulab 的地盘） |
| 分词 | **字节级 BPE** | BPE 及其变体仍是 2026 年的主流算法。Llama 3 用 tiktoken 风格的字节级 BPE，词表 128,256；GPT-4o 的 o200k_base 是 199,998 + 2；Gemma 用 SentencePiece 约 256,000。**前沿是 SuperBPE**（两阶段课程，允许跨空格合并，30 个下游任务平均 +4.0%、MMLU +8.2%，推理省 27% 算力）—— 做成第 1 关的加分项。<https://superbpe.github.io/> · <https://openreview.net/pdf?id=lcDRvffeNP> |

### 1.2 训练

| 组件 | 选型 | 状态与依据 |
| --- | --- | --- |
| 优化器 | **AdamW 为主，Muon 做一关** | Muon 已经不是玩具：**Kimi K2（1T 参数）用 MuonClip 预训练，GLM-5（744B）也用**，Moonlight 证明它在 LLM 预训练上比 AdamW 更省算力。做法是对**矩阵形状的参数**用 Newton–Schulz 迭代把动量正交化，嵌入与 bias 仍走 Adam。<https://arxiv.org/pdf/2507.20534> · <https://pytorch.org/blog/using-muon-optimizer-with-deepspeed/> |
| 学习率 | warmup + cosine / WSD | WSD（warmup-stable-decay）配合 mid-training 更常见 |
| 精度 | bf16 计算 + fp32 主权重 | 我们在浏览器里没有 bf16 硬件，**用位级模拟**（同 gpulab 的做法），让「为什么 fp16 会溢出而 bf16 不会」是算出来的 |
| 数据 | **FineWeb-Edu / DCLM / Nemotron-CC 的配方**（我们用等价的小语料复现其**方法**） | 推荐配方：一份通用语料（FineWeb / RedPajama-V2）+ 一份可复现混合（DCLM / HPLTv2）+ 一份专门集（OpenWebMath / The Stack v2）+ 一份 CPT 刷新（Nemotron-CC v2）。FineWeb-Edu 1.3T token 靠 Llama3-70B 标注训出的分类器筛；DCLM 3.8T 用 fastText 分类器筛。**FineWeb-Edu 在学术基准上强，DCLM 在常识推理上强 —— 这个「配方决定能力画像」正是数据关要教的东西。**<https://arxiv.org/pdf/2412.02595> · <https://www.emergentmind.com/topics/fineweb-edu-dataset> |
| 阶段划分 | **预训练 → mid-training → 后训练** | 多阶段已是标配：第一阶段以海量 web 数据为主，第二阶段（mid-training）换成高质量为主的混合。OLMo 2 / Phi-4 / LongCat-Flash 都这么做。<https://arxiv.org/html/2510.06826v1> |

### 1.3 后训练

**2026 年最要紧的一句话：「预训练 + 人类偏好标注的 RLHF」这套标准配方已经死了。**
过去一年发布的每个主要模型（DeepSeek-R1 / Nemotron 3 Super / GPT-5.3 Codex）
用的都是不同的后训练栈，共同点是**混合式管线（SFT 与 RL 融合）+ 模型自己产出的 rollout**。

| 阶段 | 选型 | 状态与依据 |
| --- | --- | --- |
| SFT | 指令-回答对，**只在 completion 上算 loss** | 基础，没有争议 |
| 偏好优化 | **DPO** | 让基座模型礼貌地跟随指令：SFT 然后 DPO，便宜、稳定、形状正好对得上风格与语气 |
| 奖励模型 | **Bradley-Terry 成对排序** | 评测用 RewardBench v2（第二代多技能、按准确率评奖励模型）。<https://arxiv.org/pdf/2410.14872> |
| RL | **GRPO + RLVR** | 推数学/代码/逻辑的推理能力时，GRPO + 可验证奖励 + 组内基线胜过其他做法。GRPO 每个 prompt 采样多条回答、组内比较算优势，**不需要单独的 critic 模型** |
| GRPO 的修正 | **DAPO / Dr.GRPO / GSPO** | 三个必须讲的坑：① **clip-higher**（非对称裁剪，ε_high≈0.28 > ε_low≈0.20，别过度惩罚有希望的轨迹）；② **token 级 loss**（否则偏向短回答）；③ **Dr.GRPO 的长度偏置修正**（按固定最大长度归一化，短答案不该拿到更大的更新）。GSPO 更进一步，把粒度从 token 级换成序列级，对 MoE 更稳。<https://huggingface.co/blog/NormalUhr/grpo-to-dapo-and-gspo> · <https://www.turingpost.com/p/reasoning-rl-in-2026> |
| 长度偏置 | **必须讲** | 现代偏好与策略优化方法几乎都有强长度偏置 —— 模型倾向于把答案写长，哪怕简短更好。这是一条能被我们精确计量的门槛 |

### 1.4 评测

| 基准 | 用途 | 状态（2026-08） |
| --- | --- | --- |
| MMLU-Pro | 知识与推理 | MMLU 对前沿模型已饱和（>90%）；MMLU-Pro 约 12,000 题、14 学科、10 个选项（原来 4 个）以压制蒙对 |
| GPQA Diamond | 专家级科学推理 | 非专家博士约 34% 作地板。2026-02：Gemini 3.1 Pro 94.3%、Claude Opus 4.6 91.3%、GPT-5.3 Codex 81%。顶端接近饱和，60–90% 区间仍有区分度 |
| IFEval | 指令跟随 | 后训练阶段的标准项 |
| AlpacaEval-2 | 对话偏好 | 805 条指令，**长度受控胜率**与原始胜率两个指标 —— 长度受控这件事本身就是教学点 |
| LiveBench | 抗污染 | 每月换题、用新数据源，答案可验证、自动打分 |
| RewardBench v2 | 奖励模型 | 见上 |

来源：<https://datavlab.ai/post/llm-benchmarks-2026-which-model-for-which-job> · <https://www.lxt.ai/blog/llm-benchmarks/>

**这个项目怎么用它们**：我们的模型是 ~1M 参数的字符/小词表模型，
**跑不了任何一个真基准**。所以基准的作用是**教口径**：
学员实现的是「长度受控胜率」「pass@k」「以固定 rubric 做裁判」这些**方法**，
在我们自己的小评测集上跑。题面里写清对应的真基准叫什么、口径是什么，
这样换到真环境里学员知道自己在算什么。

### 1.5 明确不教

| 放弃 | 理由 |
| --- | --- |
| kernel 优化、访存合并、Tensor Core | **那是 gpulab（`llm-accelerator`）的全部内容**，这里重复就是浪费 |
| 分布式训练（DP/TP/PP/EP 的通信） | 同上，gpulab 第 22–29 关已经做了 |
| 多模态、视觉编码器、扩散语言模型 | 与「从零实现一个 LLM 并训练它」这条主线无关 |
| 真实规模的数据管线（去重、PII、分类器筛） | 方法讲、做一关的**缩小版**，不做 TB 级工程 |
| Agent / 工具调用 / 长上下文工程 | 是应用层，不是「实现并训练一个模型」 |
| 真 PyTorch / HF 生态的安装与部署 | 浏览器里没有；接口形状对齐，部署不教 |

---

## 二、实现依赖

许可证判断标准：**兼容 MIT 自托管、仍在维护、浏览器与 Electron 两端都能跑、离线可用**。

### 2.1 JS / WASM 依赖（npm registry 直查 + 本机实测，2026-08-31）

| 用途 | 包 | 版本 | 许可证 | 实测 | 判断 |
| --- | --- | --- | --- | --- | --- |
| Python 运行时 | **`pyodide`** | 314.0.6 | MPL-2.0 | npm 包体 13.87MB；**实际要发布的 5 个运行时资产 13.53MB → brotli 5.86MB**；Node 里**冷启 761ms** | ✓ **采用**（见下方三条硬约束） |
| WAT → WASM | `wabt` | 现行版 | Apache-2.0 | 手写 SIMD sgemm **504 字节**，跑到 42 GFLOP/s | ◐ 只在**构建期**用；若算子核走 C + clang 则不需要 |
| 图表 | `recharts` | 3.6.0 | MIT | — | ✓ 仓库已在用 —— loss 曲线、梯度范数、直方图 |
| 编辑器 | `@monaco-editor/react` | 4.7.0 | MIT | — | ✓ 仓库已在用；Python 高亮 Monaco 自带 |
| 终端 | `@xterm/xterm` | 6.0.0 | MIT | — | ✓ 复用 `WorkbenchTerminal` |
| 语法（备选） | `tree-sitter-python` | 0.25.0 | MIT | 自带预编译 wasm，与 `tree-sitter-bash` 同一条加载路径 | ◐ 只有在「自己写 Python 子集解释器」那条路上才需要；选 Pyodide 就不需要 |

**结论：主线只新增一个运行时依赖 —— `pyodide`。** 算子核是我们自己的 wasm，不引入第三方数值库。

### 2.2 Pyodide 的三条硬约束（不遵守就是线上事故）

1. **绝不 `loadPackage` 到 CDN。** 实测：`py.loadPackage('numpy')` 会去
   `https://cdn.jsdelivr.net/pyodide/v314.0.6/full/` 抓 wheel。这个 app 是**离线优先**的，
   一旦有任何一条这样的路径，断网环境下关卡直接开不了。做法是
   `loadPyodide({ indexURL: 本地路径, packages: [] })`，且**永不调用 `loadPackage`**。
2. **不用 numpy。** 实测 pyodide 里 numpy 的 f32 matmul 只有 **3.0–4.9 GFLOP/s**
   （pyodide 用 Netlib 参考 BLAS，SIMD 与线程都是关的），
   而我们手写的 wasm SIMD kernel 是 **42 GFLOP/s**，差一个数量级。
   顺带省掉 2.9MB 的 wheel。<https://github.com/pyodide/pyodide/issues/3763>
3. **`PYTHONHASHSEED` 必须钉死。** 否则 `hash()` 随机化会让任何依赖集合/字典迭代顺序的
   结果不可复现 —— BPE 训练的 merge 选择就是典型受害者。

### 2.3 实测数字（本机 darwin/arm64，Node v24.18.1，2026-08-31）

| 量 | 实测 | 说明 |
| --- | ---: | --- |
| Pyodide 5 个运行时资产 | **13.53 MB → brotli 5.86 MB** | `pyodide.asm.wasm` 9.60→3.11、`python_stdlib.zip` 2.55→2.49（zip 已压过）、`pyodide.asm.mjs` 1.25→0.23、`pyodide-lock.json`、`pyodide.mjs`。作参照：opslab 现在带的 `opslab-cli.wasm` 是 142MB / 14MB brotli |
| 纯 JS `Float32Array` sgemm（4 行寄存器分块） | **5.0 GFLOP/s** | 朴素 i-j-k 是 2.8 |
| **手写 WASM SIMD sgemm**（f32x4，504 字节） | **42–44 GFLOP/s** | 相对 JS **8.4–10.8×** |
| Pyodide 冷启（不含任何包） | 761 ms | 浏览器里会略高 |
| Python → JS 每次调用 | **1.47 µs** | 一步训练约 150 次调用 ⇒ 0.22ms，可忽略 |
| 纯 Python 三重循环 | **15.8 MFLOP/s** | 比 JS 慢约 300 倍 —— **学员代码必须向量化**（现实里也是这条规矩） |
| Pyodide numpy f32 matmul | 3.0–4.9 GFLOP/s | 见上，不用 |

### 2.4 可以借鉴但不引入的东西

| 项目 | 许可证 | 为什么不引入 | 借鉴什么 |
| --- | --- | --- | --- |
| **nanoGPT / modded-nanogpt** | MIT | 是 PyTorch 代码，跑不了 | **课程结构与代码形状**：我们的 `nanotorch` API 与关卡骨架照着它对，这样学员做完能直接读懂它。modded-nanogpt 的 speedrun 把「架构/优化器/数据固定，只换一件事」做成了基准，这正是我们门槛设计的思路来源。<https://www.tylerromero.com/posts/nanogpt-speedrun-worklog/> |
| **minbpe** | MIT | 同上 | 第 1 关（BPE）的参考实现形状 |
| **TRL**（HF） | Apache-2.0 | 同上 | `SFTTrainer` / `DPOTrainer` / `GRPOTrainer` 的**参数名与默认值**（`beta`、`num_generations`、`max_completion_length`…），我们的 API 逐个对齐 |
| **TensorFlow.js** | Apache-2.0 | 它是完整框架，学员会变成「调 tfjs」而不是「实现 transformer」；且 API 形状与 PyTorch 生态对不上 | 它是目前浏览器里最成熟的自动微分实现，值得读它的 tape 设计 |
| **ONNX Runtime Web (training)** | MIT | 只做已有图的训练，学员写不了自己的模型 | SIMD 能力探测的做法 |

---

## 三、复核时最容易过期的三行

1. **注意力的行业默认**（GQA 还是 MLA；2026 年 MLA 在大规模上已经胜出，
   什么时候该把主线从 GQA 换成 MLA）
2. **后训练的主流路线**（GRPO → DAPO/GSPO 之后还会不会再翻一次；
   RLVR 是不是仍然是推理能力的主路径）
3. **优化器**（Muon 会不会真的取代 AdamW 成为默认 —— 若是，第 13 关的主次要对调）
