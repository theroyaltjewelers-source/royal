// Example wiring for an Express-style ROYAL server (v2, multi-bot).
//
// ADAPTER NOTE: ROYAL's framework is unknown. Everything framework-specific is
// in this file; grokbot.js only needs (a) a parsed JSON body, (b) route params,
// (c) a way to send { code, json }, and (d) the raw Node response for SSE.
//   - Express 4/5: use as-is. Needs app.use(express.json({ limit: "512kb" }))
//     before mounting, and compression() (if used) must skip text/event-stream.
//   - Plain node:http: parse the body yourself, match the paths below, and call
//     the same bridge methods; send out.code / out.json.
//   - Fastify: call reply.hijack() then bridge.openStream(request.raw, reply.raw, ...).
//   - Koa: ctx.respond = false, then bridge.openStream(ctx.req, ctx.res, ...).
//   - CommonJS server: rename files to .mjs and `await import()` them, or
//     convert import/export to require/module.exports.

import { getBridge } from "./grokbot.js";

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => res.status(out.code).json(out.json);

// Who is calling? Adapt to ROYAL's auth. If ROYAL issues bot accounts/tokens,
// return that bot's id as botId so a bot can only post to its own feed and
// cannot trigger other bots. For Tahir (owner) botId is null.
function defaultGetActor(req) {
  return { botId: req.user?.bot_id ?? null, userId: req.user?.id || "owner" };
}

// requireAuth = ROYAL's existing sign-in check (the same one /v1/status uses).
// It must accept "Authorization: Bearer <token>" on every route below,
// including the SSE streams.
export function mountGrokBot(app, requireAuth, { bridge = getBridge(), getActor = defaultGetActor } = {}) {
  // List bots + connection status (never includes webhook URLs or keys).
  app.get("/v1/bots", requireAuth, wrap(async (req, res) => send(res, await bridge.listBots())));

  // Tahir/ROYAL -> one bot:  { content, skill?, conversation_id? }
  app.post("/v1/bots/:botId/message", requireAuth, wrap(async (req, res) => {
    const actor = getActor(req);
    if (actor.botId) return res.status(403).json({ ok: false, error: "BOTS_CANNOT_MESSAGE_BOTS" }); // no bot loops
    send(res, await bridge.sendMessage(req.params.botId, req.body, { requestedBy: actor.userId }));
  }));

  // One bot -> ROYAL:  { request_id?, type, content_markdown, status? }
  app.post("/v1/bots/:botId/events", requireAuth, wrap(async (req, res) => {
    send(res, await bridge.postEvent(req.params.botId, req.body, { actorBotId: getActor(req).botId }));
  }));

  // That bot's history only.  ?since=<event id | ISO time>&limit=<1..500>
  app.get("/v1/bots/:botId/feed", requireAuth, wrap(async (req, res) => {
    send(res, await bridge.getFeed(req.params.botId, req.query || {}));
  }));

  // Status/result of one request, scoped to that bot.
  app.get("/v1/bots/:botId/requests/:requestId", requireAuth, wrap(async (req, res) => {
    send(res, await bridge.getRequest(req.params.botId, req.params.requestId));
  }));

  // Live SSE feed for that bot only.  ?since=<event id> to resume.
  app.get("/v1/bots/:botId/stream", requireAuth, wrap(async (req, res) => {
    await bridge.openStream(req, res, { botId: req.params.botId });
  }));

  // Optional combined overview stream; every event is labeled with bot_id.
  app.get("/v1/feed/stream", requireAuth, wrap(async (req, res) => {
    await bridge.openStream(req, res, { botId: null });
  }));

  // ---- v1 routes, kept for backward compatibility -> bot "skill_library" ----
  // POST /v1/integrations/grokbot/run  { "skill": "001", "request": "" }
  app.post("/v1/integrations/grokbot/run", requireAuth, wrap(async (req, res) => {
    const actor = getActor(req);
    if (actor.botId) return res.status(403).json({ ok: false, error: "BOTS_CANNOT_MESSAGE_BOTS" });
    const { skill, request } = req.body || {};
    send(res, await bridge.legacyRun({ skill, request, requestedBy: actor.userId }));
  }));

  // POST /v1/integrations/grokbot/result  { request_id, skill, status, result_markdown }
  app.post("/v1/integrations/grokbot/result", requireAuth, wrap(async (req, res) => {
    send(res, await bridge.legacyResult(req.body, { actorBotId: getActor(req).botId }));
  }));

  // GET /v1/integrations/grokbot/result/:id
  app.get("/v1/integrations/grokbot/result/:id", requireAuth, wrap(async (req, res) => {
    send(res, await bridge.legacyGetResult(req.params.id));
  }));

  return bridge;
}

// ROYAL's own command handler can also call the bridge directly, e.g. when
// Tahir types "morning briefing":
//   await getBridge().sendMessage("skill_library", { content: "morning briefing", skill: "001" });
