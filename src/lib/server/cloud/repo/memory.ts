/**
 * 内存仓储
 *
 * 用途只有两个：本地开发时不想装数据库，以及 CI 里跑真实的 API 集成测试。
 * 它必须和 Postgres 实现表现一致 —— 包括唯一约束冲突、所有权校验失败时抛
 * 什么错 —— 否则测试通过而线上挂掉，比没有测试更糟。
 * tests/cloud/repo-parity.test.ts 用同一组用例跑两个实现来守住这一点。
 */
import { randomUUID } from 'crypto';
import { SlugTakenError } from './postgres';
import {
  normalizeEmail,
  type ListingRecord,
  type ListingVersionRecord,
  type Repositories,
  type SessionRecord,
  type UserRecord,
} from './types';

interface VersionRow extends ListingVersionRecord {
  listingId: string;
  payload: unknown;
}

export function createMemoryRepositories(): Repositories {
  const users = new Map<string, UserRecord>();
  const sessions = new Map<string, SessionRecord>();
  const listings = new Map<string, ListingRecord>();
  const versions: VersionRow[] = [];
  const stars = new Set<string>();

  const starKey = (userId: string, listingId: string) => `${userId}::${listingId}`;
  const now = () => new Date().toISOString();
  const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

  const uniqueViolation = (constraint: string) => {
    // Postgres 的唯一约束冲突带 code 23505，上层按这个码判「邮箱已注册」
    const error = new Error(`duplicate key value violates unique constraint "${constraint}"`) as Error & {
      code?: string;
    };
    error.code = '23505';
    return error;
  };

  return {
    kind: 'memory',

    users: {
      async findById(id) {
        return clone(users.get(id) ?? null);
      },

      async findByIds(ids) {
        // 去重是为了和 Postgres 对齐：`id = ANY($1)` 里传重复的 id 也只会返回一行
        return Array.from(new Set(ids))
          .map((id) => users.get(id))
          .filter(Boolean)
          .map((user) => clone(user!));
      },

      async findByEmail(email) {
        const target = normalizeEmail(email);
        for (const user of Array.from(users.values())) {
          if (user.email === target) return clone(user);
        }
        return null;
      },

      async findByGithubId(githubId) {
        for (const user of Array.from(users.values())) {
          if (user.githubId && user.githubId === String(githubId)) return clone(user);
        }
        return null;
      },

      async create(input) {
        const email = normalizeEmail(input.email);
        for (const user of Array.from(users.values())) {
          if (user.email === email) throw uniqueViolation('cloud_users_email_key');
          if (input.githubId && user.githubId === input.githubId) {
            throw uniqueViolation('cloud_users_github_id_key');
          }
        }

        const record: UserRecord = {
          id: randomUUID(),
          email,
          displayName: input.displayName,
          avatarUrl: input.avatarUrl,
          passwordHash: input.passwordHash,
          githubId: input.githubId,
          createdAt: now(),
          updatedAt: now(),
        };
        users.set(record.id, record);
        return clone(record);
      },

      async update(id, patch) {
        const existing = users.get(id);
        if (!existing) throw new Error(`User ${id} not found`);

        if (patch.githubId) {
          for (const user of Array.from(users.values())) {
            if (user.id !== id && user.githubId === patch.githubId) {
              throw uniqueViolation('cloud_users_github_id_key');
            }
          }
        }

        // COALESCE 语义：只有传了非空值才覆盖，传 undefined/null 保持原样
        const updated: UserRecord = {
          ...existing,
          displayName: patch.displayName ?? existing.displayName,
          avatarUrl: patch.avatarUrl ?? existing.avatarUrl,
          passwordHash: patch.passwordHash ?? existing.passwordHash,
          githubId: patch.githubId ?? existing.githubId,
          updatedAt: now(),
        };
        users.set(id, updated);
        return clone(updated);
      },
    },

    sessions: {
      async create(input) {
        const record: SessionRecord = {
          id: randomUUID(),
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          createdAt: now(),
        };
        sessions.set(record.id, record);
        return clone(record);
      },

      async findByTokenHash(tokenHash) {
        for (const session of Array.from(sessions.values())) {
          if (session.tokenHash !== tokenHash) continue;
          if (Date.parse(session.expiresAt) <= Date.now()) return null;
          return clone(session);
        }
        return null;
      },

      async touch() {
        /* last_used_at 只用于运维排查，内存实现不需要 */
      },

      async deleteByTokenHash(tokenHash) {
        for (const [id, session] of Array.from(sessions.entries())) {
          if (session.tokenHash === tokenHash) sessions.delete(id);
        }
      },

      async deleteByUser(userId) {
        for (const [id, session] of Array.from(sessions.entries())) {
          if (session.userId === userId) sessions.delete(id);
        }
      },

      async deleteExpired() {
        let removed = 0;
        for (const [id, session] of Array.from(sessions.entries())) {
          if (Date.parse(session.expiresAt) <= Date.now()) {
            sessions.delete(id);
            removed += 1;
          }
        }
        return removed;
      },
    },

    listings: {
      async findBySlug(slug) {
        for (const listing of Array.from(listings.values())) {
          if (listing.slug === slug) return clone(listing);
        }
        return null;
      },

      async search(input) {
        const needle = input.search?.toLowerCase();
        let items = Array.from(listings.values()).filter((listing) => {
          if (input.kind && listing.kind !== input.kind) return false;
          if (input.difficulty && listing.difficulty !== input.difficulty) return false;
          if (input.tag && !listing.tags.includes(input.tag)) return false;
          if (input.authorId && listing.ownerId !== input.authorId) return false;
          if (needle) {
            const haystack = [
              listing.slug,
              listing.title.en,
              listing.title.zh,
              listing.summary.en,
              listing.summary.zh,
            ]
              .join('\n')
              .toLowerCase();
            if (!haystack.includes(needle)) return false;
          }
          return true;
        });

        const byUpdated = (a: ListingRecord, b: ListingRecord) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
        if (input.sort === 'stars') {
          items.sort((a, b) => b.starCount - a.starCount || byUpdated(a, b));
        } else if (input.sort === 'downloads') {
          items.sort((a, b) => b.downloadCount - a.downloadCount || byUpdated(a, b));
        } else {
          items.sort(byUpdated);
        }

        const total = items.length;
        return { items: items.slice(input.offset, input.offset + input.limit).map((item) => clone(item)), total };
      },

      async listByOwner(ownerId) {
        return Array.from(listings.values())
          .filter((listing) => listing.ownerId === ownerId)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .map((listing) => clone(listing));
      },

      async upsert(input) {
        const existing = Array.from(listings.values()).find((listing) => listing.slug === input.slug);

        if (existing && existing.ownerId !== input.ownerId) throw new SlugTakenError(input.slug);

        const record: ListingRecord = existing
          ? {
              ...existing,
              kind: input.kind,
              title: input.title,
              summary: input.summary,
              difficulty: input.difficulty,
              tags: input.tags,
              language: input.language,
              payload: input.payload,
              changelog: input.changelog,
              version: existing.version + 1,
              updatedAt: now(),
            }
          : {
              id: randomUUID(),
              slug: input.slug,
              kind: input.kind,
              ownerId: input.ownerId,
              title: input.title,
              summary: input.summary,
              difficulty: input.difficulty,
              tags: input.tags,
              language: input.language,
              payload: input.payload,
              version: 1,
              changelog: input.changelog,
              starCount: 0,
              downloadCount: 0,
              createdAt: now(),
              updatedAt: now(),
            };

        listings.set(record.id, record);

        if (!versions.some((row) => row.listingId === record.id && row.version === record.version)) {
          versions.push({
            listingId: record.id,
            version: record.version,
            payload: input.payload,
            changelog: input.changelog,
            createdAt: now(),
          });
        }

        return clone(record);
      },

      async remove(id) {
        listings.delete(id);
        for (let i = versions.length - 1; i >= 0; i -= 1) {
          if (versions[i].listingId === id) versions.splice(i, 1);
        }
        for (const key of Array.from(stars)) {
          if (key.endsWith(`::${id}`)) stars.delete(key);
        }
      },

      async incrementDownloads(id) {
        const listing = listings.get(id);
        if (!listing) return 0;
        listing.downloadCount += 1;
        return listing.downloadCount;
      },

      async versions(listingId) {
        return versions
          .filter((row) => row.listingId === listingId)
          .sort((a, b) => b.version - a.version)
          .slice(0, 50)
          .map((row) => ({ version: row.version, changelog: row.changelog, createdAt: row.createdAt }));
      },
    },

    stars: {
      async add(userId, listingId) {
        const listing = listings.get(listingId);
        if (!listing) return 0;
        const key = starKey(userId, listingId);
        if (!stars.has(key)) {
          stars.add(key);
          listing.starCount += 1;
        }
        return listing.starCount;
      },

      async remove(userId, listingId) {
        const listing = listings.get(listingId);
        if (!listing) return 0;
        const key = starKey(userId, listingId);
        if (stars.has(key)) {
          stars.delete(key);
          listing.starCount = Math.max(0, listing.starCount - 1);
        }
        return listing.starCount;
      },

      async starredListingIds(userId, listingIds) {
        const result = new Set<string>();
        for (const listingId of listingIds) {
          if (stars.has(starKey(userId, listingId))) result.add(listingId);
        }
        return result;
      },
    },
  };
}
