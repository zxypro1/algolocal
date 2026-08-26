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
  isFloat, isPointer, sizeOf, typeName,
  type BinaryOp, type CudaType, type Expr, type KernelDecl, type Stmt, type VarDecl,
} from '../cuda/ast';
import { CudaCompileError } from '../cuda/lower';
import type {
  BinKind, BuiltinFn, CompiledKernel, Inst, IrType, KernelParam, SharedVar, Space,
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
  | { where: 'param'; reg: number; type: CudaType };

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
};

const COMPARISONS = new Set<BinaryOp>(['<', '<=', '>', '>=', '==', '!=']);

const BIN_KIND: Partial<Record<BinaryOp, BinKind>> = {
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'rem',
  '<<': 'shl', '>>': 'shr', '&': 'and', '|': 'or', '^': 'xor',
  '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', '==': 'eq', '!=': 'ne',
};

function irTypeOf(type: CudaType): IrType {
  if (type.kind === 'pointer') return 'u32';
  if (type.kind === 'array') return 'u32';
  switch (type.scalar) {
    case 'float': return 'f32';
    case 'uint': return 'u32';
    default: return 'i32';
  }
}

class Compiler {
  private insts: Inst[] = [];
  private lines: number[] = [];
  private scopes: Map<string, Binding>[] = [];
  private numRegs = 0;
  private sharedBytes = 0;
  private sharedVars: SharedVar[] = [];
  private params: KernelParam[] = [];

  constructor(private kernel: KernelDecl) {}

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

    this.stmt(this.kernel.body);
    this.emit({ op: 'ret' }, this.kernel.span.line);

    return {
      name: this.kernel.name,
      insts: this.insts,
      params: this.params,
      numRegs: this.numRegs,
      sharedBytes: this.sharedBytes,
      sharedVars: this.sharedVars,
      lines: this.lines,
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
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
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
        const binding = this.lookup(node.name);
        if (!binding) this.fail(node.span.line, node.span.column, `没有声明过 \`${node.name}\``);
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
        const spec = BUILTIN_FNS[node.callee];
        if (!spec) this.fail(node.span.line, node.span.column, `暂不支持函数 \`${node.callee}\``);
        return spec.ty === 'f32'
          ? { kind: 'scalar', scalar: 'float' }
          : { kind: 'scalar', scalar: 'int' };
      }
      case 'assign':
        return this.staticTypeOf(node.target);
      case 'incdec':
        return this.staticTypeOf(node.target);
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
        const binding = this.lookup(node.name);
        if (!binding) this.fail(node.span.line, node.span.column, `没有声明过 \`${node.name}\``);
        if (binding.where === 'shared') {
          const dst = this.alloc();
          this.emit({ op: 'sharedbase', dst, offset: binding.offset }, node.span.line);
          return { reg: dst, type: binding.type };
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
        const address = this.addressOf(node);
        return this.loadFrom(address, node.span.line);
      }

      case 'deref': {
        const address = this.addressOf(node);
        return this.loadFrom(address, node.span.line);
      }

      case 'call':
        return this.call(node);

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

  private call(node: Expr & { kind: 'call' }): Value {
    const spec = BUILTIN_FNS[node.callee];
    if (!spec) {
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
    const args = node.args.map((arg) => this.convert(this.expr(arg), target, node.span.line).reg);
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
        return { reg: pointer.reg, space: 'global', type: pointer.type.to };
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
      return { reg: binding.reg, space: 'global', type: binding.type };
    }
    if (node.kind === 'subscript') {
      // 多维数组的中间一层：地址算出来，类型降一维
      const inner = this.addressOf(node);
      return inner;
    }
    const value = this.expr(node);
    return { reg: value.reg, space: 'global', type: value.type };
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
      if (binding.where === 'shared') this.fail(line, column, `不能给共享数组 \`${target.name}\` 整体赋值`);
      const converted = this.convert(value, binding.type, line);
      this.emit({ op: 'mov', dst: binding.reg, src: converted.reg }, line);
      return { reg: binding.reg, type: binding.type };
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
        this.stmt(node.then);
        const swapAt = this.here();
        this.emit({ op: 'swap', joinPc: -1 }, node.span.line);
        if (node.otherwise) this.stmt(node.otherwise);
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
        this.stmt(node.body);
        this.emit({ op: 'jmp', target: condAt }, node.span.line);
        const exitAt = this.here();
        this.emit({ op: 'pop' }, node.span.line);
        (this.insts[loopAt] as { exitPc: number }).exitPc = exitAt;
        (this.insts[lcondAt] as { exitPc: number }).exitPc = exitAt;
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
        this.stmt(node.body);
        if (node.step) this.expr(node.step);
        this.emit({ op: 'jmp', target: condAt }, node.span.line);
        const exitAt = this.here();
        this.emit({ op: 'pop' }, node.span.line);
        (this.insts[loopAt] as { exitPc: number }).exitPc = exitAt;
        if (lcondAt >= 0) (this.insts[lcondAt] as { exitPc: number }).exitPc = exitAt;
        this.popScope();
        break;
      }

      case 'syncthreads':
        this.emit({ op: 'bar', line: node.span.line }, node.span.line);
        break;

      case 'return':
        if (node.value) this.fail(node.span.line, node.span.column, 'kernel 是 void，return 不能带值');
        // 提前 return 会让部分 lane 退出，那是发散的一种。当前子集里只允许
        // 出现在 kernel 末尾 —— 别处的 return 需要一条「退出掩码」，
        // 和 break 是同一件事，一起等后续实现。
        this.emit({ op: 'ret' }, node.span.line);
        break;
    }
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

    if (decl.type.kind === 'array') {
      this.fail(
        decl.span.line, decl.span.column,
        '暂不支持线程私有的数组 —— 真卡上它会落到 local memory（那正是第 6 关的内容），先用标量'
      );
    }

    const reg = this.alloc();
    this.bind(decl.name, { where: 'reg', reg, type: decl.type });
    if (decl.init) {
      const value = this.convert(this.expr(decl.init), decl.type, decl.span.line);
      this.emit({ op: 'mov', dst: reg, src: value.reg }, decl.span.line);
    } else {
      // 未初始化的变量在真卡上是垃圾值。我们给 0，但这是**已知的分叉**：
      // 靠未初始化值出错的程序在这里不会暴露。
      this.emit({ op: 'const', dst: reg, value: 0, ty: irTypeOf(decl.type) }, decl.span.line);
    }
  }
}

/** 数组或指针的元素类型 */
function elementOf(type: CudaType): CudaType | null {
  if (type.kind === 'array') return type.of;
  if (type.kind === 'pointer') return type.to;
  return null;
}

export function compileKernel(kernel: KernelDecl): CompiledKernel {
  return new Compiler(kernel).compile();
}

export { isFloat };
