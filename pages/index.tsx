import Link from 'next/link';
import { useState, useEffect, useMemo, ReactNode } from 'react';
import {
  Container,
  Text,
  Card,
  Group,
  Badge,
  Grid,
  Stack,
  Center,
  Divider,
  Loader,
  Alert,
  TextInput,
  Select,
  MultiSelect,
  Button,
  Paper,
  AppShell,
  Table,
  ActionIcon,
  Tooltip,
  Drawer,
  ThemeIcon,
} from '@mantine/core';
import {
  IconLayoutGrid,
  IconList,
  IconMenu2,
  IconChartBar,
  IconPlus,
  IconRobot,
  IconPackage,
  IconSettings,
  IconSearch,
  IconCircleCheckFilled,
  IconProgress,
  IconMoodEmpty,
} from '@tabler/icons-react';
import { useTranslation, useI18n } from '../src/contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../src/components/AppHeader';
import { buildProblemStatusIndex, loadPracticeAttemptEvents, PRACTICE_STATS_UPDATED_EVENT } from '../src/lib/practiceStats';

type Problem = {
  id: string;
  title: { en: string; zh: string };
  difficulty: string;
  tags: string[];
  description: { en: string; zh: string };
};

const getDifficultyColor = (difficulty: string) => {
  switch (difficulty) {
    case 'Easy': return 'green';
    case 'Medium': return 'yellow';
    case 'Hard': return 'red';
    default: return 'gray';
  }
};

