/**
 * 控制器框架：informer + workqueue
 *
 * 照抄真 k8s 的形状，因为控制器的行为特征就是从这个形状里长出来的：
 *
 *  - **informer 先 list 再 watch**：拿到 list 的 resourceVersion，从那一版起 watch，
 *    中间不漏事件。收到 410 Gone（版本被压缩了）就丢掉缓存重新 list。
 *  - **workqueue 按 key 去重**：同一个对象在一次 reconcile 期间被改了五次，
 *    只会再排一次队，而不是五次。这是控制器不被写放大压垮的原因。
 *  - **失败按指数退避重排**：一个 reconcile 失败不会卡住整条队列，
 *    也不会立刻疯狂重试。
 *  - **定期重扫（resync）**：level-triggered 的兜底。哪怕漏了事件，
 *    下一轮重扫也会把世界拉回期望状态 —— 这也是快照恢复之后
 *    只要重新起控制器就能收敛的原因。
 */
import { Kernel, Priority } from '../kernel';
import { ApiError, KubeObject, Registry, ResourceDefinition } from '../apiserver';

/** 对象在队列里的身份：`namespace/name`，集群级资源就是 `name` */
export function objectKey(object: KubeObject): string {
  return object.metadata.namespace
    ? `${object.metadata.namespace}/${object.metadata.name}`
    : object.metadata.name;
}

export function splitKey(key: string): { namespace?: string; name: string } {
  const index = key.indexOf('/');
  if (index < 0) return { name: key };
  return { namespace: key.slice(0, index), name: key.slice(index + 1) };
}

/**
 * 本地缓存 + 事件订阅。
 *
 * 控制器读缓存而不是每次都打 apiserver —— 真 k8s 也是这样，
 * 于是「控制器看到的世界可能比实际落后一点」这个特性被保留下来了，
 * 而这正是很多竞态的来源，值得让学员感受到。
 */
export class Informer {
  private cache = new Map<string, KubeObject>();
  private handlers: Array<(key: string, object: KubeObject | undefined) => void> = [];
  private watcher: { cancel: () => void } | null = null;
  private started = false;

  constructor(
    private readonly registry: Registry,
    private readonly definition: ResourceDefinition,
    private readonly options: { namespace?: string; labelSelector?: string } = {}
  ) {}

  /**
   * 对象变化的回调。
   *
   * object 是**最后一次已知状态** —— 删除时缓存里已经没有它了，但处理器多半
   * 正需要它（ReplicaSet 控制器要靠 ownerReferences 才知道该 reconcile 谁）。
   * 不给的话删掉一个 Pod，属主根本不会被通知，副本补不回来。
   */
  onChange(handler: (key: string, object: KubeObject | undefined) => void): void {
    this.handlers.push(handler);
  }

  /** 先 list 建立缓存，再从那一版起 watch */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.resync();
  }

  /**
   * 重新 list 并接上 watch。
   *
   * 缓存被清空重建，所以所有对象都会被重新入队一次 ——
   * level-triggered 的控制器对此免疫（reconcile 是幂等的）。
   */
  resync(): void {
    this.watcher?.cancel();
    const list = this.registry.list(this.definition, {
      namespace: this.options.namespace,
      labelSelector: this.options.labelSelector,
    });

    this.cache = new Map(list.items.map((item) => [objectKey(item), item]));
    for (const [key, object] of this.cache) this.notify(key, object);

    this.watcher = this.registry.watch(
      this.definition,
      {
        namespace: this.options.namespace,
        labelSelector: this.options.labelSelector,
        resourceVersion: list.metadata.resourceVersion,
      },
      (event) => {
        const key = objectKey(event.object);
        if (event.type === 'DELETED') this.cache.delete(key);
        else this.cache.set(key, event.object);
        this.notify(key, event.object);
      }
    );
  }

  private notify(key: string, object: KubeObject | undefined): void {
    for (const handler of this.handlers) handler(key, object);
  }

  get(key: string): KubeObject | undefined {
    return this.cache.get(key);
  }

  /** 缓存里的全部对象，按 key 稳定排序 */
  list(): KubeObject[] {
    return [...this.cache.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, object]) => object);
  }

  stop(): void {
    this.watcher?.cancel();
    this.watcher = null;
    this.started = false;
  }
}

