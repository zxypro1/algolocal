/**
 * 事件与变更流
 *
 * 设计里原本叫「执行轨迹」，换成这个：轨迹是给代码看的，运维现场真正要看的是
 * **集群自己说了什么**（Event）和**刚才那条命令改动了什么**（变更集）。
 * 两者按虚拟时间排在一起，就是一次操作的完整因果链。
 */
import { Badge, Group, ScrollArea, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconCircleMinus, IconCirclePlus, IconInfoCircle, IconPencil } from '@tabler/icons-react';
import type { KubeObject } from '../../lib/opslab/apiserver';
import type { ChangeEntry } from '../../lib/opslab/lab';

export interface ChangeStreamProps {
  changes: ChangeEntry[];
  events: KubeObject[];
}

const CHANGE_ICON = {
  added: { icon: IconCirclePlus, color: 'teal', label: '新增' },
  modified: { icon: IconPencil, color: 'blue', label: '变更' },
  deleted: { icon: IconCircleMinus, color: 'red', label: '删除' },
} as const;

export default function ChangeStream({ changes, events }: ChangeStreamProps) {
  const warnings = events.filter((event) => event.type === 'Warning').length;

  return (
    <Stack gap={0} h="100%">
      <Group gap="xs" px="sm" py={6} style={{ borderBottom: '1px solid var(--app-border)' }}>
        <Text size="xs" fw={600}>上一条命令的变更</Text>
        <Badge size="xs" variant="light" color={changes.length ? 'blue' : 'gray'}>
          {changes.length}
        </Badge>
        <Text size="xs" fw={600} ml="md">集群事件</Text>
        <Badge size="xs" variant="light" color={warnings ? 'orange' : 'gray'}>
          {events.length}{warnings ? ` · ${warnings} 警告` : ''}
        </Badge>
      </Group>

      <ScrollArea style={{ flex: 1 }} type="auto">
        <Stack gap={2} p="xs">
          {changes.length === 0 && events.length === 0 && (
            <Text size="xs" c="dimmed" ta="center" py="lg">
              还没有变更。敲一条命令，这里会显示它动了什么。
            </Text>
          )}

          {changes.map((change, index) => {
            const meta = CHANGE_ICON[change.type];
            const Icon = meta.icon;
            return (
              <Group key={`${change.type}-${change.kind}-${change.name}-${index}`} gap={6} wrap="nowrap">
                <ThemeIcon size={16} variant="light" color={meta.color}>
                  <Icon size={11} />
                </ThemeIcon>
                <Text size="xs" c="dimmed" w={30}>{meta.label}</Text>
                <Text size="xs" ff="monospace" truncate>
                  {change.kind.toLowerCase()}/{change.name}
                  {change.namespace ? ` · ${change.namespace}` : ''}
                </Text>
              </Group>
            );
          })}

          {events.length > 0 && changes.length > 0 && (
            <div style={{ height: 1, background: 'var(--app-border)', margin: '6px 0' }} />
          )}

          {events.map((event) => {
            const warning = event.type === 'Warning';
            const involved = event.involvedObject as { kind?: string; name?: string } | undefined;
            return (
              <Group key={event.metadata.name} gap={6} wrap="nowrap" align="flex-start">
                <ThemeIcon size={16} variant="light" color={warning ? 'orange' : 'gray'}>
                  {warning ? <IconAlertTriangle size={11} /> : <IconInfoCircle size={11} />}
                </ThemeIcon>
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    <Text size="xs" fw={600}>{String(event.reason ?? '')}</Text>
                    <Text size="xs" c="dimmed" ff="monospace" truncate>
                      {involved?.kind?.toLowerCase()}/{involved?.name}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed" style={{ wordBreak: 'break-word' }}>
                    {String(event.message ?? '')}
                  </Text>
                </Stack>
              </Group>
            );
          })}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}
