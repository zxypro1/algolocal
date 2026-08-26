/**
 * Prometheus 这个工作负载
 *
 * 它做三件事，每 15 秒一轮：按 ServiceMonitor 找目标、采一轮指标、
 * 拿 PrometheusRule 里的表达式求值决定告警。
 *
 * 「Prometheus 自己是集群里的一个 Pod」这件事在这里是有后果的：它挂了，
 * 采集停了，而 `kubectl get servicemonitor` 照样列得出来 —— 和 CNI、网格、
 * Kyverno 是同一条约束。更要紧的是**它挂了之后没有任何告警会触发**，
 * 包括「Prometheus 挂了」这一条，所以真集群里总要有另一双眼睛盯着它。
 */
import {
  Controller, ControllerContext, Informer,
} from '../controllers/framework';
import { DEPLOYMENTS, NAMESPACES, PODS, SERVICES } from '../controllers/resources';
import { PROMETHEUSES, PROMETHEUSRULES, PROMETHEUS_LABEL, SERVICEMONITORS } from './resources';
import { targetsOf, type ScrapeTarget } from './scrape';
import { evaluate, parseDuration, PromqlError } from './promql';
import { Tsdb, type Labels } from './tsdb';

/** 默认采集间隔，和 kube-prometheus 一致 */
export const SCRAPE_INTERVAL_MS = 15_000;

export interface Alert {
  name: string;
  labels: Labels;
  annotations: Record<string, string>;
  /** pending 表示条件成立了但还没满 `for` */
  state: 'pending' | 'firing';
  /** 条件从什么时候开始成立 */
  activeAt: number;
  value: number;
}

export interface MetricsSource {
  /** 这一轮每个目标额外贡献哪些指标。集群状态由世界那边算。 */
  sample(target: ScrapeTarget, at: number): Array<{ name: string; labels: Labels; value: number }>;
}

export class PrometheusController extends Controller {
  readonly tsdb = new Tsdb();
  /** 当前处于 pending / firing 的告警，key 是 `<rule>/<labels>` */
  readonly alerts = new Map<string, Alert>();

  private monitors: Informer;
  private rules: Informer;
  private prometheuses: Informer;
  private deployments: Informer;
  private services: Informer;
  private pods: Informer;
  private namespaces: Informer;
  private timer: number;
  private stopped = false;

  constructor(context: ControllerContext, private readonly source: MetricsSource) {
    super(context, 'prometheus');
    this.monitors = this.track(new Informer(this.registry, SERVICEMONITORS));
    this.rules = this.track(new Informer(this.registry, PROMETHEUSRULES));
    this.prometheuses = this.track(new Informer(this.registry, PROMETHEUSES));
    this.deployments = this.track(new Informer(this.registry, DEPLOYMENTS));
    this.services = this.track(new Informer(this.registry, SERVICES));
    this.pods = this.track(new Informer(this.registry, PODS));
    this.namespaces = this.track(new Informer(this.registry, NAMESPACES));

    /**
     * 采集是定时的，不是事件驱动的 —— 这正是「采样之间的事看不见」的来源。
     * 标成 background，否则世界永远静不下来。
     */
    this.timer = this.kernel.setInterval(() => this.scrape(), SCRAPE_INTERVAL_MS, {
      background: true,
      label: 'prometheus:scrape',
    });
  }

  stop(): void {
    this.stopped = true;
    this.kernel.clearTimer(this.timer);
    super.stop();
  }

  /** 这个控制器不按对象 reconcile，一切都在定时的 scrape 里 */
  protected reconcile(): void {}

  private installed(): boolean {
    return this.deployments.list().some((deployment) => {
      if (deployment.metadata.labels?.[PROMETHEUS_LABEL.key] !== PROMETHEUS_LABEL.value) return false;
      return (((deployment.status ?? {}) as { availableReplicas?: number }).availableReplicas ?? 0) > 0;
    });
  }

  /** 采一轮，然后按规则求值 */
  scrape(): void {
    if (this.stopped || !this.installed()) return;
    const at = this.context.now();
    const targets = this.targets();

    for (const target of targets) {
      // `up` 是 Prometheus 自己合成的指标，不来自目标
      this.tsdb.append('up', target.labels, at, target.up ? 1 : 0);
      if (!target.up) continue;
      for (const metric of this.source.sample(target, at)) {
        this.tsdb.append(metric.name, { ...target.labels, ...metric.labels }, at, metric.value);
      }
    }

    this.evaluateRules(at);
  }

  targets(): ScrapeTarget[] {
    return targetsOf({
      serviceMonitors: () => this.monitors.list(),
      services: (namespace) => this.services.list().filter(
        (item) => !namespace || item.metadata.namespace === namespace
      ),
      pods: (namespace) => this.pods.list().filter(
        (item) => !namespace || item.metadata.namespace === namespace
      ),
      namespaces: () => this.namespaces.list(),
      prometheus: () => this.prometheuses.list()[0],
    });
  }

  /**
   * 告警求值。
   *
   * `for` 是这里唯一的状态：条件第一次成立时记下时间，进入 pending；
   * 持续满 `for` 才转成 firing。条件一旦不成立就整条清掉 —— 抖动不会
   * 累积成告警，这正是 `for` 存在的意义。
   */
  private evaluateRules(at: number): void {
    const seen = new Set<string>();
    for (const rule of this.rules.list()) {
      for (const group of ((rule.spec ?? {}) as any).groups ?? []) {
        for (const entry of group.rules ?? []) {
          if (!entry.alert || !entry.expr) continue;
          let results;
          try {
            results = evaluate(this.tsdb, entry.expr, at);
          } catch (error) {
            if (!(error instanceof PromqlError)) throw error;
            this.context.recordEvent({
              object: rule, type: 'Warning', reason: 'InvalidExpression',
              message: `${entry.alert}: ${(error as Error).message}`,
            });
            continue;
          }
          const forMs = entry.for ? parseDuration(entry.for) : 0;
          for (const result of results) {
            const labels = { ...result.labels, ...(entry.labels ?? {}), alertname: entry.alert };
            const key = `${entry.alert}/${JSON.stringify(labels)}`;
            seen.add(key);
            const existing = this.alerts.get(key);
            const activeAt = existing?.activeAt ?? at;
            this.alerts.set(key, {
              name: entry.alert,
              labels,
              annotations: renderAnnotations(entry.annotations ?? {}, result.value, labels),
              state: at - activeAt >= forMs ? 'firing' : 'pending',
              activeAt,
              value: result.value,
            });
          }
        }
      }
    }
    // 条件不再成立的告警直接消失，不留残影
    for (const key of [...this.alerts.keys()]) {
      if (!seen.has(key)) this.alerts.delete(key);
    }
  }

  firing(): Alert[] {
    return [...this.alerts.values()]
      .filter((alert) => alert.state === 'firing')
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}

/** 注解里的 `{{ $value }}` 与 `{{ $labels.x }}` */
function renderAnnotations(
  annotations: Record<string, string>,
  value: number,
  labels: Labels
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, template] of Object.entries(annotations)) {
    out[key] = template
      .replace(/\{\{\s*\$value\s*\}\}/g, String(value))
      .replace(/\{\{\s*\$labels\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, name: string) => labels[name] ?? '');
  }
  return out;
}
