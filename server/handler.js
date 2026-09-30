/* ROYAL's HTTP API as a standard fetch handler: (Request) -> Promise<Response>.
   It runs unchanged on Node 20+, Deno, Cloudflare Workers and Supabase Edge
   Functions; only the entry file differs.

   Every route except /v1/health requires a signed-in owner.  Knowing the URL
   is not access. */

import { createRoyal } from "../core/royal.js";
import { stableHash } from "../core/util.js";
import { passcodeAuth } from "./passcode.js";

const VERSION = "0.1.0";
const MAX_BODY = 5 * 1024 * 1024;

export function createHandler({ royal, auth, passcode = null, allowedOrigins = [], staticFiles = null, rateLimit = { perMinute: 120 } }) {
  if (!royal) throw new Error("HANDLER_CONFIG: royal is required");
  if (!auth) throw new Error("HANDLER_CONFIG: auth is required");
  const hits = new Map();

  function cors(req) {
    const o = req.headers.get("origin");
    if (!o || allowedOrigins.indexOf(o) < 0) return {};
    return { "Access-Control-Allow-Origin": o, "Vary": "Origin", "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "600" };
  }
  const SEC = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
  function json(req, status, body) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SEC, ...cors(req) } });
  }
  function fail(req, status, code, message) { return json(req, status, { ok: false, error: code, message }); }

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

  return async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...SEC, ...cors(req) } });

    if (!path.startsWith("/v1/")) {
      if (staticFiles && req.method === "GET") { const r = await staticFiles(path); if (r) return r; }
      return fail(req, 404, "NOT_FOUND", "No such route.");
    }
    if (path === "/v1/health") return json(req, 200, { ok: true, service: "royal", version: VERSION });

    /* ROYAL's own sign-in: a passcode, no email. */
    if (path === "/v1/login" && req.method === "POST") {
      if (!passcode) return fail(req, 503, "PASSCODE_NOT_CONFIGURED", "ROYAL's passcode sign-in is not set up on the server.");
      let b; try { b = await body(req); } catch (e) { return fail(req, e.status || 400, e.code || "BAD_JSON", e.message); }
      const who = (req.headers.get("x-forwarded-for") || "anon").split(",")[0].trim();
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
    let user;
    try {
      user = passcode ? await passcode.verify(token[1]) : undefined;
      if (user === undefined) user = await auth(token[1]);
    } catch (e) { return fail(req, 503, "AUTH_UNAVAILABLE", "ROYAL could not check your sign-in. Nothing was done."); }
    if (!user) return fail(req, 401, "AUTH_INVALID", "That sign-in is not valid or has expired.");
    /* House members may keep ROYAL current by sending the calculator's state,
       and do nothing else: they cannot read answers, decisions or activity. */
    const ingestOnly = user.role === "member" && req.method === "POST" && path === "/v1/ingest/calculator";
    if (user.role !== "owner" && !ingestOnly) return fail(req, 403, "NOT_AUTHORISED", "This account is not authorised for ROYAL.");
    if (limited(stableHash(token[1]))) return fail(req, 429, "RATE_LIMITED", "Too many requests. Wait a minute.");

    try {
      if (req.method === "GET" && path === "/v1/status") return json(req, 200, { ok: true, ...(await royal.status()), user: { id: user.id } });
      if (req.method === "GET" && path === "/v1/agents") {
        /* Registry metadata plus what the audit log actually shows each agent did last. */
        const log = await royal.audit.developerLog({ limit: 2000 });
        const agents = royal.agents().map((a) => {
          const last = log.find((e) => e.agent === a.id);
          return { id: a.id, name: a.name, role: a.role, capabilities: a.capabilities || [], status: a.status, permission_profile: a.permission_profile,
            available_tools: a.allowed_tools, realms: a.realms, version: a.version, description: a.description,
            last_activity: last ? { at: last.at, action: last.action } : null, current_task: null,
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
      return fail(req, 500, "SERVER_ERROR", "ROYAL hit an internal error. Nothing was changed.");
    }
  };
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
export async function fromEnv(env, { store, providerFactory } = {}) {
  const flags = env.ROYAL_FLAGS ? JSON.parse(env.ROYAL_FLAGS) : {};
  const provider = providerFactory ? providerFactory(env) : undefined;
  const royal = createRoyal({ store, provider, flags, tzOffsetMin: env.ROYAL_TZ_OFFSET_MIN ? Number(env.ROYAL_TZ_OFFSET_MIN) : -240 });
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
