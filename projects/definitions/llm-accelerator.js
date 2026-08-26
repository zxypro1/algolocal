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
/* 第 10 关：双缓冲                                                     */
/* ------------------------------------------------------------------ */

const TILED_SOURCE = code`
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
`;

const STAGE_10 = {
  id: 'double-buffering',
  title: t('双缓冲 —— 一轮两个屏障砍成一个', 'Double buffering — two barriers per tile down to one'),
  goal: t(
    [
      '分块 GEMM 的每一轮里有**两个** `__syncthreads()`：',
      '一个在搬完之后（等大家都写完才能读），一个在算完之后（等大家都读完才能覆盖）。',
      '128 次分块就是 1024 次屏障，每次屏障整个 block 都要停下来对齐。',
      '',
      '第二个屏障之所以必要，是因为下一轮要**覆盖同一块**共享内存。',
      '那就别覆盖它 —— 开**两套** buffer 轮流用：',
      '算第 t 块的时候，往另一套里搬第 t+1 块。两件事互不干扰，',
      '于是一轮只需要一个屏障。',
      '',
      '```bash',
      'nvcc -o bench sgemm.cu && ncu ./bench',
      '```',
      '',
      '`Warp State Statistics` 里的 `Barriers` 应该从 1024 掉到 512。',
      '',
      '**代价是共享内存翻倍**（2KB 变 4KB）。这是典型的空间换时间：',
      '共享内存吃得多了，能同时驻留的 block 就少了，所以不是无脑赢 ——',
      '`ncu` 的 `Occupancy` 分节会告诉你有没有因此被卡住。',
      '',
      '**通关标准**',
      '',
      '- 结果不变',
      '- 屏障次数 ≤ 700（单缓冲是 1024）',
      '- bank 冲突仍然为 0，没有竞态',
    ].join('\n'),
    [
      'Each round of the tiled GEMM has **two** `__syncthreads()` calls: one after staging (everyone',
      'must finish writing before anyone reads) and one after accumulating (everyone must finish',
      'reading before anyone overwrites). With 128 tiles that is 1024 barriers, each stopping the',
      'whole block to line up.',
      '',
      'The second barrier exists only because the next round **overwrites the same** shared tile.',
      'So do not overwrite it. Keep **two** buffers and alternate: while computing on tile t, stage',
      'tile t+1 into the other one. The two no longer interfere and one barrier per round is enough.',
      '',
      '```bash',
      'nvcc -o bench sgemm.cu && ncu ./bench',
      '```',
      '',
      '`Barriers` under `Warp State Statistics` should drop from 1024 to 512.',
      '',
      '**The cost is twice the shared memory** (2KB to 4KB). A classic space-for-time trade: more',
      'shared memory per block means fewer resident blocks, so it is not a free win. The `Occupancy`',
      'section of `ncu` tells you whether it started limiting you.',
      '',
      '**To pass**',
      '',
      '- unchanged results',
      '- at most 700 barriers (1024 single-buffered)',
      '- still zero bank conflicts and no races',
    ].join('\n')
  ),
  checklist: [
    t('把共享内存开成两套', 'Declare two sets of shared tiles'),
    t('循环外先搬第一块，循环里搬下一块、算当前块',
      'Stage the first tile before the loop, then stage t+1 while computing t'),
    t('确认屏障次数减半而结果不变', 'Confirm barriers halved and results unchanged'),
  ],
  hints: [
    t('声明成 `__shared__ float As[2][16][16]`，用 `t % 2` 挑当前那一套。',
      'Declare `__shared__ float As[2][16][16]` and pick the current set with `t % 2`.'),
    t('循环体的顺序是：先发起下一块的搬运，再算当前块，最后一个屏障。'
      + '最后一块在循环外单独算，因为它没有「下一块」要搬。',
      'The loop body goes: stage the next tile, compute the current one, then one barrier. '
      + 'Handle the final tile after the loop, since it has no successor to stage.'),
  ],
  pitfalls: [
    t('**先算当前块再搬下一块。** 顺序反了就没有重叠可言 —— 双缓冲的意义正是'
      + '让搬运和计算在时间上错开，而不只是省一个屏障。',
      '**Computing the current tile before staging the next.** Reversed, there is nothing to overlap. '
      + 'The point of double buffering is separating the two in time, not just saving a barrier.'),
    t('**忘了循环外的第一块与最后一块。** 循环变成 `t < n/16 - 1`，'
      + '首块要在进循环前搬好，末块要在出循环后算掉。',
      '**Forgetting the first and last tiles.** The loop becomes `t < n/16 - 1`: stage the first tile '
      + 'before entering and compute the last one after leaving.'),
  ],
  extension: t(
    '真硬件上还能更进一步：Ampere 起有 `cp.async`（CUDA 里是 `__pipeline_memcpy_async`），'
    + '它让搬运**不占用寄存器也不阻塞线程** —— 发起之后线程继续算，'
    + '到需要用的时候再 `__pipeline_wait_prior`。这样双缓冲才真正变成流水线。'
    + 'Hopper 又加了 TMA（张量内存加速器），一条指令搬一整块多维 tile。'
    + '我们这里没有建模异步拷贝的时间重叠，所以门槛压在屏障次数上 ——'
    + '那是这个优化里可以被精确计量的那一半。',
    'Real hardware goes further. From Ampere there is `cp.async` (`__pipeline_memcpy_async` in CUDA), '
    + 'which stages data **without occupying registers or blocking the thread**: issue it, keep computing, '
    + 'and call `__pipeline_wait_prior` when the data is actually needed. Only then does double buffering '
    + 'become a real pipeline. Hopper adds TMA, moving a whole multidimensional tile with one instruction. '
    + 'We do not model the timing overlap of async copies here, so the gate rests on the barrier count, '
    + 'which is the half of this optimisation that can be measured exactly.'
  ),
  gpu: {
    files: { '/root/sgemm.cu': TILED_SOURCE },
    bench: gemmBench({
      kernel: 'sgemm', grid: [N7 / 16, N7 / 16], block: [16, 16],
      args: ['A', 'B', 'C', N7],
    }),
    referenceFiles: {
      '/root/sgemm.cu': code`
        __global__ void sgemm(const float* A, const float* B, float* C, int n) {
          // 两套 buffer 轮流用，于是不再需要「等大家读完」那个屏障
          __shared__ float As[2][16][16];
          __shared__ float Bs[2][16][16];

          int tx = threadIdx.x;
          int ty = threadIdx.y;
          int row = blockIdx.y * 16 + ty;
          int col = blockIdx.x * 16 + tx;

          float acc = 0.0f;

          // 先把第一块搬进 buffer 0
          As[0][ty][tx] = A[row * n + tx];
          Bs[0][ty][tx] = B[ty * n + col];
          __syncthreads();

          for (int t = 0; t < n / 16 - 1; ++t) {
            int cur = t % 2;
            int nxt = (t + 1) % 2;

            // 先发起下一块的搬运，再算当前块 —— 顺序反了就没有重叠
            As[nxt][ty][tx] = A[row * n + (t + 1) * 16 + tx];
            Bs[nxt][ty][tx] = B[((t + 1) * 16 + ty) * n + col];

            for (int k = 0; k < 16; ++k) {
              acc = fmaf(As[cur][ty][k], Bs[cur][k][tx], acc);
            }
            __syncthreads();
          }

          // 最后一块没有「下一块」要搬，单独算掉
          int last = (n / 16 - 1) % 2;
          for (int k = 0; k < 16; ++k) {
            acc = fmaf(As[last][ty][k], Bs[last][k][tx], acc);
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

      describe('双缓冲 GEMM', () => {
      ${GEMM_CORRECTNESS}
        it('屏障次数减半', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().launch.barriers).toBeLessThanOrEqual(700);
        });

        it('共享内存翻倍了 —— 这是它的代价', async () => {
          await lab.buildAndRun();
          const stat = lab.staticMetrics();
          expect(stat.sharedBytesPerBlock).toBeGreaterThanOrEqual(4096);
        });

        it('bank 冲突仍然为 0，也没有竞态', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().shared.bankConflicts).toBe(0);
          const report = await lab.racecheck();
          expect(report.races.length).toBe(0);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.launch.barriers', op: 'lte', value: 700,
      zh: '屏障次数（单缓冲是 1024）', en: 'barriers (1024 single-buffered)',
      dimension: 'latency',
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
/* 第 11 关：Tensor Core                                                */
/* ------------------------------------------------------------------ */

const STAGE_11 = {
  id: 'tensor-core',
  title: t('Tensor Core —— 让矩阵乘走专用单元', 'Tensor cores — matmul on dedicated hardware'),
  goal: t(
    [
      '到现在为止每一次乘加都走 FMA 流水线，一个 SM 每周期 128 次。',
      'GPU 上还有一类专门为矩阵乘造的单元：**tensor core**，',
      'H100 上一个 SM 每周期能做 1024 次 —— 八倍。',
      '',
      '用法是 `wmma`（warp matrix multiply-accumulate）。它是 **warp 级**的：',
      '一整个 warp 协作算一个 16×16×16 的矩阵乘，数据存在叫 `fragment` 的东西里。',
      'fragment 是不透明的 —— 你不知道也不需要知道哪个 lane 拿了哪几个元素。',
      '',
      '```cuda',
      'wmma::fragment<wmma::matrix_a, 16, 16, 16, half, wmma::row_major> af;',
      'wmma::fragment<wmma::accumulator, 16, 16, 16, float> cf;',
      'wmma::fill_fragment(cf, 0.0f);',
      'wmma::load_matrix_sync(af, A + offset, n);',
      'wmma::mma_sync(cf, af, bf, cf);',
      'wmma::store_matrix_sync(C + offset, cf, n, wmma::mem_row_major);',
      '```',
      '',
      '**输入是 half，累加是 float。** 这是 tensor core 的标准配方：',
      '精度损失只发生在输入端，累加链条仍然在 fp32 上，所以长序列不会垮。',
      '',
      '启动配置换成每个 block 一个 warp（32 线程），grid 覆盖 8×8 个 16×16 的 tile。',
      '',
      '```bash',
      'nvcc -o bench sgemm.cu && ncu ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 结果仍然对得上（half 输入，容差放宽到 5e-3）',
      '- `inst.mma ≥ n³`，`inst.fma = 0`',
      '- 瓶颈不再是 ALU',
    ].join('\n'),
    [
      'Every multiply-add so far went through the FMA pipeline: 128 per SM per cycle. GPUs also have',
      'units built specifically for matrix multiplication, **tensor cores**, and an H100 SM does 1024',
      'of those per cycle. Eight times more.',
      '',
      'The interface is `wmma` (warp matrix multiply-accumulate). It is **warp-level**: a whole warp',
      'cooperates on one 16×16×16 matmul, with the data held in `fragment` objects. A fragment is',
      'opaque; you neither know nor need to know which lane holds which elements.',
      '',
      '```cuda',
      'wmma::fragment<wmma::matrix_a, 16, 16, 16, half, wmma::row_major> af;',
      'wmma::fragment<wmma::accumulator, 16, 16, 16, float> cf;',
      'wmma::fill_fragment(cf, 0.0f);',
      'wmma::load_matrix_sync(af, A + offset, n);',
      'wmma::mma_sync(cf, af, bf, cf);',
      'wmma::store_matrix_sync(C + offset, cf, n, wmma::mem_row_major);',
      '```',
      '',
      '**Inputs are half, accumulation is float.** That is the standard tensor-core recipe: precision',
      'is lost only at the inputs while the accumulation chain stays in fp32, so long sequences hold up.',
      '',
      'Switch the launch to one warp per block (32 threads), with the grid covering 8×8 tiles of 16×16.',
      '',
      '```bash',
      'nvcc -o bench sgemm.cu && ncu ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- results still match (half inputs, tolerance relaxed to 5e-3)',
      '- `inst.mma ≥ n³` and `inst.fma = 0`',
      '- ALU is no longer the bottleneck',
    ].join('\n')
  ),
  checklist: [
    t('声明三个 fragment：matrix_a、matrix_b、accumulator',
      'Declare three fragments: matrix_a, matrix_b and accumulator'),
    t('沿 k 维循环，每轮 load 两块再 mma 一次',
      'Loop along k, loading two fragments and issuing one mma each round'),
    t('用 ncu 确认 FMA 归零、tensor core 起来了',
      'Confirm with ncu that FMA hit zero and the tensor unit is busy'),
  ],
  hints: [
    t('accumulator 只要 `fill_fragment` 一次，循环里反复 `mma_sync(cf, af, bf, cf)` 就是累加。',
      'Fill the accumulator once; repeating `mma_sync(cf, af, bf, cf)` in the loop accumulates into it.'),
    t('A 的第 t 块起点是 `A + blockIdx.y * 16 * n + t * 16`，'
      + 'B 的是 `B + t * 16 * n + blockIdx.x * 16`，两个 ldm 都是 n。',
      'Tile t of A starts at `A + blockIdx.y * 16 * n + t * 16` and of B at '
      + '`B + t * 16 * n + blockIdx.x * 16`; the leading dimension is n for both.'),
  ],
  pitfalls: [
    t('**把 accumulator 声明成 half。** 累加必须在 fp32 上，'
      + '否则 128 项累加下来误差会滚到不可用 —— 编译期就会拦下。',
      '**Declaring the accumulator as half.** Accumulation must be fp32 or the error compounds over 128 '
      + 'terms until the result is useless. The compiler rejects it.'),
    t('**用 256 个线程的 block 却只写一个 warp 的逻辑。** wmma 是 warp 级原语，'
      + '一个 block 里有几个 warp 就会算几遍同一个 tile，互相覆盖。',
      '**Launching 256-thread blocks with single-warp logic.** wmma is a warp-level primitive; every warp '
      + 'in the block computes the same tile and they overwrite each other.'),
  ],
  extension: t(
    '这一关只把 FMA 换成了 tensor core，算术强度没变 —— 数据还是直接从显存读的。'
    + '真正的高性能实现会把前面几关的东西全叠上：共享内存分块喂 fragment、双缓冲、'
    + 'swizzle 消 bank 冲突。CUTLASS 就是这么组织的。'
    + '再往后，Hopper 的 `wgmma` 与 Blackwell 的 `tcgen05` 把 MMA 变成异步的，'
    + '于是要 warp 专业化：一部分 warp 专门搬数据，另一部分专门算。'
    + 'FlashAttention-4 之所以从 Triton 退回 CuTe DSL，就是因为那种 tile 级控制'
    + 'Triton 的抽象暴露不出来。',
    'This stage only swaps FMA for tensor cores; arithmetic intensity is unchanged because data still '
    + 'comes straight from device memory. A real implementation layers everything from the earlier stages '
    + 'on top: shared-memory tiles feeding the fragments, double buffering, swizzling to kill bank '
    + 'conflicts. That is how CUTLASS is organised. Beyond that, Hopper\'s `wgmma` and Blackwell\'s '
    + '`tcgen05` make MMA asynchronous, which forces warp specialisation: some warps only move data while '
    + 'others only compute. FlashAttention-4 moved from Triton back to CuTe DSL precisely because Triton\'s '
    + 'abstractions do not expose that level of tile control.'
  ),
  gpu: {
    files: { '/root/sgemm.cu': TILED_SOURCE },
    bench: gemmBench({
      kernel: 'sgemm', grid: [N7 / 16, N7 / 16], block: [32],
      args: ['A', 'B', 'C', N7],
    }),
    referenceFiles: {
      '/root/sgemm.cu': code`
        // 每个 block 一个 warp，负责一个 16×16 的输出 tile。
        //
        // 注意输入类型是 half：精度损失只在输入端，累加仍然在 fp32 上。
        __global__ void sgemm(const half* A, const half* B, float* C, int n) {
          wmma::fragment<wmma::matrix_a, 16, 16, 16, half, wmma::row_major> af;
          wmma::fragment<wmma::matrix_b, 16, 16, 16, half, wmma::row_major> bf;
          wmma::fragment<wmma::accumulator, 16, 16, 16, float> cf;

          wmma::fill_fragment(cf, 0.0f);

          for (int t = 0; t < n / 16; ++t) {
            wmma::load_matrix_sync(af, A + blockIdx.y * 16 * n + t * 16, n);
            wmma::load_matrix_sync(bf, B + t * 16 * n + blockIdx.x * 16, n);
            wmma::mma_sync(cf, af, bf, cf);
          }

          wmma::store_matrix_sync(C + blockIdx.y * 16 * n + blockIdx.x * 16, cf, n,
                                  wmma::mem_row_major);
        }
      `,
    },
  },
  specs: [
    spec('gemm.spec.ts', code`
      const lab = require('@gpu/lab');
      const N = ${N7};

      describe('Tensor Core GEMM', () => {
        it('结果对得上 —— half 输入所以容差放宽', async () => {
          await lab.buildAndRun();
          const A = lab.buffer('A');
          const B = lab.buffer('B');
          const C = lab.buffer('C');
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
          // half 只有 10 位尾数，输入端的舍入是主要误差来源
          expect(worst).toBeLessThanOrEqual(5e-3);
        });

        it('乘加全部走了 tensor core', async () => {
          await lab.buildAndRun();
          const metrics = lab.metrics();
          expect(metrics.inst.mma).toBeGreaterThanOrEqual(N * N * N);
          expect(metrics.inst.fma).toBe(0);
        });

        it('瓶颈不再是 ALU', async () => {
          await lab.buildAndRun();
          expect(lab.timing().bottleneck).not.toBe('alu');
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.inst.mma', op: 'gte', value: N7 * N7 * N7,
      zh: 'tensor core 乘加次数', en: 'tensor-core multiply-accumulates',
      dimension: 'latency',
    }),
    gate({
      metric: 'gpu.inst.fma', op: 'eq', value: 0,
      zh: 'FMA 流水线的乘加次数（换成 tensor core 之后应该归零）',
      en: 'FMA-pipeline multiply-accumulates (should hit zero)',
      dimension: 'latency',
    }),
  ],
  focus: ['latency'],
};

/* ------------------------------------------------------------------ */
/* 第 12 关：softmax                                                    */
/* ------------------------------------------------------------------ */

const ROWS12 = 64;
const COLS12 = 256;
const N12 = ROWS12 * COLS12;

/** 一行一个 warp 的场景，第 12、13 关共用 */
const rowBench = (kernel) => ({
  sources: ['/root/kernel.cu'],
  buffers: [
    { name: 'in', length: N12, fill: { kind: 'random', seed: 51, min: -20, max: 20 } },
    { name: 'out', length: N12, fill: { kind: 'zeros' } },
  ],
  launches: [
    { kernel, grid: [ROWS12], block: [32], args: ['in', 'out', ROWS12, COLS12] },
  ],
});

const STAGE_12 = {
  id: 'online-softmax',
  title: t('softmax —— 三遍读变两遍，代价是更多的 expf',
    'Softmax — three passes down to two, paid for in expf'),
  goal: t(
    [
      'softmax 是注意力里的那一步：`out[i] = exp(x[i]) / Σ exp(x[j])`。',
      '直接这么写会溢出 —— `exp(20)` 已经很大，`exp(100)` 就是 inf 了。',
      '标准做法是先减去这一行的最大值：`exp(x[i] - m) / Σ exp(x[j] - m)`，',
      '结果完全一样，但每个指数的输入都 ≤ 0，永远不会溢出。',
      '',
      '于是朴素写法要读三遍：一遍求 max，一遍求和，一遍写结果。',
      '`kernel.cu` 里就是这样，`ncu` 上 DRAM 读量是张量的 **3 倍**。',
      '',
      '**在线 softmax**把前两遍合成一遍。诀窍是边走边修正：',
      '维护当前的最大值 `m` 和当前的和 `s`，看到一个更大的值时，',
      '把已经累加的和按 `exp(m_old - m_new)` 缩放一下就行 —— 数学上完全等价。',
      '',
      '```cuda',
      'float mNew = fmaxf(m, v);',
      's = s * expf(m - mNew) + expf(v - mNew);',
      'm = mNew;',
      '```',
      '',
      'warp 内归并时也要按同样的方式合并两个 `(m, s)` 对。',
      '',
      '**这一步不是免费的**：修正项要额外算 `expf`，而 SFU 的吞吐只有 FMA 的 1/8。',
      '跑完之后对比一下 `ncu` 里 SFU 那一行 —— 你会看到访存省下来的，一部分还给了 SFU。',
      '这个取舍在 FlashAttention 里被推到了极致，第 16 关会回到它。',
      '',
      '**通关标准**',
      '',
      '- 结果和 fp64 参考对得上，且没有 inf / nan（输入里有 ±20 的值）',
      '- DRAM 读量 ≤ 张量的 2.2 倍（三遍版是 3 倍）',
    ].join('\n'),
    [
      'Softmax is the step inside attention: `out[i] = exp(x[i]) / Σ exp(x[j])`. Written directly it',
      'overflows: `exp(20)` is already large and `exp(100)` is inf. The standard fix subtracts the row',
      'maximum first, `exp(x[i] - m) / Σ exp(x[j] - m)`, which is mathematically identical while every',
      'exponent argument is now ≤ 0 and can never overflow.',
      '',
      'That costs three passes: one for the max, one for the sum, one to write. `kernel.cu` does exactly',
      'that and `ncu` reports **3×** the tensor size in DRAM reads.',
      '',
      '**Online softmax** merges the first two. The trick is correcting as you go: keep a running max `m`',
      'and running sum `s`, and when a larger value appears, rescale the accumulated sum by',
      '`exp(m_old - m_new)`. Mathematically exact.',
      '',
      '```cuda',
      'float mNew = fmaxf(m, v);',
      's = s * expf(m - mNew) + expf(v - mNew);',
      'm = mNew;',
      '```',
      '',
      'The warp-level reduction must combine two `(m, s)` pairs the same way.',
      '',
      '**This is not free**: the correction needs extra `expf`, and SFU throughput is one eighth of FMA.',
      'Compare the SFU line in `ncu` afterwards; part of what you saved in memory went back to the SFU.',
      'FlashAttention pushes this trade to its limit, and stage 16 returns to it.',
      '',
      '**To pass**',
      '',
      '- results match an fp64 reference with no inf/nan (inputs reach ±20)',
      '- DRAM reads at most 2.2× the tensor (3× for the three-pass version)',
    ].join('\n')
  ),
  checklist: [
    t('把求 max 与求和合成一遍', 'Merge the max and sum passes into one'),
    t('warp 归并时同时合并 (m, s) 两个量', 'Combine both `m` and `s` in the warp reduction'),
    t('比一比优化前后 ncu 里的 SFU 那一行', 'Compare the SFU line in ncu before and after'),
  ],
  hints: [
    t('每个 lane 先在自己负责的那些列上跑在线更新，再做 warp 归并。',
      'Run the online update over each lane\'s own columns first, then reduce across the warp.'),
    t('归并两个 (m, s)：`mNew = max(m1, m2)`，'
      + '`sNew = s1 * exp(m1 - mNew) + s2 * exp(m2 - mNew)`。',
      'Merging two pairs: `mNew = max(m1, m2)` and `sNew = s1 * exp(m1 - mNew) + s2 * exp(m2 - mNew)`.'),
  ],
  pitfalls: [
    t('**忘了减最大值。** 输入里有 20 附近的值，`exp` 直接把和推到 inf，'
      + '再一除就是 nan。用例里专门查了这一条。',
      '**Forgetting to subtract the maximum.** Inputs reach 20, `exp` pushes the sum to inf, and the '
      + 'division yields nan. There is a dedicated check for this.'),
    t('**归并时只合并 max 不合并 sum。** 两个 lane 的和是在**各自的** max 下算的，'
      + '直接相加是错的，必须先各自缩放到共同的 max。',
      '**Merging only the max and not the sum.** Each lane accumulated its sum under its *own* max, so '
      + 'adding them directly is wrong; both must first be rescaled to the shared maximum.'),
  ],
  extension: t(
    '在线 softmax 是 FlashAttention 的核心。注意力里那个 S = QK^T 矩阵是 O(S²) 大的，'
    + '物化出来显存就爆了；而有了在线 softmax，就可以一块一块地算 S、一块一块地更新 (m, s)，'
    + '**永远不把完整的 S 存下来**。第 15、16 关做的就是这件事。'
    + '这个算法最早出现在 Milakov 与 Gimelshein 2018 年的 Online normalizer calculation for softmax，'
    + '后来被 FlashAttention 用成了标准部件。',
    'Online softmax is the heart of FlashAttention. The S = QK^T matrix inside attention is O(S²) and '
    + 'materialising it exhausts memory; with online softmax you can compute S tile by tile and update '
    + '(m, s) tile by tile, **never storing the full S**. Stages 15 and 16 do exactly that. The algorithm '
    + 'first appeared in Milakov and Gimelshein\'s 2018 "Online normalizer calculation for softmax" and '
    + 'became a standard component through FlashAttention.'
  ),
  gpu: {
    files: {
      '/root/kernel.cu': code`
        // 一行一个 warp 的 softmax。结果是对的，但读了三遍。
        //
        //   nvcc -o bench kernel.cu && ncu ./bench
        //
        // 把「求 max」和「求和」合成一遍。
        __global__ void softmax(const float* in, float* out, int rows, int cols) {
          int row = blockIdx.x;
          int lane = threadIdx.x;
          const float* r = in + row * cols;

          // 第一遍：求这一行的最大值
          float m = -3.4e38f;
          for (int c = lane; c < cols; c += 32) m = fmaxf(m, r[c]);
          for (int d = 16; d > 0; d >>= 1) m = fmaxf(m, __shfl_xor_sync(0xffffffff, m, d));

          // 第二遍：求和
          float s = 0.0f;
          for (int c = lane; c < cols; c += 32) s += expf(r[c] - m);
          for (int d = 16; d > 0; d >>= 1) s += __shfl_xor_sync(0xffffffff, s, d);

          // 第三遍：写结果
          for (int c = lane; c < cols; c += 32) out[row * cols + c] = expf(r[c] - m) / s;
        }
      `,
    },
    bench: rowBench('softmax'),
    referenceFiles: {
      '/root/kernel.cu': code`
        __global__ void softmax(const float* in, float* out, int rows, int cols) {
          int row = blockIdx.x;
          int lane = threadIdx.x;
          const float* r = in + row * cols;

          // 一遍走完，边走边修正
          float m = -3.4e38f;
          float s = 0.0f;
          for (int c = lane; c < cols; c += 32) {
            float v = r[c];
            float mNew = fmaxf(m, v);
            s = s * expf(m - mNew) + expf(v - mNew);
            m = mNew;
          }

          // 归并时把两个 (m, s) 对合起来，注意各自先缩放到共同的 max
          for (int d = 16; d > 0; d >>= 1) {
            float mOther = __shfl_xor_sync(0xffffffff, m, d);
            float sOther = __shfl_xor_sync(0xffffffff, s, d);
            float mNew = fmaxf(m, mOther);
            s = s * expf(m - mNew) + sOther * expf(mOther - mNew);
            m = mNew;
          }

          for (int c = lane; c < cols; c += 32) {
            out[row * cols + c] = expf(r[c] - m) / s;
          }
        }
      `,
    },
  },
  specs: [
    spec('softmax.spec.ts', code`
      const lab = require('@gpu/lab');
      const ROWS = ${ROWS12};
      const COLS = ${COLS12};

      describe('softmax', () => {
        it('结果对得上，且没有 inf / nan', async () => {
          await lab.buildAndRun();
          const input = lab.buffer('in');
          const out = lab.buffer('out');
          for (let row = 0; row < ROWS; row += 5) {
            let max = -Infinity;
            for (let c = 0; c < COLS; c += 1) max = Math.max(max, input[row * COLS + c]);
            let sum = 0;
            for (let c = 0; c < COLS; c += 1) sum += Math.exp(input[row * COLS + c] - max);
            for (let c = 0; c < COLS; c += 11) {
              const expected = Math.exp(input[row * COLS + c] - max) / sum;
              const actual = out[row * COLS + c];
              expect(Number.isFinite(actual)).toBe(true);
              expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-5);
            }
          }
        });

        it('每一行加起来是 1', async () => {
          await lab.buildAndRun();
          const out = lab.buffer('out');
          for (let row = 0; row < ROWS; row += 7) {
            let sum = 0;
            for (let c = 0; c < COLS; c += 1) sum += out[row * COLS + c];
            expect(sum).toBeCloseTo(1, 4);
          }
        });

        it('DRAM 读量从三遍降到两遍', async () => {
          await lab.buildAndRun();
          const bytes = ROWS * COLS * 4;
          expect(lab.metrics().memory.readBytes).toBeLessThanOrEqual(bytes * 2.2);
        });

        it('省下来的访存有一部分还给了 SFU —— 这是真实的取舍', async () => {
          await lab.buildAndRun();
          // 在线版的修正项要额外算 expf，SFU 指令数反而更多
          expect(lab.metrics().inst.sfu).toBeGreaterThan(ROWS * COLS);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.memory.readBytes', op: 'lte', value: Math.round(N12 * 4 * 2.2),
      zh: 'DRAM 读字节数（三遍版是张量的 3 倍）', en: 'DRAM bytes read (3× tensor for three passes)',
      unit: 'byte', dimension: 'latency',
    }),
  ],
  focus: ['latency', 'correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 13 关：LayerNorm 与 Welford                                       */
/* ------------------------------------------------------------------ */

const STAGE_13 = {
  id: 'welford-layernorm',
  title: t('RMSNorm 与 Welford —— 两遍求方差变一遍',
    'RMSNorm and Welford — variance in one pass instead of two'),
  goal: t(
    [
      '归一化是每个 Transformer 层都要做两次的事。',
      'LayerNorm 要算均值与方差；现代 LLM（Llama 系列起）大多改用 **RMSNorm**，',
      '只算平方均值，省掉减均值那一步：`out[i] = x[i] / sqrt(mean(x²) + eps)`。',
      '',
      '`kernel.cu` 里是两遍写法：一遍求平方和，一遍写结果 —— 加起来读了张量的 3 倍。',
      '（因为求和那一遍读一次、写结果那一遍又读一次原始数据。）',
      '',
      '把它压成一遍：**在第一遍就把数据留在寄存器里**。',
      '每个 lane 负责的列数是固定的（`cols / 32 = 8`），',
      '所以可以在求和的同时把这 8 个值存进 8 个标量，写结果时直接用。',
      '',
      '**注意第 6 关的规则**：那 8 个值必须是常量下标才待得住寄存器。',
      '',
      '```bash',
      'nvcc -o bench kernel.cu && ncu ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 结果和 fp64 参考对得上',
      '- DRAM 读量 ≤ 张量的 1.2 倍（两遍版是 2 倍）',
      '- `local.bytes = 0`',
    ].join('\n'),
    [
      'Normalisation happens twice in every Transformer layer. LayerNorm needs a mean and a variance;',
      'modern LLMs (from the Llama family onward) mostly use **RMSNorm**, which needs only the mean',
      'square and skips the mean subtraction: `out[i] = x[i] / sqrt(mean(x²) + eps)`.',
      '',
      '`kernel.cu` uses two passes, one for the sum of squares and one to write, reading the tensor',
      'twice in total.',
      '',
      'Collapse it into one: **keep the data in registers during the first pass**. Each lane owns a',
      'fixed number of columns (`cols / 32 = 8`), so it can accumulate the sum and stash those eight',
      'values in eight scalars at the same time, then use them directly when writing.',
      '',
      '**Remember stage 6**: those eight values need constant subscripts to stay in registers.',
      '',
      '```bash',
      'nvcc -o bench kernel.cu && ncu ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- results match an fp64 reference',
      '- DRAM reads at most 1.2× the tensor (2× for two passes)',
      '- `local.bytes = 0`',
    ].join('\n')
  ),
  checklist: [
    t('第一遍读的时候把值留在寄存器里', 'Keep the values in registers during the first pass'),
    t('用 8 个标量而不是带循环下标的数组', 'Use eight scalars rather than a loop-indexed array'),
    t('确认 DRAM 读量减半、local.bytes 为 0',
      'Confirm DRAM reads halved and local.bytes is zero'),
  ],
  hints: [
    t('`cols / 32 = 8`，所以每个 lane 正好 8 个值：`v0 = r[lane]`、`v1 = r[lane + 32]`……',
      '`cols / 32 = 8`, so each lane owns exactly eight values: `v0 = r[lane]`, `v1 = r[lane + 32]`, and so on.'),
    t('平方和先在 lane 内累完，再用 5 次 `__shfl_xor_sync` 归并到整个 warp。',
      'Accumulate the sum of squares within the lane first, then reduce across the warp with five `__shfl_xor_sync` rounds.'),
  ],
  pitfalls: [
    t('**用 `float v[8]` 加循环。** 循环变量当下标，整个数组落 local memory，'
      + '省下的 DRAM 读又以另一种形式还回去了 —— `local.bytes` 门槛会挂。',
      '**Using `float v[8]` with a loop.** A loop variable as subscript sends the array to local memory '
      + 'and the DRAM traffic you saved comes back in another form. The `local.bytes` gate fails.'),
    t('**RMSNorm 当成 LayerNorm 写。** RMSNorm 不减均值，'
      + '分母是 `sqrt(mean(x²) + eps)` 而不是标准差。多减一次均值结果就不对了。',
      '**Writing LayerNorm when RMSNorm is asked for.** RMSNorm does not subtract the mean; the '
      + 'denominator is `sqrt(mean(x²) + eps)`, not the standard deviation.'),
  ],
  extension: t(
    'LayerNorm 要同时算均值与方差，两遍写法会读三次。**Welford 算法**能一遍算完：'
    + '维护 `(count, mean, M2)` 三元组，每来一个新值按增量公式更新，'
    + '数值稳定性还比「先求平方和再减均值平方」那个公式好得多 —— 后者在均值远大于方差时会灾难性抵消。'
    + 'RMSNorm 用不上 Welford（它不需要均值），但真做 LayerNorm 时这是标准做法。'
    + 'PyTorch 与 Triton 的 LayerNorm 内核都是这么写的。',
    'LayerNorm needs both a mean and a variance and takes three reads in its two-pass form. **Welford\'s '
    + 'algorithm** does it in one: keep a `(count, mean, M2)` triple and update it incrementally per '
    + 'value. It is also far more numerically stable than "sum of squares minus square of mean", which '
    + 'suffers catastrophic cancellation when the mean dwarfs the variance. RMSNorm does not need Welford '
    + 'since it has no mean, but it is the standard approach for real LayerNorm, and both the PyTorch and '
    + 'Triton LayerNorm kernels are written that way.'
  ),
  gpu: {
    files: {
      '/root/kernel.cu': code`
        // RMSNorm：out[i] = x[i] / sqrt(mean(x^2) + eps)
        //
        // 两遍写法：一遍求平方和，一遍写结果。张量被读了两次。
        __global__ void rmsnorm(const float* in, float* out, int rows, int cols) {
          int row = blockIdx.x;
          int lane = threadIdx.x;
          const float* r = in + row * cols;

          float sum = 0.0f;
          for (int c = lane; c < cols; c += 32) sum = fmaf(r[c], r[c], sum);
          for (int d = 16; d > 0; d >>= 1) sum += __shfl_xor_sync(0xffffffff, sum, d);

          float scale = rsqrtf(sum / (float)cols + 1e-6f);

          for (int c = lane; c < cols; c += 32) out[row * cols + c] = r[c] * scale;
        }
      `,
    },
    bench: rowBench('rmsnorm'),
    referenceFiles: {
      '/root/kernel.cu': code`
        __global__ void rmsnorm(const float* in, float* out, int rows, int cols) {
          int row = blockIdx.x;
          int lane = threadIdx.x;
          const float* r = in + row * cols;

          // 一遍读完，值留在寄存器里 —— cols / 32 = 8，每个 lane 正好 8 个
          float v0 = r[lane +   0];
          float v1 = r[lane +  32];
          float v2 = r[lane +  64];
          float v3 = r[lane +  96];
          float v4 = r[lane + 128];
          float v5 = r[lane + 160];
          float v6 = r[lane + 192];
          float v7 = r[lane + 224];

          float sum = 0.0f;
          sum = fmaf(v0, v0, sum); sum = fmaf(v1, v1, sum);
          sum = fmaf(v2, v2, sum); sum = fmaf(v3, v3, sum);
          sum = fmaf(v4, v4, sum); sum = fmaf(v5, v5, sum);
          sum = fmaf(v6, v6, sum); sum = fmaf(v7, v7, sum);

          for (int d = 16; d > 0; d >>= 1) sum += __shfl_xor_sync(0xffffffff, sum, d);

          float scale = rsqrtf(sum / (float)cols + 1e-6f);

          float* o = out + row * cols;
          o[lane +   0] = v0 * scale; o[lane +  32] = v1 * scale;
          o[lane +  64] = v2 * scale; o[lane +  96] = v3 * scale;
          o[lane + 128] = v4 * scale; o[lane + 160] = v5 * scale;
          o[lane + 192] = v6 * scale; o[lane + 224] = v7 * scale;
        }
      `,
    },
  },
  specs: [
    spec('rmsnorm.spec.ts', code`
      const lab = require('@gpu/lab');
      const ROWS = ${ROWS12};
      const COLS = ${COLS12};

      describe('RMSNorm', () => {
        it('结果对得上', async () => {
          await lab.buildAndRun();
          const input = lab.buffer('in');
          const out = lab.buffer('out');
          for (let row = 0; row < ROWS; row += 5) {
            let sum = 0;
            for (let c = 0; c < COLS; c += 1) sum += input[row * COLS + c] * input[row * COLS + c];
            const scale = 1 / Math.sqrt(sum / COLS + 1e-6);
            for (let c = 0; c < COLS; c += 11) {
              const expected = input[row * COLS + c] * scale;
              expect(Math.abs(out[row * COLS + c] - expected))
                .toBeLessThanOrEqual(Math.max(1e-4, Math.abs(expected) * 1e-4));
            }
          }
        });

        it('张量只读了一遍', async () => {
          await lab.buildAndRun();
          const bytes = ROWS * COLS * 4;
          expect(lab.metrics().memory.readBytes).toBeLessThanOrEqual(bytes * 1.2);
        });

        it('值留在寄存器里，没有掉到 local memory', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().local.bytes).toBe(0);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.memory.readBytes', op: 'lte', value: Math.round(N12 * 4 * 1.2),
      zh: 'DRAM 读字节数（两遍版是张量的 2 倍）', en: 'DRAM bytes read (2× tensor for two passes)',
      unit: 'byte', dimension: 'latency',
    }),
    gate({
      metric: 'gpu.local.bytes', op: 'eq', value: 0,
      zh: 'local memory 流量', en: 'local memory traffic',
      unit: 'byte', dimension: 'latency',
    }),
  ],
  focus: ['latency'],
};

/* ------------------------------------------------------------------ */
/* 第 14 关：算子融合                                                    */
/* ------------------------------------------------------------------ */

const N14 = 8192;

const STAGE_14 = {
  id: 'operator-fusion',
  title: t('算子融合 —— 别让中间结果落回显存',
    'Operator fusion — keep intermediates out of memory'),
  goal: t(
    [
      'Transformer 的前馈层里有一串逐元素操作：加 bias、过激活函数、加残差。',
      '每一步单独写成一个 kernel 的话，中间结果要**写回显存再读回来**，',
      '而这些数据本来就在寄存器里。',
      '',
      '`kernel.cu` 模拟了这种写法：三步之间用一块 scratch 缓冲区中转。',
      '`ncu` 上 DRAM 的读写加起来是张量的 **8 倍**（5 次读 + 3 次写）。',
      '',
      '**融合**就是把三步写进一个 kernel，中间值一直待在寄存器里：',
      '读 x、读 bias、读 residual、写 out —— **4 趟**搞定，而不是 8 趟。',
      '',
      '激活函数用 GELU 的 tanh 近似（这是 GPT 系列的标准写法）：',
      '',
      '```cuda',
      'float g = 0.5f * v * (1.0f + tanhf(0.7978845608f * (v + 0.044715f * v * v * v)));',
      '```',
      '',
      '```bash',
      'nvcc -o bench kernel.cu && ncu ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 结果不变',
      '- DRAM 读写总量 ≤ 张量的 4.5 倍（分开写是 8 倍）',
      '- 一个字节 scratch 都不用',
    ].join('\n'),
    [
      'A Transformer feed-forward block ends with a chain of element-wise steps: add a bias, apply an',
      'activation, add the residual. Written as three separate kernels, every intermediate is **written',
      'to memory and read back**, even though the data was already sitting in registers.',
      '',
      '`kernel.cu` mimics that shape, routing the three steps through a scratch buffer. `ncu` shows DRAM',
      'reads plus writes at **6×** the tensor size.',
      '',
      '**Fusion** puts all three in one kernel with the intermediates staying in registers: read x once,',
      'read x, bias and the residual, write out once. **Four trips** instead of eight.',
      '',
      'The activation is the tanh approximation of GELU, standard in the GPT family:',
      '',
      '```cuda',
      'float g = 0.5f * v * (1.0f + tanhf(0.7978845608f * (v + 0.044715f * v * v * v)));',
      '```',
      '',
      '```bash',
      'nvcc -o bench kernel.cu && ncu ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- unchanged results',
      '- DRAM reads plus writes at most 4.5× the tensor (8× unfused)',
      '- not a single byte of scratch',
    ].join('\n')
  ),
  checklist: [
    t('把三步写进一个 kernel', 'Put all three steps in one kernel'),
    t('中间值只用局部变量，不碰 scratch', 'Keep intermediates in locals and never touch scratch'),
    t('确认 DRAM 读写总量降下来', 'Confirm total DRAM traffic dropped'),
  ],
  hints: [
    t('三步是纯逐元素的，一个线程从头做到尾就行，不需要任何同步。',
      'All three steps are element-wise, so one thread can carry a value through with no synchronisation.'),
    t('`scratch` 参数留着不用就行，用例查的是它有没有被写过。',
      'Leave the `scratch` parameter unused; the spec checks whether anything was written to it.'),
  ],
  pitfalls: [
    t('**只融合了两步。** 三步都要在一个 kernel 里，少融一步 DRAM 就多两趟。',
      '**Fusing only two of the three.** All three must share one kernel; each unfused step adds two more trips.'),
    t('**用 `__expf` 之类的快速版换性能。** GELU 的 tanh 近似本身已经是近似了，'
      + '再叠一层低精度会让误差超出容差。',
      '**Reaching for `__expf` and friends.** The tanh approximation of GELU is already an approximation; '
      + 'stacking a low-precision variant on top pushes the error past tolerance.'),
  ],
  extension: t(
    '融合是推理引擎里收益最直接的一类优化，因为逐元素算子几乎全部是带宽受限的：'
    + '算得再快也没用，时间全花在搬数据上。`torch.compile` 的主要工作之一就是自动做这件事 ——'
    + '它把一串逐元素操作合成一个 Triton 内核。'
    + '手写的库里，Liger-Kernel 把 LLM 常见的融合模式（RMSNorm + 旋转位置编码、SwiGLU、'
    + '交叉熵）全部实现了一遍，整个库都是 Triton 写的。'
    + '再往上就是把 GEMM 与它后面的逐元素操作也融进去，那叫 epilogue fusion，是 CUTLASS 的招牌能力。',
    'Fusion is the most directly profitable optimisation in an inference engine because element-wise '
    + 'operators are almost all bandwidth-bound: computing faster does not help when the time goes into '
    + 'moving data. One of the main jobs of `torch.compile` is doing this automatically, collapsing a '
    + 'chain of element-wise operations into a single Triton kernel. Among hand-written libraries, '
    + 'Liger-Kernel implements the common LLM fusion patterns (RMSNorm plus rotary embeddings, SwiGLU, '
    + 'cross-entropy) and is written entirely in Triton. One level further up, fusing a GEMM with the '
    + 'element-wise work that follows it is called epilogue fusion and is a signature CUTLASS capability.'
  ),
  gpu: {
    files: {
      '/root/kernel.cu': code`
        // bias -> GELU -> residual
        //
        // 现在三步之间经 scratch 中转，中间结果写回显存又读回来。
        // 把它们融进一个 kernel，中间值留在寄存器里。
        __global__ void ffn(const float* x, const float* bias, const float* residual,
                            float* scratch, float* out, int n) {
          int i = blockIdx.x * blockDim.x + threadIdx.x;
          if (i >= n) return;

          // 第一步：加 bias，写回显存
          scratch[i] = x[i] + bias[i % 256];

          // 第二步：读回来过 GELU，再写回去
          float v = scratch[i];
          float g = 0.5f * v * (1.0f + tanhf(0.7978845608f * (v + 0.044715f * v * v * v)));
          scratch[i] = g;

          // 第三步：再读回来加残差
          out[i] = scratch[i] + residual[i];
        }
      `,
    },
    bench: {
      sources: ['/root/kernel.cu'],
      buffers: [
        { name: 'x', length: N14, fill: { kind: 'random', seed: 61, min: -3, max: 3 } },
        { name: 'bias', length: 256, fill: { kind: 'random', seed: 67, min: -1, max: 1 } },
        { name: 'residual', length: N14, fill: { kind: 'random', seed: 71, min: -1, max: 1 } },
        { name: 'scratch', length: N14, fill: { kind: 'zeros' } },
        { name: 'out', length: N14, fill: { kind: 'zeros' } },
      ],
      launches: [
        {
          kernel: 'ffn', grid: [N14 / 256], block: [256],
          args: ['x', 'bias', 'residual', 'scratch', 'out', N14],
        },
      ],
    },
    referenceFiles: {
      '/root/kernel.cu': code`
        __global__ void ffn(const float* x, const float* bias, const float* residual,
                            float* scratch, float* out, int n) {
          int i = blockIdx.x * blockDim.x + threadIdx.x;
          if (i >= n) return;

          // 三步一气呵成，中间值全程在寄存器里，scratch 一个字节都不用
          float v = x[i] + bias[i % 256];
          float g = 0.5f * v * (1.0f + tanhf(0.7978845608f * (v + 0.044715f * v * v * v)));
          out[i] = g + residual[i];
        }
      `,
    },
  },
  specs: [
    spec('fusion.spec.ts', code`
      const lab = require('@gpu/lab');
      const N = ${N14};

      function gelu(v) {
        const inner = 0.7978845608 * (v + 0.044715 * v * v * v);
        return 0.5 * v * (1 + Math.tanh(inner));
      }

      describe('融合的前馈尾巴', () => {
        it('结果对得上', async () => {
          await lab.buildAndRun();
          const x = lab.buffer('x');
          const bias = lab.buffer('bias');
          const residual = lab.buffer('residual');
          const out = lab.buffer('out');
          for (let i = 0; i < N; i += 13) {
            const expected = gelu(x[i] + bias[i % 256]) + residual[i];
            expect(Number.isFinite(out[i])).toBe(true);
            expect(Math.abs(out[i] - expected))
              .toBeLessThanOrEqual(Math.max(2e-4, Math.abs(expected) * 2e-4));
          }
        });

        it('中间结果没有落回显存', async () => {
          await lab.buildAndRun();
          const scratch = lab.buffer('scratch');
          expect(scratch.every((value) => value === 0)).toBe(true);
        });

        it('DRAM 读写总量从 8 趟降到 4 趟', async () => {
          await lab.buildAndRun();
          const metrics = lab.metrics();
          const bytes = N * 4;
          expect(metrics.memory.readBytes + metrics.memory.writeBytes)
            .toBeLessThanOrEqual(bytes * 4.5);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.memory.readBytes', op: 'lte', value: Math.round(N14 * 4 * 3.5),
      zh: 'DRAM 读字节数（分开写是 5 倍张量）', en: 'DRAM bytes read (5× tensor unfused)',
      unit: 'byte', dimension: 'latency',
    }),
    gate({
      metric: 'gpu.memory.writeBytes', op: 'lte', value: Math.round(N14 * 4 * 1.2),
      zh: 'DRAM 写字节数（分开写是 3 倍张量）', en: 'DRAM bytes written (3× tensor unfused)',
      unit: 'byte', dimension: 'latency',
    }),
  ],
  focus: ['latency'],
};

/* ------------------------------------------------------------------ */
/* 第 15、16 关：注意力                                                  */
/* ------------------------------------------------------------------ */

const SEQ = 128;
const DIM = 64;

const attentionBench = {
  sources: ['/root/attention.cu'],
  buffers: [
    { name: 'Q', length: SEQ * DIM, fill: { kind: 'random', seed: 81, min: -1, max: 1 } },
    { name: 'K', length: SEQ * DIM, fill: { kind: 'random', seed: 83, min: -1, max: 1 } },
    { name: 'V', length: SEQ * DIM, fill: { kind: 'random', seed: 89, min: -1, max: 1 } },
    // S 是那张 seq×seq 的注意力分数矩阵。第 16 关的目标就是一个字节都不碰它。
    { name: 'S', length: SEQ * SEQ, fill: { kind: 'zeros' } },
    { name: 'O', length: SEQ * DIM, fill: { kind: 'zeros' } },
  ],
  launches: [
    {
      kernel: 'attention', grid: [SEQ], block: [32],
      args: ['Q', 'K', 'V', 'S', 'O', SEQ, DIM],
    },
  ],
};

/** 两关共用的正确性检查：拿 fp64 算一遍完整的注意力 */
const ATTENTION_CORRECTNESS = code`
  it('结果和 fp64 参考对得上', async () => {
    await lab.buildAndRun();
    const Q = lab.buffer('Q');
    const K = lab.buffer('K');
    const V = lab.buffer('V');
    const O = lab.buffer('O');
    const scale = 1 / Math.sqrt(DIM);

    for (let row = 0; row < SEQ; row += 17) {
      const scores = new Float64Array(SEQ);
      for (let j = 0; j < SEQ; j += 1) {
        let dot = 0;
        for (let d = 0; d < DIM; d += 1) dot += Q[row * DIM + d] * K[j * DIM + d];
        scores[j] = dot * scale;
      }
      let max = -Infinity;
      for (let j = 0; j < SEQ; j += 1) max = Math.max(max, scores[j]);
      let sum = 0;
      for (let j = 0; j < SEQ; j += 1) sum += Math.exp(scores[j] - max);

      for (let d = 0; d < DIM; d += 11) {
        let expected = 0;
        for (let j = 0; j < SEQ; j += 1) {
          expected += (Math.exp(scores[j] - max) / sum) * V[j * DIM + d];
        }
        const actual = O[row * DIM + d];
        expect(Number.isFinite(actual)).toBe(true);
        expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-4);
      }
    }
  });
`;

const STAGE_15 = {
  id: 'naive-attention',
  title: t('朴素注意力 —— 亲手把显存打爆', 'Naive attention — blow up memory on purpose'),
  goal: t(
    [
      '注意力是 Transformer 的核心：`O = softmax(Q Kᵀ / √d) V`。',
      '',
      '按定义直接写就是三步：',
      '',
      '1. 算分数矩阵 `S = Q Kᵀ / √d`，形状是 **seq × seq**',
      '2. 对 S 的每一行做 softmax',
      '3. 用归一化后的权重加权 V',
      '',
      '`attention.cu` 里的 kernel 是空的，参数已经给好了 —— 注意有一个 `S` 参数，',
      '那就是第 1 步要写进去的分数矩阵。每个 block 一个 warp，负责一行 query。',
      '',
      '**这一关不设性能门槛**，把它写对就行。但跑完之后请看一眼 `ncu`：',
      '',
      '```bash',
      'nvcc -o bench attention.cu && ncu ./bench',
      '```',
      '',
      '这里 seq = 128，S 是 128×128 = 64 KB，看起来无所谓。',
      '**但 S 的大小是 seq 的平方。** 换成真实场景：',
      '',
      '| seq | S 的大小（单头 fp32） |',
      '| --- | --- |',
      '| 128 | 64 KB |',
      '| 2048 | 16 MB |',
      '| 8192 | 256 MB |',
      '| 32768 | 4 GB |',
      '',
      '再乘上头数（32）与批大小，长上下文的 S 根本放不进显存。',
      '这就是 FlashAttention 要解决的问题，也是下一关的内容。',
      '',
      '**通关标准**',
      '',
      '- 结果和 fp64 参考对得上',
      '- softmax 要减最大值，不能出 inf / nan',
      '- 分数矩阵确实被物化了（下一关就是来拆掉它的）',
    ].join('\n'),
    [
      'Attention is the heart of a Transformer: `O = softmax(Q Kᵀ / √d) V`.',
      '',
      'Written straight from the definition it is three steps:',
      '',
      '1. compute the score matrix `S = Q Kᵀ / √d`, shape **seq × seq**',
      '2. softmax each row of S',
      '3. weight V by the normalised scores',
      '',
      'The kernel in `attention.cu` is empty and the parameters are already there. Note the `S`',
      'parameter: that is the score matrix step 1 writes. One warp per block, one query row each.',
      '',
      '**No performance gate here**, just get it right. But look at `ncu` afterwards:',
      '',
      '```bash',
      'nvcc -o bench attention.cu && ncu ./bench',
      '```',
      '',
      'Here seq = 128 and S is 128×128 = 64 KB, which seems harmless.',
      '**But S grows with the square of seq.** In realistic settings:',
      '',
      '| seq | size of S (one head, fp32) |',
      '| --- | --- |',
      '| 128 | 64 KB |',
      '| 2048 | 16 MB |',
      '| 8192 | 256 MB |',
      '| 32768 | 4 GB |',
      '',
      'Multiply by the head count (32) and the batch size and S simply does not fit for long contexts.',
      'That is the problem FlashAttention solves, and the next stage.',
      '',
      '**To pass**',
      '',
      '- results match an fp64 reference',
      '- softmax subtracts the maximum, no inf/nan',
      '- the score matrix really is materialised (the next stage takes it apart)',
    ].join('\n')
  ),
  checklist: [
    t('算出 S = Q Kᵀ / √d 并写进 S 参数', 'Compute `S = Q Kᵀ / √d` and write it into the S parameter'),
    t('对 S 的每一行做数值稳定的 softmax', 'Apply a numerically stable softmax to each row of S'),
    t('用权重加权 V 得到输出', 'Weight V by those scores to produce the output'),
  ],
  hints: [
    t('一个 warp 负责一行 query。算 S 那一步让 32 个 lane 分头算不同的 j。',
      'One warp per query row. In the S step, let the 32 lanes handle different j values.'),
    t('softmax 的 max 与 sum 都要跨整个 warp 归并，用 `__shfl_xor_sync`。'
      + '写完 S 之后读它之前，加一句 `__syncwarp(0xffffffff)`。',
      'Both the max and the sum must be reduced across the warp with `__shfl_xor_sync`. '
      + 'Put a `__syncwarp(0xffffffff)` between writing S and reading it back.'),
  ],
  pitfalls: [
    t('**忘了除以 √d。** 点积的量级随维度增长，不缩放的话 softmax 会退化成 one-hot，'
      + '数值上还容易溢出。',
      '**Forgetting the 1/√d scaling.** Dot products grow with dimension; without it softmax collapses '
      + 'toward one-hot and overflows more easily.'),
    t('**softmax 不减最大值。** 分数里有正有负，`exp` 直接算容易出 inf，'
      + '除下来就是 nan。第 12 关讲过这一点。',
      '**Skipping the max subtraction in softmax.** Scores span positive and negative values; raw `exp` '
      + 'overflows to inf and the division yields nan. Stage 12 covered this.'),
  ],
  extension: t(
    '注意力的计算量是 O(seq² · d)，显存是 O(seq²)。'
    + '这两个平方是长上下文的根本困难，也是过去几年一大堆研究的出发点：'
    + '稀疏注意力砍掉大部分分数、线性注意力换一种结合律、'
    + '而 FlashAttention 选择了第三条路 —— 计算量一点不减，但**不把 S 存下来**，'
    + '于是显存从 O(seq²) 降到 O(seq)。下一关就做这件事。',
    'Attention costs O(seq² · d) in compute and O(seq²) in memory. Those two squares are the fundamental '
    + 'difficulty of long context and the starting point for years of research: sparse attention drops '
    + 'most scores, linear attention reassociates the products, and FlashAttention takes a third route, '
    + 'keeping the full computation but **never storing S**, which brings memory down from O(seq²) to '
    + 'O(seq). That is the next stage.'
  ),
  gpu: {
    files: {
      '/root/attention.cu': code`
        // O = softmax(Q K^T / sqrt(d)) V
        //
        // 一个 block 一个 warp，负责一行 query。
        // S 是 seq×seq 的分数矩阵，第一步写进去、后面两步读回来。
        __global__ void attention(const float* Q, const float* K, const float* V,
                                  float* S, float* O, int seq, int dim) {
          int row = blockIdx.x;
          int lane = threadIdx.x;

          // TODO: 三步走
          //   1. S[row][j] = dot(Q[row], K[j]) / sqrt(dim)
          //   2. 对 S[row][*] 做数值稳定的 softmax
          //   3. O[row][d] = sum_j P[j] * V[j][d]
        }
      `,
    },
    bench: attentionBench,
    referenceFiles: {
      '/root/attention.cu': code`
        __global__ void attention(const float* Q, const float* K, const float* V,
                                  float* S, float* O, int seq, int dim) {
          int row = blockIdx.x;
          int lane = threadIdx.x;
          float scale = rsqrtf((float)dim);

          // 1. 分数矩阵，写进显存
          for (int j = lane; j < seq; j += 32) {
            float acc = 0.0f;
            for (int d = 0; d < dim; ++d) acc = fmaf(Q[row * dim + d], K[j * dim + d], acc);
            S[row * seq + j] = acc * scale;
          }
          __syncwarp(0xffffffff);

          // 2. 行内 softmax，减最大值保证不溢出
          float m = -3.4e38f;
          for (int j = lane; j < seq; j += 32) m = fmaxf(m, S[row * seq + j]);
          for (int d = 16; d > 0; d >>= 1) m = fmaxf(m, __shfl_xor_sync(0xffffffff, m, d));

          float sum = 0.0f;
          for (int j = lane; j < seq; j += 32) sum += expf(S[row * seq + j] - m);
          for (int d = 16; d > 0; d >>= 1) sum += __shfl_xor_sync(0xffffffff, sum, d);

          // 3. 加权 V
          for (int d = lane; d < dim; d += 32) {
            float acc = 0.0f;
            for (int j = 0; j < seq; ++j) {
              acc = fmaf(expf(S[row * seq + j] - m) / sum, V[j * dim + d], acc);
            }
            O[row * dim + d] = acc;
          }
        }
      `,
    },
  },
  specs: [
    spec('attention.spec.ts', code`
      const lab = require('@gpu/lab');
      const SEQ = ${SEQ};
      const DIM = ${DIM};

      describe('朴素注意力', () => {
      ${ATTENTION_CORRECTNESS}
        it('softmax 减了最大值 —— 没有 inf 也没有 nan', async () => {
          await lab.buildAndRun();
          expect(lab.buffer('O').every((value) => Number.isFinite(value))).toBe(true);
          // 分数矩阵里也不能有溢出：直接 expf 一个大分数就会在这里暴露
          expect(lab.buffer('S').every((value) => Number.isFinite(value))).toBe(true);
        });

        it('确实把 seq×seq 的分数矩阵物化了 —— 这正是下一关要去掉的', async () => {
          await lab.buildAndRun();
          const S = lab.buffer('S');
          expect(S.some((value) => value !== 0)).toBe(true);
        });
      });
    `),
  ],
  // 这一关只有安全闸门：正文说了不设性能门槛，先把它写对。
  // 朴素版第一步天然就是非合并的（每个 lane 读 K 的不同行），
  // 挂一道合并访存的闸门等于要求学员在这一关就把它优化掉，和关卡意图相反。
  gates: [...SAFETY_GATES],
  focus: ['correctness'],
};

