"""自定义算子：前向和反向都自己写。

形状照着 `torch.autograd.Function` 来：

    class MyLinear(nt.autograd.Function):
        @staticmethod
        def forward(ctx, x, w):
            ctx.save_for_backward(x, w)
            return F.linear(x, w)

        @staticmethod
        def backward(ctx, grad_output):
            x, w = ctx.saved_tensors
            return dx, dw          # 顺序对着 forward 里的张量参数

    y = MyLinear.apply(x, w)

## 三件和 PyTorch 一致、且都有理由的事

**1. `forward` 跑在 `no_grad` 里。** 你在 forward 里照样可以调 `F.linear`，
但那一次调用**不会挂反向** —— 挂了的话反向会走两遍：
一遍是引擎顺着 tape 走的，一遍是你写的 `backward`。
PyTorch 里这件事同样是自动的，只是它藏得更深。

**2. `backward` 收 `grad_output`，返回每个输入的梯度。**
返回值按 `forward` 里**张量参数的顺序**一一对应；不需要梯度的位置返回 `None`。
（PyTorch 要求非张量参数的位置也返回 `None`，这里只按张量参数对齐 ——
这是本实现唯一简化掉的一处，写在这里免得你换到真 PyTorch 时踩空。）

**3. 梯度是累加进去的，不是赋值。** 同一个张量可能被好几处用到，
每一处都要把自己那份加上去。赋值的话后一处会把前一处覆盖掉，
而这种错**只有在计算图有分叉时才出现** —— 单链的表达式上一切正常。
"""

from . import _bridge as B
from .tensor import Tensor, is_grad_enabled, no_grad


class Context:
    """`ctx` —— 前向存给反向的那点东西。对应 PyTorch 的 `ctx`。"""

    def __init__(self):
        self.saved_tensors = ()

    def save_for_backward(self, *tensors):
        """存下反向要用的张量。

        PyTorch 里这个方法存在的理由是内存：**没被存下来的中间结果可以立刻释放**。
        在这里理由一样 —— 竞技场按 mark/release 推平，
        存进 ctx 的那几个才是这一步反向真正需要留着的。
        """
        self.saved_tensors = tensors
        return self


class Function:
    """自定义算子的基类。子类实现 `forward` 与 `backward` 两个静态方法。"""

    @staticmethod
    def forward(ctx, *args, **kwargs):
        raise NotImplementedError("自定义算子要实现 forward(ctx, ...)")

    @staticmethod
    def backward(ctx, grad_output):
        raise NotImplementedError("自定义算子要实现 backward(ctx, grad_output)")

    @classmethod
    def apply(cls, *args, **kwargs):
        ctx = Context()
        inputs = [a for a in args if isinstance(a, Tensor)]

        # 前向本身不记带 —— 见文件开头第 1 条
        with no_grad():
            out = cls.forward(ctx, *args, **kwargs)

        needs = any(t.requires_grad for t in inputs)
        if not (needs and is_grad_enabled()):
            return out

        def _backward():
            go = out.grad
            if go is None:
                return
            grads = cls.backward(ctx, go)
            if not isinstance(grads, (tuple, list)):
                grads = (grads,)
            if len(grads) != len(inputs):
                raise ValueError(
                    f"{cls.__name__}.backward 返回了 {len(grads)} 个梯度，"
                    f"但 forward 收了 {len(inputs)} 个张量参数 —— 要一一对应"
                )
            for t, g in zip(inputs, grads):
                if g is None or not t.requires_grad:
                    continue
                if g.numel != t.numel:
                    raise ValueError(
                        f"{cls.__name__}.backward 给 {t.name or '某个输入'} 的梯度是 "
                        f"{g.numel} 个元素，而它本身有 {t.numel} 个"
                    )
                # 累加，不是赋值 —— 见文件开头第 3 条
                B.add_inplace(t.ensure_grad().handle, g.handle, t.numel)

        out.requires_grad = True
        out._backward = _backward
        out._parents = tuple(inputs)
        return out
