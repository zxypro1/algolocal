/**
 * 执行轨迹：把一次运行「录」下来，之后可以来回拖着看。
 *
 * 之所以做成轨迹回放而不是断点调试器：浏览器主线程没法真正阻塞，
 * 想要真断点就得把用户代码搬进 Worker 再配 Atomics.wait。而做题时
 * 真正想知道的是「循环第 3 轮的时候 seen 里有什么」——
 * 这种问题拖时间轴比反复设断点、单步、再重跑要快得多，而且能往回看。
 */

export interface TraceVariable {
  name: string;
  /** 已经格式化成字符串的快照。存引用的话，后面的改动会把历史一起改掉。 */
  value: string;
}

export interface Breakpoint {
  /** 源码行号（1 起） */
  line: number;
  enabled: boolean;
  /**
   * 条件断点：一个在该行作用域里求值的表达式，为真才算命中。
   * 在**录制时**用活的变量求值 —— 轨迹里存的是字符串快照，拿快照没法求值。
   */
  condition?: string;
  /**
   * 日志断点：不算命中，只在经过这行时记一条消息。
   * `{}` 里的部分当表达式求值，和 VS Code 的 logpoint 一致。
   */
  logMessage?: string;
}

export interface TraceStep {
  /** 原始源码的行号（1 起） */
  line: number;
  /** 调用栈深度，用于 UI 缩进 */
  depth: number;
  /** 当前函数名，栈顶 */
  fn: string;
  /** 这一步执行前，当前函数作用域里可见的变量 */
  vars: TraceVariable[];
  /** 完整调用栈，栈底在前 */
  stack: string[];
  /** 这一步命中了断点（含条件成立的条件断点） */
  hit?: boolean;
  /** 日志断点在这一步产生的消息 */
  log?: string;
}

export interface ExecutionTrace {
  steps: TraceStep[];
  /** 因为超出上限而被丢弃的步数 */
  droppedSteps: number;
  /** 轨迹是否因为超限而被截断 */
  truncated: boolean;
  /** 采集轨迹时代码是否正常结束 */
  completed: boolean;
  error?: string;
}

export const TRACE_LIMITS = {
  /** 最多记录多少步。超过就停止记录，但代码继续跑完。 */
  maxSteps: 5000,
  /** 单个变量值的最大字符数 */
  maxValueChars: 200,
  /** 每一步最多记录多少个变量 */
  maxVarsPerStep: 24,
  /**
   * 到了 maxSteps 之后仍然给命中断点的步留的额外名额。
   * 不留的话，断点设在一个很长的循环的后半段就永远「命中 0 次」——
   * 而那恰恰是最需要断点的场景。
   */
  maxHitStepsAfterCap: 200,
} as const;

/**
 * 工厂而不是常量：导出一个共享对象的话，`{ ...EMPTY_TRACE, error }`
 * 展开出来的每一份都指向同一个 steps 数组。
 */
export function emptyTrace(): ExecutionTrace {
  return { steps: [], droppedSteps: 0, truncated: false, completed: false };
}
