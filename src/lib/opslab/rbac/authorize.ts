/**
 * RBAC 的判定
 *
 * 规则本身很简单：**只有允许，没有拒绝**。一条请求只要被任意一条规则命中
 * 就放行，没被命中就拒绝。写不出「除了 X 都可以」这种规则 —— 想表达它，
 * 只能把 X 之外的都列出来。这是 RBAC 与 NetworkPolicy、AuthorizationPolicy
 * 最大的区别，也是很多人第一次写策略时的错觉来源。
 */
import type { KubeObject } from '../apiserver';
import type { UserInfo } from './resources';

export interface ResourceAttributes {
  verb: string;
  group?: string;
  resource?: string;
  subresource?: string;
  namespace?: string;
  name?: string;
  /** 非资源请求，如 `/healthz` */
  path?: string;
}

export interface AuthorizeResult {
  allowed: boolean;
  /** 命中的角色，写进 `auth can-i -v` 与审计里 */
  reason: string;
}

export interface RbacView {
  roles(): KubeObject[];
  roleBindings(): KubeObject[];
  clusterRoles(): KubeObject[];
  clusterRoleBindings(): KubeObject[];
}

/** `system:masters` 组绕过 RBAC —— 真集群也是这么实现的 */
export const SUPERUSER_GROUP = 'system:masters';

export function authorize(
  view: RbacView,
  user: UserInfo,
  attributes: ResourceAttributes
): AuthorizeResult {
  if (user.groups.includes(SUPERUSER_GROUP)) {
    return { allowed: true, reason: 'RBAC: allowed by group "system:masters"' };
  }

  const clusterRoles = new Map(view.clusterRoles().map((role) => [role.metadata.name!, role]));
  const roles = new Map(view.roles().map(
    (role) => [`${role.metadata.namespace}/${role.metadata.name}`, role]
  ));

  // ClusterRoleBinding：给的是全集群的权限，命名空间不限
  for (const binding of view.clusterRoleBindings()) {
    if (!bindsUser(binding, user)) continue;
    const role = clusterRoles.get(roleRefName(binding));
    if (!role) continue;
    if (rulesAllow(rulesOf(role), attributes)) {
      return {
        allowed: true,
        reason: `RBAC: allowed by ClusterRoleBinding "${binding.metadata.name}" `
          + `of ClusterRole "${role.metadata.name}"`,
      };
    }
  }

  // RoleBinding：范围是 binding 自己所在的命名空间，哪怕它引用的是 ClusterRole
  for (const binding of view.roleBindings()) {
    if (binding.metadata.namespace !== attributes.namespace) continue;
    if (!bindsUser(binding, user)) continue;
    const ref = ((binding.spec ?? binding) as any).roleRef ?? {};
    const role = ref.kind === 'ClusterRole'
      ? clusterRoles.get(ref.name)
      : roles.get(`${binding.metadata.namespace}/${ref.name}`);
    if (!role) continue;
    if (rulesAllow(rulesOf(role), attributes)) {
      return {
        allowed: true,
        reason: `RBAC: allowed by RoleBinding "${binding.metadata.namespace}/${binding.metadata.name}" `
          + `of ${ref.kind} "${ref.name}"`,
      };
    }
  }

  /**
   * 拒绝时不给理由。
   *
   * 真 RBAC 授权器对「没匹配上」返回的是 NoOpinion 且理由为空，于是
   * `kubectl auth can-i` 打出来就是一个干净的 `no`。给了理由的话它会变成
   * `no - ...`，和真集群对不上。要看细节应该去看 403 的那句话，那里说全了。
   */
  return { allowed: false, reason: '' };
}

function roleRefName(binding: KubeObject): string {
  return ((binding as any).roleRef ?? {}).name ?? '';
}

function rulesOf(role: KubeObject): any[] {
  return (role as any).rules ?? [];
}

/** subjects 里有没有这个用户（或它所在的组、或它的 ServiceAccount） */
export function bindsUser(binding: KubeObject, user: UserInfo): boolean {
  const subjects: any[] = (binding as any).subjects ?? [];
  return subjects.some((subject) => {
    if (subject.kind === 'User') return subject.name === user.username;
    if (subject.kind === 'Group') return user.groups.includes(subject.name);
    if (subject.kind === 'ServiceAccount') {
      return user.username === `system:serviceaccount:${subject.namespace}:${subject.name}`;
    }
    return false;
  });
}

export function rulesAllow(rules: any[], attributes: ResourceAttributes): boolean {
  return rules.some((rule) => ruleAllows(rule, attributes));
}

function ruleAllows(rule: any, attributes: ResourceAttributes): boolean {
  if (!matches(rule.verbs ?? [], attributes.verb)) return false;

  if (attributes.path) {
    return matches(rule.nonResourceURLs ?? [], attributes.path, true);
  }

  if (!matches(rule.apiGroups ?? [], attributes.group ?? '')) return false;

  // 子资源写成 `pods/log`。规则里没写子资源时，不覆盖子资源请求。
  const wanted = attributes.subresource
    ? `${attributes.resource}/${attributes.subresource}`
    : attributes.resource ?? '';
  if (!matches(rule.resources ?? [], wanted)) return false;

  /**
   * resourceNames 限定到具体对象。
   *
   * 只对「指名道姓」的请求生效：list / watch / create 没有名字，
   * 带 resourceNames 的规则对它们一律不生效 —— 这条经常让人以为
   * 「我明明允许了这个 Secret，为什么 list 不出来」。
   */
  const names: string[] = rule.resourceNames ?? [];
  if (names.length > 0) {
    if (!attributes.name) return false;
    if (!names.includes(attributes.name)) return false;
  }
  return true;
}

/** `*` 通配；非资源 URL 额外支持结尾的 `/*` */
function matches(patterns: string[], value: string, pathStyle = false): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pathStyle && pattern.endsWith('/*')) return value.startsWith(pattern.slice(0, -1));
    return pattern === value;
  });
}

/**
 * 403 的消息。
 *
 * 一字不差地抄真 apiserver —— 学员会把这句话直接搜出去，
 * 而这句话本身也把「谁、想做什么、在哪个组、哪个命名空间」说全了。
 */
export function forbiddenMessage(user: UserInfo, attributes: ResourceAttributes): string {
  if (attributes.path) {
    return `forbidden: User ${JSON.stringify(user.username)} cannot ${attributes.verb} path `
      + `${JSON.stringify(attributes.path)}`;
  }
  const resource = attributes.subresource
    ? `${attributes.resource}/${attributes.subresource}`
    : attributes.resource;
  const scope = attributes.namespace
    ? ` in the namespace ${JSON.stringify(attributes.namespace)}`
    : ' at the cluster scope';
  return `${resource} is forbidden: User ${JSON.stringify(user.username)} cannot ${attributes.verb} `
    + `resource ${JSON.stringify(attributes.resource)} in API group ${JSON.stringify(attributes.group ?? '')}`
    + scope;
}
