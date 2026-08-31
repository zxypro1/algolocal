/**
 * 第 3–8 关要用的那批算子：拆开的注意力、行 softmax、LayerNorm、低精度、采样
 *
 * 三条最要紧的用例：
 *
 * 1. **拆开写 == 融合写**。融合的 `attn_fwd` 已经验过一遍了，
 *    所以让拆开的三步去对它 —— 两条路算出同一个数，才说明第 3 关
 *    要学员拼的那套是对的。
 * 2. **带 KV cache 的解码 == 整段重算**，而且**逐位**相同。
 *    「差不多」在这里是不够的：解码用的必须是同一段代码同一套掩码，
 *    差一格就是差一格。
 * 3. **fp16 会溢出、bf16 不会**。第 17 关的对照组，这里先把位级模拟验对。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRuntime, type Runtime } from '../../src/lib/llmlab/bridge';
import type { Tensor } from '../../src/lib/llmlab/bridge';

const WASM = readFileSync(join(__dirname, '..', '..', 'public', 'llmlab', 'llmlab-kernels.wasm'));

let rt: Runtime;
beforeEach(() => { rt = createRuntime(WASM); });

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296 - 0.5;
  };
}

function filled(n: number, seed: number, dtype: 'f32' | 'f64' = 'f64'): Tensor {
  const t = rt.arena.zeros([n], dtype);
  const view = rt.arena.view(t);
  const r = rng(seed);
  for (let i = 0; i < n; i++) view[i] = r();
  return t;
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('拆开的注意力 == 融合的注意力', () => {
  const B = 2, S = 6, H = 4, KV = 2, hd = 8;

  function decomposed(q: Tensor, k: Tensor, v: Tensor) {
    const scores = rt.arena.zeros([B * H * S * S], 'f64');
    const probs = rt.arena.zeros([B * H * S * S], 'f64');
    const out = rt.arena.zeros([B * S * H * hd], 'f64');
    const valid = rt.arena.zeros([B * H * S], 'f32', 'data');
    // 因果：第 (b,h,i) 行能看到 i+1 个键
    const vv = rt.arena.i32(valid);
    for (let b = 0; b < B; b++)
      for (let h = 0; h < H; h++)
        for (let i = 0; i < S; i++) vv[(b * H + h) * S + i] = i + 1;

    rt.ops.attnScores(q, k, scores, B, S, S, H, KV, hd, 1 / Math.sqrt(hd));
    rt.ops.softmaxRows(scores, valid, probs, B * H * S, S);
    rt.ops.attnApply(probs, v, out, B, S, S, H, KV, hd);
    return { out, probs };
  }

  it('输出与概率矩阵都对得上（f64，容差 1e-13）', () => {
    const q = filled(B * S * H * hd, 1);
    const k = filled(B * S * KV * hd, 2);
    const v = filled(B * S * KV * hd, 3);

    const fusedAtt = rt.arena.zeros([B * H * S * S], 'f64');
    const fusedOut = rt.arena.zeros([B * S * H * hd], 'f64');
    rt.ops.attnFwd(q, k, v, fusedAtt, fusedOut, B, S, H, KV, hd);

    const { out, probs } = decomposed(q, k, v);
    expect(maxDiff(rt.arena.view(out), rt.arena.view(fusedOut))).toBeLessThan(1e-13);
    expect(maxDiff(rt.arena.view(probs), rt.arena.view(fusedAtt))).toBeLessThan(1e-13);
  });

  it('拆开写多算了一半的分数 —— 这正是融合能省的地方', () => {
    const q = filled(B * S * H * hd, 1);
    const k = filled(B * S * KV * hd, 2);
    const v = filled(B * S * KV * hd, 3);

    rt.meter.reset();
    decomposed(q, k, v);
    const split = rt.metrics().flops.total;

    rt.meter.reset();
    const att = rt.arena.zeros([B * H * S * S], 'f64');
    const out = rt.arena.zeros([B * S * H * hd], 'f64');
    rt.ops.attnFwd(q, k, v, att, out, B, S, H, KV, hd);
    const fused = rt.metrics().flops.total;

    // 融合按 Σ(i+1) 算，拆开按 S² 算 —— 比值大约是 2S/(S+1)
    console.log(`  拆开 ${(split / 1e3).toFixed(1)}k / 融合 ${(fused / 1e3).toFixed(1)}k FLOPs`);
    expect(split).toBeGreaterThan(fused * 1.4);
    expect(split).toBeLessThan(fused * 2.2);
  });

  it('softmax 掩掉的位置是硬 0，不是「很小的数」', () => {
    const q = filled(B * S * H * hd, 4);
    const k = filled(B * S * KV * hd, 5);
    const v = filled(B * S * KV * hd, 6);
    const { probs } = decomposed(q, k, v);
    const p = rt.arena.view(probs);
    for (let b = 0; b < B; b++)
      for (let h = 0; h < H; h++)
        for (let i = 0; i < S; i++) {
          for (let j = i + 1; j < S; j++) expect(p[((b * H + h) * S + i) * S + j]).toBe(0);
          let sum = 0;
          for (let j = 0; j <= i; j++) sum += p[((b * H + h) * S + i) * S + j];
          expect(sum).toBeCloseTo(1, 12);
        }
  });
});

describe('KV cache：解码 == 整段重算', () => {
  /*
   * **这条是第 8 关那条门槛的原型。**
   *
   * `attn_scores` / `attn_apply` 的 Sq 与 Skv 是分开的两个参数，
   * 所以解码（Sq=1、Skv=t+1）走的是**同一段代码**。
   * 「解码和训练走不走同一条路」正是真实推理引擎里最容易出错的地方 ——
   * 一旦分成两套，掩码差一格、RoPE 的位置偏一位，都要很久才发现。
   */
  const B = 1, S = 5, H = 2, KV = 1, hd = 4;

  it('逐位相同，不是「差不多」', () => {
    const q = filled(B * S * H * hd, 11);
    const k = filled(B * S * KV * hd, 12);
    const v = filled(B * S * KV * hd, 13);

    // 一次性整段算
    const scoresAll = rt.arena.zeros([B * H * S * S], 'f64');
    const probsAll = rt.arena.zeros([B * H * S * S], 'f64');
    const outAll = rt.arena.zeros([B * S * H * hd], 'f64');
    const validAll = rt.arena.zeros([B * H * S], 'f32', 'data');
    const va = rt.arena.i32(validAll);
    for (let h = 0; h < H; h++) for (let i = 0; i < S; i++) va[h * S + i] = i + 1;
    rt.ops.attnScores(q, k, scoresAll, B, S, S, H, KV, hd, 1 / Math.sqrt(hd));
    rt.ops.softmaxRows(scoresAll, validAll, probsAll, B * H * S, S);
    rt.ops.attnApply(probsAll, v, outAll, B, S, S, H, KV, hd);
    const full = Float64Array.from(rt.arena.view(outAll));

    // 逐步解码：每步 Sq=1，Skv=t+1
    const qv = rt.arena.view(q);
    for (let t = 0; t < S; t++) {
      const qStep = rt.arena.zeros([B * 1 * H * hd], 'f64');
      const qsv = rt.arena.view(qStep);
      for (let c = 0; c < H * hd; c++) qsv[c] = qv[t * H * hd + c];

      const scores = rt.arena.zeros([B * H * 1 * (t + 1)], 'f64');
      const probs = rt.arena.zeros([B * H * 1 * (t + 1)], 'f64');
      const out = rt.arena.zeros([B * 1 * H * hd], 'f64');
      const valid = rt.arena.zeros([B * H * 1], 'f32', 'data');
      const vv = rt.arena.i32(valid);
      for (let h = 0; h < H; h++) vv[h] = t + 1;   // 解码：offset=t，Sq=1

      rt.ops.attnScores(qStep, k, scores, B, 1, t + 1, H, KV, hd, 1 / Math.sqrt(hd));
      rt.ops.softmaxRows(scores, valid, probs, B * H * 1, t + 1);
      rt.ops.attnApply(probs, v, out, B, 1, t + 1, H, KV, hd);

      const step = rt.arena.view(out);
      for (let c = 0; c < H * hd; c++) {
        expect(step[c]).toBe(full[t * H * hd + c]);   // 逐位
      }
    }
  });
});

