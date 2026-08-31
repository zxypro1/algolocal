/**
 * 样例面板：模型到底说了什么
 *
 * 后训练的一半内容是「输出变成什么样了」，而这件事**不看样例是判断不了的** ——
 * loss 降了不等于答得更好，胜率涨了可能只是因为答得更长。
 *
 * 三种视图，对应三个阶段：
 *
 * | 分组 | 用在哪 | 看什么 |
 * | --- | --- | --- |
 * | 单条 | 预训练、SFT | token 按 logprob 着色 —— 模型在哪几个词上没把握 |
 * | 成对 | 偏好优化 | chosen / rejected 并排，以及它们的长度差 |
 * | rollout 组 | GRPO | 一组采样各自的 reward 与 advantage，**组内均值画在旁边** |
 */
import { useMemo, useState } from 'react';
import {
  Alert, Badge, Group, Paper, ScrollArea, SegmentedControl, Stack, Text,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type { SampleRecord, TrainingLogView } from '../../lib/llmlab/bridge';

export interface SamplePanelProps {
  log: TrainingLogView;
  revision: number;
}

export default function SamplePanel({ log, revision }: SamplePanelProps) {
  const groups = useMemo(
    () => Array.from(new Set(log.samples.map((s) => s.group))).sort(),
    [log.samples, revision]
  );
  const [group, setGroup] = useState<string | null>(null);
  const active = group && groups.includes(group) ? group : groups[0];
  const shown = useMemo(
    () => log.samples.filter((s) => s.group === active).slice(-40).reverse(),
    [log.samples, active, revision]
  );

  if (log.samples.length === 0) {
    return (
      <ScrollArea h="100%" type="auto" p="md" className="panel-scroll">
        <Alert color="gray" icon={<IconInfoCircle size={16} />} title="还没有生成样例">
          <Stack gap="xs">
            <Text size="xs">生成一段就记一条，这里会按 logprob 着色：</Text>
            <Text size="xs" ff="monospace" c="dimmed">
              nt.log.sample(text, step=step, logprobs=lp, group=&quot;pretrain&quot;)
            </Text>
            <Text size="xs" c="dimmed">
              loss 降了不等于答得更好 —— 后训练那几关，样例才是判断的入口。
            </Text>
          </Stack>
        </Alert>
      </ScrollArea>
    );
  }

  // 一组 rollout 的组内均值：GRPO 的优势归一化写错时，它不是 0
  const advantages = shown.map((s) => s.advantage).filter(Number.isFinite);
  const advMean = advantages.length
    ? advantages.reduce((a, b) => a + b, 0) / advantages.length
    : null;

  return (
    <ScrollArea h="100%" type="auto" p="sm" className="panel-scroll">
      {groups.length > 1 && (
        <SegmentedControl
          size="xs"
          mb="xs"
          value={active}
          onChange={setGroup}
          data={groups.map((g) => ({ value: g, label: g }))}
        />
      )}

      {advMean !== null && (
        <Paper withBorder p={6} mb="xs">
          <Group gap="md">
            <Text size="xs" c="dimmed">组内优势均值</Text>
            <Badge size="sm" variant="light" color={Math.abs(advMean) < 1e-4 ? 'teal' : 'orange'}>
              {advMean.toExponential(2)}
            </Badge>
            <Text size="xs" c="dimmed">
              归一化对了它应该≈0 —— 不是 0 就是那一步算错了
            </Text>
          </Group>
        </Paper>
      )}

      <Stack gap="xs">
        {shown.map((s, i) => <SampleCard key={i} sample={s} />)}
      </Stack>
    </ScrollArea>
  );
}

function SampleCard({ sample }: { sample: SampleRecord }) {
  const chars = Array.from(sample.text);
  const hasLogprobs = sample.logprobs.length > 0;

  return (
    <Paper withBorder p="xs">
      <Group gap={6} mb={4}>
        <Badge size="xs" variant="light" color="gray">第 {sample.step} 步</Badge>
        {Number.isFinite(sample.reward) && (
          <Badge size="xs" variant="light" color={sample.reward > 0 ? 'teal' : 'red'}>
            reward {sample.reward.toFixed(3)}
          </Badge>
        )}
        {Number.isFinite(sample.advantage) && (
          <Badge size="xs" variant="light" color="blue">
            adv {sample.advantage.toFixed(3)}
          </Badge>
        )}
        <Badge size="xs" variant="light" color="gray">{chars.length} 字符</Badge>
        {Object.entries(sample.meta).map(([k, v]) => (
          <Badge key={k} size="xs" variant="outline" color="gray">{k} {String(v)}</Badge>
        ))}
      </Group>
      <div style={{ fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
        {hasLogprobs
          ? chars.map((ch, i) => (
              <span key={i} style={{ backgroundColor: colorFor(sample.logprobs[i]) }}>{ch}</span>
            ))
          : sample.text}
      </div>
      {hasLogprobs && (
        <Text size="xs" c="dimmed" mt={4}>
          底色越红，模型对那个 token 越没把握（logprob 越低）
        </Text>
      )}
    </Paper>
  );
}

/**
 * logprob → 底色。
 *
 * 0 是「完全确定」（概率 1），−4 往下基本是「在瞎猜」。
 * 用透明度而不是换色相：叠在深浅两种主题上都还能读。
 */
function colorFor(logprob: number | undefined): string {
  if (logprob === undefined || !Number.isFinite(logprob)) return 'transparent';
  const t = Math.max(0, Math.min(1, -logprob / 4));
  return `rgba(239, 68, 68, ${(t * 0.45).toFixed(3)})`;
}
