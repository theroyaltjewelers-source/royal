/* ROYAL <-> Grok Bot bridge.

   Tahir talks to each external Grok Bot directly from ROYAL, and watches each
   one's feed separately.  Nothing mixes between bots, and nothing mixes
   between realms.

     ROYAL -> bot   sendMessage(): a request row, then a POST to that bot's
                    own webhook, with that bot's own key.
     bot -> ROYAL   postEvent(): the bot signs in with its own token and posts
                    to /v1/bots/<its id>/events.  Records only.
     live           stream(): Server-Sent Events for one bot or the combined
                    overview, resumable with Last-Event-ID.

   Safety.  Bot events are display-only.  Nothing here calls ROYAL's tools,
   decisions or executors, so no bot can send a client message, refund, pay a
   vendor, change a price or policy, or deploy.  Webhook URLs and keys never
   leave this module: not in responses, not in logs, not in errors.

   Framework-neutral: methods return { status, body }.  stream() returns a
   fetch-standard Response. */

import { randomUUID } from "node:crypto";
import { loadBotRegistry, authHeaderFor, publicBotView, BOT_ID_RE, LEGACY_BOT_ID, REALMS } from "./bots.js";
import { MemoryBridgeStore } from "./store.js";
import { LocalPubSub } from "./pubsub.js";
import { mintToken, verifyBotToken } from "./tokens.js";

export const LIMITS = Object.freeze({
  MAX_MESSAGE_CHARS: 2000,
  MAX_EVENT_CHARS: 100000,
  FEED_DEFAULT: 100, FEED_MAX: 500, REPLAY_MAX: 500, REPLAY_PAGES: 10,
  MAX_STREAMS_PER_SCOPE: 10, MAX_STREAMS_TOTAL: 100,
  SSE_HEARTBEAT_MS: 25000, SSE_RETRY_MS: 5000, SSE_MAX_BUFFER_BYTES: 1000000,
  MESSAGES_PER_MINUTE: 30, EVENTS_PER_MINUTE: 120,
  WEBHOOK_TIMEOUT_MS: 15000, WEBHOOK_RETRY_BACKOFF_MS: 750,
});

