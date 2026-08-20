/**
 * Postgres（Neon）仓储实现
 *
 * 用 Neon 的 HTTP 驱动：Serverless 函数活不过一次请求，传统连接池在这里
 * 只会把连接数耗光。HTTP 驱动没有会话，所以凡是「读-改-写」的操作都写成
 * 一条带 CTE 的语句，靠数据库自己保证原子性，而不是在应用层拼两次往返。
 */
import type { ListingDifficulty, ListingKind, LocalizedText } from '../../../cloud/types';
import type { SqlExecutor } from './schema';
import {
  normalizeEmail,
  type ListingRecord,
  type ListingVersionRecord,
  type Repositories,
  type SearchListingsInput,
  type SessionRecord,
  type UpsertListingInput,
  type UserRecord,
} from './types';

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date().toISOString();
}

function toUser(row: any): UserRecord {
  return {
    id: String(row.id),
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url ?? null,
    passwordHash: row.password_hash ?? null,
    githubId: row.github_id ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toSession(row: any): SessionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenHash: row.token_hash,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

/** jsonb 列在不同驱动下可能already-parsed，也可能是字符串，这里两种都接 */
function asJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function toListing(row: any): ListingRecord {
  return {
    id: String(row.id),
    slug: row.slug,
    kind: row.kind as ListingKind,
    ownerId: String(row.owner_id),
    title: asJson<LocalizedText>(row.title, { en: '', zh: '' }),
    summary: asJson<LocalizedText>(row.summary, { en: '', zh: '' }),
    difficulty: row.difficulty as ListingDifficulty,
    tags: Array.isArray(row.tags) ? row.tags : asJson<string[]>(row.tags, []),
    language: row.language ?? null,
    payload: asJson<unknown>(row.payload, null),
    version: Number(row.version) || 1,
    changelog: row.changelog ?? null,
    starCount: Number(row.star_count) || 0,
    downloadCount: Number(row.download_count) || 0,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const SORT_COLUMNS: Record<SearchListingsInput['sort'], string> = {
  recent: 'updated_at DESC',
  stars: 'star_count DESC, updated_at DESC',
  downloads: 'download_count DESC, updated_at DESC',
};

export function createPostgresRepositories(sql: SqlExecutor): Repositories {
  return {
    kind: 'postgres',

    users: {
      async findById(id) {
        if (!isUuid(id)) return null;
        const rows = await sql(`SELECT * FROM cloud_users WHERE id = $1`, [id]);
        return rows[0] ? toUser(rows[0]) : null;
      },

      async findByIds(ids) {
        const valid = ids.filter(isUuid);
        if (!valid.length) return [];
        const rows = await sql(`SELECT * FROM cloud_users WHERE id = ANY($1::uuid[])`, [valid]);
        return rows.map(toUser);
      },

      async findByEmail(email) {
        const rows = await sql(`SELECT * FROM cloud_users WHERE email = $1`, [normalizeEmail(email)]);
        return rows[0] ? toUser(rows[0]) : null;
      },

      async findByGithubId(githubId) {
        const rows = await sql(`SELECT * FROM cloud_users WHERE github_id = $1`, [String(githubId)]);
        return rows[0] ? toUser(rows[0]) : null;
      },

      async create(input) {
        const rows = await sql(
          `INSERT INTO cloud_users (email, display_name, password_hash, github_id, avatar_url)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [
            normalizeEmail(input.email),
            input.displayName,
            input.passwordHash,
            input.githubId,
            input.avatarUrl,
          ]
        );
        return toUser(rows[0]);
      },

      async update(id, patch) {
        const rows = await sql(
          `UPDATE cloud_users
              SET display_name  = COALESCE($2, display_name),
                  avatar_url    = COALESCE($3, avatar_url),
                  password_hash = COALESCE($4, password_hash),
                  github_id     = COALESCE($5, github_id),
                  updated_at    = now()
            WHERE id = $1
            RETURNING *`,
          [
            id,
            patch.displayName ?? null,
            patch.avatarUrl ?? null,
            patch.passwordHash ?? null,
            patch.githubId ?? null,
          ]
        );
        if (!rows[0]) throw new Error(`User ${id} not found`);
        return toUser(rows[0]);
      },
    },

    sessions: {
      async create(input) {
        const rows = await sql(
          `INSERT INTO cloud_sessions (user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [input.userId, input.tokenHash, input.expiresAt]
        );
        return toSession(rows[0]);
      },

      async findByTokenHash(tokenHash) {
        const rows = await sql(
          `SELECT * FROM cloud_sessions WHERE token_hash = $1 AND expires_at > now()`,
          [tokenHash]
        );
        return rows[0] ? toSession(rows[0]) : null;
      },

      async touch(id) {
        await sql(`UPDATE cloud_sessions SET last_used_at = now() WHERE id = $1`, [id]);
      },

      async deleteByTokenHash(tokenHash) {
        await sql(`DELETE FROM cloud_sessions WHERE token_hash = $1`, [tokenHash]);
      },

      async deleteByUser(userId) {
        await sql(`DELETE FROM cloud_sessions WHERE user_id = $1`, [userId]);
      },

      async deleteExpired() {
        const rows = await sql(`DELETE FROM cloud_sessions WHERE expires_at <= now() RETURNING 1`);
        return rows.length;
      },
    },

    listings: {
      async findBySlug(slug) {
        const rows = await sql(`SELECT * FROM cloud_listings WHERE slug = $1`, [slug]);
        return rows[0] ? toListing(rows[0]) : null;
      },

      async search(input) {
        const where: string[] = [];
        const params: unknown[] = [];

        const add = (clause: string, value: unknown) => {
          params.push(value);
          where.push(clause.replace('?', `$${params.length}`));
        };

        if (input.kind) add('kind = ?', input.kind);
        if (input.difficulty) add('difficulty = ?', input.difficulty);
        if (input.tag) add('tags @> ARRAY[?]::text[]', input.tag);
        if (input.authorId && isUuid(input.authorId)) add('owner_id = ?', input.authorId);
        if (input.search) {
          params.push(`%${input.search}%`);
          const p = `$${params.length}`;
          where.push(
            `(slug ILIKE ${p} OR title->>'en' ILIKE ${p} OR title->>'zh' ILIKE ${p} OR summary->>'en' ILIKE ${p} OR summary->>'zh' ILIKE ${p})`
          );
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const countRows = await sql(`SELECT count(*)::int AS total FROM cloud_listings ${whereSql}`, params);
        const total = Number(countRows[0]?.total) || 0;

        params.push(input.limit, input.offset);
        const rows = await sql(
          `SELECT * FROM cloud_listings ${whereSql}
            ORDER BY ${SORT_COLUMNS[input.sort]}
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        );

        return { items: rows.map(toListing), total };
      },

      async listByOwner(ownerId) {
        if (!isUuid(ownerId)) return [];
        const rows = await sql(
          `SELECT * FROM cloud_listings WHERE owner_id = $1 ORDER BY updated_at DESC`,
          [ownerId]
        );
        return rows.map(toListing);
      },

      async upsert(input: UpsertListingInput) {
        // 版本自增和历史留档必须和写入同时发生，否则并发发布会漏掉一个版本。
        // 改动 CTE 里带 owner 判断：slug 已经属于别人时不返回行，调用方据此报 403。
        const rows = await sql(
          `WITH upserted AS (
             INSERT INTO cloud_listings
               (slug, kind, owner_id, title, summary, difficulty, tags, language, payload, changelog)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::text[], $8, $9::jsonb, $10)
             ON CONFLICT (slug) DO UPDATE
               SET kind       = EXCLUDED.kind,
                   title      = EXCLUDED.title,
                   summary    = EXCLUDED.summary,
                   difficulty = EXCLUDED.difficulty,
                   tags       = EXCLUDED.tags,
                   language   = EXCLUDED.language,
                   payload    = EXCLUDED.payload,
                   changelog  = EXCLUDED.changelog,
                   version    = cloud_listings.version + 1,
                   updated_at = now()
               WHERE cloud_listings.owner_id = EXCLUDED.owner_id
             RETURNING *
           ), archived AS (
             INSERT INTO cloud_listing_versions (listing_id, version, payload, changelog)
             SELECT id, version, payload, changelog FROM upserted
             ON CONFLICT (listing_id, version) DO NOTHING
             RETURNING 1
           )
           SELECT * FROM upserted`,
          [
            input.slug,
            input.kind,
            input.ownerId,
            JSON.stringify(input.title),
            JSON.stringify(input.summary),
            input.difficulty,
            input.tags,
            input.language,
            JSON.stringify(input.payload),
            input.changelog,
          ]
        );

        if (!rows[0]) throw new SlugTakenError(input.slug);
        return toListing(rows[0]);
      },

      async remove(id) {
        await sql(`DELETE FROM cloud_listings WHERE id = $1`, [id]);
      },

      async incrementDownloads(id) {
        const rows = await sql(
          `UPDATE cloud_listings SET download_count = download_count + 1 WHERE id = $1 RETURNING download_count`,
          [id]
        );
        return Number(rows[0]?.download_count) || 0;
      },

      async versions(listingId): Promise<ListingVersionRecord[]> {
        const rows = await sql(
          `SELECT version, changelog, created_at FROM cloud_listing_versions
            WHERE listing_id = $1 ORDER BY version DESC LIMIT 50`,
          [listingId]
        );
        return rows.map((row: any) => ({
          version: Number(row.version),
          changelog: row.changelog ?? null,
          createdAt: iso(row.created_at),
        }));
      },
    },

    stars: {
      async add(userId, listingId) {
        const rows = await sql(
          `WITH inserted AS (
             INSERT INTO cloud_stars (user_id, listing_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING
             RETURNING 1
           )
           UPDATE cloud_listings
              SET star_count = star_count + (SELECT count(*) FROM inserted)
            WHERE id = $2
            RETURNING star_count`,
          [userId, listingId]
        );
        return Number(rows[0]?.star_count) || 0;
      },

      async remove(userId, listingId) {
        const rows = await sql(
          `WITH deleted AS (
             DELETE FROM cloud_stars WHERE user_id = $1 AND listing_id = $2
             RETURNING 1
           )
           UPDATE cloud_listings
              SET star_count = GREATEST(0, star_count - (SELECT count(*) FROM deleted))
            WHERE id = $2
            RETURNING star_count`,
          [userId, listingId]
        );
        return Number(rows[0]?.star_count) || 0;
      },

      async starredListingIds(userId, listingIds) {
        const valid = listingIds.filter(isUuid);
        if (!isUuid(userId) || !valid.length) return new Set<string>();
        const rows = await sql(
          `SELECT listing_id FROM cloud_stars WHERE user_id = $1 AND listing_id = ANY($2::uuid[])`,
          [userId, valid]
        );
        return new Set(rows.map((row: any) => String(row.listing_id)));
      },
    },
  };
}

/** 发布时 slug 已被别人占用。单独立一个类型，路由层才能把它翻成 403 而不是 500。 */
export class SlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`Slug "${slug}" belongs to another account`);
    this.name = 'SlugTakenError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 传一个非法 uuid 给 Postgres 会直接抛语法错误，而不是返回空结果。
 * 用户可以随手在 URL 里塞任何东西，那应该是 404，不是 500。
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
