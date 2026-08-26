/**
 * 访存面板：warp 热图 + 共享内存 bank 视图
 *
 * **这是这个工作台区别于「在真卡上跑一跑」的地方** —— 真卡上你看不见这些。
 * `ncu` 给的是聚合之后的数（扇区总数、冲突路数），而
 * 「为什么改一下下标 DRAM 字节就掉了 8 倍」要看的是分布：
 * 合并的时候 32 个 lane 挤进 4 个格子，不合并的时候散成 32 个点。
 *
 * 轨迹是**按需采样**的：点一下按钮单独跑一遍，不影响学员刚跑出来的指标。
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Alert, Badge, Button, Group, ScrollArea, Select, Stack, Table, Text, Tooltip,
} from '@mantine/core';
import { AccessTrace, banksOf, sectorsOf } from '../../lib/gpulab';
import { runBench, type GpuWorld } from '../../lib/gpulab/lab';
import type { AccessRecord } from '../../lib/gpulab';

export interface MemoryPanelProps {
  world: GpuWorld | null;
  revision: number;
}

const WARP = 32;

/** 一个 lane 格子的颜色：按它落在第几组循环取色，好把「相邻 lane 是否连续」看出来 */
function laneColor(groupIndex: number, total: number): string {
  if (total <= 1) return 'var(--mantine-color-teal-6)';
  const hue = Math.round((groupIndex / total) * 300);
  return `hsl(${hue}, 62%, 48%)`;
}

/**
 * warp 访存热图。
 *
 * 上面一行 32 个格子是 lane，下面按 32B 扇区分组 ——
 * 一个扇区一个色块，色块里写着这一格聚了几个 lane。
 * **合并 = 少数几个宽色块；不合并 = 32 个窄条。**
 */
function SectorMap({ record }: { record: AccessRecord }) {
  const view = useMemo(() => sectorsOf(record), [record]);
  const laneToGroup = useMemo(() => {
    const map = new Int32Array(WARP).fill(-1);
    view.forEach((item, index) => item.lanes.forEach((lane) => { map[lane] = index; }));
    return map;
  }, [view]);

  return (
    <Stack gap={6}>
      <Group gap={2} wrap="nowrap">
        {Array.from({ length: WARP }, (_, lane) => {
          const group = laneToGroup[lane];
          const address = record.addresses[lane];
          return (
            <Tooltip
              key={lane}
              label={address < 0
                ? `lane ${lane}：不活跃`
                : `lane ${lane} → 地址 ${address}，扇区 ${address >> 5}`}
              position="top"
            >
              <div
                style={{
                  width: 16, height: 22, borderRadius: 2,
                  background: group < 0 ? 'var(--app-border)' : laneColor(group, view.length),
                  opacity: group < 0 ? 0.35 : 1,
                  flexShrink: 0,
                }}
              />
            </Tooltip>
          );
        })}
      </Group>
      <Text size="10px" c="dimmed">
        上面 32 格是 warp 的 32 个 lane，同色 = 落在同一个 32B 扇区
      </Text>

      <Group gap={3} wrap="wrap">
        {view.map((item, index) => (
          <Tooltip
            key={item.sector}
            label={`扇区 ${item.sector}（字节 ${item.sector * 32}~${item.sector * 32 + 31}）：lane ${item.lanes.join(', ')}`}
          >
            <div
              style={{
                background: laneColor(index, view.length),
                color: 'white', fontSize: 10, borderRadius: 3,
                padding: '2px 6px', flexShrink: 0,
              }}
            >
              #{item.sector} · {item.lanes.length}
            </div>
          </Tooltip>
        ))}
      </Group>
      <Text size="10px" c="dimmed">
        下面每一块是一个 32B 扇区，写着聚了几个 lane。
        <Text span fw={700} size="10px">搬回来的是整个扇区</Text> ——
        {view.length} 个扇区 = {view.length * 32} 字节，真正用上的只有{' '}
        {record.addresses.reduce((sum, a) => sum + (a >= 0 ? 1 : 0), 0) * 4} 字节。
      </Text>
    </Stack>
  );
}

