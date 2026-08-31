/**
 * 训练面板：loss 曲线、学习率、梯度范数、以及每条门槛的实时值
 *
 * 这块面板要回答的是「它在学吗」，而不是「它内部长什么样」（那是张量面板）。
 *
 * 三条基线画成横线是有意的：**loss 的绝对值没有意义，相对基线才有**。
 * 一个 1.9 的 loss 是好是坏，取决于均匀熵是 3.26 还是 6.9。
 * 学员在第 2 关自己算出来的那三个数，从此一直在图上陪着他。
 */
import { useMemo } from 'react';
import {
  Alert, Badge, Group, Paper, ScrollArea, SegmentedControl, Stack, Table, Text,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { useState } from 'react';
import type { TrainingLogView } from '../../lib/llmlab/bridge';
import type { Baselines } from '../../lib/llmlab/lab';
import type { GateResult } from '../../lib/engineering/types';

export interface TrainingPanelProps {
  log: TrainingLogView;
  baselines?: Baselines;
  gates?: GateResult[];
  /** 世界改过几次 —— 拿它当重算的依据 */
  revision: number;
}

type Metric = 'loss' | 'lr' | 'gradNorm';

const METRIC_LABEL: Record<Metric, string> = {
  loss: 'loss',
  lr: '学习率',
  gradNorm: '梯度范数',
};

export default function TrainingPanel({ log, baselines, gates, revision }: TrainingPanelProps) {
  const [metric, setMetric] = useState<Metric>('loss');

  const data = useMemo(() => log.steps.map((s) => ({
    step: s.step,
    loss: Number.isFinite(s.loss) ? s.loss : null,
    valLoss: Number.isFinite(s.valLoss) ? s.valLoss : null,
    lr: Number.isFinite(s.lr) ? s.lr : null,
    gradNorm: Number.isFinite(s.gradNorm) ? s.gradNorm : null,
  })), [log.steps, revision]);

  const custom = useMemo(() => Object.keys(log.scalars).sort(), [log.scalars, revision]);

  if (data.length === 0) {
    return (
      <ScrollArea h="100%" type="auto" p="md" className="panel-scroll">
        <Alert color="gray" icon={<IconInfoCircle size={16} />} title="还没有训练记录">
          <Stack gap="xs">
            <Text size="xs">在训练循环里调一下日志，这里就会实时画出来：</Text>
            <Text size="xs" ff="monospace" c="dimmed">
              nt.log.step(step, loss=loss.value, lr=lr, grad_norm=gn)
            </Text>
            <Text size="xs" c="dimmed">
              日志不是门槛的来源 —— 门槛读的是算子层数出来的计量，你绕不过。
              这里只负责让人看见。
            </Text>
          </Stack>
        </Alert>
      </ScrollArea>
    );
  }

  const last = log.steps[log.steps.length - 1];
  const showBaselines = metric === 'loss' && baselines;

  return (
    <ScrollArea h="100%" type="auto" p="sm" className="panel-scroll">
      <Group justify="space-between" mb="xs">
        <SegmentedControl
          size="xs"
          value={metric}
          onChange={(v) => setMetric(v as Metric)}
          data={(['loss', 'lr', 'gradNorm'] as Metric[]).map((m) => ({ value: m, label: METRIC_LABEL[m] }))}
        />
        <Group gap={6}>
          <Badge size="sm" variant="light" color="gray">{log.steps.length} 步</Badge>
          {Number.isFinite(last.loss) && (
            <Badge size="sm" variant="light" color="blue">loss {last.loss.toFixed(4)}</Badge>
          )}
        </Group>
      </Group>

      <Paper withBorder p="xs" mb="sm">
        <div style={{ width: '100%', height: 240 }}>
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--app-border)" />
              <XAxis dataKey="step" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} width={52} domain={['auto', 'auto']} />
              <Tooltip
                contentStyle={{ fontSize: 12 }}
                formatter={(v) => (typeof v === 'number' ? v.toPrecision(5) : '—')}
              />
              {/*
                基线画成横线：loss 的绝对值没有意义，相对基线才有。
                「打穿 bigram」这件事在图上是一条线被穿过去，不是一个数字变小。
              */}
              {showBaselines && (
                <ReferenceLine y={baselines!.uniform} stroke="#94a3b8" strokeDasharray="4 4"
                  label={{ value: `均匀 ${baselines!.uniform.toFixed(2)}`, fontSize: 10, position: 'right' }} />
              )}
              {showBaselines && (
                <ReferenceLine y={baselines!.unigram} stroke="#f59e0b" strokeDasharray="4 4"
                  label={{ value: `unigram ${baselines!.unigram.toFixed(2)}`, fontSize: 10, position: 'right' }} />
              )}
              {showBaselines && (
                <ReferenceLine y={baselines!.bigram} stroke="#ef4444" strokeDasharray="4 4"
                  label={{ value: `bigram ${baselines!.bigram.toFixed(2)}`, fontSize: 10, position: 'right' }} />
              )}
              <Line type="monotone" dataKey={metric} stroke="#2563eb" dot={false} strokeWidth={1.6}
                isAnimationActive={false} connectNulls />
              {metric === 'loss' && (
                <Line type="monotone" dataKey="valLoss" stroke="#16a34a" dot={false} strokeWidth={1.6}
                  strokeDasharray="5 3" isAnimationActive={false} connectNulls />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
        {metric === 'loss' && (
          <Text size="xs" c="dimmed" mt={4}>
            实线是训练 loss，虚线是验证 loss。两条分开就是开始过拟合了。
          </Text>
        )}
      </Paper>

      {custom.length > 0 && (
        <Paper withBorder p="xs" mb="sm">
          <Text size="xs" fw={600} mb={4}>自定义曲线</Text>
          <div style={{ width: '100%', height: 180 }}>
            <ResponsiveContainer>
              <LineChart margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--app-border)" />
                <XAxis dataKey="step" type="number" tick={{ fontSize: 11 }} allowDuplicatedCategory={false} />
                <YAxis tick={{ fontSize: 11 }} width={52} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                {custom.map((name, i) => (
                  <Line key={name} data={log.scalars[name]} dataKey="value" name={name}
                    stroke={['#2563eb', '#16a34a', '#f59e0b', '#a855f7', '#ef4444'][i % 5]}
                    dot={false} strokeWidth={1.5} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <Text size="xs" c="dimmed">{custom.join(' · ')}</Text>
        </Paper>
      )}

      {gates && gates.length > 0 && (
        <Paper withBorder p="xs">
          <Text size="xs" fw={600} mb={4}>门槛</Text>
          <Table fz="xs" verticalSpacing={4}>
            <Table.Tbody>
              {gates.map((g, i) => (
                <Table.Tr key={i}>
                  <Table.Td>{g.gate.label.zh || g.gate.metric}</Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {formatNumber(g.actual)} {opText(g.gate.op)} {formatNumber(g.gate.value)}
                  </Table.Td>
                  <Table.Td w={48} ta="right">
                    <Badge size="xs" color={g.passed ? 'teal' : 'red'} variant="light">
                      {g.passed ? '过' : '挂'}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
    </ScrollArea>
  );
}

function opText(op: string): string {
  return { lte: '≤', lt: '<', gte: '≥', gt: '>', eq: '=' }[op] ?? op;
}

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v !== 0 && (Math.abs(v) >= 1e6 || Math.abs(v) < 1e-3)) return v.toExponential(2);
  return String(Math.round(v * 1e4) / 1e4);
}
