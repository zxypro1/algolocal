/**
 * 密码、token、OAuth state 的单元测试
 *
 * 这些是最不应该「大概对」的代码：密码哈希写错了要等到数据库泄露才知道，
 * state 校验写错了就是一个开放重定向。
 */
import { useMemoryCloud } from './harness';

useMemoryCloud();

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  generateToken,
  hashPassword,
  hashToken,
  signState,
  validateDisplayName,
  validateEmail,
  validatePassword,
  verifyPassword,
  verifyState,
  AuthError,
} = require('../../src/lib/server/cloud/auth');
const { assertAllowedRedirect, fallbackEmail } = require('../../src/lib/server/cloud/github');
const { externalOrigin, callbackUrlFor } = require('../../src/lib/server/cloud/requestUrl');
const { checkRateLimit, resetRateLimits, toErrorResponse, HttpError } = require('../../src/lib/server/cloud/http');
/* eslint-enable @typescript-eslint/no-var-requires */

describe('passwords', () => {
  it('round-trips a password', async () => {
    const stored = await hashPassword('correct horse battery staple');

    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
  });

  it('uses a fresh salt every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);

    // 两次哈希必须不同，否则相同密码的用户在库里长得一样，撞库一次全中
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('never accepts a null or malformed hash', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
    expect(await verifyPassword('anything', 'plaintext')).toBe(false);
    expect(await verifyPassword('anything', 'bcrypt$1$2$3$4$5')).toBe(false);
  });

  it('validates inputs', () => {
    expect(validatePassword('short')).toMatch(/8 characters/);
    expect(validatePassword(' leading space is fine inside')).toMatch(/whitespace/);
    expect(validatePassword('a'.repeat(201))).toMatch(/200/);
    expect(validatePassword('a reasonable password')).toBeNull();

    expect(validateEmail('not-an-email')).toBeTruthy();
    expect(validateEmail('someone@example.com')).toBeNull();

    expect(validateDisplayName('a')).toBeTruthy();
    expect(validateDisplayName('a'.repeat(41))).toBeTruthy();
    expect(validateDisplayName('Reasonable Name')).toBeNull();
  });
});

describe('tokens', () => {
  it('generates unguessable tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));

    expect(tokens.size).toBe(200);
    Array.from(tokens).forEach((token) => {
      expect(String(token).startsWith('alc_')).toBe(true);
      expect(String(token).length).toBeGreaterThan(40);
    });
  });

  it('stores a keyed hash rather than the token', () => {
    const token = generateToken();
    const hash = hashToken(token);

    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
    expect(hashToken(token)).toBe(hash);
    // 换一个密钥就对不上：数据库被读走也没法拿去别的部署上用
    expect(hashToken(token, 'a different secret')).not.toBe(hash);
  });
});

describe('OAuth state', () => {
  it('round-trips a payload', () => {
    const state = signState({ redirectUri: 'http://localhost:3000/account' });
    expect(verifyState(state).redirectUri).toBe('http://localhost:3000/account');
  });

  it('rejects a tampered payload', () => {
    const state = signState({ redirectUri: 'http://localhost:3000/account' });
    const [encoded, signature] = state.split('.');

    const swapped = Buffer.from(
      JSON.stringify({ redirectUri: 'https://evil.example.com', exp: Date.now() + 60000 }),
      'utf8'
    ).toString('base64url');

    expect(() => verifyState(`${swapped}.${signature}`)).toThrow(AuthError);
    expect(() => verifyState(`${encoded}.deadbeef`)).toThrow(AuthError);
    expect(() => verifyState('garbage')).toThrow(AuthError);
  });

  it('rejects an expired state', () => {
    const state = signState({ redirectUri: 'http://localhost:3000/account' }, -1000);
    expect(() => verifyState(state)).toThrow(/expired/);
  });
});

