/**
 * etcd 语义存储的回归测试
 *
 * 这一层的每条语义都会被 apiserver 直接拿去用：
 * revision 就是 resourceVersion，CAS 就是乐观并发（409），
 * watch-from-revision 就是 informer 的「先 list 再 watch 不漏事件」，
 * compaction 就是 `too old resource version`。所以这里挨条钉死。
 */
import {
  CompactedError,
  createStore,
  FutureRevisionError,
  Store,
  WatchEvent,
} from '../../src/lib/opslab/store';

const K = (name: string, ns = 'default') => `/registry/pods/${ns}/${name}`;

describe('revision 语义', () => {
  it('每次写让 revision 单调 +1', () => {
    const store = createStore();
    expect(store.revision).toBe(0);
    store.put(K('a'), { x: 1 });
    expect(store.revision).toBe(1);
    store.put(K('b'), { x: 2 });
    expect(store.revision).toBe(2);
    store.put(K('a'), { x: 3 });
    expect(store.revision).toBe(3);
  });

  it('createRevision 不变、modRevision 跟着改、version 累加', () => {
    const store = createStore();
    const first = store.put(K('a'), { x: 1 });
    expect(first).toMatchObject({ createRevision: 1, modRevision: 1, version: 1 });

    store.put(K('other'), {});
    const second = store.put(K('a'), { x: 2 });
    expect(second).toMatchObject({ createRevision: 1, modRevision: 3, version: 2 });
  });

  it('删掉再建，createRevision 重新算', () => {
    const store = createStore();
    store.put(K('a'), { x: 1 });
    store.delete(K('a'));
    const again = store.put(K('a'), { x: 2 });
    expect(again).toMatchObject({ createRevision: 3, modRevision: 3, version: 1 });
  });
});

describe('读', () => {
  it('前缀读按键名排序，不看插入顺序', () => {
    const store = createStore();
    // 故意乱序写入
    store.put(K('zeta'), {});
    store.put(K('alpha'), {});
    store.put(K('mid'), {});
    const result = store.range('/registry/pods/', { prefix: true });
    expect(result.kvs.map((kv) => kv.key)).toEqual([K('alpha'), K('mid'), K('zeta')]);
  });

  it('分页：limit 截断并给出 more 与总数', () => {
    const store = createStore();
    for (const name of ['a', 'b', 'c', 'd', 'e']) store.put(K(name), {});

    const page1 = store.range('/registry/pods/', { prefix: true, limit: 2 });
    expect(page1.kvs.map((kv) => kv.key)).toEqual([K('a'), K('b')]);
    expect(page1.more).toBe(true);
    expect(page1.count).toBe(5);

    const page2 = store.range('/registry/pods/', { prefix: true, limit: 2, startAfter: K('b') });
    expect(page2.kvs.map((kv) => kv.key)).toEqual([K('c'), K('d')]);

    const page3 = store.range('/registry/pods/', { prefix: true, limit: 2, startAfter: K('d') });
    expect(page3.kvs.map((kv) => kv.key)).toEqual([K('e')]);
    expect(page3.more).toBe(false);
  });

  it('读历史版本看到的是那一刻的世界', () => {
    const store = createStore();
    store.put(K('a'), { v: 1 });          // rev 1
    store.put(K('b'), { v: 1 });          // rev 2
    store.put(K('a'), { v: 2 });          // rev 3
    store.delete(K('b'));                 // rev 4

    const atTwo = store.range('/registry/pods/', { prefix: true, revision: 2 });
    expect(atTwo.kvs.map((kv) => kv.key)).toEqual([K('a'), K('b')]);
    expect(atTwo.kvs[0].value).toEqual({ v: 1 });

    const now = store.range('/registry/pods/', { prefix: true });
    expect(now.kvs.map((kv) => kv.key)).toEqual([K('a')]);
    expect(now.kvs[0].value).toEqual({ v: 2 });
  });

  it('读未来的 revision 直接报错', () => {
    const store = createStore();
    store.put(K('a'), {});
    expect(() => store.range(K('a'), { revision: 99 })).toThrow(FutureRevisionError);
  });

  it('读出来的是拷贝，改它不会污染库里的对象', () => {
    const store = createStore();
    store.put(K('a'), { nested: { n: 1 } });
    const read = store.get(K('a')) as any;
    read.value.nested.n = 999;
    expect((store.get(K('a')) as any).value.nested.n).toBe(1);
  });

  it('写进去的也是拷贝，之后改原对象不影响库里的', () => {
    const store = createStore();
    const original = { nested: { n: 1 } };
    store.put(K('a'), original);
    original.nested.n = 999;
    expect((store.get(K('a')) as any).value.nested.n).toBe(1);
  });
});

