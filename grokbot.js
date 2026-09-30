// ROYAL <-> Grok Bot bridge v2 (multi-bot). Node 18+, ES modules.
//
// Each Grok Bot teammate (skill_library, royal, me_bot, house, ace, grace,
// grok_bot, ...) has its OWN webhook routine (URL + sender key + header).
//   ROYAL -> bot : sendMessage(botId, ...) POSTs to that bot's webhook only.
//   bot -> ROYAL : postEvent(botId, ...) -- the bot signs in to ROYAL with
//                  ROYAL's normal auth and POSTs to /v1/bots/<id>/events.
// Every message/result/event is stored and served by bot_id. Live updates go
// out over Server-Sent Events from an in-process EventEmitter.
//
// Framework-neutral: methods return { code, json } and openStream() writes to
// a raw Node http.ServerResponse (Express's res is one). See routes-example.js.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { loadBotRegistry, authHeaderFor, publicBotView, BOT_ID_RE, LEGACY_BOT_ID } from "./bots.js";
import { MemoryStore } from "./store.js";

export const LIMITS = Object.freeze({
  MAX_MESSAGE_CHARS: 8_000,     // Tahir -> bot content
  MAX_EVENT_CHARS: 100_000,     // bot -> ROYAL content_markdown
  FEED_DEFAULT: 100,
  FEED_MAX: 500,
  REPLAY_MAX: 200,              // events replayed on SSE (re)connect
  MAX_STREAMS_PER_SCOPE: 10,    // concurrent SSE connections per bot (or combined)
  MAX_STREAMS_TOTAL: 100,
  SSE_HEARTBEAT_MS: 25_000,     // below Render's / proxies' idle timeouts
  SSE_RETRY_MS: 5_000,
  SSE_MAX_BUFFER_BYTES: 1_000_000, // drop clients that stop reading
  MESSAGES_PER_MINUTE: 30,      // per bot, outbound webhook calls
  WEBHOOK_TIMEOUT_MS: 15_000,
});

const EVENT_TYPES = new Set(["progress", "result", "alert", "message"]);
const DEFAULT_STATUS = { progress: "in_progress", result: "completed", alert: "attention", message: null };
const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,128}$/;   // request_id, conversation_id
const SKILL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const STATUS_RE = /^[a-z_]{1,32}$/;
const SINCE_RE = /^(\d{1,20}|\d{4}-\d{2}-\d{2}T[0-9:.]{2,15}(Z|[+-]\d{2}:\d{2})?)$/;

const ok = (json, code = 200) => ({ code, json: { ok: true, ...json } });
const fail = (code, error, extra = {}) => ({ code, json: { ok: false, error, ...extra } });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const blank = (v) => v === undefined || v === null || v === "";
const now = () => new Date().toISOString();

function optional(v, re) { // -> [value|null, valid]
  if (blank(v)) return [null, true];
  return typeof v === "string" && re.test(v) ? [v, true] : [null, false];
}

function writeJson(res, code, json) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(json));
}

