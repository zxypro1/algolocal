/**
 * React Hook for WASM Code Execution
 * 在浏览器端使用 WebAssembly 执行代码
 * 
 * JavaScript: 使用 Function 构造函数执行
 * TypeScript: 使用 TypeScript 编译器转译后执行
 * Python: 使用 Pyodide WASM
 */
import { useState, useCallback, useRef } from 'react';

import {
  CONSOLE_LIMITS,
  createConsoleCollector,
  entriesFromPythonOutput,
  type ConsoleCollector,
  type ConsoleLogEntry,
} from '../lib/consoleCapture';
import { instrumentSource } from '../lib/trace/instrument';
import { createTraceRecorder } from '../lib/trace/recorder';
import { buildPythonTraceProgram } from '../lib/trace/pythonTrace';
import { EMPTY_TRACE, type ExecutionTrace } from '../lib/trace/types';

export type { ExecutionTrace, TraceStep } from '../lib/trace/types';

export type { ConsoleLogEntry };

export interface WasmExecutionResult {
  output: string;
  error: string;
  executionTime: number;
  success: boolean;
}

export interface TestResult {
  input: string;
  expected: any;
  actual: any;
  passed: boolean;
  executionTime: number;
  error: string | null;
  /** 这条用例执行期间用户代码产生的输出 */
  logs: ConsoleLogEntry[];
  /** 输出条数超过上限被截断 */
  logsTruncated: boolean;
}

export interface PerformanceStats {
  totalExecutionTime: number;
  averageExecutionTime: number;
  medianExecutionTime: number;
  minExecutionTime: number;
  maxExecutionTime: number;
  standardDeviation: number;
  warmupTime: number;
  iterations: number;
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
}

export interface RunTestsResult {
  status: 'success' | 'error';
  total: number;
  passed: number;
  results: TestResult[];
  performance: PerformanceStats;
  error?: string;
}

// WASM 运行时状态
interface WasmRuntimeState {
  pyodide: any;
  pyodideLoading: boolean;
  pyodideError: string | null;
  typescript: any;
  typescriptLoading: boolean;
  typescriptError: string | null;
}

// 全局运行时缓存
let globalRuntime: WasmRuntimeState = {
  pyodide: null,
  pyodideLoading: false,
  pyodideError: null,
  typescript: null,
  typescriptLoading: false,
  typescriptError: null,
};

/**
 * 使用 Function 构造函数安全执行 JavaScript 代码
 * 比 iframe 更可靠，适用于用户自己编写的代码
 */
export function executeCode(code: string, sandboxConsole?: unknown, traceApi?: unknown): any {
  try {
    // 用 Function 构造函数创建一个新的函数作用域。
    // console 和 __trace 都作为形参传进去：用户代码里的 console.* 命中我们的收集器，
    // 插桩产生的 __trace.* 命中记录器 —— 既能捕获，又不会污染全局或在并发运行时串台。
    const fn = new Function('console', '__trace', code);
    return fn(sandboxConsole ?? console, traceApi ?? NOOP_TRACE);
  } catch (error) {
    throw error;
  }
}

/** 没开调试时，插桩调用要有个不做事的落点（正常路径下代码根本没被插桩） */
const NOOP_TRACE = {
  enter: () => undefined,
  exit: () => undefined,
  step: () => undefined,
};

/**
 * 加载 TypeScript 编译器
 */
async function loadTypeScript(): Promise<any> {
  if (typeof window === 'undefined') {
    throw new Error('TypeScript can only be loaded in browser environment');
  }

  if (globalRuntime.typescript) {
    return globalRuntime.typescript;
  }

  if (globalRuntime.typescriptLoading) {
    return new Promise((resolve, reject) => {
      const checkLoaded = setInterval(() => {
        if (globalRuntime.typescript) {
          clearInterval(checkLoaded);
          resolve(globalRuntime.typescript);
        }
        if (globalRuntime.typescriptError) {
          clearInterval(checkLoaded);
          reject(new Error(globalRuntime.typescriptError));
        }
      }, 100);
    });
  }

  globalRuntime.typescriptLoading = true;

  try {
    // 动态加载 TypeScript 编译器
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/typescript@5.3.3/lib/typescript.min.js';
    
    await new Promise<void>((resolve, reject) => {
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load TypeScript'));
      document.head.appendChild(script);
    });

    globalRuntime.typescript = (window as any).ts;
    globalRuntime.typescriptLoading = false;
    return globalRuntime.typescript;
  } catch (error: any) {
    globalRuntime.typescriptError = error.message;
    globalRuntime.typescriptLoading = false;
    throw error;
  }
}

