/**
 * 算子核：正确性、确定性、以及 f64 路径的梯度检验
 *
 * 这是整个项目最底下那一层。它错了，上面所有的门槛都在量一个假的东西 ——
 * 而且是**静默地**假：loss 照样会降，样例照样能生成，只有梯度检验挂。
 *
 * 所以这里的用例分三类：
 *
 * 1. **对拍**：每个算子对着一份直白的 JS 参考实现，f32 按 fp32 容差、
 *    f64 按 1e-12。参考实现故意写得笨，可读性优先。
 * 2. **梯度检验**：在 f64 里用中心差分验反向。这条最值钱 ——
 *    rmsnorm 少一项、attention 的 softmax 反向写错，前向都是对的，
 *    只有它抓得到。
 * 3. **确定性**：同一份输入跑两遍，逐位一致。
 *
 * 顺带留一条吞吐量的记录用例（不作断言，机器不同数不同），
 * 好让「原型量到 42 GFLOP/s」这件事在真产物上也有个数可看。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  createKernels, createKernelsAsync, KERNEL_ABI_VERSION, type Kernels,
} from '../../src/lib/llmlab/kernels';

const WASM = join(__dirname, '..', '..', 'public', 'llmlab', 'llmlab-kernels.wasm');

let K: Kernels;
beforeAll(() => {
  K = createKernels(readFileSync(WASM));
});

/** 确定性的伪随机，避免用例之间互相影响 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296 - 0.5;
  };
}

/** 分配一块并填上确定性随机数 */
function put(n: number, seed: number, f64 = false): number {
  const off = K.alloc(n * (f64 ? 8 : 4));
  const view = f64 ? K.f64(off, n) : K.f32(off, n);
  const r = rng(seed);
  for (let i = 0; i < n; i++) view[i] = r();
  return off;
}

