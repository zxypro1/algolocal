/*
 * 算子实现，按标量类型模板化。
 *
 * kernels.c 把这个文件 include 两遍：一遍 float（导出 `*_f32`），
 * 一遍 double（导出 `*_f64`）。
 *
 * **为什么非要有 f64 那一份**：梯度检验必须在双精度里做。
 * 原型实测（design/llmproto/gradcheck.js）—— 同一份正确的反向，
 * fp32 下最差相对误差 4.99e-2（看起来像写错了），fp64 下 6.79e-4。
 * fp32 的数值噪声足以淹没中心差分，所以不是「顺便也支持一下」，
 * 而是这条判定成不成立的前提。
 *
 * 两份必须是**同一套算法**，否则梯度检验验的就不是 fp32 那条路径了。
 * 所以这里是一份源码、两次实例化，而不是各写各的。
 *
 * SIMD 只给 f32：wasm 的 v128 装 4 个 float / 2 个 double，
 * f32 的收益是实测的（原型里 sgemm 5.0 → 42 GFLOP/s），
 * 而 f64 那条路径只在梯度检验里跑、模型极小，先要正确不要快。
 */

/* 由 kernels.c 定义：SCALAR / SUF / LL_SIMD */
#define LL_CAT2(a, b) a##_##b
#define LL_CAT(a, b) LL_CAT2(a, b)
#define FN(name) LL_CAT(name, SUF)

#define P(off) ((SCALAR *)(ll_mem + (off)))
#define CP(off) ((const SCALAR *)(ll_mem + (off)))

/* ---------------------------------------------------------------- 矩阵乘 */

/*
 * C[M,N] = A[M,K] @ B[K,N]
 *
 * i-k-j + 4 行展开：B 沿 j 连续读、C 沿 j 连续写，两边都能向量化，
 * 而 A 的那个元素在整条 j 循环里是常数（splat 一次）。
 * 朴素 i-j-k 的内层要沿 B 的列跳着走，实测慢 1.8 倍。
 */
void FN(gemm_nn)(int a, int b, int c, int M, int N, int K) {
  SCALAR *C = P(c);
  const SCALAR *A = CP(a), *B = CP(b);
  for (int i = 0; i < M * N; i++) C[i] = (SCALAR)0;

  int i = 0;
  for (; i + 4 <= M; i += 4) {
    SCALAR *c0 = C + (i + 0) * N, *c1 = C + (i + 1) * N;
    SCALAR *c2 = C + (i + 2) * N, *c3 = C + (i + 3) * N;
    const SCALAR *a0 = A + (i + 0) * K, *a1 = A + (i + 1) * K;
    const SCALAR *a2 = A + (i + 2) * K, *a3 = A + (i + 3) * K;
    for (int k = 0; k < K; k++) {
      const SCALAR *bk = B + k * N;
      SCALAR v0 = a0[k], v1 = a1[k], v2 = a2[k], v3 = a3[k];
#ifdef LL_SIMD
      int j = 0;
      LL_VEC s0 = LL_SPLAT(v0), s1 = LL_SPLAT(v1);
      LL_VEC s2 = LL_SPLAT(v2), s3 = LL_SPLAT(v3);
      for (; j + 4 <= N; j += 4) {
        LL_VEC bv = LL_LOAD(bk + j);
        LL_STORE(c0 + j, LL_LOAD(c0 + j) + s0 * bv);
        LL_STORE(c1 + j, LL_LOAD(c1 + j) + s1 * bv);
        LL_STORE(c2 + j, LL_LOAD(c2 + j) + s2 * bv);
        LL_STORE(c3 + j, LL_LOAD(c3 + j) + s3 * bv);
      }
      for (; j < N; j++) {
        SCALAR bv = bk[j];
        c0[j] += v0 * bv; c1[j] += v1 * bv; c2[j] += v2 * bv; c3[j] += v3 * bv;
      }
#else
      for (int j = 0; j < N; j++) {
        SCALAR bv = bk[j];
        c0[j] += v0 * bv; c1[j] += v1 * bv; c2[j] += v2 * bv; c3[j] += v3 * bv;
      }
#endif
    }
  }
  for (; i < M; i++) {
    SCALAR *ci = C + i * N;
    const SCALAR *ai = A + i * K;
    for (int k = 0; k < K; k++) {
      SCALAR v = ai[k];
      const SCALAR *bk = B + k * N;
      for (int j = 0; j < N; j++) ci[j] += v * bk[j];
    }
  }
}

