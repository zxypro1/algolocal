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
  Paper, ScrollArea, SegmentedControl, Select, Stack, Switch, Tabs, Text, Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle, IconDeviceDesktop, IconFileCode, IconPlayerPlay,
  IconRefresh, IconSitemap, IconTimeline,
} from '@tabler/icons-react';
import { useMantineColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import { useTranslation } from '../../contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../AppHeader';
import MarkdownRenderer from '../MarkdownRenderer';
import ErrorBoundary from '../ErrorBoundary';
import { RunReportPanel } from '../engineering/ResultPanels';
import ChangeStream from './ChangeStream';
import MachineFiles from './MachineFiles';
import { useOpsWorkspace } from '../../hooks/useOpsWorkspace';
import { runOpsStage } from '../../lib/opslab/lab';
import { resolveTranspiler } from '../../lib/engineering/transpile';
import type { ProjectSession, ResultScope } from '../../hooks/useProjectSession';
import type { StageRunReport } from '../../lib/engineering/types';

const OpsTerminal = dynamic(() => import('./OpsTerminal'), { ssr: false });
const TopologyView = dynamic(() => import('./TopologyView'), { ssr: false });

export interface OpsWorkspaceProps {
  session: ProjectSession;
  registerClearResults: (fn: ((scope: ResultScope) => void) | null) => void;
}

const BANNER = [
  '\x1b[1mopslab\x1b[0m —— 一台连着内网集群的跳板机',
  '',
  '  shell、coreutils、kubectl、helm、docker 都是真的。',
  '  `kubectl get nodes` 起步；拓扑图上点一下会把只读命令插进来。',
  '',
].join('\r\n');

export default function OpsWorkspace({ session, registerClearResults }: OpsWorkspaceProps) {
  const { t } = useTranslation();
  const { colorScheme } = useMantineColorScheme();
  const { project, stage, stageIndex, pick, files, handleFileChange } = session;

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
  const [rightTab, setRightTab] = useState<string>('topology');
  const insertRef = useRef<((command: string) => void) | null>(null);

  // 换关卡 / 重置时把结果清掉，和代码形态一样
  useEffect(() => {
    registerClearResults(() => setReport(null));
    return () => registerClearResults(null);
  }, [registerClearResults]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ops.world, ops.history.length, activePath, report]
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

  const handleInspect = useCallback((command: string) => {
    insertRef.current?.(command);
  }, []);

  const handleVerify = useCallback(async () => {
    if (!ops.world) return;
    setRunning(true);
    try {
      const specs = stage?.specs ?? [];
      const transpile = await resolveTranspiler(
        Object.fromEntries(specs.map((spec) => [spec.path, spec.content]))
      );
      setReport(await runOpsStage({ world: ops.world, specs, transpile }));
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
  }, [ops.world, stage?.specs]);

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
        <div style={{ height: `calc(100vh - ${HEADER_HEIGHT}px)`, display: 'flex', minHeight: 0 }}>
          {/* 任务 */}
          <Paper
            withBorder={false}
            style={{ width: 340, flexShrink: 0, borderRight: '1px solid var(--app-border)', display: 'flex', flexDirection: 'column' }}
          >
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
          </Paper>

          {/* 右侧：上面是 IDE 与拓扑，下面是终端 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ flex: 1, display: 'flex', minHeight: 0, borderBottom: '1px solid var(--app-border)' }}>
              {/* IDE */}
              <div style={{ flex: 1, display: 'flex', minWidth: 0, borderRight: '1px solid var(--app-border)' }}>
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

              {/* 拓扑 / 变更流 */}
              <div style={{ width: '42%', minWidth: 320, display: 'flex', flexDirection: 'column' }}>
                <Group gap="xs" px="sm" py={4} justify="space-between" style={{ borderBottom: '1px solid var(--app-border)' }}>
                  <SegmentedControl
                    size="xs"
                    value={rightTab}
                    onChange={setRightTab}
                    data={[
                      { value: 'topology', label: <Group gap={4} wrap="nowrap"><IconSitemap size={12} />拓扑</Group> },
                      { value: 'changes', label: <Group gap={4} wrap="nowrap"><IconTimeline size={12} />事件与变更</Group> },
                    ]}
                  />
                  <Group gap="xs">
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
                </Group>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <ErrorBoundary fallback={renderPanelError}>
                    {rightTab === 'topology'
                      ? <TopologyView graph={ops.topology} onInspect={handleInspect} />
                      : <ChangeStream changes={ops.changes} events={ops.events} />}
                  </ErrorBoundary>
                </div>
              </div>
            </div>

            {/* 终端 */}
            <div style={{ height: '38%', minHeight: 180, display: 'flex', flexDirection: 'column' }}>
              <Group gap={6} px="sm" py={4} style={{ borderBottom: '1px solid var(--app-border)' }}>
                <IconDeviceDesktop size={13} />
                <Text size="xs" fw={600}>终端</Text>
                <Text size="xs" c="dimmed">{ops.history.length} 条命令</Text>
              </Group>
              <div style={{ flex: 1, minHeight: 0 }}>
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
                  <OpsTerminal
                    prompt={ops.prompt}
                    banner={BANNER}
                    onCommand={ops.runCommand}
                    registerInsert={registerInsert}
                  />
                )}
              </div>
            </div>
          </div>
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
