/**
 * 把一个 GPU 世界压成 AI 能吃下的快照
 *
 * 和 ops 那边同一个思路（裁剪发生在客户端，服务端只排版），但**要给的东西完全不同**。
 *
 * ops 的学员卡住时，答案通常在上一条命令的报错里。GPU 这边不是：
 * 学员最常见的处境是「结果算对了，但某个指标没到线」—— 代码能跑、用例全绿、
 * 就是门槛红着。这种时候光看报错没有用，得知道**差多少、差在哪个计量上**。
 * 所以这份快照的重心是：当前 kernel 源码 + 上次验收的门槛实测值 + 剖析计量。
 *
 * **绝对不要把访存轨迹放进来。** `AccessTrace` 是逐次访存的记录，
 * 一个 N=256 的 GEMM 就是几十万条；它存在的意义是算出扇区数与 bank 冲突数，
 * 而那两个数已经在 metrics 里了。要的是结论，不是原始轨迹。
 *
 * 所有上限都写在这个文件里，`tests/gpulab/aicontext.test.ts` 盯着它们。
 */
import type { CommandRecord } from '../../labkit/machine';
import type { GateResult, StageRunReport } from '../../engineering/types';
import { HOST_HEADERS } from '../host/headers';
import { gpuMetricTree } from './runner';
import type { GpuWorld } from './world';

/**
 * 终端历史的预算，两种用法差别很大，所以做成两套（同 ops）。
 *
 * 对话是「看着刚才那条 nvcc 报错问」：条数少，单条输出要给全 ——
 * `ncu` 的一节输出、compute-sanitizer 的竞态报告都不短，截狠了等于没给。
 * 复盘问的是「这一关他是怎么优化过来的」：**编译与验收的先后顺序**本身就是被评的东西，
 * 所以条数放宽、单条压短。
 */
export interface GpuSnapshotLimits {
  commands: number;
  commandOutput: number;
}

const CHAT_LIMITS: GpuSnapshotLimits = { commands: 8, commandOutput: 1600 };
const REVIEW_LIMITS: GpuSnapshotLimits = { commands: 40, commandOutput: 500 };

export const GPU_SNAPSHOT_LIMITS = { chat: CHAT_LIMITS, review: REVIEW_LIMITS };

/**
 * 单个源文件截到多少字符。
 *
 * 给得比 ops 的文件预算宽：那边的 manifest 是配角，这边的 kernel 源码是**主角** ——
 * 少给一半等于让 AI 对着半个 kernel 猜。一关的 .cu 通常一两百行，8000 字符够装。
 */
const MAX_SOURCE_CHARS = 8000;
/** 所有源文件加起来的预算 */
const MAX_SOURCES_TOTAL = 20000;
/** 最多带几个源文件 */
const MAX_SOURCES = 6;
/** 失败用例最多带几条 */
const MAX_FAILING_CASES = 6;
/** 单条失败用例的报错截到多少字符 */
const MAX_CASE_ERROR = 800;
/** 单条命令本身截到多少字符 */
const MAX_COMMAND_TEXT = 300;
/**
 * 竞态最多带几条。
 *
 * sanitizer 自己上限 32 条，但同一个 bug 往往报出几十条长得一模一样的记录。
 * 带前几条 + 总数就够定位了，剩下的让学员自己跑 compute-sanitizer 看。
 */
const MAX_RACES = 5;

export interface GpuSnapshotSource {
  path: string;
  content: string;
  truncated: boolean;
}

export interface GpuSnapshotCommand {
  command: string;
  code: number;
  output: string;
}

export interface GpuSnapshotRace {
  space: 'global' | 'shared';
  address: number;
  firstLine: number;
  secondLine: number;
}

/** 剖析面板上那些数，摊平成一层，名字和门槛里写的 metric 路径对得上 */
export interface GpuSnapshotProfile {
  device: string;
  sectorsPerRequest: number;
  globalLoadSectors: number;
  globalStoreSectors: number;
  dramReadBytes: number;
  dramWriteBytes: number;
  sharedBankConflicts: number;
  localBytes: number;
  divergentBranches: number;
  activeLaneRatio: number;
  atomics: number;
  inst: { warpExecuted: number; fma: number; ldst: number; sfu: number; mma: number };
  launch: { blocks: number; warps: number; barriers: number; kernels: number };
  registersPerThread: number;
  occupancy: number;
  warpsPerSm: number;
  memoryPeakBytes: number;
  arithmeticIntensity: number;
  /** 模拟周期数：**只能同关相对比较，不能当绝对值**，提示词里也这么写 */
  cycles: number;
  bottleneck: string;
}

