import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Modal,
  TextInput,
  Button,
  Stack,
  Paper,
  Text,
  Group,
  ScrollArea,
  ActionIcon,
  Loader,
  Alert,
  Badge,
  Tooltip,
  Box,
} from '@mantine/core';
import { IconSend, IconRobot, IconUser, IconX, IconMessageCircle } from '@tabler/icons-react';
import { useTranslation, useI18n } from '../contexts/I18nContext';
import MarkdownRenderer from './MarkdownRenderer';

interface AIProviderConfig {
  deepSeek?: { apiKey: string; model: string; timeout?: string; maxTokens?: string };
  openAI?: { apiKey: string; model: string };
  qwen?: { apiKey: string; model: string };
  claude?: { apiKey: string; model: string };
  ollama?: { endpoint: string; model: string };
  selectedProvider?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

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
  
  const [opened, setOpened] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiConfig, setAiConfig] = useState<AIProviderConfig | null>(null);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load AI configuration
  const loadAIConfig = useCallback(async () => {
    try {
      // Check if running in Electron
      if (typeof window !== 'undefined' && (window as any).electronAPI) {
        const result = await (window as any).electronAPI.loadConfiguration();
        if (result.success && result.data) {
          setAiConfig(result.data);
        }
      } else {
        // Web mode: Load from localStorage
        const savedConfig = localStorage.getItem('ai-provider-config');
        if (savedConfig) {
          setAiConfig(JSON.parse(savedConfig));
        }
      }
    } catch (err) {
      console.error('Failed to load AI config:', err);
    }
  }, []);

  useEffect(() => {
    loadAIConfig();
  }, [loadAIConfig]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  // Focus input when modal opens
  useEffect(() => {
    if (opened && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [opened]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: ChatMessage = { role: 'user', content: input.trim() };
    const assistantPlaceholder: ChatMessage = { role: 'assistant', content: '' };
    setMessages(prev => [...prev, userMessage, assistantPlaceholder]);
    setInput('');
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMessage],
          problem,
          language: locale,
          config: aiConfig, // Pass AI configuration
          currentCode, // Pass user's current code
          codeLanguage, // Pass the programming language
          stream: true,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        try {
          const data = JSON.parse(text);
          throw new Error(data.error || 'Failed to get response');
        } catch {
          throw new Error(text || 'Failed to get response');
        }
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const text = await response.text();
        let content = text;
        try {
          const data = JSON.parse(text);
          content = data.message || data.content || text;
        } catch {
          // ignore
        }

        setMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') last.content = content;
          return next;
        });
        return;
      }

      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        setMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') last.content = buffer;
          return next;
        });
      }

      buffer += decoder.decode();
      setMessages(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant') last.content = buffer;
        return next;
      });
    } catch (err: any) {
      setError(err.message || 'Failed to get AI response');
      setMessages(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && !last.content) {
          last.content = locale === 'zh' ? '（请求失败）' : '(Request failed)';
        }
        return next;
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([]);
    setError(null);
  };

  // Quick prompts - include code-related prompts if code is available
  const basePrompts = locale === 'zh' 
    ? ['给我一些提示', '这道题应该用什么算法？', '帮我分析一下时间复杂度', '能解释一下这道题吗？']
    : ['Give me a hint', 'What algorithm should I use?', 'Help me analyze time complexity', 'Can you explain this problem?'];
  
  const codePrompts = locale === 'zh'
    ? ['检查我的代码有什么问题', '帮我优化这段代码']
    : ['Check what\'s wrong with my code', 'Help me optimize this code'];
  
  const quickPrompts = currentCode?.trim() 
    ? [...basePrompts.slice(0, 2), ...codePrompts]
    : basePrompts;

  return (
    <>
      {/* Floating Chat Button */}
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

      {/* Chat Modal */}
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={
          <Group gap="xs">
            <IconRobot size={24} />
            <Text fw={600}>{t('aiChat.title')}</Text>
          </Group>
        }
        size="lg"
        styles={{
          body: {
            padding: 0,
            height: '60vh',
            display: 'flex',
            flexDirection: 'column',
          },
          content: {
            display: 'flex',
            flexDirection: 'column',
          }
        }}
      >
        <Stack gap={0} style={{ flex: 1, height: '100%' }}>
          {/* Problem Info Banner */}
          <Paper p="xs" withBorder style={{ borderRadius: 0 }}>
            <Group gap="xs">
              <Badge size="sm" color={
                problem.difficulty === 'Easy' ? 'green' : 
                problem.difficulty === 'Medium' ? 'yellow' : 'red'
              }>
                {problem.difficulty}
              </Badge>
              <Text size="sm" fw={500} lineClamp={1}>
                {problem.title[locale as 'en' | 'zh'] || problem.title.en}
              </Text>
            </Group>
          </Paper>

          {/* Messages Area */}
          <ScrollArea 
            style={{ flex: 1, padding: '16px' }} 
            viewportRef={scrollRef}
          >
            {messages.length === 0 ? (
              <Stack gap="md" align="center" justify="center" style={{ height: '100%', minHeight: 200 }}>
                <IconRobot size={48} color="gray" />
                <Text c="dimmed" ta="center" size="sm">
                  {t('aiChat.emptyState')}
                </Text>
                
                {/* Quick Prompts */}
                <Stack gap="xs" align="center">
                  <Text size="xs" c="dimmed">{t('aiChat.quickPrompts')}</Text>
                  <Group gap="xs" justify="center">
                    {quickPrompts.map((prompt, i) => (
                      <Button
                        key={i}
                        size="xs"
                        variant="light"
                        onClick={() => {
                          setInput(prompt);
                          inputRef.current?.focus();
                        }}
                      >
                        {prompt}
                      </Button>
                    ))}
                  </Group>
                </Stack>
              </Stack>
            ) : (
              <Stack gap="md">
                {messages.map((msg, index) => (
                  <Paper
                    key={index}
                    p="sm"
                    withBorder
                    style={{
                      backgroundColor: msg.role === 'user'
                        ? 'var(--mantine-color-brand-light)'
                        : 'var(--app-surface)',
                      marginLeft: msg.role === 'user' ? '20%' : 0,
                      marginRight: msg.role === 'assistant' ? '20%' : 0,
                    }}
                  >
                    <Group gap="xs" mb="xs">
                      {msg.role === 'user' ? (
                        <IconUser size={16} />
                      ) : (
                        <IconRobot size={16} />
                      )}
                      <Text size="xs" c="dimmed" fw={500}>
                        {msg.role === 'user' ? t('aiChat.you') : t('aiChat.assistant')}
                      </Text>
                    </Group>
                    {msg.role === 'assistant' ? (
                      <MarkdownRenderer content={msg.content} />
                    ) : (
                      <Text size="sm">{msg.content}</Text>
                    )}
                  </Paper>
                ))}
                
                {isLoading && (
                  <Paper p="sm" withBorder style={{ marginRight: '20%' }}>
                    <Group gap="xs">
                      <Loader size="xs" />
                      <Text size="sm" c="dimmed">{t('aiChat.thinking')}</Text>
                    </Group>
                  </Paper>
                )}
              </Stack>
            )}
          </ScrollArea>

          {/* Error Display */}
          {error && (
            <Alert color="red" p="xs" style={{ margin: '0 16px' }} withCloseButton onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          {/* Input Area */}
          <Paper p="md" withBorder style={{ borderRadius: 0, borderLeft: 0, borderRight: 0, borderBottom: 0 }}>
            <Group gap="xs">
              <TextInput
                ref={inputRef}
                placeholder={t('aiChat.inputPlaceholder')}
                value={input}
                onChange={(e) => setInput(e.currentTarget.value)}
                onKeyDown={handleKeyDown}
                disabled={isLoading}
                style={{ flex: 1 }}
              />
              <ActionIcon
                size="lg"
                variant="filled"
                color="violet"
                onClick={sendMessage}
                disabled={!input.trim() || isLoading}
              >
                <IconSend size={18} />
              </ActionIcon>
              {messages.length > 0 && (
                <Tooltip label={t('aiChat.clearChat')}>
                  <ActionIcon
                    size="lg"
                    variant="light"
                    color="gray"
                    onClick={clearChat}
                  >
                    <IconX size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          </Paper>
        </Stack>
      </Modal>
    </>
  );
}

