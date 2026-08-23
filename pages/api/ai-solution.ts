import type { NextApiRequest, NextApiResponse } from 'next';
import {
  abortSignalFor,
  AIProviderConfig,
  callAI,
  ChatMessage,
  NoProviderError,
  streamAI,
  statusForError,
} from '../../src/lib/server/aiProvider';
import { TEXT_STREAM_ERROR_MARK } from '../../src/lib/textStreamProtocol';

/**
 * 生成「一份文件里包含多个解法」的题解。
 *
 * 输出会被直接灌进 Monaco 编辑器，所以这里用裸文本流（format: 'text'），
 * 而不是聊天用的 SSE 事件流。
 */

interface SolutionRequest {
  problem: {
    id: string;
    title: { en: string; zh: string };
    description: { en: string; zh: string };
    difficulty: string;
    tags: string[];
    examples?: Array<{ input: string; output: string }>;
    tests?: Array<{ input: string; output: string }>;
  };
  language: 'en' | 'zh';
  codeLanguage: 'javascript' | 'typescript' | 'python';
  provider?: string;
  config?: AIProviderConfig;
  stream?: boolean;
}

// AI Provider API functions

function getSystemPrompt(language: 'en' | 'zh', codeLanguage: string): string {
  const langName = {
    javascript: 'JavaScript',
    typescript: 'TypeScript', 
    python: 'Python'
  }[codeLanguage] || 'JavaScript';

  if (language === 'zh') {
    return `你是一个专业的算法专家和编程导师。请为给定的算法题目生成“同一份代码文件里包含多个解法”的答案。

要求：
1. 使用 ${langName} 语言编写代码
2. 在同一份代码里提供 2-3 个不同的解法（如：暴力法、优化解法、最优解法），用清晰的注释分隔每个解法
3. 每个解法都要包含详细的中文注释（思路 + 复杂度 + 关键实现点）
4. 代码必须是可运行的、正确的
5. 使用清晰的变量命名和代码结构

代码格式要求：
- JavaScript/TypeScript: 使用 module.exports = functionName 导出
- Python: 定义一个名为 solution 的函数

输出要求：
- 只输出代码本体（不要输出任何 JSON / Markdown 解释性文字）
- 建议在文件顶部给出“解法对比总结”注释，然后依次给出解法 1/2/3
- 最后导出你认为最推荐的那个解法（其余解法保留为不同函数名/实现块即可）。`;
  }
  
  return `You are a professional algorithm expert and programming tutor. Generate a single code file that contains multiple solutions for the given algorithm problem.

Requirements:
1. Write code in ${langName}
2. Provide 2-3 different solutions (e.g., brute force, optimized, optimal) in the SAME file, clearly separated by comments
3. Each solution must include detailed comments (approach + complexity + key points)
4. Code must be runnable and correct
5. Use clear variable naming and code structure

Code format requirements:
- JavaScript/TypeScript: Use module.exports = functionName to export
- Python: Define a function named solution

Output:
- Return ONLY the code (no JSON / no extra prose)
- Put a short comparison summary in comments at the top
- Finally export the recommended implementation (keep other implementations as alternate functions/blocks).`;
}

function buildPrompt(problem: SolutionRequest['problem'], language: 'en' | 'zh', codeLanguage: string): string {
  const title = language === 'zh' ? problem.title.zh : problem.title.en;
  const description = language === 'zh' ? problem.description.zh : problem.description.en;
  
  let prompt = language === 'zh' 
    ? `请为以下算法题目生成“同一份代码文件里包含多个解法”的答案（2-3个解法 + 对比总结注释）：

题目：${title}
难度：${problem.difficulty}
标签：${problem.tags.join(', ')}

题目描述：
${description}`
    : `Please generate a single code file that contains multiple solutions (2-3) for the following algorithm problem, with a comparison summary in comments:

Problem: ${title}
Difficulty: ${problem.difficulty}
Tags: ${problem.tags.join(', ')}

Description:
${description}`;

  if (problem.examples && problem.examples.length > 0) {
    prompt += language === 'zh' ? '\n\n示例：' : '\n\nExamples:';
    problem.examples.forEach((ex, i) => {
      prompt += `\n${language === 'zh' ? '输入' : 'Input'}: ${ex.input}`;
      prompt += `\n${language === 'zh' ? '输出' : 'Output'}: ${ex.output}\n`;
    });
  }

  return prompt;
}

function cleanCode(code: string): string {
  const trimmed = (code || '').trim();
  const codeBlockMatch = trimmed.match(/```(?:javascript|typescript|python|js|ts|py)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  return trimmed;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { problem, language = 'zh', codeLanguage = 'javascript', provider, config, stream } =
      req.body as SolutionRequest;

    if (!problem) {
      return res.status(400).json({ error: 'Problem is required' });
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: getSystemPrompt(language, codeLanguage) },
      { role: 'user', content: buildPrompt(problem, language, codeLanguage) },
    ];

    const effectiveConfig: AIProviderConfig = provider
      ? { ...config, selectedProvider: provider }
      : config || {};

    if (stream === false) {
      const raw = await callAI(messages, effectiveConfig, { temperature: 0.7, maxTokens: 8000 });
      return res.status(200).json({ code: cleanCode(raw) });
    }

    // 流式：编辑器一边收一边显示，前端负责剥掉可能的 markdown 围栏
    await streamAI(res, messages, effectiveConfig, {
      temperature: 0.7,
      maxTokens: 8000,
      format: 'text',
      signal: abortSignalFor(res),
    });
  } catch (error: any) {
    console.error('AI Solution error:', error);
    const message =
      error instanceof NoProviderError ? error.message : error.message || 'Failed to generate solution';
    if (!res.headersSent) return res.status(statusForError(error)).json({ error: message });
    res.write(`${TEXT_STREAM_ERROR_MARK}${message}`);
    res.end();
  }
}