function zeros(n: number, f64 = false): number {
  const off = K.alloc(n * (f64 ? 8 : 4));
  (f64 ? K.f64(off, n) : K.f32(off, n)).fill(0);
  return off;
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('算子核：装载', () => {
  it('零 import —— 一个 {} 就能实例化', () => {
    const module = new WebAssembly.Module(readFileSync(WASM));
    expect(WebAssembly.Module.imports(module)).toHaveLength(0);
  });

  it('ABI 版本与代码里的常量一致', () => {
    expect(K.fn.ll_abi_version()).toBe(KERNEL_ABI_VERSION);
  });

  it('产物不是空壳', () => {
    expect(readFileSync(WASM).byteLength).toBeGreaterThan(4000);
  });

  /*
   * 这条盯的是「改了 .c 忘了重建」。产物进仓库的代价就是它会过期，
   * 而过期的表现是「代码看着是新的、跑的是旧的」，不报任何错。
   * CI 里 --check 会做字节比对；这里做的是更弱但更快的一条：产物不能比源码旧。
   */
  it('产物不比源码旧', () => {
    const { mtimeMs: wasm } = require('fs').statSync(WASM);
    for (const name of ['kernels.c', 'ops.h', 'math.h']) {
      const src = join(__dirname, '..', '..', 'src', 'lib', 'llmlab', 'kernels', name);
      const { mtimeMs } = require('fs').statSync(src);
      expect(wasm).toBeGreaterThanOrEqual(mtimeMs - 1000);
    }
  });
});

describe('矩阵乘', () => {
  const shapes: Array<[number, number, number]> = [
    [1, 1, 1], [3, 5, 7], [63, 37, 51], [64, 64, 64], [128, 96, 64],
  ];

  it.each(shapes)('gemm_nn f32 %ix%ix%i', (M, N, K_) => {
    const mark = K.mark();
    const a = put(M * K_, 1), b = put(K_ * N, 2), c = zeros(M * N);
    K.fn.gemm_nn_f32(a, b, c, M, N, K_);
    const A = K.f32(a, M * K_), B = K.f32(b, K_ * N), C = K.f32(c, M * N);
    const ref = new Float32Array(M * N);
    for (let i = 0; i < M; i++)
      for (let j = 0; j < N; j++) {
        let s = 0;
        for (let k = 0; k < K_; k++) s += A[i * K_ + k] * B[k * N + j];
        ref[i * N + j] = s;
      }
    // 求和顺序不同，fp32 下差在舍入量级
    expect(maxAbsDiff(C, ref)).toBeLessThan(1e-4);
    K.reset(mark);
  });

  it.each(shapes)('gemm_nn f64 %ix%ix%i', (M, N, K_) => {
    const mark = K.mark();
    const a = put(M * K_, 3, true), b = put(K_ * N, 4, true), c = zeros(M * N, true);
    K.fn.gemm_nn_f64(a, b, c, M, N, K_);
    const A = K.f64(a, M * K_), B = K.f64(b, K_ * N), C = K.f64(c, M * N);
    const ref = new Float64Array(M * N);
    for (let i = 0; i < M; i++)
      for (let j = 0; j < N; j++) {
        let s = 0;
        for (let k = 0; k < K_; k++) s += A[i * K_ + k] * B[k * N + j];
        ref[i * N + j] = s;
      }
    expect(maxAbsDiff(C, ref)).toBeLessThan(1e-12);
    K.reset(mark);
  });

  it('gemm_tn_acc 是累加的，不是覆盖', () => {
    const mark = K.mark();
    const M = 12, N = 9, Kd = 7;
    const a = put(M * Kd, 5, true), b = put(M * N, 6, true), c = put(Kd * N, 7, true);
    const before = Float64Array.from(K.f64(c, Kd * N));
    K.fn.gemm_tn_acc_f64(a, b, c, M, N, Kd);
    const A = K.f64(a, M * Kd), B = K.f64(b, M * N), C = K.f64(c, Kd * N);
    const ref = Float64Array.from(before);
    for (let m = 0; m < M; m++)
      for (let k = 0; k < Kd; k++)
        for (let j = 0; j < N; j++) ref[k * N + j] += A[m * Kd + k] * B[m * N + j];
    expect(maxAbsDiff(C, ref)).toBeLessThan(1e-12);
    K.reset(mark);
  });

  it('gemm_nt 算的是 A @ B^T', () => {
    const mark = K.mark();
    const M = 11, Kd = 13, N = 17;
    const a = put(M * N, 8, true), b = put(Kd * N, 9, true), c = zeros(M * Kd, true);
    K.fn.gemm_nt_f64(a, b, c, M, Kd, N);
    const A = K.f64(a, M * N), B = K.f64(b, Kd * N), C = K.f64(c, M * Kd);
    const ref = new Float64Array(M * Kd);
    for (let m = 0; m < M; m++)
      for (let k = 0; k < Kd; k++) {
        let s = 0;
        for (let j = 0; j < N; j++) s += A[m * N + j] * B[k * N + j];
        ref[m * Kd + k] = s;
      }
    expect(maxAbsDiff(C, ref)).toBeLessThan(1e-12);
    K.reset(mark);
  });
});

describe('超越函数：自己实现的那两个', () => {
  /*
   * 为什么不用宿主的：V8 与 JSC 的 Math.exp 结果不一样，直接用会让
   * 「同一份代码跑两遍逐位一致」这条门槛在不同浏览器上给出不同答案。
   * 这里反过来拿 JS 的当参考，验我们的准不准 —— 精度对得上就行，
   * 位模式不必一样。
   */
  it('exp 与 JS 的 Math.exp 相对误差 < 1e-14', () => {
    const mark = K.mark();
    const xs = [-700, -30, -5, -1, -0.3, 0, 0.3, 1, 5, 30, 700];
    // 借 swiglu 的 sigmoid 反推 exp：sigmoid(x) = 1/(1+e^-x)
    const n = xs.length;
    const gate = K.alloc(n * 8), up = K.alloc(n * 8), out = K.alloc(n * 8);
    K.f64(gate, n).set(xs);
    K.f64(up, n).fill(1);
    K.fn.swiglu_fwd_f64(gate, up, out, n);
    const got = K.f64(out, n);
    for (let i = 0; i < n; i++) {
      const sig = 1 / (1 + Math.exp(-xs[i]));
      const expected = xs[i] * sig;
      const err = Math.abs(got[i] - expected) / Math.max(1e-300, Math.abs(expected));
      expect(err).toBeLessThan(1e-14);
    }
    K.reset(mark);
  });

  it('log 走交叉熵那条路，与 JS 的 Math.log 对得上', () => {
    const mark = K.mark();
    const rows = 4, vocab = 6;
    const logits = put(rows * vocab, 21, true);
    const tgt = K.alloc(rows * 4);
    K.i32(tgt, rows).set([0, 3, 5, 1]);
    const probs = zeros(rows * vocab, true);
    const loss = K.fn.cross_entropy_f64(logits, tgt, probs, rows, vocab);

    const L = K.f64(logits, rows * vocab);
    const t = K.i32(tgt, rows);
    let ref = 0;
    for (let r = 0; r < rows; r++) {
      let mx = -Infinity;
      for (let j = 0; j < vocab; j++) mx = Math.max(mx, L[r * vocab + j]);
      let sum = 0;
      for (let j = 0; j < vocab; j++) sum += Math.exp(L[r * vocab + j] - mx);
      ref += -(L[r * vocab + t[r]] - mx - Math.log(sum));
    }
    ref /= rows;
    expect(Math.abs(loss - ref)).toBeLessThan(1e-13);
    K.reset(mark);
  });

  it('softmax 减最大值：logits 很大时不出 NaN', () => {
    const mark = K.mark();
    const rows = 2, vocab = 4;
    const logits = K.alloc(rows * vocab * 8);
    // 不减最大值的话 exp(800) = inf，然后 inf/inf = NaN
    K.f64(logits, rows * vocab).set([800, 799, 798, 797, -800, -799, -798, -797]);
    const tgt = K.alloc(rows * 4);
    K.i32(tgt, rows).set([0, 3]);
    const probs = zeros(rows * vocab, true);
    const loss = K.fn.cross_entropy_f64(logits, tgt, probs, rows, vocab);
    expect(Number.isFinite(loss)).toBe(true);
    const p = K.f64(probs, rows * vocab);
    for (let r = 0; r < rows; r++) {
      let s = 0;
      for (let j = 0; j < vocab; j++) s += p[r * vocab + j];
      expect(s).toBeCloseTo(1, 12);
    }
    K.reset(mark);
  });
});

describe('注意力', () => {
  const B = 2, S = 6, H = 4, KV = 2, hd = 8;

  it('因果：概率矩阵的上三角恒为 0，每行和为 1', () => {
    const mark = K.mark();
    const q = put(B * S * H * hd, 11, true);
    const k = put(B * S * KV * hd, 12, true);
    const v = put(B * S * KV * hd, 13, true);
    const att = zeros(B * H * S * S, true);
    const out = zeros(B * S * H * hd, true);
    K.fn.attn_fwd_f64(q, k, v, att, out, B, S, H, KV, hd);
    const A = K.f64(att, B * H * S * S);
    for (let b = 0; b < B; b++)
      for (let h = 0; h < H; h++)
        for (let i = 0; i < S; i++) {
          let sum = 0;
          for (let j = 0; j < S; j++) {
            const p = A[((b * H + h) * S + i) * S + j];
            if (j > i) expect(p).toBe(0);   // 未来位置必须是硬 0，不是「很小」
            else sum += p;
          }
          expect(sum).toBeCloseTo(1, 12);
        }
    K.reset(mark);
  });

  /*
   * 因果性的真正判据不是「掩码写了没」，而是**改未来改不动现在**。
   * 这条探针就是第 3 关那条 `llm.causality.leakBits = 0` 门槛的原型。
   */
  it('改掉后面的 token，前面位置的输出一位都不变', () => {
    const mark = K.mark();
    const q = put(B * S * H * hd, 14, true);
    const k = put(B * S * KV * hd, 15, true);
    const v = put(B * S * KV * hd, 16, true);
    const att = zeros(B * H * S * S, true);
    const out1 = zeros(B * S * H * hd, true);
    K.fn.attn_fwd_f64(q, k, v, att, out1, B, S, H, KV, hd);
    const before = Float64Array.from(K.f64(out1, B * S * H * hd));

    // 把每个 batch 最后一个位置的 k / v 全改掉
    const kv = K.f64(k, B * S * KV * hd), vv = K.f64(v, B * S * KV * hd);
    for (let b = 0; b < B; b++)
      for (let c = 0; c < KV * hd; c++) {
        kv[((b * S + (S - 1)) * KV) * hd + c] += 3.14;
        vv[((b * S + (S - 1)) * KV) * hd + c] -= 2.71;
      }
    const out2 = zeros(B * S * H * hd, true);
    K.fn.attn_fwd_f64(q, k, v, att, out2, B, S, H, KV, hd);
    const after = K.f64(out2, B * S * H * hd);

    for (let b = 0; b < B; b++)
      for (let i = 0; i < S - 1; i++)           // 最后一个位置本来就该变
        for (let c = 0; c < H * hd; c++) {
          const idx = (b * S + i) * H * hd + c;
          expect(after[idx]).toBe(before[idx]); // 逐位，不是 toBeCloseTo
        }
    K.reset(mark);
  });

  it('GQA：kv 头数减半时，共享同一个 kv 头的查询头看到的是同一份 k/v', () => {
    const mark = K.mark();
    // KV=1 时所有查询头共用一个 kv 头；把 q 的两个头设成相同，输出必须相同
    const b1 = 1, s1 = 4, h1 = 2, kv1 = 1, hd1 = 4;
    const q = zeros(b1 * s1 * h1 * hd1, true);
    const qv = K.f64(q, b1 * s1 * h1 * hd1);
    const r = rng(77);
    for (let s = 0; s < s1; s++) {
      for (let c = 0; c < hd1; c++) {
        const val = r();
        qv[(s * h1 + 0) * hd1 + c] = val;
        qv[(s * h1 + 1) * hd1 + c] = val;
      }
    }
    const k = put(b1 * s1 * kv1 * hd1, 18, true);
    const v = put(b1 * s1 * kv1 * hd1, 19, true);
    const att = zeros(b1 * h1 * s1 * s1, true);
    const out = zeros(b1 * s1 * h1 * hd1, true);
    K.fn.attn_fwd_f64(q, k, v, att, out, b1, s1, h1, kv1, hd1);
    const O = K.f64(out, b1 * s1 * h1 * hd1);
    for (let s = 0; s < s1; s++)
      for (let c = 0; c < hd1; c++)
        expect(O[(s * h1 + 1) * hd1 + c]).toBe(O[(s * h1 + 0) * hd1 + c]);
    K.reset(mark);
  });
});

describe('RoPE', () => {
  it('前向再反向是恒等变换（旋转矩阵的转置就是逆）', () => {
    const mark = K.mark();
    const B = 2, S = 5, H = 3, hd = 8, half = hd / 2;
    const x = put(B * S * H * hd, 31, true);
    const before = Float64Array.from(K.f64(x, B * S * H * hd));
    const cos = K.alloc(S * half * 8), sin = K.alloc(S * half * 8);
    const cv = K.f64(cos, S * half), sv = K.f64(sin, S * half);
    for (let p = 0; p < S; p++)
      for (let i = 0; i < half; i++) {
        const th = p / Math.pow(10000, (2 * i) / hd);
        cv[p * half + i] = Math.cos(th);
        sv[p * half + i] = Math.sin(th);
      }
    K.fn.rope_fwd_f64(x, cos, sin, B, S, H, hd);
    K.fn.rope_bwd_f64(x, cos, sin, B, S, H, hd);
    expect(maxAbsDiff(K.f64(x, B * S * H * hd), before)).toBeLessThan(1e-14);
    K.reset(mark);
  });

  it('位置 0 不旋转', () => {
    const mark = K.mark();
    const B = 1, S = 2, H = 1, hd = 4, half = hd / 2;
    const x = put(B * S * H * hd, 32, true);
    const before = Float64Array.from(K.f64(x, B * S * H * hd));
    const cos = K.alloc(S * half * 8), sin = K.alloc(S * half * 8);
    const cv = K.f64(cos, S * half), sv = K.f64(sin, S * half);
    for (let p = 0; p < S; p++)
      for (let i = 0; i < half; i++) {
        const th = p / Math.pow(10000, (2 * i) / hd);
        cv[p * half + i] = Math.cos(th);
        sv[p * half + i] = Math.sin(th);
      }
    K.fn.rope_fwd_f64(x, cos, sin, B, S, H, hd);
    const after = K.f64(x, B * S * H * hd);
    for (let c = 0; c < hd; c++) expect(after[c]).toBeCloseTo(before[c], 15);
    K.reset(mark);
  });
});

/**
 * 梯度检验：中心差分 vs 解析梯度，全部在 f64 里。
 *
 * **这一组是整个文件里最值钱的。** rmsnorm 少减一项、softmax 的反向漏掉
 * 那个 `Σ p·dp`、swiglu 的导数写成 σ(z) 而不是 σ(z)(1+z(1−σ)) ——
 * 这三种错误的前向都是完全正确的，loss 也会降，只有它抓得到。
 *
 * 步长取 1e-5：f64 下中心差分的误差是 O(h²) + O(ε/h)，
 * h=1e-5 时两项都在 1e-10 量级，留了四个数量级的余量给 2e-3 这个界。
 */
describe('梯度检验（f64）', () => {
  const H_STEP = 1e-5;

  /** 通用：给一个 loss(参数) 与一份解析梯度，逐点比 */
  function checkGrad(
    loss: () => number,
    param: Float64Array,
    grad: Float64Array,
    indices: number[]
  ): number {
    let worst = 0;
    for (const i of indices) {
      const orig = param[i];
      param[i] = orig + H_STEP; const lp = loss();
      param[i] = orig - H_STEP; const lm = loss();
      param[i] = orig;
      const num = (lp - lm) / (2 * H_STEP);
      const ana = grad[i];
      const rel = Math.abs(num - ana) / Math.max(1e-6, Math.abs(num) + Math.abs(ana));
      worst = Math.max(worst, rel);
    }
    return worst;
  }

  it('rmsnorm_bwd —— 漏掉 r³ 那一项前向照样对，只有这条抓得到', () => {
    const mark = K.mark();
    const rows = 4, d = 16;
    const x = put(rows * d, 41, true);
    const g = K.alloc(d * 8);
    const gv = K.f64(g, d);
    const r = rng(42);
    for (let i = 0; i < d; i++) gv[i] = 1 + r() * 0.5;
    const out = zeros(rows * d, true), inv = zeros(rows, true);
    const w = put(rows * d, 43, true);   // 固定的权重，loss = Σ out·w
    const dout = K.alloc(rows * d * 8);
    const dg = zeros(d, true), dx = zeros(rows * d, true);

    const loss = () => {
      K.fn.rmsnorm_fwd_f64(x, g, out, inv, rows, d, 1e-5);
      const O = K.f64(out, rows * d), W = K.f64(w, rows * d);
      let s = 0;
      for (let i = 0; i < rows * d; i++) s += O[i] * W[i];
      return s;
    };

    loss();
    K.f64(dout, rows * d).set(K.f64(w, rows * d));   // dL/dout = w
    K.f64(dg, d).fill(0);
    K.fn.rmsnorm_bwd_f64(dout, x, g, inv, dg, dx, rows, d);

    const idx = Array.from({ length: 16 }, (_, i) => (i * 7 + 3) % (rows * d));
    expect(checkGrad(loss, K.f64(x, rows * d), K.f64(dx, rows * d), idx)).toBeLessThan(2e-3);
    // 增益的梯度也要查 —— 它是另一条式子
    const gidx = Array.from({ length: 8 }, (_, i) => (i * 3) % d);
    expect(checkGrad(loss, K.f64(g, d), K.f64(dg, d), gidx)).toBeLessThan(2e-3);
    K.reset(mark);
  });

  it('swiglu_bwd —— 门与上投影两条式子都要对', () => {
    const mark = K.mark();
    const n = 64;
    const gate = put(n, 51, true), up = put(n, 52, true);
    const out = zeros(n, true), w = put(n, 53, true);
    const dout = K.alloc(n * 8);
    const dgate = zeros(n, true), dup = zeros(n, true);

    const loss = () => {
      K.fn.swiglu_fwd_f64(gate, up, out, n);
      const O = K.f64(out, n), W = K.f64(w, n);
      let s = 0;
      for (let i = 0; i < n; i++) s += O[i] * W[i];
      return s;
    };
    loss();
    K.f64(dout, n).set(K.f64(w, n));
    K.fn.swiglu_bwd_f64(dout, gate, up, dgate, dup, n);

    const idx = Array.from({ length: 16 }, (_, i) => (i * 5) % n);
    expect(checkGrad(loss, K.f64(gate, n), K.f64(dgate, n), idx)).toBeLessThan(2e-3);
    expect(checkGrad(loss, K.f64(up, n), K.f64(dup, n), idx)).toBeLessThan(2e-3);
    K.reset(mark);
  });

  it('attn_bwd —— softmax 反向那个 Σ p·dp 漏了就会红', () => {
    const mark = K.mark();
    const B = 2, S = 5, H = 2, KV = 1, hd = 4;
    const q = put(B * S * H * hd, 61, true);
    const k = put(B * S * KV * hd, 62, true);
    const v = put(B * S * KV * hd, 63, true);
    const att = zeros(B * H * S * S, true);
    const out = zeros(B * S * H * hd, true);
    const w = put(B * S * H * hd, 64, true);
    const dout = K.alloc(B * S * H * hd * 8);
    const dq = zeros(B * S * H * hd, true);
    const dk = zeros(B * S * KV * hd, true);
    const dv = zeros(B * S * KV * hd, true);
    const dp = zeros(S, true);

    const loss = () => {
      K.fn.attn_fwd_f64(q, k, v, att, out, B, S, H, KV, hd);
      const O = K.f64(out, B * S * H * hd), W = K.f64(w, B * S * H * hd);
      let s = 0;
      for (let i = 0; i < B * S * H * hd; i++) s += O[i] * W[i];
      return s;
    };
    loss();
    K.f64(dout, B * S * H * hd).set(K.f64(w, B * S * H * hd));
    K.fn.attn_bwd_f64(dout, q, k, v, att, dq, dk, dv, dp, B, S, H, KV, hd);

    const nq = B * S * H * hd, nkv = B * S * KV * hd;
    const qi = Array.from({ length: 12 }, (_, i) => (i * 11 + 1) % nq);
    const ki = Array.from({ length: 12 }, (_, i) => (i * 7 + 2) % nkv);
    expect(checkGrad(loss, K.f64(q, nq), K.f64(dq, nq), qi)).toBeLessThan(2e-3);
    expect(checkGrad(loss, K.f64(k, nkv), K.f64(dk, nkv), ki)).toBeLessThan(2e-3);
    expect(checkGrad(loss, K.f64(v, nkv), K.f64(dv, nkv), ki)).toBeLessThan(2e-3);
    K.reset(mark);
  });

  it('cross_entropy_bwd —— dlogits = (p − onehot)·scale', () => {
    const mark = K.mark();
    const rows = 5, vocab = 9;
    const logits = put(rows * vocab, 71, true);
    const tgt = K.alloc(rows * 4);
    K.i32(tgt, rows).set([0, 4, 8, 2, 6]);
    const probs = zeros(rows * vocab, true);
    const dl = zeros(rows * vocab, true);

    const loss = () => K.fn.cross_entropy_f64(logits, tgt, probs, rows, vocab);
    loss();
    K.fn.cross_entropy_bwd_f64(probs, tgt, -1, dl, rows, vocab, 1 / rows);

    const idx = Array.from({ length: 20 }, (_, i) => (i * 13 + 1) % (rows * vocab));
    expect(checkGrad(loss, K.f64(logits, rows * vocab), K.f64(dl, rows * vocab), idx))
      .toBeLessThan(2e-3);
    K.reset(mark);
  });

  it('loss mask：被遮住的行梯度恒为 0', () => {
    const mark = K.mark();
    const rows = 4, vocab = 5;
    const logits = put(rows * vocab, 81, true);
    const tgt = K.alloc(rows * 4);
    K.i32(tgt, rows).set([1, 2, 3, 4]);
    const mask = K.alloc(rows * 4);
    K.i32(mask, rows).set([1, 0, 1, 0]);
    const probs = zeros(rows * vocab, true);
    const dl = zeros(rows * vocab, true);
    K.fn.cross_entropy_f64(logits, tgt, probs, rows, vocab);
    K.fn.cross_entropy_bwd_f64(probs, tgt, mask, dl, rows, vocab, 1 / rows);
    const D = K.f64(dl, rows * vocab);
    for (const r of [1, 3])
      for (let j = 0; j < vocab; j++) expect(D[r * vocab + j]).toBe(0);
    for (const r of [0, 2]) {
      let any = false;
      for (let j = 0; j < vocab; j++) if (D[r * vocab + j] !== 0) any = true;
      expect(any).toBe(true);
    }
    K.reset(mark);
  });
});

describe('嵌入与优化器', () => {
  it('embed_bwd 对重复的 token 是累加的', () => {
    const mark = K.mark();
    const vocab = 5, d = 4, rows = 6;
    const idx = K.alloc(rows * 4);
    K.i32(idx, rows).set([2, 2, 0, 4, 2, 0]);   // token 2 出现三次
    const dout = put(rows * d, 91, true);
    const dtable = zeros(vocab * d, true);
    K.fn.embed_bwd_f64(dout, idx, dtable, rows, d);
    const D = K.f64(dout, rows * d), T = K.f64(dtable, vocab * d);
    for (let c = 0; c < d; c++) {
      expect(T[2 * d + c]).toBeCloseTo(D[0 * d + c] + D[1 * d + c] + D[4 * d + c], 14);
      expect(T[0 * d + c]).toBeCloseTo(D[2 * d + c] + D[5 * d + c], 14);
      expect(T[1 * d + c]).toBe(0);
    }
    K.reset(mark);
  });

  it('embed_fwd 取的是对应行', () => {
    const mark = K.mark();
    const vocab = 4, d = 3, rows = 3;
    const table = put(vocab * d, 92, true);
    const idx = K.alloc(rows * 4);
    K.i32(idx, rows).set([3, 0, 1]);
    const out = zeros(rows * d, true);
    K.fn.embed_fwd_f64(table, idx, out, rows, d);
    const T = K.f64(table, vocab * d), O = K.f64(out, rows * d);
    for (let c = 0; c < d; c++) {
      expect(O[0 * d + c]).toBe(T[3 * d + c]);
      expect(O[1 * d + c]).toBe(T[0 * d + c]);
      expect(O[2 * d + c]).toBe(T[1 * d + c]);
    }
    K.reset(mark);
  });

  it('AdamW 的权重衰减是解耦的 —— 不进动量', () => {
    const mark = K.mark();
    const n = 8;
    const w = K.alloc(n * 8), g = K.alloc(n * 8);
    const m = zeros(n, true), v = zeros(n, true);
    K.f64(w, n).fill(1);
    K.f64(g, n).fill(0);          // 梯度为 0：更新应当**只**来自权重衰减
    const lr = 0.1, decay = 0.5;
    K.fn.adamw_f64(w, g, m, v, n, lr, 0.9, 0.95, 1e-8, decay, 1 - 0.9, 1 - 0.95, 1.0);
    const W = K.f64(w, n), M = K.f64(m, n);
    for (let i = 0; i < n; i++) {
      expect(W[i]).toBeCloseTo(1 - lr * decay * 1, 14);
      expect(M[i]).toBe(0);       // 衰减没有污染动量
    }
    K.reset(mark);
  });

  it('AdamW 一步与手算一致', () => {
    const mark = K.mark();
    const n = 4;
    const w = K.alloc(n * 8), g = K.alloc(n * 8);
    const m = zeros(n, true), v = zeros(n, true);
    K.f64(w, n).set([0.5, -0.5, 1.0, -1.0]);
    K.f64(g, n).set([0.1, -0.2, 0.3, -0.4]);
    const b1 = 0.9, b2 = 0.95, eps = 1e-8, lr = 0.01;
    const bc1 = 1 - b1, bc2 = 1 - b2;
    const w0 = Array.from(K.f64(w, n)), g0 = Array.from(K.f64(g, n));
    K.fn.adamw_f64(w, g, m, v, n, lr, b1, b2, eps, 0, bc1, bc2, 1.0);
    const W = K.f64(w, n);
    for (let i = 0; i < n; i++) {
      const mi = (1 - b1) * g0[i], vi = (1 - b2) * g0[i] * g0[i];
      const expected = w0[i] - lr * ((mi / bc1) / (Math.sqrt(vi / bc2) + eps));
      expect(W[i]).toBeCloseTo(expected, 14);
    }
    K.reset(mark);
  });

  it('sumsq 是梯度范数的原料', () => {
    const mark = K.mark();
    const n = 100;
    const a = put(n, 93, true);
    const A = K.f64(a, n);
    let ref = 0;
    for (let i = 0; i < n; i++) ref += A[i] * A[i];
    expect(K.fn.sumsq_f64(a, n)).toBeCloseTo(ref, 12);
    K.reset(mark);
  });
});

describe('确定性', () => {
  /*
   * 这条是所有门槛的地基。它成立靠三件事：算子里没有任何非确定的来源、
   * 超越函数是我们自己的（不是宿主的 Math.exp）、以及编译时**没有开 -ffast-math**
   * （它允许浮点重结合）。三条里少一条这里就会红。
   */
  it('同一份输入跑两遍，逐位一致', () => {
    const mark = K.mark();
    const M = 64, N = 48, Kd = 32;
    const a = put(M * Kd, 101), b = put(Kd * N, 102);
    const c1 = zeros(M * N), c2 = zeros(M * N);
    K.fn.gemm_nn_f32(a, b, c1, M, N, Kd);
    K.fn.gemm_nn_f32(a, b, c2, M, N, Kd);
    expect(Array.from(K.f32(c1, M * N))).toEqual(Array.from(K.f32(c2, M * N)));
    K.reset(mark);
  });

  it('换一个实例，同一份输入还是同一个结果', () => {
    const other = createKernels(readFileSync(WASM));
    const M = 32, N = 24, Kd = 16;
    const build = (kk: Kernels) => {
      const a = kk.alloc(M * Kd * 4), b = kk.alloc(Kd * N * 4), c = kk.alloc(M * N * 4);
      const ra = rng(201), rb = rng(202);
      const av = kk.f32(a, M * Kd), bv = kk.f32(b, Kd * N);
      for (let i = 0; i < M * Kd; i++) av[i] = ra();
      for (let i = 0; i < Kd * N; i++) bv[i] = rb();
      kk.fn.gemm_nn_f32(a, b, c, M, N, Kd);
      return Array.from(kk.f32(c, M * N));
    };
    const mark = K.mark();
    expect(build(K)).toEqual(build(other));
    K.reset(mark);
  });
});

describe('吞吐量（只记录，不断言）', () => {
  it('sgemm 的 GFLOP/s', () => {
    const mark = K.mark();
    const M = 512, N = 256, Kd = 256;
    const a = put(M * Kd, 301), b = put(Kd * N, 302), c = zeros(M * N);
    K.fn.gemm_nn_f32(a, b, c, M, N, Kd);
    const reps = 10;
    const t0 = Date.now();
    for (let i = 0; i < reps; i++) K.fn.gemm_nn_f32(a, b, c, M, N, Kd);
    const sec = (Date.now() - t0) / 1000;
    const gflops = (2 * M * N * Kd * reps) / 1e9 / sec;
    // 机器不同数不同，所以不断言具体值 —— 只要不是慢到离谱（说明 SIMD 没生效）
    console.log(`  sgemm ${M}x${N}x${Kd}: ${gflops.toFixed(1)} GFLOP/s`);
    expect(gflops).toBeGreaterThan(2);
    K.reset(mark);
  });
});

describe('装载路径：同步与异步', () => {
  /*
   * 浏览器主线程禁止同步编译大于 4KB 的 wasm buffer，而我们的产物是 37KB。
   * Node 没有这条限制，所以这条用例**验不出**那个问题 —— 它只保证异步那条路
   * 真的存在、真的能用，免得将来有人顺手把它删了。
   * 真正的防线是 index.ts 里那段注释与 loadKernelsFromUrl 的实现。
   */
  it('异步装载出来的实例与同步的行为一致', async () => {
    const other = await createKernelsAsync(readFileSync(WASM));
    expect(other.fn.ll_abi_version()).toBe(KERNEL_ABI_VERSION);

    const M = 16, N = 12, Kd = 8;
    const run = (kk: Kernels) => {
      const a = kk.alloc(M * Kd * 4), b = kk.alloc(Kd * N * 4), c = kk.alloc(M * N * 4);
      const ra = rng(401), rb = rng(402);
      const av = kk.f32(a, M * Kd), bv = kk.f32(b, Kd * N);
      for (let i = 0; i < M * Kd; i++) av[i] = ra();
      for (let i = 0; i < Kd * N; i++) bv[i] = rb();
      kk.fn.gemm_nn_f32(a, b, c, M, N, Kd);
      return Array.from(kk.f32(c, M * N));
    };
    const mark = K.mark();
    expect(run(other)).toEqual(run(K));
    K.reset(mark);
  });

  it('堆基址是 16 对齐的 —— 不然 f64 视图建不出来', () => {
    const mark = K.mark();
    K.alloc(1);                       // 故意分一个奇数字节数
    const off = K.alloc(8);
    expect(() => K.f64(off, 1)).not.toThrow();
    K.reset(mark);
  });
});
