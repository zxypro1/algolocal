import React from 'react';
import { ActionIcon, Badge, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useTranslation } from '../contexts/I18nContext';
import type { Breakpoint } from '../lib/trace/types';

interface BreakpointListProps {
  breakpoints: Breakpoint[];
  onUpdate: (line: number, patch: Partial<Breakpoint>) => void;
  onRemove: (line: number) => void;
}

/**
 * 断点列表：设在哪一行、条件是什么、要不要只打日志。
 *
 * 条件和日志放在这里编辑而不是编辑器里弹浮层，是因为它们需要被看见 ——
 * 一个条件写错了的断点如果只是「没停」，用户会以为功能坏了。
 */
export default function BreakpointList({ breakpoints, onUpdate, onRemove }: BreakpointListProps) {
  const { t } = useTranslation();

  if (breakpoints.length === 0) {
    return (
      <Text size="xs" c="dimmed" fs="italic">
        {t('trace.noBreakpoints')}
      </Text>
    );
  }

  return (
    <Stack gap={8}>
      {breakpoints
        .slice()
        .sort((a, b) => a.line - b.line)
        .map((breakpoint) => (
          <Group key={breakpoint.line} gap={8} align="flex-end" wrap="nowrap">
            <Badge size="sm" variant="light" color={breakpoint.logMessage ? 'blue' : 'red'}>
              {t('trace.line')} {breakpoint.line}
            </Badge>
            <TextInput
              size="xs"
              style={{ flex: 1 }}
              label={t('trace.condition')}
              placeholder={t('trace.conditionPlaceholder')}
              value={breakpoint.condition || ''}
              onChange={(event) => onUpdate(breakpoint.line, { condition: event.target.value })}
            />
            <TextInput
              size="xs"
              style={{ flex: 1 }}
              label={t('trace.logMessage')}
              placeholder={t('trace.logPlaceholder')}
              value={breakpoint.logMessage || ''}
              onChange={(event) => onUpdate(breakpoint.line, { logMessage: event.target.value })}
            />
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() => onRemove(breakpoint.line)}
              aria-label={t('trace.removeBreakpoint')}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        ))}
    </Stack>
  );
}
