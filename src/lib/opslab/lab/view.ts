/**
 * 给面板看的两个投影：拓扑图与变更流
 *
 * 都是从集群当前状态算出来的纯函数，不持有状态。这样「面板之间单向数据流、
 * 单一数据源」这条约束才成立 —— 面板不互相发消息，各自从同一份世界里取自己要的。
 *
 * 坐标自己算，不交给布局引擎：泳道固定、每层内按名字排序，
 * 于是同样的集群状态每次画出来位置完全一样。学员盯着一张会跳来跳去的图
 * 是看不出「刚才那一下改了什么」的。
 */
import type { Cluster } from '../controllers';
import type { KubeObject } from '../apiserver';
import type { ConnectResult, ConnectTrace, Hop, Source, Target } from '../net';

export type TopologyStatus = 'ok' | 'pending' | 'warn' | 'error';

export interface TopologyNode {
  id: string;
  kind: string;
  name: string;
  namespace?: string;
  /** 节点下面那行小字，如 `3/3` 或 `ImagePullBackOff` */
  detail: string;
  status: TopologyStatus;
  /** 点一下往终端里插的命令 */
  command: string;
  x: number;
  y: number;
  /** 上一次之后变过 */
  changed?: boolean;
}

export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  kind: 'owns' | 'routes' | 'schedules';
}

export interface TopologyLane {
  id: string;
  title: string;
  y: number;
  height: number;
}

export interface TopologyGraph {
  lanes: TopologyLane[];
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  width: number;
  height: number;
}

const NODE_WIDTH = 168;
const NODE_HEIGHT = 56;
const GAP_X = 24;
const LANE_HEIGHT = 112;
const LANE_PADDING = 28;

/** 泳道从上到下：流量怎么进来 → 谁在提供服务 → 实例 → 落在哪台机器 */
const LANES: Array<{ id: string; title: string; kinds: string[] }> = [
  { id: 'ingress', title: '入口', kinds: ['Gateway', 'HTTPRoute', 'Ingress', 'Service'] },
  {
    id: 'workload', title: '工作负载',
    kinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Rollout', 'ReplicaSet'],
  },
  { id: 'pod', title: '实例', kinds: ['Pod'] },
  { id: 'node', title: '节点', kinds: ['Node'] },
];

export interface TopologyOptions {
  namespace?: string;
  /** 上一张图，用来标出「刚才那一下改了什么」 */
  previous?: TopologyGraph;
  /** ReplicaSet 平时是噪音，排查滚动更新时才需要 */
  showReplicaSets?: boolean;
}

