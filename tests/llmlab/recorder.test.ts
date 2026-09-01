/**
 * 训练日志：从 Python 写进去，面板从 JS 读出来
 *
 * 面板本身（图长得好不好看）不好测，但**数据流通不通**是能测的：
 * 学员在 Python 里调 `nt.log.step(...)`，JS 侧的 `rt.log.view()` 就要看得到。
 * 这条缝断了的表现是「训练在跑，面板永远空着」—— 学员会以为是自己的代码问题。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRuntime, histogramOf, TrainingLog, type Runtime } from '../../src/lib/llmlab/bridge';
import { createTrainSession, type TrainSession } from '../../src/lib/llmlab/python';

const ROOT = join(__dirname, '..', '..');
const WASM = readFileSync(join(ROOT, 'public', 'llmlab', 'llmlab-kernels.wasm'));
const INDEX_URL = join(ROOT, 'public', 'llmlab', 'pyodide') + '/';

describe('TrainingLog 本身', () => {
  it('曲线超上限时按步数抽稀，保住首尾', () => {
    const log = new TrainingLog();
    for (let i = 1; i <= 9000; i++) log.step({ step: i, loss: i });
    const view = log.view();
    expect(view.steps.length).toBeLessThanOrEqual(4000);
    // 首尾必须还在：抽稀是为了省内存，不是为了丢掉结论
    expect(view.steps[0].step).toBe(1);
    expect(view.steps[view.steps.length - 1].step).toBe(9000);
  });

  it('样例超上限时丢最老的 —— 和曲线相反', () => {
    const log = new TrainingLog();
    for (let i = 0; i < 300; i++) log.sample({ text: `第 ${i} 条`, step: i });
    const view = log.view();
    expect(view.samples.length).toBe(200);
    // 新的才是学员想看的
    expect(view.samples[view.samples.length - 1].text).toBe('第 299 条');
  });

  it('直方图：桶数固定、统计量对得上', () => {
    const values = Float64Array.from({ length: 1000 }, (_, i) => (i % 100) / 10);
    const h = histogramOf(values, 'x', 1);
    expect(h.counts).toHaveLength(32);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(h.min).toBeCloseTo(0, 10);
    expect(h.max).toBeCloseTo(9.9, 10);
    expect(h.mean).toBeCloseTo(4.95, 6);
  });

  it('非有限值不进统计，也不炸', () => {
    const h = histogramOf([1, 2, NaN, Infinity, 3], 'x', 0);
    expect(h.mean).toBeCloseTo(2, 10);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe('从 Python 写到 JS', () => {
  let rt: Runtime;
  let session: TrainSession;

  beforeAll(async () => {
    rt = createRuntime(WASM);
    session = await createTrainSession(rt, { indexURL: INDEX_URL });
  }, 180_000);

  it('nt.log.step 写进来的东西，JS 侧读得到', () => {
    rt.log.clear();
    session.py.run(`
import nanotorch as nt
for s in range(1, 6):
    nt.log.step(s, loss=3.0 - s * 0.2, lr=1e-3, grad_norm=0.5 + s, tokens=256)
`);
    const view = rt.log.view();
    expect(view.steps).toHaveLength(5);
    expect(view.steps[0].loss).toBeCloseTo(2.8, 10);
    expect(view.steps[4].gradNorm).toBeCloseTo(5.5, 10);
    expect(view.steps[4].tokens).toBe(256);
  });

  it('自定义曲线与结构化报告', () => {
    rt.log.clear();
    session.py.run(`
import nanotorch as nt
nt.log.scalar("perplexity", 10, 12.5)
nt.log.scalar("perplexity", 20, 9.25)
nt.log.report("eval", {"accuracy": 0.83, "n": 120})
`);
    const view = rt.log.view();
    expect(view.scalars.perplexity).toHaveLength(2);
    expect(view.scalars.perplexity[1].value).toBeCloseTo(9.25, 10);
    expect(view.reported.eval).toEqual({ accuracy: 0.83, n: 120 });
  });

  it('生成样例带 logprob，面板按它着色', () => {
    rt.log.clear();
    session.py.run(`
import nanotorch as nt
nt.log.sample("hello", step=3, group="pretrain", logprobs=[-0.1, -2.0, -0.3, -0.05, -4.0])
`);
    const s = rt.log.view().samples[0];
    expect(s.text).toBe('hello');
    expect(s.group).toBe('pretrain');
    expect(s.logprobs).toHaveLength(5);
    expect(s.logprobs[4]).toBeCloseTo(-4, 10);
  });

  /*
   * 注意力热图：只搬 (batch=0, layer, head) 那一片。
   * 整块 [B,H,S,S] 搬过来是几十万个数，而面板一次只画一张图。
   */
  it('注意力热图只搬一片，而且搬对了那一片', () => {
    rt.log.clear();
    const B = 2, H = 2, S = 4;
    const probs = rt.arena.zeros([B * H * S * S], 'f32', 'data', 'probs');
    const view = rt.arena.view(probs);
    // 给每个 (b,h) 一个能认出来的常数
    for (let b = 0; b < B; b++)
      for (let h = 0; h < H; h++)
        for (let i = 0; i < S * S; i++) view[((b * H + h) * S * S) + i] = b * 10 + h;

    session.py.setGlobal('probs_handle', probs.id);
    session.py.run(`
import nanotorch as nt
from nanotorch import Tensor
t = Tensor((${B}, ${H}, ${S}, ${S}), handle=probs_handle)
nt.log.attention(t, ${B}, ${H}, ${S}, step=7, layer=1, head=1)
`);
    const snap = rt.log.view().attention[0];
    expect(snap.step).toBe(7);
    expect(snap.layer).toBe(1);
    expect(snap.head).toBe(1);
    expect(snap.probs).toHaveLength(S * S);
    // batch=0、head=1 → 常数应该是 0*10 + 1 = 1
    expect(snap.probs.every((v) => v === 1)).toBe(true);
  });

  it('直方图从张量算出来', () => {
    rt.log.clear();
    const t = rt.arena.zeros([256], 'f32', 'data', 'w');
    const view = rt.arena.view(t);
    for (let i = 0; i < 256; i++) view[i] = (i - 128) / 64;
    session.py.setGlobal('h_handle', t.id);
    session.py.run(`
import nanotorch as nt
from nanotorch import Tensor
nt.log.histogram(Tensor((256,), handle=h_handle), "weights/wq", step=2)
`);
    const h = rt.log.view().histograms[0];
    expect(h.name).toBe('weights/wq');
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(256);
    expect(h.mean).toBeCloseTo(-0.0078125, 6);
  });

  it('clear 之后面板会空掉 —— 换一次运行不该把两次曲线接在一起', () => {
    session.py.run('import nanotorch as nt; nt.log.step(1, loss=1.0); nt.log.clear()');
    expect(rt.log.view().steps).toHaveLength(0);
  });
});

