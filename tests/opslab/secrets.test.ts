/**
 * 密钥不该住在集群里
 *
 * Kubernetes 的 Secret 只是 base64，不是加密。真值住在外部密钥库，
 * 集群里只留一份由 ESO 维护的投影。
 *
 * 这一组要钉住的行为：认证方式的差别、路径与策略、同步的时机、
 * 以及「手改了投影会被盖回去」。
 */
import { createOpsWorld } from '../../src/lib/opslab/lab';
import { OpenBao, DEFAULT_REFRESH_MS } from '../../src/lib/opslab/secrets';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

describe('OpenBao', () => {
  function bench() {
    const bao = new OpenBao('https://openbao.corp.internal:8200');
    bao.addPolicy('reader', { rules: { 'kv/payments/*': ['read', 'list'] } });
    bao.addPolicy('writer', { rules: { 'kv/payments/*': ['read', 'create', 'update'] } });
    bao.write('kv/payments/db', { username: 'app', password: 's3cr3t' });
    return bao;
  }

  it('KV v2 保留历史，读的是最新一版', () => {
    const bao = bench();
    bao.write('kv/payments/db', { username: 'app', password: 'rotated' });
    expect(bao.versions('kv/payments/db')).toBe(2);
    expect(bao.read('kv/payments/db')!.password).toBe('rotated');
    expect(bao.read('kv/payments/db', 1)!.password).toBe('s3cr3t');
  });

  it('路径里的 data/ 是引擎加的，两种写法指同一个东西', () => {
    const bao = bench();
    expect(bao.read('kv/data/payments/db')).toEqual(bao.read('kv/payments/db'));
  });

  it('策略按路径与能力判', () => {
    const bao = bench();
    const reader = bao.issueToken('reader');
    expect(bao.allows(reader, 'kv/payments/db', 'read')).toBe(true);
    expect(bao.allows(reader, 'kv/payments/db', 'update')).toBe(false);
    expect(bao.allows(reader, 'kv/analytics/db', 'read')).toBe(false);
  });

  it('root 什么都能做', () => {
    const bao = bench();
    expect(bao.allows(bao.issueToken('root'), 'anything/at/all', 'update')).toBe(true);
  });

  it('没开 Kubernetes auth 时登录被拒', () => {
    const bao = bench();
    expect(bao.loginKubernetes('eso', 'external-secrets/eso')).toEqual({
      error: 'permission denied: kubernetes auth method is not enabled',
    });
  });

  it('开了之后只认绑定过的 ServiceAccount', () => {
    const bao = bench();
    bao.enableKubernetesAuth({
      eso: { boundServiceAccounts: ['external-secrets/eso'], policy: 'reader' },
    });
    expect(bao.loginKubernetes('eso', 'external-secrets/eso')).toMatchObject({ policy: 'reader' });
    expect(bao.loginKubernetes('eso', 'payments/portal')).toMatchObject({
      error: expect.stringContaining('not authorized'),
    });
  });
});

/* ------------------------------------------------------------------ */
/* 集群里                                                              */
/* ------------------------------------------------------------------ */

const ESO_IMAGE = 'ghcr.io/external-secrets/external-secrets:v0.21.0';

const ESO_PLATFORM = [
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'eso', namespace: 'external-secrets' } },
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'external-secrets', namespace: 'external-secrets',
      labels: { 'app.kubernetes.io/name': 'external-secrets' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'external-secrets' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'external-secrets' } },
        spec: { serviceAccountName: 'eso', containers: [{ name: 'controller', image: ESO_IMAGE }] },
      },
    },
  },
];

const STORE = {
  apiVersion: 'external-secrets.io/v1', kind: 'SecretStore',
  metadata: { name: 'openbao', namespace: 'payments' },
  spec: {
    provider: {
      vault: {
        server: 'https://openbao.corp.internal:8200',
        path: 'kv',
        auth: { kubernetes: { role: 'payments', serviceAccountRef: { name: 'default' } } },
      },
    },
  },
};

