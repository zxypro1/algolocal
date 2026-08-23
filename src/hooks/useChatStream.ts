/**
 * 流式对话的客户端 hook
 *
 * 之前的写法是「每收到一个 chunk 就 setState 一次」。看起来没问题，但助手消息
 * 是用 MarkdownRenderer 渲染的——remark/rehype/katex/语法高亮会跟着每个 token
 * 完整跑一遍，一次回答就是几百次全量解析，长回答必然掉帧。
 *
 * 这里做三件事：
 * 1. chunk 先攒在 ref 里，按帧（约 60ms）批量刷进 state；
 * 2. 全程 AbortController：可以主动停止，弹窗关闭/组件卸载也会中断，
 *    服务端收到断开会把上游请求一起取消；
 * 3. 出错时**保留已经流出来的内容**，而不是把这条消息整个丢掉。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createSseParser } from '../lib/chatStreamProtocol';

export interface StreamMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 该消息是否仍在生成中 */
  streaming?: boolean;
  /** 生成中断或失败时的说明 */
  error?: string;
}

export interface SendOptions {
  url: string;
  /** 由调用方构造请求体，hook 只负责传输与渲染节流 */
  body: (history: StreamMessage[], input: string) => unknown;
}

const FLUSH_INTERVAL_MS = 60;

function createId(): string {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function useChatStream({ url, body }: SendOptions) {
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const bufferRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeIdRef = useRef<string | null>(null);

  // send 通过 ref 读历史：既让 send 的引用保持稳定，
  // 也保证 retry 截断历史后立刻重发时拿到的是截断后的版本
  const messagesRef = useRef<StreamMessage[]>(messages);
  messagesRef.current = messages;

  const stopFlushing = useCallback(() => {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  /** 把攒下的内容一次性写进对应的消息 */
  const flush = useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    const content = bufferRef.current;
    setMessages((prev) => {
      const target = prev.find((message) => message.id === id);
      if (!target || target.content === content) return prev;
      return prev.map((message) => (message.id === id ? { ...message, content } : message));
    });
  }, []);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    stopFlushing();
    flush();

    const id = activeIdRef.current;
    if (id) {
      setMessages((prev) =>
        prev.map((message) => (message.id === id ? { ...message, streaming: false } : message))
      );
    }
    activeIdRef.current = null;
    setIsStreaming(false);
  }, [flush, stopFlushing]);

  // 组件卸载（弹窗关闭）时断开，避免后台继续生成
  useEffect(() => () => {
    controllerRef.current?.abort();
    stopFlushing();
  }, [stopFlushing]);

  const send = useCallback(
    async (input: string) => {
      const text = input.trim();
      if (!text || isStreaming) return;

      const userMessage: StreamMessage = { id: createId(), role: 'user', content: text };
      const assistantId = createId();
      const history = messagesRef.current;

      setMessages((prev) => [
        ...prev,
        userMessage,
        { id: assistantId, role: 'assistant', content: '', streaming: true },
      ]);
      setError(null);
      setIsStreaming(true);

      bufferRef.current = '';
      activeIdRef.current = assistantId;

      const controller = new AbortController();
      controllerRef.current = controller;
      flushTimerRef.current = setInterval(flush, FLUSH_INTERVAL_MS);

      let streamError: string | null = null;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body(history, text)),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text();
          let message = '';
          try {
            message = JSON.parse(detail).error || '';
          } catch {
            // 不是 JSON 的错误体多半是代理或框架的 HTML 错误页。
            // 把整页贴进对话框只会给用户一屏标签，状态码才是有用的那部分。
          }
          throw new Error(message || `Request failed with ${response.status}`);
        }

        const reader = response.body?.getReader();
        // 非 SSE 的接口（或老部署）直接吐裸文本，这里原样累加，不要当成协议错误丢掉
        const isSse = (response.headers.get('content-type') || '').includes('text/event-stream');

        if (!reader) {
          bufferRef.current = await response.text();
        } else {
          const decoder = new TextDecoder('utf-8');
          const parser = createSseParser();

          const consume = (events: ReturnType<typeof parser.push>) => {
            for (const event of events) {
              if (event.error) streamError = event.error;
              if (event.text) bufferRef.current += event.text;
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            if (isSse) consume(parser.push(chunk));
            else bufferRef.current += chunk;
          }

          if (isSse) consume(parser.flush());
          else bufferRef.current += decoder.decode();
        }
      } catch (requestError) {
        // 主动 stop() 触发的中断不算错误
        if ((requestError as Error).name !== 'AbortError') {
          streamError = (requestError as Error).message || 'Failed to get AI response';
        }
      } finally {
        stopFlushing();
        const finalContent = bufferRef.current;

        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  // 已经流出来的内容保留，只在完全为空时才显示失败占位
                  content: finalContent,
                  streaming: false,
                  error: streamError || undefined,
                }
              : message
          )
        );

        if (streamError) setError(streamError);
        controllerRef.current = null;
        activeIdRef.current = null;
        setIsStreaming(false);
      }
    },
    [body, flush, isStreaming, stopFlushing, url]
  );

  const clear = useCallback(() => {
    stop();
    setMessages([]);
    setError(null);
  }, [stop]);

  /** 重发最后一条用户消息（把它之后的内容丢掉） */
  const retry = useCallback(() => {
    const current = messagesRef.current;
    const index = current.map((message) => message.role).lastIndexOf('user');
    if (index < 0) return;

    const question = current[index].content;
    const truncated = current.slice(0, index);
    messagesRef.current = truncated;
    setMessages(truncated);
    setError(null);
    // 下一帧再发，让 setMessages 落定后 UI 不闪
    setTimeout(() => send(question), 0);
  }, [send]);

  return { messages, send, stop, clear, retry, isStreaming, error, setError };
}

export default useChatStream;
