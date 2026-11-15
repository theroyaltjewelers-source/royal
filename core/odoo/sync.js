/* One Odoo sync pass: pull every undelivered page (after=0, then next_cursor),
   mirror each event, then ack that page before asking for the next. The next
   pass starts at after=0 again, because the feed only returns what is still
   unacknowledged.
   Applied event ids, record versions and Odoo ids live in ROYAL's own store
   (the same one /v1/boot reports as DURABLE when Postgres or the file store
   is on). An event that fails while writing to Odoo is kept in odoo_retry
   and is not acknowledged, so the next pass tries it again even when the
   feed has nothing new. Acknowledging it as failed made the feed stop
   offering it. A skipped event (bridge.test, test flag, stale version) is
   remembered and acked as delivered, so it is not served again and is not
   written to Odoo. A bad envelope (no id, unknown type) is acked as failed
   because trying it again cannot succeed. */

import { createHash, timingSafeEqual } from "node:crypto";
import { chunkAck, createFeedClient, DEFAULT_FEED_BASE } from "./feed.js";
import { createOdooClient, redact } from "./client.js";
import { planEvent, recordKey } from "./plan.js";
import { applyHouseEvent } from "./map.js";
import { noteForwardWrite, runReverse } from "./reverse.js";

export const ODOO_STORE = Object.freeze({ event: "odoo_event", map: "odoo_map", state: "odoo_sync", stateId: "state", retry: "odoo_retry" });

const EMPTY_COUNTS = { runs: 0, delivered: 0, failed: 0, skipped: 0, applied: 0 };

export function storeId(key) {
  const s = String(key);
  if (s.length >= 1 && s.length <= 512) return s;
  return "h:" + createHash("sha256").update(s).digest("hex");
}

export function sameSecret(expected, got) {
  if (!expected || !got) return false;
  const a = createHash("sha256").update(String(expected), "utf8").digest();
  const b = createHash("sha256").update(String(got), "utf8").digest();
  return timingSafeEqual(a, b);
}

export async function casUpdate(store, kind, id, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await store.get(kind, id);
    const next = await fn(cur ? cur.data : null, cur);
    if (next === undefined) return cur;
    const rec = await store.put(kind, id, next, cur ? cur.rev : null);
    if (rec.ok) return { id, data: next, rev: rec.rev };
  }
  throw new Error("I could not save the Odoo sync record.");
}

function text(v) { return v == null ? "" : String(v).trim(); }

function checkHttps(value, name, issues) {
  const s = text(value);
  if (!s) { issues.push("Set " + name + "."); return ""; }
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.username || u.password) throw new Error("bad");
    return s;
  } catch (_) { issues.push(name + " must be an https address with no password in it."); return ""; }
}

/* Reads the environment. Enabled only when the switch is exactly "true" and
   every required value is present and well formed. Otherwise the worker does
   nothing. Reasons name variables, never values. */
export function readOdooConfig(env) {
  const allowTest = env.ODOO_SYNC_ALLOW_TEST === "true";
  const blank = { enabled: false, allowTest, journalId: null, runSecret: "", secrets: [], reverseEnabled: false, reverseDryRun: false };
  if (env.ODOO_SYNC_ENABLED !== "true") {
    return { ...blank, reason: "ODOO_SYNC_ENABLED is not true, so I am not syncing to Odoo." };
  }
  const issues = [];
  const odooUrl = checkHttps(env.ODOO_URL, "ODOO_URL", issues);
  const feedBase = checkHttps(text(env.REPAINT_FEED_BASE_URL) || DEFAULT_FEED_BASE, "REPAINT_FEED_BASE_URL", issues);
  const db = text(env.ODOO_DB);
  if (!db) issues.push("Set ODOO_DB.");
  else if (!/^[A-Za-z0-9._-]+$/.test(db)) issues.push("ODOO_DB has characters I cannot use.");
  const apiKey = text(env.ODOO_API_KEY);
  if (!apiKey) issues.push("Set ODOO_API_KEY.");
  const keyId = text(env.REPAINT_FEED_KEY_ID);
  if (!keyId) issues.push("Set REPAINT_FEED_KEY_ID.");
  else if (!/^[A-Za-z0-9._-]{1,40}$/.test(keyId)) issues.push("REPAINT_FEED_KEY_ID must be 1 to 40 letters, numbers, dots, underscores or hyphens.");
  const feedSecret = text(env.REPAINT_FEED_SECRET);
  if (!feedSecret) issues.push("Set REPAINT_FEED_SECRET.");
  else if (feedSecret.length < 32 || feedSecret.length > 128) issues.push("REPAINT_FEED_SECRET must be 32 to 128 characters.");
  let journalId = null;
  if (text(env.ODOO_PAYMENT_JOURNAL_ID)) {
    if (!/^[1-9]\d*$/.test(text(env.ODOO_PAYMENT_JOURNAL_ID))) issues.push("ODOO_PAYMENT_JOURNAL_ID must be a positive integer.");
    else journalId = Number(text(env.ODOO_PAYMENT_JOURNAL_ID));
  }
  let runSecret = text(env.ODOO_SYNC_RUN_SECRET);
  if (runSecret && runSecret.length < 16) {
    issues.push("ODOO_SYNC_RUN_SECRET must be at least 16 characters.");
    runSecret = "";
  }
  if (issues.length) return { ...blank, journalId, reason: "I am not syncing to Odoo yet. " + issues.join(" ") };
  return {
    enabled: true, allowTest, reason: "", odooUrl, db, apiKey, feedBase, keyId, feedSecret, journalId, runSecret,
    secrets: [apiKey, feedSecret, runSecret].filter((s) => s && s.length >= 8),
    reverseEnabled: env.ODOO_REVERSE_SYNC_ENABLED === "true",
    reverseDryRun: env.ODOO_REVERSE_SYNC_DRY_RUN === "true",
  };
}

