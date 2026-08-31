/**
 * train 形态的世界：装配与运行时
 *
 * 沿用 ops / gpu 的定论：**世界写在项目上，关卡只写增量**。
 * 一个世界 = 一个算子核运行时 + 一个 Python 会话 + 语料 / 词表 / 数据集，
 * 工作台的每块面板和判定读的都是**同一个**世界 —— 学员在编辑器里改过、
 * 在终端里跑过的东西必须算数。
 */
import type { Runtime } from '../bridge';
import { createRuntime, createRuntimeAsync } from '../bridge';
import { createTrainSession, type TrainSession } from '../python';
import type { LoadPythonOptions } from '../python';
import {
  charVocab, encodeChars, entropyBaselines, templatedEnglish,
  type Baselines, type CharVocab,
} from './corpus';

export type {
  TrainArchSpec, TrainCorpusSpec, TrainHParams,
  TrainMachineSpec, TrainTokenizerSpec, TrainWorldSpec,
} from './spec';

import type { TrainWorldSpec } from './spec';

/** 装配好的世界 */
export interface TrainWorld {
  readonly rt: Runtime;
  readonly session: TrainSession;
  /** 语料的原文，按名字取 */
  readonly corpus: Record<string, string>;
  /** 主语料的字符词表 —— 第 2 关之前用它，之后换成 BPE */
  readonly vocab: CharVocab;
  /** 主语料编码之后的 token 序列 */
  readonly tokens: Int32Array;
  /** 留出集的起点。之前是训练集，之后是验证集 */
  readonly holdoutAt: number;
  /** 三条基线。**第 16 关那条门槛的分母就是 bigram** */
  readonly baselines: Baselines;
  readonly spec: TrainWorldSpec;
  /** 世界改过几次 —— 面板的投影挂在这个数上重算 */
  revision: number;
}

export interface BuildWorldOptions {
  /** 算子核的 wasm 字节 */
  wasmBytes: BufferSource;
  /** Pyodide 的加载参数 */
  python: LoadPythonOptions;
  /** 项目级世界 + 关卡增量，浅合并之后的结果 */
  spec?: TrainWorldSpec;
  /** 同步建（Node / Worker）还是异步建（浏览器主线程） */
  sync?: boolean;
}

const DEFAULT_CORPUS_BYTES = 60_000;
const DEFAULT_HOLDOUT = 0.1;

/**
 * 把关卡增量浅合并到项目级世界上。
 *
 * `machine.files` 要**深合并一层**：关卡放的起始代码不该把项目级的
 * 只读基础设施文件冲掉。其余字段整块覆盖 —— 换档位、换语料都是整块换的。
 */
export function mergeWorldSpec(
  base: TrainWorldSpec | undefined,
  patch: Partial<TrainWorldSpec> | undefined
): TrainWorldSpec {
  if (!base) return (patch ?? {}) as TrainWorldSpec;
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    machine: {
      ...(base.machine ?? {}),
      ...(patch.machine ?? {}),
      files: { ...(base.machine?.files ?? {}), ...(patch.machine?.files ?? {}) },
    },
  };
}

export async function buildWorld(options: BuildWorldOptions): Promise<TrainWorld> {
  const spec = options.spec ?? {};
  const rt = options.sync === false
    ? await createRuntimeAsync(options.wasmBytes)
    : createRuntime(options.wasmBytes);

  const session = await createTrainSession(rt, options.python);

  /*
   * 语料。世界里没写就生成一份默认的 ——
   * 前几关（分词器、基线）需要的正是这份文本，而不是某个具体项目的内容。
   */
  const corpus: Record<string, string> = { ...(spec.corpus?.files ?? {}) };
  if (Object.keys(corpus).length === 0) {
    corpus['corpus.txt'] = templatedEnglish(DEFAULT_CORPUS_BYTES);
  }
  const mainName = Object.keys(corpus).sort()[0];
  const text = corpus[mainName];

  const vocab = charVocab(text);
  const tokens = encodeChars(text, vocab);
  const ratio = spec.corpus?.holdoutRatio ?? DEFAULT_HOLDOUT;
  const holdoutAt = Math.floor(tokens.length * (1 - ratio));

  /*
   * 基线只在**训练集**上统计。
   *
   * 在全量上统计的话，bigram 基线会偷看到验证集 —— 于是「模型打穿了 bigram」
   * 这件事被系统性地变难，而难的原因和模型无关。这个错很隐蔽，
   * 因为两个数看起来都很合理。
   */
  const baselines = entropyBaselines(tokens.subarray(0, holdoutAt), vocab.size);

  // 把语料与只读文件铺到 Python 的虚拟文件系统上
  for (const [name, content] of Object.entries(corpus)) {
    session.writeFile(`data/${name}`, content);
  }
  /*
   * 训练 / 留出的切分也落一份到盘上。
   *
   * **平台与学员必须用同一份切分**，否则基线那一关算出来的数和判定算的对不上，
   * 而两边都没错 —— 只是切在了不同的地方。与其让每个人各切各的，
   * 不如平台切好写出去。
   */
  session.writeFile('data/split.json', JSON.stringify({
    train: Array.from(tokens.subarray(0, holdoutAt)),
    eval: Array.from(tokens.subarray(holdoutAt)),
    vocab_size: vocab.size,
  }));
  for (const [path, content] of Object.entries(spec.machine?.files ?? {})) {
    session.writeFile(path, content);
  }
  for (const [name, content] of Object.entries(spec.datasets ?? {})) {
    session.writeFile(`data/${name}`, content);
  }

  return {
    rt, session, corpus, vocab, tokens, holdoutAt, baselines, spec, revision: 0,
  };
}
