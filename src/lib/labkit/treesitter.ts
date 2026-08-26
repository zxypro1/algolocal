/**
 * tree-sitter 的加载
 *
 * 两个实验台都要用：opslab 的 shell 用 bash 语法，gpulab 的 nvcc 用 CUDA 语法。
 * 抽出来的原因不是「看起来该抽」，而是这里面有一处**必须记住的坑**，
 * 抄两份的话早晚有一份会退化：
 *
 * **不能把路径交给 `Language.load`。** 它内部按路径加载时会走动态 `import()`，
 * 在 jest 的 CJS 环境里直接抛「A dynamic import callback was invoked without
 * --experimental-vm-modules」，而浏览器里那条路同样走不通。
 * 正确做法是自己把字节读出来，再把 `Uint8Array` 交给它。
 */

/** tree-sitter 的 Parser，只暴露我们用得到的部分 */
export interface TsParserLike {
  parse(source: string): { rootNode: unknown };
}

export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * 读一个 wasm 文件的字节。
 *
 * 浏览器里走 fetch（构建脚本已经把文件拷到 public/ 下），
 * Node 里走 fs —— 用 eval 拿 require，免得打包器把 fs 打进浏览器包。
 */
export async function readWasmBytes(location: string): Promise<Uint8Array> {
  if (isBrowser()) {
    const response = await fetch(location);
    if (!response.ok) throw new Error(`failed to fetch ${location}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const nodeRequire = eval('require') as (id: string) => { readFileSync(path: string): Buffer };
  return new Uint8Array(nodeRequire('fs').readFileSync(location));
}

export interface GrammarLoadOptions {
  /** web-tree-sitter 运行时 wasm 的地址。Node 里不用给。 */
  runtimeWasmUrl?: string;
  /** 语法：给地址或者直接给字节 */
  grammar: string | Uint8Array;
}

/**
 * 装好运行时与一门语法，返回一个 Parser。
 *
 * 调用方自己负责缓存 —— 每个语法各缓存一份，互不影响。
 */
export async function createTreeSitterParser<T>(options: GrammarLoadOptions): Promise<T> {
  const treeSitter: any = await import('web-tree-sitter');
  const Parser = treeSitter.Parser ?? treeSitter.default?.Parser;
  const Language = treeSitter.Language ?? treeSitter.default?.Language;

  const runtimeUrl = options.runtimeWasmUrl ?? (isBrowser() ? '/labkit/web-tree-sitter.wasm' : undefined);
  await Parser.init(runtimeUrl ? { locateFile: () => runtimeUrl } : undefined);

  const bytes = typeof options.grammar === 'string'
    ? await readWasmBytes(options.grammar)
    : options.grammar;

  const language = await Language.load(bytes);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser as T;
}
