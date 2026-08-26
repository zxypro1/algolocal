/**
 * CUDA 前端 + warp 锁步 VM
 *
 * 这一套用例要回答三个问题，第三个是整个方案的命门：
 *  1. 真 CUDA 语法能不能编、能不能算对；
 *  2. 发散、屏障、共享内存的语义对不对；
 *  3. **访存计量能不能证明「优化真的生效」** —— 也就是同一段逻辑换个下标，
 *     扇区数是不是真的塌下去。门槛全建立在这上面。
 */
import {
  CudaCompileError, CudaSyntaxError, GpuDevice, KernelError,
  compileSource, dim3,
} from '../../src/lib/gpulab';

jest.setTimeout(120_000);

/** 每关的规模都小，一台 4MB 的设备足够，建起来也快 */
function device(): GpuDevice {
  return new GpuDevice({ globalBytes: 4 * 1024 * 1024 });
}

async function compileOne(source: string, name: string) {
  const kernels = await compileSource(source);
  const kernel = kernels.get(name);
  if (!kernel) throw new Error(`没编出 ${name}，只有 ${[...kernels.keys()].join(', ')}`);
  return kernel;
}

describe('CUDA 前端', () => {
  it('解析真实写法的 kernel：限定符、共享内存、内建变量、启动配置', async () => {
    const kernels = await compileSource(`
      __global__ void saxpy(const float* __restrict__ x, float* y, float a, int n) {
        int i = blockIdx.x * blockDim.x + threadIdx.x;
        if (i < n) {
          y[i] = fmaf(a, x[i], y[i]);
        }
      }
    `);
    expect([...kernels.keys()]).toEqual(['saxpy']);
    const kernel = kernels.get('saxpy')!;
    expect(kernel.params.map((p) => p.name)).toEqual(['x', 'y', 'a', 'n']);
    expect(kernel.params[0].isPointer).toBe(true);
    expect(kernel.params[2].isPointer).toBe(false);
  });

  it('语法错误报在出错的那一行，而不是让它悄悄编过去', async () => {
    await expect(compileSource(`
      __global__ void k(float* a) {
        a[0] = 1.0f
      }
    `)).rejects.toThrow(CudaSyntaxError);
  });

  it('子集之外的语法明确报「暂不支持」，并说清替代做法', async () => {
    const cases: Array<[string, RegExp]> = [
      ['__global__ void k(float* a) { struct P { int x; }; }', /暂不支持|struct/],
      ['__global__ void k(float* a) { double d = 1.0; }', /double/],
      ['__global__ void k(float* a) { for (int i=0;i<4;++i) { break; } }', /break/],
      // __device__ 函数现在支持了（编译期内联，见 tests/gpulab/host.test.ts）。
      // 换成还没做的：函数里的提前 return 在设备侧需要按层保存的退出掩码。
      ['__device__ int f(int x) { if (x > 0) { return 1; } return 0; }\n'
        + '__global__ void k(int* a) { a[0] = f(a[0]); }', /退出掩码/],
      ['__global__ void k(float* a) { extern __shared__ float s[]; }', /extern|动态共享内存/],
      // 线程私有数组现在支持了（常量下标进寄存器、动态下标落 local memory），
      // 这一行换成还没做的：数组初始化列表
      ['__global__ void k(float* a) { float t[2] = {1.0f, 2.0f}; a[0] = t[0]; }', /初始化列表|暂不支持/],
    ];
    for (const [source, pattern] of cases) {
      await expect(compileSource(source)).rejects.toThrow(pattern);
    }
  });

  it('调用没实现的函数会列出有哪些内建函数可用', async () => {
    // __ldg 是只读缓存加载，还没做（等缓存模型那一片）
    await expect(compileSource(`
      __global__ void k(const float* a, float* out) { out[0] = __ldg(&a[0]); }
    `)).rejects.toThrow(CudaCompileError);
  });
});

