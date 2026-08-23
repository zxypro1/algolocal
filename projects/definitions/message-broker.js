/**
 * 工程实战 · 高并发消息系统
 *
 * 注意：代码片段使用 String.raw 模板，不要在片段里写 `${}`。
 */
const { t, code, file, readonlyFile, spec, gate } = require('./_helpers');

/* ------------------------------------------------------------------ */
/* 平台提供的基础设施                                                   */
/* ------------------------------------------------------------------ */

const storage = readonlyFile(
  'src/support/storage.ts',
  code`
    /**
     * 分段日志设备（只读，平台提供）
     *
     * 它模拟的是一块真实的盘，而这道题的每一关都在和它的三个特性较劲：
     *
     * - **顺序写便宜，随机写贵**：append 是唯一该走的路，overwrite 能用，
     *   但每次都会记一笔 counters.randomWrites；
     * - **fsync 才算持久**：append 之后、fsync 之前 crash()，那批数据就没了，
     *   而 fsync 要 5ms，所以「攒一批只 fsync 一次」是能被量出来的；
     * - **读一条记录就是一次 IO**：每次 readAt 记一笔 counters.recordsScanned，
     *   「定位一条消息扫了多少条」因此不是估算，是读数。
     */
    import { sleep } from '@lab/env';
    import { count } from '@lab/metrics';

    /** 每条记录的固定开销（长度、CRC 之类），算字节数时要带上 */
    export const RECORD_HEADER_BYTES = 8;

    const FSYNC_MS = 5;

    /** 落在盘上的一条记录 */
    export interface StoredRecord {
      /** 全局单调递增的逻辑位置 */
      offset: number;
      key: string;
      value: string;
      /** 这条记录占多少字节 */
      size: number;
    }

    export interface SegmentInfo {
      id: number;
      /** 这个段里第一条记录的 offset */
      baseOffset: number;
      bytes: number;
      count: number;
    }

    export interface StorageDevice {
      /** 新建一个段。每次调用都会被计入 counters.segmentsCreated。 */
      createSegment(baseOffset: number): number;
      /** 往段尾追加一条，返回它在段内的下标。计入 counters.storageAppends。 */
      append(segmentId: number, record: { offset: number; key: string; value: string }): number;
      /** 覆盖写。能用，但它是随机写，计入 counters.randomWrites。 */
      overwrite(segmentId: number, index: number, record: { offset: number; key: string; value: string }): void;
      /** 读段内第 index 条。计入 counters.recordsScanned。 */
      readAt(segmentId: number, index: number): StoredRecord | null;
      segments(): SegmentInfo[];
      /** 把所有已追加的数据落盘。计入 counters.storageFsyncs，耗时 5ms。 */
      fsync(): Promise<void>;
      /** 掉电：没 fsync 的追加全部消失 */
      crash(): void;
      /** 删掉一个段，保留策略用 */
      deleteSegment(segmentId: number): void;
      /** 当前保留的总字节数 */
      bytes(): number;
      /** 一条记录会占多少字节 */
      sizeOf(key: string, value: string): number;
    }

    interface Segment {
      id: number;
      baseOffset: number;
      records: StoredRecord[];
      /** 前多少条已经落盘了 */
      durable: number;
    }

    export function createStorage(): StorageDevice {
      const segments: Segment[] = [];
      let nextSegmentId = 0;
      /** 已经落盘的段数，crash 时后面新建的段一起消失 */
      let durableSegments = 0;

      function segmentOf(segmentId: number): Segment | undefined {
        return segments.filter((segment) => segment.id === segmentId)[0];
      }

      function measure(key: string, value: string): number {
        return RECORD_HEADER_BYTES + key.length + value.length;
      }

      return {
        createSegment(baseOffset: number): number {
          count('segmentsCreated');
          const segment: Segment = { id: nextSegmentId, baseOffset, records: [], durable: 0 };
          nextSegmentId += 1;
          segments.push(segment);
          return segment.id;
        },

        append(segmentId: number, record: { offset: number; key: string; value: string }): number {
          const segment = segmentOf(segmentId);
          if (!segment) throw new Error('no such segment: ' + segmentId);
          count('storageAppends');
          const size = measure(record.key, record.value);
          segment.records.push({ offset: record.offset, key: record.key, value: record.value, size });
          return segment.records.length - 1;
        },

        overwrite(segmentId: number, index: number, record: { offset: number; key: string; value: string }): void {
          const segment = segmentOf(segmentId);
          if (!segment || index < 0 || index >= segment.records.length) {
            throw new Error('cannot overwrite outside the segment');
          }
          // 随机写：真实盘上它比顺序写贵一个数量级，这里把它记下来
          count('randomWrites');
          const size = measure(record.key, record.value);
          segment.records[index] = { offset: record.offset, key: record.key, value: record.value, size };
        },

        readAt(segmentId: number, index: number): StoredRecord | null {
          const segment = segmentOf(segmentId);
          if (!segment) return null;
          count('recordsScanned');
          const record = segment.records[index];
          return record ? { ...record } : null;
        },

        /** 按 baseOffset 排序返回：真实系统里段文件也是按名字（baseOffset）排的 */
        segments(): SegmentInfo[] {
          return segments
            .map((segment) => ({
              id: segment.id,
              baseOffset: segment.baseOffset,
              bytes: segment.records.reduce((total, record) => total + record.size, 0),
              count: segment.records.length,
            }))
            .sort((left, right) => left.baseOffset - right.baseOffset || left.id - right.id);
        },

        async fsync(): Promise<void> {
          count('storageFsyncs');
          await sleep(FSYNC_MS);
          for (const segment of segments) segment.durable = segment.records.length;
          durableSegments = segments.length;
        },

        crash(): void {
          segments.length = Math.min(segments.length, durableSegments);
          for (const segment of segments) segment.records.length = segment.durable;
        },

        deleteSegment(segmentId: number): void {
          const index = segments.findIndex((segment) => segment.id === segmentId);
          if (index < 0) return;
          segments.splice(index, 1);
          durableSegments = Math.min(durableSegments, segments.length);
        },

        bytes(): number {
          return segments.reduce(
            (total, segment) =>
              total + segment.records.reduce((sum, record) => sum + record.size, 0),
            0
          );
        },

        sizeOf(key: string, value: string): number {
          return measure(key, value);
        },
      };
    }
  `
);

const replica = readonlyFile(
  'src/support/replica.ts',
  code`
    /**
     * 从副本（只读，平台提供）
     *
     * 它只做一件事：**慢一点地确认**。send 过去的数据要等 lagMs 之后才算它收到，
     * stall() 之后更久。第 8 关的高水位就是从这些确认位置里算出来的。
     */
    import { sleep } from '@lab/env';
    import type { StoredRecord } from './storage';

    export interface Replica {
      id: string;
      /** 把一批记录推给它。返回的 Promise 在它确认之后 resolve。 */
      send(records: StoredRecord[]): Promise<void>;
      /** 它已经确认到哪个 offset（含）。什么都没收到时是 -1。 */
      ackedOffset(): number;
      /** 让它掉队：之后每次确认额外慢这么多 */
      stall(extraMs: number): void;
      /** 恢复正常 */
      resume(): void;
    }

    export function createReplica(id: string, options: { lagMs: number }): Replica {
      let acked = -1;
      let extra = 0;

      return {
        id,

        async send(records: StoredRecord[]): Promise<void> {
          await sleep(options.lagMs + extra);
          for (const record of records) {
            if (record.offset > acked) acked = record.offset;
          }
        },

        ackedOffset(): number {
          return acked;
        },

        stall(extraMs: number): void {
          extra = extraMs;
        },

        resume(): void {
          extra = 0;
        },
      };
    }
  `
);

/* ------------------------------------------------------------------ */
/* 第 1 关 · 追加写日志与段滚动                                         */
/* ------------------------------------------------------------------ */

const stage1 = {
  id: 'segment-log',
  title: t('第 1 关 · 追加写日志', 'Stage 1 · An append-only log'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '消息系统的底座是一个**只往后追加的日志**。这不是实现上的偷懒，是选择：',
      '',
      '顺序写在真实磁盘上比随机写快一到两个数量级 —— 机械盘不用寻道，',
      'SSD 不用读改写整块。一个「只追加、不修改」的结构因此天然跑得快，',
      '而且它顺带解决了另外三件事：写入天然有序、旧数据天然可重放、',
      '并发写入天然只有一个竞争点（末尾）。',
      '',
      '代价是「修改」这个操作没了。改一条消息的办法是**再追加一条**。',
      '后面十一关，包括压缩、复制、重投，全都建立在这个约定上。',
      '',
      '## 要实现什么',
      '',
      '在 `src/log.ts` 实现 `createLog(storage, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `append(key, value)` | 追加一条，返回它的 offset、所在段和段内下标 |',
      '| `read(offset, max)` | 从 offset 开始顺序读，最多 max 条 |',
      '| `endOffset()` | 下一条会拿到的 offset |',
      '| `segments()` | 段的元信息 |',
      '| `flush()` | 落盘 |',
      '',
      'offset 从 0 开始，每条加一。段按字节滚动：',
      '当前段装不下这一条了，就 `createSegment` 开一个新的。',
      '',
      '## 怎么算过',
      '',
      '- 读回来的顺序、内容和写进去的完全一致；',
      '- **同一个 key 追加两次是两条记录**，不是覆盖',
      '  （门槛 `counters.randomWrites = 0` 数的就是「你回头改了几次」）；',
      '- 每个段的字节数不超过 `segmentBytes`，100 条 24 字节的记录、',
      '  段上限 240 字节，正好滚出 10 个段（门槛 `counters.segmentsCreated ≤ 10`）；',
      '- 单条记录比段上限还大时，它自己独占一个段，而不是被拒绝；',
      '- `flush()` 之后 crash，数据还在；没 flush 就 crash，那批数据没了。',
      '',
      '## 最后那条在考什么',
      '',
      '考你有没有**在内存里另存一份**。',
      '',
      '把追加过的记录同时塞进一个数组，读的时候直接返回它 —— 快得多，也对得上，',
      '直到 `crash()` 发生：设备上的数据没了，你的数组还在，',
      '于是日志报告的内容和盘上真实的内容对不上。',
      '这在真实系统里叫「静默数据丢失」，比崩溃难查得多。',
      '',
      '## 最容易写错的地方',
      '',
      '段滚动的判断写成「先追加，再看超没超」。',
      '',
      '这样每个段都会超出上限一条记录。数字上只差一点，但段的大小是',
      '保留策略、复制批量、索引间隔共同依赖的参数 —— 它「差不多对」的时候，',
      '后面每一层都跟着差不多对。',
    ].join('\n'),
    [
      'The foundation of a message system is a log that only ever grows at the end. That is a choice, not a',
      'shortcut:',
      '',
      'Sequential writes beat random writes by one to two orders of magnitude on real hardware — no seeking on',
      'a spinning disk, no read-modify-write of a block on an SSD. An append-only structure is therefore fast',
      'by construction, and it happens to solve three more problems for free: writes are inherently ordered,',
      'old data is inherently replayable, and concurrent writers contend at exactly one point (the end).',
      '',
      'The price is that "modify" no longer exists. Changing a message means **appending another one.** All',
      'eleven stages that follow — compaction, replication, redelivery — rest on that convention.',
      '',
      '## What to build',
      '',
      'Implement `createLog(storage, options)` in `src/log.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `append(key, value)` | Append one record; return its offset, segment and slot |',
      '| `read(offset, max)` | Read sequentially from offset, at most max records |',
      '| `endOffset()` | The offset the next append will receive |',
      '| `segments()` | Segment metadata |',
      '| `flush()` | Make it durable |',
      '',
      'Offsets start at 0 and increase by one. Segments roll by bytes: when the active segment cannot fit the',
      'incoming record, `createSegment` opens a new one.',
      '',
      '## What counts as passing',
      '',
      '- What comes back matches what went in, in order;',
      '- **Appending the same key twice produces two records**, not an overwrite',
      '  (the `counters.randomWrites = 0` gate counts how often you went back and edited);',
      '- No segment exceeds `segmentBytes`: 100 records of 24 bytes with a 240-byte limit roll into exactly ten',
      '  segments (the `counters.segmentsCreated ≤ 10` gate);',
      '- A record larger than the segment limit gets a segment of its own rather than being refused;',
      '- After `flush()` a crash loses nothing; without a flush, that batch is gone.',
      '',
      '## What that last one is really testing',
      '',
      'Whether you kept **a second copy in memory.**',
      '',
      'Pushing every appended record into an array and serving reads from it is much faster and agrees with',
      'the device — right up until `crash()`. The device loses the data, your array does not, and the log now',
      'reports content the disk does not have. In production that is called silent data loss, and it is far',
      'harder to find than a crash.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Deciding to roll after appending instead of before.',
      '',
      'Every segment then overshoots the limit by one record. It is a small number, and segment size is the',
      'parameter that retention, replication batches and index intervals all depend on — when it is',
      'approximately right, every layer above it is approximately right too.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  A["append(key, value)"] --> SZ["size = storage.sizeOf(key, value)"]',
      '  SZ --> HAS{"有活动段吗？"}',
      '  HAS -- 没有 --> NEW["createSegment(下一个 offset)"]',
      '  HAS -- 有 --> FIT{"装得下吗？<br/>已用 + size 不超过上限"}',
      '  FIT -- 装不下 --> NEW',
      '  FIT -- 装得下 --> PUT["storage.append(活动段, 记录)"]',
      '  NEW --> PUT',
      '  PUT --> BUMP["offset 加一<br/>活动段字节数加 size"]',
      '  BUMP --> RET["返回 offset / 段 id / 段内下标"]',
      '',
      '  R["read(offset, max)"] --> SEGS["storage.segments() 拿段列表"]',
      '  SEGS --> SKIP["跳过整段都在 offset 之前的段"]',
      '  SKIP --> SCAN["在段内逐条 readAt"]',
      '  SCAN --> COLL["offset 够大的收进结果"]',
      '  COLL --> STOP{"收够 max 条了？"}',
      '  STOP -- 是 --> DONE["返回"]',
      '  STOP -- 否 --> SCAN',
      '```',
      '',
      '要点：`read` 的数据来源是 `storage`，不是内存里的副本。',
      '这条边决定了 crash 之后日志说的话和盘上的事实是不是一致的。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  A["append(key, value)"] --> SZ["size = storage.sizeOf(key, value)"]',
      '  SZ --> HAS{"is there an active segment?"}',
      '  HAS -- no --> NEW["createSegment(next offset)"]',
      '  HAS -- yes --> FIT{"does it fit?<br/>used + size within the limit"}',
      '  FIT -- no --> NEW',
      '  FIT -- yes --> PUT["storage.append(active segment, record)"]',
      '  NEW --> PUT',
      '  PUT --> BUMP["offset + 1<br/>active bytes + size"]',
      '  BUMP --> RET["return offset / segment id / slot"]',
      '',
      '  R["read(offset, max)"] --> SEGS["storage.segments() for the list"]',
      '  SEGS --> SKIP["skip segments entirely below offset"]',
      '  SKIP --> SCAN["readAt through the segment"]',
      '  SCAN --> COLL["collect records at or past offset"]',
      '  COLL --> STOP{"collected max?"}',
      '  STOP -- yes --> DONE["return"]',
      '  STOP -- no --> SCAN',
      '```',
      '',
      'The point: `read` sources its data from `storage`, not from an in-memory copy. That edge decides',
      'whether the log tells the truth after a crash.',
    ].join('\n')
  ),
  checklist: [
    t('offset 从 0 开始逐条递增', 'Offsets start at 0 and increase by one'),
    t('滚动判断在追加之前', 'The roll decision comes before the append'),
    t('同一个 key 再写就是再追加一条', 'Writing a key again appends another record'),
    t('超大记录独占一个段', 'An oversized record gets its own segment'),
    t('读数据来自设备，不来自内存副本', 'Reads come from the device, not a memory copy'),
  ],
  pitfalls: [
    t(
      '在内存里再存一份记录数组，读的时候直接返回它。快，而且平时完全正确 —— 直到掉电：设备丢了没 fsync 的部分，你的数组还完整，日志于是开始报告盘上不存在的数据。真实系统里这叫静默数据丢失。',
      'Keeping a parallel array of records and serving reads from it. Fast, and correct until a power cut: the device drops everything unsynced while your array stays whole, and the log starts reporting data the disk does not have. Production calls that silent data loss.'
    ),
    t(
      '想「更新」一条消息时回头 overwrite。日志结构的全部价值来自「写过的不再改」：改了之后，副本同步、重放、压缩这些依赖「同一个 offset 永远是同一条内容」的机制全部失效，而且随机写本身也慢一个数量级。',
      'Reaching for overwrite to "update" a message. The entire value of a log comes from never rewriting: replication, replay and compaction all assume an offset always names the same content, and a random write is an order of magnitude slower besides.'
    ),
    t(
      '段滚动只看条数不看字节。真实系统里消息大小差异极大 —— 一条 100 字节的心跳和一条 1MB 的图片都算「一条」。按条数滚动会滚出大小相差一万倍的段，而保留策略是按段删的，于是「保留最近 1GB」会变成一个完全不可预测的量。',
      'Rolling segments by record count instead of bytes. Message sizes vary enormously — a 100-byte heartbeat and a 1MB image are both "one record" — so counting produces segments that differ by four orders of magnitude. Retention deletes whole segments, which turns "keep the last 1GB" into an unpredictable quantity.'
    ),
    t(
      '当一条记录比段上限还大时直接抛错。日志层不该替调用方决定「这条消息太大了」—— 那是生产者的策略。它该做的是给它一个自己的段：单条超限是配置问题，不是数据错误。',
      'Throwing when a record exceeds the segment limit. The log layer does not get to decide a message is too large — that is the producer\'s policy. It should give the record its own segment: an oversized record is a configuration question, not corrupt data.'
    ),
  ],
  hints: [
    t(
      '活动段只需要记两个数：段 id 和它已经用掉的字节数。滚动的时候两个一起重置。',
      'The active segment needs two numbers: its id and the bytes it has used. Rolling resets both.'
    ),
    t(
      '`read` 里跳过整段的条件是 `offset >= 段.baseOffset + 段.count` —— 这一句省掉的就是「从头扫」的代价，也是第 2 关那个索引的雏形。',
      'The skip condition in `read` is `offset >= segment.baseOffset + segment.count`. That line is what saves you from scanning from zero, and it is the embryo of the index in stage 2.'
    ),
  ],
  extension: t(
    [
      'Kafka 的日志就是这个结构：一个分区是一个目录，目录里是一堆 `.log` 段文件，',
      '文件名就是这个段的 baseOffset。段滚动由 `log.segment.bytes`（默认 1GB）',
      '和 `log.roll.ms` 共同决定 —— 后者保证低流量的分区也不会永远停在一个段上，',
      '否则保留策略永远删不掉东西。',
      '',
      '「顺序写有多快」这件事有个经典数据：ACM Queue 2009 年的一篇文章测出',
      '在当时的磁盘上，顺序写是 53MB/s，随机写是 0.4MB/s，差 100 倍以上。',
      'SSD 缩小了这个差距，但没有消除：随机写会引发写放大，直接影响寿命。',
      '',
      '还有一个这一关没做的东西：**每条记录的 CRC**。真实的日志会给每条记录',
      '存一个校验和，读的时候校验一遍 —— 因为磁盘会悄悄地写坏一个 bit，',
      '而在一个只追加的系统里，损坏会被无限期地保留下去。',
    ].join('\n'),
    [
      "Kafka's log is exactly this structure: a partition is a directory of `.log` segment files whose names",
      'are their base offsets. Rolling is governed by `log.segment.bytes` (1GB by default) together with',
      '`log.roll.ms` — the second exists so a low-traffic partition does not sit in one segment forever, which',
      'would leave retention with nothing it is allowed to delete.',
      '',
      'There is a classic number for how much faster sequential writes are: an ACM Queue article from 2009',
      'measured 53MB/s sequential against 0.4MB/s random on the disks of the day, a factor of over a hundred.',
      'SSDs narrowed the gap without closing it — random writes cause write amplification, which costs',
      'endurance.',
      '',
      'One thing this stage leaves out: **a CRC per record.** Real logs store a checksum with every record and',
      'verify it on read, because disks do silently flip bits, and in an append-only system corruption is kept',
      'indefinitely.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'encapsulation'],
  lab: {},
  starterFiles: [
    storage,
    replica,
    file(
      'src/log.ts',
      code`
        import type { SegmentInfo, StorageDevice, StoredRecord } from './support/storage';

        export interface AppendResult {
          /** 这条记录的全局位置 */
          offset: number;
          segmentId: number;
          /** 在这个段里的下标 */
          index: number;
        }

        export interface LogOptions {
          /** 一个段最多装多少字节 */
          segmentBytes: number;
        }

        export interface MessageLog {
          append(key: string, value: string): AppendResult;
          /** 从 offset 开始顺序读，最多 max 条 */
          read(offset: number, max: number): StoredRecord[];
          /** 下一条会拿到的 offset */
          endOffset(): number;
          segments(): SegmentInfo[];
          flush(): Promise<void>;
        }

        export function createLog(storage: StorageDevice, options: LogOptions): MessageLog {
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
        import { createLog } from '../src/log';
        import { createStorage } from '../src/support/storage';

        /** 8 字节头 + 4 字节 key + 12 字节 value = 24 字节一条 */
        const SEGMENT_BYTES = 240;

        function keyOf(index: number): string {
          return 'k' + String(index % 1000).padStart(3, '0');
        }

        function valueOf(index: number): string {
          return 'v' + String(index).padStart(11, '0');
        }

        function makeLog(segmentBytes = SEGMENT_BYTES) {
          const storage = createStorage();
          return { storage, log: createLog(storage, { segmentBytes }) };
        }

        function fill(log: any, count: number): void {
          for (let index = 0; index < count; index += 1) {
            log.append(keyOf(index), valueOf(index));
          }
        }

        describe('阶段1 · 追加写日志', () => {
          it('offset 从 0 开始逐条递增', () => {
            const context = makeLog();

            expect(context.log.append('k000', valueOf(0)).offset).toBe(0);
            expect(context.log.append('k001', valueOf(1)).offset).toBe(1);
            expect(context.log.endOffset()).toBe(2);
          });

          it('读回来的顺序和内容与写进去的一致', () => {
            const context = makeLog();
            fill(context.log, 5);

            const records = context.log.read(0, 10);
            expect(records).toHaveLength(5);
            expect(records.map((record: any) => record.offset)).toEqual([0, 1, 2, 3, 4]);
            expect(records[3].value).toBe(valueOf(3));
          });

          it('同一个 key 写两次是两条记录，不是覆盖', () => {
            const context = makeLog();

            context.log.append('same-key', valueOf(1));
            context.log.append('same-key', valueOf(2));

            const records = context.log.read(0, 10);
            expect(records).toHaveLength(2);
            expect(records[0].value).toBe(valueOf(1));
            expect(records[1].value).toBe(valueOf(2));
          });

          it('段按字节滚动，谁也不超上限 [gate:segments]', () => {
            const context = makeLog();
            fill(context.log, 100);

            const segments = context.log.segments();
            expect(segments.length).toBeGreaterThanOrEqual(10);
            for (const segment of segments) {
              expect(segment.bytes).toBeLessThanOrEqual(SEGMENT_BYTES);
            }
          });

          it('段的 baseOffset 首尾相接', () => {
            const context = makeLog();
            fill(context.log, 100);

            let expected = 0;
            for (const segment of context.log.segments()) {
              expect(segment.baseOffset).toBe(expected);
              expected += segment.count;
            }
            expect(expected).toBe(100);
          });

          it('从中间读，并且最多读 max 条', () => {
            const context = makeLog();
            fill(context.log, 100);

            const records = context.log.read(45, 3);
            expect(records).toHaveLength(3);
            expect(records[0].offset).toBe(45);
            expect(records[2].offset).toBe(47);
          });

          it('读到末尾之后返回空数组', () => {
            const context = makeLog();
            fill(context.log, 5);

            expect(context.log.read(5, 10)).toEqual([]);
            expect(context.log.read(99, 10)).toEqual([]);
          });

          it('空日志读出来是空的', () => {
            const context = makeLog();

            expect(context.log.read(0, 10)).toEqual([]);
            expect(context.log.endOffset()).toBe(0);
          });

          it('比段上限还大的单条记录独占一个段', () => {
            const context = makeLog();
            const huge = 'x'.repeat(SEGMENT_BYTES * 2);

            context.log.append('k000', valueOf(0));
            const result = context.log.append('big', huge);

            expect(result.offset).toBe(1);
            expect(context.log.read(1, 1)[0].value).toBe(huge);
            expect(context.log.segments()).toHaveLength(2);
          });

          it('flush 之后掉电，数据还在', async () => {
            const context = makeLog();
            fill(context.log, 30);
            await context.log.flush();

            context.storage.crash();

            expect(context.log.read(0, 100)).toHaveLength(30);
          });

          it('没 flush 就掉电，那批数据没了', async () => {
            const context = makeLog();
            fill(context.log, 20);
            await context.log.flush();
            fill(context.log, 20);

            context.storage.crash();

            // 内存里另存一份的实现会在这里报出 40 条
            expect(context.log.read(0, 100)).toHaveLength(20);
          });

          it('段内下标是连续的', () => {
            const context = makeLog();

            const first = context.log.append(keyOf(0), valueOf(0));
            const second = context.log.append(keyOf(1), valueOf(1));

            expect(first.index).toBe(0);
            expect(second.index).toBe(1);
            expect(second.segmentId).toBe(first.segmentId);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.randomWrites',
      op: 'eq',
      value: 0,
      zh: '一次随机写都没有，全是追加',
      en: 'Not one random write — appends only',
      dimension: 'latency',
    }),
    gate({
      metric: 'counters.segmentsCreated',
      op: 'lte',
      value: 10,
      zh: '100 条记录最多滚出 10 个段',
      en: 'A hundred records roll into at most ten segments',
      dimension: 'latency',
      scope: 'gate:segments',
    }),
  ],
  referenceFiles: [
    file(
      'src/log.ts',
      code`
        import type { SegmentInfo, StorageDevice, StoredRecord } from './support/storage';

        export interface AppendResult {
          offset: number;
          segmentId: number;
          index: number;
        }

        export interface LogOptions {
          segmentBytes: number;
        }

        export interface MessageLog {
          append(key: string, value: string): AppendResult;
          read(offset: number, max: number): StoredRecord[];
          endOffset(): number;
          segments(): SegmentInfo[];
          flush(): Promise<void>;
        }

        export function createLog(storage: StorageDevice, options: LogOptions): MessageLog {
          let nextOffset = 0;
          /** 活动段只需要这两个数 */
          let activeSegmentId = -1;
          let activeBytes = 0;

          function roll(): void {
            activeSegmentId = storage.createSegment(nextOffset);
            activeBytes = 0;
          }

          /** 判断在追加之前做：先追加再看超没超，每个段都会多出一条 */
          function segmentFor(size: number): number {
            if (activeSegmentId < 0) roll();
            // 段是空的时候无条件接受：超大的单条记录也得有地方放
            else if (activeBytes > 0 && activeBytes + size > options.segmentBytes) roll();
            return activeSegmentId;
          }

          return {
            append(key: string, value: string): AppendResult {
              const size = storage.sizeOf(key, value);
              const segmentId = segmentFor(size);
              const offset = nextOffset;

              const index = storage.append(segmentId, { offset, key, value });
              nextOffset += 1;
              activeBytes += size;

              return { offset, segmentId, index };
            },

            read(offset: number, max: number): StoredRecord[] {
              const found: StoredRecord[] = [];
              if (max <= 0) return found;

              for (const segment of storage.segments()) {
                // 整段都在 offset 之前，一条都不用读
                if (offset >= segment.baseOffset + segment.count) continue;

                for (let index = 0; index < segment.count; index += 1) {
                  // 数据来自设备：掉电丢掉的部分在这里自然读不到
                  const record = storage.readAt(segment.id, index);
                  if (!record) break;
                  if (record.offset < offset) continue;
                  found.push(record);
                  if (found.length >= max) return found;
                }
              }

              return found;
            },

            endOffset(): number {
              return nextOffset;
            },

            segments(): SegmentInfo[] {
              return storage.segments();
            },

            async flush(): Promise<void> {
              await storage.fsync();
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
      '**滚动判断在追加之前，而且空段无条件接受。** 两句写在一起才完整：',
      '前者保证段不超限，后者保证「超大记录」不会因为「永远装不下」而被无限滚动。',
      '少了后一句，一条超过段上限的消息会让 `segmentFor` 每次都开新段却仍然放不下。',
      '',
      '**`read` 从 `storage.segments()` 出发，一条内存副本都不留。** 这让日志在',
      'crash 之后说的是盘上的事实。代价是每次读都要走设备 —— 而那正是第 2 关',
      '要解决的问题：不是把数据搬进内存，而是**少读几条**。',
      '',
      '**活动段的字节数自己算，不去问设备。** `storage.segments()` 每次都要',
      '遍历所有记录求和，放在 append 的热路径上就是 O(n) 的开销。',
      '一个 `activeBytes` 变量把它变成 O(1)，代价是要记得在滚动时清零。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'The roll decision comes before the append, and an empty segment accepts unconditionally. Both halves',
      'are needed: the first keeps segments within the limit, the second stops an oversized record from',
      'rolling forever because it never fits. Without the second, a message larger than the segment limit',
      'makes `segmentFor` open a fresh segment on every call and still fail to place it.',
      '',
      '`read` starts from `storage.segments()` and keeps no memory copy, so the log tells the truth after a',
      'crash. The cost is that every read touches the device — which is exactly the problem stage 2 solves,',
      'not by moving data into memory but by **reading fewer records.**',
      '',
      'The active segment tracks its own byte count rather than asking the device. `storage.segments()` sums',
      'over every record, which on the append hot path is O(n) work. One `activeBytes` variable makes it O(1),',
      'at the cost of remembering to reset it when rolling.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 2 关 · 稀疏索引                                                   */
/* ------------------------------------------------------------------ */

const stage2 = {
  id: 'offset-index',
  title: t('第 2 关 · 稀疏索引', 'Stage 2 · A sparse index'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关的 `read` 有个问题：它靠段的 baseOffset 跳过整段，',
      '但一旦进了目标段，就只能从段头一条条扫过去。',
      '',
      '段有多大，这个代价就有多大。一个装一千条消息的段，',
      '读它中间那条要先读掉五百条 —— 而「消费者从上次的位置继续读」',
      '正是消息系统里最高频的操作。',
      '',
      '解法是给日志配一张索引。但**不是每条都记**：',
      '每条都记的索引和日志一样大，内存装不下，维护成本也翻倍。',
      '每隔 N 条记一个锚点，定位时先跳到最近的锚点，再往后扫最多 N 条 ——',
      '用「多扫 N 条」换掉「多存 N 倍索引」。这就是**稀疏索引**。',
      '',
      '## 要实现什么',
      '',
      '在 `src/offsetIndex.ts` 实现两个东西：',
      '',
      '**`createOffsetIndex(options)`** —— 索引本身：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `observe(result)` | 每追加一条问一次，由它决定要不要记锚点 |',
      '| `locate(offset)` | 返回**不超过** offset 的最近一个锚点 |',
      '| `size()` | 记了多少个锚点 |',
      '',
      '**`createIndexedLog(storage, options)`** —— 带索引的日志：',
      '接口和第 1 关的 `MessageLog` 一样，再加上 `indexSize()` 和 `locate()`。',
      '它应该**复用**第 1 关的 `createLog`，而不是把追加逻辑再写一遍。',
      '',
      '## 怎么算过',
      '',
      '- 索引是稀疏的：6000 条记录、间隔 16，锚点数在 400 上下，不是 6000；',
      '- `locate` 返回的锚点指向的位置确实是那条记录；',
      '- 读到的内容和第 1 关完全一致，跨段读也正常；',
      '- **定位第 5500 条最多扫 16 条**（门槛 `counters.recordsScanned ≤ 16`）——',
      '  没有索引的话，这一条要从它所在段的段头扫过去，五百多条；',
      '- 顺序读 10 条不该扫掉几十条；',
      '- 空日志、超出末尾的 offset 都不会炸。',
      '',
      '## 间隔怎么选',
      '',
      '这是一个纯粹的空间换时间：间隔 N 意味着索引大小是日志的 1/N，',
      '而每次定位平均多扫 N/2 条。',
      '',
      'Kafka 的默认值是 `index.interval.bytes = 4096`，也就是「每 4KB 记一个锚点」——',
      '注意它按**字节**而不是按条数，因为索引的目的是限制「扫过的字节数」，',
      '而不是「扫过的条数」。这一关为了好数，用的是条数。',
      '',
      '## 最容易写错的地方',
      '',
      '`locate` 返回「最接近的」锚点，而不是「不超过的最近一个」。',
      '',
      '返回一个 offset 比目标**大**的锚点，从它开始往后扫，',
      '目标记录就在起点前面 —— 于是读出来的是一段完全正确、但少了开头几条的数据。',
      '消费者不会报错，只会静静地漏掉几条消息。',
    ].join('\n'),
    [
      'The `read` from stage 1 has a problem: it skips whole segments by base offset, and once inside the',
      'target segment it can only walk from the beginning.',
      '',
      'That cost is the size of a segment. Reading the middle record of a segment holding a thousand messages',
      'means reading five hundred first — and "a consumer resumes from where it left off" is the single most',
      'frequent operation in a message system.',
      '',
      'The answer is an index over the log. But **not one entry per record**: that index is as large as the',
      'log, does not fit in memory, and doubles the maintenance cost. Record an anchor every N records, jump',
      'to the nearest anchor, then scan at most N — trading "scan N more" for "store N times less". That is a',
      '**sparse index.**',
      '',
      '## What to build',
      '',
      'Two things in `src/offsetIndex.ts`:',
      '',
      '**`createOffsetIndex(options)`** — the index itself:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `observe(result)` | Called on every append; it decides whether to store an anchor |',
      '| `locate(offset)` | The nearest anchor **not past** the offset |',
      '| `size()` | How many anchors exist |',
      '',
      '**`createIndexedLog(storage, options)`** — the indexed log: the same interface as the `MessageLog` of',
      'stage 1 plus `indexSize()` and `locate()`. It should **reuse** `createLog` rather than reimplementing',
      'appends.',
      '',
      '## What counts as passing',
      '',
      '- The index is sparse: 6000 records at interval 16 gives roughly 400 anchors, not 6000;',
      '- The position an anchor points at really holds that record;',
      '- Reads return exactly what stage 1 returned, across segment boundaries included;',
      '- **Locating record 5500 scans at most 16** (the `counters.recordsScanned ≤ 16` gate) — without an',
      '  index that record costs a walk from the head of its segment, over five hundred reads;',
      '- Reading ten records in sequence must not cost dozens of reads;',
      '- An empty log and an offset past the end do not blow up.',
      '',
      '## Choosing the interval',
      '',
      'It is a pure space-time trade: interval N means the index is 1/N the size of the log, and every lookup',
      'scans N/2 extra records on average.',
      '',
      "Kafka's default is `index.interval.bytes = 4096` — an anchor every 4KB, counted in **bytes** rather than",
      'records, because the point of the index is bounding the bytes scanned rather than the records scanned.',
      'This stage counts records because they are easier to count.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Returning the *closest* anchor instead of the closest one **not past** the target.',
      '',
      'An anchor whose offset is **greater** than the target puts the record you want behind your starting',
      'point, so the data you return is perfectly valid and missing its first few entries. The consumer does',
      'not error; it silently skips messages.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**追加** —— 只有整数倍才留锚点',
      '',
      '```mermaid',
      'flowchart TD',
      '  AP["append(key, value)"] --> BASE["log.append(...)<br/>复用第 1 关"]',
      '  BASE --> OBS["index.observe(结果)"]',
      '  OBS --> MOD{"offset 是间隔的整数倍？"}',
      '  MOD -- 不是 --> SKIP["不记，索引因此才是稀疏的"]',
      '  MOD -- 是 --> ANCHOR["记一个锚点<br/>offset / 段 id / 段内下标"]',
      '```',
      '',
      '**读取** —— 先跳到锚点，再往后扫',
      '',
      '```mermaid',
      'flowchart TD',
      '  RD["read(offset, max)"] --> LOC["index.locate(offset)"]',
      '  LOC --> BS["在锚点数组上二分<br/>取最后一个不超过 offset 的"]',
      '  BS --> START{"找到锚点了吗？"}',
      '  START -- 没有 --> HEAD["从第一个段的开头扫"]',
      '  START -- 找到 --> JUMP["跳到锚点所在的段与下标"]',
      '  HEAD --> SCAN["逐条 readAt<br/>offset 小的跳过"]',
      '  JUMP --> SCAN',
      '  SCAN --> CROSS{"这个段读完了？"}',
      '  CROSS -- 是 --> NEXTSEG["接着读下一个段"]',
      '  NEXTSEG --> SCAN',
      '  CROSS -- 否 --> ENOUGH{"收够 max 条？"}',
      '  ENOUGH -- 是 --> DONE["返回"]',
      '  ENOUGH -- 否 --> SCAN',
      '```',
      '',
      '要点：锚点记的是「段 id + 段内下标」，不是「全局第几条」。',
      '前者能直接 `readAt`，后者还要再算一次「这是第几个段的第几条」——',
      '而段会因为保留策略被删掉，那个换算迟早会算错。',
    ].join('\n'),
    [
      '**Appending** — only multiples leave an anchor',
      '',
      '```mermaid',
      'flowchart TD',
      '  AP["append(key, value)"] --> BASE["log.append(...)<br/>reuse stage 1"]',
      '  BASE --> OBS["index.observe(result)"]',
      '  OBS --> MOD{"offset a multiple of the interval?"}',
      '  MOD -- no --> SKIP["store nothing — this is what sparse means"]',
      '  MOD -- yes --> ANCHOR["store an anchor<br/>offset / segment id / slot"]',
      '```',
      '',
      '**Reading** — jump to the anchor, then scan forward',
      '',
      '```mermaid',
      'flowchart TD',
      '  RD["read(offset, max)"] --> LOC["index.locate(offset)"]',
      '  LOC --> BS["binary search the anchors<br/>last one not past the offset"]',
      '  BS --> START{"anchor found?"}',
      '  START -- no --> HEAD["start at the head of the first segment"]',
      '  START -- yes --> JUMP["jump to its segment and slot"]',
      '  HEAD --> SCAN["readAt one by one<br/>skip anything below offset"]',
      '  JUMP --> SCAN',
      '  SCAN --> CROSS{"segment exhausted?"}',
      '  CROSS -- yes --> NEXTSEG["continue into the next segment"]',
      '  NEXTSEG --> SCAN',
      '  CROSS -- no --> ENOUGH{"collected max?"}',
      '  ENOUGH -- yes --> DONE["return"]',
      '  ENOUGH -- no --> SCAN',
      '```',
      '',
      'The point: an anchor stores "segment id plus slot", not "the nth record overall". The first can be fed',
      'straight to `readAt`; the second needs a conversion into segment and slot — and segments disappear under',
      'retention, so that conversion eventually gets it wrong.',
    ].join('\n')
  ),
  checklist: [
    t('每隔固定条数才记一个锚点', 'An anchor only every N records'),
    t('locate 返回不超过 offset 的最近锚点', 'locate returns the nearest anchor not past the offset'),
    t('锚点记段 id 与段内下标', 'An anchor stores segment id and slot'),
    t('复用第 1 关的 append 逻辑', 'The append logic of stage 1 is reused'),
    t('跨段读取正常', 'Reads cross segment boundaries correctly'),
  ],
  pitfalls: [
    t(
      '`locate` 返回「最接近」的锚点。比目标大的锚点会让扫描从目标后面开始，前面那几条永远读不到 —— 返回的数据看起来完全正常，只是少了开头几条。消费者不会报错，它只会漏消息。',
      'Making `locate` return the *nearest* anchor. An anchor past the target starts the scan beyond it and the records in between are never read — the returned data looks entirely normal and is missing its first few entries. The consumer does not error, it just loses messages.'
    ),
    t(
      '每条记录都记一个锚点。定位确实快了，但索引和日志一样大：内存装不下，重启时重建索引的时间也和日志长度成正比。稀疏不是折中，是这个结构能成立的前提。',
      'Storing an anchor per record. Lookups do get faster, and the index is now the size of the log: it no longer fits in memory, and rebuilding it at startup takes time proportional to the whole log. Sparseness is not a compromise, it is what makes the structure viable.'
    ),
    t(
      '锚点里存「全局第几条」而不是「段 id + 下标」。保留策略删掉几个段之后，这个换算就错位了，而错位的结果不是报错，是读到别的消息。',
      'Storing "the nth record overall" in an anchor instead of segment id plus slot. After retention drops a few segments the conversion is off, and being off does not raise an error — it returns the wrong messages.'
    ),
    t(
      '把第 1 关的追加逻辑复制一份到这一关，而不是包一层。段滚动的规则于是有了两份实现，改一处就漏一处；而这一关真正新增的东西只有「记锚点」和「从哪儿开始扫」。',
      'Copying the append logic from stage 1 instead of wrapping it. Segment rolling now has two implementations that drift apart on the first change, while all this stage genuinely adds is "record an anchor" and "where to start scanning".'
    ),
  ],
  hints: [
    t(
      '锚点数组天然是按 offset 递增的（因为 append 是递增的），所以 locate 可以二分。线性扫也能过用例，但它让「索引」变成了另一次全表扫描。',
      'The anchor array is naturally sorted by offset, since appends are, so `locate` can binary search. A linear walk also passes the specs, and turns the index into a second full scan.'
    ),
    t(
      '扫描函数需要「从某个段的某个下标开始」这个能力，而第 1 关的 read 只能「从段头开始」。把它写成一个私有函数，两种入口（有锚点 / 没锚点）都走它。',
      'The scanner needs to start at a given slot of a given segment, while stage 1 could only start at a segment head. Write it as one private function and let both entry points — with and without an anchor — go through it.'
    ),
  ],
  extension: t(
    [
      'Kafka 每个段配两个索引文件：`.index` 是 offset → 物理位置，',
      '`.timeindex` 是时间戳 → offset。后者让「从昨天下午三点开始重放」成为可能，',
      '而它的实现和这一关一模一样：稀疏、有序、二分。',
      '',
      '这两个文件都是 mmap 的，而且**可以随时丢掉重建**——',
      'Kafka 启动时如果发现索引损坏，会扫一遍段文件重新生成。',
      '这是日志结构的一个额外好处：**索引是派生数据**，',
      '它错了不影响正确性，只影响速度。',
      '',
      '再往外一层是 LSM 树（RocksDB、LevelDB）：同样是「顺序写 + 稀疏索引」，',
      '只是它还多做了一件这一关第 9 关才会碰的事 —— 把多个段合并压缩成新段。',
    ].join('\n'),
    [
      'Kafka keeps two index files per segment: `.index` maps offset to physical position, `.timeindex` maps',
      'timestamp to offset. The second is what makes "replay from 3pm yesterday" possible, and it is built',
      'exactly like this stage: sparse, sorted, binary searched.',
      '',
      'Both files are mmapped and **can be thrown away and rebuilt at any time** — on startup Kafka rescans',
      'the segment files if it finds a corrupt index. That is an extra benefit of a log structure: **the index',
      'is derived data**, so a wrong index costs speed, not correctness.',
      '',
      'One layer further out sits the LSM tree (RocksDB, LevelDB): the same "sequential writes plus a sparse',
      'index", with one addition this project does not reach until stage 9 — merging several segments into new',
      'ones.',
    ].join('\n')
  ),
  focus: ['latency', 'correctness', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/offsetIndex.ts',
      code`
        import { createLog } from './log';
        import type { AppendResult, LogOptions, MessageLog } from './log';
        import type { StorageDevice } from './support/storage';

        /** 索引里的一个锚点：某条记录在哪个段的第几个位置 */
        export interface IndexAnchor {
          offset: number;
          segmentId: number;
          index: number;
        }

        export interface OffsetIndex {
          observe(result: AppendResult): void;
          /** 不超过 offset 的最近一个锚点；一个都没有时返回 null */
          locate(offset: number): IndexAnchor | null;
          size(): number;
        }

        export interface IndexOptions {
          /** 每隔多少条记一个锚点 */
          indexInterval: number;
        }

        export interface IndexedLogOptions extends LogOptions, IndexOptions {}

        export interface IndexedLog extends MessageLog {
          indexSize(): number;
          locate(offset: number): IndexAnchor | null;
        }

        export function createOffsetIndex(options: IndexOptions): OffsetIndex {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }

        export function createIndexedLog(storage: StorageDevice, options: IndexedLogOptions): IndexedLog {
          // TODO: 在这里实现，复用 createLog
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
        import { createIndexedLog, createOffsetIndex } from '../src/offsetIndex';
        import { createStorage } from '../src/support/storage';
        import { getCounters } from '@lab/metrics';

        /** 24 字节一条，一个段正好装 1000 条 */
        const SEGMENT_BYTES = 24000;
        const INTERVAL = 16;
        const TOTAL = 6000;

        function keyOf(index: number): string {
          return 'k' + String(index % 1000).padStart(3, '0');
        }

        function valueOf(index: number): string {
          return 'v' + String(index).padStart(11, '0');
        }

        function makeLog() {
          const storage = createStorage();
          const log = createIndexedLog(storage, {
            segmentBytes: SEGMENT_BYTES,
            indexInterval: INTERVAL,
          });
          return { storage, log };
        }

        function fill(log: any, count: number): void {
          for (let index = 0; index < count; index += 1) {
            log.append(keyOf(index), valueOf(index));
          }
        }

        function scannedBy(action: () => void): number {
          const before = getCounters()['recordsScanned'] || 0;
          action();
          return (getCounters()['recordsScanned'] || 0) - before;
        }

        describe('阶段2 · 稀疏索引', () => {
          it('索引是稀疏的，不是每条都记', () => {
            const context = makeLog();
            fill(context.log, TOTAL);

            const anchors = context.log.indexSize();
            expect(anchors).toBeLessThanOrEqual(TOTAL / INTERVAL + 2);
            expect(anchors).toBeGreaterThanOrEqual(TOTAL / INTERVAL - 2);
          });

          it('locate 返回不超过 offset 的最近一个锚点', () => {
            const context = makeLog();
            fill(context.log, 100);

            const anchor = context.log.locate(37);
            expect(anchor).toBeDefined();
            expect(anchor.offset).toBeLessThanOrEqual(37);
            expect(anchor.offset).toBeGreaterThan(37 - INTERVAL);
          });

          it('锚点指向的位置确实是那条记录', () => {
            const context = makeLog();
            fill(context.log, 100);

            const anchor = context.log.locate(80);
            const record = context.storage.readAt(anchor.segmentId, anchor.index);
            expect(record.offset).toBe(anchor.offset);
          });

          it('offset 正好落在锚点上时直接命中', () => {
            const context = makeLog();
            fill(context.log, 100);

            expect(context.log.locate(INTERVAL * 3).offset).toBe(INTERVAL * 3);
          });

          it('读到的内容和不带索引时完全一致', () => {
            const context = makeLog();
            fill(context.log, 100);

            const records = context.log.read(45, 3);
            expect(records.map((record: any) => record.offset)).toEqual([45, 46, 47]);
            expect(records[0].value).toBe(valueOf(45));
          });

          it('定位第 5500 条只扫十几条 [gate:locate]', () => {
            const context = makeLog();
            fill(context.log, TOTAL);

            const records = context.log.read(5500, 1);
            expect(records).toHaveLength(1);
            expect(records[0].offset).toBe(5500);
          });

          it('顺序读 10 条不会扫掉几十条', () => {
            const context = makeLog();
            fill(context.log, TOTAL);

            let records: any[] = [];
            const scanned = scannedBy(() => {
              records = context.log.read(2345, 10);
            });

            expect(records).toHaveLength(10);
            expect(records[0].offset).toBe(2345);
            expect(scanned).toBeLessThanOrEqual(INTERVAL + 16);
          });

          it('跨段读取正常', () => {
            const context = makeLog();
            fill(context.log, 2500);

            // 995 到 1004 横跨第一个段的段尾和第二个段的段头
            const records = context.log.read(995, 10);
            expect(records.map((record: any) => record.offset)).toEqual([
              995, 996, 997, 998, 999, 1000, 1001, 1002, 1003, 1004,
            ]);
          });

          it('超出末尾的 offset 返回空数组', () => {
            const context = makeLog();
            fill(context.log, 100);

            expect(context.log.read(100, 5)).toEqual([]);
            expect(context.log.read(99999, 5)).toEqual([]);
          });

          it('空日志上 locate 返回 null，read 返回空', () => {
            const context = makeLog();

            expect(context.log.locate(0)).toBeNull();
            expect(context.log.read(0, 10)).toEqual([]);
          });

          it('索引本身可以单独用', () => {
            const index = createOffsetIndex({ indexInterval: 4 });

            index.observe({ offset: 0, segmentId: 0, index: 0 });
            index.observe({ offset: 1, segmentId: 0, index: 1 });
            index.observe({ offset: 4, segmentId: 0, index: 4 });

            expect(index.size()).toBe(2);
            expect(index.locate(3).offset).toBe(0);
            expect(index.locate(5).offset).toBe(4);
          });

          it('追加与段滚动的行为和第 1 关一致', () => {
            const context = makeLog();
            fill(context.log, 2500);

            expect(context.log.endOffset()).toBe(2500);
            expect(context.log.segments()).toHaveLength(3);
            for (const segment of context.log.segments()) {
              expect(segment.bytes).toBeLessThanOrEqual(SEGMENT_BYTES);
            }
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.recordsScanned',
      op: 'lte',
      value: 16,
      zh: '定位第 5500 条最多扫 16 条记录',
      en: 'Locating record 5500 scans at most sixteen records',
      dimension: 'latency',
      scope: 'gate:locate',
    }),
  ],
  referenceFiles: [
    file(
      'src/offsetIndex.ts',
      code`
        import { createLog } from './log';
        import type { AppendResult, LogOptions, MessageLog } from './log';
        import type { StorageDevice, StoredRecord } from './support/storage';

        export interface IndexAnchor {
          offset: number;
          segmentId: number;
          index: number;
        }

        export interface OffsetIndex {
          observe(result: AppendResult): void;
          locate(offset: number): IndexAnchor | null;
          size(): number;
        }

        export interface IndexOptions {
          indexInterval: number;
        }

        export interface IndexedLogOptions extends LogOptions, IndexOptions {}

        export interface IndexedLog extends MessageLog {
          indexSize(): number;
          locate(offset: number): IndexAnchor | null;
        }

        export function createOffsetIndex(options: IndexOptions): OffsetIndex {
          /** 天然按 offset 递增，因为 append 就是递增的 */
          const anchors: IndexAnchor[] = [];
          const interval = Math.max(1, options.indexInterval);

          return {
            observe(result: AppendResult): void {
              if (result.offset % interval !== 0) return;
              anchors.push({ offset: result.offset, segmentId: result.segmentId, index: result.index });
            },

            locate(offset: number): IndexAnchor | null {
              // 二分找「最后一个不超过 offset 的」，而不是「最接近的」
              let low = 0;
              let high = anchors.length - 1;
              let found: IndexAnchor | null = null;

              while (low <= high) {
                const middle = Math.floor((low + high) / 2);
                if (anchors[middle].offset <= offset) {
                  found = anchors[middle];
                  low = middle + 1;
                } else {
                  high = middle - 1;
                }
              }

              return found;
            },

            size(): number {
              return anchors.length;
            },
          };
        }

        export function createIndexedLog(storage: StorageDevice, options: IndexedLogOptions): IndexedLog {
          // 段滚动那套逻辑只有一份，在第 1 关
          const log = createLog(storage, { segmentBytes: options.segmentBytes });
          const index = createOffsetIndex({ indexInterval: options.indexInterval });

          /** 从某个段的某个下标开始往后扫，跨段继续 */
          function scan(anchor: IndexAnchor | null, offset: number, max: number): StoredRecord[] {
            const segments = storage.segments();
            const found: StoredRecord[] = [];

            let start = 0;
            if (anchor) {
              const position = segments.findIndex((segment) => segment.id === anchor.segmentId);
              if (position >= 0) start = position;
            }

            for (let position = start; position < segments.length; position += 1) {
              const segment = segments[position];
              const from = position === start && anchor ? anchor.index : 0;

              for (let slot = from; slot < segment.count; slot += 1) {
                const record = storage.readAt(segment.id, slot);
                if (!record) break;
                if (record.offset < offset) continue;
                found.push(record);
                if (found.length >= max) return found;
              }
            }

            return found;
          }

          return {
            append(key: string, value: string): AppendResult {
              const result = log.append(key, value);
              index.observe(result);
              return result;
            },

            read(offset: number, max: number): StoredRecord[] {
              if (max <= 0) return [];
              return scan(index.locate(offset), offset, max);
            },

            endOffset(): number {
              return log.endOffset();
            },

            segments() {
              return log.segments();
            },

            async flush(): Promise<void> {
              await log.flush();
            },

            indexSize(): number {
              return index.size();
            },

            locate(offset: number): IndexAnchor | null {
              return index.locate(offset);
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
      '**索引是个独立的对象，不是日志里的一个数组。** 它自己决定「记不记」，',
      '日志只负责把每次追加的结果递给它。这条边界让「换一种索引策略」',
      '（按字节、按时间戳）变成换一个实现，而不是改日志。',
      '',
      '**`locate` 用二分找「最后一个不超过」。** 循环里那句 `found = anchors[middle]`',
      '写在 `<=` 分支里，是这一关唯一容易写反的地方：只要它跑到了 `>` 分支上，',
      '扫描起点就跑到了目标后面，读出来的数据会静静地少几条。',
      '',
      '**`scan` 同时服务两种入口。** 有锚点就从锚点开始，没锚点就从头开始，',
      '两条路走同一段代码。写成两个函数的话，「跨段继续读」这个逻辑就有了两份，',
      '而它恰好是最容易在边界上出错的那一段。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'The index is its own object, not an array inside the log. It decides what to keep; the log merely hands',
      'it each append result. That boundary turns "index by bytes instead of records" or "index by timestamp"',
      'into a different implementation rather than an edit to the log.',
      '',
      '`locate` binary searches for the last anchor not past the target. The `found = anchors[middle]`',
      'assignment living in the `<=` branch is the one line here that is easy to invert — move it to the `>`',
      'branch and the scan starts past the target, quietly returning a few records short.',
      '',
      '`scan` serves both entry points: with an anchor it starts there, without one it starts at the head, and',
      'both take the same code. Split into two functions, "keep reading into the next segment" exists twice —',
      'and that is precisely the part that gets boundaries wrong.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 3 关 · 攒批与 linger                                              */
/* ------------------------------------------------------------------ */

const stage3 = {
  id: 'produce-batching',
  title: t('第 3 关 · 攒批与 linger', 'Stage 3 · Batching and linger'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前两关把消息写进了日志，但每写一条就 `fsync` 一次 —— 而 fsync 要 5ms。',
      '一秒钟最多两百条，这个吞吐配不上「消息系统」四个字。',
      '',
      '问题不在于写得慢，在于**每条都单独付了一次固定成本**。',
      '把一百条攒成一批，一次 fsync 就全落盘了：固定成本被摊薄了一百倍。',
      '',
      '但攒批引入了一个新问题：**最后那几条怎么办？**',
      '如果非要攒够一批才发，流量低的时候一条消息可能永远等不到同伴。',
      '所以要有一个「等不到就先发」的上限，这就是 linger。',
      '',
      '## 要实现什么',
      '',
      '在 `src/producer.ts` 实现 `createProducer(log, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `send(key, value)` | 交一条消息，Promise 在它**落盘之后**才 resolve，返回 offset |',
      '| `flush()` | 立刻把当前缓冲刷出去 |',
      '| `buffered()` | 缓冲里还有几条 |',
      '| `stats()` | 发了多少批、多少条 |',
      '',
      '触发落盘的条件有两个：**攒够 `batchSize` 条**，或者**距这一批的第一条已经',
      '过了 `lingerMs`**。两者谁先到算谁。',
      '',
      '## 怎么算过',
      '',
      '- `send` 的 Promise 在落盘之后才 resolve，返回的 offset 与调用顺序一致；',
      '- 攒满一批**立刻发，不再等 linger**；',
      '- 50 条、每批 10 条：只 fsync 5 次（门槛 `counters.storageFsyncs ≤ 5`），',
      '  总耗时 25ms 上下（门槛 `virtualElapsedMs ≤ 30`）；',
      '- 攒不满时，到了 linger 自动发；',
      '- **linger 从这一批的第一条算起**，不因为后来的消息顺延；',
      '- `flush()` 立刻发，空缓冲时不产生 fsync。',
      '',
      '## 两个门槛为什么一起出现',
      '',
      '只看 fsync 次数，最优解是「永远不发，攒到天荒地老」——',
      '一次 fsync 都不用做，而消息永远出不去。',
      '',
      '只看耗时，最优解是「来一条发一条」—— 单条延迟最低，',
      '而 50 条要付 50 次 5ms。',
      '',
      '两个一起看，答案只有一种：**攒够就发，攒不够就等一小会儿**。',
      '这也是所有消息系统生产端的通用形状 —— Kafka 的 `batch.size` 与 `linger.ms`、',
      'RabbitMQ 的 publisher confirm 批量、数据库的 group commit，全是同一个东西。',
      '',
      '## 最容易写错的地方',
      '',
      '攒满一批之后仍然等 linger 到点才发。',
      '',
      '代码上通常长这样：`send` 里只负责往缓冲里放，发送完全交给定时器。',
      '功能是对的，吞吐也够，但**每一批都白等了一个 linger**——',
      '而 linger 的存在只是为了照顾「攒不满」的情况。',
      '流量越大，这份浪费越离谱：满负载时每一批都在等一个本不需要的超时。',
    ].join('\n'),
    [
      'The first two stages put messages into the log and paid one `fsync` per record — and an fsync costs',
      '5ms. Two hundred messages a second is not a throughput that deserves the name "message system".',
      '',
      'The problem is not that writing is slow, it is that **each record pays the fixed cost alone.** Batch a',
      'hundred and one fsync makes all of them durable: the fixed cost is amortised a hundredfold.',
      '',
      'Batching introduces its own question: **what about the last few?** Insisting on a full batch means a',
      'lone message during a quiet period waits forever for company. So there has to be an upper bound on the',
      'waiting, and that is linger.',
      '',
      '## What to build',
      '',
      'Implement `createProducer(log, options)` in `src/producer.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `send(key, value)` | Hand over a message; the promise resolves **after it is durable**, with its offset |',
      '| `flush()` | Push the current buffer out now |',
      '| `buffered()` | How many records are waiting |',
      '| `stats()` | Batches and records sent |',
      '',
      'Two things trigger a write: **the buffer reaches `batchSize`**, or **`lingerMs` has passed since the',
      'first record of this batch.** Whichever comes first.',
      '',
      '## What counts as passing',
      '',
      '- The promise from `send` resolves after the write, and offsets follow call order;',
      '- A full batch goes **immediately, without waiting for linger**;',
      '- 50 records at 10 per batch cost five fsyncs (the `counters.storageFsyncs ≤ 5` gate) and about 25ms',
      '  (the `virtualElapsedMs ≤ 30` gate);',
      '- A partial batch leaves on its own once linger expires;',
      '- **Linger runs from the first record of the batch** and is not pushed back by later arrivals;',
      '- `flush()` sends immediately, and an empty buffer costs no fsync.',
      '',
      '## Why the two gates come as a pair',
      '',
      'Optimise only the fsync count and the best answer is "never send, accumulate forever": zero fsyncs, and',
      'no message ever leaves.',
      '',
      'Optimise only the elapsed time and the best answer is "send each record as it arrives": the lowest',
      'possible single-message latency, and fifty times 5ms for fifty records.',
      '',
      'Together they leave one shape: **send when full, wait briefly when not.** It is the universal form of a',
      "producer — Kafka's `batch.size` and `linger.ms`, RabbitMQ's batched publisher confirms, a database's",
      'group commit are all the same mechanism.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Waiting out the linger even after the batch is full.',
      '',
      'The code usually looks like this: `send` only appends to the buffer and the timer does all the sending.',
      'It works and the throughput is fine, and **every batch wastes one linger interval** — an interval that',
      'exists solely for the case where the batch does not fill. The busier the system, the more absurd the',
      'waste: at full load every batch waits out a timeout it never needed.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  S["send(key, value)"] --> BUF["放进缓冲<br/>连同它的 resolve"]',
      '  BUF --> FULL{"缓冲满了？"}',
      '  FULL -- 满 --> NOW["立刻刷出去<br/>不等 linger"]',
      '  FULL -- 没满 --> FIRST{"它是这一批的第一条？"}',
      '  FIRST -- 是 --> TIMER["起一个 lingerMs 的定时器"]',
      '  FIRST -- 不是 --> WAIT["什么都不做<br/>定时器不顺延"]',
      '  TIMER --> FIRE["到点触发刷出"]',
      '  FIRE --> NOW',
      '',
      '  NOW --> SWAP["把缓冲整个换成新的空数组<br/>并取消定时器"]',
      '  SWAP --> CHAIN["接到刷盘链的末尾<br/>保证批与批之间有序"]',
      '  CHAIN --> APP["逐条 log.append"]',
      '  APP --> SYNC["log.flush()<br/>一整批只 fsync 一次"]',
      '  SYNC --> RES["逐条 resolve 它们的 offset"]',
      '```',
      '',
      '要点：`SWAP` 那一步是先换缓冲、再做异步落盘。',
      '顺序反过来（先 await 再换），落盘期间新来的消息会被算进这一批，',
      '而它们的 resolve 早已被跳过 —— 那几条消息的 Promise 永远不会完成。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  S["send(key, value)"] --> BUF["push into the buffer<br/>together with its resolve"]',
      '  BUF --> FULL{"buffer full?"}',
      '  FULL -- yes --> NOW["flush now<br/>do not wait for linger"]',
      '  FULL -- no --> FIRST{"is it the first of this batch?"}',
      '  FIRST -- yes --> TIMER["start a lingerMs timer"]',
      '  FIRST -- no --> WAIT["do nothing<br/>the timer is not extended"]',
      '  TIMER --> FIRE["fires, flush"]',
      '  FIRE --> NOW',
      '',
      '  NOW --> SWAP["swap in a fresh empty buffer<br/>and cancel the timer"]',
      '  SWAP --> CHAIN["append to the flush chain<br/>keeping batches ordered"]',
      '  CHAIN --> APP["log.append record by record"]',
      '  APP --> SYNC["log.flush()<br/>one fsync for the whole batch"]',
      '  SYNC --> RES["resolve each with its offset"]',
      '```',
      '',
      'The point: `SWAP` replaces the buffer before the asynchronous write begins. Reverse the order — await',
      'first, swap later — and records arriving during the write join a batch whose resolves have already been',
      'handed out, so their promises never settle.',
    ].join('\n')
  ),
  checklist: [
    t('攒满立刻发，不等 linger', 'A full batch leaves immediately'),
    t('linger 从这一批的第一条算起', 'Linger runs from the first record of the batch'),
    t('一整批只 fsync 一次', 'One fsync per batch, not per record'),
    t('先换缓冲，再做异步落盘', 'Swap the buffer before the async write'),
    t('send 的 Promise 落盘之后才 resolve', 'The send promise resolves only after durability'),
  ],
  pitfalls: [
    t(
      '攒满之后仍然等定时器到点。吞吐没问题，延迟白白多了一个 linger —— 而且流量越大浪费越明显：满载时每一批都在等一个本不需要的超时。',
      'Letting the timer send even when the batch is already full. Throughput is fine and every batch pays an extra linger of latency — worse the busier you get, since at full load every batch waits out a timeout it did not need.'
    ),
    t(
      '每来一条消息就重置定时器。这是防抖（debounce）而不是 linger：只要消息不断，这一批就永远发不出去。linger 是「最多等这么久」，不是「安静这么久之后发」。',
      'Resetting the timer on every message. That is debounce, not linger: while messages keep arriving the batch never leaves. Linger means "wait at most this long", not "send once it goes quiet".'
    ),
    t(
      '先 await 落盘，再清空缓冲。落盘期间新到的消息进了同一个数组，而这一批的 resolve 已经按旧长度分发过了 —— 那几条的 Promise 永远不 resolve，调用方就那么挂着。',
      'Awaiting the write before clearing the buffer. Records arriving during the write land in the same array whose resolves were already handed out by the old length, so those promises never settle and the caller hangs forever.'
    ),
    t(
      '在 send 里直接 await 落盘。这样每条消息都独占一批，攒批完全失效 —— 而代码看起来最简单、最直观，测试也全绿。只有 fsync 计数会告诉你真相。',
      'Awaiting the write inside `send`. Every message becomes its own batch and batching is gone entirely — while the code looks simplest and the tests stay green. Only the fsync count tells you.'
    ),
  ],
  hints: [
    t(
      '缓冲里存的不只是 key 和 value，还有这条消息的 resolve。落盘之后逐条调用它们，这就是「Promise 在落盘之后才完成」的实现方式。',
      'The buffer holds each record\'s resolve alongside its key and value. Calling them after the write is how "the promise settles only when durable" is implemented.'
    ),
    t(
      '批与批之间要有序：维护一个 Promise 链，每次刷出都接到链尾。这样即使两批几乎同时触发，写入顺序也和 send 顺序一致。',
      'Keep batches ordered with a promise chain, appending each flush to its tail. Two batches triggered almost simultaneously then still reach the log in send order.'
    ),
  ],
  extension: t(
    [
      'Kafka 生产端的三个参数正好对应这一关：`batch.size`（攒够多少字节）、',
      '`linger.ms`（默认 0，也就是「不等」）、`max.in.flight.requests.per.connection`',
      '（同时有几批在飞）。第三个是这一关刻意简化掉的部分 —— 参考实现用一条',
      'Promise 链把并发度锁死成 1，代价是吞吐上限，收益是绝对有序。',
      '',
      '把它调大会出现一个著名的坑：重试 + 多批在飞 = **乱序**。',
      '第 1 批失败重试、第 2 批成功先落盘，日志里的顺序就和发送顺序不一样了。',
      'Kafka 的解法是幂等生产者（给每批带上序列号，broker 拒收乱序的批），',
      '这也是「恰好一次」的第一块拼图。',
      '',
      '数据库那边的同一个机制叫 **group commit**：多个事务的 WAL 一起 fsync。',
      'PostgreSQL 的 `commit_delay` 就是它的 linger。',
      '所有需要「昂贵的固定成本 + 可合并的操作」的地方，最后都会长出这个形状。',
    ].join('\n'),
    [
      "Kafka's producer has three parameters matching this stage: `batch.size` (bytes to accumulate),",
      '`linger.ms` (0 by default, meaning do not wait) and `max.in.flight.requests.per.connection` (how many',
      'batches are in flight at once). The third is what this stage deliberately simplifies — the reference',
      'pins concurrency at one with a promise chain, capping throughput in exchange for absolute ordering.',
      '',
      'Raising it exposes a famous trap: retries plus multiple in-flight batches equal **reordering.** Batch 1',
      'fails and retries, batch 2 succeeds and lands first, and the log order no longer matches the send order.',
      "Kafka's answer is the idempotent producer — a sequence number per batch, with the broker refusing",
      'out-of-order ones — which is also the first piece of exactly-once.',
      '',
      'The database world calls the same mechanism **group commit**: several transactions fsync their WAL',
      "together, and PostgreSQL's `commit_delay` is its linger. Anywhere an expensive fixed cost meets a",
      'mergeable operation, this shape eventually grows.',
    ].join('\n')
  ),
  focus: ['latency', 'concurrency', 'correctness'],
  lab: {},
  starterFiles: [
    file(
      'src/producer.ts',
      code`
        import type { MessageLog } from './log';

        export interface ProducerOptions {
          /** 攒够多少条立刻发 */
          batchSize: number;
          /** 距这一批第一条最多等多久 */
          lingerMs: number;
        }

        export interface ProducerStats {
          batches: number;
          records: number;
        }

        export interface Producer {
          /** 交一条消息；Promise 在它落盘之后 resolve，值是它的 offset */
          send(key: string, value: string): Promise<number>;
          /** 立刻把当前缓冲刷出去 */
          flush(): Promise<void>;
          buffered(): number;
          stats(): ProducerStats;
        }

        export function createProducer(log: MessageLog, options: ProducerOptions): Producer {
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
        import { createProducer } from '../src/producer';
        import { createIndexedLog } from '../src/offsetIndex';
        import { createStorage } from '../src/support/storage';
        import { now, sleep } from '@lab/env';
        import { getCounters } from '@lab/metrics';

        const BATCH = 10;
        const LINGER = 100;

        function makeProducer(batchSize = BATCH, lingerMs = LINGER) {
          const storage = createStorage();
          const log = createIndexedLog(storage, { segmentBytes: 24000, indexInterval: 16 });
          return { storage, log, producer: createProducer(log, { batchSize, lingerMs }) };
        }

        function valueOf(index: number): string {
          return 'v' + String(index).padStart(11, '0');
        }

        function sendMany(producer: any, count: number): Promise<number[]> {
          const pending: Promise<number>[] = [];
          for (let index = 0; index < count; index += 1) {
            pending.push(producer.send('k' + String(index % 1000).padStart(3, '0'), valueOf(index)));
          }
          return Promise.all(pending);
        }

        describe('阶段3 · 攒批与 linger', () => {
          it('send 在落盘之后才 resolve，offset 与调用顺序一致', async () => {
            const context = makeProducer();

            const offsets = await sendMany(context.producer, BATCH);

            expect(offsets).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
            expect(context.log.read(0, BATCH)).toHaveLength(BATCH);
          });

          it('50 条只 fsync 5 次，也不白等 linger [gate:batch]', async () => {
            const context = makeProducer();

            const started = now();
            await sendMany(context.producer, BATCH * 5);
            const elapsed = now() - started;

            expect(context.producer.stats().batches).toBe(5);
            expect(context.producer.stats().records).toBe(50);
            // 攒满就发，一次 linger 都不该等
            expect(elapsed).toBeLessThan(LINGER);
          });

          it('攒不满时，到了 linger 自动发', async () => {
            const context = makeProducer();

            const started = now();
            const pending = sendMany(context.producer, 3);
            expect(context.producer.buffered()).toBe(3);

            const offsets = await pending;
            expect(offsets).toEqual([0, 1, 2]);
            expect(now() - started).toBeGreaterThanOrEqual(LINGER);
          });

          it('linger 从这一批的第一条算起，不因为新消息顺延', async () => {
            const context = makeProducer();

            const started = now();
            const first = context.producer.send('k000', valueOf(0));
            await sleep(LINGER / 2);
            const second = context.producer.send('k001', valueOf(1));

            await Promise.all([first, second]);
            // 顺延的话这里会是 150ms 而不是 100ms
            expect(now() - started).toBeLessThan(LINGER * 1.4);
          });

          it('攒满立刻发，剩下的零头才等 linger', async () => {
            const context = makeProducer();

            const started = now();
            const pending = sendMany(context.producer, BATCH + 2);

            // 满的那一批已经走了，缓冲里只剩零头
            expect(context.producer.buffered()).toBe(2);
            await pending;
            expect(context.producer.stats().batches).toBe(2);
            expect(now() - started).toBeGreaterThanOrEqual(LINGER);
          });

          it('flush 立刻把缓冲刷出去', async () => {
            const context = makeProducer();

            const started = now();
            const pending = sendMany(context.producer, 3);
            await context.producer.flush();
            await pending;

            expect(now() - started).toBeLessThan(LINGER);
            expect(context.producer.buffered()).toBe(0);
          });

          it('空缓冲上 flush 不产生 fsync', async () => {
            const context = makeProducer();

            const before = getCounters()['storageFsyncs'] || 0;
            await context.producer.flush();

            expect(getCounters()['storageFsyncs'] || 0).toBe(before);
          });

          it('落盘之前日志里读不到', async () => {
            const context = makeProducer();

            const pending = sendMany(context.producer, 3);
            expect(context.log.read(0, 10)).toEqual([]);

            await pending;
            expect(context.log.read(0, 10)).toHaveLength(3);
          });

          it('一整批只 fsync 一次', async () => {
            const context = makeProducer();

            const before = getCounters()['storageFsyncs'] || 0;
            await sendMany(context.producer, BATCH);

            expect((getCounters()['storageFsyncs'] || 0) - before).toBe(1);
          });

          it('批与批之间保持顺序', async () => {
            const context = makeProducer(2, LINGER);

            await sendMany(context.producer, 6);

            const records = context.log.read(0, 10);
            expect(records.map((record: any) => record.value)).toEqual([0, 1, 2, 3, 4, 5].map(valueOf));
          });

          it('内容原样落进日志', async () => {
            const context = makeProducer();

            await context.producer.send('order-1', 'created');
            await context.producer.flush();

            const record = context.log.read(0, 1)[0];
            expect(record.key).toBe('order-1');
            expect(record.value).toBe('created');
          });

          it('批量大小为 1 时退化成逐条发送', async () => {
            const context = makeProducer(1, LINGER);

            const started = now();
            await sendMany(context.producer, 3);

            expect(context.producer.stats().batches).toBe(3);
            expect(now() - started).toBeLessThan(LINGER);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.storageFsyncs',
      op: 'lte',
      value: 5,
      zh: '50 条消息最多 5 次 fsync',
      en: 'Fifty messages cost at most five fsyncs',
      dimension: 'latency',
      scope: 'gate:batch',
    }),
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 30,
      zh: '50 条消息 30ms 内落盘',
      en: 'Fifty messages are durable within 30ms',
      unit: 'ms',
      dimension: 'latency',
      scope: 'gate:batch',
    }),
  ],
  referenceFiles: [
    file(
      'src/producer.ts',
      code`
        import type { MessageLog } from './log';

        export interface ProducerOptions {
          batchSize: number;
          lingerMs: number;
        }

        export interface ProducerStats {
          batches: number;
          records: number;
        }

        export interface Producer {
          send(key: string, value: string): Promise<number>;
          flush(): Promise<void>;
          buffered(): number;
          stats(): ProducerStats;
        }

        /** 缓冲里的一条：内容加上它自己的 resolve */
        interface Pending {
          key: string;
          value: string;
          settle(offset: number): void;
        }

        export function createProducer(log: MessageLog, options: ProducerOptions): Producer {
          let buffer: Pending[] = [];
          let timer: number | null = null;
          /** 批与批之间靠这条链保持有序 */
          let chain: Promise<void> = Promise.resolve();
          const counters: ProducerStats = { batches: 0, records: 0 };

          function cancelTimer(): void {
            if (timer === null) return;
            clearTimeout(timer);
            timer = null;
          }

          function flushNow(): Promise<void> {
            cancelTimer();
            // 先把缓冲整个换掉，再去做异步落盘：
            // 反过来的话，落盘期间新来的消息会掉进一个已经分发过 resolve 的批次里
            const batch = buffer;
            buffer = [];
            if (batch.length === 0) return chain;

            counters.batches += 1;
            counters.records += batch.length;

            chain = chain.then(async () => {
              const offsets = batch.map((entry) => log.append(entry.key, entry.value).offset);
              // 一整批只 fsync 一次，固定成本被摊薄
              await log.flush();
              batch.forEach((entry, index) => entry.settle(offsets[index]));
            });
            return chain;
          }

          return {
            send(key: string, value: string): Promise<number> {
              return new Promise<number>((resolve) => {
                buffer.push({ key, value, settle: resolve });

                if (buffer.length >= options.batchSize) {
                  // 攒满了就走，linger 是给攒不满的情况准备的
                  void flushNow();
                  return;
                }
                // 只有这一批的第一条会起定时器，后来的不顺延
                if (buffer.length === 1) {
                  timer = setTimeout(() => {
                    void flushNow();
                  }, options.lingerMs) as unknown as number;
                }
              });
            },

            flush(): Promise<void> {
              return flushNow();
            },

            buffered(): number {
              return buffer.length;
            },

            stats(): ProducerStats {
              return { batches: counters.batches, records: counters.records };
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
      '**先换缓冲，再落盘。** `const batch = buffer; buffer = [];` 这两行的位置',
      '决定了这份实现有没有一个「Promise 永不 resolve」的 bug。',
      '异步边界前后各有一份状态时，第一件该做的事就是把它们切干净。',
      '',
      '**定时器只在缓冲从空变成一条时起。** 这一句区分了 linger 和防抖：',
      '前者是「最多等这么久」，后者是「安静下来才发」。写成后者的话，',
      '持续有流量时这一批永远发不出去 —— 而那正是最需要它发出去的时候。',
      '',
      '**批与批之间串成一条 Promise 链。** 它把并发落盘的可能性锁死了：',
      '任何时刻只有一批在写，于是日志里的顺序永远等于 send 的顺序。',
      '这是一个明确的取舍 —— 放开并发能提高吞吐，代价是要自己处理',
      '「第一批重试、第二批先成功」带来的乱序。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'Swap the buffer, then write. The position of `const batch = buffer; buffer = [];` decides whether this',
      'implementation contains a promise that never settles. When state exists on both sides of an async',
      'boundary, the first thing to do is cut it cleanly.',
      '',
      'The timer starts only when the buffer goes from empty to one. That single condition separates linger',
      'from debounce: the first means "wait at most", the second means "send once it goes quiet". Written as',
      'the second, a batch under continuous traffic never leaves — exactly when it most needs to.',
      '',
      'Batches are serialised through a promise chain, which forecloses concurrent writes: one batch is in',
      'flight at a time, so log order always equals send order. It is an explicit trade — allowing concurrency',
      'raises throughput and hands you the reordering that follows when batch one retries and batch two lands',
      'first.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 4 关 · 至少一次投递                                               */
/* ------------------------------------------------------------------ */

const stage4 = {
  id: 'ack-visibility',
  title: t('第 4 关 · 至少一次投递', 'Stage 4 · At-least-once delivery'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前三关把消息安全地写了下来。现在要把它们发出去，而这里有一个',
      '绕不过去的物理事实：**你无法知道消费者到底有没有处理完。**',
      '',
      '消息发出去了，然后消费者没了消息 —— 是它崩在处理之前，',
      '崩在处理之后、回复之前，还是回复在路上丢了？三种情况在服务端看起来一模一样。',
      '',
      '既然分不清，就只能选一边站：',
      '**发出去先当没送到**（可能重复投递），还是**发出去就当送到了**（可能丢）。',
      '几乎所有消息系统都选前者，因为重复可以靠幂等消化，丢失不能。',
      '这就是「至少一次」。',
      '',
      '实现它需要三样东西：投出去的消息进 **in-flight 表**、',
      '每次投递带一个**可见性超时**、消费者处理完回一个 **ack**。',
      '',
      '## 要实现什么',
      '',
      '在 `src/delivery.ts` 实现 `createDeliveryQueue(log, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `poll(max)` | 取最多 max 条可投的消息，每条带一个 receipt |',
      '| `ack(receipt)` | 确认处理完，这条不再投递；receipt 无效时返回 false |',
      '| `inflight()` | 当前有多少条投出去了还没确认 |',
      '| `pendingOffsets()` | 这些在飞消息的 offset |',
      '',
      '一条消息被 `poll` 出去之后，在 `visibilityMs` 之内**对其他 poll 不可见**；',
      '超时还没 ack 就重新可投，并且**换一个新的 receipt**。',
      '',
      '## 怎么算过',
      '',
      '- 在飞的消息不会被重复投出去（门槛 `counters.deliveredWhileInflight = 0`）；',
      '- 消费者不 ack（等同于宕机），超时之后消息回来，**一条都不少**',
      '  （门槛 `counters.lostMessages = 0`）；',
      '- ack 过的消息不再出现；',
      '- 过期的 receipt 和不存在的 receipt 都 ack 不掉东西；',
      '- 重投的优先级高于新消息 —— 否则积压时老消息会被一直往后挤；',
      '- 全部处理完之后 `poll` 返回空数组。',
      '',
      '## 可见性超时该设多久',
      '',
      '这是这一关唯一需要权衡的参数，而它没有正确答案，只有取舍：',
      '',
      '| 设置 | 后果 |',
      '| --- | --- |',
      '| 短于处理时间 | 消费者还在处理，消息已经被投给别人了 —— 稳定地重复 |',
      '| 远长于处理时间 | 消费者真崩了，这条消息要等很久才回来 —— 延迟尖峰 |',
      '',
      '真实系统的做法是让消费者能**续期**（SQS 的 ChangeMessageVisibility）：',
      '处理时间不确定时，边处理边续。这一关不做续期，但值得知道那个洞在哪儿。',
      '',
      '## 最容易写错的地方',
      '',
      '把 `poll` 写成「先发新的，再看有没有超时的」。',
      '',
      '积压的时候，新消息源源不断，超时回来的老消息永远排在后面 ——',
      '一条处理失败过一次的消息，可能在队列非空期间永远得不到第二次机会。',
      '重投必须优先。',
    ].join('\n'),
    [
      'The first three stages stored messages safely. Now they have to go out, and here an unavoidable',
      'physical fact appears: **you cannot know whether the consumer finished.**',
      '',
      'A message goes out and the consumer goes quiet — did it die before processing, after processing but',
      'before replying, or did the reply get lost on the way? All three look identical from the server.',
      '',
      'Since you cannot tell them apart, you pick a side: **assume it did not arrive** (and risk duplicates)',
      'or **assume it did** (and risk losses). Nearly every message system picks the first, because duplicates',
      'can be absorbed by idempotency and losses cannot. That is at-least-once.',
      '',
      'It takes three pieces: delivered messages go into an **in-flight table**, every delivery carries a',
      '**visibility timeout**, and the consumer sends an **ack** when it is done.',
      '',
      '## What to build',
      '',
      'Implement `createDeliveryQueue(log, options)` in `src/delivery.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `poll(max)` | Take up to max deliverable messages, each with a receipt |',
      '| `ack(receipt)` | Confirm completion; returns false for an invalid receipt |',
      '| `inflight()` | How many are out and unacknowledged |',
      '| `pendingOffsets()` | The offsets of those in-flight messages |',
      '',
      'Once polled, a message is **invisible to other polls** for `visibilityMs`; unacknowledged after that,',
      'it becomes deliverable again **with a new receipt.**',
      '',
      '## What counts as passing',
      '',
      '- An in-flight message is never handed out twice (the `counters.deliveredWhileInflight = 0` gate);',
      '- A consumer that never acks (a crash) gets its messages back after the timeout, **all of them**',
      '  (the `counters.lostMessages = 0` gate);',
      '- Acknowledged messages never reappear;',
      '- Neither an expired receipt nor an unknown one can acknowledge anything;',
      '- Redeliveries outrank new messages — otherwise a backlog buries the old ones forever;',
      '- Once everything is done, `poll` returns an empty array.',
      '',
      '## How long should the visibility timeout be',
      '',
      'It is the one parameter to weigh here, and it has no correct value, only trade-offs:',
      '',
      '| Setting | Consequence |',
      '| --- | --- |',
      '| Shorter than processing | The consumer is still working when the message goes to someone else — steady duplication |',
      '| Far longer than processing | A genuinely dead consumer holds the message hostage — latency spikes |',
      '',
      "Real systems let the consumer **extend** it (SQS's ChangeMessageVisibility) and renew while working when",
      'the processing time is unpredictable. This stage does not implement renewal, but it is worth knowing',
      'where that hole is.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Writing `poll` as "hand out new messages first, then check for expiries".',
      '',
      'Under a backlog new messages keep arriving and the expired old ones queue behind them forever — a',
      'message that failed once may never get its second chance while the queue is non-empty. Redelivery has',
      'to come first.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  P["poll(max)"] --> EXP["先扫 in-flight 表<br/>挑出 deadline 已过的"]',
      '  EXP --> RE{"有超时的吗？"}',
      '  RE -- 有 --> DROP["删掉旧 receipt<br/>旧凭据就此作废"]',
      '  DROP --> HAND["重新发一次<br/>换新 receipt 与新 deadline"]',
      '  RE -- 没有 --> NEW["从 cursor 读新消息"]',
      '  HAND --> ROOM{"还没取够 max？"}',
      '  ROOM -- 是 --> NEW',
      '  ROOM -- 否 --> RET["返回这一批"]',
      '  NEW --> ANY{"日志里还有吗？"}',
      '  ANY -- 有 --> HAND2["发出去并推进 cursor"]',
      '  HAND2 --> ROOM',
      '  ANY -- 没有 --> RET',
      '',
      '  A["ack(receipt)"] --> FIND{"这个 receipt 还在表里？"}',
      '  FIND -- 在 --> DEL["从 in-flight 表删掉<br/>这条消息就此完成"]',
      '  FIND -- 不在 --> NO["返回 false<br/>过期或伪造的凭据"]',
      '```',
      '',
      '要点：重投那条路在图的**上面**。它不是「顺便也处理一下」，',
      '而是 poll 的第一件事 —— 否则积压时它永远排不上队。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  P["poll(max)"] --> EXP["scan the in-flight table<br/>collect expired deadlines"]',
      '  EXP --> RE{"any expired?"}',
      '  RE -- yes --> DROP["delete the old receipt<br/>it is void from now on"]',
      '  DROP --> HAND["hand out again<br/>new receipt, new deadline"]',
      '  RE -- no --> NEW["read new records from the cursor"]',
      '  HAND --> ROOM{"still short of max?"}',
      '  ROOM -- yes --> NEW',
      '  ROOM -- no --> RET["return the batch"]',
      '  NEW --> ANY{"anything left in the log?"}',
      '  ANY -- yes --> HAND2["hand out and advance the cursor"]',
      '  HAND2 --> ROOM',
      '  ANY -- no --> RET',
      '',
      '  A["ack(receipt)"] --> FIND{"receipt still in the table?"}',
      '  FIND -- yes --> DEL["remove it<br/>the message is done"]',
      '  FIND -- no --> NO["return false<br/>expired or forged"]',
      '```',
      '',
      'The point: the redelivery path sits at the **top** of the diagram. It is not something handled along',
      'the way, it is the first thing `poll` does — otherwise a backlog starves it forever.',
    ].join('\n')
  ),
  checklist: [
    t('在飞的消息对其他 poll 不可见', 'In-flight messages are invisible to other polls'),
    t('超时之后换新 receipt 重投', 'After the timeout it comes back with a new receipt'),
    t('旧 receipt 作废', 'The old receipt becomes void'),
    t('重投优先于新消息', 'Redeliveries outrank new messages'),
    t('ack 之后消息彻底消失', 'An acknowledged message is gone for good'),
  ],
  pitfalls: [
    t(
      '先发新消息，再看超时。积压时新消息源源不断，超时回来的老消息永远排在队尾 —— 一条失败过一次的消息可能永远等不到第二次机会，而队列监控上一切正常。',
      'Handing out new messages before checking expiries. Under a backlog the new ones never stop, so a message that failed once queues behind them indefinitely and may never get a second attempt — while the queue metrics look entirely healthy.'
    ),
    t(
      '重投时沿用旧的 receipt。那条消息现在有两个持有者：崩溃前的消费者可能突然活过来 ack 一下，把正在被另一个消费者处理的消息标记成完成。新的一次投递就是新的一次授权，凭据必须换。',
      'Reusing the receipt on redelivery. The message now has two holders, and the consumer everyone assumed was dead can come back and acknowledge a message another consumer is actively processing. A new delivery is a new authorisation, so the receipt has to change.'
    ),
    t(
      '把 ack 实现成「推进 cursor」。至少一次的前提是消息可以乱序完成：3 号先处理完、2 号还在处理，这时候把 cursor 推到 3 就等于把 2 号丢了。cursor 管的是「发出去过没有」，ack 管的是「处理完没有」，两件事。',
      'Implementing ack as "advance the cursor". At-least-once assumes completions arrive out of order: if 3 finishes while 2 is still running, moving the cursor to 3 discards 2. The cursor tracks what has been handed out; the ack tracks what has been completed. Two different things.'
    ),
    t(
      '把可见性超时设得比处理时间还短。消费者还在正常工作，消息已经被投给了第二个人，两个人一起处理同一条 —— 而且这不是偶发，是稳定复现的重复。它看起来像「消费者有 bug」，其实是队列参数配错了。',
      'Setting the visibility timeout shorter than the processing time. The consumer is working normally and the message has already gone to a second one, so two consumers process it together — not occasionally, but every time. It looks like a buggy consumer and is a misconfigured queue.'
    ),
  ],
  hints: [
    t(
      'in-flight 表用 Map<receipt, 条目> 就够了，条目里带上 record 和 deadline。inflight() 就是 map.size，pendingOffsets() 是遍历一遍取 offset。',
      'A Map from receipt to entry is enough, each entry holding the record and its deadline. `inflight()` is the map size and `pendingOffsets()` is one walk over the values.'
    ),
    t(
      'cursor 只记「日志读到哪儿了」，它只会前进，从不因为 ack 而改变。消息完成与否完全由 in-flight 表表达。',
      'The cursor only records how far the log has been read. It moves forward and never reacts to an ack; completion lives entirely in the in-flight table.'
    ),
  ],
  extension: t(
    [
      'SQS 的模型就是这一关：ReceiveMessage 拿到 ReceiptHandle，',
      'VisibilityTimeout 默认 30 秒，DeleteMessage 是 ack。',
      '它甚至把「消费者宕机」和「消费者很慢」用同一个机制处理 ——',
      '因为服务端确实分不清这两件事。',
      '',
      'Kafka 的模型不一样：它不维护 in-flight 表，而是让消费者提交 offset。',
      '代价是同一个分区里必须按顺序完成 —— 第 5 条卡住，第 6 条就不能提交，',
      '否则崩溃恢复时第 5 条会被跳过。这是「顺序保证」换来的：',
      'Kafka 用分区内有序换掉了逐条 ack 的灵活性，SQS 反过来。',
      '',
      '至于「恰好一次」：它在分布式系统里不是不可能，但它需要',
      '**投递和处理结果在同一个事务里提交**。Kafka 的事务、',
      'Flink 的两阶段提交 sink 都是这么做的。如果做不到，',
      '正确的目标是「至少一次 + 幂等消费」，而不是追求恰好一次。',
    ].join('\n'),
    [
      "SQS's model is this stage: ReceiveMessage returns a ReceiptHandle, VisibilityTimeout defaults to thirty",
      'seconds, DeleteMessage is the ack. It deliberately handles "the consumer died" and "the consumer is',
      'slow" with the same mechanism, because the server genuinely cannot tell them apart.',
      '',
      "Kafka's model differs: no in-flight table, and consumers commit offsets instead. The price is in-order",
      'completion within a partition — if record 5 is stuck, 6 cannot be committed, or a crash would skip 5.',
      'That is what ordering costs: Kafka trades per-message acknowledgement for partition order, and SQS',
      'trades the other way.',
      '',
      'As for exactly-once: it is not impossible in a distributed system, but it requires **the delivery and',
      "the result to commit in one transaction** — which is what Kafka's transactions and Flink's two-phase",
      'commit sinks do. Where that is unavailable, the correct target is at-least-once plus idempotent',
      'consumers, not a pursuit of exactly-once.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'concurrency'],
  lab: {},
  starterFiles: [
    file(
      'src/delivery.ts',
      code`
        import type { MessageLog } from './log';
        import type { StoredRecord } from './support/storage';
        import { now } from '@lab/env';

        export interface DeliveryOptions {
          /** 投出去多久没 ack 就重新可投 */
          visibilityMs: number;
        }

        export interface Delivery {
          record: StoredRecord;
          /** 这一次投递的凭据，ack 时要带上 */
          receipt: string;
        }

        export interface DeliveryQueue {
          poll(max: number): Delivery[];
          /** 确认处理完；receipt 无效时返回 false */
          ack(receipt: string): boolean;
          inflight(): number;
          pendingOffsets(): number[];
        }

        export function createDeliveryQueue(log: MessageLog, options: DeliveryOptions): DeliveryQueue {
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
        import { createDeliveryQueue } from '../src/delivery';
        import { createIndexedLog } from '../src/offsetIndex';
        import { createStorage } from '../src/support/storage';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const VISIBILITY = 1000;

        function makeQueue(records: number) {
          const storage = createStorage();
          const log = createIndexedLog(storage, { segmentBytes: 24000, indexInterval: 16 });
          for (let index = 0; index < records; index += 1) {
            log.append('k' + String(index).padStart(3, '0'), 'v' + index);
          }
          return { log, queue: createDeliveryQueue(log, { visibilityMs: VISIBILITY }) };
        }

        function offsetsOf(deliveries: any[]): number[] {
          return deliveries.map((delivery) => delivery.record.offset);
        }

        describe('阶段4 · 至少一次投递', () => {
          it('poll 从头开始取消息', () => {
            const context = makeQueue(5);

            expect(offsetsOf(context.queue.poll(3))).toEqual([0, 1, 2]);
          });

          it('在飞的消息不会被再投一次', () => {
            const context = makeQueue(4);

            const first = context.queue.poll(2);
            const second = context.queue.poll(2);

            for (const delivery of second) {
              if (offsetsOf(first).indexOf(delivery.record.offset) >= 0) {
                count('deliveredWhileInflight');
              }
            }
            expect(offsetsOf(second)).toEqual([2, 3]);
          });

          it('超时之后重新可投，并且换了新 receipt', async () => {
            const context = makeQueue(2);
            const first = context.queue.poll(1)[0];

            await sleep(VISIBILITY);
            const again = context.queue.poll(1)[0];

            expect(again.record.offset).toBe(first.record.offset);
            expect(again.receipt).not.toBe(first.receipt);
          });

          it('超时之前不会重新可投', async () => {
            const context = makeQueue(1);
            const first = context.queue.poll(1)[0];

            await sleep(VISIBILITY - 1);
            const again = context.queue.poll(1);

            for (const delivery of again) {
              if (delivery.record.offset === first.record.offset) count('deliveredWhileInflight');
            }
            expect(again).toEqual([]);
          });

          it('ack 之后不再出现', async () => {
            const context = makeQueue(2);
            const first = context.queue.poll(1)[0];

            expect(context.queue.ack(first.receipt)).toBe(true);
            await sleep(VISIBILITY * 2);

            expect(offsetsOf(context.queue.poll(5))).toEqual([1]);
          });

          it('过期的 receipt ack 不掉东西', async () => {
            const context = makeQueue(1);
            const stale = context.queue.poll(1)[0];

            await sleep(VISIBILITY);
            const fresh = context.queue.poll(1)[0];

            expect(context.queue.ack(stale.receipt)).toBe(false);
            expect(context.queue.inflight()).toBe(1);
            expect(context.queue.ack(fresh.receipt)).toBe(true);
          });

          it('伪造的 receipt ack 不掉东西', () => {
            const context = makeQueue(1);
            context.queue.poll(1);

            expect(context.queue.ack('r-made-up')).toBe(false);
            expect(context.queue.inflight()).toBe(1);
          });

          it('inflight 与 pendingOffsets 反映在飞的消息', () => {
            const context = makeQueue(5);
            const batch = context.queue.poll(3);

            expect(context.queue.inflight()).toBe(3);
            expect(context.queue.pendingOffsets()).toEqual([0, 1, 2]);

            context.queue.ack(batch[1].receipt);
            expect(context.queue.inflight()).toBe(2);
            expect(context.queue.pendingOffsets()).toEqual([0, 2]);
          });

          it('消费者宕机也不会丢消息 [gate:no-loss]', async () => {
            const context = makeQueue(6);
            const seen = new Set<number>();

            // 前两条正常处理
            for (const delivery of context.queue.poll(2)) {
              seen.add(delivery.record.offset);
              context.queue.ack(delivery.receipt);
            }
            // 接着这两条投出去之后消费者就没了
            context.queue.poll(2);

            await sleep(VISIBILITY);

            let batch = context.queue.poll(10);
            while (batch.length > 0) {
              for (const delivery of batch) {
                seen.add(delivery.record.offset);
                context.queue.ack(delivery.receipt);
              }
              batch = context.queue.poll(10);
            }

            for (let offset = 0; offset < 6; offset += 1) {
              if (!seen.has(offset)) count('lostMessages');
            }
            expect(seen.size).toBe(6);
          });

          it('重投优先于新消息', async () => {
            const context = makeQueue(1);
            context.queue.poll(1);
            context.log.append('k100', 'newer');

            await sleep(VISIBILITY);

            // 队列里有一条超时回来的和一条新的，先给老的
            expect(context.queue.poll(1)[0].record.offset).toBe(0);
          });

          it('全部处理完之后 poll 返回空', () => {
            const context = makeQueue(3);

            for (const delivery of context.queue.poll(10)) {
              context.queue.ack(delivery.receipt);
            }

            expect(context.queue.poll(10)).toEqual([]);
            expect(context.queue.inflight()).toBe(0);
          });

          it('后写入的消息也投得出去', () => {
            const context = makeQueue(1);
            for (const delivery of context.queue.poll(10)) context.queue.ack(delivery.receipt);

            context.log.append('k999', 'late');

            expect(offsetsOf(context.queue.poll(10))).toEqual([1]);
          });

          it('max 为 0 时什么都不取', () => {
            const context = makeQueue(3);

            expect(context.queue.poll(0)).toEqual([]);
            expect(context.queue.inflight()).toBe(0);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.lostMessages',
      op: 'eq',
      value: 0,
      zh: '消费者宕机也一条都不丢',
      en: 'Not one message is lost when a consumer dies',
      dimension: 'resilience',
    }),
    gate({
      metric: 'counters.deliveredWhileInflight',
      op: 'eq',
      value: 0,
      zh: '在飞的消息一次都没被重复投出去',
      en: 'No in-flight message is ever handed out twice',
      dimension: 'correctness',
    }),
  ],
  referenceFiles: [
    file(
      'src/delivery.ts',
      code`
        import type { MessageLog } from './log';
        import type { StoredRecord } from './support/storage';
        import { now } from '@lab/env';

        export interface DeliveryOptions {
          visibilityMs: number;
        }

        export interface Delivery {
          record: StoredRecord;
          receipt: string;
        }

        export interface DeliveryQueue {
          poll(max: number): Delivery[];
          ack(receipt: string): boolean;
          inflight(): number;
          pendingOffsets(): number[];
        }

        interface InflightEntry {
          record: StoredRecord;
          receipt: string;
          /** 到这个时刻还没 ack 就重新可投 */
          deadline: number;
        }

        export function createDeliveryQueue(log: MessageLog, options: DeliveryOptions): DeliveryQueue {
          /** 日志读到哪儿了。它只前进，和 ack 无关。 */
          let cursor = 0;
          let nextReceipt = 0;
          const inflight = new Map<string, InflightEntry>();

          function handOut(record: StoredRecord): Delivery {
            const receipt = 'r-' + nextReceipt;
            nextReceipt += 1;
            // 每一次投递都是一次新的授权，所以换新凭据
            inflight.set(receipt, { record, receipt, deadline: now() + options.visibilityMs });
            return { record, receipt };
          }

          function expired(): InflightEntry[] {
            return Array.from(inflight.values()).filter((entry) => entry.deadline <= now());
          }

          return {
            poll(max: number): Delivery[] {
              const batch: Delivery[] = [];
              if (max <= 0) return batch;

              // 超时回来的先发：积压时新消息源源不断，老消息否则永远排不上
              for (const entry of expired()) {
                if (batch.length >= max) return batch;
                inflight.delete(entry.receipt);
                batch.push(handOut(entry.record));
              }

              while (batch.length < max) {
                const records = log.read(cursor, max - batch.length);
                if (records.length === 0) break;
                for (const record of records) {
                  batch.push(handOut(record));
                  cursor = record.offset + 1;
                }
              }

              return batch;
            },

            ack(receipt: string): boolean {
              // 过期的凭据已经不在表里了，它 ack 不掉任何东西
              return inflight.delete(receipt);
            },

            inflight(): number {
              return inflight.size;
            },

            pendingOffsets(): number[] {
              return Array.from(inflight.values())
                .map((entry) => entry.record.offset)
                .sort((left, right) => left - right);
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
      '**cursor 和 in-flight 表是两件事。** cursor 回答「日志读到哪儿了」，',
      '只前进；in-flight 表回答「哪些还没完成」，可增可减。',
      '把两者合并成一个「已确认位置」就退化成了 Kafka 式的顺序提交 ——',
      '那也是一种设计，但它不允许乱序完成，而这一关的前提正是允许。',
      '',
      '**重投在 poll 的最前面。** 它不是「顺便处理」，是第一优先级。',
      '判断它的位置很简单：如果新消息永不枯竭，超时回来的消息还有没有机会？',
      '',
      '**ack 就是 `map.delete`，返回值直接当结果。** 过期凭据、',
      '伪造凭据、重复 ack 三种情况在这里是同一件事 —— 表里没有它。',
      '把它们分开处理需要多存一份「历史凭据」，而那张表只会无限增长。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'The cursor and the in-flight table are separate. The cursor answers "how far has the log been read"',
      'and only moves forward; the table answers "what is unfinished" and moves both ways. Merging them into a',
      'single committed position degenerates into Kafka-style ordered commits — a legitimate design that',
      'forbids out-of-order completion, which is the premise here.',
      '',
      'Redelivery sits at the very top of `poll`. It is the first priority, not an afterthought, and the test',
      'for its position is simple: if new messages never run out, does an expired one ever get a turn?',
      '',
      '`ack` is `map.delete` and its return value is the answer. An expired receipt, a forged one and a double',
      'ack are the same event here — it is not in the table. Distinguishing them needs a second table of',
      'historical receipts, and that table only ever grows.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 5 关 · 重投退避与死信                                             */
/* ------------------------------------------------------------------ */

const stage5 = {
  id: 'redelivery-dlq',
  title: t('第 5 关 · 重投退避与死信', 'Stage 5 · Backoff and dead letters'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关的队列有一个致命的乐观假设：**消息总有一天会被处理成功。**',
      '',
      '现实里有一类消息永远不会成功：字段缺失、格式错误、引用了一个已经被删掉的实体。',
      '它们被称为**毒消息**。在上一关的模型里，一条毒消息会被无限重投 ——',
      '每次超时都回来一次，占着 CPU、占着日志、占着监控告警，直到有人手动干预。',
      '',
      '更糟的是它可能**挡住别人**：如果实现让重投排在队头，',
      '或者消费者被同一条消息反复噎住，整条队列就停在这一条上。',
      '',
      '这一关补两件事：**退避**（失败之后越等越久）和**死信**（试够了就送走）。',
      '',
      '## 要实现什么',
      '',
      '在 `src/redelivery.ts` 实现 `createRetryingQueue(source, options)`。',
      '`source` 就是第 4 关的队列 —— 它在这里退居为「从日志里取货的游标」：',
      '**取出来就立刻 ack**，因为这条消息的生命周期从此由重试层负责。',
      '两层各管一段，才不会出现两个地方同时决定同一条消息什么时候重投。',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `poll(max)` | 取消息，每条带 `attempt`（第几次投递，从 1 开始） |',
      '| `ack(receipt)` | 处理成功 |',
      '| `nack(receipt, reason)` | 明确失败：进入退避，或者够次数了就进死信 |',
      '| `deadLetters()` | 死信列表，带 attempts 与 reason |',
      '| `inflight()` | 在飞条数 |',
      '',
      '退避是指数的：第 n 次失败之后等 `baseBackoffMs * 2^(n-1)`。',
      '不 ack 也不 nack（消费者宕机）同样算一次尝试，超时之后回来。',
      '',
      '## 怎么算过',
      '',
      '- `attempt` 从 1 开始递增，退避时间翻倍；',
      '- **投满 `maxAttempts` 次就进死信**，之后再也不投',
      '  （门槛 `counters.redeliveries ≤ 3` 数的是「第 2 次及以后的投递」有多少次）；',
      '- **毒消息退避期间，别的消息照常投递**',
      '  （门槛 `counters.poisonBlockedOthers = 0`）；',
      '- 死信条目带着尝试次数和失败原因；',
      '- 超时路径和 nack 路径都会累计尝试次数，都会进死信。',
      '',
      '## 为什么要指数退避',
      '',
      '因为失败的原因通常分两类，而它们需要相反的对待：',
      '',
      '| 失败原因 | 该怎么办 |',
      '| --- | --- |',
      '| 临时的（下游抖动、超时） | 稍等再试，多半就好了 |',
      '| 永久的（数据本身有问题） | 试多少次都一样，只是在浪费资源 |',
      '',
      '固定间隔重投对第一类太急、对第二类太浪费。指数退避是一个',
      '不需要区分两者的策略：临时故障在前几次就恢复了，',
      '永久故障则以指数级递减的频率骚扰系统，直到进死信。',
      '',
      '## 最容易写错的地方',
      '',
      '把重投做成「放回队头，下次 poll 优先取」。',
      '',
      '上一关刚说过重投要优先，这里为什么反而不行？因为**加了退避之后，',
      '「优先」和「立刻」不再是一回事**：一条正在退避的消息应该排在前面，',
      '但要等它的退避时间到了才算数。',
      '不加时间判断的「优先」会让毒消息在每次 poll 里都抢在最前面，',
      '把整条队列变成它一个人的重试循环。',
    ].join('\n'),
    [
      'The queue from the last stage rests on one fatally optimistic assumption: **every message eventually',
      'succeeds.**',
      '',
      'Some never will. A missing field, a malformed payload, a reference to an entity that was deleted — these',
      'are **poison messages**, and under the previous model one is redelivered forever: back on every timeout,',
      'consuming CPU, log space and alert budget until a human intervenes.',
      '',
      'Worse, it can **block the others**: if redelivery jumps the queue, or the consumer keeps choking on the',
      'same record, the whole queue stops on it.',
      '',
      'This stage adds two things: **backoff** (wait longer after each failure) and **dead letters** (after',
      'enough tries, take it away).',
      '',
      '## What to build',
      '',
      'Implement `createRetryingQueue(source, options)` in `src/redelivery.ts`. `source` is the stage 4 queue,',
      'demoted here to "a cursor that fetches from the log": **acknowledge each record as soon as you take',
      "it**, because this message's lifecycle now belongs to the retry layer. One owner per message is what",
      'stops two layers from independently deciding when it is redelivered.',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `poll(max)` | Take messages, each carrying `attempt` (starting at 1) |',
      '| `ack(receipt)` | Processed successfully |',
      '| `nack(receipt, reason)` | Explicit failure: back off, or dead-letter when the attempts run out |',
      '| `deadLetters()` | The dead letters, with attempts and reason |',
      '| `inflight()` | How many are out |',
      '',
      'Backoff is exponential: after the nth failure, wait `baseBackoffMs * 2^(n-1)`. Neither acking nor',
      'nacking — a crashed consumer — still counts as an attempt and comes back after the timeout.',
      '',
      '## What counts as passing',
      '',
      '- `attempt` starts at 1 and increases, and the backoff doubles each time;',
      '- **After `maxAttempts` deliveries it goes to the dead-letter list** and is never delivered again',
      '  (the `counters.redeliveries ≤ 3` gate counts deliveries after the first);',
      '- **While a poison message backs off, everything else keeps flowing**',
      '  (the `counters.poisonBlockedOthers = 0` gate);',
      '- Dead letters carry the attempt count and the failure reason;',
      '- Both the timeout path and the nack path accumulate attempts and both end in the dead-letter list.',
      '',
      '## Why exponential backoff',
      '',
      'Because failures come in two kinds that want opposite treatment:',
      '',
      '| Cause | What it deserves |',
      '| --- | --- |',
      '| Transient (a flaky dependency, a timeout) | Wait a moment and try again; it usually works |',
      '| Permanent (the data itself is wrong) | No number of attempts helps; each one is waste |',
      '',
      'A fixed interval is too eager for the first and too wasteful for the second. Exponential backoff is a',
      'policy that does not need to tell them apart: transient failures clear in the first few attempts, and',
      'permanent ones bother the system at an exponentially decreasing rate until they are retired.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Implementing redelivery as "put it back at the head so the next poll takes it first".',
      '',
      'The last stage insisted redelivery should be prioritised, so why not here? Because **once backoff',
      'exists, "first" and "immediately" stop being the same thing.** A message in backoff belongs at the',
      'front — once its backoff has elapsed. "First" without the time check makes the poison message win every',
      'poll and turns the whole queue into its personal retry loop.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**取消息** —— 退避到期的先发，不够再取新的',
      '',
      '```mermaid',
      'flowchart TD',
      '  P["poll(max)"] --> READY["扫 pending<br/>挑出 notBefore 已到期的"]',
      '  READY --> OVER{"尝试次数已经用完？"}',
      '  OVER -- 是 --> DLQ1["移进死信，不再投"]',
      '  OVER -- 否 --> OUT["发出去<br/>attempt 加一，换新 receipt"]',
      '  OUT --> ROOM{"还没取够 max？"}',
      '  ROOM -- 是 --> SRC["source.poll 取新货"]',
      '  SRC --> TAKE["立刻 source.ack<br/>生命周期归本层"]',
      '  TAKE --> OUT',
      '  ROOM -- 否 --> RET["返回这一批"]',
      '```',
      '',
      '**回执** —— 成功就删掉，失败就退避或送走',
      '',
      '```mermaid',
      'flowchart TD',
      '  A["ack(receipt)"] --> DONE["从 in-flight 和 pending 里一起删掉"]',
      '  N["nack(receipt, reason)"] --> CNT{"attempt 达到上限？"}',
      '  CNT -- 是 --> DLQ2["移进死信<br/>带上 attempts 与 reason"]',
      '  CNT -- 否 --> BACK["notBefore = 现在 + base 乘以 2 的 n 次方"]',
      '```',
      '',
      '要点：退避的表达方式是**给消息记一个「不早于」时刻**，而不是',
      '「把它放进一个延迟队列」。前者让 poll 的逻辑保持成一次简单的筛选，',
      '也让「退避中」和「在飞」是两个互斥的状态，不会互相打架。',
    ].join('\n'),
    [
      '**Polling** — expired backoffs first, then new records',
      '',
      '```mermaid',
      'flowchart TD',
      '  P["poll(max)"] --> READY["scan pending<br/>collect those whose notBefore passed"]',
      '  READY --> OVER{"attempts exhausted?"}',
      '  OVER -- yes --> DLQ1["move to dead letters, never deliver"]',
      '  OVER -- no --> OUT["hand out<br/>attempt + 1, new receipt"]',
      '  OUT --> ROOM{"still short of max?"}',
      '  ROOM -- yes --> SRC["source.poll for new records"]',
      '  SRC --> TAKE["ack the source immediately<br/>ownership moves here"]',
      '  TAKE --> OUT',
      '  ROOM -- no --> RET["return the batch"]',
      '```',
      '',
      '**Receipts** — success deletes, failure backs off or retires',
      '',
      '```mermaid',
      'flowchart TD',
      '  A["ack(receipt)"] --> DONE["remove from in-flight and pending"]',
      '  N["nack(receipt, reason)"] --> CNT{"attempts at the limit?"}',
      '  CNT -- yes --> DLQ2["dead-letter it<br/>with attempts and reason"]',
      '  CNT -- no --> BACK["notBefore = now + base times 2 to the n"]',
      '```',
      '',
      'The point: backoff is expressed as a **"not before" stamp on the message**, not as a separate delay',
      'queue. That keeps `poll` a simple filter and makes "backing off" and "in flight" two mutually exclusive',
      'states that cannot fight each other.',
    ].join('\n')
  ),
  checklist: [
    t('attempt 从 1 开始递增', 'attempt starts at 1 and increases'),
    t('退避时间指数增长', 'The backoff grows exponentially'),
    t('退避期间不参与投递', 'A backing-off message is not deliverable'),
    t('够次数就进死信，不再投', 'Enough attempts means dead-lettered, forever'),
    t('毒消息不挡住别的消息', 'A poison message never blocks the others'),
  ],
  pitfalls: [
    t(
      '重投时不看时间，只看「它失败过」就排在最前面。毒消息于是在每一次 poll 里都抢到第一位，队列变成它一个人的重试循环，而其他消息在监控上表现为「延迟突然升高」。优先级要和退避时间一起判断。',
      'Prioritising anything that failed, without checking the clock. The poison message wins every poll, the queue becomes its personal retry loop, and every other message shows up in monitoring as a latency spike. Priority has to be evaluated together with the backoff deadline.'
    ),
    t(
      '固定间隔重投。临时故障需要快速重试，永久故障需要越来越慢 —— 固定间隔对两者都不合适，而且它会制造一个整齐的重试波峰：一批消息同时失败、同时重试、同时再失败。真实系统里还要给退避加抖动，否则这个波峰会一直保持整齐。',
      'Retrying at a fixed interval. Transient failures want speed and permanent ones want increasing slowness, and a fixed interval suits neither — it also creates a tidy retry wave where a batch fails together, retries together and fails together again. Production adds jitter for exactly that reason.'
    ),
    t(
      '死信只记消息本身，不记原因和次数。死信队列的用途是「让人来看看这里出了什么事」，而一条没有上下文的消息回答不了任何问题 —— 排查的人只能去日志里翻，而日志通常已经滚掉了。',
      'Storing only the message in the dead-letter list, without a reason or attempt count. A dead-letter queue exists so a person can find out what went wrong, and a message without context answers nothing — the investigator ends up grepping logs that have already rolled away.'
    ),
    t(
      '让第 4 关的队列和这一层同时管同一条消息的重投。两边各有一套超时，同一条消息会被两套逻辑分别安排重投，于是出现「明明在退避，却又被投出去了」。一条消息在任一时刻只能有一个所有者。',
      'Letting the stage 4 queue and this layer both manage redelivery of the same message. Each has its own timeout, both schedule the same record, and you get a message that is simultaneously backing off and being delivered. A message has exactly one owner at a time.'
    ),
  ],
  hints: [
    t(
      'pending 用 Map<offset, 条目>，条目里放 { record, attempts, notBefore }。in-flight 用另一个 Map<receipt, offset> 指回去 —— 两张表，两个状态，互不重叠。',
      'Keep pending as a Map from offset to { record, attempts, notBefore }, and in-flight as a second Map from receipt back to the offset. Two tables, two states, no overlap.'
    ),
    t(
      '「够次数了」的判断在两个地方都要做：nack 的时候，以及超时回来准备再发的时候。把它抽成一个 retire() 函数，两处都调它。',
      'The "attempts exhausted" check is needed in two places: on nack, and when a timed-out message is about to go out again. Extract one `retire()` and call it from both.'
    ),
  ],
  extension: t(
    [
      '死信队列（DLQ）是所有主流消息系统的标配：SQS 的 RedrivePolicy',
      '（`maxReceiveCount` 到了就转投另一个队列）、RabbitMQ 的',
      '`x-dead-letter-exchange`、Kafka 生态里 Connect 的 `errors.deadletterqueue.topic.name`。',
      '',
      '有意思的是 Kafka 核心本身**没有**死信概念 —— 因为它的日志是不可变的，',
      '消息不能「移走」。所以 Kafka 的重试通常是应用层的：',
      '把失败的消息重新生产到一个 retry topic（甚至按退避时长分成',
      'retry-5s / retry-1m / retry-10m 几个 topic），死信也是另一个 topic。',
      '这是一个很好的例子：**存储模型决定了上层能提供什么原语**。',
      '',
      '还有一个这一关没做但很重要的东西：**重放死信**。',
      '死信队列不是垃圾桶，是待处理箱 —— 修好代码之后要能把它们放回主队列。',
      '所以死信条目必须保留完整的原始消息，而不只是一条错误日志。',
    ].join('\n'),
    [
      'Dead-letter queues are standard equipment: SQS has a RedrivePolicy (a `maxReceiveCount` after which the',
      "message is moved), RabbitMQ has `x-dead-letter-exchange`, and Kafka Connect has",
      '`errors.deadletterqueue.topic.name`.',
      '',
      'Interestingly, Kafka core has **no** dead-letter concept, because its log is immutable and a message',
      'cannot be moved out of it. Retries there are an application concern: failed messages are produced to a',
      'retry topic — often several, split by delay, retry-5s / retry-1m / retry-10m — and dead letters are yet',
      'another topic. It is a clean illustration that **the storage model decides which primitives the layer',
      'above can offer.**',
      '',
      'One important thing this stage omits: **replaying dead letters.** A DLQ is not a bin, it is an inbox —',
      'after the bug is fixed those messages need to go back into the main queue. Which is why a dead-letter',
      'entry has to keep the whole original message, not just an error line.',
    ].join('\n')
  ),
  focus: ['resilience', 'correctness', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/redelivery.ts',
      code`
        import type { DeliveryQueue } from './delivery';
        import type { StoredRecord } from './support/storage';
        import { now } from '@lab/env';

        export interface RetryOptions {
          /** 投出去多久没回音就算一次失败 */
          visibilityMs: number;
          /** 最多投几次 */
          maxAttempts: number;
          /** 第 n 次失败之后等 baseBackoffMs 乘以 2 的 n-1 次方 */
          baseBackoffMs: number;
        }

        export interface RetryDelivery {
          record: StoredRecord;
          receipt: string;
          /** 这是第几次投递，从 1 开始 */
          attempt: number;
        }

        export interface DeadLetter {
          record: StoredRecord;
          attempts: number;
          reason: string;
        }

        export interface RetryingQueue {
          poll(max: number): RetryDelivery[];
          ack(receipt: string): boolean;
          /** 明确的处理失败 */
          nack(receipt: string, reason: string): void;
          deadLetters(): DeadLetter[];
          inflight(): number;
        }

        export function createRetryingQueue(source: DeliveryQueue, options: RetryOptions): RetryingQueue {
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
        import { createRetryingQueue } from '../src/redelivery';
        import { createDeliveryQueue } from '../src/delivery';
        import { createIndexedLog } from '../src/offsetIndex';
        import { createStorage } from '../src/support/storage';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const VISIBILITY = 1000;
        const BASE_BACKOFF = 200;
        const MAX_ATTEMPTS = 3;

        function makeQueue(records: number) {
          const storage = createStorage();
          const log = createIndexedLog(storage, { segmentBytes: 24000, indexInterval: 16 });
          for (let index = 0; index < records; index += 1) {
            log.append('k' + String(index).padStart(3, '0'), 'v' + index);
          }
          const source = createDeliveryQueue(log, { visibilityMs: VISIBILITY });
          const queue = createRetryingQueue(source, {
            visibilityMs: VISIBILITY,
            maxAttempts: MAX_ATTEMPTS,
            baseBackoffMs: BASE_BACKOFF,
          });
          return { log, queue };
        }

        function offsetsOf(deliveries: any[]): number[] {
          return deliveries.map((delivery) => delivery.record.offset);
        }

        describe('阶段5 · 重投退避与死信', () => {
          it('处理成功之后不再投递', async () => {
            const context = makeQueue(2);
            const first = context.queue.poll(1)[0];

            expect(first.attempt).toBe(1);
            expect(context.queue.ack(first.receipt)).toBe(true);

            await sleep(VISIBILITY * 2);
            expect(offsetsOf(context.queue.poll(5))).toEqual([1]);
          });

          it('nack 之后按退避重投，attempt 递增', async () => {
            const context = makeQueue(1);
            const first = context.queue.poll(1)[0];
            context.queue.nack(first.receipt, 'boom');

            // 退避还没到，取不到
            expect(context.queue.poll(1)).toEqual([]);

            await sleep(BASE_BACKOFF);
            const second = context.queue.poll(1)[0];
            expect(second.attempt).toBe(2);
            expect(second.record.offset).toBe(0);
          });

          it('退避时间是指数增长的', async () => {
            const context = makeQueue(1);

            const first = context.queue.poll(1)[0];
            context.queue.nack(first.receipt, 'boom');
            await sleep(BASE_BACKOFF);

            const second = context.queue.poll(1)[0];
            context.queue.nack(second.receipt, 'boom');

            // 第二次失败之后要等两倍
            await sleep(BASE_BACKOFF);
            expect(context.queue.poll(1)).toEqual([]);
            await sleep(BASE_BACKOFF);
            expect(context.queue.poll(1)[0].attempt).toBe(3);
          });

          it('投满次数之后进死信，不再投 [gate:retry]', async () => {
            const context = makeQueue(1);
            let handed = 0;

            for (let round = 0; round < 6; round += 1) {
              for (const delivery of context.queue.poll(1)) {
                handed += 1;
                if (delivery.attempt > 1) count('redeliveries');
                context.queue.nack(delivery.receipt, 'bad payload');
              }
              await sleep(BASE_BACKOFF * 8);
            }

            expect(handed).toBe(MAX_ATTEMPTS);
            expect(context.queue.deadLetters()).toHaveLength(1);
          });

          it('死信条目带着次数和原因', async () => {
            const context = makeQueue(1);

            for (let round = 0; round < MAX_ATTEMPTS; round += 1) {
              for (const delivery of context.queue.poll(1)) {
                context.queue.nack(delivery.receipt, 'missing field');
              }
              await sleep(BASE_BACKOFF * 8);
            }

            const dead = context.queue.deadLetters()[0];
            expect(dead.record.offset).toBe(0);
            expect(dead.attempts).toBe(MAX_ATTEMPTS);
            expect(dead.reason).toBe('missing field');
          });

          it('毒消息退避期间，别的消息照常投递', () => {
            const context = makeQueue(3);

            const poison = context.queue.poll(1)[0];
            context.queue.nack(poison.receipt, 'boom');

            const others = context.queue.poll(2);
            if (others.length === 0) count('poisonBlockedOthers');
            expect(offsetsOf(others)).toEqual([1, 2]);
          });

          it('毒消息进死信之后，后面的消息一条不落', async () => {
            const context = makeQueue(4);
            const seen = new Set<number>();

            for (let round = 0; round < 8; round += 1) {
              for (const delivery of context.queue.poll(4)) {
                if (delivery.record.offset === 0) {
                  context.queue.nack(delivery.receipt, 'boom');
                } else {
                  seen.add(delivery.record.offset);
                  context.queue.ack(delivery.receipt);
                }
              }
              await sleep(BASE_BACKOFF * 8);
            }

            if (seen.size < 3) count('poisonBlockedOthers');
            expect(Array.from(seen).sort()).toEqual([1, 2, 3]);
            expect(context.queue.deadLetters()).toHaveLength(1);
          });

          it('不 ack 也不 nack 同样算一次尝试', async () => {
            const context = makeQueue(1);

            expect(context.queue.poll(1)[0].attempt).toBe(1);
            await sleep(VISIBILITY);

            expect(context.queue.poll(1)[0].attempt).toBe(2);
          });

          it('反复超时最终也会进死信', async () => {
            const context = makeQueue(1);

            for (let round = 0; round < MAX_ATTEMPTS + 2; round += 1) {
              context.queue.poll(1);
              await sleep(VISIBILITY);
            }

            expect(context.queue.deadLetters()).toHaveLength(1);
            expect(context.queue.poll(1)).toEqual([]);
          });

          it('死信之后 ack 旧凭据不再生效', async () => {
            const context = makeQueue(1);
            let last: any = null;

            for (let round = 0; round < MAX_ATTEMPTS; round += 1) {
              last = context.queue.poll(1)[0];
              context.queue.nack(last.receipt, 'boom');
              await sleep(BASE_BACKOFF * 8);
            }

            expect(context.queue.ack(last.receipt)).toBe(false);
            expect(context.queue.deadLetters()).toHaveLength(1);
          });

          it('刚开始时没有死信，inflight 为 0', () => {
            const context = makeQueue(2);

            expect(context.queue.deadLetters()).toEqual([]);
            expect(context.queue.inflight()).toBe(0);

            context.queue.poll(2);
            expect(context.queue.inflight()).toBe(2);
          });

          it('ack 掉的消息不会进死信', async () => {
            const context = makeQueue(2);

            for (const delivery of context.queue.poll(2)) {
              context.queue.ack(delivery.receipt);
            }
            await sleep(VISIBILITY * 3);

            expect(context.queue.deadLetters()).toEqual([]);
            expect(context.queue.poll(5)).toEqual([]);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.redeliveries',
      op: 'lte',
      value: 3,
      zh: '一条毒消息最多重投 3 次',
      en: 'A poison message is redelivered at most three times',
      dimension: 'resilience',
      scope: 'gate:retry',
    }),
    gate({
      metric: 'counters.poisonBlockedOthers',
      op: 'eq',
      value: 0,
      zh: '毒消息一次都没挡住别的消息',
      en: 'A poison message never blocks the others',
      dimension: 'concurrency',
    }),
  ],
  referenceFiles: [
    file(
      'src/redelivery.ts',
      code`
        import type { DeliveryQueue } from './delivery';
        import type { StoredRecord } from './support/storage';
        import { now } from '@lab/env';

        export interface RetryOptions {
          visibilityMs: number;
          maxAttempts: number;
          baseBackoffMs: number;
        }

        export interface RetryDelivery {
          record: StoredRecord;
          receipt: string;
          attempt: number;
        }

        export interface DeadLetter {
          record: StoredRecord;
          attempts: number;
          reason: string;
        }

        export interface RetryingQueue {
          poll(max: number): RetryDelivery[];
          ack(receipt: string): boolean;
          nack(receipt: string, reason: string): void;
          deadLetters(): DeadLetter[];
          inflight(): number;
        }

        /** 一条还没完成的消息 */
        interface PendingEntry {
          record: StoredRecord;
          attempts: number;
          /** 早于这个时刻不参与投递：退避和可见性超时都写在这里 */
          notBefore: number;
        }

        export function createRetryingQueue(source: DeliveryQueue, options: RetryOptions): RetryingQueue {
          const pending = new Map<number, PendingEntry>();
          /** receipt -> offset，只指路，不存状态 */
          const outstanding = new Map<string, number>();
          const dead: DeadLetter[] = [];
          let nextReceipt = 0;

          function retire(entry: PendingEntry, reason: string): void {
            pending.delete(entry.record.offset);
            dead.push({ record: entry.record, attempts: entry.attempts, reason });
          }

          function handOut(entry: PendingEntry): RetryDelivery {
            entry.attempts += 1;
            // 发出去之后就按可见性超时算，没回音就当失败
            entry.notBefore = now() + options.visibilityMs;
            const receipt = 'r-' + nextReceipt;
            nextReceipt += 1;
            outstanding.set(receipt, entry.record.offset);
            return { record: entry.record, receipt, attempt: entry.attempts };
          }

          /** 退避到期、当前不在飞的那些 */
          function ready(): PendingEntry[] {
            return Array.from(pending.values())
              .filter((entry) => entry.notBefore <= now())
              .sort((left, right) => left.record.offset - right.record.offset);
          }

          function take(max: number, batch: RetryDelivery[]): void {
            while (batch.length < max) {
              const fetched = source.poll(max - batch.length);
              if (fetched.length === 0) return;
              for (const delivery of fetched) {
                // 立刻 ack 源队列：这条消息的生命周期从这里起归本层管
                source.ack(delivery.receipt);
                const entry: PendingEntry = { record: delivery.record, attempts: 0, notBefore: 0 };
                pending.set(delivery.record.offset, entry);
                batch.push(handOut(entry));
              }
            }
          }

          return {
            poll(max: number): RetryDelivery[] {
              const batch: RetryDelivery[] = [];
              if (max <= 0) return batch;

              for (const entry of ready()) {
                if (batch.length >= max) return batch;
                // 超时回来的也算用掉了一次机会
                if (entry.attempts >= options.maxAttempts) {
                  retire(entry, 'max attempts exceeded');
                  continue;
                }
                batch.push(handOut(entry));
              }

              take(max, batch);
              return batch;
            },

            ack(receipt: string): boolean {
              const offset = outstanding.get(receipt);
              if (offset === undefined) return false;
              outstanding.delete(receipt);
              return pending.delete(offset);
            },

            nack(receipt: string, reason: string): void {
              const offset = outstanding.get(receipt);
              if (offset === undefined) return;
              outstanding.delete(receipt);
              const entry = pending.get(offset);
              if (!entry) return;

              if (entry.attempts >= options.maxAttempts) {
                retire(entry, reason);
                return;
              }
              // 指数退避：第 n 次失败之后等 base 乘以 2 的 n-1 次方
              entry.notBefore = now() + options.baseBackoffMs * Math.pow(2, entry.attempts - 1);
            },

            deadLetters(): DeadLetter[] {
              return dead.map((letter) => ({ ...letter }));
            },

            inflight(): number {
              return outstanding.size;
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
      '**退避是一个「不早于」时刻，不是一个延迟队列。** `notBefore` 这一个字段',
      '同时表达了两种等待：投出去之后的可见性超时，和失败之后的退避。',
      '两者本来就是同一件事 —— 「这条消息暂时别再发了」—— 用两套机制表达它，',
      '就会出现「退避中的消息被可见性超时唤醒」这种自己打自己的 bug。',
      '',
      '**`outstanding` 只存 receipt 到 offset 的映射，不存状态。** 状态只有一份，',
      '在 `pending` 里。两张表都存状态的话，ack 和超时会各改各的，迟早对不上。',
      '',
      '**从源队列取货之后立刻 ack。** 这一行是两层之间的所有权交接：',
      '在此之前消息属于第 4 关的队列，在此之后属于重试层。',
      '不交接的话，同一条消息会被两套超时各自安排重投 ——',
      '而这种 bug 的现象是「消息偶尔会被处理两次」，几乎无法在测试里复现。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'Backoff is a "not before" instant, not a delay queue. The single `notBefore` field expresses both kinds',
      'of waiting: the visibility timeout after a delivery and the backoff after a failure. They are the same',
      'statement — "do not send this one for now" — and expressing it with two mechanisms produces the',
      'self-defeating bug where a backing-off message is woken by its visibility timeout.',
      '',
      '`outstanding` maps receipts to offsets and holds no state. The state exists once, in `pending`. With',
      'state in both tables, acks and timeouts each update their own copy and the two eventually disagree.',
      '',
      'Acknowledging the source queue immediately after fetching is the ownership handover between the layers:',
      'before that line the message belongs to stage 4, after it to the retry layer. Without the handover, two',
      'timeout mechanisms schedule the same message independently — and the symptom, "messages are',
      'occasionally processed twice", is nearly impossible to reproduce in a test.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 6 关 · 扇出订阅                                                   */
/* ------------------------------------------------------------------ */

const stage6 = {
  id: 'fanout-subscriptions',
  title: t('第 6 关 · 一份数据，多个订阅', 'Stage 6 · One copy, many subscriptions'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '到这里为止，一条消息被投给一个消费者就结束了。但真实系统里，',
      '同一条「订单已支付」往往要同时喂给发货、开票、风控、数据仓库四路下游。',
      '',
      '最直接的做法是给每一路复制一份。它在两个订阅时看不出问题，',
      '在十个订阅时就变成了：**存储成本乘以十，写入吞吐除以十**。',
      '而这十份数据的内容一模一样。',
      '',
      '正确的做法是：**数据只存一份，每个订阅只存一个数字** —— 它读到哪儿了。',
      '一份日志加十个整数，和一份日志加一个整数，成本几乎相同。',
      '',
      '## 要实现什么',
      '',
      '在 `src/fanout.ts` 实现 `createTopic(log)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `publish(key, value)` | 发一条消息，**无论有几个订阅，只写一次** |',
      '| `subscribe(name, options?)` | 拿到一个订阅；同名返回同一个（游标共享） |',
      '| `subscriptions()` | 现有的订阅名 |',
      '| `endOffset()` | 日志末尾 |',
      '',
      '订阅本身：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `poll(max)` | 从自己的位置读，**不推进游标** |',
      '| `commit(offset)` | 确认处理到这里（含），游标推到下一条 |',
      '| `seek(offset)` | 跳到任意位置，用来回放 |',
      '| `position()` / `lag()` | 当前位置 / 落后多少条 |',
      '',
      '`subscribe` 的 `options.from` 可以是 `beginning`（默认，从头读）',
      '或 `end`（只看订阅之后的新消息）。',
      '',
      '## 怎么算过',
      '',
      '- 一条消息、三个订阅，**存储只写了一次**',
      '  （门槛 `counters.storageAppends = 1`）；',
      '- 三个订阅都能读到它，而且各自的游标互不影响；',
      '- 新订阅默认能读到历史消息，`from: end` 的只看新的；',
      '- 同名订阅拿到的是同一个游标；',
      '- `commit` 只会前进，不会因为一个更小的 offset 而倒退；',
      '- `seek` 之后可以重放已经处理过的消息。',
      '',
      '## 为什么 commit 不能倒退',
      '',
      '因为 ack 是会乱序到达的。',
      '',
      '消费者并发处理 10、11、12 三条，12 先完成、提交；11 随后完成、提交。',
      '如果 commit 允许倒退，游标就退回了 11 —— 12 会被再投一次。',
      '而这条规则一旦成立，「提交」的语义就变成了',
      '**「这个位置之前的都处理完了」**，而不是「这一条处理完了」。',
      '',
      '这也是为什么消费位置是一个数字而不是一个集合：',
      '一个数字表达的是一条前缀，不是一堆散点。',
      '',
      '## 最容易写错的地方',
      '',
      '把订阅做成「拿到消息的一份拷贝」。',
      '',
      '写法上通常是 `subscription.buffer.push(record)` —— 每次 publish 往每个订阅的',
      '数组里塞一份。功能完全正确，测试也过，但存储和内存开销都随订阅数线性增长，',
      '而且历史消息没法回放（新订阅的 buffer 是空的）。',
      '日志已经在那里了，订阅需要的只是一个下标。',
    ].join('\n'),
    [
      'So far a message goes to one consumer and is done. In a real system the same "order paid" event feeds',
      'shipping, invoicing, fraud detection and the data warehouse at once.',
      '',
      'The direct approach copies the message for each. With two subscriptions nothing looks wrong; with ten',
      'it becomes **ten times the storage and a tenth of the write throughput** — for ten byte-identical copies.',
      '',
      'The right shape is: **store the data once, store one number per subscription** — how far it has read.',
      'One log plus ten integers costs almost exactly what one log plus one integer costs.',
      '',
      '## What to build',
      '',
      'Implement `createTopic(log)` in `src/fanout.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `publish(key, value)` | Publish once — **one write no matter how many subscriptions** |',
      '| `subscribe(name, options?)` | Get a subscription; the same name shares the same cursor |',
      '| `subscriptions()` | The existing subscription names |',
      '| `endOffset()` | The end of the log |',
      '',
      'And on a subscription:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `poll(max)` | Read from its own position **without advancing** |',
      '| `commit(offset)` | Confirm through this offset inclusive; the cursor moves past it |',
      '| `seek(offset)` | Jump anywhere, for replay |',
      '| `position()` / `lag()` | Where it is / how far behind |',
      '',
      "`subscribe`'s `options.from` is either `beginning` (the default, read history) or `end` (only messages",
      'published afterwards).',
      '',
      '## What counts as passing',
      '',
      '- One message with three subscriptions costs **exactly one write**',
      '  (the `counters.storageAppends = 1` gate);',
      '- All three read it, and their cursors move independently;',
      '- A new subscription sees history by default; `from: end` sees only new messages;',
      '- The same name yields the same cursor;',
      '- `commit` only moves forward and never rewinds on a smaller offset;',
      '- `seek` replays messages that were already processed.',
      '',
      '## Why commit must not rewind',
      '',
      'Because acknowledgements arrive out of order.',
      '',
      'A consumer processes 10, 11 and 12 concurrently; 12 finishes and commits, then 11 finishes and commits.',
      'If commit could rewind, the cursor goes back to 11 and 12 is delivered again. Once the rule holds, the',
      'meaning of a commit becomes **"everything before this point is done"** rather than "this one is done".',
      '',
      'That is also why a consumer position is a number rather than a set: a number expresses a prefix, not a',
      'scattering of points.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Implementing a subscription as its own copy of the messages.',
      '',
      'It usually looks like `subscription.buffer.push(record)` — a copy pushed into every subscription on every',
      'publish. Functionally correct, tests pass, and both storage and memory grow linearly with the number of',
      'subscribers, while history cannot be replayed at all (a new subscription starts with an empty buffer).',
      'The log is already there; a subscription needs an index into it.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**发布与订阅** —— 写一次，游标一人一个',
      '',
      '```mermaid',
      'flowchart TD',
      '  PUB["publish(key, value)"] --> ONE["log.append 一次<br/>订阅数不影响这里"]',
      '  ONE --> OFF["返回 offset"]',
      '  SUB["subscribe(name, from)"] --> HAS{"这个名字有游标了吗？"}',
      '  HAS -- 有 --> REUSE["返回同一个游标<br/>同名就是同一个订阅"]',
      '  HAS -- 没有 --> INIT{"from 是 end 吗？"}',
      '  INIT -- 是 --> ATEND["游标 = 当前末尾"]',
      '  INIT -- 否 --> ATZERO["游标 = 0，历史照读"]',
      '```',
      '',
      '**游标的三种动法** —— 读不动、确认才动、回放随意',
      '',
      '```mermaid',
      'flowchart TD',
      '  POLL["subscription.poll(max)"] --> READ["log.read(游标, max)<br/>只读，不推进"]',
      '  CMT["subscription.commit(offset)"] --> FWD{"offset+1 比现在大吗？"}',
      '  FWD -- 大 --> MOVE["游标推到 offset+1"]',
      '  FWD -- 不大 --> KEEP["原地不动<br/>乱序到达的旧确认不能让它倒退"]',
      '  SEEK["subscription.seek(offset)"] --> ANY["游标直接设成 offset<br/>回放就是把它调小"]',
      '```',
      '',
      '要点：整张图里只有一个地方碰存储（`log.append`），',
      '其余全是在改一个整数。这就是「一份数据、多个订阅」在代码上的样子。',
    ].join('\n'),
    [
      '**Publish and subscribe** — one write, one cursor per name',
      '',
      '```mermaid',
      'flowchart TD',
      '  PUB["publish(key, value)"] --> ONE["one log.append<br/>subscription count is irrelevant"]',
      '  ONE --> OFF["return the offset"]',
      '  SUB["subscribe(name, from)"] --> HAS{"does this name have a cursor?"}',
      '  HAS -- yes --> REUSE["return the same cursor<br/>same name, same subscription"]',
      '  HAS -- no --> INIT{"is from equal to end?"}',
      '  INIT -- yes --> ATEND["cursor = current end"]',
      '  INIT -- no --> ATZERO["cursor = 0, history included"]',
      '```',
      '',
      '**Three ways a cursor moves** — reads never, commits forward, seeks anywhere',
      '',
      '```mermaid',
      'flowchart TD',
      '  POLL["subscription.poll(max)"] --> READ["log.read(cursor, max)<br/>read only, no advance"]',
      '  CMT["subscription.commit(offset)"] --> FWD{"is offset+1 greater than now?"}',
      '  FWD -- yes --> MOVE["move the cursor to offset+1"]',
      '  FWD -- no --> KEEP["stay put<br/>a late out-of-order ack must not rewind it"]',
      '  SEEK["subscription.seek(offset)"] --> ANY["set the cursor directly<br/>replay is just a smaller number"]',
      '```',
      '',
      'The point: exactly one node in this diagram touches storage (`log.append`); everything else edits an',
      'integer. That is what "one copy, many subscriptions" looks like in code.',
    ].join('\n')
  ),
  checklist: [
    t('一次 publish 只写一次存储', 'One publish, one write'),
    t('每个订阅只保存一个位置', 'A subscription is one number'),
    t('poll 不推进游标，commit 才推进', 'poll reads, commit advances'),
    t('commit 单调不倒退', 'commit is monotonic'),
    t('seek 能回放历史', 'seek replays history'),
  ],
  pitfalls: [
    t(
      '给每个订阅存一份消息拷贝。存储与内存随订阅数线性增长，写入吞吐被订阅数除，而且新订阅看不到历史 —— 而这三件事恰恰是「用日志做消息系统」最想避免的。',
      'Keeping a copy of each message per subscription. Storage and memory grow with the subscriber count, write throughput is divided by it, and a new subscription cannot see history — the three things a log-backed message system exists to avoid.'
    ),
    t(
      '让 commit 直接覆盖游标。乱序到达的旧确认会把游标往回拽，已经处理过的消息被再投一次。消费位置是一条前缀的边界，只能前进。',
      'Letting commit assign the cursor directly. A late out-of-order acknowledgement drags it backwards and already-processed messages are delivered again. A consumer position is the boundary of a prefix and only moves forward.'
    ),
    t(
      '让 poll 顺手推进游标。这样「读到了」就等于「处理完了」，消费者一崩溃，正在处理的那一批就再也回不来 —— 这正是第 4 关花了一整关避免的事。读和确认必须是两个动作。',
      'Advancing the cursor inside poll. "Read" then means "done", so a consumer crash loses the batch in flight — precisely what stage 4 spent an entire stage avoiding. Reading and acknowledging are two acts.'
    ),
    t(
      '新订阅默认从末尾开始。听起来更「安全」（不会突然处理一大批历史），但它让「加一路新下游」这件事永远拿不到历史数据，而补数据的唯一办法是手动重放。默认从头开始、需要时显式指定 end，语义更清楚。',
      'Defaulting a new subscription to the end. It sounds safer — no sudden flood of history — and it means adding a downstream consumer can never see what came before, with manual replay as the only remedy. Defaulting to the beginning and asking for `end` explicitly states the intent.'
    ),
  ],
  hints: [
    t(
      '订阅的全部状态就是一个 Map<名字, 位置>。订阅对象本身可以每次现造，它只是这个数字的一层外壳。',
      'The entire state is a Map from name to position. The subscription object can be constructed on demand; it is a shell around that number.'
    ),
    t(
      'lag 是 endOffset 减去当前位置，注意它不能为负 —— seek 到末尾之后又有新消息进来时，两个数会同时变。',
      'Lag is endOffset minus the position and must never be negative — after seeking to the end, both numbers move as new messages arrive.'
    ),
  ],
  extension: t(
    [
      'Kafka 的消费者组就是这一关：一个 topic 的数据只有一份，',
      '每个消费者组在 `__consumer_offsets` 里存自己的位置。',
      '「加一路新下游」在 Kafka 里是零成本的 —— 不需要改生产者，',
      '不需要额外存储，只是多了一行 offset 记录。',
      '',
      'RabbitMQ 的模型不同：exchange 把消息**路由**到多个 queue，',
      '每个 queue 真的各存一份。代价是扇出会放大存储，',
      '好处是每个 queue 可以有完全独立的生命周期（不同的 TTL、不同的死信策略）。',
      '两种模型没有优劣，只有取舍 —— 而这个取舍决定了它们各自擅长的场景：',
      'Kafka 擅长「一份数据喂很多下游」，RabbitMQ 擅长「每个下游有自己的规矩」。',
      '',
      '还有一个这一关刻意留着的洞：**订阅位置存在哪儿**。',
      '这里存在内存里，进程一重启就全丢了。真实系统要么存进日志本身',
      '（Kafka 的做法：offset 也是一个 topic），要么存进外部存储。',
      '第 10 关会再碰到这个问题。',
    ].join('\n'),
    [
      "Kafka's consumer groups are this stage: one copy of the topic data, and each group storing its position",
      'in `__consumer_offsets`. Adding a downstream consumer costs nothing — no producer change, no extra',
      'storage, just one more offset row.',
      '',
      "RabbitMQ's model differs: an exchange **routes** each message into several queues, each of which really",
      'does hold its own copy. Fan-out multiplies storage, and in exchange every queue gets a fully independent',
      'lifecycle — its own TTL, its own dead-letter policy. Neither model is better; the trade decides what',
      'each is good at. Kafka excels at feeding many consumers from one copy, RabbitMQ at giving every consumer',
      'its own rules.',
      '',
      'One hole deliberately left here: **where subscription positions live.** In memory, so a restart loses',
      'them all. Real systems either store them in the log itself (Kafka: offsets are a topic) or in external',
      'storage. Stage 10 runs into this again.',
    ].join('\n')
  ),
  focus: ['encapsulation', 'correctness', 'latency'],
  lab: {},
  starterFiles: [
    file(
      'src/fanout.ts',
      code`
        import type { MessageLog } from './log';
        import type { StoredRecord } from './support/storage';

        export interface SubscribeOptions {
          /** beginning：从头读（默认）；end：只看订阅之后的新消息 */
          from?: 'beginning' | 'end';
        }

        export interface Subscription {
          name: string;
          /** 从自己的位置往后读，不推进游标 */
          poll(max: number): StoredRecord[];
          /** 确认处理到 offset（含） */
          commit(offset: number): void;
          /** 跳到任意位置，用来回放 */
          seek(offset: number): void;
          position(): number;
          lag(): number;
        }

        export interface Topic {
          publish(key: string, value: string): number;
          subscribe(name: string, options?: SubscribeOptions): Subscription;
          subscriptions(): string[];
          endOffset(): number;
        }

        export function createTopic(log: MessageLog): Topic {
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
        import { createTopic } from '../src/fanout';
        import { createIndexedLog } from '../src/offsetIndex';
        import { createStorage } from '../src/support/storage';

        function makeTopic() {
          const storage = createStorage();
          const log = createIndexedLog(storage, { segmentBytes: 24000, indexInterval: 16 });
          return { storage, log, topic: createTopic(log) };
        }

        function valuesOf(records: any[]): string[] {
          return records.map((record) => record.value);
        }

        describe('阶段6 · 一份数据，多个订阅', () => {
          it('一条消息三个订阅都能读到，而存储只写了一次 [gate:fanout]', () => {
            const context = makeTopic();
            const shipping = context.topic.subscribe('shipping');
            const billing = context.topic.subscribe('billing');
            const warehouse = context.topic.subscribe('warehouse');

            context.topic.publish('order-1', 'paid');

            expect(valuesOf(shipping.poll(10))).toEqual(['paid']);
            expect(valuesOf(billing.poll(10))).toEqual(['paid']);
            expect(valuesOf(warehouse.poll(10))).toEqual(['paid']);
          });

          it('各自的游标互不影响', () => {
            const context = makeTopic();
            const fast = context.topic.subscribe('fast');
            const slow = context.topic.subscribe('slow');
            for (let index = 0; index < 5; index += 1) context.topic.publish('k', 'v' + index);

            fast.commit(4);

            expect(fast.position()).toBe(5);
            expect(slow.position()).toBe(0);
            expect(fast.poll(10)).toEqual([]);
            expect(slow.poll(10)).toHaveLength(5);
          });

          it('poll 不推进游标', () => {
            const context = makeTopic();
            const subscription = context.topic.subscribe('one');
            context.topic.publish('k', 'v0');

            expect(subscription.poll(10)).toHaveLength(1);
            expect(subscription.poll(10)).toHaveLength(1);
            expect(subscription.position()).toBe(0);
          });

          it('commit 之后从下一条开始', () => {
            const context = makeTopic();
            const subscription = context.topic.subscribe('one');
            for (let index = 0; index < 4; index += 1) context.topic.publish('k', 'v' + index);

            subscription.commit(1);

            expect(valuesOf(subscription.poll(10))).toEqual(['v2', 'v3']);
            expect(subscription.position()).toBe(2);
          });

          it('commit 不会倒退', () => {
            const context = makeTopic();
            const subscription = context.topic.subscribe('one');
            for (let index = 0; index < 4; index += 1) context.topic.publish('k', 'v' + index);

            subscription.commit(2);
            // 乱序到达的旧确认
            subscription.commit(0);

            expect(subscription.position()).toBe(3);
          });

          it('新订阅默认能读到历史消息', () => {
            const context = makeTopic();
            context.topic.publish('k', 'old-1');
            context.topic.publish('k', 'old-2');

            const late = context.topic.subscribe('late');

            expect(valuesOf(late.poll(10))).toEqual(['old-1', 'old-2']);
          });

          it('from 为 end 的订阅只看新消息', () => {
            const context = makeTopic();
            context.topic.publish('k', 'old');

            const tail = context.topic.subscribe('tail', { from: 'end' });
            context.topic.publish('k', 'new');

            expect(valuesOf(tail.poll(10))).toEqual(['new']);
          });

          it('同名订阅共享同一个游标', () => {
            const context = makeTopic();
            for (let index = 0; index < 3; index += 1) context.topic.publish('k', 'v' + index);

            context.topic.subscribe('shared').commit(1);

            expect(context.topic.subscribe('shared').position()).toBe(2);
            expect(context.topic.subscriptions()).toEqual(['shared']);
          });

          it('seek 可以回放已经处理过的消息', () => {
            const context = makeTopic();
            const subscription = context.topic.subscribe('one');
            for (let index = 0; index < 4; index += 1) context.topic.publish('k', 'v' + index);
            subscription.commit(3);
            expect(subscription.poll(10)).toEqual([]);

            subscription.seek(1);

            expect(valuesOf(subscription.poll(10))).toEqual(['v1', 'v2', 'v3']);
          });

          it('lag 反映落后多少条', () => {
            const context = makeTopic();
            const subscription = context.topic.subscribe('one');
            for (let index = 0; index < 5; index += 1) context.topic.publish('k', 'v' + index);

            expect(subscription.lag()).toBe(5);
            subscription.commit(2);
            expect(subscription.lag()).toBe(2);
            subscription.commit(4);
            expect(subscription.lag()).toBe(0);
          });

          it('没有任何订阅时也能正常发布', () => {
            const context = makeTopic();

            expect(context.topic.publish('k', 'v0')).toBe(0);
            expect(context.topic.endOffset()).toBe(1);
            expect(context.topic.subscriptions()).toEqual([]);
          });

          it('订阅数变多不影响已经发布的消息', () => {
            const context = makeTopic();
            const first = context.topic.subscribe('first');
            context.topic.publish('k', 'v0');
            const second = context.topic.subscribe('second');
            context.topic.publish('k', 'v1');

            expect(valuesOf(first.poll(10))).toEqual(['v0', 'v1']);
            expect(valuesOf(second.poll(10))).toEqual(['v0', 'v1']);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.storageAppends',
      op: 'eq',
      value: 1,
      zh: '一条消息三个订阅，存储只写一次',
      en: 'One message with three subscriptions costs one write',
      dimension: 'latency',
      scope: 'gate:fanout',
    }),
  ],
  referenceFiles: [
    file(
      'src/fanout.ts',
      code`
        import type { MessageLog } from './log';
        import type { StoredRecord } from './support/storage';

        export interface SubscribeOptions {
          from?: 'beginning' | 'end';
        }

        export interface Subscription {
          name: string;
          poll(max: number): StoredRecord[];
          commit(offset: number): void;
          seek(offset: number): void;
          position(): number;
          lag(): number;
        }

        export interface Topic {
          publish(key: string, value: string): number;
          subscribe(name: string, options?: SubscribeOptions): Subscription;
          subscriptions(): string[];
          endOffset(): number;
        }

        export function createTopic(log: MessageLog): Topic {
          /** 一个订阅的全部状态就是这里的一个整数 */
          const cursors = new Map<string, number>();

          function positionOf(name: string): number {
            const cursor = cursors.get(name);
            return cursor === undefined ? 0 : cursor;
          }

          function viewOf(name: string): Subscription {
            return {
              name,

              poll(max: number): StoredRecord[] {
                // 只读，不推进：读到不等于处理完
                return log.read(positionOf(name), max);
              },

              commit(offset: number): void {
                const next = offset + 1;
                // 单调前进：乱序到达的旧确认不能把它拽回去
                if (next > positionOf(name)) cursors.set(name, next);
              },

              seek(offset: number): void {
                cursors.set(name, Math.max(0, offset));
              },

              position(): number {
                return positionOf(name);
              },

              lag(): number {
                return Math.max(0, log.endOffset() - positionOf(name));
              },
            };
          }

          return {
            publish(key: string, value: string): number {
              // 整个文件里唯一一处写存储，和订阅数无关
              return log.append(key, value).offset;
            },

            subscribe(name: string, options: SubscribeOptions = {}): Subscription {
              if (!cursors.has(name)) {
                cursors.set(name, options.from === 'end' ? log.endOffset() : 0);
              }
              return viewOf(name);
            },

            subscriptions(): string[] {
              return Array.from(cursors.keys());
            },

            endOffset(): number {
              return log.endOffset();
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
      '**订阅对象是现造的外壳，状态在 `cursors` 里。** 这样「同名订阅共享游标」',
      '不需要缓存对象，也不会出现两个对象各持一份位置的情况。',
      '订阅在这里不是一个实体，是一个视角。',
      '',
      '**`commit` 里那句 `if (next > ...)`。** 三个字符的判断，',
      '决定了这个位置是「一条前缀的边界」还是「最后一次确认的坐标」。',
      '前者在乱序确认下依然自洽，后者会悄悄重投已经处理过的消息。',
      '',
      '**`publish` 只有一行。** 它是整个文件里唯一碰存储的地方 ——',
      '这一点本身就是这一关的结论：扇出的成本应该体现在整数上，不在字节上。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'A subscription object is a shell built on demand; the state lives in `cursors`. Sharing a cursor by',
      'name then needs no object cache and cannot produce two objects each holding their own position. A',
      'subscription here is a viewpoint, not an entity.',
      '',
      'The `if (next > …)` inside `commit`. Three characters decide whether the position means "the boundary',
      'of a completed prefix" or "the coordinate of the last acknowledgement". The first stays coherent under',
      'out-of-order acks; the second quietly redelivers work that was already done.',
      '',
      '`publish` is one line, and it is the only place in the file that touches storage. That fact is the',
      "stage's conclusion: the cost of fan-out belongs in integers, not in bytes.",
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 7 关 · 按 credit 推送                                             */
/* ------------------------------------------------------------------ */

const stage7 = {
  id: 'flow-control',
  title: t('第 7 关 · 按 credit 推送', 'Stage 7 · Pushing on credit'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前几关的消费者都是**拉**：它自己决定什么时候 poll、取几条。',
      '拉模型很安全 —— 消费者永远不会被喂撑，因为它只拿自己要的。',
      '代价是延迟：消息到了，得等下一次 poll 才被发现。',
      '',
      '推模型反过来：消息一到就发给消费者，延迟最低，',
      '但 broker 现在需要回答一个新问题 —— **推多快？**',
      '',
      '推太慢，消费者闲着；推太快，消费者的内存里堆满了还没处理的消息，',
      '最后 OOM —— 而这时候 broker 其实是**帮凶**：它明明看得见对方处理不过来。',
      '',
      '解法是让消费者说了算：它给 broker 一个**额度（credit）**，',
      '说「我还能接 N 条」。broker 只在有额度时推送，处理完一条还一份额度。',
      '这就是 prefetch 流控。',
      '',
      '## 要实现什么',
      '',
      '在 `src/flow.ts` 实现 `createPushEngine(log, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `attach(sink)` | 接一个消费者，初始额度是 `prefetch` |',
      '| `run(from)` | 把日志里从 from 开始的消息全部推完，返回推了多少条 |',
      '| `credits(id)` | 某个消费者当前剩余额度 |',
      '',
      '消费者是一个 `{ id, deliver(record) }`，`deliver` 返回的 Promise',
      '完成时表示这一条处理完了 —— 额度在**那时**才归还。',
      '',
      '## 怎么算过',
      '',
      '- 所有消息都被推完，一条不漏、不重复；',
      '- **任一时刻，一个消费者手里不超过 `prefetch` 条**',
      '  （门槛 `counters.overPrefetch = 0`，由消费者自己数）；',
      '- 2 个消费者、prefetch 各 2、每条处理 100ms、12 条消息：',
      '  总耗时 300ms（门槛 `virtualElapsedMs ≤ 350`）——',
      '  也就是四路并行，不是串行，也不是一次全推出去；',
      '- 慢的消费者不会拖住快的：额度是各算各的；',
      '- **`deliver` 抛错也要归还额度**；',
      '- `run` 的 Promise 在全部处理完之后才 resolve。',
      '',
      '## 那个 300ms 是怎么算出来的',
      '',
      '总额度是 2 个消费者 × 2 = 4，也就是最多 4 条同时在处理。',
      '12 条消息 ÷ 4 = 3 轮，每轮 100ms，共 300ms。',
      '',
      '这个数字同时排除了两种错误实现：',
      '',
      '| 错误做法 | 耗时 |',
      '| --- | --- |',
      '| 一条一条推，等处理完再推下一条 | 1200ms |',
      '| 不看额度，一次全推出去 | 100ms，但消费者手里堆了 12 条 |',
      '',
      '第二种**更快**，而它正是这一关要禁止的事 —— 快，是因为把风险转嫁给了下游。',
      '',
      '## 最容易写错的地方',
      '',
      '推出去就归还额度，而不是等处理完。',
      '',
      '这样 credit 变成了「同时在网络上传输的条数」而不是',
      '「消费者手里未处理的条数」，流控就失去了全部意义：',
      'broker 会以消费者的**接收**速度推送，而不是它的**处理**速度。',
      '两者在消费者变慢时正好背道而驰。',
    ].join('\n'),
    [
      'Consumers so far have **pulled**: they decide when to poll and how many to take. Pulling is safe — a',
      'consumer can never be overfed, because it only ever asks for what it wants. The price is latency: a',
      'message that has arrived waits for the next poll to be noticed.',
      '',
      'Pushing inverts that. Messages go out as they arrive, latency is minimal, and the broker now has a new',
      'question to answer: **how fast?**',
      '',
      'Too slow and the consumer idles. Too fast and the consumer fills up with unprocessed messages and runs',
      'out of memory — with the broker as an **accomplice**, since it could see perfectly well that the other',
      'side was not keeping up.',
      '',
      'The answer is to let the consumer decide: it grants the broker a **credit** — "I can take N more". The',
      'broker pushes only while credit remains, and one credit returns for each message completed. That is',
      'prefetch-based flow control.',
      '',
      '## What to build',
      '',
      'Implement `createPushEngine(log, options)` in `src/flow.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `attach(sink)` | Register a consumer, starting with `prefetch` credits |',
      '| `run(from)` | Push everything from `from` to the end; return how many were pushed |',
      '| `credits(id)` | The credit a consumer has left |',
      '',
      'A consumer is `{ id, deliver(record) }`, and the promise from `deliver` settling means that message is',
      'processed — the credit returns **then**, not before.',
      '',
      '## What counts as passing',
      '',
      '- Every message is pushed exactly once, none lost, none duplicated;',
      '- **No consumer ever holds more than `prefetch` at a time**',
      '  (the `counters.overPrefetch = 0` gate, counted by the consumer itself);',
      '- Two consumers with prefetch 2 each, 100ms per message and 12 messages take 300ms',
      '  (the `virtualElapsedMs ≤ 350` gate) — four in parallel, neither serial nor all at once;',
      '- A slow consumer does not hold up a fast one: credits are per consumer;',
      '- **A rejected `deliver` still returns its credit**;',
      '- The promise from `run` resolves only after everything is processed.',
      '',
      '## Where the 300ms comes from',
      '',
      'Total credit is two consumers times two, so at most four messages are in processing at once. Twelve',
      'messages divided by four is three rounds of 100ms: 300ms.',
      '',
      'That number rules out two wrong implementations at once:',
      '',
      '| Wrong approach | Time |',
      '| --- | --- |',
      '| One at a time, waiting for each to finish | 1200ms |',
      '| Ignore credits and push everything immediately | 100ms, with twelve messages piled in the consumer |',
      '',
      'The second is **faster** — and is exactly what this stage forbids. It is fast because it moved the risk',
      'downstream.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Returning the credit when the message is pushed instead of when it is processed.',
      '',
      'Credit then measures "messages in flight on the wire" rather than "messages the consumer has not',
      'finished", and flow control loses its entire purpose: the broker paces itself against the consumer\'s',
      '**receive** rate instead of its **processing** rate. Those two diverge precisely when the consumer slows',
      'down.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  RUN["run(from)"] --> NEXT["从日志读下一条"]',
      '  NEXT --> EMPTY{"还有消息吗？"}',
      '  EMPTY -- 没有 --> WAITALL["等所有在飞的处理完"]',
      '  EMPTY -- 有 --> PICK["找一个还有额度的消费者"]',
      '  PICK --> FOUND{"找到了吗？"}',
      '  FOUND -- 没有 --> BLOCK["挂起，等有人还额度"]',
      '  BLOCK --> PICK',
      '  FOUND -- 找到 --> DEC["额度减一<br/>游标前进"]',
      '  DEC --> SEND["sink.deliver(record)<br/>不等它完成"]',
      '  SEND --> NEXT',
      '',
      '  SEND --> DONE["deliver 完成或失败"]',
      '  DONE --> INC["额度加一<br/>失败也要还"]',
      '  INC --> WAKE["唤醒一个等额度的推送循环"]',
      '  WAITALL --> RET["返回推送条数"]',
      '```',
      '',
      '要点：`SEND` 之后立刻回到 `NEXT`，不等 deliver 完成 —— 这是并行的来源；',
      '而额度在 `DONE` 之后才还，这是并行**上限**的来源。',
      '两者缺一：不等就还额度，等于没有流控；等完再推，等于串行。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  RUN["run(from)"] --> NEXT["read the next record"]',
      '  NEXT --> EMPTY{"anything left?"}',
      '  EMPTY -- no --> WAITALL["await everything in flight"]',
      '  EMPTY -- yes --> PICK["find a consumer with credit"]',
      '  PICK --> FOUND{"found one?"}',
      '  FOUND -- no --> BLOCK["suspend until credit returns"]',
      '  BLOCK --> PICK',
      '  FOUND -- yes --> DEC["credit - 1<br/>advance the cursor"]',
      '  DEC --> SEND["sink.deliver(record)<br/>without awaiting it"]',
      '  SEND --> NEXT',
      '',
      '  SEND --> DONE["deliver settles, success or failure"]',
      '  DONE --> INC["credit + 1<br/>returned on failure too"]',
      '  INC --> WAKE["wake one waiting push loop"]',
      '  WAITALL --> RET["return the pushed count"]',
      '```',
      '',
      'The point: control returns to `NEXT` right after `SEND` without awaiting delivery — that is where the',
      'parallelism comes from — while the credit returns only at `DONE`, which is where its **ceiling** comes',
      'from. Drop either and you get no flow control, or no parallelism.',
    ].join('\n')
  ),
  checklist: [
    t('额度在处理完成之后才归还', 'Credit returns only after processing'),
    t('推送不等待，靠额度限流', 'Pushing does not await; credit is the limit'),
    t('每个消费者的额度独立', 'Credits are per consumer'),
    t('deliver 失败也要还额度', 'A failed deliver returns its credit too'),
    t('run 在全部完成之后才 resolve', 'run resolves only when everything is done'),
  ],
  pitfalls: [
    t(
      '推出去就把额度还回来。credit 于是衡量的是「在网络上飞的条数」而不是「消费者没处理完的条数」，broker 按接收速度而不是处理速度推送 —— 而消费者变慢时，这两个速度正好背道而驰。',
      'Returning the credit at push time. Credit then measures messages in flight rather than messages unfinished, so the broker paces against the receive rate instead of the processing rate — and those two diverge exactly when the consumer slows down.'
    ),
    t(
      'deliver 抛错时忘了还额度。每失败一次，这个消费者的额度就永久少一份；失败够多次之后它的额度归零，broker 再也不给它推消息 —— 而它其实是活着的。这类「额度泄漏」在生产环境的表现是「某个实例莫名其妙不干活了」。',
      'Forgetting to return the credit when `deliver` throws. Each failure permanently costs that consumer one credit, and after enough failures it reaches zero and the broker stops pushing to a consumer that is perfectly alive. In production this credit leak shows up as "one instance mysteriously stopped working".'
    ),
    t(
      'await 每一次 deliver。流控确实生效了，但并行度永远是 1：prefetch 设成 100 也没用，因为下一条要等上一条处理完才推。这份实现跑起来完全正确，只是慢了一个数量级，而且慢得没有任何报错。',
      'Awaiting every `deliver`. Flow control works and the parallelism is permanently one: a prefetch of 100 changes nothing, because the next push waits for the previous message to finish. The implementation is entirely correct and an order of magnitude slower, silently.'
    ),
    t(
      '所有消费者共用一份全局额度。一个慢消费者会把全局额度占满，快的那些跟着一起停 —— 而流控的目的恰恰是让每个消费者按自己的速度接收。额度必须是每个消费者一份。',
      'Sharing one global credit pool across consumers. One slow consumer occupies it and the fast ones stall with it — while the entire point of flow control is letting each consumer receive at its own pace. Credit is per consumer.'
    ),
  ],
  hints: [
    t(
      '「等额度」可以用一个 resolve 队列实现：没额度时 push 一个 resolve 进去并 await 它，还额度时 shift 出来一个调用它。',
      'Waiting for credit can be a queue of resolve functions: push one and await it when nothing is available, shift and call one when a credit returns.'
    ),
    t(
      '推送出去的 Promise 要收集起来，`run` 最后 `await Promise.all(它们)`。否则 run 会在最后一条还在处理时就返回。',
      'Collect the delivery promises and `await Promise.all` them at the end of `run`; otherwise `run` returns while the last message is still being processed.'
    ),
  ],
  extension: t(
    [
      'AMQP 的 `basic.qos(prefetch_count)` 就是这一关，RabbitMQ 的默认值是',
      '**无限** —— 也就是默认没有流控。这是一个著名的坑：不设 prefetch 的消费者',
      '会在启动瞬间被推来整个队列，内存直接爆掉。官方文档现在建议',
      '「从 100 到 300 开始调」，而正确的值取决于处理一条消息要多久。',
      '',
      'HTTP/2 和 gRPC 用的是同一个思路，只是单位是字节：',
      '`WINDOW_UPDATE` 帧就是「我又能接收这么多字节了」。',
      'TCP 本身的滑动窗口更是这个机制的祖宗 —— 接收方通告窗口大小，',
      '发送方不得超发。所有需要「快的一方不能压垮慢的一方」的地方，',
      '最后都会长成 credit 的形状。',
      '',
      '这一关刻意没做的是**动态额度**：真实系统会根据处理耗时自动调整 prefetch',
      '（处理得快就多给点）。它的难点不在算法，在于「调整的反馈延迟」——',
      '等你观察到消费者变慢，多推的那些消息已经在它手里了。',
    ].join('\n'),
    [
      "AMQP's `basic.qos(prefetch_count)` is this stage, and RabbitMQ's default is **unlimited** — no flow",
      'control at all. It is a well-known trap: a consumer without a prefetch setting is handed the entire',
      'queue on startup and dies of memory exhaustion. The documentation now suggests starting between 100 and',
      '300, and the right value depends on how long one message takes.',
      '',
      'HTTP/2 and gRPC use the same idea in bytes: a `WINDOW_UPDATE` frame says "I can receive this much more".',
      "TCP's sliding window is the ancestor of them all — the receiver advertises a window and the sender may",
      'not exceed it. Anywhere a fast party must not overwhelm a slow one, the shape that grows is credit.',
      '',
      'Deliberately omitted here: **dynamic credit.** Real systems adjust prefetch from observed processing',
      'times, giving more to consumers that keep up. The difficulty is not the algorithm but the feedback',
      'delay — by the time you observe a consumer slowing down, the extra messages are already in its hands.',
    ].join('\n')
  ),
  focus: ['concurrency', 'latency', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/flow.ts',
      code`
        import type { MessageLog } from './log';
        import type { StoredRecord } from './support/storage';

        export interface ConsumerSink {
          id: string;
          /** broker 把消息推给它；Promise 完成时才算处理完 */
          deliver(record: StoredRecord): Promise<void>;
        }

        export interface FlowOptions {
          /** 每个消费者最多同时持有多少条没处理完的消息 */
          prefetch: number;
        }

        export interface PushEngine {
          attach(sink: ConsumerSink): void;
          /** 把从 from 开始的消息全部推完，返回推了多少条 */
          run(from: number): Promise<number>;
          credits(consumerId: string): number;
        }

        export function createPushEngine(log: MessageLog, options: FlowOptions): PushEngine {
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
        import { createPushEngine } from '../src/flow';
        import { createIndexedLog } from '../src/offsetIndex';
        import { createStorage } from '../src/support/storage';
        import { now, sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const PREFETCH = 2;
        const WORK_MS = 100;

        function makeEngine(records: number, prefetch = PREFETCH) {
          const storage = createStorage();
          const log = createIndexedLog(storage, { segmentBytes: 24000, indexInterval: 16 });
          for (let index = 0; index < records; index += 1) {
            log.append('k' + String(index).padStart(3, '0'), 'v' + index);
          }
          return { log, engine: createPushEngine(log, { prefetch }) };
        }

        /** 消费者自己数手里有多少条没处理完 —— 门槛量的就是它 */
        function makeSink(id: string, prefetch: number, workMs = WORK_MS) {
          const seen: number[] = [];
          let holding = 0;
          let peak = 0;

          return {
            id,
            seen,
            peak: () => peak,
            async deliver(record: any): Promise<void> {
              holding += 1;
              peak = Math.max(peak, holding);
              if (holding > prefetch) count('overPrefetch');
              seen.push(record.offset);
              await sleep(workMs);
              holding -= 1;
            },
          };
        }

        describe('阶段7 · 按 credit 推送', () => {
          it('所有消息都推完，一条不漏不重', async () => {
            const context = makeEngine(6);
            const sink = makeSink('c1', PREFETCH);
            context.engine.attach(sink);

            const pushed = await context.engine.run(0);

            expect(pushed).toBe(6);
            expect(sink.seen.slice().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
          });

          it('消费者手里不会超过 prefetch 条', async () => {
            const context = makeEngine(10);
            const sink = makeSink('c1', PREFETCH);
            context.engine.attach(sink);

            await context.engine.run(0);

            expect(sink.peak()).toBeLessThanOrEqual(PREFETCH);
          });

          it('两个消费者四路并行，12 条 300ms [gate:flow]', async () => {
            const context = makeEngine(12);
            const first = makeSink('c1', PREFETCH);
            const second = makeSink('c2', PREFETCH);
            context.engine.attach(first);
            context.engine.attach(second);

            const started = now();
            const pushed = await context.engine.run(0);
            const elapsed = now() - started;

            expect(pushed).toBe(12);
            expect(first.seen.length + second.seen.length).toBe(12);
            expect(elapsed).toBeLessThanOrEqual(WORK_MS * 3 + 50);
            expect(elapsed).toBeGreaterThanOrEqual(WORK_MS * 3);
          });

          it('两个消费者都分到了活', async () => {
            const context = makeEngine(12);
            const first = makeSink('c1', PREFETCH);
            const second = makeSink('c2', PREFETCH);
            context.engine.attach(first);
            context.engine.attach(second);

            await context.engine.run(0);

            expect(first.seen.length).toBeGreaterThan(0);
            expect(second.seen.length).toBeGreaterThan(0);
          });

          it('prefetch 为 1 时每人手里只有一条', async () => {
            const context = makeEngine(4, 1);
            const sink = makeSink('c1', 1);
            context.engine.attach(sink);

            const started = now();
            await context.engine.run(0);

            expect(sink.peak()).toBe(1);
            expect(now() - started).toBe(WORK_MS * 4);
          });

          it('慢消费者不拖住快消费者', async () => {
            const context = makeEngine(10);
            const fast = makeSink('fast', PREFETCH, 10);
            const slow = makeSink('slow', PREFETCH, 500);
            context.engine.attach(fast);
            context.engine.attach(slow);

            await context.engine.run(0);

            // 快的那个应该干掉大部分活
            expect(fast.seen.length).toBeGreaterThan(slow.seen.length);
          });

          it('run 在全部处理完之后才 resolve', async () => {
            const context = makeEngine(4);
            let finished = 0;
            context.engine.attach({
              id: 'c1',
              async deliver(): Promise<void> {
                await sleep(WORK_MS);
                finished += 1;
              },
            });

            await context.engine.run(0);

            expect(finished).toBe(4);
          });

          it('deliver 抛错也要归还额度', async () => {
            const context = makeEngine(6);
            let attempts = 0;
            context.engine.attach({
              id: 'flaky',
              async deliver(): Promise<void> {
                attempts += 1;
                await sleep(10);
                throw new Error('handler blew up');
              },
            });

            const pushed = await context.engine.run(0);

            // 额度泄漏的实现会在推完前 prefetch 条之后永远卡住
            expect(pushed).toBe(6);
            expect(attempts).toBe(6);
            expect(context.engine.credits('flaky')).toBe(PREFETCH);
          });

          it('处理完之后额度回到初始值', async () => {
            const context = makeEngine(5);
            const sink = makeSink('c1', PREFETCH);
            context.engine.attach(sink);

            expect(context.engine.credits('c1')).toBe(PREFETCH);
            await context.engine.run(0);
            expect(context.engine.credits('c1')).toBe(PREFETCH);
          });

          it('可以从中间的 offset 开始推', async () => {
            const context = makeEngine(6);
            const sink = makeSink('c1', PREFETCH);
            context.engine.attach(sink);

            const pushed = await context.engine.run(4);

            expect(pushed).toBe(2);
            expect(sink.seen.slice().sort((a, b) => a - b)).toEqual([4, 5]);
          });

          it('没有消费者时不推也不卡', async () => {
            const context = makeEngine(3);

            expect(await context.engine.run(0)).toBe(0);
          });

          it('日志为空时立刻结束', async () => {
            const context = makeEngine(0);
            context.engine.attach(makeSink('c1', PREFETCH));

            expect(await context.engine.run(0)).toBe(0);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.overPrefetch',
      op: 'eq',
      value: 0,
      zh: '消费者手里一次都没超过 prefetch 条',
      en: 'No consumer ever holds more than its prefetch',
      dimension: 'concurrency',
    }),
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 350,
      zh: '12 条消息四路并行 350ms 内推完',
      en: 'Twelve messages finish within 350ms at four in parallel',
      unit: 'ms',
      dimension: 'latency',
      scope: 'gate:flow',
    }),
  ],
  referenceFiles: [
    file(
      'src/flow.ts',
      code`
        import type { MessageLog } from './log';
        import type { StoredRecord } from './support/storage';

        export interface ConsumerSink {
          id: string;
          deliver(record: StoredRecord): Promise<void>;
        }

        export interface FlowOptions {
          prefetch: number;
        }

        export interface PushEngine {
          attach(sink: ConsumerSink): void;
          run(from: number): Promise<number>;
          credits(consumerId: string): number;
        }

        export function createPushEngine(log: MessageLog, options: FlowOptions): PushEngine {
          const sinks: ConsumerSink[] = [];
          /** 每个消费者一份额度，不是全局一份 */
          const credit = new Map<string, number>();
          /** 没额度时挂在这里的推送循环 */
          const waiting: Array<() => void> = [];

          function creditOf(id: string): number {
            const value = credit.get(id);
            return value === undefined ? 0 : value;
          }

          function pickSink(): ConsumerSink | null {
            const ready = sinks.filter((sink) => creditOf(sink.id) > 0);
            return ready.length > 0 ? ready[0] : null;
          }

          function giveBack(id: string): void {
            credit.set(id, creditOf(id) + 1);
            const next = waiting.shift();
            if (next) next();
          }

          function waitForCredit(): Promise<void> {
            return new Promise<void>((resolve) => {
              waiting.push(resolve);
            });
          }

          return {
            attach(sink: ConsumerSink): void {
              sinks.push(sink);
              credit.set(sink.id, options.prefetch);
            },

            async run(from: number): Promise<number> {
              if (sinks.length === 0) return 0;

              const inFlight: Array<Promise<void>> = [];
              let cursor = from;
              let pushed = 0;

              for (;;) {
                const records = log.read(cursor, 1);
                if (records.length === 0) break;
                const record = records[0];

                let sink = pickSink();
                while (!sink) {
                  await waitForCredit();
                  sink = pickSink();
                }

                credit.set(sink.id, creditOf(sink.id) - 1);
                cursor = record.offset + 1;
                pushed += 1;

                const target = sink;
                // 不等 deliver 完成就继续推下一条：并行度由额度决定，不由 await 决定
                inFlight.push(
                  Promise.resolve()
                    .then(() => target.deliver(record))
                    // 处理失败也要还额度，否则这个消费者的额度会慢慢漏光
                    .catch(() => undefined)
                    .then(() => giveBack(target.id))
                );
              }

              await Promise.all(inFlight);
              return pushed;
            },

            credits(consumerId: string): number {
              return creditOf(consumerId);
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
      '**额度在 `.then` 里归还，而且挂在 `.catch` 后面。** 顺序是',
      '`deliver → catch → giveBack`：无论成功失败都还，而且都在处理**结束之后**还。',
      '把 `giveBack` 挪到 `deliver` 之前，流控就没了；只在成功时还，额度就会漏。',
      '',
      '**推送不 await，只收集 Promise。** 这是并行的唯一来源。',
      '并行度不由这里控制，由额度控制 —— 两件事分开之后，',
      '「调 prefetch」就成了唯一需要调的旋钮。',
      '',
      '**等额度用一个 resolve 队列，而不是轮询。** 轮询（每隔几毫秒看一眼）',
      '也能工作，但它会在虚拟时钟上凭空制造出延迟，而且这份延迟会随着',
      '轮询间隔而变 —— 一个和业务无关的参数就这样影响了系统的吞吐。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'Credit returns inside a `.then` placed after the `.catch`. The order is deliver, catch, give back: on',
      'success and on failure alike, and always **after** processing ends. Move `giveBack` ahead of `deliver`',
      'and flow control disappears; return it only on success and the credit leaks.',
      '',
      'Pushing does not await; it collects promises. That is the only source of parallelism, and the degree of',
      'parallelism is set by credit rather than by control flow. With the two separated, prefetch becomes the',
      'single knob worth turning.',
      '',
      'Waiting for credit uses a queue of resolvers rather than polling. Polling every few milliseconds also',
      'works, and it invents latency out of nothing on the virtual clock — latency that varies with the polling',
      'interval, letting a parameter unrelated to the workload decide the throughput.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 8 关 · 副本同步与高水位                                           */
/* ------------------------------------------------------------------ */

const stage8 = {
  id: 'replication-isr',
  title: t('第 8 关 · 副本同步与高水位', 'Stage 8 · Replicas and the high watermark'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '到现在为止整个系统只有一份数据。这台机器的盘坏了，消息就全没了 ——',
      '而「消息不会丢」正是这类系统存在的理由。',
      '',
      '所以要有副本。加了副本之后，一个新问题立刻出现：',
      '**一条消息写进 leader 之后、副本还没收到之前，它算不算数？**',
      '',
      '如果算，消费者读到了它，然后 leader 挂了、新 leader 上没有这条 ——',
      '消费者「见过」一条从未存在过的消息。这比丢消息更糟：数据出现了分叉。',
      '',
      'Kafka 的答案是**高水位**：只有被足够多副本确认过的位置，才对消费者可见。',
      'leader 上已经写下但还没被确认的那一段，谁也读不到。',
      '',
      '## 要实现什么',
      '',
      '在 `src/replication.ts` 实现 `createReplicatedLog(log, replicas, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `produce(key, value)` | 写 leader，复制给所有副本，**等够 `minInSync` 个确认**才返回 |',
      '| `read(offset, max)` | 只返回高水位以下的记录 |',
      '| `highWatermark()` | 已提交的边界（这个位置本身还不可见） |',
      '| `inSyncReplicas()` | 当前跟得上的副本 id |',
      '| `endOffset()` | leader 上的末尾，可能高于高水位 |',
      '',
      '副本是平台给的（`src/support/replica.ts`），它只做一件事：慢一点地确认。',
      '落后超过 `maxLagRecords` 条的副本被移出 ISR，不再参与高水位的计算。',
      '',
      '高水位的定义是：**至少 `minInSync` 个 ISR 成员都确认过的位置**。',
      '把 ISR 成员的确认位置从大到小排一排，第 `minInSync` 个就是它。',
      '',
      '## 怎么算过',
      '',
      '- **消费者读不到高水位之上的东西**（门槛 `counters.readsAboveWatermark = 0`：',
      '  用例会直接从副本对象上算出「真正被 quorum 确认到哪儿」再对照）；',
      '- 高水位**只会前进，不会后退**；',
      '- 掉队的副本被踢出 ISR，**并且不拖慢写入**：3 个副本（其中一个慢 5 倍）、',
      '  `minInSync` 为 2、写 5 条，总耗时 50ms 上下',
      '  （门槛 `virtualElapsedMs ≤ 60`）；',
      '- 副本追上之后重新进 ISR；',
      '- `endOffset` 可以高于 `highWatermark` —— 这正是「写下了但还没提交」。',
      '',
      '## 为什么等「足够多」而不是「全部」',
      '',
      '等全部意味着**最慢的那个副本决定整个集群的写入延迟**。',
      '一台机器的磁盘变慢，整个 topic 的写入跟着变慢；那台机器彻底挂掉，',
      '写入直接停止 —— 而你明明还有两台好的。',
      '',
      '等一部分（quorum）用一点点持久性换来了可用性：',
      '`minInSync` 个副本确认过的数据，在少于 `minInSync` 台机器同时故障时不会丢。',
      '这个参数就是「你愿意为多快付出多少风险」的旋钮。',
      '',
      '## 最容易写错的地方',
      '',
      '高水位取「所有副本里最靠前的那个」。',
      '',
      '听起来更积极 —— 有副本确认了就往前推。但那等于把 quorum 降成了 1：',
      '只有一台机器持有的数据被判成了已提交。leader 一挂，新 leader 上',
      '根本没有那段数据，而消费者已经读过它了。',
      '',
      '高水位必须往**排序之后的第 `minInSync` 位**去取 —— 它衡量的是',
      '「有多少份拷贝」，不是「跑得最快的那份到哪儿了」。',
    ].join('\n'),
    [
      'Everything so far lives on one copy. The disk on this machine dies and every message goes with it —',
      'while "messages are not lost" is the reason this kind of system exists.',
      '',
      'So there are replicas. And with replicas comes a new question: **does a record written to the leader',
      'but not yet received by any replica count?**',
      '',
      'If it does, a consumer reads it, the leader dies, the new leader does not have it — and the consumer has',
      '"seen" a message that never existed. That is worse than losing a message: the data has forked.',
      '',
      "Kafka's answer is the **high watermark**: only positions acknowledged by enough replicas are visible to",
      'consumers. The stretch already written on the leader but not yet acknowledged is invisible to everyone.',
      '',
      '## What to build',
      '',
      'Implement `createReplicatedLog(log, replicas, options)` in `src/replication.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `produce(key, value)` | Write the leader, replicate, and return once **`minInSync` have acked** |',
      '| `read(offset, max)` | Return only records below the high watermark |',
      '| `highWatermark()` | The committed boundary (that position itself is not yet visible) |',
      '| `inSyncReplicas()` | The ids of replicas keeping up |',
      '| `endOffset()` | The end of the leader log, which may be beyond the watermark |',
      '',
      'Replicas come from the platform (`src/support/replica.ts`) and do one thing: acknowledge, slowly. A',
      'replica more than `maxLagRecords` behind leaves the ISR and stops counting toward the watermark.',
      '',
      '## What counts as passing',
      '',
      '- **Consumers cannot read past the high watermark** (the `counters.readsAboveWatermark = 0` gate: the',
      '  specs compute the truly quorum-acknowledged position from the replica objects and compare);',
      '- The high watermark **only moves forward**;',
      '- A lagging replica leaves the ISR **and does not slow writes down**: three replicas, one five times',
      '  slower, `minInSync` of 2, five records, about 50ms total (the `virtualElapsedMs ≤ 60` gate);',
      '- A replica that catches up rejoins the ISR;',
      '- `endOffset` may exceed `highWatermark` — that gap is "written but not committed".',
      '',
      '## Why "enough" rather than "all"',
      '',
      'Waiting for all means **the slowest replica decides the write latency of the whole cluster.** One',
      "machine's disk gets slow and every write to the topic slows with it; that machine dies and writes stop",
      'entirely — while two healthy machines sit there.',
      '',
      'Waiting for a quorum trades a little durability for availability: data acknowledged by `minInSync`',
      'replicas survives the simultaneous loss of fewer than `minInSync` machines. That parameter is the knob',
      'for "how much risk are you buying speed with".',
      '',
      '## The easiest thing to get wrong',
      '',
      'Taking the high watermark as the furthest-ahead replica.',
      '',
      'It sounds more eager — someone acknowledged it, so move forward. It also silently reduces the quorum to',
      'one: data held by a single machine is treated as committed. The leader dies, the new leader never had',
      'that stretch, and consumers have already read it.',
      '',
      'The watermark has to come from the **`minInSync`-th position after sorting** — it measures how many',
      'copies exist, not how far the fastest copy got.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  P["produce(key, value)"] --> APP["log.append 写 leader<br/>此刻它还不可见"]',
      '  APP --> FAN["同时发给所有副本<br/>不是逐个等"]',
      '  FAN --> Q["等够 minInSync 个确认<br/>慢的那个不参与决定"]',
      '  Q --> RECALC["重算高水位"]',
      '  RECALC --> RET["返回 offset"]',
      '',
      '  RECALC --> ISR["先算 ISR：<br/>确认位置离 leader 末尾不超过 maxLagRecords"]',
      '  ISR --> MIN["ISR 的确认位置从大到小排<br/>取第 minInSync 个"]',
      '  MIN --> MONO["高水位 = max(旧值, 这个位置 + 1)<br/>只前进，不后退"]',
      '',
      '  R["read(offset, max)"] --> CLAMP["把 max 压到高水位以内"]',
      '  CLAMP --> ZERO{"还剩几条可读？"}',
      '  ZERO -- 0 条 --> NONE["返回空数组"]',
      '  ZERO -- 有 --> DELEG["log.read(offset, 压过的 max)"]',
      '```',
      '',
      '要点：可见性是在 `read` 的入口用一个 `Math.min` 实现的，',
      '而不是读出来之后再过滤。这两种写法结果相同，但前者让',
      '「高水位之上的数据永远不会离开这个模块」成为一件结构上的事实。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  P["produce(key, value)"] --> APP["log.append writes the leader<br/>invisible at this moment"]',
      '  APP --> FAN["send to every replica at once<br/>not one after another"]',
      '  FAN --> Q["await minInSync acks<br/>the slow one does not decide"]',
      '  Q --> RECALC["recompute the watermark"]',
      '  RECALC --> RET["return the offset"]',
      '',
      '  RECALC --> ISR["compute the ISR first:<br/>acked within maxLagRecords of the leader end"]',
      '  ISR --> MIN["sort ISR acked positions descending<br/>take the minInSync-th"]',
      '  MIN --> MONO["watermark = max(old, that + 1)<br/>forward only"]',
      '',
      '  R["read(offset, max)"] --> CLAMP["clamp max to the watermark"]',
      '  CLAMP --> ZERO{"anything readable left?"}',
      '  ZERO -- none --> NONE["return an empty array"]',
      '  ZERO -- some --> DELEG["log.read(offset, clamped max)"]',
      '```',
      '',
      'The point: visibility is a `Math.min` at the entrance of `read`, not a filter applied to what came back.',
      'Both give the same answer, and the first makes "data above the watermark never leaves this module" a',
      'structural fact.',
    ].join('\n')
  ),
  checklist: [
    t('高水位取第 minInSync 高的确认位置', 'The watermark is the minInSync-th acked position'),
    t('高水位只前进不后退', 'The watermark only moves forward'),
    t('复制并行发出，等够 quorum 即可', 'Replication fans out and waits for a quorum'),
    t('掉队副本移出 ISR', 'A lagging replica leaves the ISR'),
    t('可见性在读入口处限制', 'Visibility is enforced at the read entrance'),
  ],
  pitfalls: [
    t(
      '高水位取所有副本里最靠前的位置。它把「只有一个副本收到」的数据判成了已提交，等于偷偷把 quorum 降成了 1；leader 一挂这段数据就不存在了，而消费者已经读过。高水位衡量的是拷贝数，所以要取排序之后的第 minInSync 位。',
      'Taking the watermark as the furthest-ahead replica. Data held by exactly one replica becomes committed, quietly reducing the quorum to one; the leader dies, that stretch never existed, and consumers already read it. The watermark measures how many copies exist, so it is the minInSync-th position after sorting.'
    ),
    t(
      '逐个 await 每个副本。三个副本各 10ms，写入延迟就是 30ms 而不是 10ms —— 而且这个代价随副本数线性增长，加副本变成了「更安全但更慢」的单调交易。并行发出、只等 quorum，才让副本数和延迟脱钩。',
      'Awaiting replicas one at a time. Three replicas at 10ms each make write latency 30ms instead of 10ms, and the cost grows linearly with the replica count, turning "add a replica" into a strictly slower trade. Fanning out and waiting for a quorum is what decouples replica count from latency.'
    ),
    t(
      '等所有副本都确认。持久性确实最高，代价是最慢的副本决定整个集群的写入延迟，而一台机器挂掉就等于写入停止。ISR 这个概念存在的全部理由，就是把「掉队的成员」从决策集合里摘出去。',
      'Waiting for every replica. Durability is maximal and the slowest replica dictates cluster write latency, while one dead machine stops writes altogether. The entire reason the ISR concept exists is to remove stragglers from the decision set.'
    ),
    t(
      '让高水位跟着 ISR 收缩而后退。副本掉队时 ISR 变小，如果直接按新集合重算，高水位可能算出一个比之前小的值 —— 而消费者已经读过那一段了。「读到过的东西又变成不可见」会让消费位置彻底失去意义。',
      'Letting the watermark shrink when the ISR does. A smaller ISR can recompute to a smaller value — after consumers have read that stretch. "Something already read becomes invisible again" destroys the meaning of a consumer position.'
    ),
  ],
  hints: [
    t(
      '「等够 N 个」可以自己写一个小函数：给每个 send 的 Promise 挂一个计数器，数到 N 就 resolve 外层的 Promise。注意 N 不能大于副本数，否则会永远等下去。',
      'Write a small "wait for N" helper: attach a counter to each send promise and resolve the outer one when it reaches N. Guard N against the replica count, or it waits forever.'
    ),
    t(
      '副本对象上的 `ackedOffset()` 返回的是「已确认到的位置（含）」，所以「确认了几条」是它加一。高水位用的是后者。',
      '`ackedOffset()` returns the last position acknowledged, inclusive, so the count of acknowledged records is that plus one. The watermark uses the latter.'
    ),
  ],
  extension: t(
    [
      'Kafka 的 `acks` 参数就是这一关的 `minInSync`：`acks=0`（不等）、',
      '`acks=1`（只等 leader）、`acks=all`（等所有 ISR 成员）。',
      '注意 `acks=all` 等的是**ISR**而不是所有副本 —— 掉队的副本已经被摘出去了，',
      '所以它并不会因为一台慢机器而卡住。',
      '',
      '与之配套的是 `min.insync.replicas`：ISR 小于这个数时，broker 直接拒绝写入。',
      '这两个参数一起才有意义 —— 只设 `acks=all` 而不设后者，',
      'ISR 缩到只剩 leader 一个时，`acks=all` 就退化成了 `acks=1`，',
      '而你以为自己开着最高级别的持久性。这是 Kafka 配置里最经典的误解。',
      '',
      '高水位还有一个这一关没做的用途：**leader 切换时的日志截断**。',
      '新 leader 上任后，其他副本要把自己高水位之上的部分砍掉，',
      '因为那部分数据可能和新 leader 的不一致。',
      'Kafka 早期版本在这里出过数据丢失的 bug，后来引入 leader epoch 才修好 ——',
      '光有高水位不够，还要知道「这段数据是哪一任 leader 写的」。',
    ].join('\n'),
    [
      "Kafka's `acks` parameter is this stage's `minInSync`: `acks=0` waits for nothing, `acks=1` waits for the",
      'leader, `acks=all` waits for every member of the **ISR** — not every replica, since stragglers have',
      'already been removed, which is why one slow machine does not stall it.',
      '',
      'Its partner is `min.insync.replicas`: when the ISR falls below that number the broker refuses writes.',
      'The two only mean something together — set `acks=all` without it and, once the ISR shrinks to the leader',
      'alone, `acks=all` degenerates into `acks=1` while you believe you are running maximum durability. It is',
      'the most classic misconfiguration in Kafka.',
      '',
      'The watermark has one more use this stage skips: **log truncation on leader change.** A new leader takes',
      'over and the other replicas cut off everything above their watermark, since that data may disagree with',
      'the new leader. Early Kafka lost data here, and the fix was the leader epoch — a watermark alone is not',
      'enough, you also need to know which leader wrote that stretch.',
    ].join('\n')
  ),
  focus: ['resilience', 'latency', 'correctness'],
  lab: {},
  starterFiles: [
    file(
      'src/replication.ts',
      code`
        import type { MessageLog } from './log';
        import { RECORD_HEADER_BYTES } from './support/storage';
        import type { StoredRecord } from './support/storage';
        import type { Replica } from './support/replica';

        export interface ReplicationOptions {
          /** 落后超过这么多条就移出 ISR */
          maxLagRecords: number;
          /** 至少要有几个副本确认才算提交 */
          minInSync: number;
        }

        export interface ReplicatedLog {
          /** 写 leader 并复制；等够 minInSync 个确认才 resolve */
          produce(key: string, value: string): Promise<number>;
          /** 只返回高水位以下的记录 */
          read(offset: number, max: number): StoredRecord[];
          /** 已提交的边界：这个位置本身还不可见 */
          highWatermark(): number;
          inSyncReplicas(): string[];
          /** leader 的末尾，可能高于高水位 */
          endOffset(): number;
        }

        export function createReplicatedLog(
          log: MessageLog,
          replicas: Replica[],
          options: ReplicationOptions
        ): ReplicatedLog {
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
        import { createReplicatedLog } from '../src/replication';
        import { createIndexedLog } from '../src/offsetIndex';
        import { createStorage } from '../src/support/storage';
        import { createReplica } from '../src/support/replica';
        import { now, sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const FAST_LAG = 10;
        const SLOW_LAG = 50;
        const MIN_IN_SYNC = 2;
        const MAX_LAG_RECORDS = 2;

        function makeCluster() {
          const storage = createStorage();
          const log = createIndexedLog(storage, { segmentBytes: 24000, indexInterval: 16 });
          const replicas = [
            createReplica('r1', { lagMs: FAST_LAG }),
            createReplica('r2', { lagMs: FAST_LAG }),
            createReplica('r3', { lagMs: SLOW_LAG }),
          ];
          const replicated = createReplicatedLog(log, replicas, {
            maxLagRecords: MAX_LAG_RECORDS,
            minInSync: MIN_IN_SYNC,
          });
          return { log, replicas, replicated };
        }

        /** 直接从副本对象上算：至少 minInSync 个副本确认到了哪儿 */
        function quorumBound(replicas: any[], minInSync: number): number {
          const acked = replicas
            .map((replica) => replica.ackedOffset())
            .sort((left, right) => right - left);
          return acked[minInSync - 1] + 1;
        }

        describe('阶段8 · 副本同步与高水位', () => {
          it('写进去并被确认之后就可以读到', async () => {
            const context = makeCluster();

            expect(await context.replicated.produce('k0', 'v0')).toBe(0);

            expect(context.replicated.highWatermark()).toBe(1);
            expect(context.replicated.read(0, 10)).toHaveLength(1);
          });

          it('消费者读不到高水位之上的数据', async () => {
            const context = makeCluster();
            context.replicas[2].stall(10000);

            await context.replicated.produce('k0', 'v0');
            await context.replicated.produce('k1', 'v1');

            const bound = quorumBound(context.replicas, MIN_IN_SYNC);
            for (const record of context.replicated.read(0, 100)) {
              if (record.offset >= bound) count('readsAboveWatermark');
            }

            expect(context.replicated.highWatermark()).toBeLessThanOrEqual(bound);
            expect(context.replicated.endOffset()).toBe(2);
          });

          it('掉队的副本不拖慢写入 [gate:isr]', async () => {
            const context = makeCluster();

            const started = now();
            for (let index = 0; index < 5; index += 1) {
              await context.replicated.produce('k' + index, 'v' + index);
            }
            const elapsed = now() - started;

            // 只等两个快副本：5 条 50ms，而不是 250ms
            expect(elapsed).toBeLessThanOrEqual(FAST_LAG * 5 + 10);
            expect(context.replicated.endOffset()).toBe(5);
          });

          it('落后太多的副本被移出 ISR', async () => {
            const context = makeCluster();
            context.replicas[2].stall(10000);

            for (let index = 0; index < 5; index += 1) {
              await context.replicated.produce('k' + index, 'v' + index);
            }

            expect(context.replicated.inSyncReplicas()).toEqual(['r1', 'r2']);
          });

          it('副本追上之后重新进 ISR', async () => {
            const context = makeCluster();
            context.replicas[2].stall(400);
            for (let index = 0; index < 5; index += 1) {
              await context.replicated.produce('k' + index, 'v' + index);
            }
            expect(context.replicated.inSyncReplicas()).toHaveLength(2);

            context.replicas[2].resume();
            await context.replicated.produce('k9', 'v9');
            await context.replicated.produce('k10', 'v10');
            // 给它一点时间把新的确认送回来
            await sleep(SLOW_LAG * 4);

            expect(context.replicated.inSyncReplicas()).toHaveLength(3);
          });

          it('高水位只前进不后退', async () => {
            const context = makeCluster();
            for (let index = 0; index < 3; index += 1) {
              await context.replicated.produce('k' + index, 'v' + index);
            }
            const before = context.replicated.highWatermark();

            // 一个副本掉队，ISR 变小，但已经提交过的位置不能反悔
            context.replicas[1].stall(10000);
            await context.replicated.produce('k3', 'v3');

            expect(context.replicated.highWatermark()).toBeGreaterThanOrEqual(before);
          });

          it('endOffset 可以高于高水位', async () => {
            const context = makeCluster();
            context.replicas[1].stall(200);
            context.replicas[2].stall(200);

            // 只有一个快副本确认，达不到 minInSync 之前这条就是「写下了但没提交」
            const pending = context.replicated.produce('k0', 'v0');
            expect(context.replicated.endOffset()).toBe(1);
            expect(context.replicated.highWatermark()).toBe(0);

            await pending;
            expect(context.replicated.highWatermark()).toBe(1);
          });

          it('读的内容正确，并且受高水位限制', async () => {
            const context = makeCluster();
            for (let index = 0; index < 4; index += 1) {
              await context.replicated.produce('k' + index, 'v' + index);
            }

            const records = context.replicated.read(1, 2);
            expect(records.map((record: any) => record.value)).toEqual(['v1', 'v2']);
          });

          it('从高水位之上开始读返回空数组', async () => {
            const context = makeCluster();
            await context.replicated.produce('k0', 'v0');

            const bound = quorumBound(context.replicas, MIN_IN_SYNC);
            const records = context.replicated.read(context.replicated.highWatermark(), 10);
            for (const record of records) {
              if (record.offset >= bound) count('readsAboveWatermark');
            }
            expect(records).toEqual([]);
          });

          it('每个副本都收到了数据', async () => {
            const context = makeCluster();
            for (let index = 0; index < 3; index += 1) {
              await context.replicated.produce('k' + index, 'v' + index);
            }

            // 慢副本也在收，只是晚一点
            expect(context.replicas[0].ackedOffset()).toBe(2);
            await sleep(SLOW_LAG * 2);
            expect(context.replicas[2].ackedOffset()).toBe(2);
          });

          it('刚开始时高水位是 0，读不到任何东西', () => {
            const context = makeCluster();

            expect(context.replicated.highWatermark()).toBe(0);
            expect(context.replicated.read(0, 10)).toEqual([]);
            expect(context.replicated.inSyncReplicas()).toHaveLength(3);
          });

          it('minInSync 为 1 时只等最快的那个', async () => {
            const storage = createStorage();
            const log = createIndexedLog(storage, { segmentBytes: 24000, indexInterval: 16 });
            const replicas = [createReplica('a', { lagMs: FAST_LAG }), createReplica('b', { lagMs: SLOW_LAG })];
            const replicated = createReplicatedLog(log, replicas, {
              maxLagRecords: MAX_LAG_RECORDS,
              minInSync: 1,
            });

            const started = now();
            await replicated.produce('k0', 'v0');

            expect(now() - started).toBe(FAST_LAG);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.readsAboveWatermark',
      op: 'eq',
      value: 0,
      zh: '一条高水位之上的记录都没被读出去',
      en: 'Not one record above the watermark is ever served',
      dimension: 'correctness',
    }),
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 60,
      zh: '掉队副本不拖慢写入：5 条 60ms 内完成',
      en: 'A lagging replica does not slow writes: five records within 60ms',
      unit: 'ms',
      dimension: 'latency',
      scope: 'gate:isr',
    }),
  ],
  referenceFiles: [
    file(
      'src/replication.ts',
      code`
        import type { MessageLog } from './log';
        import { RECORD_HEADER_BYTES } from './support/storage';
        import type { StoredRecord } from './support/storage';
        import type { Replica } from './support/replica';

        export interface ReplicationOptions {
          maxLagRecords: number;
          minInSync: number;
        }

        export interface ReplicatedLog {
          produce(key: string, value: string): Promise<number>;
          read(offset: number, max: number): StoredRecord[];
          highWatermark(): number;
          inSyncReplicas(): string[];
          endOffset(): number;
        }

        /** 等够 needed 个 Promise 完成就返回，不等剩下的 */
        function waitForQuorum(tasks: Array<Promise<void>>, needed: number): Promise<void> {
          const target = Math.min(needed, tasks.length);
          if (target <= 0) return Promise.resolve();

          return new Promise<void>((resolve) => {
            let acked = 0;
            for (const task of tasks) {
              task.then(() => {
                acked += 1;
                if (acked === target) resolve();
              });
            }
          });
        }

        export function createReplicatedLog(
          log: MessageLog,
          replicas: Replica[],
          options: ReplicationOptions
        ): ReplicatedLog {
          let watermark = 0;

          function inSync(): Replica[] {
            const end = log.endOffset();
            return replicas.filter((replica) => replica.ackedOffset() + 1 >= end - options.maxLagRecords);
          }

          function recompute(): void {
            const members = inSync();
            // ISR 成员不够，就没有「被足够多副本持有」的新位置可言
            if (members.length < options.minInSync) return;

            // 从大到小排，第 minInSync 个就是「至少这么多份拷贝都有」的位置
            const acked = members
              .map((replica) => replica.ackedOffset())
              .sort((left, right) => right - left);
            const committed = acked[options.minInSync - 1];
            const candidate = Math.min(log.endOffset(), committed + 1);

            // 只前进：ISR 收缩不能让已经提交过的位置反悔
            watermark = Math.max(watermark, candidate);
          }

          return {
            async produce(key: string, value: string): Promise<number> {
              const appended = log.append(key, value);
              const record: StoredRecord = {
                offset: appended.offset,
                key,
                value,
                size: RECORD_HEADER_BYTES + key.length + value.length,
              };

              // 并行发出去，副本数不影响延迟；晚到的确认同样推进高水位
              const sends = replicas.map((replica) =>
                replica.send([record]).then(() => {
                  recompute();
                })
              );
              await waitForQuorum(sends, options.minInSync);

              recompute();
              return appended.offset;
            },

            read(offset: number, max: number): StoredRecord[] {
              // 可见性在入口处限制，高水位之上的数据不会离开这个模块
              const room = Math.min(max, watermark - offset);
              if (room <= 0) return [];
              return log.read(offset, room);
            },

            highWatermark(): number {
              return watermark;
            },

            inSyncReplicas(): string[] {
              return inSync().map((replica) => replica.id);
            },

            endOffset(): number {
              return log.endOffset();
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
      '**高水位是排序之后的第 `minInSync` 位，不是最小值也不是最大值。** 取最小值',
      '（ISR 里最慢的那个）在 `minInSync` 等于 ISR 大小时才等价，否则会让',
      '一个还没被踢出 ISR 的慢副本白白压住可见性；取最大值则等于把 quorum 降成 1。',
      '',
      '**`Math.max(watermark, candidate)` 那一句。** 高水位单调是一条硬约束：',
      'ISR 会随时收缩，按新集合重算完全可能得到一个更小的值，',
      '而消费者已经读过那一段了。「已经承诺过的事不能反悔」在分布式系统里',
      '通常都要靠这样一句显式的单调保护来实现。',
      '',
      '**`waitForQuorum` 不取消剩下的请求。** 慢副本的 send 仍然在跑，',
      '它迟早会确认、迟早会重新进 ISR。「不等它」和「不要它」是两回事 ——',
      '把慢副本的复制取消掉，它就永远追不上了。',
      '',
      '**可见性在 `read` 的第一行用 `Math.min` 表达。** 另一种写法是',
      '「先 log.read 再 filter 掉高水位之上的」，结果一样。',
      '但前者让这个模块在结构上不可能把未提交的数据交出去 ——',
      '而后者只是这一次没交出去。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'The watermark is the minInSync-th position after sorting, neither the minimum nor the maximum. The',
      'minimum is equivalent only when minInSync equals the ISR size, and otherwise lets a slow replica that',
      'has not yet left the ISR hold visibility back for nothing; the maximum reduces the quorum to one.',
      '',
      'The `Math.max(watermark, candidate)` line. Monotonicity is a hard constraint: the ISR shrinks at any',
      'time and recomputing over a smaller set can easily produce a smaller value — after consumers read that',
      'stretch. "A promise already made cannot be taken back" is usually implemented in distributed systems by',
      'exactly this kind of explicit guard.',
      '',
      '`waitForQuorum` does not cancel the remaining requests. The slow replica\'s send keeps running and it',
      'will eventually acknowledge and rejoin the ISR. "Not waiting for it" and "not wanting it" are different',
      'things — cancel its replication and it can never catch up.',
      '',
      'Visibility is a `Math.min` on the first line of `read`. The alternative — read from the log and filter',
      'out anything above the watermark — returns the same answer. The first makes it structurally impossible',
      'for this module to hand out uncommitted data; the second merely did not, this time.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 9 关 · 保留与压缩                                                 */
/* ------------------------------------------------------------------ */

const stage9 = {
  id: 'retention-compaction',
  title: t('第 9 关 · 保留与压缩', 'Stage 9 · Retention and compaction'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '追加写日志有一个前八关都在回避的问题：**它只会变大。**',
      '磁盘是有限的，所以迟早要删东西。而「删什么」有两种完全不同的答案，',
      '对应两种完全不同的用途：',
      '',
      '| 策略 | 删什么 | 适合什么 |',
      '| --- | --- | --- |',
      '| **保留（retention）** | 太老或超出容量的**整段** | 事件流：三天前的点击日志没人要了 |',
      '| **压缩（compaction）** | 同一个 key 被后来者覆盖的**旧版本** | 状态流：每个用户的最新资料要一直留着 |',
      '',
      '保留会删掉活数据（那一段里所有 key 都没了），压缩不会 ——',
      '它保证**每个 key 的最后一条永远在**。用途不同，不是谁比谁强。',
      '',
      '## 要实现什么',
      '',
      '在 `src/retention.ts` 实现 `createLogKeeper(log, storage, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `append(key, value)` | 转发给日志，同时记下新段的创建时刻 |',
      '| `enforce()` | 按 `maxBytes` 与 `maxAgeMs` 删掉旧段，返回删了几个 |',
      '| `compact()` | 每个 key 只留最后一条，返回 `{ removed, kept }` |',
      '| `live()` | 当前每个 key 的最后一条，按 offset 升序 |',
      '| `latest(key)` | 某个 key 的最后一条 |',
      '| `bytes()` | 当前占用字节数 |',
      '',
      '**活动段（最后一个段）既不删也不压缩** —— 它还在被写。',
      '',
      '## 怎么算过',
      '',
      '- 压缩之后每个 key 的最后一条都还在',
      '  （门槛 `counters.liveKeysLost = 0`）；',
      '- 压缩之后字节数下降，重复压缩是幂等的；',
      '- 100 条记录、`maxBytes` 为 500 时，`enforce()` 之后占用降到 500 以内',
      '  （门槛 `counters.bytesRetained ≤ 500`）；',
      '- 超过 `maxAgeMs` 的段被删掉，即使容量还够；',
      '- 活动段永远不被删；',
      '- 保留删掉的段里的 key 确实找不到了 —— 这正是它和压缩的区别。',
      '',
      '## 压缩之后 offset 会有空洞',
      '',
      '压缩把幸存的记录搬进一个新段、删掉旧段，而幸存者保留着**原来的 offset**。',
      '于是日志里出现了空洞：0、5、9、10……中间那些 offset 不再存在。',
      '',
      '这不是缺陷，是压缩型日志的固有性质。它也解释了这类 topic 的用法：',
      '按 key 取最新值，而不是按 offset 逐条遍历。',
      '（真按 offset 读也可以，只是要允许「这个 offset 已经没了」。）',
      '',
      '## 最容易写错的地方',
      '',
      '压缩时只看被压的那几个段，不看活动段。',
      '',
      '一个 key 的最后一条如果刚写在活动段里，那么旧段里的所有版本都是死的 ——',
      '可如果你只在旧段范围内找「最后一条」，就会把旧段里的那一条当成最新的留下来。',
      '结果是压缩之后这个 key 有两条记录，而且**旧的排在后面**：',
      '任何「取最后一条」的读法都会读到已经被覆盖的旧值。',
    ].join('\n'),
    [
      'An append-only log has a problem the first eight stages avoided: **it only grows.** Disks are finite, so',
      'something eventually has to go. And "what to delete" has two entirely different answers serving two',
      'entirely different purposes:',
      '',
      '| Policy | Deletes | Suits |',
      '| --- | --- | --- |',
      '| **Retention** | Whole segments that are too old or over the size budget | Event streams: nobody wants clicks from three days ago |',
      '| **Compaction** | Older versions of a key that a newer record superseded | State streams: the latest profile of every user must persist |',
      '',
      'Retention deletes live data (every key in that segment goes with it); compaction never does — it',
      'guarantees **the last record of every key survives.** Different purposes, not better and worse.',
      '',
      '## What to build',
      '',
      'Implement `createLogKeeper(log, storage, options)` in `src/retention.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `append(key, value)` | Forward to the log and note when new segments were created |',
      '| `enforce()` | Delete old segments by `maxBytes` and `maxAgeMs`; return how many |',
      '| `compact()` | Keep only the last record per key; return `{ removed, kept }` |',
      '| `live()` | The current last record of every key, ordered by offset |',
      '| `latest(key)` | The last record for one key |',
      '| `bytes()` | Current bytes on the device |',
      '',
      '**The active segment (the last one) is neither deleted nor compacted** — it is still being written.',
      '',
      '## What counts as passing',
      '',
      '- After compaction, the last record of every key is still there',
      '  (the `counters.liveKeysLost = 0` gate);',
      '- Compaction shrinks the byte count and running it twice changes nothing;',
      '- With 100 records and `maxBytes` of 500, `enforce()` brings usage under 500',
      '  (the `counters.bytesRetained ≤ 500` gate);',
      '- Segments older than `maxAgeMs` go even when there is room to spare;',
      '- The active segment is never deleted;',
      '- Keys in a segment retention deleted really are gone — which is the difference from compaction.',
      '',
      '## Compaction leaves holes in the offsets',
      '',
      'Compaction copies survivors into a new segment and deletes the old ones, and survivors keep their',
      '**original offsets.** The log therefore develops holes: 0, 5, 9, 10… and the offsets between no longer',
      'exist.',
      '',
      'That is not a defect, it is what a compacted log is. It also explains how such topics are used: look up',
      'the latest value by key rather than walking offset by offset. (Reading by offset still works, as long as',
      'you accept that an offset may simply be gone.)',
      '',
      '## The easiest thing to get wrong',
      '',
      'Compacting the sealed segments while ignoring the active one.',
      '',
      'If the newest record for a key was just written into the active segment, then every version in the older',
      'segments is dead — but searching for "the last one" within the old segments alone keeps one of them. The',
      'key now has two records after compaction, and **the stale one comes later in the file**: any "take the',
      'last one" read returns a value that was already overwritten.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**追加** —— 顺手记下新段的生日',
      '',
      '```mermaid',
      'flowchart TD',
      '  AP["append(key, value)"] --> FWD["log.append 转发"]',
      '  FWD --> NEWSEG{"落进了一个没见过的段？"}',
      '  NEWSEG -- 是 --> STAMP["记下这个段的创建时刻"]',
      '  NEWSEG -- 否 --> SKIP["什么都不用做"]',
      '```',
      '',
      '**保留** —— 按段删，从最老的开始',
      '',
      '```mermaid',
      'flowchart TD',
      '  EN["enforce()"] --> LIST["取段列表，去掉最后一个活动段"]',
      '  LIST --> LOOP["从最老的开始逐个看"]',
      '  LOOP --> OLD{"超过 maxAgeMs？"}',
      '  OLD -- 是 --> DEL["deleteSegment"]',
      '  OLD -- 否 --> BIG{"总字节数还超 maxBytes？"}',
      '  BIG -- 是 --> DEL',
      '  BIG -- 否 --> STOP["后面的更新更小，停"]',
      '  DEL --> LOOP',
      '```',
      '',
      '**压缩** —— 看全局，只动封存段',
      '',
      '```mermaid',
      'flowchart TD',
      '  CP["compact()"] --> SCAN["扫全部段（含活动段）<br/>记下每个 key 最后出现的 offset"]',
      '  SCAN --> PICK["在**非活动段**里挑出<br/>offset 等于该 key 最后一条的记录"]',
      '  PICK --> NEW["createSegment 写进幸存者<br/>offset 原样保留"]',
      '  NEW --> DROP["删掉所有被压缩的旧段"]',
      '```',
      '',
      '要点：`SCAN` 覆盖**全部**段，`PICK` 只在非活动段里选。',
      '两个范围不一样 —— 「谁是最新的」要看全局，「能动谁」只限于封存的段。',
    ].join('\n'),
    [
      '**Appending** — note the birthday of a new segment',
      '',
      '```mermaid',
      'flowchart TD',
      '  AP["append(key, value)"] --> FWD["forward to log.append"]',
      '  FWD --> NEWSEG{"landed in a segment we have not seen?"}',
      '  NEWSEG -- yes --> STAMP["stamp its creation time"]',
      '  NEWSEG -- no --> SKIP["nothing to do"]',
      '```',
      '',
      '**Retention** — delete whole segments, oldest first',
      '',
      '```mermaid',
      'flowchart TD',
      '  EN["enforce()"] --> LIST["list segments, drop the active one"]',
      '  LIST --> LOOP["walk from the oldest"]',
      '  LOOP --> OLD{"older than maxAgeMs?"}',
      '  OLD -- yes --> DEL["deleteSegment"]',
      '  OLD -- no --> BIG{"still over maxBytes?"}',
      '  BIG -- yes --> DEL',
      '  BIG -- no --> STOP["the rest are newer and smaller, stop"]',
      '  DEL --> LOOP',
      '```',
      '',
      '**Compaction** — decide globally, rewrite only sealed segments',
      '',
      '```mermaid',
      'flowchart TD',
      '  CP["compact()"] --> SCAN["scan every segment, active included<br/>note the last offset per key"]',
      '  SCAN --> PICK["among the **sealed** segments, take records<br/>whose offset is that key latest"]',
      '  PICK --> NEW["createSegment and append survivors<br/>keeping their original offsets"]',
      '  NEW --> DROP["delete the compacted segments"]',
      '```',
      '',
      'The point: `SCAN` covers **every** segment while `PICK` only selects from sealed ones. The two ranges',
      'differ — "who is newest" is a global question, "what may I touch" is not.',
    ].join('\n')
  ),
  checklist: [
    t('活动段既不删也不压缩', 'The active segment is neither deleted nor compacted'),
    t('判断「谁是最新」要看全部段', '"Which is newest" is decided across all segments'),
    t('压缩保留原来的 offset', 'Compaction preserves original offsets'),
    t('保留策略按段删，不按条删', 'Retention deletes segments, not records'),
    t('压缩之后每个 key 的最新值仍在', 'Every key keeps its latest value'),
  ],
  pitfalls: [
    t(
      '压缩时只在被压的段里判断「谁是最新」。某个 key 的最新版本如果在活动段里，旧段里那条就会被当成最新的留下来，压缩之后这个 key 出现两条、而且旧的排在后面 —— 任何「取最后一条」的读法都会读到旧值。',
      'Deciding "which is newest" only within the segments being compacted. If a key\'s newest version sits in the active segment, an old one is kept as though it were current, the key ends up with two records, and the stale one comes last — so any "take the latest" read returns the overwritten value.'
    ),
    t(
      '压缩时给幸存者分配新的 offset。offset 是消费者记住的位置，重排一次，所有消费位置全部失效 —— 它们指向的消息变成了别的消息。压缩可以让 offset 出现空洞，但不能让同一个 offset 指向不同的内容。',
      'Renumbering survivors during compaction. An offset is what a consumer remembers, so renumbering invalidates every stored position — the messages they point at become different messages. Compaction may leave holes in the offsets; it must never let one offset mean two things.'
    ),
    t(
      '按条删除来实现保留策略。追加写日志的「删除」只有整段一种粒度，逐条删会退化成随机写，也会让段的元数据（baseOffset、count）失去意义。段的存在就是为了让删除变成一次 unlink。',
      'Implementing retention record by record. Deletion in an append-only log has exactly one granularity — the whole segment. Per-record deletion degenerates into random writes and destroys the meaning of segment metadata. Segments exist so that deletion is one unlink.'
    ),
    t(
      '把活动段也纳入清理范围。它正在被写，删掉它等于把刚刚 ack 给生产者的消息扔了；而且删完之后下一次 append 会落进一个不存在的段。清理永远从「已经封存的段」里选。',
      'Including the active segment in cleanup. It is being written, so deleting it throws away messages just acknowledged to the producer — and the next append targets a segment that no longer exists. Cleanup only ever picks from sealed segments.'
    ),
  ],
  hints: [
    t(
      '「每个 key 最后一条」扫一遍就能算出来：用 Map<key, offset> 边扫边覆盖，扫完之后 map 里就是答案。',
      '"The last record per key" needs one pass: overwrite into a Map from key to offset as you scan, and the map is the answer when you are done.'
    ),
    t(
      '段是按 baseOffset 排序返回的，所以「最老的段」就是第一个，「活动段」就是最后一个。',
      'Segments come back sorted by base offset, so the oldest is the first and the active one is the last.'
    ),
  ],
  extension: t(
    [
      'Kafka 的 `cleanup.policy` 有三个值：`delete`（保留）、`compact`（压缩）、',
      '以及 `compact,delete`（两个一起用 —— 先压缩，再按时间删）。',
      '第三种适合「既要每个 key 的最新值，又不想留着一年前就没再更新过的 key」。',
      '',
      '压缩型 topic 在 Kafka 里有个特别重要的用途：**它自己的元数据**。',
      '消费位置存在 `__consumer_offsets` 这个压缩 topic 里 —— 每个消费者组的',
      '最新位置就是这个 key 的最后一条。这是一个漂亮的自举：',
      '「存状态」这个需求被压缩型日志完全满足了，不需要另一个数据库。',
      '',
      '还有一个这一关没做的细节：**墓碑（tombstone）**。',
      '压缩型日志里删除一个 key 的办法是写一条 value 为空的记录，',
      '压缩时保留它一段时间（让所有消费者都看到「这个 key 没了」），',
      '之后再彻底清掉。没有墓碑的话，一个 key 一旦写进压缩 topic 就永远删不掉了。',
    ].join('\n'),
    [
      "Kafka's `cleanup.policy` takes three values: `delete` (retention), `compact`, and `compact,delete` — both",
      'together, compacting first and then aging out. The third suits "I want the latest value per key, but not',
      'keys nobody has updated in a year".',
      '',
      'Compacted topics have one especially important user inside Kafka: **its own metadata.** Consumer',
      'positions live in `__consumer_offsets`, a compacted topic where the latest position of a group is simply',
      'the last record for that key. It is an elegant bootstrap — the need to "store state" is fully served by a',
      'compacted log, with no second database.',
      '',
      'One detail omitted here: **tombstones.** Deleting a key from a compacted log means writing a record with',
      'an empty value, which compaction keeps around for a while so every consumer sees that the key is gone,',
      'and only then removes. Without tombstones, a key written into a compacted topic can never be deleted.',
    ].join('\n')
  ),
  focus: ['correctness', 'encapsulation', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/retention.ts',
      code`
        import type { AppendResult, MessageLog } from './log';
        import type { StorageDevice, StoredRecord } from './support/storage';
        import { now } from '@lab/env';

        export interface RetentionOptions {
          /** 超过这么多字节就从最老的段开始删 */
          maxBytes: number;
          /** 段活过这么久就删 */
          maxAgeMs: number;
        }

        export interface CompactionResult {
          /** 删掉了多少条被覆盖的旧版本 */
          removed: number;
          /** 留下了多少条 */
          kept: number;
        }

        export interface LogKeeper {
          append(key: string, value: string): AppendResult;
          /** 按大小与时间清理旧段，返回删掉几个 */
          enforce(): number;
          /** 每个 key 只留最后一条 */
          compact(): CompactionResult;
          /** 每个 key 的最后一条，按 offset 升序 */
          live(): StoredRecord[];
          latest(key: string): StoredRecord | null;
          bytes(): number;
        }

        export function createLogKeeper(
          log: MessageLog,
          storage: StorageDevice,
          options: RetentionOptions
        ): LogKeeper {
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
        import { createLogKeeper } from '../src/retention';
        import { createIndexedLog } from '../src/offsetIndex';
        import { createStorage } from '../src/support/storage';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        /** 24 字节一条，一个段正好装 10 条 */
        const SEGMENT_BYTES = 240;
        const HUGE = 1000000;

        function makeKeeper(maxBytes = HUGE, maxAgeMs = HUGE) {
          const storage = createStorage();
          const log = createIndexedLog(storage, { segmentBytes: SEGMENT_BYTES, indexInterval: 16 });
          return { storage, log, keeper: createLogKeeper(log, storage, { maxBytes, maxAgeMs }) };
        }

        function keyOf(index: number): string {
          return 'k' + String(index).padStart(3, '0');
        }

        function valueOf(index: number): string {
          return 'v' + String(index).padStart(11, '0');
        }

        function fill(keeper: any, count: number, keys: number): void {
          for (let index = 0; index < count; index += 1) {
            keeper.append(keyOf(index % keys), valueOf(index));
          }
        }

        describe('阶段9 · 保留与压缩', () => {
          it('压缩之后同一个 key 只剩最后一条', () => {
            const context = makeKeeper();
            // 5 个 key、循环写 30 条，再多写一条让最后一段成为活动段
            fill(context.keeper, 30, 5);

            const result = context.keeper.compact();

            expect(result.removed).toBeGreaterThan(0);
            expect(context.keeper.latest(keyOf(0)).value).toBe(valueOf(25));
          });

          it('压缩不丢任何活着的 key', () => {
            const context = makeKeeper();
            fill(context.keeper, 40, 6);
            const before = context.keeper.live();

            context.keeper.compact();

            const after = context.keeper.live();
            for (const record of before) {
              const survivor = context.keeper.latest(record.key);
              if (!survivor || survivor.value !== record.value) count('liveKeysLost');
            }
            expect(after).toHaveLength(before.length);
          });

          it('压缩之后占用字节数下降', () => {
            const context = makeKeeper();
            fill(context.keeper, 40, 4);
            const before = context.keeper.bytes();

            context.keeper.compact();

            expect(context.keeper.bytes()).toBeLessThan(before);
          });

          it('重复压缩是幂等的', () => {
            const context = makeKeeper();
            fill(context.keeper, 40, 4);
            context.keeper.compact();
            const bytes = context.keeper.bytes();

            const second = context.keeper.compact();

            expect(second.removed).toBe(0);
            expect(context.keeper.bytes()).toBe(bytes);
          });

          it('压缩之后 offset 保持原样，只是有了空洞', () => {
            const context = makeKeeper();
            fill(context.keeper, 30, 3);
            const before = context.keeper.live().map((record: any) => record.offset);

            context.keeper.compact();

            expect(context.keeper.live().map((record: any) => record.offset)).toEqual(before);
          });

          it('活动段里的最新值不会被旧版本盖住', () => {
            const context = makeKeeper();
            fill(context.keeper, 25, 5);
            // 这一条落在活动段里
            context.keeper.append(keyOf(0), 'freshest');

            context.keeper.compact();

            const survivors = context.keeper.live().filter((record: any) => record.key === keyOf(0));
            if (survivors.length !== 1) count('liveKeysLost');
            expect(survivors).toHaveLength(1);
            expect(survivors[0].value).toBe('freshest');
          });

          it('超出容量时从最老的段开始删 [gate:bytes]', () => {
            const context = makeKeeper(500, HUGE);
            fill(context.keeper, 100, 100);
            expect(context.keeper.bytes()).toBe(2400);

            const removed = context.keeper.enforce();

            expect(removed).toBeGreaterThan(0);
            count('bytesRetained', context.keeper.bytes());
            expect(context.keeper.bytes()).toBeLessThanOrEqual(500);
          });

          it('超过保留时长的段会被删掉', async () => {
            const context = makeKeeper(HUGE, 1000);
            fill(context.keeper, 30, 30);

            await sleep(1000);
            // 再写一条，让前面三个段都变成封存段
            context.keeper.append('later', valueOf(99));

            expect(context.keeper.enforce()).toBe(3);
          });

          it('还没到期也没超容量时什么都不删', () => {
            const context = makeKeeper(HUGE, HUGE);
            fill(context.keeper, 30, 30);

            expect(context.keeper.enforce()).toBe(0);
            expect(context.keeper.bytes()).toBe(720);
          });

          it('活动段永远不会被删', () => {
            const context = makeKeeper(1, HUGE);
            fill(context.keeper, 25, 25);

            context.keeper.enforce();

            // 至少留下活动段
            expect(context.storage.segments().length).toBeGreaterThanOrEqual(1);
            expect(context.keeper.bytes()).toBeGreaterThan(0);
          });

          it('保留策略删掉的段里的 key 确实找不到了', () => {
            const context = makeKeeper(500, HUGE);
            fill(context.keeper, 100, 100);

            context.keeper.enforce();

            // 这正是它和压缩的区别：保留会连活着的 key 一起删
            expect(context.keeper.latest(keyOf(0))).toBeNull();
            expect(context.keeper.latest(keyOf(99))).toBeDefined();
          });

          it('live 按 offset 升序返回', () => {
            const context = makeKeeper();
            fill(context.keeper, 20, 7);

            const offsets = context.keeper.live().map((record: any) => record.offset);
            const sorted = offsets.slice().sort((left: number, right: number) => left - right);
            expect(offsets).toEqual(sorted);
          });

          it('空日志上压缩与清理都不炸', () => {
            const context = makeKeeper();

            expect(context.keeper.compact()).toEqual({ removed: 0, kept: 0 });
            expect(context.keeper.enforce()).toBe(0);
            expect(context.keeper.live()).toEqual([]);
            expect(context.keeper.latest('nope')).toBeNull();
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.liveKeysLost',
      op: 'eq',
      value: 0,
      zh: '压缩一个活 key 都没丢',
      en: 'Compaction loses no live key',
      dimension: 'correctness',
    }),
    gate({
      metric: 'counters.bytesRetained',
      op: 'lte',
      value: 500,
      zh: '清理之后占用不超过 500 字节',
      en: 'Usage stays within 500 bytes after cleanup',
      unit: 'bytes',
      dimension: 'resilience',
      scope: 'gate:bytes',
    }),
  ],
  referenceFiles: [
    file(
      'src/retention.ts',
      code`
        import type { AppendResult, MessageLog } from './log';
        import type { StorageDevice, StoredRecord } from './support/storage';
        import { now } from '@lab/env';

        export interface RetentionOptions {
          maxBytes: number;
          maxAgeMs: number;
        }

        export interface CompactionResult {
          removed: number;
          kept: number;
        }

        export interface LogKeeper {
          append(key: string, value: string): AppendResult;
          enforce(): number;
          compact(): CompactionResult;
          live(): StoredRecord[];
          latest(key: string): StoredRecord | null;
          bytes(): number;
        }

        /** 扫出来的一条记录，连同它躺在哪个段里 */
        interface Located {
          record: StoredRecord;
          segmentId: number;
        }

        export function createLogKeeper(
          log: MessageLog,
          storage: StorageDevice,
          options: RetentionOptions
        ): LogKeeper {
          /** 段 id -> 创建时刻，保留策略按它算年龄 */
          const bornAt = new Map<number, number>();

          function scan(): Located[] {
            const found: Located[] = [];
            for (const segment of storage.segments()) {
              for (let slot = 0; slot < segment.count; slot += 1) {
                const record = storage.readAt(segment.id, slot);
                if (record) found.push({ record, segmentId: segment.id });
              }
            }
            return found;
          }

          /** 每个 key 最后一次出现的 offset。范围是**全部**段。 */
          function latestOffsets(entries: Located[]): Map<string, number> {
            const last = new Map<string, number>();
            for (const entry of entries) last.set(entry.record.key, entry.record.offset);
            return last;
          }

          function activeSegmentId(): number {
            const segments = storage.segments();
            return segments.length > 0 ? segments[segments.length - 1].id : -1;
          }

          return {
            append(key: string, value: string): AppendResult {
              const result = log.append(key, value);
              if (!bornAt.has(result.segmentId)) bornAt.set(result.segmentId, now());
              return result;
            },

            enforce(): number {
              const segments = storage.segments();
              // 活动段还在被写，永远不参与清理
              const sealed = segments.slice(0, segments.length - 1);
              let total = storage.bytes();
              let removed = 0;

              for (const segment of sealed) {
                const age = now() - (bornAt.get(segment.id) || 0);
                const tooOld = age >= options.maxAgeMs;
                const tooBig = total > options.maxBytes;
                // 段按 baseOffset 排序，后面的更新更小，第一个留下的之后都留下
                if (!tooOld && !tooBig) break;

                storage.deleteSegment(segment.id);
                bornAt.delete(segment.id);
                total -= segment.bytes;
                removed += 1;
              }

              return removed;
            },

            compact(): CompactionResult {
              const entries = scan();
              const last = latestOffsets(entries);
              const active = activeSegmentId();

              const sealed = entries.filter((entry) => entry.segmentId !== active);
              // 「谁是最新」看全局，「能动谁」只限封存段
              const survivors = sealed.filter(
                (entry) => last.get(entry.record.key) === entry.record.offset
              );
              const removed = sealed.length - survivors.length;
              if (removed === 0) return { removed: 0, kept: entries.length };

              if (survivors.length > 0) {
                const target = storage.createSegment(survivors[0].record.offset);
                // offset 原样搬过去：消费者记住的位置不能被重排
                for (const entry of survivors) storage.append(target, entry.record);
              }
              for (const entry of sealed) {
                storage.deleteSegment(entry.segmentId);
                bornAt.delete(entry.segmentId);
              }

              return { removed, kept: entries.length - removed };
            },

            live(): StoredRecord[] {
              const entries = scan();
              const last = latestOffsets(entries);
              return entries
                .filter((entry) => last.get(entry.record.key) === entry.record.offset)
                .map((entry) => entry.record)
                .sort((left, right) => left.offset - right.offset);
            },

            latest(key: string): StoredRecord | null {
              const matches = scan().filter((entry) => entry.record.key === key);
              return matches.length > 0 ? matches[matches.length - 1].record : null;
            },

            bytes(): number {
              return storage.bytes();
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
      '**`scan` 覆盖全部段，`compact` 只动封存段。** 这两个范围不同，',
      '而把它们写成同一个才是这一关最常见的 bug：',
      '「谁是最新」必须看全局，否则活动段里的新值会被旧段里的版本盖住。',
      '',
      '**幸存者保留原来的 offset。** `storage.append(target, entry.record)` 传的是',
      '整条原始记录，包括它的 offset。重新编号会让所有消费者记住的位置指向别的消息 ——',
      '压缩允许 offset 有空洞，但不允许同一个 offset 换内容。',
      '',
      '**`enforce` 里那个 `break`。** 段是按 baseOffset 排序的，也就是按时间排序，',
      '所以第一个「既不老也不超容量」的段之后，后面的段更不该删。',
      '不 break 而是 continue 的话，一个刚好被跳过的老段会让后面所有段被误判 ——',
      '而这种 bug 只在「时间和容量两条规则同时接近边界」时才出现。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      '`scan` covers every segment while `compact` only touches sealed ones. Those two ranges differ, and',
      'collapsing them into one is the classic bug of this stage: "which is newest" is a global question, or a',
      'fresh value in the active segment gets shadowed by an older version.',
      '',
      'Survivors keep their original offsets. `storage.append(target, entry.record)` passes the whole original',
      'record, offset included. Renumbering would make every position a consumer remembers point at a different',
      'message — compaction may leave holes, never reassignments.',
      '',
      'The `break` in `enforce`. Segments are sorted by base offset, which is chronological, so once one is',
      'neither too old nor over budget, nothing after it should go either. Using `continue` instead lets a',
      'skipped old segment mislead every later decision — a bug that only appears when the age and size rules',
      'are both near their boundaries.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 10 关 · 心跳、会话与再平衡                                        */
/* ------------------------------------------------------------------ */

const stage10 = {
  id: 'session-heartbeat',
  title: t('第 10 关 · 心跳与再平衡', 'Stage 10 · Heartbeats and rebalancing'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '第 4 关用可见性超时处理了「消费者宕机」，但它是**一条消息一条消息**处理的：',
      '每条消息各自等到超时，各自回来。',
      '',
      '这在消费者真的挂掉时不够。一台机器上跑着一个消费者，手里有几十条在处理，',
      '它的进程没了 —— 这几十条要各自等满一个可见性超时，而且它负责的那部分数据',
      '在这段时间里**完全没人处理**。整个系统还以为它活着。',
      '',
      '所以需要一个更快的信号：**心跳**。消费者定期报到，一段时间没报到就判定它死了，',
      '立刻把它手里的活收回来重新分配 —— 这就是再平衡。',
      '',
      '## 要实现什么',
      '',
      '在 `src/membership.ts` 实现 `createCoordinator(options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `join(memberId)` | 加入，触发一次再平衡 |',
      '| `heartbeat(memberId)` | 报到，刷新它的存活时间 |',
      '| `leave(memberId)` | 主动退出 |',
      '| `tick()` | 剔除超时成员并再平衡，返回本次移动了多少个分片 |',
      '| `claim(id, offsets)` / `release(id, offset)` | 认领 / 交还手里的消息 |',
      '| `requeued()` | 因为成员消失而回到队列的消息 |',
      '| `members()` / `assignmentOf(id)` | 当前成员 / 某人分到的分片 |',
      '',
      '## 怎么算过',
      '',
      '- 分片不重不漏：所有分片都有人负责，没有两个人负责同一个；',
      '- 分配是均衡的（6 个分片 3 个人，每人 2 个）；',
      '- 心跳之内不会被剔除，超时之后立刻被剔除；',
      '- **成员消失时，它手里的消息全部回到队列**',
      '  （门槛 `counters.messagesStuck = 0` 数的是「卡在死人手里没回来的」）；',
      '- **再平衡要尽量少动分片**：3 个人挂掉 1 个，只该移动那 2 个孤儿分片',
      '  （门槛 `counters.rebalanceMoves ≤ 2`）；',
      '- `release` 过的消息不会再回队列。',
      '',
      '## 为什么「少动分片」是个硬指标',
      '',
      '因为每一次分片易主，都意味着：',
      '',
      '1. 原来的消费者要放下手里正在处理的消息（重投一次）；',
      '2. 新的消费者要重新建立这个分片的本地状态（缓存、连接、聚合窗口）；',
      '3. 这段时间这个分片没人处理。',
      '',
      '一次「从头重新分配」的再平衡，会让**所有**分片都经历这三件事，',
      '哪怕只是加了一个成员。这就是 Kafka 早年著名的 stop-the-world 再平衡 ——',
      '一个消费者滚动重启，整个消费者组反复停摆。',
      '',
      '## 最容易写错的地方',
      '',
      '再平衡时不看现有分配，直接按成员列表重新排一遍。',
      '',
      '这样写出来的代码更短、更「干净」，而且分配结果同样均衡 ——',
      '两个版本唯一的区别是**有多少分片换了主人**，而这件事在测试里看不出来，',
      '只有在生产环境的再平衡风暴里才会显现。',
      '所以这一关把它做成了门槛：均衡是对的，但不够。',
    ].join('\n'),
    [
      'Stage 4 handled "the consumer died" with a visibility timeout, but it did so **one message at a time**:',
      'each waits out its own timeout and comes back on its own.',
      '',
      'That is not enough when a consumer really dies. A process holding dozens of messages disappears, each',
      'of those messages waits out a full visibility timeout, and the data that consumer was responsible for',
      'goes **entirely unprocessed** meanwhile. The system still believes it is alive.',
      '',
      'So a faster signal is needed: the **heartbeat.** A consumer checks in periodically, silence for long',
      'enough means it is gone, and its work is reclaimed and redistributed at once — a rebalance.',
      '',
      '## What to build',
      '',
      'Implement `createCoordinator(options)` in `src/membership.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `join(memberId)` | Join, triggering a rebalance |',
      '| `heartbeat(memberId)` | Check in, refreshing liveness |',
      '| `leave(memberId)` | Leave deliberately |',
      '| `tick()` | Evict timed-out members, rebalance, return how many partitions moved |',
      '| `claim(id, offsets)` / `release(id, offset)` | Take / hand back messages |',
      '| `requeued()` | Messages returned to the queue because a member disappeared |',
      '| `members()` / `assignmentOf(id)` | Current members / one member\'s partitions |',
      '',
      '## What counts as passing',
      '',
      '- Partitions are covered exactly once: everything is owned, nothing is owned twice;',
      '- The assignment is balanced (six partitions across three members is two each);',
      '- A member heartbeating on time is never evicted, and one that goes silent is evicted immediately;',
      '- **When a member disappears, every message it held returns to the queue**',
      '  (the `counters.messagesStuck = 0` gate counts what stayed stuck with the dead);',
      '- **A rebalance moves as little as possible**: one of three members dying should move only the two',
      '  orphaned partitions (the `counters.rebalanceMoves ≤ 2` gate);',
      '- Released messages do not come back.',
      '',
      '## Why "move as little as possible" is a hard requirement',
      '',
      'Because every change of ownership means:',
      '',
      '1. the previous consumer drops whatever it was processing (those messages get redelivered);',
      '2. the new one rebuilds local state for that partition — caches, connections, aggregation windows;',
      '3. nobody processes that partition in between.',
      '',
      'A rebalance that reassigns from scratch inflicts all three on **every** partition, even when a single',
      'member joined. That is the famous stop-the-world rebalance of early Kafka, where one rolling restart',
      'stalls the entire consumer group repeatedly.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Rebalancing by re-deriving the assignment from the member list, ignoring what exists.',
      '',
      'That code is shorter, cleaner, and just as balanced — the only difference between the two versions is',
      '**how many partitions changed hands**, which no functional test notices and every production rebalance',
      'storm does. Which is why this stage makes it a gate: balanced is right, and not enough.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  HB["heartbeat(id)"] --> STAMP["把它的最后报到时间刷成现在"]',
      '',
      '  TICK["tick()"] --> SCAN["找出超过 sessionTimeoutMs 没报到的"]',
      '  SCAN --> DROP["逐个剔除"]',
      '  DROP --> BACK["它认领的消息全部推进 requeued"]',
      '  BACK --> RB["再平衡"]',
      '',
      '  RB --> OWNER["先记下现在每个分片归谁"]',
      '  OWNER --> TARGET["算每个成员该拿几个<br/>总数除以人数，余数分给前几个"]',
      '  TARGET --> KEEP["逐个分片：原主还在且没超额<br/>就留给他"]',
      '  KEEP --> ORPH["其余的进孤儿池<br/>主人没了的、超额的"]',
      '  ORPH --> GIVE["孤儿分给还没到目标数的成员"]',
      '  GIVE --> DIFF["和 OWNER 那份对比，数出换了几个主人"]',
      '```',
      '',
      '要点：`KEEP` 那一步是「少动分片」的全部内容 —— 它先把能留的留下，',
      '再去分剩下的。删掉这一步，代码会短三行，分配依然均衡，',
      '而再平衡的代价会从「动两个」变成「几乎全动」。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  HB["heartbeat(id)"] --> STAMP["refresh its last-seen time"]',
      '',
      '  TICK["tick()"] --> SCAN["find members silent past sessionTimeoutMs"]',
      '  SCAN --> DROP["evict each"]',
      '  DROP --> BACK["push everything they claimed into requeued"]',
      '  BACK --> RB["rebalance"]',
      '',
      '  RB --> OWNER["record who owns each partition now"]',
      '  OWNER --> TARGET["compute each member target<br/>total over members, remainder to the first few"]',
      '  TARGET --> KEEP["per partition: keep it with its owner<br/>if they remain and are under target"]',
      '  KEEP --> ORPH["everything else joins the orphan pool<br/>ownerless or surplus"]',
      '  ORPH --> GIVE["hand orphans to members below target"]',
      '  GIVE --> DIFF["compare against OWNER and count the changes"]',
      '```',
      '',
      'The point: the `KEEP` step is the entirety of "move as little as possible" — keep what can be kept,',
      'then distribute the rest. Delete it and the code is three lines shorter, the assignment is still',
      'balanced, and the cost of a rebalance goes from "two partitions" to "nearly all of them".',
    ].join('\n')
  ),
  checklist: [
    t('分片不重不漏', 'Partitions are covered exactly once'),
    t('再平衡先保留能保留的', 'Rebalancing keeps what it can'),
    t('超时成员的消息回到队列', 'A dead member\'s messages return to the queue'),
    t('心跳能续命', 'A heartbeat keeps a member alive'),
    t('主动退出和超时走同一条路', 'Leaving and timing out take the same path'),
  ],
  pitfalls: [
    t(
      '再平衡时从头重新分配。结果同样均衡，代价是几乎所有分片都换了主人：每一次成员变动都变成一次全组停摆。这是 Kafka 早年的 range/round-robin 分配器的问题，后来的 sticky 分配器就是为了解决它。',
      'Reassigning from scratch on every rebalance. The result is equally balanced and nearly every partition changes hands, so every membership change becomes a group-wide stall. That was the problem with Kafka\'s early range and round-robin assignors, and precisely what the sticky assignor was built to fix.'
    ),
    t(
      '成员消失时只把它从成员列表里删掉，不管它手里的消息。那些消息既不在队列里（已经被认领了）也没人处理（认领者已经死了），它们要等到可见性超时才回来 —— 而心跳机制存在的意义正是「比可见性超时更快地发现死亡」。',
      'Removing a departed member from the list and forgetting what it held. Those messages are neither in the queue (they were claimed) nor being processed (the claimer is dead), so they wait out a visibility timeout — while the entire point of heartbeats is noticing death sooner than that timeout.'
    ),
    t(
      '把会话超时设得比心跳间隔还短，或者只差一点。网络抖动、一次 GC 停顿都会让一次心跳晚到，于是活着的消费者被判死、触发再平衡、再平衡又拖慢所有人 —— 一次 200ms 的抖动引发一轮全组重组。经验值是超时至少三倍于心跳间隔。',
      'Setting the session timeout at or barely above the heartbeat interval. A network hiccup or one GC pause delays a heartbeat, a living consumer is declared dead, a rebalance starts and slows everybody down — a 200ms hiccup causing a group-wide reorganisation. The rule of thumb is a timeout at least three times the heartbeat interval.'
    ),
    t(
      '在遍历成员表的同时删除成员。JavaScript 里对着 Map 边遍历边 delete 不会抛错，只会安静地跳过下一个 —— 于是同时挂掉两个成员时，只有一个被剔除，另一个要等到下一次 tick。先收集再删除。',
      'Deleting members while iterating the member map. JavaScript does not throw here, it quietly skips the next entry — so when two members die together only one is evicted and the other waits for the next tick. Collect first, delete after.'
    ),
  ],
  hints: [
    t(
      '目标数：`base = 分片数 / 人数` 向下取整，余数分给排在前面的几个人。这样 6 个分片 4 个人就是 2、2、1、1。',
      'Targets: `base` is partitions divided by members rounded down, and the remainder goes to the first few. Six partitions across four members is 2, 2, 1, 1.'
    ),
    t(
      '「移动了几个」不需要单独记账：把再平衡之前的归属存一份，之后逐个分片对比即可。',
      '"How many moved" needs no bookkeeping: snapshot ownership before the rebalance and compare partition by partition afterwards.'
    ),
  ],
  extension: t(
    [
      'Kafka 的消费者组协议里有三个参数正好对应这一关：',
      '`heartbeat.interval.ms`（多久报一次）、`session.timeout.ms`（多久没报算死）、',
      '以及 `max.poll.interval.ms`（两次 poll 之间最长间隔）。',
      '第三个是后来加的，因为早期只有前两个时，心跳跑在后台线程上 ——',
      '于是出现了「心跳正常但业务线程卡死」的僵尸消费者：组认为它活着，它却什么都不处理。',
      '',
      '「少动分片」这件事，Kafka 从 range 分配器一路演进到 sticky、',
      '再到 **cooperative sticky**（增量协作式再平衡）：后者甚至不再停掉整个组，',
      '而是只让需要移交的那几个分片暂停。KIP-429 的动机就是一句话：',
      '再平衡的代价不该和组的大小成正比。',
      '',
      '这一关刻意简化掉的是**分配的一致性**：真实系统里协调者要给每次分配一个',
      'generation id，老 generation 的消费者提交 offset 会被拒绝 ——',
      '否则一个「以为自己还活着」的旧成员会覆盖新成员的消费进度。',
    ].join('\n'),
    [
      "Kafka's consumer group protocol has three parameters matching this stage: `heartbeat.interval.ms`,",
      '`session.timeout.ms`, and `max.poll.interval.ms`. The third came later, because with only the first two',
      'the heartbeat ran on a background thread and produced zombie consumers — heartbeating normally while the',
      'processing thread was wedged, so the group believed it was healthy and it processed nothing.',
      '',
      'On moving as little as possible, Kafka went from the range assignor to sticky and then to',
      '**cooperative sticky** (incremental rebalancing), which does not stop the group at all and pauses only',
      'the partitions actually changing hands. The motivation of KIP-429 is one sentence: the cost of a',
      'rebalance should not be proportional to the size of the group.',
      '',
      'Deliberately simplified here: **assignment consistency.** A real coordinator stamps each assignment with',
      'a generation id and rejects offset commits from an older generation — otherwise a member that still',
      "believes it is alive overwrites the new owner's progress.",
    ].join('\n')
  ),
  focus: ['resilience', 'correctness', 'concurrency'],
  lab: {},
  starterFiles: [
    file(
      'src/membership.ts',
      code`
        import { now } from '@lab/env';

        export interface MembershipOptions {
          /** 多久没心跳就算它死了 */
          sessionTimeoutMs: number;
          /** 一共有多少个分片要分 */
          partitions: number;
        }

        export interface MembershipCoordinator {
          join(memberId: string): void;
          heartbeat(memberId: string): void;
          leave(memberId: string): void;
          /** 剔除超时成员并再平衡，返回移动了多少个分片 */
          tick(): number;
          /** 认领一批消息（正在处理） */
          claim(memberId: string, offsets: number[]): void;
          /** 处理完了，交还一条 */
          release(memberId: string, offset: number): void;
          /** 因为成员消失而回到队列的消息 */
          requeued(): number[];
          members(): string[];
          assignmentOf(memberId: string): number[];
        }

        export function createCoordinator(options: MembershipOptions): MembershipCoordinator {
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
        import { createCoordinator } from '../src/membership';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const TIMEOUT = 1000;
        const PARTITIONS = 6;

        function makeCoordinator(members: string[] = []) {
          const coordinator = createCoordinator({
            sessionTimeoutMs: TIMEOUT,
            partitions: PARTITIONS,
          });
          for (const member of members) coordinator.join(member);
          return coordinator;
        }

        /** 当前每个分片归谁 */
        function ownership(coordinator: any): Map<number, string> {
          const owner = new Map<number, string>();
          for (const member of coordinator.members()) {
            for (const partition of coordinator.assignmentOf(member)) owner.set(partition, member);
          }
          return owner;
        }

        function movedBetween(before: Map<number, string>, after: Map<number, string>): number {
          let moved = 0;
          for (const partition of Array.from(after.keys())) {
            if (before.get(partition) !== after.get(partition)) moved += 1;
          }
          return moved;
        }

        describe('阶段10 · 心跳与再平衡', () => {
          it('分片不重不漏', () => {
            const coordinator = makeCoordinator(['a', 'b', 'c']);

            const owner = ownership(coordinator);
            expect(owner.size).toBe(PARTITIONS);
            for (let partition = 0; partition < PARTITIONS; partition += 1) {
              expect(owner.has(partition)).toBe(true);
            }
          });

          it('分配是均衡的', () => {
            const coordinator = makeCoordinator(['a', 'b', 'c']);

            for (const member of ['a', 'b', 'c']) {
              expect(coordinator.assignmentOf(member)).toHaveLength(2);
            }
          });

          it('人数除不尽时，余数分给前几个', () => {
            const coordinator = makeCoordinator(['a', 'b', 'c', 'd']);

            const sizes = coordinator.members().map((member: string) => coordinator.assignmentOf(member).length);
            expect(sizes.slice().sort()).toEqual([1, 1, 2, 2]);
          });

          it('心跳之内不会被剔除', async () => {
            const coordinator = makeCoordinator(['a', 'b']);

            await sleep(TIMEOUT / 2);
            coordinator.heartbeat('a');
            coordinator.heartbeat('b');
            await sleep(TIMEOUT / 2);
            coordinator.tick();

            expect(coordinator.members().slice().sort()).toEqual(['a', 'b']);
          });

          it('超时的成员被剔除', async () => {
            const coordinator = makeCoordinator(['a', 'b']);

            await sleep(TIMEOUT / 2);
            coordinator.heartbeat('a');
            await sleep(TIMEOUT / 2);
            coordinator.tick();

            expect(coordinator.members()).toEqual(['a']);
            expect(ownership(coordinator).size).toBe(PARTITIONS);
          });

          it('成员消失时它手里的消息全部回到队列', async () => {
            const coordinator = makeCoordinator(['a', 'b']);
            coordinator.claim('b', [10, 11, 12]);

            await sleep(TIMEOUT);
            coordinator.heartbeat('a');
            coordinator.tick();

            const back = coordinator.requeued().slice().sort((left: number, right: number) => left - right);
            for (const offset of [10, 11, 12]) {
              if (back.indexOf(offset) < 0) count('messagesStuck');
            }
            expect(back).toEqual([10, 11, 12]);
          });

          it('已经交还的消息不会再回队列', async () => {
            const coordinator = makeCoordinator(['a', 'b']);
            coordinator.claim('b', [10, 11]);
            coordinator.release('b', 10);

            await sleep(TIMEOUT);
            coordinator.heartbeat('a');
            coordinator.tick();

            expect(coordinator.requeued()).toEqual([11]);
          });

          it('主动退出同样会把消息还回来', () => {
            const coordinator = makeCoordinator(['a', 'b']);
            coordinator.claim('b', [7]);

            coordinator.leave('b');

            if (coordinator.requeued().indexOf(7) < 0) count('messagesStuck');
            expect(coordinator.requeued()).toEqual([7]);
            expect(coordinator.members()).toEqual(['a']);
          });

          it('一个成员挂掉时只移动它的分片 [gate:rebalance]', async () => {
            const coordinator = makeCoordinator(['a', 'b', 'c']);
            const before = ownership(coordinator);

            await sleep(TIMEOUT);
            coordinator.heartbeat('a');
            coordinator.heartbeat('b');
            coordinator.tick();

            const after = ownership(coordinator);
            count('rebalanceMoves', movedBetween(before, after));
            expect(after.size).toBe(PARTITIONS);
            expect(coordinator.members().slice().sort()).toEqual(['a', 'b']);
          });

          it('新成员加入时也只移动必要的分片', () => {
            const coordinator = makeCoordinator(['a', 'b']);
            const before = ownership(coordinator);

            coordinator.join('c');

            const after = ownership(coordinator);
            // 6 个分片从两人分到三人，只需要移交 2 个
            expect(movedBetween(before, after)).toBeLessThanOrEqual(2);
          });

          it('两个成员同时超时都会被剔除', async () => {
            const coordinator = makeCoordinator(['a', 'b', 'c']);

            await sleep(TIMEOUT);
            coordinator.heartbeat('a');
            coordinator.tick();

            expect(coordinator.members()).toEqual(['a']);
            expect(coordinator.assignmentOf('a')).toHaveLength(PARTITIONS);
          });

          it('没有成员时分片无人认领', () => {
            const coordinator = makeCoordinator(['a']);

            coordinator.leave('a');

            expect(coordinator.members()).toEqual([]);
            expect(ownership(coordinator).size).toBe(0);
            expect(coordinator.tick()).toBe(0);
          });

          it('重复 join 不会把分片分成两份', () => {
            const coordinator = makeCoordinator(['a', 'b']);

            coordinator.join('a');

            expect(coordinator.members().slice().sort()).toEqual(['a', 'b']);
            expect(ownership(coordinator).size).toBe(PARTITIONS);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.messagesStuck',
      op: 'eq',
      value: 0,
      zh: '没有消息卡在消失的成员手里',
      en: 'No message stays stuck with a departed member',
      dimension: 'resilience',
    }),
    gate({
      metric: 'counters.rebalanceMoves',
      op: 'lte',
      value: 2,
      zh: '一个成员挂掉最多移动 2 个分片',
      en: 'Losing one member moves at most two partitions',
      dimension: 'concurrency',
      scope: 'gate:rebalance',
    }),
  ],
  referenceFiles: [
    file(
      'src/membership.ts',
      code`
        import { now } from '@lab/env';

        export interface MembershipOptions {
          sessionTimeoutMs: number;
          partitions: number;
        }

        export interface MembershipCoordinator {
          join(memberId: string): void;
          heartbeat(memberId: string): void;
          leave(memberId: string): void;
          tick(): number;
          claim(memberId: string, offsets: number[]): void;
          release(memberId: string, offset: number): void;
          requeued(): number[];
          members(): string[];
          assignmentOf(memberId: string): number[];
        }

        export function createCoordinator(options: MembershipOptions): MembershipCoordinator {
          const lastSeen = new Map<string, number>();
          const assignment = new Map<string, number[]>();
          const claimed = new Map<string, number[]>();
          const back: number[] = [];

          function currentOwners(): Map<number, string> {
            const owner = new Map<number, string>();
            for (const pair of Array.from(assignment.entries())) {
              for (const partition of pair[1]) owner.set(partition, pair[0]);
            }
            return owner;
          }

          /** 每个成员该拿几个：整除的部分平分，余数给排在前面的 */
          function targets(members: string[]): Map<string, number> {
            const quota = new Map<string, number>();
            if (members.length === 0) return quota;
            const base = Math.floor(options.partitions / members.length);
            const extra = options.partitions % members.length;
            members.forEach((member, index) => quota.set(member, base + (index < extra ? 1 : 0)));
            return quota;
          }

          function rebalance(): number {
            const members = Array.from(lastSeen.keys()).sort();
            const owner = currentOwners();
            const quota = targets(members);

            const next = new Map<string, number[]>();
            for (const member of members) next.set(member, []);

            const orphans: number[] = [];
            for (let partition = 0; partition < options.partitions; partition += 1) {
              const holder = owner.get(partition);
              const kept = holder ? next.get(holder) : undefined;
              // 原主还在、而且还没拿够，就让他继续拿着 —— 这一步就是「少动分片」
              if (kept && kept.length < (quota.get(holder as string) || 0)) kept.push(partition);
              else orphans.push(partition);
            }

            for (const partition of orphans) {
              const taker = members.filter(
                (member) => (next.get(member) || []).length < (quota.get(member) || 0)
              )[0];
              if (!taker) break;
              (next.get(taker) as number[]).push(partition);
            }

            let moved = 0;
            assignment.clear();
            for (const member of members) {
              const parts = (next.get(member) as number[]).sort((left, right) => left - right);
              for (const partition of parts) {
                if (owner.get(partition) !== member) moved += 1;
              }
              assignment.set(member, parts);
            }

            return moved;
          }

          function evict(memberId: string): void {
            // 手里没处理完的消息回队列，别等可见性超时
            for (const offset of claimed.get(memberId) || []) back.push(offset);
            claimed.delete(memberId);
            lastSeen.delete(memberId);
            assignment.delete(memberId);
          }

          return {
            join(memberId: string): void {
              lastSeen.set(memberId, now());
              rebalance();
            },

            heartbeat(memberId: string): void {
              if (lastSeen.has(memberId)) lastSeen.set(memberId, now());
            },

            leave(memberId: string): void {
              evict(memberId);
              rebalance();
            },

            tick(): number {
              // 先收集再删除：边遍历边删会安静地跳过下一个
              const expired = Array.from(lastSeen.entries())
                .filter((pair) => now() - pair[1] >= options.sessionTimeoutMs)
                .map((pair) => pair[0]);
              for (const memberId of expired) evict(memberId);
              return rebalance();
            },

            claim(memberId: string, offsets: number[]): void {
              const held = claimed.get(memberId) || [];
              claimed.set(memberId, held.concat(offsets));
            },

            release(memberId: string, offset: number): void {
              const held = claimed.get(memberId) || [];
              claimed.set(memberId, held.filter((item) => item !== offset));
            },

            requeued(): number[] {
              return back.slice();
            },

            members(): string[] {
              return Array.from(lastSeen.keys()).sort();
            },

            assignmentOf(memberId: string): number[] {
              return (assignment.get(memberId) || []).slice();
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
      '**再平衡先算「谁现在拿着什么」，再决定「谁该拿几个」。** 这两步的顺序',
      '就是 sticky 和 round-robin 的全部区别。反过来（先算该拿几个、再按顺序发牌）',
      '同样均衡，但每次都会重新洗牌。',
      '',
      '**`evict` 同时做两件事：还消息、清成员。** 把它们分开写，迟早会出现',
      '「删了成员忘了还消息」的路径 —— 而那条路径的表现是「偶尔有几条消息',
      '要等可见性超时才回来」，在监控上表现为延迟长尾，几乎查不到根因。',
      '',
      '**`tick` 里先收集再删除。** 对着 Map 边遍历边 delete 在 JavaScript 里',
      '不会报错，只会跳过下一个元素。两个成员同时超时的时候，',
      '这个 bug 会让其中一个多活一个 tick —— 而两个成员同时超时，',
      '恰恰是网络分区时最常见的场景。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'The rebalance computes "who holds what now" before deciding "who should hold how many". The order of',
      'those two steps is the entire difference between sticky and round-robin. The other way around is',
      'equally balanced and reshuffles the deck every time.',
      '',
      '`evict` does two things at once: return the messages and remove the member. Split them and a path',
      'eventually appears that removes a member without returning its messages — a path whose symptom is "a',
      'few messages occasionally take a visibility timeout to come back", visible only as a latency tail with',
      'no traceable cause.',
      '',
      '`tick` collects before deleting. Deleting from a Map while iterating it does not throw in JavaScript, it',
      'skips the next entry. When two members time out together, that bug grants one of them an extra tick of',
      'life — and two members timing out together is exactly what a network partition looks like.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 11 关 · 配额与公平调度                                            */
/* ------------------------------------------------------------------ */

const stage11 = {
  id: 'client-quota',
  title: t('第 11 关 · 配额与公平调度', 'Stage 11 · Quotas and fair scheduling'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前十关的 broker 对所有客户端一视同仁 —— 而这正是问题所在。',
      '',
      '一个共享集群上，某个客户端上线了一个新任务，它一秒钟拉一百万条。',
      '它没有恶意，只是「尽力而为」。而 broker 的资源是有限的，',
      '于是其他二十个客户端的延迟集体升高，值班的人开始收到告警 ——',
      '告警来自那二十个受害者，而问题出在第二十一个。',
      '',
      '这一关加两层保护，它们各管一头：',
      '',
      '| 机制 | 管什么 | 保护谁 |',
      '| --- | --- | --- |',
      '| **配额** | 一个客户端每个窗口最多拿多少 | 防止某一个吃掉整个集群 |',
      '| **公平调度** | 一轮容量怎么在等待者之间分 | 防止排在后面的永远轮不到 |',
      '',
      '配额是**上限**，公平是**下限** —— 缺任何一个，另一个都不够。',
      '',
      '## 要实现什么',
      '',
      '在 `src/quota.ts` 实现 `createFairScheduler(options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `submit(clientId, want)` | 某个客户端想要 want 条，累加到它的待办上 |',
      '| `dispatch(capacity)` | 分一轮，总共最多 capacity 条，返回每人分到多少 |',
      '| `remaining(clientId)` | 它在当前窗口还剩多少额度 |',
      '| `pending(clientId)` | 它还有多少需求没被满足 |',
      '',
      '每个客户端在一个 `windowMs` 窗口里最多拿 `perWindow` 条，窗口过去后重置。',
      '',
      '## 怎么算过',
      '',
      '- **任何客户端在一个窗口里拿到的都不超过 `perWindow`**',
      '  （门槛 `counters.quotaViolations = 0`）；',
      '- **有需求的客户端不会一条都拿不到**',
      '  （门槛 `counters.starvedClients = 0`）——',
      '  哪怕容量比客户端数还少，轮几次也要轮到它；',
      '- 一轮分出去的总数不超过 `capacity`；',
      '- 某个客户端配额用满时，剩下的容量让给别人，不浪费；',
      '- 窗口滚动之后额度恢复。',
      '',
      '## 为什么容量小于客户端数时会饿死人',
      '',
      '假设 3 个客户端都有需求，而一轮只能发 2 条。',
      '如果每轮都从头开始发，那么第 3 个客户端**永远**排在第三位，',
      '而容量永远在第二位就用完了 —— 它一条都拿不到，而且这个状态会一直持续。',
      '',
      '解法是让起点转起来：这一轮从谁开始，取决于上一轮发到了哪儿。',
      '同样是「一轮发 2 条」，转起来之后三轮下来每人都拿到 2 条。',
      '',
      '这就是操作系统调度器里 round-robin 的核心 —— 公平不来自「分得多」，',
      '来自「**轮得到**」。',
      '',
      '## 最容易写错的地方',
      '',
      '按需求量分配：谁要得多谁分得多。',
      '',
      '这听起来很合理（按需分配嘛），而它把系统的激励做反了：',
      '**要得越多，拿得越多**。一个失控的客户端会因为它的失控而获得优先权，',
      '而规规矩矩每次只要几条的客户端反而被挤到最后。',
      '',
      '公平调度要按「人头」分，不按「嗓门」分。',
    ].join('\n'),
    [
      'For ten stages the broker has treated every client identically — which is exactly the problem.',
      '',
      'On a shared cluster somebody deploys a new job that pulls a million records a second. There is no',
      'malice; it is simply doing its best. Broker resources are finite, so the latency of the other twenty',
      'clients rises together and the on-call engineer starts receiving alerts — from the twenty victims,',
      'about a problem caused by the twenty-first.',
      '',
      'This stage adds two protections, each covering one end:',
      '',
      '| Mechanism | Governs | Protects |',
      '| --- | --- | --- |',
      '| **Quota** | How much one client may take per window | Stops one client eating the cluster |',
      '| **Fair scheduling** | How a round of capacity is split among waiters | Stops the back of the queue never being served |',
      '',
      'A quota is a **ceiling** and fairness is a **floor** — either one alone is not enough.',
      '',
      '## What to build',
      '',
      'Implement `createFairScheduler(options)` in `src/quota.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `submit(clientId, want)` | A client wants `want` records; add to its outstanding demand |',
      '| `dispatch(capacity)` | Hand out one round of at most `capacity`; return who got what |',
      '| `remaining(clientId)` | Its remaining allowance in the current window |',
      '| `pending(clientId)` | Its unmet demand |',
      '',
      'Each client may take at most `perWindow` records within a `windowMs` window, which then resets.',
      '',
      '## What counts as passing',
      '',
      '- **No client receives more than `perWindow` within a window**',
      '  (the `counters.quotaViolations = 0` gate);',
      '- **A client with demand never receives nothing**',
      '  (the `counters.starvedClients = 0` gate) — even when capacity is smaller than the client count, a few',
      '  rounds must reach it;',
      '- One round never hands out more than `capacity` in total;',
      '- When a client exhausts its quota, the remaining capacity goes to others rather than being wasted;',
      '- Allowances come back when the window rolls.',
      '',
      '## Why a capacity smaller than the client count starves someone',
      '',
      'Suppose three clients all have demand and one round can only serve two. Handing out from the top every',
      'round leaves the third client **permanently** in third place while capacity always runs out at second —',
      'it receives nothing, indefinitely.',
      '',
      'The fix is to rotate the starting point: where this round begins depends on where the last one ended.',
      'Same "two per round", and after three rounds everyone has received two.',
      '',
      'That is the core of round-robin scheduling in an operating system — fairness does not come from getting',
      'a lot, it comes from **getting a turn.**',
      '',
      '## The easiest thing to get wrong',
      '',
      'Allocating in proportion to demand: whoever asks for more gets more.',
      '',
      'It sounds reasonable — from each according to their need — and it inverts the incentives of the system:',
      '**the more you ask for, the more you get.** A runaway client is rewarded with priority for being',
      'runaway, while the well-behaved client asking for a handful each time is pushed to the back.',
      '',
      'Fair scheduling counts heads, not volume.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  SUB["submit(clientId, want)"] --> ACC["需求累加<br/>第一次出现就记进轮转顺序"]',
      '',
      '  DIS["dispatch(capacity)"] --> ROLL{"窗口过去了？"}',
      '  ROLL -- 是 --> RESET["清空本窗口的用量"]',
      '  ROLL -- 否 --> KEEP["保持"]',
      '  RESET --> LOOP',
      '  KEEP --> LOOP["从上一轮结束的位置开始转"]',
      '  LOOP --> ONE["看当前这个客户端"]',
      '  ONE --> WANT{"它还有需求吗？"}',
      '  WANT -- 没有 --> SKIP["跳过，看下一个"]',
      '  WANT -- 有 --> QUOTA{"本窗口额度还有吗？"}',
      '  QUOTA -- 没有 --> SKIP',
      '  QUOTA -- 有 --> GIVE["发一条<br/>需求减一，用量加一，容量减一"]',
      '  GIVE --> LEFT{"容量还有剩？"}',
      '  SKIP --> LEFT',
      '  LEFT -- 有 --> ONE',
      '  LEFT -- 没有 --> ROT["把轮转起点往前推<br/>推过的格数等于这轮发出去的条数"]',
      '  ROT --> RET["返回每人分到多少"]',
      '```',
      '',
      '要点：`ROT` 是这张图里唯一和「公平」有关的一步。',
      '去掉它，其余逻辑全都不变、配额也依然生效，但排在后面的客户端',
      '会在容量紧张时永远轮不到 —— 而这件事在「分配是否正确」的测试里看不出来。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  SUB["submit(clientId, want)"] --> ACC["accumulate demand<br/>first appearance joins the rotation"]',
      '',
      '  DIS["dispatch(capacity)"] --> ROLL{"has the window passed?"}',
      '  ROLL -- yes --> RESET["clear this window usage"]',
      '  ROLL -- no --> KEEP["keep it"]',
      '  RESET --> LOOP',
      '  KEEP --> LOOP["start where the last round ended"]',
      '  LOOP --> ONE["look at the current client"]',
      '  ONE --> WANT{"any demand?"}',
      '  WANT -- no --> SKIP["skip to the next"]',
      '  WANT -- yes --> QUOTA{"allowance left this window?"}',
      '  QUOTA -- no --> SKIP',
      '  QUOTA -- yes --> GIVE["hand out one<br/>demand -1, usage +1, capacity -1"]',
      '  GIVE --> LEFT{"capacity left?"}',
      '  SKIP --> LEFT',
      '  LEFT -- yes --> ONE',
      '  LEFT -- no --> ROT["advance the rotation<br/>by as many as this round handed out"]',
      '  ROT --> RET["return who got what"]',
      '```',
      '',
      'The point: `ROT` is the only step in this diagram that has anything to do with fairness. Remove it and',
      'every other behaviour is unchanged and the quota still holds, while clients at the back never get a turn',
      'under pressure — something no "is the allocation correct" test can see.',
    ].join('\n')
  ),
  checklist: [
    t('一个窗口内不超过 perWindow', 'Never more than perWindow within a window'),
    t('轮转起点每轮变化', 'The rotation start moves every round'),
    t('按人头分，不按需求量分', 'Allocate by head count, not by demand size'),
    t('额度用完的客户端让出容量', 'A client out of allowance yields its capacity'),
    t('窗口滚动后额度恢复', 'Allowances return when the window rolls'),
  ],
  pitfalls: [
    t(
      '按需求量按比例分配。要得越多分得越多，于是失控的客户端因为失控而获得优先权，而每次只要几条的老实客户端被挤到最后。公平调度要数人头，不要数嗓门。',
      'Allocating proportionally to demand. The more you ask, the more you get, so a runaway client is rewarded with priority for being runaway while the well-behaved one asking for a handful is pushed to the back. Fair scheduling counts heads, not volume.'
    ),
    t(
      '每轮都从第一个客户端开始发。容量充足时看不出任何问题，一旦容量小于客户端数，排在后面的就永远拿不到 —— 而这正是系统最忙、最需要公平的时候。饥饿是一个只在压力下出现的 bug。',
      'Starting every round from the first client. Nothing looks wrong while capacity is plentiful, and the moment capacity falls below the client count the back of the list receives nothing — exactly when the system is busiest and fairness matters most. Starvation is a bug that only appears under pressure.'
    ),
    t(
      '配额用完就把这个客户端的容量份额浪费掉（跳过它，但也不给别人）。集群明明还有余量，别人却拿不到 —— 限流的目的是防止一个人吃掉所有，不是让资源闲置。跳过它之后，容量应该继续往下发。',
      'Skipping a client that has exhausted its quota and wasting its share of the capacity. The cluster has room and nobody can use it — throttling exists to stop one client eating everything, not to idle the resource. After skipping, the capacity must keep flowing to the others.'
    ),
    t(
      '窗口用「上一次请求到现在」的滑动方式实现，却在每次请求时都重置起点。这样只要客户端持续请求，窗口就永远不会滚动，配额永远不会恢复 —— 它从限流变成了一次性的总量限制。',
      'Implementing the window as "since the last request" and resetting the start on every request. A client that keeps requesting never rolls the window and never recovers its allowance, turning a rate limit into a one-time total.'
    ),
  ],
  hints: [
    t(
      '轮转起点存一个整数就够了：`(起点 + 步数) % 客户端数`。每轮结束时把它往前推「这一轮发出去的条数」格。',
      'The rotation is one integer: `(start + step) % clientCount`. At the end of a round, advance it by however many records that round handed out.'
    ),
    t(
      '一次发一条、循环着发，比「算好每人该拿几条再发」简单得多，也天然处理了「有人需求不足、有人额度用完」这些边界。',
      'Handing out one at a time in a loop is far simpler than computing everybody\'s share up front, and it handles "this one has no demand" and "that one is out of allowance" for free.'
    ),
  ],
  extension: t(
    [
      'Kafka 的配额是按**字节速率**而不是条数算的（`producer_byte_rate`、',
      '`consumer_byte_rate`），而且它的执行方式很有意思：不是拒绝请求，',
      '而是**延迟响应** —— broker 算出「你超了多少」，然后把响应压住相应的时间。',
      '客户端因此自然而然地慢下来，不需要处理任何错误码。',
      '',
      '这是限流实现里一个重要的分野：**拒绝**还是**减速**。',
      '拒绝对客户端更友好（立刻知道），减速对系统更友好（不产生重试风暴）。',
      '消息系统普遍选后者，因为它的客户端天然是长连接、天然会重试。',
      '',
      '公平调度这一侧，网络设备里的对应物是 **fair queueing**：',
      '每个流一个队列，轮流出队。再往上还有 **deficit round robin**，',
      '它解决的是「包大小不一样时，按包数轮转并不公平」的问题 ——',
      '给每个流一个赤字计数器，允许它在这一轮少发、下一轮补回来。',
      '如果这一关的消息大小不一，你需要的就是它。',
    ].join('\n'),
    [
      'Kafka quotas are measured in **bytes per second** rather than records (`producer_byte_rate`,',
      '`consumer_byte_rate`), and their enforcement is interesting: instead of rejecting a request, the broker',
      '**delays the response** by however long the overage implies. The client slows down naturally, with no',
      'error code to handle.',
      '',
      'That is an important fork in throttling design: **reject** or **slow down.** Rejecting is friendlier to',
      'the client, which learns immediately; slowing is friendlier to the system, which avoids a retry storm.',
      'Message systems generally choose the second, because their clients hold long connections and retry by',
      'nature.',
      '',
      'On the fairness side, the networking equivalent is **fair queueing**: one queue per flow, dequeued in',
      'turn. Above it sits **deficit round robin**, which solves "rotating by packet count is unfair when',
      'packets differ in size" by giving each flow a deficit counter so it can under-send this round and catch',
      'up next. If the messages in this stage had varying sizes, that is what you would need.',
    ].join('\n')
  ),
  focus: ['concurrency', 'correctness', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/quota.ts',
      code`
        import { now } from '@lab/env';

        export interface QuotaOptions {
          /** 每个客户端一个窗口内最多拿多少条 */
          perWindow: number;
          /** 窗口有多长 */
          windowMs: number;
        }

        export interface FairScheduler {
          /** 某个客户端想要 want 条，累加到它的待办上 */
          submit(clientId: string, want: number): void;
          /** 分一轮，总共最多 capacity 条，返回每人分到多少 */
          dispatch(capacity: number): Record<string, number>;
          /** 当前窗口还剩多少额度 */
          remaining(clientId: string): number;
          /** 还有多少需求没被满足 */
          pending(clientId: string): number;
        }

        export function createFairScheduler(options: QuotaOptions): FairScheduler {
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
        import { createFairScheduler } from '../src/quota';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const PER_WINDOW = 10;
        const WINDOW = 1000;

        function makeScheduler(perWindow = PER_WINDOW) {
          return createFairScheduler({ perWindow, windowMs: WINDOW });
        }

        function totalOf(granted: Record<string, number>): number {
          return Object.keys(granted).reduce((sum, client) => sum + granted[client], 0);
        }

        function merge(into: Record<string, number>, granted: Record<string, number>): void {
          for (const client of Object.keys(granted)) {
            into[client] = (into[client] || 0) + granted[client];
          }
        }

        /** 一个窗口里拿超了就是违规 —— 门槛数的就是它 */
        function checkQuota(totals: Record<string, number>, perWindow: number): void {
          for (const client of Object.keys(totals)) {
            if (totals[client] > perWindow) count('quotaViolations');
          }
        }

        /** 有需求却一条都没拿到 = 被饿死 */
        function checkStarvation(scheduler: any, clients: string[], totals: Record<string, number>): void {
          for (const client of clients) {
            if (scheduler.pending(client) > 0 && !(totals[client] > 0)) count('starvedClients');
          }
        }

        describe('阶段11 · 配额与公平调度', () => {
          it('拿不到超过自己需求的量', () => {
            const scheduler = makeScheduler();
            scheduler.submit('a', 3);

            const granted = scheduler.dispatch(100);

            expect(granted['a']).toBe(3);
            expect(scheduler.pending('a')).toBe(0);
          });

          it('一个窗口里拿不到超过配额的量', () => {
            const scheduler = makeScheduler();
            scheduler.submit('a', 100);
            const totals: Record<string, number> = {};

            merge(totals, scheduler.dispatch(50));
            merge(totals, scheduler.dispatch(50));

            checkQuota(totals, PER_WINDOW);
            expect(totals['a']).toBe(PER_WINDOW);
            expect(scheduler.remaining('a')).toBe(0);
          });

          it('窗口滚动之后额度恢复', async () => {
            const scheduler = makeScheduler();
            scheduler.submit('a', 100);
            scheduler.dispatch(50);

            await sleep(WINDOW);
            const totals: Record<string, number> = {};
            merge(totals, scheduler.dispatch(50));

            checkQuota(totals, PER_WINDOW);
            expect(totals['a']).toBe(PER_WINDOW);
          });

          it('多个客户端轮流分，谁都不会空手', () => {
            const scheduler = makeScheduler();
            const clients = ['a', 'b', 'c'];
            for (const client of clients) scheduler.submit(client, 100);
            const totals: Record<string, number> = {};

            merge(totals, scheduler.dispatch(6));

            checkStarvation(scheduler, clients, totals);
            checkQuota(totals, PER_WINDOW);
            expect(totals).toEqual({ a: 2, b: 2, c: 2 });
          });

          it('容量比客户端还少时，轮几次也要轮到 [gate:fair]', () => {
            const scheduler = makeScheduler();
            const clients = ['a', 'b', 'c'];
            for (const client of clients) scheduler.submit(client, 100);
            const totals: Record<string, number> = {};

            // 每轮只发 2 条，三轮下来每人都该拿到
            merge(totals, scheduler.dispatch(2));
            merge(totals, scheduler.dispatch(2));
            merge(totals, scheduler.dispatch(2));

            checkStarvation(scheduler, clients, totals);
            checkQuota(totals, PER_WINDOW);
            expect(Object.keys(totals).slice().sort()).toEqual(['a', 'b', 'c']);
          });

          it('一轮发出去的总数不超过 capacity', () => {
            const scheduler = makeScheduler();
            for (const client of ['a', 'b', 'c']) scheduler.submit(client, 100);

            expect(totalOf(scheduler.dispatch(5))).toBe(5);
            expect(totalOf(scheduler.dispatch(1))).toBe(1);
          });

          it('额度用完的客户端让出容量，不浪费', () => {
            const scheduler = makeScheduler();
            scheduler.submit('greedy', 100);
            scheduler.submit('quiet', 5);
            const totals: Record<string, number> = {};

            merge(totals, scheduler.dispatch(50));

            checkQuota(totals, PER_WINDOW);
            // greedy 只能拿到配额，剩下的容量给了 quiet
            expect(totals['greedy']).toBe(PER_WINDOW);
            expect(totals['quiet']).toBe(5);
          });

          it('没有需求的客户端不占名额', () => {
            const scheduler = makeScheduler();
            scheduler.submit('idle', 0);
            scheduler.submit('busy', 4);

            const granted = scheduler.dispatch(4);

            expect(granted['busy']).toBe(4);
            expect(granted['idle']).toBeUndefined();
          });

          it('需求会累加', () => {
            const scheduler = makeScheduler();
            scheduler.submit('a', 2);
            scheduler.submit('a', 3);

            expect(scheduler.pending('a')).toBe(5);
            expect(scheduler.dispatch(100)['a']).toBe(5);
          });

          it('remaining 反映本窗口剩余额度', () => {
            const scheduler = makeScheduler();
            scheduler.submit('a', 4);

            expect(scheduler.remaining('a')).toBe(PER_WINDOW);
            scheduler.dispatch(100);
            expect(scheduler.remaining('a')).toBe(PER_WINDOW - 4);
          });

          it('没有任何需求时分不出东西', () => {
            const scheduler = makeScheduler();

            expect(scheduler.dispatch(10)).toEqual({});
            expect(scheduler.pending('nobody')).toBe(0);
          });

          it('容量为 0 时什么都不发', () => {
            const scheduler = makeScheduler();
            scheduler.submit('a', 5);

            expect(scheduler.dispatch(0)).toEqual({});
            expect(scheduler.pending('a')).toBe(5);
          });

          it('大家一起来的时候，长期下来分得均匀 [gate:fair]', () => {
            const scheduler = makeScheduler(100);
            const clients = ['a', 'b', 'c', 'd'];
            for (const client of clients) scheduler.submit(client, 50);
            const totals: Record<string, number> = {};

            for (let round = 0; round < 6; round += 1) merge(totals, scheduler.dispatch(6));

            checkStarvation(scheduler, clients, totals);
            for (const client of clients) {
              expect(totals[client]).toBe(9);
            }
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.quotaViolations',
      op: 'eq',
      value: 0,
      zh: '没有客户端在一个窗口里超额',
      en: 'No client exceeds its allowance within a window',
      dimension: 'correctness',
    }),
    gate({
      metric: 'counters.starvedClients',
      op: 'eq',
      value: 0,
      zh: '有需求的客户端一个都没被饿死',
      en: 'No client with demand is ever starved',
      dimension: 'concurrency',
    }),
  ],
  referenceFiles: [
    file(
      'src/quota.ts',
      code`
        import { now } from '@lab/env';

        export interface QuotaOptions {
          perWindow: number;
          windowMs: number;
        }

        export interface FairScheduler {
          submit(clientId: string, want: number): void;
          dispatch(capacity: number): Record<string, number>;
          remaining(clientId: string): number;
          pending(clientId: string): number;
        }

        export function createFairScheduler(options: QuotaOptions): FairScheduler {
          const demand = new Map<string, number>();
          /** 本窗口已经拿了多少 */
          const used = new Map<string, number>();
          /** 客户端的轮转顺序，第一次 submit 时入列 */
          const order: string[] = [];
          let windowStart = now();
          /** 下一轮从第几个开始发 —— 公平的全部秘密 */
          let rotation = 0;

          function rollWindow(): void {
            if (now() < windowStart + options.windowMs) return;
            windowStart = now();
            used.clear();
          }

          function valueOf(table: Map<string, number>, clientId: string): number {
            const value = table.get(clientId);
            return value === undefined ? 0 : value;
          }

          function allowance(clientId: string): number {
            return options.perWindow - valueOf(used, clientId);
          }

          return {
            submit(clientId: string, want: number): void {
              if (!demand.has(clientId)) order.push(clientId);
              demand.set(clientId, valueOf(demand, clientId) + Math.max(0, want));
            },

            dispatch(capacity: number): Record<string, number> {
              rollWindow();
              const granted: Record<string, number> = {};
              if (order.length === 0) return granted;

              let left = Math.max(0, capacity);
              let handed = 0;
              let servedSomeone = true;

              // 一次发一条、循环着发：边界情况全都自然消失
              while (left > 0 && servedSomeone) {
                servedSomeone = false;
                for (let step = 0; step < order.length && left > 0; step += 1) {
                  const clientId = order[(rotation + step) % order.length];
                  if (valueOf(demand, clientId) <= 0) continue;
                  // 额度用完的跳过，但容量继续往下发，不浪费
                  if (allowance(clientId) <= 0) continue;

                  granted[clientId] = (granted[clientId] || 0) + 1;
                  demand.set(clientId, valueOf(demand, clientId) - 1);
                  used.set(clientId, valueOf(used, clientId) + 1);
                  left -= 1;
                  handed += 1;
                  servedSomeone = true;
                }
              }

              // 起点往前推，下一轮换个人打头，排在后面的才轮得到
              rotation = (rotation + handed) % order.length;
              return granted;
            },

            remaining(clientId: string): number {
              rollWindow();
              return Math.max(0, allowance(clientId));
            },

            pending(clientId: string): number {
              return valueOf(demand, clientId);
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
      '**一次发一条，循环着发。** 「先算每人该拿几条再发」听起来更高效，',
      '但那个计算要同时考虑需求、额度、容量三个约束，还要处理除不尽的余数 ——',
      '而一条一条发让这三个约束各自变成一个 `continue`，边界情况自己就消失了。',
      '在这个量级上，简单比省几次循环重要。',
      '',
      '**`rotation` 往前推的格数等于「这一轮发了几条」。** 推 1 格也能防饿死，',
      '但推「发出去的条数」让长期分配更均匀：谁在这一轮吃到了，下一轮就自然排到后面。',
      '',
      '**额度用完是 `continue` 而不是 `break`。** 一个客户端超额了，',
      '只说明它不能再拿，不说明这一轮该结束。写成 break 的话，',
      '一个贪婪客户端会在拿满额度之后顺手把整轮容量作废 ——',
      '限流反而成了另一种形式的不公平。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'Hand out one at a time in a loop. "Compute everyone\'s share, then distribute" sounds more efficient, and',
      'that computation has to satisfy demand, allowance and capacity simultaneously while handling the',
      'remainder of an uneven division. One at a time turns each of those constraints into a `continue` and the',
      'edge cases disappear. At this scale, simple beats saving a few iterations.',
      '',
      'The rotation advances by however many records the round handed out. Advancing by one also prevents',
      'starvation; advancing by the count spreads the long-run allocation more evenly, since whoever ate this',
      'round naturally lands at the back of the next.',
      '',
      'An exhausted allowance is a `continue`, not a `break`. One client being over its quota means it takes no',
      'more, not that the round is over. Written as `break`, a greedy client that fills its quota also voids the',
      'rest of the capacity — turning the throttle into another kind of unfairness.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 12 关 · 组装成一个 broker                                         */
/* ------------------------------------------------------------------ */

const stage12 = {
  id: 'broker-e2e',
  title: t('第 12 关 · 组装成一个 broker', 'Stage 12 · Assembling the broker'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前十一关每一关都是一个零件。这一关把它们接起来，接成一条完整的链路：',
      '',
      '```',
      'publish → 写日志 → 复制到副本 → 高水位放行 → 投递 → ack / 重试 / 死信',
      '```',
      '',
      '组装本身不难 —— 难的是接起来之后，你还能不能说清楚**系统现在的状态**。',
      '',
      '一个跑在生产环境的消息系统，运维最常问的问题只有一个：',
      '「现在积压了多少？」这个数字决定要不要扩容、要不要告警、要不要回滚。',
      '而它出乎意料地容易算错 —— 因为「还没处理完」这件事，',
      '在这条链路上有四个可能的去处：还没提交、在队列里、在飞、已经进死信。',
      '',
      '## 要实现什么',
      '',
      '在 `src/broker.ts` 实现 `createBroker(log, replicas, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `publish(key, value)` | 写入并复制，等够 `minInSync` 个确认才返回 |',
      '| `poll(max)` | 取消息（只取到高水位为止），带 attempt 与 receipt |',
      '| `ack(receipt)` / `nack(receipt, reason)` | 完成 / 失败 |',
      '| `stats()` | 系统当前状态，见下表 |',
      '',
      '`stats()` 要给出：',
      '',
      '| 字段 | 含义 |',
      '| --- | --- |',
      '| `produced` | 发布了多少条 |',
      '| `committed` | 高水位：多少条已经被足够多副本确认 |',
      '| `delivered` / `acked` | 投递次数（含重投）/ 确认条数 |',
      '| `inflight` / `deadLetters` | 在飞条数 / 死信条数 |',
      '| `backlog` | **已提交但还没处理完**的条数 |',
      '| `lag` | **日志末尾与「彻底处理完」之间的差** |',
      '',
      '直接复用前面的模块：第 8 关的复制、第 4 关的投递、第 5 关的重试与死信。',
      '这一关不该出现任何一段「重新实现一遍」的代码。',
      '',
      '## 怎么算过',
      '',
      '- 端到端跑得通：发布、消费、确认，内容和顺序都对；',
      '- **消费者崩溃、毒消息进死信，都不丢消息**',
      '  （门槛 `counters.lostMessages = 0`）；',
      '- 高水位之上的消息不会被投递出去；',
      '- **`lag` 报得准**：用例会自己算一遍真实的 lag 来对照',
      '  （门槛 `counters.lagError ≤ 1`）；',
      '- 全部处理完（ack 或进死信）之后，`lag` 归零。',
      '',
      '## 为什么「处理完」包括死信',
      '',
      '因为 lag 的用途是回答「系统追上了吗」。',
      '',
      '一条永远处理不成功的毒消息，如果一直算在 lag 里，那么 lag 就永远不会归零 ——',
      '监控图上是一条不降的曲线，而值班的人第三次看到它之后就不再相信这个指标了。',
      '',
      '进了死信意味着「这条消息的生命周期结束了，剩下的事交给人」。',
      '它不该继续占着积压量，但它应该出现在 `deadLetters` 里 ——',
      '**换一个指标，而不是消失。**',
      '',
      '## 最容易写错的地方',
      '',
      '用「投递次数」算积压。',
      '',
      '`delivered` 里包含重投：一条消息投了三次就被数了三次。',
      '拿它去减，积压量会随着重试**变成负数**，而负的积压量看起来像个显示 bug，',
      '于是没人当回事 —— 直到某天它是正的，而系统真的在积压。',
      '',
      '积压要用「彻底完成」的数字算：ack 掉的，加上进了死信的。',
    ].join('\n'),
    [
      'Each of the eleven previous stages built one part. This one wires them into a single path:',
      '',
      '```',
      'publish → log → replicate → watermark → deliver → ack / retry / dead letter',
      '```',
      '',
      'The wiring is not the hard part. The hard part is whether, once wired, you can still state **what the',
      'system is doing right now.**',
      '',
      'For a message system in production, operators ask one question more than any other: "how far behind are',
      'we?" That number decides whether to scale out, whether to page someone, whether to roll back. And it is',
      'surprisingly easy to compute wrongly, because "not finished yet" has four possible homes on this path:',
      'not yet committed, waiting in the queue, in flight, or already dead-lettered.',
      '',
      '## What to build',
      '',
      'Implement `createBroker(log, replicas, options)` in `src/broker.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `publish(key, value)` | Write and replicate, returning once `minInSync` have acknowledged |',
      '| `poll(max)` | Take messages (only up to the watermark) with attempt and receipt |',
      '| `ack(receipt)` / `nack(receipt, reason)` | Done / failed |',
      '| `stats()` | The current state, below |',
      '',
      '`stats()` reports:',
      '',
      '| Field | Meaning |',
      '| --- | --- |',
      '| `produced` | How many were published |',
      '| `committed` | The high watermark: how many are acknowledged by enough replicas |',
      '| `delivered` / `acked` | Deliveries (redeliveries included) / completions |',
      '| `inflight` / `deadLetters` | Currently out / dead-lettered |',
      '| `backlog` | **Committed but not finished** |',
      '| `lag` | **The distance between the end of the log and "fully finished"** |',
      '',
      'Reuse the earlier modules directly: replication from stage 8, delivery from stage 4, retries and dead',
      'letters from stage 5. Nothing here should be a reimplementation.',
      '',
      '## What counts as passing',
      '',
      '- The end-to-end path works: publish, consume, acknowledge, with the right content and order;',
      '- **A consumer crash and a poison message both lose nothing**',
      '  (the `counters.lostMessages = 0` gate);',
      '- Nothing above the high watermark is ever delivered;',
      '- **`lag` is accurate**: the specs compute the true lag independently and compare',
      '  (the `counters.lagError ≤ 1` gate);',
      '- Once everything is finished — acknowledged or dead-lettered — `lag` is zero.',
      '',
      '## Why "finished" includes dead letters',
      '',
      'Because lag exists to answer "have we caught up".',
      '',
      'A poison message that can never succeed, if it stays in the lag forever, means the lag never returns to',
      'zero — a line on a dashboard that never comes down, and after the third time the on-call engineer sees',
      'it, they stop believing the metric.',
      '',
      'Dead-lettering means "this message\'s lifecycle is over, the rest is a human problem". It should stop',
      'counting as backlog and it should appear in `deadLetters` — **moved to another metric, not erased.**',
      '',
      '## The easiest thing to get wrong',
      '',
      'Computing backlog from the delivery count.',
      '',
      '`delivered` includes redeliveries: a message delivered three times is counted three times. Subtract with',
      'it and the backlog goes **negative** under retries — and a negative backlog looks like a display bug, so',
      'nobody investigates. Until the day it is positive and the system really is falling behind.',
      '',
      'Backlog is computed from what truly finished: acknowledged plus dead-lettered.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  PUB["publish(key, value)"] --> REP["第 8 关的复制日志<br/>replicated.produce"]',
      '  REP --> WAIT["等够 minInSync 个确认"]',
      '  WAIT --> HW["高水位前移"]',
      '',
      '  HW --> VIEW["受高水位限制的日志视图<br/>read 只到高水位为止"]',
      '  VIEW --> DQ["第 4 关的投递队列"]',
      '  DQ --> RQ["第 5 关的重试队列<br/>退避、上限、死信"]',
      '  RQ --> POLL["broker.poll(max)"]',
      '  POLL --> APP["消费者处理"]',
      '  APP --> OK["ack：acked 加一"]',
      '  APP --> BAD["nack：退避重投，够次数进死信"]',
      '',
      '  OK --> ST["stats()"]',
      '  BAD --> ST',
      '  ST --> CALC["done = acked + deadLetters<br/>backlog = 高水位 - done<br/>lag = 日志末尾 - done"]',
      '```',
      '',
      '要点：这张图里没有一个新的存储或状态 —— `stats()` 用的每个数字，',
      '要么来自某个已有模块，要么是两个已有数字相减。',
      '组装层一旦开始自己存状态，它和被组装的模块之间就会出现第二份真相。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  PUB["publish(key, value)"] --> REP["the replicated log from stage 8<br/>replicated.produce"]',
      '  REP --> WAIT["await minInSync acknowledgements"]',
      '  WAIT --> HW["the watermark advances"]',
      '',
      '  HW --> VIEW["a watermark-limited log view<br/>read stops at the watermark"]',
      '  VIEW --> DQ["the delivery queue from stage 4"]',
      '  DQ --> RQ["the retry queue from stage 5<br/>backoff, limit, dead letters"]',
      '  RQ --> POLL["broker.poll(max)"]',
      '  POLL --> APP["the consumer processes"]',
      '  APP --> OK["ack: acked + 1"]',
      '  APP --> BAD["nack: back off, retry, eventually dead-letter"]',
      '',
      '  OK --> ST["stats()"]',
      '  BAD --> ST',
      '  ST --> CALC["done = acked + deadLetters<br/>backlog = watermark - done<br/>lag = log end - done"]',
      '```',
      '',
      'The point: there is no new storage or state in this diagram — every number in `stats()` either comes',
      'from an existing module or is the difference of two of them. The moment an assembly layer starts keeping',
      'its own state, a second version of the truth appears alongside the modules it assembles.',
    ].join('\n')
  ),
  checklist: [
    t('直接复用前面几关的模块', 'The earlier modules are reused as they are'),
    t('投递只看到高水位以下的数据', 'Delivery only sees below the watermark'),
    t('done = acked + 死信', 'Finished means acknowledged plus dead-lettered'),
    t('backlog 与 lag 各自的口径写清楚', 'backlog and lag each have a stated definition'),
    t('组装层不自己存状态', 'The assembly layer keeps no state of its own'),
  ],
  pitfalls: [
    t(
      '用投递次数算积压。`delivered` 含重投，一条消息投三次就数三次，减出来的积压会在重试多的时候变成负数。负的积压看起来像显示 bug，于是没人查 —— 直到它变成正的，而那时系统是真的在积压。',
      'Computing backlog from the delivery count. `delivered` includes redeliveries, so a message delivered three times counts three times and the subtraction goes negative under retries. A negative backlog looks like a display bug and nobody investigates — until it is positive and the system really is behind.'
    ),
    t(
      '把死信继续算进 lag。lag 于是永远不会归零，监控图上留下一条不降的线，而值班的人很快就学会忽略这个指标。指标失去可信度的代价，比这条曲线本身高得多。',
      'Keeping dead letters in the lag. It then never returns to zero, a dashboard line never comes down, and the on-call engineer quickly learns to ignore that metric. The cost of a metric losing credibility is far higher than the line itself.'
    ),
    t(
      '在组装层重新实现一遍投递或重试。「反正只有几行」——然后这几行和第 4、5 关的语义慢慢分叉：那边改了退避策略，这边没有；那边修了一个边界，这边还留着。组装层的价值恰恰在于它不含逻辑。',
      'Reimplementing delivery or retries inside the assembly layer. "It is only a few lines" — and those lines slowly diverge from stages 4 and 5: the backoff policy changes there and not here, a boundary is fixed there and not here. The value of an assembly layer is precisely that it holds no logic.'
    ),
    t(
      '让 stats() 自己维护一份计数器来记录「还有多少没处理」。两份真相立刻开始漂移：某条路径忘了减一，这个数字就再也回不到零，而你无法从代码上看出是哪一条路径漏了。能相减得到的数字，不要另存一份。',
      'Having `stats()` maintain its own counter of outstanding work. Two versions of the truth start drifting immediately: one path forgets to decrement and the number never returns to zero, with no way to tell from the code which path leaked. A number you can subtract for is a number you should not store.'
    ),
  ],
  hints: [
    t(
      '「受高水位限制的日志视图」只是一个对象字面量：read 转发给 replicated.read，其余方法转发给原来的日志。第 4 关的队列拿到它之后什么都不用改。',
      'The watermark-limited view is one object literal: `read` forwards to `replicated.read` and the rest forward to the original log. The stage 4 queue needs no change to consume it.'
    ),
    t(
      'ack 的计数放在 `queue.ack` 返回 true 的分支里 —— 无效的 receipt 不该让 acked 变大。',
      'Increment the acked counter only when `queue.ack` returns true; an invalid receipt must not move it.'
    ),
  ],
  extension: t(
    [
      '真实 broker 的可观测性远不止一个 lag。Kafka 暴露的核心指标里，',
      '有几个和这一关直接对应：`records-lag-max`（消费者落后多少）、',
      '`UnderReplicatedPartitions`（有多少分区的 ISR 不完整）、',
      '`RequestHandlerAvgIdlePercent`（broker 线程还有多少余量）。',
      '',
      '这三个指标合起来能回答「问题出在哪一端」：',
      'lag 高但 broker 空闲 = 消费者不行；lag 高且 broker 满负载 = broker 不行；',
      'lag 正常但 under-replicated = 现在没事，但一台机器挂掉就会出事。',
      '**单独一个指标几乎不能定位任何问题**，这也是为什么 `stats()` 要给出一组，',
      '而不是一个「健康度」。',
      '',
      '还有一件这一关没做、但每个真实系统都要做的事：**lag 的时间维度**。',
      '「落后 10000 条」在不同流量下的含义天差地别 ——',
      '所以真实系统同时报告 lag（条数）和 lag time（按当前速率要多久追上）。',
      '后者才是人能直接决策的那个数字。',
    ].join('\n'),
    [
      'A real broker exposes far more than one lag number. Among the core Kafka metrics, several map directly',
      'onto this stage: `records-lag-max` (how far a consumer is behind), `UnderReplicatedPartitions` (how many',
      'partitions have an incomplete ISR), `RequestHandlerAvgIdlePercent` (how much headroom the broker threads',
      'have).',
      '',
      'Together those three answer "which end is the problem": high lag with an idle broker means the consumer',
      'cannot keep up; high lag with a saturated broker means the broker cannot; healthy lag with',
      'under-replicated partitions means nothing is wrong now and one machine failure will change that.',
      '**A single metric localises almost nothing**, which is why `stats()` returns a set rather than a health',
      'score.',
      '',
      'One thing omitted here that every real system needs: **lag over time.** "Ten thousand records behind"',
      'means wildly different things at different throughputs, so production systems report both lag in records',
      'and lag in time — how long catching up would take at the current rate. The second is the number a human',
      'can actually act on.',
    ].join('\n')
  ),
  focus: ['correctness', 'encapsulation', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/broker.ts',
      code`
        import { createDeliveryQueue } from './delivery';
        import { createRetryingQueue } from './redelivery';
        import type { RetryDelivery } from './redelivery';
        import { createReplicatedLog } from './replication';
        import type { MessageLog } from './log';
        import type { Replica } from './support/replica';

        export interface BrokerOptions {
          /** 至少几个副本确认才算提交 */
          minInSync: number;
          /** 落后多少条就移出 ISR */
          maxLagRecords: number;
          /** 投出去多久没回音算失败 */
          visibilityMs: number;
          /** 最多投几次 */
          maxAttempts: number;
          /** 退避基数 */
          baseBackoffMs: number;
        }

        export interface BrokerStats {
          produced: number;
          /** 高水位 */
          committed: number;
          /** 投递次数，含重投 */
          delivered: number;
          acked: number;
          inflight: number;
          deadLetters: number;
          /** 已提交但还没处理完 */
          backlog: number;
          /** 日志末尾与「彻底处理完」之间的差 */
          lag: number;
        }

        export interface Broker {
          publish(key: string, value: string): Promise<number>;
          poll(max: number): RetryDelivery[];
          ack(receipt: string): boolean;
          nack(receipt: string, reason: string): void;
          stats(): BrokerStats;
        }

        export function createBroker(
          log: MessageLog,
          replicas: Replica[],
          options: BrokerOptions
        ): Broker {
          // TODO: 在这里实现，直接复用前面几关的模块
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
        import { createBroker } from '../src/broker';
        import { createIndexedLog } from '../src/offsetIndex';
        import { createStorage } from '../src/support/storage';
        import { createReplica } from '../src/support/replica';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const VISIBILITY = 500;
        const BACKOFF = 100;
        const MAX_ATTEMPTS = 3;

        function makeBroker() {
          const storage = createStorage();
          const log = createIndexedLog(storage, { segmentBytes: 24000, indexInterval: 16 });
          const replicas = [
            createReplica('r1', { lagMs: 10 }),
            createReplica('r2', { lagMs: 10 }),
            createReplica('r3', { lagMs: 40 }),
          ];
          const broker = createBroker(log, replicas, {
            minInSync: 2,
            maxLagRecords: 2,
            visibilityMs: VISIBILITY,
            maxAttempts: MAX_ATTEMPTS,
            baseBackoffMs: BACKOFF,
          });
          return { storage, log, replicas, broker };
        }

        async function publishMany(broker: any, total: number): Promise<void> {
          for (let index = 0; index < total; index += 1) {
            await broker.publish('k' + String(index).padStart(3, '0'), 'v' + index);
          }
        }

        /** 用例自己算一遍真实的 lag：发出去的减去彻底完成的 */
        function checkLag(broker: any, published: number): void {
          const stats = broker.stats();
          const truth = published - stats.acked - stats.deadLetters;
          count('lagError', Math.abs(stats.lag - truth));
        }

        /** 一直消费到没东西可消费为止，返回处理过的 key */
        async function drain(broker: any, rounds: number): Promise<Set<string>> {
          const seen = new Set<string>();
          for (let round = 0; round < rounds; round += 1) {
            for (const delivery of broker.poll(10)) {
              seen.add(delivery.record.key);
              broker.ack(delivery.receipt);
            }
            await sleep(VISIBILITY);
          }
          return seen;
        }

        describe('阶段12 · 组装成一个 broker', () => {
          it('端到端跑得通', async () => {
            const context = makeBroker();
            await publishMany(context.broker, 3);

            const batch = context.broker.poll(10);

            expect(batch).toHaveLength(3);
            expect(batch.map((delivery: any) => delivery.record.value)).toEqual(['v0', 'v1', 'v2']);
            expect(batch[0].attempt).toBe(1);
          });

          it('全部确认之后 lag 归零', async () => {
            const context = makeBroker();
            await publishMany(context.broker, 5);

            for (const delivery of context.broker.poll(10)) context.broker.ack(delivery.receipt);

            checkLag(context.broker, 5);
            expect(context.broker.stats().lag).toBe(0);
            expect(context.broker.stats().backlog).toBe(0);
          });

          it('还没确认时 lag 等于未完成条数', async () => {
            const context = makeBroker();
            await publishMany(context.broker, 5);

            const batch = context.broker.poll(2);
            context.broker.ack(batch[0].receipt);

            checkLag(context.broker, 5);
            expect(context.broker.stats().lag).toBe(4);
          });

          it('消费者崩溃也不丢消息', async () => {
            const context = makeBroker();
            await publishMany(context.broker, 6);

            // 前两条正常处理，接着两条投出去就没人管了
            const first = context.broker.poll(2);
            for (const delivery of first) context.broker.ack(delivery.receipt);
            context.broker.poll(2);

            const seen = await drain(context.broker, 6);
            for (const delivery of first) seen.add(delivery.record.key);

            for (let index = 0; index < 6; index += 1) {
              if (!seen.has('k' + String(index).padStart(3, '0'))) count('lostMessages');
            }
            checkLag(context.broker, 6);
            expect(context.broker.stats().lag).toBe(0);
          });

          it('毒消息进死信之后 lag 照样归零', async () => {
            const context = makeBroker();
            await publishMany(context.broker, 3);

            for (let round = 0; round < 8; round += 1) {
              for (const delivery of context.broker.poll(10)) {
                if (delivery.record.value === 'v0') {
                  context.broker.nack(delivery.receipt, 'bad payload');
                } else {
                  context.broker.ack(delivery.receipt);
                }
              }
              await sleep(BACKOFF * 8);
            }

            const stats = context.broker.stats();
            checkLag(context.broker, 3);
            expect(stats.deadLetters).toBe(1);
            expect(stats.acked).toBe(2);
            expect(stats.lag).toBe(0);
          });

          it('高水位之上的消息不会被投递', async () => {
            const context = makeBroker();
            context.replicas[1].stall(200);
            context.replicas[2].stall(200);

            const pending = context.broker.publish('k000', 'v0');

            // 只有一个副本确认，达不到 minInSync：写下了，但还没提交
            expect(context.broker.poll(10)).toEqual([]);
            expect(context.broker.stats().committed).toBe(0);

            await pending;
            expect(context.broker.stats().committed).toBe(1);
            expect(context.broker.poll(10)).toHaveLength(1);
          });

          it('backlog 反映已提交但没处理完的部分', async () => {
            const context = makeBroker();
            await publishMany(context.broker, 4);

            const batch = context.broker.poll(4);
            context.broker.ack(batch[0].receipt);
            context.broker.ack(batch[1].receipt);

            const stats = context.broker.stats();
            expect(stats.committed).toBe(4);
            expect(stats.backlog).toBe(2);
          });

          it('inflight 反映在飞的条数', async () => {
            const context = makeBroker();
            await publishMany(context.broker, 4);

            const batch = context.broker.poll(3);
            expect(context.broker.stats().inflight).toBe(3);

            context.broker.ack(batch[0].receipt);
            expect(context.broker.stats().inflight).toBe(2);
          });

          it('重投不会让 backlog 变成负数', async () => {
            const context = makeBroker();
            await publishMany(context.broker, 2);

            for (const delivery of context.broker.poll(2)) {
              context.broker.nack(delivery.receipt, 'retry me');
            }
            await sleep(BACKOFF);
            for (const delivery of context.broker.poll(2)) {
              context.broker.nack(delivery.receipt, 'retry me');
            }

            const stats = context.broker.stats();
            expect(stats.delivered).toBeGreaterThan(2);
            expect(stats.backlog).toBe(2);
            checkLag(context.broker, 2);
          });

          it('无效的 receipt 不会让 acked 变大', async () => {
            const context = makeBroker();
            await publishMany(context.broker, 1);
            context.broker.poll(1);

            expect(context.broker.ack('r-made-up')).toBe(false);
            expect(context.broker.stats().acked).toBe(0);
          });

          it('五十条消息全流程走完，一条不丢', async () => {
            const context = makeBroker();
            await publishMany(context.broker, 50);

            const seen = await drain(context.broker, 8);

            for (let index = 0; index < 50; index += 1) {
              if (!seen.has('k' + String(index).padStart(3, '0'))) count('lostMessages');
            }
            checkLag(context.broker, 50);
            expect(seen.size).toBe(50);
            expect(context.broker.stats().lag).toBe(0);
          });

          it('空 broker 的统计全是零', () => {
            const context = makeBroker();

            expect(context.broker.stats()).toEqual({
              produced: 0,
              committed: 0,
              delivered: 0,
              acked: 0,
              inflight: 0,
              deadLetters: 0,
              backlog: 0,
              lag: 0,
            });
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.lostMessages',
      op: 'eq',
      value: 0,
      zh: '端到端一条消息都不丢',
      en: 'The end-to-end path loses nothing',
      dimension: 'resilience',
    }),
    gate({
      metric: 'counters.lagError',
      op: 'lte',
      value: 1,
      zh: '报出来的 lag 与真实值相差不超过 1',
      en: 'The reported lag is within one of the truth',
      dimension: 'correctness',
    }),
  ],
  referenceFiles: [
    file(
      'src/broker.ts',
      code`
        import { createDeliveryQueue } from './delivery';
        import { createRetryingQueue } from './redelivery';
        import type { RetryDelivery } from './redelivery';
        import { createReplicatedLog } from './replication';
        import type { MessageLog } from './log';
        import type { Replica } from './support/replica';

        export interface BrokerOptions {
          minInSync: number;
          maxLagRecords: number;
          visibilityMs: number;
          maxAttempts: number;
          baseBackoffMs: number;
        }

        export interface BrokerStats {
          produced: number;
          committed: number;
          delivered: number;
          acked: number;
          inflight: number;
          deadLetters: number;
          backlog: number;
          lag: number;
        }

        export interface Broker {
          publish(key: string, value: string): Promise<number>;
          poll(max: number): RetryDelivery[];
          ack(receipt: string): boolean;
          nack(receipt: string, reason: string): void;
          stats(): BrokerStats;
        }

        export function createBroker(
          log: MessageLog,
          replicas: Replica[],
          options: BrokerOptions
        ): Broker {
          const replicated = createReplicatedLog(log, replicas, {
            minInSync: options.minInSync,
            maxLagRecords: options.maxLagRecords,
          });

          /**
           * 给投递侧看的日志视图：读只到高水位为止。
           * 除了 read，其余方法原样转发 —— 这一层不含任何逻辑。
           */
          const visible: MessageLog = {
            append: (key: string, value: string) => log.append(key, value),
            read: (offset: number, max: number) => replicated.read(offset, max),
            endOffset: () => replicated.highWatermark(),
            segments: () => log.segments(),
            flush: () => log.flush(),
          };

          const source = createDeliveryQueue(visible, { visibilityMs: options.visibilityMs });
          const queue = createRetryingQueue(source, {
            visibilityMs: options.visibilityMs,
            maxAttempts: options.maxAttempts,
            baseBackoffMs: options.baseBackoffMs,
          });

          let produced = 0;
          let delivered = 0;
          let acked = 0;

          return {
            async publish(key: string, value: string): Promise<number> {
              const offset = await replicated.produce(key, value);
              produced += 1;
              return offset;
            },

            poll(max: number): RetryDelivery[] {
              const batch = queue.poll(max);
              delivered += batch.length;
              return batch;
            },

            ack(receipt: string): boolean {
              const done = queue.ack(receipt);
              // 无效的 receipt 什么都没完成，不该让计数变大
              if (done) acked += 1;
              return done;
            },

            nack(receipt: string, reason: string): void {
              queue.nack(receipt, reason);
            },

            stats(): BrokerStats {
              const dead = queue.deadLetters().length;
              // 「彻底完成」= 确认掉的 + 进了死信的。投递次数含重投，不能用来减。
              const finished = acked + dead;

              return {
                produced,
                committed: replicated.highWatermark(),
                delivered,
                acked,
                inflight: queue.inflight(),
                deadLetters: dead,
                backlog: Math.max(0, replicated.highWatermark() - finished),
                lag: Math.max(0, replicated.endOffset() - finished),
              };
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
      '**`visible` 是一个纯转发的对象字面量。** 它把「高水位限制可见性」这件事',
      '表达成了「换一个日志给投递层看」，于是第 4 关的队列一行都不用改。',
      '这是组装层该有的样子：接线，不加逻辑。',
      '',
      '**`stats()` 里没有一个自己维护的「未完成数」。** 所有数字要么来自模块',
      '（`queue.inflight()`、`replicated.highWatermark()`），要么是两个数相减。',
      '自己维护一份计数器意味着每条路径都要记得增减，而漏掉一条的后果是',
      '「这个数再也回不到零」—— 而且看代码看不出来是哪条路径漏了。',
      '',
      '**`finished = acked + dead`。** 这一行是这一关唯一的业务判断：',
      '「进了死信也算处理完」。它值得单独写成一个变量并加一句注释，',
      '因为它是所有 lag 类指标里最容易被争论、也最容易被写错的一处口径。',
      '',
      '最后那两个 `Math.max(0, ...)` 不是防御性编程的装饰：',
      '在极短的时间窗里，高水位可能还没跟上已经完成的条数（复制在飞），',
      '而一个负数的积压量会让上层的告警规则彻底失效。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      '`visible` is a pure forwarding object literal. It expresses "the watermark limits visibility" as',
      '"hand the delivery layer a different log", so the stage 4 queue needs no change at all. That is what an',
      'assembly layer should look like: wiring, not logic.',
      '',
      '`stats()` maintains no "outstanding" counter of its own. Every number either comes from a module',
      '(`queue.inflight()`, `replicated.highWatermark()`) or is one number minus another. A private counter',
      'means every path must remember to adjust it, and missing one leaves a number that never returns to zero',
      '— with no way to see from the code which path leaked.',
      '',
      '`finished = acked + dead`. That line is the single business judgement of this stage: dead-lettered',
      'counts as finished. It deserves its own variable and a comment, because it is the most argued-over and',
      'most frequently miswritten definition among lag metrics.',
      '',
      'The two `Math.max(0, …)` calls are not defensive decoration: within a very short window the watermark',
      'can trail the finished count while replication is in flight, and a negative backlog silently breaks',
      'every alerting rule built on top of it.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

module.exports = {
  id: 'message-broker',
  title: t('高并发消息系统', 'A high-throughput message broker'),
  summary: t(
    '十二关造出一个消息中间件：分段日志、稀疏索引、攒批落盘、至少一次投递、重投与死信、扇出订阅、credit 流控、副本同步与高水位、保留与压缩、心跳与再平衡、配额公平，最后组装成一个能报 lag 的 broker。',
    'Twelve stages building a message broker: a segmented log, a sparse index, batched writes, at-least-once delivery, redelivery and dead letters, fan-out subscriptions, credit-based flow control, replication with a high watermark, retention and compaction, heartbeats and rebalancing, per-client quotas, and finally a broker that reports its own lag.'
  ),
  difficulty: 'Hard',
  domain: 'messaging',
  tags: [
    'message-queue',
    'kafka',
    'log-structured-storage',
    'replication',
    'flow-control',
    'backpressure',
    'delivery-semantics',
    'dead-letter-queue',
    'quotas',
  ],
  estimatedMinutes: 600,
  language: 'typescript',
  weights: {
    correctness: 3,
    concurrency: 2,
    latency: 2,
    resilience: 2,
    encapsulation: 1.5,
    elegance: 1.5,
  },
  brief: t(
    [
      '## 背景',
      '',
      '这道题不是「用消息队列」，是**造一个**。',
      '',
      '所有消息中间件——Kafka、RabbitMQ、Pulsar、SQS——都在回答同一组问题，',
      '只是答案不同。十二关按这些问题分组：',
      '',
      '| 层 | 关卡 | 回答的问题 |',
      '| --- | --- | --- |',
      '| 存储 | 1-3 | 消息落在盘上是什么样，怎么定位，怎么写才不慢 |',
      '| 投递 | 4-7 | 怎么保证不丢，怎么处理消费失败，一份数据怎么给多个订阅者，推多快 |',
      '| 可靠性 | 8-10 | 副本怎么同步，旧数据怎么清，消费者宕了怎么办 |',
      '| 多租户与收口 | 11-12 | 一个客户端能不能拖垮别人，以及怎么知道系统落后了多少 |',
      '',
      '十二关做完，你手上是一个能持久化、能重放、能容忍消费者崩溃、',
      '能在副本掉队时保证不读到未提交数据、并且会自己报告积压量的消息系统。',
      '',
      '## 平台提供什么',
      '',
      '`src/support/storage.ts` 是一块分段日志设备，只读。它保留了真实盘的三个特性：',
      '',
      '```ts',
      'storage.append(segmentId, record);   // 顺序写，便宜',
      'storage.overwrite(segmentId, i, r);  // 随机写，每次记一笔 randomWrites',
      'await storage.fsync();               // 5ms，到这一步才算持久',
      'storage.crash();                     // 没 fsync 的追加全部消失',
      '```',
      '',
      '每次 `readAt` 也会计数，所以「定位一条消息扫了多少条」是能被量出来的。',
      '',
      '`src/support/replica.ts` 是可配置延迟的从副本，第 8 关用它做 ISR 与高水位。',
      '',
      '## 这十二关怎么串起来',
      '',
      '前一关的产物就是后一关的地基：',
      '',
      '- 稀疏索引（2）索的是分段日志（1）的段与下标；',
      '- 投递（4）读的是攒批写下去（3）的那份日志；',
      '- 重投与死信（5）建在投递的 in-flight 表上；',
      '- 扇出（6）证明多个订阅共用同一份存储；',
      '- 高水位（8）决定投递能读到哪里为止；',
      '- 第 12 关把它们接成一条完整的链路，并暴露 lag。',
      '',
      '## 硬性约束',
      '',
      '1. 日志只能追加。更新一条消息的办法是再追加一条，不是回去改；',
      '2. `fsync` 之前的数据不算持久，掉电就是丢了；',
      '3. 投递语义是**至少一次**：宁可重复，不可丢失；',
      '4. 高水位之上的数据不可见，哪怕它已经写在 leader 上；',
      '5. 一个客户端的行为不得让别的客户端饿死。',
      '',
      '## 非目标',
      '',
      '- 不做网络协议、序列化格式、消费者组的分区分配算法细节；',
      '- 不做恰好一次（exactly-once）——它需要事务和幂等生产者，篇幅放不下；',
      '- 不做真正的多线程：并发用协作式 async 模拟，时序语义完全一致。',
      '',
      '## 术语',
      '',
      '- **offset**：一条消息在日志里的位置，单调递增。',
      '- **段（segment）**：日志被切成的一个个文件，删旧数据是按段删的。',
      '- **稀疏索引**：每隔 N 条记一个锚点，用少量内存换定位速度。',
      '- **in-flight**：已经投递出去、还没被 ack 的消息。',
      '- **可见性超时**：一条消息投出去多久没 ack 就重新可投。',
      '- **ISR**：与 leader 保持同步的副本集合。',
      '- **高水位**：ISR 全部确认到的位置，消费者只能读到这里。',
      '- **credit / prefetch**：消费者告诉 broker「我还能接几条」的额度。',
      '- **lag**：日志末尾与消费位置之间的差，也就是积压量。',
    ].join('\n'),
    [
      '## Context',
      '',
      'This project is not about using a message queue. It is about **building one.**',
      '',
      'Every broker — Kafka, RabbitMQ, Pulsar, SQS — answers the same set of questions with different',
      'answers. The twelve stages are grouped by those questions:',
      '',
      '| Layer | Stages | Questions it answers |',
      '| --- | --- | --- |',
      '| Storage | 1-3 | What a message looks like on disk, how to find it, how to write without being slow |',
      '| Delivery | 4-7 | How nothing is lost, what happens when consumption fails, how one copy serves many subscribers, how fast to push |',
      '| Reliability | 8-10 | How replicas sync, how old data is reclaimed, what happens when a consumer dies |',
      '| Fairness and closure | 11-12 | Whether one client can sink the others, and how you know how far behind you are |',
      '',
      'Twelve stages later you have a system that persists and replays messages, survives consumer crashes,',
      'refuses to serve uncommitted data while a replica lags, and reports its own backlog.',
      '',
      '## What the platform gives you',
      '',
      '`src/support/storage.ts` is a read-only segmented log device with three real-disk behaviours:',
      '',
      '```ts',
      'storage.append(segmentId, record);   // sequential, cheap',
      'storage.overwrite(segmentId, i, r);  // random write, counted as randomWrites',
      'await storage.fsync();               // 5ms, and only now is it durable',
      'storage.crash();                     // everything not fsynced is gone',
      '```',
      '',
      'Every `readAt` is counted too, so "how many records did you scan to find one" is a measurement.',
      '',
      '`src/support/replica.ts` is a follower with configurable lag, used by stage 8 for the ISR and the high',
      'watermark.',
      '',
      '## How the twelve stages connect',
      '',
      'Each stage is the ground the next one stands on:',
      '',
      '- the sparse index (2) indexes the segments and slots of the log (1);',
      '- delivery (4) reads the log that batching (3) wrote;',
      '- redelivery and dead letters (5) build on the in-flight table of delivery;',
      '- fan-out (6) proves many subscriptions share one copy of the data;',
      '- the high watermark (8) decides how far delivery may read;',
      '- stage 12 wires them into one path and exposes the lag.',
      '',
      '## Hard constraints',
      '',
      '1. The log is append-only. Updating a message means appending another one, never going back;',
      '2. Data before an `fsync` is not durable; a crash loses it;',
      '3. Delivery is **at least once**: duplicates are acceptable, losses are not;',
      '4. Nothing above the high watermark is visible, even if the leader already holds it;',
      '5. One client must never starve another.',
      '',
      '## Non-goals',
      '',
      '- No wire protocol, no serialisation format, no consumer-group assignment algorithm in detail;',
      '- No exactly-once semantics — that needs transactions and an idempotent producer, which do not fit;',
      '- No real threads: concurrency is cooperative async with identical ordering semantics.',
      '',
      '## Glossary',
      '',
      '- Offset: the monotonically increasing position of a message in the log.',
      '- Segment: one of the files the log is cut into; old data is reclaimed a segment at a time.',
      '- Sparse index: an anchor every N records, trading a little memory for lookup speed.',
      '- In-flight: delivered but not yet acknowledged.',
      '- Visibility timeout: how long an unacknowledged delivery stays hidden before it comes back.',
      '- ISR: the set of replicas keeping up with the leader.',
      '- High watermark: the position every ISR member has acknowledged; consumers may read no further.',
      '- Credit / prefetch: how many messages a consumer says it can still take.',
      '- Lag: the distance between the end of the log and a consumer position — the backlog.',
    ].join('\n')
  ),
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  P["producer"] --> B["3 batching and linger"]',
      '  B --> L["1 segmented log"]',
      '  L --> IDX["2 sparse offset index"]',
      '  L --> REP["8 replicas and high watermark"]',
      '  REP --> HW["visible up to the watermark"]',
      '  HW --> D["4 delivery, in-flight, ack"]',
      '  D --> R["5 redelivery and dead letters"]',
      '  D --> F["6 fan-out subscriptions"]',
      '  F --> FC["7 credit based push"]',
      '  FC --> Q["11 per client quota"]',
      '  Q --> C["consumers"]',
      '  C --> HB["10 heartbeat and rebalance"]',
      '  HB --> D',
      '  L --> RET["9 retention and compaction"]',
      '  D --> E2E["12 broker, lag and backlog"]',
      '```',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  P["producer"] --> B["3 batching and linger"]',
      '  B --> L["1 segmented log"]',
      '  L --> IDX["2 sparse offset index"]',
      '  L --> REP["8 replicas and high watermark"]',
      '  REP --> HW["visible up to the watermark"]',
      '  HW --> D["4 delivery, in-flight, ack"]',
      '  D --> R["5 redelivery and dead letters"]',
      '  D --> F["6 fan-out subscriptions"]',
      '  F --> FC["7 credit based push"]',
      '  FC --> Q["11 per client quota"]',
      '  Q --> C["consumers"]',
      '  C --> HB["10 heartbeat and rebalance"]',
      '  HB --> D',
      '  L --> RET["9 retention and compaction"]',
      '  D --> E2E["12 broker, lag and backlog"]',
      '```',
    ].join('\n')
  ),
  files: [storage, replica],
  stages: [stage1, stage2, stage3, stage4, stage5, stage6, stage7, stage8, stage9, stage10, stage11, stage12],
};
