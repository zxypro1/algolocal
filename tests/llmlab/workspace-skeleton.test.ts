/**
 * train 形态的平台接线
 *
 * 这一片只做「点进去有东西」这件事，所以用例查的也就是接线本身：
 * 类型有没有那一支、草稿收不收得住、打包脚本认不认这个形态、
 * 分发页接没接上。运行时（Pyodide + nanotorch + WASM 算子核）在后面几片。
 *
 * 为什么这些值得单独写用例：**它们全是「漏了也不报错」的那类接线**。
 * `labFilesOf` 漏一个形态，表现是学员改的文件切走再切回来变回原样，
 * 不抛异常、不打日志、测试也不会红 —— gpu 那次就是这么过去的（#108）。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  WORKSPACE_KINDS,
  type ProjectStage,
  type EngineeringProject,
} from '../../src/lib/engineering/types';
import {
  allProjectFiles,
  buildStageFiles,
  labDraftKey,
  labFilesOf,
  pruneDrafts,
  workspaceKindOf,
} from '../../src/lib/engineering/workspace';

const ROOT = join(__dirname, '..', '..');

/** 一个最小的 train 工程，只为验接线 */
function trainProject(): EngineeringProject {
  const stage = (id: string, files: Record<string, string>): ProjectStage => ({
    id,
    title: { zh: id, en: id },
    primer: { zh: 'p', en: 'p' },
    goal: { zh: 'g', en: 'g' },
    specs: [{ path: `${id}.spec.ts`, content: '' }],
    train: { files },
  });

  return {
    id: 'llm-from-scratch',
    title: { zh: '从零实现一个 LLM', en: 'Build an LLM from scratch' },
    summary: { zh: 's', en: 's' },
    difficulty: 'Hard',
    domain: 'ml',
    tags: [],
    language: 'typescript',
    brief: { zh: 'b', en: 'b' },
    files: [],
    stages: [
      stage('bpe', { '/root/bpe.py': 'def train(): pass\n' }),
      stage('attention', { '/root/model.py': 'class Attention: pass\n' }),
    ],
    workspace: { kind: 'train', world: { entry: 'train.py' } },
  };
}

describe('train 形态：平台接线', () => {
  it('WorkspaceKind 里有 train 这一支', () => {
    expect(WORKSPACE_KINDS).toContain('train');
  });

  it('workspaceKindOf 认得出来', () => {
    expect(workspaceKindOf(trainProject())).toBe('train');
  });

  describe('实战文件与草稿', () => {
    const project = trainProject();

    it('labFilesOf 收得到 stage.train.files', () => {
      expect(labFilesOf(project.stages[0])).toEqual({ '/root/bpe.py': 'def train(): pass\n' });
    });

    it('buildStageFiles 只铺当前这一关的文件，并且带上关卡 id 的草稿键', () => {
      const files = buildStageFiles(project, 1);
      const paths = files.map((file) => file.path);
      expect(paths).toEqual(['/root/model.py']);
      expect(files[0].draftKey).toBe(labDraftKey('attention', '/root/model.py'));
    });

    it('allProjectFiles 收得到所有关卡的 train 文件', () => {
      const all = allProjectFiles(project);
      expect(Object.keys(all).sort()).toEqual(['/root/bpe.py', '/root/model.py']);
    });

    /*
     * 这条是 #108 的反向验证：草稿必须按 `关卡id::路径` 存，
     * 而且要按**那一关自己的**初始内容比对。
     * 用「同名路径的最后一关」比会得出错误结论。
     */
    it('改过的草稿留得住，没改的被清掉', () => {
      const cleaned = pruneDrafts(project, {
        [labDraftKey('bpe', '/root/bpe.py')]: 'def train(): return 1\n',   // 改过 → 留
        [labDraftKey('attention', '/root/model.py')]: 'class Attention: pass\n', // 没改 → 清
        [labDraftKey('bpe', '/root/gone.py')]: 'x',                        // 不存在 → 清
      });
      expect(Object.keys(cleaned)).toEqual([labDraftKey('bpe', '/root/bpe.py')]);
    });
  });

  it('labFilesOf 覆盖了每一种实战形态 —— 漏一种草稿就静默丢失', () => {
    /*
     * 刻意用源码文本查：实战形态是「stage 上有 files 的那些 kind」，
     * 而这件事没有类型能表达。至少让「加了形态却没在这里加一行」变成红的。
     */
    const source = readFileSync(
      join(ROOT, 'src', 'lib', 'engineering', 'workspace.ts'), 'utf8'
    );
    const body = source.slice(source.indexOf('export function labFilesOf'));
    for (const kind of ['ops', 'gpu', 'train']) {
      expect(body).toContain(`lab.${kind}?.files`);
    }
  });

  it('build-projects 把 train 当成机器形态（不要求 project.files，要求 workspace.world）', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'build-projects.js'), 'utf8');
    expect(source).toMatch(/machineBased\s*=[^;]*kind === 'train'/);
  });

  it('分发页接上了 train，而且是按需加载的', () => {
    const source = readFileSync(join(ROOT, 'pages', 'projects', '[id].tsx'), 'utf8');
    expect(source).toContain("kind === 'train'");
    expect(source).toMatch(/const TrainWorkspace = dynamic\(/);
  });

  /*
   * 这条用例的意思随着实现在变，但**问的一直是同一件事**：
   * 界面上呈现的能力，和底下真有的能力，对不对得上。
   *
   * 第 1 片时它查的是「没做的面板要明说自己没做」（那时运行时还没接）。
   * 第 7 片运行时接上了，于是反过来查：**真的接上了，没有留着空壳**。
   * gpulab 那次能滑到发版，正是因为「没做」在界面上不产生任何信号。
   */
  it('运行时真的接上了 —— 不是一个空壳', () => {
    const source = readFileSync(
      join(ROOT, 'src', 'components', 'llmlab', 'TrainWorkspace.tsx'), 'utf8'
    );
    // 判定跑得起来
    expect(source).toContain('runTrainStage(');
    expect(source).toContain('useTrainWorkspace(');
    // 三块面板接的是真组件，不是 Pending
    for (const panel of ['TrainingPanel', 'TensorPanel', 'SamplePanel']) {
      expect(source).toMatch(new RegExp(`const ${panel} = dynamic\\(`));
      expect(source).toContain(`<${panel}`);
    }
    // 终端接的是真终端
    expect(source).toContain('<WorkbenchTerminal');
    // 验收按钮在世界没起来之前仍然要禁用 —— 点了没反应比灰着更糟
    expect(source).toMatch(/disabled=\{train\.status !== 'ready'\}/);
  });

  it('剩下没接的那块（AI 助手）仍然明说自己在等什么', () => {
    const source = readFileSync(
      join(ROOT, 'src', 'components', 'llmlab', 'TrainWorkspace.tsx'), 'utf8'
    );
    expect(source).toContain('还没接上');
    expect(source).toMatch(/value="chat"[\s\S]{0,400}?<Pending/);
  });
});
