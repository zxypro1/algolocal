/**
 * 工程实战的本地进度
 *
 * 和算法练习一样保持纯本地（localStorage），不依赖任何后端：
 * 草稿代码、当前关卡、通关记录、历史得分都存在浏览器里。
 */

export interface StageAttempt {
  stageId: string;
  at: string;
  passedCases: number;
  totalCases: number;
  gatesPassed: boolean;
  score: number;
}

export interface ProjectProgress {
  projectId: string;
  /** 用哪种语言做这道题，不设则用工程的默认语言 */
  language?: 'typescript' | 'javascript';
  currentStage: number;
  completedStages: string[];
  /** 用户编辑过的文件内容 */
  drafts: Record<string, string>;
  /** 每关已解锁的提示条数 */
  revealedHints: Record<string, number>;
  attempts: StageAttempt[];
  updatedAt: string;
}

const STORAGE_PREFIX = 'engineering-progress-v1:';
export const ENGINEERING_PROGRESS_UPDATED_EVENT = 'engineering-progress-updated';
const MAX_ATTEMPTS = 200;

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

export function emptyProgress(projectId: string): ProjectProgress {
  return {
    projectId,
    currentStage: 0,
    completedStages: [],
    drafts: {},
    revealedHints: {},
    attempts: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadProgress(projectId: string): ProjectProgress {
  if (typeof window === 'undefined') return emptyProgress(projectId);
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    if (!raw) return emptyProgress(projectId);
    const parsed = JSON.parse(raw) as ProjectProgress;
    return {
      ...emptyProgress(projectId),
      ...parsed,
      drafts: parsed.drafts && typeof parsed.drafts === 'object' ? parsed.drafts : {},
      completedStages: Array.isArray(parsed.completedStages) ? parsed.completedStages : [],
      revealedHints: parsed.revealedHints && typeof parsed.revealedHints === 'object' ? parsed.revealedHints : {},
      attempts: Array.isArray(parsed.attempts) ? parsed.attempts.slice(-MAX_ATTEMPTS) : [],
    };
  } catch {
    return emptyProgress(projectId);
  }
}

export function saveProgress(progress: ProjectProgress): void {
  if (typeof window === 'undefined') return;
  const next: ProjectProgress = {
    ...progress,
    attempts: progress.attempts.slice(-MAX_ATTEMPTS),
    updatedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(storageKey(progress.projectId), JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(ENGINEERING_PROGRESS_UPDATED_EVENT, { detail: progress.projectId }));
  } catch (error) {
    console.error('Failed to persist engineering progress', error);
  }
}

export function resetProgress(projectId: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(storageKey(projectId));
  window.dispatchEvent(new CustomEvent(ENGINEERING_PROGRESS_UPDATED_EVENT, { detail: projectId }));
}

/** 首页/列表页用：一次性读出所有工程的进度概览 */
export function loadAllProgress(): Record<string, ProjectProgress> {
  if (typeof window === 'undefined') return {};
  const result: Record<string, ProjectProgress> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
    const projectId = key.slice(STORAGE_PREFIX.length);
    result[projectId] = loadProgress(projectId);
  }
  return result;
}
