/**
 * 算法题的代码草稿
 *
 * 之前这边的代码完全不保存：刷新一下、切个语言、点错返回键，写了一半的解法就没了。
 * 工程实战那边已经有草稿机制，这里补上同样的能力。
 *
 * 按「题目 + 语言」分别存：同一道题用 JS 和 Python 各写一版是常见的，
 * 两边不该互相覆盖。
 */

const STORAGE_KEY = 'problem-drafts-v1';
const MAX_DRAFTS = 200;

interface DraftRecord {
  code: string;
  updatedAt: number;
}

type DraftMap = Record<string, DraftRecord>;

function draftKey(problemId: string, language: string): string {
  return `${problemId}::${language}`;
}

function readAll(): DraftMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(drafts: DraftMap): void {
  if (typeof window === 'undefined') return;
  try {
    let entries = Object.entries(drafts);
    // 攒太多会把 localStorage 撑满，按时间淘汰最旧的
    if (entries.length > MAX_DRAFTS) {
      entries = entries
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, MAX_DRAFTS);
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 隐私模式或配额满了，忽略即可，不该因此打断做题
  }
}

/**
 * 空草稿一律当作「没有草稿」。
 *
 * 一个空文件对任何人都没有价值，而「把编辑器清空后刷新，回到初始模板」
 * 也比「回到一个空文件」更符合预期。这条规则同时能自愈历史上误存的空草稿。
 */
function isMeaningful(code: string | undefined): boolean {
  return typeof code === 'string' && code.trim().length > 0;
}

export function loadDraft(problemId: string, language: string): string | null {
  const record = readAll()[draftKey(problemId, language)];
  return record && isMeaningful(record.code) ? record.code : null;
}

export function saveDraft(problemId: string, language: string, code: string): void {
  if (!isMeaningful(code)) {
    clearDraft(problemId, language);
    return;
  }

  const drafts = readAll();
  drafts[draftKey(problemId, language)] = { code, updatedAt: Date.now() };
  writeAll(drafts);
}

/** 还原成初始模板时调用：把这条草稿删掉，而不是存一份和模板一样的 */
export function clearDraft(problemId: string, language: string): void {
  const drafts = readAll();
  if (!(draftKey(problemId, language) in drafts)) return;
  delete drafts[draftKey(problemId, language)];
  writeAll(drafts);
}

/** 首页/列表页可以用它标出「写过一半」的题 */
export function draftedProblemIds(): Set<string> {
  return new Set(Object.keys(readAll()).map((key) => key.split('::')[0]));
}
