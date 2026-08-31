/*
 * llmlab 的算子核。
 *
 * 这是「浏览器里真的能训练」这件事的地板。原型实测（design/llmproto/）：
 * 纯 JS 的 sgemm 是 5.0 GFLOP/s，同一个算法编成带 SIMD 的 wasm 是 42 GFLOP/s，
 * 接回完整训练循环端到端快 3.7–5.0 倍。
 *
 * ## 三条设计约束
 *
 * **零 import。** 不链 libc、不链 wasi-libc，超越函数自己写（math.h）。
 * 于是 `WebAssembly.instantiate(module, {})` 就能起来 ——
 * 浏览器、Node、Electron 三处同一条路径，也不用 stub 任何 WASI 调用。
 *
 * **内存由 JS 管。** 这里只导出纯函数，参数全是**相对 `__heap_base` 的字节偏移**。
 * 张量的分配、形状、dtype、以及全部计量都在 JS 桥那一层
 * （门槛读的 `llm.flops.*` / `llm.memory.*` 就是在那里数的）。
 * wasm 这边不认识「张量」，只认识一段数。
 *
 * **f32 与 f64 是同一份源码的两次实例化**（见 ops.h）。梯度检验必须跑在
 * 双精度上，而它验的必须是 fp32 那条路径本身的算法。
 *
 * ## 产物怎么来的
 *
 * `scripts/build-llmlab-kernels.sh`，clang 来自钉死版本的 wasi-sdk。
 * **产物 `public/llmlab/llmlab-kernels.wasm` 进仓库**（只有几十 KB），
 * CI 重建并断言与仓库里那份字节一致。
 * 和 opslab 那个 142MB 的 wasm 相反 —— 那个太大只能 gitignore + CI 挂 release，
 * 代价是本机没装 Go 就改不了它。我们这个小，所以可以两全。
 */
#include "math.h"

/*
 * 线性内存的基址。
 *
 * `__heap_base` 是链接器给的符号，指向静态数据之后的第一个字节。
 * 不直接用绝对地址 0：对 C 来说那是空指针，编译器可以按 UB 优化掉解引用。
 * JS 那边读导出的 `__heap_base` 全局，把自己的分配都放在它之后。
 */
extern unsigned char __heap_base;
#define ll_mem (&__heap_base)

/* ------------------------------------------------------ f32：带 SIMD 的那份 */

/*
 * `aligned(4)` 是关键：Float32Array 只保证 4 字节对齐，而向量类型默认要 16。
 * 不声明的话 clang 会发对齐的 v128.load，遇到没 16 对齐的张量就读错
 * （wasm 本身不 trap，所以这会是一个静默的错误结果）。
 */
typedef float ll_f32x4 __attribute__((vector_size(16), aligned(4)));

#define SCALAR float
#define SUF f32
#define LL_SIMD 1
#define LL_VEC ll_f32x4
#define LL_SPLAT(v) ((ll_f32x4){(v), (v), (v), (v)})
#define LL_LOAD(p) (*(const ll_f32x4 *)(p))
#define LL_STORE(p, x) (*(ll_f32x4 *)(p) = (x))
#include "ops.h"
#undef SCALAR
#undef SUF
#undef LL_SIMD
#undef LL_VEC
#undef LL_SPLAT
#undef LL_LOAD
#undef LL_STORE

/* ------------------------------------------------------ f64：标量的那份 */

/*
 * 不上 SIMD：f64x2 只有 2 倍，而这条路径只在梯度检验里跑、模型极小
 * （原型里 d=32 / L=2 / T=16）。这里先要正确不要快。
 */
#define SCALAR double
#define SUF f64
#include "ops.h"
#undef SCALAR
#undef SUF

/* ------------------------------------------------------ 杂项 */

/*
 * 版本号。JS 侧启动时核一下，防止「改了 .c 忘了重建产物」——
 * 那种情况下代码看着是新的、跑的是旧的，而且不报任何错。
 * 改算子的语义时把它 +1。
 */
int ll_abi_version(void) { return 3; }

/** 堆基址，JS 的分配器从这里往后排 */
int ll_heap_base(void) { return (int)(unsigned long)(&__heap_base); }
