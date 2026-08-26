/**
 * tree-sitter 的具体语法树 → 我们的 AST
 *
 * 这一层的职责有两条，第二条比第一条重要：
 *  1. 把节点翻过去；
 *  2. **翻不动的语法明确报错**，绝不悄悄降级。
 *
 * 一个学员写了 `struct` 或调用了自己写的 `__device__` 函数，得到的应该是
 * 「第 12 行：暂不支持 struct」，而不是一个能跑但算错的 kernel。模拟器最怕的
 * 就是「看起来跑了」。
 *
 * 不依赖 tree-sitter 的 field 名（这个语法里大多数节点没有挂 field），
 * 一律按子节点的 type 扫 —— 更啰嗦，但不会因为上游改了 field 名而无声失效。
 */
import type { TsNode } from './parser';
import {
  BOOL, FLOAT, INT, UINT, VOID,
  type BinaryOp, type BuiltinVar, type CudaType, type Expr, type KernelDecl,
  type Param, type SourceSpan, type Stmt, type TranslationUnit, type UnaryOp, type VarDecl,
} from './ast';

export class CudaCompileError extends Error {
  line: number;
  column: number;
  constructor(message: string, span: SourceSpan) {
    super(`${span.line}:${span.column}: ${message}`);
    this.name = 'CudaCompileError';
    this.line = span.line;
    this.column = span.column;
  }
}

function spanOf(node: TsNode): SourceSpan {
  return { line: node.startPosition.row + 1, column: node.startPosition.column + 1 };
}

function fail(node: TsNode, message: string): never {
  throw new CudaCompileError(message, spanOf(node));
}

/** 只要具名子节点，跳过标点与关键字 */
function namedChildren(node: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

/** 所有子节点，含标点 —— 判断 `++i` 还是 `i++` 要用到 */
function allChildren(node: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (child) out.push(child);
  }
  return out;
}

/** 这些限定符我们读得懂，但对语义没有影响 */
const IGNORED_QUALIFIERS = new Set(['const', '__restrict__', 'restrict', 'volatile', '__volatile__']);

const BUILTIN_STRUCTS = new Set(['threadIdx', 'blockIdx', 'blockDim', 'gridDim']);

const BINARY_OPS = new Set<string>([
  '+', '-', '*', '/', '%', '<<', '>>', '&', '|', '^',
  '<', '<=', '>', '>=', '==', '!=', '&&', '||',
]);

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

function lowerTypeSpecifier(node: TsNode): CudaType {
  const text = node.text.trim();
  switch (node.type) {
    case 'primitive_type':
      switch (text) {
        case 'float': return FLOAT;
        case 'int': return INT;
        case 'unsigned': case 'unsigned int': return UINT;
        case 'bool': return BOOL;
        case 'void': return VOID;
        case 'double':
          fail(node, 'double 暂不支持 —— 这个工作台的算术全部在 fp32 上做，见 design/gpulab.md');
          break;
        default:
          fail(node, `暂不支持的类型：${text}`);
      }
      break;
    case 'sized_type_specifier': {
      const normalized = text.replace(/\s+/g, ' ');
      if (normalized === 'unsigned' || normalized === 'unsigned int') return UINT;
      if (normalized === 'signed' || normalized === 'signed int' || normalized === 'long') return INT;
      fail(node, `暂不支持的类型：${text}`);
      break;
    }
    case 'type_identifier':
      fail(node, `暂不支持自定义类型 \`${text}\` —— 当前子集只有 int / unsigned / float / bool`);
      break;
    default:
      fail(node, `暂不支持的类型写法：${node.type}`);
  }
}

/** 从一串子节点里挑出类型说明符 */
function findTypeSpecifier(children: TsNode[], at: TsNode): CudaType {
  for (const child of children) {
    if (child.type === 'type_qualifier' || child.type === 'storage_class_specifier') continue;
    if (child.type === '__shared__' || child.type === '__device__' || child.type === '__global__') continue;
    if (
      child.type === 'primitive_type' ||
      child.type === 'sized_type_specifier' ||
      child.type === 'type_identifier'
    ) {
      return lowerTypeSpecifier(child);
    }
  }
  fail(at, '看不出这个声明的类型');
}

interface Declared {
  name: string;
  type: CudaType;
  init?: TsNode;
}

/**
 * 走一个 declarator，把指针与数组的层次叠到基础类型上。
 *
 * `float* a` 的 declarator 是 `pointer_declarator(* , identifier)`；
 * `float t[16][17]` 是 `array_declarator(array_declarator(identifier, 16), 17)` ——
 * 注意外层才是最后一维，所以数组维度要从里往外读。
 */
