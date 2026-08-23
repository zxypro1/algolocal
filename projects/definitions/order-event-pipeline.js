/**
 * 工程实战 · 事件驱动的订单流水线
 *
 * 注意：代码片段使用 String.raw 模板，不要在片段里写 `${}`。
 */
const { t, code, file, readonlyFile, spec, gate } = require('./_helpers');

const contract = readonlyFile(
  'src/contract.ts',
  code`
    /** Contract provided by the platform (read-only) */

    export interface OrderEvent {
      /** Unique event id, used for idempotency */
      id: string;
      type: string;
      payload: Record<string, unknown>;
      /** When the event was produced (virtual clock) */
      at?: number;
    }

    export interface Context {
      event: OrderEvent;
      /** Data passed between middleware */
      state: Record<string, unknown>;
      /** The result; the last middleware is responsible for writing it */
      result?: unknown;
    }

    export type Next = () => Promise<void>;
    export type Middleware = (ctx: Context, next: Next) => Promise<void> | void;
  `
);

/* ------------------------------------------------------------------ */

const stage1 = {
  id: 'schema-evolution',
  title: t('第 1 关 · 事件模式与版本演进', 'Stage 1 · Event schemas and versioning'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '在写任何事件系统之前，先回答一个会困扰你三年的问题：**事件的结构变了怎么办？**',
      '',
      '数据库表结构变了可以写迁移脚本，一次性把所有行改掉。事件不行 ——',
      '事件是**已经发生的事实**，存在日志里、在别人的消费队列里、在备份磁带里。',
      '你改不了它们，只能让新代码有能力读懂旧格式。',
      '',
      '标准做法叫 **upcasting**：注册一串「从版本 N 升到版本 N+1」的转换函数，',
      '读到旧事件时顺着链条一路升到最新版本，业务代码只面对最新格式。',
      '',
      '## 要实现什么',
      '',
      '在 `src/schema.ts` 实现 `createRegistry()`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `register(type, fromVersion, upcaster)` | 登记一次「从 `fromVersion` 升一级」的转换 |',
      '| `upcast(event)` | 把任意版本的事件升到最新，**逐级升，不能跳** |',
      '| `latestVersion(type)` | 这个类型当前的最新版本 |',
      '',
      '遇到比最新版本还新的事件（老消费者读到新数据）要**抛错**，不能当作最新处理。',
      '',
      '## 怎么算过',
      '',
      '- 一个 v1 事件在最新版本是 v3 时被读到，必须经过 **2 次**转换',
      '  （门槛 `counters.upcastSteps = 2`）；',
      '- 链条中间缺一级时明确报错，而不是跳过；',
      '- 版本比最新还高时抛错；',
      '- 升级过程**不修改原事件**，返回新对象。',
      '',
      '## 三个都会让你付出代价的细节',
      '',
      '**只调用最后一个 upcaster** 会得到一个字段缺失的对象，而且不报错 ——',
      '它会在下游某个远处炸掉，那时你已经完全想不起来是这里的问题。',
      '',
      '**链断了要停下来报错。** 静默跳过会产出一个既不是旧格式也不是新格式的中间态，',
      '这种对象在系统里流动起来极难排查。',
      '',
      '**每一级都返回新对象。** 同一个事件可能被多个消费者读取，',
      '原地修改会让第二个消费者拿到一个已经升过的 payload，然后在它上面再升一次。',
    ].join('\n'),
    [
      'Before writing any event system, answer a question that will follow you for three years: **what',
      'happens when the shape of an event changes?**',
      '',
      'A database schema change gets a migration script that rewrites every row. Events do not — an event is',
      '**something that already happened**, sitting in a log, in somebody else\'s queue, on a backup tape. You',
      'cannot change them; you can only make new code able to read old formats.',
      '',
      'The standard technique is **upcasting**: register a chain of "version N to version N+1" transforms,',
      'and when an old event arrives, walk it up the chain so business code only ever sees the latest shape.',
      '',
      '## What to build',
      '',
      '`createRegistry()` in `src/schema.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `register(type, fromVersion, upcaster)` | Record one upgrade step out of `fromVersion` |',
      '| `upcast(event)` | Raise any version to the latest, **one step at a time, never skipping** |',
      '| `latestVersion(type)` | The current version of a type |',
      '',
      'An event newer than the latest known version — old consumer, new data — must **throw** rather than be',
      'treated as current.',
      '',
      '## What counts as passing',
      '',
      '- A v1 event read when the latest is v3 passes through **two** transforms',
      '  (`counters.upcastSteps = 2`);',
      '- A missing step in the chain reports an error rather than being skipped;',
      '- A version above the latest throws;',
      '- Upcasting **does not mutate the original event**; it returns a new object.',
      '',
      '## Three details that each cost you later',
      '',
      '**Calling only the last upcaster** produces an object missing fields, without error — and it explodes',
      'somewhere far downstream, long after you could connect it back to here.',
      '',
      '**A broken chain must stop and report.** Silently skipping produces an intermediate shape that is',
      'neither the old format nor the new one, and such objects are miserable to trace once they start moving',
      'through the system.',
      '',
      '**Every step returns a new object.** The same event may be read by several consumers, and mutating in',
      'place hands the second consumer an already-upgraded payload to upgrade again.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  REG["register(type, fromVersion, upcaster)"] --> MAP["chains：事件类型 → (版本号 → 升级函数)<br/>键是「从哪个版本升」"]',
      '  MAP --> LATEST["latest(type)<br/>= 所有 fromVersion 的最大值 + 1<br/>没登记过就是 1"]',
      '',
      '  UP["upcast(event)"] --> LATEST',
      '  LATEST --> NEWER{"event.version > 最新版本？"}',
      '  NEWER -- 是 --> THROW1["抛错：老消费者读到了新数据<br/>字段语义可能已经变了，不能静默当成最新"]',
      '  NEWER -- 否 --> COPY["payload = { ...event.payload }<br/>复制一份，绝不原地改"]',
      '  COPY --> LOOP{"version < 最新版本？"}',
      '  LOOP -- 否 --> DONE["返回 { id, type, 最新 version, payload }"]',
      '  LOOP -- 是 --> GET["chain.get(version)"]',
      '  GET --> MISS{"这一级有升级函数吗？"}',
      '  MISS -- 没有 --> THROW2["抛错：链断了<br/>跳过会产出一个不新不旧的中间态"]',
      '  MISS -- 有 --> APPLY["payload = upcaster(payload)<br/>version += 1"]',
      '  APPLY --> LOOP',
      '```',
      '',
      '要点：`LOOP → GET → APPLY → LOOP` 这个回环就是「逐级升」——',
      '门槛数的 2 次转换，就是这个环转了两圈。',
      '如果实现成「直接调 `chain.get(最新版本 - 1)`」，图上就没有环了，',
      '转换次数永远是 1，中间那一级的字段补全被整个跳过。',
      '',
      '`COPY` 那一步看起来多余，但它是 upcast 可以被安全重复调用的前提。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  REG["register(type, fromVersion, upcaster)"] --> MAP["chains: event type → (version → upgrade fn)<br/>keyed by the version being upgraded FROM"]',
      '  MAP --> LATEST["latest(type)<br/>= max of all fromVersion + 1<br/>1 when nothing is registered"]',
      '',
      '  UP["upcast(event)"] --> LATEST',
      '  LATEST --> NEWER{"event.version > latest?"}',
      '  NEWER -- yes --> THROW1["throw: an old consumer met new data<br/>field meanings may have changed — never assume current"]',
      '  NEWER -- no --> COPY["payload = { ...event.payload }<br/>copy, never mutate in place"]',
      '  COPY --> LOOP{"version < latest?"}',
      '  LOOP -- no --> DONE["return { id, type, latest version, payload }"]',
      '  LOOP -- yes --> GET["chain.get(version)"]',
      '  GET --> MISS{"is there a step for this version?"}',
      '  MISS -- no --> THROW2["throw: the chain is broken<br/>skipping yields a shape that is neither old nor new"]',
      '  MISS -- yes --> APPLY["payload = upcaster(payload)<br/>version += 1"]',
      '  APPLY --> LOOP',
      '```',
      '',
      'The point: the `LOOP → GET → APPLY → LOOP` cycle **is** the step-by-step upgrade — the two transforms',
      'the gate counts are two turns around it. Implemented as "just call `chain.get(latest - 1)`", the',
      'diagram has no cycle at all, the transform count is permanently one, and whatever the middle step',
      'filled in is skipped entirely.',
      '',
      '`COPY` looks redundant, but it is what makes `upcast` safe to call more than once on the same event.',
    ].join('\n')
  ),
  checklist: [
    t('旧版本事件被逐级升到最新', 'Old events are raised one version at a time'),
    t('已经是最新版本的事件原样通过', 'An already-current event passes through unchanged'),
    t('比最新还新的版本会抛错', 'A version newer than the latest throws'),
    t('不同类型的版本链互相独立', 'Version chains are independent per type'),
    t('upcast 不修改传入的事件对象', 'upcast does not mutate the event it is given'),
  ],
  pitfalls: [
    t(
      '只应用最后一个 upcaster，假设事件都是从上一个版本来的。生产里同时存在 v1、v2、v3 的事件是常态——老服务还没升级、消息队列里有积压、重放历史数据。跳级转换会产出一个缺字段的对象，而且不抛错，问题在下游很远的地方才暴露出来。',
      'Applying only the last upcaster on the assumption that every event comes from the previous version. Having v1, v2 and v3 events in flight simultaneously is normal — an unupgraded service, a backlog in the queue, a historical replay. Skipping steps produces an object missing fields, silently, and the problem surfaces far downstream.'
    ),
    t(
      '遇到未知的高版本时当作最新处理。这是老消费者读到新数据的场景，而它读到的字段可能已经改变了语义（比如 `amount` 从「分」变成了「元」）。静默接受会产生一百倍的金额错误；抛错至少让问题在正确的地方停下来。向前兼容做不到就该明确失败。',
      'Treating an unknown higher version as current. That is an old consumer reading new data, and a field it recognises may have changed meaning — `amount` moving from cents to units, say. Accepting silently produces a hundredfold error; throwing at least stops the problem where it belongs. When forward compatibility is impossible, fail explicitly.'
    ),
    t(
      'upcaster 直接改传入的 payload 对象。同一个事件可能被多个消费者读取，如果 upcast 是原地修改，第二个消费者拿到的就是已经被改过的对象——而它自己的 upcast 会在这个基础上再升一次。每一级都返回新对象，是这类转换链的基本要求。',
      'Having upcasters mutate the incoming payload. The same event may be read by several consumers, and in-place upcasting hands the second one an already-transformed object which it then upgrades again. Each step returning a new object is the basic requirement for a transform chain.'
    ),
    t(
      '把版本号存在事件外面（比如队列的元数据里）而不是事件本身。事件被持久化、被复制、被重放，任何一次搬运都可能丢掉外部元数据——而丢了版本号的事件是无法解读的。版本号必须是事件结构的一部分，和 payload 一起走。',
      'Storing the version outside the event, in queue metadata rather than the event itself. Events get persisted, copied and replayed, and any of those moves can drop external metadata — and an event without its version cannot be interpreted at all. The version must be part of the event and travel with the payload.'
    ),
  ],
  hints: [
    t(
      '每个 type 存一个 `Map<fromVersion, upcaster>`。`upcast` 就是 `while (v < latest) { payload = map.get(v)(payload); v += 1; }`。',
      'Keep a `Map<fromVersion, upcaster>` per type. `upcast` is `while (v < latest) { payload = map.get(v)(payload); v += 1; }`.'
    ),
    t(
      '`latestVersion` = 已登记的最大 fromVersion + 1。没登记过任何升级的类型，最新版本就是 1。',
      '`latestVersion` is the highest registered `fromVersion` plus one; a type with no registered upgrades is at version 1.'
    ),
  ],
  extension: t(
    [
      '事件模式演进有一条几乎所有团队都会撞到的铁律：**只加不删不改**。',
      '加一个可选字段是安全的，老消费者忽略它就行；',
      '删掉一个字段、改一个字段的类型或含义，都会让老消费者以未定义的方式出错。',
      'Protobuf 和 Avro 的设计目标很大一部分就是把这条铁律编码进工具里——',
      'Protobuf 的字段编号一旦用过就永久保留（`reserved`），Avro 有正式的兼容性检查。',
      '',
      'Upcasting 在读路径上做转换，还有一种流派是在写路径上做：**双写**。',
      '新旧两种格式同时写，等所有消费者都升级完了再停掉旧的。',
      '它的好处是消费端完全不用改；代价是写入量翻倍，而且「所有消费者都升级完了」',
      '这件事在大组织里可能永远不会发生。',
      '',
      '还有一个更激进的方案：**不演进，只加新类型**。',
      '`OrderPlaced` 需要改结构时，不改它，而是新增一个 `OrderPlacedV2`。',
      '两种事件长期共存，消费者按需订阅。这避免了所有版本转换的复杂度，',
      '代价是事件类型会越来越多，而且「同一件事有两种事件」本身会引起混乱。',
      '',
      '真实系统通常混用：小改动用可选字段（不升版本），中等改动用 upcasting，',
      '语义级的大改动直接开新类型。判断标准是「老消费者按旧语义处理这个事件，',
      '会不会做出错误的业务决策」——会，就必须开新类型。',
    ].join('\n'),
    [
      'Schema evolution has an iron rule nearly every team eventually meets: add, never remove or change.',
      'Adding an optional field is safe because old consumers ignore it; removing a field or changing its',
      'type or meaning breaks them in undefined ways. A large part of the design of Protobuf and Avro is',
      'encoding that rule into tooling — Protobuf reserves field numbers permanently once used, and Avro',
      'has formal compatibility checks.',
      '',
      'Upcasting transforms on read. The other school transforms on write: dual writing, emitting both',
      'formats until every consumer has upgraded, then dropping the old one. Consumers need no changes at',
      'all; the cost is doubled write volume, and in a large organisation "every consumer has upgraded"',
      'may never actually happen.',
      '',
      'A more radical option is not evolving at all, only adding types. When `OrderPlaced` needs a new',
      'shape, leave it alone and introduce `OrderPlacedV2`. Both coexist indefinitely and consumers',
      'subscribe to what they want. This avoids all conversion complexity at the cost of an ever-growing',
      'type list, and "one thing has two events" is confusing in its own right.',
      '',
      'Real systems mix all three: optional fields for small changes with no version bump, upcasting for',
      'moderate ones, and a brand-new type for semantic changes. The test is whether an old consumer',
      'applying old semantics to this event would make a wrong business decision — if so, it needs a new type.',
    ].join('\n')
  ),
  focus: ['correctness', 'encapsulation', 'resilience'],
  lab: {},
  starterFiles: [
    contract,
    file(
      'src/schema.ts',
      code`
        export interface VersionedEvent {
          id: string;
          type: string;
          /** The version must be part of the event itself, not kept in external metadata */
          version: number;
          payload: Record<string, unknown>;
        }

        export type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>;

        export interface SchemaRegistry {
          /** Register one step that upgrades fromVersion to fromVersion + 1 */
          register(type: string, fromVersion: number, upcaster: Upcaster): void;
          /** Upgrade step by step to the latest version; throws if the version is newer than the latest */
          upcast(event: VersionedEvent): VersionedEvent;
          latestVersion(type: string): number;
        }

        export function createRegistry(): SchemaRegistry {
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
        import { createRegistry } from '../src/schema';
        import { count } from '@lab/metrics';

        function registryWithChain(applied?: string[]) {
          const registry = createRegistry();
          registry.register('OrderPlaced', 1, (payload) => {
            if (applied) applied.push('1->2');
            return { ...payload, currency: 'CNY' };
          });
          registry.register('OrderPlaced', 2, (payload) => {
            if (applied) applied.push('2->3');
            return { ...payload, amountCents: Number(payload.amount) * 100 };
          });
          return registry;
        }

        describe('Stage 1 · Event schema evolution', () => {
          it('a type with no registered upgrade is at version 1', () => {
            expect(createRegistry().latestVersion('Unknown')).toBe(1);
          });

          it('after registering two steps the latest version is 3', () => {
            expect(registryWithChain().latestVersion('OrderPlaced')).toBe(3);
          });

          it('an event already at the latest version passes through untouched', () => {
            const registry = registryWithChain();
            const event = {
              id: 'e1',
              type: 'OrderPlaced',
              version: 3,
              payload: { amount: 10, currency: 'CNY', amountCents: 1000 },
            };
            expect(registry.upcast(event)).toEqual(event);
          });

          it('a v1 event is upgraded step by step to v3 [gate:chain]', () => {
            const applied: string[] = [];
            const registry = registryWithChain(applied);

            const upcasted = registry.upcast({
              id: 'e1',
              type: 'OrderPlaced',
              version: 1,
              payload: { amount: 10 },
            });

            count('upcastSteps', applied.length);
            // Calling only the last upcaster takes a single step here, and leaves currency missing
            expect(applied).toEqual(['1->2', '2->3']);
            expect(upcasted.version).toBe(3);
            expect(upcasted.payload).toEqual({ amount: 10, currency: 'CNY', amountCents: 1000 });
          });

          it('a v2 event is upgraded by one step only', () => {
            const applied: string[] = [];
            const registry = registryWithChain(applied);

            registry.upcast({
              id: 'e1',
              type: 'OrderPlaced',
              version: 2,
              payload: { amount: 7, currency: 'USD' },
            });
            expect(applied).toEqual(['2->3']);
          });

          it('a version newer than the latest throws', () => {
            const registry = registryWithChain();
            let thrown = false;
            try {
              registry.upcast({ id: 'e1', type: 'OrderPlaced', version: 9, payload: {} });
            } catch (caught) {
              thrown = true;
            }
            // When an old consumer reads newer data, field meanings may have changed; accepting it silently computes the wrong answer
            expect(thrown).toBe(true);
          });

          it('version chains for different types are independent', () => {
            const registry = registryWithChain();
            registry.register('OrderShipped', 1, (payload) => ({ ...payload, carrier: 'sf' }));

            expect(registry.latestVersion('OrderPlaced')).toBe(3);
            expect(registry.latestVersion('OrderShipped')).toBe(2);
            expect(
              registry.upcast({ id: 'e2', type: 'OrderShipped', version: 1, payload: {} }).payload
            ).toEqual({ carrier: 'sf' });
          });

          it('upcast does not mutate the event it is given', () => {
            const registry = registryWithChain();
            const original = {
              id: 'e1',
              type: 'OrderPlaced',
              version: 1,
              payload: { amount: 10 },
            };
            registry.upcast(original);

            // The same event may be read by several consumers; mutating in place upgrades it twice
            expect(original.version).toBe(1);
            expect(original.payload).toEqual({ amount: 10 });
          });

          it('upgrading the same event twice gives the same result', () => {
            const registry = registryWithChain();
            const event = { id: 'e1', type: 'OrderPlaced', version: 1, payload: { amount: 10 } };
            expect(registry.upcast(event)).toEqual(registry.upcast(event));
          });

          it('an unregistered type only accepts v1', () => {
            const registry = createRegistry();
            const event = { id: 'e1', type: 'Unknown', version: 1, payload: { a: 1 } };
            expect(registry.upcast(event)).toEqual(event);

            let thrown = false;
            try {
              registry.upcast({ id: 'e2', type: 'Unknown', version: 2, payload: {} });
            } catch (caught) {
              thrown = true;
            }
            expect(thrown).toBe(true);
          });

          it('a missing link in the version chain throws instead of being skipped', () => {
            const registry = createRegistry();
            registry.register('Gappy', 1, (payload) => payload);
            registry.register('Gappy', 3, (payload) => payload);

            let thrown = false;
            try {
              registry.upcast({ id: 'e1', type: 'Gappy', version: 1, payload: {} });
            } catch (caught) {
              thrown = true;
            }
            // The 2->3 step is missing; skipping it silently would produce an in-between shape nobody recognises
            expect(thrown).toBe(true);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.upcastSteps',
      op: 'eq',
      value: 2,
      unit: 'steps',
      zh: 'v1 升到 v3 必须逐级经过两次转换',
      en: 'Raising v1 to v3 must pass through both transforms',
      dimension: 'correctness',
      scope: 'gate:chain',
    }),
  ],
  referenceFiles: [
    file(
      'src/schema.ts',
      code`
        export interface VersionedEvent {
          id: string;
          type: string;
          version: number;
          payload: Record<string, unknown>;
        }

        export type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>;

        export interface SchemaRegistry {
          register(type: string, fromVersion: number, upcaster: Upcaster): void;
          upcast(event: VersionedEvent): VersionedEvent;
          latestVersion(type: string): number;
        }

        export function createRegistry(): SchemaRegistry {
          const chains = new Map<string, Map<number, Upcaster>>();

          function chainOf(type: string): Map<number, Upcaster> {
            const existing = chains.get(type);
            if (existing) return existing;
            const created = new Map<number, Upcaster>();
            chains.set(type, created);
            return created;
          }

          function latest(type: string): number {
            const chain = chains.get(type);
            if (!chain || chain.size === 0) return 1;
            let highest = 1;
            for (const from of Array.from(chain.keys())) highest = Math.max(highest, from + 1);
            return highest;
          }

          return {
            register(type: string, fromVersion: number, upcaster: Upcaster): void {
              chainOf(type).set(fromVersion, upcaster);
            },

            upcast(event: VersionedEvent): VersionedEvent {
              const target = latest(event.type);
              if (event.version > target) {
                // An old consumer has read newer data. Field meanings may have changed,
                // so treating it silently as current produces business errors; only failing loudly catches it
                throw new Error(
                  'event ' + event.id + ' is version ' + event.version + ' but this consumer only knows ' + target
                );
              }

              const chain = chainOf(event.type);
              let version = event.version;
              // Every step returns a new object: the same event may be read by several consumers,
              // and mutating in place would upgrade it a second time for the next one
              let payload: Record<string, unknown> = { ...event.payload };

              while (version < target) {
                const upcaster = chain.get(version);
                // Stop and report when the chain is broken. Skipping silently produces a shape that is
                // neither the old format nor the new one
                if (!upcaster) {
                  throw new Error(
                    'no upcaster from version ' + version + ' for event type ' + event.type
                  );
                }
                payload = upcaster(payload);
                version += 1;
              }

              return { id: event.id, type: event.type, version, payload };
            },

            latestVersion(type: string): number {
              return latest(type);
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`while (version < target)` 而不是「取出最后一个 upcaster 调一次」。** 这是这一关的全部。',
      '生产里 v1、v2、v3 的事件同时存在是常态，跳级转换产出的对象缺字段但不抛错，',
      '会在下游很远的地方以一个看不懂的错误暴露出来。',
      '',
      '**`event.version > target` 抛错，而不是当作最新。** 这是「向前兼容做不到时明确失败」。',
      '老消费者读到新事件，最危险的不是缺字段——那通常会报错——',
      '而是字段还在但语义变了（`amount` 从元变成分）。静默处理会算出一个错一百倍的数字，',
      '而且一路通过所有校验。',
      '',
      '**链断了也抛错。** 登记了 1→2 和 3→4 但缺 2→3 时，静默跳过会产出一个',
      '「payload 是 v2 格式、version 标着 4」的对象，比缺字段更难查。',
      '转换链的完整性应该在第一次用到时就被发现。',
      '',
      '**`latest()` 从已登记的 fromVersion 推导，而不是单独维护一个版本号字段。**',
      '两处状态就有两处会不一致的地方——注册了 upcaster 但忘了改版本号，',
      '或者反过来。让它只有一个真相来源。',
    ].join('\n'),
    [
      '`while (version < target)` rather than fetching the last upcaster and calling it once. That is the',
      'whole stage. Having v1, v2 and v3 events in flight simultaneously is normal in production, and a',
      'skipped step produces an object missing fields without throwing, surfacing far downstream as an',
      'error nobody can interpret.',
      '',
      '`event.version > target` throws rather than being treated as current — failing explicitly when',
      'forward compatibility is impossible. The dangerous case for an old consumer reading a new event is',
      'not a missing field, which usually errors, but a field that still exists with changed meaning',
      '(`amount` moving from units to cents). Handling it silently computes a number wrong by a hundredfold',
      'that passes every validation on the way.',
      '',
      'A broken chain throws too. With 1→2 and 3→4 registered but 2→3 missing, skipping silently yields an',
      'object whose payload is v2-shaped while its version says 4, which is harder to diagnose than a',
      'missing field. Chain completeness should surface the first time it is needed.',
      '',
      '`latest()` is derived from the registered `fromVersion`s rather than maintained as a separate field.',
      'Two pieces of state means two places to disagree — an upcaster registered without bumping the',
      'version, or the reverse. Give it one source of truth.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage2 = {
  id: 'event-bus',
  title: t('第 2 关 · 事件总线', 'Stage 2 · Event bus'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '订单系统里，「下单成功」要同时触发库存扣减、积分发放、消息通知。',
      '现在的代码把三件事写在了下单函数里，每加一个下游就要改一次核心逻辑 ——',
      '而核心逻辑是最不该被这种事碰的地方。',
      '',
      '## 要实现什么',
      '',
      '在 `src/bus.ts` 实现 `createEventBus(options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `on(type, handler)` | 注册监听，**返回一个取消订阅的函数** |',
      '| `emit(type, payload)` | 并行触发所有监听，等它们全部结束 |',
      '| `listenerCount(type)` | 这个类型上挂了几个监听 |',
      '',
      '错误处理有明确契约：单个 handler 抛错不影响其他 handler，',
      '`emit` 本身**永不 reject**，错误交给 `options.onError`。',
      '',
      '## 怎么算过',
      '',
      '- 三个各耗 50ms 的下游并行完成，总耗时 50ms 而不是 150ms',
      '  （门槛 `virtualElapsedMs ≤ 50`）；',
      '- 一个 handler 抛错时，其他 handler 照常执行完；',
      '- 取消订阅之后不再收到事件；',
      '- handler 里调用取消订阅，不会影响本次 emit 的遍历。',
      '',
      '## 为什么并行是这一关的门槛',
      '',
      '串行的 `for (const h of handlers) await h()` 会让总延迟等于所有下游之和。',
      '通知服务慢 300ms，下单接口就跟着慢 300ms —— 而通知本来和下单成功与否毫无关系。',
      '互不依赖的副作用应该并行，`Promise.all` 就是这句话的代码形式。',
      '',
      '还有一个必须写对的地方：遍历前先给 handler 数组**拍一个快照**。',
      'handler 内部调用取消订阅是很常见的写法（比如「只处理一次」），',
      '直接遍历原数组会在遍历途中被 `splice` 改短，后面的 handler 被静默跳过。',
    ].join('\n'),
    [
      'Placing an order must decrement stock, grant points and send a notification. Today all three are',
      'hard-coded into the checkout function, so every new consumer edits core logic — and core logic is the',
      'last place that should be touched for this.',
      '',
      '## What to build',
      '',
      '`createEventBus(options)` in `src/bus.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `on(type, handler)` | Subscribe, **returning an unsubscribe function** |',
      '| `emit(type, payload)` | Fan out to all listeners in parallel and await them all |',
      '| `listenerCount(type)` | How many listeners a type carries |',
      '',
      'Error handling has an explicit contract: one failing handler must not affect the others, `emit`',
      'itself **never rejects**, and errors go to `options.onError`.',
      '',
      '## What counts as passing',
      '',
      '- Three consumers of 50ms each finish in 50ms, not 150ms (`virtualElapsedMs ≤ 50`);',
      '- When one handler throws, the others still run to completion;',
      '- An unsubscribed handler stops receiving events;',
      '- Unsubscribing from inside a handler does not disturb the current emit.',
      '',
      '## Why parallelism is the gate',
      '',
      'A serial `for (const h of handlers) await h()` makes total latency the sum of every consumer. If',
      'notifications take 300ms, checkout takes 300ms longer — and notifications have nothing to do with',
      'whether checkout succeeded. Independent side effects belong in parallel, and `Promise.all` is that',
      'sentence written as code.',
      '',
      'One more thing to get right: take a **snapshot** of the handler array before iterating. Unsubscribing',
      'from inside a handler is a common pattern ("handle once"), and iterating the live array lets a',
      '`splice` shorten it mid-traversal, silently skipping later handlers.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  ON["on(type, handler)"] --> PUSH["listeners：类型 → handler 数组"]',
      '  PUSH --> OFF["返回取消订阅函数<br/>按引用 indexOf + splice"]',
      '',
      '  EMIT["emit(type, payload)"] --> SNAP["handlers = [...listeners.get(type)]<br/>先快照：handler 里 off() 不会改坏正在遍历的数组"]',
      '  SNAP --> ALL["Promise.all —— 三个任务同时出发"]',
      '  ALL --> H1["handler A · try/catch"]',
      '  ALL --> H2["handler B · try/catch"]',
      '  ALL --> H3["handler C · try/catch"]',
      '  H1 --> Q{"抛错了吗？"}',
      '  H2 --> Q',
      '  H3 --> Q',
      '  Q -- 抛了 --> ONERR["options.onError(error, type)<br/>错误止步于此，不牵连兄弟 handler"]',
      '  Q -- 没抛 --> FIN["正常结束"]',
      '  ONERR --> JOIN["全部结束 → emit 的 promise resolve<br/>emit 本身永不 reject"]',
      '  FIN --> JOIN',
      '```',
      '',
      '要点：`ALL` 那个扇出是延迟门槛的全部 —— 三条边同时出发，',
      '总耗时是三者的最大值。改成 `for + await`，三条边就变成一条竖线，总耗时变成三者之和。',
      '',
      '`try/catch` 放在**每个 handler 内部**而不是包住 `Promise.all`：',
      '包在外面的话，第一个 reject 会让 `Promise.all` 立刻结束，',
      '其余 handler 的结果无人等待，「互不影响」也就没了。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  ON["on(type, handler)"] --> PUSH["listeners: type → handler array"]',
      '  PUSH --> OFF["return an unsubscribe function<br/>indexOf by reference + splice"]',
      '',
      '  EMIT["emit(type, payload)"] --> SNAP["handlers = [...listeners.get(type)]<br/>snapshot first: off() inside a handler cannot corrupt the walk"]',
      '  SNAP --> ALL["Promise.all — all three start at once"]',
      '  ALL --> H1["handler A · try/catch"]',
      '  ALL --> H2["handler B · try/catch"]',
      '  ALL --> H3["handler C · try/catch"]',
      '  H1 --> Q{"did it throw?"}',
      '  H2 --> Q',
      '  H3 --> Q',
      '  Q -- threw --> ONERR["options.onError(error, type)<br/>the error stops here, siblings unaffected"]',
      '  Q -- no --> FIN["finished normally"]',
      '  ONERR --> JOIN["all settled → emit\'s promise resolves<br/>emit itself never rejects"]',
      '  FIN --> JOIN',
      '```',
      '',
      'The point: the fan-out at `ALL` is the entire latency gate — three edges leaving at once, total time',
      'being their maximum. Rewrite it as `for + await` and the three edges collapse into one vertical line,',
      'making the total their sum.',
      '',
      'The `try/catch` sits **inside each handler**, not around `Promise.all`: wrapped outside, the first',
      'rejection ends `Promise.all` immediately, nobody awaits the remaining handlers, and "unaffected',
      'siblings" is gone.',
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
          /** Last-resort reporting for when a handler throws */
          onError?: (error: unknown, type: string) => void;
        }

        export interface EventBus {
          on(type: string, handler: EventHandler): () => void;
          emit(type: string, payload: Record<string, unknown>): Promise<void>;
          listenerCount(type: string): number;
        }

        export function createEventBus(options: EventBusOptions = {}): EventBus {
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
        import { createEventBus } from '../src/bus';
        import { sleep, now } from '@lab/env';

        describe('Stage 2 · Event bus', () => {
          it('every listener receives the event', async () => {
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

          it('no more events arrive after unsubscribing', async () => {
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

          it('emit waits for async handlers to finish', async () => {
            const bus = createEventBus();
            let done = false;
            bus.on('order.created', async () => {
              await sleep(30);
              done = true;
            });

            await bus.emit('order.created', {});
            expect(done).toBe(true);
          });

          it('one handler throwing does not affect the others', async () => {
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

          it('independent handlers run in parallel [gate:latency]', async () => {
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

          it('an event with no listeners does not blow up', async () => {
            const bus = createEventBus();
            await bus.emit('nobody.listens', { a: 1 });
            expect(bus.listenerCount('nobody.listens')).toBe(0);
          });

          it('different event types do not cross wires', async () => {
            const bus = createEventBus();
            const seen: string[] = [];
            bus.on('order.created', () => seen.push('created'));
            bus.on('order.paid', () => seen.push('paid'));

            await bus.emit('order.paid', {});
            expect(seen).toEqual(['paid']);
          });

          it('registering the same function twice calls it twice, and one unsubscribe removes only one', async () => {
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

          it('unsubscribing inside a handler does not disturb the dispatch in flight', async () => {
            const bus = createEventBus();
            const seen: string[] = [];
            let off2: (() => void) | null = null;

            bus.on('order.created', () => {
              seen.push('first');
              // Remove a later listener mid-dispatch: this dispatch should still complete in full
              off2?.();
            });
            off2 = bus.on('order.created', () => {
              seen.push('second');
            });

            await bus.emit('order.created', {});
            expect(seen).toEqual(['first', 'second']);
            expect(bus.listenerCount('order.created')).toBe(1);
          });

          it('emit still resolves when every handler throws', async () => {
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

          it('a throwing sync handler is isolated too', async () => {
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
              // Snapshot first, so a handler calling off() cannot corrupt the array being iterated
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

const stage3 = {
  id: 'partition-ordering',
  title: t('第 3 关 · 分区与顺序保证', 'Stage 3 · Partitioning and ordering'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关的事件总线把所有 handler 并行触发，因为它假设事件之间没有先后关系。',
      '订单系统里这个假设不成立：同一个订单的「已支付」必须在「已创建」之后处理，',
      '否则你会给一个还不存在的订单标记支付成功。',
      '',
      '但也不能因此把所有事件串行化 —— 不同订单之间毫无关系，串行会让吞吐塌到 1。',
      '',
      '正确的粒度是**分区**：按订单号哈希分到 N 个分区，',
      '**分区内严格有序，分区间完全并行**。',
      '',
      '## 要实现什么',
      '',
      '在 `src/partition.ts` 实现 `createPartitionedBus(options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `publish(event)` | 返回的 Promise 在**这个事件**被处理完时 resolve |',
      '| `subscribe(handler)` | 注册处理函数 |',
      '| `partitionOf(key)` | 这个 key 归哪个分区 |',
      '| `pending()` | 当前还有多少事件在处理中 |',
      '',
      '同一分区的事件按 publish 顺序**逐个**处理，前一个没完成不能开始下一个；',
      '不同分区并行推进。',
      '',
      '## 怎么算过',
      '',
      '- 同一个订单的 12 个事件，处理顺序和发布顺序完全一致',
      '  （门槛 `counters.orderViolations = 0`）；',
      '- 4 个分区各 3 个事件、每个 100ms，总耗时 300ms 而不是 1200ms',
      '  （门槛 `virtualElapsedMs ≤ 350`）；',
      '- 某个事件的 handler 抛错，不会让该分区后续事件永远卡住。',
      '',
      '## 两个门槛缺一不可',
      '',
      '只满足第一条的实现是「全局串行」，只满足第二条的是「全部并行」，',
      '两条都要才是分区。这也是 Kafka 这类系统的核心取舍：',
      '顺序保证的粒度决定了并行度的上限，而分区键的选择就是在选这个粒度。',
      '',
      '实现上有两处很容易踩：',
      '',
      '**分区内必须逐个 `await`**。在 handler 循环里用 `Promise.all` 顺序保证就没了 ——',
      '这一关的两个门槛正好会一个通过一个失败。',
      '',
      '**串起来的那条链要成功失败都接。** 写成 `tails[p].then(run)` 而不是 `.then(run, run)`，',
      '一次失败就会让这条链断在原地，该分区后续所有事件的 promise 全部永远悬着 ——',
      '调用方看到的现象是「某些订单再也不动了」，而且完全没有报错。',
    ].join('\n'),
    [
      'The event bus fans out to handlers in parallel because it assumes events are independent. In an order',
      'system that assumption fails: "paid" for one order must be processed after "created" for the same',
      'order, or you mark a nonexistent order as paid.',
      '',
      'Serialising everything is not the answer either — different orders have nothing to do with each other,',
      'and serialising collapses throughput to one.',
      '',
      'The right granularity is **partitioning**: hash the order id into N partitions, with **strict ordering',
      'inside a partition and full parallelism across them**.',
      '',
      '## What to build',
      '',
      '`createPartitionedBus(options)` in `src/partition.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `publish(event)` | Returns a promise resolving when **that event** has been handled |',
      '| `subscribe(handler)` | Register a handler |',
      '| `partitionOf(key)` | Which partition a key belongs to |',
      '| `pending()` | How many events are currently in flight |',
      '',
      'Events in one partition are handled **one at a time** in publish order, the next never starting before',
      'the previous finishes; partitions advance in parallel.',
      '',
      '## What counts as passing',
      '',
      '- Twelve events for one order are handled in exactly publish order',
      '  (`counters.orderViolations = 0`);',
      '- Four partitions of three events at 100ms each take 300ms, not 1200ms',
      '  (`virtualElapsedMs ≤ 350`);',
      '- A handler that throws does not wedge the rest of its partition forever.',
      '',
      '## Both gates are required',
      '',
      'Satisfying only the first is global serialisation; only the second is unrestricted parallelism.',
      'Partitioning is both at once. This is also the central trade-off in systems like Kafka: the',
      'granularity of the ordering guarantee sets the ceiling on parallelism, and choosing a partition key is',
      'choosing that granularity.',
      '',
      'Two implementation traps:',
      '',
      '**Inside a partition you must `await` one at a time.** Use `Promise.all` over the handler loop and the',
      'ordering guarantee vanishes — with these two gates, exactly one will pass and one will fail.',
      '',
      '**The chain must continue on failure as well as success.** Written as `tails[p].then(run)` instead of',
      '`.then(run, run)`, one failure stops that chain where it stands and every later event in the partition',
      'hangs forever — what the caller sees is "some orders just stopped moving", with no error anywhere.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**publish(event)** —— 把新任务接到该分区那条链的尾巴上',
      '',
      '```mermaid',
      'flowchart TD',
      '  PUB["publish(event)"] --> K["p = hash(keyOf(event)) % 分区数"]',
      '  K --> TAIL["取该分区的尾部 promise：tails[p]"]',
      '  TAIL --> CHAIN["queued = tails[p].then(run, run)<br/>成功失败都接下一个<br/>只给 then 的话一次失败就断链"]',
      '  CHAIN --> STORE["tails[p] = queued<br/>新任务成为这个分区新的尾巴"]',
      '  STORE --> RET["返回 queued<br/>它在这个事件处理完时 resolve"]',
      '  CHAIN --> RUN["轮到它时执行 run()：<br/>逐个 await handler(event)<br/>catch 吞掉异常，finally 里 inFlight -= 1"]',
      '```',
      '',
      '`run()` 里逐个 `await`，换成 `Promise.all` 顺序保证就没了；',
      '异常必须吞掉，未处理的 reject 会把整条链断在原地，',
      '该分区后续事件的 promise 全部永远悬着。',
      '',
      '**tails 数组** —— 每个分区一条互不相干的链',
      '',
      '```mermaid',
      'flowchart TD',
      '  T0["分区 0： e1 → e5 → e9"]',
      '  T1["分区 1： e2 → e6"]',
      '  T2["分区 2： e3 → e7"]',
      '  T3["分区 3： e4 → e8"]',
      '```',
      '',
      '链**内**的箭头是串行的，保证顺序；四条链之间没有任何箭头，于是天然并行。',
      '两个门槛对应的正是这张图的两个方向 —— 竖着看是顺序，横着看是并发。',
      '',
      '分区数就是并行度的上限，而 `keyOf` 决定谁和谁必须排队：',
      '写成返回常量，四条链就退化成一条；写成返回随机值，顺序保证立刻消失。',
    ].join('\n'),
    [
      '**publish(event)** — append the new task to that partition\'s chain',
      '',
      '```mermaid',
      'flowchart TD',
      '  PUB["publish(event)"] --> K["p = hash(keyOf(event)) % partitionCount"]',
      '  K --> TAIL["take that partition\'s tail promise: tails[p]"]',
      '  TAIL --> CHAIN["queued = tails[p].then(run, run)<br/>continue on success and failure alike<br/>with only then, one failure breaks the chain"]',
      '  CHAIN --> STORE["tails[p] = queued<br/>the new task becomes the partition\'s tail"]',
      '  STORE --> RET["return queued<br/>it resolves when this event is done"]',
      '  CHAIN --> RUN["when its turn comes, run():<br/>await each handler(event) in turn<br/>catch swallows errors, finally does inFlight -= 1"]',
      '```',
      '',
      '`run()` awaits handlers one at a time; swap in `Promise.all` and the ordering guarantee is gone. The',
      'error must be swallowed, because an unhandled rejection stops the chain where it stands and every',
      'later event in the partition hangs forever.',
      '',
      '**The tails array** — one independent chain per partition',
      '',
      '```mermaid',
      'flowchart TD',
      '  T0["partition 0: e1 → e5 → e9"]',
      '  T1["partition 1: e2 → e6"]',
      '  T2["partition 2: e3 → e7"]',
      '  T3["partition 3: e4 → e8"]',
      '```',
      '',
      'The arrows **inside** a chain are serial, which is the ordering guarantee; there are no arrows between',
      'the four chains, which is the parallelism. The two gates are literally the two directions of this',
      'picture — read vertically for order, horizontally for concurrency.',
      '',
      'The partition count is the ceiling on parallelism, and `keyOf` decides who must queue behind whom:',
      'return a constant and the four chains collapse into one; return something random and the ordering',
      'guarantee disappears.',
    ].join('\n')
  ),
  checklist: [
    t('同一个 key 的事件严格按发布顺序处理', 'Events for one key are handled in publish order'),
    t('不同分区的事件并行推进', 'Different partitions advance in parallel'),
    t('同一个 key 永远落到同一个分区', 'One key always lands in the same partition'),
    t('handler 抛错不会卡死整个分区', 'A throwing handler does not wedge its partition'),
    t('publish 的 Promise 在该事件处理完时 resolve', "publish resolves when that event's handling completes"),
  ],
  pitfalls: [
    t(
      '用一个全局队列串行处理所有事件。顺序当然是对的，吞吐也当然是 1——四个分区的活儿排成一队，本来 300ms 能做完的事要 1200ms。而且这个退化在小数据量的测试里完全看不出来，只有在压测或者线上才暴露。',
      'Serialising everything through one global queue. Ordering is trivially correct and throughput is one: four partitions of work in a single line, taking 1200ms for what should be 300ms. The degradation is invisible in small tests and only appears under load or in production.'
    ),
    t(
      '分区内也用 `Promise.all` 并行。吞吐很好看，但同一个订单的「已支付」可能在「已创建」之前完成——而这类 bug 是概率性的：handler 快的时候顺序碰巧是对的，某次 GC 或者网络抖动就错了。它在测试里几乎不可复现。',
      'Using `Promise.all` inside a partition as well. Throughput looks great and "paid" can complete before "created" for the same order — a probabilistic bug that happens to be ordered correctly while handlers are fast and inverts after one GC pause or network hiccup. It is nearly impossible to reproduce in a test.'
    ),
    t(
      'handler 抛错时没有 catch，导致该分区的链断掉。分区是靠「前一个 promise 完成后接着下一个」串起来的，一旦某一环 reject 且没人处理，后面所有事件的 promise 都永远不会 resolve——这个订单的后续事件全部卡死，而且没有任何错误日志。',
      'Letting a throwing handler break the partition chain. A partition is a chain of "when the previous promise settles, start the next"; one unhandled rejection leaves every subsequent event\'s promise permanently pending, so that order\'s later events wedge forever with no error logged.'
    ),
    t(
      '按事件到达顺序而不是按 key 分区，比如轮询分配。吞吐和并行度都很好，顺序保证却完全没有了——同一个订单的两个事件可能落在不同分区上并行处理。分区键的选择是这个机制唯一的正确性来源，它必须来自业务语义。',
      'Assigning partitions by arrival order — round robin — rather than by key. Throughput and parallelism are fine and the ordering guarantee is gone entirely, since two events for one order can land in different partitions and run concurrently. The partition key is the sole source of correctness here and must come from business semantics.'
    ),
  ],
  hints: [
    t(
      '每个分区维护一个「尾部 promise」。publish 时把新任务接在尾部后面：`tail = tail.then(() => handle(event))`，然后把新的 tail 存回去。',
      'Keep a tail promise per partition. On publish, chain onto it: `tail = tail.then(() => handle(event))`, and store the new tail back.'
    ),
    t(
      '接链的时候记得吞掉异常：`tail = tail.then(run, run)` 或者在 handle 里面 try/catch，否则一次失败会让这个分区的后续事件永远悬着。',
      'Swallow errors when chaining — `tail = tail.then(run, run)` or a try/catch inside the handler — otherwise one failure leaves the rest of that partition pending forever.'
    ),
  ],
  extension: t(
    [
      '「分区内有序、分区间并行」是 Kafka 的核心设计，也是它和传统消息队列最大的区别。',
      'RabbitMQ 这类队列的顺序保证是「整个队列有序」，想并行就得开多个消费者，',
      '而多个消费者就没有顺序了——两者不可兼得。Kafka 把顺序的粒度降到分区，',
      '于是「有序」和「并行」第一次可以同时成立。',
      '',
      '代价是**分区键的选择变成了架构决策**。选订单号，同一订单有序但热点订单会让某个分区过载；',
      '选用户 id，同一用户的所有订单有序但粒度更粗；选随机值，完全没有顺序保证。',
      '而且分区键一旦定了就极难改——改了之后历史事件和新事件的分区不一致，',
      '同一个订单的事件会横跨两个分区，顺序保证当场失效。',
      '',
      '分区数同样难改。Kafka 支持增加分区，但增加之后同一个 key 的哈希结果会变，',
      '新事件去了新分区、老事件还在老分区，顺序保证在扩容那一刻断掉。',
      '所以生产上的常见做法是**一开始就把分区数开大**（比如 100 个），',
      '宁可每个分区流量小一点，也不要面对扩容时的顺序断裂。',
      '',
      '还有一个这一关没做的问题：**分区内的队头阻塞**。',
      '一个处理特别慢的事件会把它后面同分区的所有事件都堵住，',
      '哪怕那些事件本来毫无关系（只是碰巧哈希到了一起）。',
      '这是分区模型的固有代价，缓解手段是把慢处理异步化，或者用更细的分区键。',
    ].join('\n'),
    [
      'Ordered within a partition, parallel across them is the core of Kafka\'s design and its biggest',
      'difference from traditional queues. RabbitMQ-style queues guarantee ordering across the whole queue,',
      'so parallelism requires several consumers and several consumers mean no ordering — you cannot have',
      'both. Kafka lowers the granularity of ordering to the partition, and for the first time ordered and',
      'parallel can hold simultaneously.',
      '',
      'The cost is that choosing the partition key becomes an architectural decision. By order id, each',
      'order is ordered but a hot order overloads its partition; by user id, all of a user\'s orders are',
      'ordered at a coarser grain; by a random value, there is no ordering at all. And the key is extremely',
      'hard to change afterwards: historical and new events would partition differently, one order\'s events',
      'would straddle two partitions, and the guarantee evaporates immediately.',
      '',
      'The partition count is equally hard to change. Kafka can add partitions, and afterwards the hash of',
      'a key changes, so new events go to a new partition while old ones remain — the ordering guarantee',
      'breaks at the moment of scaling. The common production answer is to over-provision partitions from',
      'the start, say a hundred, preferring less traffic per partition to an ordering break during growth.',
      '',
      'One problem this stage does not address: head-of-line blocking inside a partition. One unusually slow',
      'event blocks everything behind it in the same partition even when those events are entirely unrelated',
      'and merely hashed together. That is inherent to the model; the mitigations are making slow handling',
      'asynchronous or choosing a finer partition key.',
    ].join('\n')
  ),
  focus: ['concurrency', 'correctness', 'latency'],
  lab: {},
  starterFiles: [
    file(
      'src/partition.ts',
      code`
        import type { OrderEvent } from './contract';

        export interface PartitionOptions {
          partitions: number;
          /** Extract the partition key from an event */
          keyOf(event: OrderEvent): string;
        }

        export interface PartitionedBus {
          /** The returned Promise resolves once this event has been processed */
          publish(event: OrderEvent): Promise<void>;
          subscribe(handler: (event: OrderEvent) => Promise<void> | void): void;
          partitionOf(key: string): number;
          /** How many events are still in flight */
          pending(): number;
        }

        export function createPartitionedBus(options: PartitionOptions): PartitionedBus {
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
        import { createPartitionedBus } from '../src/partition';
        import { now, sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        function event(id: string, orderId: string) {
          return { id, type: 'order.event', payload: { orderId } };
        }

        const OPTIONS = {
          partitions: 4,
          keyOf: (e: any) => String(e.payload.orderId),
        };

        describe('Stage 3 · Partitioning and ordering', () => {
          it('the same key lands on the same partition every time', () => {
            const bus = createPartitionedBus(OPTIONS);
            const first = bus.partitionOf('order-1');
            for (let index = 0; index < 10; index += 1) {
              expect(bus.partitionOf('order-1')).toBe(first);
            }
            expect(first).toBeGreaterThanOrEqual(0);
            expect(first).toBeLessThan(4);
          });

          it("publish's Promise resolves when processing completes", async () => {
            const bus = createPartitionedBus(OPTIONS);
            let handled = false;
            bus.subscribe(async () => {
              await sleep(50);
              handled = true;
            });

            await bus.publish(event('e1', 'order-1'));
            expect(handled).toBe(true);
          });

          it('events for one order are processed strictly in publish order [gate:ordering]', async () => {
            const bus = createPartitionedBus(OPTIONS);
            const seen: number[] = [];
            bus.subscribe(async (incoming: any) => {
              // Deliberately make the earlier one slow and the later one fast; an out-of-order implementation cannot survive this
              await sleep(incoming.payload.index === 0 ? 80 : 10);
              seen.push(incoming.payload.index);
            });

            const published: Array<Promise<void>> = [];
            for (let index = 0; index < 12; index += 1) {
              published.push(
                bus.publish({ id: 'e' + index, type: 'x', payload: { orderId: 'order-1', index } })
              );
            }
            await Promise.all(published);

            let violations = 0;
            for (let index = 1; index < seen.length; index += 1) {
              if (seen[index] < seen[index - 1]) violations += 1;
            }
            count('orderViolations', violations);

            expect(seen).toHaveLength(12);
            expect(violations).toBe(0);
          });

          it('separate partitions make progress in parallel [gate:parallel]', async () => {
            const bus = createPartitionedBus(OPTIONS);
            bus.subscribe(async () => {
              await sleep(100);
            });

            // Find four keys that land on four different partitions
            const keys: string[] = [];
            const used = new Set<number>();
            for (let index = 0; keys.length < 4 && index < 200; index += 1) {
              const key = 'order-' + index;
              const partition = bus.partitionOf(key);
              if (!used.has(partition)) {
                used.add(partition);
                keys.push(key);
              }
            }
            expect(keys).toHaveLength(4);

            const startedAt = now();
            const published: Array<Promise<void>> = [];
            for (const key of keys) {
              for (let index = 0; index < 3; index += 1) {
                published.push(bus.publish(event(key + '-' + index, key)));
              }
            }
            await Promise.all(published);

            // Serial within a partition is 3 × 100ms; four partitions in parallel = 300ms.
            // A globally serial implementation takes 1200ms here
            expect(now() - startedAt).toBe(300);
          });

          it('publish completes even with no subscribers', async () => {
            const bus = createPartitionedBus(OPTIONS);
            await bus.publish(event('e1', 'order-1'));
            expect(bus.pending()).toBe(0);
          });

          it('a throwing handler does not wedge its partition', async () => {
            const bus = createPartitionedBus(OPTIONS);
            const seen: string[] = [];
            bus.subscribe(async (incoming: any) => {
              if (incoming.id === 'bad') throw new Error('handler exploded');
              seen.push(incoming.id);
            });

            await bus.publish({ id: 'first', type: 'x', payload: { orderId: 'order-1' } });
            await bus.publish({ id: 'bad', type: 'x', payload: { orderId: 'order-1' } });
            await bus.publish({ id: 'after', type: 'x', payload: { orderId: 'order-1' } });

            // In an implementation with a broken chain, the promise for 'after' never resolves
            expect(seen).toEqual(['first', 'after']);
          });

          it('pending reflects how many events are still unprocessed', async () => {
            const bus = createPartitionedBus(OPTIONS);
            bus.subscribe(async () => {
              await sleep(100);
            });

            const published = [
              bus.publish(event('e1', 'order-1')),
              bus.publish(event('e2', 'order-1')),
            ];
            await sleep(1);
            expect(bus.pending()).toBe(2);

            await Promise.all(published);
            expect(bus.pending()).toBe(0);
          });

          it('every subscriber receives the event', async () => {
            const bus = createPartitionedBus(OPTIONS);
            const seen: string[] = [];
            bus.subscribe(async () => {
              seen.push('a');
            });
            bus.subscribe(async () => {
              seen.push('b');
            });

            await bus.publish(event('e1', 'order-1'));
            expect(seen.sort()).toEqual(['a', 'b']);
          });

          it('separate orders do not block each other', async () => {
            const bus = createPartitionedBus({ partitions: 8, keyOf: OPTIONS.keyOf });
            bus.subscribe(async (incoming: any) => {
              await sleep(incoming.payload.orderId === 'slow' ? 500 : 20);
            });

            const slow = bus.publish(event('s1', 'slow'));
            await sleep(1);

            const startedAt = now();
            await bus.publish(event('f1', 'fast'));
            // The slow order sits on a different partition and should not hold this one up
            expect(now() - startedAt).toBeLessThanOrEqual(30);

            await slow;
          });

          it('a single partition degenerates to global ordering', async () => {
            const bus = createPartitionedBus({ partitions: 1, keyOf: OPTIONS.keyOf });
            const seen: string[] = [];
            bus.subscribe(async (incoming: any) => {
              await sleep(incoming.id === 'a' ? 50 : 5);
              seen.push(incoming.id);
            });

            await Promise.all([
              bus.publish(event('a', 'order-1')),
              bus.publish(event('b', 'order-2')),
            ]);
            expect(seen).toEqual(['a', 'b']);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.orderViolations',
      op: 'eq',
      value: 0,
      zh: '同一个订单的事件零乱序',
      en: 'Zero ordering inversions within one order',
      dimension: 'correctness',
      scope: 'gate:ordering',
    }),
    gate({
      metric: 'virtualElapsedMs',
      op: 'lte',
      value: 350,
      unit: 'ms',
      zh: '四个分区并行推进，不是排成一队',
      en: 'Four partitions advance in parallel rather than in one queue',
      dimension: 'concurrency',
      scope: 'gate:parallel',
    }),
  ],
  referenceFiles: [
    file(
      'src/partition.ts',
      code`
        import type { OrderEvent } from './contract';

        export interface PartitionOptions {
          partitions: number;
          keyOf(event: OrderEvent): string;
        }

        export interface PartitionedBus {
          publish(event: OrderEvent): Promise<void>;
          subscribe(handler: (event: OrderEvent) => Promise<void> | void): void;
          partitionOf(key: string): number;
          pending(): number;
        }

        function hash(text: string): number {
          let value = 2166136261;
          for (let index = 0; index < text.length; index += 1) {
            value ^= text.charCodeAt(index);
            value = Math.imul(value, 16777619);
          }
          return value >>> 0;
        }

        export function createPartitionedBus(options: PartitionOptions): PartitionedBus {
          const handlers: Array<(event: OrderEvent) => Promise<void> | void> = [];
          // One tail promise per partition, with new work chained onto it,
          // which makes a partition serial by construction while partitions stay independent
          const tails: Array<Promise<void>> = [];
          for (let index = 0; index < Math.max(1, options.partitions); index += 1) {
            tails.push(Promise.resolve());
          }
          let inFlight = 0;

          return {
            partitionOf(key: string): number {
              return hash(key) % tails.length;
            },

            subscribe(handler: (event: OrderEvent) => Promise<void> | void): void {
              handlers.push(handler);
            },

            publish(event: OrderEvent): Promise<void> {
              const partition = hash(options.keyOf(event)) % tails.length;
              inFlight += 1;

              const run = async (): Promise<void> => {
                try {
                  for (const handler of handlers.slice()) {
                    // Await one at a time within the partition: Promise.all here would throw the ordering guarantee away
                    await handler(event);
                  }
                } catch (error) {
                  // Swallow it: a single unhandled rejection breaks this chain and leaves
                  // every later event on the partition hanging forever
                } finally {
                  inFlight -= 1;
                }
              };

              const queued = tails[partition].then(run, run);
              tails[partition] = queued;
              return queued;
            },

            pending(): number {
              return inFlight;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**整个分区机制就是一个 promise 数组。** `tails[p].then(run)` 保证了',
      '「前一个完成才开始下一个」，而每个分区各有一条链，天然并行。',
      '不需要队列、不需要 worker、不需要调度器——JavaScript 的 promise 链本身',
      '就是一个 FIFO 的串行执行器。',
      '',
      '**`tails[partition].then(run, run)` 传了两个相同的回调。** 这不是笔误：',
      '无论上一个任务成功还是失败，这一个都必须开始。只写 `.then(run)` 的话，',
      '前一个失败会让链进入 rejected 状态，后面所有任务都被跳过——',
      '一个订单的一次处理失败会让它之后的所有事件永久卡住。',
      '',
      '**`run` 里的 try/catch 和链上的双回调是两道独立的防线。** 前者保证',
      '`run` 自己永远 resolve，后者保证即使 `run` 之外出了问题链也能继续。',
      '看起来冗余，但少了任一个，某条特定路径上就会出现「事件默默消失」。',
      '',
      '**`handlers.slice()` 复制一份再遍历。** 和第 2 关事件总线同一个理由：',
      'handler 在执行过程中可能调用 `subscribe`，直接遍历原数组会在迭代中改变它。',
    ].join('\n'),
    [
      'The entire partitioning mechanism is an array of promises. `tails[p].then(run)` enforces "the next',
      'starts only after the previous finishes", and each partition has its own chain so they run in',
      'parallel by construction. No queue, no workers, no scheduler — a JavaScript promise chain is already',
      'a FIFO serial executor.',
      '',
      '`tails[partition].then(run, run)` passes the same callback twice, and that is not a typo: this task',
      'must start whether the previous succeeded or failed. With only `.then(run)`, one failure puts the',
      'chain into a rejected state and every later task is skipped — one failed handling wedges every',
      'subsequent event for that order permanently.',
      '',
      'The try/catch inside `run` and the two-callback `then` are independent defences. The first',
      'guarantees `run` always resolves, the second keeps the chain moving even if something outside `run`',
      'goes wrong. It looks redundant, and dropping either one produces a path where events silently vanish.',
      '',
      '`handlers.slice()` copies before iterating, for the same reason as the event bus stage: a handler',
      'may call `subscribe` while running, and iterating the live array mutates what you are walking.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage4 = {
  id: 'middleware',
  title: t('第 4 关 · 洋葱式中间件', 'Stage 4 · Onion middleware'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '每个订单事件都要经过：日志 → 鉴权 → 限流 → 业务处理。',
      '这些横切关注点不该塞进业务函数，而应该组合起来。',
      '',
      '## 要实现什么',
      '',
      '在 `src/compose.ts` 实现 Koa 风格的 `compose(middlewares)`，',
      '返回一个 `(ctx, next?) => Promise<void>`：',
      '',
      '| 行为 | 说明 |',
      '| --- | --- |',
      '| 洋葱模型 | `await next()` 之后的代码在**回程**执行 |',
      '| 短路 | 中间件不调用 `next()`，后续整条链都不执行 |',
      '| 重复调用要报错 | 同一个中间件里 `next()` 被调两次必须抛错 |',
      '| 同步异常也要变 reject | 中间件同步抛错时，返回的 Promise 要 reject，不能让异常穿透出去 |',
      '',
      '`next?` 参数让 compose 出来的东西自己也是一个中间件 —— 可以再被 compose。',
      '',
      '## 怎么算过',
      '',
      '- 中间件按注册顺序进入，按相反顺序回来；',
      '- 不调 `next()` 时后面的中间件一个都不执行；',
      '- 调两次 `next()` 时返回的 Promise reject，消息说明是重复调用；',
      '- 中间件里抛出的异常能被外层中间件的 try/catch 捕获。',
      '',
      '## 为什么「调两次」值得专门防',
      '',
      '这是中间件最常见的 bug，而且它的症状极其难查：',
      '后半条链会被执行两次，于是订单被扣两次款、消息被发两遍，',
      '但日志上看不出任何异常 —— 因为每一次执行本身都是正常的。',
      '',
      '防它的办法很轻：记住「已经进入过的最深层数」，',
      '再进入一个不比它深的层数，就说明有人把同一个 `next` 调了第二次。',
      '',
      '这一关没有性能门槛。`compose` 本身不到 20 行，',
      '但系统之后往哪个方向扩展基本由它定 —— 后面几关的重试、幂等、追踪，',
      '全都会以中间件的形式挂上来。',
    ].join('\n'),
    [
      'Every order event flows through logging → auth → rate limiting → business logic. These cross-cutting',
      'concerns do not belong inside the business function; they should compose.',
      '',
      '## What to build',
      '',
      'Koa-style `compose(middlewares)` in `src/compose.ts`, returning a `(ctx, next?) => Promise<void>`:',
      '',
      '| Behaviour | Detail |',
      '| --- | --- |',
      '| The onion model | Code after `await next()` runs **on the way back out** |',
      '| Short-circuiting | A middleware that never calls `next()` stops the rest of the chain |',
      '| Double calls must throw | Calling `next()` twice inside one middleware must reject |',
      '| Sync throws become rejections | A middleware throwing synchronously must reject the returned promise, not escape it |',
      '',
      'The `next?` parameter is what makes a composed chain itself a middleware — composable again.',
      '',
      '## What counts as passing',
      '',
      '- Middlewares are entered in registration order and returned through in reverse;',
      '- Skipping `next()` runs none of the middlewares behind it;',
      '- Calling `next()` twice rejects with a message saying so;',
      '- An error thrown inside a middleware is catchable by the try/catch of an outer one.',
      '',
      '## Why the double call deserves its own guard',
      '',
      'It is the classic middleware bug, and its symptoms are miserable to trace: the back half of the chain',
      'runs twice, so an order is charged twice and a message is sent twice, while the logs show nothing',
      'wrong — because each individual execution was perfectly normal.',
      '',
      'Guarding it is cheap: remember the deepest layer already entered, and entering a layer no deeper than',
      'that means somebody called the same `next` a second time.',
      '',
      'This stage has no performance gate. `compose` is under 20 lines, but it decides how the whole system',
      'extends from here — the retries, idempotency and tracing of later stages all attach as middlewares.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**compose 内部** —— 一个 `dispatch` 递归，加一个防重复的 `index`',
      '',
      '```mermaid',
      'flowchart TD',
      '  C["compose(middlewares)"] --> R["返回 run(ctx, next?)<br/>它本身也是一个中间件，可以再被 compose"]',
      '  R --> D["dispatch(current)<br/>index = 已经进入过的最深层数"]',
      '  D --> GUARD{"current ≤ index？"}',
      '  GUARD -- 是 --> REJ["reject(\'next() called multiple times\')<br/>同一个 next 被调了第二次"]',
      '  GUARD -- 否 --> SET["index = current"]',
      '  SET --> PICK{"current === middlewares.length？"}',
      '  PICK -- 是 --> OUT["交给外层传进来的 next<br/>没有就直接 resolve"]',
      '  PICK -- 否 --> MW["middlewares[current](ctx, () => dispatch(current + 1))"]',
      '  MW --> WRAP["同步抛错在这里转成 reject<br/>否则调用方的 catch 接不住"]',
      '  MW -.中间件调用 next 时.-> D',
      '```',
      '',
      '整个洋葱只靠 `MW → D` 那条虚线回边支撑 —— 每一层拿到的 `next` 都是一个',
      '「调用下一层」的闭包，调用它就把控制权交下去，它 resolve 之后就是回程。',
      '`index` 是唯一的防重状态：没有它，同一个中间件把 `next()` 调两次，',
      '后半条链会安安静静地执行两遍。',
      '',
      '**执行起来的样子** —— `await next()` 把每一层劈成去程和回程',
      '',
      '```mermaid',
      'flowchart TD',
      '  A1["日志 · 去程"] --> A2["鉴权 · 去程"]',
      '  A2 --> A3["限流 · 去程"]',
      '  A3 --> CORE["业务处理"]',
      '  CORE --> B3["限流 · 回程"]',
      '  B3 --> B2["鉴权 · 回程"]',
      '  B2 --> B1["日志 · 回程"]',
      '```',
      '',
      '一个中间件不调用 `next()`，这条线就在它那里折返 —— 后面的层一个都不执行，',
      '这就是短路。',
    ].join('\n'),
    [
      '**Inside compose** — one recursive `dispatch` plus an `index` that prevents double entry',
      '',
      '```mermaid',
      'flowchart TD',
      '  C["compose(middlewares)"] --> R["return run(ctx, next?)<br/>itself a middleware, composable again"]',
      '  R --> D["dispatch(current)<br/>index = deepest layer already entered"]',
      '  D --> GUARD{"current ≤ index?"}',
      '  GUARD -- yes --> REJ["reject(\'next() called multiple times\')<br/>the same next was called twice"]',
      '  GUARD -- no --> SET["index = current"]',
      '  SET --> PICK{"current === middlewares.length?"}',
      '  PICK -- yes --> OUT["hand over to the outer next<br/>resolve if there is none"]',
      '  PICK -- no --> MW["middlewares[current](ctx, () => dispatch(current + 1))"]',
      '  MW --> WRAP["a synchronous throw becomes a rejection here<br/>otherwise the caller\'s catch cannot see it"]',
      '  MW -.when the middleware calls next.-> D',
      '```',
      '',
      'The entire onion rests on that dashed back-edge from `MW` to `D` — each layer receives a `next` that',
      'is a closure over "call the layer below", calling it hands control down, and its resolution is the way',
      'back out. `index` is the only guard state: without it, a middleware calling `next()` twice runs the',
      'back half of the chain twice, quietly.',
      '',
      '**What it looks like running** — `await next()` splits each layer into inbound and outbound',
      '',
      '```mermaid',
      'flowchart TD',
      '  A1["logging · in"] --> A2["auth · in"]',
      '  A2 --> A3["rate limit · in"]',
      '  A3 --> CORE["business logic"]',
      '  CORE --> B3["rate limit · out"]',
      '  B3 --> B2["auth · out"]',
      '  B2 --> B1["logging · out"]',
      '```',
      '',
      'A middleware that never calls `next()` turns the line around at its own level — nothing below it runs.',
      'That is short-circuiting.',
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
         * Compose an array of middleware into a single function.
         * Semantics match koa-compose.
         */
        export function compose(middlewares: Middleware[]): (ctx: Context, next?: Next) => Promise<void> {
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
        import { compose } from '../src/compose';
        import { sleep } from '@lab/env';

        function createContext() {
          return { event: { id: 'e1', type: 'order.created', payload: {} }, state: {} } as any;
        }

        describe('Stage 4 · Onion middleware', () => {
          it('runs in onion order', async () => {
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

          it('async middleware is awaited properly', async () => {
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

          it('not calling next short-circuits the rest of the chain', async () => {
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

          it('an error in middleware propagates to the caller', async () => {
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

          it('calling next twice throws', async () => {
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

          it('an empty middleware array runs safely', async () => {
            const run = compose([]);
            await run(createContext());
            expect(true).toBe(true);
          });

          it('middleware passes values through ctx.state', async () => {
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

          it('errors thrown on the way back out propagate too', async () => {
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
            // Downstream really did finish first
            expect(ctx.result).toBe('inner done');
          });

          it('middleware can catch downstream errors and degrade', async () => {
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

          it("the innermost next calls compose's second argument", async () => {
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

          it('sync middleware composes fine as well', async () => {
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

          it('a composed function is reusable and calls do not interfere', async () => {
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
            // index is the deepest level already entered, which is how a second next() on the same level is spotted
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

const stage5 = {
  id: 'consumer-group',
  title: t('第 5 关 · 消费者组与再平衡', 'Stage 5 · Consumer groups and rebalancing'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关把事件分到了 N 个分区。现在的问题是：谁来消费它们？',
      '',
      '一个进程消费全部分区，扩容就没意义了。多个进程各消费一部分，',
      '就需要一个分配机制回答两个问题：**每个分区归谁**，以及**有人加入或退出时怎么办**。',
      '',
      '## 要实现什么',
      '',
      '在 `src/group.ts` 实现 `createConsumerGroup(options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `join(id)` / `leave(id)` | 成员变化，触发再平衡 |',
      '| `assignmentOf(id)` | 这个消费者负责哪些分区 |',
      '| `ownerOf(partition)` | 这个分区归谁 |',
      '| `members()` / `rebalances()` | 当前成员、累计再平衡次数 |',
      '',
      '## 怎么算过',
      '',
      '- 每个分区**恰好一个主人**，不重不漏（门槛 `counters.doubleOwned = 0`）；',
      '- 12 个分区 3 个消费者，加入第 4 个时移动的分区数不超过 4',
      '  （门槛 `counters.partitionsMoved ≤ 4`）；',
      '- 消费者退出后它的分区被重新分给别人，不留无主分区；',
      '- 分配尽量均衡：每人 `base` 个，余数分给前几个。',
      '',
      '## 两条硬性要求各自在防什么',
      '',
      '**一个分区两个主人**，就是同一个订单被处理两次 ——',
      '第 7 关的幂等能兜住一部分，但这里本来就不该发生。',
      '',
      '**再平衡要「粘」。** 12 个分区 3 个消费者，加入第 4 个时，',
      '只需要移动 3 个分区就能达到均衡（4/4/4 → 3/3/3/3）。',
      '一个「全部推倒重分」的实现会移动 9 个 —— 而每次移动都意味着',
      '一个分区的消费停顿、本地缓存失效、消费进度重新加载。',
      '',
      '粘性的前提是**分配必须是有状态的**：记住现在谁拥有什么，在此基础上做最小调整。',
      '用 `partition % 成员数` 算出来的分配没有状态，成员数一变几乎所有分区都会换主 ——',
      '它满足第一条，但第二条会输得很难看。',
      '',
      '实现上有一处顺序陷阱：要在收回超额分区**之前**先记下「谁都持有什么」。',
      '用收回之后的状态去算哪些分区无主，刚被收回的那些会同时出现在',
      '「多出来的」和「无人认领的」两个列表里，于是被分配两次 —— 第一个门槛直接失败。',
    ].join('\n'),
    [
      'The previous stage split events into N partitions. The question now is who consumes them.',
      '',
      'One process consuming everything makes scaling pointless. Several processes each taking a share needs',
      'an assignment mechanism answering two questions: **who owns each partition**, and **what happens when',
      'a member joins or leaves**.',
      '',
      '## What to build',
      '',
      '`createConsumerGroup(options)` in `src/group.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `join(id)` / `leave(id)` | Membership changes, triggering a rebalance |',
      '| `assignmentOf(id)` | The partitions a consumer owns |',
      '| `ownerOf(partition)` | The owner of a partition |',
      '| `members()` / `rebalances()` | Current members, total rebalances so far |',
      '',
      '## What counts as passing',
      '',
      '- **Exactly one owner** per partition, none doubled and none dropped (`counters.doubleOwned = 0`);',
      '- With twelve partitions and three consumers, adding a fourth moves at most four partitions',
      '  (`counters.partitionsMoved ≤ 4`);',
      '- A departing consumer\'s partitions are reassigned, leaving none unowned;',
      '- Assignment stays balanced: `base` each, with the remainder going to the first few.',
      '',
      '## What each requirement defends',
      '',
      '**Two owners on one partition** means the same order processed twice — stage 7\'s idempotency covers',
      'some of that, and it should not be happening here at all.',
      '',
      '**Rebalancing must be sticky.** With twelve partitions and three consumers, adding a fourth needs only',
      'three partitions to move (4/4/4 becomes 3/3/3/3). A tear-down-and-redistribute implementation moves',
      'nine — and every move means a partition stops being consumed, its local cache is lost and its progress',
      'must be reloaded.',
      '',
      'Stickiness requires the assignment to be **stateful**: remember who owns what and adjust minimally',
      'from there. An assignment computed as `partition % memberCount` has no state, so almost every',
      'partition changes owner whenever the member count does — it satisfies the first requirement and loses',
      'the second badly.',
      '',
      'There is an ordering trap in the implementation: record "who holds what" **before** revoking surplus',
      'partitions. Compute the unowned set from the post-revocation state and the just-revoked partitions',
      'appear in both the "surplus" list and the "unclaimed" list, getting assigned twice — which fails the',
      'first gate outright.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  J["join(id)：加入成员列表尾部"] --> RB',
      '  L["leave(id)：移出成员列表<br/>必须真的重分，只标无主等于没人消费"] --> RB["rebalance()"]',
      '',
      '  RB --> T["算每人的目标数<br/>base = 分区数 / 人数<br/>余数 extra 分给前 extra 个人"]',
      '  T --> BEFORE["heldBefore = 调整前所有人持有的分区<br/>必须在收回之前拍这张快照"]',
      '  BEFORE --> S1["第一步 · 收回超额<br/>每人只留前 target 个<br/>多出来的进 orphans"]',
      '  S1 --> S2["再把 heldBefore 里没有的分区<br/>（从来没人认领的）也加进 orphans"]',
      '  S2 --> S3["第二步 · 补齐<br/>orphans 依次发给还不够 target 的人"]',
      '  S3 --> KEEP["没被这两步碰到的分配原封不动<br/>—— 粘性就在这里"]',
      '',
      '  subgraph state["状态：assignments 是有状态的分配表"]',
      '    ST1["消费者 → 它持有的分区数组"]',
      '    ST2["没有它，就只能每次按 partition % 人数 重算<br/>人数一变几乎全部换主"]',
      '  end',
      '```',
      '',
      '要点：整个再平衡只做两件事 —— **收回**和**补齐**，中间那条 `KEEP` 说的是它不做的事：',
      '不重新计算任何一个已经平衡的分配。移动量因此等于「必须移动的最小量」。',
      '',
      '`BEFORE` 的位置是这张图里唯一不能挪的一步。放到 `S1` 之后，',
      '刚被收回的分区会同时出现在 orphans 和「无人认领」里，被发给两个人。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  J["join(id): append to the member list"] --> RB',
      '  L["leave(id): remove from the member list<br/>a real reassignment, since merely marking unowned means nobody consumes"] --> RB["rebalance()"]',
      '',
      '  RB --> T["compute each member\'s target<br/>base = partitions / members<br/>the remainder goes to the first few"]',
      '  T --> BEFORE["heldBefore = every partition held before adjusting<br/>this snapshot must be taken before revoking"]',
      '  BEFORE --> S1["step 1 · revoke surplus<br/>each member keeps its first target partitions<br/>the rest join orphans"]',
      '  S1 --> S2["then add partitions absent from heldBefore<br/>(never claimed by anyone) to orphans"]',
      '  S2 --> S3["step 2 · top up<br/>hand orphans to whoever is below target"]',
      '  S3 --> KEEP["assignments untouched by those two steps stay exactly as they were<br/>— that is the stickiness"]',
      '',
      '  subgraph state["state: assignments is a stateful ownership table"]',
      '    ST1["consumer → the partitions it holds"]',
      '    ST2["without it, the only option is recomputing partition % members<br/>which reshuffles nearly everything on any change"]',
      '  end',
      '```',
      '',
      'The point: rebalancing does exactly two things — **revoke** and **top up** — and the `KEEP` node',
      'states what it does not do: recompute any assignment that is already balanced. The movement count is',
      'therefore the minimum possible.',
      '',
      '`BEFORE`\'s position is the one step in this diagram that cannot move. Place it after `S1` and the',
      'just-revoked partitions appear both in orphans and as unclaimed, and get handed to two members.',
    ].join('\n')
  ),
  checklist: [
    t('每个分区恰好一个主人', 'Exactly one owner per partition'),
    t('分配尽量均匀', 'Assignment is as even as possible'),
    t('成员退出后它的分区被接管', "A departing member's partitions are taken over"),
    t('再平衡尽量少移动分区', 'Rebalancing moves as few partitions as possible'),
    t('没有成员时所有分区无主', 'With no members, no partition has an owner'),
  ],
  pitfalls: [
    t(
      '再平衡时先清空所有分配再重新分。结果是均匀的，代价是每个分区都换了主人——所有消费者的本地状态作废、消费位点重新加载、处理停顿。Kafka 早期的 range 和 round-robin 分配器就是这样，直到 2.4 才引入 sticky 分配器，因为大集群的再平衡停顿能到分钟级。',
      'Clearing every assignment and redistributing on rebalance. The result is even and every partition has changed hands, so all local state is void, offsets are reloaded and consumption pauses. Kafka\'s early range and round-robin assignors did this, and sticky assignment only arrived in 2.4, because rebalance pauses on large clusters reached minutes.'
    ),
    t(
      '成员退出时只把它的分区标成无主，不重新分配。分区从此没人消费，事件无声地堆积——而监控上「消费者数量」是正常的（剩下的都活着），只有消费延迟在悄悄上涨。退出必须触发一次真正的再分配。',
      "Marking a departing member's partitions as unowned without reassigning them. Nobody consumes them and events pile up silently, while the consumer-count metric looks fine because the survivors are all alive and only lag creeps upward. Leaving must trigger a real reassignment."
    ),
    t(
      '用 `分区号 % 消费者数` 直接算主人。简单，而且消费者数一变几乎所有分区都换主——这是一致性哈希那一课在另一个场景的重演。分配必须是有状态的：记住现在谁拥有什么，在此基础上做最小调整。',
      'Computing the owner as `partition % consumerCount`. Simple, and changing the consumer count moves nearly every partition — the consistent-hashing lesson replayed in another setting. Assignment must be stateful: remember who owns what and adjust minimally from there.'
    ),
    t(
      '允许分配不均，比如 12 个分区 4 个消费者分成 6/2/2/2。每个分区确实有唯一主人，粘性也很好，但那个拿了 6 个分区的消费者会成为瓶颈。再平衡要同时满足「唯一」「均匀」「少移动」三条，前两条是硬约束，第三条是在满足前两条的前提下优化。',
      'Tolerating uneven assignment such as 6/2/2/2 across twelve partitions and four consumers. Every partition has a unique owner and stickiness is excellent, and the consumer holding six becomes the bottleneck. Rebalancing must satisfy uniqueness, evenness and minimal movement together — the first two are constraints and the third is what you optimise within them.'
    ),
  ],
  hints: [
    t(
      '再平衡分三步：算出每个消费者的目标数量；把超额的分区收回来（连同无主的）；把收回来的分给不足的。前两步之外的分配原封不动，粘性就自然有了。',
      'Rebalance in three steps: compute each consumer\'s target count, reclaim surplus partitions (along with unowned ones), and hand the reclaimed set to those below target. Everything not touched by the first two steps stays put, which is where stickiness comes from.'
    ),
    t(
      '目标数量：`base = floor(P / C)`，前 `P % C` 个消费者多分一个。',
      'Target counts: `base = floor(P / C)`, with the first `P % C` consumers taking one extra.'
    ),
  ],
  extension: t(
    [
      '再平衡的代价在真实系统里比想象中大。Kafka 早期用的是 **stop-the-world 再平衡**：',
      '任何成员变化都会让**整个组**停止消费，重新协商分配，然后恢复。',
      '一个 200 个消费者的组，滚动重启时会触发 200 次全组停顿。',
      '',
      'Kafka 2.4 引入了两个改进。**Sticky 分配器**就是这一关做的事——尽量不动。',
      '**增量协作式再平衡**（incremental cooperative rebalancing）更进一步：',
      '不停整个组，只让需要交出分区的消费者交出，其他人继续消费。',
      '代价是需要两轮协商（先撤销，再分配），协议复杂度显著上升。',
      '',
      '另一个方向是**静态成员**（static membership）：给消费者一个固定 id，',
      '短暂断线重连时不触发再平衡，直接把原来的分区还给它。',
      '这专门解决滚动重启和 K8s 滚动更新的场景——那种情况下成员其实没变，',
      '只是同一个成员换了个进程。',
      '',
      '还有一个这一关刻意回避的问题：**再平衡期间的重复消费**。',
      '消费者 A 交出分区 3 的那一刻，它可能还有一个事件正在处理中。',
      'B 接管后从上次提交的位点开始消费，于是那个事件被处理两次。',
      '这是 at-least-once 语义的直接来源，也是第 7 关幂等存在的理由——',
      '再平衡做得再好，都消除不了这个窗口。',
    ].join('\n'),
    [
      'Rebalancing costs more in real systems than one expects. Early Kafka used stop-the-world',
      'rebalancing: any membership change halted the entire group, renegotiated assignments and resumed. A',
      'group of two hundred consumers triggers two hundred full-group pauses during a rolling restart.',
      '',
      'Kafka 2.4 brought two improvements. The sticky assignor is what this stage builds — move as little',
      'as possible. Incremental cooperative rebalancing goes further: rather than stopping the group, only',
      'consumers that must surrender partitions do so while everyone else keeps consuming. The price is two',
      'rounds of negotiation (revoke, then assign) and a substantially more complex protocol.',
      '',
      'Another direction is static membership: give each consumer a fixed id so a brief disconnect and',
      'reconnect does not trigger a rebalance and its partitions are simply returned. That targets rolling',
      'restarts and Kubernetes rolling updates specifically, where membership has not really changed and',
      'the same member merely moved to a new process.',
      '',
      'One problem this stage deliberately avoids: duplicate consumption during a rebalance. At the moment',
      'consumer A surrenders partition 3 it may still have an event in flight; B takes over from the last',
      'committed offset and processes that event again. This is the direct source of at-least-once',
      "semantics and the reason stage 7's idempotency exists — no amount of rebalancing finesse closes",
      'that window.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'concurrency'],
  lab: {},
  starterFiles: [
    file(
      'src/group.ts',
      code`
        export interface GroupOptions {
          partitions: number;
        }

        export interface ConsumerGroup {
          join(consumerId: string): void;
          leave(consumerId: string): void;
          /** Partitions this consumer owns, ascending */
          assignmentOf(consumerId: string): number[];
          /** Who owns this partition; null when unowned */
          ownerOf(partition: number): string | null;
          members(): string[];
          rebalances(): number;
        }

        export function createConsumerGroup(options: GroupOptions): ConsumerGroup {
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
        import { createConsumerGroup } from '../src/group';
        import { count } from '@lab/metrics';

        function snapshot(group: any, partitions: number): Array<string | null> {
          const owners: Array<string | null> = [];
          for (let index = 0; index < partitions; index += 1) owners.push(group.ownerOf(index));
          return owners;
        }

        describe('Stage 5 · Consumer groups', () => {
          it('with no members every partition is unowned', () => {
            const group = createConsumerGroup({ partitions: 6 });
            expect(snapshot(group, 6)).toEqual([null, null, null, null, null, null]);
          });

          it('a single consumer takes every partition', () => {
            const group = createConsumerGroup({ partitions: 6 });
            group.join('c1');
            expect(group.assignmentOf('c1')).toEqual([0, 1, 2, 3, 4, 5]);
          });

          it('two consumers split them evenly', () => {
            const group = createConsumerGroup({ partitions: 6 });
            group.join('c1');
            group.join('c2');
            expect(group.assignmentOf('c1')).toHaveLength(3);
            expect(group.assignmentOf('c2')).toHaveLength(3);
          });

          it('an uneven split differs by at most 1', () => {
            const group = createConsumerGroup({ partitions: 7 });
            group.join('c1');
            group.join('c2');
            group.join('c3');
            const sizes = ['c1', 'c2', 'c3'].map((id) => group.assignmentOf(id).length).sort();
            expect(sizes).toEqual([2, 2, 3]);
          });

          it('every partition has exactly one owner [gate:exclusive]', () => {
            const group = createConsumerGroup({ partitions: 12 });
            for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) group.join(id);

            const seen = new Map<number, number>();
            for (const id of group.members()) {
              for (const partition of group.assignmentOf(id)) {
                seen.set(partition, (seen.get(partition) || 0) + 1);
              }
            }

            let doubleOwned = 0;
            let unowned = 0;
            for (let index = 0; index < 12; index += 1) {
              const owners = seen.get(index) || 0;
              if (owners > 1) doubleOwned += 1;
              if (owners === 0) unowned += 1;
            }
            count('doubleOwned', doubleOwned + unowned);

            expect(doubleOwned).toBe(0);
            expect(unowned).toBe(0);
          });

          it("a departed member's partitions are taken over", () => {
            const group = createConsumerGroup({ partitions: 6 });
            group.join('c1');
            group.join('c2');
            const orphaned = group.assignmentOf('c2');

            group.leave('c2');
            expect(group.assignmentOf('c1')).toHaveLength(6);
            for (const partition of orphaned) {
              expect(group.ownerOf(partition)).toBe('c1');
            }
          });

          it('once everyone leaves the partitions are unowned again', () => {
            const group = createConsumerGroup({ partitions: 4 });
            group.join('c1');
            group.leave('c1');
            expect(snapshot(group, 4)).toEqual([null, null, null, null]);
          });

          it('joining twice with the same id does not assign twice', () => {
            const group = createConsumerGroup({ partitions: 6 });
            group.join('c1');
            group.join('c1');
            expect(group.members()).toEqual(['c1']);
            expect(group.assignmentOf('c1')).toHaveLength(6);
          });

          it('leaving with an unknown member is a no-op', () => {
            const group = createConsumerGroup({ partitions: 4 });
            group.join('c1');
            const before = group.rebalances();
            group.leave('ghost');
            expect(group.rebalances()).toBe(before);
          });

          it('rebalances counts how many rebalances happened', () => {
            const group = createConsumerGroup({ partitions: 4 });
            group.join('c1');
            group.join('c2');
            group.leave('c1');
            expect(group.rebalances()).toBe(3);
          });

          it('a new member only moves the partitions it has to [gate:sticky]', () => {
            const group = createConsumerGroup({ partitions: 12 });
            for (const id of ['c1', 'c2', 'c3']) group.join(id);
            const before = snapshot(group, 12);

            group.join('c4');
            const after = snapshot(group, 12);

            let moved = 0;
            for (let index = 0; index < 12; index += 1) {
              if (before[index] !== after[index]) moved += 1;
            }
            count('partitionsMoved', moved);

            // 4/4/4 -> 3/3/3/3 only needs three to move.
            // An implementation that reassigns from scratch moves nine
            expect(moved).toBeLessThanOrEqual(4);
            expect(group.assignmentOf('c4')).toHaveLength(3);
          });

          it('a member leaving does not disturb what others already hold', () => {
            const group = createConsumerGroup({ partitions: 12 });
            for (const id of ['c1', 'c2', 'c3', 'c4']) group.join(id);
            const keptBefore = group.assignmentOf('c1');

            group.leave('c4');
            const keptAfter = group.assignmentOf('c1');

            // Everything c1 held should still be c1's; it may just have picked up a few more
            for (const partition of keptBefore) {
              expect(keptAfter).toContain(partition);
            }
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.doubleOwned',
      op: 'eq',
      value: 0,
      zh: '每个分区恰好一个主人，不重不漏',
      en: 'Exactly one owner per partition, none doubled or dropped',
      dimension: 'correctness',
      scope: 'gate:exclusive',
    }),
    gate({
      metric: 'counters.partitionsMoved',
      op: 'lte',
      value: 4,
      zh: '新成员加入只移动必要的分区',
      en: 'A joining member moves only the partitions it must',
      dimension: 'resilience',
      scope: 'gate:sticky',
    }),
  ],
  referenceFiles: [
    file(
      'src/group.ts',
      code`
        export interface GroupOptions {
          partitions: number;
        }

        export interface ConsumerGroup {
          join(consumerId: string): void;
          leave(consumerId: string): void;
          assignmentOf(consumerId: string): number[];
          ownerOf(partition: number): string | null;
          members(): string[];
          rebalances(): number;
        }

        export function createConsumerGroup(options: GroupOptions): ConsumerGroup {
          const order: string[] = [];
          // Assignment is stateful: remember who owns what right now and adjust minimally from there.
          // An assignment computed as partition % memberCount has no state,
          // so almost every partition changes hands the moment the member count does
          const assignments = new Map<string, number[]>();
          let rebalanceCount = 0;

          function rebalance(): void {
            rebalanceCount += 1;
            if (order.length === 0) {
              assignments.clear();
              return;
            }

            const base = Math.floor(options.partitions / order.length);
            const extra = options.partitions % order.length;
            const targetOf = (index: number) => base + (index < extra ? 1 : 0);

            // Record who held what *before* the adjustment. Computing unowned partitions from the
            // post-adjustment keep would list the just-revoked ones as both surplus and unowned, assigning them twice
            const heldBefore = new Set<number>();
            for (const id of order) {
              for (const partition of assignments.get(id) || []) heldBefore.add(partition);
            }

            // Step one: revoke the surplus
            const orphans: number[] = [];
            order.forEach((id, index) => {
              const current = (assignments.get(id) || []).slice().sort((a, b) => a - b);
              assignments.set(id, current.slice(0, targetOf(index)));
              for (const partition of current.slice(targetOf(index))) orphans.push(partition);
            });
            // Plus the ones that were never claimed
            for (let partition = 0; partition < options.partitions; partition += 1) {
              if (!heldBefore.has(partition)) orphans.push(partition);
            }
            orphans.sort((a, b) => a - b);

            // Step two: hand the revoked ones to whoever is short. Anything untouched by these two steps
            // stays exactly where it was — that is where the stickiness comes from
            let cursor = 0;
            order.forEach((id, index) => {
              const current = assignments.get(id) as number[];
              while (current.length < targetOf(index) && cursor < orphans.length) {
                current.push(orphans[cursor]);
                cursor += 1;
              }
              current.sort((a, b) => a - b);
            });
          }

          return {
            join(consumerId: string): void {
              if (order.indexOf(consumerId) !== -1) return;
              order.push(consumerId);
              assignments.set(consumerId, []);
              rebalance();
            },

            leave(consumerId: string): void {
              const index = order.indexOf(consumerId);
              if (index === -1) return;
              order.splice(index, 1);
              assignments.delete(consumerId);
              // Leaving has to trigger a real reassignment: merely marking partitions unowned
              // leaves them with no consumer while monitoring shows nothing wrong
              rebalance();
            },

            assignmentOf(consumerId: string): number[] {
              return (assignments.get(consumerId) || []).slice();
            },

            ownerOf(partition: number): string | null {
              for (const entry of Array.from(assignments.entries())) {
                if (entry[1].indexOf(partition) !== -1) return entry[0];
              }
              return null;
            },

            members(): string[] {
              return order.slice();
            },

            rebalances(): number {
              return rebalanceCount;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**再平衡的两步结构是粘性的全部来源。** 第一步只收回「超出目标数量」的部分，',
      '第二步只填补「不足目标数量」的部分。中间那些正好达标的消费者，',
      '它们的分区从头到尾没被碰过。写成「先全清空再重分」，代码更短，',
      '但每个分区都会换主人。',
      '',
      '**`current.slice(0, target)` 保留的是排序后的前 N 个。** 保留哪几个其实无所谓，',
      '重要的是**确定性**——同样的输入必须得到同样的输出，否则再平衡会在',
      '「没有实际变化」的情况下也产生移动。排序是最简单的确定性来源。',
      '',
      '**`targetOf` 让前 `extra` 个消费者多拿一个。** 12 个分区 5 个消费者时是',
      '3/3/2/2/2，任意两个消费者的差不超过 1。允许 6/2/2/2 这种分配的实现',
      '在唯一性和粘性上都完美，但那个拿 6 个的消费者会成为瓶颈——',
      '均匀是硬约束，不是优化目标。',
      '',
      '**`leave` 里的 `rebalance()` 不能省。** 只把成员从列表里删掉、',
      '把它的分配删掉，那些分区就变成无主状态了。',
      '而「无主」在这个模型里不会自动被谁接管——事件会一直堆积，',
      '而消费者数量、错误率这些指标全都正常。',
    ].join('\n'),
    [
      'The two-step structure of the rebalance is where all the stickiness comes from. The first step',
      'reclaims only what exceeds the target, the second fills only what falls short, and consumers already',
      'exactly at target are never touched. Clearing everything and redistributing is shorter code and',
      'moves every partition.',
      '',
      '`current.slice(0, target)` keeps the first N after sorting. Which ones are kept does not matter; what',
      'matters is determinism — the same input must give the same output, or a rebalance produces movement',
      'even when nothing actually changed. Sorting is the simplest source of that.',
      '',
      '`targetOf` gives the first `extra` consumers one more each, so twelve partitions across five',
      'consumers is 3/3/2/2/2 and no two differ by more than one. An implementation allowing 6/2/2/2 is',
      'perfect on uniqueness and stickiness, and the consumer holding six becomes the bottleneck. Evenness',
      'is a constraint, not an optimisation target.',
      '',
      'The `rebalance()` inside `leave` cannot be omitted. Removing the member and deleting its assignment',
      'leaves those partitions unowned, and unowned partitions are not adopted by anyone in this model —',
      'events accumulate indefinitely while consumer count, error rate and every other metric look normal.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const databaseSupport = readonlyFile(
  'src/support/db.ts',
  code`
    /**
     * Minimal database (read-only, provided by the platform)
     *
     * It offers only what this stage needs: a transaction that really does roll back.
     * When work throws, every write in the transaction is undone together.
     */
    export interface Tx {
      insert(table: string, row: Record<string, unknown>): void;
      update(table: string, match: (row: Record<string, unknown>) => boolean, patch: Record<string, unknown>): void;
    }

    export interface Database {
      /** If work throws, the whole transaction rolls back and the error keeps propagating */
      transaction<T>(work: (tx: Tx) => T): T;
      rows(table: string): Array<Record<string, unknown>>;
    }

    export function createDatabase(): Database {
      const tables = new Map<string, Array<Record<string, unknown>>>();

      function tableOf(name: string): Array<Record<string, unknown>> {
        const existing = tables.get(name);
        if (existing) return existing;
        const created: Array<Record<string, unknown>> = [];
        tables.set(name, created);
        return created;
      }

      return {
        transaction<T>(work: (tx: Tx) => T): T {
          const snapshot = new Map<string, Array<Record<string, unknown>>>();
          for (const entry of Array.from(tables.entries())) {
            snapshot.set(entry[0], entry[1].map((row) => ({ ...row })));
          }

          const tx: Tx = {
            insert(table: string, row: Record<string, unknown>): void {
              tableOf(table).push({ ...row });
            },
            update(table, match, patch): void {
              for (const row of tableOf(table)) {
                if (match(row)) Object.assign(row, patch);
              }
            },
          };

          try {
            return work(tx);
          } catch (error) {
            tables.clear();
            for (const entry of Array.from(snapshot.entries())) tables.set(entry[0], entry[1]);
            throw error;
          }
        },

        rows(table: string): Array<Record<string, unknown>> {
          return tableOf(table).map((row) => ({ ...row }));
        },
      };
    }
  `
);

const stage6 = {
  id: 'outbox',
  title: t('第 6 关 · 事务性 outbox', 'Stage 6 · The transactional outbox'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '到这里，事件的分发、排序、消费都做完了。但有一个问题一直被回避着：',
      '**事件是怎么产生的？**',
      '',
      '最直觉的写法是：',
      '',
      '```ts',
      'await db.insert(\'orders\', order);',
      'await bus.publish({ type: \'order.created\', ... });',
      '```',
      '',
      '这两行之间有一个致命的缝隙。进程在第一行之后崩溃 ——',
      '订单落库了，事件没发出去，下游永远不知道有这个订单。',
      '把两行调换顺序也不行：事件发出去了，订单没落库，下游收到一个不存在订单的通知。',
      '',
      '**数据库事务和消息队列不在同一个事务里**，这个缝隙无法用重试或者小心翼翼消除。',
      '',
      'Outbox 模式的答案是：**先别发消息**。把事件当作一行数据，',
      '和业务数据写在**同一个数据库事务**里；再由一个独立的投递器把它读出来发走。',
      '',
      '## 要实现什么',
      '',
      '在 `src/outbox.ts` 实现 `createOutbox(db)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `commit(work)` | 在一个事务里执行 `work`，把它返回的事件写进 outbox 表；`work` 抛错则业务数据和事件**一起回滚** |',
      '| `dispatch(publish)` | 把未投递的事件依次发出去，成功的标记为已投递，返回本轮发了几条 |',
      '| `pending()` | 还有多少事件没投递 |',
      '',
      '## 怎么算过',
      '',
      '- 业务写入回滚时，outbox 里不留下孤儿事件（门槛 `counters.orphanEvents = 0`）；',
      '- 投递失败的事件一个都不丢，重试之后全部送达（门槛 `counters.lostEvents = 0`）；',
      '- 已投递的事件不会被重复发送；',
      '- 同一个订单的事件按写入顺序送达。',
      '',
      '## 三处顺序决定了这一关的成败',
      '',
      '**`tx.insert` 必须在事务回调里面。** 挪到 `db.transaction(...)` 外面，',
      '就退回成了「先写库再写 outbox」的两步问题 —— 你什么也没解决，只是把缝隙挪了个位置。',
      '',
      '**先发送，成功了再标记已投递。** 反过来的话，发送失败的事件已经被标成已投递，',
      '永远不会重试 —— 这就是静默丢失。这个顺序把「至少一次」变成了系统的保证：',
      '崩溃在发送和标记之间，最坏结果是重发一次，而重复投递正是下一关要解决的问题。',
      '',
      '**投递失败要 `break`，不是 `continue`。** 跳过失败的继续发下一条，',
      '会让同一个订单的事件倒序送达 —— 下游先看到「已支付」再看到「已创建」。',
    ].join('\n'),
    [
      'Dispatch, ordering and consumption are all done. One question has been dodged throughout: **where do',
      'events come from?**',
      '',
      'The intuitive version is:',
      '',
      '```ts',
      'await db.insert(\'orders\', order);',
      'await bus.publish({ type: \'order.created\', ... });',
      '```',
      '',
      'There is a fatal gap between those two lines. The process dies after the first — the order is stored',
      'and no event was published, so nothing downstream ever learns it exists. Swapping the lines does not',
      'help: the event goes out, the order does not persist, and downstream is notified about an order that',
      'never existed.',
      '',
      '**The database and the message broker are not in one transaction**, and no amount of retrying or care',
      'closes that gap.',
      '',
      'The outbox answer is: **do not publish yet**. Treat the event as a row and write it in the **same',
      'database transaction** as the business data, then let a separate dispatcher read and deliver it.',
      '',
      '## What to build',
      '',
      '`createOutbox(db)` in `src/outbox.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `commit(work)` | Run `work` in a transaction and store the events it returns; if `work` throws, business data and events **roll back together** |',
      '| `dispatch(publish)` | Send undelivered events in order, mark the successful ones, return how many went out |',
      '| `pending()` | How many remain undelivered |',
      '',
      '## What counts as passing',
      '',
      '- A rolled-back business write leaves no orphan event (`counters.orphanEvents = 0`);',
      '- No event that failed to publish is lost — a later dispatch delivers every one (`counters.lostEvents = 0`);',
      '- Already-delivered events are never sent again;',
      '- Events for one order arrive in the order they were written.',
      '',
      '## Three orderings decide this stage',
      '',
      '**`tx.insert` must be inside the transaction callback.** Move it outside `db.transaction(...)` and you',
      'are back to the two-step "write the database, then write the outbox" problem — nothing is solved, the',
      'gap has merely moved.',
      '',
      '**Publish first, mark delivered second.** Reversed, an event that failed to send is already marked',
      'delivered and will never be retried — that is silent loss. This ordering is what turns "at least once"',
      'into a guarantee: a crash between sending and marking costs one duplicate delivery at worst, and',
      'duplicates are exactly what the next stage handles.',
      '',
      '**A failed publish must `break`, not `continue`.** Skipping the failure and sending the next event',
      'delivers one order\'s events out of order — downstream sees "paid" before "created".',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  subgraph commit["commit(work) · 写入侧"]',
      '    C1["db.transaction(tx => ...)"] --> C2["work(tx)：写业务数据<br/>返回本次要发的事件"]',
      '    C2 --> C3["同一个事务回调里：<br/>tx.insert(\'outbox\', { ...事件, delivered: false })"]',
      '    C3 --> C4{"work 抛错了吗？"}',
      '    C4 -- 抛了 --> RB["整个事务回滚<br/>业务数据和事件一起消失，没有孤儿"]',
      '    C4 -- 没有 --> CM["业务数据和事件一起提交"]',
      '  end',
      '',
      '  subgraph dispatch["dispatch(publish) · 投递侧，和业务完全解耦"]',
      '    D1["读出 delivered = false 的行，保持写入顺序"] --> D2["逐行 await publish(event)"]',
      '    D2 --> D3{"发出去了吗？"}',
      '    D3 -- 成功 --> D4["再开一个事务标记 delivered = true<br/>顺序：先发送，后标记"]',
      '    D4 --> D2',
      '    D3 -- 失败 --> BRK["break —— 中断整批<br/>剩下的留到下一轮，顺序不乱"]',
      '  end',
      '',
      '  CM -.事件作为普通数据行躺在库里等着.-> D1',
      '```',
      '',
      '要点：两个 subgraph 之间只有一条虚线，而且是**异步**的 ——',
      '写入侧从头到尾没有网络调用，所以它可以被数据库事务完整保护。',
      '这就是 outbox 的全部思想：把「跨系统的原子性」换成「同库的原子性 + 之后的重试」。',
      '',
      '`D4` 在 `D2` 之后是唯一正确的顺序；调过来就变成了至多一次投递，',
      '而至多一次的另一个名字是「可能丢」。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  subgraph commit["commit(work) · the write side"]',
      '    C1["db.transaction(tx => ...)"] --> C2["work(tx): write business data<br/>return the events to publish"]',
      '    C2 --> C3["inside the same transaction callback:<br/>tx.insert(\'outbox\', { ...event, delivered: false })"]',
      '    C3 --> C4{"did work throw?"}',
      '    C4 -- yes --> RB["the whole transaction rolls back<br/>business data and events vanish together, no orphans"]',
      '    C4 -- no --> CM["business data and events commit together"]',
      '  end',
      '',
      '  subgraph dispatch["dispatch(publish) · the delivery side, fully decoupled"]',
      '    D1["read rows with delivered = false, in write order"] --> D2["await publish(event), one at a time"]',
      '    D2 --> D3{"did it go out?"}',
      '    D3 -- succeeded --> D4["open a transaction to mark delivered = true<br/>order: publish first, mark second"]',
      '    D4 --> D2',
      '    D3 -- failed --> BRK["break — stop the batch<br/>the rest waits for the next round, order preserved"]',
      '  end',
      '',
      '  CM -.the event sits in the database as an ordinary row.-> D1',
      '```',
      '',
      'The point: the two subgraphs are joined by a single dashed, **asynchronous** edge — the write side',
      'makes no network call at all, which is why a database transaction can protect it completely. That is',
      'the whole idea of the outbox: trade cross-system atomicity for same-database atomicity plus a retry',
      'afterwards.',
      '',
      '`D4` following `D2` is the only correct order; reversed it becomes at-most-once delivery, and',
      'at-most-once is another name for "may be lost".',
    ].join('\n')
  ),
  checklist: [
    t('业务数据和事件在同一个事务里写入', 'Business data and events are written in one transaction'),
    t('业务失败时事件一起回滚', 'A failed business write rolls the events back with it'),
    t('投递成功的事件被标记，不会重发', 'Delivered events are marked and not resent'),
    t('投递失败的事件保留，下次继续', 'Failed deliveries stay pending for the next attempt'),
    t('投递顺序与写入顺序一致', 'Delivery order matches write order'),
  ],
  pitfalls: [
    t(
      '在事务提交之后再往 outbox 表里写事件。这就退回到了原来的两步问题，只是把「数据库和队列」换成了「数据库和数据库」——中间崩溃仍然会产生孤儿。事件的写入必须发生在业务写入的**同一个** `transaction` 回调里面。',
      'Inserting into the outbox after the transaction commits. That is the original two-step problem again with "database and queue" replaced by "database and database" — a crash in between still orphans data. The event insert must happen inside the very same `transaction` callback as the business write.'
    ),
    t(
      '投递前先标记为已发送，再调用 publish。发送失败时事件已经被标成已投递，永远不会重试——静默丢失一个事件。顺序必须是「先发送成功，再标记」，这样最坏情况是重复投递，而重复正是第 7 关幂等要解决的问题。',
      'Marking an event delivered before calling publish. When publishing fails the event is already marked and never retried — a silently lost event. The order must be publish first, mark second, so the worst case is a duplicate delivery, and duplicates are exactly what stage 7 addresses.'
    ),
    t(
      '投递时用 `Promise.all` 并行发送所有待发事件。吞吐更好，顺序没了——同一个订单的「已创建」和「已支付」可能倒过来送达。outbox 的投递必须保持写入顺序，这是它相对于「直接发消息」的一个额外保证。',
      'Dispatching with `Promise.all` across all pending events. Throughput improves and ordering is gone, so "created" and "paid" for one order can arrive reversed. Outbox delivery must preserve insertion order, which is an extra guarantee it offers over publishing directly.'
    ),
    t(
      '一个事件发送失败就中断整批投递，但已经发出去的没有标记。下次投递会把它们重发一遍——虽然幂等能兜住，但这是白白产生的重复。中断是对的（保持顺序），但已成功的必须先标记。',
      'Aborting the whole batch on one failure without marking the ones already sent. The next dispatch resends them — idempotency absorbs it, and the duplicates were manufactured for nothing. Aborting is right, to preserve ordering, and the successful ones must be marked first.'
    ),
  ],
  hints: [
    t(
      'outbox 就是一张普通的表：`{ id, type, payload, delivered }`。`commit` 里把 work 返回的事件逐个 `tx.insert(\'outbox\', ...)`。',
      'The outbox is an ordinary table of `{ id, type, payload, delivered }`. In `commit`, insert each event `work` returned with `tx.insert(\'outbox\', ...)`.'
    ),
    t(
      '`dispatch` 遍历 `delivered === false` 的行，逐个 await publish，成功后用 `tx.update` 标记；遇到失败就 break，保持顺序。',
      "`dispatch` walks rows with `delivered === false`, awaits publish for each, marks it with `tx.update` on success, and breaks on failure to preserve order."
    ),
  ],
  extension: t(
    [
      'Outbox 解决的是**双写问题**（dual write）——同一个逻辑操作要更新两个独立的存储，',
      '而它们之间没有共同的事务。这个问题在微服务里无处不在：',
      '数据库和缓存、数据库和搜索引擎、数据库和消息队列。',
      'Outbox 的通用形式是：**只写一个存储，让其他存储从它派生**。',
      '',
      '投递器的实现有两派。**轮询派**（这一关的做法）定期扫 outbox 表，',
      '简单可靠，代价是延迟等于轮询间隔、而且给数据库持续加读负载。',
      '**日志捕获派**（CDC，change data capture）直接读数据库的事务日志——',
      'Debezium 读 MySQL binlog 和 PostgreSQL WAL 就是这个思路。',
      '延迟低到毫秒级，对业务库零额外负载，代价是需要额外的基础设施。',
      '',
      'Outbox 天然是 **at-least-once**：投递成功了但标记失败（进程恰好在两步之间崩溃），',
      '重启后会重发一次。想变成 exactly-once 的唯一办法仍然是消费端幂等——',
      '这也是为什么这个项目的下一关就是幂等。',
      '',
      '还有一个运维上的坑：**outbox 表会一直长**。已投递的行如果不清理，',
      '几个月后这张表会比业务表还大，而且每次扫描都要跳过大量已投递的行。',
      '真实实现要么定期删除，要么用分区表按时间滚动删除。',
    ].join('\n'),
    [
      'The outbox addresses the dual-write problem: one logical operation must update two independent',
      'stores with no shared transaction between them. That shape is everywhere in microservices —',
      'database and cache, database and search index, database and message broker. The general form of the',
      'answer is to write to one store and derive the others from it.',
      '',
      'Dispatchers come in two schools. Polling, which this stage implements, periodically scans the outbox',
      'table: simple and reliable, with latency equal to the polling interval and a continuous read load on',
      'the database. Log capture (CDC) reads the transaction log directly — Debezium consuming MySQL binlog',
      'or PostgreSQL WAL — with millisecond latency and no extra load on the business database, at the cost',
      'of additional infrastructure.',
      '',
      'An outbox is inherently at-least-once: publishing may succeed and the marking fail, when a process',
      'dies exactly between the two, and the event is resent on restart. The only route to exactly-once is',
      'still idempotent consumption — which is why the next stage of this project is idempotency.',
      '',
      'One operational trap: the outbox table grows forever. Unless delivered rows are cleaned up, within',
      'months it is larger than the business table and every scan skips over a mass of delivered rows. Real',
      'implementations either delete periodically or use a time-partitioned table rolled off by age.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},
  starterFiles: [
    databaseSupport,
    file(
      'src/outbox.ts',
      code`
        import type { OrderEvent } from './contract';
        import type { Database, Tx } from './support/db';

        export interface Outbox {
          /** work runs inside a transaction; the events it returns commit or roll back with the business data */
          commit(work: (tx: Tx) => OrderEvent[]): void;
          /** Emit undelivered events in write order and return how many were delivered this round */
          dispatch(publish: (event: OrderEvent) => Promise<void>): Promise<number>;
          pending(): number;
        }

        export function createOutbox(db: Database): Outbox {
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
        import { createOutbox } from '../src/outbox';
        import { createDatabase } from '../src/support/db';
        import { count } from '@lab/metrics';

        function orderEvent(id: string, orderId: string) {
          return { id, type: 'order.created', payload: { orderId } };
        }

        describe('Stage 6 · Transactional outbox', () => {
          it('business data and events are written together', () => {
            const db = createDatabase();
            const outbox = createOutbox(db);

            outbox.commit((tx) => {
              tx.insert('orders', { id: 'o1', total: 100 });
              return [orderEvent('e1', 'o1')];
            });

            expect(db.rows('orders')).toHaveLength(1);
            expect(outbox.pending()).toBe(1);
          });

          it('a failed business write rolls the events back too [gate:atomic]', () => {
            const db = createDatabase();
            const outbox = createOutbox(db);

            let thrown = false;
            try {
              outbox.commit((tx) => {
                tx.insert('orders', { id: 'o1', total: 100 });
                throw new Error('validation failed');
              });
            } catch (caught) {
              thrown = true;
            }

            count('orphanEvents', outbox.pending());
            expect(thrown).toBe(true);
            expect(db.rows('orders')).toHaveLength(0);
            // An implementation that writes the outbox outside the transaction leaves an orphan event here
            expect(outbox.pending()).toBe(0);
          });

          it('delivered events are marked and never sent twice', async () => {
            const db = createDatabase();
            const outbox = createOutbox(db);
            outbox.commit(() => [orderEvent('e1', 'o1')]);

            const sent: string[] = [];
            expect(await outbox.dispatch(async (event) => {
              sent.push(event.id);
            })).toBe(1);
            expect(outbox.pending()).toBe(0);

            await outbox.dispatch(async (event) => {
              sent.push(event.id);
            });
            expect(sent).toEqual(['e1']);
          });

          it('delivery order matches write order', async () => {
            const db = createDatabase();
            const outbox = createOutbox(db);
            outbox.commit(() => [orderEvent('e1', 'o1'), orderEvent('e2', 'o1')]);
            outbox.commit(() => [orderEvent('e3', 'o1')]);

            const sent: string[] = [];
            await outbox.dispatch(async (event) => {
              sent.push(event.id);
            });
            expect(sent).toEqual(['e1', 'e2', 'e3']);
          });

          it('not a single failed delivery is lost [gate:no-loss]', async () => {
            const db = createDatabase();
            const outbox = createOutbox(db);
            outbox.commit(() => [orderEvent('e1', 'o1'), orderEvent('e2', 'o1'), orderEvent('e3', 'o1')]);

            // First pass: everything from the second one on fails
            const firstRound: string[] = [];
            await outbox.dispatch(async (event) => {
              if (event.id !== 'e1') throw new Error('broker is down');
              firstRound.push(event.id);
            });

            // Second pass: the broker is back
            const secondRound: string[] = [];
            await outbox.dispatch(async (event) => {
              secondRound.push(event.id);
            });

            const delivered = firstRound.concat(secondRound).sort();
            count('lostEvents', 3 - new Set(delivered).size);

            expect(new Set(delivered).size).toBe(3);
            expect(outbox.pending()).toBe(0);
          });

          it('the ones that already succeeded are marked and not resent', async () => {
            const db = createDatabase();
            const outbox = createOutbox(db);
            outbox.commit(() => [orderEvent('e1', 'o1'), orderEvent('e2', 'o1')]);

            await outbox.dispatch(async (event) => {
              if (event.id === 'e2') throw new Error('broker is down');
            });
            expect(outbox.pending()).toBe(1);

            const second: string[] = [];
            await outbox.dispatch(async (event) => {
              second.push(event.id);
            });
            expect(second).toEqual(['e2']);
          });

          it('dispatch returns 0 when nothing is pending', async () => {
            const outbox = createOutbox(createDatabase());
            expect(await outbox.dispatch(async () => undefined)).toBe(0);
          });

          it('work that returns no events still commits normally', () => {
            const db = createDatabase();
            const outbox = createOutbox(db);
            outbox.commit((tx) => {
              tx.insert('orders', { id: 'o1' });
              return [];
            });
            expect(db.rows('orders')).toHaveLength(1);
            expect(outbox.pending()).toBe(0);
          });

          it('repeated commits accumulate in the outbox', () => {
            const outbox = createOutbox(createDatabase());
            outbox.commit(() => [orderEvent('e1', 'o1')]);
            outbox.commit(() => [orderEvent('e2', 'o2')]);
            expect(outbox.pending()).toBe(2);
          });

          it('a rollback leaves no trace of the business data either', () => {
            const db = createDatabase();
            const outbox = createOutbox(db);
            outbox.commit((tx) => {
              tx.insert('orders', { id: 'o1' });
              return [orderEvent('e1', 'o1')];
            });

            try {
              outbox.commit((tx) => {
                tx.insert('orders', { id: 'o2' });
                return [orderEvent('e2', 'o2')];
              });
            } catch (caught) {
              // This one does not throw
            }
            expect(db.rows('orders')).toHaveLength(2);

            try {
              outbox.commit((tx) => {
                tx.insert('orders', { id: 'o3' });
                throw new Error('nope');
              });
            } catch (caught) {
              // Expected
            }
            // The third one rolled back; the data from the first two must still be there
            expect(db.rows('orders')).toHaveLength(2);
            expect(outbox.pending()).toBe(2);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.orphanEvents',
      op: 'eq',
      value: 0,
      zh: '业务写入回滚时不留下孤儿事件',
      en: 'A rolled-back write leaves no orphan event',
      dimension: 'correctness',
      scope: 'gate:atomic',
    }),
    gate({
      metric: 'counters.lostEvents',
      op: 'eq',
      value: 0,
      zh: '投递失败的事件重试后全部送达',
      en: 'Every event that failed to publish is delivered on retry',
      dimension: 'resilience',
      scope: 'gate:no-loss',
    }),
  ],
  referenceFiles: [
    file(
      'src/outbox.ts',
      code`
        import type { OrderEvent } from './contract';
        import type { Database, Tx } from './support/db';

        export interface Outbox {
          commit(work: (tx: Tx) => OrderEvent[]): void;
          dispatch(publish: (event: OrderEvent) => Promise<void>): Promise<number>;
          pending(): number;
        }

        const TABLE = 'outbox';

        export function createOutbox(db: Database): Outbox {
          return {
            commit(work: (tx: Tx) => OrderEvent[]): void {
              db.transaction((tx) => {
                const events = work(tx);
                // The position of this line is the whole point: the event write sits inside the same transaction callback as the business write.
                // Move it outside transaction and you are back to the two-step 'write the database, then write the outbox' problem
                for (const event of events) {
                  tx.insert(TABLE, {
                    id: event.id,
                    type: event.type,
                    payload: event.payload,
                    delivered: false,
                  });
                }
              });
            },

            async dispatch(publish: (event: OrderEvent) => Promise<void>): Promise<number> {
              const rows = db.rows(TABLE).filter((row) => row.delivered === false);
              let sent = 0;

              for (const row of rows) {
                const event: OrderEvent = {
                  id: String(row.id),
                  type: String(row.type),
                  payload: row.payload as Record<string, unknown>,
                };

                try {
                  // Send first, mark only on success. The other way round leaves a failed send
                  // marked as delivered and never retried — a silent loss
                  await publish(event);
                } catch (error) {
                  // Preserve order: stop the batch and leave the rest for the next round.
                  // Skipping ahead would deliver one order's events out of order
                  break;
                }

                db.transaction((tx) => {
                  tx.update(TABLE, (candidate) => candidate.id === row.id, { delivered: true });
                });
                sent += 1;
              }

              return sent;
            },

            pending(): number {
              return db.rows(TABLE).filter((row) => row.delivered === false).length;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**整关的重点是 `tx.insert(TABLE, ...)` 所在的位置。** 它在 `db.transaction` 的回调里，',
      '和业务写入共享同一个事务边界。挪到 `transaction` 外面一行，代码看起来几乎一样，',
      '但双写问题原封不动地回来了——只是从「数据库 + 队列」变成了「数据库 + 数据库」。',
      '',
      '**先 publish 再标记。** 这个顺序决定了失败模式：',
      '「发了但没标记」会导致重复投递，「标记了但没发」会导致永久丢失。',
      '重复可以被消费端幂等消化（下一关就是干这个的），丢失不能被任何下游手段补救。',
      '在两种失败之间做选择时，永远选可以被下游修复的那一种。',
      '',
      '**失败时 `break` 而不是 `continue`。** 跳过失败的继续发下一个，能提高投递成功率，',
      '代价是顺序保证没了——同一个订单的「已支付」可能先于「已创建」送达。',
      'outbox 的一个隐含承诺就是保持写入顺序，`continue` 会悄悄破坏它。',
      '',
      '**标记用一个独立的小事务。** 它和 publish 之间仍然有缝隙（发了但还没标记时崩溃），',
      '这个缝隙是 outbox 模式固有的、无法消除的——它正是 at-least-once 语义的来源。',
    ].join('\n'),
    [
      'The stage turns on where `tx.insert(TABLE, ...)` sits. It is inside the `db.transaction` callback,',
      'sharing a transaction boundary with the business write. Move it one line outside and the code looks',
      'almost identical while the dual-write problem returns untouched — merely transformed from "database',
      'and queue" into "database and database".',
      '',
      'Publish first, mark second. That order chooses the failure mode: "sent but not marked" causes a',
      'duplicate, "marked but not sent" causes permanent loss. A duplicate can be absorbed by idempotent',
      'consumption, which is exactly the next stage; loss cannot be repaired by anything downstream. Given',
      'a choice between two failures, always take the one something downstream can fix.',
      '',
      '`break` rather than `continue` on failure. Skipping a failure to keep sending raises the delivery',
      'rate at the cost of ordering, so "paid" can arrive before "created" for one order. Preserving',
      'insertion order is an implicit promise of the outbox, and `continue` quietly breaks it.',
      '',
      'Marking happens in its own small transaction. A gap remains between publishing and marking — a',
      'crash right there — and that gap is inherent to the pattern and cannot be closed. It is precisely',
      'where at-least-once semantics come from.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage7 = {
  id: 'idempotency',
  title: t('第 7 关 · 幂等与死信队列', 'Stage 7 · Idempotency and dead letters'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '消息队列只保证 **at-least-once**：同一个事件会重复投递。',
      '上一关的 outbox 也印证了这一点 —— 崩溃在「发送」和「标记已投递」之间，',
      '重启后这条事件会被再发一次。',
      '',
      '于是问题落到消费端：如果扣库存被执行两次，就是真实的资损。',
      '',
      '## 要实现什么',
      '',
      '在 `src/processor.ts` 实现 `createOrderProcessor(options)`：',
      '',
      '| 能力 | 行为 |',
      '| --- | --- |',
      '| 执行 | `process(event)` 用第 4 关的 `compose` 跑一遍中间件链 |',
      '| 幂等 | 同一个 `event.id` 重复投递时直接返回上次结果，**不再执行中间件** |',
      '| 重试 | 处理失败时最多重试 `maxAttempts - 1` 次 |',
      '| 死信 | 仍然失败的事件进入死信队列，`deadLetters()` 可取出，且不影响后续事件 |',
      '| 打点 | 用 `@lab/metrics` 的 `count()` 记 `order.processed` / `order.deadLettered` |',
      '',
      '返回的 `ProcessOutcome` 要如实报告 `deduplicated` 和 `attempts`。',
      '',
      '## 怎么算过',
      '',
      '- 重复投递只产生一次副作用（门槛 `counters.order.processed ≤ 1`）；',
      '- 毒消息重试用尽后进入死信队列（门槛 `counters.order.deadLettered ≥ 1`）；',
      '- 死信不往外抛异常，后面的事件照常处理；',
      '- 每次重试用**全新的 ctx**。',
      '',
      '## 幂等键必须在副作用之前生效',
      '',
      '这是这一关唯一真正重要的一句话。事后补偿是另一件难得多的事，通常也补不干净 ——',
      '库存可以加回去，但发出去的短信、扣掉的优惠券、通知过的下游，都追不回来。',
      '',
      '所以 `process` 的第一件事就是查 `processed`，命中直接返回，',
      '中间件链一行都不执行。',
      '',
      '另外两处细节：',
      '',
      '**每次重试都要新建 `ctx`。** 复用同一个 ctx，上一次失败留下的半成品状态会被带进这一次，',
      '于是重试在一个脏环境里运行 —— 这种 bug 只在重试路径上出现，测试很难覆盖。',
      '',
      '**死信不要往外抛。** 一条毒消息不该拖住整条流水线：',
      '它的归宿是死信队列加一个打点，而不是让调用方的循环中断。',
    ].join('\n'),
    [
      'Message queues only guarantee **at-least-once**: the same event will be delivered twice. The previous',
      'stage proves it — crash between "published" and "marked delivered" and the event goes out again after',
      'restart.',
      '',
      'So the problem lands on the consumer: decrementing stock twice is real money lost.',
      '',
      '## What to build',
      '',
      '`createOrderProcessor(options)` in `src/processor.ts`:',
      '',
      '| Capability | Behaviour |',
      '| --- | --- |',
      '| Execution | `process(event)` runs the stage-4 `compose` chain |',
      '| Idempotency | A repeated `event.id` returns the previous result **without running the middleware** |',
      '| Retries | A failing event is retried up to `maxAttempts - 1` times |',
      '| Dead letters | Events that still fail land in a queue readable via `deadLetters()`, without affecting later events |',
      '| Metrics | `count()` from `@lab/metrics` records `order.processed` / `order.deadLettered` |',
      '',
      'The returned `ProcessOutcome` must report `deduplicated` and `attempts` truthfully.',
      '',
      '## What counts as passing',
      '',
      '- A duplicate delivery produces one side effect (`counters.order.processed ≤ 1`);',
      '- A poison message exhausts its retries and lands in the dead-letter queue (`counters.order.deadLettered ≥ 1`);',
      '- Dead-lettering throws nothing outward, and later events process normally;',
      '- Every retry uses a **fresh ctx**.',
      '',
      '## The idempotency key must engage before the side effect',
      '',
      'That is the one sentence that matters here. Compensating afterwards is a much harder job and rarely',
      'cleans up everything — stock can go back, but the SMS already sent, the coupon already burned and the',
      'downstream already notified cannot be recalled.',
      '',
      'So the first thing `process` does is consult `processed`, returning immediately on a hit, with not one',
      'line of the middleware chain executed.',
      '',
      'Two more details:',
      '',
      '**Build a fresh `ctx` per attempt.** Reuse one and the half-finished state left by the failed attempt',
      'comes along into the next, so the retry runs in a dirty environment — a bug that only ever appears on',
      'the retry path, which tests rarely cover.',
      '',
      '**Do not throw on dead-lettering.** One poison message should not stall the pipeline: its destination',
      'is the dead-letter queue plus a metric, not a broken loop in the caller.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  P["process(event)"] --> DUP{"processed 里有 event.id 吗？"}',
      '  DUP -- 有 --> RET["返回上次的结果<br/>deduplicated: true, attempts: 0<br/>中间件一行都不跑 —— 副作用之前就拦住了"]',
      '  DUP -- 没有 --> LOOP["attempt = 1 … maxAttempts"]',
      '  LOOP --> CTX["每次都新建 ctx = { event, state: {} }<br/>复用会把上次失败的半成品状态带进来"]',
      '  CTX --> RUN["await run(ctx)<br/>第 4 关 compose 出来的中间件链"]',
      '  RUN --> OK{"成功了吗？"}',
      '  OK -- 成功 --> MARK["processed.set(event.id, ctx.result)<br/>count(\'order.processed\')"]',
      '  MARK --> OUT1["{ ok: true, deduplicated: false, attempts }"]',
      '  OK -- 失败 --> MORE{"还有重试次数吗？"}',
      '  MORE -- 有 --> LOOP',
      '  MORE -- 用尽 --> DL["dead.push(event)<br/>count(\'order.deadLettered\')"]',
      '  DL --> OUT2["{ ok: false, error }<br/>不往外抛：一条毒消息不该拖住整条流水线"]',
      '```',
      '',
      '要点：`DUP` 是整张图的第一个节点，这个位置就是「幂等键在副作用之前生效」。',
      '它下面的所有路径 —— 重试、打点、死信 —— 都只对第一次投递发生。',
      '',
      '右边那条从 `MARK` 回到 `processed` 的记录，和左边 `DUP` 的查询是同一张表：',
      '写在成功之后、查在执行之前，重复投递因此永远走 `RET` 那条最短的边。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  P["process(event)"] --> DUP{"is event.id already in processed?"}',
      '  DUP -- yes --> RET["return the previous result<br/>deduplicated: true, attempts: 0<br/>no middleware runs — stopped before any side effect"]',
      '  DUP -- no --> LOOP["attempt = 1 … maxAttempts"]',
      '  LOOP --> CTX["build a fresh ctx = { event, state: {} } each time<br/>reuse drags the failed attempt\'s half-state along"]',
      '  CTX --> RUN["await run(ctx)<br/>the middleware chain composed in stage 4"]',
      '  RUN --> OK{"did it succeed?"}',
      '  OK -- succeeded --> MARK["processed.set(event.id, ctx.result)<br/>count(\'order.processed\')"]',
      '  MARK --> OUT1["{ ok: true, deduplicated: false, attempts }"]',
      '  OK -- failed --> MORE{"any attempts left?"}',
      '  MORE -- yes --> LOOP',
      '  MORE -- exhausted --> DL["dead.push(event)<br/>count(\'order.deadLettered\')"]',
      '  DL --> OUT2["{ ok: false, error }<br/>never thrown outward: one poison message must not stall the pipeline"]',
      '```',
      '',
      'The point: `DUP` is the diagram\'s first node, and that position *is* "the idempotency key engages',
      'before the side effect". Everything below it — retries, metrics, dead letters — happens only on the',
      'first delivery.',
      '',
      'The write at `MARK` and the read at `DUP` touch the same table: written after success, read before',
      'execution, so a duplicate delivery always takes the short edge to `RET`.',
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
          /** How many attempts at most, including the first; defaults to 1 */
          maxAttempts?: number;
        }

        export interface ProcessOutcome {
          ok: boolean;
          /** Whether the idempotency table was hit (nothing actually ran) */
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
        import { createOrderProcessor } from '../src/processor';
        import { getCounters } from '@lab/metrics';
        import { sleep } from '@lab/env';

        function event(id: string, type = 'order.created') {
          return { id, type, payload: { orderId: id } };
        }

        describe('Stage 7 · Idempotency and dead letters', () => {
          it('a normal event runs the whole middleware chain', async () => {
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

          it('a redelivery with the same id executes only once [gate:idempotent]', async () => {
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

          it('a failing event is retried up to maxAttempts', async () => {
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

          it('an event that fails for good goes to the dead-letter queue [gate:dlq]', async () => {
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

          it('a dead letter does not block the events behind it', async () => {
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

          it('a failed event is not written to the idempotency table and is retried on redelivery', async () => {
            let attempts = 0;
            const processor = createOrderProcessor({
              maxAttempts: 1,
              middlewares: [
                async (ctx) => {
                  attempts += 1;
                  // The first delivery failed, so the second should really run again
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

          it('every retry gets a fresh ctx with no leftovers from the last one', async () => {
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

          it('maxAttempts defaults to a single attempt', async () => {
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

          it('deadLetters returns a copy that callers cannot use to mutate the queue', async () => {
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

          it('an idempotency hit does not record the metric twice', async () => {
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

          it('an event with an empty middleware chain still counts as handled', async () => {
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
              // The idempotency check has to come before any side effect
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

/* ------------------------------------------------------------------ */

const stage8 = {
  id: 'saga',
  title: t('第 8 关 · Saga 与补偿事务', 'Stage 8 · Sagas and compensation'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '一次下单要做四件事：扣库存、扣余额、创建物流单、发通知。',
      '它们分属四个服务，各有各的数据库 —— **没有一个事务能同时覆盖它们**。',
      '扣完库存扣余额时余额不足，怎么办？库存已经扣了。',
      '',
      'Saga 的答案是：**不做回滚，做补偿**。',
      '每一步都配一个「反向操作」，失败时**按相反顺序**依次执行已完成步骤的补偿。',
      '扣了库存就还库存，扣了余额就退余额。',
      '',
      '## 要实现什么',
      '',
      '在 `src/saga.ts` 实现 `runSaga(steps, ctx)`：',
      '',
      '| 规则 | 说明 |',
      '| --- | --- |',
      '| 顺序执行 | 依次 `await step.invoke(ctx)` |',
      '| 失败即停 | 某一步失败就不再往后走 |',
      '| 逆序补偿 | 把**已经成功的**步骤按逆序 `compensate` |',
      '| 失败那步不补偿 | 它没做成，没什么可撤销的 |',
      '| 补偿失败继续补 | 记进 `compensationFailures`，但不中断 |',
      '',
      '返回 `{ ok, completed, compensated, failedAt, compensationFailures }`。',
      '',
      '## 怎么算过',
      '',
      '- 补偿严格按逆序执行（门槛 `counters.compensationOrderErrors = 0`）；',
      '- 失败之后不留下任何未补偿的已完成步骤（门槛 `counters.uncompensated = 0`）；',
      '- 全部成功时 `compensated` 为空；',
      '- 补偿抛错时仍然把剩下的补完，并如实报告哪几步补偿失败了。',
      '',
      '## 逆序是硬性要求，不是风格问题',
      '',
      '后面的步骤可能依赖前面的结果。「创建物流单」用的是「扣库存」锁定的那批货 ——',
      '先还库存再撤物流单，中间会出现一个「物流单指向已经被别人买走的库存」的窗口。',
      '这种窗口在测试里几乎不可能撞到，在生产里一天撞几次。',
      '',
      '**失败的那一步不补偿。** 强行补偿它，轻则找不到记录报错，',
      '重则撤销掉别人的东西 —— 它的 invoke 可能在写入之前就失败了，',
      '也可能失败在写入之后，你无从分辨。所以规则只能是：没进 `done` 就不补。',
      '',
      '**补偿失败要继续补完。** 中断的话，更早的步骤永远不会被撤销，',
      '系统停在一个谁也说不清的状态。尽最大努力补完，然后把补偿失败的那几步',
      '明确报出来交给人工 —— 这是这类流程唯一诚实的做法。',
    ].join('\n'),
    [
      'Placing an order does four things: reserve stock, charge the balance, create a shipment, send a',
      'notification. They belong to four services with four databases, and **no transaction spans them**.',
      'What happens when the balance is insufficient after stock was already reserved?',
      '',
      'The saga answer is: **do not roll back, compensate**. Every step carries an inverse, and on failure',
      'the compensations for the completed steps run **in reverse order**. Stock reserved gets released,',
      'money charged gets refunded.',
      '',
      '## What to build',
      '',
      '`runSaga(steps, ctx)` in `src/saga.ts`:',
      '',
      '| Rule | Detail |',
      '| --- | --- |',
      '| Run in order | `await step.invoke(ctx)` one by one |',
      '| Stop on failure | Nothing after the failing step runs |',
      '| Compensate in reverse | The steps that **already succeeded**, backwards |',
      '| The failing step is not compensated | It did not complete, so there is nothing to undo |',
      '| A failed compensation continues | Record it in `compensationFailures` and keep going |',
      '',
      'Return `{ ok, completed, compensated, failedAt, compensationFailures }`.',
      '',
      '## What counts as passing',
      '',
      '- Compensation runs strictly in reverse (`counters.compensationOrderErrors = 0`);',
      '- No completed step is left uncompensated after a failure (`counters.uncompensated = 0`);',
      '- On full success `compensated` is empty;',
      '- A throwing compensation still lets the rest finish, and the failures are reported honestly.',
      '',
      '## Reverse order is a requirement, not a stylistic preference',
      '',
      'Later steps may depend on earlier results. The shipment was created against the stock the first step',
      'reserved — release the stock before cancelling the shipment and a window opens where a shipment points',
      'at stock somebody else has already bought. Such windows are nearly impossible to hit in tests and get',
      'hit several times a day in production.',
      '',
      '**The failing step is not compensated.** Compensating it anyway either errors on a missing record or,',
      'worse, undoes somebody else\'s work — its invoke may have failed before its write or after it, and you',
      'cannot tell which. So the rule can only be: not in `done`, not compensated.',
      '',
      '**A failed compensation must not stop the rest.** Abort and the earlier steps are never undone, leaving',
      'the system in a state nobody can describe. Compensate everything on a best-effort basis, then report',
      'the failed compensations explicitly for a human — the only honest option for this kind of flow.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  S["runSaga(steps, ctx)"] --> F1["取下一步"]',
      '  F1 --> INV["await step.invoke(ctx)"]',
      '  INV --> R{"成功了吗？"}',
      '  R -- 成功 --> PUSH["done.push(step)<br/>completed.push(name)"]',
      '  PUSH --> MORE{"还有步骤吗？"}',
      '  MORE -- 有 --> F1',
      '  MORE -- 没有 --> ALLOK["{ ok: true }<br/>compensated 为空，不需要补偿"]',
      '  R -- 失败 --> FA["failedAt = step.name<br/>break —— 注意它没有进 done"]',
      '',
      '  FA --> COMP["从 done 的末尾往回走"]',
      '  COMP --> C1["await step.compensate(ctx)"]',
      '  C1 --> CR{"补偿成功了吗？"}',
      '  CR -- 成功 --> CADD["compensated.push(name)"]',
      '  CR -- 失败 --> CFAIL["compensationFailures.push(name)<br/>记下来，但继续补下一个"]',
      '  CADD --> CNEXT{"done 里还有更早的步骤吗？"}',
      '  CFAIL --> CNEXT',
      '  CNEXT -- 有 --> C1',
      '  CNEXT -- 没有 --> OUT["{ ok: false, completed, compensated,<br/>failedAt, compensationFailures }"]',
      '```',
      '',
      '要点：`done` 这个数组是全图的枢纽。它只在 `PUSH` 处增长，',
      '而补偿循环从它的**末尾**开始 —— 逆序和「失败那步不补偿」这两条规则，',
      '都是这一个数据结构自然带来的，不需要额外判断。',
      '',
      '`CFAIL → CNEXT` 那条边是「尽最大努力」的全部：补偿失败不改变循环的走向，',
      '只往报告里加一笔。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  S["runSaga(steps, ctx)"] --> F1["take the next step"]',
      '  F1 --> INV["await step.invoke(ctx)"]',
      '  INV --> R{"did it succeed?"}',
      '  R -- succeeded --> PUSH["done.push(step)<br/>completed.push(name)"]',
      '  PUSH --> MORE{"any steps left?"}',
      '  MORE -- yes --> F1',
      '  MORE -- no --> ALLOK["{ ok: true }<br/>compensated is empty, nothing to undo"]',
      '  R -- failed --> FA["failedAt = step.name<br/>break — note it never entered done"]',
      '',
      '  FA --> COMP["walk backwards from the end of done"]',
      '  COMP --> C1["await step.compensate(ctx)"]',
      '  C1 --> CR{"did the compensation succeed?"}',
      '  CR -- succeeded --> CADD["compensated.push(name)"]',
      '  CR -- failed --> CFAIL["compensationFailures.push(name)<br/>recorded, then carry on to the next"]',
      '  CADD --> CNEXT{"any earlier steps in done?"}',
      '  CFAIL --> CNEXT',
      '  CNEXT -- yes --> C1',
      '  CNEXT -- no --> OUT["{ ok: false, completed, compensated,<br/>failedAt, compensationFailures }"]',
      '```',
      '',
      'The point: the `done` array is the hub of the whole picture. It grows only at `PUSH`, and the',
      'compensation loop starts from its **end** — so both "reverse order" and "the failing step is not',
      'compensated" fall out of that one data structure, with no extra checks.',
      '',
      'The `CFAIL → CNEXT` edge is the entirety of "best effort": a failed compensation does not change where',
      'the loop goes, it only adds a line to the report.',
    ].join('\n')
  ),
  checklist: [
    t('全部成功时不执行任何补偿', 'Nothing is compensated when every step succeeds'),
    t('失败时已完成的步骤全部被补偿', 'Every completed step is compensated on failure'),
    t('补偿按逆序执行', 'Compensations run in reverse order'),
    t('失败的那一步自己不补偿', 'The failing step is not compensated'),
    t('补偿失败不影响其余补偿', 'A failing compensation does not stop the others'),
  ],
  pitfalls: [
    t(
      '补偿按正序执行。看起来只是顺序问题，实际上会制造出前面步骤已撤销、后面步骤还挂着的中间态——「物流单指向已经还回库存池的货」。补偿的依赖关系和正向执行完全相反，必须逆序。',
      'Compensating in forward order. It looks like a mere ordering detail and it manufactures an intermediate state where earlier steps are undone while later ones still stand — a shipment pointing at stock already returned to the pool. Compensation dependencies are the exact reverse of the forward ones, so it must run backwards.'
    ),
    t(
      '把失败的那一步也补偿一遍。它的 invoke 抛错了，可能什么都没做，也可能做了一半。对一个没做成的操作执行反向操作，轻则报错（找不到要撤销的记录），重则撤销掉别人的东西（比如按订单号退款，退掉了上一次成功的那笔）。补偿只针对确认成功的步骤。',
      'Compensating the failing step as well. Its `invoke` threw, having done nothing or something partial. Inverting an operation that never completed either errors — there is no record to undo — or undoes something else entirely, such as refunding by order id and reversing the previous successful charge. Compensate only confirmed successes.'
    ),
    t(
      '某个补偿抛错就中断整个补偿流程。剩下的步骤永远不会被撤销，系统停在一个谁也说不清的中间态。补偿必须尽最大努力全部执行完，失败的单独记录下来交给人工或者重试队列——这也是为什么返回值里要有 `compensationFailures`。',
      'Aborting the whole compensation when one of them throws. The remaining steps are never undone and the system settles into a state nobody can describe. Compensation must be best-effort and run to the end, recording failures separately for a human or a retry queue — which is why `compensationFailures` is in the return value.'
    ),
    t(
      '假设补偿一定成功，因此不做幂等。补偿本身也会失败重试，而「退款」重试两次就是退了两笔钱。Saga 的每一步和每一个补偿都必须是幂等的，这一关没有强制，但真实系统里它是前置条件，不是优化。',
      'Assuming compensations always succeed and therefore need not be idempotent. Compensations fail and get retried too, and a refund retried twice is two refunds. Every step and every compensation in a saga must be idempotent — this stage does not enforce it, and in a real system it is a precondition rather than an optimisation.'
    ),
  ],
  hints: [
    t(
      '正向循环里把成功的步骤 push 进一个数组，失败时 `for (let i = done.length - 1; i >= 0; i--)` 就是逆序补偿。',
      'Push each successful step into an array in the forward loop; `for (let i = done.length - 1; i >= 0; i--)` is then the reverse compensation.'
    ),
    t(
      '每个补偿单独 try/catch，把错误收进 `compensationFailures`，循环继续。',
      'Wrap each compensation in its own try/catch, collect the error into `compensationFailures`, and keep looping.'
    ),
  ],
  extension: t(
    [
      'Saga 这个词来自 1987 年 Garcia-Molina 和 Salem 的论文，原本是为了解决',
      '「长事务把数据库锁太久」的问题：把一个长事务拆成若干个短事务，',
      '每个都立即提交，用补偿来处理失败。三十多年后它成了微服务的标配。',
      '',
      'Saga 有两种编排方式。**编排式**（orchestration，这一关的做法）有一个中心协调者',
      '按顺序调用每一步，流程清晰、易于调试，代价是协调者成了一个必须高可用的组件，',
      '而且它知道所有服务的细节。**协同式**（choreography）没有中心，',
      '每个服务监听上一步的事件、做完发出自己的事件，耦合更松，',
      '代价是流程散落在各处——出问题时没人说得清「现在走到哪一步了」。',
      '',
      'Saga 最重要的性质是它**不提供隔离性**。ACID 里的 A、C、D 都能靠补偿近似，',
      'I 不行：saga 执行到一半时，中间状态对外是可见的。',
      '别人可能读到「库存已扣但订单还没创建」的瞬间。',
      '常见的缓解手段是**语义锁**（给记录打一个 pending 标记，让其他人知道这里正在进行中）',
      '和**交换律更新**（把「设置为 X」改成「增加 delta」，让顺序不再重要）。',
      '',
      '还有一个实践上的难点：**补偿不总是存在**。发出去的邮件撤不回来，',
      '调用第三方支付扣的款可能要 T+1 才能退。真实设计里的常见做法是',
      '把不可补偿的步骤**放到最后**——先做所有可撤销的，最后才做那些无法回头的。',
    ].join('\n'),
    [
      'The word saga comes from a 1987 paper by Garcia-Molina and Salem, originally about long transactions',
      'holding database locks too long: split one long transaction into several short ones that each commit',
      'immediately, and handle failure with compensation. Thirty years later it is standard in',
      'microservices.',
      '',
      'Sagas are coordinated two ways. Orchestration, what this stage builds, has a central coordinator',
      'calling each step in order: the flow is explicit and debuggable, at the cost of a component that',
      'must be highly available and knows the details of every service. Choreography has no centre — each',
      "service listens for the previous step's event and emits its own — which couples services more",
      'loosely and scatters the flow, so when something goes wrong nobody can say which step it is on.',
      '',
      'The most important property of a saga is that it provides no isolation. A, C and D from ACID can be',
      'approximated with compensation; I cannot. Mid-saga intermediate state is visible externally, and',
      'someone may read the instant where stock is reserved and the order does not yet exist. The usual',
      'mitigations are semantic locks — a pending flag telling others something is in progress — and',
      'commutative updates, replacing "set to X" with "add delta" so ordering stops mattering.',
      '',
      'One more practical difficulty: compensations do not always exist. A sent email cannot be recalled,',
      'and a third-party payment may only be refundable the next day. The common design response is to put',
      'the uncompensatable steps last — do everything reversible first, and only then the things you cannot',
      'take back.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/saga.ts',
      code`
        export interface SagaStep {
          name: string;
          invoke(context: Record<string, unknown>): Promise<void>;
          compensate(context: Record<string, unknown>): Promise<void>;
        }

        export interface SagaResult {
          ok: boolean;
          /** Steps that succeeded, in execution order */
          completed: string[];
          /** Steps that were compensated, in compensation order */
          compensated: string[];
          /** Which step the failure happened on */
          failedAt: string | null;
          /** Steps whose compensation itself failed */
          compensationFailures: string[];
        }

        export function runSaga(
          steps: SagaStep[],
          context: Record<string, unknown>
        ): Promise<SagaResult> {
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
        import { runSaga } from '../src/saga';
        import { count } from '@lab/metrics';

        function step(name: string, log: string[], options: { failInvoke?: boolean; failCompensate?: boolean } = {}) {
          return {
            name,
            async invoke() {
              if (options.failInvoke) throw new Error(name + ' failed');
              log.push('do:' + name);
            },
            async compensate() {
              if (options.failCompensate) throw new Error(name + ' compensation failed');
              log.push('undo:' + name);
            },
          };
        }

        describe('Stage 8 · Sagas and compensation', () => {
          it('nothing is compensated when every step succeeds', async () => {
            const log: string[] = [];
            const result = await runSaga(
              [step('stock', log), step('payment', log), step('shipment', log)],
              {}
            );

            expect(result.ok).toBe(true);
            expect(result.completed).toEqual(['stock', 'payment', 'shipment']);
            expect(result.compensated).toEqual([]);
            expect(log).toEqual(['do:stock', 'do:payment', 'do:shipment']);
          });

          it('a failure on the first step leaves nothing to compensate', async () => {
            const log: string[] = [];
            const result = await runSaga([step('stock', log, { failInvoke: true }), step('payment', log)], {});

            expect(result.ok).toBe(false);
            expect(result.failedAt).toBe('stock');
            expect(result.completed).toEqual([]);
            expect(result.compensated).toEqual([]);
            expect(log).toEqual([]);
          });

          it('a failure part-way through compensates in reverse order [gate:reverse]', async () => {
            const log: string[] = [];
            const result = await runSaga(
              [
                step('stock', log),
                step('payment', log),
                step('shipment', log, { failInvoke: true }),
                step('notify', log),
              ],
              {}
            );

            expect(result.ok).toBe(false);
            expect(result.failedAt).toBe('shipment');
            expect(result.completed).toEqual(['stock', 'payment']);
            // Reverse order: undo payment before stock
            expect(result.compensated).toEqual(['payment', 'stock']);

            let orderErrors = 0;
            const undoIndex = log.indexOf('undo:payment');
            const stockUndoIndex = log.indexOf('undo:stock');
            if (undoIndex === -1 || stockUndoIndex === -1 || undoIndex > stockUndoIndex) orderErrors += 1;
            count('compensationOrderErrors', orderErrors);
            expect(orderErrors).toBe(0);
          });

          it('the step that failed is not compensated itself', async () => {
            const log: string[] = [];
            await runSaga([step('stock', log), step('payment', log, { failInvoke: true })], {});
            // payment's invoke threw and may have done nothing; undoing it could undo something else
            expect(log).not.toContain('undo:payment');
            expect(log).toContain('undo:stock');
          });

          it('no completed step is left uncompensated after a failure [gate:complete]', async () => {
            const log: string[] = [];
            const result = await runSaga(
              [
                step('a', log),
                step('b', log),
                step('c', log),
                step('d', log, { failInvoke: true }),
              ],
              {}
            );

            const uncompensated = result.completed.filter(
              (name) => result.compensated.indexOf(name) === -1
            );
            count('uncompensated', uncompensated.length);

            expect(result.completed).toEqual(['a', 'b', 'c']);
            expect(uncompensated).toEqual([]);
          });

          it('a failed compensation does not stop the remaining ones', async () => {
            const log: string[] = [];
            const result = await runSaga(
              [
                step('stock', log),
                step('payment', log, { failCompensate: true }),
                step('shipment', log, { failInvoke: true }),
              ],
              {}
            );

            // payment's compensation failed, but stock's still has to run
            expect(result.compensationFailures).toEqual(['payment']);
            expect(log).toContain('undo:stock');
          });

          it('failed compensations are recorded in compensationFailures', async () => {
            const log: string[] = [];
            const result = await runSaga(
              [
                step('a', log, { failCompensate: true }),
                step('b', log, { failCompensate: true }),
                step('c', log, { failInvoke: true }),
              ],
              {}
            );
            expect(result.compensationFailures.sort()).toEqual(['a', 'b']);
          });

          it('context is threaded through the steps', async () => {
            const context: Record<string, unknown> = {};
            await runSaga(
              [
                {
                  name: 'reserve',
                  async invoke(ctx) {
                    ctx.reservationId = 'r-1';
                  },
                  async compensate() {
                    return undefined;
                  },
                },
                {
                  name: 'ship',
                  async invoke(ctx) {
                    ctx.shipmentFor = ctx.reservationId;
                  },
                  async compensate() {
                    return undefined;
                  },
                },
              ],
              context
            );
            expect(context.shipmentFor).toBe('r-1');
          });

          it('compensations can read the context too', async () => {
            const context: Record<string, unknown> = {};
            let seen: unknown = null;
            await runSaga(
              [
                {
                  name: 'reserve',
                  async invoke(ctx) {
                    ctx.reservationId = 'r-1';
                  },
                  async compensate(ctx) {
                    seen = ctx.reservationId;
                  },
                },
                {
                  name: 'boom',
                  async invoke() {
                    throw new Error('nope');
                  },
                  async compensate() {
                    return undefined;
                  },
                },
              ],
              context
            );
            expect(seen).toBe('r-1');
          });

          it('an empty step list succeeds immediately', async () => {
            const result = await runSaga([], {});
            expect(result.ok).toBe(true);
            expect(result.completed).toEqual([]);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.compensationOrderErrors',
      op: 'eq',
      value: 0,
      zh: '补偿严格按逆序执行',
      en: 'Compensations run in strictly reverse order',
      dimension: 'correctness',
      scope: 'gate:reverse',
    }),
    gate({
      metric: 'counters.uncompensated',
      op: 'eq',
      value: 0,
      zh: '失败之后没有未补偿的已完成步骤',
      en: 'No completed step is left uncompensated after a failure',
      dimension: 'resilience',
      scope: 'gate:complete',
    }),
  ],
  referenceFiles: [
    file(
      'src/saga.ts',
      code`
        export interface SagaStep {
          name: string;
          invoke(context: Record<string, unknown>): Promise<void>;
          compensate(context: Record<string, unknown>): Promise<void>;
        }

        export interface SagaResult {
          ok: boolean;
          completed: string[];
          compensated: string[];
          failedAt: string | null;
          compensationFailures: string[];
        }

        export async function runSaga(
          steps: SagaStep[],
          context: Record<string, unknown>
        ): Promise<SagaResult> {
          const done: SagaStep[] = [];
          const completed: string[] = [];
          const compensated: string[] = [];
          const compensationFailures: string[] = [];
          let failedAt: string | null = null;

          for (const step of steps) {
            try {
              await step.invoke(context);
              done.push(step);
              completed.push(step.name);
            } catch (error) {
              // This step never completed, so it has nothing of its own to undo.
              // Compensating it anyway finds no record at best, and undoes someone else's work at worst
              failedAt = step.name;
              break;
            }
          }

          if (failedAt === null) {
            return { ok: true, completed, compensated, failedAt: null, compensationFailures };
          }

          // Reverse order: later steps depend on earlier results, so compensating forwards creates
          // in-between states like a shipment pointing at stock that has already gone back to the pool
          for (let index = done.length - 1; index >= 0; index -= 1) {
            const step = done[index];
            try {
              await step.compensate(context);
              compensated.push(step.name);
            } catch (error) {
              // Compensate on a best-effort basis: stopping here leaves the remaining steps undone forever
              // and the system parked in a state nobody can explain
              compensationFailures.push(step.name);
            }
          }

          return { ok: false, completed, compensated, failedAt, compensationFailures };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`done` 数组是补偿的唯一依据。** 它只包含 `invoke` 真正返回了的步骤——',
      '抛错的那一步在 `push` 之前就 `break` 了，永远不会进这个数组。',
      '这一行顺序（先 await 再 push）决定了「失败的步骤不被补偿」这条语义。',
      '',
      '**补偿循环里每一步单独 try/catch。** 把整个循环包一层 try 会让第一个失败的补偿',
      '终止后续所有补偿。补偿是尽最大努力的（best-effort）操作，',
      '失败的那些进 `compensationFailures`，交给人工或者重试队列——',
      '但绝不能因为一个失败就放弃其余的。',
      '',
      '**`compensated` 记录的是补偿执行的顺序，不是原始顺序。** 所以它是逆序的。',
      '这让调用方能直接从返回值里看出补偿是不是按正确顺序走的，',
      '而不需要额外的日志——门槛量的就是这个数组。',
      '',
      '**这个实现不保证幂等。** `invoke` 和 `compensate` 的幂等性是**步骤自己的责任**，',
      'saga 协调者管不了。真实系统里这是前置条件：补偿也会失败重试，',
      '一个不幂等的「退款」补偿重试两次就是退了两笔钱。',
    ].join('\n'),
    [
      'The `done` array is the only basis for compensation. It contains exactly the steps whose `invoke`',
      'actually returned — the throwing one breaks before its `push` and never enters. That ordering,',
      'await before push, is what gives "the failing step is not compensated" its meaning.',
      '',
      'Each compensation gets its own try/catch. Wrapping the loop instead lets the first failing',
      'compensation abort all the rest. Compensation is best-effort: failures go into',
      '`compensationFailures` for a human or a retry queue, and one failure must never abandon the others.',
      '',
      '`compensated` records the order compensations ran in, not the original order, so it reads backwards.',
      'That lets a caller verify the ordering straight from the return value without extra logging — and',
      'it is what the gate measures.',
      '',
      'This implementation does not provide idempotency. That is each step\'s own responsibility and',
      'outside the coordinator\'s reach. In a real system it is a precondition: compensations fail and get',
      'retried, and a non-idempotent refund compensation retried twice refunds twice.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

const stage9 = {
  id: 'event-sourcing',
  title: t('第 9 关 · 事件溯源与快照', 'Stage 9 · Event sourcing and snapshots'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前八关一直把事件当作**通知**：状态存在数据库里，事件只是告诉别人「发生了什么」。',
      '事件溯源把这件事反过来：**事件就是唯一的真相**，状态是把事件从头折叠一遍算出来的。',
      '',
      '```',
      '当前状态 = events.reduce(apply, 初始状态)',
      '```',
      '',
      '好处很实在：任何历史时刻的状态都能重建，审计天然完整，',
      '「为什么这个订单是这个金额」永远有据可查。',
      '代价是两个新问题，这一关都要解决。',
      '',
      '## 要实现什么',
      '',
      '在 `src/eventstore.ts` 实现 `createEventStore()`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `append(streamId, events, expectedVersion)` | 版本不匹配抛 `ConcurrencyError` |',
      '| `read(streamId, fromVersion)` | 读取指定版本之后的事件 |',
      '| `version(streamId)` | 当前版本（就是流的长度） |',
      '| `saveSnapshot` / `latestSnapshot` | 存取快照 |',
      '| `rebuild(streamId, apply, initial)` | **从最近的快照开始**重放，而不是从头 |',
      '',
      '## 怎么算过',
      '',
      '- 并发写冲突被拦住，不产生丢失更新（门槛 `counters.lostUpdates = 0`）；',
      '- 1000 个事件、快照在 990 时，重建只重放 10 个',
      '  （门槛 `counters.eventsReplayed ≤ 12`）；',
      '- 没有快照时从 `initial` 重放全部，结果一致；',
      '- 快照存取都是深拷贝，外部修改影响不到存进去的状态。',
      '',
      '## 问题一：并发写',
      '',
      '两个人同时改同一个订单，各自基于版本 5 计算，各自追加了一个事件 ——',
      '后写的那个把前一个的前提悄悄作废了。事件流里同时存在两条互相矛盾的记录，',
      '而且没有任何报错。',
      '',
      '解法是**乐观并发**：追加时带上「我以为的版本」，对不上就拒绝。',
      '`stream.length !== expectedVersion` 这一行就是事件溯源里唯一的写冲突防线。',
      '',
      '## 问题二：重放太慢',
      '',
      '一个订单积累了一万个事件，每次读都从头折叠一万次。',
      '解法是**快照**：定期把折叠结果存下来，之后只重放快照之后的部分。',
      '',
      '注意忽略快照的实现**功能完全正确**，只是读取成本随历史长度线性增长 ——',
      '这正是这类问题难被发现的原因：上线时一切正常，半年后开始变慢，',
      '而那时已经没人记得读路径是从头折叠的。',
      '',
      '还有一处：快照必须**存副本**。存引用的话，后续 `apply` 原地改动会把快照一起改掉，',
      '于是「历史状态」悄悄变成了当前状态 —— 事件溯源最重要的那个卖点就这么没了。',
    ].join('\n'),
    [
      'Eight stages have treated events as **notifications**: state lives in a database and events tell',
      'others what happened. Event sourcing inverts that — **events are the only truth**, and state is',
      'computed by folding them from the beginning.',
      '',
      '```',
      'state = events.reduce(apply, initial)',
      '```',
      '',
      'The benefits are concrete: state at any historical moment can be reconstructed, auditing is complete',
      'by construction, and "why is this order this amount" always has an answer. The cost is two new',
      'problems, both of which this stage solves.',
      '',
      '## What to build',
      '',
      '`createEventStore()` in `src/eventstore.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `append(streamId, events, expectedVersion)` | Throws `ConcurrencyError` on a version mismatch |',
      '| `read(streamId, fromVersion)` | Events after a given version |',
      '| `version(streamId)` | The current version (the stream\'s length) |',
      '| `saveSnapshot` / `latestSnapshot` | Store and load snapshots |',
      '| `rebuild(streamId, apply, initial)` | Replay **from the latest snapshot**, not from the start |',
      '',
      '## What counts as passing',
      '',
      '- Concurrent conflicts are refused, producing no lost updates (`counters.lostUpdates = 0`);',
      '- With 1000 events snapshotted at 990, rebuilding replays ten (`counters.eventsReplayed ≤ 12`);',
      '- Without a snapshot, replaying everything from `initial` gives the same answer;',
      '- Snapshots are deep-copied in and out, so outside mutation cannot reach the stored state.',
      '',
      '## Problem one: concurrent writes',
      '',
      'Two people edit one order, both computing from version 5 and both appending an event — and the later',
      'write quietly invalidates the earlier one\'s premise. The stream now holds two contradictory records',
      'and nothing reported an error.',
      '',
      'The answer is **optimistic concurrency**: append with the version you believed, and be refused if it',
      'has moved. The line `stream.length !== expectedVersion` is the only write-conflict defence event',
      'sourcing has.',
      '',
      '## Problem two: replay cost',
      '',
      'An order with ten thousand events refolds all ten thousand on every read. The answer is **snapshots**:',
      'periodically store the folded result and replay only what came after.',
      '',
      'Note that an implementation ignoring snapshots is **functionally perfect** — its read cost merely grows',
      'linearly with history. That is exactly why this class of problem stays hidden: everything is fine at',
      'launch, it starts slowing six months later, and by then nobody remembers the read path folds from the',
      'beginning.',
      '',
      'One more thing: snapshots must store **copies**. Store a reference and a later in-place `apply`',
      'mutates the snapshot too, so "historical state" quietly becomes current state — and event sourcing\'s',
      'most important selling point is gone.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**append** —— 乐观并发的唯一防线',
      '',
      '```mermaid',
      'flowchart TD',
      '  AP["append(streamId, events, expectedVersion)"] --> V{"stream.length === expectedVersion？"}',
      '  V -- 不相等 --> CE["抛 ConcurrencyError(期望, 实际)"]',
      '  V -- 相等 --> PUSH["事件依次追加到流尾<br/>版本号 = 流的长度，不需要单独维护"]',
      '```',
      '',
      '这个判断没有任何锁：乐观并发的意思就是「先干，冲突了再说」。',
      '它成立的前提是版本读取和追加之间不会被打断 —— 在真实数据库里，',
      '这一句要靠 `WHERE version = ?` 的条件更新来保证。',
      '',
      '**快照与重建** —— `from` 这一个变量就是整个快照机制',
      '',
      '```mermaid',
      'flowchart TD',
      '  SS["saveSnapshot(streamId, version, state)"] --> COPY1["深拷贝之后再存<br/>存引用的话，之后的 apply 会把历史一起改掉"]',
      '  RB["rebuild(streamId, apply, initial)"] --> SNAP{"这条流有快照吗？"}',
      '  SNAP -- 有 --> FROM["state = 快照状态的拷贝<br/>from = 快照的 version"]',
      '  SNAP -- 没有 --> ZERO["state = initial<br/>from = 0"]',
      '  FROM --> FOLD',
      '  ZERO --> FOLD["只重放 stream.slice(from)<br/>state = apply(state, event) 逐个折叠"]',
      '  FOLD --> DONE["当前状态"]',
      '```',
      '',
      '忽略快照就是把 `FROM` 那条边删掉，所有请求都走 `ZERO` ——',
      '功能完全正确，成本随历史线性增长。门槛数的正是 `FOLD` 里折叠了几次。',
    ].join('\n'),
    [
      '**append** — optimistic concurrency\'s only defence',
      '',
      '```mermaid',
      'flowchart TD',
      '  AP["append(streamId, events, expectedVersion)"] --> V{"stream.length === expectedVersion?"}',
      '  V -- differs --> CE["throw ConcurrencyError(expected, actual)"]',
      '  V -- equal --> PUSH["append the events to the stream<br/>version = stream length, nothing extra to maintain"]',
      '```',
      '',
      'This check takes no lock: optimistic concurrency means "act first, deal with conflicts after". It holds',
      'because nothing interleaves between reading the version and appending — in a real database that',
      'guarantee comes from a conditional update with `WHERE version = ?`.',
      '',
      '**Snapshots and rebuilding** — the single variable `from` is the entire mechanism',
      '',
      '```mermaid',
      'flowchart TD',
      '  SS["saveSnapshot(streamId, version, state)"] --> COPY1["deep-copy before storing<br/>store a reference and later applies rewrite history"]',
      '  RB["rebuild(streamId, apply, initial)"] --> SNAP{"does this stream have a snapshot?"}',
      '  SNAP -- yes --> FROM["state = a copy of the snapshot state<br/>from = the snapshot\'s version"]',
      '  SNAP -- no --> ZERO["state = initial<br/>from = 0"]',
      '  FROM --> FOLD',
      '  ZERO --> FOLD["replay only stream.slice(from)<br/>state = apply(state, event), folded one at a time"]',
      '  FOLD --> DONE["current state"]',
      '```',
      '',
      'Ignoring snapshots means deleting the `FROM` edge so every request takes `ZERO` — functionally',
      'perfect, with cost growing linearly in history. The gate counts exactly how many folds happen inside',
      '`FOLD`.',
    ].join('\n')
  ),
  checklist: [
    t('状态由事件折叠得出', 'State is folded from events'),
    t('版本不匹配的追加被拒绝', 'An append with a stale version is refused'),
    t('read 能从指定版本之后开始', 'read can start after a given version'),
    t('rebuild 从最近的快照开始', 'rebuild starts from the latest snapshot'),
    t('快照不改变重建出来的状态', 'Snapshots do not change the rebuilt state'),
  ],
  pitfalls: [
    t(
      '`append` 不检查版本，直接往后追加。两个并发写都会成功，而它们各自是基于同一个旧状态算出来的——比如两个人同时把订单从「待支付」改成「已支付」和「已取消」，最后事件流里两个都在。乐观并发的检查是事件溯源里唯一的写冲突防线。',
      'Appending without checking the version. Both concurrent writes succeed while each was computed from the same old state — two people moving an order from pending to paid and to cancelled, with both events ending up in the stream. The optimistic check is the only write-conflict defence event sourcing has.'
    ),
    t(
      '`rebuild` 忽略快照，永远从版本 0 开始折叠。功能完全正确，性能随事件数线性劣化——一个跑了两年的订单聚合可能有几万个事件，每次读都重放一遍。快照的存在就是为了让读取成本与历史长度脱钩。',
      'Ignoring snapshots in `rebuild` and always folding from version zero. Functionally perfect, and read cost degrades linearly with history — an aggregate two years old may hold tens of thousands of events replayed on every read. Snapshots exist precisely to decouple read cost from history length.'
    ),
    t(
      '快照存的是状态对象的引用而不是副本。之后 `apply` 在这个对象上原地修改，快照跟着被改掉了——重建出来的「历史状态」其实是当前状态。这类 bug 在读多写少的场景下可能几个月都不暴露，一旦暴露就是「审计数据对不上」。',
      'Storing a reference to the state object in the snapshot rather than a copy. Later `apply` calls mutate that object in place and the snapshot changes with it, so the "historical state" rebuilt from it is actually the current one. In read-heavy workloads this can hide for months and surfaces as an audit that does not reconcile.'
    ),
    t(
      '把版本号理解成「事件的数量」并在 append 时用 `events.length` 当新版本。一次 append 写入多个事件时，版本会跳跃，而调用方拿到的 expectedVersion 语义变得含糊。约定应该明确：版本 = 这个流里事件的总数，append 之后新版本 = 旧版本 + 本次事件数。',
      'Treating the version as an event count and using `events.length` as the new version on append. Writing several events at once makes the version jump and the meaning of `expectedVersion` ambiguous for callers. Fix the convention: version is the total number of events in the stream, and after an append the new version is the old one plus the number written.'
    ),
  ],
  hints: [
    t(
      '每个 stream 存一个数组就够了，版本就是 `array.length`。`read(id, from)` 是 `array.slice(from)`。',
      'One array per stream suffices, with the version being `array.length`. `read(id, from)` is `array.slice(from)`.'
    ),
    t(
      '`rebuild` 先取快照：有就从 `snapshot.state` 和 `snapshot.version` 开始，没有就从 initial 和 0 开始，然后 `read(id, 起始版本)` 折叠剩下的。',
      'In `rebuild`, fetch the snapshot first: start from its state and version if present, otherwise from `initial` and zero, then fold whatever `read(id, startVersion)` returns.'
    ),
  ],
  extension: t(
    [
      '事件溯源最常见的误解是「它是一种存储方式」。它其实是一种**建模决策**：',
      '你认为系统的本质是「当前状态」还是「发生过的事情」。',
      '账本、审计、版本控制天然适合事件溯源；一个用户资料表就不适合——',
      '没人关心昵称改过几次，为此付出重建成本毫无意义。',
      '',
      '快照策略本身有讲究。**每 N 个事件存一次**最简单，但对冷门聚合是浪费；',
      '**按重建耗时**（重放超过 X 毫秒就存一个）更贴合实际收益。',
      '还有一个坑：快照的格式也会演进，而旧快照没法自动升级——',
      '所以很多实现干脆把快照当作**可丢弃的缓存**，格式变了就全部删掉重建，',
      '反正事件流还在。这个心态很重要：快照永远不是真相。',
      '',
      '乐观并发之外还有一个更细的粒度问题：**冲突不总是真冲突**。',
      '两个人一个改收货地址、一个加了备注，版本冲突了但业务上并不矛盾。',
      '成熟系统会做**语义合并**：检查两次修改是否触及同一组字段，',
      '不冲突就自动重放到新版本上。这和 Git 的 rebase 是同一个思路。',
      '',
      '最后，事件溯源和 CQRS 几乎总是一起出现，但它们是两件事。',
      'CQRS 说的是「读和写用不同的模型」，事件溯源说的是「写模型存事件」。',
      '可以只用 CQRS 不用事件溯源，反过来也行——只是事件溯源的读性能问题',
      '几乎必然把你推向 CQRS，这就是下一关的内容。',
    ].join('\n'),
    [
      'The commonest misunderstanding about event sourcing is that it is a storage technique. It is a',
      'modelling decision: whether you consider the essence of the system to be its current state or the',
      'things that happened. Ledgers, audits and version control fit naturally; a user profile table does',
      'not — nobody cares how many times a nickname changed, and paying reconstruction costs for it is',
      'pointless.',
      '',
      'Snapshot policy deserves thought. Every N events is simplest and wasteful for cold aggregates; by',
      'rebuild time — snapshot once replay exceeds X milliseconds — tracks the actual benefit better. One',
      'trap: snapshot formats evolve too, and old snapshots cannot be upgraded automatically, so many',
      'implementations treat snapshots as a disposable cache, deleting them all when the format changes',
      'since the event stream is still there. That mindset matters: a snapshot is never the truth.',
      '',
      'Beyond optimistic concurrency there is a finer question: not every conflict is a real conflict. One',
      'person edits the delivery address while another adds a note — the versions collide and the business',
      'meanings do not. Mature systems do semantic merging, checking whether the two edits touch the same',
      "fields and replaying automatically onto the new version when they do not. Same idea as Git's rebase.",
      '',
      'Finally, event sourcing and CQRS almost always appear together and are two different things. CQRS',
      'says reads and writes use different models; event sourcing says the write model stores events. You',
      'can have either without the other — and the read-performance problem of event sourcing pushes you',
      'towards CQRS almost inevitably, which is the next stage.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/eventstore.ts',
      code`
        import type { OrderEvent } from './contract';

        export class ConcurrencyError extends Error {
          streamId: string;
          expected: number;
          actual: number;

          constructor(streamId: string, expected: number, actual: number) {
            super('stream ' + streamId + ' is at version ' + actual + ', not ' + expected);
            this.name = 'ConcurrencyError';
            this.streamId = streamId;
            this.expected = expected;
            this.actual = actual;
          }
        }

        export interface Snapshot {
          version: number;
          state: unknown;
        }

        export interface EventStore {
          /** Throws ConcurrencyError when expectedVersion does not match the current version */
          append(streamId: string, events: OrderEvent[], expectedVersion: number): void;
          /** Events after version fromVersion, or all of them when omitted */
          read(streamId: string, fromVersion?: number): OrderEvent[];
          /** Total number of events in the stream */
          version(streamId: string): number;
          saveSnapshot(streamId: string, version: number, state: unknown): void;
          latestSnapshot(streamId: string): Snapshot | null;
          /** Replay from the most recent snapshot and return the folded result */
          rebuild(
            streamId: string,
            apply: (state: unknown, event: OrderEvent) => unknown,
            initial: unknown
          ): unknown;
        }

        export function createEventStore(): EventStore {
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
        import { createEventStore, ConcurrencyError } from '../src/eventstore';
        import { count } from '@lab/metrics';

        function amountEvent(id: string, delta: number) {
          return { id, type: 'amount.changed', payload: { delta } };
        }

        const applyAmount = (state: any, event: any) => ({
          total: (state.total || 0) + Number(event.payload.delta),
        });

        describe('Stage 9 · Event sourcing', () => {
          it('an empty stream is at version 0', () => {
            expect(createEventStore().version('order-1')).toBe(0);
          });

          it('after appending, the version equals the event count', () => {
            const store = createEventStore();
            store.append('order-1', [amountEvent('e1', 10), amountEvent('e2', 5)], 0);
            expect(store.version('order-1')).toBe(2);

            store.append('order-1', [amountEvent('e3', 1)], 2);
            expect(store.version('order-1')).toBe(3);
          });

          it('read returns every event', () => {
            const store = createEventStore();
            store.append('order-1', [amountEvent('e1', 10), amountEvent('e2', 5)], 0);
            expect(store.read('order-1').map((e) => e.id)).toEqual(['e1', 'e2']);
          });

          it('read can start after a given version', () => {
            const store = createEventStore();
            store.append('order-1', [amountEvent('e1', 1), amountEvent('e2', 2), amountEvent('e3', 3)], 0);
            expect(store.read('order-1', 2).map((e) => e.id)).toEqual(['e3']);
          });

          it('state is derived by folding the events', () => {
            const store = createEventStore();
            store.append('order-1', [amountEvent('e1', 10), amountEvent('e2', -3)], 0);
            expect(store.rebuild('order-1', applyAmount, { total: 0 })).toEqual({ total: 7 });
          });

          it('an append with a mismatched version is rejected [gate:concurrency]', () => {
            const store = createEventStore();
            store.append('order-1', [amountEvent('e1', 10)], 0);

            // Both concurrent writers believe they are on version 1
            store.append('order-1', [amountEvent('e2', 5)], 1);

            let conflicts = 0;
            try {
              store.append('order-1', [amountEvent('e3', 7)], 1);
            } catch (caught) {
              if (caught instanceof ConcurrencyError) conflicts += 1;
            }

            count('lostUpdates', conflicts === 1 ? 0 : 1);
            expect(conflicts).toBe(1);
            // The conflicting event must not be written
            expect(store.version('order-1')).toBe(2);
          });

          it('ConcurrencyError carries the expected and actual versions', () => {
            const store = createEventStore();
            store.append('order-1', [amountEvent('e1', 1)], 0);
            let error: any = null;
            try {
              store.append('order-1', [amountEvent('e2', 1)], 0);
            } catch (caught) {
              error = caught;
            }
            expect(error.expected).toBe(0);
            expect(error.actual).toBe(1);
          });

          it('separate streams do not affect each other', () => {
            const store = createEventStore();
            store.append('order-1', [amountEvent('e1', 10)], 0);
            store.append('order-2', [amountEvent('e2', 20)], 0);
            expect(store.version('order-1')).toBe(1);
            expect(store.rebuild('order-2', applyAmount, { total: 0 })).toEqual({ total: 20 });
          });

          it('a snapshot does not change the rebuilt state', () => {
            const store = createEventStore();
            store.append('order-1', [amountEvent('e1', 10), amountEvent('e2', 5)], 0);
            const withoutSnapshot = store.rebuild('order-1', applyAmount, { total: 0 });

            store.saveSnapshot('order-1', 1, { total: 10 });
            const withSnapshot = store.rebuild('order-1', applyAmount, { total: 0 });

            expect(withSnapshot).toEqual(withoutSnapshot);
          });

          it('a snapshot stores a copy that later applies cannot reach', () => {
            const store = createEventStore();
            const state = { total: 10 };
            store.saveSnapshot('order-1', 1, state);
            state.total = 999;

            expect(store.latestSnapshot('order-1')!.state).toEqual({ total: 10 });
          });

          it('latestSnapshot returns null when there is no snapshot', () => {
            expect(createEventStore().latestSnapshot('order-1')).toBeNull();
          });

          it('a rebuild starts from the latest snapshot, not from the beginning [gate:snapshot]', () => {
            const store = createEventStore();
            const events: any[] = [];
            for (let index = 0; index < 1000; index += 1) events.push(amountEvent('e' + index, 1));
            store.append('order-1', events, 0);
            store.saveSnapshot('order-1', 990, { total: 990 });

            let replayed = 0;
            const counting = (state: any, event: any) => {
              replayed += 1;
              return applyAmount(state, event);
            };

            const rebuilt = store.rebuild('order-1', counting, { total: 0 });
            count('eventsReplayed', replayed);

            expect(rebuilt).toEqual({ total: 1000 });
            // An implementation that folds from the start does 1000 iterations here
            expect(replayed).toBeLessThanOrEqual(12);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.lostUpdates',
      op: 'eq',
      value: 0,
      zh: '并发写冲突被拦住，不产生丢失更新',
      en: 'A concurrent write conflict is refused, so no update is lost',
      dimension: 'correctness',
      scope: 'gate:concurrency',
    }),
    gate({
      metric: 'counters.eventsReplayed',
      op: 'lte',
      value: 12,
      unit: 'events',
      zh: '有快照时重建只重放快照之后的事件',
      en: 'With a snapshot, rebuilding replays only what came after it',
      dimension: 'latency',
      scope: 'gate:snapshot',
    }),
  ],
  referenceFiles: [
    file(
      'src/eventstore.ts',
      code`
        import type { OrderEvent } from './contract';

        export class ConcurrencyError extends Error {
          streamId: string;
          expected: number;
          actual: number;

          constructor(streamId: string, expected: number, actual: number) {
            super('stream ' + streamId + ' is at version ' + actual + ', not ' + expected);
            this.name = 'ConcurrencyError';
            this.streamId = streamId;
            this.expected = expected;
            this.actual = actual;
          }
        }

        export interface Snapshot {
          version: number;
          state: unknown;
        }

        export interface EventStore {
          append(streamId: string, events: OrderEvent[], expectedVersion: number): void;
          read(streamId: string, fromVersion?: number): OrderEvent[];
          version(streamId: string): number;
          saveSnapshot(streamId: string, version: number, state: unknown): void;
          latestSnapshot(streamId: string): Snapshot | null;
          rebuild(
            streamId: string,
            apply: (state: unknown, event: OrderEvent) => unknown,
            initial: unknown
          ): unknown;
        }

        export function createEventStore(): EventStore {
          const streams = new Map<string, OrderEvent[]>();
          const snapshots = new Map<string, Snapshot>();

          function streamOf(streamId: string): OrderEvent[] {
            const existing = streams.get(streamId);
            if (existing) return existing;
            const created: OrderEvent[] = [];
            streams.set(streamId, created);
            return created;
          }

          return {
            append(streamId: string, events: OrderEvent[], expectedVersion: number): void {
              const stream = streamOf(streamId);
              // The only guard against write conflicts in event sourcing. Without it, two concurrent
              // writes based on the same old state both succeed and the stream ends up holding two contradictory events
              if (stream.length !== expectedVersion) {
                throw new ConcurrencyError(streamId, expectedVersion, stream.length);
              }
              for (const event of events) stream.push(event);
            },

            read(streamId: string, fromVersion?: number): OrderEvent[] {
              return streamOf(streamId).slice(fromVersion ?? 0);
            },

            version(streamId: string): number {
              return streamOf(streamId).length;
            },

            saveSnapshot(streamId: string, version: number, state: unknown): void {
              // Store a copy: storing a reference lets a later in-place apply mutate the snapshot too,
              // turning the historical state into the current one
              snapshots.set(streamId, { version, state: JSON.parse(JSON.stringify(state)) });
            },

            latestSnapshot(streamId: string): Snapshot | null {
              const snapshot = snapshots.get(streamId);
              if (!snapshot) return null;
              return { version: snapshot.version, state: JSON.parse(JSON.stringify(snapshot.state)) };
            },

            rebuild(
              streamId: string,
              apply: (state: unknown, event: OrderEvent) => unknown,
              initial: unknown
            ): unknown {
              const snapshot = snapshots.get(streamId);
              // Start from the snapshot when there is one: ignoring it is perfectly correct,
              // it just makes read cost grow linearly with history length
              let state = snapshot ? JSON.parse(JSON.stringify(snapshot.state)) : initial;
              const from = snapshot ? snapshot.version : 0;

              for (const event of streamOf(streamId).slice(from)) {
                state = apply(state, event);
              }
              return state;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**版本就是 `stream.length`，没有单独的计数器。** 两处状态就有两处会不一致的可能——',
      '追加了事件但忘了加版本号，或者反过来。让版本成为事件数组的一个**推导属性**，',
      '这类 bug 在结构上就不可能发生。',
      '',
      '**`append` 里的检查在 push 之前。** 冲突时一个事件都不该被写进去。',
      '边写边检查（比如逐个 push 再比较）会在冲突时留下部分写入，',
      '而事件流是只增不改的，写进去的错误事件没法删掉。',
      '',
      '**快照存进去和读出来都做深拷贝。** 存的时候拷贝，防止调用方后续修改原对象；',
      '读的时候拷贝，防止调用方修改返回值污染存储。',
      '这里用 `JSON.parse(JSON.stringify(...))` 是因为状态是纯数据；',
      '真实实现里快照通常本来就要序列化落盘，深拷贝是顺带的。',
      '',
      '**`rebuild` 里 `from` 的语义是「已经折叠到第几个事件」。** 快照记的是版本号，',
      '而版本号等于事件数，所以 `slice(from)` 正好跳过已经算进快照的那些。',
      '这个等价关系成立的前提就是上面那条「版本 = 事件数」的约定——',
      '如果版本是另外维护的，这里就要多一次转换，也就多一处可能算错的地方。',
    ].join('\n'),
    [
      'The version is `stream.length` with no separate counter. Two pieces of state means two chances to',
      'disagree — an event appended without bumping the version, or the reverse. Making the version a',
      'derived property of the array makes that class of bug structurally impossible.',
      '',
      'The check in `append` happens before any push. On conflict not a single event should be written.',
      'Checking while writing — pushing one at a time and comparing — leaves a partial write on conflict,',
      'and since an event stream is append-only, wrongly written events cannot be removed.',
      '',
      'Snapshots are deep-copied both in and out: on save so a caller mutating the original cannot change',
      'the stored snapshot, on read so a caller mutating the result cannot corrupt storage.',
      '`JSON.parse(JSON.stringify(...))` suffices because the state is plain data; in a real implementation',
      'snapshots are serialised for persistence anyway and the copy comes free.',
      '',
      "In `rebuild`, `from` means \"how many events are already folded in\". A snapshot records a version,",
      'and a version equals an event count, so `slice(from)` skips exactly what the snapshot already',
      'includes. That equivalence rests on the "version equals event count" convention above — a separately',
      'maintained version would need a conversion here, and one more place to get the arithmetic wrong.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

const stage10 = {
  id: 'projection',
  title: t('第 10 关 · 读模型投影与最终一致', 'Stage 10 · Projections and eventual consistency'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关把事件当成了真相，但真相不好查。',
      '「列出所有待发货的订单」在事件溯源里意味着重放所有订单的全部事件 ——',
      '这个查询在生产上根本跑不动。',
      '',
      '解法是 **CQRS**：写用事件流，读用另外一份专门为查询优化的**读模型**，',
      '由事件流投影（project）出来。读模型可以是一张扁平表、一个索引、一个缓存 ——',
      '任何查得快的形状。它是**派生数据**，随时可以扔掉重建。',
      '',
      '## 要实现什么',
      '',
      '在 `src/projection.ts` 实现 `createProjection(reduce)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `catchUp(events)` | 从 `checkpoint()` 之后开始追，返回本次处理了几个 |',
      '| `checkpoint()` | 已经追到第几个位置 |',
      '| `state()` | 当前读模型（交出副本） |',
      '| `reset()` | 清空，用于全量重建 |',
      '',
      '## 怎么算过',
      '',
      '- 同一批事件被追两次，状态和追一次完全一样（门槛 `counters.doubleApplied = 0`）；',
      '- 从 checkpoint 续追时不重复处理已经追过的事件（门槛 `counters.reprocessed ≤ 0`）；',
      '- `reset()` 之后能从头完整重建；',
      '- `state()` 返回的对象被外部修改，不影响内部状态。',
      '',
      '## 可续 + 幂等，两条必须同时成立',
      '',
      '**可续**：投影器崩溃重启后从 checkpoint 接着追，而不是重头来过。',
      '一个跑了三个月的读模型，重头来过意味着几个小时的不可用。',
      '',
      '**幂等**：同一批事件被追两次，状态必须和追一次一样。这条是重点 ——',
      '投影器随时可能在「应用了事件但还没保存 checkpoint」时崩溃，重启后那个事件会被重放。',
      '如果 `reduce` 是「累加」，重放就会多加一次，而这个错误无声无息，',
      '只有对账时才会发现（下一关的内容）。',
      '',
      '顺序也不能反：**先应用，后推进 checkpoint**。反过来的话，',
      '中间崩溃会让这个事件永远丢失 —— checkpoint 已经越过它了，谁也不会再回头看它。',
      '两种顺序都会在崩溃时出错，区别是一种错成「多算一次」，一种错成「永远少一笔」，',
      '而前者可以靠幂等消掉，后者不能。',
    ].join('\n'),
    [
      'The previous stage made events the truth, and truth is awkward to query. "List every order awaiting',
      'shipment" under event sourcing means replaying every event of every order — a query that simply cannot',
      'run in production.',
      '',
      'The answer is **CQRS**: write through the event stream, read from a separate **read model** shaped for',
      'queries and projected from that stream. A read model can be a flat table, an index, a cache — whatever',
      'is fast to query. It is **derived data** and can be thrown away and rebuilt at any time.',
      '',
      '## What to build',
      '',
      '`createProjection(reduce)` in `src/projection.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `catchUp(events)` | Resume after `checkpoint()` and return how many were processed |',
      '| `checkpoint()` | The position reached so far |',
      '| `state()` | The current read model (as a copy) |',
      '| `reset()` | Clear it for a full rebuild |',
      '',
      '## What counts as passing',
      '',
      '- Catching up over the same events twice leaves the state as if it happened once',
      '  (`counters.doubleApplied = 0`);',
      '- Resuming from a checkpoint does not reprocess what came before (`counters.reprocessed ≤ 0`);',
      '- After `reset()` a full rebuild reproduces the state;',
      '- Mutating the object returned by `state()` does not affect the internal state.',
      '',
      '## Resumable and idempotent, both at once',
      '',
      '**Resumable**: after a crash, catching up continues from the checkpoint rather than starting over. For',
      'a read model that has been running three months, starting over means hours of unavailability.',
      '',
      '**Idempotent**: catching up over the same events twice must leave the state as if it happened once.',
      'This is the important one — a projector can crash between applying an event and saving the checkpoint,',
      'so that event is replayed on restart. If `reduce` accumulates, the replay adds it twice, silently, and',
      'only reconciliation finds it (the next stage).',
      '',
      'The order matters too: **apply first, advance the checkpoint second**. Reversed, a crash in between',
      'loses that event forever — the checkpoint has already passed it and nothing will look back. Both',
      'orders can go wrong on a crash; the difference is that one errs toward counting something twice and',
      'the other toward never counting it at all, and only the first can be cancelled by idempotency.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**catchUp(events)** —— 可续与幂等都在这两行里',
      '',
      '```mermaid',
      'flowchart TD',
      '  CU["catchUp(events)"] --> SLICE["pending = events.slice(position)<br/>幂等来自这一行：<br/>第二次追赶时 pending 是空的"]',
      '  SLICE --> LOOP{"pending 里还有事件吗？"}',
      '  LOOP -- 有 --> APPLY["current = reduce(current, event)"]',
      '  APPLY --> ADV["position += 1<br/>顺序：先应用，后推进 checkpoint"]',
      '  ADV --> LOOP',
      '  LOOP -- 没有了 --> RET["返回 pending.length"]',
      '```',
      '',
      '`SLICE` 负责幂等（重复的部分被切掉），`position` 负责可续（进度被记住），',
      '两者共用同一个变量，所以不会出现「记住了进度但仍然重复应用」这种半吊子状态。',
      '',
      '`APPLY → ADV` 的顺序不能换：换过来之后，崩在中间的那个事件会被 checkpoint 跳过，',
      '从此永远不会被投影 —— 而 `SLICE` 的幂等保护对「少算」这种错误无能为力。',
      '',
      '**另外三个方法**',
      '',
      '```mermaid',
      'flowchart TD',
      '  CP["checkpoint()"] --> POS["position —— 唯一的进度状态"]',
      '  ST["state()"] --> COPY["返回 { ...current } 副本<br/>读模型要被很多地方查<br/>交出内部对象等于交出改坏它的权力"]',
      '  RS["reset()"] --> CLR["current = {}, position = 0<br/>读模型是派生数据<br/>清空重建是标准修复手段，不是可选功能"]',
      '```',
    ].join('\n'),
    [
      '**catchUp(events)** — resumability and idempotency both live in two lines',
      '',
      '```mermaid',
      'flowchart TD',
      '  CU["catchUp(events)"] --> SLICE["pending = events.slice(position)<br/>idempotency comes from this line:<br/>on a second catch-up, pending is empty"]',
      '  SLICE --> LOOP{"any events left in pending?"}',
      '  LOOP -- yes --> APPLY["current = reduce(current, event)"]',
      '  APPLY --> ADV["position += 1<br/>order: apply first, advance the checkpoint second"]',
      '  ADV --> LOOP',
      '  LOOP -- none --> RET["return pending.length"]',
      '```',
      '',
      '`SLICE` provides idempotency (the already-seen prefix is cut away) and `position` provides',
      'resumability (progress is remembered). They share one variable, so there is no half-state where',
      'progress is remembered but events reapply anyway.',
      '',
      'The `APPLY → ADV` order cannot be swapped: swapped, an event interrupted by a crash is skipped by the',
      'checkpoint and never projected — and `SLICE`\'s idempotency protection does nothing against',
      'undercounting.',
      '',
      '**The other three methods**',
      '',
      '```mermaid',
      'flowchart TD',
      '  CP["checkpoint()"] --> POS["position — the only progress state"]',
      '  ST["state()"] --> COPY["return a { ...current } copy<br/>the read model is queried from everywhere<br/>handing out the internal object hands out permission to corrupt it"]',
      '  RS["reset()"] --> CLR["current = {}, position = 0<br/>a read model is derived data<br/>clear-and-rebuild is the standard repair, not an optional extra"]',
      '```',
    ].join('\n')
  ),
  checklist: [
    t('catchUp 只处理 checkpoint 之后的事件', 'catchUp processes only events after the checkpoint'),
    t('重复追赶同一批事件不改变状态', 'Catching up twice over the same events changes nothing'),
    t('checkpoint 随处理进度前进', 'The checkpoint advances with progress'),
    t('reset 之后可以全量重建', 'After reset, a full rebuild is possible'),
    t('reduce 不修改传入的状态', 'reduce does not mutate the state it is given'),
  ],
  pitfalls: [
    t(
      '每次 catchUp 都从头处理全部事件。状态是对的（如果 reduce 恰好幂等），但成本随历史线性增长——一个跑了半年的投影器每次追赶都要重放几百万个事件。checkpoint 存在的全部意义就是让「追赶」的代价只和新事件数量有关。',
      'Reprocessing the whole stream on every catch-up. The state is right, if `reduce` happens to be idempotent, and the cost grows linearly with history — a projector running for six months replays millions of events on every pass. The entire purpose of a checkpoint is making catch-up cost proportional to new events only.'
    ),
    t(
      '先保存 checkpoint 再应用事件。中间崩溃会让那个事件**永远丢失**——checkpoint 已经越过它了，重启后不会再处理。顺序必须是「先应用、后保存 checkpoint」，这样最坏情况是重复应用，而重复可以靠幂等消化。这和第 6 关 outbox 的「先发送后标记」是同一条原则。',
      'Saving the checkpoint before applying the event. A crash in between loses that event permanently, since the checkpoint has moved past it and the restart never revisits it. The order must be apply then checkpoint, so the worst case is a duplicate application which idempotency absorbs. Same principle as publish-then-mark in the outbox stage.'
    ),
    t(
      '认为「读模型是派生的」就等于「读模型可以随便错」。派生数据出错的后果一点不比源数据小——用户看到的是读模型。区别只在于**修复方式**：源数据错了要人工订正，读模型错了可以 reset 之后重建。所以 `reset` 不是可选功能，它是读模型的修复手段。',
      'Assuming that because a read model is derived, being wrong is acceptable. Wrong derived data is no less damaging than wrong source data — the read model is what users see. What differs is the repair: wrong source data needs manual correction, a wrong read model can be reset and rebuilt. So `reset` is not optional, it is the repair mechanism.'
    ),
    t(
      '在 reduce 里原地修改状态对象。投影器可能同时服务多个查询，或者持有历史状态用于对比；原地修改会让「上一次的状态」跟着变。更隐蔽的是：一旦 reduce 有副作用，「重放同一批事件」就不再幂等了——而幂等正是这一关的核心要求。',
      'Mutating the state object inside `reduce`. A projector may serve several queries at once or hold a previous state for comparison, and in-place mutation changes that too. More subtly, once `reduce` has side effects, replaying the same events stops being idempotent — and idempotency is this stage\'s central requirement.'
    ),
  ],
  hints: [
    t(
      'checkpoint 就是一个整数：已经处理到 events 数组的第几个位置。`catchUp` 是 `events.slice(checkpoint)`，处理完把 checkpoint 设成 `events.length`。',
      'The checkpoint is one integer: how far into the event array you have gone. `catchUp` is `events.slice(checkpoint)`, and afterwards the checkpoint becomes `events.length`.'
    ),
    t(
      '幂等靠的就是 checkpoint 本身：第二次 catchUp 时 `slice(checkpoint)` 是空数组，什么都不会重复应用。',
      'Idempotency comes from the checkpoint itself: on a second catch-up, `slice(checkpoint)` is empty and nothing is reapplied.'
    ),
  ],
  extension: t(
    [
      '读模型的「最终一致」有一个非常具体的用户可见后果：**读己之写**（read-your-writes）。',
      '用户提交订单后立刻刷新列表，投影器可能还没追上，于是他看不到自己刚下的单——',
      '在他看来这就是「下单失败了」，然后再下一次。',
      '',
      '常见的缓解手段有三种。**写后读主**：提交之后短时间内直接查事件流而不是读模型；',
      '**版本等待**：写操作返回一个版本号，读的时候带上它，读模型没追上就等一会儿；',
      '**乐观 UI**：前端先自己把结果画出来，不等后端确认。',
      '三种都不是「解决」，只是把窗口藏起来——CQRS 的最终一致性是架构的固有属性。',
      '',
      '投影器的运维也有讲究。一个读模型的 schema 变了（加了个字段），',
      '标准做法不是写迁移脚本，而是**新建一个投影器从头重放**，追上之后切换流量。',
      '这是事件溯源最实用的好处之一：读模型的「迁移」就是重建，',
      '而重建是一个纯粹的、可反复执行的、失败了重来就行的操作。',
      '',
      '还有一个规模上的问题：**重放需要多久**。一个积累了十亿事件的系统，',
      '从头重建一个投影器可能要几天。真实系统因此会保留读模型的定期快照，',
      '或者让投影器支持并行重放（按聚合 id 分片，各自独立重放）——',
      '而后者能成立，正是因为第 3 关的分区保证：不同订单之间没有顺序依赖。',
    ].join('\n'),
    [
      'Eventual consistency in a read model has one very concrete user-visible consequence: read-your-writes.',
      'A user submits an order and refreshes the list immediately, the projector has not caught up, and they',
      'do not see the order they just placed — which reads to them as a failed submission, so they submit again.',
      '',
      'There are three common mitigations. Read from the primary after a write, querying the event stream',
      'directly for a short window. Version waiting, where the write returns a version the read carries and',
      'waits for the read model to reach. Optimistic UI, where the frontend renders the result without',
      'waiting for confirmation. None of them solves it; they hide the window. Eventual consistency is',
      'inherent to CQRS.',
      '',
      'Operating projectors has its own idiom. When a read model\'s schema changes — a new field — the',
      'standard move is not a migration script but a new projector replaying from the beginning, with',
      'traffic switched over once it catches up. This is one of the most practical benefits of event',
      'sourcing: migrating a read model is rebuilding it, and a rebuild is a pure, repeatable operation you',
      'can simply run again after a failure.',
      '',
      'There is a scale problem too: how long a replay takes. A system with a billion events may need days',
      'to rebuild a projector from scratch. Real systems therefore keep periodic snapshots of read models,',
      'or make projectors replay in parallel, sharded by aggregate id. That last option works precisely',
      'because of the partitioning guarantee from stage 3: different orders have no ordering dependency.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'latency'],
  lab: {},
  starterFiles: [
    file(
      'src/projection.ts',
      code`
        import type { OrderEvent } from './contract';

        export type Reducer = (
          state: Record<string, unknown>,
          event: OrderEvent
        ) => Record<string, unknown>;

        export interface Projection {
          /** Catch up from the checkpoint and return how many events were processed this round */
          catchUp(events: OrderEvent[]): number;
          /** How far into the event stream processing has got */
          checkpoint(): number;
          state(): Record<string, unknown>;
          /** Clear the read model and checkpoint, for a full rebuild */
          reset(): void;
        }

        export function createProjection(reduce: Reducer): Projection {
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
        import { createProjection } from '../src/projection';
        import { count } from '@lab/metrics';

        function placed(id: string, orderId: string, amount: number) {
          return { id, type: 'order.placed', payload: { orderId, amount } };
        }

        /** An accumulating reducer: a non-idempotent implementation double-counts on replay */
        const sumByOrder = (state: any, event: any) => {
          const orderId = String(event.payload.orderId);
          return { ...state, [orderId]: (Number(state[orderId]) || 0) + Number(event.payload.amount) };
        };

        function stream(count: number) {
          const events: any[] = [];
          for (let index = 0; index < count; index += 1) {
            events.push(placed('e' + index, 'order-' + (index % 3), 10));
          }
          return events;
        }

        describe('Stage 10 · Read-model projection', () => {
          it('the checkpoint starts at 0 with empty state', () => {
            const projection = createProjection(sumByOrder);
            expect(projection.checkpoint()).toBe(0);
            expect(projection.state()).toEqual({});
          });

          it('catchUp processes every event and advances the checkpoint', () => {
            const projection = createProjection(sumByOrder);
            expect(projection.catchUp(stream(6))).toBe(6);
            expect(projection.checkpoint()).toBe(6);
            expect(projection.state()).toEqual({ 'order-0': 20, 'order-1': 20, 'order-2': 20 });
          });

          it('catching up on the same batch twice does not change the state [gate:idempotent]', () => {
            const projection = createProjection(sumByOrder);
            const events = stream(6);

            projection.catchUp(events);
            const afterFirst = projection.state();

            const second = projection.catchUp(events);
            const afterSecond = projection.state();

            count('doubleApplied', second);
            expect(second).toBe(0);
            expect(afterSecond).toEqual(afterFirst);
          });

          it('after appending, only the new events are processed [gate:resume]', () => {
            const projection = createProjection(sumByOrder);
            const events = stream(6);
            projection.catchUp(events);

            events.push(placed('e6', 'order-0', 5));
            events.push(placed('e7', 'order-1', 5));

            const processed = projection.catchUp(events);
            count('reprocessed', processed - 2);

            // An implementation that replays from the start processes eight here
            expect(processed).toBe(2);
            expect(projection.checkpoint()).toBe(8);
            expect(projection.state()).toEqual({ 'order-0': 25, 'order-1': 25, 'order-2': 20 });
          });

          it('catching up in batches matches catching up in one go', () => {
            const events = stream(9);

            const incremental = createProjection(sumByOrder);
            incremental.catchUp(events.slice(0, 3));
            incremental.catchUp(events.slice(0, 6));
            incremental.catchUp(events);

            const atOnce = createProjection(sumByOrder);
            atOnce.catchUp(events);

            expect(incremental.state()).toEqual(atOnce.state());
          });

          it('a full rebuild is possible after reset', () => {
            const projection = createProjection(sumByOrder);
            const events = stream(6);
            projection.catchUp(events);
            const before = projection.state();

            projection.reset();
            expect(projection.checkpoint()).toBe(0);
            expect(projection.state()).toEqual({});

            projection.catchUp(events);
            expect(projection.state()).toEqual(before);
          });

          it('an empty event stream does not error', () => {
            const projection = createProjection(sumByOrder);
            expect(projection.catchUp([])).toBe(0);
            expect(projection.state()).toEqual({});
          });

          it('state returns a copy that callers cannot use to corrupt the read model', () => {
            const projection = createProjection(sumByOrder);
            projection.catchUp(stream(3));

            const snapshot: any = projection.state();
            snapshot['order-0'] = 9999;

            expect((projection.state() as any)['order-0']).toBe(10);
          });

          it('reduce receives state that the previous call did not corrupt', () => {
            const seen: any[] = [];
            const projection = createProjection((state, event) => {
              seen.push(state);
              return sumByOrder(state, event);
            });
            projection.catchUp(stream(3));

            // The first reduce sees empty state — which it would not, had it been mutated in place
            expect(seen[0]).toEqual({});
          });

          it('events before the checkpoint are not processed again', () => {
            const applied: string[] = [];
            const projection = createProjection((state, event) => {
              applied.push(event.id);
              return sumByOrder(state, event);
            });

            const events = stream(4);
            projection.catchUp(events);
            projection.catchUp(events);
            projection.catchUp(events);

            expect(applied).toEqual(['e0', 'e1', 'e2', 'e3']);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.doubleApplied',
      op: 'eq',
      value: 0,
      zh: '重复追赶不会重复应用事件',
      en: 'A repeated catch-up reapplies nothing',
      dimension: 'correctness',
      scope: 'gate:idempotent',
    }),
    gate({
      metric: 'counters.reprocessed',
      op: 'lte',
      value: 0,
      zh: '续追只处理新事件，不从头重放',
      en: 'Resuming processes only new events instead of replaying',
      dimension: 'latency',
      scope: 'gate:resume',
    }),
  ],
  referenceFiles: [
    file(
      'src/projection.ts',
      code`
        import type { OrderEvent } from './contract';

        export type Reducer = (
          state: Record<string, unknown>,
          event: OrderEvent
        ) => Record<string, unknown>;

        export interface Projection {
          catchUp(events: OrderEvent[]): number;
          checkpoint(): number;
          state(): Record<string, unknown>;
          reset(): void;
        }

        export function createProjection(reduce: Reducer): Projection {
          let current: Record<string, unknown> = {};
          let position = 0;

          return {
            catchUp(events: OrderEvent[]): number {
              // This line is where idempotency comes from: on a second catch-up the slice is empty and nothing is reapplied
              const pending = events.slice(position);

              for (const event of pending) {
                // Apply first, advance the checkpoint second. The other way round, a crash in between
                // loses this event forever — the checkpoint has already moved past it
                current = reduce(current, event);
                position += 1;
              }

              return pending.length;
            },

            checkpoint(): number {
              return position;
            },

            state(): Record<string, unknown> {
              // Hand out a copy: the read model is queried from many places, and returning the internal object
              // means any one caller can corrupt it
              return { ...current };
            },

            reset(): void {
              // A read model is derived data, and the way to fix a broken one is to clear and rebuild,
              // so this is not an optional feature
              current = {};
              position = 0;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`events.slice(position)` 一行同时给出了「可续」和「幂等」。** 可续是因为它跳过了',
      '已经处理的部分，幂等是因为第二次调用时这个 slice 是空的。',
      '两个看起来独立的要求，其实来自同一个 checkpoint。',
      '',
      '**`position += 1` 在 `reduce` 之后。** 顺序反过来会让「应用了但没记录」变成',
      '「记录了但没应用」——前者导致重复（可以靠幂等消化），后者导致丢失（无法补救）。',
      '这和第 6 关 outbox 的「先发送后标记」是同一条原则：',
      '在两种失败之间选可以被下游修复的那一种。',
      '',
      '**`current = reduce(current, event)` 而不是 `reduce(current, event)`。** ',
      'reducer 必须返回新状态而不是原地改。这不只是风格：一旦 reduce 有副作用，',
      '「重放同一批事件得到同样结果」这条性质就不成立了，而整个 CQRS 的重建能力',
      '都建立在这条性质上。',
      '',
      '**`state()` 返回浅拷贝。** 对这一关的扁平读模型够用。',
      '真实的读模型是嵌套结构时，浅拷贝挡不住深层修改——',
      '那时候要么深拷贝（贵），要么让读模型不可变（更好，但需要不可变数据结构）。',
    ].join('\n'),
    [
      '`events.slice(position)` delivers both resumability and idempotency in one line. Resumable because',
      'it skips what was processed, idempotent because on a second call that slice is empty. Two apparently',
      'independent requirements coming from a single checkpoint.',
      '',
      '`position += 1` comes after `reduce`. Reversing them turns "applied but not recorded" into',
      '"recorded but not applied" — the first causes a duplicate that idempotency absorbs, the second',
      'causes a loss that nothing repairs. Same principle as publish-then-mark in the outbox stage: given',
      'two failure modes, take the one something downstream can fix.',
      '',
      '`current = reduce(current, event)` rather than calling `reduce` for its effect. The reducer must',
      'return a new state instead of mutating. That is not merely style: once `reduce` has side effects,',
      '"replaying the same events yields the same result" stops holding, and the entire rebuild capability',
      'of CQRS rests on that property.',
      '',
      '`state()` returns a shallow copy, which suffices for the flat read model here. Real read models are',
      'nested, and a shallow copy does not stop deep mutation — at which point you either deep-copy, which',
      'is expensive, or make the read model immutable, which is better but needs immutable data structures.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

const stage11 = {
  id: 'reconciliation',
  title: t('第 11 关 · 端到端对账', 'Stage 11 · End-to-end reconciliation'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前十关每一关都在努力做对：顺序、幂等、事务、补偿、投影。',
      '这一关承认一件事：**它们加起来仍然会错**。',
      '',
      '一个消费者在 rebalance 的窗口里重复处理了一次；一个补偿因为下游超时没执行成功；',
      '一个投影器在崩溃后少追了一个事件。每一处的概率都很低，',
      '乘上千万级的量之后，每天都会有几笔对不上。',
      '',
      '所以真实系统里必须有一道**独立于业务链路**的检查：把事件流折叠出的',
      '「应该是什么」和读模型里的「实际是什么」摆在一起比，把差异找出来。',
      '这就是对账。它不假设任何一层是对的。',
      '',
      '## 要实现什么',
      '',
      '在 `src/reconcile.ts` 实现 `reconcile(expected, actual, options)`，',
      '返回差异列表，每条是 `{ key, kind, expected, actual }`：',
      '',
      '| kind | 含义 |',
      '| --- | --- |',
      '| `missing` | 应该有，读模型里没有 |',
      '| `extra` | 读模型里有，本不该有 |',
      '| `mismatch` | 两边都有，但值不同 |',
      '',
      '`options.tolerance`：数值差异在这个范围内不算 mismatch。',
      '结果按 key 排序，让每次对账的输出可以直接比对。',
      '',
      '## 怎么算过',
      '',
      '- 三种差异一个都不漏报，也一个都不误报（门槛 `counters.reconcileErrors = 0`）；',
      '- 值为 `0`、`\'\'`、`false` 的字段不会被误报成 `missing`；',
      '- 浮点末位差异在 `tolerance` 内时不报 mismatch；',
      '- 输出按 key 排序。',
      '',
      '## 三个能毁掉一份对账的细节',
      '',
      '**两边的键都要遍历。** 只走 `expected` 的话，读模型里凭空多出来的记录永远发现不了 ——',
      '而那恰恰是最严重的一类差异：它意味着有人重复处理了一笔业务。',
      '',
      '**判断存在要用 `hasOwnProperty`，不能写 `if (source[key])`。**',
      '金额 0、状态空串、标志 false 都是完全合法的值，用真值判断会把它们全报成缺失。',
      '于是对账报告里每天几千条假差异 —— 没有人会去看第二天。',
      '',
      '**数字比较要带容差。** 事件流折叠和读模型累加的运算顺序不同，浮点末位必然有差异。',
      '用 `===` 的话对账每天报一堆 `0.0000001`。',
      '',
      '这三条指向同一件事：**对账工具自己报错会让人失去对它的信任，',
      '而一个没人信的对账等于没有。**',
    ].join('\n'),
    [
      'Ten stages have worked at getting things right: ordering, idempotency, transactions, compensation,',
      'projections. This one accepts that **together they will still be wrong sometimes**.',
      '',
      'A consumer reprocesses once inside a rebalance window; a compensation fails on a downstream timeout; a',
      'projector misses one event after a crash. Each is individually unlikely, and multiplied by tens of',
      'millions of operations, a handful disagree every day.',
      '',
      'So a real system needs a check **independent of the business path**: fold the event stream into what',
      'things should be, put it beside what the read model says they are, and find the differences. That is',
      'reconciliation, and it assumes no layer is correct.',
      '',
      '## What to build',
      '',
      '`reconcile(expected, actual, options)` in `src/reconcile.ts`, returning a list of differences shaped',
      '`{ key, kind, expected, actual }`:',
      '',
      '| kind | Meaning |',
      '| --- | --- |',
      '| `missing` | Should be there, absent from the read model |',
      '| `extra` | Present in the read model, should not be |',
      '| `mismatch` | Present in both, with different values |',
      '',
      '`options.tolerance`: numeric differences within it are not a mismatch. Results are sorted by key so',
      'successive runs can be diffed directly.',
      '',
      '## What counts as passing',
      '',
      '- Not one of the three kinds is missed, and not one is a false positive (`counters.reconcileErrors = 0`);',
      '- Fields holding `0`, `\'\'` or `false` are not reported as `missing`;',
      '- Float drift within `tolerance` is not reported as a mismatch;',
      '- Output is sorted by key.',
      '',
      '## Three details that can ruin a reconciliation',
      '',
      '**Walk the keys of both sides.** Walking only `expected` never finds records that appeared in the read',
      'model from nowhere — and those are the most serious kind, because they mean some business operation',
      'was processed twice.',
      '',
      '**Test presence with `hasOwnProperty`, never `if (source[key])`.** An amount of 0, an empty status',
      'string and a `false` flag are all perfectly legal values, and a truthiness test reports every one of',
      'them as missing. The report then carries thousands of false differences a day — and nobody opens it on',
      'the second day.',
      '',
      '**Compare numbers with a tolerance.** Folding the event stream and accumulating in the read model',
      'apply operations in different orders, so the last float digits inevitably differ. With `===`, the',
      'reconciliation reports a pile of `0.0000001` every day.',
      '',
      'All three point at the same thing: **a reconciliation tool that reports errors of its own loses trust,',
      'and a reconciliation nobody trusts is no reconciliation at all.**',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  R["reconcile(expected, actual, options)"] --> K["keys = expected 的键 ∪ actual 的键<br/>只走 expected 的话<br/>读模型里凭空多出来的记录永远发现不了"]',
      '  K --> EACH["逐个 key 判断"]',
      '  EACH --> HAS["用 hasOwnProperty 判断在不在<br/>写成 if (source[key]) 会把<br/>金额 0、空串、false 全报成缺失"]',
      '  HAS --> C{"两边的存在情况"}',
      '  C -- 只在 expected --> MISS["missing"]',
      '  C -- 只在 actual --> EX["extra"]',
      '  C -- 两边都有 --> EQ{"equal(左, 右, tolerance)？"}',
      '  EQ -- 相等 --> SKIP["不报"]',
      '  EQ -- 不等 --> MM["mismatch"]',
      '  MISS --> SORT',
      '  EX --> SORT',
      '  MM --> SORT["按 key 排序输出<br/>让相邻两次对账可以直接 diff<br/>看出「今天新增了哪些差异」"]',
      '',
      '  subgraph eq["equal() 只有两条规则"]',
      '    E1["两个都是数字 → 绝对差 ≤ tolerance<br/>折叠顺序不同，浮点末位必然有差"]',
      '    E2["其他情况 → 严格 ==="]',
      '  end',
      '',
      '  EQ -.-> eq',
      '```',
      '',
      '要点：这一关的代码很短，但它是全项目里唯一**不信任其他十关**的组件 ——',
      '它的输入是两份独立算出来的数据，它不参与生产，也不修复什么，只负责说出「这两份对不上」。',
      '',
      '图上三个分支各自对应一类真实故障：`missing` 是投影漏了，`extra` 是有人重复处理，',
      '`mismatch` 是补偿只做了一半。所以三种都不能漏，也都不能误报。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  R["reconcile(expected, actual, options)"] --> K["keys = keys of expected ∪ keys of actual<br/>walking only expected never finds<br/>records that appeared in the read model from nowhere"]',
      '  K --> EACH["examine each key"]',
      '  EACH --> HAS["test presence with hasOwnProperty<br/>if (source[key]) would report<br/>an amount of 0, an empty string and false as missing"]',
      '  HAS --> C{"presence on each side"}',
      '  C -- "only in expected" --> MISS["missing"]',
      '  C -- "only in actual" --> EX["extra"]',
      '  C -- "in both" --> EQ{"equal(left, right, tolerance)?"}',
      '  EQ -- equal --> SKIP["not reported"]',
      '  EQ -- differ --> MM["mismatch"]',
      '  MISS --> SORT',
      '  EX --> SORT',
      '  MM --> SORT["sort output by key<br/>so consecutive runs diff directly<br/>showing which differences are new today"]',
      '',
      '  subgraph eq["equal() has exactly two rules"]',
      '    E1["both numbers → absolute difference ≤ tolerance<br/>different fold orders always differ in the last digits"]',
      '    E2["anything else → strict ==="]',
      '  end',
      '',
      '  EQ -.-> eq',
      '```',
      '',
      'The point: this stage\'s code is short, but it is the one component in the project that **trusts none of',
      'the other ten** — its inputs are two independently computed datasets, it takes no part in production',
      'and repairs nothing, and its only job is to say "these two do not agree".',
      '',
      'Each of the three branches corresponds to a real failure: `missing` is a projection that fell behind,',
      '`extra` is something processed twice, `mismatch` is a compensation that half-completed. Which is why',
      'none of the three may be missed, and none may be invented.',
    ].join('\n')
  ),
  checklist: [
    t('完全一致时返回空列表', 'An exact match returns an empty list'),
    t('三种差异都能被识别', 'All three kinds of difference are detected'),
    t('容差内的数值差异不算 mismatch', 'Numeric drift within tolerance is not a mismatch'),
    t('结果按 key 排序，可稳定比对', 'Results are sorted by key and stable across runs'),
    t('不会把 0 或空字符串误判成缺失', 'Zero and empty string are not mistaken for missing'),
  ],
  pitfalls: [
    t(
      '用 `if (!actual[key])` 判断读模型里有没有这个 key。金额是 0、状态是空字符串、标志是 false 的记录会全部被误报成 missing——而这些恰恰是最常见的合法值。判断存在性要用 `Object.prototype.hasOwnProperty.call(actual, key)`，不能靠真值。',
      "Testing presence with `if (!actual[key])`. Every record whose amount is 0, status is an empty string or flag is false is reported as missing — and those are among the most common legitimate values. Presence must be tested with `Object.prototype.hasOwnProperty.call(actual, key)`, never truthiness."
    ),
    t(
      '只遍历 expected 的键。读模型里多出来的记录（`extra`）就永远发现不了——而这类差异往往是最严重的：它意味着有一条没有事件依据的数据凭空出现了，可能是重复消费，也可能是别的 bug 写进来的脏数据。两边的键都要遍历。',
      'Iterating only the keys of `expected`. Records that exist only in the read model — the `extra` kind — are never found, and those are often the most serious: data with no event to justify it, from a duplicate consumption or from some other bug writing directly. Both key sets must be walked.'
    ),
    t(
      '数值比较用 `===`。事件流折叠出来的金额和读模型里累加出来的金额，即使逻辑完全一致，浮点运算的顺序不同也会产生末位差异。对账工具每天报一堆 0.0000001 的差异，很快就没人看了。容差不是妥协，是让工具的输出保持可信。',
      'Comparing numbers with `===`. An amount folded from the event stream and one accumulated in the read model differ in the last digits when the operations happen in a different order, even with identical logic. A tool reporting a pile of 0.0000001 differences every day soon goes unread. Tolerance is not a compromise, it is what keeps the output credible.'
    ),
    t(
      '发现差异就自动修复读模型。听起来很贴心，实际上非常危险：对账工具无法判断差异的**原因**——可能读模型错了，也可能事件流本身有问题（比如重复事件）。自动按事件流覆盖读模型，会把一个「读模型正确、事件流有脏数据」的情况改成两边都错。对账只负责发现，修复是另一个决定。',
      'Automatically repairing the read model when a difference is found. It sounds helpful and is dangerous: the tool cannot determine the cause — the read model may be wrong, or the event stream itself may be (a duplicated event, say). Overwriting the read model from the stream turns "read model right, stream dirty" into both being wrong. Reconciliation detects; repair is a separate decision.'
    ),
  ],
  hints: [
    t(
      '把两边的 key 合成一个集合遍历：`new Set([...Object.keys(expected), ...Object.keys(actual)])`，然后按「谁有谁没有」分三种情况。',
      'Walk the union of both key sets — `new Set([...Object.keys(expected), ...Object.keys(actual)])` — and branch on which side has each key.'
    ),
    t(
      '容差只对两边都是数字的情况生效，其他类型用 `===` 或者深比较。',
      'Tolerance applies only when both sides are numbers; other types compare with `===` or a deep comparison.'
    ),
  ],
  extension: t(
    [
      '对账在金融系统里是强制的，而且通常是**多方对账**：',
      '自己的账、支付渠道的账、银行的账，三份数据两两比对。',
      '任何一处不一致都会触发人工介入——因为在钱的领域，',
      '「自动修复」这四个字本身就是风险。',
      '',
      '对账的时机也有讲究。**实时对账**能最快发现问题，但事件流和读模型之间',
      '本来就有最终一致的延迟窗口，实时比对会产生大量「其实只是还没追上」的假差异。',
      '所以生产上的常见做法是**延迟对账**：只比对 5 分钟以前的数据，',
      '用时间换掉那些会自己消失的差异。',
      '',
      '发现差异之后怎么办，是一个比检测本身更难的问题。三种典型策略：',
      '**告警**（人来判断，适合金额类）、**自动重建**（reset 投影器重放，',
      '适合确定是读模型问题的场景）、**记录并继续**（适合已知的、可容忍的偏差）。',
      '选哪一种取决于「差异的原因是否可以自动判定」——而大多数时候不可以。',
      '',
      '还有一个容易被忽略的角度：**对账工具自己也会错**。',
      '它读的是同一份数据、跑在同样的代码库上，一个共享的 bug 会让它',
      '和被检查的系统犯同样的错误，然后报告「一切正常」。',
      '所以严肃的对账往往用**不同的实现路径**——不同的语言、不同的团队、',
      '甚至直接从原始日志重算，刻意不复用生产代码。',
    ].join('\n'),
    [
      'Reconciliation is mandatory in financial systems, and usually multi-party: your own ledger, the',
      "payment provider's, the bank's, compared pairwise. Any disagreement triggers human involvement,",
      'because where money is concerned the phrase "automatic repair" is itself a risk.',
      '',
      'Timing matters. Real-time reconciliation finds problems fastest, and the event stream and read model',
      'have an eventual-consistency window by design, so comparing immediately produces a flood of false',
      'differences that are merely not-caught-up-yet. The common production answer is delayed',
      'reconciliation: compare only data older than five minutes, trading time for the disappearance of',
      'differences that resolve themselves.',
      '',
      'What to do about a difference is harder than detecting it. Three typical strategies: alert and let a',
      'human judge, which suits anything involving money; rebuild automatically by resetting the projector',
      'and replaying, when the read model is definitively at fault; or record and continue, for known',
      'tolerable drift. Which one applies depends on whether the cause can be determined automatically —',
      'and usually it cannot.',
      '',
      'One angle is easy to overlook: the reconciliation tool can be wrong too. It reads the same data and',
      'runs on the same codebase, so a shared bug makes it repeat the same mistake as the system it checks',
      'and then report that everything is fine. Serious reconciliation therefore takes a different',
      'implementation path — a different language, a different team, or recomputation straight from raw',
      'logs — deliberately not reusing production code.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/reconcile.ts',
      code`
        export type DiscrepancyKind = 'missing' | 'extra' | 'mismatch';

        export interface Discrepancy {
          key: string;
          kind: DiscrepancyKind;
          expected?: unknown;
          actual?: unknown;
        }

        export interface ReconcileOptions {
          /** When both sides are numbers, a difference no larger than this is not a mismatch */
          tolerance?: number;
        }

        /**
         * expected comes from folding the event stream, actual from the read model.
         * Returns the differences sorted by key; an empty array when they agree exactly.
         */
        export function reconcile(
          expected: Record<string, unknown>,
          actual: Record<string, unknown>,
          options?: ReconcileOptions
        ): Discrepancy[] {
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
        import { reconcile } from '../src/reconcile';
        import { count } from '@lab/metrics';

        describe('Stage 11 · End-to-end reconciliation', () => {
          it('returns an empty list when the two agree exactly', () => {
            expect(reconcile({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual([]);
          });

          it('returns an empty list when both sides are empty', () => {
            expect(reconcile({}, {})).toEqual([]);
          });

          it('a row absent from the read model is missing', () => {
            expect(reconcile({ a: 1, b: 2 }, { a: 1 })).toEqual([
              { key: 'b', kind: 'missing', expected: 2, actual: undefined },
            ]);
          });

          it('a row only in the read model is extra', () => {
            expect(reconcile({ a: 1 }, { a: 1, ghost: 9 })).toEqual([
              { key: 'ghost', kind: 'extra', expected: undefined, actual: 9 },
            ]);
          });

          it('a differing value is a mismatch', () => {
            expect(reconcile({ a: 10 }, { a: 12 })).toEqual([
              { key: 'a', kind: 'mismatch', expected: 10, actual: 12 },
            ]);
          });

          it('0 is not mistaken for absent', () => {
            // An implementation written as if (!actual[key]) reports this as missing
            expect(reconcile({ a: 0 }, { a: 0 })).toEqual([]);
          });

          it('an empty string and false are not mistaken either', () => {
            expect(reconcile({ a: '', b: false }, { a: '', b: false })).toEqual([]);
          });

          it('a numeric difference within tolerance is not a mismatch', () => {
            expect(reconcile({ a: 10 }, { a: 10.0000001 }, { tolerance: 0.001 })).toEqual([]);
            expect(reconcile({ a: 10 }, { a: 10.5 }, { tolerance: 0.001 })).toHaveLength(1);
          });

          it('without a tolerance, numbers must match exactly', () => {
            expect(reconcile({ a: 10 }, { a: 10.0000001 })).toHaveLength(1);
          });

          it('tolerance applies to numbers only', () => {
            expect(reconcile({ a: 'x' }, { a: 'y' }, { tolerance: 100 })).toEqual([
              { key: 'a', kind: 'mismatch', expected: 'x', actual: 'y' },
            ]);
          });

          it('results are sorted by key', () => {
            const found = reconcile({ z: 1, a: 1, m: 1 }, { z: 2, a: 2, m: 2 });
            expect(found.map((entry) => entry.key)).toEqual(['a', 'm', 'z']);
          });

          it('all three kinds of difference are caught, with no false positives [gate:reconcile]', () => {
            const expected = { keep: 1, drift: 100, gone: 7, zero: 0, blank: '' };
            const actual = { keep: 1, drift: 130, zero: 0, blank: '', ghost: 42 };

            const found = reconcile(expected, actual, { tolerance: 0.01 });
            const byKind = found.reduce((acc: any, entry) => {
              acc[entry.kind] = (acc[entry.kind] || 0) + 1;
              return acc;
            }, {});

            // Should be exactly: gone -> missing, drift -> mismatch, ghost -> extra
            const correct =
              found.length === 3 &&
              byKind.missing === 1 &&
              byKind.mismatch === 1 &&
              byKind.extra === 1;
            count('reconcileErrors', correct ? 0 : 1);

            expect(found.map((entry) => entry.key)).toEqual(['drift', 'ghost', 'gone']);
            expect(byKind).toEqual({ missing: 1, mismatch: 1, extra: 1 });
          });

          it('picks out the single difference buried in a pile of matching data', () => {
            const expected: Record<string, unknown> = {};
            const actual: Record<string, unknown> = {};
            for (let index = 0; index < 500; index += 1) {
              expected['order-' + index] = index;
              actual['order-' + index] = index;
            }
            actual['order-250'] = 999;

            const found = reconcile(expected, actual);
            expect(found).toHaveLength(1);
            expect(found[0]).toEqual({
              key: 'order-250',
              kind: 'mismatch',
              expected: 250,
              actual: 999,
            });
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.reconcileErrors',
      op: 'eq',
      value: 0,
      zh: '三种差异不漏报也不误报',
      en: 'All three kinds are found with no false positives',
      dimension: 'correctness',
      scope: 'gate:reconcile',
    }),
  ],
  referenceFiles: [
    file(
      'src/reconcile.ts',
      code`
        export type DiscrepancyKind = 'missing' | 'extra' | 'mismatch';

        export interface Discrepancy {
          key: string;
          kind: DiscrepancyKind;
          expected?: unknown;
          actual?: unknown;
        }

        export interface ReconcileOptions {
          tolerance?: number;
        }

        function has(source: Record<string, unknown>, key: string): boolean {
          // Cannot be written as if (source[key]): an amount of 0, an empty status string, a false flag
          // are all perfectly valid values, and a truthiness check reports every one of them as missing
          return Object.prototype.hasOwnProperty.call(source, key);
        }

        function equal(left: unknown, right: unknown, tolerance: number): boolean {
          if (typeof left === 'number' && typeof right === 'number') {
            // Folding an event stream and accumulating a read model apply operations in a different order, so the last floating-point digits always differ.
            // With === the reconciliation reports a pile of 0.0000001 differences every day, and people stop reading it
            return Math.abs(left - right) <= tolerance;
          }
          return left === right;
        }

        export function reconcile(
          expected: Record<string, unknown>,
          actual: Record<string, unknown>,
          options?: ReconcileOptions
        ): Discrepancy[] {
          const tolerance = options?.tolerance ?? 0;
          // Both sides' keys have to be walked: going through expected alone never finds a record that
          // appeared in the read model out of nowhere, and that is the most serious kind of difference there is
          const keys = new Set<string>([...Object.keys(expected), ...Object.keys(actual)]);

          const found: Discrepancy[] = [];
          for (const key of Array.from(keys)) {
            const inExpected = has(expected, key);
            const inActual = has(actual, key);

            if (inExpected && !inActual) {
              found.push({ key, kind: 'missing', expected: expected[key], actual: undefined });
            } else if (!inExpected && inActual) {
              found.push({ key, kind: 'extra', expected: undefined, actual: actual[key] });
            } else if (!equal(expected[key], actual[key], tolerance)) {
              found.push({ key, kind: 'mismatch', expected: expected[key], actual: actual[key] });
            }
          }

          // Sorting makes each run's output directly diffable, so you can see which differences are new today
          return found.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '**`has` 这个三行的函数是整关最重要的地方。** 把它写成 `Boolean(source[key])`，',
      '所有金额为 0、状态为空串、标志为 false 的记录都会被报成 missing——',
      '而一个天天误报的对账工具，三天之后就没人看了。',
      '「存在」和「有值」是两件事，在对账这种场景下必须分清。',
      '',
      '**遍历的是两边键的并集。** 只走 `expected` 是最自然的写法，',
      '也会让 `extra` 这一类永远发现不了。而 extra 往往是最严重的：',
      '读模型里有一条没有事件依据的数据，意味着要么重复消费了，',
      '要么有别的东西绕过事件流直接写了进来。',
      '',
      '**容差只对「两边都是数字」生效。** 用 `Math.abs` 去比较字符串会得到 NaN，',
      '而 `NaN <= tolerance` 永远是 false——看起来能用，实际上把所有字符串',
      '差异都判成了不相等，恰好和期望一致，于是这个 bug 永远不会暴露。',
      '显式判断类型比依赖巧合安全。',
      '',
      '**这个函数只报告，不修复。** 它没有任何写操作。对账工具无法判断差异的',
      '原因——可能是读模型错了，也可能是事件流本身有脏数据。',
      '自动按事件流覆盖读模型，会把「一边错」变成「两边都错」。',
    ].join('\n'),
    [
      'The three-line `has` function is the most important thing in this stage. Written as',
      '`Boolean(source[key])`, every record with an amount of 0, an empty status or a false flag is',
      'reported missing — and a tool that produces false alarms daily goes unread within three days.',
      'Existence and truthiness are different things, and reconciliation is where that distinction matters.',
      '',
      'The iteration walks the union of both key sets. Walking only `expected` is the natural thing to',
      'write and makes the `extra` kind undiscoverable — and `extra` is often the most serious, meaning the',
      'read model holds a record with no event to justify it, from a duplicate consumption or from',
      'something writing directly and bypassing the stream.',
      '',
      'Tolerance applies only when both sides are numbers. Using `Math.abs` on strings yields NaN, and',
      '`NaN <= tolerance` is always false — which appears to work, since it declares all string differences',
      'unequal exactly as intended, so the bug never surfaces. Checking the type explicitly is safer than',
      'relying on that coincidence.',
      '',
      'The function reports and never repairs; it performs no writes at all. A reconciliation tool cannot',
      'determine the cause of a difference — the read model may be wrong, or the event stream may hold bad',
      'data — and overwriting the read model from the stream converts "one side is wrong" into "both are".',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

module.exports = {
  id: 'order-event-pipeline',
  title: t('事件驱动的订单流水线', 'Event-driven order pipeline'),
  summary: t(
    '十一关做完一条事件驱动的订单链路：模式演进、分区有序、消费者组、outbox、幂等、Saga、事件溯源、读模型投影与端到端对账。',
    'Eleven stages of an event-driven order pipeline: schema evolution, partitioned ordering, consumer groups, the outbox, idempotency, sagas, event sourcing, projections and reconciliation.'
  ),
  difficulty: 'Medium',
  domain: 'architecture',
  tags: ['event-driven', 'middleware', 'idempotency', 'api-design'],
  estimatedMinutes: 420,
  language: 'typescript',
  weights: {
    correctness: 3,
    concurrency: 0.5,
    latency: 1,
    resilience: 2,
    encapsulation: 2.5,
    elegance: 2,
  },
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
      '十一关重构出一套事件驱动的处理骨架：',
      '',
      '| 关卡 | 解决的问题 |',
      '| --- | --- |',
      '| 1 模式演进 | 事件结构变了，旧事件还读得懂 |',
      '| 2 事件总线 | 副作用与主流程解耦，互不依赖的下游并行执行 |',
      '| 3 分区与顺序 | 同一订单严格有序，不同订单完全并行 |',
      '| 4 洋葱中间件 | 横切关注点变成可组合的层，而不是复制粘贴 |',
      '| 5 消费者组 | 分区唯一归属，再平衡尽量少移动 |',
      '| 6 事务性 outbox | 业务写入和事件发出不再是两件事 |',
      '| 7 幂等与死信 | 重复投递不产生重复副作用，毒消息不阻塞队列 |',
      '| 8 Saga | 跨服务失败时逆序补偿，不留中间态 |',
      '| 9 事件溯源 | 事件成为真相，快照让重放代价可控 |',
      '| 10 读模型投影 | 查询走派生模型，可续、可重放、可重建 |',
      '| 11 端到端对账 | 承认上面十关加起来仍然会错，并把错找出来 |',
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
      'Refactor into an event-driven skeleton across eleven stages:',
      '',
      '| Stage | Problem solved |',
      '| --- | --- |',
      '| 1 Schema evolution | The shape changed and old events are still readable |',
      '| 2 Event bus | Side effects decoupled from the main flow, independent consumers run in parallel |',
      '| 3 Partitioning | One order strictly ordered, different orders fully parallel |',
      '| 4 Onion middleware | Cross-cutting concerns become composable layers instead of copy-paste |',
      '| 5 Consumer groups | Exactly one owner per partition, minimal movement on rebalance |',
      '| 6 Transactional outbox | Writing data and emitting an event stop being two things |',
      '| 7 Idempotency and DLQ | Duplicate delivery causes one side effect; poison messages do not block the queue |',
      '| 8 Sagas | Cross-service failure compensates in reverse, leaving no partial state |',
      '| 9 Event sourcing | Events become the truth, snapshots keep replay affordable |',
      '| 10 Projections | Queries read a derived model that resumes, replays and rebuilds |',
      '| 11 Reconciliation | Accept that all ten above still get it wrong, and find where |',
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
  stages: [stage1, stage2, stage3, stage4, stage5, stage6, stage7, stage8, stage9, stage10, stage11],
};
