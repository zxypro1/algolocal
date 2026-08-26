/**
 * 可执行程序：把 `Inst[]` 编码成扁平的定长记录
 *
 * 为什么不直接解释 `Inst[]`：`Inst` 是十八种不同形状的联合类型，于是
 * `inst.dst` / `inst.a` 这些属性访问全是 megamorphic 的，V8 的内联缓存完全
 * 失效；`switch (inst.op)` 也是字符串比较而不是跳转表。编成 `Int32Array`
 * 之后取操作数是定址访问、分派是数值跳转表，两个问题一起没了。
 *
 * `Inst[]` 仍然是编译器的输出形式（可读、好测、将来的反汇编面板要用它），
 * 只是在交给执行器之前过一道编码。
 *
 * **一个诚实的说明**：改成扁平编码之后在 jest 里量不出差别 —— 后来发现
 * jest 自己就吃掉了 5–7 倍（SWC 转译 + 模块注册表 + vm 上下文）。
 * 纯 node 下实测 **13.5M warp 指令/秒**（N=256 的朴素 GEMM 783ms），
 * 而 jest 里同一段代码只有 2.0M/s。所以：
 *   - 关卡规模按 13M/s 这个**生产数字**设计，不是按测试里看到的；
 *   - 测试里的吞吐断言只能当回归哨兵用，不能当性能指标。
 * 这一版没有单独隔离出扁平编码本身贡献了多少 —— 它是标准做法，
 * 保留的理由是架构而不是一个测出来的加速比。
 */
import type {
  AtomKind, BinKind, BuiltinFn, CompiledKernel, Inst, IrType,
  ShflMode, Space, SpecialReg, UnKind,
} from './types';

/** 每条指令占几个 int32 槽。取 2 的幂，`pc * SLOTS` 才能编译成移位。 */
export const SLOTS = 8;

export const OP = {
  CONST: 0,
  MOV: 1,
  BIN: 2,
  UN: 3,
  CVT: 4,
  SREG: 5,
  PARAM: 6,
  SHAREDBASE: 7,
  LOAD: 8,
  STORE: 9,
  JMP: 10,
  PUSH: 11,
  SWAP: 12,
  POP: 13,
  LOOP: 14,
  LCOND: 15,
  BAR: 16,
  CALL: 17,
  RET: 18,
  SHFL: 19,
  BALLOT: 20,
  ACTIVEMASK: 21,
  SYNCWARP: 22,
  ATOM: 23,
  LOCALBASE: 24,
} as const;

export const SHFL = { idx: 0, up: 1, down: 2, xor: 3 } as const;

export const ATOM = {
  add: 0, sub: 1, exch: 2, min: 3, max: 4, cas: 5, and: 6, or: 7, xor: 8,
} as const;

export const TY = { F32: 0, I32: 1, U32: 2 } as const;
export const SPACE = { GLOBAL: 0, SHARED: 1, LOCAL: 2 } as const;

export const BIN = {
  add: 0, sub: 1, mul: 2, div: 3, rem: 4,
  shl: 5, shr: 6, and: 7, or: 8, xor: 9,
  lt: 10, le: 11, gt: 12, ge: 13, eq: 14, ne: 15,
} as const;

export const UN = { neg: 0, not: 1, bnot: 2 } as const;

export const FN = {
  fmaf: 0, fabsf: 1, fminf: 2, fmaxf: 3, sqrtf: 4, rsqrtf: 5,
  expf: 6, logf: 7, tanhf: 8, powf: 9,
  __expf: 10, __logf: 11, __fdividef: 12,
  min: 13, max: 14, abs: 15,
  __popc: 16, __clz: 17, __ffs: 18,
} as const;

/**
 * 哪些内建函数走 **SFU**（特殊功能单元）。
 *
 * 用查表而不是判断 FN 的区间：区间判断依赖枚举顺序，将来往中间插一个
 * 函数就会静默算错，而这个数直接决定 softmax 那几关的瓶颈在哪。
 */
export const SFU_FNS = new Uint8Array(32);
for (const fn of ['sqrtf', 'rsqrtf', 'expf', 'logf', 'tanhf', 'powf', '__expf', '__logf', '__fdividef'] as const) {
  SFU_FNS[FN[fn]] = 1;
}

export const SREG = {
  'tid.x': 0, 'tid.y': 1, 'tid.z': 2,
  'ctaid.x': 3, 'ctaid.y': 4, 'ctaid.z': 5,
  'ntid.x': 6, 'ntid.y': 7, 'ntid.z': 8,
  'nctaid.x': 9, 'nctaid.y': 10, 'nctaid.z': 11,
  warpsize: 12,
} as const;

function spaceCode(space: Space): number {
  return space === 'global' ? SPACE.GLOBAL : space === 'shared' ? SPACE.SHARED : SPACE.LOCAL;
}

function tyCode(ty: IrType): number {
  return ty === 'f32' ? TY.F32 : ty === 'i32' ? TY.I32 : TY.U32;
}

export interface Program {
  /** 指令流，每条 SLOTS 个槽 */
  code: Int32Array;
  /** 立即数常量池 —— float 放不进 Int32Array，用下标引用 */
  pool: Float64Array;
  /** 指令条数 */
  count: number;
  /** 指令下标 → 源码行号 */
  lines: Int32Array;
}

export interface ExecutableKernel extends CompiledKernel {
  program: Program;
  /** 参数的类型码，避免执行时再查一遍 */
  paramTypes: Int32Array;
}

