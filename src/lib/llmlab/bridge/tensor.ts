/**
 * 张量与竞技场式分配器
 *
 * 算子核只认「一段数」。这一层给那段数配上形状、dtype 和一个 id，
 * 于是上面（TS 的参考模型、以及后面 Python 里的 nanotorch）能按张量思考。
 *
 * ## 为什么分配器长这样
 *
 * 训练循环的分配模式极其规整：一步之内建一堆中间张量，一步结束全都不要了。
 * 参数、梯度、优化器状态是长期的；激活是一次性的。所以这里是
 * **两段式竞技场**：长期的从底往上排，一次性的从一个 mark 之后排，
 * 每步结束 `release(mark)` 一把推平。
 *
 * 不做通用的 free/合并：那要维护空闲链、处理碎片，而我们**根本没有那个问题** ——
 * 一步的分配顺序每次都一样，逐位可复现也正需要它一样。
 *
 * ## dtype
 *
 * 只有 f32 与 f64，没有 bf16 / fp16 —— 后两者是**按位模拟**的，
 * 存储仍然是 f32，只是每次写入过一遍舍入（那是第 17 关的内容，还没到）。
 */
import type { Kernels } from '../kernels';

export type DType = 'f32' | 'f64';

export const DTYPE_BYTES: Record<DType, number> = { f32: 4, f64: 8 };

/**
 * 张量的生命周期类别 —— 决定它算进哪一条显存门槛。
 *
 * `param` / `grad` / `optimizer` 是长期的，`activation` 是一次性的。
 * 第 17、18 关的门槛读的是 `memory.peakActivationBytes`，
 * 也就是只数 `activation` 那一类的峰值 —— 把参数一起算进去的话，
 * 「激活重算省了多少」这件事会被参数的常数项稀释掉。
 */
export type TensorRole = 'param' | 'grad' | 'optimizer' | 'activation' | 'data';

export interface Tensor {
  readonly id: number;
  readonly shape: readonly number[];
  readonly dtype: DType;
  readonly role: TensorRole;
  /** 相对算子核堆基址的字节偏移 */
  readonly off: number;
  /** 元素个数 */
  readonly count: number;
  readonly bytes: number;
  /** 调试用的名字，出现在报错和显存分解里 */
  readonly name: string;
}

export function numel(shape: readonly number[]): number {
  let n = 1;
  for (const d of shape) {
    if (!Number.isInteger(d) || d < 0) throw new Error(`形状里有非法的维度：${JSON.stringify(shape)}`);
    n *= d;
  }
  return n;
}

export interface ArenaStats {
  /** 当前占用的字节数 */
  currentBytes: number;
  /** 历史峰值 */
  peakBytes: number;
  /** 只数 activation 的当前值与峰值 —— 第 17/18 关的门槛读它 */
  currentActivationBytes: number;
  peakActivationBytes: number;
  /** 按角色分的当前占用，给显存分解面板 */
  byRole: Record<TensorRole, number>;
  /** 按名字分的参数量，给「参数量 = 解析式」那条门槛 */
  liveTensors: number;
}

export class Arena {
  private readonly kernels: Kernels;
  private nextId = 1;
  private readonly live = new Map<number, Tensor>();
  private cur = 0;
  private peak = 0;
  private curAct = 0;
  private peakAct = 0;
  private readonly roleBytes: Record<TensorRole, number> = {
    param: 0, grad: 0, optimizer: 0, activation: 0, data: 0,
  };

  constructor(kernels: Kernels) {
    this.kernels = kernels;
  }

  alloc(
    shape: readonly number[],
    dtype: DType = 'f32',
    role: TensorRole = 'activation',
    name = ''
  ): Tensor {
    const count = numel(shape);
    const bytes = count * DTYPE_BYTES[dtype];
    const off = this.kernels.alloc(bytes);
    const tensor: Tensor = {
      id: this.nextId++, shape: [...shape], dtype, role, off, count, bytes, name,
    };
    this.live.set(tensor.id, tensor);
    this.cur += bytes;
    this.roleBytes[role] += bytes;
    if (this.cur > this.peak) this.peak = this.cur;
    if (role === 'activation') {
      this.curAct += bytes;
      if (this.curAct > this.peakAct) this.peakAct = this.curAct;
    }
    return tensor;
  }

