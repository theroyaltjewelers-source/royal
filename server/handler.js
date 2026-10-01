/* ROYAL's HTTP API as a standard fetch handler: (Request) -> Promise<Response>.
   It runs unchanged on Node 20+, Deno, Cloudflare Workers and Supabase Edge
   Functions; only the entry file differs.

   Every route except /v1/health requires a signed-in owner.  Knowing the URL
   is not access. */

import { createRoyal } from "../core/royal.js";
import { stableHash } from "../core/util.js";
import { passcodeAuth } from "./passcode.js";
import { isBotToken } from "../core/grokbot/tokens.js";
import { identityPrompt } from "../core/identity.js";
import { replyInstructions } from "../core/grokbot/envelope.js";

const VERSION = "0.1.0";
const MAX_BODY = 5 * 1024 * 1024;

/* Every route the API serves, with the methods it accepts.  A known path
   asked with the wrong method is a 405 with an Allow header, never a 404,
   so a stale caller is told exactly what changed. */
const ROUTES = [
  [/^\/v1\/health$/, "GET"], [/^\/v1\/login$/, "POST"], [/^\/v1\/login-methods$/, "GET"],
  [/^\/v1\/(status|agents|boot|skills|domains|activity|developer\/log|developer\/metrics|intelligence\/status|tools|agents\/tasks|knowledge\/search|decisions|bots|feed\/stream|inbox)$/, "GET"],
  [/^\/v1\/(provider\/test|voice\/session|voice\/speak|command|ingest\/calculator|integrations\/grokbot\/run|integrations\/grokbot\/result)$/, "POST"],
  [/^\/v1\/decisions\/[A-Za-z0-9_]+\/resolve$/, "POST"], [/^\/v1\/integrations\/grokbot\/result\/[0-9a-fA-F-]{36}$/, "GET"],
  [/^\/v1\/bots\/[a-z][a-z0-9_]{0,31}\/token$/, "POST, DELETE"], [/^\/v1\/bots\/[a-z][a-z0-9_]{0,31}\/(message|verify|events)$/, "POST"],
  [/^\/v1\/bots\/[a-z][a-z0-9_]{0,31}\/(feed|stream|requests\/[0-9a-fA-F-]{36})$/, "GET"],
];
export function allowedMethods(path) { const r = ROUTES.find(([re]) => re.test(path)); return r ? r[1] : null; }

/* The address a request came from, for rate limits.  The proxy in front
   (Render) appends the address it saw to X-Forwarded-For, so the last entry
   is the one a client cannot forge; the first is whatever the client sent. */
export function clientAddress(req) {
  const xs = String(req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xs.length ? xs[xs.length - 1] : "anon";
}

/* The path as it is logged: ids and tokens folded away, never the query. */
export function routeOf(path) {
  if (!path.startsWith("/v1/")) return path === "/" || /\.(js|css|html|png|ico|svg|txt|json)$/.test(path) ? "static" : "static:other";
  return path.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}/g, ":uuid").replace(/^\/v1\/decisions\/[^/]+/, "/v1/decisions/:id").replace(/^\/v1\/bots\/[^/]+/, (m) => (m === "/v1/bots" ? m : "/v1/bots/:bot"));
}

