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
   * 动手前的基础讲解。
   *
   * 假设读者会写函数、条件和常见数据结构，但没有接触过本关所属的技术领域。
   * 这里负责解释术语、运行过程，以及练习中的模型和真实系统之间的对应关系。
   */
  primer: LocalizedText;
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
  /** ops 形态的关卡增量（workspace.kind === 'ops' 时才有意义） */
  ops?: OpsStageSpec;
  /** gpu 形态的关卡增量（workspace.kind === 'gpu' 时才有意义） */
  gpu?: GpuStageSpec;
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

/**
 * 工作台形态：这个项目需要哪些面板。
 *
 * 起初只有一种形态（任务描述 + IDE + 结果面板），布局直接写死在
 * pages/projects/[id].tsx 里。要加入内网设施这类项目之后，工作台需要按项目组合
 * ——终端、拓扑图这些面板只对特定形态有意义。
 *
 * 这里声明的是**形态**而不是布局坐标：面板怎么摆是代码的事，
 * 题目只回答「这是哪一类实验台」。
 */
export type WorkspaceKind = 'code' | 'ops' | 'gpu';

/** 现有形态：多文件工作区 + 隐藏用例 + 指标门槛 */
export interface CodeWorkspaceSpec {
  kind: 'code';
}

/**
 * 内网设施形态：终端 + IDE + 拓扑图 + 任务。
 *
 * 世界定义放在项目上而不是每关一份：一个项目就是「一家公司的内网」，
 * 关卡是这张网上依次发生的事情，各关只写自己的增量。
 */
export interface OpsWorkspaceSpec {
  kind: 'ops';
  world?: OpsWorldSpec;
}

/** 集群里的一台节点 */
export interface OpsNodeSpec {
  name: string;
  /** 可分配 CPU，如 `4` 或 `4000m` */
  cpu?: string;
  memory?: string;
  labels?: Record<string, string>;
  /** 打上之后调度器不再往这里放新 Pod */
  unschedulable?: boolean;
}

/** 镜像目录里的一条：不在目录里的镜像拉不到，会进 ImagePullBackOff */
/**
 * 一个镜像在这个世界里怎么表现。
 *
 * 时间之外的字段是**运行时行为**：端口上有没有人听、HTTP 路径返回什么、
 * 吃多少内存。关卡的镜像表就是靠它们把「这个服务是什么样」写清楚的，
 * 而不是靠宿主认识某个具体的镜像名。
 */
export interface OpsImageSpec {
  /** 拉取耗时（虚拟毫秒） */
  pullMs?: number;
  /** 启动到进程就绪的耗时 */
  startupMs?: number;
  /** 就绪探针通过还要多久 */
  readyAfterMs?: number;
  /** 缺了这些环境变量就崩 */
  needsEnv?: string[];
  /** 真正在听的端口 */
  listens?: number[];
  /** HTTP 路径 -> 状态码。没列出的路径按 404 算。 */
  routes?: Record<string, number>;
  /** 声明的内存占用，如 `220Mi`。超过 limit 就 OOMKilled。 */
  memoryUsage?: string;
  /** 收到 SIGTERM 会不会先摘流量再优雅退出 */
  handlesSigterm?: boolean;
  /** 以哪个 uid 跑（Dockerfile 里的 USER）。0 表示 root。 */
  runAsUser?: number;
  /**
   * 这个镜像是不是一个会执行 NetworkPolicy 的 CNI。
   *
   * 只要世界里有任何一个镜像写了这一条，「CNI 执不执行策略」就成为这个世界的
   * 一个维度：没有执行者时策略对象还在，但一个包都不拦。
   */
  enforcesNetworkPolicy?: boolean;
  /**
   * 稳定状态下每秒处理多少请求。指标从这里长出来，不是伪造的。
   */
  requestsPerSecond?: number;
  /** 其中多少比例是 5xx。注入故障就是把这个数调上去。 */
  errorRatio?: number;
}

