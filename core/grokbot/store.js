/* Grok Bot bridge storage.  Two implementations of one async interface:

     MemoryBridgeStore  no database: tests, local runs.  Lost on restart.
     PgBridgeStore      Postgres (DATABASE_URL).  Durable, shared by instances.

   The isolation boundary is bot_id.  Every read and every write names the
   bot, and every query filters on it; the database adds a composite foreign
   key so an event cannot point at another bot's request.

   Interface
     durable                                   true for Postgres
     createRequest(r) / getRequest(botId, id) / updateRequest(botId, id, patch)
     appendEvent(e)          -> stored event {id (string), created_at, ...}
     getEvent(botId, id)
     listEvents({ botIds, realm, since, limit })  ascending by id
         botIds: the bots allowed in this view (never empty for a real call)
         since: event id (exclusive); without it, the latest `limit`
     touchBot(botId, patch) / getBotState(botId)
     insertToken({ bot_id, prefix, token_hash })  revokes the bot's active token first
     revokeTokens(botId) -> number revoked
     findActiveToken(prefix) / touchToken(id) */

import { randomUUID } from "node:crypto";

const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const since0 = (s) => (s == null || s === "" ? null : String(s));

export class MemoryBridgeStore {
  constructor({ maxEventsPerBot = 1000 } = {}) {
    this.durable = false; this.kind = "memory";
    this.seq = 0; this.max = maxEventsPerBot;
    this.events = new Map(); this.requests = new Map(); this.state = new Map(); this.tokens = [];
  }
  async createRequest(r) {
    const now = new Date().toISOString();
    const row = { id: r.id, bot_id: r.bot_id, realm: r.realm, conversation_id: r.conversation_id || null, skill: r.skill || null,
      content: r.content || "", status: r.status, requested_by: r.requested_by || null, created_at: now, updated_at: now, last_error: null };
    this.requests.set(r.id, row); return { ...row };
  }
  async getRequest(botId, id) { const r = this.requests.get(id); return r && r.bot_id === botId ? { ...r } : null; }
  async updateRequest(botId, id, patch) {
    const r = this.requests.get(id); if (!r || r.bot_id !== botId) return null;
    Object.assign(r, patch, { updated_at: new Date().toISOString() }); return { ...r };
  }
  async appendEvent(e) {
    if (e.request_id) { const r = this.requests.get(e.request_id); if (!r || r.bot_id !== e.bot_id || r.realm !== e.realm) throw Object.assign(new Error("request belongs to another bot or realm"), { code: "23503" }); }
    const row = Object.freeze({ id: String(++this.seq), bot_id: e.bot_id, realm: e.realm, request_id: e.request_id || null, type: e.type,
      content_markdown: e.content_markdown, status: e.status || null, author: e.author || null, created_at: new Date().toISOString() });
    let list = this.events.get(row.bot_id); if (!list) this.events.set(row.bot_id, (list = []));
    list.push(row); if (list.length > this.max) list.splice(0, list.length - this.max);
    return row;
  }
  async getEvent(botId, id) { return (this.events.get(botId) || []).find((e) => e.id === String(id)) || null; }
  async listEvents({ botIds, realm, since = null, limit = 100 }) {
    const s = since0(since);
    const all = [].concat(...botIds.map((b) => this.events.get(b) || [])).filter((e) => (!realm || e.realm === realm) && (s == null || Number(e.id) > Number(s)))
      .sort((a, b) => Number(a.id) - Number(b.id));
    return s != null ? all.slice(0, limit) : all.slice(-limit);
  }
  async touchBot(botId, patch) { this.state.set(botId, { ...(this.state.get(botId) || {}), ...patch }); }
  async getBotState(botId) { return { ...(this.state.get(botId) || {}) }; }
  async insertToken({ bot_id, prefix, token_hash }) {
    const now = new Date().toISOString();
    for (const t of this.tokens) if (t.bot_id === bot_id && !t.revoked_at) t.revoked_at = now;
    const row = { id: randomUUID(), bot_id, prefix, token_hash, created_at: now, last_used_at: null, revoked_at: null };
    this.tokens.push(row); return { ...row };
  }
  async revokeTokens(botId) {
    const now = new Date().toISOString(); let n = 0;
    for (const t of this.tokens) if (t.bot_id === botId && !t.revoked_at) { t.revoked_at = now; n++; }
    return n;
  }
  async findActiveToken(prefix) { const t = this.tokens.find((x) => x.prefix === prefix && !x.revoked_at); return t ? { ...t } : null; }
  async touchToken(id) { const t = this.tokens.find((x) => x.id === id); if (t) t.last_used_at = new Date().toISOString(); }
  async close() {}
}

/* ------------------------------------------------------------------ pg --- */

/* The Postgres helpers moved to core/db.js so ROYAL's own store can share
   them; they are re-exported here so existing imports keep working. */
export { loadPg, poolConfig, migrate } from "../db.js";

const EV = "id::text AS id, bot_id, realm, request_id::text AS request_id, type, content_markdown, status, author, created_at";
const evRow = (r) => (r ? { ...r, created_at: iso(r.created_at) } : null);
const reqRow = (r) => (r ? { ...r, created_at: iso(r.created_at), updated_at: iso(r.updated_at) } : null);
const REQ_PATCH = ["status", "last_error", "conversation_id", "skill"];

