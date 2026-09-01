/**
 * 把 Python 运行时、算子桥和 nanotorch 装到一起。
 *
 * 装完之后 Python 那边就能：
 *
 *     import nanotorch as nt
 *     from nanotorch import nn, optim
 *
 * 而 `nt` 底下每一次算子调用都落到 wasm 上，并且被 JS 桥那一层记了账。
 */
import type { Runtime } from '../bridge';
import { createPythonBridge } from './bridge';
import { loadPythonRuntime, type PythonRuntime, type LoadPythonOptions } from './runtime';
import { NANOTORCH_SOURCES, NANOTORCH_HASH } from './sources.generated';

export { loadPythonRuntime, NANOTORCH_HASH, NANOTORCH_SOURCES };
export type { PythonRuntime, LoadPythonOptions };
export { createPythonBridge } from './bridge';
export type { PythonBridge } from './bridge';

/** nanotorch 装在虚拟文件系统的哪 —— 也是学员脚本的工作目录 */
export const LAB_ROOT = '/lab';

export interface TrainSession {
  readonly py: PythonRuntime;
  readonly rt: Runtime;
  /** 跑学员的脚本。返回 stdout / stderr，异常按 Python 的原文抛出来 */
  runScript(path: string, source: string): { stdout: string; stderr: string };
  /**
   * 读学员脚本里的一个顶层变量。
   *
   * 判定要看的东西大多在这儿：`history`、`model`、他自己算的评测结果。
   * 走 `json.dumps` 是因为跨语言拿容器回来的是 PyProxy，
   * 比较和序列化都有坑（见 runtime.ts 里 `run` 的说明）。
   */
  scriptJson(name: string): unknown;
  /** 往工作目录里放文件（关卡的起始代码、语料、数据集） */
  writeFile(path: string, content: string): void;
  /**
   * 把学员那些模块从 `sys.modules` 里踢掉，让下一次 import 是真的从头来。
   *
   * **为什么必须有这一步。** 判定用例里到处是
   * `import importlib, bpe` + `importlib.reload(bpe)`。而 `reload`
   * 是把新源码**在同一个模块命名空间里**再执行一遍 ——
   * 新代码没重新定义的名字**不会消失**。
   *
   * 后果是判定会失效：同一次会话里先通过一次，再把代码改坏
   * （比如把 `train_bpe` 整个删掉），上一次留下的函数还在，
   * 用例照样全绿。**「通过」于是变成了「曾经通过过」。**
   *
   * `importlib.invalidate_caches()` 挡不住这个 —— 它清的是
   * finder 按目录 mtime 缓存的那份目录列表，和 `sys.modules` 无关。
   *
   * nanotorch 也在 `/lab` 下，但它是平台装的、状态挂着算子桥，
   * 重新 import 没有意义还有风险，所以排除掉。
   */
  resetLabModules(): void;
}

/**
 * 把 nanotorch 与算子桥装进一个已经起好的 Python 运行时。
 *
 * 桥注册成 Python 的 `llmlab_bridge` 模块 —— `nanotorch/_bridge.py` 从那儿取。
 * 名字写死是有意的：学员可以读到它，但换掉它不会让判定变松，
 * 因为计量在 JS 那一侧，不在这个名字上。
 */
export function installNanotorch(py: PythonRuntime, rt: Runtime): void {
  py.registerModule('llmlab_bridge', createPythonBridge(rt));
  py.mkdir(`${LAB_ROOT}/nanotorch`);
  for (const [name, source] of Object.entries(NANOTORCH_SOURCES)) {
    py.writeFile(`${LAB_ROOT}/${name}`, source);
  }
  py.run(`
import sys
if ${JSON.stringify(LAB_ROOT)} not in sys.path:
    sys.path.insert(0, ${JSON.stringify(LAB_ROOT)})
`);
}

/** 起一个能跑学员脚本的会话：Python + 算子桥 + nanotorch */
export async function createTrainSession(
  rt: Runtime,
  options: LoadPythonOptions
): Promise<TrainSession> {
  const py = await loadPythonRuntime(options);
  installNanotorch(py, rt);

  return {
    py,
    rt,
    writeFile(path, content) {
      py.writeFile(path.startsWith('/') ? path : `${LAB_ROOT}/${path}`, content);
    },
    runScript(path, source) {
      const full = path.startsWith('/') ? path : `${LAB_ROOT}/${path}`;
      py.writeFile(full, source);
      py.drainOutput();
      /*
       * 用 runpy 而不是直接 runPython(source)：这样学员脚本里的
       * `__name__ == "__main__"`、相对 import、以及 traceback 里的文件名
       * 都和真的跑一个 .py 一样。报错信息是学员唯一的线索，不能糊。
       */
      /*
       * `runpy.run_path` 在**自己的命名空间**里跑，跑完把那个 dict 返回来。
       * 不接住的话，脚本里的顶层变量在外面一个都读不到 ——
       * 而判定要读的正是那些（history、评测结果、模型对象）。
       */
      py.run(`
import runpy
_lab_globals = runpy.run_path(${JSON.stringify(full)}, run_name="__main__")
`);
      return py.drainOutput();
    },
    resetLabModules() {
      /*
       * 用推导式而不是 for 语句：`for _x in ...` 会把 _x 留在全局命名空间里，
       * 而这段跑在**判定用例共用的那个命名空间**（`_cache`、`_full` 都在这儿），
       * 多留一个名字就是多一次可能的撞名。推导式的循环变量不外泄。
       */
      py.run(`
import sys as _sys
[_sys.modules.pop(_n, None) for _n in [
    _k for _k, _v in list(_sys.modules.items())
    if _k != "nanotorch" and not _k.startswith("nanotorch.")
    and str(getattr(_v, "__file__", "") or "").startswith(${JSON.stringify(`${LAB_ROOT}/`)})
]]
del _sys
`);
    },
    scriptJson(name) {
      const raw = py.run(`
import json
json.dumps(_lab_globals[${JSON.stringify(name)}])
`);
      return JSON.parse(String(raw));
    },
  };
}
