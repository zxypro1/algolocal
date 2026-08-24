/**
 * 工程实战项目的结构校验与自动验证
 *
 * AI 生成一道工程题的失败模式很多：漏字段、specs 引用了不存在的模块、
 * 参考实现其实跑不过自己的用例。所以生成之后我们**真的把它跑一遍**——
 * 用参考实现跑该关的隐藏用例，全绿才算这道题成立。
 */
import type { EngineeringProject, ProjectStage, StageRunReport, WorkspaceFile } from './types';

const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

function isLocalized(value: any): boolean {
  return !!value && typeof value === 'object' && (typeof value.zh === 'string' || typeof value.en === 'string');
}

function normalizeLocalized(value: any, fallback = ''): { zh: string; en: string } {
  if (typeof value === 'string') return { zh: value, en: value };
  if (isLocalized(value)) return { zh: value.zh || value.en, en: value.en || value.zh };
  return { zh: fallback, en: fallback };
}

function normalizeFiles(files: any): WorkspaceFile[] {
  if (!Array.isArray(files)) return [];
  return files
    .filter((file) => file && typeof file.path === 'string' && typeof file.content === 'string')
    .map((file) => ({
      path: file.path.replace(/^\.?\//, ''),
      content: file.content,
      readonly: Boolean(file.readonly),
      openByDefault: Boolean(file.openByDefault),
    }));
}

/** 把模型返回的松散结构规整成可用的项目对象 */
export function coerceProject(raw: any): EngineeringProject {
  const stages: ProjectStage[] = Array.isArray(raw?.stages)
    ? raw.stages.map((stage: any, index: number) => ({
        id: String(stage?.id || `stage-${index + 1}`),
        title: normalizeLocalized(stage?.title, `Stage ${index + 1}`),
        goal: normalizeLocalized(stage?.goal),
        architecture: stage?.architecture ? normalizeLocalized(stage.architecture) : undefined,
        checklist: Array.isArray(stage?.checklist)
          ? stage.checklist.map((item: any) => normalizeLocalized(item))
          : [],
        hints: Array.isArray(stage?.hints) ? stage.hints.map((item: any) => normalizeLocalized(item)) : [],
        starterFiles: normalizeFiles(stage?.starterFiles),
        specs: Array.isArray(stage?.specs)
          ? stage.specs
              .filter((item: any) => item && typeof item.path === 'string' && typeof item.content === 'string')
              .map((item: any) => ({ path: item.path.replace(/^\.?\//, ''), content: item.content }))
          : [],
        gates: Array.isArray(stage?.gates)
          ? stage.gates
              .filter((gate: any) => gate && typeof gate.metric === 'string' && typeof gate.value === 'number')
              .map((gate: any) => ({
                metric: gate.metric,
                op: ['lte', 'lt', 'gte', 'gt', 'eq'].includes(gate.op) ? gate.op : 'lte',
                value: Number(gate.value),
                label: normalizeLocalized(gate.label, gate.metric),
                unit: gate.unit,
                dimension: gate.dimension,
                scope: gate.scope,
              }))
          : [],
        lab: stage?.lab && typeof stage.lab === 'object' ? stage.lab : {},
        focus: Array.isArray(stage?.focus) ? stage.focus : [],
        pitfalls: Array.isArray(stage?.pitfalls)
          ? stage.pitfalls.map((item: any) => normalizeLocalized(item))
          : [],
        extension: stage?.extension ? normalizeLocalized(stage.extension) : undefined,
        referenceFiles: normalizeFiles(stage?.referenceFiles),
        referenceNotes: stage?.referenceNotes ? normalizeLocalized(stage.referenceNotes) : undefined,
      }))
    : [];

  return {
    id: String(raw?.id || 'generated-project'),
    // 不要在这里编一个标题：编了之后 validateProjectShape 的「标题为空」永远不成立，
    // 一份没有标题的生成结果就会一路通过校验落盘
    title: normalizeLocalized(raw?.title),
    summary: normalizeLocalized(raw?.summary),
    difficulty: DIFFICULTIES.includes(raw?.difficulty) ? raw.difficulty : 'Medium',
    domain: String(raw?.domain || 'engineering'),
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String).slice(0, 8) : [],
    estimatedMinutes: Number(raw?.estimatedMinutes) || 90,
    language: raw?.language === 'javascript' ? 'javascript' : 'typescript',
    brief: normalizeLocalized(raw?.brief),
    // 项目级架构图：页面在关卡没有自己的架构图时会回退到它，
    // 生成接口的 schema 也仍然要求模型产出这一项 —— 这里漏掉就等于静默丢弃
    architecture: raw?.architecture ? normalizeLocalized(raw.architecture) : undefined,
    weights: raw?.weights && typeof raw.weights === 'object' ? raw.weights : undefined,
    files: normalizeFiles(raw?.files),
    stages,
    generatedAt: new Date().toISOString(),
  };
}

/** 静态结构检查，返回人类可读的问题列表 */
export function validateProjectShape(project: EngineeringProject): string[] {
  const errors: string[] = [];

  if (!project.title.zh && !project.title.en) errors.push('title is empty');
  if (!project.brief.zh && !project.brief.en) errors.push('brief is empty');
  if (!project.stages.length) errors.push('stages must contain at least one stage');

  // 渲染侧会直接显示 summary，运行侧按 id 存进度，两者都不能是空的
  if (!project.summary.zh && !project.summary.en) errors.push('summary is empty');
  if (!project.id.trim()) errors.push('id is empty');

  project.stages.forEach((stage, index) => {
    const label = `stage ${index + 1} (${stage.id})`;
    if (!stage.title.zh && !stage.title.en) errors.push(`${label}: title is empty`);
    if (!stage.goal.zh && !stage.goal.en) errors.push(`${label}: goal is empty`);
    if (!stage.specs.length) errors.push(`${label}: no spec files`);
    // 工作区是从 starterFiles 搭出来的，一关没有它就是一个空编辑器
    if (!stage.starterFiles?.length) {
      errors.push(`${label}: no starter files — the workspace would open empty`);
    }
    if (!stage.referenceFiles?.length) {
      errors.push(`${label}: referenceFiles missing — a stage without a reference solution cannot be verified`);
    }

    const available = new Set<string>([
      ...project.files.map((file) => file.path),
      ...project.stages.slice(0, index + 1).flatMap((item) => (item.starterFiles || []).map((file) => file.path)),
    ]);

    (stage.referenceFiles || []).forEach((file) => {
      if (!available.has(file.path)) {
        errors.push(`${label}: reference file "${file.path}" has no matching starter file`);
      }
    });

    stage.specs.forEach((spec) => {
      if (!/\.(ts|js)$/.test(spec.path)) errors.push(`${label}: spec "${spec.path}" must be a .ts or .js file`);
    });
  });

  // 进度（已完成关卡、提示解锁数）是按关卡 id 存的，重复 id 会让两关共用一份进度
  const seenStageIds = new Set<string>();
  project.stages.forEach((stage, index) => {
    if (seenStageIds.has(stage.id)) {
      errors.push(`stage ${index + 1}: duplicate stage id "${stage.id}"`);
    }
    seenStageIds.add(stage.id);
  });

  return errors;
}

export interface StageVerification {
  stageId: string;
  stageIndex: number;
  ok: boolean;
  report: StageRunReport;
  /** 起始骨架也能通过说明用例没有区分度 */
  starterAlsoPasses: boolean;
}

function toMap(files: WorkspaceFile[]): Record<string, string> {
  return files.reduce<Record<string, string>>((acc, file) => {
    acc[file.path] = file.content;
    return acc;
  }, {});
}

function workspaceFor(project: EngineeringProject, stageIndex: number, solved: boolean): Record<string, string> {
  const files: Record<string, string> = { ...toMap(project.files) };
  for (let index = 0; index <= stageIndex; index += 1) {
    Object.assign(files, toMap(project.stages[index].starterFiles || []));
  }
  const lastReference = solved ? stageIndex : stageIndex - 1;
  for (let index = 0; index <= lastReference; index += 1) {
    Object.assign(files, toMap(project.stages[index].referenceFiles || []));
  }
  return files;
}

/** 跑一关的执行器。由调用方注入，决定这段模型生成的代码在哪儿跑 */
export type StageExecutor = (options: {
  files: Record<string, string>;
  specs: ProjectStage['specs'];
  lab: ProjectStage['lab'];
  gates: ProjectStage['gates'];
  /**
   * 执行器可能跑不出报告：worker 崩了、或者生成的代码里有死循环被超时掐掉。
   * 类型上必须带 null，否则调用方会像之前那样直接解引用，把整轮验证炸掉。
   */
}) => Promise<StageRunReport | null>;

/** 跑不出报告时用它顶上，让「验证失败」照常是一条可读的结论而不是异常 */
function unexecutedReport(reason: string): StageRunReport {
  return {
    status: 'error',
    totals: { total: 0, passed: 0, failed: 0 },
    cases: [],
    gates: [],
    metrics: undefined as any,
    console: [],
    wallClockMs: 0,
    error: reason,
  };
}

/**
 * 用参考实现真跑一遍每一关，确认题目是可解的。
 *
 * 执行器必须由调用方给：这里跑的是**模型生成的代码**，绝不能在服务端进程里
 * 直接 `new Function` 执行 —— 一个同步死循环就能把整个 Next 进程挂住，
 * 而且那段代码能看到 `process.env`，把用户配置的所有厂商 key 带出去。
 * 浏览器侧的 Web Worker 有独立的全局环境，也能 terminate，是唯一合适的落点。
 */
export async function verifyProject(
  project: EngineeringProject,
  execute: StageExecutor
): Promise<StageVerification[]> {
  const verifications: StageVerification[] = [];

  for (let index = 0; index < project.stages.length; index += 1) {
    const stage = project.stages[index];

    // 执行器返回 null 表示这一关根本没跑起来（worker 出错或超时）。
    // 那是一条「验证不通过」的结论，不是一个可以往上抛的异常 —— 抛出去会中断
    // 整轮生成，用户既看不到是哪一关的问题，题目也不会被保存。
    const report =
      (await execute({
        files: workspaceFor(project, index, true),
        specs: stage.specs,
        lab: stage.lab,
        gates: stage.gates,
      })) ?? unexecutedReport('the stage could not be executed (worker error or timeout)');

    let starterAlsoPasses = false;
    if (report.status === 'passed') {
      const starterReport = await execute({
        files: workspaceFor(project, index, false),
        specs: stage.specs,
        lab: stage.lab,
        gates: stage.gates,
      });
      starterAlsoPasses = starterReport?.status === 'passed';
    }

    verifications.push({
      stageId: stage.id,
      stageIndex: index,
      ok: report.status === 'passed' && !starterAlsoPasses,
      report,
      starterAlsoPasses,
    });
  }

  return verifications;
}

/** 把验证结果翻译成可以喂回给模型的修复说明 */
export function describeVerification(verifications: StageVerification[]): string {
  const lines: string[] = [];

  verifications
    .filter((verification) => !verification.ok)
    .forEach((verification) => {
      lines.push(`Stage ${verification.stageIndex + 1} (${verification.stageId}) failed verification:`);

      if (verification.report.error) {
        lines.push(`  runtime error: ${verification.report.error}`);
      }

      verification.report.cases
        .filter((testCase) => !testCase.passed)
        .slice(0, 6)
        .forEach((testCase) => {
          lines.push(`  ✗ ${[...testCase.suite, testCase.name].join(' > ')}: ${testCase.error}`);
        });

      verification.report.gates
        .filter((gate) => !gate.passed)
        .forEach((gate) => {
          lines.push(
            `  ✗ gate ${gate.gate.metric} ${gate.gate.op} ${gate.gate.value} but actual is ${gate.actual}` +
              (gate.gate.scope ? ` (scope "${gate.gate.scope}" — does any test name contain it?)` : '')
          );
        });

      if (verification.starterAlsoPasses) {
        lines.push('  ✗ the starter skeleton also passes — the specs do not actually test the stage goal');
      }
    });

  return lines.join('\n');
}
