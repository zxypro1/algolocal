/**
 * CUDA 工具链
 *
 * 学员在终端里的循环和真机上一样：
 *
 *     nvcc -o bench kernel.cu
 *     ./bench
 *     ncu ./bench
 *     compute-sanitizer --tool racecheck ./bench
 *
 * 这套用例守两件事：**命令与 flag 是真的**（换到真机上原样能用），
 * 以及**跑两遍结果一样**（判定的前提）。
 */
import { buildWorld, type GpuWorldSpec } from '../../src/lib/gpulab/lab';

jest.setTimeout(120_000);

const SAXPY = `
__global__ void saxpy(const float* x, float* y, float a, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) y[i] = a * x[i] + y[i];
}
`;

function spec(source = SAXPY): GpuWorldSpec {
  return {
    seed: 7,
    globalBytes: 2 * 1024 * 1024,
    machine: { files: { '/root/kernel.cu': source } },
    bench: {
      sources: ['/root/kernel.cu'],
      buffers: [
        { name: 'x', length: 256, fill: { kind: 'iota', scale: 0.5 } },
        { name: 'y', length: 256, fill: { kind: 'const', value: 1 } },
      ],
      launches: [
        { kernel: 'saxpy', grid: [8], block: [32], args: ['x', 'y', 2, 256] },
      ],
    },
  };
}

describe('nvcc', () => {
  it('编译成功之后磁盘上有产物，`./bench` 能敲', async () => {
    const world = buildWorld(spec());
    const compile = await world.run('nvcc -o bench kernel.cu');
    expect(compile.code).toBe(0);
    expect(compile.stderr).toBe('');

    const ls = await world.run('ls');
    expect(ls.stdout).toContain('bench');

    const run = await world.run('./bench');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('launched 1 kernel');
  });

  it('`nvcc --version` 报的是钉住的那个版本', async () => {
    const world = buildWorld(spec());
    const result = await world.run('nvcc --version');
    expect(result.stdout).toContain('Cuda compilation tools, release 13.3');
  });

  it('语法错误按 nvcc 的样子报：文件(行): error，并把那一行指出来', async () => {
    const world = buildWorld(spec(`
__global__ void broken(float* a) {
  a[0] = 1.0f
}
`));
    const result = await world.run('nvcc -o bench kernel.cu');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^kernel\.cu\(\d+\): error:/m);
    expect(result.stderr).toContain('^');
    expect(result.stderr).toContain('1 error detected in the compilation of "kernel.cu".');
  });

  it('用了子集之外的语法，报错指到那一行并说清替代做法', async () => {
    const world = buildWorld(spec(`
__global__ void k(float* a) {
  double d = 1.0;
  a[0] = (float)d;
}
`));
    const result = await world.run('nvcc -o bench kernel.cu');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('kernel.cu(3): error:');
    expect(result.stderr).toContain('double');
  });

  it('文件不存在时报 nvcc 的原话', async () => {
    const world = buildWorld(spec());
    const result = await world.run('nvcc -o bench nope.cu');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nvcc fatal   : Cannot open input file 'nope.cu'");
  });

  it('没编译就跑，报「先跑 nvcc」而不是莫名其妙地成功', async () => {
    const world = buildWorld(spec());
    const result = await world.run('./bench');
    expect(result.code).not.toBe(0);
  });
});

describe('./bench', () => {
  it('算出来的结果是对的', async () => {
    const world = buildWorld(spec());
    await world.run('nvcc -o bench kernel.cu');
    await world.run('./bench');

    const y = world.buffers.get('y')!;
    const out = world.gpu.copyOut(y.address, y.length);
    for (let i = 0; i < 256; i += 1) {
      expect(out[i]).toBeCloseTo(2 * (i * 0.5) + 1, 4);
    }
  });

  it('跑两遍结果与指标完全一样 —— 每次都从干净的设备开始', async () => {
    const world = buildWorld(spec());
    await world.run('nvcc -o bench kernel.cu');

    await world.run('./bench');
    const first = {
      y: Array.from(world.gpu.copyOut(world.buffers.get('y')!.address, 256)),
      metrics: world.gpu.flatMetrics(),
    };

    await world.run('./bench');
    const second = {
      y: Array.from(world.gpu.copyOut(world.buffers.get('y')!.address, 256)),
      metrics: world.gpu.flatMetrics(),
    };

    expect(second).toEqual(first);
  });

  it('kernel 跑挂了（越界）报到 stderr，退出码非 0', async () => {
    const world = buildWorld({
      ...spec(`
__global__ void oob(float* y, int n) {
  y[blockIdx.x * blockDim.x + threadIdx.x + 1000000] = 1.0f;
}
`),
      bench: {
        sources: ['/root/kernel.cu'],
        buffers: [{ name: 'y', length: 64, fill: { kind: 'zeros' } }],
        launches: [{ kernel: 'oob', grid: [2], block: [32], args: ['y', 64] }],
      },
    });
    await world.run('nvcc -o bench kernel.cu');
    const result = await world.run('./bench');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/invalid __global__|越界/);
  });
});

