/* The Grok Bot registry.  Server-side only.

   Each external Grok Bot assistant has its own inbound webhook (URL, sender
   key, header name), a display name, a switch, and the realms it may work in.
   All of it comes from the server environment, never from a file the browser
   can load.

     GROKBOT_ENABLED=true                master switch (off by default)
     GROKBOT_BOTS=skill_library,royal,ace,house,grace,me_bot,grok_bot
     GROKBOT_<ID>_WEBHOOK_URL            https only
     GROKBOT_<ID>_WEBHOOK_KEY
     GROKBOT_<ID>_KEY_HEADER             default Authorization, sent as "Bearer <key>"
     GROKBOT_<ID>_NAME                   optional
     GROKBOT_<ID>_ENABLED=false          optional, switches one bot off
     GROKBOT_<ID>_REALMS                 comma list, default BUSINESS
                                         (skill_library defaults to BUSINESS,PERSONAL)

   Legacy GROKBOT_WEBHOOK_URL / _WEBHOOK_KEY / GROKBOT_KEY_HEADER fall back to
   skill_library, so a v1 setup keeps working.

   These bots are not ROYAL's internal specialists, even where the ids match
   (royal, ace, house, grace).  They are separate assistants outside ROYAL
   and share no state or authority with /v1/agents. */

export const BOT_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const LEGACY_BOT_ID = "skill_library";
export const REALMS = ["BUSINESS", "PERSONAL"];
export const DEFAULT_BOTS = ["skill_library", "royal", "ace", "house", "grace", "me_bot", "grok_bot"];
const DEFAULT_REALMS = { skill_library: ["BUSINESS", "PERSONAL"] };
const DEFAULT_NAMES = { skill_library: "Skill Library", royal: "Royal", ace: "Ace", house: "House", grace: "Grace", me_bot: "Me Bot", grok_bot: "Grok Bot" };
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "cookie", "x-forwarded-for"]);

const titleCase = (id) => id.split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
export const envPrefix = (id) => "GROKBOT_" + id.toUpperCase() + "_";

function checkUrl(raw, allowInsecure) {
  if (!raw) return null;
  let u; try { u = new URL(raw); } catch (_) { return "BAD_WEBHOOK_URL"; }
  if (u.username || u.password) return "WEBHOOK_URL_HAS_CREDENTIALS";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && allowInsecure) return null;   /* tests only */
  return "WEBHOOK_URL_MUST_BE_HTTPS";
}

function parseRealms(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return { realms: fallback, error: null };
  const list = String(raw).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const bad = list.filter((r) => REALMS.indexOf(r) < 0);
  if (bad.length || !list.length) return { realms: ["BUSINESS"], error: "BAD_REALMS" };
  return { realms: [...new Set(list)], error: null };
}

