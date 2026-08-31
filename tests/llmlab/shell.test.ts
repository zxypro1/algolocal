/**
 * 终端里那几条命令
 *
 * 这一组用例存在的直接原因：在浏览器里手点的时候，`python bpe.py` **卡住了** ——
 * 没有输出，也没有回到提示符。而终端一旦卡住就再也回不来（`busy` 标记不会复位），
 * 学员唯一的出路是刷新页面。
 *
 * 在浏览器里点着排查这种问题太慢，而它本来就是纯逻辑。
 * 所以命令处理从 hook 里搬进了 `lab/shell.ts`，并在这里逐条验。
 *
 * **最要紧的不变量：`runCommand` 在任何情况下都要返回，不能抛，也不能永远挂着。**
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildWorld, runCommand, type TrainWorld } from '../../src/lib/llmlab/lab';

const ROOT = join(__dirname, '..', '..');
const WASM = readFileSync(join(ROOT, 'public', 'llmlab', 'llmlab-kernels.wasm'));
const INDEX_URL = join(ROOT, 'public', 'llmlab', 'pyodide') + '/';

let world: TrainWorld;

beforeAll(async () => {
  world = await buildWorld({
    wasmBytes: WASM,
    python: { indexURL: INDEX_URL },
    spec: {
      machine: {
        files: {
          'hello.py': 'print("你好，世界")\nVALUE = 42\n',
          'boom.py': 'raise ValueError("学员自己的错")\n',
          'quiet.py': 'x = 1 + 1\n',
          'slow_ok.py': 'total = sum(range(200000))\nprint("算完了", total)\n',
        },
      },
    },
  });
}, 180_000);

describe('每条命令都要在有限时间内返回', () => {
  const commands = [
    'help', 'pwd', 'ls', 'ls data', 'cat hello.py', 'head -n 2 hello.py',
    'python hello.py', 'python quiet.py', 'python boom.py', 'python slow_ok.py',
    'python', 'cat', 'head', 'ls /nope', 'cat /nope.py', 'python /nope.py',
    'rm -rf /', '', '   ', 'python -m json.tool',
  ];

  it.each(commands)('%p 返回一个字符串，不抛也不挂', async (cmd) => {
    const out = await Promise.race([
      runCommand(world, cmd),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`命令 ${JSON.stringify(cmd)} 超过 60 秒没返回`)), 60_000)
      ),
    ]);
    expect(typeof out).toBe('string');
  }, 90_000);
});

describe('具体行为', () => {
  it('python 跑得起来，stdout 接得住', async () => {
    const out = await runCommand(world, 'python hello.py');
    expect(out).toContain('你好，世界');
  });

  /*
   * 脚本什么都不打印是常事（学员还没写 print）。这时终端上什么都不出，
   * 会让人以为命令卡住了 —— 而「像是卡住了」和「真的卡住了」在体验上没区别。
   */
  it('脚本没有输出时给一行回执，而不是一片空白', async () => {
    const out = await runCommand(world, 'python quiet.py');
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).toContain('quiet.py');
  });

  it('Python 报错时带出原文，而不是一个泛泛的失败', async () => {
    const out = await runCommand(world, 'python boom.py');
    expect(out).toContain('学员自己的错');
  });

  it('ls 列得出 nanotorch 与 data', async () => {
    const out = await runCommand(world, 'ls');
    expect(out).toContain('nanotorch');
    expect(out).toContain('data');
  });

  it('ls 一个不存在的目录：报错，不崩', async () => {
    const out = await runCommand(world, 'ls /nope');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('undefined');
  });

  it('cat 与 head', async () => {
    expect(await runCommand(world, 'cat hello.py')).toContain('VALUE = 42');
    const head = await runCommand(world, 'head -n 1 hello.py');
    expect(head).toContain('你好，世界');
    expect(head).not.toContain('VALUE');
  });

  it('不认识的命令给一句能照着做的提示', async () => {
    const out = await runCommand(world, 'kubectl get pods');
    expect(out).toContain('help');
  });

  it('空行什么都不做', async () => {
    expect(await runCommand(world, '   ')).toBe('');
  });

  it('跑过脚本之后 revision 变了 —— 面板据此重算', async () => {
    const before = world.revision;
    await runCommand(world, 'python hello.py');
    expect(world.revision).toBeGreaterThan(before);
  });

  it('脚本里的顶层变量之后读得到（判定和面板都靠它）', async () => {
    await runCommand(world, 'python hello.py');
    expect(world.session.scriptJson('VALUE')).toBe(42);
  });
});

describe('第 1 关的起始代码', () => {
  /*
   * 就是它在浏览器里卡住的。起始代码里三个函数都是 TODO，
   * 跑起来应该是几百毫秒的事 —— 卡住说明别的地方不对。
   */
  it('起始的 bpe.py 跑得完，而且有输出', async () => {
    const raw = JSON.parse(readFileSync(join(ROOT, 'projects', 'projects.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw as { projects: unknown[] }).projects;
    const project = (list as Array<Record<string, any>>).find((p) => p.id === 'llm-from-scratch')!;
    const starter = project.stages[0].train.files['bpe.py'] as string;
    world.session.writeFile('bpe.py', starter);

    const started = Date.now();
    const out = await runCommand(world, 'python bpe.py');
    const ms = Date.now() - started;
    console.log(`  起始的 bpe.py：${ms}ms，输出 ${JSON.stringify(out.slice(0, 80))}`);
    expect(out.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(60_000);
  }, 120_000);
});
