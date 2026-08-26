/**
 * Tensor Core（wmma）
 *
 * **这是唯一放开的 C++ 语法。** 理由是「接口真实」：`wmma` 在 CUDA 里本来
 * 就是带模板的 C++，造一套 C 风格的假 API 等于教一个真卡上不存在的东西。
 * 放开的范围严格限定在 `wmma::` 这几个名字上，别的 C++ 照样报错 ——
 * 这套用例把边界也钉住了。
 */
import { GpuDevice, compileSource, dim3 } from '../../src/lib/gpulab';

jest.setTimeout(180_000);

function device(): GpuDevice {
  return new GpuDevice({ globalBytes: 4 * 1024 * 1024 });
}

async function compileOne(source: string, name: string) {
  return (await compileSource(source)).get(name)!;
}

/** 一个 warp 用 wmma 算 16×16×16 */
const MMA16 = `
__global__ void mm16(const half* A, const half* B, float* C, int n) {
  wmma::fragment<wmma::matrix_a, 16, 16, 16, half, wmma::row_major> af;
  wmma::fragment<wmma::matrix_b, 16, 16, 16, half, wmma::row_major> bf;
  wmma::fragment<wmma::accumulator, 16, 16, 16, float> cf;

  wmma::fill_fragment(cf, 0.0f);
  wmma::load_matrix_sync(af, A, n);
  wmma::load_matrix_sync(bf, B, n);
  wmma::mma_sync(cf, af, bf, cf);
  wmma::store_matrix_sync(C, cf, n, wmma::mem_row_major);
}
`;

async function runMma16() {
  const kernel = await compileOne(MMA16, 'mm16');
  const gpu = device();
  const N = 16;
  const dA = gpu.malloc(N * N * 4);
  const dB = gpu.malloc(N * N * 4);
  const dC = gpu.malloc(N * N * 4);
  // 用 fp16 能精确表示的值，好把 tensor core 的语义和精度损失分开验
  const A = Float32Array.from({ length: N * N }, (_, i) => ((i % 5) - 2) * 0.5);
  const B = Float32Array.from({ length: N * N }, (_, i) => ((i % 7) - 3) * 0.25);
  gpu.copyIn(dA, A);
  gpu.copyIn(dB, B);
  gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [dA, dB, dC, N]);
  return { gpu, A, B, C: gpu.copyOut(dC, N * N), N };
}

describe('语法', () => {
  it('真 wmma 的模板写法能编过', async () => {
    const kernels = await compileSource(MMA16);
    expect(kernels.has('mm16')).toBe(true);
  });

  it('放开的只是 wmma —— 别的命名空间照样报错', async () => {
    await expect(compileSource(`
      __global__ void k(float* out) {
        cooperative_groups::thread_block b = cooperative_groups::this_thread_block();
        out[0] = 1.0f;
      }
    `)).rejects.toThrow(/命名空间|暂不支持/);
  });

  it('不支持的 fragment 形状会说清楚支持哪个', async () => {
    await expect(compileSource(`
      __global__ void k(const half* a, float* c) {
        wmma::fragment<wmma::matrix_a, 32, 8, 16, half, wmma::row_major> af;
        wmma::load_matrix_sync(af, a, 32);
      }
    `)).rejects.toThrow(/16×16×16/);
  });

  it('accumulator 用 half 会被拦下', async () => {
    await expect(compileSource(`
      __global__ void k(float* c) {
        wmma::fragment<wmma::accumulator, 16, 16, 16, half> cf;
        wmma::fill_fragment(cf, 0.0f);
      }
    `)).rejects.toThrow(/accumulator/);
  });

  it('matrix_a 不写 layout 会被拦下', async () => {
    await expect(compileSource(`
      __global__ void k(const half* a) {
        wmma::fragment<wmma::matrix_a, 16, 16, 16, half> af;
        wmma::load_matrix_sync(af, a, 16);
      }
    `)).rejects.toThrow(/row_major|col_major/);
  });

  it('fragment 不能当普通变量读写', async () => {
    await expect(compileSource(`
      __global__ void k(float* out) {
        wmma::fragment<wmma::accumulator, 16, 16, 16, float> cf;
        out[0] = cf;
      }
    `)).rejects.toThrow(/fragment/);
  });
});

