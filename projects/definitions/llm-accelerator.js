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
/* 第 18 关：分页 KV cache                                              */
/* ------------------------------------------------------------------ */

const PAGE_DIM = 64;
const PAGE_BLOCK = 16;
const PAGE_SEQS = 6;
/** 长度差别很大，而且**事先不可知** —— 真实负载就长这样 */
const PAGE_LENGTHS = [90, 7, 40, 5, 61, 22];

/**
 * 平台给的两个 kernel。
 *
 * `attendPaged` 收一张**块表**，位置 j 的物理槽是
 * `table[j / blockSize] * blockSize + j % blockSize`。真实的 vLLM
 * paged attention kernel 收的就是这个 `block_tables` 参数。
 */
const PAGE_KERNELS = code`
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

  // 位置 j 不在 j * dim，而在 table 说的那一块里
  __global__ void attendPaged(const float* q, const float* kPool, const float* vPool,
                              const int* table, float* out,
                              int len, int blockSize, int dim) {
    int lane = threadIdx.x;
    float scale = rsqrtf((float)dim);
    float m = -3.4e38f; float l = 0.0f; float a0 = 0.0f; float a1 = 0.0f;
    for (int j = 0; j < len; ++j) {
      int slot = table[j / blockSize] * blockSize + (j % blockSize);
      float p = 0.0f;
      for (int d = lane; d < dim; d += 32) p = fmaf(q[d], kPool[slot * dim + d], p);
      for (int dd = 16; dd > 0; dd >>= 1) p += __shfl_xor_sync(0xffffffff, p, dd);
      p = p * scale;
      float mN = fmaxf(m, p); float c = expf(m - mN); float w = expf(p - mN);
      l = l * c + w;
      a0 = a0 * c + w * vPool[slot * dim + lane];
      a1 = a1 * c + w * vPool[slot * dim + lane + 32];
      m = mN;
    }
    out[lane] = a0 / l; out[lane + 32] = a1 / l;
  }
`;

const PAGE_LENS = PAGE_LENGTHS.map((n) => `vec_push(lens, ${n});`).join('\n            ');

const pagedBench = {
  sources: ['/root/paged.cu'],
  buffers: [
    { name: 'W', length: 3 * PAGE_DIM * PAGE_DIM, fill: { kind: 'random', seed: 11, min: -0.15, max: 0.15 } },
    { name: 'states', length: PAGE_SEQS * PAGE_DIM, fill: { kind: 'iota', scale: 0.0007, offset: 0.05 } },
  ],
  launches: [],
};

/**
 * 黄金值。
 *
 * 交叉验证同第 17 关：预留版与分页版是两套完全不同的显存布局，
 * 跑出来**逐位相同**。块表错一个数，attention 就会读到别的位置的 k/v，
 * 结果立刻对不上。
 */
const PAGE_GOLDEN = [[0, -0.007809331640601158], [63, -0.0009999065659940243], [64, -0.02667618915438652], [127, 0.009406697936356068], [200, -0.09454234689474106], [300, 0.0036766950506716967], [383, 0.009400105103850365]];

