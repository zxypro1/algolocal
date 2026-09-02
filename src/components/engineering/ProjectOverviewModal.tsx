import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconArrowRight,
  IconBook2,
  IconListDetails,
  IconRefresh,
} from '@tabler/icons-react';
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

  const projectTitle = project ? pick(project.title) : pick(summary?.title);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Text size="sm" fw={700} c="dimmed">
          {t('engineering.list.overviewTitle')}
        </Text>
      }
      size={1080}
      radius="xl"
      fullScreen={isMobile}
      centered={!isMobile}
      overlayProps={{ backgroundOpacity: 0.68, blur: 3 }}
      styles={{
        content: {
          overflow: 'hidden',
          border: isMobile ? 'none' : '1px solid var(--app-border)',
          boxShadow: 'var(--app-shadow)',
        },
        header: {
          minHeight: 58,
          paddingInline: isMobile ? 'var(--mantine-spacing-md)' : 'var(--mantine-spacing-lg)',
          borderBottom: '1px solid var(--app-border)',
          background: 'var(--app-surface)',
        },
        body: { padding: 0, background: 'var(--app-bg)' },
      }}
    >
      <Stack
        gap={0}
        style={{ height: isMobile ? 'calc(100dvh - 58px)' : 'min(80vh, 820px)' }}
      >
        <ScrollArea
          className="project-overview-scroll"
          scrollbarSize={8}
          style={{ flex: 1, minHeight: 0 }}
          styles={{ viewport: { overflowX: 'hidden' } }}
        >
          <Box
            className="project-overview-content"
            px={{ base: 'sm', sm: 'xl' }}
            py={{ base: 'md', sm: 'xl' }}
          >
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
              <Stack gap={isMobile ? 'md' : 'xl'}>
                <Paper className="project-overview-hero" withBorder radius="xl" p={{ base: 'lg', sm: 'xl' }}>
                  <Group align="flex-start" gap="lg" wrap="nowrap">
                    <ThemeIcon
                      variant="light"
                      color="brand"
                      radius="lg"
                      size={46}
                      style={{ flexShrink: 0 }}
                    >
                      <IconBook2 size={23} />
                    </ThemeIcon>
                    <Stack gap="sm" style={{ minWidth: 0 }}>
                      <Group gap="xs">
                        <Badge variant="light">{project.domain}</Badge>
                        <Badge variant="light" color="gray">
                          {t('engineering.list.chapterCount', { count: project.stages.length })}
                        </Badge>
                      </Group>
                      <Title order={2} fz={{ base: 23, sm: 30 }} lh={1.25}>
                        {projectTitle}
                      </Title>
                      <Text c="dimmed" size={isMobile ? 'sm' : 'md'} lh={1.7} maw={760}>
                        {pick(project.summary)}
                      </Text>
                    </Stack>
                  </Group>
                </Paper>

                <Paper className="project-overview-section" withBorder radius="xl" p={{ base: 'lg', sm: 'xl' }}>
                  <Group gap="sm" mb="lg">
                    <ThemeIcon variant="light" color="brand" radius="md" size="lg">
                      <IconBook2 size={17} />
                    </ThemeIcon>
                    <Title order={3} fz={{ base: 'lg', sm: 'xl' }}>
                      {t('engineering.list.projectIntroduction')}
                    </Title>
                  </Group>
                  <Box className="project-overview-markdown">
                    <MarkdownRenderer content={pick(project.brief)} />
                  </Box>
                </Paper>

                <Stack gap="md">
                  <Group gap="sm" px={{ base: 4, sm: 8 }}>
                    <ThemeIcon variant="light" color="brand" radius="md" size="lg">
                      <IconListDetails size={17} />
                    </ThemeIcon>
                    <Title order={3} fz={{ base: 'lg', sm: 'xl' }}>
                      {t('engineering.list.chapterIntroduction')}
                    </Title>
                  </Group>
                  <Paper withBorder radius="xl" className="project-overview-stage-list">
                    {stages.map((stage, index) => (
                      <Box key={stage.id} className="project-overview-stage" px={{ base: 'md', sm: 'lg' }} py="md">
                        <Group align="flex-start" gap="md" wrap="nowrap">
                          <ThemeIcon
                            variant="light"
                            color="brand"
                            radius="xl"
                            size={34}
                            fw={700}
                            style={{ flexShrink: 0 }}
                          >
                            {index + 1}
                          </ThemeIcon>
                          <Stack gap={3} style={{ minWidth: 0 }}>
                            <Text fw={650} lh={1.45}>{stage.title}</Text>
                            <Text size="sm" c="dimmed" lh={1.65}>
                              {stage.introduction}
                            </Text>
                          </Stack>
                        </Group>
                      </Box>
                    ))}
                  </Paper>
                </Stack>
              </Stack>
            ) : null}
          </Box>
        </ScrollArea>

        <Group
          justify="flex-end"
          px={{ base: 'md', sm: 'xl' }}
          py="md"
          style={{
            borderTop: '1px solid var(--app-border)',
            background: 'var(--app-surface)',
            flexShrink: 0,
          }}
        >
          <Button
            size="sm"
            radius="md"
            fullWidth={isMobile}
            disabled={!project}
            rightSection={<IconArrowRight size={16} />}
            onClick={() => project && onStart(project.id)}
          >
            {t('engineering.list.beginProject')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
