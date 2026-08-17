/**
 * 工程实战 · 有韧性的 API 网关
 *
 * 注意：代码片段使用 String.raw 模板，不要在片段里写 `${}`。
 */
const { t, code, file, readonlyFile, spec, gate } = require('./_helpers');

const contract = readonlyFile(
  'src/contract.ts',
  code`
    /** 平台提供的契约（只读） */

    export interface GatewayResult {
      ok: boolean;
      data?: unknown;
      /** 失败原因：'timeout' | 'circuit-open' | 'upstream' */
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
  id: 'token-bucket',
  title: t('第 1 关 · 令牌桶限流', 'Stage 1 · Token bucket rate limiting'),
  goal: t(
    [
      '网关要保护的第一件事是下游的速率：合作方允许突发，但长期平均速率有硬上限。',
      '',
      '在 `src/rateLimiter.ts` 实现令牌桶 `createTokenBucket({ capacity, refillPerSecond })`：',
      '',
      '- `tryAcquire(count)`：拿得到就扣减并返回 `true`，拿不到立刻返回 `false`（不等待）；',
      '- `acquire(count)`：等到有足够令牌为止；',
      '- `available()`：当前可用令牌数（向下取整），补充上限是 `capacity`。',
      '',
      '令牌要惰性补充：不要用 `setInterval` 定时加令牌，而是在被访问时按经过的时间算出应该补多少。',

    ].join('\n'),
    [
      'The first thing a gateway protects is the downstream rate: partners tolerate bursts but cap the long-run average.',
      '',
      'Implement a token bucket in `src/rateLimiter.ts`, `createTokenBucket({ capacity, refillPerSecond })`:',
      '',
      '- `tryAcquire(count)`: take tokens and return `true`, or return `false` immediately (never waits);',
      '- `acquire(count)`: wait until enough tokens exist;',
      '- `available()`: currently available tokens (floored), refilled up to `capacity`.',
      '',
      'Refill lazily: do not add tokens on a `setInterval`; compute how many should exist from elapsed time when the bucket is touched.',

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
          /** 桶容量，也就是允许的突发大小 */
          capacity: number;
          /** 每秒补充的令牌数 */
          refillPerSecond: number;
        }

        export interface TokenBucket {
          tryAcquire(count?: number): boolean;
          acquire(count?: number): Promise<void>;
          available(): number;
        }

        export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
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
        import { createTokenBucket } from '../src/rateLimiter';
        import { now, sleep } from '@lab/env';

        describe('阶段1 · 令牌桶', () => {
          it('初始满桶，允许一次突发', () => {
            const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 10 });
            expect(bucket.available()).toBe(5);
            for (let index = 0; index < 5; index += 1) {
              expect(bucket.tryAcquire()).toBe(true);
            }
            expect(bucket.tryAcquire()).toBe(false);
            expect(bucket.available()).toBe(0);
          });

          it('按时间惰性补充', async () => {
            const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 10 });
            for (let index = 0; index < 5; index += 1) bucket.tryAcquire();

            await sleep(100);
            expect(bucket.available()).toBe(1);
            await sleep(200);
            expect(bucket.available()).toBe(3);
          });

          it('补充不会超过 capacity', async () => {
            const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 10 });
            bucket.tryAcquire(5);
            await sleep(10000);
            expect(bucket.available()).toBe(5);
          });

          it('tryAcquire 不等待，acquire 才等待', async () => {
            const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 10 });
            expect(bucket.tryAcquire()).toBe(true);
            expect(bucket.tryAcquire()).toBe(false);

            const startedAt = now();
            await bucket.acquire();
            expect(now() - startedAt).toBe(100);
          });

          it('突发之后长期速率受控 [gate:rate]', async () => {
            const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 10 });
            const startedAt = now();
            for (let index = 0; index < 6; index += 1) {
              await bucket.acquire();
            }
            const elapsed = now() - startedAt;
            // 3 个突发 + 3 个按 100ms/个 补充
            expect(elapsed).toBeGreaterThanOrEqual(300);
            expect(elapsed).toBeLessThanOrEqual(360);
          });

          it('可以一次取多个令牌', () => {
            const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 10 });
            expect(bucket.tryAcquire(3)).toBe(true);
            expect(bucket.available()).toBe(2);
            expect(bucket.tryAcquire(3)).toBe(false);
            expect(bucket.available()).toBe(2);
          });

          it('取多个令牌时要等到全部补够', async () => {
            const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 10 });
            bucket.tryAcquire(5);

            const startedAt = now();
            await bucket.acquire(3);
            // 3 个令牌 = 300ms
            expect(now() - startedAt).toBeGreaterThanOrEqual(300);
          });

          it('补充按经过的时间等比例计算，而不是固定加一个', async () => {
            const bucket = createTokenBucket({ capacity: 10, refillPerSecond: 10 });
            bucket.tryAcquire(10);

            await sleep(500);
            // 500ms * 10/s = 5 个
            expect(bucket.available()).toBe(5);
          });

          it('内部保留小数，不会因为反复取整而系统性偏低', async () => {
            const bucket = createTokenBucket({ capacity: 10, refillPerSecond: 10 });
            bucket.tryAcquire(10);

            // 分 10 次推进，每次 50ms（半个令牌）
            for (let index = 0; index < 10; index += 1) {
              await sleep(50);
              bucket.available();
            }
            // 累计 500ms 就应该是 5 个，取整丢掉小数的话只会剩 0
            expect(bucket.available()).toBe(5);
          });

          it('没有流量时不需要任何定时器就能保持正确', async () => {
            const bucket = createTokenBucket({ capacity: 4, refillPerSecond: 10 });
            bucket.tryAcquire(4);

            // 长时间完全不碰它
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
                // 直接睡到「刚好补够」的时刻，不做无谓的轮询
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

const stage2 = {
  id: 'circuit-breaker',
  title: t('第 2 关 · 熔断器', 'Stage 2 · Circuit breaker'),
  goal: t(
    [
      '限流保护的是下游的速率，熔断保护的是下游的恢复时间：',
      '当一个依赖已经挂了，继续把流量打过去只会让它更难爬起来，也会拖垮你自己的线程/连接。',
      '',
      '在 `src/circuitBreaker.ts` 实现三态熔断器：',
      '',
      '- `closed`：正常放行；连续失败达到 `failureThreshold` 后转 `open`；',
      '- `open`：不调用下游，直接抛 `CircuitOpenError`；经过 `resetTimeoutMs` 后转 `half-open`；',
      '- `half-open`：只放行 `halfOpenMax` 个探针；探针成功回到 `closed`，失败立刻回到 `open`。',
      '',
      '熔断真正买到的东西是下游的恢复窗口，快速失败只是顺带的。',
      '半开状态就是为此存在的：用一个请求去试探，而不是把全部流量放回去。',
    ].join('\n'),
    [
      'Rate limiting protects the downstream rate; a breaker protects its recovery time:',
      'hammering a dependency that is already down keeps it down, and exhausts your own connections too.',
      '',
      'Implement a three-state breaker in `src/circuitBreaker.ts`:',
      '',
      '- `closed`: pass through; after `failureThreshold` consecutive failures go to `open`;',
      '- `open`: never call downstream, throw `CircuitOpenError`; after `resetTimeoutMs` go to `half-open`;',
      '- `half-open`: admit at most `halfOpenMax` probes; a successful probe closes the circuit, a failed one reopens it.',
      '',
      'What a breaker actually buys you is recovery time for the dependency. Failing fast is a side effect.',
      'Half-open exists for that: you probe with one request instead of pointing the firehose back at it.',
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
          /** 连续失败多少次后熔断 */
          failureThreshold: number;
          /** 熔断多久之后允许探针 */
          resetTimeoutMs: number;
          /** 半开状态最多放行几个探针，默认 1 */
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
        import { createCircuitBreaker, CircuitOpenError } from '../src/circuitBreaker';
        import { request, getMetrics } from '@lab/net';
        import { sleep } from '@lab/env';

        const failing = async () => {
          throw new Error('upstream exploded');
        };

        describe('阶段2 · 熔断器', () => {
          it('连续失败达到阈值后打开', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 500 });
            expect(breaker.state()).toBe('closed');

            for (let index = 0; index < 3; index += 1) {
              await expect(async () => breaker.exec(failing)).rejects.toThrow('upstream exploded');
            }

            expect(breaker.state()).toBe('open');
          });

          it('成功会清零失败计数', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 500 });
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            await breaker.exec(async () => 'ok');
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            expect(breaker.state()).toBe('closed');
          });

          it('打开期间不再调用下游 [gate:fastfail]', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });

            for (let index = 0; index < 6; index += 1) {
              try {
                await breaker.exec(() => request('/api/down'));
              } catch (error) {
                // 前 2 次是真实失败，之后应该是 CircuitOpenError
                if (index >= 2) expect(error).toBeInstanceOf(CircuitOpenError);
              }
            }

            expect(getMetrics().requests.total).toBe(2);
          });

          it('超时后进入半开，探针成功则闭合', async () => {
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

          it('半开探针失败立刻重新打开', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 300 });
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            await expect(async () => breaker.exec(failing)).rejects.toThrow();

            await sleep(300);
            expect(breaker.state()).toBe('half-open');

            await expect(async () => breaker.exec(failing)).rejects.toThrow('upstream exploded');
            expect(breaker.state()).toBe('open');
          });

          it('探针失败后要重新等满一个 resetTimeout', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 300 });
            await expect(async () => breaker.exec(failing)).rejects.toThrow();

            await sleep(300);
            await expect(async () => breaker.exec(failing)).rejects.toThrow();
            expect(breaker.state()).toBe('open');

            // 还没到下一个窗口
            await sleep(200);
            expect(breaker.state()).toBe('open');

            await sleep(100);
            expect(breaker.state()).toBe('half-open');
          });

          it('半开时只放行 halfOpenMax 个探针', async () => {
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

            // 两个请求同时进来，只有一个能当探针
            const results = await Promise.allSettled([breaker.exec(slowProbe), breaker.exec(slowProbe)]);
            expect(probes).toBe(1);
            expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
          });

          it('成功后计数清零，可以再撑满一个阈值', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 500 });

            for (let round = 0; round < 3; round += 1) {
              await expect(async () => breaker.exec(failing)).rejects.toThrow();
              await expect(async () => breaker.exec(failing)).rejects.toThrow();
              await breaker.exec(async () => 'ok');
              expect(breaker.state()).toBe('closed');
            }
          });

          it('闭合状态下正常返回下游的结果', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 });
            const response = await breaker.exec(() => request('/api/ok'));
            expect(response.status).toBe(200);
            expect(getMetrics().requests.total).toBe(1);
          });

          it('下游恢复后，探针成功会让流量重新放行', async () => {
            const breaker = createCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 200 });

            // /api/recovering 前两次失败，之后成功
            for (let index = 0; index < 2; index += 1) {
              try {
                await breaker.exec(() => request('/api/recovering'));
              } catch (error) {
                // 预期内
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

          // 读状态顺便完成 open -> half-open 的时间驱动转换
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

const stage3 = {
  id: 'gateway',
  title: t('第 3 关 · 超时预算与组合', 'Stage 3 · Timeout budget and composition'),
  goal: t(
    [
      '最后把三层保护组合成网关。顺序很重要：限流 → 熔断 → 超时 → 下游。',
      '',
      '- 在 `src/timeout.ts` 实现 `withTimeout(task, ms)`，超时抛 `TimeoutError`；',
      '- 在 `src/gateway.ts` 实现 `createGateway(options)`，暴露 `call(url)` 与 `stats()`；',
      '- `call` 永不抛异常，统一返回 `GatewayResult`，`reason` 取 `timeout` / `circuit-open` / `upstream`；',
      '- 超时要计入熔断的失败次数，一个一直超时的依赖同样需要被熔断。',
      '',
      '顺序错了保护就会失效。熔断放在限流之前，被限流挡下的请求会白白占用熔断配额；',
      '超时放在熔断之外，熔断就永远看不到「慢」这种失败。',
    ].join('\n'),
    [
      'Finally, compose the three protections into a gateway. Order matters: rate limit → breaker → timeout → downstream.',
      '',
      '- Implement `withTimeout(task, ms)` in `src/timeout.ts`, throwing `TimeoutError`;',
      '- Implement `createGateway(options)` in `src/gateway.ts`, exposing `call(url)` and `stats()`;',
      '- `call` never throws; it returns a `GatewayResult` whose `reason` is `timeout` / `circuit-open` / `upstream`;',
      '- timeouts must count as breaker failures, a permanently slow dependency deserves tripping too.',
      '',
      'Get the order wrong and the protection stops working. Put the breaker before the limiter and throttled',
      'requests waste breaker budget. Put the timeout outside the breaker and it never sees "slow" as a failure.',
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

        /** 给任意异步任务加上超时预算 */
        export async function withTimeout<T>(task: () => Promise<T>, ms: number): Promise<T> {
          // TODO: 在这里实现
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
         * 组合限流、熔断与超时。
         * call 永远 resolve，把失败翻译成 GatewayResult。
         */
        export function createGateway(options: GatewayOptions): Gateway {
          // TODO: 在这里实现
          throw new Error('not implemented');
        }
      `
    ),
  ],
  specs: [
    spec(
      'specs/stage-3.spec.ts',
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

        describe('阶段3 · 超时预算与组合', () => {
          it('withTimeout 在预算内正常返回', async () => {
            const value = await withTimeout(async () => {
              await sleep(50);
              return 'fast';
            }, 200);
            expect(value).toBe('fast');
          });

          it('withTimeout 超时抛 TimeoutError [gate:timeout]', async () => {
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

          it('慢下游被判超时而不是一直等 [gate:budget]', async () => {
            const gateway = createDefaultGateway();
            const result = await gateway.call('/api/slow');
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('timeout');
            expect(gateway.stats().timedOut).toBe(1);
          });

          it('正常请求返回数据', async () => {
            const gateway = createDefaultGateway();
            const result = await gateway.call('/api/ok');
            expect(result.ok).toBe(true);
            expect(result.data).toBeDefined();
            expect(gateway.stats().ok).toBe(1);
          });

          it('持续失败会熔断并停止打下游 [gate:protect]', async () => {
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

          it('超时同样会累积到熔断', async () => {
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

          it('预算内完成的任务不受超时影响，也不会被迟到的定时器改写结果', async () => {
            let settled = 'pending';
            await withTimeout(async () => {
              await sleep(50);
              return 'fast';
            }, 1000).then((value) => {
              settled = value;
            });

            expect(settled).toBe('fast');

            // 把时钟推过超时点：结果不能被翻案
            // （注意：泄漏的定时器本身在这个沙箱里观察不到，见「常见坑」）
            await sleep(2000);
            expect(settled).toBe('fast');
          });

          it('call 永远不抛异常，失败也返回结构化结果', async () => {
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

          it('单次抖动不会误伤后续请求', async () => {
            const gateway = createDefaultGateway();

            // /api/blip 只失败一次，阈值是 3，不该熔断
            const first = await gateway.call('/api/blip');
            expect(first.ok).toBe(false);
            expect(first.reason).toBe('upstream');

            const second = await gateway.call('/api/blip');
            expect(second.ok).toBe(true);
            expect(gateway.stats().ok).toBe(1);
            expect(gateway.stats().failed).toBe(1);
          });

          it('stats 的四类计数互相独立', async () => {
            const gateway = createGateway({
              capacity: 10,
              refillPerSecond: 100,
              failureThreshold: 1,
              resetTimeoutMs: 5000,
              timeoutMs: 200,
            });

            await gateway.call('/api/slow'); // timedOut，同时触发熔断
            await gateway.call('/api/ok'); // 熔断已开 -> rejected

            const stats = gateway.stats();
            expect(stats.timedOut).toBe(1);
            expect(stats.rejected).toBe(1);
            expect(stats.ok).toBe(0);
          });

          it('两个网关实例互不影响', async () => {
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

          it('限流让长期速率受控 [gate:ratelimit]', async () => {
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
            // 3 个立即放行，后 3 个每 100ms 放一个，最后一个再花 100ms 请求
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
              // 顺序：限流在最外层，被限流的请求不该消耗熔断配额
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

module.exports = {
  id: 'rate-limited-gateway',
  title: t('有韧性的 API 网关', 'Resilient API gateway'),
  summary: t(
    '令牌桶限流、三态熔断、超时预算，把课本上的三个可靠性模式亲手写出来，再用正确的顺序组合成网关。',
    'Token-bucket limiting, a three-state breaker and timeout budgets, build the three textbook reliability patterns and compose them in the right order.'
  ),
  difficulty: 'Hard',
  domain: 'reliability',
  tags: ['rate-limiting', 'circuit-breaker', 'timeout', 'resilience'],
  estimatedMinutes: 150,
  language: 'typescript',
  weights: {
    correctness: 3,
    concurrency: 1,
    latency: 2,
    resilience: 3,
    encapsulation: 1.5,
    elegance: 1.5,
  },
  prerequisites: [
    t('async / await 与 Promise.race', 'async/await and Promise.race'),
    t('了解状态机的概念会更容易理解熔断器', 'Familiarity with state machines helps for the breaker'),
    t('建议先做完《高可用抓取管线》', 'Doing the resilient fetch pipeline first is recommended'),
  ],
  learningOutcomes: [
    t(
      '手写令牌桶，并说清它和漏桶、和「QPS 限制」的区别',
      'Write a token bucket and explain how it differs from a leaky bucket and from a plain QPS cap'
    ),
    t(
      '实现三态熔断器，理解半开状态为什么是这个设计的核心',
      'Implement a three-state breaker and see why half-open is the heart of the design'
    ),
    t(
      '把「慢」也当成一种失败：超时必须落在熔断器的视野之内',
      'Treat slowness as failure: timeouts must be visible to the breaker'
    ),
    t(
      '论证三层保护的组合顺序，并说清顺序错了会漏掉什么',
      'Justify the ordering of the three protections and what breaks when it is wrong'
    ),
    t(
      '用「不依赖定时器的状态机」写出可测试的时间相关逻辑',
      'Write testable time-dependent logic as a state machine that needs no timers'
    ),
  ],
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
      '| 1 令牌桶 | 下游的速率 | 长期速率受控，突发可控 |',
      '| 2 熔断器 | 下游的恢复时间 | 打开后下游零打扰 |',
      '| 3 超时 + 组合 | 自己的**资源** | 超时预算严格生效 |',
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
      '- 不做舱壁隔离与降级返回，这些在第 3 关「延伸」里提到。',
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
      '| 1 Token bucket | the downstream rate | long-run rate bounded, bursts controlled |',
      '| 2 Circuit breaker | the downstream recovery time | zero downstream traffic while open |',
      '| 3 Timeout + composition | **your own** resources | timeout budget strictly enforced |',
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
  stages: [stage1, stage2, stage3],
};