describe('算术与控制流', () => {
  it('saxpy 算对，且尾块不越界', async () => {
    const kernel = await compileOne(`
      __global__ void saxpy(const float* x, float* y, float a, int n) {
        int i = blockIdx.x * blockDim.x + threadIdx.x;
        if (i < n) y[i] = a * x[i] + y[i];
      }
    `, 'saxpy');

    const n = 100; // 故意不是 32 的整数倍
    const gpu = device();
    const dx = gpu.malloc(n * 4);
    const dy = gpu.malloc(n * 4);
    const x = Float32Array.from({ length: n }, (_, i) => i * 0.5);
    const y = Float32Array.from({ length: n }, (_, i) => i * 0.25);
    gpu.copyIn(dx, x);
    gpu.copyIn(dy, y);

    gpu.launch(kernel, { grid: dim3(4), block: dim3(32) }, [dx, dy, 2.0, n]);

    const out = gpu.copyOut(dy, n);
    for (let i = 0; i < n; i += 1) {
      expect(out[i]).toBeCloseTo(2.0 * x[i] + y[i], 5);
    }
  });

  it('fp32 的舍入是真的 —— 结果和 float64 不一样', async () => {
    const kernel = await compileOne(`
      __global__ void acc(float* out, int n) {
        float sum = 0.0f;
        for (int i = 0; i < n; ++i) sum += 0.1f;
        out[0] = sum;
      }
    `, 'acc');

    const gpu = device();
    const out = gpu.malloc(4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(1) }, [out, 1000]);
    const value = gpu.copyOut(out, 1)[0];

    // fp32 累加 1000 个 0.1f 会明显偏离 100
    expect(value).not.toBe(100);
    expect(Math.abs(value - 100)).toBeGreaterThan(1e-4);
    // 但仍然在合理范围内 —— 不是算错了，是精度就这样
    expect(value).toBeCloseTo(100, 1);
  });

  it('循环里 lane 陆续退出，各自停在自己的迭代次数上', async () => {
    const kernel = await compileOne(`
      __global__ void tri(int* out) {
        int t = threadIdx.x;
        int c = 0;
        for (int i = 0; i < t; ++i) c += 1;
        out[t] = c;
      }
    `, 'tri');

    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    const values = gpu.copyOutInts(out, 32);
    for (let i = 0; i < 32; i += 1) expect(values[i]).toBe(i);
  });

  it('三目与短路：右边只在该走的 lane 上求值，不会越界读', async () => {
    const kernel = await compileOne(`
      __global__ void guard(const float* a, float* out, int n) {
        int i = threadIdx.x;
        // i >= n 时不许去读 a[i] —— 短路必须是真的
        out[i] = (i < n && a[i] > 0.0f) ? a[i] : -1.0f;
      }
    `, 'guard');

    const gpu = device();
    const n = 8;
    const da = gpu.malloc(n * 4);           // 只分配 8 个
    const out = gpu.malloc(32 * 4);
    gpu.copyIn(da, Float32Array.from({ length: n }, (_, i) => i + 1));

    // 32 个线程里有 24 个 i >= n。短路不生效的话这里会越界读并抛 KernelError。
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [da, out, n]);

    const values = gpu.copyOut(out, 32);
    for (let i = 0; i < 32; i += 1) {
      expect(values[i]).toBeCloseTo(i < n ? i + 1 : -1, 5);
    }
  });

  it('越界访问被抓住，报的是 compute-sanitizer 那样的话', async () => {
    const kernel = await compileOne(`
      __global__ void oob(float* a) { a[threadIdx.x + 1000000] = 1.0f; }
    `, 'oob');
    const gpu = new GpuDevice({ globalBytes: 64 * 1024 });
    const a = gpu.malloc(128);
    expect(() => gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [a]))
      .toThrow(/invalid __global__|越界/);
  });

  it('死循环撞到执行预算，而不是把页面卡死', async () => {
    const kernel = await compileOne(`
      __global__ void spin(int* out) {
        int i = 0;
        while (i >= 0) i += 1;
        out[0] = i;
      }
    `, 'spin');
    // 用一个小预算，报错要快 —— 学员写错死循环时等十秒是很糟的体验
    const gpu = new GpuDevice({ globalBytes: 64 * 1024, maxWarpInsts: 100_000 });
    const out = gpu.malloc(4);
    expect(() => gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]))
      .toThrow(/执行预算/);
  });
});