const STAGE_18 = {
  id: 'paged-kv-cache',
  title: t('分页 KV cache —— 把显存当虚拟内存管',
    'Paged KV cache — manage memory the way an OS manages pages'),
  goal: t(
    [
      '上一关的 KV cache 是一整片连续显存。放到多条序列一起跑的场景里，',
      '这个做法立刻出问题：**你不知道每条序列最后会有多长。**',
      '',
      '于是只能按最坏情况预留 —— 每条序列都按最长上下文划一片。',
      '`paged.cu` 现在就是这么干的：6 条序列，每条预留 8 块。',
      '而实际长度是 90 / 7 / 40 / 5 / 61 / 22 —— 那条 5 个位置的序列',
      '占着 8 块（128 个位置）的地方，浪费了 96%。',
      '',
      '操作系统早就解决过这个问题：**分页**。把显存切成固定大小的块，',
      '序列需要了才给一块，用完了还回去。序列在物理上不再连续，',
      '靠一张**块表**记录「逻辑第 b 块在物理第几块」。',
      '',
      '`attendPaged` 已经收块表了（真实的 vLLM paged attention kernel 也是这个签名），',
      '现在的块表只是一张静态的恒等映射。你要做的是：',
      '',
      '1. 开一个**固定大小**的块池（这一关给你 12 块），用 `ring` 当空闲块链表',
      '2. 用 `map` 当块表：`(序列号 * 1024 + 逻辑块号) -> 物理块号`',
      '3. 序列写到一个新块的第一个位置时，才从空闲链表取一块',
      '4. **序列结束时把它的块全部还回去** —— 12 块之所以够用，全靠这一步',
      '',
      '```bash',
      'nvcc -o bench paged.cu && ncu ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 输出和预留版逐位相同（块表对了，attention 读到的就是同一批 k/v）',
      '- 显存峰值 ≤ 200 KB（预留版是 435 KB）',
    ].join('\n'),
    [
      'The KV cache in the previous stage was one contiguous slab. Run several sequences together',
      'and that breaks immediately: **you do not know how long each sequence will end up being.**',
      '',
      'So you reserve for the worst case, a full max-context slab per sequence. That is what',
      '`paged.cu` does now: 6 sequences, 8 blocks each. The actual lengths are 90 / 7 / 40 / 5 /',
      '61 / 22, so the 5-position sequence holds 8 blocks (128 positions) and wastes 96% of them.',
      '',
      'Operating systems solved this long ago: **paging**. Cut memory into fixed-size blocks, hand',
      'one out when a sequence needs it, take it back when it is done. Sequences are no longer',
      'physically contiguous, so a **block table** records which physical block holds logical block b.',
      '',
      '`attendPaged` already takes a block table (the real vLLM paged attention kernel has the same',
      'signature); right now that table is just a static identity mapping. Your job:',
      '',
      '1. allocate a **fixed-size** block pool (12 blocks here) and keep a free list in a `ring`',
      '2. use a `map` as the block table: `(seq * 1024 + logical block) -> physical block`',
      '3. take a block from the free list only when a sequence reaches a new block\'s first position',
      '4. **return every block when a sequence finishes** — 12 blocks only suffice because of this',
      '',
      '```bash',
      'nvcc -o bench paged.cu && ncu ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- output bit-identical to the reserving version (a correct table reads the same k/v)',
      '- peak memory at most 200 KB (435 KB reserving)',
    ].join('\n')
  ),
  checklist: [
    t('用 ring 维护空闲块链表', 'Keep a free-block list in a `ring`'),
    t('用 map 维护块表，键是「序列号 * 1024 + 逻辑块号」',
      'Keep the block table in a `map` keyed by `seq * 1024 + logical block`'),
    t('每次 attend 之前把这条序列的块表拷到设备上',
      'Copy this sequence\'s block table to the device before each attend'),
    t('序列结束时把它占的块全部还回空闲链表',
      'Return every block to the free list when a sequence finishes'),
  ],
  hints: [
    t('只有当 `have % BLOCK == 0` 时才需要新块 —— 别的位置落在已有的块里。'
      + '用 `map_has` 判断更直白。',
      'A new block is only needed when `have % BLOCK == 0`; every other position falls inside an '
      + 'existing block. Checking with `map_has` reads more directly.'),
    t('块表是宿主侧的 `map`，而 kernel 要读设备上的数组。'
      + '每步把这条序列的 `logical + 1` 个块号拷成一个小数组送上去。',
      'The block table lives in a host-side `map`, but the kernel reads a device array. Each step, '
      + 'copy this sequence\'s `logical + 1` block numbers into a small array and send it up.'),
  ],
  pitfalls: [
    t('**忘了归还。** 12 块很快就被取空，`ring_pop` 会在空队列上报错。'
      + '这不是平台在为难你 —— 真实引擎里这一刻就是 OOM。',
      '**Forgetting to free.** Twelve blocks run out fast and `ring_pop` errors on an empty queue. '
      + 'That is not the platform being difficult: in a real engine this moment is an OOM.'),
    t('**块表只拷了最后一块。** kernel 要遍历位置 0 到 len-1，'
      + '所以整张表都得在设备上，不是只有当前这一块。',
      '**Only uploading the last block.** The kernel walks positions 0 through len-1, so the whole '
      + 'table has to be on the device, not just the current block.'),
    t('**归还的时候用错了长度。** 序列写到第 61 个位置占了 4 块（ceil(61/16)），'
      + '按 61/16 = 3 算会漏还一块，慢慢就把池漏空了。',
      '**Using the wrong count when freeing.** A sequence of 61 positions holds 4 blocks '
      + '(ceil(61/16)); computing 61/16 = 3 leaks one block per sequence and drains the pool.'),
  ],
  extension: t(
    '这就是 vLLM 那篇论文的核心，也是它名字的由来（PagedAttention）。'
    + '论文里报的数字是显存浪费从 60~80% 降到 4% 以下，'
    + '于是同样一张卡能同时装下的序列数翻了好几倍 —— 吞吐的提升主要来自这里，'
    + '不是来自 kernel 变快了。'
    + '\n\n'
    + '分页还顺手带来一件事：**块可以共享**。'
    + '几个请求用同一个系统提示词时，那部分的块表可以指向同一批物理块，'
    + '一份 KV 服务所有请求。再配上写时复制，就是前缀缓存。'
    + '\n\n'
    + '代价也和操作系统一样：多了一次间接寻址。'
    + '所以块大小是个取舍 —— 太小则块表变长、间接开销占比高，'
    + '太大则最后一块的内部碎片变大。vLLM 默认 16，和这一关一样。',
    'This is the core of the vLLM paper, and where its name comes from (PagedAttention). The paper '
    + 'reports memory waste dropping from 60-80% to under 4%, so a single card holds several times '
    + 'as many concurrent sequences. That is where the throughput came from, not from faster '
    + 'kernels.\n\n'
    + 'Paging brings something else along: **blocks can be shared**. When several requests share a '
    + 'system prompt, that part of their block tables can point at the same physical blocks, one '
    + 'copy of the KV serving every request. Add copy-on-write and you have prefix caching.\n\n'
    + 'The cost is the same one operating systems pay: an extra indirection. Block size is therefore '
    + 'a trade: too small and the table grows while indirection dominates; too large and the last '
    + 'block of each sequence wastes more. vLLM defaults to 16, the same as this stage.'
  ),
  gpu: {
    files: {
      '/root/paged.cu': code`
        #include "engine.h"
        #include "containers.h"

        ${PAGE_KERNELS}

        int main(void) {
          const int DIM = ${PAGE_DIM};
          const int SEQS = ${PAGE_SEQS};
          const int BLOCK = ${PAGE_BLOCK};
          const int MAXB = 8;

          float* W = lab_buffer(0);
          float* states = lab_buffer(1);
          int lens = vec_new();
          ${PAGE_LENS}

          // TODO: 现在每条序列预留 MAXB 块，谁也不还。
          //       改成一个 12 块的池 + 空闲链表 + 块表 + 用完归还。
          float* kP; float* vP; float* q; float* k; float* v; float* out; int* table;
          cudaMalloc((void**)&kP, SEQS * MAXB * BLOCK * DIM * 4);
          cudaMalloc((void**)&vP, SEQS * MAXB * BLOCK * DIM * 4);
          cudaMalloc((void**)&q, DIM * 4); cudaMalloc((void**)&k, DIM * 4);
          cudaMalloc((void**)&v, DIM * 4); cudaMalloc((void**)&out, DIM * 4);
          cudaMalloc((void**)&table, MAXB * 4);

          int len = vec_new();
          for (int s = 0; s < SEQS; ++s) vec_push(len, 0);

          int host[8];
          int alive = 1;
          while (alive == 1) {
            alive = 0;
            for (int s = 0; s < SEQS; ++s) {
              int have = vec_get(len, s);
              if (have >= vec_get(lens, s)) { continue; }
              int logical = have / BLOCK;
              // 静态恒等映射：第 s 条序列的第 b 块永远是物理块 s * MAXB + b
              int slot = (s * MAXB + logical) * BLOCK + (have % BLOCK);

              float* x = states + s * DIM;
              project<<<1, DIM>>>(x, W, q, k, v, DIM);
              cudaMemcpy(kP + slot * DIM, k, DIM * 4, cudaMemcpyDeviceToDevice);
              cudaMemcpy(vP + slot * DIM, v, DIM * 4, cudaMemcpyDeviceToDevice);

              int nb = logical + 1;
              for (int b = 0; b < nb; ++b) host[b] = s * MAXB + b;
              cudaMemcpy(table, host, nb * 4, cudaMemcpyHostToDevice);

              attendPaged<<<1, 32>>>(q, kP, vP, table, out, have + 1, BLOCK, DIM);
              cudaMemcpy(x, out, DIM * 4, cudaMemcpyDeviceToDevice);
              vec_set(len, s, have + 1);
              alive = 1;
            }
          }
          return 0;
        }
      `,
    },
    bench: pagedBench,
    referenceFiles: {
      '/root/paged.cu': code`
        #include "engine.h"
        #include "containers.h"

        ${PAGE_KERNELS}

        int main(void) {
          const int DIM = ${PAGE_DIM};
          const int SEQS = ${PAGE_SEQS};
          const int BLOCK = ${PAGE_BLOCK};
          const int POOL = 12;
          const int MAXB = 8;

          float* W = lab_buffer(0);
          float* states = lab_buffer(1);
          int lens = vec_new();
          ${PAGE_LENS}

          float* kP; float* vP; float* q; float* k; float* v; float* out; int* table;
          cudaMalloc((void**)&kP, POOL * BLOCK * DIM * 4);
          cudaMalloc((void**)&vP, POOL * BLOCK * DIM * 4);
          cudaMalloc((void**)&q, DIM * 4); cudaMalloc((void**)&k, DIM * 4);
          cudaMalloc((void**)&v, DIM * 4); cudaMalloc((void**)&out, DIM * 4);
          cudaMalloc((void**)&table, MAXB * 4);

          // 空闲块链表与块表
          int freeList = ring_new();
          for (int b = 0; b < POOL; ++b) ring_push(freeList, b);
          int blockTable = map_new();

          int len = vec_new();
          int done = vec_new();
          for (int s = 0; s < SEQS; ++s) { vec_push(len, 0); vec_push(done, 0); }

          int host[8];
          int alive = 1;
          while (alive == 1) {
            alive = 0;
            for (int s = 0; s < SEQS; ++s) {
              if (vec_get(done, s) == 1) { continue; }
              int have = vec_get(len, s);

              if (have >= vec_get(lens, s)) {
                // 结束了：把占的块全还回去。用 ceil 而不是整除 ——
                // 61 个位置占的是 4 块不是 3 块，少还一块就是慢性泄漏
                int nb = (have + BLOCK - 1) / BLOCK;
                for (int b = 0; b < nb; ++b) {
                  ring_push(freeList, map_get(blockTable, s * 1024 + b, 0));
                  map_del(blockTable, s * 1024 + b);
                }
                vec_set(done, s, 1);
                continue;
              }

              int logical = have / BLOCK;
              if (map_has(blockTable, s * 1024 + logical) == 0) {
                map_set(blockTable, s * 1024 + logical, ring_pop(freeList));
              }
              int physical = map_get(blockTable, s * 1024 + logical, -1);
              int slot = physical * BLOCK + (have % BLOCK);

              float* x = states + s * DIM;
              project<<<1, DIM>>>(x, W, q, k, v, DIM);
              cudaMemcpy(kP + slot * DIM, k, DIM * 4, cudaMemcpyDeviceToDevice);
              cudaMemcpy(vP + slot * DIM, v, DIM * 4, cudaMemcpyDeviceToDevice);

              // 整张表都要在设备上 —— kernel 会遍历位置 0 到 len-1
              int nb = logical + 1;
              for (int b = 0; b < nb; ++b) host[b] = map_get(blockTable, s * 1024 + b, -1);
              cudaMemcpy(table, host, nb * 4, cudaMemcpyHostToDevice);

              attendPaged<<<1, 32>>>(q, kP, vP, table, out, have + 1, BLOCK, DIM);
              cudaMemcpy(x, out, DIM * 4, cudaMemcpyDeviceToDevice);
              vec_set(len, s, have + 1);
              alive = 1;
            }
          }
          return 0;
        }
      `,
    },
  },
  specs: [
    spec('paged.spec.ts', code`
      const lab = require('@gpu/lab');
      const GOLDEN = ${JSON.stringify(PAGE_GOLDEN)};

      describe('分页 KV cache', () => {
        it('结果和预留版逐位相同 —— 块表对了才读得到同一批 k/v', async () => {
          await lab.buildAndRun();
          const states = lab.buffer('states');
          for (const [index, expected] of GOLDEN) {
            expect(Math.abs(states[index] - expected)).toBeLessThanOrEqual(1e-9);
          }
        });

        it('六条序列全都跑完了', async () => {
          await lab.buildAndRun();
          // 每步 project（2 个 warp）加 attend（1 个），一共 225 个位置
          expect(lab.metrics().launch.blocks).toBe(450);
        });

        it('**显存峰值降下来了**', async () => {
          await lab.buildAndRun();
          expect(lab.peakBytes()).toBeLessThanOrEqual(200 * 1024);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.memoryPeakBytes', op: 'lte', value: 200 * 1024,
      zh: '显存峰值（预留版是 435KB）', en: 'peak device memory (435KB reserving)',
      unit: 'byte', dimension: 'throughput',
    }),
  ],
  focus: ['throughput', 'correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 19 关：量化                                                       */
/* ------------------------------------------------------------------ */

const Q_SEQ = 64;
const Q_DIM = 128;
/** NVFP4 用的就是 16 —— 这个数字不是随便挑的，见关卡正文 */
const Q_BLOCK = 16;

/**
 * 造一份带**离群通道**的 K。
 *
 * SmoothQuant 描述的现象：绝大多数激活值在同一个量级，但个别通道
 * 在**所有 token 上**都大得离谱。这里第 11 与第 68 号通道大约是
 * 其它通道的十万倍 —— 比论文里报的 100 倍还狠一些，
 * 好让「正常值被压成 0」这件事在 64×128 这么小的规模上也看得见。
 */
function makeQuantData() {
  let seed = 20260826;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const values = [];
  for (let row = 0; row < Q_SEQ; row += 1) {
    for (let d = 0; d < Q_DIM; d += 1) {
      if (d === 11) values.push(2600 * (0.8 + 0.4 * next()));
      else if (d === 68) values.push(-1900 * (0.8 + 0.4 * next()));
      else values.push((next() - 0.5) * 0.04);
    }
  }
  return values;
}

const QUANT_VALUES = makeQuantData();

const quantBench = {
  sources: ['/root/quant.cu'],
  buffers: [
    { name: 'K', length: Q_SEQ * Q_DIM, fill: { kind: 'values', values: QUANT_VALUES } },
    // fp8 打包存储：4 个 8 位存储挤在一个 int 里，所以只有四分之一大
    { name: 'packed', length: Q_SEQ * (Q_DIM / 4), type: 'int', fill: { kind: 'zeros' } },
    { name: 'scales', length: Q_SEQ * (Q_DIM / Q_BLOCK), fill: { kind: 'zeros' } },
    { name: 'restored', length: Q_SEQ * Q_DIM, fill: { kind: 'zeros' } },
  ],
  launches: [
    { kernel: 'quantize', grid: [Q_SEQ], block: [32], args: ['K', 'packed', 'scales', Q_SEQ, Q_DIM] },
    { kernel: 'dequantize', grid: [Q_SEQ], block: [32], args: ['packed', 'scales', 'restored', Q_SEQ, Q_DIM] },
  ],
};

const STAGE_19 = {
  id: 'quantization',
  title: t('量化 —— scale 的粒度决定一切', 'Quantisation — granularity of the scale is everything'),
  goal: t(
    [
      'KV cache 是显存大户。把它从 fp32 换成 fp8，显存立刻降到四分之一 ——',
      '这一步谁都会想到。难的是**怎么不把精度丢光**。',
      '',
      'fp8 的 E4M3 格式从 2⁻⁹ 到 448，只有不到 19 个二进制数量级',
      '（fp32 有 277 个）。所以量化必须先乘一个 **scale** 把数搬进这个范围，',
      '读回来再除掉。scale 怎么定，就是全部的门道。',
      '',
      '`quant.cu` 现在用的是 **per-tensor** scale：整个张量一个 scale，',
      '取全局最大绝对值算出来。问题出在真实的激活值上 ——',
      '**个别通道会比其它通道大几个数量级**。',
      '这份 K 里第 11 与第 68 号通道就是这样的离群通道。',
      '',
      '于是 scale 被离群值绑架，正常值缩得比 E4M3 的最小次正规数还小，',
      '**直接量化成 0**。跑一下就能看到：三分之一的正常值没了。',
      '',
      '把 scale 改成**按通道分块**：每 16 个通道一个 scale。',
      '离群通道被关进它自己那一块，剩下 7 块不受影响。',
      '',
      '```bash',
      'nvcc -o bench quant.cu && ncu ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 被压成 0 的正常值 ≤ 10%（per-tensor 是 34.3%）',
      '- `scales` 里真的有 `seq × dim/16` 个 scale，不是只填了一个',
      '- 打包存储仍然是四分之一大小（不许偷偷用 fp32 存）',
    ].join('\n'),
    [
      'The KV cache is the memory hog. Moving it from fp32 to fp8 cuts memory to a quarter, which',
      'everyone thinks of. The hard part is **not throwing away the accuracy**.',
      '',
      'fp8 E4M3 spans 2⁻⁹ to 448, under 19 binary orders of magnitude (fp32 has 277). So',
      'quantisation must first multiply by a **scale** to move values into that range and divide it',
      'back out on read. How you choose that scale is the whole game.',
      '',
      '`quant.cu` currently uses a **per-tensor** scale: one scale for the whole tensor, from the',
      'global maximum absolute value. Real activations break this, because **a few channels are',
      'orders of magnitude larger than the rest**. Channels 11 and 68 of this K are such outliers.',
      '',
      'The scale is then hostage to the outlier, normal values shrink below E4M3\'s smallest',
      'subnormal and **quantise straight to zero**. Run it and see: a third of the normal values',
      'are gone.',
      '',
      'Change the scale to be **per block of channels**: one scale every 16 channels. The outlier',
      'channel is confined to its own block and the other 7 are untouched.',
      '',
      '```bash',
      'nvcc -o bench quant.cu && ncu ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- at most 10% of normal values flattened to zero (34.3% per-tensor)',
      '- `scales` really holds `seq × dim/16` scales, not just one',
      '- the packed store is still a quarter the size (no sneaking back to fp32)',
    ].join('\n')
  ),
  checklist: [
    t('每 16 个通道算一个 scale', 'Compute one scale per 16 channels'),
    t('量化时按元素所在的块取 scale', 'Pick the scale by which block the element falls in'),
    t('反量化时用同一个 scale 除回去', 'Divide by that same scale when dequantising'),
  ],
  hints: [
    t('第 d 个元素属于第 `d / 16` 块，scale 存在 `scales[row * (dim / 16) + d / 16]`。',
      'Element d belongs to block `d / 16`, whose scale lives at `scales[row * (dim / 16) + d / 16]`.'),
    t('打包的时候一个 int 装 4 个元素，这 4 个元素**可能跨块** —— '
      + '16 能被 4 整除，所以其实不会，但按元素各取各的 scale 更稳当。',
      'One int packs four elements, which **could** straddle a block boundary. Sixteen is divisible '
      + 'by four so they never do here, but looking up each element\'s scale separately is safer.'),
  ],
  pitfalls: [
    t('**量化用块 scale、反量化用全局 scale。** 结果会呈现出一种奇怪的分段错误：'
      + '有的块对、有的块差好几个数量级，看起来像是内存写乱了。',
      '**Quantising with block scales but dequantising with a global one.** The result looks '
      + 'strangely piecewise: some blocks correct, others off by orders of magnitude, which reads '
      + 'like memory corruption rather than a scale bug.'),
    t('**scale 取成最大值本身而不是 448 / 最大值。** 方向反了，'
      + '所有值会被缩到 1/2600 而不是放大 —— 一样全归零，但原因完全不同。',
      '**Setting the scale to the maximum instead of 448 / maximum.** The direction is inverted, '
      + 'everything shrinks by 1/2600 instead of expanding, and everything zeroes out again for a '
      + 'completely different reason.'),
    t('**最大值取到 0 时除零。** 全零的块是存在的，记得夹一个下限。',
      '**Dividing by a zero maximum.** All-zero blocks happen; clamp the denominator.'),
  ],
  extension: t(
    '这一关的数字有出处。SmoothQuant（arXiv:2211.10438，2022 年 11 月，ICML 2023）'
    + '给了最直白的算法：设通道 i 的最大值是 mᵢ、整个矩阵的最大值是 m，'
    + '那么通道 i 实际用得上的量化格点数是 `2⁸ · mᵢ/m`。'
    + '离群值大 100 倍时，**正常通道在 256 个格点里只剩 2 到 3 个**。'
    + '\n\n'
    + '而离群值能大到什么程度？《Massive Activations in Large Language Models》'
    + '（arXiv:2402.17762，ICML 2024）在 LLaMA2-7B 上量到最大激活值 2622、中位数 0.2，'
    + '差一万倍；Mixtral-8x7B 是 7100 比 0.3。而这样的值每个 hidden state 里只有 2 到 4 个。'
    + '\n\n'
    + '为什么不干脆 per-channel？SmoothQuant 说得很清楚：per-channel 精度够，'
    + '**但和 INT8 的 GEMM kernel 不兼容** —— scale 必须能在归约维度上提出来。'
    + '整个 microscaling 硬件路线（NVFP4 每 16 个一个 scale、MXFP4 每 32 个）'
    + '就是为了在硬件里原生支持这件事。'
    + '\n\n'
    + 'NVFP4 与 MXFP4 的差别正好在 scale 上：NVFP4 是 16 个元素一块、scale 用 fp8 E4M3，'
    + '外面再套一个 per-tensor 的 fp32 scale；MXFP4 是 32 个一块、scale 用 E8M0（只能是 2 的幂）、'
    + '没有第二级。多出来的那半个 bit 换来的是精度：Llama-3.1-8B 上 W4A4 的 RTN，'
    + 'NVFP4 恢复到 94.67%，MXFP4 只有 87.83%（arXiv:2509.23202，2026 年 3 月）。'
    + '\n\n'
    + '一个反直觉的结论也来自那篇：**NVFP4 那么小的 block 反而让传统的离群值处理失效**。'
    + 'Hadamard 旋转会把离群值的误差均摊到所有坐标上，'
    + '而 absmax scaling 在小 block 上本来就保护得很好，旋转反而抹掉了这个保护。',
    'The numbers here have sources. SmoothQuant (arXiv:2211.10438, November 2022, ICML 2023) gives '
    + 'the cleanest arithmetic: if channel i has maximum mᵢ and the whole matrix has maximum m, the '
    + 'effective number of quantisation levels for channel i is `2⁸ · mᵢ/m`. With outliers 100x '
    + 'larger, **normal channels get 2 to 3 of the 256 levels**.\n\n'
    + 'How large do outliers get? Massive Activations in Large Language Models (arXiv:2402.17762, '
    + 'ICML 2024) measured a maximum activation of 2622 against a median of 0.2 in LLaMA2-7B, a '
    + 'factor of ten thousand; Mixtral-8x7B was 7100 against 0.3. Each hidden state holds only 2 to '
    + '4 such values.\n\n'
    + 'Why not simply go per-channel? SmoothQuant is explicit: per-channel is accurate enough **but '
    + 'incompatible with INT8 GEMM kernels**, because the scale has to factor out along the '
    + 'reduction dimension. The entire microscaling hardware line (NVFP4 one scale per 16 elements, '
    + 'MXFP4 per 32) exists to support this natively.\n\n'
    + 'NVFP4 and MXFP4 differ exactly in the scale: NVFP4 blocks 16 elements with an fp8 E4M3 scale '
    + 'plus a second per-tensor fp32 scale; MXFP4 blocks 32 with an E8M0 scale (powers of two only) '
    + 'and no second level. That extra half bit buys accuracy: on Llama-3.1-8B W4A4 with RTN, NVFP4 '
    + 'recovers 94.67% against MXFP4\'s 87.83% (arXiv:2509.23202, March 2026).\n\n'
    + 'One counter-intuitive result from the same paper: **NVFP4\'s small blocks actually neutralise '
    + 'traditional outlier mitigation.** Hadamard rotation spreads the outlier\'s error across all '
    + 'coordinates, and absmax scaling over a small block already protects them, so the rotation '
    + 'erases that protection instead of helping.'
  ),
  gpu: {
    files: {
      '/root/quant.cu': code`
        #include "cuda_fp8.h"

        // 量化：把 K 打包成 fp8（4 个挤一个 int），同时算出 scale
        __global__ void quantize(const float* K, int* packed, float* scales, int seq, int dim) {
          int row = blockIdx.x;
          int lane = threadIdx.x;

          // TODO: per-tensor —— 整个张量一个 scale。
          //       离群通道会把它绑架，正常值全被压成 0。
          //       改成每 ${Q_BLOCK} 个通道一个 scale。
          if (lane == 0) {
            float amax = 0.0f;
            for (int j = 0; j < seq; ++j) {
              for (int d = 0; d < dim; ++d) amax = fmaxf(amax, fabsf(K[j * dim + d]));
            }
            scales[0] = 448.0f / fmaxf(amax, 1e-30f);
          }
          __syncwarp(0xffffffff);

          for (int d = lane; d < dim / 4; d += 32) {
            int base = d * 4;
            float s = scales[0];
            int a = __nv_cvt_float_to_fp8(K[row * dim + base + 0] * s, __NV_SATFINITE, __NV_E4M3);
            int b = __nv_cvt_float_to_fp8(K[row * dim + base + 1] * s, __NV_SATFINITE, __NV_E4M3);
            int c = __nv_cvt_float_to_fp8(K[row * dim + base + 2] * s, __NV_SATFINITE, __NV_E4M3);
            int e = __nv_cvt_float_to_fp8(K[row * dim + base + 3] * s, __NV_SATFINITE, __NV_E4M3);
            packed[row * (dim / 4) + d] = a | (b << 8) | (c << 16) | (e << 24);
          }
        }

        // 反量化：拆开 4 个字节，各自除回它的 scale
        __global__ void dequantize(const int* packed, const float* scales,
                                   float* out, int seq, int dim) {
          int row = blockIdx.x;
          int lane = threadIdx.x;

          for (int d = lane; d < dim / 4; d += 32) {
            int word = packed[row * (dim / 4) + d];
            int base = d * 4;
            for (int t = 0; t < 4; ++t) {
              float sc = scales[0];
              int byte = (word >> (t * 8)) & 255;
              out[row * dim + base + t] = (float)__nv_cvt_fp8_to_halfraw(byte, __NV_E4M3) / sc;
            }
          }
        }
      `,
    },
    bench: quantBench,
    referenceFiles: {
      '/root/quant.cu': code`
        #include "cuda_fp8.h"

        __global__ void quantize(const float* K, int* packed, float* scales, int seq, int dim) {
          int row = blockIdx.x;
          int lane = threadIdx.x;
          int blocks = dim / ${Q_BLOCK};

          // 每 ${Q_BLOCK} 个通道一个 scale：离群通道被关进它自己那一块
          if (lane == 0) {
            for (int b = 0; b < blocks; ++b) {
              float amax = 0.0f;
              for (int d = 0; d < ${Q_BLOCK}; ++d) {
                amax = fmaxf(amax, fabsf(K[row * dim + b * ${Q_BLOCK} + d]));
              }
              // 夹一个下限：全零的块是存在的
              scales[row * blocks + b] = 448.0f / fmaxf(amax, 1e-30f);
            }
          }
          __syncwarp(0xffffffff);

          for (int d = lane; d < dim / 4; d += 32) {
            int base = d * 4;
            float s0 = scales[row * blocks + (base + 0) / ${Q_BLOCK}];
            float s1 = scales[row * blocks + (base + 1) / ${Q_BLOCK}];
            float s2 = scales[row * blocks + (base + 2) / ${Q_BLOCK}];
            float s3 = scales[row * blocks + (base + 3) / ${Q_BLOCK}];
            int a = __nv_cvt_float_to_fp8(K[row * dim + base + 0] * s0, __NV_SATFINITE, __NV_E4M3);
            int b = __nv_cvt_float_to_fp8(K[row * dim + base + 1] * s1, __NV_SATFINITE, __NV_E4M3);
            int c = __nv_cvt_float_to_fp8(K[row * dim + base + 2] * s2, __NV_SATFINITE, __NV_E4M3);
            int e = __nv_cvt_float_to_fp8(K[row * dim + base + 3] * s3, __NV_SATFINITE, __NV_E4M3);
            packed[row * (dim / 4) + d] = a | (b << 8) | (c << 16) | (e << 24);
          }
        }

        __global__ void dequantize(const int* packed, const float* scales,
                                   float* out, int seq, int dim) {
          int row = blockIdx.x;
          int lane = threadIdx.x;
          int blocks = dim / ${Q_BLOCK};

          for (int d = lane; d < dim / 4; d += 32) {
            int word = packed[row * (dim / 4) + d];
            int base = d * 4;
            for (int t = 0; t < 4; ++t) {
              // 量化用哪个 scale，反量化就得用哪个
              float sc = scales[row * blocks + (base + t) / ${Q_BLOCK}];
              int byte = (word >> (t * 8)) & 255;
              out[row * dim + base + t] = (float)__nv_cvt_fp8_to_halfraw(byte, __NV_E4M3) / sc;
            }
          }
        }
      `,
    },
  },
  specs: [
    spec('quant.spec.ts', code`
      const lab = require('@gpu/lab');
      const SEQ = ${Q_SEQ};
      const DIM = ${Q_DIM};
      const BLOCK = ${Q_BLOCK};
      /** 离群通道，绝对值上万；别的都在 0.02 量级 */
      const OUTLIER_CHANNELS = [11, 68];

      function normalIndices(K) {
        const out = [];
        for (let row = 0; row < SEQ; row += 1) {
          for (let d = 0; d < DIM; d += 1) {
            if (OUTLIER_CHANNELS.indexOf(d) >= 0) continue;
            if (K[row * DIM + d] !== 0) out.push(row * DIM + d);
          }
        }
        return out;
      }

      describe('量化', () => {
        it('**被压成 0 的正常值降到 10% 以下**', async () => {
          await lab.buildAndRun();
          const K = lab.buffer('K');
          const restored = lab.buffer('restored');
          const indices = normalIndices(K);
          const zeroed = indices.filter((i) => restored[i] === 0).length;
          // per-tensor 是 34.3%
          expect(zeroed / indices.length).toBeLessThanOrEqual(0.1);
        });

        it('离群通道自己仍然是准的 —— 不能靠牺牲它来换', async () => {
          await lab.buildAndRun();
          const K = lab.buffer('K');
          const restored = lab.buffer('restored');
          for (const d of OUTLIER_CHANNELS) {
            for (let row = 0; row < SEQ; row += 8) {
              const i = row * DIM + d;
              const rel = Math.abs(restored[i] - K[i]) / Math.abs(K[i]);
              expect(rel).toBeLessThanOrEqual(0.05);
            }
          }
        });

        it('scales 里真的有 seq × dim/16 个 scale', async () => {
          await lab.buildAndRun();
          const scales = lab.buffer('scales');
          const filled = Array.from(scales).filter((v) => v !== 0).length;
          expect(filled).toBe(SEQ * (DIM / BLOCK));
          // 而且不是全都一样 —— 一样就说明还是 per-tensor
          expect(new Set(Array.from(scales)).size).toBeGreaterThan(2);
        });

        it('打包存储还是四分之一大小', async () => {
          await lab.buildAndRun();
          const packed = lab.bufferInts('packed');
          expect(packed.length).toBe(SEQ * DIM / 4);
          // 每个 int 的四个字节都用上了，不是只写了低 8 位
          const highBitsUsed = Array.from(packed).some((w) => ((w >> 24) & 255) !== 0);
          expect(highBitsUsed).toBe(true);
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
  ],
  focus: ['correctness', 'throughput'],
};

/* ------------------------------------------------------------------ */
/* 第 20 关：CUDA Graph 与引擎组装                                       */
/* ------------------------------------------------------------------ */

const G_DIM = 64;
const G_STEPS = 48;

/**
 * 一整层的五个 kernel，全部由平台给定。
 *
 * **每一个都从显存读序列长度**，没有一个按值收 `len`。
 * 这不是为了好看：graph 录下来的是捕获那一刻的实参值，
 * 按值传的标量之后再变也不会生效。真实引擎为了能用 graph，
 * 会把所有随步数变化的量做成显存里的值 —— 这几个签名就是那么来的。
 */
const GRAPH_KERNELS = code`
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

  // 把这一步的 k / v 追加到缓存末尾。位置由**显存里的** len 决定
  __global__ void appendKv(float* kCache, float* vCache,
                           const float* k, const float* v,
                           const int* len, int dim) {
    int d = threadIdx.x;
    int slot = len[0];
    kCache[slot * dim + d] = k[d];
    vCache[slot * dim + d] = v[d];
  }

  // 长度加一，同样在显存里改
  __global__ void bumpLen(int* len) {
    if (threadIdx.x == 0) len[0] = len[0] + 1;
  }

  __global__ void attendLen(const float* q, const float* kCache, const float* vCache,
                            float* out, const int* len, int dim) {
    int lane = threadIdx.x;
    int n = len[0];
    float scale = rsqrtf((float)dim);
    float m = -3.4e38f; float l = 0.0f; float a0 = 0.0f; float a1 = 0.0f;
    for (int j = 0; j < n; ++j) {
      float p = 0.0f;
      for (int d = lane; d < dim; d += 32) p = fmaf(q[d], kCache[j * dim + d], p);
      for (int dd = 16; dd > 0; dd >>= 1) p += __shfl_xor_sync(0xffffffff, p, dd);
      p = p * scale;
      float mN = fmaxf(m, p); float c = expf(m - mN); float w = expf(p - mN);
      l = l * c + w;
      a0 = a0 * c + w * vCache[j * dim + lane];
      a1 = a1 * c + w * vCache[j * dim + lane + 32];
      m = mN;
    }
    out[lane] = a0 / l; out[lane + 32] = a1 / l;
  }

  // 把输出接回输入，准备下一步
  __global__ void feedback(float* x, const float* out, int dim) {
    int d = threadIdx.x;
    x[d] = out[d];
  }
`;

const graphBench = {
  sources: ['/root/engine.cu'],
  buffers: [
    { name: 'W', length: 3 * G_DIM * G_DIM, fill: { kind: 'random', seed: 23, min: -0.15, max: 0.15 } },
    { name: 'x', length: G_DIM, fill: { kind: 'const', value: 0.1 } },
  ],
  launches: [],
};

/**
 * 黄金值。
 *
 * 交叉验证：逐个提交与 graph 重放跑出来**逐位相同** ——
 * 这正是这一关要证明的事（省的是提交，计算一点没变）。
 */
const GRAPH_GOLDEN = [[0, 0.02064613252878189], [1, -0.011575520969927311], [15, 0.0026778569445014], [31, -0.008708021603524685], [47, 0.01248313020914793], [63, -0.010222419165074825]];

const STAGE_20 = {
  id: 'cuda-graph',
  title: t('CUDA Graph —— 把一步的五次提交合成一次',
    'CUDA Graphs — five submissions per step become one'),
  goal: t(
    [
      '第 17 关末尾留过一个观察：重算版比缓存版慢，**起 kernel 的次数**多了 12.75 倍，',
      '而算力只多了 21.8 倍。这两个数字量级相当，说明提交次数不是个小头。',
      '',
      '解码的处境很特别：每一步的**计算量极小**（一个 token），而 kernel 数量不少',
      '（这一关简化到 5 个，真实的一层 Transformer 有几十个，80 层就是上千个）。',
      '真卡上每次提交有几微秒的固定开销，于是**提交本身成了瓶颈** ——',
      'GPU 大部分时间在等下一个 kernel 被交上来。',
      '',
      'CUDA Graph 解决的就是这个：把一串 launch 录下来，之后一次性提交。',
      '省下来的是**提交开销**，kernel 该干的活一点没少。',
      '',
      '```cuda',
      'cudaStreamBeginCapture(0, cudaStreamCaptureModeGlobal);',
      '  ...一串 kernel...',
      'cudaStreamEndCapture(0, &graph);',
      'cudaGraphInstantiate(&exec, graph, 0);',
      'for (...) cudaGraphLaunch(exec, 0);      // 每次只算一次提交',
      '```',
      '',
      '`engine.cu` 里现在是逐个提交：48 步 × 5 个 kernel = 240 次。',
      '改成捕获一次、重放 48 次。',
      '',
      '**为什么这五个 kernel 都从显存读长度**：graph 录下来的是**捕获那一刻的实参值**。',
      '指针是稳定的地址，重放没问题；而按值传的 `len` 录下来就定死了。',
      '真实引擎为了能用 graph，会把所有随步数变化的量都做成显存里的值 ——',
      '这几个签名就是那么来的。',
      '',
      '```bash',
      'nvcc -o bench engine.cu && ncu ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 结果和逐个提交的版本逐位相同',
      '- 提交次数 ≤ 60（逐个提交是 240）',
      '- block 数一个不少 —— 省的是提交，不是计算',
    ].join('\n'),
    [
      'Stage 17 left an observation: the recomputing version was slower with 12.75x the **kernel',
      'launches** against 21.8x the arithmetic. Those two numbers are comparable, so launches are',
      'not a rounding error.',
      '',
      'Decoding is peculiar: each step does **very little work** (one token) across quite a few',
      'kernels (five here, dozens in a real Transformer layer, thousands across 80 layers). On real',
      'hardware each submission costs a few microseconds of fixed overhead, so **submission itself',
      'becomes the bottleneck** and the GPU spends most of its time waiting to be handed more work.',
      '',
      'CUDA Graphs fix precisely this: record a run of launches, then submit them in one go. What is',
      'saved is the submission overhead; the kernels do exactly as much work as before.',
      '',
      '```cuda',
      'cudaStreamBeginCapture(0, cudaStreamCaptureModeGlobal);',
      '  ...a run of kernels...',
      'cudaStreamEndCapture(0, &graph);',
      'cudaGraphInstantiate(&exec, graph, 0);',
      'for (...) cudaGraphLaunch(exec, 0);      // one submission each',
      '```',
      '',
      '`engine.cu` submits one at a time: 48 steps x 5 kernels = 240. Capture once, replay 48 times.',
      '',
      '**Why all five kernels read the length from device memory**: a graph records the **argument',
      'values at capture time**. Pointers are stable addresses so replay is fine, but a `len` passed',
      'by value is frozen. Real engines make every step-varying quantity device-resident so graphs',
      'can be used at all, and these signatures come from that.',
      '',
      '```bash',
      'nvcc -o bench engine.cu && ncu ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- results bit-identical to the one-at-a-time version',
      '- at most 60 submissions (240 one at a time)',
      '- the same number of blocks: submissions are saved, not computation',
    ].join('\n')
  ),
  checklist: [
    t('在循环外捕获一次这五个 kernel',
      'Capture the five kernels once, outside the loop'),
    t('实例化成 graphExec', 'Instantiate it into a graphExec'),
    t('循环里只 cudaGraphLaunch', 'Only call cudaGraphLaunch inside the loop'),
  ],
  hints: [
    t('捕获期间 kernel **不会执行**，所以捕获这一遍不产生任何结果 —— '
      + '48 步就老老实实重放 48 次。',
      'Kernels do not execute during capture, so the capture pass produces nothing. Replay 48 times '
      + 'for 48 steps.'),
    t('长度住在显存里，`bumpLen` 也在 graph 里 —— 于是每次重放都会往前走一格，'
      + '不需要宿主插手。',
      'The length lives in device memory and `bumpLen` is inside the graph, so each replay advances '
      + 'by one on its own with no host involvement.'),
  ],
  pitfalls: [
    t('**把捕获放进循环里。** 那就变成每步录一张新图，提交次数一次没省，'
      + '还多了捕获与实例化的开销。',
      '**Capturing inside the loop.** That records a fresh graph every step, saves no submissions '
      + 'at all, and adds capture and instantiation costs on top.'),
    t('**忘了长度必须在显存里。** 这个子集的五个 kernel 都收指针，所以踩不到；'
      + '真卡上按值传 `len` 会得到一个安静的错误 —— 程序照跑，结果是拿第一步的长度算了 48 遍。',
      '**Forgetting the length must be device-resident.** The five kernels here all take pointers so '
      + 'you cannot hit it, but on real hardware passing `len` by value fails silently: the program '
      + 'runs fine and computes 48 steps at the first step\'s length.'),
    t('**在捕获区里放 cudaMemcpy 却以为它立刻生效。** 它会被录成图里的一个节点，'
      + '每次重放都重做一遍 —— 这通常正是你要的，但如果你指望"先拷一次初始值"，就错了。',
      '**Putting a cudaMemcpy in the capture and expecting it to happen now.** It becomes a node and '
      + 'reruns on every replay, which is usually what you want, but not if you meant it as a '
      + 'one-off initialisation.'),
  ],
  extension: t(
    'CUDA Graph 是所有推理引擎的标配。vLLM 叫它 CUDA graph capture，'
    + 'TensorRT-LLM 内建，SGLang 有 CUDA graph mode ——'
    + '而它们都有同一个限制：**图是按形状固定的**。'
    + '批大小变了、序列长度跨过某个桶了，就得换一张图。'
    + '于是引擎会预先为若干个批大小各捕获一张（比如 1/2/4/8/16/32），'
    + '运行时挑最接近的那张、把多余的位置填成 padding。'
    + '\n\n'
    + '这也解释了一个现象：连续批处理的批大小往往不是任意数，而是几个固定档位。'
    + '不是调度器不想精确，是 graph 只有那么几张。'
    + '\n\n'
    + '另外注意这一关**没有省下任何计算**：block 数一个不少，'
    + 'FMA 一次不差。省的纯粹是提交开销。'
    + '这也是为什么它对预填充（一次算几千个 token）几乎没用 ——'
    + '那时候每个 kernel 本来就要跑很久，几微秒的提交开销可以忽略。'
    + '**CUDA Graph 是解码专属的优化。**',
    'CUDA Graphs are standard equipment in every inference engine: vLLM calls it CUDA graph capture, '
    + 'TensorRT-LLM builds it in, SGLang has a CUDA graph mode. All of them share one limitation: '
    + '**graphs are fixed by shape.** Change the batch size, or cross a sequence-length bucket, and '
    + 'you need a different graph. So engines capture one per batch size ahead of time (1/2/4/8/16/32 '
    + 'and so on) and at runtime pick the nearest, padding the unused slots.\n\n'
    + 'That explains something you may have noticed: continuous batching tends to use a handful of '
    + 'fixed batch sizes rather than arbitrary ones. The scheduler is not being imprecise; there are '
    + 'only so many graphs.\n\n'
    + 'Note also that this stage saves **no computation at all**: the same blocks, the same FMAs. '
    + 'Only submission overhead. Which is why it does almost nothing for prefill, where each kernel '
    + 'already runs for a long time and a few microseconds of submission is noise. **CUDA Graphs are '
    + 'a decode-side optimisation.**'
  ),
  gpu: {
    files: {
      '/root/engine.cu': code`
        #include "engine.h"
        #include "cuda_runtime.h"

        ${GRAPH_KERNELS}

        int main(void) {
          const int DIM = ${G_DIM};
          const int STEPS = ${G_STEPS};
          float* W = lab_buffer(0);
          float* x = lab_buffer(1);

          float* kCache; float* vCache; float* q; float* k; float* v; float* out;
          int* len;
          cudaMalloc((void**)&kCache, STEPS * DIM * 4);
          cudaMalloc((void**)&vCache, STEPS * DIM * 4);
          cudaMalloc((void**)&q, DIM * 4); cudaMalloc((void**)&k, DIM * 4);
          cudaMalloc((void**)&v, DIM * 4); cudaMalloc((void**)&out, DIM * 4);
          cudaMalloc((void**)&len, 4);
          cudaMemset(len, 0, 4);

          // TODO: 这五个 kernel 每步提交一次，48 步就是 240 次。
          //       捕获成一张 graph，循环里只重放。
          for (int step = 0; step < STEPS; ++step) {
            project<<<1, DIM>>>(x, W, q, k, v, DIM);
            appendKv<<<1, DIM>>>(kCache, vCache, k, v, len, DIM);
            bumpLen<<<1, 32>>>(len);
            attendLen<<<1, 32>>>(q, kCache, vCache, out, len, DIM);
            feedback<<<1, DIM>>>(x, out, DIM);
          }

          cudaFree(kCache); cudaFree(vCache); cudaFree(q);
          cudaFree(k); cudaFree(v); cudaFree(out); cudaFree(len);
          return 0;
        }
      `,
    },
    bench: graphBench,
    referenceFiles: {
      '/root/engine.cu': code`
        #include "engine.h"
        #include "cuda_runtime.h"

        ${GRAPH_KERNELS}

        int main(void) {
          const int DIM = ${G_DIM};
          const int STEPS = ${G_STEPS};
          float* W = lab_buffer(0);
          float* x = lab_buffer(1);

          float* kCache; float* vCache; float* q; float* k; float* v; float* out;
          int* len;
          cudaMalloc((void**)&kCache, STEPS * DIM * 4);
          cudaMalloc((void**)&vCache, STEPS * DIM * 4);
          cudaMalloc((void**)&q, DIM * 4); cudaMalloc((void**)&k, DIM * 4);
          cudaMalloc((void**)&v, DIM * 4); cudaMalloc((void**)&out, DIM * 4);
          cudaMalloc((void**)&len, 4);
          cudaMemset(len, 0, 4);

          // 一步的五个 kernel 录成一张图。**捕获期间它们不执行**，
          // 所以这一遍不产生任何结果，48 步就重放 48 次。
          int graph; int exec;
          cudaStreamBeginCapture(0, cudaStreamCaptureModeGlobal);
          project<<<1, DIM>>>(x, W, q, k, v, DIM);
          appendKv<<<1, DIM>>>(kCache, vCache, k, v, len, DIM);
          bumpLen<<<1, 32>>>(len);
          attendLen<<<1, 32>>>(q, kCache, vCache, out, len, DIM);
          feedback<<<1, DIM>>>(x, out, DIM);
          cudaStreamEndCapture(0, &graph);
          cudaGraphInstantiate(&exec, graph, 0);

          // 长度住在显存里、bumpLen 也在图里，所以每次重放自己往前走一格
          for (int step = 0; step < STEPS; ++step) {
            cudaGraphLaunch(exec, 0);
          }

          cudaGraphExecDestroy(exec);
          cudaGraphDestroy(graph);
          cudaFree(kCache); cudaFree(vCache); cudaFree(q);
          cudaFree(k); cudaFree(v); cudaFree(out); cudaFree(len);
          return 0;
        }
      `,
    },
  },
  specs: [
    spec('engine.spec.ts', code`
      const lab = require('@gpu/lab');
      const GOLDEN = ${JSON.stringify(GRAPH_GOLDEN)};

      describe('CUDA Graph', () => {
        it('结果和逐个提交的版本逐位相同', async () => {
          await lab.buildAndRun();
          const x = lab.buffer('x');
          for (const [index, expected] of GOLDEN) {
            expect(Math.abs(x[index] - expected)).toBeLessThanOrEqual(1e-9);
          }
        });

        it('**提交次数降下来了**', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().launch.kernels).toBeLessThanOrEqual(60);
        });

        it('计算量一点没少 —— 省的是提交，不是活', async () => {
          await lab.buildAndRun();
          // 48 步 × (project 2 warp + appendKv 2 + bumpLen 1 + attend 1 + feedback 2)
          expect(lab.metrics().launch.blocks).toBe(48 * 5);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.launch.kernels', op: 'lte', value: 60,
      zh: '提交到设备的次数（逐个提交是 240）', en: 'submissions to the device (240 one at a time)',
      unit: 'launch', dimension: 'latency',
    }),
    gate({
      metric: 'gpu.launch.blocks', op: 'gte', value: 240,
      zh: 'block 总数 —— 省的是提交不是计算，这个数不能降',
      en: 'blocks launched: submissions are saved, not work, so this must not drop',
      unit: 'block', dimension: 'correctness',
    }),
  ],
  focus: ['latency', 'correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 21 关：连续批处理                                                  */
/* ------------------------------------------------------------------ */

const B_DIM = 32;
const B_SLOTS = 4;
/** 长度差别很大 —— 静态批的痛点全在这里 */
const B_LENGTHS = [40, 3, 25, 5, 60, 4, 18, 6, 33, 2, 50, 8];
const B_TOTAL = B_LENGTHS.reduce((sum, n) => sum + n, 0);

/**
 * 一步一个槽位。
 *
 * `active[slot] == 0` 的槽位直接返回 —— 那是 padding，
 * 真卡上它一样要占着计算资源走完一遍。
 * `progress[req]` 由**平台**记账，学员改不了：
 * 判定要的是「每个请求都被服务到了它该有的步数」，
 * 而这个数只有 kernel 自己数得准。
 */
const BATCH_KERNEL = code`
  __global__ void stepSlot(int* progress, float* state, const int* active,
                           int slot, int req, int dim) {
    int d = threadIdx.x;
    if (active[slot] == 0) return;
    if (d == 0) progress[req] = progress[req] + 1;
    state[slot * dim + d] = state[slot * dim + d] * 1.0009765625f + 0.001f;
  }
`;

const B_LENS = B_LENGTHS.map((n) => `vec_push(lens, ${n});`).join('\n            ');

const batchBench = {
  sources: ['/root/scheduler.cu'],
  buffers: [
    { name: 'state', length: B_SLOTS * B_DIM, fill: { kind: 'const', value: 0.5 } },
    { name: 'progress', length: B_LENGTHS.length, type: 'int', fill: { kind: 'zeros' } },
  ],
  launches: [],
};

const STAGE_21 = {
  id: 'continuous-batching',
  title: t('连续批处理 —— 空出来的槽位立刻补上',
    'Continuous batching — refill a slot the moment it frees'),
  goal: t(
    [
      'GPU 喜欢大批量。可是解码时每条序列**长度差别极大**：',
      '有的两个 token 就结束，有的要生成几百个。',
      '',
      '朴素的做法是**静态批**：凑够 4 条一起跑，等这一批全部结束再收下一批。',
      '于是那条 2 个 token 的请求跑完之后，它的槽位要空转到最长那条结束为止 ——',
      '空转不是免费的，padding 的槽位在真卡上照样占着计算资源走完一遍。',
      '',
      '这 12 个请求的长度是 40 / 3 / 25 / 5 / 60 / 4 / 18 / 6 / 33 / 2 / 50 / 8，',
      '一共 254 个真实的槽位步。静态批要跑 **150 步 × 4 槽 = 600** ——',
      '**58% 花在 padding 上**。',
      '',
      '连续批处理（continuous batching，也叫 in-flight batching）的做法很简单：',
      '**不等整批结束，哪个槽位空了就立刻从队列里取下一个请求塞进去。**',
      '批是流动的，不是一批一批的。',
      '',
      '`scheduler.cu` 现在是静态批。改成连续批：',
      '',
      '1. 请求排成一个队列（`ring`）',
      '2. 每一步开始前先扫一遍槽位，空的就补一个新请求进来',
      '3. 照常跑这一步',
      '',
      '```bash',
      'nvcc -o bench scheduler.cu && ncu ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- **12 个请求一个不漏，每个都跑够它自己的步数**（平台记账，改不了）',
      '- 提交次数 ≤ 400（静态批是 600）',
    ].join('\n'),
    [
      'GPUs like big batches. But during decoding, sequence lengths **vary enormously**: some finish',
      'in two tokens, some generate hundreds.',
      '',
      'The naive approach is **static batching**: gather 4 sequences, run them together, wait for the',
      'whole batch before taking the next. So once that 2-token request finishes, its slot idles',
      'until the longest one is done, and idling is not free: a padded slot still occupies compute on',
      'real hardware for the whole step.',
      '',
      'These 12 requests are 40 / 3 / 25 / 5 / 60 / 4 / 18 / 6 / 33 / 2 / 50 / 8 tokens long, 254',
      'real slot-steps in total. Static batching runs **150 steps x 4 slots = 600**, so **58% goes',
      'to padding**.',
      '',
      'Continuous batching (also called in-flight batching) is simple: **do not wait for the batch;',
      'the moment a slot frees, pull the next request from the queue into it.** The batch flows',
      'rather than proceeding in lockstep.',
      '',
      '`scheduler.cu` is static right now. Make it continuous:',
      '',
      '1. put the requests in a queue (`ring`)',
      '2. before each step, scan the slots and refill any that are empty',
      '3. run the step as before',
      '',
      '```bash',
      'nvcc -o bench scheduler.cu && ncu ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- **all 12 requests served, each for exactly its own number of steps** (counted by the',
      '  platform, not by you)',
      '- at most 400 submissions (600 static)',
    ].join('\n')
  ),
  checklist: [
    t('用 ring 排队等待的请求', 'Queue the waiting requests in a `ring`'),
    t('每一步开始前把空槽位补上', 'Refill empty slots before each step'),
    t('槽位空了就立刻补，不等整批结束', 'Refill as soon as a slot frees, not after the batch'),
  ],
  hints: [
    t('每个槽位记两件事：**还剩几步**，以及**在跑哪个请求**。'
      + '补位时两个一起换。',
      'Track two things per slot: **steps remaining** and **which request is in it**. Refill swaps '
      + 'both at once.'),
    t('队列空了之后还有槽位在跑 —— 那时候补不了位，剩下的照常跑完。'
      + '所以循环的结束条件是「所有槽位都空且队列也空」。',
      'Once the queue empties some slots are still running and cannot be refilled; let them finish. '
      + 'So the loop ends when every slot is empty and the queue is too.'),
  ],
  pitfalls: [
    t('**补位时忘了换请求号。** 步数对了，但记账全记到上一个请求头上 ——'
      + '于是有的请求"跑了两倍的步数"，有的一步没跑。这一关的判定专抓这个。',
      '**Refilling the step count but not the request id.** The steps are right but the accounting '
      + 'all lands on the previous request, so some appear to run twice as long and others not at '
      + 'all. The check here is built to catch exactly this.'),
    t('**只在整批空了才补位。** 那还是静态批，只是写法绕了一圈。'
      + '补位要在**每一步**开始前做。',
      '**Only refilling when the whole batch is empty.** That is still static batching with extra '
      + 'steps. Refill before **every** step.'),
    t('**队列空了之后死循环。** 结束条件要同时看槽位和队列，'
      + '只看队列的话最后几条序列还没跑完就退出了。',
      '**Looping forever once the queue is empty.** The exit condition must consider both slots and '
      + 'queue; checking only the queue exits while the last sequences are still running.'),
  ],
  extension: t(
    '连续批处理是 Orca 那篇论文（OSDI 2022）提出的，'
    + '现在 vLLM、TensorRT-LLM、SGLang 全都是这么做的。'
    + 'TensorRT-LLM 管它叫 in-flight batching，名字不同东西一样。'
    + '\n\n'
    + '它和第 18 关的分页 KV 是一对：**连续批处理让批一直是满的，'
    + '分页 KV 让满的批装得下**。'
    + '没有分页，每条序列按最长上下文预留显存，同时能装的序列数很少，'
    + '连续批处理也就没多少可调度的余地了。vLLM 的吞吐提升是这两件事一起来的。'
    + '\n\n'
    + '真实调度器要处理的事比这一关多得多：预填充和解码要不要混在同一批里'
    + '（chunked prefill）、显存不够时抢占谁（vLLM 的 preemption 会把一条序列的'
    + 'KV 换出去、之后重算或换回来）、怎么保证长请求不被饿死、'
    + '以及第 20 关提到的那个约束 —— **批大小只能是 CUDA Graph 预先捕获过的那几档**，'
    + '所以调度器挑的往往不是"最优的批"，而是"最接近某一档的批"。'
    + '\n\n'
    + '还有一个这一关量不出来但很重要的事：连续批处理改善的是**吞吐**，'
    + '对单个请求的**延迟**可能是负面的 —— 你的请求会和更多别人的请求挤在一起。'
    + '所以生产里通常同时盯 TTFT（首 token 时延）与 TPOT（每 token 时延）两条线，'
    + '而不是只看吞吐。',
    'Continuous batching came from the Orca paper (OSDI 2022) and is now how vLLM, TensorRT-LLM and '
    + 'SGLang all work. TensorRT-LLM calls it in-flight batching; same thing, different name.\n\n'
    + 'It pairs with paged KV from stage 18: **continuous batching keeps the batch full, paging '
    + 'makes a full batch fit.** Without paging, each sequence reserves memory for its maximum '
    + 'context, few fit at once, and there is little left to schedule. vLLM\'s throughput gain comes '
    + 'from both together.\n\n'
    + 'Real schedulers handle far more: whether to mix prefill and decode in one batch (chunked '
    + 'prefill), whom to preempt when memory runs out (vLLM swaps a sequence\'s KV out and either '
    + 'recomputes or swaps it back), how to keep long requests from starving, and the constraint '
    + 'from stage 20 that **batch sizes must be ones a CUDA Graph was captured for**, so the '
    + 'scheduler usually picks not the optimal batch but the one nearest a captured size.\n\n'
    + 'One more thing this stage cannot measure but that matters: continuous batching improves '
    + '**throughput** and can hurt an individual request\'s **latency**, since your request now '
    + 'shares the GPU with more of everyone else\'s. Production systems therefore watch TTFT (time '
    + 'to first token) and TPOT (time per output token) alongside throughput, not throughput alone.'
  ),
  gpu: {
    files: {
      '/root/scheduler.cu': code`
        #include "engine.h"
        #include "containers.h"

        ${BATCH_KERNEL}

        int main(void) {
          const int DIM = ${B_DIM};
          const int SLOTS = ${B_SLOTS};
          const int N = ${B_LENGTHS.length};

          int lens = vec_new();
          ${B_LENS}

          float* state = lab_buffer(0);
          int* progress;
          cudaMalloc((void**)&progress, N * 4);
          cudaMemset(progress, 0, N * 4);

          int* active;
          cudaMalloc((void**)&active, SLOTS * 4);
          int host[4];

          // TODO: 静态批 —— 凑够一批跑到全部结束，再收下一批。
          //       改成连续批：哪个槽位空了就立刻从队列里补一个进来。
          int next = 0;
          while (next < N) {
            int remain = vec_new();
            int who = vec_new();
            for (int s = 0; s < SLOTS; ++s) {
              if (next < N) {
                vec_push(remain, vec_get(lens, next));
                vec_push(who, next);
                next += 1;
              } else {
                vec_push(remain, 0);
                vec_push(who, 0);
              }
            }

            int alive = 1;
            while (alive == 1) {
              alive = 0;
              for (int s = 0; s < SLOTS; ++s) {
                host[s] = vec_get(remain, s) > 0 ? 1 : 0;
                if (host[s] == 1) { alive = 1; }
              }
              if (alive == 0) { break; }
              cudaMemcpy(active, host, SLOTS * 4, cudaMemcpyHostToDevice);
              for (int s = 0; s < SLOTS; ++s) {
                stepSlot<<<1, DIM>>>(progress, state, active, s, vec_get(who, s), DIM);
              }
              for (int s = 0; s < SLOTS; ++s) {
                int r = vec_get(remain, s);
                if (r > 0) vec_set(remain, s, r - 1);
              }
            }
          }

          // 把记账拷回平台准备的缓冲区
          cudaMemcpy(lab_buffer(1), progress, N * 4, cudaMemcpyDeviceToDevice);
          cudaFree(progress);
          cudaFree(active);
          return 0;
        }
      `,
    },
    bench: batchBench,
    referenceFiles: {
      '/root/scheduler.cu': code`
        #include "engine.h"
        #include "containers.h"

        ${BATCH_KERNEL}

        int main(void) {
          const int DIM = ${B_DIM};
          const int SLOTS = ${B_SLOTS};
          const int N = ${B_LENGTHS.length};

          int lens = vec_new();
          ${B_LENS}

          float* state = lab_buffer(0);
          int* progress;
          cudaMalloc((void**)&progress, N * 4);
          cudaMemset(progress, 0, N * 4);

          int* active;
          cudaMalloc((void**)&active, SLOTS * 4);
          int host[4];

          // 等待的请求排成一个队列
          int queue = ring_new();
          for (int i = 0; i < N; ++i) ring_push(queue, i);

          // 每个槽位记两件事：还剩几步、在跑哪个请求
          int remain = vec_new();
          int who = vec_new();
          for (int s = 0; s < SLOTS; ++s) { vec_push(remain, 0); vec_push(who, 0); }

          int alive = 1;
          while (alive == 1) {
            alive = 0;

            // 补位：空槽立刻取下一个请求。**两件事一起换** ——
            // 只换步数不换请求号，记账就全记到上一个请求头上了
            for (int s = 0; s < SLOTS; ++s) {
              if (vec_get(remain, s) == 0) {
                if (ring_len(queue) > 0) {
                  int req = ring_pop(queue);
                  vec_set(who, s, req);
                  vec_set(remain, s, vec_get(lens, req));
                }
              }
            }

            for (int s = 0; s < SLOTS; ++s) {
              host[s] = vec_get(remain, s) > 0 ? 1 : 0;
              if (host[s] == 1) { alive = 1; }
            }
            // 槽位全空且队列也空，才是真的结束
            if (alive == 0) { break; }

            cudaMemcpy(active, host, SLOTS * 4, cudaMemcpyHostToDevice);
            for (int s = 0; s < SLOTS; ++s) {
              stepSlot<<<1, DIM>>>(progress, state, active, s, vec_get(who, s), DIM);
            }
            for (int s = 0; s < SLOTS; ++s) {
              int r = vec_get(remain, s);
              if (r > 0) vec_set(remain, s, r - 1);
            }
          }

          cudaMemcpy(lab_buffer(1), progress, N * 4, cudaMemcpyDeviceToDevice);
          cudaFree(progress);
          cudaFree(active);
          return 0;
        }
      `,
    },
  },
  specs: [
    spec('scheduler.spec.ts', code`
      const lab = require('@gpu/lab');
      const LENGTHS = ${JSON.stringify(B_LENGTHS)};
      const TOTAL = ${B_TOTAL};

      describe('连续批处理', () => {
        it('**12 个请求一个不漏，每个都跑够它自己的步数**', async () => {
          await lab.buildAndRun();
          const progress = lab.bufferInts('progress');
          expect(Array.from(progress)).toEqual(LENGTHS);
        });

        it('真实工作量没变 —— 省的是 padding', async () => {
          await lab.buildAndRun();
          const progress = lab.bufferInts('progress');
          const done = Array.from(progress).reduce((sum, n) => sum + n, 0);
          expect(done).toBe(TOTAL);
        });

        it('提交次数降下来了', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().launch.kernels).toBeLessThanOrEqual(400);
        });

        it('padding 的比例降到三成以下', async () => {
          await lab.buildAndRun();
          // 每次提交就是一个槽位一步，其中只有 TOTAL 次是真活
          const submitted = lab.metrics().launch.kernels;
          expect(1 - TOTAL / submitted).toBeLessThan(0.3);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.launch.kernels', op: 'lte', value: 400,
      zh: '提交次数（静态批是 600，其中 58% 是 padding）',
      en: 'submissions (600 static, 58% of it padding)',
      unit: 'launch', dimension: 'throughput',
    }),
  ],
  focus: ['throughput', 'correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 22 关：手写 ring all-reduce                                        */
/* ------------------------------------------------------------------ */

const R_DEVICES = 8;
const R_COUNT = 64;

/**
 * 集群关卡共用的世界覆盖：一台 8 卡机。
 *
 * 按关覆盖而不是改整个项目 —— 前 21 关是单卡的，
 * 让它们白白多出七张空转的卡没有任何好处。
 */
const CLUSTER_WORLD = {
  globalBytes: 4 * 1024 * 1024,
  cluster: { devices: R_DEVICES, devicesPerNode: 8 },
};

const RING_KERNELS = code`
  __global__ void fill(float* a, float base, int n) {
    int i = threadIdx.x;
    if (i < n) a[i] = base + (float)i * 0.01f;
  }
  __global__ void addInto(float* a, const float* b, int n) {
    int i = threadIdx.x;
    if (i < n) a[i] = a[i] + b[i];
  }
  // 只加一段：ring 每一步只碰缓冲区的 1/n
  __global__ void addRange(float* dst, const float* src, int offset, int n) {
    int i = threadIdx.x;
    if (i < n) dst[offset + i] = dst[offset + i] + src[offset + i];
  }
  __global__ void copyRange(float* dst, const float* src, int offset, int n) {
    int i = threadIdx.x;
    if (i < n) dst[offset + i] = src[offset + i];
  }
`;

const ringBench = {
  sources: ['/root/allreduce.cu'],
  buffers: [
    // 判定从这里读结果：每张卡把自己的第 0 个元素写回来
    { name: 'check', length: R_DEVICES, fill: { kind: 'zeros' } },
  ],
  launches: [],
};

const STAGE_22 = {
  id: 'ring-allreduce',
  title: t('手写 ring all-reduce —— 把 2(n-1)/n 数出来',
    'Ring all-reduce by hand — count the 2(n-1)/n yourself'),
  goal: t(
    [
      '从这一关开始是 8 张卡。',
      '',
      '数据并行的每一步都要做一次 **all-reduce**：每张卡各算出一份梯度，',
      '加起来，然后人人都要拿到这个和。',
      '',
      '`allreduce.cu` 现在的做法最直白：**所有卡把自己的整份发给 0 号，',
      '0 号加完再广播回去。** 结果是对的，但 0 号卡成了瓶颈 ——',
      '它一张卡要过 `2(n-1) × 缓冲区` 的量，而别的卡只过 `2 × 缓冲区`。',
      '',
      'ring all-reduce 把这件事摊开。它分两个阶段，每个阶段 n-1 步：',
      '',
      '1. **reduce-scatter**：把缓冲区切成 n 块。第 k 步，每张卡把某一块',
      '   发给右邻居、把收到的那块加进自己的。走完 n-1 步，',
      '   每张卡手上有**一块完整的和**（不同的卡拿到不同的块）。',
      '2. **all-gather**：再转 n-1 步，把这 n 块和转一圈，人人拿全。',
      '',
      '每一步只搬 `1/n` 个缓冲区，一共 `2(n-1)` 步 ——',
      '**每张卡搬的总量因此是 `2(n-1)/n × 缓冲区`。**',
      '这个数记住，下一关会再见到它。',
      '',
      '```bash',
      'nvcc -o bench allreduce.cu && ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 8 张卡都拿到正确的和',
      '- 最忙那张卡过的字节数 ≤ 1200（朴素版是 3584）',
      '- **恰好 `2(n-1) × n = 112` 条消息** —— 步数要对得上',
    ].join('\n'),
    [
      'From here on there are 8 GPUs.',
      '',
      'Every step of data parallelism needs an **all-reduce**: each GPU computes its own gradients,',
      'they are summed, and everyone needs the sum.',
      '',
      '`allreduce.cu` does the obvious thing: **every GPU sends its whole buffer to GPU 0, which',
      'sums and broadcasts back.** The result is right, but GPU 0 is the bottleneck: it alone moves',
      '`2(n-1) x buffer` while every other GPU moves only `2 x buffer`.',
      '',
      'Ring all-reduce spreads that out, in two phases of n-1 steps each:',
      '',
      '1. **reduce-scatter**: split the buffer into n chunks. On step k each GPU sends one chunk to',
      '   its right neighbour and adds the chunk it receives into its own. After n-1 steps each GPU',
      '   holds **one fully reduced chunk** (a different one per GPU).',
      '2. **all-gather**: another n-1 steps pass those n chunks around so everyone has all of them.',
      '',
      'Each step moves `1/n` of a buffer across `2(n-1)` steps, so **each GPU moves',
      '`2(n-1)/n x buffer` in total.** Remember that number; it comes back next stage.',
      '',
      '```bash',
      'nvcc -o bench allreduce.cu && ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- all 8 GPUs hold the correct sum',
      '- the busiest GPU moves at most 1200 bytes (3584 naive)',
      '- **exactly `2(n-1) x n = 112` messages**: the step count has to match',
    ].join('\n')
  ),
  checklist: [
    t('把缓冲区切成 n 块', 'Split the buffer into n chunks'),
    t('reduce-scatter：n-1 步，每步发一块给右邻居并加进来',
      'reduce-scatter: n-1 steps, each sending a chunk right and adding what arrives'),
    t('all-gather：再 n-1 步，把结果转一圈',
      'all-gather: another n-1 steps to pass the results around'),
  ],
  hints: [
    t('第 d 张卡在第 step 步发的是第 `(d - step + n) % n` 块，'
      + '收到的是第 `(d - 1 - step + n) % n` 块。索引绕圈是这一关唯一的难点，'
      + '拿 4 张卡在纸上画一遍最快。',
      'On step `step`, GPU d sends chunk `(d - step + n) % n` and receives chunk '
      + '`(d - 1 - step + n) % n`. The wrap-around indexing is the only hard part; drawing it out '
      + 'for 4 GPUs is the fastest way through.'),
    t('all-gather 阶段发的是第 `(d + 1 - step + n) % n` 块 —— '
      + 'reduce-scatter 结束时第 d 张卡手上完整的正是第 `(d + 1) % n` 块。',
      'In the all-gather phase GPU d sends chunk `(d + 1 - step + n) % n`, because reduce-scatter '
      + 'leaves GPU d holding chunk `(d + 1) % n` complete.'),
    t('每张卡要一个额外的接收缓冲区 —— 不能收进正在发的那块里。',
      'Each GPU needs a separate receive buffer; you cannot receive into the chunk you are sending.'),
  ],
  pitfalls: [
    t('**先收后发，或者边发边加。** 8 张卡是同时动的：这一步所有卡都发完，'
      + '才轮到所有卡去加。混在一个循环里会读到已经被覆盖的数据。',
      '**Receiving before sending, or adding while still sending.** All 8 GPUs move together: every '
      + 'send in a step completes before any add. Mixing them in one loop reads data that has '
      + 'already been overwritten.'),
    t('**收进正在发的那块。** 需要一个独立的接收缓冲区，'
      + '否则发出去的和收进来的会撞在一起。',
      '**Receiving into the chunk being sent.** A separate receive buffer is required, or the '
      + 'outgoing and incoming data collide.'),
    t('**all-gather 阶段用了 addRange 而不是 copyRange。** 那一阶段是"把结果转一圈"，'
      + '不是再加一遍 —— 加的话每个值会被多加好几次，而且错得很规律，'
      + '看起来像是"少乘了个系数"。',
      '**Using addRange instead of copyRange in the all-gather phase.** That phase passes results '
      + 'around, it does not reduce again. Adding makes every value accumulate several extra times, '
      + 'in a regular-looking way that reads like a missing scale factor.'),
  ],
  extension: t(
    '有一件事值得盯着看：**ring 并没有减少搬运的总量。**'
    + '朴素版一共搬 3584 字节，ring 也搬 3584 字节，一个字节不差。'
    + '差别全在**分布**：朴素版这 3584 字节全压在 0 号卡的端口上，'
    + 'ring 让 8 张卡各扛 896。瓶颈差 4 倍，而且这个倍数是 `n/2` —— '
    + '卡越多，差得越远。'
    + '\n\n'
    + '代价也看得见：消息数从 14 涨到 112，**多了 8 倍**。'
    + '每条消息都有固定开销，所以缓冲区小的时候 ring 反而更慢 ——'
    + '这正是 NCCL 对小消息改用 tree 算法的原因。'
    + 'NCCL 会按消息大小、卡数、拓扑自动选算法，'
    + '而它选的那套逻辑，前提就是你现在数出来的这两个量。'
    + '\n\n'
    + '最后，你刚刚数出来的 `2(n-1)/n` 就是 nccl-tests 里 all-reduce 的 **busbw 修正因子**。'
    + '算法带宽 `algbw = 缓冲区字节数 / 耗时` 是用户视角，'
    + '总线带宽 `busbw = algbw × 2(n-1)/n` 才反映硬件实际搬了多少。'
    + '下一关起所有的通信门槛都读 busbw —— 而对你来说它不是一个公式，'
    + '是你刚数出来的步数。',
    'One thing is worth staring at: **ring does not reduce the total bytes moved.** The naive version '
    + 'moves 3584 bytes and so does the ring, exactly. The difference is entirely in the '
    + '**distribution**: naive puts all 3584 through GPU 0\'s port, ring gives each of 8 GPUs 896. '
    + 'The bottleneck improves 4x, and that factor is `n/2`, so it grows with the cluster.\n\n'
    + 'The cost is visible too: messages go from 14 to 112, **eight times more**. Every message has '
    + 'fixed overhead, so for small buffers the ring is actually slower. That is exactly why NCCL '
    + 'switches to tree algorithms for small messages. NCCL picks an algorithm from message size, '
    + 'GPU count and topology, and the logic it uses rests on the two quantities you just counted.\n\n'
    + 'Finally, the `2(n-1)/n` you just counted is the **busbw correction factor** for all-reduce in '
    + 'nccl-tests. Algorithm bandwidth `algbw = buffer bytes / time` is the user\'s view; bus '
    + 'bandwidth `busbw = algbw x 2(n-1)/n` reflects what the hardware actually moved. Every '
    + 'communication gate from here on reads busbw, and for you it is not a formula but a step count '
    + 'you derived.'
  ),
  gpu: {
    world: CLUSTER_WORLD,
    files: {
      '/root/allreduce.cu': code`
        #include "engine.h"
        #include "cluster.h"

        ${RING_KERNELS}

        int main(void) {
          const int N = ${R_DEVICES};
          const int COUNT = ${R_COUNT};

          int buf[8]; int tmp[8];
          for (int d = 0; d < N; ++d) {
            cudaSetDevice(d);
            float* b; float* t;
            cudaMalloc((void**)&b, COUNT * 4);
            cudaMalloc((void**)&t, COUNT * 4);
            fill<<<1, 64>>>(b, (float)(d + 1), COUNT);
            buf[d] = b; tmp[d] = t;
          }

          // TODO: 朴素做法 —— 全都发给 0 号，0 号加完再广播回去。
          //       0 号卡一张要过 2(n-1) 份，而别的卡只过 2 份。
          //       改成 ring：reduce-scatter (n-1) 步 + all-gather (n-1) 步。
          for (int d = 1; d < N; ++d) {
            cudaMemcpyPeer(tmp[0], 0, buf[d], d, COUNT * 4);
            cudaSetDevice(0);
            addInto<<<1, 64>>>(buf[0], tmp[0], COUNT);
          }
          for (int d = 1; d < N; ++d) {
            cudaMemcpyPeer(buf[d], d, buf[0], 0, COUNT * 4);
          }

          // 把每张卡的第 0 个元素写回平台的缓冲区，判定读它
          float* check = lab_buffer(0);
          float host[8];
          for (int d = 0; d < N; ++d) {
            cudaSetDevice(d);
            float one[1];
            cudaMemcpy(one, buf[d], 4, cudaMemcpyDeviceToHost);
            host[d] = one[0];
          }
          cudaSetDevice(0);
          cudaMemcpy(check, host, N * 4, cudaMemcpyHostToDevice);
          return 0;
        }
      `,
    },
    bench: ringBench,
    referenceFiles: {
      '/root/allreduce.cu': code`
        #include "engine.h"
        #include "cluster.h"

        ${RING_KERNELS}

        int main(void) {
          const int N = ${R_DEVICES};
          const int COUNT = ${R_COUNT};
          const int CHUNK = COUNT / N;

          int buf[8]; int tmp[8];
          for (int d = 0; d < N; ++d) {
            cudaSetDevice(d);
            float* b; float* t;
            cudaMalloc((void**)&b, COUNT * 4);
            cudaMalloc((void**)&t, COUNT * 4);
            fill<<<1, 64>>>(b, (float)(d + 1), COUNT);
            buf[d] = b; tmp[d] = t;
          }

          // 阶段一：reduce-scatter。
          // **先所有卡都发完，再所有卡去加** —— 8 张卡是同时动的，
          // 混在一个循环里会读到已经被覆盖的数据。
          for (int step = 0; step < N - 1; ++step) {
            for (int d = 0; d < N; ++d) {
              int sendIdx = (d - step + N) % N;
              int to = (d + 1) % N;
              cudaMemcpyPeer(tmp[to] + sendIdx * CHUNK, to,
                             buf[d] + sendIdx * CHUNK, d, CHUNK * 4);
            }
            for (int d = 0; d < N; ++d) {
              int recvIdx = (d - 1 - step + N) % N;
              cudaSetDevice(d);
              addRange<<<1, 8>>>(buf[d], tmp[d], recvIdx * CHUNK, CHUNK);
            }
          }

          // 阶段二：all-gather。这时第 d 张卡手上完整的是第 (d + 1) % N 块。
          // 这一阶段是把结果**转一圈**，不是再加一遍 —— 所以用 copyRange
          for (int step = 0; step < N - 1; ++step) {
            for (int d = 0; d < N; ++d) {
              int sendIdx = (d + 1 - step + N) % N;
              int to = (d + 1) % N;
              cudaMemcpyPeer(tmp[to] + sendIdx * CHUNK, to,
                             buf[d] + sendIdx * CHUNK, d, CHUNK * 4);
            }
            for (int d = 0; d < N; ++d) {
              int recvIdx = (d - step + N) % N;
              cudaSetDevice(d);
              copyRange<<<1, 8>>>(buf[d], tmp[d], recvIdx * CHUNK, CHUNK);
            }
          }

          float* check = lab_buffer(0);
          float host[8];
          for (int d = 0; d < N; ++d) {
            cudaSetDevice(d);
            float one[1];
            cudaMemcpy(one, buf[d], 4, cudaMemcpyDeviceToHost);
            host[d] = one[0];
          }
          cudaSetDevice(0);
          cudaMemcpy(check, host, N * 4, cudaMemcpyHostToDevice);
          return 0;
        }
      `,
    },
  },
  specs: [
    spec('allreduce.spec.ts', code`
      const lab = require('@gpu/lab');
      const N = ${R_DEVICES};
      const COUNT = ${R_COUNT};

      describe('ring all-reduce', () => {
        it('8 张卡都拿到正确的和', async () => {
          await lab.buildAndRun();
          const check = lab.buffer('check');
          // 第 d 张卡的第 0 个元素是 d + 1，加起来是 1+2+...+8 = 36
          for (let d = 0; d < N; d += 1) {
            expect(Math.abs(check[d] - 36)).toBeLessThanOrEqual(1e-5);
          }
        });

        it('**最忙那张卡的负担降下来了**', async () => {
          await lab.buildAndRun();
          expect(lab.comm().maxDeviceBytes).toBeLessThanOrEqual(1200);
        });

        it('搬运总量一点没变 —— ring 摊的是分布，不是总量', async () => {
          await lab.buildAndRun();
          // 2(n-1) 步 × n 张卡 × (缓冲区/n) = 2(n-1) × 缓冲区
          expect(lab.comm().bytes).toBe(2 * (N - 1) * COUNT * 4);
        });

        it('恰好 2(n-1) × n 条消息 —— 步数要对得上', async () => {
          await lab.buildAndRun();
          expect(lab.comm().messages).toBe(2 * (N - 1) * N);
        });

        it('全在机内，一个字节都不该走 IB', async () => {
          await lab.buildAndRun();
          expect(lab.comm().bytesByLink.ib).toBe(0);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.comm.maxDeviceBytes', op: 'lte', value: 1200,
      zh: '最忙那张卡过的字节数（朴素版是 3584）',
      en: 'bytes through the busiest GPU (3584 naive)',
      unit: 'byte', dimension: 'throughput',
    }),
    gate({
      metric: 'gpu.comm.bytesByLink.ib', op: 'lte', value: 0,
      zh: '走 IB 的字节数 —— 8 张卡在同一台机器里，不该有',
      en: 'bytes over InfiniBand: all 8 GPUs are in one node, so there should be none',
      unit: 'byte', dimension: 'correctness',
    }),
  ],
  focus: ['throughput', 'correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 23 关：NCCL 与数据并行                                             */
/* ------------------------------------------------------------------ */

/** 32 个"层"的梯度，大小差别很大 —— 真模型就是这样 */
const DP_SIZES = [64, 8, 8, 128, 4, 4, 64, 8, 8, 256, 4, 4, 64, 8, 8, 128, 4, 4, 64, 8, 8, 256, 4, 4, 64, 8, 8, 128, 4, 4, 64, 8];
const DP_TOTAL = 1408;
const DP_DEVICES = 8;

const DP_KERNELS = code`
  __global__ void fill(float* a, float v, int n) {
    int i = threadIdx.x;
    if (i < n) a[i] = v;
  }
`;

const DP_DECL = DP_SIZES.map((n) => `vec_push(sizes, ${n});`).join('\n            ');

const dpBench = {
  sources: ['/root/dataparallel.cu'],
  buffers: [
    { name: 'check', length: DP_DEVICES, fill: { kind: 'zeros' } },
  ],
  launches: [],
};

const STAGE_23 = {
  id: 'nccl-data-parallel',
  title: t('NCCL 与数据并行 —— 梯度分桶', 'NCCL and data parallelism — gradient bucketing'),
  goal: t(
    [
      '上一关你手写了 ring all-reduce。真实工程里当然不这么干 —— 用 NCCL。',
      '',
      '```cuda',
      'int comms[8];',
      'ncclCommInitAll(comms, 8);',
      '',
      'ncclGroupStart();',
      'for (int d = 0; d < 8; ++d) {',
      '  ncclAllReduce(send[d], recv[d], n, ncclFloat, ncclSum, comms[d], 0);',
      '}',
      'ncclGroupEnd();',
      '```',
      '',
      '**`ncclGroupStart` / `ncclGroupEnd` 不是可选的。** 单线程管多张卡时，',
      '每个 NCCL 调用都可能阻塞在等对端上，不成组就会死锁 ——',
      '这是 NVIDIA 文档里明写的。这个工作台不成组会直接报错，',
      '而不是让你跑出一个看似正常的结果。',
      '',
      '现在的问题在别处。数据并行的反向传播算完之后，要把 32 层的梯度都 all-reduce 一遍。',
      '`dataparallel.cu` 现在是**每层各发一次** —— 32 次集合操作。',
      '而这些层的梯度大小差别极大：有 256 个元素的，也有只有 4 个的。',
      '',
      '为 4 个 float 发一次 all-reduce，等于为了 16 字节的数据付一整套',
      'ring 的固定开销（8 张卡 × 14 步 = 112 条消息）。',
      '',
      '解法是**分桶**：攒够一定大小再发一次。',
      '把连续的层攒到 ≥ 128 个元素再 all-reduce，32 次就变成 6 次。',
      '',
      '```bash',
      'nvcc -o bench dataparallel.cu && ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 8 张卡都拿到正确的和',
      '- 消息数 ≤ 800（逐层发是 3584）',
      '- 搬运总量不变 —— 分桶省的是每消息开销，不是字节',
    ].join('\n'),
    [
      'Last stage you wrote ring all-reduce by hand. Real engineering does not do that; it uses NCCL.',
      '',
      '```cuda',
      'int comms[8];',
      'ncclCommInitAll(comms, 8);',
      '',
      'ncclGroupStart();',
      'for (int d = 0; d < 8; ++d) {',
      '  ncclAllReduce(send[d], recv[d], n, ncclFloat, ncclSum, comms[d], 0);',
      '}',
      'ncclGroupEnd();',
      '```',
      '',
      '**`ncclGroupStart` / `ncclGroupEnd` are not optional.** With one thread driving several GPUs,',
      'every NCCL call can block waiting on a peer, and without grouping you deadlock. NVIDIA\'s docs',
      'say so explicitly. This workbench errors out rather than producing a plausible-looking result.',
      '',
      'The problem here is elsewhere. After a data-parallel backward pass, all 32 layers of gradients',
      'need all-reducing. `dataparallel.cu` currently sends **one per layer**, 32 collectives. Those',
      'layers vary enormously: some have 256 elements, some only 4.',
      '',
      'Issuing an all-reduce for 4 floats means paying a full ring\'s fixed overhead (8 GPUs x 14',
      'steps = 112 messages) to move 16 bytes.',
      '',
      'The fix is **bucketing**: accumulate until you have enough, then send once. Batching',
      'consecutive layers up to at least 128 elements turns 32 collectives into 6.',
      '',
      '```bash',
      'nvcc -o bench dataparallel.cu && ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- all 8 GPUs hold the correct sum',
      '- at most 800 messages (3584 per-layer)',
      '- the same total bytes: bucketing saves per-message overhead, not bytes',
    ].join('\n')
  ),
  checklist: [
    t('攒够 128 个元素再发一次 all-reduce',
      'Accumulate at least 128 elements before issuing an all-reduce'),
    t('最后一桶不管攒够没有都要发出去',
      'Flush the last bucket whether or not it reached the threshold'),
    t('集合操作放在 ncclGroupStart / ncclGroupEnd 之间',
      'Keep the collectives between ncclGroupStart and ncclGroupEnd'),
  ],
  hints: [
    t('梯度在显存里是连着放的，所以一桶就是一段连续区间 —— '
      + '记住这一桶的起点和已攒的长度，发一次 all-reduce 就够。',
      'Gradients are contiguous in memory, so a bucket is one contiguous range: track the bucket '
      + 'start and the accumulated length, and one all-reduce covers it.'),
    t('别忘了循环结束后还有没发出去的一桶。',
      'Do not forget the partial bucket left over after the loop.'),
  ],
  pitfalls: [
    t('**漏发最后一桶。** 前 31 层都对，最后几层的梯度没同步 —— '
      + '训练会照常收敛，只是慢一点、而且各卡的模型悄悄分叉了。'
      + '这类错误在真实训练里能藏好几天。',
      '**Dropping the last bucket.** The first 31 layers are fine and the last few never sync. '
      + 'Training still converges, just slightly worse, while the replicas silently diverge. This '
      + 'kind of bug hides for days in real training runs.'),
    t('**每桶都开一次 group。** 那是对的但没必要；真正的错是**在 group 里只发一张卡的**，'
      + '那样别的卡永远等不到人。',
      '**Opening a group per bucket.** That is fine but unnecessary. The actual mistake is issuing '
      + 'the collective for only one GPU inside a group, leaving the others waiting forever.'),
  ],
  extension: t(
    '分桶在 PyTorch 的 DDP 里是默认行为，桶大小的默认值是 **25 MiB**（`bucket_cap_mb`）。'
    + '这个数字不是拍脑袋 —— 它要同时满足两头：'
    + '大到让每消息开销可以忽略，又小到不至于让第一桶等太久才凑齐。'
    + '\n\n'
    + '还有一个更妙的细节：**DDP 是按参数的反向顺序分桶的。**'
    + '因为反向传播是从最后一层往前算的，最后一层的梯度最先就绪。'
    + '按正向顺序分桶的话，第一个桶要等到反向传播快结束才凑齐；'
    + '按反向顺序，第一个桶在反向刚开始不久就能发出去 ——'
    + '于是通信和剩下的反向计算重叠起来了。这是第 27 关的内容。'
    + '\n\n'
    + '再看一眼这一关的数字：分桶前后**搬运总量一个字节不差**，'
    + '差的全是消息数（3584 → 672）。这和第 22 关的观察正好互补：'
    + '上一关是"总量不变、分布变了"，这一关是"总量不变、消息数变了"。'
    + '通信优化几乎从来不是"少搬点数据"。',
    'Bucketing is the default in PyTorch DDP, where the bucket size defaults to **25 MiB** '
    + '(`bucket_cap_mb`). That number is not arbitrary: it has to be large enough that per-message '
    + 'overhead vanishes and small enough that the first bucket does not wait too long to fill.\n\n'
    + 'There is a neater detail: **DDP buckets in reverse parameter order.** Backpropagation runs '
    + 'from the last layer backwards, so the last layer\'s gradients are ready first. Bucketing in '
    + 'forward order would leave the first bucket waiting until backward is nearly done; in reverse '
    + 'order it can be sent shortly after backward starts, overlapping communication with the rest '
    + 'of the backward pass. That is stage 27.\n\n'
    + 'Look again at the numbers here: total bytes moved are **identical** before and after, and only '
    + 'the message count changes (3584 to 672). This complements stage 22 exactly. There it was '
    + '"same total, different distribution"; here it is "same total, fewer messages". Communication '
    + 'optimisation is almost never about moving less data.'
  ),
  gpu: {
    world: CLUSTER_WORLD,
    files: {
      '/root/dataparallel.cu': code`
        #include "engine.h"
        #include "cluster.h"
        #include "containers.h"
        #include "nccl.h"

        ${DP_KERNELS}

        int main(void) {
          const int N = ${DP_DEVICES};
          const int LAYERS = ${DP_SIZES.length};
          const int TOTAL = ${DP_TOTAL};

          // 每一"层"的梯度有多少个元素
          int sizes = vec_new();
          ${DP_DECL}

          int comms[8];
          ncclCommInitAll(comms, N, 0);

          int grad[8]; int out[8];
          for (int d = 0; d < N; ++d) {
            cudaSetDevice(d);
            float* g; float* o;
            cudaMalloc((void**)&g, TOTAL * 4);
            cudaMalloc((void**)&o, TOTAL * 4);
            fill<<<1, 64>>>(g, (float)(d + 1), 64);
            grad[d] = g; out[d] = o;
          }

          // TODO: 每层各发一次 —— 32 次集合操作。
          //       为 4 个 float 发一次 all-reduce，等于为 16 字节付一整套
          //       ring 的固定开销。改成攒够 128 个元素再发。
          int offset = 0;
          for (int layer = 0; layer < LAYERS; ++layer) {
            int n = vec_get(sizes, layer);
            ncclGroupStart();
            for (int d = 0; d < N; ++d) {
              ncclAllReduce(grad[d] + offset, out[d] + offset, n,
                            ncclFloat, ncclSum, comms[d], 0);
            }
            ncclGroupEnd();
            offset += n;
          }

          // 每张卡的第 0 个结果写回平台的缓冲区
          float* check = lab_buffer(0);
          float host[8];
          for (int d = 0; d < N; ++d) {
            cudaSetDevice(d);
            float one[1];
            cudaMemcpy(one, out[d], 4, cudaMemcpyDeviceToHost);
            host[d] = one[0];
          }
          cudaSetDevice(0);
          cudaMemcpy(check, host, N * 4, cudaMemcpyHostToDevice);
          return 0;
        }
      `,
    },
    bench: dpBench,
    referenceFiles: {
      '/root/dataparallel.cu': code`
        #include "engine.h"
        #include "cluster.h"
        #include "containers.h"
        #include "nccl.h"

        ${DP_KERNELS}

        int main(void) {
          const int N = ${DP_DEVICES};
          const int LAYERS = ${DP_SIZES.length};
          const int TOTAL = ${DP_TOTAL};
          const int BUCKET = 128;

          int sizes = vec_new();
          ${DP_DECL}

          int comms[8];
          ncclCommInitAll(comms, N, 0);

          int grad[8]; int out[8];
          for (int d = 0; d < N; ++d) {
            cudaSetDevice(d);
            float* g; float* o;
            cudaMalloc((void**)&g, TOTAL * 4);
            cudaMalloc((void**)&o, TOTAL * 4);
            fill<<<1, 64>>>(g, (float)(d + 1), 64);
            grad[d] = g; out[d] = o;
          }

          // 梯度在显存里是连着放的，所以一桶就是一段连续区间：
          // 记住起点与已攒长度，攒够了发一次
          int start = 0;
          int pending = 0;
          for (int layer = 0; layer < LAYERS; ++layer) {
            pending += vec_get(sizes, layer);
            // 最后一桶不管攒够没有都要发 —— 漏了它，最后几层的梯度
            // 永远不同步，而训练照常收敛，只是各卡悄悄分叉
            int last = layer == LAYERS - 1 ? 1 : 0;
            if (pending >= BUCKET || last == 1) {
              ncclGroupStart();
              for (int d = 0; d < N; ++d) {
                ncclAllReduce(grad[d] + start, out[d] + start, pending,
                              ncclFloat, ncclSum, comms[d], 0);
              }
              ncclGroupEnd();
              start += pending;
              pending = 0;
            }
          }

          float* check = lab_buffer(0);
          float host[8];
          for (int d = 0; d < N; ++d) {
            cudaSetDevice(d);
            float one[1];
            cudaMemcpy(one, out[d], 4, cudaMemcpyDeviceToHost);
            host[d] = one[0];
          }
          cudaSetDevice(0);
          cudaMemcpy(check, host, N * 4, cudaMemcpyHostToDevice);
          return 0;
        }
      `,
    },
  },
  specs: [
    spec('dataparallel.spec.ts', code`
      const lab = require('@gpu/lab');
      const N = ${DP_DEVICES};
      const TOTAL = ${DP_TOTAL};

      describe('数据并行的梯度同步', () => {
        it('8 张卡都拿到正确的和', async () => {
          await lab.buildAndRun();
          const check = lab.buffer('check');
          // 第 d 张卡的梯度是 d + 1，加起来 1+2+...+8 = 36
          for (let d = 0; d < N; d += 1) {
            expect(Math.abs(check[d] - 36)).toBeLessThanOrEqual(1e-5);
          }
        });

        it('**消息数降下来了**', async () => {
          await lab.buildAndRun();
          expect(lab.comm().messages).toBeLessThanOrEqual(800);
        });

        it('搬运总量一个字节没变 —— 分桶省的是每消息开销', async () => {
          await lab.buildAndRun();
          // 每个元素在 ring 上要过 2(n-1)/n × n = 2(n-1) 次，每次 4 字节
          expect(lab.comm().bytes).toBe(2 * (N - 1) * TOTAL * 4);
        });

        it('**每一层的梯度都同步了** —— 漏发最后一桶会被抓住', async () => {
          await lab.buildAndRun();
          // 全部 TOTAL 个元素都要参与，一个不能少
          expect(lab.comm().bytes).toBe(2 * (N - 1) * TOTAL * 4);
        });

        it('全在机内，不该走 IB', async () => {
          await lab.buildAndRun();
          expect(lab.comm().bytesByLink.ib).toBe(0);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.comm.messages', op: 'lte', value: 800,
      zh: '消息条数（逐层发是 3584）', en: 'messages sent (3584 per-layer)',
      unit: 'message', dimension: 'throughput',
    }),
    gate({
      metric: 'gpu.comm.bytes', op: 'gte', value: 2 * 7 * 1408 * 4,
      zh: '搬运总量 —— 分桶省的是消息数不是字节，少了就是漏了层',
      en: 'total bytes: bucketing saves messages, not bytes, so a drop means layers were skipped',
      unit: 'byte', dimension: 'correctness',
    }),
    gate({
      metric: 'gpu.comm.bytesByLink.ib', op: 'lte', value: 0,
      zh: '走 IB 的字节数 —— 8 张卡在同一台机器里',
      en: 'bytes over InfiniBand: all 8 GPUs are in one node',
      unit: 'byte', dimension: 'correctness',
    }),
  ],
  focus: ['throughput', 'correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 24 关：张量并行                                                    */
/* ------------------------------------------------------------------ */

const TP_HIDDEN = 128;
const TP_TOKENS = 32;
const TP_WAYS = 8;

/** 两台 8 卡机，一共 16 张 —— 跨机那件事得有机器可跨 */
const TWO_NODE_WORLD = {
  globalBytes: 2 * 1024 * 1024,
  cluster: { devices: 16, devicesPerNode: 8 },
};

const TP_KERNELS = code`
  __global__ void fill(float* a, float v, int n) {
    int i = threadIdx.x;
    if (i < n) a[i] = v;
  }
  // y = x W，W 是 [hidden, shard] 的一片
  __global__ void matmulShard(const float* x, const float* W, float* y,
                              int tokens, int hidden, int shard) {
    int t = blockIdx.x;
    int c = threadIdx.x;
    if (c >= shard) return;
    float acc = 0.0f;
    for (int k = 0; k < hidden; ++k) acc = fmaf(x[t * hidden + k], W[k * shard + c], acc);
    y[t * shard + c] = acc;
  }
`;

const tpBench = {
  sources: ['/root/tensorparallel.cu'],
  buffers: [
    { name: 'check', length: TP_WAYS, fill: { kind: 'zeros' } },
  ],
  launches: [],
};

const STAGE_24 = {
  id: 'tensor-parallel',
  title: t('张量并行 —— 一层只该通信一次，而且不能跨机',
    'Tensor parallelism — one collective per layer, and never across nodes'),
  goal: t(
    [
      '模型大到一张卡放不下时，就得把**单个权重矩阵**切开放到多张卡上 ——',
      '这就是张量并行。这一关有 16 张卡（两台 8 卡机），做 8 路张量并行。',
      '',
      '一个前馈层是两次矩阵乘：`y = (x W1) W2`。切法有讲究：',
      '',
      '- **列并行**切 W1 的列。每张卡算出中间结果的一竖条 ——',
      '  各算各的，**不需要通信**。',
      '- **行并行**切 W2 的行。每张卡拿自己那一竖条中间结果，',
      '  乘 W2 的对应横条，得到一个**部分和**。',
      '  所有卡的部分和加起来才是答案 —— 这里需要一次 all-reduce。',
      '',
      '关键在于**列并行的输出形状正好是行并行想要的输入形状**。',
      '于是一整层只需要**末尾一次** all-reduce。',
      '',
      '`tensorparallel.cu` 现在有两个问题：',
      '',
      '1. 它在两次矩阵乘**中间**也 all-reduce 了一次 —— 把分片的中间结果凑全。',
      '   凑全了才能做行并行？不对，行并行要的就是分片的。',
      '2. 它挑的 8 张卡是 0-3 和 8-11 —— **摊在两台机器上了**。',
      '',
      '第二条的代价比看上去大得多。这一关的两条链路：',
      '',
      '| | 单向带宽 | 延迟 |',
      '| --- | --- | --- |',
      '| NVLink 4（机内） | 450 GB/s | 1.5 µs |',
      '| InfiniBand NDR（跨机） | 50 GB/s | 5 µs |',
      '',
      '**差 9 倍。** 而张量并行是每层都要通信的 ——',
      '数据并行一步只 all-reduce 一次，张量并行 80 层就是 80 次。',
      '这就是「scale-up 走 NVLink，scale-out 走 IB」那条铁律的由来。',
      '',
      '```bash',
      'nvcc -o bench tensorparallel.cu && ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 结果正确',
      '- **走 IB 的字节数为 0** —— 8 路张量并行必须落在同一台机器里',
      '- 通信总量 ≤ 240 KB（起始版是 252 KB）',
    ].join('\n'),
    [
      'When a model is too large for one GPU, individual **weight matrices** get split across GPUs.',
      'That is tensor parallelism. This stage has 16 GPUs (two 8-GPU nodes) and does 8-way TP.',
      '',
      'A feed-forward layer is two matmuls: `y = (x W1) W2`. How you split them matters:',
      '',
      '- **Column parallel** splits W1 by columns. Each GPU computes one vertical strip of the',
      '  intermediate result, independently, with **no communication**.',
      '- **Row parallel** splits W2 by rows. Each GPU takes its own strip of the intermediate,',
      '  multiplies by the matching horizontal strip of W2, and gets a **partial sum**. Summing all',
      '  the partials gives the answer, and that needs one all-reduce.',
      '',
      'The key is that **column-parallel output has exactly the shape row-parallel wants as input**,',
      'so a whole layer needs only **one all-reduce, at the end**.',
      '',
      '`tensorparallel.cu` has two problems:',
      '',
      '1. It also all-reduces **between** the two matmuls, to assemble the full intermediate. But row',
      '   parallel wants the sharded one, not the full one.',
      '2. The 8 GPUs it picks are 0-3 and 8-11, **spread across two nodes**.',
      '',
      'The second costs far more than it looks. The two links here:',
      '',
      '| | one-way bandwidth | latency |',
      '| --- | --- | --- |',
      '| NVLink 4 (in-node) | 450 GB/s | 1.5 µs |',
      '| InfiniBand NDR (cross-node) | 50 GB/s | 5 µs |',
      '',
      '**A factor of nine.** And tensor parallelism communicates every layer: data parallelism',
      'all-reduces once per step, TP does it 80 times for 80 layers. That is where the rule',
      '"scale up over NVLink, scale out over InfiniBand" comes from.',
      '',
      '```bash',
      'nvcc -o bench tensorparallel.cu && ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- correct results',
      '- **zero bytes over InfiniBand**: 8-way TP has to fit in one node',
      '- at most 240 KB of communication (252 KB to start)',
    ].join('\n')
  ),
  checklist: [
    t('去掉两次矩阵乘中间那次 all-reduce', 'Remove the all-reduce between the two matmuls'),
    t('把 8 路张量并行落在同一台机器的 8 张卡上',
      'Put the 8-way TP group on one node\'s 8 GPUs'),
    t('末尾保留那一次 all-reduce —— 部分和必须加起来',
      'Keep the final all-reduce: the partial sums do have to be summed'),
  ],
  hints: [
    t('`ncclCommInitAll` 的第三个参数 `devlist` 决定第 i 个 rank 在哪张卡上。'
      + '**它不是摆设** —— ring 是按实际的卡走的。',
      'The third argument to `ncclCommInitAll`, `devlist`, decides which GPU each rank sits on. '
      + '**It is not decorative**: the ring follows the actual GPUs.'),
    t('列并行之后每张卡手上是中间结果的一竖条，正好就是行并行要的那一片 —— '
      + '什么都不用做，直接喂给第二次矩阵乘。',
      'After the column-parallel step each GPU holds one vertical strip of the intermediate, which '
      + 'is exactly the slice row parallel needs. Feed it straight into the second matmul.'),
  ],
  pitfalls: [
    t('**以为行并行需要完整的中间结果。** 正相反 —— 行并行要的就是分片的那一条。'
      + '凑全了再切开，等于白白通信一次。',
      '**Thinking row parallel needs the full intermediate.** The opposite is true: it wants exactly '
      + 'the shard. Assembling the whole thing and re-splitting it is a wasted collective.'),
    t('**把 TP 组摊到两台机器上。** 结果完全正确，只是慢得多 —— '
      + '而且慢的方式很隐蔽：单看一层的耗时只是"有点慢"，'
      + '乘上 80 层就是训练吞吐掉一半。`comm.bytesByLink.ib` 是唯一能直接看出来的地方。',
      '**Spreading the TP group across nodes.** The results are perfectly correct, just much slower, '
      + 'and slower in a sneaky way: one layer merely looks a bit slow, but across 80 layers it '
      + 'halves training throughput. `comm.bytesByLink.ib` is the one place it shows directly.'),
  ],
  extension: t(
    'Megatron-LM 那篇论文（2019）提出的就是这个切法，'
    + '而"列并行接行并行"这个顺序是它最核心的设计 ——'
    + '换成"行并行接列并行"，中间就得通信一次，一层两次 all-reduce。'
    + '\n\n'
    + '注意力层是同一个套路：QKV 投影按**头**切（等价于列并行），'
    + '输出投影按行切，于是整个注意力块也只需要末尾一次 all-reduce。'
    + '一个 Transformer 层因此是**两次** all-reduce（注意力一次、前馈一次），'
    + '反向传播再两次。80 层的模型每步就是 320 次集合操作 ——'
    + '这个频率解释了为什么张量并行对延迟极其敏感。'
    + '\n\n'
    + '所以现实中的并行策略是分层的：'
    + '**张量并行只在机内**（8 张卡，NVLink），'
    + '**流水线并行跨机**（IB，每级之间只传一次激活），'
    + '**数据并行在最外层**（每步一次 all-reduce，频率最低）。'
    + 'Megatron 的 6D 并行就是这几个维度的组合，而维度的排布顺序'
    + '几乎完全由"这一维通信多频繁"决定。'
    + '\n\n'
    + '顺带一提，这一关的两条链路差 9 倍带宽、3 倍延迟。'
    + 'GB200 NVL72 把 72 张卡用 NVLink 5 连成一个域，'
    + '就是为了把"机内"这个范围从 8 张卡扩到 72 张 ——'
    + '于是张量并行的可用宽度一下子大了 9 倍。',
    'Megatron-LM (2019) introduced this split, and the column-then-row ordering is its core design. '
    + 'Row-then-column would need a collective in the middle, two all-reduces per layer.\n\n'
    + 'Attention layers follow the same pattern: QKV projections split by **head** (equivalent to '
    + 'column parallel), the output projection splits by row, so an attention block also needs only '
    + 'one all-reduce at the end. A Transformer layer is therefore **two** all-reduces (attention, '
    + 'feed-forward) plus two more in backward. For an 80-layer model that is 320 collectives per '
    + 'step, and that frequency is why tensor parallelism is so latency-sensitive.\n\n'
    + 'Real parallel strategies are layered accordingly: **tensor parallelism stays in-node** (8 '
    + 'GPUs, NVLink), **pipeline parallelism goes across nodes** (InfiniBand, one activation '
    + 'transfer per stage boundary), and **data parallelism sits outermost** (one all-reduce per '
    + 'step, the lowest frequency). Megatron\'s 6D parallelism combines these dimensions, and their '
    + 'ordering is decided almost entirely by how often each one communicates.\n\n'
    + 'Incidentally, the two links here differ by 9x in bandwidth and 3x in latency. GB200 NVL72 '
    + 'connects 72 GPUs into one NVLink 5 domain precisely to stretch "in-node" from 8 GPUs to 72, '
    + 'making the usable width for tensor parallelism nine times larger.'
  ),
  gpu: {
    world: TWO_NODE_WORLD,
    files: {
      '/root/tensorparallel.cu': code`
        #include "engine.h"
        #include "cluster.h"
        #include "nccl.h"

        ${TP_KERNELS}

        int main(void) {
          const int TP = ${TP_WAYS};
          const int HIDDEN = ${TP_HIDDEN};
          const int TOKENS = ${TP_TOKENS};
          const int SHARD = HIDDEN / TP;

          // TODO: 这 8 张卡摊在两台机器上了（0-3 在节点 0，8-11 在节点 1）。
          //       8 路张量并行必须落在同一台机器里。
          int devs[16];
          devs[0] = 0; devs[1] = 1; devs[2] = 2; devs[3] = 3;
          devs[4] = 8; devs[5] = 9; devs[6] = 10; devs[7] = 11;

          int comms[16];
          ncclCommInitAll(comms, TP, devs);

          int x[16]; int w1[16]; int mid[16]; int w2[16]; int part[16]; int outb[16];
          for (int i = 0; i < TP; ++i) {
            cudaSetDevice(devs[i]);
            float* a; float* b; float* c; float* d2; float* e; float* f;
            cudaMalloc((void**)&a, TOKENS * HIDDEN * 4);
            cudaMalloc((void**)&b, HIDDEN * SHARD * 4);
            cudaMalloc((void**)&c, TOKENS * SHARD * 4);
            cudaMalloc((void**)&d2, SHARD * HIDDEN * 4);
            cudaMalloc((void**)&e, TOKENS * HIDDEN * 4);
            cudaMalloc((void**)&f, TOKENS * HIDDEN * 4);
            fill<<<1, 64>>>(a, 0.1f, 64);
            fill<<<1, 64>>>(b, 0.01f, 64);
            fill<<<1, 64>>>(d2, 0.02f, 64);
            x[i] = a; w1[i] = b; mid[i] = c; w2[i] = d2; part[i] = e; outb[i] = f;
          }

          // 列并行：各算各的一竖条，不需要通信
          for (int i = 0; i < TP; ++i) {
            cudaSetDevice(devs[i]);
            matmulShard<<<TOKENS, 32>>>(x[i], w1[i], mid[i], TOKENS, HIDDEN, SHARD);
          }

          // TODO: 这一次 all-reduce 是多余的。行并行要的就是分片的中间结果，
          //       凑全了再切开等于白白通信一次。
          ncclGroupStart();
          for (int i = 0; i < TP; ++i) {
            ncclAllReduce(mid[i], mid[i], TOKENS * SHARD, ncclFloat, ncclSum, comms[i], 0);
          }
          ncclGroupEnd();

          // 行并行：得到部分和
          for (int i = 0; i < TP; ++i) {
            cudaSetDevice(devs[i]);
            matmulShard<<<TOKENS, 32>>>(mid[i], w2[i], part[i], TOKENS, SHARD, HIDDEN);
          }

          // 部分和相加 —— 这一次是必须的
          ncclGroupStart();
          for (int i = 0; i < TP; ++i) {
            ncclAllReduce(part[i], outb[i], TOKENS * HIDDEN, ncclFloat, ncclSum, comms[i], 0);
          }
          ncclGroupEnd();

          float* check = lab_buffer(0);
          float host[8];
          for (int i = 0; i < TP; ++i) {
            cudaSetDevice(devs[i]);
            float one[1];
            cudaMemcpy(one, outb[i], 4, cudaMemcpyDeviceToHost);
            host[i] = one[0];
          }
          cudaSetDevice(0);
          cudaMemcpy(check, host, TP * 4, cudaMemcpyHostToDevice);
          return 0;
        }
      `,
    },
    bench: tpBench,
    referenceFiles: {
      '/root/tensorparallel.cu': code`
        #include "engine.h"
        #include "cluster.h"
        #include "nccl.h"

        ${TP_KERNELS}

        int main(void) {
          const int TP = ${TP_WAYS};
          const int HIDDEN = ${TP_HIDDEN};
          const int TOKENS = ${TP_TOKENS};
          const int SHARD = HIDDEN / TP;

          // 8 路张量并行落在节点 0 的 8 张卡上 —— 全走 NVLink
          int devs[16];
          for (int i = 0; i < TP; ++i) devs[i] = i;

          int comms[16];
          ncclCommInitAll(comms, TP, devs);

          int x[16]; int w1[16]; int mid[16]; int w2[16]; int part[16]; int outb[16];
          for (int i = 0; i < TP; ++i) {
            cudaSetDevice(devs[i]);
            float* a; float* b; float* c; float* d2; float* e; float* f;
            cudaMalloc((void**)&a, TOKENS * HIDDEN * 4);
            cudaMalloc((void**)&b, HIDDEN * SHARD * 4);
            cudaMalloc((void**)&c, TOKENS * SHARD * 4);
            cudaMalloc((void**)&d2, SHARD * HIDDEN * 4);
            cudaMalloc((void**)&e, TOKENS * HIDDEN * 4);
            cudaMalloc((void**)&f, TOKENS * HIDDEN * 4);
            fill<<<1, 64>>>(a, 0.1f, 64);
            fill<<<1, 64>>>(b, 0.01f, 64);
            fill<<<1, 64>>>(d2, 0.02f, 64);
            x[i] = a; w1[i] = b; mid[i] = c; w2[i] = d2; part[i] = e; outb[i] = f;
          }

          // 列并行：各算各的一竖条
          for (int i = 0; i < TP; ++i) {
            cudaSetDevice(devs[i]);
            matmulShard<<<TOKENS, 32>>>(x[i], w1[i], mid[i], TOKENS, HIDDEN, SHARD);
          }

          // **这里什么都不做。** 列并行的输出形状正好是行并行想要的输入形状 ——
          // 凑全了再切开等于白白通信一次
          for (int i = 0; i < TP; ++i) {
            cudaSetDevice(devs[i]);
            matmulShard<<<TOKENS, 32>>>(mid[i], w2[i], part[i], TOKENS, SHARD, HIDDEN);
          }

          // 一整层唯一的一次通信：把部分和加起来
          ncclGroupStart();
          for (int i = 0; i < TP; ++i) {
            ncclAllReduce(part[i], outb[i], TOKENS * HIDDEN, ncclFloat, ncclSum, comms[i], 0);
          }
          ncclGroupEnd();

          float* check = lab_buffer(0);
          float host[8];
          for (int i = 0; i < TP; ++i) {
            cudaSetDevice(devs[i]);
            float one[1];
            cudaMemcpy(one, outb[i], 4, cudaMemcpyDeviceToHost);
            host[i] = one[0];
          }
          cudaSetDevice(0);
          cudaMemcpy(check, host, TP * 4, cudaMemcpyHostToDevice);
          return 0;
        }
      `,
    },
  },
  specs: [
    spec('tensorparallel.spec.ts', code`
      const lab = require('@gpu/lab');
      const TP = ${TP_WAYS};

      describe('张量并行', () => {
        it('八张卡的结果一致且有限', async () => {
          await lab.buildAndRun();
          const check = lab.buffer('check');
          for (let i = 0; i < TP; i += 1) {
            expect(Number.isFinite(check[i])).toBe(true);
            expect(Math.abs(check[i] - check[0])).toBeLessThanOrEqual(1e-4);
          }
          // all-reduce 真的做了：部分和加起来不会是 0
          expect(Math.abs(check[0])).toBeGreaterThan(0);
        });

        it('**一个字节都不该走 IB** —— 8 路张量并行必须落在同一台机器里', async () => {
          await lab.buildAndRun();
          expect(lab.comm().bytesByLink.ib).toBe(0);
        });

        it('一整层只通信一次', async () => {
          await lab.buildAndRun();
          // 一次 all-reduce = 2(n-1) × n 条消息
          expect(lab.comm().messages).toBe(2 * (TP - 1) * TP);
        });

        it('通信总量降下来了', async () => {
          await lab.buildAndRun();
          expect(lab.comm().bytes).toBeLessThanOrEqual(240 * 1024);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.comm.bytesByLink.ib', op: 'lte', value: 0,
      zh: '走 IB 的字节数 —— 张量并行跨机就是被这条抓住的',
      en: 'bytes over InfiniBand: this is the gate that catches TP spanning nodes',
      unit: 'byte', dimension: 'correctness',
    }),
    gate({
      metric: 'gpu.comm.bytes', op: 'lte', value: 240 * 1024,
      zh: '通信总量（起始版是 252KB，多了中间那次多余的 all-reduce）',
      en: 'total communication (252KB to start, including the redundant middle all-reduce)',
      unit: 'byte', dimension: 'throughput',
    }),
    gate({
      metric: 'gpu.comm.messages', op: 'lte', value: 2 * 7 * 8,
      zh: '消息条数 —— 一整层只该有一次 all-reduce',
      en: 'messages: a whole layer should need only one all-reduce',
      unit: 'message', dimension: 'throughput',
    }),
  ],
  focus: ['throughput', 'correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 25 关：序列并行                                                    */
/* ------------------------------------------------------------------ */

const SP_WAYS = 8;
const SP_TOKENS = 64;
const SP_HIDDEN = 64;
const SP_LAYERS = 8;

const SP_KERNELS = code`
  __global__ void fill(float* a, float v, int n) {
    int i = threadIdx.x;
    if (i < n) a[i] = v;
  }
  // LayerNorm / dropout 这类逐元素算子的替身
  __global__ void elementwise(float* a, float k, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) a[i] = a[i] * k;
  }
`;

const spBench = {
  sources: ['/root/sequenceparallel.cu'],
  buffers: [
    { name: 'check', length: SP_WAYS, fill: { kind: 'zeros' } },
  ],
  launches: [],
};

const STAGE_25 = {
  id: 'sequence-parallel',
  title: t('序列并行 —— 通信量不变，激活显存降 n 倍',
    'Sequence parallelism — same communication, n times less activation memory'),
  goal: t(
    [
      '上一关的张量并行只切了矩阵乘。**矩阵乘之间的那些算子没切** ——',
      'LayerNorm、dropout、残差加，这些逐元素的操作在每张卡上都是',
      '**在完整的激活上重复做一遍**。',
      '',
      '重复计算还是小事。真正贵的是**激活要留着给反向用** ——',
      '8 层的模型，每张卡就得存 8 份完整的激活。',
      '',
      '序列并行的做法：既然这些算子是逐元素的，那就**按序列维度切开**，',
      '每张卡只做 1/n、只存 1/n。',
      '',
      '关键在通信怎么接。张量并行末尾的 all-reduce 之后，每张卡都有完整的结果；',
      '而序列并行只想要 1/n。这两件事合起来正好是 **reduce-scatter**：',
      '',
      '```',
      '张量并行:  部分和 --[all-reduce]--> 完整激活 --> 逐元素(完整)',
      '序列并行:  部分和 --[reduce-scatter]--> 1/n 激活 --> 逐元素(1/n)',
      '                                                        |',
      '                        下一个矩阵乘要完整输入 <--[all-gather]',
      '```',
      '',
      '**而 `reduce-scatter + all-gather` 的通信量和一次 `all-reduce` 完全相同。**',
      '回忆第 22 关：ring all-reduce 本来就是这两个阶段拼起来的，',
      '各占 `(n-1)/n`，加起来正好 `2(n-1)/n`。',
      '',
      '所以序列并行是**白拿的**：通信一个字节不多，激活显存降到 1/n，',
      '逐元素的计算也降到 1/n。',
      '',
      '```bash',
      'nvcc -o bench sequenceparallel.cu && ncu ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 每张卡的显存峰值 ≤ 60 KB（只做张量并行是 144 KB）',
      '- 逐元素的指令数 ≤ 20 万（只做张量并行是 121 万）',
      '- **通信总量一个字节都不能少** —— 省的不是通信',
    ].join('\n'),
    [
      'The tensor parallelism of the previous stage split only the matmuls. **The operators between',
      'them were not split**: LayerNorm, dropout, the residual add. Every GPU repeats those',
      'elementwise operations **on the full activation**.',
      '',
      'The repeated compute is the smaller problem. The expensive part is that **activations must be',
      'kept for the backward pass**, so an 8-layer model stores 8 full activations per GPU.',
      '',
      'Sequence parallelism\'s answer: since those operators are elementwise, **split them along the',
      'sequence dimension** so each GPU does 1/n of the work and stores 1/n of the result.',
      '',
      'The interesting part is how the communication connects. After tensor parallelism\'s final',
      'all-reduce every GPU has the complete result; sequence parallelism only wants 1/n. Those two',
      'together are exactly a **reduce-scatter**:',
      '',
      '```',
      'TP:  partials --[all-reduce]--> full activation --> elementwise (full)',
      'SP:  partials --[reduce-scatter]--> 1/n activation --> elementwise (1/n)',
      '                                                            |',
      '                        next matmul needs full <--[all-gather]',
      '```',
      '',
      '**And `reduce-scatter + all-gather` costs exactly as much as one `all-reduce`.** Recall stage',
      '22: ring all-reduce *is* those two phases stitched together, each costing `(n-1)/n`, together',
      'exactly `2(n-1)/n`.',
      '',
      'So sequence parallelism is **free**: not one extra byte of communication, activation memory',
      'down to 1/n, elementwise compute down to 1/n.',
      '',
      '```bash',
      'nvcc -o bench sequenceparallel.cu && ncu ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- peak memory per GPU at most 60 KB (144 KB with tensor parallelism alone)',
      '- at most 200k elementwise instructions (1.21M with TP alone)',
      '- **not one byte less communication**: that is not what is being saved',
    ].join('\n')
  ),
  checklist: [
    t('把 all-reduce 换成 reduce-scatter', 'Replace the all-reduce with a reduce-scatter'),
    t('每层的激活只分配 1/n', 'Allocate only 1/n of each layer\'s activation'),
    t('逐元素算子只在自己那一段上做', 'Run the elementwise operator on your own slice only'),
    t('下一个矩阵乘之前用 all-gather 凑回完整的',
      'Use an all-gather to reassemble the full tensor before the next matmul'),
  ],
  hints: [
    t('`ncclReduceScatter` 的第三个参数是**收到多少个**（`recvcount`），'
      + '不是发出去多少个 —— 发的是 `recvcount × n`。',
      'The third argument to `ncclReduceScatter` is how many elements you **receive** '
      + '(`recvcount`), not how many you send: you send `recvcount x n`.'),
    t('all-gather 凑回来的那块可以各层复用 —— 它是过渡用的，不需要留给反向。'
      + '要留的是 reduce-scatter 之后那 1/n。',
      'The buffer the all-gather fills can be reused across layers; it is transient and not needed '
      + 'for backward. What must be kept is the 1/n from the reduce-scatter.'),
  ],
  pitfalls: [
    t('**all-gather 之后的那块也留着不放。** 那就白做了 —— '
      + '省显存的关键是"完整的那份只在过渡时存在"。',
      '**Keeping the all-gathered buffer around too.** That defeats the point: the saving depends on '
      + 'the full copy existing only transiently.'),
    t('**以为 reduce-scatter 比 all-reduce 便宜一半就够了。** '
      + '它确实只有一半，但你还要加上 all-gather 的另一半 —— 加起来一样。'
      + '序列并行省的是显存与逐元素计算，**不是通信**。',
      '**Assuming reduce-scatter alone is the win because it costs half.** It does cost half, but '
      + 'you still pay the all-gather\'s other half, and the total is identical. Sequence '
      + 'parallelism saves memory and elementwise compute, **not communication**.'),
  ],
  extension: t(
    '序列并行出自 Megatron 的后续论文（Reducing Activation Recomputation in Large '
    + 'Transformer Models，2022），和选择性激活重算是同一篇里的两个手段。'
    + '论文里报的是激活显存降到约 1/5，而**通信量完全不变**。'
    + '\n\n'
    + '值得体会的是这一关和前两关的对照。三关都在动通信，但动的维度完全不同：'
    + '\n\n'
    + '| 关 | 总字节 | 消息数 | 分布 | 换来了什么 |'
    + '\n| --- | --- | --- | --- | --- |'
    + '\n| 22 ring | 不变 | 涨 n 倍 | **摊开** | 瓶颈降 n/2 |'
    + '\n| 23 分桶 | 不变 | **降** | 不变 | 每消息开销 |'
    + '\n| 25 序列并行 | **不变** | 不变 | 不变 | 显存与计算降 n 倍 |'
    + '\n\n'
    + '三次优化，通信总量一次都没降。这不是巧合 ——'
    + '集合通信的总量由算法的语义定死了（人人都要拿到那个和），'
    + '能动的只有分布、粒度、以及"用哪个集合操作把它接到别的优化上"。'
    + '\n\n'
    + '再往前一步就是上下文并行（Ring Attention）：'
    + '序列并行切的是逐元素算子，注意力本身还是每张卡算完整的；'
    + '上下文并行把注意力也按序列切开，代价是注意力内部要转一圈 KV。'
    + '那是长上下文训练（百万 token）的必需品。',
    'Sequence parallelism comes from Megatron\'s follow-up paper (Reducing Activation Recomputation '
    + 'in Large Transformer Models, 2022), alongside selective activation recomputation. The paper '
    + 'reports activation memory falling to roughly a fifth with **communication volume unchanged**.'
    + '\n\nThe contrast with the previous stages is worth sitting with. All three touch '
    + 'communication, along completely different axes:\n\n'
    + '| stage | total bytes | messages | distribution | what it buys |\n'
    + '| --- | --- | --- | --- | --- |\n'
    + '| 22 ring | same | n times more | **spread out** | bottleneck down n/2 |\n'
    + '| 23 bucketing | same | **fewer** | same | per-message overhead |\n'
    + '| 25 sequence parallel | **same** | same | same | memory and compute down n |\n\n'
    + 'Three optimisations and the total never dropped once. That is not a coincidence: the volume '
    + 'of a collective is fixed by its semantics (everyone needs that sum). What you can change is '
    + 'the distribution, the granularity, and which collective you use to connect it to another '
    + 'optimisation.\n\n'
    + 'One step further is context parallelism (Ring Attention). Sequence parallelism splits the '
    + 'elementwise operators while attention itself still runs whole on every GPU; context '
    + 'parallelism splits attention along the sequence too, at the cost of passing KV around a ring '
    + 'inside attention. That is what million-token training requires.'
  ),
  gpu: {
    world: CLUSTER_WORLD,
    files: {
      '/root/sequenceparallel.cu': code`
        #include "engine.h"
        #include "cluster.h"
        #include "nccl.h"

        ${SP_KERNELS}

        int main(void) {
          const int TP = ${SP_WAYS};
          const int FULL = ${SP_TOKENS * SP_HIDDEN};
          const int SHARD = FULL / TP;
          const int LAYERS = ${SP_LAYERS};

          int devs[8];
          for (int i = 0; i < TP; ++i) devs[i] = i;
          int comms[8];
          ncclCommInitAll(comms, TP, devs);

          int part[8];
          for (int i = 0; i < TP; ++i) {
            cudaSetDevice(devs[i]);
            float* p;
            cudaMalloc((void**)&p, FULL * 4);
            fill<<<1, 64>>>(p, 0.1f, 64);
            part[i] = p;
          }

          // TODO: 每层 all-reduce 出一份**完整的**激活，逐元素算子在完整的
          //       激活上做，而且每层都要留给反向。
          //       改成 reduce-scatter + 1/n 的逐元素 + all-gather。
          for (int layer = 0; layer < LAYERS; ++layer) {
            int act[8];
            for (int i = 0; i < TP; ++i) {
              cudaSetDevice(devs[i]);
              float* a;
              cudaMalloc((void**)&a, FULL * 4);
              act[i] = a;
            }
            ncclGroupStart();
            for (int i = 0; i < TP; ++i) {
              ncclAllReduce(part[i], act[i], FULL, ncclFloat, ncclSum, comms[i], 0);
            }
            ncclGroupEnd();
            for (int i = 0; i < TP; ++i) {
              cudaSetDevice(devs[i]);
              elementwise<<<FULL / 64, 64>>>(act[i], 1.0009765625f, FULL);
            }
          }

          float* check = lab_buffer(0);
          float host[8];
          for (int i = 0; i < TP; ++i) {
            cudaSetDevice(devs[i]);
            float one[1];
            cudaMemcpy(one, part[i], 4, cudaMemcpyDeviceToHost);
            host[i] = one[0];
          }
          cudaSetDevice(0);
          cudaMemcpy(check, host, TP * 4, cudaMemcpyHostToDevice);
          return 0;
        }
      `,
    },
    bench: spBench,
    referenceFiles: {
      '/root/sequenceparallel.cu': code`
        #include "engine.h"
        #include "cluster.h"
        #include "nccl.h"

        ${SP_KERNELS}

        int main(void) {
          const int TP = ${SP_WAYS};
          const int FULL = ${SP_TOKENS * SP_HIDDEN};
          const int SHARD = FULL / TP;
          const int LAYERS = ${SP_LAYERS};

          int devs[8];
          for (int i = 0; i < TP; ++i) devs[i] = i;
          int comms[8];
          ncclCommInitAll(comms, TP, devs);

          int part[8]; int gathered[8];
          for (int i = 0; i < TP; ++i) {
            cudaSetDevice(devs[i]);
            float* p; float* g;
            cudaMalloc((void**)&p, FULL * 4);
            // 完整的那份**只在过渡时存在**，各层复用，不留给反向
            cudaMalloc((void**)&g, FULL * 4);
            fill<<<1, 64>>>(p, 0.1f, 64);
            part[i] = p; gathered[i] = g;
          }

          for (int layer = 0; layer < LAYERS; ++layer) {
            int act[8];
            for (int i = 0; i < TP; ++i) {
              cudaSetDevice(devs[i]);
              float* a;
              // 每层要留给反向的只有 1/n
              cudaMalloc((void**)&a, SHARD * 4);
              act[i] = a;
            }

            // all-reduce 换成 reduce-scatter：归约完每张卡只拿自己那一段。
            // 注意第三个参数是**收到多少个**，发出去的是它的 n 倍
            ncclGroupStart();
            for (int i = 0; i < TP; ++i) {
              ncclReduceScatter(part[i], act[i], SHARD, ncclFloat, ncclSum, comms[i], 0);
            }
            ncclGroupEnd();

            // 逐元素算子只在自己那 1/n 上做
            for (int i = 0; i < TP; ++i) {
              cudaSetDevice(devs[i]);
              elementwise<<<SHARD / 64, 64>>>(act[i], 1.0009765625f, SHARD);
            }

            // 下一个矩阵乘要完整的输入 —— all-gather 凑回来。
            // reduce-scatter 的 (n-1)/n 加上这里的 (n-1)/n，
            // 正好是一次 all-reduce 的 2(n-1)/n：**通信一个字节都没多**
            ncclGroupStart();
            for (int i = 0; i < TP; ++i) {
              ncclAllGather(act[i], gathered[i], SHARD, ncclFloat, comms[i], 0);
            }
            ncclGroupEnd();
          }

          float* check = lab_buffer(0);
          float host[8];
          for (int i = 0; i < TP; ++i) {
            cudaSetDevice(devs[i]);
            float one[1];
            cudaMemcpy(one, part[i], 4, cudaMemcpyDeviceToHost);
            host[i] = one[0];
          }
          cudaSetDevice(0);
          cudaMemcpy(check, host, TP * 4, cudaMemcpyHostToDevice);
          return 0;
        }
      `,
    },
  },
  specs: [
    spec('sequenceparallel.spec.ts', code`
      const lab = require('@gpu/lab');
      const TP = ${SP_WAYS};

      describe('序列并行', () => {
        it('结果有限且一致', async () => {
          await lab.buildAndRun();
          const check = lab.buffer('check');
          for (let i = 0; i < TP; i += 1) expect(Number.isFinite(check[i])).toBe(true);
        });

        it('**每张卡的激活显存降下来了**', async () => {
          await lab.buildAndRun();
          expect(lab.peakBytes()).toBeLessThanOrEqual(60 * 1024);
        });

        it('逐元素的计算也降到 1/n', async () => {
          await lab.buildAndRun();
          expect(lab.metrics().inst.laneExecuted).toBeLessThanOrEqual(200000);
        });

        it('**通信总量一个字节都没少** —— 省的不是通信', async () => {
          await lab.buildAndRun();
          // reduce-scatter 的 (n-1)/n + all-gather 的 (n-1)/n = all-reduce 的 2(n-1)/n
          expect(lab.comm().bytes).toBe(1835008);
        });

        it('消息数也一样', async () => {
          await lab.buildAndRun();
          expect(lab.comm().messages).toBe(896);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.memoryPeakBytes', op: 'lte', value: 60 * 1024,
      zh: '每张卡的显存峰值（只做张量并行是 144KB）',
      en: 'peak memory per GPU (144KB with tensor parallelism alone)',
      unit: 'byte', dimension: 'throughput',
    }),
    gate({
      metric: 'gpu.inst.laneExecuted', op: 'lte', value: 200000,
      zh: '逐元素的指令数（只做张量并行是 121 万）',
      en: 'elementwise instructions (1.21M with TP alone)',
      unit: 'inst', dimension: 'throughput',
    }),
    gate({
      metric: 'gpu.comm.bytes', op: 'gte', value: 1835008,
      zh: '通信总量 —— 序列并行省的不是通信，少了就是算错了',
      en: 'total communication: sequence parallelism does not save this, so a drop means a bug',
      unit: 'byte', dimension: 'correctness',
    }),
  ],
  focus: ['throughput', 'correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 26 关：流水线并行 1F1B                                             */
/* ------------------------------------------------------------------ */

const PP_STAGES = 8;
const PP_MICROBATCHES = 32;

const PP_KERNELS = code`
  __global__ void forward(float* act, const float* in, int n) {
    int i = threadIdx.x;
    if (i < n) act[i] = in[i] * 1.0009765625f + 0.001f;
  }
  __global__ void backward(float* grad, const float* act, int n) {
    int i = threadIdx.x;
    if (i < n) grad[i] = act[i] * 0.5f;
  }
`;

const ppBench = {
  sources: ['/root/pipeline.cu'],
  buffers: [
    { name: 'check', length: PP_STAGES, fill: { kind: 'zeros' } },
  ],
  launches: [],
};

const STAGE_26 = {
  id: 'pipeline-parallel',
  title: t('流水线并行 1F1B —— 一步只做一件事',
    'Pipeline parallelism with 1F1B — one thing per step'),
  goal: t(
    [
      '张量并行只能在机内（第 24 关）。模型再大就得**按层切**，',
      '每台机器负责几层 —— 这就是流水线并行。这一关 8 级、32 个 microbatch。',
      '',
      '`pipeline.cu` 现在用的是 **GPipe** 排程：把 32 个 microbatch 的前向',
      '全部做完，再全部做反向。',
      '',
      '两个代价：',
      '',
      '1. **前向流水线要完全排空才开始反向** —— fill 与 drain 各付了两次。',
      '2. **每一级要同时存 32 份激活**（每个 microbatch 的都得留着给反向）。',
      '',
      '**1F1B**（一前一后）把这两件事一起解决。第 d 级的操作序列是：',
      '',
      '```',
      'warmup  : P-1-d 次前向          （越靠后的级，热身越短）',
      'steady  : (前向, 反向) 交替      （这里是稳态，每步一件事）',
      'cooldown: 剩下的反向',
      '```',
      '',
      '一共还是 2M 个操作，一件不多一件不少。变的是**顺序** ——',
      '流水线不再排空，而且因为反向紧跟着前向，',
      '**一份激活用完就能立刻复用**，每级只需要 P 个槽而不是 M 个。',
      '',
      '气泡率是数出来的：`pipe_step()` 声明一个步边界，',
      '平台记下每一步里哪几张卡真的干了活。',
      '',
      '```',
      '气泡率 = 1 - 干活的(步, 卡)格子数 / (步数 × 卡数)',
      '```',
      '',
      '```bash',
      'nvcc -o bench pipeline.cu && ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 气泡率 ≤ 0.12（GPipe 是 0.1795）',
      '- 每张卡的显存峰值 ≤ 4 KB（GPipe 是 8960 字节）',
      '- **总工作量一格不少** —— 干活的格子必须正好 `2 × M × P = 512`',
    ].join('\n'),
    [
      'Tensor parallelism has to stay in-node (stage 24). Larger models get **split by layer**, a few',
      'layers per machine, which is pipeline parallelism. This stage has 8 stages and 32 microbatches.',
      '',
      '`pipeline.cu` uses the **GPipe** schedule: run all 32 forwards, then all 32 backwards.',
      '',
      'Two costs:',
      '',
      '1. **The forward pipeline drains completely before backward starts**, so fill and drain are',
      '   each paid twice.',
      '2. **Each stage holds 32 activations at once**, since every microbatch\'s has to survive until',
      '   its backward.',
      '',
      '**1F1B** (one forward, one backward) fixes both. Stage d\'s operation sequence is:',
      '',
      '```',
      'warmup  : P-1-d forwards        (later stages warm up for less time)',
      'steady  : alternating forward, backward   (steady state, one op per step)',
      'cooldown: the remaining backwards',
      '```',
      '',
      'Still 2M operations, not one more or fewer. What changes is the **order**: the pipeline never',
      'drains, and because each backward closely follows its forward, **an activation can be reused',
      'as soon as it is consumed**, so each stage needs P slots instead of M.',
      '',
      'The bubble is counted, not assumed: `pipe_step()` declares a step boundary and the platform',
      'records which GPUs actually did work in it.',
      '',
      '```',
      'bubble = 1 - busy (step, GPU) cells / (steps x GPUs)',
      '```',
      '',
      '```bash',
      'nvcc -o bench pipeline.cu && ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- bubble at most 0.12 (0.1795 for GPipe)',
      '- peak memory per GPU at most 4 KB (8960 bytes for GPipe)',
      '- **not one cell of work missing**: busy cells must be exactly `2 x M x P = 512`',
    ].join('\n')
  ),
  checklist: [
    t('第 d 级热身 P-1-d 次前向', 'Warm up stage d with P-1-d forwards'),
    t('稳态里前向反向交替，一步只做一件事',
      'Alternate forward and backward in steady state, one op per step'),
    t('每级只开 P 个激活槽，循环复用', 'Allocate P activation slots per stage and reuse them'),
  ],
  hints: [
    t('第 d 级从第 d 步开始动，一共动 2M 步 —— 所以总步数是 `2M + P - 1`。'
      + 'GPipe 是 `2(M + P - 1)`，多出来的 `P-1` 就是第二次 fill/drain。',
      'Stage d starts at step d and runs for 2M steps, so the total is `2M + P - 1`. GPipe needs '
      + '`2(M + P - 1)`; the extra `P-1` is the second fill and drain.'),
    t('激活槽用 `microbatch % P` 索引就够 —— 1F1B 保证同时在飞的不超过 P 个。',
      'Indexing activation slots by `microbatch % P` suffices: 1F1B guarantees at most P are in '
      + 'flight at once.'),
  ],
  pitfalls: [
    t('**一步里同时做前向和反向。** 那不是 1F1B，那是"把两步压成一步"——'
      + '气泡率会显得很好看，但真硬件上一张卡同一时刻只能做一件事。'
      + '判定要求干活的格子数正好等于总操作数，压步会立刻露馅。',
      '**Doing a forward and a backward in the same step.** That is not 1F1B, it is squeezing two '
      + 'steps into one. The bubble looks great but a real GPU does one thing at a time. The check '
      + 'requires busy cells to equal the operation count exactly, so squeezing shows up at once.'),
    t('**激活槽还是开 M 个。** 排程对了但显存没省 —— '
      + '1F1B 的显存收益完全来自"用完就复用"这一步。',
      '**Still allocating M activation slots.** The schedule is right but the memory is not saved; '
      + '1F1B\'s memory win comes entirely from reusing a slot as soon as it is consumed.'),
    t('**热身长度算反了。** 第 0 级热身最长（P-1 次），最后一级最短（0 次）。'
      + '反了的话流水线永远填不满。',
      '**Getting the warmup lengths backwards.** Stage 0 warms up longest (P-1) and the last stage '
      + 'not at all. Reversed, the pipeline never fills.'),
  ],
  extension: t(
    '这一关实测的两个数值得放在一起看：'
    + '\n\n'
    + '| | 步数 | 气泡率 | 每卡显存 | 总工作量 |'
    + '\n| --- | --- | --- | --- | --- |'
    + '\n| GPipe | 78 | 0.1795 | 8960 | 512 |'
    + '\n| 1F1B | 71 | **0.0986** | **2816** | 512 |'
    + '\n\n'
    + '气泡率 `(P-1)/(2M+P-1)` 对 `(P-1)/(M+P-1)`，差了将近一倍；'
    + '显存差 3.2 倍。而**总工作量一格不差**。'
    + '\n\n'
    + '教科书里常说"GPipe 与 1F1B 的气泡率相同"，那是把一个 microbatch 的'
    + '前向加反向算成一个时间单位时的说法。按真实的步来数（前向一步、反向一步），'
    + 'GPipe 要多付一次 fill/drain。这一关的数字是**数出来的**，不是套的公式 ——'
    + '这也是为什么值得自己跑一遍。'
    + '\n\n'
    + '再往下还有 interleaved 1F1B（Megatron 的 virtual pipeline）：'
    + '把每台机器负责的层拆成几段不连续的，一台机器在流水线里出现多次。'
    + '级数从 P 变成 P × v，气泡率降到 `(P-1)/(v·M+P-1)`，'
    + '代价是通信次数乘 v 倍。'
    + '\n\n'
    + '还有一个方向是 **zero-bubble**：把反向拆成"算输入梯度"和"算权重梯度"两半，'
    + '后者不阻塞流水线、可以填进气泡里。'
    + '这些都建立在同一个观察上 —— 气泡是**排程**问题，不是带宽问题。',
    'The two measured numbers are worth seeing together:\n\n'
    + '| | steps | bubble | memory per GPU | total work |\n'
    + '| --- | --- | --- | --- | --- |\n'
    + '| GPipe | 78 | 0.1795 | 8960 | 512 |\n'
    + '| 1F1B | 71 | **0.0986** | **2816** | 512 |\n\n'
    + 'The bubble is `(P-1)/(2M+P-1)` against `(P-1)/(M+P-1)`, nearly a factor of two, and memory '
    + 'differs by 3.2x, with **exactly the same total work**.\n\n'
    + 'Textbooks often say GPipe and 1F1B have the same bubble, which holds when a microbatch\'s '
    + 'forward and backward count as one time unit. Counted in real steps, where forward and '
    + 'backward each take one, GPipe pays an extra fill and drain. These numbers were **counted**, '
    + 'not derived from a formula, which is exactly why it is worth running yourself.\n\n'
    + 'Beyond this lies interleaved 1F1B (Megatron\'s virtual pipeline): split each machine\'s layers '
    + 'into several non-contiguous chunks so a machine appears in the pipeline more than once. The '
    + 'stage count becomes P x v and the bubble falls to `(P-1)/(v*M+P-1)`, at the cost of v times '
    + 'as many transfers.\n\n'
    + 'Another direction is **zero-bubble**: split backward into computing input gradients and '
    + 'computing weight gradients, where the latter does not block the pipeline and can be dropped '
    + 'into the bubbles. All of these rest on the same observation, that the bubble is a '
    + '**scheduling** problem, not a bandwidth one.'
  ),
  gpu: {
    world: CLUSTER_WORLD,
    files: {
      '/root/pipeline.cu': code`
        #include "engine.h"
        #include "cluster.h"
        #include "containers.h"

        ${PP_KERNELS}

        int main(void) {
          const int P = 8; const int M = 32; const int SIZE = 64;
          int inbuf[8]; int grad[8];
          for (int d = 0; d < P; ++d) {
            cudaSetDevice(d);
            float* a; float* g;
            cudaMalloc((void**)&a, SIZE * 4);
            cudaMalloc((void**)&g, SIZE * 4);
            inbuf[d] = a; grad[d] = g;
          }
          // 每个 (microbatch, stage) 的激活都要留着
          int acts = vec_new();
          for (int mb = 0; mb < M; ++mb) {
            for (int d = 0; d < P; ++d) {
              cudaSetDevice(d);
              float* a; cudaMalloc((void**)&a, SIZE * 4);
              vec_push(acts, a);
            }
          }

          // TODO: GPipe —— 前向流水线**完全排空**之后才开始反向，
          //       于是 fill / drain 付了两次；而且每级要同时存 M 份激活。
          //       改成 1F1B：warmup / steady / cooldown，一步只做一件事。
          //
          // 前向：M + P - 1 步
          for (int step = 0; step < M + P - 1; ++step) {
            for (int d = 0; d < P; ++d) {
              int mb = step - d;
              if (mb >= 0 && mb < M) {
                cudaSetDevice(d);
                forward<<<1, 64>>>(vec_get(acts, mb * P + d), inbuf[d], SIZE);
              }
            }
            pipe_step();
          }
          // 反向：再 M + P - 1 步
          for (int step = 0; step < M + P - 1; ++step) {
            for (int d = P - 1; d >= 0; --d) {
              int mb = step - (P - 1 - d);
              if (mb >= 0 && mb < M) {
                cudaSetDevice(d);
                backward<<<1, 64>>>(grad[d], vec_get(acts, mb * P + d), SIZE);
              }
            }
            pipe_step();
          }
          printf("gpipe\n");
          return 0;
        }
      `,
    },
    bench: ppBench,
    referenceFiles: {
      '/root/pipeline.cu': code`
        #include "engine.h"
        #include "cluster.h"
        #include "containers.h"

        ${PP_KERNELS}

        int main(void) {
          const int P = 8; const int M = 32; const int SIZE = 64;
          int inbuf[8]; int grad[8];
          for (int d = 0; d < P; ++d) {
            cudaSetDevice(d);
            float* a; float* g;
            cudaMalloc((void**)&a, SIZE * 4);
            cudaMalloc((void**)&g, SIZE * 4);
            inbuf[d] = a; grad[d] = g;
          }
          // **每级只开 P 个激活槽**，循环复用 —— 这是 1F1B 换来的东西
          int acts = vec_new();
          for (int d = 0; d < P; ++d) {
            cudaSetDevice(d);
            for (int slot = 0; slot < P; ++slot) {
              float* a; cudaMalloc((void**)&a, SIZE * 4);
              vec_push(acts, a);
            }
          }

          for (int step = 0; step < 2 * M + P - 1; ++step) {
            for (int d = 0; d < P; ++d) {
              int k = step - d;
              if (k < 0) { continue; }
              if (k >= 2 * M) { continue; }
              int w = P - 1 - d;
              if (w > M) { w = M; }

              int isForward = 0;
              int mb = 0;
              if (k < w) {
                isForward = 1; mb = k;
              } else {
                int j = k - w;
                int steady = 2 * (M - w);
                if (j < steady) {
                  if (j % 2 == 0) { isForward = 1; mb = w + j / 2; }
                  else { isForward = 0; mb = (j - 1) / 2; }
                } else {
                  isForward = 0; mb = M - w + (j - steady);
                }
              }

              cudaSetDevice(d);
              if (isForward == 1) {
                forward<<<1, 64>>>(vec_get(acts, d * P + (mb % P)), inbuf[d], SIZE);
              } else {
                backward<<<1, 64>>>(grad[d], vec_get(acts, d * P + (mb % P)), SIZE);
              }
            }
            pipe_step();
          }
          printf("1f1b\n");
          return 0;
        }
      `,
    },
  },
  specs: [
    spec('pipeline.spec.ts', code`
      const lab = require('@gpu/lab');
      const P = ${PP_STAGES};
      const M = ${PP_MICROBATCHES};

      describe('流水线并行', () => {
        it('**总工作量一格不少** —— 压步会立刻露馅', async () => {
          await lab.buildAndRun();
          // 每个 microbatch 在每一级都要前向与反向各一次
          expect(lab.pipeline().busySlots).toBe(2 * M * P);
        });

        it('气泡率降下来了', async () => {
          await lab.buildAndRun();
          expect(lab.pipeline().bubbleRatio).toBeLessThanOrEqual(0.12);
        });

        it('总步数是 2M + P - 1，不是 2(M + P - 1)', async () => {
          await lab.buildAndRun();
          expect(lab.pipeline().steps).toBe(2 * M + P - 1);
        });

        it('**每级只留 P 份激活**，不是 M 份', async () => {
          await lab.buildAndRun();
          expect(lab.peakBytes()).toBeLessThanOrEqual(4 * 1024);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.pipeline.bubbleRatio', op: 'lte', value: 0.12,
      zh: '流水线气泡率（GPipe 是 0.1795）', en: 'pipeline bubble ratio (0.1795 for GPipe)',
      unit: 'ratio', dimension: 'throughput',
    }),
    gate({
      metric: 'gpu.memoryPeakBytes', op: 'lte', value: 4 * 1024,
      zh: '每张卡的显存峰值（GPipe 是 8960 字节）',
      en: 'peak memory per GPU (8960 bytes for GPipe)',
      unit: 'byte', dimension: 'throughput',
    }),
    gate({
      metric: 'gpu.pipeline.busySlots', op: 'gte', value: 2 * PP_MICROBATCHES * PP_STAGES,
      zh: '干活的格子数 —— 少了就是压了步或漏了活，不是优化',
      en: 'busy cells: fewer means steps were squeezed or work dropped, not optimised',
      unit: 'slot', dimension: 'correctness',
    }),
  ],
  focus: ['throughput', 'correctness'],
};

/* ------------------------------------------------------------------ */
/* 第 27 关：通信与计算重叠                                              */
/* ------------------------------------------------------------------ */

const OV_DEVICES = 8;
const OV_CHUNKS = 8;
const OV_CHUNK = 64;

const OV_KERNELS = code`
  // 反向传播算出一块梯度
  __global__ void backwardChunk(float* grad, const float* act, int n) {
    int i = threadIdx.x;
    if (i < n) grad[i] = act[i] * 0.5f + 0.001f;
  }
  __global__ void fill(float* a, float v, int n) {
    int i = threadIdx.x;
    if (i < n) a[i] = v;
  }
`;

const ovBench = {
  sources: ['/root/overlap.cu'],
  buffers: [
    { name: 'check', length: OV_DEVICES, fill: { kind: 'zeros' } },
  ],
  launches: [],
};

const STAGE_27 = {
  id: 'comm-compute-overlap',
  title: t('通信与计算重叠 —— 别等算完了再发',
    'Overlapping communication and computation — do not wait to finish computing'),
  goal: t(
    [
      '第 23 关的梯度分桶把消息数降了下来，但那个版本仍然是**先算完再发**：',
      '反向传播全部结束，才开始 all-reduce。这段时间里通信链路完全闲着，',
      '而 all-reduce 期间计算单元又完全闲着。',
      '',
      '第 23 关的扩展里提过为什么 DDP 按参数的**反向顺序**分桶：',
      '反向传播从最后一层往前算，最后一层的梯度最先就绪 ——',
      '**第一个桶在反向刚开始不久就能发出去**。',
      '',
      '这一关把那件事做出来。反向分成 8 块，每算完一块就立刻发出去，',
      '同时接着算下一块。要用两个流：',
      '',
      '```cuda',
      'int compute;',
      'cudaStreamCreate(&compute);',
      '',
      'for (int c = 0; c < CHUNKS; ++c) {',
      '  // 这一块的反向挂在 compute 流上，**不等它**',
      '  backwardChunk<<<1, 64, 0, compute>>>(grad + c * CHUNK, act, CHUNK);',
      '  // 上一块的通信这时候发出去，和这一块的计算重叠',
      '  ...',
      '}',
      '```',
      '',
      '重叠率是这么数的：**发起一次集合操作时，别的流上还有没有没同步过的 kernel。**',
      '有就算这次通信重叠了。',
      '',
      '```',
      '重叠率 = 重叠了的通信字节数 / 总通信字节数',
      '```',
      '',
      '⚠️ 这个子集是**即时执行**的，流不改变执行顺序，也不检测跨流的数据竞争。',
      '真卡上把有依赖的活放到不同的流上而不 `cudaStreamWaitEvent`，会静默出错。',
      '这一关的分块之间本来就是独立的，所以不会踩到 —— 但别养成习惯。',
      '',
      '```bash',
      'nvcc -o bench overlap.cu && ./bench',
      '```',
      '',
      '**通关标准**',
      '',
      '- 重叠率 ≥ 0.7（先算完再发是 0）',
      '- 通信总量与消息数都不变 —— 重叠不改变搬多少、发几条',
    ].join('\n'),
    [
      'The gradient bucketing of stage 23 cut the message count, but it still **computes everything',
      'before sending anything**: backward finishes, then the all-reduce starts. The links idle for',
      'the whole backward pass, and the compute units idle for the whole all-reduce.',
      '',
      'Stage 23\'s extension mentioned why DDP buckets in **reverse** parameter order: backward runs',
      'from the last layer forward, so the last layer\'s gradients are ready first and **the first',
      'bucket can go out shortly after backward begins**.',
      '',
      'This stage builds that. Backward is split into 8 chunks; each one is sent as soon as it is',
      'computed, while the next one computes. That needs two streams:',
      '',
      '```cuda',
      'int compute;',
      'cudaStreamCreate(&compute);',
      '',
      'for (int c = 0; c < CHUNKS; ++c) {',
      '  // this chunk\'s backward goes on the compute stream, and we do NOT wait for it',
      '  backwardChunk<<<1, 64, 0, compute>>>(grad + c * CHUNK, act, CHUNK);',
      '  // the previous chunk\'s collective goes out now, overlapping this chunk\'s compute',
      '  ...',
      '}',
      '```',
      '',
      'The overlap is counted like this: **when a collective is issued, is there unsynchronised',
      'kernel work outstanding on another stream?** If so, that collective counts as overlapped.',
      '',
      '```',
      'overlap = overlapped communication bytes / total communication bytes',
      '```',
      '',
      '⚠️ This subset executes **eagerly**; streams do not change execution order and cross-stream',
      'data hazards are not detected. On real hardware, putting dependent work on different streams',
      'without `cudaStreamWaitEvent` fails silently. The chunks here are genuinely independent so it',
      'cannot bite, but do not build the habit.',
      '',
      '```bash',
      'nvcc -o bench overlap.cu && ./bench',
      '```',
      '',
      '**To pass**',
      '',
      '- overlap ratio at least 0.7 (0 when computing before sending)',
      '- unchanged total bytes and message count: overlap changes neither',
    ].join('\n')
  ),
  checklist: [
    t('建一个计算流', 'Create a compute stream'),
    t('每算完一块就发一块，不等全部算完',
      'Send each chunk as soon as it is computed, without waiting for the rest'),
    t('计算挂在计算流上，通信留在默认流',
      'Put the compute on the compute stream and leave the collectives on the default stream'),
  ],
  hints: [
    t('顺序很关键：**先发起这一块的计算，再发上一块的通信**。'
      + '反过来的话通信发出去时计算还没挂上，就不算重叠。',
      'Order matters: **issue this chunk\'s compute first, then the previous chunk\'s collective**. '
      + 'The other way round the collective goes out before any compute is outstanding, and does not '
      + 'count as overlapped.'),
    t('循环结束后还有最后一块没发 —— 补一次。',
      'The last chunk is still unsent after the loop; flush it.'),
  ],
  pitfalls: [
    t('**计算和通信放在同一个流上。** 真卡上同一个流是严格串行的，'
      + '所以那根本没有重叠 —— 而代码看起来完全像是重叠了。'
      + '这是这类优化里最常见的假重叠。',
      '**Putting compute and communication on the same stream.** A stream is strictly serial on real '
      + 'hardware, so nothing overlaps, while the code looks exactly as though it does. This is the '
      + 'most common false overlap in this kind of optimisation.'),
    t('**每块之后就 cudaStreamSynchronize。** 那等于把异步又变回同步了，'
      + '重叠率直接掉回 0。同步要留到最后。',
      '**Calling cudaStreamSynchronize after every chunk.** That turns the asynchrony back into '
      + 'synchrony and the overlap ratio drops to zero. Synchronise at the end.'),
  ],
  extension: t(
    '重叠是「不改变工作量、只改变时间安排」这一类优化里最纯粹的一个：'
    + '通信总量不变、消息数不变、计算量不变，变的只是**发起的时机**。'
    + '\n\n'
    + '真实系统里重叠无处不在：'
    + 'DDP 的反向顺序分桶（第 23 关）、'
    + 'ZeRO-3 在用到某层权重之前就把它 all-gather 出来、'
    + '流水线并行里一级的通信和另一级的计算天然重叠（第 26 关）、'
    + '以及张量并行里把 all-reduce 拆开、和后面的矩阵乘按块交错。'
    + '\n\n'
    + '重叠的上限由两件事定死：**通信时间与计算时间的比值**，'
    + '以及**依赖链允许你提前多久发出去**。'
    + '如果通信比计算长，重叠再好也只是把计算藏进通信里，'
    + '总时间还是通信时间 —— 这时候该做的是第 22、23 关那种降低通信本身的事。'
    + '所以真实调优的顺序通常是：先看通信/计算比，比值小于 1 才值得花力气做重叠。'
    + '\n\n'
    + '还要提醒一句这个子集的边界：它是即时执行的，'
    + '不检测跨流的数据竞争。真卡上流之间要靠 `cudaEvent` 建立依赖，'
    + '而漏建依赖的错误和第 3 关那个共享内存竞态是同一类 ——'
    + '**结果稳定地错，看起来像是算法不对。**',
    'Overlap is the purest member of the "same work, different schedule" family: same total bytes, '
    + 'same message count, same computation. Only the **timing of the issue** changes.\n\n'
    + 'Real systems overlap everywhere: DDP\'s reverse-order bucketing (stage 23), ZeRO-3 '
    + 'all-gathering a layer\'s weights before they are needed, pipeline parallelism where one '
    + 'stage\'s communication naturally overlaps another\'s compute (stage 26), and tensor '
    + 'parallelism splitting an all-reduce to interleave with the following matmul.\n\n'
    + 'Two things cap how much overlap can buy: **the ratio of communication time to compute time**, '
    + 'and **how far ahead the dependency chain lets you issue**. If communication takes longer than '
    + 'compute, perfect overlap merely hides the compute inside the communication and the total is '
    + 'still the communication time; at that point the thing to do is reduce communication itself, '
    + 'as in stages 22 and 23. Real tuning therefore usually starts by measuring the '
    + 'communication-to-compute ratio and only invests in overlap when it is below one.\n\n'
    + 'One more note on this subset\'s boundary: it executes eagerly and does not detect cross-stream '
    + 'data hazards. On real hardware streams are ordered with `cudaEvent`, and a missing dependency '
    + 'is the same class of bug as the shared-memory race in stage 3: **stably wrong, and it looks '
    + 'like the algorithm is broken.**'
  ),
  gpu: {
    world: CLUSTER_WORLD,
    files: {
      '/root/overlap.cu': code`
        #include "engine.h"
        #include "cluster.h"
        #include "cuda_runtime.h"
        #include "nccl.h"

        ${OV_KERNELS}

        int main(void) {
          const int N = ${OV_DEVICES};
          const int CHUNKS = ${OV_CHUNKS};
          const int CHUNK = ${OV_CHUNK};
          const int TOTAL = CHUNKS * CHUNK;

          int devs[8];
          for (int d = 0; d < N; ++d) devs[d] = d;
          int comms[8];
          ncclCommInitAll(comms, N, devs);

          int act[8]; int grad[8]; int out[8];
          for (int d = 0; d < N; ++d) {
            cudaSetDevice(d);
            float* a; float* g; float* o;
            cudaMalloc((void**)&a, TOTAL * 4);
            cudaMalloc((void**)&g, TOTAL * 4);
            cudaMalloc((void**)&o, TOTAL * 4);
            fill<<<1, 64>>>(a, (float)(d + 1), 64);
            act[d] = a; grad[d] = g; out[d] = o;
          }

          // TODO: 先把全部 8 块算完，再一块一块发出去。
          //       反向的整段时间里链路闲着，通信的整段时间里算力闲着。
          //       改成边算边发：这一块的计算挂在计算流上不等它，
          //       同时把上一块的通信发出去。
          for (int c = 0; c < CHUNKS; ++c) {
            for (int d = 0; d < N; ++d) {
              cudaSetDevice(d);
              backwardChunk<<<1, 64>>>(grad[d] + c * CHUNK, act[d], CHUNK);
            }
          }
          for (int c = 0; c < CHUNKS; ++c) {
            ncclGroupStart();
            for (int d = 0; d < N; ++d) {
              ncclAllReduce(grad[d] + c * CHUNK, out[d] + c * CHUNK, CHUNK,
                            ncclFloat, ncclSum, comms[d], 0);
            }
            ncclGroupEnd();
          }

          float* check = lab_buffer(0);
          float host[8];
          for (int d = 0; d < N; ++d) {
            cudaSetDevice(d);
            float one[1];
            cudaMemcpy(one, out[d], 4, cudaMemcpyDeviceToHost);
            host[d] = one[0];
          }
          cudaSetDevice(0);
          cudaMemcpy(check, host, N * 4, cudaMemcpyHostToDevice);
          return 0;
        }
      `,
    },
    bench: ovBench,
    referenceFiles: {
      '/root/overlap.cu': code`
        #include "engine.h"
        #include "cluster.h"
        #include "cuda_runtime.h"
        #include "nccl.h"

        ${OV_KERNELS}

        int main(void) {
          const int N = ${OV_DEVICES};
          const int CHUNKS = ${OV_CHUNKS};
          const int CHUNK = ${OV_CHUNK};
          const int TOTAL = CHUNKS * CHUNK;

          int devs[8];
          for (int d = 0; d < N; ++d) devs[d] = d;
          int comms[8];
          ncclCommInitAll(comms, N, devs);

          int act[8]; int grad[8]; int out[8];
          for (int d = 0; d < N; ++d) {
            cudaSetDevice(d);
            float* a; float* g; float* o;
            cudaMalloc((void**)&a, TOTAL * 4);
            cudaMalloc((void**)&g, TOTAL * 4);
            cudaMalloc((void**)&o, TOTAL * 4);
            fill<<<1, 64>>>(a, (float)(d + 1), 64);
            act[d] = a; grad[d] = g; out[d] = o;
          }

          // 计算挂在这个流上，通信留在默认流 —— 两个流才有重叠可言
          int compute;
          cudaStreamCreate(&compute);

          for (int c = 0; c < CHUNKS; ++c) {
            // 先发起这一块的计算，**不等它**
            for (int d = 0; d < N; ++d) {
              cudaSetDevice(d);
              backwardChunk<<<1, 64, 0, compute>>>(grad[d] + c * CHUNK, act[d], CHUNK);
            }
            // 再把上一块的通信发出去 —— 这时计算流上还有活在飞，算重叠。
            // 顺序反过来的话通信发出去时计算还没挂上，就不算了
            if (c > 0) {
              ncclGroupStart();
              for (int d = 0; d < N; ++d) {
                ncclAllReduce(grad[d] + (c - 1) * CHUNK, out[d] + (c - 1) * CHUNK, CHUNK,
                              ncclFloat, ncclSum, comms[d], 0);
              }
              ncclGroupEnd();
            }
          }

          // 最后一块还没发 —— 补上。这时计算流上仍有活，所以它也算重叠
          ncclGroupStart();
          for (int d = 0; d < N; ++d) {
            ncclAllReduce(grad[d] + (CHUNKS - 1) * CHUNK, out[d] + (CHUNKS - 1) * CHUNK, CHUNK,
                          ncclFloat, ncclSum, comms[d], 0);
          }
          ncclGroupEnd();
          cudaStreamSynchronize(compute);
          cudaStreamDestroy(compute);

          float* check = lab_buffer(0);
          float host[8];
          for (int d = 0; d < N; ++d) {
            cudaSetDevice(d);
            float one[1];
            cudaMemcpy(one, out[d], 4, cudaMemcpyDeviceToHost);
            host[d] = one[0];
          }
          cudaSetDevice(0);
          cudaMemcpy(check, host, N * 4, cudaMemcpyHostToDevice);
          return 0;
        }
      `,
    },
  },
  specs: [
    spec('overlap.spec.ts', code`
      const lab = require('@gpu/lab');
      const N = ${OV_DEVICES};
      const CHUNKS = ${OV_CHUNKS};
      const CHUNK = ${OV_CHUNK};

      describe('通信与计算重叠', () => {
        it('结果正确', async () => {
          await lab.buildAndRun();
          const check = lab.buffer('check');
          // 第 d 张卡的激活是 d+1，梯度是 0.5(d+1)+0.001，八张卡加起来
          let expected = 0;
          for (let d = 0; d < N; d += 1) expected += 0.5 * (d + 1) + 0.001;
          for (let d = 0; d < N; d += 1) {
            expect(Math.abs(check[d] - expected)).toBeLessThanOrEqual(1e-4);
          }
        });

        it('**重叠率上来了**', async () => {
          await lab.buildAndRun();
          expect(lab.comm().overlapRatio).toBeGreaterThanOrEqual(0.7);
        });

        it('通信总量没变 —— 重叠不改变搬多少', async () => {
          await lab.buildAndRun();
          expect(lab.comm().bytes).toBe(2 * (N - 1) * CHUNKS * CHUNK * 4);
        });

        it('消息数也没变 —— 还是 8 次集合操作', async () => {
          await lab.buildAndRun();
          expect(lab.comm().messages).toBe(CHUNKS * 2 * (N - 1) * N);
        });
      });
    `),
  ],
  gates: [
    ...SAFETY_GATES,
    gate({
      metric: 'gpu.comm.overlapRatio', op: 'gte', value: 0.7,
      zh: '和计算重叠了的通信占比（先算完再发是 0）',
      en: 'share of communication overlapped with compute (0 when computing first)',
      unit: 'ratio', dimension: 'throughput',
    }),
    gate({
      metric: 'gpu.comm.bytes', op: 'gte', value: 2 * 7 * 8 * 64 * 4,
      zh: '通信总量 —— 重叠不改变搬多少，少了就是漏了块',
      en: 'total bytes: overlap does not change this, so a drop means chunks were skipped',
      unit: 'byte', dimension: 'correctness',
    }),
  ],
  focus: ['throughput', 'correctness'],
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
  stages: [STAGE_1, STAGE_2, STAGE_3, STAGE_4, STAGE_5, STAGE_6, STAGE_7, STAGE_8, STAGE_9, STAGE_10, STAGE_11, STAGE_12, STAGE_13, STAGE_14, STAGE_15, STAGE_16, STAGE_17, STAGE_18, STAGE_19, STAGE_20, STAGE_21, STAGE_22, STAGE_23, STAGE_24, STAGE_25, STAGE_26, STAGE_27],
};
