import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Button,
  Center,
  Group,
  List,
  Loader,
  Menu,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconChartBar,
  IconChecklist,
  IconCircleCheckFilled,
  IconDotsVertical,
  IconFileText,
  IconFlask,
  IconPlayerPlay,
  IconRefresh,
  IconSitemap,
  IconSparkles,
  IconTargetArrow,
} from '@tabler/icons-react';
import { useI18n, useTranslation } from '../../src/contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../../src/components/AppHeader';
import MarkdownRenderer from '../../src/components/MarkdownRenderer';
import StagePanel from '../../src/components/engineering/StagePanel';
import ReviewPanel from '../../src/components/engineering/ReviewPanel';
import { MetricsPanel, RunReportPanel, ScoreCardPanel } from '../../src/components/engineering/ResultPanels';
import { useProjectRunner } from '../../src/hooks/useProjectRunner';
import { useAiConfig } from '../../src/hooks/useAiConfig';
import { analyzeWorkspace } from '../../src/lib/engineering/analysis';
import { computeScoreCard } from '../../src/lib/engineering/scoring';
import {
  applyDrafts,
  availableLanguages,
  buildStageFiles,
  editableFiles,
  projectView,
  pruneDrafts,
  toFileMap,
} from '../../src/lib/engineering/workspace';
import { loadProgress, ProjectProgress, resetProgress, saveProgress } from '../../src/lib/engineering/progress';
import type {
  AiReview,
  EngineeringProject,
  LocalizedText,
  QualityReport,
  ScoreCard,
  WorkspaceLanguage,
} from '../../src/lib/engineering/types';

const WorkspaceEditor = dynamic(() => import('../../src/components/engineering/WorkspaceEditor'), { ssr: false });
const EngineeringChat = dynamic(() => import('../../src/components/engineering/EngineeringChat'), { ssr: false });

const MIN_BOTTOM_HEIGHT = 120;
/** 停止输入多久之后落盘 */
const SAVE_DEBOUNCE_MS = 800;

