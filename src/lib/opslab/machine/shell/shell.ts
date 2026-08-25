/**
 * shell 执行器
 *
 * 解析交给 tree-sitter（见 parser.ts），这里负责执行：管道、重定向、
 * `&&` / `||` / `;`、子 shell、函数、变量展开、内置命令，以及把外部命令
 * （coreutils、kubectl…）派发出去。
 *
 * 退出码是一等公民：`set -e`、`&&`、`$?`、管道的退出码取最后一段 ——
 * 这些是运维脚本的真实内容，不能糊弄。
 */
import { Vfs, normalizePath } from '../vfs';
import { Node, Redirect, parseShell, ShellSyntaxError, Word, WordPart } from './parser';

export interface CommandContext {
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  vfs: Vfs;
  shell: Shell;
}

export interface CommandResult {
  stdout?: string;
  stderr?: string;
  code?: number;
}

export type CommandHandler = (context: CommandContext) => Promise<CommandResult> | CommandResult;

export interface ShellOptions {
  vfs: Vfs;
  cwd?: string;
  env?: Record<string, string>;
  commands?: Record<string, CommandHandler>;
  /** 提示符里的主机名，也用于 `hostname` */
  hostname?: string;
  user?: string;
  /** 循环体最多跑多少轮 —— 虚拟世界里没人来按 Ctrl+C */
  maxLoopIterations?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

type Sink = (text: string) => void;

/** `exit` —— 退出整个 shell */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** `return` —— 只退出当前函数 */
class ReturnSignal extends Error {
  constructor(readonly code: number) {
    super(`return ${code}`);
  }
}

/** 一个函数调用帧：记着哪些变量是 `local` 的，退出时要还原 */
interface Frame {
  positional: string[];
  locals: Map<string, string | undefined>;
}

export class Shell {
  readonly vfs: Vfs;
  cwd: string;
  env: Record<string, string>;
  /** shell 变量（未 export 的），与环境变量分开 */
  private vars: Record<string, string> = {};
  private commands: Record<string, CommandHandler>;
  private functions: Record<string, Node> = {};
  readonly hostname: string;
  readonly user: string;
  /** `set -e` / `set -u` / `set -o pipefail` */
  private options = { errexit: false, nounset: false, pipefail: false };
  private lastStatus = 0;
  private positional: string[] = [];
  private frames: Frame[] = [];
  private readonly maxLoopIterations: number;
  /** 展开期间（命令替换）产生的 stderr 往哪走 */
  private errSink: Sink = () => {};

  constructor(options: ShellOptions) {
    this.vfs = options.vfs;
    this.cwd = options.cwd ?? '/root';
    this.hostname = options.hostname ?? 'localhost';
    this.user = options.user ?? 'root';
    this.maxLoopIterations = options.maxLoopIterations ?? 10_000;
    this.env = {
      HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin', PWD: this.cwd,
      USER: this.user, HOSTNAME: this.hostname, SHELL: '/bin/bash', TERM: 'xterm-256color',
      ...(options.env ?? {}),
    };
    this.commands = { ...options.commands };
  }

  register(name: string, handler: CommandHandler): void {
    this.commands[name] = handler;
  }

  has(name: string): boolean {
    return name in this.commands || name in BUILTINS || name in this.functions;
  }

  /** 已知命令名，`which` 与补全用，按名字排序 */
  commandNames(): string[] {
    return [
      ...new Set([...Object.keys(this.commands), ...Object.keys(BUILTINS), ...Object.keys(this.functions)]),
    ].sort();
  }

  /** 跑一行（或一段）脚本。stdin 是喂给第一段命令的输入。 */
  async run(source: string, stdin = ''): Promise<RunResult> {
    let node: Node | null;
    try {
      node = await parseShell(source);
    } catch (error) {
      if (error instanceof ShellSyntaxError) {
        return { stdout: '', stderr: `bash: ${error.message}\n`, code: 2 };
      }
      throw error;
    }
    if (!node) return { stdout: '', stderr: '', code: 0 };

    const out: string[] = [];
    const err: string[] = [];
    const previousSink = this.errSink;
    this.errSink = (text) => err.push(text);
    let code = 0;
    try {
      code = await this.exec(node, stdin, (s) => out.push(s), (s) => err.push(s));
    } catch (error) {
      if (error instanceof ExitSignal || error instanceof ReturnSignal) code = error.code;
      else throw error;
    } finally {
      this.errSink = previousSink;
    }
    this.lastStatus = code;
    return { stdout: out.join(''), stderr: err.join(''), code };
  }

