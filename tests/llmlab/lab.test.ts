/**
 * `@llm/lab`：判定运行时
 *
 * 隐藏用例是 TS，学员的代码是 Python，两边在这个 API 上交汇。
 * 这个文件验的是**那条缝本身**：世界装得起来、用例读得到学员的东西、
 * 门槛真的会拦、探针真的抓得住。
 *
 * 一条贯穿的规矩：**每条「必须通过」的断言，都配一条「必须挂」的**。
 * 一个永远返回通过的判定比没有判定更糟。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildWorld, entropyBaselines, inductionBatch, inductionFloor, mergeWorldSpec,
  runTrainStage, assertGatesAreStructural, templatedEnglish, charVocab, encodeChars,
  type TrainWorld,
} from '../../src/lib/llmlab/lab';
import type { MetricGate, SpecFile } from '../../src/lib/engineering/types';

const ROOT = join(__dirname, '..', '..');
const WASM = readFileSync(join(ROOT, 'public', 'llmlab', 'llmlab-kernels.wasm'));
const INDEX_URL = join(ROOT, 'public', 'llmlab', 'pyodide') + '/';

function spec(content: string): SpecFile[] {
  return [{ path: 'stage.spec.ts', content }];
}

/** 隐藏用例走的是同一条 transpile 路径，这里直接给 JS */
const noTranspile = (code: string) => code;

describe('语料与基线', () => {
  it('模板文本是确定的 —— 同一个种子给同一份语料', () => {
    expect(templatedEnglish(2000, 7)).toBe(templatedEnglish(2000, 7));
    expect(templatedEnglish(2000, 7)).not.toBe(templatedEnglish(2000, 8));
  });

  it('三条基线依次递减 —— 越会看上下文越低', () => {
    const text = templatedEnglish(40_000);
    const vocab = charVocab(text);
    const ids = encodeChars(text, vocab);
    const b = entropyBaselines(ids, vocab.size);
    console.log(
      `  均匀 ${b.uniform.toFixed(3)} > unigram ${b.unigram.toFixed(3)} > bigram ${b.bigram.toFixed(3)}`
    );
    expect(b.unigram).toBeLessThan(b.uniform);
    expect(b.bigram).toBeLessThan(b.unigram);
    expect(b.bigram).toBeGreaterThan(0);
  });

  it('归纳任务：后半段确实是前半段的照抄', () => {
    const seqLen = 16, vocab = 16;
    const { idx, tgt } = inductionBatch(2, seqLen, vocab, 1);
    const half = seqLen >> 1;
    for (let b = 0; b < 2; b++)
      for (let i = half; i < seqLen; i++) {
        expect(idx[b * seqLen + i]).toBe(idx[b * seqLen + i - half]);
      }
    // 目标是右移一位的输入
    for (let b = 0; b < 2; b++)
      for (let t = 0; t < seqLen - 1; t++) {
        expect(tgt[b * seqLen + t]).toBe(idx[b * seqLen + t + 1]);
      }
  });

  /*
   * 地板的式子自己也要有人验。第一次写的时候把预测位置数成了 seqLen−1，
   * 算出来的地板比模型实际达到的还高 —— 一个「比理论极限还好」的结果。
   * 这里用蒙特卡洛反过来核一遍：**一个知道规则的完美预测器**的交叉熵，
   * 必须等于那个式子。
   */
  it('信息论地板与「完美预测器」的实测一致', () => {
    const seqLen = 16, vocab = 16, batch = 400;
    const { idx, tgt } = inductionBatch(batch, seqLen, vocab, 99);
    const half = seqLen >> 1;
    let total = 0;
    for (let b = 0; b < batch; b++)
      for (let t = 0; t < seqLen; t++) {
        // 完美预测器：t+1 >= half 时能精确预测（loss 0），否则只能均匀猜
        total += (t + 1 >= half) ? 0 : Math.log(vocab);
      }
    const measured = total / (batch * seqLen);
    const formula = inductionFloor(seqLen, vocab);
    console.log(`  地板：式子 ${formula.toFixed(4)} / 实测 ${measured.toFixed(4)}`);
    expect(formula).toBeCloseTo(measured, 10);
    void tgt;
  });
});

