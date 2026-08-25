/**
 * apiserver 的 REST 语义层
 *
 * 对象生命周期（默认值、resourceVersion 与乐观并发、generation、
 * finalizer 与级联删除、分页、watch）都在这里；字段合法性校验是下一层的事。
 * 详见 design/opslab.md 里 L2 那一节。
 */
export {
  Registry,
  FOREGROUND_DELETION,
  ORPHAN_DEPENDENTS,
  formatTimestamp,
  parseFieldSelector,
  parseLabelSelector,
} from './registry';
export type { Defaulter, RegistryDeps, Validator } from './registry';
export { Scheme, createScheme, storageKey, storagePrefix } from './scheme';
export { ApiServer, createApiServer, parsePath } from './http';
export type { ApiServerDeps } from './http';
export { humanDuration, printerFor, renderTable, wantsTable, TABLE_PRINTERS } from './tables';
export type { Table, TableColumnDefinition, TablePrinter, TableRow } from './tables';
export type { GVR, ResourceDefinition } from './scheme';
export {
  ApiError,
  alreadyExists,
  badRequest,
  conflict,
  forbidden,
  internalError,
  invalid,
  methodNotAllowed,
  notFound,
  tooOldResourceVersion,
  toStatus,
} from './errors';
export type { Status, StatusCause, StatusDetails, StatusReason } from './errors';
export type {
  CreateOptions,
  DeleteOptions,
  KubeList,
  KubeObject,
  ListMeta,
  ListOptions,
  ObjectMeta,
  OwnerReference,
  PatchType,
  PropagationPolicy,
  UpdateOptions,
  WatchEventOut,
} from './types';
export {
  createExecSession, parseExecRequest, statusOf, CHANNEL, EXEC_PROTOCOL,
  type ExecRequest, type ExecResult, type ExecHandler,
} from './exec';
