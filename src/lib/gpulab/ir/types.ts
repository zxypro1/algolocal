/**
 * 扁平 IR
 *
 * 为什么是扁平的、带程序计数器的指令数组，而不是直接在 AST 上递归求值：
 * **`__syncthreads()` 要能把一个 warp 挂起、去跑同一个 block 里的别的 warp。**
 * 递归求值的话得靠生成器或 CPS 才能挂起，两者都比一个 pc 慢得多也难得多。
 *
 * 每条指令都是 **warp 级**的：执行器拿到一条指令，对 32 个 lane 各做一遍。
 * 指令派发的开销就这样被摊薄了 32 倍 —— 这是整个执行模型能跑得动的原因
 * （实测约 2000 万条 warp 指令/秒，见 design/gpulab.md）。
 *
 * 发散用经典的 SIMT 重汇聚栈。因为 C 的控制流是结构化的，编译期就能算出
 * 重汇聚点，不需要在运行时求 IPDOM。
 */

/** 值在寄存器里怎么存 —— 决定算术怎么做、访存按几字节 */
export type IrType = 'i32' | 'u32' | 'f32';

/**
 * 地址空间。决定访存走哪套计量。
 *
 * `local` 是**线程私有**的那一块。真卡上它其实住在显存里，只是被硬件
 * 按线程交错过，所以合并访问不是问题 —— 问题是它根本不该被用到：
 * 一个本该待在寄存器里的数组落到 local memory，占用率与带宽一起塌。
 * 第 6 关整关就是这件事。
 */
export type Space = 'global' | 'shared' | 'local';

export type BinKind =
  | 'add' | 'sub' | 'mul' | 'div' | 'rem'
  | 'shl' | 'shr' | 'and' | 'or' | 'xor'
  | 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne';

export type UnKind = 'neg' | 'not' | 'bnot';

/** 内建数学函数。`__` 开头的是 fast-math 变体，精度低但快。 */
export type BuiltinFn =
  | 'fmaf' | 'fabsf' | 'fminf' | 'fmaxf' | 'sqrtf' | 'rsqrtf'
  | 'expf' | 'logf' | 'tanhf' | 'powf'
  | '__expf' | '__logf' | '__fdividef'
  | 'min' | 'max' | 'abs'
  /** 位操作 —— 和 __ballot_sync 配套用，数掩码里有几位、最低位在哪 */
  | '__popc' | '__clz' | '__ffs';

/**
 * warp 内的数据交换方式。
 *
 * 真 CUDA 的 `__shfl_*_sync` 系列。它们是 warp 级原语 —— 一个 lane 直接读
 * 另一个 lane 的寄存器，不经过内存。规约、前缀和、以及 FlashAttention 里
 * 那些行内归并全靠它。
 */
export type ShflMode = 'idx' | 'up' | 'down' | 'xor';

/** 原子操作。真卡上它们的完成顺序不定，这里的处理见 vm.ts 的说明。 */
export type AtomKind = 'add' | 'sub' | 'exch' | 'min' | 'max' | 'cas' | 'and' | 'or' | 'xor';

export type SpecialReg =
  | 'tid.x' | 'tid.y' | 'tid.z'
  | 'ctaid.x' | 'ctaid.y' | 'ctaid.z'
  | 'ntid.x' | 'ntid.y' | 'ntid.z'
  | 'nctaid.x' | 'nctaid.y' | 'nctaid.z'
  | 'warpsize';