/** 集群关卡才有 */
export interface GpuSnapshotCluster {
  comm: unknown;
  pipeline: unknown;
  imbalance: number;
}

export interface GpuSnapshot {
  profile: GpuSnapshotProfile | null;
  sources: GpuSnapshotSource[];
  commands: GpuSnapshotCommand[];
  races: GpuSnapshotRace[];
  raceTotal: number;
  cluster: GpuSnapshotCluster | null;
  omitted: { sources: number; commands: number; races: number };
}

export interface GpuSnapshotOptions {
  /** 学员正在编辑的源码：路径 -> 内容 */
  sources?: Record<string, string>;
  history?: CommandRecord[];
  limits?: Partial<GpuSnapshotLimits>;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（截断，原文 ${text.length} 字符）`;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 计量树是 unknown 的嵌套，取一个路径上的数 */
function at(tree: Record<string, unknown>, path: string): number {
  let node: unknown = tree;
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object') return 0;
    node = (node as Record<string, unknown>)[key];
  }
  return num(node);
}

function buildProfile(world: GpuWorld): GpuSnapshotProfile | null {
  let tree: Record<string, unknown>;
  try {
    tree = gpuMetricTree(world);
  } catch {
    // 世界还没跑过 kernel 时取计量可能抛，这时没有剖析数据也是合理状态
    return null;
  }
  const timing = tree.timing as { cycles?: number } | undefined;
  return {
    device: world.gpu.device?.name ?? 'unknown',
    sectorsPerRequest: at(tree, 'global.sectorsPerRequest'),
    globalLoadSectors: at(tree, 'global.loadSectors'),
    globalStoreSectors: at(tree, 'global.storeSectors'),
    dramReadBytes: at(tree, 'memory.readBytes'),
    dramWriteBytes: at(tree, 'memory.writeBytes'),
    sharedBankConflicts: at(tree, 'shared.bankConflicts'),
    localBytes: at(tree, 'local.bytes'),
    divergentBranches: at(tree, 'warp.divergentBranches'),
    activeLaneRatio: at(tree, 'warp.activeLaneRatio'),
    atomics: at(tree, 'atomics'),
    inst: {
      warpExecuted: at(tree, 'inst.warpExecuted'),
      fma: at(tree, 'inst.fma'),
      ldst: at(tree, 'inst.ldst'),
      sfu: at(tree, 'inst.sfu'),
      mma: at(tree, 'inst.mma'),
    },
    launch: {
      blocks: at(tree, 'launch.blocks'),
      warps: at(tree, 'launch.warps'),
      barriers: at(tree, 'launch.barriers'),
      kernels: at(tree, 'launch.kernels'),
    },
    registersPerThread: at(tree, 'registers.perThread'),
    occupancy: at(tree, 'occupancy.theoretical'),
    warpsPerSm: at(tree, 'occupancy.warpsPerSm'),
    memoryPeakBytes: at(tree, 'memoryPeakBytes'),
    arithmeticIntensity: at(tree, 'arithmeticIntensity'),
    cycles: num(timing?.cycles),
    bottleneck: String((world.gpu.timing?.() as { bottleneck?: string } | undefined)?.bottleneck ?? ''),
  };
}

export function buildGpuSnapshot(world: GpuWorld, options: GpuSnapshotOptions = {}): GpuSnapshot {
  const limits: GpuSnapshotLimits = { ...CHAT_LIMITS, ...(options.limits ?? {}) };

  /*
   * 源码：kernel 是主角，先给声明过的那些。
   *
   * **平台的只读头文件要剔掉。** containers.h / engine.h / cuda_runtime.h 这些
   * 是平台发的，学员改不了也不会改，每一关内容还完全一样 ——
   * 把它们塞进去只会挤掉真正的 kernel（实测第 5 关就被 cluster.h 占了一段预算）。
   * 模型需要知道这些接口时，提示词里让它让学员 `cat containers.h` 就够了。
   *
   * IDE 里仍然照常列出来：学员是要读它们的，那是另一回事。
   */
  const entries = Object.entries(options.sources ?? {})
    .filter(([path]) => !(path in HOST_HEADERS));
  const sources: GpuSnapshotSource[] = [];
  let sourceBudget = MAX_SOURCES_TOTAL;
  for (const [path, content] of entries) {
    if (sources.length >= MAX_SOURCES || sourceBudget <= 0) break;
    const room = Math.min(MAX_SOURCE_CHARS, sourceBudget);
    const truncated = content.length > room;
    const text = truncated ? clip(content, room) : content;
    sources.push({ path, content: text, truncated });
    sourceBudget -= text.length;
  }

  const history = options.history ?? [];
  const recent = history.slice(-limits.commands);
  const commands: GpuSnapshotCommand[] = recent.map((record) => ({
    command: clip(record.command ?? '', MAX_COMMAND_TEXT),
    code: num(record.code),
    // stderr 在前：nvcc 的报错在 stderr 上，截断时不能先把它扔掉
    output: clip(
      [record.stderr, record.stdout].filter(Boolean).join('\n').trim(),
      limits.commandOutput
    ),
  }));

  let races: GpuSnapshotRace[] = [];
  let raceTotal = 0;
  try {
    const report = world.gpu.sanitizerReport();
    raceTotal = report.races.length + report.truncated;
    races = report.races.slice(0, MAX_RACES).map((race) => ({
      space: race.space,
      address: race.address,
      firstLine: race.first.line,
      secondLine: race.second.line,
    }));
  } catch {
    /* 没跑过就没有报告 */
  }

  let cluster: GpuSnapshotCluster | null = null;
  if (world.cluster) {
    try {
      cluster = {
        comm: world.cluster.comm,
        pipeline: world.cluster.pipeline,
        imbalance: num(world.cluster.imbalance()),
      };
    } catch {
      cluster = null;
    }
  }

  return {
    profile: buildProfile(world),
    sources,
    commands,
    races,
    raceTotal,
    cluster,
    omitted: {
      sources: Math.max(0, entries.length - sources.length),
      commands: Math.max(0, history.length - commands.length),
      races: Math.max(0, raceTotal - races.length),
    },
  };
}

export interface GpuGateSummary {
  metric: string;
  label: string;
  op: string;
  target: number;
  actual: number;
  passed: boolean;
  unit?: string;
}

export interface GpuReportSummary {
  status: string;
  passed: number;
  total: number;
  failing: Array<{ name: string; error: string }>;
  /** **全部**门槛，不只失败的：AI 要看得出「哪些已经到线了，别把它们改坏」 */
  gates: GpuGateSummary[];
  error?: string;
}

function gateLabel(gate: GateResult['gate'], language: 'en' | 'zh'): string {
  const label = gate.label as unknown;
  if (typeof label === 'string') return label;
  if (label && typeof label === 'object') {
    const localized = label as Record<string, string>;
    return localized[language] ?? localized.zh ?? localized.en ?? gate.metric;
  }
  return gate.metric;
}

/**
 * 把上次验收压成摘要。
 *
 * **门槛全带上，并且带实测值** —— 这是这个场景最关键的一段上下文。
 * 「sectorsPerRequest 要 ≤ 4.5，实测 9.43」和「有个门槛没过」是完全不同的信息量：
 * 前者能直接推出「访存没合并，差一倍多」，后者只能让 AI 泛泛地讲优化。
 */
export function summarizeGpuReport(
  report: StageRunReport | null,
  language: 'en' | 'zh' = 'zh'
): GpuReportSummary | null {
  if (!report) return null;
  return {
    status: report.status,
    passed: report.totals.passed,
    total: report.totals.total,
    failing: report.cases
      .filter((item) => !item.passed && item.error !== 'skipped')
      .slice(0, MAX_FAILING_CASES)
      .map((item) => ({
        name: `${item.suite} > ${item.name}`,
        error: clip(item.error ?? '', MAX_CASE_ERROR),
      })),
    gates: (report.gates ?? []).map((result) => ({
      metric: result.gate.metric,
      label: gateLabel(result.gate, language),
      op: result.gate.op,
      target: result.gate.value,
      actual: result.actual,
      passed: result.passed,
      unit: result.gate.unit,
    })),
    ...(report.error ? { error: clip(report.error, MAX_CASE_ERROR) } : {}),
  };
}
