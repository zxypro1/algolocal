/**
 * coreutils
 *
 * 覆盖排查问题真正会用到的那些。选择标准不是「命令齐全」，
 * 而是「学员在关卡里会敲」：看文件、找东西、过滤、统计、改文件。
 *
 * 不支持的写法一律明确报错，不要装作支持了 —— 一个被悄悄忽略的参数，
 * 会让人对着「命令成功了但结果不对」查上半天。
 */
import { normalizePath } from '../vfs';
import type { CommandContext, CommandHandler, CommandResult } from './shell';

const ok = (stdout = ''): CommandResult => ({ stdout, code: 0 });
const fail = (message: string, code = 1): CommandResult => ({ stderr: `${message}\n`, code });

interface Args {
  /** `-l`、`--all` 这种开关 */
  flags: Set<string>;
  /** `-n 5`、`-d,`、`--name=x` 这种带值的 */
  options: Record<string, string>;
  /** 位置参数 */
  values: string[];
}

/**
 * 拆参数。
 *
 * `valueFlags` 列出哪些短选项要吃掉后面那个值 —— 不告诉它的话，
 * `cut -d " " -f 1 f.txt` 里的分隔符会被当成文件名。
 * `-n5`、`-n 5`、`-abc` 合写、`--` 之后全算位置参数，都按 GNU 的规矩来。
 */
function parseArgs(argv: string[], valueFlags = ''): Args {
  const flags = new Set<string>();
  const options: Record<string, string> = {};
  const values: string[] = [];
  let literal = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (literal || arg === '-' || !arg.startsWith('-')) { values.push(arg); continue; }
    if (arg === '--') { literal = true; continue; }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      if (equals > 0) options[arg.slice(2, equals)] = arg.slice(equals + 1);
      else flags.add(arg.slice(2));
      continue;
    }
    for (let j = 1; j < arg.length; j += 1) {
      const letter = arg[j];
      if (valueFlags.includes(letter)) {
        const inline = arg.slice(j + 1);
        options[letter] = inline || argv[++i] || '';
        break;
      }
      flags.add(letter);
    }
  }
  return { flags, options, values };
}

/** `head -n 5` 与老写法 `head -5` 都要认 */
function countOption(args: Args, fallback: number): number {
  const explicit = Number(args.options.n);
  if (Number.isFinite(explicit) && args.options.n !== undefined) return explicit;
  for (const flag of args.flags) {
    if (/^\d+$/.test(flag)) return Number(flag);
  }
  return fallback;
}

function resolve(context: CommandContext, path: string): string {
  return normalizePath(path, context.cwd);
}

/** 读取位置参数指定的文件；没给就用 stdin */
function readInputs(context: CommandContext, values: string[]): { text: string; error?: string } {
  if (values.length === 0) return { text: context.stdin };
  const chunks: string[] = [];
  for (const value of values) {
    const path = resolve(context, value);
    if (!context.vfs.exists(path)) return { text: '', error: `${value}: No such file or directory` };
    if (context.vfs.isDir(path)) return { text: '', error: `${value}: Is a directory` };
    chunks.push(context.vfs.readFile(path));
  }
  return { text: chunks.join('') };
}

const lines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
const join = (values: string[]): string => (values.length ? `${values.join('\n')}\n` : '');

