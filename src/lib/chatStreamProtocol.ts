/**
 * 聊天流的线上协议（前后端共用的约定）
 *
 * 服务端发的是 SSE，每个事件一行 JSON：
 *   data: {"type":"delta","text":"…"}
 *   data: {"type":"error","message":"…"}
 *   data: {"type":"done"}
 *
 * 为什么不用裸文本流：HTTP 头一旦发出去状态码就固定了，中途出错没法再用 4xx/5xx
 * 表达。裸文本只能把错误信息混进正文里，前端分不清那是模型说的还是系统报的。
 *
 * 解析要处理**任意位置的分块**——网络层不保证一个 chunk 正好是一行。
 */

export interface StreamEvent {
  text?: string;
  error?: string;
  done?: boolean;
}

/** 解析单行 `data:`；不是事件行则返回 null */
export function parseSseLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;

  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  // 兼容 OpenAI 风格的终止标记
  if (payload === '[DONE]') return { done: true };

  try {
    const event = JSON.parse(payload);
    if (event.type === 'delta') return { text: event.text || '' };
    if (event.type === 'error') return { error: event.message || 'stream error' };
    if (event.type === 'done') return { done: true };
    return null;
  } catch {
    // 不是 JSON 就按裸文本处理，兼容老接口
    return { text: payload };
  }
}

/**
 * 有状态的分块解析器：把跨 chunk 的半行缓存起来。
 */
export function createSseParser() {
  let pending = '';

  return {
    push(chunk: string): StreamEvent[] {
      pending += chunk;
      const lines = pending.split('\n');
      // 最后一段可能是半行，留到下一次
      pending = lines.pop() || '';

      const events: StreamEvent[] = [];
      for (const line of lines) {
        const event = parseSseLine(line);
        if (event) events.push(event);
      }
      return events;
    },

    /** 流结束时把残留的一行冲出来 */
    flush(): StreamEvent[] {
      if (!pending.trim()) {
        pending = '';
        return [];
      }
      const event = parseSseLine(pending);
      pending = '';
      return event ? [event] : [];
    },
  };
}
