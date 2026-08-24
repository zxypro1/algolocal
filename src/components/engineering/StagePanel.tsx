import { useState } from 'react';
import { Alert, Badge, Button, Card, Collapse, Group, List, Modal, Stack, Text, ThemeIcon } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBook2,
  IconBulb,
  IconChevronDown,
  IconChevronUp,
  IconCircleCheck,
  IconCircleDashed,
  IconLock,
  IconTrophy,
  IconX,
} from '@tabler/icons-react';
import { useI18n, useTranslation } from '../../contexts/I18nContext';
import MarkdownRenderer from '../MarkdownRenderer';
import { CodeWithCopy } from '../CodeWithCopy';
import type { LocalizedText, ProjectStage } from '../../lib/engineering/types';

interface StagePanelProps {
  stage: ProjectStage;
  stageIndex: number;
  stageCount: number;
  completed: boolean;
  revealedHints: number;
  onRevealHint: () => void;
  onAdvance: () => void;
  hasNextStage: boolean;
}

export default function StagePanel({
  stage,
  stageIndex,
  stageCount,
  completed,
  revealedHints,
  onRevealHint,
  onAdvance,
  hasNextStage,
}: StagePanelProps) {
  const { t } = useTranslation();

  /**
   * 参考实现的「已确认查看」只记在这一关、这一次停留里。
   * 不写进进度存档：确认的意思是「我现在想看这一关的解法」，
   * 不是「以后所有关卡都别再问我」—— 后者会让这道确认形同虚设。
   * 组件按 stage.id 做了 key，换关卡即重新挂载，状态自然归零。
   */
  const [revealed, setRevealed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { locale } = useI18n();
  const [extensionOpen, setExtensionOpen] = useState(false);

  const pick = (text: LocalizedText | undefined) =>
    !text ? '' : text[locale as 'en' | 'zh'] || text.zh || text.en || '';

  const hints = stage.hints || [];
  const visibleHints = hints.slice(0, revealedHints);

  return (
    <Stack gap="md">
      <Group gap="xs">
        <Badge variant="light" color={completed ? 'teal' : 'brand'}>
          {t('engineering.stage.label', { current: stageIndex + 1, total: stageCount })}
        </Badge>
        {completed && (
          <Badge variant="filled" color="teal" leftSection={<IconTrophy size={11} />}>
            {t('engineering.stage.cleared')}
          </Badge>
        )}
      </Group>

      {stage.primer && pick(stage.primer) && (
        <Card withBorder radius="lg" padding="lg" bg="var(--mantine-color-blue-light)">
          <Group gap={6} mb={4}>
            <IconBook2 size={16} />
            <Text size="sm" fw={600}>
              {t('engineering.stage.primer')}
            </Text>
          </Group>
          <Text size="xs" c="dimmed" mb="sm">
            {t('engineering.stage.primerHint')}
          </Text>
          <MarkdownRenderer content={pick(stage.primer)} />
        </Card>
      )}

      <Card withBorder radius="lg" padding="lg">
        <Text size="sm" fw={600} mb={8}>
          {t('engineering.stage.goal')}
        </Text>
        <MarkdownRenderer content={pick(stage.goal)} />
      </Card>

      {stage.checklist && stage.checklist.length > 0 && (
        <Card withBorder radius="lg" padding="md">
          <Text size="sm" fw={600} mb={8}>
            {t('engineering.stage.checklist')}
          </Text>
          <List
            size="sm"
            spacing={6}
            icon={
              <ThemeIcon size={18} radius="xl" variant="light" color={completed ? 'teal' : 'gray'}>
                {completed ? <IconCircleCheck size={12} /> : <IconCircleDashed size={12} />}
              </ThemeIcon>
            }
          >
            {stage.checklist.map((item, index) => (
              <List.Item key={index}>{pick(item)}</List.Item>
            ))}
          </List>
        </Card>
      )}

      {stage.pitfalls && stage.pitfalls.length > 0 && (
        <Card withBorder radius="lg" padding="md">
          <Group gap={6} mb={8}>
            <IconAlertTriangle size={15} color="var(--mantine-color-orange-filled)" />
            <Text size="sm" fw={600}>
              {t('engineering.stage.pitfalls')}
            </Text>
          </Group>
          <Text size="xs" c="dimmed" mb={10}>
            {t('engineering.stage.pitfallsHint')}
          </Text>
          <Stack gap={8}>
            {stage.pitfalls.map((pitfall, index) => (
              <Group key={index} gap={8} align="flex-start" wrap="nowrap">
                <ThemeIcon size={18} radius="xl" variant="light" color="orange">
                  <IconX size={11} />
                </ThemeIcon>
                <Text size="xs" style={{ flex: 1 }}>
                  {pick(pitfall)}
                </Text>
              </Group>
            ))}
          </Stack>
        </Card>
      )}

      {hints.length > 0 && (
        <Card withBorder radius="lg" padding="md">
          <Group justify="space-between" mb={visibleHints.length ? 8 : 0}>
            <Group gap={6}>
              <IconBulb size={15} />
              <Text size="sm" fw={600}>
                {t('engineering.stage.hints')}
              </Text>
            </Group>
            {revealedHints < hints.length && (
              <Button size="compact-xs" variant="light" onClick={onRevealHint}>
                {t('engineering.stage.revealHint', {
                  current: revealedHints + 1,
                  total: hints.length,
                })}
              </Button>
            )}
          </Group>
          <Stack gap={6}>
            {visibleHints.map((hint, index) => (
              <Alert key={index} color="yellow" variant="light" p="xs">
                <Text size="xs">{pick(hint)}</Text>
              </Alert>
            ))}
          </Stack>
        </Card>
      )}

      {stage.extension && (
        <Card withBorder radius="lg" padding="md">
          <Group
            gap={6}
            mb={extensionOpen ? 10 : 0}
            style={{ cursor: 'pointer' }}
            onClick={() => setExtensionOpen((open) => !open)}
          >
            <IconBook2 size={15} />
            <Text size="sm" fw={600} style={{ flex: 1 }}>
              {t('engineering.stage.extension')}
            </Text>
            {extensionOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
          </Group>
          <Collapse in={extensionOpen}>
            <MarkdownRenderer content={pick(stage.extension)} />
          </Collapse>
        </Card>
      )}

      {/*
        没通关也能看参考实现，但要按一下「确定要看解法吗」。
        通关之后不再问 —— 那时已经没什么可剧透的了。
      */}
      {!completed && stage.referenceFiles && stage.referenceFiles.length > 0 && !revealed && (
        <Group justify="center" py="sm">
          <Button variant="subtle" size="compact-sm" color="gray"
            leftSection={<IconLock size={13} />}
            onClick={() => setConfirmOpen(true)}>
            {t('engineering.stage.revealReference')}
          </Button>
        </Group>
      )}

      <Modal opened={confirmOpen} onClose={() => setConfirmOpen(false)}
        title={t('engineering.stage.revealTitle')} size="sm" centered>
        <Text size="sm" mb="md">{t('engineering.stage.revealBody')}</Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" size="compact-sm" onClick={() => setConfirmOpen(false)}>
            {t('engineering.stage.revealCancel')}
          </Button>
          <Button color="orange" size="compact-sm"
            onClick={() => { setRevealed(true); setConfirmOpen(false); }}>
            {t('engineering.stage.revealConfirm')}
          </Button>
        </Group>
      </Modal>

      {(completed || revealed) && stage.referenceFiles && stage.referenceFiles.length > 0 && (
        <Card withBorder radius="lg" padding="md">
          <Text size="sm" fw={600} mb={8}>
            {t('engineering.stage.reference')}
          </Text>
          {stage.referenceNotes && (
            <Text size="xs" c="dimmed" mb={10}>
              {pick(stage.referenceNotes)}
            </Text>
          )}
          <Stack gap={10}>
            {stage.referenceFiles.map((file) => (
              <Stack key={file.path} gap={4}>
                <Text size="xs" ff="monospace" c="dimmed">
                  {file.path}
                </Text>
                <CodeWithCopy code={file.content} />
              </Stack>
            ))}
          </Stack>
        </Card>
      )}


      {completed && hasNextStage && (
        <Button fullWidth color="teal" onClick={onAdvance}>
          {t('engineering.stage.next')}
        </Button>
      )}
    </Stack>
  );
}
