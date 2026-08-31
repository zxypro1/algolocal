/**
 * 竖切：一份学员写的 Python → Pyodide → nanotorch → wasm 算子核 → 真训练
 *
 * **这是第一段的完成标准。** design/llmlab.md 第十三节把它写成了硬要求：
 * 这一段完成的判据是「竖切跑通」，不是「组件写完」。
 *
 * 所以这个文件里的用例不是在测某个模块，而是在回答一个问题：
 * **一个人写一段 PyTorch 形状的 Python，能不能在浏览器里把 loss 训下去，
 * 而且平台能不能据此判他过没过。**
 *
 * 那段 Python 就在下面，是完整的、没有删节的 —— 它长什么样，
 * 学员在第 16 关要写的就是什么样。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createRuntime, type Runtime } from '../../src/lib/llmlab/bridge';
import {
  createTrainSession, installNanotorch, loadPythonRuntime,
  NANOTORCH_HASH, type TrainSession,
} from '../../src/lib/llmlab/python';

const ROOT = join(__dirname, '..', '..');
const WASM = readFileSync(join(ROOT, 'public', 'llmlab', 'llmlab-kernels.wasm'));
const INDEX_URL = join(ROOT, 'public', 'llmlab', 'pyodide') + '/';

/**
 * 学员那一份。
 *
 * 归纳任务：序列前半随机、后半照抄。后半段每个位置都能靠「往回看半个序列」
 * 精确预测，而 bigram 原理上做不到 —— **loss 掉下来只可能来自注意力真的在工作**。
 */
const TRAIN_PY = `
import nanotorch as nt
from nanotorch import nn, optim

VOCAB, SEQ, BATCH = 16, 16, 16
DIM, N_LAYER, N_HEAD, N_KV_HEAD, HIDDEN = 64, 2, 4, 2, 128
STEPS = 800


class Block(nn.Module):
    def __init__(self, seed):
        super().__init__()
        self.norm1 = nn.RMSNorm(DIM, name="norm1")
        self.attn = nn.CausalSelfAttention(DIM, N_HEAD, N_KV_HEAD, seed, N_LAYER)
        self.norm2 = nn.RMSNorm(DIM, name="norm2")
        self.mlp = nn.SwiGLUMLP(DIM, HIDDEN, seed + 10, N_LAYER)

    def forward(self, x, cos, sin, b, s):
        # pre-norm 残差：norm 在分支里面，主干上是纯加法
        x = x + self.attn(self.norm1(x), cos, sin, b, s)
        return x + self.mlp(self.norm2(x))


class Model(nn.Module):
    def __init__(self):
        super().__init__()
        self.emb = nn.Embedding(VOCAB, DIM, seed=1, name="emb")
        self.blocks = [Block(100 + 50 * i) for i in range(N_LAYER)]
        for i, blk in enumerate(self.blocks):
            setattr(self, "block%d" % i, blk)
        self.normf = nn.RMSNorm(DIM, name="normf")
        # RoPE 的表只跟位置和头维有关，整个训练里算一次
        self.cos, self.sin = nt.F.rope_tables(SEQ, DIM // N_HEAD)

    def forward(self, idx, targets, batch):
        rows = batch * SEQ
        nt.phase("forward")
        nt.add_tokens(rows)
        x = self.emb(idx, rows)
        for blk in self.blocks:
            x = blk(x, self.cos, self.sin, batch, SEQ)
        x = self.normf(x)
        logits = nn.tied_head(self.emb, x, rows)
        loss = nt.functional.cross_entropy(logits, targets, rows, VOCAB)
        nt.phase("other")
        return loss


def make_batch(seed):
    """前半随机、后半照抄。bigram 做不到这件事。"""
    s = seed & 0xFFFFFFFF
    def nxt():
        nonlocal s
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        return s
    half = SEQ // 2
    idx, tgt = [], []
    for _ in range(BATCH):
        row = [nxt() % VOCAB for _ in range(half)]
        row = row + row + [row[0]]
        idx.extend(row[:SEQ])
        tgt.extend(row[1:SEQ + 1])
    return idx, tgt


model = Model()
opt = optim.AdamW(model.parameters(), lr=3e-3, betas=(0.9, 0.95), weight_decay=0.1)
print("参数量", model.num_parameters())

# role="data"：这两块每步复写，但不该被 release 推平
idx_t = nt.zeros((BATCH * SEQ,), role="data", name="idx")
tgt_t = nt.zeros((BATCH * SEQ,), role="data", name="tgt")

history = []
# 到这里为止分配的都是长期的：参数、梯度、优化器状态、RoPE 表、输入缓冲。
# 之后每步产生的都是激活，一把推平。
base = nt.mark()
for step in range(1, STEPS + 1):
    nt.release(base)
    idx, tgt = make_batch(1000 + step)
    idx_t.set_int_(idx)
    tgt_t.set_int_(tgt)

    model.zero_grad()
    loss = model(idx_t, tgt_t, BATCH)
    loss.backward()
    opt.step(lr=optim.cosine_with_warmup(step, STEPS, 3e-3))
    history.append(loss.value)

first = sum(history[:5]) / 5
last = sum(history[-10:]) / 10
print("loss %.4f -> %.4f" % (first, last))
RESULT = {"first": first, "last": last, "params": model.num_parameters(), "steps": STEPS}
`;

