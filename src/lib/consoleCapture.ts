/**
 * 捕获用户代码在执行期间产生的 console 输出。
 *
 * 做法是把一个替身 console 作为形参注入到 new Function 里，而不是去改全局 console：
 * 全局改法在并发运行、异常提前返回时很容易漏掉恢复，而且会把应用自己的日志一起吞掉。
 */

import { CONSOLE_LIMITS, formatConsoleArgs } from './consoleFormat';

export { CONSOLE_LIMITS, formatConsoleArgs };

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleLogEntry {
  level: ConsoleLevel;
  text: string;
  /**
   * user   —— 用户自己写的代码打的
   * system —— 测试框架 / 运行时打的（例如断言失败的说明）
   */
  source: 'user' | 'system';
}

export interface ConsoleCollector {
  /**
   * 注入给用户代码的替身 console。
   * 除了被捕获的几个级别，其余 console 方法原样透传给真实 console。
   */
  console: Record<ConsoleLevel, (...args: unknown[]) => void> & Record<string, unknown>;
  entries: ConsoleLogEntry[];
  /** 是否因为超过条数上限而丢弃了后续输出 */
  truncated: boolean;
  reset(): void;
}

const LEVELS: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

/**
 * 替身 console 必须是「完整的」console。
 * 用户代码里出现 console.table / console.time / console.group 是很正常的事，
 * 如果替身上没有这些方法，调用就会抛 TypeError，整条用例直接失败 ——
 * 本来只是想看个日志，结果把题做挂了。
 * 所以先把真实 console 的所有方法搬过来（绑定回真实 console 以免 this 丢失），
 * 再覆盖掉我们要捕获的那几个级别。
 */
function baseConsole(): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  const real = typeof console !== 'undefined' ? (console as unknown as Record<string, unknown>) : {};

  const names = new Set<string>([
    ...Object.keys(real),
    // 兜底：某些环境下这些方法在原型上，Object.keys 取不到
    'table', 'dir', 'dirxml', 'trace', 'group', 'groupCollapsed', 'groupEnd',
    'time', 'timeEnd', 'timeLog', 'count', 'countReset', 'assert', 'clear', 'profile', 'profileEnd',
  ]);

  for (const name of names) {
    const value = real[name];
    if (typeof value === 'function') {
      base[name] = (value as (...args: unknown[]) => unknown).bind(real);
    }
  }

  // 真的什么都没有时（比如某些 worker 环境），至少给个空实现，别让用户代码抛异常
  for (const name of names) {
    if (typeof base[name] !== 'function') base[name] = () => undefined;
  }

  return base;
}

export function createConsoleCollector(source: 'user' | 'system' = 'user'): ConsoleCollector {
  const collector: ConsoleCollector = {
    console: baseConsole() as ConsoleCollector['console'],
    entries: [],
    truncated: false,
    reset() {
      collector.entries = [];
      collector.truncated = false;
    },
  };

  for (const level of LEVELS) {
    collector.console[level] = (...args: unknown[]) => {
      // 死循环里不停打日志是最常见的把 UI 打挂的方式，超过上限后直接丢弃。
      if (collector.entries.length >= CONSOLE_LIMITS.maxEntries) {
        collector.truncated = true;
        return;
      }
      collector.entries.push({ level, text: formatConsoleArgs(args), source });
    };
  }

  return collector;
}

/**
 * 把 Python 的 stdout / stderr 文本切成日志条目。
 * Pyodide 那条路径拿到的是整块文本，不是一次次调用。
 */
export function entriesFromPythonOutput(stdout: string, stderr: string): {
  entries: ConsoleLogEntry[];
  truncated: boolean;
} {
  const entries: ConsoleLogEntry[] = [];
  let truncated = false;

  const push = (text: string, level: ConsoleLevel) => {
    if (entries.length >= CONSOLE_LIMITS.maxEntries) {
      truncated = true;
      return;
    }
    const clipped =
      text.length > CONSOLE_LIMITS.maxEntryChars
        ? `${text.slice(0, CONSOLE_LIMITS.maxEntryChars)}… (${text.length - CONSOLE_LIMITS.maxEntryChars} more characters truncated)`
        : text;
    entries.push({ level, text: clipped, source: 'user' });
  };

  // 末尾的换行是 print 自带的，不该多出一条空日志
  const lines = (text: string) => text.replace(/\n$/, '').split('\n');

  // stderr 通常是报错信息，比 stdout 更值得看。
  // 先给它留出一半配额，否则一个话痨解法的 stdout 会把 stderr 整个挤掉。
  const stderrLines = stderr ? lines(stderr) : [];
  const stdoutLines = stdout ? lines(stdout) : [];
  const stderrBudget = Math.min(stderrLines.length, Math.ceil(CONSOLE_LIMITS.maxEntries / 2));
  const stdoutBudget = CONSOLE_LIMITS.maxEntries - stderrBudget;

  stdoutLines.slice(0, stdoutBudget).forEach((line) => push(line, 'log'));
  if (stdoutLines.length > stdoutBudget) truncated = true;

  stderrLines.forEach((line) => push(line, 'error'));
  if (stderrLines.length > stderrBudget) truncated = true;

  return { entries, truncated };
}
