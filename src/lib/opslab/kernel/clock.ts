/**
 * opslab 的虚拟时钟
 *
 * 和 src/lib/engineering/clock.ts 那个的区别：那一个是为「一条用例把一段异步跑完」
 * 设计的，单任务驱动；这里要同时驮着几十个长期存在的实体 —— 控制器、kubelet、
 * 容器进程、协议超时 —— 而且必须完全确定。
 *
 * 确定性靠三件事：
 *  1. 时间只由这里推进，不存在真实定时器；
 *  2. 同一时刻到期的定时器按 (时间, 优先级, 注册序号) 唯一定序；
 *  3. 后台定时器（控制器的定期重扫这类）单独标记，不参与「世界静下来了没有」的判断，
 *     否则一个每 30 秒重扫的控制器会让世界永远「有事情要做」。
 */

/** 同一时刻到期时谁先跑。数字小的先。 */
export const Priority = {
  /** apiserver 把变更分发给 watch —— 必须最先，其余人才看得到 */
  DISPATCH: 0,
  /** kubelet：容器状态推进 */
  NODE: 10,
  /** 控制器 reconcile */
  CONTROLLER: 20,
  /** 网络与协议超时 */
  NETWORK: 30,
  /** 学员命令、探测 */
  USER: 40,
} as const;

export type PriorityValue = (typeof Priority)[keyof typeof Priority] | number;

export interface ScheduleOptions {
  /** 同刻定序用，默认 USER */
  priority?: PriorityValue;
  /** 周期性重复的间隔；不传就是一次性 */
  intervalMs?: number;
  /**
   * 后台定时器。
   *
   * 控制器的定期重扫、心跳这类「永远有下一次」的东西标成 background，
   * settle() 就不会因为它们而永远等下去。快进（advanceBy）照样会触发它们。
   */
  background?: boolean;
  /** 调试用的名字，出现在死锁报告里 */
  label?: string;
}

interface Timer {
  id: number;
  time: number;
  seq: number;
  priority: number;
  fn: () => void;
  intervalMs?: number;
  background: boolean;
  label?: string;
}

export class VirtualClock {
  private time = 0;
  private seq = 0;
  private nextId = 1;
  private timers: Timer[] = [];
  /** 定时器回调抛出的第一个异常，由驱动器取走 */
  private failure: { error: unknown; label?: string } | null = null;

  now(): number {
    return this.time;
  }

  /** 还挂着多少定时器（含后台） */
  get pending(): number {
    return this.timers.length;
  }

  /** 还挂着多少**非后台**定时器 —— 「世界还有正事要做吗」看这个 */
  get pendingForeground(): number {
    return this.timers.reduce((n, t) => n + (t.background ? 0 : 1), 0);
  }

  takeFailure(): { error: unknown; label?: string } | null {
    const failure = this.failure;
    this.failure = null;
    return failure;
  }

  schedule(fn: () => void, delayMs: number, options: ScheduleOptions = {}): number {
    const delay = Number.isFinite(delayMs) && delayMs > 0 ? Math.floor(delayMs) : 0;
    const timer: Timer = {
      id: this.nextId++,
      time: this.time + delay,
      seq: this.seq++,
      priority: options.priority ?? Priority.USER,
      fn,
      intervalMs: options.intervalMs,
      background: options.background === true,
      label: options.label,
    };
    this.timers.push(timer);
    return timer.id;
  }

  clear(id: number): void {
    const index = this.timers.findIndex((timer) => timer.id === id);
    if (index >= 0) this.timers.splice(index, 1);
  }

  sleep(ms: number, options: ScheduleOptions = {}): Promise<void> {
    return new Promise((resolve) => this.schedule(resolve, ms, options));
  }

  /** 下一个定时器在什么时刻；没有则 null */
  peekNextTime(options: { includeBackground?: boolean } = {}): number | null {
    const includeBackground = options.includeBackground !== false;
    let earliest: number | null = null;
    for (const timer of this.timers) {
      if (!includeBackground && timer.background) continue;
      if (earliest === null || timer.time < earliest) earliest = timer.time;
    }
    return earliest;
  }

  /**
   * 把时钟推到下一个到期时刻，触发该时刻的**全部**定时器。
   * @returns 是否真的推进了
   */
  advanceToNext(options: { includeBackground?: boolean } = {}): boolean {
    const target = this.peekNextTime(options);
    if (target === null) return false;
    this.fireUpTo(target);
    return true;
  }

  /** 把时钟推进 ms，沿途所有定时器都会触发 */
  advanceBy(ms: number): void {
    this.advanceTo(this.time + Math.max(0, Math.floor(ms)));
  }

  /** 把时钟推到某个绝对时刻 */
  advanceTo(target: number): void {
    while (true) {
      const next = this.peekNextTime();
      if (next === null || next > target) break;
      this.fireUpTo(next);
    }
    if (target > this.time) this.time = target;
  }

  /**
   * 触发到 target 时刻为止的定时器。
   *
   * 定序是确定性的核心：同一时刻按 (priority, seq)，绝不依赖数组顺序或 Map 迭代。
   * 每轮只取「当前这一刻」的一批，触发过程中新注册的同刻定时器留到下一轮，
   * 免得一个自己重排自己的定时器把循环卡死。
   */
  private fireUpTo(target: number): void {
    this.time = Math.max(this.time, target);

    const due = this.timers
      .filter((timer) => timer.time <= this.time)
      .sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq));

    for (const timer of due) {
      const index = this.timers.indexOf(timer);
      if (index < 0) continue;                    // 被同批里更早的回调清掉了
      if (timer.intervalMs && timer.intervalMs > 0) {
        timer.time = this.time + timer.intervalMs;
        timer.seq = this.seq++;
      } else {
        this.timers.splice(index, 1);
      }
      try {
        timer.fn();
      } catch (error) {
        // 一个回调抛异常不该中断这一刻其余回调的触发，但也不能悄悄吞掉。
        // 记下来交给驱动器变成一次失败。
        if (!this.failure) this.failure = { error, label: timer.label };
      }
    }
  }

  /** 快照只存标量。挂着的定时器**不在**其中 —— 见 kernel.ts 里对快照时机的说明。 */
  snapshot(): { time: number; seq: number; nextId: number } {
    return { time: this.time, seq: this.seq, nextId: this.nextId };
  }

  restore(state: { time: number; seq: number; nextId: number }): void {
    this.time = state.time;
    this.seq = state.seq;
    this.nextId = state.nextId;
    this.timers = [];
    this.failure = null;
  }

  /** 丢掉所有挂着的定时器 */
  clearAll(): void {
    this.timers = [];
    this.failure = null;
  }

  /** 调试用：现在挂着哪些定时器 */
  describePending(limit = 10): string[] {
    return [...this.timers]
      .sort((a, b) => (a.time - b.time) || (a.priority - b.priority) || (a.seq - b.seq))
      .slice(0, limit)
      .map((t) => `${t.label ?? 'timer'}@${t.time}ms${t.background ? ' (background)' : ''}`);
  }
}