const EXTERNAL = {
  apiVersion: 'external-secrets.io/v1', kind: 'ExternalSecret',
  metadata: { name: 'db', namespace: 'payments' },
  spec: {
    refreshInterval: '1m',
    secretStoreRef: { name: 'openbao', kind: 'SecretStore' },
    target: { name: 'db-credentials' },
    data: [
      { secretKey: 'username', remoteRef: { key: 'payments/db', property: 'username' } },
      { secretKey: 'password', remoteRef: { key: 'payments/db', property: 'password' } },
    ],
  },
};

function spec(objects: unknown[] = [], roles = true): OpsWorldSpec {
  return {
    namespaces: ['default', 'payments', 'external-secrets'],
    images: { [ESO_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 } },
    secretStore: {
      address: 'https://openbao.corp.internal:8200',
      data: { 'kv/payments/db': { username: 'app', password: 's3cr3t' } },
      policies: { 'payments-read': { 'kv/payments/*': ['read', 'list'] } },
      tokens: {},
      ...(roles
        ? { kubernetesRoles: { payments: { boundServiceAccounts: ['payments/default'], policy: 'payments-read' } } }
        : {}),
    },
    objects: objects as never,
  };
}

const SECRETS = { group: '', version: 'v1', resource: 'secrets' } as const;
const EXTERNALSECRETS = { group: 'external-secrets.io', version: 'v1', resource: 'externalsecrets' } as const;

const decode = (value: string) => atob(value);

async function build(objects: unknown[], roles = true) {
  return createOpsWorld({ world: spec(objects, roles) });
}

const secretOf = (w: Awaited<ReturnType<typeof build>>): KubeObject | undefined => {
  try {
    return w.cluster.registry.get(w.cluster.scheme.mustGet(SECRETS), 'payments', 'db-credentials');
  } catch {
    return undefined;
  }
};

const statusOf = (w: Awaited<ReturnType<typeof build>>) =>
  (w.cluster.registry.get(w.cluster.scheme.mustGet(EXTERNALSECRETS), 'payments', 'db').status ?? {}) as any;

describe('External Secrets', () => {
  it('同步出一个普通的 Secret，值来自密钥库', async () => {
    const w = await build([...ESO_PLATFORM, STORE, EXTERNAL]);
    const secret = secretOf(w)!;
    expect(secret).toBeTruthy();
    expect(decode((secret as any).data.username)).toBe('app');
    expect(decode((secret as any).data.password)).toBe('s3cr3t');
    expect(statusOf(w).conditions[0]).toMatchObject({ type: 'Ready', status: 'True', reason: 'SecretSynced' });
  });

  it('控制面不在，ExternalSecret 就只是一条声明', async () => {
    const w = await build([STORE, EXTERNAL]);
    expect(secretOf(w)).toBeUndefined();
  });

  it('SecretStore 找不到时，状态里写清楚原因', async () => {
    const w = await build([...ESO_PLATFORM, EXTERNAL]);
    expect(secretOf(w)).toBeUndefined();
    expect(statusOf(w).conditions[0]).toMatchObject({ status: 'False', reason: 'InvalidProviderConfig' });
  });

  it('没开 Kubernetes auth 时同步失败，而且说得出为什么', async () => {
    const w = await build([...ESO_PLATFORM, STORE, EXTERNAL], false);
    expect(secretOf(w)).toBeUndefined();
    expect(statusOf(w).conditions[0].message).toContain('kubernetes auth method is not enabled');
  });

  it('SA 没被绑定就登录不上', async () => {
    const store = {
      ...STORE,
      spec: {
        provider: {
          vault: {
            ...STORE.spec.provider.vault,
            auth: { kubernetes: { role: 'payments', serviceAccountRef: { name: 'intruder' } } },
          },
        },
      },
    };
    const w = await build([...ESO_PLATFORM, store, EXTERNAL]);
    expect(statusOf(w).conditions[0].message).toContain('not authorized');
  });

  it('策略管不到的路径取不出来', async () => {
    const external = {
      ...EXTERNAL,
      spec: {
        ...EXTERNAL.spec,
        data: [{ secretKey: 'x', remoteRef: { key: 'analytics/db', property: 'password' } }],
      },
    };
    const w = await build([...ESO_PLATFORM, STORE, external]);
    expect(statusOf(w).conditions[0].message).toContain('permission denied');
  });

  it('外部轮转之后，下一轮同步跟上 —— 但不是立刻', async () => {
    const w = await build([...ESO_PLATFORM, STORE, EXTERNAL]);
    w.bao!.write('kv/payments/db', { username: 'app', password: 'rotated' });

    // 还没到刷新时间，集群里还是旧的
    await w.cluster.settle();
    expect(decode((secretOf(w) as any).data.password)).toBe('s3cr3t');

    await w.cluster.advanceBy(DEFAULT_REFRESH_MS);
    expect(decode((secretOf(w) as any).data.password)).toBe('rotated');
  });

  it('手改了这份投影会被盖回去 —— 它归控制器管', async () => {
    const w = await build([...ESO_PLATFORM, STORE, EXTERNAL]);
    const definition = w.cluster.scheme.mustGet(SECRETS);
    const live = w.cluster.registry.get(definition, 'payments', 'db-credentials');
    w.cluster.registry.update(definition, 'payments', 'db-credentials', {
      ...live, data: { username: btoa('hacked'), password: btoa('hacked') },
    } as never);

    await w.cluster.advanceBy(DEFAULT_REFRESH_MS);
    expect(decode((secretOf(w) as any).data.username)).toBe('app');
  });

  it('dataFrom 一次性把整个路径取过来', async () => {
    const external = {
      ...EXTERNAL,
      spec: {
        ...EXTERNAL.spec,
        data: undefined,
        dataFrom: [{ extract: { key: 'payments/db' } }],
      },
    };
    const w = await build([...ESO_PLATFORM, STORE, external]);
    const secret = secretOf(w)!;
    expect(Object.keys((secret as any).data).sort()).toEqual(['password', 'username']);
  });

  it('ExternalSecret 删掉，投影跟着走', async () => {
    const w = await build([...ESO_PLATFORM, STORE, EXTERNAL]);
    expect(secretOf(w)).toBeTruthy();
    w.cluster.registry.delete(w.cluster.scheme.mustGet(EXTERNALSECRETS), 'payments', 'db');
    await w.cluster.settle();
    expect(secretOf(w)).toBeUndefined();
  });
});

