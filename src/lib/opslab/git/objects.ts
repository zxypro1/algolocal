/**
 * Git 的对象库
 *
 * 三种对象，都按 `<type> <length>\0<content>` 编码之后取 SHA-1 —— 和真 git
 * 一模一样，所以这里算出来的 hash 拿到真 git 里也对得上。这不是为了炫技：
 * 「同样的内容永远是同一个 hash」正是 GitOps 敢拿 commit sha 当部署凭据的原因，
 * 学员应该能自己 `git cat-file` 验证这件事。
 *
 * 不做的部分：packfile、delta 压缩、submodule、merge。这些是存储与协作的
 * 优化，不影响「内容寻址」这个要教的东西。
 */
import { sha1Hex } from '../crypto/sha1';

export type GitObjectType = 'blob' | 'tree' | 'commit';

export interface TreeEntry {
  mode: string;
  name: string;
  hash: string;
  type: 'blob' | 'tree';
}

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** 秒级 epoch，来自虚拟时钟 */
  timestamp: number;
}

/** 一个对象库。真 git 放在 `.git/objects` 下，我们放在内存里，写盘的是索引。 */
export class ObjectStore {
  private readonly objects = new Map<string, { type: GitObjectType; body: string }>();

  put(type: GitObjectType, body: string): string {
    const hash = hashObject(type, body);
    if (!this.objects.has(hash)) this.objects.set(hash, { type, body });
    return hash;
  }

  get(hash: string): { type: GitObjectType; body: string } | undefined {
    return this.objects.get(hash);
  }

  has(hash: string): boolean {
    return this.objects.has(hash);
  }

  /**
   * 拷贝一批对象过去。push / pull / clone 都是这个动作。
   *
   * 两边都走 `get` / `put` 而不是直接动内部的 Map —— 子类可能把对象落在
   * 磁盘上（`.git/objects`），绕过去的话对象只存在于内存里，
   * 下一条命令换一个实例就全丢了。
   */
  copyTo(other: ObjectStore, root: string): void {
    const seen = new Set<string>();
    const walk = (hash: string) => {
      if (!hash || seen.has(hash)) return;
      seen.add(hash);
      const object = this.get(hash);
      if (!object) return;
      other.put(object.type, object.body);
      if (object.type === 'commit') {
        const commit = parseCommit(object.body);
        walk(commit.tree);
        for (const parent of commit.parents) walk(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.body)) walk(entry.hash);
      }
    };
    walk(root);
  }

  get size(): number {
    return this.objects.size;
  }
}

/** 真 git 的对象 id：`sha1("<type> <len>\0" + content)` */
export function hashObject(type: GitObjectType, body: string): string {
  return sha1Hex(`${type} ${byteLength(body)}\0${body}`);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/* ------------------------------------------------------------------ */
/* tree                                                                */
/* ------------------------------------------------------------------ */

/**
 * tree 的编码。
 *
 * 真 git 用二进制（20 字节裸 hash），我们用一行一条的文本 —— 唯一的代价是
 * tree 对象的 hash 和真 git 不一致，blob 与「同内容同 hash」都还是真的。
 * 换来的是 `git cat-file -p` 打出来人能读，教学上更划算。
 */
export function encodeTree(entries: TreeEntry[]): string {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => `${entry.mode} ${entry.type} ${entry.hash}\t${entry.name}`)
    .join('\n') + (entries.length ? '\n' : '');
}

export function parseTree(body: string): TreeEntry[] {
  return body.split('\n').filter(Boolean).map((line) => {
    const [meta, name] = line.split('\t');
    const [mode, type, hash] = meta.split(' ');
    return { mode, type: type as 'blob' | 'tree', hash, name };
  });
}

/* ------------------------------------------------------------------ */
/* commit                                                              */
/* ------------------------------------------------------------------ */

export function encodeCommit(commit: Commit): string {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author} ${commit.timestamp} +0000`);
  lines.push(`committer ${commit.committer} ${commit.timestamp} +0000`);
  lines.push('');
  lines.push(commit.message.replace(/\n*$/, ''));
  return lines.join('\n') + '\n';
}

export function parseCommit(body: string): Commit {
  const [head, ...rest] = body.split('\n\n');
  const commit: Commit = {
    tree: '', parents: [], author: '', committer: '', message: rest.join('\n\n').replace(/\n$/, ''),
    timestamp: 0,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const match = /^author (.*) (\d+) [+-]\d{4}$/.exec(line);
      if (match) { commit.author = match[1]; commit.timestamp = Number(match[2]); }
    } else if (line.startsWith('committer ')) {
      const match = /^committer (.*) (\d+) [+-]\d{4}$/.exec(line);
      if (match) commit.committer = match[1];
    }
  }
  return commit;
}

/* ------------------------------------------------------------------ */
/* 文件表 <-> tree                                                     */
/* ------------------------------------------------------------------ */

/** 一棵工作树：相对路径 -> 内容 */
export type FileMap = Record<string, string>;

export function writeTree(store: ObjectStore, files: FileMap): string {
  const root: Record<string, unknown> = {};
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/').filter(Boolean);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node[part] = (node[part] as Record<string, unknown>) ?? {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = content;
  }
  const build = (node: Record<string, unknown>): string => {
    const entries: TreeEntry[] = Object.entries(node).map(([name, value]) =>
      typeof value === 'string'
        ? { mode: '100644', type: 'blob', name, hash: store.put('blob', value) }
        : { mode: '040000', type: 'tree', name, hash: build(value as Record<string, unknown>) });
    return store.put('tree', encodeTree(entries));
  };
  return build(root);
}

export function readTree(store: ObjectStore, hash: string, prefix = ''): FileMap {
  const object = store.get(hash);
  if (!object || object.type !== 'tree') return {};
  const files: FileMap = {};
  for (const entry of parseTree(object.body)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === 'blob') {
      files[path] = store.get(entry.hash)?.body ?? '';
    } else {
      Object.assign(files, readTree(store, entry.hash, path));
    }
  }
  return files;
}
