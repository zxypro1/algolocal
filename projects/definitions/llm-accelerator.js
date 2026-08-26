/**
 * CUDA GPU 编程实战：搭一个 LLM 加速引擎
 *
 * 工作台是 gpu 形态：任务 + 终端 + IDE + 剖析 + 访存。
 * 学员写真 CUDA C，敲真 nvcc / ncu / compute-sanitizer，
 * 门槛建立在平台侧的结构性计量上 —— 见 design/gpulab.md。
 *
 * 前 21 关在一张 H100 上，后 8 关摊到 16 卡集群。
 */
const { t, code, spec, gate } = require('./_helpers');

/* ------------------------------------------------------------------ */
/* 这台机器                                                            */
/* ------------------------------------------------------------------ */

const WORLD = {
  seed: 20260826,
  device: 'H100',
  globalBytes: 32 * 1024 * 1024,
  sharedBytesPerBlock: 48 * 1024,
  machine: {
    hostname: 'gpu-01',
    user: 'root',
    cwd: '/root',
  },
};

/** 每一关的判定都要先编译再跑，这段抄来抄去不如提出来 */
const RUN_AND_CHECK = `
  const lab = require('@gpu/lab');
`;

/** 恒定的硬门槛：竞态、越界、warp 同步用错，一律为 0 */
const SAFETY_GATES = [
  gate({
    metric: 'gpu.sanitizer.races', op: 'eq', value: 0,
    zh: '数据竞态', en: 'data races',
    dimension: 'correctness',
  }),
  gate({
    metric: 'gpu.sanitizer.warpSyncErrors', op: 'eq', value: 0,
    zh: 'warp 同步用错', en: 'warp sync errors',
    dimension: 'correctness',
  }),
];

/* ------------------------------------------------------------------ */
/* 第 1 关：第一个 kernel                                              */
/* ------------------------------------------------------------------ */

const N1 = 1000; // 故意不是 blockDim 的整数倍

