import type { NextApiRequest, NextApiResponse } from 'next';
import {
  AIProviderConfig,
  callAI,
  ChatMessage,
  extractJson,
  NoProviderError,
} from '../../src/lib/server/aiProvider';
import { buildWorkspaceContext, WorkspaceContext } from '../../src/lib/server/engineeringPrompt';
import { DIMENSION_KEYS } from '../../src/lib/engineering/types';
import type { AiReview, QualityReport } from '../../src/lib/engineering/types';

interface ReviewRequest {
  context: WorkspaceContext;
  quality?: QualityReport;
  language: 'en' | 'zh';
  config?: AIProviderConfig;
}

const REVIEW_SCHEMA = `{
  "summary": "2-4 sentences: would you approve this PR, and why",
  "dimensions": [
    { "key": "correctness|concurrency|latency|resilience|encapsulation|elegance", "score": 0-100, "comment": "one concrete sentence" }
  ],
  "issues": [
    {
      "title": "short problem statement",
      "severity": "blocker|major|minor|nit",
      "file": "src/xxx.ts",
      "detail": "why this is a problem in production, not just in style",
      "suggestion": "the smallest concrete change that fixes it"
    }
  ],
  "strengths": ["what this implementation genuinely does well"],
  "nextSteps": ["what to do before shipping this"]
}`;

function systemPrompt(language: 'en' | 'zh'): string {
  const shared = `You review code the way a staff engineer reviews a pull request for a production service.

You must judge, in order of importance:
1. **Correctness under concurrency** — races, shared mutable state, ordering assumptions, lost updates.
2. **Latency and resource behaviour** — serialised awaits that could be parallel, unbounded parallelism, wasteful polling, work done per request that could be amortised.
3. **Failure behaviour** — what happens when a dependency is slow, flaky or down; retry amplification; error swallowing; partial failure handling.
4. **Encapsulation** — module boundaries, leaked internals, module-level mutable singletons that make the code untestable, fan-out between modules.
5. **Elegance** — naming, function length, duplication, magic numbers, whether the abstraction earns its keep.

Hard rules:
- Judge the code that is actually there. Never invent files or functions that are not in the context.
- A passing test suite does NOT mean the code is good; say so if the design would break at 100x scale.
- Prefer few high-value findings over many nitpicks. Severity must reflect production impact.
- Scores are calibrated: 90+ means you would ship it as is, 70 means it works but you would ask for changes, below 50 means it has a real defect.
- Return ONLY valid JSON matching the schema. No markdown fences, no commentary outside the JSON.`;

  const localised =
    language === 'zh'
      ? '\n\nAll human-readable text inside the JSON (summary, comment, title, detail, suggestion, strengths, nextSteps) MUST be written in Chinese.'
      : '\n\nAll human-readable text inside the JSON must be written in English.';

  return shared + localised;
}

function buildQualitySection(quality: QualityReport | undefined, language: 'en' | 'zh'): string {
  if (!quality) return '';
  const zh = language === 'zh';
  const metrics = quality.metrics;
  return [
    zh ? '## 本地静态分析（已经算好，不用重复统计）' : '## Local static analysis (already computed, do not recount)',
    `files=${metrics.fileCount}, totalLines=${metrics.totalLines}, maxFileLines=${metrics.maxFileLines}`,
    `maxFunctionLines=${metrics.maxFunctionLines}, maxCyclomatic=${metrics.maxCyclomatic}`,
    `duplicatedBlocks=${metrics.duplicatedBlocks}, magicNumbers=${metrics.magicNumbers}, commentRatio=${metrics.commentRatio}`,
    `maxFanOut=${metrics.maxFanOut}, hasCycles=${metrics.hasCycles}, exportSurface=${metrics.exportSurface}`,
    zh
      ? '请在这些数字之上做定性判断，不要只是复述它们。'
      : 'Add qualitative judgement on top of these numbers instead of restating them.',
  ].join('\n');
}

function normalise(review: any, language: 'en' | 'zh'): AiReview {
  const allowedSeverity = ['blocker', 'major', 'minor', 'nit'];

  const dimensions = Array.isArray(review?.dimensions)
    ? review.dimensions
        .filter((item: any) => DIMENSION_KEYS.includes(item?.key))
        .map((item: any) => ({
          key: item.key,
          score: Math.max(0, Math.min(100, Math.round(Number(item.score) || 0))),
          comment: String(item.comment || ''),
        }))
    : [];

  const issues = Array.isArray(review?.issues)
    ? review.issues.slice(0, 12).map((item: any) => ({
        title: String(item?.title || 'Issue'),
        severity: allowedSeverity.includes(item?.severity) ? item.severity : 'minor',
        file: item?.file ? String(item.file) : undefined,
        detail: String(item?.detail || ''),
        suggestion: item?.suggestion ? String(item.suggestion) : undefined,
      }))
    : [];

  return {
    summary: String(review?.summary || (language === 'zh' ? '（模型没有给出总结）' : '(no summary returned)')),
    dimensions,
    issues,
    strengths: Array.isArray(review?.strengths) ? review.strengths.slice(0, 8).map(String) : [],
    nextSteps: Array.isArray(review?.nextSteps) ? review.nextSteps.slice(0, 8).map(String) : [],
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { context, quality, language = 'zh', config } = req.body as ReviewRequest;

    if (!context || !Array.isArray(context.files) || context.files.length === 0) {
      return res.status(400).json({ error: 'Workspace files are required' });
    }

    const userContent = [
      buildWorkspaceContext(context, language),
      buildQualitySection(quality, language),
      '',
      language === 'zh'
        ? '请以工程评审的标准审阅上面的实现，并严格按下面的 JSON 结构返回：'
        : 'Review the implementation above as an engineering review and return exactly this JSON structure:',
      REVIEW_SCHEMA,
    ]
      .filter(Boolean)
      .join('\n\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(language) },
      { role: 'user', content: userContent },
    ];

    const raw = await callAI(messages, config, { temperature: 0.3, maxTokens: 4000 });
    const review = normalise(extractJson<any>(raw), language);

    return res.status(200).json({ review });
  } catch (error) {
    console.error('Engineering review error:', error);
    const message =
      error instanceof NoProviderError
        ? error.message
        : (error as Error).message || 'Failed to generate review';
    return res.status(500).json({ error: message });
  }
}
