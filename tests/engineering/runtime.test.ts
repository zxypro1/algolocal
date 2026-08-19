/**
 * 工程实战运行时的回归测试
 *
 * 覆盖三件容易悄悄坏掉的事：
 * 1. 虚拟时钟是否真的能区分串行与并行；
 * 2. 多文件模块解析与隐藏用例框架是否正常；
 * 3. 预置题目的参考实现是否仍然能通关（含工程指标门槛）。
 */
import * as ts from 'typescript';
import fs from 'fs';
import path from 'path';

import { runStage, aggregateMetrics, evaluateGate, getMetricValue } from '../../src/lib/engineering/runner';
import { createTranspiler, needsTranspiler } from '../../src/lib/engineering/transpile';
import { deepEqual } from '../../src/lib/engineering/specRunner';
import { analyzeWorkspace } from '../../src/lib/engineering/analysis';
import { computeScoreCard } from '../../src/lib/engineering/scoring';
import { createModuleRuntime } from '../../src/lib/engineering/moduleRuntime';
import {
  allProjectFiles,
  applyDrafts,
  availableLanguages,
  buildStageFiles,
  defaultOpenPath,
  projectView,
  pruneDrafts,
  reconcileOpenFiles,
  toFileMap,
} from '../../src/lib/engineering/workspace';
import type { EngineeringProject, LabMetrics, WorkspaceFile } from '../../src/lib/engineering/types';

const transpile = createTranspiler(ts);

function toMap(files: WorkspaceFile[]): Record<string, string> {
  return files.reduce<Record<string, string>>((acc, file) => {
    acc[file.path] = file.content;
    return acc;
  }, {});
}

describe('workspace drafts', () => {
  const project = {
    id: 'demo',
    files: [{ path: 'src/contract.ts', content: 'export type A = 1;\n', readonly: true }],
    stages: [
      { id: 's1', starterFiles: [{ path: 'src/a.ts', content: 'TODO a\n' }] },
      { id: 's2', starterFiles: [{ path: 'src/b.ts', content: 'TODO b\n' }] },
    ],
  } as unknown as EngineeringProject;

  it('keeps drafts that genuinely differ', () => {
    const drafts = pruneDrafts(project, { 'src/a.ts': 'my work\n' });
    expect(drafts).toEqual({ 'src/a.ts': 'my work\n' });
  });

  /**
   * 这条对应一个真实 bug：草稿存在 localStorage 里，生命周期比题目内容长。
   * 一份「其实没改过」的草稿在题目更新后会和新的初始内容对不上，
   * 于是文件被永久标成「已修改」，而且用户无法自己清掉。
   */
  it('drops drafts identical to the starter content', () => {
    const drafts = pruneDrafts(project, { 'src/a.ts': 'TODO a\n', 'src/b.ts': 'changed\n' });
    expect(drafts).toEqual({ 'src/b.ts': 'changed\n' });
  });

  it('drops drafts for files the project no longer has', () => {
    const drafts = pruneDrafts(project, { 'src/gone.ts': 'orphan\n' });
    expect(drafts).toEqual({});
  });

  it('covers files from every stage, not just the current one', () => {
    // 第 2 关的文件也要认得，否则会被当成孤儿草稿删掉
    expect(Object.keys(allProjectFiles(project)).sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/contract.ts',
    ]);
  });

  it('dirty detection matches what applyDrafts produces', () => {
    const stageFiles = buildStageFiles(project, 0);
    const pristine = toFileMap(stageFiles);

    const untouched = applyDrafts(stageFiles, {});
    expect(untouched.filter((file) => pristine[file.path] !== file.content)).toEqual([]);

    const edited = applyDrafts(stageFiles, { 'src/a.ts': 'my work\n' });
    expect(edited.filter((file) => pristine[file.path] !== file.content).map((f) => f.path)).toEqual([
      'src/a.ts',
    ]);
  });
});

/**
 * 标签页与当前文件的协调。
 *
 * 对应两个真实 bug：
 *  1. 换关卡后编辑器仍停在第 1 关那个文件上，看起来就是「解锁了新文件但内容没变」；
 *  2. 换语言时默认文件被加了两遍，标签栏出现两个同名标签，点哪个都是同一个文件。
 */