  /* ---------------- 执行 ---------------- */

  private async exec(node: Node, stdin: string, onOut: Sink, onErr: Sink): Promise<number> {
    switch (node.type) {
      case 'sequence': {
        let code = 0;
        for (const statement of node.statements) {
          code = await this.exec(statement, stdin, onOut, onErr);
          this.lastStatus = code;
          if (this.options.errexit && code !== 0) break;
        }
        return code;
      }

      case 'list': {
        const left = await this.exec(node.left, stdin, onOut, onErr);
        this.lastStatus = left;
        if (node.operator === '&&' && left !== 0) return left;
        if (node.operator === '||' && left === 0) return left;
        return this.exec(node.right, stdin, onOut, onErr);
      }

      case 'pipeline': {
        // 一段段串起来：前一段的 stdout 是后一段的 stdin
        let input = stdin;
        let code = 0;
        const codes: number[] = [];
        for (let i = 0; i < node.commands.length; i += 1) {
          const isLast = i === node.commands.length - 1;
          const captured: string[] = [];
          code = await this.exec(
            node.commands[i],
            input,
            isLast ? onOut : (text) => captured.push(text),
            onErr
          );
          codes.push(code);
          input = captured.join('');
        }
        // 默认取最后一段的退出码；set -o pipefail 时取第一个非零
        const result = this.options.pipefail ? (codes.find((c) => c !== 0) ?? 0) : code;
        return node.negated ? (result === 0 ? 1 : 0) : result;
      }

      case 'redirected':
        return this.execRedirected(node, stdin, onOut, onErr);

      case 'subshell': {
        // 子 shell 里的变量与 cwd 改动不影响外面
        const savedCwd = this.cwd;
        const savedVars = { ...this.vars };
        const savedEnv = { ...this.env };
        try {
          return await this.exec(node.body, stdin, onOut, onErr);
        } finally {
          this.cwd = savedCwd;
          this.vars = savedVars;
          this.env = savedEnv;
        }
      }

      case 'assignment': {
        const value = (await this.expandWord(node.value)).join(' ');
        if (node.local) this.declareLocal(node.name);
        if (node.exported) this.env[node.name] = value;
        else this.vars[node.name] = value;
        return 0;
      }

      case 'function':
        this.functions[node.name] = node.body;
        return 0;

      case 'if': {
        // 条件的 stdout 不该漏到外面（`if grep -q ...` 是最常见的写法）
        const condition = await this.execCondition(node.condition, stdin, onErr);
        if (condition === 0) return this.exec(node.then, stdin, onOut, onErr);
        if (node.else) return this.exec(node.else, stdin, onOut, onErr);
        return 0;
      }

      case 'for': {
        let code = 0;
        const items: string[] = [];
        for (const item of node.items) items.push(...(await this.expandWord(item)));
        for (const item of items) {
          this.vars[node.variable] = item;
          code = await this.exec(node.body, stdin, onOut, onErr);
          this.lastStatus = code;
          if (this.options.errexit && code !== 0) break;
        }
        return code;
      }

      case 'while': {
        let code = 0;
        let iterations = 0;
        for (;;) {
          if (iterations >= this.maxLoopIterations) {
            onErr(`bash: loop exceeded ${this.maxLoopIterations} iterations, aborted\n`);
            return 1;
          }
          iterations += 1;
          const condition = await this.execCondition(node.condition, stdin, onErr);
          const shouldRun = node.until ? condition !== 0 : condition === 0;
          if (!shouldRun) break;
          code = await this.exec(node.body, stdin, onOut, onErr);
          this.lastStatus = code;
          if (this.options.errexit && code !== 0) break;
        }
        return code;
      }

      case 'case': {
        // 分支模式是拿来匹配的，不是文件名 —— 走了通配展开的话，
        // `*)` 会先被换成当前目录下的文件列表，兜底分支就永远不命中了
        const value = await this.expandPattern(node.value);
        for (const item of node.items) {
          for (const pattern of item.patterns) {
            const text = await this.expandPattern(pattern);
            if (!matchesGlob(text, value)) continue;
            return item.body ? this.exec(item.body, stdin, onOut, onErr) : 0;
          }
        }
        return 0;
      }

      case 'command':
        return this.execCommand(node, stdin, onOut, onErr);

      default:
        return 0;
    }
  }