describe('生成物的新鲜度', () => {
  /*
   * 「改了 .py 忘了重新生成」的表现是：代码看着是新的、跑的是旧的，
   * 而且不报任何错。和算子核那个 .wasm 是同一类问题，同一类防线。
   */
  it('sources.generated.ts 和 nanotorch/*.py 一致', () => {
    expect(() =>
      execFileSync('node', ['scripts/build-nanotorch.js', '--check'], { cwd: ROOT })
    ).not.toThrow();
  });

  it('指纹是六个源文件算出来的', () => {
    expect(NANOTORCH_HASH).toHaveLength(16);
  });
});

describe('装配', () => {
  let rt: Runtime;
  let session: TrainSession;

  beforeAll(async () => {
    rt = createRuntime(WASM);
    session = await createTrainSession(rt, { indexURL: INDEX_URL });
  }, 180_000);

  it('import nanotorch 起得来', () => {
    expect(session.py.run('import nanotorch as nt; nt.__version__')).toBe('0.1.0');
  });

  it('张量的形状与元素数对得上', () => {
    expect(session.py.run(`
import nanotorch as nt
t = nt.zeros((3, 4))
[t.numel, t.dim(), list(t.shape)][0]
`)).toBe(12);
  });

  it('Module 收得到参数，而且顺序是稳的', () => {
    const names = session.py.run(`
import json
import nanotorch as nt
from nanotorch import nn
m = nn.SwiGLUMLP(8, 16, seed=1)
json.dumps([n for n, _ in m.named_parameters()])
`);
    expect(names).toBe('["wg.weight", "wu.weight", "wd.weight"]');
  });

  /*
   * `ModuleList` / `ParameterList` 存在的理由，和 PyTorch 里一模一样：
   * **放进普通 list 的子模块不会被登记**，于是 `parameters()` 数不到它们。
   * 表现是模型看着建好了、前向也跑得通，而优化器一个参数都没更新 ——
   * 不报任何异常，只是 loss 一动不动。
   *
   * 这一条把「登记了」和「没登记」两种写法并排跑，差别是 0 和 3。
   */
  it('ModuleList 会登记子模块，普通 list 不会', () => {
    expect(session.py.run(`
import nanotorch as nt
from nanotorch import nn

class Naive(nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = [nn.Linear(4, 4, seed=i + 1) for i in range(3)]

class Right(nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = nn.ModuleList([nn.Linear(4, 4, seed=i + 1) for i in range(3)])

[len(Naive().parameters()), len(Right().parameters())][0]
`)).toBe(0);

    expect(session.py.run('len(Right().parameters())')).toBe(3);
    // 下标、长度、迭代都要能用 —— 不然写起来还是得回到普通 list
    expect(session.py.run('len(Right().layers)')).toBe(3);
    expect(session.py.run('sum(1 for _ in Right().layers)')).toBe(3);
  });

  it('ParameterList 同理', () => {
    expect(session.py.run(`
import nanotorch as nt
from nanotorch import nn

class M(nn.Module):
    def __init__(self):
        super().__init__()
        self.ws = nn.ParameterList([nt.parameter((2, 2), i + 1, 0.02) for i in range(3)])

M().num_parameters()
`)).toBe(12);
  });

  /*
   * `F.scale` 的反向：乘常数的导数就是乘同一个常数。
   *
   * 单独验它是因为**它的反向一旦就地改了上游的 grad，错法非常隐蔽** ——
   * 残差缩放这条路上 `out.grad` 是和别的分支共享的，
   * 就地缩放会把别人的梯度也一起改掉，而前向完全正常。
   */
  it('F.scale 的反向是乘同一个常数，且不动上游的 grad', () => {
    const out = session.py.run(`
import json
import nanotorch as nt
from nanotorch import functional as F

x = nt.parameter((4,), None, 0.0)      # 全 1
x.set_([1.0, 2.0, 3.0, 4.0])
y = F.scale(x, 0.25)
fwd = y.tolist()

# 同一个 grad 喂给两条分支：一条缩放、一条原样加。
# 如果 scale 的反向就地改了 grad，第二条分支拿到的就是被改过的值。
g = y.ensure_grad()
g.set_([1.0, 1.0, 1.0, 1.0])
y._backward()
grad_after = x.grad.tolist()
shared = g.tolist()

json.dumps({"fwd": fwd, "grad": grad_after, "shared": shared})
`) as string;
    const r = JSON.parse(out);
    expect(r.fwd).toEqual([0.25, 0.5, 0.75, 1]);
    expect(r.grad).toEqual([0.25, 0.25, 0.25, 0.25]);
    // 上游那份 grad 必须还是原来的 1，没被就地缩放掉
    expect(r.shared).toEqual([1, 1, 1, 1]);
  });

  /*
   * `F.norm` / `F.rms` 是观测量，不进计算图。
   * 它们是第 6 关那条「残差流随深度涨多少」的量尺,量尺本身得先是准的。
   */
  it('F.norm 与 F.rms 算的是 L2 与均方根', () => {
    const out = session.py.run(`
import json
import nanotorch as nt
from nanotorch import functional as F
x = nt.zeros((4,), role="data")
x.set_([3.0, 4.0, 0.0, 0.0])
json.dumps([F.norm(x), F.rms(x)])
`) as string;
    const [l2, rms] = JSON.parse(out);
    expect(l2).toBeCloseTo(5, 6);
    expect(rms).toBeCloseTo(2.5, 6);
  });

  /*
   * 权重共享的模型里，`parameters()` 绝不能把同一份权重数两遍 ——
   * 数两遍的话优化器会更新它两次，而参数量也会报错。
   * `tied_head` 写成函数而不是 Module 正是为了这个。
   */
  it('权重共享不会让参数被数两遍', () => {
    expect(session.py.run(`
import nanotorch as nt
from nanotorch import nn
emb = nn.Embedding(10, 4, seed=1)
class M(nn.Module):
    def __init__(self):
        super().__init__()
        self.emb = emb
m = M()
len(m.parameters())
`)).toBe(1);
  });

  /*
   * **相邻的整数种子必须给出不相关的初始化。**
   *
   * 这条是回归用的。竖切第一版给同一个 block 的 wq/wk/wv/wo 发了 `seed+1..+4`，
   * 400 步之后 loss 停在 2.25；把种子在 JS 侧先打散之后，同样 400 步是 1.44、
   * 800 步 1.23。相关的初始化把学习速度砍掉了一大半，而**表面上一切正常** ——
   * 模型在学，loss 在降，只是慢，没有任何东西会报错。
   *
   * 而「给每个张量发一个相邻的整数种子」是任何人都会写的东西。
   * 所以这是我们 API 的坑，堵在 bridge.ts 的 mixSeed 里。
   */
  it('相邻的种子给出不相关的初始化', () => {
    const corr = session.py.run(`
import nanotorch as nt
n = 4096
a = nt.zeros((n,)).normal_(1, 1.0).tolist()
b = nt.zeros((n,)).normal_(2, 1.0).tolist()
ma = sum(a) / n
mb = sum(b) / n
cov = sum((x - ma) * (y - mb) for x, y in zip(a, b)) / n
sa = (sum((x - ma) ** 2 for x in a) / n) ** 0.5
sb = (sum((y - mb) ** 2 for y in b) / n) ** 0.5
abs(cov / (sa * sb))
`) as number;
    console.log(`  seed=1 与 seed=2 的相关系数 |r| = ${corr.toFixed(4)}`);
    // 4096 个样本，独立时 |r| 的量级是 1/sqrt(n) ≈ 0.016；给到 0.08 的余量
    expect(corr).toBeLessThan(0.08);
  });

  it('形状写错时报的是 Python 的错，带得出行号', () => {
    expect(() => session.py.run(`
import nanotorch as nt
from nanotorch import functional as F
x = nt.zeros((4, 8))
w = nt.parameter((16, 8), seed=1)
F.linear(x, w)
`)).toThrow(/linear 的形状对不上/);
  });
});