/*
 * C[K,N] += A[M,K]^T @ B[M,N]   —— 权重梯度 dW = X^T dY
 *
 * 累加而不是覆盖：一个权重在一次反向里可能被多处用到（比如权重共享的嵌入），
 * 各处的贡献要加起来。调用方负责先清零。
 */
void FN(gemm_tn_acc)(int a, int b, int c, int M, int N, int K) {
  SCALAR *C = P(c);
  const SCALAR *A = CP(a), *B = CP(b);
  for (int m = 0; m < M; m++) {
    const SCALAR *am = A + m * K, *bm = B + m * N;
    for (int k = 0; k < K; k++) {
      SCALAR v = am[k];
      if (v == (SCALAR)0) continue;
      SCALAR *ck = C + k * N;
#ifdef LL_SIMD
      int j = 0;
      LL_VEC s = LL_SPLAT(v);
      for (; j + 4 <= N; j += 4) LL_STORE(ck + j, LL_LOAD(ck + j) + s * LL_LOAD(bm + j));
      for (; j < N; j++) ck[j] += v * bm[j];
#else
      for (int j = 0; j < N; j++) ck[j] += v * bm[j];
#endif
    }
  }
}

/*
 * C[M,K] = A[M,N] @ B[K,N]^T   —— 输入梯度 dX = dY W^T
 *
 * 沿 N 做点积，A 与 B 两边都连续，所以是「乘累加 + 最后横向求和」。
 */
void FN(gemm_nt)(int a, int b, int c, int M, int K, int N) {
  SCALAR *C = P(c);
  const SCALAR *A = CP(a), *B = CP(b);
  for (int m = 0; m < M; m++) {
    const SCALAR *am = A + m * N;
    SCALAR *cm = C + m * K;
    for (int k = 0; k < K; k++) {
      const SCALAR *bk = B + k * N;
      SCALAR acc = (SCALAR)0;
#ifdef LL_SIMD
      int j = 0;
      LL_VEC v = LL_SPLAT((SCALAR)0);
      for (; j + 4 <= N; j += 4) v += LL_LOAD(am + j) * LL_LOAD(bk + j);
      acc = (v[0] + v[1]) + (v[2] + v[3]);
      for (; j < N; j++) acc += am[j] * bk[j];
#else
      for (int j = 0; j < N; j++) acc += am[j] * bk[j];
#endif
      cm[k] = acc;
    }
  }
}

/* ---------------------------------------------------------------- 逐元素 */

void FN(add_inplace)(int a, int b, int n) {
  SCALAR *x = P(a); const SCALAR *y = CP(b);
  for (int i = 0; i < n; i++) x[i] += y[i];
}

void FN(scale_inplace)(int a, double s, int n) {
  SCALAR *x = P(a);
  for (int i = 0; i < n; i++) x[i] = (SCALAR)(x[i] * (SCALAR)s);
}

void FN(fill)(int a, double v, int n) {
  SCALAR *x = P(a);
  for (int i = 0; i < n; i++) x[i] = (SCALAR)v;
}

void FN(copy)(int dst, int src, int n) {
  SCALAR *d = P(dst); const SCALAR *s = CP(src);
  for (int i = 0; i < n; i++) d[i] = s[i];
}

double FN(sumsq)(int a, int n) {
  const SCALAR *x = CP(a);
  double s = 0.0;
  for (int i = 0; i < n; i++) s += (double)x[i] * (double)x[i];
  return s;
}

