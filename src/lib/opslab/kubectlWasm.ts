/**
 * 在浏览器里跑真 kubectl（GOOS=js GOARCH=wasm）
 *
 * 三件事：
 *  1. 内存文件系统 —— kubectl 读 kubeconfig、读 `-f` 指到的 manifest，都走这里；
 *     正式版里它就是「虚拟机器的文件系统」，和 IDE 里编辑的是同一棵树。
 *  2. 拦截 fetch —— client-go 被打过补丁，在 js 上统一走 globalThis.fetch，
 *     我们把它指向内存里的 apiserver。
 *  3. 收 stdout / stderr —— 交给终端渲染。
 *
 * 编译产物不进仓库（115MB），由 scripts/build-opslab-wasm.sh 生成到
 * public/opslab/kubectl.wasm。
 */
import { createVFS } from './vfs';

export const WASM_URL = '/opslab/kubectl.wasm';

const KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
- name: opslab
  cluster:
    server: https://apiserver.opslab
contexts:
- name: opslab
  context:
    cluster: opslab
    user: ops
    namespace: default
current-context: opslab
users:
- name: ops
  user:
    token: opslab-token
`;

export interface ApiServerLike {
  handle(url: string, init?: any): Promise<Response>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

let modulePromise: Promise<WebAssembly.Module> | null = null;

/**
 * 编译一次、复用多次。
 *
 * 编译是最贵的一步（浏览器里几百毫秒），实例化只要十几毫秒 ——
 * 所以每条命令新建实例、共用同一个 Module。
 */
export function loadKubectlModule(url = WASM_URL): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`kubectl.wasm not found at ${url} (run scripts/build-opslab-wasm.sh)`);
      if (typeof WebAssembly.compileStreaming === 'function') {
        return WebAssembly.compileStreaming(Promise.resolve(response));
      }
      return WebAssembly.compile(await response.arrayBuffer());
    })();
  }
  return modulePromise;
}

/** wasm_exec.js 由 Go 发行版提供，构建脚本会把它拷到 public/opslab/ */
async function ensureGoRuntime(): Promise<void> {
  if ((globalThis as any).Go) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/opslab/wasm_exec.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('failed to load /opslab/wasm_exec.js'));
    document.head.appendChild(script);
  });
}

/**
 * 串行执行。
 *
 * 运行一条命令要把 globalThis 上的 fs / fetch / process 换成这一次的，跑完再换回去。
 * 两条命令并发的话会互相把对方的全局踩掉，输出串台。终端本身是串行的，
 * 但判定探测那边会有多个调用方，所以把串行保证放在这一层，而不是指望调用方守规矩。
 */
let queue: Promise<unknown> = Promise.resolve();

export function runKubectl(
  args: string[],
  options: { server: ApiServerLike; files?: Record<string, string>; wasmUrl?: string }
): Promise<RunResult> {
  const next = queue.then(() => runKubectlExclusive(args, options));
  // 前一条失败不能卡住后面的
  queue = next.catch(() => undefined);
  return next;
}

async function runKubectlExclusive(
  args: string[],
  options: { server: ApiServerLike; files?: Record<string, string>; wasmUrl?: string }
): Promise<RunResult> {
  const decoder = new TextDecoder();
  let stdout = '';
  let stderr = '';

  const vfs = createVFS(
    { '/root/.kube/config': KUBECONFIG, ...(options.files || {}) },
    { onStdout: (b) => { stdout += decoder.decode(b); }, onStderr: (b) => { stderr += decoder.decode(b); } }
  );

  const [mod] = await Promise.all([loadKubectlModule(options.wasmUrl), ensureGoRuntime()]);

  const g = globalThis as any;
  const saved = { fs: g.fs, fetch: g.fetch, process: g.process, path: g.path };
  g.fs = vfs;
  g.path = { resolve: (...p: string[]) => p.join('/') };
  g.process = {
    getuid: () => 0, getgid: () => 0, geteuid: () => 0, getegid: () => 0, getgroups: () => [0],
    pid: 1, ppid: 0, umask: () => 0o22, cwd: () => '/root', chdir: () => {},
    env: { HOME: '/root', KUBECONFIG: '/root/.kube/config', PATH: '/usr/bin' },
    on: () => {},
  };
  g.fetch = (url: any, init: any) => options.server.handle(String(url), init);

  const go = new g.Go();
  go.argv = ['kubectl', ...args];
  go.env = { HOME: '/root', KUBECONFIG: '/root/.kube/config' };
  let code = 0;
  go.exit = (c: number) => { code = c; };

  try {
    const instance = await WebAssembly.instantiate(mod, go.importObject);
    await go.run(instance);
  } catch (error) {
    stderr += String((error as Error)?.message || error);
    code = code || 1;
  } finally {
    /**
     * 把这一次运行的东西彻底断开。
     *
     * 不只是为了避免 wasm_exec 事后 _resume 抛「already exited」——
     * 排着的那个 setTimeout 闭包抓着 go，go 抓着实例，实例抓着 68MB 线性内存。
     * 不清的话每跑一条命令泄漏 68MB，一百多条之后标签页就被 OOM 掉了。
     *
     * 注意 _scheduledTimeouts 是 Map，不能用 Object.values 取值（会拿到空数组，
     * 看着像清理过了，其实一个都没清）。
     */
    if (go._scheduledTimeouts instanceof Map) {
      for (const handle of go._scheduledTimeouts.values()) clearTimeout(handle as any);
      go._scheduledTimeouts.clear();
    }
    go._resume = () => {};
    go._inst = null;
    go.mem = null;
    go._values = null;
    go._goRefCounts = null;
    go._ids = null;
    g.fs = saved.fs; g.fetch = saved.fetch; g.process = saved.process; g.path = saved.path;
  }

  return { stdout, stderr, code };
}
