import { useState, useEffect, useMemo } from 'react';
import { 
  Container, 
  Title, 
  Text, 
  Card, 
  Group, 
  Stack,
  TextInput,
  Autocomplete,
  Button,
  Alert,
  Loader,
  Box,
  Divider,
  PasswordInput,
  Center,
  Select,
  Badge,
  AppShell
} from '@mantine/core';
import { IconRobot } from '@tabler/icons-react';
import { useTranslation, useI18n } from '../src/contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../src/components/AppHeader';
import { DEFAULT_MODELS, SUGGESTED_MODELS } from '../src/lib/aiModels';
import { isInsecureRemote, looksRemote } from '../src/lib/endpointHosts';

export default function SettingsPage() {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  
  // AI Provider configuration states
  const [deepSeekConfig, setDeepSeekConfig] = useState({
    apiKey: '',
    model: '',
    timeout: '',
    maxTokens: ''
  });
  
  const [openAIConfig, setOpenAIConfig] = useState({
    apiKey: '',
    model: ''
  });
  
  const [qwenConfig, setQwenConfig] = useState({
    apiKey: '',
    model: ''
  });
  
  const [claudeConfig, setClaudeConfig] = useState({
    apiKey: '',
    model: ''
  });
  
  const [ollamaConfig, setOllamaConfig] = useState({
    endpoint: '',
    model: ''
  });

  const [compatibleConfig, setCompatibleConfig] = useState({
    endpoint: '',
    model: '',
    apiKey: ''
  });
  // 从端点拉回来的模型列表，填充下拉框
  const [compatibleModels, setCompatibleModels] = useState<string[]>([]);
  const [compatibleLoading, setCompatibleLoading] = useState(false);
  const [compatibleError, setCompatibleError] = useState<string | null>(null);

  /**
   * 判断用户填的是不是远程地址。补协议的规则要和服务端的
   * normalizeCompatibleEndpoint 一致，否则提示会和实际行为对不上。
   */
  const compatibleProbeUrl = useMemo(() => {
    const raw = (compatibleConfig.endpoint || '').trim();
    if (!raw) return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
    const hostPart = raw.split('/')[0].replace(/:\d+$/, '');
    return `${looksRemote(`http://${hostPart}`) ? 'https' : 'http'}://${raw}`;
  }, [compatibleConfig.endpoint]);

  const compatibleRemote = compatibleProbeUrl ? looksRemote(compatibleProbeUrl) : false;
  const compatibleInsecure = compatibleProbeUrl ? isInsecureRemote(compatibleProbeUrl) : false;

  const fetchCompatibleModels = async () => {
    setCompatibleLoading(true);
    setCompatibleError(null);
    try {
      const response = await fetch('/api/compatible-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: compatibleConfig.endpoint, apiKey: compatibleConfig.apiKey }),
      });
      const data = await response.json();
      if (!response.ok) {
        setCompatibleError(data?.error || t('settings.compatible.fetchFailed'));
        setCompatibleModels([]);
        return;
      }
      setCompatibleModels(data.models || []);
      if (!data.models?.length) {
        setCompatibleError(t('settings.compatible.noModels'));
        return;
      }
      // 只有一个模型时直接替用户选上，省一次点击
      if (data.models.length === 1 && !compatibleConfig.model) {
        setCompatibleConfig((prev) => ({ ...prev, model: data.models[0] }));
      }
    } catch (error: any) {
      setCompatibleError(error?.message || t('settings.compatible.fetchFailed'));
      setCompatibleModels([]);
    } finally {
      setCompatibleLoading(false);
    }
  };
  
  // Global AI provider selection
  const [selectedProvider, setSelectedProvider] = useState('auto');

  // Load current configuration
  useEffect(() => {
    const loadConfiguration = async () => {
      try {
        // Check if we're running in Electron
        if (typeof window !== 'undefined' && (window as any).electronAPI) {
          // Load configuration from Electron main process
          const result = await (window as any).electronAPI.loadConfiguration();
          if (result.success && result.data) {
            const data = result.data;
            setDeepSeekConfig(data.deepSeek || { apiKey: '', model: '', timeout: '', maxTokens: '' });
            setOpenAIConfig(data.openAI || { apiKey: '', model: '' });
            setQwenConfig(data.qwen || { apiKey: '', model: '' });
            setClaudeConfig(data.claude || { apiKey: '', model: '' });
            setOllamaConfig(data.ollama || { endpoint: '', model: '' });
            setCompatibleConfig(data.compatible || { endpoint: '', model: '', apiKey: '' });
            setSelectedProvider(data.selectedProvider || 'auto');
          }
        } else {
          // Web mode: Load from localStorage first, fallback to environment variables
          const savedConfig = localStorage.getItem('ai-provider-config');
          if (savedConfig) {
            try {
              const config = JSON.parse(savedConfig);
              setDeepSeekConfig(config.deepSeek || { apiKey: '', model: '', timeout: '', maxTokens: '' });
              setOpenAIConfig(config.openAI || { apiKey: '', model: '' });
              setQwenConfig(config.qwen || { apiKey: '', model: '' });
              setClaudeConfig(config.claude || { apiKey: '', model: '' });
              setOllamaConfig(config.ollama || { endpoint: '', model: '' });
              setCompatibleConfig(config.compatible || { endpoint: '', model: '', apiKey: '' });
              setSelectedProvider(config.selectedProvider || 'auto');
            } catch (parseError) {
              console.error('Error parsing saved configuration:', parseError);
              // Fallback to environment variables
              setDeepSeekConfig({
                apiKey: process.env.DEEPSEEK_API_KEY || '',
                model: process.env.DEEPSEEK_MODEL || '',
                timeout: process.env.DEEPSEEK_API_TIMEOUT || '',
                maxTokens: process.env.DEEPSEEK_MAX_TOKENS || ''
              });
              
              setOpenAIConfig({
                apiKey: process.env.OPENAI_API_KEY || '',
                model: process.env.OPENAI_MODEL || ''
              });
              
              setQwenConfig({
                apiKey: process.env.QWEN_API_KEY || '',
                model: process.env.QWEN_MODEL || ''
              });
              
              setClaudeConfig({
                apiKey: process.env.CLAUDE_API_KEY || '',
                model: process.env.CLAUDE_MODEL || ''
              });
              
              setOllamaConfig({
                endpoint: process.env.OLLAMA_ENDPOINT || '',
                model: process.env.OLLAMA_MODEL || ''
              });
            }
          } else {
            // Fallback to environment variables
            setDeepSeekConfig({
              apiKey: process.env.DEEPSEEK_API_KEY || '',
              model: process.env.DEEPSEEK_MODEL || '',
              timeout: process.env.DEEPSEEK_API_TIMEOUT || '',
              maxTokens: process.env.DEEPSEEK_MAX_TOKENS || ''
            });
            
            setOpenAIConfig({
              apiKey: process.env.OPENAI_API_KEY || '',
              model: process.env.OPENAI_MODEL || ''
            });
            
            setQwenConfig({
              apiKey: process.env.QWEN_API_KEY || '',
              model: process.env.QWEN_MODEL || ''
            });
            
            setClaudeConfig({
              apiKey: process.env.CLAUDE_API_KEY || '',
              model: process.env.CLAUDE_MODEL || ''
            });
            
            setOllamaConfig({
              endpoint: process.env.OLLAMA_ENDPOINT || '',
              model: process.env.OLLAMA_MODEL || ''
            });
          }
        }
      } catch (err) {
        setError('Failed to load configuration');
        console.error('Error loading configuration:', err);
      } finally {
        setLoading(false);
      }
    };

    loadConfiguration();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    
    try {
      // Prepare configuration data
      const configData = {
        deepSeek: deepSeekConfig,
        openAI: openAIConfig,
        qwen: qwenConfig,
        claude: claudeConfig,
        ollama: ollamaConfig,
        compatible: compatibleConfig,
        selectedProvider: selectedProvider
      };
      
      // Check if we're running in Electron
      if (typeof window !== 'undefined' && (window as any).electronAPI) {
        // Save configuration to Electron main process
        const result = await (window as any).electronAPI.saveConfiguration(configData);
        if (result.success) {
          setSuccess('Configuration saved successfully!');
          // Reload the page to refresh the AI provider detection
          setTimeout(() => {
            window.location.reload();
          }, 1000);
        } else {
          setError(`Failed to save configuration: ${result.error}`);
        }
      } else {
        // Web mode: Save to localStorage
        try {
          localStorage.setItem('ai-provider-config', JSON.stringify(configData));
          setSuccess('Configuration saved successfully!');
          // Reload the page to refresh the AI provider detection
          setTimeout(() => {
            window.location.reload();
          }, 1000);
        } catch (storageError) {
          setError('Failed to save configuration to localStorage');
          console.error('Error saving to localStorage:', storageError);
        }
      }
    } catch (err) {
      setError('Failed to save configuration');
      console.error('Error saving configuration:', err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AppShell header={{ height: HEADER_HEIGHT }}>
        <AppHeader backHref="/" title={t('settings.title')} />
        <AppShell.Main>
          <Container size="md" py="xl">
            <Card padding="lg" radius="lg" withBorder>
              <Center style={{ minHeight: '300px' }}>
                <Stack align="center" gap="md">
                  <Loader size="md" />
                  <Text size="sm" c="dimmed">{t('common.loading')}</Text>
                </Stack>
              </Center>
            </Card>
          </Container>
        </AppShell.Main>
      </AppShell>
    );
  }

  return (
    <AppShell header={{ height: HEADER_HEIGHT }}>
      <AppHeader backHref="/" title={t('settings.title')} />
      <AppShell.Main>
      <Container size="md" py="xl">
        <Stack gap="xl">
          <Title order={1}>{t('settings.title')}</Title>

          <Card padding="lg" radius="lg" withBorder>
          <Stack gap="xl">
            <Text size="sm" c="dimmed">
              {t('settings.description')}
            </Text>
            
            {error && (
              <Alert color="red" title={t('common.error')}>
                {error}
              </Alert>
            )}
            
            {success && (
              <Alert color="green" title={t('common.success')}>
                {success}
              </Alert>
            )}
            
            {/* Global AI Provider Selection */}
            <Box>
              <Group gap="sm" mb="md">
                <IconRobot size={24} />
                <Title order={3}>{t('settings.defaultProvider.title')}</Title>
              </Group>
              <Text size="sm" c="dimmed" mb="md">
                {t('settings.defaultProvider.description')}
              </Text>
              <Select
                label={t('settings.defaultProvider.label')}
                description={t('settings.defaultProvider.selectDescription')}
                value={selectedProvider}
                onChange={(value) => setSelectedProvider(value || 'auto')}
                data={[
                  { value: 'auto', label: t('settings.defaultProvider.auto') },
                  { value: 'deepseek', label: 'DeepSeek', disabled: !deepSeekConfig.apiKey },
                  { value: 'openai', label: 'OpenAI', disabled: !openAIConfig.apiKey },
                  { value: 'qwen', label: 'Qwen (通义千问)', disabled: !qwenConfig.apiKey },
                  { value: 'claude', label: 'Claude', disabled: !claudeConfig.apiKey },
                  { value: 'ollama', label: 'Ollama (Local)', disabled: !ollamaConfig.endpoint && !ollamaConfig.model },
                  {
                    value: 'compatible',
                    label: t('settings.compatible.title'),
                    // 端点和模型缺一不可
                    disabled: !compatibleConfig.endpoint || !compatibleConfig.model,
                  },
                ]}
                w={300}
              />
              {selectedProvider !== 'auto' && (
                <Badge mt="sm" color="blue" variant="light">
                  {t('settings.defaultProvider.currentSelection')}: {selectedProvider}
                </Badge>
              )}
            </Box>
            
            <Divider />
            
            {/* DeepSeek Configuration */}
            <Box>
              <Title order={3} mb="md">DeepSeek</Title>
              <Stack gap="sm">
                <PasswordInput
                  label={t('settings.deepseek.apiKey')}
                  placeholder={t('settings.deepseek.apiKeyPlaceholder')}
                  value={deepSeekConfig.apiKey}
                  onChange={(e) => setDeepSeekConfig({...deepSeekConfig, apiKey: e.target.value})}
                />
                <Autocomplete
                  label={t('settings.deepseek.model')}
                  placeholder={DEFAULT_MODELS.deepseek}
                  description={t('settings.modelHint')}
                  data={SUGGESTED_MODELS.deepseek}
                  value={deepSeekConfig.model}
                  onChange={(value) => setDeepSeekConfig({...deepSeekConfig, model: value})}
                />
                <TextInput
                  label={t('settings.deepseek.timeout')}
                  placeholder={t('settings.deepseek.timeoutPlaceholder')}
                  value={deepSeekConfig.timeout}
                  onChange={(e) => setDeepSeekConfig({...deepSeekConfig, timeout: e.target.value})}
                  type="number"
                />
                <TextInput
                  label={t('settings.deepseek.maxTokens')}
                  placeholder={t('settings.deepseek.maxTokensPlaceholder')}
                  value={deepSeekConfig.maxTokens}
                  onChange={(e) => setDeepSeekConfig({...deepSeekConfig, maxTokens: e.target.value})}
                  type="number"
                />
              </Stack>
            </Box>
            
            <Divider />
            
            {/* OpenAI Configuration */}
            <Box>
              <Title order={3} mb="md">OpenAI</Title>
              <Stack gap="sm">
                <PasswordInput
                  label={t('settings.openai.apiKey')}
                  placeholder={t('settings.openai.apiKeyPlaceholder')}
                  value={openAIConfig.apiKey}
                  onChange={(e) => setOpenAIConfig({...openAIConfig, apiKey: e.target.value})}
                />
                <Autocomplete
                  label={t('settings.openai.model')}
                  placeholder={DEFAULT_MODELS.openai}
                  description={t('settings.modelHint')}
                  data={SUGGESTED_MODELS.openai}
                  value={openAIConfig.model}
                  onChange={(value) => setOpenAIConfig({...openAIConfig, model: value})}
                />
              </Stack>
            </Box>
            
            <Divider />
            
            {/* Qwen Configuration */}
            <Box>
              <Title order={3} mb="md">Qwen (通义千问)</Title>
              <Stack gap="sm">
                <PasswordInput
                  label={t('settings.qwen.apiKey')}
                  placeholder={t('settings.qwen.apiKeyPlaceholder')}
                  value={qwenConfig.apiKey}
                  onChange={(e) => setQwenConfig({...qwenConfig, apiKey: e.target.value})}
                />
                <Autocomplete
                  label={t('settings.qwen.model')}
                  placeholder={DEFAULT_MODELS.qwen}
                  description={t('settings.modelHint')}
                  data={SUGGESTED_MODELS.qwen}
                  value={qwenConfig.model}
                  onChange={(value) => setQwenConfig({...qwenConfig, model: value})}
                />
              </Stack>
            </Box>
            
            <Divider />
            
            {/* Claude Configuration */}
            <Box>
              <Title order={3} mb="md">Claude</Title>
              <Stack gap="sm">
                <PasswordInput
                  label={t('settings.claude.apiKey')}
                  placeholder={t('settings.claude.apiKeyPlaceholder')}
                  value={claudeConfig.apiKey}
                  onChange={(e) => setClaudeConfig({...claudeConfig, apiKey: e.target.value})}
                />
                <Autocomplete
                  label={t('settings.claude.model')}
                  placeholder={DEFAULT_MODELS.claude}
                  description={t('settings.modelHint')}
                  data={SUGGESTED_MODELS.claude}
                  value={claudeConfig.model}
                  onChange={(value) => setClaudeConfig({...claudeConfig, model: value})}
                />
              </Stack>
            </Box>
            
            <Divider />
            
            {/* Ollama Configuration */}
            <Box>
              <Title order={3} mb="md">Ollama (Local)</Title>
              <Stack gap="sm">
                <TextInput
                  label={t('settings.ollama.endpoint')}
                  placeholder={t('settings.ollama.endpointPlaceholder')}
                  value={ollamaConfig.endpoint}
                  onChange={(e) => setOllamaConfig({...ollamaConfig, endpoint: e.target.value})}
                />
                <Autocomplete
                  label={t('settings.ollama.model')}
                  placeholder={DEFAULT_MODELS.ollama}
                  description={t('settings.modelHint')}
                  data={SUGGESTED_MODELS.ollama}
                  value={ollamaConfig.model}
                  onChange={(value) => setOllamaConfig({...ollamaConfig, model: value})}
                />
              </Stack>
            </Box>

            <Divider />

            {/* 任意 OpenAI 兼容端点 */}
            <Box>
              <Title order={3} mb={4}>{t('settings.compatible.title')}</Title>
              <Text size="sm" c="dimmed" mb="md">
                {t('settings.compatible.intro')}
              </Text>
              <Stack gap="sm">
                <TextInput
                  label={t('settings.compatible.endpoint')}
                  placeholder="http://localhost:1234/v1"
                  description={t('settings.compatible.endpointHint')}
                  value={compatibleConfig.endpoint}
                  onChange={(e) => setCompatibleConfig({...compatibleConfig, endpoint: e.target.value})}
                />
                <PasswordInput
                  label={t('settings.compatible.apiKey')}
                  placeholder={t('settings.compatible.apiKeyPlaceholder')}
                  description={t('settings.compatible.apiKeyHint')}
                  value={compatibleConfig.apiKey}
                  onChange={(e) => setCompatibleConfig({...compatibleConfig, apiKey: e.target.value})}
                />
                <Group align="flex-end" gap="sm" wrap="nowrap">
                  <Autocomplete
                    style={{ flex: 1 }}
                    label={t('settings.compatible.model')}
                    placeholder={t('settings.compatible.modelPlaceholder')}
                    description={t('settings.compatible.modelHint')}
                    data={compatibleModels}
                    value={compatibleConfig.model}
                    onChange={(value) => setCompatibleConfig({...compatibleConfig, model: value})}
                  />
                  <Button
                    variant="light"
                    onClick={fetchCompatibleModels}
                    loading={compatibleLoading}
                    disabled={!compatibleConfig.endpoint}
                  >
                    {t('settings.compatible.fetchModels')}
                  </Button>
                </Group>
                {/* 远程端点的两个常见配错，与其让请求失败后再猜，不如当场说清楚 */}
                {compatibleRemote && !compatibleConfig.apiKey && (
                  <Text size="xs" c="orange">{t('settings.compatible.remoteNeedsKey')}</Text>
                )}
                {compatibleInsecure && (
                  <Text size="xs" c="orange">{t('settings.compatible.insecureRemote')}</Text>
                )}
                {compatibleError && (
                  <Text size="xs" c="red">{compatibleError}</Text>
                )}
                {!compatibleError && compatibleModels.length > 0 && (
                  <Text size="xs" c="teal">
                    {t('settings.compatible.foundModels').replace('{count}', String(compatibleModels.length))}
                  </Text>
                )}
              </Stack>
            </Box>

            <Group justify="flex-end">
              <Button 
                onClick={handleSave} 
                loading={saving}
                size="md"
              >
                {saving ? t('settings.saving') : t('settings.save')}
              </Button>
            </Group>
          </Stack>
          </Card>
        </Stack>
      </Container>
      </AppShell.Main>
    </AppShell>
  );
}