/**
 * 工程实战的工作台页面
 *
 * 这一页本身不摆面板，只做三件事：把会话拉起来、处理载入与出错、
 * 然后按项目声明的工作台形态（workspace.kind）分发给对应的工作台组件。
 *
 * 形态是 v0.15 之后引入的概念：原先「任务描述 + IDE + 结果面板」这套布局是写死的，
 * 而内网设施那类项目需要终端和拓扑图。不声明 workspace 的项目一律走 'code'，
 * 也就是搬进 CodeWorkspace 的那套原有布局。
 */
import { useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { Alert, AppShell, Button, Center, Loader, Stack, Text } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useTranslation } from '../../src/contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../../src/components/AppHeader';
import CodeWorkspace from '../../src/components/engineering/CodeWorkspace';
import { useProjectSession, type ResultScope } from '../../src/hooks/useProjectSession';
import { workspaceKindOf } from '../../src/lib/engineering/workspace';
import { resetProgress } from '../../src/lib/engineering/progress';

export default function ProjectWorkspacePage() {
  const router = useRouter();
  const { id } = router.query;
  const { t } = useTranslation();

  /**
   * 「清结果」要跨过会话与工作台的边界。
   *
   * 换关卡、换语言、重置这些动作住在会话里，而运行结果、评分卡、AI 评审这些状态
   * 住在工作台里 —— 会话不该知道有哪些结果面板。所以工作台挂载时把自己的清理函数
   * 登记进来，会话通过这个稳定的转接函数调用它。
   */
  const clearResultsRef = useRef<((scope: ResultScope) => void) | null>(null);
  const registerClearResults = useCallback((fn: ((scope: ResultScope) => void) | null) => {
    clearResultsRef.current = fn;
  }, []);
  const onClearResults = useCallback((scope: ResultScope) => {
    clearResultsRef.current?.(scope);
  }, []);

  const session = useProjectSession({
    projectId: typeof id === 'string' ? id : undefined,
    onClearResults,
  });

  const { project, loading, loadError, progress, stage } = session;

  if (loading) {
    return (
      <AppShell header={{ height: HEADER_HEIGHT }}>
        <AppHeader backHref="/projects" />
        <AppShell.Main>
          <Center style={{ minHeight: '60vh' }}>
            <Stack align="center" gap="md">
              <Loader />
              <Text size="sm" c="dimmed">
                {t('common.loading')}
              </Text>
            </Stack>
          </Center>
        </AppShell.Main>
      </AppShell>
    );
  }

  if (loadError || !project || !stage || !progress) {
    return (
      <AppShell header={{ height: HEADER_HEIGHT }}>
        <AppHeader backHref="/projects" />
        <AppShell.Main>
          <Center style={{ minHeight: '60vh' }}>
            <Alert color="red" title={t('common.error')} maw={480}>
              <Stack gap="sm" align="flex-start">
                <Text size="sm">{loadError || t('engineering.workspace.notFound')}</Text>
                {/* 存着的进度和题目对不上时，这里是唯一的出口，否则用户被永久挡在外面 */}
                {typeof id === 'string' && (
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    leftSection={<IconRefresh size={14} />}
                    onClick={() => {
                      resetProgress(id);
                      router.reload();
                    }}
                  >
                    {t('engineering.workspace.resetProject')}
                  </Button>
                )}
              </Stack>
            </Alert>
          </Center>
        </AppShell.Main>
      </AppShell>
    );
  }

  /**
   * 形态未知时不能白屏。
   *
   * 题目可能来自更新的版本（用户导入的、或者降级安装之后留下的），
   * 这时要说清楚是「这个版本不支持这种工作台」，而不是渲染半个坏掉的页面。
   */
  if (workspaceKindOf(project) !== 'code') {
    return (
      <AppShell header={{ height: HEADER_HEIGHT }}>
        <AppHeader backHref="/projects" title={session.pick(project.title)} />
        <AppShell.Main>
          <Center style={{ minHeight: '60vh' }}>
            <Alert color="yellow" title={t('engineering.workspace.unsupportedKind')} maw={480}>
              <Text size="sm">{t('engineering.workspace.unsupportedKindBody')}</Text>
            </Alert>
          </Center>
        </AppShell.Main>
      </AppShell>
    );
  }

  return <CodeWorkspace session={session} registerClearResults={registerClearResults} />;
}
