/**
 * 网络层
 */
export { Network, createNetwork, CONNECT_TIMEOUT_MS, type NetworkDeps } from './network';
export {
  resolve, candidatesFor, resolvConf, isIpv4, CLUSTER_DOMAIN, type DnsView, type ResolveOptions,
} from './dns';
export {
  evaluate, evaluateEgress, evaluateIngress, directionsOf, matchesSelector, inCidr,
  type PolicyDecision, type PolicyPeer, type Traffic,
} from './policy';
export type { ConnectResult, ConnectKind, Hop, Resolution, Source, Target, Zone } from './types';
export { createNetTools, parseUrl, type NetToolsOptions } from './tools';
