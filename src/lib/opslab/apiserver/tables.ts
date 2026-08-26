/**
 * 服务端表格渲染
 *
 * `kubectl get` 默认那张表**是 apiserver 渲染的**，不是 kubectl 自己排的 ——
 * kubectl 发的是 `Accept: application/json;as=Table;g=meta.k8s.io;v=v1`，
 * 收到的是一个 Table 对象。不实现它的话 kubectl 会退化成通用打印，
 * 只剩 NAME 和 AGE 两列，一眼就看出来是假的（spike 时踩过）。
 *
 * 列定义照抄 k8s 的 `pkg/printers/internalversion/printers.go`。
 * `priority: 1` 的列只在 `-o wide` 时显示。
 * AGE 也由服务端算好 —— 真集群同样如此，而这正好让它接上虚拟时钟：
 * 快进时间时 AGE 会跟着动。
 */
import type { KubeObject } from './types';

export interface TableColumnDefinition {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'date';
  format?: string;
  description: string;
  /** 0 = 总是显示，1 = 只在 -o wide 显示 */
  priority: number;
}

export interface TableRow {
  cells: Array<string | number | null>;
  object: { kind: 'PartialObjectMetadata'; apiVersion: 'meta.k8s.io/v1'; metadata: KubeObject['metadata'] };
}

export interface Table {
  kind: 'Table';
  apiVersion: 'meta.k8s.io/v1';
  metadata: { resourceVersion: string };
  columnDefinitions: TableColumnDefinition[];
  rows: TableRow[];
}

const NAME_COLUMN: TableColumnDefinition = {
  name: 'Name', type: 'string', format: 'name', priority: 0,
  description: 'Name must be unique within a namespace.',
};
const AGE_COLUMN: TableColumnDefinition = {
  name: 'Age', type: 'string', priority: 0,
  description: 'CreationTimestamp is a timestamp representing the server time when this object was created.',
};

export interface TablePrinter {
  columns: TableColumnDefinition[];
  cells: (object: KubeObject, age: string) => Array<string | number | null>;
}

const col = (
  name: string,
  description: string,
  priority = 0,
  type: TableColumnDefinition['type'] = 'string'
): TableColumnDefinition => ({ name, type, description, priority });

