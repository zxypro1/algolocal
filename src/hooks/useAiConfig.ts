/**
 * 读取用户配置的 AI provider
 *
 * 桌面端存在 Electron 的配置文件里，Web 端存在 localStorage，
 * 两处逻辑原本散落在多个组件中，这里收成一个 hook。
 */
import { useCallback, useEffect, useState } from 'react';

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

export function useAiConfig() {
  const [config, setConfig] = useState<AIProviderConfig | null>(null);

  const load = useCallback(async () => {
    try {
      if (typeof window !== 'undefined' && (window as any).electronAPI) {
        const result = await (window as any).electronAPI.loadConfiguration();
        if (result?.success && result.data) {
          setConfig(result.data);
          return;
        }
      }
      const saved = typeof window !== 'undefined' ? localStorage.getItem('ai-provider-config') : null;
      if (saved) setConfig(JSON.parse(saved));
    } catch (error) {
      console.error('Failed to load AI config:', error);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { config, reload: load };
}

export default useAiConfig;
