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
import { describeNetworkError, EndpointPolicyError, guardedFetch } from './endpointPolicy';
import { looksLikeMarkup, readableErrorBody } from '../errorBody';
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

/**
 * 把消息规整成「至多一条 system，而且在最前面」。
 *
 * 这不是给某个后端打的补丁，是**开放权重模型的 chat 模板普遍要求**：
 * Qwen 等模型的 Jinja 模板里写着 `raise_exception('System message must be at
 * the beginning.')`，llama.cpp / LM Studio / Ollama 走模板渲染时会原样抛出来，
 * 变成一个 400。llama.cpp 把这视为模板的既定行为而不是 bug（#20733 closed as
 * not planned），也就是说客户端本来就该保证这个前提。
 *
 * 托管 API（OpenAI、DeepSeek）接受多条 system、也接受它出现在中间，所以同一份
 * 代码在它们那里一直是好的 —— 这正是这个 bug 只在本地模型上暴露的原因。
 *
 * 我们自己的路由从来只在开头放 system（只是放了两条：一条人设、一条上下文），
 * 所以这里把它们按顺序拼成一条，语义不变。
 */
export function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];

  for (const message of messages) {
    // messages 是请求体里来的，路由只校验了它是个数组。这里读到的每个字段
    // 都可能不是字符串，甚至不是对象 —— 让 .trim() 抛 TypeError 只会变成
    // 一个内部错误的 500，还不如把这条丢掉。
    if (!message || typeof message !== 'object') continue;
    // role 没写或者写了个我们不认识的值，转发上去只会换来一个看不懂的 400
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') continue;
    // content 不是字符串就当它不存在。硬转出来的 "[object Object]" 会原样
    // 变成模型看到的提示词，比少一条消息更糟。
    const content = typeof message.content === 'string' ? message.content : '';

    if (message.role === 'system') {
      if (content.trim()) systemParts.push(content.trim());
      continue;
    }

    /*
     * 空的 user/assistant 也要丢掉。
     *
     * 一次失败的请求会在对话历史里留下一条**空的** assistant 消息（内容还没
     * 流出来就断了），下一次发送会把它一起带上。Anthropic 直接拒绝空的
     * content block，一部分 chat 模板也一样 —— 于是一次偶发失败会把整个
     * 会话钉死，用户只能关掉对话框重开。
     */
    if (!content.trim()) continue;

    // 丢掉空消息可能让两条同角色的消息挨在一起（user, assistant(空), user）。
    // Anthropic 要求角色交替，所以这里把它们并成一条，而不是留个坑给上游。
    const previous = rest[rest.length - 1];
    if (previous && previous.role === message.role) {
      rest[rest.length - 1] = { ...previous, content: `${previous.content}\n\n${content}` };
      continue;
    }

    rest.push({ ...message, content });
  }

  if (systemParts.length === 0) return rest;
  return [{ role: 'system', content: systemParts.join('\n\n') }, ...rest];
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
  rawMessages: ChatMessage[],
  options: { stream: boolean; temperature: number }
): UpstreamRequest {
  // 所有 provider 共用同一份规整：system 合成一条、放最前
  const messages = normalizeMessages(rawMessages);

  // 规整之后一条对话都不剩（全是空消息，或者本来就没发）。发上去只会换回一个
  // 各家措辞不同的 400，不如自己说清楚。
  if (!messages.some((message) => message.role !== 'system')) {
    throw new EmptyConversationError();
  }

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
      // normalizeMessages 保证了：要么没有 system，要么就是唯一一条、在 index 0
      const system = messages[0]?.role === 'system' ? messages[0].content : '';
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
          messages: system ? messages.slice(1) : messages,
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
/** 正文两块之间最多能停多久 —— 本地模型慢是常态，卡死不是 */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * 上游明确拒绝了这次请求。
 *
 * 它和「我们自己挂了」是两件事，所以要带着上游的状态码往外传：
 * 端点填错、key 过期、模型名不存在、超出上下文长度，用户看到 400/401/404
 * 才知道该去改什么；一律报 500 只会让人以为是应用坏了。
 */
export class AIUpstreamError extends Error {
  /** 上游返回的状态码 */
  upstreamStatus: number;
  /** 转给客户端用的状态码：上游的 4xx 照传，5xx 归一成 502 */
  status: number;

  constructor(message: string, upstreamStatus: number) {
    super(message);
    this.name = 'AIUpstreamError';
    this.upstreamStatus = upstreamStatus;
    this.status = upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 502;
  }
}

/**
 * 根本没连上上游：服务没起、端口写错、域名解析不了、证书不受信任。
 *
 * 和上游返回 4xx 一样，这也是「要改的是配置」，只不过失败发生在更早的一层。
 */
export class AINetworkError extends Error {
  status = 502;

  constructor(message: string) {
    super(message);
    this.name = 'AINetworkError';
  }
}

/** 规整之后没有任何一条真正的对话消息 */
export class EmptyConversationError extends Error {
  status = 400;

  constructor() {
    super('There is nothing to send: the conversation has no message with any content.');
    this.name = 'EmptyConversationError';
  }
}

/**
 * 上游 200 了，但一个字都没有。
 *
 * 空回答不能当成成功：界面上是一个空白气泡 —— 没内容、没报错、连重试按钮
 * 都不亮，用户看不出发生了什么。本地模型上这通常意味着它被换出去了、
 * 上下文塞满了，或者模板渲染出了一段我们解析不了的东西。
 */
export class AIEmptyResponseError extends Error {
  status = 502;

  constructor(origin: string) {
    super(
      `${origin} returned an empty response. If it is a local model, check its own log — it may have run out of context or unloaded the model.`
    );
    this.name = 'AIEmptyResponseError';
  }
}

/**
 * 上游在超时窗口内没有回应。
 *
 * 它必须和「客户端自己走了」区分开：两者都是 AbortError，但前者要告诉用户，
 * 后者只需要安静收尾。混在一起的后果是，一次超时会变成一个空白的回答气泡 ——
 * 没有报错、没有内容，用户等了两分钟什么也没得到。
 */
export class AITimeoutError extends Error {
  status = 504;

  constructor(message: string) {
    super(message);
    this.name = 'AITimeoutError';
  }
}

/** 该用哪个状态码回给客户端 */
export function statusForError(error: unknown): number {
  if (error instanceof AIUpstreamError) return error.status;
  if (error instanceof AITimeoutError || error instanceof AINetworkError) return error.status;
  if (error instanceof AIEmptyResponseError || error instanceof EmptyConversationError) return error.status;
  if (error instanceof EndpointPolicyError) return error.status;
  // 没配 provider 属于「请求缺前提」，不是服务端故障
  if (error instanceof NoProviderError) return 400;
  return 500;
}

/**
 * 从上游的错误响应体里抠出一句人能读的话。
 *
 * 各家的形状不一样：OpenAI 兼容端点是 { error: { message } }，
 * Ollama 是 { error: "..." }，还有直接回一段文本的。
 * 抠不出来就退回截断后的原文 —— 那也比一个纯粹的 500 强。
 */
function describeUpstreamError(status: number, body: string): string {
  const text = (body || '').trim();
  if (!text) return `The AI endpoint returned ${status} with an empty body.`;

  try {
    const parsed = JSON.parse(text);
    const message =
      (typeof parsed?.error === 'string' && parsed.error) ||
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.detail;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch {
    // 不是 JSON，按纯文本处理
  }

  // 代理和框架的错误页是 HTML。把几百个字符的标签塞进错误提示里，用户看到的
  // 是一屏 <html><head><title>502 Bad Gateway —— 状态码才是有用的那部分。
  if (looksLikeMarkup(text)) {
    return `The AI endpoint returned ${status} with an HTML error page, not JSON. Check that the endpoint URL points at the API and not at a web page.`;
  }

  // 和客户端共用同一把尺子，免得一边转发、一边丢弃
  return readableErrorBody(text) || `The AI endpoint returned ${status}.`;
}

/**
 * 这个错误是不是「网络层没接上/断了」。
 *
 * 注意不能只看有没有 code：abort 抛的是 DOMException，它带着遗留的
 * 数字 code 20，会把「用户关掉了对话框」误判成一次网络故障。
 */
function isTransportFailure(error: unknown): boolean {
  if ((error as Error)?.name === 'AbortError') return false;
  const code = (error as any)?.cause?.code || (error as any)?.code;
  if (typeof code === 'string') return true;
  return /fetch failed|terminated|socket hang up/i.test((error as Error)?.message || '');
}

/**
 * 正文读到一半断了，同样要翻译。
 *
 * 这一段发生在响应头之后，所以走不到 fetchUpstream 里那个分支 —— 本地模型
 * 生成到一半被 OOM 杀掉时，用户看到的原本只有一个词：terminated。
 */
function translateStreamFailure(error: unknown, origin: string): unknown {
  if (error instanceof AITimeoutError || error instanceof AINetworkError) return error;
  if (!isTransportFailure(error)) return error;
  return new AINetworkError(describeNetworkError(error, origin));
}

/** 只取协议 + 主机，错误提示里没必要出现完整路径 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

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
  // 超时和「客户端走了」都会 abort 同一个 controller，但后面要分别处理，
  // 所以这里自己记一笔 —— AbortError 本身分不出是谁触发的。
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DEFAULT_TIMEOUT_MS);
  // 客户端断开 -> 连带取消上游，不再为没人看的回答付费
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    // 聊天请求打的是同一个用户填的地址，所以 SSRF 面不只是「列模型」那个路由；
    // guardedFetch 会逐跳校验重定向。
    const send = userSuppliedUrl ? guardedFetch : fetch;
    let response: Response;
    try {
      response = await send(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch (error) {
      const origin = originOf(request.url);
      if (timedOut) {
        throw new AITimeoutError(
          describeNetworkError({ name: 'AbortError' }, origin, DEFAULT_TIMEOUT_MS)
        );
      }
      // 客户端自己走了：原样往上抛，让调用方安静收尾。
      // 这一步必须在传输层判断之前 —— abort 抛的 DOMException 带着遗留的
      // 数字 code 20，按「有 code 就是传输失败」判会把它误报成 502。
      if ((error as Error)?.name === 'AbortError') throw error;
      // 连都没连上：服务没起、端口写错、域名解析不了、证书不受信任。这是本地
      // 模型场景里最常见的一类失败，不该以「fetch failed」的形式露出来。
      // 只翻译传输层失败 —— endpointPolicy 的拦截理由本身就是给人看的，别再包一层。
      if (isTransportFailure(error)) throw new AINetworkError(describeNetworkError(error, origin));
      throw error;
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new AIUpstreamError(describeUpstreamError(response.status, detail), response.status);
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

/**
 * 把上游的流转成一次次 onChunk。
 *
 * 无论上游自称什么 content-type，这里一律**按流读**：一个真的流被代理标成
 * application/json 是常有的事，而按 content-type 分派会让那种情况彻底读不出内容。
 * 「上游其实没给流」由收尾时的兜底解析发现 —— 那时一条 delta 都还没发出去，
 * 所以事件顺序（meta 先于正文）依然成立。
 *
 * @returns 是否真的是逐块到达的。false 表示上游无视了 stream:true，
 *          整段内容是一次性拿到的 —— 调用方要如实告诉前端。
 */
interface PipeResult {
  /** 是不是逐块到达的。false 表示上游无视了 stream:true */
  incremental: boolean;
  /** 有没有拿到任何内容。false 表示这次回答是空的 */
  delivered: boolean;
}

async function pipeUpstream(
  kind: ProviderKind,
  upstream: Response,
  onChunk: (text: string) => void,
  /** 确认上游不是流时先回调一次，永远早于第一次 onChunk */
  onNotIncremental: () => void = () => undefined,
  /** 报错时用得上：是哪个地址停住了 */
  origin = 'the AI endpoint'
): Promise<PipeResult> {
  const reader = upstream.body?.getReader();
  if (!reader) return { incremental: false, delivered: false };

  /**
   * 响应头到手之后，fetchUpstream 的超时定时器就清掉了 —— 但正文可能才是卡住
   * 的那一段：本地模型加载权重、被 OOM 杀掉、或者干脆不吐 token。没有这道
   * 看门狗的话，连接会一直开着，界面上就是一个永远转下去的圈。
   */
  const readNext = async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new AITimeoutError(
              `${origin} stopped sending data for ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s. If it is a local model, check its own log.`
            )),
            STREAM_IDLE_TIMEOUT_MS
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  /** 一条都没发出去之前，把原文留着，收尾时再兜底解析一次 */
  let rawSoFar = '';
  let emitted = false;
  const emit = (text: string) => {
    emitted = true;
    onChunk(text);
  };

  while (true) {
    const { done, value } = await readNext();
    if (done) break;
    const decoded = decoder.decode(value, { stream: true });
    if (!emitted) rawSoFar += decoded;
    buffer += decoded;

    if (kind === 'ollama') {
      // Ollama 是 NDJSON，不是 SSE
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json?.message?.content) emit(json.message.content);
          if (json?.done) return { incremental: emitted, delivered: emitted };
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
        if (text) emit(text);
      }
    }
  }

  if (emitted) return { incremental: true, delivered: true };

  /**
   * 走到这里说明整条流读完了，一个 delta 都没解析出来。
   * 常见原因：上游无视了 stream:true，回的其实是一整个 JSON。
   * 与其交出一个空回答，不如把内容捞出来 —— 但要如实报告它不是流。
   */
  const tail = rawSoFar + decoder.decode();
  try {
    const text = extractContent(kind, JSON.parse(tail.trim()));
    if (text) {
      onNotIncremental();
      onChunk(text);
      return { incremental: false, delivered: true };
    }
  } catch {
    // 真的什么都解析不出来，交给上层按空回复处理
  }
  return { incremental: false, delivered: false };
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

