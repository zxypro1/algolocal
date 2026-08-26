/**
 * 把 ops 世界的快照排成给模型看的上下文
 *
 * 裁剪已经在客户端做完了（见 src/lib/opslab/lab/aicontext.ts），这里只负责排版 ——
 * 以及再兜一次总量：客户端是可以被绕过的，服务端不该假设请求体是善意的。
 *
 * 排版顺序就是重要性顺序：先关卡要求，再终端最近发生了什么，再集群哪儿不对，
 * 最后才是清单式的资源列表。模型和人一样，读到后面注意力会散。
 */
import type { LocalizedText } from '../engineering/types';
import type { OpsSnapshot, OpsReportSummary } from '../opslab/lab/aicontext';

export interface OpsContext {
  projectTitle?: LocalizedText;
  projectSummary?: LocalizedText;
  stageIndex?: number;
  stageCount?: number;
  stageTitle?: LocalizedText;
  stageGoal?: LocalizedText;
  checklist?: LocalizedText[];
  snapshot?: OpsSnapshot;
  report?: OpsReportSummary | null;
}

/**
 * 服务端的兜底总量。客户端已经裁过一轮，这里防的是被构造的请求。
 *
 * 复盘的额度更高：它要看完整的排查路径，几十条命令本身就占掉对话的全部预算。
 */
const MAX_TOTAL_CHARS = 40000;
export const REVIEW_MAX_CHARS = 60000;

function pick(text: LocalizedText | undefined, language: 'en' | 'zh'): string {
  if (!text) return '';
  return text[language] || text.zh || text.en || '';
}

function statusMark(status: string): string {
  if (status === 'error') return '✗';
  if (status === 'warn') return '!';
  if (status === 'pending') return '…';
  return '✓';
}

function objectLine(item: { kind: string; namespace?: string; name: string; detail: string; status: string }): string {
  const where = item.namespace ? `${item.namespace}/` : '';
  return `  ${statusMark(item.status)} ${item.kind} ${where}${item.name} — ${item.detail}`;
}

