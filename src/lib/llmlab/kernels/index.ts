/**
 * 算子核的加载与内存管理。
 *
 * 这一层只做三件事：把 wasm 实例化、管一块线性内存、把偏移换成 TypedArray 视图。
 * **张量、形状、dtype、以及全部计量都在上一层**（JS 桥，下一片）——
 * 这里不认识「张量」，只认识一段数。
 *
 * ## 两个必须守住的规矩
 *
 * **1. 不 import 任何 Node 内置模块。** 这个文件要在浏览器、Electron 渲染进程
 * 和 jest 里跑同一份。所以字节从外面传进来（`createKernels(bytes)`），
 * 怎么拿到字节是调用方的事：浏览器 `fetch`，测试 `fs.readFileSync`。
 *
 * **2. 每次都重新建视图。** `memory.grow()` 会让已有的 TypedArray **detach**，
 * 之后再读就是空的 —— 而且不报错，只是所有数变成 0。所以 `f32()` / `f64()`
 * 这些访问器每次都 `new` 一个视图，绝不缓存。
 */

/** wasm 导出的算子。参数全是相对堆基址的**字节**偏移 */
export interface KernelExports {
  memory: WebAssembly.Memory;
  ll_abi_version(): number;
  ll_heap_base(): number;

  gemm_nn_f32(a: number, b: number, c: number, M: number, N: number, K: number): void;
  gemm_tn_acc_f32(a: number, b: number, c: number, M: number, N: number, K: number): void;
  gemm_nt_f32(a: number, b: number, c: number, M: number, K: number, N: number): void;
  add_inplace_f32(a: number, b: number, n: number): void;
  scale_inplace_f32(a: number, s: number, n: number): void;
  fill_f32(a: number, v: number, n: number): void;
  copy_f32(dst: number, src: number, n: number): void;
  sumsq_f32(a: number, n: number): number;
  rmsnorm_fwd_f32(x: number, g: number, out: number, inv: number, rows: number, d: number, eps: number): void;
  rmsnorm_bwd_f32(dout: number, x: number, g: number, inv: number, dg: number, dx: number, rows: number, d: number): void;
  swiglu_fwd_f32(gate: number, up: number, out: number, n: number): void;
  swiglu_bwd_f32(dout: number, gate: number, up: number, dgate: number, dup: number, n: number): void;
  rope_fwd_f32(x: number, cos: number, sin: number, B: number, S: number, H: number, hd: number): void;
  rope_bwd_f32(dx: number, cos: number, sin: number, B: number, S: number, H: number, hd: number): void;
  attn_fwd_f32(q: number, k: number, v: number, att: number, out: number, B: number, S: number, H: number, KV: number, hd: number): void;
  attn_bwd_f32(dout: number, q: number, k: number, v: number, att: number, dq: number, dk: number, dv: number, dp: number, B: number, S: number, H: number, KV: number, hd: number): void;
  cross_entropy_f32(logits: number, targets: number, probs: number, rows: number, vocab: number): number;
  cross_entropy_bwd_f32(probs: number, targets: number, mask: number, dlogits: number, rows: number, vocab: number, scale: number): void;
  embed_fwd_f32(table: number, idx: number, out: number, rows: number, d: number): void;
  mul_f32(a: number, b: number, out: number, n: number): void;
  exp_fwd_f32(x: number, out: number, n: number): void;
  exp_bwd_f32(go: number, out: number, dx: number, n: number): void;
  row_scale_f32(x: number, s: number, out: number, rows: number, d: number): void;
  row_scale_bwd_s_f32(go: number, x: number, ds: number, rows: number, d: number): void;
  embed_bwd_f32(dout: number, idx: number, dtable: number, rows: number, d: number): void;
  adamw_f32(w: number, g: number, m: number, v: number, n: number, lr: number, b1: number, b2: number, eps: number, decay: number, bc1: number, bc2: number, clip: number): void;
  attn_scores_fwd_f32(q: number, k: number, out: number, B: number, Sq: number, Skv: number, H: number, KV: number, hd: number, scale: number): void;
  attn_scores_bwd_f32(dout: number, q: number, k: number, dq: number, dk: number, B: number, Sq: number, Skv: number, H: number, KV: number, hd: number, scale: number): void;
  attn_apply_fwd_f32(p: number, v: number, out: number, B: number, Sq: number, Skv: number, H: number, KV: number, hd: number): void;
  attn_apply_bwd_f32(dout: number, p: number, v: number, dp: number, dv: number, B: number, Sq: number, Skv: number, H: number, KV: number, hd: number): void;
  softmax_rows_fwd_f32(x: number, valid: number, out: number, rows: number, cols: number): void;
  log_softmax_fwd_f32(x: number, valid: number, out: number, rows: number, cols: number): void;
  log_softmax_bwd_f32(dout: number, out: number, valid: number, dx: number, rows: number, cols: number): void;
  softmax_rows_bwd_f32(dout: number, out: number, valid: number, dx: number, rows: number, cols: number): void;
  layernorm_fwd_f32(x: number, g: number, b: number, out: number, mean: number, inv: number, rows: number, d: number, eps: number): void;
  layernorm_bwd_f32(dout: number, x: number, g: number, mean: number, inv: number, dg: number, db: number, dx: number, rows: number, d: number): void;
  quantize_bf16_f32(x: number, n: number): void;
  quantize_fp16_f32(x: number, n: number): void;
  count_nonfinite_f32(x: number, n: number): number;

