import { Alert, Badge, Box, Card, Code, Group, Progress, ScrollArea, Stack, Text, ThemeIcon } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconGauge,
  IconInfoCircle,
  IconTerminal2,
  IconX,
} from '@tabler/icons-react';
import {
  Area,
  AreaChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useI18n, useTranslation } from '../../contexts/I18nContext';
import ConsoleOutput from '../ConsoleOutput';
import type {
  DimensionKey,
  LocalizedText,
  QualityReport,
  ScoreCard,
  StageRunReport,
} from '../../lib/engineering/types';

function useLocalized() {
  const { locale } = useI18n();
  return (text: LocalizedText | undefined) =>
    !text ? '' : text[locale as 'en' | 'zh'] || text.zh || text.en || '';
}

export function scoreColor(score: number): string {
  if (score >= 85) return 'teal';
  if (score >= 70) return 'yellow';
  if (score >= 50) return 'orange';
  return 'red';
}

/* ------------------------------------------------------------------ */
/* 用例与门槛                                                          */
/* ------------------------------------------------------------------ */

export function RunReportPanel({ report }: { report: StageRunReport | null }) {
  const { t } = useTranslation();
  const localized = useLocalized();

  if (!report) {
    return (
      <Group justify="center" py="xl">
        <Text size="sm" c="dimmed">
          {t('engineering.results.empty')}
        </Text>
      </Group>
    );
  }

  const passRate = report.totals.total ? (report.totals.passed / report.totals.total) * 100 : 0;

  return (
    <Stack gap="md">
      {report.error && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('engineering.results.runError')}>
          <Code block>{report.error}</Code>
        </Alert>
      )}

      <Card withBorder radius="md" padding="sm">
        <Group justify="space-between" mb={8}>
          <Group gap={8}>
            <Badge color={report.status === 'passed' ? 'teal' : 'red'} variant="filled">
              {report.status === 'passed' ? t('engineering.results.stagePassed') : t('engineering.results.stageFailed')}
            </Badge>
            <Text size="sm" fw={500}>
              {report.totals.passed}/{report.totals.total} {t('engineering.results.cases')}
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            {report.wallClockMs}ms
          </Text>
        </Group>
        <Progress value={passRate} color={passRate === 100 ? 'teal' : 'orange'} size="sm" radius="xl" />
      </Card>

      {report.gates.length > 0 && (
        <Card withBorder radius="md" padding="sm">
          <Group gap={6} mb={8}>
            <IconGauge size={15} />
            <Text size="sm" fw={600}>
              {t('engineering.results.gates')}
            </Text>
          </Group>
          <Stack gap={6}>
            {report.gates.map((gate, index) => (
              <Group key={index} justify="space-between" wrap="nowrap">
                <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                  <ThemeIcon size={16} radius="xl" color={gate.passed ? 'teal' : 'red'} variant="light">
                    {gate.passed ? <IconCheck size={10} /> : <IconX size={10} />}
                  </ThemeIcon>
                  <Text size="xs" truncate>
                    {localized(gate.gate.label)}
                  </Text>
                </Group>
                <Text size="xs" c={gate.passed ? 'dimmed' : 'red'} style={{ whiteSpace: 'nowrap' }}>
                  {Number.isFinite(gate.actual) ? gate.actual : '—'}
                  {gate.gate.unit || ''} / {gate.gate.op === 'lte' || gate.gate.op === 'lt' ? '≤' : '≥'}{' '}
                  {gate.gate.value}
                  {gate.gate.unit || ''}
                </Text>
              </Group>
            ))}
          </Stack>
        </Card>
      )}

      <Stack gap={6}>
        {report.cases.map((testCase, index) => (
          <Card key={index} withBorder radius="md" padding="sm">
            <Group justify="space-between" wrap="nowrap" mb={testCase.passed ? 0 : 6}>
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                <ThemeIcon size={16} radius="xl" color={testCase.passed ? 'teal' : 'red'} variant="light">
                  {testCase.passed ? <IconCheck size={10} /> : <IconX size={10} />}
                </ThemeIcon>
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  {testCase.suite.join(' › ')}
                </Text>
                <Text size="xs" fw={500} truncate>
                  {testCase.name}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                {testCase.durationMs}ms
              </Text>
            </Group>

            {!testCase.passed && testCase.error && (
              <Box>
                <Code block style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>
                  {testCase.error}
                </Code>
                {(testCase.expected || testCase.actual) && (
                  <Group gap="xs" mt={6} align="flex-start">
                    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                      <Text size="xs" c="dimmed">
                        {t('engineering.results.expected')}
                      </Text>
                      <Code style={{ fontSize: 11 }}>{testCase.expected || '—'}</Code>
                    </Stack>
                    <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                      <Text size="xs" c="dimmed">
                        {t('engineering.results.actual')}
                      </Text>
                      <Code color="red" style={{ fontSize: 11 }}>
                        {testCase.actual || '—'}
                      </Code>
                    </Stack>
                  </Group>
                )}
              </Box>
            )}

            {testCase.console && testCase.console.length > 0 && (
              <Box mt={6}>
                <ConsoleOutput
                  entries={testCase.console}
                  truncated={testCase.consoleTruncated}
                  defaultOpen={!testCase.passed}
                  maxHeight={160}
                />
              </Box>
            )}
          </Card>
        ))}
      </Stack>

      {report.console.length > 0 && (
        <Card withBorder radius="md" padding="sm">
          {/*
            带上条数：之前这块没有任何计数，用户跑完一轮看不出「到底有没有输出」，
            要一条条展开用例才发现。
          */}
          <Group gap={6} mb={8}>
            <IconTerminal2 size={15} />
            <Text size="sm" fw={600}>
              {t('engineering.results.console')}
            </Text>
            <Badge size="xs" variant="light" color="gray">
              {report.console.length}
            </Badge>
          </Group>
          <ScrollArea.Autosize mah={180}>
            <Stack gap={2}>
              {report.console.map((entry, index) => (
                <Text
                  key={index}
                  size="xs"
                  ff="monospace"
                  c={entry.level === 'error' ? 'red' : entry.level === 'warn' ? 'orange' : undefined}
                >
                  <Text span size="xs" c="dimmed">
                    [{entry.at}ms]{' '}
                  </Text>
                  {entry.text}
                </Text>
              ))}
            </Stack>
          </ScrollArea.Autosize>
        </Card>
      )}
    </Stack>
  );
}

