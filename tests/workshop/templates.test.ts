/**
 * 工坊起始模板的可用性
 *
 * 新建一道题之后立刻点「运行验证」，必须是全绿的。如果模板自己都跑不过，
 * 用户第一次接触工坊看到的就是一片红 —— 而且分不清是自己的问题还是产品的问题。
 *
 * 这里跑的是真实的运行时（和浏览器里同一套代码），只有 TypeScript 转译器
 * 换成了 node 上的那份。
 */
import * as ts from 'typescript';
import { runStage } from '../../src/lib/engineering/runner';
import { createTranspiler } from '../../src/lib/engineering/transpile';
import { describeVerification, validateProjectShape, verifyProject } from '../../src/lib/engineering/validateProject';
import { hasBlockingIssues, validateProblem } from '../../src/lib/workshop/problem';
import { blankAlgorithmProblem, blankEngineeringProject } from '../../src/lib/workshop/templates';

const transpile = createTranspiler(ts);

describe('algorithm starter template', () => {
  const problem = blankAlgorithmProblem();

  it('passes validation out of the box', () => {
    expect(hasBlockingIssues(validateProblem(problem))).toBe(false);
  });

  /** 题目里的代码用 module.exports 导出，这里补一个 module 让它能在 node 上求值 */
  const load = (code: string) =>
    new Function(`const module = { exports: null };\n${code}\nreturn module.exports;`)();

  it('ships a reference solution that agrees with its own test cases', () => {
    // 这是工坊「运行验证」对算法题做的事，在 node 上直接算一遍
    const solve = load(problem.solution!.js);

    for (const testCase of problem.tests) {
      const args = JSON.parse(`[${testCase.input}]`);
      expect(solve(...args)).toEqual(JSON.parse(testCase.output));
    }
  });

  it('ships a starter template that does not already solve it', () => {
    const solve = load(problem.template.js);
    expect(solve(1, 2)).toBeUndefined();
  });
});

describe('engineering starter template', () => {
  const project = blankEngineeringProject();

  it('passes structural validation', () => {
    expect(validateProjectShape(project)).toEqual([]);
  });

  it('is solvable: the reference passes and the skeleton does not', async () => {
    const verifications = await verifyProject(project, (options) =>
      runStage({ ...options, transpile, caseWallClockMs: 5000 })
    );

    expect(describeVerification(verifications)).toBe('');
    expect(verifications.every((item) => item.ok)).toBe(true);
    expect(verifications.every((item) => !item.starterAlsoPasses)).toBe(true);
  }, 30000);

  it('has a latency gate that the reference actually meets', async () => {
    const stage = project.stages[0];
    const files: Record<string, string> = {};
    project.files.forEach((file) => {
      files[file.path] = file.content;
    });
    (stage.referenceFiles || []).forEach((file) => {
      files[file.path] = file.content;
    });

    const report = await runStage({
      files,
      specs: stage.specs,
      lab: stage.lab,
      gates: stage.gates,
      transpile,
      caseWallClockMs: 5000,
    });

    expect(report.status).toBe('passed');
    expect(report.gates.every((gate) => gate.passed)).toBe(true);
    // 门槛写成一个「怎么写都能过」的数字等于没有门槛
    expect(report.metrics.virtualElapsedMs).toBeGreaterThan(0);
  }, 30000);
});
