import Editor from '@monaco-editor/react';
import { Box, Group, Text } from '@mantine/core';
import { useTheme } from '../../contexts/ThemeContext';

interface CodeFieldProps {
  value: string;
  onChange: (value: string) => void;
  language: string;
  /**
   * Monaco 的 model 是按 path 全局唯一的。工坊里同时开着模板、参考实现、
   * 隐藏用例好几个编辑器，path 撞了就会出现「改 A 变成改 B」。
   */
  path: string;
  label?: string;
  hint?: string;
  height?: number;
  readOnly?: boolean;
}

export function CodeField({
  value,
  onChange,
  language,
  path,
  label,
  hint,
  height = 220,
  readOnly,
}: CodeFieldProps) {
  const { colorScheme } = useTheme();

  return (
    <Box>
      {(label || hint) && (
        <Group justify="space-between" mb={4} gap="xs">
          {label && (
            <Text size="sm" fw={500}>
              {label}
            </Text>
          )}
          {hint && (
            <Text size="xs" c="dimmed">
              {hint}
            </Text>
          )}
        </Group>
      )}
      <Box
        style={{
          border: '1px solid var(--mantine-color-default-border)',
          borderRadius: 'var(--mantine-radius-md)',
          overflow: 'hidden',
        }}
      >
        <Editor
          height={height}
          path={path}
          language={language}
          value={value}
          onChange={(next) => onChange(next ?? '')}
          theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
          options={{
            readOnly,
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 1.6,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'on',
            padding: { top: 8, bottom: 8 },
            renderLineHighlight: 'none',
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          }}
        />
      </Box>
    </Box>
  );
}

export default CodeField;
