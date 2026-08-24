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
import { useProjectRunner } from '../../src/hooks/useProjectRunner';
import { describeVerification, verifyProject } from '../../src/lib/engineering/validateProject';
import { StreamRequestError } from '../../src/lib/streamRequest';
import { requestStructuredStream } from '../../src/lib/streamRequest';
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

/** 保留服务端逐条列出的结构问题，否则界面上只剩一句「保存失败」 */
function messageWithDetails(error: unknown): string {
  const message = (error as Error)?.message || 'Something went wrong';
  const details = (error as StreamRequestError)?.details;
  if (Array.isArray(details) && details.length > 0) {
    return `${message}\n${details.map((item) => `• ${String(item)}`).join('\n')}`;
  }
  return message;
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
  const [status, setStatus] = useState<string | null>(null);
  /** 模型正在写的原文 */
  const [draft, setDraft] = useState('');
  const { run } = useProjectRunner();

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

  /**
   * 生成 → 在浏览器里真跑一遍 → 不过就带着失败原因让模型修一轮 → 再跑一遍。
   *
   * 「真跑一遍」发生在 useProjectRunner 的 Web Worker 里：模型生成的代码有独立的
   * 全局环境、看不到任何密钥，死循环也能被 terminate。服务端只负责调模型和结构校验。
   */
  const generate = async () => {
    if (!request.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setDraft('');

    // 一份工程题几万字，边写边显示，而不是让人对着转圈等到最后
    const ask = async (body: Record<string, unknown>) =>
      requestStructuredStream<GenerateResult>('/api/generate-project', body, {
        onDelta: (_chunk, full) => setDraft(full),
      });

    const check = async (candidate: EngineeringProject) => {
      setStatus(t('engineering.generator.verifying'));
      // 不要 as any：StageExecutor 现在明说可能没有报告，verifyProject 自己会处理
      const verifications = await verifyProject(candidate, (options) => run(options));
      const failureReport = describeVerification(verifications);
      return {
        verification: verifications.map((item) => ({
          stageId: item.stageId,
          ok: item.ok,
          starterAlsoPasses: item.starterAlsoPasses,
          summary: `${item.report.totals.passed}/${item.report.totals.total} cases, ${
            item.report.gates.filter((gate) => gate.passed).length
          }/${item.report.gates.length} gates`,
        })),
        problems: failureReport ? failureReport.split('\n') : [],
      };
    };

    try {
      setStatus(t('engineering.generator.drafting'));
      let data = await ask({ request: request.trim(), config, language: locale });
      let project = data.project;
      let problems = data.problems || [];
      let verification: VerificationSummary[] = [];

      if (project && problems.length === 0) {
        const checked = await check(project);
        verification = checked.verification;
        problems = checked.problems;
      }

      // 一轮自动修复：结构问题和真实运行失败一起喂回去
      if (project && problems.length > 0) {
        setStatus(t('engineering.generator.repairing'));
        data = await ask({
          request: request.trim(),
          config,
          language: locale,
          previous: project,
          problems,
        });
        project = data.project;
        problems = data.problems || [];
        verification = [];

        if (project && problems.length === 0) {
          const checked = await check(project);
          verification = checked.verification;
          problems = checked.problems;
        }
      }

      const verified = Boolean(project) && problems.length === 0;
      if (verified && project) {
        setStatus(t('engineering.generator.saving'));
        const saved = await ask({ project, force: true });
        setResult({ project: saved.project, verification, saved: true });
      } else {
        setResult({ project, verification, problems, saved: false });
      }
    } catch (generateError) {
      setError(messageWithDetails(generateError));
    } finally {
      setStatus(null);
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
      if (!response.ok) {
        // 服务端会把结构问题逐条放在 details 里，只显示一句「保存失败」等于把原因扔了
        throw new StreamRequestError(data.error || 'Failed to save project', data.details);
      }
      if (!data.project?.id) throw new Error('The server did not return a saved project');
      router.push(`/projects/${data.project.id}`);
    } catch (saveError) {
      setError(messageWithDetails(saveError));
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
                {/* 生成 / 验证 / 修复 是三个阶段，验证阶段会跑好几关，得让人知道进行到哪儿了 */}
                {status || t('engineering.generator.loadingHint')}
              </Alert>
            )}

            {/* 模型写到哪儿了。生成一份工程题要几分钟，光转圈没法让人判断它是不是卡住了。 */}
            {loading && draft && (
              <Card withBorder radius="md" padding="sm">
                <Text
                  size="xs"
                  c="dimmed"
                  style={{
                    maxHeight: 200,
                    overflow: 'auto',
                    fontFamily: 'monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {draft.slice(-4000)}
                </Text>
              </Card>
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
