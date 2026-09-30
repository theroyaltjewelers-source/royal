/* The Store contract (core/store.js), run against every backend:
   MemoryStore, the JSON file store and, when TEST_DATABASE_URL is set,
   PgStore (core/pgstore.js).  The Postgres tests use their own schema so they
   never touch the tables tests/grokbot.test.js resets. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore, fileStore } from "../core/store.js";
import { AuditService } from "../core/audit.js";
import { EventBus } from "../core/events.js";
import { createRoyal } from "../core/royal.js";
import { createHandler } from "../server/handler.js";
import { storeFromEnv } from "../server/store-env.js";
import { house, NOW } from "./fixtures.js";

const MIGRATIONS = join(dirname(dirname(fileURLToPath(import.meta.url))), "server", "migrations");
const OWNER = { id: "u-tahir", role: "owner" };
const quiet = { log() {}, warn() {} };

/* ------------------------------------------------------------ backends --- */

const DB = process.env.TEST_DATABASE_URL;
const pgSkip = DB ? false : "set TEST_DATABASE_URL to run the Postgres tests";
const SCHEMA = "royal_store_test";

/* The test database URL, pointed at this file's own schema. */
function schemaUrl() {
  const u = new URL(DB);
  u.searchParams.set("options", "-c search_path=" + SCHEMA);
  return u.toString();
}
const pgEnv = (extra = {}) => ({ DATABASE_URL: schemaUrl(), DATABASE_SSL: "false", ...extra });

async function freshSchema() {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  try {
    await pool.query("DROP SCHEMA IF EXISTS " + SCHEMA + " CASCADE");
    await pool.query("CREATE SCHEMA " + SCHEMA);
  } finally { await pool.end(); }
}

/* Opens a migrated PgStore on the test schema (a fresh one unless `keep`). */
async function openPg({ keep = false } = {}) {
  if (!keep) await freshSchema();
  const { store, pool } = await storeFromEnv(pgEnv(), { migrationsDir: MIGRATIONS, logger: quiet });
  return { store, pool, close: () => pool.end() };
}

const tmpFiles = [];
async function openFile() {
  const dir = await mkdtemp(join(tmpdir(), "royal-store-"));
  tmpFiles.push(dir);
  return { store: await fileStore(join(dir, "royal.json")), close: async () => {} };
}

const BACKENDS = [
  { name: "memory", open: async () => ({ store: new MemoryStore(), close: async () => {} }) },
  { name: "file", open: openFile },
  { name: "postgres", open: openPg, skip: pgSkip },
];

/* --------------------------------------------------------- conformance --- */