export const COREUTILS: Record<string, CommandHandler> = {
  ls: (context) => {
    const args = parseArgs(context.argv);
    const targets = args.values.length ? args.values : ['.'];
    const blocks: string[] = [];

    for (const value of targets) {
      const target = resolve(context, value);
      if (!context.vfs.exists(target)) {
        return fail(`ls: cannot access '${value}': No such file or directory`, 2);
      }
      if (context.vfs.isFile(target)) { blocks.push(`${value}\n`); continue; }

      const entries = context.vfs
        .readDir(target)
        .filter((name) => args.flags.has('a') || !name.startsWith('.'));
      blocks.push(
        args.flags.has('l')
          ? join(entries.map((name) => longFormat(context, target, name)))
          : join(entries)
      );
    }
    // 多个目标时会打上目录名做表头，和 GNU ls 一样
    if (targets.length > 1) {
      return ok(targets.map((value, index) => `${value}:\n${blocks[index]}`).join('\n'));
    }
    return ok(blocks[0]);
  },

  cat: (context) => {
    const args = parseArgs(context.argv);
    const input = readInputs(context, args.values);
    if (input.error) return fail(`cat: ${input.error}`);
    if (!args.flags.has('n')) return ok(input.text);
    return ok(join(lines(input.text).map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)));
  },

  head: (context) => {
    const args = parseArgs(context.argv, 'nc');
    const input = readInputs(context, args.values);
    if (input.error) return fail(`head: ${input.error}`);
    return ok(join(lines(input.text).slice(0, countOption(args, 10))));
  },

  tail: (context) => {
    const args = parseArgs(context.argv, 'nc');
    const input = readInputs(context, args.values);
    if (input.error) return fail(`tail: ${input.error}`);
    return ok(join(lines(input.text).slice(-countOption(args, 10))));
  },

  wc: (context) => {
    const args = parseArgs(context.argv);
    const input = readInputs(context, args.values);
    if (input.error) return fail(`wc: ${input.error}`);
    const text = input.text;
    const lineCount = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (args.flags.has('l')) return ok(`${lineCount}\n`);
    if (args.flags.has('w')) return ok(`${wordCount}\n`);
    if (args.flags.has('c')) return ok(`${text.length}\n`);
    return ok(`${lineCount} ${wordCount} ${text.length}\n`);
  },

  grep: (context) => {
    const args = parseArgs(context.argv, 'e');
    const values = [...args.values];
    const pattern = args.options.e ?? values.shift();
    if (pattern === undefined) return fail('usage: grep [-invcqh] pattern [file ...]', 2);

    const input = readInputs(context, values);
    if (input.error) return fail(`grep: ${input.error}`, 2);

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, args.flags.has('i') ? 'i' : '');
    } catch {
      return fail(`grep: ${pattern}: invalid regular expression`, 2);
    }

    const matched = lines(input.text).filter((line) => regex.test(line) !== args.flags.has('v'));
    // 没匹配到任何东西时退出码是 1，脚本里常拿它当条件
    const code = matched.length === 0 ? 1 : 0;
    if (args.flags.has('q')) return { stdout: '', code };
    if (args.flags.has('c')) return { stdout: `${matched.length}\n`, code };
    return { stdout: join(matched), code };
  },

  sort: (context) => {
    const args = parseArgs(context.argv);
    const input = readInputs(context, args.values);
    if (input.error) return fail(`sort: ${input.error}`);
    let sorted = lines(input.text).sort((a, b) =>
      args.flags.has('n') ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0
    );
    if (args.flags.has('r')) sorted = sorted.reverse();
    if (args.flags.has('u')) sorted = sorted.filter((line, i) => i === 0 || line !== sorted[i - 1]);
    return ok(join(sorted));
  },

  uniq: (context) => {
    const args = parseArgs(context.argv);
    const input = readInputs(context, args.values);
    if (input.error) return fail(`uniq: ${input.error}`);
    const all = lines(input.text);
    if (!args.flags.has('c')) {
      return ok(join(all.filter((line, i) => i === 0 || line !== all[i - 1])));
    }
    const out: string[] = [];
    let index = 0;
    while (index < all.length) {
      let count = 1;
      while (index + count < all.length && all[index + count] === all[index]) count += 1;
      out.push(`${String(count).padStart(7)} ${all[index]}`);
      index += count;
    }
    return ok(join(out));
  },

  cut: (context) => {
    const args = parseArgs(context.argv, 'df');
    const delimiter = args.options.d ?? '\t';
    const fieldSpec = args.options.f;
    if (!fieldSpec) return fail('cut: you must specify a list of fields', 2);
    const fields = fieldSpec.split(',').map((n) => Number(n) - 1);

    const input = readInputs(context, args.values);
    if (input.error) return fail(`cut: ${input.error}`);
    return ok(join(lines(input.text).map((line) => {
      const parts = line.split(delimiter);
      return fields.map((index) => parts[index] ?? '').join(delimiter);
    })));
  },

  tr: (context) => {
    const args = parseArgs(context.argv);
    const [from, to] = args.values;
    if (from === undefined) return fail('tr: missing operand', 2);

    let text = context.stdin;
    if (args.flags.has('d') || to === undefined) {
      text = text.split('').filter((c) => !from.includes(c)).join('');
    } else {
      text = text.split('').map((c) => {
        const index = from.indexOf(c);
        return index >= 0 ? (to[index] ?? to[to.length - 1]) : c;
      }).join('');
    }
    // -s 把连续重复的目标字符压成一个
    if (args.flags.has('s')) {
      const squeeze = to ?? from;
      for (const char of new Set(squeeze.split(''))) {
        text = text.split(new RegExp(`${escapeRegExp(char)}{2,}`, 'g')).join(char);
      }
    }
    return ok(text);
  },

  mkdir: (context) => {
    const args = parseArgs(context.argv, 'm');
    for (const value of args.values) {
      const path = resolve(context, value);
      if (context.vfs.exists(path)) {
        if (args.flags.has('p')) continue;
        return fail(`mkdir: cannot create directory '${value}': File exists`);
      }
      if (!args.flags.has('p') && !context.vfs.isDir(normalizePath(`${path}/..`))) {
        return fail(`mkdir: cannot create directory '${value}': No such file or directory`);
      }
      context.vfs.mkdirp(path);
    }
    return ok();
  },

  rmdir: (context) => {
    const args = parseArgs(context.argv);
    for (const value of args.values) {
      const path = resolve(context, value);
      if (!context.vfs.isDir(path)) return fail(`rmdir: failed to remove '${value}': Not a directory`);
      if (context.vfs.readDir(path).length > 0) {
        return fail(`rmdir: failed to remove '${value}': Directory not empty`);
      }
      context.vfs.remove(path);
    }
    return ok();
  },

  rm: (context) => {
    const args = parseArgs(context.argv);
    const recursive = args.flags.has('r') || args.flags.has('R');
    for (const value of args.values) {
      const path = resolve(context, value);
      if (!context.vfs.exists(path)) {
        if (args.flags.has('f')) continue;
        return fail(`rm: cannot remove '${value}': No such file or directory`);
      }
      if (context.vfs.isDir(path) && !recursive) {
        return fail(`rm: cannot remove '${value}': Is a directory`);
      }
      context.vfs.remove(path, { recursive });
    }
    return ok();
  },

  cp: (context) => {
    const args = parseArgs(context.argv);
    const [source, target] = args.values;
    if (!source || !target) return fail('cp: missing file operand', 2);
    const from = resolve(context, source);
    const to = resolve(context, target);
    if (!context.vfs.exists(from)) return fail(`cp: cannot stat '${source}': No such file or directory`);

    if (context.vfs.isDir(from)) {
      if (!(args.flags.has('r') || args.flags.has('R'))) {
        return fail(`cp: -r not specified; omitting directory '${source}'`);
      }
      for (const file of context.vfs.walk(from)) {
        context.vfs.writeFile(`${to}${file.slice(from.length)}`, context.vfs.readFile(file));
      }
      return ok();
    }
    const destination = context.vfs.isDir(to) ? `${to}/${baseOf(source)}` : to;
    context.vfs.writeFile(destination, context.vfs.readFile(from));
    return ok();
  },

  mv: (context) => {
    const args = parseArgs(context.argv);
    const [source, target] = args.values;
    if (!source || !target) return fail('mv: missing file operand', 2);
    const from = resolve(context, source);
    const to = resolve(context, target);
    if (!context.vfs.exists(from)) return fail(`mv: cannot stat '${source}': No such file or directory`);
    context.vfs.rename(from, context.vfs.isDir(to) ? `${to}/${baseOf(source)}` : to);
    return ok();
  },

  touch: (context) => {
    for (const value of parseArgs(context.argv).values) {
      const path = resolve(context, value);
      if (!context.vfs.exists(path)) context.vfs.writeFile(path, '');
    }
    return ok();
  },

  chmod: (context) => {
    const args = parseArgs(context.argv);
    const [mode, ...targets] = args.values;
    if (!/^[0-7]{3,4}$/.test(mode ?? '')) return fail(`chmod: invalid mode: '${mode ?? ''}'`, 1);
    for (const value of targets) {
      const path = resolve(context, value);
      if (!context.vfs.exists(path)) {
        return fail(`chmod: cannot access '${value}': No such file or directory`);
      }
      context.vfs.chmod(path, parseInt(mode, 8));
    }
    return ok();
  },

  find: (context) => {
    // find 的语法是「路径 + 谓词」，不是普通的选项，按位置一个个扫
    let namePattern: string | undefined;
    let type: string | undefined;
    let start = '.';
    let sawStart = false;
    for (let i = 0; i < context.argv.length; i += 1) {
      const arg = context.argv[i];
      if (arg === '-name') { namePattern = context.argv[++i]; continue; }
      if (arg === '-type') { type = context.argv[++i]; continue; }
      if (arg.startsWith('-')) continue;
      if (!sawStart) { start = arg; sawStart = true; }
    }

    const root = resolve(context, start);
    if (!context.vfs.exists(root)) return fail(`find: '${start}': No such file or directory`);

    const regex = namePattern ? globToRegExp(namePattern) : null;
    const found = context.vfs.walkAll(root).filter((path) => {
      if (regex && !regex.test(baseOf(path))) return false;
      if (type === 'f' && !context.vfs.isFile(path)) return false;
      if (type === 'd' && !context.vfs.isDir(path)) return false;
      return true;
    });
    return ok(join(found));
  },

  tee: (context) => {
    const args = parseArgs(context.argv);
    for (const value of args.values) {
      const path = resolve(context, value);
      if (args.flags.has('a')) context.vfs.appendFile(path, context.stdin);
      else context.vfs.writeFile(path, context.stdin);
    }
    return ok(context.stdin);
  },

  env: (context) => {
    const entries = Object.entries(context.shell.allVars()).sort(([a], [b]) => (a < b ? -1 : 1));
    return ok(join(entries.map(([key, value]) => `${key}=${value}`)));
  },

  which: (context) => {
    const name = context.argv[0];
    if (!name) return fail('usage: which command', 2);
    return context.shell.has(name) ? ok(`/usr/bin/${name}\n`) : { stdout: '', code: 1 };
  },

  hostname: (context) => ok(`${context.shell.hostname}\n`),
  whoami: (context) => ok(`${context.shell.user}\n`),
  id: (context) => ok(`uid=0(${context.shell.user}) gid=0(root) groups=0(root)\n`),

  basename: (context) => {
    const [value = '', suffix] = parseArgs(context.argv).values;
    const name = baseOf(value) || '/';
    return ok(`${suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name}\n`);
  },

  dirname: (context) => {
    const value = parseArgs(context.argv).values[0] ?? '';
    const parts = value.split('/').filter(Boolean);
    parts.pop();
    return ok(`${value.startsWith('/') ? '/' : ''}${parts.join('/') || '.'}\n`);
  },

  seq: (context) => {
    const numbers = parseArgs(context.argv).values.map(Number);
    const [start, end] = numbers.length === 1 ? [1, numbers[0]] : numbers;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return fail('seq: invalid argument', 2);
    const out: string[] = [];
    for (let i = start; i <= end; i += 1) out.push(String(i));
    return ok(join(out));
  },

  xargs: async (context) => {
    const args = parseArgs(context.argv);
    const [name, ...rest] = args.values;
    if (!name) return ok(context.stdin);
    const items = context.stdin.split(/\s+/).filter(Boolean);
    const quoted = items.map((item) => `'${item.replace(/'/g, "'\\''")}'`).join(' ');
    return context.shell.run(`${name} ${rest.join(' ')} ${quoted}`.trim());
  },

  /**
   * sed 只做最常用的 `s/a/b/` 与 `NNd`。
   *
   * 其余语法明确报「不支持」—— 一个被悄悄忽略的 sed 表达式，
   * 会让学员对着「命令成功了但文件没变」查半天。
   */
  sed: (context) => {
    const args = parseArgs(context.argv, 'e');
    const values = [...args.values];
    const script = args.options.e ?? values.shift();
    if (!script) return fail('sed: no script specified', 2);
    const input = readInputs(context, values);
    if (input.error) return fail(`sed: ${input.error}`);

    const substitute = /^s(.)([\s\S]*?)\1([\s\S]*?)\1([gi]*)$/.exec(script);
    if (substitute) {
      const [, , pattern, replacement, modifiers] = substitute;
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, modifiers.includes('g') ? 'g' : '');
      } catch {
        return fail(`sed: -e expression #1, char 0: invalid regex: ${pattern}`, 1);
      }
      const replaced = lines(input.text).map((line) => line.replace(regex, replacement));
      const text = join(replaced);
      if (args.flags.has('i')) {
        context.vfs.writeFile(resolve(context, values[0] ?? ''), text);
        return ok();
      }
      return ok(text);
    }

    const deleteLine = /^(\d+)d$/.exec(script);
    if (deleteLine) {
      const target = Number(deleteLine[1]);
      return ok(join(lines(input.text).filter((_, index) => index + 1 !== target)));
    }
    return fail(`sed: unsupported script "${script}" (opslab supports s/a/b/ and Nd)`, 2);
  },
};

/* ------------------------------------------------------------------ */

function baseOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('')
    .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : escapeRegExp(char)))
    .join('');
  return new RegExp(`^${body}$`);
}

/** `ls -l` 的那一行 */
function longFormat(context: CommandContext, directory: string, name: string): string {
  const stat = context.vfs.stat(`${directory === '/' ? '' : directory}/${name}`);
  const type = stat.type === 'dir' ? 'd' : stat.type === 'symlink' ? 'l' : '-';
  const size = String(stat.size).padStart(5);
  return `${type}${permissionString(stat.mode)} 1 root root ${size} ${formatTime(stat.mtime)} ${name}`;
}

function permissionString(mode: number): string {
  const bits = ['r', 'w', 'x'];
  let out = '';
  for (let shift = 6; shift >= 0; shift -= 3) {
    const value = (mode >> shift) & 7;
    for (let i = 0; i < 3; i += 1) out += value & (4 >> i) ? bits[i] : '-';
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Jan  1 00:00` —— 用虚拟墙钟，UTC，保证可复现 */
function formatTime(mtime: number): string {
  const date = new Date(mtime);
  const day = String(date.getUTCDate()).padStart(2, ' ');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[date.getUTCMonth()]} ${day} ${hours}:${minutes}`;
}
