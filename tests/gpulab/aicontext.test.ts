/**
 * 喂给 AI 的 GPU 快照
 *
 * 这一组存在的理由和 ops 那边一样：工程对话曾经把整个工作区发上去，
 * 撞在 Next 默认的 1mb 请求体上限上，中等项目直接 413 —— 不是变慢，是不可用。
 *
 * GPU 这边有一个 ops 没有的失控源：**访存轨迹**。一个 N=256 的 GEMM 的
 * AccessTrace 是几十万条记录，真塞进去请求体直接以 MB 计。所以这里除了盯体积，
 * 还专门有一条盯「轨迹没被带进去」—— 需要的是它算出来的结论（扇区数、bank 冲突），
 * 不是原始轨迹。
 */
import { createGpuWorld } from '../../src/lib/gpulab/lab';
import {
  buildGpuSnapshot, summarizeGpuReport, GPU_SNAPSHOT_LIMITS,
} from '../../src/lib/gpulab/lab/aicontext';
import { buildGpuContext, GPU_REVIEW_MAX_CHARS } from '../../src/lib/server/gpuPrompt';
import type { GpuWorld } from '../../src/lib/gpulab/lab';
import type { StageRunReport } from '../../src/lib/engineering/types';
import type { CommandRecord } from '../../src/lib/labkit/machine';

jest.setTimeout(120_000);

const WORLD_SPEC = {
  seed: 20260826,
  device: 'H100' as const,
  globalBytes: 8 * 1024 * 1024,
  sharedBytesPerBlock: 48 * 1024,
  machine: { hostname: 'gpu-01', user: 'root', cwd: '/root' },
};

function world(): GpuWorld {
  return createGpuWorld(WORLD_SPEC);
}

function command(line: string, code: number, output: string): CommandRecord {
  return { command: line, code, stdout: output, stderr: code === 0 ? '' : output, at: 0 } as CommandRecord;
}

function report(overrides: Partial<StageRunReport> = {}): StageRunReport {
  return {
    status: 'failed',
    totals: { total: 4, passed: 3, failed: 1 },
    cases: [
      { suite: '正确性', name: '结果对得上', passed: true, durationMs: 3 },
      { suite: '合并访问', name: '扇区数达标', passed: false, durationMs: 5, error: 'x'.repeat(4000) },
    ],
    gates: [
      {
        gate: {
          metric: 'gpu.global.sectorsPerRequest', op: 'lte', value: 4.5,
          label: { zh: '每次访存打到的 32B 扇区数', en: 'sectors per request' }, unit: 'sector/req',
        },
        actual: 9.43,
        passed: false,
      },
      {
        gate: {
          metric: 'gpu.sanitizer.races', op: 'eq', value: 0,
          label: { zh: '数据竞态', en: 'data races' },
        },
        actual: 0,
        passed: true,
      },
    ],
    metrics: {} as StageRunReport['metrics'],
    console: [],
    wallClockMs: 12,
    ...overrides,
  } as StageRunReport;
}

describe('体积', () => {
  /**
   * 这一条是这组测试存在的理由。
   *
   * 六个大源文件 + 40 条各 20KB 输出的命令，原始素材是好几 MB；
   * 压出来必须远低于 Next 的默认 1mb，就算将来有人把 sizeLimit 改回默认值也不该挂。
   */
  it('大量源码与长输出下请求体远低于 1mb', () => {
    const sources: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) sources[`/root/kernel-${i}.cu`] = 'a'.repeat(30000);
    const history = Array.from({ length: 40 }, (_, i) =>
      command(`nvcc -o bench k${i}.cu`, i % 3 === 0 ? 1 : 0, 'z'.repeat(20000)));

    const snapshot = buildGpuSnapshot(world(), { sources, history });
    const payload = JSON.stringify({
      messages: [{ role: 'user', content: '为什么没到线' }],
      context: { snapshot, report: summarizeGpuReport(report()) },
    });

    expect(payload.length).toBeLessThan(200_000);
    // 也不能压过头压成空壳
    expect(snapshot.sources.length).toBeGreaterThan(0);
    expect(snapshot.commands.length).toBe(GPU_SNAPSHOT_LIMITS.chat.commands);
  });

  it('**平台的只读头文件不进上下文** —— 每关都一样，只会挤掉真正的 kernel', () => {
    const snapshot = buildGpuSnapshot(world(), {
      sources: {
        '/root/reduce.cu': '__global__ void k() {}',
        '/root/containers.h': 'x'.repeat(5000),
        '/root/cluster.h': 'y'.repeat(5000),
        '/root/cuda_runtime.h': 'z'.repeat(5000),
      },
    });
    expect(snapshot.sources.map((file) => file.path)).toEqual(['/root/reduce.cu']);
  });

  it('源文件有总预算，超了就不再带', () => {
    const sources: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) sources[`/root/f-${i}.cu`] = 'b'.repeat(9000);
    const snapshot = buildGpuSnapshot(world(), { sources });

    const total = snapshot.sources.reduce((sum, file) => sum + file.content.length, 0);
    expect(total).toBeLessThanOrEqual(22000);
    expect(snapshot.sources.length).toBeLessThan(10);
    expect(snapshot.omitted.sources).toBeGreaterThan(0);
  });

  it('对话与复盘是两套预算：复盘条数多、单条短', () => {
    const history = Array.from({ length: 60 }, (_, i) => command(`ncu ./bench # ${i}`, 0, 'y'.repeat(5000)));
    const chat = buildGpuSnapshot(world(), { history });
    const review = buildGpuSnapshot(world(), { history, limits: GPU_SNAPSHOT_LIMITS.review });

    expect(chat.commands.length).toBe(8);
    expect(review.commands.length).toBe(40);
    // 复盘看的是顺序，单条截得更狠
    expect(review.commands[0].output.length).toBeLessThan(chat.commands[0].output.length);
  });

  it('**访存轨迹不会被带进快照** —— 它有几十万条，要的是它算出来的扇区数', () => {
    const snapshot = buildGpuSnapshot(world(), { sources: { '/root/k.cu': 'int x;' } });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('trace');
    expect(serialized).not.toContain('accesses');
    // 但结论要在
    expect(snapshot.profile).not.toBeNull();
    expect(snapshot.profile).toHaveProperty('sectorsPerRequest');
    expect(snapshot.profile).toHaveProperty('sharedBankConflicts');
  });

  it('服务端还会再兜一次总量 —— 客户端是可以被绕过的', () => {
    const huge = {
      snapshot: {
        ...buildGpuSnapshot(world()),
        // 伪造一个没经过客户端裁剪的请求
        sources: [{ path: '/root/evil.cu', content: 'q'.repeat(500000), truncated: false }],
      },
    };
    const text = buildGpuContext(huge as never, 'zh');
    expect(text.length).toBeLessThanOrEqual(40000 + 200);
  });
});

