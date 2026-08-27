import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconPlayerStop, IconRefresh, IconRobot, IconSend, IconTrash, IconUser } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/I18nContext';
import MarkdownRenderer from '../MarkdownRenderer';
import type { StreamMessage } from '../../hooks/useChatStream';

/**
 * 聊天消息行
 *
 * 单独抽出来并 memo：流式生成时只有最后一条在变，
 * 其余消息不会被重新渲染（也就不会重新解析 markdown）。
 */
const MessageRow = React.memo(function MessageRow({
  message,
  youLabel,
  assistantLabel,
}: {
  message: StreamMessage;
  youLabel: string;
  assistantLabel: string;
}) {
  const isUser = message.role === 'user';

  return (
    <Paper
      p="sm"
      withBorder
      radius="md"
      style={{
        background: isUser ? 'var(--mantine-color-brand-light)' : 'var(--app-surface)',
        marginLeft: isUser ? '18%' : 0,
        marginRight: isUser ? 0 : '8%',
      }}
    >
      <Group gap={6} mb={6}>
        {isUser ? <IconUser size={14} /> : <IconRobot size={14} />}
        <Text size="xs" c="dimmed" fw={500}>
          {isUser ? youLabel : assistantLabel}
        </Text>
      </Group>

      {isUser ? (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {message.content}
        </Text>
      ) : (
        <>
          <MarkdownRenderer content={message.content} streaming={message.streaming} />
          {message.streaming && (
            <Text component="span" size="sm" className="app-caret" aria-hidden>
              ▍
            </Text>
          )}
          {message.error && (
            <Alert color="red" p="xs" mt="xs" variant="light">
              <Text size="xs">{message.error}</Text>
            </Alert>
          )}
        </>
      )}
    </Paper>
  );
});

interface ChatPanelProps {
  messages: StreamMessage[];
  isStreaming: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onClear: () => void;
  onRetry: () => void;
  onDismissError: () => void;
  emptyState: React.ReactNode;
  quickPrompts?: string[];
  placeholder: string;
}

export default function ChatPanel({
  messages,
  isStreaming,
  error,
  onSend,
  onStop,
  onClear,
  onRetry,
  onDismissError,
  emptyState,
  quickPrompts = [],
  placeholder,
}: ChatPanelProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  /**
   * 只在用户本来就贴着底部时才自动滚动。
   * 之前是无条件 scrollTo，用户往回翻看历史会被一直拽回底部。
   */
  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    pinnedRef.current = distance < 80;
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  /**
   * 尺寸或内容高度变了也要重新贴底。
   *
   * 工作台里这栏的宽度是可以拖的，一拖内容重排、总高度变，原来贴着底部的视图
   * 就浮到中间去了 —— 看起来像「消息没滚到底」。同样只在**本来就贴着底**时才动，
   * 用户正在往回翻历史时拖分隔条不会被拽走。
   *
   * **要盯的是内容那一层，不只是视口。** 只观察视口的话，回调在视口尺寸变化的
   * 那一帧就跑了，而此时里面的文字还没重新折行；等它折完，总高度又长了一截，
   * 于是又不贴底了。实测拖宽左栏（对话变窄、文字折行变多）必现，
   * 而后续几次拖动反而正常 —— 因为那时高度已经稳定。观察内容元素就没有这个时序问题。
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;
    const stickToBottom = () => {
      if (!pinnedRef.current) return;
      viewport.scrollTop = viewport.scrollHeight;
    };
    const observer = new ResizeObserver(stickToBottom);
    observer.observe(viewport);
    const content = viewport.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const submit = () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    pinnedRef.current = true;
    setInput('');
    onSend(text);
  };

  const lastMessage = messages[messages.length - 1];
  const canRetry = !isStreaming && (Boolean(error) || Boolean(lastMessage?.error));

  return (
    /*
     * 高度要同时应付两种父容器。
     *
     * 弹窗形态（AIChatDialog / EngineeringChat）把它放进一个 `display: flex` 的
     * 列容器里，`flex: 1` 就够了。但工作台形态放进的是 Mantine 的 `Tabs.Panel` ——
     * **那是个 `display: block` 的 div**，`flex` 在里面是死的，于是整个面板
     * 缩到内容高度：实测 Panel 有 580px，面板只有 313px，输入框下面空了 267px。
     *
     * 所以两条都写上：`height: 100%` 管住块级父容器，`flex: 1` 管住弹性父容器。
     * 弹性容器里 `flex-basis: 0%` 会盖掉 `height`，两者不打架。
     */
    <Stack gap={0} style={{ flex: 1, minHeight: 0, height: '100%', width: '100%' }}>
      <ScrollArea
        style={{ flex: 1, minHeight: 0, padding: 16 }}
        viewportRef={viewportRef}
        onScrollPositionChange={handleScroll}
      >
        {messages.length === 0 ? (
          <Stack align="center" justify="center" gap="md" style={{ minHeight: 220 }}>
            {emptyState}
            {quickPrompts.length > 0 && (
              <Group gap="xs" justify="center">
                {quickPrompts.map((prompt) => (
                  <Button key={prompt} size="xs" variant="light" onClick={() => onSend(prompt)}>
                    {prompt}
                  </Button>
                ))}
              </Group>
            )}
          </Stack>
        ) : (
          <Stack gap="md">
            {messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                youLabel={t('aiChat.you')}
                assistantLabel={t('aiChat.assistant')}
              />
            ))}

            {isStreaming && !lastMessage?.content && (
              <Group gap={6} pl="sm">
                <Loader size="xs" />
                <Text size="sm" c="dimmed">
                  {t('aiChat.thinking')}
                </Text>
              </Group>
            )}
          </Stack>
        )}
      </ScrollArea>

      {error && (
        <Alert color="red" p="xs" m="sm" withCloseButton onClose={onDismissError}>
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Text size="xs" style={{ minWidth: 0 }}>
              {error}
            </Text>
            <Button size="compact-xs" variant="light" leftSection={<IconRefresh size={12} />} onClick={onRetry}>
              {t('aiChat.retry')}
            </Button>
          </Group>
        </Alert>
      )}

      <Paper p="sm" withBorder style={{ borderRadius: 0, borderLeft: 0, borderRight: 0, borderBottom: 0 }}>
        <Group gap="xs" align="flex-end">
          <Textarea
            placeholder={placeholder}
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            autosize
            minRows={1}
            maxRows={6}
            style={{ flex: 1 }}
          />

          {isStreaming ? (
            <Tooltip label={t('aiChat.stop')}>
              <ActionIcon size="lg" variant="filled" color="red" onClick={onStop}>
                <IconPlayerStop size={17} />
              </ActionIcon>
            </Tooltip>
          ) : (
            <ActionIcon
              size="lg"
              variant="filled"
              color="violet"
              onClick={submit}
              disabled={!input.trim()}
              aria-label={t('aiChat.send')}
            >
              <IconSend size={17} />
            </ActionIcon>
          )}

          {canRetry && (
            <Tooltip label={t('aiChat.retry')}>
              <ActionIcon size="lg" variant="light" color="gray" onClick={onRetry}>
                <IconRefresh size={17} />
              </ActionIcon>
            </Tooltip>
          )}

          {messages.length > 0 && !isStreaming && (
            <Tooltip label={t('aiChat.clearChat')}>
              <ActionIcon size="lg" variant="light" color="gray" onClick={onClear}>
                <IconTrash size={17} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Paper>
    </Stack>
  );
}
