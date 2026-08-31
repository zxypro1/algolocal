'use strict';
const F64 = !!process.env.F64;
const FA = F64 ? Float64Array : Float32Array;
const fr = F64 ? ((x) => x) : Math.fround;
/*
 * 一个真的能训练的 decoder-only transformer，纯 JS + Float32Array，手写反向。
 * 架构按 2026 年的主流：pre-norm RMSNorm + RoPE + GQA + SwiGLU + 权重共享。
 * 目的是量三件事：每步耗时、loss 真的降不降、两次跑是不是逐位一致。
 */

//// ---------- 线性代数 ----------
// C[M,N] = A[M,K] @ B[K,N]，4 行寄存器分块
function matmul(A, B, C, M, N, K) {
  C.fill(0);
  for (let i0 = 0; i0 < M; i0 += 4) {
    const im = Math.min(4, M - i0);
    if (im === 4) {
      const c0 = i0 * N, c1 = c0 + N, c2 = c1 + N, c3 = c2 + N;
      const r0 = i0 * K, r1 = r0 + K, r2 = r1 + K, r3 = r2 + K;
      for (let k = 0; k < K; k++) {
        const a0 = A[r0 + k], a1 = A[r1 + k], a2 = A[r2 + k], a3 = A[r3 + k], bk = k * N;
        for (let j = 0; j < N; j++) {
          const b = B[bk + j];
          C[c0 + j] += a0 * b; C[c1 + j] += a1 * b; C[c2 + j] += a2 * b; C[c3 + j] += a3 * b;
        }
      }
    } else {
      for (let ii = 0; ii < im; ii++) {
        const ci = (i0 + ii) * N, ri = (i0 + ii) * K;
        for (let k = 0; k < K; k++) {
          const a = A[ri + k], bk = k * N;
          for (let j = 0; j < N; j++) C[ci + j] += a * B[bk + j];
        }
      }
    }
  }
}
// C[K,N] += A[M,K]^T @ B[M,N]   （权重梯度：dW = X^T dY，累加）
function matmulTN_acc(A, B, C, M, N, K) {
  for (let m = 0; m < M; m++) {
    const am = m * K, bm = m * N;
    for (let k = 0; k < K; k++) {
      const a = A[am + k];
      if (a === 0) continue;
      const ck = k * N;
      for (let j = 0; j < N; j++) C[ck + j] += a * B[bm + j];
    }
  }
}
// C[M,K] = A[M,N] @ B[K,N]^T    （输入梯度：dX = dY W^T）
function matmulNT(A, B, C, M, K, N) {
  C.fill(0);
  for (let m = 0; m < M; m++) {
    const am = m * N, cm = m * K;
    for (let k = 0; k < K; k++) {
      const bk = k * N; let acc = 0;
      for (let j = 0; j < N; j++) acc += A[am + j] * B[bk + j];
      C[cm + k] = acc;
    }
  }
}

let K = { matmul, matmulNT, matmulTN_acc };
function setKernels(k) { K = k; }

//// ---------- 确定性 RNG ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function randn(r) { // Box-Muller，确定性
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

//// ---------- 模型 ----------
class Model {
  constructor(cfg) {
    this.cfg = cfg;
    const { vocab, d, nLayer, nHead, nKvHead, hidden } = cfg;
    const hd = d / nHead;
    this.hd = hd;
    const r = rng(cfg.seed || 1337);
    const p = [];
    const mk = (rows, cols, std) => {
      const a = new FA(rows * cols);
      for (let i = 0; i < a.length; i++) a[i] = fr(randn(r) * std);
      p.push(a); return a;
    };
    const ones = (n) => { const a = new FA(n).fill(1); p.push(a); return a; };
    const s = 0.02;
    this.emb = mk(vocab, d, s);              // 词嵌入，与 lm_head 共享
    this.layers = [];
    for (let i = 0; i < nLayer; i++) {
      this.layers.push({
        g1: ones(d),
        wq: mk(d, nHead * hd, s), wk: mk(d, nKvHead * hd, s), wv: mk(d, nKvHead * hd, s),
        wo: mk(nHead * hd, d, s / Math.sqrt(2 * nLayer)),
        g2: ones(d),
        wg: mk(d, hidden, s), wu: mk(d, hidden, s),
        wd: mk(hidden, d, s / Math.sqrt(2 * nLayer)),
      });
    }
    this.gf = ones(d);
    this.params = p;
    this.grads = p.map((a) => new FA(a.length));
    this.m = p.map((a) => new FA(a.length));
    this.v = p.map((a) => new FA(a.length));
    this.nParams = p.reduce((n, a) => n + a.length, 0);
    // RoPE 表
    const S = cfg.block;
    this.cos = new FA(S * hd / 2); this.sin = new FA(S * hd / 2);
    for (let pos = 0; pos < S; pos++) {
      for (let i = 0; i < hd / 2; i++) {
        const th = pos / Math.pow(cfg.ropeBase || 10000, (2 * i) / hd);
        this.cos[pos * hd / 2 + i] = fr(Math.cos(th));
        this.sin[pos * hd / 2 + i] = fr(Math.sin(th));
      }
    }
    this.buf = null;
  }

