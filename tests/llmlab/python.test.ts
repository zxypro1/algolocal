/**
 * Python 运行时：离线、确定性、以及和 JS 之间的那条缝
 *
 * 这些用例查的都是「装错了也能跑起来，但会在别的地方要命」的东西：
 * 走了 CDN（断网就死）、hash 没钉死（BPE 不可复现）、
 * stdout 没接住（学员 print 了看不见）。
 *
 * **测试用的是 `public/llmlab/pyodide/` 里那份拷贝，不是 node_modules 里的原件。**
 * 验的就是打包链路那一头 —— 拷贝脚本漏了文件、或者拷坏了，这里立刻红。
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadPythonRuntime, type PythonRuntime } from '../../src/lib/llmlab/python/runtime';

const ROOT = join(__dirname, '..', '..');
const INDEX_URL = join(ROOT, 'public', 'llmlab', 'pyodide') + '/';

let py: PythonRuntime;

beforeAll(async () => {
  py = await loadPythonRuntime({ indexURL: INDEX_URL });
}, 120_000);

describe('资产', () => {
  it('五个运行时文件都在 public/llmlab/pyodide/ 下', () => {
    for (const name of [
      'pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm',
      'python_stdlib.zip', 'pyodide-lock.json',
    ]) {
      expect(existsSync(join(ROOT, 'public', 'llmlab', 'pyodide', name))).toBe(true);
    }
  });

  /*
   * 代码级禁令。这是 design/llmlab-stack.md 里那三条硬约束的第一条 ——
   * 与其在文档里写「别调 loadPackage」，不如让写了就红。
   */
  it('llmlab 的代码里没有 loadPackage，也没有任何 CDN 字面量', () => {
    const files = [
      'src/lib/llmlab/python/runtime.ts',
      'scripts/copy-lab-assets.js',
    ];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      // 注释里提到这些词是好事（说明写清了为什么不能用），所以只扫代码行
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|#)/.test(line))
        .join('\n');
      expect(code).not.toMatch(/\.loadPackage\s*\(/);
      expect(code).not.toContain('cdn.jsdelivr.net');
      expect(code).not.toContain('pyodide.org/v');
    }
  });
});

describe('装配', () => {
  it('起得来，而且能算数', () => {
    expect(py.run('1 + 1')).toBe(2);
  });

  it('indexURL 是必填的 —— 不给默认值就是不给走 CDN 的机会', async () => {
    await expect(loadPythonRuntime({ indexURL: '' })).rejects.toThrow(/需要 indexURL/);
  });

  it('标准库在，不需要额外装包', () => {
    expect(py.run('import json; json.dumps({"a": [1, 2]})')).toBe('{"a": [1, 2]}');
    expect(py.run('import re; bool(re.match(r"^ab+$", "abbb"))')).toBe(true);
    expect(py.run('from dataclasses import dataclass; 1')).toBe(1);
    // BPE 那一关要用的
    expect(py.run('from collections import Counter; Counter("aab")["a"]')).toBe(2);
  });

  it('numpy 装不上 —— 我们本来就不要它，而且不许它去 CDN 找', () => {
    expect(() => py.run('import numpy')).toThrow(/ModuleNotFoundError|No module named/);
  });
});

describe('确定性', () => {
  /*
   * 硬约束 3。hash 随机化的表现极其阴险：同一份代码同一份输入，
   * 两次跑出不同的 merge 顺序，而两次**都是对的**（只是不同）。
   * 学员会以为自己的实现有 bug，而实际上是运行时不确定。
   */
  it('PYTHONHASHSEED 钉死了：字符串的 hash 每次一样', () => {
    const a = py.run('hash("llmlab")');
    const b = py.run('hash("llmlab")');
    expect(a).toBe(b);
    expect(typeof a).toBe('number');
  });

  /*
   * 一律经过 json.dumps 再比。
   *
   * `run()` 返回的是 Pyodide 的原始值 —— 容器类型是 PyProxy，不是 JS 数组。
   * 直接 toEqual 两个 PyProxy 比的是代理对象的内部结构（里面还有个 `ptr`），
   * 这一版第一次写就在这里被咬了一口：两个内容相同的 list 因为 ptr 不同而不相等。
   * 比字符串没有这个歧义。
   */
  it('集合的迭代顺序可复现', () => {
    const code = 'import json; json.dumps(list({"pear", "apple", "fig", "kiwi", "plum"}))';
    expect(py.run(code)).toBe(py.run(code));
  });

  /*
   * **这条才是真正验 PYTHONHASHSEED 的那一条**，上面那条只验了同一个解释器内一致
   * （而那件事不设 seed 也成立）。
   *
   * 拿掉 env 之后实测过一次：两个独立实例给出 -1495200212 与 1155841173，
   * 设上之后两边都是 -1455936053。所以这条用例不是空转的 —— 去掉那个环境变量它就红。
   */
  it('换一个实例，同一段代码给同一个答案', async () => {
    const other = await loadPythonRuntime({ indexURL: INDEX_URL });
    const code =
      'import json; json.dumps(sorted({"pear", "apple", "fig"}, key=lambda s: (hash(s) % 97, s)))';
    expect(other.run(code)).toBe(py.run(code));
  }, 120_000);

  it('random 被 seed 过', () => {
    const code =
      'import random, json; random.seed(0); json.dumps([random.random() for _ in range(3)])';
    expect(py.run(code)).toBe(py.run(code));
  });
});

