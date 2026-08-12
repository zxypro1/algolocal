import { Group, Menu, ActionIcon, Tooltip } from '@mantine/core';
import { IconLanguage, IconSun, IconMoon, IconCheck } from '@tabler/icons-react';
import { useI18n } from '../contexts/I18nContext';
import { useTheme } from '../contexts/ThemeContext';

export function LanguageThemeControls() {
  const { locale, switchLocale, t } = useI18n();
  const { colorScheme, toggleColorScheme } = useTheme();

  const changeLocale = (next: 'zh' | 'en') => {
    switchLocale(next);
    // Notify Electron of language change
    if (typeof window !== 'undefined' && (window as any).electronAPI) {
      (window as any).electronAPI.setLanguage(next);
    }
  };

  return (
    <Group gap={4}>
      {/* 语言切换 */}
      <Menu shadow="md" width={160} position="bottom-end">
        <Menu.Target>
          <Tooltip label={t('common.language')}>
            <ActionIcon variant="subtle" color="gray" size="lg" aria-label={t('common.language')}>
              <IconLanguage size={18} />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>

        <Menu.Dropdown>
          <Menu.Label>{t('common.language')}</Menu.Label>
          <Menu.Item
            onClick={() => changeLocale('zh')}
            rightSection={locale === 'zh' ? <IconCheck size={14} /> : null}
          >
            中文
          </Menu.Item>
          <Menu.Item
            onClick={() => changeLocale('en')}
            rightSection={locale === 'en' ? <IconCheck size={14} /> : null}
          >
            English
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      {/* 主题切换 */}
      <Tooltip label={colorScheme === 'dark' ? t('common.light') : t('common.dark')}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          aria-label={t('common.theme')}
          onClick={() => {
            toggleColorScheme();
            // Notify Electron of theme change
            if (typeof window !== 'undefined' && (window as any).electronAPI) {
              (window as any).electronAPI.setTheme(colorScheme === 'dark' ? 'light' : 'dark');
            }
          }}
        >
          {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
