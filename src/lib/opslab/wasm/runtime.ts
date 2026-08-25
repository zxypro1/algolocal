/**
 * 多合一 CLI 的运行时
 *
 * 一个 wasm 里装着 kubectl 与 helm（见 scripts/build-opslab-wasm.sh），
 * 按 argv[0] 决定这一次当谁跑。这么做不是为了省事：client-go 有 5.5MB(brotli)
 * 的地板，每个 CLI 单独编就各付一次；合在一起之后 kubectl 之上再加 helm
 * 只多了不到 2MB。
 *
 * 这一层负责三件事：
 *  1. 加载与缓存 —— 编译一次，之后每条命令只做实例化（十几毫秒）；
 *  2. 把 Go 的 fs / fetch / process 接到我们的机器与 apiserver 上；
 *  3. 跑完把实例彻底断开 —— 不断的话每条命令泄漏 68MB（见下面那段注释）。
 */
import { Vfs, createVfs } from '../machine/vfs';
import { createGoFs } from './gofs';
import { WebSocketConnection, type StreamServer } from '../net/websocket';
import { CacheEntry, ModuleCache, createIndexedDbCache, remoteSignature } from './cache';

export const CLI_WASM_URL = '/opslab/opslab-cli.wasm';
export const WASM_EXEC_URL = '/opslab/wasm_exec.js';

export type FetchLike = (url: string, init?: unknown) => Promise<Response>;

export interface CliRuntimeOptions {
  /** 从哪里取 wasm。三选一，优先级 module > bytes > url。 */
  url?: string;
  bytes?: Uint8Array;
  module?: WebAssembly.Module;
  /** 传 false 关掉缓存；不传则浏览器里默认用 IndexedDB */
  cache?: ModuleCache | false;
  /** wasm_exec.js 的地址。Node 里请调用方自己先把 globalThis.Go 准备好。 */
  wasmExecUrl?: string;
}

export interface CliRunOptions {
  /** 机器的文件系统。kubectl 读的 kubeconfig、`-f` 的文件都在这棵树上。 */
  vfs: Vfs;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  /** client-go 在 js 上统一走 fetch —— 把它指到内存里的 apiserver */
  fetch: FetchLike;
  /**
   * `kubectl exec` / `port-forward` 要的双向通道。
   *
   * fetch 撑不起 WebSocket，所以这条路单开：Go 那边 dial 出来的 net.Conn
   * 就接在这里。不给就是这次运行不支持 exec，Go 会报「宿主没有提供」。
   */
  dial?: (address: string) => StreamServer | undefined;
  /** 虚拟墙钟 */
  now?: () => number;
}