  /** 分配并清零 */
  zeros(shape: readonly number[], dtype: DType = 'f32', role: TensorRole = 'activation', name = ''): Tensor {
    const t = this.alloc(shape, dtype, role, name);
    this.view(t).fill(0);
    return t;
  }

  /** 当前的分配位置。配合 release 做一步一放 */
  mark(): number {
    return this.kernels.mark();
  }

  /**
   * 把分配指针推回 mark，并把之后建的张量全部作废。
   *
   * 作废之后再用那些张量是**用错了**，所以这里真的把它们从 live 里删掉，
   * `view()` 会报一个说得清的错，而不是安静地读到别人的数据。
   */
  release(mark: number): void {
    /*
     * **长期张量落在 mark 之后 = mark 取早了。**
     *
     * 参数、梯度、优化器状态、以及语料这类常驻数据都该在取 mark 之前分配好，
     * 之后每步 release 掉的只有激活。搞反了的表现极其难查：
     * 下一步用到那个张量时报「没有 id 为 N 的张量」，而 N 是个没有来历的数字，
     * 现场离出错的原因（mark 取在了哪一行）已经很远了。
     *
     * 所以这里当场拦下来，并且说清是哪一个张量、什么角色。
     * 这是我自己在写竖切时踩的第一个坑：AdamW 的梯度是懒分配的，
     * 于是它们落在了 mark 之后，第二步就被推平了。
     */
    for (const t of this.live.values()) {
      if (t.off >= mark && t.role !== 'activation') {
        throw new Error(
          `release 会丢掉长期张量「${t.name || `#${t.id}`}」（角色 ${t.role}）——` +
          'mark 取早了。参数 / 梯度 / 优化器状态 / 常驻数据都要在 mark 之前分配好，' +
          '每步只 release 激活。'
        );
      }
    }
    for (const [id, t] of this.live) {
      if (t.off >= mark) {
        this.live.delete(id);
        this.cur -= t.bytes;
        this.roleBytes[t.role] -= t.bytes;
        this.curAct -= t.bytes;   // 走到这里的必然是 activation（上面已拦下其余角色）
      }
    }
    this.kernels.reset(mark);
  }

  /**
   * 按 id 取张量。
   *
   * Python 侧只拿得到 id（一个整数）—— 真正的数留在 wasm 内存里，
   * 不跨语言边界搬。所以那一层的每次调用都从这里换回张量。
   * 取不到就是用了一个已经 release 掉的 id，报得清清楚楚。
   */
  get(id: number): Tensor {
    const t = this.live.get(id);
    if (!t) throw new Error(`没有 id 为 ${id} 的张量（可能已经被 release 了）`);
    return t;
  }

  view(t: Tensor): Float32Array | Float64Array {
    if (!this.live.has(t.id)) {
      throw new Error(`张量 #${t.id}${t.name ? `（${t.name}）` : ''} 已经被 release 掉了，不能再用`);
    }
    return t.dtype === 'f32'
      ? this.kernels.f32(t.off, t.count)
      : this.kernels.f64(t.off, t.count);
  }

  /** i32 视图，给 token id 与 loss mask 用 */
  i32(t: Tensor): Int32Array {
    if (t.dtype !== 'f32') throw new Error('i32 视图只能建在按 4 字节分配的张量上');
    return this.kernels.i32(t.off, t.count);
  }

  stats(): ArenaStats {
    return {
      currentBytes: this.cur,
      peakBytes: this.peak,
      currentActivationBytes: this.curAct,
      peakActivationBytes: this.peakAct,
      byRole: { ...this.roleBytes },
      liveTensors: this.live.size,
    };
  }

  /**
   * 把峰值清零，但不动当前占用。
   *
   * 用在「量这一步的激活峰值」上：参数与优化器状态是上一步就在的，
   * 不该记进这一步的峰值里 —— 否则第 18 关「激活重算把峰值按下去」
   * 会被参数那个常数项稀释成看不出来。
   */
  resetPeak(): void {
    this.peak = this.cur;
    this.peakAct = this.curAct;
  }
}