describe('共享内存与屏障', () => {
  it('block 内经共享内存交换数据，__syncthreads() 之后读得到', async () => {
    const kernel = await compileOne(`
      __global__ void reverse(const float* in, float* out) {
        __shared__ float s[64];
        int t = threadIdx.x;
        s[t] = in[t];
        __syncthreads();
        out[t] = s[63 - t];
      }
    `, 'reverse');

    const gpu = device();
    const din = gpu.malloc(64 * 4);
    const dout = gpu.malloc(64 * 4);
    gpu.copyIn(din, Float32Array.from({ length: 64 }, (_, i) => i));
    gpu.launch(kernel, { grid: dim3(1), block: dim3(64) }, [din, dout]);

    const out = gpu.copyOut(dout, 64);
    for (let i = 0; i < 64; i += 1) expect(out[i]).toBe(63 - i);
    // 两个 warp、一次屏障
    expect(gpu.metrics().launch.barriers).toBe(1);
  });

  it('发散分支里的 __syncthreads() 明确报错，而不是装作没事', async () => {
    const kernel = await compileOne(`
      __global__ void bad(float* out) {
        __shared__ float s[32];
        int t = threadIdx.x;
        if (t < 16) {
          s[t] = 1.0f;
          __syncthreads();
        }
        out[t] = s[t];
      }
    `, 'bad');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    expect(() => gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]))
      .toThrow(/发散|__syncthreads/);
  });

  it('共享内存超过每 block 上限，在启动前就报错', async () => {
    const kernel = await compileOne(`
      __global__ void hog(float* out) {
        __shared__ float s[16384];
        s[threadIdx.x] = 1.0f;
        out[threadIdx.x] = s[threadIdx.x];
      }
    `, 'hog');
    const gpu = new GpuDevice({ globalBytes: 1024 * 1024, sharedBytesPerBlock: 48 * 1024 });
    const out = gpu.malloc(128);
    expect(() => gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]))
      .toThrow(/共享内存|上限/);
  });
});

/* ------------------------------------------------------------------ */
/* 计量 —— 门槛的地基                                                   */
/* ------------------------------------------------------------------ */

describe('全局访存合并计量', () => {
  const COPY = `
    __global__ void copy(const float* in, float* out, int stride) {
      int i = (blockIdx.x * blockDim.x + threadIdx.x) * stride;
      out[i] = in[i];
    }
  `;

  it('完全合并时每次请求恰好 4 个扇区', async () => {
    const kernel = await compileOne(COPY, 'copy');
    const gpu = device();
    const n = 1024;
    const din = gpu.malloc(n * 4);
    const dout = gpu.malloc(n * 4);
    gpu.copyIn(din, new Float32Array(n));

    gpu.launch(kernel, { grid: dim3(n / 32), block: dim3(32) }, [din, dout, 1]);

    const metrics = gpu.metrics();
    // 32 lane × 4 字节 = 128 字节 = 4 个 32B 扇区
    expect(metrics.global.sectorsPerRequest).toBe(4);
    expect(metrics.global.loadSectors).toBe((n / 32) * 4);
    expect(metrics.memory.readBytes).toBe(n * 4);
  });

  it('stride=8 时每个 lane 落在不同扇区 —— 32 个，也就是 8 倍的传输量', async () => {
    const kernel = await compileOne(COPY, 'copy');
    const gpu = device();
    const n = 256;
    const din = gpu.malloc(n * 8 * 4);
    const dout = gpu.malloc(n * 8 * 4);
    gpu.copyIn(din, new Float32Array(n * 8));

    gpu.launch(kernel, { grid: dim3(n / 32), block: dim3(32) }, [din, dout, 8]);

    const metrics = gpu.metrics();
    expect(metrics.global.sectorsPerRequest).toBe(32);
  });

  it('「优化真的生效」是能被证明的：同一段逻辑换个下标，DRAM 字节掉 8 倍', async () => {
    const kernel = await compileOne(COPY, 'copy');
    const n = 1024;

    const measure = (stride: number) => {
      const gpu = device();
      const din = gpu.malloc(n * stride * 4);
      const dout = gpu.malloc(n * stride * 4);
      gpu.copyIn(din, new Float32Array(n * stride));
      gpu.launch(kernel, { grid: dim3(n / 32), block: dim3(32) }, [din, dout, stride]);
      return gpu.metrics();
    };

    const bad = measure(8);
    const good = measure(1);

    // 指令数一模一样 —— 学员没有「少做事」，只是访存变整齐了
    expect(good.inst.laneExecuted).toBe(bad.inst.laneExecuted);
    // 但传输量差 8 倍。这就是第 2 关的门槛能成立的原因。
    expect(bad.memory.readBytes / good.memory.readBytes).toBe(8);
    expect(good.global.sectorsPerRequest).toBe(4);
    expect(bad.global.sectorsPerRequest).toBe(32);
  });
});

