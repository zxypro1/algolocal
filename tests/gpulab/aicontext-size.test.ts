/**
 * 真实关卡下的上下文体积
 *
 * 上面那组（aicontext.test.ts）用的是合成素材，盯的是上限。
 * 这一条跑**项目里真的关卡**：真的 kernel、真的门槛、真的验收报告，
 * 量出来的比值才是「裁剪有没有意义」的答案。
 *
 * 挑集群关是因为它是最坏情况：源码最长、通信计量最多，还多一份流水线数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { buildWorld, runGpuStage } from '../../src/lib/gpulab/lab';
import { buildGpuSnapshot, summarizeGpuReport } from '../../src/lib/gpulab/lab/aicontext';
import { buildGpuContext } from '../../src/lib/server/gpuPrompt';
import { createTranspiler } from '../../src/lib/engineering/transpile';
import type {
  EngineeringProject, GpuStageSpec, ProjectStage,
} from '../../src/lib/engineering/types';
import type { CommandRecord } from '../../src/lib/labkit/machine';

jest.setTimeout(600_000);

const PROJECTS: EngineeringProject[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../projects/projects.json'), 'utf8')
);
const project = PROJECTS.find((item) => item.workspace?.kind === 'gpu')!;
const transpile = createTranspiler(ts);

/** 拿一关来跑：铺参考解、编译、跑、profile，然后量上下文 */
async function measure(stageIndex: number) {
  const stage = project.stages[stageIndex];
  const gpu = (stage as ProjectStage & { gpu?: GpuStageSpec }).gpu ?? {};
  const worldSpec = project.workspace?.kind === 'gpu' ? project.workspace.world : undefined;

  const world = buildWorld({
    ...(worldSpec ?? {}),
    ...(gpu.world ?? {}),
    ...(gpu.sharedBytesPerBlock ? { sharedBytesPerBlock: gpu.sharedBytesPerBlock } : {}),
    machine: {
      ...(worldSpec?.machine ?? {}),
      files: {
        ...(worldSpec?.machine?.files ?? {}),
        ...(gpu.files ?? {}),
        ...(gpu.referenceFiles ?? {}),
      },
    },
    bench: gpu.bench ?? worldSpec?.bench,
  });

  for (const command of gpu.setupCommands ?? []) await world.run(command);
  for (const command of gpu.referenceCommands ?? []) await world.run(command);
  // 学员真会敲的那几条
  await world.run('ncu ./bench');
  await world.run('compute-sanitizer --tool racecheck ./bench');

  const report = await runGpuStage({
    world, specs: stage.specs ?? [], gates: stage.gates ?? [], transpile,
  });

  const history = world.machine.transcript() as CommandRecord[];
  const sources: Record<string, string> = {};
  for (const [p, content] of Object.entries(gpu.referenceFiles ?? {})) sources[p] = String(content);

  // 原始素材：整棵磁盘 + 全部命令 + 完整计量树 + 完整报告
  const raw = JSON.stringify({
    files: world.machine.vfs.toFileMap('/'),
    history,
    metrics: world.gpu.metrics(),
    sanitizer: world.gpu.sanitizerReport(),
    report,
  });

  const snapshot = buildGpuSnapshot(world, { sources, history });
  const payload = JSON.stringify({
    messages: [{ role: 'user', content: '这条门槛差在哪' }],
    context: {
      snapshot,
      report: summarizeGpuReport(report),
      stageTitle: stage.title,
      stageGoal: stage.goal,
    },
  });
  const prompt = buildGpuContext(
    { snapshot, report: summarizeGpuReport(report), stageTitle: stage.title, stageGoal: stage.goal } as never,
    'zh'
  );

  return { stage, raw, payload, prompt, snapshot, history };
}

it('真实关卡（集群关，最坏情况）的上下文体积', async () => {
  const last = project.stages.length - 1;
  const { stage, raw, payload, prompt, snapshot, history } = await measure(last);

  // eslint-disable-next-line no-console
  console.log(
    `\n  第 ${last + 1} 关「${stage.title.zh}」\n` +
    `  原始素材 ${(raw.length / 1024).toFixed(1)} KB` +
    ` -> 请求体 ${(payload.length / 1024).toFixed(1)} KB` +
    ` -> 排版后 ${(prompt.length / 1024).toFixed(1)} KB\n` +
    `  （命令 ${history.length} 条，带进去 ${snapshot.commands.length} 条；` +
    `源码 ${snapshot.sources.length} 份）\n`
  );

  // 真实关卡下必须是小几十 KB 量级，离 1mb 差着两个数量级
  expect(payload.length).toBeLessThan(120_000);
  // 也不能压成空壳：门槛与源码是这个场景的主角
  expect(prompt).toContain('sectorsPerRequest');
  expect(snapshot.sources.length).toBeGreaterThan(0);
});
