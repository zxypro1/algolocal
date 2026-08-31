/**
 * 平台探针：学员改不了、也绕不过的那些证据
 *
 * 门槛分两类。一类读**计量**（FLOPs、显存、禁用算子），那些在 JS 桥里数好了。
 * 另一类要**主动构造一个场景去问**，比如：
 *
 * - 因果性：改掉未来的 token，现在的输出会不会变？
 * - loss mask：被遮住的位置，梯度真的是 0 吗？
 * - 确定性：同一份代码跑两遍，结果逐位一样吗？
 *
 * 这三件事**看结果是看不出来的** —— 一个泄漏了未来的模型 loss 会更低、
 * 一个没屏蔽 prompt 的 SFT 照样收敛。只有主动去问才问得出来。
 *
 * 这是 gpulab 那条教训在这里的对应物：「在确定性模拟器里，一个有竞态的 kernel
 * 会给出一个稳定的结果」—— 不主动检测，判定就是假的。
 */
import type { TrainSession } from '../python';

/** 因果性探针的结果 */
export interface CausalityReport {
  /** 改了未来 token 之后，本该不变的位置里有几个变了。**恒等门槛：0** */
  leakBits: number;
  /** 一共查了多少个位置 —— 防止「只查一个点」 */
  checked: number;
  /** 第一个泄漏的位置，没有就是 -1 */
  firstLeakAt: number;
}

/**
 * 因果性：改掉后面的 token，前面位置的输出必须**一位都不变**。
 *
 * 判据不是「掩码写了没」（那查的是实现），而是行为。
 * 逐位比而不是按容差比：因果泄漏哪怕只泄漏一点点，也是泄漏。
 *
 * `runLogits` 由关卡提供：喂一串 token id，返回 [rows, vocab] 的 logits。
 */
export function probeCausality(
  runLogits: (idx: Int32Array) => Float64Array | Float32Array,
  idx: Int32Array,
  seqLen: number,
  vocab: number,
  changeAt = seqLen - 1
): CausalityReport {
  const before = Float64Array.from(runLogits(idx));
  const changed = Int32Array.from(idx);
  const batch = idx.length / seqLen;
  for (let b = 0; b < batch; b++) {
    const at = b * seqLen + changeAt;
    changed[at] = (changed[at] + 7) % vocab;
  }
  const after = runLogits(changed);

  let leak = 0;
  let checked = 0;
  let first = -1;
  for (let b = 0; b < batch; b++) {
    for (let t = 0; t < changeAt; t++) {      // changeAt 及之后本来就该变
      for (let j = 0; j < vocab; j++) {
        const at = (b * seqLen + t) * vocab + j;
        checked += 1;
        if (after[at] !== before[at]) {
          leak += 1;
          if (first < 0) first = b * seqLen + t;
        }
      }
    }
  }
  return { leakBits: leak, checked, firstLeakAt: first };
}

export interface DeterminismReport {
  /** 两遍是否逐位一致 */
  bitIdentical: boolean;
  /** 不一致的元素数 */
  differing: number;
  /** 比了多少个 */
  compared: number;
}

/**
 * 确定性：同一份代码跑两遍，结果必须逐位一致。
 *
 * **所有门槛的地基。** 这一条一红，重放、反向验证、进度存档全都不成立 ——
 * 因为「学员这次过了」和「他下次还能过」之间就没有关系了。
 */
export function probeDeterminism(run: () => ArrayLike<number>): DeterminismReport {
  const a = Array.from(run());
  const b = Array.from(run());
  let differing = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) differing += 1;
  return {
    bitIdentical: differing === 0 && a.length === b.length,
    differing: differing + Math.abs(a.length - b.length),
    compared: n,
  };
}

export interface GradCheckReport {
  /** 最大相对误差。界一般取 2e-3（f64 中心差分，步长 1e-5） */
  maxRelError: number;
  /** 查了多少个参数张量 —— 必须等于全部，否则一整类错会全绿通过 */
  checkedTensors: number;
  checkedElements: number;
  /** 最差的那个张量叫什么 */
  worstTensor: string;
}

