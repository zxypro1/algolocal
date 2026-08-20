import { badRequest, createHandler, requireBody } from '../../../../src/lib/server/cloud/http';
import {
  AuthError,
  hashPassword,
  requireUser,
  toPublicUser,
  validateDisplayName,
  validatePassword,
  verifyPassword,
} from '../../../../src/lib/server/cloud/auth';
import type { CloudUser } from '../../../../src/lib/cloud/types';

export default createHandler({
  async GET({ req, repositories }): Promise<{ user: CloudUser }> {
    const { user } = await requireUser(req, repositories);
    return { user: toPublicUser(user) };
  },

  async PATCH({ req, repositories }): Promise<{ user: CloudUser }> {
    const { user, tokenHash } = await requireUser(req, repositories);
    const { displayName, password, currentPassword } = requireBody<{
      displayName?: string;
      password?: string;
      currentPassword?: string;
    }>(req);

    const patch: { displayName?: string; passwordHash?: string } = {};

    if (displayName !== undefined) {
      const problem = validateDisplayName(displayName);
      if (problem) throw badRequest(problem);
      patch.displayName = displayName.trim();
    }

    if (password !== undefined) {
      const problem = validatePassword(password);
      if (problem) throw badRequest(problem);

      // 已经设过密码的账号必须验旧密码。只用 GitHub 登录的账号还没有密码，
      // 这一步对他们就是「首次设置密码」，不该被一个不存在的旧密码卡住。
      if (user.passwordHash) {
        if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, user.passwordHash))) {
          throw new AuthError('unauthorized', 'The current password is incorrect');
        }
      }
      patch.passwordHash = await hashPassword(password);
    }

    if (!Object.keys(patch).length) throw badRequest('Nothing to update');

    const updated = await repositories.users.update(user.id, patch);

    if (patch.passwordHash) {
      // 改完密码把别处的登录态全部作废，只留当前这一个 —— 改密码的常见动机
      // 就是怀疑账号被别人登着
      await repositories.sessions.deleteByUser(user.id);
      await repositories.sessions.create({
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }

    return { user: toPublicUser(updated) };
  },
});
