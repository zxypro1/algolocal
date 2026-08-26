/**
 * AST → 扁平 IR
 *
 * 一个直白的表达式求值 + 结构化控制流降级。没有优化，也不该有优化：
 * 这个工作台的全部意义是「学员写了什么就跑什么，指令数与访存次数都算数」。
 * 编译器替他把重复的下标计算提出去，`gpu.inst.*` 就不再反映他写的东西了。
 *
 * 类型规则按 C 的通常算术转换裁剪过：int 和 float 混算提升到 float，
 * int 和 unsigned 混算提升到 unsigned。够用，且和真 nvcc 在这个子集上一致。
 */
import {
  fragmentSlots, isFragment, isPointer, sizeOf, typeName,
  type BinaryOp, type CudaType, type Expr, type FragmentType, type FuncDecl,
  type KernelDecl, type Stmt, type VarDecl,
} from '../cuda/ast';
import { CudaCompileError } from '../cuda/lower';
import type {
  AtomKind, BinKind, BuiltinFn, CompiledHost, CompiledKernel, HostFn, Inst, IrType,
  KernelParam, LaunchSite, SharedVar, ShflMode, Space,
} from './types';

/** 一个值：寄存器编号 + 它的 CUDA 类型 */
interface Value {
  reg: number;
  type: CudaType;
}

/** 变量住在哪 */
type Binding =
  | { where: 'reg'; reg: number; type: CudaType }
  /** `__shared__` 的数组：住在共享内存，名字对应一个基地址 */
  | { where: 'shared'; offset: number; type: CudaType }
  /** kernel 参数里的指针：寄存器里存的是字节地址 */
  | { where: 'param'; reg: number; type: CudaType }
  /** 下标全是常量的线程私有数组：整个摊平成一串寄存器 */
  | { where: 'regarray'; base: number; type: CudaType }
  /** 有动态下标的线程私有数组：落到 local memory */
  | { where: 'local'; offset: number; type: CudaType }
  /** wmma 的 fragment：每个 lane 占 m*n/32 个寄存器槽 */
  | { where: 'fragment'; base: number; type: FragmentType };

const BUILTIN_FNS: Record<string, { fn: BuiltinFn; arity: number; ty: IrType }> = {
  fmaf: { fn: 'fmaf', arity: 3, ty: 'f32' },
  fabsf: { fn: 'fabsf', arity: 1, ty: 'f32' },
  fminf: { fn: 'fminf', arity: 2, ty: 'f32' },
  fmaxf: { fn: 'fmaxf', arity: 2, ty: 'f32' },
  sqrtf: { fn: 'sqrtf', arity: 1, ty: 'f32' },
  rsqrtf: { fn: 'rsqrtf', arity: 1, ty: 'f32' },
  expf: { fn: 'expf', arity: 1, ty: 'f32' },
  logf: { fn: 'logf', arity: 1, ty: 'f32' },
  tanhf: { fn: 'tanhf', arity: 1, ty: 'f32' },
  powf: { fn: 'powf', arity: 2, ty: 'f32' },
  __expf: { fn: '__expf', arity: 1, ty: 'f32' },
  __logf: { fn: '__logf', arity: 1, ty: 'f32' },
  __fdividef: { fn: '__fdividef', arity: 2, ty: 'f32' },
  min: { fn: 'min', arity: 2, ty: 'i32' },
  max: { fn: 'max', arity: 2, ty: 'i32' },
  abs: { fn: 'abs', arity: 1, ty: 'i32' },
  // fp8 转换。第一个是「float 转 fp8 的 8 位存储」，返回 0..255；
  // 第二个转回来。参数与真 cuda_fp8.h 一致：(值, 饱和模式, 格式)。
  __nv_cvt_float_to_fp8: { fn: '__nv_cvt_float_to_fp8', arity: 3, ty: 'i32' },
  __nv_cvt_fp8_to_halfraw: { fn: '__nv_cvt_fp8_to_halfraw', arity: 2, ty: 'f32' },
  __popc: { fn: '__popc', arity: 1, ty: 'i32' },
  __clz: { fn: '__clz', arity: 1, ty: 'i32' },
  __ffs: { fn: '__ffs', arity: 1, ty: 'i32' },
};

/** `__shfl_*_sync(mask, var, laneArg, width = warpSize)` */
const SHFL_FNS: Record<string, ShflMode> = {
  __shfl_sync: 'idx',
  __shfl_up_sync: 'up',
  __shfl_down_sync: 'down',
  __shfl_xor_sync: 'xor',
};

/** `atomicXxx(addr, value)`；atomicCAS 多一个参数 */
const ATOMIC_FNS: Record<string, { kind: AtomKind; arity: number }> = {
  atomicAdd: { kind: 'add', arity: 2 },
  atomicSub: { kind: 'sub', arity: 2 },
  atomicExch: { kind: 'exch', arity: 2 },
  atomicMin: { kind: 'min', arity: 2 },
  atomicMax: { kind: 'max', arity: 2 },
  atomicAnd: { kind: 'and', arity: 2 },
  atomicOr: { kind: 'or', arity: 2 },
  atomicXor: { kind: 'xor', arity: 2 },
  atomicCAS: { kind: 'cas', arity: 3 },
};

const COMPARISONS = new Set<BinaryOp>(['<', '<=', '>', '>=', '==', '!=']);

const BIN_KIND: Partial<Record<BinaryOp, BinKind>> = {
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'rem',
  '<<': 'shl', '>>': 'shr', '&': 'and', '|': 'or', '^': 'xor',
  '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', '==': 'eq', '!=': 'ne',
};

function irTypeOf(type: CudaType): IrType {
  if (type.kind === 'pointer' || type.kind === 'array' || type.kind === 'fragment') return 'u32';
  switch (type.scalar) {
    // half 在寄存器里也是按 fp32 存的，只是每次写入都会舍到 fp16 能表示的值
    case 'float': case 'half': return 'f32';
    case 'uint': return 'u32';
    default: return 'i32';
  }
}

/**
 * 一个线程私有的数组能不能待在寄存器里。
 *
 * 规则和真 nvcc 一样：**下标全是编译期常量**就能展开成一组寄存器；
 * 只要有一处是动态下标，整个数组就落到 local memory。
 *
 * 判断是保守的 —— 按名字扫整个 kernel，同名的不同作用域会被一起算。
 * 保守方向是安全的（把能进寄存器的判成 local，学员会看到 local.bytes
 * 不为 0 然后去改），反过来就会漏掉第 6 关要教的那件事。
 */
function arraysWithDynamicIndex(body: Stmt): Set<string> {
  const dynamic = new Set<string>();

  const isConstIndex = (node: Expr): boolean =>
    node.kind === 'intLit' ||
    (node.kind === 'unary' && node.op === '-' && isConstIndex(node.operand)) ||
    (node.kind === 'binary' && isConstIndex(node.left) && isConstIndex(node.right));

  const visitExpr = (node: Expr): void => {
    switch (node.kind) {
      case 'subscript':
        if (node.array.kind === 'name') {
          // 这里**不能**往下走 visitExpr(node.array)：那是下标的基址，
          // 不是「数组名当值用」。走下去的话每个数组都会被当成退化了。
          if (!isConstIndex(node.index)) dynamic.add(node.array.name);
        } else {
          visitExpr(node.array);
        }
        visitExpr(node.index);
        break;
      case 'name':
        // 数组名单独出现 = 退化成指针（传给 cudaMemcpy、传给 kernel、
        // 赋给一个 float*）。寄存器里的数组没有地址，退化不了，
        // 所以这种用法一律落到 local memory。
        //
        // 这一条以前是漏的：`float h[4]` 只用常量下标写、再整个
        // cudaMemcpy 出去，会被提升进寄存器，然后报「不能整体当指针用」。
        dynamic.add(node.name);
        break;
      case 'binary': visitExpr(node.left); visitExpr(node.right); break;
      case 'unary': visitExpr(node.operand); break;
      case 'ternary': visitExpr(node.cond); visitExpr(node.then); visitExpr(node.otherwise); break;
      case 'deref': visitExpr(node.pointer); break;
      case 'addressOf':
        // 取了地址就说不清了，一律按 local 算
        if (node.target.kind === 'name') dynamic.add(node.target.name);
        if (node.target.kind === 'subscript' && node.target.array.kind === 'name') {
          dynamic.add(node.target.array.name);
        }
        visitExpr(node.target);
        break;
      case 'cast': visitExpr(node.operand); break;
      case 'call': node.args.forEach(visitExpr); break;
      case 'assign': visitExpr(node.target); visitExpr(node.value); break;
      case 'incdec': visitExpr(node.target); break;
      default: break;
    }
  };

  const visitStmt = (node: Stmt): void => {
    switch (node.kind) {
      case 'expr': visitExpr(node.expr); break;
      case 'decl': node.decls.forEach((decl) => decl.init && visitExpr(decl.init)); break;
      case 'block': node.body.forEach(visitStmt); break;
      case 'if':
        visitExpr(node.cond); visitStmt(node.then);
        if (node.otherwise) visitStmt(node.otherwise);
        break;
      case 'for':
        if (node.init) visitStmt(node.init);
        if (node.cond) visitExpr(node.cond);
        if (node.step) visitExpr(node.step);
        visitStmt(node.body);
        break;
      case 'while': visitExpr(node.cond); visitStmt(node.body); break;
      case 'return': if (node.value) visitExpr(node.value); break;
      case 'launch':
        node.grid.forEach(visitExpr);
        node.block.forEach(visitExpr);
        node.args.forEach(visitExpr);
        break;
      default: break;
    }
  };

  visitStmt(body);
  return dynamic;
}

/**
 * 宿主侧的平台函数。
 *
 * 名字与签名照抄真 CUDA runtime 与一份最小容器库 —— 学员在这里敲的
 * `cudaMemcpy(d, h, n, cudaMemcpyHostToDevice)` 和真卡上一模一样。
 * 容器（vec / map / ring）的实现在平台侧，声明写在只读的 `containers.h` 里。
 */
