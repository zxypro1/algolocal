/**
 * 跑一个 GPU 关卡的判定
 *
 * 和 `runOpsStage` 是姐妹：同一套隐藏用例机制、同一份 `StageRunReport`，
 * 所以结果面板、计分卡、AI 评审、进度存档全部复用。
 *
 * **一处关键的不同：门槛真的会算。**
 * `runOpsStage` 永远返回 `gates: []` —— ops 关卡不走指标门槛。
 * 而 gpulab 的门槛是主角（「优化真的生效」全靠它证明），所以这里把
 * `evaluateGates` 接了进来，并且把 GPU 的指标树挂到 `LabMetrics.gpu` 下。
 * 门槛写起来就是 `{ metric: 'gpu.global.sectorsPerRequest', op: 'lte', value: 4.5 }`。
 */
import { createModuleRuntime } from '../../engineering/moduleRuntime';
import { evaluateGates } from '../../engineering/runner';
import { AssertionError, createSpecCollector } from '../../engineering/specRunner';
import type {
  ConsoleEntry, GateResult, LabMetrics, MetricGate,
  SpecCaseResult, SpecFile, StageRunReport,
} from '../../engineering/types';
import { createGpuLabModules } from './modules';
import type { GpuWorld } from './world';

export interface RunGpuStageOptions {
  world: GpuWorld;
  specs: SpecFile[];
  gates?: MetricGate[];
  /** 隐藏用例之外，还要让 spec 能 import 的文件 */
  files?: Record<string, string>;
  transpile?: (code: string, filePath: string) => string;
  /** 单条用例的真实时间预算 */
  caseWallClockMs?: number;
}

/**
 * 把 GPU 的指标整理成一棵能被 `getMetricValue` 一层层走下去的树。
 *
 * 静态指标（寄存器、占用率）与 sanitizer 的结果也放进来 ——
 * 它们和运行时计数器一样是门槛要读的东西。
 */
export function gpuMetricTree(world: GpuWorld): Record<string, unknown> {
  const metrics = world.gpu.metrics();
  const stat = world.gpu.staticMetrics();
  const sanitizer = world.gpu.sanitizerReport();

  return {
    ...metrics,
    registers: { perThread: stat?.registersPerThread ?? 0 },
    occupancy: {
      theoretical: stat?.occupancy.theoretical ?? 0,
      warpsPerSm: stat?.occupancy.warpsPerSm ?? 0,
      blocksPerSm: stat?.occupancy.blocksPerSm ?? 0,
    },
    sanitizer: {
      races: sanitizer.races.length + sanitizer.truncated,
      /** warp 同步原语用错的次数，和 races 一样是恒为 0 的硬门槛 */
      warpSyncErrors: metrics.warp.syncErrors,
    },
    /** 显存峰值 —— FlashAttention、KV cache 那几关的门槛读它 */
    memoryPeakBytes: world.gpu.usedBytes,
  };
}

/** GPU 关卡没有请求级指标，但报告结构要一致 —— 给一份空的，再挂上 gpu 那棵树 */
export function gpuLabMetrics(world: GpuWorld): LabMetrics {
  return {
    virtualElapsedMs: 0,
    maxConcurrency: 0,
    concurrencyTimeline: [],
    requests: { total: 0, ok: 0, failed: 0, throttled: 0, retries: 0, duplicated: 0, byUrl: {} },
    samples: [],
    counters: {},
    gpu: gpuMetricTree(world),
  };
}

export async function runGpuStage(options: RunGpuStageOptions): Promise<StageRunReport> {
  const startedAt = Date.now();
  const cases: SpecCaseResult[] = [];
  const consoleEntries: ConsoleEntry[] = [];

  const builtins = createGpuLabModules(options.world);

  try {
    for (const spec of options.specs) {
      const collector = createSpecCollector();
      const runtime = createModuleRuntime({
        files: { ...(options.files ?? {}), [spec.path]: spec.content },
        builtins,
        globals: {
          ...collector.globals,
          console: makeConsole(consoleEntries),
        },
        transpile: options.transpile,
      });

      runtime.require(`./${spec.path}`);
      collector.finalize();

      for (const testCase of collector.cases) {
        if (testCase.skipped) {
          cases.push({
            suite: testCase.suite, name: testCase.name,
            passed: true, durationMs: 0, error: 'skipped',
          });
          continue;
        }

        const caseStartedAt = Date.now();
        let failure: { message: string; expected?: string; actual?: string } | null = null;
        try {
          await withTimeout(async () => {
            for (const hook of testCase.beforeEach.flat()) await hook();
            try {
              await testCase.fn();
            } finally {
              for (const hook of testCase.afterEach.flat()) await hook();
            }
          }, options.caseWallClockMs ?? 60_000, `${testCase.suite} ${testCase.name}`);
        } catch (error) {
          failure = describeError(error);
        }

        cases.push({
          suite: testCase.suite,
          name: testCase.name,
          passed: !failure,
          durationMs: Date.now() - caseStartedAt,
          ...(failure ?? {}),
          ...(failure ? { error: failure.message } : {}),
        });
      }
    }
  } catch (error) {
    const detail = describeError(error);
    const passedSoFar = cases.filter((item) => item.passed).length;
    return {
      status: 'error',
      totals: { total: cases.length, passed: passedSoFar, failed: cases.length - passedSoFar },
      cases,
      gates: [],
      metrics: gpuLabMetrics(options.world),
      console: consoleEntries.slice(0, 200),
      wallClockMs: Date.now() - startedAt,
      error: detail.message,
    };
  }

  const metrics = gpuLabMetrics(options.world);
  // 门槛只看整次运行的聚合指标，没有按用例分组的概念 ——
  // 一次 launch 的计量本来就是整体的。
  const gates: GateResult[] = evaluateGates(options.gates ?? [], [], metrics);

  const passed = cases.filter((item) => item.passed).length;
  const failed = cases.length - passed;
  const allGatesPassed = gates.every((gate) => gate.passed);

  return {
    status: failed === 0 && allGatesPassed ? 'passed' : 'failed',
    totals: { total: cases.length, passed, failed },
    cases,
    gates,
    metrics,
    console: consoleEntries.slice(0, 200),
    wallClockMs: Date.now() - startedAt,
  };
}

/**
 * 用例的真实时间预算。
 *
 * GPU 的用例会真的编译并跑 kernel。jest 之外（也就是学员那一侧）
 * 一次 N=256 的 GEMM 是几百毫秒量级，但一关可能跑好几遍，
 * 所以给得比 ops 宽一点。
 */
function withTimeout<T>(run: () => Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`用例超时（${ms}ms）：${label}`)), ms);
    run().then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function describeError(error: unknown): { message: string; expected?: string; actual?: string } {
  if (error instanceof AssertionError) {
    return { message: error.message, expected: error.expected, actual: error.actual };
  }
  if (error instanceof Error) {
    const stackLine = (error.stack ?? '').split('\n')[1]?.trim();
    return { message: stackLine ? `${error.message}\n  ${stackLine}` : error.message };
  }
  return { message: String(error) };
}

function makeConsole(sink: ConsoleEntry[]) {
  const push = (level: ConsoleEntry['level']) => (...args: unknown[]) => {
    if (sink.length >= 200) return;
    sink.push({
      level,
      text: args.map((value) => (typeof value === 'string' ? value : safeJson(value))).join(' '),
      at: 0,
      source: 'user',
    });
  };
  return { log: push('log'), info: push('log'), warn: push('warn'), error: push('error'), debug: push('log') };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
