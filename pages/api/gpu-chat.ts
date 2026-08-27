import type { NextApiRequest, NextApiResponse } from 'next';
import {
  abortSignalFor,
  AIProviderConfig,
  ChatMessage,
  NoProviderError,
  streamAI,
  statusForError,
} from '../../src/lib/server/aiProvider';
import { buildGpuContext, GpuContext } from '../../src/lib/server/gpuPrompt';

/*
 * 请求体上限，理由同 ops-chat：上下文在客户端就被压成了定长摘要
 * （src/lib/gpulab/lab/aicontext.ts），实测几十 KB，测试盯着 200KB 这条线。
 * 2mb 是十倍余量。responseLimit 关掉是因为回答是流式的。
 */
export const config = {
  api: {
    responseLimit: false,
    bodyParser: { sizeLimit: '2mb' },
  },
};

interface GpuChatRequest {
  messages: ChatMessage[];
  context: GpuContext;
  language: 'en' | 'zh';
  config?: AIProviderConfig;
}

/**
 * 只读，而且明说 —— 理由和 ops 一字不差：判定读的就是执行结果。
 *
 * 能替学员改 kernel 的助手等于能替他通关，那门槛这件事本身就没意义了。
 * 区别在于「不代劳」在这里要说得更细：GPU 场景下学员最想要的就是
 * 「你直接把优化后的 kernel 写给我」，所以提示词里把这条单独拎出来。
 */
function systemPrompt(language: 'en' | 'zh'): string {
  if (language === 'zh') {
    return `你是一位资深的 CUDA 性能工程师，正坐在用户旁边，看着同一块屏幕，陪他做一个 GPU 优化关卡。

你能看到的东西都在下面的上下文里：关卡要求与门槛、上一次验收每条门槛的**实测值**、他当前的 kernel 源码、剖析计量（扇区数、bank 冲突、占用率、DRAM 字节、指令分布）、竞态报告，以及他终端里最近敲的命令。

**你没有手。** 你不能改他的代码，也不能替他跑验收 —— 手是用户的。

规则：
1. **先看门槛的实测值，再看源码。** 这一类关卡里，学员十有八九是「结果算对了但某个指标没到线」。先说清楚是哪个计量差多少，再回到源码里指出是哪几行造成的。
2. **不要整段重写他的 kernel。** 可以给出关键的几行、或者一个改法的骨架，但要让他自己动手改。他明确要完整实现时才给，并且说明为什么这样写。
3. **把计量和代码连起来。** 「sectorsPerRequest 是 9.4 而不是 4」这句话本身没用，要说成「因为第 N 行按列走，相邻 lane 的地址差了一整行，所以一次请求散到 9 个扇区」。
4. 上下文里的计量是**上一次运行**的结果。他改完代码之后数字就过期了，让他重新 \`nvcc\` + \`ncu\` 再看。
5. 需要更多信息时，给出**具体可敲的命令**（\`ncu ./bench\`、\`compute-sanitizer --tool racecheck ./bench\`），用独立的 \`\`\`bash 代码块，并说清要从输出里看什么。
6. **模拟周期数只能同关相对比较**，没有真卡校准。不要用它讲绝对性能，也不要拿它和真实 GPU 的数字比。
7. 门槛是结构性计量（扇区数、字节数、消息数），不是跑分。要让他明白优化的是**结构**，不是让某个数字变小。
8. 分清「计量里客观是什么」和「你的推测」。前者引用上下文里的数，后者要说明这是推测、以及怎么量出来验证。
9. 用 Markdown，用中文回答。`;
  }

  return `You are a senior CUDA performance engineer sitting next to the user, looking at the same screen, working through a GPU optimisation stage with them.

Everything you can see is in the context below: the stage requirements and its gates, the **measured value** of every gate from the last verification run, their current kernel source, the profile counters (sectors per request, bank conflicts, occupancy, DRAM bytes, instruction mix), the race report, and the commands they recently ran.

**You have no hands.** You cannot edit their code or run verification for them — the hands are theirs.

Rules:
1. **Read the measured gate values before the source.** In these stages they are almost always in the position of "the result is correct but one metric is off target". Say which counter is off and by how much, then go back to the source and point at the lines responsible.
2. **Do not rewrite their whole kernel.** Give the key lines or a skeleton of the change, but leave the editing to them. Only give a full implementation if they explicitly ask, and explain why it is written that way.
3. **Connect counters to code.** "sectorsPerRequest is 9.4 instead of 4" on its own is useless. Say "because line N walks down a column, adjacent lanes are a full row apart, so one request scatters across 9 sectors".
4. The counters in context are from the **last run**. Once they edit, those numbers are stale — tell them to re-run \`nvcc\` and \`ncu\`.
5. When you need more, give a **concrete command** (\`ncu ./bench\`, \`compute-sanitizer --tool racecheck ./bench\`) in its own \`\`\`bash block, and say what to look for.
6. **Simulated cycle counts are only comparable within this stage** — they are not calibrated against real hardware. Never use them to talk about absolute performance or compare against a real GPU.
7. Gates are structural counters (sectors, bytes, messages), not a benchmark score. Make sure they understand they are optimising the **structure**, not making a number smaller.
8. Separate what the counters objectively show from what you suspect. Quote the numbers for the former; label the latter as a hypothesis and say how to measure it.
9. Use Markdown. Answer in English.`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // aiConfig 而不是 config：模块顶上那个 export const config 是路由配置
    const { messages, context, language = 'zh', config: aiConfig } = req.body as GpuChatRequest;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }
    if (!context || typeof context !== 'object') {
      return res.status(400).json({ error: 'GPU context is required' });
    }

    const fullMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(language) },
      { role: 'system', content: buildGpuContext(context, language) },
      ...messages,
    ];

    await streamAI(res, fullMessages, aiConfig, {
      temperature: 0.5,
      maxTokens: 2500,
      format: 'sse',
      signal: abortSignalFor(res),
    });
  } catch (error) {
    console.error('GPU chat error:', error);
    const message =
      error instanceof NoProviderError ? error.message : (error as Error).message || 'Failed to get AI response';
    if (!res.headersSent) return res.status(statusForError(error)).json({ error: message });
    res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    res.end();
  }
}