const HOST_FNS: Record<string, { fn: HostFn; arity: number; scalar: 'int' | 'void' }> = {
  cudaFree: { fn: 'cudaFree', arity: 1, scalar: 'int' },
  cudaMemcpy: { fn: 'cudaMemcpy', arity: 4, scalar: 'int' },
  cudaMemset: { fn: 'cudaMemset', arity: 3, scalar: 'int' },
  cudaDeviceSynchronize: { fn: 'cudaDeviceSynchronize', arity: 0, scalar: 'int' },

  lab_buffer: { fn: 'lab_buffer', arity: 1, scalar: 'int' },
  lab_buffer_len: { fn: 'lab_buffer_len', arity: 1, scalar: 'int' },

  cudaStreamBeginCapture: { fn: 'cudaStreamBeginCapture', arity: 2, scalar: 'int' },
  cudaStreamEndCapture: { fn: 'cudaStreamEndCapture', arity: 2, scalar: 'int' },
  cudaGraphInstantiate: { fn: 'cudaGraphInstantiate', arity: 3, scalar: 'int' },
  cudaGraphLaunch: { fn: 'cudaGraphLaunch', arity: 2, scalar: 'int' },
  cudaGraphDestroy: { fn: 'cudaGraphDestroy', arity: 1, scalar: 'int' },
  cudaGraphExecDestroy: { fn: 'cudaGraphExecDestroy', arity: 1, scalar: 'int' },

  vec_new: { fn: 'vec_new', arity: 0, scalar: 'int' },
  vec_push: { fn: 'vec_push', arity: 2, scalar: 'void' },
  vec_pop: { fn: 'vec_pop', arity: 1, scalar: 'int' },
  vec_get: { fn: 'vec_get', arity: 2, scalar: 'int' },
  vec_set: { fn: 'vec_set', arity: 3, scalar: 'void' },
  vec_len: { fn: 'vec_len', arity: 1, scalar: 'int' },
  vec_clear: { fn: 'vec_clear', arity: 1, scalar: 'void' },

  map_new: { fn: 'map_new', arity: 0, scalar: 'int' },
  map_set: { fn: 'map_set', arity: 3, scalar: 'void' },
  map_get: { fn: 'map_get', arity: 3, scalar: 'int' },
  map_has: { fn: 'map_has', arity: 2, scalar: 'int' },
  map_del: { fn: 'map_del', arity: 2, scalar: 'void' },
  map_len: { fn: 'map_len', arity: 1, scalar: 'int' },

  ring_new: { fn: 'ring_new', arity: 0, scalar: 'int' },
  ring_push: { fn: 'ring_push', arity: 2, scalar: 'void' },
  ring_pop: { fn: 'ring_pop', arity: 1, scalar: 'int' },
  ring_peek: { fn: 'ring_peek', arity: 1, scalar: 'int' },
  ring_len: { fn: 'ring_len', arity: 1, scalar: 'int' },
};

/**
 * 设备侧也认的常量，kernel 与宿主代码都能用。
 *
 * 取值与 `cuda_fp8.h` 里那两个枚举一致。
 */
/**
 * 哪些宿主函数带**出参**，以及出参在第几个位置。
 *
 * C 里返回句柄的惯例是 `f(&handle, ...)`，真 CUDA 的
 * `cudaMalloc` / `cudaStreamEndCapture` / `cudaGraphInstantiate` 都是这样。
 * 这个子集里标量住在寄存器里、没有地址，所以在语法层面认这个模式，
 * 把结果直接写回那个变量。**保留真签名是有意的** —— 学员在真卡上
 * 敲的就是这几行。
 */
const HOST_OUT_PARAM: Record<string, { at: number; hint: string }> = {
  // 提示按函数各写各的：学员在 cudaMalloc 上真正会敲的是 `(void**)&p`，
  // 报错里说成泛泛的「&变量」会让他以为要去掉那个 cast
  cudaMalloc: { at: 0, hint: '(void**)&指针变量' },
  cudaStreamEndCapture: { at: 1, hint: '&变量' },
  cudaGraphInstantiate: { at: 0, hint: '&变量' },
};

const DEVICE_CONSTANTS: Record<string, number> = {
  __NV_NOSAT: 0,
  __NV_SATFINITE: 1,
  __NV_E4M3: 0,
  __NV_E5M2: 1,
  /** cudaStreamCaptureMode */
  cudaStreamCaptureModeGlobal: 0,
  cudaStreamCaptureModeThreadLocal: 1,
  cudaStreamCaptureModeRelaxed: 2,
};

/** `cudaMemcpyKind` 的四个取值，和真头文件里的顺序一致 */
const HOST_CONSTANTS: Record<string, number> = {
  cudaMemcpyHostToHost: 0,
  cudaMemcpyHostToDevice: 1,
  cudaMemcpyDeviceToHost: 2,
  cudaMemcpyDeviceToDevice: 3,
  cudaSuccess: 0,
};

/** 编译一个函数时需要知道的上下文 */
interface CompilerContext {
  /** 自己写的函数，按名字查，调用点整个内联进去 */
  functions: Map<string, FuncDecl>;
  /**
   * 宿主模式。
   *
   * 开着才认 CUDA runtime 与容器，也才允许 `break` 与提前 `return` ——
   * 理由见 `unwindTo`。
   */
  host: boolean;
}

/**
 * 编译期的作用域帧。
 *
 * 只用来算「跳出去要弹几层掩码」，和 VM 的重收敛栈是一一对应的：
 * 每一个 `mask` / `loop` 帧在 VM 那边都有一项。
 */
type Frame =
  | { kind: 'mask' }
  | { kind: 'loop'; breaks: number[]; continues: number[] }
  | { kind: 'fn'; returns: number[]; result: number; type: CudaType; name: string };

class Compiler {
  private insts: Inst[] = [];
  private lines: number[] = [];
  private scopes: Map<string, Binding>[] = [];
  private numRegs = 0;
  private sharedBytes = 0;
  private sharedVars: SharedVar[] = [];
  private params: KernelParam[] = [];
  private localBytes = 0;
  private dynamicArrays: Set<string>;
  private frames: Frame[] = [];
  /** 内联链，用来发现递归 */
  private inlineStack: string[] = [];
  /**
   * 作用域可见性的下界。
   *
   * 内联进来的函数体**看不见调用者的局部变量** —— 少了这道屏障，
   * 一个函数里写 `int i` 就会撞上调用者循环里的 `i`，而且是静默地撞上。
   */
  private scopeFloor: number[] = [];
  private strings: string[] = [];
  private launches: LaunchSite[] = [];
  /** 顶层 return 的跳转，编译到最后统一补目标 */
  private topReturns: number[] = [];

  constructor(private kernel: KernelDecl, private ctx: CompilerContext) {
    this.dynamicArrays = arraysWithDynamicIndex(kernel.body);
  }

  compile(): CompiledKernel {
    this.scopes.push(new Map());

    this.kernel.params.forEach((param, index) => {
      if (param.type.kind === 'array') {
        this.fail(param.span.line, param.span.column, 'kernel 参数不能是数组，用指针');
      }
      const reg = this.alloc();
      const pointer = isPointer(param.type);
      this.emit(
        { op: 'param', dst: reg, index, ty: pointer ? 'u32' : irTypeOf(param.type) },
        param.span.line
      );
      this.bind(param.name, { where: 'param', reg, type: param.type });
      this.params.push({
        name: param.name,
        ty: pointer ? 'u32' : irTypeOf(param.type),
        isPointer: pointer,
        elementBytes: pointer ? sizeOf((param.type as { to: CudaType }).to) : 4,
      });
    });

    for (const [name, value] of Object.entries(DEVICE_CONSTANTS)) {
      const reg = this.constant(value, 'i32', this.kernel.span.line);
      this.bind(name, { where: 'reg', reg, type: { kind: 'scalar', scalar: 'int' } });
    }

    if (this.ctx.host) {
      for (const [name, value] of Object.entries(HOST_CONSTANTS)) {
        const reg = this.constant(value, 'i32', this.kernel.span.line);
        this.bind(name, { where: 'reg', reg, type: { kind: 'scalar', scalar: 'int' } });
      }
    }

    this.stmt(this.kernel.body);
    const exitAt = this.here();
    this.emit({ op: 'ret' }, this.kernel.span.line);
    for (const at of this.topReturns) {
      (this.insts[at] as { target: number }).target = exitAt;
    }

    return {
      name: this.kernel.name,
      insts: this.insts,
      params: this.params,
      numRegs: this.numRegs,
      sharedBytes: this.sharedBytes,
      sharedVars: this.sharedVars,
      localBytes: this.localBytes,
      registersPerThread: estimateRegisters(this.insts, this.numRegs),
      lines: this.lines,
      ...(this.strings.length ? { strings: this.strings } : {}),
      ...(this.launches.length ? { launches: this.launches } : {}),
    };
  }

  /* ---------------- 基础设施 ---------------- */

  private fail(line: number, column: number, message: string): never {
    throw new CudaCompileError(message, { line, column });
  }

  private alloc(): number {
    return this.numRegs++;
  }

  private emit(inst: Inst, line: number): number {
    this.insts.push(inst);
    this.lines.push(line);
    return this.insts.length - 1;
  }

  private here(): number {
    return this.insts.length;
  }

  private bind(name: string, binding: Binding): void {
    this.scopes[this.scopes.length - 1].set(name, binding);
  }

  private lookup(name: string): Binding | undefined {
    const floor = this.scopeFloor.length ? this.scopeFloor[this.scopeFloor.length - 1] : 0;
    for (let i = this.scopes.length - 1; i >= floor; i -= 1) {
      const found = this.scopes[i].get(name);
      if (found) return found;
    }
    return undefined;
  }

  private pushScope(): void {
    this.scopes.push(new Map());
  }

  private popScope(): void {
    this.scopes.pop();
  }

  private constant(value: number, ty: IrType, line: number): number {
    const reg = this.alloc();
    this.emit({ op: 'const', dst: reg, value, ty }, line);
    return reg;
  }

  /* ---------------- 类型 ---------------- */

  /** C 的通常算术转换，裁剪到我们的四种标量 */
  private unify(a: CudaType, b: CudaType, line: number, column: number): CudaType {
    if (a.kind !== 'scalar' || b.kind !== 'scalar') {
      this.fail(line, column, `不能对 ${typeName(a)} 和 ${typeName(b)} 做算术`);
    }
    if (a.scalar === 'float' || b.scalar === 'float') return { kind: 'scalar', scalar: 'float' };
    if (a.scalar === 'uint' || b.scalar === 'uint') return { kind: 'scalar', scalar: 'uint' };
    return { kind: 'scalar', scalar: 'int' };
  }