describe('世界的装配', () => {
  it('关卡增量浅合并到项目级世界上，machine.files 深合并一层', () => {
    const merged = mergeWorldSpec(
      { arch: { dModel: 64, nLayer: 2, nHead: 4, nKvHead: 2, hidden: 128, blockSize: 16, vocabSize: 16 },
        machine: { files: { '/lab/base.py': 'base', '/lab/keep.py': 'keep' } } },
      { arch: { dModel: 96, nLayer: 3, nHead: 6, nKvHead: 2, hidden: 192, blockSize: 32, vocabSize: 32 },
        machine: { files: { '/lab/base.py': 'stage' } } }
    );
    expect(merged.arch?.dModel).toBe(96);
    // 关卡的起始代码覆盖同名文件，但不该把项目级的只读文件冲掉
    expect(merged.machine?.files?.['/lab/base.py']).toBe('stage');
    expect(merged.machine?.files?.['/lab/keep.py']).toBe('keep');
  });

  it('世界建得起来，语料 / 词表 / 基线都在', async () => {
    const world = await buildWorld({ wasmBytes: WASM, python: { indexURL: INDEX_URL } });
    expect(world.vocab.size).toBeGreaterThan(10);
    expect(world.tokens.length).toBeGreaterThan(1000);
    expect(world.baselines.bigram).toBeLessThan(world.baselines.unigram);
    expect(world.holdoutAt).toBeLessThan(world.tokens.length);
    // 语料落到了 Python 的虚拟文件系统上
    expect(world.session.py.readFile('/lab/data/corpus.txt').length).toBeGreaterThan(1000);
  }, 180_000);

  /*
   * 基线只在训练集上统计。在全量上统计的话 bigram 会偷看到验证集，
   * 于是「模型打穿了 bigram」这件事被系统性地变难 —— 而难的原因和模型无关。
   */
  it('基线只用训练集统计，不偷看留出集', async () => {
    const world = await buildWorld({ wasmBytes: WASM, python: { indexURL: INDEX_URL } });
    const trainOnly = entropyBaselines(world.tokens.subarray(0, world.holdoutAt), world.vocab.size);
    const wholeThing = entropyBaselines(world.tokens, world.vocab.size);
    expect(world.baselines.bigram).toBeCloseTo(trainOnly.bigram, 12);
    expect(world.baselines.bigram).not.toBeCloseTo(wholeThing.bigram, 12);
  }, 180_000);
});

