/**
 * 关卡运行器：把工作区 + 隐藏 spec 跑一遍，产出测试结果与工程指标
 */
import { driveVirtualClock, VirtualClockDeadlockError, VirtualClockTimeoutError } from './clock';
import { createLabGlobals, createLabModules, Lab } from './lab';
import { createModuleRuntime, TranspileFn } from './moduleRuntime';
import { AssertionError, createSpecCollector } from './specRunner';
import type {
  GateResult,
  LabMetrics,
  LabNetworkConfig,
  MetricGate,
  SpecCaseResult,
  SpecFile,
  StageRunReport,
} from './types';

export interface RunStageOptions {
  /** 工作区文件：路径 -> 源码 */
  files: Record<string, string>;
  specs: SpecFile[];
  lab?: LabNetworkConfig;
  gates?: MetricGate[];
  transpile?: TranspileFn;
  /** 单个用例的真实时间预算 */
  caseWallClockMs?: number;
}

/**
 * 空指标。
 *
 * 每次都新建一份：之前这里是模块级常量 + 浅拷贝返回，嵌套的 requests / counters
 * 仍然指向同一个对象，任何调用方改一下就永久污染了后面所有次运行 ——
 * verify 脚本、jest、worker 都是一个进程里连着跑很多关。
 */
function emptyMetrics(): LabMetrics {
  return {
    virtualElapsedMs: 0,
    maxConcurrency: 0,
    concurrencyTimeline: [],
    requests: { total: 0, ok: 0, failed: 0, throttled: 0, retries: 0, duplicated: 0, byUrl: {} },
    samples: [],
    counters: {},
  };
}

export function getMetricValue(metrics: LabMetrics, path: string): number {
  const segments = path.split('.');
  let current: unknown = metrics;

  for (let index = 0; index < segments.length; index += 1) {
    if (current == null || typeof current !== 'object') return Number.NaN;
    // 自定义计数器的名字本身可能带点（counters.order.processed），
    // 所以每一层先尝试把剩余路径当作字面量 key。
    const remaining = segments.slice(index).join('.');
    if (Object.prototype.hasOwnProperty.call(current, remaining)) {
      current = (current as any)[remaining];
      break;
    }
    current = (current as any)[segments[index]];
  }

  if (typeof current === 'number') return current;

  /**
   * 没被自增过的计数器就是 0，不是「测不出来」。
   *
   * 返回 NaN 的话，`counters.retries lte 3` 这种门槛会把「一次都没重试」的最优实现
   * 判成失败（evaluateGate 见到非有限值直接判负）。未知的顶层指标仍然返回 NaN，
   * 那才是真的写错了指标名。
   */
  if (current === undefined && path.startsWith('counters.')) return 0;

  return Number.NaN;
}

export function evaluateGate(metrics: LabMetrics, gate: MetricGate): GateResult {
  const actual = getMetricValue(metrics, gate.metric);
  let passed = false;
  if (Number.isFinite(actual)) {
    switch (gate.op) {
      case 'lte':
        passed = actual <= gate.value;
        break;
      case 'lt':
        passed = actual < gate.value;
        break;
      case 'gte':
        passed = actual >= gate.value;
        break;
      case 'gt':
        passed = actual > gate.value;
        break;
      case 'eq':
        passed = actual === gate.value;
        break;
    }
  }
  return { gate, actual, passed };
}

/** 带用例标签的指标快照，用于按 scope 评估门槛 */
export interface LabeledMetrics {
  label: string;
  metrics: LabMetrics;
}

export function evaluateGates(gates: MetricGate[], labeled: LabeledMetrics[], aggregate: LabMetrics): GateResult[] {
  return gates.map((gate) => {
    if (!gate.scope) return evaluateGate(aggregate, gate);
    const matched = labeled.filter((entry) => entry.label.includes(gate.scope!));
    if (matched.length === 0) {
      return { gate, actual: Number.NaN, passed: false };
    }
    return evaluateGate(aggregateMetrics(matched.map((entry) => entry.metrics)), gate);
  });
}