  private convert(value: Value, target: CudaType, line: number): Value {
    const from = irTypeOf(value.type);
    const to = irTypeOf(target);
    if (from === to) return { reg: value.reg, type: target };
    const dst = this.alloc();
    this.emit({ op: 'cvt', dst, a: value.reg, from, to }, line);
    return { reg: dst, type: target };
  }

  /**
   * 不生成代码，只算出一个表达式的静态类型。
   *
   * 三目运算需要它：两个分支要转成同一个类型再写进同一个寄存器，
   * 而 `then` 分支的代码必须在知道目标类型之后才能生成 —— 否则就得先生成、
   * 再回过头改指令流，那条路试过，脆得多。
   */
  private staticTypeOf(node: Expr): CudaType {
    switch (node.kind) {
      case 'intLit': case 'boolLit':
        return { kind: 'scalar', scalar: 'int' };
      case 'floatLit':
        return { kind: 'scalar', scalar: 'float' };
      case 'builtin':
        return { kind: 'scalar', scalar: 'uint' };
      case 'name': {
        // wmma::mem_row_major 这类枚举名不是变量
        if (node.name.startsWith('wmma::')) return { kind: 'scalar', scalar: 'int' };
        const binding = this.lookup(node.name);
        if (!binding) this.fail(node.span.line, node.span.column, `没有声明过 \`${node.name}\``);
        if (binding.where === 'local' && binding.type.kind === 'array') {
          return { kind: 'pointer', to: binding.type.of, space: 'local' };
        }
        return binding.type;
      }
      case 'unary':
        return node.op === '!'
          ? { kind: 'scalar', scalar: 'int' }
          : this.staticTypeOf(node.operand);
      case 'binary': {
        if (COMPARISONS.has(node.op) || node.op === '&&' || node.op === '||') {
          return { kind: 'scalar', scalar: 'int' };
        }
        const left = this.staticTypeOf(node.left);
        const right = this.staticTypeOf(node.right);
        if (isPointer(left)) return left;
        if (isPointer(right)) return right;
        return this.unify(left, right, node.span.line, node.span.column);
      }
      case 'ternary':
        return this.unify(
          this.staticTypeOf(node.then), this.staticTypeOf(node.otherwise),
          node.span.line, node.span.column
        );
      case 'cast':
        return node.to;
      case 'subscript': {
        const base = this.staticTypeOf(node.array);
        const element = elementOf(base);
        if (!element) this.fail(node.span.line, node.span.column, `${typeName(base)} 不能取下标`);
        return element;
      }
      case 'deref': {
        const pointer = this.staticTypeOf(node.pointer);
        if (!isPointer(pointer)) this.fail(node.span.line, node.span.column, `${typeName(pointer)} 不是指针`);
        return pointer.to;
      }
      case 'call': {
        // wmma 的四个函数都返回 void，用例里也不会拿它们的值
        if (node.callee.startsWith('wmma::')) return { kind: 'scalar', scalar: 'int' };
        if (SHFL_FNS[node.callee]) return this.staticTypeOf(node.args[1]);
        if (ATOMIC_FNS[node.callee]) {
          const pointer = this.staticTypeOf(node.args[0]);
          if (!isPointer(pointer)) this.fail(node.span.line, node.span.column, '原子操作的第一个参数得是指针');
          return pointer.to;
        }
        if (node.callee === '__ballot_sync' || node.callee === '__activemask') {
          return { kind: 'scalar', scalar: 'uint' };
        }
        if (node.callee === '__any_sync' || node.callee === '__all_sync' || node.callee === '__syncwarp') {
          return { kind: 'scalar', scalar: 'int' };
        }
        const spec = BUILTIN_FNS[node.callee];
        if (spec) {
          return spec.ty === 'f32'
            ? { kind: 'scalar', scalar: 'float' }
            : { kind: 'scalar', scalar: 'int' };
        }
        const user = this.ctx.functions.get(node.callee);
        if (user) {
          return user.returnType.kind === 'scalar' && user.returnType.scalar === 'void'
            ? { kind: 'scalar', scalar: 'int' }
            : user.returnType;
        }
        if (node.callee === 'lab_buffer') {
          return { kind: 'pointer', to: { kind: 'scalar', scalar: 'float' }, space: 'global' };
        }
        if (node.callee === 'cudaMalloc' || node.callee === 'printf' || HOST_FNS[node.callee]) {
          return { kind: 'scalar', scalar: 'int' };
        }
        this.fail(node.span.line, node.span.column, `暂不支持函数 \`${node.callee}\``);
      }
      case 'addressOf': {
        const target = this.staticTypeOf(node.target);
        return { kind: 'pointer', to: target, space: this.spaceOfLvalue(node.target) };
      }
      case 'assign':
        return this.staticTypeOf(node.target);
      case 'incdec':
        return this.staticTypeOf(node.target);
      case 'strLit':
        // 字符串只当 printf 的格式串用，不参与任何运算
        return { kind: 'scalar', scalar: 'int' };
    }
  }

  /** 一个左值静态上住在哪个地址空间 */
  private spaceOfLvalue(node: Expr): Space {
    switch (node.kind) {
      case 'name': {
        const binding = this.lookup(node.name);
        if (binding?.where === 'shared') return 'shared';
        if (binding?.where === 'local') return 'local';
        if (binding && binding.type.kind === 'pointer') return binding.type.space ?? 'global';
        return 'global';
      }
      case 'subscript':
        return this.spaceOfLvalue(node.array);
      case 'deref': {
        const pointer = this.staticTypeOf(node.pointer);
        return pointer.kind === 'pointer' ? pointer.space ?? 'global' : 'global';
      }
      default:
        return 'global';
    }
  }

  /* ---------------- 表达式 ---------------- */

  private expr(node: Expr): Value {
    switch (node.kind) {
      case 'intLit':
        return { reg: this.constant(node.value | 0, 'i32', node.span.line), type: { kind: 'scalar', scalar: 'int' } };

      case 'floatLit':
        return { reg: this.constant(node.value, 'f32', node.span.line), type: { kind: 'scalar', scalar: 'float' } };

      case 'boolLit':
        return { reg: this.constant(node.value ? 1 : 0, 'i32', node.span.line), type: { kind: 'scalar', scalar: 'int' } };

      case 'builtin': {
        const dst = this.alloc();
        const map: Record<string, string> = {
          'threadIdx.x': 'tid.x', 'threadIdx.y': 'tid.y', 'threadIdx.z': 'tid.z',
          'blockIdx.x': 'ctaid.x', 'blockIdx.y': 'ctaid.y', 'blockIdx.z': 'ctaid.z',
          'blockDim.x': 'ntid.x', 'blockDim.y': 'ntid.y', 'blockDim.z': 'ntid.z',
          'gridDim.x': 'nctaid.x', 'gridDim.y': 'nctaid.y', 'gridDim.z': 'nctaid.z',
          warpSize: 'warpsize',
        };
        this.emit({ op: 'sreg', dst, which: map[node.which] as never }, node.span.line);
        // 内建变量在 CUDA 里是 unsigned
        return { reg: dst, type: { kind: 'scalar', scalar: 'uint' } };
      }

      case 'name': {
        if (node.name.startsWith('wmma::')) {
          // 枚举名：给一个占位值，真正的语义由调用方按名字判
          return { reg: this.constant(0, 'i32', node.span.line), type: { kind: 'scalar', scalar: 'int' } };
        }
        const binding = this.lookup(node.name);
        if (!binding) this.fail(node.span.line, node.span.column, `没有声明过 \`${node.name}\``);
        if (binding.where === 'shared') {
          const dst = this.alloc();
          this.emit({ op: 'sharedbase', dst, offset: binding.offset }, node.span.line);
          // 数组名衰减成指针时把地址空间带上
          const decayed: CudaType = binding.type.kind === 'array'
            ? { kind: 'pointer', to: binding.type.of, space: 'shared' }
            : binding.type;
          return { reg: dst, type: decayed };
        }
        if (binding.where === 'local') {
          const dst = this.alloc();
          this.emit({ op: 'localbase', dst, offset: binding.offset }, node.span.line);
          const decayed: CudaType = binding.type.kind === 'array'
            ? { kind: 'pointer', to: binding.type.of, space: 'local' }
            : binding.type;
          return { reg: dst, type: decayed };
        }
        if (binding.where === 'regarray') {
          this.fail(node.span.line, node.span.column,
            `\`${node.name}\` 是一个待在寄存器里的数组，只能按常量下标访问，不能整体当指针用`);
        }
        if (binding.where === 'fragment') {
          this.fail(node.span.line, node.span.column,
            `\`${node.name}\` 是 wmma 的 fragment，只能交给 wmma::* 那几个函数，不能直接读写`);
        }
        return { reg: binding.reg, type: binding.type };
      }

      case 'unary': {
        const operand = this.expr(node.operand);
        if (node.op === '+') return operand;
        const ty = irTypeOf(operand.type);
        const dst = this.alloc();
        const kind = node.op === '-' ? 'neg' : node.op === '!' ? 'not' : 'bnot';
        if (node.op !== '-' && ty === 'f32') {
          this.fail(node.span.line, node.span.column, `\`${node.op}\` 不能用在 float 上`);
        }
        this.emit({ op: 'un', dst, a: operand.reg, kind, ty }, node.span.line);
        return {
          reg: dst,
          type: node.op === '!' ? { kind: 'scalar', scalar: 'int' } : operand.type,
        };
      }

      case 'binary':
        return this.binary(node);

      case 'ternary': {
        // 用分歧区实现：两边都可能有 lane 走到，而且**只在自己的 lane 上求值** ——
        // 三目里带访存时这一点是有意义的，`i < n ? a[i] : 0.0f` 不该越界读。
        const type = this.unify(
          this.staticTypeOf(node.then),
          this.staticTypeOf(node.otherwise),
          node.span.line, node.span.column
        );
        const result = this.alloc();
        const cond = this.expr(node.cond);
        const pushAt = this.emit(
          { op: 'push', cond: cond.reg, elsePc: -1, joinPc: -1, line: node.span.line },
          node.span.line
        );
        const thenValue = this.convert(this.expr(node.then), type, node.span.line);
        this.emit({ op: 'mov', dst: result, src: thenValue.reg }, node.span.line);
        const swapAt = this.here();
        this.emit({ op: 'swap', joinPc: -1 }, node.span.line);
        const elseValue = this.convert(this.expr(node.otherwise), type, node.span.line);
        this.emit({ op: 'mov', dst: result, src: elseValue.reg }, node.span.line);
        const joinAt = this.here();
        this.emit({ op: 'pop' }, node.span.line);
        this.patchPush(pushAt, swapAt, joinAt);
        this.patchSwap(swapAt, joinAt);
        return { reg: result, type };
      }

      case 'cast': {
        const operand = this.expr(node.operand);
        if (node.to.kind === 'pointer') {
          return { reg: operand.reg, type: node.to };
        }
        return this.convert(operand, node.to, node.span.line);
      }

      case 'subscript': {
        const direct = this.registerArraySlot(node);
        if (direct !== null) {
          return { reg: direct.reg, type: direct.type };
        }
        const address = this.addressOf(node);
        return this.loadFrom(address, node.span.line);
      }

      case 'deref': {
        const address = this.addressOf(node);
        return this.loadFrom(address, node.span.line);
      }

      case 'addressOf': {
        const address = this.addressOf(node.target);
        return { reg: address.reg, type: { kind: 'pointer', to: address.type, space: address.space } };
      }

      case 'call':
        return this.call(node);

      case 'strLit':
        this.fail(node.span.line, node.span.column,
          '字符串只能作为 printf 的格式串出现 —— 这个子集没有 char*');
        break;

      case 'assign':
        return this.assign(node);

      case 'incdec': {
        const before = this.expr(node.target);
        const one = this.constant(node.delta, irTypeOf(before.type) === 'f32' ? 'f32' : 'i32', node.span.line);
        const oneValue: Value = {
          reg: one,
          type: irTypeOf(before.type) === 'f32'
            ? { kind: 'scalar', scalar: 'float' }
            : { kind: 'scalar', scalar: 'int' },
        };
        const sum = this.arith(before, oneValue, '+', node.span.line, node.span.column);
        this.storeInto(node.target, sum, node.span.line, node.span.column);
        if (!node.postfix) return sum;
        // 后缀要的是旧值，而旧值的寄存器可能已经被覆写，复制一份
        const saved = this.alloc();
        this.emit({ op: 'mov', dst: saved, src: before.reg }, node.span.line);
        return { reg: saved, type: before.type };
      }
    }
  }

