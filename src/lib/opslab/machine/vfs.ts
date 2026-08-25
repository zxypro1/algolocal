/**
 * 虚拟文件系统
 *
 * 「学员机器上的磁盘」。三个地方要用同一棵树：
 *  - 终端里的 `cat` / `ls` / 重定向；
 *  - IDE 里编辑的文件；
 *  - 真 kubectl 通过 Go 的 fs 垫片读 kubeconfig 与 `-f` 指到的 manifest。
 *
 * 三者读写的是同一份数据 —— 这正是「在 IDE 里改完，终端里 apply 就生效」
 * 这个体验的基础，不是三份各自为政的副本。
 */

export interface FileStat {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mode: number;
  /** 世界的墙钟毫秒 */
  mtime: number;
  /** 符号链接指向哪里 */
  target?: string;
}

export interface VfsSnapshot {
  entries: Array<{ path: string; type: 'file' | 'dir' | 'symlink'; content?: string; target?: string; mode: number; mtime: number }>;
}

export class VfsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VfsError';
    this.code = code;
  }
}

const enoent = (path: string) => new VfsError('ENOENT', `${path}: No such file or directory`);
const eisdir = (path: string) => new VfsError('EISDIR', `${path}: Is a directory`);
const enotdir = (path: string) => new VfsError('ENOTDIR', `${path}: Not a directory`);
const eexist = (path: string) => new VfsError('EEXIST', `${path}: File exists`);
const enotempty = (path: string) => new VfsError('ENOTEMPTY', `${path}: Directory not empty`);

interface Node {
  type: 'file' | 'dir' | 'symlink';
  content: string;
  target?: string;
  mode: number;
  mtime: number;
}

/** 把路径规整成绝对路径，处理 `.`、`..`、多余的斜杠 */
export function normalizePath(path: string, cwd = '/'): string {
  const raw = path.startsWith('/') ? path : `${cwd}/${path}`;
  const out: string[] = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { out.pop(); continue; }
    out.push(segment);
  }
  return `/${out.join('/')}`;
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized === '/' ? '/' : normalized.slice(normalized.lastIndexOf('/') + 1);
}

export class Vfs {
  private nodes = new Map<string, Node>();

  constructor(private readonly now: () => number = () => 0) {
    this.nodes.set('/', { type: 'dir', content: '', mode: 0o755, mtime: this.now() });
  }

  /* ---------------- 查询 ---------------- */

  exists(path: string): boolean {
    return this.nodes.has(normalizePath(path));
  }

