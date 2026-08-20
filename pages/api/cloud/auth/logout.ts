import { createHandler } from '../../../../src/lib/server/cloud/http';
import { optionalUser } from '../../../../src/lib/server/cloud/auth';

export default createHandler({
  async POST({ req, repositories }) {
    const authenticated = await optionalUser(req, repositories);

    // 已经失效的 token 再退一次也算成功。让「退出登录」报错除了吓人没有别的作用。
    if (authenticated) {
      await repositories.sessions.deleteByTokenHash(authenticated.tokenHash);
    }

    return undefined;
  },
});
