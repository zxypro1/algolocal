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
  /** 注入给用户代码的替身 console */
  console: Record<ConsoleLevel, (...args: unknown[]) => void>;
  entries: ConsoleLogEntry[];
  /** 是否因为超过条数上限而丢弃了后续输出 */
  truncated: boolean;
  reset(): void;
}

const LEVELS: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

export function createConsoleCollector(source: 'user' | 'system' = 'user'): ConsoleCollector {
  const collector: ConsoleCollector = {
    console: {} as ConsoleCollector['console'],
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

  if (stdout) lines(stdout).forEach((line) => push(line, 'log'));
  if (stderr) lines(stderr).forEach((line) => push(line, 'error'));

  return { entries, truncated };
}
