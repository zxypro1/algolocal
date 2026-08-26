/**
 * 自定义资源
 *
 * CRD 让 apiserver 多认识一种类型；认识之后，存储、watch、RBAC、kubectl
 * 全套白送。控制器只是这套设施的消费者 —— 这也是为什么「写一个 Operator」
 * 的重点从来不是写 CRD，而是写那个 reconcile。
 */
export { CUSTOMRESOURCEDEFINITIONS, CRD_RESOURCES } from './resources';
export { CrdController, definitionOf } from './controller';
export type { CrdOptions } from './controller';