  private patchPush(at: number, elsePc: number, joinPc: number): void {
    const inst = this.insts[at];
    if (inst.op !== 'push') throw new Error('内部错误：patchPush 指向的不是 push');
    inst.elsePc = elsePc;
    inst.joinPc = joinPc;
  }

  private patchSwap(at: number, joinPc: number): void {
    const inst = this.insts[at];
    if (inst.op !== 'swap') throw new Error('内部错误：patchSwap 指向的不是 swap');
    inst.joinPc = joinPc;
  }

  private binary(node: Expr & { kind: 'binary' }): Value {
    const { op, span } = node;

    // && 与 || 在 C 里短路。SIMT 里「短路」的意思是：右边只在左边为真的
    // lane 上求值 —— 用分歧区表达，副作用与真硬件一致。
    if (op === '&&' || op === '||') {
      return this.shortCircuit(node);
    }

    const left = this.expr(node.left);
    const right = this.expr(node.right);
    return this.arith(left, right, op, span.line, span.column);
  }

  private shortCircuit(node: Expr & { kind: 'binary' }): Value {
    const line = node.span.line;
    const result = this.alloc();

    const left = this.toBool(this.expr(node.left), line);
    this.emit({ op: 'mov', dst: result, src: left.reg }, line);

    // && 时右边只在「左为真」的 lane 上算；|| 时只在「左为假」的 lane 上算。
    // 这就是 SIMT 里的短路：不是跳过，是掩码掉。
    let guard = left.reg;
    if (node.op === '||') {
      guard = this.alloc();
      this.emit({ op: 'un', dst: guard, a: left.reg, kind: 'not', ty: 'i32' }, line);
    }

    const pushAt = this.emit({ op: 'push', cond: guard, elsePc: -1, joinPc: -1, line }, line);
    const right = this.toBool(this.expr(node.right), line);
    this.emit({ op: 'mov', dst: result, src: right.reg }, line);
    const joinAt = this.here();
    this.emit({ op: 'pop' }, line);
    // 没有 else 分支：push 直接跳到 pop
    this.patchPush(pushAt, joinAt, joinAt);

    return { reg: result, type: { kind: 'scalar', scalar: 'int' } };
  }

  /** 把任意标量变成 0/1 */
  private toBool(value: Value, line: number): Value {
    const zero = this.constant(0, irTypeOf(value.type), line);
    const dst = this.alloc();
    this.emit({ op: 'bin', dst, a: value.reg, b: zero, kind: 'ne', ty: irTypeOf(value.type) }, line);
    return { reg: dst, type: { kind: 'scalar', scalar: 'int' } };
  }

  private arith(left: Value, right: Value, op: BinaryOp, line: number, column: number): Value {
    const kind = BIN_KIND[op];
    if (!kind) this.fail(line, column, `暂不支持运算符 \`${op}\``);

    // 指针算术：p + i 走元素步长
    if (isPointer(left.type) || isPointer(right.type)) {
      if (op !== '+' && op !== '-' && !COMPARISONS.has(op)) {
        this.fail(line, column, `指针不能做 \`${op}\``);
      }
      if (COMPARISONS.has(op)) {
        const dst = this.alloc();
        this.emit({ op: 'bin', dst, a: left.reg, b: right.reg, kind, ty: 'u32' }, line);
        return { reg: dst, type: { kind: 'scalar', scalar: 'int' } };
      }
      const pointer = isPointer(left.type) ? left : right;
      const offset = isPointer(left.type) ? right : left;
      const elementBytes = sizeOf((pointer.type as { to: CudaType }).to);
      const scaled = this.alloc();
      const bytes = this.constant(elementBytes, 'i32', line);
      this.emit({ op: 'bin', dst: scaled, a: offset.reg, b: bytes, kind: 'mul', ty: 'i32' }, line);
      const dst = this.alloc();
      this.emit({ op: 'bin', dst, a: pointer.reg, b: scaled, kind, ty: 'u32' }, line);
      return { reg: dst, type: pointer.type };
    }

    const unified = this.unify(left.type, right.type, line, column);
    const ty = irTypeOf(unified);
    if (ty === 'f32' && (op === '%' || op === '<<' || op === '>>' || op === '&' || op === '|' || op === '^')) {
      this.fail(line, column, `\`${op}\` 不能用在 float 上`);
    }

    const a = this.convert(left, unified, line);
    const b = this.convert(right, unified, line);
    const dst = this.alloc();
    this.emit({ op: 'bin', dst, a: a.reg, b: b.reg, kind, ty }, line);

    return {
      reg: dst,
      type: COMPARISONS.has(op) ? { kind: 'scalar', scalar: 'int' } : unified,
    };
  }

  /**
   * `__shfl_*_sync` —— warp 内直接读别的 lane 的寄存器。
   *
   * `width` 必须是编译期常量（真代码里也总是），因为它决定 warp 被切成
   * 几段，运行时才知道的话每个 lane 的段边界都要现算。
   */
  private shuffle(node: Expr & { kind: 'call' }): Value {
    const mode = SHFL_FNS[node.callee];
    const { line, column } = node.span;
    if (node.args.length < 3 || node.args.length > 4) {
      this.fail(line, column, `${node.callee} 需要 3 或 4 个参数（mask, var, lane[, width]）`);
    }
    const mask = this.convert(this.expr(node.args[0]), { kind: 'scalar', scalar: 'uint' }, line);
    const value = this.expr(node.args[1]);
    const lane = this.convert(this.expr(node.args[2]), { kind: 'scalar', scalar: 'int' }, line);

    let width = 32;
    if (node.args.length === 4) {
      const literal = node.args[3];
      if (literal.kind !== 'intLit') {
        this.fail(line, column, `${node.callee} 的 width 必须是常量`);
      }
      width = literal.value;
      if (width < 1 || width > 32 || (width & (width - 1)) !== 0) {
        this.fail(line, column, 'width 必须是 1..32 之间的 2 的幂');
      }
    }

    const dst = this.alloc();
    this.emit({
      op: 'shfl', dst, src: value.reg, lane: lane.reg, mask: mask.reg,
      mode, width, ty: irTypeOf(value.type), line,
    }, line);
    return { reg: dst, type: value.type };
  }

  private ballot(node: Expr & { kind: 'call' }): Value {
    const { line, column } = node.span;
    if (node.args.length !== 2) this.fail(line, column, '__ballot_sync(mask, pred)');
    const mask = this.convert(this.expr(node.args[0]), { kind: 'scalar', scalar: 'uint' }, line);
    const pred = this.expr(node.args[1]);
    const dst = this.alloc();
    this.emit({ op: 'ballot', dst, pred: pred.reg, mask: mask.reg, line }, line);
    return { reg: dst, type: { kind: 'scalar', scalar: 'uint' } };
  }

  /** `__any_sync` / `__all_sync` 就是 ballot 之后看掩码 */
  private anyAll(node: Expr & { kind: 'call' }): Value {
    const { line } = node.span;
    const voted = this.ballot({ ...node, callee: '__ballot_sync' });
    const dst = this.alloc();
    if (node.callee === '__any_sync') {
      const zero = this.constant(0, 'u32', line);
      this.emit({ op: 'bin', dst, a: voted.reg, b: zero, kind: 'ne', ty: 'u32' }, line);
    } else {
      // all：投票掩码要覆盖参与的每一个 lane
      const participants = this.convert(this.expr(node.args[0]), { kind: 'scalar', scalar: 'uint' }, line);
      this.emit({ op: 'bin', dst, a: voted.reg, b: participants.reg, kind: 'eq', ty: 'u32' }, line);
    }
    return { reg: dst, type: { kind: 'scalar', scalar: 'int' } };
  }