export function createHandler({ royal, auth, passcode = null, bridge = null, allowedOrigins = [], staticFiles = null, rateLimit = { perMinute: 120 }, log = null }) {
  if (!royal) throw new Error("HANDLER_CONFIG: royal is required");
  if (!auth) throw new Error("HANDLER_CONFIG: auth is required");
  const hits = new Map();

  function cors(req) {
    const o = req.headers.get("origin");
    if (!o || allowedOrigins.indexOf(o) < 0) return {};
    return { "Access-Control-Allow-Origin": o, "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Max-Age": "600" };
  }
  const SEC = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
  /* Spoken replies: a short cache so a phrase ROYAL says often (a greeting,
     "Nothing needs you") is paid for once per process. */
  const SPEECH_MAX = 1200, SPEECH_CACHE = 160;   /* by sentence, so more entries */
  const speechCache = new Map();
  function json(req, status, body) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SEC, ...cors(req) } });
  }
  function fail(req, status, code, message) { return json(req, status, { ok: false, error: code, message }); }
  /* A bridge result ({status, body}) or a streaming Response, with ROYAL's headers. */
  function reply(req, r) {
    if (r instanceof Response) { const h = new Headers(r.headers); for (const [k, v] of Object.entries(cors(req))) h.set(k, v); return new Response(r.body, { status: r.status, headers: h }); }
    return json(req, r.status, r.body);
  }

  async function body(req) {
    const len = Number(req.headers.get("content-length") || 0);
    if (len > MAX_BODY) throw Object.assign(new Error("Body too large"), { status: 413, code: "BODY_TOO_LARGE" });
    const text = await req.text();
    if (text.length > MAX_BODY) throw Object.assign(new Error("Body too large"), { status: 413, code: "BODY_TOO_LARGE" });
    try { return text ? JSON.parse(text) : {}; }
    catch (e) { throw Object.assign(new Error("Body is not JSON"), { status: 400, code: "BAD_JSON" }); }
  }

  function limited(key) {
    const minute = Math.floor(Date.now() / 60000), k = key + ":" + minute;
    const n = (hits.get(k) || 0) + 1; hits.set(k, n);
    if (hits.size > 5000) for (const x of hits.keys()) if (!x.endsWith(":" + minute)) hits.delete(x);
    return n > rateLimit.perMinute;
  }

  /* ------------------------------------------------ Grok Bot bridge --- */
  const BOT_PATH = /^\/v1\/bots\/([a-z][a-z0-9_]{0,31})(?:\/(token|message|verify|events|feed|stream|requests\/([0-9a-fA-F-]{36})))?$/;
  const noBridge = (req) => fail(req, 503, "BRIDGE_UNAVAILABLE", "The Grok Bot bridge is not running on this server.");
  const since = (req, url) => url.searchParams.get("since") || req.headers.get("last-event-id") || undefined;

  async function botRoutes(req, path, principal) {
    const m = BOT_PATH.exec(path);
    const own = m && m[1] === principal.bot_id;
    if (own && req.method === "POST" && m[2] === "events") return reply(req, await bridge.postEvent(m[1], await body(req), { principal }));
    if (own && req.method === "GET" && m[3]) return reply(req, await bridge.getRequest(m[1], m[3], { principal }));
    if (principal.bot_id === "skill_library" && req.method === "POST" && path === "/v1/integrations/grokbot/result")
      return reply(req, await bridge.legacyResult(await body(req), { principal }));
    return fail(req, 403, "BOT_FORBIDDEN", "A bot token may only post its own events and read its own requests.");
  }

  async function ownerBotRoutes(req, url, path, user) {
    if (!bridge) return noBridge(req);
    const realm = url.searchParams.get("realm") || undefined;
    const audit = (action, summary, r) => royal.audit.record({ actor: "tahir", action, summary, executive: true, realm: r || "BUSINESS" }).catch(() => {});
    if (req.method === "GET" && path === "/v1/bots") return reply(req, await bridge.listBots({ realm }));
    if (req.method === "GET" && path === "/v1/feed/stream") return reply(req, await bridge.stream(null, { realm, since: since(req, url), signal: req.signal }));
    if (req.method === "POST" && path === "/v1/integrations/grokbot/run") {
      const r = await bridge.legacyRun(await body(req), { realm, requestedBy: "tahir" });
      if (r.body.request_id) await audit("BOT_MESSAGE_SENT", "Asked Skill Library to run a skill (" + (r.body.ok ? "delivered" : r.body.error) + ").", realm);
      return reply(req, r);
    }
    if (req.method === "POST" && path === "/v1/integrations/grokbot/result") return fail(req, 403, "BOT_ONLY", "Results come from Skill Library itself, signed with its own token.");
    const lr = /^\/v1\/integrations\/grokbot\/result\/([0-9a-fA-F-]{36})$/.exec(path);
    if (req.method === "GET" && lr) return reply(req, await bridge.legacyGetResult(lr[1], {}));
    const m = BOT_PATH.exec(path);
    if (!m) return null;
    const [, id, action, rid] = m;
    if (!bridge.hasBot(id)) return fail(req, 404, "UNKNOWN_BOT", "No such bot.");
    if (action === "token" && req.method === "POST") {
      const r = await bridge.issueToken(id);
      if (r.body.ok) await audit("BOT_TOKEN_ISSUED", "Issued a new token for the " + id + " bot. Any earlier token for it stopped working.");
      return reply(req, r);
    }
    if (action === "token" && req.method === "DELETE") {
      const r = await bridge.revokeToken(id);
      if (r.body.ok) await audit("BOT_TOKEN_REVOKED", "Revoked the token for the " + id + " bot.");
      return reply(req, r);
    }
    if (action === "message" && req.method === "POST") {
      const b = await body(req);
      const r = await bridge.sendMessage(id, b, { realm, requestedBy: "tahir" });
      if (r.body.request_id) await audit("BOT_MESSAGE_SENT", "Sent a message to the " + id + " bot (" + (r.body.ok ? "delivered" : r.body.error) + ").", (b && b.realm) || realm);
      return reply(req, r);
    }
    /* A real connection test, through the orchestrator: a nonce the bot
       must repeat, with its name and role, in a structured result.  The
       bot is CONNECTED_VERIFIED only once that comes back with its own
       token, and the test is an AgentTask in the ledger like any other. */
    if (action === "verify" && req.method === "POST") {
      if (royal.orchestrator && royal.orchestrator.bridge && ["ace", "grace", "ledger", "house", "forge"].indexOf(id) >= 0) {
        const o = await royal.orchestrator.connectionTest(id, { realm: realm || "BUSINESS" });
        await audit("BOT_VERIFY_SENT", "Sent a connection test to the " + id + " bot (" + (o.delivered ? "delivered, waiting for its reply" : o.why || o.status) + ").", realm);
        return json(req, o.delivered ? 200 : 502, o.delivered ? { ok: true, bot_id: id, request_id: o.task.request_id, task_id: o.task.id, status: "delivered" }
          : { ok: false, error: o.status, message: o.why || "The test could not be delivered." });
      }
      const nonce = "n_" + Math.random().toString(36).slice(2, 12), handoff = "hof_" + Math.random().toString(36).slice(2, 12);
      const r = await bridge.sendMessage(id, { skill: "connection_check", content: "Connection test from ROYAL. Return your name, role and the supplied nonce. Take no external action.\nhandoff_id: " + handoff + "\nnonce: " + nonce + "\n\n" +
        replyInstructions({ bot_id: id, task_id: "check", handoff_id: handoff, nonce }) }, { realm, requestedBy: "tahir" });
      if (r.body.request_id) await audit("BOT_VERIFY_SENT", "Sent a connection test to the " + id + " bot (" + (r.body.ok ? "delivered, waiting for its reply" : r.body.error) + ").", realm);
      return reply(req, r);
    }
    if (action === "events" && req.method === "POST") return fail(req, 403, "BOT_ONLY", "Only the bot itself posts to its events, with its own token.");
    if (action === "feed" && req.method === "GET") return reply(req, await bridge.getFeed(id, { since: url.searchParams.get("since") || undefined, limit: url.searchParams.get("limit") || undefined, realm }));
    if (action === "stream" && req.method === "GET") return reply(req, await bridge.stream(id, { realm, since: since(req, url), signal: req.signal }));
    if (rid && req.method === "GET") return reply(req, await bridge.getRequest(id, rid, {}));
    return fail(req, 405, "METHOD_NOT_ALLOWED", "That method is not supported here.");
  }

  /* One line per request: method, folded route, status, duration, error
     code and a request id the response also carries.  Never a body, a
     query string, a token or a key.  Health checks and static files are
     logged only when they fail. */
  const started = Date.now();
  async function handle(req) {
    const t0 = Date.now(), rid = Math.random().toString(36).slice(2, 10);
    const head = req.method === "HEAD";
    let res;
    try { res = await route(head ? new Request(req.url, { method: "GET", headers: req.headers, signal: req.signal }) : req); }
    catch (e) { res = fail(req, 500, "SERVER_ERROR", "I hit an internal error. Nothing was changed."); }
    const h = new Headers(res.headers); h.set("X-Request-Id", rid);
    const out = new Response(head ? null : res.body, { status: res.status, headers: h });
    if (log) {
      const p = new URL(req.url).pathname.replace(/\/+$/, "") || "/", r = routeOf(p);
      if (res.status >= 400 || (p.startsWith("/v1/") && p !== "/v1/health")) {
        let code = null;
        if (res.status >= 400 && /json/.test(res.headers.get("content-type") || "")) { try { code = (await res.clone().json()).error || null; } catch (_) {} }
        try { log({ at: new Date().toISOString(), request_id: rid, method: req.method, route: r, status: res.status, ms: Date.now() - t0, error: code }); } catch (_) {}
      }
    }
    return out;
  }
  handle.routeOf = routeOf;
  return handle;

  async function route(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...SEC, ...cors(req) } });

    if (!path.startsWith("/v1/")) {
      if (req.method !== "GET") return new Response(JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED", message: "Only GET is served here." }),
        { status: 405, headers: { "Content-Type": "application/json; charset=utf-8", Allow: "GET, HEAD", ...SEC } });
      if (staticFiles) { const r = await staticFiles(path); if (r) return r; }
      return fail(req, 404, "NOT_FOUND", "No such route.");
    }
    /* Liveness: the server loop is answering.  It depends on no provider,
       database or bot, so a slow dependency never restarts the service.
       Depth lives behind sign-in (/v1/status, "diagnose yourself"). */
    if (path === "/v1/health") return json(req, 200, { ok: true, service: "royal", version: VERSION, uptime_s: Math.round((Date.now() - started) / 1000) });
    const allow = allowedMethods(path);
    if (allow && allow.split(", ").indexOf(req.method) < 0)
      return new Response(JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED", message: path + " accepts " + allow + "." }),
        { status: 405, headers: { "Content-Type": "application/json; charset=utf-8", Allow: allow + (allow.includes("GET") ? ", HEAD" : ""), ...SEC, ...cors(req) } });

    /* ROYAL's own sign-in: a passcode, no email. */
    if (path === "/v1/login" && req.method === "POST") {
      if (!passcode) return fail(req, 503, "PASSCODE_NOT_CONFIGURED", "ROYAL's passcode sign-in is not set up on the server.");
      let b; try { b = await body(req); } catch (e) { return fail(req, e.status || 400, e.code || "BAD_JSON", e.message); }
      const who = clientAddress(req);
      const r = await passcode.login(String(b.passcode || ""), who);
      if (!r.ok) return fail(req, r.status, r.error, r.message);
      await royal.audit.record({ actor: "tahir", action: "SIGNED_IN", summary: "Signed in to ROYAL with the passcode.", executive: true });
      return json(req, 200, { ok: true, token: r.token, expires_at: r.expires_at });
    }
    if (path === "/v1/login-methods" && req.method === "GET") return json(req, 200, { ok: true, passcode: !!(passcode && passcode.configured) });

    /* ------------------------------------------------------------ auth --- */
    const h = req.headers.get("authorization") || "";
    const token = /^Bearer\s+(.+)$/i.exec(h);
    if (!token) return fail(req, 401, "AUTH_REQUIRED", "Sign in to use ROYAL.");

    /* A Grok Bot's own token.  A bot may post its own events and read its own
       requests, and nothing else: not another bot, not /v1/command, not
       decisions, not domains, not admin. */
    if (isBotToken(token[1])) {
      if (!bridge) return fail(req, 401, "AUTH_INVALID", "That sign-in is not valid or has expired.");
      let principal;
      try { principal = await bridge.authenticate(token[1]); } catch (e) { return fail(req, 503, "AUTH_UNAVAILABLE", "I couldn't check that token. Nothing was done."); }
      if (!principal) {
        /* Slow down guessing: invalid bot tokens are limited per address. */
        const who = clientAddress(req);
        if (limited("badbot:" + who)) return fail(req, 429, "RATE_LIMITED", "Too many requests. Wait a minute.");
        return fail(req, 401, "AUTH_INVALID", "That token is not valid or has been revoked.");
      }
      if (limited(stableHash(token[1]))) return fail(req, 429, "RATE_LIMITED", "Too many requests. Wait a minute.");
      try { return await botRoutes(req, path, principal); }
      catch (e) {
        if (e.status) return fail(req, e.status, e.code, e.message);
        await royal.audit.record({ actor: "bot:" + principal.bot_id, action: "SERVER_ERROR", summary: path, error: e }).catch(() => {});
        return fail(req, 500, "SERVER_ERROR", "I hit an internal error. Nothing was changed.");
      }
    }
    let user;
    try {
      user = passcode ? await passcode.verify(token[1]) : undefined;
      if (user === undefined) user = await auth(token[1]);
    } catch (e) { return fail(req, 503, "AUTH_UNAVAILABLE", "I couldn't check your sign-in. Nothing was done."); }
    if (!user) return fail(req, 401, "AUTH_INVALID", "That sign-in is not valid or has expired.");
    /* House members may keep ROYAL current by sending the calculator's state,
       and do nothing else: they cannot read answers, decisions or activity. */
    const ingestOnly = user.role === "member" && req.method === "POST" && path === "/v1/ingest/calculator";
    if (user.role !== "owner" && !ingestOnly) return fail(req, 403, "NOT_AUTHORISED", "This account is not authorised for ROYAL.");
    if (limited(stableHash(token[1]))) return fail(req, 429, "RATE_LIMITED", "Too many requests. Wait a minute.");

    try {
      if (req.method === "GET" && path === "/v1/status") return json(req, 200, { ok: true, ...(await royal.status()), user: { id: user.id } });
      if (req.method === "GET" && path === "/v1/agents") {
        /* Registry metadata, what the audit log shows each agent did last, and
           its current work from records (native runs in flight, open
           delegated tasks), never from asking the agent. */
        const log = await royal.audit.developerLog({ limit: 2000 });
        const work = royal.currentWork ? await royal.currentWork() : {};
        const agents = royal.agents().map((a) => {
          const last = log.find((e) => e.agent === a.id), w = work[a.id] || {};
          return { id: a.id, name: a.name, role: a.role, capabilities: a.capabilities || [], status: a.status, permission_profile: a.permission_profile,
            available_tools: a.allowed_tools, realms: a.realms, version: a.version, description: a.description,
            last_activity: last ? { at: last.at, action: last.action } : null, current_task: w.current_task || null, active_count: w.active_count || 0, last_task: w.last_task || null,
            health: a.status !== "ACTIVE" ? "NOT_CONNECTED" : (last && /FAILED|DENIED/.test(last.action) ? "DEGRADED" : "OK") };
        });
        return json(req, 200, { ok: true, agents });
      }
      /* Boot: only states that are actually true right now. */
      if (req.method === "GET" && path === "/v1/boot") {
        const st = await royal.status();
        const agents = royal.agents().filter((a) => a.id !== "royal");
        const active = agents.filter((a) => a.status === "ACTIVE").length;
        const lines = [
          { k: "IDENTITY", v: "VERIFIED", ok: true },
          { k: "AUTHORITY", v: user.role === "owner" ? "OWNER" : user.role.toUpperCase(), ok: user.role === "owner" },
          { k: "PROJECT SYSTEM", v: st.calculator.connected ? "CONNECTED" : "NOT CONNECTED", ok: !!st.calculator.connected, detail: st.calculator.connected ? st.calculator.age : null },
          { k: "AGENT NETWORK", v: active + " OF " + agents.length + " ACTIVE", ok: active > 0 },
          { k: "LANGUAGE", v: st.provider.status === "CONNECTED" ? "CONNECTED" : st.provider.status === "DEGRADED" ? "DEGRADED" : "NOT CONNECTED", ok: st.provider.status === "CONNECTED" },
          { k: "EVENT STREAM", v: "ACTIVE", ok: true },
          { k: "MEMORY", v: royal.store.durable ? "DURABLE" : "TEMPORARY", ok: !!royal.store.durable, detail: royal.store.durable ? null : "Lost when the server restarts" },
          { k: "PERMISSIONS", v: "ENFORCED", ok: true },
          { k: "AUDIT", v: "ACTIVE", ok: true },
        ];
        return json(req, 200, { ok: true, lines, realm_domains: royal.domains() });
      }
      if (req.method === "GET" && path === "/v1/skills") return json(req, 200, { ok: true, skills: royal.skills() });
      const realmQ = url.searchParams.get("realm") || undefined;
      if (realmQ && ["BUSINESS", "PERSONAL"].indexOf(realmQ) < 0) return fail(req, 400, "BAD_REALM", "Realm must be BUSINESS or PERSONAL.");
      if (req.method === "GET" && path === "/v1/domains") return json(req, 200, { ok: true, domains: royal.domains(realmQ) });
      if (req.method === "GET" && path === "/v1/activity") return json(req, 200, { ok: true, activity: await royal.audit.executiveLedger({ limit: 100, realm: realmQ }) });
      if (req.method === "POST" && path === "/v1/provider/test") {
        if (!royal.provider || typeof royal.provider.test !== "function")
          return json(req, 200, { ok: false, failed_because: "PROVIDER_NOT_CONNECTED", detail: (royal.provider && royal.provider.status().detail) || "No language provider is configured." });
        const st = royal.provider.status();
        if (st.status === "NOT_CONNECTED") return json(req, 200, { ok: false, failed_because: "PROVIDER_NOT_CONNECTED", detail: st.detail });
        const t = await royal.provider.test();
        await royal.audit.record({ actor: "tahir", action: "PROVIDER_TESTED", summary: "Grok test: " + (t.ok ? "working" : "failed (" + t.failed_because + ")"), executive: true });
        return json(req, 200, t);
      }
      if (req.method === "GET" && path === "/v1/developer/log") return json(req, 200, { ok: true, log: await royal.audit.developerLog({ limit: 500 }) });
      /* ------------------------------------------------ intelligence --- */
      if (req.method === "GET" && path === "/v1/intelligence/status")
        return json(req, 200, { ok: true, ...royal.intelligence.status(), integrations: await royal.gateway.describe(), flags: royal.flags });
      if (req.method === "GET" && path === "/v1/tools") return json(req, 200, { ok: true, tools: royal.tools() });
      if (req.method === "GET" && path === "/v1/agents/tasks") return json(req, 200, { ok: true, tasks: await royal.intelligence.tasks.list({}) });
      if (req.method === "GET" && path === "/v1/developer/metrics") return json(req, 200, { ok: true, metrics: royal.metrics ? royal.metrics.snapshot() : null });
      if (req.method === "GET" && path === "/v1/knowledge/search") {
        const q = String(url.searchParams.get("q") || "").slice(0, 300);
        if (!q.trim()) return fail(req, 400, "QUERY_REQUIRED", "Add ?q=");
        return json(req, 200, { ok: true, results: royal.intelligence.status().knowledge.status === "CONNECTED" ? (await royal.intelligence.toolImpls.knowledge_search({ query: q })).data : [] });
      }
      if (req.method === "POST" && path === "/v1/voice/session") {
        /* A short-lived token for the realtime voice WebSocket.  The API key
           stays here; the browser gets a token that expires in minutes. */
        if (!royal.flags.realtime_voice) return fail(req, 409, "VOICE_DISABLED", "Realtime voice is switched off (realtime_voice).");
        /* The realtime voice model hears the conversation; it is offered for
           Business only, so nothing from the Personal side reaches it. */
        if (realmQ === "PERSONAL") return fail(req, 409, "VOICE_BUSINESS_ONLY", "Realtime voice is available on the Business side only. The browser's own speech works in Personal.");
        if (!royal.provider.voiceSession || !(royal.provider.capabilities && royal.provider.capabilities().realtime_voice))
          return fail(req, 409, "VOICE_NOT_CONFIGURED", "Realtime voice needs XAI_API_KEY on the server.");
        const v = await royal.provider.voiceSession({ seconds: 600 });
        if (!v.ok) return json(req, 502, { ok: false, error: v.failed_because, message: "The voice service did not issue a session" + (v.detail ? ": " + v.detail : ".") });
        await royal.audit.record({ actor: "tahir", action: "VOICE_SESSION", summary: "Started a realtime voice session." });
        return json(req, 200, { ok: true, token: v.token, expires_at: v.expires_at, ws_url: v.ws_url, model: v.model, session: voiceSessionConfig(v.voice) });
      }
      if (req.method === "POST" && path === "/v1/voice/speak") {
        /* ROYAL's one voice: the words of a reply, spoken by the server's
           voice, so every device sounds the same.  Business only, like
           realtime voice: nothing from the Personal side reaches xAI.  The
           browser falls back to the device's own voice on any refusal. */
        if (!royal.flags.spoken_voice) return fail(req, 409, "SPEECH_DISABLED", "My voice is switched off (spoken_voice). Your device's own voice is used.");
        if (realmQ === "PERSONAL") return fail(req, 409, "SPEECH_BUSINESS_ONLY", "My voice speaks on the Business side only. In Personal, your device's own voice is used.");
        if (!royal.provider.speech || !(royal.provider.capabilities && royal.provider.capabilities().speech))
          return fail(req, 409, "SPEECH_NOT_CONFIGURED", "My voice needs XAI_API_KEY on the server.");
        const b = await body(req);
        const text = String((b && b.text) || "").replace(/\s+/g, " ").trim();
        if (!text) return fail(req, 400, "TEXT_REQUIRED", "Nothing to say.");
        if (text.length > SPEECH_MAX) return fail(req, 400, "TEXT_TOO_LONG", "I speak at most " + SPEECH_MAX + " characters at a time.");
        const key = royal.provider.voice + "\u0000" + text;
        let hit = speechCache.get(key);
        if (hit) { speechCache.delete(key); speechCache.set(key, hit); }
        else {
          const s = await royal.provider.speech({ text });
          if (!s.ok) return json(req, 502, { ok: false, error: s.failed_because, message: "The voice service did not answer" + (s.detail ? ": " + s.detail : ".") });
          hit = { audio: s.audio, type: s.type || "audio/wav" };
          speechCache.set(key, hit);
          if (speechCache.size > SPEECH_CACHE) speechCache.delete(speechCache.keys().next().value);
        }
        return new Response(hit.audio, { status: 200, headers: { "Content-Type": hit.type, "Content-Length": String(hit.audio.length), ...SEC, ...cors(req) } });
      }
      /* Answers that came back after their request returned (a Grok Bot
         replying later), for one conversation, and how many hand-offs are
         still open there.  Business only. */
      if (req.method === "GET" && path === "/v1/inbox") {
        if (realmQ === "PERSONAL") return json(req, 200, { ok: true, items: [], open: 0 });
        const cid = String(url.searchParams.get("conversation_id") || user.id).slice(0, 80);
        const since = Number(url.searchParams.get("since") || 0) || 0;
        const key = "BUSINESS:" + cid;
        const [items, open] = await Promise.all([royal.orchestrator.readInbox(key, since), royal.orchestrator.openFor(key)]);
        return json(req, 200, { ok: true, items, open: open.length, now: Date.now() });
      }
      if (req.method === "GET" && path === "/v1/decisions") {
        const status = url.searchParams.get("status") || undefined;
        return json(req, 200, { ok: true, decisions: await royal.decisions.list({ status, realm: realmQ }) });
      }
      if (req.method === "POST" && path === "/v1/command") {
        const b = await body(req);
        const r = await royal.handle({ content: b.content, modality: b.modality || "text", skill: b.skill || null, context: b.context || {}, realm: b.realm || "BUSINESS",
          conversation_id: String(b.conversation_id || user.id).slice(0, 80), user: { id: user.id } });
        return json(req, 200, { ok: true, result: r });
      }
      if (req.method === "POST" && path === "/v1/ingest/calculator") {
        const b = await body(req);
        const r = await royal.ingestCalculator(b.snapshot, { actor: "calculator:" + user.id, transport: b.transport || "embedded" });
        return json(req, r.ok ? 200 : 422, r);
      }
      if (path === "/v1/bots" || path.startsWith("/v1/bots/") || path === "/v1/feed/stream" || path.startsWith("/v1/integrations/grokbot/")) {
        const r = await ownerBotRoutes(req, url, path, user);
        if (r) return r;
      }
      const m = /^\/v1\/decisions\/([A-Za-z0-9_]+)\/resolve$/.exec(path);
      if (req.method === "POST" && m) {
        const b = await body(req);
        const r = await royal.resolveDecision(m[1], { actor: { id: user.id, role: user.role }, resolution: b.resolution, modified_args: b.modified_args, note: b.note });
        return json(req, r.ok === false && !r.decision ? 409 : 200, r);
      }
      return fail(req, 404, "NOT_FOUND", "No such route.");
    } catch (e) {
      if (e.status) return fail(req, e.status, e.code, e.message);
      await royal.audit.record({ actor: "system", action: "SERVER_ERROR", summary: path, error: e }).catch(() => {});
      return fail(req, 500, "SERVER_ERROR", "I hit an internal error. Nothing was changed.");
    }
  }
}

