import { useEffect, useState } from 'react';
import { ActionIcon, Button, Group, Paper, Stack, Switch, Text, TextInput } from '@mantine/core';
import { IconFilePlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/I18nContext';
import { CodeField } from './CodeField';

export interface EditableFile {
  path: string;
  content: string;
  readonly?: boolean;
  openByDefault?: boolean;
}

interface FileListEditorProps {
  files: EditableFile[];
  onChange: (files: EditableFile[]) => void;
  label: string;
  hint?: string;
  /** Monaco model path 的前缀，必须在整个页面里唯一 */
  namespace: string;
  language: 'typescript' | 'javascript';
  /** 隐藏用例没有「只读」「默认打开」这些属性 */
  showFlags?: boolean;
  newFilePath?: string;
}

/**
 * 一组文件的编辑器：左边是文件名列表，右边是选中文件的内容。
 *
 * 之所以不把所有文件平铺成一串编辑器：一关的起始文件、隐藏用例、参考实现加
 * 起来可能有十几个，平铺之后页面长到没法用，而且十几个 Monaco 实例同时活着
 * 会明显拖慢输入。
 */
export function FileListEditor({
  files,
  onChange,
  label,
  hint,
  namespace,
  language,
  showFlags,
  newFilePath = 'src/new-file',
}: FileListEditorProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(0);

  // 删掉最后一个文件后 selected 会指向不存在的下标
  useEffect(() => {
    if (selected >= files.length) setSelected(Math.max(0, files.length - 1));
  }, [files.length, selected]);

  const active = files[selected];
  const extension = language === 'typescript' ? 'ts' : 'js';

  const update = (index: number, patch: Partial<EditableFile>) =>
    onChange(files.map((file, position) => (position === index ? { ...file, ...patch } : file)));

  const addFile = () => {
    // 名字撞了 Monaco 会共用同一个 model，两个文件的内容会互相覆盖
    const taken = new Set(files.map((file) => file.path));
    let path = `${newFilePath}.${extension}`;
    let counter = 2;
    while (taken.has(path)) {
      path = `${newFilePath}-${counter}.${extension}`;
      counter += 1;
    }
    onChange([...files, { path, content: '' }]);
    setSelected(files.length);
  };

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Stack gap={0}>
          <Text size="sm" fw={500}>
            {label}
          </Text>
          {hint && (
            <Text size="xs" c="dimmed">
              {hint}
            </Text>
          )}
        </Stack>
        <Button size="compact-xs" variant="light" leftSection={<IconFilePlus size={13} />} onClick={addFile}>
          {t('workshop.addFile')}
        </Button>
      </Group>

      {files.length === 0 ? (
        <Paper p="md" withBorder>
          <Text size="xs" c="dimmed">
            {t('workshop.noFiles')}
          </Text>
        </Paper>
      ) : (
        <Stack gap="xs">
          <Group gap={6} wrap="wrap">
            {files.map((file, index) => (
              <Button
                key={`${file.path}-${index}`}
                size="compact-xs"
                variant={index === selected ? 'filled' : 'default'}
                onClick={() => setSelected(index)}
              >
                {file.path}
              </Button>
            ))}
          </Group>

          {active && (
            <Stack gap="xs">
              <Group gap="xs" wrap="nowrap">
                <TextInput
                  flex={1}
                  size="xs"
                  value={active.path}
                  onChange={(event) => update(selected, { path: event.currentTarget.value })}
                />
                {showFlags && (
                  <>
                    <Switch
                      size="xs"
                      label={t('workshop.fileReadonly')}
                      checked={Boolean(active.readonly)}
                      onChange={(event) => update(selected, { readonly: event.currentTarget.checked })}
                    />
                    <Switch
                      size="xs"
                      label={t('workshop.fileOpenByDefault')}
                      checked={Boolean(active.openByDefault)}
                      onChange={(event) => update(selected, { openByDefault: event.currentTarget.checked })}
                    />
                  </>
                )}
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size="sm"
                  onClick={() => onChange(files.filter((_, position) => position !== selected))}
                  aria-label={t('workshop.removeFile')}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>

              <CodeField
                path={`workshop:///${namespace}/${active.path}`}
                language={language}
                value={active.content}
                onChange={(content) => update(selected, { content })}
                height={280}
              />
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
}

export default FileListEditor;
