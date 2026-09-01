/**
 * 机器层：文件系统、shell 解析与执行、coreutils
 *
 * 判断标准是「跟真 bash 一致」：命令怎么写、输出什么样、退出码是几。
 * 所以这里的断言基本都是把真 bash 的行为抄下来。
 */
import { createMachine, Machine } from '../../src/lib/labkit/machine';
import { createVfs, VfsError } from '../../src/lib/labkit/machine/vfs';
import { matchesGlob } from '../../src/lib/labkit/machine/shell/shell';
import { loadShellParser, parseShell, resetShellParser, ShellSyntaxError } from '../../src/lib/labkit/machine/shell/parser';
import fs from 'node:fs';
import path from 'node:path';

/** 只要 stdout，顺手断言退出码是 0 —— 大多数用例都这么用 */
async function sh(machine: Machine, command: string): Promise<string> {
  const result = await machine.exec(command);
  if (result.code !== 0) {
    throw new Error(`"${command}" exited ${result.code}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

describe('Vfs', () => {
  it('规整路径时处理 . 与 ..', () => {
    const vfs = createVfs();
    vfs.writeFile('/a/b/c.txt', 'hi');
    expect(vfs.readFile('/a/b/../b/./c.txt')).toBe('hi');
    expect(vfs.exists('/a/b')).toBe(true);
    expect(vfs.isDir('/a')).toBe(true);
  });

  it('读不存在的文件报 ENOENT，读目录报 EISDIR', () => {
    const vfs = createVfs();
    vfs.mkdirp('/etc');
    expect(() => vfs.readFile('/nope')).toThrow(VfsError);
    expect(() => vfs.readFile('/etc')).toThrow(/Is a directory/);
  });

  it('非空目录要 recursive 才能删', () => {
    const vfs = createVfs();
    vfs.writeFile('/data/a.txt', 'a');
    expect(() => vfs.remove('/data')).toThrow(/Directory not empty/);
    vfs.remove('/data', { recursive: true });
    expect(vfs.exists('/data')).toBe(false);
    expect(vfs.exists('/data/a.txt')).toBe(false);
  });

  it('改名会把整棵子树搬走', () => {
    const vfs = createVfs();
    vfs.writeFile('/src/deep/a.txt', 'a');
    vfs.rename('/src', '/dst');
    expect(vfs.readFile('/dst/deep/a.txt')).toBe('a');
    expect(vfs.exists('/src/deep/a.txt')).toBe(false);
  });

  it('快照与还原是等价的', () => {
    const vfs = createVfs(() => 42);
    vfs.writeFile('/a.txt', 'one');
    vfs.mkdirp('/b');
    const snapshot = vfs.snapshot();
    vfs.writeFile('/a.txt', 'two');
    vfs.remove('/b');

    const restored = createVfs();
    restored.restore(snapshot);
    expect(restored.readFile('/a.txt')).toBe('one');
    expect(restored.isDir('/b')).toBe(true);
    expect(JSON.stringify(restored.snapshot())).toBe(JSON.stringify(snapshot));
  });

  it('walk 只给文件，walkAll 连目录一起给，都按路径排序', () => {
    const vfs = createVfs();
    vfs.writeFile('/x/b.txt', '');
    vfs.writeFile('/x/a.txt', '');
    expect(vfs.walk('/x')).toEqual(['/x/a.txt', '/x/b.txt']);
    expect(vfs.walkAll('/x')).toEqual(['/x', '/x/a.txt', '/x/b.txt']);
  });
});

describe('shell 解析', () => {
  it('管道尾部的重定向不会丢', async () => {
    const node = await parseShell('ls | grep a > out.txt');
    expect(node?.type).toBe('pipeline');
    const pipeline = node as Extract<typeof node, { type: 'pipeline' }>;
    expect(pipeline.commands[1].type).toBe('redirected');
  });

  it('`[ -f x ]` 翻成 test 命令而不是被丢掉', async () => {
    const node = await parseShell('[ -f /etc/hosts ]');
    expect(node).toMatchObject({ type: 'command' });
    const command = node as Extract<typeof node, { type: 'command' }>;
    expect(command.words[0].parts[0]).toEqual({ kind: 'literal', text: 'test' });
    expect(command.words).toHaveLength(3);
  });

  it('语法错误抛 ShellSyntaxError', async () => {
    await expect(parseShell('if [ -f a ]; then')).rejects.toBeInstanceOf(ShellSyntaxError);
  });

  it('C 风格 for 明确报不支持，而不是装作跑了', async () => {
    await expect(parseShell('for ((i=0;i<3;i++)); do echo $i; done')).rejects.toThrow(/not supported/);
  });
});

describe('shell 执行', () => {
  let machine: Machine;
  beforeEach(() => {
    machine = createMachine({
      files: {
        '/root/a.txt': 'alpha\nbravo\ncharlie\n',
        '/root/b.txt': 'bravo\n',
        '/root/data/one.yaml': 'kind: One\n',
        '/root/data/two.yaml': 'kind: Two\n',
        '/root/data/note.md': 'note\n',
      },
    });
  });

  it('跑一条最简单的命令', async () => {
    expect(await sh(machine, 'echo hello')).toBe('hello\n');
    expect(await sh(machine, 'pwd')).toBe('/root\n');
  });

  it('未知命令的报错与退出码跟 bash 一样', async () => {
    const result = await machine.exec('nosuchcmd');
    expect(result.code).toBe(127);
    expect(result.stderr).toBe('bash: nosuchcmd: command not found\n');
  });

  it('管道一段段传下去', async () => {
    expect(await sh(machine, 'cat a.txt | grep bravo')).toBe('bravo\n');
    expect(await sh(machine, 'cat a.txt | grep -v bravo | wc -l')).toBe('2\n');
  });

  it('&& 与 || 看退出码', async () => {
    expect(await sh(machine, 'true && echo yes')).toBe('yes\n');
    expect((await machine.exec('false && echo yes')).stdout).toBe('');
    expect(await sh(machine, 'false || echo fallback')).toBe('fallback\n');
    expect(await sh(machine, 'true || echo skipped')).toBe('');
  });

  it('$? 是上一条命令的退出码', async () => {
    await machine.exec('false');
    expect(await sh(machine, 'echo $?')).toBe('1\n');
    await machine.exec('true');
    expect(await sh(machine, 'echo $?')).toBe('0\n');
  });

  it('grep 没匹配上退出码是 1', async () => {
    const result = await machine.exec('grep zzz a.txt');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('重定向写文件，>> 追加', async () => {
    await sh(machine, 'echo one > out.txt');
    await sh(machine, 'echo two >> out.txt');
    expect(machine.vfs.readFile('/root/out.txt')).toBe('one\ntwo\n');
    expect(await sh(machine, 'cat < out.txt')).toBe('one\ntwo\n');
  });

  it('`> f` 即使没有输出也会把文件建出来', async () => {
    await machine.exec('grep zzz a.txt > empty.txt');
    expect(machine.vfs.exists('/root/empty.txt')).toBe(true);
    expect(machine.vfs.readFile('/root/empty.txt')).toBe('');
  });

  it('2> 与 2>&1 分得清 stdout 和 stderr', async () => {
    const dropped = await machine.exec('nosuchcmd 2>/dev/null');
    expect(dropped.stderr).toBe('');

    await machine.exec('nosuchcmd 2> err.txt');
    expect(machine.vfs.readFile('/root/err.txt')).toBe('bash: nosuchcmd: command not found\n');

    await machine.exec('nosuchcmd > both.txt 2>&1');
    expect(machine.vfs.readFile('/root/both.txt')).toBe('bash: nosuchcmd: command not found\n');
  });

  it('heredoc 写文件，$VAR 会展开；带引号的 delimiter 不展开', async () => {
    await sh(machine, 'export NS=prod');
    await sh(machine, 'cat > m.yaml <<EOF\nnamespace: $NS\nEOF');
    expect(machine.vfs.readFile('/root/m.yaml')).toBe('namespace: prod\n');

    await sh(machine, "cat > raw.yaml <<'EOF'\nnamespace: $NS\nEOF");
    expect(machine.vfs.readFile('/root/raw.yaml')).toBe('namespace: $NS\n');
  });

  it('变量展开的各种写法', async () => {
    await sh(machine, 'X=hello');
    expect(await sh(machine, 'echo $X ${X} "${X}"')).toBe('hello hello hello\n');
    expect(await sh(machine, 'echo ${#X}')).toBe('5\n');
    expect(await sh(machine, 'echo ${MISSING:-default}')).toBe('default\n');
    expect(await sh(machine, 'echo ${X:+set}')).toBe('set\n');
    await sh(machine, 'FILE=cluster.yaml');
    expect(await sh(machine, 'echo ${FILE%.yaml}')).toBe('cluster\n');
    expect(await sh(machine, 'echo ${FILE#clu}')).toBe('ster.yaml\n');
  });

  it('引号决定分词', async () => {
    await sh(machine, 'SPACED="a b"');
    // 未加引号的展开会分词，加了就不分
    expect(await sh(machine, 'echo $SPACED')).toBe('a b\n');
    expect(await sh(machine, 'wc -w <<EOF\n$SPACED\nEOF')).toBe('2\n');
    expect(await sh(machine, "echo 'literal $SPACED'")).toBe('literal $SPACED\n');
  });

  it('命令替换与算术展开', async () => {
    expect(await sh(machine, 'echo "lines: $(wc -l < a.txt)"')).toBe('lines: 3\n');
    expect(await sh(machine, 'echo $((2 + 3 * 4))')).toBe('14\n');
    await sh(machine, 'N=5');
    expect(await sh(machine, 'echo $((N * 2))')).toBe('10\n');
  });

  it('通配展开，匹配不到就原样保留', async () => {
    expect(await sh(machine, 'echo data/*.yaml')).toBe('data/one.yaml data/two.yaml\n');
    expect(await sh(machine, 'echo data/*.json')).toBe('data/*.json\n');
    expect(await sh(machine, 'cd data && echo *.yaml')).toBe('one.yaml two.yaml\n');
  });

  it('cd 会改工作目录，并且反映在提示符里', async () => {
    expect(machine.prompt()).toBe('root@jump-01:~# ');
    await sh(machine, 'cd data');
    expect(await sh(machine, 'pwd')).toBe('/root/data\n');
    expect(machine.prompt()).toBe('root@jump-01:~/data# ');
    const failed = await machine.exec('cd /nope');
    expect(failed.code).toBe(1);
    expect(failed.stderr).toBe('bash: cd: /nope: No such file or directory\n');
  });

  it('子 shell 里的 cd 不影响外面', async () => {
    expect(await sh(machine, '(cd /etc && pwd)')).toBe('/etc\n');
    expect(await sh(machine, 'pwd')).toBe('/root\n');
  });

  it('if / elif / else 走对分支', async () => {
    expect(await sh(machine, 'if [ -f a.txt ]; then echo found; else echo missing; fi')).toBe('found\n');
    expect(await sh(machine, 'if [ -f zz ]; then echo found; else echo missing; fi')).toBe('missing\n');
    expect(
      await sh(machine, 'if [ -f zz ]; then echo one; elif [ -d data ]; then echo two; else echo three; fi')
    ).toBe('two\n');
  });

  it('for 与 while', async () => {
    expect(await sh(machine, 'for f in a b c; do echo $f; done')).toBe('a\nb\nc\n');
    expect(await sh(machine, 'for f in data/*.yaml; do basename $f; done')).toBe('one.yaml\ntwo.yaml\n');
    expect(await sh(machine, 'i=0\nwhile [ $i -lt 3 ]; do echo $i; i=$((i + 1)); done')).toBe('0\n1\n2\n');
  });

  it('死循环会被拦住而不是把页面挂死', async () => {
    const result = await machine.exec('while true; do echo x > /dev/null; done');
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('bash: loop exceeded 10000 iterations, aborted\n');
  });

  it('循环上限可以调小，报错里写的是实际生效的那个数', async () => {
    const strict = createMachine({ maxLoopIterations: 5 });
    const result = await strict.exec('i=0\nwhile true; do i=$((i+1)); done\necho $i');
    expect(result.stderr).toBe('bash: loop exceeded 5 iterations, aborted\n');
  });

  it('case 按模式选分支', async () => {
    const script = 'x=prod\ncase "$x" in dev) echo D;; prod|stage) echo P;; *) echo other;; esac';
    expect(await sh(machine, script)).toBe('P\n');
    expect(await sh(machine, 'x=zzz\ncase "$x" in dev) echo D;; *) echo other;; esac')).toBe('other\n');
  });

  it('函数有位置参数，local 变量出了函数就没了', async () => {
    const script = [
      'greet() { local who=$1; echo "hi $who ($#)"; }',
      'who=outer',
      'greet world',
      'echo $who',
    ].join('\n');
    expect(await sh(machine, script)).toBe('hi world (1)\nouter\n');
  });

  it('return 只退出函数', async () => {
    const script = ['f() { return 3; }', 'f', 'echo after=$?'].join('\n');
    expect(await sh(machine, script)).toBe('after=3\n');
  });

  it('set -e 遇到失败就停', async () => {
    const result = await machine.exec('set -e\nfalse\necho unreachable');
    expect(result.stdout).toBe('');
    expect(result.code).toBe(1);
  });

  it('set -u 引用未定义变量会报错', async () => {
    const result = await machine.exec('set -u\necho $UNDEFINED_VAR');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unbound variable/);
  });

  it('set -o pipefail 让管道里的失败露出来', async () => {
    expect((await machine.exec('grep zzz a.txt | wc -l')).code).toBe(0);
    expect((await machine.exec('set -o pipefail\ngrep zzz a.txt | wc -l')).code).toBe(1);
  });

  it('! 取反管道的退出码', async () => {
    expect((await machine.exec('! grep zzz a.txt')).code).toBe(0);
    expect((await machine.exec('! grep bravo a.txt')).code).toBe(1);
  });

  it('前置赋值只对那一条命令可见', async () => {
    const echoEnv = { env: ({ env }: { env: Record<string, string> }) => ({ stdout: `${env.FOO ?? ''}\n` }) };
    machine.install('showfoo', echoEnv.env as never);
    expect(await sh(machine, 'FOO=once showfoo')).toBe('once\n');
    expect(await sh(machine, 'showfoo')).toBe('\n');
  });

  it('source 会在当前 shell 里跑脚本', async () => {
    machine.vfs.writeFile('/root/env.sh', 'export REGION=cn-north\n');
    await sh(machine, 'source env.sh');
    expect(await sh(machine, 'echo $REGION')).toBe('cn-north\n');
  });

  it('反斜杠转义', async () => {
    expect(await sh(machine, 'echo a\\ b')).toBe('a b\n');
    expect(await sh(machine, 'echo \\$HOME')).toBe('$HOME\n');
    expect(await sh(machine, 'echo "\\$HOME"')).toBe('$HOME\n');
  });
});

describe('coreutils', () => {
  let machine: Machine;
  beforeEach(() => {
    machine = createMachine({
      files: {
        '/root/nums.txt': '3\n1\n2\n1\n',
        '/root/pods.txt': 'web  Running\napi  Pending\ndb   Running\n',
        '/root/dir/x.yaml': 'x\n',
        '/root/dir/.hidden': 'h\n',
      },
    });
  });

  it('ls 默认不显示隐藏文件，-a 才显示', async () => {
    expect(await sh(machine, 'ls dir')).toBe('x.yaml\n');
    expect(await sh(machine, 'ls -a dir')).toBe('.hidden\nx.yaml\n');
  });

  it('ls 找不到路径时的报错与退出码', async () => {
    const result = await machine.exec('ls /nope');
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("ls: cannot access '/nope': No such file or directory\n");
  });

  it('head / tail / wc', async () => {
    expect(await sh(machine, 'head -n 2 nums.txt')).toBe('3\n1\n');
    expect(await sh(machine, 'tail -n 2 nums.txt')).toBe('2\n1\n');
    expect(await sh(machine, 'wc -l nums.txt')).toBe('4\n');
  });

  it('sort / uniq / cut / tr', async () => {
    expect(await sh(machine, 'sort -n nums.txt')).toBe('1\n1\n2\n3\n');
    expect(await sh(machine, 'sort -n nums.txt | uniq')).toBe('1\n2\n3\n');
    expect(await sh(machine, 'sort -n nums.txt | uniq -c | tr -s " " " " | head -n 1')).toContain('1');
    expect(await sh(machine, 'cut -d " " -f 1 pods.txt')).toBe('web\napi\ndb\n');
  });

  it('grep -c 与 -i', async () => {
    expect(await sh(machine, 'grep -c Running pods.txt')).toBe('2\n');
    expect(await sh(machine, 'grep -i RUNNING pods.txt | wc -l')).toBe('2\n');
  });

  it('mkdir / rm / cp / mv', async () => {
    await sh(machine, 'mkdir -p deep/a/b');
    expect(machine.vfs.isDir('/root/deep/a/b')).toBe(true);
    await sh(machine, 'cp nums.txt copy.txt');
    expect(machine.vfs.readFile('/root/copy.txt')).toBe('3\n1\n2\n1\n');
    await sh(machine, 'mv copy.txt moved.txt');
    expect(machine.vfs.exists('/root/copy.txt')).toBe(false);
    const failed = await machine.exec('rm dir');
    expect(failed.stderr).toBe("rm: cannot remove 'dir': Is a directory\n");
    await sh(machine, 'rm -r dir');
    expect(machine.vfs.exists('/root/dir')).toBe(false);
  });

  it('find -name', async () => {
    expect(await sh(machine, 'find /root/dir -name "*.yaml"')).toBe('/root/dir/x.yaml\n');
  });

  it('tee 既写文件也往下游传', async () => {
    expect(await sh(machine, 'echo hi | tee saved.txt')).toBe('hi\n');
    expect(machine.vfs.readFile('/root/saved.txt')).toBe('hi\n');
  });

  it('sed 支持 s/// 与 Nd，其余明确报不支持', async () => {
    expect(await sh(machine, 'echo aaa | sed s/a/b/')).toBe('baa\n');
    expect(await sh(machine, 'echo aaa | sed s/a/b/g')).toBe('bbb\n');
    expect(await sh(machine, 'sed 2d nums.txt')).toBe('3\n2\n1\n');
    const unsupported = await machine.exec('sed y/a/b/ nums.txt');
    expect(unsupported.code).toBe(2);
    expect(unsupported.stderr).toMatch(/unsupported script/);
  });

  it('which 只认装了的命令', async () => {
    expect(await sh(machine, 'which grep')).toBe('/usr/bin/grep\n');
    expect((await machine.exec('which kubectl')).code).toBe(1);
  });
});

describe('机器', () => {
  it('装上的命令能拿到 argv、stdin 与 cwd', async () => {
    const machine = createMachine();
    machine.install('kubectl', ({ argv, stdin, cwd }) => ({
      stdout: `argv=${argv.join(',')} stdin=${stdin.trim()} cwd=${cwd}\n`,
    }));
    machine.vfs.mkdirp('/root/work');
    const result = await machine.exec('cd work && echo body | kubectl apply -f -');
    expect(result.stdout).toBe('argv=apply,-f,- stdin=body cwd=/root/work\n');
  });

  it('操作记录留下命令、退出码与当时的目录', async () => {
    const machine = createMachine();
    await machine.exec('echo one');
    await machine.exec('false');
    const transcript = machine.transcript();
    expect(transcript.map((r) => [r.command, r.code])).toEqual([['echo one', 0], ['false', 1]]);
    expect(transcript[0].cwd).toBe('/root');
    expect(machine.history).toEqual(['echo one', 'false']);
  });

  it('快照能把机器整台还原回去，连变量和函数一起', async () => {
    const machine = createMachine();
    await machine.exec('echo before > f.txt');
    const snapshot = machine.snapshot();
    await machine.exec('echo after > f.txt');
    await machine.exec('cd /etc');
    await machine.exec('LEFTOVER=1');
    await machine.exec('leftover() { echo nope; }');

    machine.restore(snapshot);
    expect(machine.vfs.readFile('/root/f.txt')).toBe('before\n');
    expect(machine.cwd).toBe('/root');
    expect((await machine.exec('echo "[$LEFTOVER]"')).stdout).toBe('[]\n');
    expect((await machine.exec('leftover')).code).toBe(127);
  });

  it('同样的脚本跑两遍，输出逐字节相同', async () => {
    const script = [
      'mkdir -p /work/manifests',
      'for n in api web db; do echo "name: $n" > /work/manifests/$n.yaml; done',
      'ls /work/manifests | sort',
      'grep -h name /work/manifests/*.yaml | sort | uniq -c',
      'echo done=$?',
    ].join('\n');

    const run = async () => {
      const machine = createMachine({ now: () => 1_700_000_000_000 });
      const result = await machine.exec(script);
      return JSON.stringify({ ...result, files: machine.vfs.toFileMap('/work') });
    };
    const [first, second] = [await run(), await run()];
    expect(first).toBe(second);
    expect(JSON.parse(first).code).toBe(0);
  });
});

describe('glob 匹配', () => {
  it.each([
    ['*.yaml', 'a.yaml', true],
    ['*.yaml', 'a.yml', false],
    ['a?c', 'abc', true],
    ['a?c', 'ac', false],
    ['[abc]x', 'bx', true],
    ['[abc]x', 'dx', false],
    ['*', 'anything', true],
    ['*', 'a/b', false],
  ])('%s vs %s', (pattern, value, expected) => {
    expect(matchesGlob(pattern, value)).toBe(expected);
  });
});

/**
 * 浏览器路径
 *
 * 解析器在浏览器里走的是另一条分支：fetch 一个 URL 拿语法文件，
 * 而不是从 node_modules 读。那条分支在 Node 测试里永远不会被执行，
 * 于是「路径写错了」「拷贝脚本没跑」这类问题要到真打开页面才发现。
 * 这里把 window / document / fetch 造出来，逼它走浏览器分支。
 */
describe('浏览器里的语法加载', () => {
  const PUBLIC_WASM = path.join(__dirname, '../../public/labkit/tree-sitter-bash.wasm');

  it('从 /labkit/tree-sitter-bash.wasm 取语法，取到的是能用的', async () => {
    expect(fs.existsSync(PUBLIC_WASM)).toBe(true);

    const requested: string[] = [];
    const globals = globalThis as Record<string, unknown>;
    const saved = { window: globals.window, document: globals.document, fetch: globals.fetch };

    globals.window = {};
    globals.document = {};
    globals.fetch = async (url: string) => {
      requested.push(url);
      const file = url === '/labkit/tree-sitter-bash.wasm'
        ? PUBLIC_WASM
        : path.join(__dirname, '../../node_modules/web-tree-sitter/web-tree-sitter.wasm');
      const bytes = fs.readFileSync(file);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    };

    resetShellParser();
    try {
      // 运行时 wasm 在 Node 下由 emscripten 自己定位，这里只验语法文件那一段
      const parser = await loadShellParser({ runtimeWasmUrl: undefined });
      expect(parser.parse('echo hi | wc -l').rootNode.hasError).toBe(false);
      expect(requested).toContain('/labkit/tree-sitter-bash.wasm');
    } finally {
      globals.window = saved.window;
      globals.document = saved.document;
      globals.fetch = saved.fetch;
      resetShellParser();
    }
  });
});

/**
 * `a && b > f` 只重定向 b
 *
 * 整段包起来的话，重定向的目标路径会在 a 跑之前就解析掉：
 * `cd sub && echo x > f` 把文件写到 cd 之前的目录里，命令全部成功，
 * 文件出现在错误的地方，一句报错都没有。
 */
describe('重定向挂在哪一段上', () => {
  it('cd 之后的重定向落在新目录里', async () => {
    const machine = createMachine({ files: {}, now: () => 0 });
    await machine.exec('mkdir -p /root/sub');
    const result = await machine.exec('cd /root/sub && echo hello > out.txt');
    expect(result.code).toBe(0);
    expect(machine.vfs.exists('/root/sub/out.txt')).toBe(true);
    expect(machine.vfs.exists('/root/out.txt')).toBe(false);
  });

  it('前一段失败时后一段不跑，文件也不该被建出来', async () => {
    const machine = createMachine({ files: {}, now: () => 0 });
    const result = await machine.exec('false && echo hello > /root/never.txt');
    expect(result.code).toBe(1);
    expect(machine.vfs.exists('/root/never.txt')).toBe(false);
  });
});

/**
 * `help` —— 终端的第一块路标
 *
 * 两个工作台的终端都是一个不给任何线索的黑框，而横幅在让人「先敲点什么」。
 * 少了 help，学员只能靠猜；而猜错的反馈是 `command not found`，
 * 那是最不给人方向的一句话。
 */
describe('help', () => {
  it('列出这台机器上装了的命令，装上去的也在里面', async () => {
    const machine = createMachine();
    machine.install('kubectl', async () => ({ stdout: '' }));

    const result = await machine.exec('help');

    expect(result.code).toBe(0);
    // 内建、coreutils、以及后装的命令都要出现
    expect(result.stdout).toContain('kubectl');
    expect(result.stdout).toContain('echo');
    expect(result.stdout).toContain('help');
    expect(result.stdout).toMatch(/装了 \d+ 条命令/);
  });

  it('按类别分栏，自带的命令带一句说明', async () => {
    const machine = createMachine();
    const result = await machine.exec('help');

    for (const title of ['shell 内建', '看文件', '文本处理']) {
      expect(result.stdout).toContain(title);
    }
    // 说明不是摆设：每条自带命令都该有一句
    expect(result.stdout).toContain('列目录');
    expect(result.stdout).toContain('按模式挑出行');
  });

  it('世界装工具时带的说明会出现在「这台机器上装的」那一栏', async () => {
    const machine = createMachine();
    machine.install('kubectl', async () => ({ stdout: '' }), '操作 Kubernetes 集群');

    const listed = await machine.exec('help');
    expect(listed.stdout).toContain('这台机器上装的');
    expect(listed.stdout).toContain('操作 Kubernetes 集群');

    // `help <命令>` 也读同一份说明
    const single = await machine.exec('help kubectl');
    expect(single.code).toBe(0);
    expect(single.stdout).toContain('操作 Kubernetes 集群');
  });

  it('help <命令> 认得出装过的和没装过的', async () => {
    const machine = createMachine();
    machine.install('helm', async () => ({ stdout: '' }));

    const known = await machine.exec('help helm');
    expect(known.code).toBe(0);
    expect(known.stdout).toContain('helm');

    const unknown = await machine.exec('help nosuchthing');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('nosuchthing');
  });

  it('输出能进管道 —— 它就是一条普通命令', async () => {
    const machine = createMachine();
    const result = await machine.exec('help | grep echo');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('echo');
  });
});