  /** 条件位置上的命令：只要退出码，stdout 丢掉 */
  private execCondition(node: Node, stdin: string, onErr: Sink): Promise<number> {
    return this.exec(node, stdin, () => {}, onErr);
  }

  /**
   * 重定向。
   *
   * 按书写顺序依次生效，这样 `cmd > f 2>&1` 与 `cmd 2>&1 > f` 的区别
   * 才是对的 —— 前者 stderr 进文件，后者留在终端。
   */
  private async execRedirected(
    node: Extract<Node, { type: 'redirected' }>,
    stdin: string,
    onOut: Sink,
    onErr: Sink
  ): Promise<number> {
    let input = stdin;
    let stdout: Sink = onOut;
    let stderr: Sink = onErr;
    const pending: Array<{ path: string; append: boolean; buffer: string[] }> = [];

    for (const redirect of node.redirects) {
      if (redirect.kind === 'in') {
        const path = normalizePath(redirect.source, this.cwd);
        if (!this.vfs.exists(path)) {
          onErr(`bash: ${redirect.source}: No such file or directory\n`);
          return 1;
        }
        if (this.vfs.isDir(path)) {
          onErr(`bash: ${redirect.source}: Is a directory\n`);
          return 1;
        }
        input = this.vfs.readFile(path);
      } else if (redirect.kind === 'heredoc') {
        input = redirect.expand ? await this.expandText(redirect.content) : redirect.content;
      } else if (redirect.kind === 'dup') {
        // 绑定的是「此刻」的那个 sink，不是最终的
        const source = redirect.to === 2 ? stderr : stdout;
        if (redirect.from === 2) stderr = source;
        else stdout = source;
      } else {
        const sink = this.openOutput(redirect, pending);
        if (redirect.fd === 2) stderr = sink;
        else stdout = sink;
      }
    }

    let code: number;
    try {
      code = await this.exec(node.body, input, stdout, stderr);
    } finally {
      // 即使命令失败，`> f` 也已经把文件截断/建出来了，和真 shell 一致
      for (const entry of pending) {
        try {
          if (entry.append) this.vfs.appendFile(entry.path, entry.buffer.join(''));
          else this.vfs.writeFile(entry.path, entry.buffer.join(''));
        } catch (error) {
          onErr(`bash: ${entry.path}: ${(error as Error).message}\n`);
        }
      }
    }
    return code;
  }

  private openOutput(
    redirect: Extract<Redirect, { kind: 'out' }>,
    pending: Array<{ path: string; append: boolean; buffer: string[] }>
  ): Sink {
    const path = normalizePath(redirect.target, this.cwd);
    if (path === '/dev/null') return () => {};
    const entry = { path, append: redirect.append, buffer: [] as string[] };
    pending.push(entry);
    return (text: string) => entry.buffer.push(text);
  }

  private async execCommand(
    node: Extract<Node, { type: 'command' }>,
    stdin: string,
    onOut: Sink,
    onErr: Sink
  ): Promise<number> {
    // 只有赋值没有命令：`FOO=bar`
    if (node.words.length === 0) {
      for (const assignment of node.assignments) {
        this.vars[assignment.name] = (await this.expandWord(assignment.value)).join(' ');
      }
      return 0;
    }

    const argv: string[] = [];
    try {
      for (const word of node.words) argv.push(...(await this.expandWord(word)));
    } catch (error) {
      if (error instanceof ExitSignal || error instanceof ReturnSignal) throw error;
      onErr(`bash: ${(error as Error).message}\n`);
      return 1;
    }
    if (argv.length === 0) return 0;

    // 前置赋值只对这一条命令可见
    const overrides: Record<string, string> = {};
    for (const assignment of node.assignments) {
      overrides[assignment.name] = (await this.expandWord(assignment.value)).join(' ');
    }

    return this.dispatch(argv, stdin, { ...this.env, ...overrides }, onOut, onErr);
  }

