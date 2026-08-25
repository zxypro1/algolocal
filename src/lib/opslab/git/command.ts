/**
 * `git`
 *
 * 覆盖到「能在 GitOps 里干活」为止：init / clone / add / commit / status /
 * log / diff / branch / checkout / remote / push / pull / rev-parse /
 * cat-file / hash-object / show / ls-files。
 *
 * 输出照抄真 git —— 学员在这里练出来的读法要能带走。
 */
import type { CommandHandler } from '../machine/shell/shell';
import type { Vfs } from '../machine/vfs';
import { GitNetwork, type BareRepository } from './remote';
import { DEFAULT_BRANCH, Repository, statusOf } from './repository';
import { hashObject, readTree } from './objects';

export interface GitCommandOptions {
  network: GitNetwork;
  now: () => number;
  /** 提交人。真 git 从 ~/.gitconfig 读，这里由世界给。 */
  identity?: { name: string; email: string };
  /** 哪些主机解析得到。不在里面的 URL 表现为 DNS 失败。 */
  resolves?(host: string): boolean;
}

const USAGE = `usage: git [--version] [--help] <command> [<args>]\n`;

export function createGitCommand(options: GitCommandOptions): CommandHandler {
  const identity = options.identity ?? { name: 'ops', email: 'ops@corp.internal' };

  return ({ argv, cwd, vfs }) => {
    // 这里的 argv 已经不含命令名了（和 curl / docker 那些一致）
    const [subcommand, ...rest] = argv;
    if (!subcommand) return { stderr: USAGE, code: 1 };

    const open = (): Repository | undefined => Repository.find(vfs, cwd, options.now);
    const notARepo = {
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      code: 128,
    };

    switch (subcommand) {
      case '--version':
      case 'version':
        return { stdout: 'git version 2.51.0\n' };

      case 'init': {
        const target = rest[0] ? resolve(cwd, rest[0]) : cwd;
        vfs.mkdirp(target);
        if (vfs.exists(`${target}/.git/HEAD`)) {
          return { stdout: `Reinitialized existing Git repository in ${target}/.git/\n` };
        }
        new Repository(vfs, target, options.now).init();
        return { stdout: `Initialized empty Git repository in ${target}/.git/\n` };
      }

      case 'clone': return clone(vfs, cwd, rest, options);

      case 'config': {
        // 只认 `git config user.name X` 这种最常用的形式，读的时候回默认值
        if (rest.length >= 2) return {};
        if (rest[0] === 'user.name') return { stdout: `${identity.name}\n` };
        if (rest[0] === 'user.email') return { stdout: `${identity.email}\n` };
        return {};
      }

      case 'add': {
        const repository = open();
        if (!repository) return notARepo;
        const paths = rest.filter((entry) => !entry.startsWith('-'));
        if (paths.length === 0) return { stderr: 'Nothing specified, nothing added.\n', code: 1 };
        const { missing } = repository.add(paths);
        if (missing.length > 0) {
          return {
            stderr: `fatal: pathspec '${missing[0]}' did not match any files\n`,
            code: 128,
          };
        }
        return {};
      }

      case 'status': return status(open(), rest) ?? notARepo;
      case 'log': return log(open(), rest) ?? notARepo;
      case 'diff': return diff(open(), rest) ?? notARepo;

      case 'commit': {
        const repository = open();
        if (!repository) return notARepo;
        if (rest.includes('-a') || rest.includes('--all')) repository.restageTracked();
        const message = messageOf(rest);
        if (!message) {
          return { stderr: 'Aborting commit due to empty commit message.\n', code: 1 };
        }
        const state = statusOf(repository);
        if (state.staged.length === 0) {
          const branch = repository.currentBranch() ?? DEFAULT_BRANCH;
          const lines = [`On branch ${branch}`];
          if (state.unstaged.length > 0 || state.untracked.length > 0) {
            lines.push('Changes not staged for commit:', '  (use "git add <file>..." to update what will be committed)');
          } else {
            lines.push('nothing to commit, working tree clean');
          }
          return { stdout: `${lines.join('\n')}\n`, code: 1 };
        }
        const hash = repository.createCommit(message, identity);
        const branch = repository.currentBranch() ?? DEFAULT_BRANCH;
        const files = state.staged.length;
        return {
          stdout: `[${branch} ${hash.slice(0, 7)}] ${message.split('\n')[0]}\n`
            + ` ${files} file${files === 1 ? '' : 's'} changed\n`,
        };
      }

      case 'branch': {
        const repository = open();
        if (!repository) return notARepo;
        const name = rest.find((entry) => !entry.startsWith('-'));
        if (name) {
          const head = repository.headCommit();
          if (!head) return { stderr: `fatal: not a valid object name: '${name}'\n`, code: 128 };
          repository.setRef(name, head);
          return {};
        }
        const current = repository.currentBranch();
        return {
          stdout: repository.branches()
            .map((branch) => `${branch === current ? '*' : ' '} ${branch}\n`).join(''),
        };
      }

      case 'checkout':
      case 'switch': {
        const repository = open();
        if (!repository) return notARepo;
        const create = rest.includes('-b') || rest.includes('-c');
        const name = rest.find((entry) => !entry.startsWith('-'));
        if (!name) return { stderr: 'fatal: you must specify a branch name\n', code: 128 };
        if (!create && !repository.ref(name)) {
          return { stderr: `error: pathspec '${name}' did not match any file(s) known to git\n`, code: 1 };
        }
        repository.checkout(name, create);
        return {
          stderr: create ? `Switched to a new branch '${name}'\n` : `Switched to branch '${name}'\n`,
        };
      }

      case 'remote': {
        const repository = open();
        if (!repository) return notARepo;
        if (rest[0] === 'add' && rest[1] && rest[2]) {
          repository.setRemote(rest[1], rest[2]);
          return {};
        }
        if (rest[0] === '-v' || rest.length === 0) {
          const config = repository.config();
          const names = Object.keys(config)
            .filter((key) => key.endsWith('.url'))
            .map((key) => key.slice('remote.'.length, -'.url'.length));
          if (rest[0] !== '-v') return { stdout: names.map((name) => `${name}\n`).join('') };
          return {
            stdout: names.flatMap((name) => [
              `${name}\t${config[`remote.${name}.url`]} (fetch)\n`,
              `${name}\t${config[`remote.${name}.url`]} (push)\n`,
            ]).join(''),
          };
        }
        return {};
      }

      case 'push': return push(open(), rest, options) ?? notARepo;
      case 'pull':
      case 'fetch': return pull(open(), rest, options, subcommand === 'pull') ?? notARepo;

      case 'rev-parse': {
        const repository = open();
        if (!repository) return notARepo;
        const target = rest.find((entry) => !entry.startsWith('-')) ?? 'HEAD';
        if (rest.includes('--abbrev-ref')) return { stdout: `${repository.currentBranch() ?? 'HEAD'}\n` };
        const hash = target === 'HEAD' ? repository.headCommit() : repository.ref(target);
        if (!hash) return { stderr: `fatal: ambiguous argument '${target}'\n`, code: 128 };
        return { stdout: `${hash}\n` };
      }

      case 'hash-object': {
        const path = rest.find((entry) => !entry.startsWith('-'));
        if (!path) return { stderr: 'fatal: no file given\n', code: 128 };
        const full = resolve(cwd, path);
        if (!vfs.exists(full)) return { stderr: `fatal: could not open '${path}'\n`, code: 128 };
        return { stdout: `${hashObject('blob', vfs.readFile(full))}\n` };
      }

      case 'cat-file': {
        const repository = open();
        if (!repository) return notARepo;
        const hash = rest[rest.length - 1];
        const object = repository.objects.get(hash);
        if (!object) return { stderr: `fatal: Not a valid object name ${hash}\n`, code: 128 };
        if (rest.includes('-t')) return { stdout: `${object.type}\n` };
        if (rest.includes('-s')) return { stdout: `${new TextEncoder().encode(object.body).length}\n` };
        return { stdout: object.body.endsWith('\n') ? object.body : `${object.body}\n` };
      }

      case 'show': {
        const repository = open();
        if (!repository) return notARepo;
        const hash = rest.find((entry) => !entry.startsWith('-')) ?? repository.headCommit();
        if (!hash) return { stderr: 'fatal: bad revision\n', code: 128 };
        const commit = repository.commit(hash);
        if (!commit) return { stderr: `fatal: bad object ${hash}\n`, code: 128 };
        return {
          stdout: `commit ${hash}\nAuthor: ${commit.author}\nDate:   ${formatDate(commit.timestamp)}\n\n`
            + `    ${commit.message.split('\n').join('\n    ')}\n`,
        };
      }

      case 'ls-files': {
        const repository = open();
        if (!repository) return notARepo;
        return { stdout: Object.keys(repository.index()).sort().map((path) => `${path}\n`).join('') };
      }

      default:
        return { stderr: `git: '${subcommand}' is not a git command. See 'git --help'.\n`, code: 1 };
    }
  };
}

