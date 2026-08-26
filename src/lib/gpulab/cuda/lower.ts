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
  BOOL, FLOAT, HALF, INT, UINT, VOID,
  type BinaryOp, type BuiltinVar, type CudaType, type Expr,
  type FuncDecl, type FunctionRole, type KernelDecl,
  type FragmentType, type Param, type SourceSpan, type Stmt, type TranslationUnit,
  type UnaryOp, type VarDecl,
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
      if (text === 'half' || text === '__half') return HALF;
      fail(node, `暂不支持自定义类型 \`${text}\` —— 当前子集只有 int / unsigned / float / half / bool`);
      break;
    default:
      fail(node, `暂不支持的类型写法：${node.type}`);
  }
}

/**
 * `wmma::fragment<use, M, N, K, T[, layout]>` 翻成我们的 FragmentType。
 *
 * 这是**唯一**放开的 C++ 语法。理由是「接口真实」：wmma 在 CUDA 里本来
 * 就是带模板的 C++，造一套 C 风格的假 API 等于教一个真卡上不存在的东西。
 * 放开的范围严格限定在 wmma 这几个名字上，别的 C++ 照样报错。
 */
function lowerFragmentType(node: TsNode): FragmentType | null {
  if (node.type !== 'qualified_identifier') return null;
  const children = namedChildren(node);
  if (children[0]?.text !== 'wmma') return null;
  const template = children[1];
  if (!template || template.type !== 'template_type') return null;
  if (namedChildren(template)[0]?.text !== 'fragment') {
    fail(template, `wmma 里只支持 fragment，不支持 ${namedChildren(template)[0]?.text}`);
  }

  const args = namedChildren(namedChildren(template)[1] ?? template)
    .filter((child) => child.type !== ',');
  const text = (child: TsNode | undefined) => child?.text.replace('wmma::', '').trim() ?? '';

  const use = text(args[0]);
  if (use !== 'matrix_a' && use !== 'matrix_b' && use !== 'accumulator') {
    fail(args[0] ?? node, `fragment 的第一个模板参数要是 matrix_a / matrix_b / accumulator，给的是 ${use}`);
  }
  const dims = [args[1], args[2], args[3]].map((child) => {
    if (!child || child.type !== 'number_literal') fail(child ?? node, 'fragment 的 M/N/K 要是数字');
    return constIntOf(child);
  });
  if (dims[0] !== 16 || dims[1] !== 16 || dims[2] !== 16) {
    fail(node, `目前只支持 16×16×16 的 fragment，给的是 ${dims.join('×')}`);
  }

  const element = text(args[4]);
  if (use === 'accumulator') {
    if (element !== 'float') fail(args[4] ?? node, 'accumulator 的元素类型必须是 float');
  } else if (element !== 'half') {
    fail(args[4] ?? node, `matrix_a / matrix_b 的元素类型必须是 half，给的是 ${element}`);
  }

  const layout = args[5] ? text(args[5]) : undefined;
  if (layout && layout !== 'row_major' && layout !== 'col_major') {
    fail(args[5], `layout 要是 row_major 或 col_major，给的是 ${layout}`);
  }
  if (use !== 'accumulator' && !layout) {
    fail(node, 'matrix_a / matrix_b 的 fragment 必须写明 row_major 或 col_major');
  }

  return {
    kind: 'fragment',
    use: use as FragmentType['use'],
    m: dims[0], n: dims[1], k: dims[2],
    element: element as 'half' | 'float',
    layout: layout as FragmentType['layout'],
  };
}

