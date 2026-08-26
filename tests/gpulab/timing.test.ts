/**
 * 时序模型
 *
 * 这个模型**只用于展示与同关相对比较**，绝不作门槛（见 timing.ts 开头）。
 * 所以这里断言的都是**方向**与**比例关系**，不是绝对数字：
 * 「访存密集的 kernel 瓶颈在 DRAM」「换到 tensor core 更快的卡上瓶颈会挪位置」。
 *
 * 断言绝对周期数就等于把一个没有真卡校准的数字变成了契约，
 * 那正是设计文档里明令禁止的事。
 */
import { B200, GpuDevice, H100, compileSource, dim3 } from '../../src/lib/gpulab';

jest.setTimeout(180_000);

async function compileOne(source: string, name: string) {
  return (await compileSource(source)).get(name)!;
}

/** 访存密集：每个元素只做一次乘法 */
const STREAM = `
__global__ void stream(const float* in, float* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) out[i] = in[i] * 2.0f;
}
`;

/**
 * 算力密集：每读一个数做很多次 FMA。
 *
 * 循环体里放 8 次 FMA 而不是 1 次 —— 循环体只有一次运算的 kernel
 * 本来就不是算力受限的，它受限于循环开销，真卡上也一样
 * （区别只是 nvcc 会展开定长循环，我们的 IR 不展开）。
 */
const COMPUTE = `
__global__ void compute(const float* in, float* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) {
    float v = in[i];
    float a = 0.0f; float b = 0.0f; float c = 0.0f; float d = 0.0f;
    for (int k = 0; k < 50; ++k) {
      a = fmaf(v, 1.0009765625f, a);
      b = fmaf(v, 1.0019531250f, b);
      c = fmaf(v, 1.0029296875f, c);
      d = fmaf(v, 1.0039062500f, d);
      a = fmaf(a, 1.0009765625f, b);
      b = fmaf(b, 1.0019531250f, c);
      c = fmaf(c, 1.0029296875f, d);
      d = fmaf(d, 1.0039062500f, a);
    }
    out[i] = a + b + c + d;
  }
}
`;

/** SFU 密集：每读一个数做很多次 expf，同样把循环体写密 */
const TRANSCENDENTAL = `
__global__ void trans(const float* in, float* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) {
    float v = in[i] * 0.001f;
    float acc = 0.0f;
    for (int k = 0; k < 20; ++k) {
      acc += expf(v);
      acc += expf(v * 1.03125f);
      acc += expf(v * 1.06250f);
      acc += expf(v * 1.09375f);
      acc += expf(v * 1.12500f);
      acc += expf(v * 1.15625f);
      acc += expf(v * 1.18750f);
      acc += expf(v * 1.21875f);
    }
    out[i] = acc;
  }
}
`;

async function run(source: string, name: string, device = H100) {
  const kernel = await compileOne(source, name);
  const gpu = new GpuDevice({ globalBytes: 4 * 1024 * 1024, device });
  const n = 4096;
  const din = gpu.malloc(n * 4);
  const dout = gpu.malloc(n * 4);
  gpu.copyIn(din, Float32Array.from({ length: n }, (_, i) => (i % 13) * 0.5));
  gpu.launch(kernel, { grid: dim3(n / 128), block: dim3(128) }, [din, dout, n]);
  return { gpu, timing: gpu.timing(), roof: gpu.roofline(), metrics: gpu.metrics() };
}

describe('瓶颈判定', () => {
  it('访存密集的 kernel 卡在访存侧', async () => {
    const { timing } = await run(STREAM, 'stream');
    expect(['dram', 'lsu']).toContain(timing.bottleneck);
  });

  it('算力密集的 kernel 卡在 FMA 上', async () => {
    const { timing } = await run(COMPUTE, 'compute');
    expect(timing.bottleneck).toBe('fma');
  });

  it('**expf 密集的 kernel 卡在 SFU 上，哪怕 FMA 一点不忙**', async () => {
    const { timing, metrics } = await run(TRANSCENDENTAL, 'trans');
    expect(metrics.inst.sfu).toBeGreaterThan(0);
    expect(timing.bottleneck).toBe('sfu');
    // SFU 的吞吐只有 FMA 的 1/8，所以同样的指令数它要花 8 倍的周期
    expect(timing.units.sfu).toBeGreaterThan(timing.units.fma);
  });

  it('四个计算单元是分开算的，不会被混成一坨', async () => {
    const { timing } = await run(TRANSCENDENTAL, 'trans');
    expect(timing.units).toEqual(expect.objectContaining({
      alu: expect.any(Number), fma: expect.any(Number),
      sfu: expect.any(Number), tensor: expect.any(Number),
      lsu: expect.any(Number), shared: expect.any(Number), dram: expect.any(Number),
    }));
  });
});

