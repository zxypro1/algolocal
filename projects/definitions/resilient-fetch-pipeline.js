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
     * 平台提供的契约文件（只读）
     * 你的实现必须满足这里的类型约定，隐藏用例会按此校验。
     */

    export interface PageResult {
      /** 请求的地址 */
      url: string;
      /** 是否成功拿到数据 */
      ok: boolean;
      /** 成功时的响应体，失败时为 null */
      data: unknown;
      /** 失败原因，成功时可以省略 */
      error?: string;
    }

    export interface FetchOptions {
      /** 并发上限，不传表示串行 */
      concurrency?: number;
      /** 单个地址的最大重试次数 */
      retries?: number;
      /** 重试的基础退避时间 */
      baseDelayMs?: number;
      /** 缓存有效期 */
      ttlMs?: number;
      /** 取消信号 */
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
    /** 平台提供的取消令牌实现（只读），用法类似 AbortController */
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
  goal: t(
    [
      '先把最小可用的抓取能力跑通，重点不是快，而是边界清晰。',
      '',
      '在 `src/fetcher.ts` 中实现：',
      '',
      '- `fetchPage(url)`：调用 `@lab/net` 的 `request`，把结果规范化为 `PageResult`。',
      '  失败不要向外抛异常，而是返回 `{ ok: false, error }`，上层要能拿到全部结果，而不是被一个坏地址打断。',
      '- `fetchAll(urls)`：按输入顺序返回结果数组。这一关串行实现即可。',
      '',
      '一个随时可能抛异常的函数，会把错误处理的责任摊给每一个调用方。先把错误收敛在模块边界里。',
    ].join('\n'),
    [
      'Get a minimal fetching capability working. The point is not speed yet, it is a clean boundary.',
      '',
      'Implement in `src/fetcher.ts`:',
      '',
      '- `fetchPage(url)`: call `request` from `@lab/net` and normalise the result into a `PageResult`.',
      '  Do not throw on failure, return `{ ok: false, error }` so callers can see every result instead of losing the batch to one bad url.',
      '- `fetchAll(urls)`: return results in input order. A sequential implementation is fine here.',
      '',
      'A function that might throw at any moment spreads error handling across every caller. Contain failure at the module boundary instead.',
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
         * 抓取单个地址，把成功/失败统一成 PageResult。
         * 提示：request 失败时会抛出 LabHttpError。
         */
        export async function fetchPage(url: string): Promise<PageResult> {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }

        /**
         * 批量抓取，返回顺序必须与 urls 一致。
         * 第 1 关串行实现即可，后面几关会逐步加上并发、重试和缓存。
         */
        export async function fetchAll(urls: string[], options: FetchOptions = {}): Promise<PageResult[]> {
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
        import { fetchAll, fetchPage } from '../src/fetcher';
        import { getMetrics } from '@lab/net';

        const urls = ['/api/pages/1', '/api/pages/2', '/api/pages/3'];

        describe('阶段1 · 契约与错误边界', () => {
          it('fetchPage 返回规范化的成功结果', async () => {
            const result = await fetchPage('/api/pages/1');
            expect(result.url).toBe('/api/pages/1');
            expect(result.ok).toBe(true);
            expect(result.data).toBeDefined();
          });

          it('fetchPage 把失败收敛成结果而不是异常', async () => {
            const result = await fetchPage('/api/pages/broken');
            expect(result.ok).toBe(false);
            expect(result.data).toBeNull();
            expect(typeof result.error).toBe('string');
            expect(result.error.length).toBeGreaterThan(0);
          });

          it('fetchAll 保持输入顺序', async () => {
            const results = await fetchAll(urls);
            expect(results).toHaveLength(3);
            expect(results.map((item) => item.url)).toEqual(urls);
            expect(results.every((item) => item.ok)).toBe(true);
          });

          it('一个坏地址不会拖垮整批 [gate:dedup]', async () => {
            const results = await fetchAll(['/api/pages/1', '/api/pages/broken', '/api/pages/3']);
            expect(results.map((item) => item.ok)).toEqual([true, false, true]);
            expect(getMetrics().requests.duplicated).toBe(0);
          });

          it('全部失败时也返回完整的结果数组', async () => {
            const results = await fetchAll(['/api/pages/broken', '/api/pages/gone']);
            expect(results).toHaveLength(2);
            expect(results.map((item) => item.ok)).toEqual([false, false]);
            expect(results.map((item) => item.url)).toEqual(['/api/pages/broken', '/api/pages/gone']);
          });

          it('空数组直接返回空结果，不发请求', async () => {
            const results = await fetchAll([]);
            expect(results).toEqual([]);
            expect(getMetrics().requests.total).toBe(0);
          });

          it('单个地址也能正常工作', async () => {
            const results = await fetchAll(['/api/pages/only']);
            expect(results).toHaveLength(1);
            expect(results[0].ok).toBe(true);
          });

          it('error 是字符串，能被 JSON 序列化', async () => {
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
  goal: t(
    [
      '串行太慢，`Promise.all` 又会把下游打挂：下游服务只允许 5 路并发，超了直接返回 429。',
      '',
      '在 `src/pool.ts` 实现通用的并发映射：',
      '',
      '```ts',
      'mapWithConcurrency(items, limit, worker) // 顺序返回结果，同时最多 limit 个 worker 在跑',
      '```',
      '',
      '然后让 `fetchAll` 在 `options.concurrency` 存在时使用它。',
      '',
      '并发控制值得做成一个可复用的原语，而不是每次都在业务代码里手写一遍循环。',
      '另外提醒一句：分批式并发（每批 4 个、等一批跑完再下一批）会浪费尾部时间，',
      '本关的延迟门槛是按取号式的 worker 池卡的。',
    ].join('\n'),
    [
      'Sequential is too slow, and `Promise.all` melts the downstream, it only allows 5 concurrent calls and returns 429 beyond that.',
      '',
      'Implement a reusable concurrent map in `src/pool.ts`:',
      '',
      '```ts',
      'mapWithConcurrency(items, limit, worker) // ordered results, at most `limit` workers in flight',
      '```',
      '',
      'Then make `fetchAll` use it when `options.concurrency` is set.',
      '',
      'Concurrency control is worth building as a reusable primitive rather than hand-rolling a loop each time.',
      'One warning: batch slicing (run 4, wait for all, run the next 4) wastes tail time, and the latency gate here',
      'assumes a pull-based worker pool.',
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
         * 通用的并发映射原语。
         *
         * 要求：
         * - 返回值顺序与 items 一致
         * - 任意时刻最多有 limit 个 worker 在执行
         * - 某个 worker 抛错时，整体 reject（不要静默吞掉）
         */
        export async function mapWithConcurrency<T, R>(
          items: T[],
          limit: number,
          worker: (item: T, index: number) => Promise<R>
        ): Promise<R[]> {
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
        import { mapWithConcurrency } from '../src/pool';
        import { fetchAll } from '../src/fetcher';
        import { getMetrics } from '@lab/net';
        import { sleep } from '@lab/env';

        const urls = Array.from({ length: 12 }, (_, index) => '/api/pages/' + index);

        describe('阶段2 · 有上限的并发', () => {
          it('mapWithConcurrency 保持结果顺序', async () => {
            const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
              await sleep(10 * (6 - value));
              return value * 2;
            });
            expect(result).toEqual([2, 4, 6, 8, 10]);
          });

          it('mapWithConcurrency 不会超过并发上限', async () => {
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

          it('worker 抛出的错误会向上传播', async () => {
            await expect(async () =>
              mapWithConcurrency([1, 2, 3], 2, async (value) => {
                if (value === 2) throw new Error('boom');
                return value;
              })
            ).rejects.toThrow('boom');
          });

          it('fetchAll 支持并发且顺序不变 [gate:concurrency]', async () => {
            const results = await fetchAll(urls, { concurrency: 4 });
            expect(results.map((item) => item.url)).toEqual(urls);
            const metrics = getMetrics();
            expect(metrics.maxConcurrency).toBeLessThanOrEqual(4);
            expect(metrics.requests.throttled).toBe(0);
          });

          it('12 个 100ms 的请求在并发 4 下 300ms 跑完 [gate:latency]', async () => {
            await fetchAll(urls, { concurrency: 4 });
            const metrics = getMetrics();
            expect(metrics.requests.total).toBe(12);
            expect(metrics.virtualElapsedMs).toBe(300);
          });

          it('并发确实跑满上限，而不是保守地少跑', async () => {
            await fetchAll(urls, { concurrency: 4 });
            // 峰值必须正好是 4：小于 4 说明白白浪费了配额
            expect(getMetrics().maxConcurrency).toBe(4);
          });

          it('limit 大于任务数时不会创建多余的 worker', async () => {
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

          it('limit 为 1 时退化成串行', async () => {
            await fetchAll(['/api/a', '/api/b', '/api/c'], { concurrency: 1 });
            const metrics = getMetrics();
            expect(metrics.maxConcurrency).toBe(1);
            expect(metrics.virtualElapsedMs).toBe(300);
          });

          it('不传 concurrency 时保持串行，不偷偷放大并发', async () => {
            await fetchAll(['/api/a', '/api/b'], {});
            expect(getMetrics().maxConcurrency).toBe(1);
          });

          it('空任务列表不会挂住', async () => {
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

const stage3 = {
  id: 'retry-backoff',
  title: t('第 3 关 · 重试与指数退避', 'Stage 3 · Retry with exponential backoff'),
  goal: t(
    [
      '真实的下游会抖动。`/api/pages/flaky` 前两次一定失败，第三次才成功。',
      '',
      '在 `src/retry.ts` 实现：',
      '',
      '```ts',
      'withRetry(task, { retries, baseDelayMs, factor })',
      '```',
      '',
      '- 第 n 次失败后等待 `baseDelayMs * factor^(n-1)`（factor 默认 2）再重试；',
      '- 用尽次数后抛出最后一次的错误；',
      '- 让 `fetchPage` 在 `options.retries` 存在时走重试。',
      '',
      '没有退避的重试，等于在下游最虚弱的时候加倍打它。等待时间要随失败次数增长。',
    ].join('\n'),
    [
      'Real upstreams flap. `/api/pages/flaky` fails its first two calls and succeeds on the third.',
      '',
      'Implement in `src/retry.ts`:',
      '',
      '```ts',
      'withRetry(task, { retries, baseDelayMs, factor })',
      '```',
      '',
      '- After the n-th failure wait `baseDelayMs * factor^(n-1)` (factor defaults to 2) before retrying;',
      '- Throw the last error once attempts are exhausted;',
      '- Wire `fetchPage` to use it when `options.retries` is set.',
      '',
      'Retrying without backoff means hitting a dependency hardest exactly when it is weakest.',
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
          /** 最多额外重试几次（不含第一次调用） */
          retries: number;
          /** 第一次退避的等待时间 */
          baseDelayMs: number;
          /** 退避倍数，默认 2 */
          factor?: number;
          /** 判断错误是否值得重试，默认全部重试 */
          isRetryable?: (error: unknown) => boolean;
        }

        /**
         * 带指数退避的重试。
         * task 接收当前是第几次尝试（从 1 开始）。
         */
        export async function withRetry<T>(
          task: (attempt: number) => Promise<T>,
          options: RetryOptions
        ): Promise<T> {
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
        import { withRetry } from '../src/retry';
        import { fetchPage } from '../src/fetcher';
        import { getMetrics } from '@lab/net';
        import { now } from '@lab/env';

        describe('阶段3 · 重试与退避', () => {
          it('失败两次后第三次成功 [gate:retry]', async () => {
            const result = await fetchPage('/api/pages/flaky', { retries: 3, baseDelayMs: 50 });
            expect(result.ok).toBe(true);
            const metrics = getMetrics();
            expect(metrics.requests.total).toBe(3);
            expect(metrics.requests.retries).toBe(2);
          });

          it('退避是指数增长的 [gate:backoff]', async () => {
            await fetchPage('/api/pages/flaky', { retries: 3, baseDelayMs: 50 });
            // 3 次请求各 100ms，退避 50ms + 100ms
            expect(getMetrics().virtualElapsedMs).toBe(450);
          });

          it('固定间隔的退避会被识别出来', async () => {
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

          it('重试用尽后抛出最后一次错误', async () => {
            await expect(async () =>
              withRetry(
                async (attempt) => {
                  throw new Error('attempt ' + attempt + ' failed');
                },
                { retries: 2, baseDelayMs: 10 }
              )
            ).rejects.toThrow('attempt 3 failed');
          });

          it('不重试 404 这类不可恢复的错误', async () => {
            const result = await fetchPage('/api/pages/missing', { retries: 3, baseDelayMs: 10 });
            expect(result.ok).toBe(false);
            expect(getMetrics().requests.total).toBe(1);
          });

          it('第一次就成功时不产生任何等待', async () => {
            const startedAt = now();
            const result = await fetchPage('/api/pages/1', { retries: 3, baseDelayMs: 100 });
            expect(result.ok).toBe(true);
            // 只有一次请求的 100ms，没有额外退避
            expect(now() - startedAt).toBe(100);
            expect(getMetrics().requests.total).toBe(1);
          });

          it('retries 为 0 时只尝试一次', async () => {
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

          it('factor 可以自定义', async () => {
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

          it('task 能拿到当前是第几次尝试', async () => {
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

          it('isRetryable 返回 false 时立刻放弃', async () => {
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

const stage4 = {
  id: 'cache-single-flight',
  title: t('第 4 关 · 缓存与并发去重', 'Stage 4 · Caching and single-flight'),
  goal: t(
    [
      '同一批任务里经常出现重复地址；更糟的是，同一个地址的多个请求会同时打到下游。',
      '',
      '在 `src/cache.ts` 实现两件事：',
      '',
      '- `createCache({ ttlMs, maxSize })`：带 TTL 的 LRU 缓存（`get` / `set` / `size`）。',
      '- `createSingleFlight()`：并发调用同一个 key 时，只真正执行一次 loader，其余共享同一个 Promise。',
      '',
      '然后让 `fetchPage` 在 `options.ttlMs` 存在时走「缓存 → 单飞 → 网络」。',
      '',
      '缓存管的是「再次」，单飞管的是「同时」。少了任何一个，热点 key 都会击穿到下游。',
    ].join('\n'),
    [
      'Duplicate urls show up constantly, and worse, several requests for the same url hit the upstream at the same time.',
      '',
      'Implement two things in `src/cache.ts`:',
      '',
      '- `createCache({ ttlMs, maxSize })`: an LRU cache with TTL (`get` / `set` / `size`).',
      '- `createSingleFlight()`: concurrent calls for the same key run the loader once and share one promise.',
      '',
      'Then make `fetchPage` go through cache → single-flight → network when `options.ttlMs` is set.',
      '',
      'A cache handles "again"; single-flight handles "at the same time". Miss either and hot keys stampede the upstream.',
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
          /** 条目存活时间，不传表示永不过期 */
          ttlMs?: number;
          /** 最大条目数，超出后按 LRU 淘汰 */
          maxSize?: number;
        }

        export interface Cache<T> {
          get(key: string): T | undefined;
          set(key: string, value: T): void;
          readonly size: number;
        }

        /** 带 TTL 的 LRU 缓存 */
        export function createCache<T>(options: CacheOptions = {}): Cache<T> {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }

        /** 并发去重：同一个 key 同时到来的调用共享一次执行 */
        export function createSingleFlight() {
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
        import { createCache, createSingleFlight } from '../src/cache';
        import { fetchPage, fetchAll } from '../src/fetcher';
        import { getMetrics } from '@lab/net';
        import { sleep } from '@lab/env';

        describe('阶段4 · 缓存与并发去重', () => {
          it('LRU 按最近使用淘汰', () => {
            const cache = createCache<number>({ maxSize: 2 });
            cache.set('a', 1);
            cache.set('b', 2);
            expect(cache.get('a')).toBe(1); // a 变成最近使用
            cache.set('c', 3);              // 淘汰 b
            expect(cache.get('b')).toBeUndefined();
            expect(cache.get('a')).toBe(1);
            expect(cache.get('c')).toBe(3);
            expect(cache.size).toBe(2);
          });

          it('TTL 过期后不再命中', async () => {
            const cache = createCache<string>({ ttlMs: 100 });
            cache.set('k', 'v');
            expect(cache.get('k')).toBe('v');
            await sleep(150);
            expect(cache.get('k')).toBeUndefined();
          });

          it('单飞让并发调用只执行一次 loader', async () => {
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

          it('单飞结束后不会一直占着 key', async () => {
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

          it('并发抓同一个地址只打一次下游 [gate:dedup]', async () => {
            const urls = ['/api/hot', '/api/hot', '/api/hot', '/api/hot', '/api/hot'];
            const results = await fetchAll(urls, { concurrency: 5, ttlMs: 1000 });
            expect(results.every((item) => item.ok)).toBe(true);
            const metrics = getMetrics();
            expect(metrics.requests.total).toBe(1);
            expect(metrics.virtualElapsedMs).toBe(100);
          });

          it('缓存命中不再产生请求', async () => {
            await fetchPage('/api/warm', { ttlMs: 1000 });
            await fetchPage('/api/warm', { ttlMs: 1000 });
            expect(getMetrics().requests.total).toBe(1);
          });

          it('容量为 1 的 LRU 每次都只留最新的一个', () => {
            const cache = createCache<number>({ maxSize: 1 });
            cache.set('a', 1);
            cache.set('b', 2);
            expect(cache.get('a')).toBeUndefined();
            expect(cache.get('b')).toBe(2);
            expect(cache.size).toBe(1);
          });

          it('重复 set 同一个 key 不会撑大容量', () => {
            const cache = createCache<number>({ maxSize: 2 });
            cache.set('a', 1);
            cache.set('a', 2);
            cache.set('a', 3);
            expect(cache.size).toBe(1);
            expect(cache.get('a')).toBe(3);
          });

          it('不缓存失败的结果，下次仍然会回源', async () => {
            const first = await fetchPage('/api/flaky-cache', { ttlMs: 1000 });
            expect(first.ok).toBe(false);

            const second = await fetchPage('/api/flaky-cache', { ttlMs: 1000 });
            expect(second.ok).toBe(true);
            expect(getMetrics().requests.total).toBe(2);
          });

          it('loader 抛错时单飞也要清理登记表', async () => {
            const singleFlight = createSingleFlight();
            let calls = 0;
            const failing = async () => {
              calls += 1;
              throw new Error('loader failed');
            };

            await expect(async () => singleFlight('k', failing)).rejects.toThrow('loader failed');
            await expect(async () => singleFlight('k', failing)).rejects.toThrow('loader failed');
            // 没清理的话第二次会复用那个已经 reject 的旧 promise，calls 会停在 1
            expect(calls).toBe(2);
          });

          it('不同 key 之间互不影响', async () => {
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
              // Map 保持插入顺序，删掉再塞回去就是「移到最近使用」
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

const stage5 = {
  id: 'pipeline',
  title: t('第 5 关 · 收敛为可运维的组件', 'Stage 5 · Ship an operable component'),
  goal: t(
    [
      '最后一关不加新功能，而是把前四关的能力收进一个有边界的组件。',
      '',
      '在 `src/pipeline.ts` 实现 `createPipeline(options)`，返回：',
      '',
      '- `run(urls)`：执行抓取，语义等价于带全部选项的 `fetchAll`；',
      '- `stats()`：返回 `{ completed, failed, cacheHits }`；',
      '- 支持 `options.signal` 取消：取消后不再发起新请求，已在飞行中的请求可以跑完。',
      '',
      '每个 pipeline 实例必须持有自己的缓存，不要用模块级单例。',
      '同时用 `@lab/metrics` 的 `count()` 打点 `pipeline.completed` / `pipeline.failed`。',
      '',
      '一个能创建多份、能取消、能报告自己状态的组件，才有可能被安心地放上线。',
    ].join('\n'),
    [
      'The last stage adds no features. It puts a boundary around everything you built.',
      '',
      'Implement `createPipeline(options)` in `src/pipeline.ts`, returning:',
      '',
      '- `run(urls)`: fetches, semantically equal to `fetchAll` with every option;',
      '- `stats()`: returns `{ completed, failed, cacheHits }`;',
      '- cancellation via `options.signal`: once cancelled, start no new requests (in-flight ones may finish).',
      '',
      'Every pipeline instance must own its cache, no module-level singletons.',
      'Also emit `pipeline.completed` / `pipeline.failed` through `count()` from `@lab/metrics`.',
      '',
      'A component you can instantiate twice, cancel, and ask for its state is one you can put into production without worrying.',
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
         * 把前四关的能力组装成一个自带状态、可取消、可观测的组件。
         * 每个实例必须有自己的缓存。
         */
        export function createPipeline(options: PipelineOptions = {}): Pipeline {
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
        import { createPipeline } from '../src/pipeline';
        import { createCancelSource } from '../src/support/cancel';
        import { getMetrics } from '@lab/net';
        import { getCounters } from '@lab/metrics';
        import { sleep } from '@lab/env';

        const urls = Array.from({ length: 12 }, (_, index) => '/api/pages/' + index);

        describe('阶段5 · 收敛为组件', () => {
          it('组合能力：并发 + 重试 + 缓存 [gate:pipeline]', async () => {
            const pipeline = createPipeline({ concurrency: 4, retries: 2, baseDelayMs: 20, ttlMs: 1000 });
            const results = await pipeline.run(urls.concat(['/api/pages/flaky', '/api/pages/0']));
            expect(results).toHaveLength(14);
            expect(results.every((item) => item.ok)).toBe(true);

            const metrics = getMetrics();
            expect(metrics.maxConcurrency).toBeLessThanOrEqual(4);
            expect(metrics.requests.throttled).toBe(0);
            expect(pipeline.stats().completed).toBe(14);
          });

          it('实例之间缓存隔离', async () => {
            const first = createPipeline({ ttlMs: 1000 });
            const second = createPipeline({ ttlMs: 1000 });
            await first.run(['/api/shared']);
            await second.run(['/api/shared']);
            expect(getMetrics().requests.total).toBe(2);
          });

          it('同一个实例内命中缓存', async () => {
            const pipeline = createPipeline({ ttlMs: 1000 });
            await pipeline.run(['/api/shared']);
            await pipeline.run(['/api/shared']);
            expect(getMetrics().requests.total).toBe(1);
            expect(pipeline.stats().cacheHits).toBe(1);
          });

          it('取消后不再发起新请求 [gate:cancel]', async () => {
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

          it('埋点写入了 metrics', async () => {
            const pipeline = createPipeline({ concurrency: 4 });
            await pipeline.run(['/api/pages/1', '/api/pages/2']);
            const counters = getCounters();
            expect(counters['pipeline.completed']).toBe(2);
          });

          it('stats() 返回的是副本，外部改不动内部计数', async () => {
            const pipeline = createPipeline({ concurrency: 2 });
            await pipeline.run(['/api/pages/1']);

            const snapshot = pipeline.stats();
            snapshot.completed = 999;
            expect(pipeline.stats().completed).toBe(1);
          });

          it('取消之后 run 仍然正常返回，而不是抛异常', async () => {
            const source = createCancelSource();
            const pipeline = createPipeline({ concurrency: 2, signal: source.token });
            source.cancel();

            const results = await pipeline.run(['/api/pages/1', '/api/pages/2']);
            expect(results).toHaveLength(2);
            expect(results.every((item) => !item.ok)).toBe(true);
            expect(getMetrics().requests.total).toBe(0);
          });

          it('两个实例的统计互不干扰', async () => {
            const first = createPipeline({ concurrency: 2 });
            const second = createPipeline({ concurrency: 2 });

            await first.run(['/api/pages/1', '/api/pages/2']);
            await second.run(['/api/pages/3']);

            expect(first.stats().completed).toBe(2);
            expect(second.stats().completed).toBe(1);
          });

          it('失败的地址计入 failed 而不是 completed', async () => {
            const pipeline = createPipeline({ concurrency: 2 });
            const results = await pipeline.run(['/api/pages/1', '/api/pages/flaky']);

            // flaky 第一次必失败，且这里没开重试
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
          // 每个实例持有自己的缓存与单飞登记表：可以放心 new 两份
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

module.exports = {
  id: 'resilient-fetch-pipeline',
  title: t('高可用抓取管线', 'Resilient fetch pipeline'),
  summary: t(
    '从一个串行 for 循环出发，逐关加上并发池、指数退避、缓存单飞与取消，最终收敛成一个可运维的组件。',
    'Start from a sequential for-loop and grow it into an operable component: bounded concurrency, backoff, caching, single-flight and cancellation.'
  ),
  difficulty: 'Medium',
  domain: 'concurrency',
  tags: ['concurrency', 'resilience', 'caching', 'api-design'],
  estimatedMinutes: 120,
  language: 'typescript',
  weights: {
    correctness: 3,
    concurrency: 2,
    latency: 2,
    resilience: 1.5,
    encapsulation: 1.5,
    elegance: 1,
  },
  prerequisites: [
    t('async / await 与 Promise 的基本用法', 'async/await and Promise basics'),
    t('TypeScript 的接口与泛型', 'TypeScript interfaces and generics'),
    t('不需要任何分布式系统背景', 'No distributed-systems background required'),
  ],
  learningOutcomes: [
    t(
      '写出一个带上限的并发原语，并说清它为什么比「分批 Promise.all」更好',
      'Write a bounded-concurrency primitive and explain why it beats chunked Promise.all'
    ),
    t(
      '实现指数退避，并判断哪些错误值得重试、哪些重试多少次都没用',
      'Implement exponential backoff and tell retryable failures from hopeless ones'
    ),
    t(
      '用缓存解决「再次」、用单飞解决「同时」，防住热点 key 击穿',
      'Use a cache for "again" and single-flight for "at the same time" to stop hot-key stampedes'
    ),
    t(
      '把一堆能力收进一个可实例化、可取消、可观测的组件里',
      'Fold a pile of capabilities into one instantiable, cancellable, observable component'
    ),
    t(
      '读懂并发度与延迟指标，用它们判断一个实现是快还是只是「看起来快」',
      'Read concurrency and latency metrics to tell a fast implementation from one that merely looks fast'
    ),
  ],
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
      '分 5 关把它改造成一个真正能上线的抓取管线：',
      '',
      '| 关卡 | 引入的能力 | 主要指标 |',
      '| --- | --- | --- |',
      '| 1 | 错误边界：失败是数据，不是异常 | 不重复请求 |',
      '| 2 | 有上限的并发 | 峰值并发 ≤ 4，12 个请求 ≤ 300ms |',
      '| 3 | 指数退避重试 | 确实重试，且退避不过度 |',
      '| 4 | 缓存 + 并发去重 | 热点地址只回源一次 |',
      '| 5 | 收敛成可运维组件 | 并发受控、可取消、有埋点 |',
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
      '- 不做优先级调度：所有地址同等重要（这是第 2 关「延伸」里的话题）。',
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
      '| 3 | Retry with exponential backoff | Retries happen, backoff is not wasteful |',
      '| 4 | Caching + request coalescing | Hot key hits origin once |',
      '| 5 | An operable component | Bounded, cancellable, instrumented |',
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
  stages: [stage1, stage2, stage3, stage4, stage5],
};
