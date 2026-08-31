/**
 * 学员写的东西必须存得住
 *
 * ## 这道闸门是第三次补
 *
 * 前两次是「gpulab 的工作台 UI 整个没写」和「gpulab 没有 AI 助手」。
 * 这一次是**草稿持久化**：`allProjectFiles` 里有一行专门收 `stage.ops.files`，
 * 注释还写着「不收进来的话草稿会被当成孤儿清掉」—— 而 `stage.gpu.files` 那一行
 * 从来没有人补。于是 CUDA 关卡里改的 kernel，每次重新载入都被 pruneDrafts 清空。
 * 修的时候还顺带发现恢复那一侧对 ops 和 gpu **都是坏的**（`buildStageFiles` 里
 * 根本没有这些路径，工作台的 `files.find(...)` 永远落空），以及同一个路径在多关
 * 之间会串（`/root/sgemm.cu` 横跨 5 关）。
 *
 * 上一版的 workspace-parity.test.ts 拦不住这一条，因为它查的是**文件在不在、
 * tab 挂没挂**，而这里坏的是一个函数内部少了一个分支 —— 文件都在，
 * 组件都挂着，就是数据默默丢了。
 *
 * 所以这一组不查结构，**查行为**：对每一种工作台形态，走一遍
 * 「改一个文件 -> 存 -> 重新载入 -> 还在不在」的往返。
 * 再加新的工作台形态时，只要它的文件不在 allProjectFiles / buildStageFiles 里，
 * 这里就会红。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  allProjectFiles, applyDrafts, buildStageFiles, labDraftKey, labFilesOf, pruneDrafts,
} from '../../src/lib/engineering/workspace';
import { WORKSPACE_KINDS } from '../../src/lib/engineering/types';
import type { EngineeringProject, ProjectStage } from '../../src/lib/engineering/types';

const PROJECTS: EngineeringProject[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../projects/projects.json'), 'utf8')
);

/** 一种工作台形态 + 一个能代表它的工程 */
interface Kind {
  kind: string;
  project: EngineeringProject;
  /** 从一个关卡里挑一个「学员会改的文件」，返回 [路径, 初始内容, 关卡序号] */
  pickFile(project: EngineeringProject): [string, string, number] | null;
}

function labPicker(field: 'ops' | 'gpu' | 'train') {
  return (project: EngineeringProject): [string, string, number] | null => {
    const stages = project.stages || [];
    for (let index = 0; index < stages.length; index += 1) {
      const files = (stages[index] as ProjectStage & Record<string, any>)[field]?.files ?? {};
      const [first] = Object.keys(files);
      if (first) return [first, files[first], index];
    }
    return null;
  };
}

function codePicker(project: EngineeringProject): [string, string, number] | null {
  const stages = project.stages || [];
  for (let index = 0; index < stages.length; index += 1) {
    const starter = (stages[index].starterFiles || []).find((file) => !file.readonly);
    if (starter) return [starter.path, starter.content, index];
  }
  return null;
}

const KINDS: Kind[] = [];
for (const project of PROJECTS) {
  const kind = (project.workspace as { kind?: string } | undefined)?.kind ?? 'code';
  if (KINDS.some((item) => item.kind === kind)) continue;
  KINDS.push({
    kind,
    project,
    pickFile: kind === 'ops' || kind === 'gpu' || kind === 'train'
      ? labPicker(kind)
      : codePicker,
  });
}

describe('每一种工作台形态的草稿往返', () => {
  /*
   * 判据从写死的清单换成「`WorkspaceKind` 的每一支都要有代表工程」。
   *
   * 写死清单的话，加一种形态时这条用例会红 —— 但红的原因是清单过期，
   * 而不是「新形态没被覆盖」。改完清单它就绿了，**而新形态的草稿往返
   * 一次都没被验过**。按类型比就没有这个空子。
   */
  it('每一种工作台形态都要有代表工程，否则下面几组是空转', () => {
    const kinds = KINDS.map((item) => item.kind).sort();
    expect(kinds).toEqual([...WORKSPACE_KINDS].sort());
  });

  describe.each(KINDS.map((item) => [item.kind, item] as const))('%s 工作台', (_kind, entry) => {
    const picked = entry.pickFile(entry.project);

    it('挑得出一个学员会改的文件', () => {
      expect(picked).not.toBeNull();
    });

    /** 工作台写草稿时用的键：累积文件是裸路径，实战文件带关卡 id */
    const keyOf = (filePath: string, stageIndex: number) => {
      const file = buildStageFiles(entry.project, stageIndex).find((item) => item.path === filePath);
      return file?.draftKey ?? filePath;
    };

    it('**改过的内容不会被 pruneDrafts 当成孤儿清掉**（保存侧）', () => {
      const [filePath, , stageIndex] = picked!;
      const drafts = { [keyOf(filePath, stageIndex)]: '// 学员改过的内容' };
      const kept = pruneDrafts(entry.project, drafts);
      expect(kept[keyOf(filePath, stageIndex)]).toBe('// 学员改过的内容');
    });

    it('**重新载入之后读回来的是改过的内容**（恢复侧）', () => {
      const [filePath, , stageIndex] = picked!;
      const drafts = { [keyOf(filePath, stageIndex)]: '// 学员改过的内容' };
      const files = applyDrafts(buildStageFiles(entry.project, stageIndex), drafts);
      const restored = files.find((file) => file.path === filePath);
      // 两个实战工作台就是这么找草稿的：files.find(...)?.content ?? 初始内容
      expect(restored).toBeDefined();
      expect(restored!.content).toBe('// 学员改过的内容');
    });

    it('改回原样时草稿会被丢掉，不会一直挂着「已修改」', () => {
      const [filePath, original, stageIndex] = picked!;
      const drafts = { [keyOf(filePath, stageIndex)]: original };
      expect(pruneDrafts(entry.project, drafts)[keyOf(filePath, stageIndex)]).toBeUndefined();
    });

    it('工程里根本没有的路径仍然会被清掉 —— 清理逻辑不能因为放宽而失效', () => {
      const kept = pruneDrafts(entry.project, { '/root/不存在的文件.txt': 'x' });
      expect(kept['/root/不存在的文件.txt']).toBeUndefined();
    });
  });
});

