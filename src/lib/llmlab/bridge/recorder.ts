/**
 * 训练日志：学员的脚本往里写，面板与判定从里面读
 *
 * 对应现实里的 wandb / tensorboard —— 学员在训练循环里调
 * `nt.log.step(step, loss=..., lr=..., grad_norm=...)`，
 * 和他在真项目里会写的那一行是同一个形状。
 *
 * **为什么日志在 JS 侧而不是 Python 侧**：面板要实时画它，判定要读它，
 * 而这两者都在 JS。放 Python 里的话每次取都要跨语言搬一次数组。
 *
 * **为什么它不是门槛的主要来源**：日志是学员**自愿**写的 ——
 * 他可以少写、写错、甚至不写。所以门槛读的是 `llm.*` 那棵计量树
 * （在算子层数出来的，绕不过），日志只负责「让人看见」，
 * 以及给那些本来就该由学员报告的量（他自己算的评测结果）一个落点。
 */

export interface TrainStepRecord {
  step: number;
  loss: number;
  /** 学习率。不写就是 NaN，面板会跳过这条线 */
  lr: number;
  /** 裁剪前的梯度范数 */
  gradNorm: number;
  /** 验证 loss，一般每隔几十步才算一次 */
  valLoss: number;
  /** 这一步用了多少 token */
  tokens: number;
  /** 墙钟毫秒。**只作展示** —— 门槛永远不读它 */
  wallMs: number;
}

/** 一条生成样例 */
export interface SampleRecord {
  step: number;
  /** 分组：`pretrain` / `sft` / `chosen` / `rejected` / `rollout` … */
  group: string;
  text: string;
  /** 每个 token 的 logprob，面板按它着色 */
  logprobs: number[];
  /** 奖励 / 优势 / 是否通过验证器，后训练各关用 */
  reward: number;
  advantage: number;
  meta: Record<string, number | string>;
}

/** 一张注意力热图的快照 */
export interface AttentionSnapshot {
  step: number;
  layer: number;
  head: number;
  seqLen: number;
  /** 行优先的 [seqLen, seqLen] 概率 */
  probs: number[];
  /** 这几个位置对应的 token（有就画在轴上） */
  tokens: string[];
}

/** 一组直方图（激活 / 梯度 / 权重的分布） */
export interface HistogramSnapshot {
  step: number;
  name: string;
  /** 桶的左边界 */
  edges: number[];
  counts: number[];
  min: number;
  max: number;
  mean: number;
  std: number;
}

export interface TrainingLogView {
  steps: TrainStepRecord[];
  scalars: Record<string, Array<{ step: number; value: number }>>;
  samples: SampleRecord[];
  attention: AttentionSnapshot[];
  histograms: HistogramSnapshot[];
  /** 学员自己报告的东西（评测结果之类），judging 也读得到 */
  reported: Record<string, unknown>;
}

/**
 * 上限。
 *
 * 一次判定可能跑几千步、生成几百条样例，全留在内存里会把面板拖垮
 * （而且没有人会去看第 1372 条样例）。超了之后**按步数抽稀**而不是丢新的 ——
 * 丢新的会让曲线的末尾消失，而末尾恰恰是最要紧的地方。
 */
const MAX_STEPS = 4000;
const MAX_SAMPLES = 200;
const MAX_SNAPSHOTS = 64;

export class TrainingLog {
  private steps: TrainStepRecord[] = [];
  private scalars: Record<string, Array<{ step: number; value: number }>> = {};
  private samples: SampleRecord[] = [];
  private attention: AttentionSnapshot[] = [];
  private histograms: HistogramSnapshot[] = [];
  private reported: Record<string, unknown> = {};
  /** 变化计数 —— 面板挂在这个数上重算，不用深比 */
  revision = 0;
  /** `view()` 的快照与它对应的 revision，见 view() 上的说明 */
  private snapshot: TrainingLogView | null = null;
  private snapshotAt = -1;

  step(record: Partial<TrainStepRecord> & { step: number }): void {
    this.steps.push({
      step: record.step,
      loss: record.loss ?? NaN,
      lr: record.lr ?? NaN,
      gradNorm: record.gradNorm ?? NaN,
      valLoss: record.valLoss ?? NaN,
      tokens: record.tokens ?? 0,
      wallMs: record.wallMs ?? 0,
    });
    if (this.steps.length > MAX_STEPS) this.steps = decimate(this.steps);
    this.revision += 1;
  }

