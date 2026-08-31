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

/* -------------------------------------------------- 拆开的注意力（第 3–8 关） */

/*
 * `attn_fwd` 是**融合**的一整块。而第 3 关的全部内容就是「自己把注意力拼出来」，
 * 所以必须有拆开的三步：算分数 → softmax → 加权求和。
 *
 * 融合那份在第 3 关是被禁用的算子（`builtins.forbiddenCalls` 数得到），
 * 到第 8 关之后才放开 —— 那时它的意义变成「FlashAttention 式的融合实现」。
 *
 * 这三个算子还顺带解决了 KV cache：`Sq` 与 `Skv` 是分开的两个参数，
 * 训练时相等，解码时 `Sq=1`、`Skv=t+1`。**同一套算子，不用另写一条解码路径**
 * —— 而「解码和训练走的是不是同一段代码」正是真实推理引擎里最容易出错的地方。
 */

/**
 * scores[b,h,i,j] = scale · q[b,i,h,:] · k[b,j,kh,:]
 *
 * q 是 [B, Sq, H, hd]，k 是 [B, Skv, KV, hd]，out 是 [B, H, Sq, Skv]。
 * 这里**不做因果掩码** —— 掩码是 softmax 那一步的事，
 * 拆开是为了让学员看清「掩码作用在分数上，不是作用在输出上」。
 */
void FN(attn_scores_fwd)(int q_, int k_, int out_,
                         int B, int Sq, int Skv, int H, int KV, int hd, double scale) {
  const SCALAR *q = CP(q_), *k = CP(k_);
  SCALAR *out = P(out_);
  int rep = H / KV;
  for (int b = 0; b < B; b++)
    for (int h = 0; h < H; h++) {
      int kh = h / rep;
      for (int i = 0; i < Sq; i++) {
        const SCALAR *qo = q + ((((long)b * Sq + i) * H) + h) * hd;
        SCALAR *o = out + ((((long)b * H + h) * Sq) + i) * Skv;
        for (int j = 0; j < Skv; j++) {
          const SCALAR *ko = k + ((((long)b * Skv + j) * KV) + kh) * hd;
          double s = 0.0;
          for (int x = 0; x < hd; x++) s += (double)qo[x] * (double)ko[x];
          o[j] = (SCALAR)(s * scale);
        }
      }
    }
}

void FN(attn_scores_bwd)(int dout_, int q_, int k_, int dq_, int dk_,
                         int B, int Sq, int Skv, int H, int KV, int hd, double scale) {
  const SCALAR *dout = CP(dout_), *q = CP(q_), *k = CP(k_);
  SCALAR *dq = P(dq_), *dk = P(dk_);
  int rep = H / KV;
  for (long i = 0, n = (long)B * Sq * H * hd; i < n; i++) dq[i] = (SCALAR)0;
  for (long i = 0, n = (long)B * Skv * KV * hd; i < n; i++) dk[i] = (SCALAR)0;

  for (int b = 0; b < B; b++)
    for (int h = 0; h < H; h++) {
      int kh = h / rep;
      for (int i = 0; i < Sq; i++) {
        long qi = ((((long)b * Sq + i) * H) + h) * hd;
        const SCALAR *d = dout + ((((long)b * H + h) * Sq) + i) * Skv;
        for (int j = 0; j < Skv; j++) {
          SCALAR g = (SCALAR)((double)d[j] * scale);
          if (g == (SCALAR)0) continue;
          long ki = ((((long)b * Skv + j) * KV) + kh) * hd;
          for (int x = 0; x < hd; x++) {
            dq[qi + x] += g * k[ki + x];
            dk[ki + x] += g * q[qi + x];
          }
        }
      }
    }
}

/**
 * out[b,i,h,:] = Σ_j p[b,h,i,j] · v[b,j,kh,:]
 *
 * p 是 [B, H, Sq, Skv]（softmax 之后的概率），v 是 [B, Skv, KV, hd]。
 */
