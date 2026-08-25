/**
 * etcd 语义的键值存储
 *
 * apiserver 的每一条对外行为都建立在 etcd 的这几条语义上，所以这一层要先做对：
 *
 *  - **单调 revision**：每次写让全局 revision +1，对象记下自己是在哪一版被改的。
 *    apiserver 的 `resourceVersion` 就是它，乐观并发（409 Conflict）也靠它。
 *  - **watch from revision**：从某一版开始订阅，先补齐这之后发生过的事件再接着推。
 *    「informer 先 list 再 watch，中间不能漏事件」全靠这个。
 *  - **CAS 事务**：比较再写，是 apiserver 实现「改的是我读到的那一版」的底座。
 *  - **compaction**：历史不能无限留。压缩之后从太老的 revision 起 watch 要明确报错
 *    （对应 k8s 的 `too old resource version`），而不是悄悄少给几个事件。
 *
 * 键的形状照抄 k8s：`/registry/<resource>/<namespace>/<name>`。
 */

export type EventType = 'PUT' | 'DELETE';

export interface KeyValue {
  key: string;
  /** 存的是解析好的对象，不是字节 —— 我们不需要真的编解码 */
  value: unknown;
  /** 这个键被创建时的 revision */
  createRevision: number;
  /** 这个键最后一次被修改时的 revision */
  modRevision: number;
  /** 从创建以来被改过多少次，第一次写是 1 */
  version: number;
}

export interface WatchEvent {
  type: EventType;
  kv: KeyValue;
  /** DELETE 时带上被删掉之前的那一版，控制器要靠它知道删的是什么 */
  prevKv?: KeyValue;
}

export interface RangeOptions {
  /** 前缀匹配；不传就是精确取一个键 */
  prefix?: boolean;
  /** 从这个键之后开始（分页用），不含它本身 */
  startAfter?: string;
  limit?: number;
  /** 读某个历史版本；不传读最新 */
  revision?: number;
}

export interface RangeResult {
  kvs: KeyValue[];
  /** 这次读对应的 revision，informer 拿它作为 watch 的起点 */
  revision: number;
  /** 还有更多没返回（被 limit 截断了） */
  more: boolean;
  /** 满足条件的总数 */
  count: number;
}

/** 事务里的比较条件 */
export type Compare =
  | { key: string; target: 'MOD_REVISION'; op: '=' | '!=' | '<' | '>'; value: number }
  | { key: string; target: 'CREATE_REVISION'; op: '=' | '!='; value: number }
  | { key: string; target: 'VERSION'; op: '=' | '!='; value: number }
  | { key: string; target: 'EXISTS'; value: boolean };

export type TxnOp =
  | { type: 'put'; key: string; value: unknown }
  | { type: 'delete'; key: string }
  | { type: 'get'; key: string; options?: RangeOptions };

export interface TxnResult {
  succeeded: boolean;
  revision: number;
  /** 与执行的那一支 ops 一一对应；put/delete 返回受影响的 kv，get 返回 RangeResult */
  results: Array<KeyValue | RangeResult | null>;
}

export class CompactedError extends Error {
  requiredRevision: number;
  compactRevision: number;
  constructor(requiredRevision: number, compactRevision: number) {
    super(
      `required revision ${requiredRevision} has been compacted, ` +
        `the earliest available revision is ${compactRevision}`
    );
    this.name = 'CompactedError';
    this.requiredRevision = requiredRevision;
    this.compactRevision = compactRevision;
  }
}

export class FutureRevisionError extends Error {
  constructor(requested: number, current: number) {
    super(`required revision ${requested} is greater than the current revision ${current}`);
    this.name = 'FutureRevisionError';
  }
}

export interface WatchOptions {
  /** 从哪一版之后开始收事件；不传就是「只收将来的」 */
  startRevision?: number;
  prefix?: boolean;
}

export interface Watcher {
  cancel(): void;
}

interface HistoryEntry {
  revision: number;
  events: WatchEvent[];
}

interface WatcherRecord {
  id: number;
  key: string;
  prefix: boolean;
  onEvent: (event: WatchEvent) => void;
  cancelled: boolean;
}