/**
 * 将 TypeScript 代码转译为 JavaScript
 */
async function transpileTypeScript(code: string): Promise<string> {
  const ts = await loadTypeScript();
  
  const result = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      strict: false,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    }
  });
  
  return result.outputText;
}

/**
 * 加载 Pyodide 运行时
 */
async function loadPyodide(): Promise<any> {
  if (typeof window === 'undefined') {
    throw new Error('Pyodide can only be loaded in browser environment');
  }

  if (globalRuntime.pyodide) {
    return globalRuntime.pyodide;
  }

  if (globalRuntime.pyodideLoading) {
    return new Promise((resolve, reject) => {
      const checkLoaded = setInterval(() => {
        if (globalRuntime.pyodide) {
          clearInterval(checkLoaded);
          resolve(globalRuntime.pyodide);
        }
        if (globalRuntime.pyodideError) {
          clearInterval(checkLoaded);
          reject(new Error(globalRuntime.pyodideError));
        }
      }, 100);
    });
  }

  globalRuntime.pyodideLoading = true;

  try {
    // 动态加载 Pyodide 脚本
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
    
    await new Promise<void>((resolve, reject) => {
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Pyodide script'));
      document.head.appendChild(script);
    });

    // @ts-ignore - loadPyodide 来自 CDN 脚本
    globalRuntime.pyodide = await (window as any).loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
    });
    globalRuntime.pyodideLoading = false;
    return globalRuntime.pyodide;
  } catch (error: any) {
    globalRuntime.pyodideError = error.message;
    globalRuntime.pyodideLoading = false;
    throw error;
  }
}

/**
 * 执行 JavaScript 代码（使用 Function 构造函数）
 *
 * 这个函数和下面的 parseTestInput / deepEqual 之所以导出，是为了让
 * tests/api/solutions.test.ts 能用**同一段代码**去验证题库里每一份参考实现。
 * 测试里复制一份执行逻辑的话，测的就是那份副本，题库和线上执行器之间的
 * 分歧反而看不见。
 */
export async function executeJavaScript(
  code: string,
  args: any[],
  isLinkedListProblem: boolean = false,
  collector?: ConsoleCollector,
  traceApi?: unknown
): Promise<{ result: any; error: string | null; executionTime: number }> {
  const startTime = performance.now();

  try {
    const jsCode = `
      ${isLinkedListProblem ? `
      function ListNode(val, next) {
        this.val = (val === undefined ? 0 : val);
        this.next = (next === undefined ? null : next);
      }

      function arrayToLinkedList(arr) {
        if (!arr || arr.length === 0) return null;
        var head = new ListNode(arr[0]);
        var current = head;
        for (var i = 1; i < arr.length; i++) {
          current.next = new ListNode(arr[i]);
          current = current.next;
        }
        return head;
      }

      function linkedListToArray(head) {
        var result = [];
        var current = head;
        while (current) {
          result.push(current.val);
          current = current.next;
        }
        return result;
      }
      ` : ''}

      var userExports = null;
      (function() {
        var module = { exports: null };
        ${code}
        userExports = module.exports;
      })();

      if (typeof userExports !== 'function') {
        throw new Error('Must use module.exports = yourFunction to export function');
      }

      var args = ${JSON.stringify(args)};
      
      ${isLinkedListProblem ? `
      var processedArgs = args.map(function(arg) {
        if (Array.isArray(arg)) {
          return arrayToLinkedList(arg);
        }
        return arg;
      });
      var rawResult = userExports.apply(null, processedArgs);
      return linkedListToArray(rawResult);
      ` : `
      return userExports.apply(null, args);
      `}
    `;

    const result = executeCode(jsCode, collector?.console, traceApi);
    const executionTime = performance.now() - startTime;

    return {
      result,
      error: null,
      executionTime
    };
  } catch (error: any) {
    const executionTime = performance.now() - startTime;
    return {
      result: null,
      error: error.message || String(error),
      executionTime
    };
  }
}

