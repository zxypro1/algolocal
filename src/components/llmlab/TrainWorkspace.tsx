/**
 * train 形态的工作台：任务 + 终端 + IDE + 训练 + 张量 + 样例
 *
 * 布局和 ops / gpu 一致：左边任务、右边一组 tab，分隔条能拖、左栏能收起、
 * 位置记在 localStorage 里。**同一时刻只看一样东西**，每样都占满整个右栏。
 *
 * 面板之间不发消息（同 ops / gpu 的定论）。终端里 `python train.py` 之后，
 * 训练面板上的曲线变了，不是因为终端通知了它，而是两边看的是同一个世界。
 *
 * ## 为什么分发是第一个 commit
 *
 * design/llmlab.md 第五节把它写成了硬规矩 —— gpulab 那次 29 关全做完、
 * 测试全绿、包都发了，才发现工作台一行没写。所以这个项目的顺序反过来：
 * 先让「点进去有东西」成立（第 1 片），再往里填运行时（第 7 片）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  Alert, AppShell, Badge, Button, Code, Group, List, Loader,
  ScrollArea, Select, Stack, Tabs, Text, Tooltip, ActionIcon,
} from '@mantine/core';
import {
  IconAlertTriangle, IconChartLine, IconFileCode, IconInfoCircle, IconMessages,
  IconPlayerPlay, IconRefresh, IconRobot, IconTable, IconTerminal2,
} from '@tabler/icons-react';
import { useMantineColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import { AppHeader, HEADER_HEIGHT } from '../AppHeader';
import MarkdownRenderer from '../MarkdownRenderer';
import ErrorBoundary from '../ErrorBoundary';
import { RunReportPanel } from '../engineering/ResultPanels';
import WorkbenchSplit from '../workbench/WorkbenchSplit';
import { useTrainWorkspace } from '../../hooks/useTrainWorkspace';
import { runTrainStage } from '../../lib/llmlab/lab';
import { resolveTranspiler } from '../../lib/engineering/transpile';
import type { ProjectSession, ResultScope } from '../../hooks/useProjectSession';
import type { StageRunReport } from '../../lib/engineering/types';

const WorkbenchTerminal = dynamic(() => import('../workbench/WorkbenchTerminal'), { ssr: false });
const TrainingPanel = dynamic(() => import('./TrainingPanel'), { ssr: false });
const TensorPanel = dynamic(() => import('./TensorPanel'), { ssr: false });
const SamplePanel = dynamic(() => import('./SamplePanel'), { ssr: false });

const BANNER = [
  '\x1b[1mllmlab\x1b[0m —— 一台装着 Python 与 nanotorch 的开发机',
  '',
  '  `python train.py` 跑你的脚本，`ls` / `cat` 看看盘上有什么。',
  '  敲 `help` 看这个终端支持哪些命令。',
  '',
].join('\r\n');

function renderPanelError(error: Error) {
  return (
    <Alert color="red" icon={<IconAlertTriangle size={16} />} m="sm">
      <Text size="xs">这块面板炸了：{error.message}</Text>
    </Alert>
  );
}

export interface TrainWorkspaceProps {
  session: ProjectSession;
  registerClearResults: (fn: ((scope: ResultScope) => void) | null) => void;
}

const RIGHT_TAB_KEY = 'llmlab.rightTab.v1';
const SPLIT_KEY = 'llmlab.split.v1';

/**
 * 一块还没接上的面板。
 *
 * 写清「在等哪一片」而不是画一个空壳 —— 空壳在验收时看起来和做完了一样，
 * 那正是 gpulab 那次滑过去的原因。
 */
function Pending({ title, waitingFor, willShow }: {
  title: string;
  waitingFor: string;
  willShow: string[];
}) {
  return (
    <ScrollArea h="100%" type="auto" p="md" className="panel-scroll">
      <Alert color="gray" icon={<IconInfoCircle size={16} />} title={`${title} · 还没接上`}>
        <Stack gap="xs">
          <Text size="xs">在等：{waitingFor}</Text>
          <Text size="xs" c="dimmed">接上之后这里会有：</Text>
          <List size="xs" spacing={2} c="dimmed">
            {willShow.map((item) => <List.Item key={item}>{item}</List.Item>)}
          </List>
        </Stack>
      </Alert>
    </ScrollArea>
  );
}

