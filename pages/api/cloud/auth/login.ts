import { createHandler, requireBody } from '../../../../src/lib/server/cloud/http';
import { AuthError, issueSession, toPublicUser, verifyPassword } from '../../../../src/lib/server/cloud/auth';
import type { AuthResult } from '../../../../src/lib/cloud/types';

export default createHandler(
  {
    async POST({ req, repositories }): Promise<AuthResult> {
      const { email, password } = requireBody<{ email: string; password: string }>(req);

      if (typeof email !== 'string' || typeof password !== 'string') {
        throw new AuthError('bad_request', 'Email and password are required');
      }

      const user = await repositories.users.findByEmail(email);

      // 用户不存在和密码错误返回同一句话：区分开来等于把「这个邮箱注册过吗」
      // 变成一个免费查询接口
      const ok = user ? await verifyPassword(password, user.passwordHash) : false;
      if (!user || !ok) {
        throw new AuthError('unauthorized', 'Incorrect email or password');
      }

      const session = await issueSession(user.id, repositories);
      return { token: session.token, expiresAt: session.expiresAt, user: toPublicUser(user) };
    },
  },
  { rateLimit: { windowMs: 10 * 60 * 1000, max: 20, key: 'auth:login' } }
);