export interface WorkQueueOptions {
  /** 首次重试的退避，之后翻倍 */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** 同一个 key 连续失败多少次之后放弃并上报 */
  maxRetries?: number;
}

/**
 * 去重的工作队列。
 *
 * 「同一个 key 排队期间又来了几次变更，只算一次」这条是控制器的核心特性：
 * 一个 Deployment 被连改十次，控制器只需要 reconcile 到最终状态一次。
 */
export class WorkQueue {
  private queue: string[] = [];
  private queued = new Set<string>();
  private processing = new Set<string>();
  /** 处理期间又被标脏的 key，处理完要再排一次 */
  private dirty = new Set<string>();
  private failures = new Map<string, number>();

  constructor(
    private readonly kernel: Kernel,
    private readonly name: string,
    private readonly options: WorkQueueOptions = {}
  ) {}

  add(key: string): void {
    if (this.processing.has(key)) {
      // 正在处理的对象又变了 —— 处理完再排一次，别丢掉这次变更
      this.dirty.add(key);
      return;
    }
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push(key);
    this.schedulePump();
  }

  /** 延后入队，用于退避重试 */
  addAfter(key: string, delayMs: number): void {
    this.kernel.setTimeout(() => this.add(key), delayMs, {
      priority: Priority.CONTROLLER,
      label: `${this.name}:retry:${key}`,
    });
  }

  get length(): number {
    return this.queue.length;
  }

  private take(): string | undefined {
    const key = this.queue.shift();
    if (key === undefined) return undefined;
    this.queued.delete(key);
    this.processing.add(key);
    return key;
  }

  private done(key: string): void {
    this.processing.delete(key);
    if (this.dirty.delete(key)) this.add(key);
  }

  /** 一次成功的 reconcile：清掉失败计数 */
  private forget(key: string): void {
    this.failures.delete(key);
  }

  /** 一次失败：按指数退避重排 */
  private requeue(key: string): number | null {
    const attempts = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, attempts);
    const maxRetries = this.options.maxRetries ?? 15;
    if (attempts > maxRetries) {
      this.failures.delete(key);
      return null;                                  // 放弃
    }
    const base = this.options.baseBackoffMs ?? 5;
    const max = this.options.maxBackoffMs ?? 1000 * 300;
    return Math.min(base * 2 ** (attempts - 1), max);
  }

  /**
   * 起消费循环。
   *
   * 不能用「spawn 一个 for(;;) 的常驻任务」来做 —— 那样 kernel.liveTasks 永远大于 0，
   * settle() 就再也返回不了（第一版这么写，测试直接挂死）。
   *
   * 正确的形状是：**有活才排一个前台定时器**。队列空了就没有定时器，
   * 世界自然静下来；一有新 key 入队就再排一个。于是「控制器还有活没干完」
   * 恰好等价于「还有前台定时器」，和内核的静止判定天然对齐。
   */
  run(reconcile: (key: string) => Promise<void> | void, onGiveUp?: (key: string, error: unknown) => void): void {
    this.reconciler = reconcile;
    this.onGiveUp = onGiveUp;
    this.schedulePump();
  }

  private reconciler: ((key: string) => Promise<void> | void) | null = null;
  private onGiveUp?: (key: string, error: unknown) => void;
  private pumpScheduled = false;

  private schedulePump(): void {
    if (this.pumpScheduled || !this.reconciler || this.queue.length === 0) return;
    this.pumpScheduled = true;
    this.kernel.setTimeout(
      () => {
        this.pumpScheduled = false;
        // 每一批是一个会结束的任务，liveTasks 只在处理期间大于 0
        this.kernel.spawn(`${this.name}:pump`, async () => {
          await this.pump();
          this.schedulePump();
        });
      },
      0,
      { priority: Priority.CONTROLLER, label: `${this.name}:pump` }
    );
  }

  private async pump(): Promise<void> {
    const reconcile = this.reconciler;
    if (!reconcile) return;
    for (;;) {
      const key = this.take();
      if (key === undefined) break;
      try {
        await reconcile(key);
        this.forget(key);
      } catch (error) {
        const backoff = this.requeue(key);
        if (backoff === null) this.onGiveUp?.(key, error);
        else this.addAfter(key, backoff);
      } finally {
        this.done(key);
      }
    }
  }
}