describe('新算子的梯度检验（f64）', () => {
  const H_STEP = 1e-5;

  function checkGrad(loss: () => number, param: Float64Array, grad: Float64Array, idx: number[]) {
    let worst = 0;
    for (const i of idx) {
      const orig = param[i];
      param[i] = orig + H_STEP; const lp = loss();
      param[i] = orig - H_STEP; const lm = loss();
      param[i] = orig;
      const num = (lp - lm) / (2 * H_STEP);
      const rel = Math.abs(num - grad[i]) / Math.max(1e-6, Math.abs(num) + Math.abs(grad[i]));
      worst = Math.max(worst, rel);
    }
    return worst;
  }

  it('softmax_rows_bwd —— 漏掉 Σ p·dp 那一项前向照样对', () => {
    const rows = 6, cols = 8;
    const x = filled(rows * cols, 21);
    const out = rt.arena.zeros([rows * cols], 'f64');
    const dx = rt.arena.zeros([rows * cols], 'f64');
    const w = filled(rows * cols, 22);
    const dout = rt.arena.zeros([rows * cols], 'f64');
    const valid = rt.arena.zeros([rows], 'f32', 'data');
    const vv = rt.arena.i32(valid);
    for (let r = 0; r < rows; r++) vv[r] = 3 + (r % 5);   // 参差不齐的有效长度

    const loss = () => {
      rt.ops.softmaxRows(x, valid, out, rows, cols);
      const O = rt.arena.view(out), W = rt.arena.view(w);
      let s = 0;
      for (let i = 0; i < rows * cols; i++) s += O[i] * W[i];
      return s;
    };
    loss();
    rt.arena.view(dout).set(rt.arena.view(w));
    rt.ops.softmaxRowsBwd(dout, out, valid, dx, rows, cols);

    const idx = Array.from({ length: 16 }, (_, i) => (i * 7 + 1) % (rows * cols));
    expect(checkGrad(loss, rt.arena.view(x) as Float64Array, rt.arena.view(dx) as Float64Array, idx))
      .toBeLessThan(2e-3);
  });

  it('attn_scores_bwd 与 attn_apply_bwd', () => {
    const B = 2, S = 4, H = 2, KV = 1, hd = 4;
    const q = filled(B * S * H * hd, 31);
    const k = filled(B * S * KV * hd, 32);
    const v = filled(B * S * KV * hd, 33);
    const scores = rt.arena.zeros([B * H * S * S], 'f64');
    const probs = rt.arena.zeros([B * H * S * S], 'f64');
    const out = rt.arena.zeros([B * S * H * hd], 'f64');
    const valid = rt.arena.zeros([B * H * S], 'f32', 'data');
    const vv = rt.arena.i32(valid);
    for (let b = 0; b < B; b++) for (let h = 0; h < H; h++) for (let i = 0; i < S; i++) vv[(b * H + h) * S + i] = i + 1;
    const w = filled(B * S * H * hd, 34);
    const scale = 1 / Math.sqrt(hd);

    const loss = () => {
      rt.ops.attnScores(q, k, scores, B, S, S, H, KV, hd, scale);
      rt.ops.softmaxRows(scores, valid, probs, B * H * S, S);
      rt.ops.attnApply(probs, v, out, B, S, S, H, KV, hd);
      const O = rt.arena.view(out), W = rt.arena.view(w);
      let s = 0;
      for (let i = 0; i < B * S * H * hd; i++) s += O[i] * W[i];
      return s;
    };
    loss();

    // 反向：dout → dprobs/dv → dscores → dq/dk
    const dout = rt.arena.zeros([B * S * H * hd], 'f64');
    rt.arena.view(dout).set(rt.arena.view(w));
    const dprobs = rt.arena.zeros([B * H * S * S], 'f64');
    const dv = rt.arena.zeros([B * S * KV * hd], 'f64');
    rt.ops.attnApplyBwd(dout, probs, v, dprobs, dv, B, S, S, H, KV, hd);
    const dscores = rt.arena.zeros([B * H * S * S], 'f64');
    rt.ops.softmaxRowsBwd(dprobs, probs, valid, dscores, B * H * S, S);
    const dq = rt.arena.zeros([B * S * H * hd], 'f64');
    const dk = rt.arena.zeros([B * S * KV * hd], 'f64');
    rt.ops.attnScoresBwd(dscores, q, k, dq, dk, B, S, S, H, KV, hd, scale);

    const nq = B * S * H * hd, nkv = B * S * KV * hd;
    const qi = Array.from({ length: 10 }, (_, i) => (i * 11 + 1) % nq);
    const ki = Array.from({ length: 10 }, (_, i) => (i * 7 + 2) % nkv);
    expect(checkGrad(loss, rt.arena.view(q) as Float64Array, rt.arena.view(dq) as Float64Array, qi)).toBeLessThan(2e-3);
    expect(checkGrad(loss, rt.arena.view(k) as Float64Array, rt.arena.view(dk) as Float64Array, ki)).toBeLessThan(2e-3);
    expect(checkGrad(loss, rt.arena.view(v) as Float64Array, rt.arena.view(dv) as Float64Array, ki)).toBeLessThan(2e-3);
  });

  it('layernorm_bwd', () => {
    const rows = 4, d = 12;
    const x = filled(rows * d, 41);
    const g = rt.arena.zeros([d], 'f64');
    const bi = rt.arena.zeros([d], 'f64');
    const gv = rt.arena.view(g), bv = rt.arena.view(bi);
    const r = rng(42);
    for (let i = 0; i < d; i++) { gv[i] = 1 + r() * 0.4; bv[i] = r() * 0.2; }
    const out = rt.arena.zeros([rows * d], 'f64');
    const mean = rt.arena.zeros([rows], 'f64');
    const inv = rt.arena.zeros([rows], 'f64');
    const w = filled(rows * d, 43);
    const dout = rt.arena.zeros([rows * d], 'f64');
    const dg = rt.arena.zeros([d], 'f64');
    const db = rt.arena.zeros([d], 'f64');
    const dx = rt.arena.zeros([rows * d], 'f64');

    const loss = () => {
      rt.ops.layernormFwd(x, g, bi, out, mean, inv, rows, d);
      const O = rt.arena.view(out), W = rt.arena.view(w);
      let s = 0;
      for (let i = 0; i < rows * d; i++) s += O[i] * W[i];
      return s;
    };
    loss();
    rt.arena.view(dout).set(rt.arena.view(w));
    rt.ops.layernormBwd(dout, x, g, mean, inv, dg, db, dx, rows, d);

    const idx = Array.from({ length: 12 }, (_, i) => (i * 5 + 1) % (rows * d));
    expect(checkGrad(loss, rt.arena.view(x) as Float64Array, rt.arena.view(dx) as Float64Array, idx)).toBeLessThan(2e-3);
    const gi = Array.from({ length: 6 }, (_, i) => (i * 3) % d);
    expect(checkGrad(loss, rt.arena.view(g) as Float64Array, rt.arena.view(dg) as Float64Array, gi)).toBeLessThan(2e-3);
    expect(checkGrad(loss, rt.arena.view(bi) as Float64Array, rt.arena.view(db) as Float64Array, gi)).toBeLessThan(2e-3);
  });
});

