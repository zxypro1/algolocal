/**
 * 工程实战 · 从零实现一个最小数据库
 *
 * 注意：代码片段使用 String.raw 模板，不要在片段里写 `${}`。
 */
const { t, code, file, readonlyFile, spec, gate } = require('./_helpers');

/* ------------------------------------------------------------------ */
/* 平台提供的基础设施                                                   */
/* ------------------------------------------------------------------ */

const contract = readonlyFile(
  'src/contract.ts',
  code`
    /** 平台提供的契约（只读） */

    /** 一行数据。定长 schema，省掉「解析 schema」这层与本题无关的工作。 */
    export interface Row {
      id: number;
      name: string;
      /** 0 或 1 */
      active: number;
    }

    /** 缓冲池的运行统计，用来证明缓存真的生效了 */
    export interface PagerStats {
      /** 命中缓存的次数 */
      hits: number;
      /** 未命中、必须读盘的次数 */
      misses: number;
      /** 因容量不足被淘汰的页数 */
      evictions: number;
      /** 当前缓存中被改过、尚未写回的页数 */
      dirty: number;
    }

    export interface Pager {
      readPage(pageId: number): Promise<Uint8Array>;
      writePage(pageId: number, data: Uint8Array): Promise<void>;
      allocatePage(): Promise<number>;
      /** 把所有脏页写回磁盘并 fsync 一次 */
      flush(): Promise<void>;
      stats(): PagerStats;
    }

    /** 一条记录在页内的位置 */
    export interface Slot {
      pageId: number;
      slotId: number;
    }

    /** WAL 里的一条日志 */
    export interface LogRecord {
      /** 事务号 */
      txId: number;
      type: 'begin' | 'write' | 'commit';
      /** type 为 write 时才有 */
      pageId?: number;
      /** type 为 write 时才有，页的新内容 */
      after?: number[];
    }
  `
);

const disk = readonlyFile(
  'src/disk.ts',
  code`
    /**
     * 模拟块设备（只读，平台提供）
     *
     * 它刻意做得像真的磁盘，因为这道题的每一关都在和它的特性较劲：
     *
     * - 读写以「页」为单位，不能读半页；
     * - 写入先落在操作系统的页缓存里，**只有 fsync 之后才真正持久**；
     * - crash() 会丢掉所有没 fsync 的写入——崩溃恢复那一关全靠它；
     * - 每次读、写、fsync 都会计数并推进虚拟时钟，所以「少读一次盘」是能被量出来的。
     */
    import { sleep } from '@lab/env';
    import { count } from '@lab/metrics';

    /** 页大小。真实数据库通常是 4KB/8KB，这里取小值方便手算。 */
    export const PAGE_SIZE = 128;

    const READ_MS = 1;
    const WRITE_MS = 1;
    const FSYNC_MS = 5;

    export class Disk {
      private durable = new Map<number, Uint8Array>();
      private pending = new Map<number, Uint8Array>();
      private durableLog: Uint8Array[] = [];
      private pendingLog: Uint8Array[] = [];
      private nextPageId = 0;

      async readPage(pageId: number): Promise<Uint8Array> {
        count('diskReads');
        await sleep(READ_MS);
        const bytes = this.pending.get(pageId) || this.durable.get(pageId);
        if (!bytes) throw new Error('page ' + pageId + ' has not been allocated');
        return bytes.slice();
      }

      async writePage(pageId: number, data: Uint8Array): Promise<void> {
        if (data.length !== PAGE_SIZE) {
          throw new Error('a page must be exactly ' + PAGE_SIZE + ' bytes, got ' + data.length);
        }
        count('diskWrites');
        await sleep(WRITE_MS);
        this.pending.set(pageId, data.slice());
      }

      /** 分配一个新页，内容全零 */
      async allocatePage(): Promise<number> {
        const pageId = this.nextPageId;
        this.nextPageId += 1;
        await this.writePage(pageId, new Uint8Array(PAGE_SIZE));
        return pageId;
      }

      pageCount(): number {
        return this.nextPageId;
      }

      /** 把页缓存和日志缓存一起刷到「盘上」 */
      async fsync(): Promise<void> {
        count('diskFsync');
        await sleep(FSYNC_MS);
        for (const entry of Array.from(this.pending.entries())) {
          this.durable.set(entry[0], entry[1]);
        }
        this.pending.clear();
        for (const record of this.pendingLog) this.durableLog.push(record);
        this.pendingLog = [];
      }

      /** 追加一条 WAL 记录（同样要 fsync 才持久） */
      appendLog(bytes: Uint8Array): void {
        count('diskLogAppends');
        this.pendingLog.push(bytes.slice());
      }

      /** 读取已持久化的日志 */
      readLog(): Uint8Array[] {
        return this.durableLog.map((record) => record.slice());
      }

      /** 检查点之后清空日志 */
      truncateLog(): void {
        this.durableLog = [];
        this.pendingLog = [];
      }

      /**
       * 模拟掉电：没 fsync 的东西全部消失。
       * nextPageId 保留，因为真实系统重启后会从元数据里读回它。
       */
      crash(): void {
        this.pending.clear();
        this.pendingLog = [];
      }
    }
  `
);

/* ------------------------------------------------------------------ */
/* 第 1 关 · 页与缓冲池                                                 */
/* ------------------------------------------------------------------ */

