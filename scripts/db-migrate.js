#!/usr/bin/env node
/**
 * 建表 / 迁移
 *
 *   DATABASE_URL=postgres://... node scripts/db-migrate.js
 *
 * 幂等：跑过的迁移会被跳过，没跑过的按顺序执行。部署流水线每次上线都会跑它，
 * 所以「忘了迁移」这个故障模式不存在。
 */
const path = require('path');
const { runMigrations } = require(path.join(__dirname, '..', 'src', 'lib', 'server', 'cloud', 'repo', 'migrations.js'));

function loadEnvFile() {
  // 本地跑的时候顺手读一下 .env.local，省得每次都在命令行里贴连接串
  const fs = require('fs');
  for (const name of ['.env.local', '.env']) {
    const file = path.join(process.cwd(), name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, '');
    }
  }
}

async function main() {
  loadEnvFile();

  const databaseUrl = (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
  if (!databaseUrl) {
    // 构建流水线用 --if-configured 调它：一个不打算开云端的部署（比如只想把
    // 网页版当静态站点用）不该因为「没配数据库」而构建失败。
    if (process.argv.includes('--if-configured')) {
      console.log('DATABASE_URL is not set — skipping migrations. Cloud features will report themselves as unavailable.');
      return;
    }
    console.error('DATABASE_URL is not set. Nothing to migrate.');
    console.error('Set it to your Neon connection string, or pass --if-configured to skip.');
    process.exit(1);
  }

  const { neon } = require('@neondatabase/serverless');
  const sql = neon(databaseUrl);

  const started = Date.now();
  const result = await runMigrations((text, params = []) => sql(text, params));

  const host = (() => {
    try {
      return new URL(databaseUrl).host;
    } catch {
      return 'the database';
    }
  })();

  console.log(`Migrated ${host} in ${Date.now() - started}ms`);
  console.log(`  applied: ${result.applied.length ? result.applied.join(', ') : 'none'}`);
  console.log(`  already up to date: ${result.skipped.length ? result.skipped.join(', ') : 'none'}`);
}

main().catch((error) => {
  console.error('Migration failed:', error.message || error);
  process.exit(1);
});