for (const B of BACKENDS) {
  const t = (title, fn) => test(B.name + ": " + title, { skip: B.skip || false }, async () => {
    const s = await B.open();
    try { await fn(s.store); } finally { await s.close(); }
  });

  t("store refuses a write over a revision that has moved", async (s) => {
    const a = await s.put("tasks", "t1", { v: 1 }, null);
    assert.equal(a.ok, true); assert.equal(a.rev, 1);
    assert.equal((await s.put("tasks", "t1", { v: 2 }, null)).ok, false);
    const b = await s.put("tasks", "t1", { v: 2 }, 1);
    assert.equal(b.ok, true); assert.equal(b.rev, 2);
    const stale = await s.put("tasks", "t1", { v: 3 }, 1);
    assert.equal(stale.ok, false); assert.equal(stale.conflict, true); assert.equal(stale.current.data.v, 2); assert.equal(stale.current.rev, 2);
    const missing = await s.put("tasks", "nope", { v: 1 }, 4);
    assert.equal(missing.ok, false); assert.equal(missing.current, null);
    assert.deepEqual(await s.get("tasks", "t1"), { id: "t1", data: { v: 2 }, rev: 2 });
    assert.equal(await s.get("tasks", "nope"), null);
  });

  t("get, put and list keep kinds apart and return copies", async (s) => {
    await s.put("tasks", "a", { n: [1, 2, { x: "y" }], nested: { deep: true } }, null);
    await s.put("tasks", "b", { n: 2 }, null);
    await s.put("commitments", "a", { other: true }, null);
    const got = await s.get("tasks", "a");
    got.data.n.push(99);
    assert.deepEqual((await s.get("tasks", "a")).data.n, [1, 2, { x: "y" }], "a caller's change does not reach the store");
    assert.deepEqual((await s.list("tasks")).map((r) => r.id).sort(), ["a", "b"]);
    assert.deepEqual((await s.list("commitments")).map((r) => r.data), [{ other: true }]);
    assert.deepEqual(await s.list("waiting"), []);
  });

  t("the audit log is append-only", async (s) => {
    const first = await s.append("audit", { action: "X" });
    const second = await s.append("audit", { action: "Y" });
    assert.ok(second.seq > first.seq); assert.match(first.id, /^audit_\d{8}$/);
    await assert.rejects(() => s.put("audit", "audit_00000001", {}, 1), /APPEND_ONLY/);
    await assert.rejects(() => s.get("events", "x"), /APPEND_ONLY/);
    await assert.rejects(() => s.list("audit"), /APPEND_ONLY/);
    await assert.rejects(() => s.append("tasks", { a: 1 }), /NOT_A_LOG/);
    const r = await s.readLog("audit");
    assert.deepEqual(r.map((x) => x.action), ["X", "Y"]);
    assert.equal(r[0].id, first.id); assert.equal(r[0].seq, first.seq);
    r[0].action = "CHANGED";
    assert.equal((await s.readLog("audit"))[0].action, "X", "a caller's change does not reach the log");
  });

  t("readLog returns the latest entries after `since`, oldest first", async (s) => {
    const seqs = [];
    for (let i = 1; i <= 6; i++) seqs.push((await s.append("events", { type: "PAYMENT_RECEIVED", key: "k" + i, i })).seq);
    await s.append("audit", { action: "OTHER_LOG" });
    assert.deepEqual((await s.readLog("events", { limit: 2 })).map((r) => r.i), [5, 6]);
    assert.deepEqual((await s.readLog("events", { since: seqs[3] })).map((r) => r.i), [5, 6]);
    assert.deepEqual((await s.readLog("events", { since: seqs[0], limit: 3 })).map((r) => r.i), [4, 5, 6]);
    assert.deepEqual(await s.readLog("events", { since: seqs[5] }), []);
    assert.equal(await s.hasKey("events", "k3"), true);
    assert.equal(await s.hasKey("events", "k9"), false);
    assert.equal(await s.hasKey("audit", "k3"), false, "keys are per log");
  });

  t("a duplicate event is recognised and handled once", async (s) => {
    const bus = new EventBus({ store: s, audit: new AuditService(s) });
    let n = 0; bus.subscribe(["PAYMENT_RECEIVED"], () => { n++; });
    await bus.publish({ type: "PAYMENT_RECEIVED", key: "p1" });
    const again = await bus.publish({ type: "PAYMENT_RECEIVED", key: "p1" });
    assert.equal(n, 1); assert.equal(again.duplicate, true);
    await assert.rejects(() => bus.publish({ type: "NOT_A_THING", key: "x" }), /EVENT_INVALID/);
  });

  t("secrets never reach the audit log", async (s) => {
    const a = new AuditService(s);
    await a.record({ action: "X", result: { api_key: "xai-abcdefghijklmnopqrstu", nested: { Authorization: "Bearer y" }, jwt: "eyJa.eyJb.c" } });
    const [r] = await s.readLog("audit");
    const txt = JSON.stringify(r);
    assert.ok(!/xai-abc/.test(txt)); assert.ok(!/Bearer y/.test(txt)); assert.ok(!/eyJa\.eyJb/.test(txt));
  });

  t("two writers holding the same revision: exactly one wins", async (s) => {
    await s.put("decisions", "d1", { status: "OPEN" }, null);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => s.put("decisions", "d1", { status: "APPROVED", by: i }, 1)));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal((await s.get("decisions", "d1")).rev, 2);
    const creates = await Promise.all(Array.from({ length: 8 }, (_, i) => s.put("decisions", "d2", { by: i }, null)));
    assert.equal(creates.filter((r) => r.ok).length, 1, "only one writer may create a record");
  });

  t("the durable flag says whether records survive a restart", async (s) => {
    assert.equal(!!s.durable, B.name !== "memory");
  });
}

