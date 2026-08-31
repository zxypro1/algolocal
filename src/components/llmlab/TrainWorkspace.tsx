/**
 * train 形态的工作台：任务 + 终端 + IDE + 训练 + 张量 + 样例
 *
 * 布局和 ops / gpu 一致：左边任务、右边一组 tab，分隔条能拖、左栏能收起、
 * 位置记在 localStorage 里。**同一时刻只看一样东西**，每样都占满整个右栏。
 *
 * 面板之间不发消息（同 ops / gpu 的定论）。终端里 `python train.py` 之后，
 * 训练面板上的曲线变了，不是因为终端通知了它，而是两边看的是同一个世界。
 *
 * ## 这一片做到哪
 *
 * **分发已经接通，Python 运行时还没接。** 这是有意的顺序：
 * design/llmlab.md 第五节最后一段把它写成了硬规矩 —— gpulab 那次
 * 29 关全做完、测试全绿、包都发了，才发现工作台一行没写。
 * 所以这次先让「点进去有东西」成立，再往里填。
 *
 * 现在能用的：任务 / 背景 / 验收 / 复盘四页，以及 **IDE 真的能改文件、
 * 草稿真的存得住**（走 `stage.train.files` + `handleFileChange`）。
 * 还没接的三块面板各自明说自己在等什么，而不是渲染一块空白。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, AppShell, Badge, Button, Code, Group, List,
  ScrollArea, Select, Stack, Tabs, Text, Tooltip,
} from '@mantine/core';
import {
  IconChartLine, IconFileCode, IconInfoCircle, IconMessages,
  IconPlayerPlay, IconRobot, IconTable, IconTerminal2,
} from '@tabler/icons-react';
import { useMantineColorScheme } from '@mantine/core';
import Editor from '@monaco-editor/react';
import { AppHeader, HEADER_HEIGHT } from '../AppHeader';
import MarkdownRenderer from '../MarkdownRenderer';
import { RunReportPanel } from '../engineering/ResultPanels';
import WorkbenchSplit from '../workbench/WorkbenchSplit';
import type { ProjectSession, ResultScope } from '../../hooks/useProjectSession';
import type { StageRunReport } from '../../lib/engineering/types';

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
  const [rightTab, setRightTab] = useState('ide');
  const [activePath, setActivePath] = useState<string | null>(null);

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
    handleFileChange(activePath, value);
  }, [activePath, handleFileChange]);

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
            <Badge variant="light" color="orange" size="sm">Python 运行时未接入</Badge>
            <Tooltip label="Pyodide 与 nanotorch 还没接进来，验收暂时跑不了">
              <Button size="xs" leftSection={<IconPlayerPlay size={14} />} disabled>
                验收
              </Button>
            </Tooltip>
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
                  <Pending
                    title="终端"
                    waitingFor="Pyodide 装配（虚拟 FS、模块注入、stdout 转发）"
                    willShow={[
                      `python ${entry} —— 真的跑学员写的训练脚本`,
                      'python -m nanotorch.gradcheck —— fp64 那一遍梯度检验',
                      'ls / head / cat —— 复用 labkit 的 shell 与 coreutils',
                    ]}
                  />
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
                  <Pending
                    title="训练"
                    waitingFor="WASM 算子核 + JS 桥的计量层"
                    willShow={[
                      'loss 曲线（训练 / 验证双线），以及第 2 关那条 bigram 基线',
                      '学习率、梯度范数、每步 token 数',
                      '每条门槛的实时值与目标值',
                    ]}
                  />
                </Tabs.Panel>

                <Tabs.Panel value="tensor" style={{ flex: 1, minHeight: 0 }}>
                  <Pending
                    title="张量"
                    waitingFor="nanotorch 的前向与 JS 桥的张量视图"
                    willShow={[
                      '注意力热图（选层选头）—— 因果掩码写错时右上三角会亮',
                      '激活与梯度直方图、逐层范数',
                      '参数量与显存分解（嵌入 / 注意力 / MLP / 优化器状态 / 激活）',
                    ]}
                  />
                </Tabs.Panel>

                <Tabs.Panel value="samples" style={{ flex: 1, minHeight: 0 }}>
                  <Pending
                    title="样例"
                    waitingFor="采样与 KV cache（第 8 关）"
                    willShow={[
                      '生成样例，token 按 logprob 着色',
                      'SFT 前后对比、偏好对（chosen / rejected）与 reward',
                      'GRPO 的一组 rollout，每条带 reward 与 advantage，组内均值画在旁边',
                    ]}
                  />
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
