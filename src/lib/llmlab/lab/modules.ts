/**
 * `@llm/lab` —— train 关卡的隐藏用例能拿到的东西
 *
 * 和 `@ops/lab` / `@gpu/lab` 一个路子：判定读的是**工作台里那个世界**，
 * 不是另起一个干净的。学员在编辑器里改过、在终端里跑过的东西必须算数。
 *
 * 判定的三个证据来源：
 *
 * 1. **终态** —— 跑完学员的脚本，读他算出来的东西（`scriptJson`）
 * 2. **行为探测** —— 平台自己构造场景去问（`probe.*`），学员绕不过
 * 3. **过程指标** —— `metrics()`，也就是门槛读的那棵树
 *
 * 用例是 TS，学员的代码是 Python。两边通过这个 API 交汇 ——
 * 于是学员看不到用例，用例也不受学员的 Python 代码结构影响。
 */
import type { LlmMetricTree } from '../bridge';
import type { TrainWorld } from './world';
import {
  gradCheck, probeCausality, probeCrossDocument, probeDeterminism, probeLossMask,
  type CausalityReport, type DeterminismReport, type GradCheckReport,
  type LossMaskReport,
} from './probes';
import { arithmeticPairs, inductionBatch, inductionFloor, type Baselines } from './corpus';

export interface ScriptResult {
  stdout: string;
  stderr: string;
}

export interface LlmLabApi {
  /* ---- 跑学员的东西 ---- */

  /** 跑一个学员脚本。异常按 Python 的原文抛出来 */
  run(path: string): ScriptResult;
  /** 读学员脚本里的一个顶层变量（经 json.dumps） */
  value(name: string): unknown;
  /** 直接跑一段 Python（平台身份）—— 用来问学员的对象要东西 */
  py(code: string): unknown;
  /** 学员现在写的那份源码，喂给 AI 评审 */
  source(path: string): string;

  /* ---- 门槛读的那棵树 ---- */

  metrics(): LlmMetricTree;

  /* ---- 平台探针：学员绕不过的证据 ---- */

  probe: {
    causality(runLogits: (idx: Int32Array) => Float64Array | Float32Array,
              idx: Int32Array, seqLen: number, vocab: number): CausalityReport;
    determinism(run: () => ArrayLike<number>): DeterminismReport;
    gradCheck(params: Array<{ name: string; values: Float64Array; grad: Float64Array }>,
              loss: () => number): GradCheckReport;
    lossMask(dlogits: ArrayLike<number>, mask: ArrayLike<number>,
             rows: number, vocab: number): LossMaskReport;
    crossDocument(probs: ArrayLike<number>, docIds: ArrayLike<number>,
                  batch: number, heads: number, seqLen: number): { crossDocumentPairs: number; checked: number };
  };

  /* ---- 世界 ---- */

  world: {
    /** 语料原文 */
    corpus(name?: string): string;
    /** 字符词表 */
    vocabSize(): number;
    /** 三条基线。`baselines().bigram` 是第 16 关那条门槛的分母 */
    baselines(): Baselines;
    /** 主语料的 token 序列 */
    tokens(): Int32Array;
    /** 留出集的起点 */
    holdoutAt(): number;
  };

  /* ---- 合成数据：题目要用的那几种 ---- */

  data: {
    induction(batch: number, seqLen: number, vocab: number, seed: number):
      { idx: Int32Array; tgt: Int32Array };
    /** 归纳任务的信息论地板 —— 门槛的分母，必须由平台算 */
    inductionFloor(seqLen: number, vocab: number): number;
    arithmetic(count: number, maxValue: number, seed: number):
      Array<{ prompt: string; answer: string }>;
  };
}

export function createLlmLabApi(world: TrainWorld): LlmLabApi {
  const { session, rt } = world;

  return {
    run(path) {
      const source = session.py.readFile(path.startsWith('/') ? path : `/lab/${path}`);
      return session.runScript(path, source);
    },
    value: (name) => session.scriptJson(name),
    py: (code) => session.py.run(code),
    source(path) {
      return session.py.readFile(path.startsWith('/') ? path : `/lab/${path}`);
    },

    metrics: () => rt.metrics(),

    probe: {
      causality: (runLogits, idx, seqLen, vocab) => probeCausality(runLogits, idx, seqLen, vocab),
      determinism: probeDeterminism,
      gradCheck: (params, loss) => gradCheck(params, loss),
      lossMask: probeLossMask,
      crossDocument: probeCrossDocument,
    },

    world: {
      corpus(name) {
        if (name) {
          const text = world.corpus[name];
          if (text === undefined) {
            throw new Error(`世界里没有语料 ${JSON.stringify(name)}，有的是：${Object.keys(world.corpus).join(', ')}`);
          }
          return text;
        }
        return world.corpus[Object.keys(world.corpus).sort()[0]];
      },
      vocabSize: () => world.vocab.size,
      baselines: () => world.baselines,
      tokens: () => world.tokens,
      holdoutAt: () => world.holdoutAt,
    },

    data: {
      induction: inductionBatch,
      inductionFloor,
      arithmetic: arithmeticPairs,
    },
  };
}

/** 注入给隐藏用例的内建模块表 */
export function createTrainLabModules(world: TrainWorld): Record<string, unknown> {
  const api = createLlmLabApi(world);
  return {
    '@llm/lab': api,
    // 别名，和 @ops/lab / @gpu/lab 的写法保持一致
    '@llm/lab/index': api,
  };
}