/** 交给 Go 的那个句柄。字段名是 opslab_dial_js.go 认的那几个。 */
interface DialHandle {
  send(bytes: Uint8Array): void;
  close(): void;
  onData?: (bytes: Uint8Array) => void;
  onClose?: () => void;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class CliRuntime {
  private readonly options: CliRuntimeOptions;
  private modulePromise: Promise<WebAssembly.Module> | null = null;
  private appletsPromise: Promise<string[]> | null = null;
  /**
   * 串行执行。
   *
   * 跑一条命令要把 globalThis 上的 fs / fetch / process 换成这一次的，跑完换回去。
   * 两条命令并发就会互相把对方的全局踩掉，输出串台。终端本身是串行的，但判分
   * 探测那边有别的调用方，所以把这个保证放在这一层，而不是指望调用方守规矩。
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CliRuntimeOptions = {}) {
    this.options = options;
  }

  /** 这个二进制里到底有哪些 CLI —— 问它本人，不要在两边各写一份清单 */
  applets(): Promise<string[]> {
    if (!this.appletsPromise) {
      this.appletsPromise = this.run('opslab-cli', [], {
        // 问清单不碰文件系统，给一棵空树就行
        vfs: createVfs(),
        fetch: async () => new Response('', { status: 404 }),
      }).then((result) => result.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
    }
    return this.appletsPromise;
  }

  run(applet: string, args: string[], options: CliRunOptions): Promise<CliResult> {
    const next = this.queue.then(() => this.runExclusive(applet, args, options));
    // 前一条失败不能卡住后面的
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * 编译一次，复用多次。
   *
   * 编译是最贵的一步（浏览器里几十到几百毫秒），实例化只要十几毫秒 ——
   * 所以每条命令新建实例、共用同一个 Module。
   */
  load(): Promise<WebAssembly.Module> {
    if (!this.modulePromise) this.modulePromise = this.compile();
    return this.modulePromise;
  }

  private async compile(): Promise<WebAssembly.Module> {
    if (this.options.module) return this.options.module;
    if (this.options.bytes) return WebAssembly.compile(this.options.bytes);

    const url = this.options.url ?? CLI_WASM_URL;
    const cache = this.options.cache === false
      ? undefined
      : this.options.cache ?? createIndexedDbCache();

    const signature = await remoteSignature(url);
    const hit: CacheEntry | undefined = cache
      // 拿不到签名多半是离线：这时候有什么就用什么，别为了校验新鲜度把功能弄没
      ? await cache.get(url, signature ?? OFFLINE_SIGNATURE)
      : undefined;
    if (hit?.module) return hit.module;
    if (hit?.bytes) return WebAssembly.compile(hit.bytes);

    /**
     * `cache: 'no-store'` 不是可有可无的。
     *
     * 142MB 的响应超过了浏览器 HTTP 缓存单条记录的上限，Chrome 会在写缓存时
     * 失败并把整个请求判死：`net::ERR_CACHE_WRITE_FAILURE` → fetch 抛
     * `TypeError: Failed to fetch`。我们本来就有自己的 IndexedDB 缓存，
     * 让浏览器别插手。
     */
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`${url} 取不到（${response.status}）—— 先跑 scripts/build-opslab-wasm.sh`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const module = await WebAssembly.compile(bytes);
    if (cache) await cache.put(url, signature ?? OFFLINE_SIGNATURE, module, bytes);
    return module;
  }

  private async runExclusive(applet: string, args: string[], options: CliRunOptions): Promise<CliResult> {
    const decoder = new TextDecoder();
    let stdout = '';
    let stderr = '';

    const cwd = options.cwd ?? '/root';
    const fs = createGoFs({
      vfs: options.vfs,
      cwd,
      stdin: options.stdin,
      now: options.now,
      onStdout: (bytes) => { stdout += decoder.decode(bytes); },
      onStderr: (bytes) => { stderr += decoder.decode(bytes); },
    });

    const [module] = await Promise.all([this.load(), this.ensureGoRuntime()]);

    const env = {
      HOME: '/root',
      KUBECONFIG: '/root/.kube/config',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      ...(options.env ?? {}),
    };

    const host = globalThis as Record<string, unknown>;
    const saved = {
      fs: host.fs, fetch: host.fetch, process: host.process, path: host.path,
      dial: host.__opslabDial,
    };
    const openConnections: WebSocketConnection[] = [];
    // Go 退出之后再 resume 就是 "Go program has already exited"。
    // 收尾时先把这面旗子立起来，排在队里的字节直接丢掉。
    let finished = false;

    host.fs = fs;
    host.path = { resolve: (...parts: string[]) => parts.join('/') };
    host.process = {
      getuid: () => 0, getgid: () => 0, geteuid: () => 0, getegid: () => 0, getgroups: () => [0],
      pid: 1, ppid: 0, umask: () => 0o22, cwd: () => cwd, chdir: () => {},
      env, on: () => {},
    };
    host.fetch = (url: unknown, init: unknown) => options.fetch(String(url), init);
    host.__opslabDial = (address: unknown): DialHandle | null => {
      const server = options.dial?.(String(address));
      if (!server) return null;
      const handle: DialHandle = {
        send: (bytes) => connection.receive(bytes),
        close: () => connection.close(),
      };
      /**
       * 回给 Go 的字节必须晚一拍。
       *
       * `handle.send` 是在 Go 的 Write 里同步调过来的；这时候直接回调
       * `onData`，wasm_exec 会在 Go 还没出栈的时候再 `resume()` 一次 ——
       * Go 的调度器不支持这种重入，整个实例就卡死在那里，连 panic 都没有。
       * 排到微任务里，等 Go 让出控制权再送。
       */
      const defer = (fn: () => void) => {
        queueMicrotask(() => {
          // Go 已经退出的话，队里剩下的字节没人要了 —— 再 resume 一次会抛
          if (finished || (go as { exited?: boolean } | undefined)?.exited) return;
          fn();
        });
      };
      const connection = new WebSocketConnection(
        server,
        (bytes) => defer(() => handle.onData?.(bytes)),
        () => defer(() => handle.onClose?.()),
      );
      openConnections.push(connection);
      return handle;
    };

    const go = new (host.Go as new () => GoInstance)();
    go.argv = [applet, ...args];
    go.env = env;
    let code = 0;
    go.exit = (value: number) => { code = value; };

    try {
      const instance = await WebAssembly.instantiate(module, go.importObject);
      await go.run(instance);
    } catch (error) {
      stderr += String((error as Error)?.message ?? error);
      code = code || 1;
    } finally {
      releaseInstance(go);
      host.fs = saved.fs;
      host.fetch = saved.fetch;
      host.process = saved.process;
      host.path = saved.path;
      host.__opslabDial = saved.dial;
      // Go 正常退出时自己会 Close；异常退出时别把连接留着，
      // 不然下一条命令跑起来还有上一条的会话在往一个已经没人听的口子写
      finished = true;
      for (const connection of openConnections) connection.close();
    }

    return { stdout, stderr, code };
  }

  /** wasm_exec.js 由 Go 发行版提供，构建脚本会把它拷到 public/opslab/ */
  private async ensureGoRuntime(): Promise<void> {
    const host = globalThis as Record<string, unknown>;
    if (host.Go) return;
    if (typeof document === 'undefined') {
      throw new Error('globalThis.Go 未就绪：Node 环境请先自行加载 public/opslab/wasm_exec.js');
    }
    const source = this.options.wasmExecUrl ?? WASM_EXEC_URL;
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = source;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`加载不了 ${source}`));
      document.head.appendChild(script);
    });
  }
}