describe('事务与乐观并发', () => {
  it('modRevision 对得上就写成功', () => {
    const store = createStore();
    const kv = store.put(K('a'), { v: 1 });
    const result = store.txn(
      [{ key: K('a'), target: 'MOD_REVISION', op: '=', value: kv.modRevision }],
      [{ type: 'put', key: K('a'), value: { v: 2 } }]
    );
    expect(result.succeeded).toBe(true);
    expect((store.get(K('a')) as any).value).toEqual({ v: 2 });
  });

  it('中间被别人改过就失败 —— apiserver 的 409 靠这个', () => {
    const store = createStore();
    const kv = store.put(K('a'), { v: 1 });
    store.put(K('a'), { v: 'someone else' });          // 并发写

    const result = store.txn(
      [{ key: K('a'), target: 'MOD_REVISION', op: '=', value: kv.modRevision }],
      [{ type: 'put', key: K('a'), value: { v: 2 } }]
    );
    expect(result.succeeded).toBe(false);
    expect((store.get(K('a')) as any).value).toEqual({ v: 'someone else' });
  });

  it('EXISTS 比较可以实现「只在不存在时创建」', () => {
    const store = createStore();
    const create = () =>
      store.txn(
        [{ key: K('a'), target: 'EXISTS', value: false }],
        [{ type: 'put', key: K('a'), value: { v: 1 } }]
      );
    expect(create().succeeded).toBe(true);
    expect(create().succeeded).toBe(false);            // 第二次是 AlreadyExists
  });

  it('一个事务里的多次写共用一个 revision', () => {
    const store = createStore();
    const result = store.txn(
      [],
      [
        { type: 'put', key: K('a'), value: {} },
        { type: 'put', key: K('b'), value: {} },
        { type: 'put', key: K('c'), value: {} },
      ]
    );
    expect(store.revision).toBe(1);
    const kvs = (result.results as any[]).map((r) => r.modRevision);
    expect(kvs).toEqual([1, 1, 1]);
  });

  it('比较不成立时走 onFailure 那一支', () => {
    const store = createStore();
    const result = store.txn(
      [{ key: K('missing'), target: 'EXISTS', value: true }],
      [{ type: 'put', key: K('yes'), value: {} }],
      [{ type: 'put', key: K('no'), value: {} }]
    );
    expect(result.succeeded).toBe(false);
    expect(store.get(K('yes'))).toBeUndefined();
    expect(store.get(K('no'))).toBeDefined();
  });
});

