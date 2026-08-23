/**
 * AI provider 层的回归测试
 *
 * 重点是那些「发错参数就 400」的地方：推理模型的 max_completion_tokens、
 * 不接受自定义 temperature，以及流式协议的解析。
 */
import { capabilitiesFor, DEFAULT_MODELS, SUGGESTED_MODELS } from '../../src/lib/aiModels';
import { normalizeCompatibleEndpoint, resolveProvider } from '../../src/lib/server/aiProvider';

describe('model capabilities', () => {
  it('uses max_completion_tokens for OpenAI reasoning models', () => {
    for (const model of ['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini']) {
      const capabilities = capabilitiesFor('openai', model);
      expect(capabilities.maxTokensParam).toBe('max_completion_tokens');
      expect(capabilities.supportsTemperature).toBe(false);
    }
  });

  it('keeps max_tokens for classic chat models', () => {
    for (const model of ['gpt-4.1', 'gpt-4o', 'gpt-4-turbo']) {
      const capabilities = capabilitiesFor('openai', model);
      expect(capabilities.maxTokensParam).toBe('max_tokens');
      expect(capabilities.supportsTemperature).toBe(true);
    }
  });

  it('drops temperature for deepseek-reasoner only', () => {
    expect(capabilitiesFor('deepseek', 'deepseek-reasoner').supportsTemperature).toBe(false);
    expect(capabilitiesFor('deepseek', 'deepseek-chat').supportsTemperature).toBe(true);
  });

  it('lists every provider default among its suggestions', () => {
    for (const kind of Object.keys(DEFAULT_MODELS) as Array<keyof typeof DEFAULT_MODELS>) {
      // 'compatible' 指向的是任意一台 OpenAI 兼容服务，模型 id 由对端决定，
      // 没有默认值可猜 —— 所以它的默认值是空串，建议列表在设置页动态填充。
      // 这里不是放宽断言：空默认值必须同时意味着空建议列表，
      // 免得「留空 -> 用默认」这条路径悄悄退化成发一个不存在的模型 id 上去。
      if (DEFAULT_MODELS[kind] === '') {
        expect(SUGGESTED_MODELS[kind]).toEqual([]);
        continue;
      }
      expect(SUGGESTED_MODELS[kind]).toContain(DEFAULT_MODELS[kind]);
    }
  });

  it('requires an explicit model for the compatible provider', () => {
    // 端点填了、模型没填，不能被当成「配好了」而进入 auto 顺序
    expect(DEFAULT_MODELS.compatible).toBe('');
  });
});

