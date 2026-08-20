import { badRequest, createHandler, queryString } from '../../../../../src/lib/server/cloud/http';
import { signState } from '../../../../../src/lib/server/cloud/auth';
import { assertAllowedRedirect, authorizeUrl } from '../../../../../src/lib/server/cloud/github';
import { callbackUrlFor } from '../../../../../src/lib/server/cloud/requestUrl';

export default createHandler(
  {
    async GET({ req, res }) {
      const redirectUri = queryString(req, 'redirect_uri');
      if (!redirectUri) throw badRequest('redirect_uri is required');

      const target = assertAllowedRedirect(redirectUri, req.headers.host);
      const state = signState({ redirectUri: target.toString() });

      res.redirect(302, authorizeUrl(state, callbackUrlFor(req)));
      return undefined;
    },
  },
  { rateLimit: { windowMs: 10 * 60 * 1000, max: 30, key: 'auth:github-start' } }
);