describe('门槛摘要 —— 这个场景最关键的一段上下文', () => {
  it('带上每条门槛的指标名、目标值与实测值', () => {
    const summary = summarizeGpuReport(report());
    expect(summary).not.toBeNull();
    const gate = summary!.gates.find((item) => item.metric === 'gpu.global.sectorsPerRequest');
    expect(gate).toMatchObject({ op: 'lte', target: 4.5, actual: 9.43, passed: false });
  });

  it('**已经通过的门槛也带上** —— AI 得知道哪些别改坏', () => {
    const summary = summarizeGpuReport(report());
    expect(summary!.gates.some((gate) => gate.passed)).toBe(true);
    expect(summary!.gates).toHaveLength(2);
  });

  it('门槛标签按语言取', () => {
    expect(summarizeGpuReport(report(), 'en')!.gates[0].label).toBe('sectors per request');
    expect(summarizeGpuReport(report(), 'zh')!.gates[0].label).toBe('每次访存打到的 32B 扇区数');
  });

  it('排版里写出「差多少」，模型不用自己算', () => {
    const text = buildGpuContext({ report: summarizeGpuReport(report()) } as never, 'zh');
    expect(text).toContain('9.43');
    expect(text).toContain('4.5');
    // 9.43 / 4.5 = 2.10
    expect(text).toContain('2.10');
  });

  it('没跑过验收时用关卡声明的门槛，不至于什么都不知道', () => {
    const text = buildGpuContext({
      gates: [{ metric: 'gpu.memory.readBytes', op: 'lte', value: 1024, unit: 'B' }],
    } as never, 'zh');
    expect(text).toContain('gpu.memory.readBytes');
    expect(text).toContain('1024');
  });

  it('失败用例的报错会截断但不丢', () => {
    const summary = summarizeGpuReport(report());
    expect(summary!.failing).toHaveLength(1);
    expect(summary!.failing[0].error.length).toBeLessThan(1000);
  });
});

describe('排版', () => {
  it('缺字段的 snapshot 不该让排版抛异常', () => {
    expect(() => buildGpuContext({ snapshot: {} } as never, 'zh')).not.toThrow();
    expect(() => buildGpuContext({} as never, 'en')).not.toThrow();
  });

  it('周期数旁边必须写着「只能相对比较」', () => {
    const snapshot = buildGpuSnapshot(world());
    const text = buildGpuContext({ snapshot } as never, 'zh');
    expect(text).toMatch(/相对比较/);
  });

  it('命令输出里 stderr 排在 stdout 前面 —— nvcc 的报错在 stderr 上', () => {
    const record = { command: 'nvcc bench.cu', code: 1, stdout: 'OUT', stderr: 'ERR', at: 0 } as CommandRecord;
    const snapshot = buildGpuSnapshot(world(), { history: [record] });
    expect(snapshot.commands[0].output.indexOf('ERR')).toBeLessThan(snapshot.commands[0].output.indexOf('OUT'));
  });

  it('复盘的额度比对话高', () => {
    expect(GPU_REVIEW_MAX_CHARS).toBeGreaterThan(40000);
  });
});