/* ---------------------------------------------------------------- RMSNorm */

/* out = x / sqrt(mean(x²) + eps) * g；顺带把 1/sqrt(...) 存进 inv 给反向用 */
void FN(rmsnorm_fwd)(int x_, int g_, int out_, int inv_, int rows, int d, double eps) {
  const SCALAR *x = CP(x_), *g = CP(g_);
  SCALAR *out = P(out_), *inv = P(inv_);
  for (int t = 0; t < rows; t++) {
    const SCALAR *xr = x + (long)t * d;
    SCALAR *o = out + (long)t * d;
    double s = 0.0;
    for (int i = 0; i < d; i++) s += (double)xr[i] * (double)xr[i];
    SCALAR r = (SCALAR)(1.0 / ll_sqrt(s / (double)d + eps));
    inv[t] = r;
    for (int i = 0; i < d; i++) o[i] = xr[i] * r * g[i];
  }
}

/*
 * dx_i = dout_i·g_i·r − x_i·r³·(Σ_j dout_j·g_j·x_j)/d
 *
 * 第二项是 r 对 x_i 的依赖带来的 —— 漏掉它，前向对、loss 也会降，
 * 只有梯度检验抓得到。这正是第 11 关那条门槛存在的理由。
 */
void FN(rmsnorm_bwd)(int dout_, int x_, int g_, int inv_, int dg_, int dx_, int rows, int d) {
  const SCALAR *dout = CP(dout_), *x = CP(x_), *g = CP(g_), *inv = CP(inv_);
  SCALAR *dg = P(dg_), *dx = P(dx_);
  for (int t = 0; t < rows; t++) {
    const SCALAR *dr = dout + (long)t * d, *xr = x + (long)t * d;
    SCALAR *dxr = dx + (long)t * d;
    SCALAR r = inv[t];
    double dot = 0.0;
    for (int i = 0; i < d; i++) {
      dg[i] += dr[i] * xr[i] * r;
      dot += (double)dr[i] * (double)g[i] * (double)xr[i];
    }
    SCALAR c = (SCALAR)(dot * (double)r * (double)r * (double)r / (double)d);
    for (int i = 0; i < d; i++) dxr[i] = dr[i] * g[i] * r - xr[i] * c;
  }
}

/* ---------------------------------------------------------------- SwiGLU */

/* out = silu(gate) * up，silu(z) = z·σ(z) */
void FN(swiglu_fwd)(int gate_, int up_, int out_, int n) {
  const SCALAR *gate = CP(gate_), *up = CP(up_);
  SCALAR *out = P(out_);
  for (int i = 0; i < n; i++) {
    double z = (double)gate[i];
    out[i] = (SCALAR)(z * ll_sigmoid(z) * (double)up[i]);
  }
}

/* d(silu)/dz = σ(z)·(1 + z·(1−σ(z))) */
void FN(swiglu_bwd)(int dout_, int gate_, int up_, int dgate_, int dup_, int n) {
  const SCALAR *dout = CP(dout_), *gate = CP(gate_), *up = CP(up_);
  SCALAR *dgate = P(dgate_), *dup = P(dup_);
  for (int i = 0; i < n; i++) {
    double z = (double)gate[i];
    double sg = ll_sigmoid(z);
    double sl = z * sg;
    double d = (double)dout[i];
    dgate[i] = (SCALAR)(d * (double)up[i] * (sg * (1.0 + z * (1.0 - sg))));
    dup[i] = (SCALAR)(d * sl);
  }
}

/* ---------------------------------------------------------------- RoPE */

/*
 * 就地把每个头的前后半维当成复数旋转。
 * x[i], x[i+hd/2] ← x[i]·cos − x[i+hd/2]·sin, x[i]·sin + x[i+hd/2]·cos
 */
