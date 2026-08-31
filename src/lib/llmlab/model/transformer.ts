/**
 * 参考实现的 transformer：RoPE + GQA + pre-norm RMSNorm + SwiGLU + 权重共享
 *
 * 架构按 2026 年的共识核心块（见 design/llmlab-stack.md 一节 1.1）——
 * Llama / Mistral / Gemma / Qwen / Phi 各自独立收敛到的那一套。
 *
 * ## 这份代码在项目里干什么
 *
 * **它不是学员要写的东西**（那份是 Python 里的 nanotorch）。它是平台自己的
 * 参考实现，三个用途：
 *
 * 1. **参考答案**：`@llm/lab` 的 `reference()` 拿它在 f64 里算标准输出
 * 2. **出题**：录 baseline（参考解与朴素解各跑一遍，两个数都写进题面）、
 *    生成后训练各关要用的预训练检查点
 * 3. **回归**：证明「算子核 + JS 桥」这一整条路真的能把 loss 训下去 ——
 *    在 Python 那一层接进来之前，这是唯一的端到端证据
 *
 * ## 一个刻意的选择：手写反向，不做自动微分
 *
 * 自动微分是**学员第 10 关要写的东西**。参考实现这边手写，
 * 换来的是一条完全独立的验算路径：将来 nanotorch 的 autograd 写错了，
 * 拿它对一下就知道。两边用同一个引擎会让这个交叉验证失效。
 */
import type { Runtime } from '../bridge';
import type { Tensor } from '../bridge';
import type { DType } from '../bridge';

export interface ModelConfig {
  vocabSize: number;
  dModel: number;
  nLayer: number;
  nHead: number;
  nKvHead: number;
  hidden: number;
  blockSize: number;
  ropeBase?: number;
  dtype?: DType;
  seed?: number;
  /** RMSNorm 的 eps，与 Llama 一致 */
  eps?: number;
}

interface LayerParams {
  g1: Tensor; wq: Tensor; wk: Tensor; wv: Tensor; wo: Tensor;
  g2: Tensor; wg: Tensor; wu: Tensor; wd: Tensor;
}

interface LayerBuffers {
  xin: Tensor; h1: Tensor; inv1: Tensor;
  q: Tensor; k: Tensor; v: Tensor; att: Tensor; ao: Tensor;
  post: Tensor; h2: Tensor; inv2: Tensor;
  gate: Tensor; up: Tensor; act: Tensor;
}

