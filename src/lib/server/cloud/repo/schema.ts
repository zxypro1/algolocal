/**
 * migrations.js 的类型化外壳
 *
 * SQL 定义本身在 migrations.js 里，因为部署脚本要用 node 直接 require 它。
 * 这里只负责给应用侧一个有类型的入口。
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const migrations = require('./migrations.js');

export interface Migration {
  name: string;
  statements: string[];
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export type SqlExecutor = (text: string, params?: unknown[]) => Promise<any[]>;

export const MIGRATIONS: Migration[] = migrations.MIGRATIONS;
export const MIGRATIONS_TABLE: string = migrations.MIGRATIONS_TABLE;

export function runMigrations(sql: SqlExecutor): Promise<MigrationResult> {
  return migrations.runMigrations(sql);
}
