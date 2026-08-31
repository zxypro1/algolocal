"""优化器。参数名与默认值对着 `torch.optim.AdamW`。

第 12 关要学员自己把 `step()` 写出来，所以这份实现是参考解，
不是学员一开始就能看到的东西。
"""

from . import _bridge as B
from .tensor import Tensor


class AdamW:
    """解耦权重衰减的 Adam。

    `betas=(0.9, 0.95)` 而不是 PyTorch 默认的 `(0.9, 0.999)` ——
    LLM 预训练普遍用 0.95，因为二阶动量跟得太慢时 loss 尖峰更难恢复。
    这是这个领域的惯例，不是我们的发明。

    **一维参数不做权重衰减。** norm 的增益、以及（如果有的话）bias
    都属于这一类。把增益一起衰减掉，它会慢慢塌向 0，
    而 loss 在前几百步看不出区别 —— 第 12 关的探针查的就是这个。
    """

    def __init__(self, params, lr=3e-3, betas=(0.9, 0.95), eps=1e-8,
                 weight_decay=0.1, grad_clip=1.0):
        self.params = list(params)
        self.lr = lr
        self.beta1, self.beta2 = betas
        self.eps = eps
        self.weight_decay = weight_decay
        self.grad_clip = grad_clip
        self.t = 0
        # 一阶与二阶动量，跟参数一一对应。role='optimizer' 让它们出现在
        # `llm.memory.optimizerStateBytes` 里 —— AdamW 的 2× 状态是显存关的主角之一
        self._m = [Tensor(p.shape, p.dtype, role="optimizer", name="m") for p in self.params]
        self._v = [Tensor(p.shape, p.dtype, role="optimizer", name="v") for p in self.params]
        for t in self._m + self._v:
            t.fill_(0.0)
        # **梯度也在这里分配掉**，不留到第一次反向。
        # 梯度是长期张量：训练循环每步 release 一次激活，而懒分配出来的梯度
        # 会落在那个 mark 之后，第二步就被推平了（写竖切时踩的第一个坑）。
        for p in self.params:
            p.ensure_grad()

    def zero_grad(self):
        for p in self.params:
            p.zero_grad()

    def grad_norm(self):
        """全局梯度范数。裁剪与诊断都读它。"""
        total = 0.0
        for p in self.params:
            if p.grad is not None:
                total += B.sumsq(p.grad.handle, p.numel)
        return total ** 0.5

    def step(self, lr=None):
        """走一步，返回**裁剪前**的梯度范数。

        返回裁剪前的值是有意的：训练曲线要看的是梯度本来有多大，
        而不是裁完之后那个恒等于 clip 的数。
        """
        B.phase("optimizer")
        self.t += 1
        rate = self.lr if lr is None else lr
        norm = self.grad_norm()
        scale = 1.0
        if self.grad_clip > 0 and norm > self.grad_clip:
            scale = self.grad_clip / norm

        for i, p in enumerate(self.params):
            if p.grad is None:
                continue
            # 一维的不衰减，见类文档
            decay = self.weight_decay if len(p.shape) > 1 else 0.0
            B.adamw(p.handle, p.grad.handle, self._m[i].handle, self._v[i].handle, p.numel,
                    rate, self.beta1, self.beta2, self.eps, decay, self.t, scale)
        B.phase("other")
        return norm


def cosine_with_warmup(step, total, base_lr, warmup=None, floor=0.1):
    """warmup 之后余弦退火 —— LLM 预训练最常见的那条曲线。

    没有 warmup 的话开头几步的梯度会把权重推得很远，loss 尖峰甚至发散。
    第 13 关的对照组就是「把 warmup 关掉」。
    """
    if warmup is None:
        warmup = max(1, total // 40)
    if step <= warmup:
        return base_lr * step / warmup
    import math
    progress = (step - warmup) / max(1, total - warmup)
    return base_lr * (floor + (1 - floor) * 0.5 * (1 + math.cos(math.pi * progress)))
