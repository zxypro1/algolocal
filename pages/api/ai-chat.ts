import type { NextApiRequest, NextApiResponse } from 'next';
import {
  abortSignalFor,
  AIProviderConfig,
  callAI,
  ChatMessage,
  NoProviderError,
  streamAI,
} from '../../src/lib/server/aiProvider';

/**
 * 算法题的 AI 助手。
 *
 * provider 相关的逻辑全部收敛到 src/lib/server/aiProvider —— 这个文件原本
 * 把 5 家 provider 的调用各抄了一遍（还只有其中 3 家支持流式）。
 */

interface ChatRequest {
  messages: ChatMessage[];
  problem: {
    id: string;
    title: { en: string; zh: string };
    description: { en: string; zh: string };
    difficulty: string;
    tags: string[];
  };
  language: 'en' | 'zh';
  provider?: string;
  config?: AIProviderConfig;
  currentCode?: string;
  codeLanguage?: string;
  stream?: boolean;
}

function getSystemPrompt(language: 'en' | 'zh'): string {
  if (language === 'zh') {
    return `你是一个专业的算法导师和编程助手。你的任务是帮助用户理解和解决算法题目。

你可以访问：
- 题目的完整描述和要求
- 用户当前在编辑器中的代码（如果有的话）

你可以：
1. 提供解题思路和提示
2. 解释算法概念和数据结构
3. 分析时间和空间复杂度
4. 帮助用户调试和优化他们的代码
5. 指出用户代码中的错误或改进点
6. 提供循序渐进的引导

请使用中文回复。使用 Markdown 格式来组织你的回复，包括代码块、列表等。`;
  }

  return `You are a professional algorithm tutor and programming assistant. Your task is to help users understand and solve algorithm problems.

You have access to:
- The complete problem description and requirements
- The user's current code in the editor (if available)

You can:
1. Provide hints and approaches
2. Explain algorithm concepts and data structures
3. Analyze time and space complexity
4. Help users debug and optimize their code
5. Point out errors or improvements in the user's code
6. Provide step-by-step guidance

Please respond in English. Use Markdown formatting for your responses, including code blocks, lists, etc.`;
}

function buildContext(request: ChatRequest): string {
  const { problem, language, currentCode, codeLanguage } = request;

  const problemContext =
    language === 'zh'
      ? `当前题目：${problem.title.zh}\n难度：${problem.difficulty}\n标签：${problem.tags.join(', ')}\n\n题目描述：\n${problem.description.zh}`
      : `Current Problem: ${problem.title.en}\nDifficulty: ${problem.difficulty}\nTags: ${problem.tags.join(', ')}\n\nDescription:\n${problem.description.en}`;

  if (!currentCode || !currentCode.trim()) return problemContext;

  const codeContext =
    language === 'zh'
      ? `\n\n用户当前的代码 (${codeLanguage || 'unknown'}):\n\`\`\`${codeLanguage || ''}\n${currentCode}\n\`\`\``
      : `\n\nUser's Current Code (${codeLanguage || 'unknown'}):\n\`\`\`${codeLanguage || ''}\n${currentCode}\n\`\`\``;

  return problemContext + codeContext;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body as ChatRequest;
    const { messages, language = 'zh', provider, config, stream } = body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    const fullMessages: ChatMessage[] = [
      { role: 'system', content: getSystemPrompt(language) },
      { role: 'system', content: buildContext(body) },
      ...messages,
    ];

    // 显式传入的 provider 优先于配置里选的那个
    const effectiveConfig: AIProviderConfig = provider
      ? { ...config, selectedProvider: provider }
      : config || {};

    if (stream === false) {
      const message = await callAI(fullMessages, effectiveConfig, {
        temperature: 0.7,
        maxTokens: 2000,
      });
      return res.status(200).json({ message, role: 'assistant' });
    }

    await streamAI(res, fullMessages, effectiveConfig, {
      temperature: 0.7,
      maxTokens: 2000,
      format: 'sse',
      signal: abortSignalFor(res),
    });
  } catch (error) {
    console.error('AI Chat error:', error);
    const message =
      error instanceof NoProviderError ? error.message : (error as Error).message || 'Failed to get AI response';
    if (!res.headersSent) return res.status(500).json({ error: message });
    res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    res.end();
  }
}
