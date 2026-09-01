/**
 * 内网设施形态的工作台：任务 + 终端 + IDE + 拓扑
 *
 * 四块面板共用一个世界（集群 + 机器 + 仓库 + 真 CLI），彼此不通消息 ——
 * 各自从同一份状态里取自己要的那一部分。在终端里 apply 一个 Deployment，
 * 拓扑上就长出节点、变更流里出现三条记录、IDE 的文件树里多出一个文件，
 * 不是因为三块面板互相通知了，而是因为它们看的本来就是同一样东西。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  ActionIcon, Alert, AppShell, Badge, Button, Code, Group, Loader,
  ScrollArea, Select, Stack, Switch, Tabs, Text, Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle, IconDeviceDesktop, IconFileCode, IconPlayerPlay,
  IconRefresh, IconRobot, IconRoute, IconSitemap, IconTimeline,
} from '@tabler/icons-react';
import { useMantineColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import { useTranslation } from '../../contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../AppHeader';
import MarkdownRenderer from '../MarkdownRenderer';
import ErrorBoundary from '../ErrorBoundary';
import { RunReportPanel } from '../engineering/ResultPanels';
import ChangeStream from './ChangeStream';
import WorkbenchSplit from '../workbench/WorkbenchSplit';
import MachineFiles from './MachineFiles';
import { useOpsWorkspace } from '../../hooks/useOpsWorkspace';
import { emptyMetrics, runOpsStage } from '../../lib/opslab/lab';
import { resolveTranspiler } from '../../lib/engineering/transpile';
import type { ProjectSession, ResultScope } from '../../hooks/useProjectSession';
import type { StageRunReport } from '../../lib/engineering/types';

const WorkbenchTerminal = dynamic(
  () => import('../workbench/WorkbenchTerminal'), { ssr: false }
);
const TopologyView = dynamic(() => import('./TopologyView'), { ssr: false });
const PacketPathPanel = dynamic(() => import('./PacketPathPanel'), { ssr: false });
const OpsChat = dynamic(() => import('./OpsChat'), { ssr: false });
const OpsReview = dynamic(() => import('./OpsReview'), { ssr: false });

export interface OpsWorkspaceProps {
  session: ProjectSession;
  registerClearResults: (fn: ((scope: ResultScope) => void) | null) => void;
}

const BANNER = [
  '\x1b[1mopslab\x1b[0m —— 一台连着内网集群的跳板机',
  '',
  '  shell、coreutils、kubectl、helm、docker 都是真的。',
  '  `kubectl get nodes` 起步；拓扑图上点一下会把只读命令插进来。',
  '  敲 `help` 看这台机器上都装了什么。',
  '',
].join('\r\n');

/** 右侧那一组 tab，以及记住选择用的键 */
const RIGHT_TABS = ['terminal', 'ide', 'topology', 'changes', 'packets', 'chat'];
const RIGHT_TAB_KEY = 'opslab.rightTab.v1';
const SPLIT_KEY = 'opslab.split.v1';

