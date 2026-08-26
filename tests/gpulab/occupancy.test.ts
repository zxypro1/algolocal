/**
 * 寄存器、local memory 与占用率
 *
 * 第 6 关（occupancy 与寄存器压力）整关建立在这上面。那一关的坑是：
 * 起始代码里有个 `float tmp[8]` 被动态下标访问，于是溢出到 local memory ——
 * `ncu` 上看指令数正常、结果也对，**只有 local.bytes 不对**。
 *
 * 所以这里要证明两件事：
 *  1. 同一个数组，常量下标进寄存器、动态下标落 local memory；
 *  2. `gpu.local.bytes` 是精确的，而 `registersPerThread` 是估的 ——
 *     门槛该压在前者上。
 */
import { B200, GpuDevice, H100, computeOccupancy, compileSource, dim3 } from '../../src/lib/gpulab';

jest.setTimeout(120_000);

function device(): GpuDevice {
  return new GpuDevice({ globalBytes: 2 * 1024 * 1024 });
}

async function compileOne(source: string, name: string) {
  return (await compileSource(source)).get(name)!;
}

describe('线程私有数组：寄存器还是 local memory', () => {
  /**
   * 同一件事的两种写法：把 in 里连续 4 个数加进 acc，再求和。
   * 唯一的差别是下标 —— 一边是编译期常量，一边是循环变量。
   */
  const KERNEL = (dynamic: boolean) => `
    __global__ void tile(const float* in, float* out, int n) {
      int t = blockIdx.x * blockDim.x + threadIdx.x;
      float acc[4];
      acc[0] = 0.0f; acc[1] = 0.0f; acc[2] = 0.0f; acc[3] = 0.0f;
      ${dynamic
        ? 'for (int k = 0; k < 4; ++k) acc[k] = acc[k] + in[t * 4 + k];'
        : `acc[0] = acc[0] + in[t * 4 + 0];
           acc[1] = acc[1] + in[t * 4 + 1];
           acc[2] = acc[2] + in[t * 4 + 2];
           acc[3] = acc[3] + in[t * 4 + 3];`}
      out[t] = acc[0] + acc[1] + acc[2] + acc[3];
    }
  `;

  async function run(dynamic: boolean) {
    const kernel = await compileOne(KERNEL(dynamic), 'tile');
    const gpu = device();
    const n = 128;
    const din = gpu.malloc(n * 4 * 4);
    const dout = gpu.malloc(n * 4);
    gpu.copyIn(din, Float32Array.from({ length: n * 4 }, (_, i) => i % 7));
    gpu.launch(kernel, { grid: dim3(n / 64), block: dim3(64) }, [din, dout, n]);
    return { kernel, gpu, out: gpu.copyOut(dout, n) };
  }

  it('常量下标 → 一个字节的 local memory 都不用', async () => {
    const { kernel, gpu } = await run(false);
    expect(kernel.localBytes).toBe(0);
    expect(gpu.metrics().local.bytes).toBe(0);
  });

  it('**动态下标 → 整个数组落到 local memory**', async () => {
    const { kernel, gpu } = await run(true);
    expect(kernel.localBytes).toBe(4 * 4); // 4 个 float
    expect(gpu.metrics().local.bytes).toBeGreaterThan(0);
  });

  it('两种写法算出同一个结果 —— 差别只在它住在哪', async () => {
    const constant = await run(false);
    const dynamic = await run(true);
    expect(Array.from(dynamic.out)).toEqual(Array.from(constant.out));
  });

  it('落 local memory 之后寄存器数反而少了 —— 但那不是好事', async () => {
    const constant = await run(false);
    const dynamic = await run(true);
    // 数组搬走了，寄存器当然省下来，可代价是每次访问都要走显存。
    // 这就是为什么门槛不能只看寄存器数。
    expect(dynamic.kernel.registersPerThread)
      .toBeLessThanOrEqual(constant.kernel.registersPerThread);
    expect(dynamic.gpu.metrics().local.bytes).toBeGreaterThan(0);
    expect(constant.gpu.metrics().local.bytes).toBe(0);
  });

  it('取地址也会让数组落到 local memory —— 因为地址得是真地址', async () => {
    const kernel = await compileOne(`
      __global__ void addr(float* out) {
        float v[2];
        v[0] = 1.0f; v[1] = 2.0f;
        float* p = &v[0];
        out[threadIdx.x] = p[0] + p[1];
      }
    `, 'addr');
    expect(kernel.localBytes).toBe(8);
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    expect(gpu.copyOut(out, 32)[0]).toBe(3);
  });

  it('local memory 是线程私有的，不会被报成竞态', async () => {
    const kernel = await compileOne(`
      __global__ void priv(float* out, int n) {
        float buf[4];
        int t = threadIdx.x;
        for (int i = 0; i < n; ++i) buf[i] = (float)(t + i);
        float s = 0.0f;
        for (int i = 0; i < n; ++i) s += buf[i];
        out[t] = s;
      }
    `, 'priv');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    const report = gpu.launchWithRacecheck(kernel, { grid: dim3(1), block: dim3(32) }, [out, 4]);
    expect(report.races.length).toBe(0);
    expect(gpu.copyOut(out, 32)[5]).toBe(5 + 6 + 7 + 8);
  });

  it('常量下标越界在编译期就报', async () => {
    await expect(compileSource(`
      __global__ void oob(float* out) {
        float v[4];
        v[7] = 1.0f;
        out[0] = v[0];
      }
    `)).rejects.toThrow(/越界/);
  });
});

