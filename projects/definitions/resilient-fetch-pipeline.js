/**
 * 工程实战 · 高可用抓取管线
 *
 * 注意：本文件里的代码片段使用 String.raw 模板，
 * 因此**不要**在片段里使用 `${}` 模板字符串，用字符串拼接代替。
 */
const { t, code, file, readonlyFile, spec, gate } = require('./_helpers');

const contract = readonlyFile(
  'src/contract.ts',
  code`
    /**
     * Contract file provided by the platform (read-only)
     * Your implementation has to satisfy the types here; the hidden specs check against them.
     */

    export interface PageResult {
      /** The URL requested */
      url: string;
      /** Whether the data was fetched successfully */
      ok: boolean;
      /** The response body on success, null on failure */
      data: unknown;
      /** Failure reason; may be omitted on success */
      error?: string;
    }

    export interface FetchOptions {
      /** Concurrency ceiling; serial when omitted */
      concurrency?: number;
      /** Maximum retries for a single URL */
      retries?: number;
      /** Base backoff delay for retries */
      baseDelayMs?: number;
      /** Cache lifetime */
      ttlMs?: number;
      /** Cancellation signal */
      signal?: CancelToken;
    }

    export interface CancelToken {
      readonly cancelled: boolean;
      throwIfCancelled(): void;
      onCancel(listener: () => void): void;
    }
  `
);

const cancelSupport = readonlyFile(
  'src/support/cancel.ts',
  code`
    /** Cancellation token provided by the platform (read-only), used much like AbortController */
    import type { CancelToken } from '../contract';

    export class CancelledError extends Error {
      constructor() {
        super('operation cancelled');
        this.name = 'CancelledError';
      }
    }

    export function createCancelSource(): { token: CancelToken; cancel(): void } {
      let cancelled = false;
      const listeners: Array<() => void> = [];

      const token: CancelToken = {
        get cancelled() {
          return cancelled;
        },
        throwIfCancelled() {
          if (cancelled) throw new CancelledError();
        },
        onCancel(listener: () => void) {
          if (cancelled) listener();
          else listeners.push(listener);
        },
      };

      return {
        token,
        cancel() {
          if (cancelled) return;
          cancelled = true;
          listeners.splice(0).forEach((listener) => listener());
        },
      };
    }
  `
);

/* ------------------------------------------------------------------ */
/* 阶段 1：契约与错误边界                                               */
/* ------------------------------------------------------------------ */

