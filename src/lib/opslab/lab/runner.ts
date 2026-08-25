/**
 * 跑一个 ops 关卡的判定
 *
 * 和代码形态的 `runStage` 是姐妹：同一套隐藏用例机制（describe / it / expect）、
 * 同一份 `StageRunReport`，所以结果面板、计分卡、AI 评审、进度存档全部复用。
 *
 * 两点不同，都是本质的：
 *  1. 判定读的是**工作台里那个世界**，不是另起一个干净集群 ——
 *     学员在终端里做过的事必须算数；
 *  2. 时间由集群的虚拟时钟推进（`settle` / `advance`），不是 `@lab/env` 那个时钟。
 */
import { createModuleRuntime } from '../../engineering/moduleRuntime';
import { AssertionError, createSpecCollector } from '../../engineering/specRunner';
import type {
  ConsoleEntry, LabMetrics, SpecCaseResult, SpecFile, StageRunReport,
} from '../../engineering/types';
import { createOpsLabModules } from './modules';
import type { OpsWorld } from './world';

export interface RunOpsStageOptions {
  world: OpsWorld;
  specs: SpecFile[];
  /** 隐藏用例之外，还要让 spec 能 import 的文件（一般是学员的 manifest 目录） */
  files?: Record<string, string>;
  transpile?: (code: string, filePath: string) => string;
  /** 单条用例的真实时间预算 */
  caseWallClockMs?: number;
}

/** ops 关卡没有请求级指标，但报告结构要一致 —— 给一份空的 */
export function emptyMetrics(virtualElapsedMs: number): LabMetrics {
  return {
    virtualElapsedMs,
    maxConcurrency: 0,
    concurrencyTimeline: [],
    requests: { total: 0, ok: 0, failed: 0, throttled: 0, retries: 0, duplicated: 0, byUrl: {} },
    samples: [],
    counters: {},
  };
}

export async function runOpsStage(options: RunOpsStageOptions): Promise<StageRunReport> {
  const startedAt = Date.now();
  const startedVirtual = options.world.now();
  const cases: SpecCaseResult[] = [];
  const consoleEntries: ConsoleEntry[] = [];

  const builtins = createOpsLabModules(options.world);

  try {
    for (const spec of options.specs) {
      const collector = createSpecCollector();
      const runtime = createModuleRuntime({
        files: { ...(options.files ?? {}), [spec.path]: spec.content },
        builtins,
        globals: {
          ...collector.globals,
          console: makeConsole(consoleEntries, () => options.world.now()),
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
          }, options.caseWallClockMs ?? 30_000, `${testCase.suite} ${testCase.name}`);
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
      metrics: emptyMetrics(options.world.now() - startedVirtual),
      console: consoleEntries.slice(0, 200),
      wallClockMs: Date.now() - startedAt,
      error: detail.message,
    };
  }

  const passed = cases.filter((item) => item.passed).length;
  const failed = cases.length - passed;
  return {
    status: failed === 0 ? 'passed' : 'failed',
    totals: { total: cases.length, passed, failed },
    cases,
    gates: [],
    metrics: emptyMetrics(options.world.now() - startedVirtual),
    console: consoleEntries.slice(0, 200),
    wallClockMs: Date.now() - startedAt,
  };
}

/**
 * 用例的真实时间预算。
 *
 * ops 的用例会真的去跑 kubectl（每条几十毫秒），写错一个 while 循环就能把
 * 页面卡死 —— 集群那边的虚拟时钟有自己的死锁检测，但 spec 自己的循环没有。
 */
function withTimeout<T>(run: () => Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`用例超时（${ms}ms）：${label}`)),
      ms
    );
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

/** 用例里的 console 要进报告，而不是打到宿主的控制台上 */
function makeConsole(sink: ConsoleEntry[], now: () => number) {
  const push = (level: ConsoleEntry['level']) => (...args: unknown[]) => {
    if (sink.length >= 200) return;
    sink.push({
      level,
      text: args.map((value) => (typeof value === 'string' ? value : safeJson(value))).join(' '),
      at: now(),
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