/** 资源名 -> 打印器。没有登记的资源退化成 NAME + AGE，和真 apiserver 一致。 */
export const TABLE_PRINTERS: Record<string, TablePrinter> = {
  pods: {
    columns: [
      NAME_COLUMN,
      col('Ready', 'The aggregate readiness state of this pod for accepting traffic.'),
      col('Status', 'The aggregate status of the containers in this pod.'),
      col('Restarts', 'The number of times the containers in this pod have been restarted.'),
      AGE_COLUMN,
      col('IP', 'IP address allocated to the pod.', 1),
      col('Node', 'The name of the node this pod runs on.', 1),
      col('Nominated Node', 'Nominated node for the pod.', 1),
      col('Readiness Gates', 'Readiness gates of the pod.', 1),
    ],
    cells: (object, age) => {
      const status = (object.status ?? {}) as any;
      const spec = (object.spec ?? {}) as any;
      const containerStatuses: any[] = status.containerStatuses ?? [];
      const total = containerStatuses.length || (spec.containers ?? []).length;
      const ready = containerStatuses.filter((c) => c.ready).length;
      const restarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
      // 正在删除的 Pod 显示 Terminating，真集群也是这么覆盖 phase 的
      const phase = object.metadata.deletionTimestamp ? 'Terminating' : (status.phase ?? 'Unknown');
      return [
        object.metadata.name, `${ready}/${total}`, phase, String(restarts), age,
        status.podIP ?? '<none>', spec.nodeName ?? '<none>', '<none>', '<none>',
      ];
    },
  },
  deployments: {
    columns: [
      NAME_COLUMN,
      col('Ready', 'Number of the pod with ready state'),
      col('Up-to-date', 'Total number of non-terminated pods targeted by this deployment that have the desired template spec.'),
      col('Available', 'Total number of available pods (ready for at least minReadySeconds) targeted by this deployment.'),
      AGE_COLUMN,
      col('Containers', 'Names of each container in the template.', 1),
      col('Images', 'Images referenced by each container in the template.', 1),
      col('Selector', 'The label selector of this deployment.', 1),
    ],
    cells: (object, age) => {
      const spec = (object.spec ?? {}) as any;
      const status = (object.status ?? {}) as any;
      const containers: any[] = spec.template?.spec?.containers ?? [];
      const selector = Object.entries(spec.selector?.matchLabels ?? {})
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      return [
        object.metadata.name,
        `${status.readyReplicas ?? 0}/${spec.replicas ?? 0}`,
        String(status.updatedReplicas ?? 0),
        String(status.availableReplicas ?? 0),
        age,
        containers.map((c) => c.name).join(',') || '<none>',
        containers.map((c) => c.image).join(',') || '<none>',
        selector || '<none>',
      ];
    },
  },
  daemonsets: {
    columns: [
      NAME_COLUMN,
      col('Desired', 'The desired number of pods.'),
      col('Current', 'The number of currently running pods.'),
      col('Ready', 'The number of ready pods.'),
      col('Up-to-date', 'The number of pods updated to the latest spec.'),
      col('Available', 'The number of available pods.'),
      col('Node Selector', 'The node selector of this daemonset.'),
      AGE_COLUMN,
      col('Containers', 'Names of each container in the template.', 1),
      col('Images', 'Images referenced by each container in the template.', 1),
      col('Selector', 'The label selector of this daemonset.', 1),
    ],
    cells: (object, age) => {
      const spec = (object.spec ?? {}) as any;
      const status = (object.status ?? {}) as any;
      const containers: any[] = spec.template?.spec?.containers ?? [];
      const nodeSelector = Object.entries(spec.template?.spec?.nodeSelector ?? {})
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      const selector = Object.entries(spec.selector?.matchLabels ?? {})
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      return [
        object.metadata.name,
        String(status.desiredNumberScheduled ?? 0),
        String(status.currentNumberScheduled ?? 0),
        String(status.numberReady ?? 0),
        String(status.updatedNumberScheduled ?? 0),
        String(status.numberAvailable ?? 0),
        nodeSelector || '<none>',
        age,
        containers.map((c) => c.name).join(',') || '<none>',
        containers.map((c) => c.image).join(',') || '<none>',
        selector || '<none>',
      ];
    },
  },
  applications: {
    columns: [
      NAME_COLUMN,
      col('Sync Status', 'Whether the live state matches the repository.'),
      col('Health Status', 'Health of the resources this application manages.'),
      col('Revision', 'The revision the application is synced to.', 1),
      AGE_COLUMN,
    ],
    cells: (object, age) => {
      const status = (object.status ?? {}) as any;
      return [
        object.metadata.name,
        status.sync?.status ?? 'Unknown',
        status.health?.status ?? 'Unknown',
        (status.sync?.revision ?? '').slice(0, 7) || '<none>',
        age,
      ];
    },
  },
  poddisruptionbudgets: {
    columns: [
      NAME_COLUMN,
      col('Min Available', 'The minimum number of pods that must be available.'),
      col('Max Unavailable', 'The maximum number of pods that may be unavailable.'),
      col('Allowed Disruptions', 'The number of pods that may be evicted right now.'),
      AGE_COLUMN,
    ],
    cells: (object, age) => {
      const spec = (object.spec ?? {}) as any;
      const status = (object.status ?? {}) as any;
      return [
        object.metadata.name,
        spec.minAvailable !== undefined ? String(spec.minAvailable) : 'N/A',
        spec.maxUnavailable !== undefined ? String(spec.maxUnavailable) : 'N/A',
        String(status.disruptionsAllowed ?? 0),
        age,
      ];
    },
  },
  namespaces: {
    columns: [NAME_COLUMN, col('Status', 'The status of the namespace.'), AGE_COLUMN],
    cells: (object, age) => [
      object.metadata.name,
      object.metadata.deletionTimestamp ? 'Terminating' : ((object.status as any)?.phase ?? 'Active'),
      age,
    ],
  },
  nodes: {
    columns: [
      NAME_COLUMN,
      col('Status', 'The status of the node.'),
      col('Roles', 'The roles of the node.'),
      AGE_COLUMN,
      col('Version', 'The kubelet version.'),
      col('Internal-IP', 'The internal IP of the node.', 1),
      col('OS-Image', 'The OS image of the node.', 1),
      col('Kernel-Version', 'The kernel version of the node.', 1),
      col('Container-Runtime', 'The container runtime of the node.', 1),
    ],
    cells: (object, age) => {
      const status = (object.status ?? {}) as any;
      const conditions: any[] = status.conditions ?? [];
      const readyCondition = conditions.find((c) => c.type === 'Ready');
      let state = readyCondition?.status === 'True' ? 'Ready' : 'NotReady';
      if ((object.spec as any)?.unschedulable) state += ',SchedulingDisabled';
      const roles = Object.keys(object.metadata.labels ?? {})
        .filter((label) => label.startsWith('node-role.kubernetes.io/'))
        .map((label) => label.slice('node-role.kubernetes.io/'.length))
        .sort();
      const addresses: any[] = status.addresses ?? [];
      const info = status.nodeInfo ?? {};
      return [
        object.metadata.name, state, roles.join(',') || '<none>', age,
        info.kubeletVersion ?? '<unknown>',
        addresses.find((a) => a.type === 'InternalIP')?.address ?? '<none>',
        info.osImage ?? '<unknown>',
        info.kernelVersion ?? '<unknown>',
        info.containerRuntimeVersion ?? '<unknown>',
      ];
    },
  },
  services: {
    columns: [
      NAME_COLUMN,
      col('Type', 'The type of this service.'),
      col('Cluster-IP', 'The cluster IP of this service.'),
      col('External-IP', 'The external IP of this service.'),
      col('Port(s)', 'The ports exposed by this service.'),
      AGE_COLUMN,
      col('Selector', 'The label selector of this service.', 1),
    ],
    cells: (object, age) => {
      const spec = (object.spec ?? {}) as any;
      const ports: any[] = spec.ports ?? [];
      const selector = Object.entries(spec.selector ?? {})
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      return [
        object.metadata.name,
        spec.type ?? 'ClusterIP',
        spec.clusterIP ?? '<none>',
        '<none>',
        ports.map((p) => (p.nodePort ? `${p.port}:${p.nodePort}/${p.protocol ?? 'TCP'}` : `${p.port}/${p.protocol ?? 'TCP'}`)).join(',') || '<none>',
        age,
        selector || '<none>',
      ];
    },
  },

  /**
   * Endpoints 的这一列是排查「服务不通」时最该看的东西。
   *
   * 空的时候显示 `<none>`，一眼就知道是标签没匹配上，而不是网络问题。
   * 真集群超过 3 个地址会折成 `a,b,c + 2 more...`，这里照做 —— 学员会
   * 拿两边的输出对照。
   */
  endpoints: {
    columns: [
      NAME_COLUMN,
      col('Endpoints', 'The addresses of the endpoints.'),
      AGE_COLUMN,
    ],
    cells: (object, age) => {
      const subsets: any[] = (object.subsets ?? []) as any[];
      const addresses: string[] = [];
      for (const subset of subsets) {
        for (const address of subset.addresses ?? []) {
          for (const port of subset.ports ?? [{}]) {
            addresses.push(port.port ? `${address.ip}:${port.port}` : String(address.ip));
          }
        }
      }
      const shown = addresses.slice(0, 3).join(',');
      const rest = addresses.length - 3;
      return [
        object.metadata.name,
        addresses.length === 0 ? '<none>' : rest > 0 ? `${shown} + ${rest} more...` : shown,
        age,
      ];
    },
  },

  configmaps: {
    columns: [
      NAME_COLUMN,
      col('Data', 'The number of keys in this config map.'),
      AGE_COLUMN,
    ],
    cells: (object, age) => [
      object.metadata.name,
      String(Object.keys((object.data ?? {}) as Record<string, unknown>).length),
      age,
    ],
  },

  secrets: {
    columns: [
      NAME_COLUMN,
      col('Type', 'The type of this secret.'),
      col('Data', 'The number of keys in this secret.'),
      AGE_COLUMN,
    ],
    cells: (object, age) => [
      object.metadata.name,
      String(object.type ?? 'Opaque'),
      String(Object.keys({
        ...((object.data ?? {}) as Record<string, unknown>),
        ...((object.stringData ?? {}) as Record<string, unknown>),
      }).length),
      age,
    ],
  },
};