describe('open files', () => {
  const file = (path: string, extra: Partial<WorkspaceFile> = {}): WorkspaceFile =>
    ({ path, content: `// ${path}\n`, ...extra }) as WorkspaceFile;

  const stage1 = [file('src/contract.ts', { readonly: true }), file('src/fetcher.ts', { openByDefault: true })];
  const stage2 = [...stage1, file('src/pool.ts', { openByDefault: true })];

  it('opens the current stage main file, not the first one', () => {
    expect(defaultOpenPath(stage1)).toBe('src/fetcher.ts');
    expect(defaultOpenPath(stage2)).toBe('src/pool.ts');
  });

  it('never picks a read-only file', () => {
    expect(defaultOpenPath([file('src/contract.ts', { readonly: true, openByDefault: true })])).toBe(
      'src/contract.ts'
    );
    expect(
      defaultOpenPath([file('src/contract.ts', { readonly: true, openByDefault: true }), file('src/a.ts')])
    ).toBe('src/a.ts');
  });

  it('switches to the file a new stage unlocks', () => {
    const next = reconcileOpenFiles({
      previousPaths: stage1.map((f) => f.path),
      paths: stage2.map((f) => f.path),
      defaultPath: 'src/pool.ts',
      openPaths: ['src/fetcher.ts'],
      activePath: 'src/fetcher.ts',
    });

    expect(next.activePath).toBe('src/pool.ts');
    expect(next.openPaths).toEqual(['src/fetcher.ts', 'src/pool.ts']);
  });

  it('follows the same file across a language switch instead of resetting', () => {
    const next = reconcileOpenFiles({
      previousPaths: ['src/contract.ts', 'src/fetcher.ts', 'src/pool.ts'],
      paths: ['src/contract.js', 'src/fetcher.js', 'src/pool.js'],
      defaultPath: 'src/pool.js',
      openPaths: ['src/fetcher.ts', 'src/pool.ts'],
      activePath: 'src/fetcher.ts',
    });

    expect(next.activePath).toBe('src/fetcher.js');
    expect(next.openPaths).toEqual(['src/fetcher.js', 'src/pool.js']);
  });

  it('never opens the same file twice', () => {
    const next = reconcileOpenFiles({
      previousPaths: ['src/fetcher.ts'],
      paths: ['src/fetcher.js'],
      defaultPath: 'src/fetcher.js',
      openPaths: ['src/fetcher.ts', 'src/fetcher.js'],
      activePath: 'src/fetcher.ts',
    });

    expect(next.openPaths).toEqual(['src/fetcher.js']);
  });

  it('drops tabs the new file set does not have', () => {
    const next = reconcileOpenFiles({
      previousPaths: stage2.map((f) => f.path),
      paths: stage1.map((f) => f.path),
      defaultPath: 'src/fetcher.ts',
      openPaths: ['src/fetcher.ts', 'src/pool.ts'],
      activePath: 'src/pool.ts',
    });

    expect(next.openPaths).toEqual(['src/fetcher.ts']);
    expect(next.activePath).toBe('src/fetcher.ts');
  });

  it('stays put when only the file contents changed', () => {
    const paths = stage2.map((f) => f.path);
    const next = reconcileOpenFiles({
      previousPaths: paths,
      paths,
      defaultPath: 'src/pool.ts',
      openPaths: ['src/fetcher.ts', 'src/contract.ts'],
      activePath: 'src/contract.ts',
    });

    expect(next.activePath).toBe('src/contract.ts');
    expect(next.openPaths).toEqual(['src/fetcher.ts', 'src/contract.ts']);
  });

  it('always leaves something open', () => {
    const next = reconcileOpenFiles({
      previousPaths: ['src/old.ts'],
      paths: stage1.map((f) => f.path),
      defaultPath: 'src/fetcher.ts',
      openPaths: [],
      activePath: '',
    });

    expect(next.openPaths).toEqual(['src/fetcher.ts']);
    expect(next.activePath).toBe('src/fetcher.ts');
  });

  /** 预置题目里每一关都有自己的 openByDefault 文件，换关卡就该跟着换 */
  it('每一关的主文件都能被认出来（预置题目）', () => {
    const presets: EngineeringProject[] = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'projects', 'projects.json'), 'utf8')
    );
    for (const rawProject of presets) {
      for (const language of availableLanguages(rawProject)) {
        const view = projectView(rawProject, language);
        const mains = view.stages.map((_, index) => defaultOpenPath(buildStageFiles(view, index)));
        expect(new Set(mains).size).toBe(view.stages.length);
      }
    }
  });
});