/** 从一串子节点里挑出类型说明符 */
function findTypeSpecifier(children: TsNode[], at: TsNode): CudaType {
  for (const child of children) {
    if (child.type === 'type_qualifier' || child.type === 'storage_class_specifier') continue;
    if (child.type === '__shared__' || child.type === '__device__' || child.type === '__global__') continue;
    if (child.type === 'qualified_identifier') {
      const fragment = lowerFragmentType(child);
      if (fragment) return fragment;
      fail(child, `暂不支持带命名空间的类型 \`${child.text}\` —— 只放开了 wmma::fragment`);
    }
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
    case 'string_literal': {
      // tree-sitter 把内容放在 string_content 里，转义序列是独立节点
      let text = '';
      for (const child of allChildren(node)) {
        if (child.type === 'string_content') text += child.text;
        else if (child.type === 'escape_sequence') text += unescapeC(child.text, node);
      }
      return { kind: 'strLit', value: text, span };
    }

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

    case 'qualified_identifier': {
      // `wmma::mem_row_major` 这类枚举名：当成一个名字，由编译器识别
      const parts = namedChildren(node);
      if (parts[0]?.text === 'wmma') {
        return { kind: 'name', name: `wmma::${parts[1]?.text ?? ''}`, span };
      }
      fail(node, `暂不支持带命名空间的名字 \`${node.text}\``);
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
      if (op === '&') return { kind: 'addressOf', target: lowerExpr(children[0]), span };
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
      if (callee.type === 'qualified_identifier') {
        const parts = namedChildren(callee);
        if (parts[0]?.text !== 'wmma') {
          fail(callee, `暂不支持带命名空间的调用 \`${callee.text}\` —— 只放开了 wmma::`);
        }
        const argList = children[1];
        const args = argList && argList.type === 'argument_list' ? namedChildren(argList) : [];
        return {
          kind: 'call',
          callee: `wmma::${parts[1]?.text ?? ''}`,
          args: args.map(lowerExpr),
          span,
        };
      }
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
      child.type === 'storage_class_specifier' ||
      // 类型说明符本身：`wmma::fragment<...>` 与 `half`，
      // findTypeSpecifier 已经读过了，这里别再当成声明符
      child.type === 'qualified_identifier' ||
      child.type === 'type_identifier'
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

/**
 * `kernel<<<grid, block>>>(args)`
 *
 * 真 CUDA 的 `<<<>>>` 还能带第三、四个参数（动态共享内存字节数、流）。
 * 这个子集只收前两个，多写的**明确报错**而不是悄悄忽略 ——
 * 被忽略的动态共享内存会让 kernel 读到一片根本没分配的内存。
 */
/** printf 的格式串里能出现的转义 */
function unescapeC(text: string, node: TsNode): string {
  switch (text) {
    case '\\n': return '\n';
    case '\\t': return '\t';
    case '\\r': return '\r';
    case '\\\\': return '\\';
    case '\\"': return '"';
    case "\\'": return "'";
    case '\\0': return '\0';
    default: fail(node, `暂不支持的转义 \`${text}\``);
  }
}

function lowerLaunch(node: TsNode, syntax: TsNode, span: SourceSpan): Stmt {
  const children = namedChildren(node);
  const callee = children[0];
  if (callee?.type !== 'identifier') fail(node, '起 kernel 时 <<< 前面要写 kernel 的名字');

  const config = namedChildren(syntax);
  if (config.length < 2) fail(syntax, '<<<>>> 里至少要写 grid 与 block 两个参数');
  if (config.length > 2) {
    fail(syntax, '<<<>>> 的第三、四个参数（动态共享内存、流）暂不支持 —— '
      + '共享内存请用 __shared__ 静态声明');
  }

  const argList = children.find((child) => child.type === 'argument_list');
  const args = argList ? namedChildren(argList).map(lowerExpr) : [];

  return {
    kind: 'launch',
    kernel: callee.text,
    grid: lowerDim(config[0]),
    block: lowerDim(config[1]),
    args,
    span,
  };
}

/** grid / block 可以写成一个整数，也可以写成 `dim3(x, y, z)` */
function lowerDim(node: TsNode): Expr[] {
  if (node.type === 'call_expression') {
    const parts = namedChildren(node);
    if (parts[0]?.type === 'identifier' && parts[0].text === 'dim3') {
      const argList = parts.find((child) => child.type === 'argument_list');
      const args = argList ? namedChildren(argList) : [];
      if (!args.length || args.length > 3) fail(node, 'dim3 要写 1 到 3 个分量');
      return args.map(lowerExpr);
    }
  }
  return [lowerExpr(node)];
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
        // `kernel<<<grid, block>>>(args)`：语法上还是 call_expression，
        // 只是中间多了一个 kernel_call_syntax 节点。它是语句不是表达式 ——
        // 起 kernel 没有返回值。
        const launchSyntax = namedChildren(inner).find(
          (child) => child.type === 'kernel_call_syntax'
        );
        if (launchSyntax) return lowerLaunch(inner, launchSyntax, span);
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

    case 'break_statement':
      return { kind: 'break', span };

    case 'continue_statement':
      return { kind: 'continue', span };

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

function lowerFunction(node: TsNode): FuncDecl {
  const kinds = allChildren(node).map((child) => child.text.trim());
  const role: FunctionRole = kinds.includes('__global__')
    ? 'kernel'
    : kinds.includes('__device__')
      ? 'device'
      : 'host';

  const declarator = namedChildren(node).find((child) => child.type === 'function_declarator');
  if (!declarator) fail(node, '看不出这个函数的名字与参数');

  const nameNode = namedChildren(declarator).find((child) => child.type === 'identifier');
  if (!nameNode) fail(declarator, '函数缺少名字');

  const paramList = namedChildren(declarator).find((child) => child.type === 'parameter_list');
  const params = paramList
    ? namedChildren(paramList)
        .filter((child) => child.type === 'parameter_declaration')
        // `int main(void)` 里的 void 不是参数
        .filter((child) => child.text.trim() !== 'void')
        .map(lowerParam)
    : [];

  const body = namedChildren(node).find((child) => child.type === 'compound_statement');
  if (!body) fail(node, '函数缺少函数体');

  const returnType = findTypeSpecifier(namedChildren(node), node);
  if (role === 'kernel' && !(returnType.kind === 'scalar' && returnType.scalar === 'void')) {
    fail(node, 'kernel 的返回类型必须是 void');
  }
  if (returnType.kind === 'array') fail(node, '函数不能返回数组');

  return {
    name: nameNode.text,
    role,
    params,
    returnType,
    body: lowerStmt(body),
    span: spanOf(node),
  };
}

/**
 * 顶层的 `declaration` 有两种：函数原型与全局变量。
 * 原型是合法的（`containers.h` 里全是原型），全局变量还不支持。
 */
function isPrototype(node: TsNode): boolean {
  return namedChildren(node).some((child) => child.type === 'function_declarator');
}

export function lowerTranslationUnit(root: TsNode): TranslationUnit {
  const kernels: KernelDecl[] = [];
  const functions = new Map<string, FuncDecl>();
  let main: FuncDecl | null = null;

  for (const child of namedChildren(root)) {
    switch (child.type) {
      case 'function_definition': {
        const fn = lowerFunction(child);
        if (functions.has(fn.name) || kernels.some((k) => k.name === fn.name)) {
          fail(child, `\`${fn.name}\` 定义了两次`);
        }
        if (fn.role === 'kernel') {
          kernels.push({ name: fn.name, params: fn.params, body: fn.body, span: fn.span });
          break;
        }
        functions.set(fn.name, fn);
        if (fn.name === 'main') {
          if (fn.role !== 'host') fail(child, 'main 不能带 __device__');
          main = fn;
        }
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
        if (isPrototype(child)) break;
        fail(child, '暂不支持全局变量');
        break;
      default:
        fail(child, `暂不支持的顶层写法：${child.type}`);
    }
  }

  if (!kernels.length && !main) {
    throw new CudaCompileError(
      '这份源码里既没有 __global__ kernel，也没有 int main()',
      { line: 1, column: 1 }
    );
  }
  return { kernels, functions, main };
}