  private async dispatch(
    argv: string[],
    stdin: string,
    env: Record<string, string>,
    onOut: Sink,
    onErr: Sink
  ): Promise<number> {
    const [name, ...args] = argv;

    const body = this.functions[name];
    if (body && !(name in BUILTINS)) return this.callFunction(body, args, stdin, onOut, onErr);

    const handler = BUILTINS[name] ?? this.commands[name];
    if (!handler) {
      onErr(`bash: ${name}: command not found\n`);
      return 127;
    }

    try {
      const result = await handler({
        argv: args, stdin, cwd: this.cwd, env, vfs: this.vfs, shell: this,
      });
      if (result.stdout) onOut(result.stdout);
      if (result.stderr) onErr(result.stderr);
      return result.code ?? 0;
    } catch (error) {
      if (error instanceof ExitSignal || error instanceof ReturnSignal) throw error;
      onErr(`${name}: ${(error as Error).message}\n`);
      return 1;
    }
  }

  private async callFunction(
    body: Node,
    args: string[],
    stdin: string,
    onOut: Sink,
    onErr: Sink
  ): Promise<number> {
    const frame: Frame = { positional: this.positional, locals: new Map() };
    this.frames.push(frame);
    this.positional = args;
    try {
      return await this.exec(body, stdin, onOut, onErr);
    } catch (error) {
      if (error instanceof ReturnSignal) return error.code;
      throw error;
    } finally {
      this.frames.pop();
      this.positional = frame.positional;
      for (const [name, previous] of frame.locals) {
        if (previous === undefined) delete this.vars[name];
        else this.vars[name] = previous;
      }
    }
  }

  private declareLocal(name: string): void {
    const frame = this.frames[this.frames.length - 1];
    if (frame && !frame.locals.has(name)) frame.locals.set(name, this.vars[name]);
  }

  /* ---------------- 展开 ---------------- */

  /** 一个词展开成零个或多个参数（未加引号的展开会按空白分词） */
  async expandWord(word: Word): Promise<string[]> {
    if (word.quoted === 'single') {
      return [word.parts.map((p) => (p.kind === 'literal' ? p.text : '')).join('')];
    }

    let text = '';
    let sawUnquotedExpansion = false;
    for (const part of word.parts) {
      const [value, expanded] = await this.expandPart(part);
      text += value;
      if (expanded && word.quoted !== 'double') sawUnquotedExpansion = true;
    }

    if (word.quoted === 'double') return [text];
    // 未加引号的展开结果要分词；纯字面量不分（免得路径里的空格被拆）
    const fields = sawUnquotedExpansion ? text.split(/\s+/).filter(Boolean) : [text];
    return fields.flatMap((field) => this.expandGlob(field));
  }

  /** 只做变量与命令替换，不分词也不通配 —— case 的模式、`[[ ]]` 的右边要用 */
  async expandPattern(word: Word): Promise<string> {
    if (word.quoted === 'single') {
      return word.parts.map((p) => (p.kind === 'literal' ? p.text : '')).join('');
    }
    let text = '';
    for (const part of word.parts) text += (await this.expandPart(part))[0];
    return text;
  }

