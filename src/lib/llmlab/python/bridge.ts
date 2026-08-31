/**
 * Python 与算子核之间那一层薄桥
 *
 * ## 边界怎么划的
 *
 * **数不过边界，只有 id 过。** Python 侧的 `Tensor` 拿到的是一个整数 id，
 * 真正的浮点数始终躺在 wasm 的线性内存里。跨语言搬一个 [256, 64] 的张量
 * 要几万次 PyProxy 转换；搬一个整数是 1.05 µs（实测）。
 *
 * 于是每一步训练大约 150 次调用 ⇒ 0.22 ms，相对一步 5.6 ms 是噪声。
 * 这条路能成立，全靠这个划法。
 *
 * **形状留在 Python 侧。** 桥上的方法都收显式的 M / N / K，
 * 因为形状是 `nanotorch` 算出来的。好处是学员写错形状时，
 * 报错带的是 Python 的调用栈 —— 而那才是他能看懂的地方。
 *
 * **计量在 JS 侧。** 每个方法都走 `Ops`，所以 FLOPs、显存峰值、
 * 禁用算子的调用次数一条都漏不掉，而且学员在 Python 里绕不过去。
 */
import type { Runtime } from '../bridge';
import type { DType, Tensor, TensorRole } from '../bridge';

/** 暴露给 Python 的那张表。方法名用蛇形，和 Python 那边读起来一致 */
export interface PythonBridge {
  /* ---- 张量的生命周期 ---- */
  alloc(count: number, dtype: DType, role: TensorRole, name: string): number;
  mark(): number;
  release(mark: number): void;
  /* ---- 小批量数据进出（大块永远不过边界）---- */
  set_i32(id: number, values: ArrayLike<number>): void;
  set_f(id: number, values: ArrayLike<number>): void;
  get_f(id: number, count: number): number[];
  item(id: number, index: number): number;
  fill(id: number, value: number): void;
  /** 用确定性 RNG 填正态分布 —— 初始化放在 JS 侧，Python 里逐元素写会慢 300 倍 */
  fill_normal(id: number, seed: number, std: number): void;
  /** RoPE 的 cos/sin 表，同理 */
  fill_rope(cosId: number, sinId: number, blockSize: number, headDim: number, base: number): void;
  /* ---- 算子 ---- */
  gemm_nn(a: number, b: number, c: number, M: number, N: number, K: number): void;
  gemm_tn_acc(a: number, b: number, c: number, M: number, N: number, K: number): void;
  gemm_nt(a: number, b: number, c: number, M: number, K: number, N: number): void;
  add_inplace(a: number, b: number, n: number): void;
  scale_inplace(a: number, s: number, n: number): void;
  copy(dst: number, src: number, n: number): void;
  sumsq(a: number, n: number): number;
  rmsnorm_fwd(x: number, g: number, out: number, inv: number, rows: number, d: number, eps: number): void;
  rmsnorm_bwd(dout: number, x: number, g: number, inv: number, dg: number, dx: number, rows: number, d: number): void;
  swiglu_fwd(gate: number, up: number, out: number, n: number): void;
  swiglu_bwd(dout: number, gate: number, up: number, dgate: number, dup: number, n: number): void;
  rope_fwd(x: number, cos: number, sin: number, B: number, S: number, H: number, hd: number): void;
  rope_bwd(dx: number, cos: number, sin: number, B: number, S: number, H: number, hd: number): void;
  attn_fwd(q: number, k: number, v: number, att: number, out: number, B: number, S: number, H: number, KV: number, hd: number): void;
  attn_bwd(dout: number, q: number, k: number, v: number, att: number, dq: number, dk: number, dv: number, dp: number, B: number, S: number, H: number, KV: number, hd: number): void;
  cross_entropy(logits: number, targets: number, probs: number, rows: number, vocab: number): number;
  cross_entropy_bwd(probs: number, targets: number, mask: number, dlogits: number, rows: number, vocab: number, scale: number): void;
  embed_fwd(table: number, idx: number, out: number, rows: number, d: number): void;
  embed_bwd(dout: number, idx: number, dtable: number, rows: number, d: number): void;
  adamw(w: number, g: number, m: number, v: number, n: number, lr: number, b1: number, b2: number, eps: number, decay: number, step: number, clip: number): void;
  attn_scores(q: number, k: number, out: number, B: number, Sq: number, Skv: number, H: number, KV: number, hd: number, scale: number): void;
  attn_scores_bwd(dout: number, q: number, k: number, dq: number, dk: number, B: number, Sq: number, Skv: number, H: number, KV: number, hd: number, scale: number): void;
  attn_apply(p: number, v: number, out: number, B: number, Sq: number, Skv: number, H: number, KV: number, hd: number): void;
  attn_apply_bwd(dout: number, p: number, v: number, dp: number, dv: number, B: number, Sq: number, Skv: number, H: number, KV: number, hd: number): void;
  softmax_rows(x: number, valid: number, out: number, rows: number, cols: number): void;
  softmax_rows_bwd(dout: number, out: number, valid: number, dx: number, rows: number, cols: number): void;
  layernorm_fwd(x: number, g: number, b: number, out: number, mean: number, inv: number, rows: number, d: number, eps: number): void;
  layernorm_bwd(dout: number, x: number, g: number, mean: number, inv: number, dg: number, db: number, dx: number, rows: number, d: number): void;
  quantize_bf16(x: number, n: number): void;
  quantize_fp16(x: number, n: number): void;
  count_nonfinite(x: number, n: number): number;
  /** 填因果掩码的每行有效长度：第 r 行（查询位置 i）能看到 offset+i+1 个键 */
  fill_causal_valid(valid: number, B: number, H: number, Sq: number, offset: number): void;
  /** 从一行 logits 采样一个 token。确定性：种子与步数决定结果 */
  sample_token(logits: number, row: number, vocab: number, temperature: number, topK: number, topP: number, seed: number): number;
  argmax_row(logits: number, row: number, vocab: number): number;
  /** 把 src 的一段拷进 dst 的某个偏移处 —— KV cache 的追加就是它 */
  copy_at(dst: number, dstOff: number, src: number, srcOff: number, n: number): void;
  /* ---- 阶段标记：门槛要分开读前向 / 反向 / 优化器的 FLOPs ---- */
  phase(name: string): void;
  add_tokens(n: number): void;
}