  alloc(B) {
    const { d, nLayer, nHead, nKvHead, hidden, block: S, vocab } = this.cfg, hd = this.hd;
    const T = B * S;
    const f = (n) => new FA(n);
    this.buf = {
      T, B,
      x: f(T * d), xin: [], post: [], h1: [], q: [], k: [], v: [], att: [], ao: [],
      h2: [], gate: [], up: [], act: [],
      inv1: [], inv2: [], probs: [],
      logits: f(T * vocab), dlogits: f(T * vocab),
      xf: f(T * d), invf: f(T), hf: f(T * d),
      tmp: f(T * Math.max(d, hidden, nHead * hd)), tmp2: f(T * Math.max(d, hidden)),
      dx: f(T * d), dy: f(T * d),
    };
    for (let l = 0; l < nLayer; l++) {
      this.buf.xin.push(f(T * d)); this.buf.h1.push(f(T * d)); this.buf.inv1.push(f(T));
      this.buf.q.push(f(T * nHead * hd)); this.buf.k.push(f(T * nKvHead * hd)); this.buf.v.push(f(T * nKvHead * hd));
      this.buf.att.push(f(B * nHead * S * S)); this.buf.ao.push(f(T * nHead * hd));
      this.buf.h2.push(f(T * d)); this.buf.inv2.push(f(T)); this.buf.post.push(f(T * d));
      this.buf.gate.push(f(T * hidden)); this.buf.up.push(f(T * hidden)); this.buf.act.push(f(T * hidden));
    }
    return this.buf;
  }

  /** 前向 + loss。idx / tgt 是 [B*S] 的 Int32Array */
  forward(idx, tgt, B) {
    const cfg = this.cfg, { d, nLayer, nHead, nKvHead, hidden, block: S, vocab } = cfg, hd = this.hd;
    const T = B * S, b = this.buf;
    // 嵌入
    for (let t = 0; t < T; t++) {
      const src = idx[t] * d, dst = t * d;
      for (let i = 0; i < d; i++) b.x[dst + i] = this.emb[src + i];
    }
    for (let l = 0; l < nLayer; l++) {
      const L = this.layers[l];
      b.xin[l].set(b.x);
      rmsnorm(b.x, L.g1, b.h1[l], b.inv1[l], T, d);
      K.matmul(b.h1[l], L.wq, b.q[l], T, nHead * hd, d);
      K.matmul(b.h1[l], L.wk, b.k[l], T, nKvHead * hd, d);
      K.matmul(b.h1[l], L.wv, b.v[l], T, nKvHead * hd, d);
      rope(b.q[l], this.cos, this.sin, B, S, nHead, hd);
      rope(b.k[l], this.cos, this.sin, B, S, nKvHead, hd);
      attnFwd(b.q[l], b.k[l], b.v[l], b.att[l], b.ao[l], B, S, nHead, nKvHead, hd);
      K.matmul(b.ao[l], L.wo, b.tmp, T, d, nHead * hd);
      for (let i = 0; i < T * d; i++) b.x[i] += b.tmp[i];
      b.post[l].set(b.x);
      rmsnorm(b.x, L.g2, b.h2[l], b.inv2[l], T, d);
      K.matmul(b.h2[l], L.wg, b.gate[l], T, hidden, d);
      K.matmul(b.h2[l], L.wu, b.up[l], T, hidden, d);
      const g = b.gate[l], u = b.up[l], a = b.act[l];
      for (let i = 0; i < T * hidden; i++) { const z = g[i]; a[i] = fr((z / (1 + Math.exp(-z))) * u[i]); }
      K.matmul(a, L.wd, b.tmp, T, d, hidden);
      for (let i = 0; i < T * d; i++) b.x[i] += b.tmp[i];
    }
    b.xf.set(b.x);
    rmsnorm(b.xf, this.gf, b.hf, b.invf, T, d);
    K.matmulNT(b.hf, this.emb, b.logits, T, vocab, d); // logits = hf @ emb^T
    // 交叉熵
    let loss = 0;
    for (let t = 0; t < T; t++) {
      const o = t * vocab; let mx = -Infinity;
      for (let j = 0; j < vocab; j++) if (b.logits[o + j] > mx) mx = b.logits[o + j];
      let sum = 0;
      for (let j = 0; j < vocab; j++) { const e = Math.exp(b.logits[o + j] - mx); b.dlogits[o + j] = e; sum += e; }
      const inv = 1 / sum;
      for (let j = 0; j < vocab; j++) b.dlogits[o + j] *= inv;
      loss += -Math.log(Math.max(b.dlogits[o + tgt[t]], 1e-30));
    }
    return loss / T;
  }