/**
 * 共享内存 bank 视图。
 *
 * 32 个 bank 一行，冲突的那些标红。鼠标停上去说清是哪两个 lane 撞在了
 * 同一个 bank 的不同地址上 —— 加一列 padding 之后整行变绿，
 * 这个变化在这张图上是一眼的事。
 */
function BankMap({ record }: { record: AccessRecord }) {
  const view = useMemo(() => banksOf(record), [record]);
  const worst = Math.max(1, ...view.map((bank) => bank.ways));

  return (
    <Stack gap={6}>
      <Group gap={2} wrap="nowrap">
        {view.map((bank) => {
          const conflicted = bank.ways > 1;
          const idle = bank.ways === 0;
          return (
            <Tooltip
              key={bank.bank}
              multiline
              w={280}
              label={idle
                ? `bank ${bank.bank}：这一条没人访问`
                : conflicted
                  ? `bank ${bank.bank}：${bank.ways} 个不同地址，要发 ${bank.ways} 次。`
                    + bank.groups.map((g) => `\n  地址 ${g.address} ← lane ${g.lanes.join(', ')}`).join('')
                  : `bank ${bank.bank}：1 个地址（lane ${bank.groups[0].lanes.join(', ')}）`
                    + (bank.groups[0].lanes.length > 1 ? ' —— 同地址是广播，不算冲突' : '')}
              position="top"
            >
              <div
                style={{
                  width: 16, height: 22, borderRadius: 2, flexShrink: 0,
                  background: idle
                    ? 'var(--app-border)'
                    : conflicted
                      ? `hsl(0, 70%, ${62 - (bank.ways / worst) * 22}%)`
                      : 'var(--mantine-color-teal-6)',
                  opacity: idle ? 0.35 : 1,
                }}
              />
            </Tooltip>
          );
        })}
      </Group>
      <Group gap="xs">
        <Text size="10px" c="dimmed">32 个 bank</Text>
        <Badge size="xs" variant="light" color="teal">无冲突</Badge>
        <Badge size="xs" variant="light" color="red">
          冲突（最坏 {worst} 路）
        </Badge>
      </Group>
      <Text size="10px" c="dimmed">
        同一个 bank 里<Text span fw={700} size="10px">同地址是广播</Text>，一次就够；
        不同地址才要串行发多次。
      </Text>
    </Stack>
  );
}

