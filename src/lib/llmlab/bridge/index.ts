/**
 * JS 桥：算子核之上的张量运行时
 *
 * 三块：{@link Arena}（张量与显存）、{@link Ops}（调度与计量）、
 * {@link buildLlmMetrics}（门槛读的那棵指标树）。
 *
 * 上面是学员的代码（现在是 TS 参考模型，之后是 Python 里的 nanotorch），
 * 下面是 37KB 的 wasm。**全部门槛的取数点都在这一层** ——
 * 学员碰不到，也绕不过。
 */
import { createKernels, createKernelsAsync, loadKernelsFromUrl, type Kernels } from '../kernels';
import { Arena } from './tensor';
import { Meter, Ops, type OpName } from './ops';
import { buildLlmMetrics, type LlmMetricTree } from './metrics';

export { Arena, DTYPE_BYTES, numel } from './tensor';
export type { DType, Tensor, TensorRole, ArenaStats } from './tensor';
export { Meter, Ops } from './ops';
export type { OpName, Phase, OpRecord, OpCounters } from './ops';
export { buildLlmMetrics, isForbiddenGateMetric, FORBIDDEN_GATE_PREFIXES } from './metrics';
export type { LlmMetricTree } from './metrics';

export interface Runtime {
  readonly kernels: Kernels;
  readonly arena: Arena;
  readonly ops: Ops;
  readonly meter: Meter;
  /** 本关禁用哪些算子。判定开始时设一次 */
  forbid(ops: OpName[]): void;
  metrics(extra?: RuntimeMetricsInput): LlmMetricTree;
}

/** 只有模型自己知道的那部分（参数量按模块分、墙钟）由调用方补进来 */
export interface RuntimeMetricsInput {
  params?: { total: number; active?: number; byModule?: Record<string, number> };
  timing?: { msPerStep?: number; tokensPerSecond?: number };
}

function makeRuntime(kernels: Kernels): Runtime {
  const arena = new Arena(kernels);
  const meter = new Meter();
  const ops = new Ops(kernels, arena, meter);
  return {
    kernels, arena, ops, meter,
    forbid(list) {
      meter.forbidden = new Set(list);
    },
    metrics(extra) {
      return buildLlmMetrics({ meter, arena: arena.stats(), ...(extra ?? {}) });
    },
  };
}

/** 同步建一个运行时。Node / Web Worker 用这条（浏览器主线程编不动 37KB） */
export function createRuntime(wasmBytes: BufferSource): Runtime {
  return makeRuntime(createKernels(wasmBytes));
}

/** 异步建一个运行时。浏览器主线程用这条 */
export async function createRuntimeAsync(wasmBytes: BufferSource): Promise<Runtime> {
  return makeRuntime(await createKernelsAsync(wasmBytes));
}

/** 从默认路径取算子核并建运行时 */
export async function loadRuntime(url?: string): Promise<Runtime> {
  return makeRuntime(await loadKernelsFromUrl(url));
}
