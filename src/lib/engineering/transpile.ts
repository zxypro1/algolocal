/**
 * TypeScript 转译器加载
 *
 * 工作区里的 .ts 文件需要先转成 CommonJS 才能在模块运行时里执行。
 * 编译器按需懒加载：只有工程包含 TS 文件时才会拉这个 chunk，
 * 并且走本地 bundle 而不是 CDN，保证离线可用。
 */
import type { TranspileFn } from './moduleRuntime';

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

/** 工作区里是否存在需要转译的文件 */
export function needsTranspiler(files: Record<string, string>): boolean {
  return Object.entries(files).some(
    ([path, content]) => /\.tsx?$/.test(path) || /(^|\n)\s*(import\s|export\s)/.test(content)
  );
}

export async function resolveTranspiler(files: Record<string, string>): Promise<TranspileFn | undefined> {
  if (!needsTranspiler(files)) return undefined;
  const ts = await loadTypeScriptCompiler();
  return createTranspiler(ts);
}
