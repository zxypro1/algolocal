/**
 * 密钥不该住在集群里
 *
 * Kubernetes 的 Secret 只是 base64，不是加密：谁能 `get secret` 谁就看得到
 * 明文。把密钥放进 Git 更糟。External Secrets 的做法是让真值住在外部的
 * 密钥库里，集群里只留一份由控制器维护的投影。
 */
export { OpenBao } from './openbao';
export type { BaoAuthKubernetes, BaoLoginResult, BaoPolicy } from './openbao';
export {
  SECRETSTORES, CLUSTERSECRETSTORES, EXTERNALSECRETS, ESO_RESOURCES, ESO_LABEL,
} from './resources';
export { ExternalSecretsController, DEFAULT_REFRESH_MS } from './controller';
export type { ExternalSecretsOptions, SecretFetcher } from './controller';
export { createBaoCommand } from './baocli';
export type { BaoCliOptions } from './baocli';
