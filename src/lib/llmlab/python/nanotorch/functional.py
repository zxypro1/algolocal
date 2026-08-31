"""算子的函数式接口，每个都自带反向。

命名与参数尽量对着 `torch.nn.functional` —— 学员在这里写的
`F.rms_norm(x, weight)`、`F.scaled_dot_product_attention(q, k, v, is_causal=True)`，
换到 PyTorch 上是同一个名字同一个意思。

每个函数的结构都一样：

    1. 核形状
    2. 分配输出
    3. 调前向
    4. 挂一个闭包，反向时把梯度散给上游

第 9–11 关要学员自己把第 4 步写出来，所以这些闭包是**这个项目的教学正文**，
不是实现细节。
"""

from . import _bridge as B
from .tensor import Tensor, zeros, is_grad_enabled


def _rows(shape):
    """把 [..., d] 摊平成 (行数, d)。所有逐行算子都按这个约定。"""
    n = 1
    for d in shape[:-1]:
        n *= d
    return n, shape[-1]


def add(a, b):
    """逐元素相加。残差连接就是它。

    反向极其简单 —— 加法的梯度是**原样分给两边**。
    简单到值得说一句：残差之所以能让深网络训得动，一半的原因就在这里，
    梯度从输出到输入有一条不经过任何缩放的通路。
    """
    assert a.shape == b.shape, f"相加的两边形状要一致：{a.shape} vs {b.shape}"
    n = a.numel
    out = Tensor(a.shape, a.dtype, name="add")
    B.copy(out.handle, a.handle, n)
    B.add_inplace(out.handle, b.handle, n)

    def backward():
        go = out.grad
        if go is None:
            return
        if a.requires_grad:
            B.add_inplace(a.ensure_grad().handle, go.handle, n)
        if b.requires_grad:
            B.add_inplace(b.ensure_grad().handle, go.handle, n)

    out.requires_grad = is_grad_enabled() and (a.requires_grad or b.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (a, b)
    return out


def one_hot(targets, rows, vocab, dtype="f32"):
    """把一列 token id 摊成 `[rows, vocab]` 的 0/1 矩阵。

    对应 `torch.nn.functional.one_hot`。交叉熵的反向要用它 ——
    `dlogits = (softmax(logits) − onehot(targets)) / rows`。

    **不挂反向**：下标不是连续量，对它求导没有意义。

    角色是 `activation` 而不是 `data`：它是反向里每步现造现扔的中间量。
    标成 `data` 的话，每步的 `release` 会撞上「不许丢长期张量」那条守卫 ——
    训练循环第二步就当场报错。
    """
    out = Tensor((rows, vocab), dtype, name="one_hot")
    B.fill_one_hot(out.handle, targets.handle, rows, vocab)
    return out


def gemm(a, b, m, n, k, mode="nn", dtype=None):
    """裸的矩阵乘，**不挂反向**。写自定义算子的反向时用它。

    三种模式的名字照 BLAS 来（PyTorch 的 linear 反向底下调的也是这三个）：

    | mode | 算的是 | A 的形状 | B 的形状 | 结果 |
    | --- | --- | --- | --- | --- |
    | `"nn"` | `A @ B` | `[m, k]` | `[k, n]` | `[m, n]` |
    | `"nt"` | `A @ Bᵀ` | `[m, k]` | `[n, k]` | `[m, n]` |
    | `"tn"` | `Aᵀ @ B` | `[k, m]` | `[k, n]` | `[m, n]` |

    于是 `y = x @ W` 的反向就是两行：

        dx = gemm(dy, W, rows, din, dout, "nt")     # dy @ Wᵀ
        dW = gemm(x, dy, din, dout, rows, "tn")     # xᵀ @ dy

    这不是简化过的教学接口 —— 真的 cuBLAS 就是这三个转置标志。
    """
    dt = dtype or a.dtype
    out = Tensor((m, n), dt, name="gemm." + mode)
    if mode == "nn":
        B.gemm_nn(a.handle, b.handle, out.handle, m, n, k)
    elif mode == "nt":
        B.gemm_nt(a.handle, b.handle, out.handle, m, n, k)
    elif mode == "tn":
        # 算子核那一版是累加的，所以先清零
        out.fill_(0.0)
        B.gemm_tn_acc(a.handle, b.handle, out.handle, k, n, m)
    else:
        raise ValueError(f"mode 只能是 nn / nt / tn，拿到 {mode!r}")
    return out


def mul(a, b):
    """逐元素相乘。对应 PyTorch 里的 `a * b`。

    反向是对称的：`da = b·go`，`db = a·go`。
    """
    assert a.shape == b.shape, f"相乘的两边形状要一致：{a.shape} vs {b.shape}"
    n = a.numel
    out = Tensor(a.shape, a.dtype, name="mul")
    B.mul(a.handle, b.handle, out.handle, n)

    def backward():
        go = out.grad
        if go is None:
            return
        if a.requires_grad:
            tmp = Tensor(a.shape, a.dtype, name="dmul.a")
            B.mul(b.handle, go.handle, tmp.handle, n)
            B.add_inplace(a.ensure_grad().handle, tmp.handle, n)
        if b.requires_grad:
            tmp = Tensor(b.shape, b.dtype, name="dmul.b")
            B.mul(a.handle, go.handle, tmp.handle, n)
            B.add_inplace(b.ensure_grad().handle, tmp.handle, n)

    out.requires_grad = is_grad_enabled() and (a.requires_grad or b.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (a, b)
    return out


def row_scale(x, coef, rows, dim):
    """每一行乘一个自己的系数：`out[r][c] = x[r][c] · coef[r]`。

    「一行一个标量」这个形状在后训练里到处都是 ——
    MoE 的路由权重、SFT 的样本掩码、GRPO 的优势加权。
    用逐元素乘也能做，代价是先摊出一块 `[rows, dim]` 的广播；
    这里直接给算子，省掉那一块。
    """
    out = Tensor(x.shape, x.dtype, name="row_scale")
    B.row_scale(x.handle, coef.handle, out.handle, rows, dim)

    def backward():
        go = out.grad
        if go is None:
            return
        if x.requires_grad:
            tmp = Tensor(x.shape, x.dtype, name="drow_scale.x")
            B.row_scale(go.handle, coef.handle, tmp.handle, rows, dim)
            B.add_inplace(x.ensure_grad().handle, tmp.handle, x.numel)
        if coef.requires_grad:
            B.row_scale_bwd_s(go.handle, x.handle, coef.ensure_grad().handle, rows, dim)

    out.requires_grad = is_grad_enabled() and (x.requires_grad or coef.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (x, coef)
    return out


def gather(table, idx, rows, dim):
    """按行取：`out[i] = table[idx[i]]`。对应 `torch.index_select` / `x[idx]`。

    和 `embedding` 是同一个算子 —— 区别只在**语义**：
    嵌入表是参数，而这里 `table` 常常是激活（MoE 把 token 分给专家就是这么取的）。
    反向都是散射累加。
    """
    return embedding(table, idx, rows, dim)


def scatter_add(src, idx, rows, dim, out_rows):
    """散射累加：`out[idx[i]] += src[i]`。对应 `torch.index_add_`。

    MoE 把各个专家算完的结果放回原位靠它。**是累加不是覆盖** ——
    top-k > 1 时同一个 token 会从好几个专家那里各收一份。
    """
    out = Tensor((out_rows, dim), src.dtype, name="scatter_add")
    out.fill_(0.0)
    B.embed_bwd(src.handle, idx.handle, out.handle, rows, dim)

    def backward():
        go = out.grad
        if go is None or not src.requires_grad:
            return
        tmp = Tensor((rows, dim), src.dtype, name="dscatter")
        B.embed_fwd(go.handle, idx.handle, tmp.handle, rows, dim)
        B.add_inplace(src.ensure_grad().handle, tmp.handle, rows * dim)

    out.requires_grad = is_grad_enabled() and src.requires_grad
    if out.requires_grad:
        out._backward = backward
        out._parents = (src,)
    return out


def linear(x, weight):
    """y = x @ weight。

    `weight` 是 [in, out]，和 PyTorch 的 `nn.Linear`（存 [out, in]）**转置着来** ——
    这是我们的算子核更自然的排布。`nn.Linear` 那一层会把这件事藏起来，
    所以学员在模型代码里看到的仍然是熟悉的形状。
    """
    rows, din = _rows(x.shape)
    assert weight.dim() == 2 and weight.shape[0] == din, \
        f"linear 的形状对不上：x 的最后一维是 {din}，weight 是 {weight.shape}"
    dout = weight.shape[1]
    out = Tensor(x.shape[:-1] + (dout,), x.dtype, name="linear")
    B.gemm_nn(x.handle, weight.handle, out.handle, rows, dout, din)

    def backward():
        go = out.grad
        if go is None:
            return
        if weight.requires_grad:
            B.gemm_tn_acc(x.handle, go.handle, weight.ensure_grad().handle, rows, dout, din)
        if x.requires_grad:
            # dX = dY @ W^T，累加到 x 已有的梯度上（x 可能被多处用到）
            tmp = Tensor(x.shape, x.dtype, name="dlinear")
            B.gemm_nt(go.handle, weight.handle, tmp.handle, rows, din, dout)
            B.add_inplace(x.ensure_grad().handle, tmp.handle, x.numel)

    out.requires_grad = is_grad_enabled() and (x.requires_grad or weight.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (x, weight)
    return out


def scale_(x, factor):
    """就地乘一个标量。**不挂反向** —— 它改的是已经算好的数。

    梯度裁剪就是它：`clip_grad_norm_` 算出缩放系数之后，
    把每份梯度原地乘上去。对应 PyTorch 里 `p.grad.mul_(coef)`。
    """
    B.scale_inplace(x.handle, float(factor), x.numel)
    return x


def scale(x, factor):
    """乘一个标量常数。对应 PyTorch 里的 `x * factor`。

    残差缩放（`1/sqrt(2L)`）、loss 的梯度累积除以 micro-batch 数，
    用的都是它。乘常数的导数就是乘同一个常数,反向里没有别的东西。
    """
    out = Tensor(x.shape, x.dtype, name="scale")
    B.copy(out.handle, x.handle, x.numel)
    B.scale_inplace(out.handle, float(factor), out.numel)
    out.requires_grad = is_grad_enabled() and (x.requires_grad)

    def backward():
        go = out.grad
        if go is None:
            return
        # 不能就地改 go —— 它可能被别的分支共享。先抄一份再缩放。
        tmp = Tensor(x.shape, x.dtype, name="scale.grad")
        B.copy(tmp.handle, go.handle, tmp.numel)
        B.scale_inplace(tmp.handle, float(factor), tmp.numel)
        B.add_inplace(x.ensure_grad().handle, tmp.handle, tmp.numel)

    if out.requires_grad:
        out._backward = backward
        out._parents = (x,)
    return out


def rms_norm(x, weight, eps=1e-5):
    """沿最后一维做 RMSNorm。对应 `torch.nn.functional.rms_norm`。"""
    rows, d = _rows(x.shape)
    assert weight.numel == d, f"rms_norm 的增益长度应为 {d}，实际 {weight.numel}"
    out = Tensor(x.shape, x.dtype, name="rmsnorm")
    inv = Tensor((rows,), x.dtype, name="rmsnorm.inv")
    B.rmsnorm_fwd(x.handle, weight.handle, out.handle, inv.handle, rows, d, eps)

    def backward():
        go = out.grad
        if go is None:
            return
        tmp = Tensor(x.shape, x.dtype, name="drmsnorm")
        B.rmsnorm_bwd(go.handle, x.handle, weight.handle, inv.handle,
                      weight.ensure_grad().handle, tmp.handle, rows, d)
        if x.requires_grad:
            B.add_inplace(x.ensure_grad().handle, tmp.handle, x.numel)

    out.requires_grad = is_grad_enabled() and (x.requires_grad or weight.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (x, weight)
    return out


def swiglu(gate, up):
    """silu(gate) * up。

    对应 PyTorch 里手写的 `F.silu(gate) * up` —— 现代 LLM 的前馈层就这一句，
    只是真实现里会把两个投影合成一个 gemm 再劈开。
    """
    assert gate.shape == up.shape, f"swiglu 两边形状要一致：{gate.shape} vs {up.shape}"
    n = gate.numel
    out = Tensor(gate.shape, gate.dtype, name="swiglu")
    B.swiglu_fwd(gate.handle, up.handle, out.handle, n)

    def backward():
        go = out.grad
        if go is None:
            return
        dgate = Tensor(gate.shape, gate.dtype, name="dgate")
        dup = Tensor(up.shape, up.dtype, name="dup")
        B.swiglu_bwd(go.handle, gate.handle, up.handle, dgate.handle, dup.handle, n)
        if gate.requires_grad:
            B.add_inplace(gate.ensure_grad().handle, dgate.handle, n)
        if up.requires_grad:
            B.add_inplace(up.ensure_grad().handle, dup.handle, n)

    out.requires_grad = is_grad_enabled() and (gate.requires_grad or up.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (gate, up)
    return out


def rope_tables(seq, head_dim, base=10000.0):
    """预算 RoPE 的 cos / sin 表，返回 `(cos, sin)`。

    表只跟位置和头维有关，跟数据无关，所以整个训练里算一次就够。
    真 PyTorch 里这一步同样是预算好挂在模块上的（Llama 叫 `rotary_emb`）。

    在 JS 侧填：Python 里逐元素写这张表要走两万次解释器循环，
    而它比整个前向还慢 —— 这是「纯 Python 的循环慢 300 倍」的第一个受害者。
    """
    assert head_dim % 2 == 0, f"RoPE 要求头维是偶数，拿到 {head_dim}"
    half = head_dim // 2
    # role="data"：这张表整个训练里都在，不该被每步的 release 推平
    cos = Tensor((seq, half), role="data", name="rope.cos")
    sin = Tensor((seq, half), role="data", name="rope.sin")
    B.fill_rope(cos.handle, sin.handle, seq, head_dim, base)
    return cos, sin


def rope(x, cos, sin, batch, seq, heads, head_dim):
    """就地把每个头的前后半维当成复数旋转。

    **这个算子是就地的**，所以它返回的是同一个 handle 包成的新 Tensor ——
    上游那份在旋转之后就不再是原来的值了。真 PyTorch 的实现一般不就地，
    这里就地是为了省一块 [B, S, H, hd]；边界写在这里，别在别处假设 x 还是旧的。
    """
    B.rope_fwd(x.handle, cos.handle, sin.handle, batch, seq, heads, head_dim)
    out = Tensor(x.shape, x.dtype, name="rope", handle=x.handle)
    out.requires_grad = is_grad_enabled() and (x.requires_grad)

    def backward():
        go = out.grad
        if go is None:
            return
        # 旋转矩阵的转置就是转 −θ，所以反向也是就地的
        B.rope_bwd(go.handle, cos.handle, sin.handle, batch, seq, heads, head_dim)
        x.grad = go

    if out.requires_grad:
        out._backward = backward
        out._parents = (x,)
    return out


def scaled_dot_product_attention(q, k, v, batch, seq, heads, kv_heads, head_dim):
    """因果注意力，支持 GQA。对应 `F.scaled_dot_product_attention(..., is_causal=True)`。

    `att` 那块是 [B, H, S, S] —— **它就是那块 O(S²) 的显存**。
    B=16 / H=8 / S=128 时每层 8.4MB，比一个 75k 参数的模型本身还大。
    FlashAttention 存在的理由，在这个尺度上就已经是一个能量出来的数了。
    """
    # 输出跟 q 同形。**不要写死成 (batch, seq, heads*head_dim)** ——
    # 上游可能是摊平的 (rows, dim)，写死之后残差那一步会因为 rank 不同而挂，
    # 而元素数是一样的，所以错得很像「形状约定没定清楚」。事实上就是。
    assert q.numel == batch * seq * heads * head_dim, \
        f"q 有 {q.numel} 个元素，按 B={batch} S={seq} H={heads} hd={head_dim} 应该是 " \
        f"{batch * seq * heads * head_dim}"
    assert k.numel == batch * seq * kv_heads * head_dim, "k 的元素数与 kv_heads 对不上"
    assert v.numel == k.numel, "v 要和 k 同形"
    out = Tensor(q.shape, q.dtype, name="attn.out")
    att = Tensor((batch, heads, seq, seq), q.dtype, name="attn.probs")
    B.attn_fwd(q.handle, k.handle, v.handle, att.handle, out.handle,
               batch, seq, heads, kv_heads, head_dim)

    def backward():
        go = out.grad
        if go is None:
            return
        dq = zeros(q.shape, q.dtype, name="dq")
        dk = zeros(k.shape, k.dtype, name="dk")
        dv = zeros(v.shape, v.dtype, name="dv")
        dp = zeros((seq,), q.dtype, name="attn.scratch")
        B.attn_bwd(go.handle, q.handle, k.handle, v.handle, att.handle,
                   dq.handle, dk.handle, dv.handle, dp.handle,
                   batch, seq, heads, kv_heads, head_dim)
        if q.requires_grad:
            B.add_inplace(q.ensure_grad().handle, dq.handle, q.numel)
        if k.requires_grad:
            B.add_inplace(k.ensure_grad().handle, dk.handle, k.numel)
        if v.requires_grad:
            B.add_inplace(v.ensure_grad().handle, dv.handle, v.numel)

    out.requires_grad = is_grad_enabled() and (q.requires_grad or k.requires_grad or v.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (q, k, v)
    return out


def embedding(table, idx, rows, dim):
    """按 token id 取行。对应 `F.embedding`。"""
    out = Tensor((rows, dim), table.dtype, name="embedding")
    B.embed_fwd(table.handle, idx.handle, out.handle, rows, dim)

    def backward():
        go = out.grad
        if go is None:
            return
        # 散射累加：同一个 token 在一个 batch 里出现多次，梯度要加起来
        B.embed_bwd(go.handle, idx.handle, table.ensure_grad().handle, rows, dim)

    out.requires_grad = is_grad_enabled() and (table.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (table,)
    return out


def linear_tied(x, table, rows, dim, vocab):
    """logits = x @ table^T —— lm_head 与词嵌入共享权重。

    注意 `table` 的梯度在这里加一次、在 `embedding` 的反向里再加一次。
    **两次都要**，这正是权重共享的意思；漏掉任何一次，前向照样对、loss 照样降，
    只有梯度检验抓得到。
    """
    out = Tensor((rows, vocab), x.dtype, name="logits")
    B.gemm_nt(x.handle, table.handle, out.handle, rows, vocab, dim)

    def backward():
        go = out.grad
        if go is None:
            return
        if table.requires_grad:
            B.gemm_tn_acc(go.handle, x.handle, table.ensure_grad().handle, rows, dim, vocab)
        if x.requires_grad:
            tmp = Tensor(x.shape, x.dtype, name="dlogits.x")
            B.gemm_nn(go.handle, table.handle, tmp.handle, rows, dim, vocab)
            B.add_inplace(x.ensure_grad().handle, tmp.handle, x.numel)

    out.requires_grad = is_grad_enabled() and (x.requires_grad or table.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (x, table)
    return out


def cross_entropy(logits, targets, rows, vocab, mask=None):
    """行 softmax + 交叉熵，返回**平均** loss（一个标量 Tensor）。

    `mask` 给 SFT 用：标 0 的行不贡献梯度。注意**前向报的仍是全部位置的平均** ——
    要屏蔽的话学员得自己在报数时也过一遍 mask。这个边界写在这里，
    因为「以为屏蔽了、其实没有」是 SFT 那一关最容易踩的坑。
    """
    probs = Tensor((rows, vocab), logits.dtype, name="probs")
    value = B.cross_entropy(logits.handle, targets.handle, probs.handle, rows, vocab)

    loss = Tensor((1,), logits.dtype, name="loss")
    loss.set_([value])

    def backward():
        d = Tensor((rows, vocab), logits.dtype, name="dlogits")
        B.cross_entropy_bwd(probs.handle, targets.handle,
                            mask.handle if mask is not None else -1,
                            d.handle, rows, vocab, 1.0 / rows)
        if logits.requires_grad:
            B.add_inplace(logits.ensure_grad().handle, d.handle, logits.numel)

    loss.requires_grad = is_grad_enabled() and (logits.requires_grad)
    if loss.requires_grad:
        loss._backward = backward
        loss._parents = (logits,)
    # Python 侧要拿这个数打印曲线，附在张量上省一次跨语言读
    loss.value = value  # type: ignore[attr-defined]
    return loss


# ============================================================ 拆开的注意力
#
# `scaled_dot_product_attention` 是融合的一整块。第 3 关的全部内容是
# **自己把注意力拼出来**，所以这里给出拆开的三步。
#
# 融合那份在第 3 关是禁用算子（`builtins.forbiddenCalls` 数得到）；
# 到第 8 关之后放开，那时它的意义变成「FlashAttention 式的融合实现」。


def attn_scores(q, k, batch, seq_q, seq_kv, heads, kv_heads, head_dim, scale=None):
    """scores[b,h,i,j] = scale · q[b,i,h,:] · k[b,j,kh,:]，形状 [B, H, Sq, Skv]。

    **不含因果掩码** —— 掩码是 softmax 那一步的事。拆开是为了让人看清
    「掩码作用在分数上，不是作用在输出上」。

    `seq_q` 与 `seq_kv` 是两个参数：训练时相等；解码时 `seq_q=1`、
    `seq_kv=t+1`（KV cache）。**同一个算子，不用另写一条解码路径。**
    """
    if scale is None:
        scale = 1.0 / (head_dim ** 0.5)
    out = Tensor((batch, heads, seq_q, seq_kv), q.dtype, name="attn.scores")
    B.attn_scores(q.handle, k.handle, out.handle,
                  batch, seq_q, seq_kv, heads, kv_heads, head_dim, scale)

    def backward():
        go = out.grad
        if go is None:
            return
        dq = zeros(q.shape, q.dtype, name="dq")
        dk = zeros(k.shape, k.dtype, name="dk")
        B.attn_scores_bwd(go.handle, q.handle, k.handle, dq.handle, dk.handle,
                          batch, seq_q, seq_kv, heads, kv_heads, head_dim, scale)
        if q.requires_grad:
            B.add_inplace(q.ensure_grad().handle, dq.handle, q.numel)
        if k.requires_grad:
            B.add_inplace(k.ensure_grad().handle, dk.handle, k.numel)

    out.requires_grad = is_grad_enabled() and (q.requires_grad or k.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (q, k)
    return out


def causal_valid(batch, heads, seq_q, offset=0):
    """因果掩码 —— 写成「每行能看到多少个键」。

    第 (b,h,i) 行的有效长度是 `offset + i + 1`。`offset` 给 KV cache 用：
    解码到第 t 步时 `seq_q=1`、`offset=t`。

    掩码做成一个长度数组而不是一张布尔矩阵，是因为因果、滑窗、文档边界
    三种掩码在这个表示下是同一套东西，算子不必分别认识它们。
    """
    # 角色是 activation：这张表每次前向都按 (batch, heads, seq) 重算一次，
    # 是个一次性的中间量。标成 data 的话它会落在训练循环那个 mark 之后，
    # 而 data 是常驻角色 —— 第二步的 release 会当场报错。
    # （这条是训练循环真的跑起来才暴露的：竖切用的是融合的注意力，
    #   走不到 causal_valid，于是它在第 13 关之前一直没露过面。）
    valid = Tensor((batch * heads * seq_q,), "f32", name="causal.valid")
    B.fill_causal_valid(valid.handle, batch, heads, seq_q, offset)
    return valid


def softmax(x, rows, cols, valid=None):
    """逐行 softmax。`valid` 是每行的有效长度，不给就整行都算。

    对应 `torch.softmax(x, dim=-1)` 加上一个掩码。
    **被掩掉的位置是硬 0，不是「很小的数」** —— 第 3 关的因果性探针查的就是这个。
    """
    out = Tensor(x.shape, x.dtype, name="softmax")
    B.softmax_rows(x.handle, valid.handle if valid is not None else -1,
                   out.handle, rows, cols)

    def backward():
        go = out.grad
        if go is None:
            return
        dx = Tensor(x.shape, x.dtype, name="dsoftmax")
        B.softmax_rows_bwd(go.handle, out.handle,
                           valid.handle if valid is not None else -1,
                           dx.handle, rows, cols)
        if x.requires_grad:
            B.add_inplace(x.ensure_grad().handle, dx.handle, x.numel)

    out.requires_grad = is_grad_enabled() and (x.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (x,)
    return out


def log_softmax(x, rows, cols, valid=None):
    """逐行 log-softmax。对应 `torch.log_softmax(x, dim=-1)`。

    **不是 `log(softmax(x))`。** softmax 之后小概率会下溢成 0，再取 log 就是 −inf；
    合成一步之后不必显式算出概率，小概率对应的只是一个很负的数。

    强化学习里 log-prob 到处都是 —— DPO 的隐式奖励、PPO / GRPO 的重要性比值，
    而那些地方的概率常常很小。所以这一步的稳定性不是可选项。
    """
    out = Tensor(x.shape, x.dtype, name="log_softmax")
    B.log_softmax_fwd(x.handle, valid.handle if valid is not None else -1,
                      out.handle, rows, cols)

    def backward():
        go = out.grad
        if go is None or not x.requires_grad:
            return
        dx = Tensor(x.shape, x.dtype, name="dlog_softmax")
        B.log_softmax_bwd(go.handle, out.handle,
                          valid.handle if valid is not None else -1,
                          dx.handle, rows, cols)
        B.add_inplace(x.ensure_grad().handle, dx.handle, x.numel)

    out.requires_grad = is_grad_enabled() and x.requires_grad
    if out.requires_grad:
        out._backward = backward
        out._parents = (x,)
    return out


def attn_apply(probs, v, batch, seq_q, seq_kv, heads, kv_heads, head_dim, out_shape=None):
    """out[b,i,h,:] = Σ_j probs[b,h,i,j] · v[b,j,kh,:]。"""
    shape = out_shape if out_shape is not None else (batch * seq_q, heads * head_dim)
    out = Tensor(shape, probs.dtype, name="attn.out")
    B.attn_apply(probs.handle, v.handle, out.handle,
                 batch, seq_q, seq_kv, heads, kv_heads, head_dim)

    def backward():
        go = out.grad
        if go is None:
            return
        dp = zeros(probs.shape, probs.dtype, name="dprobs")
        dv = zeros(v.shape, v.dtype, name="dv")
        B.attn_apply_bwd(go.handle, probs.handle, v.handle, dp.handle, dv.handle,
                         batch, seq_q, seq_kv, heads, kv_heads, head_dim)
        if probs.requires_grad:
            B.add_inplace(probs.ensure_grad().handle, dp.handle, probs.numel)
        if v.requires_grad:
            B.add_inplace(v.ensure_grad().handle, dv.handle, v.numel)

    out.requires_grad = is_grad_enabled() and (probs.requires_grad or v.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (probs, v)
    return out


# ============================================================ LayerNorm（对照用）


def layer_norm(x, weight, bias, eps=1e-5):
    """对应 `torch.nn.functional.layer_norm`。

    比 RMSNorm 多减一个均值、多一个 bias。现代 LLM 全都换成了 RMSNorm ——
    第 6 关让学员两个都跑一遍，自己看「换掉之后质量没掉、还快了一点」。
    """
    rows, d = _rows(x.shape)
    out = Tensor(x.shape, x.dtype, name="layernorm")
    mean = Tensor((rows,), x.dtype, name="ln.mean")
    inv = Tensor((rows,), x.dtype, name="ln.inv")
    B.layernorm_fwd(x.handle, weight.handle, bias.handle, out.handle,
                    mean.handle, inv.handle, rows, d, eps)

    def backward():
        go = out.grad
        if go is None:
            return
        dx = Tensor(x.shape, x.dtype, name="dlayernorm")
        B.layernorm_bwd(go.handle, x.handle, weight.handle, mean.handle, inv.handle,
                        weight.ensure_grad().handle, bias.ensure_grad().handle,
                        dx.handle, rows, d)
        if x.requires_grad:
            B.add_inplace(x.ensure_grad().handle, dx.handle, x.numel)

    out.requires_grad = is_grad_enabled() and (x.requires_grad or weight.requires_grad)
    if out.requires_grad:
        out._backward = backward
        out._parents = (x, weight, bias)
    return out


# ============================================================ 低精度与诊断


def quantize_(x, dtype):
    """就地把张量舍到 bf16 或 fp16 的可表示集合上。存储仍是 f32。

    浏览器里没有半精度硬件，所以这是**位级模拟** —— 尾数位数与指数范围
    都按真格式来。于是「fp16 会溢出而 bf16 不会」是算出来的：
    bf16 有 8 位指数（和 f32 一样），fp16 只有 5 位，最大值 65504。
    """
    if dtype == "bf16":
        B.quantize_bf16(x.handle, x.numel)
    elif dtype == "fp16":
        B.quantize_fp16(x.handle, x.numel)
    else:
        raise ValueError(f"只支持 bf16 / fp16，拿到 {dtype!r}")
    return x


def count_nonfinite(x):
    """有多少个 NaN / inf。训练炸了的第一手证据。"""
    return B.count_nonfinite(x.handle, x.numel)


def sumsq(x):
    """平方和 `Σ x²`，一个普通的 float。观测量，不进计算图。

    全局梯度范数是 `sqrt(Σ 各张量的 sumsq)` —— 注意是**先把平方和加起来再开方**，
    不是把各自的范数平方回去：`sqrt(s)**2` 和 `s` 在浮点下不是同一个数，
    而裁剪系数是拿这个数除出来的。
    """
    return B.sumsq(x.handle, x.numel)


def adamw_(param, grad, m, v, lr, beta1, beta2, eps, decay, step, clip=1.0):
    """AdamW 的逐元素更新，**就地改 param / m / v**。

    对应真实框架里的融合优化器 kernel（PyTorch 的 `fused=True` / `foreach=True`）。
    一次调用做完：动量更新、偏差修正（分母 `1 − β^step`，`step` 从 1 数起）、
    以及**解耦的**权重衰减（`decay` 不经过 `sqrt(v)`）。

    `clip` 是全局裁剪系数，乘在梯度上。`decay=0` 就是不衰减 ——
    一维参数（norm 的增益、bias）该传 0。
    """
    assert step >= 1, f"偏差修正的 step 从 1 数起，拿到 {step}"
    B.adamw(param.handle, grad.handle, m.handle, v.handle, param.numel,
            lr, beta1, beta2, eps, decay, step, clip)
    return param


def norm(x):
    """L2 范数 `sqrt(Σ x²)`。

    它是个**观测量**，不进计算图 —— 返回的是普通的 float，不是 Tensor。
    看残差流有没有爆、梯度有没有消失，第一个要看的就是它。
    """
    return B.sumsq(x.handle, x.numel) ** 0.5


def rms(x):
    """均方根 `sqrt(mean(x²))`。同样是观测量。

    比 L2 范数更适合跨层比较 —— 它不随元素个数变。
    「第 8 层的激活是第 1 层的几倍」问的就是这个数。
    """
    if x.numel == 0:
        return 0.0
    return (B.sumsq(x.handle, x.numel) / x.numel) ** 0.5
