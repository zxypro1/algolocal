/**
 * 数据库结构与迁移
 *
 * 写成 CommonJS 而不是 TypeScript，是为了让 `node scripts/db-migrate.js`
 * 能直接 require 它。部署流水线里跑迁移的那一步不该依赖一整套构建工具，
 * 而「迁移脚本和应用读的是同一份定义」比类型标注更重要 —— 两份 SQL 各自
 * 演化的下场是线上表结构和代码对不上。
 *
 * 每条语句都写成幂等的（IF NOT EXISTS），执行记录落在 cloud_migrations 里。
 */

/** @typedef {{ name: string, statements: string[] }} Migration */

/** @type {Migration[]} */
const MIGRATIONS = [
  {
    name: '0001_init',
    statements: [
      `CREATE TABLE IF NOT EXISTS cloud_users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email         text NOT NULL UNIQUE,
        display_name  text NOT NULL,
        avatar_url    text,
        password_hash text,
        github_id     text UNIQUE,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )`,

      `CREATE TABLE IF NOT EXISTS cloud_sessions (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      uuid NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
        token_hash   text NOT NULL UNIQUE,
        expires_at   timestamptz NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS cloud_sessions_user_idx ON cloud_sessions (user_id)`,
      `CREATE INDEX IF NOT EXISTS cloud_sessions_expiry_idx ON cloud_sessions (expires_at)`,

      `CREATE TABLE IF NOT EXISTS cloud_listings (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug           text NOT NULL UNIQUE,
        kind           text NOT NULL CHECK (kind IN ('algorithm', 'engineering')),
        owner_id       uuid NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
        title          jsonb NOT NULL,
        summary        jsonb NOT NULL,
        difficulty     text NOT NULL CHECK (difficulty IN ('Easy', 'Medium', 'Hard')),
        tags           text[] NOT NULL DEFAULT '{}',
        language       text,
        payload        jsonb NOT NULL,
        version        integer NOT NULL DEFAULT 1,
        changelog      text,
        star_count     integer NOT NULL DEFAULT 0,
        download_count integer NOT NULL DEFAULT 0,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS cloud_listings_kind_idx ON cloud_listings (kind)`,
      `CREATE INDEX IF NOT EXISTS cloud_listings_owner_idx ON cloud_listings (owner_id)`,
      `CREATE INDEX IF NOT EXISTS cloud_listings_updated_idx ON cloud_listings (updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS cloud_listings_stars_idx ON cloud_listings (star_count DESC)`,
      `CREATE INDEX IF NOT EXISTS cloud_listings_tags_idx ON cloud_listings USING gin (tags)`,

      `CREATE TABLE IF NOT EXISTS cloud_listing_versions (
        listing_id uuid NOT NULL REFERENCES cloud_listings(id) ON DELETE CASCADE,
        version    integer NOT NULL,
        payload    jsonb NOT NULL,
        changelog  text,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (listing_id, version)
      )`,

      `CREATE TABLE IF NOT EXISTS cloud_stars (
        user_id    uuid NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
        listing_id uuid NOT NULL REFERENCES cloud_listings(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, listing_id)
      )`,
      `CREATE INDEX IF NOT EXISTS cloud_stars_listing_idx ON cloud_stars (listing_id)`,
    ],
  },
];

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS cloud_migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/**
 * @param {(text: string, params?: unknown[]) => Promise<any[]>} sql
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
async function runMigrations(sql) {
  await sql(MIGRATIONS_TABLE);
  const rows = await sql(`SELECT name FROM cloud_migrations`);
  const done = new Set(rows.map((row) => row.name));

  const result = { applied: [], skipped: [] };

  for (const migration of MIGRATIONS) {
    if (done.has(migration.name)) {
      result.skipped.push(migration.name);
      continue;
    }
    for (const statement of migration.statements) {
      await sql(statement);
    }
    await sql(`INSERT INTO cloud_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [migration.name]);
    result.applied.push(migration.name);
  }

  return result;
}

module.exports = { MIGRATIONS, MIGRATIONS_TABLE, runMigrations };
