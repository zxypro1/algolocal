/**
 * OpenBao
 *
 * Vault 在 2023 年改成 BUSL 之后 fork 出来的开源版本，接口与 Vault 兼容。
 * 这里做的是 KV v2 引擎与两种认证方式，够撑起「密钥住在集群外面」这件事。
 *
 * KV v2 有一处容易绊人：读写路径和挂载路径不一样。挂在 `secret/` 上的引擎，
 * 写的时候路径是 `secret/data/<path>`，`bao kv put secret/<path>` 只是替你
 * 把 `data/` 插进去了。ESO 的 SecretStore 里写错这一层是最常见的配置错误。
 */
export interface BaoAuthKubernetes {
  /** 允许哪些 ServiceAccount 登录，形如 `argocd/deployer` */
  boundServiceAccounts: string[];
  /** 登录后拿到哪个策略 */
  policy: string;
}

export interface BaoPolicy {
  /** 路径 -> 允许的能力（read / create / update / list / delete） */
  rules: Record<string, string[]>;
}

export interface BaoLoginResult {
  token: string;
  policy: string;
}

/**
 * 一个 OpenBao 实例。
 *
 * 数据全在内存里，和镜像仓库、Git 服务一样是「集群外的东西」——
 * 世界拥有它，集群只能通过网络访问。
 */
export class OpenBao {
  /** path -> 版本列表，最后一个是最新的 */
  private readonly kv = new Map<string, Array<Record<string, string>>>();
  private readonly policies = new Map<string, BaoPolicy>();
  private readonly tokens = new Map<string, string>();
  private roles = new Map<string, BaoAuthKubernetes>();
  private tokenSeq = 0;
  /** 认证方式开没开。没开的话 Kubernetes auth 登录会被拒。 */
  kubernetesAuthEnabled = false;

  constructor(readonly address: string) {}

  /* ---------------- 策略与令牌 ---------------- */

  addPolicy(name: string, policy: BaoPolicy): void {
    this.policies.set(name, policy);
  }

  /** 直接登记一把令牌。关卡里预先发好的那些走这里。 */
  addToken(token: string, policy: string): void {
    this.tokens.set(token, policy);
  }

  /** 发一把静态令牌。root 令牌就是这么来的。 */
  issueToken(policy: string): string {
    this.tokenSeq += 1;
    const token = `bao-${policy}-${this.tokenSeq}`;
    this.tokens.set(token, policy);
    return token;
  }

  enableKubernetesAuth(roles: Record<string, BaoAuthKubernetes> = {}): void {
    this.kubernetesAuthEnabled = true;
    for (const [name, role] of Object.entries(roles)) this.roles.set(name, role);
  }

  /** 加一个角色。`bao write auth/kubernetes/role/<name> ...` 走这里。 */
  addKubernetesRole(name: string, role: BaoAuthKubernetes): void {
    this.roles.set(name, role);
  }

  kubernetesRole(name: string): BaoAuthKubernetes | undefined {
    return this.roles.get(name);
  }

  hasPolicy(name: string): boolean {
    return this.policies.has(name);
  }

  /**
   * ServiceAccount 换令牌。
   *
   * 这才是集群里该用的方式：没有需要自己保管的长期凭据，
   * 身份来自 Kubernetes 自己签发的 token，OpenBao 这边只认「哪个 SA」。
   */
  loginKubernetes(role: string, serviceAccount: string): BaoLoginResult | { error: string } {
    if (!this.kubernetesAuthEnabled) {
      return { error: 'permission denied: kubernetes auth method is not enabled' };
    }
    const found = this.roles.get(role);
    if (!found) return { error: `role "${role}" could not be found` };
    if (!found.boundServiceAccounts.includes(serviceAccount)) {
      return { error: `service account "${serviceAccount}" is not authorized for role "${role}"` };
    }
    return { token: this.issueToken(found.policy), policy: found.policy };
  }

  policyOf(token: string): string | undefined {
    return this.tokens.get(token);
  }

  /* ---------------- KV v2 ---------------- */

  /** 写一版。KV v2 保留历史，所以这是 append 不是覆盖。 */
  write(path: string, data: Record<string, string>): number {
    const versions = this.kv.get(normalize(path)) ?? [];
    versions.push({ ...data });
    this.kv.set(normalize(path), versions);
    return versions.length;
  }

  /** 读最新一版；`version` 可以指定历史版本 */
  read(path: string, version?: number): Record<string, string> | undefined {
    const versions = this.kv.get(normalize(path));
    if (!versions || versions.length === 0) return undefined;
    const index = version ? version - 1 : versions.length - 1;
    return versions[index];
  }

  versions(path: string): number {
    return this.kv.get(normalize(path))?.length ?? 0;
  }

  list(prefix = ''): string[] {
    const clean = normalize(prefix);
    return [...this.kv.keys()]
      .filter((path) => path.startsWith(clean))
      .sort();
  }

  /** 这把令牌能不能对这个路径做这件事 */
  allows(token: string, path: string, capability: string): boolean {
    const policyName = this.tokens.get(token);
    if (!policyName) return false;
    if (policyName === 'root') return true;
    const policy = this.policies.get(policyName);
    if (!policy) return false;
    return Object.entries(policy.rules).some(([pattern, capabilities]) => {
      if (!capabilities.includes(capability) && !capabilities.includes('*')) return false;
      return pathMatches(pattern, normalize(path));
    });
  }
}

/** KV v2 的路径里那一层 `data/` 是引擎加的，存储时归一化掉 */
function normalize(path: string): string {
  return path.replace(/^\/+/, '').replace(/^([^/]+)\/data\//, '$1/');
}

/** OpenBao 的策略路径支持结尾的 `*` 与单层的 `+` */
function pathMatches(pattern: string, path: string): boolean {
  const normalized = normalize(pattern);
  if (normalized.endsWith('*')) return path.startsWith(normalized.slice(0, -1));
  if (normalized.includes('+')) {
    const regex = new RegExp(`^${normalized.split('+').map(escapeRegex).join('[^/]+')}$`);
    return regex.test(path);
  }
  return normalized === path;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