const BOT_EVENT_TYPES = ["progress", "result", "alert", "message"];
const REQUEST_STATUSES = ["requested", "delivered", "in_progress", "completed", "failed"];
const EVENT_TO_REQUEST = { progress: "in_progress", result: "completed" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONV_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const SKILL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const STATUS_RE = /^[a-z_]{1,32}$/;
const SINCE_RE = /^\d{1,18}$/;   /* fits a Postgres bigint */

const out = (status, body) => ({ status, body });
const ok = (body, status = 200) => out(status, { ok: true, ...body });
const fail = (status, error, message, extra = {}) => out(status, { ok: false, error, message, ...extra });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const blank = (v) => v === undefined || v === null || v === "";
function opt(v, re) { if (blank(v)) return [null, true]; return typeof v === "string" && re.test(v) ? [v, true] : [null, false]; }

export function createBridge({ env = {}, store = new MemoryBridgeStore(), pubsub = null, fetchImpl = globalThis.fetch, limits = {}, logger = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const L = { ...LIMITS, ...limits };
  const { bots, warnings, globalEnabled } = loadBotRegistry(env);
  warnings.forEach((w) => logger.warn && logger.warn("[grokbot] " + w));
  const ps = pubsub || new LocalPubSub(store);
  const counts = new Map(); let total = 0;
  const windows = new Map();

  const getBot = (id) => (typeof id === "string" && BOT_ID_RE.test(id) ? bots.get(id) || null : null);
  const realmOf = (r) => (blank(r) ? "BUSINESS" : String(r).toUpperCase());
  const allows = (bot, realm) => bot.realms.indexOf(realm) >= 0;
  const botsIn = (realm) => [...bots.values()].filter((b) => allows(b, realm));
  const now = () => new Date().toISOString();

  function limited(kind, botId, perMinute) {
    const t = Date.now(), k = kind + ":" + botId;
    const recent = (windows.get(k) || []).filter((x) => t - x < 60000);
    if (recent.length >= perMinute) { windows.set(k, recent); return true; }
    recent.push(t); windows.set(k, recent); return false;
  }
  function checkRealm(realm) { return REALMS.indexOf(realm) >= 0; }

  async function record(e) {
    const stored = await store.appendEvent(e);
    await ps.publish(stored.bot_id, stored.id).catch((err) => logger.warn && logger.warn("[grokbot] publish failed: " + err.message));
    return stored;
  }

  /* ------------------------------------------------------------ bots --- */
  async function listBots({ realm } = {}) {
    const r = realmOf(realm); if (!checkRealm(r)) return fail(400, "BAD_REALM", "Realm must be BUSINESS or PERSONAL.");
    const list = [];
    for (const b of botsIn(r)) list.push(publicBotView(b, await store.getBotState(b.id), { live_streams: counts.get(b.id) || 0 }));
    return ok({ realm: r, enabled: globalEnabled, storage: store.durable ? "DURABLE" : "TEMPORARY", bots: list });
  }

  /* ---------------------------------------------------------- tokens --- */
  async function issueToken(botId) {
    const bot = getBot(botId); if (!bot) return fail(404, "UNKNOWN_BOT", "No such bot.");
    const t = mintToken();
    let row;
    try { row = await store.insertToken({ bot_id: bot.id, prefix: t.prefix, token_hash: t.hash }); }
    catch (e) { if (e && e.code === "23505") return fail(409, "TOKEN_CONFLICT", "Another token for this bot was issued at the same moment. Try again."); throw e; }
    return ok({ bot_id: bot.id, token: t.token, prefix: t.prefix, created_at: row.created_at,
      reply_endpoint: "/v1/bots/" + bot.id + "/events", note: "Shown once. Store it in the bot's secure secret input. Any earlier token for this bot no longer works." }, 201);
  }
  async function revokeToken(botId) {
    const bot = getBot(botId); if (!bot) return fail(404, "UNKNOWN_BOT", "No such bot.");
    return ok({ bot_id: bot.id, revoked: await store.revokeTokens(bot.id) });
  }
  async function authenticate(token) {
    const p = await verifyBotToken(store, token);
    if (!p || !getBot(p.bot_id)) return null;
    return { kind: "bot", bot_id: p.bot_id };
  }

  /* ------------------------------------------------- ROYAL -> one bot --- */
  async function callWebhook(bot, payload) {
    const [h, v] = authHeaderFor(bot);
    let error = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      error = null; let retry = false;
      try {
        const r = await fetchImpl(bot.url, { method: "POST", headers: { "Content-Type": "application/json", [h]: v }, body: JSON.stringify(payload),
          redirect: "error", signal: AbortSignal.timeout(L.WEBHOOK_TIMEOUT_MS) });
        try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (_) {}
        if (!r.ok) { error = "GROKBOT_HTTP_" + r.status; retry = r.status >= 500; }
      } catch (e) {
        error = e && (e.name === "TimeoutError" || e.name === "AbortError") ? "GROKBOT_TIMEOUT" : "GROKBOT_UNREACHABLE"; retry = true;
      }
      if (!error || !retry || attempt === 1) break;
      await sleep(L.WEBHOOK_RETRY_BACKOFF_MS);
    }
    return error;
  }

  async function sendMessage(botId, body, { realm, requestedBy = "tahir" } = {}) {
    const bot = getBot(botId); if (!bot) return fail(404, "UNKNOWN_BOT", "No such bot.");
    if (!isObj(body)) return fail(400, "BAD_BODY", "Send a JSON object.");
    const r = realmOf(blank(body.realm) ? realm : body.realm);
    if (!checkRealm(r)) return fail(400, "BAD_REALM", "Realm must be BUSINESS or PERSONAL.");
    if (!allows(bot, r)) return fail(403, "REALM_FORBIDDEN", bot.name + " works in " + bot.realms.join(" and ").toLowerCase() + " only.");
    const content = body.content;
    if (typeof content !== "string" || !content.trim()) return fail(400, "CONTENT_REQUIRED", "Say something.");
    if (content.length > L.MAX_MESSAGE_CHARS) return fail(413, "CONTENT_TOO_LONG", "At most " + L.MAX_MESSAGE_CHARS + " characters.");
    const [skill, sOk] = opt(body.skill, SKILL_RE); if (!sOk) return fail(400, "BAD_SKILL", "Skill must be letters, numbers, dots, dashes or underscores.");
    const [conv, cOk] = opt(body.conversation_id, CONV_RE); if (!cOk) return fail(400, "BAD_CONVERSATION_ID", "conversation_id is not valid.");
    if (bot.status === "NOT_CONNECTED") return fail(409, "BOT_NOT_CONNECTED", bot.name + " has no webhook configured.", { bot_id: bot.id });
    if (bot.status === "DISABLED") return fail(409, "BOT_DISABLED", bot.name + " is switched off.", { bot_id: bot.id });
    if (limited("out", bot.id, L.MESSAGES_PER_MINUTE)) return fail(429, "RATE_LIMITED", "Too many messages to " + bot.name + ". Wait a minute.", { bot_id: bot.id });

    const id = randomUUID(), conversation_id = conv || id, requested_by = String(requestedBy).slice(0, 64), sent_at = now();
    await store.createRequest({ id, bot_id: bot.id, realm: r, conversation_id, skill, content, status: "requested", requested_by });
    const payload = { bot_id: bot.id, realm: r, content, request: content, skill, request_id: id, conversation_id,
      reply_endpoint: "/v1/bots/" + bot.id + "/events", requested_by, sent_at };
    const error = await callWebhook(bot, payload);
    if (error) logger.warn && logger.warn('[grokbot] webhook for "' + bot.id + '" failed: ' + error);   /* never the URL or key */
    await store.updateRequest(bot.id, id, error ? { status: "failed", last_error: error } : { status: "delivered" });
    await store.touchBot(bot.id, { last_message_at: sent_at, last_error: error });
    const evt = await record({ bot_id: bot.id, realm: r, request_id: id, type: "outbound", content_markdown: content, status: error ? "failed" : "delivered", author: requested_by });
    return error
      ? fail(502, error, bot.name + " could not be reached. The message was recorded but not delivered.", { bot_id: bot.id, request_id: id, event_id: evt.id, status: "failed" })
      : ok({ bot_id: bot.id, request_id: id, conversation_id, status: "delivered", event_id: evt.id });
  }

  /* ------------------------------------------------- one bot -> ROYAL --- */
  async function postEvent(botId, body, { principal } = {}) {
    const bot = getBot(botId); if (!bot) return fail(404, "UNKNOWN_BOT", "No such bot.");
    if (principal && principal.kind === "bot" && principal.bot_id !== bot.id) return fail(403, "BOT_FORBIDDEN", "A bot may only post to its own feed.");
    if (!bot.enabled) return fail(409, "BOT_DISABLED", bot.name + " is switched off, so ROYAL is not accepting its events.");
    if (!isObj(body)) return fail(400, "BAD_BODY", "Send a JSON object.");
    if (!blank(body.bot_id) && body.bot_id !== bot.id) return fail(400, "BOT_ID_MISMATCH", "bot_id in the body does not match the path.");
    const { type, content_markdown } = body;
    if (BOT_EVENT_TYPES.indexOf(type) < 0) return fail(400, "BAD_TYPE", "type must be one of " + BOT_EVENT_TYPES.join(", ") + ".");
    if (typeof content_markdown !== "string" || !content_markdown.trim()) return fail(400, "CONTENT_REQUIRED", "content_markdown is required.");
    if (content_markdown.length > L.MAX_EVENT_CHARS) return fail(413, "CONTENT_TOO_LONG", "content_markdown is at most " + L.MAX_EVENT_CHARS + " characters.");
    const [status, stOk] = opt(body.status, STATUS_RE); if (!stOk) return fail(400, "BAD_STATUS", "status must be lower-case letters and underscores.");
    const [requestId, rOk] = opt(body.request_id, UUID_RE); if (!rOk) return fail(400, "BAD_REQUEST_ID", "request_id must be the id ROYAL sent.");
    if (!blank(body.realm) && !checkRealm(realmOf(body.realm))) return fail(400, "BAD_REALM", "Realm must be BUSINESS or PERSONAL.");
    if (limited("in", bot.id, L.EVENTS_PER_MINUTE)) return fail(429, "RATE_LIMITED", "Too many events. Wait a minute.");

    let realm = blank(body.realm) ? null : realmOf(body.realm);
    let req = null;
    if (requestId) {
      req = await store.getRequest(bot.id, requestId);
      if (!req) {
        /* Belongs to another bot, or does not exist.  Either way, no write. */
        const other = [...bots.keys()].some((b) => b !== bot.id) ? await anyOwner(requestId, bot.id) : false;
        return other ? fail(403, "REQUEST_FORBIDDEN", "That request belongs to another bot.") : fail(404, "REQUEST_NOT_FOUND", "No such request for this bot.");
      }
      if (realm && realm !== req.realm) return fail(400, "REALM_MISMATCH", "The event's realm must match its request.");
      realm = req.realm;
    }
    if (!realm) realm = allows(bot, "BUSINESS") ? "BUSINESS" : bot.realms[0];
    if (!allows(bot, realm)) return fail(403, "REALM_FORBIDDEN", bot.name + " cannot post " + realm.toLowerCase() + " events.");

    if (req) {
      const next = REQUEST_STATUSES.indexOf(status) >= 0 ? status : EVENT_TO_REQUEST[type];
      if (next && req.status !== next) await store.updateRequest(bot.id, req.id, { status: next, last_error: next === "failed" ? "reported by bot" : null });
    }
    await store.touchBot(bot.id, { last_seen: now() });
    const evt = await record({ bot_id: bot.id, realm, request_id: requestId, type, content_markdown, status, author: bot.id });
    return ok({ bot_id: bot.id, event_id: evt.id, request_id: requestId, realm }, 201);
  }
  /* Is this request id owned by some other bot?  Asked bot by bot, so the
     store is never queried without a bot_id. */
  async function anyOwner(requestId, except) {
    for (const b of bots.keys()) if (b !== except && (await store.getRequest(b, requestId))) return true;
    return false;
  }

  /* ------------------------------------------------------------- reads --- */
  async function getFeed(botId, { since, limit, realm } = {}) {
    const bot = getBot(botId); if (!bot) return fail(404, "UNKNOWN_BOT", "No such bot.");
    const r = realmOf(realm); if (!checkRealm(r)) return fail(400, "BAD_REALM", "Realm must be BUSINESS or PERSONAL.");
    if (!allows(bot, r)) return fail(403, "REALM_FORBIDDEN", bot.name + " is not part of " + r.toLowerCase() + ".");
    if (!blank(since) && !SINCE_RE.test(String(since))) return fail(400, "BAD_SINCE", "since must be an event id.");
    let n = blank(limit) ? L.FEED_DEFAULT : parseInt(limit, 10);
    if (!Number.isFinite(n) || n < 1) return fail(400, "BAD_LIMIT", "limit must be a positive number.");
    n = Math.min(n, L.FEED_MAX);
    const events = (await store.listEvents({ botIds: [bot.id], realm: r, since: blank(since) ? null : String(since), limit: n })).filter((e) => e.bot_id === bot.id && e.realm === r);
    return ok({ bot_id: bot.id, realm: r, events, next_since: events.length ? events[events.length - 1].id : (blank(since) ? null : String(since)) });
  }

  async function getRequest(botId, requestId, { principal } = {}) {
    const bot = getBot(botId); if (!bot) return fail(404, "UNKNOWN_BOT", "No such bot.");
    if (principal && principal.kind === "bot" && principal.bot_id !== bot.id) return fail(403, "BOT_FORBIDDEN", "A bot may only read its own requests.");
    if (typeof requestId !== "string" || !UUID_RE.test(requestId)) return fail(400, "BAD_REQUEST_ID", "Not a request id.");
    const r = await store.getRequest(bot.id, requestId);
    if (!r) return fail(404, "NOT_FOUND", "No such request for this bot.");
    return ok({ request: r });
  }

  /* ----------------------------------------------------------- streams --- */
  /* botId null = combined overview (every event carries bot_id). */
  async function stream(botId, { since, realm, signal } = {}) {
    const r = realmOf(realm);
    if (!checkRealm(r)) return fail(400, "BAD_REALM", "Realm must be BUSINESS or PERSONAL.");
    let allowed;
    if (botId != null) {
      const bot = getBot(botId); if (!bot) return fail(404, "UNKNOWN_BOT", "No such bot.");
      if (!allows(bot, r)) return fail(403, "REALM_FORBIDDEN", bot.name + " is not part of " + r.toLowerCase() + ".");
      allowed = new Set([bot.id]);
    } else allowed = new Set(botsIn(r).map((b) => b.id));
    if (!blank(since) && !SINCE_RE.test(String(since))) return fail(400, "BAD_SINCE", "since must be an event id.");
    const scope = botId != null ? botId : "*:" + r;
    if (total >= L.MAX_STREAMS_TOTAL || (counts.get(scope) || 0) >= L.MAX_STREAMS_PER_SCOPE) return fail(429, "TOO_MANY_STREAMS", "Too many open streams.");
    counts.set(scope, (counts.get(scope) || 0) + 1); total++;

    const enc = new TextEncoder();
    let closed = false, replaying = true, controllerRef = null;
    const floor = blank(since) ? 0 : Number(since);
    const queue = [], seen = new Set();
    let unsubscribe = () => {}, heartbeat = null;
    const cleanup = () => {
      if (closed) return; closed = true;
      clearInterval(heartbeat); unsubscribe();
      counts.set(scope, Math.max(0, (counts.get(scope) || 1) - 1)); total = Math.max(0, total - 1);
      try { controllerRef && controllerRef.close(); } catch (_) {}
    };
    const write = (s) => {
      if (closed || !controllerRef) return;
      try { controllerRef.enqueue(enc.encode(s)); } catch (_) { return cleanup(); }
      if (controllerRef.desiredSize !== null && controllerRef.desiredSize < -L.SSE_MAX_BUFFER_BYTES) cleanup();   /* a client that stopped reading */
    };
    const send = (e) => {
      if (!allowed.has(e.bot_id) || e.realm !== r) return;               /* isolation, checked again at the edge */
      /* never twice, and nothing the client already had before it resumed.
         A set, not a high-water mark: two bots' events can commit out of order. */
      if (Number(e.id) <= floor || seen.has(e.id)) return;
      seen.add(e.id); if (seen.size > 5000) seen.delete(seen.values().next().value);
      write("id: " + e.id + "\nevent: bot_event\ndata: " + JSON.stringify(e) + "\n\n");
    };
    const onEvent = (e) => (replaying ? queue.push(e) : send(e));
    if (signal) { if (signal.aborted) { cleanup(); } else signal.addEventListener("abort", cleanup, { once: true }); }

    const body = new ReadableStream({
      async start(controller) {
        controllerRef = controller;
        unsubscribe = ps.subscribe(botId, onEvent, cleanup);   /* on a lost LISTEN, close; the client resumes */
        heartbeat = setInterval(() => write(": ping " + Date.now() + "\n\n"), L.SSE_HEARTBEAT_MS);
        if (heartbeat.unref) heartbeat.unref();
        write("retry: " + L.SSE_RETRY_MS + "\n\n");
        write("event: hello\ndata: " + JSON.stringify({ scope: botId != null ? botId : "all", bot_id: botId, realm: r, server_time: now() }) + "\n\n");
        if (!blank(since)) {
          /* Replay in pages until caught up.  If the gap is too large to
             replay, say so: the client reloads the feed instead of silently
             skipping what it missed. */
          try {
            let cursor = String(since), pages = 0, page;
            do {
              page = await store.listEvents({ botIds: [...allowed], realm: r, since: cursor, limit: L.REPLAY_MAX });
              page.forEach(send);
              if (page.length) cursor = page[page.length - 1].id;
            } while (page.length === L.REPLAY_MAX && ++pages < L.REPLAY_PAGES && !closed);
            if (page.length === L.REPLAY_MAX && !closed) { write("event: reset\ndata: " + JSON.stringify({ reason: "gap_too_large" }) + "\n\n"); cleanup(); return; }
          } catch (e) { logger.warn && logger.warn("[grokbot] replay failed: " + e.message); write("event: reset\ndata: " + JSON.stringify({ reason: "replay_failed" }) + "\n\n"); cleanup(); return; }
        }
        replaying = false;
        queue.splice(0).forEach(send);
      },
      cancel() { cleanup(); },
    }, new ByteLengthQueuingStrategy({ highWaterMark: 65536 }));

    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" } });
  }

  /* ------------------------------------------------ v1 compatibility --- */
  async function legacyRun(body = {}, opts = {}) {
    if (!isObj(body) || blank(body.skill)) return fail(400, "SKILL_REQUIRED", "skill is required.");
    const content = typeof body.request === "string" && body.request.trim() ? body.request : "Run skill " + String(body.skill);
    return sendMessage(LEGACY_BOT_ID, { content, skill: String(body.skill), realm: body.realm }, opts);
  }
  async function legacyResult(body = {}, opts = {}) {
    const b = isObj(body) ? body : {};
    if (typeof b.result_markdown !== "string") return fail(400, "BAD_RESULT", "result_markdown is required.");
    const st = blank(b.status) ? undefined : String(b.status).toLowerCase().replace(/[^a-z_]/g, "_").slice(0, 32);
    return postEvent(LEGACY_BOT_ID, { request_id: blank(b.request_id) ? undefined : b.request_id, type: "result", content_markdown: b.result_markdown, status: st }, opts);
  }
  async function legacyGetResult(id, opts = {}) {
    const r = await getRequest(LEGACY_BOT_ID, id, opts);
    if (!r.body.ok) return r;
    const q = r.body.request;
    const results = (await store.listEvents({ botIds: [LEGACY_BOT_ID], realm: q.realm, since: null, limit: L.FEED_MAX })).filter((e) => e.request_id === q.id && e.type === "result");
    const last = results[results.length - 1];
    return ok({ request_id: q.id, status: q.status, skill: q.skill, result_markdown: last ? last.content_markdown : null,
      requested_at: q.created_at, received_at: last ? last.created_at : null, source: "grokbot" });
  }

  return {
    listBots, issueToken, revokeToken, authenticate, sendMessage, postEvent, getFeed, getRequest, stream,
    legacyRun, legacyResult, legacyGetResult,
    hasBot: (id) => !!getBot(id), bots: () => [...bots.keys()], stats: () => ({ total, scopes: Object.fromEntries(counts) }),
    storage: () => (store.durable ? "DURABLE" : "TEMPORARY"),
    async close() { await ps.stop(); await store.close(); },
  };
}

/* Builds the bridge from the server environment: Postgres when DATABASE_URL
   is set (with migrations and LISTEN/NOTIFY), memory otherwise. */
export async function bridgeFromEnv(env, { migrationsDir, fetchImpl, logger = console } = {}) {
  if (!env.DATABASE_URL) {
    if (env.GROKBOT_ENABLED === "true") logger.warn("[grokbot] DATABASE_URL is not set: bot requests, events and tokens are in memory and will be lost on restart.");
    return createBridge({ env, fetchImpl, logger });
  }
  const { loadPg, poolConfig, migrate, PgBridgeStore } = await import("./store.js");
  const { PgPubSub } = await import("./pubsub.js");
  const pg = await loadPg();
  const pool = new pg.Pool(poolConfig(env.DATABASE_URL, env));
  pool.on("error", (e) => logger.warn("[grokbot] database pool error: " + e.message));
  if (migrationsDir && env.ROYAL_AUTO_MIGRATE !== "false") {
    const applied = await migrate(pool, migrationsDir);
    if (applied.length) logger.log("[grokbot] applied migrations: " + applied.join(", "));
  }
  const store = new PgBridgeStore(pool);
  const pubsub = new PgPubSub(store, pool, { logger });
  await pubsub.start();
  return createBridge({ env, store, pubsub, fetchImpl, logger });
}
