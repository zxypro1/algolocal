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
    /** 返回这次调用的帧 id，插桩代码会把它带在每一步上 */
    /** 调用发生前由调用方宣告自己是谁，好让被调方的 enter 找到正确的父帧 */
    at(frame: number): void;
    enter(fn: string): number;
    exit(frame: number): void;
    step(line: number, vars: Record<string, unknown>, file?: string, frame?: number): void;
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
  let dropped = 0;
  let hitsAfterCap = 0;

  /**
   * 每次函数调用一个「帧」，帧在进入时把自己的调用栈固定下来。
   *
   * 不能让每一步去读一个共享的 LIFO 栈：工程题全是 async，两个协程交替
   * 推进时，await 之后的步会被算到另一个函数头上 —— 实测 alpha 的语句
   * 会显示成 fn=beta。进入时刻是同步发生在调用者体内的，那一刻的父帧是准的，
   * 所以把栈在进入时算好、之后每一步都引用自己的帧。
   */
  interface Frame {
    name: string;
    stack: string[];
    depth: number;
    live: boolean;
  }
  const rootFrame: Frame = { name: entryName, stack: [entryName], depth: 0, live: true };
  const frames = new Map<number, Frame>([[0, rootFrame]]);
  let nextFrameId = 1;
  /** 当前正在执行的帧。每条 step 都会更新它，所以嵌套调用能找到正确的父帧。 */
  let currentFrame = 0;

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
      at(frame: number) {
        if (frames.has(frame)) currentFrame = frame;
      },
      enter(fn: string): number {
        // 进入是同步发生在调用者体内的，此刻的 currentFrame 就是真正的调用者
        const parent = frames.get(currentFrame) || rootFrame;
        const id = nextFrameId++;
        frames.set(id, {
          name: fn,
          stack: [...parent.stack, fn],
          depth: parent.depth + 1,
          live: true,
        });
        currentFrame = id;
        return id;
      },
      exit(frame: number) {
        const target = frames.get(frame);
        if (target) target.live = false;
        // 回到调用者：帧自己记着父链，不依赖弹栈顺序，
        // 所以 await 之后乱序退出也不会把归属搞错
        if (currentFrame === frame) {
          const parentName = target?.stack[target.stack.length - 2];
          for (const [id, candidate] of frames) {
            if (candidate.live && candidate.name === parentName && candidate.depth === (target?.depth ?? 1) - 1) {
              currentFrame = id;
              break;
            }
          }
        }
        // 帧用完就丢，否则一轮跑下来 Map 会一直涨
        if (!target?.live) frames.delete(frame);
      },
      step(line: number, vars: Record<string, unknown>, file?: string, frame?: number) {
        // 这一步属于哪个帧由插桩直接给出，不去猜共享栈的栈顶
        const own = (frame !== undefined && frames.get(frame)) || frames.get(currentFrame) || rootFrame;
        if (frame !== undefined) currentFrame = frame;
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
          depth: own.depth,
          fn: own.name,
          vars: snapshot,
          stack: [...own.stack],
          ...(hit ? { hit: true } : {}),
          ...(logText !== undefined ? { log: logText } : {}),
        });
      },
    },
  };
}