  /** 反向。假定 forward 刚跑过 */
  backward(idx, tgt, B) {
    const cfg = this.cfg, { d, nLayer, nHead, nKvHead, hidden, block: S, vocab } = cfg, hd = this.hd;
    const T = B * S, b = this.buf;
    const G = this.gradMap();
    const scale = 1 / T;
    for (let t = 0; t < T; t++) {
      const o = t * vocab;
      for (let j = 0; j < vocab; j++) b.dlogits[o + j] *= scale;
      b.dlogits[o + tgt[t]] -= scale;
    }
    // logits = hf @ emb^T  →  d(hf) = dlogits @ emb ; d(emb) += dlogits^T @ hf
    K.matmul(b.dlogits, this.emb, b.dy, T, d, vocab);
    K.matmulTN_acc(b.dlogits, b.hf, G.emb, T, d, vocab);
    rmsnormBwd(b.dy, b.xf, this.gf, b.invf, G.gf, b.dx, T, d);

    for (let l = nLayer - 1; l >= 0; l--) {
      const L = this.layers[l], g = G.layers[l];
      // --- MLP 残差 ---
      // dx 同时是残差主干的梯度；先算 MLP 分支
      K.matmulTN_acc(b.act[l], b.dx, g.wd, T, d, hidden);      // dWd
      K.matmulNT(b.dx, L.wd, b.tmp, T, hidden, d);             // d(act)
      const ga = b.gate[l], ua = b.up[l], dg = b.tmp2;
      for (let i = 0; i < T * hidden; i++) {
        const z = ga[i], sg = 1 / (1 + Math.exp(-z)), sl = z * sg;
        const da = b.tmp[i];
        dg[i] = da * ua[i] * (sg * (1 + z * (1 - sg)));      // d(gate)
        b.tmp[i] = da * sl;                                   // d(up)（就地覆盖）
      }
      K.matmulTN_acc(b.h2[l], dg, g.wg, T, hidden, d);
      K.matmulTN_acc(b.h2[l], b.tmp, g.wu, T, hidden, d);
      K.matmulNT(dg, L.wg, b.dy, T, d, hidden);
      const dh2 = b.dy;
      { const t2 = new FA(T * d); K.matmulNT(b.tmp, L.wu, t2, T, d, hidden); for (let i = 0; i < T * d; i++) dh2[i] += t2[i]; }
      // rmsnorm2 的输入是「注意力后的 x」，它存在哪？—— 我们没存，用 xin[l] 重建代价高，
      // 所以 forward 里把它留在 h2 的输入上：这里用 postAttn[l]
      rmsnormBwd(dh2, b.post[l], L.g2, b.inv2[l], g.g2, b.tmp, T, d);
      for (let i = 0; i < T * d; i++) b.dx[i] += b.tmp[i];

      // --- 注意力残差 ---
      K.matmulTN_acc(b.ao[l], b.dx, g.wo, T, d, nHead * hd);
      K.matmulNT(b.dx, L.wo, b.tmp, T, nHead * hd, d);
      const dq = new FA(T * nHead * hd), dk = new FA(T * nKvHead * hd), dv = new FA(T * nKvHead * hd);
      attnBwd(b.tmp, b.q[l], b.k[l], b.v[l], b.att[l], dq, dk, dv, B, S, nHead, nKvHead, hd);
      ropeBwd(dq, this.cos, this.sin, B, S, nHead, hd);
      ropeBwd(dk, this.cos, this.sin, B, S, nKvHead, hd);
      K.matmulTN_acc(b.h1[l], dq, g.wq, T, nHead * hd, d);
      K.matmulTN_acc(b.h1[l], dk, g.wk, T, nKvHead * hd, d);
      K.matmulTN_acc(b.h1[l], dv, g.wv, T, nKvHead * hd, d);
      const dh1 = new FA(T * d), t3 = new FA(T * d);
      K.matmulNT(dq, L.wq, dh1, T, d, nHead * hd);
      K.matmulNT(dk, L.wk, t3, T, d, nKvHead * hd); for (let i = 0; i < T * d; i++) dh1[i] += t3[i];
      K.matmulNT(dv, L.wv, t3, T, d, nKvHead * hd); for (let i = 0; i < T * d; i++) dh1[i] += t3[i];
      rmsnormBwd(dh1, b.xin[l], L.g1, b.inv1[l], g.g1, b.tmp, T, d);
      for (let i = 0; i < T * d; i++) b.dx[i] += b.tmp[i];
    }
    // 嵌入
    for (let t = 0; t < T; t++) {
      const dst = idx[t] * d, src = t * d;
      for (let i = 0; i < d; i++) G.emb[dst + i] += b.dx[src + i];
    }
  }

