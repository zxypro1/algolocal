/**
 * 关卡的反向验证
 *
 * 一关的题面和判定对不对，只有这一条能说了算：
 *
 *   跑完 `ops.referenceCommands`，隐藏用例必须**全绿**；
 *   什么都不做（起始状态），必须**挂**。
 *
 * 后者同样重要 —— 一个「一进来就通过」的关卡，学员做与不做没有区别。
 *
 * 需要 142MB 的 CLI 产物，没有时整组跳过：`bash scripts/build-opslab-wasm.sh`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createOpsWorld, runOpsStage } from '../../src/lib/opslab/lab';
import { createCliRuntime } from '../../src/lib/opslab/wasm';
import { createTranspiler } from '../../src/lib/engineering/transpile';
import type { EngineeringProject, ProjectStage } from '../../src/lib/engineering/types';

const WASM_PATH = path.join(__dirname, '../../public/opslab/opslab-cli.wasm');
const WASM_EXEC = path.join(__dirname, '../../public/opslab/wasm_exec.js');
const HAS_ARTIFACT = fs.existsSync(WASM_PATH) && fs.existsSync(WASM_EXEC);
const describeIfBuilt = HAS_ARTIFACT ? describe : describe.skip;

const PROJECTS: EngineeringProject[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../projects/projects.json'), 'utf8')
);
const OPS_PROJECTS = PROJECTS.filter((project) => project.workspace?.kind === 'ops');

const transpile = createTranspiler(ts);

let runtime: ReturnType<typeof createCliRuntime> | null = null;
function cli() {
  if (!runtime) {
    if (!(globalThis as Record<string, unknown>).Go) createRequire(__filename)(WASM_EXEC);
    runtime = createCliRuntime({ bytes: new Uint8Array(fs.readFileSync(WASM_PATH)), cache: false });
  }
  return runtime;
}

async function attempt(project: EngineeringProject, stage: ProjectStage, solve: boolean) {
  const world = await createOpsWorld({
    world: project.workspace?.kind === 'ops' ? project.workspace.world : undefined,
    stage: {
      ...stage.ops,
      files: { ...(stage.ops?.files ?? {}), ...(solve ? stage.ops?.referenceFiles ?? {} : {}) },
    },
    runtime: cli(),
  });
  if (solve) {
    for (const command of stage.ops?.referenceCommands ?? []) {
      const result = await world.run(command);
      // 参考解自己就跑不通的话，后面的断言全无意义，这里先兜住
      if (result.code !== 0) {
        throw new Error(`参考命令失败：${command}\n${result.stderr || result.stdout}`);
      }
    }
  }
  return runOpsStage({ world, specs: stage.specs, transpile });
}

describeIfBuilt('ops 关卡的反向验证', () => {
  jest.setTimeout(300_000);

  it('至少有一个 ops 项目', () => {
    expect(OPS_PROJECTS.length).toBeGreaterThan(0);
  });

  for (const project of OPS_PROJECTS) {
    describe(project.id, () => {
      project.stages.forEach((stage, index) => {
        it(`第 ${index + 1} 关 ${stage.id}：参考解全绿`, async () => {
          const report = await attempt(project, stage, true);
          expect(report.cases.filter((item) => !item.passed).map((item) => [item.name, item.error]))
            .toEqual([]);
          expect(report.status).toBe('passed');
          expect(report.totals.total).toBeGreaterThan(0);
        });

        it(`第 ${index + 1} 关 ${stage.id}：什么都不做要挂`, async () => {
          const report = await attempt(project, stage, false);
          expect(report.status).not.toBe('passed');
        });

        it(`第 ${index + 1} 关 ${stage.id}：写了参考命令`, () => {
          expect(stage.ops?.referenceCommands?.length ?? 0).toBeGreaterThan(0);
        });
      });
    });
  }
});

describe('ops 关卡反向验证的前提', () => {
  it(HAS_ARTIFACT ? '产物已就绪' : '产物缺失，整组跳过（先跑 scripts/build-opslab-wasm.sh）', () => {
    expect(true).toBe(true);
  });
});
