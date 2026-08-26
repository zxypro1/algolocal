/**
 * warp 锁步执行器
 *
 * 核心：**一条指令派发一次，内部对 32 个 lane 循环**。指令派发的开销因此
 * 被摊薄 32 倍，这是整个执行模型跑得动的原因。
 *
 * 三件事在这里是「真的」而不是估的：
 *  - 发散：活跃掩码 + 结构化重汇聚栈，和真硬件对结构化控制流的处理一致；
 *  - 屏障：`__syncthreads()` 真的把 warp 挂起，等同 block 的其它 warp 到齐；
 *  - 访存计量：每条访存指令算 32 个地址，做扇区归并 / bank 冲突分析。
 *
 * 执行顺序完全确定（block 按 id、warp 按编号轮转），所以同一份代码跑两遍
 * 逐位相同 —— 这是判定门槛之一。**代价是竞态不会自己暴露**，得靠单独的
 * racecheck 主动检测。
 *
 * 性能纪律（生产环境实测约 1350 万条 warp 指令/秒，见 ir/program.ts 的说明）：
 *  1. 指令流是 `Int32Array`，不是对象数组；
 *  2. **热路径上不分配内存** —— `countSectors` / `countBankConflicts` 都用
 *     复用的暂存数组，计数器在循环里用局部变量攒着，退出时再写回；
 *  3. 收尾**不要用闭包**：闭包一旦捕获可变局部，V8 会把它们挪进堆上的
 *     context 对象，每条指令多出好几次堆访问。
 */
import { encode, type ExecutableKernel, type Program, ATOM, BIN, FN, OP, SFU_FNS, SHFL, SLOTS, SPACE, SREG, TY, UN } from '../ir/program';
import type { CompiledKernel } from '../ir/types';
import {
  addF32, divF32, expF32, fastDivF32, fastExpF32, fastLogF32, floatToInt, floatToUint,
  fmaF32, logF32, maxF32, minF32, mulF32, powF32, rsqrtF32, sqrtF32, subF32, tanhF32, toHalf,
  FP8_E4M3, FP8_E5M2, fp8ToStorage, storageToFp8,
} from './float';
import {
  LinearMemory, MemoryFault, SECTOR_BYTES, WARP_SIZE,
  countBankConflicts, countSectors,
} from './memory';
import type { RaceDetector } from './sanitizer';

export interface Dim3 {
  x: number;
  y: number;
  z: number;
}

export function dim3(x: number, y = 1, z = 1): Dim3 {
  return { x, y, z };
}

export interface LaunchConfig {
  grid: Dim3;
  block: Dim3;
}

/** kernel 实参：指针是地址（number），标量按声明的类型 */
export type KernelArg = number;

export interface GpuCounters {
  warpInsts: number;
  laneInsts: number;
  instFma: number;
  instLdSt: number;
  /**
   * 走特殊功能单元的指令：exp / log / rsqrt / tanh。
   *
   * 单独数是因为 **SFU 的吞吐是 FMA 的 1/8**，softmax 里那个 expf
   * 能不能成为瓶颈全看这个数。
   */
  instSfu: number;
  /** tensor core 的乘加次数 */
  instMma: number;
  /**
   * 记账指令：立即数与寄存器搬运。
   *
   * 我们的 IR **故意不做优化**，这样指令数才反映学员写了什么。
   * 但 const 与 mov 在任何真编译器里都会被折叠进操作数，硬件上并不存在。
   * 时序模型必须把它们扣掉，否则瓶颈归因会被这些幽灵指令带偏。
   */
  instBookkeeping: number;
  globalLoadRequests: number;
  globalStoreRequests: number;
  globalLoadSectors: number;
  globalStoreSectors: number;
  sharedLoadRequests: number;
  sharedStoreRequests: number;
  sharedBankConflicts: number;
  /**
   * local memory 的读写字节数。
   *
   * **不是 0 就说明有本该待在寄存器里的数组落到了显存上。**
   * 不做扇区分析 —— 真硬件把 local memory 按线程交错过，合并不是问题；
   * 问题是它根本不该被用到。
   */
  localReadBytes: number;
  localWriteBytes: number;
  divergentBranches: number;
  activeLanes: number;
  /** 原子操作次数（按 lane 算）—— 第 5 关的门槛读它 */
  atomics: number;
  /** warp 级交换指令条数 */
  shuffles: number;
  /**
   * warp 同步原语用错的次数：shuffle 读了一个不参与的 lane、
   * 或者 __syncwarp 的掩码里有 lane 没到。真卡上这些是未定义行为。
   */
  warpSyncErrors: number;
  barriers: number;
  blocksLaunched: number;
  /**
   * **提交到设备上的次数**，不是 block 数。
   *
   * 一次 `kernel<<<...>>>` 算一次；一次 `cudaGraphLaunch` 不管里面有
   * 多少个 kernel 也只算一次 —— 这正是 CUDA Graph 省下来的东西。
   * 真卡上每次提交有几微秒的固定开销，解码那种"每步计算量很小"的场景里
   * 它本身就能成为瓶颈。
   */
  kernelLaunches: number;
  warpsLaunched: number;
}

export function emptyCounters(): GpuCounters {
  return {
    warpInsts: 0, laneInsts: 0, instFma: 0, instLdSt: 0, instSfu: 0, instMma: 0, instBookkeeping: 0,
    globalLoadRequests: 0, globalStoreRequests: 0,
    globalLoadSectors: 0, globalStoreSectors: 0,
    sharedLoadRequests: 0, sharedStoreRequests: 0, sharedBankConflicts: 0,
    localReadBytes: 0, localWriteBytes: 0,
    divergentBranches: 0, activeLanes: 0,
    atomics: 0, shuffles: 0, warpSyncErrors: 0,
    barriers: 0, blocksLaunched: 0, warpsLaunched: 0, kernelLaunches: 0,
  };
}

export class KernelError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(line > 0 ? `第 ${line} 行：${message}` : message);
    this.name = 'KernelError';
    this.line = line;
  }
}

/** 重汇聚栈的一项 */
interface MaskFrame {
  origin: number;
  otherwise: number;
}

