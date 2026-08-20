import { createHandler, notFound, queryString } from '../../../../../src/lib/server/cloud/http';
import { optionalUser } from '../../../../../src/lib/server/cloud/auth';
import { loadAuthors, loadStarred, toDetail } from '../../../../../src/lib/server/cloud/present';
import type { ListingDetail } from '../../../../../src/lib/cloud/types';

/**
 * 下载一道题的完整内容，并记一次下载。
 *
 * 不要求登录：市场的价值在于东西能被拿走用。计数用 POST 而不是 GET，
 * 一来它确实有副作用，二来 GET 会被各级缓存和预取悄悄放大成假的下载量。
 */
export default createHandler(
  {
    async POST({ req, res, repositories }): Promise<ListingDetail> {
      const slug = queryString(req, 'slug');
      if (!slug) throw notFound();

      const listing = await repositories.listings.findBySlug(slug);
      if (!listing) throw notFound(`No listing named "${slug}"`);

      const viewer = await optionalUser(req, repositories);
      const [authors, starred, versions, downloadCount] = await Promise.all([
        loadAuthors(repositories, [listing]),
        loadStarred(repositories, viewer?.user.id ?? null, [listing]),
        repositories.listings.versions(listing.id),
        repositories.listings.incrementDownloads(listing.id),
      ]);

      res.setHeader('Cache-Control', 'no-store');

      return {
        ...toDetail(listing, authors, starred, versions, { includePayload: true }),
        downloadCount,
      };
    },
  },
  { rateLimit: { windowMs: 60 * 1000, max: 60, key: 'market:download' } }
);