/* ------------------------------------------------------------------ */
/* 各个子命令                                                          */
/* ------------------------------------------------------------------ */

function status(repository: Repository | undefined, argv: string[]) {
  if (!repository) return undefined;
  const state = statusOf(repository);
  const branch = repository.currentBranch() ?? 'HEAD (detached)';

  if (argv.includes('--porcelain') || argv.includes('-s')) {
    const lines: string[] = [];
    for (const entry of state.staged) lines.push(`${letter(entry.state)}  ${entry.path}`);
    for (const entry of state.unstaged) lines.push(` ${letter(entry.state)} ${entry.path}`);
    for (const path of state.untracked) lines.push(`?? ${path}`);
    return { stdout: lines.length ? `${lines.join('\n')}\n` : '' };
  }

  const lines = [`On branch ${branch}`];
  if (state.staged.length) {
    lines.push('', 'Changes to be committed:', '  (use "git restore --staged <file>..." to unstage)');
    for (const entry of state.staged) lines.push(`\t${label(entry.state)}   ${entry.path}`);
  }
  if (state.unstaged.length) {
    lines.push('', 'Changes not staged for commit:', '  (use "git add <file>..." to update what will be committed)');
    for (const entry of state.unstaged) lines.push(`\t${label(entry.state)}   ${entry.path}`);
  }
  if (state.untracked.length) {
    lines.push('', 'Untracked files:', '  (use "git add <file>..." to include in what will be committed)');
    for (const path of state.untracked) lines.push(`\t${path}`);
  }
  if (!state.staged.length && !state.unstaged.length && !state.untracked.length) {
    lines.push('', 'nothing to commit, working tree clean');
  }
  return { stdout: `${lines.join('\n')}\n` };
}

