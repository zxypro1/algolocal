/**
 * 云端 API 的集成测试
 *
 * 跑的是真实的路由 + 真实的仓储（内存实现），只有网络这一层是伪造的。
 * 覆盖的是一条完整的用户路径：注册 → 发布 → 浏览 → star → 下载 → 改版本
 * → 删除，外加各种「不该成功的事情不能成功」。
 */
import { call, useMemoryCloud } from './harness';

useMemoryCloud();

// 环境变量要在路由模块被 require 之前设好，所以这里用 require 而不是顶层 import
/* eslint-disable @typescript-eslint/no-var-requires */
const healthHandler = require('../../pages/api/cloud/health').default;
const registerHandler = require('../../pages/api/cloud/auth/register').default;
const loginHandler = require('../../pages/api/cloud/auth/login').default;
const logoutHandler = require('../../pages/api/cloud/auth/logout').default;
const meHandler = require('../../pages/api/cloud/auth/me').default;
const marketHandler = require('../../pages/api/cloud/market/index').default;
const publishHandler = require('../../pages/api/cloud/market/publish').default;
const mineHandler = require('../../pages/api/cloud/market/mine').default;
const detailHandler = require('../../pages/api/cloud/market/[slug]/index').default;
const starHandler = require('../../pages/api/cloud/market/[slug]/star').default;
const downloadHandler = require('../../pages/api/cloud/market/[slug]/download').default;
const { resetRepositories } = require('../../src/lib/server/cloud/repo');
const { resetRateLimits } = require('../../src/lib/server/cloud/http');
const { blankAlgorithmProblem, blankEngineeringProject } = require('../../src/lib/workshop/templates');
/* eslint-enable @typescript-eslint/no-var-requires */

async function registerUser(email: string, displayName = 'Test Author'): Promise<string> {
  const response = await call(registerHandler, {
    method: 'POST',
    body: { email, password: 'correct horse battery', displayName },
  });
  expect(response.status).toBe(200);
  return response.body.token;
}