const OFFLINE_SIGNATURE = 'offline';

interface GoInstance {
  argv: string[];
  env: Record<string, string>;
  exit: (code: number) => void;
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
  _scheduledTimeouts?: Map<number, unknown>;
  _resume?: () => void;
  _inst?: unknown;
  mem?: unknown;
  _values?: unknown;
  _goRefCounts?: unknown;
  _ids?: unknown;
}

/**
 * 把这一次运行的东西彻底断开。
 *
 * 不只是为了避免 wasm_exec 事后 `_resume` 抛「already exited」——
 * 排着的那个 setTimeout 闭包抓着 go，go 抓着实例，实例抓着 68MB 线性内存。
 * 不清的话每跑一条命令泄漏 68MB，一百多条之后标签页就被 OOM 掉。
 *
 * 注意 `_scheduledTimeouts` 是 Map，不能用 `Object.values` 取值 —— 那样
 * 拿到的是空数组，看着像清理过了，其实一个都没清。
 */
function releaseInstance(go: GoInstance): void {
  if (go._scheduledTimeouts instanceof Map) {
    for (const handle of go._scheduledTimeouts.values()) clearTimeout(handle as never);
    go._scheduledTimeouts.clear();
  }
  go._resume = () => {};
  go._inst = null;
  go.mem = null;
  go._values = null;
  go._goRefCounts = null;
  go._ids = null;
}

export function createCliRuntime(options?: CliRuntimeOptions): CliRuntime {
  return new CliRuntime(options);
}

let shared: CliRuntime | null = null;

/**
 * 整个应用共用一个运行时。
 *
 * 每个工作台自己 new 一个的话，React 严格模式把副作用跑两遍就会**下载两份
 * 142MB**，第二份还会把第一份的缓存写坏。编译好的模块本来就是无状态的，
 * 共用没有任何坏处。
 */
export function sharedCliRuntime(options?: CliRuntimeOptions): CliRuntime {
  if (!shared) shared = new CliRuntime(options);
  return shared;
}
