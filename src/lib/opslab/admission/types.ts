/**
 * 准入
 *
 * 对象写进 etcd 之前的最后一道关。和鉴权的区别是：鉴权只看「谁在做什么」，
 * 准入看**对象本身长什么样** —— 特权容器、没写 limits、镜像没签名，
 * 都是在这一层被拦下的。
 *
 * 真集群里这一层由内置插件（PodSecurity）与 webhook（Kyverno、Gatekeeper）
 * 组成，我们照同样的分工：内置的直接在 apiserver 里，Kyverno 是集群里的
 * 一个工作负载 —— 停掉它，策略就不再生效。
 */
import type { KubeObject, ResourceDefinition } from '../apiserver';

export type AdmissionOperation = 'CREATE' | 'UPDATE';

export interface AdmissionRequest {
  definition: ResourceDefinition;
  namespace?: string;
  operation: AdmissionOperation;
  object: KubeObject;
  /** UPDATE 时的旧对象 */
  oldObject?: KubeObject;
}

export interface AdmissionResponse {
  allowed: boolean;
  /** 拒绝的原因。会原样出现在 kubectl 的报错里，所以要能读。 */
  message?: string;
  /** 不拦，但要提醒。真 apiserver 通过 Warning 头带回来。 */
  warnings?: string[];
}

export interface AdmissionPlugin {
  /** 出现在报错里，学员据此知道是谁拦的 */
  readonly name: string;
  review(request: AdmissionRequest): AdmissionResponse;
}
