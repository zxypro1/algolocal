/**
 * 内网的 Git 服务
 *
 * 一个 URL 对应一个裸仓库。push / pull / clone 就是在两个对象库之间搬对象、
 * 然后动一下引用 —— 真 git 也是这么回事，只是中间隔着 smart HTTP 协议。
 *
 * 认证做成和镜像仓库一样：URL 里的主机得在网络里存在，仓库得存在。
 * 「clone 不下来」和「push 被拒」是两件不同的事，学员应该分得清。
 */
import { ObjectStore, writeTree, type FileMap } from './objects';

export interface BareRepository {
  /** 默认分支 */
  head: string;
  refs: Record<string, string>;
  objects: ObjectStore;
  /** 只读的仓库：push 会被拒 */
  readOnly?: boolean;
}

export class GitNetwork {
  private readonly repositories = new Map<string, BareRepository>();

  /** URL 归一化：去掉结尾的斜杠与 `.git` */
  static normalize(url: string): string {
    return url.replace(/\/+$/, '').replace(/\.git$/, '');
  }

  create(url: string, options: { head?: string; readOnly?: boolean } = {}): BareRepository {
    const repository: BareRepository = {
      head: options.head ?? 'main',
      refs: {},
      objects: new ObjectStore(),
      readOnly: options.readOnly,
    };
    this.repositories.set(GitNetwork.normalize(url), repository);
    return repository;
  }

  get(url: string): BareRepository | undefined {
    return this.repositories.get(GitNetwork.normalize(url));
  }

  has(url: string): boolean {
    return this.repositories.has(GitNetwork.normalize(url));
  }

  list(): string[] {
    return [...this.repositories.keys()].sort();
  }

  /** 主机名 —— 网络层判断解析得到解析不到时要用 */
  static hostOf(url: string): string | undefined {
    const match = /^[a-z+]+:\/\/([^/@]+@)?([^/:]+)/.exec(url);
    return match?.[2];
  }
}

/**
 * 往裸仓库里塞一次提交，返回 commit id。
 *
 * 分支上已经有东西时默认接在它后面 —— 不然造出来的是一次根提交，
 * 对面 pull 下来会被判成分叉。
 */
export function seedRepository(
  repository: BareRepository,
  files: FileMap,
  options: {
    branch?: string; message?: string; author?: string; timestamp?: number;
    /** 接在哪次提交后面。不给就是一次根提交。 */
    parent?: string;
  } = {}
): string {
  // 这里刻意不复用 Repository：裸仓库没有工作树，只有对象与引用
  const store = repository.objects;
  const tree = writeTree(store, files);
  const branch = options.branch ?? repository.head;
  const author = options.author ?? 'Platform Team <platform@corp.internal>';
  const timestamp = Math.floor((options.timestamp ?? 0) / 1000);
  const parent = options.parent ?? repository.refs[branch];
  const body = [
    `tree ${tree}`,
    ...(parent ? [`parent ${parent}`] : []),
    `author ${author} ${timestamp} +0000`,
    `committer ${author} ${timestamp} +0000`,
    '',
    options.message ?? 'initial commit',
    '',
  ].join('\n');
  const hash = store.put('commit', body);
  repository.refs[branch] = hash;
  return hash;
}