/**
 * 写一段并立刻推出去。
 *
 * `flush` 只有在响应被压缩中间件包过时才存在（compression 会把 write 攒进
 * gzip 缓冲区，不 flush 就要等缓冲满或流结束）。当前的部署形态下它不存在，
 * 这一行是给「哪天前面多了一层压缩」准备的：漏掉它的表现正是所有块一起到达。
 */
function writeNow(res: NextApiResponse, chunk: string): void {
  res.write(chunk);
  (res as unknown as { flush?: () => void }).flush?.();
}

function sseEvent(res: NextApiResponse, payload: unknown): void {
  writeNow(res, `data: ${JSON.stringify(payload)}\n\n`);
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
    else writeNow(res, text);
  };

  /**
   * 这一段不是逐字来的，就明说。
   *
   * 假流式的本质不是「一次性到达」——上游不给流我们也变不出来——
   * 而是**假装**它是逐字到达的。前端拿到这个事件可以照实提示用户。
   */
  const declareNotIncremental = () => {
    if (format === 'sse') sseEvent(res, { type: 'meta', incremental: false });
  };

  try {
    if (!provider.capabilities.supportsStreaming) {
      const text = await callAI(messages, config, options);
      writeHeaders(res, format);
      declareNotIncremental();
      emit(text);
    } else {
      const request = buildRequest(provider, messages, { stream: true, temperature });
      const upstream = await fetchUpstream(request, options.signal, provider.kind === 'compatible');
      writeHeaders(res, format);
      const piped = await pipeUpstream(
        provider.kind,
        upstream,
        emit,
        declareNotIncremental,
        originOf(request.url)
      ).catch((error) => {
        throw translateStreamFailure(error, originOf(request.url));
      });
      // 空回答按失败报，别交出一个没有内容也没有解释的气泡
      if (!piped.delivered) throw new AIEmptyResponseError(originOf(request.url));
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
      // 上游拒绝了就把它的状态码传下去：400 是「请求不对」，不是「我们挂了」
      res.status(statusForError(error)).json({ error: message });
      return;
    }
    if (format === 'sse') sseEvent(res, { type: 'error', message });
    else res.write(`\n\n[error] ${message}`);
    res.end();
  }
}

