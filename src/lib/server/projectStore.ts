/**
 * 工程实战项目的服务端存储
 *
 * 预置项目随应用分发（只读），AI 生成的项目写到用户目录，
 * 这样打包后的桌面端也能正常写入，且升级应用不会丢失用户的题目。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { EngineeringProject } from '../engineering/types';
import { coerceProject } from '../engineering/validateProject';

const USER_DIR = path.join(os.homedir(), '.offline-leet-practice');
const USER_PROJECTS_FILE = path.join(USER_DIR, 'user-projects.json');

export interface StoredProject extends EngineeringProject {
  /** 预置项目不可删除 */
  source?: 'preset' | 'user';
}

/**
 * 列表页要的字段。
 *
 * 完整的题库有 295KB，其中绝大部分是每一关的隐藏用例和参考实现。列表页只渲染
 * 标题、简介、标签和关卡数，没必要把这些一起发下去 —— 题库还会随着用户生成
 * 新题目继续变大。
 */
export interface ProjectSummary {
  id: string;
  title: EngineeringProject['title'];
  summary: EngineeringProject['summary'];
  difficulty: EngineeringProject['difficulty'];
  domain: EngineeringProject['domain'];
  tags: EngineeringProject['tags'];
  estimatedMinutes: EngineeringProject['estimatedMinutes'];
  stageCount: number;
  source?: 'preset' | 'user';
}

export function summarizeProject(project: StoredProject): ProjectSummary {
  return {
    id: project.id,
    title: project.title,
    summary: project.summary,
    difficulty: project.difficulty,
    domain: project.domain,
    tags: project.tags,
    estimatedMinutes: project.estimatedMinutes,
    stageCount: project.stages?.length || 0,
    source: project.source,
  };
}

function appRoot(): string {
  return process.env.APP_ROOT || process.cwd();
}

/**
 * 预置题库随应用分发、进程生命周期内不会变，按 mtime 缓存解析结果。
 *
 * 之前每个请求都要重读并解析一遍 295KB：列表页一次、工作区一次，保存一道生成的
 * 题目更是要读三次文件、解析两遍 —— 都发生在服务 UI 的同一个线程上。
 */
let presetCache: { key: string; projects: StoredProject[] } | null = null;

export function loadPresetProjects(): StoredProject[] {
  const candidates = [
    path.join(appRoot(), 'public', 'projects.json'),
    path.join(appRoot(), 'projects', 'projects.json'),
  ];

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;

      const stat = fs.statSync(file);
      const key = `${file}:${stat.mtimeMs}:${stat.size}`;
      if (presetCache && presetCache.key === key) return presetCache.projects;

      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) {
        const projects = parsed.map((project) => ({ ...project, source: 'preset' as const }));
        presetCache = { key, projects };
        return projects;
      }
    } catch (error) {
      console.error(`Failed to read preset projects from ${file}:`, error);
    }
  }

  return [];
}

export function loadUserProjects(): StoredProject[] {
  try {
    if (!fs.existsSync(USER_PROJECTS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(USER_PROJECTS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return [];

    /**
     * 用户项目一律过一遍 coerceProject 再交出去。
     *
     * 这个文件是 AI 生成结果落盘的地方，也可以被手工改。以前它是原样读出来直接
     * 送进渲染层的：一份 `checklist` 写成字符串的项目会让 `checklist.map` 抛异常，
     * 整页白屏。保存那头现在有结构校验挡着，但**已经写进去的**坏数据只能在这里兜住。
     * 预置题库不走这条路——它由我们自己的构建流程产出并逐关验证过。
     */
    return parsed.map((project) => ({
      ...coerceProject(project),
      // coerceProject 会盖上当前时间，这里保留原始的生成时刻
      generatedAt: project?.generatedAt || undefined,
      source: 'user' as const,
    }));
  } catch (error) {
    console.error('Failed to read user projects:', error);
    return [];
  }
}

export function saveUserProjects(projects: StoredProject[]): void {
  fs.mkdirSync(USER_DIR, { recursive: true });
  const payload = projects.map(({ source, ...project }) => project);
  fs.writeFileSync(USER_PROJECTS_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

export function loadAllProjects(): StoredProject[] {
  const presets = loadPresetProjects();
  const users = loadUserProjects();
  const presetIds = new Set(presets.map((project) => project.id));
  return [...presets, ...users.filter((project) => !presetIds.has(project.id))];
}

/** 生成一个不冲突的 id */
export function uniqueProjectId(desired: string): string {
  const existing = new Set(loadAllProjects().map((project) => project.id));
  const base = (desired || 'engineering-project')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'engineering-project';

  if (!existing.has(base)) return base;

  let counter = 1;
  while (existing.has(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}

export function addUserProject(project: EngineeringProject): StoredProject {
  const stored = { ...project, id: uniqueProjectId(project.id) };
  const users = loadUserProjects();
  users.push(stored as StoredProject);
  saveUserProjects(users);
  return { ...stored, source: 'user' };
}

export function deleteUserProject(id: string): boolean {
  const users = loadUserProjects();
  const next = users.filter((project) => project.id !== id);
  if (next.length === users.length) return false;
  saveUserProjects(next);
  return true;
}
