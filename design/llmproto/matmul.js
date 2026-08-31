// 目标：量出浏览器/Node 里 Float32Array 的 sgemm 真实吞吐（GFLOP/s）
// 这是「能不能在浏览器里真训练」的地板：训练的 95% 时间都在 matmul 上。

function fill(n, seed) {
  const a = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; a[i] = (s / 4294967296) - 0.5; }
  return a;
}

// C[M,N] = A[M,K] * B[K,N]，朴素 i-j-k
function naive(A, B, C, M, N, K) {
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < N; j++) {
      let acc = 0;
      for (let k = 0; k < K; k++) acc += A[i * K + k] * B[k * N + j];
      C[i * N + j] = acc;
    }
  }
}

// i-k-j：B 按行连续访问，对 JIT 与 cache 友好得多
function ikj(A, B, C, M, N, K) {
  C.fill(0);
  for (let i = 0; i < M; i++) {
    const ci = i * N;
    for (let k = 0; k < K; k++) {
      const a = A[i * K + k];
      if (a === 0) continue;
      const bk = k * N;
      for (let j = 0; j < N; j++) C[ci + j] += a * B[bk + j];
    }
  }
}

// 4x4 寄存器分块 + i-k-j
function blocked(A, B, C, M, N, K) {
  C.fill(0);
  const MB = 4;
  for (let i0 = 0; i0 < M; i0 += MB) {
    const im = Math.min(MB, M - i0);
    for (let k = 0; k < K; k++) {
      const bk = k * N;
      if (im === 4) {
        const a0 = A[(i0) * K + k], a1 = A[(i0 + 1) * K + k], a2 = A[(i0 + 2) * K + k], a3 = A[(i0 + 3) * K + k];
        const c0 = i0 * N, c1 = c0 + N, c2 = c1 + N, c3 = c2 + N;
        for (let j = 0; j < N; j++) {
          const b = B[bk + j];
          C[c0 + j] += a0 * b; C[c1 + j] += a1 * b; C[c2 + j] += a2 * b; C[c3 + j] += a3 * b;
        }
      } else {
        for (let ii = 0; ii < im; ii++) {
          const a = A[(i0 + ii) * K + k], ci = (i0 + ii) * N;
          for (let j = 0; j < N; j++) C[ci + j] += a * B[bk + j];
        }
      }
    }
  }
}

function bench(name, fn, M, N, K, reps) {
  const A = fill(M * K, 1), B = fill(K * N, 2), C = new Float32Array(M * N);
  fn(A, B, C, M, N, K); // warmup
  const t0 = process.hrtime.bigint();
  for (let r = 0; r < reps; r++) fn(A, B, C, M, N, K);
  const t1 = process.hrtime.bigint();
  const sec = Number(t1 - t0) / 1e9;
  const gflop = (2 * M * N * K * reps) / 1e9;
  console.log(`${name.padEnd(9)} M=${M} N=${N} K=${K}  ${(sec / reps * 1000).toFixed(3)} ms/次  ${(gflop / sec).toFixed(2)} GFLOP/s`);
  return gflop / sec;
}

const shapes = [
  [512, 128, 128],   // 训练里典型：batch*seq=512, d_model=128
  [512, 512, 128],   // MLP 上投影
  [512, 128, 512],   // MLP 下投影
  [2048, 256, 256],
  [256, 256, 256],
];
for (const [M, N, K] of shapes) {
  const reps = Math.max(3, Math.round(2e9 / (2 * M * N * K)));
  bench('naive', naive, M, N, K, reps);
  bench('ikj', ikj, M, N, K, reps);
  bench('blocked4', blocked, M, N, K, reps);
  console.log('');
}
