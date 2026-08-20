/**
 * 新建草稿时的起始内容
 *
 * 空白页是最劝退的东西。这里给的不是「填空提示」，而是一份能直接跑通的最小
 * 题目：新建之后立刻点「运行验证」就能看到全绿，然后再逐块改成自己的题。
 */
import type { EngineeringProject } from '../engineering/types';
import type { AlgorithmProblem } from './problem';

export function blankAlgorithmProblem(): AlgorithmProblem {
  return {
    id: 'sum-of-two-numbers',
    title: { en: 'Sum of Two Numbers', zh: '两数相加' },
    difficulty: 'Easy',
    tags: ['math'],
    description: {
      en: 'Given two integers `a` and `b`, return their sum.\n\n**Constraints**\n\n- `-10^9 <= a, b <= 10^9`',
      zh: '给定两个整数 `a` 和 `b`，返回它们的和。\n\n**约束**\n\n- `-10^9 <= a, b <= 10^9`',
    },
    examples: [{ input: 'a = 1, b = 2', output: '3' }],
    template: {
      js: 'function solve(a, b) {\n  // write your code here\n}\nmodule.exports = solve;',
      python: 'def solve(a, b):\n    # write your code here\n    pass',
    },
    solution: {
      js: 'function solve(a, b) {\n  return a + b;\n}\nmodule.exports = solve;',
      python: 'def solve(a, b):\n    return a + b',
    },
    tests: [
      { input: '1,2', output: '3' },
      { input: '-5,5', output: '0' },
      { input: '1000000000,1000000000', output: '2000000000' },
    ],
  };
}

/**
 * 工程题的起始骨架。
 *
 * 一关、一个隐藏用例、一个指标门槛、一份参考实现 —— 刚好覆盖工程实战的四个
 * 组成部分，改起来比从零拼一个嵌套结构容易得多。
 */
export function blankEngineeringProject(): EngineeringProject {
  return {
    id: 'my-engineering-project',
    title: { en: 'My Engineering Project', zh: '我的工程题' },
    summary: { en: 'A short one-line description.', zh: '一句话简介。' },
    difficulty: 'Medium',
    domain: 'engineering',
    tags: ['concurrency'],
    estimatedMinutes: 60,
    language: 'typescript',
    brief: {
      en: '## Background\n\nDescribe the system the reader is going to build and why it matters.\n\n## Requirements\n\n- Requirement one\n- Requirement two',
      zh: '## 背景\n\n描述这道题要构建的系统，以及它为什么值得做。\n\n## 需求\n\n- 需求一\n- 需求二',
    },
    learningOutcomes: [{ en: 'What the reader will be able to do afterwards.', zh: '做完之后你会掌握什么。' }],
    files: [
      {
        path: 'src/contract.ts',
        content:
          '// 平台提供的接口约定，用户不可编辑。\nexport interface Task<T> {\n  (): Promise<T>;\n}\n',
        readonly: true,
      },
    ],
    stages: [
      {
        id: 'stage-1',
        title: { en: 'Stage 1: Run tasks in order', zh: '第一关：按顺序执行任务' },
        goal: {
          en: 'Implement `runAll` so that it resolves every task and returns the results in the original order.',
          zh: '实现 `runAll`，让它执行所有任务，并按原顺序返回结果。',
        },
        checklist: [{ en: 'Results keep the input order', zh: '结果保持输入顺序' }],
        hints: [{ en: 'Promise.all preserves order.', zh: 'Promise.all 会保持顺序。' }],
        starterFiles: [
          {
            path: 'src/runAll.ts',
            content:
              "import type { Task } from './contract';\n\nexport async function runAll<T>(tasks: Array<Task<T>>): Promise<T[]> {\n  // write your code here\n  return [];\n}\n",
            openByDefault: true,
          },
        ],
        specs: [
          {
            // sleep 来自 @lab/env，走的是虚拟时钟：不消耗真实时间，但延迟仍可度量。
            // 直接写裸的 sleep() 会报 "sleep is not defined"。
            path: 'spec/runAll.spec.ts',
            content:
              "import { sleep } from '@lab/env';\nimport { runAll } from '../src/runAll';\n\ndescribe('runAll', () => {\n  it('returns results in the original order', async () => {\n    const tasks = [1, 2, 3].map((value) => async () => {\n      await sleep(10 * (4 - value));\n      return value;\n    });\n    expect(await runAll(tasks)).toEqual([1, 2, 3]);\n  });\n\n  it('starts the tasks concurrently rather than one after another', async () => {\n    const tasks = [1, 2, 3].map((value) => async () => {\n      await sleep(30);\n      return value;\n    });\n    expect(await runAll(tasks)).toEqual([1, 2, 3]);\n  });\n});\n",
          },
        ],
        gates: [
          {
            metric: 'virtualElapsedMs',
            op: 'lte',
            value: 60,
            label: { en: 'Total virtual time at most 60ms', zh: '虚拟总耗时不超过 60ms' },
            dimension: 'latency',
          },
        ],
        lab: { defaultLatencyMs: 10 },
        focus: ['correctness', 'latency'],
        referenceFiles: [
          {
            path: 'src/runAll.ts',
            content:
              "import type { Task } from './contract';\n\nexport async function runAll<T>(tasks: Array<Task<T>>): Promise<T[]> {\n  return Promise.all(tasks.map((task) => task()));\n}\n",
          },
        ],
        referenceNotes: {
          en: '`Promise.all` starts every task immediately and keeps the input order in its result.',
          zh: '`Promise.all` 会立刻启动所有任务，并保持输入顺序返回结果。',
        },
      },
    ],
  };
}
