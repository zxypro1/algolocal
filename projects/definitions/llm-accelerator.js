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
/* 第 4 关：bank conflict                                              */
/* ------------------------------------------------------------------ */

const TILE4 = 32;
const N4 = TILE4 * TILE4;

const STAGE_4 = {
  id: 'bank-conflicts',
  title: t('bank conflict —— 一列 padding 换来 32 倍的共享内存吞吐',
    'Bank conflicts — one column of padding, 32× the shared-memory throughput'),
  goal: t(
    [
      '第 3 关的 tile 声明是 `float tile[32][33]`，那个 33 当时说了「不是笔误，第 4 关会讲」。',
      '现在把它改回 `[32][32]`，转置结果一点没变，但 `ncu` 上多了 **992 路 bank 冲突**。',
      '',
      '```bash',
      'nvcc -o bench transpose.cu && ncu ./bench',
      '```',
      '',
      '看 `l1tex__data_bank_conflicts_pipe_lsu_mem_shared.sum`。',
      '',
      '**为什么**：共享内存被切成 **32 个 bank**，bank 号 = (字节地址 / 4) % 32。',
      '一个 warp 里 32 个 lane 同时访问，落在**不同 bank** 上就一次做完；',
      '落在**同一个 bank 的不同地址**上就得排队，n 个不同地址就是 n 路串行。',
      '',
      '`tile[x][y]` 这句里，warp 的 32 个 lane 走的是同一列：',
      '地址依次差 32 个 float，(地址/4) % 32 全都一样，于是 32 个 lane 全挤在一个 bank 上。',
      '把行宽改成 33，相邻行的同一列就错开一个 bank，冲突归零。',
      '',
      '注意**同一个 bank 上读同一个地址不算冲突**，那是广播，一点都不慢。',
      '',
      '**通关标准**',
      '',
      '- 转置结果不变',
      '- `bankConflicts = 0`',
      '- 共享内存的访问次数不许增加（不能靠「少用共享内存」蒙混过关）',
    ].join('\n'),
    [
      'In stage 3 the tile was declared `float tile[32][33]` and the 33 was left unexplained.',
      'Change it back to `[32][32]`: the transpose is still correct, but `ncu` now reports',
      '**992 bank-conflict ways**.',
      '',
      '```bash',
      'nvcc -o bench transpose.cu && ncu ./bench',
      '```',
      '',
      'Look at `l1tex__data_bank_conflicts_pipe_lsu_mem_shared.sum`.',
      '',
      '**Why**: shared memory is split into **32 banks**, bank = (byte address / 4) % 32.',
      'When the 32 lanes of a warp access it, lanes hitting **different banks** complete together;',
      'lanes hitting **different addresses in the same bank** serialise, n addresses meaning n ways.',
      '',
      'In `tile[x][y]` the warp walks one column: addresses differ by 32 floats, so',
      '(address/4) % 32 is identical for all lanes and all 32 pile into a single bank.',
      'Widening a row to 33 shifts each row by one bank and the conflicts vanish.',
      '',
      'Note that **the same address in the same bank is a broadcast**, not a conflict, and costs nothing.',
      '',
      '**To pass**',
      '',
      '- transpose still correct',
      '- `bankConflicts = 0`',
      '- shared-memory access count must not drop (no passing by avoiding shared memory)',
    ].join('\n')
  ),
  checklist: [
    t('跑 ncu，找到 bank 冲突那一行', 'Run ncu and find the bank-conflict line'),
    t('让相邻行的同一列落在不同的 bank 上', 'Make the same column of adjacent rows land in different banks'),
    t('确认冲突归零而共享内存访问次数没变',
      'Confirm conflicts hit zero while shared-memory accesses stay the same'),
  ],
  hints: [
    t('bank 号只看 (字节地址 / 4) % 32。行宽是 32 个 float 时，同一列的所有行都算出同一个 bank。',
      'The bank is just (byte address / 4) % 32. With a row of 32 floats every row in a column maps to the same bank.'),
    t('把行宽加 1（`[32][33]`）。多出来的那一列一个字节都不用，只是把后面的行整体挪开一个 bank。',
      'Widen the row by one (`[32][33]`). The extra column is never used; it just shifts every later row by one bank.'),
  ],
  pitfalls: [
    t('**改成用 `tile[y][x]` 读（不转置了）来消冲突。** 冲突是没了，但转置也没了，用例会挂。',
      '**Reading `tile[y][x]` instead (no transpose) to remove conflicts.** The conflicts go, and so does the transpose.'),
    t('**以为多申请的那一列浪费了内存。** 32×33 个 float 是 4224 字节，'
      + '而共享内存每 SM 有 228KB，这点开销换来 32 倍的吞吐。',
      '**Worrying about the wasted column.** 32×33 floats is 4224 bytes against 228KB of shared memory per SM, '
      + 'and it buys a 32× throughput improvement.'),
  ],
  extension: t(
    'padding 不是唯一解。CUTLASS 与 FlashAttention 这类库更常用 **swizzle**：'
    + '把行内的列按一个异或函数重排，同样错开 bank 而且不浪费任何字节，'
    + '代价是索引计算复杂一点。做 tensor core 的分块时 swizzle 几乎是标配，'
    + '因为那里的 tile 尺寸受 MMA 形状约束，不能随便加一列。',
    'Padding is not the only fix. Libraries such as CUTLASS and FlashAttention prefer **swizzling**: permute '
    + 'the columns within a row by an XOR function, which staggers the banks without wasting a single byte at '
    + 'the cost of slightly more index arithmetic. Swizzling is near-universal for tensor-core tiling, where '
    + 'MMA shapes constrain the tile size so an extra column is not an option.'
  ),
  gpu: {
    files: {
      '/root/transpose.cu': code`
        // 转置是对的，但共享内存的列访问全挤在一个 bank 上。
        //
        //   nvcc -o bench transpose.cu && ncu ./bench
        //
        // 看 l1tex__data_bank_conflicts_pipe_lsu_mem_shared.sum
        __global__ void transpose(const float* in, float* out, int n) {
          __shared__ float tile[32][32];   // TODO: 这里有问题

          int x = threadIdx.x;
          int y = threadIdx.y;

          tile[y][x] = in[y * n + x];
          __syncthreads();
          out[y * n + x] = tile[x][y];
        }
      `,
    },
    bench: {
      sources: ['/root/transpose.cu'],
      buffers: [
        { name: 'in', length: N4, fill: { kind: 'iota', scale: 1 } },
        { name: 'out', length: N4, fill: { kind: 'zeros' } },
      ],
      launches: [
        { kernel: 'transpose', grid: [1], block: [TILE4, TILE4], args: ['in', 'out', TILE4] },
      ],
    },
    referenceFiles: {
      '/root/transpose.cu': code`
        __global__ void transpose(const float* in, float* out, int n) {
          // 行宽 33：相邻行的同一列错开一个 bank，列访问不再串行
          __shared__ float tile[32][33];

          int x = threadIdx.x;
          int y = threadIdx.y;

          tile[y][x] = in[y * n + x];
          __syncthreads();
          out[y * n + x] = tile[x][y];
        }
      `,
    },
  },
  specs: [
    spec('bank.spec.ts', code`
      const lab = require('@gpu/lab');
      const N = ${TILE4};

      describe('无冲突的转置', () => {
        it('结果仍然正确', async () => {
          await lab.buildAndRun();
          const input = lab.buffer('in');
          const out = lab.buffer('out');
          const expected = new Float32Array(N * N);
          for (let y = 0; y < N; y += 1) {
            for (let x = 0; x < N; x += 1) expected[y * N + x] = input[x * N + y];
          }
          expect(lab.compare(out, expected).maxAbs).toBe(0);
        });

        it('bank 冲突归零', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().shared.bankConflicts).toBe(0);
        });

        it('还在用共享内存中转 —— 不是靠绕开它蒙混过关', async () => {
          await lab.buildAndRun();
          const metrics = lab.metrics();
          expect(metrics.shared.loadRequests).toBeGreaterThanOrEqual(N);
          expect(metrics.shared.storeRequests).toBeGreaterThanOrEqual(N);
          expect(metrics.global.sectorsPerRequest).toBeLessThanOrEqual(4.5);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.shared.bankConflicts', op: 'eq', value: 0,
      zh: '共享内存 bank 冲突路数（未优化时是 992）', en: 'shared bank-conflict ways (992 before)',
      dimension: 'latency',
    }),
    gate({
      metric: 'gpu.shared.loadRequests', op: 'gte', value: TILE4,
      zh: '共享内存读次数（防止绕开共享内存）', en: 'shared loads (guards against bypassing shared memory)',
      dimension: 'correctness',
    }),
  ],
  focus: ['latency'],
};

/* ------------------------------------------------------------------ */
/* 第 5 关：发散与 warp 原语                                            */
/* ------------------------------------------------------------------ */

const N5 = 4096;
const BLOCK5 = 128;
const BLOCKS5 = N5 / BLOCK5;

const STAGE_5 = {
  id: 'warp-reduce',
  title: t('发散与 warp 原语 —— 把 4096 次原子操作压到 32 次',
    'Divergence and warp primitives — from 4096 atomics down to 32'),
  goal: t(
    [
      '`reduce.cu` 把 4096 个数求和。做法最直白：每个线程 `atomicAdd(out, in[i])`。',
      '结果是对的，但 4096 个线程排队往同一个地址加，真卡上这是灾难。',
      '',
      '```bash',
      'nvcc -o bench reduce.cu && ncu ./bench',
      '```',
      '',
      '`Atomic Operations` 那一行是 4096。',
      '',
      '**换个做法**：一个 `warp`（32 个线程）内部可以不经过内存直接交换寄存器，',
      '用的是 `__shfl_xor_sync(0xffffffff, v, delta)` —— 它让每个 lane 拿到',
      '`lane ^ delta` 那个 lane 的 `v`。做 5 次（delta = 16, 8, 4, 2, 1），',
      'warp 里 32 个值就归并成了一个，**一次内存都不用碰**。',
      '然后每个 warp 只出一次 `atomicAdd`。',
      '',
      '**通关标准**',
      '',
      '- 和仍然正确（fp32 累加，容差见用例）',
      '- 原子操作次数 ≤ 128（4096 / 32）',
      '- 一次共享内存都不用',
      '- warp 内不发散',
    ].join('\n'),
    [
      '`reduce.cu` sums 4096 numbers the most direct way: every thread does `atomicAdd(out, in[i])`.',
      'The answer is right, but 4096 threads queueing on one address is a disaster on real hardware.',
      '',
      '```bash',
      'nvcc -o bench reduce.cu && ncu ./bench',
      '```',
      '',
      '`Atomic Operations` reads 4096.',
      '',
      '**A better way**: the 32 threads of a `warp` can exchange registers directly without going',
      'through memory, using `__shfl_xor_sync(0xffffffff, v, delta)` which hands each lane the `v`',
      'held by lane `lane ^ delta`. Five rounds (delta = 16, 8, 4, 2, 1) collapse 32 values into one',
      '**without touching memory at all**. Then each warp issues a single `atomicAdd`.',
      '',
      '**To pass**',
      '',
      '- the sum is still correct (fp32 accumulation, tolerance in the spec)',
      '- at most 128 atomic operations (4096 / 32)',
      '- no shared memory',
      '- no divergence inside a warp',
    ].join('\n')
  ),
  checklist: [
    t('用 5 次 `__shfl_xor_sync` 把 warp 内的 32 个值归并成 1 个',
      'Collapse 32 values into one with five `__shfl_xor_sync` rounds'),
    t('让每个 warp 只出一次 atomicAdd', 'Have each warp issue exactly one atomicAdd'),
    t('用 ncu 确认原子操作次数掉下来了', 'Confirm with ncu that the atomic count dropped'),
  ],
  hints: [
    t('蝶形归并：`for (int d = 16; d > 0; d >>= 1) v += __shfl_xor_sync(0xffffffff, v, d);`',
      'Butterfly reduction: `for (int d = 16; d > 0; d >>= 1) v += __shfl_xor_sync(0xffffffff, v, d);`'),
    t('归并完之后每个 lane 手里都是同一个和。用 `(threadIdx.x & 31) == 0` 挑出每个 warp 的 0 号 lane 去写。',
      'After the butterfly every lane holds the same sum. Pick lane 0 of each warp with `(threadIdx.x & 31) == 0` to write it.'),
  ],
  pitfalls: [
    t('**用 `__shfl_down_sync` 做归并之后，让所有 lane 都去 atomicAdd。** '
      + 'down 版归并完只有 0 号 lane 手里是对的，别的 lane 是部分和，全加进去结果会偏大。',
      '**Reducing with `__shfl_down_sync` and then letting every lane atomicAdd.** Only lane 0 holds the '
      + 'full sum after a down-shuffle; the others hold partial sums and adding them all inflates the result.'),
    t('**把 `__shfl_xor_sync` 的掩码写成 `__activemask()` 之后又在分歧区里调用。** '
      + '掩码里没点到的 lane 被读时是未定义值，这里会记成 warp 同步错误并挂掉门槛。',
      '**Passing `__activemask()` and then calling it inside divergent code.** Reading a lane outside the '
      + 'mask is undefined; here it is counted as a warp sync error and fails the gate.'),
  ],
  extension: t(
    '这套蝶形归并是 GPU 上一切规约的地基：softmax 求 max 与求和、LayerNorm 求均值与方差、'
    + 'FlashAttention 的行内归并，全都是它。CUDA 从 sm_80 起还提供了 `__reduce_add_sync`，'
    + '把整个蝶形压成一条指令。再往上一层是 CUB 的 `BlockReduce`，'
    + '它把 warp 内归并与跨 warp 的共享内存归并封在一起。',
    'This butterfly is the foundation of every reduction on a GPU: the max and sum in softmax, the mean and '
    + 'variance in LayerNorm, the row-wise reductions inside FlashAttention. From sm_80 CUDA also offers '
    + '`__reduce_add_sync`, collapsing the whole butterfly into one instruction, and above that CUB\'s '
    + '`BlockReduce` packages the warp-level and cross-warp shared-memory stages together.'
  ),
  gpu: {
    files: {
      '/root/reduce.cu': code`
        // 4096 个数求和。
        //
        // 结果对，但 4096 个线程排队往同一个地址加。
        // 用 __shfl_xor_sync 先在 warp 内归并，每个 warp 只出一次 atomicAdd。
        __global__ void reduceSum(const float* in, float* out, int n) {
          int i = blockIdx.x * blockDim.x + threadIdx.x;
          if (i < n) {
            atomicAdd(out, in[i]);
          }
        }
      `,
    },
    bench: {
      sources: ['/root/reduce.cu'],
      buffers: [
        { name: 'in', length: N5, fill: { kind: 'random', seed: 11, min: -2, max: 2 } },
        { name: 'out', length: 1, fill: { kind: 'zeros' } },
      ],
      launches: [
        { kernel: 'reduceSum', grid: [BLOCKS5], block: [BLOCK5], args: ['in', 'out', N5] },
      ],
    },
    referenceFiles: {
      '/root/reduce.cu': code`
        __global__ void reduceSum(const float* in, float* out, int n) {
          int i = blockIdx.x * blockDim.x + threadIdx.x;
          float v = (i < n) ? in[i] : 0.0f;

          // 蝶形归并：5 步把 warp 里的 32 个值收成一个
          for (int d = 16; d > 0; d >>= 1) {
            v += __shfl_xor_sync(0xffffffff, v, d);
          }

          // 每个 warp 只出一次原子操作
          if ((threadIdx.x & 31) == 0) {
            atomicAdd(out, v);
          }
        }
      `,
    },
  },
  specs: [
    spec('reduce.spec.ts', code`
      const lab = require('@gpu/lab');
      const N = ${N5};

      describe('规约求和', () => {
        it('和是对的', async () => {
          await lab.buildAndRun();
          const input = lab.buffer('in');
          let expected = 0;
          for (let i = 0; i < N; i += 1) expected += input[i];
          const actual = lab.buffer('out')[0];
          expect(Number.isFinite(actual)).toBe(true);
          // fp32 累加 4096 项，不同的归并顺序会有差别，按 sqrt(K)*eps 给界
          const tolerance = 8 * Math.sqrt(N) * Math.pow(2, -23) * Math.max(1, Math.abs(expected));
          expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(tolerance, 1e-3));
        });

        it('原子操作次数掉到每 warp 一次', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().atomics).toBeLessThanOrEqual(N / 32);
        });

        it('确实用了 warp 原语，而且一次共享内存都没碰', async () => {
          await lab.buildAndRun();
          const metrics = lab.metrics();
          expect(metrics.warp.shuffles).toBeGreaterThan(0);
          expect(metrics.shared.loadRequests + metrics.shared.storeRequests).toBe(0);
        });

        it('warp 内不发散', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().warp.activeLaneRatio).toBeGreaterThan(0.9);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.atomics', op: 'lte', value: N5 / 32,
      zh: '原子操作次数（未优化时是 4096）', en: 'atomic operations (4096 before)',
      dimension: 'latency',
    }),
    gate({
      metric: 'gpu.warp.shuffles', op: 'gte', value: 1,
      zh: 'warp 内交换指令数', en: 'warp shuffle instructions',
      dimension: 'latency',
    }),
    gate({
      metric: 'gpu.warp.activeLaneRatio', op: 'gte', value: 0.9,
      zh: '活跃 lane 占比', en: 'active lane ratio',
      dimension: 'latency',
    }),
  ],
  focus: ['latency', 'correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 6 关：occupancy 与寄存器压力                                       */
/* ------------------------------------------------------------------ */

const N6 = 2048;
const TAPS6 = 8;

const STAGE_6 = {
  id: 'occupancy',
  title: t('occupancy 与寄存器压力 —— 加了个小数组，怎么就慢了',
    'Occupancy and register pressure — one little array, and it fell over'),
  goal: t(
    [
      '`filter.cu` 做一个 8 抽头的滑动窗口加权和。它用一个 `float tap[8]` 暂存窗口里的值。',
      '结果是对的，指令数也正常，但 `ncu` 里有一行不对劲：**Local Memory Traffic 不是 0**。',
      '',
      '```bash',
      'nvcc -o bench filter.cu && ncu ./bench',
      '```',
      '',
      '**为什么**：线程私有的数组只有在**下标全是编译期常量**时才能待在寄存器里。',
      '只要出现一次动态下标（比如循环变量），整个数组就会被搬到 **local memory** ——',
      '那块内存名字叫 local，其实住在显存里。于是每次访问都要走一趟显存。',
      '',
      '更糟的是它对 occupancy 的影响：占用率是「一个 SM 上能同时驻留多少 warp」，',
      '决定了访存延迟能不能被别的 warp 的计算盖住。寄存器和共享内存都是每 SM 固定的，',
      '吃得越多能驻留的 block 越少。`ncu` 的 `Occupancy` 分节会直接告诉你是谁卡住了。',
      '',
      '**通关标准**',
      '',
      '- 结果不变',
      '- `local.bytes = 0`（数组回到寄存器里）',
      '- 理论占用率 ≥ 50%',
    ].join('\n'),
    [
      '`filter.cu` computes an 8-tap weighted sliding window, staging the window in a `float tap[8]`.',
      'The answer is right and the instruction count is normal, but one `ncu` line is off:',
      '**Local Memory Traffic is not zero**.',
      '',
      '```bash',
      'nvcc -o bench filter.cu && ncu ./bench',
      '```',
      '',
      '**Why**: a thread-private array can only live in registers when **every subscript is a',
      'compile-time constant**. A single dynamic index (a loop variable, say) moves the whole array',
      'to **local memory**, which despite the name lives in device memory. Every access becomes a',
      'round trip to DRAM.',
      '',
      'The occupancy cost is worse. Occupancy is how many warps stay resident on an SM, which decides',
      'whether memory latency can be hidden behind another warp\'s work. Registers and shared memory',
      'are fixed per SM, so the more you use the fewer blocks fit. The `Occupancy` section of `ncu`',
      'names the limiter directly.',
      '',
      '**To pass**',
      '',
      '- unchanged results',
      '- `local.bytes = 0` (the array is back in registers)',
      '- theoretical occupancy at least 50%',
    ].join('\n')
  ),
  checklist: [
    t('在 ncu 里找到 Local Memory Traffic 那一行', 'Find the Local Memory Traffic line in ncu'),
    t('把数组的动态下标去掉，或者干脆不用数组',
      'Remove the dynamic subscript, or drop the array altogether'),
    t('确认 local.bytes 归零、占用率上来了',
      'Confirm local.bytes hits zero and occupancy recovers'),
  ],
  hints: [
    t('8 个抽头是固定的。把循环展开，用 8 个标量变量，或者用常量下标访问数组。',
      'There are exactly eight taps. Unroll the loop into eight scalars, or index the array with constants.'),
    t('只要有一处写成 `tap[k]`（k 是循环变量），整个数组就会落到 local memory。',
      'A single `tap[k]` with a loop variable `k` sends the whole array to local memory.'),
  ],
  pitfalls: [
    t('**只把读改成常量下标，写还留着 `tap[k] = ...`。** 判断是按整个数组来的，'
      + '有一处动态就全落 local memory。',
      '**Making reads constant but leaving `tap[k] = ...`.** The decision is per array: one dynamic '
      + 'subscript anywhere sends all of it to local memory.'),
    t('**盯着寄存器数优化。** 数组落到 local memory 之后寄存器数反而**变少**了，'
      + '看寄存器数会以为优化成功了。真正的证据是 `local.bytes`。',
      '**Optimising for register count.** Spilling the array to local memory actually *reduces* the '
      + 'register count, so that number looks like an improvement. The real evidence is `local.bytes`.'),
  ],
  extension: t(
    '寄存器分块（register tiling）正是把这条规则反过来用：GEMM 里让每个线程算 4×4 甚至 8×8 个输出，'
    + '那些累加器全部待在寄存器里，于是每从显存读一个数就能做更多次乘加，算术强度直接上去。'
    + '第 9 关做的就是这件事，前提就是这一关的规则：常量下标才能进寄存器。'
    + 'nvcc 的 `-maxrregcount` 与 `__launch_bounds__` 可以反过来限制寄存器数来换占用率，'
    + '那是另一个方向的权衡。',
    'Register tiling applies this rule in reverse: in a GEMM each thread computes a 4×4 or even 8×8 output '
    + 'tile whose accumulators all live in registers, so every value loaded from memory feeds many more '
    + 'multiply-adds and arithmetic intensity rises. That is stage 9, and it depends on the rule learned here. '
    + 'In the other direction, nvcc\'s `-maxrregcount` and `__launch_bounds__` cap register usage to buy '
    + 'occupancy back.'
  ),
  gpu: {
    files: {
      '/root/filter.cu': code`
        // 8 抽头滑动窗口加权和。
        //
        // 结果是对的，但 ncu 里 Local Memory Traffic 不是 0。
        //   nvcc -o bench filter.cu && ncu ./bench
        __global__ void filter8(const float* in, float* out, int n) {
          int i = blockIdx.x * blockDim.x + threadIdx.x;
          if (i >= n) return;

          float tap[8];

          // 动态下标：整个 tap 数组会被搬到 local memory
          for (int k = 0; k < 8; ++k) {
            int j = i + k;
            tap[k] = (j < n) ? in[j] : 0.0f;
          }

          float acc = 0.0f;
          for (int k = 0; k < 8; ++k) {
            acc += tap[k] * (float)(k + 1);
          }
          out[i] = acc;
        }
      `,
    },
    bench: {
      sources: ['/root/filter.cu'],
      buffers: [
        { name: 'in', length: N6, fill: { kind: 'random', seed: 23, min: -1, max: 1 } },
        { name: 'out', length: N6, fill: { kind: 'zeros' } },
      ],
      launches: [
        { kernel: 'filter8', grid: [N6 / 256], block: [256], args: ['in', 'out', N6] },
      ],
    },
    referenceFiles: {
      '/root/filter.cu': code`
        __global__ void filter8(const float* in, float* out, int n) {
          int i = blockIdx.x * blockDim.x + threadIdx.x;
          if (i >= n) return;

          // 8 个标量，全部待在寄存器里 —— 一个字节 local memory 都不用
          float t0 = (i + 0 < n) ? in[i + 0] : 0.0f;
          float t1 = (i + 1 < n) ? in[i + 1] : 0.0f;
          float t2 = (i + 2 < n) ? in[i + 2] : 0.0f;
          float t3 = (i + 3 < n) ? in[i + 3] : 0.0f;
          float t4 = (i + 4 < n) ? in[i + 4] : 0.0f;
          float t5 = (i + 5 < n) ? in[i + 5] : 0.0f;
          float t6 = (i + 6 < n) ? in[i + 6] : 0.0f;
          float t7 = (i + 7 < n) ? in[i + 7] : 0.0f;

          out[i] = t0 * 1.0f + t1 * 2.0f + t2 * 3.0f + t3 * 4.0f
                 + t4 * 5.0f + t5 * 6.0f + t6 * 7.0f + t7 * 8.0f;
        }
      `,
    },
  },
  specs: [
    spec('filter.spec.ts', code`
      const lab = require('@gpu/lab');
      const N = ${N6};
      const TAPS = ${TAPS6};

      describe('滑动窗口', () => {
        it('结果正确', async () => {
          await lab.buildAndRun();
          const input = lab.buffer('in');
          const out = lab.buffer('out');
          const expected = new Float32Array(N);
          for (let i = 0; i < N; i += 1) {
            let acc = 0;
            for (let k = 0; k < TAPS; k += 1) {
              const j = i + k;
              acc = Math.fround(acc + Math.fround((j < N ? input[j] : 0) * (k + 1)));
            }
            expected[i] = acc;
          }
          const diff = lab.compare(out, expected);
          expect(diff.hasNonFinite).toBe(false);
          expect(diff.maxUlp).toBeLessThanOrEqual(4);
        });

        it('一个字节 local memory 都不用', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().local.bytes).toBe(0);
        });

        it('理论占用率至少一半', async () => {
          await lab.buildAndRun();
          const stat = lab.staticMetrics();
          expect(stat).not.toBeNull();
          expect(stat.occupancy.theoretical).toBeGreaterThanOrEqual(0.5);
        });

        it('没有靠少读数据来蒙混 —— 8 个抽头都读了', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().global.loadRequests).toBeGreaterThanOrEqual((N / 32) * (TAPS - 1));
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.local.bytes', op: 'eq', value: 0,
      zh: 'local memory 流量（未优化时不为 0）', en: 'local memory traffic (non-zero before)',
      unit: 'byte', dimension: 'latency',
    }),
    gate({
      metric: 'gpu.occupancy.theoretical', op: 'gte', value: 0.5,
      zh: '理论占用率', en: 'theoretical occupancy',
      dimension: 'latency',
    }),
  ],
  focus: ['latency'],
};

/* ------------------------------------------------------------------ */
/* 第 7 关：朴素 GEMM                                                   */
/* ------------------------------------------------------------------ */

const N7 = 128;

/** 三关共用的 GEMM 场景：128×128，A 与 B 用固定种子填 */
const gemmBench = (kernel) => ({
  sources: ['/root/sgemm.cu'],
  buffers: [
    { name: 'A', length: N7 * N7, fill: { kind: 'random', seed: 31, min: -1, max: 1 } },
    { name: 'B', length: N7 * N7, fill: { kind: 'random', seed: 37, min: -1, max: 1 } },
    { name: 'C', length: N7 * N7, fill: { kind: 'zeros' } },
  ],
  launches: [kernel],
});

/** 结果对不对：拿 fp64 算一遍参考，按 sqrt(K)*eps 给界 */
const GEMM_CORRECTNESS = code`
  it('结果和 fp64 参考对得上', async () => {
    await lab.buildAndRun();
    const A = lab.buffer('A');
    const B = lab.buffer('B');
    const C = lab.buffer('C');
    // 抽样比较：全比一遍要 128^3 次乘加，没必要
    let worst = 0;
    for (let row = 0; row < N; row += 7) {
      for (let col = 0; col < N; col += 7) {
        let expected = 0;
        for (let k = 0; k < N; k += 1) expected += A[row * N + k] * B[k * N + col];
        const actual = C[row * N + col];
        expect(Number.isFinite(actual)).toBe(true);
        worst = Math.max(worst, Math.abs(actual - expected) / Math.max(1, Math.abs(expected)));
      }
    }
    // fp32 累加 128 项：8 * sqrt(128) * 2^-23 约等于 1.1e-5
    expect(worst).toBeLessThanOrEqual(2e-5);
  });
`;

const STAGE_7 = {
  id: 'naive-gemm',
  title: t('朴素 GEMM —— 先跑通，看它落在 roofline 的哪儿',
    'Naive GEMM — get it working, then find it on the roofline'),
  goal: t(
    [
      '矩阵乘法是 LLM 里绝大部分算力的去处。先用最直白的写法做出来：',
      '每个线程负责输出矩阵的一个元素，沿 k 维做一遍点积。',
      '',
      '规模是 128×128×128，启动配置 8×8 个 block、每块 16×16 个线程。',
      '',
      '```bash',
      'nvcc -o bench sgemm.cu && ncu ./bench',
      '```',
      '',
      '**这一关不设性能门槛。** 它的作用是立一根标杆：跑完之后记下',
      '`Arithmetic Intensity` 那一行（每从显存搬一个字节做了多少次浮点运算）',
      '和 DRAM 读字节数。第 8、9 关会把这两个数分别改善 8 倍与 25 倍。',
      '',
      '朴素写法的问题在于：A 的每一行被读了 128 遍，B 的每一列也是。',
      '算术强度只有 0.5，也就是搬两个字节才做一次乘加 —— 这种 kernel 卡在带宽上，',
      'GPU 那几十 TFLOPS 的算力一点用不上。',
      '',
      '**通关标准**',
      '',
      '- 结果和 fp64 参考对得上（相对误差 ≤ 2e-5）',
      '- 每个线程只算一个输出元素',
      '- 访存是合并的',
    ].join('\n'),
    [
      'Matrix multiplication is where nearly all the FLOPs in an LLM go. Start with the direct',
      'version: one thread per output element, one dot product along k.',
      '',
      'The size is 128×128×128, launched as 8×8 blocks of 16×16 threads.',
      '',
      '```bash',
      'nvcc -o bench sgemm.cu && ncu ./bench',
      '```',
      '',
      '**No performance gate here.** This stage plants a marker: note the `Arithmetic Intensity`',
      'line (floating-point operations per byte fetched from memory) and the DRAM read bytes.',
      'Stages 8 and 9 improve those by 8× and 25×.',
      '',
      'The problem with the direct version is that every row of A is read 128 times and so is every',
      'column of B. Arithmetic intensity is 0.5, meaning two bytes moved per multiply-add. A kernel',
      'like that is bandwidth-bound and the tens of TFLOPs of compute sit idle.',
      '',
      '**To pass**',
      '',
      '- results match an fp64 reference (relative error ≤ 2e-5)',
      '- one output element per thread',
      '- coalesced memory access',
    ].join('\n')
  ),
  checklist: [
    t('算出这个线程负责哪一行、哪一列', 'Work out which row and column this thread owns'),
    t('沿 k 维累加 A[row][k] * B[k][col]', 'Accumulate A[row][k] * B[k][col] along k'),
    t('用 ncu 记下算术强度与 DRAM 读字节数', 'Note arithmetic intensity and DRAM bytes with ncu'),
  ],
  hints: [
    t('`row` 用 blockIdx.y / threadIdx.y，`col` 用 blockIdx.x / threadIdx.x。',
      'Use blockIdx.y / threadIdx.y for `row` and blockIdx.x / threadIdx.x for `col`.'),
    t('用 `fmaf(a, b, acc)` 而不是 `acc += a * b`，一次舍入而不是两次。',
      'Prefer `fmaf(a, b, acc)` over `acc += a * b`: one rounding instead of two.'),
  ],
  pitfalls: [
    t('**把 row 和 col 接反。** `col` 必须跟着 threadIdx.x 走，'
      + '这样同一个 warp 里相邻的线程才访问 B 的相邻列，访存才合并。接反了扇区数会翻 8 倍。',
      '**Swapping row and col.** `col` must follow threadIdx.x so neighbouring lanes read neighbouring '
      + 'columns of B and the access coalesces. Swapped, the sector count goes up 8×.'),
    t('**累加器用 double。** 这个工作台只做 fp32；真卡上 fp64 的吞吐是 fp32 的 1/64，'
      + '拿它当累加器会让 kernel 慢两个数量级。',
      '**Accumulating in double.** This workbench is fp32 only, and on real hardware fp64 throughput '
      + 'is 1/64 of fp32, so using it as an accumulator costs two orders of magnitude.'),
  ],
  extension: t(
    'roofline 图上有两段：一段斜坡（受带宽限制）和一段平台（受算力限制），交界处叫**拐点**。'
    + 'H100 的拐点在几十 FLOP/byte，而朴素 GEMM 的算术强度是 0.5，'
    + '离拐点差两个数量级 —— 它稳稳落在斜坡的最左边。'
    + '接下来两关做的事情，本质上就是把这个点沿横轴往右推。',
    'A roofline chart has two segments: a bandwidth-limited slope and a compute-limited plateau, '
    + 'meeting at the **ridge point**. On an H100 that ridge sits in the tens of FLOP/byte, while naive '
    + 'GEMM has an arithmetic intensity of 0.5, two orders of magnitude to the left of it, firmly on the '
    + 'slope. The next two stages are, in essence, about pushing that point to the right.'
  ),
  gpu: {
    files: {
      '/root/sgemm.cu': code`
        // C = A * B，都是 128×128 的方阵。
        //
        // 每个线程算 C 的一个元素。启动配置是 8×8 个 block、每块 16×16 线程。
        __global__ void sgemm(const float* A, const float* B, float* C, int n) {
          // TODO: 算出 row 与 col，沿 k 维做点积
        }
      `,
    },
    bench: gemmBench({
      kernel: 'sgemm', grid: [N7 / 16, N7 / 16], block: [16, 16],
      args: ['A', 'B', 'C', N7],
    }),
    referenceFiles: {
      '/root/sgemm.cu': code`
        __global__ void sgemm(const float* A, const float* B, float* C, int n) {
          int row = blockIdx.y * blockDim.y + threadIdx.y;
          int col = blockIdx.x * blockDim.x + threadIdx.x;
          if (row < n && col < n) {
            float acc = 0.0f;
            for (int k = 0; k < n; ++k) {
              acc = fmaf(A[row * n + k], B[k * n + col], acc);
            }
            C[row * n + col] = acc;
          }
        }
      `,
    },
  },
  specs: [
    spec('gemm.spec.ts', code`
      const lab = require('@gpu/lab');
      const N = ${N7};

      describe('朴素 GEMM', () => {
      ${GEMM_CORRECTNESS}
        it('访存是合并的', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().global.sectorsPerRequest).toBeLessThanOrEqual(4.5);
        });

        it('每个线程只算一个输出 —— 乘加总数就是 n^3', async () => {
          await lab.buildAndRun();
          const fma = lab.metrics().inst.fma;
          expect(fma).toBeGreaterThanOrEqual(N * N * N);
          expect(fma).toBeLessThan(N * N * N * 1.2);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.global.sectorsPerRequest', op: 'lte', value: 4.5,
      zh: '每次访存打到的 32B 扇区数', en: 'sectors per request',
      unit: 'sector/req', dimension: 'latency',
    }),
    gate({
      metric: 'gpu.inst.fma', op: 'gte', value: N7 * N7 * N7,
      zh: '乘加总数（确认真的在算矩阵乘）', en: 'FMA count (confirms the work is done)',
      dimension: 'correctness',
    }),
  ],
  focus: ['correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 8 关：共享内存分块 GEMM                                            */
/* ------------------------------------------------------------------ */

const STAGE_8 = {
  id: 'tiled-gemm',
  title: t('分块 GEMM —— 把 DRAM 读量砍掉 8 倍', 'Tiled GEMM — 8× less DRAM traffic'),
  goal: t(
    [
      '上一关的朴素 GEMM 从 DRAM 读了 **8 MB**，而 A 和 B 加起来才 128 KB。',
      '同一份数据被反复读了几十遍。',
      '',
      '**分块**解决这件事：把 A 和 B 各切成 16×16 的小块，一次搬一对到共享内存，',
      '让 block 里的 256 个线程都从共享内存取数。每个元素从 DRAM 读一次，',
      '在共享内存里被用 16 次。',
      '',
      '流程是：搬一块 → `__syncthreads()` → 用这一块累加 → `__syncthreads()` → 搬下一块。',
      '**两个屏障都不能少**：第一个保证「大家都搬完了才开始算」，',
      '第二个保证「大家都算完了才开始覆盖」。',
      '',
      '```bash',
      'nvcc -o bench sgemm.cu && ncu ./bench',
      'compute-sanitizer --tool racecheck ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 结果和上一关一样',
      '- DRAM 读量 ≤ 2 MB（朴素版是 8 MB）',
      '- bank 冲突为 0',
      '- 没有竞态',
    ].join('\n'),
    [
      'The naive GEMM read **8 MB** from DRAM while A and B together are only 128 KB.',
      'The same data was fetched dozens of times.',
      '',
      '**Tiling** fixes that: cut A and B into 16×16 tiles, stage one pair at a time in shared memory,',
      'and let all 256 threads of the block read from there. Each element is fetched from DRAM once',
      'and used 16 times out of shared memory.',
      '',
      'The loop is: stage a tile, `__syncthreads()`, accumulate, `__syncthreads()`, stage the next.',
      '**Neither barrier is optional**: the first guarantees everyone finished writing before anyone',
      'reads, the second guarantees everyone finished reading before anyone overwrites.',
      '',
      '```bash',
      'nvcc -o bench sgemm.cu && ncu ./bench',
      'compute-sanitizer --tool racecheck ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- same results as before',
      '- DRAM reads at most 2 MB (8 MB before)',
      '- zero bank conflicts',
      '- no races',
    ].join('\n')
  ),
  checklist: [
    t('声明两块 16×16 的共享内存暂存 A 与 B 的分块',
      'Declare two 16×16 shared tiles for the A and B blocks'),
    t('外层沿 k 维按分块推进，内层在共享内存里做 16 次乘加',
      'Step tiles along k in the outer loop, 16 multiply-adds in shared memory in the inner one'),
    t('两个 __syncthreads() 都不能少', 'Both `__syncthreads()` calls are required'),
  ],
  hints: [
    t('每个线程搬一个 A 元素和一个 B 元素进共享内存，正好 16×16 = 256 个线程搬一整块。',
      'Each thread stages one A element and one B element; 16×16 = 256 threads cover a whole tile.'),
    t('搬 A 时用 `A[row * n + t * 16 + tx]`，搬 B 时用 `B[(t * 16 + ty) * n + col]` —— 两边都是合并的。',
      'Stage A with `A[row * n + t * 16 + tx]` and B with `B[(t * 16 + ty) * n + col]`; both coalesce.'),
  ],
  pitfalls: [
    t('**只放一个屏障。** 少了第二个，跑得快的线程会在别人还没读完时就覆盖共享内存。'
      + 'racecheck 会指出来，而结果不一定错 —— 这正是第 3 关讲过的。',
      '**Using only one barrier.** Without the second, a fast thread overwrites the tile while others '
      + 'are still reading it. racecheck reports it even when the answer happens to be right, exactly as in stage 3.'),
    t('**分块循环写成 `k < n` 而不是 `t < n / 16`。** 外层走的是分块数不是元素数。',
      '**Writing the tile loop as `k < n` instead of `t < n / 16`.** The outer loop counts tiles, not elements.'),
  ],
  extension: t(
    '这一关把算术强度从 0.5 推到 3.8，但离 H100 拐点的几十 FLOP/byte 还差得远。'
    + '瓶颈已经从 DRAM 换成了共享内存的带宽：每做一次乘加就要从共享内存读两个数。'
    + '下一关用寄存器分块把这个比例再改善一个量级。'
    + 'CUTLASS 把这套层次叫做 threadblock tile / warp tile / thread tile，是同一个思路的三层展开。',
    'This stage lifts arithmetic intensity from 0.5 to 3.8, still far from the H100 ridge in the tens of '
    + 'FLOP/byte. The bottleneck has merely moved from DRAM to shared-memory bandwidth: every multiply-add '
    + 'still reads two values out of shared memory. The next stage improves that ratio by another order of '
    + 'magnitude with register tiling. CUTLASS calls this hierarchy threadblock tile / warp tile / thread '
    + 'tile, which is the same idea unrolled three levels deep.'
  ),
  gpu: {
    files: {
      '/root/sgemm.cu': code`
        // 上一关的朴素版：结果对，但从 DRAM 读了 8MB。
        //
        // 改成分块：把 A 和 B 各切成 16×16 的块搬进共享内存。
        __global__ void sgemm(const float* A, const float* B, float* C, int n) {
          int row = blockIdx.y * blockDim.y + threadIdx.y;
          int col = blockIdx.x * blockDim.x + threadIdx.x;
          if (row < n && col < n) {
            float acc = 0.0f;
            for (int k = 0; k < n; ++k) {
              acc = fmaf(A[row * n + k], B[k * n + col], acc);
            }
            C[row * n + col] = acc;
          }
        }
      `,
    },
    bench: gemmBench({
      kernel: 'sgemm', grid: [N7 / 16, N7 / 16], block: [16, 16],
      args: ['A', 'B', 'C', N7],
    }),
    referenceFiles: {
      '/root/sgemm.cu': code`
        __global__ void sgemm(const float* A, const float* B, float* C, int n) {
          __shared__ float As[16][16];
          __shared__ float Bs[16][16];

          int tx = threadIdx.x;
          int ty = threadIdx.y;
          int row = blockIdx.y * 16 + ty;
          int col = blockIdx.x * 16 + tx;

          float acc = 0.0f;
          for (int t = 0; t < n / 16; ++t) {
            // 每个线程搬一个 A 元素、一个 B 元素，两边都是合并访问
            As[ty][tx] = A[row * n + t * 16 + tx];
            Bs[ty][tx] = B[(t * 16 + ty) * n + col];
            __syncthreads();

            for (int k = 0; k < 16; ++k) {
              acc = fmaf(As[ty][k], Bs[k][tx], acc);
            }
            // 大家都读完了才能覆盖 —— 少了这一句就是竞态
            __syncthreads();
          }

          C[row * n + col] = acc;
        }
      `,
    },
  },
  specs: [
    spec('gemm.spec.ts', code`
      const lab = require('@gpu/lab');
      const N = ${N7};

      describe('分块 GEMM', () => {
      ${GEMM_CORRECTNESS}
        it('DRAM 读量砍掉了', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().memory.readBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
        });

        it('确实经过了共享内存，而且没有 bank 冲突', async () => {
          await lab.buildAndRun();
          const metrics = lab.metrics();
          expect(metrics.shared.loadRequests).toBeGreaterThan(0);
          expect(metrics.shared.bankConflicts).toBe(0);
          expect(metrics.launch.barriers).toBeGreaterThan(0);
        });

        it('没有竞态', async () => {
          const report = await lab.racecheck();
          expect(report.races.length).toBe(0);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.memory.readBytes', op: 'lte', value: 2 * 1024 * 1024,
      zh: 'DRAM 读字节数（朴素版是 8MB）', en: 'DRAM bytes read (8MB naive)',
      unit: 'byte', dimension: 'latency',
    }),
    gate({
      metric: 'gpu.shared.bankConflicts', op: 'eq', value: 0,
      zh: '共享内存 bank 冲突', en: 'shared bank conflicts',
      dimension: 'latency',
    }),
    gate({
      metric: 'gpu.launch.barriers', op: 'gte', value: 1,
      zh: '屏障次数（确认真的用了共享内存分块）', en: 'barriers (confirms real tiling)',
      dimension: 'correctness',
    }),
  ],
  focus: ['latency'],
};

/* ------------------------------------------------------------------ */
/* 第 9 关：寄存器分块                                                   */
/* ------------------------------------------------------------------ */

const STAGE_9 = {
  id: 'register-tiling',
  title: t('寄存器分块 —— 每个线程算 4×4，算术强度再涨三倍',
    'Register tiling — 4×4 per thread, 3× the arithmetic intensity'),
  goal: t(
    [
      '分块之后算术强度是 3.8，DRAM 不再是瓶颈了 —— 但共享内存成了新瓶颈：',
      '每做一次乘加就要从共享内存读两个数。',
      '',
      '**寄存器分块**把这个比例改过来：让每个线程算 **4×4 = 16 个输出**。',
      '从共享内存读 4 个 A 的值和 4 个 B 的值（8 次读），就能做 16 次乘加 ——',
      '读写比从 2:1 变成 1:2，好了四倍。而那 16 个累加器全部待在寄存器里。',
      '',
      'block 还是 16×16 个线程，但现在它负责 **64×64** 的输出块。',
      '',
      '```bash',
      'nvcc -o bench sgemm.cu && ncu ./bench',
      '```',
      '',
      '**注意第 6 关的规则**：那 16 个累加器只有在下标全是编译期常量时才待得住寄存器。',
      '写成 `float acc[4][4]` 再用循环变量去索引，整个数组就落到 local memory 了。',
      '',
      '**通关标准**',
      '',
      '- 结果不变',
      '- 算术强度 ≥ 8（分块版是 3.8）',
      '- `local.bytes = 0`',
      '- bank 冲突为 0',
    ].join('\n'),
    [
      'After tiling, arithmetic intensity is 3.8 and DRAM is no longer the bottleneck. Shared memory is:',
      'every multiply-add still reads two values out of it.',
      '',
      '**Register tiling** changes that ratio: let each thread compute **4×4 = 16 outputs**.',
      'Reading 4 values of A and 4 of B (8 reads) then feeds 16 multiply-adds, turning a 2:1 read/compute',
      'ratio into 1:2, four times better. All 16 accumulators live in registers.',
      '',
      'The block is still 16×16 threads but now owns a **64×64** output tile.',
      '',
      '```bash',
      'nvcc -o bench sgemm.cu && ncu ./bench',
      '```',
      '',
      '**Remember stage 6**: those 16 accumulators stay in registers only while every subscript is a',
      'compile-time constant. Writing `float acc[4][4]` and indexing it with a loop variable sends the',
      'whole array to local memory.',
      '',
      '**To pass**',
      '',
      '- unchanged results',
      '- arithmetic intensity at least 8 (3.8 when tiled)',
      '- `local.bytes = 0`',
      '- zero bank conflicts',
    ].join('\n')
  ),
  checklist: [
    t('每个线程用 16 个标量累加器，不要用带动态下标的数组',
      'Use 16 scalar accumulators, not an array with dynamic subscripts'),
    t('内层循环读 4 个 A 值与 4 个 B 值，做 16 次乘加',
      'The inner loop reads 4 A values and 4 B values, then does 16 multiply-adds'),
    t('给两块共享内存各挑一个不会撞 bank 的行宽',
      'Pick a row width for each shared tile that avoids bank collisions'),
  ],
  hints: [
    t('把 4 个输出按 16 跨步分布（`ty`、`ty+16`、`ty+32`、`ty+48`），而不是连续的 4 行 —— '
      + '这样每个 warp 读共享内存时落在连续的 bank 上。',
      'Spread the four outputs with a stride of 16 (`ty`, `ty+16`, `ty+32`, `ty+48`) rather than four '
      + 'consecutive rows, so each warp reads consecutive banks.'),
    t('一个 warp 跨了两个 ty（blockDim 是 16×16），所以两块共享内存的行宽要**分别**错开：'
      + '被 ty 索引的那块行宽取 %32 == 2，被 tx 索引的那块取 %32 == 16。',
      'A warp spans two ty values (blockDim is 16×16), so the two tiles need *different* paddings: the '
      + 'tile indexed by ty wants a row width ≡ 2 (mod 32), the one indexed by tx wants ≡ 16.'),
  ],
  pitfalls: [
    t('**用 `float acc[4][4]` 加循环初始化。** `acc[i][j] = 0.0f` 里的 `i` 是循环变量，'
      + '整个数组会落到 local memory，`local.bytes` 门槛立刻挂 —— 这就是第 6 关那个坑。',
      '**Using `float acc[4][4]` with a loop to initialise it.** The `i` in `acc[i][j] = 0.0f` is a loop '
      + 'variable, so the array lands in local memory and the `local.bytes` gate fails. Exactly the stage-6 trap.'),
    t('**两块共享内存用同一个 padding。** 一个被 ty 索引、一个被 tx 索引，'
      + '同一个 padding 只能救一块，另一块照样撞。',
      '**Padding both shared tiles the same way.** One is indexed by ty and the other by tx; a single '
      + 'padding fixes only one of them.'),
  ],
  extension: t(
    '到这里算术强度是 12.8，比朴素版高 25 倍，DRAM 读量从 8MB 降到 256KB。'
    + '再往上就要用 tensor core 了 —— 那是第 11 关。'
    + '真正的高性能 GEMM（CUTLASS、cuBLAS）在这一层之上还有两件事：'
    + '用 `float4` 做向量化访存把每条指令搬 16 字节，以及用 swizzle 代替 padding'
    + '（padding 在 tile 尺寸受 MMA 形状约束时用不了）。',
    'Arithmetic intensity is now 12.8, twenty-five times the naive version, and DRAM reads fell from 8MB '
    + 'to 256KB. Going further means tensor cores, which is stage 11. Production GEMMs (CUTLASS, cuBLAS) '
    + 'add two more things on top of this layer: vectorised `float4` accesses moving 16 bytes per '
    + 'instruction, and swizzling instead of padding, since padding is unavailable once MMA shapes '
    + 'constrain the tile size.'
  ),
  gpu: {
    files: {
      '/root/sgemm.cu': code`
        // 第 8 关的分块版：算术强度 3.8，瓶颈从 DRAM 挪到了共享内存。
        //
        // 改成每个线程算 4×4 个输出，block 覆盖 64×64。
        __global__ void sgemm(const float* A, const float* B, float* C, int n) {
          __shared__ float As[16][16];
          __shared__ float Bs[16][16];

          int tx = threadIdx.x;
          int ty = threadIdx.y;
          int row = blockIdx.y * 16 + ty;
          int col = blockIdx.x * 16 + tx;

          float acc = 0.0f;
          for (int t = 0; t < n / 16; ++t) {
            As[ty][tx] = A[row * n + t * 16 + tx];
            Bs[ty][tx] = B[(t * 16 + ty) * n + col];
            __syncthreads();
            for (int k = 0; k < 16; ++k) acc = fmaf(As[ty][k], Bs[k][tx], acc);
            __syncthreads();
          }
          C[row * n + col] = acc;
        }
      `,
    },
    bench: gemmBench({
      kernel: 'sgemm', grid: [N7 / 64, N7 / 64], block: [16, 16],
      args: ['A', 'B', 'C', N7],
    }),
    referenceFiles: {
      '/root/sgemm.cu': code`
        __global__ void sgemm(const float* A, const float* B, float* C, int n) {
          // 一个 warp 跨两个 ty，所以两块的行宽要分别错开：
          //   As 被 ty 索引 -> 66 % 32 == 2
          //   Bs 被 tx 索引 -> 80 % 32 == 16
          __shared__ float As[16][66];
          __shared__ float Bs[16][80];

          int tx = threadIdx.x;
          int ty = threadIdx.y;

          // 16 个标量累加器，全部待在寄存器里
          float a00 = 0.0f, a01 = 0.0f, a02 = 0.0f, a03 = 0.0f;
          float a10 = 0.0f, a11 = 0.0f, a12 = 0.0f, a13 = 0.0f;
          float a20 = 0.0f, a21 = 0.0f, a22 = 0.0f, a23 = 0.0f;
          float a30 = 0.0f, a31 = 0.0f, a32 = 0.0f, a33 = 0.0f;

          for (int t = 0; t < n / 16; ++t) {
            As[tx][ty +  0] = A[(blockIdx.y * 64 + ty +  0) * n + t * 16 + tx];
            As[tx][ty + 16] = A[(blockIdx.y * 64 + ty + 16) * n + t * 16 + tx];
            As[tx][ty + 32] = A[(blockIdx.y * 64 + ty + 32) * n + t * 16 + tx];
            As[tx][ty + 48] = A[(blockIdx.y * 64 + ty + 48) * n + t * 16 + tx];
            Bs[ty][tx +  0] = B[(t * 16 + ty) * n + blockIdx.x * 64 + tx +  0];
            Bs[ty][tx + 16] = B[(t * 16 + ty) * n + blockIdx.x * 64 + tx + 16];
            Bs[ty][tx + 32] = B[(t * 16 + ty) * n + blockIdx.x * 64 + tx + 32];
            Bs[ty][tx + 48] = B[(t * 16 + ty) * n + blockIdx.x * 64 + tx + 48];
            __syncthreads();

            for (int k = 0; k < 16; ++k) {
              float x0 = As[k][ty + 0], x1 = As[k][ty + 16];
              float x2 = As[k][ty + 32], x3 = As[k][ty + 48];
              float y0 = Bs[k][tx + 0], y1 = Bs[k][tx + 16];
              float y2 = Bs[k][tx + 32], y3 = Bs[k][tx + 48];
              // 8 次共享内存读换 16 次乘加
              a00 = fmaf(x0, y0, a00); a01 = fmaf(x0, y1, a01);
              a02 = fmaf(x0, y2, a02); a03 = fmaf(x0, y3, a03);
              a10 = fmaf(x1, y0, a10); a11 = fmaf(x1, y1, a11);
              a12 = fmaf(x1, y2, a12); a13 = fmaf(x1, y3, a13);
              a20 = fmaf(x2, y0, a20); a21 = fmaf(x2, y1, a21);
              a22 = fmaf(x2, y2, a22); a23 = fmaf(x2, y3, a23);
              a30 = fmaf(x3, y0, a30); a31 = fmaf(x3, y1, a31);
              a32 = fmaf(x3, y2, a32); a33 = fmaf(x3, y3, a33);
            }
            __syncthreads();
          }

          int cb = blockIdx.x * 64 + tx;
          int r0 = (blockIdx.y * 64 + ty +  0) * n;
          C[r0 + cb] = a00; C[r0 + cb + 16] = a01; C[r0 + cb + 32] = a02; C[r0 + cb + 48] = a03;
          int r1 = (blockIdx.y * 64 + ty + 16) * n;
          C[r1 + cb] = a10; C[r1 + cb + 16] = a11; C[r1 + cb + 32] = a12; C[r1 + cb + 48] = a13;
          int r2 = (blockIdx.y * 64 + ty + 32) * n;
          C[r2 + cb] = a20; C[r2 + cb + 16] = a21; C[r2 + cb + 32] = a22; C[r2 + cb + 48] = a23;
          int r3 = (blockIdx.y * 64 + ty + 48) * n;
          C[r3 + cb] = a30; C[r3 + cb + 16] = a31; C[r3 + cb + 32] = a32; C[r3 + cb + 48] = a33;
        }
      `,
    },
  },
  specs: [
    spec('gemm.spec.ts', code`
      const lab = require('@gpu/lab');
      const N = ${N7};

      describe('寄存器分块 GEMM', () => {
      ${GEMM_CORRECTNESS}
        it('算术强度上去了', async () => {
          await lab.buildAndRun();
          expect(lab.roofline().arithmeticIntensity).toBeGreaterThanOrEqual(8);
        });

        it('累加器待在寄存器里，一个字节 local memory 都不用', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().local.bytes).toBe(0);
        });

        it('共享内存没有 bank 冲突', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().shared.bankConflicts).toBe(0);
        });

        it('每个线程真的算了 16 个输出 —— 线程总数只有上一关的十六分之一', async () => {
          await lab.buildAndRun();
          const metrics = lab.metrics();
          // 64×64 的输出块 / 256 个线程 = 每线程 16 个
          expect(metrics.launch.warps).toBeLessThanOrEqual((N / 64) * (N / 64) * 8);
          expect(metrics.inst.fma).toBeGreaterThanOrEqual(N * N * N);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.arithmeticIntensity', op: 'gte', value: 8,
      zh: '算术强度（朴素 0.5，分块 3.8）', en: 'arithmetic intensity (0.5 naive, 3.8 tiled)',
      unit: 'flop/byte', dimension: 'latency',
    }),
    gate({
      metric: 'gpu.local.bytes', op: 'eq', value: 0,
      zh: 'local memory 流量', en: 'local memory traffic',
      unit: 'byte', dimension: 'latency',
    }),
    gate({
      metric: 'gpu.shared.bankConflicts', op: 'eq', value: 0,
      zh: '共享内存 bank 冲突', en: 'shared bank conflicts',
      dimension: 'latency',
    }),
  ],
  focus: ['latency'],
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
  stages: [STAGE_1, STAGE_2, STAGE_3, STAGE_4, STAGE_5, STAGE_6, STAGE_7, STAGE_8, STAGE_9],
};