/* ------------------------------------------------------------------ */
/* 工程指标                                                            */
/* ------------------------------------------------------------------ */

function MetricTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card withBorder radius="md" padding="sm" style={{ flex: '1 1 130px', minWidth: 130 }}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="lg" fw={700}>
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Card>
  );
}

export function MetricsPanel({ report }: { report: StageRunReport | null }) {
  const { t } = useTranslation();

  if (!report) {
    return (
      <Group justify="center" py="xl">
        <Text size="sm" c="dimmed">
          {t('engineering.results.empty')}
        </Text>
      </Group>
    );
  }

  const { metrics } = report;

  return (
    <Stack gap="md">
      <Group gap="sm" wrap="wrap">
        <MetricTile label={t('engineering.metrics.virtualElapsed')} value={`${metrics.virtualElapsedMs}ms`} />
        <MetricTile label={t('engineering.metrics.maxConcurrency')} value={metrics.maxConcurrency} />
        <MetricTile label={t('engineering.metrics.requests')} value={metrics.requests.total} />
        <MetricTile label={t('engineering.metrics.failed')} value={metrics.requests.failed} />
        <MetricTile label={t('engineering.metrics.throttled')} value={metrics.requests.throttled} />
        <MetricTile label={t('engineering.metrics.retries')} value={metrics.requests.retries} />
        <MetricTile label={t('engineering.metrics.duplicated')} value={metrics.requests.duplicated} />
      </Group>

      {metrics.concurrencyTimeline.length > 1 && (
        <Card withBorder radius="md" padding="sm">
          <Text size="sm" fw={600} mb={4}>
            {t('engineering.metrics.timeline')}
          </Text>
          <Text size="xs" c="dimmed" mb="sm">
            {t('engineering.metrics.timelineHint')}
          </Text>
          <Box h={160}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={metrics.concurrencyTimeline}>
                <XAxis dataKey="t" tick={{ fontSize: 10 }} unit="ms" />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={24} />
                <RechartsTooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  labelFormatter={(value) => `${value}ms`}
                />
                <Area
                  type="stepAfter"
                  dataKey="inFlight"
                  stroke="var(--mantine-color-brand-filled)"
                  fill="var(--mantine-color-brand-light)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </Box>
        </Card>
      )}

      {Object.keys(metrics.counters).length > 0 && (
        <Card withBorder radius="md" padding="sm">
          <Text size="sm" fw={600} mb={8}>
            {t('engineering.metrics.counters')}
          </Text>
          <Stack gap={4}>
            {Object.entries(metrics.counters).map(([name, value]) => (
              <Group key={name} justify="space-between">
                <Text size="xs" ff="monospace">
                  {name}
                </Text>
                <Badge size="sm" variant="light">
                  {value}
                </Badge>
              </Group>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

/* ------------------------------------------------------------------ */
/* 评分卡                                                              */
/* ------------------------------------------------------------------ */

export function ScoreCardPanel({
  scoreCard,
  quality,
}: {
  scoreCard: ScoreCard | null;
  quality: QualityReport | null;
}) {
  const { t } = useTranslation();
  const localized = useLocalized();

  if (!scoreCard) {
    return (
      <Group justify="center" py="xl">
        <Text size="sm" c="dimmed">
          {t('engineering.results.empty')}
        </Text>
      </Group>
    );
  }

  const radarData = scoreCard.dimensions.map((dimension) => ({
    dimension: t(`engineering.dimensions.${dimension.key}` as const),
    // 未测量的维度按 0 画，否则雷达图会给「什么都没跑」画出一个满形状
    score: dimension.measured ? dimension.score : 0,
  }));

  return (
    <Stack gap="md">
      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" align="flex-start">
          <Stack gap={0}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
              {t('engineering.score.total')}
            </Text>
            <Text size="42px" fw={800} lh={1.1} c={scoreColor(scoreCard.total)}>
              {scoreCard.total}
            </Text>
          </Stack>
          <Box style={{ width: 220, height: 180 }}>
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={radarData} outerRadius="70%">
                <PolarGrid />
                <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 10 }} />
                <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                <Radar
                  dataKey="score"
                  stroke="var(--mantine-color-brand-filled)"
                  fill="var(--mantine-color-brand-filled)"
                  fillOpacity={0.35}
                />
              </RadarChart>
            </ResponsiveContainer>
          </Box>
        </Group>
      </Card>

      {scoreCard.passRate < 1 && (
        <Text size="xs" c="dimmed">
          {t('engineering.score.scaledByPassRate', { percent: Math.round(scoreCard.passRate * 100) })}
        </Text>
      )}

      <Stack gap={6}>
        {scoreCard.dimensions.map((dimension) => (
          <Card key={dimension.key} withBorder radius="md" padding="sm">
            <Group justify="space-between" mb={4}>
              <Group gap={6}>
                <Text size="sm" fw={600}>
                  {t(`engineering.dimensions.${dimension.key as DimensionKey}` as const)}
                </Text>
                <Badge size="xs" variant="light" color="gray">
                  ×{dimension.weight}
                </Badge>
              </Group>
              {/* 没有可测数据的维度显示「—」，给个满分反而是误导 */}
              <Text size="sm" fw={700} c={dimension.measured ? scoreColor(dimension.score) : 'dimmed'}>
                {dimension.measured ? dimension.score : '—'}
              </Text>
            </Group>
            <Progress
              value={dimension.measured ? dimension.score : 0}
              color={dimension.measured ? scoreColor(dimension.score) : 'gray'}
              size="xs"
              radius="xl"
              mb={6}
            />
            <Text size="xs" c="dimmed">
              {dimension.measured ? localized(dimension.detail) : t('engineering.score.notMeasured')}
            </Text>
          </Card>
        ))}
      </Stack>

      {quality && quality.findings.length > 0 && (
        <Card withBorder radius="md" padding="sm">
          <Text size="sm" fw={600} mb={8}>
            {t('engineering.score.staticFindings')}
          </Text>
          <Stack gap={8}>
            {quality.findings.map((finding, index) => (
              <Group key={index} gap={8} align="flex-start" wrap="nowrap">
                <ThemeIcon
                  size={18}
                  radius="xl"
                  variant="light"
                  color={finding.severity === 'error' ? 'red' : finding.severity === 'warn' ? 'orange' : 'blue'}
                >
                  {finding.severity === 'info' ? <IconInfoCircle size={11} /> : <IconAlertTriangle size={11} />}
                </ThemeIcon>
                <Text size="xs">{localized(finding.message)}</Text>
              </Group>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
