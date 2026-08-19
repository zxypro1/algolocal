/**
 * 在浏览器里运行一关的 hook
 *
 * 优先用 Web Worker（可被 terminate，死循环不会冻住界面），
 * 环境不支持时退化到主线程直接执行。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunStageOptions } from '../lib/engineering/runner';
import type { StageRunReport } from '../lib/engineering/types';

export type RunPayload = Omit<RunStageOptions, 'transpile'>;

const DEFAULT_TIMEOUT_MS = 30_000;

/** 超时和「worker 本身坏了」要区别对待：超时可能是死循环，绝不能回退到主线程重跑 */
class RunTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunTimeoutError';
  }
}

interface PendingRun {
  resolve: (report: StageRunReport) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function createWorker(): Worker | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../workers/projectRunner.worker.ts', import.meta.url));
  } catch (error) {
    console.warn('Web Worker unavailable, falling back to main-thread execution', error);
    return null;
  }
}

async function runInline(payload: RunPayload): Promise<StageRunReport> {
  const [{ runStage }, { resolveTranspiler, sourcesOf }] = await Promise.all([
    import('../lib/engineering/runner'),
    import('../lib/engineering/transpile'),
  ]);
  const transpile = await resolveTranspiler(sourcesOf(payload));
  return runStage({ ...payload, transpile });
}

export function useProjectRunner() {
  const [report, setReport] = useState<StageRunReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<number, PendingRun>>(new Map());
  const requestIdRef = useRef(0);
  const workerBrokenRef = useRef(false);

  /**
   * 干掉 worker，并且把还挂在上面的运行**拒绝掉**。
   *
   * 只 clearTimeout 不 reject 的话，被顺带干掉的那次运行的 promise 永远不 settle：
   * run() 里的 await 不返回，finally 里的 setIsRunning(false) 也就不会执行，
   * 「运行验收」按钮从此一直是禁用状态，只能刷新页面。
   */
  const disposeWorker = useCallback((reason?: string) => {
    workerRef.current?.terminate();
    workerRef.current = null;
    const pendings = Array.from(pendingRef.current.values());
    pendingRef.current.clear();
    for (const pending of pendings) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason || 'The run was cancelled because the worker was disposed.'));
    }
  }, []);

  useEffect(() => disposeWorker, [disposeWorker]);

  const ensureWorker = useCallback((): Worker | null => {
    if (workerBrokenRef.current) return null;
    if (workerRef.current) return workerRef.current;

    const worker = createWorker();
    if (!worker) {
      workerBrokenRef.current = true;
      return null;
    }

    worker.onmessage = (event: MessageEvent<{ id: number; report?: StageRunReport; error?: string }>) => {
      const pending = pendingRef.current.get(event.data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRef.current.delete(event.data.id);

      if (event.data.report) pending.resolve(event.data.report);
      else pending.reject(new Error(event.data.error || 'Unknown worker error'));
    };

    worker.onerror = (event) => {
      // Worker 自身加载失败：本次之后一律走主线程
      workerBrokenRef.current = true;
      const failures = Array.from(pendingRef.current.values());
      pendingRef.current.clear();
      disposeWorker();
      failures.forEach((pending) => {
        clearTimeout(pending.timer);
        pending.reject(new Error(event.message || 'Worker failed to start'));
      });
    };

    workerRef.current = worker;
    return worker;
  }, [disposeWorker]);

  const run = useCallback(
    async (payload: RunPayload, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<StageRunReport | null> => {
      setIsRunning(true);
      setError(null);

      try {
        const worker = ensureWorker();
        let result: StageRunReport;

        if (worker) {
          const id = (requestIdRef.current += 1);
          try {
            result = await new Promise<StageRunReport>((resolve, reject) => {
              const timer = setTimeout(() => {
                pendingRef.current.delete(id);
                // 超时几乎都意味着用户代码里有死循环，直接掐掉这个 worker。
                // 同一个 worker 上并发的其他运行会被 disposeWorker 一并拒绝。
                disposeWorker('The worker was terminated because another run timed out.');
                reject(new RunTimeoutError(`Execution timed out after ${timeoutMs / 1000}s — check for an infinite loop.`));
              }, timeoutMs);

              pendingRef.current.set(id, { resolve, reject, timer });
              worker.postMessage({ id, payload });
            });
          } catch (workerError) {
            // 死循环不能回退到主线程，否则整个页面都会被冻住
            if (workerError instanceof RunTimeoutError) throw workerError;

            // 其余都是 worker 环境本身的问题（chunk 加载、bundle 缺失等），
            // 退回主线程重跑一次，用户至少不会被卡住
            console.warn('Worker execution failed, retrying on the main thread', workerError);
            workerBrokenRef.current = true;
            disposeWorker();
            result = await runInline(payload);
          }
        } else {
          result = await runInline(payload);
        }

        setReport(result);
        return result;
      } catch (runError) {
        const message = (runError as Error).message || 'Failed to run the stage';
        setError(message);
        setReport(null);
        return null;
      } finally {
        setIsRunning(false);
      }
    },
    [disposeWorker, ensureWorker]
  );

  const reset = useCallback(() => {
    setReport(null);
    setError(null);
  }, []);

  return { run, reset, report, isRunning, error };
}

export default useProjectRunner;
