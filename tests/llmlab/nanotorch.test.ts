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
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createRuntime, type Runtime } from '../../src/lib/llmlab/bridge';
import {
  createTrainSession, installNanotorch, loadPythonRuntime,
  NANOTORCH_HASH, NANOTORCH_SOURCES, type TrainSession,
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

  it('指纹是全部源文件算出来的', () => {
    expect(NANOTORCH_HASH).toHaveLength(16);
    // 数量对不上说明新加的 .py 没进生成物 —— 那种情况下 import 会在浏览器里才炸
    const names = readdirSync(join(ROOT, 'src', 'lib', 'llmlab', 'python', 'nanotorch'))
      .filter((n) => n.endsWith('.py'));
    const embedded = Object.keys(NANOTORCH_SOURCES).map((k) => k.replace(/^nanotorch\//, ''));
    expect(embedded.sort()).toEqual(names.sort());
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
   * `F.log_softmax` —— 后训练那几关的地基。
   *
   * **不是 `log(softmax(x))`**：softmax 之后小概率会下溢成 0，再取 log 就是 −inf。
   * 这一条特意用一组跨度很大的 logits 验：合成的那一步给出的是一个很负的有限数，
   * 而分开算会得到 −inf。
   */
  it('log_softmax 在概率下溢的地方仍然是有限值', () => {
    const out = session.py.run(`
import json, math
import nanotorch as nt
from nanotorch import functional as F

x = nt.zeros((1, 4), role="data")
x.set_([0.0, -120.0, -200.0, 1.0])       # 后两个的概率会下溢成 0
ls = F.log_softmax(x, 1, 4).tolist()
sm = F.softmax(x, 1, 4).tolist()
naive = [math.log(v) if v > 0 else float("-inf") for v in sm]
json.dumps({"ls": ls, "sm": sm, "naive": [str(v) for v in naive]})
`) as string;
    const r = JSON.parse(out);
    // 合成的那一步全是有限值
    expect(r.ls.every((v: number) => Number.isFinite(v))).toBe(true);
    expect(r.ls[2]).toBeLessThan(-100);
    // 而先 softmax 再 log 已经变成 −inf 了 —— 这就是不能那么写的理由
    expect(r.naive[2]).toBe('-inf');
    // 数值上和 x − logsumexp 对得上
    const mx = 1.0;
    const lse = mx + Math.log([0, -120, -200, 1].reduce((a, v) => a + Math.exp(v - mx), 0));
    for (let j = 0; j < 4; j++) {
      expect(Math.abs(r.ls[j] - ([0, -120, -200, 1][j] - lse))).toBeLessThan(1e-4);
    }
  });

  /*
   * log_softmax 的反向：`dx_j = dout_j − exp(out_j)·Σ_k dout_k`。
   * 和 softmax 的反向长得像，但求和项**不带权重** ——
   * 写成 softmax 那一版的话前向照样对，梯度悄悄错。
   */
  it('log_softmax 的反向对得上中心差分（f64）', () => {
    const out = session.py.run(`
import json
import nanotorch as nt
from nanotorch import functional as F

rows, cols = 3, 5
x = nt.parameter((rows, cols), 11, 1.0, "x", dtype="f64")
w = nt.zeros((rows, cols), "f64", role="data")
w.set_([0.3, -0.2, 0.5, 0.1, -0.4] * rows)     # 一组不对称的上游梯度

def forward():
    y = F.log_softmax(x, rows, cols)
    # 标量出口：Σ w·y
    return y, sum(a * b for a, b in zip(y.tolist(), w.tolist()))

y, _ = forward()
g = y.ensure_grad()
g.set_(w.tolist())
y._backward()
ana = list(x.grad.tolist())

vals = list(x.tolist())
h = 1e-5
num = []
for i in range(rows * cols):
    orig = vals[i]
    vals[i] = orig + h; x.set_(vals)
    _, lp = forward()
    vals[i] = orig - h; x.set_(vals)
    _, lm = forward()
    vals[i] = orig; x.set_(vals)
    num.append((lp - lm) / (2 * h))
json.dumps({"ana": ana, "num": num})
`) as string;
    const r = JSON.parse(out);
    let worst = 0;
    for (let i = 0; i < r.ana.length; i++) {
      worst = Math.max(worst, Math.abs(r.ana[i] - r.num[i])
        / Math.max(1e-6, Math.abs(r.ana[i]) + Math.abs(r.num[i])));
    }
    expect(worst).toBeLessThan(2e-3);
  });

  /*
   * `F.mul` / `F.row_scale` / `F.gather` / `F.scatter_add` —— 第 20 关起要用的四个。
   *
   * 四个一起验是因为 MoE 那一关把它们串成一条链：
   * 按专家 gather 出 token、算完、乘上路由权重、再 scatter 回原位。
   * 链上任何一环写错，表现都是「loss 还在降，只是慢一点」。
   */
  it('mul 与 row_scale 的前向和反向', () => {
    const out = session.py.run(`
import json
import nanotorch as nt
from nanotorch import functional as F

a = nt.parameter((2, 3), None, 0.0); a.set_([1, 2, 3, 4, 5, 6])
b = nt.parameter((2, 3), None, 0.0); b.set_([2, 2, 2, 3, 3, 3])
y = F.mul(a, b)
g = y.ensure_grad(); g.set_([1, 1, 1, 1, 1, 1])
y._backward()

x = nt.parameter((2, 3), None, 0.0); x.set_([1, 2, 3, 4, 5, 6])
c = nt.parameter((2,), None, 0.0); c.set_([0.5, 2.0])
z = F.row_scale(x, c, 2, 3)
gz = z.ensure_grad(); gz.set_([1, 1, 1, 1, 1, 1])
z._backward()

json.dumps({"mul": y.tolist(), "da": a.grad.tolist(), "db": b.grad.tolist(),
            "rs": z.tolist(), "dx": x.grad.tolist(), "dc": c.grad.tolist()})
`) as string;
    const r = JSON.parse(out);
    expect(r.mul).toEqual([2, 4, 6, 12, 15, 18]);
    // d(a⊙b)/da = b，d/db = a
    expect(r.da).toEqual([2, 2, 2, 3, 3, 3]);
    expect(r.db).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.rs).toEqual([0.5, 1, 1.5, 8, 10, 12]);
    // 每行乘自己的系数，所以 dx 的每一行就是那个系数
    expect(r.dx).toEqual([0.5, 0.5, 0.5, 2, 2, 2]);
    // dc[r] = Σ_c x[r][c]  ->  1+2+3=6，4+5+6=15
    expect(r.dc).toEqual([6, 15]);
  });

  /*
   * gather / scatter_add 是一对。**scatter 是累加不是覆盖** ——
   * top-k > 1 时同一个 token 会从好几个专家那里各收一份，
   * 覆盖的话只剩最后一个专家的贡献，而 loss 照样降。
   */
  it('gather 与 scatter_add：scatter 是累加', () => {
    const out = session.py.run(`
import json
import nanotorch as nt
from nanotorch import functional as F

table = nt.parameter((4, 2), None, 0.0)
table.set_([10, 11, 20, 21, 30, 31, 40, 41])
idx = nt.zeros((3,), role="data"); idx.set_int_([2, 0, 2])
g = F.gather(table, idx, 3, 2)

src = nt.parameter((3, 2), None, 0.0); src.set_([1, 1, 2, 2, 4, 4])
sc = F.scatter_add(src, idx, 3, 2, 4)

gg = sc.ensure_grad(); gg.set_([1, 2, 3, 4, 5, 6, 7, 8])
sc._backward()

json.dumps({"gather": g.tolist(), "scatter": sc.tolist(), "dsrc": src.grad.tolist()})
`) as string;
    const r = JSON.parse(out);
    expect(r.gather).toEqual([30, 31, 10, 11, 30, 31]);
    // 行 2 收到 src[0] 和 src[2] 两份：1+4 = 5
    expect(r.scatter).toEqual([2, 2, 0, 0, 5, 5, 0, 0]);
    // scatter 的反向是 gather
    expect(r.dsrc).toEqual([5, 6, 1, 2, 5, 6]);
  });

  /*
   * `F.gemm` 的三种转置模式。写自定义算子的反向全靠它，
   * **一旦某个模式的 m/n/k 对错了，梯度会静静地错掉**，
   * 而形状检查未必拦得住（方阵上尤其拦不住）。
   * 所以这里用非方阵，并逐元素对着手算的结果比。
   */
  it('F.gemm 的 nn / nt / tn 三种模式都算对了', () => {
    const out = session.py.run(`
import json
import nanotorch as nt
from nanotorch import functional as F

# A: 2x3, B: 3x2
a = nt.zeros((2, 3), role="data"); a.set_([1, 2, 3, 4, 5, 6])
b = nt.zeros((3, 2), role="data"); b.set_([1, 2, 3, 4, 5, 6])
nn_ = F.gemm(a, b, 2, 2, 3, "nn").tolist()

# nt: A[2,3] @ B[2,3]^T -> [2,2]
c = nt.zeros((2, 3), role="data"); c.set_([1, 0, 0, 0, 1, 0])
nt_ = F.gemm(a, c, 2, 2, 3, "nt").tolist()

# tn: A[2,3]^T @ B[2,2] -> [3,2]
d = nt.zeros((2, 2), role="data"); d.set_([1, 0, 0, 1])
tn_ = F.gemm(a, d, 3, 2, 2, "tn").tolist()

json.dumps({"nn": nn_, "nt": nt_, "tn": tn_})
`) as string;
    const r = JSON.parse(out);
    // [[1,2,3],[4,5,6]] @ [[1,2],[3,4],[5,6]] = [[22,28],[49,64]]
    expect(r.nn).toEqual([22, 28, 49, 64]);
    // [[1,2,3],[4,5,6]] @ [[1,0,0],[0,1,0]]^T = [[1,2],[4,5]]
    expect(r.nt).toEqual([1, 2, 4, 5]);
    // [[1,2,3],[4,5,6]]^T @ I = [[1,4],[2,5],[3,6]]
    expect(r.tn).toEqual([1, 4, 2, 5, 3, 6]);
  });

  /*
   * `no_grad` 里不建带。这不是省一点点 —— 评测和生成循环里，
   * **建带意味着每一层的激活都要留到反向**，显存差出好几倍。
   */
  it('no_grad 里的算子不挂反向，出了作用域又恢复', () => {
    const out = session.py.run(`
import json
import nanotorch as nt
from nanotorch import functional as F

x = nt.parameter((2, 2), 1, 0.02)
inside = None
with nt.no_grad():
    y = F.linear(x, x)
    inside = [y.requires_grad, nt.is_grad_enabled()]
z = F.linear(x, x)
json.dumps({"inside": inside, "after": [z.requires_grad, nt.is_grad_enabled()]})
`) as string;
    const r = JSON.parse(out);
    expect(r.inside).toEqual([false, false]);
    expect(r.after).toEqual([true, true]);
  });

  /*
   * `autograd.Function`：自己写的反向要真的被引擎调到，而且是**累加**进去的。
   *
   * 这一条用一个**分叉**的图：同一个 x 走两条自定义算子再相加。
   * 反向如果是赋值而不是累加，第二条会把第一条的梯度盖掉 ——
   * 单链的表达式上完全看不出来，只有分叉才暴露。
   */
  it('autograd.Function 的反向被调到，而且梯度是累加的', () => {
    const out = session.py.run(`
import json
import nanotorch as nt
from nanotorch import functional as F

class Twice(nt.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        return F.scale(x, 2.0)
    @staticmethod
    def backward(ctx, go):
        return F.scale(go, 2.0)

class Thrice(nt.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        return F.scale(x, 3.0)
    @staticmethod
    def backward(ctx, go):
        return F.scale(go, 3.0)

x = nt.parameter((4,), None, 0.0)          # 全 1
x.set_([1.0, 2.0, 3.0, 4.0])
y = F.add(Twice.apply(x), Thrice.apply(x))  # y = 5x，分叉
# 直接给 y 灌一份全 1 的梯度，倒着走
g = y.ensure_grad(); g.set_([1.0, 1.0, 1.0, 1.0])
topo, seen = [], set()
def visit(t):
    if id(t) in seen: return
    seen.add(id(t))
    for p in t._parents: visit(p)
    topo.append(t)
visit(y)
for t in reversed(topo):
    if t._backward is not None:
        t._backward()

json.dumps({"fwd": y.tolist(), "grad": x.grad.tolist()})
`) as string;
    const r = JSON.parse(out);
    expect(r.fwd).toEqual([5, 10, 15, 20]);
    // 2 + 3 = 5，两条分支各加各的
    expect(r.grad).toEqual([5, 5, 5, 5]);
  });

  /*
   * `forward` 跑在 no_grad 里 —— 所以里面调 `F.linear` 也不会挂上内建的反向。
   * 挂了的话反向会走两遍（引擎一遍、你的 backward 一遍），梯度正好翻倍，
   * 而这个错在梯度检验里表现为「差了整整一倍」，很容易被误读成学习率的问题。
   */
  it('Function.forward 里的内建算子不会额外挂一份反向', () => {
    expect(session.py.run(`
import nanotorch as nt
from nanotorch import functional as F

class Id(nt.autograd.Function):
    @staticmethod
    def forward(ctx, x):
        y = F.scale(x, 1.0)
        # forward 内部产生的中间量不该带 parents
        return y
    @staticmethod
    def backward(ctx, go):
        return go

x = nt.parameter((2,), None, 0.0)
y = Id.apply(x)
len(y._parents)
`)).toBe(1);
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
