/**
 * kubeconfig
 *
 * 第 1 关整关就在这个文件上：哪个 context、哪个 namespace、
 * 用哪把用户凭据、能不能连上。所以它得是一份**真的** kubeconfig ——
 * `kubectl config get-contexts` / `use-context` / `--context` 都要能正常工作。
 */

export interface KubeconfigCluster {
  name: string;
  server: string;
  /** PEM，base64 之前的原文；不填就是 insecure */
  certificateAuthorityData?: string;
  insecureSkipTlsVerify?: boolean;
}

export interface KubeconfigUser {
  name: string;
  token?: string;
  clientCertificateData?: string;
  clientKeyData?: string;
}

export interface KubeconfigContext {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
}

export interface KubeconfigSpec {
  clusters: KubeconfigCluster[];
  users: KubeconfigUser[];
  contexts: KubeconfigContext[];
  currentContext: string;
}

export const DEFAULT_KUBECONFIG_PATH = '/root/.kube/config';

/** 一个能直接用的单集群配置 */
export function defaultKubeconfig(server = 'https://apiserver.opslab:6443'): KubeconfigSpec {
  return {
    clusters: [{ name: 'opslab', server, insecureSkipTlsVerify: true }],
    users: [{ name: 'ops', token: 'opslab-token' }],
    contexts: [{ name: 'opslab', cluster: 'opslab', user: 'ops', namespace: 'default' }],
    currentContext: 'opslab',
  };
}

/**
 * 渲染成 YAML。
 *
 * 自己拼而不是引 YAML 库：这份结构是固定的，而且缩进要和 `kubectl config view`
 * 打出来的一致 —— 学员会把两边对着看。
 */
export function renderKubeconfig(spec: KubeconfigSpec): string {
  const lines: string[] = ['apiVersion: v1', 'kind: Config'];

  lines.push('clusters:');
  for (const cluster of spec.clusters) {
    lines.push(`- name: ${cluster.name}`, '  cluster:', `    server: ${cluster.server}`);
    if (cluster.certificateAuthorityData) {
      lines.push(`    certificate-authority-data: ${base64(cluster.certificateAuthorityData)}`);
    }
    if (cluster.insecureSkipTlsVerify) lines.push('    insecure-skip-tls-verify: true');
  }

  lines.push('contexts:');
  for (const context of spec.contexts) {
    lines.push(`- name: ${context.name}`, '  context:',
      `    cluster: ${context.cluster}`, `    user: ${context.user}`);
    if (context.namespace) lines.push(`    namespace: ${context.namespace}`);
  }

  lines.push(`current-context: ${spec.currentContext}`, 'users:');
  for (const user of spec.users) {
    lines.push(`- name: ${user.name}`, '  user:');
    if (user.token) lines.push(`    token: ${user.token}`);
    if (user.clientCertificateData) {
      lines.push(`    client-certificate-data: ${base64(user.clientCertificateData)}`);
    }
    if (user.clientKeyData) lines.push(`    client-key-data: ${base64(user.clientKeyData)}`);
  }

  return `${lines.join('\n')}\n`;
}

/** 浏览器里没有 Buffer */
function base64(text: string): string {
  return btoa(text);
}
