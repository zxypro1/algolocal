'use strict';
/* 真训练：量每步耗时、loss 曲线、确定性、内存 */
const { Model, rng } = require('./nn');

//// 语料：一个小模板文法生成的英文样文本（自己造的，没有版权问题，且结构真实）
function corpus(n) {
  const r = rng(20260831);
  const pick = (a) => a[Math.floor(r() * a.length) % a.length];
  const subj = ['the cat', 'a dog', 'the tall man', 'my sister', 'the old ship', 'a small bird'];
  const verb = ['walked to', 'looked at', 'carried', 'found', 'painted', 'remembered'];
  const obj = ['the harbour', 'a wooden box', 'the blue door', 'her letters', 'the quiet room', 'an empty street'];
  const tail = ['before dawn.', 'without a word.', 'in the rain.', 'and then left.', 'twice that week.', 'again.'];
  let s = '';
  while (s.length < n) s += `${pick(subj)} ${pick(verb)} ${pick(obj)} ${pick(tail)}\n`;
  return s.slice(0, n);
}

function entropyBaselines(ids, V) {
  const uni = new Float64Array(V), bi = new Float64Array(V * V);
  for (let i = 0; i < ids.length; i++) { uni[ids[i]]++; if (i) bi[ids[i - 1] * V + ids[i]]++; }
  let hU = 0; const N = ids.length;
  for (let i = 0; i < V; i++) if (uni[i]) hU -= (uni[i] / N) * Math.log(uni[i] / N);
  let hB = 0, tot = 0;
  for (let a = 0; a < V; a++) {
    let rowSum = 0; for (let b = 0; b < V; b++) rowSum += bi[a * V + b];
    if (!rowSum) continue;
    for (let b = 0; b < V; b++) if (bi[a * V + b]) { hB -= bi[a * V + b] * Math.log(bi[a * V + b] / rowSum); tot += bi[a * V + b]; }
  }
  return { uniform: Math.log(V), unigram: hU, bigram: hB / tot };
}

function run(cfg, steps, B, opts = {}) {
  const text = corpus(opts.corpusBytes || 60000);
  const chars = Array.from(new Set(text)).sort();
  const stoi = new Map(chars.map((c, i) => [c, i]));
  const ids = Int32Array.from(Array.from(text, (c) => stoi.get(c)));
  cfg = { ...cfg, vocab: chars.length };
  const base = entropyBaselines(ids, cfg.vocab);

  const m = new Model(cfg);
  m.alloc(B);
  const S = cfg.block, T = B * S;
  const idx = new Int32Array(T), tgt = new Int32Array(T);
  const r = rng(cfg.seed * 7 + 1);
  const batch = () => {
    for (let b = 0; b < B; b++) {
      const off = Math.floor(r() * (ids.length - S - 1));
      for (let t = 0; t < S; t++) { idx[b * S + t] = ids[off + t]; tgt[b * S + t] = ids[off + t + 1]; }
    }
  };

  const hist = [];
  let tf = 0, tb = 0, to = 0;
  const warm = Math.max(1, Math.floor(steps * 0.05));
  const t0 = process.hrtime.bigint();
  for (let step = 1; step <= steps; step++) {
    batch();
    const lr = (opts.lr ?? 3e-3) * (step <= warm ? step / warm
      : 0.1 + 0.9 * 0.5 * (1 + Math.cos(Math.PI * (step - warm) / (steps - warm))));
    m.zeroGrad();
    let a = process.hrtime.bigint();
    const loss = m.forward(idx, tgt, B);
    let b2 = process.hrtime.bigint(); tf += Number(b2 - a);
    m.backward(idx, tgt, B);
    let c = process.hrtime.bigint(); tb += Number(c - b2);
    m.step(lr, step);
    to += Number(process.hrtime.bigint() - c);
    hist.push(loss);
  }
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  const tail = hist.slice(-10).reduce((s, x) => s + x, 0) / 10;
  const flops = 6 * m.nParams * T * steps;
  return {
    cfg, B, steps, nParams: m.nParams, vocab: cfg.vocab, base,
    wallMs: wall, msPerStep: wall / steps,
    split: { fwd: tf / 1e6 / steps, bwd: tb / 1e6 / steps, opt: to / 1e6 / steps },
    gflops: flops / 1e9 / (wall / 1000),
    loss0: hist[0], lossEnd: tail, hist,
    finalParams: m.params.map((p) => p.slice()),
  };
}

