/**
 * 产物体检那道闸门自己也要被测
 *
 * v0.16.0 发出去的包里，`new Terminal()` 一构造就抛
 * `Super constructor null of anonymous class is not a constructor` ——
 * SWC 压缩器把 xterm 里某个类的基类换成了 `null`，整个 ops 工作台的终端起不来。
 *
 * dev 不压缩，所以这类故障**只在正式构建里出现**，任何单元测试都照不到它。
 * 唯一的防线就是构建之后扫产物。而一道永远返回「没问题」的闸门比没有闸门更糟，
 * 所以这里拿真假两种产物各喂它一次。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspect } = require('../../scripts/check-bundle');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-bundle-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe('产物体检', () => {
  it('干净的产物：没有问题', () => {
    const dir = fixture({
      'a.js': 'var x=class s extends Error{constructor(n){super(n)}};',
      'nested/b.js': 'class Foo extends Bar {}',
    });
    const { files, problems } = inspect(dir);
    expect(files).toHaveLength(2);
    expect(problems).toEqual([]);
  });

  /** 这一条就是 v0.16.0 那个故障的形状 */
  it('基类被压缩器吃掉的产物：抓得出来', () => {
    const dir = fixture({
      'bad.js': 'var ev=class s extends null{constructor(n){super(n),this.name="X"}};',
    });
    const { problems } = inspect(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0].count).toBe(1);
    expect(problems[0].rule.what).toBe('class extends null');
  });

  it('同一个文件里多处也数得对', () => {
    const dir = fixture({
      'bad.js': 'a=class extends null{};b=class extends null{};c=class extends Error{};',
    });
    expect(inspect(dir).problems[0].count).toBe(2);
  });

  it('只看 .js，不管别的', () => {
    const dir = fixture({
      'x.js.map': '"extends null"',
      'y.css': 'extends null',
    });
    const { files, problems } = inspect(dir);
    expect(files).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('目录不存在时不抛，交给调用方处理', () => {
    const { files, problems } = inspect(path.join(os.tmpdir(), 'check-bundle-does-not-exist'));
    expect(files).toEqual([]);
    expect(problems).toEqual([]);
  });
});