void FN(rope_fwd)(int x_, int cos_, int sin_, int B, int S, int H, int hd) {
  SCALAR *x = P(x_);
  const SCALAR *cs = CP(cos_), *sn = CP(sin_);
  int half = hd / 2;
  for (int b = 0; b < B; b++)
    for (int s = 0; s < S; s++) {
      long base = ((long)b * S + s) * H * hd;
      const SCALAR *c = cs + (long)s * half, *n = sn + (long)s * half;
      for (int h = 0; h < H; h++) {
        SCALAR *o = x + base + (long)h * hd;
        for (int i = 0; i < half; i++) {
          SCALAR a = o[i], d = o[i + half];
          o[i] = a * c[i] - d * n[i];
          o[i + half] = a * n[i] + d * c[i];
        }
      }
    }
}

/* 旋转矩阵的转置就是转 −θ */
void FN(rope_bwd)(int dx_, int cos_, int sin_, int B, int S, int H, int hd) {
  SCALAR *dx = P(dx_);
  const SCALAR *cs = CP(cos_), *sn = CP(sin_);
  int half = hd / 2;
  for (int b = 0; b < B; b++)
    for (int s = 0; s < S; s++) {
      long base = ((long)b * S + s) * H * hd;
      const SCALAR *c = cs + (long)s * half, *n = sn + (long)s * half;
      for (int h = 0; h < H; h++) {
        SCALAR *o = dx + base + (long)h * hd;
        for (int i = 0; i < half; i++) {
          SCALAR a = o[i], d = o[i + half];
          o[i] = a * c[i] + d * n[i];
          o[i + half] = -a * n[i] + d * c[i];
        }
      }
    }
}

/* ---------------------------------------------------------------- 注意力 */

/*
 * 因果、支持 GQA（H 个查询头共享 KV 个键值头）。
 *
 * att 存归一化后的概率，反向要用。**它就是那块 O(S²) 的显存** ——
 * B=16/H=8/S=128 时每层 8.4MB，比模型本身还大。
 * 第 17 关的门槛读的是这个数，第 18 关（激活重算）要把它按下去。
 *
 * softmax 减最大值：不减的话 seq 一长 exp 就溢出成 inf，
 * 然后 inf/inf = NaN。第 12 关专门讲这件事。
 */
void FN(attn_fwd)(int q_, int k_, int v_, int att_, int out_,
                  int B, int S, int H, int KV, int hd) {
  const SCALAR *q = CP(q_), *k = CP(k_), *v = CP(v_);
  SCALAR *att = P(att_), *out = P(out_);
  int rep = H / KV;
  double sc = 1.0 / ll_sqrt((double)hd);

  for (long i = 0, n = (long)B * S * H * hd; i < n; i++) out[i] = (SCALAR)0;

  for (int b = 0; b < B; b++)
    for (int h = 0; h < H; h++) {
      int kh = h / rep;
      for (int i = 0; i < S; i++) {
        const SCALAR *qo = q + ((((long)b * S + i) * H) + h) * hd;
        SCALAR *ao = att + ((((long)b * H + h) * S) + i) * S;
        SCALAR *oo = out + ((((long)b * S + i) * H) + h) * hd;

        double mx = -1e308;
        for (int j = 0; j <= i; j++) {
          const SCALAR *ko = k + ((((long)b * S + j) * KV) + kh) * hd;
          double s = 0.0;
          for (int x = 0; x < hd; x++) s += (double)qo[x] * (double)ko[x];
          s *= sc;
          ao[j] = (SCALAR)s;
          if (s > mx) mx = s;
        }
        double sum = 0.0;
        for (int j = 0; j <= i; j++) {
          double e = ll_exp((double)ao[j] - mx);
          ao[j] = (SCALAR)e;
          sum += e;
        }
        double inv = 1.0 / sum;
        for (int j = 0; j <= i; j++) {
          SCALAR p = (SCALAR)((double)ao[j] * inv);
          ao[j] = p;
          const SCALAR *vo = v + ((((long)b * S + j) * KV) + kh) * hd;
          for (int x = 0; x < hd; x++) oo[x] += p * vo[x];
        }
        for (int j = i + 1; j < S; j++) ao[j] = (SCALAR)0;
      }
    }
}

