'use strict';
/* 数值梯度 vs 解析梯度：既验证原型的反向是对的，也是我要提案的一条门槛的原型 */
const { Model } = require('./nn');

const cfg = { vocab: 17, d: 32, nLayer: 2, nHead: 4, nKvHead: 2, hidden: 64, block: 8, seed: 7 };
const B = 2, T = B * cfg.block;
const m = new Model(cfg);
m.alloc(B);

const idx = new Int32Array(T), tgt = new Int32Array(T);
let s = 12345;
const nx = () => { s = (s * 1103515245 + 12345) >>> 0; return s % cfg.vocab; };
for (let i = 0; i < T; i++) { idx[i] = nx(); tgt[i] = nx(); }

m.zeroGrad();
m.forward(idx, tgt, B);
m.backward(idx, tgt, B);
const analytic = m.grads.map((g) => (process.env.F64?Float64Array:Float32Array).from(g));

// 数值梯度用中心差分；fp32 下步长取 3e-3（太小会被舍入淹没）
const H = process.env.F64 ? 1e-5 : 3e-3;
const names = ['emb'];
for (let l = 0; l < cfg.nLayer; l++) names.push(`L${l}.g1`, `L${l}.wq`, `L${l}.wk`, `L${l}.wv`, `L${l}.wo`, `L${l}.g2`, `L${l}.wg`, `L${l}.wu`, `L${l}.wd`);
names.push('gf');

let worst = 0, worstName = '';
let sr = 999;
const pick = (n) => { sr = (sr * 1103515245 + 12345) >>> 0; return sr % n; };
for (let p = 0; p < m.params.length; p++) {
  const w = m.params[p];
  let maxRel = 0;
  for (let trial = 0; trial < 8; trial++) {
    const i = pick(w.length);
    const orig = w[i];
    w[i] = Math.fround(orig + H); const lp = m.forward(idx, tgt, B);
    w[i] = Math.fround(orig - H); const lm = m.forward(idx, tgt, B);
    w[i] = orig;
    const num = (lp - lm) / (2 * H);
    const ana = analytic[p][i];
    const rel = Math.abs(num - ana) / Math.max(1e-4, Math.abs(num) + Math.abs(ana));
    if (rel > maxRel) maxRel = rel;
  }
  if (maxRel > worst) { worst = maxRel; worstName = names[p]; }
  console.log(`${names[p].padEnd(9)} 参数 ${String(w.length).padStart(6)}  最大相对误差 ${maxRel.toExponential(2)}`);
}
console.log(`\n全局最差：${worstName} ${worst.toExponential(2)}  ${worst < 2e-2 ? '通过' : '不通过'}`);
