/**
 * 可观测性
 *
 * 两条贯穿始终的事实：
 *  1. **采集是定时拉的** —— 两次采样之间发生的事看不见；
 *  2. **告警是对表达式定时求值** —— 表达式写错了不会报错，只是永不触发。
 *
 * 这一组把 PromQL 的语义、采集目标的选择、以及 `for` 的行为逐条钉住。
 */
import { Tsdb, evaluate, counterDelta, parseDuration, targetsOf, PromqlError } from '../../src/lib/opslab/observability';
import type { KubeObject } from '../../src/lib/opslab/apiserver';

const T = (minutes: number) => minutes * 60_000;

function bench() {
  const tsdb = new Tsdb();
  // 两个 Pod，一个健康一个挂了
  for (let i = 0; i <= 10; i += 1) {
    tsdb.append('up', { job: 'shop/portal', pod: 'portal-a' }, T(i), 1);
    tsdb.append('up', { job: 'shop/portal', pod: 'portal-b' }, T(i), i < 5 ? 1 : 0);
    tsdb.append('http_requests_total', { job: 'shop/portal', pod: 'portal-a', code: '200' }, T(i), i * 600);
    tsdb.append('http_requests_total', { job: 'shop/portal', pod: 'portal-a', code: '500' }, T(i), i * 6);
  }
  return tsdb;
}

describe('时序库', () => {
  it('同名不同标签是两条序列', () => {
    const tsdb = bench();
    expect(tsdb.select('up')).toHaveLength(2);
    expect(tsdb.select('up', [{ label: 'pod', op: '=', value: 'portal-a' }])).toHaveLength(1);
  });

  it('正则匹配是完全匹配，不是搜索', () => {
    const tsdb = new Tsdb();
    tsdb.append('x', { code: '500' }, 0, 1);
    tsdb.append('x', { code: '1500' }, 0, 1);
    expect(tsdb.select('x', [{ label: 'code', op: '=~', value: '5..' }])).toHaveLength(1);
  });

  it('超过回看窗口就当作没有数据 —— 目标挂了指标还会留五分钟', () => {
    const tsdb = new Tsdb();
    tsdb.append('up', { pod: 'a' }, T(0), 1);
    const series = tsdb.select('up')[0];
    expect(tsdb.valueAt(series, T(4))).toBe(1);
    expect(tsdb.valueAt(series, T(6))).toBeUndefined();
  });
});

describe('PromQL', () => {
  const at = T(10);

  it('选择器加比较：== 是过滤，不是求布尔值', () => {
    const tsdb = bench();
    const down = evaluate(tsdb, 'up{job="shop/portal"} == 0', at);
    expect(down).toHaveLength(1);
    expect(down[0].labels.pod).toBe('portal-b');
    expect(down[0].value).toBe(0);
  });

  it('rate 算的是每秒增量', () => {
    const tsdb = bench();
    // 每分钟涨 600，也就是每秒 10
    const result = evaluate(tsdb, 'rate(http_requests_total{code="200"}[5m])', at);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBeCloseTo(10, 5);
  });

  it('counter 归零会被补偿，不会算出负数或假尖峰', () => {
    expect(counterDelta([{ at: 0, value: 100 }, { at: 1, value: 120 }])).toBe(20);
    // 中途重启：120 -> 5，涨的是 5 不是 -115
    expect(counterDelta([{ at: 0, value: 120 }, { at: 1, value: 5 }, { at: 2, value: 25 }])).toBe(25);
  });

  it('sum by 分组', () => {
    const tsdb = bench();
    const result = evaluate(tsdb, 'sum(rate(http_requests_total[5m])) by (job)', at);
    expect(result).toHaveLength(1);
    expect(result[0].labels).toEqual({ job: 'shop/portal' });
    expect(result[0].value).toBeCloseTo(10.1, 5);
  });

  it('错误率：两个向量相除，按标签配对', () => {
    const tsdb = bench();
    const result = evaluate(
      tsdb,
      'sum(rate(http_requests_total{code="500"}[5m])) by (job)'
      + ' / sum(rate(http_requests_total[5m])) by (job)',
      at
    );
    expect(result[0].value).toBeCloseTo(0.1 / 10.1, 6);
  });

  it('两边标签配不上时返回空 —— 这是 a / b 突然没结果的原因', () => {
    const tsdb = new Tsdb();
    tsdb.append('a', { job: 'x', pod: 'p' }, 0, 10);
    tsdb.append('b', { job: 'x' }, 0, 2);
    expect(evaluate(tsdb, 'a / b', 0)).toEqual([]);
    // 先聚合掉多余的标签就能配上了
    expect(evaluate(tsdb, 'sum(a) by (job) / sum(b) by (job)', 0)[0].value).toBe(5);
  });

  it('标量参与运算时广播', () => {
    const tsdb = bench();
    const result = evaluate(tsdb, '100 * rate(http_requests_total{code="500"}[5m])', at);
    expect(result[0].value).toBeCloseTo(10, 5);
  });

  it('range vector 不能直接当结果', () => {
    const tsdb = bench();
    expect(() => evaluate(tsdb, 'http_requests_total[5m]', at)).toThrow(PromqlError);
  });

  it('语法错会抛，而不是静默返回空', () => {
    const tsdb = bench();
    expect(() => evaluate(tsdb, 'sum(rate(x[5m])', at)).toThrow(PromqlError);
    expect(() => evaluate(tsdb, 'rate(up)', at)).toThrow(/带时间窗/);
  });

  it('时间单位', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(() => parseDuration('5 minutes')).toThrow(PromqlError);
  });
});

