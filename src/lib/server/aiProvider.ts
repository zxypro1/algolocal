/**
 * 服务端共享的 AI provider 抽象
 *
 * 一处收敛三件事：
 * 1. **选 provider** —— 显式指定或按可用性自动挑；
 * 2. **模型能力差异** —— 新一代推理模型（OpenAI o 系列 / GPT-5、DeepSeek reasoner）
 *    不再接受 `max_tokens`、也不接受自定义 temperature，参数发错会直接 400；
 * 3. **流式转发** —— 统一成一种 SSE 事件流，让前端能区分「正文」和「中途出错」，
 *    并且客户端断开时把上游请求一起 abort 掉，不再白烧 token。
 */
import type { NextApiResponse } from 'next';
import { guardedFetch } from './endpointPolicy';
import { isPrivateHostname } from '../endpointHosts';
import {
  capabilitiesFor,
  DEFAULT_MODELS,
  ModelCapabilities,
  ProviderKind,
} from '../aiModels';

export interface AIProviderConfig {
  deepSeek?: { apiKey: string; model: string; timeout?: string; maxTokens?: string };
  openAI?: { apiKey: string; model: string };
  qwen?: { apiKey: string; model: string };
  claude?: { apiKey: string; model: string };
  ollama?: { endpoint: string; model: string };
  /** 任意 OpenAI 兼容端点：LM Studio、vLLM、LocalAI、llama.cpp server… */
  compatible?: { endpoint: string; model: string; apiKey?: string };
  selectedProvider?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export type { ProviderKind, ModelCapabilities };
export { capabilitiesFor, DEFAULT_MODELS, SUGGESTED_MODELS } from '../aiModels';

/** 选定的 provider + 该模型的参数能力 */
export interface ResolvedProvider {
  kind: ProviderKind;
  model: string;
  apiKey?: string;
  endpoint?: string;
  maxTokens: number;
  capabilities: ModelCapabilities;
}

export class NoProviderError extends Error {
  constructor(message = 'No AI provider is configured. Please configure one in Settings.') {
    super(message);
    this.name = 'NoProviderError';
  }
}

/** 用户明确选了某个厂商，但它缺凭据 */
export class SelectedProviderUnavailableError extends NoProviderError {
  constructor(kind: string) {
    super(`The selected AI provider "${kind}" has no API key configured. Add one in Settings, or switch the provider to Auto.`);
    this.name = 'SelectedProviderUnavailableError';
  }
}

/**
 * 把用户填的地址规整成 OpenAI 风格的 base URL。
 *
 * 只在「对方只给了 host:port、完全没有路径」时补 /v1 —— LM Studio 的地址
 * 写成 http://localhost:1234 和 http://localhost:1234/v1 的人一样多。
 * 一旦用户明确写了路径就原样尊重，因为不是所有兼容服务都挂在 /v1 下。
 */
export function normalizeCompatibleEndpoint(raw: string): string {
  let trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;

  // 少了协议头就补一个。注意不能直接丢给 new URL：
  // 'localhost:1234' 会被解析成协议 "localhost:"、路径 "1234"，
  // 于是既补不上 /v1，最后 fetch 还会因为未知协议报一个看不懂的错。
  //
  // 补什么取决于地址指向哪：本地服务基本都是明文 http，而远程主机补 http
  // 等于把 API Key 明文发出去，所以默认 https。写全了协议的一律照原样。
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    const hostPart = trimmed.split('/')[0].replace(/:\d+$/, '');
    trimmed = `${isPrivateHostname(hostPart) ? 'http' : 'https'}://${trimmed}`;
  }

