import { AppProps } from 'next/app';
import Head from 'next/head';
import { MantineProvider, createTheme, ColorSchemeScript, MantineColorsTuple } from '@mantine/core';
import '@mantine/core/styles.css';
import '../styles/globals.css';
import { I18nProvider, useI18n } from '../src/contexts/I18nContext';
import { ThemeProvider, useTheme } from '../src/contexts/ThemeContext';
import FindBar from '../src/components/FindBar';
import ErrorBoundary from '../src/components/ErrorBoundary';
import { useRouter } from 'next/router';

// AlgoLocal 品牌青色：与新的本地执行回路标志保持一致
const brand: MantineColorsTuple = [
  '#e6fbff',
  '#ccf6ff',
  '#9cecff',
  '#63e1ff',
  '#2ed4ff',
  '#14c8ff',
  '#08a9dc',
  '#0787b1',
  '#096d8e',
  '#0c5a75',
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
  const router = useRouter();
  const { colorScheme } = useTheme();
  const theme = colorScheme === 'dark' ? darkTheme : lightTheme;
  const forceScheme = (colorScheme === 'dark' || colorScheme === 'light') ? colorScheme : 'light';

  return (
    <MantineProvider theme={theme} defaultColorScheme={forceScheme} forceColorScheme={forceScheme}>
      {/*
        最外层兜底。页面内部各自还有更细的边界（关卡、架构图），那些能把损坏范围
        收得更小；这一层是为了保证**任何**没被接住的渲染异常都不会变成整页白屏。
        按路由重置：换一个页面就该重新试一次。
      */}
      <ErrorBoundary resetKey={router.asPath}>
        <Component {...pageProps} />
      </ErrorBoundary>
      {/* 桌面端的 ⌘F 查找栏；浏览器里它自己不渲染 */}
      <FindBar />
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
      <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=5" />
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