  scalar(name: string, step: number, value: number): void {
    const list = this.scalars[name] ?? (this.scalars[name] = []);
    list.push({ step, value });
    if (list.length > MAX_STEPS) this.scalars[name] = decimate(list);
    this.revision += 1;
  }

  sample(record: Partial<SampleRecord> & { text: string }): void {
    this.samples.push({
      step: record.step ?? 0,
      group: record.group ?? 'default',
      text: record.text,
      logprobs: record.logprobs ?? [],
      reward: record.reward ?? NaN,
      advantage: record.advantage ?? NaN,
      meta: record.meta ?? {},
    });
    // 样例超了就丢最老的：这里和曲线相反，新样例才是学员想看的
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    this.revision += 1;
  }

  attentionSnapshot(snap: AttentionSnapshot): void {
    this.attention.push(snap);
    if (this.attention.length > MAX_SNAPSHOTS) this.attention.shift();
    this.revision += 1;
  }

  histogram(snap: HistogramSnapshot): void {
    this.histograms.push(snap);
    if (this.histograms.length > MAX_SNAPSHOTS) this.histograms.shift();
    this.revision += 1;
  }

  report(key: string, value: unknown): void {
    this.reported[key] = value;
    this.revision += 1;
  }

  /**
   * 面板读的那份投影。**身份必须跟着内容走。**
   *
   * 以前这里直接把内部数组交出去。它们是原地 `push` 的，所以
   * 记了两百步之后 `view().steps` 还是**同一个引用** ——
   * 而面板的 `useMemo` 挂在 `[log.steps, revision]` 上，
   * 引用不变就不重算，曲线一条都画不出来。
   *
   * 这个 bug 在 v0.19.0 的实装验收里露头：头部徽章显示「200 步」
   * （它每次渲染直接读 `.length`），而训练面板同时显示「还没有训练记录」。
   * **同一份数据，两个地方给出相反的结论**，差别只在读法。
   *
   * 现在按 `revision` 缓存一份快照：内容没变就返回同一个对象
   * （memo 照样省得下来），内容一变就是全新的引用。
   */
  view(): TrainingLogView {
    if (this.snapshot && this.snapshotAt === this.revision) return this.snapshot;
    this.snapshotAt = this.revision;
    this.snapshot = {
      steps: this.steps.slice(),
      scalars: Object.fromEntries(
        Object.entries(this.scalars).map(([name, list]) => [name, list.slice()])
      ),
      samples: this.samples.slice(),
      attention: this.attention.slice(),
      histograms: this.histograms.slice(),
      reported: { ...this.reported },
    };
    return this.snapshot;
  }

  clear(): void {
    this.steps = [];
    this.scalars = {};
    this.samples = [];
    this.attention = [];
    this.histograms = [];
    this.reported = {};
    this.revision += 1;
  }
}

/** 隔一个留一个。保持首尾，只把中间稀释掉 */
function decimate<T>(list: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < list.length; i += 2) out.push(list[i]);
  const last = list[list.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * 算一组数的直方图。
 *
 * 桶按 [min, max] 均分。**分布看的是形状不是精度**，所以桶数固定 32 ——
 * 可调的话每个人的图都不一样，没法互相对照。
 */
export function histogramOf(
  values: ArrayLike<number>, name: string, step: number, bins = 32
): HistogramSnapshot {
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n += 1;
  }
  if (n === 0) {
    return { step, name, edges: [], counts: [], min: 0, max: 0, mean: 0, std: 0 };
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) varSum += (v - mean) * (v - mean);
  }
  const std = Math.sqrt(varSum / n);

  // 全都一样时给一个宽度，免得除以 0
  const span = max - min || 1;
  const edges: number[] = [];
  const counts = new Array<number>(bins).fill(0);
  for (let b = 0; b < bins; b++) edges.push(min + (span * b) / bins);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let b = Math.floor(((v - min) / span) * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    counts[b] += 1;
  }
  return { step, name, edges, counts, min, max, mean, std };
}
