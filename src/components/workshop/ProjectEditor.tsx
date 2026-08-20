/**
 * 工程题编辑器
 *
 * 一道工程题是一棵深层嵌套的树：项目 → 关卡 → （起始文件、隐藏用例、
 * 指标门槛、lab 配置、参考实现）。直接编辑 JSON 是可行的，但那样作者需要
 * 自己记住二十几个字段名，而且一个逗号就能让整份题目变成语法错误。
 *
 * 所以这里按结构拆成表单，把「哪些字段存在、各自是什么意思」摆在界面上。
 */
import { useCallback, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Tabs,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconPlus, IconSparkles, IconTrash } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/I18nContext';
import { useWorkshopAssist } from '../../hooks/useWorkshopAssist';
import MarkdownRenderer from '../MarkdownRenderer';
import { CodeField } from './CodeField';
import { FileListEditor } from './FileListEditor';
import { LocalizedField } from './LocalizedField';
import { slugifyProblemId } from '../../lib/workshop/problem';
import { DIMENSION_KEYS, type EngineeringProject, type MetricGate, type ProjectStage } from '../../lib/engineering/types';

const GATE_OPERATORS: MetricGate['op'][] = ['lte', 'lt', 'gte', 'gt', 'eq'];

/** lab 采集的指标名。写错一个字门槛就永远是 0，所以给成下拉而不是自由输入。 */
const METRIC_PATHS = [
  'virtualElapsedMs',
  'maxConcurrency',
  'requests.total',
  'requests.ok',
  'requests.failed',
  'requests.throttled',
  'requests.retries',
  'requests.duplicated',
];

interface ProjectEditorProps {
  project: EngineeringProject;
  onChange: (project: EngineeringProject) => void;
  onReview: (notes: unknown, verdict?: string) => void;
  draftId: string;
}

