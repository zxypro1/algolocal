import { useEffect, useState, ReactNode } from 'react';
import {
  AppShell,
  Center,
  Loader,
  Stack,
  Text,
} from '@mantine/core';
import { useTranslation } from '../src/contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../src/components/AppHeader';
import { PracticeDashboard } from '../src/components/PracticeDashboard';

type ProblemLite = {
  id: string;
  title: { en: string; zh: string };
  difficulty: string;
  tags?: string[];
};

export default function StatsPage() {
  const { t } = useTranslation();
  const [problems, setProblems] = useState<ProblemLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchProblems = async () => {
      try {
        const response = await fetch('/api/problems');
        if (!response.ok) throw new Error('Failed to fetch problems');
        const data = await response.json();
        setProblems(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load problems');
      } finally {
        setLoading(false);
      }
    };
    fetchProblems();
  }, []);

  const shell = (children: ReactNode) => (
    <AppShell header={{ height: HEADER_HEIGHT }} padding={{ base: 'sm', md: 'lg' }}>
      <AppHeader backHref="/" title={t('statsPage.title')} />
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );

  if (loading) {
    return shell(
      <Center style={{ minHeight: '60vh' }}>
        <Stack align="center" gap="md">
          <Loader size="md" />
          <Text size="sm" c="dimmed">{t('common.loading')}</Text>
        </Stack>
      </Center>
    );
  }

  if (error) {
    return shell(
      <Center style={{ minHeight: '60vh' }}>
        <Text c="red">{error}</Text>
      </Center>
    );
  }

  return shell(<PracticeDashboard problems={problems as any} />);
}