  /* f64 是同一套算法的双精度实例化，梯度检验走它 —— 理由见 ops.h 开头 */
  gemm_nn_f64(a: number, b: number, c: number, M: number, N: number, K: number): void;
  gemm_tn_acc_f64(a: number, b: number, c: number, M: number, N: number, K: number): void;
  gemm_nt_f64(a: number, b: number, c: number, M: number, K: number, N: number): void;
  add_inplace_f64(a: number, b: number, n: number): void;
  scale_inplace_f64(a: number, s: number, n: number): void;
  fill_f64(a: number, v: number, n: number): void;
  copy_f64(dst: number, src: number, n: number): void;
  sumsq_f64(a: number, n: number): number;
  rmsnorm_fwd_f64(x: number, g: number, out: number, inv: number, rows: number, d: number, eps: number): void;
  rmsnorm_bwd_f64(dout: number, x: number, g: number, inv: number, dg: number, dx: number, rows: number, d: number): void;
  swiglu_fwd_f64(gate: number, up: number, out: number, n: number): void;
  swiglu_bwd_f64(dout: number, gate: number, up: number, dgate: number, dup: number, n: number): void;
  rope_fwd_f64(x: number, cos: number, sin: number, B: number, S: number, H: number, hd: number): void;
  rope_bwd_f64(dx: number, cos: number, sin: number, B: number, S: number, H: number, hd: number): void;
  attn_fwd_f64(q: number, k: number, v: number, att: number, out: number, B: number, S: number, H: number, KV: number, hd: number): void;
  attn_bwd_f64(dout: number, q: number, k: number, v: number, att: number, dq: number, dk: number, dv: number, dp: number, B: number, S: number, H: number, KV: number, hd: number): void;
  cross_entropy_f64(logits: number, targets: number, probs: number, rows: number, vocab: number): number;
  cross_entropy_bwd_f64(probs: number, targets: number, mask: number, dlogits: number, rows: number, vocab: number, scale: number): void;
  embed_fwd_f64(table: number, idx: number, out: number, rows: number, d: number): void;
  mul_f64(a: number, b: number, out: number, n: number): void;
  exp_fwd_f64(x: number, out: number, n: number): void;
  exp_bwd_f64(go: number, out: number, dx: number, n: number): void;
  row_scale_f64(x: number, s: number, out: number, rows: number, d: number): void;
  row_scale_bwd_s_f64(go: number, x: number, ds: number, rows: number, d: number): void;
  embed_bwd_f64(dout: number, idx: number, dtable: number, rows: number, d: number): void;
  adamw_f64(w: number, g: number, m: number, v: number, n: number, lr: number, b1: number, b2: number, eps: number, decay: number, bc1: number, bc2: number, clip: number): void;
  attn_scores_fwd_f64(q: number, k: number, out: number, B: number, Sq: number, Skv: number, H: number, KV: number, hd: number, scale: number): void;
  attn_scores_bwd_f64(dout: number, q: number, k: number, dq: number, dk: number, B: number, Sq: number, Skv: number, H: number, KV: number, hd: number, scale: number): void;
  attn_apply_fwd_f64(p: number, v: number, out: number, B: number, Sq: number, Skv: number, H: number, KV: number, hd: number): void;
  attn_apply_bwd_f64(dout: number, p: number, v: number, dp: number, dv: number, B: number, Sq: number, Skv: number, H: number, KV: number, hd: number): void;
  softmax_rows_fwd_f64(x: number, valid: number, out: number, rows: number, cols: number): void;
  log_softmax_fwd_f64(x: number, valid: number, out: number, rows: number, cols: number): void;
  log_softmax_bwd_f64(dout: number, out: number, valid: number, dx: number, rows: number, cols: number): void;
  softmax_rows_bwd_f64(dout: number, out: number, valid: number, dx: number, rows: number, cols: number): void;
  layernorm_fwd_f64(x: number, g: number, b: number, out: number, mean: number, inv: number, rows: number, d: number, eps: number): void;
  layernorm_bwd_f64(dout: number, x: number, g: number, mean: number, inv: number, dg: number, db: number, dx: number, rows: number, d: number): void;
  quantize_bf16_f64(x: number, n: number): void;
  quantize_fp16_f64(x: number, n: number): void;
  count_nonfinite_f64(x: number, n: number): number;
}

/** 这一版算子的 ABI。改了算子语义就在 kernels.c 里 +1，两边对不上要立刻炸 */
export const KERNEL_ABI_VERSION = 5;

const PAGE = 65536;

