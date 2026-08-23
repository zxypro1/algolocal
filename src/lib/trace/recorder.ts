/**
 * 轨迹记录器：被插桩后的代码在运行时调用它。
 *
 * 注入方式和 console 收集器一样，走 new Function 的形参，不碰全局。
 */

import { formatConsoleValue } from '../consoleFormat';
import { TRACE_LIMITS, type ExecutionTrace, type TraceStep, type TraceVariable } from './types';

export interface TraceRecorder {
  /** 注入给插桩代码的对象 */
  api: {
    enter(fn: string): void;
    exit(): void;
    step(line: number, vars: Record<string, unknown>): void;
  };
  trace: ExecutionTrace;
}

function clip(text: string): string {
  if (text.length <= TRACE_LIMITS.maxValueChars) return text;
  return `${text.slice(0, TRACE_LIMITS.maxValueChars)}…`;
}

export function createTraceRecorder(entryName = '(top level)'): TraceRecorder {
  const steps: TraceStep[] = [];
  const stack: string[] = [entryName];
  let dropped = 0;

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
      step(line: number, vars: Record<string, unknown>) {
        // 到上限就只计数不再记录。代码继续跑完 —— 中途抛异常反而更难解释。
        if (steps.length >= TRACE_LIMITS.maxSteps) {
          dropped += 1;
          trace.droppedSteps = dropped;
          trace.truncated = true;
          return;
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
          depth: stack.length - 1,
          fn: stack[stack.length - 1],
          vars: snapshot,
          stack: [...stack],
        });
      },
    },
  };
}
