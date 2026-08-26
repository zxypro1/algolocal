/**
 * 渐进式发布
 *
 * Deployment 的滚动更新只关心「新的起来了没有」，不关心「新的好不好」。
 * Rollout 把发布过程写成 steps，并在分析失败时**自动回到稳定版本**。
 *
 * 这一组要钉住的：状态机一步一步走、不带 duration 的 pause 会一直停、
 * 分析失败会中止并回滚、以及中止不是「停在原地」。
 */
import { NO_DATA_GRACE_MS, checkCondition } from '../../src/lib/opslab/rollouts';
import { buildTopology, createOpsWorld } from '../../src/lib/opslab/lab';
import { SCRAPE_INTERVAL_MS } from '../../src/lib/opslab/observability';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';
import { printerFor, type KubeObject } from '../../src/lib/opslab/apiserver';

describe('successCondition', () => {
  it('一元比较', () => {
    expect(checkCondition('result < 0.05', 0.01)).toBe(true);
    expect(checkCondition('result < 0.05', 0.2)).toBe(false);
    expect(checkCondition('result >= 0.99', 0.99)).toBe(true);
  });

  it('不写就是通过', () => {
    expect(checkCondition(undefined, 42)).toBe(true);
  });

  it('看不懂的条件按失败算 —— 静默通过比明确失败危险', () => {
    expect(checkCondition('result matches /ok/', 1)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

const GOOD = 'harbor.corp.internal/team/portal:1.4.0';
const BAD = 'harbor.corp.internal/team/portal:1.5.0-bad';
const PROM_IMAGE = 'quay.io/prometheus/prometheus:v3.9.1';
const ROLLOUTS_IMAGE = 'quay.io/argoproj/argo-rollouts:v1.8.3';

const PLATFORM = [
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'monitoring' }, status: { phase: 'Active' } },
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'prometheus', namespace: 'monitoring', labels: { 'app.kubernetes.io/name': 'prometheus' } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'prometheus' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'prometheus' } },
        spec: { containers: [{ name: 'prometheus', image: PROM_IMAGE }] },
      },
    },
  },
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'argo-rollouts', namespace: 'monitoring', labels: { 'app.kubernetes.io/name': 'argo-rollouts' } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'argo-rollouts' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'argo-rollouts' } },
        spec: { containers: [{ name: 'controller', image: ROLLOUTS_IMAGE }] },
      },
    },
  },
];

const TEMPLATE = {
  apiVersion: 'argoproj.io/v1alpha1', kind: 'AnalysisTemplate',
  metadata: { name: 'error-rate', namespace: 'shop' },
  spec: {
    metrics: [{
      name: 'error-rate',
      // 先等一分钟再量：金丝雀刚起来的时候算出来的是稳定版的错误率
      initialDelay: '1m',
      successCondition: 'result < 0.05',
      provider: {
        prometheus: {
          query: 'sum(rate(http_requests_total{code=~"5.."}[5m]))'
            + ' / sum(rate(http_requests_total[5m]))',
        },
      },
    }],
  },
};

/** 判据引用一个根本不存在的指标：这条查询永远查不到数 */
const TEMPLATE_NO_DATA = {
  apiVersion: 'argoproj.io/v1alpha1', kind: 'AnalysisTemplate',
  metadata: { name: 'no-data', namespace: 'shop' },
  spec: {
    metrics: [{
      name: 'error-rate',
      successCondition: 'result < 0.05',
      provider: { prometheus: { query: 'sum(rate(nothing_here_total[5m]))' } },
    }],
  },
};

const MONITOR = {
  apiVersion: 'monitoring.coreos.com/v1', kind: 'ServiceMonitor',
  metadata: { name: 'portal', namespace: 'shop' },
  spec: { selector: { matchLabels: { app: 'portal' } } },
};

const SERVICE = {
  apiVersion: 'v1', kind: 'Service',
  metadata: { name: 'portal', namespace: 'shop', labels: { app: 'portal' } },
  spec: { selector: { app: 'portal' }, ports: [{ port: 80, targetPort: 8080 }] },
};

function rollout(image: string, steps: unknown[]) {
  return {
    apiVersion: 'argoproj.io/v1alpha1', kind: 'Rollout',
    metadata: { name: 'portal', namespace: 'shop' },
    spec: {
      replicas: 4,
      selector: { matchLabels: { app: 'portal' } },
      strategy: { canary: { steps } },
      template: {
        metadata: { labels: { app: 'portal' } },
        spec: { containers: [{ name: 'web', image, ports: [{ containerPort: 8080 }] }] },
      },
    },
  };
}

const STEPS = [
  { setWeight: 25 },
  { analysis: { templates: [{ templateName: 'error-rate' }] } },
  { setWeight: 50 },
];

