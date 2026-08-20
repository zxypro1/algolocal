/**
 * 调用工坊的 AI 工具链
 *
 * 打的是同源的 /api/workshop/assist，用的是用户自己配置的 provider。配了
 * Ollama 的话这条链路完全在本机，断网可用 —— 这和「发布到市场」是两件事，
 * 不要把它们的可用性绑在一起。
 */
import { useCallback, useState } from 'react';
import { useAiConfig } from './useAiConfig';
import { useI18n } from '../contexts/I18nContext';
import type { AssistAction } from '../../pages/api/workshop/assist';

export interface AssistInput {
  action: AssistAction;
  instruction?: string;
  problem?: unknown;
  project?: unknown;
  codeLanguage?: string;
}

export function useWorkshopAssist() {
  const { config } = useAiConfig();
  const { locale } = useI18n();

  const [running, setRunning] = useState<AssistAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T = unknown>(input: AssistInput): Promise<T | null> => {
      setRunning(input.action);
      setError(null);

      try {
        const response = await fetch('/api/workshop/assist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...input, config, language: locale === 'en' ? 'en' : 'zh' }),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || `Request failed with ${response.status}`);

        return payload.result as T;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      } finally {
        setRunning(null);
      }
    },
    [config, locale]
  );

  return { run, running, error, clearError: () => setError(null) };
}

export default useWorkshopAssist;