describe('module runtime', () => {
  it('resolves relative imports across files', () => {
    const runtime = createModuleRuntime({
      files: {
        'src/a.ts': "import { b } from './b';\nexport const a = () => 'a' + b();",
        'src/b.ts': "export const b = () => 'b';",
      },
      transpile,
    });

    const moduleA = runtime.require('./src/a.ts') as { a: () => string };
    expect(moduleA.a()).toBe('ab');
    expect(runtime.dependencyGraph['src/a.ts']).toEqual(['src/b.ts']);
  });

  it('survives circular dependencies like node does', () => {
    const runtime = createModuleRuntime({
      files: {
        'src/x.ts': "import './y';\nexport const x = 1;",
        'src/y.ts': "import './x';\nexport const y = 2;",
      },
      transpile,
    });

    expect(() => runtime.require('./src/x.ts')).not.toThrow();
  });

  it('reports the failing file when a module throws', () => {
    const runtime = createModuleRuntime({
      files: { 'src/boom.ts': "throw new Error('kaboom');" },
      transpile,
    });

    expect(() => runtime.require('./src/boom.ts')).toThrow(/src\/boom\.ts.*kaboom/);
  });
});

describe('virtual clock', () => {
  const files = {
    'src/work.ts': `
      import { request } from '@lab/net';

      export async function serial(urls: string[]) {
        for (const url of urls) await request(url);
      }

      export async function parallel(urls: string[]) {
        await Promise.all(urls.map((url) => request(url)));
      }
    `,
  };

  const spec = {
    path: 'specs/timing.spec.ts',
    content: `
      import { serial, parallel } from '../src/work';
      import { getMetrics } from '@lab/net';

      const urls = ['/a', '/b', '/c', '/d'];

      describe('timing', () => {
        it('serial pays for every hop', async () => {
          await serial(urls);
          const metrics = getMetrics();
          expect(metrics.virtualElapsedMs).toBe(400);
          expect(metrics.maxConcurrency).toBe(1);
        });

        it('parallel overlaps them', async () => {
          await parallel(urls);
          const metrics = getMetrics();
          expect(metrics.virtualElapsedMs).toBe(100);
          expect(metrics.maxConcurrency).toBe(4);
        });
      });
    `,
  };

  it('measures serial and parallel workloads differently', async () => {
    const report = await runStage({
      files,
      specs: [spec],
      lab: { defaultLatencyMs: 100 },
      transpile,
    });

    expect(report.status).toBe('passed');
    expect(report.totals).toEqual({ total: 2, passed: 2, failed: 0 });
  });

  it('detects a promise that never settles instead of hanging forever', async () => {
    const report = await runStage({
      files: { 'src/stuck.ts': 'export const stuck = () => new Promise(() => {});' },
      specs: [
        {
          path: 'specs/stuck.spec.ts',
          content: `
            import { stuck } from '../src/stuck';
            describe('deadlock', () => {
              it('never resolves', async () => {
                await stuck();
              });
            });
          `,
        },
      ],
      transpile,
    });

    expect(report.status).toBe('failed');
    expect(report.cases[0].error).toMatch(/deadlock/i);
  });
});

