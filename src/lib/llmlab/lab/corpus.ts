/**
 * 语料与合成任务
 *
 * 全部由代码生成，**不引入任何外部文本**。两个理由：
 *
 * 1. **版权**。语料要随项目发布，来源必须干净。
 * 2. **可复现**。生成器是确定的，所以「第 2 关算出来的 bigram 基线」
 *    这个数在任何机器上都一样 —— 而后面十几关的 loss 门槛都以它为分母。
 *
 * 三种语料，各有各的用处：
 *
 * | | 用在哪 | 为什么是它 |
 * | --- | --- | --- |
 * | `templatedEnglish` | 第 1–2、15–21 关 | 有真实的词法与句法结构，BPE 学得出词边界；bigram 有意义但远不够 |
 * | `induction` | 第 3–8 关 | 前半随机、后半照抄 —— **bigram 原理上做不到**，只有注意力对了才降得下去 |
 * | `arithmetic` | 后训练各关 | 答案可验证（RLVR 的奖励函数不需要人标） |
 */

/** 确定性 PRNG。种子先过 splitmix32 打散 —— 相邻种子给出相关序列的坑见 bridge.ts */
export function makeRandom(seed: number) {
  let z = (seed + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  let s = ((z ^ (z >>> 15)) >>> 0) || 1;
  return {
    next(): number {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    },
    pick<T>(list: readonly T[]): T {
      return list[Math.floor(this.next() * list.length) % list.length];
    },
    int(n: number): number {
      return Math.floor(this.next() * n) % n;
    },
  };
}

const SUBJECTS = [
  'the cat', 'a dog', 'the tall man', 'my sister', 'the old ship', 'a small bird',
  'her brother', 'the young teacher', 'that grey horse', 'the quiet child',
] as const;
const VERBS = [
  'walked to', 'looked at', 'carried', 'found', 'painted', 'remembered',
  'opened', 'counted', 'described', 'lost',
] as const;
const OBJECTS = [
  'the harbour', 'a wooden box', 'the blue door', 'her letters', 'the quiet room',
  'an empty street', 'three small stones', 'the broken clock', 'a paper map',
] as const;
const TAILS = [
  'before dawn.', 'without a word.', 'in the rain.', 'and then left.',
  'twice that week.', 'again.', 'as usual.', 'on the way home.',
] as const;

/**
 * 模板文法生成的英文。
 *
 * 刻意留着真实文本的两个性质：**词有边界**（BPE 能学出 `the` / `ed` 这样的片段），
 * **有长程重复**（同一个主语会在段落里再出现，注意力有东西可抓）。
 * 但它比真英文规整得多，所以 loss 的地板比真语料低 —— 题面里要写清这一点。
 */
export function templatedEnglish(bytes: number, seed = 20260831): string {
  const r = makeRandom(seed);
  let out = '';
  while (out.length < bytes) {
    out += `${r.pick(SUBJECTS)} ${r.pick(VERBS)} ${r.pick(OBJECTS)} ${r.pick(TAILS)}\n`;
  }
  return out.slice(0, bytes);
}

/**
 * 归纳任务：前半随机、后半照抄。
 *
 * **这个任务的价值在于 bigram 原理上做不到。** 前半段是均匀随机的，
 * 任何只看前一个符号的模型都只能给出均匀分布；而后半段每个位置都能靠
 * 「往回看半个序列」精确预测。
 *
 * 所以 loss 掉到均匀熵以下**只可能来自注意力真的在工作** ——
 * 第 3–8 关的门槛都建立在这一点上。
 */
export function inductionBatch(
  batch: number, seqLen: number, vocab: number, seed: number
): { idx: Int32Array; tgt: Int32Array } {
  const r = makeRandom(seed);
  const half = seqLen >> 1;
  const idx = new Int32Array(batch * seqLen);
  const tgt = new Int32Array(batch * seqLen);
  for (let b = 0; b < batch; b++) {
    const row = new Int32Array(seqLen + 1);
    for (let i = 0; i < half; i++) row[i] = r.int(vocab);
    for (let i = half; i <= seqLen; i++) row[i] = row[i - half];
    for (let t = 0; t < seqLen; t++) {
      idx[b * seqLen + t] = row[t];
      tgt[b * seqLen + t] = row[t + 1];
    }
  }
  return { idx, tgt };
}

/**
 * 归纳任务的信息论地板。
 *
 * 前 `half - 1` 个预测位置面对的是均匀随机的符号，谁也预测不了，每个 ln(V)；
 * 从第 `half - 1` 个位置起（预测 `row[half]` = `row[0]`）都能精确预测。
 *
 * **这个式子自己也要有人验**：第一次写的时候把预测位置数成了 `seqLen − 1`，
 * 算出来的地板比模型实际达到的还高 —— 一个「比理论极限还好」的结果。
 * 门槛的分母也会错。
 */
export function inductionFloor(seqLen: number, vocab: number): number {
  const half = seqLen >> 1;
  return ((half - 1) * Math.log(vocab)) / seqLen;
}

/** 可验证的算术题：`a+b=` → 答案。后训练的 RLVR 用它 —— 奖励函数不需要人标 */
export function arithmeticPairs(
  count: number, maxValue: number, seed: number
): Array<{ prompt: string; answer: string }> {
  const r = makeRandom(seed);
  const out: Array<{ prompt: string; answer: string }> = [];
  for (let i = 0; i < count; i++) {
    const a = r.int(maxValue), b = r.int(maxValue);
    out.push({ prompt: `${a}+${b}=`, answer: String(a + b) });
  }
  return out;
}

/* ------------------------------------------------------------------ 基线 */

export interface Baselines {
  /** ln(V)：什么都不学 */
  uniform: number;
  /** 只按字符频率猜 */
  unigram: number;
  /** 只看前一个字符 —— 第 16 关那条「打穿 bigram」门槛的分母 */
  bigram: number;
}

/**
 * 算 unigram / bigram 的交叉熵基线。
 *
 * **加一法平滑**：不平滑的话，验证集里出现了训练集没见过的二元组，
 * 交叉熵直接是 inf，那个基线就没法用了。平滑的强度会影响这个数，
 * 所以它写死在这里而不是参数化 —— 基线要是能调，它就不是基线。
 */
export function entropyBaselines(ids: Int32Array, vocab: number): Baselines {
  const uni = new Float64Array(vocab);
  const bi = new Float64Array(vocab * vocab);
  for (let i = 0; i < ids.length; i++) {
    uni[ids[i]] += 1;
    if (i > 0) bi[ids[i - 1] * vocab + ids[i]] += 1;
  }

  let hUni = 0;
  const n = ids.length;
  for (let i = 0; i < vocab; i++) {
    const p = (uni[i] + 1) / (n + vocab);
    if (uni[i] > 0) hUni -= (uni[i] / n) * Math.log(p);
  }

  let hBi = 0;
  let total = 0;
  for (let a = 0; a < vocab; a++) {
    let rowSum = 0;
    for (let b = 0; b < vocab; b++) rowSum += bi[a * vocab + b];
    if (rowSum === 0) continue;
    for (let b = 0; b < vocab; b++) {
      const c = bi[a * vocab + b];
      if (c === 0) continue;
      hBi -= c * Math.log((c + 1) / (rowSum + vocab));
      total += c;
    }
  }

  return {
    uniform: Math.log(vocab),
    unigram: hUni,
    bigram: total > 0 ? hBi / total : Math.log(vocab),
  };
}

/* -------------------------------------------------------------- 字符词表 */

export interface CharVocab {
  chars: string[];
  stoi: Map<string, number>;
  size: number;
}

/** 从文本建字符词表。排序保证同一份文本永远得到同一张表 */
export function charVocab(text: string): CharVocab {
  const chars = Array.from(new Set(Array.from(text))).sort();
  return {
    chars,
    stoi: new Map(chars.map((c, i) => [c, i])),
    size: chars.length,
  };
}

export function encodeChars(text: string, vocab: CharVocab): Int32Array {
  const out = new Int32Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const id = vocab.stoi.get(text[i]);
    if (id === undefined) throw new Error(`词表里没有字符 ${JSON.stringify(text[i])}`);
    out[i] = id;
  }
  return out;
}
