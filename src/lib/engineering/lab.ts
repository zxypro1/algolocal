/**
 * Lab：工程实战的模拟运行环境
 *
 * 用户代码通过虚拟模块访问「外部世界」：
 *   import { request } from '@lab/net';   // 一个会计量并发/延迟/失败的下游服务
 *   import { sleep, now } from '@lab/env'; // 虚拟时钟
 *   import { count } from '@lab/metrics';  // 自定义埋点
 *
 * 所有请求都跑在虚拟时钟上，因此「串行 10 次 200ms 请求 = 2000ms，
 * 并发 5 路 = 400ms」这样的差异可以被精确、可复现地度量出来。
 */
import { VirtualClock } from './clock';
import type {
  ConsoleEntry,
  LabEndpointConfig,
  LabMetrics,
  LabNetworkConfig,
  RequestSample,
} from './types';

export class LabHttpError extends Error {
  status: number;
  url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'LabHttpError';
    this.status = status;
    this.url = url;
  }
}

/** 可复现的伪随机数发生器 */
function createRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_TIMELINE_POINTS = 400;
const MAX_SAMPLES = 200;

interface UrlState {
  calls: number;
  lastFailed: boolean;
}

export class Lab {
  clock = new VirtualClock();
  console: ConsoleEntry[] = [];

  private config: LabNetworkConfig = {};
  private rng = createRng(1);
  private inFlight = 0;
  private maxConcurrency = 0;
  private timeline: Array<{ t: number; inFlight: number }> = [];
  private samples: RequestSample[] = [];
  private urlState = new Map<string, UrlState>();
  private counters: Record<string, number> = {};
  private totals = { total: 0, ok: 0, failed: 0, throttled: 0, retries: 0, duplicated: 0 };

  constructor(config: LabNetworkConfig = {}) {
    this.configure(config);
  }

  configure(config: LabNetworkConfig): void {
    this.config = { ...this.config, ...config };
    this.rng = createRng(this.config.seed ?? 1);
  }

  /** 每个用例开始前调用：换一块干净的时间轴和计量器 */
  reset(config?: LabNetworkConfig): void {
    if (config) this.config = { ...config };
    this.clock = new VirtualClock();
    this.rng = createRng(this.config.seed ?? 1);
    this.console = [];
    this.inFlight = 0;
    this.maxConcurrency = 0;
    this.timeline = [];
    this.samples = [];
    this.urlState = new Map();
    this.counters = {};
    this.totals = { total: 0, ok: 0, failed: 0, throttled: 0, retries: 0, duplicated: 0 };
  }

  snapshot(): LabMetrics {
    return {
      virtualElapsedMs: this.clock.now(),
      maxConcurrency: this.maxConcurrency,
      concurrencyTimeline: [...this.timeline],
      requests: {
        ...this.totals,
        byUrl: Object.fromEntries(
          Array.from(this.urlState.entries()).map(([url, state]) => [url, state.calls])
        ),
      },
      samples: [...this.samples],
      counters: { ...this.counters },
    };
  }

  private endpointConfig(url: string): LabEndpointConfig {
    const endpoints = this.config.endpoints || {};
    if (endpoints[url]) return endpoints[url];
    // 支持前缀匹配，方便配置 '/api/items/' 这样的一族地址
    const prefixKey = Object.keys(endpoints)
      .filter((key) => key.endsWith('*'))
      .find((key) => url.startsWith(key.slice(0, -1)));
    return prefixKey ? endpoints[prefixKey] : {};
  }

  private track(): void {
    if (this.timeline.length < MAX_TIMELINE_POINTS) {
      this.timeline.push({ t: this.clock.now(), inFlight: this.inFlight });
    }
  }