/** 以下每条都对应一个 review 里查出来的真实缺陷 */
describe('runtime regressions', () => {
  it('transpiler detection matches the module runtime', () => {
    // `export{x}` 后面没有空格：以前这里判定「不需要转译器」，
    // 而模块运行时判定「需要」，于是整关以 ModuleEvaluationError 失败
    expect(needsTranspiler({ 'src/a.js': 'const x = 1;\nexport{x};\n' })).toBe(true);
    expect(needsTranspiler({ 'src/a.js': "import{y}from'./b';\n" })).toBe(true);
    expect(needsTranspiler({ 'src/a.js': "export*from'./b';\n" })).toBe(true);
    expect(needsTranspiler({ 'src/a.js': 'module.exports = 1;\n' })).toBe(false);
    // exports.foo 不是 ESM，别误判
    expect(needsTranspiler({ 'src/a.js': 'exports.foo = 1;\n' })).toBe(false);
  });

  it('empty metrics are a fresh object every time', () => {
    const first = aggregateMetrics([]);
    first.requests.total = 999;
    first.counters.hacked = 1;

    const second = aggregateMetrics([]);
    expect(second.requests.total).toBe(0);
    expect(second.counters.hacked).toBeUndefined();
  });

  it('deepEqual compares Date and RegExp by value', () => {
    // 两者都没有自有可枚举属性，落到通用对象分支会「keys 都是空」从而判定相等，
    // 于是 expect(时间戳).toEqual(错误的时间戳) 永远通过
    expect(deepEqual(new Date(1), new Date(2))).toBe(false);
    expect(deepEqual(new Date(1), new Date(1))).toBe(true);
    expect(deepEqual(/a/g, /b/g)).toBe(false);
    expect(deepEqual(/a/g, /a/g)).toBe(true);
    expect(deepEqual(/a/g, /a/i)).toBe(false);
    expect(deepEqual(new Date(1), { })).toBe(false);
  });

  it('a throwing timer callback fails the case instead of escaping', async () => {
    const report = await runStage({
      files: {},
      specs: [
        {
          path: 'specs/timer.spec.js',
          content: `
            describe('timer', () => {
              it('reports the error', async () => {
                setTimeout(() => { throw new Error('boom'); }, 10);
                await new Promise((resolve) => setTimeout(resolve, 50));
              });
            });
          `,
        },
      ],
    });

    expect(report.totals.failed).toBe(1);
    expect(report.cases[0].error).toContain('boom');
  });

  it('afterAll runs after the last case, not the first', async () => {
    const report = await runStage({
      files: {},
      specs: [
        {
          path: 'specs/hooks.spec.js',
          content: `
            const seen = [];
            describe('hooks', () => {
              afterAll(() => { seen.push('afterAll'); });
              it('one', () => { seen.push('one'); });
              it('two', () => { seen.push('two'); });
              it('three', () => {
                seen.push('three');
                // 前两条用例跑完时 afterAll 还不该执行
                expect(seen).toEqual(['one', 'two', 'three']);
              });
            });
          `,
        },
      ],
    });

    expect(report.totals.failed).toBe(0);
  });

  it('does not hand the lab controls to workspace code', async () => {
    // configure 能把门槛量的那些参数直接改掉，reset 会换掉驱动器正在推进的时钟
    const report = await runStage({
      files: {},
      specs: [
        {
          path: 'specs/surface.spec.js',
          content: `
            const net = require('@lab/net');
            describe('lab surface', () => {
              it('has no configure/reset', () => {
                expect(net.configure).toBeUndefined();
                expect(net.reset).toBeUndefined();
                expect(typeof net.request).toBe('function');
              });
            });
          `,
        },
      ],
    });

    expect(report.totals.failed).toBe(0);
  });

  it('does not award engineering points for a run that did nothing', () => {
    const idleReport = {
      status: 'failed',
      totals: { total: 4, passed: 0, failed: 4 },
      cases: [],
      gates: [],
      metrics: aggregateMetrics([]),
      console: [],
      wallClockMs: 1,
    } as any;

    const card = computeScoreCard({
      report: idleReport,
      quality: analyzeWorkspace({ 'src/a.ts': 'export function solve() {\n  throw new Error("not implemented");\n}\n' }),
    });

    expect(card.total).toBe(0);
    // 没跑出任何东西的维度标成未测量，而不是默认满分
    const runtimeDims = card.dimensions.filter((d) => ['concurrency', 'latency', 'resilience'].includes(d.key));
    expect(runtimeDims.every((d) => d.measured)).toBe(false);
  });

  it('scales the engineering score by the acceptance pass rate', () => {
    const halfReport = {
      status: 'failed',
      totals: { total: 10, passed: 5, failed: 5 },
      cases: [],
      gates: [],
      metrics: { ...aggregateMetrics([]), virtualElapsedMs: 100, requests: { ...aggregateMetrics([]).requests, total: 4, ok: 4 } },
      console: [],
      wallClockMs: 1,
    } as any;

    const quality = analyzeWorkspace({ 'src/a.ts': 'export function solve(n: number) {\n  return n + 1;\n}\n' });
    const card = computeScoreCard({ report: halfReport, quality });

    expect(card.passRate).toBe(0.5);
    // 一半用例不过，工程分不该按满分记
    expect(card.total).toBeLessThan(50);
  });

  it('keeps totals consistent when a spec file blows up', async () => {
    const report = await runStage({
      files: {},
      specs: [
        {
          path: 'specs/broken.spec.js',
          content: `
            describe('half', () => {
              it('passes', () => { expect(1).toBe(1); });
            });
            throw new Error('collection exploded');
          `,
        },
      ],
    });

    expect(report.status).toBe('error');
    expect(report.totals.passed + report.totals.failed).toBe(report.totals.total);
  });
});

