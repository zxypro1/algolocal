/**
 * GPU 形态的工作台：任务 + 终端 + IDE + 剖析 + 访存 + 集群
 *
 * 布局和 ops 那边一致：左边任务、右边一组 tab，分隔条能拖、左栏能收起、
 * 位置记在 localStorage 里。**同一时刻只看一样东西**，每样都占满整个右栏 ——
 * 而不是几块面板互相挤。
 *
 * 面板之间不发消息。在终端里 `nvcc -o bench x.cu && ncu ./bench` 之后，
 * 剖析面板上的数字变了，不是因为终端通知了它，而是两边看的是同一台设备。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  ActionIcon, Alert, AppShell, Badge, Button, Group, Loader,
  ScrollArea, Select, Stack, Tabs, Text, Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle, IconChartHistogram, IconFileCode,
  IconPlayerPlay, IconRefresh, IconTerminal2,
} from '@tabler/icons-react';
import { useMantineColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import { AppHeader, HEADER_HEIGHT } from '../AppHeader';
import MarkdownRenderer from '../MarkdownRenderer';
import ErrorBoundary from '../ErrorBoundary';
import { RunReportPanel } from '../engineering/ResultPanels';
import WorkbenchSplit from '../workbench/WorkbenchSplit';
import { useGpuWorkspace } from '../../hooks/useGpuWorkspace';
import { runGpuStage } from '../../lib/gpulab/lab';
import { resolveTranspiler } from '../../lib/engineering/transpile';
import type { ProjectSession, ResultScope } from '../../hooks/useProjectSession';
import type { StageRunReport } from '../../lib/engineering/types';

const WorkbenchTerminal = dynamic(
  () => import('../workbench/WorkbenchTerminal'), { ssr: false }
);
const ProfilePanel = dynamic(() => import('./ProfilePanel'), { ssr: false });

export interface GpuWorkspaceProps {
  session: ProjectSession;
  registerClearResults: (fn: ((scope: ResultScope) => void) | null) => void;
}

const BANNER = [
  '\x1b[1mgpulab\x1b[0m —— 一台装着 CUDA 工具链的开发机',
  '',
  '  nvcc、ncu、compute-sanitizer、nvidia-smi 都在。',
  '  `nvcc -o bench <源文件> && ./bench` 起步，然后 `ncu ./bench` 看指标。',
  '',
].join('\r\n');

const RIGHT_TAB_KEY = 'gpulab.rightTab.v1';
const SPLIT_KEY = 'gpulab.split.v1';

/**
 * 剖析与访存面板从第 2 关起才有意义（第 1 关只要求写对），
 * 集群面板要有第二张卡才有东西可画。
 *
 * 判据用**世界里有什么**而不是关卡编号 —— 编号会随大纲调整而变，
 * 而「这一关是不是集群关」是世界自己说了算的。
 */
function renderPanelError(error: Error) {
  return (
    <Alert color="red" icon={<IconAlertTriangle size={16} />} m="sm">
      <Text size="xs">这块面板炸了：{error.message}</Text>
    </Alert>
  );
}

