/**
 * 轨迹记录器：被插桩后的代码在运行时调用它。
 *
 * 注入方式和 console 收集器一样，走 new Function 的形参，不碰全局。
 */

import { formatConsoleValue } from '../consoleFormat';
import {
  TRACE_LIMITS,
  type Breakpoint,
  type ExecutionTrace,
  type TraceStep,
  type TraceVariable,
} from './types';

export interface TraceRecorder {
  /** 注入给插桩代码的对象 */
  api: {
    enter(fn: string): void;
    exit(): void;
    step(line: number, vars: Record<string, unknown>, file?: string): void;
  };
  trace: ExecutionTrace;
}

function clip(text: string): string {
  if (text.length <= TRACE_LIMITS.maxValueChars) return text;
  return `${text.slice(0, TRACE_LIMITS.maxValueChars)}…`;
}

/**
 * 把断点条件 / 日志模板编译成一个吃「变量名→值」的函数。
 *
 * 在录制时求值而不是回放时：轨迹里存的是格式化后的字符串快照，
 * 拿字符串没法判断 `i > 3` 这种条件。这里能拿到活的值。
 */
const compiledCache = new Map<string, ((values: unknown[]) => unknown) | null>();

function compileExpression(expression: string, names: string[]): ((values: unknown[]) => unknown) | null {
  // 每一步都 new Function 一次的话，5000 步就是 5000 次编译
  const key = `${names.join(',')}|${expression}`;
  if (compiledCache.has(key)) return compiledCache.get(key)!;
  const compiled = compileUncached(expression, names);
  compiledCache.set(key, compiled);
  return compiled;
}

function compileUncached(expression: string, names: string[]): ((values: unknown[]) => unknown) | null {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `return (${expression});`);
    return (values: unknown[]) => fn(...values);
  } catch {
    // 表达式本身语法错误 —— 当作不成立，不要把用户的运行搞崩
    return null;
  }
}

/** 日志断点模板：把 `{expr}` 换成求值结果 */
function renderLogMessage(template: string, names: string[], values: unknown[]): string {
  return template.replace(/\{([^{}]+)\}/g, (whole, expression) => {
    const compiled = compileExpression(String(expression), names);
    if (!compiled) return whole;
    try {
      return formatConsoleValue(compiled(values));
    } catch {
      return whole;
    }
  });
}

export function createTraceRecorder(
  entryName = '(top level)',
  breakpoints: Breakpoint[] = []
): TraceRecorder {
  const steps: TraceStep[] = [];
  const stack: string[] = [entryName];
  let dropped = 0;
  let hitsAfterCap = 0;

  // 按行建索引：每一步都遍历一遍断点列表太浪费
  const byLine = new Map<number, Breakpoint[]>();
  for (const breakpoint of breakpoints) {
    if (!breakpoint.enabled) continue;
    const list = byLine.get(breakpoint.line) || [];
    list.push(breakpoint);
    byLine.set(breakpoint.line, list);
  }

  const trace: ExecutionTrace = {
    steps,
    droppedSteps: 0,
    truncated: false,
    completed: false,
  };

  return {
    trace,
    api: {
      enter(fn: string) {
        stack.push(fn);
      },
      exit() {
        // 保底：栈底那一层不弹，插桩配对出问题时也不至于把栈掏空
        if (stack.length > 1) stack.pop();
      },
      step(line: number, vars: Record<string, unknown>, file?: string) {
        // 先算断点，再考虑是否要记录：命中的步永远值得留下
        const active = byLine.get(line);
        let hit = false;
        let logText: string | undefined;

        if (active && active.length > 0) {
          const names = Object.keys(vars);
          const values = names.map((name) => vars[name]);
          for (const breakpoint of active) {
            // 条件先算：既有条件又有日志时，两者都要受这个条件约束
            let conditionMet = true;
            if (breakpoint.condition) {
              conditionMet = false;
              const compiled = compileExpression(breakpoint.condition, names);
              if (compiled) {
                try {
                  conditionMet = Boolean(compiled(values));
                } catch {
                  // 条件在这一帧求值失败（比如引用了还不存在的变量）就当不成立
                }
              }
            }
            if (!conditionMet) continue;

            if (breakpoint.logMessage) {
              // 日志断点只记一条，不算命中，也就不会让「继续」停下来
              logText = renderLogMessage(breakpoint.logMessage, names, values);
            } else {
              hit = true;
            }
          }
        }

        // 到上限就只计数不再记录，代码继续跑完 —— 中途抛异常反而更难解释。
        // 但命中断点的步要例外：断点设在长循环的后半段时，
        // 「录不下」等于「永远命中 0 次」，那正是最需要它的场景。
        if (steps.length >= TRACE_LIMITS.maxSteps) {
          trace.truncated = true;
          if (!hit || hitsAfterCap >= TRACE_LIMITS.maxHitStepsAfterCap) {
            dropped += 1;
            trace.droppedSteps = dropped;
            return;
          }
          hitsAfterCap += 1;
        }

        const snapshot: TraceVariable[] = [];
        for (const name of Object.keys(vars)) {
          if (snapshot.length >= TRACE_LIMITS.maxVarsPerStep) break;
          let value: string;
          try {
            // 立刻格式化成字符串 = 快照。存引用的话，
            // 后面每一次 push/set 都会把之前记录的那一步一起改掉。
            value = clip(formatConsoleValue(vars[name]));
          } catch {
            value = '[unreadable]';
          }
          snapshot.push({ name, value });
        }

        steps.push({
          line,
          ...(file ? { file } : {}),
          depth: stack.length - 1,
          fn: stack[stack.length - 1],
          vars: snapshot,
          stack: [...stack],
          ...(hit ? { hit: true } : {}),
          ...(logText !== undefined ? { log: logText } : {}),
        });
      },
    },
  };
}
