/**
 * 机器磁盘上的文件浏览器
 *
 * 和代码形态的工作区文件树不同：这里的树不是题目给的一份清单，
 * 而是**机器磁盘的实时投影** —— 学员在终端里 `cp`、`kubectl get -o yaml >` 出来的
 * 文件，会立刻出现在这里。这是「同一棵树」这件事在界面上的兑现。
 */
import { useMemo } from 'react';
import { NavLink, ScrollArea, Text } from '@mantine/core';
import { IconFile, IconFileText } from '@tabler/icons-react';

export interface MachineFilesProps {
  /** 路径 -> 内容 */
  files: Record<string, string>;
  activePath: string;
  onSelect: (path: string) => void;
  /** 只显示这个目录下的（终端里 /usr /bin 那些不该出现在 IDE 里） */
  root?: string;
}

export default function MachineFiles({ files, activePath, onSelect, root = '/root' }: MachineFilesProps) {
  /**
   * kubectl 会往 `~/.kube/cache` 里写一堆 discovery 与 HTTP 缓存 —— 真实，
   * 但塞进文件树只会把学员自己的文件淹掉。和真 IDE 一样，把它藏起来。
   */
  const paths = useMemo(
    () => Object.keys(files)
      .filter((path) => path.startsWith(`${root}/`) && !path.includes('/.kube/cache/'))
      .sort(),
    [files, root]
  );

  if (paths.length === 0) {
    return <Text size="xs" c="dimmed" p="sm">{root} 下还没有文件</Text>;
  }

  return (
    <ScrollArea style={{ flex: 1 }} type="auto">
      {paths.map((path) => (
        <NavLink
          key={path}
          active={path === activePath}
          label={path.slice(root.length + 1)}
          leftSection={/\.(ya?ml|json|md|sh|txt)$/.test(path) ? <IconFileText size={13} /> : <IconFile size={13} />}
          onClick={() => onSelect(path)}
          styles={{ label: { fontSize: 12, fontFamily: 'var(--mantine-font-family-monospace)' } }}
          py={4}
        />
      ))}
    </ScrollArea>
  );
}
