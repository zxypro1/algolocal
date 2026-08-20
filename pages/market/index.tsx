/**
 * 题目市场
 *
 * 这是一个纯粹的云端界面，所以它挂载时会探测一次（useCloudSurface）。
 * 探测失败不会抛错，只会渲染成离线态 —— 用户从首页点进来，看到一句
 * 「现在连不上」和一个回到工坊的入口，比看到一个转不完的圈好。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AppShell,
  Badge,
  Button,
  Container,
  Grid,
  Group,
  Pagination,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconBuildingFactory2, IconSearch, IconTool, IconUser } from '@tabler/icons-react';
import { AppHeader, HEADER_HEIGHT } from '../../src/components/AppHeader';
import { CloudGate } from '../../src/components/cloud/CloudGate';
import { ListingCard } from '../../src/components/cloud/ListingCard';
import { useCloudSurface } from '../../src/contexts/CloudContext';
import { useTranslation } from '../../src/contexts/I18nContext';
import * as api from '../../src/lib/cloud/api';
import { CloudError } from '../../src/lib/cloud/client';
import type { ListingKind, ListingPage, ListingSummary } from '../../src/lib/cloud/types';

const PAGE_SIZE = 24;

export default function MarketPage() {
  const { t } = useTranslation();
  const { status, user } = useCloudSurface();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [kind, setKind] = useState<'all' | ListingKind>('all');
  const [difficulty, setDifficulty] = useState<string | null>(null);
  const [sort, setSort] = useState<string>('recent');
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<ListingPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  // 每敲一个字就查一次会把搜索框变成一个压测工具
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => setPage(1), [debouncedSearch, kind, difficulty, sort]);

  useEffect(() => {
    if (status !== 'online') return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    api
      .fetchListings(
        {
          kind: kind === 'all' ? undefined : kind,
          difficulty: (difficulty as 'Easy' | 'Medium' | 'Hard' | null) || undefined,
          search: debouncedSearch || undefined,
          sort: sort as 'recent' | 'stars' | 'downloads',
          page,
          pageSize: PAGE_SIZE,
        },
        controller.signal
      )
      .then(setResult)
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof CloudError ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [status, kind, difficulty, sort, debouncedSearch, page]);

  const toggleStar = useCallback(
    async (listing: ListingSummary) => {
      setBusySlug(listing.slug);
      const next = !listing.starred;

      // 先改本地再发请求：star 是一个高频的小动作，等一个往返才亮起来会很迟钝
      setResult((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.slug === listing.slug
                  ? { ...item, starred: next, starCount: item.starCount + (next ? 1 : -1) }
                  : item
              ),
            }
          : current
      );

      try {
        const response = await api.starListing(listing.slug, next);
        setResult((current) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.slug === listing.slug
                    ? { ...item, starred: response.starred, starCount: response.starCount }
                    : item
                ),
              }
            : current
        );
      } catch (cause) {
        // 回滚，并把原因说出来
        setResult((current) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.slug === listing.slug
                    ? { ...item, starred: listing.starred, starCount: listing.starCount }
                    : item
                ),
              }
            : current
        );
        setError(cause instanceof CloudError ? cause.message : String(cause));
      } finally {
        setBusySlug(null);
      }
    },
    []
  );

  const totalPages = useMemo(
    () => (result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1),
    [result]
  );

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} padding={0}>
      <AppHeader
        backHref="/"
        title={t('market.title')}
        actions={
          <Group gap="xs">
            <Button component={Link} href="/workshop" size="xs" variant="light" leftSection={<IconTool size={14} />}>
              {t('workshop.title')}
            </Button>
            <Button
              component={Link}
              href="/account"
              size="xs"
              variant="subtle"
              leftSection={<IconUser size={14} />}
            >
              {user ? user.displayName : t('account.signIn')}
            </Button>
          </Group>
        }
      />

      <AppShell.Main>
        <Container size="xl" py="lg">
          <Stack gap="lg">
            <Stack gap={4}>
              <Title order={1}>{t('market.title')}</Title>
              <Text c="dimmed" size="sm">
                {t('market.subtitle')}
              </Text>
            </Stack>

            <CloudGate status={status}>
              <Stack gap="md">
                <Paper p="sm" withBorder>
                  <Group gap="sm" wrap="wrap">
                    <TextInput
                      flex="1 1 220px"
                      leftSection={<IconSearch size={15} />}
                      placeholder={t('market.searchPlaceholder')}
                      value={search}
                      onChange={(event) => setSearch(event.currentTarget.value)}
                    />
                    <SegmentedControl
                      size="xs"
                      value={kind}
                      onChange={(value) => setKind(value as 'all' | ListingKind)}
                      data={[
                        { value: 'all', label: t('market.kindAll') },
                        { value: 'algorithm', label: t('market.kindAlgorithm') },
                        { value: 'engineering', label: t('market.kindEngineering') },
                      ]}
                    />
                    <Select
                      w={130}
                      size="xs"
                      clearable
                      placeholder={t('homepage.allDifficulties')}
                      value={difficulty}
                      onChange={setDifficulty}
                      data={[
                        { value: 'Easy', label: t('homepage.difficulty.Easy') },
                        { value: 'Medium', label: t('homepage.difficulty.Medium') },
                        { value: 'Hard', label: t('homepage.difficulty.Hard') },
                      ]}
                    />
                    <Select
                      w={150}
                      size="xs"
                      allowDeselect={false}
                      value={sort}
                      onChange={(value) => setSort(value || 'recent')}
                      data={[
                        { value: 'recent', label: t('market.sortRecent') },
                        { value: 'stars', label: t('market.sortStars') },
                        { value: 'downloads', label: t('market.sortDownloads') },
                      ]}
                    />
                  </Group>
                </Paper>

                {error && (
                  <Text size="sm" c="red">
                    {error}
                  </Text>
                )}

                {result && (
                  <Group justify="space-between">
                    <Text size="xs" c="dimmed">
                      {t('market.resultCount', { count: result.total })}
                    </Text>
                    {loading && (
                      <Badge size="xs" variant="light">
                        {t('common.loading')}
                      </Badge>
                    )}
                  </Group>
                )}

                {result && result.items.length === 0 && !loading && (
                  <Paper p="xl" withBorder>
                    <Stack align="center" gap="xs">
                      <IconBuildingFactory2 size={28} style={{ opacity: 0.35 }} />
                      <Text size="sm" c="dimmed">
                        {t('market.empty')}
                      </Text>
                      <Button component={Link} href="/workshop" size="xs" variant="light">
                        {t('market.emptyAction')}
                      </Button>
                    </Stack>
                  </Paper>
                )}

                <Grid gutter="sm">
                  {(result?.items || []).map((listing) => (
                    <Grid.Col key={listing.slug} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
                      <ListingCard
                        listing={listing}
                        busy={busySlug === listing.slug}
                        onToggleStar={user ? toggleStar : undefined}
                      />
                    </Grid.Col>
                  ))}
                </Grid>

                {totalPages > 1 && (
                  <Group justify="center">
                    <Pagination size="sm" total={totalPages} value={page} onChange={setPage} />
                  </Group>
                )}
              </Stack>
            </CloudGate>
          </Stack>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
