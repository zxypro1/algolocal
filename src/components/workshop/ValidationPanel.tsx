import { Alert, Badge, Group, List, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconExclamationCircle } from '@tabler/icons-react';
import { useI18n, useTranslation } from '../../contexts/I18nContext';
import type { ValidationIssue } from '../../lib/workshop/problem';

export interface ReviewNote {
  severity: 'blocker' | 'major' | 'minor';
  field: string;
  message: string;
  suggestion?: string;
}

interface ValidationPanelProps {
  /** 结构校验的结果，本地算出来的，不需要网络 */
  issues?: ValidationIssue[];
  /** AI 评审的结果 */
  notes?: ReviewNote[];
  verdict?: string;
}

const NOTE_COLORS: Record<ReviewNote['severity'], string> = {
  blocker: 'red',
  major: 'orange',
  minor: 'gray',
};

/**
 * 校验结果。
 *
 * 结构问题和 AI 评审分开显示，因为它们的可信度不同：前者是确定的
 * （没有测试用例就是没有测试用例），后者是建议，可能说错。
 */
export function ValidationPanel({ issues = [], notes = [], verdict }: ValidationPanelProps) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const language = locale === 'en' ? 'en' : 'zh';

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  if (!issues.length && !notes.length && !verdict) {
    return (
      <Alert color="green" icon={<IconCircleCheck size={16} />}>
        <Text size="sm">{t('workshop.validationClean')}</Text>
      </Alert>
    );
  }

  return (
    <Stack gap="sm">
      {errors.length > 0 && (
        <Alert color="red" icon={<IconExclamationCircle size={16} />} title={t('workshop.blockingIssues')}>
          <List size="sm" spacing={4}>
            {errors.map((issue, index) => (
              <List.Item key={`${issue.field}-${index}`}>
                <Text size="sm" span fw={500}>
                  {issue.field}
                </Text>
                {' — '}
                {issue.message[language]}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}

      {warnings.length > 0 && (
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title={t('workshop.warnings')}>
          <List size="sm" spacing={4}>
            {warnings.map((issue, index) => (
              <List.Item key={`${issue.field}-${index}`}>
                <Text size="sm" span fw={500}>
                  {issue.field}
                </Text>
                {' — '}
                {issue.message[language]}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}

      {(notes.length > 0 || verdict) && (
        <Alert color="blue" title={t('workshop.aiReview')}>
          <Stack gap="xs">
            {verdict && <Text size="sm">{verdict}</Text>}
            {notes.map((note, index) => (
              <Group key={index} gap="xs" align="flex-start" wrap="nowrap">
                <Badge size="xs" color={NOTE_COLORS[note.severity]} variant="light">
                  {note.severity}
                </Badge>
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Text size="sm">
                    <Text span fw={500} size="sm">
                      {note.field}
                    </Text>
                    {' — '}
                    {note.message}
                  </Text>
                  {note.suggestion && (
                    <Text size="xs" c="dimmed">
                      {note.suggestion}
                    </Text>
                  )}
                </Stack>
              </Group>
            ))}
          </Stack>
        </Alert>
      )}
    </Stack>
  );
}

export default ValidationPanel;
