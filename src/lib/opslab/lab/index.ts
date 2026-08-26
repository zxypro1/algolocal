/**
 * ops 关卡的运行与判定
 */
export { createOpsWorld, type OpsWorld, type OpsWorldOptions } from './world';
export { createOpsLabApi, createOpsLabModules, type OpsLabApi } from './modules';
export { runOpsStage, emptyMetrics, type RunOpsStageOptions } from './runner';
export {
  buildTopology, snapshotVersions, diffVersions, currentNamespaceOf,
  type TopologyGraph, type TopologyNode, type TopologyEdge, type TopologyLane,
  type TopologyStatus, type TopologyOptions, type ChangeEntry, type ChangeType,
} from './view';

export { toolchainFor, baseImageOf, type ToolchainName } from './toolchains';
export { createExecHandler, normalizeCommand } from './podshell';
export { buildPacketPath, buildPacketPaths, describe } from './view';
export { buildOpsSnapshot, summarizeReport, SNAPSHOT_LIMITS } from './aicontext';
export type {
  OpsSnapshot, OpsSnapshotOptions, OpsReportSummary, SnapshotObject, SnapshotEvent, SnapshotCommand,
  SnapshotLimits,
} from './aicontext';
export type { PacketPath, PacketStep } from './view';