  try {
    const url = new URL(trimmed);
    if (url.pathname === '' || url.pathname === '/') {
      return `${url.origin}/v1`;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    // 实在解析不了就原样返回，让请求自己报错 —— 那个错误信息比这里瞎猜更有用
    return trimmed;
  }
}

const AUTO_ORDER: ProviderKind[] = ['deepseek', 'openai', 'qwen', 'claude', 'ollama', 'compatible'];

export function resolveProvider(config?: AIProviderConfig, maxTokens = 4000): ResolvedProvider {
  const build = (
    kind: ProviderKind,
    fields: { apiKey?: string; endpoint?: string; model?: string; maxTokens?: number }
  ): ResolvedProvider => {
    const model = fields.model || DEFAULT_MODELS[kind];
    return {
      kind,
      model,
      apiKey: fields.apiKey,
      endpoint: fields.endpoint,
      maxTokens: fields.maxTokens || maxTokens,
      capabilities: capabilitiesFor(kind, model),
    };
  };

  const candidates: Record<ProviderKind, ResolvedProvider | null> = {
    deepseek: (config?.deepSeek?.apiKey || process.env.DEEPSEEK_API_KEY)
      ? build('deepseek', {
          apiKey: config?.deepSeek?.apiKey || process.env.DEEPSEEK_API_KEY,
          model: config?.deepSeek?.model || process.env.DEEPSEEK_MODEL,
          maxTokens: Number(config?.deepSeek?.maxTokens) || undefined,
        })
      : null,
    openai: (config?.openAI?.apiKey || process.env.OPENAI_API_KEY)
      ? build('openai', {
          apiKey: config?.openAI?.apiKey || process.env.OPENAI_API_KEY,
          model: config?.openAI?.model || process.env.OPENAI_MODEL,
        })
      : null,
    qwen: (config?.qwen?.apiKey || process.env.QWEN_API_KEY)
      ? build('qwen', {
          apiKey: config?.qwen?.apiKey || process.env.QWEN_API_KEY,
          model: config?.qwen?.model || process.env.QWEN_MODEL,
        })
      : null,
    claude: (config?.claude?.apiKey || process.env.CLAUDE_API_KEY)
      ? build('claude', {
          apiKey: config?.claude?.apiKey || process.env.CLAUDE_API_KEY,
          model: config?.claude?.model || process.env.CLAUDE_MODEL,
        })
      : null,
    ollama: (config?.ollama?.model || process.env.OLLAMA_MODEL)
      ? build('ollama', {
          endpoint: config?.ollama?.endpoint || process.env.OLLAMA_ENDPOINT || 'http://localhost:11434',
          model: config?.ollama?.model || process.env.OLLAMA_MODEL,
        })
      : null,
    // 只有端点没有模型时不算「配好了」：模型 id 由对端决定，猜不出来。
    // 这里返回 null，让它在 auto 顺序里被跳过；用户显式选了它则会收到
    // SelectedProviderUnavailableError，提示去设置页补上。
    compatible: (config?.compatible?.endpoint || process.env.OPENAI_COMPATIBLE_ENDPOINT)
      && (config?.compatible?.model || process.env.OPENAI_COMPATIBLE_MODEL)
      ? build('compatible', {
          endpoint: normalizeCompatibleEndpoint(
            config?.compatible?.endpoint || process.env.OPENAI_COMPATIBLE_ENDPOINT || ''
          ),
          model: config?.compatible?.model || process.env.OPENAI_COMPATIBLE_MODEL,
          // 本地服务通常不校验 key，所以它是可选的；填了就照常带上，
          // 这样同一个 provider 也能连需要鉴权的自建网关。
          apiKey: config?.compatible?.apiKey || process.env.OPENAI_COMPATIBLE_API_KEY,
        })
      : null,
  };

  const selected = (config?.selectedProvider || 'auto') as ProviderKind | 'auto';
  if (selected !== 'auto') {
    // 选定的厂商没配好就直接报错。之前这里会静默回落到 AUTO_ORDER 的第一个可用项，
    // 于是「我选了 Claude」的用户，代码和提示词被发去了 DeepSeek，还计在另一把 key 上。
    if (!candidates[selected]) throw new SelectedProviderUnavailableError(selected);
    return candidates[selected]!;
  }

  for (const kind of AUTO_ORDER) {
    if (candidates[kind]) return candidates[kind]!;
  }

  throw new NoProviderError();
}

/* ------------------------------------------------------------------ */
/* 请求构造                                                            */
/* ------------------------------------------------------------------ */

interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** OpenAI 兼容格式：DeepSeek、Qwen（compatible-mode）、OpenAI 自己都走这套 */
function openAiCompatibleBody(
  provider: ResolvedProvider,
  messages: ChatMessage[],
  options: { stream: boolean; temperature: number }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    stream: options.stream,
    [provider.capabilities.maxTokensParam]: provider.maxTokens,
  };
  if (provider.capabilities.supportsTemperature) body.temperature = options.temperature;
  if (options.stream) body.stream_options = { include_usage: false };
  return body;
}

