/**
 * 客户端消费「正文流 + 结构化结果」的那类接口。
 *
 * 生成类接口（出题、生成工程题、AI 评审）最终要的是一个对象，但模型写出来的
 * 原文没有理由攒到最后再给用户看。服务端因此发的是：
 *   delta ... delta   —— 模型原文，边写边到
 *   result            —— 解析校验之后的结构化结果
 *   done
 *
 * 这个函数把两者分开交付：正文通过回调实时给调用方，结果作为返回值。
 *
 * 它同时兼容「服务端直接回 JSON」的情况 —— 比如纯保存、或者还没进流就失败了。
 */
import { createSseParser } from './chatStreamProtocol';

export interface StructuredStreamHandlers {
  /** 每收到一段模型原文触发一次；full 是累计到目前的全文 */
  onDelta?: (chunk: string, full: string) => void;
  /** 服务端明说这一段不是逐字到达的（上游没给流） */
  onNotIncremental?: () => void;
}

export class StreamRequestError extends Error {
  /** 服务端附带的数据，例如 JSON 解析失败时的模型原文 */
  details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'StreamRequestError';
    this.details = details;
  }
}

export async function requestStructuredStream<T>(
  url: string,
  body: unknown,
  handlers: StructuredStreamHandlers = {},
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  const contentType = response.headers.get('content-type') || '';

  // 没进流就失败，或者这个请求本来就不调模型（例如「仍然保存」）
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      throw new StreamRequestError(text || `Request failed with ${response.status}`);
    }
    if (!response.ok) {
      throw new StreamRequestError(
        data?.error || `Request failed with ${response.status}`,
        data?.details ?? data?.rawContent
      );
    }
    return data as T;
  }

  const reader = response.body?.getReader();
  if (!reader) throw new StreamRequestError('This browser cannot read streaming responses');

  const decoder = new TextDecoder('utf-8');
  const parser = createSseParser();
  let full = '';
  let result: T | undefined;
  let failure: StreamRequestError | null = null;

  const consume = (events: ReturnType<typeof parser.push>) => {
    for (const event of events) {
      if (event.incremental === false) handlers.onNotIncremental?.();
      if (event.text) {
        full += event.text;
        handlers.onDelta?.(event.text, full);
      }
      if (event.result !== undefined) result = event.result as T;
      if (event.error) failure = new StreamRequestError(event.error, event.details);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    consume(parser.push(decoder.decode(value, { stream: true })));
  }
  consume(parser.flush());

  if (failure) throw failure;
  if (result === undefined) {
    throw new StreamRequestError('The server finished without returning a result');
  }
  return result;
}

export default requestStructuredStream;
