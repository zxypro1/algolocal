/**
 * apiserver 的对象模型
 *
 * 字段与语义照抄 Kubernetes —— 学员从 `kubectl get -o yaml` 里看到什么，
 * 这里就得有什么。字段名一律用 k8s 的原名，不做本地化的重命名。
 */

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  /** 属主被删时是否连带删掉这个对象。默认按 true 处理。 */
  blockOwnerDeletion?: boolean;
  controller?: boolean;
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  /** 就是存储层的 modRevision，字符串形式 —— k8s 对外一律用字符串 */
  resourceVersion?: string;
  /** spec 每变一次 +1；status 变不算。控制器拿它和 observedGeneration 比 */
  generation?: number;
  creationTimestamp?: string;
  /**
   * 标记删除的时刻。
   *
   * 有 finalizer 的对象删不掉，只会被打上这个时间戳 —— 对象还在，
   * 但已经处在「正在删除」状态。所有 finalizer 摘干净了才真的消失。
   */
  deletionTimestamp?: string;
  deletionGracePeriodSeconds?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  finalizers?: string[];
  ownerReferences?: OwnerReference[];
}

export interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: ObjectMeta;
  spec?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

export interface ListMeta {
  resourceVersion: string;
  /** 分页游标；还有下一页时才有 */
  continue?: string;
  remainingItemCount?: number;
}

export interface KubeList {
  apiVersion: string;
  kind: string;
  metadata: ListMeta;
  items: KubeObject[];
}

/** 删除策略。对应 kubectl 的 --cascade */
export type PropagationPolicy = 'Foreground' | 'Background' | 'Orphan';

export interface DeleteOptions {
  propagationPolicy?: PropagationPolicy;
  gracePeriodSeconds?: number;
  /** 前置条件：uid / resourceVersion 对不上就拒绝 */
  preconditions?: { uid?: string; resourceVersion?: string };
}

export interface ListOptions {
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
  /** 上一页返回的 continue */
  continue?: string;
  /** 从这一版开始读；不传读最新 */
  resourceVersion?: string;
}

export interface CreateOptions {
  /** 只校验不写 */
  dryRun?: boolean;
  fieldManager?: string;
}

export interface UpdateOptions extends CreateOptions {}

export type PatchType =
  | 'application/json-patch+json'
  | 'application/merge-patch+json'
  | 'application/strategic-merge-patch+json'
  | 'application/apply-patch+yaml';

export interface WatchEventOut {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK';
  object: KubeObject;
}