const STAGE_16 = {
  id: 'flash-attention',
  title: t('FlashAttention —— 不把分数矩阵存下来',
    'FlashAttention — never materialise the score matrix'),
  goal: t(
    [
      '上一关的 S 是 seq×seq。要让它不占显存，办法只有一个：**不存它**。',
      '',
      'FlashAttention 的思路是把三步合成一遍：一边算分数、一边做 softmax、一边加权 V。',
      '关键是第 12 关那个**在线 softmax** —— 它让你在还没看完整行的情况下，',
      '就能维护一个「到目前为止正确」的归一化结果，看到更大的值时把已有的部分修正一下。',
      '',
      '对输出也用同样的修正：',
      '',
      '```cuda',
      'float mNew = fmaxf(m, p);          // p 是新算出来的分数',
      'float corr = expf(m - mNew);        // 已有部分要缩放多少',
      'float w    = expf(p - mNew);',
      'l   = l   * corr + w;               // 归一化分母',
      'acc = acc * corr + w * V[j][d];     // 输出累加器',
      'm   = mNew;',
      '```',
      '',
      '走完整行之后 `acc / l` 就是答案，**而 S 从头到尾没有被写过一个字节**。',
      '显存从 O(seq²) 降到 O(seq)。',
      '',
      '```bash',
      'nvcc -o bench attention.cu && ncu ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 结果和上一关一样（fp64 参考，容差 1e-4）',
      '- `S` 缓冲区一个字节都没被写过',
      '- DRAM 写量 ≤ 40 KB（朴素版是 96 KB）',
    ].join('\n'),
    [
      'The S from the previous stage is seq×seq. There is only one way to stop it occupying memory:',
      '**do not store it**.',
      '',
      'FlashAttention fuses all three steps into one pass: score, softmax and V-weighting together.',
      'The key is the **online softmax** from stage 12, which maintains a result that is correct',
      '"so far" without having seen the whole row, rescaling what it has when a larger value appears.',
      '',
      'The same correction applies to the output accumulator:',
      '',
      '```cuda',
      'float mNew = fmaxf(m, p);          // p is the newly computed score',
      'float corr = expf(m - mNew);        // how much to rescale what we have',
      'float w    = expf(p - mNew);',
      'l   = l   * corr + w;               // normalising denominator',
      'acc = acc * corr + w * V[j][d];     // output accumulator',
      'm   = mNew;',
      '```',
      '',
      'After the row, `acc / l` is the answer, **and S was never written at all**. Memory drops from',
      'O(seq²) to O(seq).',
      '',
      '```bash',
      'nvcc -o bench attention.cu && ncu ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- same results as before (fp64 reference, tolerance 1e-4)',
      '- not a single byte written to `S`',
      '- DRAM writes at most 40 KB (96 KB naive)',
    ].join('\n')
  ),
  checklist: [
    t('把三步合成一个循环', 'Fuse the three steps into one loop'),
    t('同时维护 m、l 与输出累加器，每一步都按 corr 修正',
      'Maintain m, l and the output accumulators together, rescaling each by corr'),
    t('确认 S 一个字节都没写', 'Confirm nothing was written to S'),
  ],
  hints: [
    t('每个 lane 负责 `dim / 32 = 2` 个输出分量，所以要两个累加器。',
      'Each lane owns `dim / 32 = 2` output components, so keep two accumulators.'),
    t('算 `dot(Q[row], K[j])` 时让整个 warp 分头算再归并，这样每一步只需要一个 j。',
      'Compute `dot(Q[row], K[j])` by splitting across the warp and reducing, so each step handles one j.'),
  ],
  pitfalls: [
    t('**只修正了 l 忘了修正 acc。** 输出累加器和分母是在同一个 max 下算的，'
      + '两个都要按 corr 缩放，少一个结果就偏了。',
      '**Rescaling l but not acc.** The output accumulator and the denominator share the same running '
      + 'maximum; both need the corr factor or the result drifts.'),
    t('**最后忘了除以 l。** 累加器里是未归一化的加权和，'
      + '结果会大一个数量级 —— 而且量级正好是权重和，很容易看成「算法错了」。',
      '**Forgetting the final division by l.** The accumulator holds an unnormalised weighted sum, so the '
      + 'result is off by exactly the weight total, which is easy to misread as an algorithmic bug.'),
  ],
  extension: t(
    '这一关做的是 FlashAttention 的核心思想，真实现还要在此之上分块：'
    + 'K 与 V 按块搬进共享内存，Q 的一块留在寄存器里，'
    + '于是访存也从 O(seq²) 降下来 —— 我们这一版只解决了显存，访存量还是 O(seq²·d)。'
    + '\n\n'
    + 'FlashAttention-4 在 2026 年 3 月发布，针对 Blackwell 重写：因为 tensor core 变快了'
    + '而 SFU 没跟上，softmax 里那个 `exp()` 变得和矩阵乘一样贵，'
    + '于是要在两个 tile 之间 ping-pong，让一块的矩阵乘和另一块的指数运算重叠。'
    + '第 12 关那个「省下访存却多花 SFU」的取舍，在这里被放大成了整个 kernel 的结构。'
    + '\n\n'
    + '它也是从 Triton 退回 CuTe DSL 写的 —— Blackwell 的 TMA 与 TMEM 需要 tile 级控制，'
    + 'Triton 的抽象暴露不出来。',
    'This stage implements the core idea; a real implementation also tiles on top of it, staging blocks '
    + 'of K and V into shared memory with a block of Q in registers, which brings memory *traffic* down '
    + 'too. Our version only fixes the footprint; traffic is still O(seq²·d).\n\n'
    + 'FlashAttention-4 shipped in March 2026, rewritten for Blackwell: because tensor cores got faster '
    + 'while the SFU did not, the `exp()` in softmax became as expensive as the matmuls, so the kernel '
    + 'ping-pongs between two tiles to overlap one tile\'s matmuls with the other\'s exponentials. The '
    + 'trade from stage 12, saving memory traffic at the cost of SFU work, is magnified here into the '
    + 'structure of the whole kernel.\n\n'
    + 'It is also written in CuTe DSL rather than Triton: Blackwell\'s TMA and TMEM need tile-level '
    + 'control that Triton\'s abstractions do not expose.'
  ),
  gpu: {
    files: {
      '/root/attention.cu': code`
        // 上一关的朴素版：正确，但把 seq×seq 的分数矩阵写进了显存。
        //
        // 用在线 softmax 把三步合成一遍，让 S 一个字节都不用写。
        __global__ void attention(const float* Q, const float* K, const float* V,
                                  float* S, float* O, int seq, int dim) {
          int row = blockIdx.x;
          int lane = threadIdx.x;
          float scale = rsqrtf((float)dim);

          for (int j = lane; j < seq; j += 32) {
            float acc = 0.0f;
            for (int d = 0; d < dim; ++d) acc = fmaf(Q[row * dim + d], K[j * dim + d], acc);
            S[row * seq + j] = acc * scale;
          }
          __syncwarp(0xffffffff);

          float m = -3.4e38f;
          for (int j = lane; j < seq; j += 32) m = fmaxf(m, S[row * seq + j]);
          for (int d = 16; d > 0; d >>= 1) m = fmaxf(m, __shfl_xor_sync(0xffffffff, m, d));

          float sum = 0.0f;
          for (int j = lane; j < seq; j += 32) sum += expf(S[row * seq + j] - m);
          for (int d = 16; d > 0; d >>= 1) sum += __shfl_xor_sync(0xffffffff, sum, d);

          for (int d = lane; d < dim; d += 32) {
            float acc = 0.0f;
            for (int j = 0; j < seq; ++j) {
              acc = fmaf(expf(S[row * seq + j] - m) / sum, V[j * dim + d], acc);
            }
            O[row * dim + d] = acc;
          }
        }
      `,
    },
    bench: attentionBench,
    referenceFiles: {
      '/root/attention.cu': code`
        __global__ void attention(const float* Q, const float* K, const float* V,
                                  float* S, float* O, int seq, int dim) {
          int row = blockIdx.x;
          int lane = threadIdx.x;
          float scale = rsqrtf((float)dim);

          // 走一遍就够：分数、softmax、加权 V 同时进行
          float m = -3.4e38f;   // 到目前为止见过的最大分数
          float l = 0.0f;       // 到目前为止的归一化分母
          float acc0 = 0.0f;    // 每个 lane 负责 dim/32 = 2 个输出分量
          float acc1 = 0.0f;

          for (int j = 0; j < seq; ++j) {
            // 整个 warp 协作算一个点积
            float p = 0.0f;
            for (int d = lane; d < dim; d += 32) p = fmaf(Q[row * dim + d], K[j * dim + d], p);
            for (int dd = 16; dd > 0; dd >>= 1) p += __shfl_xor_sync(0xffffffff, p, dd);
            p = p * scale;

            // 在线修正：见到更大的分数就把已有的部分缩放一下
            float mNew = fmaxf(m, p);
            float corr = expf(m - mNew);
            float w = expf(p - mNew);

            l = l * corr + w;
            acc0 = acc0 * corr + w * V[j * dim + lane];
            acc1 = acc1 * corr + w * V[j * dim + lane + 32];
            m = mNew;
          }

          O[row * dim + lane] = acc0 / l;
          O[row * dim + lane + 32] = acc1 / l;
        }
      `,
    },
  },
  specs: [
    spec('attention.spec.ts', code`
      const lab = require('@gpu/lab');
      const SEQ = ${SEQ};
      const DIM = ${DIM};

      describe('FlashAttention', () => {
      ${ATTENTION_CORRECTNESS}
        it('**分数矩阵一个字节都没被写过**', async () => {
          await lab.buildAndRun();
          const S = lab.buffer('S');
          expect(S.every((value) => value === 0)).toBe(true);
        });

        it('DRAM 写量降到只剩输出', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().memory.writeBytes).toBeLessThanOrEqual(40 * 1024);
        });

        it('没有 inf / nan —— 在线修正必须数值稳定', async () => {
          await lab.buildAndRun();
          expect(lab.buffer('O').every((value) => Number.isFinite(value))).toBe(true);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.memory.writeBytes', op: 'lte', value: 40 * 1024,
      zh: 'DRAM 写字节数（朴素版是 96KB，含 seq×seq 的分数矩阵）',
      en: 'DRAM bytes written (96KB naive, including the seq×seq scores)',
      unit: 'byte', dimension: 'latency',
    }),
    gate({
      metric: 'gpu.memory.readBytes', op: 'lte', value: 20 * 1024 * 1024,
      zh: 'DRAM 读字节数（朴素版约 40MB）', en: 'DRAM bytes read (about 40MB naive)',
      unit: 'byte', dimension: 'latency',
    }),
  ],
  focus: ['latency', 'correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 17 关：KV cache                                                   */
/* ------------------------------------------------------------------ */

const DECODE_DIM = 64;
const DECODE_PROMPT = 32;
const DECODE_STEPS = 16;
const DECODE_TOTAL = DECODE_PROMPT + DECODE_STEPS;

/**
 * 两个 kernel 由平台给定、学员不改。
 *
 * 这一关考的是**宿主侧的循环怎么写**，不是 kernel 怎么优化。
 * 算术因此是完全固定的：任何正确的写法都会得到逐位相同的结果，
 * 所以判定可以直接比黄金值。
 */
const DECODE_KERNELS = code`
  // 从当前状态 x 投影出这一步的 q / k / v
  __global__ void project(const float* x, const float* W,
                          float* q, float* k, float* v, int dim) {
    int d = threadIdx.x;
    float aq = 0.0f; float ak = 0.0f; float av = 0.0f;
    for (int j = 0; j < dim; ++j) {
      float xv = x[j];
      aq = fmaf(xv, W[j * dim + d], aq);
      ak = fmaf(xv, W[dim * dim + j * dim + d], ak);
      av = fmaf(xv, W[2 * dim * dim + j * dim + d], av);
    }
    q[d] = aq; k[d] = ak; v[d] = av;
  }

  // 对 kCache / vCache 里前 len 个位置做注意力（第 16 关那份 FlashAttention）
  __global__ void attend(const float* q, const float* kCache, const float* vCache,
                         float* out, int len, int dim) {
    int lane = threadIdx.x;
    float scale = rsqrtf((float)dim);
    float m = -3.4e38f; float l = 0.0f; float acc0 = 0.0f; float acc1 = 0.0f;
    for (int j = 0; j < len; ++j) {
      float p = 0.0f;
      for (int d = lane; d < dim; d += 32) p = fmaf(q[d], kCache[j * dim + d], p);
      for (int dd = 16; dd > 0; dd >>= 1) p += __shfl_xor_sync(0xffffffff, p, dd);
      p = p * scale;
      float mNew = fmaxf(m, p);
      float corr = expf(m - mNew);
      float w = expf(p - mNew);
      l = l * corr + w;
      acc0 = acc0 * corr + w * vCache[j * dim + lane];
      acc1 = acc1 * corr + w * vCache[j * dim + lane + 32];
      m = mNew;
    }
    out[lane] = acc0 / l;
    out[lane + 32] = acc1 / l;
  }
`;

const decodeBench = {
  sources: ['/root/decode.cu'],
  buffers: [
    // 编号就是 lab_buffer 的下标，顺序不能改
    { name: 'W', length: 3 * DECODE_DIM * DECODE_DIM, fill: { kind: 'random', seed: 7, min: -0.15, max: 0.15 } },
    { name: 'x', length: DECODE_DIM, fill: { kind: 'const', value: 0.1 } },
    { name: 'out', length: DECODE_DIM, fill: { kind: 'zeros' } },
  ],
  // 学员自己写 main，平台不代起 kernel
  launches: [],
};

/**
 * 黄金值。
 *
 * 来源不是「参考解打印了什么」：重算版与缓存版是两个结构完全不同的实现，
 * 它们跑出来**逐位相同**，这才是可信的交叉验证。
 */
const DECODE_GOLDEN = [[0, -0.010491766035556793], [1, 0.0045389835722744465], [7, -0.0033696589525789022], [15, 0.025088032707571983], [23, -0.001545826904475689], [31, 0.005528752226382494], [47, -0.011208686977624893], [63, -0.01979956403374672]];

const STAGE_17 = {
  id: 'kv-cache',
  title: t('KV cache —— 别把算过的再算一遍', 'KV cache — stop recomputing what you already have'),
  goal: t(
    [
      '前 16 关都在优化单个 kernel。从这一关开始，**主战场挪到宿主侧**：',
      '你要写 `int main()`，自己决定分配什么显存、每一步起哪些 kernel。',
      '',
      '`decode.cu` 里给了两个 kernel（不用改）：',
      '',
      '- `project(x, W, q, k, v, dim)` —— 从当前状态投影出这一步的 q / k / v',
      '- `attend(q, kCache, vCache, out, len, dim)` —— 对前 `len` 个位置做注意力',
      '',
      '现在的 `main` 是**能跑但很蠢的版本**：每生成一步，它把历史上',
      '每一个位置的 k / v 全部重新投影一遍。这在数学上没错 ——',
      '同样的 x 和同样的 W，投影出来当然是同一个 k。',
      '',
      '但自回归解码有一个关键性质：**已经生成过的位置，它的 k 和 v 永远不会再变。**',
      '第 3 步算出来的 k，到第 48 步还是那个 k。既然如此，算一次存起来就行了。',
      '这就是 KV cache，也是所有推理引擎的第一块基石。',
      '',
      '把重算改成缓存：',
      '',
      '1. 分配 `kCache` / `vCache`，能装下最长 48 个位置',
      '2. 每一步只 `project` 一次，把新的 k / v **追加**到缓存末尾',
      '3. `attend` 对整个缓存做',
      '',
      '```bash',
      'nvcc -o bench decode.cu && ncu ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 输出和重算版逐位相同（kernel 是给定的，算术完全固定）',
      '- FMA 次数 ≤ 150 万（重算版是 1450 万）',
      '- 起的 block 总数 ≤ 200（重算版是 1224）',
    ].join('\n'),
    [
      'The first 16 stages optimised individual kernels. From here the action moves to the **host**:',
      'you write `int main()` and decide what to allocate and which kernels each step launches.',
      '',
      '`decode.cu` gives you two kernels (leave them alone):',
      '',
      '- `project(x, W, q, k, v, dim)` projects this step\'s q / k / v from the current state',
      '- `attend(q, kCache, vCache, out, len, dim)` attends over the first `len` positions',
      '',
      'The `main` you start with **works but is foolish**: for every generated step it reprojects',
      'the k and v of every historical position. Mathematically that is fine, the same x and the',
      'same W obviously project to the same k.',
      '',
      'But autoregressive decoding has one crucial property: **once a position has been generated,',
      'its k and v never change again.** The k computed at step 3 is still that k at step 48. So',
      'compute it once and keep it. That is the KV cache, the first foundation stone of every',
      'inference engine.',
      '',
      'Turn the recomputation into a cache:',
      '',
      '1. allocate `kCache` / `vCache` large enough for all 48 positions',
      '2. `project` once per step and **append** the new k / v to the end of the cache',
      '3. run `attend` over the whole cache',
      '',
      '```bash',
      'nvcc -o bench decode.cu && ncu ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- output bit-identical to the recomputing version (the kernels are fixed, so the arithmetic is)',
      '- at most 1.5M FMAs (14.5M recomputing)',
      '- at most 200 blocks launched (1224 recomputing)',
    ].join('\n')
  ),
  checklist: [
    t('分配能装下全部 48 个位置的 kCache / vCache',
      'Allocate kCache / vCache big enough for all 48 positions'),
    t('每步只 project 一次，把 k / v 追加到缓存末尾',
      'Project once per step and append the new k / v'),
    t('attend 对整个缓存做，长度随步数增长',
      'Attend over the whole cache, whose length grows with the step'),
  ],
  hints: [
    t('追加就是往 `kCache + len * dim` 这个位置拷 `dim * 4` 字节，'
      + '方向是 `cudaMemcpyDeviceToDevice` —— 两头都在显存里。',
      'Appending means copying `dim * 4` bytes to `kCache + len * dim`, with '
      + '`cudaMemcpyDeviceToDevice`: both ends are in device memory.'),
    t('注意顺序：**先追加再 attend**。当前这一步的 token 也要能被它自己看到，'
      + '这就是因果注意力。',
      'Mind the order: **append first, then attend**. The current token must be visible to '
      + 'itself, which is what causal attention means.'),
  ],
  pitfalls: [
    t('**先 attend 再追加。** 结果会差一个位置，而且前几步差得不明显 ——'
      + '越往后错得越离谱，最后看起来像是「模型不收敛」而不是「代码写错了」。',
      '**Attending before appending.** The result is off by one position, and the first few '
      + 'steps barely differ, so it looks like the model failing to converge rather than a bug.'),
    t('**缓存开小了。** 提示词 32 个位置加上生成 16 步，一共要 48 个，'
      + '不是 16 个。开小了会写到别人的显存上去。',
      '**Sizing the cache too small.** 32 prompt positions plus 16 generated steps is 48, not 16. '
      + 'Undersizing it writes into someone else\'s memory.'),
  ],
  extension: t(
    'KV cache 是拿显存换算力，而它换掉的显存不是小数：'
    + '每个位置每层要存 `2 × 头数 × 头维度` 个数，一个 70B 的模型在 fp16 下'
    + '大约是每个 token 每层 320KB，80 层就是 2.5MB —— 一条 4K 上下文的序列'
    + '光 KV cache 就要 10GB。'
    + '\n\n'
    + '所以从这一关往后，几乎所有工程都在跟这块显存较劲：'
    + '第 18 关的分页 KV 解决碎片，MQA / GQA 让多个查询头共享一份 KV，'
    + '再往后还有 KV 量化、跨请求前缀共享。'
    + '\n\n'
    + '另外注意重算版慢在哪：FMA 多了 21.8 倍，但**起 kernel 的次数多了 12.75 倍**。'
    + '真卡上每次 launch 有几微秒的固定开销，解码这种「每步计算量很小」的场景里，'
    + 'launch 开销本身就能成为瓶颈 —— 第 20 关的 CUDA Graph 就是来治这个的。',
    'A KV cache trades memory for compute, and the memory is not a rounding error: each position '
    + 'per layer stores `2 × heads × head_dim` values, roughly 320KB per token per layer for a 70B '
    + 'model in fp16, so 2.5MB across 80 layers. A single 4K-context sequence needs 10GB of KV '
    + 'cache alone.\n\n'
    + 'From here on almost all the engineering fights over that memory: stage 18 pages it to kill '
    + 'fragmentation, MQA and GQA share one KV across many query heads, and beyond that lie KV '
    + 'quantisation and cross-request prefix sharing.\n\n'
    + 'Note also *where* the recomputing version loses: 21.8x the FMAs, but **12.75x the kernel '
    + 'launches**. On real hardware each launch costs a few microseconds of fixed overhead, and in '
    + 'decoding, where each step does very little work, that overhead alone can be the bottleneck. '
    + 'Stage 20 and CUDA Graphs exist to fix exactly this.'
  ),
  gpu: {
    files: {
      '/root/decode.cu': code`
        #include "engine.h"

        ${DECODE_KERNELS}

        // 平台交过来的缓冲区：0 = 权重 W，1 = 当前状态 x，2 = 输出暂存 out
        int main(void) {
          const int DIM = ${DECODE_DIM};
          const int TOTAL = ${DECODE_TOTAL};
          float* W = lab_buffer(0);
          float* x = lab_buffer(1);
          float* out = lab_buffer(2);

          float* kCache; float* vCache; float* q; float* k; float* v; float* hist;
          cudaMalloc((void**)&kCache, TOTAL * DIM * 4);
          cudaMalloc((void**)&vCache, TOTAL * DIM * 4);
          cudaMalloc((void**)&q, DIM * 4);
          cudaMalloc((void**)&k, DIM * 4);
          cudaMalloc((void**)&v, DIM * 4);
          cudaMalloc((void**)&hist, TOTAL * DIM * 4);

          int len = 0;
          for (int step = 0; step < TOTAL; ++step) {
            cudaMemcpy(hist + len * DIM, x, DIM * 4, cudaMemcpyDeviceToDevice);
            len += 1;

            // TODO: 这个内层循环把历史上每一个位置的 k / v 都重新投影了一遍。
            //       已经生成过的位置，它的 k 和 v 永远不会再变 ——
            //       所以这里应该只 project 这一步的，追加到缓存末尾。
            for (int j = 0; j < len; ++j) {
              project<<<1, DIM>>>(hist + j * DIM, W, q, k, v, DIM);
              cudaMemcpy(kCache + j * DIM, k, DIM * 4, cudaMemcpyDeviceToDevice);
              cudaMemcpy(vCache + j * DIM, v, DIM * 4, cudaMemcpyDeviceToDevice);
            }

            attend<<<1, 32>>>(q, kCache, vCache, out, len, DIM);
            cudaMemcpy(x, out, DIM * 4, cudaMemcpyDeviceToDevice);
          }

          cudaFree(kCache); cudaFree(vCache);
          cudaFree(q); cudaFree(k); cudaFree(v); cudaFree(hist);
          return 0;
        }
      `,
    },
    bench: decodeBench,
    referenceFiles: {
      '/root/decode.cu': code`
        #include "engine.h"

        ${DECODE_KERNELS}

        int main(void) {
          const int DIM = ${DECODE_DIM};
          const int TOTAL = ${DECODE_TOTAL};
          float* W = lab_buffer(0);
          float* x = lab_buffer(1);
          float* out = lab_buffer(2);

          float* kCache; float* vCache; float* q; float* k; float* v;
          cudaMalloc((void**)&kCache, TOTAL * DIM * 4);
          cudaMalloc((void**)&vCache, TOTAL * DIM * 4);
          cudaMalloc((void**)&q, DIM * 4);
          cudaMalloc((void**)&k, DIM * 4);
          cudaMalloc((void**)&v, DIM * 4);

          int len = 0;
          for (int step = 0; step < TOTAL; ++step) {
            // 这一步的 k / v 只算一次
            project<<<1, DIM>>>(x, W, q, k, v, DIM);
            // 追加到缓存末尾，先追加再 attend —— 当前 token 要能看到自己
            cudaMemcpy(kCache + len * DIM, k, DIM * 4, cudaMemcpyDeviceToDevice);
            cudaMemcpy(vCache + len * DIM, v, DIM * 4, cudaMemcpyDeviceToDevice);
            len += 1;

            attend<<<1, 32>>>(q, kCache, vCache, out, len, DIM);
            cudaMemcpy(x, out, DIM * 4, cudaMemcpyDeviceToDevice);
          }

          cudaFree(kCache); cudaFree(vCache);
          cudaFree(q); cudaFree(k); cudaFree(v);
          return 0;
        }
      `,
    },
  },
  specs: [
    spec('decode.spec.ts', code`
      const lab = require('@gpu/lab');
      const GOLDEN = ${JSON.stringify(DECODE_GOLDEN)};

      describe('KV cache', () => {
        it('结果和重算版逐位相同', async () => {
          await lab.buildAndRun();
          const x = lab.buffer('x');
          for (const [index, expected] of GOLDEN) {
            expect(Math.abs(x[index] - expected)).toBeLessThanOrEqual(1e-9);
          }
        });

        it('确实跑满了 48 步', async () => {
          await lab.buildAndRun();
          // 每步一次 project（DIM/32 = 2 个 warp）加一次 attend（1 个 warp）
          expect(lab.metrics().launch.blocks).toBeGreaterThanOrEqual(2 * 48);
        });

        it('**每个位置只投影一次** —— 算力不再随步数平方增长', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().inst.fma).toBeLessThanOrEqual(1500000);
        });

        it('起 kernel 的次数不再随步数平方增长', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().launch.blocks).toBeLessThanOrEqual(200);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.inst.fma', op: 'lte', value: 1500000,
      zh: 'FMA 次数（重算版是 1450 万）', en: 'FMA count (14.5M recomputing)',
      unit: 'inst', dimension: 'latency',
    }),
    gate({
      metric: 'gpu.launch.blocks', op: 'lte', value: 200,
      zh: '起的 block 总数（重算版是 1224）', en: 'blocks launched (1224 recomputing)',
      unit: 'block', dimension: 'latency',
    }),
    gate({
      metric: 'gpu.memory.readBytes', op: 'lte', value: 8 * 1024 * 1024,
      zh: 'DRAM 读字节数（重算版是 63.5MB）', en: 'DRAM bytes read (63.5MB recomputing)',
      unit: 'byte', dimension: 'latency',
    }),
  ],
  focus: ['latency', 'correctness'],
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
  stages: [STAGE_1, STAGE_2, STAGE_3, STAGE_4, STAGE_5, STAGE_6, STAGE_7, STAGE_8, STAGE_9, STAGE_10, STAGE_11, STAGE_12, STAGE_13, STAGE_14, STAGE_15, STAGE_16, STAGE_17],
};
