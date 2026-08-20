/**
 * 算法题编辑器
 *
 * 四块内容：基本信息、题面、代码、测试用例。每一块旁边挂着对应的 AI 动作，
 * 而不是把所有 AI 功能堆成一个「智能助手」按钮 —— 出题人需要的是「帮我把
 * 这段题面写清楚」，不是「帮我做点什么」。
 *
 * 所有 AI 结果都进入一个待确认状态，采纳与否由作者决定。
 */
import { useCallback, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Select,
  Stack,
  Table,
  Tabs,
  TagsInput,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconLanguage,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconWand,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/I18nContext';
import { useWorkshopAssist } from '../../hooks/useWorkshopAssist';
import MarkdownRenderer from '../MarkdownRenderer';
import { CodeField } from './CodeField';
import { LocalizedField } from './LocalizedField';
import {
  PROBLEM_DIFFICULTIES,
  PROBLEM_LANGUAGES,
  slugifyProblemId,
  type AlgorithmProblem,
  type ProblemLanguage,
} from '../../lib/workshop/problem';

const MONACO_LANGUAGE: Record<ProblemLanguage, string> = {
  js: 'javascript',
  python: 'python',
  java: 'java',
  cpp: 'cpp',
  c: 'c',
};

const LANGUAGE_LABELS: Record<ProblemLanguage, string> = {
  js: 'JavaScript',
  python: 'Python',
  java: 'Java',
  cpp: 'C++',
  c: 'C',
};

interface ProblemEditorProps {
  problem: AlgorithmProblem;
  onChange: (problem: AlgorithmProblem) => void;
  onReview: (notes: unknown, verdict?: string) => void;
  /** 草稿的稳定 id，用来给 Monaco 的 model path 加前缀 */
  draftId: string;
}

export function ProblemEditor({ problem, onChange, onReview, draftId }: ProblemEditorProps) {
  const { t } = useTranslation();
  const { run, running, error, clearError } = useWorkshopAssist();
  const [codeLanguage, setCodeLanguage] = useState<ProblemLanguage>('js');
  const [previewLanguage, setPreviewLanguage] = useState<'zh' | 'en'>('zh');
  const [assistNote, setAssistNote] = useState<string | null>(null);

  const patch = useCallback(
    (next: Partial<AlgorithmProblem>) => onChange({ ...problem, ...next }),
    [problem, onChange]
  );

  const setTest = useCallback(
    (index: number, field: 'input' | 'output', value: string) => {
      const tests = problem.tests.map((testCase, position) =>
        position === index ? { ...testCase, [field]: value } : testCase
      );
      patch({ tests });
    },
    [problem.tests, patch]
  );

  /* ----------------------------- AI 动作 ----------------------------- */

  const polish = useCallback(async () => {
    const result = await run<{ description: AlgorithmProblem['description'] }>({
      action: 'polish-statement',
      problem,
    });
    if (result?.description) patch({ description: result.description });
  }, [run, problem, patch]);

  const translate = useCallback(async () => {
    const result = await run<{ title?: AlgorithmProblem['title']; description?: AlgorithmProblem['description'] }>({
      action: 'translate',
      problem,
    });
    if (result) {
      patch({
        title: result.title || problem.title,
        description: result.description || problem.description,
      });
    }
  }, [run, problem, patch]);

  const suggestMetadata = useCallback(async () => {
    const result = await run<{ tags: string[]; difficulty: AlgorithmProblem['difficulty']; reason: string }>({
      action: 'suggest-metadata',
      problem,
    });
    if (result) {
      patch({ tags: result.tags || problem.tags, difficulty: result.difficulty || problem.difficulty });
      setAssistNote(result.reason || null);
    }
  }, [run, problem, patch]);

  const generateTests = useCallback(async () => {
    const result = await run<{ tests: Array<{ input: string; output: string; why?: string }> }>({
      action: 'generate-tests',
      problem,
    });
    if (!result?.tests?.length) return;

    // 追加而不是替换：作者手写的用例是这道题的定义，AI 只能补充
    const existing = new Set(problem.tests.map((testCase) => `${testCase.input}=>${testCase.output}`));
    const additions = result.tests
      .filter((testCase) => testCase.input && testCase.output)
      .filter((testCase) => !existing.has(`${testCase.input}=>${testCase.output}`))
      .map((testCase) => ({ input: testCase.input, output: testCase.output }));

    patch({ tests: [...problem.tests, ...additions] });
    setAssistNote(t('workshop.testsAdded', { count: additions.length }));
  }, [run, problem, patch, t]);

  const generateSolution = useCallback(async () => {
    const result = await run<{ code: string; complexity?: { time: string; space: string }; notes?: string }>({
      action: 'generate-solution',
      problem,
      codeLanguage,
    });
    if (result?.code) {
      patch({ solution: { ...(problem.solution || {}), [codeLanguage]: result.code } });
      setAssistNote(
        result.complexity ? `${result.complexity.time} / ${result.complexity.space}` : result.notes || null
      );
    }
  }, [run, problem, patch, codeLanguage]);

  const generateTemplates = useCallback(async () => {
    const result = await run<{ template: Record<string, string> }>({
      action: 'generate-templates',
      problem,
    });
    if (result?.template) patch({ template: { ...problem.template, ...result.template } });
  }, [run, problem, patch]);

  const review = useCallback(async () => {
    const result = await run<{ notes: unknown[]; verdict?: string }>({ action: 'review-problem', problem });
    if (result) onReview(result.notes || [], result.verdict);
  }, [run, problem, onReview]);

  const busy = running !== null;

  const testStats = useMemo(
    () => ({
      total: problem.tests.length,
      empty: problem.tests.filter((testCase) => !testCase.input.trim() || !testCase.output.trim()).length,
    }),
    [problem.tests]
  );

  return (
    <Stack gap="md">
      {error && (
        <Alert color="red" withCloseButton onClose={clearError}>
          {error}
        </Alert>
      )}
      {assistNote && (
        <Alert color="blue" withCloseButton onClose={() => setAssistNote(null)}>
          <Text size="sm">{assistNote}</Text>
        </Alert>
      )}

      <Tabs defaultValue="basics">
        <Tabs.List>
          <Tabs.Tab value="basics">{t('workshop.tabBasics')}</Tabs.Tab>
          <Tabs.Tab value="statement">{t('workshop.tabStatement')}</Tabs.Tab>
          <Tabs.Tab value="code">{t('workshop.tabCode')}</Tabs.Tab>
          <Tabs.Tab value="tests">
            {t('workshop.tabTests')}
            <Badge size="xs" ml={6} variant="light" color={testStats.empty ? 'red' : 'gray'}>
              {testStats.total}
            </Badge>
          </Tabs.Tab>
        </Tabs.List>

        {/* ------------------------------ 基本信息 ------------------------------ */}
        <Tabs.Panel value="basics" pt="md">
          <Stack gap="md">
            <Group grow align="flex-start">
              <TextInput
                label={t('addProblem.problemId')}
                description={t('addProblem.problemIdHint')}
                value={problem.id}
                onChange={(event) => patch({ id: event.currentTarget.value })}
                onBlur={(event) => patch({ id: slugifyProblemId(event.currentTarget.value) })}
              />
              <Select
                label={t('addProblem.difficulty')}
                data={PROBLEM_DIFFICULTIES.map((value) => ({
                  value,
                  label: t(`homepage.difficulty.${value}`),
                }))}
                value={problem.difficulty}
                allowDeselect={false}
                onChange={(value) => patch({ difficulty: (value as AlgorithmProblem['difficulty']) || 'Medium' })}
              />
            </Group>

            <LocalizedField
              label={t('addProblem.titles')}
              value={problem.title}
              onChange={(title) => patch({ title })}
            />

            <TagsInput
              label={t('addProblem.tagsLabel')}
              placeholder={t('addProblem.tagsPlaceholder')}
              value={problem.tags}
              onChange={(tags) => patch({ tags })}
              maxTags={12}
            />

            <Group>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconSparkles size={14} />}
                loading={running === 'suggest-metadata'}
                disabled={busy}
                onClick={suggestMetadata}
              >
                {t('workshop.aiSuggestMetadata')}
              </Button>
            </Group>

            <Card padding="md" withBorder>
              <Stack gap="xs">
                <Group justify="space-between">
                  <Text size="sm" fw={500}>
                    {t('problemPage.examples')}
                  </Text>
                  <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconPlus size={13} />}
                    onClick={() => patch({ examples: [...problem.examples, { input: '', output: '' }] })}
                  >
                    {t('addProblem.addTestCase')}
                  </Button>
                </Group>

                {problem.examples.map((example, index) => (
                  <Group key={index} gap="xs" wrap="nowrap" align="flex-start">
                    <TextInput
                      flex={1}
                      size="xs"
                      placeholder={t('problemPage.input')}
                      value={example.input}
                      onChange={(event) =>
                        patch({
                          examples: problem.examples.map((item, position) =>
                            position === index ? { ...item, input: event.currentTarget.value } : item
                          ),
                        })
                      }
                    />
                    <TextInput
                      flex={1}
                      size="xs"
                      placeholder={t('problemPage.output')}
                      value={example.output}
                      onChange={(event) =>
                        patch({
                          examples: problem.examples.map((item, position) =>
                            position === index ? { ...item, output: event.currentTarget.value } : item
                          ),
                        })
                      }
                    />
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="sm"
                      onClick={() =>
                        patch({ examples: problem.examples.filter((_, position) => position !== index) })
                      }
                      aria-label={t('addProblem.removeTestCase')}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                ))}
              </Stack>
            </Card>
          </Stack>
        </Tabs.Panel>

        {/* ------------------------------- 题面 ------------------------------- */}
        <Tabs.Panel value="statement" pt="md">
          <Stack gap="md">
            <Group>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconWand size={14} />}
                loading={running === 'polish-statement'}
                disabled={busy}
                onClick={polish}
              >
                {t('workshop.aiPolish')}
              </Button>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconLanguage size={14} />}
                loading={running === 'translate'}
                disabled={busy}
                onClick={translate}
              >
                {t('workshop.aiTranslate')}
              </Button>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconSparkles size={14} />}
                loading={running === 'review-problem'}
                disabled={busy}
                onClick={review}
              >
                {t('workshop.aiReviewAction')}
              </Button>
            </Group>

            <LocalizedField
              label={t('addProblem.descriptions')}
              value={problem.description}
              onChange={(description) => patch({ description })}
              multiline
              rows={14}
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
              <MarkdownRenderer content={problem.description[previewLanguage] || ''} />
            </Card>
          </Stack>
        </Tabs.Panel>

        {/* ------------------------------- 代码 ------------------------------- */}
        <Tabs.Panel value="code" pt="md">
          <Stack gap="md">
            <Group justify="space-between">
              <Select
                size="xs"
                w={150}
                allowDeselect={false}
                value={codeLanguage}
                onChange={(value) => setCodeLanguage((value as ProblemLanguage) || 'js')}
                data={PROBLEM_LANGUAGES.map((value) => ({ value, label: LANGUAGE_LABELS[value] }))}
              />
              <Group gap="xs">
                <Tooltip label={t('workshop.aiTemplatesHint')}>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconSparkles size={14} />}
                    loading={running === 'generate-templates'}
                    disabled={busy}
                    onClick={generateTemplates}
                  >
                    {t('workshop.aiTemplates')}
                  </Button>
                </Tooltip>
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconSparkles size={14} />}
                  loading={running === 'generate-solution'}
                  disabled={busy}
                  onClick={generateSolution}
                >
                  {t('workshop.aiSolution')}
                </Button>
              </Group>
            </Group>

            <CodeField
              label={t('workshop.template')}
              hint={t('workshop.templateHint')}
              path={`workshop:///${draftId}/template.${codeLanguage}`}
              language={MONACO_LANGUAGE[codeLanguage]}
              value={problem.template[codeLanguage] || ''}
              onChange={(value) => patch({ template: { ...problem.template, [codeLanguage]: value } })}
              height={220}
            />

            <CodeField
              label={t('workshop.solution')}
              hint={t('workshop.solutionHint')}
              path={`workshop:///${draftId}/solution.${codeLanguage}`}
              language={MONACO_LANGUAGE[codeLanguage]}
              value={problem.solution?.[codeLanguage] || ''}
              onChange={(value) => patch({ solution: { ...(problem.solution || {}), [codeLanguage]: value } })}
              height={260}
            />
          </Stack>
        </Tabs.Panel>

        {/* ------------------------------ 测试用例 ------------------------------ */}
        <Tabs.Panel value="tests" pt="md">
          <Stack gap="md">
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                {t('workshop.testsHint')}
              </Text>
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconSparkles size={14} />}
                  loading={running === 'generate-tests'}
                  disabled={busy}
                  onClick={generateTests}
                >
                  {t('workshop.aiTests')}
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconPlus size={14} />}
                  onClick={() => patch({ tests: [...problem.tests, { input: '', output: '' }] })}
                >
                  {t('addProblem.addTestCase')}
                </Button>
              </Group>
            </Group>

            <Table withTableBorder withColumnBorders striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={40}>#</Table.Th>
                  <Table.Th>{t('addProblem.input')}</Table.Th>
                  <Table.Th>{t('addProblem.expectedOutput')}</Table.Th>
                  <Table.Th w={50} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {problem.tests.map((testCase, index) => (
                  <Table.Tr key={index}>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {index + 1}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <TextInput
                        size="xs"
                        variant="unstyled"
                        ff="monospace"
                        value={testCase.input}
                        onChange={(event) => setTest(index, 'input', event.currentTarget.value)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <TextInput
                        size="xs"
                        variant="unstyled"
                        ff="monospace"
                        value={testCase.output}
                        onChange={(event) => setTest(index, 'output', event.currentTarget.value)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        onClick={() => patch({ tests: problem.tests.filter((_, position) => position !== index) })}
                        aria-label={t('addProblem.removeTestCase')}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

export default ProblemEditor;
