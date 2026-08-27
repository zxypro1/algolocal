/**
 * 把 GPU 世界的快照排成给模型看的上下文
 *
 * 裁剪已经在客户端做完了（见 src/lib/gpulab/lab/aicontext.ts），这里只负责排版 ——
 * 以及再兜一次总量：客户端是可以被绕过的，服务端不该假设请求体是善意的。
 *
 * **排版顺序就是重要性顺序，而这个顺序和 ops 那边不一样。**
 * ops 是「先关卡、再终端、再集群哪儿不对」，因为答案通常在上一条报错里。
 * GPU 这边最常见的处境是「跑通了但指标没到线」，所以顺序是：
 * 关卡要求与门槛 → 上次验收的门槛实测值 → 当前 kernel 源码 → 剖析计量
 * → 竞态 → 集群通信 → 终端最近几条。
 * 门槛实测值排在源码前面，是因为它决定了「该往源码的哪儿看」。
 */
import type { LocalizedText } from '../engineering/types';
import type { GpuSnapshot, GpuReportSummary } from '../gpulab/lab/aicontext';

export interface GpuContext {
  projectTitle?: LocalizedText;
  projectSummary?: LocalizedText;
  stageIndex?: number;
  stageCount?: number;
  stageTitle?: LocalizedText;
  stageGoal?: LocalizedText;
  checklist?: LocalizedText[];
  /** 关卡声明的门槛（还没跑验收时也能让 AI 知道要达到什么） */
  gates?: Array<{ metric: string; label?: LocalizedText; op: string; value: number; unit?: string }>;
  snapshot?: GpuSnapshot;
  report?: GpuReportSummary | null;
}

const MAX_TOTAL_CHARS = 40000;
export const GPU_REVIEW_MAX_CHARS = 60000;

function pick(text: LocalizedText | undefined, language: 'en' | 'zh'): string {
  if (!text) return '';
  return text[language] || text.zh || text.en || '';
}

/** 大数字读起来费劲，给个人类单位；门槛比对用的还是原始值 */
function bytes(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB (${value} B)`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB (${value} B)`;
  return `${value} B`;
}

const OP_TEXT: Record<string, string> = {
  lte: '≤', gte: '≥', lt: '<', gt: '>', eq: '=',
};

/**
 * 门槛那一行是这份上下文里信息密度最高的一行，所以写全：
 * 指标路径、要求、实测、还差多少。「差多少」是模型自己算容易算错的东西，直接给。
 */
function gateLine(
  gate: { metric: string; label: string; op: string; target: number; actual: number; passed: boolean; unit?: string },
  zh: boolean
): string {
  const mark = gate.passed ? '✓' : '✗';
  const unit = gate.unit ? ` ${gate.unit}` : '';
  const op = OP_TEXT[gate.op] ?? gate.op;
  const head = `  ${mark} ${gate.label} [${gate.metric}] ${zh ? '要求' : 'requires'} ${op} ${gate.target}${unit}，${zh ? '实测' : 'measured'} ${gate.actual}${unit}`;
  if (gate.passed) return head;

  // 还差多少：比值比差值好读 —— 「超出 2.1 倍」比「超出 4.93」更能指方向
  const { op: rawOp, target, actual } = gate;
  let gap = '';
  if ((rawOp === 'lte' || rawOp === 'lt') && target > 0 && actual > target) {
    gap = zh ? `，超出 ${(actual / target).toFixed(2)} 倍` : `, ${(actual / target).toFixed(2)}x over`;
  } else if ((rawOp === 'gte' || rawOp === 'gt') && actual > 0 && actual < target) {
    gap = zh ? `，只到要求的 ${((actual / target) * 100).toFixed(0)}%` : `, only ${((actual / target) * 100).toFixed(0)}% of target`;
  }
  return head + gap;
}

