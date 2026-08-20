/**
 * 把仓储记录翻译成接口返回值
 *
 * 列表接口不下发 payload：一道工程题带隐藏用例和参考实现能到几百 KB，
 * 一页 20 条就是十几 MB。详情和下载接口才带完整内容。
 */
import type { ListingDetail, ListingSummary } from '../../cloud/types';
import type { ListingRecord, ListingVersionRecord, Repositories, UserRecord } from './repo/types';

const UNKNOWN_AUTHOR = { id: '', displayName: 'Unknown', avatarUrl: null as string | null };

function authorOf(users: Map<string, UserRecord>, ownerId: string): ListingSummary['author'] {
  const user = users.get(ownerId);
  if (!user) return { ...UNKNOWN_AUTHOR };
  return { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl };
}

export function toSummary(
  listing: ListingRecord,
  users: Map<string, UserRecord>,
  starred: Set<string>
): ListingSummary {
  return {
    slug: listing.slug,
    kind: listing.kind,
    title: listing.title,
    summary: listing.summary,
    difficulty: listing.difficulty,
    tags: listing.tags,
    language: listing.language,
    version: listing.version,
    starCount: listing.starCount,
    downloadCount: listing.downloadCount,
    author: authorOf(users, listing.ownerId),
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    starred: starred.has(listing.id),
  };
}

export function toDetail(
  listing: ListingRecord,
  users: Map<string, UserRecord>,
  starred: Set<string>,
  versions: ListingVersionRecord[],
  options: { includePayload: boolean }
): ListingDetail {
  return {
    ...toSummary(listing, users, starred),
    payload: options.includePayload ? listing.payload : null,
    changelog: listing.changelog,
    versions,
  };
}

/** 批量取作者，避免一页 20 条查 20 次 */
export async function loadAuthors(
  repositories: Repositories,
  listings: ListingRecord[]
): Promise<Map<string, UserRecord>> {
  const ids = Array.from(new Set(listings.map((listing) => listing.ownerId)));
  const users = await repositories.users.findByIds(ids);
  return new Map(users.map((user) => [user.id, user]));
}

export async function loadStarred(
  repositories: Repositories,
  viewerId: string | null,
  listings: ListingRecord[]
): Promise<Set<string>> {
  if (!viewerId || !listings.length) return new Set();
  return repositories.stars.starredListingIds(
    viewerId,
    listings.map((listing) => listing.id)
  );
}
