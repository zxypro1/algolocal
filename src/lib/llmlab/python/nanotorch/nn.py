"""模块系统。形状与用法照着 `torch.nn` 来。

学员写的模型长这样：

    class Block(nn.Module):
        def __init__(self, cfg):
            super().__init__()
            self.attn = Attention(cfg)
            self.mlp = MLP(cfg)
        def forward(self, x):
            x = x + self.attn(self.norm1(x))
            return x + self.mlp(self.norm2(x))

—— 和 nanoGPT 里那段是同一个形状，这正是选 Python 的理由。
"""

from . import functional as F
from .tensor import Tensor, parameter, zeros


class Module:
    """所有模块的基类。

    比 `torch.nn.Module` 少很多东西（没有 buffer、没有 hook、没有 train/eval），
    但**参数的收集方式是一样的**：递归遍历子模块。
    """

    def __init__(self):
        self._params = {}
        self._modules = {}

    def __setattr__(self, name, value):
        if isinstance(value, Tensor) and value.requires_grad:
            self.__dict__.setdefault("_params", {})[name] = value
        elif isinstance(value, Module):
            self.__dict__.setdefault("_modules", {})[name] = value
        object.__setattr__(self, name, value)

    def parameters(self):
        """按**确定的顺序**返回全部参数。

        顺序确定这件事不是洁癖：优化器按这个顺序更新，
        而「同一份代码跑两遍逐位一致」要求每一步的浮点运算顺序都一样。
        Python 3.7+ 的 dict 保序，所以这里天然是稳的。
        """
        out = []
        for p in self.__dict__.get("_params", {}).values():
            out.append(p)
        for m in self.__dict__.get("_modules", {}).values():
            out.extend(m.parameters())
        return out

    def named_parameters(self, prefix=""):
        out = []
        for name, p in self.__dict__.get("_params", {}).items():
            out.append((f"{prefix}{name}", p))
        for name, m in self.__dict__.get("_modules", {}).items():
            out.extend(m.named_parameters(f"{prefix}{name}."))
        return out

    def zero_grad(self):
        for p in self.parameters():
            p.zero_grad()

    def num_parameters(self):
        return sum(p.numel for p in self.parameters())

    def forward(self, *args, **kwargs):
        raise NotImplementedError(f"{type(self).__name__} 没有实现 forward()")

    def __call__(self, *args, **kwargs):
        return self.forward(*args, **kwargs)


class Linear(Module):
    """不带 bias 的线性层。

    现代 LLM 的注意力与前馈投影**都不带 bias**（Llama 起就是这样），
    所以这里没有 `bias=` 这个参数 —— 不是省事，是那个选项在这个领域里已经没人用了。
    """

    def __init__(self, in_features, out_features, seed, std=0.02, name="linear"):
        super().__init__()
        self.in_features = in_features
        self.out_features = out_features
        # 存 [in, out]：算子核这么排更自然。模型代码看不到这件事
        self.weight = parameter((in_features, out_features), seed, std, name)

    def forward(self, x):
        return F.linear(x, self.weight)


class RMSNorm(Module):
    """对应 `torch.nn.RMSNorm`。增益从 1 起步，不带 bias。"""

    def __init__(self, dim, eps=1e-5, name="norm"):
        super().__init__()
        self.dim = dim
        self.eps = eps
        self.weight = parameter((dim,), None, 0, name)

    def forward(self, x):
        return F.rms_norm(x, self.weight, self.eps)


class Embedding(Module):
    """词嵌入。`weight` 也当 lm_head 用（权重共享），见 `TiedHead`。"""

    def __init__(self, num_embeddings, dim, seed, std=0.02, name="emb"):
        super().__init__()
        self.num_embeddings = num_embeddings
        self.dim = dim
        self.weight = parameter((num_embeddings, dim), seed, std, name)

    def forward(self, idx, rows):
        return F.embedding(self.weight, idx, rows, self.dim)


def tied_head(embedding, x, rows):
    """logits = x @ emb^T。

    写成函数而不是 Module，是因为它**没有自己的参数** ——
    做成 Module 会让 `parameters()` 把同一份权重数两遍，
    于是优化器更新它两次、参数量也报错。
    """
    return F.linear_tied(x, embedding.weight, rows, embedding.dim, embedding.num_embeddings)


class CausalSelfAttention(Module):
    """多头因果自注意力，支持 GQA。

    形状体操和 nanoGPT 里那段一一对应，只是我们的算子核直接吃
    [B, S, H*hd] 的排布，省掉了 `.view().transpose()` 那两步 ——
    真 PyTorch 里那两步是必须的，第 4 关会讲清为什么以及它们的代价。
    """

    def __init__(self, dim, n_head, n_kv_head, seed, n_layer=1, name="attn"):
        super().__init__()
        assert dim % n_head == 0, f"dim {dim} 不能被 n_head {n_head} 整除"
        assert n_head % n_kv_head == 0, f"n_head {n_head} 不能被 n_kv_head {n_kv_head} 整除"
        self.dim = dim
        self.n_head = n_head
        self.n_kv_head = n_kv_head
        self.head_dim = dim // n_head
        res_std = 0.02 / (2 * n_layer) ** 0.5
        self.wq = Linear(dim, n_head * self.head_dim, seed + 1, 0.02, f"{name}.wq")
        self.wk = Linear(dim, n_kv_head * self.head_dim, seed + 2, 0.02, f"{name}.wk")
        self.wv = Linear(dim, n_kv_head * self.head_dim, seed + 3, 0.02, f"{name}.wv")
        # 残差分支的输出投影按 1/sqrt(2L) 缩：不缩的话残差流的范数随层数线性长
        self.wo = Linear(n_head * self.head_dim, dim, seed + 4, res_std, f"{name}.wo")

    def forward(self, x, cos, sin, batch, seq):
        q = F.rope(self.wq(x), cos, sin, batch, seq, self.n_head, self.head_dim)
        k = F.rope(self.wk(x), cos, sin, batch, seq, self.n_kv_head, self.head_dim)
        v = self.wv(x)
        att = F.scaled_dot_product_attention(
            q, k, v, batch, seq, self.n_head, self.n_kv_head, self.head_dim
        )
        return self.wo(att)


class SwiGLUMLP(Module):
    """门控前馈。三个矩阵：门、上投影、下投影。"""

    def __init__(self, dim, hidden, seed, n_layer=1, name="mlp"):
        super().__init__()
        res_std = 0.02 / (2 * n_layer) ** 0.5
        self.wg = Linear(dim, hidden, seed + 1, 0.02, f"{name}.wg")
        self.wu = Linear(dim, hidden, seed + 2, 0.02, f"{name}.wu")
        self.wd = Linear(hidden, dim, seed + 3, res_std, f"{name}.wd")

    def forward(self, x):
        return self.wd(F.swiglu(self.wg(x), self.wu(x)))
