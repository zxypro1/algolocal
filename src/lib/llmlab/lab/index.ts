/**
 * `@llm/lab` 的公开面。
 *
 * 类型（`spec.ts`）与运行时（其余）是分开的：
 * `src/lib/engineering/types.ts` 只 import 前者，
 * 免得平台的类型定义把 Pyodide 与 wasm 拉进依赖链。
 */
export type {
  TrainArchSpec,
  TrainCorpusSpec,
  TrainHParams,
  TrainMachineSpec,
  TrainTokenizerSpec,
  TrainWorldSpec,
} from './spec';

export { buildWorld, mergeWorldSpec } from './world';
export type { TrainWorld, BuildWorldOptions } from './world';

export { createLlmLabApi, createTrainLabModules } from './modules';
export type { LlmLabApi, ScriptResult } from './modules';

export { runTrainStage, trainLabMetrics, assertGatesAreStructural } from './runner';
export type { RunTrainStageOptions } from './runner';

export {
  gradCheck, probeCausality, probeCrossDocument, probeDeterminism, probeLossMask, readJson,
} from './probes';
export type {
  CausalityReport, DeterminismReport, GradCheckReport, LossMaskReport,
} from './probes';

export {
  arithmeticPairs, charVocab, encodeChars, entropyBaselines,
  inductionBatch, inductionFloor, makeRandom, templatedEnglish,
} from './corpus';
export type { Baselines, CharVocab } from './corpus';
