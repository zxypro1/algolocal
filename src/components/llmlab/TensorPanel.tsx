/**
 * 张量面板：注意力热图、分布直方图、参数与显存分解
 *
 * 这块面板回答的是「它内部长什么样」。教程里看不到这些 —— 而恰恰是这些
 * 让抽象的错误变成看得见的东西：
 *
 * - **因果掩码写错**：热图的右上三角会亮起来
 * - **归纳头学成了**：对角线偏移那条亮带会自己长出来
 * - **pre-norm 去掉了**：深层激活的直方图往两边跑
 * - **梯度裁剪生效了**：梯度范数的分布被削平了顶
 */
import { useMemo, useState } from 'react';
import {
  Alert, Badge, Group, Paper, ScrollArea, Select, Stack, Table, Text,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { AttentionSnapshot, LlmMetricTree, TrainingLogView } from '../../lib/llmlab/bridge';

export interface TensorPanelProps {
  log: TrainingLogView;
  metrics?: LlmMetricTree;
  revision: number;
}

export default function TensorPanel({ log, metrics, revision }: TensorPanelProps) {
  const [attnIndex, setAttnIndex] = useState(0);
  const [histIndex, setHistIndex] = useState(0);

  const attn = log.attention[Math.min(attnIndex, log.attention.length - 1)];
  const hist = log.histograms[Math.min(histIndex, log.histograms.length - 1)];

  const memory = useMemo(() => {
    if (!metrics) return [];
    const m = metrics.memory;
    return [
      { name: '参数', bytes: m.paramBytes ?? 0 },
      { name: '梯度', bytes: m.gradBytes ?? 0 },
      { name: '优化器状态', bytes: m.optimizerStateBytes ?? 0 },
      { name: '激活峰值', bytes: m.peakActivationBytes ?? 0 },
      { name: '常驻数据', bytes: m.dataBytes ?? 0 },
    ].filter((row) => row.bytes > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics, revision]);

  const byModule = (metrics?.params?.byModule ?? {}) as Record<string, number>;
  const moduleRows = Object.entries(byModule).sort((a, b) => b[1] - a[1]);

  const nothing = log.attention.length === 0 && log.histograms.length === 0 && memory.length === 0;
  if (nothing) {
    return (
      <ScrollArea h="100%" type="auto" p="md" className="panel-scroll">
        <Alert color="gray" icon={<IconInfoCircle size={16} />} title="还没有可看的张量">
          <Stack gap="xs">
            <Text size="xs">在前向里记一张注意力热图，或者记一组分布：</Text>
            <Text size="xs" ff="monospace" c="dimmed">
              nt.log.attention(probs, B, H, S, layer=0, head=0)<br />
              nt.log.histogram(x.grad, &quot;grad/wq&quot;)
            </Text>
          </Stack>
        </Alert>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea h="100%" type="auto" p="sm" className="panel-scroll">
      {log.attention.length > 0 && attn && (
        <Paper withBorder p="xs" mb="sm">
          <Group justify="space-between" mb={6}>
            <Text size="xs" fw={600}>注意力热图</Text>
            <Select
              size="xs"
              value={String(Math.min(attnIndex, log.attention.length - 1))}
              onChange={(v) => setAttnIndex(Number(v ?? 0))}
              data={log.attention.map((s, i) => ({
                value: String(i),
                label: `第 ${s.step} 步 · 层 ${s.layer} · 头 ${s.head}`,
              }))}
              allowDeselect={false}
              style={{ minWidth: 200 }}
            />
          </Group>
          <AttentionHeatmap snapshot={attn} />
          <Text size="xs" c="dimmed" mt={4}>
            行是查询位置、列是被看的位置。**右上三角必须全黑** ——
            亮起来就是因果掩码漏了，而那种模型的 loss 反而更低。
          </Text>
        </Paper>
      )}

      {log.histograms.length > 0 && hist && (
        <Paper withBorder p="xs" mb="sm">
          <Group justify="space-between" mb={6}>
            <Text size="xs" fw={600}>分布</Text>
            <Select
              size="xs"
              value={String(Math.min(histIndex, log.histograms.length - 1))}
              onChange={(v) => setHistIndex(Number(v ?? 0))}
              data={log.histograms.map((h, i) => ({
                value: String(i), label: `${h.name}（第 ${h.step} 步）`,
              }))}
              allowDeselect={false}
              style={{ minWidth: 220 }}
            />
          </Group>
          <div style={{ width: '100%', height: 160 }}>
            <ResponsiveContainer>
              <BarChart
                data={hist.counts.map((c, i) => ({ x: hist.edges[i], count: c }))}
                margin={{ top: 4, right: 8, bottom: 4, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--app-border)" />
                <XAxis dataKey="x" tick={{ fontSize: 10 }}
                  tickFormatter={(v) => (typeof v === 'number' ? v.toPrecision(2) : String(v))} />
                <YAxis tick={{ fontSize: 10 }} width={44} />
                <Tooltip contentStyle={{ fontSize: 12 }}
                  labelFormatter={(v) => (typeof v === 'number' ? `≥ ${v.toPrecision(3)}` : String(v))} />
                <Bar dataKey="count" fill="#2563eb" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Group gap="md" mt={4}>
            <Text size="xs" c="dimmed">均值 {hist.mean.toPrecision(3)}</Text>
            <Text size="xs" c="dimmed">标准差 {hist.std.toPrecision(3)}</Text>
            <Text size="xs" c="dimmed">
              范围 [{hist.min.toPrecision(3)}, {hist.max.toPrecision(3)}]
            </Text>
          </Group>
        </Paper>
      )}

      {memory.length > 0 && (
        <Paper withBorder p="xs" mb="sm">
          <Text size="xs" fw={600} mb={4}>显存分解</Text>
          <Table fz="xs" verticalSpacing={3}>
            <Table.Tbody>
              {memory.map((row) => (
                <Table.Tr key={row.name}>
                  <Table.Td>{row.name}</Table.Td>
                  <Table.Td ta="right" ff="monospace">{formatBytes(row.bytes)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {/*
            激活峰值单独说一句：注意力那块 [B,H,S,S] 往往比模型本身还大，
            而这正是 FlashAttention 存在的理由。学员自己看到这个数才有体感。
          */}
          <Text size="xs" c="dimmed" mt={4}>
            激活峰值里最大的一块通常是注意力的 [B, H, S, S] 概率矩阵 ——
            它随序列长度平方增长。
          </Text>
        </Paper>
      )}

      {moduleRows.length > 0 && (
        <Paper withBorder p="xs">
          <Group justify="space-between" mb={4}>
            <Text size="xs" fw={600}>参数量</Text>
            <Badge size="sm" variant="light">
              {(metrics?.params?.total as number ?? 0).toLocaleString()}
            </Badge>
          </Group>
          <Table fz="xs" verticalSpacing={3}>
            <Table.Tbody>
              {moduleRows.map(([name, count]) => (
                <Table.Tr key={name}>
                  <Table.Td ff="monospace">{name}</Table.Td>
                  <Table.Td ta="right">{count.toLocaleString()}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
    </ScrollArea>
  );
}

/**
 * 热图用 canvas 画。
 *
 * S 到 128 时是 16384 个格子，用 div 画会造出一万多个 DOM 节点 ——
 * 首帧要几百毫秒，而且每次换头都重来一遍。canvas 是一次 putImageData。
 */
function AttentionHeatmap({ snapshot }: { snapshot: AttentionSnapshot }) {
  const size = snapshot.seqLen;
  const scale = Math.max(1, Math.floor(280 / Math.max(1, size)));
  const px = size * scale;

  const dataUrl = useMemo(() => {
    if (typeof document === 'undefined' || size === 0) return '';
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    const image = ctx.createImageData(px, px);

    // 每一行各自归一化：因果注意力里靠后的行本来就摊得更薄，
    // 用全局最大值上色的话前几行会白得看不出结构
    const rowMax = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      let m = 0;
      for (let j = 0; j < size; j++) m = Math.max(m, snapshot.probs[i * size + j]);
      rowMax[i] = m || 1;
    }

    for (let y = 0; y < px; y++) {
      const i = Math.floor(y / scale);
      for (let x = 0; x < px; x++) {
        const j = Math.floor(x / scale);
        const v = snapshot.probs[i * size + j] / rowMax[i];
        const t = Math.max(0, Math.min(1, v));
        const at = (y * px + x) * 4;
        // 深蓝 → 亮青。0 是纯黑，所以被掩掉的位置一眼看得出来
        image.data[at] = Math.round(20 * t);
        image.data[at + 1] = Math.round(180 * t);
        image.data[at + 2] = Math.round(60 + 195 * t);
        image.data[at + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL();
  }, [snapshot, size, px, scale]);

  if (!dataUrl) return <Text size="xs" c="dimmed">画不出来</Text>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={dataUrl}
      alt={`第 ${snapshot.step} 步 层 ${snapshot.layer} 头 ${snapshot.head} 的注意力`}
      style={{ width: px, height: px, imageRendering: 'pixelated', display: 'block' }}
    />
  );
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}