function log(repository: Repository | undefined, argv: string[]) {
  if (!repository) return undefined;
  const history = repository.history();
  if (history.length === 0) {
    const branch = repository.currentBranch() ?? DEFAULT_BRANCH;
    return {
      stderr: `fatal: your current branch '${branch}' does not have any commits yet\n`,
      code: 128,
    };
  }
  const limit = limitOf(argv) ?? history.length;
  const shown = history.slice(0, limit);
  if (argv.includes('--oneline')) {
    return {
      stdout: shown.map(({ hash, commit }) =>
        `${hash.slice(0, 7)} ${commit.message.split('\n')[0]}\n`).join(''),
    };
  }
  return {
    stdout: shown.map(({ hash, commit }) =>
      `commit ${hash}\nAuthor: ${commit.author}\nDate:   ${formatDate(commit.timestamp)}\n\n`
      + `    ${commit.message.split('\n').join('\n    ')}\n`).join('\n'),
  };
}

function diff(repository: Repository | undefined, argv: string[]) {
  if (!repository) return undefined;
  const cached = argv.includes('--cached') || argv.includes('--staged');
  const left = cached ? repository.committed() : repository.staged();
  const right = cached ? repository.staged() : repository.worktree();
  const paths = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();

  if (argv.includes('--name-only')) {
    return {
      stdout: paths.filter((path) => left[path] !== right[path]).map((path) => `${path}\n`).join(''),
    };
  }

  const out: string[] = [];
  for (const path of paths) {
    if (left[path] === right[path]) continue;
    out.push(`diff --git a/${path} b/${path}`);
    if (!(path in left)) out.push('new file mode 100644', '--- /dev/null', `+++ b/${path}`);
    else if (!(path in right)) out.push('deleted file mode 100644', `--- a/${path}`, '+++ /dev/null');
    else out.push(`--- a/${path}`, `+++ b/${path}`);
    out.push(...unified(left[path] ?? '', right[path] ?? ''));
  }
  return { stdout: out.length ? `${out.join('\n')}\n` : '' };
}

