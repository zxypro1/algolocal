/**
 * 跑一个 train 关卡的判定
 *
 * 和 `runGpuStage` 是姐妹：同一套隐藏用例机制、同一份 `StageRunReport`，
 * 所以结果面板、计分卡、AI 评审、进度存档全部复用。
 *
 * **门槛是主角。** 和 gpulab 一样，`evaluateGates` 接进来，指标树挂在
 * `LabMetrics.llm` 下，门槛写起来就是
 * `{ metric: 'llm.flops.backwardOverForward', op: 'lte', value: 2.2 }`。
 *
 * 一条铁律（design/llmlab.md 第六节）：**`llm.timing.*` 不许作门槛**。
 * 这里在跑之前先扫一遍关卡声明的门槛，写错了当场报错 ——
 * 与其在文档里写一句「别用墙钟」，不如让写错的题目根本跑不起来。
 */
import { createModuleRuntime } from '../../engineering/moduleRuntime';
import { evaluateGates } from '../../engineering/runner';
import { AssertionError, createSpecCollector } from '../../engineering/specRunner';
import type {
  ConsoleEntry, GateResult, LabMetrics, MetricGate,
  SpecCaseResult, SpecFile, StageRunReport,
} from '../../engineering/types';
import { isForbiddenGateMetric } from '../bridge';
import { createTrainLabModules } from './modules';
import type { TrainWorld } from './world';

export interface RunTrainStageOptions {
  world: TrainWorld;
  specs: SpecFile[];
  gates?: MetricGate[];
  /** 隐藏用例之外，还要让 spec 能 import 的文件 */
  files?: Record<string, string>;
  transpile?: (code: string, filePath: string) => string;
  /**
   * 单条用例的真实时间预算。
   *
   * 比 gpu 那边还宽：train 的用例会**真的训练** ——
   * 15 万参数、400 步是十几秒的量级，而一关可能跑参考解与对照组各一遍。
   */
  caseWallClockMs?: number;
}

/**
 * 把 GPU 那棵指标树的做法照搬过来：`llm` 挂在 `LabMetrics` 下，
 * `getMetricValue` 本来就会一层层走下去，不用改解析。
 */
export function trainLabMetrics(world: TrainWorld): LabMetrics {
  return {
    virtualElapsedMs: 0,
    maxConcurrency: 0,
    concurrencyTimeline: [],
    requests: { total: 0, ok: 0, failed: 0, throttled: 0, retries: 0, duplicated: 0, byUrl: {} },
    samples: [],
    counters: {},
    llm: world.rt.metrics() as unknown as Record<string, unknown>,
  };
}

/**
 * 出题期的校验：门槛不许读墙钟。
 *
 * 单独抽出来是为了让 `projects:verify` 也能直接调它 ——
 * 一道写错的题目应该在入库时就被拦下来，而不是等学员发现自己
 * 在一台慢机器上永远过不了。
 */
export function assertGatesAreStructural(gates: MetricGate[] | undefined): void {
  for (const gate of gates ?? []) {
    if (isForbiddenGateMetric(gate.metric)) {
      throw new Error(
        `门槛不许建立在 ${gate.metric} 上 —— 那是墙钟，取决于学员的机器。` +
        '见 design/llmlab.md 第六节「规矩一」。'
      );
    }
  }
}

export async function runTrainStage(options: RunTrainStageOptions): Promise<StageRunReport> {
  const startedAt = Date.now();
  const cases: SpecCaseResult[] = [];
  const consoleEntries: ConsoleEntry[] = [];

  try {
    /*
     * 放在 try 里面，让它变成一份 `status: 'error'` 的报告而不是一个
     * 未捕获的 rejection。工作台那边收到报告会把原因显示出来；
     * 抛出去的话学员只看到「验收挂了」，看不到是题目写错了。
     *
     * `assertGatesAreStructural` 仍然导出，给 `projects:verify` 直接调 ——
     * 那条路上就是要它抛，因为那是出题期，题目根本不该入库。
     */
    assertGatesAreStructural(options.gates);
    /*
     * **每次验收都从干净的模块命名空间开始。**
     *
     * 用例里的 `importlib.reload(x)` 是在**同一个命名空间**里重跑新源码，
     * 学员删掉的函数不会消失 —— 于是「先通过一次、再把代码改坏」还是全绿。
     * 这里先把 /lab 下的模块踢出 `sys.modules`，reload 前那次 import
     * 才是真的从头来。钉这条行为的用例见 tests/llmlab/stages.test.ts。
     */
    options.world.session.resetLabModules();
    const builtins = createTrainLabModules(options.world);

    for (const spec of options.specs) {
      const collector = createSpecCollector();
      const runtime = createModuleRuntime({
        files: { ...(options.files ?? {}), [spec.path]: spec.content },
        builtins,
        globals: { ...collector.globals, console: makeConsole(consoleEntries) },
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
          }, options.caseWallClockMs ?? 120_000, `${testCase.suite} ${testCase.name}`);
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
      metrics: trainLabMetrics(options.world),
      console: consoleEntries.slice(0, 200),
      wallClockMs: Date.now() - startedAt,
      error: detail.message,
    };
  }

  const metrics = trainLabMetrics(options.world);
  // 门槛只看整次运行的聚合指标 —— 一次训练的计量本来就是整体的
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
      text: args.map((v) => (typeof v === 'string' ? v : safeJson(v))).join(' '),
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