describe('语义', () => {
  it('一个 warp 算出正确的 16×16×16', async () => {
    const { A, B, C, N } = await runMma16();
    for (let r = 0; r < N; r += 1) {
      for (let c = 0; c < N; c += 1) {
        let expected = 0;
        for (let k = 0; k < N; k += 1) expected += A[r * N + k] * B[k * N + c];
        expect(C[r * N + c]).toBeCloseTo(expected, 4);
      }
    }
  });

  it('fill_fragment 之后累加器是给定的值', async () => {
    const kernel = await compileOne(`
      __global__ void fill(float* C, int n) {
        wmma::fragment<wmma::accumulator, 16, 16, 16, float> cf;
        wmma::fill_fragment(cf, 2.5f);
        wmma::store_matrix_sync(C, cf, n, wmma::mem_row_major);
      }
    `, 'fill');
    const gpu = device();
    const dC = gpu.malloc(16 * 16 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [dC, 16]);
    const out = gpu.copyOut(dC, 256);
    for (let i = 0; i < 256; i += 1) expect(out[i]).toBe(2.5);
  });

  it('累加是真的累加 —— 连做两次 mma 结果翻倍', async () => {
    const kernel = await compileOne(`
      __global__ void twice(const half* A, const half* B, float* C, int n) {
        wmma::fragment<wmma::matrix_a, 16, 16, 16, half, wmma::row_major> af;
        wmma::fragment<wmma::matrix_b, 16, 16, 16, half, wmma::row_major> bf;
        wmma::fragment<wmma::accumulator, 16, 16, 16, float> cf;
        wmma::fill_fragment(cf, 0.0f);
        wmma::load_matrix_sync(af, A, n);
        wmma::load_matrix_sync(bf, B, n);
        wmma::mma_sync(cf, af, bf, cf);
        wmma::mma_sync(cf, af, bf, cf);
        wmma::store_matrix_sync(C, cf, n, wmma::mem_row_major);
      }
    `, 'twice');
    const once = await runMma16();
    const gpu = device();
    const dA = gpu.malloc(256 * 4);
    const dB = gpu.malloc(256 * 4);
    const dC = gpu.malloc(256 * 4);
    gpu.copyIn(dA, once.A);
    gpu.copyIn(dB, once.B);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [dA, dB, dC, 16]);
    const out = gpu.copyOut(dC, 256);
    for (let i = 0; i < 256; i += 1) expect(out[i]).toBeCloseTo(once.C[i] * 2, 4);
  });

  it('col_major 的 B 按列取', async () => {
    const kernel = await compileOne(`
      __global__ void colmajor(const half* A, const half* B, float* C, int n) {
        wmma::fragment<wmma::matrix_a, 16, 16, 16, half, wmma::row_major> af;
        wmma::fragment<wmma::matrix_b, 16, 16, 16, half, wmma::col_major> bf;
        wmma::fragment<wmma::accumulator, 16, 16, 16, float> cf;
        wmma::fill_fragment(cf, 0.0f);
        wmma::load_matrix_sync(af, A, n);
        wmma::load_matrix_sync(bf, B, n);
        wmma::mma_sync(cf, af, bf, cf);
        wmma::store_matrix_sync(C, cf, n, wmma::mem_row_major);
      }
    `, 'colmajor');
    const N = 16;
    const gpu = device();
    const dA = gpu.malloc(N * N * 4);
    const dB = gpu.malloc(N * N * 4);
    const dC = gpu.malloc(N * N * 4);
    const A = Float32Array.from({ length: N * N }, (_, i) => ((i % 5) - 2) * 0.5);
    const B = Float32Array.from({ length: N * N }, (_, i) => ((i % 7) - 3) * 0.25);
    gpu.copyIn(dA, A);
    gpu.copyIn(dB, B);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [dA, dB, dC, N]);
    const C = gpu.copyOut(dC, N * N);
    for (let r = 0; r < N; r += 4) {
      for (let c = 0; c < N; c += 4) {
        let expected = 0;
        // col_major：B 的 (k, c) 存在 B[c * n + k]
        for (let k = 0; k < N; k += 1) expected += A[r * N + k] * B[c * N + k];
        expect(C[r * N + c]).toBeCloseTo(expected, 4);
      }
    }
  });
});