describe('metric gates', () => {
  const metrics = {
    virtualElapsedMs: 300,
    maxConcurrency: 4,
    concurrencyTimeline: [],
    requests: { total: 12, ok: 12, failed: 0, throttled: 0, retries: 0, duplicated: 0, byUrl: {} },
    samples: [],
    counters: { 'order.processed': 1 },
  } as LabMetrics;

  it('reads nested paths', () => {
    expect(getMetricValue(metrics, 'requests.total')).toBe(12);
  });

  it('reads counter names that contain dots', () => {
    expect(getMetricValue(metrics, 'counters.order.processed')).toBe(1);
  });

  it('evaluates comparisons', () => {
    const gate = { metric: 'maxConcurrency', op: 'lte' as const, value: 4, label: { zh: '', en: '' } };
    expect(evaluateGate(metrics, gate).passed).toBe(true);
    expect(evaluateGate(metrics, { ...gate, value: 3 }).passed).toBe(false);
  });
});

describe('static analysis', () => {
  it('penalises a single god file and rewards module boundaries', () => {
    const godFile = analyzeWorkspace({
      'src/all.ts': Array.from({ length: 200 }, (_, index) => `const value${index} = ${index + 3};`).join('\n'),
    });
    const modular = analyzeWorkspace({
      'src/a.ts': "import { b } from './b';\nexport const a = () => b();",
      'src/b.ts': 'export const b = () => 1;',
      'src/c.ts': 'export const c = () => 2;',
    });

    expect(modular.encapsulationScore).toBeGreaterThan(godFile.encapsulationScore);
  });

  it('flags dependency cycles', () => {
    const report = analyzeWorkspace({
      'src/a.ts': "import './b';\nexport const a = 1;",
      'src/b.ts': "import './a';\nexport const b = 2;",
    });
    expect(report.metrics.hasCycles).toBe(true);
  });
});