function lowerDeclarator(node: TsNode, base: CudaType): Declared {
  switch (node.type) {
    case 'identifier':
      return { name: node.text, type: base };

    case 'pointer_declarator': {
      const inner = namedChildren(node).find(
        (child) => child.type !== 'type_qualifier' && !IGNORED_QUALIFIERS.has(child.type)
      );
      if (!inner) fail(node, '指针声明缺少名字');
      return lowerDeclarator(inner, { kind: 'pointer', to: base });
    }

    case 'array_declarator': {
      const children = namedChildren(node);
      const inner = children[0];
      const sizeNode = children[1];
      if (!inner) fail(node, '数组声明缺少名字');
      if (!sizeNode) {
        fail(node, '数组必须写出长度 —— 变长数组（VLA）在设备代码里本来也不能用');
      }
      const size = constIntOf(sizeNode);
      // 先把外层这一维套上，再往里走：外层是最后一维
      const declared = lowerDeclarator(inner, base);
      return { name: declared.name, type: appendDimension(declared.type, size) };
    }

    case 'init_declarator': {
      const children = namedChildren(node);
      const declared = lowerDeclarator(children[0], base);
      return { ...declared, init: children[1] };
    }

    case 'function_declarator':
      fail(node, '暂不支持函数指针与嵌套函数声明');
      break;

    default:
      fail(node, `暂不支持的声明写法：${node.type}`);
  }
}

/** 把一维追加到数组类型的最内层，让 `t[16][17]` 变成 array(16, array(17, float)) */
function appendDimension(type: CudaType, length: number): CudaType {
  if (type.kind === 'array') return { kind: 'array', of: appendDimension(type.of, length), length: type.length };
  return { kind: 'array', of: type, length };
}

/** 数组维度、模板参数这类地方要的是一个编译期常量 */
function constIntOf(node: TsNode): number {
  if (node.type === 'number_literal') {
    const value = parseNumberLiteral(node);
    if (!Number.isInteger(value.value) || value.isFloat) fail(node, '这里需要一个整数常量');
    return value.value;
  }
  if (node.type === 'binary_expression') {
    const children = namedChildren(node);
    const op = operatorOf(node);
    const a = constIntOf(children[0]);
    const b = constIntOf(children[1]);
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return Math.trunc(a / b);
      case '<<': return a << b;
      default: fail(node, `数组长度里暂不支持 \`${op}\``);
    }
  }
  fail(node, '数组长度必须是编译期常量');
}

/** 取一个二元/赋值/一元节点的运算符文本 */
function operatorOf(node: TsNode): string {
  for (const child of allChildren(node)) {
    if (child.namedChildCount === 0 && child.type !== 'comment' && !child.type.match(/^[a-z_]+$/)) {
      return child.type;
    }
  }
  // 兜底：找第一个不是具名子节点的
  const named = new Set(namedChildren(node));
  for (const child of allChildren(node)) {
    if (!named.has(child)) return child.type;
  }
  fail(node, '看不出这里的运算符');
}

interface ParsedNumber {
  value: number;
  isFloat: boolean;
}

function parseNumberLiteral(node: TsNode): ParsedNumber {
  const raw = node.text.trim();
  const cleaned = raw.replace(/[uUlL]+$/, '');
  if (/^[+-]?0[xX]/.test(cleaned)) {
    return { value: Number(cleaned), isFloat: false };
  }
  const isFloat = /[.eEfF]/.test(cleaned) && !/^[+-]?0[xX]/.test(cleaned);
  const withoutSuffix = cleaned.replace(/[fF]$/, '');
  const value = Number(withoutSuffix);
  if (!Number.isFinite(value)) fail(node, `看不懂的数字：${raw}`);
  return { value, isFloat };
}

/* ------------------------------------------------------------------ */
/* 表达式                                                              */
/* ------------------------------------------------------------------ */

