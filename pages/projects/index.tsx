import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  Center,
  Container,
  Grid,
  Group,
  Loader,
  Menu,
  Progress,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconClock,
  IconDotsVertical,
  IconSearch,
  IconSparkles,
  IconStack2,
  IconTrash,
  IconTrophy,
} from '@tabler/icons-react';
import { useI18n, useTranslation } from '../../src/contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../../src/components/AppHeader';
import { loadAllProgress, ProjectProgress } from '../../src/lib/engineering/progress';
import type { LocalizedText } from '../../src/lib/engineering/types';
import type { ProjectSummary } from '../../src/lib/server/projectStore';

/** 列表页只拿摘要：完整题库里绝大部分是隐藏用例和参考实现，这里一个都用不上 */
type ProjectWithSource = ProjectSummary;

const difficultyColor = (difficulty: string) =>
  difficulty === 'Easy' ? 'green' : difficulty === 'Medium' ? 'yellow' : 'red';

export default function ProjectsPage() {
  const { t } = useTranslation();
  const { locale } = useI18n();

  const [projects, setProjects] = useState<ProjectWithSource[]>([]);
  const [progressMap, setProgressMap] = useState<Record<string, ProjectProgress>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const pick = (text: LocalizedText | undefined) =>
    !text ? '' : text[locale as 'en' | 'zh'] || text.zh || text.en || '';

  const fetchProjects = async () => {
    try {
      const response = await fetch('/api/projects');
      if (!response.ok) throw new Error('Failed to load projects');
      setProjects(await response.json());
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
    setProgressMap(loadAllProgress());
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return projects;
    const needle = query.toLowerCase();
    return projects.filter((project) =>
      [project.title.zh, project.title.en, project.summary.zh, project.summary.en, ...(project.tags || [])]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle))
    );
  }, [projects, query]);

  const handleDelete = async (project: ProjectWithSource) => {
    if (project.source !== 'user') return;
    const response = await fetch(`/api/projects?id=${encodeURIComponent(project.id)}`, { method: 'DELETE' });
    if (response.ok) setProjects((prev) => prev.filter((item) => item.id !== project.id));
  };

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} padding={{ base: 'sm', md: 'md' }}>
      <AppHeader
        backHref="/"
        title={t('engineering.list.title')}
        actions={
          <Button
            component={Link}
            href="/projects/generator"
            size="xs"
            variant="light"
            color="violet"
            leftSection={<IconSparkles size={14} />}
          >
            {t('engineering.list.generate')}
          </Button>
        }
      />

      <AppShell.Main>
        <Container size="xl" py="md">
          <Stack gap="lg">
            <Stack gap={4}>
              <Title order={2}>{t('engineering.list.heading')}</Title>
              <Text size="sm" c="dimmed" maw={760}>
                {t('engineering.list.subtitle')}
              </Text>
            </Stack>

            <TextInput
              placeholder={t('engineering.list.searchPlaceholder')}
              leftSection={<IconSearch size={15} />}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              maw={420}
            />

            {error && (
              <Alert color="red" title={t('common.error')}>
                {error}
              </Alert>
            )}

            {loading ? (
              <Center py="xl">
                <Loader />
              </Center>
            ) : filtered.length === 0 ? (
              <Center py="xl">
                <Text size="sm" c="dimmed">
                  {t('engineering.list.empty')}
                </Text>
              </Center>
            ) : (
              <Grid>
                {filtered.map((project) => {
                  const progress = progressMap[project.id];
                  const cleared = progress?.completedStages?.length || 0;
                  const total = project.stageCount || 0;
                  const percent = total ? (cleared / total) * 100 : 0;

                  return (
                    <Grid.Col key={project.id} span={{ base: 12, sm: 6, lg: 4 }}>
                      <Card
                        withBorder
                        radius="lg"
                        padding="lg"
                        h="100%"
                        style={{ display: 'flex', flexDirection: 'column' }}
                      >
                        <Group justify="space-between" wrap="nowrap" mb={8}>
                          <Group gap={6} wrap="nowrap">
                            <Badge color={difficultyColor(project.difficulty)} variant="light" size="sm">
                              {t(`homepage.difficulty.${project.difficulty}`)}
                            </Badge>
                            <Badge variant="light" color="gray" size="sm">
                              {project.domain}
                            </Badge>
                            {project.source === 'user' && (
                              <Badge variant="light" color="violet" size="sm">
                                AI
                              </Badge>
                            )}
                          </Group>
                          {project.source === 'user' && (
                            <Menu position="bottom-end" withinPortal>
                              <Menu.Target>
                                <ActionIcon variant="subtle" color="gray" size="sm">
                                  <IconDotsVertical size={14} />
                                </ActionIcon>
                              </Menu.Target>
                              <Menu.Dropdown>
                                <Menu.Item
                                  color="red"
                                  leftSection={<IconTrash size={14} />}
                                  onClick={() => handleDelete(project)}
                                >
                                  {t('manage.delete')}
                                </Menu.Item>
                              </Menu.Dropdown>
                            </Menu>
                          )}
                        </Group>

                        <Title order={4} mb={6}>
                          {pick(project.title)}
                        </Title>
                        <Text size="sm" c="dimmed" mb="md" lineClamp={3} style={{ flex: 1 }}>
                          {pick(project.summary)}
                        </Text>

                        <Group gap="md" mb="sm">
                          <Tooltip label={t('engineering.list.stages')}>
                            <Group gap={4}>
                              <IconStack2 size={14} />
                              <Text size="xs" c="dimmed">
                                {total}
                              </Text>
                            </Group>
                          </Tooltip>
                          {project.estimatedMinutes && (
                            <Group gap={4}>
                              <IconClock size={14} />
                              <Text size="xs" c="dimmed">
                                ~{project.estimatedMinutes}min
                              </Text>
                            </Group>
                          )}
                          {cleared > 0 && (
                            <Group gap={4}>
                              <IconTrophy size={14} color="var(--mantine-color-teal-filled)" />
                              <Text size="xs" c="dimmed">
                                {cleared}/{total}
                              </Text>
                            </Group>
                          )}
                        </Group>

                        {cleared > 0 && (
                          <Progress
                            value={percent}
                            color={percent === 100 ? 'teal' : 'brand'}
                            size="xs"
                            radius="xl"
                            mb="sm"
                          />
                        )}

                        <Button component={Link} href={`/projects/${project.id}`} fullWidth variant="light">
                          {cleared > 0 ? t('engineering.list.continue') : t('engineering.list.start')}
                        </Button>
                      </Card>
                    </Grid.Col>
                  );
                })}
              </Grid>
            )}
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
