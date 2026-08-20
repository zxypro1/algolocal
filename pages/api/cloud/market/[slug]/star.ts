import type { NextApiRequest } from 'next';
import { createHandler, notFound, queryString } from '../../../../../src/lib/server/cloud/http';
import { requireUser } from '../../../../../src/lib/server/cloud/auth';
import type { ListingRecord, Repositories } from '../../../../../src/lib/server/cloud/repo/types';

/**
 * star 与取消 star。
 *
 * 用 POST/DELETE 两个方法而不是一个 toggle 接口：toggle 在网络抖动重发时
 * 会把「点了一次」变成「点了两次又取消」，最终状态取决于重试次数的奇偶。
 */
export default createHandler({
  async POST({ req, repositories }): Promise<{ starCount: number; starred: boolean }> {
    const { user } = await requireUser(req, repositories);
    const listing = await listingOf(req, repositories);

    const starCount = await repositories.stars.add(user.id, listing.id);
    return { starCount, starred: true };
  },

  async DELETE({ req, repositories }): Promise<{ starCount: number; starred: boolean }> {
    const { user } = await requireUser(req, repositories);
    const listing = await listingOf(req, repositories);

    const starCount = await repositories.stars.remove(user.id, listing.id);
    return { starCount, starred: false };
  },
});

async function listingOf(req: NextApiRequest, repositories: Repositories): Promise<ListingRecord> {
  const slug = queryString(req, 'slug');
  if (!slug) throw notFound();

  const listing = await repositories.listings.findBySlug(slug);
  if (!listing) throw notFound(`No listing named "${slug}"`);
  return listing;
}