/**
 * 执行 TypeScript 代码（先转译为 JS 再执行）
 */
async function executeTypeScript(
  code: string,
  args: any[],
  isLinkedListProblem: boolean = false,
  collector?: ConsoleCollector,
  traceApi?: unknown
): Promise<{ result: any; error: string | null; executionTime: number }> {
  const startTime = performance.now();

  try {
    // 先转译 TypeScript 为 JavaScript
    const jsCode = await transpileTypeScript(code);
    
    // 然后使用 JavaScript 执行逻辑
    return await executeJavaScript(jsCode, args, isLinkedListProblem, collector, traceApi);
  } catch (error: any) {
    const executionTime = performance.now() - startTime;
    return {
      result: null,
      error: `TypeScript Error: ${error.message || String(error)}`,
      executionTime
    };
  }
}

/**
 * 执行 Python 代码
 */
async function executePython(
  code: string,
  args: any[],
  functionName: string = 'solution',
  collector?: ConsoleCollector
): Promise<{ result: any; error: string | null; executionTime: number }> {
  const startTime = performance.now();

  try {
    const pyodide = await loadPyodide();

    // 准备测试代码
    const argsJson = JSON.stringify(args).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    
    const testCode = `
import json
import sys
from io import StringIO

# 重置输出
_stdout_backup = sys.stdout
_stderr_backup = sys.stderr
sys.stdout = StringIO()
sys.stderr = StringIO()

_result = None
_error = None

try:
${code.split('\n').map(line => '    ' + line).join('\n')}

    # 执行测试
    _args = json.loads('${argsJson}')
    if len(_args) == 1:
        _result = ${functionName}(_args[0])
    else:
        _result = ${functionName}(*_args)
except Exception as e:
    _error = str(e)

_stdout_content = sys.stdout.getvalue()
_stderr_content = sys.stderr.getvalue()

sys.stdout = _stdout_backup
sys.stderr = _stderr_backup

{
    "result": _result if _error is None else None,
    "error": _error,
    "stdout": _stdout_content,
    "stderr": _stderr_content
}
    `;

    const output = await pyodide.runPythonAsync(testCode);
    const executionTime = performance.now() - startTime;

    // 将 Python 对象转换为 JS
    const jsOutput = output.toJs ? output.toJs({ dict_converter: Object.fromEntries }) : output;
    
    // stdout / stderr 一直都被收集着，只是过去没有被读出来，直接丢了。
    if (collector) {
      const { entries, truncated } = entriesFromPythonOutput(
        jsOutput.stdout || '',
        jsOutput.stderr || ''
      );
      // 走收集器自己的入口，才会受同一个条数上限约束
      for (const entry of entries) {
        if (collector.entries.length >= CONSOLE_LIMITS.maxEntries) {
          collector.truncated = true;
          break;
        }
        collector.entries.push(entry);
      }
      if (truncated) collector.truncated = true;
    }

    if (jsOutput.error) {
      return {
        result: null,
        error: jsOutput.error,
        executionTime
      };
    }

    // 递归转换 Map 为普通对象
    const convertResult = (val: any): any => {
      if (val instanceof Map) {
        const obj: any = {};
        val.forEach((v, k) => {
          obj[k] = convertResult(v);
        });
        return obj;
      }
      if (Array.isArray(val)) {
        return val.map(convertResult);
      }
      return val;
    };

    return {
      result: convertResult(jsOutput.result),
      error: null,
      executionTime
    };
  } catch (error: any) {
    const executionTime = performance.now() - startTime;
    return {
      result: null,
      error: error.message || String(error),
      executionTime
    };
  }
}

/**
 * 从模板提取函数名
 */