describe('bao 命令', () => {
  async function shell() {
    return build([...ESO_PLATFORM]);
  }

  it('没设 BAO_ADDR 时说清楚', async () => {
    const w = await shell();
    const result = await w.run('bao status');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('BAO_ADDR 没设');
  });

  it('地址解析不到时报的是 no such host', async () => {
    const w = await shell();
    const result = await w.run('BAO_ADDR=https://nope.corp.internal:8200 bao status');
    expect(result.stderr).toContain('no such host');
  });

  it('没令牌是 400，令牌不对是 403', async () => {
    const w = await shell();
    const base = 'BAO_ADDR=https://openbao.corp.internal:8200';
    expect((await w.run(`${base} bao kv get kv/payments/db`)).stderr).toContain('missing client token');
    expect((await w.run(`${base} BAO_TOKEN=nope bao kv get kv/payments/db`)).stderr).toContain('permission denied');
  });

  it('拿到令牌就读得出来，-field 只打一个值', async () => {
    const w = await shell();
    const token = w.bao!.issueToken('root');
    const base = `BAO_ADDR=https://openbao.corp.internal:8200 BAO_TOKEN=${token}`;
    const table = await w.run(`${base} bao kv get kv/payments/db`);
    expect(table.stdout).toContain('password');
    expect(table.stdout).toContain('s3cr3t');

    const field = await w.run(`${base} bao kv get -field=password kv/payments/db`);
    expect(field.stdout.trim()).toBe('s3cr3t');
  });

  it('写进去的东西 ESO 取得到', async () => {
    const w = await build([...ESO_PLATFORM, STORE, {
      ...EXTERNAL,
      spec: {
        ...EXTERNAL.spec,
        data: [{ secretKey: 'apiKey', remoteRef: { key: 'payments/gateway', property: 'apiKey' } }],
      },
    }]);
    const token = w.bao!.issueToken('root');
    await w.run(
      `BAO_ADDR=https://openbao.corp.internal:8200 BAO_TOKEN=${token} `
      + 'bao kv put kv/payments/gateway apiKey=abc123'
    );
    await w.cluster.advanceBy(DEFAULT_REFRESH_MS);
    expect(decode((secretOf(w) as any).data.apiKey)).toBe('abc123');
  });
});
