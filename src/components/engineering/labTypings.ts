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

  /** 调用模拟的下游服务。失败时 reject 一个 LabHttpError。 */
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

  /** 只在验收用例里使用 */
  export function getMetrics(): LabMetrics;
}

declare module '@lab/env' {
  /** 虚拟时钟上的等待，不会真的阻塞 */
  export function sleep(ms: number): Promise<void>;
  /** 当前虚拟时间（毫秒） */
  export function now(): number;
  /** 可复现的伪随机数 */
  export function random(): number;
}

declare module '@lab/metrics' {
  import type { LabMetrics } from '@lab/net';
  /** 自定义埋点计数 */
  export function count(name: string, delta?: number): void;
  export function getCounters(): Record<string, number>;
  export function getMetrics(): LabMetrics;
}
`;

/** 让 Monaco 认识 @lab/* 并放宽与本地工程无关的检查 */
export function configureMonacoForWorkspace(monaco: any): void {
  const typescript = monaco?.languages?.typescript;
  if (!typescript) return;

  // JS 关卡走的是 javascriptDefaults，两边都要配，否则用 JavaScript 做题时
  // @lab/* 和相对导入都是「找不到模块」
  for (const defaults of [typescript.typescriptDefaults, typescript.javascriptDefaults]) {
    if (!defaults) continue;

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

    defaults.addExtraLib(LAB_TYPE_DECLARATIONS, 'file:///lab-modules.d.ts');
  }
}
