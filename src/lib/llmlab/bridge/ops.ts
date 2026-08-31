/**
 * 算子调度与计量
 *
 * **这一层是全部门槛的取数点。** 学员的代码（现在是 TS 参考模型，
 * 之后是 Python 里的 nanotorch）只能通过这里碰到算子核，
 * 所以「做了多少次浮点运算」「用了多少显存」「有没有调不该调的东西」
 * 在这里全都是**精确**的，不是估的。
 *
 * 对应 gpulab 里 VM 记 DRAM 字节的那一层 —— 同一个位置，同一个作用：
 * 学员碰不到，也绕不过。
 *
 * ## FLOPs 怎么数
 *
 * 每个算子一条**写明的公式**，按乘加各算一次浮点运算（和 PyTorch profiler、
 * 以及 6ND 那个经验式的口径一致）。公式写在每个 case 旁边，
 * 因为「这个数是怎么来的」比这个数本身重要 —— 学员要拿它对着解析式核。
 *
 * 注意力那一条特别标出来：它是**因果**的，所以不是 2·B·H·S²·hd，
 * 而是按 Σ(i+1) 算。差一倍，而第 3 关的门槛正好卡在这个量级上。
 */
import type { Kernels } from '../kernels';
import { Arena, type DType, type Tensor } from './tensor';

export type OpName =
  | 'gemm_nn' | 'gemm_tn_acc' | 'gemm_nt'
  | 'add_inplace' | 'scale_inplace' | 'fill' | 'copy' | 'sumsq'
  | 'rmsnorm_fwd' | 'rmsnorm_bwd'
  | 'swiglu_fwd' | 'swiglu_bwd'
  | 'rope_fwd' | 'rope_bwd'
  | 'attn_fwd' | 'attn_bwd'
  | 'attn_scores_fwd' | 'attn_scores_bwd'
  | 'attn_apply_fwd' | 'attn_apply_bwd'
  | 'softmax_rows_fwd' | 'softmax_rows_bwd'
  | 'layernorm_fwd' | 'layernorm_bwd'
  | 'quantize_bf16' | 'quantize_fp16' | 'count_nonfinite'
  | 'cross_entropy' | 'cross_entropy_bwd'
  | 'embed_fwd' | 'embed_bwd'
  | 'mul' | 'row_scale' | 'row_scale_bwd_s'
  | 'adamw';

/** 一次调用记的账 */
export interface OpRecord {
  op: OpName;
  flops: number;
  /** 前向 / 反向 / 优化器 —— 门槛要分开读（比如「反向 ≤ 前向 × 2.2」） */
  phase: Phase;
}

export type Phase = 'forward' | 'backward' | 'optimizer' | 'generate' | 'other';

export interface OpCounters {
  calls: number;
  flops: number;
}

export class Meter {
  /** 当前处在哪个阶段。调用方用 `withPhase` 切 */
  phase: Phase = 'other';
  readonly byOp = new Map<OpName, OpCounters>();
  readonly byPhase = new Map<Phase, OpCounters>();
  /** 本关禁用的算子 —— 「自己实现」这件事在这里是精确可判的 */
  forbidden = new Set<OpName>();
  forbiddenCalls = 0;
  readonly forbiddenHits = new Map<OpName, number>();
  /** 这一次判定里出现过的 token 数，`flops.forwardPerToken` 的分母 */
  tokens = 0;

  record(op: OpName, flops: number): void {
    const o = this.byOp.get(op) ?? { calls: 0, flops: 0 };
    o.calls += 1; o.flops += flops;
    this.byOp.set(op, o);

    const p = this.byPhase.get(this.phase) ?? { calls: 0, flops: 0 };
    p.calls += 1; p.flops += flops;
    this.byPhase.set(this.phase, p);

    if (this.forbidden.has(op)) {
      this.forbiddenCalls += 1;
      this.forbiddenHits.set(op, (this.forbiddenHits.get(op) ?? 0) + 1);
    }
  }

  reset(): void {
    this.byOp.clear();
    this.byPhase.clear();
    this.forbiddenCalls = 0;
    this.forbiddenHits.clear();
    this.tokens = 0;
    this.phase = 'other';
  }
}

