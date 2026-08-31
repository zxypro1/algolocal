"""自回归采样与 KV cache。

第 8 关的内容。这里给的是**零件**，拼起来是学员的事：

- `KVCache` —— 一块预分配的 K/V，按位置追加
- `sample` —— temperature / top-k / top-p，确定性
- `greedy` —— argmax

## 为什么 KV cache 不是「优化」，是「必须」

不带 cache 的解码，每生成一个 token 都要把整段前缀重算一遍：
第 t 步的代价是 O(t)，生成 n 个 token 是 O(n²)。
带 cache 之后每步是 O(1)，n 个 token 是 O(n)。

平台数得到这件事：`llm.flops.generatePerToken` **与已生成长度无关**
才算过关。而这条门槛也是第 27 关（GRPO 的 rollout）能不能在预算里跑完的前提 ——
不做 cache，那一关**真的跑不完**，不是人为设的障碍。
"""

from . import _bridge as B
from .tensor import Tensor, zeros


class KVCache:
    """一层的 K/V 缓存。

    形状是 [batch, max_seq, kv_heads * head_dim]，按位置追加。
    真实推理引擎里这块是**分页**的（vLLM 的 PagedAttention），
    那是 gpulab 第 18 关的内容；这里先做连续的那版。
    """

    def __init__(self, batch, max_seq, kv_heads, head_dim, dtype="f32"):
        self.batch = batch
        self.max_seq = max_seq
        self.kv_heads = kv_heads
        self.head_dim = head_dim
        self.width = kv_heads * head_dim
        # role="data"：整段生成里都在，不该被每步的 release 推平
        self.k = zeros((batch, max_seq, self.width), dtype, role="data", name="kv.k")
        self.v = zeros((batch, max_seq, self.width), dtype, role="data", name="kv.v")
        self.length = 0

    def reset(self):
        self.length = 0

    def append(self, k_new, v_new, n_new):
        """把 `n_new` 个位置的 k/v 追加进来。

        `k_new` 的形状是 [batch, n_new, width]，按 batch 分段拷 ——
        因为缓存里同一个 batch 的位置是连续的，而新来的这几个在 batch 之间是隔开的。
        写错这一步的表现是「第二个样本读到了第一个样本的历史」，
        而 loss 看着还挺正常。
        """
        assert self.length + n_new <= self.max_seq, \
            f"KV cache 满了：已有 {self.length}，又要塞 {n_new}，上限 {self.max_seq}"
        for b in range(self.batch):
            dst = (b * self.max_seq + self.length) * self.width
            src = b * n_new * self.width
            B.copy_at(self.k.handle, dst, k_new.handle, src, n_new * self.width)
            B.copy_at(self.v.handle, dst, v_new.handle, src, n_new * self.width)
        self.length += n_new
        return self.length


def sample(logits, row, vocab, temperature=1.0, top_k=0, top_p=0.0, seed=0):
    """从一行 logits 里采一个 token。

    参数名与 HuggingFace 的 `generate()` 一致，叠加顺序也一致：先 top-k 后 top-p。
    `temperature=0` 等价于贪心。

    **确定性**：结果只由 (logits, seed) 决定。概率相同的候选按 token id 排序，
    否则同一份输入两次可能采到不同的词 —— 那会让整条重放链失效。
    """
    return B.sample_token(logits.handle, row, vocab, temperature, top_k, top_p, seed)


def greedy(logits, row, vocab):
    """取概率最大的那个。等价于 `sample(..., temperature=0)`。"""
    return B.argmax_row(logits.handle, row, vocab)