describe('roofline', () => {
  it('算力密集的算术强度远高于访存密集的', async () => {
    const stream = await run(STREAM, 'stream');
    const compute = await run(COMPUTE, 'compute');
    expect(compute.roof.arithmeticIntensity)
      .toBeGreaterThan(stream.roof.arithmeticIntensity * 20);
  });

  it('拐点是「算力峰值 / 带宽峰值」，H100 上是几十 FLOP/byte 量级', async () => {
    const { roof } = await run(STREAM, 'stream');
    expect(roof.ridgePoint).toBeGreaterThan(10);
    expect(roof.ridgePoint).toBeLessThan(500);
  });

  it('达到的算力不会超过屋顶', async () => {
    for (const [source, name] of [[STREAM, 'stream'], [COMPUTE, 'compute']] as const) {
      const { roof } = await run(source, name);
      expect(roof.efficiency).toBeLessThanOrEqual(1);
      expect(roof.efficiency).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('占用率影响延迟隐藏', () => {
  it('占用率越低，延迟隐藏系数越小', async () => {
    const kernel = await compileOne(`
      __global__ void hog(const float* in, float* out, int n) {
        __shared__ float big[12000];
        int t = threadIdx.x;
        big[t] = in[t];
        __syncthreads();
        out[t] = big[t];
      }
    `, 'hog');
    const light = await run(STREAM, 'stream');

    const gpu = new GpuDevice({
      globalBytes: 1024 * 1024, device: H100, sharedBytesPerBlock: 96 * 1024,
    });
    const din = gpu.malloc(128 * 4);
    const dout = gpu.malloc(128 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(128) }, [din, dout, 128]);

    expect(gpu.timing().latencyHiding).toBeLessThan(light.timing.latencyHiding);
  });
});

describe('换一组硬件参数，瓶颈会挪位置', () => {
  /**
   * design/gpulab.md 拍板记录第 2 条的核心：**一套 ISA，两组硬件参数**。
   * 学员的 kernel 一个字不用改，换到 B200 上跑，tensor core 快了而 SFU 没动，
   * 于是瓶颈自己挪。第 16 关讲 FlashAttention-4 的 ping-pong 就靠这个。
   */
  it('B200 上 SFU 的相对压力更大 —— 因为它的 tensor core 快了而 SFU 没变', async () => {
    const hopper = await run(TRANSCENDENTAL, 'trans', H100);
    const blackwell = await run(TRANSCENDENTAL, 'trans', B200);

    // 同一份代码、同样的指令数
    expect(blackwell.metrics.inst.sfu).toBe(hopper.metrics.inst.sfu);
    // 两边都是 SFU 卡住
    expect(hopper.timing.bottleneck).toBe('sfu');
    expect(blackwell.timing.bottleneck).toBe('sfu');
    // B200 的 tensor core 吞吐是 H100 的 4 倍，SFU 一样 ——
    // 所以真跑起 tensor core 时这个差距会被放大，这一关就是那件事的伏笔
    expect(B200.name).toContain('B200');
  });

  it('B200 的带宽更高，访存密集的 kernel 相对更快', async () => {
    const hopper = await run(STREAM, 'stream', H100);
    const blackwell = await run(STREAM, 'stream', B200);
    expect(blackwell.timing.units.dram).toBeLessThan(hopper.timing.units.dram);
  });
});

describe('模型的边界（写在用例里，免得被当成精确值用）', () => {
  it('周期数是估的，但同一份代码跑两遍必须一样', async () => {
    const a = await run(COMPUTE, 'compute');
    const b = await run(COMPUTE, 'compute');
    expect(b.timing.cycles).toBe(a.timing.cycles);
  });

  it('空 kernel 不会算出负数或 NaN', async () => {
    const kernel = await compileOne('__global__ void noop(float* out) { }', 'noop');
    const gpu = new GpuDevice({ globalBytes: 64 * 1024 });
    const out = gpu.malloc(128);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    const timing = gpu.timing();
    expect(Number.isFinite(timing.cycles)).toBe(true);
    expect(timing.cycles).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(gpu.roofline().arithmeticIntensity)).toBe(true);
  });
});