export default function GpuWorkspace({ session, registerClearResults }: GpuWorkspaceProps) {
  const { colorScheme } = useMantineColorScheme();
  const { project, stage, stageIndex, progress, pick, files, handleFileChange, goToStage } = session;

  // 页面已经挡过一次了，这里再挡一次是给类型看的 —— hooks 必须在返回之前调完
  const worldSpec = project?.workspace?.kind === 'gpu' ? project.workspace.world : undefined;

  /** 草稿：把这一关涉及的源文件铺到机器上 */
  const stageFiles = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [path, content] of Object.entries(stage?.gpu?.files ?? {})) {
      const draft = files.find((file) => file.path === path);
      out[path] = draft?.content ?? content;
    }
    return out;
    // 只在换关卡时重算：之后编辑器直接写 vfs，不该把世界重建掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage?.id]);

  const gpu = useGpuWorkspace({
    world: worldSpec,
    stage: stage?.gpu,
    stageKey: `${project?.id ?? ''}:${stage?.id ?? ''}`,
    files: stageFiles,
  });

  const [report, setReport] = useState<StageRunReport | null>(null);
  const [running, setRunning] = useState(false);
  const [rightTab, setRightTab] = useState('terminal');
  const [activePath, setActivePath] = useState<string | null>(null);
  const insertRef = useRef<((command: string) => void) | null>(null);

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
    setActivePath(gpu.sourcePaths[0] ?? null);
    setReport(null);
  }, [gpu.sourcePaths]);

  const editorValue = useMemo(
    () => (activePath ? gpu.readFile(activePath) : ''),
    // 换文件或者重建世界时才重读；之后编辑器自己维护内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activePath, gpu.generation, gpu.status]
  );

  const handleEditorChange = useCallback((value?: string) => {
    if (!activePath || value === undefined) return;
    gpu.writeFile(activePath, value);
    // 同一份内容也写进草稿，刷新页面之后还在
    if (stage?.gpu?.files?.[activePath] !== undefined) handleFileChange(activePath, value);
  }, [activePath, gpu, stage?.gpu, handleFileChange]);

  const registerInsert = useCallback((insert: ((command: string) => void) | null) => {
    insertRef.current = insert;
  }, []);

  /**
   * 把一条命令填进终端。
   *
   * 只是**填进去**，不替他回车 —— 和 ops 那边一个规矩：
   * 命令是学员自己敲下去的，这一点在教学上不能含糊。
   */
  const insertCommand = useCallback((command: string) => {
    selectRightTab('terminal');
    insertRef.current?.(command);
  }, [selectRightTab]);

  const handleVerify = useCallback(async () => {
    if (!gpu.world) return;
    setRunning(true);
    try {
      const specs = stage?.specs ?? [];
      const transpile = await resolveTranspiler(
        Object.fromEntries(specs.map((spec) => [spec.path, spec.content]))
      );
      const outcome = await runGpuStage({
        world: gpu.world,
        specs,
        gates: stage?.gates ?? [],
        transpile,
      });
      setReport(outcome);
      const gatesPassed = outcome.gates.every((gate) => gate.passed);
      session.recordAttempt({
        stageId: stage!.id,
        passed: outcome.status === 'passed',
        passedCases: outcome.totals.passed,
        totalCases: outcome.totals.total,
        gatesPassed,
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
  }, [gpu.world, stage, session]);

  /** 集群关卡在标题上多显示卡数（集群面板在后面的切片里补） */
  const isCluster = Boolean(gpu.world?.cluster);

  if (!project || !stage) return null;

  const buildCommand = `nvcc -o bench ${(stage.gpu?.bench?.sources ?? []).join(' ')} && ./bench`;

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
            {gpu.world && (
              <Badge variant="light" color="teal" size="sm">
                {gpu.world.device.name}
                {isCluster ? ` × ${gpu.world.cluster!.count}` : ''}
              </Badge>
            )}
            <Tooltip label="重置这台机器与设备">
              <ActionIcon variant="subtle" color="gray" onClick={gpu.reboot} aria-label="重置世界">
                <IconRefresh size={16} />
              </ActionIcon>
            </Tooltip>
            <Button
              size="xs"
              leftSection={<IconPlayerPlay size={14} />}
              loading={running}
              disabled={gpu.status !== 'ready'}
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
                  <ScrollArea h="100%" type="auto" p="sm">
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
                  <ScrollArea h="100%" type="auto" p="sm">
                    <MarkdownRenderer content={pick(stage.primer)} />
                  </ScrollArea>
                </Tabs.Panel>
                <Tabs.Panel value="result" style={{ flex: 1, minHeight: 0 }}>
                  <ScrollArea h="100%" type="auto" p="sm">
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
                  <Tabs.Tab value="terminal" fz="xs" leftSection={<IconTerminal2 size={13} />}>
                    终端
                  </Tabs.Tab>
                  <Tabs.Tab value="ide" fz="xs" leftSection={<IconFileCode size={13} />}>
                    IDE
                  </Tabs.Tab>
                  <Tabs.Tab value="profile" fz="xs" leftSection={<IconChartHistogram size={13} />}>
                    剖析
                  </Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="terminal" style={{ flex: 1, minHeight: 0 }}>
                  {gpu.status === 'ready' ? (
                    <WorkbenchTerminal
                      key={`${stage.id}:${gpu.generation}`}
                      prompt={gpu.prompt}
                      onCommand={gpu.runCommand}
                      banner={BANNER}
                      registerInsert={registerInsert}
                    />
                  ) : (
                    <Group justify="center" p="xl">
                      {gpu.status === 'error'
                        ? <Alert color="red" title="设备没起来"><Text size="xs">{gpu.error}</Text></Alert>
                        : <Loader size="sm" />}
                    </Group>
                  )}
                </Tabs.Panel>

                <Tabs.Panel value="ide" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <Group gap="xs" p={6} style={{ borderBottom: '1px solid var(--app-border)', flexShrink: 0 }}>
                    <Select
                      size="xs"
                      value={activePath}
                      onChange={setActivePath}
                      data={gpu.sourcePaths.map((path) => ({ value: path, label: path.replace('/root/', '') }))}
                      style={{ minWidth: 200 }}
                      allowDeselect={false}
                    />
                    <Tooltip label="把编译并运行的命令填进终端">
                      <Button
                        size="compact-xs"
                        variant="light"
                        onClick={() => insertCommand(buildCommand)}
                      >
                        编译并运行
                      </Button>
                    </Tooltip>
                    <Tooltip label="把剖析命令填进终端">
                      <Button size="compact-xs" variant="subtle" onClick={() => insertCommand('ncu ./bench')}>
                        ncu
                      </Button>
                    </Tooltip>
                  </Group>
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <Editor
                      height="100%"
                      language="cpp"
                      theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
                      path={activePath ?? 'untitled.cu'}
                      value={editorValue}
                      onChange={handleEditorChange}
                      options={{
                        fontSize: 13,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        tabSize: 2,
                      }}
                    />
                  </div>
                </Tabs.Panel>

                <Tabs.Panel value="profile" style={{ flex: 1, minHeight: 0 }}>
                  <ErrorBoundary fallback={renderPanelError}>
                    <ProfilePanel world={gpu.world} revision={gpu.revision} onInsert={insertCommand} />
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
