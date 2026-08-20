/**
 * 账号与登录态
 *
 * token 是随机串，不是 JWT。因为每个请求本来就要读一次用户表，JWT 省不掉这次
 * 查询，却换来一个「签发之后无法撤销」的麻烦：改密码、退出登录、发现账号被盗，
 * 都需要立刻让旧 token 失效。随机 token + 服务端 session 表天然做得到。
 *
 * 库里存的是 HMAC(secret, token)，不是 token 本身。数据库被读走的话，
 * 攻击者拿到的是一堆无法反推、也无法直接使用的哈希。
 */
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import type { NextApiRequest } from 'next';
import type { CloudUser } from '../../cloud/types';
import { readCloudConfig } from './env';
import { getRepositories } from './repo';
import type { Repositories, UserRecord } from './repo/types';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/**
 * scrypt 参数。N=16384 在 Serverless 上大约 60~90ms，是「用户感觉不到、
 * 但离线爆破成本高」的平衡点。maxmem 必须显式给：默认的 32MB 上限恰好卡在
 * 128*N*r 上，不给就会随机抛 "memory limit exceeded"。
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export const TOKEN_TTL_DAYS = 30;
const TOKEN_PREFIX = 'alc_';

export class AuthError extends Error {
  constructor(
    readonly code: 'unauthorized' | 'forbidden' | 'bad_request' | 'conflict',
    message: string
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/* ------------------------------ 密码 ------------------------------ */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');

  const derived = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * 密码强度要求。刻意只查长度和字符种类，不做「必须含大写字母和符号」那一套：
 * 那类规则逼出来的是 Password1!，而不是更强的密码。
 */
export function validatePassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (password.length > 200) return 'Password must be at most 200 characters';
  if (/^\s|\s$/.test(password)) return 'Password must not start or end with whitespace';
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(email: string): string | null {
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) return 'Enter a valid email address';
  if (email.trim().length > 254) return 'Email address is too long';
  return null;
}

export function validateDisplayName(name: string): string | null {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 2) return 'Display name must be at least 2 characters';
  if (trimmed.length > 40) return 'Display name must be at most 40 characters';
  return null;
}

/* ------------------------------ token ------------------------------ */

function authSecret(): string {
  const secret = readCloudConfig().authSecret;
  if (!secret) throw new AuthError('unauthorized', 'AUTH_SECRET is not configured');
  return secret;
}

export function hashToken(token: string, secret = authSecret()): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export interface IssuedSession {
  token: string;
  expiresAt: string;
}

export async function issueSession(userId: string, repositories: Repositories): Promise<IssuedSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await repositories.sessions.create({ userId, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt };
}

export function bearerToken(req: NextApiRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export interface AuthenticatedRequest {
  user: UserRecord;
  tokenHash: string;
}

/** 没登录返回 null，让「登录可选」的接口（比如市场列表）自己决定怎么办 */
export async function optionalUser(
  req: NextApiRequest,
  repositories: Repositories = getRepositories()
): Promise<AuthenticatedRequest | null> {
  const token = bearerToken(req);
  if (!token) return null;

  const tokenHash = hashToken(token);
  const session = await repositories.sessions.findByTokenHash(tokenHash);
  if (!session) return null;

  const user = await repositories.users.findById(session.userId);
  if (!user) return null;

  // 不 await：更新「最后使用时间」只是运维信息，不该让用户多等一个往返
  void repositories.sessions.touch(session.id).catch(() => {});

  return { user, tokenHash };
}

export async function requireUser(
  req: NextApiRequest,
  repositories: Repositories = getRepositories()
): Promise<AuthenticatedRequest> {
  const authenticated = await optionalUser(req, repositories);
  if (!authenticated) throw new AuthError('unauthorized', 'Sign in to continue');
  return authenticated;
}

/* ------------------------------ 出参 ------------------------------ */

export function toPublicUser(user: UserRecord): CloudUser {
  const providers: CloudUser['providers'] = [];
  if (user.passwordHash) providers.push('password');
  if (user.githubId) providers.push('github');

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    providers,
    createdAt: user.createdAt,
  };
}

/* --------------------------- OAuth state --------------------------- */

/**
 * GitHub 回调时用来确认「这次回调确实是我们发起的」。
 *
 * state 里带上时间戳和签名，服务端不需要存任何东西 —— Serverless 上没有
 * 可靠的跨请求内存，存 state 反而会在多实例下随机失败。
 */
export function signState(payload: Record<string, string>, ttlMs = 10 * 60 * 1000): string {
  const body = JSON.stringify({ ...payload, exp: Date.now() + ttlMs });
  const encoded = Buffer.from(body, 'utf8').toString('base64url');
  const signature = createHmac('sha256', authSecret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyState(state: string): Record<string, string> {
  const [encoded, signature] = String(state || '').split('.');
  if (!encoded || !signature) throw new AuthError('bad_request', 'Malformed OAuth state');

  const expected = createHmac('sha256', authSecret()).update(encoded).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError('bad_request', 'OAuth state signature mismatch');
  }

  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    throw new AuthError('bad_request', 'OAuth state has expired');
  }
  return payload;
}