class Warp {
  pc = 0;
  active: number;
  readonly present: number;
  stack: MaskFrame[] = [];
  /**
   * 已经 return 掉的 lane。
   *
   * `if (i >= n) return;` 是 CUDA 里最常见的一句话，而它天生是发散的：
   * 尾块里有的 lane 该退出，有的还要接着算。`ret` 如果直接把整个 warp
   * 标记成结束，那些还没算完的 lane 就被一起带走了 —— 只有当 n 恰好是
   * 块大小的整数倍时才碰巧不出错。
   *
   * 所以 return 掉的 lane 记在这里，之后每一次恢复掩码都把它们排除掉。
   * 退出是**永久**的，这一点和 break 不同（break 只在当前循环内有效），
   * 所以一条掩码就够，不需要按层保存。
   */
  exited = 0;
  atBarrier = false;
  done = false;
  readonly regs: Float64Array;

  constructor(readonly index: number, present: number, numRegs: number) {
    this.present = present;
    this.active = present;
    this.regs = new Float64Array(Math.max(1, numRegs) * WARP_SIZE);
  }
}

export interface RunResult {
  counters: GpuCounters;
}

export interface RunOptions {
  memory: LinearMemory;
  sharedCapacity?: number;
  maxWarpInsts?: number;
  /**
   * 竞态检测器。
   *
   * **按需开启**：不给就一行额外代码都不跑。带上它每次访存要多四次影子读写，
   * 整体慢两三倍 —— 和现实里 compute-sanitizer 的代价是一个量级，
   * 也和现实里的用法一致（平时不挂，要查的时候单独跑一遍）。
   */
  raceDetector?: RaceDetector;
  /**
   * 宿主服务：CUDA runtime、printf、容器、起 kernel。
   *
   * **只有跑宿主程序时才给。** 设备侧的 kernel 里根本编不出 hostcall
   * 与 launch 这两条指令（编译器在 `ctx.host` 关着时就拦下了），
   * 所以这个字段为空对 kernel 执行是完全无害的。
   */
  host?: HostServices;
  /**
   * 用调用方给的这块内存当 local 空间。
   *
   * 宿主程序要用：`cudaMemcpy(..., cudaMemcpyHostToDevice)` 里的
   * 「主机端指针」就是 local 空间的地址，运行时那一层得能读到它。
   * 不给就照常自己开一块（kernel 都走这条路）。
   */
  localMemory?: LinearMemory;
}

/**
 * 宿主程序要用的平台能力。
 *
 * 由 `src/lib/gpulab/host/runtime.ts` 实现 —— VM 只管把指令翻译成调用，
 * 具体怎么分配显存、容器存在哪，是运行时那一层的事。
 */
export interface HostServices {
  /** 一次运行时调用；返回值写回 dst 寄存器 */
  call(fn: number, args: number[], line: number): number;
  /** `kernel<<<grid, block>>>(args)` */
  launch(name: string, grid: Dim3, block: Dim3, args: number[], line: number): void;
}

const DEFAULT_MAX_WARP_INSTS = 200_000_000;

export function launchKernel(
  kernel: CompiledKernel | ExecutableKernel,
  config: LaunchConfig,
  args: KernelArg[],
  options: RunOptions
): RunResult {
  const executable = 'program' in kernel ? kernel : encode(kernel);
  const counters = emptyCounters();
  new Executor(executable, config, args, options, counters).run();
  return { counters };
}

class Executor {
  private readonly shared: LinearMemory;
  private readonly local: LinearMemory;
  private readonly localBytesPerThread: number;
  private readonly addresses = new Int32Array(WARP_SIZE);
  /** shuffle 要先把源值快照下来 —— dst 和 src 可能是同一个寄存器 */
  private readonly shflScratch = new Float64Array(WARP_SIZE);
  /** 宿主调用的实参缓冲，复用同一个数组 */
  private readonly hostArgs: number[] = [];
  /** wmma 把整个 warp 的碎片拼成 16×16 用的暂存 */
  private readonly tileA = new Float64Array(256);
  private readonly tileB = new Float64Array(256);
  private readonly tileC = new Float64Array(256);
  private readonly maxWarpInsts: number;
  private readonly blockThreads: number;
  private readonly warpsPerBlock: number;
  private readonly program: Program;
  /** 参数值按类型规整过，避免每次 param 指令都判一遍 */
  private readonly argValues: Float64Array;

  constructor(
    private readonly kernel: ExecutableKernel,
    private readonly config: LaunchConfig,
    args: KernelArg[],
    private readonly options: RunOptions,
    private readonly counters: GpuCounters
  ) {
    this.program = kernel.program;
    const capacity = options.sharedCapacity ?? 48 * 1024;
    if (kernel.sharedBytes > capacity) {
      throw new KernelError(
        `这个 kernel 要 ${kernel.sharedBytes} 字节共享内存，超过了每个 block 的上限 ${capacity} 字节`,
        0
      );
    }
    this.shared = new LinearMemory(Math.max(4, kernel.sharedBytes), 'shared');
    this.localBytesPerThread = kernel.localBytes;
    this.maxWarpInsts = options.maxWarpInsts ?? DEFAULT_MAX_WARP_INSTS;
    this.blockThreads = config.block.x * config.block.y * config.block.z;
    if (this.blockThreads === 0) throw new KernelError('blockDim 不能是 0', 0);
    if (this.blockThreads > 1024) {
      throw new KernelError(`一个 block 最多 1024 个线程，这里是 ${this.blockThreads}`, 0);
    }
    this.warpsPerBlock = Math.ceil(this.blockThreads / WARP_SIZE);
    // local memory 是线程私有的，一个 block 一份就够 —— 我们一次只跑一个 block
    const localBytes = Math.max(4, this.localBytesPerThread * this.blockThreads);
    if (options.localMemory) {
      if (options.localMemory.capacity < localBytes) {
        throw new KernelError(
          `主机端要 ${localBytes} 字节局部内存，给的只有 ${options.localMemory.capacity} 字节`, 0
        );
      }
      this.local = options.localMemory;
    } else {
      this.local = new LinearMemory(localBytes, 'local');
    }
    if (args.length !== kernel.params.length) {
      throw new KernelError(
        `${kernel.name} 需要 ${kernel.params.length} 个参数，给了 ${args.length} 个`, 0
      );
    }
    this.argValues = new Float64Array(args.length);
    for (let i = 0; i < args.length; i += 1) {
      const ty = kernel.paramTypes[i];
      this.argValues[i] =
        ty === TY.F32 ? Math.fround(args[i]) : ty === TY.U32 ? args[i] >>> 0 : args[i] | 0;
    }
  }

