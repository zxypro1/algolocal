/**
 * 云端界面的外壳
 *
 * 市场和账号页共用。它把「正在探测 / 连不上 / 被关掉了 / 服务端没配数据库」
 * 四种状态渲染成人话，而不是让每个页面各写一遍 —— 离线是这个应用的常态，
 * 常态不该长得像故障。
 */
import { ReactNode } from 'react';
import { Alert, Button, Center, Group, Loader, Stack, Text } from '@mantine/core';
import { IconCloudOff, IconPlugConnectedX, IconRefresh } from '@tabler/icons-react';
import Link from 'next/link';
import { useTranslation } from '../../contexts/I18nContext';
import { useCloud, type CloudStatus } from '../../contexts/CloudContext';

interface CloudGateProps {
  status: CloudStatus;
  children: ReactNode;
  /** 探测中是否显示 loading。列表页给 true，只放一个按钮的地方给 false。 */
  showChecking?: boolean;
}

export function CloudGate({ status, children, showChecking = true }: CloudGateProps) {
  const { t } = useTranslation();
  const { refresh, health } = useCloud();

  if (status === 'checking' && showChecking) {
    return (
      <Center py="xl">
        <Group gap="xs">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            {t('cloud.checking')}
          </Text>
        </Group>
      </Center>
    );
  }

  if (status === 'disabled') {
    return (
      <Alert color="gray" icon={<IconPlugConnectedX size={18} />} title={t('cloud.disabledTitle')}>
        <Stack gap="sm" align="flex-start">
          <Text size="sm">{t('cloud.disabledBody')}</Text>
          <Button component={Link} href="/settings" size="xs" variant="light">
            {t('common.settings')}
          </Button>
        </Stack>
      </Alert>
    );
  }

  if (status === 'offline') {
    // 服务端答上话了但说自己没数据库，和「压根连不上」是两回事，
    // 自建部署的人需要看到这个区别
    const misconfigured = Boolean(health && !health.features.database);

    return (
      <Alert
        color="yellow"
        icon={<IconCloudOff size={18} />}
        title={misconfigured ? t('cloud.notConfiguredTitle') : t('cloud.offlineTitle')}
      >
        <Stack gap="sm" align="flex-start">
          <Text size="sm">{misconfigured ? t('cloud.notConfiguredBody') : t('cloud.offlineBody')}</Text>
          <Group gap="xs">
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => refresh()}>
              {t('cloud.retry')}
            </Button>
            <Button component={Link} href="/workshop" size="xs" variant="subtle">
              {t('cloud.goOfflineWorkshop')}
            </Button>
          </Group>
        </Stack>
      </Alert>
    );
  }

  if (status === 'idle') return null;

  return <>{children}</>;
}

export default CloudGate;