export default function OpsWorkspace({ session, registerClearResults }: OpsWorkspaceProps) {
  const { t } = useTranslation();
  const { colorScheme } = useMantineColorScheme();
  const { project, stage, stageIndex, progress, pick, files, handleFileChange, goToStage } = session;

  // 页面已经挡过一次了，这里再挡一次是给类型看的 —— hooks 必须在返回之前调完，
  // 所以下面所有 hook 都用可空值兜底，真正的空态在最后统一返回。
  const worldSpec = project?.workspace?.kind === 'ops' ? project.workspace.world : undefined;

  /** 草稿：只把这一关涉及的 ops 文件铺到机器上 */
  const stageFiles = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [path, content] of Object.entries(stage?.ops?.files ?? {})) {
      const draft = files.find((file) => file.path === path);
      out[path] = draft?.content ?? content;
    }
    return out;
    // 只在换关卡时重算：之后编辑器直接写 vfs，不该把世界重建掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage?.id]);

  const ops = useOpsWorkspace({
    world: worldSpec,
    stage: stage?.ops,
    stageKey: `${project?.id ?? ''}#${stage?.id ?? ''}`,
    files: stageFiles,
  });

  const [activePath, setActivePath] = useState('');
  const [report, setReport] = useState<StageRunReport | null>(null);
  const [running, setRunning] = useState(false);
  /**
   * 右侧那一组 tab 选在哪儿。
   *
   * 记住它，是因为学员在一关里来回切「敲命令 → 看拓扑 → 改 YAML」，
   * 每次进新一关都被扔回默认页很烦。挂载后再读，避免 hydration 不一致。
   */
  const [rightTab, setRightTab] = useState<string>('terminal');
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(RIGHT_TAB_KEY);
      if (saved && RIGHT_TABS.includes(saved)) setRightTab(saved);
    } catch { /* 隐私模式下读不到，用默认值 */ }
  }, []);
  const selectRightTab = useCallback((value: string | null) => {
    if (!value) return;
    setRightTab(value);
    try { window.localStorage.setItem(RIGHT_TAB_KEY, value); } catch { /* noop */ }
  }, []);
  /**
   * 包路径选中的那一跳对应的拓扑节点。
   *
   * 存在这里而不是各自面板里：两个面板在同一个位置轮换，切回拓扑时
   * 那一跳还该是圈着的 —— 不然「先看路径、再切回图上找它」这个动作就断了。
   */
  const [highlight, setHighlight] = useState<string | undefined>();
  const insertRef = useRef<((command: string) => void) | null>(null);

  // 换关卡 / 重置时把结果清掉，和代码形态一样
  useEffect(() => {
    registerClearResults(() => setReport(null));
    return () => registerClearResults(null);
  }, [registerClearResults]);

  /**
   * 复盘的结论只对「这一关的这个世界」成立。
   *
   * OpsWorkspace 换关卡时不重挂（关卡在 session 里），复盘的结果又是它自己的
   * 局部状态 —— 不管的话，学员翻到下一关，看到的还是上一关的评分和问题列表，
   * 而且被当成这一关的。「重置世界」同理：结论挂在一个已经不存在的世界上。
   * 用 key 把这两件事一起解决。
   */
  const reviewKey = `${stage?.id ?? 'none'}:${ops.generation}`;

  /**
   * 自测入口，只在开发构建里挂。
   *
   * 终端的输入走的是真键盘事件（xterm 自己解析），自动化环境很难可靠地
   * 打进去。暴露一个直接调命令的钩子，好让端到端验的是链路而不是键位。
   */
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return undefined;
    const host = window as unknown as Record<string, unknown>;
    host.__opslabRun = ops.runCommand;
    return () => { delete host.__opslabRun; };
  }, [ops.runCommand]);

  const machineFiles = useMemo(
    () => ops.world?.machine.vfs.toFileMap('/root') ?? {},
    // revision 是世界变过的信号：敲命令、编辑器写盘都会 +1
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ops.world, ops.revision]
  );

  // 默认打开这一关的主文件
  useEffect(() => {
    if (activePath && machineFiles[activePath] !== undefined) return;
    const first = Object.keys(stage?.ops?.files ?? {})[0] ?? Object.keys(machineFiles)[0];
    if (first) setActivePath(first);
  }, [machineFiles, stage?.ops, activePath]);

  const handleEditorChange = useCallback((value?: string) => {
    if (!activePath || value === undefined) return;
    ops.writeFile(activePath, value);
    // 同一份内容也写进草稿，刷新页面之后还在
    if (stage?.ops?.files?.[activePath] !== undefined) handleFileChange(activePath, value);
  }, [activePath, ops, stage?.ops, handleFileChange]);

  const registerInsert = useCallback((insert: ((command: string) => void) | null) => {
    insertRef.current = insert;
  }, []);

  /**
   * 在拓扑图上点一个节点，把对应的只读命令填进终端。
   *
   * 终端和拓扑现在是同一组 tab 里的两页，所以填完得把 tab 切过去 ——
   * 不然命令进了一个看不见的终端，学员只会觉得点了没反应。
   * 仍然只是**填进去**，不替他回车。
   */
  const handleInspect = useCallback((command: string) => {
    selectRightTab('terminal');
    insertRef.current?.(command);
  }, [selectRightTab]);

  const handleVerify = useCallback(async () => {
    if (!ops.world) return;
    setRunning(true);
    try {
      const specs = stage?.specs ?? [];
      const transpile = await resolveTranspiler(
        Object.fromEntries(specs.map((spec) => [spec.path, spec.content]))
      );
      const outcome = await runOpsStage({ world: ops.world, specs, transpile });
      setReport(outcome);
      // ops 关卡没有指标门槛，分数就按用例通过率算
      session.recordAttempt({
        stageId: stage!.id,
        passed: outcome.status === 'passed',
        passedCases: outcome.totals.passed,
        totalCases: outcome.totals.total,
        gatesPassed: true,
        score: outcome.totals.total
          ? Math.round((outcome.totals.passed / outcome.totals.total) * 100)
          : 0,
      });
    } catch (error) {
      setReport({
        status: 'error',
        totals: { total: 0, passed: 0, failed: 0 },
        cases: [], gates: [],
        metrics: emptyMetrics(0),
        console: [],
        wallClockMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunning(false);
    }
  }, [ops.world, stage?.specs, session]);

  const namespaces = useMemo(() => {
    if (!ops.world) return ['default'];
    const definition = ops.world.cluster.scheme.get({ group: '', version: 'v1', resource: 'namespaces' });
    if (!definition) return ['default'];
    return ops.world.cluster.registry.list(definition).items.map((item) => item.metadata.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops.world, ops.history.length]);

  if (!project || !stage) return null;

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
            {ops.applets.length > 0 && (
              <Badge variant="light" color="teal" size="sm">{ops.applets.join(' · ')}</Badge>
            )}
            <Tooltip label="重置这台机器与集群">
              <ActionIcon variant="subtle" color="gray" onClick={ops.reboot} aria-label="重置世界">
                <IconRefresh size={16} />
              </ActionIcon>
            </Tooltip>
            <Button
              size="xs"
              leftSection={<IconPlayerPlay size={14} />}
              loading={running}
              disabled={ops.status !== 'ready'}
              onClick={handleVerify}
            >
              验收
            </Button>
          </Group>
        }
      />
      <AppShell.Main>
        <div style={{ height: `calc(100vh - ${HEADER_HEIGHT}px)`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/*
            关卡进度条。
            换关卡会把整个世界重建 —— 每一关都从自己的起始状态开始，
            这是「反向验证」这件事成立的前提：判定看的是这一关做了什么。
          */}
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

        {/**
          * 左边任务、右边一组 tab。
          *
          * 之前是「左任务 + 右上 IDE + 右上拓扑 + 右下终端」四块写死的格子：
          * 终端只有 38% 高，拓扑固定 42% 宽，谁都拖不动、也收不起来。
          * 现在终端、IDE、拓扑并列成 tab —— 同一时刻只看一样东西，
          * 每样都占满整个右栏，而不是四块互相挤。
          */}
        {/*
          左栏的每一页都挂 `panel-scroll`（见 globals.css）。
          Mantine 的 ScrollArea 视口内层是 display: table，会收缩包裹到最宽的那个子元素 ——
          说明里有一个宽代码块，整页的段落就都按那个宽度排，于是左栏出现横向滚动条、
          文字被裁掉半句。panel-scroll 把它改回 block，宽内容各自横向滚。
        */}
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
                <Tabs.Tab value="review" fz="xs">复盘</Tabs.Tab>
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
              {/**
                * 复盘。评的是操作过程，不是验收结果 —— 验收只查关键点，
                * 把 replicas 调成 0 也能让 CrashLoopBackOff 消失。
                */}
              <Tabs.Panel value="review" style={{ flex: 1, minHeight: 0 }}>
                <ScrollArea h="100%" type="auto" p="sm" className="panel-scroll">
                  <ErrorBoundary fallback={renderPanelError}>
                    <OpsReview
                      key={reviewKey}
                      projectTitle={project.title}
                      projectSummary={project.summary}
                      stageTitle={stage.title}
                      stageGoal={stage.goal}
                      stageIndex={stageIndex}
                      stageCount={project.stages.length}
                      checklist={stage.checklist}
                      world={ops.world}
                      history={ops.history}
                      namespace={ops.namespace}
                      files={machineFiles}
                      report={report}
                    />
                  </ErrorBoundary>
                </ScrollArea>
              </Tabs.Panel>
            </Tabs>
          )}
          right={(
            <Tabs
              value={rightTab}
              onChange={selectRightTab}
              style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
            >
              <Group
                gap="xs"
                justify="space-between"
                wrap="nowrap"
                style={{ borderBottom: '1px solid var(--app-border)', flexShrink: 0 }}
              >
                <Tabs.List style={{ border: 'none', flexWrap: 'nowrap' }}>
                  <Tabs.Tab value="terminal" fz="xs" leftSection={<IconDeviceDesktop size={13} />}>
                    终端{ops.history.length > 0 ? ` · ${ops.history.length}` : ''}
                  </Tabs.Tab>
                  <Tabs.Tab value="ide" fz="xs" leftSection={<IconFileCode size={13} />}>IDE</Tabs.Tab>
                  <Tabs.Tab value="topology" fz="xs" leftSection={<IconSitemap size={13} />}>拓扑</Tabs.Tab>
                  <Tabs.Tab value="changes" fz="xs" leftSection={<IconTimeline size={13} />}>事件与变更</Tabs.Tab>
                  <Tabs.Tab value="packets" fz="xs" leftSection={<IconRoute size={13} />}>包路径</Tabs.Tab>
                  <Tabs.Tab value="chat" fz="xs" leftSection={<IconRobot size={13} />}>
                    {t('opslab.chat.tab')}
                  </Tabs.Tab>
                </Tabs.List>

                {/* 只跟集群视图有关的控件。切到终端或者 IDE 的时候它们没有意义，就别占地方。 */}
                {(rightTab === 'topology' || rightTab === 'changes' || rightTab === 'packets') && (
                  <Group gap="xs" wrap="nowrap" pr="sm">
                    {rightTab === 'topology' && (
                      <Switch
                        size="xs"
                        label="ReplicaSet"
                        checked={ops.showReplicaSets}
                        onChange={(event) => ops.setShowReplicaSets(event.currentTarget.checked)}
                      />
                    )}
                    <Select
                      size="xs"
                      w={130}
                      value={ops.namespace}
                      onChange={(value) => value && ops.setNamespace(value)}
                      data={namespaces}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </Group>
                )}
              </Group>

              {/**
                * 面板全部保持挂载（Mantine 默认如此），只是切走的时候 display:none。
                * 终端的 scrollback 和 Monaco 的编辑状态都不能因为切个 tab 就没了。
                */}
              <Tabs.Panel value="terminal" style={{ flex: 1, minHeight: 0 }}>
                {ops.status === 'booting' && (
                  <Stack align="center" justify="center" h="100%" gap="xs">
                    <Loader size="sm" />
                    <Text size="xs" c="dimmed">正在拉起集群与 CLI（第一次要下载并编译 wasm）…</Text>
                  </Stack>
                )}
                {ops.status === 'error' && (
                  <Alert color="red" title="世界没起来" icon={<IconAlertTriangle size={16} />} m="sm">
                    <Stack gap="xs" align="flex-start">
                      <Code block style={{ whiteSpace: 'pre-wrap' }}>{ops.error}</Code>
                      <Text size="xs" c="dimmed">
                        缺 CLI 产物时先跑 <Code>bash scripts/build-opslab-wasm.sh</Code>。
                      </Text>
                      <Button size="xs" variant="light" onClick={ops.reboot}>重试</Button>
                    </Stack>
                  </Alert>
                )}
                {ops.status === 'ready' && (
                  <WorkbenchTerminal
                    prompt={ops.prompt}
                    banner={BANNER}
                    onCommand={ops.runCommand}
                    registerInsert={registerInsert}
                  />
                )}
              </Tabs.Panel>

              <Tabs.Panel value="ide" style={{ flex: 1, minHeight: 0 }}>
                <div style={{ display: 'flex', height: '100%', minWidth: 0 }}>
                  <div style={{ width: 180, flexShrink: 0, borderRight: '1px solid var(--app-border)', display: 'flex', flexDirection: 'column' }}>
                    <Group gap={6} px="sm" py={6} style={{ borderBottom: '1px solid var(--app-border)' }}>
                      <IconFileCode size={13} />
                      <Text size="xs" fw={600}>机器磁盘</Text>
                    </Group>
                    <MachineFiles files={machineFiles} activePath={activePath} onSelect={setActivePath} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {activePath ? (
                      <Editor
                        height="100%"
                        path={activePath}
                        language={languageOf(activePath)}
                        value={machineFiles[activePath] ?? ''}
                        theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
                        onChange={handleEditorChange}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 13,
                          tabSize: 2,
                          scrollBeyondLastLine: false,
                          automaticLayout: true,
                        }}
                      />
                    ) : (
                      <Stack align="center" justify="center" h="100%">
                        <Text size="xs" c="dimmed">左边选一个文件</Text>
                      </Stack>
                    )}
                  </div>
                </div>
              </Tabs.Panel>

              {/**
                * 拓扑这一页切走就卸载，和别的页不一样。
                *
                * 它是世界的纯投影，没有自己的状态，卸载不丢任何东西；而留着的话
                * 代价很实在：隐藏期间 ReactFlow 把每个节点量成 0×0，切回来时
                * fitView 按错的包围盒算，缩放停在最小值 0.5，看着就是一张空白画布
                * （要再切一次才正常）。重新挂载则是它最顺的那条路 —— 容器一开始
                * 就有尺寸，`fitView` 属性自己就对了。
                */}
              <Tabs.Panel value="topology" style={{ flex: 1, minHeight: 0 }}>
                {rightTab === 'topology' && (
                  <ErrorBoundary fallback={renderPanelError}>
                    <TopologyView graph={ops.topology} onInspect={handleInspect} highlight={highlight} />
                  </ErrorBoundary>
                )}
              </Tabs.Panel>

              <Tabs.Panel value="changes" style={{ flex: 1, minHeight: 0 }}>
                <ErrorBoundary fallback={renderPanelError}>
                  <ChangeStream changes={ops.changes} events={ops.events} />
                </ErrorBoundary>
              </Tabs.Panel>

              <Tabs.Panel value="packets" style={{ flex: 1, minHeight: 0 }}>
                <ErrorBoundary fallback={renderPanelError}>
                  <PacketPathPanel paths={ops.packetPaths} onHighlight={setHighlight} />
                </ErrorBoundary>
              </Tabs.Panel>

              {/**
                * AI 助手。
                *
                * 保持挂载：对话历史不能因为切去看一眼拓扑就没了。
                * 它只读世界，不执行任何命令 —— 建议的命令由学员自己敲进终端。
                */}
              <Tabs.Panel value="chat" style={{ flex: 1, minHeight: 0 }}>
                <ErrorBoundary fallback={renderPanelError}>
                  <OpsChat
                    projectTitle={project.title}
                    projectSummary={project.summary}
                    stageTitle={stage.title}
                    stageGoal={stage.goal}
                    stageIndex={stageIndex}
                    stageCount={project.stages.length}
                    checklist={stage.checklist}
                    world={ops.world}
                    history={ops.history}
                    namespace={ops.namespace}
                    files={machineFiles}
                    report={report}
                  />
                </ErrorBoundary>
              </Tabs.Panel>
            </Tabs>
          )}
        />
        </div>
      </AppShell.Main>
    </AppShell>
  );
}

function renderPanelError(error: Error, reset: () => void) {
  return (
    <Alert color="red" title="这块面板画不出来" icon={<IconAlertTriangle size={16} />} m="sm">
      <Stack gap="xs" align="flex-start">
        <Code block style={{ whiteSpace: 'pre-wrap' }}>{error.message}</Code>
        <Button size="xs" variant="light" color="red" onClick={reset}>重试</Button>
      </Stack>
    </Alert>
  );
}

function languageOf(path: string): string {
  if (/\.ya?ml$/.test(path)) return 'yaml';
  if (/\.json$/.test(path)) return 'json';
  if (/\.sh$/.test(path)) return 'shell';
  if (/\.md$/.test(path)) return 'markdown';
  if (/Dockerfile$/.test(path)) return 'dockerfile';
  return 'plaintext';
}