void FN(attn_apply_fwd)(int p_, int v_, int out_,
                        int B, int Sq, int Skv, int H, int KV, int hd) {
  const SCALAR *p = CP(p_), *v = CP(v_);
  SCALAR *out = P(out_);
  int rep = H / KV;
  for (long i = 0, n = (long)B * Sq * H * hd; i < n; i++) out[i] = (SCALAR)0;

  for (int b = 0; b < B; b++)
    for (int h = 0; h < H; h++) {
      int kh = h / rep;
      for (int i = 0; i < Sq; i++) {
        const SCALAR *pr = p + ((((long)b * H + h) * Sq) + i) * Skv;
        SCALAR *oo = out + ((((long)b * Sq + i) * H) + h) * hd;
        for (int j = 0; j < Skv; j++) {
          SCALAR w = pr[j];
          if (w == (SCALAR)0) continue;
          const SCALAR *vo = v + ((((long)b * Skv + j) * KV) + kh) * hd;
          for (int x = 0; x < hd; x++) oo[x] += w * vo[x];
        }
      }
    }
}

void FN(attn_apply_bwd)(int dout_, int p_, int v_, int dp_, int dv_,
                        int B, int Sq, int Skv, int H, int KV, int hd) {
  const SCALAR *dout = CP(dout_), *p = CP(p_), *v = CP(v_);
  SCALAR *dp = P(dp_), *dv = P(dv_);
  int rep = H / KV;
  for (long i = 0, n = (long)B * H * Sq * Skv; i < n; i++) dp[i] = (SCALAR)0;
  for (long i = 0, n = (long)B * Skv * KV * hd; i < n; i++) dv[i] = (SCALAR)0;

  for (int b = 0; b < B; b++)
    for (int h = 0; h < H; h++) {
      int kh = h / rep;
      for (int i = 0; i < Sq; i++) {
        const SCALAR *oo = dout + ((((long)b * Sq + i) * H) + h) * hd;
        const SCALAR *pr = p + ((((long)b * H + h) * Sq) + i) * Skv;
        SCALAR *dpr = dp + ((((long)b * H + h) * Sq) + i) * Skv;
        for (int j = 0; j < Skv; j++) {
          long vi = ((((long)b * Skv + j) * KV) + kh) * hd;
          double s = 0.0;
          for (int x = 0; x < hd; x++) {
            s += (double)oo[x] * (double)v[vi + x];
            dv[vi + x] += pr[j] * oo[x];
          }
          dpr[j] = (SCALAR)s;
        }
      }
    }
}

/* ------------------------------------------------------------ 行 softmax */

/*
 * 逐行 softmax，带一个**每行有效长度**。
 *
 * `valid` 是一个 i32 数组，valid[r] 表示第 r 行前多少列参与计算，
 * 后面的一律置 0（不是「置成很小的数」—— 因果位置必须是硬 0，
 * 第 3 关的探针查的就是这个）。传 `valid_ = -1` 表示整行都算。
 *
 * 因果掩码在这里表现成 valid[r] = i+1，由调用方填 —— 这样掩码是什么
 * 完全由上层决定（因果、滑窗、文档边界都是同一套），算子不必认识它们。
 */
void FN(softmax_rows_fwd)(int x_, int valid_, int out_, int rows, int cols) {
  const SCALAR *x = CP(x_);
  const int *valid = valid_ >= 0 ? (const int *)(ll_mem + valid_) : 0;
  SCALAR *out = P(out_);
  for (int r = 0; r < rows; r++) {
    const SCALAR *xr = x + (long)r * cols;
    SCALAR *o = out + (long)r * cols;
    int n = valid ? valid[r] : cols;
    if (n > cols) n = cols;
    if (n <= 0) {
      for (int j = 0; j < cols; j++) o[j] = (SCALAR)0;
      continue;
    }
    /* 减最大值：不减的话 seq 一长 exp 就溢出成 inf，然后 inf/inf = NaN */
    double mx = -1e308;
    for (int j = 0; j < n; j++) if ((double)xr[j] > mx) mx = (double)xr[j];
    double sum = 0.0;
    for (int j = 0; j < n; j++) {
      double e = ll_exp((double)xr[j] - mx);
      o[j] = (SCALAR)e;
      sum += e;
    }
    double inv = 1.0 / sum;
    for (int j = 0; j < n; j++) o[j] = (SCALAR)((double)o[j] * inv);
    for (int j = n; j < cols; j++) o[j] = (SCALAR)0;
  }
}

