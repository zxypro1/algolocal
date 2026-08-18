/**
 * 浏览器端的多文件模块运行时
 *
 * 算法题只有一个函数，工程题是一个工程：需要 import/export、需要目录结构、
 * 需要循环依赖保护。这里实现了一个最小可用的 CommonJS 加载器，
 * 配合 TypeScript 转译就能在浏览器里跑起一个多文件项目。
 */

export type TranspileFn = (code: string, filePath: string) => string;

export interface ModuleRuntimeOptions {
  /** 虚拟文件系统：路径 -> 源码 */
  files: Record<string, string>;
  /** 虚拟内置模块，如 '@lab/net' */
  builtins?: Record<string, unknown>;
  /** 注入到每个模块作用域的全局对象（定时器、console 等） */
  globals?: Record<string, unknown>;
  /** TypeScript / ESM 转译函数 */
  transpile?: TranspileFn;
}

export class ModuleResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleResolutionError';
  }
}

export class ModuleEvaluationError extends Error {
  filePath: string;
  cause?: unknown;

  constructor(filePath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${filePath}: ${detail}`);
    this.name = 'ModuleEvaluationError';
    this.filePath = filePath;
    this.cause = cause;
  }
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.js'];
/**
 * 判断一段源码是不是 ESM。
 *
 * 关键字后面允许直接跟 `{` `*` 或引号：`export{x}`、`import'./polyfill'` 都是合法写法。
 * transpile.ts 里也要用同一个判断 —— 之前那边抄了一份更窄的正则，
 * 于是「运行时认为需要转译」而「加载器认为不需要」，整关直接报错跑不起来。
 */
export const ESM_PATTERN = /(^|\n)\s*(import|export)(\s|\{|\*|'|")/;

export function normalizePath(input: string): string {
  const segments = input.replace(/\\/g, '/').split('/');
  const stack: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

export function dirname(filePath: string): string {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

export function joinPath(base: string, relative: string): string {
  if (!base) return normalizePath(relative);
  return normalizePath(`${base}/${relative}`);
}

export function isTypeScript(filePath: string): boolean {
  return /\.tsx?$/.test(filePath);
}

export interface ModuleRuntime {
  /** 加载一个模块并返回它的 exports */
  require(id: string, fromFile?: string): unknown;
  /** 只做路径解析，不执行 */
  resolve(id: string, fromFile?: string): string;
  /** 已经被执行过的文件，按加载顺序 */
  readonly loadedFiles: string[];
  /** 模块依赖图：文件 -> 它 require 过的文件（不含内置模块） */
  readonly dependencyGraph: Record<string, string[]>;
}

export function createModuleRuntime(options: ModuleRuntimeOptions): ModuleRuntime {
  const files = options.files;
  const builtins = options.builtins || {};
  const globals = options.globals || {};
  const transpile = options.transpile;

  const cache = new Map<string, { exports: unknown }>();
  const compiled = new Map<string, string>();
  const loadedFiles: string[] = [];
  const dependencyGraph: Record<string, string[]> = {};

  const globalNames = Object.keys(globals).filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name));
  const globalValues = globalNames.map((name) => globals[name]);

  function resolve(id: string, fromFile = ''): string {
    if (Object.prototype.hasOwnProperty.call(builtins, id)) return id;

    const base = id.startsWith('.') ? dirname(fromFile) : '';
    const target = id.startsWith('.') ? joinPath(base, id) : normalizePath(id);

    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = `${target}${suffix}`;
      if (Object.prototype.hasOwnProperty.call(files, candidate)) return candidate;
    }

    // 允许省略 src/ 前缀（AI 生成的代码经常这么写）
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = `src/${target}${suffix}`;
      if (Object.prototype.hasOwnProperty.call(files, candidate)) return candidate;
    }

    throw new ModuleResolutionError(
      `Cannot resolve module "${id}"${fromFile ? ` from "${fromFile}"` : ''}`
    );
  }

  function compile(filePath: string): string {
    const cached = compiled.get(filePath);
    if (cached !== undefined) return cached;

    const source = files[filePath];
    const needsTranspile = isTypeScript(filePath) || ESM_PATTERN.test(source);
    let output = source;

    if (needsTranspile) {
      if (!transpile) {
        throw new ModuleEvaluationError(
          filePath,
          new Error('TypeScript/ESM source requires a transpiler but none was provided')
        );
      }
      output = transpile(source, filePath);
    }

    compiled.set(filePath, output);
    return output;
  }

  function requireModule(id: string, fromFile = ''): unknown {
    if (Object.prototype.hasOwnProperty.call(builtins, id)) {
      return builtins[id];
    }

    const filePath = resolve(id, fromFile);

    if (fromFile) {
      const deps = dependencyGraph[fromFile] || (dependencyGraph[fromFile] = []);
      if (!deps.includes(filePath)) deps.push(filePath);
    }

    const cached = cache.get(filePath);
    // 循环依赖时返回尚未填充完的 exports，与 Node 行为一致
    if (cached) return cached.exports;

    const moduleObject = { exports: {} as unknown };
    cache.set(filePath, moduleObject);
    loadedFiles.push(filePath);
    if (!dependencyGraph[filePath]) dependencyGraph[filePath] = [];

    const code = compile(filePath);
    const localRequire = (nextId: string) => requireModule(nextId, filePath);

    let factory: Function;
    try {
      factory = new Function(
        'exports',
        'module',
        'require',
        '__filename',
        '__dirname',
        ...globalNames,
        code
      );
    } catch (error) {
      cache.delete(filePath);
      throw new ModuleEvaluationError(filePath, error);
    }

    try {
      factory(
        moduleObject.exports,
        moduleObject,
        localRequire,
        filePath,
        dirname(filePath),
        ...globalValues
      );
    } catch (error) {
      cache.delete(filePath);
      if (error instanceof ModuleEvaluationError || error instanceof ModuleResolutionError) throw error;
      throw new ModuleEvaluationError(filePath, error);
    }

    return moduleObject.exports;
  }

  return {
    require: requireModule,
    resolve,
    loadedFiles,
    dependencyGraph,
  };
}