test("file: the store file is owner-readable only and reloads what was written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "royal-store-")); tmpFiles.push(dir);
  const path = join(dir, "royal.json");
  const a = await fileStore(path);
  await a.put("tasks", "t1", { v: 1 }, null); await a.append("audit", { action: "X", key: "k" });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const b = await fileStore(path);
  assert.deepEqual(await b.get("tasks", "t1"), { id: "t1", data: { v: 1 }, rev: 1 });
  assert.equal(await b.hasKey("audit", "k"), true);
});

test.after(async () => { for (const d of tmpFiles) await rm(d, { recursive: true, force: true }); });

/* ------------------------------------------------------ Postgres only --- */

test("store choice: without DATABASE_URL the store is the file or memory, as before", async () => {
  const warned = [];
  const mem = await storeFromEnv({}, { logger: { log() {}, warn: (m) => warned.push(m) } });
  assert.ok(mem.store instanceof MemoryStore); assert.equal(mem.pool, null); assert.equal(!!mem.store.durable, false);
  assert.match(warned.join(" "), /lost on restart/);
  const dir = await mkdtemp(join(tmpdir(), "royal-store-")); tmpFiles.push(dir);
  const f = await storeFromEnv({ ROYAL_STORE_PATH: join(dir, "royal.json") }, { logger: quiet });
  assert.equal(f.store.durable, true); assert.equal(f.pool, null);
});

test("postgres: the database itself refuses to change or remove log entries", { skip: pgSkip }, async () => {
  const { store, pool, close } = await openPg();
  try {
    await store.append("audit", { action: "X" });
    await assert.rejects(pool.query("UPDATE royal_log SET record = '{}'::jsonb"), /STORE_APPEND_ONLY/);
    await assert.rejects(pool.query("DELETE FROM royal_log"), /STORE_APPEND_ONLY/);
    await assert.rejects(pool.query("TRUNCATE royal_log"), /STORE_APPEND_ONLY/);
    await assert.rejects(pool.query("INSERT INTO royal_log (log, id, record) VALUES ('scratch', 'x', '{}')"), /check/i);
    await assert.rejects(pool.query("INSERT INTO royal_records (kind, id, data, rev) VALUES ('audit', 'x', '{}', 1)"), /check/i);
    assert.equal((await store.readLog("audit")).length, 1);
  } finally { await close(); }
});

test("postgres: migrations apply once, and a second start changes nothing", { skip: pgSkip }, async () => {
  const a = await openPg();
  await a.store.put("tasks", "t1", { v: 1 }, null);
  const b = await openPg({ keep: true });
  try {
    const names = (await b.pool.query("SELECT name FROM royal_migrations ORDER BY name")).rows.map((r) => r.name);
    assert.deepEqual(names, ["001_grokbot.sql", "002_royal_store.sql"]);
    assert.deepEqual((await b.store.get("tasks", "t1")).data, { v: 1 });
  } finally { await a.close(); await b.close(); }
});

test("postgres: a Decision survives a restart and can be resolved once only", { skip: pgSkip }, async () => {
  const first = await openPg();
  const r1 = createRoyal({ store: first.store, clock: () => NOW });
  assert.equal((await r1.ingestCalculator(house())).ok, true);
  await r1.handle({ content: "What needs me?", conversation_id: "c1" });
  await r1.handle({ content: "Handle it.", conversation_id: "c1" });
  const open = await r1.decisions.list({ status: "OPEN" });
  assert.ok(open.length >= 1);
  const ledger = await r1.audit.executiveLedger();
  await first.close();

  const second = await openPg({ keep: true });
  try {
    const r2 = createRoyal({ store: second.store, clock: () => NOW });
    const again = await r2.decisions.list({ status: "OPEN" });
    assert.deepEqual(again.map((d) => d.id).sort(), open.map((d) => d.id).sort());
    assert.deepEqual((await r2.audit.executiveLedger()).map((e) => e.id), ledger.map((e) => e.id), "the activity list survives");
    const ok = await r2.decisions.resolve(open[0].id, { actor: OWNER, resolution: "REJECT" });
    assert.notEqual(ok.ok, false);
    const twice = await r2.decisions.resolve(open[0].id, { actor: OWNER, resolution: "APPROVE" });
    assert.equal(twice.ok, false); assert.equal(twice.failed_because, "ALREADY_REJECTED");
    /* the snapshot is there too, so the House answers without a new push */
    const a = await r2.handle({ content: "State of the House", conversation_id: "c2" });
    assert.notEqual(a.status, "FAILED");
  } finally { await second.close(); }
});

