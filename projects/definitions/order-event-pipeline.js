/**
 * 工程实战 · 事件驱动的订单流水线
 *
 * 注意：代码片段使用 String.raw 模板，不要在片段里写 `${}`。
 */
const { t, code, file, readonlyFile, spec, gate } = require('./_helpers');

const contract = readonlyFile(
  'src/contract.ts',
  code`
    /** 平台提供的契约（只读） */

    export interface OrderEvent {
      /** 事件唯一 id，用于幂等 */
      id: string;
      type: string;
      payload: Record<string, unknown>;
      /** 事件产生时间（虚拟时钟） */
      at?: number;
    }

    export interface Context {
      event: OrderEvent;
      /** 中间件之间传递的数据 */
      state: Record<string, unknown>;
      /** 处理结果，最后一个中间件负责写入 */
      result?: unknown;
    }

    export type Next = () => Promise<void>;
    export type Middleware = (ctx: Context, next: Next) => Promise<void> | void;
  `
);

/* ------------------------------------------------------------------ */

const stage1 = {
  id: 'event-bus',
  title: t('第 1 关 · 事件总线', 'Stage 1 · Event bus'),
  goal: t(
    [
      '订单系统里，「下单成功」要同时触发库存扣减、积分发放、消息通知。',
      '现在的代码把三件事写在了下单函数里，每加一个下游就要改一次核心逻辑。',
      '',
      '在 `src/bus.ts` 实现 `createEventBus(options)`：',
      '',
      '- `on(type, handler)`：注册监听，返回取消订阅的函数；',
      '- `emit(type, payload)`：并行触发所有监听并等待它们全部结束；',
      '- 单个 handler 抛错不能影响其他 handler，`emit` 本身不 reject，错误交给 `options.onError`；',
      '- `listenerCount(type)`。',
      '',
      '串行的 `for (const h of handlers) await h()` 会让总延迟等于所有下游之和。',
      '通知服务慢 300ms，下单接口就跟着慢 300ms。互不依赖的副作用应该并行。',
    ].join('\n'),
    [
      'When an order is placed you must decrement stock, grant points and send a notification.',
      'Today all three are hard-coded into the checkout function, so every new consumer edits core logic.',
      '',
      'Implement `createEventBus(options)` in `src/bus.ts`:',
      '',
      '- `on(type, handler)`: subscribe, returning an unsubscribe function;',
      '- `emit(type, payload)`: fan out to all listeners in parallel and await them all;',
      '- one failing handler must not affect the others, `emit` never rejects, errors go to `options.onError`;',
      '- `listenerCount(type)`.',
      '',
      'A serial `for (const h of handlers) await h()` makes total latency the sum of every consumer.',
      'If notifications take 300ms, checkout takes 300ms longer. Independent side effects belong in parallel.',
    ].join('\n')
  ),
  checklist: [
    t('on 返回可用的取消订阅函数', 'on returns a working unsubscribe function'),
    t('emit 等待所有异步 handler 完成', 'emit awaits every async handler'),
    t('一个 handler 抛错不影响其他 handler', 'A throwing handler does not affect the others'),
    t('三个 50ms 的 handler 并行只花 50ms', 'Three 50ms handlers finish in 50ms together'),
  ],
  pitfalls: [
    t(
      '有人加了个发短信的监听，下单接口就跟着慢 300ms。原因是串行的 `for (const h of handlers) await h()` 让总延迟等于所有下游之和，扩展的代价全落在主流程上。',
      'Someone adds an SMS listener and checkout gets 300ms slower. A serial `for (const h of handlers) await h()` makes latency the sum of every consumer, so the cost of extending the system lands on the main flow.'
    ),
    t(
      '把 try/catch 包在 `Promise.all` 外面而不是每个 handler 外面：第一个失败者会让你看不到其他 handler 的结果，而且它们的失败被静默吞掉。',
      'Wrapping try/catch around `Promise.all` instead of each handler: the first rejection hides every other outcome and silently swallows their failures.'
    ),
    t(
      '某个 handler 在执行中调用了 `off()`，而你正遍历着原数组，于是有的监听被跳过、有的被触发两次。派发前先复制一份。',
      'A handler calls `off()` mid-dispatch while you are iterating the live array, so some listeners get skipped and others fire twice. Snapshot before dispatching.'
    ),
    t(
      '把错误直接 `console.error` 掉：本地看得见，线上看不见。错误要交给注入的 `onError`，让调用方决定是上报、降级还是告警。',
      'Just `console.error`-ing failures: visible locally, invisible in production. Hand them to the injected `onError` so the caller decides whether to report, degrade or alert.'
    ),
  ],
  hints: [
    t(
      '并行 + 错误隔离 = Promise.allSettled，或者给每个 handler 包一层 try/catch 再 Promise.all。',
      'Parallel plus isolation = Promise.allSettled, or wrap each handler in try/catch and Promise.all.'
    ),
    t(
      'emit 时先复制一份监听器数组，否则 handler 里调用 off 会改坏正在遍历的数组。',
      'Copy the listener array before emitting, otherwise a handler calling off() mutates the array you are iterating.'
    ),
  ],
  extension: t(
    [
      '这一关做的是**进程内**的事件总线。往真实系统走，会遇到三个必须回答的问题：',
      '',
      '1. 副作用真的能并行吗？ 能并行的前提是它们之间没有依赖。',
      '「扣库存」和「发通知」可以并行；但「扣库存」和「生成发货单」有先后关系，',
      '那它们就不该是两个平级的监听，而应该是一条有序的流水线（第 2 关的主题）。',
      '',
      '2. emit 之后如果进程挂了怎么办？ 进程内事件总线是**不持久**的：',
      '订单已经落库、但通知还没发出去，重启后这个事件就永远丢了。',
      '真实系统的解法是 transactional outbox：把事件和业务数据写在同一个事务里，',
      '再由一个独立的投递器去消费。',
      '',
      '3. 谁来兜底失败的 handler？ 本关交给 `onError`，但真实系统需要重试和死信，',
      '这正是第 3 关的内容。',
      '',
      'Node 自带的 `EventEmitter` 在这三点上都不管：它的 `emit` 是**同步**的，',
      '不 await 异步 handler，一个未捕获的 rejection 会直接让进程退出。',
      '所以业务系统里几乎没人直接用它做异步副作用。',
    ].join('\n'),
    [
      'This stage builds an in-process bus. Moving toward a real system raises three questions:',
      '',
      '1. Can these side effects really run in parallel? Only if they are independent.',
      '"Decrement stock" and "send notification" can; "decrement stock" and "create a shipment" are',
      'ordered, those should not be two sibling listeners but an ordered pipeline (stage 2).',
      '',
      '2. What if the process dies right after emit? An in-process bus is not durable:',
      'the order is committed but the notification never went out, and the event is gone forever.',
      'The production answer is the transactional outbox: write the event in the same transaction as',
      'the business data and let a separate dispatcher consume it.',
      '',
      '3. Who catches a failing handler? Here it is `onError`, but real systems need retries and a',
      'dead-letter queue, which is exactly stage 3.',
      '',
      "Node's built-in `EventEmitter` helps with none of this: `emit` is synchronous, it does not",
      'await async handlers, and an unhandled rejection takes the process down. Which is why almost',
      'nobody uses it directly for asynchronous side effects.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'encapsulation'],
  lab: {},
  starterFiles: [
    contract,
    file(
      'src/bus.ts',
      code`
        import type { OrderEvent } from './contract';

        export type EventHandler = (payload: Record<string, unknown>, event: OrderEvent) => Promise<void> | void;

        export interface EventBusOptions {
          /** handler 抛错时的兜底上报 */
          onError?: (error: unknown, type: string) => void;
        }

        export interface EventBus {
          on(type: string, handler: EventHandler): () => void;
          emit(type: string, payload: Record<string, unknown>): Promise<void>;
          listenerCount(type: string): number;
        }

        export function createEventBus(options: EventBusOptions = {}): EventBus {
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
        import { createEventBus } from '../src/bus';
        import { sleep, now } from '@lab/env';

        describe('阶段1 · 事件总线', () => {
          it('所有监听都会收到事件', async () => {
            const bus = createEventBus();
            const seen: string[] = [];
            bus.on('order.created', (payload) => {
              seen.push('stock:' + payload.orderId);
            });
            bus.on('order.created', (payload) => {
              seen.push('points:' + payload.orderId);
            });

            await bus.emit('order.created', { orderId: 'A1' });

            expect(seen).toHaveLength(2);
            expect(seen).toContain('stock:A1');
            expect(seen).toContain('points:A1');
            expect(bus.listenerCount('order.created')).toBe(2);
          });

          it('取消订阅之后不再收到事件', async () => {
            const bus = createEventBus();
            let calls = 0;
            const off = bus.on('order.paid', () => {
              calls += 1;
            });

            await bus.emit('order.paid', {});
            off();
            await bus.emit('order.paid', {});

            expect(calls).toBe(1);
            expect(bus.listenerCount('order.paid')).toBe(0);
          });

          it('emit 会等待异步 handler 完成', async () => {
            const bus = createEventBus();
            let done = false;
            bus.on('order.created', async () => {
              await sleep(30);
              done = true;
            });

            await bus.emit('order.created', {});
            expect(done).toBe(true);
          });

          it('一个 handler 抛错不影响其他 handler', async () => {
            const errors: unknown[] = [];
            const bus = createEventBus({ onError: (error) => errors.push(error) });
            let survived = false;

            bus.on('order.created', async () => {
              throw new Error('notification service down');
            });
            bus.on('order.created', async () => {
              await sleep(10);
              survived = true;
            });

            await bus.emit('order.created', {});

            expect(survived).toBe(true);
            expect(errors).toHaveLength(1);
          });

          it('互不依赖的 handler 并行执行 [gate:latency]', async () => {
            const bus = createEventBus();
            const startedAt = now();
            for (let index = 0; index < 3; index += 1) {
              bus.on('order.created', async () => {
                await sleep(50);
              });
            }

            await bus.emit('order.created', {});
            expect(now() - startedAt).toBe(50);
          });

          it('没有监听的事件不会炸', async () => {
            const bus = createEventBus();
            await bus.emit('nobody.listens', { a: 1 });
            expect(bus.listenerCount('nobody.listens')).toBe(0);
          });

          it('不同事件类型互不串台', async () => {
            const bus = createEventBus();
            const seen: string[] = [];
            bus.on('order.created', () => seen.push('created'));
            bus.on('order.paid', () => seen.push('paid'));

            await bus.emit('order.paid', {});
            expect(seen).toEqual(['paid']);
          });

          it('同一个函数注册两次会被调用两次，取消一次只减一个', async () => {
            const bus = createEventBus();
            let calls = 0;
            const handler = () => {
              calls += 1;
            };

            const off = bus.on('order.created', handler);
            bus.on('order.created', handler);
            expect(bus.listenerCount('order.created')).toBe(2);

            off();
            expect(bus.listenerCount('order.created')).toBe(1);

            await bus.emit('order.created', {});
            expect(calls).toBe(1);
          });

          it('handler 里取消订阅不会打乱本次派发', async () => {
            const bus = createEventBus();
            const seen: string[] = [];
            let off2: (() => void) | null = null;

            bus.on('order.created', () => {
              seen.push('first');
              // 在派发过程中移除后面的监听：本次派发仍然应该完整
              off2?.();
            });
            off2 = bus.on('order.created', () => {
              seen.push('second');
            });

            await bus.emit('order.created', {});
            expect(seen).toEqual(['first', 'second']);
            expect(bus.listenerCount('order.created')).toBe(1);
          });

          it('全部 handler 都抛错时 emit 依然 resolve', async () => {
            const errors: unknown[] = [];
            const bus = createEventBus({ onError: (error) => errors.push(error) });
            bus.on('order.created', () => {
              throw new Error('a');
            });
            bus.on('order.created', async () => {
              throw new Error('b');
            });

            await bus.emit('order.created', {});
            expect(errors).toHaveLength(2);
          });

          it('同步 handler 抛错也会被隔离', async () => {
            const errors: unknown[] = [];
            const bus = createEventBus({ onError: (error) => errors.push(error) });
            let survived = false;

            bus.on('order.created', () => {
              throw new Error('sync boom');
            });
            bus.on('order.created', () => {
              survived = true;
            });

            await bus.emit('order.created', {});
            expect(survived).toBe(true);
            expect(errors).toHaveLength(1);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 50,
      unit: 'ms',
      zh: '三个 50ms 的下游并行完成',
      en: 'Three 50ms consumers run in parallel',
      dimension: 'latency',
      scope: 'gate:latency',
    }),
  ],
  referenceFiles: [
    file(
      'src/bus.ts',
      code`
        import type { OrderEvent } from './contract';

        export type EventHandler = (payload: Record<string, unknown>, event: OrderEvent) => Promise<void> | void;

        export interface EventBusOptions {
          onError?: (error: unknown, type: string) => void;
        }

        export interface EventBus {
          on(type: string, handler: EventHandler): () => void;
          emit(type: string, payload: Record<string, unknown>): Promise<void>;
          listenerCount(type: string): number;
        }

        export function createEventBus(options: EventBusOptions = {}): EventBus {
          const listeners = new Map<string, EventHandler[]>();

          return {
            on(type, handler) {
              const handlers = listeners.get(type) || [];
              handlers.push(handler);
              listeners.set(type, handlers);

              return () => {
                const current = listeners.get(type);
                if (!current) return;
                const index = current.indexOf(handler);
                if (index >= 0) current.splice(index, 1);
              };
            },

            async emit(type, payload) {
              // 先快照，避免 handler 内部 off() 改坏正在遍历的数组
              const handlers = [...(listeners.get(type) || [])];
              const event: OrderEvent = { id: type + ':' + Date.now(), type, payload };

              await Promise.all(
                handlers.map(async (handler) => {
                  try {
                    await handler(payload, event);
                  } catch (error) {
                    options.onError?.(error, type);
                  }
                })
              );
            },

            listenerCount(type) {
              return (listeners.get(type) || []).length;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    '错误隔离放在「每个 handler 外面」而不是「整个 Promise.all 外面」，是这一关的关键：前者只损失一个下游，后者会让第一个失败者吞掉其余结果。',
    'Wrapping each handler rather than the whole Promise.all is the point: the former loses one consumer, the latter lets the first failure swallow every other result.'
  ),
};

/* ------------------------------------------------------------------ */

const stage2 = {
  id: 'middleware',
  title: t('第 2 关 · 洋葱式中间件', 'Stage 2 · Onion middleware'),
  goal: t(
    [
      '每个订单事件都要经过：日志 → 鉴权 → 限流 → 业务处理。',
      '这些横切关注点不该塞进业务函数，而应该组合起来。',
      '',
      '在 `src/compose.ts` 实现 Koa 风格的 `compose(middlewares)`：',
      '',
      '- 返回 `(ctx, next?) => Promise<void>`；',
      '- `await next()` 之后的代码在「回程」执行（洋葱模型）；',
      '- 中间件不调用 `next()` 就短路后续；',
      '- 同一个中间件里 `next()` 被调用两次要抛错，这是最常见的中间件 bug。',
      '',
      'compose 本身不到 20 行，但系统之后往哪个方向扩展，基本由它定。',
    ].join('\n'),
    [
      'Every order event flows through logging → auth → rate limiting → business logic.',
      'These cross-cutting concerns do not belong inside the business function; they should compose.',
      '',
      'Implement Koa-style `compose(middlewares)` in `src/compose.ts`:',
      '',
      '- returns `(ctx, next?) => Promise<void>`;',
      '- code after `await next()` runs on the way back out (the onion model);',
      '- a middleware that never calls `next()` short-circuits the rest;',
      '- calling `next()` twice inside one middleware must throw, the classic middleware bug.',
      '',
      'compose is under 20 lines, but it decides how the whole system extends from here.',
    ].join('\n')
  ),
  checklist: [
    t('洋葱顺序：进入按序、返回逆序', 'Onion order: in forwards, out backwards'),
    t('不调用 next 会短路', 'Skipping next short-circuits'),
    t('中间件抛错会向上传播', 'Errors propagate to the caller'),
    t('重复调用 next 抛错', 'Calling next twice throws'),
  ],
  pitfalls: [
    t(
      '计时中间件报出 0ms，try/catch 也抓不到下游的错误。这通常是 `await next()` 写成了 `next()`，回程的代码在下游还没跑完时就执行了。',
      'A timing middleware reports 0ms and your try/catch never sees downstream errors. That usually means `await next()` was written as `next()`, so the code after it ran before downstream finished.'
    ),
    t(
      '用 `reduce` 把中间件反向包一层：能写得很短，但很难同时处理「异步」「短路」「重复 next」三件事，出错时的调用栈也几乎不可读。',
      'Folding middleware with `reduce` is compact but struggles to handle async, short-circuit and double-next together, and produces an unreadable stack trace.'
    ),
    t(
      '同一个中间件里 `next()` 被调了两次，下游就跑两遍。如果下游是扣库存，那就是扣两次，而这类 bug 在测试里极难复现，所以要在实现里主动检测。',
      'Call `next()` twice in one middleware and the downstream runs twice. If that downstream decrements stock, you just charged twice, and this class of bug almost never reproduces in tests. Detect it.'
    ),
    t(
      '在中间件里 `catch` 掉所有错误却不重新抛出：上层的重试和死信逻辑再也看不到失败，事件会被静默丢弃。',
      'Catching every error inside a middleware without rethrowing hides failures from the retry and dead-letter logic upstream, events get silently dropped.'
    ),
  ],
  hints: [
    t(
      '经典实现：递归函数 dispatch(i)，用一个 index 变量记录「已经进到第几层」来检测重复调用。',
      'Classic shape: a recursive dispatch(i) plus an index watermark to detect a double next().'
    ),
  ],
  extension: t(
    [
      '洋葱模型不是 Koa 发明的，但 `koa-compose` 是最干净的一份实现，总共不到 30 行，',
      '值得对照着读一遍。同一个思路在很多地方出现过：',
      '',
      '| 生态 | 对应物 | 区别 |',
      '| --- | --- | --- |',
      '| Koa | `koa-compose` | 本关的原型 |',
      '| Express | `next(err)` | 错误要显式传给 next，不是 throw |',
      '| Redux | `applyMiddleware` | 同构，但是同步的 |',
      '| gRPC | interceptor | 同构 |',
      '| ASP.NET | `IApplicationBuilder.Use` | 同构 |',
      '',
      '洋葱模型 vs 责任链：责任链是「谁能处理谁处理，处理完就结束」，',
      '洋葱模型是「每一层都能在进入和返回时各做一次事」。前者适合路由分发，',
      '后者适合横切关注点（计时、日志、事务、鉴权），因为这些事天然需要',
      '「前后各来一下」。',
      '',
      '值得注意的是：`await next()` 之后的代码运行在**下游全部完成之后**，',
      '所以「记录耗时」「提交事务」「清理上下文」这类操作放在那里是最自然的。',
      '这也是为什么中间件顺序很重要，它决定了嵌套关系，而不只是执行顺序。',
    ].join('\n'),
    [
      'Koa did not invent the onion model, but `koa-compose` is its cleanest implementation, under 30',
      'lines, and worth reading side by side with yours. The same idea shows up everywhere:',
      '',
      '| Ecosystem | Counterpart | Difference |',
      '| --- | --- | --- |',
      '| Koa | `koa-compose` | the model for this stage |',
      '| Express | `next(err)` | errors are passed to next, not thrown |',
      '| Redux | `applyMiddleware` | same shape, synchronous |',
      '| gRPC | interceptors | same shape |',
      '| ASP.NET | `IApplicationBuilder.Use` | same shape |',
      '',
      'Onion vs chain of responsibility: a chain asks "who can handle this?" and stops at the first',
      'handler. The onion lets every layer act both on the way in and on the way out. The first suits',
      'routing; the second suits cross-cutting concerns (timing, logging, transactions, auth), which',
      'inherently need to do something before *and* after.',
      '',
      'Note that code after `await next()` runs once the entire downstream has finished, which is why',
      '"record duration", "commit transaction" and "clean up context" belong there. It is also why',
      'middleware order matters: it defines nesting, not merely sequence.',
    ].join('\n')
  ),
  focus: ['elegance', 'encapsulation', 'correctness'],
  lab: {},
  starterFiles: [
    file(
      'src/compose.ts',
      code`
        import type { Context, Middleware, Next } from './contract';

        /**
         * 把中间件数组组合成一个函数。
         * 语义与 koa-compose 一致。
         */
        export function compose(middlewares: Middleware[]): (ctx: Context, next?: Next) => Promise<void> {
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
        import { compose } from '../src/compose';
        import { sleep } from '@lab/env';

        function createContext() {
          return { event: { id: 'e1', type: 'order.created', payload: {} }, state: {} } as any;
        }

        describe('阶段2 · 洋葱式中间件', () => {
          it('按洋葱顺序执行', async () => {
            const trace: string[] = [];
            const run = compose([
              async (ctx, next) => {
                trace.push('a:in');
                await next();
                trace.push('a:out');
              },
              async (ctx, next) => {
                trace.push('b:in');
                await next();
                trace.push('b:out');
              },
              async () => {
                trace.push('handler');
              },
            ]);

            await run(createContext());
            expect(trace).toEqual(['a:in', 'b:in', 'handler', 'b:out', 'a:out']);
          });

          it('异步中间件被正确 await', async () => {
            const trace: string[] = [];
            const run = compose([
              async (ctx, next) => {
                await sleep(20);
                trace.push('a');
                await next();
                trace.push('a-out');
              },
              async () => {
                await sleep(10);
                trace.push('b');
              },
            ]);

            await run(createContext());
            expect(trace).toEqual(['a', 'b', 'a-out']);
          });

          it('不调用 next 会短路后续中间件', async () => {
            let reached = false;
            const run = compose([
              async (ctx) => {
                ctx.state.blocked = true;
              },
              async () => {
                reached = true;
              },
            ]);

            const ctx = createContext();
            await run(ctx);
            expect(reached).toBe(false);
            expect(ctx.state.blocked).toBe(true);
          });

          it('中间件抛错会传播给调用方', async () => {
            const run = compose([
              async (ctx, next) => {
                await next();
              },
              async () => {
                throw new Error('auth failed');
              },
            ]);

            await expect(async () => run(createContext())).rejects.toThrow('auth failed');
          });

          it('重复调用 next 会抛错', async () => {
            const run = compose([
              async (ctx, next) => {
                await next();
                await next();
              },
              async () => {
                // no-op
              },
            ]);

            await expect(async () => run(createContext())).rejects.toThrow();
          });

          it('空中间件数组也能安全运行', async () => {
            const run = compose([]);
            await run(createContext());
            expect(true).toBe(true);
          });

          it('中间件之间通过 ctx.state 传值', async () => {
            const run = compose([
              async (ctx, next) => {
                ctx.state.user = 'alice';
                await next();
              },
              async (ctx) => {
                ctx.result = 'handled by ' + ctx.state.user;
              },
            ]);

            const ctx = createContext();
            await run(ctx);
            expect(ctx.result).toBe('handled by alice');
          });

          it('回程阶段抛出的错误同样会传播', async () => {
            const run = compose([
              async (ctx, next) => {
                await next();
                throw new Error('failed on the way out');
              },
              async (ctx) => {
                ctx.result = 'inner done';
              },
            ]);

            const ctx = createContext();
            await expect(async () => run(ctx)).rejects.toThrow('failed on the way out');
            // 下游确实先跑完了
            expect(ctx.result).toBe('inner done');
          });

          it('中间件可以捕获下游错误做降级', async () => {
            const run = compose([
              async (ctx, next) => {
                try {
                  await next();
                } catch (error) {
                  ctx.state.degraded = true;
                  ctx.result = 'fallback';
                }
              },
              async () => {
                throw new Error('downstream exploded');
              },
            ]);

            const ctx = createContext();
            await run(ctx);
            expect(ctx.state.degraded).toBe(true);
            expect(ctx.result).toBe('fallback');
          });

          it('最内层的 next 会调用 compose 的第二个参数', async () => {
            let reachedOuter = false;
            const run = compose([
              async (ctx, next) => {
                await next();
              },
            ]);

            await run(createContext(), async () => {
              reachedOuter = true;
            });
            expect(reachedOuter).toBe(true);
          });

          it('同步中间件也能正常组合', async () => {
            const trace: string[] = [];
            const run = compose([
              (ctx, next) => {
                trace.push('sync-in');
                return next();
              },
              (ctx) => {
                trace.push('sync-handler');
              },
            ]);

            await run(createContext());
            expect(trace).toEqual(['sync-in', 'sync-handler']);
          });

          it('组合出来的函数可以复用，多次调用互不影响', async () => {
            const run = compose([
              async (ctx, next) => {
                ctx.state.count = 1;
                await next();
              },
              async (ctx) => {
                ctx.result = ctx.state.count;
              },
            ]);

            const first = createContext();
            const second = createContext();
            await run(first);
            await run(second);

            expect(first.result).toBe(1);
            expect(second.result).toBe(1);
          });
        });
      `
    ),
  ],
  gates: [],
  referenceFiles: [
    file(
      'src/compose.ts',
      code`
        import type { Context, Middleware, Next } from './contract';

        export function compose(middlewares: Middleware[]): (ctx: Context, next?: Next) => Promise<void> {
          return function run(ctx: Context, next?: Next): Promise<void> {
            // index 是「已经进入过的最深层数」，用来发现同一层被 next 两次
            let index = -1;

            function dispatch(current: number): Promise<void> {
              if (current <= index) {
                return Promise.reject(new Error('next() called multiple times'));
              }
              index = current;

              const middleware = current === middlewares.length ? next : middlewares[current];
              if (!middleware) return Promise.resolve();

              try {
                return Promise.resolve(
                  middleware(ctx, () => dispatch(current + 1))
                );
              } catch (error) {
                return Promise.reject(error);
              }
            }

            return dispatch(0);
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    'dispatch 里的 index 水位线是整个实现的灵魂：它把「中间件契约」变成了可检测的运行时不变量。',
    'The index watermark inside dispatch is the whole trick: it turns the middleware contract into a runtime invariant you can detect.'
  ),
};

/* ------------------------------------------------------------------ */

const stage3 = {
  id: 'idempotency',
  title: t('第 3 关 · 幂等与死信队列', 'Stage 3 · Idempotency and dead letters'),
  goal: t(
    [
      '消息队列只保证 at-least-once：同一个事件会重复投递。',
      '如果扣库存被执行两次，就是真实的资损。',
      '',
      '在 `src/processor.ts` 实现 `createOrderProcessor(options)`：',
      '',
      '- `process(event)`：用第 2 关的 `compose` 跑一遍中间件链；',
      '- 幂等：同一个 `event.id` 重复投递时直接返回上次结果，不再执行中间件；',
      '- 重试：处理失败时最多重试 `maxAttempts - 1` 次；',
      '- 死信：仍然失败的事件进入死信队列，`deadLetters()` 可以取出，且不影响后续事件；',
      '- 用 `@lab/metrics` 的 `count()` 打点 `order.processed` / `order.deadLettered`。',
      '',
      '幂等键必须在副作用之前生效。事后补偿是另一件难得多的事，通常也补不干净。',
    ].join('\n'),
    [
      'Message queues only guarantee at-least-once: the same event will be delivered twice.',
      'Decrementing stock twice is real money lost.',
      '',
      'Implement `createOrderProcessor(options)` in `src/processor.ts`:',
      '',
      '- `process(event)`: run the middleware chain from stage 2;',
      '- idempotency: a repeated `event.id` returns the previous result without running middleware again;',
      '- retries: retry a failing event up to `maxAttempts - 1` times;',
      '- dead letters: events that still fail land in a dead-letter queue readable via `deadLetters()`, without affecting later events;',
      '- emit `order.processed` / `order.deadLettered` through `count()` from `@lab/metrics`.',
      '',
      'The idempotency key has to engage before the side effect. Compensating afterwards is a much harder job, and it rarely cleans up everything.',
    ].join('\n')
  ),
  checklist: [
    t('重复 id 只执行一次中间件链', 'A repeated id runs the chain once'),
    t('失败事件按 maxAttempts 重试', 'Failures retry up to maxAttempts'),
    t('彻底失败的事件进死信队列', 'Permanently failing events go to the DLQ'),
    t('死信不影响后续事件处理', 'Dead letters do not block later events'),
  ],
  pitfalls: [
    t(
      '先扣库存、再记录「处理过了」，这等于没做幂等。检查要在任何副作用之前，登记要在成功之后。',
      'Decrementing stock and then recording "done" is not idempotency at all. Check before any side effect; record only after success.'
    ),
    t(
      '把失败也写进幂等表：一次临时故障会让这个事件永远不再被处理，即使上游重投也无效。只有成功才登记。',
      'Recording failures in the idempotency table means one transient error blocks that event forever, even on redelivery. Only successes get recorded.'
    ),
    t(
      '把重试写进中间件：重试是投递语义，属于处理器；中间件应该只关心业务。混在一起后，每加一个中间件都可能悄悄改变重试次数。',
      'Putting retries inside middleware conflates delivery semantics with business logic. Once mixed, every new middleware can silently change the retry count.'
    ),
    t(
      '每次重试复用同一个 ctx：上一次失败留下的 `state` 会污染下一次尝试，导致「重试第二次才成功」这种难以复现的现象。',
      'Reusing one ctx across retries lets state from the failed attempt leak into the next, producing the classic "only works on the second retry" mystery.'
    ),
    t(
      '`deadLetters()` 把内部数组原样交出去，调用方随手一个 `splice` 就能清空你的死信。返回副本。',
      '`deadLetters()` handing out the internal array lets any caller `splice` your dead letters away. Return a copy.'
    ),
  ],
  hints: [
    t(
      '幂等表存 Map<eventId, result>，在跑中间件之前查；成功后才写入。',
      'Keep a Map<eventId, result>, check before running middleware, write only on success.'
    ),
    t(
      '不要把重试写在中间件里，重试是处理器的职责，中间件应该保持「只做一件事」。',
      'Do not put retries inside a middleware: retrying is the processor\'s job; middleware should do one thing.'
    ),
  ],
  extension: t(
    [
      '### 为什么没有 exactly-once',
      '',
      '消息队列常被宣传成「精确一次」，但严格意义上的 exactly-once **投递**是不可能的：',
      '网络会超时，而超时的一方无法区分「对方没收到」和「对方收到了但回复丢了」。',
      '工程上真正做到的是 at-least-once 投递 + 幂等消费 = 效果上的 exactly-once。',
      '这一关做的就是后半句。',
      '',
      '### 幂等键怎么选',
      '',
      '- 用**业务字段组合**（用户 id + 商品 id）：看起来自然，但用户可能真的下两单同样的东西；',
      '- 用生产者生成的唯一 id：最可靠，Stripe 的 `Idempotency-Key` 就是让客户端自己生成；',
      '- 用消息队列的 message id：注意重投递时 id 是否会变。',
      '',
      '### 本关实现的已知局限',
      '',
      '参考实现的幂等表是「先查后写」，中间隔着一次 `await`。',
      '如果同一个 id 被并发投递两次，两次都会查到「没处理过」，于是执行两次。',
      '真实系统的解法有两种：',
      '',
      '1. 把「占位」和「执行」合并成一个原子操作（数据库唯一索引、Redis `SET NX`）；',
      '2. 复用第一个项目学过的**单飞**：同一个 id 的并发处理共享一次执行。',
      '',
      '这不是这一关的验收内容，但值得你想一想自己的实现会怎么表现。',
      '',
      '### 死信之后呢',
      '',
      '死信队列需要有人真的去看。成熟系统会给它配上告警、重放工具和保留期；',
      '没人看的死信队列，效果和直接 `catch {}` 差不多。',
    ].join('\n'),
    [
      '### Why there is no exactly-once',
      '',
      'Queues are often marketed as "exactly once", but exactly-once *delivery* is impossible:',
      'networks time out, and the sender cannot distinguish "not received" from "received but the ack',
      'was lost". What engineering actually achieves is **at-least-once delivery + idempotent',
      'consumption = effectively exactly once**. This stage builds the second half.',
      '',
      '### Choosing an idempotency key',
      '',
      '- Business fields (user id + product id) feel natural, but a user may genuinely order the same thing twice;',
      '- A producer-generated unique id is the reliable choice, Stripe\'s `Idempotency-Key` is client-generated for exactly this reason;',
      '- The queue message id works if you check whether redelivery preserves it.',
      '',
      '### A known limitation of this stage',
      '',
      'The reference implementation checks the table, then awaits, then writes. If the **same id is',
      'delivered concurrently**, both checks see "unprocessed" and the work runs twice. Production',
      'solutions:',
      '',
      '1. Make claim-and-execute atomic (a unique index, or Redis `SET NX`);',
      '2. Reuse single-flight from the first project: concurrent processing of one id shares a run.',
      '',
      'Not part of this stage\'s gates, but worth reasoning about how your implementation behaves.',
      '',
      '### After the dead letter',
      '',
      'Someone has to actually watch the DLQ. Mature systems give it alerts, a replay tool and a',
      'retention policy. An unwatched one works out about the same as `catch {}`.',
    ].join('\n')
  ),
  focus: ['resilience', 'encapsulation', 'correctness'],
  lab: {},
  starterFiles: [
    file(
      'src/processor.ts',
      code`
        import type { Context, Middleware, OrderEvent } from './contract';

        export interface ProcessorOptions {
          middlewares: Middleware[];
          /** 最多尝试几次（含第一次），默认 1 */
          maxAttempts?: number;
        }

        export interface ProcessOutcome {
          ok: boolean;
          /** 是否命中幂等表（没有真正执行） */
          deduplicated: boolean;
          result?: unknown;
          error?: string;
          attempts: number;
        }

        export interface OrderProcessor {
          process(event: OrderEvent): Promise<ProcessOutcome>;
          deadLetters(): OrderEvent[];
        }

        export function createOrderProcessor(options: ProcessorOptions): OrderProcessor {
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
        import { createOrderProcessor } from '../src/processor';
        import { getCounters } from '@lab/metrics';
        import { sleep } from '@lab/env';

        function event(id: string, type = 'order.created') {
          return { id, type, payload: { orderId: id } };
        }

        describe('阶段3 · 幂等与死信', () => {
          it('正常事件跑完中间件链', async () => {
            const trace: string[] = [];
            const processor = createOrderProcessor({
              middlewares: [
                async (ctx, next) => {
                  trace.push('audit');
                  await next();
                },
                async (ctx) => {
                  trace.push('handle');
                  ctx.result = { charged: true };
                },
              ],
            });

            const outcome = await processor.process(event('E1'));
            expect(outcome.ok).toBe(true);
            expect(outcome.deduplicated).toBe(false);
            expect(outcome.result).toEqual({ charged: true });
            expect(trace).toEqual(['audit', 'handle']);
          });

          it('相同 id 的重复投递只执行一次 [gate:idempotent]', async () => {
            let sideEffects = 0;
            const processor = createOrderProcessor({
              middlewares: [
                async (ctx) => {
                  sideEffects += 1;
                  await sleep(10);
                  ctx.result = { stock: 'decremented' };
                },
              ],
            });

            const first = await processor.process(event('E2'));
            const second = await processor.process(event('E2'));

            expect(sideEffects).toBe(1);
            expect(first.deduplicated).toBe(false);
            expect(second.deduplicated).toBe(true);
            expect(second.result).toEqual({ stock: 'decremented' });
            expect(getCounters()['order.processed']).toBe(1);
          });

          it('失败的事件会重试到 maxAttempts', async () => {
            let attempts = 0;
            const processor = createOrderProcessor({
              maxAttempts: 3,
              middlewares: [
                async (ctx) => {
                  attempts += 1;
                  if (attempts < 3) throw new Error('temporary failure');
                  ctx.result = 'recovered';
                },
              ],
            });

            const outcome = await processor.process(event('E3'));
            expect(outcome.ok).toBe(true);
            expect(outcome.attempts).toBe(3);
            expect(processor.deadLetters()).toHaveLength(0);
          });

          it('彻底失败的事件进入死信队列 [gate:dlq]', async () => {
            const processor = createOrderProcessor({
              maxAttempts: 2,
              middlewares: [
                async () => {
                  throw new Error('poison message');
                },
              ],
            });

            const outcome = await processor.process(event('E4'));
            expect(outcome.ok).toBe(false);
            expect(outcome.attempts).toBe(2);
            expect(outcome.error).toContain('poison message');

            const dead = processor.deadLetters();
            expect(dead).toHaveLength(1);
            expect(dead[0].id).toBe('E4');
            expect(getCounters()['order.deadLettered']).toBe(1);
          });

          it('死信不会挡住后面的事件', async () => {
            const processor = createOrderProcessor({
              maxAttempts: 1,
              middlewares: [
                async (ctx) => {
                  if (ctx.event.id === 'BAD') throw new Error('poison');
                  ctx.result = 'ok';
                },
              ],
            });

            await processor.process(event('BAD'));
            const outcome = await processor.process(event('GOOD'));

            expect(outcome.ok).toBe(true);
            expect(processor.deadLetters().map((item) => item.id)).toEqual(['BAD']);
          });

          it('失败的事件不会写进幂等表，重投时会再次尝试', async () => {
            let attempts = 0;
            const processor = createOrderProcessor({
              maxAttempts: 1,
              middlewares: [
                async (ctx) => {
                  attempts += 1;
                  // 第一次投递失败，第二次投递应该真的重跑
                  if (attempts === 1) throw new Error('transient');
                  ctx.result = 'recovered';
                },
              ],
            });

            const first = await processor.process(event('E5'));
            expect(first.ok).toBe(false);

            const second = await processor.process(event('E5'));
            expect(second.ok).toBe(true);
            expect(second.deduplicated).toBe(false);
            expect(attempts).toBe(2);
          });

          it('每次重试都用全新的 ctx，不带上一次的脏数据', async () => {
            const seen: unknown[] = [];
            const processor = createOrderProcessor({
              maxAttempts: 3,
              middlewares: [
                async (ctx) => {
                  seen.push(ctx.state.marker);
                  ctx.state.marker = 'dirty';
                  if (seen.length < 3) throw new Error('again');
                  ctx.result = 'done';
                },
              ],
            });

            await processor.process(event('E6'));
            expect(seen).toEqual([undefined, undefined, undefined]);
          });

          it('maxAttempts 默认只尝试一次', async () => {
            let attempts = 0;
            const processor = createOrderProcessor({
              middlewares: [
                async () => {
                  attempts += 1;
                  throw new Error('boom');
                },
              ],
            });

            const outcome = await processor.process(event('E7'));
            expect(attempts).toBe(1);
            expect(outcome.attempts).toBe(1);
            expect(outcome.ok).toBe(false);
          });

          it('deadLetters 返回副本，外部改不动内部队列', async () => {
            const processor = createOrderProcessor({
              maxAttempts: 1,
              middlewares: [
                async () => {
                  throw new Error('poison');
                },
              ],
            });

            await processor.process(event('E8'));
            const dead = processor.deadLetters();
            dead.length = 0;

            expect(processor.deadLetters()).toHaveLength(1);
          });

          it('幂等命中时不会重复打点', async () => {
            const processor = createOrderProcessor({
              middlewares: [
                async (ctx) => {
                  ctx.result = 'ok';
                },
              ],
            });

            await processor.process(event('E9'));
            await processor.process(event('E9'));
            await processor.process(event('E9'));

            expect(getCounters()['order.processed']).toBe(1);
          });

          it('中间件链为空时事件也算处理成功', async () => {
            const processor = createOrderProcessor({ middlewares: [] });
            const outcome = await processor.process(event('E10'));
            expect(outcome.ok).toBe(true);
            expect(outcome.result).toBeUndefined();
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.order.processed',
      op: 'lte',
      value: 1,
      zh: '重复投递只产生一次副作用',
      en: 'Duplicate delivery causes one side effect',
      dimension: 'resilience',
      scope: 'gate:idempotent',
    }),
    gate({
      metric: 'counters.order.deadLettered',
      op: 'gte',
      value: 1,
      zh: '毒消息进入死信队列',
      en: 'Poison messages reach the DLQ',
      dimension: 'resilience',
      scope: 'gate:dlq',
    }),
  ],
  referenceFiles: [
    file(
      'src/processor.ts',
      code`
        import { count } from '@lab/metrics';
        import { compose } from './compose';
        import type { Context, Middleware, OrderEvent } from './contract';

        export interface ProcessorOptions {
          middlewares: Middleware[];
          maxAttempts?: number;
        }

        export interface ProcessOutcome {
          ok: boolean;
          deduplicated: boolean;
          result?: unknown;
          error?: string;
          attempts: number;
        }

        export interface OrderProcessor {
          process(event: OrderEvent): Promise<ProcessOutcome>;
          deadLetters(): OrderEvent[];
        }

        export function createOrderProcessor(options: ProcessorOptions): OrderProcessor {
          const run = compose(options.middlewares);
          const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
          const processed = new Map<string, unknown>();
          const dead: OrderEvent[] = [];

          return {
            async process(event: OrderEvent): Promise<ProcessOutcome> {
              // 幂等检查必须在任何副作用之前
              if (processed.has(event.id)) {
                return {
                  ok: true,
                  deduplicated: true,
                  result: processed.get(event.id),
                  attempts: 0,
                };
              }

              let lastError: unknown;

              for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                const ctx: Context = { event, state: {} };
                try {
                  await run(ctx);
                  processed.set(event.id, ctx.result);
                  count('order.processed');
                  return { ok: true, deduplicated: false, result: ctx.result, attempts: attempt };
                } catch (error) {
                  lastError = error;
                }
              }

              dead.push(event);
              count('order.deadLettered');
              return {
                ok: false,
                deduplicated: false,
                error: (lastError as Error).message,
                attempts: maxAttempts,
              };
            },

            deadLetters() {
              return [...dead];
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    '处理器只负责「投递语义」（幂等、重试、死信），中间件只负责业务。两者的职责一旦混在一起，任何一个下游的重试策略都会污染全局。',
    'The processor owns delivery semantics (idempotency, retry, DLQ); middleware owns business logic. Mix them and one consumer\'s retry policy pollutes everything.'
  ),
};

module.exports = {
  id: 'order-event-pipeline',
  title: t('事件驱动的订单流水线', 'Event-driven order pipeline'),
  summary: t(
    '用事件总线解耦下单副作用，用洋葱中间件组织横切关注点，再用幂等与死信队列扛住 at-least-once 投递。',
    'Decouple checkout side effects with an event bus, organise cross-cutting concerns with onion middleware, then survive at-least-once delivery with idempotency and a DLQ.'
  ),
  difficulty: 'Medium',
  domain: 'architecture',
  tags: ['event-driven', 'middleware', 'idempotency', 'api-design'],
  estimatedMinutes: 90,
  language: 'typescript',
  weights: {
    correctness: 3,
    concurrency: 0.5,
    latency: 1,
    resilience: 2,
    encapsulation: 2.5,
    elegance: 2,
  },
  prerequisites: [
    t('async / await 与 Promise 的基本用法', 'async/await and Promise basics'),
    t('用过任意一种中间件（Express/Koa/Redux 都行）会更容易上手', 'Having used any middleware system (Express/Koa/Redux) helps'),
  ],
  learningOutcomes: [
    t(
      '用事件总线把副作用从主流程里摘出去，并知道什么时候**不该**这么做',
      'Lift side effects out of the main flow with an event bus, and know when not to'
    ),
    t(
      '手写一个正确的洋葱中间件 compose，包括短路、错误传播和重复 next 检测',
      'Write a correct onion compose, including short-circuit, error propagation and double-next detection'
    ),
    t(
      '说清 at-least-once 为什么无法避免，以及幂等消费如何把它变成「效果上的 exactly-once」',
      'Explain why at-least-once is unavoidable and how idempotent consumption yields effective exactly-once'
    ),
    t(
      '区分「投递语义」（重试、幂等、死信）和「业务逻辑」，并让它们各自独立演进',
      'Separate delivery semantics (retry, idempotency, DLQ) from business logic so each evolves alone'
    ),
    t(
      '识别错误隔离的边界该放在哪一层，包整体还是包每一个',
      'Place the error-isolation boundary correctly: around the whole batch, or around each item'
    ),
  ],
  brief: t(
    [
      '## 背景',
      '',
      '一个电商的下单接口已经膨胀成 400 行。翻开来看，里面挤着六件互不相干的事：',
      '',
      '```ts',
      'async function checkout(order) {',
      '  await auth(order);              // 鉴权',
      '  await rateLimit(order.userId);  // 限流',
      '  await audit(order);             // 审计日志',
      '  await createOrder(order);       // 真正的业务',
      '  await decrementStock(order);    // 副作用 1',
      '  await grantPoints(order);       // 副作用 2',
      '  await notify(order);            // 副作用 3  ← 加个短信通知就要动这个函数',
      '}',
      '```',
      '',
      '两个直接后果：',
      '',
      '1. 每加一个下游都要改核心逻辑，回归测试要跑整条链路；',
      '2. 总延迟是所有下游之和。通知服务抖一下，下单接口就跟着慢。',
      '',
      '更麻烦的是上游消息队列只保证 at-least-once，同一个事件会被投递多次。',
      '上周就出过一次事故：一条消息被重投，库存被扣了两次。',
      '',
      '## 目标',
      '',
      '三关重构出一套事件驱动的处理骨架：',
      '',
      '| 关卡 | 解决的问题 |',
      '| --- | --- |',
      '| 1 事件总线 | 副作用与主流程解耦，互不依赖的下游并行执行 |',
      '| 2 洋葱中间件 | 横切关注点变成可组合的层，而不是复制粘贴 |',
      '| 3 幂等与死信 | 重复投递不产生重复副作用，毒消息不阻塞队列 |',
      '',
      '## 硬性约束',
      '',
      '1. `emit` 永远不 reject，一个下游挂掉不能让下单失败；',
      '2. 互不依赖的 handler **必须并行**，总延迟等于最慢的那个，而不是所有之和；',
      '3. 同一个 `event.id` 重复投递，副作用只能发生一次；',
      '4. 中间件的顺序即嵌套顺序，`await next()` 之后的代码在回程执行。',
      '',
      '## 非目标',
      '',
      '- 不做持久化与跨进程投递（那需要 outbox + 真正的消息队列）；',
      '- 不做事件溯源（event sourcing），这里的事件是**通知**，不是**事实存储**；',
      '- 不处理事件顺序问题：本关假设事件之间没有先后依赖。',
      '',
      '## 术语',
      '',
      '- at-least-once：消息至少投递一次，可能多次。想「恰好一次」只能靠消费端幂等。',
      '- 幂等：同一个操作执行多次，效果与执行一次相同。',
      '- 死信队列（DLQ）：反复处理失败的消息被移到这里，避免阻塞正常消息。',
      '- **洋葱模型**：每层中间件在进入和返回时各执行一次，像洋葱一样层层包裹。',
      '',
      '这道题的评审权重偏向封装与优雅程度。用例只是底线，',
      '真正被看的是模块边界清不清晰、每个模块是不是只做一件事。',
    ].join('\n'),
    [
      '## Context',
      '',
      'A checkout endpoint has grown to 400 lines. Opening it up, six unrelated concerns are crammed together:',
      '',
      '```ts',
      'async function checkout(order) {',
      '  await auth(order);              // auth',
      '  await rateLimit(order.userId);  // rate limiting',
      '  await audit(order);             // audit log',
      '  await createOrder(order);       // the actual business',
      '  await decrementStock(order);    // side effect 1',
      '  await grantPoints(order);       // side effect 2',
      '  await notify(order);            // side effect 3  ← adding SMS means editing this function',
      '}',
      '```',
      '',
      'Two direct consequences:',
      '',
      '1. Every new consumer edits core logic, and regression means testing the whole path;',
      '2. Latency is the sum of all consumers. When notifications hiccup, checkout hiccups.',
      '',
      'Worse, the upstream queue only guarantees at-least-once, the same event arrives more than',
      'once. Last week a redelivered message decremented stock twice.',
      '',
      '## Goal',
      '',
      'Refactor into an event-driven skeleton across three stages:',
      '',
      '| Stage | Problem solved |',
      '| --- | --- |',
      '| 1 Event bus | Side effects decoupled from the main flow, independent consumers run in parallel |',
      '| 2 Onion middleware | Cross-cutting concerns become composable layers instead of copy-paste |',
      '| 3 Idempotency and DLQ | Duplicate delivery causes one side effect; poison messages do not block the queue |',
      '',
      '## Hard constraints',
      '',
      '1. `emit` never rejects, one failing consumer must not fail checkout;',
      '2. Independent handlers must run in parallel: total latency equals the slowest, not the sum;',
      '3. A repeated `event.id` may cause its side effect only once;',
      '4. Middleware order is nesting order; code after `await next()` runs on the way out.',
      '',
      '## Non-goals',
      '',
      '- No durability or cross-process delivery (that needs an outbox and a real broker);',
      '- No event sourcing, events here are notifications, not the source of truth;',
      '- No ordering guarantees: this stage assumes events are independent.',
      '',
      '## Glossary',
      '',
      '- at-least-once: delivered one or more times. "Exactly once" is only achievable via idempotent consumers.',
      '- Idempotent: running the operation twice has the same effect as running it once.',
      '- Dead-letter queue (DLQ): where repeatedly failing messages go so they stop blocking healthy ones.',
      '- Onion model: each middleware layer acts once on the way in and once on the way out.',
      '',
      'Review weights here lean towards encapsulation and elegance. Passing the specs is the baseline;',
      'what gets looked at is whether your module boundaries and responsibilities are clean.',
    ].join('\n')
  ),
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  Q[queue at-least-once] --> P[OrderProcessor]',
      '  P --> I{idempotent?}',
      '  I -- hit --> R[cached result]',
      '  I -- miss --> M[compose middlewares]',
      '  M --> A[audit] --> AU[auth] --> H[handler]',
      '  H --> B[EventBus.emit]',
      '  B --> S[stock] & PT[points] & N[notify]',
      '  M -. failed .-> D[dead letter queue]',
      '```',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  Q[queue at-least-once] --> P[OrderProcessor]',
      '  P --> I{idempotent?}',
      '  I -- hit --> R[cached result]',
      '  I -- miss --> M[compose middlewares]',
      '  M --> A[audit] --> AU[auth] --> H[handler]',
      '  H --> B[EventBus.emit]',
      '  B --> S[stock] & PT[points] & N[notify]',
      '  M -. failed .-> D[dead letter queue]',
      '```',
    ].join('\n')
  ),
  files: [contract],
  stages: [stage1, stage2, stage3],
};