function lowerExpr(node: TsNode): Expr {
  const span = spanOf(node);

  switch (node.type) {
    case 'number_literal': {
      const parsed = parseNumberLiteral(node);
      return parsed.isFloat
        ? { kind: 'floatLit', value: parsed.value, span }
        : { kind: 'intLit', value: parsed.value, span };
    }

    case 'true':
      return { kind: 'boolLit', value: true, span };
    case 'false':
      return { kind: 'boolLit', value: false, span };

    case 'identifier':
      if (node.text === 'warpSize') return { kind: 'builtin', which: 'warpSize', span };
      if (BUILTIN_STRUCTS.has(node.text)) {
        fail(node, `${node.text} 要带分量，比如 ${node.text}.x`);
      }
      return { kind: 'name', name: node.text, span };

    case 'field_expression': {
      const children = namedChildren(node);
      const base = children[0];
      const field = children[1];
      if (base.type === 'identifier' && BUILTIN_STRUCTS.has(base.text)) {
        const component = field.text;
        if (component !== 'x' && component !== 'y' && component !== 'z') {
          fail(field, `${base.text} 只有 .x / .y / .z`);
        }
        return { kind: 'builtin', which: `${base.text}.${component}` as BuiltinVar, span };
      }
      fail(node, '暂不支持结构体成员访问 —— 当前子集没有 struct');
      break;
    }

    case 'parenthesized_expression':
      return lowerExpr(namedChildren(node)[0]);

    case 'binary_expression': {
      const children = namedChildren(node);
      const op = operatorOf(node);
      if (!BINARY_OPS.has(op)) fail(node, `暂不支持运算符 \`${op}\``);
      return {
        kind: 'binary',
        op: op as BinaryOp,
        left: lowerExpr(children[0]),
        right: lowerExpr(children[1]),
        span,
      };
    }

    case 'unary_expression': {
      const children = namedChildren(node);
      const op = operatorOf(node);
      if (op !== '-' && op !== '!' && op !== '~' && op !== '+') {
        fail(node, `暂不支持一元运算符 \`${op}\``);
      }
      return { kind: 'unary', op: op as UnaryOp, operand: lowerExpr(children[0]), span };
    }

    case 'conditional_expression': {
      const children = namedChildren(node);
      return {
        kind: 'ternary',
        cond: lowerExpr(children[0]),
        then: lowerExpr(children[1]),
        otherwise: lowerExpr(children[2]),
        span,
      };
    }

    case 'subscript_expression': {
      const children = namedChildren(node);
      const array = lowerExpr(children[0]);
      const argList = children[1];
      const index = argList.type === 'subscript_argument_list'
        ? namedChildren(argList)[0]
        : argList;
      if (!index) fail(node, '下标是空的');
      return { kind: 'subscript', array, index: lowerExpr(index), span };
    }

    case 'pointer_expression': {
      const children = namedChildren(node);
      const op = operatorOf(node);
      if (op === '&') fail(node, '暂不支持取地址运算符 `&`');
      return { kind: 'deref', pointer: lowerExpr(children[0]), span };
    }

    case 'cast_expression': {
      const children = namedChildren(node);
      const descriptor = children[0];
      const target = findTypeSpecifier(namedChildren(descriptor), descriptor);
      const pointerDepth = namedChildren(descriptor).filter(
        (child) => child.type === 'abstract_pointer_declarator'
      ).length;
      let to = target;
      for (let i = 0; i < pointerDepth; i += 1) to = { kind: 'pointer', to };
      return { kind: 'cast', to, operand: lowerExpr(children[1]), span };
    }

    case 'call_expression': {
      const children = namedChildren(node);
      const callee = children[0];
      if (callee.type !== 'identifier') {
        fail(node, '暂不支持通过表达式调用函数');
      }
      const argList = children[1];
      const args = argList && argList.type === 'argument_list' ? namedChildren(argList) : [];
      return { kind: 'call', callee: callee.text, args: args.map(lowerExpr), span };
    }

    case 'assignment_expression': {
      const children = namedChildren(node);
      const op = operatorOf(node);
      const compound = op === '=' ? null : (op.slice(0, -1) as BinaryOp);
      if (compound && !BINARY_OPS.has(compound)) fail(node, `暂不支持复合赋值 \`${op}\``);
      return {
        kind: 'assign',
        target: lowerExpr(children[0]),
        op: compound,
        value: lowerExpr(children[1]),
        span,
      };
    }

    case 'update_expression': {
      const children = allChildren(node);
      const opNode = children.find((child) => child.type === '++' || child.type === '--');
      if (!opNode) fail(node, '看不出是 ++ 还是 --');
      const target = namedChildren(node)[0];
      // 前缀的话运算符在名字前面
      const postfix = opNode.startIndex > target.startIndex;
      return {
        kind: 'incdec',
        target: lowerExpr(target),
        delta: opNode.type === '++' ? 1 : -1,
        postfix,
        span,
      };
    }

    case 'comma_expression':
      fail(node, '暂不支持逗号表达式');
      break;

    case 'concatenated_string':
    case 'string_literal':
      fail(node, '设备代码里暂不支持字符串');
      break;

    default:
      fail(node, `暂不支持的表达式：${node.type}`);
  }
}

