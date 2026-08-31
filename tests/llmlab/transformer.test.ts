/**
 * 端到端：算子核 + JS 桥 + 参考 transformer
 *
 * 这个文件回答的是整个项目的命门问题 —— **在浏览器里真的能训练吗**。
 * 原型（design/llmproto/）已经用一份独立的 JS 实现证明过一次，
 * 这里是在真产物上再证一次：真的算子核、真的计量层、真的模型。
 *
 * 四类用例，一类都不能少：
 *
 * 1. **参数量 = 解析式**。第 4、7 关的门槛就是这条，所以它自己得先对。
 * 2. **整个模型的 f64 梯度检验**。前面 kernels.test.ts 逐个算子验过了，
 *    这里验的是**接线** —— 每个算子单独对、连起来错，是最常见的一类。
 * 3. **它真的学得会**。合成的归纳任务：前半段随机、后半段照抄，
 *    bigram 模型原理上做不到，只有注意力真的在工作才降得下去。
 * 4. **逐位可复现**。所有门槛的地基。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRuntime, type Runtime } from '../../src/lib/llmlab/bridge';
import { Transformer, type ModelConfig } from '../../src/lib/llmlab/model/transformer';

const WASM = join(__dirname, '..', '..', 'public', 'llmlab', 'llmlab-kernels.wasm');
const bytes = readFileSync(WASM);

function fresh(): Runtime {
  return createRuntime(bytes);
}

/** 归纳任务：`x[0..h-1]` 随机，`x[h..2h-1]` 照抄前半段 */
function inductionBatch(
  batch: number, seqLen: number, vocab: number, seed: number
): { idx: Int32Array; tgt: Int32Array } {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  const half = seqLen / 2;
  const idx = new Int32Array(batch * seqLen);
  const tgt = new Int32Array(batch * seqLen);
  for (let b = 0; b < batch; b++) {
    const row = new Int32Array(seqLen + 1);
    for (let i = 0; i < half; i++) row[i] = next() % vocab;
    for (let i = half; i < seqLen + 1; i++) row[i] = row[i - half];
    for (let t = 0; t < seqLen; t++) {
      idx[b * seqLen + t] = row[t];
      tgt[b * seqLen + t] = row[t + 1];
    }
  }
  return { idx, tgt };
}

describe('参数量', () => {
  const cfg: ModelConfig = {
    vocabSize: 16, dModel: 32, nLayer: 2, nHead: 4, nKvHead: 2,
    hidden: 64, blockSize: 8, seed: 1,
  };

  it('实际分配的参数量等于解析式', () => {
    const rt = fresh();
    const model = new Transformer(rt, cfg);
    expect(model.paramCount).toBe(Transformer.paramCount(cfg));
  });

  it('解析式算的就是手推的那个数', () => {
    const hd = cfg.dModel / cfg.nHead;
    const perLayer =
      cfg.dModel * 2                              // 两个 norm 的增益
      + cfg.dModel * cfg.nHead * hd               // wq
      + cfg.dModel * cfg.nKvHead * hd * 2         // wk + wv（GQA：按 nKvHead 开）
      + cfg.nHead * hd * cfg.dModel               // wo
      + cfg.dModel * cfg.hidden * 2               // wg + wu
      + cfg.hidden * cfg.dModel;                  // wd
    const expected = cfg.vocabSize * cfg.dModel + cfg.nLayer * perLayer + cfg.dModel;
    expect(Transformer.paramCount(cfg)).toBe(expected);
  });

  it('GQA 真的省了参数：kv 头减半，wk/wv 也减半', () => {
    const mha = { ...cfg, nKvHead: cfg.nHead };
    const gqa = { ...cfg, nKvHead: cfg.nHead / 2 };
    const hd = cfg.dModel / cfg.nHead;
    const saved = Transformer.paramCount(mha) - Transformer.paramCount(gqa);
    // 每层 wk + wv 各省 dModel × (nHead-nKvHead)×hd
    expect(saved).toBe(cfg.nLayer * 2 * cfg.dModel * (cfg.nHead - cfg.nHead / 2) * hd);
  });

  it('按模块分的参数量加起来等于总数', () => {
    const rt = fresh();
    const model = new Transformer(rt, cfg);
    const sum = Object.values(model.paramsByModule()).reduce((a, b) => a + b, 0);
    expect(sum).toBe(model.paramCount);
  });
});