describe('共享内存 bank 冲突计量', () => {
  const TRANSPOSE = (pad: number) => `
    __global__ void transpose(const float* in, float* out) {
      __shared__ float tile[32][${32 + pad}];
      int x = threadIdx.x;
      int y = threadIdx.y;
      tile[y][x] = in[y * 32 + x];
      __syncthreads();
      out[y * 32 + x] = tile[x][y];
    }
  `;

  async function run(pad: number) {
    const kernel = await compileOne(TRANSPOSE(pad), 'transpose');
    const gpu = device();
    const din = gpu.malloc(32 * 32 * 4);
    const dout = gpu.malloc(32 * 32 * 4);
    gpu.copyIn(din, Float32Array.from({ length: 32 * 32 }, (_, i) => i));
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32, 32) }, [din, dout]);
    return { gpu, out: gpu.copyOut(dout, 32 * 32) };
  }

  it('不加 padding 时列访问 32 路冲突；加一列之后归零', async () => {
    const without = await run(0);
    const withPad = await run(1);

    // 两边算的结果必须一样 —— padding 是纯优化，不改语义
    expect(Array.from(withPad.out)).toEqual(Array.from(without.out));

    const a = without.gpu.metrics().shared.bankConflicts;
    const b = withPad.gpu.metrics().shared.bankConflicts;
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(0);
  });

  it('转置结果本身是对的', async () => {
    const { out } = await run(1);
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        expect(out[y * 32 + x]).toBe(x * 32 + y);
      }
    }
  });

  it('同一个 bank 上读同一个地址是广播，不算冲突', async () => {
    const kernel = await compileOne(`
      __global__ void broadcast(float* out) {
        __shared__ float s[32];
        int t = threadIdx.x;
        s[t] = (float)t;
        __syncthreads();
        out[t] = s[0];
      }
    `, 'broadcast');
    const gpu = device();
    const out = gpu.malloc(32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32) }, [out]);
    expect(gpu.metrics().shared.bankConflicts).toBe(0);
  });
});

describe('发散计量', () => {
  it('warp 内分岔算一次发散，整个 warp 走同一边不算', async () => {
    const source = `
      __global__ void branch(int* out, int mode) {
        int t = blockIdx.x * blockDim.x + threadIdx.x;
        int v = 0;
        // mode=0：按 lane 分岔；mode=1：按 warp 分岔
        int c = (mode == 0) ? (t % 2) : ((t / 32) % 2);
        if (c == 0) v = 1; else v = 2;
        out[t] = v;
      }
    `;
    const kernel = await compileOne(source, 'branch');

    const measure = (mode: number) => {
      const gpu = device();
      const out = gpu.malloc(128 * 4);
      gpu.launch(kernel, { grid: dim3(4), block: dim3(32) }, [out, mode]);
      return gpu.metrics().warp;
    };

    const perLane = measure(0);
    const perWarp = measure(1);

    expect(perLane.divergentBranches).toBe(4);  // 四个 warp 各发散一次
    expect(perWarp.divergentBranches).toBe(0);  // 整个 warp 走同一边
    expect(perLane.activeLaneRatio).toBeLessThan(perWarp.activeLaneRatio);
  });
});

/* ------------------------------------------------------------------ */
/* 确定性 —— 判定的前提                                                 */
/* ------------------------------------------------------------------ */

