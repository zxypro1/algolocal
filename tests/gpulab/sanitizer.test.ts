/**
 * 竞态检测
 *
 * 守的是整个项目的价值主张。准确的说法是：**在确定性模拟器里，有竞态的
 * kernel 会给出一个稳定的结果** —— 于是有两种坏情况，用例里都做了：
 *
 *  1. 那个稳定结果**恰好是对的**（`ORDERED`）。学员跑一万遍都对，
 *     没有任何理由怀疑它，然后带着一份真卡上会炸的代码出门。
 *  2. 那个稳定结果是错的（`TRANSPOSE`）。学员会把它当成逻辑 bug 去调，
 *     反复重跑也不会看到真硬件上那种「时好时坏」，于是学不到「这是竞态」。
 *
 * 两种都只有主动检测才能揭穿，所以每条用例都成对写：
 *「结果是什么样」和「但它有/没有竞态」必须同时断言。
 */
import { GpuDevice, compileSource, dim3, formatRaceReports } from '../../src/lib/gpulab';

jest.setTimeout(120_000);

function device(): GpuDevice {
  return new GpuDevice({ globalBytes: 2 * 1024 * 1024 });
}

async function compileOne(source: string, name: string) {
  const kernels = await compileSource(source);
  return kernels.get(name)!;
}

/**
 * 一个**在我们这儿永远算对、真卡上完全靠运气**的 kernel。
 *
 * 我们的执行器让 warp 0 先跑完再跑 warp 1。于是 warp 1 去读 warp 0 刚写的
 * 那半段共享内存，恰好总能读到。真硬件上 warp 1 完全可能先跑，读到的是垃圾。
 *
 * 这就是竞态检测非做不可的原因：这份代码在这里跑一万遍都是对的，
 * 学员没有任何理由怀疑它。
 */
const ORDERED = (sync: boolean) => `
  __global__ void ordered(float* out) {
    __shared__ float s[64];
    int t = threadIdx.x;
    s[t] = (float)t;
    ${sync ? '__syncthreads();' : ''}
    out[t] = (t >= 32) ? s[t - 32] : s[t];
  }
`;

async function runOrdered(sync: boolean) {
  const kernel = await compileOne(ORDERED(sync), 'ordered');
  const gpu = device();
  const dout = gpu.malloc(64 * 4);
  const config = { grid: dim3(1), block: dim3(64) };
  gpu.launch(kernel, config, [dout]);
  const out = Array.from(gpu.copyOut(dout, 64));
  const report = gpu.launchWithRacecheck(kernel, config, [dout]);
  return { out, report, gpu };
}

/** 漏了一个 __syncthreads() 的转置 —— 这个在我们这儿会算错，是另一种表现 */
const TRANSPOSE = (sync: boolean) => `
  __global__ void transpose(const float* in, float* out) {
    __shared__ float tile[32][33];
    int x = threadIdx.x;
    int y = threadIdx.y;
    tile[y][x] = in[y * 32 + x];
    ${sync ? '__syncthreads();' : ''}
    out[y * 32 + x] = tile[x][y];
  }
`;

async function runTranspose(sync: boolean) {
  const kernel = await compileOne(TRANSPOSE(sync), 'transpose');
  const gpu = device();
  const din = gpu.malloc(32 * 32 * 4);
  const dout = gpu.malloc(32 * 32 * 4);
  gpu.copyIn(din, Float32Array.from({ length: 32 * 32 }, (_, i) => i));

  const config = { grid: dim3(1), block: dim3(32, 32) };
  gpu.launch(kernel, config, [din, dout]);
  const out = Array.from(gpu.copyOut(dout, 32 * 32));
  const report = gpu.launchWithRacecheck(kernel, config, [din, dout]);
  return { out, report, gpu };
}