/** 把每个用例的指标聚合成一次运行的整体画像 */
export function aggregateMetrics(snapshots: LabMetrics[]): LabMetrics {
  if (snapshots.length === 0) return emptyMetrics();

  const representative = snapshots.reduce((best, current) =>
    current.requests.total > best.requests.total ? current : best
  );

  const requests = snapshots.reduce(
    (acc, snapshot) => {
      acc.total += snapshot.requests.total;
      acc.ok += snapshot.requests.ok;
      acc.failed += snapshot.requests.failed;
      acc.throttled += snapshot.requests.throttled;
      acc.retries += snapshot.requests.retries;
      acc.duplicated += snapshot.requests.duplicated;
      for (const [url, count] of Object.entries(snapshot.requests.byUrl)) {
        acc.byUrl[url] = (acc.byUrl[url] || 0) + count;
      }
      return acc;
    },
    { total: 0, ok: 0, failed: 0, throttled: 0, retries: 0, duplicated: 0, byUrl: {} as Record<string, number> }
  );

  const counters: Record<string, number> = {};
  for (const snapshot of snapshots) {
    for (const [key, value] of Object.entries(snapshot.counters)) {
      counters[key] = (counters[key] || 0) + value;
    }
  }

  return {
    // 延迟取「最慢的那个场景」，并发取全局峰值
    virtualElapsedMs: Math.max(...snapshots.map((snapshot) => snapshot.virtualElapsedMs)),
    maxConcurrency: Math.max(...snapshots.map((snapshot) => snapshot.maxConcurrency)),
    concurrencyTimeline: representative.concurrencyTimeline,
    requests,
    samples: representative.samples,
    counters,
  };
}

function describeError(error: unknown): { message: string; expected?: string; actual?: string } {
  if (error instanceof AssertionError) {
    return { message: error.message, expected: error.expected, actual: error.actual };
  }
  if (error instanceof VirtualClockDeadlockError) {
    return {
      message: `${error.message}\nHint: every await must eventually be resolved — check for a promise you never settle.`,
    };
  }
  if (error instanceof VirtualClockTimeoutError) {
    return { message: error.message };
  }
  if (error instanceof Error) {
    const stackLine = (error.stack || '').split('\n')[1]?.trim();
    return { message: stackLine ? `${error.message}\n  ${stackLine}` : error.message };
  }
  return { message: String(error) };
}

export async function runStage(options: RunStageOptions): Promise<StageRunReport> {
  const startedAt = Date.now();
  const labConfig: LabNetworkConfig = options.lab || {};
  const lab = new Lab(labConfig);
  const labModules = createLabModules(lab);
  const labGlobals = createLabGlobals(lab);

  const cases: SpecCaseResult[] = [];
  const snapshots: LabMetrics[] = [];
  const labeledSnapshots: LabeledMetrics[] = [];
  const consoleEntries: StageRunReport['console'] = [];

  try {
    for (const spec of options.specs) {
      const collector = createSpecCollector();
      const runtime = createModuleRuntime({
        files: { ...options.files, [spec.path]: spec.content },
        builtins: labModules,
        globals: { ...labGlobals, ...collector.globals },
        transpile: options.transpile,
      });

      // 收集阶段：spec 文件同步注册用例
      lab.reset(labConfig);
      runtime.require(`./${spec.path}`);
      // 顶层的 afterAll 要等整个文件求值完，才知道该挂到哪个用例后面
      collector.finalize();

      for (const testCase of collector.cases) {
        if (testCase.skipped) {
          cases.push({
            suite: testCase.suite,
            name: testCase.name,
            passed: true,
            durationMs: 0,
            error: 'skipped',
          });
          continue;
        }

        lab.reset(labConfig);
        const caseStartedAt = Date.now();
        let failure: { message: string; expected?: string; actual?: string } | null = null;

        try {
          await driveVirtualClock(
            lab.clock,
            async () => {
              for (const hook of testCase.beforeEach.flat()) await hook();
              try {
                await testCase.fn();
              } finally {
                for (const hook of testCase.afterEach.flat()) await hook();
              }
            },
            { maxWallClockMs: options.caseWallClockMs ?? 8000 }
          );
        } catch (error) {
          failure = describeError(error);
        }

        const snapshot = lab.snapshot();
        snapshots.push(snapshot);
        labeledSnapshots.push({
          label: [...testCase.suite, testCase.name].join(' > '),
          metrics: snapshot,
        });
        consoleEntries.push(...lab.console);

        cases.push({
          suite: testCase.suite,
          name: testCase.name,
          passed: !failure,
          durationMs: Date.now() - caseStartedAt,
          error: failure?.message,
          expected: failure?.expected,
          actual: failure?.actual,
        });
      }
    }
  } catch (error) {
    const detail = describeError(error);
    const passedSoFar = cases.filter((testCase) => testCase.passed).length;
    return {
      status: 'error',
      // 已经跑完的用例里该失败的照样算失败，否则 total / passed / failed 三个数对不上，
      // 面板上会出现「3/4 通过」却一个失败都没有的自相矛盾
      totals: { total: cases.length, passed: passedSoFar, failed: cases.length - passedSoFar },
      cases,
      gates: [],
      metrics: aggregateMetrics(snapshots),
      console: consoleEntries.slice(0, 200),
      wallClockMs: Date.now() - startedAt,
      error: detail.message,
    };
  }

  const metrics = aggregateMetrics(snapshots);
  const gates = evaluateGates(options.gates || [], labeledSnapshots, metrics);
  const passed = cases.filter((testCase) => testCase.passed).length;
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