describe('redirect allow list', () => {
  it('allows loopback on any port so the desktop app works', () => {
    expect(assertAllowedRedirect('http://localhost:3000/account').host).toBe('localhost:3000');
    expect(assertAllowedRedirect('http://127.0.0.1:41234/account').host).toBe('127.0.0.1:41234');
  });

  it('allows the deployment itself', () => {
    expect(assertAllowedRedirect('https://algolocal.vercel.app/account', 'algolocal.vercel.app').host).toBe(
      'algolocal.vercel.app'
    );
  });

  it('refuses anywhere else', () => {
    // 这一条挡的是开放重定向：放行的话，攻击者只要把 redirect_uri 指向自己，
    // 用户点一下就把 token 送出去了
    expect(() => assertAllowedRedirect('https://evil.example.com/steal', 'algolocal.vercel.app')).toThrow();
    expect(() => assertAllowedRedirect('javascript:alert(1)')).toThrow();
    expect(() => assertAllowedRedirect('not a url')).toThrow();
  });

  it('honours an explicit allow list', () => {
    process.env.CLOUD_ALLOWED_REDIRECTS = 'https://practice.example.com';
    try {
      expect(assertAllowedRedirect('https://practice.example.com/account', 'other.host').host).toBe(
        'practice.example.com'
      );
    } finally {
      delete process.env.CLOUD_ALLOWED_REDIRECTS;
    }
  });
});

describe('github identity', () => {
  it('falls back to a non-deliverable address when the email is private', () => {
    expect(fallbackEmail({ githubId: '42', login: 'octocat', email: null })).toBe(
      '42+octocat@users.noreply.github.com'
    );
    expect(fallbackEmail({ githubId: '42', login: 'octocat', email: 'real@example.com' })).toBe(
      'real@example.com'
    );
  });
});

describe('external origin', () => {
  const requestWith = (headers: Record<string, string>) => ({ headers }) as any;

  it('prefers the forwarded host and protocol', () => {
    expect(
      externalOrigin(requestWith({ 'x-forwarded-host': 'preview.vercel.app', 'x-forwarded-proto': 'https' }))
    ).toBe('https://preview.vercel.app');
  });

  it('assumes http only for loopback', () => {
    expect(externalOrigin(requestWith({ host: 'localhost:3000' }))).toBe('http://localhost:3000');
    expect(externalOrigin(requestWith({ host: 'algolocal.vercel.app' }))).toBe('https://algolocal.vercel.app');
  });

  it('builds the callback url from it', () => {
    expect(callbackUrlFor(requestWith({ host: 'localhost:3000' }))).toBe(
      'http://localhost:3000/api/cloud/auth/github/callback'
    );
  });

  it('lets an explicit origin win', () => {
    process.env.CLOUD_PUBLIC_ORIGIN = 'https://algolocal.example.com/';
    try {
      expect(externalOrigin(requestWith({ host: 'internal' }))).toBe('https://algolocal.example.com');
    } finally {
      delete process.env.CLOUD_PUBLIC_ORIGIN;
    }
  });
});

describe('rate limiting', () => {
  beforeEach(() => resetRateLimits());

  it('allows up to the limit and then refuses', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(checkRateLimit('key', 60_000, 3)).toBe(true);
    }
    expect(checkRateLimit('key', 60_000, 3)).toBe(false);
  });

  it('counts each key separately', () => {
    expect(checkRateLimit('a', 60_000, 1)).toBe(true);
    expect(checkRateLimit('a', 60_000, 1)).toBe(false);
    expect(checkRateLimit('b', 60_000, 1)).toBe(true);
  });

  it('resets after the window', async () => {
    expect(checkRateLimit('window', 20, 1)).toBe(true);
    expect(checkRateLimit('window', 20, 1)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(checkRateLimit('window', 20, 1)).toBe(true);
  });
});

describe('error mapping', () => {
  it('maps a unique violation to 409 rather than 500', () => {
    const error = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(toErrorResponse(error).status).toBe(409);
  });

  it('keeps an explicit HttpError as-is', () => {
    const mapped = toErrorResponse(new HttpError(418, 'bad_request', 'no coffee'));
    expect(mapped.status).toBe(418);
    expect(mapped.body.error.message).toBe('no coffee');
  });

  it('does not leak an unexpected error message to the client', () => {
    const mapped = toErrorResponse(new Error('connection string postgres://user:secret@host/db failed'));

    expect(mapped.status).toBe(500);
    expect(mapped.body.error.message).not.toMatch(/secret/);
  });
});
