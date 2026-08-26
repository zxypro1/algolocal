/**
 * 机器
 *
 * 学员面前那台跳板机：一份磁盘（Vfs）、一个 shell、一堆装好的命令。
 * 关卡把 kubectl / helm / systemctl 之类注册进来，其余的（coreutils）
 * 开箱就有。
 *
 * 时间从内核来，不从 `Date.now()` 来 —— 文件 mtime、命令耗时都要能复现。
 */
import { createVfs, Vfs, VfsSnapshot } from './vfs';
import { COREUTILS } from './shell/coreutils';
import { CommandHandler, RunResult, Shell, createShell } from './shell/shell';

export interface MachineOptions {
  hostname?: string;
  user?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** 初始文件：路径 -> 内容 */
  files?: Record<string, string>;
  /** 关卡额外装的命令 */
  commands?: Record<string, CommandHandler>;
  /** 虚拟墙钟，毫秒 */
  now?: () => number;
  /** 循环体最多跑多少轮，防住写错的死循环 */
  maxLoopIterations?: number;
}

export interface MachineSnapshot {
  vfs: VfsSnapshot;
  cwd: string;
  env: Record<string, string>;
  history: string[];
}

/** 一条命令跑完之后的完整记录，终端面板与判分都读它 */
export interface CommandRecord extends RunResult {
  command: string;
  cwd: string;
  /** 虚拟墙钟 */
  at: number;
}

export class Machine {
  readonly vfs: Vfs;
  readonly shell: Shell;
  readonly hostname: string;
  readonly history: string[] = [];
  private readonly records: CommandRecord[] = [];
  private readonly now: () => number;

  constructor(options: MachineOptions = {}) {
    this.now = options.now ?? (() => 0);
    this.hostname = options.hostname ?? 'jump-01';
    this.vfs = createVfs(this.now);

    // 一台机器该有的目录，缺了 `cd /etc` 会莫名其妙地失败
    for (const path of ['/bin', '/usr/bin', '/usr/local/bin', '/etc', '/var/log', '/tmp', '/root', '/home']) {
      this.vfs.mkdirp(path);
    }
    this.vfs.writeFile('/etc/hostname', `${this.hostname}\n`);
    this.vfs.writeFile('/etc/os-release', OS_RELEASE);
    if (options.files) this.vfs.populate(options.files);

    this.shell = createShell({
      vfs: this.vfs,
      cwd: options.cwd ?? '/root',
      hostname: this.hostname,
      user: options.user ?? 'root',
      env: options.env,
      maxLoopIterations: options.maxLoopIterations,
      commands: { ...COREUTILS, ...(options.commands ?? {}) },
    });
  }

  /** 装一个命令（kubectl、helm、systemctl…） */
  install(name: string, handler: CommandHandler): void {
    this.shell.register(name, handler);
  }

  get cwd(): string {
    return this.shell.cwd;
  }

  /** 提示符，和 bash 默认的 `user@host:~/dir$` 一致 */
  prompt(): string {
    const home = this.shell.env.HOME ?? '/root';
    const path = this.shell.cwd === home
      ? '~'
      : this.shell.cwd.startsWith(`${home}/`)
        ? `~${this.shell.cwd.slice(home.length)}`
        : this.shell.cwd;
    return `${this.shell.user}@${this.hostname}:${path}${this.shell.user === 'root' ? '#' : '$'} `;
  }

  /** 敲一条命令 */
  async exec(command: string): Promise<CommandRecord> {
    const trimmed = command.trim();
    if (trimmed) this.history.push(trimmed);
    const cwd = this.shell.cwd;
    const result = trimmed
      ? await this.shell.run(trimmed)
      : { stdout: '', stderr: '', code: 0 };
    const record: CommandRecord = { ...result, command: trimmed, cwd, at: this.now() };
    this.records.push(record);
    return record;
  }

  /** 完整的操作记录 —— 判分与回放读它 */
  transcript(): CommandRecord[] {
    return [...this.records];
  }

  snapshot(): MachineSnapshot {
    return {
      vfs: this.vfs.snapshot(),
      cwd: this.shell.cwd,
      env: { ...this.shell.env },
      history: [...this.history],
    };
  }

  restore(snapshot: MachineSnapshot): void {
    this.vfs.restore(snapshot.vfs);
    // 变量、函数、set -e 这些也要跟着回去，否则「重来一次」会带着上一轮的残留
    this.shell.reset({ cwd: snapshot.cwd, env: snapshot.env });
    this.history.length = 0;
    this.history.push(...snapshot.history);
  }
}

const OS_RELEASE = [
  'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
  'NAME="Debian GNU/Linux"',
  'VERSION_ID="12"',
  'VERSION="12 (bookworm)"',
  'ID=debian',
  '',
].join('\n');

export function createMachine(options?: MachineOptions): Machine {
  return new Machine(options);
}
