import React, { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
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
import { continueRun, firstHit, stepInto, stepOut, stepOver } from '../lib/trace/navigate';
import type { Breakpoint, ExecutionTrace, TraceStep } from '../lib/trace/types';

interface TracePlayerProps {
  trace: ExecutionTrace;
  /** 用户源码，按行展示并高亮当前行 */
  source: string;
  /** 设过的断点，用于在源码预览里标记 */
  breakpoints?: Breakpoint[];
  /** 关于这条轨迹是怎么录的说明（不是降级警告） */
  note?: string | null;
  /** 断点在录制之后被改过，当前显示的命中结果已经不对应了 */
  staleBreakpoints?: boolean;
}

/**
 * 执行轨迹回放。
 *
 * 不是断点调试器：代码已经跑完了，这里回放的是录下来的每一步。
 * 好处是可以往回拖 —— 断点调试器做不到这件事，而做题时
 * 「上一轮循环 seen 里是什么」恰恰是最常问的问题。
 */
export default function TracePlayer({ trace, source, breakpoints = [], note = null, staleBreakpoints = false }: TracePlayerProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);

  const steps = trace.steps;
  const total = steps.length;

  // 换了一条轨迹就跳到第一个命中的断点；没有断点就从头开始。
  // 这和真调试器「跑起来直接停在断点上」的体感一致。
  useEffect(() => {
    setIndex(firstHit(trace.steps));
  }, [trace]);

  const lines = useMemo(() => source.split('\n'), [source]);
  const sourceViewportRef = React.useRef<HTMLDivElement>(null);
  const activeLineRef = React.useRef<HTMLDivElement>(null);

  // 当前行滚进视野。用 block:'nearest' 免得每一步都把整个面板弹一下。
  useEffect(() => {
    activeLineRef.current?.scrollIntoView({ block: 'nearest' });
  }, [index]);
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

  const go = (
    fn: (all: TraceStep[], from: number, direction: 1 | -1) => number,
    direction: 1 | -1
  ) => setIndex((current) => fn(steps, current, direction));

  const hitCount = steps.filter((step) => step.hit).length;

  return (
    <Stack gap="sm">
      {note && (
        <Text size="xs" c="dimmed">
          {note}
        </Text>
      )}

      {/* 断点改了但还没重录：命中结果对应的是上一次运行 */}
      {staleBreakpoints && (
        <Alert color="yellow" variant="light" p="xs">
          <Text size="xs">{t('trace.staleBreakpoints')}</Text>
        </Alert>
      )}

      {/* 调试器动作。断点没有真的停住代码 —— 代码已经跑完，这里是在录像上跳。
          所以每个动作都有反向版本，按住 Shift 就是往回走。 */}
      <Group gap={6} wrap="wrap">
        <Button size="compact-xs" variant="light" onClick={(e) => go(continueRun, e.shiftKey ? -1 : 1)}>
          {t('trace.continue')}
        </Button>
        <Button size="compact-xs" variant="default" onClick={(e) => go(stepOver, e.shiftKey ? -1 : 1)}>
          {t('trace.stepOver')}
        </Button>
        <Button size="compact-xs" variant="default" onClick={(e) => go(stepInto, e.shiftKey ? -1 : 1)}>
          {t('trace.stepInto')}
        </Button>
        <Button size="compact-xs" variant="default" onClick={(e) => go(stepOut, e.shiftKey ? -1 : 1)}>
          {t('trace.stepOut')}
        </Button>
        <Text size="xs" c="dimmed">
          {t('trace.reverseHint')}
        </Text>
      </Group>

      {breakpoints.length > 0 && (
        <Text size="xs" c="dimmed">
          {t('trace.hitSummary', { hits: hitCount, breakpoints: breakpoints.length })}
        </Text>
      )}

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

      {/* 代码中途抛了异常：轨迹是残缺的，得说清楚，否则最后一步看起来像正常结束 */}
      {trace.error && (
        <Alert color="red" variant="light">
          {t('trace.aborted', { error: trace.error })}
        </Alert>
      )}

      {trace.truncated && (
        <Text size="xs" c="dimmed" fs="italic">
          {t('trace.truncated', { count: trace.droppedSteps })}
        </Text>
      )}

      {/* 源码：当前行高亮。跳转可能跨几千步，不滚过去的话看着像没反应。 */}
      <ScrollArea.Autosize mah={220} viewportRef={sourceViewportRef}>
        <Box component="pre" style={{ margin: 0, fontSize: 11, lineHeight: 1.6 }}>
          {lines.map((text, i) => {
            const lineNumber = i + 1;
            const active = lineNumber === current.line;
            const hasBreakpoint = breakpoints.some((bp) => bp.line === lineNumber && bp.enabled);
            return (
              <Box
                key={lineNumber}
                ref={active ? activeLineRef : undefined}
                style={{
                  display: 'flex',
                  gap: 10,
                  padding: '0 6px',
                  borderRadius: 3,
                  background: active ? 'var(--mantine-color-blue-light)' : undefined,
                  fontWeight: active ? 600 : 400,
                }}
              >
                <Text span size="xs" c={hasBreakpoint ? 'red' : 'dimmed'} ff="monospace"
                  style={{ minWidth: 30, textAlign: 'right' }}>
                  {hasBreakpoint ? '● ' : ''}{lineNumber}
                </Text>
                <Text span size="xs" ff="monospace" style={{ whiteSpace: 'pre' }}>
                  {text || ' '}
                </Text>
              </Box>
            );
          })}
        </Box>
      </ScrollArea.Autosize>

      {current.log !== undefined && (
        <Alert color="blue" variant="light" p="xs">
          <Text size="xs" ff="monospace">{current.log}</Text>
        </Alert>
      )}

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
