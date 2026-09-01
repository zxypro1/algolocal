/**
 * 反向验证：参考解必须全绿，起始代码必须挂
 *
 * 这是关卡内容唯一的硬防线。ops / gpu 立的规矩，这里照搬：
 *
 * - 用**参考解**跑：全部用例与门槛必须**全绿**；
 * - 用**起始代码**跑：必须**挂**。
 *
 * 第二条和第一条一样重要。一关如果起始代码就能过，它就没有内容 ——
 * 而这件事在只跑参考解的流水线上完全看不出来。
 *
 * `scripts/verify-projects.js` 覆盖不到这个项目（它只跑 code 形态，
 * 那条路上没有 Pyodide 与算子核），所以验证放在这里。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildWorld, mergeWorldSpec, runTrainStage } from '../../src/lib/llmlab/lab';
import type { TrainWorldSpec } from '../../src/lib/llmlab/lab/spec';
import type { EngineeringProject, ProjectStage, StageRunReport } from '../../src/lib/engineering/types';

const ROOT = join(__dirname, '..', '..');
const WASM = readFileSync(join(ROOT, 'public', 'llmlab', 'llmlab-kernels.wasm'));
const INDEX_URL = join(ROOT, 'public', 'llmlab', 'pyodide') + '/';

/** 从构建产物里读 —— 验的是真的会发给学员的那一份，不是源文件 */
function loadProject(): EngineeringProject {
  const raw = JSON.parse(readFileSync(join(ROOT, 'projects', 'projects.json'), 'utf8'));
  const list: EngineeringProject[] = Array.isArray(raw) ? raw : raw.projects;
  const project = list.find((p) => p.id === 'llm-from-scratch');
  if (!project) throw new Error('projects.json 里没有 llm-from-scratch —— 先跑 npm run projects:build');
  return project;
}

/** 隐藏用例写的是 JS（没有类型标注），直接跑 */
const noTranspile = (code: string) => code;

/**
 * 跑一关。`which` 决定盘上放的是参考解还是起始代码。
 *
 * 每次都建一个**全新的世界** —— 两关之间、甚至同一关的两次运行之间
 * 共用世界的话，上一次的计量会漏进来，门槛就不准了。
 */
async function runStage(
  project: EngineeringProject, stage: ProjectStage, which: 'reference' | 'starter'
): Promise<StageRunReport> {
  const files = which === 'reference'
    ? { ...(stage.train?.files ?? {}), ...(stage.train?.referenceFiles ?? {}) }
    : (stage.train?.files ?? {});

  const world = await buildWorld({
    wasmBytes: WASM,
    python: { indexURL: INDEX_URL },
    spec: mergeWorldSpec(
      (project.workspace as { world?: TrainWorldSpec }).world,
      { ...(stage.train?.world ?? {}), machine: { files } }
    ),
  });
  world.rt.forbid((stage.train?.forbidden ?? []) as never[]);
  return runTrainStage({
    world,
    specs: stage.specs ?? [],
    gates: stage.gates ?? [],
    transpile: noTranspile,
  });
}

function describeFailures(report: StageRunReport): string {
  const cases = report.cases.filter((c) => !c.passed).map((c) => `  ✕ ${c.suite} › ${c.name}: ${c.error}`);
  const gates = report.gates.filter((g) => !g.passed)
    .map((g) => `  ✕ 门槛 ${g.gate.metric}: ${g.actual} 不满足 ${g.gate.op} ${g.gate.value}`);
  return [report.error ? `  错误：${report.error}` : '', ...cases, ...gates].filter(Boolean).join('\n');
}

const project = loadProject();

