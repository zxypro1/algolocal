import { GpuDevice, compileSource, dim3 } from '../../src/lib/gpulab';
import { FP8_E4M3, FP8_E5M2, fp8ToStorage, storageToFp8, toFp8 } from '../../src/lib/gpulab/vm/float';
jest.setTimeout(180_000);

describe('fp8 的数值语义', () => {
  it('E4M3 的边界：最大 448，最小次正规数 2^-9，没有 inf', () => {
    expect(toFp8(448, FP8_E4M3)).toBe(448);
    // SATFINITE：超出范围夹到最大有限值，不产生 inf
    expect(toFp8(1e6, FP8_E4M3)).toBe(448);
    expect(toFp8(-1e6, FP8_E4M3)).toBe(-448);
    expect(toFp8(Math.pow(2, -9), FP8_E4M3)).toBe(Math.pow(2, -9));
    expect(toFp8(Math.pow(2, -12), FP8_E4M3)).toBe(0);
  });

  it('E5M2 的范围更大但精度更差', () => {
    expect(toFp8(57344, FP8_E5M2)).toBe(57344);
    // 3 位尾数 vs 2 位尾数：1.1 在两个格式里落到不同的格点
    expect(toFp8(1.1, FP8_E4M3)).toBeCloseTo(1.125, 6);
    expect(toFp8(1.1, FP8_E5M2)).toBeCloseTo(1.0, 6);
  });

  it('**E4M3 的动态范围只有 19 个二进制数量级**', () => {
    const decades = Math.log2(448 / Math.pow(2, -9));
    expect(decades).toBeLessThan(19);
    // fp32 是 277 个 —— 所有量化工程的难处都从这个比值开始
    expect(Math.log2(3.4e38 / 1.4e-45)).toBeGreaterThan(270);
  });

  it('编码解码来回一趟不丢东西', () => {
    for (const format of [FP8_E4M3, FP8_E5M2]) {
      for (let bits = 0; bits < 256; bits += 1) {
        const value = storageToFp8(bits, format);
        // NaN 与 inf 不参与：SATFINITE 下 inf 会被夹成最大有限值，
        // 所以它本来就不是一个能来回的值
        if (!Number.isFinite(value)) continue;
        expect(fp8ToStorage(value, format)).toBe(bits === 0x80 ? 0x80 : bits);
      }
    }
  });

  it('饱和模式是真的在起作用，不是收下就扔', () => {
    // SATFINITE：溢出夹到最大有限值。推理里就要这个 ——
    // 一个 inf 会顺着 softmax 传染成一整行 NaN
    expect(toFp8(1e9, FP8_E5M2, true)).toBe(57344);
    // NOSAT：按 IEEE 来，E5M2 有 inf
    expect(toFp8(1e9, FP8_E5M2, false)).toBe(Infinity);
    // E4M3 没有 inf，NOSAT 溢出只能是 NaN
    expect(Number.isNaN(toFp8(1e9, FP8_E4M3, false))).toBe(true);
    expect(toFp8(1e9, FP8_E4M3, true)).toBe(448);
  });

  it('±inf 进来不会悄悄变成 NaN', () => {
    expect(toFp8(Infinity, FP8_E5M2, false)).toBe(Infinity);
    expect(toFp8(-Infinity, FP8_E5M2, false)).toBe(-Infinity);
    expect(toFp8(Infinity, FP8_E4M3, true)).toBe(448);
  });

  it('舍入是就近取偶，不是 Math.round', () => {
    // E4M3 在 1.0 附近步长是 2^-3 = 0.125，1.0625 正好在 1.0 和 1.125 中间
    expect(toFp8(1.0625, FP8_E4M3)).toBe(1);
    // 1.1875 在 1.125 和 1.25 中间，取偶数尾数的那个
    expect(toFp8(1.1875, FP8_E4M3)).toBe(1.25);
  });
});

