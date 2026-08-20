/**
 * 云端功能的数据契约
 *
 * 这个文件同时被浏览器和 API 路由引用，所以只能放纯类型和常量，
 * 不能 import 任何 node 内置模块 —— 否则客户端 bundle 会把 fs 一起打进去。
 *
 * 云端能力（账号、题目市场）全部是可选的。离线时这些类型依然存在，
 * 只是没有任何东西会去填充它们。
 */

export type LocalizedText = { en: string; zh: string };

/** 市场里的两类内容，对应本地的算法题库和工程题库 */
export type ListingKind = 'algorithm' | 'engineering';

export const LISTING_KINDS: ListingKind[] = ['algorithm', 'engineering'];

export type ListingDifficulty = 'Easy' | 'Medium' | 'Hard';

export const LISTING_DIFFICULTIES: ListingDifficulty[] = ['Easy', 'Medium', 'Hard'];

/* ------------------------------------------------------------------ */
/* 账号                                                                */
/* ------------------------------------------------------------------ */

export interface CloudUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  /** 绑定了哪些登录方式，用于在个人页提示「你还没有设置密码」 */
  providers: Array<'password' | 'github'>;
  createdAt: string;
}

export interface AuthResult {
  token: string;
  /** ISO 时间，客户端据此提前刷新或直接判过期 */
  expiresAt: string;
  user: CloudUser;
}

/* ------------------------------------------------------------------ */
/* 题目市场                                                            */
/* ------------------------------------------------------------------ */

/** 列表页用的摘要。完整题目动辄上百 KB，列表不下发 payload。 */
export interface ListingSummary {
  slug: string;
  kind: ListingKind;
  title: LocalizedText;
  summary: LocalizedText;
  difficulty: ListingDifficulty;
  tags: string[];
  /** 工程题的工作区语言；算法题为 null */
  language: string | null;
  version: number;
  starCount: number;
  downloadCount: number;
  author: { id: string; displayName: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
  /** 当前登录用户是否已经 star 过；未登录时为 false */
  starred: boolean;
}

export interface ListingDetail extends ListingSummary {
  /** 完整题目内容：算法题是 Problem，工程题是 EngineeringProject */
  payload: unknown;
  changelog: string | null;
  /** 历史版本号，倒序 */
  versions: Array<{ version: number; changelog: string | null; createdAt: string }>;
}

export interface ListingQuery {
  kind?: ListingKind;
  difficulty?: ListingDifficulty;
  tag?: string;
  search?: string;
  author?: string;
  sort?: 'recent' | 'stars' | 'downloads';
  page?: number;
  pageSize?: number;
}

export interface ListingPage {
  items: ListingSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PublishRequest {
  kind: ListingKind;
  /** 不传则由标题派生；重复发布同一个 slug 视为发新版本 */
  slug?: string;
  payload: unknown;
  changelog?: string;
}

/* ------------------------------------------------------------------ */
/* 健康检查                                                            */
/* ------------------------------------------------------------------ */

/**
 * 客户端靠这个接口判断「云端到底能不能用」。
 *
 * 它必须在数据库没配的时候也能正常返回 200，只是把 database 标成 false ——
 * 一个连自己坏没坏都答不上来的健康检查没有意义。
 */
export interface CloudHealth {
  ok: boolean;
  version: string;
  features: {
    database: boolean;
    accounts: boolean;
    github: boolean;
    market: boolean;
  };
  /** 服务端时间，用于排查客户端时钟偏差导致的 token 误判 */
  time: string;
}

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

/**
 * 服务端返回的错误码。客户端据此决定提示语，而不是去匹配英文错误字符串 ——
 * 后者一改文案就会静默失效。
 */
export type CloudErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'cloud_disabled'
  | 'server_error';

export interface CloudErrorBody {
  error: { code: CloudErrorCode; message: string; details?: unknown };
}

export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
