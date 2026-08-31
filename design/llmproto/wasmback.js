'use strict';
const fs = require('fs'), path = require('path');
const wabt = require('wabt');

async function build() {
  const w = await wabt();
  const wat = fs.readFileSync(path.join(__dirname, 'kernels.wat'), 'utf8');
  const mod = w.parseWat('k.wat', wat, { simd: true });
  const { buffer } = mod.toBinary({});
  const inst = await WebAssembly.instantiate(new WebAssembly.Module(buffer), {});
  const ex = inst.exports;
  const mem = () => new Float32Array(ex.mem.buffer);
  let M = mem();
  // 三段 scratch：A / B / C。真实现里张量常驻 wasm 内存，这里每次拷贝 —— 是个保守上界。
  const CAP = 1 << 21; // 2M floats each
  const A0 = 0, B0 = CAP, C0 = 2 * CAP;
  const need = 3 * CAP * 4;
  if (ex.mem.buffer.byteLength < need) { ex.mem.grow(Math.ceil((need - ex.mem.buffer.byteLength) / 65536)); M = mem(); }

  const put = (off, src) => { M.set(src, off); };
  const get = (off, dst, n) => { dst.set(M.subarray(off, off + n)); };

  return {
    bytes: buffer.length,
    matmul(A, B, C, m, n, k) { put(A0, A.subarray(0, m * k)); put(B0, B.subarray(0, k * n)); ex.nn(A0 * 4, B0 * 4, C0 * 4, m, n, k); get(C0, C, m * n); },
    matmulTN_acc(A, B, C, m, n, k) { put(A0, A.subarray(0, m * k)); put(B0, B.subarray(0, m * n)); put(C0, C.subarray(0, k * n)); ex.tnacc(A0 * 4, B0 * 4, C0 * 4, m, n, k); get(C0, C, k * n); },
    matmulNT(A, B, C, m, k, n) { put(A0, A.subarray(0, m * n)); put(B0, B.subarray(0, k * n)); ex.nt(A0 * 4, B0 * 4, C0 * 4, m, k, n); get(C0, C, m * k); },
    raw: ex,
  };
}
module.exports = { build };

if (require.main === module) {
  (async () => {
    const k = await build();
    const nn = require('./nn');
    console.log(`kernels.wasm ${k.bytes} 字节`);
    const rnd = (n, s) => { const a = new Float32Array(n); let x = s >>> 0; for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; a[i] = x / 4294967296 - 0.5; } return a; };
    // 正确性
    for (const [M, N, K] of [[63, 37, 51], [512, 128, 128], [128, 176, 64]]) {
      const A = rnd(M * K, 1), B = rnd(K * N, 2);
      let c1 = new Float32Array(M * N), c2 = new Float32Array(M * N);
      nn.matmul(A, B, c1, M, N, K); k.matmul(A, B, c2, M, N, K);
      let d1 = 0; for (let i = 0; i < M * N; i++) d1 = Math.max(d1, Math.abs(c1[i] - c2[i]));
      const A2 = rnd(M * N, 3), B2 = rnd(K * N, 4);
      c1 = new Float32Array(M * K).fill(0); c2 = new Float32Array(M * K).fill(0);
      nn.matmulNT(A2, B2, c1, M, K, N); k.matmulNT(A2, B2, c2, M, K, N);
      let d2 = 0; for (let i = 0; i < M * K; i++) d2 = Math.max(d2, Math.abs(c1[i] - c2[i]));
      const A3 = rnd(M * K, 5), B3 = rnd(M * N, 6);
      c1 = rnd(K * N, 7); c2 = Float32Array.from(c1);
      nn.matmulTN_acc(A3, B3, c1, M, N, K); k.matmulTN_acc(A3, B3, c2, M, N, K);
      let d3 = 0; for (let i = 0; i < K * N; i++) d3 = Math.max(d3, Math.abs(c1[i] - c2[i]));
      console.log(`${M}x${N}x${K}  nn差 ${d1.toExponential(1)}  nt差 ${d2.toExponential(1)}  tnacc差 ${d3.toExponential(1)}`);
    }
  })();
}