  /**
   * `atomicXxx(ptr, value)` —— 返回**旧值**，和真 API 一致。
   *
   * 第 5 关的门槛之一是 `atomics <= gridDim`：逼出 shuffle 规约而不是
   * 每个线程都往同一个地址 atomicAdd。所以这条指令必须单独计数。
   */
  private atomic(node: Expr & { kind: 'call' }): Value {
    const spec = ATOMIC_FNS[node.callee];
    const { line, column } = node.span;
    if (node.args.length !== spec.arity) {
      this.fail(line, column, `${node.callee} 需要 ${spec.arity} 个参数`);
    }

    const pointer = this.expr(node.args[0]);
    if (!isPointer(pointer.type)) {
      this.fail(line, column, `${node.callee} 的第一个参数得是指针`);
    }
    const elementType = pointer.type.to;
    // 共享内存上的原子操作要走共享地址空间 —— 地址是两套独立的偏移
    const space: Space = pointer.type.space ?? 'global';

    const value = this.convert(this.expr(node.args[1]), elementType, line);
    let compare = value.reg;
    if (spec.kind === 'cas') {
      // atomicCAS(addr, compare, val)：参数顺序是「比较值」在前
      const cmp = this.convert(this.expr(node.args[1]), elementType, line);
      const desired = this.convert(this.expr(node.args[2]), elementType, line);
      compare = cmp.reg;
      const dst = this.alloc();
      this.emit({
        op: 'atom', dst, addr: pointer.reg, value: desired.reg, compare,
        kind: 'cas', space, ty: irTypeOf(elementType), line,
      }, line);
      return { reg: dst, type: elementType };
    }

    const dst = this.alloc();
    this.emit({
      op: 'atom', dst, addr: pointer.reg, value: value.reg, compare,
      kind: spec.kind, space, ty: irTypeOf(elementType), line,
    }, line);
    return { reg: dst, type: elementType };
  }

  /**
   * `wmma::*` 的四个内建函数。
   *
   * fragment 的排布是**我们定义的**：一个 16×16 的 tile 展平之后，
   * 第 f 个元素放在 lane `f % 32` 的第 `f / 32` 个槽里。
   * 真硬件上这个排布是未定义的（所以 fragment 才是 opaque 类型），
   * 我们选一个让 load 尽量合并的排法。
   */
  private wmma(node: Expr & { kind: 'call' }): Value {
    const { line, column } = node.span;
    const name = node.callee.slice('wmma::'.length);
    const zero = (): Value => ({
      reg: this.constant(0, 'i32', line),
      type: { kind: 'scalar', scalar: 'int' },
    });

    const fragmentArg = (index: number): { base: number; type: FragmentType } => {
      const arg = node.args[index];
      if (arg?.kind !== 'name') this.fail(line, column, `${node.callee} 的第 ${index + 1} 个参数要是一个 fragment 变量`);
      const binding = this.lookup(arg.name);
      if (!binding || binding.where !== 'fragment') {
        this.fail(line, column, `\`${arg.name}\` 不是 fragment`);
      }
      return { base: binding.base, type: binding.type };
    };

    switch (name) {
      case 'fill_fragment': {
        if (node.args.length !== 2) this.fail(line, column, 'wmma::fill_fragment(frag, value)');
        const frag = fragmentArg(0);
        const value = this.convert(this.expr(node.args[1]), { kind: 'scalar', scalar: 'float' }, line);
        this.emit({ op: 'wmmafill', base: frag.base, slots: fragmentSlots(frag.type), value: value.reg }, line);
        return zero();
      }

      case 'load_matrix_sync': {
        if (node.args.length < 3) this.fail(line, column, 'wmma::load_matrix_sync(frag, ptr, ldm)');
        const frag = fragmentArg(0);
        const pointer = this.expr(node.args[1]);
        if (!isPointer(pointer.type)) this.fail(line, column, '第二个参数要是指针');
        const stride = this.convert(this.expr(node.args[2]), { kind: 'scalar', scalar: 'int' }, line);
        this.emit({
          op: 'wmmaload', base: frag.base, slots: fragmentSlots(frag.type),
          addr: pointer.reg, stride: stride.reg,
          space: pointer.type.space ?? 'global',
          colMajor: frag.type.layout === 'col_major',
          half: frag.type.element === 'half',
          line,
        }, line);
        return zero();
      }

      case 'store_matrix_sync': {
        if (node.args.length < 3) this.fail(line, column, 'wmma::store_matrix_sync(ptr, frag, ldm, layout)');
        const pointer = this.expr(node.args[0]);
        if (!isPointer(pointer.type)) this.fail(line, column, '第一个参数要是指针');
        const frag = fragmentArg(1);
        const stride = this.convert(this.expr(node.args[2]), { kind: 'scalar', scalar: 'int' }, line);
        const layout = node.args[3];
        const colMajor = layout?.kind === 'name' && layout.name === 'wmma::mem_col_major';
        this.emit({
          op: 'wmmastore', base: frag.base, slots: fragmentSlots(frag.type),
          addr: pointer.reg, stride: stride.reg,
          space: pointer.type.space ?? 'global',
          colMajor, line,
        }, line);
        return zero();
      }

      case 'mma_sync': {
        if (node.args.length !== 4) this.fail(line, column, 'wmma::mma_sync(d, a, b, c)');
        const d = fragmentArg(0);
        const a = fragmentArg(1);
        const b = fragmentArg(2);
        const c = fragmentArg(3);
        if (a.type.use !== 'matrix_a' || b.type.use !== 'matrix_b') {
          this.fail(line, column, 'mma_sync 的第 2、3 个参数要分别是 matrix_a 与 matrix_b 的 fragment');
        }
        if (d.type.use !== 'accumulator' || c.type.use !== 'accumulator') {
          this.fail(line, column, 'mma_sync 的第 1、4 个参数要是 accumulator 的 fragment');
        }
        this.emit({
          op: 'wmmamma', d: d.base, a: a.base, b: b.base, c: c.base,
          slots: fragmentSlots(d.type), line,
        }, line);
        return zero();
      }

      default:
        this.fail(line, column,
          `暂不支持 \`${node.callee}\` —— wmma 里实现了 fill_fragment / load_matrix_sync / store_matrix_sync / mma_sync`);
    }
  }

  private call(node: Expr & { kind: 'call' }): Value {
    if (node.callee.startsWith('wmma::')) return this.wmma(node);
    if (SHFL_FNS[node.callee]) return this.shuffle(node);
    if (ATOMIC_FNS[node.callee]) return this.atomic(node);
    if (node.callee === '__ballot_sync') return this.ballot(node);
    if (node.callee === '__any_sync' || node.callee === '__all_sync') return this.anyAll(node);
    if (node.callee === '__syncwarp') {
      const { line } = node.span;
      const mask = node.args.length
        ? this.convert(this.expr(node.args[0]), { kind: 'scalar', scalar: 'uint' }, line).reg
        : this.constant(-1, 'u32', line);
      this.emit({ op: 'syncwarp', mask, line }, line);
      // 返回值没人用，给一个 0 占位
      return { reg: this.constant(0, 'i32', line), type: { kind: 'scalar', scalar: 'int' } };
    }
    if (node.callee === '__activemask') {
      if (node.args.length) this.fail(node.span.line, node.span.column, '__activemask() 不带参数');
      const dst = this.alloc();
      this.emit({ op: 'activemask', dst }, node.span.line);
      return { reg: dst, type: { kind: 'scalar', scalar: 'uint' } };
    }

    const spec = BUILTIN_FNS[node.callee];
    if (!spec) {
      // 内建之外还有两条路：自己写的函数（内联展开）、宿主运行时。
      const user = this.ctx.functions.get(node.callee);
      if (user) {
        if (user.role === 'host' && !this.ctx.host) {
          this.fail(node.span.line, node.span.column,
            `\`${node.callee}\` 是宿主函数，kernel 里调用不了 —— 给它加 __device__`);
        }
        return this.inlineCall(user, node);
      }
      if (node.callee === 'cudaMalloc' || node.callee === 'printf' || HOST_FNS[node.callee]) {
        return this.hostCall(node);
      }
      this.fail(
        node.span.line, node.span.column,
        `暂不支持函数 \`${node.callee}\` —— 内建的只有 ${Object.keys(BUILTIN_FNS).join(' / ')}`
      );
    }
    if (node.args.length !== spec.arity) {
      this.fail(node.span.line, node.span.column, `${node.callee} 需要 ${spec.arity} 个参数，给了 ${node.args.length} 个`);
    }
    const target: CudaType = spec.ty === 'f32'
      ? { kind: 'scalar', scalar: 'float' }
      : { kind: 'scalar', scalar: 'int' };
    // fp8 那两个的参数类型不齐：第一个按各自的类型，后面两个是枚举（int）。
    // 一律按返回类型转的话，`__nv_cvt_fp8_to_halfraw(storage, __NV_E4M3)`
    // 会把存储字节转成 float 再传，解码就全错了。
    const isFp8 = spec.fn === '__nv_cvt_float_to_fp8' || spec.fn === '__nv_cvt_fp8_to_halfraw';
    const args = node.args.map((arg, index) => {
      const argTarget: CudaType = isFp8
        ? (index === 0 && spec.fn === '__nv_cvt_float_to_fp8'
            ? { kind: 'scalar', scalar: 'float' }
            : { kind: 'scalar', scalar: 'int' })
        : target;
      return this.convert(this.expr(arg), argTarget, node.span.line).reg;
    });
    const dst = this.alloc();
    this.emit({ op: 'call', dst, fn: spec.fn, args, ty: spec.ty }, node.span.line);
    return { reg: dst, type: target };
  }

  /* ---------------- 地址与访存 ---------------- */

  /**
   * 算出一个左值的地址。
   *
   * 返回地址寄存器、地址空间、以及元素类型。共享内存与全局内存的地址是两套
   * 独立的偏移，所以 space 必须一路带着走。
   */
  private addressOf(node: Expr): { reg: number; space: Space; type: CudaType } {
    switch (node.kind) {
      case 'subscript': {
        const base = this.addressBase(node.array);
        const index = this.expr(node.index);
        const elementType = elementOf(base.type);
        if (!elementType) {
          this.fail(node.span.line, node.span.column, `${typeName(base.type)} 不能取下标`);
        }
        const elementBytes = sizeOf(elementType);
        const asInt = this.convert(index, { kind: 'scalar', scalar: 'int' }, node.span.line);
        const scaled = this.alloc();
        const bytes = this.constant(elementBytes, 'i32', node.span.line);
        this.emit({ op: 'bin', dst: scaled, a: asInt.reg, b: bytes, kind: 'mul', ty: 'i32' }, node.span.line);
        const addr = this.alloc();
        this.emit({ op: 'bin', dst: addr, a: base.reg, b: scaled, kind: 'add', ty: 'u32' }, node.span.line);
        return { reg: addr, space: base.space, type: elementType };
      }

      case 'deref': {
        const pointer = this.expr(node.pointer);
        if (!isPointer(pointer.type)) {
          this.fail(node.span.line, node.span.column, `${typeName(pointer.type)} 不是指针，不能解引用`);
        }
        return { reg: pointer.reg, space: pointer.type.space ?? 'global', type: pointer.type.to };
      }

      default:
        this.fail(
          (node as Expr).span.line, (node as Expr).span.column,
          '这个表达式不能作为左值'
        );
    }
  }