/** 确定性 RNG。xorshift32 + Box-Muller，和原型里那份同一套 */
function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  return {
    uniform: next,
    normal(): number {
      let u = 0, v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

export class Transformer {
  readonly cfg: Required<Omit<ModelConfig, 'dtype' | 'seed'>> & { dtype: DType; seed: number };
  readonly headDim: number;
  readonly params: Tensor[] = [];
  readonly grads: Tensor[] = [];
  readonly names: string[] = [];
  private readonly moment1: Tensor[] = [];
  private readonly moment2: Tensor[] = [];

  private emb!: Tensor;
  private layers: LayerParams[] = [];
  private gf!: Tensor;
  private cos!: Tensor;
  private sin!: Tensor;

  /** 一次前向的中间量。alloc 之后固定，每步复用 —— 分配顺序一样才逐位可复现 */
  private buf: {
    batch: number;
    rows: number;
    x: Tensor; xf: Tensor; hf: Tensor; invf: Tensor;
    logits: Tensor; probs: Tensor;
    tmp: Tensor; tmp2: Tensor; tmp3: Tensor;
    dx: Tensor; dy: Tensor; dh: Tensor;
    dq: Tensor; dk: Tensor; dv: Tensor; dp: Tensor;
    dgate: Tensor; dup: Tensor;
    idx: Tensor; tgt: Tensor;
    layers: LayerBuffers[];
  } | null = null;

  constructor(private readonly rt: Runtime, cfg: ModelConfig) {
    this.cfg = {
      vocabSize: cfg.vocabSize,
      dModel: cfg.dModel,
      nLayer: cfg.nLayer,
      nHead: cfg.nHead,
      nKvHead: cfg.nKvHead,
      hidden: cfg.hidden,
      blockSize: cfg.blockSize,
      ropeBase: cfg.ropeBase ?? 10000,
      eps: cfg.eps ?? 1e-5,
      dtype: cfg.dtype ?? 'f32',
      seed: cfg.seed ?? 1337,
    };
    if (this.cfg.dModel % this.cfg.nHead !== 0) {
      throw new Error(`dModel ${this.cfg.dModel} 不能被 nHead ${this.cfg.nHead} 整除`);
    }
    if (this.cfg.nHead % this.cfg.nKvHead !== 0) {
      throw new Error(`nHead ${this.cfg.nHead} 不能被 nKvHead ${this.cfg.nKvHead} 整除`);
    }
    this.headDim = this.cfg.dModel / this.cfg.nHead;
    if (this.headDim % 2 !== 0) throw new Error(`头维 ${this.headDim} 必须是偶数（RoPE 要成对旋转）`);
    this.build();
  }

  /**
   * 参数量的解析式。
   *
   * 第 4、7 关的门槛就是拿它和实际数对：**必须相等，不是「差不多」**。
   * 少了残差、多了一份 bias、GQA 的 kv 投影按 nHead 而不是 nKvHead 开，
   * 三种错误在这个数上都是立刻可见的。
   */
  static paramCount(cfg: ModelConfig): number {
    const hd = cfg.dModel / cfg.nHead;
    const perLayer =
      cfg.dModel                                  // g1
      + cfg.dModel * cfg.nHead * hd               // wq
      + cfg.dModel * cfg.nKvHead * hd             // wk
      + cfg.dModel * cfg.nKvHead * hd             // wv
      + cfg.nHead * hd * cfg.dModel               // wo
      + cfg.dModel                                // g2
      + cfg.dModel * cfg.hidden                   // wg
      + cfg.dModel * cfg.hidden                   // wu
      + cfg.hidden * cfg.dModel;                  // wd
    return cfg.vocabSize * cfg.dModel             // 词嵌入（与 lm_head 共享）
      + cfg.nLayer * perLayer
      + cfg.dModel;                               // 最后那层 norm 的增益
  }

  get paramCount(): number {
    return this.params.reduce((n, t) => n + t.count, 0);
  }

  paramsByModule(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < this.params.length; i++) {
      const key = this.names[i].replace(/^layers\.\d+\./, 'layer.');
      out[key] = (out[key] ?? 0) + this.params[i].count;
    }
    return out;
  }

  private param(shape: number[], std: number, name: string, rng: ReturnType<typeof makeRng>): Tensor {
    const t = this.rt.arena.alloc(shape, this.cfg.dtype, 'param', name);
    const view = this.rt.arena.view(t);
    if (std === 0) {
      view.fill(1);   // norm 的增益从 1 开始
    } else {
      for (let i = 0; i < t.count; i++) view[i] = rng.normal() * std;
    }
    this.params.push(t);
    this.names.push(name);
    this.grads.push(this.rt.arena.zeros(shape, this.cfg.dtype, 'grad', `d${name}`));
    this.moment1.push(this.rt.arena.zeros(shape, this.cfg.dtype, 'optimizer', `m.${name}`));
    this.moment2.push(this.rt.arena.zeros(shape, this.cfg.dtype, 'optimizer', `v.${name}`));
    return t;
  }

  private build(): void {
    const { vocabSize, dModel, nLayer, nHead, nKvHead, hidden, blockSize, ropeBase, dtype } = this.cfg;
    const hd = this.headDim;
    const rng = makeRng(this.cfg.seed);
    const std = 0.02;
    /*
     * 残差分支的输出投影按 1/sqrt(2L) 缩：不缩的话残差流的范数随层数线性长，
     * 深一点就发散。第 6 关会让学员在「逐层范数」那张图上亲眼看到。
     */
    const resStd = std / Math.sqrt(2 * nLayer);

    this.emb = this.param([vocabSize, dModel], std, 'emb', rng);
    for (let l = 0; l < nLayer; l++) {
      this.layers.push({
        g1: this.param([dModel], 0, `layers.${l}.g1`, rng),
        wq: this.param([dModel, nHead * hd], std, `layers.${l}.wq`, rng),
        wk: this.param([dModel, nKvHead * hd], std, `layers.${l}.wk`, rng),
        wv: this.param([dModel, nKvHead * hd], std, `layers.${l}.wv`, rng),
        wo: this.param([nHead * hd, dModel], resStd, `layers.${l}.wo`, rng),
        g2: this.param([dModel], 0, `layers.${l}.g2`, rng),
        wg: this.param([dModel, hidden], std, `layers.${l}.wg`, rng),
        wu: this.param([dModel, hidden], std, `layers.${l}.wu`, rng),
        wd: this.param([hidden, dModel], resStd, `layers.${l}.wd`, rng),
      });
    }
    this.gf = this.param([dModel], 0, 'gf', rng);

    // RoPE 的表：位置 × 半个头维，预算好省得每步重算
    const half = hd / 2;
    this.cos = this.rt.arena.alloc([blockSize, half], dtype, 'data', 'rope.cos');
    this.sin = this.rt.arena.alloc([blockSize, half], dtype, 'data', 'rope.sin');
    const cv = this.rt.arena.view(this.cos), sv = this.rt.arena.view(this.sin);
    for (let pos = 0; pos < blockSize; pos++) {
      for (let i = 0; i < half; i++) {
        const theta = pos / Math.pow(ropeBase, (2 * i) / hd);
        cv[pos * half + i] = Math.cos(theta);
        sv[pos * half + i] = Math.sin(theta);
      }
    }
  }

  /** 按批大小铺开中间量。换批大小要重新 alloc */
  allocActivations(batch: number): void {
    const { dModel, nLayer, nHead, nKvHead, hidden, blockSize: S, vocabSize, dtype } = this.cfg;
    const hd = this.headDim;
    const rows = batch * S;
    const A = this.rt.arena;
    const act = (shape: number[], name: string) => A.zeros(shape, dtype, 'activation', name);

    const layers: LayerBuffers[] = [];
    for (let l = 0; l < nLayer; l++) {
      layers.push({
        xin: act([rows, dModel], `l${l}.xin`),
        h1: act([rows, dModel], `l${l}.h1`),
        inv1: act([rows], `l${l}.inv1`),
        q: act([rows, nHead * hd], `l${l}.q`),
        k: act([rows, nKvHead * hd], `l${l}.k`),
        v: act([rows, nKvHead * hd], `l${l}.v`),
        /*
         * 这一块就是 O(S²) 的那个。B=16/H=8/S=128 时每层 8.4MB，
         * 六层比模型本身还大 —— 第 17 关的门槛读的是它，
         * 第 18 关（激活重算）要把它按下去。
         */
        att: act([batch, nHead, S, S], `l${l}.att`),
        ao: act([rows, nHead * hd], `l${l}.ao`),
        post: act([rows, dModel], `l${l}.post`),
        h2: act([rows, dModel], `l${l}.h2`),
        inv2: act([rows], `l${l}.inv2`),
        gate: act([rows, hidden], `l${l}.gate`),
        up: act([rows, hidden], `l${l}.up`),
        act: act([rows, hidden], `l${l}.act`),
      });
    }

    const wide = Math.max(dModel, hidden, nHead * hd);
    this.buf = {
      batch, rows, layers,
      x: act([rows, dModel], 'x'),
      xf: act([rows, dModel], 'xf'),
      hf: act([rows, dModel], 'hf'),
      invf: act([rows], 'invf'),
      logits: act([rows, vocabSize], 'logits'),
      probs: act([rows, vocabSize], 'probs'),
      tmp: act([rows, wide], 'tmp'),
      tmp2: act([rows, wide], 'tmp2'),
      tmp3: act([rows, wide], 'tmp3'),
      dx: act([rows, dModel], 'dx'),
      dy: act([rows, dModel], 'dy'),
      dh: act([rows, dModel], 'dh'),
      dq: act([rows, nHead * hd], 'dq'),
      dk: act([rows, nKvHead * hd], 'dk'),
      dv: act([rows, nKvHead * hd], 'dv'),
      dp: act([S], 'dp'),
      dgate: act([rows, hidden], 'dgate'),
      dup: act([rows, hidden], 'dup'),
      // token id 与目标：按 f32 分配、按 i32 用（4 字节一格，正好对得上）
      idx: A.zeros([rows], 'f32', 'data', 'idx'),
      tgt: A.zeros([rows], 'f32', 'data', 'tgt'),
    };
  }

  setBatch(idx: ArrayLike<number>, tgt: ArrayLike<number>): void {
    const b = this.need();
    this.rt.arena.i32(b.idx).set(idx as ArrayLike<number>);
    this.rt.arena.i32(b.tgt).set(tgt as ArrayLike<number>);
  }

  private need() {
    if (!this.buf) throw new Error('先调 allocActivations(batch)');
    return this.buf;
  }

  /**
   * 前向，返回平均**未加权**的交叉熵。
   *
   * 注意这里**没有** mask 参数：loss mask 目前只作用在反向上
   * （`backward(mask)`），前向报的仍是全部位置的平均。
   * SFT 那一关（第 22 关）要的是「prompt 位置的 loss 也不算」，
   * 那时候会给算子核加一个带 mask 的 cross_entropy，两边一起改。
   *
   * 在那之前**不给这里加一个被忽略的参数** —— 一个收下却不用的 mask
   * 比没有 mask 更危险：调用方以为自己屏蔽了，数字却没变。
   */
  forward(): number {
    const { dModel, nLayer, nHead, nKvHead, hidden, blockSize: S, vocabSize, eps } = this.cfg;
    const hd = this.headDim;
    const b = this.need();
    const { ops, arena } = this.rt;
    const rows = b.rows;

    return ops.withPhase('forward', () => {
      ops.embedFwd(this.emb, b.idx, b.x, rows, dModel);

      for (let l = 0; l < nLayer; l++) {
        const L = this.layers[l], B = b.layers[l];
        ops.copy(B.xin, b.x, rows * dModel);
        ops.rmsnormFwd(b.x, L.g1, B.h1, B.inv1, rows, dModel, eps);
        ops.gemmNN(B.h1, L.wq, B.q, rows, nHead * hd, dModel);
        ops.gemmNN(B.h1, L.wk, B.k, rows, nKvHead * hd, dModel);
        ops.gemmNN(B.h1, L.wv, B.v, rows, nKvHead * hd, dModel);
        ops.ropeFwd(B.q, this.cos, this.sin, b.batch, S, nHead, hd);
        ops.ropeFwd(B.k, this.cos, this.sin, b.batch, S, nKvHead, hd);
        ops.attnFwd(B.q, B.k, B.v, B.att, B.ao, b.batch, S, nHead, nKvHead, hd);
        ops.gemmNN(B.ao, L.wo, b.tmp, rows, dModel, nHead * hd);
        ops.addInplace(b.x, b.tmp, rows * dModel);

        ops.copy(B.post, b.x, rows * dModel);
        ops.rmsnormFwd(b.x, L.g2, B.h2, B.inv2, rows, dModel, eps);
        ops.gemmNN(B.h2, L.wg, B.gate, rows, hidden, dModel);
        ops.gemmNN(B.h2, L.wu, B.up, rows, hidden, dModel);
        ops.swigluFwd(B.gate, B.up, B.act, rows * hidden);
        ops.gemmNN(B.act, L.wd, b.tmp, rows, dModel, hidden);
        ops.addInplace(b.x, b.tmp, rows * dModel);
      }

      ops.copy(b.xf, b.x, rows * dModel);
      ops.rmsnormFwd(b.xf, this.gf, b.hf, b.invf, rows, dModel, eps);
      // logits = hf @ emb^T —— 权重共享，所以是 nt 而不是 nn
      ops.gemmNT(b.hf, this.emb, b.logits, rows, vocabSize, dModel);
      this.rt.meter.tokens += rows;
      return ops.crossEntropy(b.logits, b.tgt, b.probs, rows, vocabSize);
    });
  }

  /** 反向。假定 forward 刚跑过。`mask` 与 forward 传的那个要一致 */
  backward(mask: Tensor | null = null): void {
    const { dModel, nLayer, nHead, nKvHead, hidden, blockSize: S, vocabSize } = this.cfg;
    const hd = this.headDim;
    const b = this.need();
    const { ops } = this.rt;
    const rows = b.rows;
    const G = this.gradIndex();

    ops.withPhase('backward', () => {
      /*
       * 就地把 dlogits 写进 b.logits：前向要留的是 probs，logits 到这里
       * 已经没人要了，省一块 rows×vocab。
       * **代价是 `logits()` 只在 forward 之后有效**，backward 跑完那块就是梯度了。
       */
      ops.crossEntropyBwd(b.probs, b.tgt, mask, b.logits, rows, vocabSize, 1 / rows);
      const dlogits = b.logits;

      // d(hf) = dlogits @ emb ; d(emb) += dlogits^T @ hf
      ops.gemmNN(dlogits, this.emb, b.dy, rows, dModel, vocabSize);
      ops.gemmTNAcc(dlogits, b.hf, G.emb, rows, dModel, vocabSize);
      ops.rmsnormBwd(b.dy, b.xf, this.gf, b.invf, G.gf, b.dx, rows, dModel);

      for (let l = nLayer - 1; l >= 0; l--) {
        const L = this.layers[l], B = b.layers[l], g = G.layers[l];

        /* ---- MLP 分支。b.dx 同时是残差主干的梯度，所以是「读它、再往它上加」 ---- */
        ops.gemmTNAcc(B.act, b.dx, g.wd, rows, dModel, hidden);
        ops.gemmNT(b.dx, L.wd, b.tmp, rows, hidden, dModel);          // d(act)
        ops.swigluBwd(b.tmp, B.gate, B.up, b.dgate, b.dup, rows * hidden);
        ops.gemmTNAcc(B.h2, b.dgate, g.wg, rows, hidden, dModel);
        ops.gemmTNAcc(B.h2, b.dup, g.wu, rows, hidden, dModel);
        ops.gemmNT(b.dgate, L.wg, b.dh, rows, dModel, hidden);
        ops.gemmNT(b.dup, L.wu, b.tmp2, rows, dModel, hidden);
        ops.addInplace(b.dh, b.tmp2, rows * dModel);
        ops.rmsnormBwd(b.dh, B.post, L.g2, B.inv2, g.g2, b.tmp, rows, dModel);
        ops.addInplace(b.dx, b.tmp, rows * dModel);

        /* ---- 注意力分支 ---- */
        ops.gemmTNAcc(B.ao, b.dx, g.wo, rows, dModel, nHead * hd);
        ops.gemmNT(b.dx, L.wo, b.tmp, rows, nHead * hd, dModel);      // d(ao)
        ops.attnBwd(b.tmp, B.q, B.k, B.v, B.att, b.dq, b.dk, b.dv, b.dp,
          b.batch, S, nHead, nKvHead, hd);
        ops.ropeBwd(b.dq, this.cos, this.sin, b.batch, S, nHead, hd);
        ops.ropeBwd(b.dk, this.cos, this.sin, b.batch, S, nKvHead, hd);
        ops.gemmTNAcc(B.h1, b.dq, g.wq, rows, nHead * hd, dModel);
        ops.gemmTNAcc(B.h1, b.dk, g.wk, rows, nKvHead * hd, dModel);
        ops.gemmTNAcc(B.h1, b.dv, g.wv, rows, nKvHead * hd, dModel);
        ops.gemmNT(b.dq, L.wq, b.dh, rows, dModel, nHead * hd);
        ops.gemmNT(b.dk, L.wk, b.tmp2, rows, dModel, nKvHead * hd);
        ops.addInplace(b.dh, b.tmp2, rows * dModel);
        ops.gemmNT(b.dv, L.wv, b.tmp2, rows, dModel, nKvHead * hd);
        ops.addInplace(b.dh, b.tmp2, rows * dModel);
        ops.rmsnormBwd(b.dh, B.xin, L.g1, B.inv1, g.g1, b.tmp, rows, dModel);
        ops.addInplace(b.dx, b.tmp, rows * dModel);
      }

      // 嵌入与 lm_head 共享权重，所以这里是**第二次**往 G.emb 上加
      ops.embedBwd(b.dx, b.idx, G.emb, rows, dModel);
    });
  }

  private gradIndex() {
    let i = 0;
    const g = this.grads;
    const emb = g[i++];
    const layers = [] as Array<Record<keyof LayerParams, Tensor>>;
    for (let l = 0; l < this.cfg.nLayer; l++) {
      layers.push({
        g1: g[i++], wq: g[i++], wk: g[i++], wv: g[i++], wo: g[i++],
        g2: g[i++], wg: g[i++], wu: g[i++], wd: g[i++],
      });
    }
    return { emb, layers, gf: g[i++] };
  }

  zeroGrad(): void {
    for (const t of this.grads) this.rt.ops.fill(t, 0);
  }

  /** 全局梯度范数 */
  gradNorm(): number {
    let s = 0;
    for (const t of this.grads) s += this.rt.ops.sumsq(t);
    return Math.sqrt(s);
  }

  /**
   * AdamW 一步，返回裁剪前的梯度范数。
   *
   * **一维参数（norm 的增益）不做权重衰减。** 这是 AdamW 的通行做法，
   * 也是第 12 关的一条探针：把增益一起衰减掉，它会慢慢塌向 0，
   * 而 loss 在前几百步看不出区别。
   */
  step(opts: {
    lr: number; step: number;
    beta1?: number; beta2?: number; eps?: number; weightDecay?: number; gradClip?: number;
  }): number {
    const beta1 = opts.beta1 ?? 0.9;
    const beta2 = opts.beta2 ?? 0.95;
    const eps = opts.eps ?? 1e-8;
    const wd = opts.weightDecay ?? 0.1;
    const clip = opts.gradClip ?? 1.0;

    return this.rt.ops.withPhase('optimizer', () => {
      const norm = this.gradNorm();
      const scale = clip > 0 && norm > clip ? clip / norm : 1;
      for (let i = 0; i < this.params.length; i++) {
        const w = this.params[i];
        const decay = w.shape.length > 1 ? wd : 0;
        this.rt.ops.adamw(w, this.grads[i], this.moment1[i], this.moment2[i], w.count, {
          lr: opts.lr, beta1, beta2, eps, decay, step: opts.step, clip: scale,
        });
      }
      return norm;
    });
  }

  /** 把全部参数拷出来，用于「跑两遍逐位一致」那条门槛 */
  snapshot(): Float64Array {
    const out = new Float64Array(this.paramCount);
    let at = 0;
    for (const t of this.params) {
      const view = this.rt.arena.view(t);
      for (let i = 0; i < t.count; i++) out[at++] = view[i];
    }
    return out;
  }

  /**
   * 读一份 logits（行 = batch·位置）。
   *
   * **只在 forward 之后有效** —— backward 会把这块就地改写成 dlogits（见那里的注释）。
   */
  logits(): Float32Array | Float64Array {
    return this.rt.arena.view(this.need().logits);
  }
}
