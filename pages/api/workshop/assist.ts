/**
 * 工坊的 AI 工具链
 *
 * 一个接口，多个动作。每个动作都是「给一段当前内容，返回一段改好的内容」，
 * 由前端决定要不要采纳 —— 出题人对自己的题目有最终解释权，AI 在这里是助手
 * 不是作者，所以没有任何一个动作会直接落盘。
 *
 * 走的是用户自己配置的 provider（可以是本地 Ollama），因此工坊的 AI 能力在
 * 完全离线的机器上也成立。
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  AIProviderConfig,
  callAI,
  ChatMessage,
  extractJson,
  NoProviderError,
} from '../../../src/lib/server/aiProvider';
import { coerceProblem, type AlgorithmProblem } from '../../../src/lib/workshop/problem';
import { coerceProject } from '../../../src/lib/engineering/validateProject';
import type { EngineeringProject } from '../../../src/lib/engineering/types';

export type AssistAction =
  | 'draft-problem'
  | 'polish-statement'
  | 'translate'
  | 'generate-tests'
  | 'generate-solution'
  | 'generate-templates'
  | 'suggest-metadata'
  | 'review-problem'
  | 'review-project'
  | 'draft-stage';

interface AssistRequest {
  action: AssistAction;
  language?: 'en' | 'zh';
  config?: AIProviderConfig;
  /** 自然语言指令，draft-problem / draft-stage 用 */
  instruction?: string;
  problem?: unknown;
  project?: unknown;
  /** generate-solution / generate-templates 的目标语言 */
  codeLanguage?: string;
}

export interface ReviewNote {
  severity: 'blocker' | 'major' | 'minor';
  field: string;
  message: string;
  suggestion?: string;
}

const RESPOND_WITH_JSON =
  'Respond with a single JSON object and nothing else. No prose, no markdown fences.';

/** 题面里所有面向读者的文字都是双语的，模型很容易只写一种，所以每个 prompt 都重申一遍 */
const BILINGUAL = 'Every localized field is an object of the form {"en": "...", "zh": "..."} and BOTH must be filled.';

function problemContext(problem: AlgorithmProblem): string {
  return JSON.stringify(
    {
      id: problem.id,
      title: problem.title,
      difficulty: problem.difficulty,
      tags: problem.tags,
      description: problem.description,
      examples: problem.examples,
      template: problem.template,
      solution: problem.solution,
      tests: problem.tests,
    },
    null,
    2
  ).slice(0, 40000);
}

function projectContext(project: EngineeringProject): string {
  // 参考实现和隐藏用例是最占字数的部分，评审用得上，但要截断
  return JSON.stringify(
    {
      id: project.id,
      title: project.title,
      summary: project.summary,
      difficulty: project.difficulty,
      language: project.language,
      brief: project.brief,
      files: project.files.map((file) => ({ path: file.path, content: file.content.slice(0, 2000) })),
      stages: project.stages.map((stage) => ({
        id: stage.id,
        title: stage.title,
        goal: stage.goal,
        gates: stage.gates,
        lab: stage.lab,
        specs: stage.specs.map((spec) => ({ path: spec.path, content: spec.content.slice(0, 3000) })),
        starterFiles: (stage.starterFiles || []).map((file) => ({ path: file.path, content: file.content.slice(0, 1500) })),
      })),
    },
    null,
    2
  ).slice(0, 50000);
}