  /** 下标的基址：可能是共享数组、指针参数、或者又一层下标 */
  private addressBase(node: Expr): { reg: number; space: Space; type: CudaType } {
    if (node.kind === 'name') {
      const binding = this.lookup(node.name);
      if (!binding) this.fail(node.span.line, node.span.column, `没有声明过 \`${node.name}\``);
      if (binding.where === 'shared') {
        const reg = this.alloc();
        this.emit({ op: 'sharedbase', dst: reg, offset: binding.offset }, node.span.line);
        return { reg, space: 'shared', type: binding.type };
      }
      if (binding.where === 'local') {
        const reg = this.alloc();
        this.emit({ op: 'localbase', dst: reg, offset: binding.offset }, node.span.line);
        return { reg, space: 'local', type: binding.type };
      }
      if (binding.where === 'regarray' || binding.where === 'fragment') {
        this.fail(node.span.line, node.span.column,
          `\`${node.name}\` 住在寄存器里，取不到地址`);
      }
      const space = binding.type.kind === 'pointer' ? binding.type.space ?? 'global' : 'global';
      return { reg: binding.reg, space, type: binding.type };
    }
    if (node.kind === 'subscript') {
      // 多维数组的中间一层：地址算出来，类型降一维
      const inner = this.addressOf(node);
      return inner;
    }
    const value = this.expr(node);
    const space = value.type.kind === 'pointer' ? value.type.space ?? 'global' : 'global';
    return { reg: value.reg, space, type: value.type };
  }

  /**
   * `t[2]` 这种「寄存器数组 + 常量下标」直接落到某个具体寄存器上。
   * 返回 null 表示不是这种情况，走普通的地址路径。
   */
  private registerArraySlot(node: Expr & { kind: 'subscript' }): { reg: number; type: CudaType } | null {
    // 多维时一层层剥
    const indices: number[] = [];
    let cursor: Expr = node;
    while (cursor.kind === 'subscript') {
      const constant = foldConstant(cursor.index);
      if (constant === null) return null;
      indices.unshift(constant);
      cursor = cursor.array;
    }
    if (cursor.kind !== 'name') return null;
    const binding = this.lookup(cursor.name);
    if (!binding || binding.where !== 'regarray') return null;

    let type: CudaType = binding.type;
    let offset = 0;
    for (const index of indices) {
      if (type.kind !== 'array') {
        this.fail(node.span.line, node.span.column, `${cursor.name} 的维度比下标少`);
      }
      if (index < 0 || index >= type.length) {
        this.fail(node.span.line, node.span.column,
          `下标 ${index} 越界 —— ${cursor.name} 这一维只有 ${type.length} 个`);
      }
      offset = offset * type.length + index;
      type = type.of;
    }
    if (type.kind === 'array') {
      this.fail(node.span.line, node.span.column, `${cursor.name} 的下标给少了`);
    }
    return { reg: binding.base + offset, type };
  }

  private loadFrom(address: { reg: number; space: Space; type: CudaType }, line: number): Value {
    if (address.type.kind === 'array') {
      // `t[3]` 里 t 是二维数组时，取到的还是一段地址，不是值
      return { reg: address.reg, type: address.type };
    }
    const dst = this.alloc();
    this.emit(
      { op: 'load', dst, addr: address.reg, space: address.space, ty: irTypeOf(address.type), line },
      line
    );
    return { reg: dst, type: address.type };
  }

  private assign(node: Expr & { kind: 'assign' }): Value {
    let value: Value;
    if (node.op) {
      const current = this.expr(node.target);
      const operand = this.expr(node.value);
      value = this.arith(current, operand, node.op, node.span.line, node.span.column);
    } else {
      value = this.expr(node.value);
    }
    return this.storeInto(node.target, value, node.span.line, node.span.column);
  }

  private storeInto(target: Expr, value: Value, line: number, column: number): Value {
    if (target.kind === 'name') {
      const binding = this.lookup(target.name);
      if (!binding) this.fail(line, column, `没有声明过 \`${target.name}\``);
      if (binding.where !== 'reg' && binding.where !== 'param') {
        this.fail(line, column, `不能给 \`${target.name}\` 整体赋值`);
      }
      const converted = this.convert(value, binding.type, line);
      this.emit({ op: 'mov', dst: binding.reg, src: converted.reg }, line);
      return { reg: binding.reg, type: binding.type };
    }

    if (target.kind === 'subscript') {
      const direct = this.registerArraySlot(target);
      if (direct !== null) {
        const converted = this.convert(value, direct.type, line);
        this.emit({ op: 'mov', dst: direct.reg, src: converted.reg }, line);
        return { reg: direct.reg, type: direct.type };
      }
    }

    if (target.kind === 'subscript' || target.kind === 'deref') {
      const address = this.addressOf(target);
      if (address.type.kind === 'array') this.fail(line, column, '不能给整个数组赋值');
      const converted = this.convert(value, address.type, line);
      this.emit(
        { op: 'store', addr: address.reg, src: converted.reg, space: address.space, ty: irTypeOf(address.type), line },
        line
      );
      return converted;
    }

    this.fail(line, column, '这个表达式不能被赋值');
  }

  /* ---------------- 语句 ---------------- */

  private stmt(node: Stmt): void {
    switch (node.kind) {
      case 'block':
        this.pushScope();
        node.body.forEach((child) => this.stmt(child));
        this.popScope();
        break;

      case 'expr':
        this.expr(node.expr);
        break;

      case 'decl':
        node.decls.forEach((decl) => this.declare(decl));
        break;

      case 'if': {
        const cond = this.expr(node.cond);
        const pushAt = this.emit(
          { op: 'push', cond: cond.reg, elsePc: -1, joinPc: -1, line: node.span.line },
          node.span.line
        );
        this.frames.push({ kind: 'mask' });
        this.stmt(node.then);
        const swapAt = this.here();
        this.emit({ op: 'swap', joinPc: -1 }, node.span.line);
        if (node.otherwise) this.stmt(node.otherwise);
        this.frames.pop();
        const joinAt = this.here();
        this.emit({ op: 'pop' }, node.span.line);
        this.patchPush(pushAt, swapAt, joinAt);
        this.patchSwap(swapAt, joinAt);
        break;
      }

      case 'while': {
        const loopAt = this.emit({ op: 'loop', exitPc: -1 }, node.span.line);
        const condAt = this.here();
        const cond = this.expr(node.cond);
        const lcondAt = this.emit({ op: 'lcond', cond: cond.reg, exitPc: -1 }, node.span.line);
        const frame: Frame = { kind: 'loop', breaks: [], continues: [] };
        this.frames.push(frame);
        this.stmt(node.body);
        this.frames.pop();
        const backAt = this.here();
        this.emit({ op: 'jmp', target: condAt }, node.span.line);
        const exitAt = this.here();
        this.emit({ op: 'pop' }, node.span.line);
        (this.insts[loopAt] as { exitPc: number }).exitPc = exitAt;
        (this.insts[lcondAt] as { exitPc: number }).exitPc = exitAt;
        this.patchBreaks(frame, exitAt, backAt);
        break;
      }

      case 'for': {
        this.pushScope();
        if (node.init) this.stmt(node.init);
        const loopAt = this.emit({ op: 'loop', exitPc: -1 }, node.span.line);
        const condAt = this.here();
        let lcondAt = -1;
        if (node.cond) {
          const cond = this.expr(node.cond);
          lcondAt = this.emit({ op: 'lcond', cond: cond.reg, exitPc: -1 }, node.span.line);
        }
        const frame: Frame = { kind: 'loop', breaks: [], continues: [] };
        this.frames.push(frame);
        this.stmt(node.body);
        this.frames.pop();
        // continue 落在这里：步进表达式的第一条指令
        const stepAt = this.here();
        if (node.step) this.expr(node.step);
        this.emit({ op: 'jmp', target: condAt }, node.span.line);
        const exitAt = this.here();
        this.emit({ op: 'pop' }, node.span.line);
        (this.insts[loopAt] as { exitPc: number }).exitPc = exitAt;
        if (lcondAt >= 0) (this.insts[lcondAt] as { exitPc: number }).exitPc = exitAt;
        this.patchBreaks(frame, exitAt, stepAt);
        this.popScope();
        break;
      }

      case 'syncthreads':
        this.emit({ op: 'bar', line: node.span.line }, node.span.line);
        break;

      case 'return':
        this.returnStmt(node.value, node.span.line, node.span.column);
        break;

      case 'break': {
        this.requireHost(node.span.line, node.span.column, 'break');
        const loop = this.innermostLoop();
        if (!loop) this.fail(node.span.line, node.span.column, 'break 不在循环里');
        // 弹掉这个循环之上开着的每一层掩码；循环自己那一层由跳转目标处的
        // pop 负责，所以不在这里弹。
        this.unwindAbove(loop, node.span.line);
        loop.breaks.push(this.emit({ op: 'jmp', target: -1 }, node.span.line));
        break;
      }

      case 'continue': {
        this.requireHost(node.span.line, node.span.column, 'continue');
        const loop = this.innermostLoop();
        if (!loop) this.fail(node.span.line, node.span.column, 'continue 不在循环里');
        // 只弹这个循环之上的掩码帧 —— 循环本身还要接着转
        this.unwindAbove(loop, node.span.line);
        loop.continues.push(this.emit({ op: 'jmp', target: -1 }, node.span.line));
        break;
      }

      case 'launch':
        this.launchStmt(node);
        break;
    }
  }

  /* ---------------- 自己写的函数：整个内联进来 ---------------- */

