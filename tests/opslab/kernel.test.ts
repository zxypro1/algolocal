/**
 * opslab 确定性内核的回归测试
 *
 * 重点是最后那组：几十个并发实体跑在同一个虚拟时钟上，同样的输入必须得到
 * 逐字节相同的结果。这一条不成立的话，判定、反向验证、进度恢复全都不成立。
 */
import {
  BudgetExceededError,
  ClockLivelockError,
  createKernel,
  createRandom,
  DeadlockError,
  Kernel,
  Priority,
} from '../../src/lib/opslab/kernel';

describe('确定性随机数', () => {
  it('同一个种子给出同一串数', () => {
    const a = createRandom(42);
    const b = createRandom(42);
    const left = Array.from({ length: 20 }, () => a.next());
    const right = Array.from({ length: 20 }, () => b.next());
    expect(left).toEqual(right);
  });

  it('不同种子给出不同的串', () => {
    const a = Array.from({ length: 10 }, createRandom(1).next);
    const b = Array.from({ length: 10 }, createRandom(2).next);
    expect(a).not.toEqual(b);
  });

  it('状态可以存下来再恢复', () => {
    const rng = createRandom(7);
    rng.next();
    rng.next();
    const saved = rng.state();
    const expected = [rng.next(), rng.next(), rng.next()];

    rng.restore(saved);
    expect([rng.next(), rng.next(), rng.next()]).toEqual(expected);
  });

  it('suffix 产出 k8s 风格的后缀', () => {
    const rng = createRandom(3);
    const suffix = rng.suffix(5);
    expect(suffix).toHaveLength(5);
    expect(suffix).toMatch(/^[a-z0-9]+$/);
  });
});

describe('虚拟时钟', () => {
  it('同一时刻按优先级再按注册顺序触发', async () => {
    const kernel = createKernel();
    const order: string[] = [];

    // 故意反着注册：如果定序只看数组顺序，这个用例就会挂
    kernel.setTimeout(() => order.push('user-1'), 100, { priority: Priority.USER });
    kernel.setTimeout(() => order.push('controller-1'), 100, { priority: Priority.CONTROLLER });
    kernel.setTimeout(() => order.push('dispatch-1'), 100, { priority: Priority.DISPATCH });
    kernel.setTimeout(() => order.push('controller-2'), 100, { priority: Priority.CONTROLLER });
    kernel.setTimeout(() => order.push('node-1'), 100, { priority: Priority.NODE });

    await kernel.settle();
    expect(order).toEqual(['dispatch-1', 'node-1', 'controller-1', 'controller-2', 'user-1']);
  });

  it('时间按定时器推进，不消耗真实时间', async () => {
    const kernel = createKernel();
    const wallStart = Date.now();
    kernel.spawn('sleeper', async () => {
      await kernel.sleep(60_000);
      await kernel.sleep(60_000);
    });
    await kernel.settle();
    expect(kernel.now()).toBe(120_000);
    // 两分钟虚拟时间，真实世界里应当是一瞬
    expect(Date.now() - wallStart).toBeLessThan(2000);
  });

  it('后台定时器不会让世界永远静不下来', async () => {
    const kernel = createKernel();
    let resyncs = 0;
    // 控制器的定期重扫：永远有下一次
    kernel.setInterval(() => { resyncs += 1; }, 30_000, {
      background: true,
      label: 'controller-resync',
    });

    let done = false;
    kernel.spawn('work', async () => {
      await kernel.sleep(500);
      done = true;
    });

    await kernel.settle();
    expect(done).toBe(true);
    expect(kernel.now()).toBe(500);
    // settle 不该去触发后台定时器
    expect(resyncs).toBe(0);
  });

  it('快进会触发后台定时器', async () => {
    const kernel = createKernel();
    let resyncs = 0;
    kernel.setInterval(() => { resyncs += 1; }, 30_000, { background: true });

    await kernel.advanceBy(95_000);
    expect(resyncs).toBe(3);
    expect(kernel.now()).toBe(95_000);
  });

  it('清掉的定时器不会再触发', async () => {
    const kernel = createKernel();
    let fired = 0;
    const id = kernel.setTimeout(() => { fired += 1; }, 100);
    kernel.clearTimer(id);
    await kernel.advanceBy(1000);
    expect(fired).toBe(0);
  });
});

describe('异常与预算', () => {
  it('永不 resolve 的 promise 报成死锁而不是挂死', async () => {
    const kernel = createKernel();
    kernel.spawn('stuck', () => new Promise<void>(() => { /* 永远不 resolve */ }));
    await expect(kernel.settle()).rejects.toThrow(DeadlockError);
  });

  it('定时器回调里的异常成为一次失败，不是全局未捕获', async () => {
    const kernel = createKernel();
    kernel.setTimeout(() => { throw new Error('boom from timer'); }, 10);
    await expect(kernel.settle()).rejects.toThrow('boom from timer');
  });

  it('任务里的异常会被抛出来', async () => {
    const kernel = createKernel();
    kernel.spawn('bad', async () => {
      await kernel.sleep(10);
      throw new Error('boom from task');
    });
    await expect(kernel.settle()).rejects.toThrow('boom from task');
  });

  it('在原地不停重排 0 延迟定时器的回调会被判活锁，而不是把线程转死', async () => {
    // 这一条来自自审：虚拟时间与真实时间的预算都在 settle 里，而 advanceTo 是同步的，
    // 没有这道闸的话下面这段会把整个进程转死，一声不吭。
    const kernel = createKernel();
    const tick = () => { kernel.setTimeout(tick, 0); };
    kernel.setTimeout(tick, 0);
    await expect(kernel.advanceBy(10)).rejects.toThrow(ClockLivelockError);
  }, 20_000);

  it('收敛不了的世界撞上虚拟时间预算', async () => {
    const kernel = createKernel();
    kernel.spawn('forever', async () => {
      // 前台定时器上的无限循环：永远有下一步，永远静不下来
      for (;;) await kernel.sleep(1000);
    });
    await expect(kernel.settle({ maxVirtualMs: 60_000 })).rejects.toThrow(BudgetExceededError);
  });
});