/**
 * 整个模型的梯度检验，f64。
 *
 * **这是这个文件里最值钱的一条。** 逐个算子的正确性 kernels.test.ts 已经验过，
 * 这里验的是接线：残差往哪加、权重共享的嵌入梯度加了几次、
 * rmsnorm 的输入存的是不是加完残差之后那份。这些错误单看算子全是对的。
 *
 * 用 f64：原型实测同一份正确的反向，fp32 下最差相对误差 4.99e-2，
 * fp64 下 6.79e-4 —— fp32 的噪声足以淹没中心差分。
 */
describe('整个模型的梯度检验（f64）', () => {
  const cfg: ModelConfig = {
    vocabSize: 11, dModel: 16, nLayer: 2, nHead: 4, nKvHead: 2,
    hidden: 32, blockSize: 6, seed: 7, dtype: 'f64',
  };
  const batch = 2;
  const H = 1e-5;

  it('每个参数张量都过，最大相对误差 < 2e-3', () => {
    const rt = fresh();
    const model = new Transformer(rt, cfg);
    model.allocActivations(batch);
    const { idx, tgt } = inductionBatch(batch, cfg.blockSize, cfg.vocabSize, 99);
    model.setBatch(idx, tgt);

    model.zeroGrad();
    model.forward();
    model.backward();
    const analytic = model.grads.map((g) => Float64Array.from(rt.arena.view(g)));

    let worst = 0;
    let worstName = '';
    let checkedTensors = 0;
    let checkedElements = 0;

    // 抽样的步长取质数，免得每个张量都只抽到开头那几个
    for (let p = 0; p < model.params.length; p++) {
      const t = model.params[p];
      const view = rt.arena.view(t);
      let local = 0;
      const samples = Math.min(8, t.count);
      for (let s = 0; s < samples; s++) {
        const i = (s * 31 + 5) % t.count;
        const orig = view[i];
        view[i] = orig + H; const lp = model.forward();
        view[i] = orig - H; const lm = model.forward();
        view[i] = orig;
        const num = (lp - lm) / (2 * H);
        const ana = analytic[p][i];
        const rel = Math.abs(num - ana) / Math.max(1e-6, Math.abs(num) + Math.abs(ana));
        local = Math.max(local, rel);
        checkedElements += 1;
      }
      checkedTensors += 1;
      if (local > worst) { worst = local; worstName = model.names[p]; }
    }

    // 覆盖率也要断言 —— 只查一个点的话，一整类「某个矩阵梯度全错」会全绿通过
    expect(checkedTensors).toBe(model.params.length);
    expect(checkedElements).toBeGreaterThanOrEqual(model.params.length * 4);
    console.log(`  最差的是 ${worstName}：${worst.toExponential(2)}（界 2e-3）`);
    expect(worst).toBeLessThan(2e-3);
  });

  /*
   * 反向验证：把一处**故意改错**，梯度检验必须挂。
   * 一条永远绿的检验比没有检验更糟 —— 它会让人以为反向是对的。
   */
  it('把嵌入的梯度少加一次（权重共享那一份），检验必须挂', () => {
    const rt = fresh();
    const model = new Transformer(rt, cfg);
    model.allocActivations(batch);
    const { idx, tgt } = inductionBatch(batch, cfg.blockSize, cfg.vocabSize, 99);
    model.setBatch(idx, tgt);

    model.zeroGrad();
    model.forward();
    model.backward();

    // 嵌入是与 lm_head 共享的，梯度该加两次。这里把 lm_head 那一份抹掉，
    // 模拟「忘了权重共享」这个经典错误
    const embGrad = rt.arena.view(model.grads[0]);
    for (let i = 0; i < embGrad.length; i++) embGrad[i] = 0;
    model.forward();   // 恢复前向状态
    const analytic = Float64Array.from(embGrad);

    const t = model.params[0];
    const view = rt.arena.view(t);
    let worst = 0;
    for (let s = 0; s < 8; s++) {
      const i = (s * 31 + 5) % t.count;
      const orig = view[i];
      view[i] = orig + H; const lp = model.forward();
      view[i] = orig - H; const lm = model.forward();
      view[i] = orig;
      const num = (lp - lm) / (2 * H);
      const rel = Math.abs(num - analytic[i]) / Math.max(1e-6, Math.abs(num) + Math.abs(analytic[i]));
      worst = Math.max(worst, rel);
    }
    expect(worst).toBeGreaterThan(0.5);   // 全零的梯度，相对误差必然接近 1
  });
});

