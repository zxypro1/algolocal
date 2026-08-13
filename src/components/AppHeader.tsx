import { ReactNode } from 'react';
import Link from 'next/link';
import { AppShell, Group, Text, Divider, ActionIcon, Tooltip, Box } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { useTranslation } from '../contexts/I18nContext';
import { LanguageThemeControls } from './LanguageThemeControls';

/** 所有页面共用的顶栏高度，页面计算可用高度时请引用它，不要写死数字 */
export const HEADER_HEIGHT = 60;

interface AppHeaderProps {
  /** 当前页标题，跟在品牌名之后；首页不传 */
  title?: string;
  /** 返回按钮的目标地址，不传则不显示 */
  backHref?: string;
  /** 顶栏右侧的额外操作，排在语言/主题切换之前 */
  actions?: ReactNode;
}

function BrandMark() {
  return (
    <Box
      component="img"
      src="/favicon.svg?v=4"
      alt=""
      aria-hidden="true"
      style={{
        width: 32,
        height: 32,
        display: 'block',
        flexShrink: 0,
      }}
    />
  );
}

export function AppHeader({ title, backHref, actions }: AppHeaderProps) {
  const { t } = useTranslation();

  return (
    <AppShell.Header className="app-header" withBorder={false}>
      <Group h="100%" px="md" justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          {backHref && (
            <Tooltip label={t('common.home')}>
              <ActionIcon
                component={Link}
                href={backHref}
                variant="subtle"
                color="gray"
                size="lg"
                aria-label={t('common.home')}
              >
                <IconArrowLeft size={18} />
              </ActionIcon>
            </Tooltip>
          )}

          <Link href="/" aria-label={t('header.title')} style={{ minWidth: 0 }}>
            <Group gap={10} wrap="nowrap">
              <BrandMark />
              <Text fw={700} size="md" style={{ letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
                {t('header.title')}
              </Text>
            </Group>
          </Link>

          {title && (
            <>
              <Divider orientation="vertical" my={14} />
              <Text size="sm" c="dimmed" fw={500} truncate>
                {title}
              </Text>
            </>
          )}
        </Group>

        <Group gap="xs" wrap="nowrap">
          {actions}
          <LanguageThemeControls />
        </Group>
      </Group>
    </AppShell.Header>
  );
}

export default AppHeader;
