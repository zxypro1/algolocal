import { badRequest, createHandler, queryString } from '../../../../../src/lib/server/cloud/http';
import { issueSession, verifyState } from '../../../../../src/lib/server/cloud/auth';
import {
  assertAllowedRedirect,
  exchangeCode,
  fallbackEmail,
  fetchIdentity,
} from '../../../../../src/lib/server/cloud/github';
import { callbackUrlFor } from '../../../../../src/lib/server/cloud/requestUrl';
import type { UserRecord } from '../../../../../src/lib/server/cloud/repo/types';

export default createHandler({
  async GET({ req, res, repositories }) {
    const error = queryString(req, 'error');
    const state = queryString(req, 'state');
    const code = queryString(req, 'code');

    if (!state) throw badRequest('Missing OAuth state');
    const { redirectUri } = verifyState(state);
    const target = assertAllowedRedirect(redirectUri, req.headers.host);

    // 用户在 GitHub 上点了「取消」。把原因带回应用页，而不是甩一个 400 页面。
    if (error) {
      target.hash = new URLSearchParams({ error: queryString(req, 'error_description') || error }).toString();
      res.redirect(302, target.toString());
      return undefined;
    }

    if (!code) throw badRequest('Missing OAuth code');

    const accessToken = await exchangeCode(code, callbackUrlFor(req));
    const identity = await fetchIdentity(accessToken);

    let user = await repositories.users.findByGithubId(identity.githubId);

    if (!user) {
      const email = fallbackEmail(identity);
      const byEmail = await repositories.users.findByEmail(email);

      if (byEmail) {
        // 同一个邮箱已经用密码注册过：把 GitHub 绑到那个账号上，而不是
        // 建第二个账号。两个账号会让用户的题目莫名其妙地分成两半。
        user = await repositories.users.update(byEmail.id, {
          githubId: identity.githubId,
          avatarUrl: byEmail.avatarUrl || identity.avatarUrl,
        });
      } else {
        user = await repositories.users.create({
          email,
          displayName: identity.displayName,
          passwordHash: null,
          githubId: identity.githubId,
          avatarUrl: identity.avatarUrl,
        });
      }
    } else if (!user.avatarUrl && identity.avatarUrl) {
      user = await repositories.users.update(user.id, { avatarUrl: identity.avatarUrl });
    }

    const session = await issueSession((user as UserRecord).id, repositories);

    // token 放 fragment：它不会被发到服务器，也不会出现在访问日志和 Referer 里
    target.hash = new URLSearchParams({
      token: session.token,
      expires_at: session.expiresAt,
    }).toString();

    res.redirect(302, target.toString());
    return undefined;
  },
});