describe('因果性', () => {
  /*
   * 第 3 关那条 `llm.causality.leakBits = 0` 门槛的原型。
   * 判据不是「掩码写了没」，而是**改未来改不动现在**。
   */
  it('改掉最后一个 token，前面位置的 logits 一位都不变', () => {
    const cfg: ModelConfig = {
      vocabSize: 13, dModel: 16, nLayer: 2, nHead: 4, nKvHead: 2,
      hidden: 32, blockSize: 8, seed: 3, dtype: 'f64',
    };
    const batch = 2;
    const rt = fresh();
    const model = new Transformer(rt, cfg);
    model.allocActivations(batch);
    const { idx, tgt } = inductionBatch(batch, cfg.blockSize, cfg.vocabSize, 5);

    model.setBatch(idx, tgt);
    model.forward();
    const before = Float64Array.from(model.logits());

    const changed = Int32Array.from(idx);
    for (let b = 0; b < batch; b++) {
      const at = b * cfg.blockSize + cfg.blockSize - 1;
      changed[at] = (changed[at] + 7) % cfg.vocabSize;
    }
    model.setBatch(changed, tgt);
    model.forward();
    const after = model.logits();

    for (let b = 0; b < batch; b++)
      for (let t = 0; t < cfg.blockSize - 1; t++)       // 最后一个位置本来就该变
        for (let j = 0; j < cfg.vocabSize; j++) {
          const at = (b * cfg.blockSize + t) * cfg.vocabSize + j;
          expect(after[at]).toBe(before[at]);            // 逐位
        }
  });
});

describe('它真的学得会', () => {
  /*
   * 归纳任务：序列前半随机、后半照抄。后半段每个位置都能靠「往回看半个序列」
   * 精确预测，而 bigram / unigram 原理上做不到 —— 前半段是均匀随机的。
   *
   * 所以 loss 掉到均匀熵以下这件事，**只可能来自注意力真的在工作**。
   * 这正是第 16 关「打穿 bigram 基线」那条门槛的形状。
   */
  const vocab = 16;
  const seqLen = 16;
  const batch = 16;
  const cfg: ModelConfig = {
    vocabSize: vocab, dModel: 64, nLayer: 2, nHead: 4, nKvHead: 2,
    hidden: 128, blockSize: seqLen, seed: 11,
  };

  it('800 步之后基本把这个任务解掉了 —— 逼近信息论地板', () => {
    const rt = fresh();
    const model = new Transformer(rt, cfg);
    model.allocActivations(batch);

    const uniform = Math.log(vocab);              // 2.7726
    /*
     * 信息论地板。16 个预测位置里：
     *   t = 0..6  预测的是均匀随机的符号 —— 谁也预测不了，每个 ln(V)
     *   t = 7..15 预测的是半个序列之前出现过的那个 —— 注意力够得着就是 0
     * 所以 loss ≥ 7·ln(V)/16 ≈ 1.213。
     *
     * （第一版这里写的是 /(seqLen−1)，把预测位置数错成 15，
     * 于是地板算成 1.294，比模型实际达到的 1.229 还高 —— 一个「跑出来
     * 比理论极限还好」的结果本该立刻引起怀疑，而它确实引起了。）
     */
    const floor = (7 * uniform) / seqLen;

    const steps = 800;
    const warm = 20;
    const history: number[] = [];
    for (let step = 1; step <= steps; step++) {
      const { idx, tgt } = inductionBatch(batch, seqLen, vocab, 1000 + step);
      model.setBatch(idx, tgt);
      model.zeroGrad();
      const loss = model.forward();
      model.backward();
      const lr = 3e-3 * (step <= warm
        ? step / warm
        : 0.1 + 0.9 * 0.5 * (1 + Math.cos((Math.PI * (step - warm)) / (steps - warm))));
      model.step({ lr, step });
      history.push(loss);
    }

    const first = history.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const last = history.slice(-10).reduce((a, b) => a + b, 0) / 10;
    console.log(
      `  均匀熵 ${uniform.toFixed(3)} / 理论地板 ${floor.toFixed(3)} / ` +
      `起步 ${first.toFixed(3)} → 末尾 ${last.toFixed(3)}`
    );

    expect(first).toBeGreaterThan(uniform * 0.9);   // 起步就该在均匀熵附近
    /*
     * 门槛按「规矩二」定：卡在朴素值（均匀熵 2.773）与参考值（实测 1.229）之间、
     * 靠近参考侧，两个数都写在这儿。1.5 对实测值留了 22% 的余量，
     * 换个初始化、换台机器都翻不掉。
     */
    expect(last).toBeLessThan(1.5);
    /*
     * 而且要**逼近地板**才算真学会了 —— 只降到 1.9 那种是学了个大概，
     * 归纳头还没真正形成。实测 1.229 / 地板 1.213，差 1.3%。
     */
    expect(last).toBeLessThan(floor * 1.15);
    // 反过来也不能低于地板：低于它说明任务构造错了（后半段泄漏进了前半段）
    expect(last).toBeGreaterThan(floor * 0.95);
    expect(Number.isFinite(last)).toBe(true);
  }, 180_000);
});

