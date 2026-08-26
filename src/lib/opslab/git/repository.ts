/**
 * 一个仓库
 *
 * 对象、引用、索引全都落在 `.git/` 下面 —— 不是为了好看：世界要能快照回放，
 * 而快照的是文件系统。把仓库状态藏在内存里，回放就对不上了。
 * 顺带的好处是 `find .git/objects` 真的能翻，`cat .git/HEAD` 真的有东西。
 */
import type { Vfs } from '../../labkit/machine/vfs';
import {
  Commit, FileMap, ObjectStore, encodeCommit, parseCommit, readTree, writeTree,
  type GitObjectType,
} from './objects';

export const DEFAULT_BRANCH = 'main';

/** 把 `.git/objects` 当成对象库来读写 */
class VfsObjectStore extends ObjectStore {
  constructor(private readonly vfs: Vfs, private readonly gitDir: string) {
    super();
  }

  put(type: GitObjectType, body: string): string {
    const hash = super.put(type, body);
    const path = `${this.gitDir}/objects/${hash.slice(0, 2)}/${hash.slice(2)}`;
    if (!this.vfs.exists(path)) this.vfs.writeFile(path, `${type}\n${body}`);
    return hash;
  }

  get(hash: string): { type: GitObjectType; body: string } | undefined {
    const cached = super.get(hash);
    if (cached) return cached;
    const path = `${this.gitDir}/objects/${hash.slice(0, 2)}/${hash.slice(2)}`;
    if (!this.vfs.exists(path)) return undefined;
    const raw = this.vfs.readFile(path);
    const split = raw.indexOf('\n');
    const object = { type: raw.slice(0, split) as GitObjectType, body: raw.slice(split + 1) };
    super.put(object.type, object.body);
    return object;
  }

  has(hash: string): boolean {
    return this.get(hash) !== undefined;
  }
}

export interface GitIdentity {
  name: string;
  email: string;
}

export class Repository {
  readonly objects: ObjectStore;

  constructor(
    private readonly vfs: Vfs,
    /** 工作树的根，如 `/root/platform` */
    readonly root: string,
    private readonly now: () => number
  ) {
    this.objects = new VfsObjectStore(vfs, this.gitDir);
  }

  get gitDir(): string {
    return `${this.root}/.git`;
  }

  static find(vfs: Vfs, cwd: string, now: () => number): Repository | undefined {
    let current = cwd;
    for (;;) {
      if (vfs.exists(`${current}/.git/HEAD`)) return new Repository(vfs, current, now);
      const parent = current.replace(/\/[^/]*$/, '');
      if (!parent || parent === current) return undefined;
      current = parent;
    }
  }

  init(branch = DEFAULT_BRANCH): void {
    this.vfs.mkdirp(`${this.gitDir}/objects`);
    this.vfs.mkdirp(`${this.gitDir}/refs/heads`);
    this.vfs.writeFile(`${this.gitDir}/HEAD`, `ref: refs/heads/${branch}\n`);
    this.vfs.writeFile(`${this.gitDir}/index`, '{}\n');
  }

  /* ---------------- 引用 ---------------- */

  head(): string {
    return this.vfs.readFile(`${this.gitDir}/HEAD`).trim();
  }

  currentBranch(): string | undefined {
    const head = this.head();
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : undefined;
  }

  branches(): string[] {
    const dir = `${this.gitDir}/refs/heads`;
    return this.vfs.exists(dir) ? this.vfs.readDir(dir).sort() : [];
  }

  ref(branch: string): string | undefined {
    const path = `${this.gitDir}/refs/heads/${branch}`;
    return this.vfs.exists(path) ? this.vfs.readFile(path).trim() : undefined;
  }

  setRef(branch: string, hash: string): void {
    this.vfs.writeFile(`${this.gitDir}/refs/heads/${branch}`, `${hash}\n`);
  }

  /** HEAD 指向的 commit。空仓库返回 undefined。 */
  headCommit(): string | undefined {
    const branch = this.currentBranch();
    if (branch) return this.ref(branch);
    return this.head() || undefined;
  }

  checkout(branch: string, create = false): void {
    if (create) {
      const current = this.headCommit();
      if (current) this.setRef(branch, current);
      else this.vfs.mkdirp(`${this.gitDir}/refs/heads`);
    }
    this.vfs.writeFile(`${this.gitDir}/HEAD`, `ref: refs/heads/${branch}\n`);
    const target = this.ref(branch);
    if (target) this.restoreWorktree(target);
  }

  /* ---------------- 索引与工作树 ---------------- */

