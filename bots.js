// ROYAL <-> Grok Bot bridge v2: bot registry (server-side only).
//
// Reads per-bot config from environment variables (set them in Render >
// Environment, never in config.js or any file the browser can load):
//
//   GROKBOT_ENABLED=true                     master switch (off by default)
//   GROKBOT_BOTS=skill_library,royal,me_bot,house,ace,grace,grok_bot
//   GROKBOT_<ID>_WEBHOOK_URL                 that bot's own webhook routine URL
//   GROKBOT_<ID>_WEBHOOK_KEY                 that routine's sender key
//   GROKBOT_<ID>_KEY_HEADER                  header the key goes in (default
//                                            "Authorization" -> "Bearer <key>")
//   GROKBOT_<ID>_NAME                        display name (optional)
//   GROKBOT_<ID>_ENABLED=false               switch one bot off (optional)
//
// <ID> is the bot id upper-cased: me_bot -> GROKBOT_ME_BOT_WEBHOOK_URL.
// Legacy v1 vars GROKBOT_WEBHOOK_URL / _KEY / GROKBOT_KEY_HEADER are used as a
// fallback for the "skill_library" bot so an existing v1 setup keeps working.
//
// The objects returned here contain the webhook URL + key. They must never be
// serialized to the frontend; use publicBotView() for anything client-facing.

export const BOT_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const LEGACY_BOT_ID = "skill_library";
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "cookie"]);

const DEFAULT_NAMES = {
  skill_library: "Skill Library",
  royal: "ROYAL",
  me_bot: "Me Bot",
  house: "House",
  ace: "Ace",
  grace: "Grace",
  grok_bot: "Grok Bot",
};

const titleCase = (id) => id.split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
export const envPrefix = (id) => `GROKBOT_${id.toUpperCase()}_`;

function checkUrl(raw, allowInsecure) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return "BAD_WEBHOOK_URL"; }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && allowInsecure) return null; // local testing only
  return "WEBHOOK_URL_MUST_BE_HTTPS";
}

export function loadBotRegistry(env = process.env) {
  const globalEnabled = env.GROKBOT_ENABLED === "true";
  const allowInsecure = env.GROKBOT_ALLOW_INSECURE_WEBHOOKS === "true";
  const warnings = [];
  const ids = String(env.GROKBOT_BOTS || LEGACY_BOT_ID)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!ids.includes(LEGACY_BOT_ID)) ids.unshift(LEGACY_BOT_ID); // v1 routes map here

  const bots = new Map();
  for (const id of ids) {
    if (!BOT_ID_RE.test(id)) { warnings.push(`ignored invalid bot id "${id.slice(0, 40)}"`); continue; }
    if (bots.has(id)) continue;
    const p = envPrefix(id);
    const legacy = id === LEGACY_BOT_ID;
    const url = String(env[p + "WEBHOOK_URL"] || (legacy && env.GROKBOT_WEBHOOK_URL) || "").trim();
    const key = String(env[p + "WEBHOOK_KEY"] || (legacy && env.GROKBOT_WEBHOOK_KEY) || "").trim();
    const header = String(env[p + "KEY_HEADER"] || (legacy && env.GROKBOT_KEY_HEADER) || "Authorization").trim();

    let configError = checkUrl(url, allowInsecure);
    if (!configError && (!HEADER_RE.test(header) || FORBIDDEN_HEADERS.has(header.toLowerCase()))) configError = "BAD_KEY_HEADER";
    if (configError) warnings.push(`bot "${id}": ${configError}`);

    const enabled = globalEnabled && env[p + "ENABLED"] !== "false";
    const configured = Boolean(url && key && !configError);
    const status = !configured ? "NOT_CONNECTED" : !enabled ? "DISABLED" : "CONNECTED";
    const name = String(env[p + "NAME"] || DEFAULT_NAMES[id] || titleCase(id)).trim().slice(0, 64);

    bots.set(id, Object.freeze({ id, name, url, key, header, enabled, configured, status, configError }));
  }
  return { bots, warnings, globalEnabled };
}

// [headerName, headerValue] for the outbound webhook call.
export function authHeaderFor(bot) {
  return [bot.header, bot.header.toLowerCase() === "authorization" ? `Bearer ${bot.key}` : bot.key];
}

// Whitelisted, frontend-safe view. Never add url/key/header here.
export function publicBotView(bot, state = {}, liveStreams = 0) {
  return {
    bot_id: bot.id,
    name: bot.name,
    status: bot.status,                 // CONNECTED | NOT_CONNECTED | DISABLED
    config_error: bot.configError || null, // e.g. WEBHOOK_URL_MUST_BE_HTTPS (no secrets)
    accepts_events: bot.enabled,
    last_seen: state.last_seen || null,           // last time the bot posted an event
    last_message_at: state.last_message_at || null, // last time ROYAL messaged the bot
    last_error: state.last_error || null,         // last webhook delivery error code
    live_streams: liveStreams,
  };
}
