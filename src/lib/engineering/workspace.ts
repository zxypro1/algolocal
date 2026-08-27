/**
 * 工作区装配：把「工程基础文件 + 各关解锁的文件 + 用户草稿」合成一棵文件树
 */
import type {
  EngineeringProject,
  ProjectStage,
  WorkspaceFile,
  WorkspaceKind,
  WorkspaceLanguage,
} from './types';

/**
 * 这个工程用哪种工作台。
 *
 * 不声明就是 'code'，也就是现有的「任务描述 + IDE + 结果面板」。
 * 所有既有项目（以及 AI 生成的项目，coerceProject 不产出这个字段）都落在这一支上。
 */
export function workspaceKindOf(project: Pick<EngineeringProject, 'workspace'>): WorkspaceKind {
  return project.workspace?.kind ?? 'code';
}

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

  /*
   * 实战关卡（ops / gpu）的文件不在 `starterFiles` 里，而在 `stage.ops.files` /
   * `stage.gpu.files` —— 那是「机器磁盘上的初始内容」，形状是 path -> content。
   *
   * **不收进来的话草稿就恢复不了。** 两个工作台都是这么找草稿的：
   *
   *   const draft = files.find((file) => file.path === path);
   *   out[path] = draft?.content ?? content;
   *
   * `files` 里从来没有这些路径，`find` 永远返回 undefined，于是永远回退到初始内容 ——
   * 学员改的 kernel / manifest 切走再切回来就变回原样。
   *
   * 只收**当前这一关**的，不像 starterFiles 那样累积：每一关的世界是各自重建的，
   * 把上一关的文件也铺进来只会让编辑器里多出这一关根本不存在的东西。
   */
  const current = (project.stages || [])[stageIndex];
  for (const [path, content] of Object.entries(labFilesOf(current))) {
    push({ path, content, draftKey: labDraftKey(current!.id, path) });
  }

  return files;
}

/** 一关的实战文件（机器磁盘上的初始内容）。code 形态没有这一项，返回空对象 */
export function labFilesOf(stage: ProjectStage | undefined): Record<string, string> {
  if (!stage) return {};
  const lab = stage as ProjectStage & { ops?: { files?: Record<string, string> }; gpu?: { files?: Record<string, string> } };
  return { ...(lab.ops?.files ?? {}), ...(lab.gpu?.files ?? {}) };
}

/**
 * 实战文件的草稿键。
 *
 * 带上关卡 id，因为同一个路径在不同关卡是不同的练习（见 WorkspaceFile.draftKey）。
 * 分隔符用 `::`：关卡 id 是 kebab-case，文件路径里也不会出现它。
 */
export function labDraftKey(stageId: string, path: string): string {
  return `${stageId}::${path}`;
}

/** 用户草稿覆盖初始内容；只读文件永远使用工程给定的版本 */
export function applyDrafts(
  files: WorkspaceFile[],
  drafts: Record<string, string> | undefined
): WorkspaceFile[] {
  if (!drafts) return files;
  return files.map((file) => {
    const key = file.draftKey ?? file.path;
    return file.readonly || drafts[key] === undefined
      ? file
      : { ...file, content: drafts[key] };
  });
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
  for (const stage of project.stages || []) {
    collect(stage.starterFiles);
    /*
     * 实战关卡的文件放在 stage.ops.files / stage.gpu.files 里
     * （机器磁盘上的 manifest、kernel 源码），一并收进来 ——
     * 这个函数的契约是「这个工程有的全部文件」，少一类就不成立。
     *
     * **注意别再把草稿的清理逻辑挂在这上面。** 曾经是那样的：ops 这一行的旧注释
     * 写着「不收进来草稿会被当成孤儿清掉」，而 gpu 那一行漏了整整一个工作台，
     * 于是 CUDA 关卡改的 kernel 每次载入都被清空。现在实战文件的草稿键带关卡 id，
     * 由 pruneDrafts 里的 labKnown 单独比对，不再走这里。
     */
    for (const [path, content] of Object.entries(stage.ops?.files ?? {})) files[path] = content;
    for (const [path, content] of Object.entries(stage.gpu?.files ?? {})) files[path] = content;
  }

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

  /*
   * 实战关卡的键是 `关卡id::路径`，要按那一关自己的初始内容比。
   * 用 allProjectFiles 里那份（同名路径的最后一关）比会得出错误结论：
   * 在第 9 关把 sgemm.cu 改成第 13 关的样子，草稿会被当成「和初始内容一样」丢掉。
   */
  const labKnown: Record<string, string> = {};
  for (const stage of project.stages || []) {
    for (const [path, content] of Object.entries(labFilesOf(stage))) {
      labKnown[labDraftKey(stage.id, path)] = content;
    }
  }

  const cleaned: Record<string, string> = {};

  for (const [key, content] of Object.entries(drafts)) {
    const original = key.includes('::') ? labKnown[key] : known[key];
    if (original === undefined) continue;
    if (original === content) continue;
    /*
     * 旧版本把实战文件按裸路径存过。那些草稿从来没有被读回去过
     * （两个工作台的恢复路径当时都是坏的），所以丢掉它们对学员是无感的；
     * 留着反而会在 localStorage 里越积越多。
     */
    if (!key.includes('::') && !isCumulativeFile(project, key)) continue;
    cleaned[key] = content;
  }

  return cleaned;
}

/** 这个路径是不是「累积工作区」里的文件（project.files 或某一关的 starterFiles） */
function isCumulativeFile(project: EngineeringProject, path: string): boolean {
  if ((project.files || []).some((file) => file.path === path)) return true;
  for (const stage of project.stages || []) {
    if ((stage.starterFiles || []).some((file) => file.path === path)) return true;
  }
  for (const variant of Object.values(project.variants || {})) {
    if ((variant?.files || []).some((file) => file.path === path)) return true;
    for (const stage of variant?.stages || []) {
      if ((stage.starterFiles || []).some((file) => file.path === path)) return true;
    }
  }
  return false;
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