export default function TrainWorkspace({ session, registerClearResults }: TrainWorkspaceProps) {
  const { colorScheme } = useMantineColorScheme();
  const { project, stage, stageIndex, progress, pick, files, handleFileChange, goToStage } = session;

  const [report, setReport] = useState<StageRunReport | null>(null);
  const [running, setRunning] = useState(false);
  const [rightTab, setRightTab] = useState('ide');
  const [activePath, setActivePath] = useState<string | null>(null);
  const insertRef = useRef<((command: string) => void) | null>(null);

  const worldSpec = project?.workspace?.kind === 'train' ? project.workspace.world : undefined;

  /** 草稿：把这一关涉及的源文件铺到虚拟文件系统上 */
  const stageFiles = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [path, content] of Object.entries(stage?.train?.files ?? {})) {
      const draft = files.find((file) => file.path === path);
      out[path] = draft?.content ?? content;
    }
    return out;
    // 只在换关卡时重算：之后编辑器直接写虚拟文件系统，不该把世界重建掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage?.id]);

  const train = useTrainWorkspace({
    world: worldSpec,
    stage: stage?.train,
    stageKey: `${project?.id ?? ''}:${stage?.id ?? ''}`,
    files: stageFiles,
  });

  /** 这一关摆在机器磁盘上的文件 —— IDE 的文件列表 */
  const stagePaths = useMemo(
    () => Object.keys(stage?.train?.files ?? {}).sort(),
    [stage?.train?.files]
  );

  /** 记住上次看的是哪一页 */
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(RIGHT_TAB_KEY);
      if (saved) setRightTab(saved);
    } catch {
      /* 隐私模式下 localStorage 会抛，用默认的就行 */
    }
  }, []);

  const selectRightTab = useCallback((value: string | null) => {
    if (!value) return;
    setRightTab(value);
    try {
      window.localStorage.setItem(RIGHT_TAB_KEY, value);
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    registerClearResults(() => setReport(null));
    return () => registerClearResults(null);
  }, [registerClearResults]);

  /** 换关卡时把编辑器切回这一关的第一个源文件 */
  useEffect(() => {
    setActivePath(stagePaths[0] ?? null);
    setReport(null);
  }, [stagePaths]);

  /**
   * 编辑器里显示什么。
   *
   * 优先取草稿（`files` 里那份，键是 `关卡id::路径`，由 buildStageFiles 铺好），
   * 没有草稿才回退到关卡的初始内容 —— 少了这一步，学员切走再切回来
   * 改的东西就没了（#108 修的就是这个）。
   *
   * **只在换文件 / 换关卡时重读，之后内容由 Monaco 自己维护**（同 GpuWorkspace）。
   * 把 `files` 放进依赖的话，每敲一个字都会重算出一个新的 `value` 喂回去 ——
   * 而草稿的写入是攒批的，回来的那一份可能比编辑器里的旧一拍，光标会跳。
   * 所以这里用 ref 读最新的一份，依赖只留「该重读了」的那两个信号。
   */
  const filesRef = useRef(files);
  filesRef.current = files;

  const editorValue = useMemo(() => {
    if (!activePath) return '';
    const draft = filesRef.current.find((file) => file.path === activePath);
    return draft?.content ?? stage?.train?.files?.[activePath] ?? '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, stage?.id]);

  const handleEditorChange = useCallback((value?: string) => {
    if (!activePath || value === undefined) return;
    // 同时写两处：虚拟文件系统（终端与判定读它）与草稿（刷新之后还在）
    train.writeFile(activePath, value);
    handleFileChange(activePath, value);
  }, [activePath, handleFileChange, train]);

  const registerInsert = useCallback((insert: ((command: string) => void) | null) => {
    insertRef.current = insert;
  }, []);

  /**
   * 把一条命令填进终端 —— **只是填进去，不替他回车**。
   * 和 ops / gpu 一个规矩：命令是学员自己敲下去的。
   */
  const insertCommand = useCallback((command: string) => {
    selectRightTab('terminal');
    insertRef.current?.(command);
  }, [selectRightTab]);

  const handleVerify = useCallback(async () => {
    if (!train.world || !stage) return;
    setRunning(true);
    try {
      const specs = stage.specs ?? [];
      const transpile = await resolveTranspiler(
        Object.fromEntries(specs.map((spec) => [spec.path, spec.content]))
      );
      train.world.rt.forbid((stage.train?.forbidden ?? []) as never[]);
      const outcome = await runTrainStage({
        world: train.world,
        specs,
        gates: stage.gates ?? [],
        transpile,
      });
      setReport(outcome);
      session.recordAttempt({
        stageId: stage.id,
        passed: outcome.status === 'passed',
        passedCases: outcome.totals.passed,
        totalCases: outcome.totals.total,
        gatesPassed: outcome.gates.every((gate) => gate.passed),
        score: outcome.totals.total
          ? Math.round((outcome.totals.passed / outcome.totals.total) * 100)
          : 0,
      });
    } catch (error) {
      setReport({
        status: 'error',
        totals: { total: 0, passed: 0, failed: 0 },
        cases: [], gates: [],
        metrics: {
          virtualElapsedMs: 0, maxConcurrency: 0, concurrencyTimeline: [],
          requests: { total: 0, ok: 0, failed: 0, throttled: 0, retries: 0, duplicated: 0, byUrl: {} },
          samples: [], counters: {},
        },
        console: [],
        wallClockMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunning(false);
    }
  }, [train, stage, session]);

  if (!project || !stage) return null;

  const entry = stage.train?.entry
    ?? (project.workspace?.kind === 'train' ? project.workspace.world?.entry : undefined)
    ?? 'train.py';

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} padding="0">
      <AppHeader
        backHref="/projects"
        title={pick(project.title)}
        actions={
          <Group gap="xs">
            <Badge variant="light" color="gray" size="sm">
              第 {stageIndex + 1} 关 · {pick(stage.title)}
            </Badge>
            {train.status === 'ready' && (
              <Badge variant="light" color="teal" size="sm">
                {train.log.steps.length > 0 ? `${train.log.steps.length} 步` : 'nanotorch 就绪'}
              </Badge>
            )}
            {train.status === 'booting' && (
              <Badge variant="light" color="gray" size="sm">正在起 Python…</Badge>
            )}
            <Tooltip label="重置这台机器（会清掉训练日志）">
              <ActionIcon variant="subtle" color="gray" onClick={train.reboot} aria-label="重置世界">
                <IconRefresh size={16} />
              </ActionIcon>
            </Tooltip>
            <Button
              size="xs"
              leftSection={<IconPlayerPlay size={14} />}
              loading={running}
              disabled={train.status !== 'ready'}
              onClick={handleVerify}
            >
              验收
            </Button>
          </Group>
        }
      />
      <AppShell.Main>
        <div style={{ height: `calc(100vh - ${HEADER_HEIGHT}px)`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Group
            gap={6}
            px="md"
            py={6}
            wrap="nowrap"
            style={{ borderBottom: '1px solid var(--app-border)', overflowX: 'auto', flexShrink: 0 }}
          >
            {project.stages.map((item, index) => {
              const done = progress?.completedStages.includes(item.id) ?? false;
              const current = index === stageIndex;
              const unlocked = index === 0
                || (progress?.completedStages.includes(project.stages[index - 1].id) ?? false)
                || done;
              return (
                <Tooltip key={item.id} label={unlocked ? pick(item.title) : '先过上一关'} position="bottom">
                  <Button
                    size="compact-xs"
                    variant={current ? 'filled' : done ? 'light' : 'subtle'}
                    color={done ? 'teal' : current ? 'brand' : 'gray'}
                    onClick={() => unlocked && goToStage(index)}
                    disabled={!unlocked}
                    style={{ flexShrink: 0 }}
                  >
                    {index + 1}. {pick(item.title)}
                  </Button>
                </Tooltip>
              );
            })}
          </Group>

          <WorkbenchSplit
            storageKey={SPLIT_KEY}
            collapseLabel="展开任务栏"
            left={(
              <Tabs defaultValue="goal" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <Tabs.List>
                  <Tabs.Tab value="goal" fz="xs">任务</Tabs.Tab>
                  <Tabs.Tab value="primer" fz="xs">背景</Tabs.Tab>
                  <Tabs.Tab value="result" fz="xs">
                    验收{report ? ` · ${report.totals.passed}/${report.totals.total}` : ''}
                  </Tabs.Tab>
                </Tabs.List>
                <Tabs.Panel value="goal" style={{ flex: 1, minHeight: 0 }}>
                  <ScrollArea h="100%" type="auto" p="sm" className="panel-scroll">
                    <MarkdownRenderer content={pick(stage.goal)} />
                    {(stage.checklist ?? []).length > 0 && (
                      <Stack gap={4} mt="md">
                        <Text size="xs" fw={600} c="dimmed">通关标准</Text>
                        {(stage.checklist ?? []).map((item, index) => (
                          <Text key={index} size="xs">· {pick(item)}</Text>
                        ))}
                      </Stack>
                    )}
                    {(stage.hints ?? []).length > 0 && (
                      <Stack gap={4} mt="md">
                        <Text size="xs" fw={600} c="dimmed">提示</Text>
                        {(stage.hints ?? []).map((item, index) => (
                          <Text key={index} size="xs" c="dimmed">· {pick(item)}</Text>
                        ))}
                      </Stack>
                    )}
                    {(stage.pitfalls ?? []).length > 0 && (
                      <Stack gap={6} mt="md">
                        <Text size="xs" fw={600} c="dimmed">常见坑</Text>
                        {(stage.pitfalls ?? []).map((item, index) => (
                          <MarkdownRenderer key={index} content={pick(item)} />
                        ))}
                      </Stack>
                    )}
                  </ScrollArea>
                </Tabs.Panel>
                <Tabs.Panel value="primer" style={{ flex: 1, minHeight: 0 }}>
                  <ScrollArea h="100%" type="auto" p="sm" className="panel-scroll">
                    <MarkdownRenderer content={pick(stage.primer)} />
                  </ScrollArea>
                </Tabs.Panel>
                <Tabs.Panel value="result" style={{ flex: 1, minHeight: 0 }}>
                  <ScrollArea h="100%" type="auto" p="sm" className="panel-scroll">
                    {report
                      ? <RunReportPanel report={report} />
                      : <Text size="xs" c="dimmed">还没跑过验收</Text>}
                  </ScrollArea>
                </Tabs.Panel>
              </Tabs>
            )}
            right={(
              <Tabs
                value={rightTab}
                onChange={selectRightTab}
                style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
              >
                <Tabs.List>
                  <Tabs.Tab value="terminal" fz="xs" leftSection={<IconTerminal2 size={13} />}>终端</Tabs.Tab>
                  <Tabs.Tab value="ide" fz="xs" leftSection={<IconFileCode size={13} />}>IDE</Tabs.Tab>
                  <Tabs.Tab value="train" fz="xs" leftSection={<IconChartLine size={13} />}>训练</Tabs.Tab>
                  <Tabs.Tab value="tensor" fz="xs" leftSection={<IconTable size={13} />}>张量</Tabs.Tab>
                  <Tabs.Tab value="samples" fz="xs" leftSection={<IconMessages size={13} />}>样例</Tabs.Tab>
                  <Tabs.Tab value="chat" fz="xs" leftSection={<IconRobot size={13} />}>AI 助手</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="terminal" style={{ flex: 1, minHeight: 0 }}>
                  {train.status === 'ready' ? (
                    <WorkbenchTerminal
                      key={`${stage.id}:${train.generation}`}
                      prompt={train.prompt}
                      onCommand={train.runCommand}
                      banner={BANNER}
                      registerInsert={registerInsert}
                    />
                  ) : (
                    <Group justify="center" p="xl">
                      {train.status === 'error'
                        ? <Alert color="red" title="Python 没起来"><Text size="xs">{train.error}</Text></Alert>
                        : <Stack align="center" gap="xs"><Loader size="sm" /><Text size="xs" c="dimmed">正在装配 Python 与算子核…</Text></Stack>}
                    </Group>
                  )}
                </Tabs.Panel>

                <Tabs.Panel value="ide" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  {stagePaths.length === 0 ? (
                    <ScrollArea h="100%" type="auto" p="md" className="panel-scroll">
                      <Alert color="gray" icon={<IconInfoCircle size={16} />}>
                        <Text size="xs">这一关没有声明 <Code>train.files</Code>，编辑器里没有东西可改。</Text>
                      </Alert>
                    </ScrollArea>
                  ) : (
                    <>
                      <Group gap="xs" p={6} style={{ borderBottom: '1px solid var(--app-border)', flexShrink: 0 }}>
                        <Select
                          size="xs"
                          value={activePath}
                          onChange={setActivePath}
                          data={stagePaths.map((path) => ({ value: path, label: path.replace(/^\/root\//, '') }))}
                          style={{ minWidth: 220 }}
                          allowDeselect={false}
                        />
                        <Tooltip label="把运行命令填进终端（要你自己回车）">
                          <Button
                            size="compact-xs"
                            variant="light"
                            onClick={() => insertCommand(`python ${(activePath ?? entry).replace(/^\/lab\//, '')}`)}
                          >
                            运行
                          </Button>
                        </Tooltip>
                      </Group>
                      <div style={{ flex: 1, minHeight: 0 }}>
                        <Editor
                          height="100%"
                          language="python"
                          theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
                          path={activePath ?? 'untitled.py'}
                          value={editorValue}
                          onChange={handleEditorChange}
                          options={{
                            fontSize: 13,
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            tabSize: 4,
                          }}
                        />
                      </div>
                    </>
                  )}
                </Tabs.Panel>

                <Tabs.Panel value="train" style={{ flex: 1, minHeight: 0 }}>
                  <ErrorBoundary fallback={renderPanelError}>
                    <TrainingPanel
                      log={train.log}
                      baselines={train.world?.baselines}
                      gates={report?.gates}
                      revision={train.revision}
                    />
                  </ErrorBoundary>
                </Tabs.Panel>

                <Tabs.Panel value="tensor" style={{ flex: 1, minHeight: 0 }}>
                  <ErrorBoundary fallback={renderPanelError}>
                    <TensorPanel
                      log={train.log}
                      metrics={train.world?.rt.metrics()}
                      revision={train.revision}
                    />
                  </ErrorBoundary>
                </Tabs.Panel>

                <Tabs.Panel value="samples" style={{ flex: 1, minHeight: 0 }}>
                  <ErrorBoundary fallback={renderPanelError}>
                    <SamplePanel log={train.log} revision={train.revision} />
                  </ErrorBoundary>
                </Tabs.Panel>

                {/*
                  AI 助手与复盘（左栏那一页）跟 ops / gpu 是同一套，
                  但喂给它的上下文得是 train 世界的 —— 模型档位、loss 曲线、
                  梯度检验的结果。世界还没有，所以这里先明说，而不是先摆一个
                  拿不到上下文的聊天框。
                */}
                <Tabs.Panel value="chat" style={{ flex: 1, minHeight: 0 }}>
                  <Pending
                    title="AI 助手"
                    waitingFor="train 世界（`@llm/lab`）—— 助手要读得到档位、指标与训练历史"
                    willShow={[
                      '带上当前关卡、门槛、学员代码与最近一次训练结果的对话',
                      '左栏还会多一页「复盘」，和 ops / gpu 一样是一篇从头读到尾的长文',
                    ]}
                  />
                </Tabs.Panel>
              </Tabs>
            )}
          />
        </div>
      </AppShell.Main>
    </AppShell>
  );
}