export function buildGpuContext(
  context: GpuContext,
  language: 'en' | 'zh',
  maxChars: number = MAX_TOTAL_CHARS
): string {
  const zh = language === 'zh';
  const sections: string[] = [];

  /**
   * 排版之前先把形状补齐。
   *
   * 这个函数是路由的最后一站，而请求体是外面来的 —— 一个缺了 sources 的
   * snapshot 不该让整个路由抛 500。
   */
  const snapshot: GpuSnapshot = {
    profile: null,
    sources: [],
    commands: [],
    races: [],
    raceTotal: 0,
    cluster: null,
    omitted: { sources: 0, commands: 0, races: 0 },
    ...(context.snapshot ?? {}),
  };
  snapshot.sources = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  snapshot.commands = Array.isArray(snapshot.commands) ? snapshot.commands : [];
  snapshot.races = Array.isArray(snapshot.races) ? snapshot.races : [];

  /* ---- 关卡 ---- */
  const stageHead = [
    `${zh ? '项目' : 'Project'}: ${pick(context.projectTitle, language)}`,
    pick(context.projectSummary, language),
    `${zh ? '关卡' : 'Stage'} ${(context.stageIndex ?? 0) + 1}/${context.stageCount ?? '?'}: ${pick(context.stageTitle, language)}`,
    '',
    pick(context.stageGoal, language),
  ].filter(Boolean).join('\n');
  sections.push(`## ${zh ? '这一关' : 'This stage'}\n${stageHead}`);

  if (context.checklist?.length) {
    sections.push(
      `## ${zh ? '通关标准' : 'Done when'}\n` +
      context.checklist.map((item) => `- ${pick(item, language)}`).join('\n')
    );
  }

  /* ---- 门槛：这是最要紧的一段 ---- */
  const report = context.report;
  if (report?.gates?.length) {
    const failing = report.gates.filter((gate) => !gate.passed);
    const passing = report.gates.filter((gate) => gate.passed);
    const lines: string[] = [];
    if (failing.length) {
      lines.push(zh ? '没到线的：' : 'Not met:');
      lines.push(...failing.map((gate) => gateLine(gate, zh)));
    }
    if (passing.length) {
      lines.push(zh ? '已经到线的（改动别把它们弄坏）：' : 'Already met (do not regress these):');
      lines.push(...passing.map((gate) => gateLine(gate, zh)));
    }
    sections.push(`## ${zh ? '上次验收的门槛' : 'Gates from the last run'}\n${lines.join('\n')}`);
  } else if (context.gates?.length) {
    // 还没跑过验收：至少让 AI 知道这一关要达到什么
    sections.push(
      `## ${zh ? '这一关的门槛（还没跑过验收）' : 'Gates for this stage (not run yet)'}\n` +
      context.gates.map((gate) => {
        const op = OP_TEXT[gate.op] ?? gate.op;
        const unit = gate.unit ? ` ${gate.unit}` : '';
        return `  · ${pick(gate.label, language) || gate.metric} [${gate.metric}] ${op} ${gate.value}${unit}`;
      }).join('\n')
    );
  }

  /* ---- 验收用例 ---- */
  if (report) {
    const head = `${zh ? '状态' : 'Status'}: ${report.status} — ${report.passed}/${report.total} ${zh ? '用例通过' : 'cases passed'}`;
    const failing = report.failing?.length
      ? '\n' + report.failing.map((item) => `  ✗ ${item.name}\n    ${item.error.split('\n').join('\n    ')}`).join('\n')
      : '';
    const err = report.error ? `\n${zh ? '运行错误' : 'Run error'}: ${report.error}` : '';
    sections.push(`## ${zh ? '上次验收' : 'Last verification'}\n${head}${failing}${err}`);
  }

  /* ---- 当前 kernel 源码 ---- */
  if (snapshot.sources.length) {
    const body = snapshot.sources
      .map((file) => `### ${file.path}${file.truncated ? zh ? '（已截断）' : ' (truncated)' : ''}\n\`\`\`cuda\n${file.content}\n\`\`\``)
      .join('\n\n');
    sections.push(`## ${zh ? '学员当前的源码' : 'Their current source'}\n${body}`);
  }

  /* ---- 剖析计量 ---- */
  const profile = snapshot.profile;
  if (profile) {
    const lines = [
      `${zh ? '设备' : 'Device'}: ${profile.device}`,
      `${zh ? '访存合并' : 'Coalescing'}: sectorsPerRequest = ${profile.sectorsPerRequest.toFixed(2)} (${zh ? '完全合并 4.0，完全发散 32.0' : '4.0 fully coalesced, 32.0 fully scattered'})`,
      `${zh ? '全局访存扇区' : 'Global sectors'}: load ${profile.globalLoadSectors}, store ${profile.globalStoreSectors}`,
      `DRAM: read ${bytes(profile.dramReadBytes)}, write ${bytes(profile.dramWriteBytes)}`,
      `${zh ? '共享内存 bank 冲突' : 'Shared bank conflicts'}: ${profile.sharedBankConflicts}`,
      `${zh ? '本地内存（寄存器溢出）' : 'Local memory (register spill)'}: ${bytes(profile.localBytes)}`,
      `${zh ? '分支发散' : 'Divergent branches'}: ${profile.divergentBranches}, ${zh ? '活跃 lane 比例' : 'active lane ratio'} ${profile.activeLaneRatio.toFixed(3)}`,
      `${zh ? '原子操作' : 'Atomics'}: ${profile.atomics}`,
      `${zh ? '指令' : 'Instructions'}: warp ${profile.inst.warpExecuted}, fma ${profile.inst.fma}, ldst ${profile.inst.ldst}, sfu ${profile.inst.sfu}, mma ${profile.inst.mma}`,
      `${zh ? '启动' : 'Launch'}: ${profile.launch.blocks} blocks, ${profile.launch.warps} warps, ${profile.launch.barriers} barriers, ${profile.launch.kernels} kernels`,
      `${zh ? '寄存器/线程' : 'Registers/thread'}: ${profile.registersPerThread}, ${zh ? '理论占用率' : 'theoretical occupancy'} ${(profile.occupancy * 100).toFixed(1)}% (${profile.warpsPerSm} warps/SM)`,
      `${zh ? '显存峰值' : 'Peak device memory'}: ${bytes(profile.memoryPeakBytes)}`,
      `${zh ? '算术强度' : 'Arithmetic intensity'}: ${profile.arithmeticIntensity.toFixed(3)} FLOP/byte`,
      // 周期数放最后并且带上警告：它是估的，不能当绝对值用
      `${zh ? '模拟周期' : 'Simulated cycles'}: ${profile.cycles}${profile.bottleneck ? `, ${zh ? '瓶颈' : 'bottleneck'} ${profile.bottleneck}` : ''} — ${zh ? '**只能同关相对比较，没有真卡校准，不要当绝对性能**' : '**relative comparison within this stage only; not calibrated against real hardware**'}`,
    ];
    sections.push(`## ${zh ? '剖析计量（上次运行）' : 'Profile counters (last run)'}\n${lines.join('\n')}`);
  }

  /* ---- 竞态 ---- */
  if (snapshot.raceTotal > 0) {
    const lines = snapshot.races.map(
      (race) => `  ${race.space} @ 0x${race.address.toString(16)} — ${zh ? '行' : 'line'} ${race.firstLine} ↔ ${race.secondLine}`
    );
    const more = snapshot.omitted.races > 0
      ? `\n  ${zh ? `（还有 ${snapshot.omitted.races} 条同类记录没列出来）` : `(${snapshot.omitted.races} more not listed)`}`
      : '';
    sections.push(`## ${zh ? 'compute-sanitizer 竞态' : 'compute-sanitizer races'}\n${zh ? '共' : 'total'} ${snapshot.raceTotal}\n${lines.join('\n')}${more}`);
  }

  /* ---- 集群 ---- */
  if (snapshot.cluster) {
    sections.push(
      `## ${zh ? '集群通信' : 'Cluster communication'}\n` +
      `${zh ? '通信量' : 'comm'}: ${JSON.stringify(snapshot.cluster.comm)}\n` +
      `${zh ? '流水线' : 'pipeline'}: ${JSON.stringify(snapshot.cluster.pipeline)}\n` +
      `${zh ? '负载不均衡度' : 'imbalance'}: ${snapshot.cluster.imbalance.toFixed(4)}`
    );
  }

  /* ---- 终端 ---- */
  if (snapshot.commands.length) {
    const lines = snapshot.commands.map((entry) => {
      const mark = entry.code === 0 ? '' : ` (exit ${entry.code})`;
      return `$ ${entry.command}${mark}\n${entry.output || (zh ? '（无输出）' : '(no output)')}`;
    });
    const more = snapshot.omitted.commands > 0
      ? `\n${zh ? `（更早的 ${snapshot.omitted.commands} 条没列出来）` : `(${snapshot.omitted.commands} earlier commands not listed)`}`
      : '';
    sections.push(`## ${zh ? '终端最近的命令' : 'Recent terminal commands'}\n${lines.join('\n\n')}${more}`);
  }

  const text = sections.join('\n\n');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n…${zh ? '（上下文超长，已截断）' : '(context truncated)'}`;
}