describe('判定运行时', () => {
  let world: TrainWorld;
  beforeAll(async () => {
    world = await buildWorld({ wasmBytes: WASM, python: { indexURL: INDEX_URL } });
  }, 180_000);

  it('用例能通过 @llm/lab 拿到世界', async () => {
    const report = await runTrainStage({
      world,
      transpile: noTranspile,
      specs: spec(`
const lab = require('@llm/lab');
describe('世界', () => {
  it('词表不为空', () => { expect(lab.world.vocabSize()).toBeGreaterThan(10); });
  it('基线拿得到', () => { expect(lab.world.baselines().bigram).toBeGreaterThan(0); });
});
`),
    });
    expect(report.status).toBe('passed');
    expect(report.totals.passed).toBe(2);
  }, 120_000);

  it('用例能跑学员的 Python 并读回他的变量', async () => {
    world.session.writeFile('student.py', 'ANSWER = 6 * 7\nprint("跑过了")\n');
    const report = await runTrainStage({
      world,
      transpile: noTranspile,
      specs: spec(`
const lab = require('@llm/lab');
describe('学员脚本', () => {
  it('跑得起来，而且读得到他的结果', () => {
    const out = lab.run('student.py');
    expect(out.stdout).toContain('跑过了');
    expect(lab.value('ANSWER')).toBe(42);
  });
});
`),
    });
    if (report.status !== 'passed') console.log(JSON.stringify(report.cases, null, 1));
    expect(report.status).toBe('passed');
  }, 120_000);

  it('学员的 Python 报错时，用例看到的是 Python 的原文', async () => {
    world.session.writeFile('bad.py', 'raise ValueError("形状对不上：期望 (B, T, C)")\n');
    const report = await runTrainStage({
      world,
      transpile: noTranspile,
      specs: spec(`
const lab = require('@llm/lab');
describe('报错', () => {
  it('带得出中文原文', () => { lab.run('bad.py'); });
});
`),
    });
    expect(report.status).toBe('failed');
    expect(report.cases[0].error).toContain('形状对不上');
  }, 120_000);

  it('门槛真的会拦 —— 而且拦得住的是「必须挂」的那一版', async () => {
    const body = `
const lab = require('@llm/lab');
describe('跑一点算子', () => {
  it('动一下', () => { lab.py('import nanotorch as nt; nt.zeros((64, 64))'); expect(1).toBe(1); });
});
`;
    const pass: MetricGate = {
      metric: 'llm.kernelCalls.total', op: 'gte', value: 0,
      label: { zh: '至少调过算子', en: 'kernels called' },
    };
    const fail: MetricGate = {
      metric: 'llm.kernelCalls.total', op: 'gte', value: 1e9,
      label: { zh: '不可能达到的门槛', en: 'impossible' },
    };

    const ok = await runTrainStage({ world, transpile: noTranspile, specs: spec(body), gates: [pass] });
    expect(ok.status).toBe('passed');
    expect(ok.gates[0].passed).toBe(true);

    const bad = await runTrainStage({ world, transpile: noTranspile, specs: spec(body), gates: [fail] });
    // 用例全过，但门槛没过 —— 整关就是没过
    expect(bad.totals.failed).toBe(0);
    expect(bad.gates[0].passed).toBe(false);
    expect(bad.status).toBe('failed');
  }, 120_000);

  /*
   * 出题期的闸门。与其在文档里写「门槛不许读墙钟」，
   * 不如让写错的题目根本跑不起来。
   */
  it('门槛读墙钟时当场报错，而不是安静地生效', async () => {
    expect(() => assertGatesAreStructural([
      { metric: 'llm.timing.msPerStep', op: 'lte', value: 10, label: { zh: '', en: '' } },
    ])).toThrow(/不许建立在 llm.timing.msPerStep 上/);

    expect(() => assertGatesAreStructural([
      { metric: 'llm.flops.forwardPerToken', op: 'lte', value: 1e6, label: { zh: '', en: '' } },
    ])).not.toThrow();

    const report = await runTrainStage({
      world,
      transpile: noTranspile,
      specs: spec(`describe('x', () => { it('y', () => { expect(1).toBe(1); }); });`),
      gates: [{ metric: 'llm.timing.tokensPerSecond', op: 'gte', value: 1, label: { zh: '', en: '' } }],
    });
    expect(report.status).toBe('error');
    expect(report.error).toContain('llm.timing.tokensPerSecond');
  }, 120_000);
});

