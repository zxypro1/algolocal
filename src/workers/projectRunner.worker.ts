/**
 * 关卡运行 Worker
 *
 * 工程题的代码是用户自己写的多文件工程，一个 `while (true)` 就能把主线程冻住。
 * 放到 Worker 里跑，主线程随时可以 terminate，最差情况只是这次运行被中断。
 */
// 这里必须是**静态** import：Worker 里没有 window/document，
// 而 webpack 的动态 import() 会走 JSONP 加载 chunk 并访问它们，直接报
// "window is not defined"。静态导入把编译器打进 worker 自己的 bundle。
import * as ts from 'typescript';
import { runStage } from '../lib/engineering/runner';
import { createTranspiler, needsTranspiler, sourcesOf } from '../lib/engineering/transpile';
import type { RunStageOptions } from '../lib/engineering/runner';

export interface RunRequestMessage {
  id: number;
  payload: Omit<RunStageOptions, 'transpile'>;
}

const context = self as unknown as Worker;

context.onmessage = async (event: MessageEvent<RunRequestMessage>) => {
  const { id, payload } = event.data;

  try {
    // 用例文件也要算进来：它们和工作区一起被编译
    const transpile = needsTranspiler(sourcesOf(payload)) ? createTranspiler(ts) : undefined;
    const report = await runStage({ ...payload, transpile });
    context.postMessage({ id, report });
  } catch (error) {
    context.postMessage({ id, error: (error as Error)?.message || String(error) });
  }
};

export {};
