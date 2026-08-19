/**
 * AI provider 层的回归测试
 *
 * 重点是那些「发错参数就 400」的地方：推理模型的 max_completion_tokens、
 * 不接受自定义 temperature，以及流式协议的解析。
 */
import { capabilitiesFor, DEFAULT_MODELS, SUGGESTED_MODELS } from '../../src/lib/aiModels';
import { resolveProvider } from '../../src/lib/server/aiProvider';

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
      expect(SUGGESTED_MODELS[kind]).toContain(DEFAULT_MODELS[kind]);
    }
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
