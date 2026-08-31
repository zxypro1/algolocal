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
    scriptJson(name) {
      const raw = py.run(`
import json
json.dumps(_lab_globals[${JSON.stringify(name)}])
`);
      return JSON.parse(String(raw));
    },
  };
}