  index(): Record<string, string> {
    const path = `${this.gitDir}/index`;
    if (!this.vfs.exists(path)) return {};
    try {
      return JSON.parse(this.vfs.readFile(path)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writeIndex(index: Record<string, string>): void {
    const ordered = Object.fromEntries(Object.entries(index).sort(([a], [b]) => (a < b ? -1 : 1)));
    this.vfs.writeFile(`${this.gitDir}/index`, `${JSON.stringify(ordered, null, 2)}\n`);
  }

  /** 工作树上的文件（不含 .git） */
  worktree(): FileMap {
    const files: FileMap = {};
    for (const path of this.vfs.walkAll(this.root)) {
      if (!this.vfs.isFile(path)) continue;
      const relative = path.slice(this.root.length + 1);
      if (relative.startsWith('.git/') || relative === '.git') continue;
      files[relative] = this.vfs.readFile(path);
    }
    return files;
  }

  /** HEAD 那次提交的内容 */
  committed(): FileMap {
    const head = this.headCommit();
    if (!head) return {};
    const commit = this.commit(head);
    return commit ? readTree(this.objects, commit.tree) : {};
  }

  /**
   * `git add`
   *
   * 只动 pathspec 覆盖到的那些路径。删除同样要进暂存区，但**也只限这些路径** ——
   * `git add b.yaml` 不该顺手把别处删掉的文件也暂存了。
   */
  add(paths: string[]): { added: string[]; missing: string[] } {
    const worktree = this.worktree();
    const index = this.index();
    const added: string[] = [];
    const missing: string[] = [];
    for (const raw of paths) {
      const wanted = raw === '.' || raw === './' ? '' : raw.replace(/^\.\//, '').replace(/\/$/, '');
      const covers = (file: string) => wanted === '' || file === wanted || file.startsWith(`${wanted}/`);
      const matched = Object.keys(worktree).filter(covers);
      const removed = Object.keys(index).filter((file) => covers(file) && !(file in worktree));
      if (matched.length === 0 && removed.length === 0) { missing.push(raw); continue; }
      for (const file of matched) {
        index[file] = this.objects.put('blob', worktree[file]);
        added.push(file);
      }
      for (const file of removed) delete index[file];
    }
    this.writeIndex(index);
    return { added, missing };
  }

  /** `git commit -a`：只重新暂存已跟踪的文件，不碰未跟踪的 */
  restageTracked(): void {
    this.add(Object.keys(this.index()));
  }

  /** ancestor 是不是 descendant 的祖先（快进判断） */
  isAncestor(ancestor: string, descendant: string): boolean {
    let cursor: string | undefined = descendant;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      if (cursor === ancestor) return true;
      seen.add(cursor);
      cursor = this.commit(cursor)?.parents[0];
    }
    return false;
  }

  /** 暂存区的内容（路径 -> 内容） */
  staged(): FileMap {
    const files: FileMap = {};
    for (const [path, hash] of Object.entries(this.index())) {
      files[path] = this.objects.get(hash)?.body ?? '';
    }
    return files;
  }

  createCommit(message: string, identity: GitIdentity): string {
    const who = `${identity.name} <${identity.email}>`;
    const parent = this.headCommit();
    const tree = writeTree(this.objects, this.staged());
    const commit: Commit = {
      tree,
      parents: parent ? [parent] : [],
      author: who,
      committer: who,
      message,
      timestamp: Math.floor(this.now() / 1000),
    };
    const hash = this.objects.put('commit', encodeCommit(commit));
    const branch = this.currentBranch() ?? DEFAULT_BRANCH;
    this.setRef(branch, hash);
    return hash;
  }

  commit(hash: string): Commit | undefined {
    const object = this.objects.get(hash);
    return object?.type === 'commit' ? parseCommit(object.body) : undefined;
  }

  /** 从新到旧 */
  history(from = this.headCommit()): Array<{ hash: string; commit: Commit }> {
    const out: Array<{ hash: string; commit: Commit }> = [];
    let cursor = from;
    while (cursor) {
      const commit = this.commit(cursor);
      if (!commit) break;
      out.push({ hash: cursor, commit });
      cursor = commit.parents[0];
    }
    return out;
  }

  /** 把某次提交的内容铺回工作树 */
  restoreWorktree(hash: string): void {
    const commit = this.commit(hash);
    if (!commit) return;
    const wanted = readTree(this.objects, commit.tree);
    for (const path of Object.keys(this.worktree())) {
      if (!(path in wanted)) this.vfs.remove(`${this.root}/${path}`);
    }
    for (const [path, content] of Object.entries(wanted)) {
      this.vfs.writeFile(`${this.root}/${path}`, content);
    }
    const index: Record<string, string> = {};
    for (const [path, content] of Object.entries(wanted)) index[path] = this.objects.put('blob', content);
    this.writeIndex(index);
  }

  /* ---------------- 远端 ---------------- */

  config(): Record<string, string> {
    const path = `${this.gitDir}/config`;
    if (!this.vfs.exists(path)) return {};
    try {
      return JSON.parse(this.vfs.readFile(path)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  setRemote(name: string, url: string): void {
    const config = this.config();
    config[`remote.${name}.url`] = url;
    this.vfs.writeFile(`${this.gitDir}/config`, `${JSON.stringify(config, null, 2)}\n`);
  }

  remote(name: string): string | undefined {
    return this.config()[`remote.${name}.url`];
  }
}

/** 状态：工作树 / 暂存区 / HEAD 三者的差 */
export interface StatusEntry {
  path: string;
  state: 'added' | 'modified' | 'deleted';
}

export function statusOf(repository: Repository): {
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: string[];
} {
  const head = repository.committed();
  const index = repository.staged();
  const worktree = repository.worktree();

  const staged: StatusEntry[] = [];
  for (const path of union(head, index)) {
    if (!(path in head)) staged.push({ path, state: 'added' });
    else if (!(path in index)) staged.push({ path, state: 'deleted' });
    else if (head[path] !== index[path]) staged.push({ path, state: 'modified' });
  }

  const unstaged: StatusEntry[] = [];
  const untracked: string[] = [];
  for (const path of union(index, worktree)) {
    if (!(path in index)) { untracked.push(path); continue; }
    if (!(path in worktree)) { unstaged.push({ path, state: 'deleted' }); continue; }
    if (index[path] !== worktree[path]) unstaged.push({ path, state: 'modified' });
  }

  return { staged: sortBy(staged), unstaged: sortBy(unstaged), untracked: untracked.sort() };
}

function union(a: FileMap, b: FileMap): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
}

function sortBy(entries: StatusEntry[]): StatusEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
}
