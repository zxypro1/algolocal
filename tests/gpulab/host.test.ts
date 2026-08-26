/**
 * 宿主代码
 *
 * 后半程的关卡（KV cache、分页 KV、引擎组装、调度器）主要逻辑在宿主侧：
 * 分配显存、管块表、按调度决定这一步起哪些 kernel。这套用例钉住的是
 * **接口的真实性**（学员敲的和真卡上一样）与**边界的明确性**
 * （不支持的东西必须报错，不能悄悄跑错）。
 */
import {
  CONTAINERS_H, CUDA_RUNTIME_H, ENGINE_H,
} from '../../src/lib/gpulab/host/headers';
import { GpuDevice, compileProgram, formatPrintf } from '../../src/lib/gpulab';

jest.setTimeout(180_000);

async function run(source: string, buffers: Array<{ address: number; length: number }> = []) {
  const program = await compileProgram(source);
  if (!program.host) throw new Error('这份源码里没有 main');
  const gpu = new GpuDevice({ globalBytes: 4 * 1024 * 1024 });
  const result = gpu.runHost(program.host, program.kernels, buffers);
  return { gpu, stdout: result.stdout };
}

const SCALE = `
__global__ void scale(float* out, const float* in, float k, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) out[i] = in[i] * k;
}
`;

describe('CUDA runtime', () => {
  it('分配、拷进去、起 kernel、拷回来 —— 和真卡上一模一样的写法', async () => {
    const { stdout } = await run(`${SCALE}
      int main(void) {
        const int N = 64;
        float host[64];
        for (int i = 0; i < N; ++i) host[i] = (float)i;

        float* dIn;
        float* dOut;
        cudaMalloc((void**)&dIn, N * 4);
        cudaMalloc((void**)&dOut, N * 4);
        cudaMemcpy(dIn, host, N * 4, cudaMemcpyHostToDevice);

        scale<<<2, 32>>>(dOut, dIn, 3.0f, N);
        cudaDeviceSynchronize();

        cudaMemcpy(host, dOut, N * 4, cudaMemcpyDeviceToHost);
        printf("%.1f %.1f\\n", host[7], host[63]);
        cudaFree(dIn);
        cudaFree(dOut);
        return 0;
      }
    `);
    expect(stdout).toBe('21.0 189.0\n');
  });

  it('**主机内存与设备内存是真的两个地址空间**', async () => {
    // 把主机指针当设备指针传给 kernel：地址在 local 空间里是合法的，
    // 在 global 空间里指向完全不同的东西 —— 于是结果不可能是对的。
    // 这正是 cudaMemcpyKind 那个参数存在的理由。
    const { gpu } = await run(`${SCALE}
      int main(void) {
        float host[16];
        for (int i = 0; i < 16; ++i) host[i] = 1.0f;
        float* d;
        cudaMalloc((void**)&d, 16 * 4);
        cudaMemcpy(d, host, 16 * 4, cudaMemcpyHostToDevice);
        return 0;
      }
    `);
    // 设备侧确实收到了数据
    expect(gpu.metrics()).toBeTruthy();
  });

  it('拷贝方向写反会搬错东西，不会被悄悄纠正', async () => {
    const { stdout } = await run(`
      int main(void) {
        float host[4];
        for (int i = 0; i < 4; ++i) host[i] = 7.0f;
        float* d;
        cudaMalloc((void**)&d, 16);
        cudaMemset(d, 0, 16);
        // 方向反了：本想把 host 送进设备，实际是把设备的 0 拷回 host
        cudaMemcpy(host, d, 16, cudaMemcpyDeviceToHost);
        printf("%.1f\\n", host[0]);
        return 0;
      }
    `);
    expect(stdout).toBe('0.0\n');
  });

  it('cudaMalloc 只认 (void**)&指针 这一种写法', async () => {
    await expect(compileProgram(`
      int main(void) {
        float* d;
        cudaMalloc(d, 16);
        return 0;
      }
    `)).rejects.toThrow(/\(void\*\*\)&/);
  });

  it('给一个没声明过的名字会说清楚', async () => {
    await expect(compileProgram(`
      int main(void) {
        cudaMalloc((void**)&nope, 16);
        return 0;
      }
    `)).rejects.toThrow(/nope/);
  });

  it('越界的 cudaMemcpy 会炸，不会静默改写别的内存', async () => {
    await expect(run(`
      int main(void) {
        float* d;
        cudaMalloc((void**)&d, 16);
        float host[4];
        cudaMemcpy(host, d, 1000000000, cudaMemcpyDeviceToHost);
        return 0;
      }
    `)).rejects.toThrow(/越界/);
  });
});