describe('llm-from-scratch 的关卡', () => {
  it('项目本身是 train 形态，而且声明了世界', () => {
    expect(project.workspace?.kind).toBe('train');
    expect((project.workspace as { world?: unknown }).world).toBeTruthy();
    expect(project.stages.length).toBeGreaterThan(0);
  });

  it.each(project.stages.map((s, i) => [i + 1, s.id, s] as const))(
    '第 %i 关 %s：每一关都要有起始代码、参考解、用例与门槛',
    (_i, _id, stage) => {
      expect(Object.keys(stage.train?.files ?? {}).length).toBeGreaterThan(0);
      expect(Object.keys(stage.train?.referenceFiles ?? {}).length).toBeGreaterThan(0);
      expect((stage.specs ?? []).length).toBeGreaterThan(0);
      expect((stage.gates ?? []).length).toBeGreaterThan(0);
      // 双语，两边都不能空
      for (const field of ['title', 'goal', 'primer'] as const) {
        expect(stage[field].zh.length).toBeGreaterThan(10);
        expect(stage[field].en.length).toBeGreaterThan(10);
      }
      // 参考解与起始代码必须**不一样** —— 一样的话反向验证是空转的
      expect(JSON.stringify(stage.train?.referenceFiles))
        .not.toBe(JSON.stringify(stage.train?.files));
    }
  );

  it('门槛一条都不许读墙钟', () => {
    for (const stage of project.stages) {
      for (const gate of stage.gates ?? []) {
        expect(gate.metric.startsWith('llm.timing.')).toBe(false);
      }
    }
  });

  describe.each(project.stages.map((s, i) => [i + 1, s.id, s] as const))(
    '第 %i 关 %s',
    (_i, _id, stage) => {
      it('参考解：全部用例与门槛全绿', async () => {
        const report = await runStage(project, stage, 'reference');
        if (report.status !== 'passed') {
          throw new Error(`参考解没过：\n${describeFailures(report)}`);
        }
        expect(report.totals.failed).toBe(0);
        expect(report.gates.every((g) => g.passed)).toBe(true);
      }, 600_000);

      it('起始代码：必须挂', async () => {
        const report = await runStage(project, stage, 'starter');
        /*
         * 起始代码过了 = 这一关没有内容。
         * 这条比上一条更容易被忽略，但漏掉它的代价更大：
         * 一关白送，而所有仪表盘上都显示「已完成」。
         */
        if (report.status === 'passed') {
          throw new Error('起始代码居然过了 —— 这一关没有内容');
        }
        expect(report.status).not.toBe('passed');
      }, 600_000);
    }
  );
});

/**
 * 「通过」必须是「现在通过」，不能是「曾经通过过」
 *
 * 判定用例普遍写成 `import importlib, bpe` + `importlib.reload(bpe)`。
 * 而 reload 是把新源码**在同一个模块命名空间里**再执行一遍 ——
 * 新代码没重新定义的名字不会消失。于是同一次会话里先通过一次、
 * 再把关键函数整个删掉，上一次留下的定义还在，用例照样全绿。
 *
 * 这条是在 v0.19.0 的实装验收里抓到的：同一份文件，新开会话 0/5，
 * 而在通过过一次的会话里 5/5，控制台里打的还是上一次那轮的输出。
 *
 * 上面那两条反向验证拦不住它 —— 它们每次都建一个全新的世界，
 * 正好绕开了「同一个会话跑第二次」这个唯一会出问题的路径。
 */
describe('同一个会话里跑第二次', () => {
  it('先通过、再把代码改坏，第二次必须挂', async () => {
    const stage = project.stages[0];
    expect(stage.id).toBe('byte-bpe');

    const world = await buildWorld({
      wasmBytes: WASM,
      python: { indexURL: INDEX_URL },
      spec: mergeWorldSpec(
        (project.workspace as { world?: TrainWorldSpec }).world,
        {
          ...(stage.train?.world ?? {}),
          machine: {
            files: { ...(stage.train?.files ?? {}), ...(stage.train?.referenceFiles ?? {}) },
          },
        }
      ),
    });
    world.rt.forbid((stage.train?.forbidden ?? []) as never[]);

    const run = () => runTrainStage({
      world,
      specs: stage.specs ?? [],
      gates: stage.gates ?? [],
      transpile: noTranspile,
    });

    const first = await run();
    if (first.status !== 'passed') {
      throw new Error(`参考解第一次就没过：\n${describeFailures(first)}`);
    }

    /*
     * 把三个函数**整个删掉**。这正是学员会干的事：
     * 通过之后接着改，改到一半保存了一次。
     */
    world.session.writeFile('bpe.py', '# 什么都没写\nWIP = 1\n');

    const second = await run();
    if (second.status === 'passed') {
      throw new Error(
        '同一个会话里把 train_bpe 删光之后判定还是通过 —— '
        + '上一次的模块还留在 sys.modules 里，reload 清不掉它'
      );
    }
    expect(second.status).not.toBe('passed');
  }, 600_000);
});
