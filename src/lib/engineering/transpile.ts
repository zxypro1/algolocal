/**
 * TypeScript 转译器加载
 *
 * 工作区里的 .ts 文件需要先转成 CommonJS 才能在模块运行时里执行。
 * 编译器按需懒加载：只有工程包含 TS 文件时才会拉这个 chunk，
 * 并且走本地 bundle 而不是 CDN，保证离线可用。
 */
import { ESM_PATTERN, type TranspileFn } from './moduleRuntime';

let compilerPromise: Promise<any> | null = null;

export async function loadTypeScriptCompiler(): Promise<any> {
  if (typeof window !== 'undefined' && (window as any).ts) {
    return (window as any).ts;
  }
  if (!compilerPromise) {
    compilerPromise = import('typescript').then((mod: any) => mod.default || mod);
  }
  return compilerPromise;
}

export function createTranspiler(ts: any): TranspileFn {
  return (code: string, filePath: string) =>
    ts.transpileModule(code, {
      fileName: filePath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
        allowJs: true,
        strict: false,
        skipLibCheck: true,
        // 保留 class fields 的原生语义，避免和虚拟时钟的执行顺序打架
        useDefineForClassFields: false,
      },
    }).outputText;
}

/**
 * 工作区里是否存在需要转译的文件。
 *
 * 判断标准必须和 moduleRuntime 里那条完全一致，所以直接复用 ESM_PATTERN：
 * 两边一旦不一致，就会出现「运行时要求转译器，而这里认为不需要、没加载」，
 * 结果是整关以 ModuleEvaluationError 失败。
 */
export function needsTranspiler(files: Record<string, string>): boolean {
  return Object.entries(files).some(
    ([path, content]) => /\.tsx?$/.test(path) || ESM_PATTERN.test(content)
  );
}

/**
 * 一次运行真正会被编译的所有源码：工作区文件 + 该关的隐藏用例。
 *
 * runStage 编译的是 `{ ...files, [spec.path]: spec.content }`。只看 files 的话，
 * 「CommonJS 工作区 + ESM 用例」会被判成不需要转译器，然后模块运行时在编译用例时
 * 抛 ModuleEvaluationError，整关跑不起来。
 */
export function sourcesOf(payload: {
  files: Record<string, string>;
  specs?: Array<{ path: string; content: string }>;
}): Record<string, string> {
  const sources = { ...payload.files };
  for (const spec of payload.specs || []) sources[spec.path] = spec.content;
  return sources;
}

export async function resolveTranspiler(files: Record<string, string>): Promise<TranspileFn | undefined> {
  if (!needsTranspiler(files)) return undefined;
  const ts = await loadTypeScriptCompiler();
  return createTranspiler(ts);
}
