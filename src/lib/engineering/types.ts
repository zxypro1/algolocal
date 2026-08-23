/**
 * 工程实战模块的数据模型
 *
 * 与算法题（Problem）最大的区别：
 * - 一道工程题是一个「多文件工程」，而不是一个函数
 * - 通过分阶段闯关（stage）推进，每关有自己的验收用例与工程指标
 * - 评审维度不只是「对不对」，还包括并发度、延迟、封装、优雅程度
 */

export interface LocalizedText {
  en: string;
  zh: string;
}

export type EngineeringDifficulty = 'Easy' | 'Medium' | 'Hard';

/** 工作区里的一个文件 */
export interface WorkspaceFile {
  path: string;
  content: string;
  /** 平台提供的基础设施文件，用户不可编辑（可读，用来理解接口约定） */
  readonly?: boolean;
  /** 是否默认在编辑器中打开 */
  openByDefault?: boolean;
}

/** 评审维度：既用于展示雷达图，也用于加权总分 */
export type DimensionKey =
  | 'correctness'
  | 'concurrency'
  | 'latency'
  | 'resilience'
  | 'encapsulation'
  | 'elegance';

export const DIMENSION_KEYS: DimensionKey[] = [
  'correctness',
  'concurrency',
  'latency',
  'resilience',
  'encapsulation',
  'elegance',
];

/** 项目声明各维度的权重，总和不必为 1，计算时会归一化 */
export type DimensionWeights = Partial<Record<DimensionKey, number>>;

export type GateOperator = 'lte' | 'lt' | 'gte' | 'gt' | 'eq';

/**
 * 工程指标门槛。指标由 lab 运行时采集（见 src/lib/engineering/lab.ts），
 * 例如「并发度不得超过 4」「虚拟总耗时不得超过 800ms」。
 */
export interface MetricGate {
  /** LabMetrics 上的路径，如 'maxConcurrency' / 'virtualElapsedMs' / 'requests.total' */
  metric: string;
  op: GateOperator;
  value: number;
  label: LocalizedText;
  unit?: string;
  /** 该门槛主要体现哪个维度，用于计分 */
  dimension?: DimensionKey;
  /**
   * 只对匹配的用例生效（匹配 "suite > case" 全名的子串）。
   * 不写则针对整次运行的聚合指标——注意如果 spec 里故意演示了低效实现，
   * 聚合指标会被拖累，这时应该用 scope 把门槛锁定到目标用例上。
   */
  scope?: string;
}

/** 隐藏的验收用例文件（用户不可见，运行时注入工作区） */
export interface SpecFile {
  path: string;
  content: string;
}

/** lab 网络模拟的配置，由每一关声明 */
export interface LabNetworkConfig {
  /** 默认单次请求的虚拟延迟（毫秒） */
  defaultLatencyMs?: number;
  /** 服务端允许的最大并发，超过即返回 429，用于逼出限流/背压设计 */
  serverConcurrencyLimit?: number;
  /** 随机失败概率 0~1，配合 seed 保证可复现 */
  failureRate?: number;
  seed?: number;
  /** 针对特定 endpoint 的覆盖配置 */
  endpoints?: Record<string, LabEndpointConfig>;
}

export interface LabEndpointConfig {
  latencyMs?: number;
  /** 前 N 次调用必定失败，用来考察重试与退避 */
  failFirstN?: number;
  /** 成功时固定返回的 payload */
  payload?: unknown;
  /** **失败**时返回的状态码（默认 500）。成功响应永远是 200。 */
  status?: number;
}

/** 一个关卡 */
export interface ProjectStage {
  id: string;
  title: LocalizedText;
  /**
   * 参考架构：这一关的参考代码结构，mermaid 流程图（flowchart TD）。
   * 是「一种可行的组织方式」，不是唯一答案。
   */
  architecture?: LocalizedText;
  /**
   * 本关任务：背景 + 通关标准 + 代码细节，一整块。
   *
   * 曾经拆成过「概述 / 详情」两块，但读的人要在两个 tab 之间来回跳才能
   * 拼出完整的一关，反而更碎 —— 合回一块。
   */
  goal: LocalizedText;
  /** 任务清单，用于左侧 checklist 展示 */
  checklist?: LocalizedText[];
  /** 渐进式提示，用户可逐条解锁 */
  hints?: LocalizedText[];
  /** 进入本关时解锁/追加到工作区的文件 */
  starterFiles?: WorkspaceFile[];
  /** 本关的验收用例（隐藏） */
  specs: SpecFile[];
  /** 本关的工程指标门槛 */
  gates?: MetricGate[];
  /** lab 网络模拟配置 */
  lab?: LabNetworkConfig;
  /** 本关重点考察的维度，用于 AI 评审聚焦 */
  focus?: DimensionKey[];
  /**
   * 常见坑：这一关最容易写错的做法，以及**为什么**会挂。
   * 和 hints 的区别是它不需要解锁——提前知道哪条路是死路，比事后调试更有价值。
   */
  pitfalls?: LocalizedText[];
  /** 延伸：真实世界里对应的东西（库、论文、线上事故），markdown */
  extension?: LocalizedText;
  /** 参考实现（通关后可查看） */
  referenceFiles?: WorkspaceFile[];
  /** 参考实现讲解，markdown */
  referenceNotes?: LocalizedText;
}

