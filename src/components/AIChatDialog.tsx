import React, { useCallback, useMemo, useState } from 'react';
import { ActionIcon, Badge, Group, Modal, Paper, Text, Tooltip } from '@mantine/core';
import { IconMessageCircle, IconRobot } from '@tabler/icons-react';
import { useI18n, useTranslation } from '../contexts/I18nContext';
import { useAiConfig } from '../hooks/useAiConfig';
import { useChatStream, StreamMessage } from '../hooks/useChatStream';
import ChatPanel from './chat/ChatPanel';

interface AIChatDialogProps {
  problem: {
    id: string;
    title: { en: string; zh: string };
    description: { en: string; zh: string };
    difficulty: string;
    tags: string[];
  };
  currentCode?: string;
  codeLanguage?: string;
}

export default function AIChatDialog({ problem, currentCode, codeLanguage }: AIChatDialogProps) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const { config } = useAiConfig();
  const [opened, setOpened] = useState(false);

  const buildBody = useCallback(
    (history: StreamMessage[], input: string) => ({
      messages: [...history, { role: 'user' as const, content: input }].map((message) => ({
        role: message.role,
        content: message.content,
      })),
      problem,
      language: locale,
      config,
      currentCode,
      codeLanguage,
      stream: true,
    }),
    [codeLanguage, config, currentCode, locale, problem]
  );

  const chat = useChatStream({ url: '/api/ai-chat', body: buildBody });

  const quickPrompts = useMemo(() => {
    const base =
      locale === 'zh'
        ? ['给我一些提示', '这道题应该用什么算法？', '帮我分析一下时间复杂度', '能解释一下这道题吗？']
        : [
            'Give me a hint',
            'What algorithm should I use?',
            'Help me analyze time complexity',
            'Can you explain this problem?',
          ];

    const withCode =
      locale === 'zh'
        ? ['检查我的代码有什么问题', '帮我优化这段代码']
        : ["Check what's wrong with my code", 'Help me optimize this code'];

    return currentCode?.trim() ? [...base.slice(0, 2), ...withCode] : base;
  }, [currentCode, locale]);

  return (
    <>
      <Tooltip label={t('aiChat.title')} position="left">
        <ActionIcon
          size={56}
          radius="xl"
          variant="filled"
          color="violet"
          onClick={() => setOpened(true)}
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            zIndex: 1000,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          }}
        >
          <IconMessageCircle size={28} />
        </ActionIcon>
      </Tooltip>

      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        keepMounted
        title={
          <Group gap="xs">
            <IconRobot size={24} />
            <Text fw={600}>{t('aiChat.title')}</Text>
          </Group>
        }
        size="lg"
        styles={{
          body: { padding: 0, height: '60vh', display: 'flex', flexDirection: 'column' },
          content: { display: 'flex', flexDirection: 'column' },
        }}
      >
        <Paper p="xs" withBorder style={{ borderRadius: 0 }}>
          <Group gap="xs">
            <Badge
              size="sm"
              color={
                problem.difficulty === 'Easy' ? 'green' : problem.difficulty === 'Medium' ? 'yellow' : 'red'
              }
            >
              {problem.difficulty}
            </Badge>
            <Text size="sm" fw={500} lineClamp={1}>
              {problem.title[locale as 'en' | 'zh'] || problem.title.en}
            </Text>
          </Group>
        </Paper>

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
          placeholder={t('aiChat.inputPlaceholder')}
          emptyState={
            <>
              <IconRobot size={48} opacity={0.35} />
              <Text c="dimmed" ta="center" size="sm">
                {t('aiChat.emptyState')}
              </Text>
              <Text size="xs" c="dimmed">
                {t('aiChat.quickPrompts')}
              </Text>
            </>
          }
        />
      </Modal>
    </>
  );
}