export function encode(kernel: CompiledKernel): ExecutableKernel {
  const count = kernel.insts.length;
  const code = new Int32Array(count * SLOTS);
  const lines = new Int32Array(count);
  const pool: number[] = [];

  const constant = (value: number): number => {
    // 常量很多是重复的（下标步长、0、1），去重能让池小一个量级
    const found = pool.indexOf(value);
    if (found >= 0) return found;
    pool.push(value);
    return pool.length - 1;
  };

  for (let i = 0; i < count; i += 1) {
    const inst = kernel.insts[i];
    const at = i * SLOTS;
    lines[i] = kernel.lines[i] ?? 0;

    switch (inst.op) {
      case 'const':
        code[at] = OP.CONST;
        code[at + 1] = inst.dst;
        code[at + 2] = constant(inst.value);
        code[at + 3] = tyCode(inst.ty);
        break;
      case 'mov':
        code[at] = OP.MOV;
        code[at + 1] = inst.dst;
        code[at + 2] = inst.src;
        break;
      case 'bin':
        code[at] = OP.BIN;
        code[at + 1] = inst.dst;
        code[at + 2] = inst.a;
        code[at + 3] = inst.b;
        code[at + 4] = BIN[inst.kind as BinKind];
        code[at + 5] = tyCode(inst.ty);
        break;
      case 'un':
        code[at] = OP.UN;
        code[at + 1] = inst.dst;
        code[at + 2] = inst.a;
        code[at + 3] = UN[inst.kind as UnKind];
        code[at + 4] = tyCode(inst.ty);
        break;
      case 'cvt':
        code[at] = OP.CVT;
        code[at + 1] = inst.dst;
        code[at + 2] = inst.a;
        code[at + 3] = tyCode(inst.from);
        code[at + 4] = tyCode(inst.to);
        break;
      case 'sreg':
        code[at] = OP.SREG;
        code[at + 1] = inst.dst;
        code[at + 2] = SREG[inst.which as SpecialReg];
        break;
      case 'param':
        code[at] = OP.PARAM;
        code[at + 1] = inst.dst;
        code[at + 2] = inst.index;
        code[at + 3] = tyCode(inst.ty);
        break;
      case 'sharedbase':
        code[at] = OP.SHAREDBASE;
        code[at + 1] = inst.dst;
        code[at + 2] = inst.offset;
        break;
      case 'localbase':
        code[at] = OP.LOCALBASE;
        code[at + 1] = inst.dst;
        code[at + 2] = inst.offset;
        break;
      case 'load':
        code[at] = OP.LOAD;
        code[at + 1] = inst.dst;
        code[at + 2] = inst.addr;
        code[at + 3] = spaceCode(inst.space);
        code[at + 4] = tyCode(inst.ty);
        break;
      case 'store':
        code[at] = OP.STORE;
        code[at + 1] = inst.addr;
        code[at + 2] = inst.src;
        code[at + 3] = spaceCode(inst.space);
        code[at + 4] = tyCode(inst.ty);
        break;
      case 'jmp':
        code[at] = OP.JMP;
        code[at + 1] = inst.target;
        break;
      case 'push':
        code[at] = OP.PUSH;
        code[at + 1] = inst.cond;
        code[at + 2] = inst.elsePc;
        code[at + 3] = inst.joinPc;
        break;
      case 'swap':
        code[at] = OP.SWAP;
        code[at + 1] = inst.joinPc;
        break;
      case 'pop':
        code[at] = OP.POP;
        break;
      case 'loop':
        code[at] = OP.LOOP;
        code[at + 1] = inst.exitPc;
        break;
      case 'lcond':
        code[at] = OP.LCOND;
        code[at + 1] = inst.cond;
        code[at + 2] = inst.exitPc;
        break;
      case 'bar':
        code[at] = OP.BAR;
        break;
      case 'call':
        code[at] = OP.CALL;
        code[at + 1] = inst.dst;
        code[at + 2] = FN[inst.fn as BuiltinFn];
        code[at + 3] = tyCode(inst.ty);
        code[at + 4] = inst.args[0] ?? 0;
        code[at + 5] = inst.args[1] ?? 0;
        code[at + 6] = inst.args[2] ?? 0;
        break;
      case 'shfl':
        code[at] = OP.SHFL;
        code[at + 1] = inst.dst;
        code[at + 2] = inst.src;
        code[at + 3] = inst.lane;
        code[at + 4] = inst.mask;
        code[at + 5] = SHFL[inst.mode as ShflMode];
        code[at + 6] = inst.width;
        break;
      case 'ballot':
        code[at] = OP.BALLOT;
        code[at + 1] = inst.dst;
        code[at + 2] = inst.pred;
        code[at + 3] = inst.mask;
        break;
      case 'activemask':
        code[at] = OP.ACTIVEMASK;
        code[at + 1] = inst.dst;
        break;
      case 'syncwarp':
        code[at] = OP.SYNCWARP;
        code[at + 1] = inst.mask;
        break;
      case 'atom':
        code[at] = OP.ATOM;
        code[at + 1] = inst.dst;
        code[at + 2] = inst.addr;
        code[at + 3] = inst.value;
        code[at + 4] = ATOM[inst.kind as AtomKind];
        code[at + 5] = spaceCode(inst.space);
        code[at + 6] = tyCode(inst.ty);
        code[at + 7] = inst.compare;
        break;
      case 'ret':
        code[at] = OP.RET;
        break;
    }
  }

  return {
    ...kernel,
    program: { code, pool: Float64Array.from(pool), count, lines },
    paramTypes: Int32Array.from(kernel.params.map((param) => tyCode(param.ty))),
  };
}

export type { Space };