describe('ncu', () => {
  it('分节名与指标名照抄 Nsight Compute', async () => {
    const world = buildWorld(spec());
    await world.run('nvcc -o bench kernel.cu');
    const result = await world.run('ncu ./bench');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('==PROF== Connected to process');
    expect(result.stdout).toContain('==PROF== Profiling "saxpy"');
    for (const section of [
      'Section: GPU Speed Of Light Throughput',
      'Section: Memory Workload Analysis',
      'Section: Compute Workload Analysis',
      'Section: Occupancy',
      'Section: Warp State Statistics',
      'Section: Launch Statistics',
    ]) {
      expect(result.stdout).toContain(section);
    }
    // 真的 ncu 指标名，学员拿去搜能搜到 NVIDIA 的文档
    expect(result.stdout).toContain('dram__bytes_read.sum');
    expect(result.stdout).toContain('l1tex__average_t_sectors_per_request_pipe_lsu_mem_global_op_ld.ratio');
    expect(result.stdout).toContain('launch__registers_per_thread');
  });

  it('合并访问的数字是真的：saxpy 每次请求 4 个扇区', async () => {
    const world = buildWorld(spec());
    await world.run('nvcc -o bench kernel.cu');
    await world.run('ncu ./bench');
    expect(world.gpu.metrics().global.sectorsPerRequest).toBe(4);
  });

  it('占用率被什么卡住会直接写出来', async () => {
    const world = buildWorld({
      ...spec(`
__global__ void hog(float* y) {
  __shared__ float big[20000];
  int t = threadIdx.x;
  big[t] = (float)t;
  __syncthreads();
  y[t] = big[t];
}
`),
      sharedBytesPerBlock: 96 * 1024,
      bench: {
        sources: ['/root/kernel.cu'],
        buffers: [{ name: 'y', length: 64, fill: { kind: 'zeros' } }],
        launches: [{ kernel: 'hog', grid: [1], block: [64], args: ['y'] }],
      },
    });
    await world.run('nvcc -o bench kernel.cu');
    const result = await world.run('ncu ./bench');
    expect(result.stdout).toContain('OPT');
    expect(result.stdout).toContain('共享内存用量');
  });
});

describe('compute-sanitizer', () => {
  const RACY = `
__global__ void ordered(float* out) {
  __shared__ float s[64];
  int t = threadIdx.x;
  s[t] = (float)t;
  out[t] = (t >= 32) ? s[t - 32] : s[t];
}
`;

  function racySpec(source: string): GpuWorldSpec {
    return {
      globalBytes: 1024 * 1024,
      machine: { files: { '/root/kernel.cu': source } },
      bench: {
        sources: ['/root/kernel.cu'],
        buffers: [{ name: 'out', length: 64, fill: { kind: 'zeros' } }],
        launches: [{ kernel: 'ordered', grid: [1], block: [64], args: ['out'] }],
      },
    };
  }

  it('racecheck 抓出竞态，退出码非 0', async () => {
    const world = buildWorld(racySpec(RACY));
    await world.run('nvcc -o bench kernel.cu');
    const result = await world.run('compute-sanitizer --tool racecheck ./bench');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('========= COMPUTE-SANITIZER');
    expect(result.stdout).toMatch(/ERROR: Race reported between/);
    expect(result.stdout).toContain('RACECHECK SUMMARY');
  });

  it('加上屏障之后 0 hazards，退出码 0', async () => {
    const world = buildWorld(racySpec(RACY.replace('  out[t]', '  __syncthreads();\n  out[t]')));
    await world.run('nvcc -o bench kernel.cu');
    const result = await world.run('compute-sanitizer --tool racecheck ./bench');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 hazards displayed (0 errors, 0 warnings)');
  });

  it('memcheck 抓越界', async () => {
    const world = buildWorld({
      globalBytes: 512 * 1024,
      machine: {
        files: {
          '/root/kernel.cu': `
__global__ void oob(float* out) { out[threadIdx.x + 900000] = 1.0f; }
`,
        },
      },
      bench: {
        sources: ['/root/kernel.cu'],
        buffers: [{ name: 'out', length: 32, fill: { kind: 'zeros' } }],
        launches: [{ kernel: 'oob', grid: [1], block: [32], args: ['out'] }],
      },
    });
    await world.run('nvcc -o bench kernel.cu');
    const result = await world.run('compute-sanitizer --tool memcheck ./bench');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ERROR SUMMARY');
  });

  it('不认识的 tool 会把有哪些列出来', async () => {
    const world = buildWorld(racySpec(RACY));
    await world.run('nvcc -o bench kernel.cu');
    const result = await world.run('compute-sanitizer --tool initcheck ./bench');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('racecheck');
  });
});

describe('nvidia-smi', () => {
  it('打出来是那张熟悉的表', async () => {
    const world = buildWorld(spec());
    const result = await world.run('nvidia-smi');
    expect(result.stdout).toContain('NVIDIA-SMI');
    expect(result.stdout).toContain('CUDA Version: 13.3');
    expect(result.stdout).toContain('H100');
    expect(result.stdout).toContain('MiB /');
  });
});

describe('和 shell 的其它东西一起用', () => {
  it('管道、重定向、&& 都照常', async () => {
    const world = buildWorld(spec());
    const result = await world.run('nvcc -o bench kernel.cu && ./bench > out.txt && cat out.txt | wc -l');
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('1');
  });

  it('编译失败时 && 后面的不跑', async () => {
    const world = buildWorld(spec('__global__ void k(float* a) { a[0] = }'));
    const result = await world.run('nvcc -o bench kernel.cu && ./bench');
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('launched');
  });

  it('学员改了源码再编，跑的是新的', async () => {
    const world = buildWorld(spec());
    await world.run('nvcc -o bench kernel.cu && ./bench');
    const before = world.gpu.copyOut(world.buffers.get('y')!.address, 4)[1];

    // 把 a * x + y 改成 x + y
    await world.run(`cat > kernel.cu <<'EOF'
__global__ void saxpy(const float* x, float* y, float a, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) y[i] = x[i] + y[i];
}
EOF`);
    await world.run('nvcc -o bench kernel.cu && ./bench');
    const after = world.gpu.copyOut(world.buffers.get('y')!.address, 4)[1];

    expect(before).toBeCloseTo(2 * 0.5 + 1, 5);
    expect(after).toBeCloseTo(0.5 + 1, 5);
  });
});
