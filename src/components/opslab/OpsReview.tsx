/**
 * ops 工作台的 AI 复盘
 *
 * 和代码形态的评审并列，但评的东西完全不同：那边评「这段代码能不能合」，
 * 这边评「这一关他是怎么操作过来的」—— 学员没写代码，他敲了一串命令、
 * 改了几个 manifest，把集群从坏改到好。
 *
 * 它放在左栏「验收」旁边而不是右栏：右栏是干活的地方（终端、IDE、拓扑），
 * 左栏是读长文的地方，而复盘正是一篇要从头读到尾的长文。
 *
 * 排版直接复用代码形态那个 ReviewPanel —— 总结 + 维度分 + 问题 + 亮点 + 下一步
 * 是同一套结构，只是维度和文案换了一套。
 */
import { useCallback, useMemo, useState } from 'react';
import { useI18n, useTranslation } from '../../contexts/I18nContext';
import { useAiConfig } from '../../hooks/useAiConfig';
import { requestStructuredStream } from '../../lib/streamRequest';
import ReviewPanel from '../engineering/ReviewPanel';
import type { ReviewPanelData, ReviewPanelStrings } from '../engineering/ReviewPanel';
import { buildOpsSnapshot, summarizeReport, SNAPSHOT_LIMITS } from '../../lib/opslab/lab';
import type { OpsWorld } from '../../lib/opslab/lab';
import type { CommandRecord } from '../../lib/labkit/machine';
import type { LocalizedText, OpsReview as OpsReviewData, StageRunReport } from '../../lib/engineering/types';

export interface OpsReviewProps {
  projectTitle: LocalizedText;
  projectSummary: LocalizedText;
  stageTitle: LocalizedText;
  stageGoal: LocalizedText;
  stageIndex: number;
  stageCount: number;
  checklist?: LocalizedText[];
  world: OpsWorld | null;
  history: CommandRecord[];
  namespace: string;
  files: Record<string, string>;
  report: StageRunReport | null;
}

export default function OpsReview(props: OpsReviewProps) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const { config } = useAiConfig();

  const [review, setReview] = useState<OpsReviewData | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    world, history, namespace, files, report,
    projectTitle, projectSummary, stageTitle, stageGoal, stageIndex, stageCount, checklist,
  } = props;

  const handleRequest = useCallback(async () => {
    if (!world) {
      setError(t('opslab.review.noWorld'));
      return;
    }

    setLoading(true);
    setError(null);
    setDraft('');

    try {
      const data = await requestStructuredStream<{ review: OpsReviewData }>(
        '/api/ops-review',
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
            // 复盘要看整条排查路径，不是最近几条 —— 命令的顺序本身就是被评的东西
            snapshot: buildOpsSnapshot(world, {
              files, history, namespace, limits: SNAPSHOT_LIMITS.review,
            }),
            report: summarizeReport(report),
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
    config, locale, world, files, history, namespace, report, t,
    projectTitle, projectSummary, stageTitle, stageGoal, stageIndex, stageCount, checklist,
  ]);

  const strings = useMemo<ReviewPanelStrings>(
    () => ({
      title: t('opslab.review.title'),
      subtitle: t('opslab.review.subtitle'),
      request: t('opslab.review.request'),
      running: t('opslab.review.running'),
      empty: t('opslab.review.empty'),
      issues: t('opslab.review.issues'),
      strengths: t('opslab.review.strengths'),
      nextSteps: t('opslab.review.nextSteps'),
      dimensionLabel: (key) => t(`opslab.review.dimensions.${key}`),
    }),
    [t]
  );

  // where -> file：面板右上角那行小字，代码形态放文件名，这里放命令或对象
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