describe('同一个路径在不同关卡是不同的练习', () => {
  /**
   * 这是修恢复路径时**顺带发现的**一个更糟的问题。
   *
   * `/root/sgemm.cu` 在 llm-accelerator 里出现在 5 关（朴素 GEMM、分块、寄存器分块…），
   * 每一关的起始代码都不一样。草稿如果按裸路径存，在朴素 GEMM 那关写的实现
   * 会被带到分块那关，把那一关的起始代码顶掉 —— 学员会看到自己没写过的代码，
   * 而且那一关的题目就废了。
   *
   * 代码形态没有这个问题，也不该按关卡分：那边 `src/store.ts` 从第 2 关写到第 12 关，
   * 是同一份不断长大的实现。两种语义不同，键也就不同。
   */
  const labProjects = PROJECTS.filter(
    (project) => ['ops', 'gpu'].includes((project.workspace as { kind?: string } | undefined)?.kind ?? 'code')
  );

  it('确实存在被多关共用的路径，否则这组用例是空转', () => {
    const shared = labProjects.flatMap((project) => {
      const seen = new Map<string, number>();
      for (const stage of project.stages || []) {
        for (const path of Object.keys(labFilesOf(stage))) seen.set(path, (seen.get(path) ?? 0) + 1);
      }
      return [...seen.entries()].filter(([, n]) => n > 1);
    });
    expect(shared.length).toBeGreaterThan(0);
  });

  it.each(labProjects.map((project) => [project.id, project] as const))(
    '%s：在一关改的东西不会串到另一关',
    (_id, project) => {
      // 找一个被多关共用的路径
      const byPath = new Map<string, number[]>();
      (project.stages || []).forEach((stage, index) => {
        for (const path of Object.keys(labFilesOf(stage))) {
          byPath.set(path, [...(byPath.get(path) ?? []), index]);
        }
      });
      const entry = [...byPath.entries()].find(([, indexes]) => indexes.length > 1);
      expect(entry).toBeDefined();
      const [sharedPath, [firstIndex, secondIndex]] = entry!;

      const firstStage = project.stages[firstIndex];
      const drafts = { [labDraftKey(firstStage.id, sharedPath)]: '// 只属于第一关的实现' };

      // 第一关：读回来的是自己写的
      const inFirst = applyDrafts(buildStageFiles(project, firstIndex), drafts)
        .find((file) => file.path === sharedPath);
      expect(inFirst!.content).toBe('// 只属于第一关的实现');

      // 第二关：**必须还是那一关自己的起始代码**
      const secondStage = project.stages[secondIndex];
      const inSecond = applyDrafts(buildStageFiles(project, secondIndex), drafts)
        .find((file) => file.path === sharedPath);
      expect(inSecond!.content).toBe(labFilesOf(secondStage)[sharedPath]);
      expect(inSecond!.content).not.toBe('// 只属于第一关的实现');
    }
  );
});

describe('allProjectFiles 覆盖每一种关卡文件来源', () => {
  /**
   * 直接对着数据问：projects.json 里出现过的每一个「学员可编辑文件」的路径，
   * allProjectFiles 都得认得。这条比上面那组更笨也更全 ——
   * 上面每种形态只抽一个文件，这条把 154 关的全部路径都过一遍。
   */
  it('154 关里所有 ops / gpu 关卡文件都在 allProjectFiles 里', () => {
    const missing: string[] = [];
    for (const project of PROJECTS) {
      const known = allProjectFiles(project);
      for (const stage of project.stages || []) {
        const lab = stage as ProjectStage & Record<string, any>;
        for (const field of ['ops', 'gpu'] as const) {
          for (const filePath of Object.keys(lab[field]?.files ?? {})) {
            if (known[filePath] === undefined) missing.push(`${project.id}/${stage.id}: ${filePath}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('starterFiles 也一样', () => {
    const missing: string[] = [];
    for (const project of PROJECTS) {
      const known = allProjectFiles(project);
      for (const stage of project.stages || []) {
        for (const file of stage.starterFiles || []) {
          if (known[file.path] === undefined) missing.push(`${project.id}/${stage.id}: ${file.path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