export class PgBridgeStore {
  constructor(pool, { ownsPool = true } = {}) { this.pool = pool; this.ownsPool = ownsPool; this.durable = true; this.kind = "postgres"; }
  q(text, values) { return this.pool.query(text, values); }

  async createRequest(r) {
    const { rows } = await this.q(
      "INSERT INTO grokbot_requests (id, bot_id, realm, conversation_id, skill, content, status, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text AS id, *",
      [r.id, r.bot_id, r.realm, r.conversation_id || null, r.skill || null, r.content || "", r.status, r.requested_by || null]);
    return reqRow(rows[0]);
  }
  async getRequest(botId, id) {
    const { rows } = await this.q("SELECT id::text AS id, bot_id, realm, conversation_id, skill, content, status, requested_by, created_at, updated_at, last_error FROM grokbot_requests WHERE bot_id = $1 AND id = $2", [botId, id]);
    return reqRow(rows[0]);
  }
  async updateRequest(botId, id, patch) {
    const keys = Object.keys(patch).filter((k) => REQ_PATCH.indexOf(k) >= 0);
    if (!keys.length) return this.getRequest(botId, id);
    const sets = keys.map((k, i) => k + " = $" + (i + 3)).join(", ");
    const { rows } = await this.q("UPDATE grokbot_requests SET " + sets + ", updated_at = now() WHERE bot_id = $1 AND id = $2 RETURNING id::text AS id, *",
      [botId, id, ...keys.map((k) => patch[k])]);
    return reqRow(rows[0]);
  }
  async appendEvent(e) {
    const { rows } = await this.q(
      "INSERT INTO grokbot_events (bot_id, realm, request_id, type, content_markdown, status, author) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING " + EV,
      [e.bot_id, e.realm, e.request_id || null, e.type, e.content_markdown, e.status || null, e.author || null]);
    return evRow(rows[0]);
  }
  async getEvent(botId, id) {
    const { rows } = await this.q("SELECT " + EV + " FROM grokbot_events WHERE bot_id = $1 AND id = $2", [botId, id]);
    return evRow(rows[0]);
  }
  async listEvents({ botIds, realm, since = null, limit = 100 }) {
    if (!botIds || !botIds.length) return [];
    const s = since0(since);
    const where = "bot_id = ANY($1::text[])" + (realm ? " AND realm = $2" : " AND $2::text IS NULL");
    const rows = s != null
      ? (await this.q("SELECT " + EV + " FROM grokbot_events WHERE " + where + " AND id > $3 ORDER BY id ASC LIMIT $4", [botIds, realm || null, s, limit])).rows
      : (await this.q("SELECT * FROM (SELECT " + EV + " FROM grokbot_events WHERE " + where + " ORDER BY id DESC LIMIT $3) x ORDER BY id::bigint ASC", [botIds, realm || null, limit])).rows;
    return rows.map(evRow);
  }
  async touchBot(botId, patch) {
    const cols = ["last_seen", "last_message_at", "last_error"].filter((k) => k in patch);
    if (!cols.length) return;
    await this.q("INSERT INTO grokbot_bot_state (bot_id, " + cols.join(", ") + ") VALUES ($1, " + cols.map((_, i) => "$" + (i + 2)).join(", ") + ") " +
      "ON CONFLICT (bot_id) DO UPDATE SET " + cols.map((k) => k + " = EXCLUDED." + k).join(", "), [botId, ...cols.map((k) => patch[k])]);
  }
  async getBotState(botId) {
    const { rows } = await this.q("SELECT last_seen, last_message_at, last_error FROM grokbot_bot_state WHERE bot_id = $1", [botId]);
    const r = rows[0] || {};
    return { last_seen: iso(r.last_seen), last_message_at: iso(r.last_message_at), last_error: r.last_error || null };
  }
  async insertToken({ bot_id, prefix, token_hash }) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("UPDATE grokbot_bot_tokens SET revoked_at = now() WHERE bot_id = $1 AND revoked_at IS NULL", [bot_id]);
      const { rows } = await c.query("INSERT INTO grokbot_bot_tokens (id, bot_id, prefix, token_hash) VALUES ($1,$2,$3,$4) RETURNING id::text AS id, bot_id, prefix, created_at",
        [randomUUID(), bot_id, prefix, token_hash]);
      await c.query("COMMIT");
      return { ...rows[0], created_at: iso(rows[0].created_at) };
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
    finally { c.release(); }
  }
  async revokeTokens(botId) {
    const r = await this.q("UPDATE grokbot_bot_tokens SET revoked_at = now() WHERE bot_id = $1 AND revoked_at IS NULL", [botId]);
    return r.rowCount;
  }
  async findActiveToken(prefix) {
    const { rows } = await this.q("SELECT id::text AS id, bot_id, token_hash, revoked_at FROM grokbot_bot_tokens WHERE prefix = $1 AND revoked_at IS NULL", [prefix]);
    return rows[0] || null;
  }
  async touchToken(id) {
    /* at most once a minute per token, so a busy bot does not write on every call */
    await this.q("UPDATE grokbot_bot_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [id]);
  }
  async close() { if (this.ownsPool) await this.pool.end(); }
}
