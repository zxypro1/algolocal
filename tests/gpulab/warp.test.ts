/**
 * warp 原语与原子操作
 *
 * 第 5 关（发散与 warp 原语）直接建立在这上面，后面 softmax、LayerNorm、
 * FlashAttention 的行内归并也全靠它。
 *
 * 用例分两类：**语义对不对**（shuffle 的段边界、ballot 的参与者）、
 * 以及**门槛能不能成立**（shuffle 规约与 atomic 规约算出同样的结果，
 * 但 `gpu.atomics` 差两个数量级）。
 */
import { GpuDevice, compileSource, dim3 } from '../../src/lib/gpulab';

jest.setTimeout(120_000);

function device(): GpuDevice {
  return new GpuDevice({ globalBytes: 2 * 1024 * 1024 });
}

async function compileOne(source: string, name: string) {
  return (await compileSource(source)).get(name)!;
}

describe('__shfl_*_sync', () => {
  it('xor：蝶形交换，段内按位异或取源 lane', async () => {
    const kernel = await compileOne(`
      __global__ void butterfly(int* out, int delta) {
        int t = threadIdx.x;
        int v = t * 10;
        out[t] = __shfl_xor_sync(0xffffffff, v, delta);
      }
    `, 'butterfly');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    for (const delta of [1, 2, 4, 16]) {
      gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out, delta]);
      const values = gpu.copyOutInts(out, 32);
      for (let t = 0; t < 32; t += 1) expect(values[t]).toBe((t ^ delta) * 10);
    }
  });

  it('down：往上取，越出 warp 就原地不动', async () => {
    const kernel = await compileOne(`
      __global__ void down(int* out) {
        int t = threadIdx.x;
        out[t] = __shfl_down_sync(0xffffffff, t * 10, 4);
      }
    `, 'down');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    const values = gpu.copyOutInts(out, 32);
    for (let t = 0; t < 32; t += 1) {
      // t + 4 越界的那几个 lane 拿回自己的值，和真硬件一致
      expect(values[t]).toBe(t + 4 < 32 ? (t + 4) * 10 : t * 10);
    }
  });

  it('up：往下取，越出就原地不动', async () => {
    const kernel = await compileOne(`
      __global__ void up(int* out) {
        int t = threadIdx.x;
        out[t] = __shfl_up_sync(0xffffffff, t * 10, 3);
      }
    `, 'up');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    const values = gpu.copyOutInts(out, 32);
    for (let t = 0; t < 32; t += 1) {
      expect(values[t]).toBe(t - 3 >= 0 ? (t - 3) * 10 : t * 10);
    }
  });

  it('idx：广播 —— 所有 lane 取同一个源', async () => {
    const kernel = await compileOne(`
      __global__ void bcast(int* out) {
        int t = threadIdx.x;
        out[t] = __shfl_sync(0xffffffff, t * 10, 7);
      }
    `, 'bcast');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    const values = gpu.copyOutInts(out, 32);
    for (let t = 0; t < 32; t += 1) expect(values[t]).toBe(70);
  });

  it('width 把 warp 切成段，段之间互不串门', async () => {
    const kernel = await compileOne(`
      __global__ void seg(int* out) {
        int t = threadIdx.x;
        // width=8：0..7 一段、8..15 一段，以此类推
        out[t] = __shfl_sync(0xffffffff, t, 0, 8);
      }
    `, 'seg');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    const values = gpu.copyOutInts(out, 32);
    for (let t = 0; t < 32; t += 1) expect(values[t]).toBe((t >> 3) << 3);
  });

  it('dst 和 src 是同一个变量也不会互相踩', async () => {
    const kernel = await compileOne(`
      __global__ void inplace(int* out) {
        int v = threadIdx.x;
        v = __shfl_xor_sync(0xffffffff, v, 1);
        out[threadIdx.x] = v;
      }
    `, 'inplace');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    const values = gpu.copyOutInts(out, 32);
    for (let t = 0; t < 32; t += 1) expect(values[t]).toBe(t ^ 1);
  });

  it('float 也能交换，位模式原样过去', async () => {
    const kernel = await compileOne(`
      __global__ void f(float* out) {
        int t = threadIdx.x;
        float v = (float)t * 0.25f;
        out[t] = __shfl_xor_sync(0xffffffff, v, 1);
      }
    `, 'f');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    const values = gpu.copyOut(out, 32);
    for (let t = 0; t < 32; t += 1) expect(values[t]).toBe((t ^ 1) * 0.25);
  });

  it('读一个不参与的 lane 会被记成 warp 同步错误', async () => {
    const kernel = await compileOne(`
      __global__ void bad(int* out) {
        int t = threadIdx.x;
        // 掩码只点了低 16 个 lane，却让每个 lane 都去读 t+16
        out[t] = __shfl_sync(0x0000ffff, t, t + 16);
      }
    `, 'bad');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    expect(gpu.metrics().warp.syncErrors).toBeGreaterThan(0);
  });
});

