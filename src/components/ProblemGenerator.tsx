import React, { useState, useEffect } from 'react';
import { 
  Button, 
  Textarea, 
  Title, 
  Text, 
  Alert, 
  Loader, 
  Stack, 
  Group, 
  Box, 
  Card, 
  Badge
} from '@mantine/core';
import { useTranslation, useI18n } from '../contexts/I18nContext';
import { useTheme } from '../contexts/ThemeContext';
import { 
  IconBrain, 
  IconWand, 
  IconDeviceFloppy
} from '@tabler/icons-react';
import Editor from '@monaco-editor/react';

interface GeneratedProblem {
  id: string;
  title: {
    en: string;
    zh: string;
  };
  difficulty: 'Easy' | 'Medium' | 'Hard';
  tags: string[];
  description: {
    en: string;
    zh: string;
  };
}

interface ProblemGeneratorProps {
  onProblemGenerated?: (problem: GeneratedProblem) => void;
  onClose?: () => void;
}

const ProblemGenerator: React.FC<ProblemGeneratorProps> = ({ onProblemGenerated, onClose }) => {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const { colorScheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [request, setRequest] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [generatedProblem, setGeneratedProblem] = useState<GeneratedProblem | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [canGenerate, setCanGenerate] = useState(false);
  const [isUsingLocalAI, setIsUsingLocalAI] = useState(false);
  const [currentAIProvider, setCurrentAIProvider] = useState<string | null>(null);
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
  const [configSelectedProvider, setConfigSelectedProvider] = useState('auto');
  
  // AI Provider configuration states
  const [isDeepSeekConfigured, setIsDeepSeekConfigured] = useState(false);
  const [isOpenAIConfigured, setIsOpenAIConfigured] = useState(false);
  const [isQwenConfigured, setIsQwenConfigured] = useState(false);
  const [isClaudeConfigured, setIsClaudeConfigured] = useState(false);
  const [isOllamaConfigured, setIsOllamaConfigured] = useState(false);
  const [isCompatibleConfigured, setIsCompatibleConfigured] = useState(false);
  
  // JSON Editor states
  const [showJsonEditor, setShowJsonEditor] = useState(false);
  const [jsonContent, setJsonContent] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Prevent hydration mismatch by ensuring component is mounted
  useEffect(() => {
    setMounted(true);
  }, []);

  // Fetch AI provider configuration from server
  useEffect(() => {
    const fetchProviderConfiguration = async () => {
      try {
        // Check if we're running in Electron
        if (typeof window !== 'undefined' && (window as any).electronAPI) {
          const response = await fetch('/api/ai-providers');
          const data = await response.json();
          
          if (response.ok) {
            setIsOllamaConfigured(data.providers.ollama);
            setIsDeepSeekConfigured(data.providers.deepseek);
            setIsOpenAIConfigured(data.providers.openai);
            setIsQwenConfigured(data.providers.qwen);
            setIsClaudeConfigured(data.providers.claude);
            setIsCompatibleConfigured(!!data.providers.compatible);
          } else {
            console.error('Failed to fetch provider configuration:', data.error);
          }
        } else {
          // Web mode: Check localStorage first, fallback to API
          const savedConfig = localStorage.getItem('ai-provider-config');
          if (savedConfig) {
            try {
              const config = JSON.parse(savedConfig);
              setIsOllamaConfigured(!!(config.ollama?.endpoint || config.ollama?.model));
              setIsDeepSeekConfigured(!!config.deepSeek?.apiKey);
              setIsOpenAIConfigured(!!config.openAI?.apiKey);
              setIsQwenConfigured(!!config.qwen?.apiKey);
              setIsClaudeConfigured(!!config.claude?.apiKey);
              // 和服务端一致：端点和模型都得有才算配好
              setIsCompatibleConfigured(!!(config.compatible?.endpoint && config.compatible?.model));
              setConfigSelectedProvider(config.selectedProvider || 'auto');
            } catch (parseError) {
              console.error('Error parsing saved configuration:', parseError);
              // Fallback to API
              const response = await fetch('/api/ai-providers');
              const data = await response.json();
              
              if (response.ok) {
                setIsOllamaConfigured(data.providers.ollama);
                setIsDeepSeekConfigured(data.providers.deepseek);
                setIsOpenAIConfigured(data.providers.openai);
                setIsQwenConfigured(data.providers.qwen);
                setIsClaudeConfigured(data.providers.claude);
            setIsCompatibleConfigured(!!data.providers.compatible);
              } else {
                console.error('Failed to fetch provider configuration:', data.error);
              }
            }
          } else {
            // Fallback to API
            const response = await fetch('/api/ai-providers');
            const data = await response.json();
            
            if (response.ok) {
              setIsOllamaConfigured(data.providers.ollama);
              setIsDeepSeekConfigured(data.providers.deepseek);
              setIsOpenAIConfigured(data.providers.openai);
              setIsQwenConfigured(data.providers.qwen);
              setIsClaudeConfigured(data.providers.claude);
            setIsCompatibleConfigured(!!data.providers.compatible);
            } else {
              console.error('Failed to fetch provider configuration:', data.error);
            }
          }
        }
      } catch (err) {
        console.error('Error fetching provider configuration:', err);
      } finally {
        setProvidersLoading(false);
      }
    };

    if (mounted) {
      fetchProviderConfiguration();
    }
  }, [mounted]);

  // Determine which AI provider is currently selected (from settings page config)
  const getCurrentAIProvider = () => {
    if (configSelectedProvider === 'auto') {
      // Auto-select based on what's available (in order of preference)
      if (isDeepSeekConfigured) {
        return 'deepseek';
      } else if (isOpenAIConfigured) {
        return 'openai';
      } else if (isQwenConfigured) {
        return 'qwen';
      } else if (isClaudeConfigured) {
        return 'claude';
      } else if (isOllamaConfigured) {
        return 'ollama';
      } else if (isCompatibleConfigured) {
        return 'compatible';
      } else {
        return null; // None configured
      }
    }
    return configSelectedProvider;
  };

  useEffect(() => {
    const provider = getCurrentAIProvider();
    setCurrentAIProvider(provider);
    // 兼容端点绝大多数场景也是本地服务
    setIsUsingLocalAI(provider === 'ollama' || provider === 'compatible');

    const providers = [];
    if (isDeepSeekConfigured) providers.push('deepseek');
    if (isOpenAIConfigured) providers.push('openai');
    if (isQwenConfigured) providers.push('qwen');
    if (isClaudeConfigured) providers.push('claude');
    if (isOllamaConfigured) providers.push('ollama');
    if (isCompatibleConfigured) providers.push('compatible');

    setAvailableProviders(providers);
    setCanGenerate(providers.length > 0);
  }, [
    configSelectedProvider,
    isDeepSeekConfigured,
    isOpenAIConfigured,
    isQwenConfigured,
    isClaudeConfigured,
    isOllamaConfigured,
    isCompatibleConfigured
  ]);

  const suggestedRequests = [
    locale === 'zh' ? "我想做一道动态规划题目" : "Generate a dynamic programming problem",
    locale === 'zh' ? "创建一个中等难度的数组操作问题" : "Generate a medium difficulty array manipulation problem",
    locale === 'zh' ? "创建一个关于二分搜索的问题" : "Create a binary search problem",
    locale === 'zh' ? "我想要一个滑动窗口字符串处理问题" : "I want a string processing problem with sliding window",
    locale === 'zh' ? "生成一个困难的图算法题目" : "Generate a hard graph algorithm problem",
    locale === 'zh' ? "创建一个简单的贪心算法问题" : "Create an easy greedy algorithm problem",
    locale === 'zh' ? "我需要一道链表操作的题目" : "I need a linked list operation problem",
    locale === 'zh' ? "生成一个树遍历问题" : "Generate a tree traversal problem"
  ];

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case 'Easy': return 'green';
      case 'Medium': return 'yellow';
      case 'Hard': return 'red';
      default: return 'gray';
    }
  };

  const handleGenerate = async () => {
    if (!request.trim()) {
      setError(t('aiGenerator.pleaseEnterRequest'));
      return;
    }

    if (!canGenerate) {
      setError(t('aiGenerator.noAIProviderConfigured'));
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);
    setGeneratedProblem(null);
    setShowJsonEditor(false);
    setJsonContent('');
    setJsonError(null);

    try {
      // Prepare request body - config contains selectedProvider from settings
      const requestBody: any = { 
        request: request.trim()
      };

      // Check if we're in web mode and have saved configuration
      if (typeof window !== 'undefined' && !(window as any).electronAPI) {
        const savedConfig = localStorage.getItem('ai-provider-config');
        if (savedConfig) {
          try {
            requestBody.config = JSON.parse(savedConfig);
          } catch (parseError) {
            console.error('Error parsing saved configuration:', parseError);
          }
        }
      }

      const response = await fetch('/api/generate-problem', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();

      if (!response.ok) {
        // Check if it's a JSON parsing error
        if (data.error && data.error.includes('Failed to parse generated problem data')) {
          // Show JSON editor for user to fix the problem
          setShowJsonEditor(true);
          setJsonContent(data.rawContent || data.details || '');
          setError(t('aiGenerator.jsonParseError'));
        } else {
          throw new Error(data.error || 'Failed to generate problem');
        }
      } else {
        setGeneratedProblem(data.problem);
        setSuccess(data.message);
        
        if (onProblemGenerated) {
          onProblemGenerated(data.problem);
        }
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate problem');
    } finally {
      setLoading(false);
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setRequest(suggestion);
  };

  const handleSaveFixedJson = async () => {
    if (!jsonContent.trim()) {
      setJsonError(t('aiGenerator.pleaseEnterJson'));
      return;
    }

    try {
      // Try to parse the JSON to validate it
      const parsed = JSON.parse(jsonContent);
      
      // If parsing succeeds, try to save the problem
      const response = await fetch('/api/add-problem', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ problem: parsed }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save problem');
      }

      setGeneratedProblem(parsed);
      setSuccess(data.message);
      setShowJsonEditor(false);
      setJsonContent('');
      setJsonError(null);
      
      if (onProblemGenerated) {
        onProblemGenerated(parsed);
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        setJsonError(t('aiGenerator.invalidJsonFormat'));
      } else {
        setJsonError(err instanceof Error ? err.message : 'Failed to save problem');
      }
    }
  };

  // Prevent hydration issues by not rendering until mounted
  if (!mounted) {
    return (
      <Box maw={800} mx="auto" p="md">
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Stack gap="lg">
            <Group gap="md">
              <IconBrain size={32} color={colorScheme === 'dark' ? '#748ffc' : '#339af0'} />
              <Title order={2} c={colorScheme === 'dark' ? 'blue.4' : 'blue.6'}>
                {t('aiGenerator.title')}
              </Title>
            </Group>
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <Loader size="md" />
            </div>
          </Stack>
        </Card>
      </Box>
    );
  }

  // Show loading state while fetching provider configuration
  if (providersLoading) {
    return (
      <Box maw={800} mx="auto" p="md">
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Stack gap="lg">
            <Group gap="md">
              <IconBrain size={32} color={colorScheme === 'dark' ? '#748ffc' : '#339af0'} />
              <Title order={2} c={colorScheme === 'dark' ? 'blue.4' : 'blue.6'}>
                {t('aiGenerator.title')}
              </Title>
            </Group>
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <Loader size="md" />
              <Text mt="md">{t('common.loading')}</Text>
            </div>
          </Stack>
        </Card>
      </Box>
    );
  }

  return (
    <Box maw={800} mx="auto" p="md">
      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Stack gap="lg">
          <Group gap="md">
            <IconBrain size={32} color={colorScheme === 'dark' ? '#748ffc' : '#339af0'} />
            <Title order={2} c={colorScheme === 'dark' ? 'blue.4' : 'blue.6'}>
              {t('aiGenerator.title')}
            </Title>
          </Group>

          <Text size="sm" c="dimmed">
            {t('aiGenerator.subtitle')}
          </Text>

          {/* AI Provider Status */}
          {!canGenerate ? (
            <Alert color="red" title={t('aiGenerator.errorTitle')}>
              {t('aiGenerator.noAIProviderConfigured')}
            </Alert>
          ) : (
            /* AI Provider Indicator - shows which provider is selected in settings */
            <Alert color={isUsingLocalAI ? 'blue' : 'violet'} variant="light">
              <Group gap="xs">
                <IconBrain size={16} />
                <Text size="sm" fw={500}>
                  {currentAIProvider === 'ollama'
                    ? t('aiGenerator.usingLocalAI')
                    : currentAIProvider === 'compatible'
                      // 兼容端点可以指向本地服务，也可以指向自建网关，
                      // 这里不替用户断言是「本地」还是「在线」
                      ? t('aiGenerator.usingCompatibleAI')
                      : t('aiGenerator.usingOnlineAI', { provider: currentAIProvider || 'unknown' })}
                </Text>
                <Text size="xs" c="dimmed">
                  ({t('aiGenerator.changeInSettings')})
                </Text>
              </Group>
            </Alert>
          )}

          {/* Request Input */}
          <Textarea
            label={t('aiGenerator.requestLabel')}
            placeholder={t('aiGenerator.requestPlaceholder')}
            value={request}
            onChange={(event) => setRequest(event.currentTarget.value)}
            minRows={3}
            disabled={loading || !canGenerate}
          />

          {/* Suggested Requests */}
          <div>
            <Title order={4} mb="md">
              {t('aiGenerator.suggestedRequests')}:
            </Title>
            <Group gap="xs">
              {suggestedRequests.map((suggestion, index) => (
                <Badge
                  key={index}
                  variant="outline"
                  style={{ cursor: 'pointer' }}
                  onClick={() => handleSuggestionClick(suggestion)}
                  size="sm"
                >
                  {suggestion}
                </Badge>
              ))}
            </Group>
          </div>

          {/* Generate Button */}
          <Group>
            <Button
              leftSection={loading ? <Loader size="sm" /> : <IconWand size={16} />}
              onClick={handleGenerate}
              disabled={loading || !request.trim() || !canGenerate}
              size="md"
              style={{ minWidth: 200 }}
            >
              {loading ? t('aiGenerator.generating') : t('aiGenerator.generateButton')}
            </Button>
            
            {onClose && (
              <Button
                variant="outline"
                onClick={onClose}
                disabled={loading}
              >
                {t('aiGenerator.cancel')}
              </Button>
            )}
          </Group>

          {/* Error Display */}
          {error && !showJsonEditor && (
            <Alert color="red" title={t('aiGenerator.errorTitle')}>
              {error}
            </Alert>
          )}

          {/* JSON Editor for fixing parsing errors */}
          {showJsonEditor && (
            <Card withBorder mt="md" style={{ position: 'relative' }}>
              <Stack gap="md">
                <Group justify="space-between">
                  <Title order={4} c={colorScheme === 'dark' ? 'red.4' : 'red.6'}>
                    {t('aiGenerator.fixJsonTitle')}
                  </Title>
                  <Button
                    leftSection={<IconDeviceFloppy size={16} />}
                    onClick={handleSaveFixedJson}
                    color="green"
                  >
                    {t('aiGenerator.saveFixedJson')}
                  </Button>
                </Group>
                
                <Text size="sm" c="dimmed">
                  {t('aiGenerator.fixJsonInstructions')}
                </Text>
                
                {jsonError && (
                  <Alert color="red" title={t('aiGenerator.errorTitle')}>
                    {jsonError}
                  </Alert>
                )}
                
                <div style={{ height: '400px', border: '1px solid #ccc', borderRadius: '4px' }}>
                  <Editor
                    height="100%"
                    language="json"
                    value={jsonContent}
                    onChange={(value) => setJsonContent(value || '')}
                    theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 14,
                      lineNumbers: 'on',
                      roundedSelection: false,
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      tabSize: 2,
                      insertSpaces: true,
                      wordWrap: 'on',
                      contextmenu: false,
                      folding: false
                    }}
                  />
                </div>
              </Stack>
            </Card>
          )}

          {/* Success Display */}
          {success && (
            <Alert color="green" title={t('aiGenerator.successTitle')}>
              {success}
            </Alert>
          )}

          {/* Generated Problem Preview */}
          {generatedProblem && (
            <Card withBorder mt="md">
              <Stack gap="md">
                <Title order={4} c={colorScheme === 'dark' ? 'blue.4' : 'blue.6'}>
                  {t('aiGenerator.previewTitle')}
                </Title>
                
                <Group>
                  <Title order={5}>
                    {generatedProblem.title[locale as keyof typeof generatedProblem.title] || generatedProblem.title.en}
                  </Title>
                  <Badge 
                    color={getDifficultyColor(generatedProblem.difficulty)}
                    size="sm"
                  >
                    {t(`homepage.difficulty.${generatedProblem.difficulty}`)}
                  </Badge>
                </Group>

                <Text size="sm" c="dimmed">
                  {generatedProblem.title[locale === 'zh' ? 'zh' : 'en']}
                </Text>

                <Group gap="xs">
                  {generatedProblem.tags.map((tag, index) => (
                    <Badge key={index} variant="light" size="xs">
                      {t(`tags.${tag}`) !== `tags.${tag}` ? t(`tags.${tag}`) : tag}
                    </Badge>
                  ))}
                </Group>

                <Box
                  style={{
                    maxHeight: 150,
                    overflow: 'auto',
                    border: '1px solid var(--app-border)',
                    borderRadius: 8,
                    padding: 12,
                    backgroundColor: 'var(--app-surface-muted)'
                  }}
                >
                  <Text size="sm">
                    {generatedProblem.description[locale as keyof typeof generatedProblem.description] || generatedProblem.description.en}
                  </Text>
                </Box>

                <Text size="xs" c="dimmed">
                  {t('aiGenerator.problemId')}: {generatedProblem.id}
                </Text>
              </Stack>
            </Card>
          )}

          {/* Instructions */}
          <Card 
            withBorder 
            style={{ 
              backgroundColor: colorScheme === 'dark' ? '#1a365d' : '#e7f5ff'
            }}
          >
            <Stack gap="sm">
              <Title order={5}>
                {t('aiGenerator.howToUse')}:
              </Title>
              <div style={{ fontSize: '14px' }}>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  <li>{t('aiGenerator.instruction1')}</li>
                  <li>{t('aiGenerator.instruction2')}</li>
                  <li>{t('aiGenerator.instruction3')}</li>
                  <li>{t('aiGenerator.instruction4')}</li>
                  <li>{t('aiGenerator.instruction5')}</li>
                </ul>
              </div>
            </Stack>
          </Card>
        </Stack>
      </Card>
    </Box>
  );
};

export default ProblemGenerator;