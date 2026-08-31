'use strict';
/* 手写 WASM SIMD 的 sgemm：验证「平台提供的算子核」能把地板抬多高 */
const wabt = require('wabt');

const WAT = `
(module
  (memory (export "mem") 1024)
  ;; sgemm: C[M,N] = A[M,K] @ B[K,N]，f32x4 向量化 j 维，i 维展开 4 行
  ;; 参数：aPtr bPtr cPtr M N K（字节偏移，f32 索引 × 4）
  (func (export "sgemm")
    (param $a i32) (param $b i32) (param $c i32)
    (param $M i32) (param $N i32) (param $K i32)
    (local $i i32) (local $k i32) (local $j i32)
    (local $n4 i32) (local $ci i32) (local $c1 i32) (local $c2 i32) (local $c3 i32)
    (local $ai i32) (local $bk i32)
    (local $v0 v128) (local $v1 v128) (local $v2 v128) (local $v3 v128)
    (local $bv v128)
    (local $s0 f32) (local $s1 f32) (local $s2 f32) (local $s3 f32)
    ;; C 清零
    (local.set $j (i32.const 0))
    (block $zdone (loop $z
      (br_if $zdone (i32.ge_u (local.get $j) (i32.mul (i32.mul (local.get $M) (local.get $N)) (i32.const 4))))
      (f32.store (i32.add (local.get $c) (local.get $j)) (f32.const 0))
      (local.set $j (i32.add (local.get $j) (i32.const 4)))
      (br $z)))
    (local.set $n4 (i32.and (local.get $N) (i32.const 0xfffffffc)))
    (local.set $i (i32.const 0))
    (block $idone (loop $iloop
      (br_if $idone (i32.gt_u (i32.add (local.get $i) (i32.const 4)) (local.get $M)))
      (local.set $ci (i32.add (local.get $c) (i32.mul (i32.mul (local.get $i) (local.get $N)) (i32.const 4))))
      (local.set $c1 (i32.add (local.get $ci) (i32.mul (local.get $N) (i32.const 4))))
      (local.set $c2 (i32.add (local.get $c1) (i32.mul (local.get $N) (i32.const 4))))
      (local.set $c3 (i32.add (local.get $c2) (i32.mul (local.get $N) (i32.const 4))))
      (local.set $ai (i32.add (local.get $a) (i32.mul (i32.mul (local.get $i) (local.get $K)) (i32.const 4))))
      (local.set $k (i32.const 0))
      (block $kdone (loop $kloop
        (br_if $kdone (i32.ge_u (local.get $k) (local.get $K)))
        (local.set $s0 (f32.load (i32.add (local.get $ai) (i32.mul (local.get $k) (i32.const 4)))))
        (local.set $s1 (f32.load (i32.add (local.get $ai) (i32.mul (i32.add (local.get $k) (local.get $K)) (i32.const 4)))))
        (local.set $s2 (f32.load (i32.add (local.get $ai) (i32.mul (i32.add (local.get $k) (i32.mul (local.get $K) (i32.const 2))) (i32.const 4)))))
        (local.set $s3 (f32.load (i32.add (local.get $ai) (i32.mul (i32.add (local.get $k) (i32.mul (local.get $K) (i32.const 3))) (i32.const 4)))))
        (local.set $v0 (f32x4.splat (local.get $s0)))
        (local.set $v1 (f32x4.splat (local.get $s1)))
        (local.set $v2 (f32x4.splat (local.get $s2)))
        (local.set $v3 (f32x4.splat (local.get $s3)))
        (local.set $bk (i32.add (local.get $b) (i32.mul (i32.mul (local.get $k) (local.get $N)) (i32.const 4))))
        (local.set $j (i32.const 0))
        (block $jdone (loop $jloop
          (br_if $jdone (i32.ge_u (local.get $j) (local.get $n4)))
          (local.set $bv (v128.load (i32.add (local.get $bk) (i32.mul (local.get $j) (i32.const 4)))))
          (v128.store (i32.add (local.get $ci) (i32.mul (local.get $j) (i32.const 4)))
            (f32x4.add (v128.load (i32.add (local.get $ci) (i32.mul (local.get $j) (i32.const 4))))
                       (f32x4.mul (local.get $v0) (local.get $bv))))
          (v128.store (i32.add (local.get $c1) (i32.mul (local.get $j) (i32.const 4)))
            (f32x4.add (v128.load (i32.add (local.get $c1) (i32.mul (local.get $j) (i32.const 4))))
                       (f32x4.mul (local.get $v1) (local.get $bv))))
          (v128.store (i32.add (local.get $c2) (i32.mul (local.get $j) (i32.const 4)))
            (f32x4.add (v128.load (i32.add (local.get $c2) (i32.mul (local.get $j) (i32.const 4))))
                       (f32x4.mul (local.get $v2) (local.get $bv))))
          (v128.store (i32.add (local.get $c3) (i32.mul (local.get $j) (i32.const 4)))
            (f32x4.add (v128.load (i32.add (local.get $c3) (i32.mul (local.get $j) (i32.const 4))))
                       (f32x4.mul (local.get $v3) (local.get $bv))))
          (local.set $j (i32.add (local.get $j) (i32.const 4)))
          (br $jloop)))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $kloop)))
      (local.set $i (i32.add (local.get $i) (i32.const 4)))
      (br $iloop)))
  )
)`;