describe('kernel 里的 fp8 内建函数', () => {
  async function roundTrip(values: number[], interp: string) {
    const kernel = (await compileSource(`
      __global__ void quantize(const float* in, float* out, int n) {
        int i = threadIdx.x;
        if (i >= n) return;
        int storage = __nv_cvt_float_to_fp8(in[i], __NV_SATFINITE, ${interp});
        half back = __nv_cvt_fp8_to_halfraw(storage, ${interp});
        out[i] = (float)back;
      }
    `)).get('quantize')!;
    const gpu = new GpuDevice({ globalBytes: 64 * 1024 });
    const din = gpu.malloc(values.length * 4);
    const dout = gpu.malloc(values.length * 4);
    gpu.copyIn(din, Float32Array.from(values));
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [din, dout, values.length]);
    return Array.from(gpu.copyOut(dout, values.length));
  }

  it('名字与参数照抄 cuda_fp8.h，走一趟回来是量化后的值', async () => {
    const out = await roundTrip([1.0, 1.1, 2.5, -3.75, 0.001, 1000], '__NV_E4M3');
    expect(out[0]).toBe(1);
    expect(out[1]).toBeCloseTo(1.125, 5);
    expect(out[2]).toBe(2.5);
    expect(out[3]).toBe(-3.75);
    // 1000 超出 E4M3 的范围，夹到 448
    expect(out[5]).toBe(448);
  });

  it('两种格式在同一个值上给出不同结果', async () => {
    const e4 = await roundTrip([1.1, 1000], '__NV_E4M3');
    const e5 = await roundTrip([1.1, 1000], '__NV_E5M2');
    expect(e4[0]).not.toBe(e5[0]);
    // E5M2 装得下 1000，E4M3 装不下
    expect(e5[1]).toBe(1024);
    expect(e4[1]).toBe(448);
  });

  it('**打包 4 个 fp8 进一个 int** —— 真 kernel 就是这么省显存的', async () => {
    const kernel = (await compileSource(`
      __global__ void pack(const float* in, int* out, int n) {
        int i = threadIdx.x;
        if (i * 4 >= n) return;
        int a = __nv_cvt_float_to_fp8(in[i * 4 + 0], __NV_SATFINITE, __NV_E4M3);
        int b = __nv_cvt_float_to_fp8(in[i * 4 + 1], __NV_SATFINITE, __NV_E4M3);
        int c = __nv_cvt_float_to_fp8(in[i * 4 + 2], __NV_SATFINITE, __NV_E4M3);
        int d = __nv_cvt_float_to_fp8(in[i * 4 + 3], __NV_SATFINITE, __NV_E4M3);
        out[i] = a | (b << 8) | (c << 16) | (d << 24);
      }
    `)).get('pack')!;
    const gpu = new GpuDevice({ globalBytes: 64 * 1024 });
    const values = [1.0, 2.0, -1.0, 0.5];
    const din = gpu.malloc(16);
    const dout = gpu.malloc(4);
    gpu.copyIn(din, Float32Array.from(values));
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [din, dout, 4]);
    const packed = gpu.copyOutInts(dout, 1)[0];
    for (let i = 0; i < 4; i += 1) {
      const byte = (packed >> (i * 8)) & 0xff;
      expect(storageToFp8(byte, FP8_E4M3)).toBe(values[i]);
    }
  });

  it('**per-tensor 的 scale 在有离群值时会把正常值直接压成 0**', () => {
    // 真实的激活值就长这样：绝大多数在 0.01 量级，个别通道能到上万。
    // 论文里管这叫 outlier channel，也是 SmoothQuant / AWQ 那一串工作的起点。
    const values = [0.01, 0.02, 0.03, 0.04, 20000];

    // per-tensor：一个 scale 管全部。离群值把 scale 拉到 448/20000，
    // 于是 0.01 缩到 0.000224 —— 比 E4M3 的最小次正规数（2^-9）还小
    const tensorScale = 448 / 20000;
    const perTensor = values.map((v) => toFp8(v * tensorScale, FP8_E4M3) / tensorScale);
    expect(perTensor.slice(0, 4).every((q) => q === 0)).toBe(true);

    // per-block：离群值单独一组，正常值那一组按自己的最大值定 scale
    const blockScale = 448 / 0.04;
    const perBlock = values.slice(0, 4).map((v) => toFp8(v * blockScale, FP8_E4M3) / blockScale);
    const errors = perBlock.map((q, i) => Math.abs(q - values[i]) / values[i]);
    // 3 位尾数在一个 binade 里的分辨率大约是 6%，所以误差在这个量级 ——
    // 但至少值还在，而不是变成 0
    expect(Math.max(...errors)).toBeLessThan(0.07);
    expect(perBlock.every((q) => q > 0)).toBe(true);
  });

  it('scale 的粒度决定一切，而不是格式本身', () => {
    // 同一批数、同一个 fp8 格式，只改 scale 的分组方式，结果天差地别。
    // 这就是第 19 关的全部内容。
    const values = [0.01, 0.02, 0.03, 0.04, 20000];
    const relative = (scale: number, slice: number[]) =>
      slice.map((v) => Math.abs(toFp8(v * scale, FP8_E4M3) / scale - v) / v);

    const tensorErrors = relative(448 / 20000, values.slice(0, 4));
    const blockErrors = relative(448 / 0.04, values.slice(0, 4));
    // per-tensor 的相对误差是 100%（值没了），per-block 是个位数百分比
    expect(Math.min(...tensorErrors)).toBe(1);
    expect(Math.max(...blockErrors)).toBeLessThan(0.07);
  });
});