  async request(url: string, options: { method?: string; body?: unknown } = {}): Promise<{
    status: number;
    data: unknown;
    url: string;
  }> {
    if (typeof url !== 'string' || !url) {
      throw new TypeError('request(url) expects a non-empty url string');
    }

    const endpoint = this.endpointConfig(url);
    const state = this.urlState.get(url) || { calls: 0, lastFailed: false };
    state.calls += 1;
    if (state.calls > 1) {
      if (state.lastFailed) this.totals.retries += 1;
      else this.totals.duplicated += 1;
    }
    this.urlState.set(url, state);

    this.totals.total += 1;
    this.inFlight += 1;
    this.maxConcurrency = Math.max(this.maxConcurrency, this.inFlight);
    this.track();

    const startedAt = this.clock.now();
    const attempt = state.calls;
    const limit = this.config.serverConcurrencyLimit;

    const finish = (sample: RequestSample) => {
      this.inFlight -= 1;
      this.track();
      if (this.samples.length < MAX_SAMPLES) this.samples.push(sample);
    };

    // 服务端限流：超出并发上限直接 429，逼出客户端的并发控制
    if (typeof limit === 'number' && this.inFlight > limit) {
      await this.clock.sleep(1);
      this.totals.throttled += 1;
      this.totals.failed += 1;
      state.lastFailed = true;
      finish({
        url,
        startedAt,
        endedAt: this.clock.now(),
        ok: false,
        attempt,
        status: 429,
        error: 'Too Many Requests',
      });
      throw new LabHttpError(`429 Too Many Requests: ${url}`, 429, url);
    }

    const latency = endpoint.latencyMs ?? this.config.defaultLatencyMs ?? 100;
    await this.clock.sleep(latency);

    const forcedFailure = typeof endpoint.failFirstN === 'number' && attempt <= endpoint.failFirstN;
    const randomFailure = !forcedFailure && (this.config.failureRate ?? 0) > 0
      ? this.rng() < (this.config.failureRate ?? 0)
      : false;

    if (forcedFailure || randomFailure) {
      const status = endpoint.status ?? 500;
      this.totals.failed += 1;
      state.lastFailed = true;
      finish({
        url,
        startedAt,
        endedAt: this.clock.now(),
        ok: false,
        attempt,
        status,
        error: `Upstream failure (${status})`,
      });
      throw new LabHttpError(`${status} Upstream failure: ${url}`, status, url);
    }

    this.totals.ok += 1;
    state.lastFailed = false;
    finish({ url, startedAt, endedAt: this.clock.now(), ok: true, attempt, status: 200 });

    return {
      // endpoint.status 描述的是**失败**时返回什么，成功永远是 200。
      // 否则 { failFirstN: 2, status: 503 } 这种配置会让恢复后的成功响应也带着 503。
      status: 200,
      url,
      data: endpoint.payload !== undefined ? endpoint.payload : { url, attempt, at: startedAt },
    };
  }

  /** 可复现的随机数，用户代码通过 @lab/env 拿到 */
  random(): number {
    return this.rng();
  }

  count(name: string, delta = 1): void {
    this.counters[name] = (this.counters[name] || 0) + delta;
  }

  log(level: ConsoleEntry['level'], args: unknown[]): void {
    if (this.console.length >= 500) return;
    const text = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
    this.console.push({ level, text, at: this.clock.now() });
  }
}

/**
 * 构造注入到用户模块里的虚拟模块与全局对象。
 * 所有函数都是稳定引用（内部委托到 lab 的当前时钟），
 * 因此每个用例 reset 时不会让用户模块里缓存的引用失效。
 */
export function createLabModules(lab: Lab): Record<string, unknown> {
  const env = {
    sleep: (ms: number) => lab.clock.sleep(ms),
    now: () => lab.clock.now(),
    random: () => lab.random(),
  };

  /**
   * 注意这里**不**暴露 configure 和 reset。
   *
   * 它们是平台侧的能力，只应由 runner 在每个用例之前调用：
   *  - configure 能把失败率、并发上限这些参数改掉，而工程门槛量的正是这些指标，
   *    一句 `configure({ failureRate: 0 })` 就能让容错门槛通过而不写任何逻辑；
   *  - reset 会换掉 lab.clock，而驱动器驱动的还是旧那个，之后所有 sleep 都排到
   *    一个没人推进的时钟上，用例挂死并被误报成死锁。
   */
  const net = {
    request: (url: string, options?: { method?: string; body?: unknown }) => lab.request(url, options),
    LabHttpError,
    getMetrics: () => lab.snapshot(),
  };

  const metrics = {
    count: (name: string, delta?: number) => lab.count(name, delta),
    getMetrics: () => lab.snapshot(),
    getCounters: () => lab.snapshot().counters,
  };

  return {
    '@lab/env': env,
    '@lab/net': net,
    '@lab/metrics': metrics,
  };
}

/** 沙箱内的全局对象：定时器 / console / Date 全部走虚拟时钟 */
export function createLabGlobals(lab: Lab): Record<string, unknown> {
  const setTimeoutShim = (fn: (...args: any[]) => void, ms?: number, ...args: any[]) =>
    lab.clock.schedule(fn, ms ?? 0, args);
  const setIntervalShim = (fn: (...args: any[]) => void, ms?: number, ...args: any[]) =>
    lab.clock.schedule(fn, ms ?? 0, args, Math.max(1, ms ?? 1));
  const clearShim = (id: number) => lab.clock.clear(id);

  const VirtualDate = new Proxy(Date, {
    get(target, prop, receiver) {
      if (prop === 'now') return () => lab.clock.now();
      return Reflect.get(target, prop, receiver);
    },
    construct(target, args) {
      if (args.length === 0) return new target(lab.clock.now());
      return new (target as any)(...args);
    },
  });

  return {
    setTimeout: setTimeoutShim,
    setInterval: setIntervalShim,
    clearTimeout: clearShim,
    clearInterval: clearShim,
    queueMicrotask: (fn: () => void) => Promise.resolve().then(fn),
    Date: VirtualDate,
    performance: { now: () => lab.clock.now() },
    console: {
      log: (...args: unknown[]) => lab.log('log', args),
      info: (...args: unknown[]) => lab.log('log', args),
      warn: (...args: unknown[]) => lab.log('warn', args),
      error: (...args: unknown[]) => lab.log('error', args),
      debug: (...args: unknown[]) => lab.log('log', args),
    },
  };
}