/**
 * 最朴素的逐行差异。
 *
 * 真 git 用 Myers 算法给出最小编辑脚本；这里整段删、整段加。
 * 读起来一样能看出改了什么，而「diff 算法」不是这个项目要教的东西。
 */
function unified(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a[a.length - 1] === '') a.pop();
  if (b[b.length - 1] === '') b.pop();
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;

  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const lines = [`@@ -${head + 1},${removed.length} +${head + 1},${added.length} @@`];
  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);
  return lines;
}

function clone(vfs: Vfs, cwd: string, argv: string[], options: GitCommandOptions) {
  const positional = argv.filter((entry) => !entry.startsWith('-'));
  const url = positional[0];
  if (!url) return { stderr: 'fatal: You must specify a repository to clone.\n', code: 128 };

  const host = GitNetwork.hostOf(url);
  if (host && options.resolves && !options.resolves(host)) {
    return {
      stderr: `fatal: unable to access '${url}': Could not resolve host: ${host}\n`,
      code: 128,
    };
  }
  const bare = options.network.get(url);
  if (!bare) {
    return {
      stderr: `fatal: repository '${url}' not found\n`,
      code: 128,
    };
  }

  const name = positional[1] ?? GitNetwork.normalize(url).split('/').pop()!;
  const target = resolve(cwd, name);
  if (vfs.exists(`${target}/.git/HEAD`)) {
    return { stderr: `fatal: destination path '${name}' already exists and is not an empty directory.\n`, code: 128 };
  }

  const repository = new Repository(vfs, target, options.now);
  repository.init(bare.head);
  repository.setRemote('origin', url);
  for (const [branch, hash] of Object.entries(bare.refs)) {
    bare.objects.copyTo(repository.objects, hash);
    repository.setRef(branch, hash);
  }
  const head = bare.refs[bare.head];
  if (head) repository.restoreWorktree(head);

  // git 把进度打在 stderr 上，stdout 留给能被管道接走的东西
  const empty = !head || Object.keys(readTree(repository.objects, repository.commit(head)!.tree)).length === 0;
  const notice = empty ? 'warning: You appear to have cloned an empty repository.\n' : '';
  return { stderr: `Cloning into '${name}'...\n${notice}`, code: 0 };
}

function push(repository: Repository | undefined, argv: string[], options: GitCommandOptions) {
  if (!repository) return undefined;
  const positional = argv.filter((entry) => !entry.startsWith('-'));
  const remoteName = positional[0] ?? 'origin';
  const branch = positional[1] ?? repository.currentBranch() ?? DEFAULT_BRANCH;
  const url = repository.remote(remoteName);
  if (!url) return { stderr: `fatal: '${remoteName}' does not appear to be a git repository\n`, code: 128 };

  const bare = resolveRemote(url, options);
  if ('stderr' in bare) return bare;
  if (bare.repository.readOnly) {
    return {
      stderr: `remote: You are not allowed to push code to this project.\nfatal: unable to access '${url}': The requested URL returned error: 403\n`,
      code: 128,
    };
  }

  const hash = repository.ref(branch);
  if (!hash) return { stderr: `error: src refspec ${branch} does not match any\n`, code: 1 };
  const before = bare.repository.refs[branch];
  if (before === hash) return { stdout: 'Everything up-to-date\n' };
  /**
   * 非快进的推送要拒。
   *
   * 别人先推了一版而你手上是旧的，直接覆盖等于把那次提交抹掉 ——
   * 真 git 在这里拦一道，GitOps 里这一拦尤其重要：远端就是期望状态。
   */
  if (before && !repository.isAncestor(before, hash)) {
    return {
      stderr: `To ${url}\n ! [rejected]        ${branch} -> ${branch} (fetch first)\n`
        + `error: failed to push some refs to '${url}'\n`
        + `hint: Updates were rejected because the remote contains work that you do not\n`
        + `hint: have locally. Integrate the remote changes before pushing again.\n`,
      code: 1,
    };
  }

  repository.objects.copyTo(bare.repository.objects, hash);
  bare.repository.refs[branch] = hash;
  const range = before ? `${before.slice(0, 7)}..${hash.slice(0, 7)}` : `[new branch]      ${branch}`;
  return {
    stderr: `To ${url}\n   ${range}  ${branch} -> ${branch}\n`,
  };
}

