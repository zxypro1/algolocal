/**
 * 设置页里的云端一栏
 *
 * 两个开关：要不要用云端，以及用哪个后端。默认指向官方部署，自建的人填自己的
 * 地址即可，不需要重新编译客户端。
 *
 * 关掉之后客户端一个云端请求都不会发 —— 这是给「这台机器不联网」的场景准备的，
 * 不是一个仅仅隐藏入口的视觉开关。
 */
import { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, Group, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { IconCloud } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/I18nContext';
import { useCloud } from '../../contexts/CloudContext';
import { fetchHealth } from '../../lib/cloud/api';
import { CloudError } from '../../lib/cloud/client';
import {
  DEFAULT_CLOUD_BASE,
  getCustomCloudBase,
  isCloudEnabled,
  setCloudBase,
  setCloudEnabled,
} from '../../lib/cloud/config';

export function CloudSettingsCard() {
  const { t } = useTranslation();
  const { refresh } = useCloud();

  const [enabled, setEnabled] = useState(true);
  const [base, setBase] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // localStorage 只能在客户端读，SSR 阶段先给默认值，挂载后再对齐
  useEffect(() => {
    setEnabled(isCloudEnabled());
    setBase(getCustomCloudBase() || '');
  }, []);

  const applyEnabled = (next: boolean) => {
    setEnabled(next);
    setCloudEnabled(next);
    setResult(null);
    void refresh();
  };

  const applyBase = (next: string) => {
    setBase(next);
    setCloudBase(next.trim() || null);
    setResult(null);
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const health = await fetchHealth();
      setResult({
        ok: health.features.database,
        text: health.features.database
          ? t('cloud.connectionOk', { version: health.version })
          : t('cloud.notConfiguredBody'),
      });
      await refresh();
    } catch (error) {
      setResult({
        ok: false,
        text: t('cloud.connectionFailed', {
          reason: error instanceof CloudError ? error.message : String(error),
        }),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card padding="lg" radius="lg" withBorder>
      <Stack gap="md">
        <Box>
          <Group gap="sm" mb="xs">
            <IconCloud size={24} />
            <Title order={3}>{t('cloud.settingsTitle')}</Title>
          </Group>
          <Text size="sm" c="dimmed">
            {t('cloud.settingsDescription')}
          </Text>
        </Box>

        <Switch
          checked={enabled}
          onChange={(event) => applyEnabled(event.currentTarget.checked)}
          label={t('cloud.enableLabel')}
          description={t('cloud.enableHint')}
        />

        <TextInput
          label={t('cloud.baseLabel')}
          description={t('cloud.baseHint')}
          placeholder={DEFAULT_CLOUD_BASE}
          value={base}
          disabled={!enabled}
          onChange={(event) => applyBase(event.currentTarget.value)}
        />

        <Group>
          <Button size="xs" variant="light" loading={testing} disabled={!enabled} onClick={test}>
            {t('cloud.testConnection')}
          </Button>
        </Group>

        {result && <Alert color={result.ok ? 'green' : 'yellow'}>{result.text}</Alert>}
      </Stack>
    </Card>
  );
}

export default CloudSettingsCard;