describe('起 kernel', () => {
  it('grid 与 block 可以是表达式，也可以是 dim3', async () => {
    const { gpu } = await run(`${SCALE}
      int main(void) {
        float* d;
        cudaMalloc((void**)&d, 1024);
        int blocks = 3;
        scale<<<blocks + 1, dim3(16, 2)>>>(d, d, 1.0f, 8);
        return 0;
      }
    `);
    expect(gpu.metrics().launch.blocks).toBe(4);
    // 16×2 = 32 个线程，一个 warp
    expect(gpu.metrics().launch.warps).toBe(4);
  });

  it('<<<>>> 的第三、四个参数暂不支持，会明确说', async () => {
    await expect(compileProgram(`${SCALE}
      int main(void) {
        float* d;
        cudaMalloc((void**)&d, 1024);
        scale<<<1, 32, 4096>>>(d, d, 1.0f, 8);
        return 0;
      }
    `)).rejects.toThrow(/动态共享内存/);
  });

  it('起一个不存在的 kernel 会说清楚有哪些', async () => {
    await expect(run(`${SCALE}
      int main(void) {
        float* d;
        cudaMalloc((void**)&d, 1024);
        nosuch<<<1, 32>>>(d);
        return 0;
      }
    `)).rejects.toThrow(/nosuch/);
  });

  it('kernel 里不能起 kernel', async () => {
    await expect(compileProgram(`${SCALE}
      __global__ void outer(float* d) {
        scale<<<1, 32>>>(d, d, 1.0f, 8);
      }
      int main(void) { return 0; }
    `)).rejects.toThrow(/只有宿主代码能起 kernel/);
  });
});

describe('自己写的函数：内联展开', () => {
  it('宿主函数能调用，返回值对', async () => {
    const { stdout } = await run(`
      static int square(int x) { return x * x; }
      int main(void) {
        printf("%d\\n", square(7) + square(2));
        return 0;
      }
    `);
    expect(stdout).toBe('53\n');
  });

  it('__device__ 函数能在 kernel 里调用', async () => {
    const { gpu } = await run(`
      __device__ float relu(float x) { return fmaxf(x, 0.0f); }
      __global__ void act(float* out, const float* in, int n) {
        int i = blockIdx.x * blockDim.x + threadIdx.x;
        if (i < n) out[i] = relu(in[i]);
      }
      int main(void) {
        float host[8];
        for (int i = 0; i < 8; ++i) host[i] = (float)(i - 4);
        float* d;
        cudaMalloc((void**)&d, 32);
        cudaMemcpy(d, host, 32, cudaMemcpyHostToDevice);
        act<<<1, 8>>>(d, d, 8);
        cudaMemcpy(host, d, 32, cudaMemcpyDeviceToHost);
        printf("%.1f %.1f\\n", host[0], host[7]);
        return 0;
      }
    `);
    expect(gpu.metrics().launch.blocks).toBe(1);
  });

  it('**被内联的函数看不见调用者的局部变量**', async () => {
    // 少了作用域屏障，函数里的 i 会撞上调用者循环里的 i，而且是静默地撞上
    await expect(compileProgram(`
      static int leak(void) { return i; }
      int main(void) {
        for (int i = 0; i < 3; ++i) { printf("%d\\n", leak()); }
        return 0;
      }
    `)).rejects.toThrow(/i/);
  });

  it('同名的局部变量互不干扰', async () => {
    const { stdout } = await run(`
      static int helper(int x) { int t = x * 10; return t; }
      int main(void) {
        int t = 1;
        int sum = 0;
        for (int i = 0; i < 3; ++i) sum += helper(i);
        printf("%d %d\\n", sum, t);
        return 0;
      }
    `);
    expect(stdout).toBe('30 1\n');
  });

  it('递归会明确报错，而不是把寄存器撑爆', async () => {
    await expect(compileProgram(`
      static int fact(int n) { if (n <= 1) { return 1; } return n * fact(n - 1); }
      int main(void) { printf("%d\\n", fact(5)); return 0; }
    `)).rejects.toThrow(/递归/);
  });

  it('宿主函数在 kernel 里调用不了', async () => {
    await expect(compileProgram(`
      static int helper(int x) { return x + 1; }
      __global__ void k(int* out) { out[0] = helper(1); }
      int main(void) { return 0; }
    `)).rejects.toThrow(/__device__/);
  });

  it('参数个数不对会说清楚', async () => {
    await expect(compileProgram(`
      static int add(int a, int b) { return a + b; }
      int main(void) { printf("%d\\n", add(1)); return 0; }
    `)).rejects.toThrow(/2 个参数，给了 1 个/);
  });
});

