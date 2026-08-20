/**
 * 工坊编辑页
 *
 * 三件事按顺序发生：编辑 → 验证 → 交付。
 *
 * 「验证」是这一页存在的理由。一道题只要结构合法就能保存，但只有真的跑过
 * （算法题用参考实现跑测试用例，工程题用参考实现跑每一关的隐藏用例）才谈得上
 * 可用。验证全部发生在浏览器里 —— WASM 沙箱和 Web Worker，和用户平时做题
 * 走的是同一条路径，所以断网也能验。
 *
 * 「交付」有两个去处：存进本地题库（马上就能做），或者发布到市场（需要账号）。
 * 后者失败不影响前者。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  List,
  Loader,
  Modal,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import {
  IconCheck,
  IconCloudUpload,
  IconDeviceFloppy,
  IconFileDownload,
  IconPlayerPlay,
  IconX,
} from '@tabler/icons-react';
import { AppHeader, HEADER_HEIGHT } from '../../src/components/AppHeader';
import { ProblemEditor } from '../../src/components/workshop/ProblemEditor';
import { ProjectEditor } from '../../src/components/workshop/ProjectEditor';
import { ValidationPanel, type ReviewNote } from '../../src/components/workshop/ValidationPanel';
import { useCloud } from '../../src/contexts/CloudContext';
import { useI18n, useTranslation } from '../../src/contexts/I18nContext';
import { useEnvironment } from '../../src/hooks/useEnvironment';
import { useProjectRunner } from '../../src/hooks/useProjectRunner';
import { useWasmExecutor } from '../../src/hooks/useWasmExecutor';
import * as api from '../../src/lib/cloud/api';
import { CloudError } from '../../src/lib/cloud/client';
import { downloadAsFile, installListing, InstallError } from '../../src/lib/cloud/install';
import { describeVerification, validateProjectShape, verifyProject } from '../../src/lib/engineering/validateProject';
import type { EngineeringProject } from '../../src/lib/engineering/types';
import {
  hasBlockingIssues,
  validateProblem,
  type AlgorithmProblem,
  type ValidationIssue,
} from '../../src/lib/workshop/problem';
import {
  loadDraft,
  markInstalled,
  markPublished,
  saveDraft,
  type Draft,
  type DraftKind,
} from '../../src/lib/workshop/drafts';

type Verification =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; ok: boolean; lines: string[] };

export default function WorkshopEditorPage() {
  const router = useRouter();
  const draftId = typeof router.query.draftId === 'string' ? router.query.draftId : '';
  const { t } = useTranslation();
  const { locale } = useI18n();
  const language = locale === 'en' ? 'en' : 'zh';

  const { status, user, ensureProbe } = useCloud();
  const { environment } = useEnvironment();
  const { runTests } = useWasmExecutor();
  const { run: runStage } = useProjectRunner();

  const [draft, setDraft] = useState<Draft | null>(null);
  const [missing, setMissing] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [reviewNotes, setReviewNotes] = useState<ReviewNote[]>([]);
  const [reviewVerdict, setReviewVerdict] = useState<string | undefined>();
  const [verification, setVerification] = useState<Verification>({ kind: 'idle' });
  const [publishOpen, setPublishOpen] = useState(false);
  const [changelog, setChangelog] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [installing, setInstalling] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!draftId) return;
    const loaded = loadDraft(draftId);
    if (loaded) setDraft(loaded);
    else setMissing(true);
  }, [draftId]);

  /** 自动保存。防抖 600ms：工程题几百 KB，每敲一个字写一次会明显卡顿。 */
  const update = useCallback(
    (payload: AlgorithmProblem | EngineeringProject) => {
      setDraft((current) => {
        if (!current) return current;
        const next = { ...current, payload, title: payload.title[language] || payload.title.en };

        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          try {
            saveDraft(next);
            setSavedAt(Date.now());
          } catch (cause) {
            setNotice({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
          }
        }, 600);

        return next;
      });
    },
    [language]
  );

  // 离开页面时把还没落盘的改动写掉，否则「编辑完直接关标签页」会丢最后几秒
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );

  useEffect(() => {
    if (!draft) return;
    const flush = () => {
      if (!saveTimer.current) return;
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      try {
        saveDraft(draft);
      } catch {
        /* 关页面的路上没有可以展示错误的地方 */
      }
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [draft]);

  const problem = draft?.kind === 'algorithm' ? (draft.payload as AlgorithmProblem) : null;
  const project = draft?.kind === 'engineering' ? (draft.payload as EngineeringProject) : null;

  const issues: ValidationIssue[] = useMemo(() => {
    if (problem) return validateProblem(problem);
    if (project) {
      return validateProjectShape(project).map((message) => ({
        field: 'project',
        severity: 'error' as const,
        message: { en: message, zh: message },
      }));
    }
    return [];
  }, [problem, project]);

  const blocked = hasBlockingIssues(issues);

  /* ----------------------------- 验证 ----------------------------- */

  const verify = useCallback(async () => {
    setVerification({ kind: 'running' });
    setNotice(null);

    try {
      if (problem) {
        // 用参考实现跑一遍题目自己的用例。跑不通说明用例或参考实现有一个是错的，
        // 而这正是一道题最容易出错、也最难被人眼发现的地方。
        const solutionLanguage = problem.solution?.js ? 'javascript' : problem.solution?.python ? 'python' : null;
        if (!solutionLanguage) {
          setVerification({ kind: 'done', ok: false, lines: [t('workshop.verifyNeedsSolution')] });
          return;
        }

        const code = solutionLanguage === 'javascript' ? problem.solution!.js : problem.solution!.python;
        const result = await runTests(problem, code, solutionLanguage);

        if (result.status === 'error') {
          setVerification({ kind: 'done', ok: false, lines: [result.error || 'Execution failed'] });
          return;
        }

        const failures = result.results
          .map((testCase, index) => ({ testCase, index }))
          .filter((entry) => !entry.testCase.passed)
          .map(
            (entry) =>
              `#${entry.index + 1} ${t('codeRunner.input')}: ${entry.testCase.input} · ${t(
                'codeRunner.expected'
              )}: ${JSON.stringify(entry.testCase.expected)} · ${t('codeRunner.actual')}: ${JSON.stringify(
                entry.testCase.actual
              )}${entry.testCase.error ? ` · ${entry.testCase.error}` : ''}`
          );

        setVerification({
          kind: 'done',
          ok: failures.length === 0,
          lines: failures.length
            ? failures
            : [t('workshop.verifyPassed', { passed: result.passed, total: result.total })],
        });
        return;
      }

      if (project) {
        const verifications = await verifyProject(project, (options) => runStage(options) as any);
        const report = describeVerification(verifications);
        const ok = verifications.every((entry) => entry.ok);

        setVerification({
          kind: 'done',
          ok,
          lines: ok
            ? [t('workshop.verifyStagesPassed', { count: verifications.length })]
            : report.split('\n').filter(Boolean),
        });
      }
    } catch (cause) {
      setVerification({
        kind: 'done',
        ok: false,
        lines: [cause instanceof Error ? cause.message : String(cause)],
      });
    }
  }, [problem, project, runTests, runStage, t]);

  /* ----------------------------- 交付 ----------------------------- */

  const install = useCallback(async () => {
    if (!draft) return;
    setInstalling(true);
    setNotice(null);

    try {
      if (!environment.writableLibrary) {
        downloadAsFile((draft.payload as AlgorithmProblem).id, draft.payload);
        setNotice({ kind: 'success', text: t('market.exported') });
        return;
      }

      const installedId = await installListing(draft.kind as DraftKind, draft.payload);
      markInstalled(draft.id, installedId);
      setNotice({ kind: 'success', text: t('workshop.savedToLibrary', { id: installedId }) });
    } catch (cause) {
      if (cause instanceof InstallError && cause.readOnly) {
        setNotice({ kind: 'error', text: t('market.readOnlyLibrary') });
      } else {
        setNotice({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
      }
    } finally {
      setInstalling(false);
    }
  }, [draft, environment.writableLibrary, t]);

  const openPublish = useCallback(async () => {
    setPublishOpen(true);
    await ensureProbe();
  }, [ensureProbe]);

  const publish = useCallback(async () => {
    if (!draft) return;
    setPublishing(true);
    setNotice(null);

    try {
      const result = await api.publishListing({
        kind: draft.kind as DraftKind,
        slug: draft.publishedSlug,
        payload: draft.payload,
        changelog: changelog.trim() || undefined,
      });

      markPublished(draft.id, result.listing.slug);
      setDraft((current) => (current ? { ...current, publishedSlug: result.listing.slug } : current));
      setPublishOpen(false);
      setChangelog('');
      setNotice({
        kind: 'success',
        text: t('workshop.publishedAs', { slug: result.listing.slug, version: result.listing.version }),
      });
    } catch (cause) {
      const detail =
        cause instanceof CloudError && Array.isArray(cause.details)
          ? `: ${cause.details.map((item: any) => item?.message || item).join('; ')}`
          : '';
      setNotice({
        kind: 'error',
        text: (cause instanceof Error ? cause.message : String(cause)) + detail,
      });
    } finally {
      setPublishing(false);
    }
  }, [draft, changelog, t]);

  const handleReview = useCallback((notes: unknown, verdict?: string) => {
    setReviewNotes(Array.isArray(notes) ? (notes as ReviewNote[]) : []);
    setReviewVerdict(verdict);
  }, []);

  if (missing) {
    return (
      <AppShell header={{ height: HEADER_HEIGHT }} padding={0}>
        <AppHeader backHref="/workshop" title={t('workshop.title')} />
        <AppShell.Main>
          <Container size="sm" py="xl">
            <Alert color="yellow" title={t('workshop.draftMissingTitle')}>
              <Stack gap="sm" align="flex-start">
                <Text size="sm">{t('workshop.draftMissingBody')}</Text>
                <Button component={Link} href="/workshop" size="xs" variant="light">
                  {t('workshop.title')}
                </Button>
              </Stack>
            </Alert>
          </Container>
        </AppShell.Main>
      </AppShell>
    );
  }

  if (!draft) {
    return (
      <AppShell header={{ height: HEADER_HEIGHT }} padding={0}>
        <AppHeader backHref="/workshop" title={t('workshop.title')} />
        <AppShell.Main>
          <Group justify="center" py="xl" gap="xs">
            <Loader size="sm" />
            <Text size="sm" c="dimmed">
              {t('common.loading')}
            </Text>
          </Group>
        </AppShell.Main>
      </AppShell>
    );
  }

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} padding={0}>
      <AppHeader
        backHref="/workshop"
        title={draft.title || t('workshop.untitled')}
        actions={
          <Group gap="xs">
            {savedAt && (
              <Text size="xs" c="dimmed">
                {t('workshop.autosaved')}
              </Text>
            )}
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlayerPlay size={14} />}
              loading={verification.kind === 'running'}
              onClick={verify}
            >
              {t('workshop.verify')}
            </Button>
            <Button
              size="xs"
              variant="light"
              loading={installing}
              leftSection={
                environment.writableLibrary ? <IconDeviceFloppy size={14} /> : <IconFileDownload size={14} />
              }
              onClick={install}
              disabled={blocked}
            >
              {environment.writableLibrary ? t('workshop.saveToLibrary') : t('market.export')}
            </Button>
            <Button
              size="xs"
              leftSection={<IconCloudUpload size={14} />}
              onClick={openPublish}
              disabled={blocked}
            >
              {t('workshop.publish')}
            </Button>
          </Group>
        }
      />

      <AppShell.Main>
        <Container size="xl" py="lg">
          <Stack gap="lg">
            <Group justify="space-between" wrap="wrap">
              <Group gap="xs">
                <Title order={2}>{draft.title || t('workshop.untitled')}</Title>
                <Badge size="sm" variant="light">
                  {draft.kind === 'engineering' ? t('market.kindEngineering') : t('market.kindAlgorithm')}
                </Badge>
                {draft.publishedSlug && (
                  <Badge size="sm" variant="light" color="green">
                    {draft.publishedSlug}
                  </Badge>
                )}
              </Group>
            </Group>

            {notice && (
              <Alert
                color={notice.kind === 'success' ? 'green' : 'red'}
                withCloseButton
                onClose={() => setNotice(null)}
              >
                {notice.text}
              </Alert>
            )}

            <ValidationPanel issues={issues} notes={reviewNotes} verdict={reviewVerdict} />

            {verification.kind === 'done' && (
              <Alert
                color={verification.ok ? 'green' : 'red'}
                icon={verification.ok ? <IconCheck size={16} /> : <IconX size={16} />}
                title={verification.ok ? t('workshop.verifyOkTitle') : t('workshop.verifyFailedTitle')}
              >
                <List size="sm" spacing={2}>
                  {verification.lines.slice(0, 20).map((line, index) => (
                    <List.Item key={index}>
                      <Text size="sm" ff={verification.ok ? undefined : 'monospace'}>
                        {line}
                      </Text>
                    </List.Item>
                  ))}
                </List>
              </Alert>
            )}

            <Card padding="lg">
              {problem && (
                <ProblemEditor
                  draftId={draft.id}
                  problem={problem}
                  onChange={update}
                  onReview={handleReview}
                />
              )}
              {project && (
                <ProjectEditor
                  draftId={draft.id}
                  project={project}
                  onChange={update}
                  onReview={handleReview}
                />
              )}
            </Card>
          </Stack>
        </Container>
      </AppShell.Main>

      <Modal opened={publishOpen} onClose={() => setPublishOpen(false)} title={t('workshop.publish')}>
        <Stack gap="md">
          {status !== 'online' ? (
            <Alert color="yellow">{t('cloud.offlineBody')}</Alert>
          ) : !user ? (
            <Stack gap="sm" align="flex-start">
              <Text size="sm">{t('workshop.publishNeedsAccount')}</Text>
              <Button component={Link} href="/account" size="xs">
                {t('account.signIn')}
              </Button>
            </Stack>
          ) : (
            <>
              <Text size="sm" c="dimmed">
                {draft.publishedSlug
                  ? t('workshop.publishUpdate', { slug: draft.publishedSlug })
                  : t('workshop.publishNew')}
              </Text>

              {verification.kind !== 'done' || !verification.ok ? (
                <Alert color="yellow">
                  <Text size="xs">{t('workshop.publishUnverified')}</Text>
                </Alert>
              ) : null}

              <Textarea
                label={t('workshop.changelog')}
                description={t('workshop.changelogHint')}
                autosize
                minRows={2}
                maxRows={5}
                value={changelog}
                onChange={(event) => setChangelog(event.currentTarget.value)}
              />

              <Group justify="flex-end">
                <Button variant="subtle" onClick={() => setPublishOpen(false)}>
                  {t('aiGenerator.cancel')}
                </Button>
                <Button onClick={publish} loading={publishing}>
                  {t('workshop.publish')}
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Modal>
    </AppShell>
  );
}
