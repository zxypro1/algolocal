/**
 * ops 工作台里的 AI 助手
 *
 * 和代码形态那个浮动按钮 + 弹窗不一样：这里它是右侧那组 tab 里的一页，
 * 和终端、IDE、拓扑并列。原因是 ops 的问答几乎总是「看着报错问」——
 * 一个盖住半个屏幕的弹窗会把学员要问的那段输出挡住。
 *
 * 上下文在**每次发送时**现取：集群一直在动，敲一条命令世界就变了，
 * 缓存下来的快照第二个问题就已经过期了。
 */
import { useCallback, useMemo } from 'react';
import { Text } from '@mantine/core';
import { IconRobot } from '@tabler/icons-react';
import { useI18n, useTranslation } from '../../contexts/I18nContext';
import { useAiConfig } from '../../hooks/useAiConfig';
import { useChatStream, StreamMessage } from '../../hooks/useChatStream';
import ChatPanel from '../chat/ChatPanel';
import { buildOpsSnapshot, summarizeReport } from '../../lib/opslab/lab';
import type { OpsWorld } from '../../lib/opslab/lab';
import type { CommandRecord } from '../../lib/labkit/machine';
import type { LocalizedText, StageRunReport } from '../../lib/engineering/types';

export interface OpsChatProps {
  projectTitle: LocalizedText;
  projectSummary: LocalizedText;
  stageTitle: LocalizedText;
  stageGoal: LocalizedText;
  stageIndex: number;
  stageCount: number;
  checklist?: LocalizedText[];
  world: OpsWorld | null;
  history: CommandRecord[];
  namespace: string;
  /** IDE 里打开的文件（这一关涉及的那些） */
  files: Record<string, string>;
  report: StageRunReport | null;
}

export default function OpsChat(props: OpsChatProps) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const { config } = useAiConfig();

  const {
    world, history, namespace, files, report,
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
        // 世界还没起来时只发关卡信息 —— 总比整个面板不能用强
        snapshot: world ? buildOpsSnapshot(world, { files, history, namespace }) : undefined,
        report: summarizeReport(report),
      },
    }),
    [
      config, locale, world, files, history, namespace, report,
      projectTitle, projectSummary, stageTitle, stageGoal, stageIndex, stageCount, checklist,
    ]
  );

  const chat = useChatStream({ url: '/api/ops-chat', body: buildBody });

  /**
   * 快捷提问跟着现场走。
   *
   * 上一条命令挂了就先问它 —— 那通常就是学员想问的；验收没过就问没过的那条。
   */
  const quickPrompts = useMemo(() => {
    const prompts: string[] = [];
    const last = history[history.length - 1];
    if (last && last.code !== 0) prompts.push(t('opslab.chat.prompts.lastError'));
    if (report && report.status !== 'passed') prompts.push(t('opslab.chat.prompts.whyFailing'));
    prompts.push(t('opslab.chat.prompts.whereToLook'));
    prompts.push(t('opslab.chat.prompts.explainStage'));
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
      placeholder={t('opslab.chat.placeholder')}
      emptyState={
        <>
          <IconRobot size={44} opacity={0.35} />
          <Text size="sm" c="dimmed" ta="center" maw={420}>
            {t('opslab.chat.empty')}
          </Text>
        </>
      }
    />
  );
}
