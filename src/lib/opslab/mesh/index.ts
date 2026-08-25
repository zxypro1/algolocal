/**
 * Istio ambient
 *
 * 做的是可观察面与判定面：谁用什么身份访问谁、被哪条策略放行或拒绝。
 * 不做 HBONE 的字节流 —— 那一层对「排查网格」这件事没有教学价值，
 * 而它带来的实现量足以淹没其余部分。
 */
export {
  AUTHORIZATIONPOLICIES, PEERAUTHENTICATIONS, MESH_RESOURCES,
  AMBIENT_LABEL, ZTUNNEL_LABEL, ISTIOD_LABEL, WAYPOINT_CLASS, TRUST_DOMAIN, spiffeId,
} from './resources';
export { evaluateAuthz, policiesFor, globMatch } from './policy';
export type { AuthzDecision, MeshRequest, MeshTarget } from './policy';
export { traverseMesh, strictnessFor, isAmbient } from './mesh';
export type { MeshOutcome, MeshPeer, MeshView } from './mesh';
export { createIstioctlCommand } from './istioctl';
export type { IstioctlOptions } from './istioctl';
