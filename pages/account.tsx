/**
 * 账号
 *
 * 未登录时是登录/注册表单，登录后是资料页 + 我发布的题目。
 * 整页在离线时会退化成 CloudGate 的离线提示 —— 账号是可选功能，
 * 没有它算法题和工程实战照样能做。
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  AppShell,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Group,
  PasswordInput,
  Stack,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconBrandGithub, IconLogout, IconTrash } from '@tabler/icons-react';
import { AppHeader, HEADER_HEIGHT } from '../src/components/AppHeader';
import { CloudGate } from '../src/components/cloud/CloudGate';
import { useCloudSurface } from '../src/contexts/CloudContext';
import { useI18n, useTranslation } from '../src/contexts/I18nContext';
import * as api from '../src/lib/cloud/api';
import { CloudError } from '../src/lib/cloud/client';
import type { ListingDetail } from '../src/lib/cloud/types';

export default function AccountPage() {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const language = locale === 'en' ? 'en' : 'zh';
  const { status, user, health, signIn, signUp, signOut, startGithubSignIn, updateUser } = useCloudSurface();

  const [mode, setMode] = useState<string>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [listings, setListings] = useState<ListingDetail[] | null>(null);
  const [profileName, setProfileName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [profileNotice, setProfileNotice] = useState<string | null>(null);

  useEffect(() => {
    if (user) setProfileName(user.displayName);
  }, [user]);

  useEffect(() => {
    if (!user || status !== 'online') return;

    const controller = new AbortController();
    api
      .fetchMyListings(controller.signal)
      .then((result) => setListings(result.items))
      .catch(() => {
        // 「我发布的」拿不到不影响这一页的主要用途，静默降级成空列表
        if (!controller.signal.aborted) setListings([]);
      });

    return () => controller.abort();
  }, [user, status]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') await signUp({ email, password, displayName });
      else await signIn({ email, password });
      setPassword('');
    } catch (cause) {
      setError(cause instanceof CloudError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [mode, email, password, displayName, signIn, signUp]);

  const saveProfile = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProfileNotice(null);
    try {
      const payload: { displayName?: string; password?: string; currentPassword?: string } = {};
      if (profileName && profileName !== user?.displayName) payload.displayName = profileName;
      if (newPassword) {
        payload.password = newPassword;
        if (currentPassword) payload.currentPassword = currentPassword;
      }
      if (!Object.keys(payload).length) return;

      const result = await api.updateProfile(payload);
      updateUser(result.user);
      setNewPassword('');
      setCurrentPassword('');
      setProfileNotice(t('account.profileSaved'));
    } catch (cause) {
      setError(cause instanceof CloudError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [profileName, newPassword, currentPassword, user, updateUser, t]);

  const removeListing = useCallback(
    async (listing: ListingDetail) => {
      if (!window.confirm(t('market.confirmDelete', { title: listing.title[language] }))) return;
      try {
        await api.deleteListing(listing.slug);
        setListings((current) => (current || []).filter((item) => item.slug !== listing.slug));
      } catch (cause) {
        setError(cause instanceof CloudError ? cause.message : String(cause));
      }
    },
    [language, t]
  );

  const githubAvailable = Boolean(health?.features.github);

  return (
    <AppShell header={{ height: HEADER_HEIGHT }} padding={0}>
      <AppHeader backHref="/" title={t('account.title')} />

      <AppShell.Main>
        <Container size="sm" py="lg">
          <CloudGate status={status}>
            {!user ? (
              <Card padding="lg">
                <Stack gap="md">
                  <Stack gap={4}>
                    <Title order={2}>{mode === 'signup' ? t('account.signUp') : t('account.signIn')}</Title>
                    <Text size="sm" c="dimmed">
                      {t('account.optionalHint')}
                    </Text>
                  </Stack>

                  <Tabs value={mode} onChange={(value) => setMode(value || 'signin')}>
                    <Tabs.List grow>
                      <Tabs.Tab value="signin">{t('account.signIn')}</Tabs.Tab>
                      <Tabs.Tab value="signup">{t('account.signUp')}</Tabs.Tab>
                    </Tabs.List>
                  </Tabs>

                  {error && <Alert color="red">{error}</Alert>}

                  <Stack gap="sm">
                    {mode === 'signup' && (
                      <TextInput
                        label={t('account.displayName')}
                        value={displayName}
                        onChange={(event) => setDisplayName(event.currentTarget.value)}
                        autoComplete="nickname"
                      />
                    )}
                    <TextInput
                      label={t('account.email')}
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.currentTarget.value)}
                      autoComplete="email"
                    />
                    <PasswordInput
                      label={t('account.password')}
                      description={mode === 'signup' ? t('account.passwordHint') : undefined}
                      value={password}
                      onChange={(event) => setPassword(event.currentTarget.value)}
                      autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submit();
                      }}
                    />
                    <Button onClick={submit} loading={busy}>
                      {mode === 'signup' ? t('account.signUp') : t('account.signIn')}
                    </Button>
                  </Stack>

                  {githubAvailable && (
                    <>
                      <Divider label={t('account.or')} labelPosition="center" />
                      <Button
                        variant="default"
                        leftSection={<IconBrandGithub size={16} />}
                        onClick={() => startGithubSignIn('/account')}
                      >
                        {t('account.continueWithGithub')}
                      </Button>
                    </>
                  )}
                </Stack>
              </Card>
            ) : (
              <Stack gap="lg">
                <Card padding="lg">
                  <Stack gap="md">
                    <Group justify="space-between">
                      <Stack gap={2}>
                        <Title order={2}>{user.displayName}</Title>
                        <Text size="sm" c="dimmed">
                          {user.email}
                        </Text>
                        <Group gap={6} mt={4}>
                          {user.providers.map((provider) => (
                            <Badge key={provider} size="xs" variant="light">
                              {provider === 'github' ? 'GitHub' : t('account.password')}
                            </Badge>
                          ))}
                        </Group>
                      </Stack>
                      <Button
                        variant="subtle"
                        color="gray"
                        leftSection={<IconLogout size={15} />}
                        onClick={signOut}
                      >
                        {t('account.signOut')}
                      </Button>
                    </Group>

                    <Divider />

                    {error && <Alert color="red">{error}</Alert>}
                    {profileNotice && <Alert color="green">{profileNotice}</Alert>}

                    <TextInput
                      label={t('account.displayName')}
                      value={profileName}
                      onChange={(event) => setProfileName(event.currentTarget.value)}
                    />
                    {user.providers.includes('password') && (
                      <PasswordInput
                        label={t('account.currentPassword')}
                        value={currentPassword}
                        onChange={(event) => setCurrentPassword(event.currentTarget.value)}
                        autoComplete="current-password"
                      />
                    )}
                    <PasswordInput
                      label={
                        user.providers.includes('password') ? t('account.newPassword') : t('account.setPassword')
                      }
                      description={t('account.passwordHint')}
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.currentTarget.value)}
                      autoComplete="new-password"
                    />
                    <Group>
                      <Button onClick={saveProfile} loading={busy}>
                        {t('settings.save')}
                      </Button>
                      {newPassword && (
                        <Text size="xs" c="dimmed">
                          {t('account.passwordChangeSignsOutOthers')}
                        </Text>
                      )}
                    </Group>
                  </Stack>
                </Card>

                <Card padding="lg">
                  <Stack gap="sm">
                    <Group justify="space-between">
                      <Title order={3}>{t('account.myListings')}</Title>
                      <Button component={Link} href="/workshop" size="xs" variant="light">
                        {t('workshop.title')}
                      </Button>
                    </Group>

                    {listings === null && <Text size="sm" c="dimmed">{t('common.loading')}</Text>}
                    {listings?.length === 0 && (
                      <Text size="sm" c="dimmed">
                        {t('account.noListings')}
                      </Text>
                    )}

                    {(listings || []).map((listing) => (
                      <Group key={listing.slug} justify="space-between" wrap="nowrap">
                        <Stack gap={0} style={{ minWidth: 0 }}>
                          <Anchor component={Link} href={`/market/${listing.slug}`} size="sm" truncate>
                            {listing.title[language] || listing.title.en}
                          </Anchor>
                          <Text size="xs" c="dimmed">
                            v{listing.version} · {t('market.starCount', { count: listing.starCount })} ·{' '}
                            {t('market.downloadCount', { count: listing.downloadCount })}
                          </Text>
                        </Stack>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="red"
                          leftSection={<IconTrash size={13} />}
                          onClick={() => removeListing(listing)}
                        >
                          {t('market.delete')}
                        </Button>
                      </Group>
                    ))}
                  </Stack>
                </Card>
              </Stack>
            )}
          </CloudGate>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
