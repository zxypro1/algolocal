/**
 * 准入
 *
 * 两层，分工不同：
 *  - **PSA** 是内置的，三档写死的标准，靠命名空间标签开关，卸不掉；
 *  - **Kyverno** 是集群里的一个工作负载，写自定义规则，停掉就不生效。
 *
 * 还有一条贯穿两层的事实：PSA 只看 Pod。给 Deployment 打标签拦不住
 * Deployment，它照样被收下，然后控制器建 Pod 时被拦 —— `kubectl get deploy`
 * 显示 0/N，原因藏在 ReplicaSet 的事件里。
 */
import { createOpsWorld } from '../../src/lib/opslab/lab';
import {
  digestOf, matchesPattern, modesOf, psaMessage, signDigest, violationsOf, SignatureStore,
} from '../../src/lib/opslab/admission';
import { encodePrivateKeyPem, publicKeyPem } from '../../src/lib/opslab/crypto/x509';
import { keyFor } from '../../src/lib/opslab/crypto/keys';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';

const APP = 'harbor.corp.internal/team/portal:1.4.0';
const KYVERNO_IMAGE = 'ghcr.io/kyverno/kyverno:v1.16.0';

describe('PodSecurity 的档位', () => {
  const bad = {
    containers: [{ name: 'app', image: APP, securityContext: { privileged: true } }],
    hostNetwork: true,
    volumes: [{ name: 'root', hostPath: { path: '/' } }],
  };

  it('privileged 什么都不管', () => {
    expect(violationsOf(bad, 'privileged')).toEqual([]);
  });

  it('baseline 挡住特权、host 命名空间与 hostPath', () => {
    const violations = violationsOf(bad, 'baseline').join(' ');
    expect(violations).toContain('privileged');
    expect(violations).toContain('hostNetwork=true');
    expect(violations).toContain('hostPath volumes');
  });

  it('一个规规矩矩的 Pod 过 baseline 但过不了 restricted', () => {
    const plain = { containers: [{ name: 'app', image: APP }] };
    expect(violationsOf(plain, 'baseline')).toEqual([]);
    const restricted = violationsOf(plain, 'restricted').join(' ');
    expect(restricted).toContain('allowPrivilegeEscalation != false');
    expect(restricted).toContain('runAsNonRoot != true');
    expect(restricted).toContain('capabilities.drop=["ALL"]');
    expect(restricted).toContain('seccompProfile');
  });

  it('四样都补齐就过 restricted', () => {
    const good = {
      securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{
        name: 'app', image: APP,
        securityContext: {
          allowPrivilegeEscalation: false,
          runAsNonRoot: true,
          capabilities: { drop: ['ALL'] },
        },
      }],
    };
    expect(violationsOf(good, 'restricted')).toEqual([]);
  });

  it('标签决定档位，enforce 与 warn 是两件事', () => {
    expect(modesOf({ metadata: { name: 'x', labels: {} } } as never)).toEqual({ enforce: 'privileged' });
    expect(modesOf({
      metadata: {
        name: 'x',
        labels: {
          'pod-security.kubernetes.io/warn': 'restricted',
          'pod-security.kubernetes.io/enforce': 'baseline',
        },
      },
    } as never)).toMatchObject({ enforce: 'baseline', warn: 'restricted' });
  });

  it('拒绝消息照抄真 PSA', () => {
    expect(psaMessage('restricted', ['runAsNonRoot != true (…)']))
      .toBe('violates PodSecurity "restricted:latest": runAsNonRoot != true (…)');
  });
});

describe('Kyverno 的 pattern 匹配', () => {
  it('* 表示这个字段得有值', () => {
    expect(matchesPattern({ metadata: { labels: { owner: 'pay' } } }, { metadata: { labels: { owner: '?*' } } })).toBe(true);
    expect(matchesPattern({ metadata: { labels: {} } }, { metadata: { labels: { owner: '?*' } } })).toBe(false);
  });

  it('! 表示不能等于', () => {
    expect(matchesPattern({ image: 'nginx:1.27' }, { image: '!*:latest' })).toBe(true);
    expect(matchesPattern({ image: 'nginx:latest' }, { image: '!*:latest' })).toBe(false);
  });

  it('| 是或', () => {
    expect(matchesPattern({ tier: 'web' }, { tier: 'web | api' })).toBe(true);
    expect(matchesPattern({ tier: 'db' }, { tier: 'web | api' })).toBe(false);
  });

  it('数组里写一项，表示每一项都要满足', () => {
    const pattern = { containers: [{ image: 'harbor.corp.internal/*' }] };
    expect(matchesPattern({ containers: [{ image: 'harbor.corp.internal/a:1' }, { image: 'harbor.corp.internal/b:2' }] }, pattern)).toBe(true);
    expect(matchesPattern({ containers: [{ image: 'harbor.corp.internal/a:1' }, { image: 'docker.io/b:2' }] }, pattern)).toBe(false);
  });

  it('带 ? 的键是可选的', () => {
    expect(matchesPattern({ spec: {} }, { spec: { 'replicas?': '*' } })).toBe(true);
  });
});