describe('确定性模拟器为什么必须主动查竞态', () => {
  it('**有竞态却算得完全正确** —— 跑多少遍都对，学员没理由怀疑它', async () => {
    const { out } = await runOrdered(false);
    // 一个屏障都没有，结果却和加了屏障的一模一样
    for (let t = 0; t < 64; t += 1) {
      expect(out[t]).toBe(t >= 32 ? t - 32 : t);
    }
    const withSync = await runOrdered(true);
    expect(out).toEqual(withSync.out);
  });

  it('结果一样，但 racecheck 把它抓出来了', async () => {
    const clean = await runOrdered(true);
    const racy = await runOrdered(false);
    expect(racy.out).toEqual(clean.out);
    expect(clean.report.races.length).toBe(0);
    expect(racy.report.races.length).toBeGreaterThan(0);
  });

  it('另一种表现：结果错了，但错得很稳 —— 一样查不出「这是竞态」', async () => {
    const clean = await runTranspose(true);
    const racy = await runTranspose(false);
    // 转置那个在我们这儿会算错（warp 之间读不到对方还没写的数据）
    expect(racy.out).not.toEqual(clean.out);
    // 但它每次都错得一模一样，学员会当成逻辑 bug 去调，
    // 而不会意识到「这是竞态、真卡上表现还不一样」
    const again = await runTranspose(false);
    expect(again.out).toEqual(racy.out);
    // racecheck 才说得出真正的原因
    expect(racy.report.races.length).toBeGreaterThan(0);
  });

  it('报告指出是「写与读」的冲突，并给出两条源码行号', async () => {
    const { report } = await runTranspose(false);
    const race = report.races[0];
    expect(race.space).toBe('shared');
    expect([race.first.kind, race.second.kind].sort()).toEqual(['read', 'write']);
    expect(race.first.line).not.toBe(race.second.line);
    expect(race.first.thread).not.toEqual(race.second.thread);
  });

  it('输出格式贴 compute-sanitizer', async () => {
    const { report } = await runTranspose(false);
    const text = formatRaceReports(report, 'transpose');
    expect(text).toContain('========= COMPUTE-SANITIZER');
    expect(text).toMatch(/ERROR: Race reported between (Read|Write) access and (Read|Write) access/);
    expect(text).toMatch(/by thread \(\d+,\d+,\d+\) in block \(\d+,\d+,\d+\) at transpose\.cu:\d+/);
    expect(text).toContain('RACECHECK SUMMARY');
  });

  it('干净的 kernel 打出 0 hazards', async () => {
    const { report } = await runTranspose(true);
    expect(formatRaceReports(report, 'transpose'))
      .toContain('RACECHECK SUMMARY: 0 hazards displayed (0 errors, 0 warnings)');
  });
});

describe('屏障确实把纪元分开了', () => {
  it('屏障两侧的读写不算竞态', async () => {
    const kernel = await compileOne(`
      __global__ void pingpong(float* out) {
        __shared__ float s[64];
        int t = threadIdx.x;
        s[t] = (float)t;
        __syncthreads();
        float a = s[(t + 1) % 64];   // 读别人写的 —— 但中间有屏障
        __syncthreads();
        s[t] = a;
        __syncthreads();
        out[t] = s[(t + 2) % 64];
      }
    `, 'pingpong');
    const gpu = device();
    const out = gpu.malloc(64 * 4);
    const config = { grid: dim3(1), block: dim3(64) };
    const report = gpu.launchWithRacecheck(kernel, config, [out]);
    expect(report.races.length).toBe(0);
  });

  it('少放一个屏障就报 —— 判据落在屏障上，不是落在「读了别人的数据」上', async () => {
    const kernel = await compileOne(`
      __global__ void missing(float* out) {
        __shared__ float s[64];
        int t = threadIdx.x;
        s[t] = (float)t;
        __syncthreads();
        float a = s[(t + 1) % 64];
        s[t] = a;                     // 这里少了一个屏障
        __syncthreads();
        out[t] = s[t];
      }
    `, 'missing');
    const gpu = device();
    const out = gpu.malloc(64 * 4);
    const config = { grid: dim3(1), block: dim3(64) };
    const report = gpu.launchWithRacecheck(kernel, config, [out]);
    expect(report.races.length).toBeGreaterThan(0);
  });

  it('同一个线程自己反复读写自己那格，不是竞态', async () => {
    const kernel = await compileOne(`
      __global__ void own(float* out) {
        __shared__ float s[64];
        int t = threadIdx.x;
        s[t] = 1.0f;
        s[t] = s[t] + 2.0f;
        s[t] = s[t] * 3.0f;
        __syncthreads();
        out[t] = s[t];
      }
    `, 'own');
    const gpu = device();
    const out = gpu.malloc(64 * 4);
    const report = gpu.launchWithRacecheck(kernel, { grid: dim3(1), block: dim3(64) }, [out]);
    expect(report.races.length).toBe(0);
    expect(gpu.copyOut(out, 64)[0]).toBe(9);
  });
});