test("postgres: boot reports MEMORY as DURABLE", { skip: pgSkip }, async () => {
  const { store, close } = await openPg();
  try {
    const royal = createRoyal({ store });
    const h = createHandler({ royal, auth: async () => OWNER });
    const b = await (await h(new Request("https://royal.test/v1/boot", { headers: { Authorization: "Bearer x" } }))).json();
    const mem = b.lines.find((l) => l.k === "MEMORY");
    assert.equal(mem.v, "DURABLE"); assert.equal(mem.ok, true);
  } finally { await close(); }
});

test("postgres: a file store is imported once, with counts only in the audit", { skip: pgSkip }, async () => {
  await freshSchema();
  const dir = await mkdtemp(join(tmpdir(), "royal-store-")); tmpFiles.push(dir);
  const path = join(dir, "royal.json");
  const f = await fileStore(path);
  await f.put("decisions", "dec_1", { title: "Refund Marcus", status: "OPEN" }, null);
  await f.put("decisions", "dec_1", { title: "Refund Marcus", status: "REJECTED" }, 1);
  await f.put("tasks", "t1", { title: "Call the setter" }, null);
  await new AuditService(f).record({ action: "DECISION_CREATED", summary: "Decision needed", key: "dec_1", executive: true });
  await f.append("events", { type: "PAYMENT_RECEIVED", key: "evt-1" });

  const env = pgEnv({ ROYAL_STORE_PATH: path, ROYAL_IMPORT_FILE_STORE: "true" });
  const a = await storeFromEnv(env, { migrationsDir: MIGRATIONS, logger: quiet });
  const b = await storeFromEnv(env, { migrationsDir: MIGRATIONS, logger: quiet });   /* second start: nothing more */
  try {
    assert.deepEqual(await a.store.get("decisions", "dec_1"), { id: "dec_1", data: { title: "Refund Marcus", status: "REJECTED" }, rev: 2 });
    assert.equal((await a.store.list("tasks")).length, 1);
    assert.equal(await a.store.hasKey("events", "evt-1"), true);
    const audit = await a.store.readLog("audit");
    assert.deepEqual(audit.map((r) => r.action), ["DECISION_CREATED", "STORE_IMPORTED"], "imported once, audited once");
    assert.equal(audit[0].id, "audit_00000001", "imported entries keep their ids");
    const imp = audit[1];
    assert.deepEqual(imp.result, { records: 2, audit: 1, events: 1 });
    assert.ok(!/Marcus|Refund|setter/.test(JSON.stringify(imp)), "the import audit carries counts, not content");
    const next = await a.store.append("events", { type: "PAYMENT_RECEIVED", key: "evt-2" });
    assert.ok(next.seq > 1, "new entries continue above the imported ones");
    /* An import never runs over a database that already holds records. */
    await f.put("tasks", "t2", { title: "Later" }, null);
    const c = await storeFromEnv(env, { migrationsDir: MIGRATIONS, logger: quiet });
    assert.equal(await c.store.get("tasks", "t2"), null);
    await c.pool.end();
  } finally { await a.pool.end(); await b.pool.end(); }
});

test("postgres: the bridge and the store share one pool", { skip: pgSkip }, async () => {
  const { store, pool } = await openPg();
  const { bridgeFromEnv } = await import("../core/grokbot/bridge.js");
  const bridge = await bridgeFromEnv(pgEnv(), { pool, logger: quiet });
  await bridge.close();
  /* closing the bridge leaves the shared pool open for the store */
  await store.put("tasks", "after-bridge", { ok: true }, null);
  assert.equal((await store.get("tasks", "after-bridge")).data.ok, true);
  await pool.end();
});
