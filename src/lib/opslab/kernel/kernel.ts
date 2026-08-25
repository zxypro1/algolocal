/**
 * 确定性内核
 *
 * 模拟世界里所有会「过时间」的东西都挂在这上面：控制器、kubelet、容器进程、
 * 协议超时、学员敲的命令。内核保证两件事：
 *
 *  1. **时间只由它推进** —— 没有真实定时器，快进一分钟是一次同步计算；
 *  2. **同样的输入必然得到同样的输出** —— 判定、反向验证、进度恢复全靠这一条。
 *
 * 这不是我们发明的技法，是分布式领域的 deterministic simulation testing
 * （FoundationDB 起头，TigerBeetle / Antithesis 在用）。
 *
 * ## 关于快照
 *
 * 内核快照只有标量（时间、随机数状态、计数器），**挂着的定时器不在里面** ——
 * JS 没法序列化一个闭包。所以规则是：**只能在世界静下来的时刻做快照**
 * （settle 之后、没有前台定时器）。恢复时新建内核、把世界状态灌回去、
 * 重新启动控制器；控制器是 level-triggered 的，从状态重新收敛即可，
 * 这正是真 Kubernetes 控制器的工作方式。
 */
import { createRandom, DeterministicRandom } from './random';
import { Priority, PriorityValue, ScheduleOptions, VirtualClock } from './clock';

/**
 * 抓住真实 setTimeout。
 *
 * 模块加载时就取，一来避免被沙箱里注入的同名函数换掉，
 * 二来 settle 的热循环里每轮都 bind 一次纯属浪费。
 */
const realSetTimeout: typeof setTimeout =
  typeof setTimeout === 'function' ? setTimeout.bind(null) : ((fn: any) => fn()) as any;

/** 让出一个宏任务，等当前所有微任务链排空 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

export class DeadlockError extends Error {
  pending: string[];
  constructor(message: string, pending: string[]) {
    super(message);
    this.name = 'DeadlockError';
    this.pending = pending;
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export interface KernelOptions {
  seed?: number;
  /** 虚拟时间上限，超过说明世界逻辑上跑不完 */
  maxVirtualMs?: number;
  /** 真实墙钟上限，防住失控循环 */
  maxWallClockMs?: number;
}

export interface SettleOptions {
  /** 最多推进多少虚拟时间；超了抛 BudgetExceededError */
  maxVirtualMs?: number;
  /** 连续多少轮「没有定时器可推进但还有任务没结束」判为死锁 */
  maxIdleDrains?: number;
}

export interface KernelSnapshot {
  clock: ReturnType<VirtualClock['snapshot']>;
  random: number;
  taskSeq: number;
}

interface TaskRecord {
  id: number;
  name: string;
  done: boolean;
  error?: unknown;
}

export class Kernel {
  readonly clock = new VirtualClock();
  readonly random: DeterministicRandom;

  private readonly maxVirtualMs: number;
  private readonly maxWallClockMs: number;
  private tasks = new Map<number, TaskRecord>();
  private taskSeq = 0;
  private disposed = false;

  constructor(options: KernelOptions = {}) {
    this.random = createRandom(options.seed ?? 1);
    this.maxVirtualMs = options.maxVirtualMs ?? 24 * 60 * 60 * 1000;   // 一天虚拟时间
    this.maxWallClockMs = options.maxWallClockMs ?? 30_000;
  }

  now(): number {
    return this.clock.now();
  }

  /** 当前活着（还没结束）的任务数 */
  get liveTasks(): number {
    let n = 0;
    for (const task of this.tasks.values()) if (!task.done) n += 1;
    return n;
  }

  sleep(ms: number, options?: ScheduleOptions): Promise<void> {
    return this.clock.sleep(ms, options);
  }

  setTimeout(fn: () => void, ms: number, options?: ScheduleOptions): number {
    return this.clock.schedule(fn, ms, options);
  }

  setInterval(fn: () => void, ms: number, options: ScheduleOptions = {}): number {
    return this.clock.schedule(fn, ms, { ...options, intervalMs: ms });
  }

  clearTimer(id: number): void {
    this.clock.clear(id);
  }

  /**
   * 起一个长期存在的实体（控制器、kubelet、容器进程…）。
   *
   * 任务自己 await 内核的时间原语；内核只负责推进时间和定序，
   * 不打断任务 —— JS 单线程本身就是确定的，不确定性来自真实时间与真实 I/O，
   * 而这两样在这里都不存在。
   */
  spawn(name: string, fn: () => Promise<void> | void): number {
    if (this.disposed) throw new Error('kernel disposed');
    const id = ++this.taskSeq;
    const record: TaskRecord = { id, name, done: false };
    this.tasks.set(id, record);
    Promise.resolve()
      .then(fn)
      .then(
        () => { record.done = true; },
        (error) => { record.done = true; record.error = error; }
      );
    return id;
  }

