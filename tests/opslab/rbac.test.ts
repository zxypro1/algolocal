/**
 * RBAC
 *
 * 三件最容易搞错的事：
 *  1. **只有允许，没有拒绝** —— 写不出「除了 X 都可以」；
 *  2. RoleBinding 引用 ClusterRole 时，范围由 **Binding** 决定；
 *  3. `get` 不等于 `list`，`resourceNames` 对 list 一律不生效。
 */
import { authorize, forbiddenMessage, type RbacView, type UserInfo } from '../../src/lib/opslab/rbac';
import { createOpsWorld } from '../../src/lib/opslab/lab';
import type { KubeObject } from '../../src/lib/opslab/apiserver';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';

function view(objects: {
  roles?: unknown[]; roleBindings?: unknown[]; clusterRoles?: unknown[]; clusterRoleBindings?: unknown[];
}): RbacView {
  return {
    roles: () => (objects.roles ?? []) as KubeObject[],
    roleBindings: () => (objects.roleBindings ?? []) as KubeObject[],
    clusterRoles: () => (objects.clusterRoles ?? []) as KubeObject[],
    clusterRoleBindings: () => (objects.clusterRoleBindings ?? []) as KubeObject[],
  };
}

const DEV: UserInfo = { username: 'dev@corp.internal', groups: ['developers', 'system:authenticated'] };

const READER = {
  metadata: { name: 'reader' },
  rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }],
};

describe('规则匹配', () => {
  it('没有任何规则命中就是拒绝 —— RBAC 只有允许', () => {
    expect(authorize(view({}), DEV, { verb: 'get', resource: 'pods', namespace: 'shop' }))
      .toMatchObject({ allowed: false });
  });

  it('ClusterRoleBinding 给的是全集群的权限', () => {
    const decision = authorize(view({
      clusterRoles: [READER],
      clusterRoleBindings: [{
        metadata: { name: 'dev-reader' },
        subjects: [{ kind: 'User', name: 'dev@corp.internal' }],
        roleRef: { kind: 'ClusterRole', name: 'reader' },
      }],
    }), DEV, { verb: 'list', resource: 'pods', namespace: 'anywhere' });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('ClusterRoleBinding "dev-reader"');
  });

  it('RoleBinding 引用 ClusterRole：范围由 Binding 决定，不由 Role 决定', () => {
    const world = view({
      clusterRoles: [READER],
      roleBindings: [{
        metadata: { name: 'dev-reader', namespace: 'shop' },
        subjects: [{ kind: 'User', name: 'dev@corp.internal' }],
        roleRef: { kind: 'ClusterRole', name: 'reader' },
      }],
    });
    expect(authorize(world, DEV, { verb: 'list', resource: 'pods', namespace: 'shop' }).allowed).toBe(true);
    expect(authorize(world, DEV, { verb: 'list', resource: 'pods', namespace: 'payments' }).allowed).toBe(false);
  });

  it('按组绑定', () => {
    const decision = authorize(view({
      clusterRoles: [READER],
      clusterRoleBindings: [{
        metadata: { name: 'devs' },
        subjects: [{ kind: 'Group', name: 'developers' }],
        roleRef: { kind: 'ClusterRole', name: 'reader' },
      }],
    }), DEV, { verb: 'get', resource: 'pods', name: 'x', namespace: 'shop' });
    expect(decision.allowed).toBe(true);
  });

  it('ServiceAccount 的用户名是 system:serviceaccount:<ns>:<name>', () => {
    const sa: UserInfo = {
      username: 'system:serviceaccount:shop:deployer',
      groups: ['system:serviceaccounts', 'system:authenticated'],
    };
    const decision = authorize(view({
      clusterRoles: [READER],
      roleBindings: [{
        metadata: { name: 'deployer', namespace: 'shop' },
        subjects: [{ kind: 'ServiceAccount', name: 'deployer', namespace: 'shop' }],
        roleRef: { kind: 'ClusterRole', name: 'reader' },
      }],
    }), sa, { verb: 'list', resource: 'pods', namespace: 'shop' });
    expect(decision.allowed).toBe(true);
  });

  it('get 不等于 list —— 只写 get 的规则挡不住也放不开 list', () => {
    const world = view({
      clusterRoles: [{ metadata: { name: 'getter' }, rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }] }],
      clusterRoleBindings: [{
        metadata: { name: 'b' }, subjects: [{ kind: 'User', name: 'dev@corp.internal' }],
        roleRef: { kind: 'ClusterRole', name: 'getter' },
      }],
    });
    expect(authorize(world, DEV, { verb: 'get', resource: 'pods', name: 'x', namespace: 'shop' }).allowed).toBe(true);
    expect(authorize(world, DEV, { verb: 'list', resource: 'pods', namespace: 'shop' }).allowed).toBe(false);
  });

  it('resourceNames 只对指名道姓的请求生效，list 一律不匹配', () => {
    const world = view({
      clusterRoles: [{
        metadata: { name: 'one-secret' },
        rules: [{ apiGroups: [''], resources: ['secrets'], resourceNames: ['db'], verbs: ['get', 'list'] }],
      }],
      clusterRoleBindings: [{
        metadata: { name: 'b' }, subjects: [{ kind: 'User', name: 'dev@corp.internal' }],
        roleRef: { kind: 'ClusterRole', name: 'one-secret' },
      }],
    });
    expect(authorize(world, DEV, { verb: 'get', resource: 'secrets', name: 'db', namespace: 'shop' }).allowed).toBe(true);
    expect(authorize(world, DEV, { verb: 'get', resource: 'secrets', name: 'other', namespace: 'shop' }).allowed).toBe(false);
    // list 没有名字，带 resourceNames 的规则对它不生效
    expect(authorize(world, DEV, { verb: 'list', resource: 'secrets', namespace: 'shop' }).allowed).toBe(false);
  });

  it('子资源要单独写：pods/log', () => {
    const world = view({
      clusterRoles: [{
        metadata: { name: 'logs' },
        rules: [{ apiGroups: [''], resources: ['pods/log'], verbs: ['get'] }],
      }],
      clusterRoleBindings: [{
        metadata: { name: 'b' }, subjects: [{ kind: 'User', name: 'dev@corp.internal' }],
        roleRef: { kind: 'ClusterRole', name: 'logs' },
      }],
    });
    expect(authorize(world, DEV, { verb: 'get', resource: 'pods', subresource: 'log', name: 'x', namespace: 'shop' }).allowed).toBe(true);
    expect(authorize(world, DEV, { verb: 'get', resource: 'pods', name: 'x', namespace: 'shop' }).allowed).toBe(false);
  });

  it('system:masters 绕过一切', () => {
    const admin: UserInfo = { username: 'kubernetes-admin', groups: ['system:masters'] };
    expect(authorize(view({}), admin, { verb: 'delete', resource: 'namespaces', name: 'kube-system' }).allowed).toBe(true);
  });

  it('403 的话一字不差抄真 apiserver', () => {
    expect(forbiddenMessage(DEV, { verb: 'list', resource: 'pods', group: '', namespace: 'payments' }))
      .toBe('pods is forbidden: User "dev@corp.internal" cannot list resource "pods" in API group "" in the namespace "payments"');
    expect(forbiddenMessage(DEV, { verb: 'delete', resource: 'nodes', group: '' }))
      .toContain('at the cluster scope');
  });
});

