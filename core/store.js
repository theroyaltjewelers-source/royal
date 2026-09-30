/* ROYAL's own persistence.  This holds ROYAL's objects (decisions,
   commitments, waiting items, tasks, audit, ingested snapshots) and never the
   business's operational truth, which stays in the systems that own it.

   The contract every backend implements:

     get(kind, id)                  -> {id, data, rev} | null
     put(kind, id, data, expected)  -> {ok:true, rev} | {ok:false, conflict:true, current}
     list(kind)                     -> [{id, data, rev}]
     append(log, record)            -> {id, seq}          append-only, no update, no delete

   `expected` is the revision the caller read, or null for "I believe this
   does not exist yet".  A write over a revision that has since moved changes
   nothing and says so: the same compare-and-swap the calculator uses, so two
   writers can never silently overwrite each other.

   There is deliberately no delete.  Records are cancelled, voided or
   superseded, never removed. */

import { clone } from "./util.js";

const APPEND_ONLY = new Set(["audit", "events"]);

export class MemoryStore {
  constructor() { this.tables = new Map(); this.logs = new Map(); }

  _t(kind) {
    if (APPEND_ONLY.has(kind)) throw new Error("STORE_APPEND_ONLY: " + kind + " can only be appended to");
    if (!this.tables.has(kind)) this.tables.set(kind, new Map());
    return this.tables.get(kind);
  }

  async get(kind, id) {
    const r = this._t(kind).get(id);
    return r ? { id, data: clone(r.data), rev: r.rev } : null;
  }

  async put(kind, id, data, expected) {
    const t = this._t(kind), cur = t.get(id);
    if (expected === null || expected === undefined) {
      if (cur) return { ok: false, conflict: true, current: { id, data: clone(cur.data), rev: cur.rev } };
    } else if (!cur || cur.rev !== expected) {
      return { ok: false, conflict: true, current: cur ? { id, data: clone(cur.data), rev: cur.rev } : null };
    }
    const rev = cur ? cur.rev + 1 : 1;
    t.set(id, { data: clone(data), rev });
    return { ok: true, rev };
  }

  async list(kind) {
    return Array.from(this._t(kind).entries()).map(([id, r]) => ({ id, data: clone(r.data), rev: r.rev }));
  }

  async append(log, record) {
    if (!APPEND_ONLY.has(log)) throw new Error("STORE_NOT_A_LOG: " + log);
    if (!this.logs.has(log)) this.logs.set(log, []);
    const arr = this.logs.get(log);
    const seq = arr.length + 1;
    const id = log + "_" + String(seq).padStart(8, "0");
    arr.push(Object.freeze({ id, seq, ...clone(record) }));
    return { id, seq };
  }

  async readLog(log, { since = 0, limit = 500 } = {}) {
    return (this.logs.get(log) || []).filter((r) => r.seq > since).slice(-limit).map(clone);
  }

  /* Whether a log already holds a record with this key.  Used for event
     dedupe, so a retried delivery is recognised rather than processed twice. */
  async hasKey(log, key) {
    return (this.logs.get(log) || []).some((r) => r.key === key);
  }
}

/* A JSON file on disk, for a single-node deployment and for local work.  The
   whole file is rewritten atomically (write then rename) on every change. */
export async function fileStore(path) {
  const fs = await import("node:fs/promises");
  const s = new MemoryStore();
  try {
    const raw = JSON.parse(await fs.readFile(path, "utf8"));
    for (const [k, rows] of Object.entries(raw.tables || {})) s.tables.set(k, new Map(rows.map((r) => [r.id, { data: r.data, rev: r.rev }])));
    for (const [k, rows] of Object.entries(raw.logs || {})) s.logs.set(k, rows.map((r) => Object.freeze(r)));
  } catch (e) { if (e.code !== "ENOENT") throw e; }

  let chain = Promise.resolve();
  const flush = () => {
    chain = chain.then(async () => {
      const out = { tables: {}, logs: {} };
      for (const [k, m] of s.tables) out.tables[k] = Array.from(m, ([id, r]) => ({ id, data: r.data, rev: r.rev }));
      for (const [k, a] of s.logs) out.logs[k] = a;
      const tmp = path + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(out), { mode: 0o600 }); /* client names and money: owner-readable only */
      await fs.rename(tmp, path);
    });
    return chain;
  };
  s.durable = true;
  const put = s.put.bind(s), append = s.append.bind(s);
  s.put = async (...a) => { const r = await put(...a); if (r.ok) await flush(); return r; };
  s.append = async (...a) => { const r = await append(...a); await flush(); return r; };
  return s;
}
