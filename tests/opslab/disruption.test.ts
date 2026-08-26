/**
 * PDB 与驱逐
 *
 * PDB 管的是**自愿中断**。它管不了节点掉电、OOMKill 这类非自愿中断 ——
 * 很多人以为配了 PDB 就「不会少于 N 个副本」，其实它只是让主动发起的中断
 * 被拒绝。
 *
 * 另一条：`kubectl drain` 走 eviction 子资源会先问 PDB，
 * `kubectl delete pod` 走 delete，谁也拦不住。
 */
import { desiredHealthyOf, evaluatePdb, evictionVerdict } from '../../src/lib/opslab/disruption';
import { createOpsWorld } from '../../src/lib/opslab/lab';
import type { KubeObject } from '../../src/lib/opslab/apiserver';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';

const pod = (name: string, ready: boolean): KubeObject => ({
  apiVersion: 'v1', kind: 'Pod',
  metadata: { name, namespace: 'shop', labels: { app: 'portal' } },
  status: { phase: 'Running', conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
} as never);

const budget = (spec: Record<string, unknown>): KubeObject => ({
  apiVersion: 'policy/v1', kind: 'PodDisruptionBudget',
  metadata: { name: 'portal', namespace: 'shop' },
  spec: { selector: { matchLabels: { app: 'portal' } }, ...spec },
} as never);

describe('算「还能中断几个」', () => {
  it('minAvailable 是绝对数', () => {
    const pods = [pod('a', true), pod('b', true), pod('c', true)];
    expect(evaluatePdb(budget({ minAvailable: 2 }), pods)).toMatchObject({
      currentHealthy: 3, desiredHealthy: 2, disruptionsAllowed: 1,
    });
  });

  it('maxUnavailable 换算成「至少活着几个」', () => {
    const pods = [pod('a', true), pod('b', true), pod('c', true)];
    expect(evaluatePdb(budget({ maxUnavailable: 1 }), pods).disruptionsAllowed).toBe(1);
  });

  it('百分比：minAvailable 向上取整，maxUnavailable 向下取整', () => {
    expect(desiredHealthyOf({ minAvailable: '50%' }, 3)).toBe(2);
    expect(desiredHealthyOf({ maxUnavailable: '50%' }, 3)).toBe(2);
  });

  it('没 Ready 的不算数 —— 正在启动的那个抵不了数', () => {
    const pods = [pod('a', true), pod('b', false), pod('c', true)];
    expect(evaluatePdb(budget({ minAvailable: 2 }), pods)).toMatchObject({
      currentHealthy: 2, disruptionsAllowed: 0,
    });
  });

  it('两个都不写的 PDB 什么都不拦', () => {
    expect(desiredHealthyOf({}, 5)).toBe(0);
  });
});

describe('驱逐的判断', () => {
  it('预算还有余量就放行', () => {
    const pods = [pod('a', true), pod('b', true), pod('c', true)];
    expect(evictionVerdict(pods[0], [budget({ minAvailable: 2 })], pods)).toEqual({ allowed: true });
  });

  it('刚好卡在下限就拒，消息照抄真 apiserver', () => {
    const pods = [pod('a', true), pod('b', true)];
    const verdict = evictionVerdict(pods[0], [budget({ minAvailable: 2 })], pods);
    expect(verdict).toMatchObject({
      allowed: false,
      message: "Cannot evict pod as it would violate the pod's disruption budget.",
      pdb: 'shop/portal',
    });
  });

  it('选不中这个 Pod 的 PDB 不管它', () => {
    const pods = [pod('a', true)];
    const other = budget({ minAvailable: 5, selector: { matchLabels: { app: 'other' } } });
    expect(evictionVerdict(pods[0], [other], pods)).toEqual({ allowed: true });
  });
});

/* ------------------------------------------------------------------ */
/* 集群里                                                              */
/* ------------------------------------------------------------------ */

const APP = 'harbor.corp.internal/team/portal:1.4.0';

function spec(minAvailable: number): OpsWorldSpec {
  return {
    namespaces: ['default', 'shop'],
    images: { [APP]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 } },
    objects: [
      {
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name: 'portal', namespace: 'shop' },
        spec: {
          replicas: 3,
          selector: { matchLabels: { app: 'portal' } },
          template: {
            metadata: { labels: { app: 'portal' } },
            spec: { containers: [{ name: 'web', image: APP }] },
          },
        },
      },
      {
        apiVersion: 'policy/v1', kind: 'PodDisruptionBudget',
        metadata: { name: 'portal', namespace: 'shop' },
        spec: { minAvailable, selector: { matchLabels: { app: 'portal' } } },
      },
    ] as never,
  };
}

const PODS = { group: '', version: 'v1', resource: 'pods' } as const;
const PDBS = { group: 'policy', version: 'v1', resource: 'poddisruptionbudgets' } as const;

describe('集群里的 PDB', () => {
  it('status 里写着还能中断几个', async () => {
    const w = await createOpsWorld({ world: spec(2) });
    const pdb = w.cluster.registry.get(w.cluster.scheme.mustGet(PDBS), 'shop', 'portal');
    expect((pdb.status as any)).toMatchObject({
      currentHealthy: 3, desiredHealthy: 2, disruptionsAllowed: 1,
    });
  });

  it('预算用满时驱逐被 429 拒掉', async () => {
    const w = await createOpsWorld({ world: spec(3) });
    const name = w.cluster.registry.list(w.cluster.scheme.mustGet(PODS), { namespace: 'shop' })
      .items[0].metadata.name;
    const response = await w.cluster.apiServer.handle(
      `/api/v1/namespaces/shop/pods/${name}/eviction`,
      { method: 'POST', body: '{}' } as never
    );
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.message).toBe("Cannot evict pod as it would violate the pod's disruption budget.");
    expect(body.details.causes[0].message).toContain('shop/portal');
  });

  it('有余量时驱逐真的把 Pod 删了', async () => {
    const w = await createOpsWorld({ world: spec(2) });
    const definition = w.cluster.scheme.mustGet(PODS);
    const name = w.cluster.registry.list(definition, { namespace: 'shop' }).items[0].metadata.name;
    const response = await w.cluster.apiServer.handle(
      `/api/v1/namespaces/shop/pods/${name}/eviction`,
      { method: 'POST', body: '{}' } as never
    );
    expect(response.status).toBe(201);
    expect(w.cluster.registry.list(definition, { namespace: 'shop' }).items
      .some((item) => item.metadata.name === name)).toBe(false);
  });

  it('delete 不问 PDB —— 这就是它和 drain 的区别', async () => {
    const w = await createOpsWorld({ world: spec(3) });
    const definition = w.cluster.scheme.mustGet(PODS);
    const name = w.cluster.registry.list(definition, { namespace: 'shop' }).items[0].metadata.name!;
    expect(() => w.cluster.registry.delete(definition, 'shop', name)).not.toThrow();
  });
});