const stage1 = {
  id: 'pager',
  title: t('第 1 关 · 页与缓冲池', 'Stage 1 · Pages and the buffer pool'),
  goal: t(
    [
      '数据库不按「行」读盘，按**页**读盘。一页 128 字节，读一次 1ms，fsync 一次 5ms。',
      '这个代价决定了上层所有设计：能少读一页就少读一页。',
      '',
      '在 `src/pager.ts` 实现 `createPager(disk, options)`，给磁盘加一层带 LRU 淘汰的缓冲池：',
      '',
      '- `readPage(id)`：命中缓存直接返回，未命中才读盘；',
      '- `writePage(id, data)`：**只写缓存并标记为脏**，不立刻落盘；',
      '- `allocatePage()`：向磁盘要一个新页；',
      '- `flush()`：把所有脏页写回，然后 fsync 一次（注意是一次，不是每页一次）；',
      '- `stats()`：返回 hits / misses / evictions / dirty。',
      '',
      '缓存装不下时淘汰**最久未使用**的那一页。淘汰脏页必须先写回，',
      '否则用户明明写过的数据会凭空消失——这是缓冲池最容易写错的地方。',
    ].join('\n'),
    [
      'A database does not read rows from disk, it reads pages. A page is 128 bytes; a read costs 1ms,',
      'an fsync costs 5ms. That cost shapes every layer above: read one page fewer whenever you can.',
      '',
      'Implement `createPager(disk, options)` in `src/pager.ts`, a buffer pool with LRU eviction:',
      '',
      '- `readPage(id)`: serve from cache on a hit, only touch the disk on a miss;',
      '- `writePage(id, data)`: write to the cache and mark it dirty, do not go to disk;',
      '- `allocatePage()`: ask the disk for a fresh page;',
      '- `flush()`: write every dirty page back, then fsync once (once, not once per page);',
      '- `stats()`: hits / misses / evictions / dirty.',
      '',
      'When the pool is full, evict the least recently used page. A dirty page must be written back',
      'before it is evicted, otherwise data the user definitely wrote silently disappears — the single',
      'most common bug in a buffer pool.',
    ].join('\n')
  ),
  checklist: [
    t('同一页读第二次不再碰磁盘', 'A second read of the same page does not touch the disk'),
    t('writePage 不立刻落盘，flush 才落盘', 'writePage does not hit the disk; flush does'),
    t('容量满时淘汰最久未使用的页', 'A full pool evicts the least recently used page'),
    t('淘汰脏页时先写回，数据不丢', 'Evicting a dirty page writes it back first'),
    t('flush 只 fsync 一次', 'flush issues exactly one fsync'),
  ],
  pitfalls: [
    t(
      '把淘汰写成「淘汰最先放进来的」（FIFO）。它在顺序扫描时看起来没问题，一旦出现热点页就会把刚用过的页扔掉——LRU 要在**每次访问**时更新顺序，不只是在插入时。',
      'Implementing eviction as "evict the oldest inserted" (FIFO). It looks fine on a sequential scan, but with a hot page it throws away the page you just used. LRU must reorder on every access, not only on insert.'
    ),
    t(
      '淘汰脏页时忘记写回。测试里写完马上读通常还在缓存里，看不出问题；只有当缓存被撑满、那一页恰好被挤掉时数据才丢，于是它变成一个「压力大了才复现」的 bug。',
      'Forgetting to write back a dirty page on eviction. Writing then reading usually still hits the cache, so nothing looks wrong; the loss only shows up once the pool overflows and that page happens to be evicted — a bug that only reproduces under load.'
    ),
    t(
      '把缓存里的 Uint8Array 直接交给调用方。调用方改一个字节，缓存内容就跟着变了，而这一页并没有被标记为脏——写回时又把它当干净页跳过。读的时候返回副本。',
      'Handing the cached Uint8Array straight to the caller. The caller mutates one byte and the cache changes with it, but the page was never marked dirty, so write-back skips it as clean. Return a copy.'
    ),
    t(
      '在 flush 里每写一页就 fsync 一次。结果全对，但 10 个脏页要 50ms 而不是 5ms——fsync 是这一层最贵的操作，应该攒够了一次做完。',
      'Calling fsync after every page inside flush. Correct, but ten dirty pages cost 50ms instead of 5ms. fsync is the most expensive operation at this layer; batch it into one call.'
    ),
  ],
  hints: [
    t(
      'JavaScript 的 Map 本身就按插入顺序迭代。命中时先 delete 再 set，就把这一页挪到了「最新」的一端，`map.keys().next().value` 就是最久未使用的那个。',
      "JavaScript's Map iterates in insertion order. On a hit, delete then set to move the entry to the newest end, and `map.keys().next().value` is the least recently used key."
    ),
    t(
      'flush 的顺序是：先把所有脏页 writePage 回磁盘，全部写完之后再 fsync 一次。',
      'The order inside flush: write every dirty page back first, then issue a single fsync at the end.'
    ),
  ],
  extension: t(
    [
      '真实数据库的缓冲池比这一关多两件事：',
      '',
      '1. **pin / unpin**。上层正在读某一页时，它不能被淘汰。PostgreSQL 的 buffer pin 和',
      'InnoDB 的 buffer fix count 都是干这个的。这一关是单线程的，所以省掉了。',
      '',
      '2. **淘汰策略不是纯 LRU**。纯 LRU 有个著名弱点：一次全表扫描会把整个缓冲池冲干净',
      '（sequential flooding）。PostgreSQL 用 clock sweep，MySQL 把 LRU 链表切成 young/old 两段，',
      '新读进来的页先进 old 区，被再次访问才升到 young 区——扫描进来的页因此不会挤掉热点数据。',
      '',
      '至于「写缓存里、fsync 才持久」，这不是模拟出来的特性，而是真实文件系统的行为。',
      '2018 年 PostgreSQL 社区发现 Linux 上 fsync 失败后会把脏页标记清掉，',
      '重试 fsync 会返回成功但数据其实没写下去，史称 fsyncgate。',
    ].join('\n'),
    [
      'A real buffer pool does two more things than this stage:',
      '',
      '1. Pin and unpin. A page being read by an upper layer must not be evicted. That is what',
      "PostgreSQL's buffer pins and InnoDB's buffer fix count are for. This stage is single-threaded,",
      'so it is left out.',
      '',
      '2. Eviction is rarely pure LRU. Pure LRU has a well-known weakness: one full table scan wipes',
      'the whole pool (sequential flooding). PostgreSQL uses a clock sweep; MySQL splits the LRU list',
      'into young and old sublists so a freshly read page enters the old end and is only promoted when',
      'touched again, which stops a scan from evicting hot data.',
      '',
      'The "buffered until fsync" behaviour is not a simulation, it is what real filesystems do. In 2018',
      'the PostgreSQL community found that on Linux a failed fsync clears the dirty flags, so retrying',
      'fsync reports success while the data was never written — since known as fsyncgate.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'encapsulation'],
  lab: {},
  starterFiles: [
    contract,
    disk,
    file(
      'src/pager.ts',
      code`
        import type { Pager, PagerStats } from './contract';
        import { Disk } from './disk';

        export interface PagerOptions {
          /** 缓冲池最多缓存多少页 */
          capacity: number;
        }

        export function createPager(disk: Disk, options: PagerOptions): Pager {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-1.spec.ts',
      code`
        import { createPager } from '../src/pager';
        import { Disk, PAGE_SIZE } from '../src/disk';
        import { getCounters } from '@lab/metrics';

        function bytes(fill: number): Uint8Array {
          const page = new Uint8Array(PAGE_SIZE);
          page.fill(fill);
          return page;
        }

        describe('阶段1 · 页与缓冲池', () => {
          it('读回来的就是写进去的', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 4 });
            const pageId = await pager.allocatePage();

            await pager.writePage(pageId, bytes(7));
            const read = await pager.readPage(pageId);

            expect(Array.from(read)).toEqual(Array.from(bytes(7)));
          });

          it('同一页读第二次命中缓存 [gate:cache]', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 4 });
            const pageId = await pager.allocatePage();
            await pager.writePage(pageId, bytes(1));
            await pager.flush();

            for (let index = 0; index < 20; index += 1) {
              await pager.readPage(pageId);
            }

            const stats = pager.stats();
            expect(stats.hits).toBeGreaterThanOrEqual(19);
            expect(stats.misses).toBeLessThanOrEqual(1);
          });

          it('writePage 不立刻落盘', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 4 });
            const pageId = await pager.allocatePage();

            const before = getCounters()['diskWrites'] || 0;
            await pager.writePage(pageId, bytes(3));
            const after = getCounters()['diskWrites'] || 0;

            expect(after).toBe(before);
            expect(pager.stats().dirty).toBe(1);
          });

          it('flush 把脏页写回并且只 fsync 一次', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 8 });
            const ids: number[] = [];
            for (let index = 0; index < 5; index += 1) {
              ids.push(await pager.allocatePage());
            }
            for (let index = 0; index < 5; index += 1) {
              await pager.writePage(ids[index], bytes(index + 1));
            }

            const beforeSync = getCounters()['diskFsync'] || 0;
            await pager.flush();
            const afterSync = getCounters()['diskFsync'] || 0;

            expect(afterSync - beforeSync).toBe(1);
            expect(pager.stats().dirty).toBe(0);

            // 绕过缓冲池直接问磁盘，确认真的写下去了
            const raw = await disk.readPage(ids[2]);
            expect(Array.from(raw)).toEqual(Array.from(bytes(3)));
          });

          it('容量满时淘汰最久未使用的页', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 2 });
            const a = await pager.allocatePage();
            const b = await pager.allocatePage();
            const c = await pager.allocatePage();
            await pager.flush();

            await pager.readPage(a);
            await pager.readPage(b);
            // 再碰一下 a，让 b 成为最久未使用的那个
            await pager.readPage(a);
            await pager.readPage(c);

            expect(pager.stats().evictions).toBeGreaterThanOrEqual(1);

            const beforeHits = pager.stats().hits;
            await pager.readPage(a);
            expect(pager.stats().hits).toBe(beforeHits + 1);
          });

          it('被淘汰的脏页先写回，数据不丢', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 1 });
            const a = await pager.allocatePage();
            const b = await pager.allocatePage();

            await pager.writePage(a, bytes(9));
            // 容量只有 1，读 b 一定会把 a 挤出去
            await pager.readPage(b);
            await pager.flush();

            const raw = await disk.readPage(a);
            expect(Array.from(raw)).toEqual(Array.from(bytes(9)));
          });

          it('淘汰干净页不产生写盘', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 1 });
            const a = await pager.allocatePage();
            const b = await pager.allocatePage();
            await pager.flush();

            await pager.readPage(a);
            const before = getCounters()['diskWrites'] || 0;
            await pager.readPage(b);
            const after = getCounters()['diskWrites'] || 0;

            expect(after).toBe(before);
          });

          it('缓存不会超过容量', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 3 });
            const ids: number[] = [];
            for (let index = 0; index < 6; index += 1) {
              ids.push(await pager.allocatePage());
            }
            await pager.flush();

            for (const pageId of ids) {
              await pager.readPage(pageId);
            }

            expect(pager.stats().evictions).toBeGreaterThanOrEqual(3);
          });

          it('返回的是副本，调用方改不坏缓存', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 4 });
            const pageId = await pager.allocatePage();
            await pager.writePage(pageId, bytes(4));

            const first = await pager.readPage(pageId);
            first[0] = 99;
            const second = await pager.readPage(pageId);

            expect(second[0]).toBe(4);
          });

          it('重新读回被淘汰的页拿到的是最后写入的内容', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 1 });
            const a = await pager.allocatePage();
            const b = await pager.allocatePage();

            await pager.writePage(a, bytes(11));
            await pager.readPage(b);
            const back = await pager.readPage(a);

            expect(Array.from(back)).toEqual(Array.from(bytes(11)));
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.diskReads',
      op: 'lte',
      value: 2,
      zh: '同一页读 20 次最多读盘 2 次',
      en: 'Twenty reads of one page cost at most two disk reads',
      dimension: 'latency',
      scope: 'gate:cache',
    }),
  ],
  referenceFiles: [
    file(
      'src/pager.ts',
      code`
        import type { Pager, PagerStats } from './contract';
        import { Disk } from './disk';

        export interface PagerOptions {
          capacity: number;
        }

        interface Frame {
          data: Uint8Array;
          dirty: boolean;
        }

        export function createPager(disk: Disk, options: PagerOptions): Pager {
          const capacity = Math.max(1, options.capacity);

          // Map 按插入顺序迭代，命中时 delete + set 把这一页挪到最新端，
          // 于是第一个 key 永远是最久未使用的那一页。
          const frames = new Map<number, Frame>();
          const stats: PagerStats = { hits: 0, misses: 0, evictions: 0, dirty: 0 };

          function touch(pageId: number, frame: Frame): void {
            frames.delete(pageId);
            frames.set(pageId, frame);
          }

          function countDirty(): number {
            let dirty = 0;
            for (const frame of Array.from(frames.values())) {
              if (frame.dirty) dirty += 1;
            }
            return dirty;
          }

          async function evictIfNeeded(): Promise<void> {
            while (frames.size > capacity) {
              const oldest = frames.keys().next();
              if (oldest.done) return;
              const pageId = oldest.value as number;
              const frame = frames.get(pageId) as Frame;
              frames.delete(pageId);
              // 脏页必须先写回，否则用户写过的数据会随着淘汰一起消失
              if (frame.dirty) await disk.writePage(pageId, frame.data);
              stats.evictions += 1;
            }
          }

          async function load(pageId: number): Promise<Frame> {
            const cached = frames.get(pageId);
            if (cached) {
              stats.hits += 1;
              touch(pageId, cached);
              return cached;
            }

            stats.misses += 1;
            const data = await disk.readPage(pageId);
            const frame: Frame = { data, dirty: false };
            frames.set(pageId, frame);
            await evictIfNeeded();
            return frame;
          }

          return {
            async readPage(pageId: number): Promise<Uint8Array> {
              const frame = await load(pageId);
              // 交出副本：调用方改坏了返回值也不会污染缓存
              return frame.data.slice();
            },

            async writePage(pageId: number, data: Uint8Array): Promise<void> {
              const existing = frames.get(pageId);
              if (existing) {
                existing.data = data.slice();
                existing.dirty = true;
                touch(pageId, existing);
              } else {
                frames.set(pageId, { data: data.slice(), dirty: true });
                await evictIfNeeded();
              }
              stats.dirty = countDirty();
            },

            async allocatePage(): Promise<number> {
              const pageId = await disk.allocatePage();
              frames.set(pageId, { data: new Uint8Array(0), dirty: false });
              frames.delete(pageId);
              return pageId;
            },

            async flush(): Promise<void> {
              for (const entry of Array.from(frames.entries())) {
                const frame = entry[1];
                if (!frame.dirty) continue;
                await disk.writePage(entry[0], frame.data);
                frame.dirty = false;
              }
              // 攒够了一次 fsync：它是这一层最贵的操作
              await disk.fsync();
              stats.dirty = 0;
            },

            stats(): PagerStats {
              return { ...stats, dirty: countDirty() };
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**LRU 用 Map 的插入顺序实现。** 不需要手写双向链表：`delete` 再 `set` 就把一页挪到最新端，',
      '`frames.keys().next().value` 就是最久未使用的那一个。代价是 delete+set 比链表指针操作慢，',
      '但在缓冲池这个量级上无所谓，而可读性差得很远。',
      '',
      '**读返回副本，写接受副本。** `frame.data.slice()` 看起来是多余的拷贝，但少了它，',
      '调用方持有的就是缓存内部的那块内存。改一个字节，缓存跟着变，而这一页没有被标记为脏，',
      'flush 会把它当干净页跳过——数据在内存里是对的，落盘之后是错的。',
      '',
      '**flush 里 fsync 只做一次。** 写回和持久化是两件事：writePage 只是把数据交给操作系统，',
      'fsync 才真正落盘。把 fsync 放进循环，结果一样对，但 10 个脏页要 50ms 而不是 5ms。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'LRU rides on Map insertion order. No hand-written doubly linked list: delete then set moves a',
      'page to the newest end, and `frames.keys().next().value` is the least recently used one. It is',
      'slower than pointer surgery, which does not matter at buffer-pool sizes, and it is far easier to read.',
      '',
      'Reads return a copy, writes take a copy. The `frame.data.slice()` looks like a wasted allocation,',
      'but without it the caller holds the cache\'s own memory. One mutated byte changes the cache while',
      'the page is still marked clean, so flush skips it — correct in memory, wrong on disk.',
      '',
      'flush issues exactly one fsync. Writing back and persisting are different things: writePage only',
      'hands bytes to the OS, fsync is what makes them durable. Putting fsync inside the loop is equally',
      'correct and costs 50ms for ten dirty pages instead of 5ms.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 2 关 · 记录编解码与 slotted page                                  */
/* ------------------------------------------------------------------ */

const stage2 = {
  id: 'slotted-page',
  title: t('第 2 关 · 记录编解码与页内布局', 'Stage 2 · Record encoding and page layout'),
  goal: t(
    [
      '现在有了页，但页里装的还是一堆零。这一关把「一行数据」变成字节，再把字节塞进页里。',
      '',
      '**第一步，`src/record.ts`：**',
      '',
      '- `encodeRow(row)`：把 `{ id, name, active }` 编成紧凑的字节；',
      '- `decodeRow(bytes)`：反过来。',
      '',
      '定长字段（id、active）好办；变长的 `name` 必须自带长度，否则解码时不知道读到哪。',
      '`name` 的 UTF-8 字节数超过 255 就抛错——长度用一个字节存不下了。',
      '',
      '**第二步，`src/page.ts`：**',
      '',
      '一页 128 字节，要放进若干条**变长**记录，还要能按编号取出来。做法是 slotted page：',
      '',
      '```',
      '[ header | 记录1 记录2 记录3 →      ← slot3 slot2 slot1 ]',
      '```',
      '',
      '记录从前往后堆，slot 目录从后往前长，中间是空闲空间。每个 slot 记一条记录的',
      '偏移和长度。这样记录可以变长，slotId 又是稳定的编号。',
      '',
      '- `insert(bytes)`：放不下时返回 `null`，不要抛错也不要写坏页；',
      '- `read(slotId)`：删掉的返回 `null`；',
      '- `remove(slotId)`：**只标记，不搬移**——搬移会让其他记录的 slotId 失效；',
      '- `toBytes()` / `loadSlottedPage(bytes)`：与磁盘页互相转换，必须正好 128 字节。',
    ].join('\n'),
    [
      'You have pages, but they are still full of zeroes. This stage turns a row into bytes and packs',
      'those bytes into a page.',
      '',
      'First, `src/record.ts`:',
      '',
      '- `encodeRow(row)`: encode `{ id, name, active }` compactly;',
      '- `decodeRow(bytes)`: the inverse.',
      '',
      'Fixed-width fields (id, active) are easy; the variable-length `name` must carry its own length,',
      'or the decoder cannot know where it ends. Throw if the UTF-8 length of `name` exceeds 255 — one',
      'byte can no longer hold it.',
      '',
      'Second, `src/page.ts`:',
      '',
      'A 128-byte page must hold several variable-length records and still address them by number.',
      'That is a slotted page:',
      '',
      '```',
      '[ header | record1 record2 record3 →      ← slot3 slot2 slot1 ]',
      '```',
      '',
      'Records grow forward, the slot directory grows backward, free space sits between them. Each slot',
      'stores one record\'s offset and length, so records stay variable-length while slot ids stay stable.',
      '',
      '- `insert(bytes)`: return `null` when it does not fit; do not throw and do not corrupt the page;',
      '- `read(slotId)`: return `null` for a removed record;',
      '- `remove(slotId)`: mark only, never compact — compaction would invalidate other slot ids;',
      '- `toBytes()` / `loadSlottedPage(bytes)`: convert to and from a disk page, exactly 128 bytes.',
    ].join('\n')
  ),
  checklist: [
    t('encodeRow / decodeRow 往返不丢信息', 'encodeRow / decodeRow round-trips losslessly'),
    t('变长字段自带长度前缀', 'The variable-length field carries its own length prefix'),
    t('页放不下时 insert 返回 null 而不是抛错', 'insert returns null instead of throwing when the page is full'),
    t('remove 之后其他记录的 slotId 不变', 'Other slot ids survive a remove'),
    t('toBytes 正好 128 字节且能被 load 回来', 'toBytes is exactly 128 bytes and loads back'),
  ],
  pitfalls: [
    t(
      '用 `name.length` 当字节数。JavaScript 的字符串长度是 UTF-16 码元数，一个汉字 length 是 1 但 UTF-8 要 3 字节。按 length 分配缓冲区，写中文时就会越界或截断。',
      'Using `name.length` as a byte count. That is UTF-16 code units: a Chinese character has length 1 but takes 3 bytes in UTF-8. Sizing the buffer by length overruns or truncates as soon as a non-ASCII name appears.'
    ),
    t(
      '删除时把后面的记录往前搬，把空洞压掉。页内是紧凑了，但所有被搬动的记录 slotId 都变了，而索引里存的还是旧的——查出来的是另一行数据。这就是为什么删除只留墓碑。',
      'Compacting the page on delete by sliding later records down. The page gets tidy, but every moved record changes slot id while the index still holds the old one, so lookups return a different row. That is why deletion leaves a tombstone.'
    ),
    t(
      '判断「放不放得下」时忘了算 slot 自己的 4 个字节。于是最后一条记录写进去了，slot 目录却压到了记录数据上，页面损坏——而且是写的时候不报错、读的时候才乱。',
      'Forgetting that the new slot itself costs 4 bytes when checking whether a record fits. The last record goes in, the directory overwrites record data, and the page is corrupt — silently on write, visibly on read.'
    ),
    t(
      '直接把 `bytes.buffer` 交给 DataView。`Uint8Array` 可能是某个更大 buffer 上的视图，`byteOffset` 不为 0 时你读到的是别人的数据。构造 DataView 要带上 byteOffset 和 byteLength。',
      'Passing `bytes.buffer` straight to a DataView. A `Uint8Array` can be a view into a larger buffer; when `byteOffset` is not 0 you are reading somebody else\'s bytes. Always pass byteOffset and byteLength.'
    ),
  ],
  hints: [
    t(
      'TextEncoder / TextDecoder 直接给你 UTF-8 字节和字符串，不用自己处理码点。',
      'TextEncoder and TextDecoder hand you UTF-8 bytes and strings directly; no manual code-point work.'
    ),
    t(
      '空闲空间 = 目录起点 - 记录区终点。插入前先算 `需要的字节 = 记录长度 + 4`，再和空闲空间比。',
      'Free space = start of the directory minus end of the record area. Before inserting, compute `needed = record length + 4` and compare against it.'
    ),
  ],
  extension: t(
    [
      '这一关的布局就是 PostgreSQL 的页结构去掉细节之后的样子：页头、从前往后的行数据、',
      '从后往前的 line pointer 数组，中间是空洞。PostgreSQL 把这个 slot 叫 ItemId，',
      '把「页号 + slot 号」这个地址叫 **ctid**，索引里存的正是它。',
      '',
      '墓碑不回收带来一个真实问题：一个页反复插入删除之后，空间都被墓碑占着，',
      '看起来满了其实没数据。PostgreSQL 靠 VACUUM 回收，InnoDB 在页利用率低于阈值时合并页。',
      '这也是为什么「删了很多数据但磁盘没变小」是个经典 FAQ。',
      '',
      '另外，真实系统的记录编码要处理这一关跳过的东西：NULL 值（用一个位图标记哪些列是 NULL）、',
      '列的增删（记录里要带 schema 版本）、以及超长字段（PostgreSQL 的 TOAST 会把大字段挪到另一张表）。',
    ].join('\n'),
    [
      'This layout is PostgreSQL\'s page structure with the details removed: a header, tuples growing',
      'forward, an array of line pointers growing backward, free space in between. PostgreSQL calls the',
      'slot an ItemId and calls the "page number plus slot number" address a ctid — which is exactly what',
      'its indexes store.',
      '',
      'Never reclaiming tombstones creates a real problem: after enough insert/delete churn a page is',
      'full of dead space and looks full while holding almost nothing. PostgreSQL reclaims it with',
      'VACUUM; InnoDB merges pages once utilisation drops below a threshold. This is also why "I deleted',
      'a lot of rows but the disk did not shrink" is a classic FAQ.',
      '',
      'Real record encoding also handles what this stage skips: NULLs (a bitmap marking which columns are',
      'null), schema evolution (records carry a schema version), and oversized fields (PostgreSQL\'s TOAST',
      'moves large values into a side table).',
    ].join('\n')
  ),
  focus: ['correctness', 'encapsulation', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/record.ts',
      code`
        import type { Row } from './contract';

        /** 把一行编码成紧凑字节 */
        export function encodeRow(row: Row): Uint8Array {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }

        /** 从字节解码回一行 */
        export function decodeRow(bytes: Uint8Array): Row {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
    file(
      'src/page.ts',
      code`
        export interface SlottedPage {
          /** 放得下返回 slotId，放不下返回 null */
          insert(record: Uint8Array): number | null;
          /** 不存在或已删除返回 null */
          read(slotId: number): Uint8Array | null;
          remove(slotId: number): boolean;
          /** 包含墓碑在内的 slot 总数 */
          slotCount(): number;
          /** 还活着的记录条数 */
          liveCount(): number;
          freeSpace(): number;
          /** 序列化成正好 PAGE_SIZE 字节的页 */
          toBytes(): Uint8Array;
        }

        export function createSlottedPage(): SlottedPage {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }

        export function loadSlottedPage(bytes: Uint8Array): SlottedPage {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-2.spec.ts',
      code`
        import { encodeRow, decodeRow } from '../src/record';
        import { createSlottedPage, loadSlottedPage } from '../src/page';
        import { PAGE_SIZE } from '../src/disk';

        function row(id: number, name: string, active = 1) {
          return { id, name, active };
        }

        describe('阶段2 · 记录编解码', () => {
          it('编码后再解码，内容不变', () => {
            const original = row(42, 'alice', 1);
            const decoded = decodeRow(encodeRow(original));
            expect(decoded).toEqual(original);
          });

          it('空名字也能往返', () => {
            const decoded = decodeRow(encodeRow(row(7, '', 0)));
            expect(decoded).toEqual(row(7, '', 0));
          });

          it('大 id 不溢出', () => {
            const decoded = decodeRow(encodeRow(row(4000000000, 'big', 1)));
            expect(decoded.id).toBe(4000000000);
          });

          it('非 ASCII 名字按 UTF-8 字节处理', () => {
            const decoded = decodeRow(encodeRow(row(1, '张三', 1)));
            expect(decoded.name).toBe('张三');
          });

          it('编码是紧凑的，不是定长填充', () => {
            const short = encodeRow(row(1, 'a', 1));
            const long = encodeRow(row(1, 'abcdefghij', 1));
            expect(long.length).toBeGreaterThan(short.length);
            expect(short.length).toBeLessThan(20);
          });

          it('名字超过 255 字节时抛错', () => {
            let threw = false;
            try {
              encodeRow(row(1, 'x'.repeat(300), 1));
            } catch (error) {
              threw = true;
            }
            expect(threw).toBe(true);
          });
        });

        describe('阶段2 · slotted page', () => {
          it('插入后能按 slotId 读回来', () => {
            const page = createSlottedPage();
            const slot = page.insert(encodeRow(row(1, 'alice')));
            expect(slot).not.toBeNull();
            const back = page.read(slot as number);
            expect(back).not.toBeNull();
            expect(decodeRow(back as Uint8Array)).toEqual(row(1, 'alice'));
          });

          it('多条记录互不干扰', () => {
            const page = createSlottedPage();
            const a = page.insert(encodeRow(row(1, 'aa'))) as number;
            const b = page.insert(encodeRow(row(2, 'bbbb'))) as number;
            const c = page.insert(encodeRow(row(3, 'c'))) as number;

            expect(decodeRow(page.read(a) as Uint8Array)).toEqual(row(1, 'aa'));
            expect(decodeRow(page.read(b) as Uint8Array)).toEqual(row(2, 'bbbb'));
            expect(decodeRow(page.read(c) as Uint8Array)).toEqual(row(3, 'c'));
            expect(page.liveCount()).toBe(3);
          });

          it('页满时返回 null，已有记录仍然完好', () => {
            const page = createSlottedPage();
            const accepted: number[] = [];
            let rejected = false;

            for (let index = 0; index < 40; index += 1) {
              const slot = page.insert(encodeRow(row(index, 'user' + index)));
              if (slot === null) {
                rejected = true;
                break;
              }
              accepted.push(slot);
            }

            expect(rejected).toBe(true);
            // 128 字节的页装不下 40 条，但也不该只装得下两三条
            expect(accepted.length).toBeGreaterThanOrEqual(4);
            for (let index = 0; index < accepted.length; index += 1) {
              const back = page.read(accepted[index]);
              expect(back).not.toBeNull();
              expect(decodeRow(back as Uint8Array).id).toBe(index);
            }
          });

          it('删除之后读不到，其他记录的 slotId 不变', () => {
            const page = createSlottedPage();
            const a = page.insert(encodeRow(row(1, 'aa'))) as number;
            const b = page.insert(encodeRow(row(2, 'bb'))) as number;
            const c = page.insert(encodeRow(row(3, 'cc'))) as number;

            expect(page.remove(b)).toBe(true);
            expect(page.read(b)).toBeNull();
            expect(page.liveCount()).toBe(2);

            // 关键：a 和 c 的编号没有因为中间那条被删而挪动
            expect(decodeRow(page.read(a) as Uint8Array)).toEqual(row(1, 'aa'));
            expect(decodeRow(page.read(c) as Uint8Array)).toEqual(row(3, 'cc'));
          });

          it('删除不存在的 slot 返回 false', () => {
            const page = createSlottedPage();
            expect(page.remove(99)).toBe(false);
            expect(page.read(99)).toBeNull();
          });

          it('toBytes 正好是一页，且能 load 回等价的页', () => {
            const page = createSlottedPage();
            const a = page.insert(encodeRow(row(11, 'alpha'))) as number;
            const b = page.insert(encodeRow(row(22, 'beta'))) as number;
            page.remove(a);

            const bytes = page.toBytes();
            expect(bytes.length).toBe(PAGE_SIZE);

            const reloaded = loadSlottedPage(bytes);
            expect(reloaded.read(a)).toBeNull();
            expect(decodeRow(reloaded.read(b) as Uint8Array)).toEqual(row(22, 'beta'));
            expect(reloaded.liveCount()).toBe(1);
          });

          it('load 回来的页还能继续插入', () => {
            const page = createSlottedPage();
            page.insert(encodeRow(row(1, 'a')));

            const reloaded = loadSlottedPage(page.toBytes());
            const next = reloaded.insert(encodeRow(row(2, 'b')));
            expect(next).not.toBeNull();
            expect(decodeRow(reloaded.read(next as number) as Uint8Array)).toEqual(row(2, 'b'));
            expect(reloaded.liveCount()).toBe(2);
          });

          it('空页的空闲空间接近整页，插入后变小', () => {
            const page = createSlottedPage();
            const empty = page.freeSpace();
            expect(empty).toBeGreaterThan(PAGE_SIZE / 2);

            page.insert(encodeRow(row(1, 'hello')));
            expect(page.freeSpace()).toBeLessThan(empty);
          });

          it('读出来的是副本，改不坏页内数据', () => {
            const page = createSlottedPage();
            const slot = page.insert(encodeRow(row(5, 'copy'))) as number;

            const first = page.read(slot) as Uint8Array;
            first[0] = 255;
            const second = page.read(slot) as Uint8Array;

            expect(decodeRow(second)).toEqual(row(5, 'copy'));
          });
        });
      `
    ),
  ],
  gates: [],
  referenceFiles: [
    file(
      'src/record.ts',
      code`
        import type { Row } from './contract';

        /**
         * 布局：
         *   [0..3]  id            uint32 BE
         *   [4]     active        uint8
         *   [5]     nameLength    uint8   ← 变长字段自带长度
         *   [6..]   name          UTF-8
         */
        const ID_OFFSET = 0;
        const ACTIVE_OFFSET = 4;
        const NAME_LENGTH_OFFSET = 5;
        const HEADER_BYTES = 6;
        const MAX_NAME_BYTES = 255;

        export function encodeRow(row: Row): Uint8Array {
          const name = new TextEncoder().encode(row.name);
          if (name.length > MAX_NAME_BYTES) {
            throw new Error('name is ' + name.length + ' bytes, the length prefix holds at most 255');
          }

          const bytes = new Uint8Array(HEADER_BYTES + name.length);
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          view.setUint32(ID_OFFSET, row.id >>> 0);
          view.setUint8(ACTIVE_OFFSET, row.active ? 1 : 0);
          view.setUint8(NAME_LENGTH_OFFSET, name.length);
          bytes.set(name, HEADER_BYTES);
          return bytes;
        }

        export function decodeRow(bytes: Uint8Array): Row {
          if (bytes.length < HEADER_BYTES) {
            throw new Error('record is truncated: ' + bytes.length + ' bytes');
          }
          // 带上 byteOffset：bytes 可能是某个更大 buffer 上的视图
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const nameLength = view.getUint8(NAME_LENGTH_OFFSET);
          if (bytes.length < HEADER_BYTES + nameLength) {
            throw new Error('record claims a ' + nameLength + '-byte name but is shorter than that');
          }

          return {
            id: view.getUint32(ID_OFFSET),
            active: view.getUint8(ACTIVE_OFFSET),
            name: new TextDecoder().decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + nameLength)),
          };
        }
      `
    ),
    file(
      'src/page.ts',
      code`
        import { PAGE_SIZE } from './disk';

        export interface SlottedPage {
          insert(record: Uint8Array): number | null;
          read(slotId: number): Uint8Array | null;
          remove(slotId: number): boolean;
          slotCount(): number;
          liveCount(): number;
          freeSpace(): number;
          toBytes(): Uint8Array;
        }

        /**
         * 页布局：
         *   [0..1]   slotCount   uint16 BE
         *   [2..3]   freeStart   uint16 BE，记录区的终点
         *   [4..]    记录数据，从前往后堆
         *   [..128]  slot 目录，从后往前长，每个 slot 4 字节 (offset uint16, length uint16)
         *
         * 记录和目录相向生长，中间就是空闲空间。length 为 0 表示墓碑。
         */
        const HEADER_BYTES = 4;
        const SLOT_BYTES = 4;
        const SLOT_COUNT_OFFSET = 0;
        const FREE_START_OFFSET = 2;

        interface Slot {
          offset: number;
          length: number;
        }

        function build(slots: Slot[], data: Uint8Array, freeStart: number): SlottedPage {
          function directoryStart(): number {
            return PAGE_SIZE - slots.length * SLOT_BYTES;
          }

          function freeSpace(): number {
            return Math.max(0, directoryStart() - freeStart);
          }

          return {
            insert(record: Uint8Array): number | null {
              // 新记录要占 record.length 字节，它的 slot 还要再占 4 字节
              const needed = record.length + SLOT_BYTES;
              if (needed > freeSpace()) return null;

              data.set(record, freeStart);
              slots.push({ offset: freeStart, length: record.length });
              freeStart += record.length;
              return slots.length - 1;
            },

            read(slotId: number): Uint8Array | null {
              const slot = slots[slotId];
              if (!slot || slot.length === 0) return null;
              // slice 而不是 subarray：交出副本，调用方改不坏页
              return data.slice(slot.offset, slot.offset + slot.length);
            },

            remove(slotId: number): boolean {
              const slot = slots[slotId];
              if (!slot || slot.length === 0) return false;
              // 只留墓碑，不搬移：搬移会让其他记录的 slotId 失效，
              // 而索引里存的正是 slotId
              slot.length = 0;
              return true;
            },

            slotCount(): number {
              return slots.length;
            },

            liveCount(): number {
              return slots.filter((slot) => slot.length > 0).length;
            },

            freeSpace,

            toBytes(): Uint8Array {
              const page = new Uint8Array(PAGE_SIZE);
              page.set(data.subarray(0, freeStart), 0);

              const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
              view.setUint16(SLOT_COUNT_OFFSET, slots.length);
              view.setUint16(FREE_START_OFFSET, freeStart);

              slots.forEach((slot, index) => {
                const base = PAGE_SIZE - (index + 1) * SLOT_BYTES;
                view.setUint16(base, slot.offset);
                view.setUint16(base + 2, slot.length);
              });

              return page;
            },
          };
        }

        export function createSlottedPage(): SlottedPage {
          const data = new Uint8Array(PAGE_SIZE);
          return build([], data, HEADER_BYTES);
        }

        export function loadSlottedPage(bytes: Uint8Array): SlottedPage {
          if (bytes.length !== PAGE_SIZE) {
            throw new Error('a page must be exactly ' + PAGE_SIZE + ' bytes, got ' + bytes.length);
          }

          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const slotCount = view.getUint16(SLOT_COUNT_OFFSET);
          const freeStart = view.getUint16(FREE_START_OFFSET);

          const slots: Slot[] = [];
          for (let index = 0; index < slotCount; index += 1) {
            const base = PAGE_SIZE - (index + 1) * SLOT_BYTES;
            slots.push({ offset: view.getUint16(base), length: view.getUint16(base + 2) });
          }

          return build(slots, bytes.slice(), freeStart || HEADER_BYTES);
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**为什么删除只留墓碑。** 把后面的记录往前搬，页内确实紧凑了，但每条被搬动的记录 slotId 都变了。',
      '下一关的索引里存的正是 `(pageId, slotId)`，一搬就全指错了地方——查出来的不是「查不到」，',
      '而是**另一行数据**，这比报错难查得多。代价是空间不回收，真实数据库靠 VACUUM 之类的后台过程补。',
      '',
      '**为什么 insert 要把 slot 自己的 4 字节算进去。** 只比记录长度的话，最后一条会「刚好放下」，',
      '然后它的 slot 从后往前压到记录数据上。写的时候一切正常，读的时候才发现页坏了。',
      '',
      '**为什么 DataView 要带 byteOffset。** `new DataView(bytes.buffer)` 在 `bytes` 是子视图时会从',
      '整个 buffer 的开头读起。这一关里 `loadSlottedPage` 拿到的很可能就是别人 subarray 出来的视图，',
      '不带 offset 的话读到的是相邻页的数据，而且完全不报错。',
    ].join('\n'),
    [
      'Why deletion only leaves a tombstone. Sliding later records down does compact the page, but every',
      'moved record changes slot id. The next stage\'s index stores exactly `(pageId, slotId)`, so after a',
      'compaction those pointers do not fail to resolve — they resolve to a different row, which is far',
      'harder to debug than an error. The cost is unreclaimed space, which real databases sweep up with',
      'background processes like VACUUM.',
      '',
      'Why insert counts the slot\'s own 4 bytes. Comparing against the record length alone lets the last',
      'record "just fit", after which its slot grows backward over the record data. Nothing complains on',
      'write; the page is simply corrupt on read.',
      '',
      'Why the DataView carries byteOffset. `new DataView(bytes.buffer)` starts at the beginning of the',
      'whole buffer when `bytes` is a sub-view. Here `loadSlottedPage` is very likely handed a subarray,',
      'and without the offset you silently read the neighbouring page.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 3 关 · B+Tree 索引                                                */
/* ------------------------------------------------------------------ */

const btreeNode = readonlyFile(
  'src/btree-node.ts',
  code`
    /**
     * B+Tree 节点的编解码（只读，平台提供）
     *
     * 节点怎么变成字节，第 2 关已经练过了，这一关不重复。
     * 你要写的是**树的算法**：查找路径、分裂、以及叶子之间的链表。
     */
    import type { Slot } from './contract';
    import { PAGE_SIZE } from './disk';

    /** 一个节点最多放几个 key。取小值是为了让分裂尽快发生，方便观察。 */
    export const MAX_KEYS = 4;

    export interface LeafNode {
      kind: 'leaf';
      keys: number[];
      /** 与 keys 一一对应，指向真实记录的位置 */
      slots: Slot[];
      /** 下一个叶子的 pageId，没有则为 -1。范围扫描靠它 */
      next: number;
    }

    export interface InternalNode {
      kind: 'internal';
      keys: number[];
      /** 总是比 keys 多一个 */
      children: number[];
    }

    export type BTreeNode = LeafNode | InternalNode;

    export function emptyLeaf(): LeafNode {
      return { kind: 'leaf', keys: [], slots: [], next: -1 };
    }

    export function encodeNode(node: BTreeNode): Uint8Array {
      const page = new Uint8Array(PAGE_SIZE);
      const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
      view.setUint8(0, node.kind === 'leaf' ? 0 : 1);
      view.setUint8(1, node.keys.length);

      let offset = 4;
      if (node.kind === 'leaf') {
        view.setInt16(2, node.next);
        for (const key of node.keys) {
          view.setUint32(offset, key >>> 0);
          offset += 4;
        }
        for (const slot of node.slots) {
          view.setUint16(offset, slot.pageId);
          view.setUint16(offset + 2, slot.slotId);
          offset += 4;
        }
      } else {
        for (const key of node.keys) {
          view.setUint32(offset, key >>> 0);
          offset += 4;
        }
        for (const child of node.children) {
          view.setUint16(offset, child);
          offset += 2;
        }
      }
      return page;
    }

    export function decodeNode(bytes: Uint8Array): BTreeNode {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const kind = view.getUint8(0);
      const keyCount = view.getUint8(1);

      let offset = 4;
      const keys: number[] = [];
      if (kind === 0) {
        const next = view.getInt16(2);
        for (let index = 0; index < keyCount; index += 1) {
          keys.push(view.getUint32(offset));
          offset += 4;
        }
        const slots: Slot[] = [];
        for (let index = 0; index < keyCount; index += 1) {
          slots.push({ pageId: view.getUint16(offset), slotId: view.getUint16(offset + 2) });
          offset += 4;
        }
        return { kind: 'leaf', keys, slots, next };
      }

      for (let index = 0; index < keyCount; index += 1) {
        keys.push(view.getUint32(offset));
        offset += 4;
      }
      const children: number[] = [];
      for (let index = 0; index < keyCount + 1; index += 1) {
        children.push(view.getUint16(offset));
        offset += 2;
      }
      return { kind: 'internal', keys, children };
    }
  `
);

const stage3 = {
  id: 'btree',
  title: t('第 3 关 · B+Tree 索引', 'Stage 3 · B+Tree index'),
  goal: t(
    [
      '有了页和记录，现在能存一千行了。问题是「找 id = 837 的那一行」还得把一千行全读一遍。',
      '一次读盘 1ms，全表扫描就是几十毫秒；而 B+Tree 只要读 3 页。',
      '',
      '在 `src/btree.ts` 实现 `createBTree(pager, rootPageId?)`：',
      '',
      '- `insert(key, slot)`：key 已存在就覆盖它的 slot；',
      '- `search(key)`：找不到返回 `null`；',
      '- `range(lo, hi)`：返回 key 在闭区间内的全部条目，**按 key 升序**；',
      '- `height()`：树的层数，根算第 1 层；',
      '- `rootPageId()`：当前根节点的 pageId（分裂会换根，所以它会变）。',
      '',
      '节点的编解码平台已经给了（`src/btree-node.ts`，只读），你要写的是树本身：',
      '',
      '1. **查找路径**：从根往下，在内部节点里选对孩子；',
      '2. **分裂**：一个节点装不下 `MAX_KEYS + 1` 个 key 时一分为二，把分界 key 向上提；',
      '   根节点分裂时要**新建一个根**，树才会长高；',
      '3. **叶子链表**：所有叶子用 `next` 串成一条有序链，`range` 顺着它走就行，不用回到根。',
      '',
      '不传 `rootPageId` 表示建一棵新树；传了表示打开磁盘上已有的树。',
    ].join('\n'),
    [
      'Pages and records let you store a thousand rows. But "find the row with id 837" still means',
      'reading all thousand. At 1ms per page read that is tens of milliseconds; a B+Tree reads 3 pages.',
      '',
      'Implement `createBTree(pager, rootPageId?)` in `src/btree.ts`:',
      '',
      '- `insert(key, slot)`: an existing key has its slot overwritten;',
      '- `search(key)`: `null` when absent;',
      '- `range(lo, hi)`: every entry whose key is in the closed interval, in ascending key order;',
      '- `height()`: number of levels, the root counting as 1;',
      '- `rootPageId()`: the current root page (a root split changes it).',
      '',
      'Node encoding is provided (`src/btree-node.ts`, read-only). What you write is the tree:',
      '',
      '1. The search path: descend from the root, picking the right child at each internal node;',
      '2. Splitting: when a node would hold `MAX_KEYS + 1` keys, cut it in two and push the separator',
      '   up; splitting the root means creating a new root, which is how the tree grows taller;',
      '3. The leaf chain: leaves are linked in key order through `next`, so `range` walks sideways',
      '   instead of returning to the root.',
      '',
      'Omitting `rootPageId` builds a new tree; passing one opens the tree already on disk.',
    ].join('\n')
  ),
  checklist: [
    t('插入后能查到，查不存在的 key 返回 null', 'Inserted keys are found; absent keys return null'),
    t('插入足够多的 key 之后树会长高', 'Enough inserts make the tree taller'),
    t('range 返回升序结果并能跨叶子', 'range returns ascending results and crosses leaves'),
    t('flush 之后换一个 pager 打开，数据还在', 'After flush, reopening with another pager still finds the data'),
    t('查找读的页数随层数增长，而不是随数据量', 'Pages read per lookup grows with height, not with row count'),
  ],
  pitfalls: [
    t(
      '内部节点选孩子时用 `key > separator` 而不是 `key >= separator`。B+Tree 的分界 key 是**右**子树的最小值（复制上去的，不是移上去的），用 `>` 会把等于分界值的那个 key 落到左子树里，于是它插得进去却查不出来。',
      'Descending with `key > separator` instead of `key >= separator`. In a B+Tree the separator is the minimum of the right subtree (copied up, not moved up), so `>` sends an exactly-equal key into the left subtree: it inserts fine and then cannot be found.'
    ),
    t(
      '分裂叶子时忘了接好 `next` 链。新叶子要接管旧叶子原来的后继，旧叶子再指向新叶子。顺序写反或者漏掉一环，单点查询全对，`range` 却会漏掉一整段——而且漏的是分裂过的那一段，数据量小的时候根本不出现。',
      'Forgetting to relink `next` when splitting a leaf. The new leaf inherits the old leaf\'s successor and the old leaf points at the new one. Get the order wrong and point lookups all pass while `range` silently skips a whole run — the run that was split, which does not exist in small test data.'
    ),
    t(
      '根节点分裂时在原地改根。根的 pageId 是别人（这里是 `rootPageId()`，真实系统里是元数据页）记着的，就地把根变成内部节点会让树的其余部分对不上。正确做法是**新分配**一个页当新根。',
      'Splitting the root in place. The root\'s page id is remembered elsewhere (here `rootPageId()`, in a real engine a metadata page); mutating the root into an internal node desynchronises the rest of the tree. Allocate a new page for the new root instead.'
    ),
    t(
      '内部节点分裂时把中间 key 复制上去而不是移上去。叶子分裂是复制（因为叶子必须保有全部数据），内部节点分裂是移动（中间 key 只是路标，留在下面会多出一个指不到任何数据的分界）。两者搞混会让某些 key 查不到。',
      'Copying the middle key up when splitting an internal node instead of moving it. Leaf splits copy (leaves must keep all the data); internal splits move (the middle key is only a signpost, and leaving a duplicate below creates a separator that points at nothing). Confusing the two makes some keys unreachable.'
    ),
  ],
  hints: [
    t(
      '插入写成递归：`insertInto(pageId, key, slot)` 返回 `null` 表示没分裂，返回 `{ key, rightPageId }` 表示分裂了、请上层把这个 key 收进去。根那一层单独处理换根。',
      'Write insertion recursively: `insertInto(pageId, key, slot)` returns `null` for no split, or `{ key, rightPageId }` meaning "I split, please absorb this key". Handle the root replacement one level above.'
    ),
    t(
      'range 先像 search 那样降到 lo 所在的叶子，然后顺着 next 一直走，直到某个叶子的最大 key 已经超过 hi。',
      'For range, descend to the leaf holding lo exactly as search does, then follow `next` until a leaf\'s largest key passes hi.'
    ),
  ],
  extension: t(
    [
      '为什么是 B+Tree 而不是二叉树？因为磁盘按页读。二叉树每层只能排除一半，',
      '一次读盘只带回 1 个 key；B+Tree 一次读盘带回一整页的 key，扇出几百，',
      '于是一千万行也只要三四层。层数就是读盘次数，这是它唯一在乎的指标。',
      '',
      '这一关省掉的部分里，最要紧的是**删除后的合并**。真实的 B+Tree 在节点利用率低于一半时',
      '要向兄弟借 key 或者与兄弟合并，否则大量删除之后树会退化成一堆半空的页。',
      '实现难度比插入高，因为合并会向上传播，可能一路缩到根。',
      '',
      '另外，叶子的 `next` 链在并发环境下是个经典难题：一个线程正沿着链扫描，另一个线程分裂了',
      '它脚下的叶子。教科书解法是 **B-link tree**（Lehman & Yao, 1981），给每个节点加一个',
      '指向右兄弟的指针，扫描者发现自己落后了就顺着右指针追上去——PostgreSQL 的 nbtree 用的就是它。',
    ].join('\n'),
    [
      'Why a B+Tree and not a binary tree? Because disks read pages. A binary tree eliminates half the',
      'keys per level and brings back one key per read; a B+Tree brings back a whole page of keys, giving',
      'a fan-out in the hundreds, so ten million rows still fit in three or four levels. Levels are disk',
      'reads, and that is the only number it cares about.',
      '',
      'The most significant omission here is merging after deletion. A real B+Tree borrows from or merges',
      'with a sibling once a node drops below half full, otherwise heavy deletion degrades the tree into a',
      'pile of half-empty pages. It is harder than insertion because a merge propagates upward and can',
      'shrink the tree all the way to the root.',
      '',
      'The leaf chain is also a classic concurrency problem: one thread is scanning it while another',
      'splits the leaf under its feet. The textbook answer is the B-link tree (Lehman and Yao, 1981),',
      "which adds a right-sibling pointer so a lagging scanner can chase forward — that is what",
      "PostgreSQL's nbtree implements.",
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'elegance'],
  lab: {},
  starterFiles: [
    btreeNode,
    file(
      'src/btree.ts',
      code`
        import type { Pager, Slot } from './contract';

        export interface BTreeEntry {
          key: number;
          slot: Slot;
        }

        export interface BTree {
          insert(key: number, slot: Slot): Promise<void>;
          search(key: number): Promise<Slot | null>;
          range(lo: number, hi: number): Promise<BTreeEntry[]>;
          height(): Promise<number>;
          rootPageId(): number;
        }

        /** 不传 rootPageId 建新树，传了则打开磁盘上已有的树 */
        export function createBTree(pager: Pager, rootPageId?: number): Promise<BTree> {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-3.spec.ts',
      code`
        import { createBTree } from '../src/btree';
        import { createPager } from '../src/pager';
        import { Disk } from '../src/disk';
        import { MAX_KEYS } from '../src/btree-node';
        import { count, getCounters } from '@lab/metrics';

        function slotFor(key: number) {
          return { pageId: key % 50, slotId: key % 7 };
        }

        async function freshTree(capacity = 32) {
          const disk = new Disk();
          const pager = createPager(disk, { capacity });
          const tree = await createBTree(pager);
          return { disk, pager, tree };
        }

        describe('阶段3 · B+Tree 索引', () => {
          it('插入之后能查到', async () => {
            const { tree } = await freshTree();
            await tree.insert(10, slotFor(10));
            expect(await tree.search(10)).toEqual(slotFor(10));
          });

          it('查不存在的 key 返回 null', async () => {
            const { tree } = await freshTree();
            await tree.insert(10, slotFor(10));
            expect(await tree.search(11)).toBeNull();
          });

          it('空树查任何 key 都返回 null', async () => {
            const { tree } = await freshTree();
            expect(await tree.search(1)).toBeNull();
          });

          it('重复 key 覆盖旧的 slot', async () => {
            const { tree } = await freshTree();
            await tree.insert(5, { pageId: 1, slotId: 1 });
            await tree.insert(5, { pageId: 9, slotId: 3 });
            expect(await tree.search(5)).toEqual({ pageId: 9, slotId: 3 });
          });

          it('乱序插入几十个 key，每个都查得到', async () => {
            const { tree } = await freshTree();
            const keys: number[] = [];
            // 用一个固定的乘法散列打乱顺序，保证可复现
            for (let index = 0; index < 60; index += 1) keys.push((index * 37) % 101);

            for (const key of keys) await tree.insert(key, slotFor(key));
            for (const key of keys) {
              expect(await tree.search(key)).toEqual(slotFor(key));
            }
          });

          it('插入足够多之后树会长高', async () => {
            const { tree } = await freshTree();
            expect(await tree.height()).toBe(1);

            for (let key = 1; key <= MAX_KEYS + 1; key += 1) {
              await tree.insert(key, slotFor(key));
            }
            expect(await tree.height()).toBe(2);

            for (let key = MAX_KEYS + 2; key <= 60; key += 1) {
              await tree.insert(key, slotFor(key));
            }
            expect(await tree.height()).toBeGreaterThanOrEqual(3);
          });

          it('根分裂之后 rootPageId 会变', async () => {
            const { tree } = await freshTree();
            const before = tree.rootPageId();
            for (let key = 1; key <= MAX_KEYS + 1; key += 1) {
              await tree.insert(key, slotFor(key));
            }
            expect(tree.rootPageId()).not.toBe(before);
          });

          it('range 返回升序结果', async () => {
            const { tree } = await freshTree();
            for (let key = 1; key <= 40; key += 1) await tree.insert(key, slotFor(key));

            const found = await tree.range(12, 19);
            expect(found.map((entry) => entry.key)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
            expect(found[0].slot).toEqual(slotFor(12));
          });

          it('range 能跨越多个叶子', async () => {
            const { tree } = await freshTree();
            for (let key = 1; key <= 60; key += 1) await tree.insert(key, slotFor(key));

            // 一个叶子最多 MAX_KEYS 个 key，这个区间必然横跨好几个叶子
            const found = await tree.range(5, 55);
            const expected: number[] = [];
            for (let key = 5; key <= 55; key += 1) expected.push(key);
            expect(found.map((entry) => entry.key)).toEqual(expected);
          });

          it('range 区间内没有 key 时返回空数组', async () => {
            const { tree } = await freshTree();
            for (let key = 1; key <= 20; key += 1) await tree.insert(key * 10, slotFor(key * 10));

            expect(await tree.range(101, 109)).toEqual([]);
          });

          it('range 的边界是闭区间', async () => {
            const { tree } = await freshTree();
            for (let key = 1; key <= 20; key += 1) await tree.insert(key, slotFor(key));

            const found = await tree.range(7, 7);
            expect(found.map((entry) => entry.key)).toEqual([7]);
          });

          it('flush 之后换一个 pager 打开，数据还在', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 32 });
            const tree = await createBTree(pager);
            for (let key = 1; key <= 40; key += 1) await tree.insert(key, slotFor(key));
            const rootPageId = tree.rootPageId();
            await pager.flush();

            const reopened = await createBTree(createPager(disk, { capacity: 32 }), rootPageId);
            expect(await reopened.search(23)).toEqual(slotFor(23));
            expect((await reopened.range(30, 33)).map((entry) => entry.key)).toEqual([30, 31, 32, 33]);
          });

          it('单点查找只读了树高那么多页 [gate:logarithmic]', async () => {
            const disk = new Disk();
            const warm = createPager(disk, { capacity: 64 });
            const tree = await createBTree(warm);
            for (let key = 1; key <= 60; key += 1) await tree.insert(key, slotFor(key));
            const rootPageId = tree.rootPageId();
            const treeHeight = await tree.height();
            await warm.flush();

            // capacity 1 的缓冲池等于没有缓存：每读一个节点就是一次真实读盘
            const cold = createPager(disk, { capacity: 1 });
            const reopened = await createBTree(cold, rootPageId);

            const before = getCounters()['diskReads'] || 0;
            const found = await reopened.search(37);
            const reads = (getCounters()['diskReads'] || 0) - before;
            count('searchPageReads', reads);

            expect(found).toEqual(slotFor(37));
            // 60 个 key 至少 15 个叶子；扫一遍要十几次读盘，走索引只要树高那么多次
            expect(reads).toBeLessThanOrEqual(treeHeight + 1);
            expect(reads).toBeLessThanOrEqual(6);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.searchPageReads',
      op: 'lte',
      value: 6,
      unit: 'pages',
      zh: '60 个 key 的单点查找最多读 6 页',
      en: 'A point lookup over 60 keys reads at most 6 pages',
      dimension: 'latency',
      scope: 'gate:logarithmic',
    }),
  ],
  referenceFiles: [
    file(
      'src/btree.ts',
      code`
        import type { Pager, Slot } from './contract';
        import type { BTreeNode, InternalNode, LeafNode } from './btree-node';
        import { MAX_KEYS, decodeNode, emptyLeaf, encodeNode } from './btree-node';

        export interface BTreeEntry {
          key: number;
          slot: Slot;
        }

        export interface BTree {
          insert(key: number, slot: Slot): Promise<void>;
          search(key: number): Promise<Slot | null>;
          range(lo: number, hi: number): Promise<BTreeEntry[]>;
          height(): Promise<number>;
          rootPageId(): number;
        }

        /** 子节点分裂后交给父节点的东西：一个分界 key 和新的右兄弟 */
        interface Split {
          key: number;
          rightPageId: number;
        }

        export async function createBTree(pager: Pager, rootPageId?: number): Promise<BTree> {
          let root: number;
          if (rootPageId === undefined) {
            root = await pager.allocatePage();
            await pager.writePage(root, encodeNode(emptyLeaf()));
          } else {
            root = rootPageId;
          }

          async function readNode(pageId: number): Promise<BTreeNode> {
            return decodeNode(await pager.readPage(pageId));
          }

          async function writeNode(pageId: number, node: BTreeNode): Promise<void> {
            await pager.writePage(pageId, encodeNode(node));
          }

          /**
           * 分界 key 是右子树的最小值，所以「等于分界值」要往右走。
           * 写成 key > keys[index] 的话，等于分界值的 key 会掉进左子树，插得进去查不出来。
           */
          function childIndexFor(node: InternalNode, key: number): number {
            let index = 0;
            while (index < node.keys.length && key >= node.keys[index]) index += 1;
            return index;
          }

          async function descendToLeaf(key: number): Promise<LeafNode> {
            let node = await readNode(root);
            while (node.kind === 'internal') {
              node = await readNode(node.children[childIndexFor(node, key)]);
            }
            return node;
          }

          async function splitLeaf(pageId: number, node: LeafNode): Promise<Split> {
            const mid = Math.floor(node.keys.length / 2);
            const rightKeys = node.keys.splice(mid);
            const rightSlots = node.slots.splice(mid);

            const rightPageId = await pager.allocatePage();
            // 新叶子接管旧叶子的后继，旧叶子再指向新叶子——顺序反了 range 就会断链
            const rightNode: LeafNode = {
              kind: 'leaf',
              keys: rightKeys,
              slots: rightSlots,
              next: node.next,
            };
            node.next = rightPageId;

            await writeNode(pageId, node);
            await writeNode(rightPageId, rightNode);
            // 叶子分裂是「复制」分界 key：叶子必须保有全部数据
            return { key: rightNode.keys[0], rightPageId };
          }

          async function splitInternal(pageId: number, node: InternalNode): Promise<Split> {
            const mid = Math.floor(node.keys.length / 2);
            // 内部节点分裂是「移动」分界 key：它只是路标，留在下面会多出一个指不到数据的分界
            const promoted = node.keys[mid];
            const rightNode: InternalNode = {
              kind: 'internal',
              keys: node.keys.slice(mid + 1),
              children: node.children.slice(mid + 1),
            };
            node.keys = node.keys.slice(0, mid);
            node.children = node.children.slice(0, mid + 1);

            const rightPageId = await pager.allocatePage();
            await writeNode(pageId, node);
            await writeNode(rightPageId, rightNode);
            return { key: promoted, rightPageId };
          }

          async function insertInto(pageId: number, key: number, slot: Slot): Promise<Split | null> {
            const node = await readNode(pageId);

            if (node.kind === 'leaf') {
              let position = 0;
              while (position < node.keys.length && node.keys[position] < key) position += 1;

              if (node.keys[position] === key) {
                node.slots[position] = slot;
                await writeNode(pageId, node);
                return null;
              }

              node.keys.splice(position, 0, key);
              node.slots.splice(position, 0, slot);
              if (node.keys.length <= MAX_KEYS) {
                await writeNode(pageId, node);
                return null;
              }
              return splitLeaf(pageId, node);
            }

            const index = childIndexFor(node, key);
            const split = await insertInto(node.children[index], key, slot);
            if (!split) return null;

            node.keys.splice(index, 0, split.key);
            node.children.splice(index + 1, 0, split.rightPageId);
            if (node.keys.length <= MAX_KEYS) {
              await writeNode(pageId, node);
              return null;
            }
            return splitInternal(pageId, node);
          }

          return {
            async insert(key: number, slot: Slot): Promise<void> {
              const split = await insertInto(root, key, slot);
              if (!split) return;

              // 根分裂：必须新分配一页当根，不能就地把旧根改成内部节点
              const newRoot = await pager.allocatePage();
              await writeNode(newRoot, {
                kind: 'internal',
                keys: [split.key],
                children: [root, split.rightPageId],
              });
              root = newRoot;
            },

            async search(key: number): Promise<Slot | null> {
              const leaf = await descendToLeaf(key);
              const index = leaf.keys.indexOf(key);
              return index === -1 ? null : leaf.slots[index];
            },

            async range(lo: number, hi: number): Promise<BTreeEntry[]> {
              const found: BTreeEntry[] = [];
              let leaf: LeafNode | null = await descendToLeaf(lo);

              while (leaf) {
                for (let index = 0; index < leaf.keys.length; index += 1) {
                  const key = leaf.keys[index];
                  if (key >= lo && key <= hi) found.push({ key, slot: leaf.slots[index] });
                }

                const largest = leaf.keys[leaf.keys.length - 1];
                // 叶子是有序链，最大的 key 都超过 hi 了，后面不可能还有命中
                if (leaf.next === -1 || (largest !== undefined && largest > hi)) break;
                leaf = (await readNode(leaf.next)) as LeafNode;
              }

              return found;
            },

            async height(): Promise<number> {
              let depth = 1;
              let node = await readNode(root);
              while (node.kind === 'internal') {
                node = await readNode(node.children[0]);
                depth += 1;
              }
              return depth;
            },

            rootPageId(): number {
              return root;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**插入写成「向上冒泡」的递归。** `insertInto` 返回 `null` 或者一个 `Split`，',
      '含义是「我裂了，这个 key 归你管」。父节点收下它，如果自己也满了就继续往上裂。',
      '根那一层单独处理，因为只有它需要**新建一个根**——树长高就发生在这一行。',
      '',
      '**叶子分裂复制 key，内部节点分裂移动 key。** 这是 B+Tree 和 B-Tree 的分界点：',
      'B+Tree 的数据全在叶子，所以分界 key 必须在叶子里留一份；内部节点的 key 只是路标，',
      '移上去就行。把两者搞反，要么查不到数据，要么多出一个指不到任何东西的分界。',
      '',
      '**`childIndexFor` 用 `>=` 而不是 `>`。** 分界 key 等于右子树的最小值，',
      '所以「正好等于分界值」的 key 在右边。这一个字符的差别会让某些 key 插得进去、查不出来，',
      '而且只在分界值上出错——小数据量的测试基本撞不到。',
      '',
      '**`range` 不回到根。** 降到起点叶子之后顺着 `next` 横着走，这是 B+Tree 相对 B-Tree 的主要好处：',
      '范围扫描是顺序的，不用为每个 key 重新走一遍树。',
    ].join('\n'),
    [
      'Insertion bubbles upward through recursion. `insertInto` returns `null` or a `Split` meaning "I',
      'split, this key is yours now". The parent absorbs it and splits in turn if it is also full. The',
      'root is handled one level up because only the root needs a brand-new page — that single line is',
      'where the tree grows taller.',
      '',
      'Leaf splits copy the key, internal splits move it. This is the line between a B+Tree and a B-Tree:',
      'all data lives in the leaves, so the separator must also remain in a leaf; an internal key is only',
      'a signpost and can move. Swap the two and you either lose keys or create a separator pointing at',
      'nothing.',
      '',
      '`childIndexFor` uses `>=`, not `>`. The separator equals the minimum of the right subtree, so a key',
      'exactly equal to it belongs on the right. That one character makes some keys insertable but',
      'unfindable, and only ever at separator values — which small test data rarely hits.',
      '',
      '`range` never returns to the root. It descends once to the starting leaf and then walks sideways',
      'along `next`. That is the main advantage a B+Tree has over a B-Tree: range scans are sequential',
      'instead of re-descending the tree for every key.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 4 关 · WAL 与崩溃恢复                                             */
/* ------------------------------------------------------------------ */

const walCodec = readonlyFile(
  'src/wal-codec.ts',
  code`
    /**
     * 日志记录的编解码（只读，平台提供）
     *
     * 这里用 JSON，因为日志的字节格式不是这一关要教的东西。
     * 真实的 WAL 是紧凑二进制，每条记录还带 LSN 和校验和——
     * 校验和用来识别「最后一条记录只写了一半」，那是崩溃时的常态。
     */
    import type { LogRecord } from './contract';

    export function encodeLogRecord(record: LogRecord): Uint8Array {
      return new TextEncoder().encode(JSON.stringify(record));
    }

    export function decodeLogRecord(bytes: Uint8Array): LogRecord {
      return JSON.parse(new TextDecoder().decode(bytes)) as LogRecord;
    }
  `
);

const stage4 = {
  id: 'wal',
  title: t('第 4 关 · WAL 与崩溃恢复', 'Stage 4 · WAL and crash recovery'),
  goal: t(
    [
      '前三关的数据只要不 fsync 就会丢，而且丢得没有规律：一个事务改了 3 页，',
      '可能落盘 1 页就掉电，重启后数据库处在一个「半个事务」的状态。',
      '',
      'WAL 的思路是：**别指望数据页写得原子，让日志来记账**。',
      '事务提交前，先把「我要改哪些页、改成什么」写进日志并 fsync；',
      '日志一旦持久，事务就算提交成功了——哪怕数据页一页都还没写。',
      '崩溃之后照着日志把改动重放一遍，数据库就回到了一致状态。',
      '',
      '在 `src/wal.ts` 实现 `createWalStore(disk)`：',
      '',
      '- `begin()`：开一个事务，返回 `{ id, write, commit, rollback }`；',
      '- `tx.write(pageId, data)`：登记一次修改，**此时不要碰数据页**；',
      '- `tx.commit()`：写 commit 日志 → fsync（整个事务**只 fsync 一次**）→ 再落数据页；',
      '- `tx.rollback()`：丢弃这个事务，日志里没有 commit 记录，恢复时它会被忽略；',
      '- `readPage(pageId)`：读已提交的数据；',
      '- `recover()`：重放日志里所有**已提交**的事务，返回重放了几个事务。',
      '',
      '关键在于 `write` 的时候不能直接写数据页。一旦写了，别的事务 fsync 时会顺手把你',
      '没提交的改动一起刷到盘上——这就是所谓 steal，它会逼你实现 undo 日志。',
      '把改动攒到 commit 再落盘（no-steal），恢复就只需要 redo。',
    ].join('\n'),
    [
      'Through the first three stages, anything not fsynced is lost — and lost unevenly: a transaction',
      'touching three pages might get one of them to disk before the power cut, leaving the database in a',
      'half-transaction state.',
      '',
      'WAL\'s idea is to stop expecting data pages to be written atomically and let a log keep the books.',
      'Before a transaction commits, write "which pages I am changing and to what" into the log and fsync',
      'it; once the log is durable the transaction is committed, even if not one data page has been',
      'written. After a crash, replay the log and the database is consistent again.',
      '',
      'Implement `createWalStore(disk)` in `src/wal.ts`:',
      '',
      '- `begin()`: start a transaction, returning `{ id, write, commit, rollback }`;',
      '- `tx.write(pageId, data)`: record a change, and do not touch the data page yet;',
      '- `tx.commit()`: append the commit record, fsync once for the whole transaction, then write pages;',
      '- `tx.rollback()`: drop the transaction; with no commit record, recovery ignores it;',
      '- `readPage(pageId)`: read committed data;',
      '- `recover()`: replay every committed transaction in the log, returning how many were replayed.',
      '',
      'The crux is that `write` must not touch the data page. If it does, another transaction\'s fsync',
      'will push your uncommitted change to disk with it — that is "steal", and it forces you to write an',
      'undo log. Buffering until commit (no-steal) means recovery only ever needs redo.',
    ].join('\n')
  ),
  checklist: [
    t('提交后掉电，数据还在', 'Data survives a crash after commit'),
    t('没提交就掉电，改动完全不存在', 'An uncommitted change leaves no trace after a crash'),
    t('write 时不碰数据页，攒到 commit 再落盘', 'write buffers; only commit touches data pages'),
    t('一个事务只 fsync 一次', 'One transaction costs exactly one fsync'),
    t('recover 返回重放的事务数，且可重复调用', 'recover reports how many transactions it replayed and is repeatable'),
  ],
  pitfalls: [
    t(
      '`commit()` 里忘了 fsync。所有测试在不崩溃的路径上都会通过，因为数据还在页缓存里读得到；只有掉电之后才发现「提交成功」的事务消失了。这正是 ACID 里的 D，也是最容易被漏掉的一个字母。',
      'Forgetting the fsync inside `commit()`. Every non-crash test still passes because the data is readable from the page cache; only after a power cut do "successfully committed" transactions vanish. That is the D in ACID, and the letter most often dropped.'
    ),
    t(
      '在 `write()` 里就把数据页写下去。看起来更直接，但另一个事务提交时的 fsync 会把你没提交的页一起刷成持久的。恢复时 redo 日志里没有这个事务，也就没人把它撤销——脏数据就这么留在了库里。',
      'Writing the data page inside `write()`. It looks more direct, but another transaction\'s commit fsync makes your uncommitted page durable. Recovery finds no record of that transaction and therefore never undoes it, so the dirty data simply stays in the database.'
    ),
    t(
      '每写一页就 fsync 一次。正确，但一个改了 10 页的事务要 50ms 而不是 5ms。日志的价值恰恰在于把「若干次随机页写」换成「一次顺序日志写 + 一次 fsync」。',
      'Calling fsync after every page. Correct, but a ten-page transaction costs 50ms instead of 5ms. The whole point of a log is trading several random page writes for one sequential log write and one fsync.'
    ),
    t(
      '恢复时不区分「已提交」和「写到一半」。日志里既有提交完成的事务，也有崩溃时正在进行的事务，后者同样留下了 write 记录。必须先扫一遍找出哪些 txId 有 commit 记录，再只重放这些。',
      'Replaying without separating committed from in-flight transactions. The log holds both, and an in-flight one left `write` records too. You must first scan for which txIds have a commit record, then replay only those.'
    ),
  ],
  hints: [
    t(
      '恢复分两趟：第一趟扫全部日志，收集有 commit 记录的 txId；第二趟按日志顺序重放这些事务的 write 记录。顺序很重要——同一页被改过两次时，后写的必须赢。',
      'Recovery is two passes: first scan the whole log collecting txIds that have a commit record, then replay those transactions\' write records in log order. Order matters — when a page was written twice, the later write must win.'
    ),
    t(
      '事务里把 `{ pageId, data }` 攒在一个数组里，commit 时再依次 `disk.writePage`。rollback 就是把这个数组丢掉，什么都不用撤销。',
      'Buffer `{ pageId, data }` in an array inside the transaction and only `disk.writePage` them at commit. Rollback is just discarding the array; there is nothing to undo.'
    ),
  ],
  extension: t(
    [
      '这一关实现的是 **redo-only、no-steal、no-force** 的 WAL：',
      '',
      '- **no-steal**：没提交的改动不许落盘 → 不需要 undo；',
      '- **no-force**：提交时不强制把数据页落盘，只强制日志落盘 → 提交很快。',
      '',
      '真实系统大多是 **steal + no-force**，因为 no-steal 意味着一个大事务的所有脏页都得留在内存里，',
      '内存放不下就没法跑。代价是必须同时写 undo 和 redo，恢复也变成三个阶段：',
      '分析（找出崩溃瞬间哪些事务在跑）、redo（把所有改动重放到崩溃那一刻的状态）、',
      'undo（回滚那些没提交的）。这套算法叫 **ARIES**（Mohan et al., 1992），',
      '几乎所有关系数据库的恢复模块都是它的变体。',
      '',
      '还有两件事这里省了：**检查点**（定期把脏页刷盘并在日志里打个标记，',
      '否则恢复要从数据库诞生之日开始重放）和**日志校验和**（崩溃时最后一条记录很可能只写了一半，',
      '没有校验和就会把半条记录当成完整记录读进来）。',
    ].join('\n'),
    [
      'What you built is a redo-only, no-steal, no-force WAL:',
      '',
      '- no-steal: uncommitted changes never reach disk, so undo is never needed;',
      '- no-force: commit does not force data pages out, only the log, which makes commits fast.',
      '',
      'Real systems are usually steal plus no-force, because no-steal means every dirty page of a large',
      'transaction must stay in memory, and a transaction bigger than memory cannot run at all. The price',
      'is writing both undo and redo, and a three-phase recovery: analysis (which transactions were live',
      'at the crash), redo (replay everything up to the crash), undo (roll back the uncommitted ones).',
      'That algorithm is ARIES (Mohan et al., 1992), and essentially every relational database\'s recovery',
      'module is a variation of it.',
      '',
      'Two more omissions: checkpoints (periodically flushing dirty pages and marking the log, without',
      'which recovery replays from the beginning of time) and log checksums (the last record before a',
      'crash is very likely half-written, and without a checksum you read half a record as a whole one).',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'latency'],
  lab: {},
  starterFiles: [
    walCodec,
    file(
      'src/wal.ts',
      code`
        import { Disk } from './disk';

        export interface WalTransaction {
          id: number;
          /** 登记一次页修改。注意：此时不要写数据页 */
          write(pageId: number, data: Uint8Array): Promise<void>;
          commit(): Promise<void>;
          rollback(): Promise<void>;
        }

        export interface WalStore {
          begin(): WalTransaction;
          readPage(pageId: number): Promise<Uint8Array>;
          /** 重放日志里所有已提交的事务，返回重放的事务数 */
          recover(): Promise<number>;
        }

        export function createWalStore(disk: Disk): WalStore {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-4.spec.ts',
      code`
        import { createWalStore } from '../src/wal';
        import { Disk, PAGE_SIZE } from '../src/disk';
        import { count, getCounters } from '@lab/metrics';

        function bytes(fill: number): Uint8Array {
          const page = new Uint8Array(PAGE_SIZE);
          page.fill(fill);
          return page;
        }

        /** 先把页分配好并持久化，模拟一个已经存在的数据库文件 */
        async function preparedDisk(pageCount: number) {
          const disk = new Disk();
          const pages: number[] = [];
          for (let index = 0; index < pageCount; index += 1) {
            pages.push(await disk.allocatePage());
          }
          await disk.fsync();
          return { disk, pages };
        }

        describe('阶段4 · WAL 与崩溃恢复', () => {
          it('提交之后读得到', async () => {
            const { disk, pages } = await preparedDisk(1);
            const store = createWalStore(disk);

            const tx = store.begin();
            await tx.write(pages[0], bytes(1));
            await tx.commit();

            expect(Array.from(await store.readPage(pages[0]))).toEqual(Array.from(bytes(1)));
          });

          it('提交之后掉电，数据还在', async () => {
            const { disk, pages } = await preparedDisk(1);
            const store = createWalStore(disk);

            const tx = store.begin();
            await tx.write(pages[0], bytes(2));
            await tx.commit();

            disk.crash();
            const replayed = await store.recover();

            expect(replayed).toBe(1);
            expect(Array.from(await store.readPage(pages[0]))).toEqual(Array.from(bytes(2)));
          });

          it('没提交就掉电，改动不存在', async () => {
            const { disk, pages } = await preparedDisk(1);
            const store = createWalStore(disk);

            const tx = store.begin();
            await tx.write(pages[0], bytes(3));
            // 没有 commit
            disk.crash();
            const replayed = await store.recover();

            expect(replayed).toBe(0);
            expect(Array.from(await store.readPage(pages[0]))).toEqual(Array.from(new Uint8Array(PAGE_SIZE)));
          });

          it('rollback 之后改动不可见', async () => {
            const { disk, pages } = await preparedDisk(1);
            const store = createWalStore(disk);

            const tx = store.begin();
            await tx.write(pages[0], bytes(4));
            await tx.rollback();

            expect(Array.from(await store.readPage(pages[0]))).toEqual(Array.from(new Uint8Array(PAGE_SIZE)));
          });

          it('一个事务改多页，崩溃后要么全在要么全不在', async () => {
            const { disk, pages } = await preparedDisk(3);
            const store = createWalStore(disk);

            const tx = store.begin();
            await tx.write(pages[0], bytes(7));
            await tx.write(pages[1], bytes(8));
            await tx.write(pages[2], bytes(9));
            await tx.commit();

            disk.crash();
            await store.recover();

            expect(Array.from(await store.readPage(pages[0]))).toEqual(Array.from(bytes(7)));
            expect(Array.from(await store.readPage(pages[1]))).toEqual(Array.from(bytes(8)));
            expect(Array.from(await store.readPage(pages[2]))).toEqual(Array.from(bytes(9)));
          });

          it('未提交事务的页不会被别人的 fsync 带下去', async () => {
            const { disk, pages } = await preparedDisk(3);
            const store = createWalStore(disk);

            const committed = store.begin();
            await committed.write(pages[0], bytes(1));
            await committed.commit();

            // 这个事务永远不提交，它的改动一个字节都不该留在盘上
            const inFlight = store.begin();
            await inFlight.write(pages[2], bytes(66));

            // 另一个事务提交时会 fsync；如果 inFlight 的页已经写进了页缓存，
            // 这一次 fsync 会把它一起刷成持久的
            const later = store.begin();
            await later.write(pages[1], bytes(3));
            await later.commit();

            disk.crash();
            await store.recover();

            expect(Array.from(await store.readPage(pages[0]))).toEqual(Array.from(bytes(1)));
            expect(Array.from(await store.readPage(pages[1]))).toEqual(Array.from(bytes(3)));
            expect(Array.from(await store.readPage(pages[2]))).toEqual(Array.from(new Uint8Array(PAGE_SIZE)));
          });

          it('同一页被多个事务改过，重放后是最后提交的那个', async () => {
            const { disk, pages } = await preparedDisk(1);
            const store = createWalStore(disk);

            for (const fill of [1, 2, 3]) {
              const tx = store.begin();
              await tx.write(pages[0], bytes(fill));
              await tx.commit();
            }

            disk.crash();
            const replayed = await store.recover();

            expect(replayed).toBe(3);
            expect(Array.from(await store.readPage(pages[0]))).toEqual(Array.from(bytes(3)));
          });

          it('recover 之后日志被清空，再调用返回 0', async () => {
            const { disk, pages } = await preparedDisk(1);
            const store = createWalStore(disk);

            const tx = store.begin();
            await tx.write(pages[0], bytes(5));
            await tx.commit();

            disk.crash();
            expect(await store.recover()).toBe(1);
            expect(await store.recover()).toBe(0);
            expect(Array.from(await store.readPage(pages[0]))).toEqual(Array.from(bytes(5)));
          });

          it('空日志上恢复不出错', async () => {
            const { disk } = await preparedDisk(1);
            const store = createWalStore(disk);
            expect(await store.recover()).toBe(0);
          });

          it('事务号互不相同', async () => {
            const { disk } = await preparedDisk(1);
            const store = createWalStore(disk);
            const a = store.begin();
            const b = store.begin();
            expect(a.id).not.toBe(b.id);
          });

          it('write 时不写数据页', async () => {
            const { disk, pages } = await preparedDisk(1);
            const store = createWalStore(disk);

            const tx = store.begin();
            const before = getCounters()['diskWrites'] || 0;
            await tx.write(pages[0], bytes(1));
            const after = getCounters()['diskWrites'] || 0;

            expect(after).toBe(before);
          });

          it('一个事务只 fsync 一次 [gate:commit]', async () => {
            const { disk, pages } = await preparedDisk(5);
            const store = createWalStore(disk);

            const tx = store.begin();
            for (let index = 0; index < 5; index += 1) {
              await tx.write(pages[index], bytes(index + 1));
            }

            const before = getCounters()['diskFsync'] || 0;
            await tx.commit();
            const used = (getCounters()['diskFsync'] || 0) - before;
            count('commitFsyncs', used);

            expect(used).toBeLessThanOrEqual(2);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.commitFsyncs',
      op: 'lte',
      value: 2,
      unit: 'fsync',
      zh: '改 5 页的事务提交时最多 fsync 2 次',
      en: 'Committing a five-page transaction costs at most two fsyncs',
      dimension: 'latency',
      scope: 'gate:commit',
    }),
  ],
  referenceFiles: [
    file(
      'src/wal.ts',
      code`
        import type { LogRecord } from './contract';
        import { Disk } from './disk';
        import { decodeLogRecord, encodeLogRecord } from './wal-codec';

        export interface WalTransaction {
          id: number;
          write(pageId: number, data: Uint8Array): Promise<void>;
          commit(): Promise<void>;
          rollback(): Promise<void>;
        }

        export interface WalStore {
          begin(): WalTransaction;
          readPage(pageId: number): Promise<Uint8Array>;
          recover(): Promise<number>;
        }

        interface BufferedWrite {
          pageId: number;
          data: Uint8Array;
        }

        export function createWalStore(disk: Disk): WalStore {
          let nextTxId = 1;

          return {
            begin(): WalTransaction {
              const id = nextTxId;
              nextTxId += 1;

              // 改动先攒在这里，提交之前一个字节都不落盘（no-steal）。
              // 这样别的事务 fsync 时不会顺手把它刷下去，恢复也就只需要 redo。
              const buffered: BufferedWrite[] = [];
              let settled = false;

              disk.appendLog(encodeLogRecord({ txId: id, type: 'begin' }));

              return {
                id,

                async write(pageId: number, data: Uint8Array): Promise<void> {
                  if (settled) throw new Error('transaction ' + id + ' has already finished');
                  const copy = data.slice();
                  buffered.push({ pageId, data: copy });
                  disk.appendLog(
                    encodeLogRecord({ txId: id, type: 'write', pageId, after: Array.from(copy) })
                  );
                },

                async commit(): Promise<void> {
                  if (settled) throw new Error('transaction ' + id + ' has already finished');
                  settled = true;

                  disk.appendLog(encodeLogRecord({ txId: id, type: 'commit' }));
                  // write-ahead：日志先落盘，整个事务只用这一次 fsync。
                  // 这一行返回之后事务就算提交成功了，哪怕数据页一页都还没写。
                  await disk.fsync();

                  // 数据页可以慢慢来：它们即使丢了，日志里也还记着该改成什么
                  for (const entry of buffered) {
                    await disk.writePage(entry.pageId, entry.data);
                  }
                },

                async rollback(): Promise<void> {
                  settled = true;
                  // 日志里没有 commit 记录，恢复时这个事务会被跳过，
                  // 数据页从来没被碰过，所以没有任何东西需要撤销
                  buffered.length = 0;
                },
              };
            },

            async readPage(pageId: number): Promise<Uint8Array> {
              return disk.readPage(pageId);
            },

            async recover(): Promise<number> {
              const records: LogRecord[] = disk.readLog().map(decodeLogRecord);

              // 第一趟：哪些事务真的提交了。崩溃瞬间正在跑的事务同样留下了 write 记录，
              // 不先筛一遍就会把没提交的改动一起重放进去。
              const committed = new Set<number>();
              for (const record of records) {
                if (record.type === 'commit') committed.add(record.txId);
              }

              // 第二趟：按日志顺序重放。顺序不能乱——同一页被改过两次时后写的必须赢。
              let replayed = 0;
              for (const record of records) {
                if (!committed.has(record.txId)) continue;
                if (record.type === 'write' && record.pageId !== undefined && record.after) {
                  await disk.writePage(record.pageId, new Uint8Array(record.after));
                } else if (record.type === 'commit') {
                  replayed += 1;
                }
              }

              await disk.fsync();
              // 重放过的日志没用了。真实系统在这里打检查点，而不是直接丢。
              disk.truncateLog();
              return replayed;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**为什么 `write` 只登记不落盘。** 这是整关唯一真正的设计决定。一旦在 `write` 里调用',
      '`disk.writePage`，这一页就进了操作系统的页缓存，而页缓存是**全局**的：',
      '任何别的事务提交时的 fsync 都会把它一起刷成持久的。于是一个从未提交的事务把数据留在了盘上，',
      '而日志里没有它的 commit 记录，恢复时也就没人负责撤销它。',
      '要么攒到提交再写（no-steal，本关的做法），要么老老实实实现 undo 日志，没有第三条路。',
      '',
      '**为什么 fsync 在 commit 记录之后、数据页之前。** 顺序就是「write-ahead」这个名字的全部含义。',
      'fsync 返回的那一刻，日志里已经完整记着这个事务要做什么，于是它可以对外宣称提交成功了；',
      '数据页什么时候写下去都行，反正丢了还能从日志重放。反过来先写数据页，就会出现',
      '「页改了一半、日志还没记」的状态，那是恢复不了的。',
      '',
      '**为什么恢复要扫两趟。** 崩溃时正在跑的事务也在日志里留下了 write 记录，',
      '它们和已提交事务的记录交错在一起。不先扫一遍收集 commit 记录，就分不清哪些该重放。',
      '第二趟必须按日志原始顺序走，否则同一页的多次修改会以错误的顺序落地。',
    ].join('\n'),
    [
      'Why `write` only records and never writes. This is the one real design decision in the stage. The',
      'moment `write` calls `disk.writePage`, that page sits in the OS page cache — and the page cache is',
      'global: any other transaction\'s commit fsync makes it durable. A transaction that never committed',
      'has now left data on disk, and since the log holds no commit record for it, nothing takes',
      'responsibility for undoing it. Either buffer until commit (no-steal, what this does) or write a',
      'real undo log. There is no third option.',
      '',
      'Why the fsync sits after the commit record and before the data pages. That order is the entire',
      'meaning of "write-ahead". When fsync returns, the log fully describes what the transaction does, so',
      'the transaction can be declared committed; the data pages can land whenever, because losing them',
      'only costs a replay. Do it the other way and you get "page half-changed, log knows nothing", which',
      'is exactly the state that cannot be recovered.',
      '',
      'Why recovery makes two passes. Transactions that were in flight at the crash also left `write`',
      'records, interleaved with the committed ones. Without a first pass collecting commit records there',
      'is no way to tell which to replay. The second pass must follow original log order, or repeated',
      'writes to one page land in the wrong sequence.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

module.exports = {
  id: 'minimal-database',
  title: t('从零实现一个最小数据库', 'Build a minimal database from scratch'),
  summary: t(
    '从页式存储和缓冲池开始，一路做到记录编解码、B+Tree 索引和 WAL 崩溃恢复。',
    'Start at paged storage and a buffer pool, then build record encoding, a B+Tree index and WAL crash recovery.'
  ),
  difficulty: 'Hard',
  domain: 'storage',
  tags: ['database', 'storage-engine', 'b-tree', 'wal', 'binary-encoding'],
  estimatedMinutes: 150,
  language: 'typescript',
  weights: {
    correctness: 3,
    concurrency: 0,
    latency: 1.5,
    resilience: 2,
    encapsulation: 2,
    elegance: 1.5,
  },
  prerequisites: [
    t('会用 Uint8Array / DataView 读写二进制', 'Comfortable reading and writing binary with Uint8Array / DataView'),
    t('知道二叉查找树是什么（B+Tree 那一关会从头讲）', 'Know what a binary search tree is (the B+Tree stage starts from scratch)'),
  ],
  learningOutcomes: [
    t(
      '说清数据库为什么以「页」为单位读写，以及缓冲池凭什么能把 IO 降一个数量级',
      'Explain why a database reads and writes in pages, and how a buffer pool cuts IO by an order of magnitude'
    ),
    t(
      '自己设计一个页内布局，并解释 slot 目录为什么比定长数组更适合变长记录',
      'Design a page layout yourself, and explain why a slot directory beats a fixed-size array for variable-length records'
    ),
    t(
      '手写一棵会分裂的 B+Tree，并用「读了几页」证明它确实是对数级的',
      'Write a splitting B+Tree by hand, and prove it is logarithmic by counting pages read'
    ),
    t(
      '解释 WAL 为什么必须先写日志再写数据页，以及崩溃后靠什么把数据库拉回一致状态',
      'Explain why WAL must reach the log before the data page, and what pulls the database back to a consistent state after a crash'
    ),
  ],
  brief: t(
    [
      '## 背景',
      '',
      '「数据库」听起来像个不可拆的黑盒。但把它切开，最小的那个能用的核只有四层，',
      '而且每一层都在回答一个很具体的问题：',
      '',
      '| 层 | 回答的问题 |',
      '| --- | --- |',
      '| 页与缓冲池 | 数据在磁盘上怎么组织，怎么少读盘 |',
      '| 记录与页内布局 | 一行数据怎么变成字节，怎么塞进一页里 |',
      '| B+Tree 索引 | 一千行里找一行，怎么不扫全表 |',
      '| WAL 与崩溃恢复 | 写到一半掉电，怎么保证不出现半个事务 |',
      '',
      '这四层就是这道题的四关。做完之后你手上会有一个能 insert、能按主键查、',
      '能范围扫描、掉电重启后数据还在的存储引擎。',
      '',
      '## 平台提供什么',
      '',
      '`src/disk.ts` 是一块模拟磁盘，只读，你不能改它。它刻意保留了真实磁盘的三个特性：',
      '',
      '```ts',
      'await disk.writePage(id, bytes);  // 只进了操作系统的页缓存',
      'await disk.fsync();               // 到这一步才真正持久',
      'disk.crash();                     // 没 fsync 的写入全部消失',
      '```',
      '',
      '每次读、写、fsync 都会计数，所以「你的实现读了几次盘」是能被量出来的，',
      '几关的工程门槛量的正是它。',
      '',
      '## 硬性约束',
      '',
      '1. 一页固定 128 字节，不能读写半页；',
      '2. `writePage` 之后、`fsync` 之前发生 crash，那次写入就是丢了——这不是 bug，是题设；',
      '3. 索引查找必须是对数级的：读盘次数随数据量增长，但增长得比线性慢得多；',
      '4. 已提交的事务在崩溃后必须还在，没提交的必须消失。',
      '',
      '## 非目标',
      '',
      '- 不做 SQL 解析，接口是函数调用，不是字符串；',
      '- 不做并发控制（没有锁、没有 MVCC），全程单线程；',
      '- 不做删除后的页回收与 B+Tree 合并——真实系统里这块的复杂度不亚于插入，',
      '  但它不改变你对存储引擎的整体理解。',
      '',
      '## 术语',
      '',
      '- **页（page）**：磁盘 IO 的最小单位。',
      '- **缓冲池（buffer pool）**：页在内存里的缓存，数据库里最重要的那块内存。',
      '- **脏页（dirty page）**：在内存里被改过、还没写回磁盘的页。',
      '- **slot 目录**：页尾的一张小表，记录每条记录在页内的偏移和长度。',
      '- **WAL**：write-ahead log，先写日志再写数据页。',
    ].join('\n'),
    [
      '## Context',
      '',
      '"A database" sounds like an indivisible black box. Cut it open and the smallest working core is',
      'four layers, each answering one very concrete question:',
      '',
      '| Layer | Question it answers |',
      '| --- | --- |',
      '| Pages and buffer pool | How is data laid out on disk, and how do we read less of it |',
      '| Records and page layout | How does a row become bytes, and how does it fit in a page |',
      '| B+Tree index | How do we find one row among a thousand without scanning them all |',
      '| WAL and recovery | Power is cut mid-write; how do we avoid half a transaction |',
      '',
      'Those four layers are the four stages. At the end you have a storage engine that inserts, looks',
      'up by primary key, scans ranges, and still has your data after the power goes out.',
      '',
      '## What the platform gives you',
      '',
      '`src/disk.ts` is a simulated disk. It is read-only and keeps three real-disk behaviours:',
      '',
      '```ts',
      'await disk.writePage(id, bytes);  // only reached the OS page cache',
      'await disk.fsync();               // now it is durable',
      'disk.crash();                     // everything not fsynced is gone',
      '```',
      '',
      'Every read, write and fsync is counted, so "how many times did your implementation touch the',
      'disk" is measurable — and that is exactly what several stage gates measure.',
      '',
      '## Hard constraints',
      '',
      '1. A page is exactly 128 bytes; there is no such thing as half a page;',
      '2. A crash between `writePage` and `fsync` loses that write. That is the premise, not a bug;',
      '3. Index lookups must be logarithmic: disk reads grow with the data, but far slower than linearly;',
      '4. Committed transactions must survive a crash, uncommitted ones must not.',
      '',
      '## Non-goals',
      '',
      '- No SQL parsing; the interface is function calls, not strings;',
      '- No concurrency control (no locks, no MVCC), everything is single-threaded;',
      '- No page reclamation or B+Tree merging after deletes — in a real engine that is as hard as',
      '  insertion, but it does not change your mental model of a storage engine.',
      '',
      '## Glossary',
      '',
      '- Page: the smallest unit of disk IO.',
      '- Buffer pool: the in-memory cache of pages, the most important memory in a database.',
      '- Dirty page: changed in memory, not yet written back.',
      '- Slot directory: a small table at the end of a page recording each record\'s offset and length.',
      '- WAL: write-ahead log, the log reaches disk before the data page does.',
    ].join('\n')
  ),
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  C[caller] --> T[BTree index]',
      '  C --> H[Heap / slotted pages]',
      '  T --> P[Pager buffer pool]',
      '  H --> P',
      '  W[WAL] --> D[(Disk)]',
      '  P -- dirty page --> D',
      '  P -. must log first .-> W',
      '  D -- crash --> R[recover replays committed txns]',
      '```',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  C[caller] --> T[BTree index]',
      '  C --> H[Heap / slotted pages]',
      '  T --> P[Pager buffer pool]',
      '  H --> P',
      '  W[WAL] --> D[(Disk)]',
      '  P -- dirty page --> D',
      '  P -. must log first .-> W',
      '  D -- crash --> R[recover replays committed txns]',
      '```',
    ].join('\n')
  ),
  files: [contract, disk],
  stages: [stage1, stage2, stage3, stage4],
};