function pull(
  repository: Repository | undefined,
  argv: string[],
  options: GitCommandOptions,
  checkout: boolean
) {
  if (!repository) return undefined;
  const positional = argv.filter((entry) => !entry.startsWith('-'));
  const remoteName = positional[0] ?? 'origin';
  const branch = positional[1] ?? repository.currentBranch() ?? DEFAULT_BRANCH;
  const url = repository.remote(remoteName);
  if (!url) return { stderr: `fatal: '${remoteName}' does not appear to be a git repository\n`, code: 128 };

  const bare = resolveRemote(url, options);
  if ('stderr' in bare) return bare;

  const hash = bare.repository.refs[branch];
  if (!hash) return { stderr: `fatal: couldn't find remote ref ${branch}\n`, code: 128 };
  const local = repository.ref(branch);
  if (local === hash) return { stdout: 'Already up to date.\n' };

  bare.repository.objects.copyTo(repository.objects, hash);
  // 本地有远端没有的提交 = 分叉了。这里不做 merge，如实说出来。
  if (local && !repository.isAncestor(local, hash)) {
    return {
      stderr: `fatal: Not possible to fast-forward, and merging is not supported here.\n`
        + `hint: ${branch} has diverged from ${remoteName}/${branch}.\n`,
      code: 128,
    };
  }
  repository.setRef(branch, hash);
  if (checkout && repository.currentBranch() === branch) repository.restoreWorktree(hash);
  return { stdout: `Updating ${branch}\nFast-forward\n` };
}

function resolveRemote(url: string, options: GitCommandOptions):
  { repository: BareRepository } | { stderr: string; code: number } {
  const host = GitNetwork.hostOf(url);
  if (host && options.resolves && !options.resolves(host)) {
    return { stderr: `fatal: unable to access '${url}': Could not resolve host: ${host}\n`, code: 128 };
  }
  const repository = options.network.get(url);
  if (!repository) return { stderr: `fatal: repository '${url}' not found\n`, code: 128 };
  return { repository };
}

/* ------------------------------------------------------------------ */

function messageOf(argv: string[]): string | undefined {
  const index = argv.findIndex((entry) => entry === '-m' || entry === '--message');
  if (index >= 0 && argv[index + 1] !== undefined) return argv[index + 1];
  const inline = argv.find((entry) => entry.startsWith('-m'));
  return inline && inline.length > 2 ? inline.slice(2) : undefined;
}

function limitOf(argv: string[]): number | undefined {
  const flag = argv.find((entry) => /^-\d+$/.test(entry));
  if (flag) return Number(flag.slice(1));
  const index = argv.indexOf('-n');
  return index >= 0 ? Number(argv[index + 1]) : undefined;
}

function letter(state: 'added' | 'modified' | 'deleted'): string {
  return state === 'added' ? 'A' : state === 'deleted' ? 'D' : 'M';
}

function label(state: 'added' | 'modified' | 'deleted'): string {
  return state === 'added' ? 'new file:' : state === 'deleted' ? 'deleted:' : 'modified:';
}

/** git 的日期格式：`Mon Mar 2 09:00:00 2026 +0000` */
function formatDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${date.getUTCDate()} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} `
    + `${date.getUTCFullYear()} +0000`;
}

function resolve(cwd: string, path: string): string {
  if (path.startsWith('/')) return path.replace(/\/+$/, '') || '/';
  const parts = `${cwd}/${path}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}
