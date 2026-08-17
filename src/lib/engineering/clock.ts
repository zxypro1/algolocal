/**
 * 虚拟时钟
 *
 * 工程实战需要度量「延迟」和「并发度」，但真实等待会让做题体验非常慢，
 * 而且墙钟时间在不同机器上不可复现。这里用一个可被推进的虚拟时钟替代
 * 真实定时器：sleep(200) 只是把任务挂到时间轴上，驱动器在微任务队列
 * 排空后一次性把时钟推到下一个到期时刻。
 *
 * 于是 1000 次「200ms 的网络请求」在真实世界里瞬间跑完，
 * 但虚拟耗时依然精确反映串行/并行的差异。
 */

/** 抓住真实 setTimeout，防止被沙箱内注入的同名函数覆盖 */
const realSetTimeout: typeof setTimeout =
  typeof setTimeout === 'function' ? setTimeout.bind(null) : ((fn: any) => fn()) as any;

interface VirtualTimer {
  id: number;
  time: number;
  seq: number;
  fn: (...args: any[]) => void;
  args: any[];
  /** setInterval 的重复周期 */
  intervalMs?: number;
  cancelled?: boolean;
}

export class VirtualClock {
  private time = 0;
  private seq = 0;
  private nextId = 1;
  private timers: VirtualTimer[] = [];

  now(): number {
    return this.time;
  }

  get pending(): number {
    return this.timers.length;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.schedule(resolve, ms, []);
    });
  }

  schedule(fn: (...args: any[]) => void, ms: number, args: any[] = [], intervalMs?: number): number {
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const timer: VirtualTimer = {
      id: this.nextId++,
      time: this.time + delay,
      seq: this.seq++,
      fn,
      args,
      intervalMs,
    };
    this.timers.push(timer);
    return timer.id;
  }

  clear(id: number): void {
    const index = this.timers.findIndex((timer) => timer.id === id);
    if (index >= 0) {
      this.timers[index].cancelled = true;
      this.timers.splice(index, 1);
    }
  }

  /**
   * 把时钟推进到下一个到期时刻，并触发该时刻的全部回调。
   * @returns 是否真的推进了（没有待触发定时器时返回 false）
   */
  advance(): boolean {
    if (this.timers.length === 0) return false;

    let earliest = this.timers[0];
    for (const timer of this.timers) {
      if (timer.time < earliest.time || (timer.time === earliest.time && timer.seq < earliest.seq)) {
        earliest = timer;
      }
    }

    this.time = Math.max(this.time, earliest.time);

    // 同一时刻到期的定时器按注册顺序触发
    const due = this.timers
      .filter((timer) => timer.time <= this.time)
      .sort((a, b) => a.seq - b.seq);

    for (const timer of due) {
      if (timer.cancelled) continue;
      if (timer.intervalMs && timer.intervalMs > 0) {
        timer.time = this.time + timer.intervalMs;
        timer.seq = this.seq++;
      } else {
        const index = this.timers.indexOf(timer);
        if (index >= 0) this.timers.splice(index, 1);
      }
      try {
        timer.fn(...timer.args);
      } catch (error) {
        // 定时器回调里的异常不应该中断时钟推进，交给外层 promise 捕获
        queueMicrotask(() => {
          throw error;
        });
      }
    }

    return true;
  }
}

export class VirtualClockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VirtualClockTimeoutError';
  }
}

export class VirtualClockDeadlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VirtualClockDeadlockError';
  }
}

/** 让出一个宏任务，等待当前所有微任务链排空 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

export interface DriveOptions {
  /** 真实墙钟上限，防止用户代码写出爆炸性的异步循环 */
  maxWallClockMs?: number;
  /** 虚拟时间上限，超过说明逻辑上永远跑不完 */
  maxVirtualMs?: number;
  /** 连续多少次「无定时器可推进但任务未完成」判定为死锁 */
  maxIdleDrains?: number;
}

/**
 * 在虚拟时钟下驱动一段异步任务直到完成。
 */
export async function driveVirtualClock<T>(
  clock: VirtualClock,
  task: () => Promise<T> | T,
  options: DriveOptions = {}
): Promise<T> {
  const { maxWallClockMs = 10_000, maxVirtualMs = 10 * 60 * 1000, maxIdleDrains = 50 } = options;

  let settled = false;
  let value: T;
  let failure: unknown;
  let failed = false;

  const running = Promise.resolve()
    .then(task)
    .then(
      (result) => {
        value = result;
        settled = true;
      },
      (error) => {
        failure = error;
        failed = true;
        settled = true;
      }
    );

  const startedAt = Date.now();
  let idleDrains = 0;

  while (!settled) {
    await flushMicrotasks();
    if (settled) break;

    if (clock.advance()) {
      idleDrains = 0;
    } else {
      idleDrains += 1;
      if (idleDrains > maxIdleDrains) {
        throw new VirtualClockDeadlockError(
          'No pending timers but the task never settled — a promise is likely never resolved (deadlock).'
        );
      }
    }

    if (clock.now() > maxVirtualMs) {
      throw new VirtualClockTimeoutError(
        `Virtual time exceeded ${maxVirtualMs}ms — the workload never finishes.`
      );
    }
    if (Date.now() - startedAt > maxWallClockMs) {
      throw new VirtualClockTimeoutError(
        `Execution exceeded ${maxWallClockMs}ms of real time — possible runaway loop.`
      );
    }
  }

  await running;
  if (failed) throw failure;
  return value!;
}
