'use strict';
/* Pyodide 的三个数：启动耗时、Python→JS 调用开销、纯 Python 解释器速度 */
const { loadPyodide } = require('pyodide');
(async () => {
  let t0 = Date.now();
  const py = await loadPyodide({ packages: [] });
  console.log(`启动（不含 numpy）：${Date.now() - t0} ms`);

  // 纯 Python 解释器速度：一个 64x64x64 的三重循环 matmul
  t0 = Date.now();
  py.runPython(`
n = 48
A = [[(i*j) % 7 * 0.1 for j in range(n)] for i in range(n)]
B = [[(i+j) % 5 * 0.1 for j in range(n)] for i in range(n)]
C = [[0.0]*n for _ in range(n)]
for i in range(n):
    Ai = A[i]; Ci = C[i]
    for k in range(n):
        a = Ai[k]; Bk = B[k]
        for j in range(n):
            Ci[j] += a * Bk[j]
`);
  const pureMs = Date.now() - t0;
  console.log(`纯 Python 48³ matmul：${pureMs} ms  → ${(2 * 48 ** 3 / 1e6 / (pureMs / 1000)).toFixed(1)} MFLOP/s`);

  // Python → JS 调用开销
  globalThis.jsNoop = (a, b) => a + b;
  py.runPython(`
import js, time
t = time.perf_counter()
for _ in range(20000):
    js.jsNoop(1, 2)
print('Python→JS 每次调用 %.2f us' % ((time.perf_counter()-t)/20000*1e6))
`);

  // Python 里操作一个 JS 侧的 Float32Array（typed array 视图）
  globalThis.buf = new Float32Array(1024);
  py.runPython(`
import js, time
t = time.perf_counter()
b = js.buf.to_py()
print('to_py(1024 floats) %.3f ms' % ((time.perf_counter()-t)*1000))
`);

  // 装 numpy 看看体积与 matmul 速度
  t0 = Date.now();
  try {
    await py.loadPackage('numpy');
    console.log(`装 numpy：${Date.now() - t0} ms`);
    py.runPython(`
import numpy as np, time
for n in (128, 256):
    A = np.random.rand(n, n).astype(np.float32); B = np.random.rand(n, n).astype(np.float32)
    A @ B
    t = time.perf_counter(); reps = 20
    for _ in range(reps): C = A @ B
    s = time.perf_counter() - t
    print('numpy f32 %dx%d  %.2f GFLOP/s' % (n, n, 2*n**3*reps/1e9/s))
`);
  } catch (e) { console.log('numpy 装不上（离线？）：', String(e).slice(0, 200)); }
})();
