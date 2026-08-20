/**
 * 市场详情页
 *
 * 这里是唯一一个「别人写的内容进入你机器」的入口，所以页面上有一句明确的
 * 提示：题目自带的用例和参考实现会在你本地执行。执行本身跑在 WASM 沙箱和
 * Web Worker 里（和你自己写的代码同一条路径），但用户有权知道这件事。
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Group,
  List,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconDownload,
  IconFileDownload,
  IconStar,
  IconStarFilled,
  IconTrash,
} from '@tabler/icons-react';
import { AppHeader, HEADER_HEIGHT } from '../../src/components/AppHeader';
import { CloudGate } from '../../src/components/cloud/CloudGate';
import MarkdownRenderer from '../../src/components/MarkdownRenderer';
import { useCloudSurface } from '../../src/contexts/CloudContext';
import { useI18n, useTranslation } from '../../src/contexts/I18nContext';
import { useEnvironment } from '../../src/hooks/useEnvironment';
import * as api from '../../src/lib/cloud/api';
import { CloudError } from '../../src/lib/cloud/client';
import { downloadAsFile, installListing, InstallError } from '../../src/lib/cloud/install';
import type { ListingDetail } from '../../src/lib/cloud/types';
import type { EngineeringProject } from '../../src/lib/engineering/types';
import type { AlgorithmProblem } from '../../src/lib/workshop/problem';

const DIFFICULTY_COLORS: Record<string, string> = { Easy: 'green', Medium: 'yellow', Hard: 'red' };

export default function ListingDetailPage() {
  const router = useRouter();
  const slug = typeof router.query.slug === 'string' ? router.query.slug : '';
  const { t } = useTranslation();
  const { locale } = useI18n();
  const language = locale === 'en' ? 'en' : 'zh';
  const { status, user } = useCloudSurface();
  const { environment } = useEnvironment();

  const [listing, setListing] = useState<ListingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!slug || status !== 'online') return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    api
      .fetchListing(slug, controller.signal)
      .then(setListing)
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof CloudError ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [slug, status]);

  const toggleStar = useCallback(async () => {
    if (!listing || !user) return;
    const next = !listing.starred;
    try {
      const response = await api.starListing(listing.slug, next);
      setListing({ ...listing, starred: response.starred, starCount: response.starCount });
    } catch (cause) {
      setNotice({ kind: 'error', text: cause instanceof CloudError ? cause.message : String(cause) });
    }
  }, [listing, user]);

  const install = useCallback(async () => {
    if (!listing) return;
    setInstalling(true);
    setNotice(null);

    try {
      // 走 /download 而不是用详情里已有的 payload：下载量要算，而且详情
      // 可能是缓存的旧版本
      const fresh = await api.downloadListing(listing.slug);
      setListing((current) => (current ? { ...current, downloadCount: fresh.downloadCount } : fresh));

      if (!environment.writableLibrary) {
        downloadAsFile(fresh.slug, fresh.payload);
        setNotice({ kind: 'success', text: t('market.exported') });
        return;
      }

      const installedId = await installListing(fresh.kind, fresh.payload);
      setNotice({
        kind: 'success',
        text: t('market.installed', { id: installedId }),
      });
    } catch (cause) {
      if (cause instanceof InstallError && cause.readOnly) {
        setNotice({ kind: 'error', text: t('market.readOnlyLibrary') });
      } else {
        setNotice({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
      }
    } finally {
      setInstalling(false);
    }
  }, [listing, environment.writableLibrary, t]);

  const remove = useCallback(async () => {
    if (!listing) return;
    if (!window.confirm(t('market.confirmDelete', { title: listing.title[language] }))) return;

    try {
      await api.deleteListing(listing.slug);
      router.push('/market');
    } catch (cause) {
      setNotice({ kind: 'error', text: cause instanceof CloudError ? cause.message : String(cause) });
    }
  }, [listing, language, router, t]);

  const isOwner = Boolean(user && listing && user.id === listing.author.id);
  const problem = listing?.kind === 'algorithm' ? (listing.payload as AlgorithmProblem) : null;
  const project = listing?.kind === 'engineering' ? (listing.payload as EngineeringProject) : null;

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} padding={0}>
      <AppHeader backHref="/market" title={t('market.title')} />

      <AppShell.Main>
        <Container size="lg" py="lg">
          <CloudGate status={status}>
            {loading && (
              <Group gap="xs" py="xl" justify="center">
                <Loader size="sm" />
                <Text size="sm" c="dimmed">
                  {t('common.loading')}
                </Text>
              </Group>
            )}

            {error && !loading && (
              <Alert color="red" title={t('common.error')}>
                {error}
              </Alert>
            )}

            {listing && !loading && (
              <Stack gap="lg">
                <Group justify="space-between" align="flex-start" wrap="wrap">
                  <Stack gap={6} style={{ minWidth: 0, flex: '1 1 320px' }}>
                    <Title order={1}>{listing.title[language] || listing.title.en}</Title>
                    <Text c="dimmed" size="sm">
                      {listing.summary[language] || listing.summary.en}
                    </Text>
                    <Group gap={6}>
                      <Badge size="sm" color={DIFFICULTY_COLORS[listing.difficulty] || 'gray'} variant="light">
                        {t(`homepage.difficulty.${listing.difficulty}`)}
                      </Badge>
                      <Badge size="sm" variant="default">
                        {listing.kind === 'engineering' ? t('market.kindEngineering') : t('market.kindAlgorithm')}
                      </Badge>
                      <Badge size="sm" variant="default">
                        v{listing.version}
                      </Badge>
                      {listing.tags.map((tag) => (
                        <Badge key={tag} size="sm" variant="default">
                          {tag}
                        </Badge>
                      ))}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {t('market.byAuthor', { author: listing.author.displayName })} ·{' '}
                      {t('market.updatedAt', { date: new Date(listing.updatedAt).toLocaleDateString() })} ·{' '}
                      {t('market.downloadCount', { count: listing.downloadCount })}
                    </Text>
                  </Stack>

                  <Group gap="xs">
                    <Button
                      variant={listing.starred ? 'filled' : 'light'}
                      color="yellow"
                      size="sm"
                      disabled={!user}
                      leftSection={listing.starred ? <IconStarFilled size={15} /> : <IconStar size={15} />}
                      onClick={toggleStar}
                    >
                      {listing.starCount}
                    </Button>
                    <Button
                      size="sm"
                      loading={installing}
                      leftSection={
                        environment.writableLibrary ? <IconDownload size={15} /> : <IconFileDownload size={15} />
                      }
                      onClick={install}
                    >
                      {environment.writableLibrary ? t('market.install') : t('market.export')}
                    </Button>
                    {isOwner && (
                      <Button
                        size="sm"
                        variant="subtle"
                        color="red"
                        leftSection={<IconTrash size={15} />}
                        onClick={remove}
                      >
                        {t('market.delete')}
                      </Button>
                    )}
                  </Group>
                </Group>

                {notice && (
                  <Alert color={notice.kind === 'success' ? 'green' : 'red'}>{notice.text}</Alert>
                )}

                <Alert color="gray" icon={<IconAlertTriangle size={16} />}>
                  <Text size="xs">{t('market.executionNotice')}</Text>
                </Alert>

                {!user && (
                  <Text size="xs" c="dimmed">
                    {t('market.starSignInHint')}{' '}
                    <Link href="/account">{t('account.signIn')}</Link>
                  </Text>
                )}

                <Card padding="lg">
                  <Stack gap="sm">
                    <Title order={3}>{t('market.preview')}</Title>
                    <Divider />
                    <ScrollArea.Autosize mah={520} className="panel-scroll">
                      <MarkdownRenderer
                        content={
                          (project ? project.brief[language] || project.brief.en : '') ||
                          (problem ? problem.description[language] || problem.description.en : '')
                        }
                      />
                    </ScrollArea.Autosize>
                  </Stack>
                </Card>

                {project && (
                  <Card padding="lg">
                    <Stack gap="sm">
                      <Title order={3}>{t('market.stages', { count: project.stages.length })}</Title>
                      <List size="sm" spacing="xs">
                        {project.stages.map((stage) => (
                          <List.Item key={stage.id}>
                            <Text size="sm" fw={500} span>
                              {stage.title[language] || stage.title.en}
                            </Text>
                            {stage.gates && stage.gates.length > 0 && (
                              <Text size="xs" c="dimmed">
                                {stage.gates
                                  .map((gate) => gate.label[language] || gate.label.en)
                                  .join(' · ')}
                              </Text>
                            )}
                          </List.Item>
                        ))}
                      </List>
                    </Stack>
                  </Card>
                )}

                {problem && problem.examples.length > 0 && (
                  <Card padding="lg">
                    <Stack gap="sm">
                      <Title order={3}>{t('problemPage.examples')}</Title>
                      <Table withTableBorder withColumnBorders>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>{t('problemPage.input')}</Table.Th>
                            <Table.Th>{t('problemPage.output')}</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {problem.examples.map((example, index) => (
                            <Table.Tr key={index}>
                              <Table.Td>
                                <Text size="xs" ff="monospace">
                                  {example.input}
                                </Text>
                              </Table.Td>
                              <Table.Td>
                                <Text size="xs" ff="monospace">
                                  {example.output}
                                </Text>
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                      <Text size="xs" c="dimmed">
                        {t('market.testCount', { count: problem.tests.length })}
                      </Text>
                    </Stack>
                  </Card>
                )}

                {listing.versions.length > 1 && (
                  <Paper p="md" withBorder>
                    <Stack gap="xs">
                      <Text fw={600} size="sm">
                        {t('market.versions')}
                      </Text>
                      {listing.versions.map((version) => (
                        <Group key={version.version} gap="sm">
                          <Badge size="xs" variant="default">
                            v{version.version}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            {new Date(version.createdAt).toLocaleString()}
                          </Text>
                          {version.changelog && <Text size="xs">{version.changelog}</Text>}
                        </Group>
                      ))}
                    </Stack>
                  </Paper>
                )}
              </Stack>
            )}
          </CloudGate>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
