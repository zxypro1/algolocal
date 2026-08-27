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
import { buildGpuContext, GpuContext, GPU_REVIEW_MAX_CHARS } from '../../src/lib/server/gpuPrompt';
import { GPU_DIMENSION_KEYS } from '../../src/lib/engineering/types';
import type { GpuReview } from '../../src/lib/engineering/types';

/*
 * 请求体上限，理由同 gpu-chat：上下文是客户端压出来的定长摘要。
 * 复盘比对话多带一整条命令序列，实测也就几十 KB。
 */
export const config = {
  api: {
    responseLimit: false,
    bodyParser: { sizeLimit: '2mb' },
  },
};

interface GpuReviewRequest {
  context: GpuContext;
  language: 'en' | 'zh';
  config?: AIProviderConfig;
}

const REVIEW_SCHEMA = `{
  "summary": "2-4 sentences: how did they optimise this kernel, and would you trust this change in a real inference engine",
  "dimensions": [
    { "key": "optimization|measurement|correctness|legitimacy|understanding", "score": 0-100, "comment": "one concrete sentence" }
  ],
  "issues": [
    {
      "title": "short problem statement",
      "severity": "blocker|major|minor|nit",
      "where": "the kernel lines, the counter, or the command this is about",
      "detail": "why this matters on a real GPU, not just for the gate",
      "suggestion": "the smallest concrete change"
    }
  ],
  "strengths": ["what they genuinely did well"],
  "nextSteps": ["what to do before calling this stage done"]
}`;

/**
 * 复盘评的是优化，不是代码风格。
 *
 * 这一关里学员改的是一个 kernel，目标是把某个结构性计量压下去。所以能评的是：
 * 他有没有先量再改、改动是不是冲着瓶颈去的、结果还对不对、
 * 以及最要紧的一条 —— 门槛是**真的优化**过去的，还是钻空子过去的。
 *
 * 最后这条是 GPU 场景独有的，而且是这份提示词存在的主要理由：
 * 把问题规模改小、把 kernel 掏空只留下写结果、把循环次数减掉，
 * 都能让某个计量掉下来而用例照样绿。`legitimacy` 这个维度专门盯它。
 */
function systemPrompt(language: 'en' | 'zh'): string {
  const shared = `You are a senior CUDA performance engineer reviewing how someone optimised a kernel in a hands-on GPU stage. You can see the stage requirements and its gates, the measured value of every gate, their current kernel source, the profile counters, the race report, and the commands they ran in order.

Judge how they optimised, in order of importance:
1. **legitimacy** — did they actually optimise, or did they game the gate? Shrinking the problem size, deleting work the stage is supposed to do, hollowing out the kernel so it only writes the expected result, dropping loop iterations, moving work to the host — all of these can make a counter fall while the test cases stay green. This is the single most important thing to check. If the source no longer does the work the stage describes, say so loudly, no matter how green everything is.
2. **correctness** — is the result still right, and would it stay right outside the tested shapes? Look for tail handling (n not a multiple of the block size), missing __syncthreads, races the sanitizer reported, and reliance on a particular launch geometry.
3. **optimization** — is the change aimed at the actual bottleneck? Coalescing when the problem was coalescing, tiling when it was DRAM traffic, avoiding bank conflicts when it was shared memory. Changing something that was never the constraint is not optimisation.
4. **measurement** — did they measure before and after, or guess? The command history shows whether they ran ncu/compute-sanitizer or just recompiled and hoped.
5. **understanding** — does the code read like someone who knows why the counter moved, or like someone who tried things until it went green?

Hard rules:
- **A passing gate does NOT mean they optimised well.** Gates are structural counters; a shortcut can satisfy them. Check the source actually still does the stage's work.
- **Never judge on simulated cycle counts.** They are not calibrated against real hardware and are only comparable within one stage. Judge on the structural counters: sectors per request, DRAM bytes, bank conflicts, local memory bytes, message counts.
- Judge what is actually in the context. Never invent code they did not write or counters that are not there.
- Every issue must point at something concrete: quote the lines or name the counter in "where".
- Prefer a few findings that matter over a list of nitpicks. Severity reflects what it would cost on a real GPU.
- Scores are calibrated: 90+ means you would take this change into a real inference engine, 70 means it works but you would ask questions in review, below 50 means something is actually wrong with the approach.
- Return ONLY valid JSON matching the schema. No markdown fences, no commentary outside the JSON.`;

  const localised =
    language === 'zh'
      ? '\n\nAll human-readable text inside the JSON (summary, comment, title, where, detail, suggestion, strengths, nextSteps) MUST be written in Chinese.'
      : '\n\nAll human-readable text inside the JSON must be written in English.';

  return shared + localised;
}

function normalise(review: any, language: 'en' | 'zh'): GpuReview {
  const allowedSeverity = ['blocker', 'major', 'minor', 'nit'];

  const dimensions = Array.isArray(review?.dimensions)
    ? review.dimensions
        .filter((item: any) => (GPU_DIMENSION_KEYS as readonly string[]).includes(item?.key))
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
    const { context, language = 'zh', config: aiConfig } = req.body as GpuReviewRequest;

    if (!context || typeof context !== 'object') {
      return res.status(400).json({ error: 'GPU context is required' });
    }
    // 查到字段一级：只判 snapshot 存在的话，一个 {} 会在排版时抛出去变成 500
    const snapshot = context.snapshot as Partial<typeof context.snapshot> | undefined;
    if (!snapshot || !Array.isArray(snapshot.sources) || !Array.isArray(snapshot.commands)) {
      return res.status(400).json({ error: 'A GPU snapshot is required to review a kernel stage' });
    }

    const userContent = [
      buildGpuContext(context, language, GPU_REVIEW_MAX_CHARS),
      '',
      language === 'zh'
        ? '请按上面的标准复盘这一关的优化过程，并严格按下面的 JSON 结构返回：'
        : 'Review how this kernel was optimised and return exactly this JSON structure:',
      REVIEW_SCHEMA,
    ].join('\n\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(language) },
      { role: 'user', content: userContent },
    ];

    await streamStructured(res, messages, aiConfig, {
      temperature: 0.3,
      maxTokens: 4000,
      signal: abortSignalFor(res),
      onComplete: (raw) => ({ review: normalise(extractJson<any>(raw), language) }),
    });
  } catch (error) {
    console.error('GPU review error:', error);
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