export function buildOpsContext(
  context: OpsContext,
  language: 'en' | 'zh',
  maxChars: number = MAX_TOTAL_CHARS
): string {
  const zh = language === 'zh';
  const sections: string[] = [];
  /**
   * 排版之前先把形状补齐。
   *
   * 这个函数是路由的最后一站，而请求体是外面来的 —— 一个缺了 problems 的
   * snapshot 不该让路由 500，它顶多是「这块没内容」。
   */
  const raw = context.snapshot;
  const snapshot: OpsSnapshot | undefined = raw && {
    ...raw,
    nodes: raw.nodes ?? [],
    workloads: raw.workloads ?? [],
    problems: raw.problems ?? [],
    events: raw.events ?? [],
    commands: raw.commands ?? [],
    files: raw.files ?? [],
    omitted: { ...{ objects: 0, problems: 0, namespaces: 0, commands: 0, files: 0 }, ...(raw.omitted ?? {}) },
  };

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

  const checklist = (context.checklist ?? []).map((item) => `- ${pick(item, language)}`).filter((line) => line !== '- ');
  if (checklist.length) {
    sections.push([zh ? '## 通关标准' : '## Done when', ...checklist].join('\n'));
  }

  /**
   * 终端历史排在集群状态前面。
   *
   * ops 场景里学员卡住，答案十有八九在上一条命令的报错里 —— 而不在某个
   * 健康对象的字段上。把它放在模型注意力最好的位置。
   */
  if (snapshot?.commands.length) {
    const lines = [zh ? '## 终端最近敲了什么' : '## Recent terminal activity'];
    if (snapshot.omitted.commands > 0) {
      lines.push(zh
        ? `（更早的 ${snapshot.omitted.commands} 条没有带上）`
        : `(${snapshot.omitted.commands} earlier commands omitted)`);
    }
    for (const entry of snapshot.commands) {
      lines.push('', `$ ${entry.command}`, `# exit ${entry.code}`, entry.output || '(无输出)');
    }
    sections.push(lines.join('\n'));
  }

  if (snapshot) {
    const lines = [
      zh ? '## 集群现状' : '## Cluster state',
      zh ? `当前命名空间：${snapshot.namespace}` : `Current namespace: ${snapshot.namespace}`,
    ];

    if (snapshot.problems.length) {
      lines.push('', zh ? '### 状态不正常的对象' : '### Objects not healthy', ...snapshot.problems.map(objectLine));
      /**
       * 超上限被砍掉的异常对象必须单独说。
       *
       * 这一行以前和「省略了 N 个健康对象」混在一起报 —— 于是问题列表被砍了
       * 一半，模型收到的却是「其余都是健康的」。宁可让它知道自己看不全，
       * 也不能让它以为看全了。
       */
      if (snapshot.omitted.problems > 0) {
        lines.push(zh
          ? `（还有 ${snapshot.omitted.problems} 个状态不正常的对象没列出来 —— 这个列表**不是全的**，`
            + `让用户敲 kubectl get -A 自己看。）`
          : `(${snapshot.omitted.problems} more unhealthy objects were not listed — this list is NOT complete. `
            + `Ask the user to run kubectl get -A.)`);
      }
    } else {
      lines.push('', zh ? '### 状态不正常的对象：没有' : '### Objects not healthy: none');
    }

    if (snapshot.nodes.length) {
      lines.push('', zh ? '### 节点' : '### Nodes', ...snapshot.nodes.map(objectLine));
    }
    if (snapshot.workloads.length) {
      lines.push('', zh ? '### 工作负载与接线' : '### Workloads and wiring', ...snapshot.workloads.map(objectLine));
    }
    if (snapshot.omitted.objects > 0 || snapshot.omitted.namespaces > 0) {
      lines.push(
        '',
        zh
          ? `（为控制体积，省略了 ${snapshot.omitted.objects} 个健康对象`
            + `${snapshot.omitted.namespaces ? `、${snapshot.omitted.namespaces} 个命名空间的明细` : ''}。`
            + `需要的话让用户自己敲 kubectl 查，然后把输出贴给你。）`
          : `(${snapshot.omitted.objects} healthy objects`
            + `${snapshot.omitted.namespaces ? ` and detail for ${snapshot.omitted.namespaces} namespaces` : ''}`
            + ` were omitted to keep this small. Ask the user to run kubectl and paste the output.)`
      );
    }
    sections.push(lines.join('\n'));
  }

  if (snapshot?.events.length) {
    sections.push(
      [
        zh ? '## 最近的事件' : '## Recent events',
        ...snapshot.events.map((event) => `  [${event.type}] ${event.reason} ${event.object}: ${event.message}`),
      ].join('\n')
    );
  }

  if (snapshot?.files.length) {
    const lines = [
      zh ? '## 跳板机磁盘上的文件' : '## Files on the jump host',
      ...snapshot.files.map((file) => `### ${file.path}\n\`\`\`yaml\n${file.content}\n\`\`\``),
    ];
    if (snapshot.omitted.files > 0) {
      lines.push(zh
        ? `（另有 ${snapshot.omitted.files} 个文件没带上。需要哪个就让用户 cat 出来贴给你。）`
        : `(${snapshot.omitted.files} more files were not included. Ask the user to cat the one you need.)`);
    }
    sections.push(lines.join('\n'));
  }

  const report = context.report;
  if (report) {
    const lines = [
      zh ? '## 上一次验收' : '## Latest verification',
      `status: ${report.status}, ${report.passed}/${report.total}`,
    ];
    if (report.failing.length) {
      lines.push(
        '',
        zh ? '### 没过的用例' : '### Failing checks',
        ...report.failing.map((item) => `  ✗ ${item.name}\n    ${item.error}`)
      );
    }
    if (report.error) lines.push('', zh ? '### 运行错误' : '### Run error', report.error);
    sections.push(lines.join('\n'));
  }

  const text = sections.join('\n\n');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（上下文过长，后面被截断）`;
}