/** 内网的密钥库（OpenBao） */
export interface OpsSecretStoreSpec {
  /** 地址，如 `https://openbao.corp.internal:8200` */
  address: string;
  /** 初始内容：路径 -> 键值 */
  data?: Record<string, Record<string, string>>;
  /** 策略：名字 -> 路径 -> 能力 */
  policies?: Record<string, Record<string, string[]>>;
  /** 发好的静态令牌：token -> 策略名 */
  tokens?: Record<string, string>;
  /**
   * Kubernetes 认证的角色。不声明就是「这台还没开 Kubernetes auth」，
   * ESO 只能用静态令牌 —— 而那本身又是一个要保管的密钥。
   */
  kubernetesRoles?: Record<string, { boundServiceAccounts: string[]; policy: string }>;
}

/** 内网 Git 服务上的一个仓库 */
export interface OpsGitRepositorySpec {
  /** 完整 URL，如 `https://git.corp.internal/platform/apps` */
  url: string;
  /** 默认分支，不写就是 main */
  branch?: string;
  /** 初始内容：仓库内相对路径 -> 文件内容 */
  files?: Record<string, string>;
  /** 首次提交的说明 */
  message?: string;
  /** 只读的仓库 push 会被 403 拒掉 */
  readOnly?: boolean;
}

/** 一个私有镜像仓库 */
export interface OpsRegistrySpec {
  host: string;
  /** 用户名 -> 密码。空表示匿名可用。 */
  users?: Record<string, string>;
  /** 允许推送到哪些项目（第一段路径） */
  projects?: string[];
  anonymousPull?: boolean;
}

/** 学员面前那台跳板机 */
export interface OpsMachineSpec {
  hostname?: string;
  user?: string;
  cwd?: string;
  /** 开局就在磁盘上的文件 */
  files?: Record<string, string>;
  /** `git commit` 的署名。真机上来自 ~/.gitconfig。 */
  gitIdentity?: { name: string; email: string };
}

/** 这家公司的内网长什么样 */
export interface OpsWorldSpec {
  seed?: number;
  /** 世界的起始时刻，ISO8601。固定住，AGE 列才可复现。 */
  startTime?: string;
  /** 这个集群已经跑了多少天。不填按 32 天算 —— 接手的从来不是新集群。 */
  clusterAgeDays?: number;
  nodes?: OpsNodeSpec[];
  namespaces?: string[];
  images?: Record<string, OpsImageSpec>;
  /**
   * 本地已经有的基础镜像，`FROM` 得着。
   *
   * 值是工具链的名字：`node` 的镜像里有 npm，`python` 的有 pip。
   * 具体命令的行为写在 src/lib/opslab/lab/toolchains.ts 里 —— 行为写不进 JSON。
   */
  baseImages?: Record<string, 'node' | 'python' | 'static'>;
  registries?: OpsRegistrySpec[];
  /**
   * 集群认哪些身份。
   *
   * key 是 kubeconfig 里的 token。一旦声明了这张表，集群就开始按 RBAC 鉴权 ——
   * 不声明就是「这个世界不讲 RBAC」，所有请求都是 cluster-admin。
   */
  users?: Record<string, { username: string; groups?: string[] }>;
  /** 内网的 Git 仓库。GitOps 里那份 YAML 就住在这儿。 */
  gitRepositories?: OpsGitRepositorySpec[];
  /** 内网的密钥库。真正的密钥住在这儿，集群里只有投影。 */
  secretStore?: OpsSecretStoreSpec;
  machine?: OpsMachineSpec;
  /** 集群外的名字：`git.corp.internal` -> ['10.10.0.30'] */
  externalHosts?: Record<string, string[]>;
  /**
   * 内网 PKI 的初态。
   *
   * 题目只声明「有哪些 CA、谁签谁、哪张证书故意做坏了」，真正的密钥与 DER
   * 由运行时用真 RSA 生成 —— 学员导出来的 PEM 是货真价实的。
   */
  pki?: OpsPkiSpec;
  /**
   * 负载均衡地址池。
   *
   * `loadBalancerClass` 决定从哪个池子分地址，也决定这个地址能被谁访问到。
   * 「内网入口」与「公网入口」的分野在这里。
   */
  addressPools?: Array<{
    loadBalancerClass: string;
    cidrPrefix: string;
    zones: Array<'office' | 'internet'>;
  }>;
  /**
   * 哪些主机名解析得到 apiserver。
   *
   * 不填就是 `apiserver.opslab`。写错 server 的 kubeconfig 应该连不上，
   * 否则「context 选错了」这种题目根本没法出。
   */
  endpoints?: string[];
  /** 开局就存在的集群对象 */
  objects?: Record<string, unknown>[];
  /**
   * 盘上开局就有的数据。
   *
   * key 是 PVC 的 `命名空间/名字`，value 是**卷内的相对路径**到内容。
   * 之所以不能写在 objects 里：这些字节根本不在 apiserver 上，它们在存储
   * 后端。而「已经在跑的库里有数据」是备份这类题目的前提 —— 没有数据，
   * 「恢复成功」和「恢复出一块空盘」看起来一模一样。
   */
  volumes?: Record<string, Record<string, string>>;
}

