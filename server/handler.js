/* ROYAL's HTTP API as a standard fetch handler: (Request) -> Promise<Response>.
   It runs unchanged on Node 20+, Deno, Cloudflare Workers and Supabase Edge
   Functions; only the entry file differs.

   Every route except /v1/health requires a signed-in owner.  Knowing the URL
   is not access. */

import { createRoyal } from "../core/royal.js";
import { stableHash } from "../core/util.js";

const VERSION = "0.1.0";
const MAX_BODY = 5 * 1024 * 1024;

export function createHandler({ royal, auth, allowedOrigins = [], staticFiles = null, rateLimit = { perMinute: 120 } }) {
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

    /* ------------------------------------------------------------ auth --- */
    const h = req.headers.get("authorization") || "";
    const token = /^Bearer\s+(.+)$/i.exec(h);
    if (!token) return fail(req, 401, "AUTH_REQUIRED", "Sign in to use ROYAL.");
    let user;
    try { user = await auth(token[1]); } catch (e) { return fail(req, 503, "AUTH_UNAVAILABLE", "ROYAL could not check your sign-in. Nothing was done."); }
    if (!user) return fail(req, 401, "AUTH_INVALID", "That sign-in is not valid or has expired.");
    /* House members may keep ROYAL current by sending the calculator's state,
       and do nothing else: they cannot read answers, decisions or activity. */
    const ingestOnly = user.role === "member" && req.method === "POST" && path === "/v1/ingest/calculator";
    if (user.role !== "owner" && !ingestOnly) return fail(req, 403, "NOT_AUTHORISED", "This account is not authorised for ROYAL.");
    if (limited(stableHash(token[1]))) return fail(req, 429, "RATE_LIMITED", "Too many requests. Wait a minute.");

    try {
      if (req.method === "GET" && path === "/v1/status") return json(req, 200, { ok: true, ...(await royal.status()), user: { id: user.id } });
      if (req.method === "GET" && path === "/v1/agents") return json(req, 200, { ok: true, agents: royal.agents() });
      if (req.method === "GET" && path === "/v1/skills") return json(req, 200, { ok: true, skills: royal.skills() });
      if (req.method === "GET" && path === "/v1/domains") return json(req, 200, { ok: true, domains: royal.domains() });
      if (req.method === "GET" && path === "/v1/activity") return json(req, 200, { ok: true, activity: await royal.audit.executiveLedger({ limit: 100 }) });
      if (req.method === "GET" && path === "/v1/developer/log") return json(req, 200, { ok: true, log: await royal.audit.developerLog({ limit: 500 }) });
      if (req.method === "GET" && path === "/v1/decisions") {
        const status = url.searchParams.get("status") || undefined;
        return json(req, 200, { ok: true, decisions: await royal.decisions.list({ status }) });
      }
      if (req.method === "POST" && path === "/v1/command") {
        const b = await body(req);
        const r = await royal.handle({ content: b.content, modality: b.modality || "text", skill: b.skill || null, context: b.context || {},
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
  return { royal, auth, allowedOrigins };
}
