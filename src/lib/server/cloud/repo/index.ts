/**
 * 仓储的装配点
 *
 * 决定这次请求用 Postgres 还是内存实现，并把实例缓存在 globalThis 上 ——
 * Next 的开发模式每次热更新都会重新求值模块，缓存挂在模块变量上的话，
 * 内存仓储里的数据会在你改一行 CSS 之后凭空消失。
 */
import { capabilitiesOf, memoryStoreAllowed, readCloudConfig, type CloudServerConfig } from '../env';
import { createMemoryRepositories } from './memory';
import { createPostgresRepositories } from './postgres';
import { runMigrations, type MigrationResult, type SqlExecutor } from './schema';
import type { Repositories } from './types';

type Cache = {
  repositories?: Repositories;
  signature?: string;
  sql?: SqlExecutor;
};

const globalCache = globalThis as typeof globalThis & { __algolocalCloud?: Cache };
const cache: Cache = (globalCache.__algolocalCloud ||= {});

/** 云端没配好时抛这个，路由层统一翻译成 503 */
export class CloudDisabledError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'CloudDisabledError';
  }
}

export function createSqlExecutor(databaseUrl: string): SqlExecutor {
  // 动态 require：没配数据库的部署不该为了一个用不到的驱动付出加载成本，
  // 桌面端更是完全不需要它
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { neon } = require('@neondatabase/serverless') as typeof import('@neondatabase/serverless');
  const sql = neon(databaseUrl);
  return (text: string, params: unknown[] = []) => sql(text, params) as Promise<any[]>;
}

function signatureOf(config: CloudServerConfig): string {
  return `${config.databaseUrl ? 'pg' : ''}|${config.memoryStore ? 'mem' : ''}`;
}

export function getRepositories(config: CloudServerConfig = readCloudConfig()): Repositories {
  const signature = signatureOf(config);
  if (cache.repositories && cache.signature === signature) return cache.repositories;

  let repositories: Repositories;

  if (config.databaseUrl) {
    cache.sql = createSqlExecutor(config.databaseUrl);
    repositories = createPostgresRepositories(cache.sql);
  } else if (memoryStoreAllowed(config)) {
    repositories = createMemoryRepositories();
  } else {
    throw new CloudDisabledError(
      config.memoryStore
        ? 'ALGOLOCAL_CLOUD_MEMORY is not allowed on Vercel; set DATABASE_URL instead'
        : 'DATABASE_URL is not configured'
    );
  }

  cache.repositories = repositories;
  cache.signature = signature;
  return repositories;
}

/** 云端能不能用。路由在做任何事之前先问它，这样错误是 503 而不是堆栈。 */
export function assertCloudReady(config: CloudServerConfig = readCloudConfig()): void {
  const capabilities = capabilitiesOf(config);
  if (!capabilities.database) {
    throw new CloudDisabledError('DATABASE_URL is not configured');
  }
  if (!capabilities.accounts) {
    throw new CloudDisabledError('AUTH_SECRET is not configured');
  }
}

export async function migrate(config: CloudServerConfig = readCloudConfig()): Promise<MigrationResult> {
  if (!config.databaseUrl) {
    // 内存实现的「结构」就是它自己的数据结构，没有可迁移的东西
    if (memoryStoreAllowed(config)) return { applied: [], skipped: ['memory-store'] };
    throw new CloudDisabledError('DATABASE_URL is not configured');
  }
  const sql = createSqlExecutor(config.databaseUrl);
  return runMigrations(sql);
}

/** 测试用：丢掉缓存，下一次调用重新装配 */
export function resetRepositories(): void {
  delete cache.repositories;
  delete cache.signature;
  delete cache.sql;
}

export type { Repositories } from './types';
