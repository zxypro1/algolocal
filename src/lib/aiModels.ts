/**
 * 模型目录（前后端共用）
 *
 * 单独放在这里而不是塞进 server/aiProvider，是为了让设置页能直接引用，
 * 又不会把服务端的流式实现打进客户端 bundle。
 */

export type ProviderKind = 'deepseek' | 'openai' | 'qwen' | 'claude' | 'ollama';

/**
 * 各家没填模型时的默认值。
 * 用户在设置里填了什么就用什么，这里只影响「留空」的情况。
 */
export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  deepseek: 'deepseek-chat',
  openai: 'gpt-4.1',
  qwen: 'qwen-plus',
  claude: 'claude-sonnet-5',
  ollama: 'llama3.1',
};

/** 设置页的下拉建议，仍然允许自由输入任意模型 id */
export const SUGGESTED_MODELS: Record<ProviderKind, string[]> = {
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openai: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-5', 'o4-mini'],
  qwen: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  claude: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
  ollama: ['llama3.1', 'qwen2.5-coder', 'deepseek-r1'],
};

/** 不同世代的模型接受的参数不一样，这里显式建模而不是「都发一遍碰运气」 */
export interface ModelCapabilities {
  /** 输出长度参数名：推理模型用 max_completion_tokens */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  /** 是否接受自定义 temperature（推理模型只接受默认值） */
  supportsTemperature: boolean;
  supportsStreaming: boolean;
}

// o1 / o3 / o4… 以及 gpt-5 系列属于推理模型
const OPENAI_REASONING = /^(o\d|gpt-5)/i;
const DEEPSEEK_REASONING = /reason/i;

export function capabilitiesFor(kind: ProviderKind, model: string): ModelCapabilities {
  switch (kind) {
    case 'openai': {
      const reasoning = OPENAI_REASONING.test(model);
      return {
        // 推理模型拒绝 max_tokens，必须用 max_completion_tokens
        maxTokensParam: reasoning ? 'max_completion_tokens' : 'max_tokens',
        // 也拒绝非默认 temperature
        supportsTemperature: !reasoning,
        supportsStreaming: true,
      };
    }
    case 'deepseek':
      return {
        maxTokensParam: 'max_tokens',
        supportsTemperature: !DEEPSEEK_REASONING.test(model),
        supportsStreaming: true,
      };
    default:
      return { maxTokensParam: 'max_tokens', supportsTemperature: true, supportsStreaming: true };
  }
}
