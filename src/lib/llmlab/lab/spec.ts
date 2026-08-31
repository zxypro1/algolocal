/**
 * train 形态的世界：语料、分词器、模型档位、超参、数据集、检查点
 *
 * 沿用 ops / gpu 的定论：**世界写在项目上，关卡只写增量**。
 * **这个文件只有类型，一行运行时代码都没有。** 装配它的是 `world.ts`。
 * 分开是因为 `src/lib/engineering/types.ts` 要引用这些类型 ——
 * 让平台的类型定义去 import 一个会拉起 Pyodide 与 wasm 的模块，
 * 是把整条依赖链弄脏的最快办法。
 */

/** 模型档位。判定档约 15 万参数，探索档约 40 万 —— 数字与依据见 design/llmlab.md「训练规模的天花板」 */
export interface TrainArchSpec {
  dModel: number;
  nLayer: number;
  /** 查询头数 */
  nHead: number;
  /** 键值头数。等于 nHead 就是 MHA，小于就是 GQA */
  nKvHead: number;
  /** 前馈的中间维度（SwiGLU 有三个 d×hidden 的矩阵） */
  hidden: number;
  /** 上下文长度 */
  blockSize: number;
  vocabSize: number;
  /** RoPE 的底数，默认 10000 */
  ropeBase?: number;
}

/**
 * 训练超参。
 *
 * **这一整块是只读的，学员改不了。** 门槛规矩二：学习效果类门槛成立的前提是
 * 种子、数据、超参、步数全部由平台固定 —— 否则「loss 降到 1.45 以下」
 * 只要把步数调到十倍就过了。
 */
export interface TrainHParams {
  seed: number;
  batchSize: number;
  steps: number;
  learningRate: number;
  warmupSteps?: number;
  weightDecay?: number;
  gradClip?: number;
  betas?: [number, number];
}

/** 语料：项目自带的文本，按名字取 */
export interface TrainCorpusSpec {
  /** 名字 → 磁盘上的路径 */
  files: Record<string, string>;
  /** 留出集占比，用于算验证 loss */
  holdoutRatio?: number;
}

/** 分词器：第 1 关之后各关都用平台这一份，保证起点一致 */
export interface TrainTokenizerSpec {
  kind: 'char' | 'bpe';
  vocabSize: number;
  /** BPE 的 merge 表落在磁盘的哪里（由平台生成） */
  mergesPath?: string;
}

/** 一台装着 Python 与 nanotorch 的开发机 */
export interface TrainMachineSpec {
  /** 开局盘上就有的文件 */
  files?: Record<string, string>;
  /** 提示符，默认 `~ $` */
  prompt?: string;
}

export interface TrainWorldSpec {
  machine?: TrainMachineSpec;
  corpus?: TrainCorpusSpec;
  tokenizer?: TrainTokenizerSpec;
  arch?: TrainArchSpec;
  hparams?: TrainHParams;
  /**
   * 随项目发布的预训练检查点：名字 → `public/llmlab/` 下的文件名。
   *
   * 后训练那 9 关都要一个已经会说话的模型做起点，现场训一遍是纯浪费 ——
   * 现实里也没有人为了做 SFT 先重新预训练一遍。
   */
  checkpoints?: Record<string, string>;
  /** 数据集：名字 → 磁盘路径（SFT 指令集、偏好对、可验证任务集、评测集） */
  datasets?: Record<string, string>;
  /** 「运行」按钮默认跑哪个脚本 */
  entry?: string;
}