export interface EngineeringProject {
  id: string;
  title: LocalizedText;
  /** 卡片上的一句话简介 */
  summary: LocalizedText;
  difficulty: EngineeringDifficulty;
  /** 领域标签，如 concurrency / caching / pipeline */
  domain: string;
  tags: string[];
  estimatedMinutes?: number;
  /** 工作区语言，决定 Monaco 语法与是否需要 TS 转译 */
  language: 'typescript' | 'javascript';
  /** 需求文档，markdown */
  brief: LocalizedText;
  /** 架构说明，markdown（支持 mermaid） */
  architecture?: LocalizedText;
  /** 评审维度权重 */
  weights?: DimensionWeights;
  /** 初始工作区文件 */
  files: WorkspaceFile[];
  stages: ProjectStage[];
  /**
   * 其他编程语言的版本。
   * 内容只写一份 TypeScript，JS 版在构建时自动派生（见 scripts/derive-js-variant.js）。
   */
  variants?: Partial<Record<WorkspaceLanguage, ProjectVariant>>;
  /** AI 生成的项目会带上生成信息 */
  generatedAt?: string;
}

export type WorkspaceLanguage = 'typescript' | 'javascript';

/** 某个语言版本下被替换掉的那部分内容 */
export interface ProjectVariant {
  files: WorkspaceFile[];
  stages: Array<{
    id: string;
    starterFiles: WorkspaceFile[];
    referenceFiles: WorkspaceFile[];
    specs: SpecFile[];
  }>;
}

/* ------------------------------------------------------------------ */
/* 运行结果                                                             */
/* ------------------------------------------------------------------ */

export interface SpecCaseResult {
  suite: string[];
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  /** 断言失败时的期望/实际，便于 UI 直接展示 diff */
  expected?: string;
  actual?: string;
  /** 这条用例执行期间产生的输出。整体聚合在 StageRunReport.console 里。 */
  console?: ConsoleEntry[];
  /** 输出条数超过上限被截断 */
  consoleTruncated?: boolean;
}

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  /** 虚拟时钟时间 */
  at: number;
  /** user = 学员代码打的，system = 运行时/测试框架打的 */
  source: 'user' | 'system';
}

export interface RequestSample {
  url: string;
  startedAt: number;
  endedAt: number;
  ok: boolean;
  attempt: number;
  status: number;
  error?: string;
}

export interface LabMetrics {
  /** 虚拟时钟推进的总时长（毫秒），即「感知延迟」 */
  virtualElapsedMs: number;
  /** 观察到的最大并发请求数 */
  maxConcurrency: number;
  /** 并发时间线，用于图表 */
  concurrencyTimeline: Array<{ t: number; inFlight: number }>;
  requests: {
    total: number;
    ok: number;
    failed: number;
    /** 因超过服务端并发限制被拒绝的次数 */
    throttled: number;
    /** 重试次数（同一 url 的第 2 次及以后的调用） */
    retries: number;
    /** 去重命中：完全重复的 url 调用次数 */
    duplicated: number;
    byUrl: Record<string, number>;
  };
  samples: RequestSample[];
  /** 用户通过 @lab/metrics 打的自定义计数 */
  counters: Record<string, number>;
}

export interface GateResult {
  gate: MetricGate;
  actual: number;
  passed: boolean;
}

export interface StageRunReport {
  status: 'passed' | 'failed' | 'error';
  totals: { total: number; passed: number; failed: number };
  cases: SpecCaseResult[];
  gates: GateResult[];
  metrics: LabMetrics;
  console: ConsoleEntry[];
  /** 开了「录制轨迹」时才有 */
  trace?: import('../trace/types').ExecutionTrace;
  /** 真实墙钟耗时 */
  wallClockMs: number;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* 代码质量静态分析                                                     */
/* ------------------------------------------------------------------ */

export interface QualityFinding {
  severity: 'info' | 'warn' | 'error';
  message: LocalizedText;
  file?: string;
  line?: number;
}

export interface QualityReport {
  /** 0~100 */
  encapsulationScore: number;
  eleganceScore: number;
  metrics: {
    fileCount: number;
    totalLines: number;
    maxFileLines: number;
    maxFunctionLines: number;
    averageFunctionLines: number;
    maxCyclomatic: number;
    duplicatedBlocks: number;
    magicNumbers: number;
    commentRatio: number;
    /** 模块依赖图的最大出度，出度越高耦合越强 */
    maxFanOut: number;
    /** 是否存在循环依赖 */
    hasCycles: boolean;
    exportSurface: number;
  };
  findings: QualityFinding[];
}

export interface DimensionScore {
  key: DimensionKey;
  score: number;
  weight: number;
  /** 分数的来源说明 */
  detail: LocalizedText;
  /**
   * 这一维度这次运行里有没有可测的东西。
   * 没发过任何请求就谈不上并发和延迟，空工作区也谈不上封装 ——
   * 这种情况不参与总分，而不是默认给满分。
   */
  measured: boolean;
}

export interface ScoreCard {
  total: number;
  dimensions: DimensionScore[];
  /** 验收通过率，工程分按它折算：不对的实现谈不上工程质量 */
  passRate: number;
}

/* ------------------------------------------------------------------ */
/* AI 评审                                                              */
/* ------------------------------------------------------------------ */

export interface AiReviewIssue {
  title: string;
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  file?: string;
  detail: string;
  suggestion?: string;
}

export interface AiReview {
  summary: string;
  dimensions: Array<{ key: DimensionKey; score: number; comment: string }>;
  issues: AiReviewIssue[];
  strengths: string[];
  nextSteps: string[];
}