describe('竖切：Python 里真训一个模型', () => {
  let rt: Runtime;
  let session: TrainSession;

  beforeAll(async () => {
    rt = createRuntime(WASM);
    session = await createTrainSession(rt, { indexURL: INDEX_URL });
  }, 180_000);

  it('800 步，loss 从均匀熵掉到信息论地板附近', () => {
    const t0 = Date.now();
    const { stdout } = session.runScript('train.py', TRAIN_PY);
    const ms = Date.now() - t0;

    const result = session.scriptJson('RESULT') as Record<string, number>;
    const uniform = Math.log(16);
    const floor = (7 * uniform) / 16;

    console.log(`  ${stdout.trim().split('\n').join(' | ')}`);
    console.log(
      `  ${ms}ms 共 ${result.steps} 步 → ${(ms / result.steps).toFixed(1)} ms/步；` +
      `均匀熵 ${uniform.toFixed(3)}，信息论地板 ${floor.toFixed(3)}`
    );

    expect(result.first).toBeGreaterThan(uniform * 0.9);
    // 门槛按「规矩二」定：卡在朴素值（2.773）与参考值之间，靠近参考侧
    expect(result.last).toBeLessThan(1.5);
    expect(result.last).toBeLessThan(floor * 1.2);
    expect(result.last).toBeGreaterThan(floor * 0.95);
  }, 300_000);

  /*
   * Python 侧算出来的参数量必须等于解析式。
   * 第 4、7 关的门槛就是这条 —— 少了残差、多了一份 bias、
   * GQA 的 kv 投影按 n_head 而不是 n_kv_head 开，三种错在这个数上都立刻可见。
   */
  it('参数量等于解析式', () => {
    const result = session.scriptJson('RESULT') as Record<string, number>;
    const dim = 64, nHead = 4, nKvHead = 2, hidden = 128, vocab = 16, nLayer = 2;
    const hd = dim / nHead;
    const perLayer =
      dim * 2                        // 两个 RMSNorm 的增益
      + dim * nHead * hd             // wq
      + dim * nKvHead * hd * 2       // wk + wv
      + nHead * hd * dim             // wo
      + dim * hidden * 2             // wg + wu
      + hidden * dim;                // wd
    expect(result.params).toBe(vocab * dim + nLayer * perLayer + dim);
  });

  it('计量拿得到，而且反向大约是前向的两倍', () => {
    const m = rt.metrics();
    console.log(
      `  FLOPs 前向 ${(m.flops.forward / 1e9).toFixed(2)}G / ` +
      `反向 ${(m.flops.backward / 1e9).toFixed(2)}G / ` +
      `比值 ${m.flops.backwardOverForward.toFixed(2)}；` +
      `激活峰值 ${(m.memory.peakActivationBytes / 1e6).toFixed(1)}MB`
    );
    expect(m.flops.forward).toBeGreaterThan(0);
    expect(m.flops.backwardOverForward).toBeGreaterThan(1.5);
    expect(m.flops.backwardOverForward).toBeLessThan(2.6);
    expect(m.tokens.total).toBe(800 * 16 * 16);
  });

  /*
   * 这条是「平台能不能据此判他过没过」那一半。
   * 门槛读的是同一棵指标树，学员在 Python 里绕不过去 ——
   * 因为计量在 JS 那一层，不在他的代码里。
   */
  it('禁用的算子被数到了 —— 「自己实现」是精确可判的', async () => {
    const rt2 = createRuntime(WASM);
    rt2.forbid(['attn_fwd']);
    const py2 = await loadPythonRuntime({ indexURL: INDEX_URL });
    installNanotorch(py2, rt2);
    py2.run(`
import nanotorch as nt
from nanotorch import functional as F
B, S, H, KV, HD = 1, 4, 2, 1, 4
q = nt.zeros((B, S, H * HD)); k = nt.zeros((B, S, KV * HD)); v = nt.zeros((B, S, KV * HD))
F.scaled_dot_product_attention(q, k, v, B, S, H, KV, HD)
`);
    const m = rt2.metrics();
    expect(m.builtins.forbiddenCalls).toBe(1);
    expect((m.builtins.forbiddenHits as Record<string, number>).attn_fwd).toBe(1);
  }, 180_000);
});

describe('确定性', () => {
  /*
   * 所有门槛的地基。跨 Pyodide 实例跑两遍同一份脚本，loss 序列必须逐位一致 ——
   * 这条一红，重放、反向验证、进度存档全都不成立。
   */
  it('两个独立会话跑同一份脚本，loss 逐位一致', async () => {
    const short = TRAIN_PY.replace('STEPS = 800', 'STEPS = 25');
    const run = async () => {
      const rt = createRuntime(WASM);
      const s = await createTrainSession(rt, { indexURL: INDEX_URL });
      s.runScript('train.py', short);
      return JSON.stringify(s.scriptJson('history'));
    };
    const [a, b] = [await run(), await run()];
    expect(a).toBe(b);
    expect(JSON.parse(a)).toHaveLength(25);
  }, 300_000);
});
