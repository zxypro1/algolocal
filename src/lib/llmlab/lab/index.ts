/**
 * `@llm/lab` 的公开面。
 *
 * 目前只有世界的类型声明；判定运行时（`runTrainStage`）、Pyodide 装配、
 * nanotorch 与 WASM 算子核在后面几片里接进来。
 */
export type {
  TrainArchSpec,
  TrainCorpusSpec,
  TrainHParams,
  TrainMachineSpec,
  TrainTokenizerSpec,
  TrainWorldSpec,
} from './world';
