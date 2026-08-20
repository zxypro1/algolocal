import { createHandler, requireBody } from '../../../../src/lib/server/cloud/http';
import { requireUser } from '../../../../src/lib/server/cloud/auth';
import { normalizeListing, resolveSlug } from '../../../../src/lib/server/cloud/listing';
import { loadAuthors, loadStarred, toDetail } from '../../../../src/lib/server/cloud/present';
import type { ListingDetail, PublishRequest } from '../../../../src/lib/cloud/types';

export default createHandler(
  {
    async POST({ req, repositories }): Promise<{ listing: ListingDetail }> {
      const { user } = await requireUser(req, repositories);
      const body = requireBody<PublishRequest>(req);

      const normalized = normalizeListing(body.kind, body.payload);

      const slug = await resolveSlug(
        normalized.desiredSlug,
        user.id,
        (candidate) => repositories.listings.findBySlug(candidate),
        typeof body.slug === 'string' ? body.slug : undefined
      );

      const listing = await repositories.listings.upsert({
        slug,
        kind: normalized.kind,
        ownerId: user.id,
        title: normalized.title,
        summary: normalized.summary,
        difficulty: normalized.difficulty,
        tags: normalized.tags,
        language: normalized.language,
        payload: normalized.payload,
        changelog: typeof body.changelog === 'string' ? body.changelog.slice(0, 500) : null,
      });

      const [authors, starred, versions] = await Promise.all([
        loadAuthors(repositories, [listing]),
        loadStarred(repositories, user.id, [listing]),
        repositories.listings.versions(listing.id),
      ]);

      // 发布结果不回传 payload：发布者本来就有这份内容，回传一遍只是让
      // 一次已经不小的请求再翻一倍
      return { listing: toDetail(listing, authors, starred, versions, { includePayload: false }) };
    },
  },
  { rateLimit: { windowMs: 60 * 60 * 1000, max: 60, key: 'market:publish' } }
);

export const config = {
  api: {
    // 默认 1MB 挡不住一道带隐藏用例和参考实现的工程题，真正的上限在
    // normalizeListing 里按 payload 字节数判，错误信息也更具体
    bodyParser: { sizeLimit: '4mb' },
  },
};