describe('确定性', () => {
  /**
   * 同一份代码跑很多遍，结果与**全部计数器**都必须逐位相同。
   *
   * 这不是锦上添花：门槛判定、参考解重放、进度恢复全都建立在它上面。
   * opslab 那边的教训是这条要进 CI 当门禁，所以放在这里而不是手工验一次。
   */
  it('1000 次重放，输出与全部指标逐位一致', async () => {
    const kernel = await compileOne(`
      __global__ void mix(const float* in, float* out, int n) {
        __shared__ float s[64];
        int t = threadIdx.x;
        int i = blockIdx.x * blockDim.x + t;
        s[t] = (i < n) ? in[i] : 0.0f;
        __syncthreads();
        float acc = 0.0f;
        for (int k = 0; k < 8; ++k) {
          acc = fmaf(s[(t + k) % 64], 1.5f, acc);
          if ((t & 1) == 0) acc = acc * 0.5f; else acc = acc - 0.25f;
        }
        if (i < n) out[i] = acc + expf(s[t] * 0.01f);
      }
    `, 'mix');

    const n = 256;
    const input = Float32Array.from({ length: n }, (_, i) => Math.sin(i) * 10);

    const once = () => {
      const gpu = device();
      const din = gpu.malloc(n * 4);
      const dout = gpu.malloc(n * 4);
      gpu.copyIn(din, input);
      gpu.launch(kernel, { grid: dim3(4), block: dim3(64) }, [din, dout, n]);
      return {
        // 用位模式比较，而不是数值 —— NaN 与 -0 也要一致
        bits: Array.from(new Int32Array(gpu.copyOut(dout, n).buffer)),
        metrics: gpu.flatMetrics(),
      };
    };

    const first = once();
    const reference = JSON.stringify(first);
    for (let run = 1; run < 1000; run += 1) {
      expect(JSON.stringify(once())).toBe(reference);
    }
    // 确实跑了真东西，不是空转
    expect(first.metrics['gpu.inst.laneExecuted']).toBeGreaterThan(10_000);
  });

  it('超越函数不走 JS 的 Math.* —— 换个引擎结果也一样', async () => {
    // expf/logf/tanhf 自己实现的直接后果：这些值是我们定死的，
    // 不随宿主 JS 引擎的 libm 变。这里钉住几个点，实现改了会立刻报。
    const kernel = await compileOne(`
      __global__ void trans(float* out) {
        out[0] = expf(1.0f);
        out[1] = logf(10.0f);
        out[2] = tanhf(0.5f);
        out[3] = __expf(1.0f);
      }
    `, 'trans');
    const gpu = device();
    const out = gpu.malloc(16);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(1) }, [out]);
    const values = gpu.copyOut(out, 4);

    expect(values[0]).toBeCloseTo(Math.E, 5);
    expect(values[1]).toBeCloseTo(Math.log(10), 5);
    expect(values[2]).toBeCloseTo(Math.tanh(0.5), 5);
    // 快速版精度更低，但和精确版方向一致 —— 「快但不准」在这里是真的
    expect(values[3]).toBeCloseTo(Math.E, 2);
    expect(values[3]).not.toBe(values[0]);
  });
});

describe('执行预算', () => {
  it('朴素 GEMM 在 N=128 时跑得动，指令量在设计预算内', async () => {
    const kernel = await compileOne(`
      __global__ void sgemm(const float* A, const float* B, float* C, int n) {
        int row = blockIdx.y * blockDim.y + threadIdx.y;
        int col = blockIdx.x * blockDim.x + threadIdx.x;
        if (row < n && col < n) {
          float acc = 0.0f;
          for (int k = 0; k < n; ++k) acc = fmaf(A[row * n + k], B[k * n + col], acc);
          C[row * n + col] = acc;
        }
      }
    `, 'sgemm');

    const n = 128;
    const gpu = device();
    const dA = gpu.malloc(n * n * 4);
    const dB = gpu.malloc(n * n * 4);
    const dC = gpu.malloc(n * n * 4);
    const A = Float32Array.from({ length: n * n }, (_, i) => ((i % 7) - 3) * 0.25);
    const B = Float32Array.from({ length: n * n }, (_, i) => ((i % 5) - 2) * 0.5);
    gpu.copyIn(dA, A);
    gpu.copyIn(dB, B);

    const startedAt = Date.now();
    gpu.launch(kernel, { grid: dim3(n / 16, n / 16), block: dim3(16, 16) }, [dA, dB, dC, n]);
    const elapsed = Date.now() - startedAt;

    // 结果对着 float64 的参考实现比，用相对误差界
    const C = gpu.copyOut(dC, n * n);
    for (let row = 0; row < n; row += 8) {
      for (let col = 0; col < n; col += 8) {
        let expected = 0;
        for (let k = 0; k < n; k += 1) expected += A[row * n + k] * B[k * n + col];
        const scale = Math.max(1, Math.abs(expected));
        expect(Math.abs(C[row * n + col] - expected) / scale).toBeLessThan(2e-5);
      }
    }

    // 这是**回归哨兵，不是性能指标**。
    //
    // jest 自己就吃掉 5–7 倍（SWC 转译 + 模块注册表 + vm 上下文）：同一段代码
    // 纯 node 下是 13.5M warp 指令/秒，这里只有约 2M。关卡规模按前一个数设计。
    // 这条断言的作用是「有人往热路径里加了会分配内存的东西」时能立刻发现。
    const metrics = gpu.metrics();
    const warpInstsPerSecond = metrics.inst.warpExecuted / Math.max(1, elapsed) * 1000;
    expect(warpInstsPerSecond).toBeGreaterThan(700_000);
  });
});