/* Supabase-backed identity: the same accounts that sign in to the calculator.
   The token is checked with Supabase itself, so ROYAL never needs the JWT
   secret.  Owners are an explicit allow-list of user ids. */
export function supabaseAuth({ url, anonKey, ownerIds = [], memberIds = [], fetchImpl = globalThis.fetch, cacheMs = 60000 }) {
  const cache = new Map();
  return async function auth(token) {
    if (!url || !anonKey) throw new Error("IDENTITY_NOT_CONFIGURED");
    const k = stableHash(token), c = cache.get(k);
    if (c && Date.now() - c.at < cacheMs) return c.user;
    const r = await fetchImpl(url.replace(/\/$/, "") + "/auth/v1/user", { headers: { apikey: anonKey, Authorization: "Bearer " + token } });
    let user = null;
    if (r.ok) {
      const j = await r.json();
      if (j && j.id) user = { id: j.id, role: ownerIds.indexOf(j.id) >= 0 ? "owner" : memberIds.indexOf(j.id) >= 0 ? "member" : "none" };
    } else if (r.status >= 500) throw new Error("IDENTITY_UNAVAILABLE");
    cache.set(k, { at: Date.now(), user });
    if (cache.size > 1000) cache.clear();
    return user;
  };
}

/* Build ROYAL from environment variables.  Used by every entry file. */
export async function fromEnv(env, { store, providerFactory, extras = {} } = {}) {
  const flags = env.ROYAL_FLAGS ? JSON.parse(env.ROYAL_FLAGS) : {};
  const provider = providerFactory ? providerFactory(env) : undefined;
  const royal = createRoyal({ store, provider, flags, tzOffsetMin: env.ROYAL_TZ_OFFSET_MIN ? Number(env.ROYAL_TZ_OFFSET_MIN) : -240,
    /* How long a question waits for a Grok Bot's answer before saying it
       will bring the answer to the conversation when it comes. */
    botWaitMs: env.ROYAL_BOT_WAIT_MS ? Math.max(0, Math.min(25000, Number(env.ROYAL_BOT_WAIT_MS) || 0)) : 12000, ...extras });
  const ownerIds = String(env.ROYAL_OWNER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const memberIds = String(env.ROYAL_MEMBER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  let auth = supabaseAuth({ url: env.ROYAL_IDENTITY_URL, anonKey: env.ROYAL_IDENTITY_ANON_KEY, ownerIds, memberIds });
  /* Local development only: a fixed token stands in for sign-in.  Refused
     when ROYAL_ENV is production. */
  if (env.ROYAL_DEV_OWNER_TOKEN) {
    if (env.ROYAL_ENV === "production") throw new Error("ROYAL_DEV_OWNER_TOKEN must not be set in production");
    const dev = env.ROYAL_DEV_OWNER_TOKEN, real = auth;
    auth = async (t) => (t === dev ? { id: "dev-owner", role: "owner" } : (env.ROYAL_IDENTITY_URL ? real(t) : null));
  }
  const allowedOrigins = String(env.ROYAL_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const passcode = passcodeAuth({ passcode: env.ROYAL_OWNER_PASSCODE, secret: env.ROYAL_SESSION_SECRET, days: Number(env.ROYAL_SESSION_DAYS || 30) });
  if (!passcode.configured) console.warn("ROYAL: passcode sign-in is off; set ROYAL_OWNER_PASSCODE (10+ characters) and ROYAL_SESSION_SECRET (32+ characters).");
  return { royal, auth, allowedOrigins, passcode };
}

/* The realtime voice session ROYAL asks for.  The voice model speaks and
   listens; ROYAL does the thinking.  It has one tool, ask_royal, and is told
   to use it for anything about the House, the world, people or actions, so
   voice and text share one intelligence, one permission engine and one
   audit.  It is told never to claim an action happened. */
export function voiceSessionConfig(voice = "ara") {
  return {
    /* Turn detection: xAI's default waits only 200 ms of silence before
       deciding Tahir has finished, which cuts him off mid-thought; 450 ms
       still answers quickly.  To be tuned by ear on his phone. */
    voice, turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 450 },
    audio: { input: { format: { type: "audio/pcm", rate: 24000 } }, output: { format: { type: "audio/pcm", rate: 24000 } } },
    instructions: [
      identityPrompt(),
      "VOICE: You are speaking aloud. Calm, warm, measured, confident, brief. Natural pauses. One or two sentences unless Tahir asks for more; the details are on his screen. No jokes unless Tahir jokes. No accent affectation.",
      "When something needs checking, say a two or three word acknowledgement first (\"I'll check.\", \"One moment.\") and then call ask_royal. Never say it worked before ask_royal says so.",
      "For anything about the House, clients, projects, money, production, policy, research, people, companies, drafts, sending, or any action, call ask_royal with Tahir's exact words, then say what it returns in your own brief words.",
      "Never answer those from your own knowledge. Never say something was sent, done or approved unless ask_royal says so. Approvals happen on screen, never by voice.",
      "If Tahir interrupts, stop and listen. Keep answers short unless he asks for more.",
    ].join(" "),
    tools: [{ type: "function", name: "ask_royal", description: "Ask ROYAL, the intelligence behind this voice. Returns what to say and shows details on screen.",
      parameters: { type: "object", properties: { request: { type: "string", description: "Tahir's request, in his words." } }, required: ["request"] } }],
  };
}
