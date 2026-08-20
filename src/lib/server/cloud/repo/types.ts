/**
 * 仓储层的契约
 *
 * 定义成接口是为了有两个实现：Postgres（生产）和内存（本地开发与集成测试）。
 * 集成测试因此可以真刀真枪地调 API 路由，而不必在 CI 里开一个数据库 ——
 * 用 mock 替掉整个 handler 的测试，测的是 mock 不是代码。
 */
import type { ListingDifficulty, ListingKind, LocalizedText } from '../../../cloud/types';

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  passwordHash: string | null;
  githubId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface ListingRecord {
  id: string;
  slug: string;
  kind: ListingKind;
  ownerId: string;
  title: LocalizedText;
  summary: LocalizedText;
  difficulty: ListingDifficulty;
  tags: string[];
  language: string | null;
  payload: unknown;
  version: number;
  changelog: string | null;
  starCount: number;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListingVersionRecord {
  version: number;
  changelog: string | null;
  createdAt: string;
}

export interface SearchListingsInput {
  kind?: ListingKind;
  difficulty?: ListingDifficulty;
  tag?: string;
  search?: string;
  authorId?: string;
  sort: 'recent' | 'stars' | 'downloads';
  limit: number;
  offset: number;
}

export interface UpsertListingInput {
  slug: string;
  kind: ListingKind;
  ownerId: string;
  title: LocalizedText;
  summary: LocalizedText;
  difficulty: ListingDifficulty;
  tags: string[];
  language: string | null;
  payload: unknown;
  changelog: string | null;
}

export interface UserRepo {
  findById(id: string): Promise<UserRecord | null>;
  findByIds(ids: string[]): Promise<UserRecord[]>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findByGithubId(githubId: string): Promise<UserRecord | null>;
  create(input: {
    email: string;
    displayName: string;
    passwordHash: string | null;
    githubId: string | null;
    avatarUrl: string | null;
  }): Promise<UserRecord>;
  update(
    id: string,
    patch: Partial<Pick<UserRecord, 'displayName' | 'avatarUrl' | 'passwordHash' | 'githubId'>>
  ): Promise<UserRecord>;
}

export interface SessionRepo {
  create(input: { userId: string; tokenHash: string; expiresAt: string }): Promise<SessionRecord>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  touch(id: string): Promise<void>;
  deleteByTokenHash(tokenHash: string): Promise<void>;
  deleteByUser(userId: string): Promise<void>;
  deleteExpired(now?: string): Promise<number>;
}

export interface ListingRepo {
  findBySlug(slug: string): Promise<ListingRecord | null>;
  search(input: SearchListingsInput): Promise<{ items: ListingRecord[]; total: number }>;
  listByOwner(ownerId: string): Promise<ListingRecord[]>;
  upsert(input: UpsertListingInput): Promise<ListingRecord>;
  remove(id: string): Promise<void>;
  incrementDownloads(id: string): Promise<number>;
  versions(listingId: string): Promise<ListingVersionRecord[]>;
}

export interface StarRepo {
  add(userId: string, listingId: string): Promise<number>;
  remove(userId: string, listingId: string): Promise<number>;
  starredListingIds(userId: string, listingIds: string[]): Promise<Set<string>>;
}

export interface Repositories {
  kind: 'postgres' | 'memory';
  users: UserRepo;
  sessions: SessionRepo;
  listings: ListingRepo;
  stars: StarRepo;
}

/** 邮箱大小写不敏感，统一小写后再比较和存储 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