/**
 * 面板的投影：身份必须跟着内容走
 *
 * 面板的 `useMemo` 挂在 `[log.steps, revision]` 上。以前 `view()` 直接把
 * 内部那个数组交出去，而它是原地 `push` 的 —— 记了两百步之后引用还是同一个，
 * memo 不重算，曲线一条都画不出来。
 *
 * v0.19.0 的实装验收里就是这个症状：头部徽章写着「200 步」
 * （它每次渲染直接读 `.length`），训练面板同时写着「还没有训练记录」。
 * **同一份数据，两个地方给出相反的结论。**
 */
describe('view() 的身份', () => {
  it('记了新的一步之后，steps 必须是一个新的引用', () => {
    const log = new TrainingLog();
    log.step({ step: 1, loss: 2.0 });
    const before = log.view();

    log.step({ step: 2, loss: 1.5 });
    const after = log.view();

    expect(after.steps).not.toBe(before.steps);
    expect(before.steps).toHaveLength(1);
    expect(after.steps).toHaveLength(2);
    // 拿到手的那份不该被后来的写入改掉
    expect(before.steps.map((s) => s.step)).toEqual([1]);
  });

  it('什么都没记的时候返回同一个对象 —— memo 还是要省得下来的', () => {
    const log = new TrainingLog();
    log.step({ step: 1, loss: 2.0 });
    expect(log.view()).toBe(log.view());
  });

  it('scalars / samples 也一样', () => {
    const log = new TrainingLog();
    log.scalar('ppl', 1, 10);
    const before = log.view();
    log.scalar('ppl', 2, 9);
    expect(log.view().scalars.ppl).not.toBe(before.scalars.ppl);
    expect(before.scalars.ppl).toHaveLength(1);
  });
});