const STAGE_1 = {
  id: 'first-kernel',
  title: t('第一个 kernel —— 线程、块、网格', 'Your first kernel — threads, blocks, grids'),
  goal: t(
    [
      '磁盘上有一个 `kernel.cu`，里面的 `vecAdd` 还是空的。把它写出来：`c[i] = a[i] + b[i]`。',
      '',
      '数组长度是 **1000**，而启动配置是 4 个 block × 256 线程 = **1024 个线程**。',
      '多出来的 24 个线程必须什么都不做 —— 让它们去写 `c[1000]` 就是越界，',
      '真卡上这会踩坏别人的显存，在这里会被 `compute-sanitizer` 当场抓住。',
      '',
      '```bash',
      'nvcc -o bench kernel.cu',
      './bench',
      'compute-sanitizer --tool memcheck ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 1000 个元素全部算对',
      '- 一次越界都没有',
      '- 每个线程只负责一个元素 —— 不许一个线程用循环把全部算完',
    ].join('\n'),
    [
      'There is a `kernel.cu` on disk with an empty `vecAdd`. Fill it in: `c[i] = a[i] + b[i]`.',
      '',
      'The array holds **1000** elements but the launch is 4 blocks × 256 threads = **1024 threads**.',
      'The extra 24 threads must do nothing. Letting them write `c[1000]` is out of bounds;',
      'on a real GPU that corrupts memory belonging to someone else, and here',
      '`compute-sanitizer` catches it immediately.',
      '',
      '```bash',
      'nvcc -o bench kernel.cu',
      './bench',
      'compute-sanitizer --tool memcheck ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- all 1000 elements correct',
      '- no out-of-bounds access',
      '- one element per thread — no single thread looping over everything',
    ].join('\n')
  ),
  checklist: [
    t('用 blockIdx / blockDim / threadIdx 算出这个线程负责哪个元素',
      'Derive this thread\'s element index from blockIdx / blockDim / threadIdx'),
    t('加上边界检查，让多出来的线程什么都不做',
      'Guard the tail so the extra threads do nothing'),
    t('`nvcc -o bench kernel.cu && ./bench` 跑通',
      'Get `nvcc -o bench kernel.cu && ./bench` to succeed'),
  ],
  hints: [
    t('全局线程号是 `blockIdx.x * blockDim.x + threadIdx.x`。',
      'The global thread index is `blockIdx.x * blockDim.x + threadIdx.x`.'),
    t('边界检查写成 `if (i < n) { ... }`。n 是传进来的参数，不要写死 1000。',
      'Guard with `if (i < n) { ... }`. `n` is a parameter — do not hard-code 1000.'),
  ],
  pitfalls: [
    t('**用 `threadIdx.x` 当全局下标。** 每个 block 里的 threadIdx 都从 0 开始，'
      + '于是 4 个 block 会把同样的 256 个元素算 4 遍，剩下的 744 个一个都没动。',
      '**Using `threadIdx.x` as the global index.** It restarts at 0 in every block, so the four '
      + 'blocks all compute the same 256 elements and the remaining 744 are never touched.'),
    t('**忘了边界检查。** 结果看起来可能是对的（多写的那几个格子没人读），'
      + '但 memcheck 会报越界 —— 真卡上那是别人的显存。',
      '**Forgetting the guard.** The result may look right (nobody reads those slots) but memcheck '
      + 'reports an out-of-bounds write — on a real GPU that memory belongs to someone else.'),
  ],
  extension: t(
    '真实的 kernel 常写成 **grid-stride loop**：`for (int i = idx; i < n; i += gridDim.x * blockDim.x)`。'
    + '这样同一份代码在任何启动配置下都正确，而且能复用已经驻留在 SM 上的 block。'
    + 'NVIDIA 的官方博客 [CUDA Pro Tip: Write Flexible Kernels with Grid-Stride Loops]'
    + '(https://developer.nvidia.com/blog/cuda-pro-tip-write-flexible-kernels-grid-stride-loops/) 讲的就是它。',
    'Real kernels often use a **grid-stride loop**: `for (int i = idx; i < n; i += gridDim.x * blockDim.x)`. '
    + 'The same code is then correct for any launch configuration and reuses blocks already resident on an SM. '
    + 'See NVIDIA\'s [CUDA Pro Tip: Write Flexible Kernels with Grid-Stride Loops]'
    + '(https://developer.nvidia.com/blog/cuda-pro-tip-write-flexible-kernels-grid-stride-loops/).'
  ),
  gpu: {
    files: {
      '/root/kernel.cu': code`
        // 每个线程负责一个元素：c[i] = a[i] + b[i]
        //
        // 注意 n = 1000，而启动的是 1024 个线程。
        __global__ void vecAdd(const float* a, const float* b, float* c, int n) {
          // TODO: 算出这个线程负责哪个元素，加上边界检查
        }
      `,
    },
    bench: {
      sources: ['/root/kernel.cu'],
      buffers: [
        { name: 'a', length: N1, fill: { kind: 'iota', scale: 0.5 } },
        { name: 'b', length: N1, fill: { kind: 'iota', scale: -0.25, offset: 7 } },
        { name: 'c', length: N1, fill: { kind: 'const', value: -999 } },
      ],
      launches: [
        { kernel: 'vecAdd', grid: [4], block: [256], args: ['a', 'b', 'c', N1] },
      ],
    },
    referenceFiles: {
      '/root/kernel.cu': code`
        __global__ void vecAdd(const float* a, const float* b, float* c, int n) {
          int i = blockIdx.x * blockDim.x + threadIdx.x;
          if (i < n) c[i] = a[i] + b[i];
        }
      `,
    },
  },
  specs: [
    spec('vecadd.spec.ts', code`
      const lab = require('@gpu/lab');

      describe('向量加法', () => {
        it('1000 个元素全部算对', async () => {
          await lab.buildAndRun();
          const a = lab.buffer('a');
          const b = lab.buffer('b');
          const c = lab.buffer('c');
          const expected = new Float32Array(a.length);
          for (let i = 0; i < a.length; i += 1) expected[i] = Math.fround(a[i] + b[i]);
          const diff = lab.compare(c, expected);
          expect(diff.hasNonFinite).toBe(false);
          expect(diff.maxAbs).toBe(0);
        });

        it('一次越界都没有', async () => {
          const result = await lab.sh('compute-sanitizer --tool memcheck ./bench');
          expect(result.code).toBe(0);
        });

        it('每个线程只算一个元素，没人用循环把全部包了', async () => {
          await lab.buildAndRun();
          const metrics = lab.metrics();
          // 1024 个线程，每个做一次读 a、一次读 b、一次写 c。
          // 有人写循环的话 lane 指令数会翻好几十倍。
          expect(metrics.global.loadRequests).toBeLessThanOrEqual(4 * 8 * 2 + 8);
          expect(metrics.inst.laneExecuted).toBeLessThan(60000);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.global.sectorsPerRequest', op: 'lte', value: 4.5,
      zh: '每次访存打到的 32B 扇区数', en: 'sectors per memory request',
      unit: 'sector/req', dimension: 'latency',
    }),
  ],
  focus: ['correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 2 关：访存合并                                                    */
/* ------------------------------------------------------------------ */

const ROWS2 = 64;
const COLS2 = 64;
const N2 = ROWS2 * COLS2;

const STAGE_2 = {
  id: 'coalescing',
  title: t('访存合并 —— 同一段逻辑，换个下标慢 8 倍', 'Coalescing — same logic, 8× the traffic'),
  goal: t(
    [
      '`scale.cu` 把一个 64×64 的矩阵每个元素乘以 2，算出来是对的。',
      '但 `ncu` 说它每次访存要打 **32 个 32B 扇区** —— 完美情况下应该是 4 个。',
      '',
      '```bash',
      'nvcc -o bench scale.cu && ncu ./bench',
      '```',
      '',
      '看 `Memory Workload Analysis` 那一节的',
      '`l1tex__average_t_sectors_per_request_pipe_lsu_mem_global_op_ld.ratio`。',
      '',
      '**为什么**：一个 warp 里 32 个 lane 的地址会被硬件归并成对 32 字节扇区的请求。',
      '32 个 lane 读连续的 32 个 float = 128 字节 = **4 个扇区**；',
      '如果它们各隔一整行，就是 **32 个扇区**，也就是 8 倍的传输量。',
      '指令一条没多，搬的字节数翻了 8 倍。',
      '',
      '**通关标准**',
      '',
      '- 结果和现在完全一样（每个元素都乘到了）',
      '- `sectorsPerRequest ≤ 4.5`',
      '- DRAM 读字节数降到理论下限附近',
    ].join('\n'),
    [
      '`scale.cu` multiplies every element of a 64×64 matrix by 2. The result is correct.',
      'But `ncu` reports **32 sectors per request** where a perfect kernel would need 4.',
      '',
      '```bash',
      'nvcc -o bench scale.cu && ncu ./bench',
      '```',
      '',
      'Look at `l1tex__average_t_sectors_per_request_pipe_lsu_mem_global_op_ld.ratio`',
      'under `Memory Workload Analysis`.',
      '',
      '**Why**: the 32 lanes of a warp have their addresses coalesced into 32-byte sector requests.',
      '32 lanes reading 32 consecutive floats = 128 bytes = **4 sectors**. If each lane instead',
      'reads a different row, that is **32 sectors** — 8× the traffic for the same instructions.',
      '',
      '**To pass**',
      '',
      '- identical results',
      '- `sectorsPerRequest ≤ 4.5`',
      '- DRAM read bytes near the theoretical minimum',
    ].join('\n')
  ),
  checklist: [
    t('让同一个 warp 里相邻的 lane 访问相邻的元素',
      'Make neighbouring lanes touch neighbouring elements'),
    t('用 `ncu ./bench` 确认扇区数掉到 4', 'Confirm with `ncu ./bench` that sectors drop to 4'),
  ],
  hints: [
    t('现在的下标是「lane 决定行、warp 决定列」，正好把连续的 lane 拆到了不同的行上。',
      'Right now the lane picks the row and the warp picks the column, which scatters consecutive lanes across rows.'),
    t('把它换成「相邻线程 → 相邻列」：`row = i / cols; col = i % cols;`，或者干脆按一维下标走。',
      'Switch to neighbouring threads → neighbouring columns: `row = i / cols; col = i % cols;` or just use the flat index.'),
  ],
  pitfalls: [
    t('**以为「反正总字节数一样」。** 总元素数确实一样，但传输是按 32 字节一整块走的：'
      + '只用到其中 4 个字节，剩下 28 个字节也被搬过来了，然后扔掉。',
      '**Assuming the byte count is the same either way.** The element count is, but transfers move whole '
      + '32-byte sectors: use 4 bytes of one and the other 28 come along anyway, then get thrown away.'),
    t('**只改读、不改写。** 写回也要合并，`ncu` 里 store 的扇区数是单独一行。',
      '**Fixing loads but not stores.** Stores coalesce too; ncu reports their sectors separately.'),
  ],
  extension: t(
    '这条规则是所有 GPU 访存优化的地基。矩阵转置之所以难，正是因为读和写不可能同时合并 ——'
    + '第 3、4 关就是用共享内存把这个矛盾解开。NVIDIA 的经典博客 '
    + '[How to Access Global Memory Efficiently in CUDA C/C++ Kernels]'
    + '(https://developer.nvidia.com/blog/how-access-global-memory-efficiently-cuda-c-kernels/) 把各种步长的代价量了一遍。',
    'This rule underpins every GPU memory optimisation. Matrix transpose is hard precisely because reads and '
    + 'writes cannot both be coalesced — stages 3 and 4 resolve that with shared memory. NVIDIA\'s '
    + '[How to Access Global Memory Efficiently in CUDA C/C++ Kernels]'
    + '(https://developer.nvidia.com/blog/how-access-global-memory-efficiently-cuda-c-kernels/) measures the cost of each stride.'
  ),
  gpu: {
    files: {
      '/root/scale.cu': code`
        // 把 64×64 的矩阵每个元素乘以 2。
        //
        // 结果是对的，但 ncu 说每次访存要打 32 个扇区。
        // 想想一个 warp 里相邻的 lane 现在落在哪儿。
        __global__ void scale(const float* in, float* out, int rows, int cols) {
          int i = blockIdx.x * blockDim.x + threadIdx.x;
          int lane = i % 32;
          int group = i / 32;

          // lane 决定行、group 决定列 —— 相邻的 lane 隔了一整行
          int row = lane * (rows / 32) + group / cols;
          int col = group % cols;

          if (row < rows && col < cols) {
            out[row * cols + col] = in[row * cols + col] * 2.0f;
          }
        }
      `,
    },
    bench: {
      sources: ['/root/scale.cu'],
      buffers: [
        { name: 'in', length: N2, fill: { kind: 'iota', scale: 0.125 } },
        { name: 'out', length: N2, fill: { kind: 'zeros' } },
      ],
      launches: [
        { kernel: 'scale', grid: [N2 / 128], block: [128], args: ['in', 'out', ROWS2, COLS2] },
      ],
    },
    referenceFiles: {
      '/root/scale.cu': code`
        __global__ void scale(const float* in, float* out, int rows, int cols) {
          int i = blockIdx.x * blockDim.x + threadIdx.x;
          // 相邻线程 → 相邻元素，一个 warp 正好覆盖连续的 128 字节
          if (i < rows * cols) out[i] = in[i] * 2.0f;
        }
      `,
    },
  },
  specs: [
    spec('coalescing.spec.ts', code`
      const lab = require('@gpu/lab');

      const ROWS = ${ROWS2};
      const COLS = ${COLS2};

      describe('矩阵缩放', () => {
        it('每个元素都乘到了', async () => {
          await lab.buildAndRun();
          const input = lab.buffer('in');
          const out = lab.buffer('out');
          const expected = new Float32Array(input.length);
          for (let i = 0; i < input.length; i += 1) expected[i] = Math.fround(input[i] * 2);
          const diff = lab.compare(out, expected);
          expect(diff.hasNonFinite).toBe(false);
          expect(diff.maxAbs).toBe(0);
        });

        it('读和写都合并了', async () => {
          await lab.buildAndRun();
          const metrics = lab.metrics();
          // 每次 warp 级访存 32 lane × 4 字节 = 128 字节 = 4 个扇区
          expect(metrics.global.loadSectors / metrics.global.loadRequests).toBeLessThanOrEqual(4.5);
          expect(metrics.global.storeSectors / metrics.global.storeRequests).toBeLessThanOrEqual(4.5);
        });

        it('DRAM 传输量降到理论下限附近', async () => {
          await lab.buildAndRun();
          const metrics = lab.metrics();
          const ideal = ROWS * COLS * 4;
          // 允许 10% 余量：尾块与对齐会带来一点额外传输
          expect(metrics.memory.readBytes).toBeLessThanOrEqual(ideal * 1.1);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.global.sectorsPerRequest', op: 'lte', value: 4.5,
      zh: '每次访存打到的 32B 扇区数（未优化时是 32）', en: 'sectors per request (32 before optimising)',
      unit: 'sector/req', dimension: 'latency',
    }),
    gate({
      metric: 'gpu.memory.readBytes', op: 'lte', value: Math.round(N2 * 4 * 1.1),
      zh: 'DRAM 读字节数', en: 'DRAM bytes read',
      unit: 'byte', dimension: 'latency',
    }),
  ],
  focus: ['latency'],
};

/* ------------------------------------------------------------------ */
/* 第 3 关：共享内存与竞态                                              */
/* ------------------------------------------------------------------ */

const TILE3 = 32;
const N3 = TILE3 * TILE3;

const STAGE_3 = {
  id: 'shared-memory-race',
  title: t('共享内存与竞态 —— 跑对了，但它是错的',
    'Shared memory and races — it works, and it is still wrong'),
  goal: t(
    [
      '转置一个 32×32 的矩阵。读和写不可能同时合并 —— 按行读就得按列写。',
      '解法是先把整块搬进**共享内存**（block 内所有线程共用的一小块高速内存），',
      '再从共享内存里按转置的顺序读出来写回去。这样读和写都是合并的。',
      '',
      '`transpose.cu` 已经这么写了。**它算出来的结果是错的**，而且每次错得一模一样。',
      '',
      '```bash',
      'nvcc -o bench transpose.cu && ./bench',
      'compute-sanitizer --tool racecheck ./bench',
      '```',
      '',
      'racecheck 会告诉你：一个线程写的格子，另一个线程在没有任何同步的情况下读了。',
      '`tile[y][x] = ...` 和 `... = tile[x][y]` 之间需要一个 **`__syncthreads()`** ——',
      '它让整个 block 的线程都停下来等，直到所有人都写完。',
      '',
      '**为什么这一关重要**：在这个模拟器里，warp 是按固定顺序跑的，',
      '所以有竞态的 kernel 会给出一个**稳定的**结果。这次它恰好是错的；',
      '换一种访问模式，它会**恰好是对的** —— 你跑一万遍都对，然后换到真卡上就炸。',
      '所以竞态不能靠「结果对不对」来发现，只能靠 racecheck。',
      '',
      '**通关标准**',
      '',
      '- 转置结果正确',
      '- `compute-sanitizer --tool racecheck` 报 0 hazards',
      '- 读写都合并（`sectorsPerRequest ≤ 4.5`）',
    ].join('\n'),
    [
      'Transpose a 32×32 matrix. Reads and writes cannot both be coalesced — reading along rows',
      'means writing along columns. The fix is to stage the tile through **shared memory**',
      '(a small fast block-local memory) and then read it back transposed, so both sides coalesce.',
      '',
      '`transpose.cu` already does that. **It produces the wrong answer**, and it is wrong the',
      'same way every single run.',
      '',
      '```bash',
      'nvcc -o bench transpose.cu && ./bench',
      'compute-sanitizer --tool racecheck ./bench',
      '```',
      '',
      'racecheck tells you: one thread writes a slot and another reads it with no synchronisation',
      'in between. You need a **`__syncthreads()`** between `tile[y][x] = ...` and `... = tile[x][y]` —',
      'it stops every thread in the block until all of them have finished writing.',
      '',
      '**Why this stage matters**: warps run in a fixed order in this simulator, so a racy kernel',
      'produces a *stable* result. Here it happens to be wrong. With a different access pattern it',
      'would happen to be **right** — correct ten thousand times here, broken on a real GPU.',
      'Races cannot be found by checking the answer. Only racecheck finds them.',
      '',
      '**To pass**',
      '',
      '- correct transpose',
      '- `compute-sanitizer --tool racecheck` reports 0 hazards',
      '- both sides coalesced (`sectorsPerRequest ≤ 4.5`)',
    ].join('\n')
  ),
  checklist: [
    t('跑一次 racecheck，看它指到哪两行', 'Run racecheck and read which two lines it points at'),
    t('在写共享内存和读共享内存之间加 `__syncthreads()`',
      'Add `__syncthreads()` between the shared-memory write and read'),
    t('确认 racecheck 报 0 hazards', 'Confirm racecheck reports 0 hazards'),
  ],
  hints: [
    t('`__syncthreads()` 必须让整个 block 都执行到 —— 不能放在 `if` 里面。',
      '`__syncthreads()` must be reached by every thread in the block — never put it inside an `if`.'),
    t('只需要一个屏障，位置在两次共享内存访问之间。',
      'One barrier is enough, between the two shared-memory accesses.'),
  ],
  pitfalls: [
    t('**把 `__syncthreads()` 放进 `if` 里。** 只有一部分线程到达屏障，'
      + '真卡上这是未定义行为、通常直接挂死；这里会明确报错。',
      '**Putting `__syncthreads()` inside an `if`.** Only some threads reach the barrier; on real '
      + 'hardware that is undefined behaviour and usually hangs. Here it is reported as an error.'),
    t('**靠「多跑几遍看看」找竞态。** 这个模拟器是确定的，跑一万遍是同一个结果。'
      + '真卡上也未必能重现 —— 竞态最擅长的就是在你观察它的时候表现正常。',
      '**Re-running to see if a race shows up.** This simulator is deterministic: ten thousand runs, '
      + 'one answer. Real hardware may not reproduce it either — races are best at looking fine while watched.'),
  ],
  extension: t(
    '`compute-sanitizer --tool racecheck` 是真工具，用法和这里一模一样。'
    + '它的原理是给共享内存的每个字配一份影子，记住最近是谁读的、谁写的、以及中间过了几次屏障；'
    + '同一个「屏障纪元」里两个不同线程冲突访问同一个字，就是竞态。'
    + '我们实现的是同一套判据 —— 见 [NVIDIA 的 racecheck 文档]'
    + '(https://docs.nvidia.com/cuda/compute-sanitizer/index.html#racecheck-tool)。',
    '`compute-sanitizer --tool racecheck` is the real tool and works exactly like this. It shadows every '
    + 'shared-memory word with the last reader, the last writer, and how many barriers have passed; two '
    + 'different threads accessing the same word inside one barrier epoch is a race. We implement the same '
    + 'rule — see [NVIDIA\'s racecheck documentation]'
    + '(https://docs.nvidia.com/cuda/compute-sanitizer/index.html#racecheck-tool).'
  ),
  gpu: {
    files: {
      '/root/transpose.cu': code`
        // 32×32 转置，经共享内存中转，好让读和写都合并。
        //
        // 结果是错的，而且每次错得一模一样 —— 先跑一次
        //   compute-sanitizer --tool racecheck ./bench
        // 看它指到哪两行。
        __global__ void transpose(const float* in, float* out, int n) {
          __shared__ float tile[32][33];   // 33 不是笔误，第 4 关会讲

          int x = threadIdx.x;
          int y = threadIdx.y;

          tile[y][x] = in[y * n + x];

          // TODO: 这里少了点什么

          out[y * n + x] = tile[x][y];
        }
      `,
    },
    bench: {
      sources: ['/root/transpose.cu'],
      buffers: [
        { name: 'in', length: N3, fill: { kind: 'iota', scale: 1 } },
        { name: 'out', length: N3, fill: { kind: 'zeros' } },
      ],
      launches: [
        { kernel: 'transpose', grid: [1], block: [TILE3, TILE3], args: ['in', 'out', TILE3] },
      ],
    },
    referenceFiles: {
      '/root/transpose.cu': code`
        __global__ void transpose(const float* in, float* out, int n) {
          __shared__ float tile[32][33];

          int x = threadIdx.x;
          int y = threadIdx.y;

          tile[y][x] = in[y * n + x];

          // 整个 block 都写完了，才能开始读别人写的格子
          __syncthreads();

          out[y * n + x] = tile[x][y];
        }
      `,
    },
  },
  specs: [
    spec('transpose.spec.ts', code`
      const lab = require('@gpu/lab');

      const N = ${TILE3};

      describe('转置', () => {
        it('结果正确', async () => {
          await lab.buildAndRun();
          const input = lab.buffer('in');
          const out = lab.buffer('out');
          const expected = new Float32Array(N * N);
          for (let y = 0; y < N; y += 1) {
            for (let x = 0; x < N; x += 1) expected[y * N + x] = input[x * N + y];
          }
          const diff = lab.compare(out, expected);
          expect(diff.hasNonFinite).toBe(false);
          expect(diff.maxAbs).toBe(0);
        });

        it('racecheck 报 0 hazards', async () => {
          const report = await lab.racecheck();
          expect(report.races.length).toBe(0);
        });

        it('确实用了屏障，而不是绕开共享内存', async () => {
          await lab.buildAndRun();
          const metrics = lab.metrics();
          expect(metrics.launch.barriers).toBeGreaterThan(0);
          expect(metrics.shared.storeRequests).toBeGreaterThan(0);
          expect(metrics.shared.loadRequests).toBeGreaterThan(0);
        });

        it('读和写都合并', async () => {
          await lab.buildAndRun();
          const metrics = lab.metrics();
          expect(metrics.global.sectorsPerRequest).toBeLessThanOrEqual(4.5);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.launch.barriers', op: 'gte', value: 1,
      zh: '屏障次数', en: 'barriers',
      dimension: 'correctness',
    }),
    gate({
      metric: 'gpu.global.sectorsPerRequest', op: 'lte', value: 4.5,
      zh: '每次访存打到的 32B 扇区数', en: 'sectors per request',
      unit: 'sector/req', dimension: 'latency',
    }),
  ],
  focus: ['correctness'],
};

/* ------------------------------------------------------------------ */

module.exports = {
  id: 'llm-accelerator',
  title: t('CUDA GPU 编程：搭一个 LLM 加速引擎', 'CUDA GPU programming: build an LLM inference engine'),
  summary: t(
    '写真 CUDA，用真 ncu 剖析。从第一个 kernel 一路做到能跑的推理引擎，最后摊到 16 卡集群上。',
    'Write real CUDA, profile with real ncu. From your first kernel to a working inference engine, then out to a 16-GPU cluster.'
  ),
  difficulty: 'Hard',
  domain: 'gpu',
  tags: ['cuda', 'gpu', 'performance', 'llm', 'parallel'],
  estimatedMinutes: 2400,
  language: 'typescript',
  brief: t(
    [
      '## 这是什么',
      '',
      '一台 H100，一个终端，一个 IDE。你写 CUDA C，敲 `nvcc` 编译、`ncu` 剖析、',
      '`compute-sanitizer` 查错 —— 命令、参数、指标名都和真机一样。',
      '',
      '## 判定标准',
      '',
      '**优化生效与否不是自称的。** 每一关的门槛都建立在平台侧的结构性计量上：',
      'DRAM 传输字节、32B 扇区数、bank 冲突路数、发散分支数、local memory 字节、',
      '占用率。这些量在给定内存模型后是精确的，而且**与硬件型号无关** ——',
      '换到真卡上一个不差。',
      '',
      '模拟耗时只用来展示和同关比较，**不作门槛**。',
      '',
      '## 已知的边界',
      '',
      '- 写的是 C99 子集 + CUDA 扩展，没有模板与类',
      '- 报错文本贴 nvcc 的形状，但做不到逐字节一致',
      '- 原子操作在这里按 lane 号定序，因此可复现；真卡上顺序不定',
    ].join('\n'),
    [
      '## What this is',
      '',
      'One H100, one terminal, one IDE. You write CUDA C and drive `nvcc`, `ncu` and',
      '`compute-sanitizer` — same commands, same flags, same metric names as the real thing.',
      '',
      '## How it is judged',
      '',
      '**Whether an optimisation worked is measured, not claimed.** Every gate is built on',
      'structural counters: DRAM bytes, 32-byte sectors, bank-conflict ways, divergent branches,',
      'local-memory traffic, occupancy. Given the memory model these are exact, and they are',
      '**independent of the specific GPU** — they carry over to real hardware unchanged.',
      '',
      'Simulated time is shown and compared within a stage, but never gates anything.',
      '',
      '## Known boundaries',
      '',
      '- a C99 subset plus CUDA extensions; no templates or classes',
      '- diagnostics follow nvcc\'s shape but are not byte-identical',
      '- atomics are ordered by lane here, so they reproduce; real hardware does not guarantee order',
    ].join('\n')
  ),
  weights: {
    correctness: 3,
    latency: 3,
    resilience: 1,
    encapsulation: 1,
    elegance: 1,
  },
  workspace: { kind: 'gpu', world: WORLD },
  files: [],
  stages: [STAGE_1, STAGE_2, STAGE_3],
};