/** 内网 PKI 的初态 */
export interface OpsPkiSpec {
  /** 自签的根 CA */
  roots?: Array<{ name: string; namespace: string; commonName: string; days?: number }>;
  /** 由某个根签出来的中间 CA。`signedBy` 写根的 Secret 名。 */
  intermediates?: Array<{
    name: string; namespace: string; commonName: string; signedBy: string; days?: number;
  }>;
  /** 预先造好的服务器证书。用来布置现场，包括故意做坏的那些。 */
  serverCertificates?: Array<{
    name: string;
    namespace: string;
    commonName: string;
    dnsNames?: string[];
    /** 由哪个 CA 的 Secret 签 */
    signedBy: string;
    days?: number;
    /**
     * 只把叶子放进 tls.crt，不带签发链。
     *
     * 这是「中间证书没带全」那个经典坑：浏览器有时候能打开（缓存过中间证书），
     * 服务之间的调用一定失败。
     */
    leafOnly?: boolean;
    /** 签成已经过期的，`expiredDaysAgo` 天前就到期了 */
    expiredDaysAgo?: number;
  }>;
  /** 哪些根装进跳板机的信任库 */
  trust?: string[];
}

/**
 * 一关在世界上加的增量。
 *
 * 判定仍然走隐藏用例（`stage.specs`），只是那些 TS 里 import 的是
 * `@ops/lab` 而不是 `@lab/net`。
 */
export interface OpsStageSpec {
  /** 进入本关时往机器磁盘上放的文件 */
  files?: Record<string, string>;
  /** 进入本关时往集群里塞的对象 */
  objects?: Record<string, unknown>[];
  /** 进入本关时先替学员跑一遍的命令（布置现场，比如「上一关留下的烂摊子」） */
  setupCommands?: string[];
  /** 额外的镜像目录条目 */
  images?: Record<string, OpsImageSpec>;
  /**
   * 参考解：把这一关做对需要敲的命令。
   *
   * 反向验证靠它：跑完这串命令，隐藏用例必须全绿；不跑，必须挂。
   * 一关的题面和判定对不对，只有这一条能说了算。
   */
  referenceCommands?: string[];
  /** 参考解顺带写下的文件（比如学员要自己写的 manifest） */
  referenceFiles?: Record<string, string>;
  /**
   * 盘上开局就有的数据。
   *
   * 和 `OpsWorldSpec.volumes` 同一个形状，只是作用在这一关：
   * key 是 PVC 的 `命名空间/名字`，value 是卷内相对路径到内容。
   */
  volumes?: Record<string, Record<string, string>>;
  /**
   * 学员自己写的 Operator。
   *
   * 声明了它，世界就会把 `path` 那个文件当成一个控制器跑起来：watch 事件、
   * 调它导出的 reconcile、给它一个 apiserver 客户端。文件改了立刻生效
   * （真集群里这一步是重新构建镜像再发布）。
   */
  operator?: {
    /** 代码在机器磁盘上的位置 */
    path: string;
    /** 它管的自定义资源的 kind */
    kind: string;
    /** 它那个 Deployment 的 `app.kubernetes.io/name`。停掉它，自定义资源就没人管了。 */
    name: string;
  };
}