describe('低精度的位级模拟', () => {
  /*
   * 第 17 关的对照组。两个格式的**指数位数不同**是关键：
   * bf16 有 8 位（和 f32 一样），fp16 只有 5 位、最大值 65504。
   * 所以「同一份代码换一种精度，fp16 那条会溢出」是算出来的，不是被告知的。
   */
  it('bf16 保住动态范围，fp16 在 65504 之上溢出', () => {
    const values = [1e-8, 1e-4, 1.0, 1000, 60000, 70000, 1e10, 3e38];
    const t = rt.arena.zeros([values.length], 'f32');
    rt.arena.view(t).set(values);
    rt.ops.quantizeBf16(t);
    const bf = Array.from(rt.arena.view(t));

    const t2 = rt.arena.zeros([values.length], 'f32');
    rt.arena.view(t2).set(values);
    rt.ops.quantizeFp16(t2);
    const fp = Array.from(rt.arena.view(t2));

    console.log(`  bf16: ${bf.map((x) => x.toExponential(2)).join(', ')}`);
    console.log(`  fp16: ${fp.map((x) => x.toExponential(2)).join(', ')}`);

    // bf16 一个都不溢出（指数位数和 f32 一样）
    expect(rt.ops.countNonFinite(t)).toBe(0);
    // fp16：70000 / 1e10 / 3e38 三个溢出成 inf；1e-8 掉到 0（次正规下界 2^-24）
    expect(fp[5]).toBe(Infinity);
    expect(fp[6]).toBe(Infinity);
    expect(fp[7]).toBe(Infinity);
    expect(rt.ops.countNonFinite(t2)).toBe(3);
    expect(fp[4]).toBeCloseTo(60000, -2);   // 65504 以内还在
  });

  it('bf16 只留 7 位尾数，精度确实掉了', () => {
    const t = rt.arena.zeros([1], 'f32');
    rt.arena.view(t)[0] = 1.2345678;
    rt.ops.quantizeBf16(t);
    const v = rt.arena.view(t)[0];
    expect(v).not.toBe(Math.fround(1.2345678));
    expect(Math.abs(v - 1.2345678)).toBeLessThan(0.01);   // 但量级还对
  });

  it('fp16 的尾数比 bf16 多，同一个数更准', () => {
    const make = (q: 'bf16' | 'fp16', x: number) => {
      const t = rt.arena.zeros([1], 'f32');
      rt.arena.view(t)[0] = x;
      if (q === 'bf16') rt.ops.quantizeBf16(t); else rt.ops.quantizeFp16(t);
      return Math.abs(rt.arena.view(t)[0] - x);
    };
    /*
     * 取 1.1 而不是 1.2345678。后者的 bf16 结果恰好也是 fp16 的可表示值
     * （1.234375 = 1 + 240/1024），于是两个格式给出完全一样的数 ——
     * 用它比较会得出「fp16 不比 bf16 准」这个假结论。
     * 挑对照值的时候要避开这种巧合。
     */
    const bf = make('bf16', 1.1);
    const fp = make('fp16', 1.1);
    console.log(`  1.1 的舍入误差：bf16 ${bf.toExponential(2)} / fp16 ${fp.toExponential(2)}`);
    // fp16 有 10 位尾数，bf16 只有 7 位 —— 这是两者的取舍：范围 vs 精度
    expect(fp).toBeLessThan(bf);
  });

  it('NaN 与 inf 原样穿过，不被舍成别的东西', () => {
    const t = rt.arena.zeros([3], 'f32');
    rt.arena.view(t).set([NaN, Infinity, -Infinity]);
    rt.ops.quantizeBf16(t);
    const v = rt.arena.view(t);
    expect(Number.isNaN(v[0])).toBe(true);
    expect(v[1]).toBe(Infinity);
    expect(v[2]).toBe(-Infinity);
  });
});
