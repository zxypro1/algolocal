/**
 * fp32 语义
 *
 * JS 的 Number 是 float64，CUDA 的 float 是 float32。每一步运算都要
 * `Math.fround` 回 fp32，否则中间结果的精度比真卡高，学员在这里看不到
 * 该看到的误差 —— 而「误差是怎么攒起来的」正是规约与 FlashAttention 那几关的内容。
 *
 * **超越函数一律自己实现，不用 JS 的 `Math.exp` / `Math.log` / `Math.tanh`。**
 * 理由是硬的：ECMAScript 不要求这些函数逐位可复现，V8 与 JavaScriptCore
 * 的结果就不一样。用了它们，「同一份代码跑两遍逐位相同」这条门槛在
 * 换个浏览器之后就不成立了，整套判定跟着塌。
 *
 * 顺带白拿一件事：CUDA 有 `expf`（精确）与 `__expf`（快但不准）两套，
 * 我们自己实现就能把这个区别做出来，而不是在 primer 里说一句了事。
 */

const f32 = Math.fround;

export { f32 };

/* ------------------------------------------------------------------ */
/* 位级转换                                                            */
/* ------------------------------------------------------------------ */

const bitsBuffer = new ArrayBuffer(4);
const bitsF32 = new Float32Array(bitsBuffer);
const bitsI32 = new Int32Array(bitsBuffer);
const bitsU32 = new Uint32Array(bitsBuffer);

export function floatToBits(value: number): number {
  bitsF32[0] = value;
  return bitsI32[0];
}

export function bitsToFloat(bits: number): number {
  bitsI32[0] = bits | 0;
  return bitsF32[0];
}

export function floatToU32Bits(value: number): number {
  bitsF32[0] = value;
  return bitsU32[0];
}

/* ------------------------------------------------------------------ */
/* 基本算术                                                            */
/* ------------------------------------------------------------------ */

export function addF32(a: number, b: number): number {
  return f32(a + b);
}

export function subF32(a: number, b: number): number {
  return f32(a - b);
}

export function mulF32(a: number, b: number): number {
  return f32(a * b);
}

export function divF32(a: number, b: number): number {
  return f32(a / b);
}

/**
 * 融合乘加：一次舍入。
 *
 * `a * b` 对两个 fp32 来说在 float64 里是**精确**的（24+24 = 48 位尾数，
 * float64 有 53 位），所以 `a * b + c` 在 float64 里只舍入一次，再 fround
 * 到 fp32 又舍入一次 —— 这是双重舍入，极少数情况下与真硬件的单次舍入差 1 ulp。
 *
 * 这是一处**已知分叉**，写在这里而不是藏着：它是确定的（同一输入永远同一输出），
 * 只是不保证与真卡逐位一致。做到完全一致需要 two-sum 展开，等有关卡真的
 * 卡在这 1 ulp 上再补。
 */
export function fmaF32(a: number, b: number, c: number): number {
  return f32(a * b + c);
}

export function minF32(a: number, b: number): number {
  // CUDA 的 fminf：有一个是 NaN 就返回另一个
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return a < b ? a : b;
}

export function maxF32(a: number, b: number): number {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return a > b ? a : b;
}

export function sqrtF32(a: number): number {
  return f32(Math.sqrt(a));
}

export function rsqrtF32(a: number): number {
  return f32(1 / Math.sqrt(a));
}

/**
 * 舍到 fp16 能表示的最近的值。
 *
 * tensor core 的输入是 half，精度只有 10 位尾数。第 11 关要学员看到的
 * 「精度换吞吐」就靠这个：同一个 GEMM 换成 half 输入之后误差会明显变大，
 * 但累加仍然在 fp32 上做，所以不会垮掉。
 */
export function toHalf(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return value;

  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  if (abs >= 65520) return sign * Infinity; // 65520 是舍入到 inf 的分界
  if (abs < 2.9802322387695312e-8) return sign * 0; // 半个最小次正规数

  // 次正规数：fp16 的最小正规数是 2^-14，再往下步长固定在 2^-24
  const step = abs < 6.103515625e-5
    ? 5.960464477539063e-8
    : Math.pow(2, Math.floor(Math.log2(abs)) - 10);

  return f32(sign * roundHalfToEven(abs / step) * step);
}

/**
 * 就近舍入、遇到正中间取偶数。
 *
 * **不能用 `Math.round`** —— 它把 0.5 一律往远离零的方向推，
 * 而 IEEE 754 规定的是取偶数。差别只在恰好落在中点的输入上，
 * 但那正是「1 + 2^-11 在 fp16 里舍成 1 还是 1+2^-10」这类问题的答案，
 * 而我们对外承诺过重放逐位一致，所以这里必须是对的。
 */
function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/* ------------------------------------------------------------------ */
/* 超越函数：自己实现                                                   */
/* ------------------------------------------------------------------ */

const LOG2E = 1.4426950408889634;
const LN2_HI = 0.6931471824645996;   // ln2 的高位部分，fp32 可精确表示
const LN2_LO = -1.904654323148236e-9; // 余项

/**
 * 2^n，n 为整数。用位运算直接构造指数，不走 Math.pow。
 */
