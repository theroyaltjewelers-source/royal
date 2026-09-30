/* Chooses ROYAL's own store from the server environment, in one place:

     DATABASE_URL       Postgres (core/pgstore.js), migrated on start unless
                        ROYAL_AUTO_MIGRATE=false; the pool is returned so the
                        Grok Bot bridge can share it
     ROYAL_STORE_PATH   a JSON file (core/store.js fileStore)
     neither            memory, with a warning that nothing survives a restart

   With Postgres and ROYAL_IMPORT_FILE_STORE=true, an existing file at
   ROYAL_STORE_PATH is imported once into the empty database and the import is
   audited with counts only (ADR-013). */

import { fileStore, MemoryStore } from "../core/store.js";
import { AuditService } from "../core/audit.js";

export async function storeFromEnv(env, { migrationsDir, logger = console } = {}) {
  if (env.DATABASE_URL) {
    const { openPool } = await import("../core/db.js");
    const { PgStore, importFileStore } = await import("../core/pgstore.js");
    const pool = await openPool(env, { migrationsDir, logger });
    const store = new PgStore(pool);
    if (env.ROYAL_IMPORT_FILE_STORE === "true") await importOnce(env, pool, store, importFileStore, logger);
    return { store, pool };
  }
  if (env.ROYAL_STORE_PATH) return { store: await fileStore(env.ROYAL_STORE_PATH), pool: null };
  logger.warn("ROYAL: neither DATABASE_URL nor ROYAL_STORE_PATH is set; decisions and audit are in memory and will be lost on restart.");
  return { store: new MemoryStore(), pool: null };
}

async function importOnce(env, pool, store, importFileStore, logger) {
  if (!env.ROYAL_STORE_PATH) { logger.warn("ROYAL: ROYAL_IMPORT_FILE_STORE is set but ROYAL_STORE_PATH is not; nothing to import."); return null; }
  const { access } = await import("node:fs/promises");
  try { await access(env.ROYAL_STORE_PATH); }
  catch (_) { logger.warn("ROYAL: ROYAL_IMPORT_FILE_STORE is set but there is no file at ROYAL_STORE_PATH; nothing to import."); return null; }
  const r = await importFileStore(pool, await fileStore(env.ROYAL_STORE_PATH));
  if (!r.imported) { logger.log("ROYAL: the database already holds ROYAL's records; the file store was not imported."); return r; }
  await new AuditService(store).record({ actor: "system", action: "STORE_IMPORTED", executive: true,
    summary: "Moved ROYAL's records from the file store into the database.",
    result: { records: r.records, audit: r.audit, events: r.events } });
  logger.log("ROYAL: imported " + r.records + " records, " + r.audit + " audit entries and " + r.events + " events into the database.");
  return r;
}
