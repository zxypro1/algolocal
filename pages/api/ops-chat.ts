import type { NextApiRequest, NextApiResponse } from 'next';
import {
  abortSignalFor,
  AIProviderConfig,
  ChatMessage,
  NoProviderError,
  streamAI,
  statusForError,
} from '../../src/lib/server/aiProvider';
import { buildOpsContext, OpsContext } from '../../src/lib/server/opsPrompt';

/*
 * 请求体上限。
 *
 * 不照抄工程对话那个 8mb：那边发的是整个工作区，大小由项目决定，所以撞过
 * Next 默认的 1mb（一个中等项目直接 413）。这边不一样 —— 上下文在客户端就被
 * 压成了定长摘要（src/lib/opslab/lab/aicontext.ts），实测几十 KB，测试盯着
 * 200KB 这条线。给到 2mb 是十倍余量，再往上只是白开一个更大的解析面。
 * responseLimit 关掉是因为回答是流式的。
 */
export const config = {
  api: {
    responseLimit: false,
    bodyParser: { sizeLimit: '2mb' },
  },
};

interface OpsChatRequest {
  messages: ChatMessage[];
  context: OpsContext;
  language: 'en' | 'zh';
  config?: AIProviderConfig;
}

/**
 * 只读，而且明说。
 *
 * 这个助手不能改集群 —— 不只是因为「代劳会毁掉教学目的」，还因为判定读的就是
 * 世界状态：能改集群的助手等于能替学员通关，进度这件事本身就没意义了。
 * 所以提示词里把它定位成「坐在旁边看着同一块屏幕的人」：能读，能给命令，
 * 但手是学员的。
 */
function systemPrompt(language: 'en' | 'zh'): string {
  if (language === 'zh') {
    return `你是一位资深的 SRE / 平台工程师，正坐在用户旁边，看着同一台跳板机的屏幕，陪他做一个内网 Kubernetes 实战关卡。

你能看到的东西都在下面的上下文里：关卡要求、他终端里最近敲的命令与输出、集群里那些状态不正常的对象、最近的事件、他打开的 manifest、以及上一次验收的结果。

**你没有手。** 你不能执行任何命令，也不能改集群 —— 手是用户的。你要做的是让他自己敲出那条对的命令。

规则：
1. **先读上下文再回答。** 尤其是终端里最近那几条命令：他卡住的原因八成就在某条报错里。不要泛泛地讲 Kubernetes 概念。
2. **不要直接把整关的答案给出来**，除非他明确要。优先给出「下一步该查什么」，并给出**具体可敲的命令**。
3. 给命令时用独立的 \`\`\`bash 代码块，一次给一到两条，并说清楚「你要从输出里看什么」。他会自己敲，然后把结果贴回来。
4. 上下文里的集群状态是**裁剪过的摘要**，不是全量。需要更多细节时，让他敲 kubectl 去查，而不是猜。
5. 分清「集群里客观是什么」和「你的推测」。前者引用上下文里的原文，后者要说明这是推测、以及怎么验证。
6. 验收没过时，先解释那条用例在检查什么、为什么现在不满足，再给最小的下一步。
7. 用 Markdown，用中文回答。`;
  }

  return `You are a senior SRE / platform engineer sitting next to the user, looking at the same jump-host screen, working through a hands-on intranet Kubernetes stage with them.

Everything you can see is in the context below: the stage requirements, the commands they recently ran and their output, the objects in the cluster that are not healthy, recent events, the manifests they have open, and the result of the last verification run.

**You have no hands.** You cannot run commands or change the cluster — the hands are theirs. Your job is to get them to type the right command themselves.

Rules:
1. **Read the context before answering**, especially the recent terminal output: the reason they are stuck is usually in one of those errors. Do not lecture about Kubernetes in general.
2. **Do not hand over the whole stage solution** unless they explicitly ask. Prefer "here is what to look at next", with a **concrete command to run**.
3. Put commands in their own \`\`\`bash block, one or two at a time, and say what to look for in the output. They will run it and paste the result back.
4. The cluster state in context is a **trimmed summary**, not everything. When you need more, ask them to run kubectl rather than guessing.
5. Separate what the cluster objectively shows from what you suspect. Quote the context for the former; label the latter as a hypothesis and say how to confirm it.
6. When verification fails, first explain what that check is asserting and why it does not hold yet, then give the smallest next step.
7. Use Markdown. Answer in English.`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // aiConfig 而不是 config：模块顶上那个 export const config 是路由配置
    const { messages, context, language = 'zh', config: aiConfig } = req.body as OpsChatRequest;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }
    if (!context || typeof context !== 'object') {
      return res.status(400).json({ error: 'Ops context is required' });
    }

    const fullMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(language) },
      { role: 'system', content: buildOpsContext(context, language) },
      ...messages,
    ];

    await streamAI(res, fullMessages, aiConfig, {
      temperature: 0.5,
      maxTokens: 2500,
      format: 'sse',
      signal: abortSignalFor(res),
    });
  } catch (error) {
    console.error('Ops chat error:', error);
    const message =
      error instanceof NoProviderError ? error.message : (error as Error).message || 'Failed to get AI response';
    if (!res.headersSent) return res.status(statusForError(error)).json({ error: message });
    res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    res.end();
  }
}
