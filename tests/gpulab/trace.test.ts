/**
 * 访存轨迹
 *
 * 这套用例钉住的是**图上会看到什么**：合并的时候 32 个 lane 挤进 4 个扇区，
 * 不合并的时候散成 32 个；共享内存里同地址是广播不是冲突。
 * 这三条正是访存面板存在的理由 —— 真卡上 ncu 只给聚合数，看不见分布。
 */
import { AccessTrace, GpuDevice, banksOf, compileSource, dim3, sectorsOf } from '../../src/lib/gpulab';

jest.setTimeout(180_000);

async function trace(source: string, name: string, n = 32) {
  const kernel = (await compileSource(source)).get(name)!;
  const gpu = new GpuDevice({ globalBytes: 1024 * 1024 });
  const din = gpu.malloc(4096 * 4);
  const dout = gpu.malloc(4096 * 4);
  gpu.copyIn(din, Float32Array.from({ length: 4096 }, (_, i) => i));
  const collector = new AccessTrace();
  gpu.launchWithTrace(kernel, { grid: dim3(1), block: dim3(32) }, [din, dout, n], collector);
  return { collector, gpu };
}

describe('全局访存的分布', () => {
  it('**合并的时候 32 个 lane 挤进 4 个扇区**', async () => {
    const { collector } = await trace(`
      __global__ void seq(const float* in, float* out, int n) {
        int i = threadIdx.x;
        if (i < n) out[i] = in[i];
      }
    `, 'seq');
    const loads = collector.records.filter((r) => r.kind === 'load' && r.space === 'global');
    expect(loads.length).toBe(1);
    const view = sectorsOf(loads[0]);
    // 32 个 float = 128 字节 = 4 个 32B 扇区
    expect(view.length).toBe(4);
    expect(view[0].lanes).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(loads[0].sectors).toBe(4);
  });

  it('**跨步访问散成 32 个扇区** —— 一眼看得出为什么慢 8 倍', async () => {
    const { collector } = await trace(`
      __global__ void strided(const float* in, float* out, int n) {
        int i = threadIdx.x;
        if (i < n) out[i] = in[i * 32];
      }
    `, 'strided');
    const loads = collector.records.filter((r) => r.kind === 'load' && r.space === 'global');
    const view = sectorsOf(loads[0]);
    expect(view.length).toBe(32);
    // 每个扇区只有一个 lane —— 搬了 32 × 32 字节，用上的只有 32 × 4
    expect(view.every((item) => item.lanes.length === 1)).toBe(true);
    expect(loads[0].sectors).toBe(32);
  });

  it('不活跃的 lane 在图上是空的，不是 0 号地址', async () => {
    const { collector } = await trace(`
      __global__ void half(const float* in, float* out, int n) {
        int i = threadIdx.x;
        if (i < n) out[i] = in[i];
      }
    `, 'half', 8);
    const loads = collector.records.filter((r) => r.kind === 'load' && r.space === 'global');
    const record = loads[0];
    for (let lane = 8; lane < 32; lane += 1) expect(record.addresses[lane]).toBe(-1);
    expect(sectorsOf(record).length).toBe(1);
  });
});

describe('共享内存的 bank 分布', () => {
  it('**同一个 bank 里同地址是广播，不算冲突**', async () => {
    const { collector } = await trace(`
      __global__ void broadcast(const float* in, float* out, int n) {
        __shared__ float s[32];
        int i = threadIdx.x;
        s[i] = in[i];
        __syncthreads();
        // 32 个 lane 都读 s[0]：同一个 bank、同一个地址 —— 一次广播
        out[i] = s[0];
      }
    `, 'broadcast');
    const reads = collector.records.filter((r) => r.space === 'shared' && r.kind === 'load');
    const last = reads[reads.length - 1];
    const banks = banksOf(last);
    const bank0 = banks[0];
    expect(bank0.groups.length).toBe(1);
    expect(bank0.groups[0].lanes.length).toBe(32);
    // 一个地址 = 一路，不是 32 路
    expect(bank0.ways).toBe(1);
    expect(last.bankConflicts).toBe(0);
  });

  it('**同一个 bank 里不同地址才是冲突**', async () => {
    const { collector } = await trace(`
      __global__ void conflict(const float* in, float* out, int n) {
        __shared__ float s[1024];
        int i = threadIdx.x;
        s[i * 32] = in[i];
        __syncthreads();
        out[i] = s[i * 32];
      }
    `, 'conflict');
    const reads = collector.records.filter((r) => r.space === 'shared' && r.kind === 'load');
    const last = reads[reads.length - 1];
    const banks = banksOf(last);
    // 步长 32 个 float 让所有 lane 落到同一个 bank，而且地址各不相同
    const busy = banks.filter((bank) => bank.ways > 0);
    expect(busy.length).toBe(1);
    expect(busy[0].ways).toBe(32);
    expect(last.bankConflicts).toBe(31);
  });
});

describe('轨迹本身的边界', () => {
  it('超出上限如实报告丢了多少，不悄悄截断', async () => {
    const collector = new AccessTrace({ limit: 4 });
    const kernel = (await compileSource(`
      __global__ void many(const float* in, float* out, int n) {
        int i = threadIdx.x;
        for (int k = 0; k < 20; ++k) out[i] = out[i] + in[i];
      }
    `)).get('many')!;
    const gpu = new GpuDevice({ globalBytes: 65536 });
    const din = gpu.malloc(128);
    const dout = gpu.malloc(128);
    gpu.launchWithTrace(kernel, { grid: dim3(1), block: dim3(32) }, [din, dout, 32], collector);
    expect(collector.records.length).toBe(4);
    expect(collector.truncated).toBeGreaterThan(0);
  });

  it('**采样不会冲掉真实那一遍的指标**', async () => {
    const kernel = (await compileSource(`
      __global__ void seq(const float* in, float* out, int n) {
        int i = threadIdx.x;
        if (i < n) out[i] = in[i];
      }
    `)).get('seq')!;
    const gpu = new GpuDevice({ globalBytes: 65536 });
    const din = gpu.malloc(128);
    const dout = gpu.malloc(128);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [din, dout, 32]);
    const before = JSON.stringify(gpu.metrics());
    gpu.launchWithTrace(kernel, { grid: dim3(1), block: dim3(32) }, [din, dout, 32], new AccessTrace());
    expect(JSON.stringify(gpu.metrics())).toBe(before);
  });

  it('不开轨迹时记录是空的', async () => {
    const kernel = (await compileSource(`
      __global__ void seq(const float* in, float* out, int n) {
        int i = threadIdx.x;
        if (i < n) out[i] = in[i];
      }
    `)).get('seq')!;
    const gpu = new GpuDevice({ globalBytes: 65536 });
    const din = gpu.malloc(128);
    const dout = gpu.malloc(128);
    const collector = new AccessTrace();
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [din, dout, 32]);
    expect(collector.records.length).toBe(0);
  });
});