describe('采集目标', () => {
  const monitor = (labels: Record<string, string>, selector: Record<string, string>): KubeObject => ({
    apiVersion: 'monitoring.coreos.com/v1', kind: 'ServiceMonitor',
    metadata: { name: 'portal', namespace: 'shop', labels },
    spec: { selector: { matchLabels: selector } },
  } as never);

  const view = (options: { monitorLabels?: Record<string, string>; promSelector?: Record<string, string> } = {}) => ({
    serviceMonitors: () => [monitor(options.monitorLabels ?? {}, { app: 'portal' })],
    services: () => [{
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: 'portal', namespace: 'shop', labels: { app: 'portal' } },
      spec: { selector: { app: 'portal' } },
    } as never],
    pods: () => [
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'portal-a', namespace: 'shop', labels: { app: 'portal' } }, status: { phase: 'Running' } } as never,
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'portal-b', namespace: 'shop', labels: { app: 'portal' } }, status: { phase: 'Pending' } } as never,
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'other', namespace: 'shop', labels: { app: 'other' } }, status: { phase: 'Running' } } as never,
    ],
    namespaces: () => [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'shop' } } as never],
    prometheus: () => (options.promSelector
      ? ({
          apiVersion: 'monitoring.coreos.com/v1', kind: 'Prometheus',
          metadata: { name: 'main', namespace: 'monitoring' },
          spec: { serviceMonitorSelector: { matchLabels: options.promSelector } },
        } as never)
      : undefined),
  });

  it('按 Service 的标签选中，再按 Service 的 selector 找 Pod', () => {
    const targets = targetsOf(view());
    expect(targets.map((target) => target.pod)).toEqual(['portal-a', 'portal-b']);
    expect(targets.find((target) => target.pod === 'portal-b')!.up).toBe(false);
  });

  it('Prometheus 自己的 serviceMonitorSelector 对不上就一条都采不到', () => {
    expect(targetsOf(view({ promSelector: { release: 'kube-prom' } }))).toEqual([]);
    expect(targetsOf(view({
      promSelector: { release: 'kube-prom' },
      monitorLabels: { release: 'kube-prom' },
    }))).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* 集群里                                                              */
/* ------------------------------------------------------------------ */

import { createOpsWorld } from '../../src/lib/opslab/lab';
import { SCRAPE_INTERVAL_MS } from '../../src/lib/opslab/observability';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';

const PROM_IMAGE = 'quay.io/prometheus/prometheus:v3.9.1';
const APP = 'harbor.corp.internal/team/portal:1.4.0';

const PROM_PLATFORM = [
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'monitoring' }, status: { phase: 'Active' } },
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'prometheus', namespace: 'monitoring', labels: { 'app.kubernetes.io/name': 'prometheus' } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'prometheus' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'prometheus' } },
        spec: { containers: [{ name: 'prometheus', image: PROM_IMAGE, ports: [{ containerPort: 9090 }] }] },
      },
    },
  },
];

const WORKLOAD = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'portal', namespace: 'shop' },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'portal' } },
      template: {
        metadata: { labels: { app: 'portal' } },
        spec: { containers: [{ name: 'web', image: APP, ports: [{ containerPort: 8080 }] }] },
      },
    },
  },
  {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'portal', namespace: 'shop', labels: { app: 'portal' } },
    spec: { selector: { app: 'portal' }, ports: [{ port: 80, targetPort: 8080 }] },
  },
];

const MONITOR = {
  apiVersion: 'monitoring.coreos.com/v1', kind: 'ServiceMonitor',
  metadata: { name: 'portal', namespace: 'shop' },
  spec: { selector: { matchLabels: { app: 'portal' } }, endpoints: [{ port: 'http' }] },
};

