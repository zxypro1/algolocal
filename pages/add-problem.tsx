import React from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { Container, AppShell, Button } from '@mantine/core';
import { useTranslation } from '../src/contexts/I18nContext';
import { AppHeader, HEADER_HEIGHT } from '../src/components/AppHeader';
import ProblemForm from '../src/components/ProblemForm';

const AddProblem: React.FC = () => {
  const { t } = useTranslation();

  return (
    <AppShell header={{ height: HEADER_HEIGHT }}>
      <Head>
        <title>{t('addProblem.title')} - {t('header.title')}</title>
        <meta name="description" content="Add new coding problems to the practice system" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <AppHeader
        backHref="/"
        title={t('addProblem.title')}
        actions={
          <Button component={Link} href="/" variant="subtle" color="gray" size="xs" visibleFrom="sm">
            {t('addProblem.backToProblems')}
          </Button>
        }
      />

      <AppShell.Main>
        <Container size="xl" py="xl">
          <ProblemForm />
        </Container>
      </AppShell.Main>
    </AppShell>
  );
};

export default AddProblem;