/* ------------------------------------------------------------------ */
/* 集群里真的被挡住                                                    */
/* ------------------------------------------------------------------ */

const WORLD: OpsWorldSpec = {
  namespaces: ['default', 'shop'],
  users: {
    'admin-token': { username: 'kubernetes-admin', groups: ['system:masters'] },
    'dev-token': { username: 'dev@corp.internal', groups: ['developers'] },
  },
  objects: [
    {
      apiVersion: 'v1', kind: 'ConfigMap',
      metadata: { name: 'settings', namespace: 'shop' }, data: { a: '1' },
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole',
      metadata: { name: 'configmap-reader' },
      rules: [{ apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'list'] }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
      metadata: { name: 'dev-reader', namespace: 'shop' },
      subjects: [{ kind: 'User', name: 'dev@corp.internal' }],
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'configmap-reader' },
    },
  ] as never,
};

describe('apiserver 真的会拒绝', () => {
  async function server() {
    const world = await createOpsWorld({ world: WORLD });
    return world.cluster.apiServer;
  }

  const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  it('管理员什么都读得到', async () => {
    const api = await server();
    const response = await api.handle('/api/v1/namespaces/shop/configmaps', as('admin-token') as never);
    expect(response.status).toBe(200);
  });

  it('dev 读得到 shop 的 configmap', async () => {
    const api = await server();
    const response = await api.handle('/api/v1/namespaces/shop/configmaps', as('dev-token') as never);
    expect(response.status).toBe(200);
  });

  it('dev 读不到别的命名空间 —— RoleBinding 只管 shop', async () => {
    const api = await server();
    const response = await api.handle('/api/v1/namespaces/default/configmaps', as('dev-token') as never);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.message).toContain('cannot list resource "configmaps"');
    expect(body.message).toContain('"default"');
  });

  it('dev 删不掉东西 —— 角色里没有 delete', async () => {
    const api = await server();
    const response = await api.handle(
      '/api/v1/namespaces/shop/configmaps/settings',
      { ...as('dev-token'), method: 'DELETE' } as never
    );
    expect(response.status).toBe(403);
  });

  it('没有 token 就是匿名，什么都不行', async () => {
    const api = await server();
    const response = await api.handle('/api/v1/namespaces/shop/configmaps');
    expect(response.status).toBe(403);
    expect((await response.json()).message).toContain('system:anonymous');
  });
});
