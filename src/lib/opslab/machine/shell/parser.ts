/**
 * shell 语法解析
 *
 * 用 tree-sitter 的 bash 语法，而不是自己写一个 —— 真实的 shell 语法边角极多
 * （引号、展开、重定向的各种形态），自己写迟早在某个学员敲出来的合法命令上翻车。
 *
 * 设计文档里原本写的是用 `sh-syntax`（mvdan/sh 编译的 WASM）。**那条路走不通**：
 * 它是给 shfmt 做格式化用的，跨 WASM 边界之后 AST 里的 `Cmd` 只剩位置信息，
 * 具体节点类型和参数全丢了 —— 能重新打印，不能解释执行。
 * tree-sitter 给的是完整的具体语法树，节点有名有姓，正是执行器要的。
 *
 * 这一层把 tree-sitter 的树翻译成我们自己的小 AST，好让执行器不必到处
 * 认 tree-sitter 的节点名。翻不动的语法**明确报错**，绝不悄悄降级成
 * 「看起来跑了但语义不对」—— 那种失败最难查。
 */

export type Redirect =
  /** `< file` */
  | { kind: 'in'; source: string }
  /** `> file` / `>> file` / `2> file`，fd 1 是 stdout、2 是 stderr */
  | { kind: 'out'; target: string; append: boolean; fd: number }
  /** `2>&1` */
  | { kind: 'dup'; from: number; to: number }
  /** heredoc。delimiter 带引号时内容不做展开。 */
  | { kind: 'heredoc'; content: string; expand: boolean };

export interface SimpleCommand {
  type: 'command';
  /** 命令名与参数，尚未展开 */
  words: Word[];
  /** `FOO=bar cmd` 里的前置赋值 */
  assignments: Array<{ name: string; value: Word }>;
}

export interface Pipeline {
  type: 'pipeline';
  commands: Node[];
  /** `! cmd` */
  negated: boolean;
}

export interface ListNode {
  type: 'list';
  left: Node;
  operator: '&&' | '||';
  right: Node;
}

export interface Subshell {
  type: 'subshell';
  body: Node;
}

export interface RedirectedNode {
  type: 'redirected';
  body: Node;
  redirects: Redirect[];
}

export interface IfNode {
  type: 'if';
  condition: Node;
  then: Node;
  else?: Node;
}

export interface ForNode {
  type: 'for';
  variable: string;
  items: Word[];
  body: Node;
}

export interface WhileNode {
  type: 'while';
  condition: Node;
  body: Node;
  until: boolean;
}

export interface CaseNode {
  type: 'case';
  value: Word;
  items: Array<{ patterns: Word[]; body: Node | null }>;
}

export interface FunctionNode {
  type: 'function';
  name: string;
  body: Node;
}

export interface SequenceNode {
  type: 'sequence';
  statements: Node[];
}

export interface AssignmentNode {
  type: 'assignment';
  name: string;
  value: Word;
  /** `export FOO=bar` */
  exported: boolean;
  /** `local x=1` —— 只在当前函数帧里可见 */
  local?: boolean;
}

export type Node =
  | SimpleCommand | Pipeline | ListNode | Subshell | RedirectedNode
  | IfNode | ForNode | WhileNode | CaseNode | FunctionNode
  | SequenceNode | AssignmentNode;

/** 一个「词」由若干片段组成：字面量、变量、命令替换…… 展开时逐段处理 */
export type WordPart =
  | { kind: 'literal'; text: string }
  | {
      kind: 'variable';
      name: string;
      /** `${x:-default}` 之类 */
      modifier?: string;
      argument?: string;
      /** `${#x}` 取长度 */
      length?: boolean;
    }
  | { kind: 'command'; source: string }
  | { kind: 'arithmetic'; source: string };

export interface Word {
  parts: WordPart[];
  /** 单引号里的内容不做任何展开，也不参与分词 */
  quoted: 'none' | 'single' | 'double';
}

export class ShellSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellSyntaxError';
  }
}

/* ------------------------------------------------------------------ */

interface TsNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  namedChildren: TsNode[];
  children: TsNode[];
  childForFieldName(name: string): TsNode | null;
  childrenForFieldName?(name: string): TsNode[];
  hasError: boolean;
  isNamed: boolean;
}