/**
 * k8s 的 `duration.HumanDuration`。
 *
 * 规则有点特别：大于 10 个单位就只显示一个单位（`13d` 而不是 `13d4h`），
 * 小于 10 才显示两个（`4h12m`）。照抄是因为学员对着真集群的输出会对不上。
 */
export function humanDuration(fromEpochMs: number, nowEpochMs: number): string {
  const ms = nowEpochMs - fromEpochMs;
  if (!Number.isFinite(ms)) return '<unknown>';
  if (ms < 0) return '<invalid>';

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes < 10 && seconds % 60 !== 0 ? `${minutes}m${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours < 10 && minutes % 60 !== 0 ? `${hours}h${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return days < 10 && hours % 24 !== 0 ? `${days}d${hours % 24}h` : `${days}d`;
  const years = Math.floor(days / 365);
  return years < 10 && days % 365 !== 0 ? `${years}y${days % 365}d` : `${years}y`;
}

const FALLBACK_PRINTER: TablePrinter = {
  columns: [NAME_COLUMN, AGE_COLUMN],
  cells: (object, age) => [object.metadata.name, age],
};

export function printerFor(resource: string): TablePrinter {
  return TABLE_PRINTERS[resource] ?? FALLBACK_PRINTER;
}

export function renderTable(
  resource: string,
  objects: KubeObject[],
  resourceVersion: string,
  nowEpochMs: number
): Table {
  const printer = printerFor(resource);
  return {
    kind: 'Table',
    apiVersion: 'meta.k8s.io/v1',
    metadata: { resourceVersion },
    columnDefinitions: printer.columns,
    rows: objects.map((object) => ({
      cells: printer.cells(
        object,
        object.metadata.creationTimestamp
          ? humanDuration(Date.parse(object.metadata.creationTimestamp), nowEpochMs)
          : '<unknown>'
      ),
      object: {
        kind: 'PartialObjectMetadata',
        apiVersion: 'meta.k8s.io/v1',
        metadata: object.metadata,
      },
    })),
  };
}

/** kubectl 想要表格吗 —— 看 Accept 里有没有 `as=Table` */
export function wantsTable(accept: string | undefined): boolean {
  return typeof accept === 'string' && accept.includes('as=Table');
}
