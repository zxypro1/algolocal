import React from 'react';
import { Badge, Group, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconTerminal2 } from '@tabler/icons-react';
import { useTranslation } from '../contexts/I18nContext';

/**
 * 两条执行路径的日志结构略有差别：工程题带虚拟时钟时间戳 at，算法题没有。
 * 这里取并集，两边共用同一个展示组件。
 */
export interface DisplayConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  source?: 'user' | 'system';
  /** 虚拟时钟时间，仅工程题有 */
  at?: number;
}

interface ConsoleOutputProps {
  entries: DisplayConsoleEntry[];
  truncated?: boolean;
  /** 折叠标题右侧显示的条数徽标，默认按 entries 长度 */
  defaultOpen?: boolean;
  maxHeight?: number;
}

function levelColor(level: DisplayConsoleEntry['level']): string | undefined {
  if (level === 'error') return 'red';
  if (level === 'warn') return 'orange';
  if (level === 'debug') return 'dimmed';
  return undefined;
}

/** 单条日志。system 级（测试框架打的）用灰色前缀和用户输出区分开。 */
function ConsoleLine({ entry }: { entry: DisplayConsoleEntry }) {
  return (
    <Text
      size="xs"
      ff="monospace"
      c={levelColor(entry.level)}
      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
    >
      {entry.at !== undefined && (
        <Text span size="xs" c="dimmed">
          [{entry.at}ms]{' '}
        </Text>
      )}
      {entry.source === 'system' && (
        <Text span size="xs" c="dimmed">
          [runtime]{' '}
        </Text>
      )}
      {entry.level !== 'log' && entry.source === 'user' && (
        <Text span size="xs" c="dimmed">
          [{entry.level}]{' '}
        </Text>
      )}
      {entry.text}
    </Text>
  );
}

/**
 * 展示一次执行捕获到的 console 输出。
 * 算法题按用例展示，工程题在结果面板里聚合展示。
 */
export default function ConsoleOutput({
  entries,
  truncated = false,
  defaultOpen = false,
  maxHeight = 200,
}: ConsoleOutputProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(defaultOpen);

  if (!entries || entries.length === 0) return null;

  return (
    <div>
      <UnstyledButton onClick={() => setOpen((v) => !v)} style={{ width: '100%' }}>
        <Group gap={6} mb={open ? 6 : 0}>
          {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          <IconTerminal2 size={13} />
          <Text size="xs" c="dimmed" fw={500}>
            {t('codeRunner.consoleOutput')}
          </Text>
          <Badge size="xs" variant="light" color="gray">
            {entries.length}
          </Badge>
        </Group>
      </UnstyledButton>

      {open && (
        <ScrollArea.Autosize mah={maxHeight}>
          <Stack gap={1} pl={19}>
            {entries.map((entry, index) => (
              <ConsoleLine key={index} entry={entry} />
            ))}
            {truncated && (
              <Text size="xs" c="dimmed" fs="italic">
                {t('codeRunner.consoleTruncated')}
              </Text>
            )}
          </Stack>
        </ScrollArea.Autosize>
      )}
    </div>
  );
}
