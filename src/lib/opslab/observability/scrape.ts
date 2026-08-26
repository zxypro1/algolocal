/**
 * 采集
 *
 * Prometheus 是**拉**模型：它按 ServiceMonitor 找到目标，定期去每个目标的
 * `/metrics` 上拉一次。这决定了两件事：
 *
 *  1. 采集间隔之间发生的事看不见。Pod 起来又挂掉、只活了十秒，
 *     很可能一个点都没采到 —— 事后翻指标是翻不出来的，得看事件。
 *  2. 目标挂掉之后，`up` 变成 0，而它此前的指标还会在图上停留一个
 *     回看窗口（默认五分钟）才消失。
 *
 * 这里不实现 HTTP 抓取，指标由集群状态直接生成 —— 但**目标是谁、采不采得到**
 * 完全按 ServiceMonitor 与选择器算，因为那才是这一层会出错的地方。
 */
import type { KubeObject } from '../apiserver';
import type { Labels } from './tsdb';

export interface ScrapeTarget {
  /** `<namespace>/<service>` */
  job: string;
  namespace: string;
  service: string;
  pod: string;
  /** 目标上不上得去。Pod 不 Running 就是 down。 */
  up: boolean;
  labels: Labels;
}

export interface ScrapeView {
  serviceMonitors(): KubeObject[];
  services(namespace?: string): KubeObject[];
  pods(namespace?: string): KubeObject[];
  namespaces(): KubeObject[];
  /** Prometheus 实例自己的选择器 */
  prometheus(): KubeObject | undefined;
}

/**
 * 算出这一轮该采哪些目标。
 *
 * 两层选择器都要过：Prometheus 的 `serviceMonitorSelector` 选中 ServiceMonitor，
 * ServiceMonitor 的 `selector` 选中 Service。少配一层是最常见的「采不到」原因。
 */
export function targetsOf(view: ScrapeView): ScrapeTarget[] {
  const prometheus = view.prometheus();
  const monitorSelector = ((prometheus?.spec ?? {}) as any)?.serviceMonitorSelector?.matchLabels as
    Record<string, string> | undefined;
  const namespaceSelector = ((prometheus?.spec ?? {}) as any)?.serviceMonitorNamespaceSelector?.matchLabels as
    Record<string, string> | undefined;

  const out: ScrapeTarget[] = [];
  for (const monitor of view.serviceMonitors()) {
    if (monitorSelector && !hasLabels(monitor.metadata.labels, monitorSelector)) continue;
    if (namespaceSelector) {
      const namespace = view.namespaces().find((item) => item.metadata.name === monitor.metadata.namespace);
      if (!hasLabels(namespace?.metadata.labels, namespaceSelector)) continue;
    }

    const spec = (monitor.spec ?? {}) as any;
    const wanted = spec.selector?.matchLabels as Record<string, string> | undefined;
    const scope: string[] = spec.namespaceSelector?.matchNames ?? [monitor.metadata.namespace ?? 'default'];

    for (const namespace of scope) {
      for (const service of view.services(namespace)) {
        if (!hasLabels(service.metadata.labels, wanted)) continue;
        const selector = ((service.spec ?? {}) as any).selector as Record<string, string> | undefined;
        for (const pod of view.pods(namespace)) {
          if (!hasLabels(pod.metadata.labels, selector)) continue;
          out.push({
            job: `${namespace}/${service.metadata.name}`,
            namespace,
            service: service.metadata.name!,
            pod: pod.metadata.name!,
            up: ((pod.status ?? {}) as any).phase === 'Running',
            labels: {
              job: `${namespace}/${service.metadata.name}`,
              namespace,
              service: service.metadata.name!,
              pod: pod.metadata.name!,
              ...(pod.metadata.labels?.app ? { app: pod.metadata.labels.app } : {}),
            },
          });
        }
      }
    }
  }
  return out.sort((a, b) => (`${a.job}/${a.pod}` < `${b.job}/${b.pod}` ? -1 : 1));
}

function hasLabels(labels: Record<string, string> | undefined, wanted: Record<string, string> | undefined): boolean {
  if (!wanted) return true;
  const actual = labels ?? {};
  return Object.entries(wanted).every(([key, value]) => actual[key] === value);
}
