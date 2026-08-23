/**
 * 工程实战 · 有韧性的 API 网关
 *
 * 注意：代码片段使用 String.raw 模板，不要在片段里写 `${}`。
 */
const { t, code, file, readonlyFile, spec, gate } = require('./_helpers');

const contract = readonlyFile(
  'src/contract.ts',
  code`
    /** Contract provided by the platform (read-only) */

    export interface GatewayResult {
      ok: boolean;
      data?: unknown;
      /** Failure reason: 'timeout' | 'circuit-open' | 'upstream' */
      reason?: string;
      error?: string;
    }

    export interface GatewayStats {
      ok: number;
      timedOut: number;
      rejected: number;
      failed: number;
    }
  `
);

/* ------------------------------------------------------------------ */

const stage1 = {
  id: 'sliding-window',
  title: t('第 1 关 · 固定窗口与滑动窗口', 'Stage 1 · Fixed windows and sliding windows'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '限流的第一个问题不是「怎么实现」，而是「窗口怎么算」。',
      '最容易想到的做法 —— 每秒清零一次计数器 —— 有一个致命缺陷，',
      '而这个缺陷只在窗口边界上出现，压测时很难撞到。',
      '',
      '## 要实现什么',
      '',
      '在 `src/window.ts` 实现三个限流器，接口都是 `allow(): boolean` 和 `size(): number`：',
      '',
      '| 工厂 | 做法 |',
      '| --- | --- |',
      '| `createFixedWindow({ limit, windowMs })` | 窗口内计数，到点清零 |',
      '| `createSlidingLog({ limit, windowMs })` | 记下每次通过的时刻，判断时数「最近 windowMs 内有多少条」 |',
      '| `createSlidingCounter({ limit, windowMs })` | 只留当前和上一个窗口的计数，按当前时刻在窗口里的位置**加权估算** |',
      '',
      '`size()` 返回这个限流器当前占了多少个存储单元 —— 门槛靠它来量内存。',
      '',
      '## 怎么算过',
      '',
      '- 固定窗口在边界上确实会放两倍（这一条是要**看见**它出问题）；',
      '- 滑动日志和滑动计数器都挡得住边界突刺（门槛 `counters.boundaryAdmitted ≤ 6`）；',
      '- 滑动计数器的内存与请求数无关（门槛 `counters.counterSlots ≤ 4`）；',
      '- 窗口过去之后额度恢复；',
      '- 三种实现在稳态下行为一致。',
      '',
      '## 边界突刺长什么样',
      '',
      '`limit = 5`、`windowMs = 1000`：在 t=900 发 5 个，t=1000 再发 5 个。',
      '固定窗口会**全部放行** —— 它们分属两个窗口，各自都没超。',
      '但站在任何观察者的角度，200ms 内过了 10 个请求，是限额的两倍。',
      '',
      '滑动日志能挡住，代价是内存随请求数增长 —— 限额一百万的接口要存一百万个时间戳。',
      '滑动计数器只存两个数字，用加权估算逼近，是工业界的默认选择。',
      '',
      '但要记住它是**估算**：它假设上一个窗口内的请求均匀分布。',
      '真实流量挤在窗口末尾时它会低估，挤在开头时会高估。',
      '这个误差是设计的一部分，不是 bug —— 但你得知道它在。',
    ].join('\n'),
    [
      'The first question in rate limiting is not how to implement it but how to define the window. The',
      'obvious approach — a counter reset every second — has a fatal flaw that appears only at window',
      'boundaries and is hard to hit in a load test.',
      '',
      '## What to build',
      '',
      'Three limiters in `src/window.ts`, all exposing `allow(): boolean` and `size(): number`:',
      '',
      '| Factory | Approach |',
      '| --- | --- |',
      '| `createFixedWindow({ limit, windowMs })` | Count within the window, reset at the boundary |',
      '| `createSlidingLog({ limit, windowMs })` | Record every admission\'s timestamp, then count how many fall inside the last `windowMs` |',
      '| `createSlidingCounter({ limit, windowMs })` | Keep only the current and previous window counts, **weighted** by where the current instant sits in the window |',
      '',
      '`size()` reports how many storage slots the limiter currently occupies — that is what the memory gate',
      'measures.',
      '',
      '## What counts as passing',
      '',
      '- The fixed window really does admit double at the boundary (this one you are meant to **see** fail);',
      '- The sliding log and sliding counter both block the boundary burst (`counters.boundaryAdmitted ≤ 6`);',
      '- The sliding counter\'s memory is independent of request count (`counters.counterSlots ≤ 4`);',
      '- Allowance recovers once the window passes;',
      '- All three agree in steady state.',
      '',
      '## What the boundary burst looks like',
      '',
      'With `limit = 5` and `windowMs = 1000`: send five at t=900 and five more at t=1000. The fixed window',
      'admits **all ten** — they belong to different windows and neither exceeds its own. To any observer,',
      'ten requests passed in 200ms, twice the limit.',
      '',
      'A sliding log stops it, at the cost of memory growing with request count: an endpoint limited to a',
      'million would store a million timestamps. A sliding counter stores two numbers and approximates by',
      'weighting, which is what the industry actually uses.',
      '',
      'But remember it is an **estimate**: it assumes requests were uniform within the previous window.',
      'Traffic clustered at the end of that window makes it underestimate; clustered at the start, it',
      'overestimates. That error is part of the design, not a bug — but you should know it is there.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '三个限流器各是一张独立的图，因为它们本来就是三种互不相干的做法。',
      '对照着看**状态格子的数量**，就是三者的内存差别。',
      '',
      '**`createFixedWindow`** —— 状态两个数字：`windowId`、`used`',
      '',
      '```mermaid',
      'flowchart TD',
      '  F1["allow()"] --> F2["id = floor(now / windowMs)<br/>算窗口编号，不用定时器"]',
      '  F2 --> F3{"id 和 windowId 不同？"}',
      '  F3 -- 不同 --> F4["windowId = id<br/>used = 0"]',
      '  F4 --> F5',
      '  F3 -- 相同 --> F5{"used ≥ limit？"}',
      '  F5 -- 是 --> FNO["false"]',
      '  F5 -- 否 --> FYES["used += 1 → true"]',
      '```',
      '',
      '**`createSlidingLog`** —— 状态是一个数组，长度会涨到 `limit`',
      '',
      '```mermaid',
      'flowchart TD',
      '  L1["allow()"] --> L2["prune(now)<br/>丢掉 ≤ now - windowMs 的时间戳"]',
      '  L2 --> L3{"stamps.length ≥ limit？"}',
      '  L3 -- 是 --> LNO["false"]',
      '  L3 -- 否 --> LYES["stamps.push(now) → true"]',
      '```',
      '',
      '`prune` 放在最前面，被拒绝的请求也会清理 —— 只在放行路径上清的话，',
      '一个持续被限流的客户端会让数组永远堆着。',
      '',
      '**`createSlidingCounter`** —— 状态三个数字：`windowId`、`current`、`previous`',
      '',
      '```mermaid',
      'flowchart TD',
      '  C1["allow()"] --> C2["roll(now)"]',
      '  C2 --> C3{"跨了几个窗口？"}',
      '  C3 -- 刚好一个 --> C4["previous = current"]',
      '  C3 -- 更远 --> C5["previous = 0"]',
      '  C4 --> C6["current = 0"]',
      '  C5 --> C6',
      '  C6 --> C7["elapsed = 当前时刻在窗口里的比例"]',
      '  C7 --> C8["估算 = previous × (1 - elapsed) + current"]',
      '  C8 --> C9{"估算 ≥ limit？"}',
      '  C9 -- 是 --> CNO["false"]',
      '  C9 -- 否 --> CYES["current += 1 → true"]',
      '```',
      '',
      '`C8` 的权重方向是这一关最容易写反的一行：`1 - elapsed` 表示「上一个窗口还有多少没滑出去」。',
      '写成 `elapsed` 之后，窗口刚开始时几乎不计上一个窗口（该严的时候松），',
      '窗口快结束时全额计入（该松的时候严），行为正好颠倒。',
    ].join('\n'),
    [
      'Three limiters, three separate diagrams, because they are three unrelated approaches. Compare the',
      '**number of state cells** across them and you have the memory difference.',
      '',
      '**`createFixedWindow`** — two numbers of state: `windowId`, `used`',
      '',
      '```mermaid',
      'flowchart TD',
      '  F1["allow()"] --> F2["id = floor(now / windowMs)<br/>compute the window id, no timer"]',
      '  F2 --> F3{"id differs from windowId?"}',
      '  F3 -- yes --> F4["windowId = id<br/>used = 0"]',
      '  F4 --> F5',
      '  F3 -- no --> F5{"used ≥ limit?"}',
      '  F5 -- yes --> FNO["false"]',
      '  F5 -- no --> FYES["used += 1 → true"]',
      '```',
      '',
      '**`createSlidingLog`** — the state is an array that grows to `limit`',
      '',
      '```mermaid',
      'flowchart TD',
      '  L1["allow()"] --> L2["prune(now)<br/>drop stamps ≤ now - windowMs"]',
      '  L2 --> L3{"stamps.length ≥ limit?"}',
      '  L3 -- yes --> LNO["false"]',
      '  L3 -- no --> LYES["stamps.push(now) → true"]',
      '```',
      '',
      '`prune` runs first, so rejected calls clean up too — cleaning only on the admit path lets an',
      'aggressively throttled client pile up timestamps forever.',
      '',
      '**`createSlidingCounter`** — three numbers: `windowId`, `current`, `previous`',
      '',
      '```mermaid',
      'flowchart TD',
      '  C1["allow()"] --> C2["roll(now)"]',
      '  C2 --> C3{"how many windows were crossed?"}',
      '  C3 -- "exactly one" --> C4["previous = current"]',
      '  C3 -- more --> C5["previous = 0"]',
      '  C4 --> C6["current = 0"]',
      '  C5 --> C6',
      '  C6 --> C7["elapsed = position within the window"]',
      '  C7 --> C8["estimate = previous × (1 - elapsed) + current"]',
      '  C8 --> C9{"estimate ≥ limit?"}',
      '  C9 -- yes --> CNO["false"]',
      '  C9 -- no --> CYES["current += 1 → true"]',
      '```',
      '',
      'The weight direction in `C8` is the line most often written backwards: `1 - elapsed` is "how much of',
      'the previous window has not yet slid out". Written as `elapsed`, the limiter nearly ignores the',
      'previous window at the start (lenient when it should be strict) and counts it fully at the end',
      '(strict when it should be lenient) — exactly inverted.',
    ].join('\n')
  ),
  checklist: [
    t('固定窗口在边界上会放两倍流量', 'A fixed window admits double at the boundary'),
    t('滑动日志能挡住边界突刺', 'A sliding log blocks the boundary burst'),
    t('滑动计数器也能挡住，且内存有界', 'A sliding counter blocks it too, in bounded memory'),
    t('窗口过去之后额度恢复', 'Allowance recovers once the window passes'),
    t('三种实现在稳态下行为一致', 'All three agree in steady state'),
  ],
  pitfalls: [
    t(
      '滑动日志里只在 `allow` 返回 true 时清理过期时间戳。被拒绝的请求同样会推进时间，如果只在放行路径上清理，一个持续被限流的客户端会让数组里的旧时间戳永远堆着——限流器本身成了内存泄漏点，而且恰恰在被攻击时泄漏最快。',
      'Cleaning expired timestamps in a sliding log only when `allow` returns true. Rejected calls advance time too, so an aggressively throttled client leaves old timestamps piling up forever — the limiter becomes the leak, and leaks fastest precisely when under attack.'
    ),
    t(
      '滑动计数器的加权方向写反：用 `已过去的比例` 去乘上一个窗口的计数。正确的权重是「上一个窗口还有多少**没滑出去**」，也就是 `1 - 已过去的比例`。写反之后，窗口刚开始时几乎不计上一个窗口（该严的时候松），窗口快结束时全额计入（该松的时候严），行为完全颠倒。',
      "Inverting the weight in the sliding counter by multiplying the previous window's count by the elapsed fraction. The correct weight is how much of the previous window has not yet slid out, `1 - elapsed`. Inverted, it nearly ignores the previous window at the start (lenient when it should be strict) and counts it fully at the end (strict when it should be lenient) — exactly backwards."
    ),
    t(
      '固定窗口用 `setInterval` 定时清零，而不是按时间戳算当前属于哪个窗口。定时器和请求处理是两条独立的时间线，在虚拟时钟或者进程繁忙时会漂移；更麻烦的是它让限流器持有一个永不结束的定时器，测试里创建的每个实例都会泄漏一个。用 `Math.floor(now / windowMs)` 算窗口编号，是无状态的。',
      'Resetting a fixed window with `setInterval` instead of computing which window the current timestamp falls in. The timer and request handling are separate timelines that drift under load, and the limiter now holds a timer that never ends, leaking one per instance created in tests. `Math.floor(now / windowMs)` is stateless.'
    ),
    t(
      '认为滑动计数器只是「更省内存的滑动日志」，因此期待它给出完全一致的结果。它是**估算**：假设上一个窗口内的请求均匀分布。真实流量集中在窗口末尾时，它会低估；集中在开头时会高估。这个误差是设计的一部分，不是 bug——但要知道它存在。',
      'Treating the sliding counter as merely a cheaper sliding log and expecting identical answers. It is an estimate that assumes requests were uniform within the previous window. Real traffic clustered at the end of that window makes it underestimate, clustered at the start makes it overestimate. The error is part of the design, not a bug — but it should be known.'
    ),
  ],
  hints: [
    t(
      '固定窗口：`const windowId = Math.floor(now() / windowMs)`，windowId 变了就把计数清零。不需要定时器。',
      'Fixed window: `const windowId = Math.floor(now() / windowMs)`, and reset the count whenever the id changes. No timer needed.'
    ),
    t(
      '滑动计数器的估算值 = `上窗口计数 × (1 - 当前窗口已过去的比例) + 当前窗口计数`，拿它和 limit 比。',
      'The sliding counter estimate is `previousCount × (1 - elapsedFraction) + currentCount`, compared against the limit.'
    ),
  ],
  extension: t(
    [
      '这三种算法在工业界都有对应：Nginx 的 `limit_req` 用的是漏桶（下一关的令牌桶是它的对偶），',
      'Cloudflare 公开过他们用滑动计数器（他们叫 approximated sliding window），',
      '而滑动日志因为内存代价，通常只用在限额很小的场景，比如「同一个手机号一分钟最多发 1 条短信」。',
      '',
      'Cloudflare 那篇文章里给了滑动计数器的误差数据：在真实流量上，',
      '它与精确滑动日志的差异只有 0.003%，而内存从 O(请求数) 降到 O(1)。',
      '这是一个非常典型的工程取舍——用可量化的、很小的不精确，换掉一个数量级的资源开销。',
      '',
      '还有一个这一关没做的维度：**限流器本身的成本**。',
      '一个每秒处理十万请求的网关，限流判断会被调用十万次，',
      '所以它必须是 O(1) 且无锁的。滑动日志的 `filter` 是 O(n)，',
      '在限额大时会成为网关本身的瓶颈——限流器把自己限流了。',
      '真实实现通常用环形缓冲或者原子计数器，避免任何形式的数组遍历。',
    ].join('\n'),
    [
      'All three algorithms have industrial counterparts. Nginx\'s `limit_req` is a leaky bucket (the token',
      'bucket in the next stage is its dual), Cloudflare has published that they use a sliding counter —',
      'they call it an approximated sliding window — and sliding logs, because of their memory cost, are',
      'usually reserved for tiny limits such as "one SMS per phone number per minute".',
      '',
      "Cloudflare's write-up gives error figures for the sliding counter: against real traffic it differs",
      'from an exact sliding log by 0.003%, while memory drops from O(requests) to O(1). That is a very',
      'typical engineering trade — a small, quantified inaccuracy bought for an order of magnitude in',
      'resources.',
      '',
      'One dimension this stage skips: the cost of the limiter itself. A gateway serving a hundred thousand',
      'requests per second calls the admission check a hundred thousand times, so it must be O(1) and',
      "lock-free. A sliding log's `filter` is O(n) and becomes the gateway's own bottleneck at large limits",
      '— the rate limiter rate-limits itself. Real implementations use ring buffers or atomic counters and',
      'avoid array traversal of any kind.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'elegance'],
  lab: {},
  starterFiles: [
    contract,
    file(
      'src/window.ts',
      code`
        export interface WindowOptions {
          /** How many are admitted per window at most */
          limit: number;
          windowMs: number;
        }

        export interface Limiter {
          /** true when admitted, false when rate-limited */
          allow(): boolean;
          /**
           * How many state entries are retained, for comparing the memory cost of the three
           * implementations
           */
          size(): number;
        }

        export function createFixedWindow(options: WindowOptions): Limiter {
          // TODO: implement this
          throw new Error('not implemented');
        }

        export function createSlidingLog(options: WindowOptions): Limiter {
          // TODO: implement this
          throw new Error('not implemented');
        }

        export function createSlidingCounter(options: WindowOptions): Limiter {
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
        import { createFixedWindow, createSlidingCounter, createSlidingLog } from '../src/window';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const OPTIONS = { limit: 5, windowMs: 1000 };

        function admit(limiter: { allow(): boolean }, times: number): number {
          let allowed = 0;
          for (let index = 0; index < times; index += 1) if (limiter.allow()) allowed += 1;
          return allowed;
        }

        describe('Stage 1 · Steady-state behaviour of the three windows', () => {
          it('the fixed window admits limit requests', () => {
            expect(admit(createFixedWindow(OPTIONS), 8)).toBe(5);
          });

          it('the sliding log admits limit requests', () => {
            expect(admit(createSlidingLog(OPTIONS), 8)).toBe(5);
          });

          it('the sliding counter admits limit requests', () => {
            expect(admit(createSlidingCounter(OPTIONS), 8)).toBe(5);
          });

          it('allowance recovers once the window passes', async () => {
            const limiter = createFixedWindow(OPTIONS);
            expect(admit(limiter, 5)).toBe(5);
            expect(limiter.allow()).toBe(false);

            await sleep(1000);
            expect(limiter.allow()).toBe(true);
          });

          it('the sliding log recovers once the window passes too', async () => {
            const limiter = createSlidingLog(OPTIONS);
            expect(admit(limiter, 5)).toBe(5);
            await sleep(1001);
            expect(admit(limiter, 5)).toBe(5);
          });
        });

        describe('Stage 1 · Boundary bursts', () => {
          it('the fixed window admits double the traffic at a boundary', async () => {
            const limiter = createFixedWindow(OPTIONS);
            await sleep(900);
            const before = admit(limiter, 5);
            await sleep(100);
            const after = admit(limiter, 5);

            // Ten got through within 200ms, twice the limit
            expect(before + after).toBe(10);
          });

          it('the sliding log blocks the boundary burst', async () => {
            const limiter = createSlidingLog(OPTIONS);
            await sleep(900);
            const before = admit(limiter, 5);
            await sleep(100);
            const after = admit(limiter, 5);

            expect(before + after).toBeLessThanOrEqual(5);
          });

          it('the sliding counter blocks the boundary burst [gate:boundary]', async () => {
            const limiter = createSlidingCounter(OPTIONS);
            await sleep(900);
            const before = admit(limiter, 5);
            await sleep(100);
            const after = admit(limiter, 5);

            count('boundaryAdmitted', before + after);
            expect(before + after).toBeLessThanOrEqual(6);
          });

          it('the sliding counter weights in the right direction', async () => {
            const limiter = createSlidingCounter(OPTIONS);
            // Fill the previous window completely
            expect(admit(limiter, 5)).toBe(5);

            // Just into the new window: the previous one counts almost in full, so almost nothing gets in
            await sleep(1010);
            const early = admit(limiter, 10);

            // Near the end of the new window: the previous one has mostly slid out and the allowance is back
            await sleep(940);
            const late = admit(limiter, 10);

            // With the weight inverted (using elapsed instead of 1 - elapsed) these two numbers swap
            expect(early).toBeLessThanOrEqual(2);
            expect(late).toBeGreaterThan(early);
          });
        });

        describe('Stage 1 · Memory cost', () => {
          it("the sliding log's memory grows with request count", () => {
            const limiter = createSlidingLog({ limit: 400, windowMs: 1000 });
            admit(limiter, 300);
            expect(limiter.size()).toBeGreaterThanOrEqual(300);
          });

          it("the sliding counter's memory is bounded [gate:memory]", () => {
            const limiter = createSlidingCounter({ limit: 400, windowMs: 1000 });
            admit(limiter, 300);

            count('counterSlots', limiter.size());
            // Only the current and previous window counts are kept
            expect(limiter.size()).toBeLessThanOrEqual(4);
          });

          it("the fixed window's memory is bounded too", () => {
            const limiter = createFixedWindow({ limit: 400, windowMs: 1000 });
            admit(limiter, 300);
            expect(limiter.size()).toBeLessThanOrEqual(4);
          });

          it('rejected requests do not let the sliding log grow without bound', async () => {
            const limiter = createSlidingLog(OPTIONS);
            admit(limiter, 5);
            // Keep hammering; everything is rejected
            admit(limiter, 200);
            await sleep(1001);
            // Once the window passes, the expired timestamps should have been cleared
            limiter.allow();
            expect(limiter.size()).toBeLessThanOrEqual(OPTIONS.limit + 1);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.boundaryAdmitted',
      op: 'lte',
      value: 6,
      zh: '窗口边界上不放两倍流量',
      en: 'No double traffic at the window boundary',
      dimension: 'correctness',
      scope: 'gate:boundary',
    }),
    gate({
      metric: 'counters.counterSlots',
      op: 'lte',
      value: 4,
      unit: 'slots',
      zh: '滑动计数器的内存与请求数无关',
      en: "The sliding counter's memory is independent of request count",
      dimension: 'encapsulation',
      scope: 'gate:memory',
    }),
  ],
  referenceFiles: [
    file(
      'src/window.ts',
      code`
        import { now } from '@lab/env';

        export interface WindowOptions {
          limit: number;
          windowMs: number;
        }

        export interface Limiter {
          allow(): boolean;
          size(): number;
        }

        export function createFixedWindow(options: WindowOptions): Limiter {
          let windowId = -1;
          let used = 0;

          return {
            allow(): boolean {
              // Derive the window number from the timestamp rather than using a timer: timers and request
              // handling are two independent timelines, and a timer leaks one never-ending handle
              // per instance
              const current = Math.floor(now() / options.windowMs);
              if (current !== windowId) {
                windowId = current;
                used = 0;
              }
              if (used >= options.limit) return false;
              used += 1;
              return true;
            },

            size(): number {
              return 2;
            },
          };
        }

        export function createSlidingLog(options: WindowOptions): Limiter {
          const stamps: number[] = [];

          function prune(at: number): void {
            const cutoff = at - options.windowMs;
            while (stamps.length > 0 && stamps[0] <= cutoff) stamps.shift();
          }

          return {
            allow(): boolean {
              const at = now();
              // Cleanup goes first so rejected requests reach it too.
              // Cleaning only on the admit path lets a permanently throttled client pile up the array forever
              prune(at);
              if (stamps.length >= options.limit) return false;
              stamps.push(at);
              return true;
            },

            size(): number {
              prune(now());
              return stamps.length;
            },
          };
        }

        export function createSlidingCounter(options: WindowOptions): Limiter {
          let windowId = -1;
          let current = 0;
          let previous = 0;

          function roll(at: number): void {
            const id = Math.floor(at / options.windowMs);
            if (id === windowId) return;
            // One window back the previous count still means something; further back, zero everything out
            previous = id === windowId + 1 ? current : 0;
            current = 0;
            windowId = id;
          }

          return {
            allow(): boolean {
              const at = now();
              roll(at);

              const elapsed = (at % options.windowMs) / options.windowMs;
              // The weight is how much of the previous window has not slid out yet, i.e. 1 - the
              // elapsed fraction.
              // Writing elapsed instead inverts the behaviour completely
              const estimated = previous * (1 - elapsed) + current;
              if (estimated >= options.limit) return false;
              current += 1;
              return true;
            },

            size(): number {
              return 3;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**三种实现的 `size()` 都是常数，除了滑动日志。** 这个方法存在的唯一目的是让',
      '「内存代价」这件事可以被测出来，而不是停留在文档里的一句话。',
      '滑动日志返回的是真实的数组长度，所以门槛能直接量到它和滑动计数器的差别。',
      '',
      '**`prune` 在 `allow` 的最开头调用。** 顺序很重要：先清过期的，再判断是否超限。',
      '反过来的话，一个刚好在窗口边缘的请求会被旧数据挡住。',
      '更关键的是它在**被拒绝的路径上也执行**——一个被持续限流的客户端',
      '同样在推进时间，只在放行时清理会让数组无限增长。',
      '',
      '**滑动计数器的 `roll` 区分「跨了一个窗口」和「跨了很多个」。**',
      '闲置十分钟之后回来，上一个窗口的计数早就没有参考价值了，',
      '直接当 0。不区分的话，久违的第一个请求会被十分钟前的流量挡住。',
      '',
      '**固定窗口用 `Math.floor(now() / windowMs)` 而不是定时器。** 它是无状态的：',
      '任何时刻问「现在是第几个窗口」都得到同一个答案，不依赖有没有人在定时清零。',
      '这也让限流器变成一个纯粹的数据结构，不持有任何需要清理的资源。',
    ].join('\n'),
    [
      'Every implementation reports a constant `size()` except the sliding log. That method exists purely',
      'so the memory cost is measurable rather than a sentence in the documentation; the sliding log',
      'returns its real array length, so the gate can measure the difference directly.',
      '',
      '`prune` runs at the very top of `allow`. Order matters: expire first, then decide, because the other',
      'way a request right at the window edge is blocked by stale data. More importantly it runs on the',
      'rejection path too — a client being throttled continuously still advances time, and pruning only on',
      'admission lets the array grow without bound.',
      '',
      "The sliding counter's `roll` distinguishes crossing one window from crossing many. After ten idle",
      'minutes the previous window has no predictive value and is treated as zero; without that',
      'distinction, the first request after a long gap is blocked by traffic from ten minutes ago.',
      '',
      'The fixed window uses `Math.floor(now() / windowMs)` rather than a timer. It is stateless — asking',
      '"which window is it" at any instant gives the same answer without depending on anyone having reset',
      'a counter — and it keeps the limiter a pure data structure holding no resource that needs cleaning up.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage2 = {
  id: 'token-bucket',
  title: t('第 2 关 · 令牌桶限流', 'Stage 2 · Token bucket rate limiting'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '网关要保护的第一件事是下游的速率：合作方允许突发，但长期平均速率有硬上限。',
      '令牌桶正好同时表达这两件事 —— 桶的容量就是能容忍的突发，补充速率就是长期上限。',
      '',
      '## 要实现什么',
      '',
      '在 `src/rateLimiter.ts` 实现 `createTokenBucket({ capacity, refillPerSecond })`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `tryAcquire(count)` | 拿得到就扣减返回 `true`，拿不到**立刻**返回 `false`，绝不等待 |',
      '| `acquire(count)` | 等到有足够令牌为止 |',
      '| `available()` | 当前可用令牌数（向下取整），补充上限是 `capacity` |',
      '',
      '令牌要**惰性补充**：不要用 `setInterval` 定时加令牌，而是在桶被访问时，',
      '按距离上次补充过了多久，算出这段时间应该补多少。',
      '',
      '## 怎么算过',
      '',
      '- 一开始是满桶，能一次性放掉一整个 `capacity` 的突发；',
      '- 桶空之后按 `refillPerSecond` 恢复，且永远不超过 `capacity`；',
      '- `tryAcquire` 拿不到时不阻塞，也**一个令牌都不扣**；',
      '- `acquire` 等的时间刚好够补上缺口，不多睡也不轮询',
      '  （门槛 `virtualElapsedMs ≤ 360`）。',
      '',
      '## 为什么门槛量的是等待时长',
      '',
      '`acquire` 最偷懒的写法是 `while (!tryAcquire()) await sleep(10)`。功能是对的，',
      '但每轮都要多睡最多 10ms，而且轮数随缺口线性增长。',
      '正确做法是**算出来**：还差 `missing` 个令牌，就睡 `missing / refillPerSecond` 秒，',
      '一觉睡到刚好补够。虚拟时钟会把这两种写法的差距原样量出来。',
      '',
      '另一个坑是用定时器补令牌。定时器和请求处理是两条独立的时间线，负载下会漂移；',
      '而且每个桶都会持有一个永不结束的 timer，测试里创建多少个实例就泄漏多少个。',
      '惰性补充没有这个问题 —— 它不持有任何东西，只是算术。',
    ].join('\n'),
    [
      'The first thing a gateway protects is the downstream rate: partners tolerate bursts but cap the',
      'long-run average. A token bucket expresses both at once — capacity is the burst you can absorb,',
      'refill rate is the long-run ceiling.',
      '',
      '## What to build',
      '',
      '`createTokenBucket({ capacity, refillPerSecond })` in `src/rateLimiter.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `tryAcquire(count)` | Take tokens and return `true`, or return `false` **immediately** — never waits |',
      '| `acquire(count)` | Wait until enough tokens exist |',
      '| `available()` | Currently available tokens (floored), refilled up to `capacity` |',
      '',
      'Refill **lazily**: do not add tokens on a `setInterval`; when the bucket is touched, compute from the',
      'elapsed time how many should have arrived.',
      '',
      '## What counts as passing',
      '',
      '- The bucket starts full and can release a whole `capacity` burst at once;',
      '- Once drained it recovers at `refillPerSecond` and never exceeds `capacity`;',
      '- `tryAcquire` does not block when it fails, and consumes **nothing**;',
      '- `acquire` waits exactly long enough to cover the shortfall — no oversleeping, no polling',
      '  (`virtualElapsedMs ≤ 360`).',
      '',
      '## Why the gate measures waiting time',
      '',
      'The lazy way to write `acquire` is `while (!tryAcquire()) await sleep(10)`. It works, but every round',
      'oversleeps by up to 10ms and the number of rounds grows with the shortfall. The right way is to',
      '**compute** it: short by `missing` tokens means sleeping `missing / refillPerSecond` seconds, waking',
      'exactly when the bucket is full enough. The virtual clock reports the difference verbatim.',
      '',
      'The other trap is refilling on a timer. The timer and request handling are separate timelines that',
      'drift under load, and every bucket then holds a timer that never ends — one leaked per instance',
      'created in tests. Lazy refill holds nothing at all; it is only arithmetic.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  TRY["tryAcquire(count)"] --> REF',
      '  ACQ["acquire(count)"] --> REF',
      '  AVA["available()"] --> REF',
      '  REF["refill() —— 唯一的补充处，没有定时器<br/>elapsed = now - lastRefillAt<br/>tokens = min(capacity, tokens + elapsed 秒 × refillPerSecond)<br/>lastRefillAt = now"]',
      '  REF --> BR{"谁触发的？"}',
      '  BR -- "available()" --> FL["返回 floor(tokens)"]',
      '  BR -- "tryAcquire / acquire" --> CMP{"take(count)：tokens ≥ count？"}',
      '  CMP -- 是 --> OK["tokens -= count → true"]',
      '  CMP -- 否 --> WHO{"是哪一个在调用？"}',
      '  WHO -- tryAcquire --> RETF["立刻返回 false<br/>不扣减、不阻塞"]',
      '  WHO -- acquire --> SLEEP["missing = count - tokens<br/>sleep(missing / refillPerSecond)<br/>睡到刚好补够，不轮询"]',
      '  SLEEP --> REF',
      '```',
      '',
      '要点：桶只有 `tokens` 和 `lastRefillAt` 两个状态，三个公开方法**全部先过 `refill()`** ——',
      '时间的流逝只在这一处变成令牌，别处不许直接改 `tokens`。',
      '`tryAcquire` 和 `acquire` 共用同一个 `take()`，区别只在拿不到之后往哪走：',
      '一个直接返回，一个算出缺口睡过去再回到同一个入口。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  TRY["tryAcquire(count)"] --> REF',
      '  ACQ["acquire(count)"] --> REF',
      '  AVA["available()"] --> REF',
      '  REF["refill() — the only refill site, no timer<br/>elapsed = now - lastRefillAt<br/>tokens = min(capacity, tokens + elapsed seconds × refillPerSecond)<br/>lastRefillAt = now"]',
      '  REF --> BR{"who called?"}',
      '  BR -- "available()" --> FL["return floor(tokens)"]',
      '  BR -- "tryAcquire / acquire" --> CMP{"take(count): tokens ≥ count?"}',
      '  CMP -- yes --> OK["tokens -= count → true"]',
      '  CMP -- no --> WHO{"which caller?"}',
      '  WHO -- tryAcquire --> RETF["return false at once<br/>consumes nothing, blocks nothing"]',
      '  WHO -- acquire --> SLEEP["missing = count - tokens<br/>sleep(missing / refillPerSecond)<br/>wake exactly when full enough, no polling"]',
      '  SLEEP --> REF',
      '```',
      '',
      'The point: the bucket holds only `tokens` and `lastRefillAt`, and all three public methods **go',
      'through `refill()` first** — elapsed time turns into tokens in exactly one place, and nothing else may',
      'touch `tokens` directly. `tryAcquire` and `acquire` share the same `take()`; they differ only in where',
      'they go on failure — one returns, the other computes the shortfall, sleeps it off, and re-enters at',
      'the same door.',
    ].join('\n')
  ),
  checklist: [
    t('初始是满桶，允许突发', 'Starts full so bursts are allowed'),
    t('按时间惰性补充，且不超过 capacity', 'Lazy refill capped at capacity'),
    t('acquire 会等到有令牌', 'acquire waits for a token'),
    t('长期速率不超过 refillPerSecond', 'Long-run rate stays within refillPerSecond'),
  ],
  pitfalls: [
    t(
      '用 `setInterval` 定时补令牌：没有流量时也在空转；进程被挂起（休眠、GC 长停顿、容器被限流）后无法追平时间；还得记得清理定时器，否则组件永远不会被 GC。',
      'Refilling on a `setInterval` spins with no traffic, cannot catch up after the process is suspended (sleep, GC pause, cgroup throttling), and leaks unless you remember to clear it.'
    ),
    t(
      '两次访问隔了 5 秒，桶里却只多了 1 个令牌。这是把补充写成 `tokens += 1` 的后果，正确做法是按经过的时间算，否则实际速率会远低于你配置的值。',
      'Five seconds pass between two calls and the bucket gained exactly one token. That is what `tokens += 1` does instead of computing from elapsed time, and the real rate ends up far below the configured one.'
    ),
    t(
      '`acquire` 里每 10ms 轮询一次：能跑通，但引入了与真实等待无关的抖动，而且高并发下这些轮询本身就是开销。直接睡到「刚好补够」的时刻。',
      'Polling every 10ms inside `acquire` works but adds jitter unrelated to the real wait, and the polling itself becomes overhead under load. Sleep exactly until enough tokens exist.'
    ),
    t(
      '把 `tokens` 存成整数并向下取整：小数部分被反复丢弃，长期速率会系统性偏低。内部保留小数，只在 `available()` 对外暴露时取整。',
      'Storing `tokens` as an integer discards the fractional part on every refill, so the long-run rate drifts systematically low. Keep it fractional internally and only floor in `available()`.'
    ),
  ],
  hints: [
    t(
      '记录 lastRefillAt，每次访问先算 elapsed * refillPerSecond / 1000，再和 capacity 取 min。',
      'Track lastRefillAt; on each touch add elapsed * refillPerSecond / 1000 and clamp to capacity.'
    ),
    t(
      'acquire 里算出「还差多少令牌」，直接 sleep 对应的时长，比每 10ms 轮询更省也更准。',
      'In acquire, compute how many tokens are missing and sleep exactly that long instead of polling every 10ms.'
    ),
    t(
      '时间要用 @lab/env 的 now()，它跑在虚拟时钟上。',
      'Read time from now() in @lab/env, it runs on the virtual clock.'
    ),
  ],
  extension: t(
    [
      '### 令牌桶 vs 漏桶',
      '',
      '两者常被混为一谈，但行为完全不同：',
      '',
      '| | 令牌桶 | 漏桶 |',
      '| --- | --- | --- |',
      '| 突发 | **允许**（桶里攒着令牌） | 不允许（恒定速率流出） |',
      '| 适合 | 对外 API 配额，允许用户攒一波再打 | 平滑流量，保护脆弱下游 |',
      '',
      '本关做的是令牌桶，`capacity` 就是允许的突发大小。',
      '如果你希望完全平滑，把 `capacity` 设成 1 就近似退化成漏桶了。',
      '',
      '### 真实实现',
      '',
      '- Guava 的 `RateLimiter`（Java）用的就是惰性补充，还支持 warm-up 模式；',
      '- Nginx 的 `limit_req` 是漏桶，`burst` 参数给了一点突发余量；',
      '- Redis 的 `CL.THROTTLE`（redis-cell 模块）实现了 GCRA，是令牌桶的等价变体；',
      '- 云厂商的 API 配额几乎都是令牌桶，这也是为什么你能「攒着不用，然后突然打一波」。',
      '',
      '### 分布式限流',
      '',
      '本关是**单进程**的。多实例部署时，每个实例各限 10 QPS，10 个实例就是 100 QPS。',
      '真实做法是把令牌桶的状态放到 Redis（用 Lua 脚本保证原子性），',
      '或者退一步做「本地配额分配」：中心节点周期性地给每个实例分配一部分配额，',
      '牺牲一点精度换取不依赖中心节点的可用性。',
    ].join('\n'),
    [
      '### Token bucket vs leaky bucket',
      '',
      'Often conflated, but they behave differently:',
      '',
      '| | Token bucket | Leaky bucket |',
      '| --- | --- | --- |',
      '| Bursts | **Allowed** (tokens accumulate) | Not allowed (constant drain) |',
      '| Fits | Public API quotas, letting clients save up | Smoothing traffic for a fragile dependency |',
      '',
      'This stage builds a token bucket, `capacity` *is* the permitted burst size.',
      'Set `capacity` to 1 and you approximate a leaky bucket.',
      '',
      '### Real implementations',
      '',
      "- Guava's `RateLimiter` (Java) uses lazy refill and adds a warm-up mode;",
      "- Nginx's `limit_req` is a leaky bucket, with `burst` allowing a little slack;",
      '- Redis `CL.THROTTLE` (redis-cell) implements GCRA, an equivalent formulation;',
      '- Cloud API quotas are almost always token buckets, which is why you can save up and then burst.',
      '',
      '### Distributed rate limiting',
      '',
      'This stage is single-process. Deploy ten instances each limiting 10 QPS and you have 100 QPS.',
      'Production answers: keep the bucket state in Redis (a Lua script for atomicity), or hand out',
      'local quota, a central node periodically allocates a slice to each instance, trading precision',
      'for not depending on that node being reachable.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'encapsulation'],
  lab: {},
  starterFiles: [
    contract,
    file(
      'src/rateLimiter.ts',
      code`
        export interface TokenBucketOptions {
          /** Bucket capacity, which is also the burst size allowed */
          capacity: number;
          /** Tokens refilled per second */
          refillPerSecond: number;
        }

        export interface TokenBucket {
          tryAcquire(count?: number): boolean;
          acquire(count?: number): Promise<void>;
          available(): number;
        }

        export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
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
        import { createTokenBucket } from '../src/rateLimiter';
        import { now, sleep } from '@lab/env';

        describe('Stage 2 · Token bucket', () => {
          it('starts full and allows one burst', () => {
            const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 10 });
            expect(bucket.available()).toBe(5);
            for (let index = 0; index < 5; index += 1) {
              expect(bucket.tryAcquire()).toBe(true);
            }
            expect(bucket.tryAcquire()).toBe(false);
            expect(bucket.available()).toBe(0);
          });

          it('refills lazily based on elapsed time', async () => {
            const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 10 });
            for (let index = 0; index < 5; index += 1) bucket.tryAcquire();

            await sleep(100);
            expect(bucket.available()).toBe(1);
            await sleep(200);
            expect(bucket.available()).toBe(3);
          });

          it('refilling never exceeds capacity', async () => {
            const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 10 });
            bucket.tryAcquire(5);
            await sleep(10000);
            expect(bucket.available()).toBe(5);
          });

          it('tryAcquire does not wait, acquire does', async () => {
            const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 10 });
            expect(bucket.tryAcquire()).toBe(true);
            expect(bucket.tryAcquire()).toBe(false);

            const startedAt = now();
            await bucket.acquire();
            expect(now() - startedAt).toBe(100);
          });

          it('the long-run rate stays controlled after a burst [gate:rate]', async () => {
            const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 10 });
            const startedAt = now();
            for (let index = 0; index < 6; index += 1) {
              await bucket.acquire();
            }
            const elapsed = now() - startedAt;
            // A burst of 3 plus 3 more refilled at 100ms each
            expect(elapsed).toBeGreaterThanOrEqual(300);
            expect(elapsed).toBeLessThanOrEqual(360);
          });

          it('several tokens can be taken at once', () => {
            const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 10 });
            expect(bucket.tryAcquire(3)).toBe(true);
            expect(bucket.available()).toBe(2);
            expect(bucket.tryAcquire(3)).toBe(false);
            expect(bucket.available()).toBe(2);
          });

          it('taking several tokens waits until all of them are refilled', async () => {
            const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 10 });
            bucket.tryAcquire(5);

            const startedAt = now();
            await bucket.acquire(3);
            // 3 tokens = 300ms
            expect(now() - startedAt).toBeGreaterThanOrEqual(300);
          });

          it('refill is proportional to elapsed time rather than a fixed increment', async () => {
            const bucket = createTokenBucket({ capacity: 10, refillPerSecond: 10 });
            bucket.tryAcquire(10);

            await sleep(500);
            // 500ms * 10/s = 5 tokens
            expect(bucket.available()).toBe(5);
          });

          it('the fraction is kept internally so repeated rounding does not bias it low', async () => {
            const bucket = createTokenBucket({ capacity: 10, refillPerSecond: 10 });
            bucket.tryAcquire(10);

            // Advance in ten steps of 50ms each (half a token)
            for (let index = 0; index < 10; index += 1) {
              await sleep(50);
              bucket.available();
            }
            // 500ms in total should be 5 tokens; rounding the fraction away leaves 0
            expect(bucket.available()).toBe(5);
          });

          it('stays correct with no traffic and without any timer', async () => {
            const bucket = createTokenBucket({ capacity: 4, refillPerSecond: 10 });
            bucket.tryAcquire(4);

            // Leave it completely untouched for a long time
            await sleep(5000);
            expect(bucket.available()).toBe(4);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 360,
      unit: 'ms',
      zh: '限流等待不过度浪费',
      en: 'Rate limit waiting is not wasteful',
      dimension: 'latency',
      scope: 'gate:rate',
    }),
  ],
  referenceFiles: [
    file(
      'src/rateLimiter.ts',
      code`
        import { now, sleep } from '@lab/env';

        export interface TokenBucketOptions {
          capacity: number;
          refillPerSecond: number;
        }

        export interface TokenBucket {
          tryAcquire(count?: number): boolean;
          acquire(count?: number): Promise<void>;
          available(): number;
        }

        export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
          let tokens = options.capacity;
          let lastRefillAt = now();

          function refill(): void {
            const current = now();
            const elapsed = current - lastRefillAt;
            if (elapsed <= 0) return;
            tokens = Math.min(options.capacity, tokens + (elapsed * options.refillPerSecond) / 1000);
            lastRefillAt = current;
          }

          function take(count: number): boolean {
            refill();
            if (tokens + 1e-9 < count) return false;
            tokens -= count;
            return true;
          }

          return {
            available() {
              refill();
              return Math.floor(tokens + 1e-9);
            },

            tryAcquire(count = 1) {
              return take(count);
            },

            async acquire(count = 1) {
              while (!take(count)) {
                const missing = count - tokens;
                // Sleep straight to the moment it is refilled, with no pointless polling
                await sleep(Math.max(1, Math.ceil((missing / options.refillPerSecond) * 1000)));
              }
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    '惰性补充把「时间」变成了纯函数的输入：桶的状态只依赖 (tokens, lastRefillAt, now)，因此可测试、可复现，也不会在空闲时烧 CPU。',
    'Lazy refill turns time into a pure input: state depends only on (tokens, lastRefillAt, now), so it is testable, reproducible and burns nothing while idle.'
  ),
};

/* ------------------------------------------------------------------ */

const stage3 = {
  id: 'quota',
  title: t('第 3 关 · 多维限流与配额', 'Stage 3 · Multi-dimensional quotas'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前两关的限流器只有一个维度：整体多少 QPS。真实网关不够用 ——',
      '你要同时限「每个用户」「每个 IP」「每个接口」，而一个请求同时属于这三者。',
      '',
      '## 要实现什么',
      '',
      '在 `src/quota.ts` 实现 `createQuotaLimiter(rules)`，规则形如',
      '`{ dimension: \'user\', limit: 100, windowMs: 1000 }`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `allow({ user, ip, route })` | **所有**命中的规则都放行才算放行；返回 `{ allowed, limitedBy }` |',
      '| `remaining(dimension, value)` | 某个具体主体还剩多少额度 |',
      '',
      '`limitedBy` 不是装饰：没有它，客户端收到 429 之后无从判断该降频还是该换 IP。',
      '',
      '两个细节容易写错：计数器的键必须是「维度 + 值」，只用维度当键会让所有用户共用一个计数器；',
      '请求里没带某个维度时，那条规则**不适用**，而不是把 `undefined` 当成一个主体值。',
      '',
      '## 怎么算过',
      '',
      '- 多维度同时生效，任一条超限即拒绝；',
      '- `limitedBy` 指向真正拒绝的那条规则；',
      '- 窗口过去后各维度独立恢复；',
      '- 被拒绝的请求**不消耗任何维度**的配额',
      '  （门槛 `counters.userRemaining ≥ 95`）。',
      '',
      '## 判断和扣减必须分成两步',
      '',
      '直觉写法是「遍历规则，逐条判断并扣减」。它在全部通过时是对的，',
      '在任何一条拒绝时都是错的：排在前面的规则已经扣过了。',
      '',
      '于是一个被 IP 规则挡住的请求，照样消耗掉了这个用户的额度 ——',
      '攻击者用一个 IP 打满，就能顺带把受害用户的配额一起烧光。',
      '门槛量的就是这件事：IP 规则挡住 15 个请求之后，用户维度的剩余额度必须几乎没动。',
    ].join('\n'),
    [
      'The limiters so far have one dimension: overall QPS. A real gateway needs more — per user, per IP',
      'and per route at once, while a single request belongs to all three.',
      '',
      '## What to build',
      '',
      '`createQuotaLimiter(rules)` in `src/quota.ts`, where a rule looks like',
      '`{ dimension: \'user\', limit: 100, windowMs: 1000 }`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `allow({ user, ip, route })` | Admits only when **every** matching rule admits; returns `{ allowed, limitedBy }` |',
      '| `remaining(dimension, value)` | What a specific subject has left |',
      '',
      '`limitedBy` is not decoration: without it, a client receiving a 429 cannot tell whether to slow down',
      'or to change address.',
      '',
      'Two details are easy to get wrong. A counter\'s key must be dimension **plus value** — keyed by',
      'dimension alone, every user shares one counter. And when a request carries no value for a dimension,',
      'that rule simply **does not apply**, rather than treating `undefined` as a subject.',
      '',
      '## What counts as passing',
      '',
      '- Several dimensions apply at once, and exceeding any one refuses;',
      '- `limitedBy` names the rule that actually refused;',
      '- Each dimension recovers independently once its window passes;',
      '- A rejected request consumes quota in **no** dimension (`counters.userRemaining ≥ 95`).',
      '',
      '## Checking and consuming must be two phases',
      '',
      'The intuitive implementation walks the rules, deciding and consuming as it goes. That is correct when',
      'everything passes and wrong whenever anything refuses, because the earlier rules already consumed.',
      '',
      'So a request blocked by the IP rule still burns that user\'s allowance — an attacker saturating one IP',
      'drains the victim\'s quota for free. The gate measures exactly this: after the IP rule blocks fifteen',
      'requests, the user dimension must be essentially untouched.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  IN["allow({ user, ip, route })"] --> APP["applicable()<br/>只留请求里真的带了值的维度<br/>没带 ≠ 值为 undefined"]',
      '  APP --> P1',
      '',
      '  subgraph phase1["第一趟：只判断，一个计数器都不动"]',
      '    P1["取下一条规则"] --> CF["counterFor(rule, value)<br/>键 = 维度 + \':\' + 值<br/>窗口号变了就换一个新计数器"]',
      '    CF --> CHK{"used ≥ limit？"}',
      '    CHK -- 是 --> DENY["allowed: false<br/>limitedBy = 这条规则的维度<br/>直接返回，没扣过任何东西"]',
      '    CHK -- 否 --> NEXT{"还有规则吗？"}',
      '    NEXT -- 有 --> P1',
      '  end',
      '',
      '  NEXT -- 没有了 --> P2',
      '',
      '  subgraph phase2["第二趟：确定全过了，才统一扣减"]',
      '    P2["再遍历一遍命中的规则"] --> INC["counterFor(...).used += 1"]',
      '    INC --> PASS["allowed: true, limitedBy: null"]',
      '  end',
      '',
      '  REM["remaining(dimension, value)"] --> CF',
      '```',
      '',
      '要点：图里 `phase1` 和 `phase2` 之间那条边，就是这一关的全部。',
      '把 `INC` 挪进 `phase1` 的循环里，代码会短两行，',
      '然后每一个被后面规则拒掉的请求，都会把前面维度的配额白白烧掉。',
      '',
      '`counterFor` 被三处共用（判断、扣减、`remaining`），窗口滚动的逻辑因此只有一份 ——',
      '否则 `remaining` 很容易报的是上一个窗口的余量。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  IN["allow({ user, ip, route })"] --> APP["applicable()<br/>keep only dimensions the request actually carries<br/>absent ≠ a value of undefined"]',
      '  APP --> P1',
      '',
      '  subgraph phase1["Phase 1: decide only, touch no counter"]',
      '    P1["take the next rule"] --> CF["counterFor(rule, value)<br/>key = dimension + \':\' + value<br/>a new window id means a fresh counter"]',
      '    CF --> CHK{"used ≥ limit?"}',
      '    CHK -- yes --> DENY["allowed: false<br/>limitedBy = this rule\'s dimension<br/>return having consumed nothing"]',
      '    CHK -- no --> NEXT{"any rules left?"}',
      '    NEXT -- yes --> P1',
      '  end',
      '',
      '  NEXT -- no --> P2',
      '',
      '  subgraph phase2["Phase 2: everything passed, now consume"]',
      '    P2["walk the matched rules again"] --> INC["counterFor(...).used += 1"]',
      '    INC --> PASS["allowed: true, limitedBy: null"]',
      '  end',
      '',
      '  REM["remaining(dimension, value)"] --> CF',
      '```',
      '',
      'The point: the edge between `phase1` and `phase2` is this entire stage. Move `INC` inside the',
      '`phase1` loop and the code gets two lines shorter — and every request refused by a later rule burns',
      'the earlier dimensions\' quota for nothing.',
      '',
      '`counterFor` is shared by all three call sites (checking, consuming, `remaining`), so window rolling',
      'lives in exactly one place — otherwise `remaining` easily reports the previous window\'s balance.',
    ].join('\n')
  ),
  checklist: [
    t('所有命中的规则都放行才放行', 'Admission requires every matching rule to agree'),
    t('limitedBy 指出是哪一条规则挡的', 'limitedBy names the rule that refused'),
    t('被拒绝时不消耗任何维度的额度', 'A rejection consumes no allowance in any dimension'),
    t('不同主体的额度互相独立', 'Different subjects have independent allowances'),
    t('请求没带某个维度时该规则不生效', 'A rule does not apply when its dimension is absent'),
  ],
  pitfalls: [
    t(
      '边判断边扣减。第一条规则放行并扣了 1，第二条规则拒绝——这个请求既没被放行，又消耗了第一个维度的配额。攻击面很直接：用一个被限流的 IP 持续打，受害用户的配额会被无声地烧光，而日志里只看得到「IP 被限流」。',
      'Deciding and consuming in one pass. The first rule admits and decrements, the second refuses — the request was not served and still consumed the first dimension. The attack is direct: hammer from one throttled IP and the victim\'s quota drains silently, while the logs only show "IP throttled".'
    ),
    t(
      '把所有维度的计数存在一个以 dimension 为键的 Map 里，忽略具体的值。`user` 这一条规则会被所有用户共用一个计数器，于是 alice 用满之后 bob 也被限流。键必须是 `dimension + 值` 的组合。',
      'Keying counters by dimension alone, ignoring the value. All users then share one counter for the `user` rule, so bob is throttled once alice has saturated hers. The key must combine dimension and value.'
    ),
    t(
      '请求里缺某个维度时（比如匿名请求没有 user），把它当成 `undefined` 这个值去计数。所有匿名请求于是共享一个「user=undefined」的桶，互相挤占——而正确的语义是这条规则对它们**不适用**。缺失的维度应该被跳过，不是被当成一个特殊值。',
      "Treating a missing dimension — an anonymous request with no user — as the value `undefined`. Every anonymous request then shares one bucket and they crowd each other out, when the correct semantics is that the rule does not apply. A missing dimension should be skipped, not turned into a special value."
    ),
    t(
      '`limitedBy` 返回所有被拒的规则组成的数组。听起来信息更全，但两阶段判断在发现第一条拒绝时就该停下——继续判断剩下的规则没有意义，还会让「哪一条最先挡住」这个最有用的信息被淹没。真实网关的 429 响应里也只会告诉你一个原因。',
      'Returning every refusing rule as an array in `limitedBy`. It sounds more informative, but two-phase checking should stop at the first refusal: evaluating the rest adds nothing and buries the single most useful fact, which is what blocked first. A real gateway\'s 429 reports one reason too.'
    ),
  ],
  hints: [
    t(
      '两阶段：先 `for` 一遍所有命中的规则只做判断，任何一条不过就直接返回；全过了再 `for` 第二遍统一扣减。两个循环比一个循环加回滚简单得多。',
      'Two phases: loop once over the matching rules deciding only, returning early on any refusal; loop a second time to consume once everything agreed. Two loops are far simpler than one loop plus rollback.'
    ),
    t(
      '每个「维度 + 值」组合各自持有一个上一关的滑动计数器。键用 `dimension + \':\' + value` 拼出来就够了。',
      "Give each dimension-and-value pair its own sliding counter from the previous stage, keyed by `dimension + ':' + value`."
    ),
  ],
  extension: t(
    [
      '「先判断再扣减」这个模式在真实系统里比这一关还难，因为规则可能分布在不同的存储上：',
      '用户配额在 Redis，IP 配额在本地内存，接口配额在配置中心。',
      '两阶段变成了一个跨存储的分布式事务——而没人会为限流做真的两阶段提交。',
      '',
      '工业界的妥协是**乐观扣减 + 补偿**：全部扣掉，发现某一条不过就把已经扣的还回去。',
      '还回去这一步不保证成功（网络可能断），所以配额会有微小的泄漏，',
      '但限流本来就是近似的，泄漏几个额度远比引入分布式事务划算。',
      '',
      '维度设计本身也有讲究。维度越多，键的基数（cardinality）越高——',
      '「每个用户每个接口」这种组合维度，在一百万用户、一千个接口时就是十亿个键。',
      '所以真实网关通常只对少数几个高价值维度做精确限流，其余的用采样或者粗粒度兜底。',
      '这和监控系统里「高基数标签会撑爆时序数据库」是同一个问题。',
      '',
      '还有一个方向是**配额而非速率**：速率限的是「每秒多少」，配额限的是「每月多少」。',
      '两者的实现完全不同——配额需要持久化（进程重启不能清零）、需要精确（少扣一次就是少收一次钱），',
      '所以它通常直接落在数据库的事务里，而不是内存计数器。',
    ].join('\n'),
    [
      'Check-then-consume is harder in real systems than here, because rules can live in different stores:',
      'user quota in Redis, IP quota in local memory, route quota in a config service. Two-phase becomes a',
      'distributed transaction across stores — and nobody runs real two-phase commit for rate limiting.',
      '',
      'The industry compromise is optimistic consumption with compensation: decrement everything, and give',
      'back what you took when something refuses. The giving back is not guaranteed (the network may fail),',
      'so quota leaks slightly — but rate limiting is approximate anyway, and leaking a few units beats',
      'introducing a distributed transaction.',
      '',
      'Dimension design matters too. More dimensions means higher key cardinality: a combined "per user per',
      'route" dimension is a billion keys at a million users and a thousand routes. So real gateways limit',
      'precisely on a few high-value dimensions and fall back to sampling or coarse buckets for the rest.',
      'It is the same problem as high-cardinality labels overwhelming a time-series database.',
      '',
      'A different axis is quota rather than rate: rate limits per second, quota limits per month. Their',
      'implementations diverge completely — quota must be durable (a restart cannot reset it) and exact (an',
      'undercount is unbilled revenue) — so it usually lives inside database transactions rather than in an',
      'in-memory counter.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/quota.ts',
      code`
        export interface QuotaRule {
          /** Which dimension this rule applies to, e.g. 'user' / 'ip' / 'route' */
          dimension: string;
          limit: number;
          windowMs: number;
        }

        export interface QuotaDecision {
          allowed: boolean;
          /** Which dimension rejected it, or null when admitted */
          limitedBy: string | null;
        }

        export interface QuotaLimiter {
          allow(dimensions: Record<string, string>): QuotaDecision;
          /** How much allowance a given subject has left */
          remaining(dimension: string, value: string): number;
        }

        export function createQuotaLimiter(rules: QuotaRule[]): QuotaLimiter {
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
        import { createQuotaLimiter } from '../src/quota';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const RULES = [
          { dimension: 'user', limit: 100, windowMs: 1000 },
          { dimension: 'ip', limit: 5, windowMs: 1000 },
          { dimension: 'route', limit: 50, windowMs: 1000 },
        ];

        const REQUEST = { user: 'alice', ip: '1.2.3.4', route: '/search' };

        describe('Stage 3 · Multi-dimensional limiting', () => {
          it('admits when every dimension has allowance left', () => {
            const limiter = createQuotaLimiter(RULES);
            const decision = limiter.allow(REQUEST);
            expect(decision.allowed).toBe(true);
            expect(decision.limitedBy).toBeNull();
          });

          it('the tightest dimension sets the ceiling', () => {
            const limiter = createQuotaLimiter(RULES);
            let allowed = 0;
            for (let index = 0; index < 20; index += 1) {
              if (limiter.allow(REQUEST).allowed) allowed += 1;
            }
            // ip is capped at 5, the tightest of the three
            expect(allowed).toBe(5);
          });

          it('limitedBy names the dimension that rejected it', () => {
            const limiter = createQuotaLimiter(RULES);
            for (let index = 0; index < 5; index += 1) limiter.allow(REQUEST);
            expect(limiter.allow(REQUEST).limitedBy).toBe('ip');
          });

          it('allowances for different subjects are independent', () => {
            const limiter = createQuotaLimiter(RULES);
            for (let index = 0; index < 5; index += 1) {
              limiter.allow({ user: 'alice', ip: '1.1.1.1', route: '/search' });
            }
            expect(limiter.allow({ user: 'alice', ip: '1.1.1.1', route: '/search' }).allowed).toBe(false);
            // A different IP should be admitted
            expect(limiter.allow({ user: 'alice', ip: '2.2.2.2', route: '/search' }).allowed).toBe(true);
          });

          it('different values within one dimension do not interfere', () => {
            const limiter = createQuotaLimiter([{ dimension: 'user', limit: 2, windowMs: 1000 }]);
            expect(limiter.allow({ user: 'alice' }).allowed).toBe(true);
            expect(limiter.allow({ user: 'alice' }).allowed).toBe(true);
            expect(limiter.allow({ user: 'alice' }).allowed).toBe(false);
            // bob should not be affected by alice
            expect(limiter.allow({ user: 'bob' }).allowed).toBe(true);
          });

          it('a rule does not apply when the request lacks that dimension', () => {
            const limiter = createQuotaLimiter([{ dimension: 'user', limit: 1, windowMs: 1000 }]);
            // An anonymous request has no user, so this rule does not apply to it
            for (let index = 0; index < 10; index += 1) {
              expect(limiter.allow({ ip: '1.1.1.1' }).allowed).toBe(true);
            }
          });

          it('remaining reflects the allowance left', () => {
            const limiter = createQuotaLimiter(RULES);
            expect(limiter.remaining('ip', '1.2.3.4')).toBe(5);
            limiter.allow(REQUEST);
            limiter.allow(REQUEST);
            expect(limiter.remaining('ip', '1.2.3.4')).toBe(3);
          });

          it('a dimension with no rule has infinite allowance', () => {
            const limiter = createQuotaLimiter(RULES);
            expect(limiter.remaining('unknown', 'x')).toBe(Infinity);
          });

          it('allowance recovers once the window passes', async () => {
            const limiter = createQuotaLimiter(RULES);
            for (let index = 0; index < 5; index += 1) limiter.allow(REQUEST);
            expect(limiter.allow(REQUEST).allowed).toBe(false);

            await sleep(2000);
            expect(limiter.allow(REQUEST).allowed).toBe(true);
          });

          it('a rejected request does not consume the other dimensions [gate:two-phase]', () => {
            const limiter = createQuotaLimiter(RULES);

            // The first 5 fill ip up, consuming 5 of user at the same time
            for (let index = 0; index < 5; index += 1) limiter.allow(REQUEST);
            // The next 15 are all blocked by ip and must not touch user
            for (let index = 0; index < 15; index += 1) limiter.allow(REQUEST);

            const left = limiter.remaining('user', 'alice');
            count('userRemaining', left);

            // An implementation that decrements while checking reports 80 here
            expect(left).toBe(95);
          });

          it('a rejected request does not consume later dimensions either', () => {
            const limiter = createQuotaLimiter(RULES);
            for (let index = 0; index < 5; index += 1) limiter.allow(REQUEST);
            for (let index = 0; index < 10; index += 1) limiter.allow(REQUEST);
            expect(limiter.remaining('route', '/search')).toBe(45);
          });

          it('an empty rule table admits everything', () => {
            const limiter = createQuotaLimiter([]);
            for (let index = 0; index < 50; index += 1) {
              expect(limiter.allow(REQUEST).allowed).toBe(true);
            }
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.userRemaining',
      op: 'gte',
      value: 95,
      zh: '被拒绝的请求不消耗其他维度的配额',
      en: 'A rejected request consumes no quota in other dimensions',
      dimension: 'correctness',
      scope: 'gate:two-phase',
    }),
  ],
  referenceFiles: [
    file(
      'src/quota.ts',
      code`
        import { now } from '@lab/env';

        export interface QuotaRule {
          dimension: string;
          limit: number;
          windowMs: number;
        }

        export interface QuotaDecision {
          allowed: boolean;
          limitedBy: string | null;
        }

        export interface QuotaLimiter {
          allow(dimensions: Record<string, string>): QuotaDecision;
          remaining(dimension: string, value: string): number;
        }

        interface Counter {
          windowId: number;
          used: number;
        }

        export function createQuotaLimiter(rules: QuotaRule[]): QuotaLimiter {
          // The key is dimension plus value: keying on the dimension alone puts every user on one counter
          const counters = new Map<string, Counter>();

          function keyOf(dimension: string, value: string): string {
            return dimension + ':' + value;
          }

          function counterFor(rule: QuotaRule, value: string): Counter {
            const key = keyOf(rule.dimension, value);
            const windowId = Math.floor(now() / rule.windowMs);
            const existing = counters.get(key);
            if (existing && existing.windowId === windowId) return existing;
            const fresh: Counter = { windowId, used: 0 };
            counters.set(key, fresh);
            return fresh;
          }

          /** When the request lacks this dimension the rule does not apply — undefined is not a value */
          function applicable(dimensions: Record<string, string>): QuotaRule[] {
            return rules.filter((rule) => typeof dimensions[rule.dimension] === 'string');
          }

          return {
            allow(dimensions: Record<string, string>): QuotaDecision {
              const matched = applicable(dimensions);

              // First pass checks only, and returns on the first failure without decrementing anything.
              // Decrementing while checking burns the earlier dimensions' quota for a request a
              // later rule rejects
              for (const rule of matched) {
                const counter = counterFor(rule, dimensions[rule.dimension]);
                if (counter.used >= rule.limit) {
                  return { allowed: false, limitedBy: rule.dimension };
                }
              }

              // Second pass decrements them all together
              for (const rule of matched) {
                counterFor(rule, dimensions[rule.dimension]).used += 1;
              }
              return { allowed: true, limitedBy: null };
            },

            remaining(dimension: string, value: string): number {
              const rule = rules.filter((candidate) => candidate.dimension === dimension)[0];
              if (!rule) return Infinity;
              return Math.max(0, rule.limit - counterFor(rule, value).used);
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**两个 `for` 循环，而不是一个循环加回滚。** 回滚看起来更高效（少遍历一次），',
      '但它要求「扣减」是可逆的，而一旦某个维度的计数器在两次操作之间跨了窗口，',
      '回滚就会把额度还到错误的窗口里。分成两趟之后，扣减发生在一个不会失败的路径上，',
      '根本不需要可逆性。',
      '',
      '**`applicable` 用 `typeof === \'string\'` 而不是简单的真值判断。** 空字符串是一个',
      '合法的维度值（比如匿名用户的 user id 就是空串），用 `if (dimensions[d])` 会把它',
      '当成「没带这个维度」而跳过规则——一个专门用来限制匿名流量的规则于是永远不生效。',
      '',
      '**`limitedBy` 只返回第一条。** 第一趟循环在发现拒绝时立刻 return，',
      '既省掉了后续判断，也让返回值有确定的语义：「最先挡住你的是这一条」。',
      '返回全部被拒规则的数组信息量更大，但调用方拿它没什么用——',
      '429 响应里也只写得下一个原因。',
      '',
      '**`counterFor` 顺手做窗口滚动。** 它既是读取器又是「如果跨窗口就重置」的地方，',
      '所以 `remaining` 和 `allow` 看到的永远是同一套窗口逻辑，不会出现',
      '「查询时说还有额度、真正扣的时候又满了」这种不一致。',
    ].join('\n'),
    [
      'Two loops rather than one loop plus rollback. Rollback looks more efficient — one pass fewer — but',
      'it requires the decrement to be reversible, and if a counter crosses a window boundary between the',
      'two operations the refund lands in the wrong window. Splitting into two passes puts consumption on a',
      'path that cannot fail, so reversibility is never needed.',
      '',
      "`applicable` tests `typeof === 'string'` rather than truthiness. An empty string is a legitimate",
      "dimension value — an anonymous user's id, say — and `if (dimensions[d])` treats it as absent and",
      'skips the rule, so a rule written specifically to constrain anonymous traffic never fires.',
      '',
      '`limitedBy` reports only the first refusal. The checking loop returns immediately on refusal, which',
      'saves the remaining checks and gives the return value a definite meaning: this is what stopped you',
      'first. An array of every refusing rule carries more information the caller cannot use — a 429 has',
      'room for one reason.',
      '',
      '`counterFor` performs window rolling as a side effect, so it is both the reader and the place where',
      'a crossed window resets. `remaining` and `allow` therefore always see the same window logic, and',
      'there is no "the query said there was room and the decrement found it full" inconsistency.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const sharedStore = readonlyFile(
  'src/support/store.ts',
  code`
    /**
     * Central quota store (read-only, provided by the platform)
     *
     * Stands in for a shared counter like Redis: every instance coordinates through it.
     * It records how often it was called — which is exactly the coordination cost this stage gates on.
     */
    export interface SharedStore {
      /** Take up to amount from the global quota and return how much was actually granted */
      take(key: string, amount: number): number;
      /** How many times it was called, as a measure of coordination overhead */
      calls(): number;
      remaining(key: string): number;
    }

    export function createSharedStore(options: { limit: number }): SharedStore {
      const balances = new Map<string, number>();
      let callCount = 0;

      function balanceOf(key: string): number {
        return balances.has(key) ? (balances.get(key) as number) : options.limit;
      }

      return {
        take(key: string, amount: number): number {
          callCount += 1;
          const left = balanceOf(key);
          const granted = Math.max(0, Math.min(amount, left));
          balances.set(key, left - granted);
          return granted;
        },

        calls(): number {
          return callCount;
        },

        remaining(key: string): number {
          return balanceOf(key);
        },
      };
    }
  `
);

const stage4 = {
  id: 'distributed-limit',
  title: t('第 4 关 · 分布式限流与租约', 'Stage 4 · Distributed limiting with leases'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前三关的限流器都活在一个进程里。网关有 4 个实例时，问题立刻变了：',
      '全局限额是 100 QPS，每个实例各限 100，实际就放了 400。',
      '',
      '最容易想到的修法是「每个实例限 100/4 = 25」。它在流量均匀时能用，',
      '而流量从来不均匀 —— 负载均衡把 80% 的请求打到一台机器上时，',
      '这台机器在 25 就开始拒绝，其他三台的额度闲着。',
      '全局明明只用了 40%，用户已经收到 429 了。',
      '',
      '正确的做法是**租约**：实例向中心存储一次性批发一批额度，本地消耗，用完再去批发下一批。',
      '',
      '## 要实现什么',
      '',
      '在 `src/leased.ts` 实现 `createLeasedLimiter(store, options)`：',
      '',
      '| 情况 | 行为 |',
      '| --- | --- |',
      '| 本地还有余额 | 直接放行，**不碰 store** |',
      '| 本地余额为 0 | 向 `store.take(key, leaseSize)` 申请一批，拿到多少就是多少 |',
      '| store 给 0 | 全局额度用完了，拒绝，并进入一小段冷却期 |',
      '',
      '`localBalance()` 暴露本地余额，用来观察租约的消耗节奏。',
      '',
      '## 怎么算过',
      '',
      '- 4 个实例合计放行的总数不超过全局限额（门槛 `counters.globalAdmitted ≤ 100`）；',
      '- 协调次数只与租约批量有关，与请求数无关',
      '  （门槛 `counters.storeCalls ≤ 14`，即 `全局限额 / leaseSize + 实例数`）；',
      '- `store.take` 返回 0 时必须当成「没拿到」，不能默认拿到了 `leaseSize`；',
      '- 全局额度耗尽后，实例不再每个请求都去问一次 store。',
      '',
      '## 两个门槛是一对，缺一不可',
      '',
      '只看第一条，每个请求都去问一次 store 也完全正确 —— 但那样限流器的吞吐',
      '就等于 Redis 的吞吐，网关被自己的限流器限住了。',
      '',
      '只看第二条，批发一次就永远不再协调也很省 —— 但全局限额就形同虚设。',
      '',
      '租约的批量大小就是在这两者之间选一个点：批量越大协调越少、超发的窗口越大。',
      '最后那个冷却期是同一个道理的延伸 —— 全局额度耗尽时正是系统最忙的时候，',
      '这时候每个请求都去敲一次中心存储，等于在过载之上再加一份满负荷流量。',
    ].join('\n'),
    [
      'Every limiter so far lived in one process. With four gateway instances the problem changes: a global',
      'limit of 100 QPS enforced at 100 per instance actually admits 400.',
      '',
      'The obvious fix is limiting each instance to 100/4 = 25. That works while traffic is even, and traffic',
      'is never even — when the load balancer sends 80% of requests to one machine, that machine starts',
      'refusing at 25 while the other three sit on unused allowance. Globally only 40% is consumed and users',
      'are already seeing 429s.',
      '',
      'The right answer is **leasing**: an instance wholesales a batch of allowance from a central store,',
      'spends it locally, and returns for another batch when it runs out.',
      '',
      '## What to build',
      '',
      '`createLeasedLimiter(store, options)` in `src/leased.ts`:',
      '',
      '| Situation | Behaviour |',
      '| --- | --- |',
      '| Local balance remains | Admit directly, **without touching the store** |',
      '| Local balance is zero | Request a batch via `store.take(key, leaseSize)` and take whatever is granted |',
      '| The store grants zero | Global allowance is gone: refuse, and back off for a short cooldown |',
      '',
      '`localBalance()` exposes the local balance so the lease\'s burn rate is observable.',
      '',
      '## What counts as passing',
      '',
      '- Four instances together never admit more than the global limit (`counters.globalAdmitted ≤ 100`);',
      '- Coordination count depends on the lease size, not the request count',
      '  (`counters.storeCalls ≤ 14`, i.e. `globalLimit / leaseSize + instanceCount`);',
      '- A `store.take` result of zero must mean "got nothing" — never assume `leaseSize` was granted;',
      '- Once the global allowance is exhausted, an instance stops asking the store on every request.',
      '',
      '## The two gates are a pair — neither alone is enough',
      '',
      'Satisfy only the first and asking the store on every request is equally correct — but then the',
      'limiter\'s throughput equals Redis\'s throughput, and the gateway is throttled by its own throttle.',
      '',
      'Satisfy only the second and leasing once and never coordinating again is very cheap — and the global',
      'limit means nothing.',
      '',
      'Lease size is the choice between those two: larger batches mean less coordination and a wider',
      'overshoot window. The cooldown at the end is the same idea extended — the global allowance runs out',
      'exactly when the system is busiest, and hammering the central store once per request at that moment',
      'piles a full extra load on top of an overload.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**一个实例内部** —— 本地状态只有 `balance` 和 `nextAttemptAt`',
      '',
      '```mermaid',
      'flowchart TD',
      '  A["allow()"] --> B{"balance > 0？"}',
      '  B -- 是 --> D["balance -= 1 → true<br/>这条路径完全不出进程"]',
      '  B -- 否 --> C{"now < nextAttemptAt？"}',
      '  C -- "是（冷却中）" --> R1["直接 false，不去打扰 store"]',
      '  C -- 否 --> T["store.take(key, leaseSize)<br/>唯一一次跨实例协调"]',
      '  T --> G{"granted > 0？"}',
      '  G -- 是 --> S["balance = granted"]',
      '  S --> D',
      '  G -- 否 --> N["nextAttemptAt = now + retryAfterMs"]',
      '  N --> R2["false —— 全局额度已耗尽"]',
      '```',
      '',
      '图里只有 `T` 会跨出进程，而它被 `B` 那个判断挡在后面 ——',
      '每 `leaseSize` 个请求才可能走到一次。这就是「协调次数与请求数无关」的全部实现。',
      '',
      '`G` 那个判断是正确性的关键：不检查 `granted` 而直接 `balance = leaseSize`，',
      '四个实例就会各自凭空造出一批额度，全局限额彻底失效。',
      '',
      '**四个实例共用一个 store**',
      '',
      '```mermaid',
      'flowchart TD',
      '  I1["实例 1<br/>自己的 balance"] --> STORE[("SharedStore<br/>全局剩余额度")]',
      '  I2["实例 2<br/>自己的 balance"] --> STORE',
      '  I3["实例 3<br/>自己的 balance"] --> STORE',
      '  I4["实例 4<br/>自己的 balance"] --> STORE',
      '```',
      '',
      '每条箭头每 `leaseSize` 个请求才触发一次 —— 批量越大协调越少，',
      '超发的窗口也越大，租约大小就是在这两者之间选一个点。',
    ].join('\n'),
    [
      '**Inside one instance** — the local state is just `balance` and `nextAttemptAt`',
      '',
      '```mermaid',
      'flowchart TD',
      '  A["allow()"] --> B{"balance > 0?"}',
      '  B -- yes --> D["balance -= 1 → true<br/>this path never leaves the process"]',
      '  B -- no --> C{"now < nextAttemptAt?"}',
      '  C -- "yes (cooling down)" --> R1["return false without bothering the store"]',
      '  C -- no --> T["store.take(key, leaseSize)<br/>the one cross-instance coordination"]',
      '  T --> G{"granted > 0?"}',
      '  G -- yes --> S["balance = granted"]',
      '  S --> D',
      '  G -- no --> N["nextAttemptAt = now + retryAfterMs"]',
      '  N --> R2["false — global allowance is gone"]',
      '```',
      '',
      '`T` is the only node that leaves the process, and it sits behind the `B` check — reachable at most',
      'once per `leaseSize` requests. That is the whole implementation of "coordination count is independent',
      'of request count".',
      '',
      'The `G` check is where correctness lives: skip it, assign `balance = leaseSize` regardless, and four',
      'instances each conjure a batch of allowance out of nothing, leaving the global limit meaningless.',
      '',
      '**Four instances sharing one store**',
      '',
      '```mermaid',
      'flowchart TD',
      '  I1["instance 1<br/>its own balance"] --> STORE[("SharedStore<br/>global remaining allowance")]',
      '  I2["instance 2<br/>its own balance"] --> STORE',
      '  I3["instance 3<br/>its own balance"] --> STORE',
      '  I4["instance 4<br/>its own balance"] --> STORE',
      '```',
      '',
      'Each arrow fires once per `leaseSize` requests — larger batches mean less coordination and a wider',
      'overshoot window, and the lease size is the choice between those two.',
    ].join('\n')
  ),
  checklist: [
    t('本地有余额时不访问 store', 'No store access while local balance remains'),
    t('余额用完才去批发下一批', 'A new batch is fetched only when local balance is spent'),
    t('多实例合计不超过全局限额', 'All instances together stay within the global limit'),
    t('全局额度用完时所有实例都拒绝', 'Every instance refuses once the global allowance is gone'),
    t('store 调用次数远少于请求数', 'Store calls are far fewer than requests'),
  ],
  pitfalls: [
    t(
      '每个请求都调一次 `store.take(key, 1)`。功能完全正确，全局限额一个不多一个不少——代价是每个请求都要一次跨网络往返，限流器的吞吐上限变成了 Redis 的吞吐上限，而且 Redis 挂了整个网关就废了。租约把协调频率从「每请求一次」降到「每 leaseSize 个请求一次」。',
      'Calling `store.take(key, 1)` per request. Functionally exact, and it costs a network round trip per request, so the limiter\'s throughput ceiling becomes Redis\'s and a Redis outage takes the whole gateway down. Leasing drops coordination from once per request to once per `leaseSize` requests.'
    ),
    t(
      '批发到的额度在窗口结束时不归还。实例拿了 20 个额度只用了 3 个，剩下 17 个既不在全局池子里也不会被自己用掉——多个实例这么干，全局实际可用额度会远低于配置值。真实实现要么定期归还未用额度，要么让租约带过期时间。',
      'Never returning unused lease. An instance takes twenty and spends three, and the other seventeen are neither in the global pool nor going to be used locally. With several instances doing this the effective global allowance falls far below what was configured. Real implementations either return the remainder periodically or give leases an expiry.'
    ),
    t(
      '本地余额为 0 时申请一批，但没检查 store 给了多少。`take` 返回 0 表示全局额度已经用完，如果不检查就默认拿到了 leaseSize，这个实例会继续放行——全局限额彻底失效，而且失效得毫无声息。',
      'Requesting a batch at zero balance without checking how much was granted. A `take` returning 0 means the global allowance is exhausted; assuming `leaseSize` was received keeps the instance admitting, and the global limit fails silently and completely.'
    ),
    t(
      '全局额度耗尽之后，每个请求仍然去问一次 store。功能上没错——每次都得到 0，每次都正确拒绝。但这意味着系统最过载的时候，中心存储要承受和请求量同样大的调用量，而它正是这时候最脆弱的组件。批发失败之后应该进入一小段冷却期，期间直接本地拒绝。',
      'Asking the store once per request after the global allowance is exhausted. Functionally right — every call returns zero and every request is correctly refused — and it means the central store takes a call rate equal to the request rate exactly when the system is most overloaded and that store is the most fragile component. A failed lease should start a short cooldown during which refusal is purely local.'
    ),
    t(
      '把 leaseSize 定得和全局限额一样大。第一个来申请的实例会一次性拿走全部额度，其余实例一个都拿不到——租约退化成了「先到先得的独占」。leaseSize 的取值是一个取舍：越大协调越少、额度分配越不均；越小越均匀、协调越频繁。',
      'Setting `leaseSize` equal to the global limit. The first instance to ask takes everything and the rest get nothing — leasing degenerates into first-come exclusivity. The size is a trade-off: larger means less coordination and less even distribution, smaller means the reverse.'
    ),
  ],
  hints: [
    t(
      '本地状态只有一个数字：`localBalance`。`allow()` 是「余额 > 0 就减一放行，否则去批发」，批发失败就拒绝。',
      'Local state is one number, `localBalance`. `allow()` decrements and admits while it is positive, otherwise fetches a batch and refuses if the fetch returns nothing.'
    ),
    t(
      '门槛里的「实例数」那一项是给每个实例最后一次徒劳的申请留的余量——全局额度用完之后，每个实例还会再问一次才知道。',
      'The instance-count term in the gate leaves room for one futile request each: once the global allowance is gone, every instance still asks once to find out.'
    ),
  ],
  extension: t(
    [
      '租约（lease）这个模式远不止用于限流。它的本质是「用一次协调换 N 次本地操作」，',
      '同样的思路出现在：数据库的自增主键分段（一次取 1000 个 id）、',
      '分布式锁的续约、Kubernetes 的 leader election、以及 DNS 的 TTL。',
      '所有这些场景的取舍都一样：租约越长，协调越少，但失效时的不一致窗口越大。',
      '',
      '这一关的租约有个明显缺陷：**不归还**。真实实现有两种补法。',
      '一种是给租约加过期时间，中心存储在租约过期后自动收回——',
      '代价是实例必须续约，而且时钟不同步会带来误差。',
      '另一种是**自适应租约**：观察实例的实际消耗速率，动态调整 leaseSize，',
      '快的实例批发得多，慢的实例批发得少。Google 的 Doorman 和',
      'Envoy 的 RLS（Rate Limit Service）都是这个方向。',
      '',
      '还有一条完全不同的路：**放弃精确**。既然限流本来就是保护性措施，',
      '那么「大约 100 QPS」和「精确 100 QPS」在工程上几乎没有区别。',
      '于是有些系统干脆让每个实例独立限流，把限额定成 `全局 / 实例数 × 冗余系数`，',
      '接受流量不均时的误差。这个方案的最大优点是**没有任何协调**——',
      '中心存储挂了，限流照常工作。在可用性优先的系统里，这个优点压倒一切。',
    ].join('\n'),
    [
      'Leasing goes far beyond rate limiting. Its essence is trading one coordination for N local',
      'operations, and the same shape appears in database identity ranges (grab a thousand ids at once),',
      'distributed lock renewal, Kubernetes leader election and DNS TTLs. The trade-off is identical',
      'everywhere: longer leases mean less coordination and a wider window of inconsistency on failure.',
      '',
      'The lease here has an obvious flaw: nothing is returned. Real implementations patch it two ways. One',
      'gives leases an expiry so the central store reclaims them automatically, at the cost of instances',
      'having to renew and clock skew introducing error. The other is adaptive leasing: observe each',
      "instance's actual consumption rate and size its batches accordingly, so busy instances wholesale",
      "more. Google's Doorman and Envoy's Rate Limit Service both work this way.",
      '',
      'There is a completely different road: abandon precision. Rate limiting is protective, so "about 100',
      'QPS" and "exactly 100 QPS" are nearly indistinguishable in engineering terms. Some systems therefore',
      'let each instance limit independently at `global / instances × headroom` and accept the error under',
      'uneven traffic. Its great advantage is requiring no coordination at all — the central store can be',
      'down and limiting still works. In availability-first systems that outweighs everything else.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'resilience'],
  lab: {},
  starterFiles: [
    sharedStore,
    file(
      'src/leased.ts',
      code`
        import type { SharedStore } from './support/store';

        export interface LeaseOptions {
          /** The global quota key, shared by every instance */
          key: string;
          /** How much to lease from the central store at a time */
          leaseSize: number;
          /** How long to wait before asking again after a failed lease; defaults to 100ms */
          retryAfterMs?: number;
        }

        export interface LeasedLimiter {
          allow(): boolean;
          /** How much leased allowance is left locally */
          localBalance(): number;
        }

        export function createLeasedLimiter(store: SharedStore, options: LeaseOptions): LeasedLimiter {
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
        import { createLeasedLimiter } from '../src/leased';
        import { createSharedStore } from '../src/support/store';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const KEY = 'search';

        describe('Stage 4 · Lease-based distributed limiting', () => {
          it('the first call goes and leases a batch', () => {
            const store = createSharedStore({ limit: 100 });
            const limiter = createLeasedLimiter(store, { key: KEY, leaseSize: 10 });

            expect(limiter.allow()).toBe(true);
            expect(store.calls()).toBe(1);
            expect(limiter.localBalance()).toBe(9);
          });

          it('does not touch the store while local allowance remains', () => {
            const store = createSharedStore({ limit: 100 });
            const limiter = createLeasedLimiter(store, { key: KEY, leaseSize: 10 });

            for (let index = 0; index < 10; index += 1) limiter.allow();
            expect(store.calls()).toBe(1);
          });

          it('leases the next batch only once the local balance runs out', () => {
            const store = createSharedStore({ limit: 100 });
            const limiter = createLeasedLimiter(store, { key: KEY, leaseSize: 10 });

            for (let index = 0; index < 11; index += 1) limiter.allow();
            expect(store.calls()).toBe(2);
          });

          it('rejects once the global quota is exhausted', () => {
            const store = createSharedStore({ limit: 20 });
            const limiter = createLeasedLimiter(store, { key: KEY, leaseSize: 10 });

            let allowed = 0;
            for (let index = 0; index < 40; index += 1) if (limiter.allow()) allowed += 1;
            expect(allowed).toBe(20);
          });

          it('does not mistake an empty grant from the store for a successful lease', () => {
            const store = createSharedStore({ limit: 5 });
            const limiter = createLeasedLimiter(store, { key: KEY, leaseSize: 10 });

            // Only 5 could be leased the first time
            for (let index = 0; index < 5; index += 1) expect(limiter.allow()).toBe(true);
            // take returned 0, so it must reject
            expect(limiter.allow()).toBe(false);
            expect(limiter.localBalance()).toBe(0);
          });

          it('different keys do not affect each other', () => {
            const store = createSharedStore({ limit: 10 });
            const search = createLeasedLimiter(store, { key: 'search', leaseSize: 10 });
            const upload = createLeasedLimiter(store, { key: 'upload', leaseSize: 10 });

            for (let index = 0; index < 10; index += 1) expect(search.allow()).toBe(true);
            expect(search.allow()).toBe(false);
            expect(upload.allow()).toBe(true);
          });

          it('four instances together stay under the global limit [gate:global]', () => {
            const store = createSharedStore({ limit: 100 });
            const instances = [1, 2, 3, 4].map(() =>
              createLeasedLimiter(store, { key: KEY, leaseSize: 10 })
            );

            let admitted = 0;
            // Wildly uneven traffic: the first instance takes most of it
            for (let round = 0; round < 200; round += 1) {
              const instance = round < 150 ? instances[0] : instances[round % 4];
              if (instance.allow()) admitted += 1;
            }

            count('globalAdmitted', admitted);
            expect(admitted).toBeLessThanOrEqual(100);
          });

          it('the global quota is fully used even when traffic is uneven', () => {
            const store = createSharedStore({ limit: 100 });
            const instances = [1, 2, 3, 4].map(() =>
              createLeasedLimiter(store, { key: KEY, leaseSize: 10 })
            );

            let admitted = 0;
            // Everything hits one instance: a fixed 25-each split would admit only 25 here
            for (let round = 0; round < 200; round += 1) {
              if (instances[0].allow()) admitted += 1;
            }
            expect(admitted).toBe(100);
          });

          it('coordination happens far less often than requests arrive [gate:coordination]', () => {
            const store = createSharedStore({ limit: 100 });
            const instances = [1, 2, 3, 4].map(() =>
              createLeasedLimiter(store, { key: KEY, leaseSize: 10 })
            );

            for (let round = 0; round < 200; round += 1) {
              instances[round % 4].allow();
            }

            count('storeCalls', store.calls());
            // 100 of quota at 10 per batch = 10 calls, plus one futile final request per instance
            expect(store.calls()).toBeLessThanOrEqual(14);
          });

          it('stops hitting the store on every request once the quota is gone', () => {
            const store = createSharedStore({ limit: 10 });
            const limiter = createLeasedLimiter(store, { key: KEY, leaseSize: 10 });

            for (let index = 0; index < 10; index += 1) limiter.allow();
            const afterLease = store.calls();

            // The quota is already spent; send 50 more requests
            for (let index = 0; index < 50; index += 1) expect(limiter.allow()).toBe(false);

            // There should be exactly one extra call that discovers it is exhausted, not 50
            expect(store.calls() - afterLease).toBeLessThanOrEqual(1);
          });

          it('tries to lease again once the cooldown has passed', async () => {
            const store = createSharedStore({ limit: 10 });
            const limiter = createLeasedLimiter(store, { key: KEY, leaseSize: 10, retryAfterMs: 50 });

            for (let index = 0; index < 11; index += 1) limiter.allow();
            const afterExhaustion = store.calls();

            await sleep(60);
            limiter.allow();
            expect(store.calls()).toBe(afterExhaustion + 1);
          });

          it('localBalance reflects what is left locally', () => {
            const store = createSharedStore({ limit: 100 });
            const limiter = createLeasedLimiter(store, { key: KEY, leaseSize: 8 });
            expect(limiter.localBalance()).toBe(0);
            limiter.allow();
            expect(limiter.localBalance()).toBe(7);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.globalAdmitted',
      op: 'lte',
      value: 100,
      zh: '多实例合计不越过全局限额',
      en: 'All instances together stay within the global limit',
      dimension: 'correctness',
      scope: 'gate:global',
    }),
    gate({
      metric: 'counters.storeCalls',
      op: 'lte',
      value: 14,
      zh: '协调次数与请求数无关，只与租约批量有关',
      en: 'Coordination scales with lease size, not with request count',
      dimension: 'latency',
      scope: 'gate:coordination',
    }),
  ],
  referenceFiles: [
    file(
      'src/leased.ts',
      code`
        import type { SharedStore } from './support/store';
        import { now } from '@lab/env';

        export interface LeaseOptions {
          key: string;
          leaseSize: number;
          retryAfterMs?: number;
        }

        export interface LeasedLimiter {
          allow(): boolean;
          localBalance(): number;
        }

        export function createLeasedLimiter(store: SharedStore, options: LeaseOptions): LeasedLimiter {
          // Local state is just these two numbers. They turn one coordination per request
          // into one coordination per leaseSize requests
          let balance = 0;
          let nextAttemptAt = 0;
          const retryAfterMs = options.retryAfterMs ?? 100;

          return {
            allow(): boolean {
              if (balance <= 0) {
                // Asking once per request after the global quota is gone piles a second full load onto
                // the central store exactly when the system is already overloaded. Reject outright
                // during the cooldown
                if (now() < nextAttemptAt) return false;

                const granted = store.take(options.key, options.leaseSize);
                // take returning 0 means the global quota is exhausted.
                // Not checking, and assuming leaseSize was granted, defeats the global limit entirely
                if (granted <= 0) {
                  nextAttemptAt = now() + retryAfterMs;
                  return false;
                }
                balance = granted;
              }

              balance -= 1;
              return true;
            },

            localBalance(): number {
              return balance;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**整个实现只有一个可变状态。** 这不是刻意精简——租约模式的价值恰恰在于',
      '把分布式协调压缩成一个本地整数。任何比这更复杂的本地状态，',
      '都意味着实例之间有了额外的隐式约定，而那是分布式系统里最难维护的东西。',
      '',
      '**`granted <= 0` 这个检查是全局限额的最后一道防线。** store 返回 0 的场景是',
      '「全局额度用完了」，而不是「网络抖了一下」——在这个模型里它是确定的信号。',
      '把返回值当成一定等于 leaseSize，限流器会在额度耗尽后继续放行，',
      '而且因为本地余额是自己算的，它永远不会发现自己错了。',
      '',
      '**`balance = granted` 而不是 `balance += granted`。** 走到这一行时 balance 一定是 0',
      '（这是进入分支的条件），两种写法等价。用赋值是因为它更明确地表达了',
      '「这是一批全新的租约」，而不是「往余额上加」——后者会让人以为可以在余额非零时预取。',
      '',
      '**未用完的租约不归还。** 这是一个已知的缺陷，也是这个最小实现的边界。',
      '在门槛的场景里它不会造成问题（额度最终都被用掉了），',
      '但在真实系统里，实例重启会带走它手上未用的那批额度——',
      '所以生产实现必须给租约加过期时间。',
    ].join('\n'),
    [
      'The whole implementation holds one piece of mutable state. That is not minimalism for its own sake:',
      'compressing distributed coordination into a single local integer is precisely what leasing buys.',
      'Any richer local state implies additional implicit agreements between instances, which is the',
      'hardest thing to maintain in a distributed system.',
      '',
      'The `granted <= 0` check is the last line of defence for the global limit. A zero from the store',
      'means the allowance is gone, not that the network hiccupped — in this model it is a definite signal.',
      'Assuming the return value equals `leaseSize` keeps the limiter admitting past exhaustion, and since',
      'it computes its balance locally it never discovers its own error.',
      '',
      '`balance = granted` rather than `balance += granted`. Reaching that line guarantees balance is zero,',
      'so the two are equivalent; assignment states more clearly that this is a fresh lease rather than a',
      'top-up, which would suggest prefetching while a balance remains is fine.',
      '',
      'Unused lease is never returned. That is a known limitation and the boundary of this minimal',
      'implementation. It causes no trouble in the gate scenarios, where the allowance is eventually spent,',
      'but in a real system an instance restart takes its unused batch with it — which is why production',
      'implementations must give leases an expiry.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage5 = {
  id: 'circuit-breaker',
  title: t('第 5 关 · 熔断器', 'Stage 5 · Circuit breaker'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '限流保护的是下游的速率，熔断保护的是下游的**恢复时间**：',
      '一个依赖已经挂了，继续把流量打过去只会让它更难爬起来，',
      '同时也在耗尽你自己的线程和连接。',
      '',
      '## 要实现什么',
      '',
      '在 `src/circuitBreaker.ts` 实现三态熔断器，入口是 `exec(task)`：',
      '',
      '| 状态 | 行为 | 转出条件 |',
      '| --- | --- | --- |',
      '| `closed` | 正常放行 | 连续失败达到 `failureThreshold` → `open` |',
      '| `open` | 不调用下游，直接抛 `CircuitOpenError` | 经过 `resetTimeoutMs` → `half-open` |',
      '| `half-open` | 只放行 `halfOpenMax` 个探针 | 探针成功 → `closed`；探针失败 → 立刻 `open` |',
      '',
      '`state()` 返回当前状态。转换是**时间驱动**的：不要用定时器，',
      '在读状态时顺手比较 `now - openedAt`，就完成了 `open → half-open`。',
      '',
      '## 怎么算过',
      '',
      '- 连续失败到阈值后开路；',
      '- 开路期间下游**一次都不再被调用**（门槛 `requests.total ≤ 2`）；',
      '- `resetTimeoutMs` 之后进入半开，并且只放过 `halfOpenMax` 个探针；',
      '- 半开时探针成功立刻回到 `closed` 并清零计数；',
      '- 半开时探针失败立刻回到 `open`，不再多试。',
      '',
      '## 半开状态是这一关的重点',
      '',
      '熔断真正买到的东西是下游的恢复窗口，快速失败只是顺带的。',
      '如果 `resetTimeoutMs` 一到就把全部流量放回去，刚缓过一口气的下游会被再次打死，',
      '然后再熔断、再放全量 —— 系统进入震荡，而不是恢复。',
      '半开就是为此存在：用一个请求去试探，成功了才开闸。',
      '',
      '还有一处容易写错：判断「这次失败该怎么处理」要用**进入时**的状态快照，',
      '不是失败当下的 `current`。`await task()` 期间状态可能已经被别的调用改过了，',
      '用当下的值会让一次半开探针的失败被当成普通失败，从而白白多打下游几次。',
    ].join('\n'),
    [
      'Rate limiting protects the downstream rate; a breaker protects its **recovery time**. Hammering a',
      'dependency that is already down keeps it down, while exhausting your own threads and connections.',
      '',
      '## What to build',
      '',
      'A three-state breaker in `src/circuitBreaker.ts`, entered through `exec(task)`:',
      '',
      '| State | Behaviour | Leaves when |',
      '| --- | --- | --- |',
      '| `closed` | Pass through | `failureThreshold` consecutive failures → `open` |',
      '| `open` | Never calls downstream, throws `CircuitOpenError` | `resetTimeoutMs` elapses → `half-open` |',
      '| `half-open` | Admits at most `halfOpenMax` probes | A probe succeeds → `closed`; a probe fails → straight back to `open` |',
      '',
      '`state()` reports the current state. Transitions are **time-driven**: no timers — comparing',
      '`now - openedAt` while reading the state is what performs `open → half-open`.',
      '',
      '## What counts as passing',
      '',
      '- Consecutive failures reaching the threshold open the circuit;',
      '- While open the downstream is **never called again** (`requests.total ≤ 2`);',
      '- After `resetTimeoutMs` the breaker half-opens and admits exactly `halfOpenMax` probes;',
      '- A successful probe closes the circuit immediately and clears the counters;',
      '- A failed probe reopens immediately, without further attempts.',
      '',
      '## Half-open is the point of this stage',
      '',
      'What a breaker actually buys is recovery time for the dependency; failing fast is a side effect. Point',
      'the full firehose back the instant `resetTimeoutMs` expires and the barely-recovered dependency dies',
      'again, trips the breaker again, and gets the full load again — the system oscillates instead of',
      'recovering. Half-open exists for that: probe with one request, open the gate only if it works.',
      '',
      'One more easy mistake: deciding how to treat a failure must use the state **snapshot taken on entry**,',
      'not `current` at the moment of failure. State may have been changed by another call during',
      '`await task()`, and reading it late turns a failed half-open probe into an ordinary failure — which',
      'costs the downstream several needless calls.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  E["exec(task)"] --> ST["snapshot = state()<br/>读状态时顺带做时间驱动的转换：<br/>open 且 now - openedAt ≥ resetTimeoutMs → half-open, probes = 0"]',
      '  ST --> SW{"snapshot 是哪个状态？"}',
      '  SW -- open --> TH["抛 CircuitOpenError<br/>下游一次都不调用"]',
      '  SW -- half-open --> PB{"probes ≥ halfOpenMax？"}',
      '  PB -- 是 --> TH',
      '  PB -- 否 --> INC["probes += 1"]',
      '  INC --> RUN',
      '  SW -- closed --> RUN["await task()"]',
      '  RUN --> OKQ{"成功了吗？"}',
      '  OKQ -- 成功 --> CLOSE["current = closed<br/>failures = 0, probes = 0"]',
      '  OKQ -- 失败 --> WAS{"用进来时的 snapshot 判断<br/>而不是此刻的 current"}',
      '  WAS -- 当时是 half-open --> TRIP["trip()<br/>current = open, openedAt = now<br/>计数全部清零"]',
      '  WAS -- 当时是 closed --> F["failures += 1"]',
      '  F --> FT{"failures ≥ failureThreshold？"}',
      '  FT -- 是 --> TRIP',
      '  FT -- 否 --> RETHROW["把原始错误抛给调用方"]',
      '  TRIP --> RETHROW',
      '```',
      '',
      '要点：状态机只有 `state()` 和 `trip()` 两处会改 `current`，',
      '`open → half-open` 藏在 `state()` 里，`* → open` 藏在 `trip()` 里 —— 没有定时器参与。',
      '',
      '`WAS` 那个菱形是最容易忽略的一处：它读的是 `ST` 拿到的快照。',
      '`await` 期间状态可能已经变了，用此刻的 `current` 判断，',
      '一次半开探针的失败会被当成普通失败处理，白白多打下游几次。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  E["exec(task)"] --> ST["snapshot = state()<br/>reading the state also performs the time-driven move:<br/>open and now - openedAt ≥ resetTimeoutMs → half-open, probes = 0"]',
      '  ST --> SW{"which state is the snapshot?"}',
      '  SW -- open --> TH["throw CircuitOpenError<br/>downstream is never called"]',
      '  SW -- half-open --> PB{"probes ≥ halfOpenMax?"}',
      '  PB -- yes --> TH',
      '  PB -- no --> INC["probes += 1"]',
      '  INC --> RUN',
      '  SW -- closed --> RUN["await task()"]',
      '  RUN --> OKQ{"did it succeed?"}',
      '  OKQ -- succeeded --> CLOSE["current = closed<br/>failures = 0, probes = 0"]',
      '  OKQ -- failed --> WAS{"judge by the entry snapshot<br/>not by current right now"}',
      '  WAS -- "was half-open" --> TRIP["trip()<br/>current = open, openedAt = now<br/>all counters cleared"]',
      '  WAS -- "was closed" --> F["failures += 1"]',
      '  F --> FT{"failures ≥ failureThreshold?"}',
      '  FT -- yes --> TRIP',
      '  FT -- no --> RETHROW["rethrow the original error"]',
      '  TRIP --> RETHROW',
      '```',
      '',
      'The point: only `state()` and `trip()` ever write `current` — `open → half-open` hides inside',
      '`state()`, `* → open` inside `trip()`, and no timer takes part.',
      '',
      'The `WAS` diamond is the easily-missed one: it reads the snapshot taken at `ST`. State may have moved',
      'during the `await`, and judging by the present `current` turns a failed half-open probe into an',
      'ordinary failure — costing the downstream several needless calls.',
    ].join('\n')
  ),
  checklist: [
    t('连续失败达阈值后打开', 'Opens after consecutive failures hit the threshold'),
    t('打开期间完全不调用下游', 'Never touches downstream while open'),
    t('超时后进入半开并放行探针', 'Moves to half-open and admits a probe'),
    t('探针失败立刻重新打开', 'A failed probe reopens immediately'),
  ],
  pitfalls: [
    t(
      '熔断打开后照样调用下游、只是把结果丢掉，那等于没熔断。它的作用就是不打过去，给下游喘息的机会。',
      'Calling downstream while open and throwing the result away protects nothing. The point is not calling, so the dependency gets room to recover.'
    ),
    t(
      '成功时不清零失败计数：跨越几小时的零星失败会累积到阈值，在系统完全健康的时候突然熔断。计数应该衡量的是「连续失败」。',
      'Not resetting the failure count on success lets sparse failures accumulate over hours and trip the breaker while everything is healthy. The counter measures *consecutive* failures.'
    ),
    t(
      '下游刚缓过来一点就被再次打死，这叫二次雪崩。原因通常是半开时把积压的流量全放了进去，那里只该走少量探针。',
      'A dependency that just started recovering gets killed again. That second avalanche usually comes from letting all the backed-up traffic through in half-open, where only a few probes belong.'
    ),
    t(
      '用 `setTimeout` 来做 open→half-open 的转换：多了一个需要清理的定时器，而且状态机变得难以测试。在读状态时顺便按时间判断即可。',
      'Using `setTimeout` for the open→half-open transition adds a timer to clean up and makes the machine hard to test. Decide it by clock when the state is read.'
    ),
    t(
      '把「超时」排除在失败之外：一个永远超时但不报错的下游会让熔断器永远闭合，你的线程和连接会被慢慢耗尽。对熔断器来说，超时和报错应该同等对待。',
      'Excluding timeouts from failures leaves the breaker closed against a dependency that hangs instead of erroring, slowly exhausting your connections. Slow is a failure mode.'
    ),
  ],
  hints: [
    t(
      '状态转换和「读状态」应该是同一个函数：读的时候顺便判断 open 是否已经该转 half-open。',
      'Make reading the state and transitioning the same function: reading is when you notice open should become half-open.'
    ),
    t(
      '成功一次就要把失败计数清零，否则跨越很长时间的零星失败也会误触发熔断。',
      'Reset the failure counter on success, otherwise sparse failures spread over hours will trip the breaker.'
    ),
  ],
  extension: t(
    [
      '### 这个模式从哪来',
      '',
      'Circuit Breaker 出自 Michael Nygard 的《Release It!》，后来被 Netflix 的 Hystrix 做成了',
      '工业标准。Hystrix 现在已经停止维护，接棒的是 resilience4j（Java）、Polly（.NET）、',
      'Envoy/Istio 的 outlier detection（服务网格层面）。',
      '',
      '### 计数阈值 vs 比例阈值',
      '',
      '本关用的是「连续 N 次失败」，实现简单、语义清晰。生产系统更常用滑动窗口内的失败率：',
      '',
      '```',
      '最近 100 次调用里失败率 > 50%  且  样本数 >= 20  ->  熔断',
      '```',
      '',
      '为什么？因为高 QPS 下，「连续 5 次失败」可能只是 0.1% 的抖动；',
      '而低 QPS 下样本太少，失败率会剧烈波动，所以还需要一个最小样本数门槛。',
      '',
      '### 三个容易被忽略的细节',
      '',
      '1. 每个下游一个熔断器。共用一个的话，A 服务挂了会把 B 的流量也切断；',
      '2. **熔断后返回什么**？直接报错 vs 返回降级数据（缓存、默认值），这是产品决策，不是技术决策；',
      '3. **半开的并发控制**。`halfOpenMax` 存在的意义是：探针期间不能让 100 个请求同时冲进去。',
      '',
      '### 和限流的区别',
      '',
      '限流保护的是「下游的速率」，熔断保护的是「下游的恢复时间」。',
      '两者互补：限流让你不会主动打挂它，熔断让你在它已经挂了之后停手。',
    ].join('\n'),
    [
      '### Where this pattern comes from',
      '',
      "Circuit Breaker comes from Michael Nygard's *Release It!* and was industrialised by Netflix's",
      'Hystrix. Hystrix is now in maintenance mode; the successors are resilience4j (Java), Polly',
      '(.NET) and outlier detection in Envoy/Istio at the mesh layer.',
      '',
      '### Count threshold vs ratio threshold',
      '',
      'This stage uses "N consecutive failures", simple and clear. Production systems more often',
      'use a failure *rate* over a sliding window:',
      '',
      '```',
      'failure rate > 50% over the last 100 calls  AND  at least 20 samples  ->  open',
      '```',
      '',
      'Why? At high QPS, five consecutive failures may be 0.1% noise. At low QPS the rate swings',
      'wildly on tiny samples, hence the minimum-sample threshold.',
      '',
      '### Three details that get missed',
      '',
      '1. One breaker per dependency. Share one and a failure in A cuts off traffic to B;',
      '2. What do you return when open? Error vs degraded data (cache, defaults) is a product decision, not a technical one;',
      '3. Concurrency in half-open. `halfOpenMax` exists so 100 requests do not rush in during probing.',
      '',
      '### How this differs from rate limiting',
      '',
      "Rate limiting protects the dependency's throughput; a breaker protects its recovery time.",
      'They complement each other: the limiter stops you from causing the outage, the breaker stops you',
      'from prolonging it.',
    ].join('\n')
  ),
  focus: ['resilience', 'encapsulation'],
  lab: {
    defaultLatencyMs: 100,
    endpoints: {
      '/api/down': { failFirstN: 99, status: 503 },
      '/api/recovering': { failFirstN: 2, status: 503 },
    },
  },
  starterFiles: [
    file(
      'src/circuitBreaker.ts',
      code`
        export type CircuitState = 'closed' | 'open' | 'half-open';

        export interface CircuitBreakerOptions {
          /** How many consecutive failures trip the breaker */
          failureThreshold: number;
          /** How long the breaker stays open before a probe is allowed */
          resetTimeoutMs: number;
          /** How many probes half-open admits at most; defaults to 1 */
          halfOpenMax?: number;
        }

        export interface CircuitBreaker {
          exec<T>(task: () => Promise<T>): Promise<T>;
          state(): CircuitState;
        }

        export class CircuitOpenError extends Error {
          constructor() {
            super('circuit open');
            this.name = 'CircuitOpenError';
          }
        }

        export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
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
        import { createCircuitBreaker, CircuitOpenError } from '../src/circuitBreaker';
        import { request, getMetrics } from '@lab/net';
        import { sleep } from '@lab/env';

        const failing = async () => {
          throw new Error('upstream exploded');
        };

        describe('Stage 5 · Circuit breaker', () => {
          it('opens once consecutive failures reach the threshold', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 500 });
            expect(breaker.state()).toBe('closed');

            for (let index = 0; index < 3; index += 1) {
              await expect(async () => breaker.exec(failing)).rejects.toThrow('upstream exploded');
            }

            expect(breaker.state()).toBe('open');
          });

          it('a success resets the failure count', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 500 });
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            await breaker.exec(async () => 'ok');
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            expect(breaker.state()).toBe('closed');
          });

          it('does not call downstream while open [gate:fastfail]', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });

            for (let index = 0; index < 6; index += 1) {
              try {
                await breaker.exec(() => request('/api/down'));
              } catch (error) {
                // The first 2 are real failures; after that it should be CircuitOpenError
                if (index >= 2) expect(error).toBeInstanceOf(CircuitOpenError);
              }
            }

            expect(getMetrics().requests.total).toBe(2);
          });

          it('goes half-open after the timeout and closes when the probe succeeds', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 300 });
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            expect(breaker.state()).toBe('open');

            await sleep(300);
            expect(breaker.state()).toBe('half-open');

            const value = await breaker.exec(async () => 'recovered');
            expect(value).toBe('recovered');
            expect(breaker.state()).toBe('closed');
          });

          it('a failed half-open probe reopens it immediately', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 300 });
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            await expect(async () => breaker.exec(failing)).rejects.toThrow();

            await sleep(300);
            expect(breaker.state()).toBe('half-open');

            await expect(async () => breaker.exec(failing)).rejects.toThrow('upstream exploded');
            expect(breaker.state()).toBe('open');
          });

          it('after a failed probe a full resetTimeout has to elapse again', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 300 });
            await expect(async () => breaker.exec(failing)).rejects.toThrow();

            await sleep(300);
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            expect(breaker.state()).toBe('open');

            // Not yet into the next window
            await sleep(200);
            expect(breaker.state()).toBe('open');

            await sleep(100);
            expect(breaker.state()).toBe('half-open');
          });

          it('half-open admits only halfOpenMax probes', async () => {
            const breaker = createCircuitBreaker({
              failureThreshold: 1,
              resetTimeoutMs: 100,
              halfOpenMax: 1,
            });
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            await sleep(100);
            expect(breaker.state()).toBe('half-open');

            let probes = 0;
            const slowProbe = async () => {
              probes += 1;
              await sleep(50);
              return 'ok';
            };

            // Two requests arrive together and only one gets to be the probe
            const results = await Promise.allSettled([breaker.exec(slowProbe), breaker.exec(slowProbe)]);
            expect(probes).toBe(1);
            expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
          });

          it('the count resets on success, so a full threshold can be absorbed again', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 500 });

            for (let round = 0; round < 3; round += 1) {
              await expect(async () => breaker.exec(failing)).rejects.toThrow();
              await expect(async () => breaker.exec(failing)).rejects.toThrow();
              await breaker.exec(async () => 'ok');
              expect(breaker.state()).toBe('closed');
            }
          });

          it("returns downstream's result normally while closed", async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 });
            const response = await breaker.exec(() => request('/api/ok'));
            expect(response.status).toBe(200);
            expect(getMetrics().requests.total).toBe(1);
          });

          it('once downstream recovers, a successful probe lets traffic through again', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 200 });

            // /api/recovering fails twice and then succeeds
            for (let index = 0; index < 2; index += 1) {
              try {
                await breaker.exec(() => request('/api/recovering'));
              } catch (error) {
                // Expected
              }
            }
            expect(breaker.state()).toBe('open');

            await sleep(200);
            const response = await breaker.exec(() => request('/api/recovering'));
            expect(response.status).toBe(200);
            expect(breaker.state()).toBe('closed');
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'requests.total',
      op: 'lte',
      value: 2,
      zh: '熔断后不再打扰下游',
      en: 'Downstream is untouched while open',
      dimension: 'resilience',
      scope: 'gate:fastfail',
    }),
  ],
  referenceFiles: [
    file(
      'src/circuitBreaker.ts',
      code`
        import { now } from '@lab/env';

        export type CircuitState = 'closed' | 'open' | 'half-open';

        export interface CircuitBreakerOptions {
          failureThreshold: number;
          resetTimeoutMs: number;
          halfOpenMax?: number;
        }

        export interface CircuitBreaker {
          exec<T>(task: () => Promise<T>): Promise<T>;
          state(): CircuitState;
        }

        export class CircuitOpenError extends Error {
          constructor() {
            super('circuit open');
            this.name = 'CircuitOpenError';
          }
        }

        export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
          const halfOpenMax = options.halfOpenMax ?? 1;
          let current: CircuitState = 'closed';
          let failures = 0;
          let openedAt = 0;
          let probes = 0;

          // Reading the state also performs the time-driven open -> half-open transition
          function state(): CircuitState {
            if (current === 'open' && now() - openedAt >= options.resetTimeoutMs) {
              current = 'half-open';
              probes = 0;
            }
            return current;
          }

          function trip(): void {
            current = 'open';
            openedAt = now();
            failures = 0;
            probes = 0;
          }

          return {
            state,

            async exec<T>(task: () => Promise<T>): Promise<T> {
              const snapshot = state();

              if (snapshot === 'open') throw new CircuitOpenError();
              if (snapshot === 'half-open') {
                if (probes >= halfOpenMax) throw new CircuitOpenError();
                probes += 1;
              }

              try {
                const result = await task();
                current = 'closed';
                failures = 0;
                probes = 0;
                return result;
              } catch (error) {
                if (snapshot === 'half-open') {
                  trip();
                } else {
                  failures += 1;
                  if (failures >= options.failureThreshold) trip();
                }
                throw error;
              }
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    '把「时间驱动的状态转换」放进 state() 里，意味着不需要任何定时器就能实现 open→half-open，状态机只在被观察时演进，这让它天然可测。',
    'Putting the time-driven transition inside state() means open→half-open needs no timer at all: the machine advances only when observed, which makes it trivially testable.'
  ),
};

/* ------------------------------------------------------------------ */

const stage6 = {
  id: 'load-balancer',
  title: t('第 6 关 · 负载均衡与健康检查', 'Stage 6 · Load balancing and health checks'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关的熔断器保护的是「一个下游」。真实网关面对的是**一组**下游实例，',
      '其中某一台挂了、某一台在 GC，其余的好好的。',
      '',
      '## 要实现什么',
      '',
      '在 `src/balancer.ts` 实现 `createBalancer(nodes, options)`。',
      '',
      '选择策略三种：',
      '',
      '| 策略 | 做法 |',
      '| --- | --- |',
      '| `round-robin` | 在健康节点里轮流 |',
      '| `least-connections` | 挑当前在飞请求最少的那个 |',
      '| `consistent-hash` | 同一个 key 永远落到同一个节点 |',
      '',
      '外加健康管理：`markStart` / `markEnd` 汇报每次调用的开始和结果；',
      '连续失败 `failureThreshold` 次的节点被摘掉，不再被 `pick` 选中；',
      '`recoverAfterMs` 之后放它回来试探一次。`healthy()` 和 `inFlight(id)` 用来观察内部状态。',
      '',
      '## 怎么算过',
      '',
      '- 三种策略各自的分布符合预期；',
      '- 被判定不健康的节点，之后收到的流量是 **0**（门槛 `counters.deadNodePicks = 0`）；',
      '- 4 个节点里摘掉 1 个，重新映射的 key 不超过 40%',
      '  （门槛 `counters.remappedPercent ≤ 40`）；',
      '- 全部节点都不健康时 `pick` 返回 `null`，而不是硬塞给某一个；',
      '- 节点恢复后能重新参与选择。',
      '',
      '## 两个门槛各自在防什么',
      '',
      '**摘除要彻底。** 「降低它的权重」不算摘除 —— 它仍然在持续吃掉一部分请求，',
      '并且全部失败。门槛写成 `= 0` 就是不给这种折中留余地。',
      '',
      '**一致性哈希要真的一致。** 用 `hash(key) % 节点数` 的实现在这里会重映射 75% ——',
      '缓存全部失效、会话全部丢失，一台机器下线引发一次全局抖动。',
      '哈希环的做法是把节点摆在环上，key 沿环往前找第一个健康节点：',
      '摘掉一个节点，只有原本落在它身上的 key 需要改投，其余不动。',
      '',
      '每个物理节点要放几十个虚拟节点，否则 4 个点在环上的分布会非常不均，',
      '「一致」是做到了，「均衡」却没了。',
      '',
      '还有一个只在 `least-connections` 下才暴露的坑：`markEnd` 的**失败路径也要减 `inFlight`**。',
      '只加不减的话，最先被选中的节点很快「看起来最忙」，之后所有流量都绕开它 ——',
      '一个健康的节点被自己的计数器排挤出局。',
    ].join('\n'),
    [
      'The circuit breaker protects one downstream. A real gateway faces a **set** of instances, one of which',
      'is down, one of which is in GC, and the rest of which are fine.',
      '',
      '## What to build',
      '',
      '`createBalancer(nodes, options)` in `src/balancer.ts`.',
      '',
      'Three selection strategies:',
      '',
      '| Strategy | Approach |',
      '| --- | --- |',
      '| `round-robin` | Take turns among healthy nodes |',
      '| `least-connections` | Pick whichever has the fewest requests in flight |',
      '| `consistent-hash` | The same key always lands on the same node |',
      '',
      'Plus health management: `markStart` / `markEnd` report each call\'s start and outcome; a node failing',
      '`failureThreshold` times consecutively is removed from selection, and `recoverAfterMs` later gets one',
      'probe to prove itself. `healthy()` and `inFlight(id)` expose the internal state.',
      '',
      '## What counts as passing',
      '',
      '- Each strategy distributes as expected;',
      '- A node judged unhealthy receives exactly **zero** traffic afterwards (`counters.deadNodePicks = 0`);',
      '- Removing one of four nodes remaps at most 40% of keys (`counters.remappedPercent ≤ 40`);',
      '- With no healthy node left, `pick` returns `null` rather than forcing one;',
      '- A recovered node re-enters selection.',
      '',
      '## What each gate is defending',
      '',
      '**Removal must be complete.** Lowering a node\'s weight is not removal — it keeps eating a share of',
      'requests and failing all of them. The gate is written as `= 0` precisely to leave no room for that',
      'compromise.',
      '',
      '**Consistent hashing must actually be consistent.** A `hash(key) % nodeCount` implementation remaps',
      '75% of keys here — every cache invalidated, every session lost, one machine going offline causing a',
      'global disturbance. A hash ring places nodes around a circle and walks forward from the key to the',
      'first healthy node: removing a node only rehomes the keys that landed on it, and leaves the rest',
      'alone.',
      '',
      'Each physical node needs dozens of virtual points on the ring, or four nodes distribute very unevenly',
      '— consistent, yes, but no longer balanced.',
      '',
      'One more trap shows up only under `least-connections`: `markEnd` must decrement `inFlight` on the',
      '**failure path too**. Increment without decrement and the first node picked quickly "looks busiest",',
      'after which all traffic routes around it — a healthy node squeezed out by its own counter.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**构造时** —— 两份状态，之后全靠它们',
      '',
      '```mermaid',
      'flowchart TD',
      '  I0["createBalancer(nodes, options)"] --> I1["states：每个节点一份<br/>inFlight / consecutiveFailures / downUntil"]',
      '  I0 --> I2["哈希环：每个物理节点放 virtualNodes 个虚拟点<br/>hash(id + \'#\' + i)，整体按 hash 排序"]',
      '```',
      '',
      '**pick(key?)** —— 先滤掉不健康的，再按策略选',
      '',
      '```mermaid',
      'flowchart TD',
      '  P1["healthyStates()<br/>downUntil 为 0，或 now 已过 downUntil"] --> P2{"还有健康节点吗？"}',
      '  P2 -- 没有 --> PNULL["返回 null，不硬塞"]',
      '  P2 -- 有 --> P3{"strategy"}',
      '  P3 -- least-connections --> LC["取 inFlight 最小的那个"]',
      '  P3 -- consistent-hash --> CH["binarySearch(ring, hash(key))<br/>沿环往前找第一个健康的虚拟点<br/>绕回开头继续找"]',
      '  P3 -- round-robin --> RR["cursor 在健康列表里轮转"]',
      '```',
      '',
      '不健康的节点在**入口处**就被整个滤掉，三种策略都只在健康列表里做选择 ——',
      '摘除因此天然是彻底的，不需要每种策略各写一遍。',
      '',
      '`CH` 里「沿环往前找第一个健康的点」是重映射比例的来源：摘掉一个节点，',
      '只有原先落在它虚拟点上的 key 会往前挪到下一个节点，其余 key 的落点完全不动。',
      '',
      '**健康状态怎么变**',
      '',
      '```mermaid',
      'flowchart TD',
      '  MS["markStart(id)"] --> H1["inFlight += 1"]',
      '  ME["markEnd(id, ok)"] --> H2["inFlight -= 1<br/>成功失败都要减"]',
      '  H2 --> H3{"ok？"}',
      '  H3 -- 成功 --> H4["consecutiveFailures = 0<br/>downUntil = 0"]',
      '  H3 -- 失败 --> H5["consecutiveFailures += 1"]',
      '  H5 --> H6{"≥ failureThreshold？"}',
      '  H6 -- 是 --> H7["downUntil = now + recoverAfterMs<br/>从此 pick 不再选它"]',
      '```',
    ].join('\n'),
    [
      '**At construction** — two pieces of state carry everything afterwards',
      '',
      '```mermaid',
      'flowchart TD',
      '  I0["createBalancer(nodes, options)"] --> I1["states: one record per node<br/>inFlight / consecutiveFailures / downUntil"]',
      '  I0 --> I2["hash ring: virtualNodes points per physical node<br/>hash(id + \'#\' + i), sorted by hash"]',
      '```',
      '',
      '**pick(key?)** — filter out the unhealthy first, then apply the strategy',
      '',
      '```mermaid',
      'flowchart TD',
      '  P1["healthyStates()<br/>downUntil is 0, or now has passed it"] --> P2{"any healthy node left?"}',
      '  P2 -- none --> PNULL["return null rather than forcing one"]',
      '  P2 -- yes --> P3{"strategy"}',
      '  P3 -- least-connections --> LC["take the smallest inFlight"]',
      '  P3 -- consistent-hash --> CH["binarySearch(ring, hash(key))<br/>walk forward to the first healthy point<br/>wrapping around the ring"]',
      '  P3 -- round-robin --> RR["cursor rotates through the healthy list"]',
      '```',
      '',
      'Unhealthy nodes are filtered out **at the entrance**, and all three strategies choose only from the',
      'healthy list — so removal is complete by construction rather than re-implemented per strategy.',
      '',
      '"Walk forward to the first healthy point" inside `CH` is where the remap percentage comes from:',
      'removing a node only moves the keys that sat on its virtual points forward to the next node, and every',
      'other key\'s destination is untouched.',
      '',
      '**How health changes**',
      '',
      '```mermaid',
      'flowchart TD',
      '  MS["markStart(id)"] --> H1["inFlight += 1"]',
      '  ME["markEnd(id, ok)"] --> H2["inFlight -= 1<br/>on success and failure alike"]',
      '  H2 --> H3{"ok?"}',
      '  H3 -- success --> H4["consecutiveFailures = 0<br/>downUntil = 0"]',
      '  H3 -- failure --> H5["consecutiveFailures += 1"]',
      '  H5 --> H6{"≥ failureThreshold?"}',
      '  H6 -- yes --> H7["downUntil = now + recoverAfterMs<br/>pick stops choosing it"]',
      '```',
    ].join('\n')
  ),
  checklist: [
    t('轮询均匀分配', 'Round robin distributes evenly'),
    t('最少连接选中在飞最少的节点', 'Least connections picks the least busy node'),
    t('同一个 key 稳定落到同一个节点', 'The same key lands on the same node every time'),
    t('不健康的节点收到零流量', 'An unhealthy node receives zero traffic'),
    t('摘掉一个节点只重映射它那一份 key', 'Removing a node only remaps its own share of keys'),
  ],
  pitfalls: [
    t(
      '一致性哈希用 `hash(key) % nodes.length`。它满足「同一个 key 落到同一个节点」这条，所以功能测试全过——但节点数一变，几乎所有 key 的映射都变了。缓存命中率瞬间归零，下游被回源流量打垮。一致性哈希的全部意义就是让这个比例从 O(1) 降到 O(1/n)。',
      'Implementing consistent hashing as `hash(key) % nodes.length`. It satisfies "same key, same node", so every functional test passes — and changing the node count remaps nearly every key. Cache hit rate drops to zero and the origin is flattened by the refill. Reducing that fraction from O(1) to O(1/n) is the entire point of consistent hashing.'
    ),
    t(
      '哈希环上每个物理节点只放一个点。理论上没错，实践中分布会极不均匀——三个节点可能分到 60%/30%/10% 的 key。要给每个物理节点放几十上百个「虚拟节点」，让它们在环上交错分布，方差才会降下来。',
      'Placing one point per physical node on the hash ring. Theoretically fine and practically very uneven — three nodes can end up with 60%, 30% and 10% of the keys. Each physical node needs dozens or hundreds of virtual nodes interleaved around the ring before the variance settles.'
    ),
    t(
      '`least-connections` 只在请求开始时加计数，忘了在结束时减。计数只增不减，第一个被选中的节点很快就「看起来最忙」，之后所有流量都会绕开它——负载均衡器把最健康的节点排除在外了。开始和结束必须成对，而且结束要放在 finally 里，失败路径同样要减。',
      'Incrementing the in-flight count on start and never decrementing on finish. The count only grows, the first node picked soon looks busiest, and all traffic routes around it — the balancer excludes the healthiest node. Start and end must be paired, with the decrement in a `finally` so the failure path decrements too.'
    ),
    t(
      '健康状态用「失败率」而不是「连续失败次数」判断。刚启动时样本很少，一次失败就是 100% 失败率，节点会被立刻误摘；而一个持续 40% 失败的节点，在 50% 的阈值下永远摘不掉。连续失败计数对冷启动友好，而且语义明确——真实系统通常两者都用，但先做对连续计数这一条。',
      'Judging health by failure rate rather than consecutive failures. At startup the sample is tiny and one failure is a 100% rate, so a healthy node is removed immediately; meanwhile a node failing steadily at 40% never crosses a 50% threshold. Consecutive counting is friendly to cold start and unambiguous — real systems use both, but get this one right first.'
    ),
  ],
  hints: [
    t(
      '哈希环用一个排好序的数组存 `{ hash, nodeId }`，查找就是「找第一个 hash 大于等于 key 的哈希值的点，绕回开头」。二分查找可以，节点不多时线性扫也够。',
      'Store the ring as a sorted array of `{ hash, nodeId }` and look up "the first point whose hash is at least the key\'s, wrapping to the start". Binary search works; a linear scan is fine at these sizes.'
    ),
    t(
      '字符串哈希用 FNV-1a 就够了：`h = 2166136261; for (ch) { h ^= ch; h = Math.imul(h, 16777619); } return h >>> 0`。',
      'FNV-1a suffices for hashing strings: `h = 2166136261; for each char { h ^= ch; h = Math.imul(h, 16777619); } return h >>> 0`.'
    ),
  ],
  extension: t(
    [
      '一致性哈希是 1997 年 MIT 那篇论文提出来的，最初是为了 web 缓存集群。',
      '今天它无处不在：Memcached 客户端、Cassandra 和 DynamoDB 的分区、',
      'Envoy 的 ring hash 负载均衡、以及几乎所有分片方案。',
      '',
      '虚拟节点解决了分布不均，但带来另一个问题：**节点数据量不一致时无法调整**。',
      '一台机器内存是别人两倍，你希望它多分一份 key——加权一致性哈希的做法是',
      '给它更多虚拟节点。Ketama（Memcached 的标准实现）就是这么做的。',
      '',
      '另一个方向是 **rendezvous hashing**（又叫 HRW）：不建环，',
      '对每个 key 计算它和所有节点的组合哈希，取最大的那个。',
      '它的重映射比例和一致性哈希一样好，实现更简单，而且天然支持权重——',
      '代价是查找复杂度从 O(log n) 变成 O(n)，节点很多时不划算。',
      '',
      '至于健康检查，这一关做的是**被动**的（从真实请求的成败推断）。',
      '真实系统还会做**主动**探测：定期打一个 `/health` 接口。',
      '两者互补——被动检查反应快但只覆盖有流量的节点，',
      '主动探测能发现「刚恢复但还没流量」的节点。',
      'Envoy 的 outlier detection 是被动的，health checking 是主动的，两个功能是分开的。',
    ].join('\n'),
    [
      'Consistent hashing comes from a 1997 MIT paper, originally for web cache clusters. Today it is',
      'everywhere: Memcached clients, Cassandra and DynamoDB partitioning, Envoy ring hash balancing and',
      'essentially every sharding scheme.',
      '',
      'Virtual nodes fix uneven distribution and introduce another problem: you cannot adjust for nodes of',
      'different capacity. A machine with twice the memory should hold twice the keys, and weighted',
      'consistent hashing does that by giving it more virtual nodes. Ketama, the standard Memcached',
      'implementation, works exactly this way.',
      '',
      'A different approach is rendezvous hashing (HRW): build no ring, and for each key compute a combined',
      'hash against every node, taking the highest. Its remapping fraction is as good as consistent',
      'hashing, it is simpler to implement and it supports weights natively — at the cost of O(n) lookup',
      'instead of O(log n), which does not pay off with many nodes.',
      '',
      'As for health, this stage does passive checking, inferring from real request outcomes. Real systems',
      'also probe actively against a `/health` endpoint. The two are complementary: passive reacts quickly',
      'but only covers nodes receiving traffic, while active probing finds a node that has recovered but',
      "has not been sent anything yet. In Envoy these are separate features — outlier detection is passive,",
      'health checking is active.',
    ].join('\n')
  ),
  focus: ['resilience', 'correctness', 'concurrency'],
  lab: {},
  starterFiles: [
    file(
      'src/balancer.ts',
      code`
        export interface Node {
          id: string;
          url: string;
        }

        export type Strategy = 'round-robin' | 'least-connections' | 'consistent-hash';

        export interface BalancerOptions {
          strategy: Strategy;
          /** How many consecutive failures mark a node unhealthy */
          failureThreshold: number;
          /** How long before it is let back in for a probe */
          recoverAfterMs: number;
          /** Virtual nodes per physical node for consistent hashing; defaults to 64 */
          virtualNodes?: number;
        }

        export interface Balancer {
          /** The consistent-hash strategy needs a key; returns null when no node is healthy */
          pick(key?: string): Node | null;
          markStart(id: string): void;
          markEnd(id: string, ok: boolean): void;
          healthy(): string[];
          inFlight(id: string): number;
        }

        export function createBalancer(nodes: Node[], options: BalancerOptions): Balancer {
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
        import { createBalancer } from '../src/balancer';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const NODES = [
          { id: 'a', url: 'http://a' },
          { id: 'b', url: 'http://b' },
          { id: 'c', url: 'http://c' },
          { id: 'd', url: 'http://d' },
        ];

        const HEALTH = { failureThreshold: 3, recoverAfterMs: 1000 };

        function keys(total: number): string[] {
          const list: string[] = [];
          for (let index = 0; index < total; index += 1) list.push('session-' + index);
          return list;
        }

        describe('Stage 6 · Selection strategies', () => {
          it('round robin picks each node in turn', () => {
            const balancer = createBalancer(NODES, { strategy: 'round-robin', ...HEALTH });
            const picked = [0, 1, 2, 3, 4].map(() => balancer.pick()!.id);
            expect(picked.slice(0, 4).sort()).toEqual(['a', 'b', 'c', 'd']);
            expect(picked[4]).toBe(picked[0]);
          });

          it('least-connections picks the one with the fewest in flight', () => {
            const balancer = createBalancer(NODES, { strategy: 'least-connections', ...HEALTH });
            balancer.markStart('a');
            balancer.markStart('a');
            balancer.markStart('b');

            const picked = balancer.pick()!.id;
            expect(picked === 'c' || picked === 'd').toBe(true);
          });

          it('the count comes back down when a request finishes', () => {
            const balancer = createBalancer(NODES, { strategy: 'least-connections', ...HEALTH });
            balancer.markStart('a');
            expect(balancer.inFlight('a')).toBe(1);
            balancer.markEnd('a', true);
            expect(balancer.inFlight('a')).toBe(0);
          });

          it('a failed request decrements the count too', () => {
            const balancer = createBalancer(NODES, { strategy: 'least-connections', ...HEALTH });
            balancer.markStart('a');
            balancer.markEnd('a', false);
            expect(balancer.inFlight('a')).toBe(0);
          });

          it('consistent hashing: one key lands on the same node every time', () => {
            const balancer = createBalancer(NODES, { strategy: 'consistent-hash', ...HEALTH });
            const first = balancer.pick('user-42')!.id;
            for (let index = 0; index < 20; index += 1) {
              expect(balancer.pick('user-42')!.id).toBe(first);
            }
          });

          it('consistent hashing distributes roughly evenly', () => {
            const balancer = createBalancer(NODES, { strategy: 'consistent-hash', ...HEALTH });
            const tally: Record<string, number> = {};
            for (const key of keys(1000)) {
              const id = balancer.pick(key)!.id;
              tally[id] = (tally[id] || 0) + 1;
            }
            for (const node of NODES) {
              expect(tally[node.id] || 0).toBeGreaterThan(100);
            }
          });
        });

        describe('Stage 6 · Health management', () => {
          it('a node is pulled once consecutive failures reach the threshold', () => {
            const balancer = createBalancer(NODES, { strategy: 'round-robin', ...HEALTH });
            for (let index = 0; index < 3; index += 1) balancer.markEnd('a', false);
            expect(balancer.healthy().sort()).toEqual(['b', 'c', 'd']);
          });

          it('a success in between resets the consecutive failure count', () => {
            const balancer = createBalancer(NODES, { strategy: 'round-robin', ...HEALTH });
            balancer.markEnd('a', false);
            balancer.markEnd('a', false);
            balancer.markEnd('a', true);
            balancer.markEnd('a', false);
            expect(balancer.healthy()).toContain('a');
          });

          it('an unhealthy node receives zero traffic [gate:dead-node]', () => {
            const balancer = createBalancer(NODES, { strategy: 'round-robin', ...HEALTH });
            for (let index = 0; index < 3; index += 1) balancer.markEnd('a', false);

            let deadPicks = 0;
            for (let index = 0; index < 200; index += 1) {
              if (balancer.pick()!.id === 'a') deadPicks += 1;
            }
            count('deadNodePicks', deadPicks);
            expect(deadPicks).toBe(0);
          });

          it('consistent hashing routes around unhealthy nodes too', () => {
            const balancer = createBalancer(NODES, { strategy: 'consistent-hash', ...HEALTH });
            for (let index = 0; index < 3; index += 1) balancer.markEnd('a', false);

            for (const key of keys(200)) {
              expect(balancer.pick(key)!.id).not.toBe('a');
            }
          });

          it('a node is let back in for a probe after the recovery period', async () => {
            const balancer = createBalancer(NODES, { strategy: 'round-robin', ...HEALTH });
            for (let index = 0; index < 3; index += 1) balancer.markEnd('a', false);
            expect(balancer.healthy()).not.toContain('a');

            await sleep(1100);
            expect(balancer.healthy()).toContain('a');
          });

          it('returns null when every node is unhealthy', () => {
            const balancer = createBalancer(NODES, { strategy: 'round-robin', ...HEALTH });
            for (const node of NODES) {
              for (let index = 0; index < 3; index += 1) balancer.markEnd(node.id, false);
            }
            expect(balancer.pick()).toBeNull();
          });

          it("pulling one node remaps only that node's share of the keys [gate:remap]", () => {
            const before = createBalancer(NODES, { strategy: 'consistent-hash', ...HEALTH });
            const sample = keys(1000);
            const original = sample.map((key) => before.pick(key)!.id);

            // Pull a
            for (let index = 0; index < 3; index += 1) before.markEnd('a', false);
            const after = sample.map((key) => before.pick(key)!.id);

            let moved = 0;
            for (let index = 0; index < sample.length; index += 1) {
              if (original[index] !== after[index]) moved += 1;
            }
            const percent = Math.round((moved / sample.length) * 100);
            count('remappedPercent', percent);

            // A hash % nodeCount implementation lands around 75% here
            expect(percent).toBeLessThanOrEqual(40);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.deadNodePicks',
      op: 'eq',
      value: 0,
      zh: '被摘除的节点收到零流量',
      en: 'A removed node receives zero traffic',
      dimension: 'resilience',
      scope: 'gate:dead-node',
    }),
    gate({
      metric: 'counters.remappedPercent',
      op: 'lte',
      value: 40,
      unit: '%',
      zh: '摘掉四分之一的节点，重映射的 key 不超过 40%',
      en: 'Removing a quarter of the nodes remaps at most 40% of keys',
      dimension: 'correctness',
      scope: 'gate:remap',
    }),
  ],
  referenceFiles: [
    file(
      'src/balancer.ts',
      code`
        import { now } from '@lab/env';

        export interface Node {
          id: string;
          url: string;
        }

        export type Strategy = 'round-robin' | 'least-connections' | 'consistent-hash';

        export interface BalancerOptions {
          strategy: Strategy;
          failureThreshold: number;
          recoverAfterMs: number;
          virtualNodes?: number;
        }

        export interface Balancer {
          pick(key?: string): Node | null;
          markStart(id: string): void;
          markEnd(id: string, ok: boolean): void;
          healthy(): string[];
          inFlight(id: string): number;
        }

        interface NodeState {
          node: Node;
          inFlight: number;
          consecutiveFailures: number;
          downUntil: number;
        }

        /** FNV-1a: fast enough and even enough, with no need for cryptographic strength */
        function hash(text: string): number {
          let value = 2166136261;
          for (let index = 0; index < text.length; index += 1) {
            value ^= text.charCodeAt(index);
            value = Math.imul(value, 16777619);
          }
          return value >>> 0;
        }

        export function createBalancer(nodes: Node[], options: BalancerOptions): Balancer {
          const states = new Map<string, NodeState>();
          for (const node of nodes) {
            states.set(node.id, { node, inFlight: 0, consecutiveFailures: 0, downUntil: 0 });
          }

          // The hash ring: many virtual nodes per physical node, otherwise four nodes spread very unevenly
          const virtualCount = options.virtualNodes ?? 64;
          const ring: Array<{ hash: number; id: string }> = [];
          for (const node of nodes) {
            for (let index = 0; index < virtualCount; index += 1) {
              ring.push({ hash: hash(node.id + '#' + index), id: node.id });
            }
          }
          ring.sort((left, right) => left.hash - right.hash);

          function isHealthy(state: NodeState): boolean {
            // Let it back in for a probe once the recovery period passes, with no extra timer needed
            return state.downUntil === 0 || now() >= state.downUntil;
          }

          function healthyStates(): NodeState[] {
            return Array.from(states.values()).filter(isHealthy);
          }

          let cursor = 0;

          return {
            pick(key?: string): Node | null {
              const available = healthyStates();
              if (available.length === 0) return null;

              if (options.strategy === 'least-connections') {
                return available.reduce((best, current) =>
                  current.inFlight < best.inFlight ? current : best
                ).node;
              }

              if (options.strategy === 'consistent-hash' && typeof key === 'string') {
                const live = new Set(available.map((state) => state.node.id));
                const target = hash(key);
                // Walk forward around the ring to the first healthy point, wrapping to the start.
                // With hash % nodes.length, changing the node count moves almost every key
                for (let step = 0; step < ring.length; step += 1) {
                  const point = ring[(binarySearch(ring, target) + step) % ring.length];
                  if (live.has(point.id)) return (states.get(point.id) as NodeState).node;
                }
                return available[0].node;
              }

              const chosen = available[cursor % available.length];
              cursor += 1;
              return chosen.node;
            },

            markStart(id: string): void {
              const state = states.get(id);
              if (state) state.inFlight += 1;
            },

            markEnd(id: string, ok: boolean): void {
              const state = states.get(id);
              if (!state) return;
              // The failure path has to decrement too: incrementing without decrementing soon makes
              // the first node picked look busiest, after which all traffic routes around it
              state.inFlight = Math.max(0, state.inFlight - 1);

              if (ok) {
                state.consecutiveFailures = 0;
                state.downUntil = 0;
                return;
              }

              state.consecutiveFailures += 1;
              if (state.consecutiveFailures >= options.failureThreshold) {
                state.downUntil = now() + options.recoverAfterMs;
                state.consecutiveFailures = 0;
              }
            },

            healthy(): string[] {
              return healthyStates().map((state) => state.node.id);
            },

            inFlight(id: string): number {
              const state = states.get(id);
              return state ? state.inFlight : 0;
            },
          };
        }

        /** Find the first point on the ring whose hash is not below target, wrapping to 0 */
        function binarySearch(ring: Array<{ hash: number; id: string }>, target: number): number {
          let low = 0;
          let high = ring.length - 1;
          let answer = 0;
          while (low <= high) {
            const mid = (low + high) >> 1;
            if (ring[mid].hash >= target) {
              answer = mid;
              high = mid - 1;
            } else {
              low = mid + 1;
            }
          }
          return answer;
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**哈希环上每个物理节点放 64 个虚拟节点。** 只放一个的话，四个节点在环上的位置',
      '完全由 `hash(id)` 决定，分布方差极大——很可能出现 60%/25%/10%/5% 这样的分配。',
      '虚拟节点把每个物理节点拆成很多小段交错插入，大数定律才开始起作用。',
      '这个数字是取舍：越多分布越均，环越大、查找越慢、内存越多。',
      '',
      '**摘除是「跳过」而不是「重建环」。** `pick` 里先算出落点，再沿环往前找第一个',
      '**健康**的节点。重建环（把不健康节点的虚拟节点全删掉）也能工作，',
      '但每次健康状态变化都要重排一次环，而且恢复时又要插回去——',
      '跳过的做法让环成为一个不可变结构，健康状态是叠在它上面的一层过滤。',
      '',
      '**`isHealthy` 用时间戳而不是布尔标志。** `downUntil` 是一个绝对时刻，',
      '「现在健康吗」这个问题任何时候问都能立刻算出来，不需要定时器把节点标回健康。',
      '和第 1 关固定窗口用 `Math.floor(now()/windowMs)` 是同一个思路：',
      '能用「当前时间 + 一个数」表达的状态，就不要用需要维护的标志位。',
      '',
      '**`markEnd` 里 `inFlight` 的减法在最前面，与成败无关。** 请求结束了就是结束了，',
      '成功失败都要还回并发计数。把它放进 `if (ok)` 分支里，是',
      '「最少连接」这个策略最常见的坏法。',
    ].join('\n'),
    [
      'Sixty-four virtual nodes per physical node. With one each, four nodes land wherever `hash(id)` puts',
      'them and the variance is enormous — 60/25/10/5 splits are entirely plausible. Virtual nodes slice',
      'each physical node into many interleaved arcs so the law of large numbers can take over. The count',
      'is a trade: more is more even, and makes the ring larger, lookups slower and memory higher.',
      '',
      'Removal is a skip, not a rebuild. `pick` computes the landing point and then walks forward to the',
      'first healthy node. Rebuilding the ring by deleting an unhealthy node\'s virtual nodes also works,',
      'and it re-sorts the ring on every health change and re-inserts on recovery. Skipping keeps the ring',
      'immutable with health as a filter layered on top.',
      '',
      '`isHealthy` uses a timestamp rather than a boolean. `downUntil` is an absolute instant, so "is it',
      'healthy now" is computable at any moment without a timer to flip the flag back. Same idea as the',
      'fixed window using `Math.floor(now()/windowMs)` in stage 1: state expressible as "current time plus',
      'a number" should never become a flag that has to be maintained.',
      '',
      "In `markEnd` the `inFlight` decrement comes first and does not depend on the outcome. A finished",
      'request is finished either way. Putting it inside the `if (ok)` branch is the most common way to',
      'break least-connections balancing.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage7 = {
  id: 'bulkhead',
  title: t('第 7 关 · 舱壁隔离', 'Stage 7 · Bulkhead isolation'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '网关同时代理十个下游。其中一个变慢了 —— 不是挂掉，只是从 50ms 变成 30 秒。',
      '如果所有下游共用同一个工作线程池，很快所有槽位都会被这个慢下游占满，',
      '**另外九个健康的下游也一起不可用了**。',
      '',
      '这是级联故障最常见的形态：一个依赖的问题，通过共享资源传染给了全部。',
      '船用隔水舱壁的思路是：把资源切成互不相通的几块，一块进水不影响其他。',
      '',
      '## 要实现什么',
      '',
      '在 `src/bulkhead.ts` 实现 `createBulkhead(options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `run(pool, task)` | pool 没满就执行；满了**立刻**抛 `BulkheadFullError`，不排队 |',
      '| `inFlight(pool)` | 这个池当前在飞多少 |',
      '| `rejected(pool)` | 这个池累计拒了多少 |',
      '',
      '每个 pool 有自己的并发上限，配置里没写的池用 `defaultLimit`。',
      '',
      '## 怎么算过',
      '',
      '- 每个池的并发不超过自己的上限；',
      '- 池满时立刻拒绝，不等待、不排队；',
      '- 任务**抛异常时槽位也要还**；',
      '- `slow` 池被两个永不返回的请求占满时，`fast` 池的请求以自己的速度完成',
      '  （门槛 `counters.fastPoolLatencyMs ≤ 60`）。',
      '',
      '## 为什么舱壁不排队',
      '',
      '注意它和背压的区别：背压排队，舱壁**不排队**。',
      '',
      '舱壁的目的不是削峰，而是**画出一条资源边界**，',
      '让「慢下游最多能占用我多少资源」有一个确定的上界。',
      '一旦开始排队，这个上界就在时间维度上变成了无限 —— 队列里的请求还是你的内存、',
      '还是你的连接，只是暂时还没发出去而已。',
      '',
      '另一个必须写对的地方是还槽位要放在 `finally` 里，不能只在成功分支还。',
      '下游报错时不还槽位的话，几次失败就能把这个池的可用并发降到 0 ——',
      '舱壁本身成了那个把服务憋死的东西。',
    ].join('\n'),
    [
      'A gateway proxies ten downstreams. One of them slows down — not failing, just going from 50ms to',
      'thirty seconds. If every downstream shares one worker pool, that one soon holds every slot and',
      '**the other nine healthy downstreams become unavailable with it**.',
      '',
      'That is the most common shape of cascading failure: one dependency\'s problem spreading to everything',
      'through a shared resource. The naval answer is a bulkhead — divide the resource into compartments so',
      'flooding one does not sink the ship.',
      '',
      '## What to build',
      '',
      '`createBulkhead(options)` in `src/bulkhead.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `run(pool, task)` | Execute while there is room; when full, throw `BulkheadFullError` **immediately**, never queue |',
      '| `inFlight(pool)` | How many are in flight in this pool |',
      '| `rejected(pool)` | How many this pool has refused |',
      '',
      'Each pool has its own concurrency limit; pools absent from the config use `defaultLimit`.',
      '',
      '## What counts as passing',
      '',
      '- No pool exceeds its own limit;',
      '- A full pool refuses immediately, without waiting or queueing;',
      '- A slot is returned **even when the task throws**;',
      '- With the `slow` pool saturated by two requests that never return, `fast` pool requests finish at',
      '  their own speed (`counters.fastPoolLatencyMs ≤ 60`).',
      '',
      '## Why a bulkhead does not queue',
      '',
      'Note the difference from backpressure: a queue holds work, a bulkhead **does not**.',
      '',
      'Its purpose is not smoothing peaks but **drawing a resource boundary**, giving "how much a slow',
      'downstream can consume of me" a definite ceiling. Start queueing and that ceiling becomes unbounded in',
      'time — queued requests are still your memory and still your connections; they simply have not gone',
      'out yet.',
      '',
      'The other thing that must be right is returning the slot in `finally`, not only on the success path.',
      'Fail to return it when the downstream errors and a handful of failures drive the pool\'s usable',
      'concurrency to zero — the bulkhead becomes the thing that suffocates the service.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  R["run(pool, task)"] --> L["limitOf(pool)<br/>配置里写了就用配置，否则 defaultLimit"]',
      '  L --> C{"running[pool] ≥ 上限？"}',
      '  C -- 是 --> REJ["refused[pool] += 1<br/>抛 BulkheadFullError<br/>不排队、不等待"]',
      '  C -- 否 --> INC["running[pool] += 1"]',
      '  INC --> RUN["await task()"]',
      '  RUN --> FIN["finally：running[pool] -= 1<br/>成功、抛错都要还槽位"]',
      '  FIN --> OUT["task 的结果或异常原样传出去"]',
      '',
      '  subgraph maps["状态就是两张按池分开的 Map"]',
      '    M1["running：池名 → 在飞数"]',
      '    M2["refused：池名 → 被拒数"]',
      '  end',
      '',
      '  M1 -.-> C',
      '  M2 -.-> REJ',
      '```',
      '',
      '要点：这一关的隔离不是靠什么复杂机制，就是靠**计数器按池分开**这一件事。',
      '`slow` 池的 `running` 涨到上限，`fast` 池的那个数字一点没动，',
      '于是 `C` 这个判断对 `fast` 的请求永远是「否」。',
      '',
      '`FIN` 用 `finally` 而不是成功分支 —— 这是图里唯一一个「异常路径也必须经过」的节点。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  R["run(pool, task)"] --> L["limitOf(pool)<br/>the configured limit, else defaultLimit"]',
      '  L --> C{"running[pool] ≥ limit?"}',
      '  C -- yes --> REJ["refused[pool] += 1<br/>throw BulkheadFullError<br/>no queue, no wait"]',
      '  C -- no --> INC["running[pool] += 1"]',
      '  INC --> RUN["await task()"]',
      '  RUN --> FIN["finally: running[pool] -= 1<br/>the slot returns on success and on throw"]',
      '  FIN --> OUT["the task\'s result or error passes through unchanged"]',
      '',
      '  subgraph maps["state is two Maps, keyed per pool"]',
      '    M1["running: pool → in flight"]',
      '    M2["refused: pool → refusals"]',
      '  end',
      '',
      '  M1 -.-> C',
      '  M2 -.-> REJ',
      '```',
      '',
      'The point: the isolation here comes from no clever mechanism — only from **the counters being',
      'separate per pool**. The `slow` pool\'s `running` climbs to its limit while the `fast` pool\'s number',
      'never moves, so the `C` test answers "no" for every `fast` request.',
      '',
      '`FIN` is a `finally` rather than a success branch — the one node in the diagram that the error path',
      'must also pass through.',
    ].join('\n')
  ),
  checklist: [
    t('每个池有独立的并发上限', 'Each pool has its own concurrency limit'),
    t('池满时立刻抛错，不排队', 'A full pool throws immediately rather than queueing'),
    t('一个池被占满不影响其他池', 'Saturating one pool does not affect the others'),
    t('任务结束后释放槽位，失败也要释放', 'Slots are released on completion, including on failure'),
    t('rejected 计数可观测', 'Rejections are counted and observable'),
  ],
  pitfalls: [
    t(
      '所有下游共用一个并发上限。这是没有舱壁的默认状态，也是级联故障的标准配方：最慢的那个依赖会逐渐占满所有槽位，因为它的请求停留时间最长。健康的下游明明能在 50ms 内返回，却因为拿不到槽位而超时——故障从一个依赖扩散到了全部。',
      'One shared concurrency limit for every downstream. That is the default state without bulkheads and the standard recipe for cascading failure: the slowest dependency gradually occupies every slot because its requests linger longest. Healthy downstreams that could answer in 50ms time out waiting for a slot, and the failure spreads from one dependency to all of them.'
    ),
    t(
      '池满时排队而不是拒绝。看起来更温和，实际上取消了舱壁的全部意义：慢下游占用的资源从「N 个槽位」变成了「N 个槽位 + 无限长的队列」，内存和延迟都失去了上界。要排队就明确地在舱壁**外面**排（那是第 9 关背压的职责），舱壁本身必须是硬边界。',
      'Queueing instead of rejecting when a pool is full. It looks gentler and removes the entire point: what a slow downstream occupies goes from N slots to N slots plus an unbounded queue, so both memory and latency lose their ceiling. If queueing is wanted it belongs outside the bulkhead; the bulkhead itself must be a hard boundary.'
    ),
    t(
      '释放槽位只写在成功路径上。任务抛错时槽位没还回去，几次失败之后这个池的可用并发就变成了 0——而它对应的下游可能早就恢复了。释放必须放在 `finally` 里，这是所有「借用-归还」型资源的通用要求。',
      'Releasing the slot only on the success path. A throwing task never returns its slot, and after a few failures that pool has zero usable concurrency while its downstream may have recovered long ago. Release belongs in a `finally`, as with every borrow-and-return resource.'
    ),
    t(
      '把并发上限设得和线程池一样大。舱壁的上限之和**应该**超过总资源——否则就退化成了静态分区，闲置的池占着资源不用。真实配置通常让各池上限之和是总量的 1.5~2 倍，赌的是「不会所有下游同时满负荷」。设成刚好相等，是把可用性换成了绝对的隔离性。',
      'Sizing pool limits so they sum exactly to the total resource. Bulkhead limits should oversubscribe — otherwise it degenerates into static partitioning where idle pools hold resources nobody uses. Real configurations sum to roughly 1.5–2x the total, betting that not every downstream saturates at once. Making them sum exactly trades availability for absolute isolation.'
    ),
  ],
  hints: [
    t(
      '每个池就是一个计数器加一个上限。`run` 是「计数 < 上限就加一并执行，否则抛错」，`finally` 里减一。',
      'A pool is a counter and a limit. `run` increments and executes while the counter is below the limit and throws otherwise, decrementing in a `finally`.'
    ),
    t(
      '拒绝路径上不要 `await` 任何东西，直接抛。和第 9 关一样，「立刻」这个语义是靠同步抛出实现的。',
      'Do not `await` anything on the rejection path; throw directly. As in the backpressure stage, "immediately" comes from throwing synchronously.'
    ),
  ],
  extension: t(
    [
      '舱壁模式来自 Michael Nygard 的《Release It!》，和熔断器出自同一本书。',
      '两者经常被混淆，但解决的是不同的问题：',
      '熔断器关心「这个下游是不是坏了」，舱壁关心「这个下游最多能占用我多少资源」。',
      '一个下游可能完全健康、只是慢，熔断器不会跳闸，而舱壁照样在保护你。',
      '',
      '实现上有两个流派。**线程池隔离**给每个下游一个独立的线程池，',
      '隔离最彻底（连线程栈都是分开的），代价是线程切换开销和内存。',
      'Hystrix 默认用这种。**信号量隔离**就是这一关的做法——一个计数器，',
      '开销几乎为零，但调用仍然发生在调用方线程上，所以挡不住「下游把调用方线程卡死」。',
      'Resilience4j 默认用信号量，因为在 Java 异步化之后线程池隔离的收益变小了。',
      '',
      '还有一个容易被忽略的维度：**舱壁该按什么划分**。',
      '按下游服务划分是最常见的，但有时按「调用方」划分更有意义——',
      '同一个下游，来自后台批处理的调用和来自用户请求的调用应该分开限，',
      '否则一个失控的批处理任务能把用户请求挤没。',
      '这和第 3 关多维限流是同一个思想：资源边界可以有多个维度。',
    ].join('\n'),
    [
      "The bulkhead pattern comes from Michael Nygard's Release It!, the same book as the circuit breaker.",
      'The two are often confused and solve different problems: a breaker asks whether a downstream is',
      'broken, a bulkhead asks how much of me it may consume. A downstream can be perfectly healthy and',
      'merely slow, in which case the breaker never trips and the bulkhead is still protecting you.',
      '',
      'There are two implementation schools. Thread-pool isolation gives each downstream its own pool, the',
      'most complete separation — even the stacks are separate — at the cost of context switching and',
      'memory. Hystrix defaulted to this. Semaphore isolation is what this stage does: a counter, almost',
      "free, though the call still runs on the caller's thread so it cannot stop a downstream from blocking",
      'that thread. Resilience4j defaults to semaphores, since thread-pool isolation pays off less once the',
      'surrounding code is asynchronous.',
      '',
      'One dimension is easy to overlook: what the bulkheads should divide by. Per downstream service is',
      'most common, and sometimes per caller makes more sense — calls to the same downstream from a',
      'background batch job and from user requests deserve separate limits, or a runaway batch squeezes out',
      'the users. Same idea as multi-dimensional quotas in stage 3: a resource boundary can have several',
      'dimensions.',
    ].join('\n')
  ),
  focus: ['resilience', 'concurrency', 'latency'],
  lab: {},
  starterFiles: [
    file(
      'src/bulkhead.ts',
      code`
        export class BulkheadFullError extends Error {
          pool: string;

          constructor(pool: string) {
            super('bulkhead "' + pool + '" is full');
            this.name = 'BulkheadFullError';
            this.pool = pool;
          }
        }

        export interface BulkheadOptions {
          /** Concurrency ceiling for each pool */
          pools: Record<string, number>;
          /** Ceiling for unregistered pools; unlimited by default */
          defaultLimit?: number;
        }

        export interface Bulkhead {
          run<T>(pool: string, task: () => Promise<T>): Promise<T>;
          inFlight(pool: string): number;
          rejected(pool: string): number;
        }

        export function createBulkhead(options: BulkheadOptions): Bulkhead {
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
        import { createBulkhead, BulkheadFullError } from '../src/bulkhead';
        import { now, sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const POOLS = { pools: { slow: 2, fast: 4 } };

        describe('Stage 7 · Bulkhead isolation', () => {
          it('runs normally while the pool has room', async () => {
            const bulkhead = createBulkhead(POOLS);
            const value = await bulkhead.run('fast', async () => {
              await sleep(10);
              return 'ok';
            });
            expect(value).toBe('ok');
          });

          it('throws BulkheadFullError immediately when the pool is full', async () => {
            const bulkhead = createBulkhead(POOLS);
            const held = [
              bulkhead.run('slow', () => sleep(500)),
              bulkhead.run('slow', () => sleep(500)),
            ];
            await sleep(1);

            let error: unknown = null;
            try {
              await bulkhead.run('slow', () => sleep(10));
            } catch (caught) {
              error = caught;
            }
            expect(error).toBeInstanceOf(BulkheadFullError);
            expect(bulkhead.rejected('slow')).toBe(1);
            await Promise.all(held);
          });

          it('rejection is immediate and does not make the caller wait', async () => {
            const bulkhead = createBulkhead(POOLS);
            const held = [
              bulkhead.run('slow', () => sleep(500)),
              bulkhead.run('slow', () => sleep(500)),
            ];
            await sleep(1);

            const before = now();
            try {
              await bulkhead.run('slow', () => sleep(10));
            } catch (caught) {
              // Expected
            }
            expect(now() - before).toBe(0);
            await Promise.all(held);
          });

          it('releases the slot when the task finishes', async () => {
            const bulkhead = createBulkhead(POOLS);
            await bulkhead.run('slow', () => sleep(10));
            expect(bulkhead.inFlight('slow')).toBe(0);
            await bulkhead.run('slow', () => sleep(10));
            expect(bulkhead.inFlight('slow')).toBe(0);
          });

          it('releases the slot when the task throws too', async () => {
            const bulkhead = createBulkhead(POOLS);
            for (let index = 0; index < 5; index += 1) {
              try {
                await bulkhead.run('slow', async () => {
                  throw new Error('downstream exploded');
                });
              } catch (caught) {
                // Expected
              }
            }
            // The pool must still be usable after five failures
            expect(bulkhead.inFlight('slow')).toBe(0);
            expect(await bulkhead.run('slow', async () => 'still works')).toBe('still works');
          });

          it('inFlight reflects how many are in flight', async () => {
            const bulkhead = createBulkhead(POOLS);
            const held = bulkhead.run('slow', () => sleep(200));
            await sleep(1);
            expect(bulkhead.inFlight('slow')).toBe(1);
            await held;
            expect(bulkhead.inFlight('slow')).toBe(0);
          });

          it('an unregistered pool is unlimited by default', async () => {
            const bulkhead = createBulkhead(POOLS);
            const tasks: Array<Promise<unknown>> = [];
            for (let index = 0; index < 20; index += 1) tasks.push(bulkhead.run('other', () => sleep(10)));
            await Promise.all(tasks);
            expect(bulkhead.rejected('other')).toBe(0);
          });

          it('defaultLimit applies to unregistered pools', async () => {
            const bulkhead = createBulkhead({ pools: { slow: 2 }, defaultLimit: 1 });
            const held = bulkhead.run('other', () => sleep(200));
            await sleep(1);

            let rejected = false;
            try {
              await bulkhead.run('other', () => sleep(10));
            } catch (caught) {
              rejected = true;
            }
            expect(rejected).toBe(true);
            await held;
          });

          it('one pool filling up does not affect another [gate:isolation]', async () => {
            const bulkhead = createBulkhead(POOLS);

            // Two permanently slow requests fill the slow pool
            const stuck = [
              bulkhead.run('slow', () => sleep(5000)),
              bulkhead.run('slow', () => sleep(5000)),
            ];
            await sleep(1);
            expect(bulkhead.inFlight('slow')).toBe(2);

            // The fast pool must be entirely unaffected
            const startedAt = now();
            const results = await Promise.all([
              bulkhead.run('fast', async () => {
                await sleep(50);
                return 1;
              }),
              bulkhead.run('fast', async () => {
                await sleep(50);
                return 2;
              }),
            ]);
            const elapsed = now() - startedAt;
            count('fastPoolLatencyMs', elapsed);

            expect(results).toEqual([1, 2]);
            // An implementation sharing one pool would wait 5000ms here
            expect(elapsed).toBe(50);

            await Promise.all(stuck);
          });

          it('requests rejected by the slow pool do not consume the fast one', async () => {
            const bulkhead = createBulkhead(POOLS);
            const stuck = [
              bulkhead.run('slow', () => sleep(1000)),
              bulkhead.run('slow', () => sleep(1000)),
            ];
            await sleep(1);

            for (let index = 0; index < 10; index += 1) {
              try {
                await bulkhead.run('slow', () => sleep(10));
              } catch (caught) {
                // Expected
              }
            }
            expect(bulkhead.inFlight('fast')).toBe(0);
            expect(bulkhead.rejected('fast')).toBe(0);

            await Promise.all(stuck);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.fastPoolLatencyMs',
      op: 'lte',
      value: 60,
      unit: 'ms',
      zh: '一个池被慢下游占满，其他池不受影响',
      en: 'One pool saturated by a slow downstream leaves the others untouched',
      dimension: 'resilience',
      scope: 'gate:isolation',
    }),
  ],
  referenceFiles: [
    file(
      'src/bulkhead.ts',
      code`
        export class BulkheadFullError extends Error {
          pool: string;

          constructor(pool: string) {
            super('bulkhead "' + pool + '" is full');
            this.name = 'BulkheadFullError';
            this.pool = pool;
          }
        }

        export interface BulkheadOptions {
          pools: Record<string, number>;
          defaultLimit?: number;
        }

        export interface Bulkhead {
          run<T>(pool: string, task: () => Promise<T>): Promise<T>;
          inFlight(pool: string): number;
          rejected(pool: string): number;
        }

        export function createBulkhead(options: BulkheadOptions): Bulkhead {
          const running = new Map<string, number>();
          const refused = new Map<string, number>();

          function limitOf(pool: string): number {
            const configured = options.pools[pool];
            if (typeof configured === 'number') return configured;
            return options.defaultLimit ?? Infinity;
          }

          function get(map: Map<string, number>, pool: string): number {
            return map.has(pool) ? (map.get(pool) as number) : 0;
          }

          return {
            async run<T>(pool: string, task: () => Promise<T>): Promise<T> {
              if (get(running, pool) >= limitOf(pool)) {
                refused.set(pool, get(refused, pool) + 1);
                // Throw rather than queue: queuing turns the bound on how much a slow downstream
                // can take from you into no bound at all in the time dimension
                throw new BulkheadFullError(pool);
              }

              running.set(pool, get(running, pool) + 1);
              try {
                return await task();
              } finally {
                // finally rather than the success branch: not returning the slot when a task throws
                // drives this pool's usable concurrency to 0 after a handful of failures
                running.set(pool, Math.max(0, get(running, pool) - 1));
              }
            },

            inFlight(pool: string): number {
              return get(running, pool);
            },

            rejected(pool: string): number {
              return get(refused, pool);
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**整个实现只有一个 `try/finally`。** 舱壁在概念上很重要，实现上极其简单——',
      '这正是它相对于线程池隔离的优势：几乎零开销，可以给每一个下游都配一个，',
      '而不用担心「二十个线程池」带来的内存和调度成本。',
      '',
      '**拒绝路径上没有 `await`。** `throw` 之前一行异步代码都没有，',
      '所以 `now()` 在调用前后完全相同。这不只是性能问题：',
      '一个「等一下再告诉你满了」的舱壁，会让调用方的超时预算被白白消耗掉，',
      '而它本来可以立刻降级或者换一条路。',
      '',
      '**`limitOf` 区分「配置成 Infinity」和「没配置」。** 用 `options.pools[pool] || Infinity`',
      '会把配置成 0 的池（意思是「完全禁用这个下游」）也变成不限——',
      '一个用来做紧急开关的配置项，因为一个 `||` 而失效。',
      '',
      '**这一关刻意不排队。** 和第 9 关的背压看起来很像，但那是另一层的职责：',
      '背压决定「要不要接这个请求」，舱壁决定「这个请求能占用多少资源」。',
      '两者叠加使用时，顺序是先背压后舱壁——先决定收不收，再决定给多少。',
    ].join('\n'),
    [
      'The whole implementation is one `try/finally`. Bulkheads matter conceptually and are trivial to',
      'build, which is exactly their advantage over thread-pool isolation: nearly free, so every downstream',
      'can have one without worrying about the memory and scheduling cost of twenty thread pools.',
      '',
      'There is no `await` on the rejection path. Not a line of asynchronous code precedes the `throw`, so',
      "`now()` is identical either side of the call. This is not only performance: a bulkhead that makes",
      "you wait before saying it is full burns the caller's timeout budget when it could have degraded or",
      'rerouted immediately.',
      '',
      '`limitOf` distinguishes "configured as Infinity" from "not configured". Writing',
      '`options.pools[pool] || Infinity` turns a pool configured as 0 — meaning "disable this downstream',
      'entirely" — into unlimited, so a configuration item intended as an emergency switch is defeated by',
      'one `||`.',
      '',
      'This stage deliberately does not queue. It resembles backpressure, and that belongs to another',
      'layer: backpressure decides whether to accept a request, a bulkhead decides how much of the system',
      'it may occupy. Used together the order is backpressure first, bulkhead second — decide whether to',
      'take it, then decide how much to give it.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage8 = {
  id: 'retry-budget',
  title: t('第 8 关 · 重试预算与放大', 'Stage 8 · Retry budgets and amplification'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '重试是所有容错手段里最容易被滥用的一个，因为它在**单个请求**的视角下永远是对的：',
      '失败了再试一次，成功率就是上去了。',
      '',
      '问题出在系统视角。下游整体故障时，所有客户端同时开始重试，每个都重试 3 次 ——',
      '下游收到的流量瞬间变成 4 倍。一个本来能自愈的抖动，被重试放大成了雪崩。',
      '而且这是个正反馈：下游越慢，超时越多，重试越多，下游越慢。',
      '',
      '## 要实现什么',
      '',
      '在 `src/retryBudget.ts` 实现 `createRetryBudget(options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `recordRequest()` | 每来一个**原始**请求记一笔 |',
      '| `canRetry()` | 现在还能不能再重试 |',
      '| `recordRetry()` | 记一次重试 |',
      '| `usedRatio()` | 当前窗口里重试占原始请求的比例 |',
      '',
      '规则：一个窗口内允许的重试数 = `max(minPerWindow, floor(请求数 × ratio))`。',
      '',
      '## 怎么算过',
      '',
      '- 预算按窗口滚动，窗口一换 `requests` 和 `retries` 一起清零；',
      '- 低流量时 `minPerWindow` 兜底，仍然允许少量重试；',
      '- 100 个请求全部失败、`ratio = 0.1` 时，总重试次数不超过 13',
      '  （门槛 `counters.retriesUsed ≤ 13`；没有预算的实现在这里是 100）。',
      '',
      '## 两个必须想清楚的细节',
      '',
      '**`minPerWindow` 那一项不能省。** 没有它，流量很低时（比如每秒 2 个请求）',
      '`2 × 0.1 = 0.2`，向下取整是 0 —— 一次重试都不允许。',
      '而每秒两个请求恰恰是重试最安全、最该发生的时候：这点量放大四倍也压不垮谁。',
      '',
      '**分母只算原始请求。** 把重试也计入 `requests`，分母就开始自我供养：',
      '重试越多，允许的重试越多，预算等于没有 —— 而这个失效恰好发生在故障期间，',
      '也就是唯一需要它的时候。',
    ].join('\n'),
    [
      'Retrying is the most easily abused of all fault-tolerance techniques, because from the perspective of',
      'a **single request** it is always right: it failed, try again, success rate goes up.',
      '',
      'The problem is the system view. When a downstream fails broadly, every client starts retrying at once,',
      'three times each, and the traffic it receives instantly quadruples. A blip that would have healed',
      'itself is amplified into a collapse. And it is positive feedback: the slower the downstream, the more',
      'timeouts, the more retries, the slower the downstream.',
      '',
      '## What to build',
      '',
      '`createRetryBudget(options)` in `src/retryBudget.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `recordRequest()` | One entry per **original** request |',
      '| `canRetry()` | Whether another retry is permitted right now |',
      '| `recordRetry()` | Record one retry |',
      '| `usedRatio()` | Retries as a fraction of original requests this window |',
      '',
      'The rule: retries allowed per window = `max(minPerWindow, floor(requests × ratio))`.',
      '',
      '## What counts as passing',
      '',
      '- The budget rolls per window, clearing `requests` and `retries` together;',
      '- `minPerWindow` keeps a small allowance alive under low traffic;',
      '- With a hundred requests all failing and `ratio = 0.1`, total retries stay at or below thirteen',
      '  (`counters.retriesUsed ≤ 13`; without a budget it is a hundred).',
      '',
      '## Two details worth thinking through',
      '',
      '**The `minPerWindow` term cannot be dropped.** Without it, low traffic — say two requests per second —',
      'gives `2 × 0.1 = 0.2`, which floors to zero, permitting no retries at all. And two requests per second',
      'is precisely when retrying is safest and most warranted: quadrupling that volume crushes nobody.',
      '',
      '**The denominator counts original requests only.** Fold retries into `requests` and the denominator',
      'feeds itself: more retries permit more retries, and the budget stops existing — a failure that arrives',
      'during an outage, the one moment it was needed.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**共同的第一步** —— 四个方法都先 `roll()`',
      '',
      '```mermaid',
      'flowchart TD',
      '  RQ["recordRequest()"] --> ROLL',
      '  CR["canRetry()"] --> ROLL',
      '  RR["recordRetry()"] --> ROLL',
      '  UR["usedRatio()"] --> ROLL["roll()<br/>id = floor(now / windowMs)<br/>id 变了就把 requests 和 retries 一起清零"]',
      '```',
      '',
      '窗口滚动因此只有一份实现，也不需要任何定时器 ——',
      '和第 1 关固定窗口用的是同一个技巧。全部状态只有三个数字：',
      '`windowId`、`requests`、`retries`。',
      '',
      '**canRetry 的判断** —— 这一关真正有内容的那条路径',
      '',
      '```mermaid',
      'flowchart TD',
      '  A4["allowance()<br/>max(minPerWindow, floor(requests × ratio))"] --> CMP{"retries < allowance？"}',
      '  CMP -- 是 --> YES["true —— 还有预算"]',
      '  CMP -- 否 --> NO["false —— 这个窗口的重试额度用完了"]',
      '```',
      '',
      '另外三个方法各只有一行：`recordRequest` 让 `requests += 1`（**只记原始请求**），',
      '`recordRetry` 让 `retries += 1`，`usedRatio` 返回 `retries / requests`。',
      '',
      '`allowance()` 是唯一读到 `ratio` 和 `minPerWindow` 的地方；',
      '把 `recordRequest` 改成「重试也 += 1」，分母就会随重试一起涨，整个预算失效 ——',
      '而这个失效恰好发生在故障期间，也就是唯一需要它的时候。',
    ].join('\n'),
    [
      '**The shared first step** — all four methods call `roll()` first',
      '',
      '```mermaid',
      'flowchart TD',
      '  RQ["recordRequest()"] --> ROLL',
      '  CR["canRetry()"] --> ROLL',
      '  RR["recordRetry()"] --> ROLL',
      '  UR["usedRatio()"] --> ROLL["roll()<br/>id = floor(now / windowMs)<br/>a new id clears requests and retries together"]',
      '```',
      '',
      'Window rolling therefore has exactly one implementation and needs no timer — the same trick as the',
      'fixed window in stage 1. All the state is three numbers: `windowId`, `requests`, `retries`.',
      '',
      '**The canRetry decision** — the one path with real content',
      '',
      '```mermaid',
      'flowchart TD',
      '  A4["allowance()<br/>max(minPerWindow, floor(requests × ratio))"] --> CMP{"retries < allowance?"}',
      '  CMP -- yes --> YES["true — budget remains"]',
      '  CMP -- no --> NO["false — this window\'s retry budget is spent"]',
      '```',
      '',
      'The other three methods are one line each: `recordRequest` does `requests += 1` (**original requests',
      'only**), `recordRetry` does `retries += 1`, and `usedRatio` returns `retries / requests`.',
      '',
      '`allowance()` is the only place that reads `ratio` and `minPerWindow`; change `recordRequest` to also',
      'count retries and the denominator grows with them, dissolving the budget — a failure that arrives',
      'during an outage, the one moment it was needed.',
    ].join('\n')
  ),
  checklist: [
    t('重试数受请求数的比例约束', 'Retries are bounded by a fraction of requests'),
    t('低流量时仍然允许最少几次重试', 'Low traffic still permits a minimum number of retries'),
    t('窗口滚动后预算重置', 'The budget resets when the window rolls'),
    t('usedRatio 反映当前占比', 'usedRatio reflects the current fraction'),
    t('预算用完后 canRetry 返回 false', 'canRetry returns false once the budget is spent'),
  ],
  pitfalls: [
    t(
      '省掉 `minPerWindow`。比例算下来不足 1 次时向下取整成 0，于是低流量场景完全不能重试——而低流量恰恰是重试最安全的时候（放大 3 倍也只有 6 个请求）。真实的重试预算都有这一项，gRPC 的默认配置里叫 `minTokens`。',
      'Dropping `minPerWindow`. When the fraction computes to less than one it floors to zero and low-traffic scenarios cannot retry at all — yet low traffic is when retrying is safest, since tripling six requests is still six requests. Real retry budgets all have this term; gRPC calls it `minTokens`.'
    ),
    t(
      '把重试也计入 `recordRequest`。预算的分母于是包含了重试本身，形成自我供养：重试越多，允许的重试越多。正确的分母只能是「原始请求数」，重试必须走单独的计数器。',
      'Counting retries in `recordRequest`. The denominator then includes the retries themselves and becomes self-feeding: more retries permit more retries. The denominator must be original requests only, with retries on a separate counter.'
    ),
    t(
      '预算按「全局」而不是「按下游」维护。一个下游故障会把整个网关的重试预算吃光，于是其他健康下游的偶发失败也失去了重试机会——一个依赖的问题又一次传染给了全部。预算应该和舱壁一样按下游隔离。',
      'Keeping one global budget instead of one per downstream. A single failing dependency consumes the whole gateway\'s retry allowance, so occasional failures against healthy downstreams lose their retries too — one dependency\'s problem spreading to all of them again. Budgets should be isolated per downstream, like bulkheads.'
    ),
    t(
      '窗口滚动时把计数清零，而不是滑动。和第 1 关是同一个问题：窗口边界上预算会突然全额恢复，于是重试呈现出「每秒开头一波、然后没有」的锯齿形——而下游感受到的正是这种周期性冲击。用上一关学过的滑动计数会平滑得多。',
      'Resetting counts on a window boundary rather than sliding. Same problem as stage 1: the budget is restored in full at the boundary, so retries come in a sawtooth of a burst at each second followed by nothing — and a periodic hammering is exactly what the downstream feels. The sliding counter from earlier smooths it considerably.'
    ),
  ],
  hints: [
    t(
      '两个计数器加一个窗口编号就够了：`requests` 和 `retries`，窗口变了都清零。',
      'Two counters and a window id suffice: `requests` and `retries`, both reset when the window changes.'
    ),
    t(
      '`canRetry()` 是 `retries < Math.max(minPerWindow, Math.floor(requests * ratio))`。注意用 `<` 不是 `<=`。',
      '`canRetry()` is `retries < Math.max(minPerWindow, Math.floor(requests * ratio))`. Note `<`, not `<=`.'
    ),
  ],
  extension: t(
    [
      '重试预算是 gRPC 和 Envoy 都内置的机制。gRPC 的配置里叫 `retryThrottling`，',
      '用的是令牌桶：每次成功加 `tokenRatio` 个令牌，每次重试扣 1 个，',
      '令牌不足就不许重试。和这一关的比例窗口等价，但对流量变化的反应更平滑。',
      '',
      '重试放大之外，还有一个更隐蔽的放大源：**层数**。',
      '一个请求穿过 4 层服务，每层各自重试 3 次，最底层收到的是 3⁴ = 81 倍流量。',
      '所以真实系统的一条硬规则是：**只在最外层重试**，或者让重试次数随层数递减。',
      'Google SRE 那本书里管这个叫「重试预算要跨层共享」——',
      '通过在请求头里传递「已经重试过几次」来实现。',
      '',
      '另一个方向是**让重试更聪明而不是更少**。',
      '对冲请求（第一个项目第 6 关）本质上是一种「提前的重试」，',
      '而它只在 p99 触发，天然就有比例约束。',
      '还有 backoff with jitter：即使重试次数不变，把时刻打散也能显著降低瞬时峰值——',
      'AWS 那篇《Exponential Backoff And Jitter》给了完整的对比数据。',
      '',
      '最后一个视角：重试预算本质上是在**用成功率换稳定性**。',
      '预算耗尽时，那些本可以通过重试成功的请求失败了。',
      '这个取舍只在「下游整体故障」时才划算——所以更好的做法是把预算和熔断器联动：',
      '熔断器判断下游整体状态，预算只在「不确定」的灰色地带发挥作用。',
    ].join('\n'),
    [
      'Retry budgets are built into both gRPC and Envoy. gRPC calls the configuration `retryThrottling` and',
      'implements it as a token bucket: each success adds `tokenRatio` tokens, each retry spends one, and',
      'no tokens means no retry. Equivalent to the ratio window here, with smoother response to changing',
      'traffic.',
      '',
      'Beyond retry amplification there is a subtler source: depth. A request crossing four services that',
      'each retry three times delivers 3⁴ = 81 times the traffic to the bottom one. Hence the hard rule in',
      'real systems: retry only at the outermost layer, or decay the retry count with depth. The Google SRE',
      'book calls this sharing the retry budget across layers, implemented by passing "how many times this',
      'has already been retried" in a request header.',
      '',
      'The other direction is making retries smarter rather than fewer. Hedging (stage 6 of the first',
      'project) is essentially an early retry, and because it only fires at p99 it is inherently',
      'rate-limited. Backoff with jitter is another: even at the same retry count, spreading the instants',
      "apart cuts the instantaneous peak substantially — AWS's \"Exponential Backoff And Jitter\" post has",
      'the comparison data.',
      '',
      'A last perspective: a retry budget trades success rate for stability. When the budget is spent,',
      'requests that a retry would have rescued fail instead. That trade only pays during a broad',
      'downstream failure, so the better design couples the budget to the circuit breaker — the breaker',
      'judges overall health, and the budget governs only the uncertain grey zone.',
    ].join('\n')
  ),
  focus: ['resilience', 'correctness', 'latency'],
  lab: {},
  starterFiles: [
    file(
      'src/retryBudget.ts',
      code`
        export interface RetryBudgetOptions {
          /** Ceiling on retries as a fraction of normal requests */
          ratio: number;
          /** Minimum retries allowed per window, as a floor for low traffic */
          minPerWindow?: number;
          windowMs: number;
        }

        export interface RetryBudget {
          /** Record one original request (retries excluded) */
          recordRequest(): void;
          canRetry(): boolean;
          recordRetry(): void;
          /** The current window's ratio of retries to requests */
          usedRatio(): number;
        }

        export function createRetryBudget(options: RetryBudgetOptions): RetryBudget {
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
        import { createRetryBudget } from '../src/retryBudget';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const OPTIONS = { ratio: 0.1, minPerWindow: 3, windowMs: 1000 };

        describe('Stage 8 · Retry budget', () => {
          it('minPerWindow provides the floor at low traffic', () => {
            const budget = createRetryBudget(OPTIONS);
            budget.recordRequest();
            budget.recordRequest();

            // 2 × 0.1 floors to 0, but minPerWindow is 3
            let allowed = 0;
            for (let index = 0; index < 10; index += 1) {
              if (budget.canRetry()) {
                budget.recordRetry();
                allowed += 1;
              }
            }
            expect(allowed).toBe(3);
          });

          it('scales proportionally at high traffic', () => {
            const budget = createRetryBudget(OPTIONS);
            for (let index = 0; index < 200; index += 1) budget.recordRequest();

            let allowed = 0;
            for (let index = 0; index < 100; index += 1) {
              if (budget.canRetry()) {
                budget.recordRetry();
                allowed += 1;
              }
            }
            expect(allowed).toBe(20);
          });

          it('canRetry returns false once the budget is spent', () => {
            const budget = createRetryBudget(OPTIONS);
            for (let index = 0; index < 100; index += 1) budget.recordRequest();
            for (let index = 0; index < 10; index += 1) budget.recordRetry();
            expect(budget.canRetry()).toBe(false);
          });

          it('retries do not count towards the denominator', () => {
            const budget = createRetryBudget({ ratio: 0.5, minPerWindow: 0, windowMs: 1000 });
            for (let index = 0; index < 10; index += 1) budget.recordRequest();

            let allowed = 0;
            for (let index = 0; index < 50; index += 1) {
              if (budget.canRetry()) {
                budget.recordRetry();
                allowed += 1;
              }
            }
            // An implementation counting retries in the denominator feeds itself and goes well past 5
            expect(allowed).toBe(5);
          });

          it('usedRatio reflects the current share', () => {
            const budget = createRetryBudget(OPTIONS);
            for (let index = 0; index < 100; index += 1) budget.recordRequest();
            for (let index = 0; index < 5; index += 1) budget.recordRetry();
            expect(budget.usedRatio()).toBeCloseTo(0.05, 4);
          });

          it('usedRatio is 0 when there are no requests', () => {
            expect(createRetryBudget(OPTIONS).usedRatio()).toBe(0);
          });

          it('the budget resets once the window rolls over', async () => {
            const budget = createRetryBudget(OPTIONS);
            for (let index = 0; index < 100; index += 1) budget.recordRequest();
            for (let index = 0; index < 10; index += 1) budget.recordRetry();
            expect(budget.canRetry()).toBe(false);

            await sleep(1100);
            budget.recordRequest();
            expect(budget.canRetry()).toBe(true);
          });

          it('a minPerWindow of 0 makes it purely proportional', () => {
            const budget = createRetryBudget({ ratio: 0.1, minPerWindow: 0, windowMs: 1000 });
            budget.recordRequest();
            budget.recordRequest();
            expect(budget.canRetry()).toBe(false);
          });

          it('retries stay inside the budget when downstream is entirely down [gate:amplification]', () => {
            const budget = createRetryBudget(OPTIONS);
            let retries = 0;

            // All 100 requests fail and every one of them wants a retry
            for (let index = 0; index < 100; index += 1) {
              budget.recordRequest();
              if (budget.canRetry()) {
                budget.recordRetry();
                retries += 1;
              }
            }

            count('retriesUsed', retries);
            // An implementation without a budget reports 100 here, doubling the traffic downstream sees
            expect(retries).toBeLessThanOrEqual(13);
          });

          it('occasional failures while healthy can still be retried', () => {
            const budget = createRetryBudget(OPTIONS);
            let retries = 0;
            // 100 requests, only 3 of which fail
            for (let index = 0; index < 100; index += 1) {
              budget.recordRequest();
              if (index % 33 === 0 && budget.canRetry()) {
                budget.recordRetry();
                retries += 1;
              }
            }
            // The budget should not block retries in the normal case
            expect(retries).toBe(4);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.retriesUsed',
      op: 'lte',
      value: 13,
      zh: '下游全挂时重试不会把流量放大一倍',
      en: 'A total downstream failure does not double the traffic through retries',
      dimension: 'resilience',
      scope: 'gate:amplification',
    }),
  ],
  referenceFiles: [
    file(
      'src/retryBudget.ts',
      code`
        import { now } from '@lab/env';

        export interface RetryBudgetOptions {
          ratio: number;
          minPerWindow?: number;
          windowMs: number;
        }

        export interface RetryBudget {
          recordRequest(): void;
          canRetry(): boolean;
          recordRetry(): void;
          usedRatio(): number;
        }

        export function createRetryBudget(options: RetryBudgetOptions): RetryBudget {
          const minPerWindow = options.minPerWindow ?? 0;
          let windowId = -1;
          let requests = 0;
          let retries = 0;

          function roll(): void {
            const current = Math.floor(now() / options.windowMs);
            if (current === windowId) return;
            windowId = current;
            requests = 0;
            retries = 0;
          }

          function allowance(): number {
            // The minPerWindow term is the floor for low traffic: 2 × 0.1 floors to 0,
            // and two requests a second is precisely when retrying is safest
            return Math.max(minPerWindow, Math.floor(requests * options.ratio));
          }

          return {
            recordRequest(): void {
              roll();
              // Count original requests only. Counting retries too makes the denominator feed itself:
              // the more you retry, the more retries you are allowed
              requests += 1;
            },

            canRetry(): boolean {
              roll();
              return retries < allowance();
            },

            recordRetry(): void {
              roll();
              retries += 1;
            },

            usedRatio(): number {
              roll();
              return requests === 0 ? 0 : retries / requests;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`roll()` 在每个公开方法的开头都调用一次。** 少了任何一处，都会出现',
      '「窗口已经过去了但计数还是上一个窗口的」这种状态。',
      '把它写成一个私有函数并在每个入口调用，比试图在某个统一的地方处理更可靠——',
      '因为这个对象没有「统一的入口」，四个方法都可能是第一个被调用的。',
      '',
      '**`canRetry` 用 `<` 而不是 `<=`。** allowance 是「允许的总次数」，',
      '已用 `retries` 次时还能再用当且仅当 `retries < allowance`。',
      '写成 `<=` 会多放一次——在 ratio 很小的场景里，这个 off-by-one 就是 50% 的误差。',
      '',
      '**`allowance()` 每次重新计算而不是缓存。** 请求数在窗口内持续增长，',
      '预算也应该跟着涨：一个窗口里先来 10 个请求、后来 190 个，',
      '如果预算在第 10 个请求时就固定成 1，后面 190 个请求就共享这 1 次重试机会。',
      '',
      '**这个预算是「按实例」的。** 真实系统里多个网关实例各有各的预算，',
      '合起来的放大倍数是单实例的 N 倍。要做全局预算就得引入第 4 关的租约机制——',
      '而绝大多数系统选择不做，因为按实例的预算已经把放大从「无限」压到了「1.1 倍」，',
      '再精确的收益很小。',
    ].join('\n'),
    [
      '`roll()` is called at the top of every public method. Missing it anywhere produces a state where the',
      'window has passed but the counts belong to the previous one. Writing it as a private function called',
      'from each entry point is more reliable than trying to handle it in one central place, because this',
      'object has no central entry point — any of the four methods may be called first.',
      '',
      '`canRetry` uses `<`, not `<=`. The allowance is a total, and with `retries` already spent another is',
      'permitted exactly when `retries < allowance`. Using `<=` grants one extra, and at small ratios that',
      'off-by-one is a 50% error.',
      '',
      '`allowance()` is recomputed rather than cached. Request count keeps growing within the window and',
      'the budget should grow with it: if ten requests arrive and then a hundred and ninety, freezing the',
      'allowance at one after the tenth leaves the remaining hundred and ninety sharing that single retry.',
      '',
      'This budget is per instance. In a real system several gateway instances each hold their own, so the',
      'combined amplification is N times a single one. A global budget would need the leasing mechanism',
      'from stage 4 — and most systems decline, because a per-instance budget has already brought',
      'amplification from unbounded down to about 1.1x and further precision buys little.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage9 = {
  id: 'gateway',
  title: t('第 9 关 · 超时预算与组合', 'Stage 9 · Timeout budget and composition'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前面八关造了一堆零件。这一关把其中三层组合成真正的网关，',
      '而组合的**顺序**本身就是这一关要考的东西。',
      '',
      '顺序是：限流 → 熔断 → 超时 → 下游。',
      '',
      '## 要实现什么',
      '',
      '**`src/timeout.ts`**：`withTimeout(task, ms)`，超时抛 `TimeoutError`。',
      '用 `Promise.race` 让任务和定时器赛跑，并且**在 `finally` 里 `clearTimeout`** ——',
      '不清的话，每个快速返回的请求都会留下一个还要等满 `ms` 才触发的定时器。',
      '',
      '**`src/gateway.ts`**：`createGateway(options)`，暴露 `call(url)` 和 `stats()`。',
      '',
      '| 约定 | 说明 |',
      '| --- | --- |',
      '| `call` 永不抛异常 | 统一返回 `GatewayResult` |',
      '| `reason` 三选一 | `timeout` / `circuit-open` / `upstream` |',
      '| 超时计入熔断失败 | 一个一直超时的依赖同样需要被熔断 |',
      '',
      '## 怎么算过',
      '',
      '- 超时预算严格生效，慢下游不会拖着调用方一起等（门槛 `virtualElapsedMs ≤ 200`）；',
      '- 熔断开路后下游零打扰（门槛 `requests.total ≤ 3`）；',
      '- 限流只是等待，不引入额外浪费（门槛 `virtualElapsedMs ≤ 460`）；',
      '- 三种失败各自映射到正确的 `reason` 和 `stats` 计数。',
      '',
      '## 顺序错了，保护就失效',
      '',
      '**熔断放在限流之前**：被限流挡下的请求会白白占用熔断配额 ——',
      '下游明明没收到这些请求，熔断器却记了一笔失败。',
      '',
      '**超时放在熔断之外**：熔断器只看得到「抛异常」的失败，',
      '看不到「慢」这种失败。而生产环境里最常见的故障形态恰恰是变慢而不是报错，',
      '熔断器就永远不会开路。',
      '',
      '所以正确的嵌套是 `bucket.acquire()` 在最外，`breaker.exec(() => withTimeout(...))` 在里 ——',
      '超时被熔断器包住，它抛出的 `TimeoutError` 自然被算作一次失败。',
    ].join('\n'),
    [
      'The previous eight stages built a pile of parts. This one composes three of those layers into an',
      'actual gateway, and the **order** of composition is what the stage is really about.',
      '',
      'The order is: rate limit → breaker → timeout → downstream.',
      '',
      '## What to build',
      '',
      '**`src/timeout.ts`**: `withTimeout(task, ms)`, throwing `TimeoutError`. Race the task against a timer',
      'with `Promise.race`, and **`clearTimeout` in a `finally`** — without it, every fast request leaves',
      'behind a timer that still has to burn its full `ms`.',
      '',
      '**`src/gateway.ts`**: `createGateway(options)`, exposing `call(url)` and `stats()`.',
      '',
      '| Contract | Detail |',
      '| --- | --- |',
      '| `call` never throws | It always returns a `GatewayResult` |',
      '| `reason` is one of three | `timeout` / `circuit-open` / `upstream` |',
      '| Timeouts count as breaker failures | A permanently slow dependency deserves tripping too |',
      '',
      '## What counts as passing',
      '',
      '- The timeout budget holds, so a slow downstream never drags the caller along (`virtualElapsedMs ≤ 200`);',
      '- Once the breaker opens, the downstream is untouched (`requests.total ≤ 3`);',
      '- Rate limiting only waits, adding no waste of its own (`virtualElapsedMs ≤ 460`);',
      '- Each failure kind maps to the right `reason` and `stats` counter.',
      '',
      '## Get the order wrong and the protection stops working',
      '',
      '**Breaker before limiter**: throttled requests waste breaker budget — the downstream never received',
      'them, yet the breaker recorded a failure.',
      '',
      '**Timeout outside the breaker**: the breaker then sees only failures that throw, never failures that',
      'are merely slow. Since production failures far more often look like slowness than like errors, the',
      'breaker would never open at all.',
      '',
      'So the correct nesting is `bucket.acquire()` outermost and `breaker.exec(() => withTimeout(...))`',
      'inside — the timeout sits within the breaker, so the `TimeoutError` it throws naturally counts as a',
      'failure.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  CALL["call(url)"] --> RL["await bucket.acquire()<br/>限流在最外层：被限流的请求<br/>还没进熔断器，不占它的配额"]',
      '  RL --> BE["breaker.exec(...)"]',
      '  BE --> OPENQ{"熔断器是开的吗？"}',
      '  OPENQ -- 是 --> COE["抛 CircuitOpenError<br/>下游一次都不碰"]',
      '  OPENQ -- 否 --> WT["withTimeout(() => request(url), timeoutMs)<br/>超时在熔断器里面 —— 这是关键"]',
      '  WT --> RACE["Promise.race([下游调用, 定时器])<br/>finally 里 clearTimeout"]',
      '  RACE --> WIN{"谁先到？"}',
      '  WIN -- 下游先返回 --> OK["stats.ok += 1<br/>返回 { ok: true, data }"]',
      '  WIN -- 定时器先到 --> TO["抛 TimeoutError<br/>被熔断器算作一次失败"]',
      '  WIN -- 下游报错 --> ERR["原始错误<br/>同样算一次失败"]',
      '',
      '  COE --> CATCH',
      '  TO --> CATCH',
      '  ERR --> CATCH["call 的 catch：按错误类型分流<br/>call 本身永不抛"]',
      '  CATCH --> R1["CircuitOpenError → rejected<br/>reason: circuit-open"]',
      '  CATCH --> R2["TimeoutError → timedOut<br/>reason: timeout"]',
      '  CATCH --> R3["其他 → failed<br/>reason: upstream"]',
      '```',
      '',
      '要点：图从上到下的层次就是保护的顺序，每一层都只处理自己那件事。',
      '`WT` 在 `BE` 里面这一点是全图最关键的位置关系 —— 它决定了 `TO` 那条边会不会流回熔断器的失败计数。',
      '把 `WT` 挪到 `BE` 外面，图看起来差不多，但熔断器从此对「慢」完全失明。',
      '',
      '`CATCH` 是唯一的出口收敛点：三种失败在这里各自变成一个 `reason`，',
      '调用方拿到的永远是值，不是异常。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  CALL["call(url)"] --> RL["await bucket.acquire()<br/>the limiter is outermost: a throttled request<br/>never enters the breaker, so it spends none of its budget"]',
      '  RL --> BE["breaker.exec(...)"]',
      '  BE --> OPENQ{"is the breaker open?"}',
      '  OPENQ -- yes --> COE["throw CircuitOpenError<br/>the downstream is never touched"]',
      '  OPENQ -- no --> WT["withTimeout(() => request(url), timeoutMs)<br/>the timeout sits INSIDE the breaker"]',
      '  WT --> RACE["Promise.race([downstream call, timer])<br/>clearTimeout in a finally"]',
      '  RACE --> WIN{"which finished first?"}',
      '  WIN -- "downstream returned" --> OK["stats.ok += 1<br/>return { ok: true, data }"]',
      '  WIN -- "timer fired" --> TO["throw TimeoutError<br/>the breaker counts it as a failure"]',
      '  WIN -- "downstream errored" --> ERR["the original error<br/>also counted as a failure"]',
      '',
      '  COE --> CATCH',
      '  TO --> CATCH',
      '  ERR --> CATCH["call\'s catch: route by error type<br/>call itself never throws"]',
      '  CATCH --> R1["CircuitOpenError → rejected<br/>reason: circuit-open"]',
      '  CATCH --> R2["TimeoutError → timedOut<br/>reason: timeout"]',
      '  CATCH --> R3["anything else → failed<br/>reason: upstream"]',
      '```',
      '',
      'The point: the diagram\'s top-to-bottom layering is the protection order, and each layer handles only',
      'its own concern. `WT` sitting inside `BE` is the most important positional fact on the page — it',
      'decides whether the `TO` edge flows back into the breaker\'s failure count. Move `WT` outside `BE` and',
      'the picture barely changes, but the breaker goes permanently blind to slowness.',
      '',
      '`CATCH` is the single convergence point: three kinds of failure each become a `reason` there, and the',
      'caller always receives a value rather than an exception.',
    ].join('\n')
  ),
  checklist: [
    t('超时返回 reason=timeout 而不是抛异常', 'Timeouts return reason=timeout instead of throwing'),
    t('超时计入熔断失败', 'Timeouts count as breaker failures'),
    t('熔断打开时 reason=circuit-open 且不打下游', 'While open, reason=circuit-open and downstream is untouched'),
    t('stats() 如实反映四类结果', 'stats() reflects all four outcomes'),
  ],
  pitfalls: [
    t(
      '把 `withTimeout` 放在 `breaker.exec` 外面：超时就发生在熔断器的视野之外，一个「只慢不错」的下游永远不会触发熔断，你的连接池会被慢慢耗光。',
      'Putting `withTimeout` *outside* `breaker.exec` hides timeouts from the breaker, so a dependency that hangs instead of erroring never trips it, and your connection pool drains.'
    ),
    t(
      '把限流放在熔断里面：被限流挡下来的请求会占用熔断器的配额甚至被记为失败，两个保护机制互相打架。限流应该在最外层。',
      'Putting the limiter *inside* the breaker lets throttled requests consume breaker budget or count as failures. The limiter belongs outermost.'
    ),
    t(
      '`withTimeout` 里忘了 `clearTimeout`，每个请求都会留下一个不会触发的定时器。高 QPS 下这就是持续的内存泄漏。',
      'Forget `clearTimeout` in `withTimeout` and every request leaves behind a timer that never fires. At high QPS that is a steady leak.'
    ),
    t(
      '让 `call` 把异常抛出去：网关的调用方通常是 HTTP 处理器，它需要的是「用什么状态码回复」，而不是一个异常。把失败翻译成结构化结果。',
      'Letting `call` throw pushes the problem to an HTTP handler that needs a status code, not an exception. Translate failure into a structured result.'
    ),
    t(
      '超时后以为下游就停了：`Promise.race` 只是不再等它，那个请求仍然在跑、仍然占着下游的连接。真实系统里需要把取消信号也传下去。',
      'Assuming a timeout stops the downstream: `Promise.race` merely stops waiting. The request is still running and still holding a connection. Real systems must propagate cancellation too.'
    ),
  ],
  hints: [
    t(
      'withTimeout 用 Promise.race 加一个 setTimeout（沙箱里的 setTimeout 已经接到虚拟时钟上）。',
      'Build withTimeout from Promise.race plus setTimeout, the sandbox setTimeout is already wired to the virtual clock.'
    ),
    t(
      '把 CircuitOpenError 和 TimeoutError 分开 catch，才能给出准确的 reason。',
      'Catch CircuitOpenError and TimeoutError separately to report an accurate reason.'
    ),
  ],
  extension: t(
    [
      '### 超时预算与调用链',
      '',
      '单个超时值容易设，难的是**整条链路**的预算分配。假设网关的 SLA 是 1s：',
      '',
      '```',
      '客户端 1000ms',
      '  └─ 网关 900ms（留 100ms 给自己的处理）',
      '       ├─ 服务 A 400ms',
      '       └─ 服务 B 400ms',
      '```',
      '',
      '常见错误是每一层都写死一个「看起来合理」的值（比如都是 3s），',
      '结果最外层早就超时返回了，内层还在傻等，白白占着资源。',
      'gRPC 的 deadline 和 Go 的 `context.WithTimeout` 之所以是沿调用链传递剩余时间，',
      '就是为了解决这个问题：每一层拿到的是「还剩多久」，而不是一个固定值。',
      '',
      '### 超时之后下游还在跑',
      '',
      '这一点很容易被忽略：`Promise.race` 超时后，那个请求**并没有被取消**，',
      '它仍然占着下游的连接和 CPU。如果你一边超时重试、一边下游还在处理旧请求，',
      '实际压力会成倍增长。所以真实的超时实现要配合取消信号',
      '（`AbortController`、`context.Context`）一起用。',
      '',
      '### 三层保护的组合顺序',
      '',
      '```',
      '限流（最外）→ 熔断 → 超时 → 下游',
      '```',
      '',
      '- 限流在最外：被挡下的请求不该消耗熔断配额，也不该占用超时预算；',
      '- 超时在熔断内：这样「慢」才会被熔断器记为失败；',
      '- 如果还有重试，它应该在**熔断之外**，否则重试会加速熔断器打开。',
      '',
      '### 还差什么',
      '',
      '真实网关还会有：舱壁隔离（bulkhead，给每个下游独立的连接池/信号量，',
      '防止一个慢下游耗尽全局资源）、负载脱落（load shedding，过载时主动丢弃低优先级请求）、',
      '以及优雅降级（返回缓存或默认值而不是错误）。',
    ].join('\n'),
    [
      '### Timeout budgets across a call chain',
      '',
      'Setting one timeout is easy; allocating a budget across the whole chain is not.',
      'Say the gateway SLA is 1s:',
      '',
      '```',
      'client 1000ms',
      '  └─ gateway 900ms (100ms reserved for itself)',
      '       ├─ service A 400ms',
      '       └─ service B 400ms',
      '```',
      '',
      'The common mistake is hard-coding a "reasonable" value at every layer (say 3s everywhere), so',
      'the outermost layer already gave up while inner layers keep waiting and holding resources.',
      "gRPC deadlines and Go's `context.WithTimeout` propagate the *remaining* time down the chain",
      'precisely for this reason: each layer learns how long is left, not a fixed constant.',
      '',
      '### The downstream keeps running after a timeout',
      '',
      'Easy to miss: after `Promise.race` fires, the request is not cancelled, it still holds a',
      'downstream connection and CPU. Retry on timeout while the old request is still processing and',
      'real load multiplies. Production timeouts must be paired with a cancellation signal',
      '(`AbortController`, `context.Context`).',
      '',
      '### Why the order is what it is',
      '',
      '```',
      'rate limit (outermost) -> breaker -> timeout -> downstream',
      '```',
      '',
      '- Limiter outermost: throttled requests should consume neither breaker budget nor timeout budget;',
      '- Timeout inside the breaker: that is what makes "slow" count as a failure;',
      '- If you add retries, they belong *outside* the breaker, otherwise retries accelerate tripping it.',
      '',
      '### What is still missing',
      '',
      'A real gateway also has bulkheads (per-dependency connection pools or semaphores so one slow',
      'dependency cannot exhaust global resources), load shedding (dropping low-priority work under',
      'overload) and graceful degradation (returning cached or default data instead of an error).',
    ].join('\n')
  ),
  focus: ['resilience', 'latency', 'encapsulation', 'elegance'],
  lab: {
    defaultLatencyMs: 100,
    endpoints: {
      '/api/down': { failFirstN: 99, status: 503 },
      '/api/slow': { latencyMs: 500 },
      '/api/blip': { failFirstN: 1, status: 503 },
    },
  },
  starterFiles: [
    file(
      'src/timeout.ts',
      code`
        export class TimeoutError extends Error {
          constructor(ms: number) {
            super('timeout after ' + ms + 'ms');
            this.name = 'TimeoutError';
          }
        }

        /** Put a timeout budget around any async task */
        export async function withTimeout<T>(task: () => Promise<T>, ms: number): Promise<T> {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
    file(
      'src/gateway.ts',
      code`
        import type { GatewayResult, GatewayStats } from './contract';

        export interface GatewayOptions {
          capacity: number;
          refillPerSecond: number;
          failureThreshold: number;
          resetTimeoutMs: number;
          timeoutMs: number;
        }

        export interface Gateway {
          call(url: string): Promise<GatewayResult>;
          stats(): GatewayStats;
        }

        /**
         * Combine rate limiting, the circuit breaker and timeouts.
         * call always resolves, translating failures into a GatewayResult.
         */
        export function createGateway(options: GatewayOptions): Gateway {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `
    ),
  ],
  specs: [
    spec(
      'specs/stage-9.spec.ts',
      code`
        import { withTimeout, TimeoutError } from '../src/timeout';
        import { createGateway } from '../src/gateway';
        import { getMetrics } from '@lab/net';
        import { now, sleep } from '@lab/env';

        function createDefaultGateway() {
          return createGateway({
            capacity: 10,
            refillPerSecond: 100,
            failureThreshold: 3,
            resetTimeoutMs: 1000,
            timeoutMs: 200,
          });
        }

        describe('Stage 9 · Timeout budgets and composition', () => {
          it('withTimeout returns normally inside the budget', async () => {
            const value = await withTimeout(async () => {
              await sleep(50);
              return 'fast';
            }, 200);
            expect(value).toBe('fast');
          });

          it('withTimeout throws TimeoutError on expiry [gate:timeout]', async () => {
            const startedAt = now();
            let caught: unknown;
            try {
              await withTimeout(async () => {
                await sleep(500);
                return 'slow';
              }, 200);
            } catch (error) {
              caught = error;
            }
            expect(caught).toBeInstanceOf(TimeoutError);
            expect(now() - startedAt).toBe(200);
          });

          it('a slow downstream is timed out rather than waited on forever [gate:budget]', async () => {
            const gateway = createDefaultGateway();
            const result = await gateway.call('/api/slow');
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('timeout');
            expect(gateway.stats().timedOut).toBe(1);
          });

          it('a normal request returns data', async () => {
            const gateway = createDefaultGateway();
            const result = await gateway.call('/api/ok');
            expect(result.ok).toBe(true);
            expect(result.data).toBeDefined();
            expect(gateway.stats().ok).toBe(1);
          });

          it('sustained failure trips the breaker and stops hitting downstream [gate:protect]', async () => {
            const gateway = createDefaultGateway();
            const reasons: string[] = [];

            for (let index = 0; index < 8; index += 1) {
              const result = await gateway.call('/api/down');
              reasons.push(result.reason || 'unknown');
            }

            expect(reasons.slice(0, 3).every((reason) => reason === 'upstream')).toBe(true);
            expect(reasons.slice(3).every((reason) => reason === 'circuit-open')).toBe(true);
            expect(getMetrics().requests.total).toBe(3);
            expect(gateway.stats().rejected).toBe(5);
          });

          it('timeouts accumulate towards the breaker too', async () => {
            const gateway = createGateway({
              capacity: 10,
              refillPerSecond: 100,
              failureThreshold: 2,
              resetTimeoutMs: 1000,
              timeoutMs: 200,
            });

            await gateway.call('/api/slow');
            await gateway.call('/api/slow');
            const third = await gateway.call('/api/slow');

            expect(third.reason).toBe('circuit-open');
            expect(gateway.stats().timedOut).toBe(2);
          });

          it('a task finishing inside the budget is unaffected, and a late timer cannot rewrite its result', async () => {
            let settled = 'pending';
            await withTimeout(async () => {
              await sleep(50);
              return 'fast';
            }, 1000).then((value) => {
              settled = value;
            });

            expect(settled).toBe('fast');

            // Push the clock past the timeout point: the result must not be overturned
            // (note: a leaked timer is not itself observable in this sandbox — see 'Common pitfalls')
            await sleep(2000);
            expect(settled).toBe('fast');
          });

          it('call never throws and returns a structured result on failure', async () => {
            const gateway = createDefaultGateway();
            const results = await Promise.all([
              gateway.call('/api/ok'),
              gateway.call('/api/down'),
              gateway.call('/api/slow'),
            ]);

            for (const result of results) {
              expect(typeof result.ok).toBe('boolean');
              if (!result.ok) expect(typeof result.reason).toBe('string');
            }
          });

          it('a single blip does not penalise later requests', async () => {
            const gateway = createDefaultGateway();

            // /api/blip fails once and the threshold is 3, so it should not trip
            const first = await gateway.call('/api/blip');
            expect(first.ok).toBe(false);
            expect(first.reason).toBe('upstream');

            const second = await gateway.call('/api/blip');
            expect(second.ok).toBe(true);
            expect(gateway.stats().ok).toBe(1);
            expect(gateway.stats().failed).toBe(1);
          });

          it("stats' four counters are independent", async () => {
            const gateway = createGateway({
              capacity: 10,
              refillPerSecond: 100,
              failureThreshold: 1,
              resetTimeoutMs: 5000,
              timeoutMs: 200,
            });

            await gateway.call('/api/slow'); // timedOut, and trips the breaker at the same time
            await gateway.call('/api/ok'); // breaker already open -> rejected

            const stats = gateway.stats();
            expect(stats.timedOut).toBe(1);
            expect(stats.rejected).toBe(1);
            expect(stats.ok).toBe(0);
          });

          it('two gateway instances do not affect each other', async () => {
            const first = createGateway({
              capacity: 10,
              refillPerSecond: 100,
              failureThreshold: 1,
              resetTimeoutMs: 5000,
              timeoutMs: 200,
            });
            const second = createGateway({
              capacity: 10,
              refillPerSecond: 100,
              failureThreshold: 1,
              resetTimeoutMs: 5000,
              timeoutMs: 200,
            });

            await first.call('/api/down');
            const result = await second.call('/api/ok');

            expect(result.ok).toBe(true);
            expect(second.stats().rejected).toBe(0);
          });

          it('rate limiting keeps the long-run rate controlled [gate:ratelimit]', async () => {
            const gateway = createGateway({
              capacity: 3,
              refillPerSecond: 10,
              failureThreshold: 10,
              resetTimeoutMs: 1000,
              timeoutMs: 500,
            });

            const startedAt = now();
            const results = await Promise.all(
              Array.from({ length: 6 }, (_, index) => gateway.call('/api/item/' + index))
            );
            const elapsed = now() - startedAt;

            expect(results.every((item) => item.ok)).toBe(true);
            // 3 pass immediately, the next 3 one per 100ms, and the last one takes another 100ms to request
            expect(elapsed).toBeGreaterThanOrEqual(400);
            expect(elapsed).toBeLessThanOrEqual(460);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 200,
      unit: 'ms',
      zh: '超时预算严格生效',
      en: 'Timeout budget is enforced',
      dimension: 'latency',
      scope: 'gate:budget',
    }),
    gate({
      metric: 'requests.total',
      op: 'lte',
      value: 3,
      zh: '熔断后下游零打扰',
      en: 'Zero downstream traffic once open',
      dimension: 'resilience',
      scope: 'gate:protect',
    }),
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 460,
      unit: 'ms',
      zh: '限流不引入额外浪费',
      en: 'Rate limiting adds no extra waste',
      dimension: 'latency',
      scope: 'gate:ratelimit',
    }),
  ],
  referenceFiles: [
    file(
      'src/timeout.ts',
      code`
        export class TimeoutError extends Error {
          constructor(ms: number) {
            super('timeout after ' + ms + 'ms');
            this.name = 'TimeoutError';
          }
        }

        export async function withTimeout<T>(task: () => Promise<T>, ms: number): Promise<T> {
          let timer: any;

          const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
          });

          try {
            return await Promise.race([task(), timeout]);
          } finally {
            clearTimeout(timer);
          }
        }
      `
    ),
    file(
      'src/gateway.ts',
      code`
        import { request } from '@lab/net';
        import { createTokenBucket } from './rateLimiter';
        import { createCircuitBreaker, CircuitOpenError } from './circuitBreaker';
        import { withTimeout, TimeoutError } from './timeout';
        import type { GatewayResult, GatewayStats } from './contract';

        export interface GatewayOptions {
          capacity: number;
          refillPerSecond: number;
          failureThreshold: number;
          resetTimeoutMs: number;
          timeoutMs: number;
        }

        export interface Gateway {
          call(url: string): Promise<GatewayResult>;
          stats(): GatewayStats;
        }

        export function createGateway(options: GatewayOptions): Gateway {
          const bucket = createTokenBucket({
            capacity: options.capacity,
            refillPerSecond: options.refillPerSecond,
          });
          const breaker = createCircuitBreaker({
            failureThreshold: options.failureThreshold,
            resetTimeoutMs: options.resetTimeoutMs,
          });
          const stats: GatewayStats = { ok: 0, timedOut: 0, rejected: 0, failed: 0 };

          return {
            async call(url: string): Promise<GatewayResult> {
              // Order matters: the limiter is outermost, and a throttled request should not consume
              // breaker budget
              await bucket.acquire();

              try {
                const response = await breaker.exec(() => withTimeout(() => request(url), options.timeoutMs));
                stats.ok += 1;
                return { ok: true, data: response.data };
              } catch (error) {
                if (error instanceof CircuitOpenError) {
                  stats.rejected += 1;
                  return { ok: false, reason: 'circuit-open', error: error.message };
                }
                if (error instanceof TimeoutError) {
                  stats.timedOut += 1;
                  return { ok: false, reason: 'timeout', error: error.message };
                }
                stats.failed += 1;
                return { ok: false, reason: 'upstream', error: (error as Error).message };
              }
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
    '注意 withTimeout 被放在 breaker.exec 内部：这样「慢」才会被熔断器看见。反过来写，超时只会在熔断器外面被吞掉，慢依赖永远不会触发熔断。',
    'Note that withTimeout sits inside breaker.exec: that is what lets the breaker see "slow" as failure. Invert them and timeouts are swallowed outside the breaker, so a slow dependency never trips it.'
  ),
};

/* ------------------------------------------------------------------ */

const stage10 = {
  id: 'degradation',
  title: t('第 10 关 · 优雅降级与兜底', 'Stage 10 · Graceful degradation'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前九关的所有手段 —— 限流、熔断、舱壁、预算 —— 都在回答同一个问题：',
      '**怎么在下游出问题时保护自己**。这一关回答下一个问题：保护住了之后，给用户返回什么？',
      '',
      '返回 500 是最省事的答案，也是最差的：推荐服务挂了不该让整个首页打不开，',
      '它只该让推荐位变成「热门商品」。',
      '',
      '## 要实现什么',
      '',
      '在 `src/degrade.ts` 实现 `createDegrader(options)`，核心是 `get(key, load)`',
      '返回 `{ value, freshness }`：',
      '',
      '| freshness | 什么时候返回它 |',
      '| --- | --- |',
      '| `live` | 缓存还在 `ttlMs` 内，或者刚从下游取到 |',
      '| `stale` | 下游失败了，但缓存还在 `staleWhileErrorMs` 内，能用 |',
      '| `fallback` | 连过期缓存都没有，返回 `fallback(key)` |',
      '',
      '另外：下游失败后进入 `retryAfterMs` 冷却期，期间直接吐旧值，不再打下游。',
      '`cachedAt(key)` 用来观察缓存的写入时刻。',
      '',
      '## 怎么算过',
      '',
      '- 三档新鲜度各自在正确的条件下出现；',
      '- **`get` 永远不抛异常**，下游全挂时 20 次调用 20 次都拿到可用的值',
      '  （门槛 `counters.degradeThrows = 0`）；',
      '- 这 20 次里真正打到下游的不超过 2 次（门槛 `counters.downstreamCalls ≤ 2`）；',
      '- 下游恢复后立刻解除冷却，不让恢复被冷却期拖着。',
      '',
      '## 为什么要分 `stale` 和 `fallback` 两档',
      '',
      '一份过期五分钟的真实数据，和一个写死的默认值，对调用方是**完全不同的两种可信度**。',
      '合成一档之后，调用方就没法决定「这个值能不能拿去做扣款判断」了。',
      '降级组件的职责是给出值和它的可信度，怎么用是调用方的事。',
      '',
      '**`get` 不抛异常是这一层唯一的硬性契约。** 抛出去就等于把降级决定推给了每一个调用点 ——',
      '而那些调用点各写各的 try/catch，正是「推荐服务挂了首页打不开」的由来。',
      '',
      '冷却期对着第二个门槛：缓存里明明有能用的旧值，没必要在下游最虚弱时继续加压；',
      '何况每次都等它超时，降级本身就成了延迟来源。',
    ].join('\n'),
    [
      'Every technique in the previous nine stages — limiting, breaking, bulkheads, budgets — answers the',
      'same question: **how to protect yourself when a downstream fails**. This one answers the next: having',
      'protected yourself, what do you return to the user?',
      '',
      'A 500 is the easiest answer and the worst. A failing recommendation service should not make the home',
      'page unopenable; it should turn the recommendation slot into "popular items".',
      '',
      '## What to build',
      '',
      '`createDegrader(options)` in `src/degrade.ts`, centred on `get(key, load)` returning',
      '`{ value, freshness }`:',
      '',
      '| freshness | When it is returned |',
      '| --- | --- |',
      '| `live` | The cache is within `ttlMs`, or the value just came from the downstream |',
      '| `stale` | The downstream failed, but the cache is still within `staleWhileErrorMs` and usable |',
      '| `fallback` | Not even a stale value exists, so `fallback(key)` |',
      '',
      'Also: after a failure, enter a `retryAfterMs` cooldown, serving stale values without touching the',
      'downstream. `cachedAt(key)` exposes when a value was stored.',
      '',
      '## What counts as passing',
      '',
      '- Each of the three freshness levels appears under the right condition;',
      '- **`get` never throws** — with the downstream entirely down, twenty calls all return a usable value',
      '  (`counters.degradeThrows = 0`);',
      '- Across those twenty, at most two actually reach the downstream (`counters.downstreamCalls ≤ 2`);',
      '- Recovery lifts the cooldown immediately, so a healthy downstream is not held back by it.',
      '',
      '## Why `stale` and `fallback` are separate levels',
      '',
      'Real data five minutes out of date and a hard-coded default carry **completely different',
      'trustworthiness** for the caller. Collapse them into one and the caller can no longer decide whether',
      'this value may be used to authorise a charge. A degradation component\'s job is to supply a value plus',
      'its trustworthiness; what to do with that is the caller\'s business.',
      '',
      '**`get` not throwing is this layer\'s one hard contract.** Throwing pushes the degradation decision out',
      'to every call site — and call sites each writing their own try/catch is exactly how "the',
      'recommendation service failed, so the home page will not open" happens.',
      '',
      'The cooldown addresses the second gate: a usable stale value is already in hand, so there is no reason',
      'to keep pressing the downstream at its weakest — and waiting for its timeout every time would make the',
      'degradation layer itself the source of latency.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  G["get(key, load)"] --> F{"缓存新鲜吗？<br/>now - storedAt < ttlMs"}',
      '  F -- 是 --> LIVE["{ value, freshness: live }<br/>完全不碰下游"]',
      '  F -- 否 --> CD{"now < nextAttemptAt[key]？<br/>已知故障的冷却期内"}',
      '  CD -- 在冷却期 --> DEG',
      '  CD -- 不在 --> LOAD["await load()<br/>唯一真正打下游的地方"]',
      '  LOAD --> SUC{"成功了吗？"}',
      '  SUC -- 成功 --> SET["cache.set(key, 新值)<br/>nextAttemptAt.delete(key)<br/>立刻解除冷却"]',
      '  SET --> LIVE',
      '  SUC -- 抛错 --> MARK["nextAttemptAt[key] = now + retryAfterMs<br/>异常在这里被吃掉"]',
      '  MARK --> DEG["degraded(key, now)"]',
      '  DEG --> SW{"旧值还在 staleWhileErrorMs 内？"}',
      '  SW -- 在 --> STALE["{ 旧值, freshness: stale }"]',
      '  SW -- 不在 --> FB["{ fallback(key), freshness: fallback }"]',
      '```',
      '',
      '要点：图里**每一条路径的终点都是一个值**，没有任何一条边通向「抛出去」——',
      '这就是「`get` 永不抛异常」在结构上的样子。',
      '',
      '`CD` 那个判断是第二个门槛的全部：它把 `LOAD` 挡在后面，',
      '让 20 次调用里只有冷却期开始和结束时的那一两次能真正走到下游。',
      '`SET` 里那句 `delete` 同样重要 —— 少了它，下游已经好了，',
      '调用方还要再吃满一个 `retryAfterMs` 的旧值。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  G["get(key, load)"] --> F{"is the cache fresh?<br/>now - storedAt < ttlMs"}',
      '  F -- yes --> LIVE["{ value, freshness: live }<br/>the downstream is never touched"]',
      '  F -- no --> CD{"now < nextAttemptAt[key]?<br/>inside the known-failure cooldown"}',
      '  CD -- "cooling down" --> DEG',
      '  CD -- no --> LOAD["await load()<br/>the only place the downstream is called"]',
      '  LOAD --> SUC{"did it succeed?"}',
      '  SUC -- succeeded --> SET["cache.set(key, value)<br/>nextAttemptAt.delete(key)<br/>cooldown lifted at once"]',
      '  SET --> LIVE',
      '  SUC -- threw --> MARK["nextAttemptAt[key] = now + retryAfterMs<br/>the exception is absorbed here"]',
      '  MARK --> DEG["degraded(key, now)"]',
      '  DEG --> SW{"is the stored value within staleWhileErrorMs?"}',
      '  SW -- yes --> STALE["{ stored value, freshness: stale }"]',
      '  SW -- no --> FB["{ fallback(key), freshness: fallback }"]',
      '```',
      '',
      'The point: **every path in the diagram ends in a value**, and no edge leads to "throw" — that is what',
      '"`get` never throws" looks like structurally.',
      '',
      'The `CD` test is the whole of the second gate: it keeps `LOAD` behind it, so out of twenty calls only',
      'the one or two at the cooldown\'s edges actually reach the downstream. The `delete` inside `SET`',
      'matters just as much — without it, the downstream recovers and callers still eat a full',
      '`retryAfterMs` of stale values.',
    ].join('\n')
  ),
  checklist: [
    t('缓存新鲜时直接返回 live', 'A fresh cache returns live'),
    t('下游失败时返回 stale 而不是抛错', 'A downstream failure returns stale instead of throwing'),
    t('没有任何缓存时返回 fallback', 'With no cache at all, the fallback is returned'),
    t('get 在任何情况下都不抛异常', 'get never throws under any circumstances'),
    t('冷却期内不重复打已知故障的下游', 'A known-failing downstream is not retried during the cooldown'),
  ],
  pitfalls: [
    t(
      '下游失败时把异常抛出去，让调用方决定怎么降级。听起来更灵活，实际上把降级逻辑推给了每一个调用点——于是有的地方处理了、有的地方没有，故障时的行为取决于代码是谁写的。降级组件的价值恰恰在于**它替所有调用方统一做了这个决定**。',
      'Letting the exception escape so the caller decides how to degrade. It sounds more flexible and pushes degradation logic to every call site, so some handle it and some do not and behaviour during an incident depends on who wrote which line. The value of a degradation component is precisely that it makes this decision once for everyone.'
    ),
    t(
      '下游失败后每次调用都再试一次。缓存里明明有可用的旧值，却仍然在下游最虚弱的时候持续给它加压——而且每次都要等它超时，降级本身变成了延迟来源。已知故障应该有冷却期，这和第 4 关租约失败后的冷却是同一个模式。',
      'Retrying the downstream on every call after it fails. A usable stale value is right there in the cache, and you keep adding load at its weakest moment — while waiting for each timeout, so the degradation itself becomes a source of latency. Known failures deserve a cooldown, the same pattern as the failed lease in stage 4.'
    ),
    t(
      '不区分 `stale` 和 `fallback`，统一返回一个「降级了」的布尔。调用方于是无法判断这个值有多可信——过期五秒的真实数据和一个写死的默认值，在业务上是完全不同的东西。前者可以直接展示，后者可能需要在界面上说明「暂时无法获取」。',
      'Collapsing `stale` and `fallback` into one "degraded" boolean. The caller then cannot judge how trustworthy the value is, and five-second-old real data is a completely different thing from a hard-coded default. The first can be displayed as-is; the second may need the interface to say the data is temporarily unavailable.'
    ),
    t(
      '成功之后不清除故障状态。冷却期是为「已知故障」设的，下游一旦恢复就该立刻回到正常路径。忘记在成功分支里重置，会让降级状态一直挂到冷却期自然结束——在冷却期设得比较长时（几十秒是常见配置），恢复后的可用性会莫名其妙地延迟。',
      'Not clearing the failure state after a success. The cooldown exists for known failures, and the moment the downstream recovers the normal path should resume. Forgetting to reset in the success branch leaves the degraded state in place until the cooldown expires naturally — and with cooldowns of tens of seconds, which is common, recovery is inexplicably delayed.'
    ),
  ],
  hints: [
    t(
      '每个 key 存 `{ value, storedAt }`。新鲜判断是 `now() - storedAt < ttlMs`，可用作 stale 的判断是 `now() - storedAt < staleWhileErrorMs`。',
      'Store `{ value, storedAt }` per key. Freshness is `now() - storedAt < ttlMs`; usable-as-stale is `now() - storedAt < staleWhileErrorMs`.'
    ),
    t(
      '冷却状态也按 key 存一个 `nextAttemptAt`。命中冷却时直接走 stale/fallback 分支，连 `load()` 都不要调用。',
      'Keep a per-key `nextAttemptAt` for the cooldown. While it is in effect, go straight to the stale or fallback branch without calling `load()` at all.'
    ),
  ],
  extension: t(
    [
      '「返回过期数据而不是错误」这个模式在 HTTP 缓存里有标准写法：',
      '`Cache-Control: stale-while-revalidate` 和 `stale-if-error`。',
      '前者是「过期了先给旧的、后台去刷新」，后者是「下游出错时可以用旧的」——',
      '这一关实现的是后者，而两者在真实 CDN 里通常同时开启。',
      '',
      '降级的层次比这一关多。除了「旧数据 vs 兜底值」，还有：',
      '**功能降级**（关掉个性化推荐，只出热门榜）、',
      '**精度降级**（返回近似的库存数字而不是精确值）、',
      '**范围降级**（只返回前 10 条而不是全部）。',
      '这些都需要业务方参与设计，不是纯技术决策——',
      '而这恰恰是降级最难的地方：写代码的人往往不知道哪些数据可以旧、旧多久还能用。',
      '',
      '还有一个反直觉的点：**降级要演练**。',
      '一个从来没被触发过的降级路径，在真正需要它的那天大概率是坏的——',
      '可能是兜底数据早就过期了，可能是那段代码在某次重构里被改坏了。',
      'Netflix 的 Chaos Monkey 和阿里的故障演练平台，很大一部分工作就是',
      '定期把降级路径跑一遍，确认它还活着。',
      '',
      '最后，降级和熔断的关系值得说清：熔断器决定「要不要打下游」，',
      '降级决定「不打下游时返回什么」。两者是同一件事的两半，',
      '真实实现里通常合在一个组件里——Hystrix 的 `getFallback()` 就是这个位置。',
    ].join('\n'),
    [
      'Returning stale data instead of an error has a standard spelling in HTTP caching:',
      '`Cache-Control: stale-while-revalidate` and `stale-if-error`. The first means serve the old value',
      'and refresh in the background, the second means the old value is acceptable when the origin errors.',
      'This stage implements the latter, and real CDNs usually enable both.',
      '',
      'Degradation has more levels than this stage covers. Beyond stale versus fallback there is functional',
      'degradation (disable personalisation and serve a popularity list), precision degradation (an',
      'approximate stock count rather than an exact one) and scope degradation (the first ten results',
      'rather than all). These require the product side to participate — which is what makes degradation',
      'hard, since the person writing the code rarely knows which data may be stale and for how long.',
      '',
      'A counterintuitive point: degradation must be rehearsed. A fallback path that has never fired is',
      'probably broken on the day it is needed — the fallback data expired long ago, or a refactor damaged',
      "that branch. A large part of what Netflix's Chaos Monkey does is periodically exercise these paths",
      'to confirm they are still alive.',
      '',
      'Finally, the relationship with circuit breaking is worth stating: the breaker decides whether to',
      'call the downstream, degradation decides what to return when it does not. They are two halves of one',
      "idea, and real implementations usually combine them — Hystrix's `getFallback()` sits exactly here.",
    ].join('\n')
  ),
  focus: ['resilience', 'correctness', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/degrade.ts',
      code`
        export type Freshness = 'live' | 'stale' | 'fallback';

        export interface DegradeResult {
          value: unknown;
          freshness: Freshness;
        }

        export interface DegradeOptions {
          /** How long a value counts as fresh */
          ttlMs: number;
          /** How old a value may be and still be served when downstream fails */
          staleWhileErrorMs: number;
          /** How long to wait before trying downstream again after a failure */
          retryAfterMs: number;
          /** What to return when there is not even a stale value */
          fallback(key: string): unknown;
        }

        export interface Degrader {
          /** Never throws, under any circumstances */
          get(key: string, load: () => Promise<unknown>): Promise<DegradeResult>;
          /** When this key was cached, or null if it was not */
          cachedAt(key: string): number | null;
        }

        export function createDegrader(options: DegradeOptions): Degrader {
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
        import { createDegrader } from '../src/degrade';
        import { now, sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const OPTIONS = {
          ttlMs: 100,
          staleWhileErrorMs: 10000,
          retryAfterMs: 1000,
          fallback: (key: string) => 'fallback:' + key,
        };

        function working(value: unknown) {
          return async () => value;
        }

        function broken(counter?: { calls: number }) {
          return async () => {
            if (counter) counter.calls += 1;
            throw new Error('downstream is down');
          };
        }

        describe('Stage 10 · Graceful degradation', () => {
          it('the first read goes downstream and is marked live', async () => {
            const degrader = createDegrader(OPTIONS);
            const result = await degrader.get('home', working('fresh'));
            expect(result).toEqual({ value: 'fresh', freshness: 'live' });
          });

          it('does not hit downstream while the cache is fresh', async () => {
            const degrader = createDegrader(OPTIONS);
            await degrader.get('home', working('first'));

            let called = false;
            const result = await degrader.get('home', async () => {
              called = true;
              return 'second';
            });
            expect(called).toBe(false);
            expect(result.value).toBe('first');
            expect(result.freshness).toBe('live');
          });

          it('fetches again once the cache expires', async () => {
            const degrader = createDegrader(OPTIONS);
            await degrader.get('home', working('first'));
            await sleep(150);

            const result = await degrader.get('home', working('second'));
            expect(result).toEqual({ value: 'second', freshness: 'live' });
          });

          it('returns the old value marked stale when downstream fails', async () => {
            const degrader = createDegrader(OPTIONS);
            await degrader.get('home', working('cached'));
            await sleep(150);

            const result = await degrader.get('home', broken());
            expect(result).toEqual({ value: 'cached', freshness: 'stale' });
          });

          it('returns the fallback when nothing is cached', async () => {
            const degrader = createDegrader(OPTIONS);
            const result = await degrader.get('home', broken());
            expect(result).toEqual({ value: 'fallback:home', freshness: 'fallback' });
          });

          it('falls back to the fallback when even the stale value is too old', async () => {
            const degrader = createDegrader({ ...OPTIONS, staleWhileErrorMs: 200, retryAfterMs: 0 });
            await degrader.get('home', working('ancient'));
            await sleep(500);

            const result = await degrader.get('home', broken());
            expect(result.freshness).toBe('fallback');
          });

          it('stale and fallback are two levels, not one boolean', async () => {
            const degrader = createDegrader(OPTIONS);
            await degrader.get('with-cache', working('cached'));
            await sleep(150);

            const stale = await degrader.get('with-cache', broken());
            const fallback = await degrader.get('no-cache', broken());
            expect(stale.freshness).toBe('stale');
            expect(fallback.freshness).toBe('fallback');
          });

          it('returns to live immediately once downstream recovers', async () => {
            const degrader = createDegrader({ ...OPTIONS, retryAfterMs: 50 });
            await degrader.get('home', working('cached'));
            await sleep(150);
            await degrader.get('home', broken());

            await sleep(60);
            const result = await degrader.get('home', working('recovered'));
            expect(result).toEqual({ value: 'recovered', freshness: 'live' });
          });

          it('cachedAt reflects when the value was cached', async () => {
            const degrader = createDegrader(OPTIONS);
            expect(degrader.cachedAt('home')).toBeNull();
            const before = now();
            await degrader.get('home', working('x'));
            expect(degrader.cachedAt('home')).toBe(before);
          });

          it('degradation state is independent per key', async () => {
            const degrader = createDegrader(OPTIONS);
            await degrader.get('bad', broken());
            const good = await degrader.get('good', working('ok'));
            expect(good.freshness).toBe('live');
          });

          it('twenty calls throw nothing while downstream is entirely down [gate:no-throw]', async () => {
            const degrader = createDegrader(OPTIONS);
            await degrader.get('home', working('cached'));
            await sleep(150);

            let thrown = 0;
            let usable = 0;
            for (let index = 0; index < 20; index += 1) {
              try {
                const result = await degrader.get('home', broken());
                if (result.value !== undefined && result.value !== null) usable += 1;
              } catch (caught) {
                thrown += 1;
              }
            }

            count('degradeThrows', thrown);
            expect(thrown).toBe(0);
            expect(usable).toBe(20);
          });

          it('does not repeatedly hit a downstream known to be broken during the cooldown [gate:cooldown]', async () => {
            const degrader = createDegrader(OPTIONS);
            await degrader.get('home', working('cached'));
            await sleep(150);

            const counter = { calls: 0 };
            for (let index = 0; index < 20; index += 1) {
              await degrader.get('home', broken(counter));
            }

            count('downstreamCalls', counter.calls);
            // An implementation that retries every time reports 20 here, waiting for each failure
            expect(counter.calls).toBeLessThanOrEqual(2);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.degradeThrows',
      op: 'eq',
      value: 0,
      zh: '下游全挂时降级组件一次都不抛异常',
      en: 'The degrader never throws, even with the downstream entirely down',
      dimension: 'resilience',
      scope: 'gate:no-throw',
    }),
    gate({
      metric: 'counters.downstreamCalls',
      op: 'lte',
      value: 2,
      zh: '冷却期内不给已知故障的下游继续加压',
      en: 'A known-failing downstream is not hammered during the cooldown',
      dimension: 'resilience',
      scope: 'gate:cooldown',
    }),
  ],
  referenceFiles: [
    file(
      'src/degrade.ts',
      code`
        import { now } from '@lab/env';

        export type Freshness = 'live' | 'stale' | 'fallback';

        export interface DegradeResult {
          value: unknown;
          freshness: Freshness;
        }

        export interface DegradeOptions {
          ttlMs: number;
          staleWhileErrorMs: number;
          retryAfterMs: number;
          fallback(key: string): unknown;
        }

        export interface Degrader {
          get(key: string, load: () => Promise<unknown>): Promise<DegradeResult>;
          cachedAt(key: string): number | null;
        }

        interface Entry {
          value: unknown;
          storedAt: number;
        }

        export function createDegrader(options: DegradeOptions): Degrader {
          const cache = new Map<string, Entry>();
          const nextAttemptAt = new Map<string, number>();

          function degraded(key: string, at: number): DegradeResult {
            const entry = cache.get(key);
            // Real data that has expired but is still inside the usable window, and a hardcoded default,
            // carry completely different confidence for the caller, so they are returned as two
            // distinct levels
            if (entry && at - entry.storedAt < options.staleWhileErrorMs) {
              return { value: entry.value, freshness: 'stale' };
            }
            return { value: options.fallback(key), freshness: 'fallback' };
          }

          return {
            async get(key: string, load: () => Promise<unknown>): Promise<DegradeResult> {
              const at = now();
              const entry = cache.get(key);
              if (entry && at - entry.storedAt < options.ttlMs) {
                return { value: entry.value, freshness: 'live' };
              }

              // During the cooldown for a known failure, load is not even called:
              // there is a perfectly usable stale value in the cache, so there is no reason to keep
              // pressing downstream at its weakest, and waiting for each timeout makes degradation
              // itself a source of latency
              const cooldownUntil = nextAttemptAt.get(key) ?? 0;
              if (at < cooldownUntil) return degraded(key, at);

              try {
                const value = await load();
                cache.set(key, { value, storedAt: now() });
                // Clear the cooldown as soon as a call succeeds, so recovery is not held back by it
                nextAttemptAt.delete(key);
                return { value, freshness: 'live' };
              } catch (error) {
                nextAttemptAt.set(key, now() + options.retryAfterMs);
                // The hard contract of this layer: exceptions stop here.
                // Letting one out pushes the degradation decision onto every single call site
                return degraded(key, now());
              }
            },

            cachedAt(key: string): number | null {
              const entry = cache.get(key);
              return entry ? entry.storedAt : null;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`get` 里唯一的 `throw` 来自 `options.fallback`。** 组件自己的代码路径上没有任何',
      '会抛的地方——`catch` 抓住了 `load` 的一切，而 `degraded` 只是读缓存和调 fallback。',
      '这个「不抛」的契约必须由组件保证，因为调用方数量众多，',
      '只要有一个地方忘了 try/catch，故障时就会有一个页面白屏。',
      '',
      '**成功分支里的 `nextAttemptAt.delete(key)`。** 冷却是为「已知故障」设的，',
      '下游一恢复就该立刻回到正常路径。忘了这一行，降级状态会一直挂到冷却期自然结束——',
      '生产配置里冷却期常是几十秒，于是「明明已经好了但还在返回旧数据」。',
      '',
      '**`degraded` 里用 `at` 而不是重新调 `now()`。** 判断新鲜度、判断冷却、判断 stale 窗口',
      '应该基于同一个时刻。中间隔着一次 `await` 的话时间会推进，',
      '于是可能出现「进函数时还在 stale 窗口内、走到判断时已经出去了」这种边界抖动。',
      'catch 分支里重新取 `now()` 是有意的——那里确实已经过了一次下游超时。',
      '',
      '**三档而不是布尔。** `stale` 和 `fallback` 在业务上的含义差得很远：',
      '前者是五秒前的真实数据，可以直接展示；后者是一个默认值，',
      '界面上可能需要明确告诉用户「暂时无法获取」。合成一个布尔就把这个选择权拿走了。',
    ].join('\n'),
    [
      'The only `throw` reachable from `get` comes from `options.fallback`. Nothing on the component\'s own',
      'path can throw — the `catch` absorbs everything `load` does, and `degraded` only reads the cache and',
      'calls the fallback. The no-throw contract must be guaranteed here because callers are many, and one',
      'forgotten try/catch means one blank page during an incident.',
      '',
      '`nextAttemptAt.delete(key)` in the success branch. The cooldown exists for known failures, and the',
      'moment the downstream recovers the normal path should resume. Without that line the degraded state',
      'persists until the cooldown expires naturally — often tens of seconds in production, producing "it',
      'recovered but is still serving stale data".',
      '',
      '`degraded` receives `at` rather than calling `now()` again. Freshness, cooldown and the stale window',
      'should all be judged against one instant; with an `await` in between, time advances and the boundary',
      'can flicker — inside the stale window on entry and outside it by the time the check runs. Re-reading',
      '`now()` in the catch branch is deliberate, since a downstream timeout really has elapsed there.',
      '',
      'Three levels, not a boolean. `stale` and `fallback` mean very different things to the product: the',
      'first is real data from five seconds ago and can be displayed as-is, the second is a default value',
      'that may need the interface to say the data is temporarily unavailable. One boolean takes that',
      'choice away.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage11 = {
  id: 'shadowing',
  title: t('第 11 关 · 流量镜像与灰度', 'Stage 11 · Traffic shadowing and canaries'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '网关做完了。最后一个问题：**怎么安全地换掉它背后的服务？**',
      '',
      '单元测试和压测都无法覆盖真实流量的形状 —— 真正的请求分布、真正的参数组合、',
      '真正的数据倾斜。唯一能验证新版本的办法是让它见真实流量，',
      '但又不能让它的 bug 影响用户。',
      '',
      '答案是**流量镜像**：把一部分请求复制一份发给新版本，**丢弃它的响应**，',
      '只用它来观察新版本会不会崩、会不会慢、结果一不一致。',
      '',
      '## 要实现什么',
      '',
      '在 `src/shadow.ts` 实现 `createShadower(options)`：',
      '',
      '| 规则 | 说明 |',
      '| --- | --- |',
      '| 永远执行 `primary` 并返回它的结果 | 包括它自己的异常，原样传出去 |',
      '| 按 `ratio` **额外**执行 `canary` | 主路径该干的一点不少 |',
      '| canary 的结果丢弃、异常吞掉 | 它只是观察对象 |',
      '| **不等 canary** | 它不许给主路径增加任何延迟 |',
      '| 采样按 key 哈希 | 同一个 key 每次镜像与否要一致 |',
      '',
      '`stats()` 报告 `primary` / `shadowed` / `canaryFailures` 三个计数。',
      '',
      '## 怎么算过',
      '',
      '- canary 每次都抛异常时，调用方拿到的异常次数是 **0**',
      '  （门槛 `counters.shadowLeaks = 0`）；',
      '- canary 慢到 2000ms 时，主路径的耗时还是它自己的 50ms',
      '  （门槛 `counters.shadowLatencyMs ≤ 60`）；',
      '- `ratio` 为 0 和 1 时分别是完全不镜像和全部镜像；',
      '- 同一个 key 反复调用，镜像与否始终一致。',
      '',
      '## 三个细节',
      '',
      '**用哈希而不是 `Math.random()` 采样。** 随机采样下同一个 key 时而镜像时而不镜像，',
      '「比较同一个请求在新旧版本上的表现」就无从谈起了。',
      '',
      '**fire-and-forget 必须给两个回调。** 只给成功回调、不处理 reject，',
      'canary 的异常会变成 unhandled rejection —— 某些运行时配置下这会直接让进程退出。',
      '一个只用来观察的旁路，把生产杀掉了。',
      '',
      '**`await` 一下 canary 看起来无害**，但主路径的延迟会立刻变成两者的最大值。',
      '第二个门槛量的就是这件事：canary 慢 40 倍时，用户不该感觉到任何变化。',
    ].join('\n'),
    [
      'The gateway is done. One question remains: **how do you safely replace the service behind it?**',
      '',
      'Neither unit tests nor load tests reproduce the shape of real traffic — the real distribution of',
      'requests, the real parameter combinations, the real data skew. The only way to validate a new version',
      'is to show it real traffic, without letting its bugs reach users.',
      '',
      'The answer is **traffic shadowing**: copy a fraction of requests to the new version, **discard its',
      'responses**, and use it only to observe whether the new version crashes, slows down, or disagrees.',
      '',
      '## What to build',
      '',
      '`createShadower(options)` in `src/shadow.ts`:',
      '',
      '| Rule | Detail |',
      '| --- | --- |',
      '| Always run `primary` and return its result | Including its own errors, passed through unchanged |',
      '| Run `canary` **additionally**, for a `ratio` fraction | The main path loses nothing |',
      '| Discard the canary\'s result, swallow its errors | It is only an object of observation |',
      '| **Never wait for the canary** | It may add no latency to the main path |',
      '| Sample by hashing the key | The same key is consistently shadowed or not |',
      '',
      '`stats()` reports the `primary`, `shadowed` and `canaryFailures` counts.',
      '',
      '## What counts as passing',
      '',
      '- With a canary that throws every time, the caller sees **zero** exceptions',
      '  (`counters.shadowLeaks = 0`);',
      '- With a canary taking 2000ms, the main path still takes its own 50ms',
      '  (`counters.shadowLatencyMs ≤ 60`);',
      '- A `ratio` of 0 shadows nothing and a `ratio` of 1 shadows everything;',
      '- Repeated calls with one key are shadowed consistently.',
      '',
      '## Three details',
      '',
      '**Sample by hash, not `Math.random()`.** Random sampling shadows the same key sometimes and not',
      'others, which makes "compare how this request behaves on old and new" meaningless.',
      '',
      '**Fire-and-forget needs both callbacks.** Handle only success and leave rejection unhandled, and the',
      'canary\'s exception becomes an unhandled rejection — which under some runtime settings terminates the',
      'process outright. A side path meant purely for observation kills production.',
      '',
      '**`await`-ing the canary looks harmless**, but the main path\'s latency immediately becomes the maximum',
      'of the two. That is what the second gate measures: a canary 40× slower must be invisible to users.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  RUN["run(key, primary, canary)"] --> C1["counters.primary += 1"]',
      '  C1 --> S{"shouldShadow(key)？<br/>hash(key) % 1000 < ratio × 1000<br/>哈希而不是随机数：同一个 key 结果恒定"}',
      '  S -- 否 --> P',
      '  S -- 是 --> FIRE["counters.shadowed += 1<br/>Promise.resolve().then(canary)<br/>发出去就不管，不 await"]',
      '  FIRE --> P["return primary()<br/>结果和异常都原样返回给调用方"]',
      '',
      '  FIRE -.旁路，主路径已经走了.-> CB{"canary 结束了"}',
      '  CB -- 成功 --> DROP["丢弃结果<br/>它不影响任何返回值"]',
      '  CB -- 抛错 --> COUNT["counters.canaryFailures += 1<br/>异常到此为止，不外泄"]',
      '```',
      '',
      '要点：`FIRE` 那个分叉是全图的关键 —— 它有两条出边，',
      '一条是虚线的旁路，一条是实线的主路径，而主路径**不等**旁路。',
      '把 `FIRE` 改成 `await`，两条边就并成一条，主路径的耗时立刻变成两者的最大值。',
      '',
      '`CB` 的两个分支都必须写。只写成功那支，canary 的异常会变成 unhandled rejection，',
      '一个纯观察用途的旁路可能因此把进程带走。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  RUN["run(key, primary, canary)"] --> C1["counters.primary += 1"]',
      '  C1 --> S{"shouldShadow(key)?<br/>hash(key) % 1000 < ratio × 1000<br/>hashing, not randomness: one key, one constant answer"}',
      '  S -- no --> P',
      '  S -- yes --> FIRE["counters.shadowed += 1<br/>Promise.resolve().then(canary)<br/>fire and forget, never awaited"]',
      '  FIRE --> P["return primary()<br/>result and errors pass through to the caller"]',
      '',
      '  FIRE -.side path, the main path already moved on.-> CB{"the canary settles"}',
      '  CB -- succeeded --> DROP["discard the result<br/>it affects no return value"]',
      '  CB -- threw --> COUNT["counters.canaryFailures += 1<br/>the exception stops here"]',
      '```',
      '',
      'The point: the fork at `FIRE` is the whole diagram — two outgoing edges, one dashed side path and one',
      'solid main path, and the main path **does not wait** for the side path. Turn `FIRE` into an `await`',
      'and the two edges merge into one, making the main path\'s latency the maximum of the two.',
      '',
      'Both branches of `CB` must be written. Handle only success and the canary\'s exception becomes an',
      'unhandled rejection, letting a purely observational side path take the process down with it.',
    ].join('\n')
  ),
  checklist: [
    t('主路径的结果永远原样返回', "The primary's result is always returned unchanged"),
    t('canary 的异常不会传播给调用方', "The canary's errors never reach the caller"),
    t('不等待 canary，主路径零额外延迟', 'The canary is not awaited and adds no latency'),
    t('按比例采样，同一个 key 结果稳定', 'Sampling is proportional and stable per key'),
    t('统计里能看出 canary 的失败次数', 'Canary failures are visible in the stats'),
  ],
  pitfalls: [
    t(
      '用 `Promise.all([primary, canary])` 同时等两个。主路径的延迟立刻变成两者的最大值——一个还在调试中的新版本，慢是常态，于是镜像流量把生产延迟拖垮了。canary 必须是 fire-and-forget：发出去就不管了。',
      'Awaiting both with `Promise.all([primary, canary])`. The main path\'s latency becomes the maximum of the two, and a new version still being debugged is slow by default, so shadowing drags production latency down with it. The canary must be fire-and-forget.'
    ),
    t(
      '不给 canary 挂 `.catch()`。它抛出的异常变成 unhandled rejection——在 Node 里默认会打印警告，某些配置下直接让进程退出。一个本该「只用来观察」的旁路，把生产进程杀掉了。这是流量镜像最经典的事故形态。',
      'Not attaching a `.catch()` to the canary. Its exception becomes an unhandled rejection, which Node warns about by default and under some configurations terminates the process. A side path meant purely for observation kills production. This is the classic shadowing incident.'
    ),
    t(
      '采样用 `Math.random()`。功能上没问题，但同一个 key 这次镜像、下次不镜像，你就没法比较「同一个请求在新旧版本上的结果」——而这恰恰是镜像最有价值的用途。按 key 哈希采样才能让对比有意义，顺便还让结果可复现。',
      'Sampling with `Math.random()`. Functionally fine, and the same key is shadowed one time and not the next, so you cannot compare how one request behaves on both versions — which is the most valuable thing shadowing offers. Hashing the key makes comparison meaningful and results reproducible.'
    ),
    t(
      '镜像写操作。读请求镜像是安全的，写请求镜像会让新版本真的往数据库里写一遍——重复扣款、重复发货。真实的镜像方案要么只镜像读，要么让 canary 连一个隔离的数据副本。这一关不涉及，但它是上线前必须回答的第一个问题。',
      'Shadowing writes. Mirroring reads is safe; mirroring writes makes the new version genuinely write to the database — double charges, double shipments. Real shadowing either mirrors reads only or points the canary at an isolated data copy. Out of scope here, and the first question to answer before enabling it.'
    ),
  ],
  hints: [
    t(
      'fire-and-forget 的正确写法是 `canary().then(onOk, onErr)`，注意**不要** await 它。两个回调都要给，只给 then 不给 catch 等于没处理异常。',
      'Fire-and-forget is `canary().then(onOk, onErr)` without awaiting. Supply both callbacks — a `then` without a rejection handler is not handling the error.'
    ),
    t(
      '采样判断：`hash(key) % 1000 < ratio * 1000`。用上一关的 FNV-1a 就行。',
      'Sample with `hash(key) % 1000 < ratio * 1000`, reusing the FNV-1a from the balancer stage.'
    ),
  ],
  extension: t(
    [
      '流量镜像在服务网格里是一等公民：Istio 的 `VirtualService` 有 `mirror` 字段，',
      'Envoy 有 `request_mirror_policies`，配置一行就能把 5% 的流量复制到新版本。',
      '',
      '镜像之外还有几种上线策略，风险和信息量各不相同：',
      '**金丝雀发布**让新版本承担一小部分真实流量（响应真的返回给用户），',
      '比镜像风险高，但能测到写路径和真实的用户反馈；',
      '**蓝绿部署**准备两套完整环境，一次性切换，回滚最快但资源翻倍；',
      '**功能开关**把「发布」和「启用」分开，代码早就上线了，只是开关没开。',
      '成熟团队通常四种混用：功能开关控制范围，镜像验证性能，',
      '金丝雀验证正确性，蓝绿作为最后的回滚手段。',
      '',
      '镜像最有价值的用法是**差异对比**（diff testing）：',
      '把新旧版本的响应都记下来，离线比对不一致的部分。',
      'GitHub 开源的 Scientist 库就是干这个的，',
      'Twitter 用类似的手法重写过整个时间线服务。',
      '难点在于「不一致」不等于「错」——时间戳、随机 id、字段顺序都会造成噪音，',
      '所以真正跑起来之后，绝大部分工作是在写各种归一化规则。',
      '',
      '最后一个容易忽略的成本：镜像会让下游的**总负载翻倍**。',
      '如果新旧版本共用一个数据库，5% 的镜像流量就是数据库 5% 的额外读。',
      '在数据库本来就接近瓶颈时，验证新版本的动作本身可能先把系统压垮。',
    ].join('\n'),
    [
      'Traffic shadowing is a first-class feature in service meshes: Istio\'s `VirtualService` has a `mirror`',
      "field and Envoy has `request_mirror_policies`, so copying 5% of traffic to a new version is one line",
      'of configuration.',
      '',
      'Alongside mirroring there are several release strategies with different risk and information:',
      'canary releases give the new version a small share of real traffic with responses actually returned',
      'to users, which is riskier than mirroring and does exercise write paths and real feedback; blue-green',
      'keeps two complete environments and switches at once, with the fastest rollback and double the',
      'resources; feature flags separate deploying from enabling, so the code shipped long ago and only the',
      'switch is off. Mature teams mix all four: flags for scope, mirroring for performance, canaries for',
      'correctness, blue-green as the last-resort rollback.',
      '',
      'The most valuable use of mirroring is diff testing: record both responses and compare them offline.',
      "GitHub's Scientist library exists for this, and Twitter rewrote its entire timeline service with the",
      'same approach. The difficulty is that "different" does not mean "wrong" — timestamps, random ids and',
      'field ordering all create noise, so once it is running, most of the work is writing normalisation',
      'rules.',
      '',
      'A last, easily forgotten cost: mirroring doubles load on everything downstream. If both versions',
      'share a database, 5% mirrored traffic is 5% extra reads on it. With the database already near its',
      'limit, the act of validating the new version can be what finally overwhelms the system.',
    ].join('\n')
  ),
  focus: ['resilience', 'encapsulation', 'latency'],
  lab: {},
  starterFiles: [
    file(
      'src/shadow.ts',
      code`
        export interface ShadowOptions {
          /** Mirroring ratio, 0 to 1 */
          ratio: number;
        }

        export interface ShadowStats {
          /** How many times the primary path ran */
          primary: number;
          /** How many times traffic was mirrored */
          shadowed: number;
          /** How many times the canary failed (counted only, never rethrown) */
          canaryFailures: number;
        }

        export interface Shadower {
          run(
            key: string,
            primary: () => Promise<unknown>,
            canary: () => Promise<unknown>
          ): Promise<unknown>;
          stats(): ShadowStats;
        }

        export function createShadower(options: ShadowOptions): Shadower {
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
        import { createShadower } from '../src/shadow';
        import { now, sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const ok = (value: unknown) => async () => value;
        const slow = (value: unknown, delay: number) => async () => {
          await sleep(delay);
          return value;
        };
        const explodes = async () => {
          throw new Error('canary is broken');
        };

        describe('Stage 11 · Traffic mirroring', () => {
          it("always returns the primary path's result", async () => {
            const shadower = createShadower({ ratio: 1 });
            const value = await shadower.run('k', ok('primary'), ok('canary'));
            expect(value).toBe('primary');
          });

          it('does not mirror when ratio is 0', async () => {
            const shadower = createShadower({ ratio: 0 });
            let canaryRan = false;
            await shadower.run('k', ok('primary'), async () => {
              canaryRan = true;
              return 'canary';
            });
            await sleep(10);
            expect(canaryRan).toBe(false);
            expect(shadower.stats().shadowed).toBe(0);
          });

          it('mirrors every time when ratio is 1', async () => {
            const shadower = createShadower({ ratio: 1 });
            for (let index = 0; index < 10; index += 1) {
              await shadower.run('key-' + index, ok('primary'), ok('canary'));
            }
            await sleep(10);
            expect(shadower.stats().shadowed).toBe(10);
            expect(shadower.stats().primary).toBe(10);
          });

          it('samples proportionally', async () => {
            const shadower = createShadower({ ratio: 0.3 });
            for (let index = 0; index < 400; index += 1) {
              await shadower.run('user-' + index, ok('primary'), ok('canary'));
            }
            await sleep(10);
            const shadowed = shadower.stats().shadowed;
            expect(shadowed).toBeGreaterThan(60);
            expect(shadowed).toBeLessThan(200);
          });

          it('sampling is stable for a given key', async () => {
            const shadower = createShadower({ ratio: 0.5 });
            await shadower.run('stable-key', ok('p'), ok('c'));
            const first = shadower.stats().shadowed;

            for (let index = 0; index < 10; index += 1) {
              await shadower.run('stable-key', ok('p'), ok('c'));
            }
            await sleep(10);
            const after = shadower.stats().shadowed;
            // Either mirrored every time (11) or not at all (0)
            expect(after === 0 || after === 11).toBe(true);
            expect(first === 0 || first === 1).toBe(true);
          });

          it('a throwing canary never reaches the caller [gate:no-leak]', async () => {
            const shadower = createShadower({ ratio: 1 });
            let leaked = 0;

            for (let index = 0; index < 50; index += 1) {
              try {
                const value = await shadower.run('key-' + index, ok('primary'), explodes);
                expect(value).toBe('primary');
              } catch (caught) {
                leaked += 1;
              }
            }
            await sleep(10);

            count('shadowLeaks', leaked);
            expect(leaked).toBe(0);
            expect(shadower.stats().canaryFailures).toBe(50);
          });

          it('a very slow canary does not slow the primary path [gate:no-latency]', async () => {
            const shadower = createShadower({ ratio: 1 });

            const startedAt = now();
            const value = await shadower.run('k', slow('primary', 50), slow('canary', 2000));
            const elapsed = now() - startedAt;

            count('shadowLatencyMs', elapsed);
            expect(value).toBe('primary');
            // A Promise.all implementation takes 2000ms here
            expect(elapsed).toBe(50);
          });

          it('errors from the primary path propagate as usual', async () => {
            const shadower = createShadower({ ratio: 1 });
            let thrown = false;
            try {
              await shadower.run('k', explodes, ok('canary'));
            } catch (caught) {
              thrown = true;
            }
            // Only the canary's errors may be swallowed; the primary path's must pass through untouched
            expect(thrown).toBe(true);
          });

          it('a successful canary does not count as a failure', async () => {
            const shadower = createShadower({ ratio: 1 });
            for (let index = 0; index < 5; index += 1) {
              await shadower.run('key-' + index, ok('primary'), ok('canary'));
            }
            await sleep(10);
            expect(shadower.stats().canaryFailures).toBe(0);
          });

          it('the primary path runs every time, regardless of sampling', async () => {
            const shadower = createShadower({ ratio: 0.1 });
            for (let index = 0; index < 30; index += 1) {
              expect(await shadower.run('key-' + index, ok('primary'), ok('canary'))).toBe('primary');
            }
            expect(shadower.stats().primary).toBe(30);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.shadowLeaks',
      op: 'eq',
      value: 0,
      zh: 'canary 的异常一次都不会漏给调用方',
      en: "Not one of the canary's errors reaches the caller",
      dimension: 'resilience',
      scope: 'gate:no-leak',
    }),
    gate({
      metric: 'counters.shadowLatencyMs',
      op: 'lte',
      value: 60,
      unit: 'ms',
      zh: '镜像流量不给主路径增加延迟',
      en: 'Shadow traffic adds no latency to the main path',
      dimension: 'latency',
      scope: 'gate:no-latency',
    }),
  ],
  referenceFiles: [
    file(
      'src/shadow.ts',
      code`
        export interface ShadowOptions {
          ratio: number;
        }

        export interface ShadowStats {
          primary: number;
          shadowed: number;
          canaryFailures: number;
        }

        export interface Shadower {
          run(
            key: string,
            primary: () => Promise<unknown>,
            canary: () => Promise<unknown>
          ): Promise<unknown>;
          stats(): ShadowStats;
        }

        function hash(text: string): number {
          let value = 2166136261;
          for (let index = 0; index < text.length; index += 1) {
            value ^= text.charCodeAt(index);
            value = Math.imul(value, 16777619);
          }
          return value >>> 0;
        }

        export function createShadower(options: ShadowOptions): Shadower {
          const counters: ShadowStats = { primary: 0, shadowed: 0, canaryFailures: 0 };

          function shouldShadow(key: string): boolean {
            if (options.ratio <= 0) return false;
            if (options.ratio >= 1) return true;
            // Hash on the key rather than Math.random: only a stable result per key makes it meaningful
            // to compare how the same request behaves on the old and new versions
            return hash(key) % 1000 < options.ratio * 1000;
          }

          return {
            run(
              key: string,
              primary: () => Promise<unknown>,
              canary: () => Promise<unknown>
            ): Promise<unknown> {
              counters.primary += 1;

              if (shouldShadow(key)) {
                counters.shadowed += 1;
                // Fire and forget. Awaiting it would make the primary path's latency
                // the maximum of the two
                Promise.resolve()
                  .then(canary)
                  .then(
                    () => undefined,
                    () => {
                      // Both callbacks are required. With then but no rejection handler,
                      // a canary error becomes an unhandled rejection and,
                      // under some configurations, exits the process outright — an observe-only
                      // side path killing production
                      counters.canaryFailures += 1;
                    }
                  );
              }

              // The primary path is returned as-is, including its own errors
              return primary();
            },

            stats(): ShadowStats {
              return { ...counters };
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`Promise.resolve().then(canary)` 而不是直接 `canary()`。** 直接调用的话，',
      'canary 里同步抛出的异常会在 `run` 内部就炸掉，绕过整条 promise 链传给调用方——',
      '而「canary 的问题不影响主路径」这条契约，恰恰要求连同步异常也被隔离。',
      '包一层 `Promise.resolve().then()` 把同步异常也变成了 rejection。',
      '',
      '**`.then(ok, err)` 而不是 `.then(ok).catch(err)`。** 这里两种写法效果一样，',
      '但两参数形式更明确地表达了「这是一个终点，不会再往下传」。',
      '真正要避免的是只写 `.then(ok)`——那样 canary 的 rejection 没有处理者，',
      '变成 unhandled rejection。',
      '',
      '**`return primary()` 而不是 `return await primary()`。** 这一关里两者等价，',
      '但不加 await 更准确地表达了 `run` 的语义：它不对主路径做任何处理，',
      '只是把 promise 原样交出去，包括异常。',
      '',
      '**`counters.primary` 在采样判断之前就加。** 主路径的执行次数和采样无关，',
      '把它放在 if 里面是很容易犯的错——统计会变成「只统计被镜像的请求」，',
      '而镜像比例恰恰要用它当分母。',
    ].join('\n'),
    [
      '`Promise.resolve().then(canary)` rather than calling `canary()` directly. A direct call lets an',
      'exception thrown synchronously inside the canary blow up inside `run` itself, bypassing the promise',
      'chain and reaching the caller — while the contract requires even synchronous errors to be isolated.',
      'Wrapping in `Promise.resolve().then()` converts them into rejections.',
      '',
      '`.then(ok, err)` rather than `.then(ok).catch(err)`. Both work here, and the two-argument form states',
      'more clearly that this is a terminus which propagates nothing further. What must be avoided is a',
      "bare `.then(ok)`, leaving the canary's rejection unhandled.",
      '',
      '`return primary()` rather than `return await primary()`. Equivalent here, and omitting the await',
      'expresses `run`\'s semantics more precisely: it does nothing to the main path and hands the promise',
      'back untouched, exceptions included.',
      '',
      '`counters.primary` increments before the sampling decision. Executions of the main path have nothing',
      'to do with sampling, and putting it inside the `if` is an easy mistake — the statistic becomes "only',
      'shadowed requests", and the shadow ratio needs it as the denominator.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

module.exports = {
  id: 'rate-limited-gateway',
  title: t('有韧性的 API 网关', 'Resilient API gateway'),
  summary: t(
    '十一关手写一整套网关可靠性机制：窗口算法、多维配额、分布式租约、熔断、负载均衡、舱壁、重试预算、降级与流量镜像。',
    'Eleven stages of gateway reliability built by hand: window algorithms, multi-dimensional quotas, distributed leases, breakers, balancing, bulkheads, retry budgets, degradation and shadowing.'
  ),
  difficulty: 'Hard',
  domain: 'reliability',
  tags: ['rate-limiting', 'circuit-breaker', 'timeout', 'resilience'],
  estimatedMinutes: 420,
  language: 'typescript',
  weights: {
    correctness: 3,
    concurrency: 1,
    latency: 2,
    resilience: 3,
    encapsulation: 1.5,
    elegance: 1.5,
  },
  brief: t(
    [
      '## 背景',
      '',
      '你负责一个对外网关，它前面是自家业务，后面是合作方的接口。合作方给的约束很硬：',
      '',
      '- 长期平均 **10 QPS**，允许短时突发；',
      '- 服务偶尔整体故障，故障期间响应会**变慢**而不是立刻报错；',
      '- 恢复需要时间，故障期间持续打流量会让恢复更慢。',
      '',
      '## 上周的故障复盘',
      '',
      '```',
      '14:02  合作方开始抖动，响应从 100ms 涨到 8s',
      '14:02  我们的客户端超时是 30s，于是所有请求都在那儿傻等',
      '14:03  连接池被占满，正常请求也开始排队',
      '14:04  客户端重试逻辑生效，流量放大到 6 倍',
      '14:05  合作方彻底挂掉',
      '14:44  合作方恢复（他们的抖动其实 14:04 就结束了）',
      '```',
      '',
      '结论写得很清楚：一次 2 分钟的抖动被我们自己拖成了 40 分钟的不可用。',
      '三个直接原因，超时太长、没有熔断、重试没有退避。',
      '',
      '## 目标',
      '',
      '| 关卡 | 保护什么 | 核心指标 |',
      '| --- | --- | --- |',
      '| 1 窗口算法 | 边界突刺 | 滑动窗口不放两倍流量，内存有界 |',
      '| 2 令牌桶 | 下游的速率 | 长期速率受控，突发可控 |',
      '| 3 多维配额 | 用户 / IP / 接口 | 被拒请求不消耗其他维度的额度 |',
      '| 4 分布式租约 | 全局额度 | 多实例合计不超限，协调次数与请求数无关 |',
      '| 5 熔断器 | 下游的恢复时间 | 打开后下游零打扰 |',
      '| 6 负载均衡 | 单个坏节点 | 摘除节点零流量，重映射不超过 40% |',
      '| 7 舱壁 | 资源边界 | 一个池被占满不影响其他池 |',
      '| 8 重试预算 | 重试放大 | 下游全挂时重试不翻倍流量 |',
      '| 9 超时 + 组合 | 自己的**资源** | 超时预算严格生效 |',
      '| 10 降级 | 用户看到什么 | 零异常，且不反复打已知故障的下游 |',
      '| 11 流量镜像 | 新版本上线 | canary 异常零泄漏，零额外延迟 |',
      '',
      '## 硬性约束',
      '',
      '1. 合作方长期平均 **10 QPS**，允许突发（突发大小由 `capacity` 决定）；',
      '2. 熔断打开期间，下游必须收到**零个**请求；',
      '3. 超时必须计入熔断的失败，「只慢不错」的下游同样需要被熔断；',
      '4. `call` 永远不抛异常，把失败翻译成 `GatewayResult`；',
      '5. 所有时间逻辑必须走 `@lab/env` 的 `now()` / `sleep()`（沙箱里的 `setTimeout` 也已接到虚拟时钟）。',
      '',
      '## 非目标',
      '',
      '- 不做分布式限流（本关是单进程，多实例的问题见第 1 关「延伸」）；',
      '- 不做重试：重试属于调用方，而且它和熔断的交互需要单独讨论；',
      '- 不做服务发现与配置下发：节点列表是静态传入的。',
      '',
      '## 术语',
      '',
      '- **令牌桶**：按固定速率补充令牌，请求消耗令牌；桶容量决定允许多大的突发。',
      '- **熔断器**：连续失败到阈值后停止调用下游，一段时间后放少量探针试探恢复。',
      '- 半开（half-open）：熔断后的试探状态，只允许极少量请求通过。',
      '- **超时预算**：一次调用最多允许花费的时间；它应该沿调用链分配，而不是每层各写一个常量。',
      '',
      '这道题的门槛几乎都压在故障时的行为上。正常路径能跑通是其中最容易的部分。',
    ].join('\n'),
    [
      '## Context',
      '',
      "You own an egress gateway: your services in front, a partner API behind. The partner's constraints are hard:",
      '',
      '- **10 QPS** long-run average, short bursts allowed;',
      '- the service occasionally fails wholesale, and during failures it gets **slow** rather than erroring fast;',
      '- recovery takes time, and sustained traffic during an outage makes it take longer.',
      '',
      "## Last week's postmortem",
      '',
      '```',
      '14:02  partner starts wobbling, latency goes from 100ms to 8s',
      '14:02  our client timeout is 30s, so every request just waits',
      '14:03  connection pool saturates, healthy requests start queuing',
      '14:04  client retries kick in, traffic amplifies 6x',
      '14:05  partner goes down completely',
      '14:44  partner recovers (their actual wobble ended at 14:04)',
      '```',
      '',
      'The conclusion was blunt: we turned a 2-minute wobble into 40 minutes of downtime ourselves.',
      'Three direct causes, timeouts too long, no breaker, retries without backoff.',
      '',
      '## Goal',
      '',
      '| Stage | Protects | Key gate |',
      '| --- | --- | --- |',
      '| 1 Window algorithms | boundary bursts | no double traffic at the edge, bounded memory |',
      '| 2 Token bucket | the downstream rate | long-run rate bounded, bursts controlled |',
      '| 3 Multi-dimensional quota | user / IP / route | a rejected request consumes no other dimension |',
      '| 4 Distributed leases | the global allowance | instances stay within it, coordination is not per request |',
      '| 5 Circuit breaker | the downstream recovery time | zero downstream traffic while open |',
      '| 6 Load balancing | one bad node | a removed node gets zero traffic, remap under 40% |',
      '| 7 Bulkheads | resource boundaries | one saturated pool leaves the others untouched |',
      '| 8 Retry budget | retry amplification | a dead downstream does not double the traffic |',
      '| 9 Timeout + composition | **your own** resources | timeout budget strictly enforced |',
      '| 10 Degradation | what the user sees | zero throws, and no hammering a known-failing downstream |',
      '| 11 Shadowing | shipping a new version | zero canary leaks, zero added latency |',
      '',
      '## Hard constraints',
      '',
      '1. The partner allows **10 QPS** long-run, with bursts sized by `capacity`;',
      '2. While the breaker is open the downstream must receive **zero** requests;',
      '3. Timeouts must count as breaker failures, a dependency that only ever hangs deserves tripping too;',
      '4. `call` never throws; failures become a `GatewayResult`;',
      '5. All time-dependent logic goes through `now()` / `sleep()` from `@lab/env` (the sandbox `setTimeout` is wired to the virtual clock too).',
      '',
      '## Non-goals',
      '',
      '- No distributed rate limiting (single process here; see the stage 1 "going further" note);',
      '- No retries: they belong to the caller, and their interaction with the breaker deserves its own discussion;',
      '- No bulkheads or fallback responses, mentioned in the stage 3 note.',
      '',
      '## Glossary',
      '',
      '- Token bucket: tokens refill at a fixed rate and requests consume them; capacity sets the burst size.',
      '- Circuit breaker: stops calling a dependency after consecutive failures, then probes for recovery.',
      '- Half-open: the probing state after a breaker opens; only a trickle is admitted.',
      '- Timeout budget: the maximum time one call may take, allocated across the chain rather than hard-coded per layer.',
      '',
      'Nearly every gate here is about behaviour during failure. The happy path is the easy part of it.',
    ].join('\n')
  ),
  architecture: t(
    [
      '```mermaid',
      'flowchart LR',
      '  C[caller] --> RL[token bucket]',
      '  RL --> CB{circuit}',
      '  CB -- open --> FF[fast fail]',
      '  CB -- closed/half-open --> TO[timeout budget]',
      '  TO --> UP["@lab/net upstream"]',
      '  TO -. timeout .-> CB',
      '  UP -. error .-> CB',
      '```',
      '',
      '顺序不能换：限流在最外层，超时在熔断内层。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart LR',
      '  C[caller] --> RL[token bucket]',
      '  RL --> CB{circuit}',
      '  CB -- open --> FF[fast fail]',
      '  CB -- closed/half-open --> TO[timeout budget]',
      '  TO --> UP["@lab/net upstream"]',
      '  TO -. timeout .-> CB',
      '  UP -. error .-> CB',
      '```',
      '',
      'The order is not interchangeable: limiter outermost, timeout inside the breaker.',
    ].join('\n')
  ),
  files: [contract],
  stages: [stage1, stage2, stage3, stage4, stage5, stage6, stage7, stage8, stage9, stage10, stage11],
};
