import { useCallback, useMemo, useState } from 'react';
import { ActionIcon, Badge, Group, Modal, Text, Tooltip } from '@mantine/core';
import { IconMessageCircle, IconRobot } from '@tabler/icons-react';
import { useI18n, useTranslation } from '../../contexts/I18nContext';
import { useAiConfig } from '../../hooks/useAiConfig';
import { useChatStream, StreamMessage } from '../../hooks/useChatStream';
import ChatPanel from '../chat/ChatPanel';
import type { LocalizedText, StageRunReport, WorkspaceFile } from '../../lib/engineering/types';

interface EngineeringChatProps {
  projectTitle: LocalizedText;
  projectSummary: LocalizedText;
  stageTitle: LocalizedText;
  stageGoal: LocalizedText;
  stageIndex: number;
  stageCount: number;
  files: WorkspaceFile[];
  report: StageRunReport | null;
}

export default function EngineeringChat(props: EngineeringChatProps) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const { config } = useAiConfig();
  const [opened, setOpened] = useState(false);

  // 工作区上下文每次发送都要重新取（代码会变），所以放在 body 回调里读
  const buildBody = useCallback(
    (history: StreamMessage[], input: string) => ({
      messages: [...history, { role: 'user' as const, content: input }].map((message) => ({
        role: message.role,
        content: message.content,
      })),
      language: locale,
      config,
      context: {
        projectTitle: props.projectTitle,
        projectSummary: props.projectSummary,
        stageIndex: props.stageIndex,
        stageCount: props.stageCount,
        stageTitle: props.stageTitle,
        stageGoal: props.stageGoal,
        files: props.files.map((file) => ({
          path: file.path,
          content: file.content,
          readonly: file.readonly,
        })),
        report: props.report,
      },
    }),
    [config, locale, props]
  );

  const chat = useChatStream({ url: '/api/engineering-chat', body: buildBody });

  const quickPrompts = useMemo(
    () =>
      props.report
        ? [
            t('engineering.chat.prompts.whyFailing'),
            t('engineering.chat.prompts.metrics'),
            t('engineering.chat.prompts.review'),
            t('engineering.chat.prompts.hint'),
          ]
        : [
            t('engineering.chat.prompts.howToStart'),
            t('engineering.chat.prompts.design'),
            t('engineering.chat.prompts.hint'),
          ],
    [props.report, t]
  );

  return (
    <>
      <Tooltip label={t('engineering.chat.title')} position="left">
        <ActionIcon
          size={52}
          radius="xl"
          variant="filled"
          color="violet"
          onClick={() => setOpened(true)}
          style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 300, boxShadow: '0 4px 14px rgba(0,0,0,.18)' }}
        >
          <IconMessageCircle size={26} />
        </ActionIcon>
      </Tooltip>

      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        size="xl"
        // 关闭时不销毁：保留会话，同时 hook 的 abort 只在真正卸载时触发
        keepMounted
        title={
          <Group gap="xs">
            <IconRobot size={20} />
            <Text fw={600}>{t('engineering.chat.title')}</Text>
            <Badge size="sm" variant="light">
              {t('engineering.stage.label', { current: props.stageIndex + 1, total: props.stageCount })}
            </Badge>
          </Group>
        }
        styles={{
          body: { padding: 0, height: '66vh', display: 'flex', flexDirection: 'column' },
          content: { display: 'flex', flexDirection: 'column' },
        }}
      >
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
          placeholder={t('engineering.chat.placeholder')}
          emptyState={
            <>
              <IconRobot size={44} opacity={0.35} />
              <Text size="sm" c="dimmed" ta="center" maw={420}>
                {t('engineering.chat.empty')}
              </Text>
            </>
          }
        />
      </Modal>
    </>
  );
}
