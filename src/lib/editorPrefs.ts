/**
 * 编辑器偏好设置
 *
 * 自动换行、缩略图、字号这些是「个人习惯」，不该每次打开工作区都重设一遍，
 * 所以存本地。和关卡进度分开存，换工程也不会丢。
 */
export interface EditorPrefs {
  wordWrap: boolean;
  minimap: boolean;
  fontSize: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

const STORAGE_KEY = 'engineering-editor-prefs-v1';

export const DEFAULT_PREFS: EditorPrefs = {
  wordWrap: true,
  minimap: false,
  fontSize: 13,
  sidebarWidth: 230,
  sidebarCollapsed: false,
};

export const FONT_SIZE_RANGE = { min: 11, max: 20 };

export function loadEditorPrefs(): EditorPrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<EditorPrefs>;
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      fontSize: Math.min(
        FONT_SIZE_RANGE.max,
        Math.max(FONT_SIZE_RANGE.min, Number(parsed.fontSize) || DEFAULT_PREFS.fontSize)
      ),
      sidebarWidth: Math.min(420, Math.max(160, Number(parsed.sidebarWidth) || DEFAULT_PREFS.sidebarWidth)),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveEditorPrefs(prefs: EditorPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 隐私模式下 localStorage 可能不可写，忽略即可
  }
}

/** 按扩展名给文件配个颜色，扫一眼就能分辨类型 */
export function fileAccent(path: string): string {
  if (/\.tsx?$/.test(path)) return 'var(--mantine-color-blue-6)';
  if (/\.jsx?$/.test(path)) return 'var(--mantine-color-yellow-7)';
  if (/\.json$/.test(path)) return 'var(--mantine-color-orange-6)';
  if (/\.md$/.test(path)) return 'var(--mantine-color-gray-6)';
  if (/\.css$/.test(path)) return 'var(--mantine-color-grape-6)';
  return 'var(--mantine-color-gray-5)';
}

/** 模糊匹配：把 "spool" 也能匹配到 "src/pool.ts" */
export function fuzzyMatch(query: string, target: string): boolean {
  const needle = query.toLowerCase().replace(/\s+/g, '');
  if (!needle) return true;

  const haystack = target.toLowerCase();
  let index = 0;
  for (const char of needle) {
    index = haystack.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}