export function buildTopology(cluster: Cluster, options: TopologyOptions = {}): TopologyGraph {
  const namespace = options.namespace ?? 'default';
  const objects = collect(cluster, namespace);

  const byLane = new Map<string, KubeObject[]>();
  for (const lane of LANES) byLane.set(lane.id, []);
  for (const object of objects) {
    if (object.kind === 'ReplicaSet' && !options.showReplicaSets) continue;
    const lane = LANES.find((item) => item.kinds.includes(object.kind));
    if (lane) byLane.get(lane.id)!.push(object);
  }

  const previousVersions = new Map(
    (options.previous?.nodes ?? []).map((node) => [node.id, node.detail + node.status])
  );

  const nodes: TopologyNode[] = [];
  const lanes: TopologyLane[] = [];
  let widest = 1;
  let y = LANE_PADDING;

  for (const lane of LANES) {
    const items = (byLane.get(lane.id) ?? []).sort(byName);
    lanes.push({ id: lane.id, title: lane.title, y: y - LANE_PADDING / 2, height: LANE_HEIGHT });
    widest = Math.max(widest, items.length);

    items.forEach((object, index) => {
      const node = toNode(object, index, y);
      const before = previousVersions.get(node.id);
      node.changed = before !== undefined && before !== node.detail + node.status;
      nodes.push(node);
    });
    y += LANE_HEIGHT;
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = buildEdges(objects, nodeIds, namespace);

  return {
    lanes,
    nodes,
    edges,
    width: LANE_PADDING * 2 + widest * (NODE_WIDTH + GAP_X),
    height: y + LANE_PADDING,
  };
}

function collect(cluster: Cluster, namespace: string): KubeObject[] {
  const out: KubeObject[] = [];
  for (const definition of cluster.scheme.list()) {
    if (!LANES.some((lane) => lane.kinds.includes(definition.kind))) continue;
    const list = cluster.registry.list(definition, {
      namespace: definition.namespaced ? namespace : undefined,
    });
    out.push(...list.items);
  }
  return out;
}

function byName(a: KubeObject, b: KubeObject): number {
  return a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0;
}

function toNode(object: KubeObject, index: number, y: number): TopologyNode {
  const { detail, status } = describe(object);
  return {
    id: `${object.kind}/${object.metadata.namespace ?? '-'}/${object.metadata.name}`,
    kind: object.kind,
    name: object.metadata.name,
    namespace: object.metadata.namespace,
    detail,
    status,
    command: commandFor(object),
    x: LANE_PADDING + index * (NODE_WIDTH + GAP_X),
    y,
  };
}

/**
 * 节点上那行小字，抄的是 `kubectl get` 里最要紧的那一列，外加一个健康度。
 *
 * 导出是给 AI 上下文用的 —— 喂给模型的集群快照和拓扑图上看到的应该是
 * 同一套判断，不然学员会问「它说我这个 Pod 没问题，可图上是红的」。
 */
export function describe(object: KubeObject): { detail: string; status: TopologyStatus } {
  const status = (object.status ?? {}) as Record<string, unknown>;
  const spec = (object.spec ?? {}) as Record<string, unknown>;

  switch (object.kind) {
    case 'Deployment':
    case 'StatefulSet': {
      const ready = Number(status.readyReplicas ?? 0);
      const desired = Number(spec.replicas ?? 0);
      return {
        detail: `${ready}/${desired}`,
        status: desired === 0 ? 'pending' : ready === desired ? 'ok' : ready === 0 ? 'error' : 'warn',
      };
    }
    /**
     * Rollout 比 Deployment 多一样东西：它停在哪一步。
     * 只打 `可用/期望` 的话，「暂停等人确认」和「分析失败已经退回去」
     * 在图上长得一模一样，而这两件事要采取的动作完全相反。
     */
    case 'Rollout': {
      const available = Number(status.availableReplicas ?? 0);
      const desired = Number(spec.replicas ?? 0);
      const phase = String(status.phase ?? 'Progressing');
      return {
        detail: `${available}/${desired} ${phase}`,
        status: phase === 'Degraded' ? 'error'
          : phase === 'Healthy' ? 'ok'
            : phase === 'Paused' ? 'pending' : 'warn',
      };
    }
    case 'ReplicaSet': {
      const ready = Number(status.readyReplicas ?? 0);
      const desired = Number(spec.replicas ?? 0);
      return { detail: `${ready}/${desired}`, status: ready === desired ? 'ok' : 'warn' };
    }
    case 'Pod': {
      const phase = String(status.phase ?? 'Pending');
      const containers = (status.containerStatuses ?? []) as Array<{ ready?: boolean; state?: Record<string, unknown> }>;
      const waiting = containers
        .map((item) => (item.state?.waiting as { reason?: string } | undefined)?.reason)
        .find(Boolean);
      if (waiting) return { detail: waiting, status: 'error' };
      const ready = containers.filter((item) => item.ready).length;
      return {
        detail: `${ready}/${containers.length || 1} ${phase}`,
        status: phase === 'Running' && ready === containers.length ? 'ok'
          : phase === 'Failed' ? 'error' : 'pending',
      };
    }
    case 'Service': {
      const type = String(spec.type ?? 'ClusterIP');
      return { detail: type, status: 'ok' };
    }
    case 'Node': {
      const conditions = (status.conditions ?? []) as Array<{ type?: string; status?: string }>;
      const ready = conditions.find((item) => item.type === 'Ready')?.status === 'True';
      const cordoned = spec.unschedulable === true;
      return {
        detail: cordoned ? 'Ready,SchedulingDisabled' : ready ? 'Ready' : 'NotReady',
        status: !ready ? 'error' : cordoned ? 'warn' : 'ok',
      };
    }
    default:
      return { detail: object.kind, status: 'ok' };
  }
}

/** 点一下拓扑上的节点，往终端里插这条命令 —— 只读检查，不改状态 */
function commandFor(object: KubeObject): string {
  const namespace = object.metadata.namespace ? ` -n ${object.metadata.namespace}` : '';
  const lower = object.kind.toLowerCase();
  return object.kind === 'Pod'
    ? `kubectl describe pod ${object.metadata.name}${namespace}`
    : `kubectl describe ${lower} ${object.metadata.name}${namespace}`;
}

function buildEdges(objects: KubeObject[], nodeIds: Set<string>, namespace: string): TopologyEdge[] {
  const edges: TopologyEdge[] = [];
  const idOf = (kind: string, name: string, ns?: string) => `${kind}/${ns ?? '-'}/${name}`;
  const push = (from: string, to: string, kind: TopologyEdge['kind']) => {
    if (!nodeIds.has(from) || !nodeIds.has(to)) return;
    const id = `${kind}:${from}->${to}`;
    if (!edges.some((edge) => edge.id === id)) edges.push({ id, from, to, kind });
  };

  const byUid = new Map(objects.map((object) => [object.metadata.uid ?? '', object]));

  for (const object of objects) {
    // 属主链：Deployment → ReplicaSet → Pod。ReplicaSet 被折叠时直接连到 Deployment。
    for (const owner of object.metadata.ownerReferences ?? []) {
      const parent = byUid.get(owner.uid);
      const parentId = parent
        ? idOf(parent.kind, parent.metadata.name, parent.metadata.namespace)
        : idOf(owner.kind, owner.name, object.metadata.namespace);
      const childId = idOf(object.kind, object.metadata.name, object.metadata.namespace);

      if (nodeIds.has(parentId)) { push(parentId, childId, 'owns'); continue; }
      // 折叠掉的中间层：往上再找一级
      const grandparent = parent?.metadata.ownerReferences?.[0];
      if (grandparent) {
        push(idOf(grandparent.kind, grandparent.name, object.metadata.namespace), childId, 'owns');
      }
    }

    // Service → Pod：按 selector 匹配，这正是「标签写错了就没有端点」看得见的地方
    if (object.kind === 'Service') {
      const selector = ((object.spec ?? {}) as { selector?: Record<string, string> }).selector;
      if (!selector || Object.keys(selector).length === 0) continue;
      for (const pod of objects) {
        if (pod.kind !== 'Pod') continue;
        const labels = pod.metadata.labels ?? {};
        if (!Object.entries(selector).every(([key, value]) => labels[key] === value)) continue;
        push(
          idOf('Service', object.metadata.name, object.metadata.namespace),
          idOf('Pod', pod.metadata.name, pod.metadata.namespace),
          'routes'
        );
      }
    }

    // Pod → Node
    if (object.kind === 'Pod') {
      const nodeName = ((object.spec ?? {}) as { nodeName?: string }).nodeName;
      if (nodeName) {
        push(
          idOf('Pod', object.metadata.name, object.metadata.namespace),
          idOf('Node', nodeName, undefined),
          'schedules'
        );
      }
    }
  }

  return edges.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* 变更流                                                              */
/* ------------------------------------------------------------------ */

export interface ObjectVersion {
  /** `Kind/namespace/name` */
  id: string;
  resourceVersion: string;
}

export type ChangeType = 'added' | 'modified' | 'deleted';

export interface ChangeEntry {
  type: ChangeType;
  kind: string;
  name: string;
  namespace?: string;
  /** 虚拟墙钟 */
  at: number;
}

/** 当前集群里所有对象的版本快照 —— 变更流靠对比两张快照算出来 */
export function snapshotVersions(cluster: Cluster): Map<string, string> {
  const out = new Map<string, string>();
  for (const definition of cluster.scheme.list()) {
    // Event 本身就是变更记录，再算一遍就成了自我指涉的噪音
    if (definition.kind === 'Event') continue;
    for (const object of cluster.registry.list(definition).items) {
      out.set(
        `${object.kind}/${object.metadata.namespace ?? '-'}/${object.metadata.name}`,
        object.metadata.resourceVersion ?? ''
      );
    }
  }
  return out;
}

/** 两张快照之间发生了什么。顺序稳定：先按类型再按 id。 */
export function diffVersions(
  before: Map<string, string>,
  after: Map<string, string>,
  at: number
): ChangeEntry[] {
  const changes: ChangeEntry[] = [];

  for (const [id, version] of after) {
    const previous = before.get(id);
    if (previous === undefined) changes.push({ ...parseId(id), type: 'added', at });
    else if (previous !== version) changes.push({ ...parseId(id), type: 'modified', at });
  }
  for (const id of before.keys()) {
    if (!after.has(id)) changes.push({ ...parseId(id), type: 'deleted', at });
  }

  const order: Record<ChangeType, number> = { added: 0, modified: 1, deleted: 2 };
  return changes.sort((a, b) =>
    order[a.type] !== order[b.type]
      ? order[a.type] - order[b.type]
      : `${a.kind}/${a.namespace}/${a.name}` < `${b.kind}/${b.namespace}/${b.name}` ? -1 : 1
  );
}

function parseId(id: string): { kind: string; namespace?: string; name: string } {
  const [kind, namespace, name] = id.split('/');
  return { kind, namespace: namespace === '-' ? undefined : namespace, name };
}

/* ------------------------------------------------------------------ */
/* kubeconfig                                                          */
/* ------------------------------------------------------------------ */

/**
 * 当前 context 用的是哪个命名空间。
 *
 * 拓扑面板要跟着它走：关卡在 `payments` 里干活、拓扑却盯着 `default`，
 * 学员会以为自己什么都没建出来。
 *
 * 自己扫而不是引 YAML 库：只取两个字段，而且 kubeconfig 是学员会手改的文件，
 * 半坏的时候也得给个合理答案，而不是抛异常把面板炸掉。
 */
export function currentNamespaceOf(kubeconfig: string, fallback = 'default'): string {
  const current = /^current-context:\s*(\S+)\s*$/m.exec(kubeconfig)?.[1];
  if (!current) return fallback;

  const contexts = kubeconfig.split(/^contexts:\s*$/m)[1];
  if (!contexts) return fallback;
  // 到下一个顶层键为止
  const section = contexts.split(/^[a-zA-Z]/m)[0];

  const entry = section
    .split(/^- /m)
    .find((block) => new RegExp(`^\\s*name:\\s*${escapeForRegExp(current)}\\s*$`, 'm').test(block));
  return /^\s*namespace:\s*(\S+)\s*$/m.exec(entry ?? '')?.[1] ?? fallback;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/* 数据面：一个包走过的路                                              */
/* ------------------------------------------------------------------ */

export interface PacketStep {
  /** 第几跳，从 1 开始 */
  index: number;
  /** 这一跳发生在哪 —— 原样来自 Hop.at，如 `svc/payments/portal` */
  at: string;
  detail: string;
  verdict: Hop['verdict'];
  /** 到这一跳为止累计花了多少虚拟毫秒 */
  elapsedMs: number;
  /**
   * 对应拓扑图上的哪个节点。
   *
   * 对不上的跳（DNS、分区边界、NetworkPolicy）没有节点 —— 它们不是集群里的
   * 对象。这些恰恰是最常出问题的地方，所以路径面板要能单独把它们显示出来，
   * 而不是只在图上高亮。
   */
  nodeId?: string;
}

export interface PacketPath {
  id: number;
  /** 谁发起的，如 `jump-01` 或 `pod/payments/portal-xxx` */
  from: string;
  /** 打给谁，如 `https://portal.corp.internal/` */
  to: string;
  /** ok / refused / timeout / reset / no-route / dns-failure */
  outcome: ConnectResult['kind'];
  /** HTTP 状态码，只有 kind === 'ok' 时有 */
  status?: number;
  /** 被谁挡下的 */
  blockedBy?: string;
  totalMs: number;
  steps: PacketStep[];
}

/**
 * 把一次连接翻译成拓扑图上的一条路径。
 *
 * 只做映射，不做判断 —— 「哪一跳出的问题」在 hop 的 verdict 里已经写好了。
 */
export function buildPacketPath(trace: ConnectTrace, graph?: TopologyGraph): PacketPath {
  const known = new Set((graph?.nodes ?? []).map((node) => node.id));
  let elapsed = 0;
  const steps = trace.result.hops.map((hop, index) => {
    elapsed += hop.elapsedMs;
    const nodeId = nodeIdForHop(hop.at);
    return {
      index: index + 1,
      at: hop.at,
      detail: hop.detail,
      verdict: hop.verdict,
      elapsedMs: elapsed,
      nodeId: nodeId && (known.size === 0 || known.has(nodeId)) ? nodeId : undefined,
    };
  });

  return {
    id: trace.id,
    from: sourceLabel(trace.source),
    to: targetLabel(trace.target),
    outcome: trace.result.kind,
    status: trace.result.status,
    blockedBy: trace.result.blockedBy,
    totalMs: trace.result.elapsedMs,
    steps,
  };
}

/** 最近几次连接，最新的在前 */
export function buildPacketPaths(cluster: Cluster, graph?: TopologyGraph): PacketPath[] {
  return [...cluster.network.traces]
    .reverse()
    .map((trace) => buildPacketPath(trace, graph));
}

/**
 * hop 的 `at` 长什么样 -> 拓扑节点 id。
 *
 * 网络层写的是 `svc/ns/name` 这种小写复数形式，拓扑节点的 id 是
 * `Kind/ns/name`。两边各有各的道理（一个抄的是 kubectl，一个抄的是 GVK），
 * 所以在这里翻译，而不是逼一边改。
 */
function nodeIdForHop(at: string): string | undefined {
  const [prefix, ...rest] = at.split('/');
  if (rest.length !== 2) return undefined;
  const kind = HOP_KINDS[prefix];
  return kind ? `${kind}/${rest[0]}/${rest[1]}` : undefined;
}

const HOP_KINDS: Record<string, string> = {
  svc: 'Service',
  service: 'Service',
  pod: 'Pod',
  gateway: 'Gateway',
  httproute: 'HTTPRoute',
};

function sourceLabel(source: Source): string {
  if (source.zone === 'cluster' && source.podName) {
    return `pod/${source.namespace ?? 'default'}/${source.podName}`;
  }
  return source.label ?? source.zone;
}

function targetLabel(target: Target): string {
  const scheme = target.tls ? 'https' : 'http';
  const port = target.port === (target.tls ? 443 : 80) ? '' : `:${target.port}`;
  return `${scheme}://${target.host}${port}${target.path ?? ''}`;
}
