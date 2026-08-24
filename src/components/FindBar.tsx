import React from 'react';
import { ActionIcon, Group, Paper, Text, TextInput } from '@mantine/core';
import { IconChevronDown, IconChevronUp, IconX } from '@tabler/icons-react';
import { useI18n } from '../contexts/I18nContext';

/**
 * 页内查找栏（仅桌面端）
 *
 * 浏览器里 ⌘F 是白送的，Electron 里没有。菜单里的「查找」把 find:open 发过来，
 * 这里收关键词交给主进程的 findInPage，命中数再从 find:result 回来。
 *
 * 浏览器环境下 window.electronAPI 不存在，组件直接不渲染——Chrome 自己的
 * 查找栏比这个好用，不要抢它。
 */
export default function FindBar() {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [result, setResult] = React.useState({ activeMatchOrdinal: 0, matches: 0 });
  const inputRef = React.useRef<HTMLInputElement>(null);
  // 事件回调里要读到最新的关键词，用 ref 免得每次都重订阅
  const queryRef = React.useRef('');
  queryRef.current = query;

  const api = () => (typeof window !== 'undefined' ? (window as any).electronAPI : undefined);

  const search = React.useCallback((text: string, forward = true, findNext = false) => {
    const bridge = api();
    if (!bridge) return;
    if (!text) {
      bridge.stopFindInPage();
      setResult({ activeMatchOrdinal: 0, matches: 0 });
      return;
    }
    bridge.findInPage(text, { forward, findNext });
  }, []);

  const close = React.useCallback(() => {
    setOpen(false);
    setResult({ activeMatchOrdinal: 0, matches: 0 });
    api()?.stopFindInPage();
  }, []);

  React.useEffect(() => {
    const bridge = api();
    if (!bridge?.onFindOpen) return;

    const offOpen = bridge.onFindOpen(() => {
      setOpen(true);
      // 已经开着的时候再按 ⌘F，是「重新选中输入框」而不是关掉
      requestAnimationFrame(() => inputRef.current?.select());
    });
    const offAgain = bridge.onFindAgain((forward: boolean) => {
      if (queryRef.current) search(queryRef.current, forward, true);
    });
    const offResult = bridge.onFindResult((r: any) => setResult(r));

    return () => {
      offOpen?.();
      offAgain?.();
      offResult?.();
    };
  }, [search]);

  if (!open) return null;

  const matches = result.matches || 0;

  return (
    <Paper
      withBorder
      shadow="md"
      radius="md"
      p={6}
      style={{ position: 'fixed', top: 12, right: 16, zIndex: 4000, minWidth: 300 }}
    >
      <Group gap={4} wrap="nowrap">
        <TextInput
          ref={inputRef}
          size="xs"
          autoFocus
          placeholder={t('find.placeholder')}
          value={query}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setQuery(next);
            search(next);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              // Shift+Enter 往回找，和浏览器一致
              search(query, !event.shiftKey, true);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
          style={{ flex: 1 }}
        />
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap', minWidth: 44, textAlign: 'center' }}>
          {matches ? `${result.activeMatchOrdinal}/${matches}` : t('find.none')}
        </Text>
        <ActionIcon
          size="sm"
          variant="subtle"
          aria-label={t('find.previous')}
          disabled={!matches}
          onClick={() => search(query, false, true)}
        >
          <IconChevronUp size={14} />
        </ActionIcon>
        <ActionIcon
          size="sm"
          variant="subtle"
          aria-label={t('find.next')}
          disabled={!matches}
          onClick={() => search(query, true, true)}
        >
          <IconChevronDown size={14} />
        </ActionIcon>
        <ActionIcon size="sm" variant="subtle" aria-label={t('find.close')} onClick={close}>
          <IconX size={14} />
        </ActionIcon>
      </Group>
    </Paper>
  );
}
