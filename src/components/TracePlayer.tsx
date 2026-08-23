import React, { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Code,
  Group,
  ScrollArea,
  Slider,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import {
  IconChevronLeft,
  IconChevronRight,
  IconPlayerSkipBack,
  IconPlayerSkipForward,
} from '@tabler/icons-react';
import { useTranslation } from '../contexts/I18nContext';
import type { ExecutionTrace } from '../lib/trace/types';

interface TracePlayerProps {
  trace: ExecutionTrace;
  /** 用户源码，按行展示并高亮当前行 */
  source: string;
}

/**
 * 执行轨迹回放。
 *
 * 不是断点调试器：代码已经跑完了，这里回放的是录下来的每一步。
 * 好处是可以往回拖 —— 断点调试器做不到这件事，而做题时
 * 「上一轮循环 seen 里是什么」恰恰是最常问的问题。
 */
export default function TracePlayer({ trace, source }: TracePlayerProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);

  const steps = trace.steps;
  const total = steps.length;

  // 换了一条轨迹就回到开头，否则会停在上一条轨迹的下标上
  useEffect(() => {
    setIndex(0);
  }, [trace]);

  const lines = useMemo(() => source.split('\n'), [source]);
  const current = steps[Math.min(index, total - 1)];

  if (total === 0) {
    return (
      <Alert color="gray" variant="light">
        {trace.error || t('trace.empty')}
      </Alert>
    );
  }

  const clamp = (value: number) => Math.max(0, Math.min(total - 1, value));
  // 用函数式更新，别读闭包里的 index：连点几下时每次点击拿到的都是同一个
  // 旧值，五次点击只前进一步。
  const stepBy = (delta: number) => setIndex((current) => clamp(current + delta));

  return (
    <Stack gap="sm">
      <Group gap="xs" wrap="nowrap">
        <ActionIcon variant="default" onClick={() => setIndex(0)} disabled={index === 0}
          aria-label={t('trace.first')}>
          <IconPlayerSkipBack size={15} />
        </ActionIcon>
        <ActionIcon variant="default" onClick={() => stepBy(-1)} disabled={index === 0}
          aria-label={t('trace.prev')}>
          <IconChevronLeft size={15} />
        </ActionIcon>
        <Slider
          style={{ flex: 1 }}
          min={0}
          max={total - 1}
          value={Math.min(index, total - 1)}
          onChange={setIndex}
          label={(value) => `${value + 1} / ${total}`}
        />
        <ActionIcon variant="default" onClick={() => stepBy(1)} disabled={index >= total - 1}
          aria-label={t('trace.next')}>
          <IconChevronRight size={15} />
        </ActionIcon>
        <ActionIcon variant="default" onClick={() => setIndex(total - 1)} disabled={index >= total - 1}
          aria-label={t('trace.last')}>
          <IconPlayerSkipForward size={15} />
        </ActionIcon>
      </Group>

      <Group gap={8}>
        <Badge size="sm" variant="light">
          {t('trace.step')} {Math.min(index, total - 1) + 1} / {total}
        </Badge>
        <Badge size="sm" variant="light" color="gray">
          {t('trace.line')} {current.line}
        </Badge>
        <Text size="xs" c="dimmed" ff="monospace">
          {current.stack.join(' › ')}
        </Text>
      </Group>

      {trace.truncated && (
        <Text size="xs" c="dimmed" fs="italic">
          {t('trace.truncated').replace('{count}', String(trace.droppedSteps))}
        </Text>
      )}

      {/* 源码：当前行高亮 */}
      <ScrollArea.Autosize mah={220}>
        <Box component="pre" style={{ margin: 0, fontSize: 11, lineHeight: 1.6 }}>
          {lines.map((text, i) => {
            const lineNumber = i + 1;
            const active = lineNumber === current.line;
            return (
              <Box
                key={lineNumber}
                style={{
                  display: 'flex',
                  gap: 10,
                  padding: '0 6px',
                  borderRadius: 3,
                  background: active ? 'var(--mantine-color-blue-light)' : undefined,
                  fontWeight: active ? 600 : 400,
                }}
              >
                <Text span size="xs" c="dimmed" ff="monospace" style={{ minWidth: 22, textAlign: 'right' }}>
                  {lineNumber}
                </Text>
                <Text span size="xs" ff="monospace" style={{ whiteSpace: 'pre' }}>
                  {text || ' '}
                </Text>
              </Box>
            );
          })}
        </Box>
      </ScrollArea.Autosize>

      {/* 当前这一步的变量 */}
      <Box>
        <Text size="xs" c="dimmed" mb={4}>
          {t('trace.variables')}
        </Text>
        {current.vars.length === 0 ? (
          <Text size="xs" c="dimmed" fs="italic">
            {t('trace.noVariables')}
          </Text>
        ) : (
          <ScrollArea.Autosize mah={180}>
            <Table withTableBorder verticalSpacing={2} horizontalSpacing={8} style={{ fontSize: 11 }}>
              <Table.Tbody>
                {current.vars.map((variable) => (
                  <Table.Tr key={variable.name}>
                    <Table.Td style={{ width: 100, verticalAlign: 'top' }}>
                      <Code style={{ fontSize: 11 }}>{variable.name}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {variable.value}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        )}
      </Box>
    </Stack>
  );
}
