/**
 * 自愿中断
 *
 * PDB 管的是主动发起的中断（维护、缩容、驱逐），管不了节点掉电这类
 * 非自愿中断。驱逐走 eviction 子资源会先问 PDB，delete 不会 ——
 * 这是 `kubectl drain` 和 `kubectl delete pod` 行为不同的根源。
 */
export { evaluatePdb, evictionVerdict, desiredHealthyOf, isHealthy, matchesSelector } from './pdb';
export type { PdbStatus } from './pdb';
export { PODDISRUPTIONBUDGETS, DISRUPTION_RESOURCES } from './resources';
export { PdbController } from './controller';