export function ProjectEditor({ project, onChange, onReview, draftId }: ProjectEditorProps) {
  const { t } = useTranslation();
  const { run, running, error, clearError } = useWorkshopAssist();
  const [stageIndex, setStageIndex] = useState(0);
  const [stageRequest, setStageRequest] = useState('');
  const [previewLanguage, setPreviewLanguage] = useState<'zh' | 'en'>('zh');

  const patch = useCallback(
    (next: Partial<EngineeringProject>) => onChange({ ...project, ...next }),
    [project, onChange]
  );

  const stage = project.stages[stageIndex] as ProjectStage | undefined;

  const patchStage = useCallback(
    (next: Partial<ProjectStage>) => {
      patch({
        stages: project.stages.map((item, index) => (index === stageIndex ? { ...item, ...next } : item)),
      });
    },
    [project.stages, stageIndex, patch]
  );

  const addStage = useCallback(() => {
    const id = `stage-${project.stages.length + 1}`;
    patch({
      stages: [
        ...project.stages,
        {
          id,
          title: { en: `Stage ${project.stages.length + 1}`, zh: `第 ${project.stages.length + 1} 关` },
          goal: { en: '', zh: '' },
          specs: [],
          starterFiles: [],
          referenceFiles: [],
          gates: [],
          lab: {},
        },
      ],
    });
    setStageIndex(project.stages.length);
  }, [project.stages, patch]);

  const removeStage = useCallback(
    (index: number) => {
      patch({ stages: project.stages.filter((_, position) => position !== index) });
      setStageIndex((current) => Math.max(0, Math.min(current, project.stages.length - 2)));
    },
    [project.stages, patch]
  );

  /* ----------------------------- AI 动作 ----------------------------- */

  const review = useCallback(async () => {
    const result = await run<{ notes: unknown[]; verdict?: string }>({ action: 'review-project', project });
    if (result) onReview(result.notes || [], result.verdict);
  }, [run, project, onReview]);

  const draftStage = useCallback(async () => {
    const result = await run<ProjectStage>({
      action: 'draft-stage',
      project,
      instruction: stageRequest,
    });
    if (!result?.id) return;

    // AI 起的 id 可能和已有关卡撞车，撞了就换一个
    const taken = new Set(project.stages.map((item) => item.id));
    let id = slugifyProblemId(result.id);
    let counter = 2;
    while (taken.has(id)) {
      id = `${slugifyProblemId(result.id)}-${counter}`;
      counter += 1;
    }

    patch({ stages: [...project.stages, { ...result, id }] });
    setStageIndex(project.stages.length);
    setStageRequest('');
  }, [run, project, patch, stageRequest]);

  const busy = running !== null;

  const gateSummary = useMemo(
    () => (stage?.gates || []).length,
    [stage]
  );

  return (
    <Stack gap="md">
      {error && (
        <Alert color="red" withCloseButton onClose={clearError}>
          {error}
        </Alert>
      )}

      <Tabs defaultValue="basics">
        <Tabs.List>
          <Tabs.Tab value="basics">{t('workshop.tabBasics')}</Tabs.Tab>
          <Tabs.Tab value="brief">{t('workshop.tabBrief')}</Tabs.Tab>
          <Tabs.Tab value="files">{t('workshop.tabSharedFiles')}</Tabs.Tab>
          <Tabs.Tab value="stages">
            {t('workshop.tabStages')}
            <Badge size="xs" ml={6} variant="light">
              {project.stages.length}
            </Badge>
          </Tabs.Tab>
        </Tabs.List>

        {/* ------------------------------ 基本信息 ------------------------------ */}
        <Tabs.Panel value="basics" pt="md">
          <Stack gap="md">
            <Group grow align="flex-start">
              <TextInput
                label={t('addProblem.problemId')}
                value={project.id}
                onChange={(event) => patch({ id: event.currentTarget.value })}
                onBlur={(event) => patch({ id: slugifyProblemId(event.currentTarget.value) })}
              />
              <Select
                label={t('addProblem.difficulty')}
                allowDeselect={false}
                value={project.difficulty}
                onChange={(value) => patch({ difficulty: (value as EngineeringProject['difficulty']) || 'Medium' })}
                data={['Easy', 'Medium', 'Hard'].map((value) => ({
                  value,
                  label: t(`homepage.difficulty.${value}`),
                }))}
              />
              <Select
                label={t('workshop.workspaceLanguage')}
                allowDeselect={false}
                value={project.language}
                onChange={(value) => patch({ language: value === 'javascript' ? 'javascript' : 'typescript' })}
                data={[
                  { value: 'typescript', label: 'TypeScript' },
                  { value: 'javascript', label: 'JavaScript' },
                ]}
              />
            </Group>

            <LocalizedField label={t('addProblem.titles')} value={project.title} onChange={(title) => patch({ title })} />
            <LocalizedField
              label={t('workshop.summary')}
              value={project.summary}
              onChange={(summary) => patch({ summary })}
              multiline
              rows={2}
            />

            <Group grow align="flex-start">
              <TextInput
                label={t('workshop.domain')}
                description={t('workshop.domainHint')}
                value={project.domain}
                onChange={(event) => patch({ domain: event.currentTarget.value })}
              />
              <NumberInput
                label={t('workshop.estimatedMinutes')}
                value={project.estimatedMinutes ?? 60}
                min={10}
                max={600}
                onChange={(value) => patch({ estimatedMinutes: Number(value) || 60 })}
              />
            </Group>

            <TagsInput
              label={t('addProblem.tagsLabel')}
              value={project.tags}
              onChange={(tags) => patch({ tags })}
              maxTags={12}
            />

            <Group>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconSparkles size={14} />}
                loading={running === 'review-project'}
                disabled={busy}
                onClick={review}
              >
                {t('workshop.aiReviewAction')}
              </Button>
            </Group>
          </Stack>
        </Tabs.Panel>

        {/* ------------------------------- 需求 ------------------------------- */}
        <Tabs.Panel value="brief" pt="md">
          <Stack gap="md">
            <LocalizedField
              label={t('workshop.brief')}
              value={project.brief}
              onChange={(brief) => patch({ brief })}
              multiline
              rows={16}
            />
            <Card padding="md" withBorder>
              <Group justify="space-between" mb="xs">
                <Text size="sm" fw={500}>
                  {t('workshop.preview')}
                </Text>
                <Select
                  size="xs"
                  w={110}
                  allowDeselect={false}
                  value={previewLanguage}
                  onChange={(value) => setPreviewLanguage(value === 'en' ? 'en' : 'zh')}
                  data={[
                    { value: 'zh', label: '中文' },
                    { value: 'en', label: 'English' },
                  ]}
                />
              </Group>
              <MarkdownRenderer content={project.brief[previewLanguage] || ''} />
            </Card>
          </Stack>
        </Tabs.Panel>

        {/* ----------------------------- 公共文件 ----------------------------- */}
        <Tabs.Panel value="files" pt="md">
          <FileListEditor
            label={t('workshop.sharedFiles')}
            hint={t('workshop.sharedFilesHint')}
            namespace={`${draftId}/shared`}
            language={project.language}
            files={project.files}
            onChange={(files) => patch({ files })}
            showFlags
            newFilePath="src/contract"
          />
        </Tabs.Panel>

        {/* ------------------------------- 关卡 ------------------------------- */}
        <Tabs.Panel value="stages" pt="md">
          <Stack gap="md">
            <Group justify="space-between" wrap="wrap">
              <Group gap={6} wrap="wrap">
                {project.stages.map((item, index) => (
                  <Button
                    key={item.id}
                    size="compact-xs"
                    variant={index === stageIndex ? 'filled' : 'default'}
                    onClick={() => setStageIndex(index)}
                  >
                    {index + 1}. {item.title.zh || item.title.en || item.id}
                  </Button>
                ))}
              </Group>
              <Group gap="xs">
                <Button size="compact-xs" variant="light" leftSection={<IconPlus size={13} />} onClick={addStage}>
                  {t('workshop.addStage')}
                </Button>
                {project.stages.length > 1 && (
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    onClick={() => removeStage(stageIndex)}
                    aria-label={t('workshop.removeStage')}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                )}
              </Group>
            </Group>

            <Card padding="md" withBorder>
              <Group gap="xs" align="flex-end">
                <Textarea
                  flex={1}
                  size="xs"
                  autosize
                  minRows={1}
                  label={t('workshop.aiDraftStage')}
                  description={t('workshop.aiDraftStageHint')}
                  value={stageRequest}
                  onChange={(event) => setStageRequest(event.currentTarget.value)}
                />
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconSparkles size={14} />}
                  loading={running === 'draft-stage'}
                  disabled={busy}
                  onClick={draftStage}
                >
                  {t('workshop.generate')}
                </Button>
              </Group>
            </Card>

            {stage && (
              <Stack gap="md">
                <Group grow align="flex-start">
                  <TextInput
                    label={t('workshop.stageId')}
                    value={stage.id}
                    onChange={(event) => patchStage({ id: event.currentTarget.value })}
                  />
                </Group>

                <LocalizedField
                  label={t('workshop.stageTitle')}
                  value={stage.title}
                  onChange={(title) => patchStage({ title })}
                />
                <LocalizedField
                  label={t('workshop.stageGoal')}
                  value={stage.goal}
                  onChange={(goal) => patchStage({ goal })}
                  multiline
                  rows={8}
                />

                <FileListEditor
                  label={t('workshop.starterFiles')}
                  hint={t('workshop.starterFilesHint')}
                  namespace={`${draftId}/${stage.id}/starter`}
                  language={project.language}
                  files={stage.starterFiles || []}
                  onChange={(starterFiles) => patchStage({ starterFiles })}
                  showFlags
                  newFilePath="src/module"
                />

                <FileListEditor
                  label={t('workshop.specs')}
                  hint={t('workshop.specsHint')}
                  namespace={`${draftId}/${stage.id}/spec`}
                  language={project.language}
                  files={stage.specs}
                  onChange={(specs) => patchStage({ specs: specs.map(({ path, content }) => ({ path, content })) })}
                  newFilePath="spec/stage"
                />

                <FileListEditor
                  label={t('workshop.referenceFiles')}
                  hint={t('workshop.referenceFilesHint')}
                  namespace={`${draftId}/${stage.id}/reference`}
                  language={project.language}
                  files={stage.referenceFiles || []}
                  onChange={(referenceFiles) => patchStage({ referenceFiles })}
                  newFilePath="src/module"
                />

                <Card padding="md" withBorder>
                  <Stack gap="xs">
                    <Group justify="space-between">
                      <Stack gap={0}>
                        <Text size="sm" fw={500}>
                          {t('workshop.gates')}
                          <Badge size="xs" ml={6} variant="light">
                            {gateSummary}
                          </Badge>
                        </Text>
                        <Text size="xs" c="dimmed">
                          {t('workshop.gatesHint')}
                        </Text>
                      </Stack>
                      <Button
                        size="compact-xs"
                        variant="light"
                        leftSection={<IconPlus size={13} />}
                        onClick={() =>
                          patchStage({
                            gates: [
                              ...(stage.gates || []),
                              {
                                metric: 'maxConcurrency',
                                op: 'lte',
                                value: 4,
                                label: { en: 'Peak concurrency at most 4', zh: '峰值并发不超过 4' },
                                dimension: 'concurrency',
                              },
                            ],
                          })
                        }
                      >
                        {t('workshop.addGate')}
                      </Button>
                    </Group>

                    {(stage.gates || []).length > 0 && (
                      <Table withTableBorder withColumnBorders>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>{t('workshop.gateMetric')}</Table.Th>
                            <Table.Th w={90}>{t('workshop.gateOp')}</Table.Th>
                            <Table.Th w={100}>{t('workshop.gateValue')}</Table.Th>
                            <Table.Th w={140}>{t('workshop.gateDimension')}</Table.Th>
                            <Table.Th w={44} />
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {(stage.gates || []).map((gate, index) => {
                            const updateGate = (next: Partial<MetricGate>) =>
                              patchStage({
                                gates: (stage.gates || []).map((item, position) =>
                                  position === index ? { ...item, ...next } : item
                                ),
                              });

                            return (
                              <Table.Tr key={index}>
                                <Table.Td>
                                  <Select
                                    size="xs"
                                    variant="unstyled"
                                    searchable
                                    allowDeselect={false}
                                    value={gate.metric}
                                    onChange={(value) => updateGate({ metric: value || gate.metric })}
                                    data={Array.from(new Set([...METRIC_PATHS, gate.metric]))}
                                  />
                                </Table.Td>
                                <Table.Td>
                                  <Select
                                    size="xs"
                                    variant="unstyled"
                                    allowDeselect={false}
                                    value={gate.op}
                                    onChange={(value) => updateGate({ op: (value as MetricGate['op']) || 'lte' })}
                                    data={GATE_OPERATORS}
                                  />
                                </Table.Td>
                                <Table.Td>
                                  <NumberInput
                                    size="xs"
                                    variant="unstyled"
                                    value={gate.value}
                                    onChange={(value) => updateGate({ value: Number(value) || 0 })}
                                  />
                                </Table.Td>
                                <Table.Td>
                                  <Select
                                    size="xs"
                                    variant="unstyled"
                                    clearable
                                    value={gate.dimension || null}
                                    onChange={(value) => updateGate({ dimension: (value as any) || undefined })}
                                    data={DIMENSION_KEYS as unknown as string[]}
                                  />
                                </Table.Td>
                                <Table.Td>
                                  <ActionIcon
                                    variant="subtle"
                                    color="red"
                                    size="sm"
                                    onClick={() =>
                                      patchStage({
                                        gates: (stage.gates || []).filter((_, position) => position !== index),
                                      })
                                    }
                                    aria-label={t('workshop.removeGate')}
                                  >
                                    <IconTrash size={14} />
                                  </ActionIcon>
                                </Table.Td>
                              </Table.Tr>
                            );
                          })}
                        </Table.Tbody>
                      </Table>
                    )}
                  </Stack>
                </Card>

                <CodeField
                  label={t('workshop.labConfig')}
                  hint={t('workshop.labConfigHint')}
                  path={`workshop:///${draftId}/${stage.id}/lab.json`}
                  language="json"
                  height={160}
                  value={JSON.stringify(stage.lab || {}, null, 2)}
                  onChange={(value) => {
                    // 编辑过程中 JSON 必然会短暂不合法，解析失败就先不动状态，
                    // 等用户把括号补齐。硬报错只会让人没法打字。
                    try {
                      patchStage({ lab: JSON.parse(value || '{}') });
                    } catch {
                      /* 等一个合法的 JSON */
                    }
                  }}
                />
              </Stack>
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

export default ProjectEditor;