export default function ProjectWorkspacePage() {
  const router = useRouter();
  const { id } = router.query;
  const { t } = useTranslation();
  const { locale } = useI18n();
  const { config: aiConfig } = useAiConfig();

  const [project, setProject] = useState<EngineeringProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProjectProgress | null>(null);

  const [leftTab, setLeftTab] = useState<string>('stage');
  const [bottomTab, setBottomTab] = useState<string>('tests');
  const [leftWidth, setLeftWidth] = useState(34);
  const [bottomHeight, setBottomHeight] = useState(300);
  const [dragging, setDragging] = useState<'horizontal' | 'vertical' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [quality, setQuality] = useState<QualityReport | null>(null);
  const [scoreCard, setScoreCard] = useState<ScoreCard | null>(null);
  const [review, setReview] = useState<AiReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const { run, report, isRunning, error: runError, reset: resetReport } = useProjectRunner();

  const pick = useCallback(
    (text: LocalizedText | undefined) =>
      !text ? '' : text[locale as 'en' | 'zh'] || text.zh || text.en || '',
    [locale]
  );

  /* ---------------- 载入工程与进度 ---------------- */

  useEffect(() => {
    if (!id || typeof id !== 'string') return;

    let cancelled = false;
    (async () => {
      try {
        // 只取这一个工程，不再把整个题库拉下来
        const response = await fetch(`/api/projects?id=${encodeURIComponent(id)}`);
        if (response.status === 404) throw new Error('Project not found');
        if (!response.ok) throw new Error('Failed to load project');
        const found: EngineeringProject = await response.json();
        if (cancelled) return;
        setProject(found);

        // 题目内容更新后，旧草稿可能已经和初始版本对不上，先清一遍
        const stored = loadProgress(found.id);
        const drafts = pruneDrafts(found, stored.drafts);
        const cleaned = { ...stored, drafts };
        if (Object.keys(drafts).length !== Object.keys(stored.drafts).length) {
          saveProgress(cleaned);
        }
        setProgress(cleaned);
      } catch (error) {
        if (!cancelled) setLoadError((error as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  /* ---------------- 拖拽分栏 ---------------- */

  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      if (dragging === 'horizontal') {
        const next = ((event.clientX - rect.left) / rect.width) * 100;
        setLeftWidth(Math.max(20, Math.min(60, next)));
      } else {
        const next = rect.bottom - event.clientY;
        setBottomHeight(Math.max(MIN_BOTTOM_HEIGHT, Math.min(rect.height - 200, next)));
      }
    };

    const onUp = () => setDragging(null);

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = dragging === 'horizontal' ? 'col-resize' : 'row-resize';

    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [dragging]);

  /* ---------------- 派生工作区 ---------------- */

  const languages = useMemo(() => (project ? availableLanguages(project) : []), [project]);
  const language: WorkspaceLanguage = progress?.language ?? languages[0] ?? 'typescript';

  /** 按所选语言取出的工程视图：关卡描述共用，代码与隐藏用例随语言切换 */
  const view = useMemo(
    () => (project ? projectView(project, language) : null),
    [project, language]
  );

  /**
   * 关卡下标要按当前题目夹一遍。
   *
   * 进度存在 localStorage 里，生命周期比题目长：题目被改短（AI 生成的工程重新生成过、
   * 预置题目减了一关）之后，存着的 currentStage 会指向不存在的关卡，页面直接渲染
   * 「找不到」——而那个页面没有重置入口，用户就被永久锁在外面了。
   */
  const stageCount = view?.stages?.length ?? 0;
  const stageIndex = stageCount ? Math.min(Math.max(progress?.currentStage ?? 0, 0), stageCount - 1) : 0;
  const stage = view?.stages?.[stageIndex];

  /** 本关应该出现的文件（不含用户草稿），编辑器用它判断「改过没有」和单文件还原 */
  const stageFiles = useMemo(
    () => (view ? buildStageFiles(view, stageIndex) : []),
    [view, stageIndex]
  );

  const pristine = useMemo(() => toFileMap(stageFiles), [stageFiles]);

  const files = useMemo(
    () => applyDrafts(stageFiles, progress?.drafts),
    [stageFiles, progress?.drafts]
  );

  /* ---------------- 保存 ----------------
   *
   * 编辑器里的内容是即时生效的（跑验收用的就是内存里这份），
   * 但落盘做了防抖：一来不必每敲一个字就把整个进度对象序列化一遍，
   * 二来「未保存」这个状态才有真实含义，指示器才不是摆设。
   */
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  const [unsavedPaths, setUnsavedPaths] = useState<Set<string>>(() => new Set());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<ProjectProgress | null>(null);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    saveProgress(pending);
    setUnsavedPaths(new Set());
    setSavedAt(Date.now());
  }, []);

  const scheduleSave = useCallback(
    (next: ProjectProgress) => {
      pendingRef.current = next;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
    },
    [flushSave]
  );

  // 关标签页、切到后台、离开页面时都要把待写内容落下去，
  // 这样即使有未保存窗口也不会真的丢东西
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushSave();
    };
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flushSave);
      document.removeEventListener('visibilitychange', onHidden);
      flushSave();
    };
  }, [flushSave]);

  /** 取消排队中的防抖落盘。重置类操作必须先做这一步，否则旧值 800ms 后会把新状态盖回去 */
  const cancelPendingSave = useCallback(() => {
    pendingRef.current = null;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  }, []);

  /** 关卡推进、解锁提示这类离散操作直接落盘，不走防抖 */
  const persist = useCallback(
    (next: ProjectProgress) => {
      setProgress(next);
      cancelPendingSave();
      saveProgress(next);
      setUnsavedPaths(new Set());
      setSavedAt(Date.now());
    },
    [cancelPendingSave]
  );

  /**
   * 进度的最新值。
   *
   * 跑验收要 await（最长 30 秒），期间用户还在改代码，闭包里的 progress 早就过期了。
   * 拿它去 persist 会把这段时间里的全部改动从 state 和 localStorage 两边一起抹掉。
   */
  const progressRef = useRef<ProjectProgress | null>(null);
  progressRef.current = progress;

  // 草稿写入要用最新的初始内容做对比，用 ref 避免把 handleFileChange 变成每次渲染都新建
  const pristineRef = useRef<Record<string, string>>({});
  pristineRef.current = pristine;

  const handleFileChange = useCallback((path: string, content: string) => {
    setProgress((prev) => {
      if (!prev) return prev;

      const drafts = { ...prev.drafts };
      if (pristineRef.current[path] === content) {
        // 改回原样就不该再算作草稿，否则这个文件会一直挂着「已修改」
        if (drafts[path] === undefined) return prev;
        delete drafts[path];
      } else {
        if (drafts[path] === content) return prev;
        drafts[path] = content;
      }

      const next = { ...prev, drafts };
      scheduleSave(next);
      return next;
    });

    setUnsavedPaths((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, [scheduleSave]);

  /* ---------------- 运行 ---------------- */

  const handleRun = useCallback(async () => {
    if (!project || !stage || !progress) return;

    setBottomTab('tests');
    flushSave();
    const result = await run({
      files: toFileMap(files),
      specs: stage.specs,
      lab: stage.lab,
      gates: stage.gates,
    });

    if (!result) return;

    const qualityReport = analyzeWorkspace(toFileMap(editableFiles(files)));
    const card = computeScoreCard({ report: result, quality: qualityReport, weights: project.weights });
    setQuality(qualityReport);
    setScoreCard(card);

    // 用 ref 里的最新进度，而不是这个闭包捕获的那份：运行期间用户敲进去的代码
    // 都在 drafts 里，用旧值 persist 会把它们全部丢掉
    const latest = progressRef.current;
    if (!latest) return;

    const cleared = result.status === 'passed';
    const completedStages = cleared && !latest.completedStages.includes(stage.id)
      ? [...latest.completedStages, stage.id]
      : latest.completedStages;

    persist({
      ...latest,
      completedStages,
      attempts: [
        ...latest.attempts,
        {
          stageId: stage.id,
          at: new Date().toISOString(),
          passedCases: result.totals.passed,
          totalCases: result.totals.total,
          gatesPassed: result.gates.every((gate) => gate.passed),
          score: card.total,
        },
      ],
    });
  }, [files, persist, progress, project, run, stage]);

  /* ---------------- AI 评审 ---------------- */

  const handleReview = useCallback(async () => {
    if (!project || !stage) return;

    setReviewLoading(true);
    setReviewError(null);
    setBottomTab('review');

    try {
      const response = await fetch('/api/engineering-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: locale,
          config: aiConfig,
          quality: quality ?? analyzeWorkspace(toFileMap(editableFiles(files))),
          context: {
            projectTitle: project.title,
            projectSummary: project.summary,
            stageIndex,
            stageCount: project.stages.length,
            stageTitle: stage.title,
            stageGoal: stage.goal,
            files: files.map((file) => ({
              path: file.path,
              content: file.content,
              readonly: file.readonly,
            })),
            report,
          },
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to review');
      setReview(data.review);
    } catch (error) {
      setReviewError((error as Error).message);
    } finally {
      setReviewLoading(false);
    }
  }, [aiConfig, files, locale, project, quality, report, stage, stageIndex]);

  /* ---------------- 关卡切换 ---------------- */

  const goToStage = useCallback(
    (index: number) => {
      if (!project || !progress) return;
      if (index < 0 || index >= project.stages.length) return;
      resetReport();
      setQuality(null);
      setScoreCard(null);
      setReview(null);
      persist({ ...progress, currentStage: index });
    },
    [persist, progress, project, resetReport]
  );

  const handleLanguageChange = useCallback(
    (next: WorkspaceLanguage) => {
      if (!progress || next === language) return;
      // 两种语言的文件路径不同（.ts / .js），草稿各存各的，切回来还在
      resetReport();
      setQuality(null);
      setScoreCard(null);
      setReview(null);
      persist({ ...progress, language: next });
    },
    [language, persist, progress, resetReport]
  );

  /** 把单个文件还原成本关的初始内容 */
  const handleResetFile = useCallback(
    (path: string) => {
      const current = progressRef.current;
      if (!current || current.drafts[path] === undefined) return;

      const drafts = { ...current.drafts };
      delete drafts[path];
      // 还原是一个明确动作，直接落盘，别留在防抖队列里
      persist({ ...current, drafts });
    },
    [persist]
  );

  const handleResetStage = useCallback(() => {
    if (!project || !progress || !stage) return;
    const stagePaths = new Set(
      buildStageFiles(view ?? project, stageIndex)
        .filter((file) => !file.readonly)
        .map((file) => file.path)
    );
    const drafts = Object.fromEntries(
      Object.entries(progress.drafts).filter(([path]) => !stagePaths.has(path))
    );
    resetReport();
    persist({ ...progress, drafts });
  }, [persist, progress, project, resetReport, stage, stageIndex]);

  const handleResetProject = useCallback(() => {
    if (!project) return;
    // 先掐掉排队中的落盘：否则 800ms 后那份旧进度会被写回去，重置等于没做
    cancelPendingSave();
    resetProgress(project.id);
    resetReport();
    setQuality(null);
    setScoreCard(null);
    setReview(null);
    setUnsavedPaths(new Set());
    setProgress(loadProgress(project.id));
  }, [cancelPendingSave, project, resetReport]);

  /* ---------------- 渲染 ---------------- */

  if (loading) {
    return (
      <AppShell header={{ height: HEADER_HEIGHT }}>
        <AppHeader backHref="/projects" />
        <AppShell.Main>
          <Center style={{ minHeight: '60vh' }}>
            <Stack align="center" gap="md">
              <Loader />
              <Text size="sm" c="dimmed">
                {t('common.loading')}
              </Text>
            </Stack>
          </Center>
        </AppShell.Main>
      </AppShell>
    );
  }

  if (loadError || !project || !stage || !progress) {
    return (
      <AppShell header={{ height: HEADER_HEIGHT }}>
        <AppHeader backHref="/projects" />
        <AppShell.Main>
          <Center style={{ minHeight: '60vh' }}>
            <Alert color="red" title={t('common.error')} maw={480}>
              <Stack gap="sm" align="flex-start">
                <Text size="sm">{loadError || t('engineering.workspace.notFound')}</Text>
                {/* 存着的进度和题目对不上时，这里是唯一的出口，否则用户被永久挡在外面 */}
                {typeof id === 'string' && (
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    leftSection={<IconRefresh size={14} />}
                    onClick={() => {
                      resetProgress(id);
                      router.reload();
                    }}
                  >
                    {t('engineering.workspace.resetProject')}
                  </Button>
                )}
              </Stack>
            </Alert>
          </Center>
        </AppShell.Main>
      </AppShell>
    );
  }

  const stageCompleted = progress.completedStages.includes(stage.id);
  const revealedHints = progress.revealedHints[stage.id] || 0;

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} padding="0">
      <AppHeader
        backHref="/projects"
        title={pick(project.title)}
        actions={
          <Group gap="xs" wrap="nowrap">
            {languages.length > 1 && (
              <Select
                size="xs"
                w={124}
                aria-label={t('engineering.workspace.language')}
                value={language}
                onChange={(value) => value && handleLanguageChange(value as WorkspaceLanguage)}
                data={languages.map((item) => ({
                  value: item,
                  label: item === 'typescript' ? 'TypeScript' : 'JavaScript',
                }))}
                allowDeselect={false}
                comboboxProps={{ withinPortal: true }}
                visibleFrom="sm"
              />
            )}
            <Button
              size="xs"
              color="violet"
              variant="light"
              leftSection={<IconSparkles size={14} />}
              onClick={handleReview}
              disabled={reviewLoading}
              visibleFrom="sm"
            >
              {t('engineering.review.request')}
            </Button>
            <Button
              size="xs"
              leftSection={isRunning ? <Loader size={12} color="white" /> : <IconPlayerPlay size={14} />}
              onClick={handleRun}
              disabled={isRunning}
            >
              {isRunning ? t('engineering.workspace.running') : t('engineering.workspace.run')}
            </Button>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" size="lg">
                  <IconDotsVertical size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<IconRefresh size={14} />} onClick={handleResetStage}>
                  {t('engineering.workspace.resetStage')}
                </Menu.Item>
                <Menu.Item color="red" leftSection={<IconRefresh size={14} />} onClick={handleResetProject}>
                  {t('engineering.workspace.resetProject')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        }
      />

      <AppShell.Main>
        <div
          ref={containerRef}
          style={{ height: `calc(100vh - ${HEADER_HEIGHT}px)`, display: 'flex', flexDirection: 'column' }}
        >
          {/* 关卡进度条 */}
          <Group
            gap={6}
            px="md"
            py={6}
            wrap="nowrap"
            style={{ borderBottom: '1px solid var(--app-border)', overflowX: 'auto', flexShrink: 0 }}
          >
            {project.stages.map((item, index) => {
              const done = progress.completedStages.includes(item.id);
              const current = index === stageIndex;
              const unlocked = index === 0 || progress.completedStages.includes(project.stages[index - 1].id) || done;
              return (
                <Tooltip
                  key={item.id}
                  label={unlocked ? pick(item.title) : t('engineering.stage.locked')}
                  position="bottom"
                >
                  <Button
                    size="compact-xs"
                    variant={current ? 'filled' : done ? 'light' : 'subtle'}
                    color={done ? 'teal' : current ? 'brand' : 'gray'}
                    onClick={() => unlocked && goToStage(index)}
                    disabled={!unlocked}
                    leftSection={done ? <IconCircleCheckFilled size={12} /> : undefined}
                    style={{ flexShrink: 0 }}
                  >
                    {index + 1}. {pick(item.title).replace(/^第\s*\d+\s*关\s*·\s*/, '').replace(/^Stage\s*\d+\s*·\s*/, '')}
                  </Button>
                </Tooltip>
              );
            })}
          </Group>

          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            {/* 左：关卡说明 / 需求 / 架构 */}
            <div style={{ width: `${leftWidth}%`, minWidth: 280, display: 'flex', flexDirection: 'column' }}>
              <Tabs value={leftTab} onChange={(value) => value && setLeftTab(value)} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <Tabs.List>
                  <Tabs.Tab value="stage" leftSection={<IconChecklist size={14} />}>
                    {t('engineering.tabs.stage')}
                  </Tabs.Tab>
                  <Tabs.Tab value="brief" leftSection={<IconFileText size={14} />}>
                    {t('engineering.tabs.brief')}
                  </Tabs.Tab>
                  {project.architecture && (
                    <Tabs.Tab value="architecture" leftSection={<IconSitemap size={14} />}>
                      {t('engineering.tabs.architecture')}
                    </Tabs.Tab>
                  )}
                </Tabs.List>

                <ScrollArea style={{ flex: 1 }} p="md">
                  <Tabs.Panel value="stage">
                    <StagePanel
                      stage={stage}
                      stageIndex={stageIndex}
                      stageCount={project.stages.length}
                      completed={stageCompleted}
                      revealedHints={revealedHints}
                      onRevealHint={() =>
                        persist({
                          ...progress,
                          revealedHints: { ...progress.revealedHints, [stage.id]: revealedHints + 1 },
                        })
                      }
                      onAdvance={() => goToStage(stageIndex + 1)}
                      hasNextStage={stageIndex < project.stages.length - 1}
                    />
                  </Tabs.Panel>

                  <Tabs.Panel value="brief">
                    <Stack gap="md">
                      {project.learningOutcomes && project.learningOutcomes.length > 0 && (
                        <Paper withBorder radius="lg" p="md">
                          <Text size="sm" fw={600} mb={8}>
                            {t('engineering.brief.outcomes')}
                          </Text>
                          <List
                            size="sm"
                            spacing={6}
                            icon={
                              <ThemeIcon size={18} radius="xl" variant="light" color="teal">
                                <IconTargetArrow size={11} />
                              </ThemeIcon>
                            }
                          >
                            {project.learningOutcomes.map((outcome, index) => (
                              <List.Item key={index}>{pick(outcome)}</List.Item>
                            ))}
                          </List>
                        </Paper>
                      )}

                      {project.prerequisites && project.prerequisites.length > 0 && (
                        <Paper withBorder radius="lg" p="md">
                          <Text size="sm" fw={600} mb={6}>
                            {t('engineering.brief.prerequisites')}
                          </Text>
                          <Group gap={6} wrap="wrap">
                            {project.prerequisites.map((item, index) => (
                              <Badge key={index} variant="light" color="gray" size="sm">
                                {pick(item)}
                              </Badge>
                            ))}
                          </Group>
                        </Paper>
                      )}

                      <Paper withBorder radius="lg" p="lg">
                        <MarkdownRenderer content={pick(project.brief)} />
                      </Paper>
                    </Stack>
                  </Tabs.Panel>

                  {project.architecture && (
                    <Tabs.Panel value="architecture">
                      <Paper withBorder radius="lg" p="lg">
                        <MarkdownRenderer content={pick(project.architecture)} />
                      </Paper>
                    </Tabs.Panel>
                  )}
                </ScrollArea>
              </Tabs>
            </div>

            <div
              className="app-resizer"
              data-dragging={dragging === 'horizontal' || undefined}
              onMouseDown={(event) => {
                event.preventDefault();
                setDragging('horizontal');
              }}
              role="separator"
              aria-orientation="vertical"
            />

            {/* 右：编辑器 + 结果面板 */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div style={{ flex: 1, minHeight: 0, borderBottom: '1px solid var(--app-border)' }}>
                <WorkspaceEditor
                  files={files}
                  pristine={pristine}
                  onChange={handleFileChange}
                  onResetFile={handleResetFile}
                  onRun={handleRun}
                  isRunning={isRunning}
                  savedAt={savedAt}
                  unsavedPaths={unsavedPaths}
                  onSaveNow={flushSave}
                />
              </div>

              <div
                onMouseDown={(event) => {
                  event.preventDefault();
                  setDragging('vertical');
                }}
                role="separator"
                aria-orientation="horizontal"
                style={{
                  height: 6,
                  cursor: 'row-resize',
                  background: dragging === 'vertical' ? 'var(--mantine-color-brand-light)' : 'transparent',
                  flexShrink: 0,
                }}
              />

              <div style={{ height: bottomHeight, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                <Tabs
                  value={bottomTab}
                  onChange={(value) => value && setBottomTab(value)}
                  style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
                >
                  <Tabs.List>
                    <Tabs.Tab
                      value="tests"
                      leftSection={<IconFlask size={14} />}
                      rightSection={
                        report ? (
                          <Badge size="xs" circle variant="filled" color={report.status === 'passed' ? 'teal' : 'red'}>
                            {report.totals.passed}
                          </Badge>
                        ) : undefined
                      }
                    >
                      {t('engineering.tabs.tests')}
                    </Tabs.Tab>
                    <Tabs.Tab value="metrics" leftSection={<IconChartBar size={14} />}>
                      {t('engineering.tabs.metrics')}
                    </Tabs.Tab>
                    <Tabs.Tab value="score" leftSection={<IconChecklist size={14} />}>
                      {t('engineering.tabs.score')}
                    </Tabs.Tab>
                    <Tabs.Tab value="review" leftSection={<IconSparkles size={14} />}>
                      {t('engineering.tabs.review')}
                    </Tabs.Tab>
                  </Tabs.List>

                  <ScrollArea style={{ flex: 1 }} p="md">
                    {runError && (
                      <Alert color="red" mb="md" title={t('engineering.results.runError')}>
                        {runError}
                      </Alert>
                    )}
                    <Tabs.Panel value="tests">
                      <RunReportPanel report={report} />
                    </Tabs.Panel>
                    <Tabs.Panel value="metrics">
                      <MetricsPanel report={report} />
                    </Tabs.Panel>
                    <Tabs.Panel value="score">
                      <ScoreCardPanel scoreCard={scoreCard} quality={quality} />
                    </Tabs.Panel>
                    <Tabs.Panel value="review">
                      <ReviewPanel
                        review={review}
                        loading={reviewLoading}
                        error={reviewError}
                        onRequest={handleReview}
                      />
                    </Tabs.Panel>
                  </ScrollArea>
                </Tabs>
              </div>
            </div>
          </div>
        </div>
      </AppShell.Main>

      <EngineeringChat
        projectTitle={project.title}
        projectSummary={project.summary}
        stageTitle={stage.title}
        stageGoal={stage.goal}
        stageIndex={stageIndex}
        stageCount={project.stages.length}
        files={files}
        report={report}
      />
    </AppShell>
  );
}
