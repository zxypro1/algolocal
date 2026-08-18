import type { NextApiRequest, NextApiResponse } from 'next';
import {
  abortSignalFor,
  AIProviderConfig,
  ChatMessage,
  NoProviderError,
  streamAI,
} from '../../src/lib/server/aiProvider';
import { buildWorkspaceContext, WorkspaceContext } from '../../src/lib/server/engineeringPrompt';

interface EngineeringChatRequest {
  messages: ChatMessage[];
  context: WorkspaceContext;
  language: 'en' | 'zh';
  config?: AIProviderConfig;
}

function systemPrompt(language: 'en' | 'zh'): string {
  if (language === 'zh') {
    return `你是一位资深的软件工程师，正在结对指导用户完成一个多文件的工程实战项目。

和算法题辅导不同，你关注的是工程质量：并发控制、延迟预算、错误边界、模块划分、可测试性、命名与抽象。

规则：
1. **不要直接给出整关的完整答案**，除非用户明确要求。优先给出思路、反问、以及指向具体文件/函数的建议。
2. 用户的代码、当前关卡目标、最近一次运行结果都在上下文里，回答要基于它们，不要泛泛而谈。
3. 如果用例失败了，先解释失败的根因，再给最小的修改方向。
4. 如果工程指标（并发度/延迟）没达标，指出是哪一段代码导致的，并解释权衡。
5. 用 Markdown 组织回答，代码片段要标注文件路径。
6. 用中文回答。`;
  }

  return `You are a senior software engineer pair-programming with the user on a multi-file engineering project.

Unlike algorithm tutoring, you care about engineering quality: concurrency control, latency budgets, error boundaries, module boundaries, testability, naming and abstraction.

Rules:
1. **Do not hand over a full solution** for the stage unless explicitly asked. Prefer direction, questions, and pointers to specific files/functions.
2. The user's code, the current stage goal and the latest run report are in context — ground every answer in them.
3. When specs fail, explain the root cause first, then the smallest change that fixes it.
4. When engineering gates (concurrency/latency) fail, name the code that causes it and explain the trade-off.
5. Use Markdown, and label code snippets with their file path.
6. Answer in English.`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, context, language = 'zh', config } = req.body as EngineeringChatRequest;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // buildWorkspaceContext 会直接读 context 上的字段；缺了它就是 500 + 一句
    // 「Cannot read properties of undefined」，对调用方毫无意义。
    if (!context || typeof context !== 'object') {
      return res.status(400).json({ error: 'Workspace context is required' });
    }

    const fullMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(language) },
      { role: 'system', content: buildWorkspaceContext(context, language) },
      ...messages,
    ];

    await streamAI(res, fullMessages, config, {
      temperature: 0.6,
      maxTokens: 2500,
      format: 'sse',
      // 用户关掉弹窗/点了停止 -> 连带取消上游生成
      signal: abortSignalFor(res),
    });
  } catch (error) {
    console.error('Engineering chat error:', error);
    const message =
      error instanceof NoProviderError ? error.message : (error as Error).message || 'Failed to get AI response';
    if (!res.headersSent) return res.status(500).json({ error: message });
    res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    res.end();
  }
}
