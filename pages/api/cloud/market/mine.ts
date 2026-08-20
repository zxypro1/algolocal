import { createHandler } from '../../../../src/lib/server/cloud/http';
import { requireUser } from '../../../../src/lib/server/cloud/auth';
import { loadAuthors, loadStarred, toDetail } from '../../../../src/lib/server/cloud/present';
import type { ListingDetail } from '../../../../src/lib/cloud/types';

export default createHandler({
  async GET({ req, res, repositories }): Promise<{ items: ListingDetail[] }> {
    const { user } = await requireUser(req, repositories);

    const listings = await repositories.listings.listByOwner(user.id);
    const [authors, starred] = await Promise.all([
      loadAuthors(repositories, listings),
      loadStarred(repositories, user.id, listings),
    ]);

    res.setHeader('Cache-Control', 'private, no-store');

    // 「我发布的」是一个管理界面，只需要元信息；要看内容点进详情页
    return {
      items: listings.map((listing) => toDetail(listing, authors, starred, [], { includePayload: false })),
    };
  },
});