describe('watch', () => {
  const collect = (store: Store, key: string, opts = {}) => {
    const seen: string[] = [];
    const watcher = store.watch(key, { prefix: true, ...opts }, (e: WatchEvent) => {
      seen.push(`${e.type} ${e.kv.key}@${e.kv.modRevision}`);
    });
    return { seen, watcher };
  };

  it('收到之后发生的 PUT 与 DELETE', () => {
    const store = createStore();
    const { seen } = collect(store, '/registry/pods/');
    store.put(K('a'), {});
    store.delete(K('a'));
    expect(seen).toEqual([`PUT ${K('a')}@1`, `DELETE ${K('a')}@2`]);
  });

  it('DELETE 事件带上 prevKv，控制器才知道删的是什么', () => {
    const store = createStore();
    store.put(K('a'), { important: true });
    let deleted: WatchEvent | null = null;
    store.watch('/registry/pods/', { prefix: true }, (e) => { if (e.type === 'DELETE') deleted = e; });
    store.delete(K('a'));
    expect((deleted as any).prevKv.value).toEqual({ important: true });
  });

  it('只收自己前缀下的事件', () => {
    const store = createStore();
    const { seen } = collect(store, '/registry/pods/kube-system/');
    store.put(K('mine', 'kube-system'), {});
    store.put(K('theirs', 'default'), {});
    expect(seen).toEqual([`PUT ${K('mine', 'kube-system')}@1`]);
  });

  it('从历史 revision 起 watch 会先补齐错过的事件', () => {
    const store = createStore();
    store.put(K('a'), {});                       // rev 1
    store.put(K('b'), {});                       // rev 2
    const listRevision = store.revision;         // informer 在这里完成了 list
    store.put(K('c'), {});                       // rev 3，watch 建立之前发生

    const { seen } = collect(store, '/registry/pods/', { startRevision: listRevision });
    // 补齐的那条要在，之前的不该重放
    expect(seen).toEqual([`PUT ${K('c')}@3`]);

    store.put(K('d'), {});
    expect(seen).toEqual([`PUT ${K('c')}@3`, `PUT ${K('d')}@4`]);
  });

  it('取消之后不再收事件', () => {
    const store = createStore();
    const { seen, watcher } = collect(store, '/registry/pods/');
    store.put(K('a'), {});
    watcher.cancel();
    store.put(K('b'), {});
    expect(seen).toEqual([`PUT ${K('a')}@1`]);
  });

  it('多个订阅者按注册顺序收到通知', () => {
    const store = createStore();
    const order: string[] = [];
    store.watch('/registry/', { prefix: true }, () => order.push('first'));
    store.watch('/registry/', { prefix: true }, () => order.push('second'));
    store.watch('/registry/', { prefix: true }, () => order.push('third'));
    store.put(K('a'), {});
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('在回调里新建的订阅者不会收到这一批事件', () => {
    const store = createStore();
    const late: string[] = [];
    store.watch('/registry/', { prefix: true }, () => {
      store.watch('/registry/', { prefix: true }, () => late.push('late'));
    });
    store.put(K('a'), {});
    expect(late).toEqual([]);
    store.put(K('b'), {});
    expect(late.length).toBeGreaterThan(0);
  });
});

describe('compaction', () => {
  it('压缩之后从更早的 revision 起 watch 会明确报错', () => {
    const store = createStore();
    store.put(K('a'), {});          // 1
    store.put(K('b'), {});          // 2
    store.put(K('c'), {});          // 3
    store.compact(2);

    expect(() => store.watch('/registry/', { prefix: true, startRevision: 1 }, () => {}))
      .toThrow(CompactedError);
    // 压缩点本身还能用
    expect(() => store.watch('/registry/', { prefix: true, startRevision: 2 }, () => {}))
      .not.toThrow();
  });

  it('压缩之后读历史版本仍然完整 —— 压缩点之前建的对象不能凭空消失', () => {
    // 自审时抓到的：历史读原先是从空状态重放全部历史，压缩把前面的事件丢掉之后，
    // 「压缩点之前创建、之后没再动过」的对象就读不出来了。
    const store = createStore();
    store.put(K('a'), { v: 1 });   // rev 1
    store.put(K('b'), { v: 1 });   // rev 2
    store.put(K('c'), { v: 1 });   // rev 3
    store.compact(2);

    const at3 = store.range('/registry/pods/', { prefix: true, revision: 3 });
    expect(at3.kvs.map((kv) => kv.key)).toEqual([K('a'), K('b'), K('c')]);

    const at2 = store.range('/registry/pods/', { prefix: true, revision: 2 });
    expect(at2.kvs.map((kv) => kv.key)).toEqual([K('a'), K('b')]);
  });

  it('历史超过上限会自动压缩，不会无限吃内存', () => {
    const store = createStore({ maxHistory: 10 });
    for (let i = 0; i < 100; i += 1) store.put(K(`n${i}`), { i });
    expect(store.compactedAt).toBeGreaterThan(0);
    expect(() => store.range(K('n0'), { revision: 1 })).toThrow(CompactedError);
    // 当前状态不受影响
    expect(store.range('/registry/pods/', { prefix: true }).count).toBe(100);
  });
});

describe('快照', () => {
  it('存下来再恢复，状态与 revision 都对得上', () => {
    const store = createStore();
    store.put(K('a'), { v: 1 });
    store.put(K('b'), { v: 2 });
    const snapshot = store.snapshot();

    const restored = createStore();
    restored.restore(snapshot);
    expect(restored.revision).toBe(store.revision);
    expect(restored.range('/registry/pods/', { prefix: true }).kvs.map((kv) => kv.key))
      .toEqual([K('a'), K('b')]);
    // 接着写要从恢复的 revision 继续，不能倒退
    expect(restored.put(K('c'), {}).modRevision).toBe(3);
  });

  it('恢复之后从旧 revision 起 watch 会报 compacted —— 历史没有跟着快照走', () => {
    const store = createStore();
    store.put(K('a'), {});
    store.put(K('b'), {});
    const restored = createStore();
    restored.restore(store.snapshot());
    expect(() => restored.watch('/registry/', { prefix: true, startRevision: 1 }, () => {}))
      .toThrow(CompactedError);
  });

  it('恢复之后读当前 revision 能读到东西 —— 底座就是快照本身', () => {
    // 同一个自审发现的另一面：快照里没有历史，恢复后重放不出任何东西，
    // 「读当前 revision」会返回空。
    const store = createStore();
    store.put(K('a'), {});
    store.put(K('b'), {});
    const restored = createStore();
    restored.restore(store.snapshot());

    const now = restored.range('/registry/pods/', { prefix: true, revision: restored.revision });
    expect(now.kvs.map((kv) => kv.key)).toEqual([K('a'), K('b')]);
  });

  it('快照是深拷贝，之后改原库不影响它', () => {
    const store = createStore();
    store.put(K('a'), { nested: { n: 1 } });
    const snapshot = store.snapshot();
    store.put(K('a'), { nested: { n: 2 } });

    const restored = createStore();
    restored.restore(snapshot);
    expect((restored.get(K('a')) as any).value.nested.n).toBe(1);
  });
});

describe('确定性', () => {
  it('同一串操作重放 200 次，事件流逐字节一致', () => {
    const run = () => {
      const store = createStore();
      const log: string[] = [];
      store.watch('/registry/', { prefix: true }, (e) => {
        log.push(`${e.type} ${e.kv.key} rev=${e.kv.modRevision} v=${JSON.stringify(e.kv.value)}`);
      });
      // 故意乱序、混着事务与前缀删除
      for (const name of ['delta', 'alpha', 'charlie', 'bravo']) store.put(K(name), { name });
      store.txn(
        [{ key: K('alpha'), target: 'EXISTS', value: true }],
        [
          { type: 'put', key: K('alpha'), value: { name: 'alpha', updated: true } },
          { type: 'delete', key: K('bravo') },
        ]
      );
      store.deletePrefix('/registry/pods/default/c');
      log.push(JSON.stringify(store.range('/registry/pods/', { prefix: true }).kvs.map((kv) => kv.key)));
      return log.join('\n');
    };

    const first = run();
    for (let i = 0; i < 199; i += 1) expect(run()).toBe(first);
  });
});
