/**
 * 云端后端的运行时配置
 *
 * 一条原则：缺配置不等于崩溃。没有 DATABASE_URL 的部署（比如用户自己
 * `npm start` 起的本地服务）照样要能跑，只是 /api/cloud/* 一律返回
 * 503 cloud_disabled，而不是抛一个连接错误的堆栈。
 */

export interface CloudServerConfig {
  /** 数据库连接串，Neon 的 postgres://... */
  databaseUrl: string | null;
  /** 签发 token 用的密钥 */
  authSecret: string | null;
  github: { clientId: string; clientSecret: string } | null;
  /** 用内存仓储代替数据库，只给本地开发和集成测试用 */
  memoryStore: boolean;
  /** 部署在 Vercel 上（只读文件系统） */
  isVercel: boolean;
}

export function readCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudServerConfig {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();

  return {
    databaseUrl: env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim() || null,
    authSecret: env.AUTH_SECRET?.trim() || null,
    github: clientId && clientSecret ? { clientId, clientSecret } : null,
    memoryStore: env.ALGOLOCAL_CLOUD_MEMORY === '1',
    isVercel: Boolean(env.VERCEL),
  };
}

export interface CloudCapabilities {
  database: boolean;
  accounts: boolean;
  github: boolean;
  market: boolean;
}

export function capabilitiesOf(config: CloudServerConfig): CloudCapabilities {
  const database = Boolean(config.databaseUrl) || config.memoryStore;
  // 没有密钥就签不出 token，也就没有登录态可言；市场同理，它的写操作都要求登录
  const accounts = database && Boolean(config.authSecret);
  return {
    database,
    accounts,
    github: accounts && Boolean(config.github),
    market: accounts,
  };
}

/**
 * 内存仓储是进程内的，重启即丢。生产环境误开会造成「注册成功但第二天账号没了」，
 * 所以在 Vercel 上直接拒绝启用它。
 */
export function memoryStoreAllowed(config: CloudServerConfig): boolean {
  return config.memoryStore && !config.isVercel;
}
