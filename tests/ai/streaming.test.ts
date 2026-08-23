/**
 * 流式协议的两端测试
 *
 * 服务端：各家上游的分块格式 -> 统一 SSE 事件
 * 客户端：SSE 事件 -> 文本，重点是任意位置切分的分块
 */
import { createSseParser, parseSseLine } from '../../src/lib/chatStreamProtocol';
import {
  callAI,
  NoProviderError,
  normalizeMessages,
  resolveProvider,
  statusForError,
  streamAI,
  streamStructured,
} from '../../src/lib/server/aiProvider';

/* ------------------------------------------------------------------ */
/* 客户端解析                                                          */
/* ------------------------------------------------------------------ */

describe('client SSE parsing', () => {
  it('parses delta / error / done events', () => {
    expect(parseSseLine('data: {"type":"delta","text":"hi"}')).toEqual({ text: 'hi' });
    expect(parseSseLine('data: {"type":"error","message":"boom"}')).toEqual({ error: 'boom' });
    expect(parseSseLine('data: {"type":"done"}')).toEqual({ done: true });
    expect(parseSseLine('data: [DONE]')).toEqual({ done: true });
  });

  it('ignores non-data lines', () => {
    expect(parseSseLine('')).toBeNull();
    expect(parseSseLine(': keep-alive')).toBeNull();
    expect(parseSseLine('event: message')).toBeNull();
  });

  it('reassembles events split across arbitrary chunk boundaries', () => {
    const stream = [
      'data: {"type":"delta","text":"Hel',
      'lo"}\n\ndata: {"type":"del',
      'ta","text":" world"}\n\ndata: {"type":"done"}\n\n',
    ];

    const parser = createSseParser();
    let text = '';
    let done = false;

    for (const chunk of stream) {
      for (const event of parser.push(chunk)) {
        if (event.text) text += event.text;
        if (event.done) done = true;
      }
    }
    for (const event of parser.flush()) {
      if (event.text) text += event.text;
      if (event.done) done = true;
    }

    expect(text).toBe('Hello world');
    expect(done).toBe(true);
  });

  it('surfaces a mid-stream error while keeping earlier text', () => {
    const parser = createSseParser();
    const events = parser.push(
      'data: {"type":"delta","text":"partial"}\n\ndata: {"type":"error","message":"upstream died"}\n\n'
    );

    expect(events[0]).toEqual({ text: 'partial' });
    expect(events[1]).toEqual({ error: 'upstream died' });
  });

  it('treats non-JSON payloads as plain text for legacy endpoints', () => {
    expect(parseSseLine('data: raw text')).toEqual({ text: 'raw text' });
  });
});

/* ------------------------------------------------------------------ */
/* 消息规整                                                            */
/* ------------------------------------------------------------------ */