interface TsParser {
  parse(source: string): { rootNode: TsNode };
}

let parserPromise: Promise<TsParser> | null = null;

export interface ShellParserOptions {
  /** web-tree-sitter 运行时 wasm 的地址 */
  runtimeWasmUrl?: string;
  /** bash 语法：给地址或者直接给字节 */
  grammar?: string | Uint8Array;
}

/** tree-sitter 的运行时与语法都是 WASM，加载一次复用 */
export async function loadShellParser(options: ShellParserOptions = {}): Promise<TsParser> {
  if (parserPromise) return parserPromise;
  parserPromise = (async () => {
    const treeSitter: any = await import('web-tree-sitter');
    const Parser = treeSitter.Parser ?? treeSitter.default?.Parser;
    const Language = treeSitter.Language ?? treeSitter.default?.Language;

    const runtimeUrl = options.runtimeWasmUrl ?? (isBrowser() ? '/opslab/web-tree-sitter.wasm' : undefined);
    await Parser.init(runtimeUrl ? { locateFile: () => runtimeUrl } : undefined);

    const grammar = options.grammar ?? defaultGrammarPath();
    // 自己把字节读出来再交给 Language.load。它自带的按路径加载会走动态
    // import()，在 jest 的 CJS 环境里直接抛 —— 而且浏览器里那条路也走不通。
    const language = await Language.load(
      typeof grammar === 'string' ? await readWasm(grammar) : grammar
    );
    const parser = new Parser();
    parser.setLanguage(language);
    return parser as TsParser;
  })();
  return parserPromise;
}

