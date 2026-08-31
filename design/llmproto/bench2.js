'use strict';
const { build } = require('./wasmback');
const nn = require('./nn');
(async () => {
  const k = await build();
  const grid = [
    { name: 'XS  d=48 L=2 s=64', cfg: { d: 48, nLayer: 2, nHead: 3, nKvHead: 1, hidden: 128, block: 64, seed: 11 }, B: 16 },
    { name: 'S   d=64 L=3 s=64', cfg: { d: 64, nLayer: 3, nHead: 4, nKvHead: 2, hidden: 176, block: 64, seed: 11 }, B: 16 },
    { name: 'M   d=96 L=4 s=64', cfg: { d: 96, nLayer: 4, nHead: 6, nKvHead: 2, hidden: 256, block: 64, seed: 11 }, B: 16 },
    { name: 'L   d=128 L=6 s=128', cfg: { d: 128, nLayer: 6, nHead: 8, nKvHead: 2, hidden: 344, block: 128, seed: 11 }, B: 16 },
    { name: 'XL  d=256 L=8 s=128', cfg: { d: 256, nLayer: 8, nHead: 8, nKvHead: 2, hidden: 688, block: 128, seed: 11 }, B: 16 },
  ];
  const { Model, setKernels } = nn;
  const jsK = { matmul: nn.matmul, matmulNT: nn.matmulNT, matmulTN_acc: nn.matmulTN_acc };
  console.log('档位              参数     tok/步   JS ms/步   WASM ms/步  加速   WASM 有效 GFLOP/s  峰值 rss');
  for (const g of grid) {
    const cfg = { ...g.cfg, vocab: 26 };
    const T = g.B * cfg.block;
    const idx = new Int32Array(T), tgt = new Int32Array(T);
    let s = 7; for (let i = 0; i < T; i++) { s = (s * 1103515245 + 12345) >>> 0; idx[i] = s % 26; tgt[i] = (s >> 8) % 26; }
    const times = [];
    for (const [label, kern] of [['js', jsK], ['wasm', k]]) {
      setKernels(kern);
      const m = new Model(cfg); m.alloc(g.B);
      for (let i = 0; i < 2; i++) { m.zeroGrad(); m.forward(idx, tgt, g.B); m.backward(idx, tgt, g.B); m.step(1e-3, i + 1); }
      const reps = label === 'js' ? 6 : 20;
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < reps; i++) { m.zeroGrad(); m.forward(idx, tgt, g.B); m.backward(idx, tgt, g.B); m.step(1e-3, i + 3); }
      times.push({ ms: Number(process.hrtime.bigint() - t0) / 1e6 / reps, n: m.nParams });
    }
    const [j, w] = times;
    const gf = 6 * j.n * T / 1e9 / (w.ms / 1000);
    console.log(`${g.name.padEnd(18)}${String(j.n).padStart(8)}  ${String(T).padStart(6)}  ${j.ms.toFixed(1).padStart(8)}  ${w.ms.toFixed(1).padStart(10)}  ${(j.ms / w.ms).toFixed(1)}x  ${gf.toFixed(1).padStart(12)}  ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
  }
})();