describe('全局内存与跨 block', () => {
  it('两个 block 写同一个全局地址会被报出来', async () => {
    const kernel = await compileOne(`
      __global__ void clash(float* out) {
        // 每个 block 都往 out[0] 写 —— 谁最后写的没有定义
        if (threadIdx.x == 0) out[0] = (float)blockIdx.x;
      }
    `, 'clash');
    const gpu = device();
    const out = gpu.malloc(4);
    const report = gpu.launchWithRacecheck(kernel, { grid: dim3(4), block: dim3(32) }, [out]);
    expect(report.races.length).toBeGreaterThan(0);
    expect(report.races[0].space).toBe('global');
    // 是两个不同的 block
    expect(report.races[0].first.block).not.toEqual(report.races[0].second.block);
  });

  it('**跨 block 的判据是语义，不是我们的执行顺序** —— 屏障管不到别的 block', async () => {
    const kernel = await compileOne(`
      __global__ void barriered(float* out) {
        __shared__ float s[32];
        int t = threadIdx.x;
        s[t] = 1.0f;
        __syncthreads();
        // block 内有屏障，但屏障对**别的 block** 一点约束都没有
        if (t == 0) out[0] = s[0];
        __syncthreads();
        if (t == 0) out[0] = s[1];
      }
    `, 'barriered');
    const gpu = device();
    const out = gpu.malloc(4);
    const report = gpu.launchWithRacecheck(kernel, { grid: dim3(2), block: dim3(32) }, [out]);
    // 两个 block 都在写 out[0]，屏障救不了
    expect(report.races.some((race) => race.space === 'global')).toBe(true);
  });

  it('每个线程写自己那格，跨 block 也不冲突', async () => {
    const kernel = await compileOne(`
      __global__ void disjoint(float* out) {
        int i = blockIdx.x * blockDim.x + threadIdx.x;
        out[i] = (float)i;
      }
    `, 'disjoint');
    const gpu = device();
    const out = gpu.malloc(128 * 4);
    const report = gpu.launchWithRacecheck(kernel, { grid: dim3(4), block: dim3(32) }, [out]);
    expect(report.races.length).toBe(0);
  });
});

describe('作为判定门槛', () => {
  it('gpu.sanitizer.races 进了指标树，可以直接写门槛', async () => {
    const dirty = await runTranspose(false);
    const clean = await runTranspose(true);
    expect(dirty.gpu.flatMetrics()['gpu.sanitizer.races']).toBeGreaterThan(0);
    expect(clean.gpu.flatMetrics()['gpu.sanitizer.races']).toBe(0);
  });

  it('没跑过 racecheck 时门槛读到 0，不会假阳性', async () => {
    const kernel = await compileOne(TRANSPOSE(false), 'transpose');
    const gpu = device();
    const din = gpu.malloc(32 * 32 * 4);
    const dout = gpu.malloc(32 * 32 * 4);
    gpu.launch(kernel, { grid: dim3(1), block: dim3(32, 32) }, [din, dout]);
    expect(gpu.flatMetrics()['gpu.sanitizer.races']).toBe(0);
  });
});

describe('开销', () => {
  it('不开检测时零成本：两次普通运行的指标完全一致', async () => {
    const kernel = await compileOne(TRANSPOSE(true), 'transpose');
    const once = () => {
      const gpu = device();
      const din = gpu.malloc(32 * 32 * 4);
      const dout = gpu.malloc(32 * 32 * 4);
      gpu.launch(kernel, { grid: dim3(1), block: dim3(32, 32) }, [din, dout]);
      return gpu.flatMetrics();
    };
    expect(JSON.stringify(once())).toBe(JSON.stringify(once()));
  });

  it('**racecheck 那一遍不进指标** —— 否则判定跑两遍会让每个门槛翻倍', async () => {
    const kernel = await compileOne(TRANSPOSE(true), 'transpose');
    const config = { grid: dim3(1), block: dim3(32, 32) };

    const gpu = device();
    const a = gpu.malloc(32 * 32 * 4);
    const b = gpu.malloc(32 * 32 * 4);

    gpu.launch(kernel, config, [a, b]);
    const afterPlain = gpu.flatMetrics();

    gpu.launchWithRacecheck(kernel, config, [a, b]);
    const afterCheck = gpu.flatMetrics();

    // 除了 races 那一项，其余一个都不该动
    expect(afterCheck['gpu.inst.warpExecuted']).toBe(afterPlain['gpu.inst.warpExecuted']);
    expect(afterCheck['gpu.global.loadRequests']).toBe(afterPlain['gpu.global.loadRequests']);
    expect(afterCheck['gpu.launch.blocks']).toBe(afterPlain['gpu.launch.blocks']);
  });

  it('racecheck 会真的改写显存，所以要么先跑它、要么接受结果被覆盖', async () => {
    const kernel = await compileOne(ORDERED(true), 'ordered');
    const gpu = device();
    const out = gpu.malloc(64 * 4);
    const config = { grid: dim3(1), block: dim3(64) };
    gpu.launchWithRacecheck(kernel, config, [out]);
    // 跑完之后显存里是真结果，不是空的
    expect(gpu.copyOut(out, 64)[40]).toBe(8);
  });
});
