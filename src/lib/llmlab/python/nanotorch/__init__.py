"""nanotorch —— PyTorch 的一个严格子集，跑在 WebAssembly 上。

学员在这里写的代码，贴进 PyTorch 就能跑：模块的组织方式、算子的名字、
优化器的参数、训练循环的形状，全是一样的。

    import nanotorch as nt
    from nanotorch import nn, functional as F

    class Block(nn.Module):
        def __init__(self, cfg):
            super().__init__()
            self.norm1 = nn.RMSNorm(cfg.dim)
            self.attn = nn.CausalSelfAttention(cfg.dim, cfg.n_head, cfg.n_kv_head, seed=1)
        def forward(self, x, cos, sin, b, s):
            return x + self.attn(self.norm1(x), cos, sin, b, s)

## 和 PyTorch 的差别（就这几条，其余都一样）

| | nanotorch | PyTorch |
| --- | --- | --- |
| 广播 | **没有**，形状必须严格对上 | 有 |
| dtype | f32 / f64 | 十几种 |
| 设备 | 只有一个（wasm 线性内存） | cpu / cuda / … |
| 算子粒度 | 粗（rmsnorm / attention 各一整块） | 粗细都有 |
| 权重排布 | `Linear` 存 [in, out] | 存 [out, in] |

**为什么慢的地方它就是慢**：纯 Python 的循环比 JS 慢约 300 倍（实测 16 MFLOP/s）。
所以代码必须向量化 —— 而现实里也是这条规矩，没有人在 PyTorch 里逐元素写 for 循环。

## 实现分几层

    nanotorch/          ← 你现在读的这一层，Python，看得见改得动
      tensor.py         Tensor 与反向传播的带
      functional.py     算子 + 它们各自的反向
      nn.py             Module / Linear / RMSNorm / Embedding / 注意力 / MLP
      optim.py          AdamW 与学习率调度
      generate.py       自回归采样与 KV cache
      _bridge.py        往下的那道缝（只传整数 id，不搬数）
         ↓
    JS 桥               张量、显存、**全部计量**
         ↓
    WASM 算子核         37KB，f32 带 SIMD（实测 37–42 GFLOP/s）

这个分层和 PyTorch 自己的结构是同一个形状（Python 前端 + C++ kernel），
不是为了偷懒发明的。
"""

from .tensor import Tensor, zeros, parameter
from . import functional
from . import functional as F
from . import nn
from . import optim
from . import generate
from ._bridge import phase, add_tokens, mark, release

__all__ = [
    "Tensor", "zeros", "parameter",
    "functional", "F", "nn", "optim", "generate",
    "phase", "add_tokens", "mark", "release",
]

__version__ = "0.1.0"