/* ------------------------------------------------------------------ */
/* 语句                                                                */
/* ------------------------------------------------------------------ */

function lowerDeclaration(node: TsNode): Stmt {
  const children = namedChildren(node);
  const shared = allChildren(node).some(
    (child) => child.text.trim() === '__shared__' || child.type === '__shared__'
  );
  if (allChildren(node).some((child) => child.text.trim() === 'extern')) {
    fail(node, '暂不支持 `extern __shared__`（动态共享内存）—— 先用定长的 __shared__ 数组');
  }
  const base = findTypeSpecifier(children, node);

  const decls: VarDecl[] = [];
  for (const child of children) {
    if (
      child.type === 'type_qualifier' ||
      child.type === 'primitive_type' ||
      child.type === 'sized_type_specifier' ||
      child.type === 'storage_class_specifier'
    ) continue;

    const declared = lowerDeclarator(child, base);
    decls.push({
      name: declared.name,
      type: declared.type,
      shared,
      init: declared.init ? lowerExpr(declared.init) : undefined,
      span: spanOf(child),
    });
  }

  if (!decls.length) fail(node, '这个声明里没有变量');
  return { kind: 'decl', decls, span: spanOf(node) };
}

/** `if (...)` / `while (...)` 的条件被包在 condition_clause 里 */
function conditionOf(node: TsNode): Expr {
  const clause = namedChildren(node).find((child) => child.type === 'condition_clause');
  if (!clause) fail(node, '缺少条件');
  const inner = namedChildren(clause)[0];
  if (!inner) fail(clause, '条件是空的');
  return lowerExpr(inner);
}

function lowerStmt(node: TsNode): Stmt {
  const span = spanOf(node);

  switch (node.type) {
    case 'compound_statement':
      return { kind: 'block', body: namedChildren(node).map(lowerStmt), span };

    case 'declaration':
      return lowerDeclaration(node);

    case 'expression_statement': {
      const inner = namedChildren(node)[0];
      if (!inner) return { kind: 'block', body: [], span };
      // `__syncthreads();` 是语句而不是普通调用 —— 它要让整个 warp 停下来
      if (inner.type === 'call_expression') {
        const callee = namedChildren(inner)[0];
        if (callee?.type === 'identifier' && callee.text === '__syncthreads') {
          return { kind: 'syncthreads', span };
        }
      }
      return { kind: 'expr', expr: lowerExpr(inner), span };
    }

    case 'if_statement': {
      const cond = conditionOf(node);
      const children = namedChildren(node);
      const thenNode = children.find(
        (child) => child.type !== 'condition_clause' && child.type !== 'else_clause'
      );
      if (!thenNode) fail(node, 'if 缺少主体');
      const elseClause = children.find((child) => child.type === 'else_clause');
      const elseNode = elseClause ? namedChildren(elseClause)[0] : undefined;
      return {
        kind: 'if',
        cond,
        then: lowerStmt(thenNode),
        otherwise: elseNode ? lowerStmt(elseNode) : undefined,
        span,
      };
    }

    case 'while_statement': {
      const cond = conditionOf(node);
      const body = namedChildren(node).find((child) => child.type !== 'condition_clause');
      if (!body) fail(node, 'while 缺少主体');
      return { kind: 'while', cond, body: lowerStmt(body), span };
    }

    case 'for_statement': {
      // 子节点是位置性的：for ( <init> <cond> ; <step> ) <body>
      // init 如果是 declaration，它自己带分号；如果是表达式，分号是独立的 token。
      const parts = namedChildren(node);
      let init: Stmt | undefined;
      let cond: Expr | undefined;
      let step: Expr | undefined;
      let body: TsNode | undefined;

      const semicolons = allChildren(node).filter((child) => child.type === ';');
      const lastSemicolon = semicolons.length ? semicolons[semicolons.length - 1].startIndex : -1;
      const closeParen = allChildren(node).filter((child) => child.type === ')').pop();
      const closeAt = closeParen ? closeParen.startIndex : Number.MAX_SAFE_INTEGER;

      for (const part of parts) {
        if (part.startIndex > closeAt) { body = part; continue; }
        if (part.type === 'declaration') { init = lowerDeclaration(part); continue; }
        if (part.startIndex > lastSemicolon) { step = lowerExpr(part); continue; }
        if (!init && !cond && isStatementLike(part)) { init = { kind: 'expr', expr: lowerExpr(part), span: spanOf(part) }; continue; }
        cond = lowerExpr(part);
      }

      if (!body) fail(node, 'for 缺少主体');
      return { kind: 'for', init, cond, step, body: lowerStmt(body), span };
    }

    case 'return_statement': {
      const value = namedChildren(node)[0];
      return { kind: 'return', value: value ? lowerExpr(value) : undefined, span };
    }

    case 'break_statement':
      fail(node, '暂不支持 break —— 用循环条件表达同样的意思');
      break;
    case 'continue_statement':
      fail(node, '暂不支持 continue');
      break;
    case 'switch_statement':
      fail(node, '暂不支持 switch');
      break;
    case 'do_statement':
      fail(node, '暂不支持 do-while');
      break;
    case 'goto_statement':
      fail(node, 'goto 不在支持范围内');
      break;

    case 'comment':
      return { kind: 'block', body: [], span };

    default:
      fail(node, `暂不支持的语句：${node.type}`);
  }
}