describe('provider resolution', () => {
  const envKeys = [
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'QWEN_API_KEY',
    'CLAUDE_API_KEY',
    'OLLAMA_MODEL',
    'DEEPSEEK_MODEL',
    'OPENAI_MODEL',
    'OPENAI_COMPATIBLE_ENDPOINT',
    'OPENAI_COMPATIBLE_MODEL',
    'OPENAI_COMPATIBLE_API_KEY',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    envKeys.forEach((key) => {
      saved[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterEach(() => {
    envKeys.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });

  it('honours an explicitly selected provider', () => {
    const provider = resolveProvider({
      deepSeek: { apiKey: 'a', model: '' },
      claude: { apiKey: 'b', model: '' },
      selectedProvider: 'claude',
    });
    expect(provider.kind).toBe('claude');
    expect(provider.model).toBe(DEFAULT_MODELS.claude);
  });

  it('falls back to the first configured provider on auto', () => {
    const provider = resolveProvider({ qwen: { apiKey: 'k', model: '' }, selectedProvider: 'auto' });
    expect(provider.kind).toBe('qwen');
  });

  /**
   * 这条以前断言的是「静默换一家」，那其实是个 bug：用户在设置里选了 Claude、
   * 但 Claude 的 key 是空的，请求就被发去了 DeepSeek/OpenAI —— 代码和提示词
   * 交给了没选的厂商，还计在另一把 key 上，界面上毫无提示。
   */
  it('refuses to substitute another vendor for the selected one', () => {
    expect(() =>
      resolveProvider({
        openAI: { apiKey: 'k', model: '' },
        selectedProvider: 'claude',
      })
    ).toThrow(/selected AI provider "claude"/);
  });

  it('carries the user model through and derives its capabilities', () => {
    const provider = resolveProvider({ openAI: { apiKey: 'k', model: 'o4-mini' } });
    expect(provider.model).toBe('o4-mini');
    expect(provider.capabilities.maxTokensParam).toBe('max_completion_tokens');
  });

  it('throws when nothing is configured', () => {
    expect(() => resolveProvider({})).toThrow(/No AI provider/);
  });
});

describe('OpenAI-compatible endpoint', () => {
  // next/jest 会加载 .env，所以真配了这个功能的人跑测试时环境里就有这几个变量。
  // 不清掉的话，下面「没配模型就不该被选中」这类断言会被环境里的值弄假。
  const envKeys = [
    'OPENAI_COMPATIBLE_ENDPOINT',
    'OPENAI_COMPATIBLE_MODEL',
    'OPENAI_COMPATIBLE_API_KEY',
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'QWEN_API_KEY',
    'CLAUDE_API_KEY',
    'OLLAMA_MODEL',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    envKeys.forEach((key) => {
      saved[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterEach(() => {
    envKeys.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });

  it('appends /v1 only when the address carries no path of its own', () => {
    // LM Studio 的地址，两种写法的人一样多
    expect(normalizeCompatibleEndpoint('http://localhost:1234')).toBe('http://localhost:1234/v1');
    expect(normalizeCompatibleEndpoint('http://localhost:1234/')).toBe('http://localhost:1234/v1');
    expect(normalizeCompatibleEndpoint('http://localhost:1234/v1')).toBe('http://localhost:1234/v1');
    // 明确写了路径就不要动它：不是所有兼容服务都挂在 /v1
    expect(normalizeCompatibleEndpoint('http://localhost:8000/openai/v1')).toBe(
      'http://localhost:8000/openai/v1'
    );
    expect(normalizeCompatibleEndpoint('  http://localhost:1234/v1//  ')).toBe(
      'http://localhost:1234/v1'
    );
    // 没写协议头的写法也很常见。注意 new URL('localhost:1234') 会把 localhost:
    // 当成协议，所以这里必须先补 http:// 再解析。
    expect(normalizeCompatibleEndpoint('localhost:1234')).toBe('http://localhost:1234/v1');
    expect(normalizeCompatibleEndpoint('127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeCompatibleEndpoint('https://gw.example.com/v1')).toBe(
      'https://gw.example.com/v1'
    );
  });

  it('resolves with the endpoint normalised and the key optional', () => {
    const provider = resolveProvider({
      compatible: { endpoint: 'http://localhost:1234', model: 'qwen2.5-coder-7b-instruct' },
      selectedProvider: 'compatible',
    });
    expect(provider.kind).toBe('compatible');
    expect(provider.endpoint).toBe('http://localhost:1234/v1');
    expect(provider.model).toBe('qwen2.5-coder-7b-instruct');
    expect(provider.apiKey).toBeUndefined();
    // 本地模型多半不是推理模型，按经典参数发
    expect(provider.capabilities.maxTokensParam).toBe('max_tokens');
    expect(provider.capabilities.supportsTemperature).toBe(true);
  });

  it('does not count as configured when the model is missing', () => {
    // 模型 id 由对端决定，没有它就不该被 auto 选中，更不该拿空模型去请求
    expect(() =>
      resolveProvider({
        compatible: { endpoint: 'http://localhost:1234', model: '' },
        selectedProvider: 'compatible',
      })
    ).toThrow(/no API key configured|not/i);

    expect(() =>
      resolveProvider({ compatible: { endpoint: 'http://localhost:1234', model: '' } })
    ).toThrow();
  });

  it('is last in the auto order, so it never displaces a configured cloud vendor', () => {
    const provider = resolveProvider({
      deepSeek: { apiKey: 'a', model: '' },
      compatible: { endpoint: 'http://localhost:1234', model: 'local' },
    });
    expect(provider.kind).toBe('deepseek');
  });
});