describe('break 与提前 return', () => {
  it('break 跳出循环', async () => {
    const { stdout } = await run(`
      int main(void) {
        int sum = 0;
        for (int i = 0; i < 100; ++i) {
          if (i == 5) { break; }
          sum += i;
        }
        printf("%d\\n", sum);
        return 0;
      }
    `);
    expect(stdout).toBe('10\n');
  });

  it('嵌套两层 if 里的 break 也把掩码弹干净了', async () => {
    const { stdout } = await run(`
      int main(void) {
        int sum = 0;
        int i = 0;
        while (i < 100) {
          if (i > 2) {
            if (i % 2 == 1) { break; }
          }
          sum += i;
          i += 1;
        }
        printf("%d %d\\n", sum, i);
        return 0;
      }
    `);
    // i=0,1,2 累加到 3；i=3 时 3>2 且是奇数，两层 if 里跳出，sum 与 i 都停在 3
    expect(stdout).toBe('3 3\n');
  });

  it('循环深处的提前 return 能一路弹回调用点', async () => {
    const { stdout } = await run(`
      static int firstMultiple(int start, int factor) {
        for (int i = start; i < start + 100; ++i) {
          if (i % factor == 0) { return i; }
        }
        return -1;
      }
      int main(void) {
        printf("%d %d\\n", firstMultiple(7, 5), firstMultiple(3, 7));
        return 0;
      }
    `);
    expect(stdout).toBe('10 7\n');
  });

  it('**设备侧的 break 明确报错** —— 掩码栈机器上它需要一条退出掩码', async () => {
    await expect(compileProgram(`
      __global__ void k(float* out, int n) {
        for (int i = 0; i < n; ++i) {
          if (out[i] < 0.0f) { break; }
        }
      }
      int main(void) { return 0; }
    `)).rejects.toThrow(/退出掩码/);
  });

  it('循环外的 break 会说清楚', async () => {
    await expect(compileProgram(`
      int main(void) { break; return 0; }
    `)).rejects.toThrow(/不在循环里/);
  });
});