  run(): void {
    const { grid } = this.config;
    for (let bz = 0; bz < grid.z; bz += 1) {
      for (let by = 0; by < grid.y; by += 1) {
        for (let bx = 0; bx < grid.x; bx += 1) {
          this.runBlock(bx, by, bz);
        }
      }
    }
  }

  private runBlock(bx: number, by: number, bz: number): void {
    this.counters.blocksLaunched += 1;
    const detector = this.options.raceDetector;
    if (detector) {
      const grid = this.config.grid;
      detector.beginBlock((bz * grid.y + by) * grid.x + bx, { x: bx, y: by, z: bz });
    }
    // 共享内存在 block 之间不保留内容。真卡上它是脏的；我们清零是为了确定性，
    // 这是一处已知分叉 —— 靠未初始化共享内存出错的程序在这里不会暴露。
    this.shared.reset();
    this.local.reset();

    const warps: Warp[] = [];
    for (let w = 0; w < this.warpsPerBlock; w += 1) {
      const first = w * WARP_SIZE;
      const count = Math.min(WARP_SIZE, this.blockThreads - first);
      const present = count === WARP_SIZE ? -1 : (1 << count) - 1;
      warps.push(new Warp(w, present, this.kernel.numRegs));
      this.counters.warpsLaunched += 1;
    }

    let cursor = 0;
    while (true) {
      let live = 0;
      let waiting = 0;
      for (const warp of warps) {
        if (warp.done) continue;
        live += 1;
        if (warp.atBarrier) waiting += 1;
      }
      if (live === 0) break;

      if (waiting === live) {
        // 全到齐了，一起放行
        this.counters.barriers += 1;
        // 屏障把 block 的执行切成一个个纪元 —— 竞态判据的核心
        if (detector) detector.passBarrier();
        for (const warp of warps) warp.atBarrier = false;
      } else if (waiting > 0) {
        // 有 warp 在等，还有 warp 活着 —— 先让活着的跑。但如果活着的
        // 全都跑完退出了，等的那些就永远等不到人了。
        let runnable = false;
        for (const warp of warps) if (!warp.done && !warp.atBarrier) { runnable = true; break; }
        if (!runnable) {
          throw new KernelError(
            '__syncthreads() 卡住了：block 里有 warp 已经退出，剩下的还在等它。' +
            '屏障必须让整个 block 都到达',
            0
          );
        }
      }

      const warp = warps[cursor % warps.length];
      cursor += 1;
      if (warp.done || warp.atBarrier) continue;
      this.runWarp(warp, bx, by, bz);
    }
  }

  /**
   * 跑一个 warp，直到它到达屏障或者结束。
   *
   * 计数器在这里用局部变量攒 —— 每条指令碰一次 `this.counters.x` 的话，
   * 光属性访问就能吃掉三成吞吐。
   */
  private runWarp(warp: Warp, bx: number, by: number, bz: number): void {
    const code = this.program.code;
    const pool = this.program.pool;
    const lines = this.program.lines;
    const regs = warp.regs;
    const addresses = this.addresses;
    const globalMemory = this.options.memory;
    const sharedMemory = this.shared;
    const localMemory = this.local;
    const localStride = this.localBytesPerThread;
    const block = this.config.block;
    const grid = this.config.grid;
    const argValues = this.argValues;
    const hostArgs = this.hostArgs;
    const counters = this.counters;
    const detector = this.options.raceDetector;
    const warpBase = warp.index * WARP_SIZE;

    // 计数器用局部变量攒着，出口再写回（理由见文件头第 3 条）
    let warpInsts = 0;
    let laneInsts = 0;
    let instFma = 0;
    let instLdSt = 0;
    let instSfu = 0;
    let instBookkeeping = 0;
    let divergent = 0;
    let atomics = 0;
    let shuffles = 0;
    let warpSyncErrors = 0;

    let pc = warp.pc;

    try {
      while (true) {
        if (pc < 0 || pc >= this.program.count) {
          warp.done = true;
          counters.warpInsts += warpInsts; counters.laneInsts += laneInsts;
          counters.instFma += instFma; counters.instLdSt += instLdSt;
          counters.instSfu += instSfu; counters.instBookkeeping += instBookkeeping;
          counters.divergentBranches += divergent;
          counters.atomics += atomics; counters.shuffles += shuffles;
          counters.warpSyncErrors += warpSyncErrors;
          return;
        }

        warpInsts += 1;
        if (counters.warpInsts + warpInsts > this.maxWarpInsts) {
          counters.warpInsts += warpInsts; counters.laneInsts += laneInsts;
          counters.instFma += instFma; counters.instLdSt += instLdSt;
          counters.instSfu += instSfu; counters.instBookkeeping += instBookkeeping;
          counters.divergentBranches += divergent;
          counters.atomics += atomics; counters.shuffles += shuffles;
          counters.warpSyncErrors += warpSyncErrors;
          throw new KernelError(
            `执行预算用光了（${this.maxWarpInsts} 条 warp 指令）—— 多半是循环没退出`,
            lines[pc]
          );
        }

        const at = pc * SLOTS;
        const op = code[at];
        const active = warp.active;
        const lanes = popcount(active);
        laneInsts += lanes;

        switch (op) {
          case OP.CONST: {
            const dst = code[at + 1] * WARP_SIZE;
            const ty = code[at + 3];
            const raw = pool[code[at + 2]];
            const value = ty === TY.F32 ? Math.fround(raw) : ty === TY.U32 ? raw >>> 0 : raw | 0;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if (active & (1 << lane)) regs[dst + lane] = value;
            }
            instBookkeeping += lanes;
            pc += 1;
            break;
          }

          case OP.MOV: {
            const dst = code[at + 1] * WARP_SIZE;
            const src = code[at + 2] * WARP_SIZE;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if (active & (1 << lane)) regs[dst + lane] = regs[src + lane];
            }
            instBookkeeping += lanes;
            pc += 1;
            break;
          }

          case OP.BIN: {
            const dst = code[at + 1] * WARP_SIZE;
            const a = code[at + 2] * WARP_SIZE;
            const b = code[at + 3] * WARP_SIZE;
            const kind = code[at + 4];
            const ty = code[at + 5];
            if (ty === TY.F32) this.binF32(regs, dst, a, b, kind, active, lines[pc]);
            else this.binInt(regs, dst, a, b, kind, ty === TY.U32, active, lines[pc]);
            pc += 1;
            break;
          }

          case OP.UN: {
            const dst = code[at + 1] * WARP_SIZE;
            const a = code[at + 2] * WARP_SIZE;
            const kind = code[at + 3];
            const ty = code[at + 4];
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if ((active & (1 << lane)) === 0) continue;
              const value = regs[a + lane];
              regs[dst + lane] =
                kind === UN.neg ? (ty === TY.F32 ? Math.fround(-value) : normalize(-value, ty))
                : kind === UN.not ? (value === 0 ? 1 : 0)
                : normalize(~value, ty);
            }
            pc += 1;
            break;
          }

          case OP.CVT: {
            const dst = code[at + 1] * WARP_SIZE;
            const a = code[at + 2] * WARP_SIZE;
            const from = code[at + 3];
            const to = code[at + 4];
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if ((active & (1 << lane)) === 0) continue;
              regs[dst + lane] = convert(regs[a + lane], from, to);
            }
            pc += 1;
            break;
          }

