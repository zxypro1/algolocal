/**
 * 关卡运行时的门面
 *
 * 一句话建好一个世界：机器 + 设备 + 整套 CUDA 工具链。
 */
export { createGpuWorld, materialize, toDim3 } from './world';
export type {
  BenchSpec, BufferFill, BufferSpec, GpuWorld, GpuWorldSpec, LaunchSpec,
} from './world';
export { installToolchain, runBench } from './cli';
export { formatProfile, formatNvidiaSmi, arithmeticIntensity } from './report';
export { createGpuLabApi, createGpuLabModules, GpuLabError } from './modules';
export type { GpuLabApi, Deviation } from './modules';
export { ulpDistanceOf, accumulationTolerance } from './numeric';
export { runGpuStage, gpuMetricTree } from './runner';
export type { RunGpuStageOptions } from './runner';

import { createGpuWorld, type GpuWorld, type GpuWorldSpec } from './world';
import { installToolchain } from './cli';

/** 建一个装好工具链、可以直接敲命令的世界 */
export function buildWorld(spec: GpuWorldSpec): GpuWorld {
  const world = createGpuWorld(spec);
  installToolchain(world);
  return world;
}