export interface StoreSnapshot {
  revision: number;
  compactRevision: number;
  kvs: KeyValue[];
}

/** 深拷贝。存进来和读出去都要拷，免得调用方手上的引用把库里的对象改了。 */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export class Store {
  private data = new Map<string, KeyValue>();
  private revisionCounter = 0;
  private compactRevision = 0;
  /** 事件历史，供 watch 补齐与历史读用。compaction 会砍掉前面的部分。 */
  private history: HistoryEntry[] = [];
  /**
   * compactRevision 那一刻的完整状态。
   *
   * 历史读是「从某个已知状态往后重放事件」。压缩把前面的历史丢掉之后，
   * 光靠剩下的事件重放不出完整世界 —— 压缩点之前创建、之后没再动过的对象会凭空消失。
   * 所以压缩时把那一刻的状态物化下来当底座。恢复快照同理：底座就是快照本身。
   */
  private baseState = new Map<string, KeyValue>();
  private watchers = new Map<number, WatcherRecord>();
  private watcherSeq = 0;
  /** 历史最多留多少个 revision，超了自动压缩 —— 一场长会话不能无限吃内存 */
  private readonly maxHistory: number;

  constructor(options: { maxHistory?: number } = {}) {
    this.maxHistory = options.maxHistory ?? 5000;
  }

  get revision(): number {
    return this.revisionCounter;
  }

  get compactedAt(): number {
    return this.compactRevision;
  }

  /* ---------------- 读 ---------------- */

  /**
   * 读一个键或一段前缀。
   *
   * 结果按键名排序 —— 顺序稳定是确定性的前提，别依赖 Map 的插入序。
   */
  range(key: string, options: RangeOptions = {}): RangeResult {
    if (options.revision !== undefined) {
      return this.rangeAtRevision(key, options, options.revision);
    }

    let kvs = [...this.data.values()]
      .filter((kv) => (options.prefix ? kv.key.startsWith(key) : kv.key === key))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    if (options.startAfter) {
      kvs = kvs.filter((kv) => kv.key > options.startAfter!);
    }
    const count = kvs.length;
    let more = false;
    if (options.limit !== undefined && options.limit > 0 && kvs.length > options.limit) {
      kvs = kvs.slice(0, options.limit);
      more = true;
    }
    return { kvs: kvs.map(clone), revision: this.revisionCounter, more, count };
  }

  /**
   * 读某个历史版本。
   *
   * 从当前状态往回放历史事件复原 —— 数据量小，不值得为它维护多版本索引。
   */
  private rangeAtRevision(key: string, options: RangeOptions, revision: number): RangeResult {
    this.assertRevisionAvailable(revision);

    const state = this.materializeAt(revision);

    let kvs = [...state.values()]
      .filter((kv) => (options.prefix ? kv.key.startsWith(key) : kv.key === key))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (options.startAfter) kvs = kvs.filter((kv) => kv.key > options.startAfter!);

    const count = kvs.length;
    let more = false;
    if (options.limit !== undefined && options.limit > 0 && kvs.length > options.limit) {
      kvs = kvs.slice(0, options.limit);
      more = true;
    }
    return { kvs: kvs.map(clone), revision, more, count };
  }

  /** 从底座出发重放到 revision 为止，得到那一刻的完整状态 */
  private materializeAt(revision: number): Map<string, KeyValue> {
    const state = new Map(this.baseState);
    for (const entry of this.history) {
      if (entry.revision > revision) break;
      for (const event of entry.events) {
        if (event.type === 'PUT') state.set(event.kv.key, event.kv);
        else state.delete(event.kv.key);
      }
    }
    return state;
  }

  get(key: string): KeyValue | undefined {
    const kv = this.data.get(key);
    return kv ? clone(kv) : undefined;
  }

  /* ---------------- 写 ---------------- */

  put(key: string, value: unknown): KeyValue {
    const revision = ++this.revisionCounter;
    const existing = this.data.get(key);
    const kv: KeyValue = {
      key,
      value: clone(value),
      createRevision: existing ? existing.createRevision : revision,
      modRevision: revision,
      version: existing ? existing.version + 1 : 1,
    };
    this.data.set(key, kv);
    this.commit(revision, [{ type: 'PUT', kv: clone(kv), prevKv: existing ? clone(existing) : undefined }]);
    return clone(kv);
  }

  delete(key: string): KeyValue | undefined {
    const existing = this.data.get(key);
    if (!existing) return undefined;
    const revision = ++this.revisionCounter;
    this.data.delete(key);
    this.commit(revision, [{ type: 'DELETE', kv: { ...clone(existing), modRevision: revision }, prevKv: clone(existing) }]);
    return clone(existing);
  }

  /** 删掉一整段前缀，返回删了几个。整段算一个 revision。 */
  deletePrefix(prefix: string): number {
    const victims = [...this.data.values()]
      .filter((kv) => kv.key.startsWith(prefix))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    if (victims.length === 0) return 0;

    const revision = ++this.revisionCounter;
    const events: WatchEvent[] = [];
    for (const kv of victims) {
      this.data.delete(kv.key);
      events.push({ type: 'DELETE', kv: { ...clone(kv), modRevision: revision }, prevKv: clone(kv) });
    }
    this.commit(revision, events);
    return victims.length;
  }

  /**
   * 事务：先比较，全部成立走 onSuccess，否则走 onFailure。
   *
   * apiserver 的乐观并发就架在这上面：读到 modRevision=N 的对象，
   * 写回时要求它仍然是 N，不是就 409。
   */
  txn(compares: Compare[], onSuccess: TxnOp[], onFailure: TxnOp[] = []): TxnResult {
    const succeeded = compares.every((compare) => this.evaluate(compare));
    const ops = succeeded ? onSuccess : onFailure;

    // 整个事务是一个 revision：一次 apply 里改了几样东西，watch 应当看到它们同时发生
    const writes = ops.filter((op) => op.type !== 'get');
    const revision = writes.length > 0 ? ++this.revisionCounter : this.revisionCounter;
    const events: WatchEvent[] = [];
    const results: Array<KeyValue | RangeResult | null> = [];

    for (const op of ops) {
      if (op.type === 'get') {
        results.push(this.range(op.key, op.options));
        continue;
      }
      if (op.type === 'put') {
        const existing = this.data.get(op.key);
        const kv: KeyValue = {
          key: op.key,
          value: clone(op.value),
          createRevision: existing ? existing.createRevision : revision,
          modRevision: revision,
          version: existing ? existing.version + 1 : 1,
        };
        this.data.set(op.key, kv);
        events.push({ type: 'PUT', kv: clone(kv), prevKv: existing ? clone(existing) : undefined });
        results.push(clone(kv));
        continue;
      }
      const existing = this.data.get(op.key);
      if (!existing) { results.push(null); continue; }
      this.data.delete(op.key);
      events.push({ type: 'DELETE', kv: { ...clone(existing), modRevision: revision }, prevKv: clone(existing) });
      results.push(clone(existing));
    }

    if (events.length > 0) this.commit(revision, events);
    return { succeeded, revision, results };
  }

  private evaluate(compare: Compare): boolean {
    const kv = this.data.get(compare.key);
    if (compare.target === 'EXISTS') return (kv !== undefined) === compare.value;
    if (!kv) return false;
    const actual =
      compare.target === 'MOD_REVISION' ? kv.modRevision
      : compare.target === 'CREATE_REVISION' ? kv.createRevision
      : kv.version;
    switch (compare.op) {
      case '=': return actual === compare.value;
      case '!=': return actual !== compare.value;
      case '<': return actual < compare.value;
      case '>': return actual > compare.value;
      default: return false;
    }
  }

  /* ---------------- watch ---------------- */

  /**
   * 订阅变更。
   *
   * 传了 startRevision 就先把这之后已经发生过的事件补齐再接着推 ——
   * informer「先 list 拿到 revision，再从那一版 watch」这条路径不能漏事件，
   * 否则控制器会基于过时的世界做决定。
   */
  watch(key: string, options: WatchOptions = {}, onEvent: (event: WatchEvent) => void): Watcher {
    const id = ++this.watcherSeq;
    const record: WatcherRecord = {
      id,
      key,
      prefix: options.prefix === true,
      onEvent,
      cancelled: false,
    };

    if (options.startRevision !== undefined) {
      this.assertRevisionAvailable(options.startRevision);
      for (const entry of this.history) {
        if (entry.revision <= options.startRevision) continue;
        for (const event of entry.events) {
          if (!this.matches(record, event.kv.key)) continue;
          record.onEvent(clone(event));
        }
      }
    }

    this.watchers.set(id, record);
    return {
      cancel: () => {
        record.cancelled = true;
        this.watchers.delete(id);
      },
    };
  }

  private matches(record: WatcherRecord, key: string): boolean {
    return record.prefix ? key.startsWith(record.key) : key === record.key;
  }

  /**
   * 落一次变更：记历史、通知订阅者。
   *
   * 订阅者按注册顺序通知（Map 的插入序是稳定的），这是确定性的一部分。
   * 通知期间新注册的订阅者不会收到这一批 —— 遍历的是快照，
   * 否则「在回调里 watch」会拿到半截事件流。
   */
  private commit(revision: number, events: WatchEvent[]): void {
    this.history.push({ revision, events: events.map(clone) });
    this.trimHistory();

    for (const record of [...this.watchers.values()]) {
      if (record.cancelled) continue;
      for (const event of events) {
        if (!this.matches(record, event.kv.key)) continue;
        record.onEvent(clone(event));
      }
    }
  }

  /* ---------------- compaction ---------------- */

  /**
   * 砍掉 revision 之前的历史。之后从更早的版本 watch 会明确报 CompactedError。
   *
   * 丢历史之前先把那一刻的状态物化成新底座，否则历史读会漏掉
   * 「压缩点之前创建、之后没再动过」的对象。
   */
  compact(revision: number): void {
    if (revision <= this.compactRevision) return;
    const target = Math.min(revision, this.revisionCounter);
    this.baseState = this.materializeAt(target);
    this.compactRevision = target;
    this.history = this.history.filter((entry) => entry.revision > this.compactRevision);
  }

  private trimHistory(): void {
    if (this.history.length <= this.maxHistory) return;
    const dropTo = this.history[this.history.length - this.maxHistory].revision - 1;
    this.compact(dropTo);
  }

  private assertRevisionAvailable(revision: number): void {
    if (revision > this.revisionCounter) {
      throw new FutureRevisionError(revision, this.revisionCounter);
    }
    // 压缩点本身还能用作起点：它之后的事件都还在
    if (revision < this.compactRevision) {
      throw new CompactedError(revision, this.compactRevision);
    }
  }

  /* ---------------- 快照 ---------------- */

  /**
   * 快照。
   *
   * 只存当前状态与 revision，**不存历史** —— 历史是给 watch 补事件用的，
   * 恢复之后所有 informer 都要重新 list + watch，补不补得上旧事件没有意义。
   * 恢复后 compactRevision 抬到当前 revision，从更早的版本 watch 会正确报错。
   */
  snapshot(): StoreSnapshot {
    return {
      revision: this.revisionCounter,
      compactRevision: this.compactRevision,
      kvs: [...this.data.values()]
        .sort((a, b) => (a.key < b.key ? -1 : 1))
        .map(clone),
    };
  }

  restore(snapshot: StoreSnapshot): void {
    this.data = new Map(snapshot.kvs.map((kv) => [kv.key, clone(kv)]));
    this.revisionCounter = snapshot.revision;
    // 快照里没有历史，所以恢复之后的压缩点就是快照那一版；
    // 底座是快照本身，这样「读当前 revision」才能读到东西。
    this.compactRevision = Math.max(snapshot.compactRevision, snapshot.revision);
    this.baseState = new Map(snapshot.kvs.map((kv) => [kv.key, clone(kv)]));
    this.history = [];
    for (const record of this.watchers.values()) record.cancelled = true;
    this.watchers = new Map();
  }
}

export function createStore(options?: { maxHistory?: number }): Store {
  return new Store(options);
}
