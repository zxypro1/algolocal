/**
 * 把工作区状态压缩成 AI 能吃下的上下文
 *
 * 工程题的上下文比算法题大得多：多文件代码 + 关卡目标 + 运行报告 + 工程指标。
 * 这里负责裁剪与排版，保证既有信息量又不会撑爆 token。
 */
import type { GateResult, LocalizedText, SpecCaseResult, StageRunReport } from '../engineering/types';

export interface WorkspaceContext {
  projectTitle?: LocalizedText;
  projectSummary?: LocalizedText;
  stageIndex?: number;
  stageCount?: number;
  stageTitle?: LocalizedText;
  stageGoal?: LocalizedText;
  files?: Array<{ path: string; content: string; readonly?: boolean }>;
  report?: StageRunReport | null;
}

const MAX_FILE_CHARS = 6000;
const MAX_TOTAL_CHARS = 24000;
const MAX_FAILING_CASES = 6;

function pick(text: LocalizedText | undefined, language: 'en' | 'zh'): string {
  if (!text) return '';
  return text[language] || text.zh || text.en || '';
}

function truncate(content: string, limit: number): string {
  if (content.length <= limit) return content;
  return `${content.slice(0, limit)}\n… (truncated, ${content.length - limit} more chars)`;
}

function formatCase(testCase: SpecCaseResult): string {
  const name = [...testCase.suite, testCase.name].join(' > ');
  const detail = [testCase.error, testCase.expected && `expected: ${testCase.expected}`, testCase.actual && `actual:   ${testCase.actual}`]
    .filter(Boolean)
    .join('\n    ');
  return `  ✗ ${name}\n    ${detail}`;
}

function formatGate(gate: GateResult, language: 'en' | 'zh'): string {
  const label = pick(gate.gate.label, language);
  const status = gate.passed ? '✓' : '✗';
  return `  ${status} ${label} — ${gate.gate.metric} ${gate.gate.op} ${gate.gate.value}, actual ${gate.actual}`;
}

export function buildWorkspaceContext(context: WorkspaceContext, language: 'en' | 'zh'): string {
  const zh = language === 'zh';
  const sections: string[] = [];

  sections.push(
    [
      zh ? '## 当前工程' : '## Project',
      `${pick(context.projectTitle, language)} — ${pick(context.projectSummary, language)}`,
      '',
      zh
        ? `## 当前关卡（第 ${(context.stageIndex ?? 0) + 1} / ${context.stageCount ?? '?'} 关）`
        : `## Current stage (${(context.stageIndex ?? 0) + 1} of ${context.stageCount ?? '?'})`,
      pick(context.stageTitle, language),
      '',
      pick(context.stageGoal, language),
    ].join('\n')
  );

  const files = (context.files || []).filter((file) => !file.readonly);
  const readonlyFiles = (context.files || []).filter((file) => file.readonly);

  if (readonlyFiles.length) {
    sections.push(
      [
        zh ? '## 平台提供的只读契约文件' : '## Read-only contract files provided by the platform',
        ...readonlyFiles.map(
          (file) => `### ${file.path}\n\`\`\`ts\n${truncate(file.content, 2500)}\n\`\`\``
        ),
      ].join('\n')
    );
  }

  let budget = MAX_TOTAL_CHARS;
  const rendered: string[] = [];
  for (const file of files) {
    if (budget <= 0) {
      rendered.push(`### ${file.path}\n(omitted — context budget exceeded)`);
      continue;
    }
    const body = truncate(file.content, Math.min(MAX_FILE_CHARS, budget));
    budget -= body.length;
    rendered.push(`### ${file.path}\n\`\`\`ts\n${body}\n\`\`\``);
  }

  sections.push([zh ? '## 用户的工作区代码' : "## User's workspace code", ...rendered].join('\n'));

  const report = context.report;
  if (report) {
    const failing = report.cases.filter((testCase) => !testCase.passed).slice(0, MAX_FAILING_CASES);
    const lines = [
      zh ? '## 最近一次运行结果' : '## Latest run',
      `status: ${report.status}, ${report.totals.passed}/${report.totals.total} cases passed`,
      '',
      zh ? '### 工程指标' : '### Engineering metrics',
      `virtualElapsedMs: ${report.metrics.virtualElapsedMs}`,
      `maxConcurrency: ${report.metrics.maxConcurrency}`,
      `requests: total=${report.metrics.requests.total}, failed=${report.metrics.requests.failed}, ` +
        `throttled=${report.metrics.requests.throttled}, retries=${report.metrics.requests.retries}, ` +
        `duplicated=${report.metrics.requests.duplicated}`,
    ];

    if (report.gates.length) {
      lines.push('', zh ? '### 指标门槛' : '### Gates', ...report.gates.map((gate) => formatGate(gate, language)));
    }

    if (failing.length) {
      lines.push('', zh ? '### 失败的用例' : '### Failing cases', ...failing.map(formatCase));
    }

    if (report.error) {
      lines.push('', zh ? '### 运行错误' : '### Run error', report.error);
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}
