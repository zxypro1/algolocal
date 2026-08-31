# llmlab 原型（2026-08-31）

`design/llmlab.md` 第二节「命门」里的每一个数都是这里跑出来的。
本机：darwin/arm64，Node v24.18.1。

| 文件 | 干什么 | 怎么跑 |
| --- | --- | --- |
| `matmul.js` | 纯 JS sgemm 三种写法的吞吐 | `node matmul.js` |
| `nn.js` | 完整 decoder-only transformer（RoPE+GQA+RMSNorm+SwiGLU+权重共享），**手写全部反向**；`F64=1` 切 fp64；`setKernels()` 换算子后端 | 被下面几个 require |
| `gradcheck.js` | 中心差分梯度检验 | `node gradcheck.js` / `F64=1 node gradcheck.js` |
| `train.js` | 规模扫描 / 学习曲线 / 确定性 | `node train.js [size\|learn\|det\|all]` |
| `kernels.wat` | 手写 WASM SIMD：`nn` / `tnacc` / `nt` 三个 sgemm 变体 | — |
| `simd.js` | 单个 SIMD sgemm 与 JS 对比 | `node simd.js` |
| `wasmback.js` | 三个 kernel 的正确性对拍 | `node wasmback.js` |
| `bench2.js` | **JS vs WASM 后端的端到端训练对比** | `node bench2.js` |
| `pyo.js` | Pyodide 冷启 / 调用开销 / 纯 Python 速度 / numpy matmul | `node pyo.js` |

依赖：`npm i wabt pyodide`（`wabt` 只在构建期用，`pyodide` 用来量它自己）。

## 三个最要紧的结论

1. **梯度检验必须在 fp64 里做。** 同一份正确的反向，fp32 下最差相对误差 4.99e-2
   （看起来像写错了），fp64 下 6.79e-4。
2. **手写 WASM SIMD 的 sgemm 是 42 GFLOP/s，纯 JS 是 5.0。** 接回训练循环，
   端到端 3.7–5.0 倍，而且那还是每次调用都拷进拷出的保守写法。
3. **真的学得会，而且逐位可复现。** 140k 参数、字符级、400 步：
   loss 3.32 → 0.21，第 50 步就打穿 bigram 基线 1.743；
   跑两遍权重 0/140352 个元素不同。