/* softmax 的反向：ds_j = p_j·(dp_j − Σ_k p_k·dp_k) */
void FN(attn_bwd)(int dout_, int q_, int k_, int v_, int att_,
                  int dq_, int dk_, int dv_, int dp_,
                  int B, int S, int H, int KV, int hd) {
  const SCALAR *dout = CP(dout_), *q = CP(q_), *k = CP(k_), *v = CP(v_), *att = CP(att_);
  SCALAR *dq = P(dq_), *dk = P(dk_), *dv = P(dv_), *dp = P(dp_);
  int rep = H / KV;
  SCALAR sc = (SCALAR)(1.0 / ll_sqrt((double)hd));

  /* 三块梯度在这里清零：dv 在 i 循环里是累加的，调用方忘了清就会静默地把
     上一步的梯度加进来 —— 那种错误 loss 照降，只有梯度检验抓得到。 */
  for (long i = 0, n = (long)B * S * H * hd; i < n; i++) dq[i] = (SCALAR)0;
  for (long i = 0, n = (long)B * S * KV * hd; i < n; i++) { dk[i] = (SCALAR)0; dv[i] = (SCALAR)0; }

  for (int b = 0; b < B; b++)
    for (int h = 0; h < H; h++) {
      int kh = h / rep;
      for (int i = 0; i < S; i++) {
        long qi = ((((long)b * S + i) * H) + h) * hd;
        const SCALAR *oo = dout + qi;
        const SCALAR *ao = att + ((((long)b * H + h) * S) + i) * S;
        double dot = 0.0;
        for (int j = 0; j <= i; j++) {
          long vi = ((((long)b * S + j) * KV) + kh) * hd;
          double s = 0.0;
          for (int x = 0; x < hd; x++) {
            s += (double)oo[x] * (double)v[vi + x];
            dv[vi + x] += ao[j] * oo[x];
          }
          dp[j] = (SCALAR)s;
          dot += s * (double)ao[j];
        }
        for (int j = 0; j <= i; j++) {
          SCALAR ds = (SCALAR)(((double)dp[j] - dot) * (double)ao[j]) * sc;
          long ki = ((((long)b * S + j) * KV) + kh) * hd;
          for (int x = 0; x < hd; x++) {
            dq[qi + x] += ds * k[ki + x];
            dk[ki + x] += ds * q[qi + x];
          }
        }
      }
    }
}

/* ---------------------------------------------------------------- 分类头 */

/*
 * 行 softmax + 交叉熵。probs 写回概率（反向要用），返回**平均** loss。
 *
 * targets 是 i32 数组，不随 SCALAR 变，所以两份实例化读的是同一块内存。
 */
double FN(cross_entropy)(int logits_, int targets_, int probs_, int rows, int vocab) {
  const SCALAR *logits = CP(logits_);
  const int *tgt = (const int *)(ll_mem + targets_);
  SCALAR *probs = P(probs_);
  double loss = 0.0;
  for (int t = 0; t < rows; t++) {
    const SCALAR *lr = logits + (long)t * vocab;
    SCALAR *pr = probs + (long)t * vocab;
    double mx = -1e308;
    for (int j = 0; j < vocab; j++) if ((double)lr[j] > mx) mx = (double)lr[j];
    double sum = 0.0;
    for (int j = 0; j < vocab; j++) {
      double e = ll_exp((double)lr[j] - mx);
      pr[j] = (SCALAR)e;
      sum += e;
    }
    double inv = 1.0 / sum;
    for (int j = 0; j < vocab; j++) pr[j] = (SCALAR)((double)pr[j] * inv);
    double p = (double)pr[tgt[t]];
    loss += -ll_log(p < 1e-300 ? 1e-300 : p);
  }
  return loss / (double)rows;
}

