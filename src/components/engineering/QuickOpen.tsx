import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Group, Kbd, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconFileCode, IconLock, IconSearch } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/I18nContext';
import { fileAccent, fuzzyMatch } from '../../lib/editorPrefs';
import type { WorkspaceFile } from '../../lib/engineering/types';

interface QuickOpenProps {
  opened: boolean;
  files: WorkspaceFile[];
  dirtyPaths: Set<string>;
  onClose: () => void;
  onSelect: (path: string) => void;
}

/** Cmd/Ctrl+P 的文件快速跳转，工程一大就离不开它 */
export default function QuickOpen({ opened, files, dirtyPaths, onClose, onSelect }: QuickOpenProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(
    () => files.filter((file) => fuzzyMatch(query, file.path)).slice(0, 30),
    [files, query]
  );

  useEffect(() => {
    if (!opened) return;
    setQuery('');
    setCursor(0);
    // Modal 有入场动画，直接 focus 会被抢走
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [opened]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const choose = (path: string) => {
    onSelect(path);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((value) => Math.min(matches.length - 1, value + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((value) => Math.max(0, value - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const file = matches[cursor];
      if (file) choose(file.path);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      withCloseButton={false}
      size="lg"
      yOffset="12vh"
      padding={0}
      styles={{ body: { padding: 0 } }}
    >
      <TextInput
        ref={inputRef}
        placeholder={t('engineering.workspace.quickOpenPlaceholder')}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        leftSection={<IconSearch size={16} />}
        variant="unstyled"
        size="md"
        px="md"
        styles={{ input: { borderBottom: '1px solid var(--app-border)', borderRadius: 0 } }}
      />

      <Stack gap={0} p={6} mah="46vh" style={{ overflowY: 'auto' }}>
        {matches.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            {t('engineering.workspace.quickOpenEmpty')}
          </Text>
        ) : (
          matches.map((file, index) => {
            const segments = file.path.split('/');
            const name = segments.pop();
            return (
              <Group
                key={file.path}
                gap={8}
                wrap="nowrap"
                px="sm"
                py={7}
                onMouseEnter={() => setCursor(index)}
                onClick={() => choose(file.path)}
                style={{
                  cursor: 'pointer',
                  borderRadius: 6,
                  background: index === cursor ? 'var(--mantine-color-brand-light)' : undefined,
                }}
              >
                <IconFileCode size={15} color={fileAccent(file.path)} style={{ flexShrink: 0 }} />
                <Text size="sm" fw={500}>
                  {name}
                </Text>
                <Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
                  {segments.join('/')}
                </Text>
                {dirtyPaths.has(file.path) && (
                  <Badge size="xs" variant="light" color="brand">
                    {t('engineering.workspace.edited')}
                  </Badge>
                )}
                {file.readonly && <IconLock size={12} opacity={0.6} />}
              </Group>
            );
          })
        )}
      </Stack>

      <Group gap="md" px="md" py={8} style={{ borderTop: '1px solid var(--app-border)' }}>
        <Group gap={4}>
          <Kbd size="xs">↑</Kbd>
          <Kbd size="xs">↓</Kbd>
          <Text size="xs" c="dimmed">
            {t('engineering.workspace.navigate')}
          </Text>
        </Group>
        <Group gap={4}>
          <Kbd size="xs">Enter</Kbd>
          <Text size="xs" c="dimmed">
            {t('engineering.workspace.open')}
          </Text>
        </Group>
        <Group gap={4}>
          <Kbd size="xs">Esc</Kbd>
          <Text size="xs" c="dimmed">
            {t('engineering.workspace.dismiss')}
          </Text>
        </Group>
      </Group>
    </Modal>
  );
}
