/**
 * gpulab 工作台的 AI 复盘
 *
 * 和 ops 的复盘并列，但评的东西不一样：那边评「这一关他是怎么操作过来的」，
 * 这边评**优化本身** —— 有没有先量再改、改动是不是冲着瓶颈去的、结果还对不对，
 * 以及最要紧的一条：门槛是真的优化过去的，还是把 kernel 掏空蒙过去的。
 *
 * 位置同 ops：左栏「验收」旁边，不在右栏。右栏是干活的地方（终端、IDE、剖析），
 * 左栏是读长文的地方，而复盘正是一篇要从头读到尾的长文。
 *
 * 排版复用 ReviewPanel，和代码形态、ops 是同一套结构，只换维度和文案。
 */
import { useCallback, useMemo, useState } from 'react';
import { useI18n, useTranslation } from '../../contexts/I18nContext';
import { useAiConfig } from '../../hooks/useAiConfig';
import { requestStructuredStream } from '../../lib/streamRequest';
import ReviewPanel from '../engineering/ReviewPanel';
import type { ReviewPanelData, ReviewPanelStrings } from '../engineering/ReviewPanel';
import { buildGpuSnapshot, summarizeGpuReport, GPU_SNAPSHOT_LIMITS } from '../../lib/gpulab/lab/aicontext';
import type { GpuWorld } from '../../lib/gpulab/lab';
import type { CommandRecord } from '../../lib/labkit/machine';
import type {
  GpuReview as GpuReviewData, LocalizedText, MetricGate, StageRunReport,
} from '../../lib/engineering/types';

export interface GpuReviewProps {
  projectTitle: LocalizedText;
  projectSummary: LocalizedText;
  stageTitle: LocalizedText;
  stageGoal: LocalizedText;
  stageIndex: number;
  stageCount: number;
  checklist?: LocalizedText[];
  gates?: MetricGate[];
  world: GpuWorld | null;
  history: CommandRecord[];
  sources: Record<string, string>;
  report: StageRunReport | null;
}

export default function GpuReview(props: GpuReviewProps) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  // locale 是宽字符串；门槛标签要按语言取，这里收窄一次
  const lang: 'en' | 'zh' = locale === 'en' ? 'en' : 'zh';
  const { config } = useAiConfig();

  const [review, setReview] = useState<GpuReviewData | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    world, history, sources, report, gates,
    projectTitle, projectSummary, stageTitle, stageGoal, stageIndex, stageCount, checklist,
  } = props;

  const handleRequest = useCallback(async () => {
    if (!world) {
      setError(t('gpulab.review.noWorld'));
      return;
    }

    setLoading(true);
    setError(null);
    setDraft('');

    try {
      const data = await requestStructuredStream<{ review: GpuReviewData }>(
        '/api/gpu-review',
        {
          language: locale,
          config,
          context: {
            projectTitle,
            projectSummary,
            stageIndex,
            stageCount,
            stageTitle,
            stageGoal,
            checklist,
            gates: gates?.map((gate) => ({
              metric: gate.metric, label: gate.label, op: gate.op, value: gate.value, unit: gate.unit,
            })),
            // 复盘要看完整的编译-测量-再改的过程，不是最近几条 ——
            // 「有没有先量再改」这件事就藏在命令的顺序里
            snapshot: buildGpuSnapshot(world, {
              sources, history, limits: GPU_SNAPSHOT_LIMITS.review,
            }),
            report: summarizeGpuReport(report, lang),
          },
        },
        { onDelta: (_chunk, full) => setDraft(full) }
      );
      setReview(data.review);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [
    config, locale, lang, world, sources, history, report, gates, t,
    projectTitle, projectSummary, stageTitle, stageGoal, stageIndex, stageCount, checklist,
  ]);

  const strings = useMemo<ReviewPanelStrings>(
    () => ({
      title: t('gpulab.review.title'),
      subtitle: t('gpulab.review.subtitle'),
      request: t('gpulab.review.request'),
      running: t('gpulab.review.running'),
      empty: t('gpulab.review.empty'),
      issues: t('gpulab.review.issues'),
      strengths: t('gpulab.review.strengths'),
      nextSteps: t('gpulab.review.nextSteps'),
      dimensionLabel: (key) => t(`gpulab.review.dimensions.${key}`),
    }),
    [t]
  );

  // where -> file：面板右上角那行小字，这里放的是代码位置或者计量名
  const data = useMemo<ReviewPanelData | null>(
    () =>
      review
        ? { ...review, issues: review.issues.map((issue) => ({ ...issue, file: issue.where })) }
        : null,
    [review]
  );

  return (
    <ReviewPanel
      review={data}
      loading={loading}
      error={error}
      draft={draft}
      onRequest={handleRequest}
      strings={strings}
    />
  );
}