          case OP.SREG: {
            const dst = code[at + 1] * WARP_SIZE;
            const which = code[at + 2];
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if ((active & (1 << lane)) === 0) continue;
              const tid = warpBase + lane;
              let value: number;
              switch (which) {
                case SREG['tid.x']: value = tid % block.x; break;
                case SREG['tid.y']: value = ((tid / block.x) | 0) % block.y; break;
                case SREG['tid.z']: value = (tid / (block.x * block.y)) | 0; break;
                case SREG['ctaid.x']: value = bx; break;
                case SREG['ctaid.y']: value = by; break;
                case SREG['ctaid.z']: value = bz; break;
                case SREG['ntid.x']: value = block.x; break;
                case SREG['ntid.y']: value = block.y; break;
                case SREG['ntid.z']: value = block.z; break;
                case SREG['nctaid.x']: value = grid.x; break;
                case SREG['nctaid.y']: value = grid.y; break;
                case SREG['nctaid.z']: value = grid.z; break;
                default: value = WARP_SIZE; break;
              }
              regs[dst + lane] = value;
            }
            pc += 1;
            break;
          }

          case OP.PARAM: {
            const dst = code[at + 1] * WARP_SIZE;
            const value = argValues[code[at + 2]];
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if (active & (1 << lane)) regs[dst + lane] = value;
            }
            pc += 1;
            break;
          }

          case OP.LOCALBASE: {
            const dst = code[at + 1] * WARP_SIZE;
            const offset = code[at + 2];
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if ((active & (1 << lane)) === 0) continue;
              // 每个线程一份，按线程号排开
              regs[dst + lane] = (warpBase + lane) * localStride + offset;
            }
            pc += 1;
            break;
          }

          case OP.SHAREDBASE: {
            const dst = code[at + 1] * WARP_SIZE;
            const offset = code[at + 2];
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if (active & (1 << lane)) regs[dst + lane] = offset;
            }
            pc += 1;
            break;
          }

          case OP.LOAD: {
            const dst = code[at + 1] * WARP_SIZE;
            const addr = code[at + 2] * WARP_SIZE;
            const space = code[at + 3];
            const ty = code[at + 4];
            const memory = space === SPACE.GLOBAL ? globalMemory
              : space === SPACE.SHARED ? sharedMemory : localMemory;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if ((active & (1 << lane)) === 0) continue;
              const address = regs[addr + lane] | 0;
              addresses[lane] = address;
              regs[dst + lane] =
                ty === TY.F32 ? memory.readF32(address)
                : ty === TY.U32 ? memory.readU32(address)
                : memory.readI32(address);
            }
            if (space === SPACE.GLOBAL) {
              counters.globalLoadRequests += 1;
              counters.globalLoadSectors += countSectors(addresses, active);
            } else if (space === SPACE.SHARED) {
              counters.sharedLoadRequests += 1;
              counters.sharedBankConflicts += countBankConflicts(addresses, active);
            } else {
              counters.localReadBytes += lanes * 4;
            }
            // local memory 是线程私有的，不可能有竞态，不用喂给检测器
            if (detector && space !== SPACE.LOCAL) {
              const name = space === SPACE.GLOBAL ? 'global' : 'shared';
              const line = lines[pc];
              for (let lane = 0; lane < WARP_SIZE; lane += 1) {
                if (active & (1 << lane)) {
                  detector.record(name, addresses[lane], warpBase + lane, 'read', line);
                }
              }
            }
            instLdSt += lanes;
            pc += 1;
            break;
          }

          case OP.STORE: {
            const addr = code[at + 1] * WARP_SIZE;
            const src = code[at + 2] * WARP_SIZE;
            const space = code[at + 3];
            const ty = code[at + 4];
            const memory = space === SPACE.GLOBAL ? globalMemory
              : space === SPACE.SHARED ? sharedMemory : localMemory;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if ((active & (1 << lane)) === 0) continue;
              const address = regs[addr + lane] | 0;
              addresses[lane] = address;
              const value = regs[src + lane];
              if (ty === TY.F32) memory.writeF32(address, value);
              else if (ty === TY.U32) memory.writeU32(address, value);
              else memory.writeI32(address, value);
            }
            if (space === SPACE.GLOBAL) {
              counters.globalStoreRequests += 1;
              counters.globalStoreSectors += countSectors(addresses, active);
            } else if (space === SPACE.SHARED) {
              counters.sharedStoreRequests += 1;
              counters.sharedBankConflicts += countBankConflicts(addresses, active);
            } else {
              counters.localWriteBytes += lanes * 4;
            }
            if (detector && space !== SPACE.LOCAL) {
              const name = space === SPACE.GLOBAL ? 'global' : 'shared';
              const line = lines[pc];
              for (let lane = 0; lane < WARP_SIZE; lane += 1) {
                if (active & (1 << lane)) {
                  detector.record(name, addresses[lane], warpBase + lane, 'write', line);
                }
              }
            }
            instLdSt += lanes;
            pc += 1;
            break;
          }

          case OP.JMP:
            pc = code[at + 1];
            break;

          case OP.PUSH: {
            const cond = code[at + 1] * WARP_SIZE;
            let taken = 0;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if ((active & (1 << lane)) === 0) continue;
              if (regs[cond + lane] !== 0) taken |= 1 << lane;
            }
            const otherwise = active & ~taken;
            if (taken !== 0 && otherwise !== 0) divergent += 1;
            warp.stack.push({ origin: active, otherwise });
            warp.active = taken;
            pc = taken === 0 ? code[at + 2] : pc + 1;
            break;
          }

          case OP.SWAP: {
            const frame = warp.stack[warp.stack.length - 1];
            if (!frame) throw new KernelError('内部错误：swap 时重汇聚栈是空的', lines[pc]);
            warp.active = frame.otherwise & ~warp.exited;
            frame.otherwise = 0;
            pc = warp.active === 0 ? code[at + 1] : pc + 1;
            break;
          }

          case OP.POP: {
            const frame = warp.stack.pop();
            if (!frame) throw new KernelError('内部错误：pop 时重汇聚栈是空的', lines[pc]);
            warp.active = frame.origin & ~warp.exited;
            pc += 1;
            break;
          }

          case OP.LOOP:
            warp.stack.push({ origin: active, otherwise: 0 });
            pc += 1;
            break;

          case OP.LCOND: {
            const cond = code[at + 1] * WARP_SIZE;
            let taken = 0;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if ((active & (1 << lane)) === 0) continue;
              if (regs[cond + lane] !== 0) taken |= 1 << lane;
            }
            if (taken !== 0 && taken !== active) divergent += 1;
            warp.active = taken & ~warp.exited;
            pc = warp.active === 0 ? code[at + 2] : pc + 1;
            break;
          }

          case OP.BAR: {
            // 屏障必须由整个 block 到达。一个 warp 在分歧区里到达屏障，
            // 真卡上是未定义行为（多半挂死）—— 明确报错，不放过去。
            if (warp.active !== warp.present) {
              throw new KernelError(
                '__syncthreads() 出现在发散的分支里：这个 warp 只有一部分 lane 到达了屏障。' +
                '真卡上这是未定义行为，通常直接挂死。把屏障挪到所有线程都会执行到的地方',
                lines[pc]
              );
            }
            warp.atBarrier = true;
            warp.pc = pc + 1;
            counters.warpInsts += warpInsts; counters.laneInsts += laneInsts;
            counters.instFma += instFma; counters.instLdSt += instLdSt;
          counters.instSfu += instSfu; counters.instBookkeeping += instBookkeeping;
            counters.divergentBranches += divergent;
          counters.atomics += atomics; counters.shuffles += shuffles;
          counters.warpSyncErrors += warpSyncErrors;
            return;
          }

          case OP.CALL: {
            const dst = code[at + 1] * WARP_SIZE;
            const fn = code[at + 2];
            const a0 = code[at + 4] * WARP_SIZE;
            const a1 = code[at + 5] * WARP_SIZE;
            const a2 = code[at + 6] * WARP_SIZE;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if ((active & (1 << lane)) === 0) continue;
              const x = regs[a0 + lane];
              const y = regs[a1 + lane];
              const z = regs[a2 + lane];
              let out: number;
              switch (fn) {
                case FN.fmaf: out = fmaF32(x, y, z); break;
                case FN.fabsf: out = Math.fround(Math.abs(x)); break;
                case FN.fminf: out = minF32(x, y); break;
                case FN.fmaxf: out = maxF32(x, y); break;
                case FN.sqrtf: out = sqrtF32(x); break;
                case FN.rsqrtf: out = rsqrtF32(x); break;
                case FN.expf: out = expF32(x); break;
                case FN.logf: out = logF32(x); break;
                case FN.tanhf: out = tanhF32(x); break;
                case FN.powf: out = powF32(x, y); break;
                case FN.__expf: out = fastExpF32(x); break;
                case FN.__logf: out = fastLogF32(x); break;
                case FN.__fdividef: out = fastDivF32(x, y); break;
                case FN.min: out = Math.min(x | 0, y | 0) | 0; break;
                case FN.max: out = Math.max(x | 0, y | 0) | 0; break;
                case FN.abs: out = Math.abs(x | 0) | 0; break;
                case FN.__popc: out = popcount(x | 0); break;
                case FN.__clz: out = (x | 0) === 0 ? 32 : Math.clz32(x >>> 0); break;
                // fp8：签名是 (值, 饱和模式, 格式)，**格式是第三个参数**。
                // 读成第二个的话 __NV_SATFINITE（= 1）会被当成 E5M2，
                // 于是每一次「E4M3 量化」其实都跑成了 E5M2。
                case FN.__nv_cvt_float_to_fp8:
                  out = fp8ToStorage(x, z === 1 ? FP8_E5M2 : FP8_E4M3, y === 1);
                  break;
                case FN.__nv_cvt_fp8_to_halfraw:
                  // 真 API 的返回类型就是 half。fp8 的每个值 fp16 都装得下，
                  // 所以这一道舍入不改值，但类型语义得对。
                  out = toHalf(storageToFp8(x | 0, y === 1 ? FP8_E5M2 : FP8_E4M3));
                  break;
                // __ffs 是 1 起算的最低置位位号，0 表示没有置位
                default: out = (x | 0) === 0 ? 0 : 32 - Math.clz32(((x | 0) & -(x | 0)) >>> 0); break;
              }
              regs[dst + lane] = out;
            }
            if (fn === FN.fmaf) instFma += lanes;
            // 超越函数走 SFU，吞吐只有 FMA 的 1/8
            else if (SFU_FNS[fn]) instSfu += lanes;
            pc += 1;
            break;
          }

          /**
           * 宿主运行时调用。
           *
           * 宿主程序只有一个 lane 在跑，所以这里只看 lane 0；
           * 如果哪天设备侧真的编出了这条指令，那是个 bug，明确炸出来
           * 比悄悄按 lane 0 算要好。
           */
          case OP.HOSTCALL: {
            const services = this.options.host;
            if (!services) {
              throw new KernelError('这段代码用到了宿主运行时，但当前不是宿主程序', lines[pc]);
            }
            if (active !== 1) {
              throw new KernelError('宿主运行时调用只能在单个线程上发生', lines[pc]);
            }
            const dst = code[at + 1] * WARP_SIZE;
            const fn = code[at + 2];
            const argc = code[at + 3];
            hostArgs.length = 0;
            for (let i = 0; i < argc; i += 1) hostArgs.push(regs[code[at + 4 + i] * WARP_SIZE]);
            regs[dst] = services.call(fn, hostArgs, lines[pc]);
            instBookkeeping += lanes;
            pc += 1;
            break;
          }

          case OP.LAUNCH: {
            const services = this.options.host;
            if (!services) {
              throw new KernelError('这段代码起了 kernel，但当前不是宿主程序', lines[pc]);
            }
            const site = this.kernel.launches?.[code[at + 1]];
            if (!site) throw new KernelError('起 kernel 的现场丢了', lines[pc]);
            const grid = {
              x: regs[site.grid[0] * WARP_SIZE] | 0,
              y: regs[site.grid[1] * WARP_SIZE] | 0,
              z: regs[site.grid[2] * WARP_SIZE] | 0,
            };
            const block = {
              x: regs[site.block[0] * WARP_SIZE] | 0,
              y: regs[site.block[1] * WARP_SIZE] | 0,
              z: regs[site.block[2] * WARP_SIZE] | 0,
            };
            hostArgs.length = 0;
            for (const reg of site.args) hostArgs.push(regs[reg * WARP_SIZE]);
            services.launch(site.kernel, grid, block, hostArgs.slice(), lines[pc]);
            instBookkeeping += lanes;
            pc += 1;
            break;
          }

          case OP.SHFL: {
            const dst = code[at + 1] * WARP_SIZE;
            const src = code[at + 2] * WARP_SIZE;
            const laneArg = code[at + 3] * WARP_SIZE;
            const maskReg = code[at + 4] * WARP_SIZE;
            const mode = code[at + 5];
            const width = code[at + 6];
            const scratch = this.shflScratch;

            // 先快照：dst 有可能就是 src
            for (let lane = 0; lane < WARP_SIZE; lane += 1) scratch[lane] = regs[src + lane];

            // 参与者 = 调用方给的掩码 ∩ 当前活跃的 lane
            let participants = active;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if (active & (1 << lane)) { participants = active & (regs[maskReg + lane] | 0); break; }
            }

            const segMask = width - 1;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if ((active & (1 << lane)) === 0) continue;
              const delta = regs[laneArg + lane] | 0;
              const inSeg = lane & segMask;
              let target: number;
              switch (mode) {
                case SHFL.idx: target = delta & segMask; break;
                case SHFL.up: target = inSeg - delta; break;
                case SHFL.down: target = inSeg + delta; break;
                default: target = inSeg ^ delta; break;
              }
              // 越出本段就是「原地不动」，和真硬件一致
              if (target < 0 || target >= width) target = inSeg;
              const srcLane = (lane & ~segMask) | target;
              if ((participants & (1 << srcLane)) === 0) {
                // 真卡上这里是未定义值。给 0 并记一笔，好让 sanitizer 说得出话。
                warpSyncErrors += 1;
                regs[dst + lane] = 0;
              } else {
                regs[dst + lane] = scratch[srcLane];
              }
            }
            shuffles += 1;
            pc += 1;
            break;
          }

          case OP.BALLOT: {
            const dst = code[at + 1] * WARP_SIZE;
            const pred = code[at + 2] * WARP_SIZE;
            const maskReg = code[at + 3] * WARP_SIZE;
            let participants = active;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if (active & (1 << lane)) { participants = active & (regs[maskReg + lane] | 0); break; }
            }
            let voted = 0;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if ((participants & (1 << lane)) === 0) continue;
              if (regs[pred + lane] !== 0) voted |= 1 << lane;
            }
            const result = voted >>> 0;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if (active & (1 << lane)) regs[dst + lane] = result;
            }
            pc += 1;
            break;
          }

          case OP.ACTIVEMASK: {
            const dst = code[at + 1] * WARP_SIZE;
            const value = active >>> 0;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if (active & (1 << lane)) regs[dst + lane] = value;
            }
            pc += 1;
            break;
          }

          case OP.SYNCWARP: {
            // 我们的 lane 本来就是锁步的，所以这条指令语义上是空操作。
            // 但它是一个**检查点**：掩码里点了名却没到的 lane，
            // 在真卡上会让这条指令行为未定义。
            const maskReg = code[at + 1] * WARP_SIZE;
            let requested = active;
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if (active & (1 << lane)) { requested = regs[maskReg + lane] | 0; break; }
            }
            if ((requested & warp.present & ~active) !== 0) warpSyncErrors += 1;
            pc += 1;
            break;
          }

          case OP.ATOM: {
            const dst = code[at + 1] * WARP_SIZE;
            const addr = code[at + 2] * WARP_SIZE;
            const value = code[at + 3] * WARP_SIZE;
            const kind = code[at + 4];
            const atomSpace = code[at + 5];
            const ty = code[at + 6];
            const compare = code[at + 7] * WARP_SIZE;
            const memory = atomSpace === SPACE.GLOBAL ? globalMemory
              : atomSpace === SPACE.SHARED ? sharedMemory : localMemory;

            // **按 lane 号从小到大依次执行。**
            // 真卡上原子操作的完成顺序是不定的，这正是「同样的种子、同样的
            // 数据，loss 曲线对不上」的常见来源。我们必须给一个确定的顺序
            // （否则重放门槛不成立），所以这里是一处**已知分叉**，
            // primer 里要专门讲。
            for (let lane = 0; lane < WARP_SIZE; lane += 1) {
              if ((active & (1 << lane)) === 0) continue;
              const address = regs[addr + lane] | 0;
              const operand = regs[value + lane];
              const old = ty === TY.F32 ? memory.readF32(address)
                : ty === TY.U32 ? memory.readU32(address) : memory.readI32(address);
              let next: number;
              if (ty === TY.F32) {
                switch (kind) {
                  case ATOM.add: next = Math.fround(old + operand); break;
                  case ATOM.sub: next = Math.fround(old - operand); break;
                  case ATOM.exch: next = operand; break;
                  case ATOM.min: next = old < operand ? old : operand; break;
                  case ATOM.max: next = old > operand ? old : operand; break;
                  case ATOM.cas: next = old === regs[compare + lane] ? operand : old; break;
                  default:
                    throw new KernelError('位运算的原子操作不能用在 float 上', lines[pc]);
                }
                memory.writeF32(address, next);
              } else {
                const o = ty === TY.U32 ? old >>> 0 : old | 0;
                const v = ty === TY.U32 ? operand >>> 0 : operand | 0;
                switch (kind) {
                  case ATOM.add: next = o + v; break;
                  case ATOM.sub: next = o - v; break;
                  case ATOM.exch: next = v; break;
                  case ATOM.min: next = o < v ? o : v; break;
                  case ATOM.max: next = o > v ? o : v; break;
                  case ATOM.and: next = o & v; break;
                  case ATOM.or: next = o | v; break;
                  case ATOM.xor: next = o ^ v; break;
                  default: next = o === (regs[compare + lane] | 0) ? v : o; break;
                }
                next = ty === TY.U32 ? next >>> 0 : next | 0;
                if (ty === TY.U32) memory.writeU32(address, next);
                else memory.writeI32(address, next);
              }
              regs[dst + lane] = old;
              atomics += 1;
            }
            // 原子操作是并发更新的**正确**做法，不该被 racecheck 报成竞态 ——
            // 真的 racecheck 也不报它们。所以这里不喂给检测器。
            instLdSt += lanes;
            pc += 1;
            break;
          }

          case OP.WMMA_FILL: {
            const base = code[at + 1];
            const slots = code[at + 2];
            const value = code[at + 3] * WARP_SIZE;
            for (let slot = 0; slot < slots; slot += 1) {
              const dst = (base + slot) * WARP_SIZE;
              for (let lane = 0; lane < WARP_SIZE; lane += 1) {
                if (active & (1 << lane)) regs[dst + lane] = regs[value + lane];
              }
            }
            pc += 1;
            break;
          }

          case OP.WMMA_LOAD: {
            const base = code[at + 1];
            const slots = code[at + 2];
            const addr = code[at + 3] * WARP_SIZE;
            const strideReg = code[at + 4] * WARP_SIZE;
            const space = code[at + 5];
            const colMajor = code[at + 6] === 1;
            const isHalf = code[at + 7] === 1;
            const memory = space === SPACE.GLOBAL ? globalMemory
              : space === SPACE.SHARED ? sharedMemory : localMemory;

            // fragment 的排布是我们定的：展平后第 f 个元素在 lane f%32 的第 f/32 槽
            const baseAddr = regs[addr] | 0;
            const stride = regs[strideReg] | 0;
            for (let slot = 0; slot < slots; slot += 1) {
              const dst = (base + slot) * WARP_SIZE;
              for (let lane = 0; lane < WARP_SIZE; lane += 1) {
                if ((active & (1 << lane)) === 0) continue;
                const flat = slot * WARP_SIZE + lane;
                const r = (flat / 16) | 0;
                const c = flat % 16;
                const offset = colMajor ? c * stride + r : r * stride + c;
                const address = baseAddr + offset * 4;
                addresses[lane] = address;
                const raw = memory.readF32(address);
                regs[dst + lane] = isHalf ? toHalf(raw) : raw;
              }
              if (space === SPACE.GLOBAL) {
                counters.globalLoadRequests += 1;
                counters.globalLoadSectors += countSectors(addresses, active);
              } else if (space === SPACE.SHARED) {
                counters.sharedLoadRequests += 1;
                counters.sharedBankConflicts += countBankConflicts(addresses, active);
              } else {
                counters.localReadBytes += lanes * 4;
              }
            }
            instLdSt += lanes * slots;
            pc += 1;
            break;
          }

          case OP.WMMA_STORE: {
            const base = code[at + 1];
            const slots = code[at + 2];
            const addr = code[at + 3] * WARP_SIZE;
            const strideReg = code[at + 4] * WARP_SIZE;
            const space = code[at + 5];
            const colMajor = code[at + 6] === 1;
            const memory = space === SPACE.GLOBAL ? globalMemory
              : space === SPACE.SHARED ? sharedMemory : localMemory;

            const baseAddr = regs[addr] | 0;
            const stride = regs[strideReg] | 0;
            for (let slot = 0; slot < slots; slot += 1) {
              const src = (base + slot) * WARP_SIZE;
              for (let lane = 0; lane < WARP_SIZE; lane += 1) {
                if ((active & (1 << lane)) === 0) continue;
                const flat = slot * WARP_SIZE + lane;
                const r = (flat / 16) | 0;
                const c = flat % 16;
                const offset = colMajor ? c * stride + r : r * stride + c;
                const address = baseAddr + offset * 4;
                addresses[lane] = address;
                memory.writeF32(address, regs[src + lane]);
              }
              if (space === SPACE.GLOBAL) {
                counters.globalStoreRequests += 1;
                counters.globalStoreSectors += countSectors(addresses, active);
              } else if (space === SPACE.SHARED) {
                counters.sharedStoreRequests += 1;
                counters.sharedBankConflicts += countBankConflicts(addresses, active);
              } else {
                counters.localWriteBytes += lanes * 4;
              }
            }
            instLdSt += lanes * slots;
            pc += 1;
            break;
          }

          case OP.WMMA_MMA: {
            // 一次 mma 要凑齐整个 warp 的碎片：先拼成完整的 16×16，
            // 算完再散回去。真硬件上这是一条指令，碎片怎么分布是未定义的 ——
            // 我们能拼是因为执行器本来就同时握着 32 个 lane 的寄存器。
            const dBase = code[at + 1];
            const aBase = code[at + 2];
            const bBase = code[at + 3];
            const cBase = code[at + 4];
            const slots = code[at + 5];
            const A = this.tileA;
            const B = this.tileB;
            const C = this.tileC;

            for (let slot = 0; slot < slots; slot += 1) {
              const aReg = (aBase + slot) * WARP_SIZE;
              const bReg = (bBase + slot) * WARP_SIZE;
              const cReg = (cBase + slot) * WARP_SIZE;
              for (let lane = 0; lane < WARP_SIZE; lane += 1) {
                const flat = slot * WARP_SIZE + lane;
                A[flat] = regs[aReg + lane];
                B[flat] = regs[bReg + lane];
                C[flat] = regs[cReg + lane];
              }
            }

            // D = A * B + C，累加在 fp32 上（真 tensor core 也是这样）
            for (let r = 0; r < 16; r += 1) {
              for (let c = 0; c < 16; c += 1) {
                let acc = C[r * 16 + c];
                for (let k = 0; k < 16; k += 1) {
                  acc = fmaF32(A[r * 16 + k], B[k * 16 + c], acc);
                }
                C[r * 16 + c] = acc;
              }
            }

            for (let slot = 0; slot < slots; slot += 1) {
              const dReg = (dBase + slot) * WARP_SIZE;
              for (let lane = 0; lane < WARP_SIZE; lane += 1) {
                if (active & (1 << lane)) regs[dReg + lane] = C[slot * WARP_SIZE + lane];
              }
            }

            // 16×16×16 = 4096 次乘加，走 tensor core 而不是 FMA 流水
            counters.instMma += 16 * 16 * 16;
            pc += 1;
            break;
          }

          case OP.RET:
            // 只有 active 的 lane 退出。栈上还有帧（说明这是分支里的
            // `return`）而且还有 lane 没退出时，接着往下跑 —— 那些 lane
            // 到不了这条指令，它们的活还没干完。
            warp.exited |= active;
            warp.active = 0;
            if (warp.exited !== warp.present && warp.stack.length > 0) {
              pc += 1;
              break;
            }
            warp.done = true;
            counters.warpInsts += warpInsts; counters.laneInsts += laneInsts;
            counters.instFma += instFma; counters.instLdSt += instLdSt;
          counters.instSfu += instSfu; counters.instBookkeeping += instBookkeeping;
            counters.divergentBranches += divergent;
          counters.atomics += atomics; counters.shuffles += shuffles;
          counters.warpSyncErrors += warpSyncErrors;
            return;

          default:
            throw new KernelError(`内部错误：不认识的操作码 ${op}`, lines[pc]);
        }
      }
    } catch (error) {
      counters.warpInsts += warpInsts; counters.laneInsts += laneInsts;
      counters.instFma += instFma; counters.instLdSt += instLdSt;
          counters.instSfu += instSfu; counters.instBookkeeping += instBookkeeping;
      counters.divergentBranches += divergent;
          counters.atomics += atomics; counters.shuffles += shuffles;
          counters.warpSyncErrors += warpSyncErrors;
      if (error instanceof MemoryFault) throw new KernelError(error.message, lines[Math.min(pc, this.program.count - 1)]);
      if (error instanceof KernelError) throw error;
      throw new KernelError(String((error as Error)?.message ?? error), lines[Math.min(pc, this.program.count - 1)]);
    }
  }

  private binF32(
    regs: Float64Array, dst: number, a: number, b: number,
    kind: number, active: number, line: number
  ): void {
    switch (kind) {
      case BIN.add:
        for (let lane = 0; lane < WARP_SIZE; lane += 1) {
          if (active & (1 << lane)) regs[dst + lane] = addF32(regs[a + lane], regs[b + lane]);
        }
        return;
      case BIN.sub:
        for (let lane = 0; lane < WARP_SIZE; lane += 1) {
          if (active & (1 << lane)) regs[dst + lane] = subF32(regs[a + lane], regs[b + lane]);
        }
        return;
      case BIN.mul:
        for (let lane = 0; lane < WARP_SIZE; lane += 1) {
          if (active & (1 << lane)) regs[dst + lane] = mulF32(regs[a + lane], regs[b + lane]);
        }
        return;
      case BIN.div:
        for (let lane = 0; lane < WARP_SIZE; lane += 1) {
          if (active & (1 << lane)) regs[dst + lane] = divF32(regs[a + lane], regs[b + lane]);
        }
        return;
      default:
        break;
    }
    for (let lane = 0; lane < WARP_SIZE; lane += 1) {
      if ((active & (1 << lane)) === 0) continue;
      const x = regs[a + lane];
      const y = regs[b + lane];
      let out: number;
      switch (kind) {
        case BIN.lt: out = x < y ? 1 : 0; break;
        case BIN.le: out = x <= y ? 1 : 0; break;
        case BIN.gt: out = x > y ? 1 : 0; break;
        case BIN.ge: out = x >= y ? 1 : 0; break;
        case BIN.eq: out = x === y ? 1 : 0; break;
        case BIN.ne: out = x !== y ? 1 : 0; break;
        default: throw new KernelError('这个运算符不能用在 float 上', line);
      }
      regs[dst + lane] = out;
    }
  }

  private binInt(
    regs: Float64Array, dst: number, a: number, b: number,
    kind: number, unsigned: boolean, active: number, line: number
  ): void {
    for (let lane = 0; lane < WARP_SIZE; lane += 1) {
      if ((active & (1 << lane)) === 0) continue;
      const xi = unsigned ? regs[a + lane] >>> 0 : regs[a + lane] | 0;
      const yi = unsigned ? regs[b + lane] >>> 0 : regs[b + lane] | 0;
      let out: number;
      switch (kind) {
        case BIN.add: out = unsigned ? (xi + yi) >>> 0 : (xi + yi) | 0; break;
        case BIN.sub: out = unsigned ? (xi - yi) >>> 0 : (xi - yi) | 0; break;
        case BIN.mul: out = unsigned ? Math.imul(xi, yi) >>> 0 : Math.imul(xi, yi); break;
        case BIN.div:
          if (yi === 0) throw new KernelError('整数除以 0', line);
          out = unsigned ? Math.trunc(xi / yi) >>> 0 : Math.trunc(xi / yi) | 0;
          break;
        case BIN.rem:
          if (yi === 0) throw new KernelError('整数取模 0', line);
          out = unsigned ? (xi % yi) >>> 0 : (xi % yi) | 0;
          break;
        case BIN.shl: out = unsigned ? (xi << (yi & 31)) >>> 0 : xi << (yi & 31); break;
        case BIN.shr: out = unsigned ? xi >>> (yi & 31) : xi >> (yi & 31); break;
        case BIN.and: out = unsigned ? (xi & yi) >>> 0 : xi & yi; break;
        case BIN.or: out = unsigned ? (xi | yi) >>> 0 : xi | yi; break;
        case BIN.xor: out = unsigned ? (xi ^ yi) >>> 0 : xi ^ yi; break;
        case BIN.lt: out = xi < yi ? 1 : 0; break;
        case BIN.le: out = xi <= yi ? 1 : 0; break;
        case BIN.gt: out = xi > yi ? 1 : 0; break;
        case BIN.ge: out = xi >= yi ? 1 : 0; break;
        case BIN.eq: out = xi === yi ? 1 : 0; break;
        default: out = xi !== yi ? 1 : 0; break;
      }
      regs[dst + lane] = out;
    }
  }
}

function normalize(value: number, ty: number): number {
  return ty === TY.F32 ? Math.fround(value) : ty === TY.U32 ? value >>> 0 : value | 0;
}

function convert(value: number, from: number, to: number): number {
  if (from === to) return value;
  if (to === TY.F32) return Math.fround(from === TY.U32 ? value >>> 0 : value | 0);
  if (from === TY.F32) return to === TY.U32 ? floatToUint(value) : floatToInt(value);
  return to === TY.U32 ? value >>> 0 : value | 0;
}

function popcount(mask: number): number {
  let n = mask - ((mask >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  n = (n + (n >> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >> 24;
}

export { SECTOR_BYTES, WARP_SIZE, LinearMemory, encode };
export type { ExecutableKernel };
