/**
 * 工坊草稿的存储
 *
 * 草稿是用户花时间写出来的东西，丢了没法找回。这里钉住的是那些「看起来
 * 不可能出问题」的地方：索引和内容写岔了、删除留下孤儿、存储满了之后
 * 静默失败。
 */
import {
  DraftStorageFullError,
  deleteDraft,
  draftsByteSize,
  listDrafts,
  loadDraft,
  markInstalled,
  markPublished,
  newDraftId,
  saveDraft,
} from '../../src/lib/workshop/drafts';
import { blankAlgorithmProblem, blankEngineeringProject } from '../../src/lib/workshop/templates';

class MemoryStorage {
  store = new Map<string, string>();
  failOnSet = false;

  get length() {
    return this.store.size;
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    if (this.failOnSet) {
      const error = new Error('The quota has been exceeded.');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

let storage: MemoryStorage;

function seed(kind: 'algorithm' | 'engineering' = 'algorithm') {
  const id = newDraftId();
  const payload = kind === 'algorithm' ? blankAlgorithmProblem() : blankEngineeringProject();
  saveDraft({
    id,
    kind,
    title: payload.title.zh,
    createdAt: new Date().toISOString(),
    updatedAt: '',
    payload,
  });
  return id;
}

beforeEach(() => {
  storage = new MemoryStorage();
  (global as any).window = { localStorage: storage, dispatchEvent: () => true };
  (global as any).Event = class {
    constructor(public type: string) {}
  };
});

afterEach(() => {
  delete (global as any).window;
});

describe('draft ids', () => {
  it('does not collide', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newDraftId()));
    expect(ids.size).toBe(500);
  });
});

describe('saving and loading', () => {
  it('round-trips an algorithm draft', () => {
    const id = seed('algorithm');
    const loaded = loadDraft(id);

    expect(loaded).not.toBeNull();
    expect(loaded!.kind).toBe('algorithm');
    expect((loaded!.payload as any).tests).toHaveLength(3);
  });

  it('round-trips an engineering draft with its stages', () => {
    const id = seed('engineering');
    const loaded = loadDraft(id);

    expect((loaded!.payload as any).stages).toHaveLength(1);
    expect((loaded!.payload as any).stages[0].specs[0].path).toBe('spec/runAll.spec.ts');
  });

  it('returns null for an unknown id instead of throwing', () => {
    expect(loadDraft('nope')).toBeNull();
  });

  it('keeps createdAt but moves updatedAt on every save', () => {
    const id = seed();
    const created = listDrafts()[0].createdAt;

    saveDraft({ ...loadDraft(id)!, title: 'Renamed' });
    const after = listDrafts()[0];

    expect(after.createdAt).toBe(created);
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created));
    expect(after.title).toBe('Renamed');
  });

  it('does not duplicate the index entry when saving twice', () => {
    const id = seed();
    saveDraft({ ...loadDraft(id)!, title: 'Second' });
    saveDraft({ ...loadDraft(id)!, title: 'Third' });

    expect(listDrafts().filter((entry) => entry.id === id)).toHaveLength(1);
  });

  it('lists the most recently touched draft first', async () => {
    const first = seed();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = seed();

    expect(listDrafts()[0].id).toBe(second);

    await new Promise((resolve) => setTimeout(resolve, 5));
    saveDraft({ ...loadDraft(first)!, title: 'Touched' });
    expect(listDrafts()[0].id).toBe(first);
  });
});

describe('deleting', () => {
  it('removes both the index entry and the content', () => {
    const id = seed();
    expect(storage.store.size).toBe(2);

    deleteDraft(id);

    expect(listDrafts()).toHaveLength(0);
    expect(loadDraft(id)).toBeNull();
    // 内容没删干净的话，存储会被再也访问不到的草稿慢慢占满
    expect(Array.from(storage.store.keys()).some((key) => key.includes(id))).toBe(false);
  });

  it('is a no-op for an unknown id', () => {
    seed();
    expect(() => deleteDraft('nope')).not.toThrow();
    expect(listDrafts()).toHaveLength(1);
  });
});

describe('publish and install markers', () => {
  it('records the market slug so the next publish is a new version', () => {
    const id = seed();

    markPublished(id, 'sum-of-two-numbers');
    expect(listDrafts()[0].publishedSlug).toBe('sum-of-two-numbers');
    expect(loadDraft(id)!.publishedSlug).toBe('sum-of-two-numbers');

    // 后续保存不能把标记冲掉
    saveDraft({ ...loadDraft(id)!, title: 'Edited' });
    expect(listDrafts()[0].publishedSlug).toBe('sum-of-two-numbers');
  });

  it('records the local library id', () => {
    const id = seed();
    markInstalled(id, 'sum-of-two-numbers');

    expect(listDrafts()[0].installedId).toBe('sum-of-two-numbers');
    saveDraft({ ...loadDraft(id)!, title: 'Edited' });
    expect(listDrafts()[0].installedId).toBe('sum-of-two-numbers');
  });
});

describe('storage pressure', () => {
  it('reports a usable size estimate', () => {
    seed('engineering');
    expect(draftsByteSize()).toBeGreaterThan(1000);
  });

  it('turns a quota error into something the UI can explain', () => {
    storage.failOnSet = true;

    expect(() =>
      saveDraft({
        id: newDraftId(),
        kind: 'algorithm',
        title: 'Too big',
        createdAt: new Date().toISOString(),
        updatedAt: '',
        payload: blankAlgorithmProblem(),
      })
    ).toThrow(DraftStorageFullError);
  });
});