/*
 * log_softmax：`out_j = x_j − max − log Σ exp(x_k − max)`
 *
 * 为什么不写成 `log(softmax(x))`：softmax 之后有些概率会下溢成 0，
 * 再取 log 就是 −inf。合成一步之后不必显式算出概率，
 * 小概率对应的只是一个很负的数，不是 −inf。
 * 强化学习里 log-prob 到处都是（DPO 的隐式奖励、PPO / GRPO 的比值），
 * 而那些地方的概率常常很小 —— 这一步的稳定性不是可选项。
 *
 * 被 valid 挡在外面的位置填一个很负的数，而不是 0：
 * 0 在 log 空间里代表概率 1，是这里最糟的取值。
 */
void FN(log_softmax_fwd)(int x_, int valid_, int out_, int rows, int cols) {
  const SCALAR *x = CP(x_);
  const int *valid = valid_ >= 0 ? (const int *)(ll_mem + valid_) : 0;
  SCALAR *out = P(out_);
  for (int r = 0; r < rows; r++) {
    const SCALAR *xr = x + (long)r * cols;
    SCALAR *o = out + (long)r * cols;
    int n = valid ? valid[r] : cols;
    if (n > cols) n = cols;
    if (n <= 0) {
      for (int j = 0; j < cols; j++) o[j] = (SCALAR)(-1e30);
      continue;
    }
    double mx = -1e308;
    for (int j = 0; j < n; j++) if ((double)xr[j] > mx) mx = (double)xr[j];
    double sum = 0.0;
    for (int j = 0; j < n; j++) sum += ll_exp((double)xr[j] - mx);
    double lse = mx + ll_log(sum);
    for (int j = 0; j < n; j++) o[j] = (SCALAR)((double)xr[j] - lse);
    for (int j = n; j < cols; j++) o[j] = (SCALAR)(-1e30);
  }
}

/*
 * dx_j = dout_j − exp(out_j)·Σ_k dout_k
 *
 * 和 softmax 的反向形状很像，区别是这里乘的是 `exp(out)`（也就是概率），
 * 而求和项**不带权重**。写成 softmax 那一版的话前向照样对、梯度悄悄错。
 */
void FN(log_softmax_bwd)(int dout_, int out_, int valid_, int dx_, int rows, int cols) {
  const SCALAR *dout = CP(dout_), *out = CP(out_);
  const int *valid = valid_ >= 0 ? (const int *)(ll_mem + valid_) : 0;
  SCALAR *dx = P(dx_);
  for (int r = 0; r < rows; r++) {
    const SCALAR *dr = dout + (long)r * cols, *orow = out + (long)r * cols;
    SCALAR *d = dx + (long)r * cols;
    int n = valid ? valid[r] : cols;
    if (n > cols) n = cols;
    double total = 0.0;
    for (int j = 0; j < n; j++) total += (double)dr[j];
    for (int j = 0; j < n; j++) {
      d[j] = (SCALAR)((double)dr[j] - ll_exp((double)orow[j]) * total);
    }
    for (int j = n; j < cols; j++) d[j] = (SCALAR)0;
  }
}

