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

const USER_DIR = path.join(os.homedir(), '.offline-leet-practice');
const USER_PROJECTS_FILE = path.join(USER_DIR, 'user-projects.json');

export interface StoredProject extends EngineeringProject {
  /** 预置项目不可删除 */
  source?: 'preset' | 'user';
}

function appRoot(): string {
  return process.env.APP_ROOT || process.cwd();
}

export function loadPresetProjects(): StoredProject[] {
  const candidates = [
    path.join(appRoot(), 'public', 'projects.json'),
    path.join(appRoot(), 'projects', 'projects.json'),
  ];

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) {
        return parsed.map((project) => ({ ...project, source: 'preset' as const }));
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
    return parsed.map((project) => ({ ...project, source: 'user' as const }));
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
