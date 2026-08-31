import type { PyodideAPI, PyodideConfig } from 'pyodide';

/**
 * Pyodide 装配：学员写的 Python 跑在哪
 *
 * 选 Pyodide 而不是自己写一个 Python 子集解释器，理由在 design/llmlab.md 第三节：
 * 接口 100% 保真（写的就是能贴进 PyTorch 的代码）、CPython 标准库白拿、
 * 而且**跨引擎确定性反而更好** —— 同一个 wasm 二进制到哪都算同一个数，
 * 不像 JS 的 `Math.exp` 在 V8 与 JSC 上不一样。
 *
 * ## 三条硬约束（少一条就是线上事故）
 *
 * **1. 绝不 CDN。** Pyodide 默认从 `cdn.jsdelivr.net` 取 indexURL 下的文件与 wheel。
 * 这个 app 是离线优先的 —— 一旦有任何一条这样的路径，断网环境下关卡直接开不了。
 * 所以 `indexURL` 是**必填参数**，没有默认值：忘了传就是启动失败，
 * 而不是安静地走上网络。`loadPackage` 一次都不许调（有测试扫源码）。
 *
 * **2. 不用 numpy。** 实测 Pyodide 里 numpy 的 f32 matmul 只有 3.0–4.9 GFLOP/s
 * （它用的是 Netlib 参考 BLAS，SIMD 与线程都关着），而我们自己的 wasm 算子核
 * 是 37–42。差一个数量级，还要多背一个 2.9MB 的 wheel。
 *
 * **3. `PYTHONHASHSEED` 必须钉死。** 否则 `hash()` 随机化会让任何依赖
 * 集合/字典迭代顺序的结果不可复现 —— BPE 训练里选哪一对合并就是典型受害者。
 *
 * ## 不 import 任何 Node 内置模块
 *
 * 这个文件要在浏览器、Electron 渲染进程和 jest 里跑同一份。
 * `indexURL` 怎么算是调用方的事：浏览器给 `/llmlab/pyodide/`，
 * 测试给一个 `file://` 或绝对路径。
 */

/** Pyodide 实例上我们真正用到的那部分 */
export interface PythonRuntime {
  /**
   * 跑一段 Python，返回最后一个表达式的值。
   *
   * ⚠️ **返回的是 Pyodide 的原始值，不是转好的 JS。** 数字与字符串会自动落成
   * JS 的原始类型，但 list / dict / 自定义对象回来的是 `PyProxy` ——
   * 拿两个 PyProxy 直接比相等比的是代理对象本身（里面还有个 `ptr`），
   * 内容相同也会不等。要值就在 Python 侧 `json.dumps` 一下，或者自己 `.toJs()`。
   */
  run(code: string): unknown;
  runAsync(code: string): Promise<unknown>;
  /** 往 Python 的全局命名空间里塞一个对象（算子桥就是这么进去的） */
  setGlobal(name: string, value: unknown): void;
  getGlobal(name: string): unknown;
  /** 往虚拟文件系统里写一个文件（nanotorch 的源码、学员的脚本） */
  writeFile(path: string, content: string): void;
  readFile(path: string): string;
  mkdir(path: string): void;
  /** 取走并清空攒下来的 stdout / stderr */
  drainOutput(): { stdout: string; stderr: string };
  /** 底层实例，给需要细粒度控制的地方 */
  readonly raw: PyodideLike;
}

/*
 * 用 Pyodide 自己的类型，不自己抄一份。
 *
 * `import type` 在编译期就被抹掉，所以这一行不会把 pyodide 拉进浏览器的包里 ——
 * 真正的加载仍然是运行时的动态 import。
 *
 * 一开始这里手写了一个 `PyodideLike` 接口「避免把 any 到处传」，
 * 结果是 tsc 拒绝在两者之间转换 —— 而它是对的：手抄的接口迟早和上游漂移，
 * 到时候类型是绿的、运行时是坏的。
 */
export type PyodideLike = PyodideAPI;

export interface LoadPythonOptions {
  /**
   * Pyodide 资产所在的目录，**必填**。
   *
   * 浏览器：`/llmlab/pyodide/`。Node / 测试：`public/llmlab/pyodide/` 的绝对路径。
   * 没有默认值是有意的 —— 见文件开头「绝不 CDN」。
   */
  indexURL: string;
  /**
   * 怎么拿到 `loadPyodide`。
   *
   * 默认动态 import `pyodide` 这个 npm 包。传进来是为了让测试能换掉，
   * 以及将来在 Worker 里换成从 `indexURL` importScripts。
   */
  loader?: () => Promise<{ loadPyodide: (opts?: PyodideConfig) => Promise<PyodideAPI> }>;
}

/** 装配好之后先跑这一段：把不确定性掐掉 */
const DETERMINISM_PRELUDE = `
import sys, random
# 见 runtime.ts 的硬约束 3：hash 随机化会让 BPE 的 merge 选择不可复现。
# PYTHONHASHSEED 在 Pyodide 里要靠环境变量，而环境变量在实例化时就定了，
# 所以这里再补一道：把 random 也钉死，并且不给 time 之类的东西留后门。
random.seed(0)
sys.setrecursionlimit(10000)
`;

export async function loadPythonRuntime(options: LoadPythonOptions): Promise<PythonRuntime> {
  const { indexURL } = options;
  if (!indexURL) {
    throw new Error('loadPythonRuntime 需要 indexURL —— 不给默认值是为了杜绝走 CDN');
  }

  const loader = options.loader ?? (() => import('pyodide'));
  const { loadPyodide } = await loader();

  let stdout = '';
  let stderr = '';

  const py = await loadPyodide({
    indexURL,
    /*
     * 空数组 = 一个包都不预装。**永远不要在这里列包名**，
     * 也永远不要在别处调 `py.loadPackage(...)` —— 那两条路都会去
     * indexURL 找 wheel，而我们只拷了运行时本体，没拷任何 wheel。
     * 在浏览器里那会变成一次对 CDN 的请求（Pyodide 找不到就回退到默认 CDN）。
     */
    packages: [],
    env: { PYTHONHASHSEED: '0' },
  } as PyodideConfig);

  py.setStdout({ batched: (s: string) => { stdout += `${s}\n`; } });
  py.setStderr({ batched: (s: string) => { stderr += `${s}\n`; } });
  py.runPython(DETERMINISM_PRELUDE);

  return {
    raw: py,
    run(code) { return py.runPython(code); },
    runAsync(code) { return py.runPythonAsync(code); },
    setGlobal(name, value) { py.globals.set(name, value); },
    getGlobal(name) { return py.globals.get(name); },
    writeFile(path, content) {
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (dir && !py.FS.analyzePath(dir).exists) py.FS.mkdirTree(dir);
      // 不传 encoding：Emscripten 的 FS.writeFile 收到字符串时本来就按 UTF-8 写，
      // 而这个选项在新版里已经不在签名上了（tsc 会拒）
      py.FS.writeFile(path, content);
    },
    readFile(path) { return py.FS.readFile(path, { encoding: 'utf8' }); },
    mkdir(path) { py.FS.mkdirTree(path); },
    drainOutput() {
      const out = { stdout, stderr };
      stdout = '';
      stderr = '';
      return out;
    },
  };
}
