import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/router';
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  Container,
  Group,
  List,
  Loader,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconSparkles, IconX } from '@tabler/icons-react';
import { useI18n, useTranslation } from '../../src/contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../../src/components/AppHeader';
import { useAiConfig } from '../../src/hooks/useAiConfig';
import type { EngineeringProject } from '../../src/lib/engineering/types';

interface VerificationSummary {
  stageId: string;
  ok: boolean;
  summary: string;
  starterAlsoPasses: boolean;
}

interface GenerateResult {
  project?: EngineeringProject;
  verification?: VerificationSummary[];
  problems?: string[];
  saved: boolean;
}

export default function ProjectGeneratorPage() {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const { config } = useAiConfig();
  const router = useRouter();

  const [request, setRequest] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(null);

  const suggestions =
    locale === 'zh'
      ? [
          '实现一个带背压的日志批量上报器，考察缓冲、批量与丢弃策略',
          '构建一个支持优先级与公平调度的任务队列',
          '实现一个分片下载器，支持断点续传与并发分片',
          '做一个带 LRU 与预热的多级配置中心客户端',
        ]
      : [
          'A log batching uploader with backpressure, buffering and drop policy',
          'A task queue with priorities and fair scheduling',
          'A chunked downloader with resume and parallel chunks',
          'A config-center client with LRU caching and warm-up',
        ];

  const generate = async () => {
    if (!request.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch('/api/generate-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: request.trim(), config, language: locale }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to generate project');
      setResult(data);
    } catch (generateError) {
      setError((generateError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const saveAnyway = async () => {
    if (!result?.project) return;
    setSaving(true);
    try {
      const response = await fetch('/api/generate-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: result.project, force: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save project');
      router.push(`/projects/${data.project.id}`);
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} padding={{ base: 'sm', md: 'md' }}>
      <AppHeader backHref="/projects" title={t('engineering.generator.title')} />

      <AppShell.Main>
        <Container size="md" py="md">
          <Stack gap="lg">
            <Stack gap={4}>
              <Title order={2}>{t('engineering.generator.heading')}</Title>
              <Text size="sm" c="dimmed">
                {t('engineering.generator.subtitle')}
              </Text>
            </Stack>

            <Card withBorder radius="lg" padding="lg">
              <Stack gap="md">
                <Textarea
                  label={t('engineering.generator.requestLabel')}
                  description={t('engineering.generator.requestHint')}
                  placeholder={t('engineering.generator.placeholder')}
                  value={request}
                  onChange={(event) => setRequest(event.currentTarget.value)}
                  autosize
                  minRows={3}
                  maxRows={8}
                />

                <Stack gap={6}>
                  <Text size="xs" c="dimmed">
                    {t('engineering.generator.suggestions')}
                  </Text>
                  <Group gap="xs">
                    {suggestions.map((suggestion) => (
                      <Button
                        key={suggestion}
                        size="compact-xs"
                        variant="light"
                        color="gray"
                        onClick={() => setRequest(suggestion)}
                      >
                        {suggestion}
                      </Button>
                    ))}
                  </Group>
                </Stack>

                <Group justify="space-between">
                  <Text size="xs" c="dimmed">
                    {t('engineering.generator.verifyNote')}
                  </Text>
                  <Button
                    onClick={generate}
                    disabled={!request.trim() || loading}
                    leftSection={loading ? <Loader size={14} color="white" /> : <IconSparkles size={16} />}
                    color="violet"
                  >
                    {loading ? t('engineering.generator.generating') : t('engineering.generator.generate')}
                  </Button>
                </Group>
              </Stack>
            </Card>

            {loading && (
              <Alert color="violet" icon={<Loader size={14} />}>
                {t('engineering.generator.loadingHint')}
              </Alert>
            )}

            {error && (
              <Alert color="red" title={t('common.error')}>
                {error}
              </Alert>
            )}

            {result?.project && (
              <Card withBorder radius="lg" padding="lg">
                <Group justify="space-between" mb="sm">
                  <Title order={4}>{result.project.title.zh || result.project.title.en}</Title>
                  <Badge color={result.saved ? 'teal' : 'orange'} variant="light">
                    {result.saved
                      ? t('engineering.generator.verified')
                      : t('engineering.generator.unverified')}
                  </Badge>
                </Group>

                <Text size="sm" c="dimmed" mb="md">
                  {result.project.summary.zh || result.project.summary.en}
                </Text>

                {result.verification && result.verification.length > 0 && (
                  <Stack gap={6} mb="md">
                    <Text size="sm" fw={600}>
                      {t('engineering.generator.verification')}
                    </Text>
                    {result.verification.map((item) => (
                      <Group key={item.stageId} gap={8}>
                        <ThemeIcon size={18} radius="xl" variant="light" color={item.ok ? 'teal' : 'red'}>
                          {item.ok ? <IconCheck size={11} /> : <IconX size={11} />}
                        </ThemeIcon>
                        <Text size="xs" ff="monospace">
                          {item.stageId}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {item.summary}
                          {item.starterAlsoPasses ? ` · ${t('engineering.generator.noDiscrimination')}` : ''}
                        </Text>
                      </Group>
                    ))}
                  </Stack>
                )}

                {result.problems && result.problems.length > 0 && (
                  <Alert color="orange" icon={<IconAlertTriangle size={16} />} mb="md">
                    <Text size="sm" fw={600} mb={6}>
                      {t('engineering.generator.problemsTitle')}
                    </Text>
                    <List size="xs" spacing={2}>
                      {result.problems.slice(0, 12).map((problem, index) => (
                        <List.Item key={index}>{problem}</List.Item>
                      ))}
                    </List>
                  </Alert>
                )}

                <Group justify="flex-end">
                  {result.saved ? (
                    <Button component={Link} href={`/projects/${result.project.id}`}>
                      {t('engineering.generator.open')}
                    </Button>
                  ) : (
                    <>
                      <Button variant="default" onClick={generate} disabled={loading}>
                        {t('engineering.generator.retry')}
                      </Button>
                      <Button color="orange" onClick={saveAnyway} loading={saving}>
                        {t('engineering.generator.saveAnyway')}
                      </Button>
                    </>
                  )}
                </Group>
              </Card>
            )}
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
