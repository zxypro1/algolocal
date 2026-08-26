import { Alert, Badge, Button, Card, Group, List, Loader, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconBulb, IconCheck, IconSparkles, IconThumbUp } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/I18nContext';
import MarkdownRenderer from '../MarkdownRenderer';
import { scoreColor } from './ResultPanels';
import type { DimensionKey } from '../../lib/engineering/types';

const SEVERITY_COLOR: Record<string, string> = {
  blocker: 'red',
  major: 'orange',
  minor: 'yellow',
  nit: 'gray',
};

/**
 * 面板认的是形状，不是某一种评审。
 *
 * ops 工作台的复盘（OpsReview）维度不一样、定位字段也不叫 file，但排版是同一套：
 * 总结 + 维度分 + 问题列表 + 亮点 + 下一步。与其抄一份，不如把这里放宽到结构，
 * 由调用方把自己的评审映射进来。AiReview 天然满足这个形状。
 */
export interface ReviewPanelData {
  summary: string;
  dimensions: Array<{ key: string; score: number; comment: string }>;
  issues: Array<{
    title: string;
    severity: string;
    /** 右上角那行小字：代码形态是文件名，ops 是命令或对象 */
    file?: string;
    detail: string;
    suggestion?: string;
  }>;
  strengths: string[];
  nextSteps: string[];
}

/** 面板上的文案。不传就按代码形态的来，代码工作台因此完全不用改。 */
export interface ReviewPanelStrings {
  title: string;
  subtitle: string;
  request: string;
  running: string;
  empty: string;
  issues: string;
  strengths: string;
  nextSteps: string;
  dimensionLabel: (key: string) => string;
}

interface ReviewPanelProps {
  review: ReviewPanelData | null;
  loading: boolean;
  error: string | null;
  onRequest: () => void;
  /** 评审生成中的原文。有它就不用对着一个转圈猜进度。 */
  draft?: string;
  strings?: ReviewPanelStrings;
}

export default function ReviewPanel({ review, loading, error, onRequest, draft, strings }: ReviewPanelProps) {
  const { t } = useTranslation();

  const text: ReviewPanelStrings = strings ?? {
    title: t('engineering.review.title'),
    subtitle: t('engineering.review.subtitle'),
    request: t('engineering.review.request'),
    running: t('engineering.review.running'),
    empty: t('engineering.review.empty'),
    issues: t('engineering.review.issues'),
    strengths: t('engineering.review.strengths'),
    nextSteps: t('engineering.review.nextSteps'),
    dimensionLabel: (key) => t(`engineering.dimensions.${key as DimensionKey}` as const),
  };

  return (
    <Stack gap="md">
      <Card withBorder radius="md" padding="sm">
        <Group justify="space-between" wrap="nowrap">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text size="sm" fw={600}>
              {text.title}
            </Text>
            <Text size="xs" c="dimmed">
              {text.subtitle}
            </Text>
          </Stack>
          <Button
            size="xs"
            variant="light"
            color="violet"
            leftSection={loading ? <Loader size={12} /> : <IconSparkles size={14} />}
            onClick={onRequest}
            disabled={loading}
          >
            {loading ? text.running : text.request}
          </Button>
        </Group>
      </Card>

      {error && (
        <Alert color="red" title={t('common.error')}>
          {error}
        </Alert>
      )}

      {loading && draft && (
        <Card withBorder radius="md" padding="sm">
          <Text
            size="xs"
            c="dimmed"
            style={{
              maxHeight: 240,
              overflow: 'auto',
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {draft.slice(-4000)}
          </Text>
        </Card>
      )}

      {!review && !loading && !error && (
        <Group justify="center" py="xl">
          <Text size="sm" c="dimmed" ta="center" maw={360}>
            {text.empty}
          </Text>
        </Group>
      )}

      {review && (
        <>
          <Card withBorder radius="md" padding="md">
            <MarkdownRenderer content={review.summary} />
          </Card>

          {review.dimensions.length > 0 && (
            <Group gap="xs" wrap="wrap">
              {review.dimensions.map((dimension) => (
                <Card key={dimension.key} withBorder radius="md" padding="sm" style={{ flex: '1 1 160px' }}>
                  <Group justify="space-between" mb={2}>
                    <Text size="xs" fw={600}>
                      {text.dimensionLabel(dimension.key)}
                    </Text>
                    <Text size="sm" fw={700} c={scoreColor(dimension.score)}>
                      {dimension.score}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {dimension.comment}
                  </Text>
                </Card>
              ))}
            </Group>
          )}

          {review.issues.length > 0 && (
            <Stack gap={8}>
              <Text size="sm" fw={600}>
                {text.issues}
              </Text>
              {review.issues.map((issue, index) => (
                <Card key={index} withBorder radius="md" padding="sm">
                  <Group gap={8} mb={6} wrap="nowrap">
                    <Badge size="xs" color={SEVERITY_COLOR[issue.severity] || 'gray'} variant="filled">
                      {issue.severity}
                    </Badge>
                    <Text size="sm" fw={600} style={{ flex: 1 }}>
                      {issue.title}
                    </Text>
                    {issue.file && (
                      <Text size="xs" c="dimmed" ff="monospace">
                        {issue.file}
                      </Text>
                    )}
                  </Group>
                  <Text size="xs" mb={issue.suggestion ? 6 : 0}>
                    {issue.detail}
                  </Text>
                  {issue.suggestion && (
                    <Group gap={6} align="flex-start" wrap="nowrap">
                      <ThemeIcon size={16} radius="xl" variant="light" color="teal">
                        <IconBulb size={10} />
                      </ThemeIcon>
                      <Text size="xs" c="dimmed">
                        {issue.suggestion}
                      </Text>
                    </Group>
                  )}
                </Card>
              ))}
            </Stack>
          )}

          {review.strengths.length > 0 && (
            <Card withBorder radius="md" padding="sm">
              <Group gap={6} mb={6}>
                <IconThumbUp size={14} />
                <Text size="sm" fw={600}>
                  {text.strengths}
                </Text>
              </Group>
              <List size="xs" spacing={4} icon={<IconCheck size={12} color="var(--mantine-color-teal-filled)" />}>
                {review.strengths.map((item, index) => (
                  <List.Item key={index}>{item}</List.Item>
                ))}
              </List>
            </Card>
          )}

          {review.nextSteps.length > 0 && (
            <Card withBorder radius="md" padding="sm">
              <Text size="sm" fw={600} mb={6}>
                {text.nextSteps}
              </Text>
              <List size="xs" spacing={4} type="ordered">
                {review.nextSteps.map((item, index) => (
                  <List.Item key={index}>{item}</List.Item>
                ))}
              </List>
            </Card>
          )}
        </>
      )}
    </Stack>
  );
}
