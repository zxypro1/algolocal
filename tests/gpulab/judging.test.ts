/**
 * 判定管线
 *
 * 这一套证明的是整个项目最核心的那句话能不能兑现：
 * **「优化真的生效」是能被证明的，而不是自称的。**
 *
 * 做法：拿同一关的两份实现（没优化的、优化过的）跑同一套隐藏用例与门槛。
 * 两份都必须通过用例（结果都对），但只有优化过的能过门槛。
 */
import { buildWorld, runGpuStage, type GpuWorldSpec } from '../../src/lib/gpulab/lab';
import { createTranspiler } from '../../src/lib/engineering/transpile';
import type { MetricGate, SpecFile } from '../../src/lib/engineering/types';
import * as ts from 'typescript';

/**
 * 隐藏用例是 TS，模块运行时要一个转译器才跑得动。
 * 学员那一侧由工作台按需懒加载（见 engineering/transpile.ts），
 * 测试里直接给一个。
 */
const transpile = createTranspiler(ts);

jest.setTimeout(180_000);

/**
 * 第 2 关的形状：同一个拷贝，换个下标就是 8 倍的传输量。
 *
 * 关键是**每个元素都要搬到**，只是顺序不对 —— 否则挂的就是用例而不是门槛，
 * 演示不出「结果全对但传输量差 8 倍」这件事。
 * 这里让一个 warp 里的 32 个 lane 各隔 n/32 个元素，正好各占一个扇区。
 */
const NAIVE = `
__global__ void copyKernel(const float* in, float* out, int n) {
  int t = blockIdx.x * blockDim.x + threadIdx.x;
  int lane = t % 32;
  int row = t / 32;
  int i = lane * (n / 32) + row;
  if (i < n) out[i] = in[i];
}
`;

const COALESCED = `
__global__ void copyKernel(const float* in, float* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) out[i] = in[i];
}
`;

const N = 2048;

function spec(source: string): GpuWorldSpec {
  return {
    seed: 3,
    globalBytes: 1024 * 1024,
    machine: { files: { '/root/kernel.cu': source } },
    bench: {
      sources: ['/root/kernel.cu'],
      buffers: [
        { name: 'in', length: N, fill: { kind: 'iota', scale: 0.25 } },
        { name: 'out', length: N, fill: { kind: 'zeros' } },
      ],
      launches: [
        { kernel: 'copyKernel', grid: [N / 64], block: [64], args: ['in', 'out', N] },
      ],
    },
  };
}

/** 隐藏用例：只管「算对没有」，不管怎么算的 */
const SPECS: SpecFile[] = [{
  path: 'spec.ts',
  content: `
    const lab = require('@gpu/lab');

    describe('拷贝', () => {
      it('每个元素都搬过去了', async () => {
        await lab.buildAndRun();
        const out = lab.buffer('out');
        const input = lab.buffer('in');
        const diff = lab.compare(out, input);
        expect(diff.maxAbs).toBe(0);
      });

      it('没有竞态', async () => {
        const report = await lab.racecheck();
        expect(report.races.length).toBe(0);
      });
    });
  `,
}];

/** 门槛：结构性计量，与硬件型号无关 */
const GATES: MetricGate[] = [
  {
    metric: 'gpu.global.sectorsPerRequest',
    op: 'lte',
    value: 4.5,
    label: { en: 'sectors per request', zh: '每次访存的扇区数' },
    dimension: 'latency',
  },
  {
    metric: 'gpu.sanitizer.races',
    op: 'eq',
    value: 0,
    label: { en: 'data races', zh: '竞态' },
    dimension: 'correctness',
  },
];

async function judge(source: string) {
  const world = buildWorld(spec(source));
  return runGpuStage({ world, specs: SPECS, gates: GATES, transpile });
}