describe('占用率', () => {
  it('寄存器吃得多就是寄存器卡住了', async () => {
    const occ = computeOccupancy(H100, {
      threadsPerBlock: 256,
      registersPerThread: 128,
      sharedBytesPerBlock: 0,
    });
    // 65536 / (128*32) = 16 warp → 16/8 = 2 个 block → 16 warp / 64 = 25%
    expect(occ.limiter).toBe('registers');
    expect(occ.theoretical).toBeCloseTo(0.25, 3);
  });

  it('共享内存吃得多就是共享内存卡住了', async () => {
    const occ = computeOccupancy(H100, {
      threadsPerBlock: 128,
      registersPerThread: 32,
      sharedBytesPerBlock: 96 * 1024,
    });
    expect(occ.limiter).toBe('shared');
    expect(occ.blocksPerSm).toBe(2);
  });

  it('都不紧张时被 warp 上限卡住 —— 也就是满占用', async () => {
    const occ = computeOccupancy(H100, {
      threadsPerBlock: 256,
      registersPerThread: 32,
      sharedBytesPerBlock: 4 * 1024,
    });
    expect(occ.limiter).toBe('warps');
    expect(occ.theoretical).toBe(1);
  });

  it('真跑一个 kernel 之后占用率进指标树', async () => {
    const kernel = await compileOne(`
      __global__ void light(float* out) {
        out[blockIdx.x * blockDim.x + threadIdx.x] = 1.0f;
      }
    `, 'light');
    const gpu = device();
    const out = gpu.malloc(256 * 4);
    gpu.launch(kernel, { grid: dim3(4), block: dim3(64) }, [out]);
    const flat = gpu.flatMetrics();
    expect(flat['gpu.occupancy.theoretical']).toBeGreaterThan(0);
    expect(flat['gpu.registers.perThread']).toBeGreaterThan(0);
    expect(flat['gpu.occupancy.blocksPerSm']).toBeGreaterThan(0);
  });

  it('换一组硬件参数，kernel 一个字不用改', async () => {
    const source = `
      __global__ void k(float* out) {
        __shared__ float s[2048];
        int t = threadIdx.x;
        s[t] = (float)t;
        __syncthreads();
        out[t] = s[t];
      }
    `;
    const kernel = await compileOne(source, 'k');
    const hopper = new GpuDevice({ globalBytes: 1024 * 1024, device: H100, sharedBytesPerBlock: 96 * 1024 });
    const blackwell = new GpuDevice({ globalBytes: 1024 * 1024, device: B200, sharedBytesPerBlock: 96 * 1024 });
    for (const gpu of [hopper, blackwell]) {
      const out = gpu.malloc(64 * 4);
      gpu.launch(kernel, { grid: dim3(1), block: dim3(64) }, [out]);
    }
    // 两组参数上占用率一致（这两条限制在两代之间没变），但设备名不同
    expect(hopper.device.name).toContain('H100');
    expect(blackwell.device.name).toContain('B200');
    expect(hopper.staticMetrics()!.occupancy.theoretical)
      .toBe(blackwell.staticMetrics()!.occupancy.theoretical);
  });
});

describe('寄存器估计', () => {
  it('用的变量越多，估出来的寄存器越多', async () => {
    const simple = await compileOne(`
      __global__ void a(float* out) { out[threadIdx.x] = 1.0f; }
    `, 'a');
    const heavy = await compileOne(`
      __global__ void a(const float* in, float* out) {
        int t = threadIdx.x;
        float a0 = in[t + 0]; float a1 = in[t + 1]; float a2 = in[t + 2]; float a3 = in[t + 3];
        float a4 = in[t + 4]; float a5 = in[t + 5]; float a6 = in[t + 6]; float a7 = in[t + 7];
        // 全部同时活着 —— 到最后才用
        out[t] = a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7;
      }
    `, 'a');
    expect(heavy.registersPerThread).toBeGreaterThan(simple.registersPerThread);
  });

  it('用完就丢的临时值不会一直占着寄存器', async () => {
    const chained = await compileOne(`
      __global__ void a(const float* in, float* out) {
        int t = threadIdx.x;
        // 每一步都吃掉上一步的结果，活跃集合始终很小
        float v = in[t];
        v = v * 2.0f; v = v + 1.0f; v = v * 3.0f; v = v + 2.0f;
        v = v * 4.0f; v = v + 3.0f; v = v * 5.0f; v = v + 4.0f;
        out[t] = v;
      }
    `, 'a');
    // 长链条不该比同样长度的并行加法吃更多寄存器
    expect(chained.registersPerThread).toBeLessThan(16);
  });
});