/*
 * dlogits = (probs − onehot) · scale
 *
 * `mask_` 是 loss mask 的偏移，**传 -1 表示没有 mask**（0 是合法偏移，
 * 不能拿它当哨兵）。mask[t] == 0 的位置贡献 0 —— SFT 的 loss mask 走这里。
 * 第 22 关的门槛 `llm.loss.contributingPositions` 数的就是它。
 */
void FN(cross_entropy_bwd)(int probs_, int targets_, int mask_, int dlogits_,
                           int rows, int vocab, double scale) {
  const SCALAR *probs = CP(probs_);
  const int *tgt = (const int *)(ll_mem + targets_);
  const int *mask = mask_ >= 0 ? (const int *)(ll_mem + mask_) : 0;
  SCALAR *dl = P(dlogits_);
  for (int t = 0; t < rows; t++) {
    SCALAR *dr = dl + (long)t * vocab;
    const SCALAR *pr = probs + (long)t * vocab;
    if (mask && mask[t] == 0) {
      for (int j = 0; j < vocab; j++) dr[j] = (SCALAR)0;
      continue;
    }
    for (int j = 0; j < vocab; j++) dr[j] = (SCALAR)((double)pr[j] * scale);
    dr[tgt[t]] = (SCALAR)((double)dr[tgt[t]] - scale);
  }
}

/* ---------------------------------------------------------------- 嵌入 */

void FN(embed_fwd)(int table_, int idx_, int out_, int rows, int d) {
  const SCALAR *table = CP(table_);
  const int *idx = (const int *)(ll_mem + idx_);
  SCALAR *out = P(out_);
  for (int t = 0; t < rows; t++) {
    const SCALAR *src = table + (long)idx[t] * d;
    SCALAR *dst = out + (long)t * d;
    for (int i = 0; i < d; i++) dst[i] = src[i];
  }
}

/* 散射累加：同一个 token 在一个 batch 里出现多次，梯度要加起来 */
void FN(embed_bwd)(int dout_, int idx_, int dtable_, int rows, int d) {
  const SCALAR *dout = CP(dout_);
  const int *idx = (const int *)(ll_mem + idx_);
  SCALAR *dtable = P(dtable_);
  for (int t = 0; t < rows; t++) {
    SCALAR *dst = dtable + (long)idx[t] * d;
    const SCALAR *src = dout + (long)t * d;
    for (int i = 0; i < d; i++) dst[i] += src[i];
  }
}

/* ---------------------------------------------------------------- 优化器 */

/*
 * AdamW 的一步。
 *
 * 解耦的权重衰减：`decay` 直接乘在权重上，**不进动量** —— 这正是
 * AdamW 与「Adam + L2」的区别，也是第 12 关要考的那一点。
 * 偏差修正的分母 bc1 / bc2 由调用方算好传进来（它只依赖步数）。
 *
 * clip 是外面算完梯度范数之后传进来的缩放系数，1.0 表示没裁。
 */
void FN(adamw)(int w_, int g_, int m_, int v_, int n,
               double lr, double b1, double b2, double eps,
               double decay, double bc1, double bc2, double clip) {
  SCALAR *w = P(w_), *m = P(m_), *v = P(v_);
  const SCALAR *g = CP(g_);
  for (int i = 0; i < n; i++) {
    double gi = (double)g[i] * clip;
    double mi = b1 * (double)m[i] + (1.0 - b1) * gi;
    double vi = b2 * (double)v[i] + (1.0 - b2) * gi * gi;
    m[i] = (SCALAR)mi;
    v[i] = (SCALAR)vi;
    double mh = mi / bc1, vh = vi / bc2;
    w[i] = (SCALAR)((double)w[i] - lr * (mh / (ll_sqrt(vh) + eps) + decay * (double)w[i]));
  }
}

#undef FN
#undef LL_CAT
#undef LL_CAT2
#undef P
#undef CP