describe('__ballot_sync / __any_sync / __all_sync / __activemask', () => {
  it('ballot 把谓词收成掩码', async () => {
    const kernel = await compileOne(`
      __global__ void vote(unsigned* out) {
        int t = threadIdx.x;
        out[t] = __ballot_sync(0xffffffff, (t % 3) == 0);
      }
    `, 'vote');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    let expected = 0;
    for (let t = 0; t < 32; t += 1) if (t % 3 === 0) expected |= 1 << t;
    const values = gpu.copyOutInts(out, 32);
    for (let t = 0; t < 32; t += 1) expect(values[t] >>> 0).toBe(expected >>> 0);
  });

  it('__popc 数出投票里有几个 —— 和 ballot 配套用', async () => {
    const kernel = await compileOne(`
      __global__ void count(int* out) {
        int t = threadIdx.x;
        unsigned m = __ballot_sync(0xffffffff, (t & 1) == 0);
        out[t] = __popc(m);
      }
    `, 'count');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    expect(Array.from(gpu.copyOutInts(out, 32))).toEqual(new Array(32).fill(16));
  });

  it('any / all', async () => {
    const kernel = await compileOne(`
      __global__ void votes(int* out) {
        int t = threadIdx.x;
        out[t] = __any_sync(0xffffffff, t == 7) * 10 + __all_sync(0xffffffff, t < 32);
      }
    `, 'votes');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    expect(Array.from(gpu.copyOutInts(out, 32))).toEqual(new Array(32).fill(11));
  });

  it('__activemask 在分歧区里只报当前这一拨', async () => {
    const kernel = await compileOne(`
      __global__ void mask(unsigned* out) {
        int t = threadIdx.x;
        unsigned m = 0;
        if (t < 8) { m = __activemask(); } else { m = __activemask(); }
        out[t] = m;
      }
    `, 'mask');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    const values = gpu.copyOutInts(out, 32);
    expect(values[0] >>> 0).toBe(0x000000ff);
    expect(values[10] >>> 0).toBe(0xffffff00);
  });
});

describe('原子操作', () => {
  it('atomicAdd 返回旧值，累加结果正确', async () => {
    const kernel = await compileOne(`
      __global__ void bump(int* counter, int* olds) {
        int t = blockIdx.x * blockDim.x + threadIdx.x;
        olds[t] = atomicAdd(counter, 1);
      }
    `, 'bump');
    const gpu = device();
    const counter = gpu.malloc(4);
    const olds = gpu.malloc(128 * 4);
    gpu.copyInInts(counter, [0]);
    gpu.launch(kernel, { grid: dim3(4), block: dim3(32) }, [counter, olds]);
    expect(gpu.copyOutInts(counter, 1)[0]).toBe(128);
    // 128 个旧值恰好是 0..127 的一个排列
    expect(Array.from(gpu.copyOutInts(olds, 128)).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 128 }, (_, i) => i));
  });

  it('atomicMax / atomicCAS', async () => {
    const kernel = await compileOne(`
      __global__ void ops(int* mx, int* slot) {
        int t = threadIdx.x;
        atomicMax(mx, t * 3);
        // 只有第一个把 0 换成自己 tid 的线程会成功
        atomicCAS(slot, 0, t + 1);
      }
    `, 'ops');
    const gpu = device();
    const mx = gpu.malloc(4);
    const slot = gpu.malloc(4);
    gpu.copyInInts(mx, [0]);
    gpu.copyInInts(slot, [0]);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [mx, slot]);
    expect(gpu.copyOutInts(mx, 1)[0]).toBe(93);
    expect(gpu.copyOutInts(slot, 1)[0]).toBe(1);
  });

  it('float 的 atomicAdd 走 fp32 累加', async () => {
    const kernel = await compileOne(`
      __global__ void fadd(float* total) {
        atomicAdd(total, 0.5f);
      }
    `, 'fadd');
    const gpu = device();
    const total = gpu.malloc(4);
    gpu.copyIn(total, [0]);
    gpu.launch(kernel, { grid: dim3(2), block: dim3(32) }, [total]);
    expect(gpu.copyOut(total, 1)[0]).toBe(32);
  });

  it('共享内存上的原子操作打到共享地址空间', async () => {
    const kernel = await compileOne(`
      __global__ void shmem(int* out) {
        __shared__ int hist[4];
        int t = threadIdx.x;
        if (t < 4) hist[t] = 0;
        __syncthreads();
        atomicAdd(&hist[t % 4], 1);
        __syncthreads();
        if (t < 4) out[t] = hist[t];
      }
    `, 'shmem');
    const gpu = device();
    const out = gpu.malloc(4 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(64) }, [out]);
    expect(Array.from(gpu.copyOutInts(out, 4))).toEqual([16, 16, 16, 16]);
  });

  it('**原子操作不该被 racecheck 报成竞态** —— 它本来就是并发更新的正确做法', async () => {
    const kernel = await compileOne(`
      __global__ void safe(int* counter) {
        atomicAdd(counter, 1);
      }
    `, 'safe');
    const gpu = device();
    const counter = gpu.malloc(4);
    gpu.copyInInts(counter, [0]);
    const report = gpu.launchWithRacecheck(kernel, { grid: dim3(4), block: dim3(32) }, [counter]);
    expect(report.races.length).toBe(0);
  });
});