function expect(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

function sameDType(...ts: Tensor[]): DType {
  const d = ts[0].dtype;
  for (const t of ts) {
    if (t.dtype !== d) {
      throw new Error(
        `算子的输入 dtype 不一致：${ts.map((x) => `${x.name || `#${x.id}`}:${x.dtype}`).join(', ')}`
      );
    }
  }
  return d;
}

/**
 * 算子调度器。
 *
 * 每个方法做三件事：**核形状 → 记账 → 调 wasm**。
 * 形状核在前面是有意的：算子核里越界不会 trap（wasm 的线性内存没有保护页），
 * 只会安静地读到别的张量 —— 那种错误的表现是「loss 变成 NaN，但看不出为什么」。
 */
export class Ops {
  constructor(
    private readonly kernels: Kernels,
    private readonly arena: Arena,
    readonly meter: Meter
  ) {}

  /** 在某个阶段里跑一段，退出时恢复 —— 嵌套安全 */
  withPhase<T>(phase: Phase, run: () => T): T {
    const prev = this.meter.phase;
    this.meter.phase = phase;
    try {
      return run();
    } finally {
      this.meter.phase = prev;
    }
  }

  private call(op: OpName, flops: number, dtype: DType, run: (suffix: 'f32' | 'f64') => void): void {
    this.meter.record(op, flops);
    run(dtype);
  }

  /** C[M,N] = A[M,K] @ B[K,N]。FLOPs = 2·M·N·K（每个输出一次乘一次加，共 K 轮） */
  gemmNN(a: Tensor, b: Tensor, c: Tensor, M: number, N: number, K: number): void {
    const dt = sameDType(a, b, c);
    expect(a.count >= M * K, `gemm_nn 的 A 装不下 ${M}×${K}（只有 ${a.count}）`);
    expect(b.count >= K * N, `gemm_nn 的 B 装不下 ${K}×${N}（只有 ${b.count}）`);
    expect(c.count >= M * N, `gemm_nn 的 C 装不下 ${M}×${N}（只有 ${c.count}）`);
    this.call('gemm_nn', 2 * M * N * K, dt, (s) => {
      this.kernels.fn[`gemm_nn_${s}`](a.off, b.off, c.off, M, N, K);
    });
  }

  /** C[K,N] += A[M,K]^T @ B[M,N]。FLOPs 同 gemm_nn */
  gemmTNAcc(a: Tensor, b: Tensor, c: Tensor, M: number, N: number, K: number): void {
    const dt = sameDType(a, b, c);
    expect(a.count >= M * K, `gemm_tn_acc 的 A 装不下 ${M}×${K}`);
    expect(b.count >= M * N, `gemm_tn_acc 的 B 装不下 ${M}×${N}`);
    expect(c.count >= K * N, `gemm_tn_acc 的 C 装不下 ${K}×${N}`);
    this.call('gemm_tn_acc', 2 * M * N * K, dt, (s) => {
      this.kernels.fn[`gemm_tn_acc_${s}`](a.off, b.off, c.off, M, N, K);
    });
  }

  /** C[M,K] = A[M,N] @ B[K,N]^T。FLOPs = 2·M·K·N */
  gemmNT(a: Tensor, b: Tensor, c: Tensor, M: number, K: number, N: number): void {
    const dt = sameDType(a, b, c);
    expect(a.count >= M * N, `gemm_nt 的 A 装不下 ${M}×${N}`);
    expect(b.count >= K * N, `gemm_nt 的 B 装不下 ${K}×${N}`);
    expect(c.count >= M * K, `gemm_nt 的 C 装不下 ${M}×${K}`);
    this.call('gemm_nt', 2 * M * K * N, dt, (s) => {
      this.kernels.fn[`gemm_nt_${s}`](a.off, b.off, c.off, M, K, N);
    });
  }

  addInplace(a: Tensor, b: Tensor, n: number): void {
    const dt = sameDType(a, b);
    expect(a.count >= n && b.count >= n, 'add_inplace 的长度超出张量');
    this.call('add_inplace', n, dt, (s) => this.kernels.fn[`add_inplace_${s}`](a.off, b.off, n));
  }

  scaleInplace(a: Tensor, scale: number, n: number): void {
    expect(a.count >= n, 'scale_inplace 的长度超出张量');
    this.call('scale_inplace', n, a.dtype, (s) => this.kernels.fn[`scale_inplace_${s}`](a.off, scale, n));
  }

  fill(a: Tensor, value: number, n = a.count): void {
    expect(a.count >= n, 'fill 的长度超出张量');
    this.call('fill', 0, a.dtype, (s) => this.kernels.fn[`fill_${s}`](a.off, value, n));
  }

  copy(dst: Tensor, src: Tensor, n: number): void {
    const dt = sameDType(dst, src);
    expect(dst.count >= n && src.count >= n, 'copy 的长度超出张量');
    this.call('copy', 0, dt, (s) => this.kernels.fn[`copy_${s}`](dst.off, src.off, n));
  }

  /** Σ x²，梯度范数的原料。FLOPs = 2n */
  sumsq(a: Tensor, n = a.count): number {
    expect(a.count >= n, 'sumsq 的长度超出张量');
    this.meter.record('sumsq', 2 * n);
    return a.dtype === 'f32'
      ? this.kernels.fn.sumsq_f32(a.off, n)
      : this.kernels.fn.sumsq_f64(a.off, n);
  }

  /** FLOPs ≈ 4·rows·d：一遍平方和（2）+ 一遍缩放与乘增益（2） */
  rmsnormFwd(x: Tensor, g: Tensor, out: Tensor, inv: Tensor, rows: number, d: number, eps = 1e-5): void {
    const dt = sameDType(x, g, out, inv);
    expect(x.count >= rows * d, 'rmsnorm_fwd 的 x 装不下');
    expect(g.count >= d, 'rmsnorm_fwd 的增益长度不对');
    expect(out.count >= rows * d, 'rmsnorm_fwd 的 out 装不下');
    expect(inv.count >= rows, 'rmsnorm_fwd 的 inv 要每行一个');
    this.call('rmsnorm_fwd', 4 * rows * d, dt, (s) => {
      this.kernels.fn[`rmsnorm_fwd_${s}`](x.off, g.off, out.off, inv.off, rows, d, eps);
    });
  }

  /** FLOPs ≈ 8·rows·d：一遍点积（3）+ 一遍组合（5） */
  rmsnormBwd(
    dout: Tensor, x: Tensor, g: Tensor, inv: Tensor, dg: Tensor, dx: Tensor,
    rows: number, d: number
  ): void {
    const dt = sameDType(dout, x, g, inv, dg, dx);
    expect(dx.count >= rows * d, 'rmsnorm_bwd 的 dx 装不下');
    expect(dg.count >= d, 'rmsnorm_bwd 的 dg 长度不对');
    this.call('rmsnorm_bwd', 8 * rows * d, dt, (s) => {
      this.kernels.fn[`rmsnorm_bwd_${s}`](dout.off, x.off, g.off, inv.off, dg.off, dx.off, rows, d);
    });
  }

  /** FLOPs ≈ 5n（一次 exp 算 4 次浮点运算，是个约定，写在这里以免有人以为它精确） */
  swigluFwd(gate: Tensor, up: Tensor, out: Tensor, n: number): void {
    const dt = sameDType(gate, up, out);
    expect(gate.count >= n && up.count >= n && out.count >= n, 'swiglu_fwd 的长度不齐');
    this.call('swiglu_fwd', 5 * n, dt, (s) => this.kernels.fn[`swiglu_fwd_${s}`](gate.off, up.off, out.off, n));
  }

  swigluBwd(dout: Tensor, gate: Tensor, up: Tensor, dgate: Tensor, dup: Tensor, n: number): void {
    const dt = sameDType(dout, gate, up, dgate, dup);
    expect(dgate.count >= n && dup.count >= n, 'swiglu_bwd 的输出装不下');
    this.call('swiglu_bwd', 9 * n, dt, (s) => {
      this.kernels.fn[`swiglu_bwd_${s}`](dout.off, gate.off, up.off, dgate.off, dup.off, n);
    });
  }

  /** 就地旋转。FLOPs = 6·B·S·H·hd/2 —— 每对元素 4 乘 2 加 */
  ropeFwd(x: Tensor, cos: Tensor, sin: Tensor, B: number, S: number, H: number, hd: number): void {
    const dt = sameDType(x, cos, sin);
    expect(hd % 2 === 0, `RoPE 要求头维是偶数，拿到 ${hd}`);
    expect(x.count >= B * S * H * hd, 'rope_fwd 的 x 装不下');
    expect(cos.count >= S * (hd / 2) && sin.count >= S * (hd / 2), 'RoPE 的 cos/sin 表长度不对');
    this.call('rope_fwd', 3 * B * S * H * hd, dt, (s) => {
      this.kernels.fn[`rope_fwd_${s}`](x.off, cos.off, sin.off, B, S, H, hd);
    });
  }

  ropeBwd(dx: Tensor, cos: Tensor, sin: Tensor, B: number, S: number, H: number, hd: number): void {
    const dt = sameDType(dx, cos, sin);
    expect(dx.count >= B * S * H * hd, 'rope_bwd 的 dx 装不下');
    this.call('rope_bwd', 3 * B * S * H * hd, dt, (s) => {
      this.kernels.fn[`rope_bwd_${s}`](dx.off, cos.off, sin.off, B, S, H, hd);
    });
  }

  /**
   * 因果注意力。
   *
   * **FLOPs 是按因果算的**：每个查询位置 i 只看 i+1 个键，
   * 所以是 Σ_{i<S}(i+1) = S(S+1)/2 而不是 S²。
   * 分数与加权和各一次 gemm 量级，每次 2·hd 次浮点运算：
   *
   *   flops = 2 · (2·hd) · B·H·S(S+1)/2 = 2·B·H·hd·S(S+1)
   *
   * 写死成 S² 的话会高估一倍，而第 3 关的门槛正好卡在这个量级上 ——
   * 学员会发现自己「多算了一倍」，然后去找一个根本不存在的 bug。
   */
  attnFwd(
    q: Tensor, k: Tensor, v: Tensor, att: Tensor, out: Tensor,
    B: number, S: number, H: number, KV: number, hd: number
  ): void {
    const dt = sameDType(q, k, v, att, out);
    expect(H % KV === 0, `查询头数 ${H} 不能被键值头数 ${KV} 整除`);
    expect(q.count >= B * S * H * hd, 'attn_fwd 的 q 装不下');
    expect(k.count >= B * S * KV * hd, 'attn_fwd 的 k 装不下');
    expect(v.count >= B * S * KV * hd, 'attn_fwd 的 v 装不下');
    expect(att.count >= B * H * S * S, 'attn_fwd 的 att 装不下（它是 O(S²) 的那一块）');
    expect(out.count >= B * S * H * hd, 'attn_fwd 的 out 装不下');
    this.call('attn_fwd', 2 * B * H * hd * S * (S + 1), dt, (s) => {
      this.kernels.fn[`attn_fwd_${s}`](q.off, k.off, v.off, att.off, out.off, B, S, H, KV, hd);
    });
  }

  /** 反向约为前向的两倍 */
  attnBwd(
    dout: Tensor, q: Tensor, k: Tensor, v: Tensor, att: Tensor,
    dq: Tensor, dk: Tensor, dv: Tensor, dp: Tensor,
    B: number, S: number, H: number, KV: number, hd: number
  ): void {
    const dt = sameDType(dout, q, k, v, att, dq, dk, dv, dp);
    expect(dp.count >= S, 'attn_bwd 的 dp 暂存区至少要 S 个元素');
    expect(dq.count >= B * S * H * hd, 'attn_bwd 的 dq 装不下');
    expect(dk.count >= B * S * KV * hd && dv.count >= B * S * KV * hd, 'attn_bwd 的 dk/dv 装不下');
    this.call('attn_bwd', 4 * B * H * hd * S * (S + 1), dt, (s) => {
      this.kernels.fn[`attn_bwd_${s}`](
        dout.off, q.off, k.off, v.off, att.off, dq.off, dk.off, dv.off, dp.off, B, S, H, KV, hd
      );
    });
  }

  /* ---------------- 拆开的注意力：第 3 关起学员自己拼 ---------------- */

  /**
   * scores = scale · q·kᵀ。FLOPs = 2·B·H·Sq·Skv·hd。
   *
   * **这里没有因果的折扣**（不像 `attnFwd` 按 Σ(i+1) 算）：
   * 拆开之后分数矩阵是整块算的，掩码是下一步 softmax 的事。
   * 这个差别本身就是第 3 关的一个观察点 —— 拆开写比融合写多算了一半的分数，
   * 而 FlashAttention 之所以能省，一半原因就在它把掩码融进了计算里。
   */
  attnScores(
    q: Tensor, k: Tensor, out: Tensor,
    B: number, Sq: number, Skv: number, H: number, KV: number, hd: number, scale: number
  ): void {
    const dt = sameDType(q, k, out);
    expect(H % KV === 0, `查询头数 ${H} 不能被键值头数 ${KV} 整除`);
    expect(q.count >= B * Sq * H * hd, 'attn_scores 的 q 装不下');
    expect(k.count >= B * Skv * KV * hd, 'attn_scores 的 k 装不下');
    expect(out.count >= B * H * Sq * Skv, 'attn_scores 的 out 装不下');
    this.call('attn_scores_fwd', 2 * B * H * Sq * Skv * hd, dt, (s) => {
      this.kernels.fn[`attn_scores_fwd_${s}`](q.off, k.off, out.off, B, Sq, Skv, H, KV, hd, scale);
    });
  }

  attnScoresBwd(
    dout: Tensor, q: Tensor, k: Tensor, dq: Tensor, dk: Tensor,
    B: number, Sq: number, Skv: number, H: number, KV: number, hd: number, scale: number
  ): void {
    const dt = sameDType(dout, q, k, dq, dk);
    expect(dq.count >= B * Sq * H * hd && dk.count >= B * Skv * KV * hd, 'attn_scores_bwd 的输出装不下');
    this.call('attn_scores_bwd', 4 * B * H * Sq * Skv * hd, dt, (s) => {
      this.kernels.fn[`attn_scores_bwd_${s}`](dout.off, q.off, k.off, dq.off, dk.off, B, Sq, Skv, H, KV, hd, scale);
    });
  }

  /** out = p·v。FLOPs = 2·B·H·Sq·Skv·hd */
  attnApply(
    p: Tensor, v: Tensor, out: Tensor,
    B: number, Sq: number, Skv: number, H: number, KV: number, hd: number
  ): void {
    const dt = sameDType(p, v, out);
    expect(p.count >= B * H * Sq * Skv, 'attn_apply 的 p 装不下');
    expect(v.count >= B * Skv * KV * hd, 'attn_apply 的 v 装不下');
    expect(out.count >= B * Sq * H * hd, 'attn_apply 的 out 装不下');
    this.call('attn_apply_fwd', 2 * B * H * Sq * Skv * hd, dt, (s) => {
      this.kernels.fn[`attn_apply_fwd_${s}`](p.off, v.off, out.off, B, Sq, Skv, H, KV, hd);
    });
  }

  attnApplyBwd(
    dout: Tensor, p: Tensor, v: Tensor, dp: Tensor, dv: Tensor,
    B: number, Sq: number, Skv: number, H: number, KV: number, hd: number
  ): void {
    const dt = sameDType(dout, p, v, dp, dv);
    expect(dp.count >= B * H * Sq * Skv && dv.count >= B * Skv * KV * hd, 'attn_apply_bwd 的输出装不下');
    this.call('attn_apply_bwd', 4 * B * H * Sq * Skv * hd, dt, (s) => {
      this.kernels.fn[`attn_apply_bwd_${s}`](dout.off, p.off, v.off, dp.off, dv.off, B, Sq, Skv, H, KV, hd);
    });
  }

  /**
   * 逐行 softmax。`valid` 是每行的有效长度（i32），传 null 表示整行都算。
   *
   * 因果掩码在这里表现成 `valid[r] = i+1`，由调用方填 ——
   * 于是「因果」「滑窗」「文档边界」是同一套机制，算子不必分别认识它们。
   */
  softmaxRows(x: Tensor, valid: Tensor | null, out: Tensor, rows: number, cols: number): void {
    const dt = sameDType(x, out);
    expect(x.count >= rows * cols && out.count >= rows * cols, 'softmax_rows 的张量装不下');
    if (valid) expect(valid.count >= rows, 'softmax_rows 的 valid 要每行一个');
    this.call('softmax_rows_fwd', 5 * rows * cols, dt, (s) => {
      this.kernels.fn[`softmax_rows_fwd_${s}`](x.off, valid ? valid.off : -1, out.off, rows, cols);
    });
  }

  softmaxRowsBwd(
    dout: Tensor, out: Tensor, valid: Tensor | null, dx: Tensor, rows: number, cols: number
  ): void {
    const dt = sameDType(dout, out, dx);
    expect(dx.count >= rows * cols, 'softmax_rows_bwd 的 dx 装不下');
    this.call('softmax_rows_bwd', 4 * rows * cols, dt, (s) => {
      this.kernels.fn[`softmax_rows_bwd_${s}`](dout.off, out.off, valid ? valid.off : -1, dx.off, rows, cols);
    });
  }

  /* ---------------- LayerNorm：只为第 6 关的对照 ---------------- */

  layernormFwd(
    x: Tensor, g: Tensor, b: Tensor, out: Tensor, mean: Tensor, inv: Tensor,
    rows: number, d: number, eps = 1e-5
  ): void {
    const dt = sameDType(x, g, b, out, mean, inv);
    expect(g.count >= d && b.count >= d, 'layernorm 的增益与偏置长度不对');
    expect(mean.count >= rows && inv.count >= rows, 'layernorm 的 mean/inv 要每行一个');
    this.call('layernorm_fwd', 6 * rows * d, dt, (s) => {
      this.kernels.fn[`layernorm_fwd_${s}`](x.off, g.off, b.off, out.off, mean.off, inv.off, rows, d, eps);
    });
  }

  layernormBwd(
    dout: Tensor, x: Tensor, g: Tensor, mean: Tensor, inv: Tensor,
    dg: Tensor, db: Tensor, dx: Tensor, rows: number, d: number
  ): void {
    const dt = sameDType(dout, x, g, mean, inv, dg, db, dx);
    this.call('layernorm_bwd', 10 * rows * d, dt, (s) => {
      this.kernels.fn[`layernorm_bwd_${s}`](dout.off, x.off, g.off, mean.off, inv.off, dg.off, db.off, dx.off, rows, d);
    });
  }

  /* ---------------- 低精度模拟：第 17 关 ---------------- */

  /** 就地舍到 bf16 的可表示集合上。不算 FLOPs —— 它是舍入，不是运算 */
  quantizeBf16(x: Tensor, n = x.count): void {
    expect(x.count >= n, 'quantize_bf16 的长度超出张量');
    this.call('quantize_bf16', 0, x.dtype, (s) => this.kernels.fn[`quantize_bf16_${s}`](x.off, n));
  }

  /** 就地舍到 fp16。超过 65504 就是 inf */
  quantizeFp16(x: Tensor, n = x.count): void {
    expect(x.count >= n, 'quantize_fp16 的长度超出张量');
    this.call('quantize_fp16', 0, x.dtype, (s) => this.kernels.fn[`quantize_fp16_${s}`](x.off, n));
  }

  /** 有多少个 NaN / inf。第 14、17 关的门槛读它 */
  countNonFinite(x: Tensor, n = x.count): number {
    this.meter.record('count_nonfinite', 0);
    return x.dtype === 'f32'
      ? this.kernels.fn.count_nonfinite_f32(x.off, n)
      : this.kernels.fn.count_nonfinite_f64(x.off, n);
  }

  /** 返回**平均** loss。FLOPs ≈ 5·rows·vocab（一遍找最大、一遍 exp、一遍归一） */
  crossEntropy(logits: Tensor, targets: Tensor, probs: Tensor, rows: number, vocab: number): number {
    const dt = sameDType(logits, probs);
    expect(logits.count >= rows * vocab, 'cross_entropy 的 logits 装不下');
    expect(probs.count >= rows * vocab, 'cross_entropy 的 probs 装不下');
    expect(targets.count >= rows, 'cross_entropy 的 targets 要每行一个');
    this.checkTargets(targets, rows, vocab);
    this.meter.record('cross_entropy', 5 * rows * vocab);
    return dt === 'f32'
      ? this.kernels.fn.cross_entropy_f32(logits.off, targets.off, probs.off, rows, vocab)
      : this.kernels.fn.cross_entropy_f64(logits.off, targets.off, probs.off, rows, vocab);
  }

  crossEntropyBwd(
    probs: Tensor, targets: Tensor, mask: Tensor | null, dlogits: Tensor,
    rows: number, vocab: number, scale: number
  ): void {
    const dt = sameDType(probs, dlogits);
    expect(dlogits.count >= rows * vocab, 'cross_entropy_bwd 的 dlogits 装不下');
    this.checkTargets(targets, rows, vocab);
    this.call('cross_entropy_bwd', 2 * rows * vocab, dt, (s) => {
      this.kernels.fn[`cross_entropy_bwd_${s}`](
        probs.off, targets.off, mask ? mask.off : -1, dlogits.off, rows, vocab, scale
      );
    });
  }

  /**
   * token id 的边界检查。
   *
   * wasm 的线性内存没有保护页，越界不会 trap —— 一个越界的 token id
   * 会安静地读到别的张量，表现是「loss 忽然变成一个奇怪的数」。
   * 这一条比让它跑过去便宜得多。
   */
  private checkTargets(targets: Tensor, rows: number, vocab: number): void {
    const view = this.arena.i32(targets);
    for (let i = 0; i < rows; i++) {
      const id = view[i];
      if (id < 0 || id >= vocab) {
        throw new Error(`第 ${i} 个 token id 是 ${id}，越出了词表大小 ${vocab}`);
      }
    }
  }

  embedFwd(table: Tensor, idx: Tensor, out: Tensor, rows: number, d: number): void {
    const dt = sameDType(table, out);
    expect(out.count >= rows * d, 'embed_fwd 的 out 装不下');
    this.checkTargets(idx, rows, table.count / d);
    this.call('embed_fwd', 0, dt, (s) => {
      this.kernels.fn[`embed_fwd_${s}`](table.off, idx.off, out.off, rows, d);
    });
  }

  embedBwd(dout: Tensor, idx: Tensor, dtable: Tensor, rows: number, d: number): void {
    const dt = sameDType(dout, dtable);
    this.checkTargets(idx, rows, dtable.count / d);
    this.call('embed_bwd', rows * d, dt, (s) => {
      this.kernels.fn[`embed_bwd_${s}`](dout.off, idx.off, dtable.off, rows, d);
    });
  }

  /** FLOPs ≈ 11n（两个动量各 3、偏差修正 2、更新 3） */
  /** out = a ⊙ b。逐元素乘 —— MoE 的门控、GRPO 的 ratio×advantage 都是它 */
  mul(a: Tensor, b: Tensor, out: Tensor, n: number): void {
    const dt = sameDType(a, b, out);
    expect(a.count >= n && b.count >= n && out.count >= n, 'mul 的三块长度不齐');
    this.call('mul', n, dt, (s) => this.kernels.fn[`mul_${s}`](a.off, b.off, out.off, n));
  }

  /** out[r][c] = x[r][c] · s[r]。一行一个系数 —— 路由权重 / 样本掩码 / 优势加权 */
  rowScale(x: Tensor, s: Tensor, out: Tensor, rows: number, d: number): void {
    const dt = sameDType(x, s, out);
    expect(x.count >= rows * d && out.count >= rows * d, 'row_scale 的张量装不下');
    expect(s.count >= rows, 'row_scale 的系数要每行一个');
    this.call('row_scale', rows * d, dt, (suf) => {
      this.kernels.fn[`row_scale_${suf}`](x.off, s.off, out.off, rows, d);
    });
  }

  /** row_scale 对系数的反向：ds[r] += Σ_c x[r][c]·go[r][c] */
  rowScaleBwdS(go: Tensor, x: Tensor, ds: Tensor, rows: number, d: number): void {
    const dt = sameDType(go, x, ds);
    expect(ds.count >= rows, 'row_scale_bwd_s 的 ds 要每行一个');
    this.call('row_scale_bwd_s', 2 * rows * d, dt, (suf) => {
      this.kernels.fn[`row_scale_bwd_s_${suf}`](go.off, x.off, ds.off, rows, d);
    });
  }

  adamw(
    w: Tensor, g: Tensor, m: Tensor, v: Tensor, n: number,
    opts: { lr: number; beta1: number; beta2: number; eps: number; decay: number; step: number; clip: number }
  ): void {
    const dt = sameDType(w, g, m, v);
    expect(w.count >= n && g.count >= n && m.count >= n && v.count >= n, 'adamw 的四块长度不齐');
    const bc1 = 1 - Math.pow(opts.beta1, opts.step);
    const bc2 = 1 - Math.pow(opts.beta2, opts.step);
    this.call('adamw', 11 * n, dt, (s) => {
      this.kernels.fn[`adamw_${s}`](
        w.off, g.off, m.off, v.off, n,
        opts.lr, opts.beta1, opts.beta2, opts.eps, opts.decay, bc1, bc2, opts.clip
      );
    });
  }
}
