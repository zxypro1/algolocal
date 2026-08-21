/**
 * 工程实战 · 从零实现一个数据库引擎
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
/* 第 3 关 · 堆文件与表扫描                                             */
/* ------------------------------------------------------------------ */

const stage3 = {
  id: 'heap-file',
  title: t('第 3 关 · 堆文件与表扫描', 'Stage 3 · Heap file and table scan'),
  goal: t(
    [
      '一页 128 字节，装五六行就满了。一张表显然不止一页——**堆文件**就是「一张表 = 一串页」这件事。',
      '',
      '在 `src/heap.ts` 实现 `createHeapFile(pager, pageIds?)`：',
      '',
      '- `insert(row)`：找一页放得下的把它放进去，都放不下就新分配一页，返回 `{ pageId, slotId }`；',
      '- `read(slot)` / `remove(slot)`：按位置读和删，删掉的读出来是 `null`；',
      '- `scan()`：返回一个游标，`next()` 一次吐一行，吐完返回 `null`；',
      '- `pages()`：这张表占了哪些页，重新打开时要靠它。',
      '',
      '游标是这道题后面所有查询算子的原型：**一次一行，按需拉取**。',
      '返回数组的写法在这里也能过用例，但到第 10 关会撞墙——',
      '`LIMIT 1` 不该把一百万行全读进内存。',
      '',
      '扫描时**每页只能读一次**。为每一行都去 `pager.readPage` 一遍，逻辑同样正确，',
      '缓冲池也会替你挡掉大部分开销，但缓冲池一小就原形毕露：这一关的门槛量的就是它。',
    ].join('\n'),
    [
      'A 128-byte page holds five or six rows. A table is obviously more than one page — a heap file is',
      'exactly the idea that "a table is a list of pages".',
      '',
      'Implement `createHeapFile(pager, pageIds?)` in `src/heap.ts`:',
      '',
      '- `insert(row)`: find a page it fits in, allocate a new one if none does, return `{ pageId, slotId }`;',
      '- `read(slot)` / `remove(slot)`: read and delete by position; a removed row reads back as `null`;',
      '- `scan()`: return a cursor whose `next()` yields one row at a time and `null` at the end;',
      '- `pages()`: which pages this table occupies, needed to reopen it.',
      '',
      'The cursor is the prototype for every query operator later in this project: one row at a time,',
      'pulled on demand. Returning an array passes these specs too, but it hits a wall in stage 10 —',
      '`LIMIT 1` should not read a million rows into memory first.',
      '',
      'A scan must read each page exactly once. Calling `pager.readPage` per row is equally correct and',
      'the buffer pool hides most of the cost — until the pool is small, which is precisely what this',
      "stage's gate measures.",
    ].join('\n')
  ),
  checklist: [
    t('插入跨多页，放不下就新开一页', 'Inserts span pages, allocating a new one when needed'),
    t('read / remove 按 (pageId, slotId) 定位', 'read and remove address rows by (pageId, slotId)'),
    t('scan 游标一次吐一行，删掉的行不出现', 'The scan cursor yields one row at a time and skips removed rows'),
    t('用 pages() 重新打开，数据还在', 'Reopening with pages() finds the data'),
    t('全表扫描每页只读一次', 'A full scan reads each page exactly once'),
  ],
  pitfalls: [
    t(
      '每读一行就 `pager.readPage` 一次。缓冲池会把它变成命中，所以本地测起来完全正常；等到表比缓冲池大，同一页会被反复换进换出，一次扫描的读盘次数从「页数」变成「行数」。',
      'Calling `pager.readPage` once per row. The buffer pool turns those into hits, so it looks fine locally; once the table outgrows the pool the same page is swapped in and out repeatedly and a scan costs one read per row instead of per page.'
    ),
    t(
      '扫描时跳过墓碑用 `liveCount()` 当循环上界。墓碑仍然占着 slot 编号，`liveCount` 比 `slotCount` 小，于是尾部的行永远扫不到。上界必须是 `slotCount()`，逐个判断是不是 `null`。',
      'Using `liveCount()` as the loop bound when skipping tombstones. Tombstones still occupy slot ids, so `liveCount` is smaller than `slotCount` and the last rows are never visited. The bound must be `slotCount()`, checking each slot for `null`.'
    ),
    t(
      '插入时忘了把改过的页写回 pager。`loadSlottedPage` 拿到的是一份副本，往副本里 insert 之后不 `writePage`，这一行只存在于那个临时对象里——函数返回、对象被回收，数据就没了，而且返回的 slot 还是个看起来很正常的编号。',
      'Forgetting to write the modified page back through the pager. `loadSlottedPage` gives you a copy; inserting into the copy without `writePage` leaves the row inside a temporary object that is collected on return — while you hand back a perfectly normal-looking slot.'
    ),
    t(
      '新分配页之后忘了把它加进 `pages()` 的列表。当前这个进程里一切正常，因为你还握着页号；重新打开表时那一页不在列表里，最后插入的那批数据凭空消失。',
      'Allocating a page without appending it to the `pages()` list. Everything works in the current process because you still hold the id; reopening the table omits that page and the most recently inserted rows are simply gone.'
    ),
  ],
  hints: [
    t(
      '最简单的可用策略：只往最后一页插，插不下就新开一页。真实引擎会维护一张空闲空间表（FSM）来复用中间页的空洞，那是这一关之外的优化。',
      'The simplest workable policy: always insert into the last page, allocating a new one when it does not fit. Real engines keep a free-space map to reuse holes in earlier pages, which is an optimisation beyond this stage.'
    ),
    t(
      '游标把「当前第几页、当前第几个 slot、当前页对象」三个状态存在闭包里，`next()` 只在跨页时才 `readPage`。',
      'Keep three pieces of state in the cursor\'s closure — current page index, current slot, the loaded page — and only call `readPage` when moving to a new page.'
    ),
  ],
  extension: t(
    [
      '「堆」这个名字的意思是**无序**：行按插入顺序堆在页里，没有任何排序保证。',
      'PostgreSQL 的表就是堆文件，所以 `SELECT * FROM t` 的返回顺序是实现细节，不是承诺。',
      'MySQL InnoDB 不一样，它的表本身就是一棵按主键组织的 B+Tree（聚簇索引），',
      '所以 InnoDB 里「表扫描」和「主键索引扫描」是同一件事，而 PostgreSQL 里是两件。',
      '',
      '这一关的插入策略是「只往最后一页塞」，删除留下的空洞永远不会被复用。',
      '真实引擎为此维护一张**空闲空间图**（PostgreSQL 叫 FSM，是一棵存在磁盘上的树），',
      '插入前先查它找一页装得下的。没有 FSM 的话，反复插入删除会让表无限膨胀。',
      '',
      '还有一件事这一关没做：`remove` 之后 `(pageId, slotId)` 这个地址就作废了，',
      '但索引里可能还存着它。PostgreSQL 的解法是索引项也留着，扫到之后再去堆里核对可见性',
      '（这就是为什么它需要 visibility map 和 VACUUM）；InnoDB 则因为二级索引存的是主键而不是物理地址，',
      '天然绕开了这个问题——代价是二级索引查询要多走一次主键树，叫「回表」。',
    ].join('\n'),
    [
      '"Heap" means unordered: rows pile into pages in insertion order with no sort guarantee.',
      "PostgreSQL's tables are heap files, which is why the order `SELECT * FROM t` returns is an",
      'implementation detail rather than a promise. MySQL InnoDB differs: its table *is* a B+Tree keyed by',
      'the primary key (a clustered index), so "table scan" and "primary key scan" are the same thing',
      'there and two different things in PostgreSQL.',
      '',
      'The insert policy here always appends to the last page, so holes left by deletion are never reused.',
      'Real engines keep a free-space map for this (PostgreSQL calls it the FSM and stores it as a tree on',
      'disk) and consult it before inserting. Without one, repeated insert/delete churn grows the table',
      'without bound.',
      '',
      'One more thing left out: after `remove`, the address `(pageId, slotId)` is dead while an index may',
      'still hold it. PostgreSQL keeps the index entry and rechecks visibility in the heap after following',
      'it — which is why it needs a visibility map and VACUUM. InnoDB sidesteps this because its secondary',
      'indexes store the primary key rather than a physical address, at the cost of a second tree descent',
      'per lookup, known as the bookmark lookup.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/heap.ts',
      code`
        import type { Pager, Row, Slot } from './contract';

        export interface HeapEntry {
          slot: Slot;
          row: Row;
        }

        /** 一次一行的游标。后面所有查询算子都是这个形状 */
        export interface HeapCursor {
          next(): Promise<HeapEntry | null>;
        }

        export interface HeapFile {
          insert(row: Row): Promise<Slot>;
          read(slot: Slot): Promise<Row | null>;
          remove(slot: Slot): Promise<boolean>;
          scan(): HeapCursor;
          /** 这张表占用的页，按顺序 */
          pages(): number[];
        }

        /** 不传 pageIds 建一张新表，传了则打开已有的表 */
        export function createHeapFile(pager: Pager, pageIds?: number[]): Promise<HeapFile> {
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
        import { createHeapFile } from '../src/heap';
        import { createPager } from '../src/pager';
        import { Disk } from '../src/disk';
        import { count, getCounters } from '@lab/metrics';

        function row(id: number, name: string, active = 1) {
          return { id, name, active };
        }

        async function freshHeap(capacity = 32) {
          const disk = new Disk();
          const pager = createPager(disk, { capacity });
          const heap = await createHeapFile(pager);
          return { disk, pager, heap };
        }

        async function drain(heap: { scan(): { next(): Promise<any> } }) {
          const cursor = heap.scan();
          const rows: any[] = [];
          let entry = await cursor.next();
          while (entry) {
            rows.push(entry);
            entry = await cursor.next();
          }
          return rows;
        }

        describe('阶段3 · 堆文件与表扫描', () => {
          it('插入后能按 slot 读回来', async () => {
            const { heap } = await freshHeap();
            const slot = await heap.insert(row(1, 'alice'));
            expect(await heap.read(slot)).toEqual(row(1, 'alice'));
          });

          it('插入很多行会跨页', async () => {
            const { heap } = await freshHeap();
            for (let index = 0; index < 40; index += 1) {
              await heap.insert(row(index, 'user' + index));
            }
            // 一页 128 字节装不下 40 行
            expect(heap.pages().length).toBeGreaterThan(1);
          });

          it('跨页之后每一行都还读得到', async () => {
            const { heap } = await freshHeap();
            const slots: any[] = [];
            for (let index = 0; index < 40; index += 1) {
              slots.push(await heap.insert(row(index, 'user' + index)));
            }
            for (let index = 0; index < 40; index += 1) {
              expect(await heap.read(slots[index])).toEqual(row(index, 'user' + index));
            }
          });

          it('读不存在的位置返回 null', async () => {
            const { heap } = await freshHeap();
            await heap.insert(row(1, 'a'));
            expect(await heap.read({ pageId: 999, slotId: 0 })).toBeNull();
            expect(await heap.read({ pageId: heap.pages()[0], slotId: 99 })).toBeNull();
          });

          it('删除之后读不到', async () => {
            const { heap } = await freshHeap();
            const slot = await heap.insert(row(1, 'a'));
            expect(await heap.remove(slot)).toBe(true);
            expect(await heap.read(slot)).toBeNull();
            expect(await heap.remove(slot)).toBe(false);
          });

          it('scan 吐出全部行', async () => {
            const { heap } = await freshHeap();
            for (let index = 0; index < 25; index += 1) {
              await heap.insert(row(index, 'u' + index));
            }
            const found = await drain(heap);
            expect(found).toHaveLength(25);
            expect(found.map((entry) => entry.row.id).sort((a, b) => a - b)).toEqual(
              Array.from({ length: 25 }, (_unused, index) => index)
            );
          });

          it('scan 跳过删掉的行，包括页尾的那些', async () => {
            const { heap } = await freshHeap();
            const slots: any[] = [];
            for (let index = 0; index < 12; index += 1) {
              slots.push(await heap.insert(row(index, 'u' + index)));
            }
            // 删掉第一个和最后一个：用 liveCount 当循环上界的实现会漏掉尾部
            await heap.remove(slots[0]);
            await heap.remove(slots[slots.length - 1]);

            const found = await drain(heap);
            expect(found).toHaveLength(10);
            const ids = found.map((entry) => entry.row.id);
            expect(ids).not.toContain(0);
            expect(ids).not.toContain(11);
            expect(ids).toContain(5);
          });

          it('空表 scan 立刻返回 null', async () => {
            const { heap } = await freshHeap();
            const cursor = heap.scan();
            expect(await cursor.next()).toBeNull();
          });

          it('scan 给出的 slot 能直接拿去 read', async () => {
            const { heap } = await freshHeap();
            for (let index = 0; index < 8; index += 1) await heap.insert(row(index, 'u' + index));

            const found = await drain(heap);
            for (const entry of found) {
              expect(await heap.read(entry.slot)).toEqual(entry.row);
            }
          });

          it('flush 之后用 pages() 重新打开，数据还在', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 32 });
            const heap = await createHeapFile(pager);
            for (let index = 0; index < 30; index += 1) {
              await heap.insert(row(index, 'u' + index));
            }
            const pageIds = heap.pages();
            await pager.flush();

            const reopened = await createHeapFile(createPager(disk, { capacity: 32 }), pageIds);
            const found = await drain(reopened);
            expect(found).toHaveLength(30);
          });

          it('重新打开之后还能继续插入', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 32 });
            const heap = await createHeapFile(pager);
            await heap.insert(row(1, 'first'));
            const pageIds = heap.pages();
            await pager.flush();

            const reopened = await createHeapFile(createPager(disk, { capacity: 32 }), pageIds);
            const slot = await reopened.insert(row(2, 'second'));
            expect(await reopened.read(slot)).toEqual(row(2, 'second'));
            expect(await drain(reopened)).toHaveLength(2);
          });

          it('全表扫描每页只读一次 [gate:scan]', async () => {
            const disk = new Disk();
            const warm = createPager(disk, { capacity: 64 });
            const heap = await createHeapFile(warm);
            for (let index = 0; index < 40; index += 1) {
              await heap.insert(row(index, 'user' + index));
            }
            const pageIds = heap.pages();
            await warm.flush();

            // capacity 1 = 没有缓存，每次 readPage 都是一次真实读盘
            const cold = createPager(disk, { capacity: 1 });
            const reopened = await createHeapFile(cold, pageIds);

            const before = getCounters()['diskReads'] || 0;
            const found = await drain(reopened);
            const reads = (getCounters()['diskReads'] || 0) - before;
            count('scanPageReads', reads);

            expect(found).toHaveLength(40);
            // 逐行 readPage 的实现在这里是 40 次；每页读一次是 pageIds.length 次
            expect(reads).toBeLessThanOrEqual(pageIds.length + 1);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.scanPageReads',
      op: 'lte',
      value: 12,
      unit: 'pages',
      zh: '扫描 40 行只读页数那么多次盘',
      en: 'Scanning 40 rows costs one disk read per page',
      dimension: 'latency',
      scope: 'gate:scan',
    }),
  ],
  referenceFiles: [
    file(
      'src/heap.ts',
      code`
        import type { Pager, Row, Slot } from './contract';
        import { decodeRow, encodeRow } from './record';
        import { createSlottedPage, loadSlottedPage, SlottedPage } from './page';

        export interface HeapEntry {
          slot: Slot;
          row: Row;
        }

        export interface HeapCursor {
          next(): Promise<HeapEntry | null>;
        }

        export interface HeapFile {
          insert(row: Row): Promise<Slot>;
          read(slot: Slot): Promise<Row | null>;
          remove(slot: Slot): Promise<boolean>;
          scan(): HeapCursor;
          pages(): number[];
        }

        export async function createHeapFile(pager: Pager, pageIds?: number[]): Promise<HeapFile> {
          const pageList: number[] = pageIds ? pageIds.slice() : [];
          if (pageList.length === 0) {
            const first = await pager.allocatePage();
            await pager.writePage(first, createSlottedPage().toBytes());
            pageList.push(first);
          }

          async function loadPage(pageId: number): Promise<SlottedPage> {
            return loadSlottedPage(await pager.readPage(pageId));
          }

          function owns(pageId: number): boolean {
            return pageList.indexOf(pageId) !== -1;
          }

          return {
            async insert(row: Row): Promise<Slot> {
              const bytes = encodeRow(row);

              // 只往最后一页塞。真实引擎会查空闲空间图去复用前面页里的空洞，
              // 那是另一个话题；这里的重点是「一张表 = 一串页」。
              let pageId = pageList[pageList.length - 1];
              let page = await loadPage(pageId);
              let slotId = page.insert(bytes);

              if (slotId === null) {
                pageId = await pager.allocatePage();
                pageList.push(pageId);
                page = createSlottedPage();
                slotId = page.insert(bytes);
                if (slotId === null) {
                  throw new Error('row does not fit in an empty page: ' + bytes.length + ' bytes');
                }
              }

              // 改的是副本，必须写回去，否则这一行只活在这个临时对象里
              await pager.writePage(pageId, page.toBytes());
              return { pageId, slotId };
            },

            async read(slot: Slot): Promise<Row | null> {
              if (!owns(slot.pageId)) return null;
              const page = await loadPage(slot.pageId);
              const bytes = page.read(slot.slotId);
              return bytes ? decodeRow(bytes) : null;
            },

            async remove(slot: Slot): Promise<boolean> {
              if (!owns(slot.pageId)) return false;
              const page = await loadPage(slot.pageId);
              if (!page.remove(slot.slotId)) return false;
              await pager.writePage(slot.pageId, page.toBytes());
              return true;
            },

            scan(): HeapCursor {
              let pageIndex = 0;
              let slotId = 0;
              let page: SlottedPage | null = null;

              return {
                async next(): Promise<HeapEntry | null> {
                  while (pageIndex < pageList.length) {
                    // 只在跨页时读一次盘，页内的行全部从同一个对象里取
                    if (!page) page = await loadPage(pageList[pageIndex]);

                    // 上界必须是 slotCount：墓碑仍然占着编号，
                    // 用 liveCount 会让页尾的行永远扫不到
                    while (slotId < page.slotCount()) {
                      const bytes = page.read(slotId);
                      const slot: Slot = { pageId: pageList[pageIndex], slotId };
                      slotId += 1;
                      if (bytes) return { slot, row: decodeRow(bytes) };
                    }

                    pageIndex += 1;
                    slotId = 0;
                    page = null;
                  }
                  return null;
                },
              };
            },

            pages(): number[] {
              return pageList.slice();
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**游标为什么是 `next()` 而不是返回数组。** 这一关看不出差别，第 10 关看得出：',
      '`SELECT ... LIMIT 1` 在游标模型里只拉一行就停，在数组模型里得先把整张表读进内存。',
      '火山模型的全部价值就在这个「按需」上，所以这里提前把形状定下来。',
      '',
      '**为什么扫描要把页对象存在闭包里。** 一页装五六行，逐行 `readPage` 就是逐行进一次缓冲池。',
      '缓冲池够大时它们全是命中，看不出问题；缓冲池一小，同一页被反复换进换出，',
      '一次扫描的读盘次数从「页数」变成「行数」。把当前页留在游标里，跨页时才读，',
      '这个差别在门槛上是 7 次和 40 次。',
      '',
      '**为什么循环上界是 `slotCount()` 而不是 `liveCount()`。** 墓碑不回收编号，',
      '`liveCount` 只是活着的行数。拿它当上界，删掉一行就少扫一行，而少掉的永远是页尾那些。',
    ].join('\n'),
    [
      'Why the cursor is `next()` rather than an array. The difference is invisible here and obvious in',
      'stage 10: `SELECT ... LIMIT 1` pulls one row and stops under a cursor, while an array forces the',
      'whole table into memory first. On-demand pulling is the entire value of the Volcano model, so the',
      'shape is fixed here in advance.',
      '',
      'Why the scan keeps the page object in its closure. A page holds five or six rows, so reading per',
      'row means entering the buffer pool per row. With a large pool those are all hits and nothing looks',
      'wrong; with a small one the same page is swapped in and out and a scan costs one read per row',
      'instead of per page. On this stage\'s gate that is 7 reads versus 40.',
      '',
      'Why the loop bound is `slotCount()` and not `liveCount()`. Tombstones keep their slot ids, so',
      '`liveCount` is only the number of living rows. Using it as a bound drops one row from the scan for',
      'every row deleted — and the ones dropped are always at the end of the page.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 4 关 · B+Tree 索引                                                */
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

const stage4 = {
  id: 'btree',
  title: t('第 4 关 · B+Tree 索引', 'Stage 4 · B+Tree index'),
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
      'specs/stage-4.spec.ts',
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

        describe('阶段4 · B+Tree 索引', () => {
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
/* 第 5 关 · WAL 与崩溃恢复                                             */
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

const stage5 = {
  id: 'wal',
  title: t('第 5 关 · WAL 与崩溃恢复', 'Stage 5 · WAL and crash recovery'),
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
      'specs/stage-5.spec.ts',
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

        describe('阶段5 · WAL 与崩溃恢复', () => {
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
/* 第 6 关 · 两阶段锁与死锁检测                                          */
/* ------------------------------------------------------------------ */

const stage6 = {
  id: 'lock-manager',
  title: t('第 6 关 · 两阶段锁与死锁检测', 'Stage 6 · Two-phase locking and deadlock detection'),
  goal: t(
    [
      '到这里为止，数据库一次只服务一个人。真实负载是几百个事务同时改同一张表，',
      '而「同时」这两个字带来的所有麻烦，锁管理器是第一道答案。',
      '',
      '在 `src/locks.ts` 实现 `createLockManager()`：',
      '',
      '- `acquire(txId, resource, mode)`：`shared` 之间相容，`exclusive` 和谁都不相容；',
      '  拿不到就**等**，返回的 Promise 在拿到时才 resolve；',
      '- `release(txId)`：释放这个事务持有的全部锁，并唤醒能被唤醒的等待者；',
      '- `holders(resource)`：当前持有者的 txId 列表。',
      '',
      '两件必须做对的事：',
      '',
      '1. **锁升级**：一个事务已经持有 shared，又要 exclusive。如果它是唯一持有者就直接升级，',
      '   否则老老实实排队——这是 `SELECT ... FOR UPDATE` 背后的东西。',
      '2. **死锁检测**：T1 拿着 A 要 B，T2 拿着 B 要 A，两边都会永远等下去。',
      '   在**让一个事务开始等之前**，先用等待图（wait-for graph）看看这条边会不会成环；',
      '   会成环就直接让请求方失败（抛 `DeadlockError`），别让它进队列。',
      '',
      '还有一条容易被忽略的：等待队列要**先进先出**。一个 shared 请求不能因为「和当前持有者相容」',
      '就插到前面一个正在等的 exclusive 请求之前，否则源源不断的读会让写永远饿死。',
    ].join('\n'),
    [
      'Until now the database has served one caller at a time. Real workloads are hundreds of concurrent',
      'transactions on one table, and a lock manager is the first answer to everything that word brings.',
      '',
      'Implement `createLockManager()` in `src/locks.ts`:',
      '',
      '- `acquire(txId, resource, mode)`: `shared` locks are compatible with each other, `exclusive` with',
      '  nothing; if the lock is not available the call waits, resolving only once granted;',
      '- `release(txId)`: drop every lock this transaction holds and wake whoever can now proceed;',
      '- `holders(resource)`: the txIds currently holding it.',
      '',
      'Two things must be right:',
      '',
      '1. Lock upgrade: a transaction already holding shared now wants exclusive. Upgrade it directly if',
      '   it is the only holder, otherwise it queues like everyone else. This is what sits behind',
      '   `SELECT ... FOR UPDATE`.',
      '2. Deadlock detection: T1 holds A and wants B, T2 holds B and wants A, and both wait forever.',
      '   Before letting a transaction start waiting, check the wait-for graph for a cycle; if the new',
      '   edge would close one, fail the requester with `DeadlockError` instead of queueing it.',
      '',
      'One more that is easy to miss: the wait queue must be FIFO. A shared request must not jump ahead',
      'of an already-waiting exclusive request just because it is compatible with the current holders, or',
      'a steady stream of readers starves writers forever.',
    ].join('\n')
  ),
  checklist: [
    t('多个 shared 锁可以同时持有', 'Several shared locks are held at once'),
    t('exclusive 与任何锁互斥，拿不到就等', 'exclusive excludes everything and waits when taken'),
    t('唯一持有者可以把 shared 升级成 exclusive', 'The sole holder can upgrade shared to exclusive'),
    t('等待队列先进先出，读不会饿死写', 'The wait queue is FIFO, so readers cannot starve writers'),
    t('环形等待在进队列之前就被拒绝', 'A cyclic wait is refused before it ever enters the queue'),
  ],
  pitfalls: [
    t(
      '死锁检测放在「等了 N 秒还没拿到」之后。超时能发现死锁，但也会把「只是比较慢」误判成死锁，而且死锁真正发生时这 N 秒里所有相关事务都卡着。等待图能在成环的那一瞬间就判定，代价只是一次图遍历。',
      'Detecting deadlock by timeout — "still waiting after N seconds". A timeout does find deadlocks, but it also misdiagnoses merely-slow as deadlocked, and while a real deadlock is pending every involved transaction is stuck for those N seconds. A wait-for graph decides at the instant the cycle would close, for the price of one traversal.'
    ),
    t(
      '锁升级时直接把自己的 shared 换成 exclusive，不检查还有没有别的持有者。别人正拿着 shared 读，你已经开始写了——这是最隐蔽的一类脏读，而且只在并发下出现。',
      'Upgrading by simply swapping your own shared lock for an exclusive one without checking for other holders. Someone else is still reading under a shared lock while you have started writing — the most subtle kind of dirty read, and it only appears under concurrency.'
    ),
    t(
      '`release` 只把锁从表里删掉，忘了唤醒等待者。测试里如果每次 release 之后都恰好有新的 acquire 触发一次队列检查，问题会被掩盖；真实场景下等待者会一直挂着，最后表现为「数据库卡住了」。',
      'Making `release` delete the lock without waking the waiters. If every release happens to be followed by an acquire that re-checks the queue, the bug hides; in production the waiters simply hang and it surfaces as "the database froze".'
    ),
    t(
      '让相容的请求绕过等待队列。看起来是优化——反正它和当前持有者不冲突。但只要读请求持续到来，队列里的写请求就永远等不到，这是教科书级的写饥饿。',
      'Letting compatible requests bypass the queue. It looks like an optimisation since they do not conflict with the current holders — but as long as readers keep arriving, the queued writer never runs. Textbook writer starvation.'
    ),
  ],
  hints: [
    t(
      '等待图这样建：对每个正在等待的事务 W 和它等待的资源 R，连一条 W → H 的边，H 是 R 当前的每个持有者。然后从新来的请求方出发做一次 DFS，能走回自己就是环。',
      'Build the graph like this: for each waiting transaction W and the resource R it waits on, add an edge W → H for every current holder H of R. Then DFS from the new requester; reaching itself means a cycle.'
    ),
    t(
      '等待用 `new Promise((resolve, reject) => queue.push({ txId, mode, resolve, reject }))`，`release` 之后统一去队头看谁能被放行。',
      'Wait with `new Promise((resolve, reject) => queue.push({ txId, mode, resolve, reject }))`, and after a release walk the queue head deciding who can now be granted.'
    ),
  ],
  extension: t(
    [
      '这一关只做了锁管理器，没做「两阶段」本身。2PL 的规则是：一个事务分成加锁阶段和解锁阶段，',
      '**放掉第一把锁之后就不能再加锁**。这条规则才是可串行化的来源——它保证所有事务的',
      '生效顺序等价于某个串行顺序。实际系统用的是 **strict 2PL**：所有锁一直持有到提交，',
      '因为普通 2PL 仍然允许级联回滚（读了别人未提交的数据，别人回滚你也得回滚）。',
      '',
      '死锁的处理有两大流派。**检测**（本关的做法）让死锁发生再抓，适合冲突少的负载；',
      '**预防**则通过给事务编号来保证不可能成环，代表是 wait-die 和 wound-wait：',
      '老事务可以等年轻事务，年轻事务遇到老事务就自杀（或被老事务杀掉）。',
      'PostgreSQL 用检测（`deadlock_timeout` 之后跑一次等待图），Spanner 用 wound-wait。',
      '',
      '还有一个维度这里完全没碰：**锁的粒度**。锁一整张表简单但并发度极低，锁一行并发度高但锁的数量',
      '可能爆炸。真实系统用**意向锁**（IS/IX）做层次化加锁：要锁某一行之前，先在表上加一个意向锁，',
      '这样想锁整张表的事务看一眼表级锁就知道有没有冲突，不用遍历所有行锁。',
    ].join('\n'),
    [
      'This stage builds the lock manager but not the "two-phase" rule itself. 2PL says a transaction has',
      'a growing phase and a shrinking phase, and may not acquire any lock after releasing its first. That',
      'rule is where serialisability comes from: it guarantees the effects are equivalent to some serial',
      'order. Real systems use strict 2PL, holding every lock until commit, because plain 2PL still allows',
      'cascading aborts — you read uncommitted data and must roll back when the other transaction does.',
      '',
      'There are two schools for deadlocks. Detection (what this stage does) lets them happen and catches',
      'them, which suits low-conflict workloads. Prevention numbers transactions so a cycle is impossible:',
      'wait-die and wound-wait, where an older transaction may wait for a younger one while a younger one',
      'meeting an older one kills itself (or is killed). PostgreSQL detects, running the graph after',
      '`deadlock_timeout`; Spanner uses wound-wait.',
      '',
      'One dimension left untouched: granularity. Locking a whole table is simple and barely concurrent;',
      'locking rows is concurrent but the number of locks can explode. Real systems use intention locks',
      '(IS/IX) for hierarchical locking: before locking a row you take an intention lock on the table, so',
      'a transaction wanting the whole table can check one table-level lock instead of walking every row.',
    ].join('\n')
  ),
  focus: ['correctness', 'concurrency', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/locks.ts',
      code`
        export type LockMode = 'shared' | 'exclusive';

        /** 请求会成环时抛出，请求方应当回滚 */
        export class DeadlockError extends Error {
          txId: number;

          constructor(txId: number) {
            super('transaction ' + txId + ' was aborted to break a deadlock');
            this.name = 'DeadlockError';
            this.txId = txId;
          }
        }

        export interface LockManager {
          acquire(txId: number, resource: string, mode: LockMode): Promise<void>;
          release(txId: number): void;
          holders(resource: string): number[];
          /** 正在等待的事务数，用于观察 */
          waiterCount(): number;
        }

        export function createLockManager(): LockManager {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-6.spec.ts',
      code`
        import { createLockManager, DeadlockError } from '../src/locks';
        import { sleep, now } from '@lab/env';

        describe('阶段6 · 两阶段锁与死锁检测', () => {
          it('多个共享锁可以同时持有', async () => {
            const locks = createLockManager();
            await locks.acquire(1, 'users', 'shared');
            await locks.acquire(2, 'users', 'shared');

            expect(locks.holders('users').sort()).toEqual([1, 2]);
          });

          it('排他锁挡住共享锁，释放后放行', async () => {
            const locks = createLockManager();
            await locks.acquire(1, 'users', 'exclusive');

            let granted = false;
            const waiting = locks.acquire(2, 'users', 'shared').then(() => {
              granted = true;
            });

            await sleep(5);
            expect(granted).toBe(false);
            expect(locks.waiterCount()).toBe(1);

            locks.release(1);
            await waiting;
            expect(granted).toBe(true);
            expect(locks.holders('users')).toEqual([2]);
          });

          it('排他锁之间互斥', async () => {
            const locks = createLockManager();
            await locks.acquire(1, 'users', 'exclusive');

            let granted = false;
            const waiting = locks.acquire(2, 'users', 'exclusive').then(() => {
              granted = true;
            });
            await sleep(5);
            expect(granted).toBe(false);

            locks.release(1);
            await waiting;
            expect(granted).toBe(true);
          });

          it('唯一持有者可以把共享锁升级为排他锁', async () => {
            const locks = createLockManager();
            await locks.acquire(1, 'users', 'shared');
            await locks.acquire(1, 'users', 'exclusive');

            expect(locks.holders('users')).toEqual([1]);

            let granted = false;
            locks.acquire(2, 'users', 'shared').then(() => {
              granted = true;
            });
            await sleep(5);
            // 升级成功之后别人就读不到了
            expect(granted).toBe(false);
            locks.release(1);
          });

          it('还有别的持有者时升级要排队', async () => {
            const locks = createLockManager();
            await locks.acquire(1, 'users', 'shared');
            await locks.acquire(2, 'users', 'shared');

            let upgraded = false;
            const upgrading = locks.acquire(1, 'users', 'exclusive').then(() => {
              upgraded = true;
            });
            await sleep(5);
            expect(upgraded).toBe(false);

            locks.release(2);
            await upgrading;
            expect(upgraded).toBe(true);
          });

          it('重复申请同一把锁不会自己卡住自己', async () => {
            const locks = createLockManager();
            await locks.acquire(1, 'users', 'exclusive');
            await locks.acquire(1, 'users', 'exclusive');
            expect(locks.holders('users')).toEqual([1]);
          });

          it('等待队列先进先出，读不会饿死写', async () => {
            const locks = createLockManager();
            await locks.acquire(1, 'users', 'shared');

            const order: string[] = [];
            const writer = locks.acquire(2, 'users', 'exclusive').then(() => order.push('writer'));
            await sleep(1);
            // 这个读请求和当前持有者相容，但它排在写请求后面，不许插队
            const reader = locks.acquire(3, 'users', 'shared').then(() => order.push('reader'));

            await sleep(5);
            locks.release(1);
            await writer;
            locks.release(2);
            await reader;

            expect(order).toEqual(['writer', 'reader']);
          });

          it('环形等待会被拒绝，而不是永远挂着', async () => {
            const locks = createLockManager();
            await locks.acquire(1, 'A', 'exclusive');
            await locks.acquire(2, 'B', 'exclusive');

            // T1 等 B
            let firstGranted = false;
            const first = locks.acquire(1, 'B', 'exclusive').then(() => {
              firstGranted = true;
            });
            await sleep(1);

            // T2 再等 A 就成环了，必须当场失败
            let error: unknown = null;
            try {
              await locks.acquire(2, 'A', 'exclusive');
            } catch (caught) {
              error = caught;
            }

            expect(error).toBeInstanceOf(DeadlockError);
            expect(firstGranted).toBe(false);

            // 被判负的事务回滚，另一个就能走下去
            locks.release(2);
            await first;
            expect(firstGranted).toBe(true);
          });

          it('三个事务的环也能抓出来', async () => {
            const locks = createLockManager();
            await locks.acquire(1, 'A', 'exclusive');
            await locks.acquire(2, 'B', 'exclusive');
            await locks.acquire(3, 'C', 'exclusive');

            locks.acquire(1, 'B', 'exclusive');
            await sleep(1);
            locks.acquire(2, 'C', 'exclusive');
            await sleep(1);

            let error: unknown = null;
            try {
              await locks.acquire(3, 'A', 'exclusive');
            } catch (caught) {
              error = caught;
            }
            expect(error).toBeInstanceOf(DeadlockError);

            locks.release(3);
            locks.release(2);
            locks.release(1);
          });

          it('不成环的等待不会被误判', async () => {
            const locks = createLockManager();
            await locks.acquire(1, 'A', 'exclusive');

            // T2 等 A，但 T1 没有在等任何东西，这不是死锁
            let granted = false;
            const waiting = locks.acquire(2, 'A', 'exclusive').then(() => {
              granted = true;
            });
            await sleep(5);
            expect(granted).toBe(false);

            locks.release(1);
            await waiting;
            expect(granted).toBe(true);
          });

          it('release 释放该事务的全部锁', async () => {
            const locks = createLockManager();
            await locks.acquire(1, 'A', 'exclusive');
            await locks.acquire(1, 'B', 'exclusive');
            locks.release(1);

            expect(locks.holders('A')).toEqual([]);
            expect(locks.holders('B')).toEqual([]);
          });

          it('释放没持有锁的事务是无操作', () => {
            const locks = createLockManager();
            locks.release(42);
            expect(locks.waiterCount()).toBe(0);
          });

          it('共享锁之间不会互相排队 [gate:shared]', async () => {
            const locks = createLockManager();
            const startedAt = now();

            await Promise.all(
              [1, 2, 3, 4, 5].map(async (txId) => {
                await locks.acquire(txId, 'users', 'shared');
                await sleep(10);
                locks.release(txId);
              })
            );

            // 串行化的实现是 50ms，正确的实现是 10ms
            expect(now() - startedAt).toBe(10);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 10,
      unit: 'ms',
      zh: '五个共享锁并发持有只花一份时间',
      en: 'Five concurrent shared locks cost one hold, not five',
      dimension: 'concurrency',
      scope: 'gate:shared',
    }),
  ],
  referenceFiles: [
    file(
      'src/locks.ts',
      code`
        export type LockMode = 'shared' | 'exclusive';

        export class DeadlockError extends Error {
          txId: number;

          constructor(txId: number) {
            super('transaction ' + txId + ' was aborted to break a deadlock');
            this.name = 'DeadlockError';
            this.txId = txId;
          }
        }

        export interface LockManager {
          acquire(txId: number, resource: string, mode: LockMode): Promise<void>;
          release(txId: number): void;
          holders(resource: string): number[];
          waiterCount(): number;
        }

        interface Waiter {
          txId: number;
          mode: LockMode;
          resolve: () => void;
        }

        export function createLockManager(): LockManager {
          const held = new Map<string, Map<number, LockMode>>();
          const queues = new Map<string, Waiter[]>();
          const byTx = new Map<number, Set<string>>();

          function holdersOf(resource: string): Map<number, LockMode> {
            const existing = held.get(resource);
            if (existing) return existing;
            const created = new Map<number, LockMode>();
            held.set(resource, created);
            return created;
          }

          function queueOf(resource: string): Waiter[] {
            const existing = queues.get(resource);
            if (existing) return existing;
            const created: Waiter[] = [];
            queues.set(resource, created);
            return created;
          }

          function compatible(resource: string, txId: number, mode: LockMode): boolean {
            const current = holdersOf(resource);
            if (current.size === 0) return true;
            // 唯一持有者是自己：重复申请或升级，都直接放行
            if (current.size === 1 && current.has(txId)) return true;
            if (mode === 'exclusive') return false;
            // 共享请求：只要没有别人拿着排他锁就相容
            for (const entry of Array.from(current.entries())) {
              if (entry[0] !== txId && entry[1] === 'exclusive') return false;
            }
            return true;
          }

          function grant(resource: string, txId: number, mode: LockMode): void {
            const current = holdersOf(resource);
            // 已经是排他锁就不要被一次共享申请降级
            const existing = current.get(txId);
            current.set(txId, existing === 'exclusive' ? 'exclusive' : mode);

            const owned = byTx.get(txId) || new Set<string>();
            owned.add(resource);
            byTx.set(txId, owned);
          }

          function drain(resource: string): void {
            const queue = queueOf(resource);
            // 只从队头放行：相容的请求也不许插队，否则源源不断的读会饿死写
            while (queue.length > 0 && compatible(resource, queue[0].txId, queue[0].mode)) {
              const waiter = queue.shift() as Waiter;
              grant(resource, waiter.txId, waiter.mode);
              waiter.resolve();
            }
            if (queue.length === 0) queues.delete(resource);
          }

          /**
           * 等待图：每个正在等待的事务，连边指向它所等资源的每个持有者。
           * 把新请求这条边也加进去，从请求方出发能走回自己就是环。
           */
          function wouldCycle(txId: number, resource: string): boolean {
            const waitsFor = new Map<number, Set<number>>();

            const addEdges = (waiter: number, target: string) => {
              const set = waitsFor.get(waiter) || new Set<number>();
              for (const holder of Array.from(holdersOf(target).keys())) {
                if (holder !== waiter) set.add(holder);
              }
              waitsFor.set(waiter, set);
            };

            for (const entry of Array.from(queues.entries())) {
              for (const waiter of entry[1]) addEdges(waiter.txId, entry[0]);
            }
            addEdges(txId, resource);

            const seen = new Set<number>();
            const stack = Array.from(waitsFor.get(txId) || []);
            while (stack.length > 0) {
              const current = stack.pop() as number;
              if (current === txId) return true;
              if (seen.has(current)) continue;
              seen.add(current);
              for (const next of Array.from(waitsFor.get(current) || [])) stack.push(next);
            }
            return false;
          }

          return {
            async acquire(txId: number, resource: string, mode: LockMode): Promise<void> {
              const queue = queueOf(resource);
              if (queue.length === 0 && compatible(resource, txId, mode)) {
                grant(resource, txId, mode);
                return;
              }

              // 判死锁要在进队列**之前**：进了队列再发现成环，
              // 就得把已经在等的人也叫醒，处理起来麻烦得多
              if (wouldCycle(txId, resource)) throw new DeadlockError(txId);

              await new Promise<void>((resolve) => {
                queue.push({ txId, mode, resolve });
              });
            },

            release(txId: number): void {
              const owned = byTx.get(txId);
              if (!owned) return;

              for (const resource of Array.from(owned)) {
                holdersOf(resource).delete(txId);
              }
              byTx.delete(txId);
              // 释放之后必须主动唤醒，等待者不会自己醒过来
              for (const resource of Array.from(owned)) drain(resource);
            },

            holders(resource: string): number[] {
              return Array.from(holdersOf(resource).keys());
            },

            waiterCount(): number {
              let total = 0;
              for (const queue of Array.from(queues.values())) total += queue.length;
              return total;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**死锁判定在进队列之前。** 这是实现顺序上的一个关键选择。进了队列再检测，',
      '意味着发现环之后要去队列里找到那个 waiter、把它摘掉、还要 reject 它的 Promise；',
      '在它之前还可能已经有别的请求基于「队列里有它」做过判断。',
      '在入队前判定，失败路径就只是一个 `throw`，没有任何状态需要回滚。',
      '',
      '**`drain` 只看队头。** 写成「遍历整个队列，把所有相容的都放行」会跑得更快，',
      '也确实不会破坏正确性——但它就是写饥饿本身：只要读请求不断到来，队列中间的写请求',
      '永远轮不到。数据库宁可慢一点也要保证公平。',
      '',
      '**`grant` 里那句 `existing === \'exclusive\' ? \'exclusive\' : mode`。** 一个事务已经持有排他锁，',
      '又申请了一次共享锁——直接覆盖会把自己降级成 shared，于是别的事务突然可以进来读它',
      '正在改的数据。锁只能升不能降。',
    ].join('\n'),
    [
      'Deadlock is decided before queueing. That ordering is a real implementation choice. Detecting after',
      'the waiter is in the queue means finding it again, removing it, and rejecting its promise — and in',
      'the meantime other requests may already have reasoned about a queue that contains it. Deciding',
      'before entry makes the failure path a bare `throw` with no state to unwind.',
      '',
      '`drain` only looks at the head. Walking the whole queue and granting everything compatible would be',
      'faster and would not break correctness — but it is writer starvation by construction: as long as',
      'readers keep arriving, a writer in the middle of the queue never runs. A database would rather be',
      'slower and fair.',
      '',
      "The `existing === 'exclusive' ? 'exclusive' : mode` line in `grant`. A transaction holding an",
      'exclusive lock that then asks for a shared one would otherwise overwrite its own mode and downgrade',
      'itself, letting other transactions in to read data it is still changing. Locks may be upgraded,',
      'never downgraded.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 7 关 · 快照隔离与版本链                                            */
/* ------------------------------------------------------------------ */

const stage7 = {
  id: 'mvcc',
  title: t('第 7 关 · 快照隔离与版本链', 'Stage 7 · Snapshot isolation and version chains'),
  goal: t(
    [
      '上一关用锁解决并发，代价是读会挡住写。一个跑十分钟的报表查询会让整张表十分钟不能改，',
      '这在真实系统里不可接受。MVCC 的答案是：**别覆盖旧值，追加新版本**，',
      '于是读永远读得到一个一致的旧快照，不需要挡住任何人。',
      '',
      '在 `src/mvcc.ts` 实现 `createMvccStore()`：',
      '',
      '- `begin()`：开事务，它看到的是**此刻已提交**的那个快照，之后别人提交什么都与它无关；',
      '- `tx.read(key)` / `tx.write(key, row)`：写只追加新版本，`write(key, null)` 表示删除；',
      '- `tx.commit()`：如果**在我的快照之后**有别的事务提交过同一个 key，抛 `WriteConflictError`；',
      '- `tx.rollback()`：丢掉我造的所有版本；',
      '- `vacuum()`：清掉所有活跃事务都看不见的旧版本，返回清了几个。',
      '',
      '可见性规则只有两条，但必须两条都对：',
      '',
      '1. 我自己写的版本，我自己立刻看得见（哪怕还没提交）；',
      '2. 别人的版本，只有在**我开始之前**就已提交的才看得见。',
      '',
      '`vacuum` 不是可选项。不清理的话版本链会一直长，读一个被改过一万次的 key 要走一万个版本。',
      'PostgreSQL 的 VACUUM 就是这件事，而「忘了 vacuum 导致表膨胀」是它最经典的运维事故。',
    ].join('\n'),
    [
      'The previous stage solved concurrency with locks, at the cost of readers blocking writers. A report',
      'query running for ten minutes would make the table unwritable for ten minutes, which is not',
      'acceptable in a real system. MVCC answers differently: never overwrite, append a new version. Reads',
      'then always see a consistent older snapshot without blocking anyone.',
      '',
      'Implement `createMvccStore()` in `src/mvcc.ts`:',
      '',
      '- `begin()`: start a transaction seeing the snapshot of what is committed right now, and nothing',
      '  committed later;',
      '- `tx.read(key)` / `tx.write(key, row)`: writes append a version, `write(key, null)` deletes;',
      '- `tx.commit()`: if another transaction committed this key after my snapshot, throw `WriteConflictError`;',
      '- `tx.rollback()`: discard every version I created;',
      '- `vacuum()`: drop versions no active transaction can see, returning how many were removed.',
      '',
      'Visibility is two rules, and both have to be right:',
      '',
      '1. My own versions are visible to me immediately, committed or not;',
      "2. Someone else's version is visible only if it was committed before I began.",
      '',
      '`vacuum` is not optional. Without it a version chain grows forever and reading a key updated ten',
      "thousand times walks ten thousand versions. That is exactly PostgreSQL's VACUUM, and \"forgot to",
      'vacuum, table bloated" is its most classic operational incident.',
    ].join('\n')
  ),
  checklist: [
    t('事务看到的是开始时的快照，之后的提交与它无关', 'A transaction sees its start snapshot and nothing committed later'),
    t('自己没提交的写，自己看得见，别人看不见', 'Own uncommitted writes are visible to self and to nobody else'),
    t('两个事务改同一个 key，后提交的那个失败', 'Two transactions on one key: the later committer fails'),
    t('改不同 key 的事务互不干扰', 'Transactions touching different keys do not interfere'),
    t('vacuum 之后版本链塌回一个版本', 'After vacuum the chain collapses to a single version'),
  ],
  pitfalls: [
    t(
      '可见性判断写成「commitSeq < 我的 startSeq」而不是 `<=`。开始快照的那一刻已经提交的事务必须可见，用 `<` 会把「刚好在我开始前提交」的那一个漏掉——症状是偶发的读不到刚写入的数据，而且和时序有关，极难复现。',
      'Writing the visibility check as `commitSeq < startSeq` instead of `<=`. A transaction committed at the instant the snapshot was taken must be visible; `<` drops the one that committed just before you began. The symptom is intermittently not seeing data that was definitely written, timing-dependent and nearly impossible to reproduce.'
    ),
    t(
      '找可见版本时从旧往新扫，返回第一个可见的。可见的版本可能有好几个（这个 key 被改过多次），你要的是**最新的那个可见版本**，所以必须从新往旧扫、遇到第一个可见的就停。从旧往新会一直返回最初的那个值。',
      'Scanning the chain oldest-first and returning the first visible version. Several versions may be visible when a key was updated repeatedly; you want the newest visible one, so scan newest-first and stop at the first hit. Oldest-first permanently returns the original value.'
    ),
    t(
      '冲突检测只看「最新版本是不是别人写的」。真正的条件是「有没有任何一个版本在我的快照之后提交」。只看最新版本时，A 提交后 B 又提交，你只和 B 比较——如果 B 恰好是你自己，就会误判成无冲突。',
      'Checking conflicts by looking only at whether the newest version belongs to someone else. The real condition is whether any version was committed after your snapshot. Looking only at the newest, when A commits and then B commits, you compare against B alone — and if B happens to be you, you wrongly conclude there is no conflict.'
    ),
    t(
      '冲突时直接抛错，不清理自己造的未提交版本。它们会永远留在版本链里，既不可见也不会被 vacuum 掉（vacuum 不敢动未提交的版本），链只会越来越长。抛错之前先把自己的版本摘掉。',
      'Throwing on conflict without removing your own uncommitted versions. They stay in the chain forever — invisible to everyone and untouchable by vacuum, which dare not remove uncommitted versions — so the chain only grows. Detach your versions before throwing.'
    ),
  ],
  hints: [
    t(
      '给 store 维护一个全局递增的 `commitSeq`。事务开始时记下当时的值当作 startSeq，提交时 `commitSeq += 1` 并把自己所有版本标上这个新值。可见性和冲突判定都只需要比较这两个数。',
      'Keep a monotonically increasing `commitSeq` on the store. A transaction records its value at begin as `startSeq`; on commit, increment it and stamp every version you created. Both visibility and conflict detection reduce to comparing those two numbers.'
    ),
    t(
      'vacuum 的水位线 = 所有活跃事务 startSeq 的最小值（没有活跃事务就是当前 commitSeq）。比这条线更旧、而且后面还有更新版本的，都没人能看见了。',
      "vacuum's watermark is the minimum `startSeq` among active transactions, or the current `commitSeq` when none are active. Any committed version older than that line with a newer version after it is invisible to everyone.",
    ),
  ],
  extension: t(
    [
      '快照隔离**不是**可串行化，这一关的最后一个用例就是证明。',
      '经典反例叫**写偏斜**（write skew）：两个事务各自读了 x 和 y、各自检查「x + y >= 0」还成立、',
      '然后一个改 x 一个改 y。它们写的是不同的 key，没有写写冲突，两个都能提交，',
      '而提交之后 x + y < 0——一个两个事务分别都维护住的不变量，被它们一起破坏了。',
      '',
      '真实系统的处理：Oracle 和 MySQL 的 REPEATABLE READ 就到快照隔离为止，把这个坑留给你，',
      '解法是手动 `SELECT ... FOR UPDATE` 把读也加上锁。PostgreSQL 从 9.1 起提供',
      '**可串行化快照隔离**（SSI），做法是在 MVCC 之上跟踪读写依赖，发现「危险结构」',
      '（一个事务读了另一个即将覆盖的数据，形成 rw 依赖的环）就中止其中一个。',
      '代价是要记录读集合，以及一定比例的误杀。',
      '',
      '另外，PostgreSQL 的 MVCC 把旧版本存在**表里**（所以需要 VACUUM 回收），',
      'MySQL InnoDB 把旧版本存在**回滚段**（undo log）里，读旧快照时顺着 undo 往回推。',
      '两种做法的取舍很不一样：前者让 UPDATE 变成「删+插」，索引也要跟着更新；',
      '后者让长事务撑大 undo 表空间，而且回滚很慢。',
    ].join('\n'),
    [
      'Snapshot isolation is not serialisability, and the last spec in this stage proves it. The classic',
      'counterexample is write skew: two transactions each read x and y, each verify that "x + y >= 0"',
      'still holds, then one updates x and the other updates y. They wrote different keys, so there is no',
      'write-write conflict and both commit — after which x + y < 0. An invariant each transaction',
      'individually preserved is broken by the pair.',
      '',
      'How real systems handle it: Oracle and MySQL REPEATABLE READ stop at snapshot isolation and leave',
      'the hole to you, the workaround being explicit `SELECT ... FOR UPDATE` to lock the reads.',
      'PostgreSQL has offered serialisable snapshot isolation (SSI) since 9.1, tracking read/write',
      'dependencies on top of MVCC and aborting a transaction when it spots a dangerous structure — a',
      'cycle of rw-dependencies. The price is remembering read sets, plus a rate of false positives.',
      '',
      'Also worth knowing: PostgreSQL stores old versions in the table itself, which is why it needs',
      'VACUUM to reclaim them, while MySQL InnoDB keeps them in the rollback segment (undo log) and walks',
      'undo backwards to reconstruct an old snapshot. The trade-offs differ sharply: the former turns every',
      'UPDATE into a delete plus insert that indexes must follow, the latter lets long transactions inflate',
      'the undo tablespace and makes rollback slow.',
    ].join('\n')
  ),
  focus: ['correctness', 'concurrency', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/mvcc.ts',
      code`
        import type { Row } from './contract';

        /** 在我的快照之后已经有人改过同一个 key */
        export class WriteConflictError extends Error {
          txId: number;
          key: string;

          constructor(txId: number, key: string) {
            super('transaction ' + txId + ' conflicts on "' + key + '"');
            this.name = 'WriteConflictError';
            this.txId = txId;
            this.key = key;
          }
        }

        export interface MvccTransaction {
          id: number;
          read(key: string): Row | null;
          /** row 为 null 表示删除 */
          write(key: string, row: Row | null): void;
          commit(): void;
          rollback(): void;
        }

        export interface MvccStore {
          begin(): MvccTransaction;
          /** 最新已提交的值，测试和运维用 */
          current(key: string): Row | null;
          /** 这个 key 的版本链有多长 */
          chainLength(key: string): number;
          /** 清掉没人看得见的旧版本，返回清理数量 */
          vacuum(): number;
          activeCount(): number;
        }

        export function createMvccStore(): MvccStore {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-7.spec.ts',
      code`
        import { createMvccStore, WriteConflictError } from '../src/mvcc';
        import { count } from '@lab/metrics';

        function row(id: number, name: string, active = 1) {
          return { id, name, active };
        }

        describe('阶段7 · 快照隔离与版本链', () => {
          it('提交之后别的事务读得到', () => {
            const store = createMvccStore();
            const writer = store.begin();
            writer.write('u1', row(1, 'alice'));
            writer.commit();

            const reader = store.begin();
            expect(reader.read('u1')).toEqual(row(1, 'alice'));
            expect(store.current('u1')).toEqual(row(1, 'alice'));
          });

          it('没写过的 key 读出来是 null', () => {
            const store = createMvccStore();
            expect(store.begin().read('nobody')).toBeNull();
          });

          it('自己没提交的写，自己看得见', () => {
            const store = createMvccStore();
            const tx = store.begin();
            tx.write('u1', row(1, 'draft'));
            expect(tx.read('u1')).toEqual(row(1, 'draft'));
          });

          it('自己没提交的写，别人看不见', () => {
            const store = createMvccStore();
            const writer = store.begin();
            writer.write('u1', row(1, 'draft'));

            const other = store.begin();
            expect(other.read('u1')).toBeNull();
          });

          it('快照建立之后，别人的提交与我无关（可重复读）', () => {
            const store = createMvccStore();
            const setup = store.begin();
            setup.write('u1', row(1, 'v1'));
            setup.commit();

            const reader = store.begin();
            expect(reader.read('u1')).toEqual(row(1, 'v1'));

            const writer = store.begin();
            writer.write('u1', row(1, 'v2'));
            writer.commit();

            // 同一个事务里读第二次，还是 v1
            expect(reader.read('u1')).toEqual(row(1, 'v1'));
            // 但新开的事务看到的是 v2
            expect(store.begin().read('u1')).toEqual(row(1, 'v2'));
          });

          it('多次更新之后读到的是最新的可见版本', () => {
            const store = createMvccStore();
            for (const name of ['v1', 'v2', 'v3']) {
              const tx = store.begin();
              tx.write('u1', row(1, name));
              tx.commit();
            }
            expect(store.begin().read('u1')).toEqual(row(1, 'v3'));
          });

          it('写同一个 key，后提交的那个冲突失败', () => {
            const store = createMvccStore();
            const setup = store.begin();
            setup.write('u1', row(1, 'base'));
            setup.commit();

            const first = store.begin();
            const second = store.begin();

            first.write('u1', row(1, 'from-first'));
            second.write('u1', row(1, 'from-second'));

            first.commit();

            let error: unknown = null;
            try {
              second.commit();
            } catch (caught) {
              error = caught;
            }

            expect(error).toBeInstanceOf(WriteConflictError);
            expect(store.current('u1')).toEqual(row(1, 'from-first'));
          });

          it('冲突失败之后不会在版本链里留下垃圾', () => {
            const store = createMvccStore();
            const setup = store.begin();
            setup.write('u1', row(1, 'base'));
            setup.commit();

            const first = store.begin();
            const second = store.begin();
            first.write('u1', row(1, 'a'));
            second.write('u1', row(1, 'b'));
            first.commit();
            try {
              second.commit();
            } catch (caught) {
              // 预期之内
            }

            expect(store.vacuum()).toBeGreaterThanOrEqual(0);
            expect(store.chainLength('u1')).toBeLessThanOrEqual(2);
            expect(store.current('u1')).toEqual(row(1, 'a'));
          });

          it('改不同 key 的事务互不干扰', () => {
            const store = createMvccStore();
            const first = store.begin();
            const second = store.begin();
            first.write('u1', row(1, 'a'));
            second.write('u2', row(2, 'b'));

            first.commit();
            second.commit();

            expect(store.current('u1')).toEqual(row(1, 'a'));
            expect(store.current('u2')).toEqual(row(2, 'b'));
          });

          it('rollback 之后什么都没留下', () => {
            const store = createMvccStore();
            const tx = store.begin();
            tx.write('u1', row(1, 'gone'));
            tx.rollback();

            expect(store.current('u1')).toBeNull();
            expect(store.begin().read('u1')).toBeNull();
          });

          it('写 null 表示删除', () => {
            const store = createMvccStore();
            const setup = store.begin();
            setup.write('u1', row(1, 'alice'));
            setup.commit();

            const remover = store.begin();
            remover.write('u1', null);
            remover.commit();

            expect(store.current('u1')).toBeNull();
            expect(store.begin().read('u1')).toBeNull();
          });

          it('活跃事务还在时，vacuum 不能清掉它要看的版本', () => {
            const store = createMvccStore();
            const setup = store.begin();
            setup.write('u1', row(1, 'v1'));
            setup.commit();

            const reader = store.begin();

            const writer = store.begin();
            writer.write('u1', row(1, 'v2'));
            writer.commit();

            store.vacuum();
            // reader 的快照还需要 v1
            expect(reader.read('u1')).toEqual(row(1, 'v1'));
          });

          it('快照隔离挡不住写偏斜——这是它的已知边界', () => {
            const store = createMvccStore();
            const setup = store.begin();
            setup.write('x', row(0, '10'));
            setup.write('y', row(0, '10'));
            setup.commit();

            // 两个事务各自检查「x + y >= 0」，各自只改一个
            const first = store.begin();
            const second = store.begin();

            const firstSum = Number(first.read('x')!.name) + Number(first.read('y')!.name);
            const secondSum = Number(second.read('x')!.name) + Number(second.read('y')!.name);
            expect(firstSum).toBe(20);
            expect(secondSum).toBe(20);

            first.write('x', row(0, '-15'));
            second.write('y', row(0, '-15'));

            // 写的是不同的 key，没有写写冲突，两个都提交成功
            first.commit();
            second.commit();

            const finalSum = Number(store.current('x')!.name) + Number(store.current('y')!.name);
            // 两个事务分别都维护住了不变量，合起来把它破坏了
            expect(finalSum).toBe(-30);
          });

          it('没有活跃事务时 vacuum 把版本链塌回一个 [gate:vacuum]', () => {
            const store = createMvccStore();
            for (let index = 0; index < 20; index += 1) {
              const tx = store.begin();
              tx.write('u1', row(1, 'v' + index));
              tx.commit();
            }

            expect(store.chainLength('u1')).toBeGreaterThan(1);
            expect(store.activeCount()).toBe(0);

            const removed = store.vacuum();
            count('chainAfterVacuum', store.chainLength('u1'));

            expect(removed).toBeGreaterThanOrEqual(19);
            expect(store.chainLength('u1')).toBe(1);
            // 清理不能改变可见的值
            expect(store.current('u1')).toEqual(row(1, 'v19'));
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.chainAfterVacuum',
      op: 'lte',
      value: 1,
      unit: 'versions',
      zh: '20 次更新后 vacuum 只留下一个版本',
      en: 'After 20 updates, vacuum leaves exactly one version',
      dimension: 'resilience',
      scope: 'gate:vacuum',
    }),
  ],
  referenceFiles: [
    file(
      'src/mvcc.ts',
      code`
        import type { Row } from './contract';

        export class WriteConflictError extends Error {
          txId: number;
          key: string;

          constructor(txId: number, key: string) {
            super('transaction ' + txId + ' conflicts on "' + key + '"');
            this.name = 'WriteConflictError';
            this.txId = txId;
            this.key = key;
          }
        }

        export interface MvccTransaction {
          id: number;
          read(key: string): Row | null;
          write(key: string, row: Row | null): void;
          commit(): void;
          rollback(): void;
        }

        export interface MvccStore {
          begin(): MvccTransaction;
          current(key: string): Row | null;
          chainLength(key: string): number;
          vacuum(): number;
          activeCount(): number;
        }

        interface Version {
          createdBy: number;
          /** null 表示还没提交 */
          commitSeq: number | null;
          row: Row | null;
        }

        export function createMvccStore(): MvccStore {
          let nextTxId = 1;
          // 全局提交序号。可见性和冲突判定都只是在比较两个整数
          let commitSeq = 0;
          const chains = new Map<string, Version[]>();
          const active = new Map<number, number>();

          function chainOf(key: string): Version[] {
            const existing = chains.get(key);
            if (existing) return existing;
            const created: Version[] = [];
            chains.set(key, created);
            return created;
          }

          function latestCommitted(key: string): Version | null {
            const versions = chains.get(key) || [];
            for (let index = versions.length - 1; index >= 0; index -= 1) {
              if (versions[index].commitSeq !== null) return versions[index];
            }
            return null;
          }

          return {
            begin(): MvccTransaction {
              const id = nextTxId;
              nextTxId += 1;
              const startSeq = commitSeq;
              active.set(id, startSeq);

              const written = new Set<string>();
              let settled = false;

              function discardOwn(): void {
                for (const key of Array.from(written)) {
                  const versions = chainOf(key);
                  chains.set(
                    key,
                    versions.filter((version) => !(version.createdBy === id && version.commitSeq === null))
                  );
                }
                written.clear();
              }

              return {
                id,

                read(key: string): Row | null {
                  const versions = chains.get(key) || [];
                  // 从新往旧扫，第一个可见的就是答案。
                  // 反过来扫会永远返回最初那个值
                  for (let index = versions.length - 1; index >= 0; index -= 1) {
                    const version = versions[index];
                    if (version.createdBy === id) return version.row;
                    // <= 而不是 <：开始那一刻已经提交的必须可见
                    if (version.commitSeq !== null && version.commitSeq <= startSeq) return version.row;
                  }
                  return null;
                },

                write(key: string, row: Row | null): void {
                  if (settled) throw new Error('transaction ' + id + ' has already finished');
                  const versions = chainOf(key);
                  const mine = versions.filter(
                    (version) => version.createdBy === id && version.commitSeq === null
                  )[0];
                  if (mine) {
                    mine.row = row;
                  } else {
                    versions.push({ createdBy: id, commitSeq: null, row });
                  }
                  written.add(key);
                },

                commit(): void {
                  if (settled) throw new Error('transaction ' + id + ' has already finished');

                  // 条件是「有没有**任何**版本在我的快照之后提交」，
                  // 只比较最新版本会在连续提交时漏判
                  for (const key of Array.from(written)) {
                    for (const version of chainOf(key)) {
                      if (version.commitSeq !== null && version.commitSeq > startSeq) {
                        // 先把自己造的版本摘掉再抛：留在链里的话
                        // 既不可见也 vacuum 不掉，链只会越来越长
                        discardOwn();
                        settled = true;
                        active.delete(id);
                        throw new WriteConflictError(id, key);
                      }
                    }
                  }

                  commitSeq += 1;
                  for (const key of Array.from(written)) {
                    for (const version of chainOf(key)) {
                      if (version.createdBy === id && version.commitSeq === null) {
                        version.commitSeq = commitSeq;
                      }
                    }
                  }
                  settled = true;
                  active.delete(id);
                },

                rollback(): void {
                  if (settled) return;
                  discardOwn();
                  settled = true;
                  active.delete(id);
                },
              };
            },

            current(key: string): Row | null {
              const version = latestCommitted(key);
              return version ? version.row : null;
            },

            chainLength(key: string): number {
              return (chains.get(key) || []).length;
            },

            vacuum(): number {
              // 水位线取所有活跃事务里最老的那个快照：比它更旧、
              // 而且后面还有更新版本的，谁也看不见了
              let watermark = commitSeq;
              for (const startSeq of Array.from(active.values())) {
                watermark = Math.min(watermark, startSeq);
              }

              let removed = 0;
              for (const entry of Array.from(chains.entries())) {
                const versions = entry[1];
                let keepFrom = -1;
                for (let index = versions.length - 1; index >= 0; index -= 1) {
                  const version = versions[index];
                  if (version.commitSeq !== null && version.commitSeq <= watermark) {
                    keepFrom = index;
                    break;
                  }
                }
                if (keepFrom > 0) {
                  removed += keepFrom;
                  chains.set(entry[0], versions.slice(keepFrom));
                }
              }
              return removed;
            },

            activeCount(): number {
              return active.size;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**整个可见性模型只用了两个整数。** `startSeq` 是事务开始时的全局提交序号，',
      '`commitSeq` 是版本被提交时的序号。可见 = `commitSeq <= startSeq`，',
      '冲突 = 我写的 key 上存在 `commitSeq > startSeq` 的版本。',
      '不需要时间戳、不需要事务列表、不需要锁——这是 MVCC 最漂亮的地方。',
      '',
      '**冲突检测遍历整条链，而不是只看最新版本。** 场景：A 和 B 都在我之后提交了同一个 key，',
      '只看最新版本（B 的）时，如果判断条件写得稍微松一点就可能放过去。',
      '遍历整条链的成本是 O(版本数)，而 vacuum 保证了这个数不会失控。',
      '',
      '**冲突时先 `discardOwn()` 再抛。** 未提交的版本对所有人都不可见，',
      '但 vacuum 不敢碰它们——它没法区分「已经废弃」和「属于一个还在跑的事务」。',
      '所以废弃的责任在抛错的这一方。少了这一行，长期运行的系统里版本链会被失败的事务慢慢撑爆。',
      '',
      '**写偏斜那条用例是故意让它「通过」的。** 它断言的是 `finalSum === -30`，',
      '也就是不变量确实被破坏了。这不是 bug，是快照隔离的定义边界——',
      '把它写成用例，比在文档里写一句「SI 不是可串行化」有用得多。',
    ].join('\n'),
    [
      'The whole visibility model runs on two integers. `startSeq` is the global commit counter when the',
      'transaction began, `commitSeq` is the counter when a version was committed. Visible means',
      '`commitSeq <= startSeq`; conflict means a version with `commitSeq > startSeq` exists on a key I',
      'wrote. No timestamps, no transaction lists, no locks — that is the elegant part of MVCC.',
      '',
      'Conflict detection walks the whole chain rather than checking the newest version. Consider A and B',
      'both committing the same key after me: looking only at the newest (B\'s) makes it easy to write a',
      'slightly loose condition that lets the conflict through. Walking the chain costs O(versions), and',
      'vacuum is what keeps that number from running away.',
      '',
      'On conflict, `discardOwn()` runs before the throw. Uncommitted versions are invisible to everyone,',
      'but vacuum will not touch them — it cannot distinguish "abandoned" from "belongs to a transaction',
      'still running". So abandoning them is the thrower\'s job. Without that line, a long-running system',
      'slowly inflates its chains with the debris of failed transactions.',
      '',
      'The write-skew spec passes on purpose. It asserts `finalSum === -30`, i.e. that the invariant really',
      'was broken. That is not a bug, it is the definition of where snapshot isolation stops — and encoding',
      'it as a spec is far more useful than a sentence in the docs saying "SI is not serialisable".',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 8 关 · SQL 词法与递归下降解析                                      */
/* ------------------------------------------------------------------ */

const ast = readonlyFile(
  'src/ast.ts',
  code`
    /** 语法树的形状（只读，平台提供）——解析器的输出必须长这样 */

    export type TokenType = 'keyword' | 'identifier' | 'number' | 'string' | 'operator' | 'punctuation' | 'eof';

    export interface Token {
      type: TokenType;
      /** 关键字统一大写，标识符保留原样 */
      value: string;
      /** 在原始 SQL 里的下标，报错要用 */
      position: number;
    }

    export type CompareOp = '=' | '!=' | '<' | '<=' | '>' | '>=';
    export type BinaryOp = CompareOp | 'AND' | 'OR';

    export type Expr =
      | { kind: 'column'; name: string }
      | { kind: 'literal'; value: number | string }
      | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr };

    export interface OrderBy {
      column: string;
      direction: 'asc' | 'desc';
    }

    export interface SelectStatement {
      kind: 'select';
      /** ['*'] 表示全部列 */
      columns: string[];
      table: string;
      where?: Expr;
      orderBy?: OrderBy;
      limit?: number;
    }

    export interface InsertStatement {
      kind: 'insert';
      table: string;
      values: Array<number | string>;
    }

    export type Statement = SelectStatement | InsertStatement;
  `
);

const stage8 = {
  id: 'sql-parser',
  title: t('第 8 关 · SQL 词法与递归下降解析', 'Stage 8 · SQL lexing and recursive descent'),
  goal: t(
    [
      '前七关做的是引擎，从这一关开始做**前端**：把一个字符串变成引擎能执行的结构。',
      '',
      '在 `src/lexer.ts` 实现 `tokenize(sql)`，在 `src/parser.ts` 实现 `parse(sql)`，',
      '支持这个子集：',
      '',
      '```sql',
      'SELECT * FROM users WHERE age >= 18 AND city = \'Beijing\' ORDER BY age DESC LIMIT 10',
      'INSERT INTO users VALUES (1, \'alice\', 1)',
      '```',
      '',
      '**词法**要处理的坑：关键字大小写不敏感（`select` 和 `SELECT` 一样），但标识符要保留原样；',
      '字符串用单引号，里面的单引号用两个连写转义（`\'it\'\'s\'`）；',
      '`>=` 和 `>` 必须先试两字符再试一字符，否则 `>=` 会被切成 `>` 和 `=`。',
      '',
      '**语法**的核心是**优先级**。`a = 1 OR b = 2 AND c = 3` 必须解析成',
      '`OR(a=1, AND(b=2, c=3))`——AND 比 OR 紧。递归下降表达优先级的方式是',
      '**一层文法一个函数**，越往下优先级越高：',
      '',
      '```',
      'expr    := orExpr',
      'orExpr  := andExpr (OR andExpr)*',
      'andExpr := compare (AND compare)*',
      'compare := primary (op primary)?',
      'primary := \'(\' expr \')\' | column | literal',
      '```',
      '',
      '报错要带**位置**：`SqlSyntaxError` 上的 `position` 是出错 token 在原串里的下标。',
      '「语法错误」四个字对用户没有任何帮助。',
    ].join('\n'),
    [
      'Seven stages built the engine. From here on you build the front end: turning a string into',
      'something the engine can execute.',
      '',
      'Implement `tokenize(sql)` in `src/lexer.ts` and `parse(sql)` in `src/parser.ts`, covering:',
      '',
      '```sql',
      "SELECT * FROM users WHERE age >= 18 AND city = 'Beijing' ORDER BY age DESC LIMIT 10",
      "INSERT INTO users VALUES (1, 'alice', 1)",
      '```',
      '',
      'Lexing traps: keywords are case-insensitive (`select` equals `SELECT`) while identifiers keep',
      "their case; strings use single quotes with '' as the escape (`'it''s'`); and two-character",
      'operators must be tried before one-character ones, or `>=` is cut into `>` and `=`.',
      '',
      'Parsing is really about precedence. `a = 1 OR b = 2 AND c = 3` must parse as',
      '`OR(a=1, AND(b=2, c=3))` — AND binds tighter. Recursive descent expresses precedence as one',
      'function per grammar level, tighter binding further down:',
      '',
      '```',
      'expr    := orExpr',
      'orExpr  := andExpr (OR andExpr)*',
      'andExpr := compare (AND compare)*',
      'compare := primary (op primary)?',
      "primary := '(' expr ')' | column | literal",
      '```',
      '',
      'Errors carry a position: `SqlSyntaxError.position` is the offset of the offending token in the',
      'original string. "Syntax error" on its own helps nobody.',
    ].join('\n')
  ),
  checklist: [
    t('关键字大小写不敏感，标识符保留原样', 'Keywords are case-insensitive, identifiers keep their case'),
    t('字符串支持 \'\' 转义', "String literals support '' as an escape"),
    t('>= 不会被切成 > 和 =', '`>=` is not cut into `>` and `=`'),
    t('AND 比 OR 优先级高，括号能覆盖', 'AND binds tighter than OR, parentheses override'),
    t('语法错误带出错位置', 'Syntax errors carry the offending position'),
  ],
  pitfalls: [
    t(
      '切词时先试一字符运算符。`age >= 18` 会被切成 `>`、`=`、`18`，然后解析器在 `=` 上报一个莫名其妙的错。多字符运算符必须**先**匹配，这是词法分析器的通用规则：最长匹配优先。',
      'Trying one-character operators first. `age >= 18` lexes into `>`, `=`, `18` and the parser then reports a baffling error at the `=`. Multi-character operators must be matched first — maximal munch is the general rule for lexers.'
    ),
    t(
      '把关键字判断写成大小写敏感的。`select * from users` 全小写时，`select` 被当成标识符，解析器看到的第一个 token 不是关键字，于是报「期望 SELECT」。大小写不敏感的判断要在**比较时**统一大写，而不是把整条 SQL 转成大写——那会把字符串字面量里的内容也改掉。',
      'Making keyword recognition case-sensitive. In `select * from users` the word `select` becomes an identifier and the parser reports "expected SELECT" on the very first token. Fold case when comparing, not by upper-casing the whole statement — that would also rewrite the contents of string literals.'
    ),
    t(
      '优先级写反：先解析 AND 再在外面套 OR 的循环。`a OR b AND c` 会变成 `AND(OR(a,b), c)`，语义完全不同——一条 WHERE 条件筛出来的行数会差很多，而且不报任何错。优先级低的在**外层**，高的在内层。',
      'Inverting precedence by looping OR inside AND. `a OR b AND c` becomes `AND(OR(a,b), c)`, which is a different predicate entirely — the WHERE clause returns a very different set of rows and nothing reports an error. Lower precedence goes in the outer function, higher precedence further in.'
    ),
    t(
      '解析完不检查是否到达 eof。`SELECT * FROM users GARBAGE` 会安静地成功，尾巴被忽略。用户以为查询生效了，实际上写错的那部分根本没被执行。解析的最后一步必须断言当前 token 是 eof。',
      'Not checking for eof after parsing. `SELECT * FROM users GARBAGE` silently succeeds with the tail ignored, so the user believes their query ran as written when part of it was never executed. The last step of parsing must assert the current token is eof.'
    ),
  ],
  hints: [
    t(
      '解析器维护一个 `index` 和几个小工具：`peek()` 看当前 token，`eat(type, value?)` 匹配并前进、不匹配就抛错。整个解析器就是这两个函数加上一层层的文法函数。',
      'Keep an `index` plus two helpers: `peek()` for the current token and `eat(type, value?)` which matches and advances or throws. The whole parser is those two functions plus one function per grammar level.'
    ),
    t(
      '`SELECT *` 里的 `*` 就是一个普通的运算符 token，在 selectList 里单独判一下它就行，不用为它造新的 token 类型。',
      'The `*` in `SELECT *` is just an operator token; special-case it inside the select list rather than inventing a token type for it.'
    ),
  ],
  extension: t(
    [
      '递归下降的好处是**读起来就是文法**：每个函数对应一条产生式，优先级用嵌套层数表达。',
      '缺点是左递归会直接变成无限递归——`expr := expr op expr` 这种写法必须先改写成循环形式，',
      '这就是上面每层都写成 `X (op X)*` 而不是 `X op X` 的原因。',
      '',
      '真实数据库大多不手写解析器。PostgreSQL 用 flex + bison（LALR），MySQL 也是 bison。',
      '生成器的好处是文法冲突能在编译期被发现；代价是错误信息很难做好——',
      '这也是为什么 PostgreSQL 的语法错误经常只能告诉你「在 X 附近」。',
      '有意思的是新一代引擎在往回走：DuckDB fork 了 PostgreSQL 的解析器，',
      '而 SQLite 用的是自己写的 LALR 生成器 Lemon。',
      '',
      '这一关的表达式解析用的是「一层文法一个函数」。运算符一多（真实 SQL 有十几个优先级）',
      '这个写法会变成一长串几乎一样的函数。工业界的替代方案是 **Pratt 解析**',
      '（又叫 top-down operator precedence）：把优先级做成一张表，一个循环搞定所有二元运算符。',
      'Rust、Go 的编译器和大多数现代解释器用的都是它。',
    ].join('\n'),
    [
      'Recursive descent reads like the grammar: one function per production, precedence expressed as',
      'nesting depth. Its weakness is that left recursion becomes infinite recursion — a rule like',
      '`expr := expr op expr` must be rewritten into a loop, which is why every level above is written',
      '`X (op X)*` rather than `X op X`.',
      '',
      'Most real databases do not hand-write their parser. PostgreSQL uses flex and bison (LALR), and so',
      'does MySQL. Generators catch grammar conflicts at build time; the price is that error messages are',
      'hard to make good, which is why PostgreSQL so often can only tell you "at or near X". Interestingly',
      'the newer engines are moving back: DuckDB forked PostgreSQL\'s parser outright, and SQLite uses',
      'Lemon, its own LALR generator.',
      '',
      'This stage uses one-function-per-level for expressions. With many operators — real SQL has a dozen',
      'precedence levels — that becomes a long series of near-identical functions. The industry',
      'alternative is Pratt parsing (top-down operator precedence), which turns precedence into a table',
      'and handles every binary operator in one loop. The Rust and Go compilers and most modern',
      'interpreters use it.',
    ].join('\n')
  ),
  focus: ['correctness', 'encapsulation', 'elegance'],
  lab: {},
  starterFiles: [
    ast,
    file(
      'src/lexer.ts',
      code`
        import type { Token } from './ast';

        export class SqlSyntaxError extends Error {
          position: number;

          constructor(message: string, position: number) {
            super(message + ' (at ' + position + ')');
            this.name = 'SqlSyntaxError';
            this.position = position;
          }
        }

        export function tokenize(sql: string): Token[] {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
    file(
      'src/parser.ts',
      code`
        import type { Statement } from './ast';

        export function parse(sql: string): Statement {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-8.spec.ts',
      code`
        import { tokenize, SqlSyntaxError } from '../src/lexer';
        import { parse } from '../src/parser';

        describe('阶段8 · 词法分析', () => {
          it('切出关键字、标识符和数字', () => {
            const tokens = tokenize('SELECT id FROM users');
            expect(tokens.map((token) => token.type)).toEqual([
              'keyword',
              'identifier',
              'keyword',
              'identifier',
              'eof',
            ]);
            expect(tokens.map((token) => token.value)).toEqual(['SELECT', 'id', 'FROM', 'users', '']);
          });

          it('关键字大小写不敏感，统一成大写', () => {
            const tokens = tokenize('select ID from Users');
            expect(tokens[0]).toEqual({ type: 'keyword', value: 'SELECT', position: 0 });
            expect(tokens[2].value).toBe('FROM');
            // 标识符保留原样
            expect(tokens[1].value).toBe('ID');
            expect(tokens[3].value).toBe('Users');
          });

          it('两字符运算符不会被切开', () => {
            const tokens = tokenize('a >= 1 AND b != 2 AND c <= 3');
            const operators = tokens.filter((token) => token.type === 'operator').map((token) => token.value);
            expect(operators).toEqual(['>=', '!=', '<=']);
          });

          it('字符串字面量支持两个连写的单引号转义', () => {
            const tokens = tokenize("name = 'it''s ok'");
            const literal = tokens.filter((token) => token.type === 'string')[0];
            expect(literal.value).toBe("it's ok");
          });

          it('未闭合的字符串会报错并带位置', () => {
            let error: any = null;
            try {
              tokenize("name = 'unterminated");
            } catch (caught) {
              error = caught;
            }
            expect(error).toBeInstanceOf(SqlSyntaxError);
            expect(error.position).toBe(7);
          });

          it('非法字符会报错', () => {
            let error: any = null;
            try {
              tokenize('SELECT # FROM t');
            } catch (caught) {
              error = caught;
            }
            expect(error).toBeInstanceOf(SqlSyntaxError);
            expect(error.position).toBe(7);
          });

          it('位置信息指向 token 的起点', () => {
            const tokens = tokenize('SELECT  id');
            expect(tokens[0].position).toBe(0);
            expect(tokens[1].position).toBe(8);
          });
        });

        describe('阶段8 · 语法分析', () => {
          it('解析最简单的 SELECT', () => {
            expect(parse('SELECT * FROM users')).toEqual({
              kind: 'select',
              columns: ['*'],
              table: 'users',
            });
          });

          it('解析列清单', () => {
            const statement: any = parse('SELECT id, name FROM users');
            expect(statement.columns).toEqual(['id', 'name']);
          });

          it('解析 WHERE 比较', () => {
            const statement: any = parse('SELECT * FROM users WHERE age >= 18');
            expect(statement.where).toEqual({
              kind: 'binary',
              op: '>=',
              left: { kind: 'column', name: 'age' },
              right: { kind: 'literal', value: 18 },
            });
          });

          it('字符串字面量进入语法树', () => {
            const statement: any = parse("SELECT * FROM users WHERE city = 'Beijing'");
            expect(statement.where.right).toEqual({ kind: 'literal', value: 'Beijing' });
          });

          it('AND 比 OR 优先级高', () => {
            const statement: any = parse('SELECT * FROM t WHERE a = 1 OR b = 2 AND c = 3');
            expect(statement.where.op).toBe('OR');
            expect(statement.where.left.op).toBe('=');
            expect(statement.where.right.op).toBe('AND');
          });

          it('括号可以覆盖优先级', () => {
            const statement: any = parse('SELECT * FROM t WHERE (a = 1 OR b = 2) AND c = 3');
            expect(statement.where.op).toBe('AND');
            expect(statement.where.left.op).toBe('OR');
          });

          it('多个 AND 左结合', () => {
            const statement: any = parse('SELECT * FROM t WHERE a = 1 AND b = 2 AND c = 3');
            expect(statement.where.op).toBe('AND');
            expect(statement.where.left.op).toBe('AND');
            expect(statement.where.right.left).toEqual({ kind: 'column', name: 'c' });
          });

          it('解析 ORDER BY 与方向', () => {
            const ascending: any = parse('SELECT * FROM t ORDER BY age');
            expect(ascending.orderBy).toEqual({ column: 'age', direction: 'asc' });

            const descending: any = parse('SELECT * FROM t ORDER BY age DESC');
            expect(descending.orderBy).toEqual({ column: 'age', direction: 'desc' });
          });

          it('解析 LIMIT', () => {
            const statement: any = parse('SELECT * FROM t LIMIT 10');
            expect(statement.limit).toBe(10);
          });

          it('子句可以组合', () => {
            const statement: any = parse(
              "SELECT id, name FROM users WHERE age >= 18 AND city = 'Beijing' ORDER BY age DESC LIMIT 5"
            );
            expect(statement.columns).toEqual(['id', 'name']);
            expect(statement.table).toBe('users');
            expect(statement.where.op).toBe('AND');
            expect(statement.orderBy).toEqual({ column: 'age', direction: 'desc' });
            expect(statement.limit).toBe(5);
          });

          it('解析 INSERT', () => {
            expect(parse("INSERT INTO users VALUES (7, 'alice', 1)")).toEqual({
              kind: 'insert',
              table: 'users',
              values: [7, 'alice', 1],
            });
          });

          it('负数字面量', () => {
            const statement: any = parse('SELECT * FROM t WHERE balance < -100');
            expect(statement.where.right).toEqual({ kind: 'literal', value: -100 });
          });

          it('缺少 FROM 会报错并带位置', () => {
            let error: any = null;
            try {
              parse('SELECT *');
            } catch (caught) {
              error = caught;
            }
            expect(error).toBeInstanceOf(SqlSyntaxError);
            expect(typeof error.position).toBe('number');
          });

          it('尾部多余的内容不会被静默忽略', () => {
            let error: any = null;
            try {
              parse('SELECT * FROM users GARBAGE');
            } catch (caught) {
              error = caught;
            }
            expect(error).toBeInstanceOf(SqlSyntaxError);
            expect(error.position).toBe(20);
          });
        });
      `
    ),
  ],
  gates: [],
  referenceFiles: [
    file(
      'src/lexer.ts',
      code`
        import type { Token, TokenType } from './ast';

        export class SqlSyntaxError extends Error {
          position: number;

          constructor(message: string, position: number) {
            super(message + ' (at ' + position + ')');
            this.name = 'SqlSyntaxError';
            this.position = position;
          }
        }

        const KEYWORDS = [
          'SELECT', 'FROM', 'WHERE', 'ORDER', 'BY', 'ASC', 'DESC',
          'LIMIT', 'INSERT', 'INTO', 'VALUES', 'AND', 'OR',
        ];

        // 先长后短：反过来的话 '>=' 会被切成 '>' 和 '='
        const TWO_CHAR_OPERATORS = ['>=', '<=', '!=', '<>'];
        const ONE_CHAR_OPERATORS = ['=', '<', '>', '*', '-'];

        function isSpace(ch: string): boolean {
          return ch === ' ' || ch === '\\t' || ch === '\\n' || ch === '\\r';
        }

        function isDigit(ch: string): boolean {
          return ch >= '0' && ch <= '9';
        }

        function isWordStart(ch: string): boolean {
          return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
        }

        export function tokenize(sql: string): Token[] {
          const tokens: Token[] = [];
          let index = 0;

          while (index < sql.length) {
            const ch = sql[index];

            if (isSpace(ch)) {
              index += 1;
              continue;
            }

            if (ch === "'") {
              const start = index;
              let cursor = index + 1;
              let value = '';
              let closed = false;
              while (cursor < sql.length) {
                if (sql[cursor] === "'") {
                  // 两个连写的单引号是一个转义，不是结束
                  if (sql[cursor + 1] === "'") {
                    value += "'";
                    cursor += 2;
                    continue;
                  }
                  closed = true;
                  cursor += 1;
                  break;
                }
                value += sql[cursor];
                cursor += 1;
              }
              if (!closed) throw new SqlSyntaxError('unterminated string literal', start);
              tokens.push({ type: 'string', value, position: start });
              index = cursor;
              continue;
            }

            if (isDigit(ch)) {
              const start = index;
              while (index < sql.length && isDigit(sql[index])) index += 1;
              tokens.push({ type: 'number', value: sql.slice(start, index), position: start });
              continue;
            }

            if (isWordStart(ch)) {
              const start = index;
              while (index < sql.length && (isWordStart(sql[index]) || isDigit(sql[index]))) index += 1;
              const word = sql.slice(start, index);
              const upper = word.toUpperCase();
              const keyword = KEYWORDS.indexOf(upper) !== -1;
              // 关键字统一大写便于比较，标识符保留原样——
              // 把整条 SQL 转大写会连字符串字面量一起改掉
              const type: TokenType = keyword ? 'keyword' : 'identifier';
              tokens.push({ type, value: keyword ? upper : word, position: start });
              continue;
            }

            const two = sql.slice(index, index + 2);
            if (TWO_CHAR_OPERATORS.indexOf(two) !== -1) {
              tokens.push({ type: 'operator', value: two === '<>' ? '!=' : two, position: index });
              index += 2;
              continue;
            }

            if (ONE_CHAR_OPERATORS.indexOf(ch) !== -1) {
              tokens.push({ type: 'operator', value: ch, position: index });
              index += 1;
              continue;
            }

            if (ch === '(' || ch === ')' || ch === ',') {
              tokens.push({ type: 'punctuation', value: ch, position: index });
              index += 1;
              continue;
            }

            throw new SqlSyntaxError('unexpected character "' + ch + '"', index);
          }

          tokens.push({ type: 'eof', value: '', position: sql.length });
          return tokens;
        }
      `
    ),
    file(
      'src/parser.ts',
      code`
        import type { BinaryOp, CompareOp, Expr, InsertStatement, SelectStatement, Statement, Token } from './ast';
        import { SqlSyntaxError, tokenize } from './lexer';

        const COMPARE_OPS = ['=', '!=', '<', '<=', '>', '>='];

        export function parse(sql: string): Statement {
          const tokens = tokenize(sql);
          let index = 0;

          function peek(): Token {
            return tokens[index];
          }

          function at(type: string, value?: string): boolean {
            const token = peek();
            return token.type === type && (value === undefined || token.value === value);
          }

          function eat(type: string, value?: string): Token {
            const token = peek();
            if (!at(type, value)) {
              throw new SqlSyntaxError(
                'expected ' + (value || type) + ' but found "' + (token.value || 'end of input') + '"',
                token.position
              );
            }
            index += 1;
            return token;
          }

          /* --- 表达式：一层文法一个函数，越往下优先级越高 --- */

          function parsePrimary(): Expr {
            if (at('punctuation', '(')) {
              eat('punctuation', '(');
              const inner = parseExpr();
              eat('punctuation', ')');
              return inner;
            }
            if (at('operator', '-')) {
              eat('operator', '-');
              const literal = eat('number');
              return { kind: 'literal', value: -Number(literal.value) };
            }
            if (at('number')) return { kind: 'literal', value: Number(eat('number').value) };
            if (at('string')) return { kind: 'literal', value: eat('string').value };
            if (at('identifier')) return { kind: 'column', name: eat('identifier').value };

            const token = peek();
            throw new SqlSyntaxError(
              'expected a column or a literal but found "' + (token.value || 'end of input') + '"',
              token.position
            );
          }

          function parseCompare(): Expr {
            const left = parsePrimary();
            if (peek().type === 'operator' && COMPARE_OPS.indexOf(peek().value) !== -1) {
              const op = eat('operator').value as CompareOp;
              return { kind: 'binary', op, left, right: parsePrimary() };
            }
            return left;
          }

          function parseAnd(): Expr {
            let left = parseCompare();
            // 循环而不是递归：文法写成 X (op X)* 才不会左递归
            while (at('keyword', 'AND')) {
              eat('keyword', 'AND');
              left = { kind: 'binary', op: 'AND' as BinaryOp, left, right: parseCompare() };
            }
            return left;
          }

          function parseExpr(): Expr {
            // OR 在最外层，所以它的优先级最低
            let left = parseAnd();
            while (at('keyword', 'OR')) {
              eat('keyword', 'OR');
              left = { kind: 'binary', op: 'OR' as BinaryOp, left, right: parseAnd() };
            }
            return left;
          }

          /* --- 语句 --- */

          function parseSelect(): SelectStatement {
            eat('keyword', 'SELECT');

            const columns: string[] = [];
            if (at('operator', '*')) {
              eat('operator', '*');
              columns.push('*');
            } else {
              columns.push(eat('identifier').value);
              while (at('punctuation', ',')) {
                eat('punctuation', ',');
                columns.push(eat('identifier').value);
              }
            }

            eat('keyword', 'FROM');
            const statement: SelectStatement = { kind: 'select', columns, table: eat('identifier').value };

            if (at('keyword', 'WHERE')) {
              eat('keyword', 'WHERE');
              statement.where = parseExpr();
            }

            if (at('keyword', 'ORDER')) {
              eat('keyword', 'ORDER');
              eat('keyword', 'BY');
              const column = eat('identifier').value;
              let direction: 'asc' | 'desc' = 'asc';
              if (at('keyword', 'ASC')) eat('keyword', 'ASC');
              else if (at('keyword', 'DESC')) {
                eat('keyword', 'DESC');
                direction = 'desc';
              }
              statement.orderBy = { column, direction };
            }

            if (at('keyword', 'LIMIT')) {
              eat('keyword', 'LIMIT');
              statement.limit = Number(eat('number').value);
            }

            return statement;
          }

          function parseInsert(): InsertStatement {
            eat('keyword', 'INSERT');
            eat('keyword', 'INTO');
            const table = eat('identifier').value;
            eat('keyword', 'VALUES');
            eat('punctuation', '(');

            const values: Array<number | string> = [];
            const readValue = () => {
              if (at('operator', '-')) {
                eat('operator', '-');
                values.push(-Number(eat('number').value));
              } else if (at('number')) {
                values.push(Number(eat('number').value));
              } else {
                values.push(eat('string').value);
              }
            };

            readValue();
            while (at('punctuation', ',')) {
              eat('punctuation', ',');
              readValue();
            }
            eat('punctuation', ')');

            return { kind: 'insert', table, values };
          }

          const statement = at('keyword', 'INSERT') ? parseInsert() : parseSelect();

          // 不检查这一步，"SELECT * FROM users GARBAGE" 会安静地成功，
          // 用户以为写的东西生效了，其实尾巴被丢掉了
          if (!at('eof')) {
            throw new SqlSyntaxError('unexpected "' + peek().value + '" after the statement', peek().position);
          }

          return statement;
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**优先级 = 函数嵌套的深度。** `parseExpr` 调 `parseAnd` 调 `parseCompare` 调 `parsePrimary`，',
      '越里层的运算符结合得越紧。想加一个优先级介于 AND 和比较之间的运算符（比如 NOT），',
      '就在这两层之间插一个函数——不用改别的地方。这是递归下降最好的性质。',
      '',
      '**每层都写成 `X (op X)*` 而不是 `X op X`。** 后者是左递归，`parseAnd` 第一件事就是调',
      '`parseAnd`，直接爆栈。改成循环之后顺便得到了左结合：`a AND b AND c` 解析成',
      '`AND(AND(a,b), c)`，和 SQL 的语义一致。',
      '',
      '**关键字统一大写、标识符保留原样。** 一个很有诱惑力的偷懒写法是先把整条 SQL 转成大写再切词，',
      '这样关键字比较就不用管大小写了——代价是 `WHERE city = \'Beijing\'` 变成了 `\'BEIJING\'`，',
      '查询结果直接错掉。大小写折叠只能发生在**比较关键字的那一刻**。',
      '',
      '**最后那句 `if (!at(\'eof\'))`。** 少了它，解析器会在能解析的部分结束时安静返回，',
      '剩下的输入被丢掉。用户写错了一个子句，得到的不是报错，而是一个少了那个子句的正确结果——',
      '这类 bug 在生产上极难被发现。',
    ].join('\n'),
    [
      'Precedence is nesting depth. `parseExpr` calls `parseAnd` calls `parseCompare` calls `parsePrimary`,',
      'and deeper means tighter binding. To add an operator that binds between AND and comparison — NOT,',
      'say — insert one function between those two levels and change nothing else. That is the best',
      'property recursive descent has.',
      '',
      'Every level is `X (op X)*`, never `X op X`. The latter is left recursion: `parseAnd` would call',
      '`parseAnd` as its first act and blow the stack. Rewriting it as a loop also yields left',
      'associativity for free — `a AND b AND c` parses as `AND(AND(a,b), c)`, matching SQL semantics.',
      '',
      'Keywords are folded to upper case, identifiers are not. The tempting shortcut is to upper-case the',
      "whole statement before lexing so keyword comparison stops caring — at the cost of turning",
      "`WHERE city = 'Beijing'` into `'BEIJING'` and returning wrong rows. Case folding may only happen at",
      'the moment a keyword is compared.',
      '',
      "The closing `if (!at('eof'))`. Without it the parser quietly returns as soon as it has consumed",
      'something parseable and drops the rest. A user who mistypes a clause gets no error — just a correct',
      'result for a query missing that clause, which is exceptionally hard to notice in production.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 9 关 · 目录、绑定与逻辑计划                                        */
/* ------------------------------------------------------------------ */

const planTypes = readonlyFile(
  'src/plan.ts',
  code`
    /** 逻辑计划的形状（只读，平台提供） */
    import type { Expr } from './ast';

    export type ColumnType = 'number' | 'string';

    export interface ColumnDef {
      name: string;
      type: ColumnType;
    }

    export interface TableSchema {
      name: string;
      columns: ColumnDef[];
      /** 这张表的堆文件占用的页 */
      pages: number[];
    }

    /** 执行期在算子之间流动的一行 */
    export type Tuple = Record<string, number | string>;

    export type LogicalPlan =
      | { kind: 'scan'; table: string }
      | { kind: 'filter'; input: LogicalPlan; predicate: Expr }
      | { kind: 'project'; input: LogicalPlan; columns: string[] }
      | { kind: 'sort'; input: LogicalPlan; column: string; direction: 'asc' | 'desc' }
      | { kind: 'limit'; input: LogicalPlan; count: number }
      | { kind: 'insert'; table: string; values: Array<number | string> };
  `
);

const stage9 = {
  id: 'planner',
  title: t('第 9 关 · 目录、绑定与逻辑计划', 'Stage 9 · Catalog, binding and the logical plan'),
  goal: t(
    [
      '语法树只说明「这条 SQL 写得合不合语法」，不说明「它指的东西存不存在」。',
      '`SELECT nmae FROM users` 语法完全正确，但 `nmae` 这一列没有。',
      '把名字对应到真实的表和列，这一步叫**绑定**（binding）。',
      '',
      '在 `src/catalog.ts` 实现 `createCatalog()`：登记表名、列定义和堆文件的页列表。',
      '在 `src/planner.ts` 实现 `plan(statement, catalog)`：把语法树变成**逻辑计划**。',
      '',
      '绑定要拒绝四类错误，全都抛 `BindError`：',
      '',
      '1. 表不存在；',
      '2. 引用了不存在的列（SELECT 列表、WHERE、ORDER BY 都要查）；',
      '3. 字面量类型和列类型对不上（`WHERE id = \'abc\'`，id 是数字列）；',
      '4. INSERT 的值个数或类型和表结构不符。',
      '',
      '逻辑计划的**嵌套顺序**就是 SQL 的求值顺序，别写反：',
      '',
      '```',
      'limit(project(sort(filter(scan(users), pred), age, desc), [id, name]), 5)',
      '```',
      '',
      '从里往外读：先扫表、再过滤、再排序、再投影、最后截断。',
      '注意 **sort 在 project 之前**——`ORDER BY age` 在 `age` 没被 SELECT 出来时也必须能用。',
      '',
      '没有 WHERE 就不要套 filter 节点，没有 LIMIT 就不要套 limit 节点。',
      '一个空转的算子在火山模型里是每行一次多余的函数调用。',
    ].join('\n'),
    [
      'A syntax tree says whether the SQL is well-formed, not whether the things it names exist.',
      '`SELECT nmae FROM users` is perfectly grammatical, and there is no column called `nmae`. Resolving',
      'names against real tables and columns is called binding.',
      '',
      'Implement `createCatalog()` in `src/catalog.ts` to register table names, column definitions and the',
      'heap file pages. Implement `plan(statement, catalog)` in `src/planner.ts` to turn a syntax tree into',
      'a logical plan.',
      '',
      'Binding rejects four kinds of error, all as `BindError`:',
      '',
      '1. the table does not exist;',
      '2. a column does not exist (check the select list, the WHERE and the ORDER BY);',
      "3. a literal's type does not match the column's (`WHERE id = 'abc'` where id is numeric);",
      '4. an INSERT whose value count or types do not match the schema.',
      '',
      "The plan's nesting is SQL's evaluation order, and it is easy to get backwards:",
      '',
      '```',
      'limit(project(sort(filter(scan(users), pred), age, desc), [id, name]), 5)',
      '```',
      '',
      'Read it inside out: scan, filter, sort, project, truncate. Note that sort sits below project —',
      '`ORDER BY age` must work even when `age` was not selected.',
      '',
      'Do not wrap a filter node when there is no WHERE, or a limit node when there is no LIMIT. An',
      'operator that does nothing still costs one function call per row in the Volcano model.',
    ].join('\n')
  ),
  checklist: [
    t('SELECT * 展开成真实的列名', 'SELECT * expands to the real column names'),
    t('不存在的表和列都被拒绝', 'Unknown tables and unknown columns are both rejected'),
    t('字面量类型与列类型不符会报错', 'A literal whose type differs from the column is an error'),
    t('计划嵌套顺序是 scan→filter→sort→project→limit', 'Nesting is scan → filter → sort → project → limit'),
    t('没有的子句不产生对应节点', 'An absent clause produces no node'),
  ],
  pitfalls: [
    t(
      '把 sort 套在 project 外面。`SELECT id FROM users ORDER BY age` 会在排序时找不到 `age`——它已经被投影掉了。SQL 规定 ORDER BY 能引用未被选中的列，所以排序必须发生在投影**之前**。',
      'Putting sort above project. `SELECT id FROM users ORDER BY age` then cannot find `age` at sort time because projection already dropped it. SQL allows ORDER BY to reference unselected columns, so sorting must happen below projection.'
    ),
    t(
      '只检查 SELECT 列表里的列名，不检查 WHERE 和 ORDER BY 里的。`SELECT id FROM users WHERE nmae = 1` 会顺利通过绑定，然后在执行期对每一行求值时拿到 undefined，比较结果永远是 false——返回空结果集，没有任何报错。',
      'Validating only the select list and not the WHERE or ORDER BY. `SELECT id FROM users WHERE nmae = 1` binds cleanly, then evaluates to undefined for every row at execution time so the comparison is always false — an empty result set and no error at all.'
    ),
    t(
      '把 `SELECT *` 原样留在计划里，让执行器去展开。执行器于是需要访问 catalog，而它本该只关心算子。展开是绑定阶段的责任：绑定之后的计划里不应该再有任何需要查目录才能理解的东西。',
      'Leaving `SELECT *` in the plan for the executor to expand. The executor then needs the catalog when it should only care about operators. Expansion belongs to binding: after binding, nothing in the plan should require the catalog to interpret.'
    ),
    t(
      '类型检查只比较 `typeof`。`WHERE active = 1` 里 active 是数字列没问题，但如果表结构写的是字符串列而查询传了数字，`typeof 1 === \'number\'` 和列类型 `\'string\'` 不匹配才是要报的错。要拿字面量的实际类型去和**列定义**比，而不是和另一个字面量比。',
      'Type-checking by comparing `typeof` against another literal. The check must compare the literal\'s actual type against the column definition — `WHERE active = 1` is fine when active is numeric and must be rejected when the schema says string.'
    ),
  ],
  hints: [
    t(
      '遍历 Expr 找列引用写成一个递归函数：遇到 `column` 就检查，遇到 `binary` 就递归左右两边。类型检查在 `binary` 那一层做——左边是列、右边是字面量时才有得比。',
      'Walk the Expr with one recursive function: check `column` nodes, recurse into both sides of `binary`. Do type checking at the `binary` level, where a column on one side and a literal on the other give you something to compare.'
    ),
    t(
      '按 scan → filter → sort → project → limit 的顺序，每一步判断「这个子句在不在」，在就把当前计划包一层。计划是从内往外一层层套出来的。',
      'Go in order — scan, filter, sort, project, limit — and at each step wrap the current plan only if that clause is present. The plan is built from the inside out.'
    ),
  ],
  extension: t(
    [
      '真实的绑定器要处理这一关全部跳过的东西：多张表（FROM a, b）带来的**列名歧义**，',
      '需要用表名限定；子查询引入的**作用域嵌套**，内层能看见外层的列（相关子查询）；',
      '还有别名（`SELECT a AS b`）导致的「同一个名字在不同子句里指不同东西」。',
      'PostgreSQL 把这一步叫 parse analysis，输出的 `Query` 结构比语法树复杂得多。',
      '',
      '「绑定之后计划里不该再有需要查目录的东西」这条原则有个实际后果：**计划缓存**。',
      '同一条 SQL 反复执行时，解析和绑定的结果可以缓存起来复用。但一旦表结构变了',
      '（加了一列、改了类型），缓存的计划就失效了——所以数据库要给每张表维护一个版本号，',
      'DDL 之后让相关的缓存计划全部作废。Oracle 的「硬解析 vs 软解析」说的就是这件事。',
      '',
      '还有一个顺序问题这里做了简化：真实 SQL 的求值顺序是',
      'FROM → WHERE → GROUP BY → HAVING → SELECT → ORDER BY → LIMIT，',
      'ORDER BY 之所以排在 SELECT 之后，是因为它**可以**引用 SELECT 里定义的别名；',
      '但它同时又能引用没被选中的原始列。这两件事同时成立，是 SQL 里最反直觉的规则之一。',
    ].join('\n'),
    [
      'A real binder handles everything this stage skips: column ambiguity across multiple tables',
      '(FROM a, b) requiring qualification; nested scopes from subqueries where the inner query can see',
      'outer columns (correlated subqueries); and aliases (`SELECT a AS b`) making one name mean different',
      'things in different clauses. PostgreSQL calls this step parse analysis, and its `Query` structure is',
      'far richer than the syntax tree.',
      '',
      'The rule "after binding, nothing needs the catalog" has a practical consequence: plan caching. When',
      'the same SQL runs repeatedly, parsing and binding can be cached and reused — until the schema',
      'changes, at which point the cached plan is invalid. So databases keep a version number per table and',
      'invalidate dependent plans after DDL. That is exactly what Oracle means by hard versus soft parse.',
      '',
      'One ordering detail is simplified here. Real SQL evaluates',
      'FROM → WHERE → GROUP BY → HAVING → SELECT → ORDER BY → LIMIT, and ORDER BY comes after SELECT',
      'because it may reference aliases defined there — while also being able to reference original columns',
      'that were never selected. Both being true at once is one of the least intuitive rules in SQL.',
    ].join('\n')
  ),
  focus: ['correctness', 'encapsulation', 'elegance'],
  lab: {},
  starterFiles: [
    planTypes,
    file(
      'src/catalog.ts',
      code`
        import type { ColumnDef, TableSchema } from './plan';

        export interface Catalog {
          createTable(name: string, columns: ColumnDef[], pages: number[]): void;
          getTable(name: string): TableSchema | null;
          /** 表被写入之后页列表会变，要能更新 */
          setPages(name: string, pages: number[]): void;
          tables(): string[];
        }

        export function createCatalog(): Catalog {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
    file(
      'src/planner.ts',
      code`
        import type { Statement } from './ast';
        import type { LogicalPlan } from './plan';
        import type { Catalog } from './catalog';

        /** 语法对但引用了不存在的东西 */
        export class BindError extends Error {
          constructor(message: string) {
            super(message);
            this.name = 'BindError';
          }
        }

        export function plan(statement: Statement, catalog: Catalog): LogicalPlan {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-9.spec.ts',
      code`
        import { createCatalog } from '../src/catalog';
        import { plan, BindError } from '../src/planner';
        import { parse } from '../src/parser';

        function catalogWithUsers() {
          const catalog = createCatalog();
          catalog.createTable(
            'users',
            [
              { name: 'id', type: 'number' },
              { name: 'name', type: 'string' },
              { name: 'active', type: 'number' },
            ],
            [0, 1]
          );
          return catalog;
        }

        function planFor(sql: string) {
          return plan(parse(sql), catalogWithUsers()) as any;
        }

        function expectBindError(sql: string) {
          let error: unknown = null;
          try {
            planFor(sql);
          } catch (caught) {
            error = caught;
          }
          expect(error).toBeInstanceOf(BindError);
        }

        describe('阶段9 · 目录', () => {
          it('登记之后能查到表结构', () => {
            const catalog = catalogWithUsers();
            const table = catalog.getTable('users');
            expect(table).not.toBeNull();
            expect(table!.columns.map((column) => column.name)).toEqual(['id', 'name', 'active']);
            expect(table!.pages).toEqual([0, 1]);
          });

          it('没登记的表返回 null', () => {
            expect(catalogWithUsers().getTable('ghosts')).toBeNull();
          });

          it('页列表可以更新', () => {
            const catalog = catalogWithUsers();
            catalog.setPages('users', [0, 1, 2, 3]);
            expect(catalog.getTable('users')!.pages).toEqual([0, 1, 2, 3]);
          });

          it('tables 列出所有表名', () => {
            const catalog = catalogWithUsers();
            catalog.createTable('orders', [{ name: 'id', type: 'number' }], [9]);
            expect(catalog.tables().sort()).toEqual(['orders', 'users']);
          });
        });

        describe('阶段9 · 绑定与逻辑计划', () => {
          it('最简单的查询是 project(scan)', () => {
            const logical = planFor('SELECT id FROM users');
            expect(logical.kind).toBe('project');
            expect(logical.columns).toEqual(['id']);
            expect(logical.input).toEqual({ kind: 'scan', table: 'users' });
          });

          it('SELECT * 在绑定期就展开成真实列名', () => {
            const logical = planFor('SELECT * FROM users');
            expect(logical.kind).toBe('project');
            // 计划里不该再留下需要查目录才能理解的 '*'
            expect(logical.columns).toEqual(['id', 'name', 'active']);
          });

          it('WHERE 变成 filter 节点', () => {
            const logical = planFor('SELECT id FROM users WHERE active = 1');
            expect(logical.kind).toBe('project');
            expect(logical.input.kind).toBe('filter');
            expect(logical.input.input).toEqual({ kind: 'scan', table: 'users' });
          });

          it('没有 WHERE 就没有 filter 节点', () => {
            const logical = planFor('SELECT id FROM users');
            expect(logical.input.kind).toBe('scan');
          });

          it('ORDER BY 排在 project 下面', () => {
            const logical = planFor('SELECT id FROM users ORDER BY name DESC');
            expect(logical.kind).toBe('project');
            expect(logical.input.kind).toBe('sort');
            expect(logical.input.column).toBe('name');
            expect(logical.input.direction).toBe('desc');
          });

          it('ORDER BY 可以用没被选中的列', () => {
            const logical = planFor('SELECT id FROM users ORDER BY name');
            expect(logical.columns).toEqual(['id']);
            expect(logical.input.column).toBe('name');
          });

          it('LIMIT 在最外层', () => {
            const logical = planFor('SELECT id FROM users LIMIT 3');
            expect(logical.kind).toBe('limit');
            expect(logical.count).toBe(3);
            expect(logical.input.kind).toBe('project');
          });

          it('完整查询的嵌套顺序', () => {
            const logical = planFor(
              "SELECT id, name FROM users WHERE active = 1 ORDER BY name DESC LIMIT 2"
            );
            expect(logical.kind).toBe('limit');
            expect(logical.input.kind).toBe('project');
            expect(logical.input.input.kind).toBe('sort');
            expect(logical.input.input.input.kind).toBe('filter');
            expect(logical.input.input.input.input.kind).toBe('scan');
          });

          it('表不存在会报 BindError', () => {
            expectBindError('SELECT id FROM ghosts');
          });

          it('SELECT 列表里的未知列会报错', () => {
            expectBindError('SELECT nmae FROM users');
          });

          it('WHERE 里的未知列会报错', () => {
            expectBindError('SELECT id FROM users WHERE nmae = 1');
          });

          it('ORDER BY 里的未知列会报错', () => {
            expectBindError('SELECT id FROM users ORDER BY nmae');
          });

          it('字面量类型和列类型不符会报错', () => {
            expectBindError("SELECT id FROM users WHERE id = 'abc'");
            expectBindError('SELECT id FROM users WHERE name = 1');
          });

          it('类型相符则通过', () => {
            const logical = planFor("SELECT id FROM users WHERE name = 'alice'");
            expect(logical.input.kind).toBe('filter');
          });

          it('嵌套表达式里的列也会被检查', () => {
            expectBindError('SELECT id FROM users WHERE active = 1 AND nmae = 2');
          });

          it('INSERT 变成 insert 节点', () => {
            const logical = plan(parse("INSERT INTO users VALUES (1, 'alice', 1)"), catalogWithUsers()) as any;
            expect(logical).toEqual({ kind: 'insert', table: 'users', values: [1, 'alice', 1] });
          });

          it('INSERT 值的个数不对会报错', () => {
            expectBindError('INSERT INTO users VALUES (1)');
          });

          it('INSERT 值的类型不对会报错', () => {
            expectBindError("INSERT INTO users VALUES ('one', 'alice', 1)");
          });
        });
      `
    ),
  ],
  gates: [],
  referenceFiles: [
    file(
      'src/catalog.ts',
      code`
        import type { ColumnDef, TableSchema } from './plan';

        export interface Catalog {
          createTable(name: string, columns: ColumnDef[], pages: number[]): void;
          getTable(name: string): TableSchema | null;
          setPages(name: string, pages: number[]): void;
          tables(): string[];
        }

        export function createCatalog(): Catalog {
          const schemas = new Map<string, TableSchema>();

          return {
            createTable(name: string, columns: ColumnDef[], pages: number[]): void {
              schemas.set(name, { name, columns: columns.slice(), pages: pages.slice() });
            },

            getTable(name: string): TableSchema | null {
              const schema = schemas.get(name);
              if (!schema) return null;
              // 交出副本：调用方改坏了目录，后面所有查询都会跟着错
              return { name: schema.name, columns: schema.columns.slice(), pages: schema.pages.slice() };
            },

            setPages(name: string, pages: number[]): void {
              const schema = schemas.get(name);
              if (!schema) throw new Error('unknown table: ' + name);
              schema.pages = pages.slice();
            },

            tables(): string[] {
              return Array.from(schemas.keys());
            },
          };
        }
      `
    ),
    file(
      'src/planner.ts',
      code`
        import type { Expr, SelectStatement, Statement } from './ast';
        import type { ColumnDef, LogicalPlan, TableSchema } from './plan';
        import type { Catalog } from './catalog';

        export class BindError extends Error {
          constructor(message: string) {
            super(message);
            this.name = 'BindError';
          }
        }

        function columnOf(schema: TableSchema, name: string): ColumnDef {
          const column = schema.columns.filter((candidate) => candidate.name === name)[0];
          if (!column) {
            throw new BindError(
              'column "' + name + '" does not exist on table "' + schema.name + '"'
            );
          }
          return column;
        }

        /**
         * 递归检查表达式里的每一个列引用和每一处类型。
         * 只查 SELECT 列表是不够的：WHERE 里的错别字会在执行期
         * 静默求值成 undefined，返回一个空结果集而不报任何错。
         */
        function checkExpr(expr: Expr, schema: TableSchema): void {
          if (expr.kind === 'column') {
            columnOf(schema, expr.name);
            return;
          }
          if (expr.kind === 'literal') return;

          checkExpr(expr.left, schema);
          checkExpr(expr.right, schema);

          if (expr.op === 'AND' || expr.op === 'OR') return;

          // 列和字面量放在一起比较时，拿字面量的实际类型去对列定义
          const sides: Array<[Expr, Expr]> = [
            [expr.left, expr.right],
            [expr.right, expr.left],
          ];
          for (const pair of sides) {
            if (pair[0].kind === 'column' && pair[1].kind === 'literal') {
              const column = columnOf(schema, pair[0].name);
              const actual = typeof pair[1].value === 'number' ? 'number' : 'string';
              if (actual !== column.type) {
                throw new BindError(
                  'column "' + column.name + '" is ' + column.type + ' but the literal is ' + actual
                );
              }
            }
          }
        }

        function planSelect(statement: SelectStatement, schema: TableSchema): LogicalPlan {
          // 从内往外一层层套，顺序就是 SQL 的求值顺序
          let current: LogicalPlan = { kind: 'scan', table: schema.name };

          if (statement.where) {
            checkExpr(statement.where, schema);
            current = { kind: 'filter', input: current, predicate: statement.where };
          }

          if (statement.orderBy) {
            // sort 必须在 project 之前：ORDER BY 能引用没被选中的列
            columnOf(schema, statement.orderBy.column);
            current = {
              kind: 'sort',
              input: current,
              column: statement.orderBy.column,
              direction: statement.orderBy.direction,
            };
          }

          // '*' 在这里就展开：绑定之后的计划不该再有需要查目录才能理解的东西
          const columns =
            statement.columns.length === 1 && statement.columns[0] === '*'
              ? schema.columns.map((column) => column.name)
              : statement.columns.map((name) => columnOf(schema, name).name);
          current = { kind: 'project', input: current, columns };

          if (statement.limit !== undefined) {
            current = { kind: 'limit', input: current, count: statement.limit };
          }

          return current;
        }

        export function plan(statement: Statement, catalog: Catalog): LogicalPlan {
          const schema = catalog.getTable(statement.table);
          if (!schema) throw new BindError('table "' + statement.table + '" does not exist');

          if (statement.kind === 'insert') {
            if (statement.values.length !== schema.columns.length) {
              throw new BindError(
                'table "' + schema.name + '" has ' + schema.columns.length +
                  ' columns but ' + statement.values.length + ' values were given'
              );
            }
            statement.values.forEach((value, index) => {
              const expected = schema.columns[index].type;
              const actual = typeof value === 'number' ? 'number' : 'string';
              if (actual !== expected) {
                throw new BindError(
                  'column "' + schema.columns[index].name + '" is ' + expected + ' but got ' + actual
                );
              }
            });
            return { kind: 'insert', table: schema.name, values: statement.values.slice() };
          }

          return planSelect(statement, schema);
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**绑定的产出是一个「自足」的计划。** 判断标准很简单：把 catalog 扔掉之后，',
      '这个计划还能不能被理解？所以 `*` 必须在这里展开，列名必须在这里验证过。',
      '做到这一点之后，执行器就只需要知道算子，不需要知道数据库里有哪些表——',
      '这也是计划能被缓存复用的前提。',
      '',
      '**`checkExpr` 递归的是整棵表达式树，不是只看顶层。** `WHERE active = 1 AND nmae = 2`',
      '的顶层是 AND，两边才是比较。只检查顶层的实现会放过右边那个错别字，',
      '而它在执行期的表现是「这个条件永远为假」——查询返回空结果，没有任何报错。',
      '这类 bug 用户通常会怪数据，不会怪 SQL。',
      '',
      '**sort 在 project 下面。** 这是 SQL 语义决定的，不是随意选的：',
      '`SELECT id FROM users ORDER BY name` 里 `name` 在投影之后已经不存在了。',
      '把 sort 套在外面的实现会在执行期拿不到排序列，而这条 SQL 是完全合法的。',
      '',
      '**`getTable` 返回副本。** 目录是全局共享的，返回内部对象意味着任何一个调用方',
      '不小心 push 了一个列，之后所有查询的绑定结果都会跟着变。',
    ].join('\n'),
    [
      'Binding produces a self-contained plan. The test is simple: throw the catalog away — is the plan',
      'still meaningful? That is why `*` must be expanded here and why column names must be validated',
      'here. Once that holds, the executor only needs to know about operators, not about which tables',
      'exist — which is also the precondition for caching and reusing plans.',
      '',
      '`checkExpr` recurses through the whole expression rather than inspecting the top. The top of',
      '`WHERE active = 1 AND nmae = 2` is an AND, with the comparisons underneath. Checking only the top',
      'lets the typo through, and at execution time it behaves as a permanently false condition — an empty',
      'result set with no error. Users blame the data for that, never the SQL.',
      '',
      'Sort sits below project. SQL semantics require it, it is not a free choice: in',
      '`SELECT id FROM users ORDER BY name`, `name` no longer exists after projection. Wrapping sort',
      'outside leaves the sort key unavailable at execution time for a perfectly legal statement.',
      '',
      '`getTable` returns a copy. The catalog is shared globally; handing out the internal object means one',
      'caller accidentally pushing a column changes how every later query binds.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 10 关 · 火山模型执行器                                             */
/* ------------------------------------------------------------------ */

const stage10 = {
  id: 'executor',
  title: t('第 10 关 · 火山模型执行器', 'Stage 10 · The Volcano executor'),
  goal: t(
    [
      '计划有了，现在让它跑起来。做法叫**火山模型**（Volcano / iterator model）：',
      '每个算子都只暴露一个 `next()`，返回一行或者 `null`；算子之间靠嵌套组装，',
      '最外层每调一次 `next()`，这个请求就沿着算子树一路传到最底下的扫描算子。',
      '',
      '在 `src/executor.ts` 实现：',
      '',
      '- `evaluate(expr, tuple)`：对一行求表达式的值，比较返回布尔，AND/OR 短路；',
      '- `buildOperator(plan, ctx)`：把逻辑计划变成算子树，`ctx` 里有 catalog 和 pager。',
      '',
      '要实现的算子：`scan`（读堆文件）、`filter`、`project`、`sort`、`limit`、`insert`。',
      '',
      '**这一关真正要理解的是流式和阻塞的区别。**',
      '',
      '`filter`、`project`、`limit` 是**流式**的：拿一行处理一行，内存占用是常数。',
      '`sort` 是**阻塞**的：不把全部输入读完就没法知道第一行是谁，所以它必须先把',
      '所有行攒起来。一个算子树里只要有阻塞算子，它下面的部分就享受不到 `LIMIT` 的提前退出。',
      '',
      '所以 `SELECT * FROM users LIMIT 1` 只应该读**一页**，而',
      '`SELECT * FROM users ORDER BY name LIMIT 1` 必须读完整张表——这两件事都要成立。',
      '',
      '不要在 `filter` 或 `project` 里先把输入读干净再处理，那会让整棵树变成阻塞的。',
    ].join('\n'),
    [
      'The plan exists; now make it run. The technique is the Volcano (iterator) model: every operator',
      'exposes only `next()`, returning one row or `null`, and operators nest. Each `next()` at the top',
      'travels down the tree to the scan at the bottom.',
      '',
      'Implement in `src/executor.ts`:',
      '',
      '- `evaluate(expr, tuple)`: evaluate an expression against one row, comparisons yield booleans,',
      '  AND/OR short-circuit;',
      '- `buildOperator(plan, ctx)`: turn a logical plan into an operator tree, with catalog and pager in `ctx`.',
      '',
      'Operators to build: `scan` (over the heap file), `filter`, `project`, `sort`, `limit`, `insert`.',
      '',
      'What this stage is really about is the difference between streaming and blocking.',
      '',
      '`filter`, `project` and `limit` stream: one row in, one row out, constant memory. `sort` blocks —',
      'it cannot know which row comes first until it has seen them all, so it must accumulate everything.',
      'Any blocking operator in the tree denies everything below it the early exit that `LIMIT` provides.',
      '',
      'So `SELECT * FROM users LIMIT 1` should read exactly one page, while',
      '`SELECT * FROM users ORDER BY name LIMIT 1` must read the whole table. Both have to be true.',
      '',
      'Do not drain the input inside `filter` or `project` before processing — that makes the whole tree',
      'blocking.',
    ].join('\n')
  ),
  checklist: [
    t('每个算子只暴露 next()，一次一行', 'Every operator exposes only next(), one row at a time'),
    t('filter / project / limit 是流式的', 'filter, project and limit stream'),
    t('LIMIT 让下层提前停下来', 'LIMIT stops the layers below early'),
    t('sort 是阻塞的，它下面享受不到提前退出', 'sort blocks, and nothing below it exits early'),
    t('AND / OR 短路求值', 'AND and OR short-circuit'),
  ],
  pitfalls: [
    t(
      '在 filter 里先把输入全读进数组再筛。用例一条都不会挂，因为结果完全正确。但整棵树从此变成阻塞的：`LIMIT 1` 依然要扫全表，内存占用从常数变成表的大小。火山模型的价值就在流式，这么写等于把它扔了。',
      'Draining the input into an array inside filter before filtering. Not one spec fails, because the results are exactly right. But the whole tree becomes blocking: `LIMIT 1` still scans the entire table and memory goes from constant to table-sized. Streaming is the entire value of the model, and this throws it away.'
    ),
    t(
      'limit 算子数够了就返回 null，但不停止调用下层。少了这个提前退出，下层扫描算子会一直被拉到底——虽然结果对，但 `LIMIT 1` 和没有 LIMIT 一样贵。真正的提前退出是「拉够了就再也不调 input.next()」。',
      'Returning null once the limit is reached without ceasing to pull from the input. The result is right, but `LIMIT 1` costs the same as no limit at all. Real early exit means never calling `input.next()` again once you have enough.'
    ),
    t(
      'AND / OR 用 `&&` 之前先把两边都求了值。对这一关的纯表达式没有可见影响，但一旦表达式里出现函数调用或子查询，短路就不只是性能问题，而是语义问题：`WHERE x != 0 AND 10 / x > 1` 依赖短路才不会除零。',
      'Evaluating both sides before combining with `&&`. It makes no visible difference for pure expressions here, but once function calls or subqueries appear, short-circuiting stops being a performance question and becomes a semantic one: `WHERE x != 0 AND 10 / x > 1` relies on it to avoid dividing by zero.'
    ),
    t(
      'project 直接改传进来的那个 tuple 对象（删掉不要的键）。下层算子可能还持有同一个引用——比如 sort 把整批行攒在数组里——于是排序结果里的行被投影算子改掉了。算子之间传递的行要当成只读的，投影应该**造一个新对象**。',
      'Mutating the incoming tuple in project by deleting unwanted keys. A lower operator may still hold that reference — sort keeps whole batches in an array — so its buffered rows get rewritten by the projection. Rows passed between operators are read-only; projection must build a new object.'
    ),
  ],
  hints: [
    t(
      '每个算子写成一个返回 `{ next }` 的函数，状态放闭包里。filter 的 next 是一个 `while (true)`：拉一行，不满足就继续拉，满足就返回，拉到 null 就返回 null。',
      'Write each operator as a function returning `{ next }`, keeping state in the closure. filter\'s next is a `while (true)`: pull a row, keep pulling while the predicate is false, return it when true, return null when the input is exhausted.'
    ),
    t(
      'sort 用一个 `loaded` 布尔标记：第一次调 next 时把输入拉干净并排好序，之后每次从数组里吐一个。',
      'Give sort a `loaded` flag: on the first `next`, drain and sort the input, then hand out one buffered row per call.'
    ),
  ],
  extension: t(
    [
      '火山模型统治了三十年，因为它把「算子」变成了一个可以自由组合的积木：',
      '任何算子的输入都只是另一个 `next()`，加一种新算子不需要动别的任何代码。',
      'PostgreSQL 到今天仍然是这个结构（`ExecProcNode`）。',
      '',
      '它的问题在**每行一次虚函数调用**。扫一亿行就是一亿次调用，每次只处理一行，',
      'CPU 的分支预测和 SIMD 全都用不上，指令缓存也一直在算子之间跳。',
      '2005 年 MonetDB/X100 的论文指出了这一点，解法是**向量化**：',
      '`next()` 一次返回一批（比如 1024 行）而不是一行，函数调用摊薄了一千倍，',
      '批内还能用 SIMD 一次算多行。DuckDB、ClickHouse、Velox 走的都是这条路。',
      '',
      '另一条路是**编译执行**：把整个算子树编译成一个专门的循环（LLVM 或者生成源码再编译），',
      '彻底消灭算子边界。Hyper 和 Spark 的 whole-stage codegen 是代表。',
      '代价是编译本身要时间，所以短查询反而更慢——真实系统通常两种都留着，按查询规模选。',
      '',
      '至于阻塞算子，`sort` 只是最常见的一个。`hash join` 的建表侧、`group by` 的聚合、',
      '`count(*)` 都是阻塞的。优化器很在意这个：一个计划里阻塞算子的位置，',
      '直接决定了 `LIMIT` 能不能生效、以及内存峰值有多高。',
    ].join('\n'),
    [
      'The Volcano model ruled for thirty years because it turns operators into freely composable blocks:',
      "any operator's input is just another `next()`, and adding a new operator touches no existing code.",
      'PostgreSQL still has this shape today (`ExecProcNode`).',
      '',
      'Its problem is one virtual call per row. Scanning a hundred million rows means a hundred million',
      'calls each handling a single row, so branch prediction and SIMD are unusable and the instruction',
      'cache thrashes between operators. The MonetDB/X100 paper made this argument in 2005, and the answer',
      'is vectorisation: `next()` returns a batch (1024 rows, say) instead of a row, amortising the call a',
      'thousandfold and letting SIMD work within a batch. DuckDB, ClickHouse and Velox all took this road.',
      '',
      'The other road is compilation: turn the whole operator tree into one specialised loop, via LLVM or',
      'by generating and compiling source, erasing operator boundaries entirely. Hyper and Spark',
      'whole-stage codegen are the examples. Compilation itself costs time, so short queries get slower —',
      'real systems keep both and choose by query size.',
      '',
      'As for blocking operators, `sort` is merely the most familiar. The build side of a hash join,',
      'aggregation for `group by` and `count(*)` all block. Optimisers care a great deal about this: where',
      'the blocking operators sit decides whether `LIMIT` helps at all and how high memory peaks.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/executor.ts',
      code`
        import type { Expr } from './ast';
        import type { LogicalPlan, Tuple } from './plan';
        import type { Pager } from './contract';
        import type { Catalog } from './catalog';

        export interface Operator {
          next(): Promise<Tuple | null>;
        }

        export interface ExecutionContext {
          catalog: Catalog;
          pager: Pager;
        }

        /** 对一行求表达式的值 */
        export function evaluate(expr: Expr, tuple: Tuple): number | string | boolean {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }

        export function buildOperator(plan: LogicalPlan, ctx: ExecutionContext): Operator {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-10.spec.ts',
      code`
        import { buildOperator, evaluate } from '../src/executor';
        import { createCatalog } from '../src/catalog';
        import { createHeapFile } from '../src/heap';
        import { createPager } from '../src/pager';
        import { plan } from '../src/planner';
        import { parse } from '../src/parser';
        import { Disk } from '../src/disk';
        import { count, getCounters } from '@lab/metrics';

        const COLUMNS = [
          { name: 'id', type: 'number' as const },
          { name: 'name', type: 'string' as const },
          { name: 'active', type: 'number' as const },
        ];

        async function seed(rowCount: number, capacity = 64) {
          const disk = new Disk();
          const pager = createPager(disk, { capacity });
          const heap = await createHeapFile(pager);
          for (let index = 0; index < rowCount; index += 1) {
            await heap.insert({ id: index, name: 'user' + index, active: index % 2 });
          }
          const catalog = createCatalog();
          catalog.createTable('users', COLUMNS, heap.pages());
          return { disk, pager, catalog, pages: heap.pages() };
        }

        async function run(sql: string, ctx: any) {
          const operator = buildOperator(plan(parse(sql), ctx.catalog), ctx);
          const rows: any[] = [];
          let tuple = await operator.next();
          while (tuple) {
            rows.push(tuple);
            tuple = await operator.next();
          }
          return rows;
        }

        describe('阶段10 · 表达式求值', () => {
          it('列引用和字面量', () => {
            expect(evaluate({ kind: 'column', name: 'id' }, { id: 7 })).toBe(7);
            expect(evaluate({ kind: 'literal', value: 'x' }, {})).toBe('x');
          });

          it('比较运算符', () => {
            const tuple = { id: 5, name: 'alice' };
            const compare = (op: any, value: any) =>
              evaluate(
                { kind: 'binary', op, left: { kind: 'column', name: 'id' }, right: { kind: 'literal', value } },
                tuple
              );
            expect(compare('=', 5)).toBe(true);
            expect(compare('!=', 5)).toBe(false);
            expect(compare('<', 6)).toBe(true);
            expect(compare('<=', 5)).toBe(true);
            expect(compare('>', 4)).toBe(true);
            expect(compare('>=', 6)).toBe(false);
          });

          it('字符串也能比较', () => {
            expect(
              evaluate(
                {
                  kind: 'binary',
                  op: '=',
                  left: { kind: 'column', name: 'name' },
                  right: { kind: 'literal', value: 'alice' },
                },
                { name: 'alice' }
              )
            ).toBe(true);
          });

          it('AND / OR', () => {
            const yes = { kind: 'literal' as const, value: 1 };
            const truthy = { kind: 'binary' as const, op: '=' as const, left: yes, right: yes };
            const falsy = {
              kind: 'binary' as const,
              op: '=' as const,
              left: yes,
              right: { kind: 'literal' as const, value: 2 },
            };
            expect(evaluate({ kind: 'binary', op: 'AND', left: truthy, right: truthy }, {})).toBe(true);
            expect(evaluate({ kind: 'binary', op: 'AND', left: truthy, right: falsy }, {})).toBe(false);
            expect(evaluate({ kind: 'binary', op: 'OR', left: falsy, right: truthy }, {})).toBe(true);
            expect(evaluate({ kind: 'binary', op: 'OR', left: falsy, right: falsy }, {})).toBe(false);
          });
        });

        describe('阶段10 · 算子', () => {
          it('扫描吐出全部行', async () => {
            const ctx = await seed(12);
            const rows = await run('SELECT * FROM users', ctx);
            expect(rows).toHaveLength(12);
            expect(rows[0]).toEqual({ id: 0, name: 'user0', active: 0 });
          });

          it('空表返回空结果', async () => {
            const ctx = await seed(0);
            expect(await run('SELECT * FROM users', ctx)).toEqual([]);
          });

          it('WHERE 过滤', async () => {
            const ctx = await seed(12);
            const rows = await run('SELECT * FROM users WHERE active = 1', ctx);
            expect(rows).toHaveLength(6);
            expect(rows.every((row: any) => row.active === 1)).toBe(true);
          });

          it('投影只留下选中的列', async () => {
            const ctx = await seed(4);
            const rows = await run('SELECT id FROM users', ctx);
            expect(Object.keys(rows[0])).toEqual(['id']);
          });

          it('投影不会改坏下层传上来的行', async () => {
            const ctx = await seed(6);
            const projected = await run('SELECT id FROM users ORDER BY name', ctx);
            // sort 把整批行攒在数组里，project 若原地删键会把它们一起改掉
            expect(projected).toHaveLength(6);
            expect(Object.keys(projected[0])).toEqual(['id']);
          });

          it('ORDER BY 升序和降序', async () => {
            const ctx = await seed(6);
            const ascending = await run('SELECT id FROM users ORDER BY id', ctx);
            expect(ascending.map((row: any) => row.id)).toEqual([0, 1, 2, 3, 4, 5]);

            const descending = await run('SELECT id FROM users ORDER BY id DESC', ctx);
            expect(descending.map((row: any) => row.id)).toEqual([5, 4, 3, 2, 1, 0]);
          });

          it('按字符串列排序', async () => {
            const ctx = await seed(3);
            const rows = await run('SELECT name FROM users ORDER BY name DESC', ctx);
            expect(rows.map((row: any) => row.name)).toEqual(['user2', 'user1', 'user0']);
          });

          it('LIMIT 截断', async () => {
            const ctx = await seed(12);
            expect(await run('SELECT * FROM users LIMIT 3', ctx)).toHaveLength(3);
            expect(await run('SELECT * FROM users LIMIT 0', ctx)).toHaveLength(0);
          });

          it('LIMIT 大于总行数也没问题', async () => {
            const ctx = await seed(3);
            expect(await run('SELECT * FROM users LIMIT 100', ctx)).toHaveLength(3);
          });

          it('完整流水线', async () => {
            const ctx = await seed(20);
            const rows = await run(
              'SELECT id, name FROM users WHERE active = 1 ORDER BY id DESC LIMIT 3',
              ctx
            );
            expect(rows.map((row: any) => row.id)).toEqual([19, 17, 15]);
            expect(Object.keys(rows[0]).sort()).toEqual(['id', 'name']);
          });

          it('INSERT 之后扫得到新行', async () => {
            const ctx = await seed(3);
            const inserted = await run("INSERT INTO users VALUES (99, 'zoe', 1)", ctx);
            expect(inserted).toHaveLength(1);

            const rows = await run('SELECT * FROM users WHERE id = 99', ctx);
            expect(rows).toEqual([{ id: 99, name: 'zoe', active: 1 }]);
          });

          it('sort 是阻塞算子：它下面享受不到提前退出', async () => {
            const disk = new Disk();
            const warm = createPager(disk, { capacity: 64 });
            const heap = await createHeapFile(warm);
            for (let index = 0; index < 40; index += 1) {
              await heap.insert({ id: index, name: 'user' + index, active: index % 2 });
            }
            const pages = heap.pages();
            await warm.flush();

            const catalog = createCatalog();
            catalog.createTable('users', COLUMNS, pages);
            const cold = createPager(disk, { capacity: 1 });

            const before = getCounters()['diskReads'] || 0;
            await run('SELECT * FROM users ORDER BY name LIMIT 1', { catalog, pager: cold });
            const reads = (getCounters()['diskReads'] || 0) - before;

            // 排序必须看完所有行才知道第一行是谁
            expect(reads).toBeGreaterThanOrEqual(pages.length);
          });

          it('LIMIT 让扫描提前停下 [gate:early-exit]', async () => {
            const disk = new Disk();
            const warm = createPager(disk, { capacity: 64 });
            const heap = await createHeapFile(warm);
            for (let index = 0; index < 40; index += 1) {
              await heap.insert({ id: index, name: 'user' + index, active: index % 2 });
            }
            const pages = heap.pages();
            await warm.flush();

            const catalog = createCatalog();
            catalog.createTable('users', COLUMNS, pages);
            const cold = createPager(disk, { capacity: 1 });

            const before = getCounters()['diskReads'] || 0;
            const rows = await run('SELECT * FROM users LIMIT 1', { catalog, pager: cold });
            const reads = (getCounters()['diskReads'] || 0) - before;
            count('limitPageReads', reads);

            expect(rows).toHaveLength(1);
            // 攒完再截断的实现在这里是 pages.length 次
            expect(reads).toBeLessThanOrEqual(2);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.limitPageReads',
      op: 'lte',
      value: 2,
      unit: 'pages',
      zh: 'LIMIT 1 只读一页，不扫全表',
      en: 'LIMIT 1 reads one page instead of the whole table',
      dimension: 'latency',
      scope: 'gate:early-exit',
    }),
  ],
  referenceFiles: [
    file(
      'src/executor.ts',
      code`
        import type { Expr } from './ast';
        import type { LogicalPlan, Row, Tuple } from './plan';
        import type { Pager } from './contract';
        import type { Catalog } from './catalog';
        import { createHeapFile } from './heap';

        export interface Operator {
          next(): Promise<Tuple | null>;
        }

        export interface ExecutionContext {
          catalog: Catalog;
          pager: Pager;
        }

        export function evaluate(expr: Expr, tuple: Tuple): number | string | boolean {
          if (expr.kind === 'column') return tuple[expr.name];
          if (expr.kind === 'literal') return expr.value;

          // 短路：一旦表达式里出现函数调用或除法，这就不再只是性能问题
          if (expr.op === 'AND') {
            return Boolean(evaluate(expr.left, tuple)) && Boolean(evaluate(expr.right, tuple));
          }
          if (expr.op === 'OR') {
            return Boolean(evaluate(expr.left, tuple)) || Boolean(evaluate(expr.right, tuple));
          }

          const left = evaluate(expr.left, tuple) as number | string;
          const right = evaluate(expr.right, tuple) as number | string;
          switch (expr.op) {
            case '=': return left === right;
            case '!=': return left !== right;
            case '<': return left < right;
            case '<=': return left <= right;
            case '>': return left > right;
            default: return left >= right;
          }
        }

        function scanOperator(table: string, ctx: ExecutionContext): Operator {
          let cursor: { next(): Promise<{ row: unknown } | null> } | null = null;

          return {
            async next(): Promise<Tuple | null> {
              if (!cursor) {
                const schema = ctx.catalog.getTable(table);
                if (!schema) throw new Error('unknown table: ' + table);
                const heap = await createHeapFile(ctx.pager, schema.pages);
                cursor = heap.scan();
              }
              const entry = await cursor.next();
              // 行在算子之间是只读的：交出一个副本，上层原地改也伤不到下层
              return entry ? ({ ...(entry.row as object) } as Tuple) : null;
            },
          };
        }

        function filterOperator(input: Operator, predicate: Expr): Operator {
          return {
            async next(): Promise<Tuple | null> {
              // 一次拉一行，不满足就继续拉。先把输入读干净会让整棵树变成阻塞的
              for (;;) {
                const tuple = await input.next();
                if (!tuple) return null;
                if (evaluate(predicate, tuple)) return tuple;
              }
            },
          };
        }

        function projectOperator(input: Operator, columns: string[]): Operator {
          return {
            async next(): Promise<Tuple | null> {
              const tuple = await input.next();
              if (!tuple) return null;
              // 造新对象，不要在原对象上删键：sort 可能还握着同一个引用
              const projected: Tuple = {};
              for (const column of columns) projected[column] = tuple[column];
              return projected;
            },
          };
        }

        function sortOperator(input: Operator, column: string, direction: 'asc' | 'desc'): Operator {
          let buffered: Tuple[] | null = null;
          let index = 0;

          return {
            async next(): Promise<Tuple | null> {
              // 阻塞算子：不看完全部输入就不知道第一行是谁
              if (!buffered) {
                buffered = [];
                for (;;) {
                  const tuple = await input.next();
                  if (!tuple) break;
                  buffered.push(tuple);
                }
                const sign = direction === 'asc' ? 1 : -1;
                buffered.sort((left, right) => {
                  if (left[column] < right[column]) return -sign;
                  if (left[column] > right[column]) return sign;
                  return 0;
                });
              }
              if (index >= buffered.length) return null;
              const tuple = buffered[index];
              index += 1;
              return tuple;
            },
          };
        }

        function limitOperator(input: Operator, count: number): Operator {
          let emitted = 0;
          return {
            async next(): Promise<Tuple | null> {
              // 拉够了就再也不碰 input：这一句才是「提前退出」本身
              if (emitted >= count) return null;
              const tuple = await input.next();
              if (!tuple) return null;
              emitted += 1;
              return tuple;
            },
          };
        }

        function insertOperator(table: string, values: Array<number | string>, ctx: ExecutionContext): Operator {
          let done = false;
          return {
            async next(): Promise<Tuple | null> {
              if (done) return null;
              done = true;

              const schema = ctx.catalog.getTable(table);
              if (!schema) throw new Error('unknown table: ' + table);

              const row: Tuple = {};
              schema.columns.forEach((column, index) => {
                row[column.name] = values[index];
              });

              const heap = await createHeapFile(ctx.pager, schema.pages);
              await heap.insert(row as unknown as Row);
              // 插入可能新开了页，目录要跟上，否则下一次扫描看不到新行
              ctx.catalog.setPages(table, heap.pages());

              return { inserted: 1 };
            },
          };
        }

        export function buildOperator(plan: LogicalPlan, ctx: ExecutionContext): Operator {
          switch (plan.kind) {
            case 'scan':
              return scanOperator(plan.table, ctx);
            case 'filter':
              return filterOperator(buildOperator(plan.input, ctx), plan.predicate);
            case 'project':
              return projectOperator(buildOperator(plan.input, ctx), plan.columns);
            case 'sort':
              return sortOperator(buildOperator(plan.input, ctx), plan.column, plan.direction);
            case 'limit':
              return limitOperator(buildOperator(plan.input, ctx), plan.count);
            default:
              return insertOperator(plan.table, plan.values, ctx);
          }
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`limitOperator` 里那句 `if (emitted >= count) return null;` 是整关的重点。**',
      '把它删掉，结果仍然完全正确——只是 `LIMIT 1` 会把整张表读完。',
      '一个只看用例的人永远发现不了这个区别，所以这一关的门槛量的是读盘次数而不是结果。',
      '',
      '**`filterOperator` 用 `for (;;)` 而不是先收集再过滤。** 两者结果一样，',
      '但前者是流式的（内存常数、能被 LIMIT 提前掐断），后者是阻塞的。',
      '火山模型里每个算子是流式还是阻塞，是它最重要的属性——比它做什么还重要。',
      '',
      '**`projectOperator` 造新对象。** 因为 `sortOperator` 把整批行攒在 `buffered` 数组里，',
      '而 project 在它上层。原地 `delete` 键的话，被删的正是 sort 数组里的那些对象。',
      '算子之间流动的行必须当成只读的——这是所有流水线式架构的通用约定。',
      '',
      '**`scanOperator` 把建堆文件推迟到第一次 `next()`。** 构造算子树时不该产生任何 IO：',
      '一棵树可能因为上层的 LIMIT 0 而一行都不拉，那它就一次盘都不该读。',
    ].join('\n'),
    [
      'The line `if (emitted >= count) return null;` in `limitOperator` is the point of the stage. Delete',
      'it and every result stays correct — `LIMIT 1` just reads the whole table. Someone reading only the',
      'specs would never see the difference, which is why this stage gates on disk reads rather than rows.',
      '',
      '`filterOperator` uses `for (;;)` instead of collecting then filtering. Same results, but the former',
      'streams (constant memory, interruptible by LIMIT) and the latter blocks. Whether an operator streams',
      'or blocks is its most important property in this model — more important than what it computes.',
      '',
      '`projectOperator` builds a new object, because `sortOperator` holds whole batches in `buffered` and',
      'sits below it. Deleting keys in place would rewrite exactly those buffered objects. Rows flowing',
      'between operators must be treated as read-only, which is the general convention in every',
      'pipeline-shaped architecture.',
      '',
      '`scanOperator` defers opening the heap file to the first `next()`. Building the tree should cause no',
      'IO at all: a tree whose top is `LIMIT 0` pulls no rows, and should therefore touch no pages.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 11 关 · 连接算法                                                   */
/* ------------------------------------------------------------------ */

const stage11 = {
  id: 'join',
  title: t('第 11 关 · 连接算法', 'Stage 11 · Join algorithms'),
  goal: t(
    [
      'JOIN 是关系数据库的核心操作，也是同一个语义可以有天差地别性能的典型例子。',
      '这一关实现两种连接，然后用读盘次数把它们的差距量出来。',
      '',
      '在 `src/join.ts` 实现：',
      '',
      '- `nestedLoopJoin(left, rightFactory, on, rightPrefix)`：对左边每一行，把右边**重扫一遍**；',
      '  右边传的是工厂函数而不是算子，因为它要被反复重建；',
      '- `hashJoin(left, right, on, rightPrefix)`：先把右边整个读进一张哈希表，再流式扫左边。',
      '',
      '两个算子的输出都是左右两行合并的结果，右边的列名加上 `rightPrefix + \'_\'` 前缀',
      '（`orders_id`），否则两张表的 `id` 会互相覆盖。',
      '',
      '复杂度差别是这一关的全部意义：',
      '',
      '| | 时间 | 读盘 | 内存 |',
      '| --- | --- | --- | --- |',
      '| 嵌套循环 | O(n × m) | 左表页数 + n × 右表页数 | 常数 |',
      '| 哈希连接 | O(n + m) | 左表页数 + 右表页数 | 右表大小 |',
      '',
      '嵌套循环内存是常数、不要求等值条件、右边小的时候反而更快；',
      '哈希连接要把右表装进内存，但只扫一遍。**没有一种连接总是更好**，',
      '这也是下一关优化器存在的理由。',
    ].join('\n'),
    [
      'JOIN is the core relational operation and the classic case where one meaning admits wildly',
      'different performance. This stage implements two joins and then measures the gap in disk reads.',
      '',
      'Implement in `src/join.ts`:',
      '',
      '- `nestedLoopJoin(left, rightFactory, on, rightPrefix)`: for each left row, rescan the right side.',
      '  The right side is a factory rather than an operator because it gets rebuilt repeatedly;',
      '- `hashJoin(left, right, on, rightPrefix)`: read the right side into a hash table, then stream the left.',
      '',
      "Both emit the merged row with the right side's columns prefixed by `rightPrefix + '_'`",
      "(`orders_id`), or the two tables' `id` columns overwrite each other.",
      '',
      'The complexity difference is the whole point:',
      '',
      '| | Time | Disk reads | Memory |',
      '| --- | --- | --- | --- |',
      '| Nested loop | O(n × m) | left pages + n × right pages | constant |',
      '| Hash join | O(n + m) | left pages + right pages | size of the right side |',
      '',
      'Nested loop uses constant memory, needs no equality condition, and is genuinely faster when the',
      'right side is tiny. Hash join reads each side once but must fit the right side in memory. No join',
      'algorithm is always better — which is exactly why the next stage exists.',
    ].join('\n')
  ),
  checklist: [
    t('两种连接产生相同的结果集', 'Both joins produce the same result set'),
    t('右侧列名带前缀，不覆盖左侧同名列', 'Right columns are prefixed and do not clobber left ones'),
    t('一对多、多对一都正确', 'One-to-many and many-to-one both work'),
    t('哈希连接每侧只扫一遍', 'Hash join scans each side once'),
    t('嵌套循环的读盘次数随左表行数增长', "Nested loop's disk reads grow with the left row count"),
  ],
  pitfalls: [
    t(
      '嵌套循环里把右侧算子只建一次，在外层循环里复用。第一行左表数据能正确匹配，之后右侧算子已经耗尽，`next()` 一直返回 null——结果里只剩下第一行左表的匹配。右侧必须为每一行左表重新建。',
      'Building the right operator once and reusing it across the outer loop. The first left row matches correctly, after which the right operator is exhausted and returns null forever — so the result contains only the first left row\'s matches. The right side must be rebuilt per left row.'
    ),
    t(
      '合并两行时用 `Object.assign(leftTuple, rightTuple)`。它就地改了左行，而左行可能还要和右边的其他行匹配（一对多），于是第二个匹配结果里混进了第一个的字段。合并要造新对象。',
      'Merging with `Object.assign(leftTuple, rightTuple)`. That mutates the left row, which may still need to match further right rows in a one-to-many join, so the second match carries fields from the first. Merging must build a new object.'
    ),
    t(
      '哈希表用 `key` 直接当对象属性名。数字 1 和字符串 \'1\' 会被 JavaScript 折叠成同一个键，于是 `users.id = 1` 会匹配上 `orders.ref = \'1\'`——一个只在混合类型数据上出现的错误匹配。用 Map，它区分键的类型。',
      "Using the join key as a plain object property. JavaScript folds the number 1 and the string '1' into one key, so `users.id = 1` matches `orders.ref = '1'` — a wrong match that only appears with mixed-type data. Use a Map, which distinguishes key types."
    ),
    t(
      '哈希连接把**左**侧建成哈希表。功能上也对，但左侧通常是流水线里更大的那一侧（它上面还挂着 filter 等算子），建表意味着把它整个装进内存。约定是把较小的一侧（这里是右侧）作为 build 端。',
      'Building the hash table from the left side. Functionally fine, but the left side is usually the larger one in a pipeline (with filters stacked above it), so building from it pulls the whole thing into memory. The convention is to build from the smaller side, here the right.'
    ),
  ],
  hints: [
    t(
      '嵌套循环的状态是「当前左行」和「当前右侧算子」。右侧返回 null 时把左行清空，下一轮 `next()` 会自动拉下一条左行并重建右侧。',
      "Nested loop's state is the current left row and the current right operator. When the right side returns null, clear the left row and the next `next()` pulls the following left row and rebuilds the right side.",
    ),
    t(
      '哈希连接的状态多一个「当前左行匹配到的那一批右行」和一个下标，因为一条左行可能匹配多条右行，要一条条吐。',
      'Hash join needs two more pieces of state: the bucket of right rows matching the current left row, and an index into it, because one left row can match many right rows and they are emitted one at a time.'
    ),
  ],
  extension: t(
    [
      '真实优化器里至少有三种连接算法，第三种是**排序归并**（sort-merge join）：',
      '两边各自按连接键排序，然后像归并两个有序数组一样扫一遍。',
      '它不需要把任何一侧装进内存，而且如果数据本来就有序（比如来自索引扫描），排序这一步是免费的。',
      '代价是排序本身是阻塞的。',
      '',
      '哈希连接在内存装不下时会退化成 **grace hash join**：先按哈希值把两侧各自分成若干分区写回磁盘，',
      '让每个分区都小到能装进内存，再逐个分区做内存哈希连接。这是「外部算法」的通用套路——',
      '外部排序也是同一个思路。',
      '',
      '还有一件事这一关完全没碰：**连接顺序**。三张表 A、B、C 连起来，',
      '`(A⋈B)⋈C` 和 `A⋈(B⋈C)` 结果一样但代价可能差几个数量级。',
      'n 张表的连接顺序有卡塔兰数量级的可能性，穷举在 n=12 左右就跑不动了。',
      'System R 的经典做法是动态规划（只考虑左深树），现代优化器则用',
      '动态规划 + 启发式剪枝，或者干脆用遗传算法（PostgreSQL 在表很多时会切到 GEQO）。',
    ].join('\n'),
    [
      'Real optimisers carry at least three join algorithms, the third being sort-merge: sort both sides on',
      'the join key and walk them like merging two sorted arrays. It needs neither side in memory, and when',
      'the data is already ordered — coming from an index scan, say — the sort is free. The price is that',
      'sorting blocks.',
      '',
      'Hash join degrades to grace hash join when memory runs out: partition both sides by hash back to',
      'disk so each partition fits, then hash-join partition by partition. That is the general shape of',
      'external algorithms — external sorting works the same way.',
      '',
      'One thing untouched here: join order. Joining A, B and C, the plans `(A⋈B)⋈C` and `A⋈(B⋈C)` return',
      'the same rows and can differ by orders of magnitude in cost. The number of orderings for n tables',
      'grows like the Catalan numbers, and exhaustive search dies around n=12. System R\'s classic answer',
      'is dynamic programming over left-deep trees; modern optimisers use DP with heuristic pruning, or',
      'give up and use a genetic algorithm — PostgreSQL switches to GEQO when there are many tables.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/join.ts',
      code`
        import type { Tuple } from './plan';
        import type { Operator } from './executor';

        export interface JoinCondition {
          /** 左侧参与连接的列 */
          left: string;
          /** 右侧参与连接的列 */
          right: string;
        }

        /** 右侧要被反复重扫，所以传工厂而不是算子实例 */
        export function nestedLoopJoin(
          left: Operator,
          rightFactory: () => Operator,
          on: JoinCondition,
          rightPrefix: string
        ): Operator {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }

        export function hashJoin(
          left: Operator,
          right: Operator,
          on: JoinCondition,
          rightPrefix: string
        ): Operator {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-11.spec.ts',
      code`
        import { hashJoin, nestedLoopJoin } from '../src/join';
        import type { Operator } from '../src/executor';
        import { buildOperator } from '../src/executor';
        import { createCatalog } from '../src/catalog';
        import { createHeapFile } from '../src/heap';
        import { createPager } from '../src/pager';
        import { plan } from '../src/planner';
        import { parse } from '../src/parser';
        import { Disk } from '../src/disk';
        import { count, getCounters } from '@lab/metrics';

        const COLUMNS = [
          { name: 'id', type: 'number' as const },
          { name: 'name', type: 'string' as const },
          { name: 'active', type: 'number' as const },
        ];

        /** 用一个数组直接造算子，方便测纯连接逻辑 */
        function fromRows(rows: Tuple[]): Operator {
          let index = 0;
          return {
            async next() {
              if (index >= rows.length) return null;
              const row = rows[index];
              index += 1;
              return { ...row };
            },
          };
        }

        type Tuple = Record<string, number | string>;

        async function drain(operator: Operator) {
          const rows: Tuple[] = [];
          let row = await operator.next();
          while (row) {
            rows.push(row);
            row = await operator.next();
          }
          return rows;
        }

        const ON = { left: 'id', right: 'id' };

        describe('阶段11 · 连接算法', () => {
          it('嵌套循环连接匹配得上', async () => {
            const left = fromRows([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
            const rightRows = [{ id: 1, name: 'x' }, { id: 3, name: 'y' }];
            const joined = await drain(nestedLoopJoin(left, () => fromRows(rightRows), ON, 'r'));

            expect(joined).toEqual([{ id: 1, name: 'a', r_id: 1, r_name: 'x' }]);
          });

          it('哈希连接结果与嵌套循环一致', async () => {
            const leftRows = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }];
            const rightRows = [{ id: 3, name: 'z' }, { id: 1, name: 'x' }];

            const viaLoop = await drain(
              nestedLoopJoin(fromRows(leftRows), () => fromRows(rightRows), ON, 'r')
            );
            const viaHash = await drain(hashJoin(fromRows(leftRows), fromRows(rightRows), ON, 'r'));

            const key = (rows: Tuple[]) =>
              rows.map((row) => row.id + ':' + row.r_name).sort();
            expect(key(viaHash)).toEqual(key(viaLoop));
            expect(viaHash).toHaveLength(2);
          });

          it('右侧列名加前缀，不覆盖左侧同名列', async () => {
            const joined = await drain(
              hashJoin(fromRows([{ id: 1, name: 'left' }]), fromRows([{ id: 1, name: 'right' }]), ON, 'orders')
            );
            expect(joined[0].name).toBe('left');
            expect(joined[0].orders_name).toBe('right');
            expect(joined[0].orders_id).toBe(1);
          });

          it('一对多：一条左行匹配多条右行', async () => {
            const rightRows = [{ id: 1, name: 'x' }, { id: 1, name: 'y' }, { id: 1, name: 'z' }];

            const viaLoop = await drain(
              nestedLoopJoin(fromRows([{ id: 1, name: 'a' }]), () => fromRows(rightRows), ON, 'r')
            );
            const viaHash = await drain(hashJoin(fromRows([{ id: 1, name: 'a' }]), fromRows(rightRows), ON, 'r'));

            expect(viaLoop).toHaveLength(3);
            expect(viaHash).toHaveLength(3);
            // 左行不能被前一次合并改坏
            expect(viaHash.map((row) => row.name)).toEqual(['a', 'a', 'a']);
            expect(viaHash.map((row) => row.r_name).sort()).toEqual(['x', 'y', 'z']);
          });

          it('多对一：多条左行匹配同一条右行', async () => {
            const leftRows = [{ id: 1, name: 'a' }, { id: 1, name: 'b' }];
            const rightRows = [{ id: 1, name: 'x' }];

            expect(await drain(hashJoin(fromRows(leftRows), fromRows(rightRows), ON, 'r'))).toHaveLength(2);
            expect(
              await drain(nestedLoopJoin(fromRows(leftRows), () => fromRows(rightRows), ON, 'r'))
            ).toHaveLength(2);
          });

          it('嵌套循环会为每一条左行重扫右侧', async () => {
            const leftRows = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }];
            let builds = 0;
            const factory = () => {
              builds += 1;
              return fromRows([{ id: 1, name: 'x' }]);
            };

            await drain(nestedLoopJoin(fromRows(leftRows), factory, ON, 'r'));
            // 只建一次的实现只有第一条左行能匹配上
            expect(builds).toBe(3);
          });

          it('没有匹配时返回空', async () => {
            expect(
              await drain(hashJoin(fromRows([{ id: 1 }]), fromRows([{ id: 2 }]), ON, 'r'))
            ).toEqual([]);
          });

          it('任一侧为空则结果为空', async () => {
            expect(await drain(hashJoin(fromRows([]), fromRows([{ id: 1 }]), ON, 'r'))).toEqual([]);
            expect(await drain(hashJoin(fromRows([{ id: 1 }]), fromRows([]), ON, 'r'))).toEqual([]);
            expect(
              await drain(nestedLoopJoin(fromRows([]), () => fromRows([{ id: 1 }]), ON, 'r'))
            ).toEqual([]);
          });

          it('数字键和字符串键不会被混为一谈', async () => {
            const joined = await drain(
              hashJoin(fromRows([{ id: 1 }]), fromRows([{ id: '1' }]), ON, 'r')
            );
            // 用对象当哈希表会把 1 和 '1' 折叠成同一个键
            expect(joined).toEqual([]);
          });

          it('可以连接不同名的列', async () => {
            const joined = await drain(
              hashJoin(
                fromRows([{ id: 7, name: 'a' }]),
                fromRows([{ userId: 7, note: 'n' }]),
                { left: 'id', right: 'userId' },
                'o'
              )
            );
            expect(joined).toEqual([{ id: 7, name: 'a', o_userId: 7, o_note: 'n' }]);
          });

          it('接在真实扫描算子后面也能跑', async () => {
            const disk = new Disk();
            const pager = createPager(disk, { capacity: 64 });
            const users = await createHeapFile(pager);
            for (let index = 0; index < 6; index += 1) {
              await users.insert({ id: index, name: 'user' + index, active: 1 });
            }
            const catalog = createCatalog();
            catalog.createTable('users', COLUMNS, users.pages());

            const ctx = { catalog, pager };
            const left = buildOperator(plan(parse('SELECT * FROM users WHERE id < 3'), catalog), ctx);
            const joined = await drain(
              hashJoin(left, fromRows([{ id: 1, name: 'match' }]), ON, 'r')
            );
            expect(joined).toHaveLength(1);
            expect(joined[0].r_name).toBe('match');
          });

          it('哈希连接每侧只扫一遍 [gate:hash-join]', async () => {
            const disk = new Disk();
            const warm = createPager(disk, { capacity: 64 });

            const users = await createHeapFile(warm);
            for (let index = 0; index < 24; index += 1) {
              await users.insert({ id: index, name: 'user' + index, active: 1 });
            }
            const orders = await createHeapFile(warm);
            for (let index = 0; index < 24; index += 1) {
              await orders.insert({ id: index, name: 'order' + index, active: 1 });
            }
            const userPages = users.pages();
            const orderPages = orders.pages();
            await warm.flush();

            const catalog = createCatalog();
            catalog.createTable('users', COLUMNS, userPages);
            catalog.createTable('orders', COLUMNS, orderPages);

            const cold = createPager(disk, { capacity: 2 });
            const ctx = { catalog, pager: cold };
            const scanOf = (table: string) =>
              buildOperator({ kind: 'scan', table } as any, ctx);

            const before = getCounters()['diskReads'] || 0;
            const joined = await drain(hashJoin(scanOf('users'), scanOf('orders'), ON, 'o'));
            const reads = (getCounters()['diskReads'] || 0) - before;
            count('joinPageReads', reads);

            expect(joined).toHaveLength(24);
            // 每侧扫一遍就是两边页数之和；嵌套循环在这里是 24 倍
            expect(reads).toBeLessThanOrEqual(userPages.length + orderPages.length + 2);
          });

          it('同样的数据，嵌套循环的读盘次数远高于哈希连接', async () => {
            const disk = new Disk();
            const warm = createPager(disk, { capacity: 64 });
            const users = await createHeapFile(warm);
            const orders = await createHeapFile(warm);
            for (let index = 0; index < 18; index += 1) {
              await users.insert({ id: index, name: 'user' + index, active: 1 });
            }
            for (let index = 0; index < 18; index += 1) {
              await orders.insert({ id: index, name: 'order' + index, active: 1 });
            }
            const catalog = createCatalog();
            catalog.createTable('users', COLUMNS, users.pages());
            catalog.createTable('orders', COLUMNS, orders.pages());
            await warm.flush();

            // capacity 1：每次换页都是一次真实读盘，重扫的代价藏不住
            const measure = async (build: (ctx: any) => Operator) => {
              const cold = createPager(disk, { capacity: 1 });
              const ctx = { catalog, pager: cold };
              const before = getCounters()['diskReads'] || 0;
              const rows = await drain(build(ctx));
              return { reads: (getCounters()['diskReads'] || 0) - before, rows: rows.length };
            };

            const scanOf = (ctx: any, table: string) => buildOperator({ kind: 'scan', table } as any, ctx);

            const hash = await measure((ctx) =>
              hashJoin(scanOf(ctx, 'users'), scanOf(ctx, 'orders'), ON, 'o')
            );
            const loop = await measure((ctx) =>
              nestedLoopJoin(scanOf(ctx, 'users'), () => scanOf(ctx, 'orders'), ON, 'o')
            );

            // 结果必须一样，代价不一样
            expect(hash.rows).toBe(18);
            expect(loop.rows).toBe(18);
            expect(loop.reads).toBeGreaterThan(hash.reads * 3);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.joinPageReads',
      op: 'lte',
      value: 14,
      unit: 'pages',
      zh: '哈希连接每侧只扫一遍',
      en: 'Hash join scans each side exactly once',
      dimension: 'latency',
      scope: 'gate:hash-join',
    }),
  ],
  referenceFiles: [
    file(
      'src/join.ts',
      code`
        import type { Tuple } from './plan';
        import type { Operator } from './executor';

        export interface JoinCondition {
          left: string;
          right: string;
        }

        /** 造新对象：左行可能还要和右边其他行匹配，不能被就地改掉 */
        function merge(left: Tuple, right: Tuple, prefix: string): Tuple {
          const merged: Tuple = { ...left };
          for (const key of Object.keys(right)) {
            merged[prefix + '_' + key] = right[key];
          }
          return merged;
        }

        export function nestedLoopJoin(
          left: Operator,
          rightFactory: () => Operator,
          on: JoinCondition,
          rightPrefix: string
        ): Operator {
          let leftTuple: Tuple | null = null;
          let right: Operator | null = null;

          return {
            async next(): Promise<Tuple | null> {
              for (;;) {
                if (!leftTuple) {
                  leftTuple = await left.next();
                  if (!leftTuple) return null;
                  // 每一条左行都要一个全新的右侧算子：复用的话
                  // 第一行之后右侧早已耗尽，结果里只剩第一行的匹配
                  right = rightFactory();
                }

                const rightTuple = await (right as Operator).next();
                if (!rightTuple) {
                  leftTuple = null;
                  continue;
                }

                if (leftTuple[on.left] === rightTuple[on.right]) {
                  return merge(leftTuple, rightTuple, rightPrefix);
                }
              }
            },
          };
        }

        export function hashJoin(
          left: Operator,
          right: Operator,
          on: JoinCondition,
          rightPrefix: string
        ): Operator {
          // Map 而不是普通对象：对象会把数字 1 和字符串 '1' 折叠成同一个键
          let buckets: Map<number | string, Tuple[]> | null = null;
          let leftTuple: Tuple | null = null;
          let matches: Tuple[] = [];
          let matchIndex = 0;

          return {
            async next(): Promise<Tuple | null> {
              // build 阶段是阻塞的，而且只做一次
              if (!buckets) {
                buckets = new Map<number | string, Tuple[]>();
                for (;;) {
                  const rightTuple = await right.next();
                  if (!rightTuple) break;
                  const key = rightTuple[on.right];
                  const bucket = buckets.get(key) || [];
                  bucket.push(rightTuple);
                  buckets.set(key, bucket);
                }
              }

              for (;;) {
                // 一条左行可能匹配多条右行，先把这一批吐完
                if (matchIndex < matches.length) {
                  const rightTuple = matches[matchIndex];
                  matchIndex += 1;
                  return merge(leftTuple as Tuple, rightTuple, rightPrefix);
                }

                leftTuple = await left.next();
                if (!leftTuple) return null;
                matches = buckets.get(leftTuple[on.left]) || [];
                matchIndex = 0;
              }
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`rightFactory` 是接口设计上的一个刻意选择。** 如果 `nestedLoopJoin` 接的是一个算子实例，',
      '调用方几乎必然会传一个已经建好的算子，然后第一条左行之后右侧就耗尽了。',
      '把类型定成 `() => Operator`，「右侧要被重建」这件事就变成了签名的一部分，',
      '用错的写法根本编译不过。**用类型把误用挡在门外**，比在文档里写一句警告有效得多。',
      '',
      '**`merge` 造新对象。** 一对多连接里，同一条左行要参与多次合并。',
      '`Object.assign(left, right)` 会把第一次合并的右侧字段留在左行上，',
      '第二个结果于是同时带着两条右行的字段。这个 bug 只在一对多时出现，',
      '一对一的测试全绿。',
      '',
      '**哈希表用 `Map` 而不是对象。** 对象的键只能是字符串，`buckets[1]` 和 `buckets[\'1\']`',
      '是同一个槽。连接键混了类型时（真实系统里 join 一个数字列和一个字符串列并不罕见），',
      '会产生**错误的匹配**而不是报错——比崩溃难查得多。',
      '',
      '**build 端选右侧。** 这不是随意的：左侧通常是流水线里更长的那一支，',
      '上面可能还挂着 filter、project。把左侧建成哈希表意味着把它整个拉进内存，',
      '而右侧往往是维表。真实优化器会根据统计信息决定哪一侧当 build 端。',
    ].join('\n'),
    [
      '`rightFactory` is a deliberate interface choice. Had `nestedLoopJoin` taken an operator instance,',
      'callers would almost inevitably pass an already-built one and find the right side exhausted after',
      'the first left row. Typing it `() => Operator` makes "the right side gets rebuilt" part of the',
      'signature, so the wrong usage does not compile. Blocking misuse with a type beats a warning in the',
      'documentation.',
      '',
      '`merge` builds a new object. In a one-to-many join the same left row participates in several merges,',
      "and `Object.assign(left, right)` leaves the first right row's fields on the left row so the second",
      'result carries both. The bug only appears with one-to-many; every one-to-one test stays green.',
      '',
      "The hash table is a `Map`, not an object. Object keys are strings, so `buckets[1]` and `buckets['1']`",
      'are the same slot. With mixed-type join keys — joining a numeric column to a string column is not',
      'rare in real systems — that produces wrong matches rather than an error, which is far harder to find',
      'than a crash.',
      '',
      'The build side is the right one. That is not arbitrary: the left side is usually the longer branch of',
      'the pipeline, with filters and projections stacked on it, so building from it drags the whole thing',
      'into memory while the right side is often a dimension table. Real optimisers pick the build side from',
      'statistics.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 12 关 · 统计信息与代价优化器                                       */
/* ------------------------------------------------------------------ */

const stage12 = {
  id: 'optimizer',
  title: t('第 12 关 · 统计信息与代价优化器', 'Stage 12 · Statistics and the cost-based optimiser'),
  goal: t(
    [
      '同一条 SQL 有很多种跑法。前面十一关把这些跑法都造出来了：',
      '顺序扫描和索引扫描，嵌套循环和哈希连接。',
      '这一关做最后一件事——**决定用哪一种**。',
      '',
      '决定的依据不是规则，是**算出来的代价**。而算代价需要知道数据长什么样，',
      '这就是统计信息。',
      '',
      '在 `src/statistics.ts` 实现 `analyze(rows, pageCount)`：',
      '统计行数、页数，以及每一列的不同值个数（distinct）和最小/最大值。',
      '',
      '在 `src/optimizer.ts` 实现：',
      '',
      '- `estimateSelectivity(expr, stats)`：这个谓词能筛掉多少行，返回 0~1；',
      '- `chooseAccessPath(predicate, stats, options)`：算出两条路的代价，返回便宜的那条。',
      '',
      '选择率的估算规则（教科书版本）：',
      '',
      '| 谓词 | 选择率 |',
      '| --- | --- |',
      '| `col = v` | `1 / distinct` |',
      '| `col != v` | `1 - 1 / distinct` |',
      '| `col < v` | `(v - min) / (max - min)` |',
      '| `col > v` | `(max - v) / (max - min)` |',
      '| `a AND b` | `s(a) × s(b)` |',
      '| `a OR b` | `s(a) + s(b) - s(a) × s(b)` |',
      '| 估不出来 | `1/3` |',
      '',
      '代价模型：**顺序扫描 = 页数**（每页读一次）；',
      '**索引扫描 = 树高 + 命中行数**（先走索引，再为每一行回表读一页）。',
      '',
      '于是关键结论就出来了：**命中行数一多，索引扫描比全表扫描还贵**。',
      '一个「有索引就走索引」的优化器在 `WHERE active = 1`（一半行都命中）上会慢得多。',
      '你的实现必须**算**，不许猜。',
    ].join('\n'),
    [
      'One SQL statement has many ways to run. The previous eleven stages built those ways: sequential and',
      'index scans, nested loop and hash joins. This stage does the last thing — decide which to use.',
      '',
      'The decision comes from computed cost, not from rules. Computing cost requires knowing what the',
      'data looks like, and that is what statistics are.',
      '',
      'Implement `analyze(rows, pageCount)` in `src/statistics.ts`: row count, page count, and per column',
      'the number of distinct values plus min and max.',
      '',
      'Implement in `src/optimizer.ts`:',
      '',
      '- `estimateSelectivity(expr, stats)`: what fraction of rows this predicate keeps, 0 to 1;',
      '- `chooseAccessPath(predicate, stats, options)`: cost both paths and return the cheaper.',
      '',
      'Selectivity rules, the textbook set:',
      '',
      '| Predicate | Selectivity |',
      '| --- | --- |',
      '| `col = v` | `1 / distinct` |',
      '| `col != v` | `1 - 1 / distinct` |',
      '| `col < v` | `(v - min) / (max - min)` |',
      '| `col > v` | `(max - v) / (max - min)` |',
      '| `a AND b` | `s(a) × s(b)` |',
      '| `a OR b` | `s(a) + s(b) - s(a) × s(b)` |',
      '| not estimable | `1/3` |',
      '',
      'The cost model: a sequential scan costs the page count (one read per page); an index scan costs',
      'the tree height plus the number of matching rows (descend the index, then one page read per row).',
      '',
      'Which yields the key conclusion: once enough rows match, an index scan costs more than reading the',
      'whole table. An optimiser that always uses an available index is far slower on `WHERE active = 1`,',
      'where half the rows match. Yours must compute, not guess.',
    ].join('\n')
  ),
  checklist: [
    t('analyze 统计出行数、distinct 和 min/max', 'analyze reports row count, distinct values and min/max'),
    t('等值、范围、AND、OR 的选择率都算得出来', 'Selectivity is computed for equality, ranges, AND and OR'),
    t('选择率被夹在 0 和 1 之间', 'Selectivity is clamped between 0 and 1'),
    t('高选择率走索引，低选择率走全表扫描', 'Selective predicates use the index, unselective ones scan'),
    t('OR 谓词用不上单列索引', 'A single-column index is unusable under OR'),
  ],
  pitfalls: [
    t(
      '把「有索引就走索引」写死。这是规则优化器（RBO）的做法，也是最容易犯的错。`WHERE active = 1` 命中一半的行时，索引扫描要为每一行回表读一页，比顺序读完整张表贵好几倍。规则替代不了算术。',
      'Hard-coding "use the index when one exists". That is a rule-based optimiser, and the easiest mistake to make. When `WHERE active = 1` matches half the rows, an index scan does one page read per matching row and costs several times a full sequential read. Arithmetic cannot be replaced by a rule.'
    ),
    t(
      '范围选择率不做边界夹取。`WHERE id < -100` 在 min=0 时算出来是负数，`WHERE id < 99999` 算出来大于 1。负的选择率会让估算行数变成负数，代价模型跟着崩；大于 1 的会高估到荒谬的程度。结果必须夹在 [0, 1]。',
      'Not clamping range selectivity. With min=0, `WHERE id < -100` computes negative and `WHERE id < 99999` computes above 1. A negative selectivity makes estimated rows negative and the cost model collapses; above 1 overestimates absurdly. Clamp to [0, 1].'
    ),
    t(
      '列在比较式右边时不翻转运算符。`WHERE 18 < age` 和 `WHERE age > 18` 是同一个意思，但直接按 `<` 算会得到 `(18 - min) / (max - min)`——刚好是正确答案的补数。估反了会让优化器在两条路之间做出恰恰相反的选择。',
      'Not flipping the operator when the column is on the right. `WHERE 18 < age` means `WHERE age > 18`, but computing it as `<` gives `(18 - min) / (max - min)` — exactly the complement of the right answer. An inverted estimate makes the optimiser choose precisely the wrong path.'
    ),
    t(
      '认为 OR 也能用索引。`WHERE a = 1 OR b = 2` 里 b 上的索引帮不上忙——满足 b = 2 的行可能完全不满足 a = 1，反过来也一样，两边都得查一遍。真实系统有位图索引扫描（bitmap OR）能处理这种情况，但那不是单列索引扫描。',
      "Assuming OR can use an index. In `WHERE a = 1 OR b = 2` an index on b does not help: rows satisfying b = 2 need not satisfy a = 1 and vice versa, so both sides must be examined. Real systems have bitmap index scans for this, but that is not a single-column index scan."
    ),
  ],
  hints: [
    t(
      '`estimateSelectivity` 写成递归：AND 和 OR 递归两边再合并，比较式在叶子上算。先把「哪边是列、哪边是字面量」归一化，必要时翻转运算符，后面的分支就干净了。',
      'Write `estimateSelectivity` recursively: AND and OR recurse and combine, comparisons compute at the leaves. Normalise which side is the column and which the literal first, flipping the operator when needed, and the remaining branches stay clean.'
    ),
    t(
      '判断索引可不可用也是一次递归：碰到 OR 直接返回 false，碰到 AND 只要有一边可用就可用，碰到比较式看列名在不在索引列表里。',
      'Index usability is another recursion: return false at an OR, true at an AND if either side is usable, and at a comparison check whether the column is in the indexed list.'
    ),
  ],
  extension: t(
    [
      '这一关用「distinct 个数 + min/max」来估选择率，隐含了一个很强的假设：**数据均匀分布**。',
      '真实数据几乎从不均匀。一张订单表里 `status = \'completed\'` 可能占 95%，',
      '`status = \'refunded\'` 占 0.1%，但按 `1/distinct` 算它们都是 1/5。',
      '',
      '所以真实优化器用**直方图**。等高直方图把值域切成若干桶、每桶行数相同，',
      '桶边界密集的地方就是数据密集的地方。PostgreSQL 默认每列 100 个桶',
      '（`default_statistics_target`），另外还单独记录**最常见值**（MCV）及其频率，',
      '专门对付上面那种倾斜。查 `pg_stats` 就能看到这两样东西。',
      '',
      '另一个大假设是**列之间相互独立**——`s(a AND b) = s(a) × s(b)` 就是这么来的。',
      '现实里「城市 = 上海」和「区号 = 021」几乎完全相关，独立假设会把选择率估低几十倍，',
      '于是优化器以为只有几行、选了嵌套循环，实际跑出几十万行。',
      '这是生产环境里慢查询最常见的成因之一。PostgreSQL 10 起支持',
      '`CREATE STATISTICS` 显式声明多列相关性。',
      '',
      '还有一件事这一关没做：**代价的单位**。这里把「读一页」当作 1，把「回表读一行」也当作 1，',
      '但顺序读一页和随机读一页在真实磁盘上差着两个数量级。PostgreSQL 为此有',
      '`seq_page_cost`（默认 1.0）和 `random_page_cost`（默认 4.0）两个参数，',
      '而 SSD 普及之后，把 `random_page_cost` 从 4 调到 1.1 是最常见的一条调优建议。',
    ].join('\n'),
    [
      'This stage estimates selectivity from distinct counts plus min/max, which embeds a strong',
      "assumption: uniform distribution. Real data almost never is. In an orders table `status =",
      "'completed'` might be 95% of rows and `status = 'refunded'` 0.1%, yet `1/distinct` calls both 1/5.",
      '',
      'So real optimisers use histograms. An equi-height histogram cuts the value range into buckets of',
      'equal row count, so densely packed boundaries mark densely packed data. PostgreSQL defaults to 100',
      'buckets per column (`default_statistics_target`) and separately records most common values (MCVs)',
      'and their frequencies precisely to handle the skew above. Both are visible in `pg_stats`.',
      '',
      'The other large assumption is column independence — that is where `s(a AND b) = s(a) × s(b)` comes',
      'from. In practice "city = Shanghai" and "area code = 021" are almost perfectly correlated, so',
      'independence underestimates selectivity by orders of magnitude, the optimiser expects a handful of',
      'rows, picks a nested loop, and meets hundreds of thousands. This is among the most common causes of',
      'slow queries in production. PostgreSQL 10 added `CREATE STATISTICS` to declare correlations explicitly.',
      '',
      'One more omission: the unit of cost. Here a page read is 1 and a row fetch is also 1, but sequential',
      'and random page reads differ by two orders of magnitude on real disks. PostgreSQL exposes',
      '`seq_page_cost` (default 1.0) and `random_page_cost` (default 4.0) for this, and since SSDs became',
      'common, lowering `random_page_cost` from 4 to about 1.1 is the single most frequently given tuning',
      'recommendation.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/statistics.ts',
      code`
        import type { Tuple } from './plan';

        export interface ColumnStats {
          /** 不同值的个数 */
          distinct: number;
          min: number | string;
          max: number | string;
        }

        export interface TableStats {
          rowCount: number;
          /** 这张表占多少页，顺序扫描的代价就是它 */
          pageCount: number;
          columns: Record<string, ColumnStats>;
        }

        export function analyze(rows: Tuple[], pageCount: number): TableStats {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
    file(
      'src/optimizer.ts',
      code`
        import type { Expr } from './ast';
        import type { TableStats } from './statistics';

        export interface AccessPath {
          kind: 'seq-scan' | 'index-scan';
          estimatedRows: number;
          estimatedCost: number;
        }

        export interface AccessOptions {
          /** 建了索引的列 */
          indexedColumns: string[];
          /** B+Tree 的层数，索引扫描的固定开销 */
          indexHeight: number;
        }

        /** 估不出来时的兜底选择率 */
        export const DEFAULT_SELECTIVITY = 1 / 3;

        export function estimateSelectivity(expr: Expr, stats: TableStats): number {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }

        export function chooseAccessPath(
          predicate: Expr | undefined,
          stats: TableStats,
          options: AccessOptions
        ): AccessPath {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-12.spec.ts',
      code`
        import { analyze } from '../src/statistics';
        import { chooseAccessPath, estimateSelectivity, DEFAULT_SELECTIVITY } from '../src/optimizer';
        import { parse } from '../src/parser';
        import { count } from '@lab/metrics';

        function rows(total: number) {
          const built: any[] = [];
          for (let index = 0; index < total; index += 1) {
            built.push({ id: index, name: 'user' + index, active: index % 2 });
          }
          return built;
        }

        /** 从一条 SQL 里把 WHERE 抠出来，省得手搭语法树 */
        function whereOf(sql: string) {
          return (parse(sql) as any).where;
        }

        const STATS = analyze(rows(100), 20);

        describe('阶段12 · 统计信息', () => {
          it('统计行数和页数', () => {
            expect(STATS.rowCount).toBe(100);
            expect(STATS.pageCount).toBe(20);
          });

          it('统计每列的不同值个数', () => {
            expect(STATS.columns.id.distinct).toBe(100);
            // active 只有 0 和 1
            expect(STATS.columns.active.distinct).toBe(2);
          });

          it('统计最小值和最大值', () => {
            expect(STATS.columns.id.min).toBe(0);
            expect(STATS.columns.id.max).toBe(99);
            expect(STATS.columns.active.min).toBe(0);
            expect(STATS.columns.active.max).toBe(1);
          });

          it('字符串列也有 min/max', () => {
            expect(typeof STATS.columns.name.min).toBe('string');
            expect(STATS.columns.name.distinct).toBe(100);
          });

          it('空表不会炸', () => {
            const empty = analyze([], 0);
            expect(empty.rowCount).toBe(0);
            expect(empty.columns).toEqual({});
          });
        });

        describe('阶段12 · 选择率估算', () => {
          it('等值谓词是 1 / distinct', () => {
            expect(estimateSelectivity(whereOf('SELECT * FROM t WHERE id = 5'), STATS)).toBeCloseTo(0.01, 4);
            expect(estimateSelectivity(whereOf('SELECT * FROM t WHERE active = 1'), STATS)).toBeCloseTo(0.5, 4);
          });

          it('不等谓词是 1 - 1 / distinct', () => {
            expect(estimateSelectivity(whereOf('SELECT * FROM t WHERE active != 1'), STATS)).toBeCloseTo(0.5, 4);
            expect(estimateSelectivity(whereOf('SELECT * FROM t WHERE id != 5'), STATS)).toBeCloseTo(0.99, 4);
          });

          it('范围谓词按 min/max 线性插值', () => {
            // id 落在 0..99，< 25 大约是四分之一
            expect(estimateSelectivity(whereOf('SELECT * FROM t WHERE id < 25'), STATS)).toBeCloseTo(0.2525, 3);
            expect(estimateSelectivity(whereOf('SELECT * FROM t WHERE id > 75'), STATS)).toBeCloseTo(0.2424, 3);
          });

          it('列在右边时运算符要翻转', () => {
            const left = estimateSelectivity(whereOf('SELECT * FROM t WHERE id > 75'), STATS);
            const right = estimateSelectivity(whereOf('SELECT * FROM t WHERE 75 < id'), STATS);
            expect(right).toBeCloseTo(left, 6);
          });

          it('AND 相乘', () => {
            const combined = estimateSelectivity(
              whereOf('SELECT * FROM t WHERE active = 1 AND id = 5'),
              STATS
            );
            expect(combined).toBeCloseTo(0.5 * 0.01, 6);
          });

          it('OR 用容斥', () => {
            const combined = estimateSelectivity(
              whereOf('SELECT * FROM t WHERE active = 1 OR id = 5'),
              STATS
            );
            expect(combined).toBeCloseTo(0.5 + 0.01 - 0.5 * 0.01, 6);
          });

          it('超出范围的边界被夹到 0 和 1', () => {
            expect(estimateSelectivity(whereOf('SELECT * FROM t WHERE id < -100'), STATS)).toBe(0);
            expect(estimateSelectivity(whereOf('SELECT * FROM t WHERE id < 99999'), STATS)).toBe(1);
            expect(estimateSelectivity(whereOf('SELECT * FROM t WHERE id > 99999'), STATS)).toBe(0);
          });

          it('没统计过的列用兜底值', () => {
            expect(estimateSelectivity(whereOf('SELECT * FROM t WHERE unknown = 1'), STATS)).toBeCloseTo(
              DEFAULT_SELECTIVITY,
              6
            );
          });

          it('字符串范围估不出来，用兜底值', () => {
            expect(
              estimateSelectivity(whereOf("SELECT * FROM t WHERE name < 'user5'"), STATS)
            ).toBeCloseTo(DEFAULT_SELECTIVITY, 6);
          });
        });

        describe('阶段12 · 访问路径选择', () => {
          const options = { indexedColumns: ['id'], indexHeight: 3 };

          it('没有谓词就是全表扫描，代价是页数', () => {
            const path = chooseAccessPath(undefined, STATS, options);
            expect(path.kind).toBe('seq-scan');
            expect(path.estimatedCost).toBe(20);
            expect(path.estimatedRows).toBe(100);
          });

          it('高选择率的谓词走索引', () => {
            // id = 5 只命中 1 行：索引代价 3 + 1 = 4，远低于 20
            const path = chooseAccessPath(whereOf('SELECT * FROM t WHERE id = 5'), STATS, options);
            expect(path.kind).toBe('index-scan');
            expect(path.estimatedRows).toBe(1);
            expect(path.estimatedCost).toBe(4);
          });

          it('低选择率的谓词走全表扫描', () => {
            // id > 10 命中约 90 行：索引代价 3 + 90 = 93，比整表 20 页贵得多
            const path = chooseAccessPath(whereOf('SELECT * FROM t WHERE id > 10'), STATS, options);
            expect(path.kind).toBe('seq-scan');
            expect(path.estimatedCost).toBe(20);
          });

          it('列上没有索引就只能全表扫描', () => {
            const path = chooseAccessPath(whereOf('SELECT * FROM t WHERE active = 1'), STATS, options);
            expect(path.kind).toBe('seq-scan');
          });

          it('AND 里只要有一边能用索引就能用', () => {
            const path = chooseAccessPath(
              whereOf('SELECT * FROM t WHERE id = 5 AND active = 1'),
              STATS,
              options
            );
            expect(path.kind).toBe('index-scan');
          });

          it('OR 用不上单列索引', () => {
            const path = chooseAccessPath(
              whereOf('SELECT * FROM t WHERE id = 5 OR active = 1'),
              STATS,
              options
            );
            expect(path.kind).toBe('seq-scan');
          });

          it('树越高索引越不划算', () => {
            const shallow = chooseAccessPath(whereOf('SELECT * FROM t WHERE id < 3'), STATS, {
              indexedColumns: ['id'],
              indexHeight: 3,
            });
            const deep = chooseAccessPath(whereOf('SELECT * FROM t WHERE id < 3'), STATS, {
              indexedColumns: ['id'],
              indexHeight: 40,
            });
            expect(shallow.kind).toBe('index-scan');
            expect(deep.kind).toBe('seq-scan');
          });

          it('每一种场景都选中了真正便宜的那条路 [gate:optimizer]', () => {
            const scenarios = [
              'SELECT * FROM t WHERE id = 5',
              'SELECT * FROM t WHERE id = 50',
              'SELECT * FROM t WHERE id < 3',
              'SELECT * FROM t WHERE id < 25',
              'SELECT * FROM t WHERE id > 10',
              'SELECT * FROM t WHERE id > 95',
              'SELECT * FROM t WHERE id != 5',
              'SELECT * FROM t WHERE id = 5 AND active = 1',
            ];

            let mistakes = 0;
            for (const sql of scenarios) {
              const predicate = whereOf(sql);
              const path = chooseAccessPath(predicate, STATS, options);
              const rowsHit = Math.ceil(estimateSelectivity(predicate, STATS) * STATS.rowCount);
              const seqCost = STATS.pageCount;
              const indexCost = options.indexHeight + rowsHit;
              const cheapest = Math.min(seqCost, indexCost);
              // 选中的那条路，代价必须就是两条里最便宜的
              if (path.estimatedCost !== cheapest) mistakes += 1;
            }

            count('optimizerMistakes', mistakes);
            expect(mistakes).toBe(0);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.optimizerMistakes',
      op: 'eq',
      value: 0,
      zh: '八种场景全部选中更便宜的那条路',
      en: 'The cheaper path is chosen in all eight scenarios',
      dimension: 'latency',
      scope: 'gate:optimizer',
    }),
  ],
  referenceFiles: [
    file(
      'src/statistics.ts',
      code`
        import type { Tuple } from './plan';

        export interface ColumnStats {
          distinct: number;
          min: number | string;
          max: number | string;
        }

        export interface TableStats {
          rowCount: number;
          pageCount: number;
          columns: Record<string, ColumnStats>;
        }

        export function analyze(rows: Tuple[], pageCount: number): TableStats {
          const columns: Record<string, ColumnStats> = {};

          if (rows.length > 0) {
            for (const name of Object.keys(rows[0])) {
              const values = rows.map((row) => row[name]);
              let min = values[0];
              let max = values[0];
              for (const value of values) {
                if (value < min) min = value;
                if (value > max) max = value;
              }
              columns[name] = { distinct: new Set(values).size, min, max };
            }
          }

          return { rowCount: rows.length, pageCount, columns };
        }
      `
    ),
    file(
      'src/optimizer.ts',
      code`
        import type { CompareOp, Expr } from './ast';
        import type { TableStats } from './statistics';

        export interface AccessPath {
          kind: 'seq-scan' | 'index-scan';
          estimatedRows: number;
          estimatedCost: number;
        }

        export interface AccessOptions {
          indexedColumns: string[];
          indexHeight: number;
        }

        export const DEFAULT_SELECTIVITY = 1 / 3;

        function clamp(value: number): number {
          if (!isFinite(value)) return DEFAULT_SELECTIVITY;
          // 夹取不是可选的：负的选择率会让估算行数变成负数，代价模型直接崩
          return Math.min(1, Math.max(0, value));
        }

        /** 列在比较式右边时，把运算符翻过来，后面就只用考虑一种方向 */
        function flip(op: CompareOp): CompareOp {
          if (op === '<') return '>';
          if (op === '<=') return '>=';
          if (op === '>') return '<';
          if (op === '>=') return '<=';
          return op;
        }

        export function estimateSelectivity(expr: Expr, stats: TableStats): number {
          if (expr.kind !== 'binary') return DEFAULT_SELECTIVITY;

          if (expr.op === 'AND') {
            // 独立性假设：现实中相关的列会让这个乘积严重低估
            return clamp(estimateSelectivity(expr.left, stats) * estimateSelectivity(expr.right, stats));
          }
          if (expr.op === 'OR') {
            const left = estimateSelectivity(expr.left, stats);
            const right = estimateSelectivity(expr.right, stats);
            return clamp(left + right - left * right);
          }

          // 归一化：把列放到左边、字面量放到右边
          let op: CompareOp = expr.op;
          let column = expr.left;
          let literal = expr.right;
          if (expr.left.kind === 'literal' && expr.right.kind === 'column') {
            op = flip(expr.op);
            column = expr.right;
            literal = expr.left;
          }
          if (column.kind !== 'column' || literal.kind !== 'literal') return DEFAULT_SELECTIVITY;

          const stat = stats.columns[column.name];
          if (!stat) return DEFAULT_SELECTIVITY;

          const distinct = Math.max(1, stat.distinct);
          if (op === '=') return clamp(1 / distinct);
          if (op === '!=') return clamp(1 - 1 / distinct);

          // 范围只在数值列上估得出来，字符串走兜底
          if (typeof stat.min !== 'number' || typeof stat.max !== 'number' || typeof literal.value !== 'number') {
            return DEFAULT_SELECTIVITY;
          }

          const span = stat.max - stat.min;
          if (span <= 0) {
            if (op === '<' || op === '<=') return literal.value >= stat.max ? 1 : 0;
            return literal.value <= stat.min ? 1 : 0;
          }

          if (op === '<' || op === '<=') return clamp((literal.value - stat.min) / span);
          return clamp((stat.max - literal.value) / span);
        }

        /**
         * 单列索引在 OR 下面用不上：两边命中的行集合没有包含关系，
         * 两边都得查一遍。真实系统用位图索引扫描处理这种情况。
         */
        function indexUsable(expr: Expr, indexedColumns: string[]): boolean {
          if (expr.kind !== 'binary') return false;
          if (expr.op === 'OR') return false;
          if (expr.op === 'AND') {
            return indexUsable(expr.left, indexedColumns) || indexUsable(expr.right, indexedColumns);
          }

          const name =
            expr.left.kind === 'column'
              ? expr.left.name
              : expr.right.kind === 'column'
                ? expr.right.name
                : null;
          return name !== null && indexedColumns.indexOf(name) !== -1;
        }

        export function chooseAccessPath(
          predicate: Expr | undefined,
          stats: TableStats,
          options: AccessOptions
        ): AccessPath {
          const selectivity = predicate ? estimateSelectivity(predicate, stats) : 1;
          const estimatedRows = Math.ceil(selectivity * stats.rowCount);

          // 顺序扫描：每页读一次
          const seqCost = stats.pageCount;

          if (!predicate || !indexUsable(predicate, options.indexedColumns)) {
            return { kind: 'seq-scan', estimatedRows, estimatedCost: seqCost };
          }

          // 索引扫描：先走一次树，再为每个命中行回表读一页。
          // 命中行一多，这个数就会超过整表页数——这正是「有索引也别走索引」的算术依据
          const indexCost = options.indexHeight + estimatedRows;

          return indexCost < seqCost
            ? { kind: 'index-scan', estimatedRows, estimatedCost: indexCost }
            : { kind: 'seq-scan', estimatedRows, estimatedCost: seqCost };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**归一化比分支更省事。** 比较式有「列在左」和「列在右」两种写法，',
      '如果为每种运算符各写两个分支，代码会翻倍而且必然漏掉一两个。',
      '先把列换到左边、必要时翻转运算符，后面就只剩四个分支。',
      '漏翻转的后果特别隐蔽：`WHERE 75 < id` 的选择率会算成正确答案的补数，',
      '优化器于是做出恰好相反的选择，而查询结果完全正确——只是慢。',
      '',
      '**`clamp` 不是防御性编程，是模型的一部分。** 选择率的定义域就是 [0, 1]，',
      '线性插值只在字面量落在 min/max 之间时才有意义。`WHERE id < -100` 算出负数，',
      '乘上行数就是负的估算行数，代价模型会认为索引扫描代价为负、无脑选它。',
      '',
      '**`indexUsable` 在 OR 上直接返回 false。** 这一条是真实优化器行为的简化版，',
      '但方向是对的：`a = 1 OR b = 2` 无法只查一棵树就得到答案。',
      'PostgreSQL 在这里会考虑位图索引扫描（分别扫两棵索引再对位图做 OR），',
      '那是另一种访问路径，不是这一关的单列索引扫描。',
      '',
      '**代价模型只有两行算术，但它是整个优化器的核心。** `seqCost = pageCount`、',
      '`indexCost = height + rows`——这两个式子相交的那个点，就是「该不该走索引」的分界线。',
      '把 `indexCost` 写成常数、或者干脆不算，优化器就退化成了规则优化器。',
    ].join('\n'),
    [
      'Normalising beats branching. A comparison can put the column on either side, and writing two',
      'branches per operator doubles the code and guarantees one gets missed. Move the column left,',
      'flipping the operator when needed, and four branches remain. Missing the flip is especially',
      'insidious: `WHERE 75 < id` estimates the complement of the right answer, so the optimiser makes',
      'exactly the wrong choice while the query results stay perfectly correct — just slow.',
      '',
      '`clamp` is part of the model, not defensive programming. Selectivity is defined on [0, 1], and',
      'linear interpolation only means anything when the literal falls between min and max.',
      '`WHERE id < -100` computes negative, multiplying by row count gives negative estimated rows, and',
      'the cost model concludes an index scan costs less than nothing and always picks it.',
      '',
      '`indexUsable` returns false at an OR. It is a simplification of real optimiser behaviour, but the',
      'direction is right: `a = 1 OR b = 2` cannot be answered from one tree. PostgreSQL would consider a',
      'bitmap index scan here — scanning both indexes and OR-ing the bitmaps — which is a different access',
      'path, not the single-column index scan of this stage.',
      '',
      'The cost model is two lines of arithmetic and it is the whole optimiser. `seqCost = pageCount` and',
      '`indexCost = height + rows` — the point where those two lines cross is the boundary between using',
      'an index and not. Make `indexCost` a constant, or skip computing it, and the optimiser degenerates',
      'into a rule-based one.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

module.exports = {
  id: 'database-engine',
  title: t('从零实现一个数据库引擎', 'Build a database engine from scratch'),
  summary: t(
    '十二关走完一条完整的数据库：页式存储、B+Tree、WAL、两阶段锁、快照隔离、SQL 解析、火山模型执行器，最后是代价优化器。',
    'Twelve stages through a whole database: paged storage, a B+Tree, WAL, two-phase locking, snapshot isolation, a SQL parser, a Volcano executor, and a cost-based optimiser.'
  ),
  difficulty: 'Hard',
  domain: 'database',
  tags: [
    'database',
    'storage-engine',
    'b-tree',
    'wal',
    'concurrency-control',
    'mvcc',
    'sql-parser',
    'query-execution',
    'query-optimizer',
  ],
  estimatedMinutes: 600,
  language: 'typescript',
  weights: {
    correctness: 3,
    concurrency: 1.5,
    latency: 1.5,
    resilience: 2,
    encapsulation: 2,
    elegance: 1.5,
  },
  prerequisites: [
    t('会用 Uint8Array / DataView 读写二进制', 'Comfortable reading and writing binary with Uint8Array / DataView'),
    t('知道二叉查找树是什么（B+Tree 那一关会从头讲）', 'Know what a binary search tree is (the B+Tree stage starts from scratch)'),
    t('写过 async/await，理解 Promise 什么时候才 resolve', 'Have written async/await and understand when a Promise actually settles'),
    t('用过 SQL 的 SELECT / WHERE / JOIN / GROUP BY，不需要知道它们怎么实现', 'Have used SQL SELECT / WHERE / JOIN / GROUP BY, with no idea how they are implemented'),
  ],
  learningOutcomes: [
    t(
      '说清数据库为什么以「页」为单位读写，以及缓冲池凭什么能把 IO 降一个数量级',
      'Explain why a database reads and writes in pages, and how a buffer pool cuts IO by an order of magnitude'
    ),
    t(
      '手写一棵会分裂的 B+Tree，并用「读了几页」证明它确实是对数级的',
      'Write a splitting B+Tree by hand, and prove it is logarithmic by counting pages read'
    ),
    t(
      '解释 WAL 为什么必须先写日志再写数据页，以及崩溃后靠什么把数据库拉回一致状态',
      'Explain why WAL must reach the log before the data page, and what pulls the database back to a consistent state after a crash'
    ),
    t(
      '实现两阶段锁并用等待图抓出死锁，说清「可串行化」到底保证了什么',
      'Implement two-phase locking, catch deadlocks with a wait-for graph, and say precisely what serialisability guarantees'
    ),
    t(
      '用版本链做出快照隔离，并演示它挡得住不可重复读、挡不住写偏斜',
      'Build snapshot isolation on version chains, and demonstrate that it stops non-repeatable reads but not write skew'
    ),
    t(
      '把一条 SQL 从字符串变成 AST、逻辑计划、物理算子树，看着它一步步变成能跑的东西',
      'Turn a SQL string into an AST, a logical plan and a physical operator tree, and watch it become something that runs'
    ),
    t(
      '用火山模型写出可组合的算子，理解为什么它统治了三十年、又为什么现在被向量化取代',
      'Write composable operators in the Volcano model, and understand why it ruled for thirty years and why vectorisation replaced it'
    ),
    t(
      '基于统计信息估算选择率与代价，让优化器**算出**该走索引还是全表扫描，而不是猜',
      'Estimate selectivity and cost from statistics so the optimiser computes whether to use an index or scan, instead of guessing'
    ),
  ],
  brief: t(
    [
      '## 背景',
      '',
      '「数据库」听起来像个不可拆的黑盒。它不是。把一台商用数据库切开，里面是四叠',
      '互相咬合的东西，每一叠都在回答一组很具体的问题：',
      '',
      '| 层 | 关卡 | 回答的问题 |',
      '| --- | --- | --- |',
      '| 存储 | 1-3 | 数据在磁盘上怎么排，怎么少读盘，一行怎么变成字节 |',
      '| 索引 | 4 | 一百万行里找一行，怎么不扫全表 |',
      '| 事务 | 5-7 | 掉电怎么办，两个人同时改一行怎么办，读到一半别人提交了怎么办 |',
      '| 查询 | 8-12 | 一条 SQL 字符串怎么变成能跑的算子树，以及**该走哪条路** |',
      '',
      '十二关做完，你手上是一个能执行 SQL、有索引、有事务、掉电不丢数据、',
      '并且会自己判断该走索引还是全表扫描的引擎。',
      '',
      '## 平台提供什么',
      '',
      '`src/disk.ts` 是一块模拟磁盘，只读，你不能改它。它保留了真实磁盘的三个特性：',
      '',
      '```ts',
      'await disk.writePage(id, bytes);  // 只进了操作系统的页缓存',
      'await disk.fsync();               // 到这一步才真正持久',
      'disk.crash();                     // 没 fsync 的写入全部消失',
      '```',
      '',
      '每次读、写、fsync 都会计数，所以「你的实现读了几次盘」是能被量出来的，',
      '好几关的工程门槛量的正是它——一个跑得通但读盘二十次的实现，在这里过不了关。',
      '',
      '## 这十二关怎么串起来',
      '',
      '前一关的产物就是后一关的地基，而且是**真的**用上去：',
      '',
      '- 堆文件（3）建在缓冲池（1）和 slotted page（2）上；',
      '- B+Tree（4）的节点也是页，同样走缓冲池；',
      '- 执行器（10）的顺序扫描算子读的是堆文件，索引扫描算子读的是 B+Tree；',
      '- 优化器（12）算出来的代价，单位就是前面这些层真实消耗的页数。',
      '',
      '## 硬性约束',
      '',
      '1. 一页固定 128 字节，不能读写半页；',
      '2. `writePage` 之后、`fsync` 之前发生 crash，那次写入就是丢了——这不是 bug，是题设；',
      '3. 已提交的事务在崩溃后必须还在，没提交的必须消失；',
      '4. 并发事务不能观察到彼此的中间状态；',
      '5. 优化器必须**算**，不许写死「有索引就走索引」——低选择率的谓词走索引比全表扫描更慢。',
      '',
      '## 非目标',
      '',
      '- 不做网络协议、连接池、权限系统：这些是数据库的外壳，不是引擎；',
      '- 不做真正的多线程：并发用协作式的 async 模拟，锁和 MVCC 的语义一模一样，',
      '  但不必处理内存屏障和真实竞态；',
      '- 不做 B+Tree 删除后的合并、页回收、以及分布式相关的一切。',
      '',
      '## 术语',
      '',
      '- **页（page）**：磁盘 IO 的最小单位。',
      '- **缓冲池（buffer pool）**：页在内存里的缓存，数据库里最重要的那块内存。',
      '- **slot 目录**：页尾的一张小表，记录每条记录在页内的偏移和长度。',
      '- **WAL**：write-ahead log，先写日志再写数据页。',
      '- **2PL**：两阶段锁，加锁阶段只加不放，解锁阶段只放不加。',
      '- **MVCC**：多版本并发控制，读不阻塞写、写不阻塞读。',
      '- **火山模型**：每个算子都是一个 `next()`，算子树靠逐行拉取驱动。',
      '- **选择率（selectivity）**：一个谓词能筛掉多少行，优化器估代价的核心输入。',
    ].join('\n'),
    [
      '## Context',
      '',
      '"A database" sounds like an indivisible black box. It is not. Cut a commercial one open and you',
      'find four interlocking stacks, each answering a specific set of questions:',
      '',
      '| Layer | Stages | Questions it answers |',
      '| --- | --- | --- |',
      '| Storage | 1-3 | How is data laid out, how do we read less of it, how does a row become bytes |',
      '| Index | 4 | How do we find one row among a million without reading a million |',
      '| Transactions | 5-7 | What about power loss, two writers on one row, a commit landing mid-read |',
      '| Query | 8-12 | How does a SQL string become a runnable operator tree, and which plan should win |',
      '',
      'Twelve stages later you have an engine that executes SQL, has indexes and transactions, survives',
      'a power cut, and decides for itself whether to use an index or scan the table.',
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
      'disk" is measurable — and that is what several stage gates measure. An implementation that works',
      'but reads twenty pages where three would do does not pass here.',
      '',
      '## How the twelve stages connect',
      '',
      'Each stage is the foundation of the next, and actually gets used:',
      '',
      '- the heap file (3) sits on the buffer pool (1) and slotted pages (2);',
      '- B+Tree nodes (4) are pages too, and go through the same buffer pool;',
      "- the executor's (10) sequential scan reads the heap file, its index scan reads the B+Tree;",
      '- the costs the optimiser (12) computes are denominated in pages those layers really consume.',
      '',
      '## Hard constraints',
      '',
      '1. A page is exactly 128 bytes; there is no such thing as half a page;',
      '2. A crash between `writePage` and `fsync` loses that write. That is the premise, not a bug;',
      '3. Committed transactions must survive a crash, uncommitted ones must not;',
      '4. Concurrent transactions must not observe each other\'s intermediate state;',
      '5. The optimiser must compute. Hard-coding "use the index when one exists" is wrong — an index',
      '   scan under a low-selectivity predicate is slower than a sequential scan.',
      '',
      '## Non-goals',
      '',
      '- No wire protocol, connection pool or permission system: those are the shell, not the engine;',
      '- No real threads: concurrency is cooperative async, which has identical lock and MVCC semantics',
      '  without memory barriers and genuine races;',
      '- No B+Tree merging after deletes, no page reclamation, nothing distributed.',
      '',
      '## Glossary',
      '',
      '- Page: the smallest unit of disk IO.',
      '- Buffer pool: the in-memory cache of pages, the most important memory in a database.',
      '- Slot directory: a small table at the end of a page recording each record\'s offset and length.',
      '- WAL: write-ahead log, the log reaches disk before the data page does.',
      '- 2PL: two-phase locking — a growing phase that only acquires, a shrinking phase that only releases.',
      '- MVCC: multi-version concurrency control, where reads do not block writes and writes do not block reads.',
      '- Volcano model: every operator is a `next()`, and the tree is driven by pulling one row at a time.',
      '- Selectivity: what fraction of rows a predicate keeps — the core input to cost estimation.',
    ].join('\n')
  ),
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  SQL[SQL text] --> PA[8 parser]',
      '  PA --> PL[9 binder and logical plan]',
      '  PL --> OP[12 cost-based optimiser]',
      '  OP --> EX[10 Volcano executor]',
      '  EX --> JN[11 join operators]',
      '  EX --> HF[3 heap file]',
      '  EX --> BT[4 B+Tree index]',
      '  HF --> SP[2 slotted page]',
      '  BT --> PG[1 pager buffer pool]',
      '  SP --> PG',
      '  PG --> D[(disk)]',
      '  TX[6 lock manager and 7 MVCC] -.guards.-> HF',
      '  WAL[5 write-ahead log] --> D',
      '  PG -. must log first .-> WAL',
      '```',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  SQL[SQL text] --> PA[8 parser]',
      '  PA --> PL[9 binder and logical plan]',
      '  PL --> OP[12 cost-based optimiser]',
      '  OP --> EX[10 Volcano executor]',
      '  EX --> JN[11 join operators]',
      '  EX --> HF[3 heap file]',
      '  EX --> BT[4 B+Tree index]',
      '  HF --> SP[2 slotted page]',
      '  BT --> PG[1 pager buffer pool]',
      '  SP --> PG',
      '  PG --> D[(disk)]',
      '  TX[6 lock manager and 7 MVCC] -.guards.-> HF',
      '  WAL[5 write-ahead log] --> D',
      '  PG -. must log first .-> WAL',
      '```',
    ].join('\n')
  ),
  files: [contract, disk],
  stages: [stage1, stage2, stage3, stage4, stage5, stage6, stage7, stage8, stage9, stage10, stage11, stage12],
};