describe('cosign 的签名是真的', () => {
  const key = keyFor('cosign-test');
  const pem = encodePrivateKeyPem(key);
  const pub = publicKeyPem(key);

  it('签一个 digest，用公钥验得过', () => {
    const store = new SignatureStore();
    const digest = digestOf(APP);
    store.add(signDigest(pem, digest)!);
    expect(store.verify(digest, pub)).toBe(true);
  });

  it('换一个 digest 就验不过 —— 签的是内容不是名字', () => {
    const store = new SignatureStore();
    store.add(signDigest(pem, digestOf(APP))!);
    expect(store.verify(digestOf('harbor.corp.internal/team/portal:1.5.0'), pub)).toBe(false);
  });

  it('换一把公钥也验不过', () => {
    const store = new SignatureStore();
    store.add(signDigest(pem, digestOf(APP))!);
    expect(store.verify(digestOf(APP), publicKeyPem(keyFor('someone-else')))).toBe(false);
  });

  it('带 @sha256: 的引用直接用那个 digest', () => {
    const explicit = `harbor.corp.internal/team/portal@sha256:${'a'.repeat(64)}`;
    expect(digestOf(explicit)).toBe(`sha256:${'a'.repeat(64)}`);
  });
});

/* ------------------------------------------------------------------ */
/* 集群里真的被拦住                                                    */
/* ------------------------------------------------------------------ */

const KYVERNO_PLATFORM = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'kyverno', namespace: 'kyverno', labels: { 'app.kubernetes.io/name': 'kyverno' } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'kyverno' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'kyverno' } },
        spec: { containers: [{ name: 'kyverno', image: KYVERNO_IMAGE }] },
      },
    },
  },
];

function spec(options: { objects?: unknown[]; nsLabels?: Record<string, string> } = {}): OpsWorldSpec {
  return {
    namespaces: ['default', 'kyverno'],
    images: {
      [APP]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [KYVERNO_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
    },
    objects: [
      {
        apiVersion: 'v1', kind: 'Namespace',
        metadata: { name: 'shop', labels: options.nsLabels ?? {} },
        status: { phase: 'Active' },
      },
      ...(options.objects ?? []),
    ] as never,
  };
}

const POD = {
  apiVersion: 'v1', kind: 'Pod',
  metadata: { name: 'probe', namespace: 'shop' },
  spec: { containers: [{ name: 'app', image: APP }] },
};

async function build(options: Parameters<typeof spec>[0] = {}) {
  return createOpsWorld({ world: spec(options) });
}

const PODS = { group: '', version: 'v1', resource: 'pods' } as const;

describe('PSA 在集群里真的拦', () => {
  it('没打标签的命名空间什么都收', async () => {
    const w = await build();
    expect(() => w.cluster.registry.create(w.cluster.scheme.mustGet(PODS), 'shop', POD as never)).not.toThrow();
  });

  it('restricted 之下普通 Pod 被拒，报的话能照着改', async () => {
    const w = await build({ nsLabels: { 'pod-security.kubernetes.io/enforce': 'restricted' } });
    expect(() => w.cluster.registry.create(w.cluster.scheme.mustGet(PODS), 'shop', POD as never))
      .toThrow(/violates PodSecurity "restricted:latest"/);
  });

  it('只打 warn 标签拦不住 —— 这是最常见的误会', async () => {
    const w = await build({ nsLabels: { 'pod-security.kubernetes.io/warn': 'restricted' } });
    expect(() => w.cluster.registry.create(w.cluster.scheme.mustGet(PODS), 'shop', POD as never)).not.toThrow();
  });

  it('Deployment 本身收得下，Pod 起不来，原因在 ReplicaSet 的事件里', async () => {
    const w = await build({
      nsLabels: { 'pod-security.kubernetes.io/enforce': 'restricted' },
      objects: [{
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: 'portal', namespace: 'shop' },
        spec: {
          replicas: 2,
          selector: { matchLabels: { app: 'portal' } },
          template: {
            metadata: { labels: { app: 'portal' } },
            spec: { containers: [{ name: 'app', image: APP }] },
          },
        },
      }],
    });
    const pods = w.cluster.registry.list(w.cluster.scheme.mustGet(PODS), { namespace: 'shop' });
    expect(pods.items).toHaveLength(0);

    const events = w.cluster.registry.list(
      w.cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'events' }), { namespace: 'shop' }
    ).items;
    const failure = events.find((event) => (event as any).reason === 'FailedCreate');
    expect(failure).toBeTruthy();
    expect((failure as any).message).toContain('violates PodSecurity');
  });
});

