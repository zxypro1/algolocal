import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconBook2, IconPlayerPlay, IconRefresh } from '@tabler/icons-react';
import { useI18n, useTranslation } from '../../contexts/I18nContext';
import type { LocalizedText } from '../../lib/engineering/types';
import type { ProjectOverview, ProjectSummary } from '../../lib/server/projectStore';
import MarkdownRenderer from '../MarkdownRenderer';

interface ProjectOverviewModalProps {
  opened: boolean;
  summary: ProjectSummary | null;
  onClose: () => void;
  onStart: (projectId: string) => void;
}

/** 从一段 Markdown 中取出第一段可读正文，供章节列表做简短预览。 */
export function markdownIntroduction(markdown: string): string {
  const paragraph = markdown
    .trim()
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(```|#{1,6}\s|\|)/.test(block));

  if (!paragraph) return '';

  return paragraph
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^[-*>]\s+/gm, '')
    .replace(/[~*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export default function ProjectOverviewModal({
  opened,
  summary,
  onClose,
  onStart,
}: ProjectOverviewModalProps) {
  const { locale } = useI18n();
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const [project, setProject] = useState<ProjectOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const pick = (text: LocalizedText | undefined) =>
    !text ? '' : text[locale as 'en' | 'zh'] || text.zh || text.en || '';

  useEffect(() => {
    if (!opened || !summary) return;

    const controller = new AbortController();
    setProject(null);
    setError(null);
    setLoading(true);

    fetch(`/api/projects?id=${encodeURIComponent(summary.id)}&view=overview`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(t('engineering.list.overviewLoadError'));
        return response.json();
      })
      .then((loadedProject: ProjectOverview) => setProject(loadedProject))
      .catch((loadError: Error) => {
        if (loadError.name !== 'AbortError') {
          setError(loadError.message || t('engineering.list.overviewLoadError'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [opened, retryToken, summary?.id, t]);

  const stages = useMemo(
    () =>
      (project?.stages || []).map((stage) => ({
        id: stage.id,
        title: pick(stage.title),
        introduction: markdownIntroduction(pick(stage.primer)),
      })),
    [locale, project]
  );

  const modalTitle = project ? pick(project.title) : pick(summary?.title);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={modalTitle || t('engineering.list.overviewTitle')}
      size="xl"
      fullScreen={isMobile}
      centered={!isMobile}
      styles={{
        header: { borderBottom: '1px solid var(--app-border)' },
        body: { padding: 0 },
        title: { fontWeight: 700 },
      }}
    >
      <Stack
        gap={0}
        style={{ height: isMobile ? 'calc(100dvh - 60px)' : 'min(72vh, 720px)' }}
      >
        <ScrollArea style={{ flex: 1, minHeight: 0 }}>
          <Box px={{ base: 'md', sm: 'xl' }} py="lg">
            {loading ? (
              <Stack align="center" justify="center" gap="sm" mih={260}>
                <Loader size="sm" />
                <Text size="sm" c="dimmed">
                  {t('engineering.list.loadingOverview')}
                </Text>
              </Stack>
            ) : error ? (
              <Alert color="red" title={t('common.error')}>
                <Stack gap="sm" align="flex-start">
                  <Text size="sm">{error}</Text>
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    leftSection={<IconRefresh size={14} />}
                    onClick={() => setRetryToken((value) => value + 1)}
                  >
                    {t('engineering.list.retryOverview')}
                  </Button>
                </Stack>
              </Alert>
            ) : project ? (
              <Stack gap="xl">
                <Stack gap="sm">
                  <Group gap="xs">
                    <Badge variant="light">{project.domain}</Badge>
                    <Badge variant="light" color="gray">
                      {t('engineering.list.chapterCount', { count: project.stages.length })}
                    </Badge>
                  </Group>
                  <Text c="dimmed">{pick(project.summary)}</Text>
                </Stack>

                <Stack gap="sm">
                  <Divider
                    label={
                      <Group gap={6}>
                        <IconBook2 size={15} />
                        <Text fw={650}>{t('engineering.list.projectIntroduction')}</Text>
                      </Group>
                    }
                    labelPosition="left"
                  />
                  <MarkdownRenderer content={pick(project.brief)} />
                </Stack>

                <Stack gap="sm">
                  <Divider
                    label={<Text fw={650}>{t('engineering.list.chapterIntroduction')}</Text>}
                    labelPosition="left"
                  />
                  <Stack gap="xs">
                    {stages.map((stage, index) => (
                      <Paper key={stage.id} withBorder radius="md" p="md">
                        <Group align="flex-start" gap="md" wrap="nowrap">
                          <Badge
                            variant="light"
                            color="brand"
                            size="lg"
                            style={{ flexShrink: 0 }}
                          >
                            {index + 1}
                          </Badge>
                          <Stack gap={4} style={{ minWidth: 0 }}>
                            <Text fw={650}>{stage.title}</Text>
                            <Text size="sm" c="dimmed" lh={1.6}>
                              {stage.introduction}
                            </Text>
                          </Stack>
                        </Group>
                      </Paper>
                    ))}
                  </Stack>
                </Stack>
              </Stack>
            ) : null}
          </Box>
        </ScrollArea>

        <Group
          justify="flex-end"
          px={{ base: 'md', sm: 'xl' }}
          py="md"
          style={{ borderTop: '1px solid var(--app-border)', flexShrink: 0 }}
        >
          <Button
            size="md"
            fullWidth={isMobile}
            disabled={!project}
            leftSection={<IconPlayerPlay size={17} />}
            onClick={() => project && onStart(project.id)}
          >
            {t('engineering.list.beginProject')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