describe('规约：门槛能不能证明「换了做法」', () => {
  const ATOMIC_REDUCE = `
    __global__ void reduce(const float* in, float* out) {
      int t = blockIdx.x * blockDim.x + threadIdx.x;
      atomicAdd(out, in[t]);
    }
  `;

  const SHUFFLE_REDUCE = `
    __global__ void reduce(const float* in, float* out) {
      int t = blockIdx.x * blockDim.x + threadIdx.x;
      float v = in[t];
      // warp 内蝶形规约：5 步把 32 个值收成 1 个
      v += __shfl_xor_sync(0xffffffff, v, 16);
      v += __shfl_xor_sync(0xffffffff, v, 8);
      v += __shfl_xor_sync(0xffffffff, v, 4);
      v += __shfl_xor_sync(0xffffffff, v, 2);
      v += __shfl_xor_sync(0xffffffff, v, 1);
      // 每个 warp 只出一次 atomic
      if ((threadIdx.x & 31) == 0) atomicAdd(out, v);
    }
  `;

  async function run(source: string) {
    const kernel = await compileOne(source, 'reduce');
    const gpu = device();
    const n = 1024;
    const din = gpu.malloc(n * 4);
    const dout = gpu.malloc(4);
    gpu.copyIn(din, Float32Array.from({ length: n }, () => 0.5));
    gpu.copyIn(dout, [0]);
    gpu.launch(kernel, { grid: dim3(n / 128), block: dim3(128) }, [din, dout]);
    return { total: gpu.copyOut(dout, 1)[0], metrics: gpu.metrics() };
  }

  it('两种做法算出同一个和，但原子操作次数差两个数量级', async () => {
    const naive = await run(ATOMIC_REDUCE);
    const fast = await run(SHUFFLE_REDUCE);

    expect(naive.total).toBe(512);
    expect(fast.total).toBe(512);

    // 1024 个线程各来一次 vs 每个 warp 一次
    expect(naive.metrics.atomics).toBe(1024);
    expect(fast.metrics.atomics).toBe(1024 / 32);
    expect(fast.metrics.warp.shuffles).toBeGreaterThan(0);
  });

  it('shuffle 版一次共享内存都不用', async () => {
    const fast = await run(SHUFFLE_REDUCE);
    expect(fast.metrics.shared.loadRequests).toBe(0);
    expect(fast.metrics.shared.storeRequests).toBe(0);
  });
});

describe('确定性', () => {
  it('原子操作的顺序是定死的 —— 重放两次逐位相同', async () => {
    // 真卡上 atomicAdd(float*) 的完成顺序不定，同样的输入会给出不同的位模式。
    // 我们按 lane 号定序，因此可复现 —— 这是一处**已知分叉**，
    // primer 里要专门讲，否则学员学不到「为什么 loss 曲线对不上」。
    const kernel = await compileOne(`
      __global__ void acc(const float* in, float* out) {
        int t = blockIdx.x * blockDim.x + threadIdx.x;
        atomicAdd(out, in[t]);
      }
    `, 'acc');
    const n = 256;
    const input = Float32Array.from({ length: n }, (_, i) => Math.sin(i) * 1e6);
    const once = () => {
      const gpu = device();
      const din = gpu.malloc(n * 4);
      const dout = gpu.malloc(4);
      gpu.copyIn(din, input);
      gpu.copyIn(dout, [0]);
      gpu.launch(kernel, { grid: dim3(n / 64), block: dim3(64) }, [din, dout]);
      return new Int32Array(gpu.copyOut(dout, 1).buffer)[0];
    };
    const first = once();
    for (let i = 0; i < 50; i += 1) expect(once()).toBe(first);
  });
});