function buildRequest(
  provider: ResolvedProvider,
  messages: ChatMessage[],
  options: { stream: boolean; temperature: number }
): UpstreamRequest {
  switch (provider.kind) {
    case 'deepseek':
      return {
        url: 'https://api.deepseek.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: openAiCompatibleBody(provider, messages, options),
      };

    case 'openai':
      return {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: openAiCompatibleBody(provider, messages, options),
      };

    case 'qwen':
      // DashScope 的 OpenAI 兼容端点：比旧的 /api/v1/services/aigc/... 多了流式支持
      return {
        url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: openAiCompatibleBody(provider, messages, options),
      };

    case 'claude': {
      const system = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          // Anthropic 只认 x-api-key，不要再带 Authorization
          'x-api-key': provider.apiKey || '',
          'anthropic-version': '2023-06-01',
        },
        body: {
          model: provider.model,
          system: system || undefined,
          messages: messages.filter((message) => message.role !== 'system'),
          temperature: options.temperature,
          max_tokens: provider.maxTokens,
          stream: options.stream,
        },
      };
    }

    case 'compatible':
      return {
        url: `${provider.endpoint}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          // 本地服务大多不看这个头，带上空 key 反而可能被某些实现拒绝，所以没填就不带
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        },
        body: openAiCompatibleBody(provider, messages, options),
      };

    case 'ollama':
      return {
        url: `${provider.endpoint}/api/chat`,
        headers: { 'Content-Type': 'application/json' },
        body: {
          model: provider.model,
          messages,
          stream: options.stream,
          options: { temperature: options.temperature },
        },
      };
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

async function fetchUpstream(
  request: UpstreamRequest,
  signal?: AbortSignal,
  /**
   * 地址是不是用户填的。只有 compatible 是 —— 其余厂商的 URL 写死在代码里，
   * 拿它们过内网策略只会误伤（Ollama 的默认地址就是 127.0.0.1）。
   */
  userSuppliedUrl = false
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  // 客户端断开 -> 连带取消上游，不再为没人看的回答付费
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    // 聊天请求打的是同一个用户填的地址，所以 SSRF 面不只是「列模型」那个路由；
    // guardedFetch 会逐跳校验重定向。
    const send = userSuppliedUrl ? guardedFetch : fetch;
    const response = await send(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`AI provider error ${response.status}: ${detail.slice(0, 500)}`);
    }

    return response;
  } finally {
    clearTimeout(timer);
  }
}

function extractContent(kind: ProviderKind, data: any): string {
  switch (kind) {
    case 'deepseek':
    case 'openai':
    case 'qwen':
    case 'compatible':
      return data?.choices?.[0]?.message?.content || '';
    case 'claude':
      return (data?.content || [])
        .filter((block: any) => block?.type === 'text')
        .map((block: any) => block.text)
        .join('');
    case 'ollama':
      return data?.message?.content || '';
  }
}

/** 一次性拿到完整回复 */
export async function callAI(
  messages: ChatMessage[],
  config?: AIProviderConfig,
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const provider = resolveProvider(config, options.maxTokens ?? 4000);
  const request = buildRequest(provider, messages, {
    stream: false,
    temperature: options.temperature ?? 0.7,
  });
  const response = await fetchUpstream(request, options.signal, provider.kind === 'compatible');
  return extractContent(provider.kind, await response.json());
}

/* ------------------------------------------------------------------ */
/* 流式                                                                */
/* ------------------------------------------------------------------ */

function parseChunk(kind: ProviderKind, payload: string): string {
  try {
    const json = JSON.parse(payload);
    if (kind === 'claude') {
      // content_block_delta -> delta.text
      return json?.delta?.text || '';
    }
    return json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? '';
  } catch {
    return '';
  }
}

async function pipeUpstream(
  kind: ProviderKind,
  upstream: Response,
  onChunk: (text: string) => void
): Promise<void> {
  const reader = upstream.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    if (kind === 'ollama') {
      // Ollama 是 NDJSON，不是 SSE
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json?.message?.content) onChunk(json.message.content);
          if (json?.done) return;
        } catch {
          // 半行，等下一批
        }
      }
      continue;
    }

    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const event of events) {
      for (const line of event.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        const text = parseChunk(kind, payload);
        if (text) onChunk(text);
      }
    }
  }
}

export type StreamFormat = 'sse' | 'text';

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  /**
   * 'sse'  —— 带类型的事件流，前端可以区分正文与中途出错（推荐）
   * 'text' —— 裸文本，给直接把输出灌进编辑器的老接口用
   */
  format?: StreamFormat;
  signal?: AbortSignal;
}

function writeHeaders(res: NextApiResponse, format: StreamFormat): void {
  if (res.headersSent) return;
  res.writeHead(200, {
    'Content-Type': format === 'sse' ? 'text/event-stream; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 避免反向代理缓冲导致「一次性吐出来」
    'X-Accel-Buffering': 'no',
  });
  (res as any).flushHeaders?.();
}

function sseEvent(res: NextApiResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * 把回复流式写给前端。
 *
 * 关键点：**头一旦发出去就没法再改状态码了**，所以中途出错不能靠 HTTP 状态表达，
 * 必须作为一个 error 事件写进流里——这正是 'sse' 格式存在的理由。
 */
export async function streamAI(
  res: NextApiResponse,
  messages: ChatMessage[],
  config?: AIProviderConfig,
  options: StreamOptions = {}
): Promise<void> {
  const format = options.format ?? 'sse';
  const provider = resolveProvider(config, options.maxTokens ?? 4000);
  const temperature = options.temperature ?? 0.7;

  const emit = (text: string) => {
    if (format === 'sse') sseEvent(res, { type: 'delta', text });
    else res.write(text);
  };

  try {
    if (!provider.capabilities.supportsStreaming) {
      const text = await callAI(messages, config, options);
      writeHeaders(res, format);
      emit(text);
    } else {
      const upstream = await fetchUpstream(
        buildRequest(provider, messages, { stream: true, temperature }),
        options.signal,
        provider.kind === 'compatible'
      );
      writeHeaders(res, format);
      await pipeUpstream(provider.kind, upstream, emit);
    }

    if (format === 'sse') sseEvent(res, { type: 'done' });
    res.end();
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError' || options.signal?.aborted;
    if (aborted) {
      // 客户端已经走了，安静收尾
      res.end();
      return;
    }

    const message = (error as Error).message || 'AI request failed';
    if (!res.headersSent) {
      res.status(500).json({ error: message });
      return;
    }
    if (format === 'sse') sseEvent(res, { type: 'error', message });
    else res.write(`\n\n[error] ${message}`);
    res.end();
  }
}

/** 把 API route 的响应生命周期接到 AbortSignal 上 */
export function abortSignalFor(res: NextApiResponse): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

/* ------------------------------------------------------------------ */

/**
 * 从模型回复里抠出 JSON。
 * 模型经常会加 ```json 围栏或前后寒暄，这里做一次尽力而为的提取。
 */
/**
 * 从模型回复里取出 JSON。
 *
 * 难点在于我们要的 JSON 内部**本来就带着 markdown 和代码块**（题面、mermaid 架构图、
 * 参考实现都是提示词明确要求的）。所以：
 *  1. 先直接 parse，多数模型本来就只回 JSON；
 *  2. 再按围栏取，但要取「最外层」—— 懒惰匹配会在内嵌代码块的第一个 ``` 处截断，
 *     把一段 ts 片段当成整个回复；
 *  3. 最后退回到第一个 { 到最后一个 } 之间。
 */
export function extractJson<T = unknown>(raw: string): T {
  const text = (raw || '').trim();

  const candidates: string[] = [text];

  const fenceStart = text.match(/```(?:json)?[^\S\n]*\n?/);
  if (fenceStart) {
    const bodyStart = (fenceStart.index ?? 0) + fenceStart[0].length;
    const lastFence = text.lastIndexOf('```');
    if (lastFence > bodyStart) candidates.push(text.slice(bodyStart, lastFence).trim());
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // 试下一个
    }
  }

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as T;
      } catch {
        // 试下一个
      }
    }
  }

  throw new Error('The model did not return valid JSON');
}
