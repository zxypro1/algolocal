import { AppProps } from 'next/app';
import Head from 'next/head';
import { MantineProvider, createTheme, ColorSchemeScript, MantineColorsTuple } from '@mantine/core';
import '@mantine/core/styles.css';
import '../styles/globals.css';
import { I18nProvider, useI18n } from '../src/contexts/I18nContext';
import { ThemeProvider, useTheme } from '../src/contexts/ThemeContext';

// 品牌主色：靛蓝，比 Mantine 默认蓝更沉稳，暗色下也不刺眼
const brand: MantineColorsTuple = [
  '#eef2ff',
  '#e0e7ff',
  '#c7d2fe',
  '#a5b4fc',
  '#818cf8',
  '#6366f1',
  '#4f46e5',
  '#4338ca',
  '#3730a3',
  '#312e81',
];

const fontStack =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif';

// 亮暗两套主题共用的排版 / 圆角 / 组件默认值
const baseTheme = {
  primaryColor: 'brand',
  primaryShade: { light: 6, dark: 5 } as const,
  defaultRadius: 'md' as const,
  fontFamily: fontStack,
  fontFamilyMonospace: '"JetBrains Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  headings: {
    fontFamily: fontStack,
    fontWeight: '650',
    sizes: {
      h1: { fontSize: '1.75rem', lineHeight: '1.3' },
      h2: { fontSize: '1.375rem', lineHeight: '1.35' },
      h3: { fontSize: '1.125rem', lineHeight: '1.4' },
      h4: { fontSize: '1rem', lineHeight: '1.45' },
      h5: { fontSize: '0.875rem', lineHeight: '1.5' },
    },
  },
  shadows: {
    xs: '0 1px 2px rgba(15, 18, 34, 0.06)',
    sm: '0 1px 3px rgba(15, 18, 34, 0.06), 0 4px 12px rgba(15, 18, 34, 0.04)',
    md: '0 4px 12px rgba(15, 18, 34, 0.08), 0 12px 28px rgba(15, 18, 34, 0.06)',
    lg: '0 12px 32px rgba(15, 18, 34, 0.12)',
  },
  cursorType: 'pointer' as const,
  components: {
    Card: { defaultProps: { radius: 'lg', withBorder: true, shadow: 'xs' } },
    Paper: { defaultProps: { radius: 'md' } },
    Button: { defaultProps: { radius: 'md' } },
    ActionIcon: { defaultProps: { radius: 'md' } },
    Badge: { defaultProps: { radius: 'sm' } },
    TextInput: { defaultProps: { radius: 'md' } },
    Textarea: { defaultProps: { radius: 'md' } },
    Select: { defaultProps: { radius: 'md' } },
    MultiSelect: { defaultProps: { radius: 'md' } },
    Modal: { defaultProps: { radius: 'lg' } },
    Drawer: { defaultProps: { radius: 0 } },
    Tooltip: { defaultProps: { radius: 'sm', withArrow: true } },
  },
};

const lightTheme = createTheme({
  ...baseTheme,
  colors: { brand },
});

const darkTheme = createTheme({
  ...baseTheme,
  colors: {
    brand,
    // 更中性的深色梯度：4=描边，6=卡片表面，7=页面底色
    dark: [
      '#c9cbd1',
      '#b2b5bd',
      '#9598a1',
      '#6f737d',
      '#3a3e47',
      '#2a2d34',
      '#1f2127',
      '#17191d',
      '#131418',
      '#0e0f12',
    ],
  },
});

function AppContent({ Component, pageProps }: AppProps) {
  const { colorScheme } = useTheme();
  const theme = colorScheme === 'dark' ? darkTheme : lightTheme;
  const forceScheme = (colorScheme === 'dark' || colorScheme === 'light') ? colorScheme : 'light';

  return (
    <MantineProvider theme={theme} defaultColorScheme={forceScheme} forceColorScheme={forceScheme}>
      <Component {...pageProps} />
    </MantineProvider>
  );
}

function AppHead() {
  const { t } = useI18n();
  const title = t('header.title');

  return (
    <Head>
      <title>{title}</title>
      <meta name="viewport" content="minimum-scale=1, initial-scale=1, width=device-width" />
      <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      <link rel="icon" type="image/x-icon" href="/favicon.ico" />
      <ColorSchemeScript />
    </Head>
  );
}

export default function App(props: AppProps) {
  return (
    <>
      <I18nProvider>
        <AppHead />
        <ThemeProvider>
          <AppContent {...props} />
        </ThemeProvider>
      </I18nProvider>
    </>
  );
}
