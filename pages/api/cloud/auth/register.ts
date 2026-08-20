import { createHandler, badRequest, conflict, requireBody } from '../../../../src/lib/server/cloud/http';
import {
  hashPassword,
  issueSession,
  toPublicUser,
  validateDisplayName,
  validateEmail,
  validatePassword,
} from '../../../../src/lib/server/cloud/auth';
import { normalizeEmail } from '../../../../src/lib/server/cloud/repo/types';
import type { AuthResult } from '../../../../src/lib/cloud/types';

export default createHandler(
  {
    async POST({ req, repositories }): Promise<AuthResult> {
      const { email, password, displayName } = requireBody<{
        email: string;
        password: string;
        displayName: string;
      }>(req);

      const problem =
        validateEmail(email) || validatePassword(password) || validateDisplayName(displayName);
      if (problem) throw badRequest(problem);

      const existing = await repositories.users.findByEmail(email);
      if (existing) {
        // 说清楚是「已注册」而不是含糊其辞：邮箱是否注册过本来就可以通过
        // 「找回密码」流程探到，含糊只会让真正的用户困惑
        throw conflict('That email address is already registered');
      }

      const user = await repositories.users.create({
        email: normalizeEmail(email),
        displayName: displayName.trim(),
        passwordHash: await hashPassword(password),
        githubId: null,
        avatarUrl: null,
      });

      const session = await issueSession(user.id, repositories);
      return { token: session.token, expiresAt: session.expiresAt, user: toPublicUser(user) };
    },
  },
  // 注册比登录更值得限死：一个 IP 十分钟开五个号已经不像正常使用
  { rateLimit: { windowMs: 10 * 60 * 1000, max: 5, key: 'auth:register' } }
);