  /**
   * 把一个函数内联到调用点。
   *
   * 没有调用栈，也就没有递归 —— 撞见递归明确报错，而不是编出一个
   * 会把寄存器数撑爆的东西。真卡上 `__device__` 函数本来也是全内联的
   * （GPU 上维护调用栈太贵），所以设备侧这不是简化；宿主侧是我们的
   * 实现选择，语义上没有区别。
   */
  private inlineCall(fn: FuncDecl, node: Extract<Expr, { kind: 'call' }>): Value {
    if (this.inlineStack.includes(fn.name)) {
      this.fail(node.span.line, node.span.column,
        `\`${fn.name}\` 递归调用了自己 —— 函数是内联展开的，展不开递归。`
        + '改成循环');
    }
    if (this.inlineStack.length >= 12) {
      this.fail(node.span.line, node.span.column, '函数内联层数超过 12 层，太深了');
    }
    if (node.args.length !== fn.params.length) {
      this.fail(node.span.line, node.span.column,
        `\`${fn.name}\` 要 ${fn.params.length} 个参数，给了 ${node.args.length} 个`);
    }

    // 实参在**调用者的**作用域里求值，然后才切进去
    const actuals = fn.params.map((param, index) => {
      const value = this.expr(node.args[index]);
      return isPointer(param.type) ? value : this.convert(value, param.type, node.span.line);
    });

    // 被内联的函数体里如果有动态下标的数组，也得落到 local memory。
    // 名字撞车会让调用者的同名数组一起落下去 —— 偏保守，不会算错。
    for (const name of arraysWithDynamicIndex(fn.body)) this.dynamicArrays.add(name);

    this.scopeFloor.push(this.scopes.length);
    this.pushScope();
    fn.params.forEach((param, index) => {
      const reg = this.alloc();
      this.emit({ op: 'mov', dst: reg, src: actuals[index].reg }, node.span.line);
      this.bind(param.name, { where: 'reg', reg, type: param.type });
    });

    const isVoid = fn.returnType.kind === 'scalar' && fn.returnType.scalar === 'void';
    const result = this.alloc();
    this.emit(
      { op: 'const', dst: result, value: 0, ty: isVoid ? 'i32' : irTypeOf(fn.returnType) },
      node.span.line
    );

    const frame: Frame = {
      kind: 'fn', returns: [], result, type: fn.returnType, name: fn.name,
    };
    this.frames.push(frame);
    this.inlineStack.push(fn.name);
    this.stmt(fn.body);
    this.inlineStack.pop();
    this.frames.pop();

    if (frame.kind === 'fn' && frame.returns.length) {
      // 跳转目标必须是一条真指令 —— 补一条无害的搬运当锚点，
      // 它算在记账指令里，时序模型会扣掉。
      const anchor = this.here();
      this.emit({ op: 'mov', dst: result, src: result }, node.span.line);
      for (const at of frame.returns) (this.insts[at] as { target: number }).target = anchor;
    }

    this.popScope();
    this.scopeFloor.pop();
    return { reg: result, type: isVoid ? { kind: 'scalar', scalar: 'int' } : fn.returnType };
  }

  /* ---------------- 宿主运行时 ---------------- */

  private hostCall(node: Extract<Expr, { kind: 'call' }>): Value {
    const { line, column } = node.span;
    if (!this.ctx.host) {
      this.fail(line, column,
        `\`${node.callee}\` 是宿主侧的函数，kernel 里调用不了`);
    }

    // 带出参的那几个：`f(&handle, ...)`。见 HOST_OUT_PARAM 的注释。
    const outParam = HOST_OUT_PARAM[node.callee];
    if (outParam !== undefined) {
      const outAt = outParam.at;
      const spec = node.callee === 'cudaMalloc'
        ? { fn: 'cudaMalloc' as const, arity: 2 }
        : HOST_FNS[node.callee];
      if (node.args.length !== spec.arity) {
        this.fail(line, column,
          `\`${node.callee}\` 要 ${spec.arity} 个参数，给了 ${node.args.length} 个`);
      }
      const target = unwrapCast(node.args[outAt]);
      if (target.kind !== 'addressOf' || target.target.kind !== 'name') {
        this.fail(line, column,
          `\`${node.callee}\` 的第 ${outAt + 1} 个参数要写成 \`${outParam.hint}\` —— `
          + '这个子集只认这一种写法');
      }
      const binding = this.lookup(target.target.name);
      if (!binding || binding.where !== 'reg') {
        this.fail(line, column, `\`${target.target.name}\` 不是一个已经声明的变量`);
      }
      if (node.callee === 'cudaMalloc' && !isPointer(binding.type)) {
        this.fail(line, column, `\`${target.target.name}\` 不是指针 —— cudaMalloc 要写成 (void**)&指针`);
      }
      const rest = node.args
        .filter((_, index) => index !== outAt)
        .map((arg) => this.convert(this.expr(arg), { kind: 'scalar', scalar: 'int' }, line).reg);
      this.emit(
        { op: 'hostcall', dst: binding.reg, fn: node.callee as HostFn, args: rest, line },
        line
      );
      // 真 API 返回的是 cudaError_t，成功是 0
      return { reg: this.constant(0, 'i32', line), type: { kind: 'scalar', scalar: 'int' } };
    }

    if (node.callee === 'printf') {
      if (!node.args.length) this.fail(line, column, 'printf 至少要一个格式串');
      const format = node.args[0];
      if (format.kind !== 'strLit') {
        this.fail(line, column, 'printf 的第一个参数必须是字符串字面量');
      }
      if (node.args.length > 4) {
        this.fail(line, column, 'printf 最多带三个值 —— 多的分几行打');
      }
      const index = this.strings.length;
      this.strings.push(format.value);
      const args = [this.constant(index, 'i32', line)];
      for (const arg of node.args.slice(1)) args.push(this.expr(arg).reg);
      const dst = this.alloc();
      this.emit({ op: 'hostcall', dst, fn: 'printf', args, line }, line);
      return { reg: dst, type: { kind: 'scalar', scalar: 'int' } };
    }

    const spec = HOST_FNS[node.callee];
    if (!spec) this.fail(line, column, `暂不支持函数 \`${node.callee}\``);
    if (node.args.length !== spec.arity) {
      this.fail(line, column, `\`${node.callee}\` 要 ${spec.arity} 个参数，给了 ${node.args.length} 个`);
    }
    const args = node.args.map((arg) => {
      const value = this.expr(arg);
      return isPointer(value.type)
        ? value.reg
        : this.convert(value, { kind: 'scalar', scalar: 'int' }, line).reg;
    });
    const dst = this.alloc();
    this.emit({ op: 'hostcall', dst, fn: spec.fn, args, line }, line);
    // lab_buffer 交回来的是一个**设备指针**，类型必须是 float* ——
    // 当成 int 的话 `p[i]` 会按标量算，静默读到别的地方
    const type: CudaType = spec.fn === 'lab_buffer'
      ? { kind: 'pointer', to: { kind: 'scalar', scalar: 'float' }, space: 'global' }
      : { kind: 'scalar', scalar: 'int' };
    return { reg: dst, type };
  }

  /* ---------------- 跳出去：弹掩码 ---------------- */

