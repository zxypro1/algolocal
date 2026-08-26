/**
 * 把一个 ops 世界压成 AI 能吃下的快照
 *
 * 代码形态那边是把工作区的文件原样发上去，服务端再裁剪。ops 这边不能这么干：
 * 一个集群几百个对象，每个对象的 YAML 都不小，原样发过去先撞 Next 的请求体上限
 * （工程对话就撞过 413），撞不上也会把 token 烧光。
 *
 * 所以裁剪发生在**客户端**：这里把世界压成一份定长的结构化摘要，服务端只负责
 * 排版。所有的上限都写在这个文件里，`tests/opslab/aicontext.test.ts` 盯着它们。
 *
 * 取舍：宁可少给对象，也要把**异常**和**最近的命令输出**给全 —— 学员卡住的时候，
 * 十有八九答案就在上一条命令的报错里，而不在某个健康 Deployment 的 YAML 里。
 */
import type { KubeObject } from '../apiserver';
import type { Cluster } from '../controllers';
import type { CommandRecord } from '../../labkit/machine';
import type { StageRunReport } from '../../engineering/types';
import { describe as describeObject } from './view';
import type { OpsWorld } from './world';

/**
 * 最多带几个命名空间的常规对象（异常对象不受这个限制）。
 *
 * 得盖得住整个工程：intranet-k8s 有 15 个命名空间，之前这里是 8，按字母序
 * 砍掉的正好是 istio-system、monitoring、velero 这些**关卡本身要讲的**那几个。
 * 真正约束体积的是 MAX_WORKLOADS，这个数放宽不会把请求体撑起来。
 */
const MAX_NAMESPACES = 24;
/** 常规工作负载最多带多少条 */
const MAX_WORKLOADS = 40;
/** 异常对象最多带多少条 */
const MAX_PROBLEMS = 25;
/** 事件最多带多少条 */
const MAX_EVENTS = 20;
/**
 * 终端历史的预算，两种用法差别很大，所以做成两套。
 *
 * 对话是「看着刚才那条报错问」：条数少，但每条的输出要给全 —— 答案通常就在
 * 输出的某一行里。复盘反过来，问的是「这一关他是怎么走过来的」：**顺序**比
 * 每条的细节重要，所以条数放宽、单条压短。
 */
export interface SnapshotLimits {
  /** 终端历史最多带最近几条 */
  commands: number;
  /** 单条命令的输出截到多少字符 */
  commandOutput: number;
}

const CHAT_LIMITS: SnapshotLimits = { commands: 8, commandOutput: 1200 };
const REVIEW_LIMITS: SnapshotLimits = { commands: 50, commandOutput: 400 };

/** 复盘要看完整的排查路径，对话只要最近几条 */
export const SNAPSHOT_LIMITS = { chat: CHAT_LIMITS, review: REVIEW_LIMITS };
/** 单个文件截到多少字符 */
const MAX_FILE_CHARS = 4000;
/** 所有文件加起来的预算 */
const MAX_FILES_TOTAL = 10000;
/** 失败用例最多带几条 */
const MAX_FAILING_CASES = 6;
/** 节点最多带多少个（自动伸缩那几关能把节点数拉起来） */
const MAX_NODES = 20;
/** 单条命令本身截到多少字符：粘一段 PEM 进终端也不该整段发出去 */
const MAX_COMMAND_TEXT = 300;
/** 单条失败用例的报错截到多少字符 */
const MAX_CASE_ERROR = 800;

/** 这些类型是「工作负载」，值得逐个列出来 */
const WORKLOAD_KINDS = new Set([
  'Deployment', 'StatefulSet', 'DaemonSet', 'Rollout', 'Job', 'CronJob', 'MachineDeployment',
]);

/**
 * 这些类型即使一切正常也值得列出来：它们是「接线」，
 * 而 ops 关卡里出问题的往往不是工作负载本身，是它前面那根线。
 */
const WIRING_KINDS = new Set([
  'Service', 'Gateway', 'HTTPRoute', 'Ingress', 'NetworkPolicy',
  'PersistentVolumeClaim', 'Certificate', 'ServiceMonitor',
]);

export interface SnapshotObject {
  kind: string;
  name: string;
  namespace?: string;
  /** 一行小字，和拓扑图上那行是同一个来源 */
  detail: string;
  status: 'ok' | 'pending' | 'warn' | 'error';
}

export interface SnapshotEvent {
  type: string;
  reason: string;
  object: string;
  message: string;
}

export interface SnapshotCommand {
  command: string;
  code: number;
  output: string;
}

