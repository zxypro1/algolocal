"""训练日志。写法照着 wandb / tensorboard 来。

    for step in range(1, STEPS + 1):
        ...
        nt.log.step(step, loss=loss.value, lr=lr, grad_norm=gn)

面板实时画它，结果面板事后展示它。

## 它不是门槛的来源

日志是**你自愿写的** —— 可以少写、写错、甚至不写。所以门槛读的不是它，
而是算子层数出来的那棵计量树（FLOPs、显存、禁用算子），你绕不过。

日志负责两件别的事：**让人看见**（loss 到底降没降、梯度炸没炸），
以及给「本来就该由你报告的量」一个落点 —— 比如你自己算的评测结果。
"""

from . import _bridge as B


def step(step, loss=float("nan"), lr=float("nan"), grad_norm=float("nan"),
         val_loss=float("nan"), tokens=0):
    """记一步。参数名与真实训练脚本里常见的写法一致。"""
    B.log_step(step, loss, lr, grad_norm, val_loss, tokens)


def scalar(name, step, value):
    """记一条自定义曲线（困惑度、准确率、KL、奖励均值……）。"""
    B.log_scalar(name, step, value)


def sample(text, step=0, group="default", logprobs=None,
           reward=float("nan"), advantage=float("nan")):
    """记一条生成样例。

    `group` 用来分栏：`pretrain` / `sft` / `chosen` / `rejected` / `rollout`。
    `logprobs` 给每个 token 一个数，面板按它给文字着色 ——
    **模型在哪几个词上没把握，一眼就看得到**，而那正是调试生成质量的入口。
    """
    B.log_sample(step, group, text, list(logprobs or []), reward, advantage)


def attention(probs, batch, heads, seq_len, step=0, layer=0, head=0, tokens=None):
    """记一张注意力热图。

    只取 (batch=0, layer, head) 那一片 —— 整块 [B,H,S,S] 是几十万个数，
    而面板一次只画一张。

    **因果掩码写错的话，右上三角会亮起来**，一眼就看得见；
    归纳头学成之后，对角线偏移那条亮带会自己长出来。
    """
    B.log_attention(step, layer, head, probs.handle, batch, heads, seq_len,
                    list(tokens or []))


def histogram(tensor, name, step=0):
    """记一组数的分布（激活、梯度、权重）。

    pre-norm 去掉之后深层激活范数怎么爆的、梯度裁剪前后分布怎么变的、
    bf16 与 fp16 的动态范围差在哪 —— 全是直方图上一眼的事。
    """
    B.log_histogram(step, name, tensor.handle)


def report(key, value):
    """报告一个结构化的结果（判定也读得到）。"""
    import json
    B.log_report(key, json.dumps(value))


def clear():
    """清空。换一次运行前调一下，免得两次的曲线接在一起。"""
    B.log_clear()