describe('确定性', () => {
  const cfg: ModelConfig = {
    vocabSize: 16, dModel: 32, nLayer: 2, nHead: 4, nKvHead: 2,
    hidden: 64, blockSize: 8, seed: 21,
  };
  const batch = 4;

  function run(steps: number): { losses: number[]; params: Float64Array } {
    const rt = fresh();
    const model = new Transformer(rt, cfg);
    model.allocActivations(batch);
    const losses: number[] = [];
    for (let step = 1; step <= steps; step++) {
      const { idx, tgt } = inductionBatch(batch, cfg.blockSize, cfg.vocabSize, 7000 + step);
      model.setBatch(idx, tgt);
      model.zeroGrad();
      losses.push(model.forward());
      model.backward();
      model.step({ lr: 1e-3, step });
    }
    return { losses, params: model.snapshot() };
  }

  it('两遍训练，loss 序列与全部权重逐位一致', () => {
    const a = run(25), b = run(25);
    expect(a.losses).toEqual(b.losses);
    let diff = 0;
    for (let i = 0; i < a.params.length; i++) if (a.params[i] !== b.params[i]) diff += 1;
    expect(diff).toBe(0);
  }, 60_000);
});

describe('计量：门槛读的那些数', () => {
  const cfg: ModelConfig = {
    vocabSize: 16, dModel: 32, nLayer: 2, nHead: 4, nKvHead: 2,
    hidden: 64, blockSize: 8, seed: 31,
  };
  const batch = 4;

  function trained() {
    const rt = fresh();
    const model = new Transformer(rt, cfg);
    model.allocActivations(batch);
    rt.arena.resetPeak();
    const { idx, tgt } = inductionBatch(batch, cfg.blockSize, cfg.vocabSize, 42);
    model.setBatch(idx, tgt);
    model.zeroGrad();
    model.forward();
    model.backward();
    model.step({ lr: 1e-3, step: 1 });
    return { rt, model };
  }

  it('反向的 FLOPs 大约是前向的两倍 —— 明显超过就是重算了前向', () => {
    const { rt, model } = trained();
    const m = rt.metrics({ params: { total: model.paramCount } });
    const ratio = m.flops.backwardOverForward;
    console.log(`  backward/forward = ${ratio.toFixed(2)}`);
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(2.6);
  });

  it('每 token 的前向 FLOPs 与 2N 是同一个量级', () => {
    const { rt, model } = trained();
    const m = rt.metrics({ params: { total: model.paramCount } });
    // 经验式 2N 只数矩阵乘；我们还数了 norm / swiglu / softmax，所以会偏高一点
    const twoN = 2 * model.paramCount;
    expect(m.flops.forwardPerToken).toBeGreaterThan(twoN * 0.5);
    expect(m.flops.forwardPerToken).toBeLessThan(twoN * 3);
  });

  it('注意力那块 O(S²) 缓冲真的进了激活峰值', () => {
    const { rt } = trained();
    const m = rt.metrics();
    const attBytes = batch * cfg.nHead * cfg.blockSize * cfg.blockSize * 4 * cfg.nLayer;
    expect(m.memory.peakActivationBytes).toBeGreaterThan(attBytes);
    // 参数与优化器状态不该混进激活峰值里
    expect(m.memory.paramBytes).toBeGreaterThan(0);
    expect(m.memory.optimizerStateBytes).toBe(m.memory.paramBytes * 2);
  });

  it('禁用的算子被精确数到，而且报得出是哪一个', () => {
    const rt = fresh();
    rt.forbid(['attn_fwd', 'swiglu_fwd']);
    const model = new Transformer(rt, cfg);
    model.allocActivations(batch);
    const { idx, tgt } = inductionBatch(batch, cfg.blockSize, cfg.vocabSize, 42);
    model.setBatch(idx, tgt);
    model.forward();
    const m = rt.metrics();
    // 每层各调一次
    expect(m.builtins.forbiddenCalls).toBe(cfg.nLayer * 2);
    expect((m.builtins.forbiddenHits as Record<string, number>).attn_fwd).toBe(cfg.nLayer);
  });

  it('没禁的时候 forbiddenCalls 是 0', () => {
    const { rt } = trained();
    expect(rt.metrics().builtins.forbiddenCalls).toBe(0);
  });

  it('timing 只在展示里，不许作门槛', () => {
    const { isForbiddenGateMetric } = require('../../src/lib/llmlab/bridge');
    expect(isForbiddenGateMetric('llm.timing.msPerStep')).toBe(true);
    expect(isForbiddenGateMetric('llm.flops.forwardPerToken')).toBe(false);
    expect(isForbiddenGateMetric('llm.memory.peakActivationBytes')).toBe(false);
  });
});