describe('快照', () => {
  it('静下来之后可以快照，并且能恢复随机数与时间', async () => {
    const kernel = createKernel({ seed: 99 });
    kernel.spawn('work', async () => { await kernel.sleep(1234); });
    await kernel.settle();
    kernel.random.next();

    const snapshot = kernel.snapshot();
    const expected = [kernel.random.next(), kernel.random.next()];

    const restored = createKernel({ seed: 1 });
    restored.restore(snapshot);
    expect(restored.now()).toBe(1234);
    expect([restored.random.next(), restored.random.next()]).toEqual(expected);
  });

  it('还有前台定时器时拒绝快照', async () => {
    const kernel = createKernel();
    kernel.setTimeout(() => {}, 500, { label: 'pending-work' });
    expect(() => kernel.snapshot()).toThrow(/静下来/);
  });

  it('只有后台定时器时允许快照', async () => {
    const kernel = createKernel();
    kernel.setInterval(() => {}, 30_000, { background: true });
    expect(() => kernel.snapshot()).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 这一组是重点：几十个并发实体，同样的输入必须给出同样的结果            */
/* ------------------------------------------------------------------ */

/**
 * 一个够乱的世界。
 *
 * 40 个实体分三类，互相通过共享状态影响对方，各自按种子随机的间隔醒来，
 * 还会中途派生新任务 —— 尽量把「顺序可能飘」的因素都塞进去。
 */
async function runChaosWorld(seed: number): Promise<string> {
  const kernel = new Kernel({ seed, maxVirtualMs: 10 * 60 * 1000 });
  const log: string[] = [];
  const store = new Map<string, number>();
  const record = (what: string) => log.push(`${kernel.now()}ms ${what}`);

  // 一类：写状态的「控制器」
  for (let i = 0; i < 15; i += 1) {
    const name = `ctrl-${i}`;
    kernel.spawn(name, async () => {
      for (let round = 0; round < 4; round += 1) {
        await kernel.sleep(50 + kernel.random.int(200), { priority: Priority.CONTROLLER });
        const key = `obj-${kernel.random.int(6)}`;
        const value = (store.get(key) ?? 0) + 1;
        store.set(key, value);
        record(`${name} set ${key}=${value}`);
      }
    });
  }

  // 二类：读状态的「kubelet」，并且会派生一次性的子任务
  for (let i = 0; i < 15; i += 1) {
    const name = `node-${i}`;
    kernel.spawn(name, async () => {
      for (let round = 0; round < 3; round += 1) {
        await kernel.sleep(30 + kernel.random.int(150), { priority: Priority.NODE });
        const key = `obj-${kernel.random.int(6)}`;
        record(`${name} saw ${key}=${store.get(key) ?? 0}`);
        if (round === 1) {
          kernel.spawn(`${name}-probe`, async () => {
            await kernel.sleep(10 + kernel.random.int(40), { priority: Priority.NETWORK });
            record(`${name}-probe done`);
          });
        }
      }
    });
  }

  // 三类：后台重扫，不该影响 settle
  for (let i = 0; i < 10; i += 1) {
    kernel.setInterval(() => record(`resync-${i}`), 30_000, { background: true, label: `resync-${i}` });
  }

  await kernel.settle();
  // 再快进一分钟，把后台的也放出来跑
  await kernel.advanceBy(60_000);

  return log.join('\n');
}

describe('并发确定性', () => {
  it('40 个并发实体，同一种子重放 50 次结果逐字节一致', async () => {
    const first = await runChaosWorld(1234);
    // 这个世界得真的复杂，否则测了个寂寞
    expect(first.split('\n').length).toBeGreaterThan(100);

    for (let run = 0; run < 49; run += 1) {
      const again = await runChaosWorld(1234);
      if (again !== first) {
        const a = first.split('\n');
        const b = again.split('\n');
        const at = a.findIndex((line, index) => line !== b[index]);
        throw new Error(`第 ${run + 2} 次重放在第 ${at + 1} 行分叉：\n  期望 ${a[at]}\n  实际 ${b[at]}`);
      }
      expect(again).toBe(first);
    }
  }, 60_000);

  it('换个种子会得到不同的世界（否则说明随机数根本没参与）', async () => {
    const a = await runChaosWorld(1234);
    const b = await runChaosWorld(5678);
    expect(a).not.toBe(b);
  }, 30_000);

  it('后台重扫在 settle 阶段不出现，快进之后才出现', async () => {
    const transcript = await runChaosWorld(1234);
    const lines = transcript.split('\n');
    const firstResync = lines.findIndex((l) => l.includes('resync-'));
    const lastWork = lines.map((l) => !l.includes('resync-')).lastIndexOf(true);
    expect(firstResync).toBeGreaterThan(-1);
    // 所有真活儿都排在第一次后台重扫之前
    expect(lastWork).toBeLessThan(firstResync);
  }, 30_000);
});