describe('cloud API', () => {
  beforeEach(() => {
    resetRepositories();
    resetRateLimits();
  });

  describe('health', () => {
    it('reports the configured capabilities', async () => {
      const response = await call(healthHandler);

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.features).toMatchObject({ database: true, accounts: true, market: true });
      expect(typeof response.body.version).toBe('string');
    });

    it('answers 200 even with no database configured', async () => {
      delete process.env.ALGOLOCAL_CLOUD_MEMORY;
      try {
        const response = await call(healthHandler);
        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(false);
        expect(response.body.features.database).toBe(false);
      } finally {
        process.env.ALGOLOCAL_CLOUD_MEMORY = '1';
      }
    });

    it('turns other routes into 503 rather than a stack trace when nothing is configured', async () => {
      delete process.env.ALGOLOCAL_CLOUD_MEMORY;
      resetRepositories();
      try {
        const response = await call(marketHandler);
        expect(response.status).toBe(503);
        expect(response.body.error.code).toBe('cloud_disabled');
      } finally {
        process.env.ALGOLOCAL_CLOUD_MEMORY = '1';
        resetRepositories();
      }
    });
  });

  describe('accounts', () => {
    it('registers, signs in and reads the profile back', async () => {
      const token = await registerUser('author@example.com');

      const me = await call(meHandler, { token });
      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe('author@example.com');
      expect(me.body.user.providers).toEqual(['password']);

      const login = await call(loginHandler, {
        method: 'POST',
        body: { email: 'AUTHOR@example.com', password: 'correct horse battery' },
      });
      expect(login.status).toBe(200);
      expect(login.body.user.id).toBe(me.body.user.id);
    });

    it('never returns the password hash', async () => {
      const token = await registerUser('hash@example.com');
      const me = await call(meHandler, { token });

      expect(JSON.stringify(me.body)).not.toMatch(/scrypt/);
      expect(me.body.user.passwordHash).toBeUndefined();
    });

    it('rejects a duplicate email', async () => {
      await registerUser('dup@example.com');
      const second = await call(registerHandler, {
        method: 'POST',
        body: { email: 'dup@example.com', password: 'another password', displayName: 'Someone Else' },
      });

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('conflict');
    });

    it('rejects a short password', async () => {
      const response = await call(registerHandler, {
        method: 'POST',
        body: { email: 'short@example.com', password: 'abc', displayName: 'Short' },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/8 characters/);
    });

    it('gives the same answer for a wrong password and an unknown account', async () => {
      await registerUser('known@example.com');

      const wrongPassword = await call(loginHandler, {
        method: 'POST',
        body: { email: 'known@example.com', password: 'not the password' },
      });
      const unknownUser = await call(loginHandler, {
        method: 'POST',
        body: { email: 'nobody@example.com', password: 'not the password' },
      });

      expect(wrongPassword.status).toBe(401);
      expect(unknownUser.status).toBe(401);
      expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
    });

    it('invalidates the token after signing out', async () => {
      const token = await registerUser('bye@example.com');

      expect((await call(meHandler, { token })).status).toBe(200);
      expect((await call(logoutHandler, { method: 'POST', token })).status).toBe(204);
      expect((await call(meHandler, { token })).status).toBe(401);
    });

    it('signs out other sessions when the password changes', async () => {
      const first = await registerUser('rotate@example.com');
      const second = (
        await call(loginHandler, {
          method: 'POST',
          body: { email: 'rotate@example.com', password: 'correct horse battery' },
        })
      ).body.token;

      const changed = await call(meHandler, {
        method: 'PATCH',
        token: second,
        body: { password: 'a brand new password', currentPassword: 'correct horse battery' },
      });

      expect(changed.status).toBe(200);
      expect((await call(meHandler, { token: second })).status).toBe(200);
      expect((await call(meHandler, { token: first })).status).toBe(401);
    });

    it('refuses a password change without the current password', async () => {
      const token = await registerUser('guard@example.com');

      const response = await call(meHandler, {
        method: 'PATCH',
        token,
        body: { password: 'a brand new password', currentPassword: 'wrong' },
      });

      expect(response.status).toBe(401);
    });

    it('requires a token on protected routes', async () => {
      expect((await call(meHandler)).status).toBe(401);
      expect((await call(mineHandler)).status).toBe(401);
      expect((await call(publishHandler, { method: 'POST', body: {} })).status).toBe(401);
    });
  });

  describe('publishing', () => {
    it('publishes, lists, stars and downloads a problem', async () => {
      const token = await registerUser('publisher@example.com', 'Publisher');

      const published = await call(publishHandler, {
        method: 'POST',
        token,
        body: { kind: 'algorithm', payload: blankAlgorithmProblem() },
      });
      expect(published.status).toBe(200);
      expect(published.body.listing.slug).toBe('sum-of-two-numbers');
      expect(published.body.listing.version).toBe(1);
      // 列表和发布结果都不该带完整内容
      expect(published.body.listing.payload).toBeNull();

      const list = await call(marketHandler, { token });
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0].author.displayName).toBe('Publisher');
      expect(list.body.items[0].starred).toBe(false);
      expect((list.body.items[0] as any).payload).toBeUndefined();

      const starred = await call(starHandler, {
        method: 'POST',
        token,
        query: { slug: 'sum-of-two-numbers' },
      });
      expect(starred.body).toEqual({ starCount: 1, starred: true });

      // star 两次仍然只算一次
      const again = await call(starHandler, {
        method: 'POST',
        token,
        query: { slug: 'sum-of-two-numbers' },
      });
      expect(again.body.starCount).toBe(1);

      const unstarred = await call(starHandler, {
        method: 'DELETE',
        token,
        query: { slug: 'sum-of-two-numbers' },
      });
      expect(unstarred.body).toEqual({ starCount: 0, starred: false });

      const downloaded = await call(downloadHandler, {
        method: 'POST',
        query: { slug: 'sum-of-two-numbers' },
      });
      expect(downloaded.status).toBe(200);
      expect(downloaded.body.downloadCount).toBe(1);
      expect((downloaded.body.payload as any).tests.length).toBeGreaterThan(0);
    });

    it('publishes an engineering project with its stages intact', async () => {
      const token = await registerUser('eng@example.com');

      const published = await call(publishHandler, {
        method: 'POST',
        token,
        body: { kind: 'engineering', payload: blankEngineeringProject() },
      });
      expect(published.status).toBe(200);
      expect(published.body.listing.language).toBe('typescript');

      const detail = await call(detailHandler, { query: { slug: published.body.listing.slug } });
      expect(detail.status).toBe(200);
      expect((detail.body.payload as any).stages).toHaveLength(1);
      expect((detail.body.payload as any).stages[0].specs).toHaveLength(1);
    });

    it('treats a second publish of the same id as a new version', async () => {
      const token = await registerUser('versions@example.com');
      const problem = blankAlgorithmProblem();

      await call(publishHandler, { method: 'POST', token, body: { kind: 'algorithm', payload: problem } });

      const second = await call(publishHandler, {
        method: 'POST',
        token,
        body: {
          kind: 'algorithm',
          slug: 'sum-of-two-numbers',
          payload: { ...problem, title: { en: 'Renamed', zh: '改名了' } },
          changelog: 'Renamed it',
        },
      });

      expect(second.status).toBe(200);
      expect(second.body.listing.version).toBe(2);
      expect(second.body.listing.title.en).toBe('Renamed');
      expect(second.body.listing.versions.map((entry: any) => entry.version)).toEqual([2, 1]);

      const list = await call(marketHandler);
      expect(list.body.total).toBe(1);
    });

    it('gives a second author a different slug instead of overwriting', async () => {
      const first = await registerUser('first@example.com', 'First');
      const second = await registerUser('second@example.com', 'Second');

      const a = await call(publishHandler, {
        method: 'POST',
        token: first,
        body: { kind: 'algorithm', payload: blankAlgorithmProblem() },
      });
      const b = await call(publishHandler, {
        method: 'POST',
        token: second,
        body: { kind: 'algorithm', payload: blankAlgorithmProblem() },
      });

      expect(a.body.listing.slug).toBe('sum-of-two-numbers');
      expect(b.body.listing.slug).toBe('sum-of-two-numbers-2');
    });

    it('refuses an explicit slug that belongs to someone else', async () => {
      const first = await registerUser('owner@example.com');
      const second = await registerUser('intruder@example.com');

      await call(publishHandler, {
        method: 'POST',
        token: first,
        body: { kind: 'algorithm', payload: blankAlgorithmProblem() },
      });

      const attempt = await call(publishHandler, {
        method: 'POST',
        token: second,
        body: { kind: 'algorithm', slug: 'sum-of-two-numbers', payload: blankAlgorithmProblem() },
      });

      expect(attempt.status).toBe(400);
      expect(attempt.body.error.message).toMatch(/already published/);
    });

    it('rejects a problem that would not run', async () => {
      const token = await registerUser('broken@example.com');

      const response = await call(publishHandler, {
        method: 'POST',
        token,
        body: {
          kind: 'algorithm',
          payload: { ...blankAlgorithmProblem(), tests: [] },
        },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.details.some((issue: any) => issue.field === 'tests')).toBe(true);
    });

    it('rejects an unknown kind', async () => {
      const token = await registerUser('kind@example.com');
      const response = await call(publishHandler, {
        method: 'POST',
        token,
        body: { kind: 'recipe', payload: blankAlgorithmProblem() },
      });

      expect(response.status).toBe(400);
    });

    it('only lets the author delete', async () => {
      const owner = await registerUser('deleter@example.com');
      const other = await registerUser('other@example.com');

      await call(publishHandler, {
        method: 'POST',
        token: owner,
        body: { kind: 'algorithm', payload: blankAlgorithmProblem() },
      });

      const byOther = await call(detailHandler, {
        method: 'DELETE',
        token: other,
        query: { slug: 'sum-of-two-numbers' },
      });
      expect(byOther.status).toBe(403);

      const byOwner = await call(detailHandler, {
        method: 'DELETE',
        token: owner,
        query: { slug: 'sum-of-two-numbers' },
      });
      expect(byOwner.status).toBe(204);
      expect((await call(detailHandler, { query: { slug: 'sum-of-two-numbers' } })).status).toBe(404);
    });
  });

  describe('browsing', () => {
    beforeEach(async () => {
      const token = await registerUser('catalog@example.com');
      const problem = blankAlgorithmProblem();

      await call(publishHandler, {
        method: 'POST',
        token,
        body: { kind: 'algorithm', payload: { ...problem, id: 'easy-one', difficulty: 'Easy', tags: ['array'] } },
      });
      await call(publishHandler, {
        method: 'POST',
        token,
        body: { kind: 'algorithm', payload: { ...problem, id: 'hard-one', difficulty: 'Hard', tags: ['graph'] } },
      });
      await call(publishHandler, {
        method: 'POST',
        token,
        body: { kind: 'engineering', payload: blankEngineeringProject() },
      });
    });

    it('filters by kind, difficulty and tag', async () => {
      expect((await call(marketHandler, { query: { kind: 'engineering' } })).body.total).toBe(1);
      expect((await call(marketHandler, { query: { difficulty: 'Hard' } })).body.total).toBe(1);
      expect((await call(marketHandler, { query: { tag: 'graph' } })).body.total).toBe(1);
      expect((await call(marketHandler, { query: { tag: 'nonexistent' } })).body.total).toBe(0);
    });

    it('searches titles and slugs', async () => {
      expect((await call(marketHandler, { query: { search: 'hard-one' } })).body.total).toBe(1);
      expect((await call(marketHandler, { query: { search: 'Engineering' } })).body.total).toBe(1);
    });

    it('paginates', async () => {
      const first = await call(marketHandler, { query: { pageSize: '2', page: '1' } });
      const second = await call(marketHandler, { query: { pageSize: '2', page: '2' } });

      expect(first.body.items).toHaveLength(2);
      expect(second.body.items).toHaveLength(1);
      expect(first.body.total).toBe(3);

      const firstSlugs = first.body.items.map((item: any) => item.slug);
      expect(firstSlugs).not.toContain(second.body.items[0].slug);
    });

    it('clamps an absurd page size instead of trusting it', async () => {
      const response = await call(marketHandler, { query: { pageSize: '100000' } });
      expect(response.body.pageSize).toBeLessThanOrEqual(50);
    });

    it('404s on an unknown slug rather than erroring', async () => {
      const response = await call(detailHandler, { query: { slug: 'does-not-exist' } });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('not_found');
    });
  });

  describe('method routing', () => {
    it('answers preflight without touching the database', async () => {
      const response = await call(marketHandler, { method: 'OPTIONS' });

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-headers']).toContain('Authorization');
    });

    it('405s an unsupported method and says what is allowed', async () => {
      const response = await call(marketHandler, { method: 'DELETE' });

      expect(response.status).toBe(405);
      expect(String(response.headers.allow)).toContain('GET');
    });
  });
});