describe('探针', () => {
  let world: TrainWorld;
  beforeAll(async () => {
    world = await buildWorld({ wasmBytes: WASM, python: { indexURL: INDEX_URL } });
  }, 180_000);

  it('因果性：泄漏的实现被抓到，不泄漏的通过', async () => {
    const report = await runTrainStage({
      world,
      transpile: noTranspile,
      specs: spec(`
const lab = require('@llm/lab');
const SEQ = 4, VOCAB = 5;
const idx = new Int32Array([1, 2, 3, 4]);

describe('因果性探针', () => {
  it('只看历史的实现：leakBits = 0', () => {
    // logits[t] 只依赖 idx[0..t]
    const run = (ids) => {
      const out = new Float64Array(SEQ * VOCAB);
      for (let t = 0; t < SEQ; t++) {
        let acc = 0;
        for (let j = 0; j <= t; j++) acc += ids[j];
        for (let v = 0; v < VOCAB; v++) out[t * VOCAB + v] = acc * (v + 1);
      }
      return out;
    };
    const r = lab.probe.causality(run, idx, SEQ, VOCAB);
    expect(r.leakBits).toBe(0);
    expect(r.checked).toBeGreaterThan(0);
  });

  it('偷看未来的实现：探针必须抓到', () => {
    // logits[t] 把整段都加进来了 —— 一个非常常见的掩码写错
    const run = (ids) => {
      const out = new Float64Array(SEQ * VOCAB);
      let all = 0;
      for (let j = 0; j < SEQ; j++) all += ids[j];
      for (let t = 0; t < SEQ; t++)
        for (let v = 0; v < VOCAB; v++) out[t * VOCAB + v] = all * (v + 1);
      return out;
    };
    const r = lab.probe.causality(run, idx, SEQ, VOCAB);
    expect(r.leakBits).toBeGreaterThan(0);
    expect(r.firstLeakAt).toBeGreaterThanOrEqual(0);
  });
});
`),
    });
    if (report.status !== 'passed') console.log(JSON.stringify(report.cases, null, 1));
    expect(report.status).toBe('passed');
  }, 120_000);

  it('loss mask：漏屏蔽的实现被抓到', async () => {
    const report = await runTrainStage({
      world,
      transpile: noTranspile,
      specs: spec(`
const lab = require('@llm/lab');
describe('loss mask 探针', () => {
  it('屏蔽对了：leakedPositions = 0', () => {
    const mask = [1, 0, 1, 0];
    const d = new Float64Array(4 * 3);
    for (let r = 0; r < 4; r++) if (mask[r]) for (let j = 0; j < 3; j++) d[r * 3 + j] = 0.1;
    const rep = lab.probe.lossMask(d, mask, 4, 3);
    expect(rep.leakedPositions).toBe(0);
    expect(rep.contributingPositions).toBe(2);
    expect(rep.maskedPositions).toBe(2);
  });
  it('忘了屏蔽：探针必须抓到', () => {
    const mask = [1, 0, 1, 0];
    const d = new Float64Array(4 * 3).fill(0.1);   // 全都有梯度
    expect(lab.probe.lossMask(d, mask, 4, 3).leakedPositions).toBe(6);
  });
});
`),
    });
    expect(report.status).toBe('passed');
  }, 120_000);

  it('跨文档泄漏：打包没断开的实现被抓到', async () => {
    const report = await runTrainStage({
      world,
      transpile: noTranspile,
      specs: spec(`
const lab = require('@llm/lab');
const S = 4, H = 1, B = 1;
const docIds = [0, 0, 1, 1];   // 前两个位置一篇，后两个另一篇

describe('跨文档探针', () => {
  it('在边界处断开：crossDocumentPairs = 0', () => {
    const p = new Float64Array(B * H * S * S);
    for (let i = 0; i < S; i++)
      for (let j = 0; j <= i; j++) if (docIds[i] === docIds[j]) p[i * S + j] = 0.5;
    expect(lab.probe.crossDocument(p, docIds, B, H, S).crossDocumentPairs).toBe(0);
  });
  it('没断开：探针必须抓到', () => {
    const p = new Float64Array(B * H * S * S);
    for (let i = 0; i < S; i++) for (let j = 0; j <= i; j++) p[i * S + j] = 0.25;
    expect(lab.probe.crossDocument(p, docIds, B, H, S).crossDocumentPairs).toBeGreaterThan(0);
  });
});
`),
    });
    expect(report.status).toBe('passed');
  }, 120_000);

  it('梯度检验：正确的反向过，写错的挂', async () => {
    const report = await runTrainStage({
      world,
      transpile: noTranspile,
      specs: spec(`
const lab = require('@llm/lab');
describe('梯度检验探针', () => {
  // loss = Σ x²，解析梯度是 2x
  const values = Float64Array.from([0.3, -0.7, 1.2, 0.05, -2.1, 0.9, 1.4, -0.2]);
  const loss = () => { let s = 0; for (const v of values) s += v * v; return s; };

  it('对的梯度：误差在 2e-3 以内', () => {
    const grad = Float64Array.from(values, (v) => 2 * v);
    const r = lab.probe.gradCheck([{ name: 'x', values, grad }], loss);
    expect(r.maxRelError).toBeLessThan(2e-3);
    expect(r.checkedTensors).toBe(1);
    expect(r.checkedElements).toBe(8);
  });

  it('错的梯度（漏了系数 2）：必须被抓到', () => {
    const grad = Float64Array.from(values, (v) => v);
    expect(lab.probe.gradCheck([{ name: 'x', values, grad }], loss).maxRelError)
      .toBeGreaterThan(0.1);
  });
});
`),
    });
    if (report.status !== 'passed') console.log(JSON.stringify(report.cases, null, 1));
    expect(report.status).toBe('passed');
  }, 120_000);
});