/**
 * 梯度检验：中心差分 vs 解析梯度。
 *
 * **必须在 f64 里做。** 原型实测：同一份正确的反向，fp32 下最差相对误差
 * 4.99e-2（看着像写错了），fp64 下 6.79e-4。fp32 的数值噪声足以淹没中心差分。
 *
 * 抽样强度也是判据的一部分 —— gpulab 的教训是「判定只查一个点时，
 * 一整类偏移算错的实现会全绿通过」。所以 `checkedTensors` 也要进门槛。
 */
export function gradCheck(
  params: Array<{ name: string; values: Float64Array; grad: Float64Array }>,
  loss: () => number,
  samplesPerTensor = 8,
  step = 1e-5
): GradCheckReport {
  let worst = 0;
  let worstTensor = '';
  let checkedElements = 0;

  for (const p of params) {
    const n = p.values.length;
    const samples = Math.min(samplesPerTensor, n);
    for (let s = 0; s < samples; s++) {
      // 步长取质数：不然每个张量都只抽到开头那几个
      const i = (s * 31 + 5) % n;
      const orig = p.values[i];
      p.values[i] = orig + step;
      const lp = loss();
      p.values[i] = orig - step;
      const lm = loss();
      p.values[i] = orig;
      const num = (lp - lm) / (2 * step);
      const ana = p.grad[i];
      const rel = Math.abs(num - ana) / Math.max(1e-6, Math.abs(num) + Math.abs(ana));
      checkedElements += 1;
      if (rel > worst) { worst = rel; worstTensor = p.name; }
    }
  }

  return { maxRelError: worst, checkedTensors: params.length, checkedElements, worstTensor };
}

export interface LossMaskReport {
  /** 被遮住的位置里，梯度不为 0 的有几个。**恒等门槛：0** */
  leakedPositions: number;
  /** 参与 loss 的位置数 */
  contributingPositions: number;
  maskedPositions: number;
}

/**
 * loss mask：被遮住的位置梯度必须恒为 0。
 *
 * SFT 那一关（第 22 关）的核心。没屏蔽 prompt 的实现**照样收敛**，
 * 只是学到的东西不对 —— 它在学「怎么生成问题」，而不是「怎么回答问题」。
 * 从 loss 曲线上完全看不出来。
 */
export function probeLossMask(
  dlogits: ArrayLike<number>, mask: ArrayLike<number>, rows: number, vocab: number
): LossMaskReport {
  let leaked = 0;
  let contributing = 0;
  let masked = 0;
  for (let r = 0; r < rows; r++) {
    if (mask[r] === 0) {
      masked += 1;
      for (let j = 0; j < vocab; j++) if (dlogits[r * vocab + j] !== 0) leaked += 1;
    } else {
      contributing += 1;
    }
  }
  return { leakedPositions: leaked, contributingPositions: contributing, maskedPositions: masked };
}

/**
 * 跨文档注意力泄漏。
 *
 * 打包（packing）把多篇文档拼成一条流之后，注意力必须在文档边界处断开。
 * 不断开的话**训练照样收敛** —— 模型只是学到了一点点不该有的关联，
 * 而这在任何曲线上都看不见。第 15 关的门槛读这个数，恒为 0。
 *
 * `docIds[t]` 是第 t 个位置属于哪一篇。`probs` 是 [B, H, S, S]。
 */
export function probeCrossDocument(
  probs: ArrayLike<number>, docIds: ArrayLike<number>,
  batch: number, heads: number, seqLen: number
): { crossDocumentPairs: number; checked: number } {
  let cross = 0;
  let checked = 0;
  for (let b = 0; b < batch; b++)
    for (let h = 0; h < heads; h++)
      for (let i = 0; i < seqLen; i++)
        for (let j = 0; j <= i; j++) {
          checked += 1;
          if (docIds[b * seqLen + i] !== docIds[b * seqLen + j]) {
            if (probs[((b * heads + h) * seqLen + i) * seqLen + j] !== 0) cross += 1;
          }
        }
  return { crossDocumentPairs: cross, checked };
}

/** 在 Python 会话里跑一段并把一个顶层变量读回来（判定常用） */
export function readJson(session: TrainSession, expression: string): unknown {
  const raw = session.py.run(`
import json as _json
_json.dumps(${expression})
`);
  return JSON.parse(String(raw));
}