  /** heredoc 正文里的 `$VAR` / `$(cmd)` —— 没有分词，整段替换 */
  async expandText(text: string): Promise<string> {
    let out = '';
    let index = 0;
    while (index < text.length) {
      const dollar = text.indexOf('$', index);
      if (dollar < 0 || dollar === text.length - 1) {
        out += text.slice(index);
        break;
      }
      out += text.slice(index, dollar);
      const rest = text.slice(dollar);

      if (rest.startsWith('$((')) {
        const end = rest.indexOf('))');
        if (end < 0) { out += rest; break; }
        out += (await this.expandPart({ kind: 'arithmetic', source: rest.slice(3, end) }))[0];
        index = dollar + end + 2;
      } else if (rest.startsWith('$(')) {
        const end = matchParen(rest, 1);
        if (end < 0) { out += rest; break; }
        out += (await this.expandPart({ kind: 'command', source: rest.slice(2, end) }))[0];
        index = dollar + end + 1;
      } else if (rest.startsWith('${')) {
        const end = rest.indexOf('}');
        if (end < 0) { out += rest; break; }
        out += (await this.expandPart(parseBraceExpansion(rest.slice(0, end + 1))))[0];
        index = dollar + end + 1;
      } else {
        const name = /^\$([A-Za-z_][A-Za-z0-9_]*|[?@*#!$0-9])/.exec(rest);
        if (!name) { out += '$'; index = dollar + 1; continue; }
        out += (await this.expandPart({ kind: 'variable', name: name[1] }))[0];
        index = dollar + name[0].length;
      }
    }
    return out;
  }

  private async expandPart(part: WordPart): Promise<[string, boolean]> {
    switch (part.kind) {
      case 'literal':
        return [part.text, false];

      case 'variable': {
        const raw = this.lookup(part.name);
        const value = raw ?? '';
        if (part.length) return [String(value.length), true];
        if (part.modifier) {
          const argument = part.argument ?? '';
          switch (part.modifier) {
            case ':-': return [value || argument, true];
            case '-': return [raw === undefined ? argument : value, true];
            case ':=': {
              if (!value) this.vars[part.name] = argument;
              return [value || argument, true];
            }
            case '=': {
              if (raw === undefined) this.vars[part.name] = argument;
              return [raw === undefined ? argument : value, true];
            }
            case ':?': case '?':
              if (!value) throw new Error(`${part.name}: ${argument || 'parameter null or not set'}`);
              return [value, true];
            case ':+': return [value ? argument : '', true];
            case '+': return [raw === undefined ? '' : argument, true];
            case '#': return [stripPrefix(value, argument, false), true];
            case '##': return [stripPrefix(value, argument, true), true];
            case '%': return [stripSuffix(value, argument, false), true];
            case '%%': return [stripSuffix(value, argument, true), true];
            default: return [value, true];
          }
        }
        if (raw === undefined && this.options.nounset) {
          throw new Error(`${part.name}: unbound variable`);
        }
        return [value, true];
      }

      case 'command': {
        const result = await this.run(part.source);
        if (result.stderr) this.errSink(result.stderr);
        // 命令替换会吃掉末尾换行，这是 shell 的规矩
        return [result.stdout.replace(/\n+$/, ''), true];
      }

      case 'arithmetic': {
        const resolved = part.source
          .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name) => this.lookup(name) ?? '0')
          .replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => this.lookup(name) ?? '0');
        // 只允许算术字符，别让它变成任意代码执行的入口
        if (!/^[\d\s+\-*/%()]*$/.test(resolved)) return ['0', true];
        try {
          // eslint-disable-next-line no-new-func
          const value = Function(`"use strict";return (${resolved.trim() || 0})`)();
          return [String(Math.trunc(Number(value))), true];
        } catch {
          return ['0', true];
        }
      }

      default:
        return ['', false];
    }
  }

  private lookup(name: string): string | undefined {
    if (name === '?') return String(this.lastStatus);
    if (name === '$') return '1';
    if (name === '#') return String(this.positional.length);
    if (name === '@' || name === '*') return this.positional.join(' ');
    if (name === '0') return 'bash';
    if (/^[1-9][0-9]*$/.test(name)) return this.positional[Number(name) - 1];
    if (name === 'PWD') return this.cwd;
    return this.vars[name] ?? this.env[name];
  }

