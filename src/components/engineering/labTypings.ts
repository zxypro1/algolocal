/**
 * 注入 Monaco 的 @lab/* 类型声明
 *
 * 工作区里 import '@lab/net' 是平台提供的虚拟模块，编辑器默认不认识它。
 * 把声明喂给 TS language service，用户就能拿到补全和类型检查，
 * 而不是满屏「找不到模块」的红波浪线。
 */
export const LAB_TYPE_DECLARATIONS = `
declare module '@lab/net' {
  export interface LabResponse {
    status: number;
    data: unknown;
    url: string;
  }

  export interface LabRequestOptions {
    method?: string;
    body?: unknown;
  }

  /** Call the simulated downstream service. Rejects with a LabHttpError on failure. */
  export function request(url: string, options?: LabRequestOptions): Promise<LabResponse>;

  export class LabHttpError extends Error {
    status: number;
    url: string;
  }

  export interface LabRequestMetrics {
    total: number;
    ok: number;
    failed: number;
    throttled: number;
    retries: number;
    duplicated: number;
    byUrl: Record<string, number>;
  }

  export interface LabMetrics {
    virtualElapsedMs: number;
    maxConcurrency: number;
    concurrencyTimeline: Array<{ t: number; inFlight: number }>;
    requests: LabRequestMetrics;
    counters: Record<string, number>;
  }

  /** For use in the acceptance specs only */
  export function getMetrics(): LabMetrics;
}

declare module '@lab/env' {
  /** Wait on the virtual clock; this never really blocks */
  export function sleep(ms: number): Promise<void>;
  /** The current virtual time, in milliseconds */
  export function now(): number;
  /** A reproducible pseudo-random number */
  export function random(): number;
}

declare module '@lab/metrics' {
  import type { LabMetrics } from '@lab/net';
  /** Record a custom instrumentation counter */
  export function count(name: string, delta?: number): void;
  export function getCounters(): Record<string, number>;
  export function getMetrics(): LabMetrics;
}
`;

/**
 * 让 Monaco 认识 @lab/* 并放宽与本地工程无关的检查。
 *
 * monaco 在一个页面里是单例，这些设置是**全局**的：不还原的话，逛过一次工程实战
 * 之后，算法题编辑器也会继承 CommonJS / strict:false 和 @lab/* 声明，用户依赖的
 * 严格检查悄悄消失。所以这里返回一个还原函数，组件卸载时调用。
 */
export function configureMonacoForWorkspace(monaco: any): () => void {
  const typescript = monaco?.languages?.typescript;
  if (!typescript) return () => {};

  const restores: Array<() => void> = [];

  // JS 关卡走的是 javascriptDefaults，两边都要配，否则用 JavaScript 做题时
  // @lab/* 和相对导入都是「找不到模块」
  for (const defaults of [typescript.typescriptDefaults, typescript.javascriptDefaults]) {
    if (!defaults) continue;

    const previousCompilerOptions = defaults.getCompilerOptions?.();
    const previousDiagnosticsOptions = defaults.getDiagnosticsOptions?.();

    defaults.setCompilerOptions({
      target: typescript.ScriptTarget.ES2020,
      module: typescript.ModuleKind.CommonJS,
      moduleResolution: typescript.ModuleResolutionKind.NodeJs,
      allowNonTsExtensions: true,
      allowJs: true,
      esModuleInterop: true,
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      lib: ['es2020', 'dom'],
    });

    defaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });

    const extraLib = defaults.addExtraLib(LAB_TYPE_DECLARATIONS, 'file:///lab-modules.d.ts');

    restores.push(() => {
      extraLib?.dispose?.();
      if (previousCompilerOptions) defaults.setCompilerOptions(previousCompilerOptions);
      if (previousDiagnosticsOptions) defaults.setDiagnosticsOptions(previousDiagnosticsOptions);
    });
  }

  return () => restores.forEach((restore) => restore());
}
