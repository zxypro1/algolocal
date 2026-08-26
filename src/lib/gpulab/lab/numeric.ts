/**
 * 数值判定的尺子
 *
 * design/gpulab.md 第八节定的三层：fp64 参考、理论误差界、重放逐位一致。
 * 这里是第二层用到的两件工具。
 */

const bitsBuffer = new ArrayBuffer(4);
const bitsF32 = new Float32Array(bitsBuffer);
const bitsI32 = new Int32Array(bitsBuffer);

/**
 * 两个 fp32 之间差多少个 ulp。
 *
 * 判定用它而不是只看相对误差：相对误差在接近 0 的地方会炸，
 * 而 ulp 在整个数值范围上都是同一把尺子。
 */
export function ulpDistanceOf(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  if (a === b) return 0;
  const ordered = (value: number): number => {
    bitsF32[0] = value;
    const bits = bitsI32[0];
    // 负数的位模式是反的，翻成一条单调的整数轴
    return bits < 0 ? 0x80000000 - bits : bits;
  };
  return Math.abs(ordered(a) - ordered(b));
}

/**
 * K 项累加在 fp32 下的相对误差界。
 *
 * 顺序累加的最坏情况是 O(K·ε)，但实际误差是随机游走，所以按 √K 给界；
 * 系数 C 留出余量（分块累加、FMA、不同的规约顺序都会让常数变一点）。
 *
 * 关卡的题面里要把这个界和它的来历写出来 —— 一个凭空的阈值教不会任何事。
 */
export function accumulationTolerance(terms: number, c = 8): number {
  const epsilon = 2 ** -23; // fp32 的机器精度
  return c * Math.sqrt(Math.max(1, terms)) * epsilon;
}