describe('Kyverno 在集群里真的拦', () => {
  const REQUIRE_OWNER = {
    apiVersion: 'kyverno.io/v1', kind: 'ClusterPolicy',
    metadata: { name: 'require-owner' },
    spec: {
      validationFailureAction: 'Enforce',
      rules: [{
        name: 'owner-label',
        match: { any: [{ resources: { kinds: ['Pod'], namespaces: ['shop'] } }] },
        validate: {
          message: 'every pod must carry an owner label',
          pattern: { metadata: { labels: { owner: '?*' } } },
        },
      }],
    },
  };

  it('控制面在，策略生效', async () => {
    const w = await build({ objects: [...KYVERNO_PLATFORM, REQUIRE_OWNER] });
    expect(() => w.cluster.registry.create(w.cluster.scheme.mustGet(PODS), 'shop', POD as never))
      .toThrow(/every pod must carry an owner label/);
  });

  it('控制面不在，同一条策略一点用都没有', async () => {
    const w = await build({ objects: [REQUIRE_OWNER] });
    expect(() => w.cluster.registry.create(w.cluster.scheme.mustGet(PODS), 'shop', POD as never)).not.toThrow();
  });

  it('带 owner 标签就放行', async () => {
    const w = await build({ objects: [...KYVERNO_PLATFORM, REQUIRE_OWNER] });
    const ok = { ...POD, metadata: { ...POD.metadata, labels: { owner: 'payments' } } };
    expect(() => w.cluster.registry.create(w.cluster.scheme.mustGet(PODS), 'shop', ok as never)).not.toThrow();
  });

  it('Audit 只警告不拦', async () => {
    const audit = {
      ...REQUIRE_OWNER,
      spec: { ...REQUIRE_OWNER.spec, validationFailureAction: 'Audit' },
    };
    const w = await build({ objects: [...KYVERNO_PLATFORM, audit] });
    expect(() => w.cluster.registry.create(w.cluster.scheme.mustGet(PODS), 'shop', POD as never)).not.toThrow();
  });

  it('CEL 表达式真的被求值', async () => {
    const policy = {
      apiVersion: 'kyverno.io/v1', kind: 'ClusterPolicy',
      metadata: { name: 'small-only' },
      spec: {
        rules: [{
          name: 'replicas',
          match: { any: [{ resources: { kinds: ['Deployment'] } }] },
          validate: {
            cel: {
              expressions: [{
                expression: 'object.spec.replicas <= 3',
                message: 'at most 3 replicas outside production',
              }],
            },
          },
        }],
      },
    };
    const w = await build({ objects: [...KYVERNO_PLATFORM, policy] });
    const deployment = (replicas: number) => ({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: `d${replicas}`, namespace: 'shop' },
      spec: {
        replicas,
        selector: { matchLabels: { app: 'x' } },
        template: { metadata: { labels: { app: 'x' } }, spec: { containers: [{ name: 'a', image: APP }] } },
      },
    });
    const deployments = w.cluster.scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' });
    expect(() => w.cluster.registry.create(deployments, 'shop', deployment(2) as never)).not.toThrow();
    expect(() => w.cluster.registry.create(deployments, 'shop', deployment(9) as never))
      .toThrow(/at most 3 replicas outside production/);
  });

  it('exclude 命中的资源不适用', async () => {
    const policy = {
      ...REQUIRE_OWNER,
      spec: {
        ...REQUIRE_OWNER.spec,
        rules: [{
          ...REQUIRE_OWNER.spec.rules[0],
          exclude: { any: [{ resources: { namespaces: ['shop'] } }] },
        }],
      },
    };
    const w = await build({ objects: [...KYVERNO_PLATFORM, policy] });
    expect(() => w.cluster.registry.create(w.cluster.scheme.mustGet(PODS), 'shop', POD as never)).not.toThrow();
  });
});

describe('cosign 命令', () => {
  it('生成密钥、签、验，一条龙', async () => {
    const w = await createOpsWorld({
      world: {
        namespaces: ['default'],
        images: { [APP]: {} },
        registries: [{ host: 'harbor.corp.internal', anonymousPull: true, projects: ['team'] }],
      } as never,
    });
    expect((await w.run('cosign generate-key-pair')).stderr).toContain('cosign.pub');
    expect(w.machine.vfs.readFile('/root/cosign.pub')).toContain('BEGIN PUBLIC KEY');

    const signed = await w.run(`cosign sign --key cosign.key ${APP}`);
    expect(signed.code).toBe(0);

    const verified = await w.run(`cosign verify --key cosign.pub ${APP}`);
    expect(verified.code).toBe(0);
    expect(verified.stderr).toContain('The signatures were verified against the specified public key');
  });

  it('没签过的镜像验不过', async () => {
    const w = await createOpsWorld({
      world: {
        namespaces: ['default'],
        images: { [APP]: {} },
        registries: [{ host: 'harbor.corp.internal', anonymousPull: true, projects: ['team'] }],
      } as never,
    });
    await w.run('cosign generate-key-pair');
    const result = await w.run(`cosign verify --key cosign.pub ${APP}`);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no matching signatures');
  });
});
