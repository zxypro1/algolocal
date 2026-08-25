/**
 * 代码形态的工作台：任务描述 + IDE + 结果面板
 *
 * 这是工程实战原本、也是目前所有项目在用的那一套布局，整块从
 * pages/projects/[id].tsx 搬过来，行为不变。会话状态（进度、草稿、关卡、语言）
 * 由 useProjectSession 提供，这里只负责「跑验收 / AI 评审 / 怎么摆面板」。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Menu,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Tabs,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBug,
  IconChartBar,
  IconChecklist,
  IconCircleCheckFilled,
  IconDotsVertical,
  IconFlask,
  IconPlayerPlay,
  IconRefresh,
  IconSitemap,
  IconSparkles,
} from '@tabler/icons-react';
import { useI18n, useTranslation } from '../../contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../AppHeader';
import MarkdownRenderer from '../MarkdownRenderer';
import StagePanel from './StagePanel';
import ReviewPanel from './ReviewPanel';
import { MetricsPanel, RunReportPanel, ScoreCardPanel } from './ResultPanels';
import TracePlayer from '../TracePlayer';
import ErrorBoundary from '../ErrorBoundary';
import { useProjectRunner } from '../../hooks/useProjectRunner';
import { useAiConfig } from '../../hooks/useAiConfig';
import { analyzeWorkspace } from '../../lib/engineering/analysis';
import { requestStructuredStream } from '../../lib/streamRequest';
import { computeScoreCard } from '../../lib/engineering/scoring';
import { editableFiles, toFileMap } from '../../lib/engineering/workspace';
import type { ResultScope } from '../../hooks/useProjectSession';
import type { ProjectSession } from '../../hooks/useProjectSession';
import type {
  AiReview,
  QualityReport,
  ScoreCard,
  WorkspaceLanguage,
} from '../../lib/engineering/types';

const WorkspaceEditor = dynamic(() => import('./WorkspaceEditor'), { ssr: false });
const EngineeringChat = dynamic(() => import('./EngineeringChat'), { ssr: false });

const MIN_BOTTOM_HEIGHT = 120;

/**
 * 渲染失败时显示什么。
 *
 * 一定要把 error.message 亮出来：白屏最大的问题不是坏，是完全不知道哪儿坏了。
 */
function renderErrorFallback(t: (key: string) => string) {
  return (error: Error, reset: () => void) => (
    <Alert color="red" title={t('renderError.title')} icon={<IconAlertTriangle size={16} />}>
      <Stack gap="xs" align="flex-start">
        <Text size="sm">{t('renderError.body')}</Text>
        <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {error.message}
        </Code>
        <Button size="xs" variant="light" color="red" onClick={reset}>
          {t('renderError.retry')}
        </Button>
      </Stack>
    </Alert>
  );
}

export interface CodeWorkspaceProps {
  session: ProjectSession;
  /**
   * 会话侧要求清结果时调用它。
   *
   * 页面把 useProjectSession 的 onClearResults 转接到这里 —— 结果状态住在
   * 工作台里，而触发清理的动作（换关卡、换语言、重置）住在会话里。
   */
  registerClearResults: (fn: (scope: ResultScope) => void) => void;
}