  stat(path: string): FileStat {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) throw enoent(path);
    return {
      path: normalized,
      type: node.type,
      size: node.type === 'file' ? node.content.length : 0,
      mode: node.mode,
      mtime: node.mtime,
      target: node.target,
    };
  }

  isDir(path: string): boolean {
    return this.nodes.get(normalizePath(path))?.type === 'dir';
  }

  isFile(path: string): boolean {
    return this.nodes.get(normalizePath(path))?.type === 'file';
  }

  readFile(path: string): string {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) throw enoent(path);
    if (node.type === 'dir') throw eisdir(path);
    if (node.type === 'symlink') return this.readFile(node.target!);
    return node.content;
  }

  /** 目录内容，按名字排序 —— 顺序稳定是确定性的一部分 */
  readDir(path: string): string[] {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) throw enoent(path);
    if (node.type !== 'dir') throw enotdir(path);

    const prefix = normalized === '/' ? '/' : `${normalized}/`;
    const names = new Set<string>();
    for (const key of this.nodes.keys()) {
      if (key === normalized || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const head = rest.split('/')[0];
      if (head) names.add(head);
    }
    return [...names].sort();
  }

  /** 递归列出某个目录下的全部文件（不含目录本身），按路径排序 */
  walk(path = '/'): string[] {
    const normalized = normalizePath(path);
    const prefix = normalized === '/' ? '/' : `${normalized}/`;
    return [...this.nodes.entries()]
      .filter(([key, node]) => node.type === 'file' && (key === normalized || key.startsWith(prefix)))
      .map(([key]) => key)
      .sort();
  }

  /** 递归列出目录下的**全部**条目（含目录），按路径排序 —— `find` 要用 */
  walkAll(path = '/'): string[] {
    const normalized = normalizePath(path);
    const prefix = normalized === '/' ? '/' : `${normalized}/`;
    return [...this.nodes.keys()]
      .filter((key) => key === normalized || key.startsWith(prefix))
      .sort();
  }

  /* ---------------- 写入 ---------------- */

  mkdirp(path: string): void {
    const normalized = normalizePath(path);
    const parts = normalized.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      const existing = this.nodes.get(current);
      if (existing) {
        if (existing.type !== 'dir') throw enotdir(current);
        continue;
      }
      this.nodes.set(current, { type: 'dir', content: '', mode: 0o755, mtime: this.now() });
    }
  }

  writeFile(path: string, content: string, options: { mode?: number } = {}): void {
    const normalized = normalizePath(path);
    const existing = this.nodes.get(normalized);
    if (existing?.type === 'dir') throw eisdir(path);
    this.mkdirp(dirname(normalized));
    this.nodes.set(normalized, {
      type: 'file',
      content,
      mode: options.mode ?? existing?.mode ?? 0o644,
      mtime: this.now(),
    });
  }

  appendFile(path: string, content: string): void {
    const existing = this.exists(path) ? this.readFile(path) : '';
    this.writeFile(path, existing + content);
  }

  symlink(target: string, path: string): void {
    const normalized = normalizePath(path);
    if (this.nodes.has(normalized)) throw eexist(path);
    this.mkdirp(dirname(normalized));
    this.nodes.set(normalized, {
      type: 'symlink', content: '', target: normalizePath(target), mode: 0o777, mtime: this.now(),
    });
  }

  remove(path: string, options: { recursive?: boolean } = {}): void {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) throw enoent(path);
    if (normalized === '/') throw new VfsError('EPERM', '/: Operation not permitted');

    if (node.type === 'dir') {
      const children = this.readDir(normalized);
      if (children.length > 0 && !options.recursive) throw enotempty(path);
      const prefix = `${normalized}/`;
      for (const key of [...this.nodes.keys()]) {
        if (key.startsWith(prefix)) this.nodes.delete(key);
      }
    }
    this.nodes.delete(normalized);
  }

  rename(from: string, to: string): void {
    const source = normalizePath(from);
    const target = normalizePath(to);
    const node = this.nodes.get(source);
    if (!node) throw enoent(from);

    this.mkdirp(dirname(target));
    // 目录要连着子树一起搬
    const prefix = `${source}/`;
    for (const [key, value] of [...this.nodes.entries()]) {
      if (key === source) {
        this.nodes.set(target, value);
        this.nodes.delete(key);
      } else if (key.startsWith(prefix)) {
        this.nodes.set(target + key.slice(source.length), value);
        this.nodes.delete(key);
      }
    }
  }

  chmod(path: string, mode: number): void {
    const node = this.nodes.get(normalizePath(path));
    if (!node) throw enoent(path);
    node.mode = mode;
  }

  /* ---------------- 批量与快照 ---------------- */

  /** 一次性铺一批文件，建世界初态用 */
  populate(files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) this.writeFile(path, content);
  }

  /** 导出成 `路径 -> 内容`，只含文件。IDE 拿它渲染文件树。 */
  toFileMap(root = '/'): Record<string, string> {
    const out: Record<string, string> = {};
    for (const path of this.walk(root)) out[path] = this.readFile(path);
    return out;
  }

  snapshot(): VfsSnapshot {
    return {
      entries: [...this.nodes.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, node]) => ({
          path,
          type: node.type,
          ...(node.type === 'file' ? { content: node.content } : {}),
          ...(node.target ? { target: node.target } : {}),
          mode: node.mode,
          mtime: node.mtime,
        })),
    };
  }

  restore(snapshot: VfsSnapshot): void {
    this.nodes = new Map(
      snapshot.entries.map((entry) => [
        entry.path,
        {
          type: entry.type,
          content: entry.content ?? '',
          target: entry.target,
          mode: entry.mode,
          mtime: entry.mtime,
        },
      ])
    );
    if (!this.nodes.has('/')) {
      this.nodes.set('/', { type: 'dir', content: '', mode: 0o755, mtime: this.now() });
    }
  }
}

export function createVfs(now?: () => number): Vfs {
  return new Vfs(now);
}
