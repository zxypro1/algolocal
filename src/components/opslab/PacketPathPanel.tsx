/**
 * 包路径
 *
 * 排查网络问题时最缺的一句话是「这个包走到哪一步被拦下的」。这里把最近几次
 * 连接逐跳列出来，选中某一跳就在拓扑图上把对应的节点圈出来。
 *
 * 刻意不做成动画自动播放：学员要停在某一跳上读那行 detail，而不是看它闪过去。
 * 「上一跳 / 下一跳」是手动的，键盘也能走。
 */
import { useEffect, useState } from 'react';
import { ActionIcon, Badge, Group, ScrollArea, Select, Stack, Text, Tooltip } from '@mantine/core';
import { IconArrowLeft, IconArrowRight } from '@tabler/icons-react';
import type { PacketPath, PacketStep } from '../../lib/opslab/lab';

const VERDICT: Record<PacketStep['verdict'], { color: string; label: string }> = {
  forward: { color: 'blue', label: '转发' },
  deliver: { color: 'teal', label: '送达' },
  drop: { color: 'red', label: '丢弃' },
  reject: { color: 'orange', label: '拒绝' },
};

const OUTCOME: Record<PacketPath['outcome'], { color: string; label: string }> = {
  ok: { color: 'teal', label: '通' },
  refused: { color: 'orange', label: '连接被拒' },
  timeout: { color: 'red', label: '超时' },
  reset: { color: 'orange', label: '连接重置' },
  'no-route': { color: 'red', label: '没有路由' },
  'dns-failure': { color: 'red', label: '解析失败' },
};

export interface PacketPathPanelProps {
  paths: PacketPath[];
  /** 选中的那一跳对应的拓扑节点 —— 交给拓扑图去高亮 */
  onHighlight?: (nodeId: string | undefined) => void;
}

export default function PacketPathPanel({ paths, onHighlight }: PacketPathPanelProps) {
  const [pathId, setPathId] = useState<number | undefined>(paths[0]?.id);
  const [stepIndex, setStepIndex] = useState(0);

  // 有新的连接进来就跳到它，并从第一跳开始
  useEffect(() => {
    if (paths.length === 0) return;
    if (!paths.some((path) => path.id === pathId)) {
      setPathId(paths[0].id);
      setStepIndex(0);
    }
  }, [paths, pathId]);

  const path = paths.find((item) => item.id === pathId) ?? paths[0];
  const step = path?.steps[stepIndex];

  useEffect(() => {
    onHighlight?.(step?.nodeId);
  }, [step?.nodeId, onHighlight]);

  if (!path) {
    return (
      <Stack align="center" justify="center" h="100%" gap={4}>
        <Text size="sm" c="dimmed">还没有发过请求</Text>
        <Text size="xs" c="dimmed">在终端里 curl 一下，这里会记下包走过的每一跳</Text>
      </Stack>
    );
  }

  const outcome = OUTCOME[path.outcome];
  const move = (delta: number) => {
    setStepIndex((value) => Math.min(Math.max(value + delta, 0), path.steps.length - 1));
  };

  return (
    <Stack gap={0} h="100%">
      <Group gap="xs" px="sm" py={6} style={{ borderBottom: '1px solid var(--app-border)' }}>
        <Select
          size="xs"
          flex={1}
          value={String(path.id)}
          onChange={(value) => { if (value) { setPathId(Number(value)); setStepIndex(0); } }}
          data={paths.map((item) => ({
            value: String(item.id),
            label: `#${item.id} ${item.from} → ${item.to}`,
          }))}
          comboboxProps={{ withinPortal: true }}
        />
        <Tooltip label="上一跳"><ActionIcon size="sm" variant="default" onClick={() => move(-1)} disabled={stepIndex === 0}>
          <IconArrowLeft size={13} />
        </ActionIcon></Tooltip>
        <Tooltip label="下一跳"><ActionIcon
          size="sm" variant="default" onClick={() => move(1)}
          disabled={stepIndex >= path.steps.length - 1}
        >
          <IconArrowRight size={13} />
        </ActionIcon></Tooltip>
      </Group>

      <Group gap={8} px="sm" py={6} style={{ borderBottom: '1px solid var(--app-border)' }}>
        <Badge size="sm" color={outcome.color} variant="light">{outcome.label}</Badge>
        {path.status !== undefined && <Badge size="sm" variant="default">HTTP {path.status}</Badge>}
        <Text size="xs" c="dimmed">{path.totalMs} ms</Text>
        {path.blockedBy && (
          <Text size="xs" c="dimmed" truncate>被 {path.blockedBy} 挡下</Text>
        )}
      </Group>

      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Stack gap={0} p="xs">
          {path.steps.map((item, index) => {
            const verdict = VERDICT[item.verdict];
            const active = index === stepIndex;
            return (
              <button
                key={item.index}
                type="button"
                onClick={() => setStepIndex(index)}
                style={{
                  textAlign: 'left',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: active ? 'var(--mantine-color-default-hover)' : 'transparent',
                  borderLeft: `3px solid var(--mantine-color-${verdict.color}-6)`,
                  marginBottom: 2,
                }}
              >
                <Group gap={6} wrap="nowrap">
                  <Text size="10px" c="dimmed" w={18}>{item.index}</Text>
                  <Text size="xs" fw={600} truncate style={{ flex: 1 }}>{item.at}</Text>
                  <Badge size="xs" color={verdict.color} variant="light">{verdict.label}</Badge>
                  <Text size="10px" c="dimmed">{item.elapsedMs}ms</Text>
                </Group>
                <Text size="11px" c="dimmed" pl={24} style={{ whiteSpace: 'normal' }}>{item.detail}</Text>
              </button>
            );
          })}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}