describe('message normalisation', () => {
  /**
   * 开放权重模型的 chat 模板（Qwen 等）在 Jinja 里写死了
   * raise_exception('System message must be at the beginning.')，
   * llama.cpp / LM Studio / Ollama 会把它变成一个 400。
   * 托管 API 宽容，所以这个前提一直没被我们自己保证。
   */
  it('merges multiple system messages into one at the front', () => {
    expect(
      normalizeMessages([
        { role: 'system', content: 'persona' },
        { role: 'system', content: 'context' },
        { role: 'user', content: 'hi' },
      ])
    ).toEqual([
      { role: 'system', content: 'persona\n\ncontext' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('hoists a system message that arrived mid-conversation', () => {
    expect(
      normalizeMessages([
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'late rule' },
        { role: 'assistant', content: 'sure' },
      ])
    ).toEqual([
      { role: 'system', content: 'late rule' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'sure' },
    ]);
  });

  it('drops empty system messages instead of sending a blank one', () => {
    expect(
      normalizeMessages([
        { role: 'system', content: '   ' },
        { role: 'user', content: 'hi' },
      ])
    ).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('leaves a conversation without a system message alone', () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ];
    expect(normalizeMessages(messages)).toEqual(messages);
  });

  /**
   * 一次失败的请求会在历史里留下一条空的 assistant 消息，下次发送会带上它。
   * Anthropic 拒绝空的 content block，一部分模板也一样 ——
   * 结果是一次偶发失败把整个会话钉死。
   */
  it('drops the empty assistant turn a failed request leaves behind', () => {
    expect(
      normalizeMessages([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'second' },
      ])
    ).toEqual([{ role: 'user', content: 'first\n\nsecond' }]);
  });

  it('survives a malformed messages array instead of throwing', () => {
    const messages = [
      null,
      { role: 'system', content: { nope: true } },
      { role: 'user', content: 'hi' },
    ] as any;
    expect(() => normalizeMessages(messages)).not.toThrow();
    // 非字符串的 content 直接丢掉：硬转出来的 "[object Object]" 会变成
    // 模型真的看到的提示词
    expect(normalizeMessages(messages)).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

/* ------------------------------------------------------------------ */
/* 服务端产出                                                          */
/* ------------------------------------------------------------------ */

interface FakeRes {
  written: string[];
  headersSent: boolean;
  ended: boolean;
  statusCode?: number;
  jsonBody?: unknown;
  headers?: Record<string, string>;
}

function createFakeRes(): FakeRes & Record<string, any> {
  const res: any = {
    written: [],
    headersSent: false,
    ended: false,
    writeHead(status: number, headers: Record<string, string>) {
      res.statusCode = status;
      res.headers = headers;
      res.headersSent = true;
    },
    write(chunk: string) {
      res.written.push(chunk);
    },
    end() {
      res.ended = true;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
    on() {},
  };
  return res;
}

/** 把一串文本块做成一个可读的 fetch Response */
function fakeStreamResponse(chunks: string[]): any {
  let index = 0;
  return {
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = new TextEncoder().encode(chunks[index]);
          index += 1;
          return { done: false, value };
        },
      }),
    },
  };
}

/**
 * 带时间表的假上游：第 n 块在 delayMs*(n+1) 时才可读。
 *
 * 真流式的判据不是「收到了几块」，而是「第一块到达的时刻」——
 * 假流式会把所有块攒到最后一起交出来，那时第一块的到达时间约等于总时长。
 */
function timedStreamResponse(chunks: string[], delayMs: number): any {
  let index = 0;
  return {
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = new TextEncoder().encode(chunks[index]);
          index += 1;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return { done: false, value };
        },
      }),
    },
  };
}

/**
 * 一次性返回整段 JSON 的上游：无视了 stream:true。
 *
 * 真实的 fetch 响应永远有 body（哪怕内容是一整个 JSON），所以这里也给一个 ——
 * 服务端不按 content-type 分派，一律按流读，靠读完之后的兜底解析发现真相。
 */
function nonStreamingResponse(body: unknown): any {
  return {
    ...fakeStreamResponse([JSON.stringify(body)]),
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
  };
}

function createTimingRes(): FakeRes & Record<string, any> {
  const res = createFakeRes();
  const startedAt = Date.now();
  res.timeline = [] as Array<{ at: number; frame: string }>;
  const write = res.write;
  res.write = (chunk: string) => {
    res.timeline.push({ at: Date.now() - startedAt, frame: chunk });
    return write(chunk);
  };
  return res;
}

/** 每个 delta 事件写出去的时刻 */
function deltaTimes(res: any): number[] {
  return res.timeline
    .filter((entry: any) => entry.frame.includes('"type":"delta"'))
    .map((entry: any) => entry.at);
}

function collectText(res: FakeRes): string {
  return res.written
    .map((frame) => {
      const match = frame.match(/^data: (.*)\n\n$/);
      if (!match) return '';
      try {
        const event = JSON.parse(match[1]);
        return event.type === 'delta' ? event.text : '';
      } catch {
        return '';
      }
    })
    .join('');
}