  /** `*.yaml` 这类通配。匹配不到就原样返回，和 bash 一致。 */
  private expandGlob(pattern: string): string[] {
    if (!/[*?[]/.test(pattern)) return [pattern];
    // 目录部分保持学员写的样子（相对就还是相对），只把最后一段拿去匹配
    const slash = pattern.lastIndexOf('/');
    const prefix = slash < 0 ? '' : pattern.slice(0, slash + 1);
    const namePattern = pattern.slice(slash + 1);
    if (/[*?[]/.test(prefix)) return [pattern];

    const directory = normalizePath(prefix || '.', this.cwd);
    if (!this.vfs.isDir(directory)) return [pattern];

    const matches = this.vfs
      .readDir(directory)
      // 通配不匹配隐藏文件，除非模式本身以点开头
      .filter((entry) => !entry.startsWith('.') || namePattern.startsWith('.'))
      .filter((entry) => matchesGlob(namePattern, entry))
      .map((entry) => `${prefix}${entry}`);
    return matches.length > 0 ? matches : [pattern];
  }

  /* ---------------- 内置命令要用到的 ---------------- */

  setOption(name: string, value: boolean): void {
    if (name === 'e') this.options.errexit = value;
    if (name === 'u') this.options.nounset = value;
    if (name === 'pipefail') this.options.pipefail = value;
  }

  exportVar(name: string, value?: string): void {
    this.env[name] = value ?? this.vars[name] ?? this.env[name] ?? '';
    delete this.vars[name];
  }

  unsetVar(name: string): void {
    delete this.vars[name];
    delete this.env[name];
    delete this.functions[name];
  }

  setVar(name: string, value: string): void {
    this.vars[name] = value;
  }

  getVar(name: string): string | undefined {
    return this.lookup(name);
  }

  allVars(): Record<string, string> {
    return { ...this.env, ...this.vars, PWD: this.cwd };
  }

  /** 位置参数，`$1` `$@` 用；给关卡脚本注入参数时也用得上 */
  setPositional(args: string[]): void {
    this.positional = [...args];
  }

  /** 回到一个干净状态。快照还原要用 —— 变量、函数、set 选项都不该留到下一轮。 */
  reset(state: { cwd: string; env: Record<string, string> }): void {
    this.cwd = state.cwd;
    this.env = { ...state.env, PWD: state.cwd };
    this.vars = {};
    this.functions = {};
    this.positional = [];
    this.frames = [];
    this.options = { errexit: false, nounset: false, pipefail: false };
    this.lastStatus = 0;
  }

  changeDirectory(target: string): void {
    const path = normalizePath(target, this.cwd);
    if (!this.vfs.exists(path)) throw new Error(`cd: ${target}: No such file or directory`);
    if (!this.vfs.isDir(path)) throw new Error(`cd: ${target}: Not a directory`);
    this.cwd = path;
    this.env.PWD = path;
  }
}

/* ------------------------------------------------------------------ */
/* 展开用的小工具                                                      */
/* ------------------------------------------------------------------ */

/** `${x#pattern}` / `${x##pattern}` */
function stripPrefix(value: string, pattern: string, greedy: boolean): string {
  const candidates: string[] = [];
  for (let i = 0; i <= value.length; i += 1) {
    if (matchesGlob(pattern, value.slice(0, i))) candidates.push(value.slice(i));
  }
  if (candidates.length === 0) return value;
  return greedy ? candidates[candidates.length - 1] : candidates[0];
}

/** `${x%pattern}` / `${x%%pattern}` */
function stripSuffix(value: string, pattern: string, greedy: boolean): string {
  const candidates: string[] = [];
  for (let i = value.length; i >= 0; i -= 1) {
    if (matchesGlob(pattern, value.slice(i))) candidates.push(value.slice(0, i));
  }
  if (candidates.length === 0) return value;
  return greedy ? candidates[candidates.length - 1] : candidates[0];
}

/** shell 通配（`*` 不跨 `/`，`?` 一个字符，`[abc]` 字符类），case 分支也用它 */
export function matchesGlob(pattern: string, value: string): boolean {
  let regex = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else if (char === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) { regex += '\\['; continue; }
      const body = pattern.slice(i + 1, end).replace(/^!/, '^');
      regex += `[${body}]`;
      i = end;
    } else if (char === '|') regex += '|';
    else regex += char.replace(/[.+^${}()\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^(?:${regex})$`).test(value);
  } catch {
    return pattern === value;
  }
}

/** 找到与 `text[open]` 配对的右括号下标 */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** heredoc 里遇到的 `${...}`，走和解析器一样的规则 */
function parseBraceExpansion(text: string): WordPart {
  const inner = text.slice(2, -1);
  if (inner.startsWith('#') && inner.length > 1) {
    return { kind: 'variable', name: inner.slice(1), length: true };
  }
  const match = /^([A-Za-z_][A-Za-z0-9_]*|[?@*#!$0-9]+)(:?[-=?+]|##?|%%?)?([\s\S]*)$/.exec(inner);
  if (!match) return { kind: 'literal', text };
  return {
    kind: 'variable',
    name: match[1],
    modifier: match[2] || undefined,
    argument: match[3] || undefined,
  };
}

/* ------------------------------------------------------------------ */
/* 内置命令                                                            */
/* ------------------------------------------------------------------ */

const BUILTINS: Record<string, CommandHandler> = {
  cd: ({ argv, shell, env }) => {
    try {
      shell.changeDirectory(argv[0] ?? env.HOME ?? '/');
      return { code: 0 };
    } catch (error) {
      return { stderr: `bash: ${(error as Error).message}\n`, code: 1 };
    }
  },

  pwd: ({ shell }) => ({ stdout: `${shell.cwd}\n` }),

  echo: ({ argv }) => {
    const noNewline = argv[0] === '-n';
    const words = noNewline ? argv.slice(1) : argv;
    return { stdout: words.join(' ') + (noNewline ? '' : '\n') };
  },

  printf: ({ argv }) => {
    const [format = '', ...rest] = argv;
    let index = 0;
    const text = format
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .replace(/%[sd]/g, () => rest[index++] ?? '');
    return { stdout: text };
  },

  export: ({ argv, shell }) => {
    for (const item of argv) {
      const index = item.indexOf('=');
      if (index < 0) shell.exportVar(item);
      else shell.exportVar(item.slice(0, index), item.slice(index + 1));
    }
    return { code: 0 };
  },

  unset: ({ argv, shell }) => {
    for (const name of argv) shell.unsetVar(name);
    return { code: 0 };
  },

  set: ({ argv, shell }) => {
    for (let i = 0; i < argv.length; i += 1) {
      const flag = argv[i];
      if (flag === '-o' || flag === '+o') {
        shell.setOption(argv[i + 1] ?? '', flag === '-o');
        i += 1;
      } else if (/^[-+][a-z]+$/.test(flag)) {
        for (const letter of flag.slice(1)) shell.setOption(letter, flag.startsWith('-'));
      }
    }
    return { code: 0 };
  },

  exit: ({ argv }) => {
    throw new ExitSignal(Number(argv[0] ?? 0) || 0);
  },

  return: ({ argv }) => {
    throw new ReturnSignal(Number(argv[0] ?? 0) || 0);
  },

  true: () => ({ code: 0 }),
  false: () => ({ code: 1 }),
  ':': () => ({ code: 0 }),

  /** `test` / `[` —— 条件判断 */
  test: (context) => runTest(context.argv, context),
  '[': (context) => runTest(context.argv.filter((arg) => arg !== ']'), context),

  source: async ({ argv, shell, vfs, cwd }) => {
    const path = normalizePath(argv[0] ?? '', cwd);
    if (!vfs.exists(path)) return { stderr: `bash: ${argv[0]}: No such file or directory\n`, code: 1 };
    return shell.run(vfs.readFile(path));
  },
};
BUILTINS['.'] = BUILTINS.source;

function runTest(argv: string[], context: CommandContext): CommandResult {
  const ok = (value: boolean): CommandResult => ({ code: value ? 0 : 1 });
  if (argv.length === 0) return ok(false);
  if (argv[0] === '!') {
    const inner = runTest(argv.slice(1), context);
    return ok(inner.code !== 0);
  }

  const { vfs, cwd } = context;
  if (argv.length === 1) return ok(argv[0].length > 0);

  if (argv.length === 2) {
    const [flag, operand] = argv;
    const path = normalizePath(operand, cwd);
    switch (flag) {
      case '-e': return ok(vfs.exists(path));
      case '-f': return ok(vfs.isFile(path));
      case '-d': return ok(vfs.isDir(path));
      case '-r': case '-w': return ok(vfs.exists(path));
      case '-x': return ok(vfs.exists(path) && (vfs.stat(path).mode & 0o111) !== 0);
      case '-s': return ok(vfs.isFile(path) && vfs.readFile(path).length > 0);
      case '-z': return ok(operand.length === 0);
      case '-n': return ok(operand.length > 0);
      default: return ok(false);
    }
  }
  if (argv.length === 3) {
    const [left, operator, right] = argv;
    switch (operator) {
      case '=': return ok(left === right);
      // `[[ $a == b* ]]` 里右边是通配模式，这是 bash 的行为
      case '==': return ok(left === right || matchesGlob(right, left));
      case '!=': return ok(left !== right);
      case '<': return ok(left < right);
      case '>': return ok(left > right);
      case '-eq': return ok(Number(left) === Number(right));
      case '-ne': return ok(Number(left) !== Number(right));
      case '-lt': return ok(Number(left) < Number(right));
      case '-le': return ok(Number(left) <= Number(right));
      case '-gt': return ok(Number(left) > Number(right));
      case '-ge': return ok(Number(left) >= Number(right));
      default: return ok(false);
    }
  }
  return ok(argv[0].length > 0);
}

export function createShell(options: ShellOptions): Shell {
  return new Shell(options);
}