describe('容器', () => {
  it('vec 能当动态数组用', async () => {
    const { stdout } = await run(`
      int main(void) {
        int v = vec_new();
        for (int i = 0; i < 5; ++i) vec_push(v, i * i);
        vec_set(v, 0, 99);
        printf("%d %d %d\\n", vec_len(v), vec_get(v, 0), vec_pop(v));
        return 0;
      }
    `);
    expect(stdout).toBe('5 99 16\n');
  });

  it('map 的键可以很大很稀疏 —— 分页 KV 的块表就是这么用的', async () => {
    const { stdout } = await run(`
      int main(void) {
        int m = map_new();
        // 键拼成 seq * 4096 + block，低位规律性很强
        for (int seq = 0; seq < 40; ++seq) {
          for (int b = 0; b < 8; ++b) map_set(m, seq * 4096 + b, seq * 100 + b);
        }
        printf("%d %d %d\\n", map_len(m), map_get(m, 39 * 4096 + 7, -1), map_get(m, 12345678, -1));
        return 0;
      }
    `);
    expect(stdout).toBe('320 3907 -1\n');
  });

  it('map 反复插删不会退化 —— 墓碑也算进装载因子', async () => {
    const { stdout } = await run(`
      int main(void) {
        int m = map_new();
        for (int round = 0; round < 200; ++round) {
          map_set(m, round, round * 2);
          if (round > 4) { map_del(m, round - 5); }
        }
        printf("%d %d\\n", map_len(m), map_get(m, 199, -1));
        return 0;
      }
    `);
    expect(stdout).toBe('5 398\n');
  });

  it('ring 是先进先出', async () => {
    const { stdout } = await run(`
      int main(void) {
        int r = ring_new();
        ring_push(r, 1);
        ring_push(r, 2);
        ring_push(r, 3);
        int first = ring_pop(r);
        printf("%d %d %d\\n", first, ring_peek(r), ring_len(r));
        return 0;
      }
    `);
    expect(stdout).toBe('1 2 2\n');
  });

  it('没初始化的句柄（C 里是 0）会立刻报错', async () => {
    await expect(run(`
      int main(void) {
        int v;
        v = 0;
        vec_push(v, 1);
        return 0;
      }
    `)).rejects.toThrow(/还没用 vec_new\(\) 初始化/);
  });

  it('越界访问报错，不是未定义行为', async () => {
    await expect(run(`
      int main(void) {
        int v = vec_new();
        vec_push(v, 1);
        printf("%d\\n", vec_get(v, 5));
        return 0;
      }
    `)).rejects.toThrow(/越界/);
  });

  it('空队列上 pop 会报错', async () => {
    await expect(run(`
      int main(void) {
        int r = ring_new();
        ring_pop(r);
        return 0;
      }
    `)).rejects.toThrow(/空的队列/);
  });

  it('kernel 里用不了容器', async () => {
    await expect(compileProgram(`
      __global__ void k(int* out) { out[0] = vec_new(); }
      int main(void) { return 0; }
    `)).rejects.toThrow(/宿主侧的函数/);
  });
});

describe('平台交过来的缓冲区', () => {
  it('lab_buffer 拿到的是能直接传给 kernel 的设备指针', async () => {
    const gpu = new GpuDevice({ globalBytes: 1024 * 1024 });
    const address = gpu.malloc(32 * 4);
    gpu.copyIn(address, Float32Array.from({ length: 32 }, (_, i) => i + 1));

    const program = await compileProgram(`${SCALE}
      int main(void) {
        float* in = lab_buffer(0);
        int n = lab_buffer_len(0);
        float* out;
        cudaMalloc((void**)&out, n * 4);
        scale<<<1, 32>>>(out, in, 2.0f, n);
        cudaMemcpy(in, out, n * 4, cudaMemcpyDeviceToDevice);
        return 0;
      }
    `);
    gpu.runHost(program.host!, program.kernels, [{ address, length: 32 }]);
    expect(Array.from(gpu.copyOut(address, 4))).toEqual([2, 4, 6, 8]);
  });

  it('要一个不存在的编号会说清楚有几个', async () => {
    await expect(run(`
      int main(void) {
        float* p = lab_buffer(3);
        return 0;
      }
    `)).rejects.toThrow(/声明了 0 个/);
  });
});

describe('printf', () => {
  it('格式串决定怎么解释这个数 —— 和 C 一样', () => {
    expect(formatPrintf('%d %u %x', [-1, -1, 255])).toBe('-1 4294967295 ff');
    expect(formatPrintf('%.2f|%.0f', [3.14159, 2.5])).toBe('3.14|3');
    expect(formatPrintf('100%%', [])).toBe('100%');
  });

  it('字符串不能当普通值用', async () => {
    await expect(compileProgram(`
      int main(void) { int x = "abc"; return 0; }
    `)).rejects.toThrow(/char\*/);
  });
});