export interface StructuredStreamOptions<T> extends Omit<StreamOptions, 'format'> {
  /**
   * 流结束之后拿完整原文做的事：解析、校验、落库，返回要发给前端的结果。
   * 抛错会变成流里的 error 事件（附带 details，前端可以拿原文兜底）。
   */
  onComplete: (raw: string) => Promise<unknown> | unknown;
}

export class StructuredStreamError extends Error {
  details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'StructuredStreamError';
    this.details = details;
  }
}

/**
 * 生成类接口的流式版本。
 *
 * 这类接口最终要的是结构化结果（题目、项目、评审），但**没有理由让用户对着
 * 转圈等一分钟**：模型的原文照样可以边写边看，结构化结果在流的末尾发一次。
 *
 * 正文走 delta，结果走 result —— 前端两样都能拿到，不必二选一。
 */
export async function streamStructured<T>(
  res: NextApiResponse,
  messages: ChatMessage[],
  config: AIProviderConfig | undefined,
  options: StructuredStreamOptions<T>
): Promise<void> {
  const provider = resolveProvider(config, options.maxTokens ?? 4000);
  const temperature = options.temperature ?? 0.7;
  let raw = '';

  try {
    let incremental = true;
    if (!provider.capabilities.supportsStreaming) {
      raw = await callAI(messages, config, options);
      writeHeaders(res, 'sse');
      incremental = false;
      sseEvent(res, { type: 'meta', incremental: false });
      sseEvent(res, { type: 'delta', text: raw });
    } else {
      const request = buildRequest(provider, messages, { stream: true, temperature });
      const upstream = await fetchUpstream(request, options.signal, provider.kind === 'compatible');
      writeHeaders(res, 'sse');
      const piped = await pipeUpstream(
        provider.kind,
        upstream,
        (text) => {
          raw += text;
          sseEvent(res, { type: 'delta', text });
        },
        () => sseEvent(res, { type: 'meta', incremental: false }),
        originOf(request.url)
      ).catch((error) => {
        throw translateStreamFailure(error, originOf(request.url));
      });
      incremental = piped.incremental;
      if (!piped.delivered) throw new AIEmptyResponseError(originOf(request.url));
    }
    void incremental;

    // 到这里正文已经全部发出去了，剩下的是解析和落库
    const result = await options.onComplete(raw);
    sseEvent(res, { type: 'result', result });
    sseEvent(res, { type: 'done' });
    res.end();
  } catch (error) {
    if ((error as Error)?.name === 'AbortError' || options.signal?.aborted) {
      res.end();
      return;
    }

    const message = (error as Error).message || 'AI request failed';
    const details = error instanceof StructuredStreamError ? error.details : undefined;

    // 头还没发出去时仍然用 HTTP 状态码报错，保持老调用方的行为
    if (!res.headersSent) {
      res.status(statusForError(error)).json({ error: message, details, rawContent: raw || undefined });
      return;
    }
    sseEvent(res, { type: 'error', message, details });
    sseEvent(res, { type: 'done' });
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