export interface Kernels {
  readonly fn: KernelExports;
  /** 分配 n 个字节，返回相对堆基址的偏移。按 16 字节对齐 */
  alloc(bytes: number): number;
  /** 把分配指针拨回去（不清内容）。一次判定跑完重置一次 */
  reset(mark?: number): void;
  /** 当前的分配位置，配合 reset 做作用域式分配 */
  mark(): number;
  /** 已经用掉多少字节 —— `llm.memory.*` 那几条门槛的原料 */
  used(): number;
  f32(off: number, len: number): Float32Array;
  f64(off: number, len: number): Float64Array;
  i32(off: number, len: number): Int32Array;
}

/**
 * 同步建一个算子核实例。
 *
 * ⚠️ **浏览器主线程上用不了这个。** Chrome 禁止在主线程同步编译大于 4KB 的
 * wasm buffer（`new WebAssembly.Module` 直接抛），而我们的产物是 37KB。
 * Node 与 Web Worker 没有这条限制，所以：
 *
 * - 测试、判定（跑在 Worker 里）、Electron 主进程 → 用这个
 * - 浏览器主线程 → 用 {@link createKernelsAsync} 或 {@link loadKernelsFromUrl}
 *
 * 这条限制在 jest 里**永远照不到**（Node 不管），所以写在这儿而不是等它在
 * 浏览器上炸 —— opslab 那四个「只有在浏览器里跑才会暴露」的问题就是这么来的。
 */
export function createKernels(bytes: BufferSource): Kernels {
  return fromModule(new WebAssembly.Module(bytes));
}

/** 异步建一个算子核实例。浏览器主线程走这条 */
export async function createKernelsAsync(bytes: BufferSource): Promise<Kernels> {
  return fromModule(await WebAssembly.compile(bytes));
}

function fromModule(module: WebAssembly.Module): Kernels {
  /*
   * 零 import 是硬要求，不是巧合 —— kernels.c 特意用 wasm32-unknown-unknown
   * 而不是 wasip1 编。这里核一下：哪天有人不小心引进 libc，
   * 报错要说清是什么，而不是抛一个「LinkError: import not found」。
   */
  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) {
    const names = imports.map((item) => `${item.module}.${item.name}`).join(', ');
    throw new Error(`算子核不该有任何 import，实际有：${names}`);
  }

  const instance = new WebAssembly.Instance(module, {});
  const fn = instance.exports as unknown as KernelExports;

  if (fn.ll_abi_version() !== KERNEL_ABI_VERSION) {
    throw new Error(
      `算子核 ABI 对不上：产物是 ${fn.ll_abi_version()}，代码要 ${KERNEL_ABI_VERSION}。` +
      '八成是改了 kernels.c 没重建 —— 跑 bash scripts/build-llmlab-kernels.sh'
    );
  }

  const memory = fn.memory;
  /*
   * 往上取整到 16。
   *
   * `Float64Array(buffer, byteOffset, len)` 要求 byteOffset 是 8 的倍数，
   * 不是就抛 RangeError。链接器给的 `__heap_base` 现在恰好是 16 对齐的
   * （1048576，正好是栈的大小，因为 --stack-first 且没有静态数据），
   * **但那是巧合** —— 哪天 kernels.c 里多一个静态数组，它就可能变成 4 的倍数，
   * 于是每一次建 f64 视图都抛。这一行让它不再依赖巧合。
   */
  const base = (fn.ll_heap_base() + 15) & ~15;
  let top = 0;

  const ensure = (needed: number) => {
    const want = base + needed;
    if (want <= memory.buffer.byteLength) return;
    const pages = Math.ceil((want - memory.buffer.byteLength) / PAGE);
    if (memory.grow(pages) < 0) throw new Error(`算子核内存涨不上去（要 ${want} 字节）`);
  };

  return {
    fn,
    alloc(bytes: number): number {
      const off = top;
      top = (top + bytes + 15) & ~15;
      ensure(top);
      return off;
    },
    reset(m = 0) { top = m; },
    mark() { return top; },
    used() { return top; },
    // 每次新建视图：grow 之后旧视图会 detach，读出来全是 0 且不报错
    f32(off, len) { return new Float32Array(memory.buffer, base + off, len); },
    f64(off, len) { return new Float64Array(memory.buffer, base + off, len); },
    i32(off, len) { return new Int32Array(memory.buffer, base + off, len); },
  };
}

/** 浏览器侧：从 URL 取字节。放在这里是为了让上层不必自己拼路径 */
export async function loadKernelsFromUrl(url = '/llmlab/llmlab-kernels.wasm'): Promise<Kernels> {
  /*
   * `cache: 'no-store'`：opslab 踩过的坑 —— 大响应写不进 HTTP 缓存时
   * Chrome 报 ERR_CACHE_WRITE_FAILURE，fetch 直接抛 Failed to fetch。
   * 我们这个只有 37KB 不至于，但没有理由为了缓存一个 37KB 的文件冒这个险。
   */
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`取算子核失败：${url} → HTTP ${response.status}`);
  // 走异步编译：主线程上同步编 37KB 的 buffer 会被 Chrome 直接拒掉
  return createKernelsAsync(await response.arrayBuffer());
}