  gradMap() {
    let i = 0;
    const g = this.grads;
    const out = { emb: g[i++], layers: [] };
    for (let l = 0; l < this.cfg.nLayer; l++) {
      out.layers.push({ g1: g[i++], wq: g[i++], wk: g[i++], wv: g[i++], wo: g[i++], g2: g[i++], wg: g[i++], wu: g[i++], wd: g[i++] });
    }
    out.gf = g[i++];
    return out;
  }
  zeroGrad() { for (const a of this.grads) a.fill(0); }

  gradNorm() {
    let s = 0;
    for (const a of this.grads) for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s);
  }

  step(lr, t, { beta1 = 0.9, beta2 = 0.95, eps = 1e-8, wd = 0.1, clip = 1.0 } = {}) {
    const gn = this.gradNorm();
    const cs = gn > clip ? clip / gn : 1;
    const bc1 = 1 - Math.pow(beta1, t), bc2 = 1 - Math.pow(beta2, t);
    for (let p = 0; p < this.params.length; p++) {
      const w = this.params[p], gr = this.grads[p], m = this.m[p], v = this.v[p];
      const decay = w.length > this.cfg.d ? wd : 0; // 增益（1 维）不做权重衰减
      for (let i = 0; i < w.length; i++) {
        const gi = gr[i] * cs;
        m[i] = fr(beta1 * m[i] + (1 - beta1) * gi);
        v[i] = fr(beta2 * v[i] + (1 - beta2) * gi * gi);
        const mh = m[i] / bc1, vh = v[i] / bc2;
        w[i] = fr(w[i] - lr * (mh / (Math.sqrt(vh) + eps) + decay * w[i]));
      }
    }
    return gn;
  }
}

