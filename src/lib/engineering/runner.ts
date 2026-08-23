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

/** 没开轨迹时插桩调用的空落点 */
const NOOP_TRACE = {
  enter: () => undefined,
  exit: () => undefined,
  step: () => undefined,
};

/**
 * 把插桩挂到转译链路上。
 *
 * 只插用户的工作区文件：spec 文件插了会把断言和 describe/it 也录进轨迹，
 * @lab/* 是内建模块根本不过 transpile。
 */
function wrapTranspile(
  transpile: TranspileFn | undefined,
  trace: RunStageOptions['trace'],
  specPath: string
): TranspileFn | undefined {
  if (!transpile || !trace) return transpile;
  return (code: string, filePath: string) => {
    const normalized = filePath.replace(/^\.\//, '');
    if (normalized === specPath) return transpile(code, filePath);
    if (trace.onlyFiles && !trace.onlyFiles.has(normalized)) return transpile(code, filePath);
    let instrumented: string;
    try {
      instrumented = trace.instrument(code, normalized);
    } catch (error) {
      // 插桩失败不该让这一关跑不起来，但也不能装作没发生：
      // 静默吞掉的话，用户看到的是「录了个空轨迹」而不是「这个文件没能插桩」。
      trace.onInstrumentError?.(normalized, error as Error);
      return transpile(code, filePath);
    }
    return transpile(instrumented, filePath);
  };
}

export interface RunStageOptions {
  /** 工作区文件：路径 -> 源码 */
  files: Record<string, string>;
  specs: SpecFile[];
  lab?: LabNetworkConfig;
  gates?: MetricGate[];
  transpile?: TranspileFn;
  /** 单个用例的真实时间预算 */
  caseWallClockMs?: number;
  /**
   * 开启轨迹录制。
   *
   * 只对工作区里的用户源码插桩，spec 和 @lab/* 内建模块一律不碰 ——
   * 插桩测试代码只会录出一堆断言噪音，而且会让「用例本身」出现在调用栈里。
   */
  trace?: {
    instrument: (code: string, filePath: string) => string;
    api: unknown;
    /**
     * 只给这些文件插桩。传空集合表示全插。
     *
     * 平台提供的只读基础设施（disk.ts、contract.ts 之类）不该进轨迹：
     * 学员调的是自己的代码，把库的内部一步步录进去既是噪音，
     * 又会把 5000 步的额度花在别人的代码上，自己的反而被截断。
     */
    onlyFiles?: Set<string>;
    /** 某个文件插桩失败时的回调，用来让失败可见而不是变成空轨迹 */
    onInstrumentError?: (filePath: string, error: Error) => void;
  };
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
        globals: {
          ...labGlobals,
          ...collector.globals,
          // 没开轨迹时也要有个落点：插桩后的代码里有 __trace.step()，
          // 而模块是按文件缓存的，同一进程里可能混着插过桩和没插桩的。
          __trace: options.trace?.api ?? NOOP_TRACE,
        },
        transpile: wrapTranspile(options.transpile, options.trace, spec.path),
      });

      // 收集阶段：spec 文件同步注册用例。
      // 用户模块的顶层代码也在这一步执行，它打的日志同样要留下 ——
      // 之前这些日志会被下面每条用例前的 lab.reset() 直接抹掉，
      // 于是「在模块顶层 console.log」看起来像是完全没生效。
      lab.reset(labConfig);
      runtime.require(`./${spec.path}`);
      const loadTimeConsole = [...lab.console];
      // 顶层的 afterAll 要等整个文件求值完，才知道该挂到哪个用例后面
      collector.finalize();

      // 原样保留 source：这些就是用户在模块顶层打的，标成 system 会被 UI
      // 渲染成 [runtime] 平台输出，还会丢掉 warn/error 级别。
      consoleEntries.push(...loadTimeConsole);

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
        // lab 每条用例前会 reset，所以 lab.console 就是这一条用例的输出。
        // 既挂到用例上（这样日志能对上是哪条用例产生的），也并进整体列表。
        const caseConsole = [...lab.console];
        consoleEntries.push(...caseConsole);

        cases.push({
          suite: testCase.suite,
          name: testCase.name,
          passed: !failure,
          durationMs: Date.now() - caseStartedAt,
          error: failure?.message,
          expected: failure?.expected,
          actual: failure?.actual,
          console: caseConsole,
          consoleTruncated: lab.consoleTruncated,
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
