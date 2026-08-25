/**
 * 准入：对象写进 etcd 之前的最后一道关
 *
 * 内置的（PodSecurity）直接在 apiserver 里；Kyverno 是集群里的一个工作负载，
 * 停掉它策略就不再生效 —— 和 CNI、网格是同一条架构约束。
 */
export type { AdmissionOperation, AdmissionPlugin, AdmissionRequest, AdmissionResponse } from './types';
export { PSA_LABELS, modesOf, violationsOf, psaMessage } from './psa';
export type { PsaLevel, PsaModes } from './psa';
export { createPsaValidator } from './plugin';
export { CLUSTERPOLICIES, POLICYREPORTS, KYVERNO_RESOURCES, KYVERNO_LABEL } from './resources';
export { reviewWithKyverno, matchesPattern } from './kyverno';
export type { KyvernoContext, KyvernoOutcome } from './kyverno';
export { SignatureStore, signDigest, digestOf, payloadFor } from './cosign';
export type { Signature } from './cosign';
export { createCosignCommand } from './cosigncli';
export type { CosignOptions } from './cosigncli';