export function loadBotRegistry(env = {}) {
  const globalEnabled = env.GROKBOT_ENABLED === "true";
  const allowInsecure = env.GROKBOT_ALLOW_INSECURE_WEBHOOKS === "true";
  const warnings = [];
  const ids = String(env.GROKBOT_BOTS || DEFAULT_BOTS.join(",")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (ids.indexOf(LEGACY_BOT_ID) < 0) ids.unshift(LEGACY_BOT_ID);   /* the v1 routes map here */

  const bots = new Map();
  for (const id of ids) {
    if (!BOT_ID_RE.test(id)) { warnings.push('ignored invalid bot id "' + id.slice(0, 40) + '"'); continue; }
    if (bots.has(id)) continue;
    const p = envPrefix(id), legacy = id === LEGACY_BOT_ID;
    const url = String(env[p + "WEBHOOK_URL"] || (legacy && env.GROKBOT_WEBHOOK_URL) || "").trim();
    const key = String(env[p + "WEBHOOK_KEY"] || (legacy && env.GROKBOT_WEBHOOK_KEY) || "").trim();
    const header = String(env[p + "KEY_HEADER"] || (legacy && env.GROKBOT_KEY_HEADER) || "Authorization").trim();
    let configError = checkUrl(url, allowInsecure);
    if (!configError && (!HEADER_RE.test(header) || FORBIDDEN_HEADERS.has(header.toLowerCase()))) configError = "BAD_KEY_HEADER";
    const rp = parseRealms(env[p + "REALMS"], DEFAULT_REALMS[id] || ["BUSINESS"]);
    if (rp.error && !configError) configError = rp.error;
    if (configError) warnings.push('bot "' + id + '": ' + configError);
    const enabled = globalEnabled && env[p + "ENABLED"] !== "false";
    const configured = !!(url && key && !configError);
    /* Configuration only: what may be attempted.  Never shown as a connection. */
    const config = !configured ? "NOT_CONFIGURED" : !enabled ? "DISABLED" : "CONFIGURED";
    const name = String(env[p + "NAME"] || DEFAULT_NAMES[id] || titleCase(id)).trim().slice(0, 64);
    bots.set(id, Object.freeze({ id, name, url, key, header, enabled, configured, config, configError, realms: Object.freeze(rp.realms) }));
  }
  return { bots, warnings, globalEnabled };
}

/* [header name, header value] for the outbound webhook call. */
export function authHeaderFor(bot) {
  return [bot.header, bot.header.toLowerCase() === "authorization" ? "Bearer " + bot.key : bot.key];
}

/* Whether a bot is really reachable, from what has actually happened, never
   from configuration alone.  There is no official Grok Bot API: a bot is
   reached only through the webhook Tahir configured, and it answers by
   posting to ROYAL with its own token.

   A round trip is verified only when the bot posts back, with its own
   token, an event carrying the request_id of a message ROYAL delivered to
   it, within UNRESPONSIVE_MS.  A post with no request_id proves the bot can
   reach ROYAL, not that it received anything, so it does not verify.

     NOT_CONFIGURED         no webhook address and key, or a bad one
     DISABLED               switched off
     CONFIGURED_UNVERIFIED  configured, no verified round trip yet
     VERIFYING              a connection check was delivered, answer pending
     CONNECTED_VERIFIED     the latest exchange was a verified round trip
     DEGRADED               verified before, but the last delivery failed
     AUTH_FAILED            the bot's webhook refused ROYAL's key (401 or 403)
     UNRESPONSIVE           delivered, but no correlated answer in time
     FAILED                 the last delivery failed and it was never verified

   This is the one connection state.  `config` says only what may be
   attempted; nothing reads it as "connected". */
export const UNRESPONSIVE_MS = 15 * 60000;
export const VERIFY_WINDOW_MS = 2 * 60000;
export const CONNECTION_STATES = ["NOT_CONFIGURED", "DISABLED", "CONFIGURED_UNVERIFIED", "VERIFYING", "CONNECTED_VERIFIED", "DEGRADED", "AUTH_FAILED", "UNRESPONSIVE", "FAILED"];
const t = (v) => (v ? Date.parse(v) || 0 : 0);
export function connectionOf(bot, state = {}, now = Date.now()) {
  if (!bot.configured) return "NOT_CONFIGURED";
  if (!bot.enabled) return "DISABLED";
  const verified = t(state.last_verified_at), sent = t(state.last_message_at), pending = t(state.pending_verify_at);
  if (state.last_error && sent >= verified) {
    if (/_HTTP_40[13]$/.test(state.last_error)) return "AUTH_FAILED";
    return verified ? "DEGRADED" : "FAILED";
  }
  if (pending && pending > verified) return now - pending < VERIFY_WINDOW_MS ? "VERIFYING" : "UNRESPONSIVE";
  if (sent > verified && now - sent > UNRESPONSIVE_MS) return "UNRESPONSIVE";
  if (verified) return "CONNECTED_VERIFIED";
  return "CONFIGURED_UNVERIFIED";
}

/* Share of the last deliveries that went through ("1" ok, "0" failed). */
export function successRate(outcomes) {
  const s = String(outcomes || "");
  return s.length ? Math.round((100 * s.split("").filter((c) => c === "1").length) / s.length) / 100 : null;
}

/* The only shape that may leave the server.  Never add url, key or header.
   can_send: ROYAL may attempt a delivery (configured and switched on).
   can_receive_tasks: ROYAL may delegate work to it (a verified round trip
   is the latest word from it).  The page reads these; it infers nothing. */
export function publicBotView(bot, state = {}, extra = {}, now = Date.now()) {
  const connection = connectionOf(bot, state, now);
  return {
    id: bot.id, bot_id: bot.id, name: bot.name, config_state: bot.config, connection, connection_state: connection, realms: [...bot.realms],
    can_send: bot.config === "CONFIGURED", can_receive_tasks: connection === "CONNECTED_VERIFIED",
    config_error: bot.configError || null,
    last_seen: state.last_seen || null, last_message_at: state.last_message_at || null, last_error: state.last_error || null,
    last_verified_at: state.last_verified_at || null, last_roundtrip_ms: state.last_roundtrip_ms == null ? null : Number(state.last_roundtrip_ms),
    last_failure_at: state.last_failure_at || null, recent_success_rate: successRate(state.recent_outcomes),
    ...extra,
  };
}