function extractFunctionName(template: string, language: string): string {
  switch (language) {
    case 'python': {
      const match = template.match(/def\s+(\w+)\s*\(/);
      return match ? match[1] : 'solution';
    }
    case 'javascript':
    case 'typescript': {
      const match = template.match(/function\s+(\w+)\s*[<(]/) || 
                   template.match(/(\w+)\s*=\s*function/) ||
                   template.match(/(\w+)\s*=\s*[<(]/) ||
                   template.match(/const\s+(\w+)\s*=/);
      return match ? match[1] : 'solution';
    }
    default:
      return 'solution';
  }
}

/**
 * 解析测试输入
 */
export function parseTestInput(input: string): any[] {
  try {
    // 处理多个参数的情况
    if (input.includes(',')) {
      const parts = splitCommaNotInBrackets(input);
      return parts.map(part => JSON.parse(part.trim()));
    } else {
      return [JSON.parse(input)];
    }
  } catch {
    return [input];
  }
}

/**
 * 分割逗号但不分割括号内的逗号
 */
function splitCommaNotInBrackets(str: string): string[] {
  const result: string[] = [];
  let current = '';
  let bracketCount = 0;
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if ((char === '"' || char === "'") && str[i - 1] !== '\\') {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      }
    }

    if (!inQuotes) {
      if (char === '[' || char === '(' || char === '{') {
        bracketCount++;
      } else if (char === ']' || char === ')' || char === '}') {
        bracketCount--;
      }
    }

    if (char === ',' && bracketCount === 0 && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

/**
 * 性能统计辅助函数
 */
interface BenchmarkConfig {
  warmupRuns: number;  // 预热运行次数
  measureRuns: number; // 测量运行次数
  discardOutliers: boolean; // 是否排除异常值
}

const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
  warmupRuns: 1,      // 1次预热
  measureRuns: 3,     // 3次测量
  discardOutliers: true
};

/**
 * 计算数组的中位数
 */
function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 计算标准差
 */
function calculateStandardDeviation(values: number[], mean: number): number {
  if (values.length <= 1) return 0;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(avgSquaredDiff);
}

/**
 * 使用 IQR 方法排除异常值
 */
function removeOutliers(values: number[]): number[] {
  if (values.length < 4) return values;
  
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  
  return values.filter(v => v >= lowerBound && v <= upperBound);
}

/**
 * 执行多次运行并收集性能数据
 */
async function benchmarkExecution(
  executeFn: () => Promise<{ result: any; error: string | null; executionTime: number }>,
  config: BenchmarkConfig = DEFAULT_BENCHMARK_CONFIG
): Promise<{
  result: any;
  error: string | null;
  times: number[];
  warmupTime: number;
}> {
  let warmupTime = 0;
  let lastResult: any = null;
  let lastError: string | null = null;
  const times: number[] = [];

  // 预热运行
  for (let i = 0; i < config.warmupRuns; i++) {
    const warmupResult = await executeFn();
    warmupTime += warmupResult.executionTime;
    lastResult = warmupResult.result;
    lastError = warmupResult.error;
    if (warmupResult.error) {
      // 预热阶段出错就直接返回
      return { result: lastResult, error: lastError, times: [warmupResult.executionTime], warmupTime };
    }
  }

  // 测量运行
  for (let i = 0; i < config.measureRuns; i++) {
    const measureResult = await executeFn();
    times.push(measureResult.executionTime);
    lastResult = measureResult.result;
    lastError = measureResult.error;
    if (measureResult.error) {
      return { result: lastResult, error: lastError, times, warmupTime };
    }
  }

  return { result: lastResult, error: lastError, times, warmupTime };
}

/**
 * 计算完整的性能统计
 */
function calculatePerformanceStats(
  times: number[],
  warmupTime: number,
  config: BenchmarkConfig = DEFAULT_BENCHMARK_CONFIG
): Omit<PerformanceStats, 'memoryUsage'> {
  // 是否排除异常值
  const processedTimes = config.discardOutliers ? removeOutliers(times) : times;
  
  if (processedTimes.length === 0) {
    return {
      totalExecutionTime: 0,
      averageExecutionTime: 0,
      medianExecutionTime: 0,
      minExecutionTime: 0,
      maxExecutionTime: 0,
      standardDeviation: 0,
      warmupTime: Math.round(warmupTime * 100) / 100,
      iterations: times.length
    };
  }

  const sum = processedTimes.reduce((a, b) => a + b, 0);
  const avg = sum / processedTimes.length;
  const median = calculateMedian(processedTimes);
  const stdDev = calculateStandardDeviation(processedTimes, avg);
  const min = Math.min(...processedTimes);
  const max = Math.max(...processedTimes);

  return {
    totalExecutionTime: Math.round(sum * 100) / 100,
    averageExecutionTime: Math.round(avg * 100) / 100,
    medianExecutionTime: Math.round(median * 100) / 100,
    minExecutionTime: Math.round(min * 100) / 100,
    maxExecutionTime: Math.round(max * 100) / 100,
    standardDeviation: Math.round(stdDev * 100) / 100,
    warmupTime: Math.round(warmupTime * 100) / 100,
    iterations: processedTimes.length
  };
}

/**
 * 深度比较两个值
 */
export function deepEqual(a: any, b: any): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!keysB.includes(key) || !deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return a === b;
}

/**
 * WASM 执行器 Hook
 */
export function useWasmExecutor() {
  const [isLoading, setIsLoading] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<{
    javascript: 'idle' | 'loading' | 'ready' | 'error';
    typescript: 'idle' | 'loading' | 'ready' | 'error';
    python: 'idle' | 'loading' | 'ready' | 'error';
  }>({
    javascript: 'ready', // JavaScript 原生支持，无需预加载
    typescript: 'idle',  // TypeScript 需要加载编译器
    python: 'idle'       // Python 需要加载 Pyodide
  });

  // 使用 ref 跟踪状态，避免 preloadRuntime 依赖 runtimeStatus 导致循环
  const runtimeStatusRef = useRef(runtimeStatus);
  runtimeStatusRef.current = runtimeStatus;

  /**
   * 预加载运行时
   * 注意：不依赖 runtimeStatus state，使用 ref 来检查当前状态
   */
  const preloadRuntime = useCallback(async (language: string) => {
    // JavaScript 原生支持，无需预加载，初始状态已经是 ready
    if (language === 'javascript') {
      return;
    }
    
    // TypeScript 需要加载编译器
    if (language === 'typescript') {
      // 使用 ref 检查状态，避免依赖 state
      if (runtimeStatusRef.current.typescript === 'ready' || 
          runtimeStatusRef.current.typescript === 'loading') {
        return;
      }
      setRuntimeStatus(prev => ({ ...prev, typescript: 'loading' }));
      try {
        await loadTypeScript();
        setRuntimeStatus(prev => ({ ...prev, typescript: 'ready' }));
      } catch {
        setRuntimeStatus(prev => ({ ...prev, typescript: 'error' }));
      }
      return;
    }
    
    // Python 需要加载 Pyodide
    if (language === 'python') {
      // 使用 ref 检查状态，避免依赖 state
      if (runtimeStatusRef.current.python === 'ready' || 
          runtimeStatusRef.current.python === 'loading') {
        return;
      }
      setRuntimeStatus(prev => ({ ...prev, python: 'loading' }));
      try {
        await loadPyodide();
        setRuntimeStatus(prev => ({ ...prev, python: 'ready' }));
      } catch {
        setRuntimeStatus(prev => ({ ...prev, python: 'error' }));
      }
    }
  }, []); // 移除 runtimeStatus 依赖，使用 ref 代替

  /**
   * 运行测试（纯 WASM 执行）- 使用更严谨的性能统计方法
   */
  const runTests = useCallback(async (
    problem: any,
    code: string,
    language: string
  ): Promise<RunTestsResult> => {
    setIsLoading(true);
    const totalStartTime = performance.now();
    const initialMemory = (performance as any).memory?.usedJSHeapSize || 0;

    try {
      // 验证语言是否支持
      const supportedLanguages = ['javascript', 'typescript', 'python'];
      if (!supportedLanguages.includes(language)) {
        throw new Error(`Language "${language}" is not supported. Supported languages: ${supportedLanguages.join(', ')}`);
      }

      const tests = problem.tests || [];
      const results: TestResult[] = [];
      let passedCount = 0;
      let totalWarmupTime = 0;
      const allExecutionTimes: number[] = [];

      const isLinkedListProblem = problem.tags?.includes('linked-list');
      const templateKey = language === 'javascript' ? 'js' : language;
      const functionName = extractFunctionName(
        problem.template?.[templateKey] || '',
        language
      );

      for (const test of tests) {
        // 每条用例一个收集器，日志才能和用例对上号。
        // 放在 try 外面，抛异常时也能把已经打出来的日志带出去 —— 恰恰是最需要看日志的时候。
        const collector = createConsoleCollector('user');
        // 基准测试会把同一段代码跑 4 次（1 次预热 + 3 次测量）。
        // 全部收集的话每条日志会重复四遍，所以只记录第一次运行的输出。
        let captureThisRun = true;

        try {
          const args = parseTestInput(test.input);
          const expected = JSON.parse(test.output);

          // 创建执行函数
          const createExecuteFn = () => {
            // 每次都需要重新解析参数，因为某些语言（如链表问题）会修改参数
            const freshArgs = parseTestInput(test.input);
            // 后续几次基准运行同样注入替身 console（保证四次运行行为一致），
            // 只是把输出丢进一个一次性收集器，不进入结果。
            const runCollector = captureThisRun ? collector : createConsoleCollector('user');
            captureThisRun = false;

            if (language === 'javascript') {
              return executeJavaScript(code, freshArgs, isLinkedListProblem, runCollector);
            } else if (language === 'typescript') {
              return executeTypeScript(code, freshArgs, isLinkedListProblem, runCollector);
            } else if (language === 'python') {
              return executePython(code, freshArgs, functionName, runCollector);
            } else {
              throw new Error(`Unsupported language: ${language}`);
            }
          };

          // 使用基准测试方法执行多次运行
          const benchmarkResult = await benchmarkExecution(createExecuteFn, DEFAULT_BENCHMARK_CONFIG);
          
          totalWarmupTime += benchmarkResult.warmupTime;
          allExecutionTimes.push(...benchmarkResult.times);

          if (benchmarkResult.error) {
            results.push({
              input: test.input,
              expected,
              actual: null,
              passed: false,
              executionTime: calculateMedian(benchmarkResult.times),
              error: benchmarkResult.error,
              logs: collector.entries,
              logsTruncated: collector.truncated
            });
          } else {
            const passed = deepEqual(benchmarkResult.result, expected);
            if (passed) passedCount++;

            // 使用中位数作为该测试用例的执行时间（更稳定）
            const medianTime = calculateMedian(benchmarkResult.times);

            results.push({
              input: test.input,
              expected,
              actual: benchmarkResult.result,
              passed,
              executionTime: Math.round(medianTime * 100) / 100,
              error: null,
              logs: collector.entries,
              logsTruncated: collector.truncated
            });
          }
        } catch (error: any) {
          results.push({
            input: test.input,
            expected: JSON.parse(test.output),
            actual: null,
            passed: false,
            executionTime: 0,
            error: error.message || String(error),
            logs: collector.entries,
            logsTruncated: collector.truncated
          });
        }
      }

      const totalExecutionTime = performance.now() - totalStartTime;
      const finalMemory = (performance as any).memory?.usedJSHeapSize || 0;
      const memoryUsed = Math.max(0, finalMemory - initialMemory);

      // 计算完整的性能统计
      const perfStats = calculatePerformanceStats(allExecutionTimes, totalWarmupTime, DEFAULT_BENCHMARK_CONFIG);

      setIsLoading(false);

      return {
        status: 'success',
        total: tests.length,
        passed: passedCount,
        results,
        performance: {
          ...perfStats,
          // 覆盖总时间为实际测量的总时间
          totalExecutionTime: Math.round(totalExecutionTime * 100) / 100,
          memoryUsage: {
            heapUsed: Math.round(memoryUsed / 1024 / 1024 * 100) / 100,
            heapTotal: Math.round(finalMemory / 1024 / 1024 * 100) / 100,
            external: 0,
            rss: Math.round(finalMemory / 1024 / 1024 * 100) / 100
          }
        }
      };
    } catch (error: any) {
      setIsLoading(false);
      return {
        status: 'error',
        total: 0,
        passed: 0,
        results: [],
        performance: {
          totalExecutionTime: 0,
          averageExecutionTime: 0,
          medianExecutionTime: 0,
          minExecutionTime: 0,
          maxExecutionTime: 0,
          standardDeviation: 0,
          warmupTime: 0,
          iterations: 0,
          memoryUsage: { heapUsed: 0, heapTotal: 0, external: 0, rss: 0 }
        },
        error: error.message || String(error)
      };
    }
  }, []);

  /**
   * 获取支持的语言列表
   */
  const getSupportedLanguages = useCallback((): string[] => {
    return ['javascript', 'typescript', 'python'];
  }, []);

  /**
   * 带轨迹地跑**一条**用例。
   *
   * 只跑一条是刻意的：轨迹是给「这一条为什么错」用的，
   * 把所有用例都录一遍既慢又没人看。也不做基准测试的多次运行 ——
   * 那样会录出四份一模一样的轨迹。
   */
  const traceExecution = useCallback(async (
    problem: any,
    code: string,
    language: string,
    testIndex: number = 0
  ): Promise<{ trace: ExecutionTrace; result: any; error: string | null; logs: ConsoleLogEntry[] }> => {
    const test = (problem.tests || [])[testIndex];
    if (!test) {
      return { trace: { ...EMPTY_TRACE, error: 'No such test case' }, result: null, error: 'No such test case', logs: [] };
    }

    const args = parseTestInput(test.input);
    const collector = createConsoleCollector('user');

    if (language === 'python') {
      const templateKey = 'python';
      const functionName = extractFunctionName(problem.template?.[templateKey] || '', 'python');
      return await tracePython(code, args, functionName, collector);
    }

    // JS / TS：先插桩，再按平常的方式跑
    const tsModule = await loadTypeScript();
    const recorder = createTraceRecorder();
    let instrumented: string;
    try {
      instrumented = instrumentSource(tsModule, code);
    } catch (error: any) {
      return {
        trace: { ...EMPTY_TRACE, error: `Could not instrument the code: ${error?.message || error}` },
        result: null,
        error: error?.message || String(error),
        logs: [],
      };
    }

    const isLinkedListProblem = problem.tags?.includes('linked-list');
    // instrumentSource 已经把 TS 转成 JS 了，所以这里统一走 JS 路径
    const outcome = await executeJavaScript(instrumented, args, isLinkedListProblem, collector, recorder.api);

    recorder.trace.completed = !outcome.error;
    if (outcome.error) recorder.trace.error = outcome.error;

    return {
      trace: recorder.trace,
      result: outcome.result,
      error: outcome.error,
      logs: collector.entries,
    };
  }, []);

  return {
    runTests,
    traceExecution,
    isLoading,
    runtimeStatus,
    preloadRuntime,
    getSupportedLanguages
  };
}

/** Python 走 sys.settrace，不插桩 */
async function tracePython(
  code: string,
  args: any[],
  functionName: string,
  collector: ConsoleCollector
): Promise<{ trace: ExecutionTrace; result: any; error: string | null; logs: ConsoleLogEntry[] }> {
  try {
    const pyodide = await loadPyodide();
    const program = buildPythonTraceProgram(code, functionName, JSON.stringify(args));
    const output = await pyodide.runPythonAsync(program);
    const js = output?.toJs ? output.toJs({ dict_converter: Object.fromEntries }) : output;

    const { entries, truncated } = entriesFromPythonOutput(js.stdout || '', js.stderr || '');
    collector.entries.push(...entries);
    if (truncated) collector.truncated = true;

    let trace: ExecutionTrace = { ...EMPTY_TRACE };
    try {
      trace = JSON.parse(js.trace);
    } catch {
      trace = { ...EMPTY_TRACE, error: 'Could not read the trace back from Python' };
    }

    return { trace, result: js.result ?? null, error: js.error || null, logs: collector.entries };
  } catch (error: any) {
    return {
      trace: { ...EMPTY_TRACE, error: error?.message || String(error) },
      result: null,
      error: error?.message || String(error),
      logs: collector.entries,
    };
  }
}

export default useWasmExecutor;

