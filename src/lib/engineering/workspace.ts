/**
 * 工作区装配：把「工程基础文件 + 各关解锁的文件 + 用户草稿」合成一棵文件树
 */
import type {
  EngineeringProject,
  ProjectStage,
  WorkspaceFile,
  WorkspaceLanguage,
} from './types';

/** 这个工程可以用哪些语言来做 */
export function availableLanguages(project: EngineeringProject): WorkspaceLanguage[] {
  const base = (project.language === 'javascript' ? 'javascript' : 'typescript') as WorkspaceLanguage;
  const extra = Object.keys(project.variants || {}) as WorkspaceLanguage[];
  return [base, ...extra.filter((item) => item !== base)];
}

/**
 * 按语言取出工程视图。
 *
 * 只有「代码」部分随语言切换（初始文件、参考实现、隐藏用例），
 * 关卡目标、提示、指标门槛这些描述性内容是共用的。
 */
export function projectView(
  project: EngineeringProject,
  language: WorkspaceLanguage
): EngineeringProject {
  const variant = project.variants?.[language];
  if (!variant) return project;

  return {
    ...project,
    files: variant.files,
    stages: project.stages.map((stage, index) => ({
      ...stage,
      starterFiles: variant.stages[index]?.starterFiles ?? [],
      referenceFiles: variant.stages[index]?.referenceFiles ?? [],
      specs: variant.stages[index]?.specs ?? [],
    })),
  };
}

export function toFileMap(files: WorkspaceFile[]): Record<string, string> {
  return files.reduce<Record<string, string>>((acc, file) => {
    acc[file.path] = file.content;
    return acc;
  }, {});
}

/**
 * 计算到第 stageIndex 关为止应该出现在工作区里的文件。
 * 后面的关卡会追加新文件（渐进式解锁），已存在的文件不会被覆盖。
 */
export function buildStageFiles(project: EngineeringProject, stageIndex: number): WorkspaceFile[] {
  const files: WorkspaceFile[] = [];
  const seen = new Set<string>();

  const push = (file: WorkspaceFile) => {
    if (seen.has(file.path)) return;
    seen.add(file.path);
    files.push({ ...file });
  };

  (project.files || []).forEach(push);
  (project.stages || []).slice(0, stageIndex + 1).forEach((stage) => {
    (stage.starterFiles || []).forEach(push);
  });

  return files;
}

/** 用户草稿覆盖初始内容；只读文件永远使用工程给定的版本 */
export function applyDrafts(
  files: WorkspaceFile[],
  drafts: Record<string, string> | undefined
): WorkspaceFile[] {
  if (!drafts) return files;
  return files.map((file) =>
    file.readonly || drafts[file.path] === undefined
      ? file
      : { ...file, content: drafts[file.path] }
  );
}

/** 提交给运行器 / AI 评审的「用户代码」，不含只读的基础设施文件 */
export function editableFiles(files: WorkspaceFile[]): WorkspaceFile[] {
  return files.filter((file) => !file.readonly);
}

export function stageOf(project: EngineeringProject, stageIndex: number): ProjectStage | undefined {
  return project.stages?.[stageIndex];
}

/**
 * 工程里所有关卡涉及的文件（含尚未解锁的、以及其他语言版本的），用于校验草稿。
 *
 * 必须覆盖所有语言：不同语言的文件路径不同（.ts / .js），
 * 漏掉的话切换语言后，另一边的草稿会被当成孤儿清掉。
 */
export function allProjectFiles(project: EngineeringProject): Record<string, string> {
  const files: Record<string, string> = {};

  const collect = (list?: WorkspaceFile[]) => {
    for (const file of list || []) files[file.path] = file.content;
  };

  collect(project.files);
  for (const stage of project.stages || []) collect(stage.starterFiles);

  for (const variant of Object.values(project.variants || {})) {
    collect(variant?.files);
    for (const stage of variant?.stages || []) collect(stage.starterFiles);
  }

  return files;
}

/**
 * 清理草稿。
 *
 * 草稿存在 localStorage 里，生命周期比题目内容长：题目更新之后，
 * 那些「其实没改过、只是被记过一笔」的草稿会和新的初始内容对不上，
 * 于是文件被永久标成「已修改」。这里在载入时把两类草稿丢掉：
 *  1. 内容与初始版本完全相同的（等于没改）；
 *  2. 指向的文件已经不在这个工程里的。
 */