/**
 * GPU 形态：任务 + 终端 + IDE + 剖析 + 访存（+ 后半程的集群）。
 *
 * 世界（这是一台什么卡、磁盘上有什么、`./bench` 跑什么）放在项目上，
 * 每一关只写自己的增量 —— 和 ops 形态一个路子。
 */
export interface GpuWorkspaceSpec {
  kind: 'gpu';
  world?: import('../gpulab/lab').GpuWorldSpec;
}

/**
 * 一关在 GPU 世界上加的增量。
 *
 * 判定仍然走隐藏用例（`stage.specs`），只是那些 TS 里 import 的是
 * `@gpu/lab`。
 */
export interface GpuStageSpec {
  /** 进入本关时往机器磁盘上放的文件（一般就是那个 .cu） */
  files?: Record<string, string>;
  /** 这一关的 `./bench` 跑什么。不写就沿用世界里的。 */
  bench?: import('../gpulab/lab').BenchSpec;
  /** 每 block 共享内存上限的覆盖（比如需要 96KB 的关卡） */
  sharedBytesPerBlock?: number;
  /** 进入本关时先替学员跑一遍的命令 */
  setupCommands?: string[];
  /**
   * 参考解：把这一关做对的那份 kernel 源码。
   *
   * 反向验证靠它 —— 用参考解跑，用例与门槛必须全绿；用起始代码跑，必须挂。
   */
  referenceFiles?: Record<string, string>;
  /** 参考解顺带要敲的命令 */
  referenceCommands?: string[];
}

export type WorkspaceSpec = CodeWorkspaceSpec | OpsWorkspaceSpec | GpuWorkspaceSpec;

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
  /**
   * 工作台形态。不写等同于 `{ kind: 'code' }` —— 现有项目一个字段都不用加，
   * 走的也仍然是原来那条代码路径。
   */
  workspace?: WorkspaceSpec;
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
  /**
   * GPU 关卡的指标树。
   *
   * 门槛直接写路径，比如
   * `{ metric: 'gpu.global.sectorsPerRequest', op: 'lte', value: 4.5 }` ——
   * `getMetricValue` 本来就会一层层走下去，不用改解析。
   */
  gpu?: Record<string, unknown>;
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

/* ------------------------------------------------------------------ *
 * ops 工作台的 AI 复盘
 *
 * 和代码形态的 AiReview 是两回事：那边评的是「这段代码能不能合」，这边评的是
 * 「这一关他是怎么操作过来的」—— 学员没写代码，他敲了一串命令、改了几个
 * manifest，把集群从坏改成好。所以维度也不一样，判分看的是排查路径本身。
 * ------------------------------------------------------------------ */

export const OPS_DIMENSION_KEYS = ['diagnosis', 'outcome', 'safety', 'efficiency', 'understanding'] as const;

export type OpsDimensionKey = (typeof OPS_DIMENSION_KEYS)[number];

export interface OpsReviewIssue {
  title: string;
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  /** 出问题的地方：一条命令、一个集群对象，或者一个文件 */
  where?: string;
  detail: string;
  suggestion?: string;
}

export interface OpsReview {
  summary: string;
  dimensions: Array<{ key: OpsDimensionKey; score: number; comment: string }>;
  issues: OpsReviewIssue[];
  strengths: string[];
  nextSteps: string[];
}
