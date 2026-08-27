/**
 * 工程实战的会话状态：载入工程、管理进度与草稿、切关卡、切语言、重置
 *
 * 这些和「工作台长什么样」无关 —— 不管是现有的「任务描述 + IDE」，还是后面
 * 内网设施那种「终端 + IDE + 拓扑图」，需要的都是同一份进度与草稿逻辑。
 * 所以它从 pages/projects/[id].tsx 里原样搬出来，各形态的工作台共用。
 *
 * 页面本身退化成一个分发器：拿到会话，按 workspace.kind 渲染对应的工作台。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../contexts/I18nContext';
import {
  applyDrafts,
  availableLanguages,
  buildStageFiles,
  labDraftKey,
  labFilesOf,
  projectView,
  pruneDrafts,
  toFileMap,
} from '../lib/engineering/workspace';
import { loadProgress, ProjectProgress, resetProgress, saveProgress } from '../lib/engineering/progress';
import type {
  EngineeringProject,
  LocalizedText,
  ProjectStage,
  WorkspaceFile,
  WorkspaceLanguage,
} from '../lib/engineering/types';

/** 停止输入多久之后落盘 */
const SAVE_DEBOUNCE_MS = 800;

/**
 * 换关卡 / 换语言 / 重置时要清掉哪些结果。
 *
 * 'all' 连同静态分析、评分卡、AI 评审一起清；'report' 只清运行结果 ——
 * 「重置本关」保留的正是后面那几项，这个区别要原样保住。
 */
export type ResultScope = 'all' | 'report';

export interface UseProjectSessionOptions {
  /** 工程 id，来自路由。还没解析出来时传 undefined */
  projectId: string | undefined;
  /** 由工作台实现：清掉它自己那份运行结果 */
  onClearResults?: (scope: ResultScope) => void;
}

export interface ProjectSession {
  project: EngineeringProject | null;
  loading: boolean;
  loadError: string | null;
  progress: ProjectProgress | null;

  /** 按当前语言取出的工程视图：关卡描述共用，代码与隐藏用例随语言切换 */
  view: EngineeringProject | null;
  languages: WorkspaceLanguage[];
  language: WorkspaceLanguage;

  stage: ProjectStage | undefined;
  stageIndex: number;
  stageCount: number;

  /** 本关应该出现的文件（不含草稿） */
  stageFiles: WorkspaceFile[];
  /** 各文件的初始内容，用来判断「改过没有」和支持单文件还原 */
  pristine: Record<string, string>;
  /** 应用草稿之后的文件，也就是编辑器与运行器看到的那一份 */
  files: WorkspaceFile[];

  savedAt: number | undefined;
  unsavedPaths: Set<string>;

  pick: (text: LocalizedText | undefined) => string;

  handleFileChange: (path: string, content: string) => void;
  handleResetFile: (path: string) => void;
  handleResetStage: () => void;
  handleResetProject: () => void;
  goToStage: (index: number) => void;
  handleLanguageChange: (next: WorkspaceLanguage) => void;
  revealHint: (stageId: string, revealed: number) => void;
  /** 跑完一次验收：记一笔尝试，通过则解锁下一关 */
  recordAttempt: (input: {
    stageId: string;
    passed: boolean;
    passedCases: number;
    totalCases: number;
    gatesPassed: boolean;
    score: number;
  }) => void;
  flushSave: () => void;
}