/**
 * 把种子先打散。
 *
 * **这一步不是可选的。** xorshift32 只有一条周期，相邻的整数种子落在这条周期上的
 * 位置是相关的 —— 于是 `seed=1, 2, 3` 初始化出来的几个权重矩阵会彼此相关。
 *
 * 这是实测出来的，不是理论担心：竖切第一版给同一个 block 的
 * wq/wk/wv/wo 发了 `seed+1..+4`，400 步之后 loss 停在 **2.25**；
 * 把种子拉开之后同样 400 步是 **1.44**，800 步 1.23（和 TS 参考实现一致）。
 * 也就是说相关的初始化把这个模型的学习速度砍掉了一大半。
 *
 * 而「给每个张量发一个相邻的整数种子」正是任何人都会写的东西 ——
 * 学员一定会写 `seed=1, seed=2`。所以这是**我们 API 的坑，不是他的错**，
 * 要在这里堵掉。splitmix32 的 finalizer，一次乘加两次异或移位。
 */
function mixSeed(seed: number): number {
  let z = (seed + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return ((z ^ (z >>> 15)) >>> 0) || 1;
}

/** 确定性正态分布：打散过的种子 + xorshift32 + Box-Muller */
function normalFiller(seed: number) {
  let s = mixSeed(seed);
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  return () => {
    let u = 0, v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export function createPythonBridge(rt: Runtime): PythonBridge {
  const { arena, ops, meter } = rt;
  const T = (id: number): Tensor => arena.get(id);

  return {
    alloc(count, dtype, role, name) {
      return arena.zeros([count], dtype, role, name).id;
    },
    mark: () => arena.mark(),
    release: (m) => arena.release(m),

    set_i32(id, values) {
      const view = arena.i32(T(id));
      for (let i = 0; i < values.length; i++) view[i] = values[i];
    },
    set_f(id, values) {
      const view = arena.view(T(id));
      for (let i = 0; i < values.length; i++) view[i] = values[i];
    },
    get_f(id, count) {
      const view = arena.view(T(id));
      const out = new Array<number>(count);
      for (let i = 0; i < count; i++) out[i] = view[i];
      return out;
    },
    item: (id, index) => arena.view(T(id))[index],
    fill: (id, value) => ops.fill(T(id), value),

    fill_normal(id, seed, std) {
      const t = T(id);
      const view = arena.view(t);
      const gen = normalFiller(seed);
      for (let i = 0; i < t.count; i++) view[i] = gen() * std;
    },
    fill_rope(cosId, sinId, blockSize, headDim, base) {
      const half = headDim / 2;
      const cos = arena.view(T(cosId));
      const sin = arena.view(T(sinId));
      for (let pos = 0; pos < blockSize; pos++) {
        for (let i = 0; i < half; i++) {
          const theta = pos / Math.pow(base, (2 * i) / headDim);
          cos[pos * half + i] = Math.cos(theta);
          sin[pos * half + i] = Math.sin(theta);
        }
      }
    },

    gemm_nn: (a, b, c, M, N, K) => ops.gemmNN(T(a), T(b), T(c), M, N, K),
    gemm_tn_acc: (a, b, c, M, N, K) => ops.gemmTNAcc(T(a), T(b), T(c), M, N, K),
    gemm_nt: (a, b, c, M, K, N) => ops.gemmNT(T(a), T(b), T(c), M, K, N),
    add_inplace: (a, b, n) => ops.addInplace(T(a), T(b), n),
    scale_inplace: (a, s, n) => ops.scaleInplace(T(a), s, n),
    copy: (dst, src, n) => ops.copy(T(dst), T(src), n),
    sumsq: (a, n) => ops.sumsq(T(a), n),
    rmsnorm_fwd: (x, g, out, inv, rows, d, eps) =>
      ops.rmsnormFwd(T(x), T(g), T(out), T(inv), rows, d, eps),
    rmsnorm_bwd: (dout, x, g, inv, dg, dx, rows, d) =>
      ops.rmsnormBwd(T(dout), T(x), T(g), T(inv), T(dg), T(dx), rows, d),
    swiglu_fwd: (gate, up, out, n) => ops.swigluFwd(T(gate), T(up), T(out), n),
    swiglu_bwd: (dout, gate, up, dgate, dup, n) =>
      ops.swigluBwd(T(dout), T(gate), T(up), T(dgate), T(dup), n),
    rope_fwd: (x, cos, sin, B, S, H, hd) => ops.ropeFwd(T(x), T(cos), T(sin), B, S, H, hd),
    rope_bwd: (dx, cos, sin, B, S, H, hd) => ops.ropeBwd(T(dx), T(cos), T(sin), B, S, H, hd),
    attn_fwd: (q, k, v, att, out, B, S, H, KV, hd) =>
      ops.attnFwd(T(q), T(k), T(v), T(att), T(out), B, S, H, KV, hd),
    attn_bwd: (dout, q, k, v, att, dq, dk, dv, dp, B, S, H, KV, hd) =>
      ops.attnBwd(T(dout), T(q), T(k), T(v), T(att), T(dq), T(dk), T(dv), T(dp), B, S, H, KV, hd),
    cross_entropy: (logits, targets, probs, rows, vocab) =>
      ops.crossEntropy(T(logits), T(targets), T(probs), rows, vocab),
    cross_entropy_bwd: (probs, targets, mask, dlogits, rows, vocab, scale) =>
      ops.crossEntropyBwd(T(probs), T(targets), mask >= 0 ? T(mask) : null, T(dlogits), rows, vocab, scale),
    embed_fwd: (table, idx, out, rows, d) => ops.embedFwd(T(table), T(idx), T(out), rows, d),
    embed_bwd: (dout, idx, dtable, rows, d) => ops.embedBwd(T(dout), T(idx), T(dtable), rows, d),
    adamw: (w, g, m, v, n, lr, b1, b2, eps, decay, step, clip) =>
      ops.adamw(T(w), T(g), T(m), T(v), n, {
        lr, beta1: b1, beta2: b2, eps, decay, step, clip,
      }),

    attn_scores: (q, k, out, B, Sq, Skv, H, KV, hd, scale) =>
      ops.attnScores(T(q), T(k), T(out), B, Sq, Skv, H, KV, hd, scale),
    attn_scores_bwd: (dout, q, k, dq, dk, B, Sq, Skv, H, KV, hd, scale) =>
      ops.attnScoresBwd(T(dout), T(q), T(k), T(dq), T(dk), B, Sq, Skv, H, KV, hd, scale),
    attn_apply: (p, v, out, B, Sq, Skv, H, KV, hd) =>
      ops.attnApply(T(p), T(v), T(out), B, Sq, Skv, H, KV, hd),
    attn_apply_bwd: (dout, p, v, dp, dv, B, Sq, Skv, H, KV, hd) =>
      ops.attnApplyBwd(T(dout), T(p), T(v), T(dp), T(dv), B, Sq, Skv, H, KV, hd),
    softmax_rows: (x, valid, out, rows, cols) =>
      ops.softmaxRows(T(x), valid >= 0 ? T(valid) : null, T(out), rows, cols),
    softmax_rows_bwd: (dout, out, valid, dx, rows, cols) =>
      ops.softmaxRowsBwd(T(dout), T(out), valid >= 0 ? T(valid) : null, T(dx), rows, cols),
    layernorm_fwd: (x, g, b, out, mean, inv, rows, d, eps) =>
      ops.layernormFwd(T(x), T(g), T(b), T(out), T(mean), T(inv), rows, d, eps),
    layernorm_bwd: (dout, x, g, mean, inv, dg, db, dx, rows, d) =>
      ops.layernormBwd(T(dout), T(x), T(g), T(mean), T(inv), T(dg), T(db), T(dx), rows, d),
    quantize_bf16: (x, n) => ops.quantizeBf16(T(x), n),
    quantize_fp16: (x, n) => ops.quantizeFp16(T(x), n),
    count_nonfinite: (x, n) => ops.countNonFinite(T(x), n),

    /*
     * 因果掩码写成「每行的有效长度」。
     *
     * valid[(b*H+h)*Sq + i] = offset + i + 1
     *
     * `offset` 给 KV cache 用：解码到第 t 步时 Sq=1、offset=t，
     * 于是那一行能看到 t+1 个键。**训练与解码共用同一套掩码逻辑**，
     * 而「解码时掩码算错一格」正是真实推理引擎里最经典的一类 bug。
     */
    fill_causal_valid(valid, B, H, Sq, offset) {
      const view = arena.i32(T(valid));
      for (let b = 0; b < B; b++)
        for (let h = 0; h < H; h++)
          for (let i = 0; i < Sq; i++) view[(b * H + h) * Sq + i] = offset + i + 1;
    },

    /*
     * 采样。
     *
     * 放在 JS 侧而不是 wasm 里：它要排序（top-p），而这不是热点 ——
     * 一个 token 一次，vocab 量级几百到几千。而且这里只用比较与我们自己的
     * PRNG，不碰任何超越函数，所以确定性不受影响。
     *
     * temperature=0 等价于贪心。top-k 与 top-p 可以叠加，顺序是先 k 后 p，
     * 和 HuggingFace 的 `LogitsProcessor` 链一致。
     */
    sample_token(logits, row, vocab, temperature, topK, topP, seed) {
      const view = arena.view(T(logits));
      const base = row * vocab;
      if (temperature <= 0) {
        let best = 0;
        for (let j = 1; j < vocab; j++) if (view[base + j] > view[base + best]) best = j;
        return best;
      }
      const items: Array<{ id: number; p: number }> = [];
      let mx = -Infinity;
      for (let j = 0; j < vocab; j++) {
        const z = view[base + j] / temperature;
        if (z > mx) mx = z;
      }
      let sum = 0;
      for (let j = 0; j < vocab; j++) {
        const e = Math.exp(view[base + j] / temperature - mx);
        items.push({ id: j, p: e });
        sum += e;
      }
      for (const it of items) it.p /= sum;
      // 概率相同的按 id 排，保证顺序确定 —— 否则同一份输入两次可能采不同的词
      items.sort((a, b) => (b.p - a.p) || (a.id - b.id));

      let pool = topK > 0 ? items.slice(0, topK) : items;
      if (topP > 0 && topP < 1) {
        const kept: typeof pool = [];
        let acc = 0;
        for (const it of pool) {
          kept.push(it);
          acc += it.p;
          if (acc >= topP) break;   // 至少留一个，所以先 push 再判
        }
        pool = kept;
      }
      let total = 0;
      for (const it of pool) total += it.p;

      // xorshift32，和初始化那边同一套；种子先打散
      let st = ((seed + 0x9e3779b9) >>> 0) || 1;
      st = Math.imul(st ^ (st >>> 16), 0x21f0aaad) >>> 0;
      st = Math.imul(st ^ (st >>> 15), 0x735a2d97) >>> 0;
      st = ((st ^ (st >>> 15)) >>> 0) || 1;
      st ^= st << 13; st >>>= 0;
      st ^= st >>> 17;
      st ^= st << 5; st >>>= 0;
      let r = (st / 4294967296) * total;

      for (const it of pool) {
        r -= it.p;
        if (r <= 0) return it.id;
      }
      return pool[pool.length - 1].id;
    },

    copy_at(dst, dstOff, src, srcOff, n) {
      const dt = T(dst), st = T(src);
      if (dstOff + n > dt.count) {
        throw new Error(
          `copy_at 写越界：往「${dt.name || dt.id}」的 ${dstOff} 处写 ${n} 个，` +
          `但它只有 ${dt.count} 个`
        );
      }
      if (srcOff + n > st.count) {
        throw new Error(
          `copy_at 读越界：从「${st.name || st.id}」的 ${srcOff} 处读 ${n} 个，` +
          `但它只有 ${st.count} 个`
        );
      }
      const d = arena.view(dt);
      const v = arena.view(st);
      for (let i = 0; i < n; i++) d[dstOff + i] = v[srcOff + i];
    },

    argmax_row(logits, row, vocab) {
      const view = arena.view(T(logits));
      const base = row * vocab;
      let best = 0;
      for (let j = 1; j < vocab; j++) if (view[base + j] > view[base + best]) best = j;
      return best;
    },

    /*
     * 阶段标记。Python 侧在前向/反向/优化器的入口各调一次，
     * 于是 `llm.flops.backwardOverForward` 这类门槛才分得开。
     *
     * 不用 `withPhase` 的闭包形式：跨语言传回调要付 PyProxy 的代价，
     * 而这里本来就是线性的三段。
     */
    phase(name) {
      meter.phase = name as typeof meter.phase;
    },
    add_tokens(n) {
      meter.tokens += n;
    },
  };
}
