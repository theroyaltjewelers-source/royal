/* Applies server/migrations in order: `npm run migrate`.
   The server also applies them on start (set ROYAL_AUTO_MIGRATE=false to
   stop that and run this by hand instead).  Needs DATABASE_URL. */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPg, poolConfig, migrate } from "../core/grokbot/store.js";

const env = process.env;
if (!env.DATABASE_URL) { console.error("DATABASE_URL is not set."); process.exit(1); }
const pg = await loadPg();
const pool = new pg.Pool(poolConfig(env.DATABASE_URL, env));
try {
  const applied = await migrate(pool, join(dirname(fileURLToPath(import.meta.url)), "migrations"));
  console.log(applied.length ? "Applied: " + applied.join(", ") : "Nothing to apply; the database is current.");
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await pool.end(); }
