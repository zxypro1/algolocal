"""和算子核之间的那一层。

学员不需要读这个文件，但**读了也不亏** —— 它就是 PyTorch 里
`torch._C` 那一层在我们这儿的对应物：Python 只管形状与调度，
真正的浮点数始终躺在 wasm 的线性内存里，这边拿到的只是一个整数 id。

跨语言搬一个 [256, 64] 的张量要几万次转换；搬一个整数是 1.05 µs。
一步训练约 150 次调用，合计 0.22 ms —— 相对一步 5.6 ms 是噪声。
这条路能成立全靠这个划法。
"""

# JS 侧用 registerJsModule 注册进来的桥。
# 不走 `import js` + globalThis：那样同一个进程里的多个运行时会互相覆盖。
import llmlab_bridge as _B


def alloc(count, dtype="f32", role="activation", name=""):
    return _B.alloc(count, dtype, role, name)


def mark():
    return _B.mark()


def release(m):
    _B.release(m)


def phase(name):
    """标一下现在处在前向 / 反向 / 优化器的哪一段。

    门槛要分开读三段的 FLOPs（比如「反向不许超过前向的 2.2 倍」），
    所以这个标记不是可有可无的装饰。
    """
    _B.phase(name)


def add_tokens(n):
    _B.add_tokens(n)


def set_i32(handle, values):
    _B.set_i32(handle, values)


def set_f(handle, values):
    _B.set_f(handle, values)


def get_f(handle, count):
    return list(_B.get_f(handle, count))


def item(handle, index=0):
    return _B.item(handle, index)


def fill(handle, value):
    _B.fill(handle, value)


def fill_normal(handle, seed, std):
    _B.fill_normal(handle, seed, std)


def fill_rope(cos_h, sin_h, block_size, head_dim, base):
    _B.fill_rope(cos_h, sin_h, block_size, head_dim, base)


# ---- 算子。参数与 JS 那边一一对应，不做任何加工 ----

set_item = _B.set_item
fill_one_hot = _B.fill_one_hot
gemm_nn = _B.gemm_nn
gemm_tn_acc = _B.gemm_tn_acc
gemm_nt = _B.gemm_nt
add_inplace = _B.add_inplace
scale_inplace = _B.scale_inplace
copy = _B.copy
sumsq = _B.sumsq
rmsnorm_fwd = _B.rmsnorm_fwd
rmsnorm_bwd = _B.rmsnorm_bwd
swiglu_fwd = _B.swiglu_fwd
swiglu_bwd = _B.swiglu_bwd
rope_fwd = _B.rope_fwd
rope_bwd = _B.rope_bwd
attn_fwd = _B.attn_fwd
attn_bwd = _B.attn_bwd
cross_entropy = _B.cross_entropy
cross_entropy_bwd = _B.cross_entropy_bwd
embed_fwd = _B.embed_fwd
embed_bwd = _B.embed_bwd
adamw = _B.adamw


# ---- 第 3 关起要用的：拆开的注意力、行 softmax、低精度、采样 ----

attn_scores = _B.attn_scores
attn_scores_bwd = _B.attn_scores_bwd
attn_apply = _B.attn_apply
attn_apply_bwd = _B.attn_apply_bwd
softmax_rows = _B.softmax_rows
softmax_rows_bwd = _B.softmax_rows_bwd
layernorm_fwd = _B.layernorm_fwd
layernorm_bwd = _B.layernorm_bwd
quantize_bf16 = _B.quantize_bf16
quantize_fp16 = _B.quantize_fp16
count_nonfinite = _B.count_nonfinite
fill_causal_valid = _B.fill_causal_valid
sample_token = _B.sample_token
argmax_row = _B.argmax_row
copy_at = _B.copy_at

# ---- 训练日志 ----
log_step = _B.log_step
log_scalar = _B.log_scalar
log_sample = _B.log_sample
log_attention = _B.log_attention
log_histogram = _B.log_histogram
log_report = _B.log_report
log_clear = _B.log_clear