export default function CodeWorkspace({ session, registerClearResults }: CodeWorkspaceProps) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const { config: aiConfig } = useAiConfig();

  const {
    project,
    progress,
    languages,
    language,
    stage,
    stageIndex,
    pristine,
    files,
    savedAt,
    unsavedPaths,
    pick,
    handleFileChange,
    handleResetFile,
    handleResetStage,
    handleResetProject,
    goToStage,
    handleLanguageChange,
    revealHint,
    recordAttempt,
    flushSave,
  } = session;

  const [leftTab, setLeftTab] = useState<string>('stage');
  const [bottomTab, setBottomTab] = useState<string>('tests');
  const [tracedSources, setTracedSources] = useState<Record<string, string>>({});
  const [leftWidth, setLeftWidth] = useState(34);
  const [bottomHeight, setBottomHeight] = useState(300);
  const [dragging, setDragging] = useState<'horizontal' | 'vertical' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [quality, setQuality] = useState<QualityReport | null>(null);
  const [scoreCard, setScoreCard] = useState<ScoreCard | null>(null);
  const [review, setReview] = useState<AiReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  /** 评审正在写的原文，边收边显示 */
  const [reviewDraft, setReviewDraft] = useState('');

  const { run, report, isRunning, error: runError, reset: resetReport } = useProjectRunner();

  /**
   * 把「清结果」的能力交回给会话。
   *
   * 'all' 与 'report' 的区别要保住：换关卡、换语言、重置工程会把静态分析、
   * 评分卡、AI 评审一起清掉，而「重置本关」只清运行结果。
   */
  const clearResults = useCallback(
    (scope: ResultScope) => {
      resetReport();
      if (scope === 'all') {
        setQuality(null);
        setScoreCard(null);
        setReview(null);
      }
    },
    [resetReport]
  );

  useEffect(() => {
    registerClearResults(clearResults);
  }, [clearResults, registerClearResults]);

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

  /* ---------------- 运行 ---------------- */

  const handleRun = useCallback(
    async (options?: { trace?: boolean }) => {
      if (!project || !stage || !progress) return;

      setBottomTab(options?.trace ? 'trace' : 'tests');
      flushSave();
      if (options?.trace) {
        // 录制用的源码快照，播放器按它渲染
        setTracedSources(Object.fromEntries(files.map((file) => [file.path, file.content])));
      }
      const result = await run({
        files: toFileMap(files),
        specs: stage.specs,
        lab: stage.lab,
        gates: stage.gates,
        // 录制会给每条语句插桩，明显更慢，所以只有点「调试」时才开
        trace: options?.trace === true,
        traceFiles: editableFiles(files).map((file) => file.path),
      });

      if (!result) return;

      const qualityReport = analyzeWorkspace(toFileMap(editableFiles(files)));
      // 一行没改过时，静态分析评的是初始骨架而不是你的代码，那两项该标成未测量
      const workspaceTouched = editableFiles(files).some((file) => pristine[file.path] !== file.content);
      const card = computeScoreCard({
        report: result,
        quality: qualityReport,
        weights: project.weights,
        workspaceTouched,
      });
      setQuality(qualityReport);
      setScoreCard(card);

      recordAttempt({
        stageId: stage.id,
        passed: result.status === 'passed',
        passedCases: result.totals.passed,
        totalCases: result.totals.total,
        gatesPassed: result.gates.every((gate) => gate.passed),
        score: card.total,
      });
    },
    [files, flushSave, pristine, progress, project, recordAttempt, run, stage]
  );

  /* ---------------- AI 评审 ---------------- */

  const handleReview = useCallback(async () => {
    if (!project || !stage) return;

    setReviewLoading(true);
    setReviewError(null);
    setBottomTab('review');

    setReviewDraft('');

    try {
      // 评审是一整篇给人读的文字，边写边显示；结构化结果在流末尾拿
      const data = await requestStructuredStream<{ review: AiReview }>(
        '/api/engineering-review',
        {
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
        },
        { onDelta: (_chunk, full) => setReviewDraft(full) }
      );

      setReview(data.review);
    } catch (error) {
      setReviewError((error as Error).message);
    } finally {
      setReviewLoading(false);
    }
  }, [aiConfig, files, locale, project, quality, report, stage, stageIndex]);

  /* ---------------- 渲染 ---------------- */

  if (!project || !progress || !stage) return null;

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
              onClick={() => handleRun()}
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
                  {(stage.architecture || project.architecture) && (
                    <Tabs.Tab value="architecture" leftSection={<IconSitemap size={14} />}>
                      {t('engineering.tabs.architecture')}
                    </Tabs.Tab>
                  )}
                </Tabs.List>

                {/*
                  Mantine 的 ScrollArea 视口里那层子元素是 display: table，宽度由内容决定。
                  关卡说明里只要有一个宽代码块，整块内容就按代码块的宽度排版，旁边的段落跟着
                  被裁掉半句。改成 block 之后，文字按视口宽度换行，宽内容自己横向滚动。
                */}
                <ScrollArea
                  style={{ flex: 1 }}
                  p="md"
                  className="panel-scroll"
                >
                  <Tabs.Panel value="stage">
                    {/* 关卡内容大半来自 AI 生成，坏数据只能毁掉这一块，不能把整页带走 */}
                    <ErrorBoundary resetKey={stage.id} fallback={renderErrorFallback(t)}>
                    <StagePanel
                      // 按关卡 key：不这样的话组件会被复用，
                      // 在一关点过「仍然查看」之后，后面每一关的参考实现都直接敞开了
                      key={stage.id}
                      stage={stage}
                      stageIndex={stageIndex}
                      stageCount={project.stages.length}
                      completed={stageCompleted}
                      revealedHints={revealedHints}
                      onRevealHint={() => revealHint(stage.id, revealedHints)}
                      onAdvance={() => goToStage(stageIndex + 1)}
                      hasNextStage={stageIndex < project.stages.length - 1}
                    />
                    </ErrorBoundary>
                  </Tabs.Panel>


                  {(stage.architecture || project.architecture) && (
                    <Tabs.Panel value="architecture">
                      <Paper withBorder radius="lg" p="lg">
                        <ErrorBoundary resetKey={stage.id} fallback={renderErrorFallback(t)}>
                          <MarkdownRenderer content={pick(stage.architecture || project.architecture)} />
                        </ErrorBoundary>
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
                    <Tabs.Tab value="trace" leftSection={<IconBug size={14} />}>
                      {t('engineering.tabs.trace')}
                    </Tabs.Tab>
                    <Tabs.Tab value="review" leftSection={<IconSparkles size={14} />}>
                      {t('engineering.tabs.review')}
                    </Tabs.Tab>
                  </Tabs.List>

                  {/*
                    Mantine 的 ScrollArea 视口里那层子元素是 display: table，宽度由内容决定。
                    关卡说明里只要有一个宽代码块，整块内容就按代码块的宽度排版，旁边的段落跟着
                    被裁掉半句。改成 block 之后，文字按视口宽度换行，宽内容自己横向滚动。
                  */}
                  <ScrollArea
                    style={{ flex: 1 }}
                    p="md"
                    className="panel-scroll"
                  >
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
                    <Tabs.Panel value="trace">
                      {report?.trace && report.trace.steps.length > 0 ? (
                        <TracePlayer
                          trace={report.trace}
                          // 取录制那一刻的快照，不是当前编辑器内容：
                          // 录完继续改代码的话，行号会整体错位，高亮指到别的行去。
                          sourceOf={(file: string) => tracedSources[file] ?? ''}
                          note={t('engineering.trace.note')}
                        />
                      ) : (
                        <Stack gap="sm" align="flex-start" p="md">
                          <Text size="sm" c="dimmed">{t('engineering.trace.empty')}</Text>
                          <Button
                            size="compact-sm"
                            variant="light"
                            leftSection={<IconBug size={14} />}
                            loading={isRunning}
                            onClick={() => handleRun({ trace: true })}
                          >
                            {t('engineering.trace.record')}
                          </Button>
                        </Stack>
                      )}
                    </Tabs.Panel>

                    <Tabs.Panel value="review">
                      <ReviewPanel
                        review={review}
                        loading={reviewLoading}
                        error={reviewError}
                        onRequest={handleReview}
                        draft={reviewDraft}
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