/**
 * for 的第一段是初始化还是条件？
 *
 * `for (i = 0; ...)` 的第一段是 assignment_expression，是初始化；
 * `for (; i < n; ...)` 的第一段直接就是条件。用「是不是带副作用的语句」区分。
 */
function isStatementLike(node: TsNode): boolean {
  return node.type === 'assignment_expression' || node.type === 'update_expression';
}

/* ------------------------------------------------------------------ */
/* 顶层                                                                */
/* ------------------------------------------------------------------ */

function lowerParam(node: TsNode): Param {
  const children = namedChildren(node);
  const base = findTypeSpecifier(children, node);
  const declarator = children.find(
    (child) =>
      child.type === 'identifier' ||
      child.type === 'pointer_declarator' ||
      child.type === 'array_declarator'
  );
  if (!declarator) fail(node, '参数缺少名字');
  const declared = lowerDeclarator(declarator, base);
  return { name: declared.name, type: declared.type, span: spanOf(node) };
}

function lowerFunction(node: TsNode): KernelDecl | null {
  const kinds = allChildren(node).map((child) => child.text.trim());
  const isGlobal = kinds.includes('__global__');
  const isDevice = kinds.includes('__device__');

  if (!isGlobal) {
    if (isDevice) {
      fail(node, '暂不支持自己写的 __device__ 函数 —— 先把逻辑内联进 kernel');
    }
    fail(node, '这一版只支持 __global__ kernel，还不支持宿主函数');
  }

  const declarator = namedChildren(node).find((child) => child.type === 'function_declarator');
  if (!declarator) fail(node, '看不出这个 kernel 的名字与参数');

  const nameNode = namedChildren(declarator).find((child) => child.type === 'identifier');
  if (!nameNode) fail(declarator, 'kernel 缺少名字');

  const paramList = namedChildren(declarator).find((child) => child.type === 'parameter_list');
  const params = paramList
    ? namedChildren(paramList)
        .filter((child) => child.type === 'parameter_declaration')
        .map(lowerParam)
    : [];

  const body = namedChildren(node).find((child) => child.type === 'compound_statement');
  if (!body) fail(node, 'kernel 缺少函数体');

  const returnType = findTypeSpecifier(namedChildren(node), node);
  if (!(returnType.kind === 'scalar' && returnType.scalar === 'void')) {
    fail(node, 'kernel 的返回类型必须是 void');
  }

  return { name: nameNode.text, params, body: lowerStmt(body), span: spanOf(node) };
}

export function lowerTranslationUnit(root: TsNode): TranslationUnit {
  const kernels: KernelDecl[] = [];

  for (const child of namedChildren(root)) {
    switch (child.type) {
      case 'function_definition': {
        const kernel = lowerFunction(child);
        if (kernel) kernels.push(kernel);
        break;
      }
      case 'comment':
      case 'preproc_include':
        break;
      case 'preproc_def':
      case 'preproc_function_def':
        fail(child, '暂不支持 #define —— 用 const 变量代替');
        break;
      case 'declaration':
        fail(child, '暂不支持全局变量');
        break;
      default:
        fail(child, `暂不支持的顶层写法：${child.type}`);
    }
  }

  if (!kernels.length) {
    throw new CudaCompileError('这份源码里没有 __global__ kernel', { line: 1, column: 1 });
  }
  return { kernels };
}
