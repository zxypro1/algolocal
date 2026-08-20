/**
 * 题目工坊
 *
 * 完全离线可用：草稿在浏览器里，AI 助手打的是同源接口（配 Ollama 就是本机），
 * 保存到题库写的是本地文件。只有「发布到市场」需要网络和账号，那是一个按钮，
 * 不是这个页面的前提。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Menu,
  Modal,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  IconBuildingFactory2,
  IconCloudUpload,
  IconFileImport,
  IconGitFork,
  IconPackage,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { AppHeader, HEADER_HEIGHT } from '../../src/components/AppHeader';
import { useTranslation, useI18n } from '../../src/contexts/I18nContext';
import {
  deleteDraft,
  draftsByteSize,
  listDrafts,
  newDraftId,
  saveDraft,
  WORKSHOP_DRAFTS_CHANGED,
  type DraftKind,
  type DraftMeta,
} from '../../src/lib/workshop/drafts';
import { blankAlgorithmProblem, blankEngineeringProject } from '../../src/lib/workshop/templates';
import { coerceProblem } from '../../src/lib/workshop/problem';
import { coerceProject } from '../../src/lib/engineering/validateProject';
import type { EngineeringProject } from '../../src/lib/engineering/types';

interface LibraryEntry {
  id: string;
  label: string;
  kind: DraftKind;
}

export default function WorkshopIndexPage() {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const language = locale === 'en' ? 'en' : 'zh';
  const router = useRouter();

  const [drafts, setDrafts] = useState<DraftMeta[]>([]);
  const [bytes, setBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [forkOpen, setForkOpen] = useState(false);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [forkTarget, setForkTarget] = useState<string | null>(null);
  const [forking, setForking] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    setDrafts(listDrafts());
    setBytes(draftsByteSize());
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(WORKSHOP_DRAFTS_CHANGED, refresh);
    return () => window.removeEventListener(WORKSHOP_DRAFTS_CHANGED, refresh);
  }, [refresh]);

  const create = useCallback(
    (kind: DraftKind) => {
      const id = newDraftId();
      const payload = kind === 'algorithm' ? blankAlgorithmProblem() : blankEngineeringProject();
      const title = payload.title[language] || payload.title.en;

      saveDraft({ id, kind, title, createdAt: new Date().toISOString(), updatedAt: '', payload });
      router.push(`/workshop/${id}`);
    },
    [language, router]
  );

  const openFork = useCallback(async () => {
    setForkOpen(true);
    setError(null);

    try {
      const [problemsResponse, projectsResponse] = await Promise.all([
        fetch('/api/problems'),
        fetch('/api/projects'),
      ]);

      const problems = problemsResponse.ok ? await problemsResponse.json() : [];
      const projects = projectsResponse.ok ? await projectsResponse.json() : [];

      setLibrary([
        ...(Array.isArray(problems) ? problems : []).map((problem: any) => ({
          id: `algorithm:${problem.id}`,
          label: `${problem.title?.[language] || problem.title?.en || problem.id}`,
          kind: 'algorithm' as const,
        })),
        ...(Array.isArray(projects) ? projects : []).map((project: any) => ({
          id: `engineering:${project.id}`,
          label: `${project.title?.[language] || project.title?.en || project.id}`,
          kind: 'engineering' as const,
        })),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [language]);

  const fork = useCallback(async () => {
    if (!forkTarget) return;
    setForking(true);
    setError(null);

    try {
      const [kind, sourceId] = forkTarget.split(/:(.+)/) as [DraftKind, string];

      let payload: any;
      if (kind === 'algorithm') {
        const response = await fetch('/api/problems');
        const problems = await response.json();
        const source = (problems as any[]).find((problem) => problem.id === sourceId);
        if (!source) throw new Error(t('workshop.forkNotFound'));
        // 派生出来的题换个 id，否则保存回题库时会和原题冲突
        payload = coerceProblem({ ...source, id: `${source.id}-copy` });
      } else {
        const response = await fetch(`/api/projects?id=${encodeURIComponent(sourceId)}`);
        if (!response.ok) throw new Error(t('workshop.forkNotFound'));
        const source = (await response.json()) as EngineeringProject;
        payload = coerceProject({ ...source, id: `${source.id}-copy` });
      }

      const id = newDraftId();
      saveDraft({
        id,
        kind,
        title: payload.title[language] || payload.title.en,
        createdAt: new Date().toISOString(),
        updatedAt: '',
        payload,
      });
      router.push(`/workshop/${id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setForking(false);
    }
  }, [forkTarget, language, router, t]);

  const importFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const raw = JSON.parse(await file.text());

        // 工程题有 stages，算法题有 tests。靠这两个字段区分比让用户先选一次类型友好。
        const kind: DraftKind = Array.isArray(raw?.stages) ? 'engineering' : 'algorithm';
        const payload = kind === 'engineering' ? coerceProject(raw) : coerceProblem(raw);

        const id = newDraftId();
        saveDraft({
          id,
          kind,
          title: payload.title[language] || payload.title.en,
          createdAt: new Date().toISOString(),
          updatedAt: '',
          payload,
        });
        router.push(`/workshop/${id}`);
      } catch (cause) {
        setError(t('workshop.importFailed', { reason: cause instanceof Error ? cause.message : String(cause) }));
      }
    },
    [language, router, t]
  );

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} padding={0}>
      <AppHeader
        backHref="/"
        title={t('workshop.title')}
        actions={
          <Button component={Link} href="/market" size="xs" variant="subtle" leftSection={<IconCloudUpload size={14} />}>
            {t('market.title')}
          </Button>
        }
      />

      <AppShell.Main>
        <Container size="lg" py="lg">
          <Stack gap="lg">
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <Stack gap={4}>
                <Title order={1}>{t('workshop.title')}</Title>
                <Text c="dimmed" size="sm">
                  {t('workshop.subtitle')}
                </Text>
              </Stack>

              <Group gap="xs">
                <Menu>
                  <Menu.Target>
                    <Button size="sm" leftSection={<IconPlus size={15} />}>
                      {t('workshop.newDraft')}
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item leftSection={<IconPackage size={15} />} onClick={() => create('algorithm')}>
                      {t('workshop.newAlgorithm')}
                    </Menu.Item>
                    <Menu.Item leftSection={<IconBuildingFactory2 size={15} />} onClick={() => create('engineering')}>
                      {t('workshop.newEngineering')}
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>

                <Button size="sm" variant="light" leftSection={<IconGitFork size={15} />} onClick={openFork}>
                  {t('workshop.forkExisting')}
                </Button>

                <Button
                  size="sm"
                  variant="light"
                  leftSection={<IconFileImport size={15} />}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {t('workshop.importJson')}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    // 清空 value，否则连续导入同一个文件不会再触发 change
                    event.currentTarget.value = '';
                    if (file) importFile(file);
                  }}
                />
              </Group>
            </Group>

            {error && (
              <Alert color="red" withCloseButton onClose={() => setError(null)}>
                {error}
              </Alert>
            )}

            <Alert color="gray">
              <Text size="xs">{t('workshop.offlineNotice')}</Text>
            </Alert>

            {drafts.length === 0 ? (
              <Card padding="xl">
                <Stack align="center" gap="xs">
                  <IconPackage size={30} style={{ opacity: 0.35 }} />
                  <Text size="sm" c="dimmed">
                    {t('workshop.noDrafts')}
                  </Text>
                </Stack>
              </Card>
            ) : (
              <Stack gap="xs">
                {drafts.map((draft) => (
                  <Card key={draft.id} padding="md">
                    <Group justify="space-between" wrap="nowrap">
                      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                        {draft.kind === 'engineering' ? (
                          <IconBuildingFactory2 size={18} style={{ opacity: 0.6, flexShrink: 0 }} />
                        ) : (
                          <IconPackage size={18} style={{ opacity: 0.6, flexShrink: 0 }} />
                        )}
                        <Stack gap={2} style={{ minWidth: 0 }}>
                          <Group gap={6} wrap="nowrap">
                            <Text
                              component={Link}
                              href={`/workshop/${draft.id}`}
                              fw={600}
                              size="sm"
                              truncate
                              style={{ textDecoration: 'none' }}
                            >
                              {draft.title || t('workshop.untitled')}
                            </Text>
                            {draft.publishedSlug && (
                              <Badge size="xs" variant="light" color="green">
                                {t('workshop.published')}
                              </Badge>
                            )}
                            {draft.installedId && (
                              <Badge size="xs" variant="light">
                                {t('workshop.inLibrary')}
                              </Badge>
                            )}
                          </Group>
                          <Text size="xs" c="dimmed">
                            {t('workshop.updatedAt', { date: new Date(draft.updatedAt).toLocaleString() })}
                          </Text>
                        </Stack>
                      </Group>

                      <Group gap="xs" wrap="nowrap">
                        <Button component={Link} href={`/workshop/${draft.id}`} size="compact-xs" variant="light">
                          {t('workshop.edit')}
                        </Button>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="red"
                          leftSection={<IconTrash size={13} />}
                          onClick={() => {
                            if (window.confirm(t('workshop.confirmDelete', { title: draft.title }))) {
                              deleteDraft(draft.id);
                            }
                          }}
                        >
                          {t('market.delete')}
                        </Button>
                      </Group>
                    </Group>
                  </Card>
                ))}

                <Text size="xs" c="dimmed">
                  {t('workshop.storageUsage', { size: (bytes / 1024).toFixed(0) })}
                </Text>
              </Stack>
            )}
          </Stack>
        </Container>
      </AppShell.Main>

      <Modal opened={forkOpen} onClose={() => setForkOpen(false)} title={t('workshop.forkExisting')}>
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {t('workshop.forkHint')}
          </Text>
          <Select
            searchable
            placeholder={t('workshop.forkPlaceholder')}
            value={forkTarget}
            onChange={setForkTarget}
            data={library.map((entry) => ({ value: entry.id, label: entry.label }))}
            nothingFoundMessage={t('homepage.noResults')}
          />
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setForkOpen(false)}>
              {t('aiGenerator.cancel')}
            </Button>
            <Button onClick={fork} loading={forking} disabled={!forkTarget}>
              {t('workshop.fork')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </AppShell>
  );
}