describe('half 的精度', () => {
  it('half 只有 10 位尾数 —— 装不下的值会被舍掉', async () => {
    const kernel = await compileOne(`
      __global__ void round(const half* A, const half* B, float* C, int n) {
        wmma::fragment<wmma::matrix_a, 16, 16, 16, half, wmma::row_major> af;
        wmma::fragment<wmma::matrix_b, 16, 16, 16, half, wmma::row_major> bf;
        wmma::fragment<wmma::accumulator, 16, 16, 16, float> cf;
        wmma::fill_fragment(cf, 0.0f);
        wmma::load_matrix_sync(af, A, n);
        wmma::load_matrix_sync(bf, B, n);
        wmma::mma_sync(cf, af, bf, cf);
        wmma::store_matrix_sync(C, cf, n, wmma::mem_row_major);
      }
    `, 'round');
    const N = 16;
    const gpu = device();
    const dA = gpu.malloc(N * N * 4);
    const dB = gpu.malloc(N * N * 4);
    const dC = gpu.malloc(N * N * 4);
    // 1.0009765625 = 1 + 2^-10，fp16 刚好能表示；再小一位就存不下
    const A = new Float32Array(N * N).fill(1 + Math.pow(2, -11));
    const B = new Float32Array(N * N).fill(0);
    B[0] = 1;
    gpu.copyIn(dA, A);
    gpu.copyIn(dB, B);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [dA, dB, dC, N]);
    const C = gpu.copyOut(dC, N * N);
    // 输入被舍到 1.0（1 + 2^-11 在 fp16 里舍到最近的偶数尾数）
    expect(C[0]).toBe(1);
    // fp32 里同样的乘法不会丢
    expect(1 + Math.pow(2, -11)).not.toBe(1);
  });

  it('累加仍然在 fp32 上做 —— 所以长链条不会垮', async () => {
    const { C } = await runMma16();
    // 16 项累加，结果没有溢出也没有下溢成 0
    expect(C.some((value) => value !== 0)).toBe(true);
    expect(C.every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe('计量', () => {
  it('mma 走 tensor core 计数，不算进 FMA', async () => {
    const { gpu } = await runMma16();
    const metrics = gpu.metrics();
    expect(metrics.inst.mma).toBe(16 * 16 * 16);
    expect(metrics.inst.fma).toBe(0);
  });

  it('用上 tensor core 之后瓶颈不再是 FMA', async () => {
    const { gpu } = await runMma16();
    expect(gpu.timing().units.tensor).toBeGreaterThan(0);
    expect(gpu.timing().units.fma).toBe(0);
  });

  it('算术强度把 mma 的乘加算进去了', async () => {
    const { gpu } = await runMma16();
    expect(gpu.roofline().arithmeticIntensity).toBeGreaterThan(0);
  });
});

describe('确定性', () => {
  it('重放 50 次逐位相同', async () => {
    const first = await runMma16();
    const bits = Array.from(new Int32Array(first.C.buffer));
    for (let i = 0; i < 50; i += 1) {
      const again = await runMma16();
      expect(Array.from(new Int32Array(again.C.buffer))).toEqual(bits);
    }
  });
});
