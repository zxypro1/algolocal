import type { NextApiRequest, NextApiResponse } from 'next';
import {
  abortSignalFor,
  AIProviderConfig,
  ChatMessage,
  extractJson,
  NoProviderError,
  streamStructured,
  statusForError,
} from '../../src/lib/server/aiProvider';
import { buildOpsContext, OpsContext, REVIEW_MAX_CHARS } from '../../src/lib/server/opsPrompt';
import { OPS_DIMENSION_KEYS } from '../../src/lib/engineering/types';
import type { OpsReview } from '../../src/lib/engineering/types';

/*
 * 请求体上限，理由同 ops-chat：上下文是客户端压出来的定长摘要，复盘比对话多带
 * 一整条排查路径，实测也就几十 KB。2mb 是十倍余量，不用照抄工程评审那个 8mb ——
 * 那个数是为「整个工作区」留的。responseLimit 关掉是因为回答是流式的。
 */
export const config = {
  api: {
    responseLimit: false,
    bodyParser: { sizeLimit: '2mb' },
  },
};

interface OpsReviewRequest {
  context: OpsContext;
  language: 'en' | 'zh';
  config?: AIProviderConfig;
}

const REVIEW_SCHEMA = `{
  "summary": "2-4 sentences: how did they operate this stage, and would you hand them the on-call pager",
  "dimensions": [
    { "key": "diagnosis|outcome|safety|efficiency|understanding", "score": 0-100, "comment": "one concrete sentence" }
  ],
  "issues": [
    {
      "title": "short problem statement",
      "severity": "blocker|major|minor|nit",
      "where": "the command, object or file this is about",
      "detail": "why this would hurt on a real cluster, not just here",
      "suggestion": "the smallest concrete change, as a command or an edit"
    }
  ],
  "strengths": ["what they genuinely did well"],
  "nextSteps": ["what to do before calling this stage done"]
}`;

/**
 * 复盘评的是操作，不是代码。
 *
 * 学员在这一关里没有写程序，他敲了一串命令、改了几个 manifest，把集群从坏改到好。
 * 所以能评的东西是：他怎么缩小范围的、集群现在到底对不对、有没有为了通关走危险
 * 的旁路（--force / delete 重建 / 直接改 status）、多少步走到答案、以及从命令的
 * 选择上看得出他是理解了机制还是在照抄。
 *
 * 「验收过了」不等于操作是对的：判定只查关键点，把 replicas 调成 0 也能让
 * CrashLoopBackOff 消失。提示词里把这一条写死。
 */
function systemPrompt(language: 'en' | 'zh'): string {
  const shared = `You are a senior SRE doing a post-incident review with an engineer who has just worked through a hands-on Kubernetes stage on a jump host. You can see the stage requirements, the commands they ran in order, the current cluster state, the manifests they touched, and the verification result.

Judge how they operated, in order of importance:
1. **diagnosis** — the path they took to find the problem. Did each command narrow the search, or were they guessing? Did they read the error before reacting to it? Did they check the obvious cheap thing first (events, describe, logs) before the expensive one?
2. **outcome** — is the cluster actually correct now, not just passing. Look at the objects, not only the verification result.
3. **safety** — anything they did that would be dangerous on a production cluster: --force, deleting and recreating instead of fixing, editing status, scaling to zero to silence a crash loop, disabling a probe rather than fixing what it caught, changes made imperatively that are not in any manifest.
4. **efficiency** — how many steps it took, repeated commands that told them nothing new, long detours.
5. **understanding** — does the sequence of commands read like someone who knows the mechanism, or like someone pattern-matching a runbook?

Hard rules:
- **A passing verification does NOT mean they operated well.** The checks only assert key facts; a shortcut can satisfy them. If they got there by a route that would be unacceptable on a real cluster, say so and score safety accordingly, even when everything is green.
- Judge what is actually in the context. Never invent commands they did not run or objects that are not there.
- The cluster state and command history are a **trimmed summary**. If something is absent, do not assume they never did it — say what you would need to see.
- Every issue must point at something concrete in the context: quote the command or name the object in "where".
- Prefer a few findings that matter over a list of nitpicks. Severity reflects blast radius on a real cluster.
- Scores are calibrated: 90+ means you would be happy to see this from a colleague on-call, 70 means it works but you would coach them, below 50 means something is actually wrong with how they did it.
- Return ONLY valid JSON matching the schema. No markdown fences, no commentary outside the JSON.`;

  const localised =
    language === 'zh'
      ? '\n\nAll human-readable text inside the JSON (summary, comment, title, where, detail, suggestion, strengths, nextSteps) MUST be written in Chinese.'
      : '\n\nAll human-readable text inside the JSON must be written in English.';

  return shared + localised;
}

function normalise(review: any, language: 'en' | 'zh'): OpsReview {
  const allowedSeverity = ['blocker', 'major', 'minor', 'nit'];

  const dimensions = Array.isArray(review?.dimensions)
    ? review.dimensions
        .filter((item: any) => (OPS_DIMENSION_KEYS as readonly string[]).includes(item?.key))
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
        where: item?.where ? String(item.where) : undefined,
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
    // aiConfig 而不是 config：模块顶上那个 export const config 是路由配置
    const { context, language = 'zh', config: aiConfig } = req.body as OpsReviewRequest;

    if (!context || typeof context !== 'object') {
      return res.status(400).json({ error: 'Ops context is required' });
    }
    // 查到字段一级：只判 snapshot 存在的话，一个 {} 会在排版时抛出去变成 500
    const snapshot = context.snapshot as Partial<typeof context.snapshot> | undefined;
    if (!snapshot || !Array.isArray(snapshot.problems) || !Array.isArray(snapshot.commands)) {
      return res.status(400).json({ error: 'A cluster snapshot is required to review an ops stage' });
    }

    const userContent = [
      buildOpsContext(context, language, REVIEW_MAX_CHARS),
      '',
      language === 'zh'
        ? '请按上面的标准复盘这一关的操作过程，并严格按下面的 JSON 结构返回：'
        : 'Review how this stage was operated and return exactly this JSON structure:',
      REVIEW_SCHEMA,
    ].join('\n\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(language) },
      { role: 'user', content: userContent },
    ];

    // 复盘是给人读的长文，没有理由攒到最后一次性甩出来
    await streamStructured(res, messages, aiConfig, {
      temperature: 0.3,
      maxTokens: 4000,
      signal: abortSignalFor(res),
      onComplete: (raw) => ({ review: normalise(extractJson<any>(raw), language) }),
    });
  } catch (error) {
    console.error('Ops review error:', error);
    const message =
      error instanceof NoProviderError ? error.message : (error as Error).message || 'Failed to generate review';
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }
    return res.status(statusForError(error)).json({ error: message });
  }
}
