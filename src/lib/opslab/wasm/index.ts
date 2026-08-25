/**
 * 真 CLI 在浏览器里跑
 */
export {
  CliRuntime, createCliRuntime, CLI_WASM_URL, WASM_EXEC_URL,
  type CliRuntimeOptions, type CliRunOptions, type CliResult, type FetchLike,
} from './runtime';

export { createGoFs, type GoFsOptions } from './gofs';

export {
  createIndexedDbCache, remoteSignature,
  type ModuleCache, type CacheEntry,
} from './cache';

export {
  renderKubeconfig, defaultKubeconfig, DEFAULT_KUBECONFIG_PATH,
  type KubeconfigSpec, type KubeconfigCluster, type KubeconfigUser, type KubeconfigContext,
} from './kubeconfig';

export { installClusterCli, type InstallCliOptions } from './install';