export interface ControllerContext {
  kernel: Kernel;
  registry: Registry;
  /** 世界的墙钟（起始时刻 + 虚拟流逝），写进对象时间戳用 —— 内核的 now() 是从 0 开始的 */
  now: () => number;
  /** 记一条 Event，学员在 describe 里能看到 */
  recordEvent: (input: {
    object: KubeObject;
    type: 'Normal' | 'Warning';
    reason: string;
    message: string;
  }) => void;
}

/**
 * 控制器的骨架：一个 informer 喂一个 workqueue，队列驱动 reconcile。
 *
 * 子类只要实现 reconcile(key)。「拿不到对象说明它被删了」这类判断留给子类，
 * 因为不同控制器对删除的反应不一样。
 */
export abstract class Controller {
  protected readonly kernel: Kernel;
  protected readonly registry: Registry;
  protected readonly queue: WorkQueue;
  protected readonly context: ControllerContext;
  private informers: Informer[] = [];

  constructor(context: ControllerContext, readonly name: string, options: WorkQueueOptions = {}) {
    this.context = context;
    this.kernel = context.kernel;
    this.registry = context.registry;
    this.queue = new WorkQueue(context.kernel, name, options);
  }

  /**
   * 把一个 informer 接进队列。
   *
   * mapKey 决定「这个对象变了，该 reconcile 谁」——
   * ReplicaSet 控制器 watch Pod，但要 reconcile 的是 Pod 的属主。
   */
  /**
   * 登记一个 informer，让 start()/stop() 管它的生命周期。
   *
   * 只调 informer.onChange 而不登记的话，start() 不会启动它，
   * 它就永远收不到事件 —— 这个坑很安静，专门给个方法避开。
   */
  protected track(informer: Informer): Informer {
    if (!this.informers.includes(informer)) this.informers.push(informer);
    return informer;
  }

  protected watch(informer: Informer, mapKey: (object: KubeObject, key: string) => string | null = (_, key) => key): void {
    informer.onChange((key, object) => {
      // 删除时缓存里已经没有它了，用事件带来的最后一次状态来定位属主
      const known = object ?? informer.get(key);
      const target = known ? mapKey(known, key) : key;
      if (target) this.queue.add(target);
    });
    this.track(informer);
  }

  /**
   * 手动排一个 key。
   *
   * watch 的 mapKey 是一对一的，扇出型的关系（节点变了要重看所有
   * DaemonSet）映不过去，这时候直接排队。
   */
  protected enqueue(key: string): void {
    this.queue.add(key);
  }

  protected abstract reconcile(key: string): Promise<void> | void;

  start(): void {
    this.queue.run(
      (key) => this.reconcile(key),
      (key, error) => {
        // 放弃之前留个痕迹，否则对象会「无声地不收敛」
        // eslint-disable-next-line no-console
        console.warn(`[${this.name}] giving up on ${key}: ${(error as Error)?.message ?? error}`);
      }
    );
    for (const informer of this.informers) informer.start();
  }

  stop(): void {
    for (const informer of this.informers) informer.stop();
  }
}

/** apiserver 返回 404 时，多数控制器的正确反应是「当它已经没了」 */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 404;
}

/** 409 冲突：拿最新的重来一次，不是错误 */
export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === 409;
}
