/**
 * gpulab 工作台里的 AI 助手
 *
 * 位置和 ops 那边一样：右侧那组 tab 里的一页，和终端、IDE、剖析并列，
 * 不是浮动弹窗 —— 学员问问题时几乎总是对着剖析面板上的某个数或者终端里的报错，
 * 弹窗会把要问的那段挡住。
 *
 * 上下文在**每次发送时**现取：他改一行代码、重跑一次 ncu，数字就全变了，
 * 缓存下来的快照第二个问题就已经过期。
 */
import { useCallback, useMemo } from 'react';
import { Text } from '@mantine/core';
import { IconRobot } from '@tabler/icons-react';
import { useI18n, useTranslation } from '../../contexts/I18nContext';
import { useAiConfig } from '../../hooks/useAiConfig';
import { useChatStream, StreamMessage } from '../../hooks/useChatStream';
import ChatPanel from '../chat/ChatPanel';
import { buildGpuSnapshot, summarizeGpuReport } from '../../lib/gpulab/lab/aicontext';
import type { GpuWorld } from '../../lib/gpulab/lab';
import type { CommandRecord } from '../../lib/labkit/machine';
import type { LocalizedText, MetricGate, StageRunReport } from '../../lib/engineering/types';

export interface GpuChatProps {
  projectTitle: LocalizedText;
  projectSummary: LocalizedText;
  stageTitle: LocalizedText;
  stageGoal: LocalizedText;
  stageIndex: number;
  stageCount: number;
  checklist?: LocalizedText[];
  gates?: MetricGate[];
  world: GpuWorld | null;
  history: CommandRecord[];
  /** 学员当前的源码：路径 -> 内容 */
  sources: Record<string, string>;
  report: StageRunReport | null;
}

export default function GpuChat(props: GpuChatProps) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  // locale 是宽字符串；门槛标签要按语言取，这里收窄一次
  const lang: 'en' | 'zh' = locale === 'en' ? 'en' : 'zh';
  const { config } = useAiConfig();

  const {
    world, history, sources, report, gates,
    projectTitle, projectSummary, stageTitle, stageGoal, stageIndex, stageCount, checklist,
  } = props;

  const buildBody = useCallback(
    (chatHistory: StreamMessage[], input: string) => ({
      messages: [...chatHistory, { role: 'user' as const, content: input }].map((message) => ({
        role: message.role,
        content: message.content,
      })),
      language: locale,
      config,
      context: {
        projectTitle,
        projectSummary,
        stageIndex,
        stageCount,
        stageTitle,
        stageGoal,
        checklist,
        // 还没跑过验收时，至少让 AI 知道这一关要达到什么
        gates: gates?.map((gate) => ({
          metric: gate.metric, label: gate.label, op: gate.op, value: gate.value, unit: gate.unit,
        })),
        // 世界还没起来时只发关卡信息 —— 总比整个面板不能用强
        snapshot: world ? buildGpuSnapshot(world, { sources, history }) : undefined,
        report: summarizeGpuReport(report, lang),
      },
    }),
    [
      config, locale, lang, world, sources, history, report, gates,
      projectTitle, projectSummary, stageTitle, stageGoal, stageIndex, stageCount, checklist,
    ]
  );

  const chat = useChatStream({ url: '/api/gpu-chat', body: buildBody });

  /**
   * 快捷提问跟着现场走。
   *
   * 和 ops 的差别就在这里：ops 优先问「上一条命令为什么报错」，
   * 而 GPU 这边最常见的处境是用例全绿、某条门槛红着 —— 那才是第一个该问的。
   */
  const quickPrompts = useMemo(() => {
    const prompts: string[] = [];
    const failedGate = report?.gates?.find((gate) => !gate.passed);
    const failedCase = report?.cases?.some((item) => !item.passed && item.error !== 'skipped');
    const last = history[history.length - 1];

    if (failedGate) prompts.push(t('gpulab.chat.prompts.gateShortfall'));
    if (failedCase) prompts.push(t('gpulab.chat.prompts.whyFailing'));
    if (last && last.code !== 0) prompts.push(t('gpulab.chat.prompts.lastError'));
    prompts.push(t('gpulab.chat.prompts.whereToLook'));
    prompts.push(t('gpulab.chat.prompts.explainStage'));
    return prompts;
  }, [history, report, t]);

  return (
    <ChatPanel
      messages={chat.messages}
      isStreaming={chat.isStreaming}
      error={chat.error}
      onSend={chat.send}
      onStop={chat.stop}
      onClear={chat.clear}
      onRetry={chat.retry}
      onDismissError={() => chat.setError(null)}
      quickPrompts={quickPrompts}
      placeholder={t('gpulab.chat.placeholder')}
      emptyState={
        <>
          <IconRobot size={44} opacity={0.35} />
          <Text size="sm" c="dimmed" ta="center" maw={420}>
            {t('gpulab.chat.empty')}
          </Text>
        </>
      }
    />
  );
}
