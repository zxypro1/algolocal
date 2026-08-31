"""Tensor 与反向传播的带（tape）。

## 这是学员要读的第一份代码

它是 PyTorch 的 `torch.Tensor` + `autograd` 在这里的对应物，只是小得多：
**一个 Tensor 记得自己是怎么被算出来的，`backward()` 沿着记录倒着走一遍。**

第 10 关「自动微分引擎」要学员自己把 `backward()` 那一段填回来 ——
所以这份实现是刻意写得可读的，不是刻意写得快的。

## 和 PyTorch 的两处差别（都写在这儿，免得学员到真环境里踩）

1. **没有广播。** 形状必须严格对上。真 PyTorch 会广播，而广播的反向
   （把梯度沿被广播的维求和）是另一件要专门学的事，留到后面。
2. **算子是粗粒度的。** 这里没有 `+` / `*` 逐元素算子的通用组合，
   而是 `rmsnorm` / `swiglu` / `attention` 这样一整块。真 PyTorch 两种都有，
   而融合过的粗算子恰恰是它 `torch.compile` 之后的样子。
"""

from . import _bridge as B


def _prod(shape):
    n = 1
    for d in shape:
        n *= d
    return n


class Tensor:
    """一块数，加上「它是怎么来的」。

    `handle` 是算子核那边的 id；这边只记形状、dtype 和梯度的去向。
    """

    # 用 __slots__ 不是为了省内存，是为了**拼错属性名当场报错**。
    # 训练循环里 `t.grads = ...`（多一个 s）这种笔误，没有 slots 的话会静静地
    # 建一个新属性，然后梯度全是 0 —— 而 loss 照样会降一点点。
    __slots__ = (
        "handle", "shape", "dtype", "role", "requires_grad", "grad",
        "_backward", "_parents", "_name",
        # 标量 loss 顺手带上它的 Python 数值，省一次跨语言读
        "value",
    )

    def __init__(self, shape, dtype="f32", role="activation", name="", handle=None,
                 requires_grad=False):
        self.shape = tuple(shape)
        self.dtype = dtype
        self.role = role
        self._name = name
        self.handle = B.alloc(_prod(self.shape), dtype, role, name) if handle is None else handle
        self.requires_grad = requires_grad
        self.grad = None
        # 反向时调它，把自己的梯度散给上游。叶子节点是 None。
        self._backward = None
        self._parents = ()

    # ---- 基本属性，名字照抄 PyTorch ----

    @property
    def numel(self):
        return _prod(self.shape)

    def dim(self):
        return len(self.shape)

    def size(self, i=None):
        return self.shape if i is None else self.shape[i]

    def __repr__(self):
        g = ", requires_grad=True" if self.requires_grad else ""
        return f"Tensor(shape={self.shape}, dtype={self.dtype}{g})"

    def __add__(self, other):
        """残差连接写成 `x + branch`，和 PyTorch 一样。

        在方法里 import 而不是在文件顶上：`functional` 要 import 这个模块，
        顶上写就成环了。这是 Python 里处理这种双向依赖的常规做法。
        """
        from .functional import add
        return add(self, other)

    def __radd__(self, other):
        # 只为让 `sum(tensors)` 这种写法能用 —— 0 + tensor 直接返回自己
        if other == 0:
            return self
        return self.__add__(other)

    # ---- 数据进出。**只用于小批量**，别拿它搬激活 ----

    def fill_(self, value):
        B.fill(self.handle, value)
        return self

    def copy_(self, other):
        assert other.numel == self.numel, f"copy_ 的两边元素数不一致：{self.shape} vs {other.shape}"
        B.copy(self.handle, other.handle, self.numel)
        return self

    def tolist(self):
        return B.get_f(self.handle, self.numel)

    def item(self, index=0):
        return B.item(self.handle, index)

    def set_(self, values):
        B.set_f(self.handle, values)
        return self

    def set_at_(self, index, value):
        """写单个元素。对应 PyTorch 里的 `t.view(-1)[i] = v`。

        梯度检验一次只扰动一个数,整块重写的话，一次检验要跨语言搬几十万个 float。
        """
        B.set_item(self.handle, index, float(value))
        return self

    def set_int_(self, values):
        """写 token id。整数张量按 4 字节一格存，和 f32 共用同一块。"""
        B.set_i32(self.handle, values)
        return self

    def normal_(self, seed, std=0.02):
        B.fill_normal(self.handle, seed, std)
        return self

    # ---- 梯度 ----

    def ensure_grad(self):
        """按需建出这个张量的梯度。

        **梯度的角色跟着它所属的张量走**：参数的梯度是长期的（每步累加、
        优化器要读），中间激活的梯度是一次性的（这一步反向用完就扔）。

        角色不是标签，它决定这块显存算进哪一条门槛，也决定每步的
        `release` 会不会把它推平。一开始这里给所有梯度都标了 "grad"，
        于是 `dlogits`（一个激活的梯度）被当成长期张量，
        第二步 release 时当场炸 —— 那条守卫把这个错抓得很准。
        """
        if self.grad is None:
            role = "grad" if self.role == "param" else "activation"
            self.grad = Tensor(self.shape, self.dtype, role=role, name=f"d{self._name}")
            self.grad.fill_(0.0)
        return self.grad

    def zero_grad(self):
        if self.grad is not None:
            self.grad.fill_(0.0)

    def backward(self):
        """从这个标量出发，倒着走一遍带。

        只支持标量起点（loss），和 PyTorch 一样 —— 非标量要传 `gradient=`，
        而那件事在这个项目里没有用到，不如不做，省得学员以为它能用。
        """
        assert self.numel == 1, "backward() 只能从标量出发（一般是 loss）"
        # 起点的梯度是 1：d(loss)/d(loss)。和 PyTorch 一样每次都重新播种，
        # 不是「有就不动」—— 上一步残留的值会让这一步的梯度整体偏掉。
        self.ensure_grad().fill_(1.0)
        topo = []
        seen = set()

        def visit(t):
            if id(t) in seen:
                return
            seen.add(id(t))
            for p in t._parents:
                visit(p)
            topo.append(t)

        visit(self)
        B.phase("backward")
        for t in reversed(topo):
            if t._backward is not None:
                t._backward()
        B.phase("other")


