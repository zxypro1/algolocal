/**
 * 生成 → 校验 → 保存 这条链路
 *
 * 两个症状（白屏 + 没添加成功）来自这里的两个缺陷：
 *
 * 1. useProjectRunner.run() 在 worker 出错或超时时 resolve 成 null，而 generator
 *    用 `run(options) as any` 把这个 null 转给了 verifyProject —— 后者直接
 *    `report.status`，抛 TypeError。整轮生成就此中断，题目自然也不会被保存。
 * 2. 保存接口的 force 分支完全不做结构校验，coerce 完直接落盘。
 *
 * 另外 coerceProject 会给没有标题的项目编一个标题，导致校验器里那条
 * 「title is empty」永远不成立。
 */
import fs from 'fs';
import path from 'path';
import {
  coerceProject,
  validateProjectShape,
  verifyProject,
  describeVerification,
} from '../../src/lib/engineering/validateProject';
import type { StageRunReport } from '../../src/lib/engineering/types';

const brokenRaw = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/unrenderable-project.json'), 'utf8')
);

function workingProject() {
  return coerceProject({
    id: 'ok-project',
    title: { zh: '标题', en: 'Title' },
    summary: { zh: '摘要', en: 'Summary' },
    brief: { zh: '简介', en: 'Brief' },
    stages: [
      {
        id: 'stage-1',
        title: { zh: '第一关', en: 'Stage 1' },
        goal: { zh: '目标', en: 'Goal' },
        starterFiles: [{ path: 'src/a.ts', content: 'export const a = 0;' }],
        referenceFiles: [{ path: 'src/a.ts', content: 'export const a = 1;' }],
        specs: [{ path: 'specs/a.spec.ts', content: 'it("x", () => {})' }],
      },
    ],
  });
}

const passingReport: StageRunReport = {
  status: 'passed',
  totals: { total: 1, passed: 1, failed: 0 },
  cases: [],
  gates: [],
  metrics: {} as any,
  console: [],
  wallClockMs: 1,
};

describe('verifyProject when a stage cannot be executed', () => {
  it('reports a failure instead of throwing', async () => {
    // 这正是 run() 在 worker 崩溃或超时时给出的东西
    const verifications = await verifyProject(workingProject(), async () => null);

    expect(verifications).toHaveLength(1);
    expect(verifications[0].ok).toBe(false);
    expect(verifications[0].report.status).toBe('error');
  });

  it('explains the failure in terms the repair round can use', async () => {
    const verifications = await verifyProject(workingProject(), async () => null);
    const report = describeVerification(verifications);

    expect(report).toMatch(/stage-1/i);
    expect(report).toMatch(/could not be executed/i);
  });

  it('still treats a genuinely passing stage as passing', async () => {
    const verifications = await verifyProject(workingProject(), async (options) =>
      // 参考实现通过、起始骨架不通过，才算这一关成立
      options.files['src/a.ts'].includes('= 1') ? passingReport : { ...passingReport, status: 'failed' }
    );

    expect(verifications[0].ok).toBe(true);
    expect(verifications[0].starterAlsoPasses).toBe(false);
  });

  it('rejects a stage whose starter also passes', async () => {
    const verifications = await verifyProject(workingProject(), async () => passingReport);

    expect(verifications[0].ok).toBe(false);
    expect(verifications[0].starterAlsoPasses).toBe(true);
  });

  it('does not throw when only the starter run yields nothing', async () => {
    let call = 0;
    const verifications = await verifyProject(workingProject(), async () => {
      call += 1;
      return call === 1 ? passingReport : null;
    });

    expect(verifications[0].ok).toBe(true);
  });
});

describe('validateProjectShape', () => {
  const problems = validateProjectShape(coerceProject(brokenRaw));

  it('rejects the fixture the app used to accept', () => {
    expect(problems.length).toBeGreaterThan(0);
  });

  it('catches a missing title, which coerceProject used to paper over', () => {
    expect(problems.join('\n')).toMatch(/title is empty/);
  });

  it('catches a missing summary', () => {
    expect(problems.join('\n')).toMatch(/summary is empty/);
  });

  it('catches a stage with no starter files', () => {
    // 工作区是从 starterFiles 搭出来的，没有它编辑器就是空的
    expect(problems.join('\n')).toMatch(/no starter files/);
  });

  it('catches duplicate stage ids, which would share one progress record', () => {
    expect(problems.join('\n')).toMatch(/duplicate stage id/);
  });

  it('catches a spec that is not a .ts or .js file', () => {
    expect(problems.join('\n')).toMatch(/must be a \.ts or \.js file/);
  });

  it('accepts a project the workspace can actually open', () => {
    expect(validateProjectShape(workingProject())).toEqual([]);
  });
});

describe('the validator and the workspace agree on what is renderable', () => {
  /**
   * 契约的核心：校验放行的项目，工作区必须打得开。
   * 打得开的最低要求是「至少有一关，且这一关有起始文件」——
   * 页面正是按这两样东西决定渲染什么的。
   */
  it('every project the validator accepts has a stage with files to open', () => {
    const project = workingProject();
    expect(validateProjectShape(project)).toEqual([]);
    expect(project.stages.length).toBeGreaterThan(0);
    project.stages.forEach((stage) => {
      expect(stage.starterFiles?.length).toBeGreaterThan(0);
    });
  });
});

describe('stored projects are normalised before they reach the renderer', () => {
  /**
   * probe-crash 那份数据：checklist 被模型写成了一句话而不是数组。
   * 存储层过去把它原样交给渲染层，StagePanel 的 checklist.map 直接抛异常，整页白屏。
   */
  it('turns a string checklist into an array instead of leaving it to explode', () => {
    const stage = coerceProject({
      id: 'x',
      stages: [{ id: 's', checklist: '这应该是一个数组，但模型给了一个字符串' }],
    }).stages[0];

    expect(Array.isArray(stage.checklist)).toBe(true);
    // 渲染层做的正是这件事
    expect(() => (stage.checklist || []).map((item) => item)).not.toThrow();
  });

  it('normalises the other list fields the same way', () => {
    const stage = coerceProject({
      id: 'x',
      stages: [{ id: 's', hints: 'not a list', pitfalls: { nope: true }, focus: 'correctness' }],
    }).stages[0];

    expect(stage.hints).toEqual([]);
    expect(stage.pitfalls).toEqual([]);
    expect(stage.focus).toEqual([]);
  });
});
