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
from .tensor import Tensor, zeros


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

    out.requires_grad = a.requires_grad or b.requires_grad
    if out.requires_grad:
        out._backward = backward
        out._parents = (a, b)
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

    out.requires_grad = x.requires_grad or weight.requires_grad
    if out.requires_grad:
        out._backward = backward
        out._parents = (x, weight)
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

    out.requires_grad = x.requires_grad or weight.requires_grad
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

    out.requires_grad = gate.requires_grad or up.requires_grad
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
    out.requires_grad = x.requires_grad

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

    out.requires_grad = q.requires_grad or k.requires_grad or v.requires_grad
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

    out.requires_grad = table.requires_grad
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

    out.requires_grad = x.requires_grad or table.requires_grad
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

    loss.requires_grad = logits.requires_grad
    if loss.requires_grad:
        loss._backward = backward
        loss._parents = (logits,)
    # Python 侧要拿这个数打印曲线，附在张量上省一次跨语言读
    loss.value = value  # type: ignore[attr-defined]
    return loss