/** 测试之间要能换 wasm 路径重来 */
export function resetShellParser(): void {
  parserPromise = null;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * 语法文件在哪。
 *
 * 浏览器里由构建脚本拷到 /opslab/tree-sitter-bash.wasm；
 * Node（测试、出题脚本）里直接从 node_modules 取。
 */
function defaultGrammarPath(): string {
  return isBrowser()
    ? '/opslab/tree-sitter-bash.wasm'
    : 'node_modules/tree-sitter-bash/tree-sitter-bash.wasm';
}

async function readWasm(location: string): Promise<Uint8Array> {
  if (isBrowser()) {
    const response = await fetch(location);
    if (!response.ok) throw new Error(`failed to fetch ${location}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  // Node 专用分支。用 eval 拿 require，免得打包器把 fs 打进浏览器包。
  const nodeRequire = eval('require') as (id: string) => any;
  return new Uint8Array(nodeRequire('fs').readFileSync(location));
}

const literal = (text: string): Word => ({ parts: [{ kind: 'literal', text }], quoted: 'none' });

/** 把 tree-sitter 的一个词节点翻成我们的 Word */
function toWord(node: TsNode): Word {
  switch (node.type) {
    case 'word':
      return literal(unescapeWord(node.text));

    case 'number':
    case 'test_operator':
    case 'extglob_pattern':
    case 'regex':
      return literal(node.text);

    case 'raw_string':
      // 单引号：里面什么都不展开
      return { parts: [{ kind: 'literal', text: node.text.slice(1, -1) }], quoted: 'single' };

    case 'ansi_c_string':
      return { parts: [{ kind: 'literal', text: unescapeAnsiC(node.text.slice(2, -1)) }], quoted: 'single' };

    case 'string': {
      // 双引号：变量与命令替换要展开，但不分词。
      //
      // 不能只遍历子节点 —— tree-sitter 不会为纯空白生成 string_content，
      // `" "` 的那个空格会凭空消失（`cut -d " "` 就此变成按空字符切）。
      // 所以按位置把子节点之间的缝隙补回来。
      const parts: WordPart[] = [];
      const text = node.text;
      const base = node.startIndex;
      let cursor = 1;
      for (const child of node.namedChildren) {
        const start = child.startIndex - base;
        if (start > cursor) parts.push({ kind: 'literal', text: unescapeQuoted(text.slice(cursor, start)) });
        parts.push(...toWord(child).parts);
        cursor = child.endIndex - base;
      }
      if (cursor < text.length - 1) {
        parts.push({ kind: 'literal', text: unescapeQuoted(text.slice(cursor, text.length - 1)) });
      }
      return { parts, quoted: 'double' };
    }

    case 'string_content':
      return literal(unescapeQuoted(node.text));

    case 'simple_expansion':
      // $FOO / $1 / $?
      return { parts: [{ kind: 'variable', name: node.text.slice(1) }], quoted: 'none' };

    case 'expansion':
      return { parts: [parseExpansion(node.text)], quoted: 'none' };

    case 'command_substitution': {
      const source = node.text.startsWith('`')
        ? node.text.slice(1, -1)
        : node.text.replace(/^\$\(/, '').replace(/\)$/, '');
      return { parts: [{ kind: 'command', source }], quoted: 'none' };
    }

    case 'arithmetic_expansion':
      return {
        parts: [{ kind: 'arithmetic', source: node.text.replace(/^\$\(\(/, '').replace(/\)\)$/, '') }],
        quoted: 'none',
      };

    case 'concatenation': {
      const parts: WordPart[] = [];
      for (const child of node.namedChildren) parts.push(...toWord(child).parts);
      return { parts, quoted: 'none' };
    }

    default:
      return literal(node.text);
  }
}

/** `${x}`、`${x:-d}`、`${#x}`、`${x#prefix}` … */
function parseExpansion(text: string): WordPart {
  const inner = text.slice(2, -1);
  if (inner.startsWith('#') && inner.length > 1) {
    return { kind: 'variable', name: inner.slice(1), length: true };
  }
  const match = /^([A-Za-z_][A-Za-z0-9_]*|[?@*#!$0-9]+)(:?[-=?+]|##?|%%?)?([\s\S]*)$/.exec(inner);
  if (!match) return { kind: 'literal', text };
  return {
    kind: 'variable',
    name: match[1],
    modifier: match[2] || undefined,
    argument: match[3] || undefined,
  };
}

/** 裸词里的 `\ ` `\$` `\*` 等转义，展开前就该还原成字面量 */
function unescapeWord(text: string): string {
  return text.replace(/\\([\s\S])/g, '$1');
}

/** 双引号里只有这几个字符会被反斜杠转义，其余反斜杠是字面量 */
function unescapeQuoted(text: string): string {
  return text.replace(/\\(["\\$`])/g, '$1');
}

function unescapeAnsiC(text: string): string {
  return text.replace(/\\(n|t|r|\\|')/g, (_, char) =>
    char === 'n' ? '\n' : char === 't' ? '\t' : char === 'r' ? '\r' : char
  );
}

/* ------------------------------------------------------------------ */

function collectRedirects(node: TsNode): Redirect[] {
  const redirects: Redirect[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'file_redirect') {
      const descriptor = child.childForFieldName('descriptor');
      const destination = child.childForFieldName('destination');
      const operator = child.children.find((c) => !c.isNamed)?.text ?? '>';
      const target = destination?.text ?? '';

      if (operator.includes('<') && !operator.includes('&')) {
        redirects.push({ kind: 'in', source: target });
      } else if (operator.includes('&')) {
        // `2>&1` —— 把一个 fd 接到另一个 fd 上
        redirects.push({ kind: 'dup', from: Number(descriptor?.text ?? 1), to: Number(target) });
      } else {
        redirects.push({
          kind: 'out',
          target,
          append: operator.includes('>>'),
          fd: Number(descriptor?.text ?? 1),
        });
      }
    } else if (child.type === 'heredoc_redirect') {
      const start = child.namedChildren.find((c) => c.type === 'heredoc_start');
      const body = child.namedChildren.find((c) => c.type === 'heredoc_body');
      const stripTabs = child.children.some((c) => c.text === '<<-');
      const delimiter = start?.text ?? '';
      const content = body?.text ?? '';
      redirects.push({
        kind: 'heredoc',
        content: stripTabs ? content.replace(/^\t+/gm, '') : content,
        // 带引号的 delimiter 里 $VAR 保持原样，这是写 manifest 时常用的一手
        expand: !/^['"]/.test(delimiter),
      });
    }
  }
  return redirects;
}

/** 把重定向挂到该挂的地方：单命令直接包一层，管道分别挂在首尾两段 */
function attachRedirects(body: Node, redirects: Redirect[]): Node {
  if (redirects.length === 0) return body;
  if (body.type === 'pipeline' && body.commands.length > 0) {
    const commands = [...body.commands];
    const inbound = redirects.filter((r) => r.kind === 'in' || r.kind === 'heredoc');
    const outbound = redirects.filter((r) => r.kind === 'out' || r.kind === 'dup');
    if (outbound.length) {
      const last = commands.length - 1;
      commands[last] = { type: 'redirected', body: commands[last], redirects: outbound };
    }
    if (inbound.length) {
      commands[0] = { type: 'redirected', body: commands[0], redirects: inbound };
    }
    return { ...body, commands };
  }
  return { type: 'redirected', body, redirects };
}

function sequence(statements: Node[]): Node | null {
  if (statements.length === 0) return null;
  return statements.length === 1 ? statements[0] : { type: 'sequence', statements };
}

function convertAll(nodes: TsNode[]): Node[] {
  return nodes.map(convert).filter((n): n is Node => n !== null);
}

function convert(node: TsNode): Node | null {
  switch (node.type) {
    case 'program':
    case 'compound_statement':
    case 'do_group':
      return sequence(convertAll(node.namedChildren));

    case 'command': {
      const words: Word[] = [];
      const assignments: SimpleCommand['assignments'] = [];
      const nameNode = node.childForFieldName('name');
      if (nameNode) words.push(toWord(nameNode.namedChildren[0] ?? nameNode));

      for (const child of node.namedChildren) {
        if (child.type === 'command_name') continue;
        if (child.type === 'variable_assignment') {
          assignments.push({
            name: child.childForFieldName('name')?.text ?? '',
            value: valueWord(child),
          });
          continue;
        }
        words.push(toWord(child));
      }
      return { type: 'command', words, assignments };
    }

    case 'variable_assignment':
      return {
        type: 'assignment',
        name: node.childForFieldName('name')?.text ?? '',
        value: valueWord(node),
        exported: false,
      };

    /** `export FOO=bar` / `local x=1` / `readonly y` */
    case 'declaration_command': {
      const keyword = node.children.find((c) => !c.isNamed)?.text ?? 'export';
      const statements: Node[] = [];
      for (const child of node.namedChildren) {
        if (child.type === 'variable_assignment') {
          statements.push({
            type: 'assignment',
            name: child.childForFieldName('name')?.text ?? '',
            value: valueWord(child),
            exported: keyword === 'export',
            local: keyword === 'local',
          });
        } else if (keyword === 'export') {
          // `export FOO` —— 把已有的 shell 变量提到环境里
          statements.push({ type: 'command', words: [literal('export'), toWord(child)], assignments: [] });
        }
      }
      return sequence(statements);
    }

    case 'pipeline':
      return { type: 'pipeline', commands: convertAll(node.namedChildren), negated: false };

    case 'negated_command': {
      const inner = convert(node.namedChildren[0]);
      if (!inner) return null;
      return inner.type === 'pipeline'
        ? { ...inner, negated: true }
        : { type: 'pipeline', commands: [inner], negated: true };
    }

    case 'list': {
      const left = convert(node.namedChildren[0]);
      const right = convert(node.namedChildren[1]);
      const operator = (node.children.find((c) => c.text === '&&' || c.text === '||')?.text ?? '&&') as '&&' | '||';
      if (!left) return right;
      if (!right) return left;
      return { type: 'list', left, operator, right };
    }

    case 'subshell': {
      const body = sequence(convertAll(node.namedChildren));
      return body ? { type: 'subshell', body } : null;
    }

    case 'redirected_statement': {
      const body = convert(node.childForFieldName('body') ?? node.namedChildren[0]);
      if (!body) return null;
      return attachRedirects(body, collectRedirects(node));
    }

    /**
     * `[ -f x ]` / `[[ $a = b ]]`
     *
     * tree-sitter 把它解析成表达式而不是普通命令，得翻回参数列表 ——
     * 否则 `if [ -f x ]` 的条件会整个丢掉，if 分支静默不执行。
     */
    case 'test_command': {
      const words: Word[] = [literal('test')];
      const inner = node.namedChildren[0];
      if (inner) words.push(...testOperands(inner));
      return { type: 'command', words, assignments: [] };
    }

    case 'if_statement': {
      const condition = convert(node.childForFieldName('condition') ?? node.namedChildren[0]);
      if (!condition) return null;
      const body = node.namedChildren.filter(
        (c) => c.type !== 'elif_clause' && c.type !== 'else_clause'
      );
      const then = sequence(convertAll(body.slice(1)));
      return {
        type: 'if',
        condition,
        then: then ?? { type: 'sequence', statements: [] },
        else: convertElse(
          node.namedChildren.filter((c) => c.type === 'elif_clause' || c.type === 'else_clause')
        ),
      };
    }

    case 'for_statement': {
      const values = node.childrenForFieldName
        ? node.childrenForFieldName('value')
        : node.namedChildren.filter((c) => c.type !== 'variable_name' && c.type !== 'do_group');
      const bodyNode = node.namedChildren.find((c) => c.type === 'do_group');
      const body = bodyNode ? convert(bodyNode) : null;
      if (!body) return null;
      return {
        type: 'for',
        variable: node.childForFieldName('variable')?.text ?? 'i',
        items: values.map(toWord),
        body,
      };
    }

    case 'while_statement': {
      const condition = convert(node.childForFieldName('condition') ?? node.namedChildren[0]);
      const bodyNode = node.namedChildren.find((c) => c.type === 'do_group');
      const body = bodyNode ? convert(bodyNode) : null;
      if (!condition || !body) return null;
      return { type: 'while', condition, body, until: node.text.startsWith('until') };
    }

    case 'case_statement': {
      const value = node.childForFieldName('value');
      const items = node.namedChildren
        .filter((c) => c.type === 'case_item')
        .map((item) => {
          const patterns = item.childrenForFieldName
            ? item.childrenForFieldName('value')
            : item.namedChildren.filter((c) => c.type === 'word' || c.type === 'extglob_pattern');
          const patternSet = new Set(patterns);
          return {
            patterns: patterns.map(toWord),
            body: sequence(convertAll(item.namedChildren.filter((c) => !patternSet.has(c)))),
          };
        });
      return { type: 'case', value: value ? toWord(value) : literal(''), items };
    }

    case 'function_definition': {
      const body = convert(node.childForFieldName('body') ?? node.namedChildren[1]);
      if (!body) return null;
      return { type: 'function', name: node.childForFieldName('name')?.text ?? '', body };
    }

    case 'comment':
      return null;

    // 真跑不了的语法，明确说清楚，别装作能跑
    case 'c_style_for_statement':
      throw new ShellSyntaxError('`for ((...))` is not supported by the opslab shell');

    default:
      return sequence(convertAll(node.namedChildren));
  }
}

/** `x=$(cmd)` 里那个值 */
function valueWord(assignment: TsNode): Word {
  const value = assignment.childForFieldName('value');
  return value ? toWord(value) : literal('');
}

/** 把 test 的表达式节点摊平成参数（`-f`、`x`、`=`…） */
function testOperands(node: TsNode): Word[] {
  if (node.type !== 'unary_expression' && node.type !== 'binary_expression') return [toWord(node)];
  const words: Word[] = [];
  for (const child of node.children) {
    if (child.type === '[' || child.type === ']' || child.type === '[[' || child.type === ']]') continue;
    if (child.isNamed) words.push(...testOperands(child));
    else if (child.text.trim()) words.push(literal(child.text));
  }
  return words;
}

/** elif 链就是嵌套的 else-if */
function convertElse(clauses: TsNode[]): Node | undefined {
  if (clauses.length === 0) return undefined;
  const [head, ...rest] = clauses;
  if (head.type === 'else_clause') return sequence(convertAll(head.namedChildren)) ?? undefined;

  const condition = convert(head.childForFieldName('condition') ?? head.namedChildren[0]);
  if (!condition) return undefined;
  const then = sequence(convertAll(head.namedChildren.slice(1)));
  return {
    type: 'if',
    condition,
    then: then ?? { type: 'sequence', statements: [] },
    else: convertElse(rest),
  };
}

export async function parseShell(source: string): Promise<Node | null> {
  const parser = await loadShellParser();
  const tree = parser.parse(source);
  if (tree.rootNode.hasError) {
    throw new ShellSyntaxError('syntax error near unexpected token');
  }
  return convert(tree.rootNode);
}
