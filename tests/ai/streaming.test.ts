/**
 * 流式协议的两端测试
 *
 * 服务端：各家上游的分块格式 -> 统一 SSE 事件
 * 客户端：SSE 事件 -> 文本，重点是任意位置切分的分块
 */
import { createSseParser, parseSseLine } from '../../src/lib/chatStreamProtocol';
import { streamAI } from '../../src/lib/server/aiProvider';

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

  it('reports upstream failure as JSON before headers are sent', async () => {
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

    expect(res.statusCode).toBe(500);
    expect((res.jsonBody as any).error).toMatch(/401/);
    expect(res.written).toHaveLength(0);
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
