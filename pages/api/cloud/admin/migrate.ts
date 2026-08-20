/**
 * 手动触发一次数据库迁移
 *
 * 正常路径是部署流水线里的 `npm run db:migrate`。这个接口是给「已经上线了、
 * 但流水线没跑到」的情况准备的补救口子，所以要求一个只有部署者知道的 token，
 * 且 token 没配时整个接口直接不存在（404 而不是 401 —— 没必要告诉扫描器
 * 这里有一个管理接口）。
 */
import { createHash, timingSafeEqual } from 'crypto';
import { createHandler, notFound } from '../../../../src/lib/server/cloud/http';
import { migrate } from '../../../../src/lib/server/cloud/repo';

/** 先各自哈希再比，长度不同也能常数时间比较 */
function secretEquals(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export default createHandler(
  {
    async POST({ req }) {
      const expected = process.env.MIGRATION_TOKEN?.trim();
      if (!expected) throw notFound();

      const provided = req.headers['x-migration-token'];
      const token = Array.isArray(provided) ? provided[0] : provided;
      if (typeof token !== 'string' || !secretEquals(token, expected)) throw notFound();

      return migrate();
    },
  },
  { requireCloud: false, rateLimit: { windowMs: 60 * 1000, max: 5, key: 'admin:migrate' } }
);
