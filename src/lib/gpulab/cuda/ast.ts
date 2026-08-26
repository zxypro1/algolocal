/**
 * 我们自己的 CUDA AST
 *
 * tree-sitter 给的是完整的具体语法树，节点又多又碎。这一层把它翻成一棵
 * 小得多的抽象树，好让后面的编译器不必到处认 tree-sitter 的节点名。
 *
 * 这棵树只覆盖 design/gpulab.md 里写明的 C99 子集 + CUDA 扩展。
 * 子集之外的语法在 lower.ts 里**明确报错**。
 */

export interface SourceSpan {
  line: number;
  column: number;
}

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export type ScalarKind = 'int' | 'uint' | 'float' | 'bool' | 'void';

export interface ScalarType {
  kind: 'scalar';
  scalar: ScalarKind;
}

export interface PointerType {
  kind: 'pointer';
  to: CudaType;
  /**
   * 指向哪个地址空间。
   *
   * 不带这一条的话 `float* p = &s[0]`（s 是 __shared__）会悄悄按全局内存
   * 去读 —— 地址对不上，算出来的东西全是错的，而且不报任何错。
   * 缺省是 global，只有从 `__shared__` 变量取地址时才是 shared。
   */
  space?: 'global' | 'shared' | 'local';
}

/** 定长数组。共享内存的 `__shared__ float t[32][33]` 就是它。 */
export interface ArrayType {
  kind: 'array';
  of: CudaType;
  length: number;
}

export type CudaType = ScalarType | PointerType | ArrayType;

export const INT: ScalarType = { kind: 'scalar', scalar: 'int' };
export const UINT: ScalarType = { kind: 'scalar', scalar: 'uint' };
export const FLOAT: ScalarType = { kind: 'scalar', scalar: 'float' };
export const BOOL: ScalarType = { kind: 'scalar', scalar: 'bool' };
export const VOID: ScalarType = { kind: 'scalar', scalar: 'void' };

export function isFloat(type: CudaType): boolean {
  return type.kind === 'scalar' && type.scalar === 'float';
}

export function isPointer(type: CudaType): type is PointerType {
  return type.kind === 'pointer';
}

/** 一个元素占几个字节。指针按 4 字节算（我们的地址空间是 32 位偏移）。 */
export function sizeOf(type: CudaType): number {
  switch (type.kind) {
    case 'scalar':
      return type.scalar === 'void' ? 0 : 4;
    case 'pointer':
      return 4;
    case 'array':
      return sizeOf(type.of) * type.length;
  }
}

export function typeName(type: CudaType): string {
  switch (type.kind) {
    case 'scalar':
      return type.scalar;
    case 'pointer':
      return `${typeName(type.to)}*`;
    case 'array':
      return `${typeName(type.of)}[${type.length}]`;
  }
}

/* ------------------------------------------------------------------ */
/* 表达式                                                              */
/* ------------------------------------------------------------------ */

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '<<' | '>>' | '&' | '|' | '^'
  | '<' | '<=' | '>' | '>=' | '==' | '!='
  | '&&' | '||';

export type UnaryOp = '-' | '!' | '~' | '+';

/** 内建变量。`.x/.y/.z` 在这里已经拆开了。 */
export type BuiltinVar =
  | 'threadIdx.x' | 'threadIdx.y' | 'threadIdx.z'
  | 'blockIdx.x' | 'blockIdx.y' | 'blockIdx.z'
  | 'blockDim.x' | 'blockDim.y' | 'blockDim.z'
  | 'gridDim.x' | 'gridDim.y' | 'gridDim.z'
  | 'warpSize';

export type Expr =
  | { kind: 'intLit'; value: number; span: SourceSpan }
  | { kind: 'floatLit'; value: number; span: SourceSpan }
  | { kind: 'boolLit'; value: boolean; span: SourceSpan }
  | { kind: 'name'; name: string; span: SourceSpan }
  | { kind: 'builtin'; which: BuiltinVar; span: SourceSpan }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr; span: SourceSpan }
  | { kind: 'unary'; op: UnaryOp; operand: Expr; span: SourceSpan }
  | { kind: 'ternary'; cond: Expr; then: Expr; otherwise: Expr; span: SourceSpan }
  | { kind: 'subscript'; array: Expr; index: Expr; span: SourceSpan }
  | { kind: 'deref'; pointer: Expr; span: SourceSpan }
  /** `&lvalue` —— 取地址。`atomicAdd(&hist[i], 1)` 这类写法要用。 */
  | { kind: 'addressOf'; target: Expr; span: SourceSpan }
  | { kind: 'cast'; to: CudaType; operand: Expr; span: SourceSpan }
  | { kind: 'call'; callee: string; args: Expr[]; span: SourceSpan }
  | { kind: 'assign'; target: Expr; op: BinaryOp | null; value: Expr; span: SourceSpan }
  /** `++i` / `i++`；`postfix` 决定表达式的值是旧的还是新的 */
  | { kind: 'incdec'; target: Expr; delta: 1 | -1; postfix: boolean; span: SourceSpan };

/* ------------------------------------------------------------------ */
/* 语句                                                                */
/* ------------------------------------------------------------------ */

export interface VarDecl {
  name: string;
  type: CudaType;
  /** `__shared__` 的变量住在共享内存里，不是寄存器 */
  shared: boolean;
  init?: Expr;
  span: SourceSpan;
}

export type Stmt =
  | { kind: 'expr'; expr: Expr; span: SourceSpan }
  | { kind: 'decl'; decls: VarDecl[]; span: SourceSpan }
  | { kind: 'block'; body: Stmt[]; span: SourceSpan }
  | { kind: 'if'; cond: Expr; then: Stmt; otherwise?: Stmt; span: SourceSpan }
  | { kind: 'for'; init?: Stmt; cond?: Expr; step?: Expr; body: Stmt; span: SourceSpan }
  | { kind: 'while'; cond: Expr; body: Stmt; span: SourceSpan }
  | { kind: 'return'; value?: Expr; span: SourceSpan }
  | { kind: 'syncthreads'; span: SourceSpan };

/* ------------------------------------------------------------------ */
/* 顶层                                                                */
/* ------------------------------------------------------------------ */

export interface Param {
  name: string;
  type: CudaType;
  span: SourceSpan;
}

export interface KernelDecl {
  name: string;
  params: Param[];
  body: Stmt;
  span: SourceSpan;
}

export interface TranslationUnit {
  kernels: KernelDecl[];
}
