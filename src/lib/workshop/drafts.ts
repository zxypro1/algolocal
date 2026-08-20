/**
 * 工坊草稿的本地存储
 *
 * 草稿完全存在浏览器里，不需要账号也不需要网络 —— 出题这件事本身跟云端无关，
 * 只有「发布到市场」才需要登录。这条边界要守住：工坊在飞机上也得能用。
 *
 * 每份草稿单独一个 key。一个 key 存全部的话，改一个字就要把几百 KB 的工程题
 * 重新序列化写一遍，输入会肉眼可见地卡。索引里只放元信息，列表页读它就够了。
 */
import type { EngineeringProject } from '../engineering/types';
import type { AlgorithmProblem } from './problem';

const INDEX_KEY = 'algolocal-workshop-index-v1';
const DRAFT_PREFIX = 'algolocal-workshop-draft-v1:';

export type DraftKind = 'algorithm' | 'engineering';

export interface DraftMeta {
  id: string;
  kind: DraftKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 已经发布过的话记下市场上的 slug，再次发布就是发新版本而不是新建 */
  publishedSlug?: string;
  publishedAt?: string;
  /** 已经存进本地题库的 id */
  installedId?: string;
}

export interface Draft<T = AlgorithmProblem | EngineeringProject> extends DraftMeta {
  payload: T;
}

export const WORKSHOP_DRAFTS_CHANGED = 'algolocal:workshop-drafts-changed';

function read<T>(key: string, fallback: T): T {
  try {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function announce(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(WORKSHOP_DRAFTS_CHANGED));
}

export function listDrafts(): DraftMeta[] {
  return read<DraftMeta[]>(INDEX_KEY, []).sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  );
}

export function loadDraft<T = AlgorithmProblem | EngineeringProject>(id: string): Draft<T> | null {
  const meta = listDrafts().find((entry) => entry.id === id);
  if (!meta) return null;

  const payload = read<T | null>(DRAFT_PREFIX + id, null);
  if (!payload) return null;

  return { ...meta, payload };
}

export function newDraftId(): string {
  // crypto.randomUUID 在 http 的非 localhost 源上不可用，这里给一个退路
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* 继续走下面的退路 */
  }
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class DraftStorageFullError extends Error {
  constructor() {
    super('The browser refused to store the draft, most likely because localStorage is full');
    this.name = 'DraftStorageFullError';
  }
}

export function saveDraft(draft: Draft): DraftMeta {
  const now = new Date().toISOString();
  const index = read<DraftMeta[]>(INDEX_KEY, []);
  const existing = index.find((entry) => entry.id === draft.id);

  const meta: DraftMeta = {
    id: draft.id,
    kind: draft.kind,
    title: draft.title,
    createdAt: existing?.createdAt || draft.createdAt || now,
    updatedAt: now,
    publishedSlug: draft.publishedSlug ?? existing?.publishedSlug,
    publishedAt: draft.publishedAt ?? existing?.publishedAt,
    installedId: draft.installedId ?? existing?.installedId,
  };

  try {
    // 先写内容再写索引：反过来的话，内容写失败会在列表里留下一条打不开的草稿
    write(DRAFT_PREFIX + draft.id, draft.payload);
    write(INDEX_KEY, [meta, ...index.filter((entry) => entry.id !== draft.id)]);
  } catch (error) {
    if (error instanceof Error && /quota|storage/i.test(error.name + error.message)) {
      throw new DraftStorageFullError();
    }
    throw error;
  }

  announce();
  return meta;
}

export function deleteDraft(id: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(DRAFT_PREFIX + id);
  write(INDEX_KEY, read<DraftMeta[]>(INDEX_KEY, []).filter((entry) => entry.id !== id));
  announce();
}

/** 发布成功后回填 slug，下次发布就走同一条记录 */
export function markPublished(id: string, slug: string): void {
  const index = read<DraftMeta[]>(INDEX_KEY, []);
  const next = index.map((entry) =>
    entry.id === id ? { ...entry, publishedSlug: slug, publishedAt: new Date().toISOString() } : entry
  );
  write(INDEX_KEY, next);
  announce();
}

export function markInstalled(id: string, installedId: string): void {
  const index = read<DraftMeta[]>(INDEX_KEY, []);
  const next = index.map((entry) => (entry.id === id ? { ...entry, installedId } : entry));
  write(INDEX_KEY, next);
  announce();
}

/** 估算草稿占了多少存储，列表页用它在接近上限前提醒用户 */
export function draftsByteSize(): number {
  if (typeof window === 'undefined') return 0;
  let total = 0;
  for (const meta of listDrafts()) {
    total += (window.localStorage.getItem(DRAFT_PREFIX + meta.id) || '').length;
  }
  return total * 2; // localStorage 存的是 UTF-16
}
