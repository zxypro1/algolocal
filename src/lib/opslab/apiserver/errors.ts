/**
 * apiserver 的错误 —— 报错文本要和真集群一字不差
 *
 * 学员看到的报错就是他们排查问题的全部线索，所以这里不自己发挥措辞，
 * 一律照抄 k8s 的 `staging/src/k8s.io/apimachinery/pkg/api/errors/errors.go`。
 * 比如「改的东西被别人动过」在真集群里是这一句：
 *
 *   Operation cannot be fulfilled on pods "web": the object has been modified;
 *   please apply your changes to the latest version and try again
 *
 * 不是「conflict detected」之类看着合理但学员搜不到的自创说法。
 */

export type StatusReason =
  | 'NotFound'
  | 'AlreadyExists'
  | 'Conflict'
  | 'Invalid'
  | 'BadRequest'
  | 'Forbidden'
  | 'MethodNotAllowed'
  | 'Gone'
  | 'UnsupportedMediaType'
  | 'InternalError'
  /** 驱逐被 PDB 挡下时用的就是它 —— 429，意思是「现在不行，等会儿再来」 */
  | 'TooManyRequests';

export interface StatusCause {
  reason: string;
  message: string;
  /** 出问题的字段路径。有些原因（比如 PDB 拦下驱逐）没有具体字段。 */
  field?: string;
}

export interface StatusDetails {
  name?: string;
  group?: string;
  kind?: string;
  uid?: string;
  causes?: StatusCause[];
  retryAfterSeconds?: number;
}

export interface Status {
  kind: 'Status';
  apiVersion: 'v1';
  metadata: Record<string, never>;
  status: 'Failure';
  message: string;
  reason: StatusReason;
  details?: StatusDetails;
  code: number;
}

/**
 * apiserver 抛出来的错误。
 *
 * 带着完整的 Status —— HTTP 层直接把它序列化成响应体，
 * kubectl 那边靠 reason 与 details 决定怎么显示。
 */
export class ApiError extends Error {
  readonly status: Status;

  constructor(status: Status) {
    super(status.message);
    this.name = 'ApiError';
    this.status = status;
  }

  get code(): number {
    return this.status.code;
  }

  get reason(): StatusReason {
    return this.status.reason;
  }
}

function makeStatus(
  code: number,
  reason: StatusReason,
  message: string,
  details?: StatusDetails
): Status {
  return {
    kind: 'Status',
    apiVersion: 'v1',
    metadata: {},
    status: 'Failure',
    message,
    reason,
    ...(details ? { details } : {}),
    code,
  };
}

/** `pods "web" not found` */
export function notFound(resource: string, name: string, group = ''): ApiError {
  return new ApiError(
    makeStatus(404, 'NotFound', `${resource} "${name}" not found`, { name, group, kind: resource })
  );
}

/** `pods "web" already exists` */
export function alreadyExists(resource: string, name: string, group = ''): ApiError {
  return new ApiError(
    makeStatus(409, 'AlreadyExists', `${resource} "${name}" already exists`, {
      name,
      group,
      kind: resource,
    })
  );
}

/**
 * `Operation cannot be fulfilled on pods "web": the object has been modified;
 *  please apply your changes to the latest version and try again`
 */
export function conflict(resource: string, name: string, detail?: string, group = ''): ApiError {
  const because =
    detail ??
    'the object has been modified; please apply your changes to the latest version and try again';
  return new ApiError(
    makeStatus(409, 'Conflict', `Operation cannot be fulfilled on ${resource} "${name}": ${because}`, {
      name,
      group,
      kind: resource,
    })
  );
}

/** `Pod "web" is invalid: spec.replicas: Invalid value: -1: must be greater than or equal to 0` */
export function invalid(kind: string, name: string, causes: StatusCause[], group = ''): ApiError {
  const summary = causes
    .map((cause) => `${cause.field}: ${cause.message}`)
    .join(', ');
  return new ApiError(
    makeStatus(422, 'Invalid', `${kind} "${name}" is invalid: ${summary}`, {
      name,
      group,
      kind,
      causes,
    })
  );
}

export function badRequest(message: string): ApiError {
  return new ApiError(makeStatus(400, 'BadRequest', message));
}

export function forbidden(message: string): ApiError {
  return new ApiError(makeStatus(403, 'Forbidden', message));
}

export function methodNotAllowed(verb: string, resource: string): ApiError {
  return new ApiError(
    makeStatus(405, 'MethodNotAllowed', `${verb} is not supported on resource "${resource}"`)
  );
}

/**
 * `too old resource version: 12 (34)`
 *
 * informer 从一个已经被压缩掉的版本起 watch 时收到它，
 * 正确的反应是丢掉本地缓存重新 list —— 这是 k8s 里很常见的一条日志。
 */
export function tooOldResourceVersion(requested: number, oldest: number): ApiError {
  return new ApiError(
    makeStatus(410, 'Gone', `too old resource version: ${requested} (${oldest})`)
  );
}

export function internalError(message: string): ApiError {
  return new ApiError(makeStatus(500, 'InternalError', `Internal error occurred: ${message}`));
}

/** 把任意异常规整成 Status，HTTP 层用它兜底 */
export function toStatus(error: unknown): Status {
  if (error instanceof ApiError) return error.status;
  const message = error instanceof Error ? error.message : String(error);
  return makeStatus(500, 'InternalError', `Internal error occurred: ${message}`);
}
