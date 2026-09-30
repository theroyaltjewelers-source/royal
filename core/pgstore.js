/* ROYAL's own store on Postgres (ADR-013).  It satisfies the Store contract
   in core/store.js exactly, so everything above it (decisions, audit, events,
   snapshots, notifications) is unchanged:

     get(kind, id)                  -> {id, data, rev} | null
     put(kind, id, data, expected)  -> {ok:true, rev} | {ok:false, conflict:true, current}
     list(kind)                     -> [{id, data, rev}]
     append(log, record)            -> {id, seq}          audit and events only
     readLog(log, {since, limit})   -> the latest `limit` records after `since`, oldest first
     hasKey(log, key)               -> boolean

   Records live in royal_records, logs in royal_log (server/migrations/
   002_royal_store.sql).  Compare-and-swap is one conditional statement, so
   two writers holding the same revision cannot both win.  The database also
   refuses any UPDATE or DELETE of the log.

   Two things differ from the memory store, neither of which the contract
   promises: object keys come back in jsonb's order rather than the order they
   were written (arrays keep theirs), and a NUL character inside a string is
   dropped, because jsonb cannot hold one. */

import { MemoryStore } from "./store.js";

const APPEND_ONLY = new Set(["audit", "events"]);
const LOG_ID = (log, seq) => log + "_" + String(seq).padStart(8, "0");
const json = (v) => JSON.stringify(v === undefined ? null : v, (_, x) => (typeof x === "string" && x.indexOf("\u0000") >= 0 ? x.replace(/\u0000/g, "") : x));

function table(kind) {
  if (APPEND_ONLY.has(kind)) throw new Error("STORE_APPEND_ONLY: " + kind + " can only be appended to");
}
function logName(log) {
  if (!APPEND_ONLY.has(log)) throw new Error("STORE_NOT_A_LOG: " + log);
}
const row = (r) => (r ? { id: r.id, data: r.data, rev: r.rev } : null);
const logRow = (r) => ({ ...r.record, id: r.id, seq: Number(r.seq) });

export class PgStore {
  constructor(pool) { this.pool = pool; this.durable = true; this.kind = "postgres"; }
  q(text, values) { return this.pool.query(text, values); }

  async get(kind, id) {
    table(kind);
    const { rows } = await this.q("SELECT id, data, rev FROM royal_records WHERE kind = $1 AND id = $2", [kind, id]);
    return row(rows[0]);
  }

  async put(kind, id, data, expected) {
    table(kind);
    const body = json(data);
    const r = expected === null || expected === undefined
      ? await this.q("INSERT INTO royal_records (kind, id, data, rev) VALUES ($1, $2, $3::jsonb, 1) ON CONFLICT (kind, id) DO NOTHING RETURNING rev", [kind, id, body])
      : await this.q("UPDATE royal_records SET data = $3::jsonb, rev = rev + 1, updated_at = now() WHERE kind = $1 AND id = $2 AND rev = $4 RETURNING rev", [kind, id, body, expected]);
    if (r.rows.length) return { ok: true, rev: r.rows[0].rev };
    return { ok: false, conflict: true, current: await this.get(kind, id) };
  }

  async list(kind) {
    table(kind);
    const { rows } = await this.q("SELECT id, data, rev FROM royal_records WHERE kind = $1 ORDER BY id", [kind]);
    return rows.map(row);
  }

  async append(log, record) {
    logName(log);
    const rec = { ...(record || {}) }; delete rec.id; delete rec.seq;
    const key = rec.key == null ? null : String(rec.key);
    /* The id is derived from the sequence number inside the same statement,
       so it is known before the row exists and never needs an UPDATE. */
    const { rows } = await this.q(
      "WITH n AS (SELECT nextval(pg_get_serial_sequence('royal_log', 'seq')) AS seq) " +
      "INSERT INTO royal_log (log, seq, id, key, record) SELECT $1, n.seq, $1 || '_' || lpad(n.seq::text, 8, '0'), $2, $3::jsonb FROM n RETURNING id, seq",
      [log, key, json(rec)]);
    return { id: rows[0].id, seq: Number(rows[0].seq) };
  }

  async readLog(log, { since = 0, limit = 500 } = {}) {
    const { rows } = await this.q(
      "SELECT * FROM (SELECT id, seq, record FROM royal_log WHERE log = $1 AND seq > $2 ORDER BY seq DESC LIMIT $3) x ORDER BY seq ASC",
      [log, Number(since) || 0, Math.max(0, Number(limit) || 0)]);
    return rows.map(logRow);
  }

  async hasKey(log, key) {
    if (key == null) return false;
    const { rows } = await this.q("SELECT 1 FROM royal_log WHERE log = $1 AND key = $2 LIMIT 1", [log, String(key)]);
    return rows.length > 0;
  }

  /* Whether this database holds nothing of ROYAL's yet. */
  async isEmpty() {
    const { rows } = await this.q("SELECT (SELECT count(*) FROM royal_records)::int + (SELECT count(*) FROM royal_log)::int AS n");
    return rows[0].n === 0;
  }

  async close() { await this.pool.end(); }
}

/* Imports a JSON file store (ROYAL_STORE_PATH) into an empty Postgres store,
   once.  Everything happens in one transaction under an advisory lock, and
   only when both tables are empty, so a second start, or a second instance
   starting at the same moment, imports nothing.  Records keep their ids and
   revisions; log entries keep their ids and sequence numbers.  Returns the
   counts, or {imported:false} when there was nothing to do. */
export async function importFileStore(pool, source) {
  if (!(source instanceof MemoryStore)) throw new Error("importFileStore needs a loaded file store");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(804212)");
    const { rows } = await c.query("SELECT (SELECT count(*) FROM royal_records)::int + (SELECT count(*) FROM royal_log)::int AS n");
    if (rows[0].n !== 0) { await c.query("ROLLBACK"); return { imported: false, reason: "NOT_EMPTY" }; }
    const counts = { records: 0, audit: 0, events: 0 };
    for (const [kind, m] of source.tables) {
      if (APPEND_ONLY.has(kind)) continue;
      for (const [id, r] of m) {
        await c.query("INSERT INTO royal_records (kind, id, data, rev) VALUES ($1, $2, $3::jsonb, $4)", [kind, id, json(r.data), r.rev]);
        counts.records++;
      }
    }
    let maxSeq = 0;
    for (const [log, arr] of source.logs) {
      if (!APPEND_ONLY.has(log)) continue;
      for (const r of arr) {
        const rec = { ...r }; delete rec.id; delete rec.seq;
        await c.query("INSERT INTO royal_log (log, seq, id, key, record) VALUES ($1, $2, $3, $4, $5::jsonb)",
          [log, r.seq, r.id || LOG_ID(log, r.seq), rec.key == null ? null : String(rec.key), json(rec)]);
        counts[log]++; if (r.seq > maxSeq) maxSeq = r.seq;
      }
    }
    /* New appends continue above every imported sequence number. */
    if (maxSeq) await c.query("SELECT setval(pg_get_serial_sequence('royal_log', 'seq'), $1)", [maxSeq]);
    await c.query("COMMIT");
    return { imported: true, ...counts };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}
