/**
 * 算法题草稿的回归测试
 *
 * 这块之前完全没有：刷新一下、切个语言、点错返回键，写了一半的解法就没了。
 * 会丢用户代码的逻辑值得钉住。
 */
import { clearDraft, draftedProblemIds, loadDraft, saveDraft } from '../../src/lib/problemDrafts';

// jest 的 testEnvironment 是 node，这里补一个够用的 localStorage
class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  clear() {
    this.store.clear();
  }
}

describe('problem drafts', () => {
  beforeEach(() => {
    (global as any).window = { localStorage: new MemoryStorage() };
  });

  afterEach(() => {
    delete (global as any).window;
  });

  it('round-trips a draft', () => {
    saveDraft('two-sum', 'javascript', 'function twoSum() {}');
    expect(loadDraft('two-sum', 'javascript')).toBe('function twoSum() {}');
  });

  it('returns null when nothing was saved', () => {
    expect(loadDraft('two-sum', 'python')).toBeNull();
  });

  /** 同一道题用两种语言各写一版是常见的，不该互相覆盖 */
  it('keeps one draft per language', () => {
    saveDraft('two-sum', 'javascript', 'const a = 1;');
    saveDraft('two-sum', 'python', 'a = 1');

    expect(loadDraft('two-sum', 'javascript')).toBe('const a = 1;');
    expect(loadDraft('two-sum', 'python')).toBe('a = 1');
  });

  it('keeps drafts of different problems apart', () => {
    saveDraft('two-sum', 'javascript', 'A');
    saveDraft('three-sum', 'javascript', 'B');

    expect(loadDraft('two-sum', 'javascript')).toBe('A');
    expect(loadDraft('three-sum', 'javascript')).toBe('B');
  });

  it('clears a single draft without touching the others', () => {
    saveDraft('two-sum', 'javascript', 'A');
    saveDraft('two-sum', 'python', 'B');

    clearDraft('two-sum', 'javascript');

    expect(loadDraft('two-sum', 'javascript')).toBeNull();
    expect(loadDraft('two-sum', 'python')).toBe('B');
  });

  it('clearing something that was never saved is a no-op', () => {
    expect(() => clearDraft('nope', 'javascript')).not.toThrow();
  });

  it('lists which problems have drafts', () => {
    saveDraft('two-sum', 'javascript', 'A');
    saveDraft('two-sum', 'python', 'B');
    saveDraft('lru-cache', 'javascript', 'C');

    expect(Array.from(draftedProblemIds()).sort()).toEqual(['lru-cache', 'two-sum']);
  });

  it('survives a corrupted storage payload', () => {
    (global as any).window.localStorage.setItem('problem-drafts-v1', '{not json');
    expect(loadDraft('two-sum', 'javascript')).toBeNull();

    saveDraft('two-sum', 'javascript', 'recovered');
    expect(loadDraft('two-sum', 'javascript')).toBe('recovered');
  });

  it('evicts the oldest drafts instead of growing without bound', () => {
    for (let index = 0; index < 210; index += 1) {
      saveDraft(`problem-${index}`, 'javascript', `code ${index}`);
    }

    const stored = JSON.parse(
      (global as any).window.localStorage.getItem('problem-drafts-v1') as string
    );
    expect(Object.keys(stored).length).toBeLessThanOrEqual(200);
    // 最近写的那些必须还在
    expect(loadDraft('problem-209', 'javascript')).toBe('code 209');
  });

  /**
   * 对应一个真实回归：保存逻辑挂在 useEffect([code]) 上，首帧读到的是
   * 上一帧的空字符串，于是存下一条空草稿，把题目的初始模板顶掉了。
   * 空草稿一律视为「没有草稿」，既是修复也是对已有坏数据的自愈。
   */
  it('treats an empty draft as no draft', () => {
    saveDraft('two-sum', 'javascript', '');
    expect(loadDraft('two-sum', 'javascript')).toBeNull();

    saveDraft('two-sum', 'javascript', '   \n  ');
    expect(loadDraft('two-sum', 'javascript')).toBeNull();
  });

  it('saving empty clears a previously saved draft', () => {
    saveDraft('two-sum', 'javascript', 'real code');
    saveDraft('two-sum', 'javascript', '');
    expect(loadDraft('two-sum', 'javascript')).toBeNull();
  });

  it('heals an empty draft written by an older build', () => {
    (global as any).window.localStorage.setItem(
      'problem-drafts-v1',
      JSON.stringify({ 'two-sum::javascript': { code: '', updatedAt: 1 } })
    );
    expect(loadDraft('two-sum', 'javascript')).toBeNull();
  });

  it('does nothing outside the browser', () => {
    delete (global as any).window;
    expect(loadDraft('two-sum', 'javascript')).toBeNull();
    expect(() => saveDraft('two-sum', 'javascript', 'x')).not.toThrow();
  });
});