  /**
   * 从当前位置跳到某个外层出口之前，要弹掉几层掩码。
   *
   * **这套办法只在宿主代码里正确，所以只在宿主代码里放开。**
   * VM 是掩码栈机器：`pop` 恢复的是进入那一层之前的 active 掩码。
   * 32 个 lane 时，只有一部分 lane 执行到 `break`，直接 pop 会把没 break
   * 的 lane 也一起带走 —— 正确的做法是维护一条贯穿循环的「已退出」掩码，
   * 那是另一件事。宿主代码只有一个 lane：要么整条路径在跑（active=1），
   * 要么整个区域被跳过（VM 在 active=0 时根本不进来），于是静态地弹掉
   * 开着的那几层就是对的。
   */
  private unwindAbove(target: Frame, line: number): void {
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const frame = this.frames[i];
      if (frame === target) return;
      if (frame.kind !== 'fn') this.emit({ op: 'pop' }, line);
    }
  }

  /** 一路弹到函数边界（含边界之上的循环帧） */
  private unwindToFunction(line: number): { kind: 'fn'; returns: number[]; result: number; type: CudaType; name: string } | null {
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const frame = this.frames[i];
      if (frame.kind === 'fn') return frame;
      this.emit({ op: 'pop' }, line);
    }
    return null;
  }

  private innermostLoop(): { kind: 'loop'; breaks: number[]; continues: number[] } | null {
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const frame = this.frames[i];
      if (frame.kind === 'loop') return frame;
      if (frame.kind === 'fn') return null;
    }
    return null;
  }

  private patchBreaks(
    frame: { kind: 'loop'; breaks: number[]; continues: number[] },
    exitAt: number, continueAt: number
  ): void {
    for (const at of frame.breaks) (this.insts[at] as { target: number }).target = exitAt;
    // continue 跳到「下一轮的入口」：for 是步进表达式，while 是条件。
    // 跳到条件而漏掉步进的话，`for (i...; ++i) { if (x) continue; }` 会死循环。
    for (const at of frame.continues) (this.insts[at] as { target: number }).target = continueAt;
  }

  private requireHost(line: number, column: number, what: string): void {
    if (this.ctx.host) return;
    this.fail(line, column,
      `\`${what}\` 暂时只在宿主代码里支持 —— 设备侧要让一部分 lane 提前跳出，`
      + '需要一条贯穿的退出掩码，这个子集还没有。用 if / else 改写');
  }

  private returnStmt(value: Expr | undefined, line: number, column: number): void {
    // 先算返回值（还在原来的掩码下），再弹栈跳出去
    const enclosing = this.frames.find((frame) => frame.kind === 'fn') as
      | { kind: 'fn'; returns: number[]; result: number; type: CudaType; name: string }
      | undefined;

    if (enclosing) {
      if (value) {
        if (enclosing.type.kind === 'scalar' && enclosing.type.scalar === 'void') {
          this.fail(line, column, `\`${enclosing.name}\` 返回 void，return 不能带值`);
        }
        const produced = this.convert(this.expr(value), enclosing.type, line);
        this.emit({ op: 'mov', dst: enclosing.result, src: produced.reg }, line);
      }
      // 内联进来的函数体里，只要不是最后一句就得跳出去
      const above = this.frames.length - 1 - this.frames.lastIndexOf(enclosing);
      if (above > 0) this.requireHost(line, column, '函数里的提前 return');
      this.unwindToFunction(line);
      enclosing.returns.push(this.emit({ op: 'jmp', target: -1 }, line));
      return;
    }

    // 顶层：kernel 是 void，宿主的 main 返回退出码（当前不往外传，
    // 但语法上要收下，否则学员写的 `return 0;` 会报错）
    if (value && !this.ctx.host) {
      this.fail(line, column, 'kernel 是 void，return 不能带值');
    }
    if (value) this.expr(value);
    if (this.ctx.host && this.frames.length > 0) {
      this.unwindToFunction(line);
      this.topReturns.push(this.emit({ op: 'jmp', target: -1 }, line));
      return;
    }
    // 设备侧：`ret` 把**当前活跃的那些 lane** 标成退出，别的 lane 接着跑。
    // `if (i >= n) return;` 这句 CUDA 里最常见的守卫就靠它成立。
    this.emit({ op: 'ret' }, line);
  }

  /* ---------------- 起 kernel ---------------- */

  private launchStmt(node: Extract<Stmt, { kind: 'launch' }>): void {
    if (!this.ctx.host) {
      this.fail(node.span.line, node.span.column,
        '只有宿主代码能起 kernel —— 设备侧起 kernel 是动态并行，这个子集不支持');
    }
    const dim = (parts: Expr[]): number[] => {
      const regs = parts.map((part) => {
        const value = this.convert(this.expr(part), { kind: 'scalar', scalar: 'int' }, node.span.line);
        return value.reg;
      });
      while (regs.length < 3) regs.push(this.constant(1, 'i32', node.span.line));
      return regs;
    };
    const grid = dim(node.grid);
    const block = dim(node.block);
    const args = node.args.map((arg) => this.expr(arg).reg);
    const site = this.launches.length;
    this.launches.push({ kernel: node.kernel, grid, block, args, line: node.span.line });
    this.emit({ op: 'launch', site, line: node.span.line }, node.span.line);
  }

  private declare(decl: VarDecl): void {
    if (decl.shared) {
      if (decl.init) {
        this.fail(decl.span.line, decl.span.column, '__shared__ 变量不能有初始值 —— 共享内存的内容在 kernel 启动时是未定义的');
      }
      const bytes = sizeOf(decl.type);
      const align = 4;
      this.sharedBytes = Math.ceil(this.sharedBytes / align) * align;
      const offset = this.sharedBytes;
      this.sharedBytes += bytes;
      this.sharedVars.push({ name: decl.name, offset, bytes });
      this.bind(decl.name, { where: 'shared', offset, type: decl.type });
      return;
    }

    if (isFragment(decl.type)) {
      if (decl.init) {
        this.fail(decl.span.line, decl.span.column,
          'fragment 不能直接初始化，用 wmma::fill_fragment(frag, 0.0f)');
      }
      const slots = fragmentSlots(decl.type);
      const base = this.numRegs;
      for (let i = 0; i < slots; i += 1) {
        const reg = this.alloc();
        this.emit({ op: 'const', dst: reg, value: 0, ty: 'f32' }, decl.span.line);
      }
      this.bind(decl.name, { where: 'fragment', base, type: decl.type });
      return;
    }

    if (decl.type.kind === 'array') {
      if (decl.init) {
        this.fail(decl.span.line, decl.span.column, '数组暂不支持初始化列表，先声明再逐个赋值');
      }
      const elements = countElements(decl.type);
      if (this.dynamicArrays.has(decl.name)) {
        // 动态下标 → 落到 local memory。**这正是第 6 关要学员亲眼看到的事。**
        const offset = this.localBytes;
        this.localBytes += elements * 4;
        this.bind(decl.name, { where: 'local', offset, type: decl.type });
      } else {
        // 下标全是常量 → 展开成一组寄存器，和 nvcc 的做法一致
        const base = this.numRegs;
        for (let i = 0; i < elements; i += 1) {
          const reg = this.alloc();
          this.emit({ op: 'const', dst: reg, value: 0, ty: irTypeOf(elementScalar(decl.type)) }, decl.span.line);
        }
        this.bind(decl.name, { where: 'regarray', base, type: decl.type });
      }
      return;
    }

    const reg = this.alloc();
    let boundType = decl.type;
    if (decl.init) {
      // `float* p = &s[0]` —— 声明里写不出地址空间，从初始值继承过来。
      // 不继承的话 p 会被当成全局指针，读到的是完全不相干的内存。
      const initType = this.staticTypeOf(decl.init);
      if (decl.type.kind === 'pointer' && initType.kind === 'pointer' && initType.space) {
        boundType = { ...decl.type, space: initType.space };
      }
    }
    this.bind(decl.name, { where: 'reg', reg, type: boundType });
    if (decl.init) {
      const value = this.convert(this.expr(decl.init), boundType, decl.span.line);
      this.emit({ op: 'mov', dst: reg, src: value.reg }, decl.span.line);
    } else {
      // 未初始化的变量在真卡上是垃圾值。我们给 0，但这是**已知的分叉**：
      // 靠未初始化值出错的程序在这里不会暴露。
      this.emit({ op: 'const', dst: reg, value: 0, ty: irTypeOf(decl.type) }, decl.span.line);
    }
  }
}

/** 数组一共有多少个标量元素 */
function countElements(type: CudaType): number {
  return type.kind === 'array' ? type.length * countElements(type.of) : 1;
}

/** 剥到最里面的标量类型 */
function elementScalar(type: CudaType): CudaType {
  return type.kind === 'array' ? elementScalar(type.of) : type;
}

/** 能折成编译期常量就折，不能就返回 null */
function foldConstant(node: Expr): number | null {
  switch (node.kind) {
    case 'intLit': return node.value;
    case 'unary': {
      const inner = foldConstant(node.operand);
      if (inner === null) return null;
      return node.op === '-' ? -inner : node.op === '+' ? inner : null;
    }
    case 'binary': {
      const a = foldConstant(node.left);
      const b = foldConstant(node.right);
      if (a === null || b === null) return null;
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? null : Math.trunc(a / b);
        case '%': return b === 0 ? null : a % b;
        default: return null;
      }
    }
    default: return null;
  }
}

/**
 * 估算每线程要多少寄存器。
 *
 * 做法：在扁平 IR 上做一遍后向活跃变量分析，取所有指令点上活跃集合的最大值。
 * 循环靠迭代到不动点处理。
 *
 * **这是估计值，不是真的寄存器分配。** 真 nvcc 还会做合并、重排、
 * 以及为了提高占用率主动限制寄存器数。所以它只用来算占用率与展示 ——
 * 门槛用的是精确的 localBytes，见 design/gpulab.md 第七节。
 */
function estimateRegisters(insts: Inst[], numRegs: number): number {
  if (!insts.length || !numRegs) return 0;

  const defs: number[] = [];
  const uses: number[][] = [];
  const succs: number[][] = [];

  for (let i = 0; i < insts.length; i += 1) {
    const inst = insts[i];
    let def = -1;
    const use: number[] = [];
    const next: number[] = [];

    switch (inst.op) {
      case 'const': def = inst.dst; break;
      case 'mov': def = inst.dst; use.push(inst.src); break;
      case 'bin': def = inst.dst; use.push(inst.a, inst.b); break;
      case 'un': case 'cvt': def = inst.dst; use.push(inst.a); break;
      case 'sreg': case 'param': case 'sharedbase': case 'localbase': case 'activemask':
        def = inst.dst; break;
      case 'load': def = inst.dst; use.push(inst.addr); break;
      case 'store': use.push(inst.addr, inst.src); break;
      case 'call': def = inst.dst; use.push(...inst.args); break;
      case 'shfl': def = inst.dst; use.push(inst.src, inst.lane, inst.mask); break;
      case 'ballot': def = inst.dst; use.push(inst.pred, inst.mask); break;
      case 'syncwarp': use.push(inst.mask); break;
      case 'atom': def = inst.dst; use.push(inst.addr, inst.value, inst.compare); break;
      case 'push': use.push(inst.cond); break;
      case 'lcond': use.push(inst.cond); break;
      default: break;
    }

    switch (inst.op) {
      case 'jmp': next.push(inst.target); break;
      case 'push': next.push(i + 1, inst.elsePc); break;
      case 'swap': next.push(i + 1, inst.joinPc); break;
      case 'lcond': next.push(i + 1, inst.exitPc); break;
      case 'loop': next.push(i + 1, inst.exitPc); break;
      case 'ret': break;
      default: next.push(i + 1); break;
    }

    defs.push(def);
    uses.push(use);
    succs.push(next.filter((target) => target >= 0 && target < insts.length));
  }

  // liveOut[i]：跑完第 i 条之后还活着的寄存器
  const liveOut: Set<number>[] = insts.map(() => new Set<number>());
  let changed = true;
  let rounds = 0;
  while (changed && rounds < 100) {
    changed = false;
    rounds += 1;
    for (let i = insts.length - 1; i >= 0; i -= 1) {
      const out = liveOut[i];
      const before = out.size;
      for (const next of succs[i]) {
        // liveIn(next) = uses(next) ∪ (liveOut(next) − def(next))
        for (const reg of uses[next]) out.add(reg);
        for (const reg of liveOut[next]) {
          if (reg !== defs[next]) out.add(reg);
        }
      }
      if (out.size !== before) changed = true;
    }
  }

  let peak = 0;
  for (let i = 0; i < insts.length; i += 1) {
    const live = new Set(liveOut[i]);
    for (const reg of uses[i]) live.add(reg);
    if (live.size > peak) peak = live.size;
  }
  // 真卡上还有一些固定开销（地址、谓词、ABI），加一点常数更接近 ncu 的数
  return peak + 4;
}

/** 剥掉外层的强制转换，`(void**)&p` 里要看的是 `&p` */
function unwrapCast(node: Expr): Expr {
  let current = node;
  while (current.kind === 'cast') current = current.operand;
  return current;
}

/** 数组或指针的元素类型 */
function elementOf(type: CudaType): CudaType | null {
  if (type.kind === 'array') return type.of;
  if (type.kind === 'pointer') return type.to;
  return null;
}

const NO_FUNCTIONS = new Map<string, FuncDecl>();

export function compileKernel(
  kernel: KernelDecl,
  functions: Map<string, FuncDecl> = NO_FUNCTIONS
): CompiledKernel {
  return new Compiler(kernel, { functions, host: false }).compile();
}

/**
 * 编译宿主程序的 `main`。
 *
 * 它编出来的东西和一个 kernel 长得一样，因为它就是用同一台 VM 跑的 ——
 * grid 与 block 都是 1，只有一个 lane 活着。
 */
export function compileHost(
  main: FuncDecl,
  functions: Map<string, FuncDecl>
): CompiledHost {
  if (main.params.length) {
    throw new CudaCompileError(
      'main 暂时不收参数 —— 写成 `int main(void)`',
      main.span
    );
  }
  const decl: KernelDecl = {
    name: 'main', params: [], body: main.body, span: main.span,
  };
  return new Compiler(decl, { functions, host: true }).compile();
}

