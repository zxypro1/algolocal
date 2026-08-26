/**
 * 关卡的反向验证
 *
 * 一关的题面和判定对不对，只有这一条能说了算：
 *
 *   用 `gpu.referenceFiles` 里的参考解跑，隐藏用例与门槛必须**全绿**；
 *   用起始代码跑，必须**挂**。
 *
 * 后者同样重要 —— 一个「一进来就通过」的关卡，学员做与不做没有区别。
 *
 * 这一套直接读 projects/projects.json，所以题面改了、门槛调了、
 * 参考解漏了一行，都会在这里立刻暴露。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { buildWorld, runGpuStage } from '../../src/lib/gpulab/lab';
import { createTranspiler } from '../../src/lib/engineering/transpile';
import type {
  EngineeringProject, GpuStageSpec, ProjectStage,
} from '../../src/lib/engineering/types';

jest.setTimeout(600_000);

const PROJECTS: EngineeringProject[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../projects/projects.json'), 'utf8')
);
const GPU_PROJECTS = PROJECTS.filter((project) => project.workspace?.kind === 'gpu');

const transpile = createTranspiler(ts);

/**
 * 跑一关。
 *
 * `solve = true` 时把参考解铺到磁盘上（覆盖起始代码），
 * 否则就是学员刚进来看到的样子。
 */
async function attempt(project: EngineeringProject, stage: ProjectStage, solve: boolean) {
  const gpu = (stage as ProjectStage & { gpu?: GpuStageSpec }).gpu ?? {};
  const worldSpec = project.workspace?.kind === 'gpu' ? project.workspace.world : undefined;

  const world = buildWorld({
    ...(worldSpec ?? {}),
    ...(gpu.sharedBytesPerBlock ? { sharedBytesPerBlock: gpu.sharedBytesPerBlock } : {}),
    machine: {
      ...(worldSpec?.machine ?? {}),
      files: {
        ...(worldSpec?.machine?.files ?? {}),
        ...(gpu.files ?? {}),
        ...(solve ? gpu.referenceFiles ?? {} : {}),
      },
    },
    bench: gpu.bench ?? worldSpec?.bench,
  });

  for (const command of gpu.setupCommands ?? []) {
    await world.run(command);
  }
  if (solve) {
    for (const command of gpu.referenceCommands ?? []) {
      const result = await world.run(command);
      if (result.code !== 0) {
        throw new Error(`参考命令失败：${command}\n${result.stderr || result.stdout}`);
      }
    }
  }

  return runGpuStage({
    world,
    specs: stage.specs ?? [],
    gates: stage.gates ?? [],
    transpile,
  });
}

describe.each(GPU_PROJECTS.map((project) => [project.id, project] as const))(
  '%s',
  (_id, project) => {
    it('每一关都写了参考解与门槛', () => {
      for (const stage of project.stages) {
        const gpu = (stage as ProjectStage & { gpu?: GpuStageSpec }).gpu;
        expect(gpu).toBeDefined();
        expect(Object.keys(gpu?.referenceFiles ?? {}).length).toBeGreaterThan(0);
        expect((stage.gates ?? []).length).toBeGreaterThan(0);
      }
    });

    describe.each(project.stages.map((stage, index) => [index + 1, stage] as const))(
      '第 %i 关：%s',
      (index, stage) => {
        it('参考解：用例与门槛全绿', async () => {
          const report = await attempt(project, stage, true);

          const failures = report.cases.filter((item) => !item.passed);
          const failedGates = report.gates.filter((gate) => !gate.passed);

          // 出错时把原因原样打出来，不然只能看到一个 false
          const detail = [
            ...failures.map((item) => `  用例挂了：${item.suite.join(' > ')} ${item.name}\n    ${item.error}`),
            ...failedGates.map((gate) =>
              `  门槛挂了：${gate.gate.metric} ${gate.gate.op} ${gate.gate.value}，实际 ${gate.actual}`),
            report.error ? `  运行时错误：${report.error}` : '',
          ].filter(Boolean).join('\n');

          expect(detail).toBe('');
          expect(report.status).toBe('passed');
        });

        it('起始代码：必须挂', async () => {
          const report = await attempt(project, stage, false);
          expect(report.status).not.toBe('passed');
        });

        it('参考解在门槛上有余量 —— 不是刚好卡在线上', async () => {
          const report = await attempt(project, stage, true);
          for (const gate of report.gates) {
            if (!Number.isFinite(gate.actual)) continue;
            const { op, value } = gate.gate;
            // eq 型门槛（竞态、越界）本来就该是 0，不谈余量
            if (op === 'eq') continue;
            const margin = op === 'lte' || op === 'lt'
              ? value === 0 ? 1 : (value - gate.actual) / Math.abs(value)
              : value === 0 ? 1 : (gate.actual - value) / Math.abs(value);
            // 参考解应该明显好过门槛，而不是擦边过 ——
            // 擦边意味着换个写法就会莫名其妙地挂
            expect({ metric: gate.gate.metric, margin: margin >= -1e-9 }).toEqual({
              metric: gate.gate.metric, margin: true,
            });
          }
        });
      }
    );
  }
);
