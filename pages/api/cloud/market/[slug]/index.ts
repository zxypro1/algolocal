import { createHandler, forbidden, notFound, queryString } from '../../../../../src/lib/server/cloud/http';
import { optionalUser, requireUser } from '../../../../../src/lib/server/cloud/auth';
import { loadAuthors, loadStarred, toDetail } from '../../../../../src/lib/server/cloud/present';
import type { ListingDetail } from '../../../../../src/lib/cloud/types';

export default createHandler({
  async GET({ req, res, repositories }): Promise<ListingDetail> {
    const slug = queryString(req, 'slug');
    if (!slug) throw notFound();

    const listing = await repositories.listings.findBySlug(slug);
    if (!listing) throw notFound(`No listing named "${slug}"`);

    const viewer = await optionalUser(req, repositories);
    const [authors, starred, versions] = await Promise.all([
      loadAuthors(repositories, [listing]),
      loadStarred(repositories, viewer?.user.id ?? null, [listing]),
      repositories.listings.versions(listing.id),
    ]);

    res.setHeader('Cache-Control', viewer ? 'private, no-store' : 'public, max-age=60, stale-while-revalidate=300');

    // 详情页要展示题面和关卡结构，所以带 payload。计数交给 /download，
    // 否则每次刷新页面都算一次下载。
    return toDetail(listing, authors, starred, versions, { includePayload: true });
  },

  async DELETE({ req, repositories }) {
    const slug = queryString(req, 'slug');
    if (!slug) throw notFound();

    const { user } = await requireUser(req, repositories);
    const listing = await repositories.listings.findBySlug(slug);
    if (!listing) throw notFound(`No listing named "${slug}"`);
    if (listing.ownerId !== user.id) throw forbidden('Only the author can remove a listing');

    await repositories.listings.remove(listing.id);
    return undefined;
  },
});