function spec(objects: unknown[], errorRatio = 0): OpsWorldSpec {
  return {
    namespaces: ['default', 'shop'],
    images: {
      [APP]: { pullMs: 10, startupMs: 10, readyAfterMs: 10, requestsPerSecond: 20, errorRatio },
      [PROM_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
    },
    objects: objects as never,
  };
}

async function build(objects: unknown[], errorRatio = 0) {
  const world = await createOpsWorld({ world: spec(objects, errorRatio) });
  // 采几轮，攒出足够算 rate 的点
  await world.cluster.advanceBy(SCRAPE_INTERVAL_MS * 30);
  return world;
}

describe('集群里的监控', () => {
  it('采得到 up，也采得到应用指标', async () => {
    const w = await build([...PROM_PLATFORM, ...WORKLOAD, MONITOR]);
    const tsdb = w.cluster.prometheus!.tsdb;
    expect(tsdb.select('up')).toHaveLength(2);
    expect(tsdb.select('http_requests_total').length).toBeGreaterThan(0);
  });

  it('没有 ServiceMonitor 就什么都采不到', async () => {
    const w = await build([...PROM_PLATFORM, ...WORKLOAD]);
    expect(w.cluster.prometheus!.tsdb.select('up')).toHaveLength(0);
  });

  it('Prometheus 挂了，采集就停了 —— 而 ServiceMonitor 还在', async () => {
    const w = await build([...WORKLOAD, MONITOR]);
    expect(w.cluster.prometheus!.tsdb.size).toBe(0);
    const monitors = w.cluster.registry.list(
      w.cluster.scheme.mustGet({ group: 'monitoring.coreos.com', version: 'v1', resource: 'servicemonitors' }),
      { namespace: 'shop' }
    );
    expect(monitors.items).toHaveLength(1);
  });

  it('告警按 PromQL 求值，for 没满只是 pending', async () => {
    const rule = {
      apiVersion: 'monitoring.coreos.com/v1', kind: 'PrometheusRule',
      metadata: { name: 'portal', namespace: 'shop' },
      spec: {
        groups: [{
          name: 'portal',
          rules: [{
            alert: 'HighErrorRate',
            expr: 'sum(rate(http_requests_total{code="500"}[5m])) by (job)'
              + ' / sum(rate(http_requests_total[5m])) by (job) > 0.05',
            for: '10m',
            labels: { severity: 'critical' },
            annotations: { summary: '{{ $labels.job }} 的错误率是 {{ $value }}' },
          }],
        }],
      },
    };
    const w = await build([...PROM_PLATFORM, ...WORKLOAD, MONITOR, rule], 0.2);
    const prometheus = w.cluster.prometheus!;

    // 才采了几分钟，for 还没满
    const pending = [...prometheus.alerts.values()];
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].state).toBe('pending');
    expect(prometheus.firing()).toHaveLength(0);

    await w.cluster.advanceBy(11 * 60_000);
    const firing = prometheus.firing();
    expect(firing).toHaveLength(1);
    expect(firing[0].name).toBe('HighErrorRate');
    expect(firing[0].labels.severity).toBe('critical');
    expect(firing[0].annotations.summary).toContain('shop/portal 的错误率是');
  });

  it('错误率正常时一条都不触发', async () => {
    const rule = {
      apiVersion: 'monitoring.coreos.com/v1', kind: 'PrometheusRule',
      metadata: { name: 'portal', namespace: 'shop' },
      spec: {
        groups: [{
          name: 'portal',
          rules: [{ alert: 'HighErrorRate', expr: 'sum(rate(http_requests_total{code="500"}[5m])) > 1' }],
        }],
      },
    };
    const w = await build([...PROM_PLATFORM, ...WORKLOAD, MONITOR, rule], 0);
    await w.cluster.advanceBy(20 * 60_000);
    expect(w.cluster.prometheus!.firing()).toHaveLength(0);
  });

  it('promtool 查得到，地址不对时说 no such host', async () => {
    const w = await build([...PROM_PLATFORM, ...WORKLOAD, MONITOR]);
    const good = await w.run("promtool query instant http://localhost:9090 'up'");
    expect(good.code).toBe(0);
    expect(good.stdout).toContain('job="shop/portal"');

    const bad = await w.run("promtool query instant http://nope:9090 'up'");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('no such host');
  });

  it('promtool check rules 认得出写错的表达式', async () => {
    const w = await build([...PROM_PLATFORM]);
    w.machine.vfs.writeFile('/root/rules.yaml', [
      'groups:',
      '- name: portal',
      '  rules:',
      '  - alert: Broken',
      '    expr: sum(rate(x[5m])',
      '  - alert: Fine',
      '    expr: up == 0',
      '',
    ].join('\n'));
    const result = await w.run('promtool check rules /root/rules.yaml');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Broken');
    expect(result.stdout).toContain('could not parse expression');
  });
});