function ldexpF32(mantissa: number, exponent: number): number {
  if (exponent > 127) return mantissa > 0 ? Infinity : -Infinity;
  if (exponent < -126) {
    // 次正规数：分两步缩，避免一次性下溢
    return f32(f32(mantissa * Math.pow(2, -126)) * Math.pow(2, exponent + 126));
  }
  return f32(mantissa * Math.pow(2, exponent));
}

/**
 * expf：先把 x 化到 [-ln2/2, ln2/2]，再用 minimax 多项式，最后乘回 2^k。
 *
 * 这是 libm 的标准做法，系数取自对 e^r 在该区间上的截断泰勒展开
 * （7 项，fp32 精度下足够 —— 误差目标 < 1 ulp）。
 */
export function expF32(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x > 88.72283935546875) return Infinity;   // fp32 能表示的最大 exp 输入
  if (x < -103.97208404541016) return 0;        // 再小就下溢到 0

  const k = Math.round(x * LOG2E);
  // 用高低位拆分减小舍入误差
  const r = (x - k * LN2_HI) - k * LN2_LO;

  // e^r ≈ 1 + r + r²/2 + r³/6 + r⁴/24 + r⁵/120 + r⁶/720
  const poly =
    1 + r * (1 + r * (0.5 + r * (1 / 6 + r * (1 / 24 + r * (1 / 120 + r / 720)))));

  return ldexpF32(f32(poly), k);
}

/**
 * logf：把 x 拆成 m * 2^k（m 在 [√2/2, √2)），再用 atanh 级数算 ln(m)。
 */
export function logF32(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (!Number.isFinite(x)) return Infinity;

  // 从位模式里取指数与尾数，不用 Math.log2
  let bits = floatToU32Bits(f32(x));
  let exponent = ((bits >>> 23) & 0xff) - 127;
  if (exponent === -127) {
    // 次正规数：先放大再补回来
    const scaled = f32(x * 16777216); // 2^24
    bits = floatToU32Bits(scaled);
    exponent = ((bits >>> 23) & 0xff) - 127 - 24;
  }
  // 尾数归一到 [1, 2)
  const mantissaBits = (bits & 0x007fffff) | 0x3f800000;
  let m = bitsToFloat(mantissaBits | 0);

  // 再把 m 挪到 [√2/2, √2)，级数收敛更快
  if (m > 1.4142135623730951) {
    m = f32(m / 2);
    exponent += 1;
  }

  // ln(m) = 2 * atanh(s)，s = (m-1)/(m+1)
  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  const atanh = s * (1 + s2 * (1 / 3 + s2 * (1 / 5 + s2 * (1 / 7 + s2 * (1 / 9 + s2 / 11)))));

  return f32(2 * atanh + exponent * (LN2_HI + LN2_LO));
}

export function tanhF32(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const ax = Math.abs(x);
  if (ax > 9) return x > 0 ? 1 : -1;   // fp32 下已经饱和
  if (ax < 1e-4) return f32(x);        // 小量直接返回，避免 0/0
  const e = expF32(f32(2 * ax));
  const result = (e - 1) / (e + 1);
  return f32(x > 0 ? result : -result);
}

export function powF32(a: number, b: number): number {
  if (b === 0) return 1;
  if (a === 0) return b > 0 ? 0 : Infinity;
  if (Number.isInteger(b) && Math.abs(b) <= 64) {
    // 整数幂走平方乘，比走 exp(log) 准得多，也是 libm 的做法
    let result = 1;
    let base = f32(a);
    let n = Math.abs(b);
    while (n > 0) {
      if (n & 1) result = f32(result * base);
      base = f32(base * base);
      n >>= 1;
    }
    return b > 0 ? result : f32(1 / result);
  }
  if (a < 0) return NaN;
  return expF32(f32(b * logF32(a)));
}

/* ------------------------------------------------------------------ */
/* fast-math 变体                                                      */
/* ------------------------------------------------------------------ */

/**
 * `__expf`：真卡上走 SFU 的 `ex2.approx.f32`，约 22 位有效精度、单周期吞吐。
 *
 * 我们的模拟方式是**故意把精度砍掉**：算完之后把尾数低位抹掉，
 * 留下和硬件近似指令相当的有效位数。这样「快但不准」在这里是真的不准，
 * 学员在 softmax 那一关会看到它对结果的影响，而不是读到一句说明。
 */
export function fastExpF32(x: number): number {
  return truncateMantissa(expF32(x), 10);
}

export function fastLogF32(x: number): number {
  return truncateMantissa(logF32(x), 10);
}

export function fastDivF32(a: number, b: number): number {
  return truncateMantissa(f32(a / b), 10);
}

/** 抹掉尾数低 bits 位，模拟近似指令的有效精度 */
function truncateMantissa(value: number, bits: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const raw = floatToBits(value);
  const mask = ~((1 << bits) - 1);
  return bitsToFloat(raw & mask);
}

/* ------------------------------------------------------------------ */
/* 整数                                                               */
/* ------------------------------------------------------------------ */

/** C 的 float → int 是截断（朝零取整），不是四舍五入 */
export function floatToInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.trunc(value) | 0;
}

export function floatToUint(value: number): number {
  if (Number.isNaN(value) || value < 0) return 0;
  return Math.trunc(value) >>> 0;
}