export type Inst =
  /** 立即数 */
  | { op: 'const'; dst: number; value: number; ty: IrType }
  | { op: 'mov'; dst: number; src: number }
  | { op: 'bin'; dst: number; a: number; b: number; kind: BinKind; ty: IrType }
  | { op: 'un'; dst: number; a: number; kind: UnKind; ty: IrType }
  /** 类型转换。整数与浮点之间是真的按 C 的规则舍入。 */
  | { op: 'cvt'; dst: number; a: number; from: IrType; to: IrType }
  /** 内建变量 */
  | { op: 'sreg'; dst: number; which: SpecialReg }
  /** kernel 参数。标量直接进寄存器，指针进的是字节地址。 */
  | { op: 'param'; dst: number; index: number; ty: IrType }
  /** 共享内存里某个变量的基地址（block 内所有 lane 相同） */
  | { op: 'sharedbase'; dst: number; offset: number }
  /**
   * local memory 里某个变量的基地址。
   * 每个线程一份，所以要按线程号算：`tid * 每线程字节数 + 变量偏移`。
   */
  | { op: 'localbase'; dst: number; offset: number }
  | { op: 'load'; dst: number; addr: number; space: Space; ty: IrType; line: number }
  | { op: 'store'; addr: number; src: number; space: Space; ty: IrType; line: number }
  /** 无条件跳转 */
  | { op: 'jmp'; target: number }
  /**
   * 进入一个分歧区。
   *  active &= cond；把 (原 active, else 掩码, 汇合点) 压栈。
   *  如果 cond 一个 lane 都没中，直接跳到 elsePc。
   */
  | { op: 'push'; cond: number; elsePc: number; joinPc: number; line: number }
  /** then 分支结束：换成 else 掩码；else 也空就跳到汇合点 */
  | { op: 'swap'; joinPc: number }
  /** 汇合：弹栈，恢复进入前的 active */
  | { op: 'pop' }
  /**
   * 进入一个循环。压栈保存进入前的 active，循环体里只会让 active 变小。
   */
  | { op: 'loop'; exitPc: number }
  /** 循环条件：active &= cond；空了就跳出去 */
  | { op: 'lcond'; cond: number; exitPc: number }
  /** `__syncthreads()` —— 挂起本 warp，等同 block 的其它 warp */
  | { op: 'bar'; line: number }
  | { op: 'call'; dst: number; fn: BuiltinFn; args: number[]; ty: IrType }
  /**
   * warp 内交换：`dst` 拿到 `src` 在另一个 lane 上的值。
   * `mask` 是参与线程掩码（真 API 的第一个参数），`width` 把 warp 切成段。
   */
  | { op: 'shfl'; dst: number; src: number; lane: number; mask: number; mode: ShflMode; width: number; ty: IrType; line: number }
  /** `__ballot_sync`：把每个 lane 的谓词收成一个 32 位掩码 */
  | { op: 'ballot'; dst: number; pred: number; mask: number; line: number }
  /** `__activemask()` */
  | { op: 'activemask'; dst: number }
  /** `__syncwarp(mask)` */
  | { op: 'syncwarp'; mask: number; line: number }
  /** 原子读改写。返回**旧值**，和真 API 一致。 */
  | { op: 'atom'; dst: number; addr: number; value: number; compare: number; kind: AtomKind; space: Space; ty: IrType; line: number }
  | { op: 'ret' };

export interface SharedVar {
  name: string;
  /** 共享内存里的字节偏移 */
  offset: number;
  bytes: number;
}

export interface KernelParam {
  name: string;
  ty: IrType;
  /** 指针参数拿到的是一个字节地址，算术上就是 u32 */
  isPointer: boolean;
  /** 指向的元素占几字节，下标算地址要用 */
  elementBytes: number;
}

export interface CompiledKernel {
  name: string;
  insts: Inst[];
  params: KernelParam[];
  /** 每个 lane 需要多少个寄存器槽 */
  numRegs: number;
  /** 静态共享内存总字节数 */
  sharedBytes: number;
  sharedVars: SharedVar[];
  /**
   * 每个线程用掉多少 local memory 字节。
   *
   * **不是 0 就说明有数组没能待在寄存器里。** 第 6 关的硬门槛读它 ——
   * 它是精确的，而寄存器数是估的。
   */
  localBytes: number;
  /**
   * 每线程寄存器数的**估计值**。
   *
   * 按 IR 上的活跃区间算出来的，不是真的寄存器分配器，会偏。
   * 所以它只用于算占用率与展示，不单独作门槛 —— 见 design/gpulab.md。
   */
  registersPerThread: number;
  /** 指令下标 → 源码行号，报错与剖析要用 */
  lines: number[];
}