describe('输入输出', () => {
  it('print 出来的东西接得住', () => {
    py.drainOutput();
    py.run('print("你好"); print("world")');
    const { stdout } = py.drainOutput();
    expect(stdout).toContain('你好');
    expect(stdout).toContain('world');
  });

  it('drain 之后就清空了', () => {
    py.run('print("一次")');
    py.drainOutput();
    py.run('pass');
    expect(py.drainOutput().stdout).toBe('');
  });

  it('异常带得出 Python 的报错文本', () => {
    expect(() => py.run('def f():\n  raise ValueError("学员自己的错")\nf()'))
      .toThrow(/学员自己的错/);
  });

  it('虚拟文件系统能读能写 —— nanotorch 与学员的脚本都从这里进去', () => {
    py.writeFile('/lab/hello.py', 'VALUE = 42\n');
    expect(py.readFile('/lab/hello.py')).toContain('VALUE = 42');
    py.run('import sys; sys.path.insert(0, "/lab")');
    expect(py.run('import hello; hello.VALUE')).toBe(42);
  });

  /*
   * 非 ASCII 要能原样往返。nanotorch 的注释与关卡的报错都是中文，
   * 写进去变成乱码的话，学员看到的每一条提示都是坏的 —— 而这件事
   * 只有真的塞一个中文字符串进去才验得出来。
   */
  it('UTF-8 往返不丢字', () => {
    const text = '# 这一关要自己实现注意力\nMSG = "形状对不上：期望 (B, T, C)"\n';
    py.writeFile('/lab/zh.py', text);
    expect(py.readFile('/lab/zh.py')).toBe(text);
    expect(py.run('import zh; zh.MSG')).toBe('形状对不上：期望 (B, T, C)');
  });
});

describe('和 JS 之间的那条缝', () => {
  /*
   * 算子桥就走这条：Python 侧只拿张量的 id（整数），
   * 真正的数留在 wasm 内存里。所以每次调用的开销直接决定这条路可不可行。
   * 原型实测 1.47 µs / 次，一步训练约 150 次调用 ⇒ 0.22ms，可忽略。
   */
  it('能调到 JS 的函数', () => {
    let seen: number[] = [];
    py.setGlobal('js_add', (a: number, b: number) => { seen.push(a + b); return a + b; });
    expect(py.run('js_add(3, 4)')).toBe(7);
    expect(seen).toEqual([7]);
  });

  it('单次调用开销在微秒量级 —— 一步训练几百次调用可以忽略', () => {
    py.setGlobal('js_noop', (a: number) => a);
    const n = 20000;
    const t0 = Date.now();
    py.run(`for _ in range(${n}): js_noop(1)`);
    const perCall = ((Date.now() - t0) * 1000) / n;
    console.log(`  Python → JS 每次调用 ${perCall.toFixed(2)} µs`);
    // 松一点：机器不同数不同，这里只要确认它不是毫秒量级
    expect(perCall).toBeLessThan(50);
  });

  it('纯 Python 的循环很慢 —— 这不是缺陷，是必须让学员知道的事实', () => {
    /*
     * 实测约 15.8 MFLOP/s，比 JS 慢约 300 倍。
     * 所以学员的代码必须向量化 —— 而**现实里也是这条规矩**，
     * 没有人在 PyTorch 里逐元素写 for 循环。
     * 这条用例把这个事实钉在这儿，免得将来有人「优化」出一个逐元素的 API。
     */
    const t0 = Date.now();
    py.run(`
n = 40
A = [[(i * j) % 7 * 0.1 for j in range(n)] for i in range(n)]
B = [[(i + j) % 5 * 0.1 for j in range(n)] for i in range(n)]
C = [[0.0] * n for _ in range(n)]
for i in range(n):
    Ai = A[i]; Ci = C[i]
    for k in range(n):
        a = Ai[k]; Bk = B[k]
        for j in range(n):
            Ci[j] += a * Bk[j]
`);
    const ms = Date.now() - t0;
    const mflops = (2 * 40 ** 3) / 1e6 / (ms / 1000);
    console.log(`  纯 Python 40³ matmul: ${ms}ms → ${mflops.toFixed(1)} MFLOP/s`);
    expect(mflops).toBeLessThan(500);   // 确认它确实慢，别指望学员在这里写循环
  });
});