const which = process.argv[2] || 'all';

if (which === 'all' || which === 'size') {
  console.log('=== 规模扫描（每档 60 步，看每步耗时与有效吞吐）===');
  const grid = [
    { name: 'XS  d=48 L=2', cfg: { d: 48, nLayer: 2, nHead: 3, nKvHead: 1, hidden: 128, block: 64, seed: 11 }, B: 16 },
    { name: 'S   d=64 L=3', cfg: { d: 64, nLayer: 3, nHead: 4, nKvHead: 2, hidden: 176, block: 64, seed: 11 }, B: 16 },
    { name: 'M   d=96 L=4', cfg: { d: 96, nLayer: 4, nHead: 6, nKvHead: 2, hidden: 256, block: 64, seed: 11 }, B: 16 },
    { name: 'L   d=128 L=6', cfg: { d: 128, nLayer: 6, nHead: 8, nKvHead: 2, hidden: 344, block: 128, seed: 11 }, B: 16 },
    { name: 'XL  d=192 L=8', cfg: { d: 192, nLayer: 8, nHead: 6, nKvHead: 2, hidden: 512, block: 128, seed: 11 }, B: 16 },
  ];
  for (const g of grid) {
    const rr = run(g.cfg, 60, g.B);
    console.log(`${g.name.padEnd(14)} 参数 ${String(rr.nParams).padStart(8)}  tok/步 ${g.B * g.cfg.block}  ` +
      `${rr.msPerStep.toFixed(1)} ms/步  ${rr.gflops.toFixed(2)} GFLOP/s  ` +
      `(fwd ${rr.split.fwd.toFixed(1)} / bwd ${rr.split.bwd.toFixed(1)} / opt ${rr.split.opt.toFixed(1)})`);
  }
  console.log('');
}

if (which === 'all' || which === 'learn') {
  console.log('=== 真的学得会吗（S 档，400 步）===');
  const cfg = { d: 64, nLayer: 3, nHead: 4, nKvHead: 2, hidden: 176, block: 64, seed: 11 };
  const rr = run(cfg, 400, 16, { lr: 3e-3 });
  console.log(`参数 ${rr.nParams}  vocab ${rr.vocab}  ${rr.msPerStep.toFixed(1)} ms/步  总 ${(rr.wallMs / 1000).toFixed(1)} s`);
  console.log(`基线：均匀 ${rr.base.uniform.toFixed(3)}  unigram ${rr.base.unigram.toFixed(3)}  bigram ${rr.base.bigram.toFixed(3)}`);
  const marks = [0, 24, 49, 99, 199, 299, 399];
  console.log('step  loss');
  for (const i of marks) if (rr.hist[i] !== undefined) console.log(`${String(i + 1).padStart(4)}  ${rr.hist[i].toFixed(4)}`);
  console.log(`末 10 步均值 ${rr.lossEnd.toFixed(4)}  ${rr.lossEnd < rr.base.bigram ? '已打穿 bigram 基线' : '未打穿 bigram'}`);
  console.log(`内存 rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB  heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`);
  console.log('');
}

if (which === 'all' || which === 'det') {
  console.log('=== 确定性：同一配置跑两遍，权重是否逐位一致 ===');
  const cfg = { d: 64, nLayer: 3, nHead: 4, nKvHead: 2, hidden: 176, block: 64, seed: 11 };
  const a = run(cfg, 40, 16), b = run(cfg, 40, 16);
  let diff = 0, maxAbs = 0;
  for (let p = 0; p < a.finalParams.length; p++) {
    const x = a.finalParams[p], y = b.finalParams[p];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { diff++; maxAbs = Math.max(maxAbs, Math.abs(x[i] - y[i])); }
  }
  console.log(`loss 序列相同：${a.hist.every((v, i) => v === b.hist[i])}`);
  console.log(`权重不同的元素：${diff} / ${a.nParams}  最大差 ${maxAbs}`);
  console.log('');
}
