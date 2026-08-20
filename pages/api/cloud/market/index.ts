import { createHandler, queryInt, queryString } from '../../../../src/lib/server/cloud/http';
import { optionalUser } from '../../../../src/lib/server/cloud/auth';
import { loadAuthors, loadStarred, toSummary } from '../../../../src/lib/server/cloud/present';
import type { ListingDifficulty, ListingKind, ListingPage } from '../../../../src/lib/cloud/types';

const SORTS = ['recent', 'stars', 'downloads'] as const;

export default createHandler({
  async GET({ req, res, repositories }): Promise<ListingPage> {
    // 浏览市场不要求登录。带了 token 才能知道哪些是自己 star 过的。
    const viewer = await optionalUser(req, repositories);

    const kind = queryString(req, 'kind');
    const difficulty = queryString(req, 'difficulty');
    const requestedSort = queryString(req, 'sort');
    const sort = SORTS.find((candidate) => candidate === requestedSort) || 'recent';
    const page = queryInt(req, 'page', 1, 1, 1000);
    const pageSize = queryInt(req, 'pageSize', 24, 1, 50);

    const { items, total } = await repositories.listings.search({
      kind: kind === 'algorithm' || kind === 'engineering' ? (kind as ListingKind) : undefined,
      difficulty:
        difficulty === 'Easy' || difficulty === 'Medium' || difficulty === 'Hard'
          ? (difficulty as ListingDifficulty)
          : undefined,
      tag: queryString(req, 'tag')?.toLowerCase(),
      search: queryString(req, 'search')?.slice(0, 120),
      authorId: queryString(req, 'author'),
      sort,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    const [authors, starred] = await Promise.all([
      loadAuthors(repositories, items),
      loadStarred(repositories, viewer?.user.id ?? null, items),
    ]);

    // 登录用户的结果里带 starred，不能进共享缓存
    res.setHeader('Cache-Control', viewer ? 'private, no-store' : 'public, max-age=30, stale-while-revalidate=120');

    return {
      items: items.map((listing) => toSummary(listing, authors, starred)),
      total,
      page,
      pageSize,
    };
  },
});
