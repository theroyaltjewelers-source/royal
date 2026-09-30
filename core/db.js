/* Postgres plumbing shared by ROYAL's own store (core/pgstore.js) and the
   Grok Bot bridge (core/grokbot/store.js).  `pg` is loaded only when
   DATABASE_URL is set (ADR-011), so ROYAL without a database still runs with
   no dependency at all. */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadPg() {
  try { return (await import("pg")).default; }
  catch (_) { throw new Error("DATABASE_URL is set but the 'pg' package is not installed. Run npm install (Render build command: npm install)."); }
}

export function poolConfig(url, env = {}) {
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1"].indexOf(u.hostname) >= 0;
  const ssl = env.DATABASE_SSL === "false" || local || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: env.DATABASE_SSL_STRICT === "true" };
  return { connectionString: url, ssl, max: Number(env.DATABASE_POOL_MAX || 5), idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 };
}

/* Applies server/migrations/NNN_name.sql in order, once each, under an
   advisory lock so two instances starting together cannot race. */
export async function migrate(pool, dir) {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(804211)");
    await c.query("CREATE TABLE IF NOT EXISTS royal_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await c.query("SELECT name FROM royal_migrations")).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const applied = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), "utf8");
      await c.query("BEGIN");
      try { await c.query(sql); await c.query("INSERT INTO royal_migrations (name) VALUES ($1)", [f]); await c.query("COMMIT"); applied.push(f); }
      catch (e) { await c.query("ROLLBACK"); throw new Error("Migration " + f + " failed: " + e.message); }
    }
    return applied;
  } finally {
    await c.query("SELECT pg_advisory_unlock(804211)").catch(() => {});
    c.release();
  }
}

/* One pool for the whole process, migrated on start unless
   ROYAL_AUTO_MIGRATE=false.  The store and the bridge share it, so the
   database sees at most DATABASE_POOL_MAX connections from one instance. */
export async function openPool(env, { migrationsDir, logger = console } = {}) {
  const pg = await loadPg();
  const pool = new pg.Pool(poolConfig(env.DATABASE_URL, env));
  pool.on("error", (e) => logger.warn("[db] pool error: " + e.message));
  if (migrationsDir && env.ROYAL_AUTO_MIGRATE !== "false") {
    const applied = await migrate(pool, migrationsDir);
    if (applied.length) logger.log("[db] applied migrations: " + applied.join(", "));
  }
  return pool;
}