export function pruneDrafts(
  project: EngineeringProject,
  drafts: Record<string, string> | undefined
): Record<string, string> {
  if (!drafts) return {};

  const known = allProjectFiles(project);
  const cleaned: Record<string, string> = {};

  for (const [path, content] of Object.entries(drafts)) {
    const original = known[path];
    if (original === undefined) continue;
    if (original === content) continue;
    cleaned[path] = content;
  }

  return cleaned;
}

/**
 * 打开哪个文件。
 *
 * 取「最后一个」标了 openByDefault 的可编辑文件。工作区是累积的，每一关都会往后
 * 追加自己的主文件，所以最后一个才是当前关卡要写的那个；取第一个的话，做到第 4 关，
 * 编辑器里打开的仍然是第 1 关那个文件，看上去就像换了关卡内容却没变。
 */
export function defaultOpenPath(files: WorkspaceFile[]): string {
  const editable = files.filter((file) => !file.readonly);
  for (let index = editable.length - 1; index >= 0; index -= 1) {
    if (editable[index].openByDefault) return editable[index].path;
  }
  return (editable[0] || files[0])?.path || '';
}

/** 同一个文件的另一种语言写法：切语言时只是扩展名变了 */
function twinPath(path: string): string {
  if (path.endsWith('.ts')) return `${path.slice(0, -3)}.js`;
  if (path.endsWith('.js')) return `${path.slice(0, -3)}.ts`;
  return path;
}

export interface OpenFilesState {
  openPaths: string[];
  activePath: string;
}

/**
 * 文件集合变化之后，重算「打开着的标签」和「当前文件」。
 *
 * 三种变化要区别对待：
 *  - 换关卡：新解锁的主文件要自动打开并切过去，否则编辑器停在上一关的文件上；
 *  - 换语言：路径只是 .ts / .js 之差，标签和当前文件都跟着换，不该被清空；
 *  - 换工程：留下还存在的标签，其余丢掉。
 */
export function reconcileOpenFiles(input: {
  previousPaths: string[];
  paths: string[];
  defaultPath: string;
  openPaths: string[];
  activePath: string;
}): OpenFilesState {
  const { previousPaths, paths, defaultPath, openPaths, activePath } = input;

  const has = (path: string) => paths.includes(path);
  const follow = (path: string) => (has(path) ? path : has(twinPath(path)) ? twinPath(path) : null);
  const isNewlyUnlocked = (path: string) =>
    !previousPaths.includes(path) && !previousPaths.includes(twinPath(path));

  const nextOpen: string[] = [];
  for (const path of openPaths) {
    const next = follow(path);
    if (next && !nextOpen.includes(next)) nextOpen.push(next);
  }
  if (defaultPath && !nextOpen.includes(defaultPath) && (isNewlyUnlocked(defaultPath) || !nextOpen.length)) {
    nextOpen.push(defaultPath);
  }

  const nextActive =
    defaultPath && isNewlyUnlocked(defaultPath) ? defaultPath : follow(activePath) || defaultPath;

  return { openPaths: nextOpen, activePath: nextActive };
}

export function fileLanguage(path: string): string {
  if (/\.tsx?$/.test(path)) return 'typescript';
  if (/\.jsx?$/.test(path)) return 'javascript';
  if (/\.json$/.test(path)) return 'json';
  if (/\.md$/.test(path)) return 'markdown';
  if (/\.css$/.test(path)) return 'css';
  if (/\.html?$/.test(path)) return 'html';
  return 'plaintext';
}

/** 把扁平路径列表转成用于渲染的树 */
export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
  readonly?: boolean;
}

export function buildFileTree(files: WorkspaceFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sorted) {
    const segments = file.path.split('/');
    let level = root;
    let currentPath = '';

    segments.forEach((segment, index) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      let node = level.find((item) => item.name === segment && item.type === (isLeaf ? 'file' : 'directory'));

      if (!node) {
        node = {
          name: segment,
          path: currentPath,
          type: isLeaf ? 'file' : 'directory',
          children: isLeaf ? undefined : [],
          readonly: isLeaf ? file.readonly : undefined,
        };
        level.push(node);
      }

      if (!isLeaf) level = node.children!;
    });
  }

  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((node) => node.children && sortNodes(node.children));
    return nodes;
  };

  return sortNodes(root);
}
