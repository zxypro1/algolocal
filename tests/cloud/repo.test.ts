/**
 * 仓储实现的一致性
 *
 * 同一组用例跑在两个实现上：内存（本地和 CI 默认）和 Postgres（设了
 * DATABASE_URL 时）。两者行为对不上是最难查的一类问题 —— 测试全绿，
 * 线上挂掉，而且现象是「偶尔重复一条记录」这种。
 *
 * 想在本地跑 Postgres 那一半：
 *   DATABASE_URL=postgres://... npx jest tests/cloud/repo.test.ts
 */
import { createMemoryRepositories } from '../../src/lib/server/cloud/repo/memory';
import { createPostgresRepositories, SlugTakenError } from '../../src/lib/server/cloud/repo/postgres';
import { createSqlExecutor } from '../../src/lib/server/cloud/repo';
import { runMigrations } from '../../src/lib/server/cloud/repo/schema';
import type { Repositories } from '../../src/lib/server/cloud/repo/types';

const DATABASE_URL = (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();

interface Backend {
  name: string;
  create: () => Promise<Repositories>;
  cleanup?: (repositories: Repositories) => Promise<void>;
}

const backends: Backend[] = [
  { name: 'memory', create: async () => createMemoryRepositories() },
];

if (DATABASE_URL) {
  backends.push({
    name: 'postgres',
    create: async () => {
      const sql = createSqlExecutor(DATABASE_URL);
      await runMigrations(sql);
      return createPostgresRepositories(sql);
    },
    cleanup: async () => {
      const sql = createSqlExecutor(DATABASE_URL);
      // 只删测试造出来的账号，级联会带走它们的题目、star 和会话
      await sql(`DELETE FROM cloud_users WHERE email LIKE $1`, ['%@repo-test.invalid']);
    },
  });
} else {
  // 没有连接串时明说跳过。静默少跑一半用例比跑不过更危险。
  console.log('[repo.test] DATABASE_URL is not set — running the memory backend only.');
}

const listingInput = (overrides: Record<string, unknown> = {}) => ({
  slug: 'demo',
  kind: 'algorithm' as const,
  ownerId: '',
  title: { en: 'Demo', zh: '示例' },
  summary: { en: 'A demo', zh: '一个示例' },
  difficulty: 'Easy' as const,
  tags: ['array', 'demo'],
  language: null,
  payload: { hello: 'world', nested: { list: [1, 2, 3] } },
  changelog: null,
  ...overrides,
});

describe.each(backends)('$name repository', (backend) => {
  let repositories: Repositories;
  let counter = 0;

  const uniqueEmail = () => `user-${Date.now()}-${(counter += 1)}@repo-test.invalid`;

  const createUser = () =>
    repositories.users.create({
      email: uniqueEmail(),
      displayName: 'Repo Test',
      passwordHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
      githubId: null,
      avatarUrl: null,
    });

  beforeAll(async () => {
    repositories = await backend.create();
  });

  afterAll(async () => {
    await backend.cleanup?.(repositories);
  });

  describe('users', () => {
    it('finds by id, email and github id', async () => {
      const user = await repositories.users.create({
        email: uniqueEmail(),
        displayName: 'Findable',
        passwordHash: null,
        githubId: `gh-${Date.now()}-${(counter += 1)}`,
        avatarUrl: 'https://example.com/a.png',
      });

      expect((await repositories.users.findById(user.id))!.displayName).toBe('Findable');
      expect((await repositories.users.findByEmail(user.email.toUpperCase()))!.id).toBe(user.id);
      expect((await repositories.users.findByGithubId(user.githubId!))!.id).toBe(user.id);
    });

    it('returns null rather than throwing on a malformed id', async () => {
      // Postgres 会对一个非法 uuid 直接抛语法错误，那会变成 500 而不是 404
      expect(await repositories.users.findById('not-a-uuid')).toBeNull();
      expect(await repositories.users.findByIds(['not-a-uuid'])).toEqual([]);
    });

    it('rejects a duplicate email with a unique violation', async () => {
      const user = await createUser();

      await expect(
        repositories.users.create({
          email: user.email,
          displayName: 'Impostor',
          passwordHash: null,
          githubId: null,
          avatarUrl: null,
        })
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('patches only the fields that were passed', async () => {
      const user = await createUser();
      const updated = await repositories.users.update(user.id, { displayName: 'Renamed' });

      expect(updated.displayName).toBe('Renamed');
      expect(updated.passwordHash).toBe(user.passwordHash);
      expect(updated.email).toBe(user.email);
    });

    it('loads several users in one call', async () => {
      const [a, b] = await Promise.all([createUser(), createUser()]);
      const found = await repositories.users.findByIds([a.id, b.id, a.id]);

      expect(found.map((user) => user.id).sort()).toEqual([a.id, b.id].sort());
    });
  });

  describe('sessions', () => {
    it('finds a live session and ignores an expired one', async () => {
      const user = await createUser();

      await repositories.sessions.create({
        userId: user.id,
        tokenHash: `live-${user.id}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await repositories.sessions.create({
        userId: user.id,
        tokenHash: `dead-${user.id}`,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      expect(await repositories.sessions.findByTokenHash(`live-${user.id}`)).not.toBeNull();
      expect(await repositories.sessions.findByTokenHash(`dead-${user.id}`)).toBeNull();
    });

    it('deletes by token and by user', async () => {
      const user = await createUser();
      await repositories.sessions.create({
        userId: user.id,
        tokenHash: `one-${user.id}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await repositories.sessions.create({
        userId: user.id,
        tokenHash: `two-${user.id}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      await repositories.sessions.deleteByTokenHash(`one-${user.id}`);
      expect(await repositories.sessions.findByTokenHash(`one-${user.id}`)).toBeNull();
      expect(await repositories.sessions.findByTokenHash(`two-${user.id}`)).not.toBeNull();

      await repositories.sessions.deleteByUser(user.id);
      expect(await repositories.sessions.findByTokenHash(`two-${user.id}`)).toBeNull();
    });
  });

  describe('listings', () => {
    it('creates at version 1 and preserves the payload shape', async () => {
      const user = await createUser();
      const slug = `demo-${(counter += 1)}-${Date.now()}`;

      const listing = await repositories.listings.upsert(listingInput({ slug, ownerId: user.id }));

      expect(listing.version).toBe(1);
      expect(listing.starCount).toBe(0);
      expect(listing.downloadCount).toBe(0);
      expect(listing.tags).toEqual(['array', 'demo']);
      // jsonb 往返之后嵌套结构必须一模一样
      expect(listing.payload).toEqual({ hello: 'world', nested: { list: [1, 2, 3] } });
      expect(listing.title).toEqual({ en: 'Demo', zh: '示例' });
    });

    it('bumps the version and archives the old one on re-publish', async () => {
      const user = await createUser();
      const slug = `versioned-${(counter += 1)}-${Date.now()}`;

      await repositories.listings.upsert(listingInput({ slug, ownerId: user.id }));
      const second = await repositories.listings.upsert(
        listingInput({ slug, ownerId: user.id, changelog: 'v2', payload: { hello: 'again' } })
      );

      expect(second.version).toBe(2);
      expect(second.payload).toEqual({ hello: 'again' });

      const versions = await repositories.listings.versions(second.id);
      expect(versions.map((entry) => entry.version)).toEqual([2, 1]);
      expect(versions[0].changelog).toBe('v2');
    });

    it('refuses to overwrite someone else', async () => {
      const [owner, intruder] = await Promise.all([createUser(), createUser()]);
      const slug = `owned-${(counter += 1)}-${Date.now()}`;

      await repositories.listings.upsert(listingInput({ slug, ownerId: owner.id }));

      await expect(
        repositories.listings.upsert(listingInput({ slug, ownerId: intruder.id }))
      ).rejects.toBeInstanceOf(SlugTakenError);

      const stored = await repositories.listings.findBySlug(slug);
      expect(stored!.ownerId).toBe(owner.id);
      expect(stored!.version).toBe(1);
    });

    it('counts downloads', async () => {
      const user = await createUser();
      const slug = `downloads-${(counter += 1)}-${Date.now()}`;
      const listing = await repositories.listings.upsert(listingInput({ slug, ownerId: user.id }));

      expect(await repositories.listings.incrementDownloads(listing.id)).toBe(1);
      expect(await repositories.listings.incrementDownloads(listing.id)).toBe(2);
      expect((await repositories.listings.findBySlug(slug))!.downloadCount).toBe(2);
    });

    it('filters, sorts and paginates', async () => {
      const user = await createUser();
      const stamp = `${(counter += 1)}-${Date.now()}`;

      await repositories.listings.upsert(
        listingInput({ slug: `filter-easy-${stamp}`, ownerId: user.id, difficulty: 'Easy', tags: ['array'] })
      );
      await repositories.listings.upsert(
        listingInput({
          slug: `filter-hard-${stamp}`,
          ownerId: user.id,
          difficulty: 'Hard',
          tags: ['graph'],
          kind: 'engineering',
          language: 'typescript',
        })
      );

      const base = { sort: 'recent' as const, limit: 50, offset: 0, authorId: user.id };

      expect((await repositories.listings.search({ ...base, difficulty: 'Hard' })).total).toBe(1);
      expect((await repositories.listings.search({ ...base, kind: 'engineering' })).total).toBe(1);
      expect((await repositories.listings.search({ ...base, tag: 'array' })).total).toBe(1);
      expect((await repositories.listings.search({ ...base, tag: 'missing' })).total).toBe(0);
      expect((await repositories.listings.search({ ...base, search: 'filter-hard' })).total).toBe(1);

      const paged = await repositories.listings.search({ ...base, limit: 1, offset: 0 });
      expect(paged.items).toHaveLength(1);
      expect(paged.total).toBe(2);
    });

    it('deletes a listing along with its versions', async () => {
      const user = await createUser();
      const slug = `deletable-${(counter += 1)}-${Date.now()}`;
      const listing = await repositories.listings.upsert(listingInput({ slug, ownerId: user.id }));

      await repositories.listings.remove(listing.id);

      expect(await repositories.listings.findBySlug(slug)).toBeNull();
      expect(await repositories.listings.versions(listing.id)).toEqual([]);
    });
  });

  describe('stars', () => {
    it('is idempotent in both directions', async () => {
      const user = await createUser();
      const slug = `starred-${(counter += 1)}-${Date.now()}`;
      const listing = await repositories.listings.upsert(listingInput({ slug, ownerId: user.id }));

      expect(await repositories.stars.add(user.id, listing.id)).toBe(1);
      expect(await repositories.stars.add(user.id, listing.id)).toBe(1);

      expect(await repositories.stars.remove(user.id, listing.id)).toBe(0);
      // 多按一次取消不能把计数减成负数
      expect(await repositories.stars.remove(user.id, listing.id)).toBe(0);
    });

    it('counts each account once', async () => {
      const [a, b] = await Promise.all([createUser(), createUser()]);
      const slug = `shared-${(counter += 1)}-${Date.now()}`;
      const listing = await repositories.listings.upsert(listingInput({ slug, ownerId: a.id }));

      await repositories.stars.add(a.id, listing.id);
      expect(await repositories.stars.add(b.id, listing.id)).toBe(2);

      const starredByA = await repositories.stars.starredListingIds(a.id, [listing.id]);
      expect(starredByA.has(listing.id)).toBe(true);
    });

    it('reports nothing for an anonymous viewer or a malformed id', async () => {
      expect((await repositories.stars.starredListingIds('not-a-uuid', ['x'])).size).toBe(0);
    });
  });
});