const stage1 = {
  id: 'contract',
  title: t('第 1 关 · 打通契约与错误边界', 'Stage 1 · Contract and error boundary'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '先把最小可用的抓取能力跑通。这一关的重点不是快，是**边界清晰** ——',
      '后面十一关全都建在这个边界之上。',
      '',
      '## 要实现什么',
      '',
      '在 `src/fetcher.ts` 实现两个函数：',
      '',
      '| 函数 | 行为 |',
      '| --- | --- |',
      '| `fetchPage(url)` | 调用 `@lab/net` 的 `request`，把结果规范化成 `PageResult` |',
      '| `fetchAll(urls)` | 按输入顺序返回结果数组，这一关串行实现即可 |',
      '',
      '`fetchPage` 失败时**不要向外抛异常**，而是返回 `{ ok: false, error }` ——',
      '上层要能拿到全部结果，而不是被一个坏地址打断整批。',
      '',
      '## 怎么算过',
      '',
      '- 成功返回 `{ url, ok: true, data }`；',
      '- 失败返回 `{ url, ok: false, data: null, error }`，异常不外泄；',
      '- 结果数组和输入**等长、同序**；',
      '- 同一个地址不重复请求（门槛 `requests.duplicated ≤ 0`）。',
      '',
      '## 为什么先立边界',
      '',
      '一个随时可能抛异常的函数，会把错误处理的责任摊给每一个调用方 ——',
      '而调用方各写各的 try/catch，最后总有几个地方漏了。',
      '把失败**收敛成返回值**，调用方就只需要看 `ok` 这一个字段。',
      '',
      '这个决定会一路影响到第 12 关：因为失败是数据而不是控制流，',
      '后面的并发池、重试、对冲、优先级队列才能统一地处理它，',
      '而不用在每一层重新考虑「异常穿过来怎么办」。',
      '',
      '顺序对齐同样是契约的一部分。调用方按下标去取结果，',
      '所以每个结果必须写回它**原本的位置**，而不是按完成先后 push 进数组 ——',
      '下一关引入并发之后，这两种写法的差别立刻就是 bug。',
    ].join('\n'),
    [
      'Get a minimal fetching capability working. The point here is not speed, it is a **clean boundary** —',
      'the remaining eleven stages are all built on top of it.',
      '',
      '## What to build',
      '',
      'Two functions in `src/fetcher.ts`:',
      '',
      '| Function | Behaviour |',
      '| --- | --- |',
      '| `fetchPage(url)` | Call `request` from `@lab/net` and normalise the result into a `PageResult` |',
      '| `fetchAll(urls)` | Return results in input order; a sequential implementation is fine here |',
      '',
      '`fetchPage` must **not throw** on failure; it returns `{ ok: false, error }` — callers should see every',
      'result rather than losing the batch to one bad url.',
      '',
      '## What counts as passing',
      '',
      '- Success returns `{ url, ok: true, data }`;',
      '- Failure returns `{ url, ok: false, data: null, error }`, with no exception escaping;',
      '- The result array has the **same length and order** as the input;',
      '- No url is requested twice (`requests.duplicated ≤ 0`).',
      '',
      '## Why the boundary comes first',
      '',
      'A function that might throw at any moment spreads error handling across every caller — and callers',
      'each writing their own try/catch means a few of them will forget. Collapsing failure into a **return',
      'value** leaves callers with one field to read: `ok`.',
      '',
      'That decision reaches all the way to stage 12: because failure is data rather than control flow, the',
      'pool, retries, hedging and priority queue that follow can all handle it uniformly, instead of each',
      'layer reasoning afresh about an exception passing through.',
      '',
      'Order alignment is part of the contract too. Callers index into the results, so each result must be',
      'written back to **its own position** rather than pushed in completion order — once the next stage',
      'introduces concurrency, the difference between those two becomes a bug immediately.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  FA["fetchAll(urls)"] --> LOOP["按输入顺序逐个处理"]',
      '  LOOP --> FP["fetchPage(url)"]',
      '  FP --> REQ["await request(url) —— @lab/net"]',
      '  REQ --> T{"返回了还是抛了？"}',
      '  T -- 返回 --> OK["{ url, ok: true, data }"]',
      '  T -- 抛错 --> ERR["catch 住，转成<br/>{ url, ok: false, data: null, error }<br/>异常到此为止，不再向外抛"]',
      '  OK --> SLOT["results[index] = 结果<br/>写回原下标，不是 push"]',
      '  ERR --> SLOT',
      '  SLOT --> LOOP',
      '  LOOP --> RET["返回与输入等长同序的数组"]',
      '```',
      '',
      '要点：`ERR` 那个节点就是这一关说的「错误边界」——',
      '它是整个模块里唯一一处 catch，往外的每一层都只看 `ok` 字段。',
      '',
      '`SLOT` 写回原下标而不是 push：现在串行看不出区别，',
      '下一关并发之后，push 出来的顺序就是完成顺序，和输入顺序不再一致。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  FA["fetchAll(urls)"] --> LOOP["walk the urls in input order"]',
      '  LOOP --> FP["fetchPage(url)"]',
      '  FP --> REQ["await request(url) — @lab/net"]',
      '  REQ --> T{"returned or threw?"}',
      '  T -- returned --> OK["{ url, ok: true, data }"]',
      '  T -- threw --> ERR["caught here and turned into<br/>{ url, ok: false, data: null, error }<br/>the exception stops here"]',
      '  OK --> SLOT["results[index] = result<br/>written to its own index, not pushed"]',
      '  ERR --> SLOT',
      '  SLOT --> LOOP',
      '  LOOP --> RET["return an array matching the input in length and order"]',
      '```',
      '',
      'The point: the `ERR` node is the error boundary this stage is about — the module\'s single catch, with',
      'every layer above it reading only the `ok` field.',
      '',
      '`SLOT` writes to the original index instead of pushing: indistinguishable while everything is',
      'sequential, but once the next stage adds concurrency, pushing yields completion order, which is no',
      'longer input order.',
    ].join('\n')
  ),
  checklist: [
    t('fetchPage 永远 resolve，不 reject', 'fetchPage always resolves, never rejects'),
    t('失败结果带上可读的 error 信息', 'Failed results carry a readable error message'),
    t('fetchAll 的返回顺序与输入顺序一致', 'fetchAll preserves input order'),
    t('空数组、单元素等边界情况不炸', 'Empty and single-element inputs behave'),
    t('同一个 url 不重复请求', 'No duplicate requests for the same url'),
  ],
  pitfalls: [
    t(
      '把 try/catch 包在 fetchAll 外面：一个坏地址会让整批结果全部丢失，而调用方本来只是想知道「哪几个失败了」。',
      'Wrapping try/catch around fetchAll: one bad url discards the whole batch, when the caller only wanted to know which ones failed.'
    ),
    t(
      '失败时返回 null 或 undefined：调用方每次拿到结果都得先判空，错误信息也没了。失败也应该是一个结构完整的结果。',
      'Returning null/undefined on failure: every caller now needs a null check and the error message is gone. A failure should still be a fully-shaped result.'
    ),
    t(
      '`results.push()` 在这一关看不出问题，因为一切都是串行的。等第 2 关加上并发，顺序立刻就乱。按索引写入。',
      '`results.push()` looks fine here because everything is sequential. Add concurrency in stage 2 and the order falls apart. Write by index.'
    ),
    t(
      '把整个 Error 对象塞进 error 字段，落日志或跨进程时它会变成 {}，因为 Error 不能被 JSON 序列化。',
      'Putting the whole Error object in the error field turns it into {} in logs or across a process boundary, because Error does not survive JSON serialisation.'
    ),
  ],
  hints: [
    t(
      'request 失败时会抛出 LabHttpError，用 try/catch 把它转成 PageResult。',
      'request throws LabHttpError on failure, catch it and turn it into a PageResult.'
    ),
    t(
      '顺序一致最稳的写法是先按索引写入固定长度的数组，而不是 push。',
      'Writing into a pre-sized array by index is the most robust way to preserve order.'
    ),
  ],
  extension: t(
    [
      '把「失败」从控制流（throw）变成数据（`{ ok: false }`），是很多语言的默认选择：',
      '',
      '- Go 的 `(value, err)` 双返回值',
      '- Rust 的 `Result<T, E>`，配合 `?` 决定何时才升级成控制流',
      '- JS 的 `Promise.allSettled`，返回 `{status, value|reason}` 而不是让第一个失败者吞掉全部结果',
      '',
      '判断标准很简单：调用方是否需要「部分成功」？ 需要，就把失败变成数据；',
      '不需要（比如参数非法、程序 bug），那就应该抛，让它尽早炸出来。',
      '',
      '批量接口的 API 设计里这条同样成立，所以 S3 的 DeleteObjects、',
      'Elasticsearch 的 Bulk API 都返回「逐条结果」而不是一个整体的成功/失败。',
    ].join('\n'),
    [
      'Turning failure from control flow (throw) into data (`{ ok: false }`) is the default in many languages:',
      '',
      "- Go's `(value, err)` pair",
      "- Rust's `Result<T, E>`, where `?` decides when it becomes control flow again",
      "- JS's `Promise.allSettled`, returning `{status, value|reason}` instead of letting the first rejection swallow everything",
      '',
      'The test is simple: does the caller need partial success? If yes, make failure data.',
      'If no (invalid arguments, a bug), throw and let it surface immediately.',
      '',
      'The same rule shows up in batch API design, which is why S3 DeleteObjects and',
      "Elasticsearch's Bulk API return per-item results rather than one overall status.",
    ].join('\n')
  ),
  focus: ['correctness', 'encapsulation'],
  lab: {
    defaultLatencyMs: 100,
    endpoints: {
      '/api/pages/broken': { failFirstN: 99, status: 503 },
      '/api/pages/gone': { failFirstN: 99, status: 404 },
    },
  },
  starterFiles: [
    contract,
    file(
      'src/fetcher.ts',
      code`
        import { request } from '@lab/net';
        import type { FetchOptions, PageResult } from './contract';

        /**
         * Fetch a single URL, normalising success and failure into a PageResult.
         * Hint: request throws LabHttpError when it fails.
         */
        export async function fetchPage(url: string): Promise<PageResult> {
          // TODO: implement this
          throw new Error('not implemented');
        }

        /**
         * Fetch in bulk; the result order must match urls.
         * A serial implementation is fine for stage 1 — later stages add concurrency, retries and caching.
         */
        export async function fetchAll(urls: string[], options: FetchOptions = {}): Promise<PageResult[]> {
          // TODO: implement this
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
        import { fetchAll, fetchPage } from '../src/fetcher';
        import { getMetrics } from '@lab/net';

        const urls = ['/api/pages/1', '/api/pages/2', '/api/pages/3'];

        describe('Stage 1 · Contract and error boundaries', () => {
          it('fetchPage returns a normalised success result', async () => {
            const result = await fetchPage('/api/pages/1');
            expect(result.url).toBe('/api/pages/1');
            expect(result.ok).toBe(true);
            expect(result.data).toBeDefined();
          });

          it('fetchPage collapses failure into a result rather than an exception', async () => {
            const result = await fetchPage('/api/pages/broken');
            expect(result.ok).toBe(false);
            expect(result.data).toBeNull();
            expect(typeof result.error).toBe('string');
            expect(result.error.length).toBeGreaterThan(0);
          });

          it('fetchAll preserves input order', async () => {
            const results = await fetchAll(urls);
            expect(results).toHaveLength(3);
            expect(results.map((item) => item.url)).toEqual(urls);
            expect(results.every((item) => item.ok)).toBe(true);
          });

          it('one bad URL does not sink the whole batch [gate:dedup]', async () => {
            const results = await fetchAll(['/api/pages/1', '/api/pages/broken', '/api/pages/3']);
            expect(results.map((item) => item.ok)).toEqual([true, false, true]);
            expect(getMetrics().requests.duplicated).toBe(0);
          });

          it('returns a complete result array even when everything fails', async () => {
            const results = await fetchAll(['/api/pages/broken', '/api/pages/gone']);
            expect(results).toHaveLength(2);
            expect(results.map((item) => item.ok)).toEqual([false, false]);
            expect(results.map((item) => item.url)).toEqual(['/api/pages/broken', '/api/pages/gone']);
          });

          it('an empty array returns empty results without issuing requests', async () => {
            const results = await fetchAll([]);
            expect(results).toEqual([]);
            expect(getMetrics().requests.total).toBe(0);
          });

          it('a single URL works fine too', async () => {
            const results = await fetchAll(['/api/pages/only']);
            expect(results).toHaveLength(1);
            expect(results[0].ok).toBe(true);
          });

          it('error is a string and survives JSON serialisation', async () => {
            const result = await fetchPage('/api/pages/broken');
            const roundTripped = JSON.parse(JSON.stringify(result));
            expect(roundTripped.error).toBe(result.error);
            expect(roundTripped.ok).toBe(false);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'requests.duplicated',
      op: 'lte',
      value: 0,
      zh: '不重复请求同一地址',
      en: 'No duplicate requests',
      dimension: 'resilience',
      scope: 'gate:dedup',
    }),
  ],
  referenceFiles: [
    file(
      'src/fetcher.ts',
      code`
        import { request } from '@lab/net';
        import type { FetchOptions, PageResult } from './contract';

        export async function fetchPage(url: string): Promise<PageResult> {
          try {
            const response = await request(url);
            return { url, ok: true, data: response.data };
          } catch (error) {
            return { url, ok: false, data: null, error: (error as Error).message };
          }
        }

        export async function fetchAll(urls: string[], options: FetchOptions = {}): Promise<PageResult[]> {
          const results: PageResult[] = new Array(urls.length);
          for (let index = 0; index < urls.length; index += 1) {
            results[index] = await fetchPage(urls[index]);
          }
          return results;
        }
      `
    ),
  ],
  referenceNotes: t(
    '把失败翻译成数据（PageResult）而不是控制流（throw），是让上层可以「部分成功」的前提。',
    'Turning failure into data (PageResult) instead of control flow (throw) is what makes partial success possible upstream.'
  ),
};

/* ------------------------------------------------------------------ */
/* 阶段 2：并发池                                                       */
/* ------------------------------------------------------------------ */

const stage2 = {
  id: 'concurrency-pool',
  title: t('第 2 关 · 有上限的并发', 'Stage 2 · Bounded concurrency'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '串行太慢，`Promise.all` 又会把下游打挂 —— 下游服务只允许 5 路并发，超了直接返回 429。',
      '需要的是一个**有上限**的并发。',
      '',
      '## 要实现什么',
      '',
      '在 `src/pool.ts` 实现通用的并发映射：',
      '',
      '```ts',
      'mapWithConcurrency(items, limit, worker) // 顺序返回结果，同时最多 limit 个 worker 在跑',
      '```',
      '',
      '然后让 `fetchAll` 在 `options.concurrency` 存在时使用它。',
      '',
      '结果仍然按**输入顺序**返回 —— 完成顺序和输入顺序不一样，',
      '所以每个结果要写回自己的下标。',
      '',
      '## 怎么算过',
      '',
      '- 峰值并发不超过配置值（门槛 `maxConcurrency ≤ 4`）；',
      '- 不触发下游限流（门槛 `requests.throttled ≤ 0`）；',
      '- 12 个请求在 300ms 内跑完（门槛 `virtualElapsedMs ≤ 300`）；',
      '- 结果顺序与输入一致；',
      '- `limit` 大于任务数时不会白起多余的 worker。',
      '',
      '## 取号式，不是分批式',
      '',
      '延迟门槛卡的就是这件事。分批式（每批 4 个、等一批跑完再下一批）功能上没错，',
      '但每批都要等**最慢的那一个**，快的 worker 站着不动 ——',
      '总时长变成「各批最大值之和」，尾部时间全浪费了。',
      '',
      '取号式的做法是：起 `limit` 个 worker，它们共享一个游标，',
      '谁空出来谁就取下一个号。没有任何 worker 会为了等别人而停下。',
      '',
      '并发控制值得做成一个**可复用的原语**，而不是每次都在业务代码里手写一遍循环。',
      '这一关之后的每一关都会用到它：超时要在它之上释放槽位，',
      '重试要在它之上重排任务，优先级调度要替换它的取号顺序。',
    ].join('\n'),
    [
      'Sequential is too slow, and `Promise.all` melts the downstream — it allows only five concurrent calls',
      'and returns 429 beyond that. What is needed is concurrency **with a ceiling**.',
      '',
      '## What to build',
      '',
      'A reusable concurrent map in `src/pool.ts`:',
      '',
      '```ts',
      'mapWithConcurrency(items, limit, worker) // ordered results, at most `limit` workers in flight',
      '```',
      '',
      'Then make `fetchAll` use it when `options.concurrency` is set.',
      '',
      'Results still come back in **input order** — completion order differs from input order, so each result',
      'must be written to its own index.',
      '',
      '## What counts as passing',
      '',
      '- Peak concurrency never exceeds the configured limit (`maxConcurrency ≤ 4`);',
      '- The downstream never throttles you (`requests.throttled ≤ 0`);',
      '- Twelve requests finish within 300ms (`virtualElapsedMs ≤ 300`);',
      '- Result order matches input order;',
      '- A `limit` larger than the item count does not spawn idle workers.',
      '',
      '## Pull-based, not batched',
      '',
      'The latency gate is precisely about this. Batch slicing — run four, wait for all four, run the next',
      'four — is functionally correct, but every batch waits for its **slowest** member while the fast workers',
      'stand idle. Total time becomes the sum of per-batch maxima, and all the tail time is wasted.',
      '',
      'The pull-based approach is: start `limit` workers sharing one cursor, and whoever frees up takes the',
      'next item. No worker ever stops to wait for another.',
      '',
      'Concurrency control is worth building as a **reusable primitive** rather than hand-rolling a loop each',
      'time. Every stage after this uses it: timeouts release its slots, retries requeue through it, and',
      'priority scheduling replaces the order in which it hands out items.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**取号式的池子**',
      '',
      '```mermaid',
      'flowchart TD',
      '  M["mapWithConcurrency(items, limit, worker)"] --> SIZE["size = min(limit, items.length)，至少 1<br/>任务比上限少时不白起 worker"]',
      '  SIZE --> SPAWN["起 size 个 runner<br/>它们共享同一个 cursor"]',
      '  SPAWN --> W1{"cursor < items.length？"}',
      '  W1 -- 否 --> WEND["这个 runner 自己结束"]',
      '  W1 -- 是 --> W2["index = cursor，然后 cursor += 1<br/>先占号，再干活"]',
      '  W2 --> W3["results[index] = await worker(item, index)<br/>写回原下标，顺序与输入一致"]',
      '  W3 --> W1',
      '  WEND --> JOIN["Promise.all(runners) 全部结束<br/>返回 results"]',
      '```',
      '',
      '要点：`cursor` 是唯一的共享状态，而「先占号再干活」保证了两个 runner 不会拿到同一个下标 ——',
      '单线程 JavaScript 里这一步不会被打断，所以不需要任何锁。',
      '',
      '图里没有任何「等其他 runner」的边，这就是它比分批式快的全部原因。',
      '',
      '**对照：分批式为什么慢**',
      '',
      '```mermaid',
      'flowchart TD',
      '  B1["每批 limit 个"] --> B2["等整批跑完"]',
      '  B2 --> B3["再下一批"]',
      '  B3 --> B1',
      '  B2 --> B4["每批都卡在最慢的那个<br/>快的 worker 站着等<br/>总时长 = 各批最大值之和"]',
      '```',
    ].join('\n'),
    [
      '**The pull-based pool**',
      '',
      '```mermaid',
      'flowchart TD',
      '  M["mapWithConcurrency(items, limit, worker)"] --> SIZE["size = min(limit, items.length), at least 1<br/>no idle workers when there are fewer items"]',
      '  SIZE --> SPAWN["start size runners<br/>all sharing one cursor"]',
      '  SPAWN --> W1{"cursor < items.length?"}',
      '  W1 -- no --> WEND["this runner finishes on its own"]',
      '  W1 -- yes --> W2["index = cursor, then cursor += 1<br/>claim the ticket before doing the work"]',
      '  W2 --> W3["results[index] = await worker(item, index)<br/>written to its own index, order preserved"]',
      '  W3 --> W1',
      '  WEND --> JOIN["Promise.all(runners) settles<br/>return results"]',
      '```',
      '',
      'The point: `cursor` is the only shared state, and claiming the ticket before doing the work is what',
      'stops two runners from taking the same index — single-threaded JavaScript cannot interleave that step,',
      'so no lock is needed.',
      '',
      'There is no edge here that waits on another runner, and that is the entire reason it beats batching.',
      '',
      '**Contrast: why batching is slower**',
      '',
      '```mermaid',
      'flowchart TD',
      '  B1["run limit items"] --> B2["wait for the whole batch"]',
      '  B2 --> B3["then the next batch"]',
      '  B3 --> B1',
      '  B2 --> B4["every batch waits on its slowest member<br/>fast workers stand idle<br/>total = sum of per-batch maxima"]',
      '```',
    ].join('\n')
  ),
  checklist: [
    t('mapWithConcurrency 结果顺序与输入一致', 'mapWithConcurrency preserves order'),
    t('峰值并发不超过 limit', 'Peak concurrency never exceeds the limit'),
    t('worker 抛错时不吞掉异常', 'Worker errors are not swallowed'),
    t('12 个 100ms 请求在并发 4 下 300ms 跑完', '12 requests of 100ms finish in 300ms at concurrency 4'),
  ],
  pitfalls: [
    t(
      '`Promise.all(urls.map(fetchPage))`：并发度等于任务数。12 个地址就是 12 路并发，下游只允许 5 路，直接被 429 打回。这种写法与其说是快，不如说是把自己的负载问题丢给了下游。',
      '`Promise.all(urls.map(fetchPage))` makes concurrency equal to the input size. 12 urls means 12 in flight, the upstream allows 5, and you get 429s, that is not speed, it is exporting your load problem to someone else.'
    ),
    t(
      '分批：`chunk(urls, 4)` 后逐批 `Promise.all`。并发度确实受控了，但每批都要等最慢的那个，批与批之间有空转。12 个任务会跑成 400ms 而不是 300ms。',
      'Chunking: `chunk(urls, 4)` then `Promise.all` per batch. Concurrency is bounded, but every batch waits for its slowest item and the pool idles in between, 400ms instead of 300ms for 12 tasks.'
    ),
    t(
      '轮询等待空位：`while (inFlight >= limit) await sleep(10)`。能跑通，但引入了与真实工作量无关的 10ms 粒度抖动，而且 CPU 一直在空转检查。',
      'Polling for a free slot with `while (inFlight >= limit) await sleep(10)` works, but adds jitter unrelated to the workload and burns cycles checking.'
    ),
    t(
      '忘记 `limit > items.length` 的情况：启动了 100 个 worker 去抢 3 个任务，多出来的 97 个立刻空转退出。这不致命，但说明边界没想清楚。',
      'Forgetting `limit > items.length`: you spawn 100 workers for 3 tasks and 97 immediately exit. Not fatal, but it shows the boundary was not considered.'
    ),
  ],
  hints: [
    t(
      '经典做法：启动 min(limit, items.length) 个 worker，每个 worker 用共享游标不断取下一个任务。',
      'Classic shape: start min(limit, items.length) workers, each pulling the next index from a shared cursor.'
    ),
    t(
      '不要用「分批 chunk + Promise.all」，那样每批都要等最慢的一个，尾部空转会让延迟超标。',
      'Avoid chunk + Promise.all: every batch waits for its slowest item and the idle tail blows the latency budget.'
    ),
  ],
  extension: t(
    [
      '这个原语在各语言里都有成熟实现，值得对照着看一眼签名：',
      '',
      '| 生态 | 对应物 |',
      '| --- | --- |',
      '| Node.js | `p-limit` / `p-map` 的 `concurrency` 选项 |',
      '| Go | `errgroup.Group.SetLimit(n)` |',
      '| Rust | `tokio::sync::Semaphore` + `JoinSet` |',
      '| Java | `Semaphore` / 固定大小线程池 |',
      '| Python | `asyncio.Semaphore` |',
      '',
      '它们的共同点是：并发上限是资源属性，不是任务属性。',
      '上限应该由「下游能承受多少」决定，而不是「我有多少活要干」。',
      '',
      '再往下一层还有两个概念值得了解：',
      '',
      '- 背压（backpressure）：当生产速度持续高于消费速度时，光限制并发不够，还得让上游慢下来；',
      '- **公平性**：本关的共享游标是 FIFO 的，但如果任务有优先级，就需要优先队列而不是游标。',
    ].join('\n'),
    [
      'This primitive exists in every ecosystem, the signatures are worth comparing:',
      '',
      '| Ecosystem | Counterpart |',
      '| --- | --- |',
      '| Node.js | the `concurrency` option of `p-limit` / `p-map` |',
      '| Go | `errgroup.Group.SetLimit(n)` |',
      '| Rust | `tokio::sync::Semaphore` + `JoinSet` |',
      '| Java | `Semaphore` / fixed-size thread pool |',
      '| Python | `asyncio.Semaphore` |',
      '',
      'They share one idea: the concurrency limit is a property of the resource, not of the workload.',
      'It should be set by what the downstream can absorb, not by how much work you happen to have.',
      '',
      'Two concepts sit just beyond this stage:',
      '',
      '- Backpressure: when production outpaces consumption for a sustained period, limiting concurrency is not enough, you must slow the producer;',
      '- **Fairness**: the shared cursor here is FIFO; priorities would need a priority queue instead.',
    ].join('\n')
  ),
  focus: ['concurrency', 'latency', 'encapsulation'],
  lab: {
    defaultLatencyMs: 100,
    serverConcurrencyLimit: 5,
  },
  starterFiles: [
    file(
      'src/pool.ts',
      code`
        /**
         * A general-purpose bounded-concurrency map primitive.
         *
         * Requirements:
         * - result order matches items
         * - at most limit workers are running at any moment
         * - if a worker throws, the whole thing rejects (do not swallow it)
         */
        export async function mapWithConcurrency<T, R>(
          items: T[],
          limit: number,
          worker: (item: T, index: number) => Promise<R>
        ): Promise<R[]> {
          // TODO: implement this
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
        import { mapWithConcurrency } from '../src/pool';
        import { fetchAll } from '../src/fetcher';
        import { getMetrics } from '@lab/net';
        import { sleep } from '@lab/env';

        const urls = Array.from({ length: 12 }, (_, index) => '/api/pages/' + index);

        describe('Stage 2 · Bounded concurrency', () => {
          it('mapWithConcurrency preserves result order', async () => {
            const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
              await sleep(10 * (6 - value));
              return value * 2;
            });
            expect(result).toEqual([2, 4, 6, 8, 10]);
          });

          it('mapWithConcurrency never exceeds the concurrency ceiling', async () => {
            let inFlight = 0;
            let peak = 0;
            await mapWithConcurrency(Array.from({ length: 9 }, (_, i) => i), 3, async (value) => {
              inFlight += 1;
              peak = Math.max(peak, inFlight);
              await sleep(20);
              inFlight -= 1;
              return value;
            });
            expect(peak).toBe(3);
          });

          it('an error thrown by a worker propagates', async () => {
            await expect(async () =>
              mapWithConcurrency([1, 2, 3], 2, async (value) => {
                if (value === 2) throw new Error('boom');
                return value;
              })
            ).rejects.toThrow('boom');
          });

          it('fetchAll runs concurrently with order preserved [gate:concurrency]', async () => {
            const results = await fetchAll(urls, { concurrency: 4 });
            expect(results.map((item) => item.url)).toEqual(urls);
            const metrics = getMetrics();
            expect(metrics.maxConcurrency).toBeLessThanOrEqual(4);
            expect(metrics.requests.throttled).toBe(0);
          });

          it('twelve 100ms requests finish in 300ms at concurrency 4 [gate:latency]', async () => {
            await fetchAll(urls, { concurrency: 4 });
            const metrics = getMetrics();
            expect(metrics.requests.total).toBe(12);
            expect(metrics.virtualElapsedMs).toBe(300);
          });

          it('concurrency really is saturated rather than conservatively under-used', async () => {
            await fetchAll(urls, { concurrency: 4 });
            // The peak has to be exactly 4: below that is wasted allowance
            expect(getMetrics().maxConcurrency).toBe(4);
          });

          it('a limit above the task count does not create surplus workers', async () => {
            let peak = 0;
            let inFlight = 0;
            await mapWithConcurrency([1, 2, 3], 50, async (value) => {
              inFlight += 1;
              peak = Math.max(peak, inFlight);
              await sleep(10);
              inFlight -= 1;
              return value;
            });
            expect(peak).toBe(3);
          });

          it('a limit of 1 degenerates to serial', async () => {
            await fetchAll(['/api/a', '/api/b', '/api/c'], { concurrency: 1 });
            const metrics = getMetrics();
            expect(metrics.maxConcurrency).toBe(1);
            expect(metrics.virtualElapsedMs).toBe(300);
          });

          it('stays serial when concurrency is omitted, without quietly ramping up', async () => {
            await fetchAll(['/api/a', '/api/b'], {});
            expect(getMetrics().maxConcurrency).toBe(1);
          });

          it('an empty task list does not hang', async () => {
            const result = await mapWithConcurrency([], 4, async (value) => value);
            expect(result).toEqual([]);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'maxConcurrency',
      op: 'lte',
      value: 4,
      zh: '峰值并发 ≤ 4',
      en: 'Peak concurrency ≤ 4',
      dimension: 'concurrency',
      scope: 'gate:concurrency',
    }),
    gate({
      metric: 'requests.throttled',
      op: 'lte',
      value: 0,
      zh: '不被下游限流',
      en: 'Never throttled by upstream',
      dimension: 'resilience',
      scope: 'gate:concurrency',
    }),
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 300,
      unit: 'ms',
      zh: '12 个请求 ≤ 300ms',
      en: '12 requests within 300ms',
      dimension: 'latency',
      scope: 'gate:latency',
    }),
  ],
  referenceFiles: [
    file(
      'src/pool.ts',
      code`
        export async function mapWithConcurrency<T, R>(
          items: T[],
          limit: number,
          worker: (item: T, index: number) => Promise<R>
        ): Promise<R[]> {
          const results: R[] = new Array(items.length);
          const size = Math.max(1, Math.min(limit, items.length));
          let cursor = 0;

          const runners = Array.from({ length: size }, async () => {
            while (cursor < items.length) {
              const index = cursor;
              cursor += 1;
              results[index] = await worker(items[index], index);
            }
          });

          await Promise.all(runners);
          return results;
        }
      `
    ),
    file(
      'src/fetcher.ts',
      code`
        import { request } from '@lab/net';
        import { mapWithConcurrency } from './pool';
        import type { FetchOptions, PageResult } from './contract';

        export async function fetchPage(url: string): Promise<PageResult> {
          try {
            const response = await request(url);
            return { url, ok: true, data: response.data };
          } catch (error) {
            return { url, ok: false, data: null, error: (error as Error).message };
          }
        }

        export async function fetchAll(urls: string[], options: FetchOptions = {}): Promise<PageResult[]> {
          const concurrency = options.concurrency && options.concurrency > 0 ? options.concurrency : 1;
          return mapWithConcurrency(urls, concurrency, (url) => fetchPage(url));
        }
      `
    ),
  ],
  referenceNotes: t(
    '共享游标 + 固定数量 worker 的「取号」模型，比分批 chunk 更好：没有批与批之间的空转，尾部延迟也更低。',
    'A shared cursor with a fixed worker pool beats chunking: no idle gap between batches and a shorter tail.'
  ),
};

/* ------------------------------------------------------------------ */
/* 阶段 3：重试与退避                                                   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

const stage3 = {
  id: 'timeout-deadline',
  title: t('第 3 关 · 超时与预算传播', 'Stage 3 · Timeouts and deadline propagation'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关的并发池有个致命假设：每个请求最终都会返回。真实世界里不会。',
      '一个卡住的连接会一直占着并发槽，池子里 5 个槽被 5 个僵死请求占满之后，',
      '整条管线就停在那里了 —— 不报错，不超时，只是永远不动。',
      '',
      '## 要实现什么',
      '',
      '在 `src/deadline.ts` 实现 `fetchWithDeadline(urls, options)`：',
      '',
      '| 选项 | 行为 |',
      '| --- | --- |',
      '| `timeoutMs` | 单个请求的超时。超了产出 `{ ok: false, error: \'timeout\' }`，**不要抛** |',
      '| `totalBudgetMs` | 整批的总预算。用完之后剩下的 URL 直接标失败，**一个请求都不发** |',
      '| `signal` | 外部取消，行为和预算用完一样 |',
      '| `concurrency` | 并发上限，沿用上一关的取号式池子 |',
      '',
      '超时之后要**立刻释放并发槽**，让下一个 URL 开始，不要等那个僵死请求。',
      '',
      '## 怎么算过',
      '',
      '- 僵死请求超时后立刻让出并发槽（门槛 `virtualElapsedMs ≤ 600`）；',
      '- 预算用完之后不再发出任何请求（门槛 `requests.total ≤ 4`）；',
      '- 超时和取消都表现为失败结果，不抛异常；',
      '- 结果数组仍然与输入等长同序。',
      '',
      '## 超时是每个请求的，预算是整批的',
      '',
      '这两件事要分清楚。一个 10 个 URL 的批次，每个超时 200ms，',
      '不代表整批最多 200ms；也不代表整批最多 2000ms —— 并发会把它压缩。',
      '**预算是独立的一道闸**：它不管你还有多少请求在飞，时间到了就不再往外发。',
      '',
      '实现上把预算记成一个**绝对时刻**（`now() + totalBudgetMs`），',
      '比维护「还剩多少毫秒」简单得多，并发下也不会算错。',
      '而且每取一个新任务都要重新判断一次 —— 并发启动的那批可能在中途把预算耗光。',
      '',
      '## 「立刻释放槽位」是这一关的全部难点',
      '',
      '`Promise.race` 让你**不再等待**那个请求，但那个请求本身还在跑。',
      '你要保证的是：race 一结束，槽位就还回池子里。',
      '如果在超时分支里还去 `await` 那个被放弃的 promise，超时就白做了 ——',
      '你还是被那个僵死请求卡着，只是多打印了一行日志。',
    ].join('\n'),
    [
      'The pool from the last stage assumes every request eventually returns. In the real world they do not.',
      'One stuck connection holds its slot forever, and once five stuck requests hold all five slots the',
      'pipeline simply stops — no error, no timeout, just permanently still.',
      '',
      '## What to build',
      '',
      '`fetchWithDeadline(urls, options)` in `src/deadline.ts`:',
      '',
      '| Option | Behaviour |',
      '| --- | --- |',
      '| `timeoutMs` | Per-request timeout. On expiry produce `{ ok: false, error: \'timeout\' }`, **do not throw** |',
      '| `totalBudgetMs` | A budget for the whole batch. Once spent, remaining URLs fail with **no request issued** |',
      '| `signal` | External cancellation, behaving like an exhausted budget |',
      '| `concurrency` | The ceiling, reusing the pull-based pool from the last stage |',
      '',
      'On timeout the concurrency slot must be **released immediately** so the next URL starts, rather than',
      'waiting for the abandoned request.',
      '',
      '## What counts as passing',
      '',
      '- A stuck request yields its slot the moment it times out (`virtualElapsedMs ≤ 600`);',
      '- No request is issued after the budget is spent (`requests.total ≤ 4`);',
      '- Timeouts and cancellation both appear as failed results, never as exceptions;',
      '- The result array still matches the input in length and order.',
      '',
      '## The timeout is per request, the budget is per batch',
      '',
      'Keep the two separate. Ten URLs with a 200ms timeout each does not mean the batch takes 200ms, nor',
      'that it takes 2000ms — concurrency compresses it. **The budget is an independent gate**: it does not',
      'care how many requests are in flight; when time is up, nothing more goes out.',
      '',
      'Record the budget as an **absolute instant** (`now() + totalBudgetMs`) rather than tracking',
      'milliseconds remaining — it is simpler and cannot drift under concurrency. And re-check it every time',
      'a worker claims a new item, since the batch already in flight may exhaust the budget partway through.',
      '',
      '## "Release the slot immediately" is the whole difficulty',
      '',
      '`Promise.race` stops you **waiting on** the request, but the request itself is still running. What you',
      'must guarantee is that the slot returns to the pool the moment the race settles. `await` the abandoned',
      'promise inside the timeout branch and the timeout accomplished nothing — you are still blocked by the',
      'stuck request, just with one more log line.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**worker 循环** —— 沿用上一关的取号式池子，每取一个都重新看预算',
      '',
      '```mermaid',
      'flowchart TD',
      '  F["fetchWithDeadline(urls, options)"] --> DL["deadline = now() + totalBudgetMs<br/>记成绝对时刻，不维护「还剩多少」"]',
      '  DL --> W1{"cursor < urls.length？"}',
      '  W1 -- 否 --> WE["这个 worker 结束"]',
      '  W1 -- 是 --> W2["index = cursor，cursor += 1"]',
      '  W2 --> W3{"outOfTime()？<br/>now ≥ deadline 或 signal.cancelled"}',
      '  W3 -- 超预算 --> W4["直接写失败结果<br/>budget exhausted / cancelled<br/>一个请求都不发出去"]',
      '  W4 --> W1',
      '  W3 -- 还有时间 --> W5["await runOne(index)"]',
      '  W5 --> W1',
      '```',
      '',
      '`W5` 一返回，这个 worker 就回到 `W1` 去取下一个 —— 槽位的释放绑定在',
      '**`runOne` 返回**上，而不是绑定在那个请求 settle 上。',
      '',
      '**runOne(index)** —— 单个请求的超时',
      '',
      '```mermaid',
      'flowchart TD',
      '  R1["Promise.race 两条路：<br/>request(url) 拿到 data<br/>sleep(timeoutMs) 得到 TIMED_OUT 哨兵"] --> R2{"谁先到？"}',
      '  R2 -- 请求先返回 --> R3["{ ok: true, data }"]',
      '  R2 -- 计时器先到 --> R4["{ ok: false, error: \'timeout\' }<br/>立刻 return<br/>绝不 await 那个被放弃的请求"]',
      '```',
      '',
      '超时分支直接 return，僵死请求还在后台跑，但它已经不再占用任何人的时间。',
      '在 `R4` 里再去 `await` 那个被放弃的 promise，超时就白做了。',
      '',
      '超时用哨兵（`TIMED_OUT`）而不是抛错，是为了让 race 之后**一次判断**就能分开两条路；',
      '用抛错的话，超时和请求自身失败会混在同一个 catch 里，分不清是谁先到。',
    ].join('\n'),
    [
      '**The worker loop** — the pull-based pool from the last stage, re-checking the budget on every claim',
      '',
      '```mermaid',
      'flowchart TD',
      '  F["fetchWithDeadline(urls, options)"] --> DL["deadline = now() + totalBudgetMs<br/>an absolute instant, not a remaining count"]',
      '  DL --> W1{"cursor < urls.length?"}',
      '  W1 -- no --> WE["this worker finishes"]',
      '  W1 -- yes --> W2["index = cursor, cursor += 1"]',
      '  W2 --> W3{"outOfTime()?<br/>now ≥ deadline or signal.cancelled"}',
      '  W3 -- "over budget" --> W4["write a failed result directly<br/>budget exhausted / cancelled<br/>no request is issued"]',
      '  W4 --> W1',
      '  W3 -- "time remains" --> W5["await runOne(index)"]',
      '  W5 --> W1',
      '```',
      '',
      'The moment `W5` returns, this worker is back at `W1` claiming the next item — slot release is tied to',
      '**`runOne` returning**, not to the request settling.',
      '',
      '**runOne(index)** — the per-request timeout',
      '',
      '```mermaid',
      'flowchart TD',
      '  R1["Promise.race between:<br/>request(url) resolving to data<br/>sleep(timeoutMs) resolving to a TIMED_OUT sentinel"] --> R2{"which settled first?"}',
      '  R2 -- "the request" --> R3["{ ok: true, data }"]',
      '  R2 -- "the timer" --> R4["{ ok: false, error: \'timeout\' }<br/>return immediately<br/>never await the abandoned request"]',
      '```',
      '',
      'The timeout branch returns straight away; the stuck request keeps running in the background but no',
      'longer consumes anyone\'s time. `await` the abandoned promise inside `R4` and the timeout accomplished',
      'nothing.',
      '',
      'The timeout resolves a sentinel (`TIMED_OUT`) rather than throwing so that **one check** after the race',
      'separates the two paths. Throwing would fold the timeout and the request\'s own failure into the same',
      'catch, leaving no way to tell which arrived first.',
    ].join('\n')
  ),
  checklist: [
    t('超时产出失败结果而不是抛异常', 'A timeout produces a failed result, not an exception'),
    t('超时后并发槽立刻释放', 'The slot is released the instant the timeout fires'),
    t('预算用完后剩下的 URL 不发请求', 'Once the budget is spent, no further requests are issued'),
    t('外部取消和预算用完行为一致', 'External cancellation behaves like an exhausted budget'),
    t('快请求不会被慢请求拖慢', 'Fast requests are not delayed by slow ones'),
  ],
  pitfalls: [
    t(
      '用 `Promise.race([request, timeout])` 之后，在 `finally` 里等 `request` 结束才释放槽位。race 赢了、结果也返回了，但槽位还被那个僵死请求占着——超时于是只改善了「调用方等多久」，完全没改善「管线还能不能往前走」。释放槽位要跟着 race 的结果走，不是跟着请求走。',
      'Racing the request against a timeout and then releasing the slot in a `finally` that awaits the request. The race is won and the result returned, but the slot is still held by the stuck request, so the timeout improved how long the caller waits and did nothing for whether the pipeline can move. Slot release must follow the race, not the request.'
    ),
    t(
      '被放弃的请求最终 settle 时又去写一次结果数组。那一格早就填上 timeout 了，晚到的成功响应会把它覆盖掉——于是一个明明超时的请求出现在结果里，而且顺序还是乱的。放弃之后要有一个「已结算」标记，晚到的响应直接丢弃。',
      'Writing to the result array again when the abandoned request finally settles. That slot already holds the timeout, and the late success overwrites it — so a request that definitely timed out appears as a success, out of order. Mark the entry settled on abandonment and drop late arrivals.'
    ),
    t(
      '预算检查只在启动新请求**之前**做一次。10 个 URL、并发 5 时，前 5 个同时启动，预算在它们跑到一半时用完——但检查已经过了，剩下 5 个还是会被发出去。预算要在每次「从队列取下一个」时重新检查。',
      'Checking the budget once before starting. With ten URLs and a concurrency of five, the first five start together and the budget runs out midway — but the check already passed, so the remaining five go out anyway. Re-check the budget every time you pull the next item off the queue.'
    ),
    t(
      '把总预算实现成「给每个请求的超时取 min(timeoutMs, 剩余预算)」。听起来更精细，实际上会让最后几个请求带着 1ms 的超时发出去，必然失败——白白消耗了服务端资源。预算用完就该**不发**，而不是发一个注定超时的请求。',
      'Implementing the budget as `min(timeoutMs, remaining)` per request. It sounds more precise, and it means the last few requests go out with a 1ms timeout and are guaranteed to fail — burning server resources for nothing. An exhausted budget means not sending, not sending something doomed.'
    ),
  ],
  hints: [
    t(
      '超时用 `Promise.race([task(), sleep(timeoutMs).then(() => TIMEOUT)])`，让超时分支返回一个哨兵值而不是抛错，这样 race 之后用一次判断就能区分两条路。',
      'Race with `Promise.race([task(), sleep(timeoutMs).then(() => TIMEOUT)])`, having the timeout branch return a sentinel rather than throw, so one check after the race distinguishes the two paths.'
    ),
    t(
      '预算用 `const deadline = now() + totalBudgetMs` 记成一个绝对时刻，取下一个 URL 前判断 `now() >= deadline`。比维护「剩余多少」简单，也不会因为并发而算错。',
      'Store the budget as an absolute instant, `const deadline = now() + totalBudgetMs`, and check `now() >= deadline` before pulling the next URL. Simpler than tracking remaining time, and immune to concurrency skew.'
    ),
  ],
  extension: t(
    [
      '这一关做的是**超时**，真实系统里更常用的概念是**截止时间**（deadline）。',
      '区别在于可传播：调用方说「我最多等 300ms」，这个 300ms 要一路传下去，',
      '让每一层都知道自己还剩多少时间。gRPC 的 deadline 就是这么工作的——',
      '它是请求元数据的一部分，跨进程传递。',
      '',
      '超时不传播会导致一类很典型的浪费：网关等了 300ms 就放弃返回给用户，',
      '但下游服务对此一无所知，还在老老实实算那个已经没人要的结果，',
      '一直占着数据库连接。这在故障时会雪上加霜——上游都在重试，',
      '下游还在处理一堆早已被放弃的请求。',
      '',
      '另一个方向是**超时值怎么定**。写死一个数字很脆：定小了正常请求被误杀，',
      '定大了故障时反应迟钝。成熟系统用的是自适应超时，比如按最近的 p99 延迟',
      '动态调整，或者干脆用 Netflix 的做法：超时 = f(并发度)，负载高时反而放宽，',
      '避免超时本身变成雪崩的放大器。',
    ].join('\n'),
    [
      'This stage implements timeouts; the more useful concept in real systems is a deadline. The',
      'difference is propagation: the caller says "I will wait at most 300ms" and that 300ms travels down',
      'so every layer knows how much time is left. gRPC deadlines work exactly this way, carried as request',
      'metadata across processes.',
      '',
      'Not propagating produces a characteristic waste: the gateway gives up after 300ms and answers the',
      'user, while the downstream service knows nothing about it and keeps computing a result nobody wants,',
      'holding a database connection throughout. Under failure this compounds — everything upstream is',
      'retrying while everything downstream is busy with requests that were abandoned long ago.',
      '',
      'The other question is where the timeout value comes from. A hard-coded number is brittle: too small',
      'and healthy requests are killed, too large and failures take forever to surface. Mature systems',
      'adapt, tracking recent p99 latency, or take the Netflix approach of making the timeout a function of',
      'concurrency so it loosens under load rather than becoming an amplifier of the collapse.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'resilience'],
  lab: {
    defaultLatencyMs: 100,
    endpoints: {
      '/api/hang': { latencyMs: 5000 },
    },
  },
  starterFiles: [
    cancelSupport,
    file(
      'src/deadline.ts',
      code`
        import type { CancelToken, PageResult } from './contract';

        export interface DeadlineOptions {
          /** Concurrency ceiling */
          concurrency?: number;
          /** Timeout for a single request */
          timeoutMs: number;
          /** Total budget for the batch; once spent, the remaining URLs are not requested */
          totalBudgetMs?: number;
          signal?: CancelToken;
        }

        export function fetchWithDeadline(
          urls: string[],
          options: DeadlineOptions
        ): Promise<PageResult[]> {
          // TODO: implement this
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
        import { fetchWithDeadline } from '../src/deadline';
        import { createCancelSource } from '../src/support/cancel';
        import { now } from '@lab/env';
        import { getMetrics } from '@lab/net';

        describe('Stage 3 · Timeouts and budgets', () => {
          it('a normal request is unaffected', async () => {
            const results = await fetchWithDeadline(['/api/a', '/api/b'], {
              concurrency: 2,
              timeoutMs: 500,
            });
            expect(results).toHaveLength(2);
            expect(results.every((result) => result.ok)).toBe(true);
            expect(results[0].url).toBe('/api/a');
          });

          it('a timeout produces a failed result rather than an exception', async () => {
            const results = await fetchWithDeadline(['/api/hang'], {
              concurrency: 1,
              timeoutMs: 200,
            });
            expect(results).toHaveLength(1);
            expect(results[0].ok).toBe(false);
            expect(results[0].error).toBe('timeout');
            expect(results[0].data).toBeNull();
          });

          it('result order matches the input', async () => {
            const results = await fetchWithDeadline(['/api/hang', '/api/b', '/api/hang'], {
              concurrency: 3,
              timeoutMs: 200,
            });
            expect(results.map((result) => result.url)).toEqual(['/api/hang', '/api/b', '/api/hang']);
            expect(results.map((result) => result.ok)).toEqual([false, true, false]);
          });

          it('an abandoned request arriving late does not overwrite the existing result', async () => {
            const results = await fetchWithDeadline(['/api/hang'], {
              concurrency: 1,
              timeoutMs: 200,
            });
            // That request only really returns at 5000ms; waiting longer must not change the result
            await new Promise((resolve) => setTimeout(resolve, 6000));
            expect(results[0].ok).toBe(false);
            expect(results[0].error).toBe('timeout');
          });

          it('a timeout releases its concurrency slot immediately [gate:slot]', async () => {
            const startedAt = now();
            const urls = ['/api/hang', '/api/hang', '/api/hang', '/api/a', '/api/b', '/api/c'];
            const results = await fetchWithDeadline(urls, { concurrency: 2, timeoutMs: 200 });

            expect(results.filter((result) => result.ok)).toHaveLength(3);
            // Three hung requests at 200ms each and three normal ones at 100ms, over two slots -> around 450ms.
            // An implementation that waits for the hung request to really return takes over 5000ms
            expect(now() - startedAt).toBeLessThanOrEqual(600);
          });

          it('once the total budget is spent the remaining URLs are not requested [gate:budget]', async () => {
            const urls: string[] = [];
            for (let index = 0; index < 10; index += 1) urls.push('/api/page-' + index);

            const results = await fetchWithDeadline(urls, {
              concurrency: 1,
              timeoutMs: 500,
              totalBudgetMs: 250,
            });

            expect(results).toHaveLength(10);
            const succeeded = results.filter((result) => result.ok).length;
            expect(succeeded).toBeGreaterThanOrEqual(2);
            expect(succeeded).toBeLessThanOrEqual(4);
            // The key point: not a single request went out for the URLs never reached
            expect(getMetrics().requests.total).toBe(succeeded);
          });

          it('URLs cut off by the budget are marked failed rather than dropped', async () => {
            const urls: string[] = [];
            for (let index = 0; index < 8; index += 1) urls.push('/api/page-' + index);

            const results = await fetchWithDeadline(urls, {
              concurrency: 1,
              timeoutMs: 500,
              totalBudgetMs: 150,
            });

            expect(results).toHaveLength(8);
            const failed = results.filter((result) => !result.ok);
            expect(failed.length).toBeGreaterThan(0);
            expect(failed[failed.length - 1].error).toBeTruthy();
          });

          it('an external cancellation stops the requests that follow', async () => {
            const source = createCancelSource();
            const urls: string[] = [];
            for (let index = 0; index < 10; index += 1) urls.push('/api/page-' + index);

            setTimeout(() => source.cancel(), 250);
            const results = await fetchWithDeadline(urls, {
              concurrency: 1,
              timeoutMs: 500,
              signal: source.token,
            });

            expect(results).toHaveLength(10);
            expect(getMetrics().requests.total).toBeLessThan(10);
          });

          it('cancelling before the start issues nothing at all', async () => {
            const source = createCancelSource();
            source.cancel();

            const results = await fetchWithDeadline(['/api/a', '/api/b'], {
              concurrency: 2,
              timeoutMs: 500,
              signal: source.token,
            });

            expect(results).toHaveLength(2);
            expect(results.every((result) => !result.ok)).toBe(true);
            expect(getMetrics().requests.total).toBe(0);
          });

          it('an ample budget does not disturb normal completion', async () => {
            const results = await fetchWithDeadline(['/api/a', '/api/b', '/api/c'], {
              concurrency: 3,
              timeoutMs: 500,
              totalBudgetMs: 5000,
            });
            expect(results.every((result) => result.ok)).toBe(true);
          });

          it('empty input returns an empty array', async () => {
            expect(await fetchWithDeadline([], { concurrency: 2, timeoutMs: 100 })).toEqual([]);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 600,
      unit: 'ms',
      zh: '僵死请求超时后立刻让出并发槽',
      en: 'A stuck request yields its slot the moment it times out',
      dimension: 'latency',
      scope: 'gate:slot',
    }),
    gate({
      metric: 'requests.total',
      op: 'lte',
      value: 4,
      zh: '预算用完之后不再发出任何请求',
      en: 'No request is issued once the budget is spent',
      dimension: 'resilience',
      scope: 'gate:budget',
    }),
  ],
  referenceFiles: [
    file(
      'src/deadline.ts',
      code`
        import type { CancelToken, PageResult } from './contract';
        import { now, sleep } from '@lab/env';
        import { request } from '@lab/net';

        export interface DeadlineOptions {
          concurrency?: number;
          timeoutMs: number;
          totalBudgetMs?: number;
          signal?: CancelToken;
        }

        /** The timeout branch returns a sentinel instead of throwing, so one check after the race separates the two paths */
        const TIMED_OUT = Symbol('timed-out');

        export async function fetchWithDeadline(
          urls: string[],
          options: DeadlineOptions
        ): Promise<PageResult[]> {
          const results: PageResult[] = new Array(urls.length);
          if (urls.length === 0) return results;

          // Record the budget as an absolute instant: simpler than tracking how much is left, and correct under concurrency
          const deadline =
            options.totalBudgetMs === undefined ? Infinity : now() + options.totalBudgetMs;

          const size = Math.max(1, Math.min(options.concurrency ?? 1, urls.length));
          let cursor = 0;

          function outOfTime(): boolean {
            return now() >= deadline || Boolean(options.signal?.cancelled);
          }

          async function runOne(index: number): Promise<void> {
            const url = urls[index];

            const outcome = await Promise.race([
              request(url).then((response) => response.data),
              sleep(options.timeoutMs).then(() => TIMED_OUT),
            ]);

            // Return as soon as the race settles; the slot is released when this function returns.
            // Awaiting the abandoned request here would make the timeout pointless
            if (outcome === TIMED_OUT) {
              results[index] = { url, ok: false, data: null, error: 'timeout' };
              return;
            }
            results[index] = { url, ok: true, data: outcome };
          }

          async function worker(): Promise<void> {
            for (;;) {
              // Re-check on every take: the batch started concurrently may exhaust the budget part-way
              if (cursor >= urls.length) return;
              const index = cursor;
              cursor += 1;

              if (outOfTime()) {
                results[index] = {
                  url: urls[index],
                  ok: false,
                  data: null,
                  error: options.signal?.cancelled ? 'cancelled' : 'budget exhausted',
                };
                continue;
              }

              try {
                await runOne(index);
              } catch (error) {
                results[index] = {
                  url: urls[index],
                  ok: false,
                  data: null,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            }
          }

          const runners: Array<Promise<void>> = [];
          for (let slot = 0; slot < size; slot += 1) runners.push(worker());
          await Promise.all(runners);

          return results;
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**槽位跟着 race 走，不跟着请求走。** `runOne` 在 race 结束时就 return 了，',
      '那个被放弃的请求还挂在事件循环上，但 worker 已经去取下一个 URL 了。',
      '这一行行为差别，在门槛上是 450ms 和 5000ms 的差别。',
      '',
      '**没有「已结算」标记也不会被晚到的响应覆盖。** 因为被放弃的那个 promise',
      '根本没人再去 `.then` 它——`Promise.race` 的输家会被静默丢弃。',
      '如果实现里在 race 之外还保留了对它的引用并写回结果，就需要一个标记；',
      '不保留引用是更简单的做法。',
      '',
      '**预算用绝对时刻而不是剩余时长。** 并发场景下「剩余多少」需要在每次启动和',
      '结束时更新，很容易漏。`now() >= deadline` 是无状态的，随便什么时候问都对。',
      '',
      '**预算耗尽的 URL 仍然占一个结果位。** 返回一个比输入短的数组会让调用方',
      '没法把结果和输入对应起来——它只知道「少了几个」，不知道是哪几个。',
    ].join('\n'),
    [
      'The slot follows the race, not the request. `runOne` returns the moment the race settles; the',
      'abandoned request is still pending on the event loop while the worker has already pulled the next',
      'URL. That one behavioural difference is 450ms versus 5000ms on the gate.',
      '',
      'No "settled" flag is needed to keep late responses out, because nothing ever `.then`s the abandoned',
      'promise again — the loser of a `Promise.race` is silently dropped. An implementation that keeps a',
      'reference and writes back would need the flag; not keeping one is simpler.',
      '',
      'The budget is an absolute instant rather than a remaining duration. Under concurrency, "how much is',
      'left" must be updated on every start and finish and is easy to get wrong. `now() >= deadline` is',
      'stateless and correct whenever it is asked.',
      '',
      'URLs skipped for budget still occupy a result slot. Returning a shorter array than the input leaves',
      'the caller unable to line results up with what they asked for — they know some are missing, not which.',
    ].join('\n')
  ),
};

const stage4 = {
  id: 'retry-backoff',
  title: t('第 4 关 · 重试与指数退避', 'Stage 4 · Retry with exponential backoff'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '真实的下游会抖动。`/api/pages/flaky` 前两次一定失败，第三次才成功。',
      '这种错误不该让整批数据缺一块 —— 它只需要再试一次。',
      '',
      '## 要实现什么',
      '',
      '在 `src/retry.ts` 实现：',
      '',
      '```ts',
      'withRetry(task, { retries, baseDelayMs, factor })',
      '```',
      '',
      '| 规则 | 说明 |',
      '| --- | --- |',
      '| 退避 | 第 n 次失败后等 `baseDelayMs × factor^(n-1)` 再重试（`factor` 默认 2） |',
      '| 次数 | 一共最多 `retries + 1` 次尝试 |',
      '| 用尽 | 抛出**最后一次**的错误，不是第一次的 |',
      '| 可选筛选 | `isRetryable(error)` 返回 false 时立刻停手 |',
      '',
      '然后让 `fetchPage` 在 `options.retries` 存在时走重试。',
      '',
      '## 怎么算过',
      '',
      '- 确实发生了重试（门槛 `requests.retries ≥ 2`）；',
      '- 整条重试链路在 450ms 内完成（门槛 `virtualElapsedMs ≤ 450`）；',
      '- 重试成功后返回的是成功结果；',
      '- 全部失败后 `fetchPage` 仍然返回 `{ ok: false }`，不抛异常。',
      '',
      '## 为什么必须退避',
      '',
      '没有退避的重试，等于在下游最虚弱的时候**加倍打它**。',
      '下游变慢通常是因为过载，而过载时所有客户端都在超时、都在重试 ——',
      '如果每个都立刻重发，下游收到的流量瞬间翻几倍，它就再也起不来了。',
      '',
      '等待时间要随失败次数增长，这样才能给下游一个真正喘息的窗口。',
      '',
      '延迟门槛卡在 450ms，就是要求退避**存在但不过分**：',
      '`50 → 100` 这样的序列刚好，而 `500 → 1000` 就把一次正常的抖动',
      '拖成了用户能感知的卡顿。',
      '',
      '另外注意 `fetchPage` 的错误边界没有变：重试在里面发生，',
      '外面依然只看到一个 `PageResult`。第 1 关立的规矩，一路都不破。',
    ].join('\n'),
    [
      'Real upstreams flap. `/api/pages/flaky` fails its first two calls and succeeds on the third. That',
      'kind of failure should not leave a hole in the batch — it just needs another attempt.',
      '',
      '## What to build',
      '',
      'In `src/retry.ts`:',
      '',
      '```ts',
      'withRetry(task, { retries, baseDelayMs, factor })',
      '```',
      '',
      '| Rule | Detail |',
      '| --- | --- |',
      '| Backoff | After the n-th failure wait `baseDelayMs × factor^(n-1)` (`factor` defaults to 2) |',
      '| Attempts | At most `retries + 1` attempts in total |',
      '| Exhaustion | Throw the **last** error, not the first |',
      '| Optional filter | Stop immediately when `isRetryable(error)` returns false |',
      '',
      'Then wire `fetchPage` to use it when `options.retries` is set.',
      '',
      '## What counts as passing',
      '',
      '- Retries actually happen (`requests.retries ≥ 2`);',
      '- The whole retry chain finishes within 450ms (`virtualElapsedMs ≤ 450`);',
      '- A successful retry returns a successful result;',
      '- After exhausting attempts `fetchPage` still returns `{ ok: false }` rather than throwing.',
      '',
      '## Why backoff is mandatory',
      '',
      'Retrying without backoff means **hitting a dependency hardest exactly when it is weakest**. A',
      'downstream usually slows because it is overloaded, and while overloaded every client is timing out and',
      'retrying — if each one resends instantly, the traffic it receives multiplies and it never recovers.',
      '',
      'The wait must grow with the failure count so the downstream gets a real window to breathe.',
      '',
      'The 450ms gate asks for backoff that **exists but is not excessive**: a `50 → 100` sequence fits, while',
      '`500 → 1000` turns an ordinary blip into a stall the user can feel.',
      '',
      'Note also that `fetchPage`\'s error boundary is unchanged: retrying happens inside, and the outside',
      'still sees only a `PageResult`. The rule set in stage 1 holds all the way through.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**withRetry 的循环**',
      '',
      '```mermaid',
      'flowchart TD',
      '  W["withRetry(task, options)"] --> L["attempt = 1 … retries + 1"]',
      '  L --> T["await task(attempt)"]',
      '  T --> R{"成功了吗？"}',
      '  R -- 成功 --> RET["直接返回结果"]',
      '  R -- 失败 --> SAVE["lastError = error<br/>留到最后抛<br/>抛第一次的会误导排查"]',
      '  SAVE --> EX{"attempt > retries？"}',
      '  EX -- 次数用尽 --> THROW["抛出 lastError"]',
      '  EX -- 还有次数 --> RB{"isRetryable(error)？"}',
      '  RB -- 不可重试 --> THROW',
      '  RB -- 可重试 --> S["sleep(baseDelayMs × factor^(attempt-1))"]',
      '  S --> L',
      '```',
      '',
      '`S → L` 那条回边是唯一会消耗时间的路径，指数在 `attempt` 上 ——',
      '尝试次数每加一次，等待就翻一倍，这正是「给下游喘息」的形状。',
      '',
      '**fetchPage 怎么接它**',
      '',
      '```mermaid',
      'flowchart TD',
      '  C1["options.retries 存在 → 包一层 withRetry"] --> C2["isRetryable：408 / 429 / 5xx 可重试<br/>没有 status 的网络错误也可重试"]',
      '  C2 --> C3["最外层照旧 catch 成 { ok: false }<br/>第 1 关的错误边界不变"]',
      '```',
      '',
      '`isRetryable` 在这一关只是个可选钩子，下一关会把它变成主角：',
      '决定「什么错误该重试」，比「怎么重试」重要得多。',
    ].join('\n'),
    [
      '**The withRetry loop**',
      '',
      '```mermaid',
      'flowchart TD',
      '  W["withRetry(task, options)"] --> L["attempt = 1 … retries + 1"]',
      '  L --> T["await task(attempt)"]',
      '  T --> R{"did it succeed?"}',
      '  R -- succeeded --> RET["return the result"]',
      '  R -- failed --> SAVE["lastError = error<br/>kept for the end<br/>throwing the first one misleads debugging"]',
      '  SAVE --> EX{"attempt > retries?"}',
      '  EX -- exhausted --> THROW["throw lastError"]',
      '  EX -- "attempts remain" --> RB{"isRetryable(error)?"}',
      '  RB -- "not retryable" --> THROW',
      '  RB -- retryable --> S["sleep(baseDelayMs × factor^(attempt-1))"]',
      '  S --> L',
      '```',
      '',
      'The `S → L` back-edge is the only path that costs time, and the exponent is on `attempt` — each',
      'additional attempt doubles the wait, which is the shape of "give the downstream room to breathe".',
      '',
      '**How fetchPage wires it in**',
      '',
      '```mermaid',
      'flowchart TD',
      '  C1["options.retries set → wrap in withRetry"] --> C2["isRetryable: 408 / 429 / 5xx retry<br/>network errors without a status retry too"]',
      '  C2 --> C3["still caught into { ok: false } at the edge<br/>stage 1\'s boundary is unchanged"]',
      '```',
      '',
      '`isRetryable` is only an optional hook here; the next stage promotes it to the main character, because',
      'deciding **which** failures deserve a retry matters far more than how the retry is done.',
    ].join('\n')
  ),
  checklist: [
    t('第 3 次尝试成功，整体返回成功', 'Succeeds on the third attempt'),
    t('退避是指数增长的，不是固定间隔', 'Backoff grows exponentially, not linearly'),
    t('重试用尽后抛出最后一次错误', 'Throws the last error after exhausting retries'),
    t('不重试不可重试的错误（4xx）', 'Does not retry non-retryable (4xx) errors'),
  ],
  pitfalls: [
    t(
      '一批请求同时失败，然后每隔 100ms 一起重试一次。这种固定间隔会形成惊群，把刚要恢复的下游再打挂一次。',
      'A batch fails together, then retries together every 100ms. Fixed intervals create a thundering herd that knocks the recovering dependency back down.'
    ),
    t(
      '对所有错误都重试：404 重试 3 次还是 404，只是把一次失败变成三次失败。可重试的是暂时性故障（429/5xx/超时），不是语义错误。',
      'Retrying every error: a 404 retried three times is still a 404, you turned one failure into three. Only transient failures (429/5xx/timeouts) are retryable.'
    ),
    t(
      '把重试写进 fetchPage 内部的 for 循环：下次换个下游、想换个退避策略，就得改业务代码。重试的节奏和是否该重试应该分开。',
      'Baking the retry loop into fetchPage: changing the backoff or the dependency now means editing business code. Separate the retry rhythm from the retryability policy.'
    ),
    t(
      '读请求重试无害，扣款重试三次可能就扣了三次。重试的前提是操作幂等，或者带幂等键。',
      'Retrying a read is harmless. Retrying a charge three times may bill three times. Retry assumes the operation is idempotent, or carries an idempotency key.'
    ),
  ],
  hints: [
    t(
      '用 @lab/env 的 sleep 来等待，它跑在虚拟时钟上，用例会精确校验退避时长。',
      'Use sleep from @lab/env, it runs on the virtual clock and the specs check the exact backoff.'
    ),
    t(
      'retries=2 表示「最多再试 2 次」，也就是最多 3 次调用。',
      'retries=2 means "at most 2 more attempts", i.e. 3 calls in total.'
    ),
    t(
      '429/500/503 值得重试，400/404 重试多少次都不会变好，用 error.status 区分。',
      '429/500/503 are worth retrying; 400/404 never will be. Branch on error.status.'
    ),
  ],
  extension: t(
    [
      '生产环境的退避通常还要加上抖动（jitter）。AWS 那篇经典的 ',
      '[Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) ',
      '给出的结论是：纯指数退避仍然会让同批失败的客户端在同一时刻重试，加上随机抖动之后，',
      '完成时间和下游压力都显著下降。常见的三种：',
      '',
      '```',
      'full jitter:  sleep = random(0, base * 2^n)',
      'equal jitter: sleep = base * 2^n / 2 + random(0, base * 2^n / 2)',
      'decorrelated: sleep = min(cap, random(base, prev * 3))',
      '```',
      '',
      '本关为了让用例可精确断言没有引入抖动，但真实系统里应该有。',
      '`@lab/env` 提供了可复现的 `random()`，你可以自己加上试试。',
      '',
      '另外两个真实系统里的概念：',
      '',
      '- 重试预算（retry budget）：限制「重试流量占总流量的比例」（如 10%），',
      '  避免大面积故障时重试把集群彻底压垮。gRPC 和 Envoy 都内置了这个机制。',
      '- **重试放大**：如果调用链有 3 层、每层重试 3 次，最底层会收到 27 倍流量。',
      '  所以通常只在最外层或最靠近故障的一层重试。',
    ].join('\n'),
    [
      'Production backoff usually adds **jitter**. The classic AWS post ',
      '[Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) ',
      'shows that pure exponential backoff still makes a batch retry in lockstep; adding randomness cuts both',
      'completion time and downstream load. Three common variants:',
      '',
      '```',
      'full jitter:  sleep = random(0, base * 2^n)',
      'equal jitter: sleep = base * 2^n / 2 + random(0, base * 2^n / 2)',
      'decorrelated: sleep = min(cap, random(base, prev * 3))',
      '```',
      '',
      'This stage omits jitter so the specs can assert exact timings, real systems should have it.',
      '`@lab/env` exposes a reproducible `random()` if you want to try.',
      '',
      'Two more production concepts:',
      '',
      '- Retry budget: cap retries as a fraction of total traffic (say 10%) so a broad outage',
      '  does not get finished off by retries. Both gRPC and Envoy ship this.',
      '- Retry amplification: 3 layers each retrying 3 times means 27x load at the bottom.',
      '  Retry at one layer only, the outermost, or the one closest to the failure.',
    ].join('\n')
  ),
  focus: ['resilience', 'latency'],
  lab: {
    defaultLatencyMs: 100,
    endpoints: {
      '/api/pages/flaky': { failFirstN: 2, status: 503 },
      '/api/pages/missing': { failFirstN: 99, status: 404 },
    },
  },
  starterFiles: [
    file(
      'src/retry.ts',
      code`
        export interface RetryOptions {
          /** How many extra retries at most (the first call excluded) */
          retries: number;
          /** How long the first backoff waits */
          baseDelayMs: number;
          /** Backoff multiplier, defaults to 2 */
          factor?: number;
          /** Decide whether an error is worth retrying; retries everything by default */
          isRetryable?: (error: unknown) => boolean;
        }

        /**
         * Retry with exponential backoff.
         * task receives the current attempt number, starting at 1.
         */
        export async function withRetry<T>(
          task: (attempt: number) => Promise<T>,
          options: RetryOptions
        ): Promise<T> {
          // TODO: implement this
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
        import { withRetry } from '../src/retry';
        import { fetchPage } from '../src/fetcher';
        import { getMetrics } from '@lab/net';
        import { now } from '@lab/env';

        describe('Stage 4 · Retries and backoff', () => {
          it('succeeds on the third try after failing twice [gate:retry]', async () => {
            const result = await fetchPage('/api/pages/flaky', { retries: 3, baseDelayMs: 50 });
            expect(result.ok).toBe(true);
            const metrics = getMetrics();
            expect(metrics.requests.total).toBe(3);
            expect(metrics.requests.retries).toBe(2);
          });

          it('backoff grows exponentially [gate:backoff]', async () => {
            await fetchPage('/api/pages/flaky', { retries: 3, baseDelayMs: 50 });
            // Three requests at 100ms each, plus 50ms + 100ms of backoff
            expect(getMetrics().virtualElapsedMs).toBe(450);
          });

          it('a fixed-interval backoff is detected', async () => {
            let attempts = 0;
            const startedAt = now();
            await withRetry(
              async (attempt) => {
                attempts = attempt;
                if (attempt < 4) throw new Error('flaky');
                return 'ok';
              },
              { retries: 3, baseDelayMs: 100, factor: 2 }
            );
            expect(attempts).toBe(4);
            // 100 + 200 + 400
            expect(now() - startedAt).toBe(700);
          });

          it('throws the last error once retries are exhausted', async () => {
            await expect(async () =>
              withRetry(
                async (attempt) => {
                  throw new Error('attempt ' + attempt + ' failed');
                },
                { retries: 2, baseDelayMs: 10 }
              )
            ).rejects.toThrow('attempt 3 failed');
          });

          it('does not retry unrecoverable errors such as 404', async () => {
            const result = await fetchPage('/api/pages/missing', { retries: 3, baseDelayMs: 10 });
            expect(result.ok).toBe(false);
            expect(getMetrics().requests.total).toBe(1);
          });

          it('succeeding on the first try produces no waiting at all', async () => {
            const startedAt = now();
            const result = await fetchPage('/api/pages/1', { retries: 3, baseDelayMs: 100 });
            expect(result.ok).toBe(true);
            // Just the 100ms of a single request, with no extra backoff
            expect(now() - startedAt).toBe(100);
            expect(getMetrics().requests.total).toBe(1);
          });

          it('retries set to 0 means a single attempt', async () => {
            let attempts = 0;
            await expect(async () =>
              withRetry(
                async () => {
                  attempts += 1;
                  throw new Error('nope');
                },
                { retries: 0, baseDelayMs: 10 }
              )
            ).rejects.toThrow('nope');
            expect(attempts).toBe(1);
          });

          it('factor is configurable', async () => {
            const startedAt = now();
            let attempts = 0;
            await withRetry(
              async () => {
                attempts += 1;
                if (attempts < 3) throw new Error('again');
                return 'ok';
              },
              { retries: 3, baseDelayMs: 100, factor: 3 }
            );
            // 100 + 300
            expect(now() - startedAt).toBe(400);
          });

          it('task can see which attempt it is on', async () => {
            const seen: number[] = [];
            await withRetry(
              async (attempt) => {
                seen.push(attempt);
                if (attempt < 3) throw new Error('retry me');
                return attempt;
              },
              { retries: 3, baseDelayMs: 1 }
            );
            expect(seen).toEqual([1, 2, 3]);
          });

          it('gives up immediately when isRetryable returns false', async () => {
            let attempts = 0;
            await expect(async () =>
              withRetry(
                async () => {
                  attempts += 1;
                  throw new Error('fatal');
                },
                { retries: 5, baseDelayMs: 1, isRetryable: () => false }
              )
            ).rejects.toThrow('fatal');
            expect(attempts).toBe(1);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'requests.retries',
      op: 'gte',
      value: 2,
      zh: '确实发生了重试',
      en: 'Retries actually happen',
      dimension: 'resilience',
      scope: 'gate:retry',
    }),
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 450,
      unit: 'ms',
      zh: '重试链路 ≤ 450ms',
      en: 'Retry path within 450ms',
      dimension: 'latency',
      scope: 'gate:backoff',
    }),
  ],
  referenceFiles: [
    file(
      'src/retry.ts',
      code`
        export interface RetryOptions {
          retries: number;
          baseDelayMs: number;
          factor?: number;
          isRetryable?: (error: unknown) => boolean;
        }

        import { sleep } from '@lab/env';

        export async function withRetry<T>(
          task: (attempt: number) => Promise<T>,
          options: RetryOptions
        ): Promise<T> {
          const factor = options.factor ?? 2;
          const isRetryable = options.isRetryable ?? (() => true);
          let lastError: unknown;

          for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
            try {
              return await task(attempt);
            } catch (error) {
              lastError = error;
              const exhausted = attempt > options.retries;
              if (exhausted || !isRetryable(error)) break;
              await sleep(options.baseDelayMs * Math.pow(factor, attempt - 1));
            }
          }

          throw lastError;
        }
      `
    ),
    file(
      'src/fetcher.ts',
      code`
        import { request } from '@lab/net';
        import { mapWithConcurrency } from './pool';
        import { withRetry } from './retry';
        import type { FetchOptions, PageResult } from './contract';

        const RETRYABLE_STATUS = [408, 429, 500, 502, 503, 504];

        function isRetryable(error: unknown): boolean {
          const status = (error as { status?: number }).status;
          return status === undefined || RETRYABLE_STATUS.indexOf(status) !== -1;
        }

        export async function fetchPage(url: string, options: FetchOptions = {}): Promise<PageResult> {
          const run = () => request(url);

          try {
            const response = options.retries
              ? await withRetry(run, {
                  retries: options.retries,
                  baseDelayMs: options.baseDelayMs ?? 50,
                  isRetryable,
                })
              : await run();
            return { url, ok: true, data: response.data };
          } catch (error) {
            return { url, ok: false, data: null, error: (error as Error).message };
          }
        }

        export async function fetchAll(urls: string[], options: FetchOptions = {}): Promise<PageResult[]> {
          const concurrency = options.concurrency && options.concurrency > 0 ? options.concurrency : 1;
          return mapWithConcurrency(urls, concurrency, (url) => fetchPage(url, options));
        }
      `
    ),
  ],
  referenceNotes: t(
    '重试策略要和「错误是否可恢复」解耦：withRetry 只管节奏，isRetryable 由调用方注入，这样同一个原语能服务不同的下游。',
    'Keep the retry rhythm separate from the retryability policy: withRetry owns timing, the caller injects isRetryable, so one primitive serves many dependencies.'
  ),
};

/* ------------------------------------------------------------------ */
/* 阶段 4：缓存与单飞                                                   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

const stage5 = {
  id: 'failure-policy',
  title: t('第 5 关 · 错误分类与限流响应', 'Stage 5 · Classifying failures and honouring throttling'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关的重试对所有错误一视同仁。这是个很贵的假设：',
      '',
      '- 404 重试三次仍然是 404，只是白白多打了三次；',
      '- 429 说的是「你太快了」，指数退避那点时间根本不够，重试反而让限流更严重。',
      '',
      '## 要实现什么',
      '',
      '在 `src/policy.ts` 实现两个东西。',
      '',
      '**`classify(error)`** —— 把失败分成三类：',
      '',
      '| 类别 | 覆盖 | 策略 |',
      '| --- | --- | --- |',
      '| `permanent` | 4xx（除 429、408、425） | **一次都不许重试**，直接失败 |',
      '| `throttled` | 429 | 等一个**固定的、较长的**时间再试，不用指数退避 |',
      '| `retryable` | 5xx、408、425、网络错误 | 指数退避重试 |',
      '',
      '**`fetchWithPolicy(url, options)`** —— 按分类执行对应策略，',
      '失败时仍然返回 `PageResult`，不抛。',
      '',
      '## 怎么算过',
      '',
      '- 打一个 404，**总请求数正好是 1**（门槛 `requests.total = 1`）；',
      '- 撞上 429 时总耗时体现出真的按 `throttleDelayMs` 退了',
      '  （门槛 `virtualElapsedMs ≥ 900`）；',
      '- 5xx 走指数退避并能重试成功；',
      '- 网络层错误（拿不到 status）被判为可重试。',
      '',
      '## 两个分类边界值得单独记住',
      '',
      '**没有 status 的错误是网络层错误** —— 连接被拒、DNS 失败。',
      '它恰恰是**最该重试**的一类，因为它往往是瞬时的。',
      '不能因为「拿不到 status」就保守地判成永久失败，那会让一次网络抖动变成一次数据缺失。',
      '',
      '**4xx 里 408 和 425 是例外。** 408 是请求超时、425 是「太早了」，',
      '两者的语义都是「再试一次可能就好了」。按区间一刀切会把它们错判成永久失败。',
      '',
      '## 为什么门槛卡在这两个数字上',
      '',
      '`requests.total = 1` 不给任何折中余地：多打一次，就是在给一个',
      '**已知会失败**的接口加压。',
      '',
      '`virtualElapsedMs ≥ 900` 是一个**下限**门槛 —— 这个项目里少见 ——',
      '它要求你真的退避了。用 50ms 的指数退避去应付秒级的限流窗口，等于没退。',
      '',
      '「什么错误该重试」这个判断，比「怎么重试」重要得多。',
      '重试策略写得再精妙，用在不该重试的错误上都是纯粹的放大器。',
    ].join('\n'),
    [
      'The retry from the last stage treats every failure alike. That is an expensive assumption:',
      '',
      '- a 404 retried three times is still a 404, just three extra requests;',
      '- a 429 means "you are going too fast", where a few tens of milliseconds of exponential backoff is',
      '  nowhere near enough and retrying makes the throttling worse.',
      '',
      '## What to build',
      '',
      'Two things in `src/policy.ts`.',
      '',
      '**`classify(error)`** — sort failures into three kinds:',
      '',
      '| Kind | Covers | Policy |',
      '| --- | --- | --- |',
      '| `permanent` | 4xx except 429, 408, 425 | **Never retried**, fail immediately |',
      '| `throttled` | 429 | Wait a **fixed, longer** delay, not exponential backoff |',
      '| `retryable` | 5xx, 408, 425, network errors | Exponential backoff |',
      '',
      '**`fetchWithPolicy(url, options)`** — apply the policy for each kind, still returning a `PageResult`',
      'on failure rather than throwing.',
      '',
      '## What counts as passing',
      '',
      '- Hitting a 404 produces **exactly one request** (`requests.total = 1`);',
      '- On a 429 the elapsed time shows a real `throttleDelayMs` backoff (`virtualElapsedMs ≥ 900`);',
      '- 5xx backs off exponentially and can succeed on a retry;',
      '- Network-layer errors (no status available) are classified retryable.',
      '',
      '## Two classification boundaries worth remembering',
      '',
      '**An error without a status is a network-layer error** — connection refused, DNS failure. It is',
      'precisely the **most** retryable kind, because it is usually transient. Classifying it as permanent',
      'just because no status is available turns a network blip into missing data.',
      '',
      '**408 and 425 are exceptions inside 4xx.** A 408 is a request timeout and a 425 is "too early"; both',
      'mean "another attempt may well work". Slicing purely by range misclassifies them as permanent.',
      '',
      '## Why the gates are these two numbers',
      '',
      '`requests.total = 1` leaves no room for compromise: one extra request is load added to an endpoint',
      '**already known to fail**.',
      '',
      '`virtualElapsedMs ≥ 900` is a **lower-bound** gate — rare in this project — and it demands that you',
      'really backed off. Answering a second-scale throttling window with 50ms of exponential backoff is not',
      'backing off.',
      '',
      'Deciding which failures deserve a retry matters far more than how the retry is performed. However',
      'elegant the strategy, applied to the wrong failure it is a pure amplifier.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**classify(error)** —— 三条分支覆盖所有失败',
      '',
      '```mermaid',
      'flowchart TD',
      '  N{"是 LabHttpError 吗？"}',
      '  N -- 不是 --> NET["retryable<br/>网络层错误：连接被拒、DNS 失败<br/>最该重试的一类"]',
      '  N -- 是 --> S429{"status === 429？"}',
      '  S429 -- 是 --> TH["throttled"]',
      '  S429 -- 否 --> S4{"4xx，且不是 408 / 425？"}',
      '  S4 -- 是 --> PERM["permanent"]',
      '  S4 -- 否 --> R5["retryable：5xx、408、425"]',
      '```',
      '',
      '**fetchWithPolicy** —— 一条循环服务三种策略',
      '',
      '```mermaid',
      'flowchart TD',
      '  F["fetchWithPolicy(url, options)"] --> LOOP["attempt = 0 … retries"]',
      '  LOOP --> REQ["await request(url)"]',
      '  REQ --> OK{"成功了吗？"}',
      '  OK -- 成功 --> DONE["{ ok: true, data }"]',
      '  OK -- 失败 --> KIND{"classify(error)"}',
      '  KIND -- permanent --> BRK["break —— 一次都不重试"]',
      '  KIND -- throttled --> D1["sleep(throttleDelayMs)<br/>固定长等待，等的是限流窗口重置"]',
      '  KIND -- retryable --> D2["sleep(baseDelayMs × 2^attempt)<br/>指数退避"]',
      '  D1 --> LOOP',
      '  D2 --> LOOP',
      '  BRK --> FAIL["返回 { ok: false, error }<br/>失败也是 PageResult，不抛"]',
      '```',
      '',
      '要点：三种策略的区别只落在**等多久**和**要不要继续**这两个决定上。',
      '`permanent → break` 那条边就是第一个门槛：循环在第一次失败时直接结束，',
      '总请求数因此正好是 1。',
      '',
      '`throttled` 和 `retryable` 分开走两个 sleep，是第二个门槛的来源。',
      '把它们合并成同一个指数退避，代码短了一行，然后限流窗口永远等不到重置。',
    ].join('\n'),
    [
      '**classify(error)** — three branches covering every failure',
      '',
      '```mermaid',
      'flowchart TD',
      '  N{"is it a LabHttpError?"}',
      '  N -- no --> NET["retryable<br/>network layer: connection refused, DNS failure<br/>the most retryable kind of all"]',
      '  N -- yes --> S429{"status === 429?"}',
      '  S429 -- yes --> TH["throttled"]',
      '  S429 -- no --> S4{"4xx, and not 408 / 425?"}',
      '  S4 -- yes --> PERM["permanent"]',
      '  S4 -- no --> R5["retryable: 5xx, 408, 425"]',
      '```',
      '',
      '**fetchWithPolicy** — one loop serving all three policies',
      '',
      '```mermaid',
      'flowchart TD',
      '  F["fetchWithPolicy(url, options)"] --> LOOP["attempt = 0 … retries"]',
      '  LOOP --> REQ["await request(url)"]',
      '  REQ --> OK{"did it succeed?"}',
      '  OK -- succeeded --> DONE["{ ok: true, data }"]',
      '  OK -- failed --> KIND{"classify(error)"}',
      '  KIND -- permanent --> BRK["break — no retry at all"]',
      '  KIND -- throttled --> D1["sleep(throttleDelayMs)<br/>a fixed long wait, sized to the throttling window"]',
      '  KIND -- retryable --> D2["sleep(baseDelayMs × 2^attempt)<br/>exponential backoff"]',
      '  D1 --> LOOP',
      '  D2 --> LOOP',
      '  BRK --> FAIL["return { ok: false, error }<br/>failure is a PageResult too, never a throw"]',
      '```',
      '',
      'The point: the three policies differ only in **how long to wait** and **whether to continue**. The',
      '`permanent → break` edge is the first gate: the loop ends on the first failure, which is why the',
      'request total is exactly one.',
      '',
      '`throttled` and `retryable` reaching separate sleeps is where the second gate comes from. Merge them',
      'into one exponential backoff and the code is a line shorter — and the throttling window never gets a',
      'chance to reset.',
    ].join('\n')
  ),
  checklist: [
    t('4xx 不重试，一次就失败', '4xx fails on the first attempt with no retry'),
    t('429 用固定的长退避，不用指数退避', '429 uses a fixed long delay, not exponential backoff'),
    t('5xx 仍然指数退避重试', '5xx still retries with exponential backoff'),
    t('分类函数本身可以单独测试', 'The classifier is independently testable'),
    t('重试用尽后返回失败结果而不是抛异常', 'Exhausted retries return a failed result, not an exception'),
  ],
  pitfalls: [
    t(
      '把 429 归到 retryable 里。它确实该重试，但用指数退避的初始值（几十毫秒）去应付限流，等于立刻又打过去一次——服务端的限流窗口通常是秒级的。结果是重试全部撞在限流上，把重试预算白白烧完，最后仍然失败。',
      'Filing 429 under retryable. It should be retried, but the initial exponential delay of tens of milliseconds means hitting the server again immediately, while its throttling window is usually seconds. Every retry lands on the throttle, burning the whole budget and failing anyway.'
    ),
    t(
      '按「有没有 status」而不是按 status 的值分类。网络层错误（连接被拒、DNS 失败）没有 status，应该算 retryable；但如果实现写成「没有 status 就当 permanent」，一次网络抖动就会被判成永久失败，而它恰恰是最该重试的那一类。',
      'Classifying by whether a status exists rather than by its value. Network-layer errors — connection refused, DNS failure — carry no status and are the most retryable kind of all; an implementation that treats "no status" as permanent turns a transient blip into a permanent failure.'
    ),
    t(
      '把 408（请求超时）和 425（Too Early）也归进 permanent。它们虽然是 4xx，但语义上都是「再试一次可能就好了」。按区间一刀切很省事，代价是把两类本该重试的错误挡在门外——真实的重试策略都是按状态码逐个列白名单的。',
      'Sweeping 408 (Request Timeout) and 425 (Too Early) into permanent. They are 4xx, but both mean "trying again may well work". Slicing by range is convenient and shuts out two genuinely retryable failures — real retry policies enumerate status codes explicitly.'
    ),
    t(
      '重试用尽之后把最后那个错误抛出去。上一关的契约是「失败也要产出一条 PageResult」，抛出去会让整批请求里的一个失败炸掉整个 `Promise.all`。分类做得再对，边界契约破了一样不能用。',
      'Throwing the last error once retries are exhausted. The contract from the earlier stages is that a failure still produces a `PageResult`; throwing lets one failure inside a batch take down the whole `Promise.all`. However right the classification, breaking the boundary contract makes it unusable.'
    ),
  ],
  hints: [
    t(
      '`LabHttpError` 上有 `status`。分类函数先判断 `error instanceof LabHttpError`，拿到 status 之后再按 429 / 4xx / 其他分三路；不是 LabHttpError 的一律当 retryable。',
      '`LabHttpError` carries a `status`. Check `error instanceof LabHttpError` first, then branch on 429 / other 4xx / everything else; anything that is not a `LabHttpError` counts as retryable.'
    ),
    t(
      '三条策略共用一个循环，区别只在「这一轮要不要继续」和「等多久」。把这两个决定抽成两行，循环本身就不会变成三个分支的大杂烩。',
      'One loop serves all three policies; only "should there be another attempt" and "how long to wait" differ. Reduce those to two lines and the loop never becomes a tangle of three branches.'
    ),
  ],
  extension: t(
    [
      '真实的 429 响应通常带一个 `Retry-After` 头，值是秒数或者一个绝对时刻。',
      '按它退避比任何本地策略都准——服务端知道自己的限流窗口什么时候重置，客户端不知道。',
      '这一关的 lab 不提供响应头，所以用固定的 `throttleDelayMs` 代替，',
      '但真实实现里「有 Retry-After 就听它的」应该是第一条规则。',
      '',
      '错误分类还有一个常被忽略的维度：**幂等性**。',
      '一个 GET 超时了可以放心重试，一个 POST 超时了不行——你不知道服务端到底有没有处理。',
      'HTTP 的方法语义（GET/PUT/DELETE 幂等，POST 不幂等）正是为此存在的，',
      '而真正的解法是让写操作带幂等键，把「不确定有没有生效」变成「重试也只生效一次」。',
      '',
      '再往上一层是**重试预算**（retry budget）。就算每次重试都判断对了，',
      '当下游整体故障时，所有客户端同时重试仍然会把流量放大好几倍，',
      '让本来能自愈的抖动变成雪崩。gRPC 和 Envoy 的做法是给重试设一个',
      '「不超过总请求量 10%」的配额，超了就直接失败——宁可多失败一点，也不参与踩踏。',
    ].join('\n'),
    [
      'A real 429 usually carries a `Retry-After` header holding either a number of seconds or an absolute',
      'time. Honouring it beats any local policy: the server knows when its throttling window resets and',
      "the client does not. This stage's lab has no response headers, so a fixed `throttleDelayMs` stands",
      'in — but in a real implementation "obey Retry-After when present" should be the first rule.',
      '',
      'Classification has another commonly ignored dimension: idempotency. A timed-out GET can be retried',
      'safely; a timed-out POST cannot, because you do not know whether the server processed it. HTTP',
      'method semantics (GET, PUT and DELETE idempotent, POST not) exist for exactly this, and the real',
      'fix is idempotency keys on writes, turning "did it take effect?" into "retrying still takes effect',
      'once".',
      '',
      'One layer above sits the retry budget. Even with every individual decision correct, a broad',
      'downstream failure has every client retrying at once and multiplies traffic several times over,',
      'turning a self-healing blip into a stampede. gRPC and Envoy cap retries at a quota — no more than',
      'about 10% of total requests — and fail outright beyond it, preferring a few more failures to joining',
      'the pile-on.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'latency'],
  lab: {
    defaultLatencyMs: 100,
    endpoints: {
      '/api/throttled': { failFirstN: 2, status: 429 },
      '/api/missing': { failFirstN: 99, status: 404 },
      '/api/gone': { failFirstN: 99, status: 410 },
      '/api/flaky': { failFirstN: 2, status: 500 },
      '/api/broken': { failFirstN: 99, status: 503 },
    },
  },
  starterFiles: [
    file(
      'src/policy.ts',
      code`
        import type { PageResult } from './contract';

        export type FailureKind = 'permanent' | 'throttled' | 'retryable';

        export interface PolicyOptions {
          /** How many retries at most (the first attempt excluded) */
          retries: number;
          /** Exponential backoff base for retryable errors */
          baseDelayMs: number;
          /** Fixed backoff for throttled errors, usually far larger than baseDelayMs */
          throttleDelayMs: number;
        }

        export function classify(error: unknown): FailureKind {
          // TODO: implement this
          throw new Error('not implemented');
        }

        export function fetchWithPolicy(url: string, options: PolicyOptions): Promise<PageResult> {
          // TODO: implement this
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
        import { classify, fetchWithPolicy } from '../src/policy';
        import { LabHttpError, getMetrics } from '@lab/net';
        import { now } from '@lab/env';

        const OPTIONS = { retries: 3, baseDelayMs: 50, throttleDelayMs: 400 };

        describe('Stage 5 · Error classification', () => {
          it('404 is a permanent failure', () => {
            expect(classify(new LabHttpError('nope', 404, '/api/missing'))).toBe('permanent');
          });

          it('410 is a permanent failure too', () => {
            expect(classify(new LabHttpError('gone', 410, '/api/gone'))).toBe('permanent');
          });

          it('429 means throttled', () => {
            expect(classify(new LabHttpError('slow down', 429, '/api/throttled'))).toBe('throttled');
          });

          it('5xx is retryable', () => {
            expect(classify(new LabHttpError('boom', 500, '/api/flaky'))).toBe('retryable');
            expect(classify(new LabHttpError('unavailable', 503, '/api/broken'))).toBe('retryable');
          });

          it('an error with no status is treated as retryable', () => {
            // Connection refused and DNS failures land here, and they are exactly the ones worth retrying
            expect(classify(new Error('connection refused'))).toBe('retryable');
          });
        });

        describe('Stage 5 · Acting on the classification', () => {
          it('a normal request just succeeds', async () => {
            const result = await fetchWithPolicy('/api/ok', OPTIONS);
            expect(result.ok).toBe(true);
            expect(result.url).toBe('/api/ok');
          });

          it('a 5xx succeeds after retrying', async () => {
            const result = await fetchWithPolicy('/api/flaky', OPTIONS);
            expect(result.ok).toBe(true);
            // The first two fail and the third succeeds
            expect(getMetrics().requests.total).toBe(3);
          });

          it('a persistent 5xx exhausts retries and returns a failed result rather than throwing', async () => {
            const result = await fetchWithPolicy('/api/broken', OPTIONS);
            expect(result.ok).toBe(false);
            expect(result.data).toBeNull();
            expect(result.error).toBeTruthy();
            expect(getMetrics().requests.total).toBe(OPTIONS.retries + 1);
          });

          it('a 429 eventually succeeds', async () => {
            const result = await fetchWithPolicy('/api/throttled', OPTIONS);
            expect(result.ok).toBe(true);
            expect(getMetrics().requests.total).toBe(3);
          });

          it('a 4xx is never retried [gate:permanent]', async () => {
            const result = await fetchWithPolicy('/api/missing', OPTIONS);
            expect(result.ok).toBe(false);
            // Retrying a 404 only piles pressure on an endpoint already known to fail
            expect(getMetrics().requests.total).toBe(1);
          });

          it('a 410 is not retried either', async () => {
            await fetchWithPolicy('/api/gone', OPTIONS);
            expect(getMetrics().requests.total).toBe(1);
          });

          it('being throttled really does back off by throttleDelayMs [gate:throttle]', async () => {
            const startedAt = now();
            const result = await fetchWithPolicy('/api/throttled', OPTIONS);
            const elapsed = now() - startedAt;

            expect(result.ok).toBe(true);
            // Three requests at 300ms plus two throttle backoffs at 800ms.
            // An implementation using the 50ms exponential backoff for throttling lands around 450ms here
            expect(elapsed).toBeGreaterThanOrEqual(900);
          });

          it('a 5xx uses exponential backoff, not the long throttle backoff', async () => {
            const startedAt = now();
            await fetchWithPolicy('/api/flaky', OPTIONS);
            const elapsed = now() - startedAt;

            // 300ms of requests plus 50 + 100 of backoff, around 450ms, clearly shorter than the throttled path
            expect(elapsed).toBeLessThan(700);
          });

          it('with retries at 0 any failure is sent exactly once', async () => {
            await fetchWithPolicy('/api/flaky', { retries: 0, baseDelayMs: 50, throttleDelayMs: 400 });
            expect(getMetrics().requests.total).toBe(1);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'requests.total',
      op: 'eq',
      value: 1,
      zh: '永久失败一次都不重试',
      en: 'A permanent failure is never retried',
      dimension: 'resilience',
      scope: 'gate:permanent',
    }),
    gate({
      metric: 'virtualElapsedMs',
      op: 'gte',
      value: 900,
      unit: 'ms',
      zh: '被限流时真的退避了，而不是立刻重打',
      en: 'Throttling is answered with a real backoff, not an immediate retry',
      dimension: 'resilience',
      scope: 'gate:throttle',
    }),
  ],
  referenceFiles: [
    file(
      'src/policy.ts',
      code`
        import type { PageResult } from './contract';
        import { sleep } from '@lab/env';
        import { LabHttpError, request } from '@lab/net';

        export type FailureKind = 'permanent' | 'throttled' | 'retryable';

        export interface PolicyOptions {
          retries: number;
          baseDelayMs: number;
          throttleDelayMs: number;
        }

        /** For these particular 4xx codes the meaning is really \u2018try again and it might work\u2019, so the range cannot be treated uniformly */
        const RETRYABLE_4XX = [408, 425];

        export function classify(error: unknown): FailureKind {
          // An error with no status is a network-layer error (connection refused, DNS failure),
          // which is exactly the kind most worth retrying — do not call it permanent just because there is no status
          if (!(error instanceof LabHttpError)) return 'retryable';

          const status = error.status;
          if (status === 429) return 'throttled';
          if (status >= 400 && status < 500 && RETRYABLE_4XX.indexOf(status) === -1) {
            return 'permanent';
          }
          return 'retryable';
        }

        export async function fetchWithPolicy(url: string, options: PolicyOptions): Promise<PageResult> {
          let lastError: unknown = null;

          for (let attempt = 0; attempt <= options.retries; attempt += 1) {
            try {
              const response = await request(url);
              return { url, ok: true, data: response.data };
            } catch (error) {
              lastError = error;
              const kind = classify(error);

              // One loop serves all three policies; only these two decisions differ
              if (kind === 'permanent') break;
              if (attempt === options.retries) break;

              const delay =
                kind === 'throttled'
                  ? // Throttling windows are measured in seconds, and an exponential backoff starts far too small to outlast one
                    options.throttleDelayMs
                  : options.baseDelayMs * Math.pow(2, attempt);
              await sleep(delay);
            }
          }

          // The contract says a failure still produces a PageResult: throwing lets one failure
          // blow up the entire Promise.all in a bulk call
          return {
            url,
            ok: false,
            data: null,
            error: lastError instanceof Error ? lastError.message : String(lastError),
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**分类函数的默认分支是 `retryable`，不是 `permanent`。** 这个方向选反了会很难查：',
      '一个不认识的错误类型（网络层异常、序列化失败）被判成永久失败之后，',
      '表现是「偶发的、不重试的、没有堆栈的失败」，而它本来只要重试一次就好了。',
      '不确定的时候倾向重试，是这类策略的通用默认值。',
      '',
      '**`RETRYABLE_4XX` 这个白名单存在的意义。** 按 `status >= 400 && status < 500` 一刀切最省事，',
      '但 408（请求超时）和 425（Too Early）落在这个区间里，语义却是「再来一次」。',
      '真实的重试策略都是逐个状态码列白名单的，区间判断只是它的粗糙近似。',
      '',
      '**三种策略共用一个循环。** 差异被压缩成两行：`if (kind === \'permanent\') break;`',
      '和那个三元表达式选延迟。写成三个 if 分支各带一份循环，逻辑一样，',
      '但「重试次数怎么算」这件事就散落在三处，改一处忘两处。',
      '',
      '**限流的退避是固定值而不是指数。** 指数退避解决的是「大家同时重试造成碰撞」，',
      '而限流解决的是「你超过了服务端的速率窗口」。后者的正确等待时长由服务端决定，',
      '和你重试了几次没关系——所以它不该随 attempt 增长。',
    ].join('\n'),
    [
      "The classifier's default branch is `retryable`, not `permanent`. Getting that direction wrong is",
      'hard to diagnose: an unrecognised error — a network-layer exception, a deserialisation failure —',
      'judged permanent presents as an intermittent, un-retried, stackless failure that one retry would',
      'have fixed. Leaning towards retrying when unsure is the usual default for policies like this.',
      '',
      'Why the `RETRYABLE_4XX` allowlist exists. Slicing on `status >= 400 && status < 500` is convenient,',
      'but 408 (Request Timeout) and 425 (Too Early) sit in that range and mean "try again". Real retry',
      'policies enumerate status codes; the range check is only a coarse approximation of one.',
      '',
      'All three policies share one loop. The difference compresses to two lines: the `permanent` break and',
      'the ternary choosing the delay. Three separate branches each with their own loop compute the same',
      'thing while scattering "how attempts are counted" across three places, so a change to one forgets',
      'the other two.',
      '',
      'The throttled backoff is fixed, not exponential. Exponential backoff solves collisions between',
      'clients retrying together; throttling means you exceeded a server-side rate window. The right wait',
      'is decided by the server and has nothing to do with how many times you have tried, so it should not',
      'grow with the attempt number.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage6 = {
  id: 'hedging',
  title: t('第 6 关 · 对冲请求与尾延迟', 'Stage 6 · Hedged requests and tail latency'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '重试解决的是**失败**，对冲解决的是**慢**。',
      '',
      '一个服务 p50 是 30ms、p99 是 900ms 时，问题往往不是它整体慢，',
      '而是某台机器恰好在 GC、某个连接恰好排在长队后面。',
      '这种慢**没有错误可以捕获** —— 请求最终会成功，只是太晚了。',
      '',
      '对冲的思路很简单：**等一小会儿，如果还没回来，就再向另一个副本发一次，谁先回用谁**。',
      '',
      '## 要实现什么',
      '',
      '在 `src/hedge.ts` 实现 `hedgedFetch(replicas, options)`：',
      '',
      '| 规则 | 说明 |',
      '| --- | --- |',
      '| 逐个追加 | 先发 `replicas[0]`，等 `hedgeAfterMs` 还没结果再发下一个 |',
      '| 上限 | 最多同时在飞 `maxAttempts` 个 |',
      '| 先到先用 | 谁先**成功**就返回谁，其余的放弃 |',
      '| 全败才败 | 所有已发出的都失败，且没有副本可发了，才返回失败 |',
      '',
      '## 怎么算过',
      '',
      '- 慢副本 900ms、快副本 120ms、`hedgeAfterMs` 200 时，总耗时在 400ms 以内',
      '  （门槛 `virtualElapsedMs ≤ 400`）；',
      '- 主副本 150ms 就返回（快过 `hedgeAfterMs`）时，**总请求数正好是 1**',
      '  （门槛 `requests.total = 1`）；',
      '- 某个副本失败不影响其他副本继续；',
      '- 全部失败时返回失败结果，不抛。',
      '',
      '## 第二个门槛才是难点',
      '',
      '对冲的代价是额外的请求。一个「先全发出去再取最快的」的实现延迟同样漂亮，',
      '但把下游流量翻了好几倍 —— 那不是对冲，那是散弹枪。',
      '',
      '要做到「主副本够快时零额外流量」，关键是定时器醒来时**先看一眼有没有人已经结束了**。',
      '少了这一句判断，健康状态下也会持续产生一倍的无效流量，',
      '而且这种浪费不会有任何报错，只会体现在下游的账单和容量规划上。',
      '',
      '## 另外两处容易写错',
      '',
      '**不能用 `Promise.race`。** race 在第一个 promise **settle** 时就结束，',
      '而失败也是 settle —— 主副本失败时你会立刻返回失败，',
      '后面那个本来会成功的副本白发了。你需要的是「第一个**成功**」，',
      '这在标准库里没有直接对应（`Promise.any` 语义接近，但它无法配合逐个追加）。',
      '',
      '**在飞的全失败时应该立刻追发下一个**，不必再等满 `hedgeAfterMs` ——',
      '`hedgeAfterMs` 是为「慢」准备的等待，而现在你手上一个在飞的请求都没有了。',
    ].join('\n'),
    [
      'Retries address **failure**; hedging addresses **slowness**.',
      '',
      'When a service has a p50 of 30ms and a p99 of 900ms, the problem is usually not that it is slow',
      'overall but that one machine happens to be in GC or one connection happens to sit behind a long queue.',
      'There is **no error to catch** — the request will succeed, just far too late.',
      '',
      'The idea is simple: **wait a little, and if nothing came back, send another request to a different',
      'replica and take whichever answers first**.',
      '',
      '## What to build',
      '',
      '`hedgedFetch(replicas, options)` in `src/hedge.ts`:',
      '',
      '| Rule | Detail |',
      '| --- | --- |',
      '| Add one at a time | Send `replicas[0]`; if nothing settled after `hedgeAfterMs`, send the next |',
      '| Ceiling | At most `maxAttempts` in flight at once |',
      '| First success wins | Return the first **success** and abandon the rest |',
      '| Fail only when all fail | Everything launched failed and no replica remains to try |',
      '',
      '## What counts as passing',
      '',
      '- With a 900ms primary, a 120ms replica and `hedgeAfterMs` of 200, it finishes within 400ms',
      '  (`virtualElapsedMs ≤ 400`);',
      '- When the primary answers in 150ms (faster than `hedgeAfterMs`), the request total is **exactly 1**',
      '  (`requests.total = 1`);',
      '- One replica failing does not stop the others;',
      '- Total failure returns a failed result rather than throwing.',
      '',
      '## The second gate is the hard one',
      '',
      'Hedging costs extra requests. An implementation that fires everything and takes the fastest has',
      'equally pretty latency while multiplying downstream traffic — that is not hedging, that is a shotgun.',
      '',
      'Achieving "zero extra traffic when the primary is fast enough" comes down to one thing: when the timer',
      'wakes up, **check whether anything has already settled**. Without that check, a perfectly healthy',
      'system doubles its traffic permanently — and this waste produces no error at all, only a larger bill',
      'and a distorted capacity plan.',
      '',
      '## Two more things easy to get wrong',
      '',
      '**`Promise.race` will not do.** It settles on the first promise to **settle**, and a failure settles',
      'too — so a failing primary returns failure immediately, wasting the replica that was about to succeed.',
      'What you need is "the first **success**", which the standard library has no direct equivalent for',
      '(`Promise.any` is close in meaning but cannot cooperate with launching one at a time).',
      '',
      '**When everything in flight has failed, launch the next one immediately** rather than waiting out',
      'another `hedgeAfterMs` — that delay exists to wait on *slowness*, and right now you have nothing in',
      'flight at all.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**launch(index)** —— 唯一发请求的地方，开头那个判断是唯一的守门人',
      '',
      '```mermaid',
      'flowchart TD',
      '  G{"settled 或 index ≥ limit？"}',
      '  G -- 是 --> STOP["什么都不做<br/>定时器醒来时的这一句判断<br/>就是「主副本够快时零额外流量」"]',
      '  G -- 否 --> FIRE["launched += 1<br/>request(replicas[index])"]',
      '  FIRE --> TIMER["同时挂一个 sleep(hedgeAfterMs)<br/>到点再 launch(index + 1)"]',
      '```',
      '',
      '两个门槛都由 `G` 决定：主副本快就没人进得来（零额外流量），',
      '主副本慢时定时器带着下一个副本进来（尾延迟被压掉）。',
      '',
      '**每个请求结束时怎么收尾**',
      '',
      '```mermaid',
      'flowchart TD',
      '  RES{"某个请求的结果"}',
      '  RES -- 成功 --> FIN["finish(成功结果)<br/>settled = true，其余在飞的自然作废"]',
      '  RES -- 失败 --> CNT["failures += 1，记下 lastError"]',
      '  CNT --> ALLDEAD{"failures === launched？<br/>手上已经没有在飞的请求了"}',
      '  ALLDEAD -- "是，且已发满 limit" --> FAIL["finish(失败结果)"]',
      '  ALLDEAD -- "是，但还有副本没发" --> NOW["立刻 launch(下一个)<br/>不必再等满 hedgeAfterMs"]',
      '  ALLDEAD -- "否，还有在飞的" --> WAIT["继续等，什么也不做"]',
      '```',
      '',
      '这三条分支是「谁先成功」和「全败才败」的分界。',
      '换成 `Promise.race`，图上就只剩「第一个 settle → 结束」一条边，',
      '主副本一失败就收工，后面那个本来会成功的副本白发了。',
    ].join('\n'),
    [
      '**launch(index)** — the only place a request is issued, and the check at its top is the only gatekeeper',
      '',
      '```mermaid',
      'flowchart TD',
      '  G{"settled, or index ≥ limit?"}',
      '  G -- yes --> STOP["do nothing<br/>this check, run when the timer wakes,<br/>IS \'zero extra traffic when the primary is fast\'"]',
      '  G -- no --> FIRE["launched += 1<br/>request(replicas[index])"]',
      '  FIRE --> TIMER["also arm a sleep(hedgeAfterMs)<br/>which calls launch(index + 1) on expiry"]',
      '```',
      '',
      'Both gates are decided at `G`: a fast primary means nobody gets through (zero extra traffic); a slow',
      'one means the timer walks the next replica in (the tail latency is cut away).',
      '',
      '**How each settled request is handled**',
      '',
      '```mermaid',
      'flowchart TD',
      '  RES{"a request\'s outcome"}',
      '  RES -- succeeded --> FIN["finish(success)<br/>settled = true, everything else lapses"]',
      '  RES -- failed --> CNT["failures += 1, remember lastError"]',
      '  CNT --> ALLDEAD{"failures === launched?<br/>nothing is in flight any more"}',
      '  ALLDEAD -- "yes, and limit is reached" --> FAIL["finish(failure)"]',
      '  ALLDEAD -- "yes, replicas remain" --> NOW["launch the next one immediately<br/>no need to wait out another hedgeAfterMs"]',
      '  ALLDEAD -- "no, something is still in flight" --> WAIT["keep waiting, do nothing"]',
      '```',
      '',
      'These three branches are what separate "first success" from "fail only when all fail". Replace them',
      'with `Promise.race` and the diagram collapses to a single "first to settle → done" edge: the primary',
      'fails, you stop, and the replica that was about to succeed was sent for nothing.',
    ].join('\n')
  ),
  checklist: [
    t('主副本够快时只发一个请求', 'A fast primary means exactly one request'),
    t('主副本慢时按 hedgeAfterMs 追发副本', 'A slow primary triggers a hedge after hedgeAfterMs'),
    t('谁先成功返回谁', 'The first success wins'),
    t('在飞数量不超过 maxAttempts', 'No more than maxAttempts are in flight'),
    t('全部失败才返回失败', 'Failure is returned only when every replica fails'),
  ],
  pitfalls: [
    t(
      '一次性把所有副本都发出去，然后 `Promise.race`。延迟指标很好看，下游流量翻了 N 倍。对冲的定义就是「先等一会儿」——去掉这个等待，它就退化成了主动散弹。真实系统里这种实现会在下游本来就慢的时候把它彻底压垮。',
      'Firing every replica at once and racing them. The latency numbers look great and downstream traffic is multiplied N-fold. Waiting first is the definition of hedging; remove the wait and it degenerates into a deliberate shotgun, which flattens a downstream that was merely slow.'
    ),
    t(
      '追发副本之前不检查「是不是已经有结果了」。定时器在 200ms 时触发，而主副本 150ms 就回来了——但定时器不知道，照样发出去。表现是「明明很快返回了，请求数却是 2」，在主副本正常的时候持续产生一倍的无效流量。',
      'Not checking whether a result already arrived before firing the hedge. The timer fires at 200ms while the primary returned at 150ms — the timer does not know, and sends anyway. The symptom is a fast response with a request count of two, doubling traffic continuously whenever the primary is healthy.'
    ),
    t(
      '用 `Promise.race` 取第一个 settle 的结果。race 不区分成功和失败：如果第一个副本 50ms 就返回 500，race 立刻以失败告终，而那个 120ms 会成功的副本根本没机会。要的是「第一个**成功**」，不是「第一个结束」。',
      'Using `Promise.race` for the first settled result. A race does not distinguish success from failure: if the first replica returns a 500 in 50ms the race ends in failure and the replica that would have succeeded at 120ms never gets a chance. You want the first success, not the first completion.'
    ),
    t(
      '成功返回之后不停止后续的追发定时器。函数已经把结果交给调用方了，但 400ms、600ms 时的定时器仍然会醒来并发出请求——调用方看到的延迟是对的，下游看到的是一串没人要的请求。放弃要放弃干净。',
      'Returning a success without cancelling the pending hedge timers. The caller has its result, and the timers at 400ms and 600ms still wake up and issue requests. The caller sees the right latency while downstream sees a trail of requests nobody wants. Abandoning must be complete.'
    ),
  ],
  hints: [
    t(
      '维护一个 `settled` 标志。追发定时器醒来时先看这个标志，已经有结果就直接返回，什么都不做。这比真的去 clearTimeout 更简单，效果一样。',
      'Keep a `settled` flag. When a hedge timer wakes, check it first and do nothing if a result already exists. Simpler than actually clearing timers, with the same effect.'
    ),
    t(
      '「第一个成功」可以这样实现：给每个副本的 promise 挂上 `.then(成功就 resolve 外层)`，同时用一个计数器记录失败数，失败数等于已发出数且不会再发时才 reject。',
      'Implement "first success" by attaching `.then(resolve the outer promise on success)` to each replica, while a counter tracks failures and rejects only when the failure count equals the number issued and no more will be sent.'
    ),
  ],
  extension: t(
    [
      '对冲是 Google 那篇《The Tail at Scale》（Dean & Barroso, 2013）里的核心手法之一。',
      '论文里的数据很有说服力：在一个 100 台机器的服务上，就算单机 p99 只有 10ms，',
      '一个需要访问全部 100 台的请求，其 p99 会被放大到接近 140ms——',
      '因为「至少有一台慢」这件事几乎必然发生。',
      '',
      '论文给的对冲变体叫 **tied request**：两个副本都收到请求，但它们互相知道对方的存在，',
      '谁先开始处理就通知对方取消。这比单纯的对冲省一半的无效工作，代价是副本之间要通信。',
      '',
      '`hedgeAfterMs` 定成多少是个真问题。定成 p50 会让一半的请求都触发对冲，流量翻倍；',
      '通常取 p95 或 p99——只有真正落在长尾里的那 1% 会付出额外一次请求的代价，',
      '而收益是把 p99 拉到接近 p50。这是一个非常划算的交换，前提是这个分位数要**动态测量**，',
      '写死一个数字在负载变化时会立刻失效。',
      '',
      '还有一个前提容易被忽略：对冲只在请求**幂等**时安全。对一个 POST 做对冲，',
      '等于故意制造重复提交。gRPC 的 hedging 配置里因此明确要求声明哪些方法可以对冲。',
    ].join('\n'),
    [
      'Hedging is one of the central techniques in Google\'s "The Tail at Scale" (Dean and Barroso, 2013).',
      'The paper\'s numbers are persuasive: on a hundred-machine service where each machine has a p99 of',
      'just 10ms, a request that must touch all hundred sees its p99 stretch towards 140ms, because "at',
      'least one is slow" is almost certain to happen.',
      '',
      'The variant the paper describes is the tied request: both replicas receive the work and know about',
      'each other, so whichever starts first tells the other to drop it. That halves the wasted work',
      'compared to plain hedging, at the cost of replicas needing to communicate.',
      '',
      'Choosing `hedgeAfterMs` is a genuine problem. Setting it at p50 hedges half of all requests and',
      'doubles traffic; the usual choice is p95 or p99, so only the 1% genuinely in the tail pays for an',
      'extra request while p99 is pulled down towards p50. That is an excellent trade, provided the',
      'percentile is measured continuously — a hard-coded number stops being right the moment load shifts.',
      '',
      'One precondition is easy to overlook: hedging is only safe for idempotent requests. Hedging a POST',
      "is deliberately manufacturing a duplicate submission, which is why gRPC's hedging configuration",
      'requires declaring which methods may be hedged.',
    ].join('\n')
  ),
  focus: ['latency', 'resilience', 'concurrency'],
  lab: {
    defaultLatencyMs: 100,
    endpoints: {
      '/api/slow-primary': { latencyMs: 900 },
      '/api/fast-replica': { latencyMs: 120 },
      '/api/second-replica': { latencyMs: 150 },
      '/api/quick-primary': { latencyMs: 150 },
      '/api/broken-primary': { failFirstN: 99, status: 500, latencyMs: 50 },
    },
  },
  starterFiles: [
    file(
      'src/hedge.ts',
      code`
        import type { PageResult } from './contract';

        export interface HedgeOptions {
          /** Send the next replica if there is still no result after this long */
          hedgeAfterMs: number;
          /** How many may be in flight at once; defaults to the replica count */
          maxAttempts?: number;
        }

        /** Request the replicas in turn and return the first successful result */
        export function hedgedFetch(replicas: string[], options: HedgeOptions): Promise<PageResult> {
          // TODO: implement this
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
        import { hedgedFetch } from '../src/hedge';
        import { now, sleep } from '@lab/env';
        import { getMetrics } from '@lab/net';

        describe('Stage 6 · Hedged requests', () => {
          it('a single replica is just an ordinary request', async () => {
            const result = await hedgedFetch(['/api/quick-primary'], { hedgeAfterMs: 200 });
            expect(result.ok).toBe(true);
            expect(getMetrics().requests.total).toBe(1);
          });

          it('does not hedge when the primary replica is fast enough [gate:cheap]', async () => {
            const result = await hedgedFetch(
              ['/api/quick-primary', '/api/fast-replica', '/api/second-replica'],
              { hedgeAfterMs: 200 }
            );

            expect(result.ok).toBe(true);
            expect(result.url).toBe('/api/quick-primary');
            // It came back at 150ms, so the 200ms hedge timer must find a result already waiting when it wakes
            expect(getMetrics().requests.total).toBe(1);
          });

          it('hedges when the primary is slow and uses the replica\u2019s result [gate:tail]', async () => {
            const startedAt = now();
            const result = await hedgedFetch(['/api/slow-primary', '/api/fast-replica'], {
              hedgeAfterMs: 200,
            });
            const elapsed = now() - startedAt;

            expect(result.ok).toBe(true);
            expect(result.url).toBe('/api/fast-replica');
            // 200ms of waiting plus a 120ms replica = 320ms, rather than the primary\u2019s 900ms
            expect(elapsed).toBeLessThanOrEqual(400);
          });

          it('only two requests are sent in total after hedging', async () => {
            await hedgedFetch(['/api/slow-primary', '/api/fast-replica'], { hedgeAfterMs: 200 });
            expect(getMetrics().requests.total).toBe(2);
          });

          it('stops hedging further replicas once one succeeds', async () => {
            await hedgedFetch(
              ['/api/slow-primary', '/api/fast-replica', '/api/second-replica'],
              { hedgeAfterMs: 200 }
            );
            const afterResolve = getMetrics().requests.total;

            // Wait a long time: the hedge timers not yet due must not wake up and issue requests
            await sleep(2000);
            expect(getMetrics().requests.total).toBe(afterResolve);
            expect(afterResolve).toBe(2);
          });

          it('maxAttempts bounds how many are in flight', async () => {
            await hedgedFetch(
              ['/api/slow-primary', '/api/slow-primary', '/api/slow-primary', '/api/fast-replica'],
              { hedgeAfterMs: 100, maxAttempts: 2 }
            );
            expect(getMetrics().requests.total).toBeLessThanOrEqual(2);
          });

          it('does not finish early when the first replica fails', async () => {
            const result = await hedgedFetch(['/api/broken-primary', '/api/fast-replica'], {
              hedgeAfterMs: 100,
            });
            // A Promise.race implementation taking the first settle would end in failure at 50ms
            expect(result.ok).toBe(true);
            expect(result.url).toBe('/api/fast-replica');
          });

          it('only reports failure once every replica has failed', async () => {
            const result = await hedgedFetch(['/api/broken-primary', '/api/broken-primary'], {
              hedgeAfterMs: 100,
            });
            expect(result.ok).toBe(false);
            expect(result.data).toBeNull();
            expect(result.error).toBeTruthy();
          });

          it('the returned url is the replica that actually won', async () => {
            const result = await hedgedFetch(['/api/slow-primary', '/api/fast-replica'], {
              hedgeAfterMs: 200,
            });
            expect(result.url).toBe('/api/fast-replica');
          });

          it('an empty replica list fails rather than hanging', async () => {
            const result = await hedgedFetch([], { hedgeAfterMs: 100 });
            expect(result.ok).toBe(false);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 400,
      unit: 'ms',
      zh: '慢副本被对冲掉，尾延迟压到副本的速度',
      en: 'The slow replica is hedged away, tail latency drops to the fast one',
      dimension: 'latency',
      scope: 'gate:tail',
    }),
    gate({
      metric: 'requests.total',
      op: 'eq',
      value: 1,
      zh: '主副本够快时不产生额外流量',
      en: 'A fast primary generates no extra traffic',
      dimension: 'resilience',
      scope: 'gate:cheap',
    }),
  ],
  referenceFiles: [
    file(
      'src/hedge.ts',
      code`
        import type { PageResult } from './contract';
        import { sleep } from '@lab/env';
        import { request } from '@lab/net';

        export interface HedgeOptions {
          hedgeAfterMs: number;
          maxAttempts?: number;
        }

        export function hedgedFetch(replicas: string[], options: HedgeOptions): Promise<PageResult> {
          const limit = Math.min(options.maxAttempts ?? replicas.length, replicas.length);

          if (limit === 0) {
            return Promise.resolve({
              url: '',
              ok: false,
              data: null,
              error: 'no replicas to try',
            });
          }

          return new Promise<PageResult>((resolve) => {
            let settled = false;
            let launched = 0;
            let failures = 0;
            let lastError = 'all replicas failed';

            function finish(result: PageResult): void {
              if (settled) return;
              settled = true;
              resolve(result);
            }

            function launch(index: number): void {
              // Check this first when the timer fires: the primary may have returned before it.
              // Without this line, a healthy system keeps generating double the traffic for nothing
              if (settled || index >= limit) return;
              launched += 1;
              const url = replicas[index];

              request(url).then(
                (response) => finish({ url, ok: true, data: response.data }),
                (error) => {
                  failures += 1;
                  lastError = error instanceof Error ? error.message : String(error);
                  // Only \u2018everything already sent has failed and nothing more will be sent\u2019 counts as a real failure.
                  // A Promise.race implementation calls it a day on the first failure
                  if (failures === launched && launched >= limit) {
                    finish({ url, ok: false, data: null, error: lastError });
                  } else if (failures === launched) {
                    // Nothing is in flight any more, so send the next one now rather than waiting out hedgeAfterMs
                    launch(launched);
                  }
                }
              );

              if (index + 1 < limit) {
                sleep(options.hedgeAfterMs).then(() => launch(index + 1));
              }
            }

            launch(0);
          });
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`settled` 标志同时解决两个问题。** 它既保证 `resolve` 只生效一次，',
      '又让所有还没醒来的追发定时器变成空操作。真的去 `clearTimeout` 也可以，',
      '但要维护一个定时器数组，而且 `sleep()` 返回的是 promise 不是 id——',
      '用标志位是更贴合这个 API 的写法。',
      '',
      '**「第一个成功」不是 `Promise.race`。** race 在第一个 settle 时结束，不管成败。',
      '这里用的是显式的 `then(成功 -> finish, 失败 -> 计数)`：成功立刻收工，',
      '失败只是记一笔，等到「发出去的全失败了且没有下一个」才算真的失败。',
      '',
      '**失败时会提前追发。** `failures === launched` 意味着手上一个在飞的请求都没有了，',
      '这时候再等满 `hedgeAfterMs` 是纯浪费——等待的意义是「给主副本一个机会」，',
      '主副本已经明确失败了，机会就没有必要留。',
      '',
      '**追发是链式的而不是一次排好的。** 每次 `launch` 只安排下一个的定时器，',
      '而不是一开始就 `for` 循环排 N 个。这样每一环都会重新检查 `settled`，',
      '中途成功之后整条链自然断掉。',
    ].join('\n'),
    [
      'The `settled` flag solves two problems at once: it makes `resolve` effective only once, and it turns',
      'every hedge timer that has not fired yet into a no-op. Actually clearing timers would work too, but',
      'that means keeping an array of them, and `sleep()` returns a promise rather than an id — a flag fits',
      'this API better.',
      '',
      '"First success" is not `Promise.race`. A race ends at the first settlement regardless of outcome.',
      'This uses an explicit `then(success -> finish, failure -> count)`: a success finishes immediately, a',
      'failure only records itself, and real failure requires everything launched to have failed with',
      'nothing left to send.',
      '',
      'A failure launches the next hedge early. `failures === launched` means nothing is in flight, and',
      'waiting out the rest of `hedgeAfterMs` then is pure waste — the wait exists to give the primary a',
      'chance, and a primary that has definitively failed needs no more chances.',
      '',
      'Hedges are chained rather than scheduled up front. Each `launch` schedules only the next timer',
      'instead of looping over all N at the start, so every link re-checks `settled` and the whole chain',
      'breaks by itself once something succeeds.',
    ].join('\n')
  ),
};

const stage7 = {
  id: 'cache-single-flight',
  title: t('第 7 关 · 缓存与并发去重', 'Stage 7 · Caching and single-flight'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '同一批任务里经常出现重复地址；更糟的是，同一个地址的多个请求会**同时**打到下游。',
      '这两件事看起来像一个问题，其实要用两个机制解决。',
      '',
      '## 要实现什么',
      '',
      '在 `src/cache.ts` 实现两样东西：',
      '',
      '| 组件 | 职责 |',
      '| --- | --- |',
      '| `createCache({ ttlMs, maxSize })` | 带 TTL 的 LRU 缓存，暴露 `get` / `set` / `size` |',
      '| `createSingleFlight()` | 并发调用同一个 key 时只真正执行一次 loader，其余共享同一个 Promise |',
      '',
      '然后让 `fetchPage` 在 `options.ttlMs` 存在时走「**缓存 → 单飞 → 网络**」这条链。',
      '',
      '## 怎么算过',
      '',
      '- 热点地址只回源一次（门槛 `requests.total ≤ 1`）；',
      '- 去重后总延迟在 100ms 内（门槛 `virtualElapsedMs ≤ 100`）；',
      '- 过期条目读不到，并且被清掉；',
      '- 超过 `maxSize` 时淘汰**最久未使用**的那个，而不是最早写入的；',
      '- 只有成功的结果进缓存，失败的不缓存。',
      '',
      '## 缓存管「再次」，单飞管「同时」',
      '',
      '少了任何一个，热点 key 都会击穿到下游：',
      '',
      '- 只有缓存：10 个并发请求同时到达，都发现缓存是空的，于是 10 个一起回源。',
      '  缓存要等第一个回来才建立起来，而那时 10 个请求已经全发出去了。',
      '- 只有单飞：并发的那一批确实只回源一次，但下一批到来时又是一次。',
      '',
      '两者叠起来才是完整的：缓存挡住时间轴上后来的，单飞挡住同一时刻并排的。',
      '',
      '## LRU 的两个实现细节',
      '',
      '**用 `Map` 的插入顺序做 LRU。** `get` 命中时把条目**删掉再塞回去**，',
      '它就跑到了迭代顺序的末尾；淘汰时取 `keys().next().value`，就是最久未使用的那个。',
      '不重新插入的话，你实现的是 FIFO 而不是 LRU —— 热点数据会被自己的年龄淘汰掉。',
      '',
      '**单飞的清理要放在 `finally`。** 只在成功时清，一次失败就会把这个 key',
      '的失败 Promise 永久留在表里，之后所有请求都直接拿到那个失败结果 ——',
      '一次瞬时故障变成了永久故障。',
    ].join('\n'),
    [
      'Duplicate urls show up constantly, and worse, several requests for the same url hit the upstream **at',
      'the same time**. These look like one problem and need two mechanisms.',
      '',
      '## What to build',
      '',
      'Two things in `src/cache.ts`:',
      '',
      '| Component | Responsibility |',
      '| --- | --- |',
      '| `createCache({ ttlMs, maxSize })` | An LRU cache with TTL, exposing `get` / `set` / `size` |',
      '| `createSingleFlight()` | Concurrent calls for one key run the loader once and share a promise |',
      '',
      'Then make `fetchPage` go **cache → single-flight → network** when `options.ttlMs` is set.',
      '',
      '## What counts as passing',
      '',
      '- A hot url reaches the origin once (`requests.total ≤ 1`);',
      '- Total latency after deduplication stays within 100ms (`virtualElapsedMs ≤ 100`);',
      '- Expired entries are unreadable and removed;',
      '- Beyond `maxSize`, the **least recently used** entry is evicted, not the oldest written;',
      '- Only successful results are cached.',
      '',
      '## A cache handles "again"; single-flight handles "at the same time"',
      '',
      'Miss either and hot keys stampede the upstream:',
      '',
      '- Cache only: ten concurrent requests arrive, all find the cache empty, and all ten go to the origin.',
      '  The cache is only populated when the first returns, by which time all ten are already out.',
      '- Single-flight only: that concurrent burst does reach the origin once, and so does the next burst.',
      '',
      'Together they are complete: the cache stops what comes later in time, single-flight stops what sits',
      'alongside in the same instant.',
      '',
      '## Two LRU implementation details',
      '',
      '**Use `Map` insertion order as the LRU order.** On a `get` hit, **delete and re-insert** the entry so',
      'it moves to the end of the iteration order; evict with `keys().next().value`, which is then the least',
      'recently used. Without the re-insert you have built a FIFO, not an LRU — and hot data gets evicted by',
      'its own age.',
      '',
      '**Clean up single-flight in a `finally`.** Clean up only on success and one failure leaves that key\'s',
      'rejected promise in the table forever, so every later request receives that same failure — a transient',
      'fault turned permanent.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**fetchPage 的三级链** —— 缓存在前，单飞在中，网络在后',
      '',
      '```mermaid',
      'flowchart TD',
      '  FP["fetchPage(url, options)"] --> TTL{"options.ttlMs 存在吗？"}',
      '  TTL -- 不存在 --> DIRECT["直接 loadPage，不走缓存这条链"]',
      '  TTL -- 存在 --> C1["cache.get(url)"]',
      '  C1 --> HIT{"命中且未过期？"}',
      '  HIT -- 命中 --> RETC["直接返回缓存结果<br/>挡住的是「时间轴上后来的」"]',
      '  HIT -- 未命中 --> SF["singleFlight(url, loader)<br/>挡住的是「同一时刻并排的」"]',
      '  SF --> LOAD["loadPage：重试 + 网络请求<br/>成功才 cache.set(url, result)"]',
      '```',
      '',
      '两道防线的位置不同：`cache.get` 在**发起之前**查，单飞在**发起之时**查。',
      '把单飞去掉，10 个并发请求会同时走到 `LOAD`；',
      '把缓存去掉，每一批新到的请求都要重新回源一次。',
      '',
      '**createSingleFlight** —— 一张在飞登记表',
      '',
      '```mermaid',
      'flowchart TD',
      '  S1{"inFlight 里已经有这个 key 吗？"}',
      '  S1 -- 有 --> S2["返回同一个 Promise，不发第二次请求"]',
      '  S1 -- 没有 --> S3["执行 loader()<br/>把 Promise 存进 inFlight"]',
      '  S3 --> S4["finally 里删除这个 key"]',
      '```',
      '',
      '`S4` 用 `finally` 而不是成功分支，是这段代码里最容易埋雷的一行：',
      '放错了，一次瞬时失败会被所有后续请求共享，直到进程重启。',
      '',
      '**createCache** —— LRU + TTL，都靠 `Map` 的插入顺序',
      '',
      '```mermaid',
      'flowchart TD',
      '  G["get(key)"] --> EXP{"过期了？"}',
      '  EXP -- 是 --> DEL["删掉，返回 undefined"]',
      '  EXP -- 否 --> TOUCH["删掉再塞回去<br/>Map 的插入顺序 = 最近使用顺序"]',
      '  ST["set(key, value)"] --> OVER{"超过 maxSize？"}',
      '  OVER -- 是 --> EVICT["删 keys().next().value<br/>也就是最久未使用的那个"]',
      '  OVER -- 否 --> KEEP["留着"]',
      '```',
      '',
      '不重新插入的话，你实现的是 FIFO 而不是 LRU —— 热点数据会被自己的年龄淘汰掉。',
    ].join('\n'),
    [
      '**fetchPage\'s three-tier chain** — cache first, single-flight next, network last',
      '',
      '```mermaid',
      'flowchart TD',
      '  FP["fetchPage(url, options)"] --> TTL{"is options.ttlMs set?"}',
      '  TTL -- no --> DIRECT["loadPage directly, skipping this chain"]',
      '  TTL -- yes --> C1["cache.get(url)"]',
      '  C1 --> HIT{"present and unexpired?"}',
      '  HIT -- hit --> RETC["return the cached result<br/>this stops what comes later in time"]',
      '  HIT -- miss --> SF["singleFlight(url, loader)<br/>this stops what sits alongside in the same instant"]',
      '  SF --> LOAD["loadPage: retries + the network call<br/>cache.set(url, result) only on success"]',
      '```',
      '',
      'The two defences sit at different moments: `cache.get` checks **before** issuing, single-flight checks',
      '**as** it issues. Remove single-flight and ten concurrent requests all reach `LOAD`; remove the cache',
      'and every fresh burst returns to the origin.',
      '',
      '**createSingleFlight** — one in-flight registry',
      '',
      '```mermaid',
      'flowchart TD',
      '  S1{"is this key already in inFlight?"}',
      '  S1 -- yes --> S2["return the same promise, no second request"]',
      '  S1 -- no --> S3["run loader()<br/>store the promise in inFlight"]',
      '  S3 --> S4["delete the key in a finally"]',
      '```',
      '',
      '`S4` being a `finally` rather than a success branch is the easiest line here to get wrong: misplaced,',
      'one transient failure is shared by every later request until the process restarts.',
      '',
      '**createCache** — LRU and TTL, both riding on `Map` insertion order',
      '',
      '```mermaid',
      'flowchart TD',
      '  G["get(key)"] --> EXP{"expired?"}',
      '  EXP -- yes --> DEL["delete it, return undefined"]',
      '  EXP -- no --> TOUCH["delete and re-insert<br/>Map insertion order = recency order"]',
      '  ST["set(key, value)"] --> OVER{"beyond maxSize?"}',
      '  OVER -- yes --> EVICT["delete keys().next().value<br/>the least recently used entry"]',
      '  OVER -- no --> KEEP["keep everything"]',
      '```',
      '',
      'Without the re-insert you have built a FIFO, not an LRU — and hot data gets evicted by its own age.',
    ].join('\n')
  ),
  checklist: [
    t('LRU 按最近使用淘汰，get 也会刷新热度', 'LRU evicts by recency, and get refreshes it'),
    t('过期条目不再命中', 'Expired entries stop hitting'),
    t('5 个并发的相同请求只打 1 次下游', '5 concurrent identical requests hit upstream once'),
    t('单飞完成后要清理登记表，避免内存泄漏', 'Single-flight cleans up its registry afterwards'),
  ],
  pitfalls: [
    t(
      '缓存失败结果：下游抖动一次，错误就被钉在缓存里，TTL 到期前所有人都拿到那个错误。要么不缓存失败，要么给它一个短得多的 TTL（negative caching）。',
      'Caching failures: one blip pins an error in the cache and everyone gets it until the TTL expires. Either do not cache failures, or give them a much shorter TTL (negative caching).'
    ),
    t(
      '单飞的登记表不清理：`inFlight.set(key, promise)` 之后忘了在 finally 里 delete。第二次请求会拿到一个早就完成的旧 promise，缓存永远不更新，Map 还会无限增长。',
      'Not cleaning the single-flight registry: forgetting the `finally` delete means the next call reuses a long-settled promise, the value never refreshes, and the Map grows without bound.'
    ),
    t(
      '只在 set 时更新热度、get 不更新，LRU 就退化成了 FIFO。一个被反复读取的热点 key 会因为写入得早而被淘汰。',
      'Update recency only on set and the LRU is really a FIFO. A key that gets read constantly is evicted for having been written early.'
    ),
    t(
      '用真实的 `Date.now()` 判断过期：本关的用例跑在虚拟时钟上会直接失败；在真实工程里，这也让缓存的过期行为无法被测试。',
      'Using the real `Date.now()` for expiry: the specs run on a virtual clock and will fail, and in real code it makes expiry untestable.'
    ),
  ],
  hints: [
    t(
      'JS 的 Map 保持插入顺序：删除后重新 set 就等价于「移到队尾」，LRU 用它实现最省事。',
      'JS Map preserves insertion order: delete + set moves a key to the tail, which is all an LRU needs.'
    ),
    t(
      '单飞的核心是一张 Map<key, Promise>：命中就复用，finally 里删除。',
      'Single-flight is a Map<key, Promise>: reuse on hit, delete in finally.'
    ),
    t(
      '过期判断用 @lab/env 的 now()，不要用真实的 Date.now()。',
      'Use now() from @lab/env for expiry, not the real Date.now().'
    ),
  ],
  extension: t(
    [
      '缓存和单飞解决的是两个不同的问题，工程上有专门的名字：',
      '',
      '| 现象 | 说明 | 对策 |',
      '| --- | --- | --- |',
      '| 缓存穿透 | 查一个**根本不存在**的 key，每次都回源 | 缓存空值（短 TTL）、布隆过滤器 |',
      '| 缓存击穿 | 一个**热点** key 刚好过期，大量并发同时回源 | 单飞、逻辑过期 |',
      '| 缓存雪崩 | 大量 key 同时过期，回源流量尖峰 | TTL 加随机抖动 |',
      '',
      '「单飞」这个名字来自 Go 的 `golang.org/x/sync/singleflight`，',
      'groupcache 用它来避免热点 key 击穿。Java 生态里 Caffeine 的 `LoadingCache.get(key, loader)` ',
      '内置了同样的语义，同一个 key 的并发加载只会执行一次。',
      '',
      '再进一步：stale-while-revalidate。过期后先返回旧值，同时在后台异步刷新，',
      '这样即使回源很慢，用户也不会看到延迟毛刺。HTTP 的 `Cache-Control: stale-while-revalidate` ',
      '就是这个语义。',
    ].join('\n'),
    [
      'Caching and single-flight solve two different problems, and both have names:',
      '',
      '| Symptom | What happens | Mitigation |',
      '| --- | --- | --- |',
      '| Penetration | Looking up a key that does not exist, every time | Cache negatives (short TTL), bloom filter |',
      '| Stampede | A hot key expires and many requests reload it at once | Single-flight, logical expiry |',
      '| Avalanche | Many keys expire simultaneously, load spikes | Jitter the TTLs |',
      '',
      'The name "single flight" comes from Go\'s `golang.org/x/sync/singleflight`, which groupcache',
      "uses to avoid hot-key stampedes. In Java, Caffeine's `LoadingCache.get(key, loader)` has the",
      'same semantics: concurrent loads of one key run once.',
      '',
      'One step further: stale-while-revalidate, serve the expired value immediately and refresh',
      'in the background, so a slow origin never becomes a latency spike. HTTP has this as',
      '`Cache-Control: stale-while-revalidate`.',
    ].join('\n')
  ),
  focus: ['resilience', 'latency', 'encapsulation'],
  lab: {
    defaultLatencyMs: 100,
    endpoints: {
      '/api/flaky-cache': { failFirstN: 1, status: 503 },
    },
  },
  starterFiles: [
    file(
      'src/cache.ts',
      code`
        export interface CacheOptions {
          /** Entry lifetime; never expires when omitted */
          ttlMs?: number;
          /** Maximum entries; evicted by LRU beyond that */
          maxSize?: number;
        }

        export interface Cache<T> {
          get(key: string): T | undefined;
          set(key: string, value: T): void;
          readonly size: number;
        }

        /** An LRU cache with TTL */
        export function createCache<T>(options: CacheOptions = {}): Cache<T> {
          // TODO: implement this
          throw new Error('not implemented');
        }

        /** Single-flight: concurrent calls for one key share a single execution */
        export function createSingleFlight() {
          // TODO: implement this
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
        import { createCache, createSingleFlight } from '../src/cache';
        import { fetchPage, fetchAll } from '../src/fetcher';
        import { getMetrics } from '@lab/net';
        import { sleep } from '@lab/env';

        describe('Stage 7 · Caching and single-flight', () => {
          it('the LRU evicts by least recent use', () => {
            const cache = createCache<number>({ maxSize: 2 });
            cache.set('a', 1);
            cache.set('b', 2);
            expect(cache.get('a')).toBe(1); // a becomes the most recently used
            cache.set('c', 3);              // evicts b
            expect(cache.get('b')).toBeUndefined();
            expect(cache.get('a')).toBe(1);
            expect(cache.get('c')).toBe(3);
            expect(cache.size).toBe(2);
          });

          it('an expired TTL no longer hits', async () => {
            const cache = createCache<string>({ ttlMs: 100 });
            cache.set('k', 'v');
            expect(cache.get('k')).toBe('v');
            await sleep(150);
            expect(cache.get('k')).toBeUndefined();
          });

          it('single-flight runs the loader once for concurrent calls', async () => {
            const singleFlight = createSingleFlight();
            let calls = 0;
            const loader = async () => {
              calls += 1;
              await sleep(50);
              return 'value';
            };
            const results = await Promise.all([
              singleFlight('k', loader),
              singleFlight('k', loader),
              singleFlight('k', loader),
            ]);
            expect(results).toEqual(['value', 'value', 'value']);
            expect(calls).toBe(1);
          });

          it('single-flight does not hold onto the key after it finishes', async () => {
            const singleFlight = createSingleFlight();
            let calls = 0;
            const loader = async () => {
              calls += 1;
              return calls;
            };
            await singleFlight('k', loader);
            await singleFlight('k', loader);
            expect(calls).toBe(2);
          });

          it('fetching one URL concurrently hits downstream once [gate:dedup]', async () => {
            const urls = ['/api/hot', '/api/hot', '/api/hot', '/api/hot', '/api/hot'];
            const results = await fetchAll(urls, { concurrency: 5, ttlMs: 1000 });
            expect(results.every((item) => item.ok)).toBe(true);
            const metrics = getMetrics();
            expect(metrics.requests.total).toBe(1);
            expect(metrics.virtualElapsedMs).toBe(100);
          });

          it('a cache hit produces no request', async () => {
            await fetchPage('/api/warm', { ttlMs: 1000 });
            await fetchPage('/api/warm', { ttlMs: 1000 });
            expect(getMetrics().requests.total).toBe(1);
          });

          it('an LRU of capacity 1 keeps only the newest entry', () => {
            const cache = createCache<number>({ maxSize: 1 });
            cache.set('a', 1);
            cache.set('b', 2);
            expect(cache.get('a')).toBeUndefined();
            expect(cache.get('b')).toBe(2);
            expect(cache.size).toBe(1);
          });

          it('setting the same key repeatedly does not inflate the size', () => {
            const cache = createCache<number>({ maxSize: 2 });
            cache.set('a', 1);
            cache.set('a', 2);
            cache.set('a', 3);
            expect(cache.size).toBe(1);
            expect(cache.get('a')).toBe(3);
          });

          it('failures are not cached and the next call still goes to the origin', async () => {
            const first = await fetchPage('/api/flaky-cache', { ttlMs: 1000 });
            expect(first.ok).toBe(false);

            const second = await fetchPage('/api/flaky-cache', { ttlMs: 1000 });
            expect(second.ok).toBe(true);
            expect(getMetrics().requests.total).toBe(2);
          });

          it('single-flight clears its registry when the loader throws', async () => {
            const singleFlight = createSingleFlight();
            let calls = 0;
            const failing = async () => {
              calls += 1;
              throw new Error('loader failed');
            };

            await expect(async () => singleFlight('k', failing)).rejects.toThrow('loader failed');
            await expect(async () => singleFlight('k', failing)).rejects.toThrow('loader failed');
            // Without cleanup the second call reuses the already-rejected promise and calls stays at 1
            expect(calls).toBe(2);
          });

          it('separate keys do not interfere', async () => {
            const singleFlight = createSingleFlight();
            let calls = 0;
            const loader = async () => {
              calls += 1;
              await sleep(20);
              return calls;
            };

            await Promise.all([singleFlight('a', loader), singleFlight('b', loader)]);
            expect(calls).toBe(2);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'requests.total',
      op: 'lte',
      value: 1,
      zh: '热点地址只回源一次',
      en: 'Hot key hits upstream once',
      dimension: 'resilience',
      scope: 'gate:dedup',
    }),
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 100,
      unit: 'ms',
      zh: '去重后延迟 ≤ 100ms',
      en: 'Deduped latency ≤ 100ms',
      dimension: 'latency',
      scope: 'gate:dedup',
    }),
  ],
  referenceFiles: [
    file(
      'src/cache.ts',
      code`
        import { now } from '@lab/env';

        export interface CacheOptions {
          ttlMs?: number;
          maxSize?: number;
        }

        export interface Cache<T> {
          get(key: string): T | undefined;
          set(key: string, value: T): void;
          readonly size: number;
        }

        interface Entry<T> {
          value: T;
          expiresAt: number;
        }

        export function createCache<T>(options: CacheOptions = {}): Cache<T> {
          const entries = new Map<string, Entry<T>>();
          const ttl = options.ttlMs ?? Number.POSITIVE_INFINITY;
          const maxSize = options.maxSize ?? Number.POSITIVE_INFINITY;

          return {
            get(key) {
              const entry = entries.get(key);
              if (!entry) return undefined;
              if (entry.expiresAt <= now()) {
                entries.delete(key);
                return undefined;
              }
              // A Map preserves insertion order, so delete-then-reinsert is exactly \u2018move to most recently used\u2019
              entries.delete(key);
              entries.set(key, entry);
              return entry.value;
            },
            set(key, value) {
              if (entries.has(key)) entries.delete(key);
              entries.set(key, { value, expiresAt: now() + ttl });
              while (entries.size > maxSize) {
                const oldest = entries.keys().next().value;
                if (oldest === undefined) break;
                entries.delete(oldest);
              }
            },
            get size() {
              return entries.size;
            },
          };
        }

        export function createSingleFlight() {
          const inFlight = new Map<string, Promise<any>>();

          return function run<T>(key: string, loader: () => Promise<T>): Promise<T> {
            const existing = inFlight.get(key);
            if (existing) return existing as Promise<T>;

            const promise = loader().finally(() => {
              inFlight.delete(key);
            });
            inFlight.set(key, promise);
            return promise;
          };
        }
      `
    ),
    file(
      'src/fetcher.ts',
      code`
        import { request } from '@lab/net';
        import { mapWithConcurrency } from './pool';
        import { withRetry } from './retry';
        import { createCache, createSingleFlight } from './cache';
        import type { FetchOptions, PageResult } from './contract';

        const RETRYABLE_STATUS = [408, 429, 500, 502, 503, 504];

        const cache = createCache<PageResult>({ ttlMs: 1000, maxSize: 200 });
        const singleFlight = createSingleFlight();

        function isRetryable(error: unknown): boolean {
          const status = (error as { status?: number }).status;
          return status === undefined || RETRYABLE_STATUS.indexOf(status) !== -1;
        }

        async function loadPage(url: string, options: FetchOptions): Promise<PageResult> {
          const run = () => request(url);
          try {
            const response = options.retries
              ? await withRetry(run, {
                  retries: options.retries,
                  baseDelayMs: options.baseDelayMs ?? 50,
                  isRetryable,
                })
              : await run();
            return { url, ok: true, data: response.data };
          } catch (error) {
            return { url, ok: false, data: null, error: (error as Error).message };
          }
        }

        export async function fetchPage(url: string, options: FetchOptions = {}): Promise<PageResult> {
          if (!options.ttlMs) return loadPage(url, options);

          const cached = cache.get(url);
          if (cached) return cached;

          return singleFlight(url, async () => {
            const result = await loadPage(url, options);
            if (result.ok) cache.set(url, result);
            return result;
          });
        }

        export async function fetchAll(urls: string[], options: FetchOptions = {}): Promise<PageResult[]> {
          const concurrency = options.concurrency && options.concurrency > 0 ? options.concurrency : 1;
          return mapWithConcurrency(urls, concurrency, (url) => fetchPage(url, options));
        }
      `
    ),
  ],
  referenceNotes: t(
    '注意参考实现里的缓存是模块级单例，它能过关，但也意味着测试之间会互相污染。第 5 关会把它收进 pipeline 实例里，这才是可测试的写法。',
    'The reference cache here is a module-level singleton: it passes, but it leaks state across tests. Stage 5 moves it into a pipeline instance, which is the testable shape.'
  ),
};

/* ------------------------------------------------------------------ */
/* 阶段 5：收敛成可运维的组件                                           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

const stage8 = {
  id: 'priority-scheduling',
  title: t('第 8 关 · 优先级调度与饥饿', 'Stage 8 · Priority scheduling and starvation'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '到这里，池子里所有请求一律平等。真实系统里不是：',
      '用户正在等的那个搜索请求，和后台的缓存预热任务，不该排同一个队。',
      '',
      '## 要实现什么',
      '',
      '在 `src/scheduler.ts` 实现 `createScheduler(options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `submit({ url, priority })` | priority 越大越优先，返回该请求的结果 |',
      '| `pending()` | 还在排队的数量 |',
      '',
      '同优先级按提交顺序（FIFO）。并发上限由 `options.concurrency` 控制。',
      '',
      '## 怎么算过',
      '',
      '- 高优先级先跑，同优先级按提交顺序；',
      '- 并发 1、每个请求 100ms，先提交一个低优先级、再提交十个高优先级时，',
      '  那个低优先级任务在 600ms 内完成（门槛 `counters.lowPriorityWaitMs ≤ 600`）；',
      '- 请求失败也要归还并发槽；',
      '- `pending()` 如实反映排队长度。',
      '',
      '## 光有优先级不够，还要老化',
      '',
      '高优先级请求源源不断的时候，低优先级的那个会**永远排在队尾** —— 这就是饥饿。',
      '',
      '一个只按优先级排序的调度器，在压力下等于把低优先级任务丢掉了，',
      '而且丢得悄无声息：它们既没失败也没超时，只是**永远不开始**。',
      '监控上看不到任何异常，因为没有任何指标记录「一个还没开始的任务」。',
      '',
      '解法是**老化**（aging）：等待越久，有效优先级越高。',
      '',
      '```',
      '有效优先级 = priority + floor(已等待时长 / agingMs) × agingBoost',
      '```',
      '',
      '不做老化的实现在门槛场景里要 1100ms —— 它排在所有高优先级后面。',
      '做了老化是 600ms 以内。',
      '',
      '## 三个实现细节',
      '',
      '**有效优先级必须在每次挑选时重算。** 入队时算一次然后固定下来，等于没有老化 ——',
      '那只是给了它一个稍高的初始分。',
      '',
      '**别赌 `Array.sort` 的稳定性来实现 FIFO。** 显式记一个入队序号 `seq`，',
      '同分时比 `seq`。这样「同优先级按提交顺序」是你实现的，不是运行时碰巧给的。',
      '',
      '**失败也要归还槽位。** 只在成功分支 `running -= 1`，',
      '一次错误就会永久缩小并发度，错够 `concurrency` 次调度器就彻底停摆了。',
    ].join('\n'),
    [
      'So far every request in the pool is equal. In a real system they are not: the search a user is',
      'waiting on and a background cache-warming job do not belong in the same queue.',
      '',
      '## What to build',
      '',
      '`createScheduler(options)` in `src/scheduler.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `submit({ url, priority })` | Higher priority goes first, resolving to that request\'s result |',
      '| `pending()` | How many are still queued |',
      '',
      'Equal priorities run in submission order (FIFO). The ceiling comes from `options.concurrency`.',
      '',
      '## What counts as passing',
      '',
      '- Higher priority runs first, equal priority runs in submission order;',
      '- At concurrency 1 and 100ms per request, submitting one low-priority task followed by ten',
      '  high-priority ones finishes the low-priority one within 600ms',
      '  (`counters.lowPriorityWaitMs ≤ 600`);',
      '- A failed request still returns its slot;',
      '- `pending()` reports the queue length honestly.',
      '',
      '## Priority alone is not enough — you need aging',
      '',
      'With high-priority work arriving continuously, the low-priority task sits at the back of the queue',
      'forever. That is **starvation**.',
      '',
      'A scheduler that only sorts by priority effectively discards low-priority work under load, and does so',
      'silently: those tasks neither fail nor time out, they simply **never begin**. Monitoring shows nothing,',
      'because no metric records a task that has not started.',
      '',
      'The fix is **aging**: the longer something waits, the higher its effective priority.',
      '',
      '```',
      'effective = priority + floor(waited / agingMs) × agingBoost',
      '```',
      '',
      'Without aging, the gate scenario takes 1100ms — behind every high-priority task. With aging it lands',
      'under 600ms.',
      '',
      '## Three implementation details',
      '',
      '**Effective priority must be recomputed on every selection.** Computing it once at enqueue time and',
      'freezing it is not aging — it is merely a slightly higher starting score.',
      '',
      '**Do not bet on `Array.sort` stability for FIFO.** Record an explicit `seq` at enqueue and compare it',
      'on ties. Then "equal priority runs in submission order" is something you implemented, not something',
      'the runtime happened to provide.',
      '',
      '**Return the slot on failure too.** With `running -= 1` only on the success branch, each error',
      'permanently shrinks the concurrency, and after `concurrency` errors the scheduler stops entirely.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**入队与调度循环**',
      '',
      '```mermaid',
      'flowchart TD',
      '  SUB["submit({ url, priority })"] --> Q["queue.push({ ...task, enqueuedAt: now(),<br/>seq: nextSeq++, settle })<br/>seq 是显式的入队序号，不赌 sort 的稳定性"]',
      '  Q --> P1{"pump()：running < limit？"}',
      '  P1 -- 否 --> PSTOP["等有人结束再说"]',
      '  P1 -- 是 --> TN["takeNext()"]',
      '  TN --> EMPTY{"队列空了？"}',
      '  EMPTY -- 是 --> PSTOP',
      '  EMPTY -- 否 --> RUN["running += 1<br/>request(task.url)"]',
      '  RUN --> DONE{"请求结束"}',
      '  DONE -- 成功 --> R1["running -= 1，settle(成功)"]',
      '  DONE -- 失败 --> R2["running -= 1，settle(失败)<br/>失败也要还槽位"]',
      '  R1 --> P1',
      '  R2 --> P1',
      '```',
      '',
      '`R2` 是「不写就慢慢死」的那处细节：失败不还槽位，`P1` 的条件会越来越难满足，',
      '并发度一点点缩到 0。',
      '',
      '**挑选规则** —— 老化就藏在这里',
      '',
      '```mermaid',
      'flowchart TD',
      '  T1["遍历整个队列"] --> T2["有效优先级 = priority<br/>+ floor((now - enqueuedAt) / agingMs) × agingBoost"]',
      '  T2 --> T3{"比当前最优高？"}',
      '  T3 -- 高 --> T4["记为新的最优"]',
      '  T3 -- 同分 --> T5["比 seq，小的赢<br/>同优先级 FIFO"]',
      '  T4 --> T6["splice 出来返回"]',
      '  T5 --> T6',
      '```',
      '',
      '`T2` 之所以有效，是因为 `takeNext` 在**每次挑选时**都重新算一遍。',
      '把有效优先级挪到入队那一步算好存进队列，代码只动一行，饥饿立刻回来 ——',
      '因为等待时长从此不再影响排序。',
    ].join('\n'),
    [
      '**Intake and the scheduling loop**',
      '',
      '```mermaid',
      'flowchart TD',
      '  SUB["submit({ url, priority })"] --> Q["queue.push({ ...task, enqueuedAt: now(),<br/>seq: nextSeq++, settle })<br/>seq is explicit; never bet on sort stability"]',
      '  Q --> P1{"pump(): running < limit?"}',
      '  P1 -- no --> PSTOP["wait for someone to finish"]',
      '  P1 -- yes --> TN["takeNext()"]',
      '  TN --> EMPTY{"queue empty?"}',
      '  EMPTY -- yes --> PSTOP',
      '  EMPTY -- no --> RUN["running += 1<br/>request(task.url)"]',
      '  RUN --> DONE{"the request settles"}',
      '  DONE -- succeeded --> R1["running -= 1, settle(success)"]',
      '  DONE -- failed --> R2["running -= 1, settle(failure)<br/>the slot returns on failure too"]',
      '  R1 --> P1',
      '  R2 --> P1',
      '```',
      '',
      '`R2` is the detail that quietly kills you: without returning the slot on failure, the `P1` condition',
      'gets harder to satisfy until the concurrency reaches zero.',
      '',
      '**The selection rule** — aging lives here',
      '',
      '```mermaid',
      'flowchart TD',
      '  T1["scan the whole queue"] --> T2["effective = priority<br/>+ floor((now - enqueuedAt) / agingMs) × agingBoost"]',
      '  T2 --> T3{"higher than the current best?"}',
      '  T3 -- higher --> T4["becomes the new best"]',
      '  T3 -- tied --> T5["compare seq, lower wins<br/>FIFO within a priority"]',
      '  T4 --> T6["splice it out and return it"]',
      '  T5 --> T6',
      '```',
      '',
      '`T2` works only because `takeNext` recomputes it **at every selection**. Move the effective priority',
      'into the enqueue step and store it on the task — a one-line change — and starvation is immediately',
      'back, because waiting time no longer affects the ordering.',
    ].join('\n')
  ),
  checklist: [
    t('高优先级插到队列前面', 'Higher priority moves to the front of the queue'),
    t('同优先级保持提交顺序', 'Equal priorities keep submission order'),
    t('等待足够久的低优先级会被提上来', 'A long-waiting low-priority task gets promoted'),
    t('正在执行的请求不会被抢占', 'A running request is never preempted'),
    t('pending() 反映真实排队数', 'pending() reflects the real queue depth'),
  ],
  pitfalls: [
    t(
      '只按 priority 排序，不做老化。压测时看不出问题——高优先级任务总能及时完成，指标很漂亮。但低优先级任务的完成时间会随高优先级的到达速率无限增长，最后表现为「后台任务好像从来没跑过」，而监控上任何一条曲线都是正常的。',
      'Sorting by priority alone with no aging. Load tests look fine, since high-priority work always completes promptly and the dashboards are green. Meanwhile low-priority completion time grows without bound as high-priority arrival rate rises, presenting as "the background jobs never seem to run" while every metric looks normal.'
    ),
    t(
      '在每次入队时计算一次有效优先级，然后就固定下来。老化的意义是「随时间变化」，算一次等于没算——任务入队那一刻等待时长是 0，有效优先级永远等于原始优先级。有效优先级必须在**每次挑选**时重新计算。',
      'Computing the effective priority once at enqueue time and freezing it. Aging means changing over time, so computing it once achieves nothing: at enqueue the wait is zero and the effective priority equals the original forever. It must be recomputed at every selection.'
    ),
    t(
      '为了实现优先级去抢占正在执行的请求。请求已经发出去了，中止它并不会让服务端少做功，只会让这次工作白费，而且高优先级任务还得从头开始等一次网络往返。调度只发生在「挑下一个」的时刻，已经在飞的不动。',
      'Preempting a running request to honour priority. The request is already out; aborting it does not save the server any work, wastes what was done, and the high-priority task still has to wait a full round trip from scratch. Scheduling happens when picking the next task, never to something already in flight.'
    ),
    t(
      '用 `array.sort()` 维护队列，并且假设它是稳定的。V8 的 sort 现在确实稳定，但依赖这一点会让「同优先级 FIFO」这条语义变成对运行时实现的赌注。想要 FIFO 就显式记一个递增的入队序号，把它作为第二排序键。',
      'Maintaining the queue with `array.sort()` and assuming stability. V8\'s sort is stable today, but relying on that turns "FIFO within a priority" into a bet on a runtime detail. Record a monotonically increasing sequence number at enqueue and use it as the tiebreaker.'
    ),
  ],
  hints: [
    t(
      '挑下一个任务时遍历整个队列算一遍有效优先级，取最大的。队列不长的时候这比维护一个堆简单得多，而且老化本来就要求每次重算。',
      'Pick the next task by walking the queue, computing effective priority for each and taking the maximum. At these queue lengths that beats maintaining a heap, and aging requires recomputation anyway.'
    ),
    t(
      '每个入队任务记下 `enqueuedAt` 和一个递增的 `seq`。有效优先级用 `enqueuedAt` 算，同分时比 `seq`。',
      'Store `enqueuedAt` and an incrementing `seq` on each queued task. Effective priority comes from `enqueuedAt`, ties break on `seq`.'
    ),
  ],
  extension: t(
    [
      '老化是操作系统调度器的老办法了。Linux 的 CFS 用的是另一套思路——',
      '不排优先级，而是记录每个任务「已经用掉多少 CPU 时间」（vruntime），',
      '总是挑用得最少的那个。优先级（nice 值）只影响 vruntime 增长的**速率**，',
      '于是低优先级任务跑得慢，但永远不会完全跑不到。',
      '这比显式老化更优雅：饥饿在模型层面就不可能发生，不需要额外的补丁。',
      '',
      '真实的请求调度还要考虑**公平性的维度**。按优先级是一维的，',
      '而线上更常见的需求是「每个租户都要拿到一份」——一个租户提交一万个请求，',
      '不该把其他租户挤没。这类需求用的是加权公平队列（WFQ）或者',
      'deficit round robin：每个租户一个子队列，轮流从各队列取，按权重分配配额。',
      '',
      '还有一个和这一关直接相关的坑：**优先级反转**。',
      '低优先级任务持有了高优先级任务需要的资源（一把锁、一个连接），',
      '于是高优先级被低优先级阻塞。1997 年火星探路者号的著名故障就是这个。',
      '解法是优先级继承：持有资源的任务临时继承等待者里最高的优先级。',
    ].join('\n'),
    [
      'Aging is an old operating-system technique. Linux CFS takes a different route: rather than ranking',
      'priorities it tracks how much CPU time each task has consumed (vruntime) and always picks the one',
      'that has used least. Priority — the nice value — only changes the rate at which vruntime grows, so',
      'low-priority tasks run slowly but never stop running entirely. That is more elegant than explicit',
      'aging: starvation becomes impossible in the model rather than patched afterwards.',
      '',
      'Real request scheduling also has a fairness dimension. Priority is one-dimensional, while the common',
      'production requirement is that every tenant gets a share — one tenant submitting ten thousand',
      'requests must not squeeze the others out. That calls for weighted fair queueing or deficit round',
      'robin: a sub-queue per tenant, served in turn with quotas by weight.',
      '',
      'One more trap connects directly to this stage: priority inversion. A low-priority task holds a',
      'resource — a lock, a connection — that a high-priority task needs, so the high-priority task is',
      "blocked by the low-priority one. The Mars Pathfinder failure of 1997 was exactly this. The fix is",
      'priority inheritance: the holder temporarily inherits the highest priority among its waiters.',
    ].join('\n')
  ),
  focus: ['concurrency', 'correctness', 'resilience'],
  lab: { defaultLatencyMs: 100 },
  starterFiles: [
    file(
      'src/scheduler.ts',
      code`
        import type { PageResult } from './contract';

        export interface ScheduledTask {
          url: string;
          /** Higher means higher priority */
          priority: number;
        }

        export interface SchedulerOptions {
          concurrency: number;
          /** Effective priority rises one step per this much waiting; omit to disable ageing */
          agingMs?: number;
          /** How much each step raises it; defaults to 10 */
          agingBoost?: number;
        }

        export interface Scheduler {
          submit(task: ScheduledTask): Promise<PageResult>;
          /** How many are still queued (not yet started) */
          pending(): number;
        }

        export function createScheduler(options: SchedulerOptions): Scheduler {
          // TODO: implement this
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
        import { createScheduler } from '../src/scheduler';
        import { now, sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        describe('Stage 8 · Priority scheduling', () => {
          it('a single task runs straight away', async () => {
            const scheduler = createScheduler({ concurrency: 1 });
            const result = await scheduler.submit({ url: '/api/a', priority: 0 });
            expect(result.ok).toBe(true);
            expect(result.url).toBe('/api/a');
          });

          it('higher priority runs first', async () => {
            const scheduler = createScheduler({ concurrency: 1 });
            const order: string[] = [];

            const blocker = scheduler.submit({ url: '/api/blocker', priority: 0 });
            await sleep(1);
            const low = scheduler.submit({ url: '/api/low', priority: 1 }).then(() => order.push('low'));
            const high = scheduler.submit({ url: '/api/high', priority: 9 }).then(() => order.push('high'));

            await Promise.all([blocker, low, high]);
            expect(order).toEqual(['high', 'low']);
          });

          it('equal priorities run in submission order', async () => {
            const scheduler = createScheduler({ concurrency: 1 });
            const order: string[] = [];

            const blocker = scheduler.submit({ url: '/api/blocker', priority: 5 });
            await sleep(1);
            const first = scheduler.submit({ url: '/api/first', priority: 5 }).then(() => order.push('first'));
            const second = scheduler.submit({ url: '/api/second', priority: 5 }).then(() => order.push('second'));

            await Promise.all([blocker, first, second]);
            expect(order).toEqual(['first', 'second']);
          });

          it('pending reflects the queue length', async () => {
            const scheduler = createScheduler({ concurrency: 1 });
            const running = scheduler.submit({ url: '/api/a', priority: 0 });
            await sleep(1);
            const queued = [
              scheduler.submit({ url: '/api/b', priority: 0 }),
              scheduler.submit({ url: '/api/c', priority: 0 }),
            ];

            expect(scheduler.pending()).toBe(2);
            await Promise.all([running, ...queued]);
            expect(scheduler.pending()).toBe(0);
          });

          it('the concurrency ceiling is respected', async () => {
            const scheduler = createScheduler({ concurrency: 2 });
            const tasks: Array<Promise<unknown>> = [];
            for (let index = 0; index < 6; index += 1) {
              tasks.push(scheduler.submit({ url: '/api/page-' + index, priority: 0 }));
            }
            const startedAt = now();
            await Promise.all(tasks);
            // Six 100ms requests over two slots = 300ms
            expect(now() - startedAt).toBe(300);
          });

          it('a running request is not preempted by higher priority', async () => {
            const scheduler = createScheduler({ concurrency: 1 });
            const order: string[] = [];

            const running = scheduler
              .submit({ url: '/api/running', priority: 0 })
              .then(() => order.push('running'));
            await sleep(1);
            const urgent = scheduler
              .submit({ url: '/api/urgent', priority: 99 })
              .then(() => order.push('urgent'));

            await Promise.all([running, urgent]);
            // The one already in flight finishes first; higher priority only gets to be next in line
            expect(order).toEqual(['running', 'urgent']);
          });

          it('without agingMs it is purely by priority', async () => {
            const scheduler = createScheduler({ concurrency: 1 });
            const order: string[] = [];

            const blocker = scheduler.submit({ url: '/api/blocker', priority: 5 });
            await sleep(1);
            const low = scheduler.submit({ url: '/api/low', priority: 0 }).then(() => order.push('low'));
            const highs: Array<Promise<unknown>> = [];
            for (let index = 0; index < 3; index += 1) {
              highs.push(
                scheduler.submit({ url: '/api/high-' + index, priority: 5 }).then(() => order.push('high'))
              );
            }

            await Promise.all([blocker, low, ...highs]);
            expect(order[order.length - 1]).toBe('low');
          });

          it('ageing promotes a long-waiting low-priority task [gate:aging]', async () => {
            const scheduler = createScheduler({ concurrency: 1, agingMs: 300, agingBoost: 10 });
            let lowFinishedAt = -1;

            const startedAt = now();
            const low = scheduler.submit({ url: '/api/low', priority: 0 }).then(() => {
              lowFinishedAt = now() - startedAt;
            });

            const highs: Array<Promise<unknown>> = [];
            for (let index = 0; index < 10; index += 1) {
              highs.push(scheduler.submit({ url: '/api/high-' + index, priority: 10 }));
            }

            await Promise.all([low, ...highs]);
            count('lowPriorityWaitMs', lowFinishedAt);

            // An implementation without ageing queues it behind all ten high-priority tasks, at 1100ms
            expect(lowFinishedAt).toBeLessThanOrEqual(600);
          });

          it('ageing does not promote low priority ahead of a freshly arrived high-priority task', async () => {
            const scheduler = createScheduler({ concurrency: 1, agingMs: 10000, agingBoost: 10 });
            const order: string[] = [];

            const blocker = scheduler.submit({ url: '/api/blocker', priority: 0 });
            await sleep(1);
            const low = scheduler.submit({ url: '/api/low', priority: 0 }).then(() => order.push('low'));
            const high = scheduler.submit({ url: '/api/high', priority: 5 }).then(() => order.push('high'));

            await Promise.all([blocker, low, high]);
            // agingMs is large, so no promotion is due yet
            expect(order).toEqual(['high', 'low']);
          });

          it('a failed request returns its slot too', async () => {
            const scheduler = createScheduler({ concurrency: 1 });
            const results = await Promise.all([
              scheduler.submit({ url: '/api/a', priority: 0 }),
              scheduler.submit({ url: '/api/b', priority: 0 }),
            ]);
            expect(results).toHaveLength(2);
            expect(scheduler.pending()).toBe(0);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.lowPriorityWaitMs',
      op: 'lte',
      value: 600,
      unit: 'ms',
      zh: '低优先级任务不会被高优先级饿死',
      en: 'A low-priority task is not starved by high-priority traffic',
      dimension: 'concurrency',
      scope: 'gate:aging',
    }),
  ],
  referenceFiles: [
    file(
      'src/scheduler.ts',
      code`
        import type { PageResult } from './contract';
        import { now } from '@lab/env';
        import { request } from '@lab/net';

        export interface ScheduledTask {
          url: string;
          priority: number;
        }

        export interface SchedulerOptions {
          concurrency: number;
          agingMs?: number;
          agingBoost?: number;
        }

        export interface Scheduler {
          submit(task: ScheduledTask): Promise<PageResult>;
          pending(): number;
        }

        interface QueuedTask extends ScheduledTask {
          enqueuedAt: number;
          /** An explicit enqueue sequence number: do not bet on Array.sort being stable */
          seq: number;
          settle(result: PageResult): void;
        }

        export function createScheduler(options: SchedulerOptions): Scheduler {
          const limit = Math.max(1, options.concurrency);
          const agingBoost = options.agingBoost ?? 10;
          const queue: QueuedTask[] = [];
          let running = 0;
          let nextSeq = 0;

          /** Recomputed on every pick: computing it once and freezing it is the same as no ageing at all */
          function effectivePriority(task: QueuedTask): number {
            if (!options.agingMs) return task.priority;
            const waited = now() - task.enqueuedAt;
            return task.priority + Math.floor(waited / options.agingMs) * agingBoost;
          }

          function takeNext(): QueuedTask | null {
            if (queue.length === 0) return null;

            let bestIndex = 0;
            let bestPriority = effectivePriority(queue[0]);
            for (let index = 1; index < queue.length; index += 1) {
              const candidate = effectivePriority(queue[index]);
              // Compare seq on ties, which keeps equal priorities FIFO
              if (candidate > bestPriority || (candidate === bestPriority && queue[index].seq < queue[bestIndex].seq)) {
                bestIndex = index;
                bestPriority = candidate;
              }
            }
            return queue.splice(bestIndex, 1)[0];
          }

          function pump(): void {
            while (running < limit) {
              const task = takeNext();
              if (!task) return;

              running += 1;
              request(task.url).then(
                (response) => {
                  running -= 1;
                  task.settle({ url: task.url, ok: true, data: response.data });
                  pump();
                },
                (error) => {
                  // A failure has to return the slot too, or one error permanently shrinks the concurrency
                  running -= 1;
                  task.settle({
                    url: task.url,
                    ok: false,
                    data: null,
                    error: error instanceof Error ? error.message : String(error),
                  });
                  pump();
                }
              );
            }
          }

          return {
            submit(task: ScheduledTask): Promise<PageResult> {
              return new Promise<PageResult>((resolve) => {
                const seq = nextSeq;
                nextSeq += 1;
                queue.push({ ...task, enqueuedAt: now(), seq, settle: resolve });
                pump();
              });
            },

            pending(): number {
              return queue.length;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`effectivePriority` 在 `takeNext` 里调用，不在 `submit` 里。** 这是老化能不能生效的分水岭：',
      '入队那一刻等待时长必然是 0，算出来的有效优先级永远等于原始优先级。',
      '老化的语义是「随时间变化」，所以它必须是一个**每次挑选时求值**的函数，而不是一个存下来的字段。',
      '',
      '**`seq` 而不是依赖 sort 的稳定性。** 这里根本没有用 sort——一次线性扫描找最大值，',
      '同分时显式比较 `seq`。即使换成堆或者别的结构，「同优先级 FIFO」这条语义也不会随之改变。',
      '',
      '**失败分支里也有 `running -= 1` 和 `pump()`。** 少了这两行，一个失败的请求会永久占走一个槽位，',
      '连续几次失败之后并发度悄悄变成 0，整个调度器停住——而且不报任何错。',
      '这类「资源没还」的 bug 在成功路径的测试里永远看不出来。',
      '',
      '**`pump` 用 `while` 而不是 `if`。** 一次归还槽位可能要启动多个任务（比如并发度是 5、',
      '刚才有 3 个同时结束）。写成 `if` 只会启动一个，剩下的要等下一次归还才被想起来，',
      '表现为「并发度在压力下莫名其妙地降下来」。',
    ].join('\n'),
    [
      '`effectivePriority` is called from `takeNext`, not from `submit`. That is what decides whether aging',
      'works at all: at enqueue the wait is necessarily zero, so the computed value equals the original',
      'priority forever. Aging means changing over time, so it has to be a function evaluated at each',
      'selection rather than a stored field.',
      '',
      '`seq` instead of relying on sort stability. There is no sort here at all — one linear scan for the',
      'maximum, breaking ties on `seq` explicitly. Swap in a heap or any other structure and "FIFO within a',
      'priority" still holds.',
      '',
      'The failure branch also has `running -= 1` and `pump()`. Without those two lines a failed request',
      'holds its slot permanently, a few failures in a row silently reduce concurrency to zero, and the',
      'scheduler stops — reporting nothing. Resource-leak bugs of this shape are invisible to any test that',
      'only exercises the success path.',
      '',
      '`pump` loops with `while` rather than `if`. One returned slot can start several tasks — concurrency',
      'five with three finishing at once — and an `if` starts only one, leaving the rest until the next',
      'return. The symptom is concurrency mysteriously sagging under load.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage9 = {
  id: 'backpressure',
  title: t('第 9 关 · 背压与队列上限', 'Stage 9 · Backpressure and bounded queues'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关的调度器有一个没说出口的假设：**队列可以无限长**。',
      '入队速度超过处理速度时，这个假设会以两种方式报复你：',
      '',
      '1. **内存**：队列一直涨，最后 OOM；',
      '2. **延迟**：排在第 10000 位的请求，等它开始时调用方早就超时走了 ——',
      '   你在花真实的资源去处理一个没人要的结果。',
      '',
      '第二条比第一条更常见，也更隐蔽。它的表现是「系统没崩，但所有请求都超时」。',
      '',
      '## 要实现什么',
      '',
      '在 `src/bounded.ts` 实现 `createBoundedQueue(options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `submit(url)` | 有位置就排队；满了**立刻** reject 一个 `QueueFullError` |',
      '| `depth()` | 当前排队数 |',
      '| `highWaterMark()` | 历史最高排队数 |',
      '| `rejected()` | 被拒绝的总数 |',
      '',
      '## 怎么算过',
      '',
      '- 历史最高排队数不超过 `maxQueueDepth`（门槛 `counters.peakDepth ≤ 3`）；',
      '- 被拒绝的请求从 submit 到 reject 的耗时是 **0**',
      '  （门槛 `counters.rejectLatencyMs = 0`）；',
      '- 拒绝之后队列继续正常消费，不受影响；',
      '- `highWaterMark()` 记的是真实峰值。',
      '',
      '## 「立刻拒绝」这四个字是重点',
      '',
      '让调用方等一会儿再告诉它「队列满了」，等于把背压又变回了延迟 ——',
      '调用方拿不到快速失败，也就没法降级、没法换一条路、没法把这个失败上报给上游。',
      '背压的价值不在于「拒绝」，而在于**尽早**拒绝：越早拒绝，',
      '调用方能做的补救就越多。',
      '',
      '实现上就是一行：满了的时候 `return Promise.reject(...)`，',
      '同步返回一个已经 reject 的 Promise，耗时天然是 0。',
      '',
      '## 两个细节',
      '',
      '**上限只算排队的，不算正在执行的。** 正在执行的马上就结束，',
      '既不占队列内存也不会让延迟无限增长；把它们算进来，',
      '`maxQueueDepth` 的含义会随并发度漂移 —— 同一个配置值在并发 4 和并发 40 下',
      '表示完全不同的东西。',
      '',
      '**`push` 之后立刻记峰值。** `pump()` 可能马上就把它取走，',
      '漏了这一次更新，压测出来的峰值会比真实值低 —— 而峰值恰恰是你调容量时唯一要看的数。',
    ].join('\n'),
    [
      'The scheduler from the last stage carries an unspoken assumption: **the queue can grow without',
      'bound**. When arrivals outpace service, that assumption takes revenge in two ways:',
      '',
      '1. **memory** — the queue grows until the process dies;',
      '2. **latency** — by the time the ten-thousandth request starts, its caller timed out long ago, and you',
      '   are spending real resources computing a result nobody wants.',
      '',
      'The second is more common and better hidden. It presents as "nothing crashed, but everything times',
      'out".',
      '',
      '## What to build',
      '',
      '`createBoundedQueue(options)` in `src/bounded.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `submit(url)` | Queue it if there is room; otherwise reject **immediately** with `QueueFullError` |',
      '| `depth()` | The current queue length |',
      '| `highWaterMark()` | The maximum ever reached |',
      '| `rejected()` | The total refused |',
      '',
      '## What counts as passing',
      '',
      '- The high-water mark never exceeds `maxQueueDepth` (`counters.peakDepth ≤ 3`);',
      '- The time from submit to rejection is **zero** (`counters.rejectLatencyMs = 0`);',
      '- After a rejection the queue keeps draining normally;',
      '- `highWaterMark()` reports the true peak.',
      '',
      '## "Immediately" carries the weight',
      '',
      'Making the caller wait before telling it the queue is full turns backpressure back into latency — no',
      'fast failure means no chance to degrade, to reroute, or to propagate the pressure upstream. The value',
      'of backpressure is not the refusal but **how early** it arrives: the sooner you refuse, the more the',
      'caller can still do.',
      '',
      'In code it is one line: when full, `return Promise.reject(...)` — a synchronously rejected promise,',
      'whose elapsed time is zero by construction.',
      '',
      '## Two details',
      '',
      '**The limit counts queued items only, not running ones.** Running requests are about to finish; they',
      'occupy no queue memory and cannot grow latency without bound. Count them and `maxQueueDepth` drifts in',
      'meaning with the concurrency — the same configured number means completely different things at',
      'concurrency 4 and at 40.',
      '',
      '**Record the peak immediately after `push`.** `pump()` may remove it right away, and missing that',
      'update makes the measured peak lower than reality — while the peak is precisely the number you size',
      'capacity by.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**入队侧** —— 满了就同步拒绝',
      '',
      '```mermaid',
      'flowchart TD',
      '  SUB["submit(url)"] --> FULL{"queue.length ≥ maxQueueDepth<br/>且 running ≥ limit？"}',
      '  FULL -- 满了 --> REJ["refused += 1<br/>return Promise.reject(QueueFullError)<br/>同步返回已 reject 的 Promise"]',
      '  FULL -- 有位置 --> PUSH["queue.push({ url, settle })"]',
      '  PUSH --> PEAK["peak = max(peak, queue.length)<br/>push 之后立刻记<br/>pump 可能马上就把它取走"]',
      '  PEAK --> CALL["pump()"]',
      '```',
      '',
      '`REJ` 这条边上**没有任何 await**，这就是第二个门槛的全部 ——',
      '拒绝发生在同一个微任务里，调用方立刻就知道。',
      '只要在这条路径上加一个 `await`（哪怕是等一个空位），耗时就不再是 0，',
      '背压也就退化成了延迟。',
      '',
      '**出队侧** —— 有空槽且有排队就一直发',
      '',
      '```mermaid',
      'flowchart TD',
      '  P1{"running < limit 且队列非空？"}',
      '  P1 -- 否 --> STOP["停下，等有人结束"]',
      '  P1 -- 是 --> SHIFT["queue.shift()，running += 1"]',
      '  SHIFT --> REQ["request(url)"]',
      '  REQ --> FIN{"结束"}',
      '  FIN -- 成功 --> D1["running -= 1，settle(成功)"]',
      '  FIN -- 失败 --> D2["running -= 1，settle(失败)"]',
      '  D1 --> P1',
      '  D2 --> P1',
      '```',
      '',
      '上限只算**排队的**，不算正在执行的：正在执行的马上就结束，',
      '既不占队列内存也不会让延迟无限增长。把它们算进来，',
      '`maxQueueDepth` 的含义会随并发度漂移 —— 同一个配置值在并发 4 和并发 40 下',
      '表示完全不同的东西。',
    ].join('\n'),
    [
      '**The intake side** — full means a synchronous refusal',
      '',
      '```mermaid',
      'flowchart TD',
      '  SUB["submit(url)"] --> FULL{"queue.length ≥ maxQueueDepth<br/>and running ≥ limit?"}',
      '  FULL -- full --> REJ["refused += 1<br/>return Promise.reject(QueueFullError)<br/>a synchronously rejected promise"]',
      '  FULL -- "room available" --> PUSH["queue.push({ url, settle })"]',
      '  PUSH --> PEAK["peak = max(peak, queue.length)<br/>recorded right after push<br/>since pump may take it at once"]',
      '  PEAK --> CALL["pump()"]',
      '```',
      '',
      'The `REJ` edge contains **no await at all**, and that is the whole of the second gate — the refusal',
      'happens within the same microtask, so the caller knows immediately. Add a single `await` to that path',
      '(even waiting for a free slot) and the elapsed time stops being zero, degrading backpressure back into',
      'latency.',
      '',
      '**The drain side** — keep issuing while slots and work exist',
      '',
      '```mermaid',
      'flowchart TD',
      '  P1{"running < limit and queue non-empty?"}',
      '  P1 -- no --> STOP["stop and wait for someone to finish"]',
      '  P1 -- yes --> SHIFT["queue.shift(), running += 1"]',
      '  SHIFT --> REQ["request(url)"]',
      '  REQ --> FIN{"settles"}',
      '  FIN -- succeeded --> D1["running -= 1, settle(success)"]',
      '  FIN -- failed --> D2["running -= 1, settle(failure)"]',
      '  D1 --> P1',
      '  D2 --> P1',
      '```',
      '',
      'The limit counts **queued** items only, not running ones: running requests are about to finish, so',
      'they hold no queue memory and cannot grow latency without bound. Count them and `maxQueueDepth` drifts',
      'in meaning with the concurrency — the same configured number means completely different things at',
      'concurrency 4 and at 40.',
    ].join('\n')
  ),
  checklist: [
    t('队列未满时正常排队执行', 'Work queues normally while there is room'),
    t('队列满时立刻拒绝，不等待', 'A full queue rejects immediately without waiting'),
    t('拒绝抛的是 QueueFullError', 'Rejection throws a QueueFullError'),
    t('排队数从不超过上限', 'Queue depth never exceeds the limit'),
    t('有槽位空出来时恢复接收', 'Accepting resumes once a slot frees up'),
  ],
  pitfalls: [
    t(
      '队列满时不拒绝，而是让 submit 挂起，等有位置了再入队。这看起来更友好，实际上把背压变成了延迟：调用方拿不到任何信号，只是变慢，于是它自己的队列开始堆积——压力被原样传给了上游，而不是被挡住。背压的本质是**说不**，不是慢慢来。',
      'Suspending `submit` when the queue is full and enqueuing once space appears. It looks friendlier and turns backpressure into latency: the caller gets no signal, just slowness, so its own queue starts filling and the pressure is passed upstream unchanged rather than stopped. Backpressure means saying no, not going slower.'
    ),
    t(
      '把上限算在「排队数 + 正在执行数」上。正在执行的请求并不占队列内存，也不会让延迟无限增长——它们马上就会结束。把它们算进上限会让实际可排队量比配置的少，并发度越高少得越多，配置的含义变得依赖并发度。',
      'Counting running requests against the limit. Running work occupies no queue memory and does not grow latency without bound — it is about to finish. Including it makes the real queue capacity smaller than configured, by an amount that depends on concurrency, so the setting stops meaning what it says.'
    ),
    t(
      '拒绝时返回一个失败的 PageResult 而不是 reject。调用方于是要检查 `result.ok` 才知道被拒了，而这和「请求发出去但失败了」是完全不同的两件事——前者应该重试或降级，后者可能要退避。用异常把它们区分开。',
      'Returning a failed `PageResult` instead of rejecting. The caller must then inspect `result.ok`, conflating two very different outcomes: refused before sending (retry or degrade) versus sent and failed (perhaps back off). An exception keeps them distinct.'
    ),
    t(
      '记 highWaterMark 时只在入队时更新。出队时不更新是对的，但如果在「入队并立刻被取走」的路径上漏了更新，压测出来的峰值会比真实值低——一个专门用来发现容量问题的指标，反而在容量出问题时最不准。',
      'Updating the high-water mark only on enqueue. Not updating on dequeue is right, but missing the path where an item is enqueued and immediately taken makes the reported peak lower than reality — a metric whose entire purpose is to reveal capacity problems becomes least accurate exactly when capacity is a problem.'
    ),
  ],
  hints: [
    t(
      '`submit` 里先判断 `queue.length >= maxQueueDepth`，是就 `return Promise.reject(new QueueFullError(url))`。同步返回一个已 reject 的 promise，耗时天然是 0。',
      'In `submit`, check `queue.length >= maxQueueDepth` first and `return Promise.reject(new QueueFullError(url))`. A synchronously rejected promise takes zero time by construction.'
    ),
    t(
      'highWaterMark 在每次 push 之后立刻 `Math.max` 一下，这样无论后面是不是马上被取走，峰值都记下来了。',
      'Update the high-water mark with a `Math.max` right after every push, so the peak is recorded whether or not the item is taken immediately afterwards.'
    ),
  ],
  extension: t(
    [
      '「满了就拒绝」是最简单的背压策略，学名叫 **tail drop**。',
      '它有个已知问题：所有客户端会在同一时刻开始被拒，同时退避，然后同时重来——',
      '这就是网络里的**全局同步**（global synchronisation）现象。',
      '路由器解决它的办法是 RED（Random Early Detection）：队列还没满的时候就开始',
      '按概率随机丢弃，队列越长概率越高。随机性把客户端的重试时刻打散了。',
      '',
      '另一个维度是**丢哪一个**。tail drop 丢最新来的，但最新来的往往是最有价值的',
      '（调用方还在等它）；队头那个已经等了很久，很可能调用方早就超时了。',
      '所以有些系统用 head drop 或者 **LIFO 队列**——反直觉，但在过载时',
      '「优先服务刚到的请求」能让成功率显著更高，因为老请求本来也救不回来了。',
      'Facebook 的 Wangle 和 Envoy 都提供了这个选项。',
      '',
      '再往上是**自适应容量**：上限不写死，而是根据观察到的延迟自动调整。',
      'Netflix 的 concurrency-limits 库用的是 TCP 拥塞控制那套算法（AIMD、Gradient），',
      '把「队列该多长」变成一个持续测量的量，而不是一个上线前拍脑袋定的常数。',
    ].join('\n'),
    [
      'Rejecting when full is the simplest backpressure policy, known as tail drop. It has a known flaw:',
      'every client starts getting refused at the same instant, backs off together and returns together —',
      'the global synchronisation effect from networking. Routers answer it with RED (Random Early',
      'Detection), dropping probabilistically before the queue is full with probability rising as it grows.',
      'The randomness spreads client retries apart.',
      '',
      'The other dimension is which item to drop. Tail drop discards the newest arrival, yet the newest is',
      'often the most valuable — its caller is still waiting — while the item at the head has waited so long',
      'its caller has probably given up. So some systems use head drop or an outright LIFO queue.',
      'Counterintuitive, but under overload "serve the freshest request first" measurably raises success',
      'rate, because the old ones were unsalvageable anyway. Facebook\'s Wangle and Envoy both offer it.',
      '',
      'Above that sits adaptive capacity: rather than a fixed limit, adjust from observed latency.',
      "Netflix's concurrency-limits library borrows TCP congestion control (AIMD, Gradient), turning \"how",
      'long should the queue be" into a continuously measured quantity instead of a constant guessed before',
      'launch.',
    ].join('\n')
  ),
  focus: ['resilience', 'concurrency', 'latency'],
  lab: { defaultLatencyMs: 100 },
  starterFiles: [
    file(
      'src/bounded.ts',
      code`
        import type { PageResult } from './contract';

        export class QueueFullError extends Error {
          url: string;

          constructor(url: string) {
            super('queue is full, rejected ' + url);
            this.name = 'QueueFullError';
            this.url = url;
          }
        }

        export interface BoundedOptions {
          concurrency: number;
          /** How many may be queued at most (those running excluded) */
          maxQueueDepth: number;
        }

        export interface BoundedQueue {
          /** Rejects immediately with QueueFullError when the queue is full */
          submit(url: string): Promise<PageResult>;
          depth(): number;
          highWaterMark(): number;
          rejected(): number;
        }

        export function createBoundedQueue(options: BoundedOptions): BoundedQueue {
          // TODO: implement this
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
        import { createBoundedQueue, QueueFullError } from '../src/bounded';
        import { now, sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        describe('Stage 9 · Backpressure and queue limits', () => {
          it('runs normally while there is room', async () => {
            const queue = createBoundedQueue({ concurrency: 2, maxQueueDepth: 4 });
            const results = await Promise.all([
              queue.submit('/api/a'),
              queue.submit('/api/b'),
            ]);
            expect(results.every((result) => result.ok)).toBe(true);
            expect(queue.rejected()).toBe(0);
          });

          it('rejects immediately once full', async () => {
            const queue = createBoundedQueue({ concurrency: 1, maxQueueDepth: 2 });
            const accepted: Array<Promise<unknown>> = [];
            // 1 running + 2 queued = full
            accepted.push(queue.submit('/api/running'));
            await sleep(1);
            accepted.push(queue.submit('/api/queued-1'));
            accepted.push(queue.submit('/api/queued-2'));

            let error: unknown = null;
            try {
              await queue.submit('/api/overflow');
            } catch (caught) {
              error = caught;
            }

            expect(error).toBeInstanceOf(QueueFullError);
            expect(queue.rejected()).toBe(1);
            await Promise.all(accepted);
          });

          it('rejection happens immediately and does not make the caller wait [gate:fast-reject]', async () => {
            const queue = createBoundedQueue({ concurrency: 1, maxQueueDepth: 1 });
            const accepted = [queue.submit('/api/running')];
            await sleep(1);
            accepted.push(queue.submit('/api/queued'));

            const before = now();
            let rejectedAt = -1;
            try {
              await queue.submit('/api/overflow');
            } catch (caught) {
              rejectedAt = now() - before;
            }
            count('rejectLatencyMs', rejectedAt);

            // An implementation that waits for a free slot before rejecting takes over 100ms here
            expect(rejectedAt).toBe(0);
            await Promise.all(accepted);
          });

          it('the queue length never exceeds the limit [gate:depth]', async () => {
            const queue = createBoundedQueue({ concurrency: 2, maxQueueDepth: 3 });
            const inFlight: Array<Promise<unknown>> = [];

            for (let index = 0; index < 20; index += 1) {
              inFlight.push(
                queue.submit('/api/page-' + index).catch(() => null)
              );
            }
            await Promise.all(inFlight);
            count('peakDepth', queue.highWaterMark());

            expect(queue.highWaterMark()).toBeLessThanOrEqual(3);
            expect(queue.rejected()).toBeGreaterThan(0);
          });

          it('starts accepting again once a slot frees up', async () => {
            const queue = createBoundedQueue({ concurrency: 1, maxQueueDepth: 1 });
            const first = queue.submit('/api/first');
            await sleep(1);
            const second = queue.submit('/api/second');

            let rejected = false;
            try {
              await queue.submit('/api/third');
            } catch (caught) {
              rejected = true;
            }
            expect(rejected).toBe(true);

            await Promise.all([first, second]);
            // Everything has finished and the queue is empty
            expect(queue.depth()).toBe(0);
            const later = await queue.submit('/api/later');
            expect(later.ok).toBe(true);
          });

          it('running requests do not take up queue slots', async () => {
            const queue = createBoundedQueue({ concurrency: 3, maxQueueDepth: 2 });
            const running: Array<Promise<unknown>> = [];
            for (let index = 0; index < 3; index += 1) running.push(queue.submit('/api/run-' + index));
            await sleep(1);

            // 3 running with an empty queue, so it should still accept 2 more
            expect(queue.depth()).toBe(0);
            running.push(queue.submit('/api/q1'));
            running.push(queue.submit('/api/q2'));
            expect(queue.depth()).toBe(2);

            await Promise.all(running);
          });

          it('depth falls back once execution starts', async () => {
            const queue = createBoundedQueue({ concurrency: 1, maxQueueDepth: 3 });
            const tasks = [queue.submit('/api/a')];
            await sleep(1);
            tasks.push(queue.submit('/api/b'));
            expect(queue.depth()).toBe(1);

            await Promise.all(tasks);
            expect(queue.depth()).toBe(0);
          });

          it('highWaterMark remembers the peak and does not fall back with it', async () => {
            const queue = createBoundedQueue({ concurrency: 1, maxQueueDepth: 5 });
            const tasks = [queue.submit('/api/a')];
            await sleep(1);
            tasks.push(queue.submit('/api/b'), queue.submit('/api/c'));
            const peak = queue.highWaterMark();
            expect(peak).toBeGreaterThanOrEqual(2);

            await Promise.all(tasks);
            expect(queue.depth()).toBe(0);
            expect(queue.highWaterMark()).toBe(peak);
          });

          it('newcomers are rejected while those already queued run as usual', async () => {
            const queue = createBoundedQueue({ concurrency: 1, maxQueueDepth: 1 });
            const running = queue.submit('/api/running');
            await sleep(1);
            const queued = queue.submit('/api/queued');

            await queue.submit('/api/overflow').catch(() => null);

            const results = await Promise.all([running, queued]);
            expect(results.every((result) => result.ok)).toBe(true);
          });

          it('a maxQueueDepth of 0 accepts only what is running', async () => {
            const queue = createBoundedQueue({ concurrency: 1, maxQueueDepth: 0 });
            const running = queue.submit('/api/running');
            await sleep(1);

            let rejected = false;
            try {
              await queue.submit('/api/any');
            } catch (caught) {
              rejected = true;
            }
            expect(rejected).toBe(true);
            await running;
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.peakDepth',
      op: 'lte',
      value: 3,
      zh: '排队数从不越过配置的上限',
      en: 'Queue depth never crosses the configured limit',
      dimension: 'resilience',
      scope: 'gate:depth',
    }),
    gate({
      metric: 'counters.rejectLatencyMs',
      op: 'eq',
      value: 0,
      unit: 'ms',
      zh: '拒绝是立刻返回的，不是等出来的',
      en: 'Rejection returns immediately rather than after a wait',
      dimension: 'latency',
      scope: 'gate:fast-reject',
    }),
  ],
  referenceFiles: [
    file(
      'src/bounded.ts',
      code`
        import type { PageResult } from './contract';
        import { request } from '@lab/net';

        export class QueueFullError extends Error {
          url: string;

          constructor(url: string) {
            super('queue is full, rejected ' + url);
            this.name = 'QueueFullError';
            this.url = url;
          }
        }

        export interface BoundedOptions {
          concurrency: number;
          maxQueueDepth: number;
        }

        export interface BoundedQueue {
          submit(url: string): Promise<PageResult>;
          depth(): number;
          highWaterMark(): number;
          rejected(): number;
        }

        interface Waiting {
          url: string;
          settle(result: PageResult): void;
        }

        export function createBoundedQueue(options: BoundedOptions): BoundedQueue {
          const limit = Math.max(1, options.concurrency);
          const queue: Waiting[] = [];
          let running = 0;
          let peak = 0;
          let refused = 0;

          function pump(): void {
            while (running < limit && queue.length > 0) {
              const task = queue.shift() as Waiting;
              running += 1;
              request(task.url).then(
                (response) => {
                  running -= 1;
                  task.settle({ url: task.url, ok: true, data: response.data });
                  pump();
                },
                (error) => {
                  running -= 1;
                  task.settle({
                    url: task.url,
                    ok: false,
                    data: null,
                    error: error instanceof Error ? error.message : String(error),
                  });
                  pump();
                }
              );
            }
          }

          return {
            submit(url: string): Promise<PageResult> {
              // The limit counts queued work only: what is running is about to finish, so it neither occupies
              // queue memory nor grows latency without bound, and counting it makes the setting's meaning drift with concurrency
              if (queue.length >= options.maxQueueDepth && running >= limit) {
                refused += 1;
                // Return an already-rejected promise synchronously, so the elapsed time is naturally 0.
                // Waiting for a free slot before rejecting turns backpressure back into latency
                return Promise.reject(new QueueFullError(url));
              }

              return new Promise<PageResult>((resolve) => {
                queue.push({ url, settle: resolve });
                // Record the peak right after the push: pump may take it away immediately,
                // and missing this update makes the measured peak lower than the real one
                peak = Math.max(peak, queue.length);
                pump();
              });
            },

            depth(): number {
              return queue.length;
            },

            highWaterMark(): number {
              return peak;
            },

            rejected(): number {
              return refused;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`Promise.reject(...)` 是同步返回的。** 这一行让「立刻拒绝」这个语义免费成立：',
      '调用方 `await` 它的时候会在下一个微任务里拿到异常，虚拟时钟一格都不走。',
      '写成 `async submit()` 里 `throw` 效果一样；写成「先 await 点什么再抛」就毁了。',
      '',
      '**判断条件是 `queue.length >= maxQueueDepth && running >= limit`。** 两个条件都要：',
      '只看队列长度的话，`maxQueueDepth: 0` 会把所有请求都拒掉，包括本可以直接开跑的那个；',
      '只看 running 的话，队列会无限长。前者管「有没有空槽」，后者管「等的人多不多」。',
      '',
      '**峰值在 push 之后立刻记。** `pump()` 可能在同一个同步块里就把它取走，',
      '这时 `queue.length` 已经回落了。把 `Math.max` 放在 pump 之后，',
      '这种「入队即执行」的路径就永远不会被计入峰值——而这恰恰是低压力下的常态，',
      '于是这个指标在正常时永远是 0，在过载时才突然跳起来，失去了预警的作用。',
      '',
      '**拒绝用异常而不是失败结果。** 「因为队列满了没发出去」和「发出去了但失败」',
      '对调用方是两种完全不同的处置：前者该降级或者换条路，后者该考虑重试。',
      '塞进同一个 `PageResult` 里，调用方就只能靠字符串匹配 error 来区分。',
    ].join('\n'),
    [
      '`Promise.reject(...)` returns synchronously, which makes "reject immediately" true for free: the',
      "caller's `await` sees the error on the next microtask and the virtual clock does not advance a tick.",
      'A `throw` inside an `async submit()` is equivalent; awaiting anything before throwing ruins it.',
      '',
      'The condition is `queue.length >= maxQueueDepth && running >= limit`, and both halves are needed.',
      'Checking only the queue makes `maxQueueDepth: 0` refuse everything including work that could start',
      'right now; checking only `running` lets the queue grow without bound. One asks whether a slot is',
      'free, the other how many are already waiting.',
      '',
      'The peak is recorded immediately after the push. `pump()` may take the item within the same',
      'synchronous block, by which point `queue.length` has already fallen. Putting the `Math.max` after',
      'pump means the enqueue-and-run-immediately path never counts — and that path is the norm under light',
      'load, so the metric reads zero when things are fine and only jumps under overload, losing exactly',
      'the early warning it exists to give.',
      '',
      'Rejection is an exception, not a failed result. "Never sent because the queue was full" and "sent',
      'and failed" call for different handling — degrade or reroute versus consider retrying. Folding both',
      'into one `PageResult` leaves the caller matching on error strings to tell them apart.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage10 = {
  id: 'pagination',
  title: t('第 10 关 · 游标分页遍历', 'Stage 10 · Cursor pagination'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前面所有关卡处理的都是「一批已知的 URL」。真实的抓取任务往往不是这样：',
      '你只知道第一页的地址，下一页的地址藏在这一页的响应里。',
      '',
      '## 要实现什么',
      '',
      '在 `src/paginate.ts` 实现 `fetchAllPages(startUrl, options)`。',
      '每一页的响应形如 `{ items: [...], next: string | null }`：',
      '',
      '| 规则 | 说明 |',
      '| --- | --- |',
      '| 顺着 `next` 走 | 把所有 `items` 拼起来，`next` 为 `null` 表示走完了 |',
      '| `maxPages` | 最多翻多少页，到了就停下并标记 `truncated: true` |',
      '| 环检测 | 游标成环时必须停下来，并标记 `looped: true` |',
      '| 容错 | 服务端返回畸形数据时不要让整次遍历崩掉 |',
      '',
      '## 怎么算过',
      '',
      '- 翻三页正好发三个请求，不重复抓（门槛 `requests.total = 3`）；',
      '- 游标指向自己时立刻停止（门槛 `requests.total ≤ 1`）；',
      '- `truncated` 只在「还有下一页却停下来了」时为真；',
      '- `items` 的顺序与页序一致。',
      '',
      '## 环检测必须独立于 `maxPages`',
      '',
      '服务端出 bug 返回一个指向自己的 `next`，没有防护的实现会一直翻下去，直到内存耗尽。',
      '',
      '但「靠 `maxPages` 兜底」也不算解决：调用方拿到的会是',
      '「一百页重复数据 + `truncated: true`」，它会以为后面还有更多，于是接着翻。',
      '错误被包装成了一个看起来正常的结果，这比直接崩掉更难查。',
      '',
      '所以要用一个 `visited` 集合独立地判断，并且用**单独的 `looped` 字段**报告出来 ——',
      '`truncated` 和 `looped` 是两件不同的事，调用方对它们的处理也不同。',
      '',
      '## 这一关天生是串行的',
      '',
      '这是前面九关都没有的特点：你必须拿到第 N 页才知道第 N+1 页在哪，',
      '所以并发池在这里一点忙都帮不上。十页各 100ms 就是 1000ms，',
      '没有任何办法压缩 —— 除非服务端提供别的分页方式（比如按 id 区间并行拉取）。',
      '',
      '认清这一点也是工程判断的一部分：**不是所有慢都能靠并发解决**，',
      '有些慢是接口形状决定的，只能去改接口。',
      '',
      '另外一个小细节：拼接用 `items.push(...)` 逐个推入，',
      '不要每页都 `items = [...items, ...page.items]` —— 后者在页数多时是 O(n²) 次复制。',
    ].join('\n'),
    [
      'Every stage so far worked on a batch of known URLs. Real crawling is rarely like that: you know the',
      'first page\'s address, and the next one is hidden inside the response.',
      '',
      '## What to build',
      '',
      '`fetchAllPages(startUrl, options)` in `src/paginate.ts`. Each page responds with',
      '`{ items: [...], next: string | null }`:',
      '',
      '| Rule | Detail |',
      '| --- | --- |',
      '| Follow `next` | Concatenate every `items`; a `null` `next` means the end |',
      '| `maxPages` | Cap how far you go, stopping with `truncated: true` |',
      '| Loop detection | A cursor loop must terminate, reported as `looped: true` |',
      '| Tolerance | Malformed server data must not crash the whole traversal |',
      '',
      '## What counts as passing',
      '',
      '- Walking three pages issues exactly three requests, none repeated (`requests.total = 3`);',
      '- A cursor pointing at itself stops immediately (`requests.total ≤ 1`);',
      '- `truncated` is true only when there was a next page and you stopped;',
      '- `items` follow page order.',
      '',
      '## Loop detection must be independent of `maxPages`',
      '',
      'A buggy server returning a `next` that points at itself will make an unguarded implementation crawl',
      'until it runs out of memory.',
      '',
      'But "let `maxPages` catch it" is not a fix either: the caller receives a hundred pages of duplicate',
      'data plus `truncated: true`, concludes there is more, and keeps going. The error has been wrapped in a',
      'result that looks normal, which is harder to diagnose than a crash.',
      '',
      'So judge it independently with a `visited` set and report it through a **separate `looped` field** —',
      '`truncated` and `looped` are different conditions and callers handle them differently.',
      '',
      '## This stage is inherently serial',
      '',
      'None of the previous nine were: you cannot know where page N+1 is until page N arrives, so the',
      'concurrency pool is of no help whatsoever. Ten pages at 100ms each is 1000ms and nothing can compress',
      'it — short of the server offering another way to paginate (fetching id ranges in parallel, say).',
      '',
      'Recognising that is part of engineering judgement too: **not every slowness can be solved with',
      'concurrency.** Some of it is decided by the shape of the interface, and the only fix is to change the',
      'interface.',
      '',
      'One small detail: concatenate by pushing items one at a time rather than doing',
      '`items = [...items, ...page.items]` per page — the latter is O(n²) copying once there are many',
      'pages.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  F["fetchAllPages(startUrl, options)"] --> INIT["cursor = startUrl<br/>visited = 空集合，items = []"]',
      '  INIT --> W{"cursor 非 null，且 pages < maxPages？"}',
      '  W -- 否 --> OUT',
      '  W -- 是 --> LP{"visited 里已经有这个 cursor 吗？"}',
      '  LP -- 有 --> BRK["looped = true，break<br/>环检测独立于 maxPages"]',
      '  LP -- 没有 --> ADD["visited.add(cursor)"]',
      '  ADD --> REQ["await request(cursor)<br/>pages += 1"]',
      '  REQ --> ITEMS{"page.items 是数组吗？"}',
      '  ITEMS -- 是 --> PUSH["逐个 push 进 items<br/>不每页重建数组：那是 O(n²) 次复制"]',
      '  ITEMS -- 不是 --> SKIP["跳过<br/>畸形数据不该让整次遍历崩掉"]',
      '  PUSH --> NEXT',
      '  SKIP --> NEXT["cursor = page.next 是字符串就用它，否则 null"]',
      '  NEXT --> W',
      '  BRK --> OUT["{ items, pages,<br/>truncated: 还有下一页却停了，<br/>looped }"]',
      '```',
      '',
      '要点：这张图是一条**没有分叉的直线** —— `REQ` 只有一个，`W` 的回边只有一条。',
      '这就是「天生串行」的样子：下一次请求的地址由上一次的响应决定，',
      '并发池在这里无处可插。',
      '',
      '`LP` 和 `W` 是两个独立的终止条件，对应结果里两个独立的字段。',
      '把 `LP` 去掉、只靠 `W` 兜底，遍历确实会停，但调用方会以为「只是被截断了，后面还有」。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  F["fetchAllPages(startUrl, options)"] --> INIT["cursor = startUrl<br/>visited = empty set, items = []"]',
      '  INIT --> W{"cursor is not null and pages < maxPages?"}',
      '  W -- no --> OUT',
      '  W -- yes --> LP{"is this cursor already in visited?"}',
      '  LP -- yes --> BRK["looped = true, break<br/>loop detection independent of maxPages"]',
      '  LP -- no --> ADD["visited.add(cursor)"]',
      '  ADD --> REQ["await request(cursor)<br/>pages += 1"]',
      '  REQ --> ITEMS{"is page.items an array?"}',
      '  ITEMS -- yes --> PUSH["push them into items one by one<br/>no per-page rebuild: that is O(n²) copying"]',
      '  ITEMS -- no --> SKIP["skip it<br/>malformed data must not crash the traversal"]',
      '  PUSH --> NEXT',
      '  SKIP --> NEXT["cursor = page.next when it is a string, otherwise null"]',
      '  NEXT --> W',
      '  BRK --> OUT["{ items, pages,<br/>truncated: there was a next page and we stopped,<br/>looped }"]',
      '```',
      '',
      'The point: this diagram is a **straight line with no fan-out** — one `REQ`, one back-edge from `W`.',
      'That is what "inherently serial" looks like: the address of the next request comes out of the previous',
      'response, and there is nowhere for a concurrency pool to fit.',
      '',
      '`LP` and `W` are two independent termination conditions matching two independent result fields. Drop',
      '`LP` and rely on `W` and the traversal does stop — but the caller concludes it was merely truncated and',
      'that more remains.',
    ].join('\n')
  ),
  checklist: [
    t('顺着 next 走到底并拼接 items', 'Follow next to the end, concatenating items'),
    t('next 为 null 时停止', 'Stop when next is null'),
    t('maxPages 生效并标记 truncated', 'maxPages applies and marks the result truncated'),
    t('环形游标不会让程序转不出来', 'A cursor loop does not spin forever'),
    t('翻 N 页就发 N 个请求', 'Walking N pages issues exactly N requests'),
  ],
  pitfalls: [
    t(
      '只靠 `maxPages` 防环。它确实能保证程序停下来，但停下来的时候你会得到一个「翻了 100 页、items 里全是重复的同一批」的结果，而且 `truncated` 是 true，调用方以为还有更多。用一个 `Set` 记住访问过的 URL，撞上重复立刻停并明确报告——这是两种不同的结束原因。',
      'Relying on `maxPages` alone to break loops. It does stop the program, and it stops with a result containing a hundred pages of the same repeated items and `truncated` set to true, so the caller believes there is more. Track visited URLs in a `Set`, stop on a repeat and report it distinctly — these are two different reasons for stopping.'
    ),
    t(
      '把 `next` 当成相对路径直接拼在 startUrl 后面。有些 API 返回的是完整 URL，有些返回的是游标字符串，有些返回相对路径——拼错了会得到一个不存在的地址，而症状是「第二页 404」，很容易被误判成服务端的问题。这一关的约定是 `next` 就是下一页的完整地址，照用即可。',
      'Treating `next` as a relative path and concatenating it onto the start URL. Some APIs return a full URL, some a cursor token, some a relative path; guessing wrong yields a nonexistent address and presents as "page two 404s", easily misdiagnosed as a server problem. The contract here is that `next` is the complete address of the next page.'
    ),
    t(
      '每翻一页都把已收集的 items 复制一遍（`items = [...items, ...page.items]`）。一百页的时候这是 O(n²) 次复制。改成 `items.push(...page.items)` 就是线性的。这类问题在十页的测试里完全看不出来。',
      'Copying the accumulated items on every page (`items = [...items, ...page.items]`). At a hundred pages that is O(n²) copying, where `items.push(...page.items)` is linear. A ten-page test shows nothing.'
    ),
    t(
      '认为分页可以并发加速，于是猜测下一页的地址（比如把 `?page=1` 改成 `?page=2`）提前发出去。这在偏移分页上碰巧能用，在游标分页上必然出错——游标是不透明的，猜不出来。而且就算是偏移分页，并发翻页遇到数据变动会漏行或重复。',
      'Assuming pagination can be parallelised by guessing the next address, incrementing `?page=1` to `?page=2` and issuing it early. That happens to work with offset pagination and cannot work with cursors, which are opaque by design. And even with offsets, paging concurrently while the data changes skips or duplicates rows.'
    ),
  ],
  hints: [
    t(
      '循环条件是「还有 next 且没到 maxPages 且这个 URL 没访问过」。三个条件对应三种结束原因，分别记下来，调用方才知道为什么停。',
      'The loop condition is "there is a next, the page cap is not reached, and this URL has not been seen". Three conditions, three reasons for stopping — record which one fired so the caller knows why.'
    ),
    t(
      '响应体就是 `response.data`，直接当作 `{ items, next }` 用。防御性地处理一下 `items` 不是数组的情况，服务端返回畸形数据时不要整个崩掉。',
      'The body is `response.data`, usable directly as `{ items, next }`. Guard against `items` not being an array so malformed server data does not take the whole crawl down.'
    ),
  ],
  extension: t(
    [
      '游标分页（cursor / keyset pagination）和偏移分页（`LIMIT 20 OFFSET 1000`）',
      '是两种完全不同的东西，而且前者在几乎所有维度上都更好。',
      '',
      '偏移分页的问题在数据库层：`OFFSET 1000` 要求数据库**扫描并丢弃**前 1000 行，',
      '翻到第 500 页时每次查询都要扫 10000 行。更糟的是它不稳定——',
      '你在翻第 2 页的时候有人插入了一行，第 3 页就会重复或者漏掉一条记录。',
      '游标分页记的是「上次读到哪个键」，用 `WHERE id > last_id LIMIT 20`，',
      '走索引、代价恒定、而且对并发插入免疫。',
      '',
      '代价是游标分页**不能跳页**——没有「第 47 页」这个概念，只能一页页往下走。',
      '这也是为什么社交产品（无限滚动）都用游标，而后台管理系统（要显示页码）还在用偏移。',
      '',
      '至于「分页天生串行」这个限制，真实系统的绕法是让服务端提供**并行分片**：',
      '一次返回 N 个互不重叠的起始游标，客户端可以并发地各走各的。',
      'DynamoDB 的 Parallel Scan、Kafka 的 partition、S3 ListObjects 的分段',
      '都是这个思路——把「串行的遍历」变成「并行的多条串行遍历」。',
    ].join('\n'),
    [
      'Cursor (keyset) pagination and offset pagination (`LIMIT 20 OFFSET 1000`) are entirely different',
      'things, and the former is better on nearly every axis.',
      '',
      "Offset's problem is at the database: `OFFSET 1000` requires scanning and discarding a thousand rows,",
      'so page 500 scans ten thousand rows per query. Worse, it is unstable — someone inserting a row while',
      'you are on page 2 makes page 3 repeat or skip a record. Cursor pagination remembers the last key seen',
      'and issues `WHERE id > last_id LIMIT 20`: index-backed, constant cost, immune to concurrent inserts.',
      '',
      'The price is that cursors cannot jump — there is no "page 47", only one page after another. Which is',
      'why infinite-scroll products use cursors while admin consoles that display page numbers still use',
      'offsets.',
      '',
      'As for pagination being inherently serial, real systems escape it by having the server offer',
      'parallel shards: return N non-overlapping starting cursors so clients can walk each concurrently.',
      "DynamoDB's Parallel Scan, Kafka partitions and segmented S3 ListObjects are all this idea — turning",
      'one serial traversal into several parallel serial traversals.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'latency'],
  lab: {
    defaultLatencyMs: 100,
    endpoints: {
      '/api/list/1': { payload: { items: ['a', 'b'], next: '/api/list/2' } },
      '/api/list/2': { payload: { items: ['c', 'd'], next: '/api/list/3' } },
      '/api/list/3': { payload: { items: ['e'], next: null } },
      '/api/single': { payload: { items: ['solo'], next: null } },
      '/api/empty': { payload: { items: [], next: null } },
      '/api/loop/1': { payload: { items: ['x'], next: '/api/loop/1' } },
      '/api/malformed': { payload: { next: null } },
    },
  },
  starterFiles: [
    file(
      'src/paginate.ts',
      code`
        export interface PaginateOptions {
          /** How many pages to fetch at most */
          maxPages: number;
        }

        export interface PaginateResult {
          items: unknown[];
          /** How many pages were actually requested */
          pages: number;
          /** Stopped early because of maxPages */
          truncated: boolean;
          /** Stopped early because the cursor formed a loop */
          looped: boolean;
        }

        export function fetchAllPages(startUrl: string, options: PaginateOptions): Promise<PaginateResult> {
          // TODO: implement this
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
        import { fetchAllPages } from '../src/paginate';
        import { now } from '@lab/env';
        import { getMetrics } from '@lab/net';

        describe('Stage 10 · Cursor pagination', () => {
          it('walks to the end and concatenates every item [gate:pages]', async () => {
            const result = await fetchAllPages('/api/list/1', { maxPages: 10 });

            expect(result.items).toEqual(['a', 'b', 'c', 'd', 'e']);
            expect(result.pages).toBe(3);
            expect(result.truncated).toBe(false);
            expect(result.looped).toBe(false);
            // Three pages take exactly three requests, with nothing fetched twice
            expect(getMetrics().requests.total).toBe(3);
          });

          it('works with a single page too', async () => {
            const result = await fetchAllPages('/api/single', { maxPages: 10 });
            expect(result.items).toEqual(['solo']);
            expect(result.pages).toBe(1);
          });

          it('an empty list does not blow up', async () => {
            const result = await fetchAllPages('/api/empty', { maxPages: 10 });
            expect(result.items).toEqual([]);
            expect(result.pages).toBe(1);
          });

          it('maxPages takes effect and marks truncated', async () => {
            const result = await fetchAllPages('/api/list/1', { maxPages: 2 });
            expect(result.items).toEqual(['a', 'b', 'c', 'd']);
            expect(result.pages).toBe(2);
            expect(result.truncated).toBe(true);
            expect(result.looped).toBe(false);
          });

          it('a maxPages of 1 fetches only the first page', async () => {
            const result = await fetchAllPages('/api/list/1', { maxPages: 1 });
            expect(result.items).toEqual(['a', 'b']);
            expect(result.pages).toBe(1);
            expect(result.truncated).toBe(true);
          });

          it('a looping cursor stops and is marked looped [gate:loop]', async () => {
            const result = await fetchAllPages('/api/loop/1', { maxPages: 50 });

            expect(result.looped).toBe(true);
            // An implementation relying on maxPages alone would fetch 50 times
            expect(result.pages).toBe(1);
            expect(getMetrics().requests.total).toBe(1);
          });

          it('stopping on a loop and stopping on maxPages are two distinct reasons', async () => {
            const looped = await fetchAllPages('/api/loop/1', { maxPages: 50 });
            const truncated = await fetchAllPages('/api/list/1', { maxPages: 2 });

            expect(looped.looped).toBe(true);
            expect(looped.truncated).toBe(false);
            expect(truncated.truncated).toBe(true);
            expect(truncated.looped).toBe(false);
          });

          it('a malformed response missing items does not crash the whole walk', async () => {
            const result = await fetchAllPages('/api/malformed', { maxPages: 5 });
            expect(result.items).toEqual([]);
            expect(result.pages).toBe(1);
          });

          it('pagination is serial, taking page count times per-page latency', async () => {
            const startedAt = now();
            await fetchAllPages('/api/list/1', { maxPages: 10 });
            // Three pages at 100ms each: without page N you do not know where page N+1 is, so it cannot be compressed
            expect(now() - startedAt).toBe(300);
          });

          it('a maxPages of 0 issues no requests at all', async () => {
            const result = await fetchAllPages('/api/list/1', { maxPages: 0 });
            expect(result.pages).toBe(0);
            expect(result.items).toEqual([]);
            expect(getMetrics().requests.total).toBe(0);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'requests.total',
      op: 'eq',
      value: 3,
      zh: '翻三页正好发三个请求',
      en: 'Three pages cost exactly three requests',
      dimension: 'correctness',
      scope: 'gate:pages',
    }),
    gate({
      metric: 'requests.total',
      op: 'lte',
      value: 1,
      zh: '游标成环时立刻停止，不靠页数上限兜底',
      en: 'A cursor loop stops at once instead of running to the page cap',
      dimension: 'resilience',
      scope: 'gate:loop',
    }),
  ],
  referenceFiles: [
    file(
      'src/paginate.ts',
      code`
        import { request } from '@lab/net';

        export interface PaginateOptions {
          maxPages: number;
        }

        export interface PaginateResult {
          items: unknown[];
          pages: number;
          truncated: boolean;
          looped: boolean;
        }

        interface PageEnvelope {
          items?: unknown[];
          next?: string | null;
        }

        export async function fetchAllPages(
          startUrl: string,
          options: PaginateOptions
        ): Promise<PaginateResult> {
          const items: unknown[] = [];
          const visited = new Set<string>();

          let cursor: string | null = startUrl;
          let pages = 0;
          let looped = false;

          while (cursor !== null && pages < options.maxPages) {
            // Loop detection is independent of maxPages: relying on the page count alone leaves
            // the caller with a hundred pages of duplicate data and truncated: true,
            // which reads as if there were more still to come
            if (visited.has(cursor)) {
              looped = true;
              break;
            }
            visited.add(cursor);

            const response = await request(cursor);
            pages += 1;

            const page = (response.data || {}) as PageEnvelope;
            // Do not let a malformed server response crash the whole walk
            if (Array.isArray(page.items)) {
              // push rather than rebuilding the array: the latter is O(n\u00b2) copies once there are many pages
              for (const item of page.items) items.push(item);
            }

            cursor = typeof page.next === 'string' ? page.next : null;
          }

          return {
            items,
            pages,
            // It only counts as truncated if it stopped while a next page still existed
            truncated: cursor !== null && !looped,
            looped,
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`truncated` 的判断是 `cursor !== null && !looped`。** 三种结束方式要能被调用方区分：',
      '正常走完（cursor 为 null）、撞上页数上限（还有 cursor）、游标成环（looped）。',
      '把后两种混成一个 `truncated: true`，调用方就没法决定「要不要接着抓」——',
      '前者接着抓是对的，后者接着抓只会再撞一次环。',
      '',
      '**`visited` 用 Set 而不是只比较「和上一个 URL 是否相同」。** 环不一定是自环，',
      '服务端可能返回 A → B → A 这样的两步环，只比上一个是发现不了的。',
      'Set 的代价是 O(页数) 的内存，而这本来就已经被 `maxPages` 限住了。',
      '',
      '**循环条件里 `pages < options.maxPages` 在前，请求在后。** 这样 `maxPages: 0`',
      '会一个请求都不发，而不是「先发一个再发现超了」。边界值传 0 通常意味着',
      '调用方想要「什么都别做」，把这个意图落实比抛参数异常更有用。',
      '',
      '**这一关没有并发。** 前面九关都在想办法把并发度提上去，这一关的正确答案是',
      '一个朴素的 `while` 加 `await`。识别出「这件事天生不能并行」和知道怎么并行同样重要——',
      '硬要在这里加并发的实现只会引入猜测游标之类的错误。',
    ].join('\n'),
    [
      'The `truncated` test is `cursor !== null && !looped`. The caller has to distinguish three endings:',
      'a natural finish (cursor null), hitting the page cap (a cursor remains), and a loop. Collapsing the',
      'last two into one `truncated: true` leaves the caller unable to decide whether to continue — in the',
      'first case continuing is right, in the second it just hits the loop again.',
      '',
      '`visited` is a Set rather than a comparison against the previous URL. A loop need not be a self-loop:',
      'a server can return A → B → A, which comparing only the previous one never detects. The Set costs',
      'memory proportional to page count, which `maxPages` already bounds.',
      '',
      'In the loop condition `pages < options.maxPages` comes before the request, so `maxPages: 0` issues',
      'nothing rather than sending one and then noticing. Passing zero usually means the caller wants',
      'nothing done, and honouring that intent is more useful than throwing an argument error.',
      '',
      'There is no concurrency in this stage. Nine stages spent effort raising parallelism and the right',
      'answer here is a plain `while` with an `await`. Recognising that something cannot be parallelised',
      'matters as much as knowing how to parallelise — forcing concurrency in here only introduces',
      'cursor-guessing bugs.',
    ].join('\n')
  ),
};

const stage11 = {
  id: 'pipeline',
  title: t('第 11 关 · 收敛为可运维的组件', 'Stage 11 · Ship an operable component'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '最后一段路不加新功能，而是把前面十关的能力收进一个**有边界的组件**。',
      '散在模块里的函数不能上线：它们共享模块级状态，没法取消，也说不出自己的状态。',
      '',
      '## 要实现什么',
      '',
      '在 `src/pipeline.ts` 实现 `createPipeline(options)`，返回：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `run(urls)` | 执行抓取，语义等价于带全部选项的 `fetchAll` |',
      '| `stats()` | 返回 `{ completed, failed, cacheHits }` 的**副本** |',
      '',
      '三条约束：',
      '',
      '- **每个实例持有自己的缓存**和单飞登记表，不要用模块级单例；',
      '- 支持 `options.signal` 取消：取消后不再发起新请求，已在飞的可以跑完；',
      '- 用 `@lab/metrics` 的 `count()` 打点 `pipeline.completed` / `pipeline.failed`。',
      '',
      '## 怎么算过',
      '',
      '- 组合之后并发仍然受控（门槛 `maxConcurrency ≤ 4`）；',
      '- 整条管线在 520ms 内跑完（门槛 `virtualElapsedMs ≤ 520`）；',
      '- 取消之后不再放大请求（门槛 `requests.total ≤ 6`）；',
      '- 两个实例互不共享缓存；',
      '- `stats()` 返回副本，调用方改不动内部状态。',
      '',
      '## 为什么「实例自己的缓存」是硬性要求',
      '',
      '模块级单例的缓存意味着：测试之间会互相污染，',
      '两个用不同 `ttlMs` 配置的 pipeline 会互相覆盖对方的条目，',
      '而且你没有任何办法把它清掉 —— 因为没有人持有它。',
      '',
      '这不是洁癖。一个能创建多份、能取消、能报告自己状态的组件，',
      '才有可能被安心地放上线：出问题时你可以换一个实例，可以取消它，',
      '可以看它现在到底做成了多少。',
      '',
      '## 取消的语义要说清楚',
      '',
      '「取消」不等于「立刻中止」。已经在飞的请求，你没有办法真的把它撤回来 ——',
      '所以约定是：**取消后不再发起新请求**，在飞的自己跑完。',
      '这个约定既诚实又可实现，而且门槛 `requests.total ≤ 6` 量的正是它：',
      '取消之后请求总数不再增长。',
      '',
      '检查点放在 `fetchOne` 的**入口**：并发池里的 worker 每取一个新任务都会走到这里，',
      '于是取消能在下一个任务边界立刻生效，不需要中断任何正在进行的事。',
    ].join('\n'),
    [
      'The last stretch adds no features. It puts a **boundary** around everything the previous ten stages',
      'built. Functions scattered across modules cannot go to production: they share module-level state,',
      'cannot be cancelled, and cannot report what they are doing.',
      '',
      '## What to build',
      '',
      '`createPipeline(options)` in `src/pipeline.ts`, returning:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `run(urls)` | Fetches, semantically equal to `fetchAll` with every option |',
      '| `stats()` | A **copy** of `{ completed, failed, cacheHits }` |',
      '',
      'Three constraints:',
      '',
      '- **Every instance owns its cache** and single-flight table — no module-level singletons;',
      '- Cancellation via `options.signal`: once cancelled, start no new requests (in-flight ones may finish);',
      '- Emit `pipeline.completed` / `pipeline.failed` through `count()` from `@lab/metrics`.',
      '',
      '## What counts as passing',
      '',
      '- Concurrency stays controlled after composition (`maxConcurrency ≤ 4`);',
      '- The whole pipeline finishes within 520ms (`virtualElapsedMs ≤ 520`);',
      '- Cancellation stops request growth (`requests.total ≤ 6`);',
      '- Two instances share no cache;',
      '- `stats()` returns a copy the caller cannot mutate.',
      '',
      '## Why per-instance caching is a hard requirement',
      '',
      'A module-level singleton cache means tests contaminate each other, two pipelines configured with',
      'different `ttlMs` overwrite each other\'s entries, and you have no way to clear it — because nobody',
      'holds it.',
      '',
      'This is not fastidiousness. A component you can instantiate twice, cancel, and ask for its state is',
      'one you can put into production without worrying: when something goes wrong you can swap in a fresh',
      'instance, cancel it, and see how much it actually completed.',
      '',
      '## Be precise about what cancellation means',
      '',
      'Cancelling is not aborting. A request already in flight cannot truly be recalled — so the contract is:',
      '**start no new requests after cancellation**, and let the in-flight ones finish. That contract is both',
      'honest and implementable, and the `requests.total ≤ 6` gate measures exactly it: the request count',
      'stops growing once cancelled.',
      '',
      'Put the check at the **entrance** of `fetchOne`: every worker in the pool passes through it when',
      'claiming a new task, so cancellation takes effect at the next task boundary without interrupting',
      'anything already underway.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**组件边界** —— 状态属于实例，不属于模块',
      '',
      '```mermaid',
      'flowchart TD',
      '  CP["createPipeline(options)"] --> OWN["这个实例自己的状态：<br/>cache、singleFlight 登记表、stats<br/>没有任何模块级单例"]',
      '  OWN --> RUN["run(urls)"]',
      '  RUN --> POOL["mapWithConcurrency(urls, concurrency, fetchOne)<br/>第 2 关的取号式池子，并发上限在这里"]',
      '  POOL --> TALLY["逐条结果记账：<br/>ok → completed++ 且 count(\'pipeline.completed\')<br/>否则 failed++ 且 count(\'pipeline.failed\')"]',
      '  TALLY --> RET["返回结果数组"]',
      '  OWN --> ST["stats() 返回 { ...stats } 副本"]',
      '```',
      '',
      '**每个 URL 走的那条链** —— 几乎每一层都是前面某一关的产物',
      '',
      '```mermaid',
      'flowchart TD',
      '  C{"signal.cancelled？<br/>检查点在 fetchOne 入口"}',
      '  C -- 已取消 --> CAN["{ ok: false, error: \'cancelled\' }<br/>不发新请求；在飞的自己跑完"]',
      '  C -- 没取消 --> CH{"开了 ttlMs 且缓存命中？"}',
      '  CH -- 命中 --> HIT["cacheHits += 1，直接返回"]',
      '  CH -- 未命中 --> SF["singleFlight(url, loader) —— 第 7 关"]',
      '  SF --> LD["load(url)：withRetry + request —— 第 4 关<br/>失败在这里被 catch 成 PageResult —— 第 1 关"]',
      '  LD --> SET["成功且开了 ttlMs → cache.set"]',
      '```',
      '',
      '要点：这一关做的事只有一件 —— 把前面十关的零件**装进一个实例**，让状态有主人。',
      '',
      '`C` 放在 `fetchOne` 的入口而不是 `run` 的开头，是取消语义能成立的原因：',
      '池子里的 worker 每取一个新任务都会重新经过它，',
      '所以取消在下一个任务边界生效，而不需要打断任何在飞的请求。',
    ].join('\n'),
    [
      '**The component boundary** — state belongs to the instance, not the module',
      '',
      '```mermaid',
      'flowchart TD',
      '  CP["createPipeline(options)"] --> OWN["this instance\'s own state:<br/>cache, single-flight table, stats<br/>no module-level singletons anywhere"]',
      '  OWN --> RUN["run(urls)"]',
      '  RUN --> POOL["mapWithConcurrency(urls, concurrency, fetchOne)<br/>the pull-based pool from stage 2; the ceiling lives here"]',
      '  POOL --> TALLY["tally each result:<br/>ok → completed++ and count(\'pipeline.completed\')<br/>otherwise failed++ and count(\'pipeline.failed\')"]',
      '  TALLY --> RET["return the results array"]',
      '  OWN --> ST["stats() returns a { ...stats } copy"]',
      '```',
      '',
      '**The chain every URL takes** — nearly every layer is the product of an earlier stage',
      '',
      '```mermaid',
      'flowchart TD',
      '  C{"signal.cancelled?<br/>the check sits at fetchOne\'s entrance"}',
      '  C -- cancelled --> CAN["{ ok: false, error: \'cancelled\' }<br/>no new request; in-flight ones finish"]',
      '  C -- "not cancelled" --> CH{"ttlMs set and cache hit?"}',
      '  CH -- hit --> HIT["cacheHits += 1, return it"]',
      '  CH -- miss --> SF["singleFlight(url, loader) — stage 7"]',
      '  SF --> LD["load(url): withRetry + request — stage 4<br/>failure is caught into a PageResult here — stage 1"]',
      '  LD --> SET["on success with ttlMs set → cache.set"]',
      '```',
      '',
      'The point: this stage does exactly one thing — it puts the previous ten stages\' parts **inside an',
      'instance** so the state has an owner.',
      '',
      '`C` sitting at `fetchOne`\'s entrance rather than the top of `run` is what makes the cancellation',
      'semantics work: every worker passes through it when claiming a new task, so cancellation takes effect',
      'at the next task boundary without interrupting anything in flight.',
    ].join('\n')
  ),
  checklist: [
    t('两个实例的缓存互不影响', 'Two instances have independent caches'),
    t('取消后不再发起新请求', 'No new requests start after cancellation'),
    t('stats() 如实反映成功/失败/缓存命中', 'stats() reflects success, failure and cache hits'),
    t('埋点计数写入 @lab/metrics', 'Counters are emitted through @lab/metrics'),
  ],
  pitfalls: [
    t(
      '缓存留在模块顶层：能过第 4 关，但两个 pipeline 实例会共享同一份缓存。测试之间互相污染，多租户场景下甚至会串数据。这是真实的安全问题，不是洁癖。',
      'Leaving the cache at module scope passes stage 4, but two pipelines then share one cache: tests pollute each other and, in a multi-tenant setting, data leaks across tenants. That is a security bug, not a style issue.'
    ),
    t(
      '只在 run() 开始时检查一次取消：那样取消只能阻止「还没开始的整批」，已经在队列里的 11 个任务照样会全部发出去。检查要放在每个任务取号之后。',
      'Checking cancellation once at the start of run() only stops a batch that has not begun; the 11 queued tasks still fire. The check belongs right after a worker picks up a task.'
    ),
    t(
      '`stats()` 返回内部对象等于把计数器的引用交了出去。返回副本。',
      '`stats()` returning the internal object hands out a live reference to your counters. Return a copy.'
    ),
    t(
      '取消后让 run() 抛异常：调用方已经拿到的部分结果就全丢了。取消是预期内的结束方式，应该正常返回已有结果。',
      'Throwing from run() on cancellation discards the partial results the caller already earned. Cancellation is an expected ending, return what you have.'
    ),
  ],
  hints: [
    t(
      '把 cache / singleFlight 从模块顶层挪进 createPipeline 的闭包里，就自然获得了实例隔离。',
      'Move cache / singleFlight from module scope into the createPipeline closure and instances become isolated for free.'
    ),
    t(
      '取消检查放在 worker 取任务之后、发起请求之前：signal.cancelled 为真就直接返回一条失败结果。',
      'Check cancellation after a worker picks a task and before issuing the request: if cancelled, return a failed result immediately.'
    ),
  ],
  extension: t(
    [
      '这一关的三个要求，对应三个更大的话题：',
      '',
      '1. 实例化而非单例。模块级状态本质上还是全局变量，只是看起来体面一点。',
      '一旦有了它，你就无法在同一个进程里跑两份配置，也无法在测试之间隔离。',
      '依赖注入之所以流行，本质上是为了让「谁持有状态」变成显式的。',
      '',
      '2. 取消（cancellation）。浏览器有 `AbortController`，Go 有 `context.Context`，',
      'Rust 有 `CancellationToken`，.NET 有 `CancellationToken`。共同点是：',
      '取消信号沿调用链**向下传递**，每一层在自己的检查点上自愿退出。',
      '没有哪个语言允许你强杀一个协程，因为那样无法保证资源被正确释放。',
      '',
      '3. 可观测性。`stats()` 是最朴素的形式，真实系统会把它换成',
      'Prometheus 指标（counter / histogram）或 OpenTelemetry span。判断标准是：',
      '线上出问题时，能不能只靠这些数字定位到哪一层慢了、哪一层在失败？',
      '',
      '延伸阅读：结构化并发（structured concurrency），它主张「任务的生命周期不应该超出',
      '创建它的作用域」，Kotlin 的 `coroutineScope`、Swift 的 `TaskGroup`、Java 21 的',
      '`StructuredTaskScope` 都是这个思路。你这一关写的 pipeline 已经很接近了。',
    ].join('\n'),
    [
      'The three requirements here map onto three larger topics:',
      '',
      '1. Instances, not singletons, module-level state is a global variable with better manners.',
      'Once you have it you cannot run two configurations in one process, or isolate tests.',
      'Dependency injection is popular largely because it makes "who owns this state" explicit.',
      '',
      '2. Cancellation, browsers have `AbortController`, Go has `context.Context`, Rust and .NET',
      'have `CancellationToken`. They all share one shape: the signal propagates **down** the call',
      'chain and each layer opts out at its own checkpoints. No language lets you kill a coroutine',
      'outright, because that cannot guarantee resources are released.',
      '',
      '3. Observability, `stats()` is the crudest form. Real systems replace it with Prometheus',
      'counters/histograms or OpenTelemetry spans. The test: **during an incident, can these numbers',
      'alone tell you which layer is slow and which is failing?**',
      '',
      'Further reading: structured concurrency, the idea that a task must not outlive the scope that',
      'created it. Kotlin\'s `coroutineScope`, Swift\'s `TaskGroup` and Java 21\'s `StructuredTaskScope`',
      'all follow it, and the pipeline you just built is close to the same shape.',
    ].join('\n')
  ),
  focus: ['encapsulation', 'elegance', 'concurrency'],
  lab: {
    defaultLatencyMs: 100,
    serverConcurrencyLimit: 5,
    endpoints: {
      '/api/pages/flaky': { failFirstN: 1, status: 503 },
    },
  },
  starterFiles: [
    cancelSupport,
    file(
      'src/pipeline.ts',
      code`
        import type { CancelToken, FetchOptions, PageResult } from './contract';

        export interface PipelineStats {
          completed: number;
          failed: number;
          cacheHits: number;
        }

        export interface Pipeline {
          run(urls: string[]): Promise<PageResult[]>;
          stats(): PipelineStats;
        }

        export interface PipelineOptions extends FetchOptions {
          signal?: CancelToken;
        }

        /**
         * Assemble the first four stages into one stateful, cancellable, observable component.
         * Every instance must have its own cache.
         */
        export function createPipeline(options: PipelineOptions = {}): Pipeline {
          // TODO: implement this
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
        import { createPipeline } from '../src/pipeline';
        import { createCancelSource } from '../src/support/cancel';
        import { getMetrics } from '@lab/net';
        import { getCounters } from '@lab/metrics';
        import { sleep } from '@lab/env';

        const urls = Array.from({ length: 12 }, (_, index) => '/api/pages/' + index);

        describe('Stage 11 · Converging into a component', () => {
          it('combines the capabilities: concurrency + retries + caching [gate:pipeline]', async () => {
            const pipeline = createPipeline({ concurrency: 4, retries: 2, baseDelayMs: 20, ttlMs: 1000 });
            const results = await pipeline.run(urls.concat(['/api/pages/flaky', '/api/pages/0']));
            expect(results).toHaveLength(14);
            expect(results.every((item) => item.ok)).toBe(true);

            const metrics = getMetrics();
            expect(metrics.maxConcurrency).toBeLessThanOrEqual(4);
            expect(metrics.requests.throttled).toBe(0);
            expect(pipeline.stats().completed).toBe(14);
          });

          it('caches are isolated between instances', async () => {
            const first = createPipeline({ ttlMs: 1000 });
            const second = createPipeline({ ttlMs: 1000 });
            await first.run(['/api/shared']);
            await second.run(['/api/shared']);
            expect(getMetrics().requests.total).toBe(2);
          });

          it('the cache hits within one instance', async () => {
            const pipeline = createPipeline({ ttlMs: 1000 });
            await pipeline.run(['/api/shared']);
            await pipeline.run(['/api/shared']);
            expect(getMetrics().requests.total).toBe(1);
            expect(pipeline.stats().cacheHits).toBe(1);
          });

          it('no new requests are issued after cancelling [gate:cancel]', async () => {
            const source = createCancelSource();
            const pipeline = createPipeline({ concurrency: 2, signal: source.token });
            const running = pipeline.run(urls);
            await sleep(150);
            source.cancel();
            const results = await running;

            expect(results).toHaveLength(12);
            const metrics = getMetrics();
            expect(metrics.requests.total).toBeLessThanOrEqual(6);
            expect(results.some((item) => !item.ok)).toBe(true);
          });

          it('instrumentation is written to metrics', async () => {
            const pipeline = createPipeline({ concurrency: 4 });
            await pipeline.run(['/api/pages/1', '/api/pages/2']);
            const counters = getCounters();
            expect(counters['pipeline.completed']).toBe(2);
          });

          it('stats() returns a copy that callers cannot use to change the internal counters', async () => {
            const pipeline = createPipeline({ concurrency: 2 });
            await pipeline.run(['/api/pages/1']);

            const snapshot = pipeline.stats();
            snapshot.completed = 999;
            expect(pipeline.stats().completed).toBe(1);
          });

          it('run still returns normally after cancellation rather than throwing', async () => {
            const source = createCancelSource();
            const pipeline = createPipeline({ concurrency: 2, signal: source.token });
            source.cancel();

            const results = await pipeline.run(['/api/pages/1', '/api/pages/2']);
            expect(results).toHaveLength(2);
            expect(results.every((item) => !item.ok)).toBe(true);
            expect(getMetrics().requests.total).toBe(0);
          });

          it('the stats of two instances do not interfere', async () => {
            const first = createPipeline({ concurrency: 2 });
            const second = createPipeline({ concurrency: 2 });

            await first.run(['/api/pages/1', '/api/pages/2']);
            await second.run(['/api/pages/3']);

            expect(first.stats().completed).toBe(2);
            expect(second.stats().completed).toBe(1);
          });

          it('a failed URL counts towards failed, not completed', async () => {
            const pipeline = createPipeline({ concurrency: 2 });
            const results = await pipeline.run(['/api/pages/1', '/api/pages/flaky']);

            // flaky always fails the first time, and retries are off here
            expect(results.filter((item) => item.ok)).toHaveLength(1);
            expect(pipeline.stats().completed).toBe(1);
            expect(pipeline.stats().failed).toBe(1);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'maxConcurrency',
      op: 'lte',
      value: 4,
      zh: '组合后并发仍然受控',
      en: 'Concurrency stays bounded',
      dimension: 'concurrency',
      scope: 'gate:pipeline',
    }),
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 520,
      unit: 'ms',
      zh: '整条管线 ≤ 520ms',
      en: 'Whole pipeline within 520ms',
      dimension: 'latency',
      scope: 'gate:pipeline',
    }),
    gate({
      metric: 'requests.total',
      op: 'lte',
      value: 6,
      zh: '取消后不再放大请求',
      en: 'Cancellation stops new requests',
      dimension: 'resilience',
      scope: 'gate:cancel',
    }),
  ],
  referenceFiles: [
    file(
      'src/pipeline.ts',
      code`
        import { count } from '@lab/metrics';
        import { mapWithConcurrency } from './pool';
        import { createCache, createSingleFlight } from './cache';
        import { withRetry } from './retry';
        import { request } from '@lab/net';
        import type { CancelToken, FetchOptions, PageResult } from './contract';

        export interface PipelineStats {
          completed: number;
          failed: number;
          cacheHits: number;
        }

        export interface Pipeline {
          run(urls: string[]): Promise<PageResult[]>;
          stats(): PipelineStats;
        }

        export interface PipelineOptions extends FetchOptions {
          signal?: CancelToken;
        }

        const RETRYABLE_STATUS = [408, 429, 500, 502, 503, 504];

        function isRetryable(error: unknown): boolean {
          const status = (error as { status?: number }).status;
          return status === undefined || RETRYABLE_STATUS.indexOf(status) !== -1;
        }

        export function createPipeline(options: PipelineOptions = {}): Pipeline {
          // Each instance holds its own cache and single-flight registry, so two of them can be created safely
          const cache = createCache<PageResult>({ ttlMs: options.ttlMs, maxSize: 500 });
          const singleFlight = createSingleFlight();
          const stats: PipelineStats = { completed: 0, failed: 0, cacheHits: 0 };

          async function load(url: string): Promise<PageResult> {
            const run = () => request(url);
            try {
              const response = options.retries
                ? await withRetry(run, {
                    retries: options.retries,
                    baseDelayMs: options.baseDelayMs ?? 50,
                    isRetryable,
                  })
                : await run();
              return { url, ok: true, data: response.data };
            } catch (error) {
              return { url, ok: false, data: null, error: (error as Error).message };
            }
          }

          async function fetchOne(url: string): Promise<PageResult> {
            if (options.signal && options.signal.cancelled) {
              return { url, ok: false, data: null, error: 'cancelled' };
            }

            if (options.ttlMs) {
              const cached = cache.get(url);
              if (cached) {
                stats.cacheHits += 1;
                return cached;
              }
            }

            const result = await singleFlight(url, async () => {
              const loaded = await load(url);
              if (loaded.ok && options.ttlMs) cache.set(url, loaded);
              return loaded;
            });

            return result;
          }

          return {
            async run(urls: string[]): Promise<PageResult[]> {
              const concurrency = options.concurrency && options.concurrency > 0 ? options.concurrency : 1;
              const results = await mapWithConcurrency(urls, concurrency, (url) => fetchOne(url));

              for (const result of results) {
                if (result.ok) {
                  stats.completed += 1;
                  count('pipeline.completed');
                } else {
                  stats.failed += 1;
                  count('pipeline.failed');
                }
              }

              return results;
            },
            stats() {
              return { ...stats };
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    '所有状态都进了闭包：缓存、单飞、统计。外部只看到 run 与 stats 两个入口，这就是「封装」在工程上的具体含义。',
    'All state lives in the closure: cache, single-flight, counters. The outside world sees only run and stats, that is what encapsulation buys you.'
  ),
};

/* ------------------------------------------------------------------ */

const stage12 = {
  id: 'observability',
  title: t('第 12 关 · 指标与慢请求归因', 'Stage 12 · Metrics and attributing slowness'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前十一关把管线做对了。这一关回答另一个问题：**它现在到底在干什么？**',
      '',
      '线上出问题时，「平均延迟 120ms」这句话几乎没有任何用处 ——',
      '它可能是所有请求都 120ms，也可能是 99% 的请求 20ms、1% 的请求 10 秒。',
      '你要的是**分位数**，以及**慢的是哪一个**。',
      '',
      '## 要实现什么',
      '',
      '在 `src/telemetry.ts` 实现两样东西。',
      '',
      '**`createHistogram(boundaries)`** —— 分桶直方图：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `observe(value)` | 记一次观测 |',
      '| `count()` / `sum()` | 观测次数、总和 |',
      '| `quantile(q)` | 分位数，在命中的那个桶里**线性插值** |',
      '| `size()` | 内部占用的统计槽数量 |',
      '',
      '**`createTracer()`** —— 计时与归因：`span(name)` 返回一个 `{ end() }`，',
      '记录这段耗时；`spans()` 列出全部，`slowest()` 给出最慢的那个。',
      '',
      '## 怎么算过',
      '',
      '- 观测一万次之后 `size()` 不超过桶数（门槛 `counters.histogramSlots ≤ 6`）；',
      '- `quantile` 在桶内插值，同一个桶里的 p10 和 p90 不相等；',
      '- 落在 `+Inf` 桶时退回最后一个有限边界，不返回 `Infinity`；',
      '- 同一个 span 调两次 `end()` 只记一条；',
      '- 并行的 span 各记各的，互不覆盖。',
      '',
      '## 唯一的门槛，也是这一关存在的理由',
      '',
      '把每个样本都存下来再排序取分位数，是最直观的实现，也是最危险的：',
      '**内存随观测数线性增长**，一个高 QPS 的接口能在几分钟内把进程撑爆。',
      '',
      '监控组件把被监控的系统搞垮，是运维事故里相当经典的一类 ——',
      '而且它总是在流量最高的时候发作，也就是你最需要监控的时候。',
      '',
      '分桶的代价是精度：你不再知道确切的 p99，只知道它落在哪个桶里。',
      '桶内线性插值是对这个损失的补偿 —— 直接返回桶的上界的话，',
      '同一个桶里的 p10 和 p90 会是同一个数，分位数就退化成了「桶的名字」。',
      '',
      '## 归因比数字更重要',
      '',
      '直方图告诉你「有 1% 的请求很慢」，`slowest()` 告诉你**慢的是哪一个**。',
      '前者让你知道有问题，后者才让你能动手。',
      '',
      '`span` 的起止时刻存在闭包里，所以并行的 span 各有各的一份 ——',
      '把 `startedAt` 提到 tracer 层面共享，并发场景下的计时会互相覆盖，',
      '测出来的每一个数字都是错的。',
    ].join('\n'),
    [
      'Eleven stages made the pipeline correct. This one answers a different question: **what is it actually',
      'doing right now?**',
      '',
      'When something breaks in production, "average latency 120ms" is nearly useless — it could mean every',
      'request takes 120ms, or that 99% take 20ms and 1% take ten seconds. What you need is **percentiles**,',
      'and **which one** was slow.',
      '',
      '## What to build',
      '',
      'Two things in `src/telemetry.ts`.',
      '',
      '**`createHistogram(boundaries)`** — a bucketed histogram:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `observe(value)` | Record one observation |',
      '| `count()` / `sum()` | Observation count and total |',
      '| `quantile(q)` | The percentile, **interpolated linearly** inside the bucket it lands in |',
      '| `size()` | How many internal slots it occupies |',
      '',
      '**`createTracer()`** — timing and attribution: `span(name)` returns `{ end() }` recording that',
      'duration; `spans()` lists them all and `slowest()` gives the worst.',
      '',
      '## What counts as passing',
      '',
      '- After ten thousand observations `size()` does not exceed the bucket count',
      '  (`counters.histogramSlots ≤ 6`);',
      '- `quantile` interpolates within a bucket, so p10 and p90 inside one bucket differ;',
      '- Landing in the `+Inf` bucket falls back to the last finite boundary rather than returning `Infinity`;',
      '- Calling `end()` twice on one span records one entry;',
      '- Parallel spans record independently without overwriting each other.',
      '',
      '## The single gate is the reason this stage exists',
      '',
      'Storing every sample and sorting to find a percentile is the most obvious implementation and the most',
      'dangerous: **memory grows linearly with observations**, and a high-QPS endpoint can exhaust the',
      'process in minutes.',
      '',
      'Monitoring that takes down the system it monitors is a classic incident — and it always strikes at',
      'peak traffic, which is exactly when you needed the monitoring.',
      '',
      'Bucketing costs precision: you no longer know the exact p99, only which bucket it fell into.',
      'Interpolating within the bucket compensates for that loss — return the bucket\'s upper bound directly',
      'and p10 and p90 inside one bucket become the same number, degrading the percentile into "the name of a',
      'bucket".',
      '',
      '## Attribution matters more than the number',
      '',
      'The histogram tells you 1% of requests are slow; `slowest()` tells you **which one**. The first tells',
      'you there is a problem, the second lets you act.',
      '',
      'A span\'s start time lives in its closure, so parallel spans each keep their own — hoist `startedAt` up',
      'to the tracer and concurrent timings overwrite each other, making every number you measure wrong.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '两个组件互不依赖，分开看。',
      '',
      '**`createHistogram(boundaries)`** —— 内存与观测数无关',
      '',
      '```mermaid',
      'flowchart TD',
      '  H0["状态：counts（桶数 + 1 个计数器，最后一个是 +Inf 桶）<br/>加上 total、totalSum 两个标量"]',
      '  OB["observe(value)"] --> BF["bucketFor(value)<br/>找第一个 value ≤ 边界的桶"]',
      '  BF --> INC["counts[i] += 1<br/>total += 1，totalSum += value<br/>只加计数器，不存样本"]',
      '  Q["quantile(q)"] --> T["target = q × total"]',
      '  T --> SCAN["从头累加 counts<br/>找 target 落在哪个桶"]',
      '  SCAN --> INF{"落在 +Inf 桶？"}',
      '  INF -- 是 --> LAST["返回最后一个有限边界<br/>它没有上界，插不了值"]',
      '  INF -- 否 --> INTERP["桶内线性插值<br/>lower + (upper - lower) × 桶内相对位置"]',
      '```',
      '',
      '`INC` 是整关的题眼：观测一万次也只是让几个计数器变大，`counts` 的长度自始至终不变，',
      '门槛量的 `size()` 就是这个长度。`INTERP` 换成「直接返回 upper」，',
      '同一个桶里的 p10 和 p90 就会相等，分位数退化成「桶的名字」。',
      '',
      '**`createTracer()`** —— 把「慢」归因到具体的名字',
      '',
      '```mermaid',
      'flowchart TD',
      '  SP["span(name)"] --> CLOSE["startedAt 存在这个闭包里<br/>并行的 span 各有各的一份"]',
      '  CLOSE --> END["end()<br/>ended 标记防重复<br/>records.push({ name, durationMs })"]',
      '  END --> SL["slowest()：reduce 取 durationMs 最大的"]',
      '  END --> SPS["spans()：返回副本"]',
      '```',
      '',
      '把 `startedAt` 提到 tracer 层面共享，并发场景下的计时会互相覆盖 ——',
      '测出来的每一个数字都是错的。',
    ].join('\n'),
    [
      'The two components are independent, so look at them separately.',
      '',
      '**`createHistogram(boundaries)`** — memory independent of observation count',
      '',
      '```mermaid',
      'flowchart TD',
      '  H0["state: counts (bucket count + 1, the last being +Inf)<br/>plus the scalars total and totalSum"]',
      '  OB["observe(value)"] --> BF["bucketFor(value)<br/>the first bucket whose bound is ≥ value"]',
      '  BF --> INC["counts[i] += 1<br/>total += 1, totalSum += value<br/>counters only, samples are never stored"]',
      '  Q["quantile(q)"] --> T["target = q × total"]',
      '  T --> SCAN["accumulate counts from the start<br/>to find target\'s bucket"]',
      '  SCAN --> INF{"landed in the +Inf bucket?"}',
      '  INF -- yes --> LAST["return the last finite boundary<br/>there is no upper bound to interpolate against"]',
      '  INF -- no --> INTERP["interpolate within the bucket<br/>lower + (upper - lower) × relative position"]',
      '```',
      '',
      '`INC` is the crux: ten thousand observations only make a few counters larger, `counts` never changes',
      'length, and that length is what the `size()` gate measures. Replace `INTERP` with "just return upper"',
      'and p10 and p90 inside one bucket become equal, degrading the percentile into the name of a bucket.',
      '',
      '**`createTracer()`** — attributing slowness to a name',
      '',
      '```mermaid',
      'flowchart TD',
      '  SP["span(name)"] --> CLOSE["startedAt lives in this closure<br/>parallel spans each keep their own"]',
      '  CLOSE --> END["end()<br/>an ended flag prevents double recording<br/>records.push({ name, durationMs })"]',
      '  END --> SL["slowest(): reduce to the largest durationMs"]',
      '  END --> SPS["spans(): return a copy"]',
      '```',
      '',
      'Hoist `startedAt` up to the tracer and concurrent timings overwrite each other, making every number',
      'you measure wrong.',
    ].join('\n')
  ),
  checklist: [
    t('count / sum 正确', 'count and sum are correct'),
    t('quantile 在桶内线性插值', 'quantile interpolates within its bucket'),
    t('内存不随观测数增长', 'Memory does not grow with the number of observations'),
    t('span 记录的是虚拟时钟的真实耗时', 'A span records real elapsed time on the virtual clock'),
    t('slowest 指出耗时最长的那一段', 'slowest names the longest segment'),
  ],
  pitfalls: [
    t(
      '把所有样本存进数组，`quantile` 时排序取下标。数学上最准，工程上不能用：内存和观测数成正比，排序还是 O(n log n)。一个每秒一万请求的服务跑十分钟，这个数组里就有六百万个数字——监控组件本身成了最大的内存消费者。',
      'Storing every sample in an array and sorting on `quantile`. Mathematically exact and operationally unusable: memory is proportional to observations and each query is O(n log n). Ten minutes at ten thousand requests per second leaves six million numbers in that array, making the monitoring the largest memory consumer in the process.'
    ),
    t(
      '用「保留最近 N 个样本」的环形缓冲代替全量存储。内存确实有界了，但分位数变成了「最近 N 个请求的分位数」——流量一大，N 个样本可能只覆盖最近几百毫秒，算出来的 p99 会剧烈抖动。分桶直方图的计数是**累积**的，不会有这个问题。',
      'Replacing full storage with a ring buffer of the last N samples. Memory is bounded and the percentile becomes "the percentile of the last N requests" — under high traffic those N may span only a few hundred milliseconds, and the computed p99 oscillates wildly. Bucketed counts are cumulative and do not have this problem.'
    ),
    t(
      '`quantile` 直接返回命中桶的上边界。这是最粗糙的近似：所有落在 [100, 500) 里的值，p50 和 p99 都会返回 500。桶内线性插值虽然假设了桶内均匀分布（这个假设并不总成立），但至少能区分桶内的不同位置。Prometheus 的 `histogram_quantile` 用的就是这个插值。',
      'Returning the upper bound of the matching bucket from `quantile`. That is the crudest approximation: every value in [100, 500) yields 500 for both p50 and p99. Linear interpolation inside the bucket assumes uniformity within it — not always true — but at least distinguishes positions within a bucket. It is what Prometheus histogram_quantile does.'
    ),
    t(
      '`span(name).end()` 用 `Date.now()` 计时。在这个环境里 `Date` 被虚拟时钟接管了，所以能跑；但真实代码里用挂钟计时会被 NTP 校时、闰秒、甚至用户改系统时间影响，出现负的耗时。计时应该用单调时钟（`performance.now()`），它只保证「一直往前走」，不保证对应任何真实时刻。',
      'Timing with `Date.now()`. It works here because `Date` is driven by the virtual clock, but in real code wall-clock timing is disturbed by NTP steps, leap seconds and users changing the system time, producing negative durations. Timing wants a monotonic clock, which only promises to move forward and corresponds to no real instant.'
    ),
  ],
  hints: [
    t(
      '桶用「上边界数组 + 计数数组」表示，最后再加一个 +Inf 桶装超出所有边界的值。`observe` 就是找到第一个 `value <= boundary` 的下标然后计数加一。',
      'Represent buckets as an array of upper bounds plus an array of counts, with one extra +Inf bucket for values beyond every boundary. `observe` finds the first index where `value <= boundary` and increments.'
    ),
    t(
      'quantile 先算目标位次 `q * count`，然后从低到高累加计数，找到跨过这个位次的桶，在这个桶的 [下边界, 上边界] 之间按剩余比例插值。',
      'For quantile, compute the target rank `q * count`, accumulate counts from the lowest bucket until the rank is crossed, then interpolate between that bucket lower and upper bound by the leftover fraction.'
    ),
  ],
  extension: t(
    [
      '分桶直方图的代价是**桶边界要提前定**。定得不好，全部样本落进同一个桶，',
      '分位数就退化成了「桶宽」级别的粗糙估计。这也是 Prometheus 用得最痛的地方——',
      '换桶边界需要改代码重新发布，而且历史数据没法重新分桶。',
      '',
      '解法之一是 **HDR Histogram**：桶宽随值指数增长（小值密、大值疏），',
      '用固定的相对精度（比如「误差不超过 1%」）覆盖从 1 微秒到 1 小时的全量程，',
      '内存仍然是常数级。另一条路是 **t-digest** 和 **DDSketch**：',
      '前者在分布两端保留更高精度（正好是分位数最需要精度的地方），',
      '后者保证相对误差有上界，而且**可合并**——多台机器的直方图能直接相加，',
      '这在分布式系统里是刚需（你要的是全集群的 p99，不是每台机器 p99 的平均）。',
      '',
      '顺带一提：**p99 的平均值没有任何意义**。十台机器各自的 p99 取平均，',
      '既不是集群的 p99，也不是任何一个可解释的量。要算集群 p99，',
      '必须把原始分布合并之后再算分位数——这就是可合并性为什么重要。',
      '',
      '至于 span，这一关做的是最简单的平铺记录。真实的分布式追踪（OpenTelemetry）',
      '还要处理父子关系、跨进程传播（trace context 通过 HTTP 头传递）、',
      '以及采样——全量记录 span 的成本通常比业务本身还高，',
      '所以线上一般只采 1% 左右，代价是低频的慢请求可能永远采不到。',
    ].join('\n'),
    [
      'Bucketed histograms cost you having to choose boundaries in advance. Choose badly and every sample',
      'lands in one bucket, degrading percentiles to bucket-width guesses. This is the sorest spot in',
      'Prometheus: changing boundaries means a code change and a redeploy, and historical data cannot be',
      're-bucketed.',
      '',
      'One answer is the HDR Histogram, where bucket width grows exponentially — dense at small values,',
      'sparse at large ones — covering microseconds to hours at fixed relative precision in constant',
      'memory. Another is t-digest and DDSketch: the former keeps higher precision at the distribution',
      'tails, exactly where percentiles need it, while the latter bounds relative error and is mergeable,',
      'so histograms from many machines add together. That is essential in distributed systems, where you',
      'want the cluster p99 rather than the average of per-machine p99s.',
      '',
      'Which is worth stating plainly: averaging p99s is meaningless. The mean of ten machines p99 values',
      'is neither the cluster p99 nor any interpretable quantity. Computing a cluster p99 requires merging',
      'the raw distributions first — which is why mergeability matters.',
      '',
      'As for spans, this stage records a flat list. Real distributed tracing (OpenTelemetry) adds',
      'parent-child structure, cross-process propagation via trace context in HTTP headers, and sampling —',
      'recording every span usually costs more than the work being traced, so production typically samples',
      'around 1%, at the price of possibly never capturing a rare slow request.',
    ].join('\n')
  ),
  focus: ['encapsulation', 'elegance', 'latency'],
  lab: {
    defaultLatencyMs: 100,
    endpoints: {
      '/api/quick': { latencyMs: 40 },
      '/api/slow': { latencyMs: 700 },
    },
  },
  starterFiles: [
    file(
      'src/telemetry.ts',
      code`
        export interface Histogram {
          observe(value: number): void;
          count(): number;
          sum(): number;
          /** q is between 0 and 1, interpolated linearly within the bucket */
          quantile(q: number): number;
          /** How many stat slots are held internally; must be independent of the observation count */
          size(): number;
        }

        /** boundaries are ascending bucket upper bounds; values past the last one go into the +Inf bucket */
        export function createHistogram(boundaries: number[]): Histogram {
          // TODO: implement this
          throw new Error('not implemented');
        }

        export interface SpanRecord {
          name: string;
          durationMs: number;
        }

        export interface Tracer {
          span(name: string): { end(): void };
          spans(): SpanRecord[];
          /** The longest span, or null when nothing was recorded */
          slowest(): SpanRecord | null;
        }

        export function createTracer(): Tracer {
          // TODO: implement this
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
        import { createHistogram, createTracer } from '../src/telemetry';
        import { now, sleep } from '@lab/env';
        import { request } from '@lab/net';
        import { count } from '@lab/metrics';

        const BOUNDARIES = [10, 50, 100, 500, 1000];

        describe('Stage 12 · Histograms', () => {
          it('count and sum', () => {
            const histogram = createHistogram(BOUNDARIES);
            histogram.observe(5);
            histogram.observe(15);
            histogram.observe(25);

            expect(histogram.count()).toBe(3);
            expect(histogram.sum()).toBe(45);
          });

          it('an empty histogram has a count of 0', () => {
            const histogram = createHistogram(BOUNDARIES);
            expect(histogram.count()).toBe(0);
            expect(histogram.sum()).toBe(0);
          });

          it('quantiles land in the right bucket', () => {
            const histogram = createHistogram(BOUNDARIES);
            for (let index = 0; index < 90; index += 1) histogram.observe(5);
            for (let index = 0; index < 10; index += 1) histogram.observe(800);

            expect(histogram.quantile(0.5)).toBeLessThanOrEqual(10);
            expect(histogram.quantile(0.95)).toBeGreaterThan(500);
            expect(histogram.quantile(0.95)).toBeLessThanOrEqual(1000);
          });

          it('interpolates within the bucket rather than returning its upper bound', () => {
            const histogram = createHistogram([100, 200]);
            for (let index = 0; index < 100; index += 1) histogram.observe(150);

            const low = histogram.quantile(0.1);
            const high = histogram.quantile(0.9);
            expect(high).toBeGreaterThan(low);
            expect(low).toBeGreaterThanOrEqual(100);
            expect(high).toBeLessThanOrEqual(200);
          });

          it('when every value is the same the quantile is around that value', () => {
            const histogram = createHistogram(BOUNDARIES);
            for (let index = 0; index < 50; index += 1) histogram.observe(30);
            const median = histogram.quantile(0.5);
            expect(median).toBeGreaterThan(10);
            expect(median).toBeLessThanOrEqual(50);
          });

          it('values past every boundary go into the +Inf bucket', () => {
            const histogram = createHistogram([10, 50]);
            histogram.observe(9999);
            expect(histogram.count()).toBe(1);
            expect(histogram.sum()).toBe(9999);
            expect(histogram.quantile(0.99)).toBeGreaterThanOrEqual(50);
          });

          it('the boundary values of q = 0 and q = 1', () => {
            const histogram = createHistogram(BOUNDARIES);
            for (let index = 0; index < 10; index += 1) histogram.observe(30);
            expect(histogram.quantile(0)).toBeGreaterThanOrEqual(0);
            expect(histogram.quantile(1)).toBeLessThanOrEqual(1000);
          });

          it('memory does not grow with the observation count [gate:bounded-memory]', () => {
            const histogram = createHistogram(BOUNDARIES);
            const before = histogram.size();

            for (let index = 0; index < 10000; index += 1) {
              histogram.observe(index % 1200);
            }

            count('histogramSlots', histogram.size());
            expect(histogram.count()).toBe(10000);
            expect(histogram.size()).toBe(before);
            expect(histogram.size()).toBeLessThanOrEqual(BOUNDARIES.length + 1);
          });
        });

        describe('Stage 12 · Timing and attribution', () => {
          it('a span records the real elapsed time', async () => {
            const tracer = createTracer();
            const span = tracer.span('sleep-120');
            await sleep(120);
            span.end();

            expect(tracer.spans()).toHaveLength(1);
            expect(tracer.spans()[0].name).toBe('sleep-120');
            expect(tracer.spans()[0].durationMs).toBe(120);
          });

          it('several spans are timed independently', async () => {
            const tracer = createTracer();
            const first = tracer.span('a');
            await sleep(50);
            first.end();

            const second = tracer.span('b');
            await sleep(200);
            second.end();

            expect(tracer.spans().map((span) => span.durationMs)).toEqual([50, 200]);
          });

          it('parallel spans do not contaminate each other', async () => {
            const tracer = createTracer();
            await Promise.all([
              (async () => {
                const span = tracer.span('short');
                await sleep(30);
                span.end();
              })(),
              (async () => {
                const span = tracer.span('long');
                await sleep(300);
                span.end();
              })(),
            ]);

            const byName = tracer.spans().reduce((acc, span) => {
              acc[span.name] = span.durationMs;
              return acc;
            }, {} as Record<string, number>);
            expect(byName.short).toBe(30);
            expect(byName.long).toBe(300);
          });

          it('slowest names the longest span', async () => {
            const tracer = createTracer();
            const plan: Array<[string, number]> = [['fast', 20], ['slower', 90], ['slowest', 240]];
            for (const entry of plan) {
              const span = tracer.span(entry[0]);
              await sleep(entry[1]);
              span.end();
            }

            expect(tracer.slowest()).toEqual({ name: 'slowest', durationMs: 240 });
          });

          it('slowest returns null when nothing was recorded', () => {
            expect(createTracer().slowest()).toBeNull();
          });

          it('attributes a real request to the slowest URL', async () => {
            const tracer = createTracer();
            const histogram = createHistogram(BOUNDARIES);

            for (const url of ['/api/quick', '/api/slow', '/api/quick']) {
              const span = tracer.span(url);
              const startedAt = now();
              await request(url);
              span.end();
              histogram.observe(now() - startedAt);
            }

            expect(tracer.slowest()!.name).toBe('/api/slow');
            expect(histogram.count()).toBe(3);
            expect(histogram.quantile(0.99)).toBeGreaterThan(500);
          });

          it('unfinished spans do not appear in the results', async () => {
            const tracer = createTracer();
            tracer.span('never-ended');
            const done = tracer.span('done');
            await sleep(10);
            done.end();

            expect(tracer.spans()).toHaveLength(1);
            expect(tracer.spans()[0].name).toBe('done');
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.histogramSlots',
      op: 'lte',
      value: 6,
      unit: 'slots',
      zh: '一万次观测之后内存占用不变',
      en: 'Memory is unchanged after ten thousand observations',
      dimension: 'encapsulation',
      scope: 'gate:bounded-memory',
    }),
  ],
  referenceFiles: [
    file(
      'src/telemetry.ts',
      code`
        import { now } from '@lab/env';

        export interface Histogram {
          observe(value: number): void;
          count(): number;
          sum(): number;
          quantile(q: number): number;
          size(): number;
        }

        export function createHistogram(boundaries: number[]): Histogram {
          const bounds = boundaries.slice().sort((left, right) => left - right);
          // The bucket count is fixed: however many observations arrive, they only increment these few counters,
          // so memory is independent of the observation count. Keeping every sample is the implementation that blows the process up
          const counts: number[] = [];
          for (let index = 0; index <= bounds.length; index += 1) counts.push(0);
          let total = 0;
          let totalSum = 0;

          function bucketFor(value: number): number {
            for (let index = 0; index < bounds.length; index += 1) {
              if (value <= bounds[index]) return index;
            }
            // Anything past every boundary goes into the +Inf bucket
            return bounds.length;
          }

          return {
            observe(value: number): void {
              counts[bucketFor(value)] += 1;
              total += 1;
              totalSum += value;
            },

            count(): number {
              return total;
            },

            sum(): number {
              return totalSum;
            },

            quantile(q: number): number {
              if (total === 0) return 0;
              const last = bounds.length > 0 ? bounds[bounds.length - 1] : 0;

              const target = q * total;
              let cumulative = 0;

              for (let index = 0; index < counts.length; index += 1) {
                const next = cumulative + counts[index];
                if (next < target) {
                  cumulative = next;
                  continue;
                }
                if (counts[index] === 0) return last;
                // The +Inf bucket has no upper bound and cannot be interpolated, so fall back to the last finite boundary
                if (index === bounds.length) return last;

                const lower = index === 0 ? 0 : bounds[index - 1];
                const upper = bounds[index];
                // Linear interpolation within the bucket: returning upper directly would make
                // p10 and p90 the same number for everything in one bucket
                const withinBucket = (target - cumulative) / counts[index];
                return lower + (upper - lower) * Math.min(1, Math.max(0, withinBucket));
              }

              return last;
            },

            size(): number {
              return counts.length;
            },
          };
        }

        export interface SpanRecord {
          name: string;
          durationMs: number;
        }

        export interface Tracer {
          span(name: string): { end(): void };
          spans(): SpanRecord[];
          slowest(): SpanRecord | null;
        }

        export function createTracer(): Tracer {
          const records: SpanRecord[] = [];

          return {
            span(name: string) {
              // Both timestamps live in this closure, so parallel spans each get their own and cannot overwrite each other
              const startedAt = now();
              let ended = false;
              return {
                end(): void {
                  // Ending twice should not record two entries
                  if (ended) return;
                  ended = true;
                  records.push({ name, durationMs: now() - startedAt });
                },
              };
            },

            spans(): SpanRecord[] {
              return records.slice();
            },

            slowest(): SpanRecord | null {
              if (records.length === 0) return null;
              return records.reduce((best, current) =>
                current.durationMs > best.durationMs ? current : best
              );
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`counts` 的长度在构造时就定死了。** 这一行就是这一关的全部：',
      '`observe` 永远只是往固定数量的计数器里加一，无论调用一万次还是一亿次，',
      '`size()` 返回同一个数。存全量样本的实现在功能上完全正确、精度还更高，',
      '但它把「监控」变成了「内存泄漏」。',
      '',
      '**桶内插值的那三行。** `withinBucket` 是「目标位次落在这个桶的哪个比例位置」，',
      '按这个比例在 `[lower, upper]` 之间取值。少了它，`quantile(0.1)` 和 `quantile(0.9)`',
      '只要落在同一个桶就会返回同一个数——而线上大部分请求本来就挤在同一个桶里，',
      '于是分位数图变成一条直线。',
      '',
      '**+Inf 桶不能插值。** 它没有上边界，数学上无从插起。Prometheus 的做法是',
      '返回最后一个有限边界，并在文档里明确说「如果 p99 落在 +Inf 桶里，',
      '说明你的桶边界定得太小了」。这是一个提示，不是一个答案。',
      '',
      '**`ended` 标志。** 一个 span 被 `end()` 两次不该产生两条记录——',
      '这在有 try/finally 又有正常返回路径的代码里非常容易发生，',
      '而重复记录会让 count 虚高、分位数偏移，且很难被发现。',
    ].join('\n'),
    [
      'The length of `counts` is fixed at construction, and that single line is the whole stage. `observe`',
      'only ever increments one of a fixed number of counters, so `size()` returns the same number after ten',
      'thousand calls or a hundred million. Storing every sample is functionally correct and more precise,',
      'and it turns monitoring into a memory leak.',
      '',
      'The three lines of intra-bucket interpolation. `withinBucket` is where the target rank falls inside',
      'the bucket as a fraction, applied between `lower` and `upper`. Without it, `quantile(0.1)` and',
      '`quantile(0.9)` return the same number whenever they land in one bucket — and in production most',
      'requests do land in one bucket, flattening the percentile chart into a line.',
      '',
      'The +Inf bucket cannot be interpolated: it has no upper bound, so there is nothing to interpolate',
      'between. Prometheus returns the last finite boundary and says plainly in its documentation that a',
      'p99 landing in +Inf means your boundaries are too small. That is a hint, not an answer.',
      '',
      'The `ended` flag. Calling `end()` twice must not record two spans — very easy to do in code with',
      'both a try/finally and a normal return path — and duplicate records inflate the count and shift the',
      'percentiles in a way that is hard to notice.',
    ].join('\n')
  ),
};

module.exports = {
  id: 'resilient-fetch-pipeline',
  title: t('高可用抓取管线', 'Resilient fetch pipeline'),
  summary: t(
    '从一个串行 for 循环出发，十二关加上并发池、超时预算、错误分类、对冲、缓存单飞、优先级、背压、分页与可观测性。',
    'Start from a sequential for-loop and spend twelve stages on a pool, deadlines, failure classification, hedging, single-flight caching, priorities, backpressure, pagination and telemetry.'
  ),
  difficulty: 'Medium',
  domain: 'concurrency',
  tags: ['concurrency', 'resilience', 'caching', 'api-design'],
  estimatedMinutes: 420,
  language: 'typescript',
  weights: {
    correctness: 3,
    concurrency: 2,
    latency: 2,
    resilience: 1.5,
    encapsulation: 1.5,
    elegance: 1,
  },
  brief: t(
    [
      '## 背景',
      '',
      '你接手了一个内容聚合服务。它需要从合作方的接口批量抓取页面，然后喂给下游的索引服务。',
      '接手第一天你就发现，这个上游**不太稳定**：',
      '',
      '- 单次响应约 **100ms**；',
      '- 只接受 5 路并发，超过直接返回 `429`；',
      '- 少量地址会间歇性失败（`503`），重试几次就能成功；',
      '- 同一批任务里经常出现重复地址，热点地址还会被并发请求。',
      '',
      '现在的实现是一个 `for` 循环 + `await`：',
      '',
      '```ts',
      'for (const url of urls) {',
      '  results.push(await request(url));   // 200 个地址 = 20 秒',
      '}',
      '```',
      '',
      '正确，但太慢。有人试过直接换成 `Promise.all`，结果当天就被合作方限流封了半小时。',
      '',
      '## 目标',
      '',
      '分 12 关把它改造成一个真正能上线的抓取管线：',
      '',
      '| 关卡 | 引入的能力 | 主要指标 |',
      '| --- | --- | --- |',
      '| 1 | 错误边界：失败是数据，不是异常 | 不重复请求 |',
      '| 2 | 有上限的并发 | 峰值并发 ≤ 4，12 个请求 ≤ 300ms |',
      '| 3 | 超时与总预算 | 僵死请求立刻让出槽位；预算用完不再发请求 |',
      '| 4 | 指数退避重试 | 确实重试，且退避不过度 |',
      '| 5 | 错误分类与限流 | 4xx 零重试；429 真的退避 |',
      '| 6 | 对冲请求 | 尾延迟压到副本速度，主副本快时零额外流量 |',
      '| 7 | 缓存 + 并发去重 | 热点地址只回源一次 |',
      '| 8 | 优先级调度与老化 | 低优先级不被饿死 |',
      '| 9 | 背压与队列上限 | 排队数有界；拒绝立刻返回 |',
      '| 10 | 游标分页 | 翻 N 页发 N 个请求；成环立刻停 |',
      '| 11 | 收敛成可运维组件 | 并发受控、可取消、有埋点 |',
      '| 12 | 指标与归因 | 一万次观测内存不增长 |',
      '',
      '## 硬性约束',
      '',
      '1. 下游并发上限是 **5**，任何时刻超过就会被 `429`；被限流的请求算失败。',
      '2. 结果顺序**必须**与输入顺序一致，下游索引服务依赖这个顺序做增量对比。',
      '3. `fetchAll` 不允许因为个别地址失败而整批失败。',
      '4. 只能用工作区内的文件和 `@lab/*` 模块，没有 npm 依赖。',
      '',
      '## 非目标',
      '',
      '- 不做持久化：进程重启后缓存丢失是可以接受的；',
      '- 不做分布式协调：这是一个单进程组件；',
      '- 不做分布式协调：优先级、背压、限流都只在这一个进程里生效。',
      '',
      '## 术语',
      '',
      '- 并发度（concurrency）：某一时刻同时在飞行中的请求数。注意它和「速率（QPS）」是两件事。',
      '- 单飞（single-flight）：同一个 key 的并发请求合并成一次真实调用，其余共享结果。',
      '- **回源**：缓存没命中时真正去请求下游。',
      '',
      '## 运行环境',
      '',
      '工作区里的代码运行在一个**虚拟时钟**上。`sleep(100)` 不会真的等 100ms，',
      '但延迟与并发度会被精确计量，因此结果可复现、跑得飞快，你可以放心地在用例里',
      '断言「正好 300ms」。',
      '',
      '```ts',
      "import { request } from '@lab/net';        // 模拟下游服务，会计量并发与延迟",
      "import { sleep, now } from '@lab/env';     // 虚拟时钟",
      "import { count } from '@lab/metrics';      // 自定义埋点",
      '```',
      '',
      '每一关都有隐藏的验收用例和工程指标门槛。跑对只是底线，',
      '并发不能失控，延迟不能退化，下游也不能被重复请求淹没。',
    ].join('\n'),
    [
      '## Context',
      '',
      'You inherited a content aggregation service that pulls pages from a partner API and feeds them',
      'to a downstream indexer. On day one you find the upstream is **flaky**:',
      '',
      '- each response takes about **100ms**;',
      '- it accepts 5 concurrent calls and returns `429` beyond that;',
      '- some urls fail intermittently (`503`) and succeed after a couple of retries;',
      '- batches contain duplicate urls, and hot urls get requested concurrently.',
      '',
      'The current implementation is a `for` loop with `await`:',
      '',
      '```ts',
      'for (const url of urls) {',
      '  results.push(await request(url));   // 200 urls = 20 seconds',
      '}',
      '```',
      '',
      'Correct, but slow. Someone tried swapping in `Promise.all` and got the partner to rate-limit',
      'the whole service for half an hour.',
      '',
      '## Goal',
      '',
      'Turn it into a pipeline you could actually ship, across 5 stages:',
      '',
      '| Stage | Capability | Key gates |',
      '| --- | --- | --- |',
      '| 1 | Error boundary: failure is data, not an exception | No duplicate calls |',
      '| 2 | Bounded concurrency | Peak ≤ 4, 12 requests ≤ 300ms |',
      '| 3 | Timeouts and a batch budget | A stuck request yields its slot; nothing is sent past the budget |',
      '| 4 | Retry with exponential backoff | Retries happen, backoff is not wasteful |',
      '| 5 | Failure classification | Zero retries on 4xx; a real backoff on 429 |',
      '| 6 | Hedged requests | Tail latency drops to the replica, a fast primary costs nothing extra |',
      '| 7 | Caching + request coalescing | Hot key hits origin once |',
      '| 8 | Priority scheduling and aging | Low priority is never starved |',
      '| 9 | Backpressure | Queue depth is bounded; rejection is instant |',
      '| 10 | Cursor pagination | N pages cost N requests; a loop stops at once |',
      '| 11 | An operable component | Bounded, cancellable, instrumented |',
      '| 12 | Metrics and attribution | Ten thousand observations, unchanged memory |',
      '',
      '## Hard constraints',
      '',
      '1. The upstream concurrency limit is **5**; exceeding it at any instant yields `429`, which counts as a failure.',
      '2. Result order **must** match input order, the indexer relies on it for incremental diffing.',
      '3. `fetchAll` must never fail the whole batch because individual urls failed.',
      '4. Only workspace files and `@lab/*` modules, no npm dependencies.',
      '',
      '## Non-goals',
      '',
      '- No persistence: losing the cache on restart is fine;',
      '- No distributed coordination: this is a single-process component;',
      '- No priority scheduling: all urls are equally important (see the stage 2 "going further" note).',
      '',
      '## Glossary',
      '',
      '- Concurrency: how many requests are in flight at one instant. Not the same thing as rate (QPS).',
      '- Single-flight: concurrent requests for one key collapse into a single real call.',
      '- Origin fetch: the real downstream call made on a cache miss.',
      '',
      '## Runtime',
      '',
      'Your code runs on a virtual clock. `sleep(100)` does not really wait 100ms, yet latency and',
      'concurrency are measured precisely, runs are reproducible and instant, so specs can assert',
      '"exactly 300ms" without flaking.',
      '',
      '```ts',
      "import { request } from '@lab/net';        // simulated upstream, measures concurrency and latency",
      "import { sleep, now } from '@lab/env';     // virtual clock",
      "import { count } from '@lab/metrics';      // custom counters",
      '```',
      '',
      'Every stage has hidden acceptance specs and engineering gates. Passing them is the baseline:',
      'concurrency must stay bounded, latency must not regress, and the upstream must not drown in',
      'duplicate calls.',
    ].join('\n')
  ),
  architecture: t(
    [
      '```mermaid',
      'flowchart LR',
      '  A[urls] --> B[pipeline.run]',
      '  B --> C{cache hit?}',
      '  C -- yes --> H[PageResult]',
      '  C -- no --> D[single flight]',
      '  D --> E[concurrency pool]',
      '  E --> F[retry + backoff]',
      '  F --> G["@lab/net request"]',
      '  G --> H',
      '```',
      '',
      '五关分别构建图中的一层，最后一关把它们收进同一个组件。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart LR',
      '  A[urls] --> B[pipeline.run]',
      '  B --> C{cache hit?}',
      '  C -- yes --> H[PageResult]',
      '  C -- no --> D[single flight]',
      '  D --> E[concurrency pool]',
      '  E --> F[retry + backoff]',
      '  F --> G["@lab/net request"]',
      '  G --> H',
      '```',
      '',
      'Each stage builds one layer; the last stage folds them into a single component.',
    ].join('\n')
  ),
  files: [contract],
  stages: [stage1, stage2, stage3, stage4, stage5, stage6, stage7, stage8, stage9, stage10, stage11, stage12],
};