async function remember(store, event, reason, now) {
  await casUpdate(store, ODOO_STORE.event, storeId(event.event_id), (cur) => cur || ({
    status: "delivered", reason, event_type: event.event_type || "", at: now().toISOString(),
  }));
}

async function queueRetry(store, event, error, now) {
  await casUpdate(store, ODOO_STORE.retry, storeId(event.event_id), (cur) => ({
    status: "pending", event, error, attempts: ((cur && cur.attempts) || 0) + 1, at: now().toISOString(),
  }));
}

async function finishRetry(store, eventId, now) {
  if (!eventId) return;
  const id = storeId(eventId);
  const cur = await store.get(ODOO_STORE.retry, id);
  if (!cur || !cur.data || cur.data.status === "done") return;
  await casUpdate(store, ODOO_STORE.retry, id, () => ({ status: "done", at: now().toISOString() }));
}

/* Pull, apply, ack. `feed` and `apply` are injectable. Pages are acked
   before the next page is requested, inside the lease the feed keeps. */
export async function runPass({ feed, store, cfg, odoo, apply = applyHouseEvent, now = () => new Date(), limit = 50, maxPages = 200, log = () => {} }) {
  const cache = {};
  const totals = { delivered: 0, failed: 0, skipped: 0, applied: 0, errors: [] };
  const handled = new Set();

  async function ackChunks(delivered, failed) {
    for (const chunk of chunkAck(delivered, failed)) {
      const ack = await feed.ack(chunk);
      if (!ack || ack.ok === false) throw new Error("The House feed did not accept the acknowledgement" + (ack && ack.error ? ": " + ack.error : "."));
    }
  }

  /* "delivered" is acked. "failed" is acked as failed (the envelope itself is
     unusable). "hold" is kept locally and not acked, so it is tried again. */
  async function applyOne(event) {
    const eventId = event && typeof event.event_id === "string" ? event.event_id : "";
    if (eventId && handled.has(eventId)) return { ack: "hold", eventId };
    if (eventId) handled.add(eventId);
    if (eventId) {
      const seen = await store.get(ODOO_STORE.event, storeId(eventId));
      if (seen) {
        totals.delivered++; totals.skipped++;
        await finishRetry(store, eventId, now);
        return { ack: "delivered", eventId };
      }
    }
    const key = recordKey(event);
    let previous = null;
    if (key) {
      const row = await store.get(ODOO_STORE.map, storeId(key));
      if (row && row.data && Number.isFinite(row.data.version)) previous = row.data.version;
    }
    const plan = planEvent(event, { previousVersion: previous, allowTest: cfg.allowTest });
    if (plan.action === "fail") {
      const error = redact(plan.error, cfg.secrets);
      totals.failed++; totals.errors.push({ at: now().toISOString(), event_id: eventId, event_type: event && event.event_type || "", error });
      return { ack: "failed", eventId, error };
    }
    if (plan.action === "skip") {
      await remember(store, event, plan.reason, now);
      await finishRetry(store, event.event_id, now);
      totals.delivered++; totals.skipped++;
      return { ack: "delivered", eventId };
    }
    try {
      const mapped = await store.get(ODOO_STORE.map, storeId(plan.key));
      const result = await apply(event, { odoo, cache, cfg, mappedId: mapped && mapped.data ? mapped.data.odoo_id : null });
      await casUpdate(store, ODOO_STORE.map, storeId(plan.key), (cur) => ({
        version: Math.max(plan.version, cur && Number.isFinite(cur.version) ? cur.version : 0),
        model: result.model, odoo_id: result.odoo_id, at: now().toISOString(),
      }));
      await remember(store, event, "applied", now);
      await noteForwardWrite(store, event, result.odoo_id, now);
      await finishRetry(store, event.event_id, now);
      totals.delivered++; totals.applied++;
      return { ack: "delivered", eventId };
    } catch (e) {
      const error = redact(e.message, cfg.secrets);
      if (eventId) await queueRetry(store, event, error, now);
      totals.failed++; totals.errors.push({ at: now().toISOString(), event_id: eventId, event_type: event && event.event_type || "", error });
      return { ack: "hold", eventId, error };
    }
  }

  async function passPages() {
    let rows = [];
    try { rows = await store.list(ODOO_STORE.retry); } catch (_) { rows = []; }
    const held = [];
    for (const row of rows) {
      if (!row.data || row.data.status !== "pending" || !row.data.event) continue;
      const outcome = await applyOne(row.data.event);
      if (outcome.ack === "delivered" && outcome.eventId) held.push(outcome.eventId);
    }
    if (held.length) await ackChunks(held, []);

    await pullFeed();
    if (cfg.reverseEnabled) {
      try {
        totals.reverse = await runReverse({
          odoo, post: (body) => feed.changes(body), store, dryRun: !!cfg.reverseDryRun, now, log,
          onConflict: async () => { await pullFeed(); },
        });
      } catch (e) {
        const message = redact(e.message, cfg.secrets);
        totals.reverse = { ok: false, dry_run: !!cfg.reverseDryRun, sent: 0, failed: 1, held: 0, skipped: 0, errors: [{ at: now().toISOString(), error: message }], preview: [] };
        log("ROYAL: reverse sync did not finish. " + message);
      }
    }
    return totals;

    async function pullFeed() {
    let after = 0;
    for (let page = 0; page < maxPages; page++) {
      const body = await feed.getEvents(after, limit);
      const events = Array.isArray(body.events) ? body.events : [];
      const delivered = [];
      const failed = [];
      for (const event of events) {
        const outcome = await applyOne(event);
        if (!outcome.eventId || outcome.ack === "hold") continue;
        if (outcome.ack === "failed") failed.push({ event_id: outcome.eventId, error: outcome.error });
        else delivered.push(outcome.eventId);
      }
      if (delivered.length || failed.length) await ackChunks(delivered, failed);
      if (body.has_more !== true) return;
      const next = Number(body.next_cursor);
      if (!Number.isInteger(next) || next === after) throw new Error("The House feed said there is more, but did not move the cursor.");
      after = next;
    }
    throw new Error("The House feed kept paging past the safety limit.");
    }
  }

  try {
    return await passPages();
  } catch (e) { e.syncTotals = totals; throw e; }
}

