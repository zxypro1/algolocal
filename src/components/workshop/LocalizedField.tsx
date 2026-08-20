import { Tabs, Textarea, TextInput } from '@mantine/core';
import { useState } from 'react';
import type { LocalizedText } from '../../lib/workshop/problem';

interface LocalizedFieldProps {
  value: LocalizedText;
  onChange: (value: LocalizedText) => void;
  label: string;
  description?: string;
  /** 多行用 textarea，标题这种一行的用 input */
  multiline?: boolean;
  rows?: number;
  placeholder?: { en?: string; zh?: string };
}

/**
 * 中英双语字段。
 *
 * 用标签页而不是并排两个框：题面动辄几十行，并排会把每一列压得没法读，
 * 而作者通常是先写完一种语言再翻另一种，很少需要同时看见两边。
 */
export function LocalizedField({
  value,
  onChange,
  label,
  description,
  multiline,
  rows = 10,
  placeholder,
}: LocalizedFieldProps) {
  const [tab, setTab] = useState<string>('zh');
  const active = tab === 'en' ? 'en' : 'zh';

  const update = (next: string) => onChange({ ...value, [active]: next });
  const Component = multiline ? Textarea : TextInput;

  return (
    <div>
      <Tabs value={active} onChange={(next) => setTab(next || 'zh')} mb={6}>
        <Tabs.List>
          <Tabs.Tab value="zh">
            {label} · 中文{!value.zh?.trim() ? ' ·' : ''}
          </Tabs.Tab>
          <Tabs.Tab value="en">
            {label} · EN{!value.en?.trim() ? ' ·' : ''}
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>

      <Component
        description={description}
        value={value[active] || ''}
        onChange={(event) => update(event.currentTarget.value)}
        placeholder={placeholder?.[active]}
        {...(multiline ? { autosize: true, minRows: rows, maxRows: rows * 2 } : {})}
      />
    </div>
  );
}

export default LocalizedField;