function spec(objects: unknown[]): OpsWorldSpec {
  return {
    namespaces: ['default', 'shop'],
    images: {
      [GOOD]: { pullMs: 10, startupMs: 10, readyAfterMs: 10, requestsPerSecond: 20, errorRatio: 0 },
      // 好版本的几个后续 tag。不声明的话拉不到镜像，Pod 起不来，
      // 会被误读成「金丝雀卡住了」
      ...Object.fromEntries(['1.4.1', '1.4.2', '1.4.3', '1.4.4', '1.4.5', '1.4.6'].map((tag) => [
        `harbor.corp.internal/team/portal:${tag}`,
        { pullMs: 10, startupMs: 10, readyAfterMs: 10, requestsPerSecond: 20, errorRatio: 0 },
      ])),
      [BAD]: { pullMs: 10, startupMs: 10, readyAfterMs: 10, requestsPerSecond: 20, errorRatio: 0.4 },
      [PROM_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      [ROLLOUTS_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
    },
    objects: objects as never,
  };
}

const ROLLOUTS = { group: 'argoproj.io', version: 'v1alpha1', resource: 'rollouts' } as const;
const REPLICASETS = { group: 'apps', version: 'v1', resource: 'replicasets' } as const;
const RUNS = { group: 'argoproj.io', version: 'v1alpha1', resource: 'analysisruns' } as const;

async function build(objects: unknown[]) {
  const world = await createOpsWorld({ world: spec(objects) });
  await world.cluster.advanceBy(SCRAPE_INTERVAL_MS * 40);
  return world;
}

const statusOf = (w: Awaited<ReturnType<typeof build>>) =>
  (w.cluster.registry.get(w.cluster.scheme.mustGet(ROLLOUTS), 'shop', 'portal').status ?? {}) as any;

const replicasOf = (w: Awaited<ReturnType<typeof build>>) =>
  w.cluster.registry.list(w.cluster.scheme.mustGet(REPLICASETS), { namespace: 'shop' }).items
    .map((rs) => [(rs.spec as any).template.spec.containers[0].image, (rs.spec as any).replicas] as const);

async function updateImage(
  w: Awaited<ReturnType<typeof build>>,
  image: string,
  advanceMs = SCRAPE_INTERVAL_MS * 60
) {
  const definition = w.cluster.scheme.mustGet(ROLLOUTS);
  const live = w.cluster.registry.get(definition, 'shop', 'portal');
  const spec = JSON.parse(JSON.stringify(live.spec)) as any;
  spec.template.spec.containers[0].image = image;
  w.cluster.registry.update(definition, 'shop', 'portal', { ...live, spec } as KubeObject);
  await w.cluster.advanceBy(advanceMs);
}

describe('金丝雀', () => {
  it('第一次创建直接拉满，不走金丝雀', async () => {
    const w = await build([...PLATFORM, SERVICE, MONITOR, TEMPLATE, rollout(GOOD, STEPS)]);
    const status = statusOf(w);
    expect(status.phase).toBe('Healthy');
    expect(replicasOf(w)).toEqual([[GOOD, 4]]);
  });

  it('控制器不在时 Rollout 就只是一个对象', async () => {
    const w = await build([SERVICE, MONITOR, TEMPLATE, rollout(GOOD, STEPS)]);
    expect(statusOf(w).phase).toBeUndefined();
    expect(replicasOf(w)).toEqual([]);
  });

  it('好版本走完所有步骤，金丝雀转正、旧的缩到 0', async () => {
    const w = await build([...PLATFORM, SERVICE, MONITOR, TEMPLATE, rollout(GOOD, STEPS)]);
    await updateImage(w, 'harbor.corp.internal/team/portal:1.4.1');

    const status = statusOf(w);
    expect(status.phase).toBe('Healthy');
    const replicas = Object.fromEntries(replicasOf(w));
    expect(replicas['harbor.corp.internal/team/portal:1.4.1']).toBe(4);
    expect(replicas[GOOD]).toBe(0);
  });

  it('坏版本在分析那一步被拦下，自动回到稳定版', async () => {
    const w = await build([...PLATFORM, SERVICE, MONITOR, TEMPLATE, rollout(GOOD, STEPS)]);
    await updateImage(w, BAD);

    const status = statusOf(w);
    expect(status.phase).toBe('Degraded');
    expect(status.abort).toBe(true);
    expect(status.message).toContain('analysis at step 1 failed');

    // 中止 = 回到稳定版，不是停在原地
    const replicas = Object.fromEntries(replicasOf(w));
    expect(replicas[BAD]).toBe(0);
    expect(replicas[GOOD]).toBe(4);
  });

  it('分析的结果留在 AnalysisRun 里，能看出是哪条指标没过', async () => {
    const w = await build([...PLATFORM, SERVICE, MONITOR, TEMPLATE, rollout(GOOD, STEPS)]);
    await updateImage(w, BAD);
    const runs = w.cluster.registry.list(w.cluster.scheme.mustGet(RUNS), { namespace: 'shop' }).items;
    expect(runs.length).toBeGreaterThan(0);
    const status = (runs[0].status ?? {}) as any;
    expect(status.phase).toBe('Failed');
    expect(status.metricResults[0]).toMatchObject({ name: 'error-rate', phase: 'Failed' });
    expect(status.metricResults[0].value).toBeGreaterThan(0.05);
  });

  it('不带 duration 的 pause 会一直停着，等人 promote', async () => {
    const steps = [{ setWeight: 25 }, { pause: {} }, { setWeight: 100 }];
    const w = await build([...PLATFORM, SERVICE, MONITOR, TEMPLATE, rollout(GOOD, steps)]);
    await updateImage(w, 'harbor.corp.internal/team/portal:1.4.2', 60_000);

    expect(statusOf(w).phase).toBe('Paused');
    // 再等多久都不会自己往下走
    await w.cluster.advanceBy(60 * 60_000);
    expect(statusOf(w).phase).toBe('Paused');
    expect(statusOf(w).currentStepIndex).toBe(1);
  });

  it('带 duration 的 pause 到点自己继续', async () => {
    const steps = [{ setWeight: 25 }, { pause: { duration: '5m' } }, { setWeight: 100 }];
    const w = await build([...PLATFORM, SERVICE, MONITOR, TEMPLATE, rollout(GOOD, steps)]);
    // 只推一分钟：pause 是 5m，这时候应该还停着
    await updateImage(w, 'harbor.corp.internal/team/portal:1.4.3', 60_000);
    expect(statusOf(w).phase).toBe('Paused');

    await w.cluster.advanceBy(6 * 60_000);
    expect(statusOf(w).phase).toBe('Healthy');
  });

  /**
   * 计数跨两个 ReplicaSet。
   *
   * 金丝雀期间副本分在新旧两边，只数一边的话 `kubectl get rollout` 的
   * CURRENT 会突然掉一截，看着像丢了副本。UP-TO-DATE 才是只数新那边的列。
   */
  it('金丝雀期间 CURRENT 数两边，UP-TO-DATE 只数新的', async () => {
    const steps = [{ setWeight: 25 }, { pause: {} }, { setWeight: 100 }];
    const w = await build([...PLATFORM, SERVICE, MONITOR, TEMPLATE, rollout(GOOD, steps)]);
    await updateImage(w, 'harbor.corp.internal/team/portal:1.4.5');

    const status = statusOf(w);
    expect(status.phase).toBe('Paused');
    expect(status.replicas).toBe(4);
    expect(status.availableReplicas).toBe(4);
    expect(status.updatedReplicas).toBe(1);

    // `kubectl get rollout` 打出来的就是这五列，和 Argo 的 CRD 一致
    const printer = printerFor('rollouts');
    const live = w.cluster.registry.get(w.cluster.scheme.mustGet(ROLLOUTS), 'shop', 'portal');
    expect(printer.columns.map((column) => column.name))
      .toEqual(['Name', 'Desired', 'Current', 'Up-to-date', 'Available', 'Age']);
    expect(printer.cells(live, '10m')).toEqual(['portal', '4', '4', '1', '4', '10m']);
  });

  it('拓扑图上 Rollout 站在工作负载那一排，并且说得出停在哪一步', async () => {
    const steps = [{ setWeight: 25 }, { pause: {} }, { setWeight: 100 }];
    const w = await build([...PLATFORM, SERVICE, MONITOR, TEMPLATE, rollout(GOOD, steps)]);
    await updateImage(w, 'harbor.corp.internal/team/portal:1.4.5');

    const graph = buildTopology(w.cluster, { namespace: 'shop' });
    const node = graph.nodes.find((item) => item.kind === 'Rollout');
    expect(node).toBeDefined();
    expect(node!.detail).toContain('Paused');
    // 属主链要接得上：Rollout -> ReplicaSet -> Pod
    expect(graph.edges.some((edge) => edge.from === node!.id && edge.kind === 'owns')).toBe(true);
  });

  /**
   * 查不到数不等于通过。
   *
   * 一条永远查不到数的判据等于没有判据。先等（指标可能只是还没攒够点），
   * 等够宽限期还是没有，就明确判失败 —— 静默放行比失败危险得多。
   */
  it('查不到数先等，等够宽限期还是没有就判失败', async () => {
    const steps = [
      { setWeight: 25 },
      { analysis: { templates: [{ templateName: 'no-data' }] } },
      { setWeight: 100 },
    ];
    const w = await build([...PLATFORM, SERVICE, MONITOR, TEMPLATE_NO_DATA, rollout(GOOD, steps)]);
    await updateImage(w, 'harbor.corp.internal/team/portal:1.4.6', 60_000);
    // 还在宽限期内：既没放行，也没判死
    expect(statusOf(w).abort).toBeFalsy();
    expect(statusOf(w).currentStepIndex).toBe(1);

    await w.cluster.advanceBy(NO_DATA_GRACE_MS + 60_000);
    expect(statusOf(w).abort).toBe(true);
    const runs = w.cluster.registry.list(w.cluster.scheme.mustGet(RUNS), { namespace: 'shop' }).items;
    expect(runs.some((run) => (run.status as any)?.phase === 'Failed')).toBe(true);
  });

  it('AnalysisTemplate 找不到时按失败处理，不静默放行', async () => {
    const steps = [{ analysis: { templates: [{ templateName: 'nope' }] } }];
    const w = await build([...PLATFORM, SERVICE, MONITOR, rollout(GOOD, steps)]);
    await updateImage(w, 'harbor.corp.internal/team/portal:1.4.4');
    expect(statusOf(w).abort).toBe(true);
  });
});