export function createSync({ store, cfg, feed, odoo, now = () => new Date(), log = () => {}, apply } = {}) {
  if (!store) throw new Error("Odoo sync needs ROYAL's store.");
  const config = cfg || { enabled: false, allowTest: false, reason: "ODOO_SYNC_ENABLED is not true, so I am not syncing to Odoo.", secrets: [] };
  let inflight = null;

  async function saveState(patch) {
    await casUpdate(store, ODOO_STORE.state, ODOO_STORE.stateId, (cur) => {
      const prev = cur || { counts: { ...EMPTY_COUNTS }, last_errors: [] };
      const counts = { ...EMPTY_COUNTS, ...(prev.counts || {}) };
      counts.runs += 1;
      counts.delivered += patch.totals.delivered;
      counts.failed += patch.totals.failed;
      counts.skipped += patch.totals.skipped;
      counts.applied += patch.totals.applied;
      const last_errors = [...(patch.totals.errors || []).slice().reverse(), ...(prev.last_errors || [])].slice(0, 20);
      return {
        counts, last_errors,
        last_run: { at: now().toISOString(), ok: patch.ok, delivered: patch.totals.delivered, failed: patch.totals.failed,
          skipped: patch.totals.skipped, applied: patch.totals.applied, error: patch.error || null },
        reverse: patch.totals.reverse || (prev && prev.reverse) || null,
      };
    });
  }

  async function once() {
    const totals = { delivered: 0, failed: 0, skipped: 0, applied: 0, errors: [] };
    if (!config.enabled) return { ok: true, enabled: false, ran: false, reason: config.reason, ...publicTotals(totals) };
    const feedClient = feed || createFeedClient({ baseUrl: config.feedBase, keyId: config.keyId, secret: config.feedSecret });
    const odooClient = odoo || createOdooClient({ url: config.odooUrl, database: config.db, apiKey: config.apiKey });
    try {
      const result = await runPass({ feed: feedClient, store, cfg: config, odoo: odooClient, apply, now, log });
      Object.assign(totals, result);
      await saveState({ ok: true, error: null, totals });
      log("ROYAL: Odoo sync pass applied " + totals.applied + ", skipped " + totals.skipped + ", failed " + totals.failed + ".");
      return { ok: true, enabled: true, ran: true, ...publicTotals(totals) };
    } catch (e) {
      if (e.syncTotals) Object.assign(totals, e.syncTotals);
      const message = redact(e.message, config.secrets);
      try { await saveState({ ok: false, error: message, totals }); } catch (_) {}
      log("ROYAL: Odoo sync pass did not finish. " + message);
      return { ok: false, enabled: true, ran: true, error: "SYNC_FAILED", message, ...publicTotals(totals) };
    }
  }

  function run() {
    if (inflight) return inflight;
    inflight = once().finally(() => { inflight = null; });
    return inflight;
  }

  async function status() {
    let saved = null;
    try { saved = await store.get(ODOO_STORE.state, ODOO_STORE.stateId); } catch (_) { saved = null; }
    const data = saved && saved.data || {};
    return {
      ok: true, enabled: !!config.enabled, allow_test: !!config.allowTest,
      reason: config.enabled ? undefined : config.reason,
      last_run: data.last_run || null,
      counts: { ...EMPTY_COUNTS, ...(data.counts || {}) },
      last_errors: Array.isArray(data.last_errors) ? data.last_errors : [],
      reverse: {
        enabled: !!config.reverseEnabled, dry_run: !!config.reverseDryRun,
        ...(data.reverse || { sent: 0, skipped: 0, failed: 0, held: 0, preview: [], errors: [] }),
      },
    };
  }

  return { enabled: !!config.enabled, run, status };
}

