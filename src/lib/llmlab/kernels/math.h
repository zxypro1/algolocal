/*
 * 超越函数：自己实现，不用宿主的。
 *
 * 为什么不用 JS 的 `Math.exp`：V8 与 JSC 的结果不一样。gpulab 已经踩过这个坑
 * （见 design/gpulab.md 组件路由表里 expf 那一行）—— 直接用会毁掉确定性，
 * 而「同一份代码跑两遍逐位一致」是这个项目所有门槛的地基。
 *
 * 为什么也不链 wasi-libc 的 libm：那要把整个 sysroot 拖进来，模块会多出
 * 一堆 WASI import（fd_write 之类），而我们要的是一个**零 import** 的模块 ——
 * `WebAssembly.instantiate(module, {})` 就能起来，浏览器与 Node 两侧同一条路径。
 *
 * 精度目标：exp / log 在双精度下 < 2 ulp。够用，理由是它们只出现在 softmax、
 * 交叉熵与 SwiGLU 里，而那几处的误差远小于 fp32 累加本身的误差。
 * 单精度版一律**先在双精度里算完再舍入** —— 少一套多项式要维护，
 * 而且保证 fp32 与 fp64 两条路径的语义完全一致（梯度检验要靠这一点）。
 */
#ifndef LLMLAB_MATH_H
#define LLMLAB_MATH_H

typedef unsigned long long u64;
typedef long long i64;

static inline double ll_from_bits(u64 b) {
  union { u64 u; double d; } v;
  v.u = b;
  return v.d;
}

static inline u64 ll_to_bits(double d) {
  union { u64 u; double d; } v;
  v.d = d;
  return v.u;
}

/** 2^k，k 是整数。用位操作直接拼指数，比反复乘快也更准 */
static inline double ll_ldexp(double x, int k) {
  if (k > 1023) {
    x *= ll_from_bits(0x7FE0000000000000ULL); /* 2^1023 */
    k -= 1023;
    if (k > 1023) return x * ll_from_bits(0x7FE0000000000000ULL);
  } else if (k < -1022) {
    /* 次正规：分两步，避免中间结果先冲掉 */
    x *= ll_from_bits(0x0010000000000000ULL); /* 2^-1022 */
    k += 1022;
    if (k < -1022) return x * ll_from_bits(0x0010000000000000ULL);
  }
  return x * ll_from_bits(((u64)(k + 1023)) << 52);
}

#define LL_LN2_HI 6.93147180369123816490e-01
#define LL_LN2_LO 1.90821492927058770002e-10
#define LL_INV_LN2 1.44269504088896338700e+00

/**
 * e^x
 *
 * 区间归约 x = k·ln2 + r（|r| ≤ ln2/2），对 r 用 Remez 多项式，再 ldexp 回去。
 * ln2 拆成 hi/lo 两半是为了让 k·ln2 这一步不丢精度 —— x 大的时候
 * k 也大，用单个 ln2 常数会在减法里损失掉低位。
 */
static double ll_exp(double x) {
  if (x != x) return x;              /* NaN */
  if (x > 709.782712893384) return ll_from_bits(0x7FF0000000000000ULL); /* +inf */
  if (x < -745.133219101941) return 0.0;

  int k = (int)(x * LL_INV_LN2 + (x >= 0 ? 0.5 : -0.5));
  double r = (x - (double)k * LL_LN2_HI) - (double)k * LL_LN2_LO;

  /* e^r - 1 的 Remez 多项式，|r| ≤ 0.3466 */
  double r2 = r * r;
  double p = r - r2 * (1.66666666666666019037e-01
             + r2 * (-2.77777777770155933842e-03
             + r2 * (6.61375632143793436117e-05
             + r2 * (-1.65339022054652515390e-06
             + r2 * 4.13813679705723846039e-08))));
  double e = 1.0 - ((r * p) / (p - 2.0) - r);
  return ll_ldexp(e, k);
}

/**
 * ln(x)
 *
 * 取出指数 k、把尾数归到 [√2/2, √2)，对 s = f/(2+f) 用奇次多项式。
 * 这是 fdlibm 的经典做法，选它是因为它在整个定义域上误差均匀，
 * 而交叉熵里 log 的自变量可以非常小（一个被压到 1e-30 的概率）。
 */
static double ll_log(double x) {
  if (x != x) return x;
  if (x < 0.0) return ll_from_bits(0x7FF8000000000000ULL);  /* NaN */
  if (x == 0.0) return -ll_from_bits(0x7FF0000000000000ULL); /* -inf */

  u64 bits = ll_to_bits(x);
  int k = 0;
  if (bits < 0x0010000000000000ULL) {  /* 次正规：先放大 2^54 */
    x *= 18014398509481984.0;
    bits = ll_to_bits(x);
    k = -54;
  }
  k += (int)((bits >> 52) & 0x7FF) - 1023;
  bits = (bits & 0x000FFFFFFFFFFFFFULL) | 0x3FF0000000000000ULL;
  double f = ll_from_bits(bits);       /* f ∈ [1, 2) */
  if (f > 1.4142135623730951) { f *= 0.5; k += 1; }
  f -= 1.0;

  double s = f / (2.0 + f);
  double z = s * s;
  double w = z * z;
  /*
   * 系数按奇偶分成两组：t2 拿 Lg1/Lg3/Lg5/Lg7（乘 z），t1 拿 Lg2/Lg4/Lg6（乘 w）。
   * **两组写反过一次**，表现是 log 的相对误差从 1e-16 掉到 2e-4 ——
   * 前向的 loss 看着完全正常（3.2 这种量级），是交叉熵那条对拍用例把它顶出来的。
   */
  double t1 = w * (3.999999999940941908e-01              /* Lg2 */
              + w * (2.222219843214978396e-01            /* Lg4 */
              + w * 1.531383769920937332e-01));          /* Lg6 */
  double t2 = z * (6.666666666666735130e-01              /* Lg1 */
              + w * (2.857142874366239149e-01            /* Lg3 */
              + w * (1.818357216161805012e-01            /* Lg5 */
              + w * 1.479819860511658591e-01)));         /* Lg7 */
  double hfsq = 0.5 * f * f;
  double dk = (double)k;
  return dk * LL_LN2_HI - ((hfsq - (s * (hfsq + t1 + t2) + dk * LL_LN2_LO)) - f);
}

static inline double ll_tanh(double x) {
  if (x > 20.0) return 1.0;
  if (x < -20.0) return -1.0;
  double e = ll_exp(2.0 * x);
  return (e - 1.0) / (e + 1.0);
}

/** logistic sigmoid，SwiGLU 与 DPO 都要它。写成两支避免大负数时 exp 溢出 */
static inline double ll_sigmoid(double x) {
  if (x >= 0.0) return 1.0 / (1.0 + ll_exp(-x));
  double e = ll_exp(x);
  return e / (1.0 + e);
}

/* sqrt 直接落到 wasm 的 f32.sqrt / f64.sqrt 指令上，不用自己写 */
static inline double ll_sqrt(double x) { return __builtin_sqrt(x); }
static inline float ll_sqrtf(float x) { return __builtin_sqrtf(x); }

#endif /* LLMLAB_MATH_H */