(async () => {
  const w = await wabt();
  const mod = w.parseWat('m.wat', WAT, { simd: true });
  const { buffer } = mod.toBinary({});
  const inst = await WebAssembly.instantiate(new WebAssembly.Module(buffer), {});
  const ex = inst.exports;
  const mem = new Float32Array(ex.mem.buffer);

  function jsBlocked(A, B, C, M, N, K) {
    C.fill(0);
    for (let i0 = 0; i0 + 4 <= M; i0 += 4) {
      const c0 = i0 * N, c1 = c0 + N, c2 = c1 + N, c3 = c2 + N;
      const r0 = i0 * K, r1 = r0 + K, r2 = r1 + K, r3 = r2 + K;
      for (let k = 0; k < K; k++) {
        const a0 = A[r0 + k], a1 = A[r1 + k], a2 = A[r2 + k], a3 = A[r3 + k], bk = k * N;
        for (let j = 0; j < N; j++) { const b = B[bk + j]; C[c0 + j] += a0 * b; C[c1 + j] += a1 * b; C[c2 + j] += a2 * b; C[c3 + j] += a3 * b; }
      }
    }
  }

  for (const [M, N, K] of [[512, 128, 128], [512, 512, 128], [2048, 256, 256], [256, 256, 256]]) {
    const aOff = 0, bOff = M * K, cOff = M * K + K * N;
    let s = 1;
    for (let i = 0; i < M * K; i++) { s = (s * 1664525 + 1013904223) >>> 0; mem[aOff + i] = s / 4294967296 - 0.5; }
    for (let i = 0; i < K * N; i++) { s = (s * 1664525 + 1013904223) >>> 0; mem[bOff + i] = s / 4294967296 - 0.5; }
    const reps = Math.max(3, Math.round(3e9 / (2 * M * N * K)));
    ex.sgemm(aOff * 4, bOff * 4, cOff * 4, M, N, K);
    let t0 = process.hrtime.bigint();
    for (let r = 0; r < reps; r++) ex.sgemm(aOff * 4, bOff * 4, cOff * 4, M, N, K);
    let sec = Number(process.hrtime.bigint() - t0) / 1e9;
    const wasmG = 2 * M * N * K * reps / 1e9 / sec;

    const A = mem.slice(aOff, aOff + M * K), B = mem.slice(bOff, bOff + K * N), C = new Float32Array(M * N);
    jsBlocked(A, B, C, M, N, K);
    t0 = process.hrtime.bigint();
    for (let r = 0; r < reps; r++) jsBlocked(A, B, C, M, N, K);
    sec = Number(process.hrtime.bigint() - t0) / 1e9;
    const jsG = 2 * M * N * K * reps / 1e9 / sec;

    let maxd = 0;
    for (let i = 0; i < M * N; i++) maxd = Math.max(maxd, Math.abs(mem[cOff + i] - C[i]));
    console.log(`M=${String(M).padStart(4)} N=${String(N).padStart(3)} K=${String(K).padStart(3)}  JS ${jsG.toFixed(2)}  WASM-SIMD ${wasmG.toFixed(2)} GFLOP/s  加速 ${(wasmG / jsG).toFixed(2)}x  逐元素最大差 ${maxd}`);
  }
  console.log(`\nwasm 字节数：${buffer.length}`);
})();