export function createBridge({
  env = process.env,
  store = new MemoryStore(),
  fetchImpl = globalThis.fetch,
  limits = {},
  logger = console,
} = {}) {
  const L = { ...LIMITS, ...limits };
  const { bots, warnings } = loadBotRegistry(env);
  for (const w of warnings) logger.warn?.(`[grokbot] ${w}`);

  const bus = new EventEmitter();
  bus.setMaxListeners(L.MAX_STREAMS_TOTAL + 10);
  const streamCounts = new Map(); // scope ("*" or bot id) -> open SSE connections
  let totalStreams = 0;
  const sendLog = new Map();      // bot id -> timestamps of recent outbound calls

  const getBot = (id) => (typeof id === "string" && BOT_ID_RE.test(id) ? bots.get(id) || null : null);

  async function record(event) {
    const stored = await store.appendEvent(event);
    bus.emit(`bot:${stored.bot_id}`, stored); // per-bot channel
    bus.emit("all", stored);                  // combined overview channel
    return stored;
  }

  function subscribe(botId, listener) { // botId null = every bot
    const channel = botId == null ? "all" : `bot:${botId}`;
    bus.on(channel, listener);
    return () => bus.off(channel, listener);
  }

  function rateLimited(botId) {
    const t = Date.now();
    const recent = (sendLog.get(botId) || []).filter((x) => t - x < 60_000);
    if (recent.length >= L.MESSAGES_PER_MINUTE) { sendLog.set(botId, recent); return true; }
    recent.push(t);
    sendLog.set(botId, recent);
    return false;
  }

  // ---- GET /v1/bots ---------------------------------------------------------
  async function listBots() {
    const out = [];
    for (const bot of bots.values()) {
      out.push(publicBotView(bot, await store.getBotState(bot.id), streamCounts.get(bot.id) || 0));
    }
    return ok({ bots: out });
  }

  // ---- POST /v1/bots/:botId/message  (ROYAL/Tahir -> one bot) --------------
  async function sendMessage(botId, body, { requestedBy = "owner" } = {}) {
    const bot = getBot(botId);
    if (!bot) return fail(404, "UNKNOWN_BOT");
    if (!isObj(body)) return fail(400, "BAD_BODY");
    const { content } = body;
    if (typeof content !== "string" || !content.trim()) return fail(400, "CONTENT_REQUIRED");
    if (content.length > L.MAX_MESSAGE_CHARS) return fail(413, "CONTENT_TOO_LONG", { max: L.MAX_MESSAGE_CHARS });
    const [skill, skillOk] = optional(body.skill, SKILL_RE);
    if (!skillOk) return fail(400, "BAD_SKILL");
    const [convIn, convOk] = optional(body.conversation_id, TOKEN_RE);
    if (!convOk) return fail(400, "BAD_CONVERSATION_ID");
    if (bot.status === "NOT_CONNECTED") return fail(409, "BOT_NOT_CONNECTED", { bot_id: bot.id });
    if (bot.status === "DISABLED") return fail(409, "BOT_DISABLED", { bot_id: bot.id });
    if (rateLimited(bot.id)) return fail(429, "RATE_LIMITED", { bot_id: bot.id });

    const request_id = crypto.randomUUID();
    const conversation_id = convIn || request_id;
    const requested_by = String(requestedBy).slice(0, 64);
    const payload = {
      bot_id: bot.id,
      content,
      skill,
      request_id,
      conversation_id,
      reply_endpoint: `/v1/bots/${bot.id}/events`,
      requested_by,
      sent_at: now(),
      request: content, // v1 alias: the original skill-library routine read "request"
    };
    await store.putRequest({ request_id, bot_id: bot.id, skill, conversation_id, status: "sending", requested_at: payload.sent_at });

    let error = null;
    try {
      const [h, v] = authHeaderFor(bot);
      const r = await fetchImpl(bot.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", [h]: v },
        body: JSON.stringify(payload),
        redirect: "error", // never follow a redirect with the key attached
        signal: AbortSignal.timeout(L.WEBHOOK_TIMEOUT_MS),
      });
      try { await r.body?.cancel(); } catch {} // we don't need the webhook's body
      if (!r.ok) error = "GROKBOT_HTTP_" + r.status;
    } catch (e) {
      error = e?.name === "TimeoutError" ? "GROKBOT_TIMEOUT" : "GROKBOT_UNREACHABLE";
    }
    // Never log bot.url / bot.key.
    if (error) logger.warn?.(`[grokbot] webhook for "${bot.id}" failed: ${error}`);

    const req = await store.getRequest(request_id);
    if (req && req.status === "sending") await store.updateRequest(request_id, { status: error ? "failed" : "requested", error });
    await store.touchBot(bot.id, { last_message_at: now(), last_error: error });
    const evt = await record({
      bot_id: bot.id, direction: "to_bot", type: "message", content_markdown: content,
      status: error ? "failed" : "delivered", request_id, conversation_id, skill, author: requested_by,
    });
    return error
      ? fail(502, error, { bot_id: bot.id, request_id, event_id: evt.id })
      : ok({ bot_id: bot.id, request_id, conversation_id, status: "requested", event_id: evt.id });
  }

  // ---- POST /v1/bots/:botId/events  (one bot -> ROYAL) ---------------------
  // actorBotId: if ROYAL's auth knows which bot a token belongs to, pass it and
  // a bot can then only post to its own feed.
  async function postEvent(botId, body, { actorBotId = null } = {}) {
    const bot = getBot(botId);
    if (!bot) return fail(404, "UNKNOWN_BOT");
    if (!bot.enabled) return fail(403, "BOT_DISABLED");
    if (actorBotId != null && actorBotId !== bot.id) return fail(403, "BOT_MISMATCH");
    if (!isObj(body)) return fail(400, "BAD_BODY");
    if (!blank(body.bot_id) && body.bot_id !== bot.id) return fail(400, "BOT_ID_MISMATCH");
    const { type, content_markdown } = body;
    if (!EVENT_TYPES.has(type)) return fail(400, "BAD_TYPE", { allowed: [...EVENT_TYPES] });
    if (typeof content_markdown !== "string" || !content_markdown.trim()) return fail(400, "CONTENT_REQUIRED");
    if (content_markdown.length > L.MAX_EVENT_CHARS) return fail(413, "CONTENT_TOO_LONG", { max: L.MAX_EVENT_CHARS });
    const [statusIn, statusOk] = optional(body.status, STATUS_RE);
    if (!statusOk) return fail(400, "BAD_STATUS");
    const [request_id, ridOk] = optional(body.request_id, TOKEN_RE);
    if (!ridOk) return fail(400, "BAD_REQUEST_ID");
    const [convIn, convOk] = optional(body.conversation_id, TOKEN_RE);
    if (!convOk) return fail(400, "BAD_CONVERSATION_ID");
    const [skillIn, skillOk] = optional(body.skill, SKILL_RE);
    if (!skillOk) return fail(400, "BAD_SKILL");
    const status = statusIn || DEFAULT_STATUS[type];

    let conversation_id = convIn, skill = skillIn;
    if (request_id) {
      const req = await store.getRequest(request_id);
      if (req && req.bot_id !== bot.id) return fail(409, "REQUEST_BOT_MISMATCH"); // no cross-bot writes
      if (req) {
        conversation_id ||= req.conversation_id || null;
        skill ||= req.skill || null;
        await store.updateRequest(request_id, {
          status: status || req.status, updated_at: now(),
          ...(type === "result" ? { result_markdown: content_markdown, received_at: now() } : {}),
        });
      } else {
        // Unsolicited / unknown id: claim it for this bot so no other bot can write to it.
        await store.putRequest({
          request_id, bot_id: bot.id, skill, conversation_id, status: status || "received",
          requested_at: null, updated_at: now(),
          ...(type === "result" ? { result_markdown: content_markdown, received_at: now() } : {}),
        });
      }
    }
    await store.touchBot(bot.id, { last_seen: now() });
    const evt = await record({
      bot_id: bot.id, direction: "from_bot", type, content_markdown, status,
      request_id, conversation_id, skill, author: bot.id,
    });
    return ok({ bot_id: bot.id, event_id: evt.id, request_id });
  }

  // ---- GET /v1/bots/:botId/feed?since=&limit= ------------------------------
  async function getFeed(botId, query = {}) {
    const bot = getBot(botId);
    if (!bot) return fail(404, "UNKNOWN_BOT");
    const since = blank(query.since) ? null : String(query.since);
    if (since && !SINCE_RE.test(since)) return fail(400, "BAD_SINCE");
    let limit = blank(query.limit) ? L.FEED_DEFAULT : parseInt(query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) return fail(400, "BAD_LIMIT");
    limit = Math.min(limit, L.FEED_MAX);
    const events = (await store.listEvents({ botId: bot.id, since, limit })).filter((e) => e.bot_id === bot.id);
    return ok({ bot_id: bot.id, events, next_since: events.length ? events[events.length - 1].id : since });
  }

  // ---- GET /v1/bots/:botId/requests/:requestId -----------------------------
  async function getRequest(botId, requestId) {
    const bot = getBot(botId);
    if (!bot) return fail(404, "UNKNOWN_BOT");
    if (typeof requestId !== "string" || !TOKEN_RE.test(requestId)) return fail(400, "BAD_REQUEST_ID");
    const req = await store.getRequest(requestId);
    if (!req || req.bot_id !== bot.id) return fail(404, "NOT_FOUND"); // don't reveal other bots' ids
    return ok({ request: req });
  }

  // ---- SSE: GET /v1/bots/:botId/stream  and  GET /v1/feed/stream -----------
  // botId null = combined overview stream (every event carries bot_id).
  // Resume: ?since=<event id> or the Last-Event-ID header.
  async function openStream(req, res, { botId = null } = {}) {
    if (botId != null && !getBot(botId)) return writeJson(res, 404, { ok: false, error: "UNKNOWN_BOT" });
    const query = new URL(req.url || "/", "http://x").searchParams;
    const since = query.get("since") || req.headers?.["last-event-id"] || null;
    if (since && !SINCE_RE.test(String(since))) return writeJson(res, 400, { ok: false, error: "BAD_SINCE" });
    const scope = botId ?? "*";
    if (totalStreams >= L.MAX_STREAMS_TOTAL || (streamCounts.get(scope) || 0) >= L.MAX_STREAMS_PER_SCOPE) {
      return writeJson(res, 429, { ok: false, error: "TOO_MANY_STREAMS" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable proxy buffering
    });
    res.flushHeaders?.();
    req.socket?.setNoDelay?.(true);
    req.socket?.setKeepAlive?.(true);
    req.socket?.setTimeout?.(0);

    streamCounts.set(scope, (streamCounts.get(scope) || 0) + 1);
    totalStreams++;

    let closed = false, replaying = true;
    const queue = [], replayed = new Set();
    const write = (chunk) => {
      if (closed) return;
      const flushed = res.write(chunk);
      if (!flushed && res.writableLength > L.SSE_MAX_BUFFER_BYTES) cleanup(); // slow/stuck client
    };
    const sendEvent = (evt) => {
      if (botId != null && evt.bot_id !== botId) return; // belt and braces: per-bot isolation
      write(`id: ${evt.id}\nevent: bot_event\ndata: ${JSON.stringify(evt)}\n\n`);
    };
    const onEvent = (evt) => (replaying ? queue.push(evt) : sendEvent(evt));
    const unsubscribe = subscribe(botId, onEvent);
    const heartbeat = setInterval(() => write(`: ping ${Date.now()}\n\n`), L.SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      streamCounts.set(scope, Math.max(0, (streamCounts.get(scope) || 1) - 1));
      totalStreams = Math.max(0, totalStreams - 1);
      queue.length = 0;
      try { res.end(); } catch {}
    }
    res.on("close", cleanup); // client went away (Render, browser tab closed, abort)
    res.on("error", cleanup);

    write(`retry: ${L.SSE_RETRY_MS}\n\n`);
    write(`event: hello\ndata: ${JSON.stringify({ scope, bot_id: botId, server_time: now() })}\n\n`);
    try {
      if (since) {
        for (const e of await store.listEvents({ botId, since: String(since), limit: L.REPLAY_MAX })) {
          replayed.add(e.id);
          sendEvent(e);
        }
      }
    } catch (e) {
      logger.warn?.(`[grokbot] SSE replay failed: ${e?.message}`);
    }
    replaying = false;
    for (const e of queue.splice(0)) if (!replayed.has(e.id)) sendEvent(e);
    return { close: cleanup };
  }

  function stats() {
    return { total_streams: totalStreams, streams: Object.fromEntries(streamCounts), listeners: bus.listenerCount("all") };
  }

  // ---- v1 compatibility (all map to bot "skill_library") -------------------
  async function legacyRun({ skill, request = "", requestedBy = "owner" } = {}) {
    if (blank(skill)) return fail(400, "SKILL_REQUIRED");
    const content = typeof request === "string" && request.trim() ? request : `Run skill ${skill}`;
    return sendMessage(LEGACY_BOT_ID, { content, skill: String(skill) }, { requestedBy });
  }

  async function legacyResult(body, opts = {}) {
    const { request_id, skill, status, result_markdown } = isObj(body) ? body : {};
    if (typeof result_markdown !== "string" || result_markdown.length > L.MAX_EVENT_CHARS) return fail(400, "BAD_RESULT");
    const norm = blank(status) ? undefined : String(status).toLowerCase().replace(/[^a-z_]/g, "_").slice(0, 32);
    return postEvent(LEGACY_BOT_ID, {
      request_id: blank(request_id) ? crypto.randomUUID() : request_id,
      type: "result", content_markdown: result_markdown, status: norm,
      skill: blank(skill) ? undefined : String(skill),
    }, opts);
  }

  async function legacyGetResult(id) {
    const out = await getRequest(LEGACY_BOT_ID, id);
    if (!out.json.ok) return out;
    const r = out.json.request;
    return ok({ request_id: r.request_id, status: r.status, skill: r.skill, result_markdown: r.result_markdown ?? null,
      requested_at: r.requested_at, received_at: r.received_at ?? null, source: "grokbot" });
  }

  return {
    listBots, sendMessage, postEvent, getFeed, getRequest, openStream, subscribe, stats,
    legacyRun, legacyResult, legacyGetResult, hasBot: (id) => Boolean(getBot(id)),
  };
}

// Lazily-created default instance (reads process.env on first use).
let defaultBridge = null;
export function getBridge() { return (defaultBridge ??= createBridge()); }

// v1 function names, kept so existing ROYAL code that imported them still works.
export async function wakeGrokBot({ skill, request = "", requestedBy = "royal" } = {}) {
  return (await getBridge().legacyRun({ skill, request, requestedBy })).json;
}
export async function handleGrokBotResult(body) { return getBridge().legacyResult(body); }
export async function getGrokBotResult(id) {
  const out = await getBridge().legacyGetResult(id);
  return out.json.ok ? out.json : null;
}