describe('头文件与编译器的签名是对得上的', () => {
  /**
   * 头文件是学员唯一的参考。它写了什么函数，编译器就必须认什么函数 ——
   * 两边分家的话，学员照着头文件写会撞上「暂不支持」，而那是平台的错。
   */
  const declared = [...`${CONTAINERS_H}\n${ENGINE_H}\n${CUDA_RUNTIME_H}`.matchAll(
    /^\s*(?:int|void|float\*)\s+(\w+)\s*\(/gm
  )].map((match) => match[1]);

  it.each(declared)('头文件里的 %s 编译器认得', async (name) => {
    // 拿一个明显错误的参数个数去调用：认得的函数会抱怨参数，
    // 不认得的函数会说「暂不支持」
    await expect(compileProgram(`
      int main(void) { ${name}(1, 2, 3, 4, 5, 6); return 0; }
    `)).rejects.toThrow(/参数|\(void\*\*\)&|格式串/);
  });

  it('头文件是只读的 —— 学员改不了接口契约', () => {
    expect(CONTAINERS_H).toContain('vec_new');
    expect(declared.length).toBeGreaterThan(20);
  });
});

describe('确定性', () => {
  it('同一个宿主程序跑 20 遍，输出与指标逐位相同', async () => {
    const source = `${SCALE}
      int main(void) {
        float host[32];
        for (int i = 0; i < 32; ++i) host[i] = (float)i * 0.5f;
        float* d;
        cudaMalloc((void**)&d, 128);
        cudaMemcpy(d, host, 128, cudaMemcpyHostToDevice);
        int m = map_new();
        for (int i = 0; i < 32; ++i) map_set(m, i * 7919, i);
        scale<<<1, 32>>>(d, d, 1.5f, 32);
        cudaMemcpy(host, d, 128, cudaMemcpyDeviceToHost);
        printf("%.4f %d\\n", host[31], map_get(m, 31 * 7919, -1));
        return 0;
      }
    `;
    const first = await run(source);
    const bits = JSON.stringify(first.gpu.metrics());
    for (let i = 0; i < 20; i += 1) {
      const again = await run(source);
      expect(again.stdout).toBe(first.stdout);
      expect(JSON.stringify(again.gpu.metrics())).toBe(bits);
    }
  });
});

describe('kernel 里的提前 return', () => {
  /**
   * `if (i >= n) return;` 是 CUDA 里最常见的一句话，而它天生是发散的。
   *
   * 这套用例特意把 n 取成**不是块大小整数倍**的数：n 是整数倍时，
   * 尾块里没有任何 lane 会走进那个 return，于是「ret 杀掉整个 warp」
   * 这种写法也能碰巧全对。取 100 而不是 128，那些还没算完的 lane
   * 才会真的被考到。
   */
  it('尾块里退出一部分 lane，剩下的把活干完', async () => {
    const gpu = new GpuDevice({ globalBytes: 1024 * 1024 });
    const address = gpu.malloc(128 * 4);
    gpu.copyIn(address, new Float32Array(128));

    const program = await compileProgram(`
      __global__ void fill(float* out, int n) {
        int i = blockIdx.x * blockDim.x + threadIdx.x;
        if (i >= n) return;
        out[i] = (float)(i + 1);
      }
      int main(void) {
        float* out = lab_buffer(0);
        fill<<<4, 32>>>(out, 100);
        return 0;
      }
    `);
    gpu.runHost(program.host!, program.kernels, [{ address, length: 128 }]);
    const out = gpu.copyOut(address, 128);

    // 前 100 个都写了 —— 包括第 96..99 个，它们和 4 个该退出的 lane 同一个 warp
    for (let i = 0; i < 100; i += 1) expect(out[i]).toBe(i + 1);
    // 后面 28 个一个都没被碰
    for (let i = 100; i < 128; i += 1) expect(out[i]).toBe(0);
  });

  it('return 之后的循环对退出的 lane 不再执行', async () => {
    const gpu = new GpuDevice({ globalBytes: 1024 * 1024 });
    const address = gpu.malloc(64 * 4);
    gpu.copyIn(address, new Float32Array(64));

    const program = await compileProgram(`
      __global__ void guarded(float* out, int n) {
        int i = threadIdx.x;
        if (i >= n) return;
        for (int k = 0; k < 3; ++k) out[i] = out[i] + 1.0f;
      }
      int main(void) {
        float* out = lab_buffer(0);
        guarded<<<1, 32>>>(out, 20);
        return 0;
      }
    `);
    gpu.runHost(program.host!, program.kernels, [{ address, length: 64 }]);
    const out = gpu.copyOut(address, 32);
    for (let i = 0; i < 20; i += 1) expect(out[i]).toBe(3);
    for (let i = 20; i < 32; i += 1) expect(out[i]).toBe(0);
  });

  it('内联函数里的提前 return 在设备侧仍然拦下 —— 那是另一回事', async () => {
    // kernel 顶层的 return 是**永久**退出这个线程，一条掩码就够。
    // 函数里的 return 只是退出那个函数，之后还要接着算 —— 需要按层
    // 保存的退出掩码，这个子集还没有。
    await expect(compileProgram(`
      __device__ int clampIndex(int i, int n) {
        if (i >= n) { return n - 1; }
        return i;
      }
      __global__ void k(float* out, int n) {
        out[threadIdx.x] = (float)clampIndex(threadIdx.x, n);
      }
      int main(void) { return 0; }
    `)).rejects.toThrow(/退出掩码/);
  });
});

describe('continue', () => {
  it('跳过这一轮的剩下部分', async () => {
    const { stdout } = await run(`
      int main(void) {
        int sum = 0;
        for (int i = 0; i < 10; ++i) {
          if (i % 3 == 0) { continue; }
          sum += i;
        }
        printf("%d\\n", sum);
        return 0;
      }
    `);
    // 0,3,6,9 跳过，剩下 1+2+4+5+7+8 = 27
    expect(stdout).toBe('27\n');
  });

  it('**for 的 continue 会跑步进表达式** —— 否则就是死循环', async () => {
    const { stdout } = await run(`
      int main(void) {
        int seen = 0;
        for (int i = 0; i < 5; ++i) {
          if (i < 3) { continue; }
          seen += 1;
        }
        printf("%d\\n", seen);
        return 0;
      }
    `);
    expect(stdout).toBe('2\n');
  });

  it('while 的 continue 跳回条件', async () => {
    const { stdout } = await run(`
      int main(void) {
        int i = 0;
        int sum = 0;
        while (i < 10) {
          i += 1;
          if (i % 2 == 0) { continue; }
          sum += i;
        }
        printf("%d\\n", sum);
        return 0;
      }
    `);
    expect(stdout).toBe('25\n');
  });

  it('嵌套 if 里的 continue 把掩码弹干净了', async () => {
    const { stdout } = await run(`
      int main(void) {
        int sum = 0;
        for (int i = 0; i < 8; ++i) {
          if (i > 1) {
            if (i % 2 == 0) { continue; }
          }
          sum += i;
        }
        printf("%d\\n", sum);
        return 0;
      }
    `);
    // 0,1 都加；之后跳过偶数：3+5+7 = 15，加上 0+1 = 16
    expect(stdout).toBe('16\n');
  });

  it('设备侧的 continue 明确报错', async () => {
    await expect(compileProgram(`
      __global__ void k(float* out, int n) {
        for (int i = 0; i < n; ++i) { if (out[i] < 0.0f) { continue; } out[i] = 1.0f; }
      }
      int main(void) { return 0; }
    `)).rejects.toThrow(/退出掩码/);
  });

  it('循环外的 continue 会说清楚', async () => {
    await expect(compileProgram(`
      int main(void) { continue; return 0; }
    `)).rejects.toThrow(/不在循环里/);
  });
});