// 卡片摘要里直接渲染 markdown 源码会很乱，这里做一次轻量去标记
const toPlainPreview = (markdown: string) =>
  markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export default function Home() {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [problemStatusIndex, setProblemStatusIndex] = useState<Map<string, { attempted: boolean; solved: boolean; lastTs: string }>>(
    new Map()
  );

  // Search and filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDifficulties, setSelectedDifficulties] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [drawerOpened, setDrawerOpened] = useState(false);

  // Column widths for list view table
  const [columnWidths, setColumnWidths] = useState({
    status: 100,
    title: 400,
    difficulty: 150,
    tags: 300
  });

  useEffect(() => {
    setMounted(true);
    // Load view mode preference from localStorage
    const savedViewMode = localStorage.getItem('problemViewMode');
    if (savedViewMode === 'grid' || savedViewMode === 'list') {
      setViewMode(savedViewMode);
    }
    // Load column widths from localStorage
    const savedWidths = localStorage.getItem('tableColumnWidths');
    if (savedWidths) {
      try {
        setColumnWidths(JSON.parse(savedWidths));
      } catch (e) {
        console.error('Failed to parse saved column widths', e);
      }
    }
  }, []);

  // Save column widths to localStorage when they change
  useEffect(() => {
    if (mounted) {
      localStorage.setItem('tableColumnWidths', JSON.stringify(columnWidths));
    }
  }, [columnWidths, mounted]);

  // Save view mode preference
  useEffect(() => {
    if (mounted) {
      localStorage.setItem('problemViewMode', viewMode);
    }
  }, [viewMode, mounted]);

  useEffect(() => {
    if (!mounted) return;

    const refresh = () => {
      const events = loadPracticeAttemptEvents();
      setProblemStatusIndex(buildProblemStatusIndex(events));
    };

    refresh();

    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.includes('practice-attempt-events-v1')) refresh();
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(PRACTICE_STATS_UPDATED_EVENT, refresh as any);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(PRACTICE_STATS_UPDATED_EVENT, refresh as any);
    };
  }, [mounted]);

  useEffect(() => {
    const fetchProblems = async () => {
      try {
        const response = await fetch('/api/problems');
        if (!response.ok) {
          throw new Error('Failed to fetch problems');
        }
        const data = await response.json();
        setProblems(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load problems');
      } finally {
        setLoading(false);
      }
    };

    fetchProblems();
  }, []);

  // Get unique difficulties and tags for filter options
  const { difficulties, allTags } = useMemo(() => {
    const uniqueDifficulties = Array.from(new Set(problems.map(p => p.difficulty)));
    const uniqueTags = Array.from(new Set(problems.flatMap(p => p.tags || [])));
    return {
      difficulties: uniqueDifficulties,
      allTags: uniqueTags
    };
  }, [problems]);

  // Filter and search logic
  const filteredProblems = useMemo(() => {
    return problems.filter(problem => {
      // Search filter
      const searchLower = searchQuery.toLowerCase();
      const titleMatch = problem.title.en.toLowerCase().includes(searchLower) ||
                         problem.title.zh.toLowerCase().includes(searchLower);
      const descMatch = problem.description.en.toLowerCase().includes(searchLower) ||
                        problem.description.zh.toLowerCase().includes(searchLower);
      const searchMatch = !searchQuery || titleMatch || descMatch;

      // Difficulty filter
      const difficultyMatch = selectedDifficulties.length === 0 ||
                             selectedDifficulties.includes(problem.difficulty);

      // Tag filter
      const tagMatch = selectedTags.length === 0 ||
                       selectedTags.some(tag => problem.tags?.includes(tag));

      return searchMatch && difficultyMatch && tagMatch;
    });
  }, [problems, searchQuery, selectedDifficulties, selectedTags]);

  // Clear all filters
  const clearFilters = () => {
    setSearchQuery('');
    setSelectedDifficulties([]);
    setSelectedTags([]);
  };

  // Check if any filters are applied
  const hasActiveFilters = searchQuery || selectedDifficulties.length > 0 || selectedTags.length > 0;

  const tagLabel = (tag: string) => (t(`tags.${tag}`) !== `tags.${tag}` ? t(`tags.${tag}`) : tag);

  const menuButton = (
    <Tooltip label={t('common.navigation')}>
      <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => setDrawerOpened(true)}>
        <IconMenu2 size={18} />
      </ActionIcon>
    </Tooltip>
  );

  // 加载 / 出错状态复用同一个外壳，避免顶栏结构在各分支间漂移
  const renderShell = (children: ReactNode) => (
    <AppShell header={{ height: HEADER_HEIGHT }} padding={{ base: 'sm', md: 'md' }}>
      <AppHeader />
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );

  // Prevent hydration mismatch by waiting for client-side mount
  if (!mounted || loading) {
    return renderShell(
      <Center style={{ minHeight: '60vh' }}>
        <Stack align="center" gap="md">
          <Loader size="md" />
          <Text size="sm" c="dimmed">{t('common.loading')}</Text>
        </Stack>
      </Center>
    );
  }

  if (error) {
    return renderShell(
      <Center style={{ minHeight: '60vh' }}>
        <Alert color="red" title={t('common.error')} maw={480}>
          {error}
        </Alert>
      </Center>
    );
  }

  // 列表视图的可拖拽列头
  const resizableTh = (key: keyof typeof columnWidths, label: string, minWidth: number, resizable = true) => (
    <Table.Th style={{ position: 'relative', padding: '12px' }}>
      {label}
      {resizable && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: '5px',
            cursor: 'col-resize',
            userSelect: 'none',
            backgroundColor: 'transparent'
          }}
          onMouseDown={(e) => {
            const startX = e.pageX;
            const startWidth = columnWidths[key];
            const handleMouseMove = (ev: MouseEvent) => {
              const newWidth = Math.max(minWidth, startWidth + ev.pageX - startX);
              setColumnWidths(prev => ({ ...prev, [key]: newWidth }));
            };
            const handleMouseUp = () => {
              document.removeEventListener('mousemove', handleMouseMove);
              document.removeEventListener('mouseup', handleMouseUp);
            };
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
          }}
        />
      )}
    </Table.Th>
  );

  const statusIndicator = (id: string, compact = false) => {
    const st = problemStatusIndex.get(id);
    if (!st?.attempted) return null;
    const solved = st.solved;
    const label = solved ? t('homepage.problemStatus.solved') : t('homepage.problemStatus.attempted');
    return (
      <Tooltip label={label}>
        <ThemeIcon
          variant="light"
          color={solved ? 'green' : 'blue'}
          size={compact ? 22 : 26}
          radius="xl"
        >
          {solved ? <IconCircleCheckFilled size={compact ? 14 : 16} /> : <IconProgress size={compact ? 14 : 16} />}
        </ThemeIcon>
      </Tooltip>
    );
  };

  return (
    <AppShell
      header={{ height: HEADER_HEIGHT }}
      navbar={{ width: 288, breakpoint: 'md', collapsed: { mobile: true } }}
      padding={{ base: 'sm', md: 'lg' }}
    >
      <AppHeader actions={menuButton} />

      {/* Left Sidebar with search and filters */}
      <AppShell.Navbar p="md" withBorder>
        <AppShell.Section grow style={{ overflowY: 'auto' }}>
          <Stack gap="lg">
            <Group justify="space-between" align="center">
              <Text fw={650} size="sm">{t('homepage.problemList')}</Text>
              {/* View Mode Toggle */}
              <Group gap={2}>
                <Tooltip label={t('homepage.viewMode.grid')}>
                  <ActionIcon
                    variant={viewMode === 'grid' ? 'light' : 'subtle'}
                    color={viewMode === 'grid' ? 'brand' : 'gray'}
                    size="md"
                    onClick={() => setViewMode('grid')}
                  >
                    <IconLayoutGrid size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t('homepage.viewMode.list')}>
                  <ActionIcon
                    variant={viewMode === 'list' ? 'light' : 'subtle'}
                    color={viewMode === 'list' ? 'brand' : 'gray'}
                    size="md"
                    onClick={() => setViewMode('list')}
                  >
                    <IconList size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>

            <Divider />

            {/* Search Section */}
            <Stack gap={8}>
              <Text className="app-section-label">{t('homepage.search')}</Text>
              <TextInput
                placeholder={t('homepage.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.currentTarget.value)}
                leftSection={<IconSearch size={15} />}
                size="sm"
              />
            </Stack>

            {/* Difficulty Filter */}
            <Stack gap={8}>
              <Text className="app-section-label">{t('homepage.filterByDifficulty')}</Text>
              <Select
                placeholder={t('homepage.allDifficulties')}
                data={difficulties.map(diff => ({
                  value: diff,
                  label: t(`homepage.difficulty.${diff}`)
                }))}
                value={selectedDifficulties.length === 1 ? selectedDifficulties[0] : null}
                onChange={(value) => setSelectedDifficulties(value ? [value] : [])}
                clearable
                size="sm"
              />
            </Stack>

            {/* Tag Filter */}
            <Stack gap={8}>
              <Text className="app-section-label">{t('homepage.filterByTags')}</Text>
              <MultiSelect
                placeholder={selectedTags.length ? undefined : t('homepage.allTags')}
                data={allTags.map(tag => ({ value: tag, label: tagLabel(tag) }))}
                value={selectedTags}
                onChange={setSelectedTags}
                searchable
                limit={20}
                size="sm"
                maxValues={10}
              />
            </Stack>

            {/* Clear Filters Button */}
            {hasActiveFilters && (
              <Button variant="light" color="gray" onClick={clearFilters} fullWidth size="xs">
                {t('homepage.clearFilters')}
              </Button>
            )}
          </Stack>
        </AppShell.Section>

        {/* Result Counter */}
        <AppShell.Section>
          <Divider mb="sm" />
          <Text size="xs" c="dimmed" ta="center">
            {t('homepage.showingResults')} {filteredProblems.length} {t('homepage.of')} {problems.length} {t('homepage.problems')}
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>

      {/* Main content area with problem list */}
      <AppShell.Main>
        <Container fluid p={0}>
          {filteredProblems.length === 0 ? (
            <Center mih="60vh">
              <Stack align="center" gap="sm">
                <ThemeIcon variant="light" color="gray" size={54} radius="xl">
                  <IconMoodEmpty size={28} />
                </ThemeIcon>
                <Text fw={600}>{t('homepage.noResults')}</Text>
                {hasActiveFilters && (
                  <Button variant="light" size="xs" onClick={clearFilters}>
                    {t('homepage.clearFilters')}
                  </Button>
                )}
              </Stack>
            </Center>
          ) : viewMode === 'grid' ? (
            <Grid gutter="md" style={{ margin: 0 }}>
              {filteredProblems.map((problem) => (
                <Grid.Col key={problem.id} span={{ base: 12, sm: 6, xl: 4 }}>
                  <Card
                    className="app-hover-card"
                    padding="lg"
                    radius="lg"
                    withBorder
                    style={{ height: '100%', cursor: 'pointer' }}
                    component={Link}
                    href={`/problems/${problem.id}`}
                  >
                    <Stack gap="sm" h="100%">
                      <Group justify="space-between" align="center" wrap="nowrap">
                        <Badge
                          color={getDifficultyColor(problem.difficulty)}
                          variant="light"
                          size="sm"
                          leftSection={
                            <span
                              style={{
                                display: 'inline-block',
                                width: 6,
                                height: 6,
                                borderRadius: '50%',
                                background: `var(--mantine-color-${getDifficultyColor(problem.difficulty)}-filled)`,
                              }}
                            />
                          }
                        >
                          {t(`homepage.difficulty.${problem.difficulty}`)}
                        </Badge>
                        {statusIndicator(problem.id)}
                      </Group>

                      <div style={{ flex: 1 }}>
                        <Text fw={620} size="md" lineClamp={1} mb={6}>
                          {problem.title[locale as keyof typeof problem.title] || problem.title.zh}
                        </Text>
                        <Text size="xs" c="dimmed" lineClamp={2} style={{ lineHeight: 1.6 }}>
                          {toPlainPreview(
                            problem.description[locale as keyof typeof problem.description] || problem.description.zh
                          )}
                        </Text>
                      </div>

                      <Group gap={6} style={{ flexWrap: 'wrap' }}>
                        {problem.tags?.slice(0, 3).map((tag) => (
                          <Badge key={tag} color="gray" variant="light" size="xs" style={{ flexShrink: 0 }}>
                            {tagLabel(tag)}
                          </Badge>
                        ))}
                        {problem.tags?.length > 3 && (
                          <Badge color="gray" variant="light" size="xs" style={{ flexShrink: 0 }}>
                            +{problem.tags.length - 3}
                          </Badge>
                        )}
                      </Group>
                    </Stack>
                  </Card>
                </Grid.Col>
              ))}
            </Grid>
          ) : (
            <Card padding={0} radius="lg" withBorder style={{ overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <Table
                  highlightOnHover
                  verticalSpacing="sm"
                  style={{ tableLayout: 'fixed', width: '100%' }}
                >
                  <colgroup>
                    <col style={{ width: `${columnWidths.status}px` }} />
                    <col style={{ width: `${columnWidths.title}px` }} />
                    <col style={{ width: `${columnWidths.difficulty}px` }} />
                    <col style={{ width: `${columnWidths.tags}px` }} />
                  </colgroup>
                  <Table.Thead>
                    <Table.Tr>
                      {resizableTh('status', t('homepage.table.status'), 50)}
                      {resizableTh('title', t('homepage.table.title'), 100)}
                      {resizableTh('difficulty', t('homepage.table.difficulty'), 80)}
                      {resizableTh('tags', t('homepage.table.tags'), 80, false)}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {filteredProblems.map((problem) => (
                      <Table.Tr
                        key={problem.id}
                        style={{ cursor: 'pointer' }}
                        onClick={() => window.location.href = `/problems/${problem.id}`}
                      >
                        <Table.Td style={{ overflow: 'hidden' }}>
                          {statusIndicator(problem.id, true)}
                        </Table.Td>
                        <Table.Td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <Text fw={550} size="sm">
                            {problem.title[locale as keyof typeof problem.title] || problem.title.zh}
                          </Text>
                        </Table.Td>
                        <Table.Td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <Badge
                            color={getDifficultyColor(problem.difficulty)}
                            variant="light"
                            size="sm"
                          >
                            {t(`homepage.difficulty.${problem.difficulty}`)}
                          </Badge>
                        </Table.Td>
                        <Table.Td style={{ overflow: 'hidden' }}>
                          <Group gap={6} wrap="nowrap">
                            {problem.tags?.slice(0, 2).map((tag) => (
                              <Badge key={tag} color="gray" variant="light" size="xs">
                                {tagLabel(tag)}
                              </Badge>
                            ))}
                            {problem.tags?.length > 2 && (
                              <Badge color="gray" variant="light" size="xs">
                                +{problem.tags.length - 2}
                              </Badge>
                            )}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            </Card>
          )}
        </Container>
      </AppShell.Main>

      {/* Navigation Drawer */}
      <NavigationDrawer opened={drawerOpened} onClose={() => setDrawerOpened(false)} />
    </AppShell>
  );
}

type NavEntry = {
  href: string;
  color: string;
  icon: ReactNode;
  labelKey: string;
  descKey: string;
  descFallback: string;
};

function NavigationDrawer({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();

  const sections: { titleKey: string; titleFallback: string; items: NavEntry[] }[] = [
    {
      titleKey: 'common.practice',
      titleFallback: 'Practice',
      items: [
        {
          href: '/stats',
          color: 'grape',
          icon: <IconChartBar size={20} />,
          labelKey: 'homepage.stats.jumpToDashboard',
          descKey: 'navigation.statsDesc',
          descFallback: 'View your progress',
        },
      ],
    },
    {
      titleKey: 'common.content',
      titleFallback: 'Content',
      items: [
        {
          href: '/add-problem',
          color: 'blue',
          icon: <IconPlus size={20} />,
          labelKey: 'homepage.addProblem',
          descKey: 'navigation.addDesc',
          descFallback: 'Create new problem',
        },
        {
          href: '/generator',
          color: 'violet',
          icon: <IconRobot size={20} />,
          labelKey: 'homepage.aiGenerator',
          descKey: 'navigation.aiDesc',
          descFallback: 'Generate with AI',
        },
        {
          href: '/manage',
          color: 'teal',
          icon: <IconPackage size={20} />,
          labelKey: 'manage.manageProblems',
          descKey: 'navigation.manageDesc',
          descFallback: 'Manage problems',
        },
      ],
    },
    {
      titleKey: 'common.system',
      titleFallback: 'System',
      items: [
        {
          href: '/settings',
          color: 'gray',
          icon: <IconSettings size={20} />,
          labelKey: 'common.settings',
          descKey: 'navigation.settingsDesc',
          descFallback: 'App settings',
        },
      ],
    },
  ];

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      title={<Text fw={650}>{t('common.navigation')}</Text>}
      padding="lg"
      size="sm"
    >
      <Stack gap="lg">
        {sections.map((section) => (
          <Stack key={section.titleKey} gap={8}>
            <Text className="app-section-label" px={4}>
              {t(section.titleKey) || section.titleFallback}
            </Text>
            <Stack gap={6}>
              {section.items.map((item) => (
                <Paper
                  key={item.href}
                  component={Link}
                  href={item.href}
                  p="sm"
                  radius="md"
                  withBorder
                  className="app-nav-item"
                  onClick={onClose}
                  style={{ cursor: 'pointer', display: 'block' }}
                >
                  <Group gap="sm" wrap="nowrap">
                    <ThemeIcon variant="light" color={item.color} size={38} radius="md">
                      {item.icon}
                    </ThemeIcon>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text fw={550} size="sm">{t(item.labelKey)}</Text>
                      <Text size="xs" c="dimmed">{t(item.descKey) || item.descFallback}</Text>
                    </div>
                  </Group>
                </Paper>
              ))}
            </Stack>
          </Stack>
        ))}
      </Stack>
    </Drawer>
  );
}