export interface OpsSnapshot {
  /** 学员正在看的那个命名空间（拓扑上那个下拉框选的，未必等于 kubeconfig 里的） */
  namespace: string;
  nodes: SnapshotObject[];
  workloads: SnapshotObject[];
  /** 状态不是 ok 的对象，跨命名空间收集 —— 这些是最该给模型看的 */
  problems: SnapshotObject[];
  events: SnapshotEvent[];
  commands: SnapshotCommand[];
  files: Array<{ path: string; content: string }>;
  /**
   * 被裁掉了多少东西，让模型知道自己看到的不是全部。
   *
   * `objects` 和 `problems` 必须分开报：前者是「健康、故意不列」，后者是
   * 「不健康、但超出上限被砍了」。混在一起报成「省略了 N 个健康对象」，
   * 等于跟模型撒谎说问题列表是全的。
   */
  omitted: { objects: number; problems: number; namespaces: number; commands: number; files: number };
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（还有 ${text.length - limit} 个字符被截掉）`;
}

/** 命令的输出：stderr 比 stdout 重要，先给 stderr */
function outputOf(record: CommandRecord, limit: number): string {
  const parts = [record.stderr?.trim(), record.stdout?.trim()].filter(Boolean) as string[];
  return truncate(parts.join('\n'), limit);
}

function toSnapshot(object: KubeObject): SnapshotObject {
  const { detail, status } = describeObject(object);
  return {
    kind: object.kind,
    name: object.metadata.name ?? '',
    namespace: object.metadata.namespace,
    detail,
    status,
  };
}

export interface OpsSnapshotOptions {
  /** 跳板机磁盘上的文件（整块盘，下面会挑和裁） */
  files?: Record<string, string>;
  /** 终端历史 */
  history?: CommandRecord[];
  /** 当前命名空间 */
  namespace?: string;
  /** 终端历史的预算，默认按对话来（见 SNAPSHOT_LIMITS） */
  limits?: Partial<SnapshotLimits>;
}

/**
 * 走一遍集群，压成快照。
 *
 * 只读，不碰任何状态 —— 这个函数在学员每次发消息时都会跑一遍。
 */
export function buildOpsSnapshot(world: OpsWorld, options: OpsSnapshotOptions = {}): OpsSnapshot {
  const cluster: Cluster = world.cluster;
  const namespace = options.namespace ?? 'default';

  const nodes: SnapshotObject[] = [];
  const workloads: SnapshotObject[] = [];
  const problems: SnapshotObject[] = [];
  const events: SnapshotEvent[] = [];
  let omittedObjects = 0;

  /**
   * 命名空间的取舍顺序：当前的排第一，其余按名字排。
   *
   * 超过上限的命名空间仍然会被扫**异常对象** —— 一个坏在别处的东西
   * 不该因为它的命名空间排在后面就看不见了。
   */
  const allNamespaces = cluster.registry
    .list(cluster.scheme.mustGet({ group: '', version: 'v1', resource: 'namespaces' })).items
    .map((item) => item.metadata.name!)
    .sort((a, b) => {
      if (a === namespace) return b === namespace ? 0 : -1;
      if (b === namespace) return 1;
      return a === b ? 0 : a < b ? -1 : 1;
    });
  const detailed = new Set(allNamespaces.slice(0, MAX_NAMESPACES));

  for (const definition of cluster.scheme.list()) {
    // 事件单独收，不当成普通对象
    if (definition.resource === 'events') continue;

    for (const object of cluster.registry.list(definition).items) {
      const summary = toSnapshot(object);

      if (object.kind === 'Node') {
        nodes.push(summary);
        continue;
      }

      /**
       * 不是 ok 就算异常 —— pending 也要算。
       *
       * 之前只收 error 和 warn，于是一个卡在 Pending 的裸 Pod（ops 关卡里
       * 最常见的症状）会一路掉到下面的 else 里被当成「健康对象」省掉，
       * 模型收到的是「状态不正常的对象：没有」。
       */
      if (summary.status !== 'ok') {
        problems.push(summary);
        continue;
      }

      const ns = object.metadata.namespace;
      if (ns && !detailed.has(ns)) { omittedObjects += 1; continue; }

      if (WORKLOAD_KINDS.has(object.kind) || WIRING_KINDS.has(object.kind)) {
        if (workloads.length < MAX_WORKLOADS) workloads.push(summary);
        else omittedObjects += 1;
      } else {
        // Pod、ReplicaSet、ConfigMap 这些健康时不单独列：数量大而信息量低，
        // 它们的状态已经体现在属主的 `3/3` 上了
        omittedObjects += 1;
      }
    }
  }

  /**
   * 异常对象先排序再砍，不能按遍历顺序先到先得。
   *
   * 注册表的遍历顺序是按资源类型来的，Pod 排在 Deployment 前面 —— 先到先得
   * 的话，别处命名空间的一堆 Pod 能把 25 个名额占满，而学员正在问的那个
   * 对象根本进不了请求。排序键：先当前命名空间，再按坏的程度。
   */
  const severity: Record<string, number> = { error: 0, warn: 1, pending: 2, ok: 3 };
  problems.sort((a, b) => {
    const mine = (item: SnapshotObject) => (item.namespace === namespace ? 0 : 1);
    return mine(a) - mine(b) || severity[a.status] - severity[b.status];
  });
  const omittedProblems = Math.max(0, problems.length - MAX_PROBLEMS);
  problems.length = Math.min(problems.length, MAX_PROBLEMS);

  const eventDefinition = cluster.scheme.get({ group: '', version: 'v1', resource: 'events' });
  if (eventDefinition) {
    const all = cluster.registry.list(eventDefinition).items;
    // Warning 优先，然后按新到旧 —— 事件表最有用的永远是「最近出的问题」
    const sorted = [...all].sort((a, b) => {
      const warn = (item: KubeObject) => ((item as Record<string, unknown>).type === 'Warning' ? 0 : 1);
      const byType = warn(a) - warn(b);
      if (byType !== 0) return byType;
      // 并列时必须返回 0：模拟时钟会让一批事件共用同一个时间戳，
      // 恒返回 1 的比较器在这种情况下顺序是未定义的
      const left = a.metadata.creationTimestamp ?? '';
      const right = b.metadata.creationTimestamp ?? '';
      return left === right ? 0 : left < right ? 1 : -1;
    });
    for (const event of sorted.slice(0, MAX_EVENTS)) {
      const raw = event as unknown as Record<string, any>;
      events.push({
        type: String(raw.type ?? 'Normal'),
        reason: String(raw.reason ?? ''),
        object: `${raw.involvedObject?.kind ?? ''}/${raw.involvedObject?.name ?? ''}`,
        message: truncate(String(raw.message ?? ''), 300),
      });
    }
  }

  const limits = { ...CHAT_LIMITS, ...options.limits };
  const history = options.history ?? [];
  const recent = history.slice(-limits.commands);
  const commands: SnapshotCommand[] = recent.map((record) => ({
    // 命令本身也截：往终端里粘一段 PEM 或者 base64 的 secret 是真会发生的
    command: truncate(record.command, MAX_COMMAND_TEXT),
    code: record.code,
    output: outputOf(record, limits.commandOutput),
  }));

  /**
   * 文件。收到的是**整块磁盘**，不是「IDE 里打开的那几个」。
   *
   * 所以顺序很要紧：磁盘是按路径排序的，照单全收的话预算会被排在最前面的
   * 点文件吃掉（`/root/.kube/config` 永远第一个），而学员正在改的
   * `/root/infra/*.yaml` 反倒挤不进去；`git clone` 之后 `.git/objects/**`
   * 更是能塞满整个预算。所以先把这类噪音排掉，再按「像不像学员在编辑的东西」
   * 排序。裁掉了几个也要报出来，别让模型以为它看到的是全部。
   */
  const NOISE = /(^|\/)\.git\/|(^|\/)node_modules\/|\.(lock|log)$/;
  const INTERESTING = /\.(ya?ml|json|conf|md|sh|toml|ini)$/;
  const candidates = Object.entries(options.files ?? {})
    .filter(([path]) => !NOISE.test(path))
    .sort(([a], [b]) => {
      const rank = (path: string) => (INTERESTING.test(path) ? 0 : 1);
      return rank(a) - rank(b) || (a === b ? 0 : a < b ? -1 : 1);
    });