/** ds_j = p_j·(dp_j − Σ_k p_k·dp_k)。漏掉那个求和项是最常见的错，前向照样对 */
void FN(softmax_rows_bwd)(int dout_, int out_, int valid_, int dx_, int rows, int cols) {
  const SCALAR *dout = CP(dout_), *out = CP(out_);
  const int *valid = valid_ >= 0 ? (const int *)(ll_mem + valid_) : 0;
  SCALAR *dx = P(dx_);
  for (int r = 0; r < rows; r++) {
    const SCALAR *dr = dout + (long)r * cols, *o = out + (long)r * cols;
    SCALAR *d = dx + (long)r * cols;
    int n = valid ? valid[r] : cols;
    if (n > cols) n = cols;
    double dot = 0.0;
    for (int j = 0; j < n; j++) dot += (double)dr[j] * (double)o[j];
    for (int j = 0; j < n; j++) d[j] = (SCALAR)((double)o[j] * ((double)dr[j] - dot));
    for (int j = n; j < cols; j++) d[j] = (SCALAR)0;
  }
}

/* ------------------------------------------------------------ LayerNorm */

/*
 * 做它只为一个用途：第 6 关的对照。
 *
 * LayerNorm 比 RMSNorm 多减一个均值、多一个 bias。现代 LLM 全都换成了 RMSNorm，
 * 而「换掉之后质量没掉、还快了一点」这件事，学员自己跑一遍两者才有体感。
 */
void FN(layernorm_fwd)(int x_, int g_, int b_, int out_, int mean_, int inv_,
                       int rows, int d, double eps) {
  const SCALAR *x = CP(x_), *g = CP(g_), *bi = CP(b_);
  SCALAR *out = P(out_), *mean = P(mean_), *inv = P(inv_);
  for (int t = 0; t < rows; t++) {
    const SCALAR *xr = x + (long)t * d;
    SCALAR *o = out + (long)t * d;
    double m = 0.0;
    for (int i = 0; i < d; i++) m += (double)xr[i];
    m /= (double)d;
    double var = 0.0;
    for (int i = 0; i < d; i++) { double c = (double)xr[i] - m; var += c * c; }
    var /= (double)d;
    SCALAR r = (SCALAR)(1.0 / ll_sqrt(var + eps));
    mean[t] = (SCALAR)m;
    inv[t] = r;
    for (int i = 0; i < d; i++) o[i] = (SCALAR)(((double)xr[i] - m) * (double)r * (double)g[i] + (double)bi[i]);
  }
}

void FN(layernorm_bwd)(int dout_, int x_, int g_, int mean_, int inv_,
                       int dg_, int db_, int dx_, int rows, int d) {
  const SCALAR *dout = CP(dout_), *x = CP(x_), *g = CP(g_), *mean = CP(mean_), *inv = CP(inv_);
  SCALAR *dg = P(dg_), *db = P(db_), *dx = P(dx_);
  for (int t = 0; t < rows; t++) {
    const SCALAR *dr = dout + (long)t * d, *xr = x + (long)t * d;
    SCALAR *dxr = dx + (long)t * d;
    double m = (double)mean[t], r = (double)inv[t];
    double sum1 = 0.0, sum2 = 0.0;
    for (int i = 0; i < d; i++) {
      double xhat = ((double)xr[i] - m) * r;
      dg[i] += (SCALAR)((double)dr[i] * xhat);
      db[i] += dr[i];
      double dxhat = (double)dr[i] * (double)g[i];
      sum1 += dxhat;
      sum2 += dxhat * xhat;
    }
    for (int i = 0; i < d; i++) {
      double xhat = ((double)xr[i] - m) * r;
      double dxhat = (double)dr[i] * (double)g[i];
      dxr[i] = (SCALAR)(r * (dxhat - sum1 / (double)d - xhat * sum2 / (double)d));
    }
  }
}

/* ------------------------------------------------------------ 低精度模拟 */

/** 就地舍到 bf16 的可表示集合上。存储仍是 SCALAR */
void FN(quantize_bf16)(int x_, int n) {
  SCALAR *x = P(x_);
  for (int i = 0; i < n; i++) x[i] = (SCALAR)ll_round_bf16((float)x[i]);
}