//// ---------- 算子 ----------
function rmsnorm(x, g, out, inv, T, d) {
  for (let t = 0; t < T; t++) {
    const o = t * d; let s = 0;
    for (let i = 0; i < d; i++) s += x[o + i] * x[o + i];
    const r = 1 / Math.sqrt(s / d + 1e-5);
    inv[t] = r;
    for (let i = 0; i < d; i++) out[o + i] = fr(x[o + i] * r * g[i]);
  }
}
function rmsnormBwd(dout, x, g, inv, dg, dx, T, d) {
  for (let t = 0; t < T; t++) {
    const o = t * d, r = inv[t];
    let dot = 0;
    for (let i = 0; i < d; i++) { const xi = x[o + i]; dg[i] += dout[o + i] * xi * r; dot += dout[o + i] * g[i] * xi; }
    const c = dot * r * r * r / d;
    for (let i = 0; i < d; i++) dx[o + i] = fr(dout[o + i] * g[i] * r - x[o + i] * c);
  }
}
function rope(x, cos, sin, B, S, H, hd) {
  const half = hd / 2;
  for (let b = 0; b < B; b++) for (let s = 0; s < S; s++) {
    const base = (b * S + s) * H * hd, co = s * half;
    for (let h = 0; h < H; h++) {
      const o = base + h * hd;
      for (let i = 0; i < half; i++) {
        const a = x[o + i], c = x[o + i + half], cc = cos[co + i], ss = sin[co + i];
        x[o + i] = fr(a * cc - c * ss);
        x[o + i + half] = fr(a * ss + c * cc);
      }
    }
  }
}
function ropeBwd(dx, cos, sin, B, S, H, hd) {
  const half = hd / 2;
  for (let b = 0; b < B; b++) for (let s = 0; s < S; s++) {
    const base = (b * S + s) * H * hd, co = s * half;
    for (let h = 0; h < H; h++) {
      const o = base + h * hd;
      for (let i = 0; i < half; i++) {
        const a = dx[o + i], c = dx[o + i + half], cc = cos[co + i], ss = sin[co + i];
        dx[o + i] = fr(a * cc + c * ss);
        dx[o + i + half] = fr(-a * ss + c * cc);
      }
    }
  }
}
function attnFwd(q, k, v, att, out, B, S, H, KV, hd) {
  const rep = H / KV, sc = 1 / Math.sqrt(hd);
  out.fill(0);
  for (let b = 0; b < B; b++) for (let h = 0; h < H; h++) {
    const kh = (h / rep) | 0;
    for (let i = 0; i < S; i++) {
      const qo = ((b * S + i) * H + h) * hd, ao = ((b * H + h) * S + i) * S;
      let mx = -Infinity;
      for (let j = 0; j <= i; j++) {
        const ko = ((b * S + j) * KV + kh) * hd; let s = 0;
        for (let x = 0; x < hd; x++) s += q[qo + x] * k[ko + x];
        s *= sc; att[ao + j] = s; if (s > mx) mx = s;
      }
      let sum = 0;
      for (let j = 0; j <= i; j++) { const e = Math.exp(att[ao + j] - mx); att[ao + j] = e; sum += e; }
      const inv = 1 / sum;
      const oo = ((b * S + i) * H + h) * hd;
      for (let j = 0; j <= i; j++) {
        const p = fr(att[ao + j] * inv); att[ao + j] = p;
        const vo = ((b * S + j) * KV + kh) * hd;
        for (let x = 0; x < hd; x++) out[oo + x] += p * v[vo + x];
      }
      for (let j = i + 1; j < S; j++) att[ao + j] = 0;
    }
  }
}
function attnBwd(dout, q, k, v, att, dq, dk, dv, B, S, H, KV, hd) {
  const rep = H / KV, sc = 1 / Math.sqrt(hd);
  const dp = new FA(S);
  for (let b = 0; b < B; b++) for (let h = 0; h < H; h++) {
    const kh = (h / rep) | 0;
    for (let i = 0; i < S; i++) {
      const oo = ((b * S + i) * H + h) * hd, ao = ((b * H + h) * S + i) * S, qo = oo;
      let dot = 0;
      for (let j = 0; j <= i; j++) {
        const vo = ((b * S + j) * KV + kh) * hd; let s = 0;
        for (let x = 0; x < hd; x++) { s += dout[oo + x] * v[vo + x]; dv[vo + x] += att[ao + j] * dout[oo + x]; }
        dp[j] = s; dot += s * att[ao + j];
      }
      for (let j = 0; j <= i; j++) {
        const ds = (dp[j] - dot) * att[ao + j] * sc;
        const ko = ((b * S + j) * KV + kh) * hd;
        for (let x = 0; x < hd; x++) { dq[qo + x] += ds * k[ko + x]; dk[ko + x] += ds * q[qo + x]; }
      }
    }
  }
}

module.exports = { Model, setKernels, matmul, matmulNT, matmulTN_acc, rng, randn, rmsnorm };
