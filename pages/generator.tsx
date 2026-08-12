import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import { AppShell, Container, Button, Text } from '@mantine/core';
import { useRouter } from 'next/router';
import { useTranslation } from '../src/contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../src/components/AppHeader';
import ProblemGenerator from '../src/components/ProblemGenerator';

interface GeneratedProblem {
  id: string;
  title: {
    en: string;
    zh: string;
  };
  difficulty: 'Easy' | 'Medium' | 'Hard';
  tags: string[];
  description: {
    en: string;
    zh: string;
  };
}

const GeneratorPage: React.FC = () => {
  const router = useRouter();
  const { t } = useTranslation();
  const [lastGeneratedProblem, setLastGeneratedProblem] = useState<GeneratedProblem | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleProblemGenerated = (problem: GeneratedProblem) => {
    setLastGeneratedProblem(problem);
  };

  const handleTryProblem = () => {
    if (lastGeneratedProblem) {
      router.push(`/problems/${lastGeneratedProblem.id}`);
    }
  };

  if (!mounted) {
    return (
      <>
        <Head>
          <title>{t('aiGenerator.title')} - {t('header.title')}</title>
          <meta name="description" content={t('aiGenerator.subtitle')} />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </Head>
        <div>{t('common.loading')}</div>
      </>
    );
  }

  return (
    <>
      <Head>
        <title>{t('aiGenerator.title')} - {t('header.title')}</title>
        <meta name="description" content={t('aiGenerator.subtitle')} />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <AppShell
        header={{ height: HEADER_HEIGHT }}
        padding="md"
      >
        {/* Header */}
        <AppHeader
          backHref="/"
          title={t('aiGenerator.title')}
          actions={
            lastGeneratedProblem ? (
              <Button variant="light" size="xs" onClick={handleTryProblem}>
                {t('aiGenerator.tryLastProblem')}
              </Button>
            ) : null
          }
        />

        {/* Main Content */}
        <AppShell.Main>
          <Container size="lg" py="xl">
            <ProblemGenerator 
              onProblemGenerated={handleProblemGenerated}
            />
          </Container>

          {/* Footer */}
          <Container size="lg" py="md">
            <Text size="sm" ta="center" c="dimmed">
              {t('aiGenerator.poweredBy', { provider: 'AI' })} • {t('aiGenerator.unlimitedProblems')}
            </Text>
          </Container>
        </AppShell.Main>
      </AppShell>
    </>
  );
};

export default GeneratorPage;