describe('门槛真的会算 —— 这是和 ops 关卡最本质的区别', () => {
  it('优化过的实现：用例全绿，门槛全过', async () => {
    const report = await judge(COALESCED);
    expect(report.totals.failed).toBe(0);
    expect(report.gates.every((gate) => gate.passed)).toBe(true);
    expect(report.status).toBe('passed');
  });

  it('**没优化的实现：用例照样全绿，但门槛挂了**', async () => {
    const report = await judge(NAIVE);
    // 结果完全正确 —— 学员没算错任何东西
    expect(report.totals.failed).toBe(0);
    // 但传输量是 8 倍，门槛不认
    const sectors = report.gates.find((gate) => gate.gate.metric === 'gpu.global.sectorsPerRequest')!;
    expect(sectors.passed).toBe(false);
    expect(sectors.actual).toBe(32);
    expect(report.status).toBe('failed');
  });

  it('两份实现算出来的结果一模一样 —— 差别只在怎么访存', async () => {
    const fast = buildWorld(spec(COALESCED));
    const slow = buildWorld(spec(NAIVE));
    for (const world of [fast, slow]) {
      await world.run('nvcc -o bench kernel.cu');
      await world.run('./bench');
    }
    const a = fast.gpu.copyOut(fast.buffers.get('out')!.address, N);
    const b = slow.gpu.copyOut(slow.buffers.get('out')!.address, N);
    expect(Array.from(b)).toEqual(Array.from(a));

    // 访存指令的**条数**一样 —— 每个元素都是一读一写，没人少做事
    expect(slow.gpu.metrics().global.loadRequests)
      .toBe(fast.gpu.metrics().global.loadRequests);
    // 但搬过去的字节数差 8 倍，这才是门槛抓住的东西
    expect(slow.gpu.metrics().memory.readBytes / fast.gpu.metrics().memory.readBytes).toBe(8);
  });
});

describe('指标树能被门槛的路径解析到', () => {
  it('嵌套路径一层层走得下去', async () => {
    const report = await judge(COALESCED);
    const tree = report.metrics.gpu as Record<string, any>;
    expect(tree.global.sectorsPerRequest).toBe(4);
    expect(tree.sanitizer.races).toBe(0);
    expect(tree.occupancy.theoretical).toBeGreaterThan(0);
    expect(tree.registers.perThread).toBeGreaterThan(0);
    expect(tree.memoryPeakBytes).toBeGreaterThan(0);
  });

  it('写错指标名会挂，而不是悄悄当成 0 过掉', async () => {
    const world = buildWorld(spec(COALESCED));
    const report = await runGpuStage({
      world,
      specs: SPECS,
      transpile,
      gates: [{
        metric: 'gpu.nonexistent.thing',
        op: 'lte',
        value: 1,
        label: { en: 'typo', zh: '写错的指标' },
      }],
    });
    expect(report.gates[0].passed).toBe(false);
    expect(Number.isNaN(report.gates[0].actual)).toBe(true);
  });
});

describe('编译失败与跑挂', () => {
  it('编不过时用例报的是编译错误原文', async () => {
    const report = await judge('__global__ void copyKernel(float* a) { a[0] = }');
    expect(report.totals.failed).toBeGreaterThan(0);
    const failure = report.cases.find((item) => !item.passed)!;
    expect(failure.error).toContain('编译没通过');
    expect(failure.error).toContain('kernel.cu(');
  });

  it('kernel 越界时用例报越界，不是报「结果不对」', async () => {
    const report = await judge(`
__global__ void copyKernel(const float* in, float* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  out[i + 900000] = in[i];
}
`);
    const failure = report.cases.find((item) => !item.passed)!;
    expect(failure.error).toMatch(/invalid __global__|越界/);
  });
});

describe('反向验证的形状', () => {
  /**
   * 出题时每一关都要满足这个：**参考解全绿，起始代码必须挂。**
   * 这里用第 2 关的两份实现演示一遍，后面每关的内容都按这个模板写。
   */
  it('参考解全绿', async () => {
    const report = await judge(COALESCED);
    expect(report.status).toBe('passed');
  });

  it('起始代码必须挂 —— 挂在门槛上而不是用例上', async () => {
    const report = await judge(NAIVE);
    expect(report.status).toBe('failed');
    expect(report.totals.failed).toBe(0);       // 用例是过的
    expect(report.gates.some((g) => !g.passed)).toBe(true); // 挂在门槛
  });
});