function collectEvents(res: FakeRes): any[] {
  return res.written
    .map((frame) => {
      const match = frame.match(/^data: (.*)\n\n$/);
      if (!match) return null;
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

describe('server streaming', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('converts OpenAI-style chunks into SSE delta events', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeStreamResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
    ) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'k', model: 'gpt-4.1' },
      selectedProvider: 'openai',
    });

    expect(collectText(res)).toBe('Hello there');
    expect(collectEvents(res).pop()).toEqual({ type: 'done' });
    expect(res.ended).toBe(true);
  });

  it('parses Claude content_block_delta events', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeStreamResponse([
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Anth"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ropic"}}\n\n',
      ])
    ) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      claude: { apiKey: 'k', model: 'claude-sonnet-5' },
      selectedProvider: 'claude',
    });

    expect(collectText(res)).toBe('Anthropic');
  });

  it('parses Ollama NDJSON', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeStreamResponse(['{"message":{"content":"lo"}}\n', '{"message":{"content":"cal"}}\n{"done":true}\n'])
    ) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      ollama: { endpoint: 'http://localhost:11434', model: 'llama3.1' },
      selectedProvider: 'ollama',
    });

    expect(collectText(res)).toBe('local');
  });

  it('sends reasoning-model parameters correctly', async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeStreamResponse(['data: [DONE]\n\n']));
    global.fetch = fetchMock as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'k', model: 'o4-mini' },
      selectedProvider: 'openai',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_completion_tokens).toBeDefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  /**
   * 上游拒绝了请求，是「这次请求不对」而不是「我们挂了」——
   * 状态码要照传，消息要是人能读的那一句，否则用户只看到一个 500，
   * 无从知道该去改 key、改模型名还是改端点。
   */
  it('passes an upstream 401 through as 401, with its message', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid api key',
    }) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'bad', model: 'gpt-4.1' },
      selectedProvider: 'openai',
    });

    expect(res.statusCode).toBe(401);
    expect((res.jsonBody as any).error).toBe('invalid api key');
    expect(res.written).toHaveLength(0);
  });

  it('unwraps an OpenAI-style error body instead of quoting the raw JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: { message: 'system message must be at the beginning', code: 'template_error' },
        }),
    }) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      compatible: { endpoint: 'http://localhost:1234/v1', model: 'qwen3-8b' },
      selectedProvider: 'compatible',
    });

    expect(res.statusCode).toBe(400);
    expect((res.jsonBody as any).error).toBe('system message must be at the beginning');
  });

  it('reports an upstream 5xx as 502, not as our own 500', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'model is loading',
    }) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'k', model: 'gpt-4.1' },
      selectedProvider: 'openai',
    });

    expect(res.statusCode).toBe(502);
    expect((res.jsonBody as any).error).toBe('model is loading');
  });

  it('classifies a missing provider as 400, not 500', () => {
    // 没配 provider 是「你还没设置」，不是「服务器坏了」。
    // resolveProvider 在写响应头之前就抛，由路由的 catch 统一映射状态码。
    // 这里要把环境变量清干净：本机（或 CI）上导了任意一把 key，auto 顺序就会选中它。
    const envKeys = [
      'DEEPSEEK_API_KEY',
      'OPENAI_API_KEY',
      'QWEN_API_KEY',
      'CLAUDE_API_KEY',
      'OLLAMA_MODEL',
      'OPENAI_COMPATIBLE_ENDPOINT',
      'OPENAI_COMPATIBLE_MODEL',
    ];
    const saved: Record<string, string | undefined> = {};
    envKeys.forEach((key) => {
      saved[key] = process.env[key];
      delete process.env[key];
    });

    try {
      expect(() => resolveProvider({}, 4000)).toThrow(NoProviderError);
      expect(statusForError(new NoProviderError())).toBe(400);
    } finally {
      envKeys.forEach((key) => {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      });
    }
  });

  it('reports a connection failure as a fixable message, not "fetch failed"', async () => {
    const refused: any = new TypeError('fetch failed');
    refused.cause = { code: 'ECONNREFUSED' };
    global.fetch = jest.fn().mockRejectedValue(refused) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      compatible: { endpoint: 'http://127.0.0.1:1234/v1', model: 'qwen3-8b' },
      selectedProvider: 'compatible',
    });

    expect(res.statusCode).toBe(502);
    expect((res.jsonBody as any).error).toContain('refused the connection');
    expect((res.jsonBody as any).error).not.toContain('fetch failed');
  });

  /**
   * 超时和「客户端自己走了」都是 AbortError，但两者的正确反应相反：
   * 前者要告诉用户，后者只需安静收尾。混在一起的后果是等满两分钟之后
   * 拿到一个空白气泡 —— 没内容、没报错，看不出发生了什么。
   */
  it('reports an upstream timeout as 504, not as a silent empty response', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(
      (_url: any, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })
    ) as any;

    const res = createFakeRes();
    const pending = streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'k', model: 'gpt-4.1' },
      selectedProvider: 'openai',
    });
    jest.advanceTimersByTime(130_000);
    await pending;
    jest.useRealTimers();

    expect(res.statusCode).toBe(504);
    expect((res.jsonBody as any).error).toMatch(/No response from https:\/\/api\.openai\.com/);
  });

  it('stays quiet when it is the client that left', async () => {
    const controller = new AbortController();
    global.fetch = jest.fn(() => {
      controller.abort();
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    }) as any;

    const res = createFakeRes();
    await streamAI(
      res as any,
      [{ role: 'user', content: 'hi' }],
      { openAI: { apiKey: 'k', model: 'gpt-4.1' }, selectedProvider: 'openai' },
      { signal: controller.signal }
    );

    expect(res.statusCode).toBeUndefined();
    expect(res.jsonBody).toBeFalsy();
    expect(res.ended).toBe(true);
  });

  it('does not paste an HTML error page into the message', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => '<html><head><title>502 Bad Gateway</title></head><body>...</body></html>',
    }) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'k', model: 'gpt-4.1' },
      selectedProvider: 'openai',
    });

    expect((res.jsonBody as any).error).not.toContain('<html>');
    expect((res.jsonBody as any).error).toMatch(/HTML error page/);
  });

  it('reports a mid-stream failure as an error event, not a broken body', async () => {
    let index = 0;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => ({
          read: async () => {
            index += 1;
            if (index === 1) {
              return {
                done: false,
                value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
              };
            }
            throw new Error('connection reset');
          },
        }),
      },
    }) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'k', model: 'gpt-4.1' },
      selectedProvider: 'openai',
    });

    const events = collectEvents(res);
    // 已经流出去的正文保留，错误单独作为一个事件
    expect(events[0]).toEqual({ type: 'delta', text: 'partial' });
    expect(events[events.length - 1].type).toBe('error');
    expect(events[events.length - 1].message).toMatch(/connection reset/);
    expect(res.ended).toBe(true);
  });

  /**
   * 真流式的证据：delta 写出去的时刻要跟着上游的节奏走。
   *
   * 上游每 60ms 给一块，5 块。真流式下第一个 delta 在 ~60ms 就写出去了，
   * 而「攒完再吐」的实现会让所有 delta 挤在 ~300ms 一起出现。
   */
  it('emits each delta as the upstream produces it, not at the end', async () => {
    const step = 60;
    const chunks = [0, 1, 2, 3, 4].map(
      (index) => `data: {"choices":[{"delta":{"content":"c${index}"}}]}\n\n`
    );
    global.fetch = jest.fn().mockResolvedValue(timedStreamResponse(chunks, step)) as any;

    const res = createTimingRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'k', model: 'gpt-4.1' },
      selectedProvider: 'openai',
    });

    const times = deltaTimes(res);
    expect(times).toHaveLength(5);

    // 第一块远早于最后一块：这正是「真流式」和「攒完再吐」的分界
    expect(times[0]).toBeLessThan(step * 2.5);
    expect(times[times.length - 1]).toBeGreaterThanOrEqual(step * 4);

    // 相邻 delta 的间隔应该跟着上游的 60ms，而不是 0
    const gaps = times.slice(1).map((at, index) => at - times[index]);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(step * 0.5);
  });

  it('streams structured generation the same way, with the result at the end', async () => {
    const step = 60;
    const parts = ['{"a"', ':1', '}'];
    const chunks = parts.map(
      (part) => `data: {"choices":[{"delta":{"content":${JSON.stringify(part)}}}]}\n\n`
    );
    global.fetch = jest.fn().mockResolvedValue(timedStreamResponse(chunks, step)) as any;

    const res = createTimingRes();
    await streamStructured(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'k', model: 'gpt-4.1' },
      selectedProvider: 'openai',
    }, {
      onComplete: (raw) => ({ parsed: JSON.parse(raw) }),
    });

    const times = deltaTimes(res);
    expect(times).toHaveLength(3);
    expect(times[0]).toBeLessThan(step * 2.5);

    const events = collectEvents(res);
    expect(events.find((event) => event.type === 'result')).toEqual({
      type: 'result',
      result: { parsed: { a: 1 } },
    });
    expect(events.pop()).toEqual({ type: 'done' });
  });

  /**
   * 上游无视 stream:true、直接回一整个 JSON。
   *
   * 修之前这里会发出一个空回答：按 SSE 切分找不到任何 data: 行，
   * 于是一个 delta 都没有，用户看到的是「什么都没生成」而且没有报错。
   */
  it('still delivers content when the upstream ignores stream:true', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      nonStreamingResponse({ choices: [{ message: { content: 'whole answer' } }] })
    ) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'k', model: 'gpt-4.1' },
      selectedProvider: 'openai',
    });

    expect(collectText(res)).toBe('whole answer');
    // 并且如实说明这一段不是逐字到达的，而不是假装它是
    expect(collectEvents(res)).toContainEqual({ type: 'meta', incremental: false });
  });

  it('marks a non-incremental delivery before the text, not after', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      nonStreamingResponse({ choices: [{ message: { content: 'whole answer' } }] })
    ) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'k', model: 'gpt-4.1' },
      selectedProvider: 'openai',
    });

    const types = collectEvents(res).map((event) => event.type);
    expect(types.indexOf('meta')).toBeLessThan(types.indexOf('delta'));
  });

  it('recovers content when the upstream lies about its content-type', async () => {
    // content-type 说是 event-stream，实际给的是一整个 JSON
    global.fetch = jest.fn().mockResolvedValue(
      fakeStreamResponse([JSON.stringify({ choices: [{ message: { content: 'sneaky' } }] })])
    ) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'k', model: 'gpt-4.1' },
      selectedProvider: 'openai',
    });

    expect(collectText(res)).toBe('sneaky');
    expect(collectEvents(res)).toContainEqual({ type: 'meta', incremental: false });
  });

  it('asks every provider for a stream', async () => {
    const configs: Array<[string, any]> = [
      ['deepseek', { deepSeek: { apiKey: 'k', model: 'deepseek-chat' }, selectedProvider: 'deepseek' }],
      ['openai', { openAI: { apiKey: 'k', model: 'gpt-4.1' }, selectedProvider: 'openai' }],
      ['qwen', { qwen: { apiKey: 'k', model: 'qwen-plus' }, selectedProvider: 'qwen' }],
      ['claude', { claude: { apiKey: 'k', model: 'claude-sonnet-5' }, selectedProvider: 'claude' }],
      ['ollama', { ollama: { endpoint: 'http://localhost:11434', model: 'llama3.1' }, selectedProvider: 'ollama' }],
      [
        'compatible',
        { compatible: { endpoint: 'http://localhost:1234/v1', model: 'local' }, selectedProvider: 'compatible' },
      ],
    ];

    for (const [kind, config] of configs) {
      const fetchMock = jest.fn().mockResolvedValue(fakeStreamResponse([])) as any;
      global.fetch = fetchMock;

      await streamAI(createFakeRes() as any, [{ role: 'user', content: 'hi' }], config);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect([kind, body.stream]).toEqual([kind, true]);
    }
  });

  it('reads a real stream even when a proxy mislabels it as json', async () => {
    // content-type 说 application/json，实际是逐块的 SSE。
    // 按 content-type 分派的实现会在这里整段读不出来。
    const response = fakeStreamResponse([
      'data: {"choices":[{"delta":{"content":"real"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" stream"}}]}\n\n',
    ]);
    response.headers = { get: () => 'application/json' };
    global.fetch = jest.fn().mockResolvedValue(response) as any;

    const res = createFakeRes();
    await streamAI(res as any, [{ role: 'user', content: 'hi' }], {
      openAI: { apiKey: 'k', model: 'gpt-4.1' },
      selectedProvider: 'openai',
    });

    expect(collectText(res)).toBe('real stream');
    // 它确实是流，所以不该被标成 non-incremental
    expect(collectEvents(res)).not.toContainEqual({ type: 'meta', incremental: false });
  });

  it('never sends more than one system message, and always first', async () => {
    const configs: Array<[string, any]> = [
      ['deepseek', { deepSeek: { apiKey: 'k', model: 'deepseek-chat' }, selectedProvider: 'deepseek' }],
      ['openai', { openAI: { apiKey: 'k', model: 'gpt-4.1' }, selectedProvider: 'openai' }],
      ['qwen', { qwen: { apiKey: 'k', model: 'qwen-plus' }, selectedProvider: 'qwen' }],
      ['ollama', { ollama: { endpoint: 'http://localhost:11434', model: 'llama3.1' }, selectedProvider: 'ollama' }],
      [
        'compatible',
        { compatible: { endpoint: 'http://localhost:1234/v1', model: 'qwen3-8b' }, selectedProvider: 'compatible' },
      ],
    ];

    // 这正是 ai-chat / engineering-chat 以前发出去的形状：两条 system
    const messages: any = [
      { role: 'system', content: 'persona' },
      { role: 'system', content: 'workspace context' },
      { role: 'user', content: 'hi' },
    ];

    for (const [kind, config] of configs) {
      const fetchMock = jest.fn().mockResolvedValue(fakeStreamResponse([])) as any;
      global.fetch = fetchMock;

      await streamAI(createFakeRes() as any, messages, config);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const roles = body.messages.map((message: any) => message.role);
      expect([kind, roles.filter((role: string) => role === 'system').length]).toEqual([kind, 1]);
      expect([kind, roles[0]]).toEqual([kind, 'system']);
      expect([kind, body.messages[0].content]).toEqual([kind, 'persona\n\nworkspace context']);
    }
  });

  /**
   * buildRequest 有三个入口：callAI（非流式）、streamAI、streamStructured。
   * 规整必须留在 buildRequest 里 —— 只在 streamAI 里做的话，生成类接口
   * （出题、生成工程题、AI 评审）会在本地模型上重新踩回同一个 400。
   */
  it('normalises on the structured-stream path too, not just chat', async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeStreamResponse([])) as any;
    global.fetch = fetchMock;

    await streamStructured(createFakeRes() as any, [
      { role: 'system', content: 'persona' },
      { role: 'system', content: 'schema' },
      { role: 'user', content: 'make one' },
    ], {
      compatible: { endpoint: 'http://localhost:1234/v1', model: 'qwen3-8b' },
      selectedProvider: 'compatible',
    }, { onComplete: async () => ({ ok: true }) });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages.filter((message: any) => message.role === 'system')).toHaveLength(1);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'persona\n\nschema' });
  });

  it('normalises on the non-streaming path too', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'done' } }] }),
    }) as any;
    global.fetch = fetchMock;

    await callAI(
      [
        { role: 'system', content: 'persona' },
        { role: 'system', content: 'context' },
        { role: 'user', content: 'hi' },
      ],
      { openAI: { apiKey: 'k', model: 'gpt-4.1' }, selectedProvider: 'openai' }
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages.filter((message: any) => message.role === 'system')).toHaveLength(1);
    expect(body.stream).toBe(false);
  });

  it('keeps Claude on its separate system field', async () => {
    const fetchMock = jest.fn().mockResolvedValue(fakeStreamResponse([])) as any;
    global.fetch = fetchMock;

    await streamAI(
      createFakeRes() as any,
      [
        { role: 'system', content: 'persona' },
        { role: 'system', content: 'context' },
        { role: 'user', content: 'hi' },
      ],
      { claude: { apiKey: 'k', model: 'claude-sonnet-5' }, selectedProvider: 'claude' }
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.system).toBe('persona\n\ncontext');
    expect(body.messages.every((message: any) => message.role !== 'system')).toBe(true);
  });

  it('streams raw text when format is text', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      fakeStreamResponse(['data: {"choices":[{"delta":{"content":"const a = 1;"}}]}\n\n'])
    ) as any;

    const res = createFakeRes();
    await streamAI(
      res as any,
      [{ role: 'user', content: 'hi' }],
      { openAI: { apiKey: 'k', model: 'gpt-4.1' }, selectedProvider: 'openai' },
      { format: 'text' }
    );

    expect(res.written.join('')).toBe('const a = 1;');
    expect(res.headers?.['Content-Type']).toContain('text/plain');
  });
});