# ---- 记不记带 ----
#
# 和 PyTorch 一样是个全局开关，做成栈是因为它要能嵌套。
# 三个地方要用它：评测（不建带就不占显存）、生成（同理）、
# 以及 `autograd.Function.forward` 里面 —— 自定义算子的前向**本身不该被记**，
# 记了的话反向会走两遍：一遍是引擎按 tape 走的，一遍是你自己写的。
_GRAD_ENABLED = [True]


def is_grad_enabled():
    return _GRAD_ENABLED[-1]


class no_grad:
    """`with nt.no_grad():` —— 里面的算子不挂反向。

    对应 `torch.no_grad()`。评测循环、生成循环都该套上它：
    不建带就不会为了反向留住每一层的激活，显存差出好几倍。
    """

    def __enter__(self):
        _GRAD_ENABLED.append(False)
        return self

    def __exit__(self, *exc):
        _GRAD_ENABLED.pop()
        return False


class enable_grad:
    """`with nt.enable_grad():` —— 在 no_grad 里面临时打开。对应 `torch.enable_grad()`。"""

    def __enter__(self):
        _GRAD_ENABLED.append(True)
        return self

    def __exit__(self, *exc):
        _GRAD_ENABLED.pop()
        return False


def zeros(shape, dtype="f32", role="activation", name="", requires_grad=False):
    t = Tensor(shape, dtype, role, name, requires_grad=requires_grad)
    t.fill_(0.0)
    return t


def parameter(shape, seed=None, std=0.02, name="", dtype="f32"):
    """一个要被优化的张量。

    `std=0` 表示常数 1 起步（norm 的增益就是这么初始化的）。

    `dtype="f64"` 是给**梯度检验**用的：中心差分要在 f64 上做，
    fp32 下一个完全正确的反向也会量出 5e-2 的相对误差 —— 噪声比信号大。
    """
    t = Tensor(shape, dtype, role="param", name=name, requires_grad=True)
    if std == 0 or seed is None:
        t.fill_(1.0)
    else:
        t.normal_(seed, std)
    return t
