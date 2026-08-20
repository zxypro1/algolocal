import Link from 'next/link';
import { ActionIcon, Badge, Card, Group, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconBuildingFactory2,
  IconDownload,
  IconPackage,
  IconStar,
  IconStarFilled,
} from '@tabler/icons-react';
import { useI18n, useTranslation } from '../../contexts/I18nContext';
import type { ListingSummary } from '../../lib/cloud/types';

const DIFFICULTY_COLORS: Record<string, string> = { Easy: 'green', Medium: 'yellow', Hard: 'red' };

interface ListingCardProps {
  listing: ListingSummary;
  /** 未登录时为 undefined，卡片上的 star 变成只读计数 */
  onToggleStar?: (listing: ListingSummary) => void;
  busy?: boolean;
}

export function ListingCard({ listing, onToggleStar, busy }: ListingCardProps) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const language = locale === 'en' ? 'en' : 'zh';

  const KindIcon = listing.kind === 'engineering' ? IconBuildingFactory2 : IconPackage;

  return (
    <Card padding="md" h="100%">
      <Stack gap="xs" h="100%">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            <KindIcon size={16} style={{ flexShrink: 0, opacity: 0.6 }} />
            <Text
              component={Link}
              href={`/market/${encodeURIComponent(listing.slug)}`}
              fw={600}
              size="sm"
              lineClamp={1}
              style={{ textDecoration: 'none' }}
            >
              {listing.title[language] || listing.title.en || listing.slug}
            </Text>
          </Group>

          <Tooltip label={onToggleStar ? t('market.star') : t('market.starSignInHint')}>
            <ActionIcon
              variant="subtle"
              color={listing.starred ? 'yellow' : 'gray'}
              size="sm"
              disabled={!onToggleStar || busy}
              onClick={() => onToggleStar?.(listing)}
              aria-label={t('market.star')}
            >
              {listing.starred ? <IconStarFilled size={15} /> : <IconStar size={15} />}
            </ActionIcon>
          </Tooltip>
        </Group>

        <Text size="xs" c="dimmed" lineClamp={2} style={{ flexGrow: 1 }}>
          {listing.summary[language] || listing.summary.en}
        </Text>

        <Group gap={6} wrap="wrap">
          <Badge size="xs" color={DIFFICULTY_COLORS[listing.difficulty] || 'gray'} variant="light">
            {t(`homepage.difficulty.${listing.difficulty}`)}
          </Badge>
          {listing.language && (
            <Badge size="xs" variant="default">
              {listing.language === 'typescript' ? 'TypeScript' : 'JavaScript'}
            </Badge>
          )}
          {listing.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} size="xs" variant="default">
              {tag}
            </Badge>
          ))}
        </Group>

        <Group justify="space-between" gap="xs">
          <Text size="xs" c="dimmed" truncate>
            {listing.author.displayName}
          </Text>
          <Group gap={10}>
            <Group gap={3}>
              <IconStar size={12} style={{ opacity: 0.55 }} />
              <Text size="xs" c="dimmed">
                {listing.starCount}
              </Text>
            </Group>
            <Group gap={3}>
              <IconDownload size={12} style={{ opacity: 0.55 }} />
              <Text size="xs" c="dimmed">
                {listing.downloadCount}
              </Text>
            </Group>
          </Group>
        </Group>
      </Stack>
    </Card>
  );
}

export default ListingCard;
