/* Small, dependency-free helpers shared across ROYAL.  Everything here runs the
   same in a browser, Node and Deno. */

export function newId(prefix) {
  const u = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID().replace(/-/g, "")
    : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return prefix + "_" + u.slice(0, 20);
}

/* JSON with keys sorted at every depth, so two objects holding the same thing
   serialise identically regardless of the order they were built in.  The
   calculator's recovery snapshots use the same rule. */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

/* FNV-1a, 53 bits.  For idempotency and dedupe keys, not for security. */
export function stableHash(v) {
  const s = typeof v === "string" ? v : canonical(v);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return (h2 & 0x1fffff).toString(16).padStart(6, "0") + h1.toString(16).padStart(8, "0");
}

export function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

export function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

export const DAY = 86400000;

export function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

export function parseDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  /* A bare date is a whole day in local time, not midnight UTC. */
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  const t = Date.parse(v);
  return isFinite(t) ? t : null;
}

export function daysBetween(fromMs, toMs) { return Math.round((startOfDay(toMs) - startOfDay(fromMs)) / DAY); }

export function money(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US");
}

export function plural(n, word, many) { return n + " " + (n === 1 ? word : (many || word + "s")); }

/* Keys that must never reach a log, a model or a response, whatever object
   they are found in. */
const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|authorization|cookie|service[_-]?role|private[_-]?key|jwt)/i;

export function redact(v, depth = 0) {
  if (depth > 12 || v === null || typeof v !== "object") {
    if (typeof v === "string" && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) return "[REDACTED_JWT]";
    if (typeof v === "string" && /^(xai|sk)-[A-Za-z0-9]{16,}/.test(v)) return "[REDACTED_KEY]";
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(v[k], depth + 1);
  return out;
}