describe('preset projects', () => {
  const projectsPath = path.join(process.cwd(), 'projects', 'projects.json');
  const projects: EngineeringProject[] = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));

  function workspaceFor(project: EngineeringProject, stageIndex: number, solved: boolean) {
    const files: Record<string, string> = { ...toMap(project.files) };
    for (let index = 0; index <= stageIndex; index += 1) {
      Object.assign(files, toMap(project.stages[index].starterFiles || []));
    }
    const lastReference = solved ? stageIndex : stageIndex - 1;
    for (let index = 0; index <= lastReference; index += 1) {
      Object.assign(files, toMap(project.stages[index].referenceFiles || []));
    }
    return files;
  }

  it('ships at least one project', () => {
    expect(projects.length).toBeGreaterThan(0);
  });

  it('offers JavaScript alongside TypeScript', () => {
    for (const project of projects) {
      expect(availableLanguages(project)).toEqual(['typescript', 'javascript']);
    }
  });

  it('derived JavaScript files carry no TypeScript syntax', () => {
    for (const project of projects) {
      const variant = project.variants?.javascript;
      expect(variant).toBeDefined();

      const everyFile = [
        ...(variant!.files || []),
        ...variant!.stages.flatMap((stage) => [
          ...(stage.starterFiles || []),
          ...(stage.referenceFiles || []),
          ...(stage.specs || []),
        ]),
      ];

      for (const file of everyFile) {
        expect(file.path.endsWith('.ts')).toBe(false);

        // 注释里保留类型契约是有意的，这里只看代码部分
        const code = file.content
          .split('\n')
          .filter((line) => !line.trim().startsWith('//'))
          .join('\n');

        expect(code).not.toMatch(/^\s*(export\s+)?interface\s/m);
        expect(code).not.toMatch(/:\s*(string|number|boolean|Promise<)/);
      }
    }
  });

  /**
   * 题目文案是批量脚本改过的，而 mermaid 的边标签写法（A -- label --> B）
   * 很容易被「把 -- 换成标点」这类顺手替换改坏，改坏了只有打开页面才看得见。
   * 这里把围栏代码块的基本语法钉住。
   */
  describe('markdown code blocks', () => {
    const fenced: Array<{ where: string; lang: string; body: string }> = [];

    const collect = (node: unknown, where: string) => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => collect(item, `${where}[${index}]`));
      } else if (node && typeof node === 'object') {
        Object.entries(node as Record<string, unknown>).forEach(([key, value]) =>
          collect(value, `${where}.${key}`)
        );
      } else if (typeof node === 'string' && node.includes('```')) {
        const pattern = /```(\w*)\n([\s\S]*?)```/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(node))) {
          fenced.push({ where, lang: match[1], body: match[2] });
        }
      }
    };

    collect(projects, 'projects');

    it('every fence is closed', () => {
      expect(fenced.length).toBeGreaterThan(0);
    });

    it('mermaid edge labels keep their `--` syntax', () => {
      const mermaid = fenced.filter((block) => block.lang === 'mermaid');
      expect(mermaid.length).toBeGreaterThan(0);

      const broken: string[] = [];
      for (const block of mermaid) {
        for (const line of block.body.split('\n')) {
          // "C, yes --> H" 是 "C -- yes --> H" 被改坏后的样子
          if (/[A-Za-z0-9\]}],\s+\S+\s+-{2,}>/.test(line)) {
            broken.push(`${block.where}: ${line.trim()}`);
          }
        }
      }
      expect(broken).toEqual([]);
    });

    it('mermaid blocks declare a diagram type', () => {
      for (const block of fenced.filter((item) => item.lang === 'mermaid')) {
        const first = block.body.trim().split('\n')[0].trim();
        expect(first).toMatch(/^(flowchart|graph|sequenceDiagram|stateDiagram|classDiagram)/);
      }
    });
  });

  projects.forEach((rawProject) => {
    // 内容只写一份 TS，JS 版是构建时派生的。派生出来的东西必须自己能跑通，
    // 否则学员切到 JS 就会撞上一堆不是自己写出来的失败。
    const languages = ['typescript', ...Object.keys(rawProject.variants || {})];

    languages.forEach((language) => {
    const project = language === 'typescript' ? rawProject : projectView(rawProject, language as any);

    describe(`${rawProject.id} (${language})`, () => {
      project.stages.forEach((stage, stageIndex) => {
        it(`stage ${stageIndex + 1} (${stage.id}) is solvable by its reference implementation`, async () => {
          const report = await runStage({
            files: workspaceFor(project, stageIndex, true),
            specs: stage.specs,
            lab: stage.lab,
            gates: stage.gates,
            transpile,
          });

          const failures = report.cases.filter((testCase) => !testCase.passed);
          expect(failures.map((testCase) => `${testCase.name}: ${testCase.error}`)).toEqual([]);
          expect(report.gates.filter((gate) => !gate.passed)).toEqual([]);
          expect(report.status).toBe('passed');

          const scoreCard = computeScoreCard({
            report,
            quality: analyzeWorkspace(workspaceFor(project, stageIndex, true)),
            weights: project.weights,
          });
          expect(scoreCard.total).toBeGreaterThan(60);
        });

        it(`stage ${stageIndex + 1} (${stage.id}) rejects the starter skeleton`, async () => {
          const files = workspaceFor(project, stageIndex, false);
          const report = await runStage({
            files,
            specs: stage.specs,
            lab: stage.lab,
            gates: stage.gates,
            transpile,
          });

          expect(report.status).not.toBe('passed');

          /**
           * 而且骨架不该有分。
           *
           * 之前一份原样未动的骨架能拿 75：正确性 0，但并发/延迟/容错/封装/优雅全是 100
           * ——「什么都没发生」被当成了「什么都做对了」，参考实现也才 89~100，
           * 整个刻度挤在 75 到 100 之间。
           */
          const scoreCard = computeScoreCard({
            report,
            quality: analyzeWorkspace(files),
            weights: project.weights,
            // 这就是「一行没改过」的状态
            workspaceTouched: false,
          });

          // 静态分析这时评的是平台发下来的骨架，不该算成你的封装与优雅
          expect(
            scoreCard.dimensions
              .filter((d) => d.key === 'encapsulation' || d.key === 'elegance')
              .every((d) => d.measured)
          ).toBe(false);

          if (stageIndex === 0) {
            // 第 1 关的骨架是完全空的：一分都不该有
            expect(scoreCard.total).toBe(0);
          } else {
            // 后面几关的「骨架」带着前几关的参考实现，会顺带过掉几条用例，
            // 拿到的分应该和通过率相称，离通关线（60）很远
            expect(scoreCard.total).toBeLessThan(30);
          }
        });
      });
    });
    });
  });
});