  let filesBudget = MAX_FILES_TOTAL;
  const files: Array<{ path: string; content: string }> = [];
  let omittedFiles = 0;
  for (const [path, content] of candidates) {
    if (filesBudget <= 0) { omittedFiles += 1; continue; }
    const body = truncate(content, Math.min(MAX_FILE_CHARS, filesBudget));
    filesBudget -= body.length;
    files.push({ path, content: body });
  }
  omittedFiles += Object.keys(options.files ?? {}).length - candidates.length;

  return {
    namespace,
    nodes: nodes.slice(0, MAX_NODES),
    workloads,
    problems,
    events,
    commands,
    files,
    omitted: {
      objects: omittedObjects + Math.max(0, nodes.length - MAX_NODES),
      problems: omittedProblems,
      namespaces: Math.max(0, allNamespaces.length - detailed.size),
      commands: Math.max(0, history.length - recent.length),
      files: omittedFiles,
    },
  };
}

/** 判定结果也要压一压：整份报告里对模型有用的只有失败的那几条 */
export function summarizeReport(report: StageRunReport | null): OpsReportSummary | null {
  if (!report) return null;
  return {
    status: report.status,
    passed: report.totals.passed,
    total: report.totals.total,
    failing: report.cases
      .filter((item) => !item.passed)
      .slice(0, MAX_FAILING_CASES)
      .map((item) => ({
        name: [item.suite, item.name].filter(Boolean).join(' > '),
        // 断言在命令输出上的用例，报错里会带着整段输出
        error: truncate(item.error ?? '', MAX_CASE_ERROR),
      })),
    error: report.error ? truncate(report.error, MAX_CASE_ERROR) : undefined,
  };
}

export interface OpsReportSummary {
  status: string;
  passed: number;
  total: number;
  failing: Array<{ name: string; error: string }>;
  error?: string;
}
