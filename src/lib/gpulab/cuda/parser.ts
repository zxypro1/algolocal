/**
 * CUDA 语法解析
 *
 * 用 tree-sitter 的 CUDA 语法（tree-sitter-cuda，MIT，包里自带预编译 wasm），
 * 而不是自己写一个 C 解析器 —— C 的声明语法边角极多（`float *(*f)(int)` 那类），
 * 手写出来的东西会在学员写出合法代码时莫名其妙地挂。
 *
 * 加载方式和 labkit 的 shell 解析器完全一样：运行时与语法都是 WASM，
 * 浏览器里由 scripts/copy-lab-assets.js 拷到 /gpulab/tree-sitter-cuda.wasm。
 *
 * 这一层只负责「拿到具体语法树」。翻成我们自己的 AST 是 lower.ts 的事，
 * 翻不动的语法在那里**明确报错**，绝不悄悄降级成能跑但不对的东西。
 */
import { createTreeSitterParser } from '../../labkit/treesitter';

interface TsNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  childCount: number;
  namedChildCount: number;
  isMissing: boolean;
  hasError: boolean;
  child(index: number): TsNode | null;
  namedChild(index: number): TsNode | null;
  childForFieldName(name: string): TsNode | null;
}

interface TsTree {
  rootNode: TsNode;
}

interface TsParser {
  parse(source: string): TsTree;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

export type { TsNode, TsTree };

let parserPromise: Promise<TsParser> | null = null;

export interface CudaParserOptions {
  /** web-tree-sitter 运行时 wasm 的地址 */
  runtimeWasmUrl?: string;
  /** CUDA 语法：给地址或者直接给字节 */
  grammar?: string | Uint8Array;
}

/**
 * 语法 wasm 在哪。
 *
 * 浏览器里由构建脚本拷到 /gpulab/tree-sitter-cuda.wasm；
 * Node（测试、出题脚本）里直接从 node_modules 取。
 */
function defaultGrammarPath(): string {
  return isBrowser()
    ? '/gpulab/tree-sitter-cuda.wasm'
    : 'node_modules/tree-sitter-cuda/tree-sitter-cuda.wasm';
}

/** tree-sitter 的运行时与语法都是 WASM，加载一次复用 */
export async function loadCudaParser(options: CudaParserOptions = {}): Promise<TsParser> {
  if (parserPromise) return parserPromise;
  parserPromise = createTreeSitterParser<TsParser>({
    runtimeWasmUrl: options.runtimeWasmUrl,
    grammar: options.grammar ?? defaultGrammarPath(),
  });
  return parserPromise;
}

/** 测试之间要能换 wasm 路径重来 */
export function resetCudaParser(): void {
  parserPromise = null;
}

export class CudaSyntaxError extends Error {
  /** 1 起算，和编译器报错的习惯一致 */
  line: number;
  column: number;
  constructor(message: string, line: number, column: number) {
    super(`${line}:${column}: ${message}`);
    this.name = 'CudaSyntaxError';
    this.line = line;
    this.column = column;
  }
}

/**
 * 找出树里第一个语法错误。
 *
 * tree-sitter 是容错解析器：写错了它照样给一棵树，只是里面有 ERROR 与 MISSING
 * 节点。不主动查的话，一个少写分号的 kernel 会被我们当成合法程序编出来，
 * 然后在完全无关的地方给出一个看不懂的错。
 */
export function firstSyntaxError(root: TsNode): CudaSyntaxError | null {
  const stack: TsNode[] = [root];
  let best: TsNode | null = null;

  while (stack.length) {
    const node = stack.pop()!;
    if (!node.hasError && !node.isMissing) continue;

    if (node.type === 'ERROR' || node.isMissing) {
      // 取位置最靠前的那个，报错才指向真正出问题的地方
      if (!best || node.startIndex < best.startIndex) best = node;
    }
    for (let i = node.childCount - 1; i >= 0; i -= 1) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }

  if (!best) return null;
  const what = best.isMissing ? `缺少 ${best.type}` : `无法解析：${truncate(best.text)}`;
  return new CudaSyntaxError(what, best.startPosition.row + 1, best.startPosition.column + 1);
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
}

/** 解析一段 CUDA 源码；有语法错误就抛 */
export async function parseCuda(source: string, options?: CudaParserOptions): Promise<TsNode> {
  const parser = await loadCudaParser(options);
  const tree = parser.parse(source);
  const error = firstSyntaxError(tree.rootNode);
  if (error) throw error;
  return tree.rootNode;
}