export default function MemoryPanel({ world, revision }: MemoryPanelProps) {
  const [trace, setTrace] = useState<AccessTrace | null>(null);
  const [sampling, setSampling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  /** 世界变了（又跑了一次 kernel），上一次的采样就作废 */
  const staleKey = useMemo(() => revision, [revision]);
  const [tracedAt, setTracedAt] = useState(-1);
  const stale = trace !== null && tracedAt !== staleKey;

  const sample = useCallback(async () => {
    if (!world) return;
    setSampling(true);
    setError(null);
    try {
      const collector = new AccessTrace({ limit: 512 });
      const outcome = await runBench(world, '/root/bench', { trace: collector });
      if (outcome.code !== 0) {
        setError(outcome.stderr.trim() || '跑挂了');
        setTrace(null);
        return;
      }
      setTrace(collector);
      setTracedAt(staleKey);
      setSelected(collector.records.length ? '0' : null);
    } catch (sampleError) {
      setError(sampleError instanceof Error ? sampleError.message : String(sampleError));
      setTrace(null);
    } finally {
      setSampling(false);
    }
  }, [world, staleKey]);

  if (!world) return <Text size="xs" c="dimmed" p="sm">设备还没准备好</Text>;

  const records = trace?.records ?? [];
  const record = selected !== null ? records[Number(selected)] : undefined;

  return (
    <ScrollArea h="100%" type="auto">
      <Stack gap="sm" p="sm">
        <Group gap="xs" align="flex-start">
          <Button size="compact-xs" onClick={sample} loading={sampling}>
            {trace ? '重新采样' : '采样一次'}
          </Button>
          {trace && (
            <Badge size="sm" variant="light" color={stale ? 'yellow' : 'gray'}>
              {records.length} 条访存
              {trace.truncated > 0 ? `（还有 ${trace.truncated} 条没记）` : ''}
            </Badge>
          )}
        </Group>

        <Text size="10px" c="dimmed">
          采样会<Text span fw={700} size="10px">单独跑一遍</Text>
          <Text span ff="monospace" size="10px"> ./bench</Text>，不影响你刚跑出来的指标。
          真卡上看不到这张图：ncu 给的是聚合数，看不见 32 个 lane 各自打到了哪。
        </Text>

        {stale && (
          <Alert color="yellow" variant="light" p="xs">
            <Text size="10px">代码或设备状态变过了，这份采样是旧的。重新采一次。</Text>
          </Alert>
        )}

        {error && (
          <Alert color="red" p="xs">
            <Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>{error}</Text>
          </Alert>
        )}

        {!trace && !error && (
          <Text size="xs" c="dimmed">
            先在终端里编译一次（<Text span ff="monospace" size="xs">nvcc -o bench 源文件</Text>），
            然后点「采样一次」。
          </Text>
        )}

        {records.length > 0 && (
          <>
            <Select
              size="xs"
              label="选一条访存指令"
              value={selected}
              onChange={setSelected}
              maxDropdownHeight={280}
              data={records.map((item, index) => ({
                value: String(index),
                label: `#${index} 第 ${item.line} 行 · ${item.space} ${item.kind}`
                  + (item.space === 'global' ? ` · ${item.sectors} 扇区` : '')
                  + (item.space === 'shared' ? ` · ${item.bankConflicts} 路冲突` : '')
                  + ` · block ${item.blockIndex} warp ${item.warpIndex}`,
              }))}
            />

            {record && (
              <Stack gap="sm">
                <Table withTableBorder fz="xs" verticalSpacing={2} horizontalSpacing={8}>
                  <Table.Tbody>
                    <Table.Tr>
                      <Table.Td>源码行号</Table.Td>
                      <Table.Td align="right">第 {record.line} 行</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>空间 / 方向</Table.Td>
                      <Table.Td align="right">{record.space} {record.kind}</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>活跃 lane</Table.Td>
                      <Table.Td align="right">
                        {record.addresses.reduce((sum, a) => sum + (a >= 0 ? 1 : 0), 0)} / 32
                      </Table.Td>
                    </Table.Tr>
                    {record.space === 'global' && (
                      <Table.Tr>
                        <Table.Td>打到的 32B 扇区</Table.Td>
                        <Table.Td align="right">
                          {record.sectors}（合并是 4，完全不合并是 32）
                        </Table.Td>
                      </Table.Tr>
                    )}
                    {record.space === 'shared' && (
                      <Table.Tr>
                        <Table.Td>bank 冲突</Table.Td>
                        <Table.Td align="right">{record.bankConflicts} 路</Table.Td>
                      </Table.Tr>
                    )}
                  </Table.Tbody>
                </Table>

                {record.space === 'global' && <SectorMap record={record} />}
                {record.space === 'shared' && <BankMap record={record} />}
                {record.space === 'local' && (
                  <Alert color="orange" variant="light" p="xs">
                    <Text size="10px">
                      这是 <Text span fw={700} size="10px">local memory</Text> 的访问 ——
                      有数组没能待在寄存器里。
                      它在物理上就是显存，慢得和全局访存一样。
                    </Text>
                  </Alert>
                )}
              </Stack>
            )}
          </>
        )}

        {trace && records.length === 0 && (
          <Text size="xs" c="dimmed">这一遍一条访存都没有。</Text>
        )}
      </Stack>
    </ScrollArea>
  );
}