function publicTotals(t) {
  return {
    delivered: t.delivered, failed: t.failed, skipped: t.skipped, applied: t.applied,
    errors: (t.errors || []).slice(0, 20),
  };
}

/* The object the HTTP handler holds. The run secret stays in this closure
   and is not a property, so a log of the object cannot print it. */
export function odooSyncFromEnv(env, { store, fetchImpl, log = () => {} } = {}) {
  const cfg = readOdooConfig(env || {});
  if ((env || {}).ODOO_SYNC_ENABLED === "true") {
    if (cfg.enabled) log("ROYAL: Odoo sync is on.");
    else log("ROYAL: Odoo sync is off. " + cfg.reason);
  }
  const feed = cfg.enabled ? createFeedClient({ baseUrl: cfg.feedBase, keyId: cfg.keyId, secret: cfg.feedSecret, fetchImpl }) : null;
  const odoo = cfg.enabled ? createOdooClient({ url: cfg.odooUrl, database: cfg.db, apiKey: cfg.apiKey, fetchImpl }) : null;
  const sync = createSync({ store, cfg, feed, odoo, log });
  return {
    enabled: cfg.enabled,
    secretOk(header) { return sameSecret(cfg.runSecret, header); },
    status: () => sync.status(),
    run: () => sync.run(),
  };
}

/* Poll while the process is awake. Render sleeps when idle, so this is not
   the only trigger: POST /v1/odoo-sync/run runs one pass from outside. */
export function startOdooSync(sync, { intervalMs = 60000, firstDelayMs = 5000 } = {}) {
  if (!sync || !sync.enabled) return { stop() {} };
  const tick = () => { sync.run().catch(() => {}); };
  const first = setTimeout(tick, firstDelayMs);
  const timer = setInterval(tick, intervalMs);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return { stop() { clearTimeout(first); clearInterval(timer); } };
}
