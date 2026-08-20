/**
 * 云端健康检查
 *
 * 客户端每次进入市场或账号页都会先打一次，用来决定是渲染内容还是渲染离线态。
 * 它是唯一一个 requireCloud: false 的路由 —— 数据库没配的时候它必须仍然
 * 返回 200，把 features.database 标成 false，而不是跟着一起 503。
 */
import { createHandler } from '../../../src/lib/server/cloud/http';
import { capabilitiesOf, readCloudConfig } from '../../../src/lib/server/cloud/env';
import type { CloudHealth } from '../../../src/lib/cloud/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../../../package.json');

export default createHandler(
  {
    async GET({ res }): Promise<CloudHealth> {
      const config = readCloudConfig();
      const features = capabilitiesOf(config);

      // 探测结果可以短暂缓存，但不能缓存到「配好数据库之后还说没配」
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');

      return {
        ok: features.database,
        version,
        features,
        time: new Date().toISOString(),
      };
    },
  },
  { requireCloud: false }
);