function promptFor(body: AssistRequest): { messages: ChatMessage[]; temperature: number } {
  const language = body.language === 'en' ? 'en' : 'zh';
  const system: ChatMessage = {
    role: 'system',
    content:
      'You help an author write programming exercises for a local-first practice app. ' +
      'You return only valid JSON. You never invent test expectations you have not computed. ' +
      `The author is working in ${language === 'zh' ? 'Chinese' : 'English'}; write review comments in that language.`,
  };

  const problem = body.problem ? coerceProblem(body.problem) : null;
  const project = body.project ? coerceProject(body.project) : null;

  switch (body.action) {
    case 'draft-problem':
      return {
        temperature: 0.6,
        messages: [
          system,
          {
            role: 'user',
            content: `Draft a complete algorithm problem from this request:

${body.instruction || 'A medium-difficulty array problem.'}

${RESPOND_WITH_JSON} The object has exactly these keys:
{
  "id": "kebab-case-id",
  "title": {"en": "...", "zh": "..."},
  "difficulty": "Easy" | "Medium" | "Hard",
  "tags": ["array", "hash-table"],
  "description": {"en": "markdown", "zh": "markdown"},
  "examples": [{"input": "nums = [1,2]", "output": "3"}],
  "template": {"js": "function solve(...) {\\n  // write your code here\\n}\\nmodule.exports = solve;", "python": "def solve(...):\\n    pass"},
  "solution": {"js": "...", "python": "..."},
  "tests": [{"input": "comma-separated JSON arguments", "output": "JSON result"}]
}

${BILINGUAL}
The "input" of a test is the argument list as it would appear inside a call, e.g. "[2,7,11,15],9".
The "output" is the JSON-encoded return value. Work through your own solution on every test before writing the expected output.
Include at least 5 tests and cover the edge cases.`,
          },
        ],
      };

    case 'polish-statement':
      return {
        temperature: 0.4,
        messages: [
          system,
          {
            role: 'user',
            content: `Rewrite this problem statement so it is unambiguous: state the input format, the output format, and the constraints. Keep the same problem — do not change what is being asked.

${problemContext(problem!)}

${RESPOND_WITH_JSON} {"description": {"en": "markdown", "zh": "markdown"}}
${BILINGUAL}`,
          },
        ],
      };

    case 'translate':
      return {
        temperature: 0.3,
        messages: [
          system,
          {
            role: 'user',
            content: `Fill in the missing translations. Where one language is empty or is a copy of the other, write a real translation. Keep markdown structure, code and identifiers untouched.

${problemContext(problem!)}

${RESPOND_WITH_JSON} {"title": {"en": "...", "zh": "..."}, "description": {"en": "...", "zh": "..."}}`,
          },
        ],
      };

    case 'generate-tests':
      return {
        temperature: 0.3,
        messages: [
          system,
          {
            role: 'user',
            content: `Propose additional test cases for this problem, focusing on the cases the current set misses: empty input, single element, duplicates, negatives, the maximum size allowed by the constraints.

${problemContext(problem!)}

${RESPOND_WITH_JSON} {"tests": [{"input": "...", "output": "...", "why": "one line, what this case covers"}]}
"input" is the argument list as it appears inside a call, "output" is the JSON-encoded expected return value.
Run the reference solution in your head on every case before you write its expected output. Return at most 8 new cases and do not repeat existing ones.`,
          },
        ],
      };

    case 'generate-solution':
      return {
        temperature: 0.3,
        messages: [
          system,
          {
            role: 'user',
            content: `Write a reference solution in ${body.codeLanguage || 'js'} for this problem. It must pass every listed test.

${problemContext(problem!)}

${RESPOND_WITH_JSON} {"code": "...", "complexity": {"time": "O(n)", "space": "O(1)"}, "notes": "one paragraph explaining the approach"}
JavaScript solutions export with module.exports = fn. Python solutions define a top-level function.`,
          },
        ],
      };

    case 'generate-templates':
      return {
        temperature: 0.2,
        messages: [
          system,
          {
            role: 'user',
            content: `Write starter templates for this problem in JavaScript, Python, Java, C++ and C. Each template has the correct signature and an empty body with a "write your code here" comment. Never include the actual solution.

${problemContext(problem!)}

${RESPOND_WITH_JSON} {"template": {"js": "...", "python": "...", "java": "...", "cpp": "...", "c": "..."}}`,
          },
        ],
      };

    case 'suggest-metadata':
      return {
        temperature: 0.3,
        messages: [
          system,
          {
            role: 'user',
            content: `Suggest tags and a difficulty for this problem, judged by the algorithmic insight it requires rather than by code length.

${problemContext(problem!)}

${RESPOND_WITH_JSON} {"tags": ["lowercase-kebab"], "difficulty": "Easy" | "Medium" | "Hard", "reason": "one sentence"}
Use at most 5 tags drawn from the usual vocabulary: array, string, hash-table, two-pointers, sliding-window, binary-search, sorting, greedy, dynamic-programming, backtracking, graph, tree, stack, queue, heap, math, bit-manipulation, linked-list, matrix, simulation, design.`,
          },
        ],
      };

    case 'review-problem':
      return {
        temperature: 0.2,
        messages: [
          system,
          {
            role: 'user',
            content: `Review this problem the way an editor would before it goes into a question bank. Look for: an ambiguous statement, missing constraints, a statement that does not match the tests, tests that do not discriminate between a correct and a naive solution, and a template whose signature disagrees with the tests.

${problemContext(problem!)}

${RESPOND_WITH_JSON} {"notes": [{"severity": "blocker" | "major" | "minor", "field": "description" | "tests" | "template" | "solution" | "title" | "tags", "message": "...", "suggestion": "..."}], "verdict": "one sentence"}
Report only real problems. An empty notes array is a valid and useful answer.`,
          },
        ],
      };

    case 'review-project':
      return {
        temperature: 0.2,
        messages: [
          system,
          {
            role: 'user',
            content: `Review this multi-stage engineering exercise. Look for: stages whose specs do not actually test the stated goal, metric gates whose numbers are unreachable or trivially met given the lab config, a starter skeleton that would already pass, reference files with no matching starter file, and stage ordering that requires knowledge from a later stage.

${projectContext(project!)}

${RESPOND_WITH_JSON} {"notes": [{"severity": "blocker" | "major" | "minor", "field": "stage-1.gates", "message": "...", "suggestion": "..."}], "verdict": "one sentence"}
When you flag a latency gate, show the arithmetic that produced your number.`,
          },
        ],
      };

    case 'draft-stage':
      return {
        temperature: 0.5,
        messages: [
          system,
          {
            role: 'user',
            content: `Draft one more stage for this engineering exercise. It must build on what the existing stages already established, and it must be verifiable by the platform's runtime.

Author's request: ${body.instruction || 'The next natural step in difficulty.'}

${projectContext(project!)}

${RESPOND_WITH_JSON} a single stage object:
{
  "id": "stage-n",
  "title": {"en": "...", "zh": "..."},
  "goal": {"en": "markdown", "zh": "markdown"},
  "checklist": [{"en": "...", "zh": "..."}],
  "hints": [{"en": "...", "zh": "..."}],
  "starterFiles": [{"path": "src/x.ts", "content": "...", "openByDefault": true}],
  "specs": [{"path": "spec/x.spec.ts", "content": "describe/it/expect, uses sleep() and the @lab modules"}],
  "gates": [{"metric": "maxConcurrency", "op": "lte", "value": 4, "label": {"en": "...", "zh": "..."}, "dimension": "concurrency"}],
  "lab": {"defaultLatencyMs": 100},
  "referenceFiles": [{"path": "src/x.ts", "content": "an implementation that passes the specs"}]
}

${BILINGUAL}
Every referenceFiles path must also exist in starterFiles. The starter skeleton must FAIL the specs; the reference must PASS them. Compute latency gate numbers from the lab config rather than guessing.`,
          },
        ],
      };

    default:
      throw new Error(`Unknown action: ${body.action}`);
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as AssistRequest;

  try {
    const needsProblem = [
      'polish-statement',
      'translate',
      'generate-tests',
      'generate-solution',
      'generate-templates',
      'suggest-metadata',
      'review-problem',
    ];
    if (needsProblem.includes(body.action) && !body.problem) {
      return res.status(400).json({ error: `Action "${body.action}" needs the current problem` });
    }
    if ((body.action === 'review-project' || body.action === 'draft-stage') && !body.project) {
      return res.status(400).json({ error: `Action "${body.action}" needs the current project` });
    }

    const { messages, temperature } = promptFor(body);
    const raw = await callAI(messages, body.config, { temperature, maxTokens: 8000 });

    // 模型经常把 JSON 包在 markdown 围栏里，extractJson 负责拆掉
    return res.status(200).json({ result: extractJson<unknown>(raw) });
  } catch (error) {
    console.error(`Workshop assist (${body?.action}) failed:`, error);
    const message =
      error instanceof NoProviderError
        ? error.message
        : (error as Error).message || 'The AI request failed';
    return res.status(error instanceof NoProviderError ? 400 : 500).json({ error: message });
  }
}

export const config = {
  api: {
    // 评审一道工程题要把关卡内容一起发上来
    bodyParser: { sizeLimit: '4mb' },
  },
};