  /**
   * 有任务抛异常了吗；有就把第一个抛出来。
   *
   * 顺手把已经结束的任务从表里摘掉：一场长会话里每条命令都可能派生探测任务，
   * 不清理的话这张表只增不减。
   */
  private throwTaskFailure(): void {
    let failure: { name: string; error: unknown } | null = null;
    for (const task of this.tasks.values()) {
      if (task.error !== undefined && !failure) {
        failure = { name: task.name, error: task.error };
        task.error = undefined;
      }
      if (task.done && task.error === undefined) this.tasks.delete(task.id);
    }
    if (!failure) return;
    throw failure.error instanceof Error
      ? failure.error
      : new Error(`task "${failure.name}" failed: ${String(failure.error)}`);
  }

  /**
   * 把世界推进到「静下来」为止。
   *
   * 静下来 = 没有前台定时器可推进，且没有任务还在跑。控制器的定期重扫这类
   * 后台定时器不算数，否则永远静不下来。
   */
  async settle(options: SettleOptions = {}): Promise<void> {
    const maxVirtual = options.maxVirtualMs ?? this.maxVirtualMs;
    const maxIdleDrains = options.maxIdleDrains ?? 50;
    const startedVirtual = this.clock.now();
    const startedWall = Date.now();
    let idleDrains = 0;

    while (true) {
      await flushMicrotasks();

      const timerFailure = this.clock.takeFailure();
      if (timerFailure) throw timerFailure.error;
      this.throwTaskFailure();

      if (this.clock.pendingForeground > 0) {
        this.clock.advanceToNext({ includeBackground: false });
        idleDrains = 0;
      } else if (this.liveTasks > 0) {
        // 没有前台定时器，但还有任务在跑 —— 也许它在等一个微任务链，
        // 也许它在等一个永远不会来的东西。多排空几轮再判死锁。
        idleDrains += 1;
        if (idleDrains > maxIdleDrains) {
          const names = [...this.tasks.values()].filter((t) => !t.done).map((t) => t.name);
          throw new DeadlockError(
            `世界静不下来：没有待触发的定时器，但仍有 ${names.length} 个任务没有结束。` +
              `多半是某个 promise 永远不会 resolve。`,
            [...names, ...this.clock.describePending()]
          );
        }
      } else {
        return;                                   // 静了
      }

      if (this.clock.now() - startedVirtual > maxVirtual) {
        throw new BudgetExceededError(
          `虚拟时间超过 ${maxVirtual}ms —— 这个世界收敛不了。挂着的：${this.clock.describePending().join(', ')}`
        );
      }
      if (Date.now() - startedWall > this.maxWallClockMs) {
        throw new BudgetExceededError(
          `真实耗时超过 ${this.maxWallClockMs}ms —— 疑似失控循环。`
        );
      }
    }
  }

  /**
   * 快进一段虚拟时间，沿途所有定时器（含后台）都会触发。
   *
   * 「等 30 秒看滚动更新走到哪」「让证书过期」用这个。
   *
   * **只推进这段窗口内到期的东西**，不会顺带把之后的也跑完 ——
   * 早先的版本在末尾调了一次 settle()，结果「只走 150ms 看看中间态」
   * 会直接看到终态，中间过程完全观察不到。要静止请显式调 settle()。
   */
  async advanceBy(ms: number, options: SettleOptions = {}): Promise<void> {
    const target = this.clock.now() + Math.max(0, Math.floor(ms));
    while (this.clock.now() < target) {
      const next = this.clock.peekNextTime();
      if (next === null || next > target) break;
      this.clock.advanceTo(next);
      await flushMicrotasks();
      const timerFailure = this.clock.takeFailure();
      if (timerFailure) throw timerFailure.error;
      this.throwTaskFailure();
    }
    this.clock.advanceTo(target);
    // 让这一刻被唤醒的微任务链跑完，但不驱动未来的定时器
    await flushMicrotasks();
    const trailing = this.clock.takeFailure();
    if (trailing) throw trailing.error;
    this.throwTaskFailure();
  }

  /**
   * 快照。
   *
   * 只能在静下来的时刻取 —— 挂着的定时器不在快照里（闭包没法序列化），
   * 在有前台定时器时取快照，恢复出来的世界会缺掉那些待办。
   */
  snapshot(): KernelSnapshot {
    if (this.clock.pendingForeground > 0) {
      throw new Error(
        `只能在世界静下来时快照，现在还有 ${this.clock.pendingForeground} 个前台定时器：` +
          this.clock.describePending().join(', ')
      );
    }
    return {
      clock: this.clock.snapshot(),
      random: this.random.state(),
      taskSeq: this.taskSeq,
    };
  }

  /**
   * 从快照恢复。
   *
   * 只恢复内核自己的标量。世界状态由调用方灌回去，控制器由调用方重新 spawn ——
   * 它们是 level-triggered 的，从状态重新收敛就行。
   */
  restore(snapshot: KernelSnapshot): void {
    this.clock.restore(snapshot.clock);
    this.random.restore(snapshot.random);
    this.taskSeq = snapshot.taskSeq;
    this.tasks = new Map();
  }

  dispose(): void {
    this.disposed = true;
    this.tasks = new Map();
    this.clock.clearAll();
  }
}

export function createKernel(options?: KernelOptions): Kernel {
  return new Kernel(options);
}

export { Priority };
export type { PriorityValue, ScheduleOptions };