export function useProjectSession({
  projectId,
  onClearResults,
}: UseProjectSessionOptions): ProjectSession {
  const { locale } = useI18n();

  const [project, setProject] = useState<EngineeringProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProjectProgress | null>(null);

  const pick = useCallback(
    (text: LocalizedText | undefined) =>
      !text ? '' : text[locale as 'en' | 'zh'] || text.zh || text.en || '',
    [locale]
  );

  /**
   * 清结果的回调放进 ref。
   *
   * 工作台每次渲染都会新建这个函数，直接进依赖数组的话，下面每个
   * useCallback 都会跟着重建，把「稳定引用」这件事整个作废。
   */
  const clearResultsRef = useRef(onClearResults);
  clearResultsRef.current = onClearResults;
  const clearResults = useCallback((scope: ResultScope) => {
    clearResultsRef.current?.(scope);
  }, []);

  /* ---------------- 载入工程与进度 ---------------- */

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;
    (async () => {
      try {
        // 只取这一个工程，不再把整个题库拉下来
        const response = await fetch(`/api/projects?id=${encodeURIComponent(projectId)}`);
        if (response.status === 404) throw new Error('Project not found');
        if (!response.ok) throw new Error('Failed to load project');
        const found: EngineeringProject = await response.json();
        if (cancelled) return;
        setProject(found);

        // 题目内容更新后，旧草稿可能已经和初始版本对不上，先清一遍
        const stored = loadProgress(found.id);
        const drafts = pruneDrafts(found, stored.drafts);
        const cleaned = { ...stored, drafts };
        if (Object.keys(drafts).length !== Object.keys(stored.drafts).length) {
          saveProgress(cleaned);
        }
        setProgress(cleaned);
      } catch (error) {
        if (!cancelled) setLoadError((error as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /* ---------------- 派生工作区 ---------------- */

  const languages = useMemo(() => (project ? availableLanguages(project) : []), [project]);
  const language: WorkspaceLanguage = progress?.language ?? languages[0] ?? 'typescript';

  const view = useMemo(
    () => (project ? projectView(project, language) : null),
    [project, language]
  );

  /**
   * 关卡下标要按当前题目夹一遍。
   *
   * 进度存在 localStorage 里，生命周期比题目长：题目被改短（AI 生成的工程重新生成过、
   * 预置题目减了一关）之后，存着的 currentStage 会指向不存在的关卡，页面直接渲染
   * 「找不到」——而那个页面没有重置入口，用户就被永久锁在外面了。
   */
  const stageCount = view?.stages?.length ?? 0;
  const stageIndex = stageCount ? Math.min(Math.max(progress?.currentStage ?? 0, 0), stageCount - 1) : 0;
  const stage = view?.stages?.[stageIndex];

  const stageFiles = useMemo(
    () => (view ? buildStageFiles(view, stageIndex) : []),
    [view, stageIndex]
  );

  const pristine = useMemo(() => toFileMap(stageFiles), [stageFiles]);

  const files = useMemo(
    () => applyDrafts(stageFiles, progress?.drafts),
    [stageFiles, progress?.drafts]
  );

  /* ---------------- 保存 ----------------
   *
   * 编辑器里的内容是即时生效的（跑验收用的就是内存里那份），
   * 但落盘做了防抖：一来不必每敲一个字就把整个进度对象序列化一遍，
   * 二来「未保存」这个状态才有真实含义，指示器才不是摆设。
   */
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  const [unsavedPaths, setUnsavedPaths] = useState<Set<string>>(() => new Set());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<ProjectProgress | null>(null);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    saveProgress(pending);
    setUnsavedPaths(new Set());
    setSavedAt(Date.now());
  }, []);

  const scheduleSave = useCallback(
    (next: ProjectProgress) => {
      pendingRef.current = next;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
    },
    [flushSave]
  );

  // 关标签页、切到后台、离开页面时都要把待写内容落下去，
  // 这样即使有未保存窗口也不会真的丢东西
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushSave();
    };
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flushSave);
      document.removeEventListener('visibilitychange', onHidden);
      flushSave();
    };
  }, [flushSave]);

  /** 取消排队中的防抖落盘。重置类操作必须先做这一步，否则旧值 800ms 后会把新状态盖回去 */
  const cancelPendingSave = useCallback(() => {
    pendingRef.current = null;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  /** 关卡推进、解锁提示这类离散操作直接落盘，不走防抖 */
  const persist = useCallback(
    (next: ProjectProgress) => {
      setProgress(next);
      cancelPendingSave();
      saveProgress(next);
      setUnsavedPaths(new Set());
      setSavedAt(Date.now());
    },
    [cancelPendingSave]
  );

  /**
   * 进度的最新值。
   *
   * 跑验收要 await（最长 30 秒），期间用户还在改代码，闭包里的 progress 早就过期了。
   * 拿它去 persist 会把这段时间里的全部改动从 state 和 localStorage 两边一起抹掉。
   */
  const progressRef = useRef<ProjectProgress | null>(null);
  progressRef.current = progress;

  // 草稿写入要用最新的初始内容做对比，用 ref 避免把 handleFileChange 变成每次渲染都新建
  const pristineRef = useRef<Record<string, string>>({});
  pristineRef.current = pristine;

  /**
   * path -> 草稿键。
   *
   * 累积工作区的文件用裸路径，实战关卡的文件用 `关卡id::路径`
   * （理由见 WorkspaceFile.draftKey）。工作台调 handleFileChange 时只给路径，
   * 键在这里查出来 —— 免得每个工作台各自拼一遍、拼法还可能不一致。
   */
  const draftKeyRef = useRef<(path: string) => string>((path) => path);
  draftKeyRef.current = (path: string) => {
    const match = stageFiles.find((file) => file.path === path);
    return match?.draftKey ?? path;
  };

  /**
   * 改一个文件。
   *
   * 落盘安排放在 setState **外面**：updater 必须是纯函数，React 可能重复执行它，
   * 也可能在更新的基准状态上重跑一次 —— 那样 pendingRef 里会留下一份基于旧 prev
   * 算出来的进度，800ms 后把中间的按键覆盖掉。CodeRunner 那边也是同样的写法。
   */
  const handleFileChange = useCallback(
    (path: string, content: string) => {
      const current = progressRef.current;
      if (!current) return;

      const key = draftKeyRef.current(path);
      const drafts = { ...current.drafts };
      if (pristineRef.current[path] === content) {
        // 改回原样就不该再算作草稿，否则这个文件会一直挂着「已修改」
        if (drafts[key] === undefined) return;
        delete drafts[key];
      } else {
        if (drafts[key] === content) return;
        drafts[key] = content;
      }

      const next = { ...current, drafts };
      progressRef.current = next;
      setProgress(next);
      scheduleSave(next);

      setUnsavedPaths((prev) => {
        if (prev.has(path)) return prev;
        const updated = new Set(prev);
        updated.add(path);
        return updated;
      });
    },
    [scheduleSave]
  );

  /* ---------------- 关卡切换 ---------------- */

  const goToStage = useCallback(
    (index: number) => {
      if (!project || !progress) return;
      if (index < 0 || index >= project.stages.length) return;
      clearResults('all');
      persist({ ...progress, currentStage: index });
    },
    [clearResults, persist, progress, project]
  );

  const handleLanguageChange = useCallback(
    (next: WorkspaceLanguage) => {
      if (!progress || next === language) return;
      // 两种语言的文件路径不同（.ts / .js），草稿各存各的，切回来还在
      clearResults('all');
      persist({ ...progress, language: next });
    },
    [clearResults, language, persist, progress]
  );

  /** 把单个文件还原成本关的初始内容 */
  const handleResetFile = useCallback(
    (path: string) => {
      const current = progressRef.current;
      const key = draftKeyRef.current(path);
      if (!current || current.drafts[key] === undefined) return;

      const drafts = { ...current.drafts };
      delete drafts[key];
      // 还原是一个明确动作，直接落盘，别留在防抖队列里
      persist({ ...current, drafts });
    },
    [persist]
  );

  const handleResetStage = useCallback(() => {
    const current = progressRef.current;
    if (!project || !current || !stage) return;

    /**
     * 只还原**本关**解锁的文件。
     *
     * buildStageFiles 是累积的（基础文件 + 第 1..N 关的初始文件），拿它当作
     * 「本关的文件」会把前几关写的实现一起删掉 —— 在第 4 关点一下「重置本关」，
     * 第 1、2、3 关的代码从内存和 localStorage 一起消失，且不可撤销。
     */
    const stageKeys = new Set<string>(
      (stage.starterFiles || []).filter((file) => !file.readonly).map((file) => file.path)
    );
    // 实战关卡的文件不在 starterFiles 里，键也带着关卡 id —— 不加这一段，
    // 在 ops / gpu 关卡点「重置本关」会一个文件都还原不了
    for (const path of Object.keys(labFilesOf(stage))) {
      stageKeys.add(labDraftKey(stage.id, path));
    }
    const drafts = Object.fromEntries(
      Object.entries(current.drafts).filter(([key]) => !stageKeys.has(key))
    );
    clearResults('report');
    persist({ ...current, drafts });
  }, [clearResults, persist, project, stage]);

  const handleResetProject = useCallback(() => {
    if (!project) return;
    // 先掐掉排队中的落盘：否则 800ms 后那份旧进度会被写回去，重置等于没做
    cancelPendingSave();
    resetProgress(project.id);
    clearResults('all');
    setUnsavedPaths(new Set());
    setProgress(loadProgress(project.id));
  }, [cancelPendingSave, clearResults, project]);

  const revealHint = useCallback(
    (stageId: string, revealed: number) => {
      const current = progressRef.current;
      if (!current) return;
      persist({
        ...current,
        revealedHints: { ...current.revealedHints, [stageId]: revealed + 1 },
      });
    },
    [persist]
  );

  const recordAttempt = useCallback<ProjectSession['recordAttempt']>(
    ({ stageId, passed, passedCases, totalCases, gatesPassed, score }) => {
      // 用 ref 里的最新进度，而不是闭包捕获的那份：运行期间用户敲进去的代码
      // 都在 drafts 里，用旧值 persist 会把它们全部丢掉
      const latest = progressRef.current;
      if (!latest) return;

      const completedStages = passed && !latest.completedStages.includes(stageId)
        ? [...latest.completedStages, stageId]
        : latest.completedStages;

      persist({
        ...latest,
        completedStages,
        attempts: [
          ...latest.attempts,
          {
            stageId,
            at: new Date().toISOString(),
            passedCases,
            totalCases,
            gatesPassed,
            score,
          },
        ],
      });
    },
    [persist]
  );

  return {
    project,
    loading,
    loadError,
    progress,
    view,
    languages,
    language,
    stage,
    stageIndex,
    stageCount,
    stageFiles,
    pristine,
    files,
    savedAt,
    unsavedPaths,
    pick,
    handleFileChange,
    handleResetFile,
    handleResetStage,
    handleResetProject,
    goToStage,
    handleLanguageChange,
    revealHint,
    recordAttempt,
    flushSave,
  };
}

export default useProjectSession;