describe('形状校验', () => {
  /*
   * wasm 的线性内存没有保护页，越界不会 trap，只会安静地读到别的张量。
   * 所以形状必须在 JS 这一层拦下来 —— 拦不住的表现是「loss 变成 NaN，
   * 但看不出为什么」，而那是学员最难自己排查的一类。
   */
  it('维度对不上时报得出是哪个算子', () => {
    const rt = fresh();
    const a = rt.arena.zeros([4, 4]);
    const b = rt.arena.zeros([4, 4]);
    const c = rt.arena.zeros([2, 2]);
    expect(() => rt.ops.gemmNN(a, b, c, 4, 4, 4)).toThrow(/gemm_nn 的 C 装不下/);
  });

  it('f32 与 f64 混着用会被拦下来', () => {
    const rt = fresh();
    const a = rt.arena.zeros([4, 4], 'f32');
    const b = rt.arena.zeros([4, 4], 'f64');
    const c = rt.arena.zeros([4, 4], 'f32');
    expect(() => rt.ops.gemmNN(a, b, c, 4, 4, 4)).toThrow(/dtype 不一致/);
  });

  it('越界的 token id 当场报错，而不是读到别人的数据', () => {
    const rt = fresh();
    const logits = rt.arena.zeros([2, 5]);
    const probs = rt.arena.zeros([2, 5]);
    const tgt = rt.arena.zeros([2], 'f32', 'data');
    rt.arena.i32(tgt).set([0, 99]);
    expect(() => rt.ops.crossEntropy(logits, tgt, probs, 2, 5)).toThrow(/越出了词表大小 5/);
  });

  it('release 之后再用那个张量会报错', () => {
    const rt = fresh();
    const mark = rt.arena.mark();
    const t = rt.arena.zeros([4], 'f32', 'activation', '临时的');
    rt.arena.release(mark);
    expect(() => rt.arena.view(t)).toThrow(/已经被 release 掉了/);
  });
});