/** 就地舍到 fp16。超过 65504 就是 inf —— 第 17 关要的正是这个 */
void FN(quantize_fp16)(int x_, int n) {
  SCALAR *x = P(x_);
  for (int i = 0; i < n; i++) x[i] = (SCALAR)ll_round_fp16((float)x[i]);
}

/**
 * 数一数有多少个非有限值。fp16 溢出关的门槛读它。
 *
 * 判据用 `v - v != 0`：有限数减自己是 0，inf 减自己是 NaN，NaN 减自己还是 NaN，
 * 两种都落进「不等于 0」。
 *
 * **第一版写的是 `v > 1e300`，在 f32 实例化里恒为假** ——
 * `(float)1e300` 本身就溢出成了 inf，而 `inf > inf` 是 false，
 * 于是这个函数对 f32 永远返回 0。一个「永远说没问题」的检查器
 * 比没有检查器更糟，是 fp16 那条用例把它顶出来的。
 */
int FN(count_nonfinite)(int x_, int n) {
  const SCALAR *x = CP(x_);
  int bad = 0;
  for (int i = 0; i < n; i++) {
    SCALAR v = x[i];
    if (!((v - v) == (SCALAR)0)) bad++;
  }
  return bad;
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

/* ---------------------------------------------------------------- 逐元素 */

/*
 * out = exp(x)。反向是 `dx = out · go` —— 导数就是它自己，不必重算。
 *
 * 强化学习里它只有一个用处，但那个用处绕不开：
 * 重要性比值 `ρ = exp(log π_new − log π_old)`。
 * 写成两个概率相除会在小概率上失去精度，所以是「在 log 空间里减，再 exp 回来」。
 */
void FN(exp_fwd)(int x_, int out_, int n) {
  const SCALAR *x = CP(x_);
  SCALAR *out = P(out_);
  for (int i = 0; i < n; i++) out[i] = (SCALAR)ll_exp((double)x[i]);
}

void FN(exp_bwd)(int go_, int out_, int dx_, int n) {
  const SCALAR *go = CP(go_), *out = CP(out_);
  SCALAR *dx = P(dx_);
  for (int i = 0; i < n; i++) dx[i] = (SCALAR)((double)go[i] * (double)out[i]);
}

/* out = a * b。PyTorch 里的 `a * b`。反向是 (b·go, a·go) */
void FN(mul)(int a_, int b_, int out_, int n) {
  const SCALAR *a = CP(a_), *b = CP(b_);
  SCALAR *out = P(out_);
  for (int i = 0; i < n; i++) out[i] = a[i] * b[i];
}

/*
 * 每一行乘一个自己的系数：out[r][c] = x[r][c] * s[r]。
 *
 * MoE 的路由权重、SFT 的样本掩码、GRPO 的优势加权都是这个形状 ——
 * 「一行一个标量」在这些地方比通用的逐元素乘更常见，也省掉一块 [rows, dim] 的广播。
 */
void FN(row_scale)(int x_, int s_, int out_, int rows, int d) {
  const SCALAR *x = CP(x_), *s = CP(s_);
  SCALAR *out = P(out_);
  for (int r = 0; r < rows; r++) {
    SCALAR k = s[r];
    const SCALAR *src = x + (long)r * d;
    SCALAR *dst = out + (long)r * d;
    for (int i = 0; i < d; i++) dst[i] = src[i] * k;
  }
}

/* row_scale 对 s 的反向：ds[r] = Σ_c x[r][c] · go[r][c] */
void FN(row_scale_bwd_s)(int go_, int x_, int ds_, int rows, int d) {
  const SCALAR *go = CP(go_), *x = CP(x_);
  SCALAR *ds = P(ds_);
  for (int r = 0; r < rows; r++) {
    double acc = 0.0;
    const SCALAR *g = go + (long)r * d, *v = x + (long)r * d;
    for (int i = 0; i < d; i++) acc += (double)g[i] * (double)v[i];
    ds[r] += (SCALAR)acc;
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
