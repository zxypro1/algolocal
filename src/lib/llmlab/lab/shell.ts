/**
 * 终端里那几条命令
 *
 * **这不是一个真 shell，边界写在这里。** 支持 `python` / `ls` / `cat` / `head` /
 * `pwd` / `help`，而且它们**都转给 Python 执行** —— 文件系统的主人是 Pyodide，
 * 让它自己回答比在 JS 里镜像一份可靠。
 *
 * 为什么不接 labkit 那套完整 shell（opslab / gpulab 用的那个）：它管的是自己的
 * VFS，而这里的文件全在 Pyodide 的 FS 里。桥接两套文件系统的工作量远大于收益 ——
 * 这个项目里终端的作用是「跑我的脚本、看看盘上有什么」，不是学 shell。
 * 真要学 shell，那是 opslab 的内容。
 *
 * 单独成文件（而不是塞在 hook 里）是为了**能被测试直接调**：
 * 它是纯逻辑，不该只能通过点浏览器来验证。
 */
import type { TrainWorld } from './world';

export const LAB_ROOT = '/lab';

export function absolutePath(path: string): string {
  return path.startsWith('/') ? path : `${LAB_ROOT}/${path}`;
}

const HELP = [
  '这个终端支持的命令（它不是一个完整的 shell）：',
  '  python <文件>            跑你的脚本',
  '  python -m <模块>         跑一个模块',
  '  ls [目录]                看看盘上有什么',
  '  cat <文件>               打印一个文件',
  '  head [-n N] <文件>       看开头几行（默认 20）',
  '  pwd                      当前目录',
  '',
].join('\n');

/**
 * 跑一条命令，返回要打印的文本（`\n` 换行，由调用方转成 `\r\n`）。
 *
 * **任何情况下都要返回，不能抛。** 终端那边用 `busy` 标记挡住输入，
 * 只有这个 Promise 落地才会把提示符画回来 —— 一次未捕获的异常会让终端
 * 永久卡住，而学员唯一的出路是刷新页面。
 */
export async function runCommand(world: TrainWorld, line: string): Promise<string> {
  const trimmed = line.trim();
  if (!trimmed) return '';
  const [cmd, ...args] = trimmed.split(/\s+/);

  try {
    switch (cmd) {
      case 'python':
      case 'python3':
        return runPython(world, args);
      case 'ls':
        return listDir(world, args[0] ?? '.');
      case 'cat': {
        if (!args[0]) return 'cat: 要给一个文件名\n';
        const text = world.session.py.readFile(absolutePath(args[0]));
        return text.endsWith('\n') ? text : `${text}\n`;
      }
      case 'head': {
        const n = args[0] === '-n' ? Number(args[1]) || 20 : 20;
        const file = args[0] === '-n' ? args[2] : args[0];
        if (!file) return 'head: 要给一个文件名\n';
        const text = world.session.py.readFile(absolutePath(file));
        return `${text.split('\n').slice(0, n).join('\n')}\n`;
      }
      case 'pwd':
        return `${LAB_ROOT}\n`;
      case 'help':
        return HELP;
      default:
        return `${cmd}: 这个终端不支持这条命令。敲 help 看支持哪些。\n`;
    }
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n`;
  }
}

function runPython(world: TrainWorld, args: string[]): string {
  if (!args[0]) return 'python: 要给一个脚本名\n';

  if (args[0] === '-m') {
    if (!args[1]) return 'python: -m 后面要给模块名\n';
    world.session.py.drainOutput();
    world.session.py.run(
      `import runpy; _lab_globals = runpy.run_module(${JSON.stringify(args[1])}, run_name="__main__")`
    );
    const out = world.session.py.drainOutput();
    world.revision += 1;
    return out.stdout + out.stderr;
  }

  const source = world.session.py.readFile(absolutePath(args[0]));
  const out = world.session.runScript(args[0], source);
  world.revision += 1;
  /*
   * 脚本什么都不打印是常事（学员还没写 print），这时给一行回执 ——
   * 终端上什么都不出会让人以为命令卡住了，而那正是最糟的反馈。
   */
  const text = out.stdout + out.stderr;
  return text || `（${args[0]} 跑完了，没有输出）\n`;
}

function listDir(world: TrainWorld, dir: string): string {
  const path = absolutePath(dir).replace(/\/\.$/, '') || LAB_ROOT;
  const listed = world.session.py.run(`
import os as _os
"\\n".join(sorted(_os.listdir(${JSON.stringify(path)})))
`);
  const text = String(listed ?? '');
  return text ? `${text}\n` : '（空目录）\n';
}
