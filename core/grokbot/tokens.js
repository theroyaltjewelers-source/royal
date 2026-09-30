/* Per-bot API tokens.

   A token looks like  rbt_<prefix>_<secret>.  The prefix (12 characters) is
   stored in clear so a presented token can be found without scanning; the
   whole token is stored only as a SHA-256 hash and compared in constant
   time.  The plaintext exists once: in the response that minted it. */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const TOKEN_RE = /^rbt_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/;
const b64u = (buf) => buf.toString("base64url");

export const isBotToken = (t) => typeof t === "string" && t.startsWith("rbt_");
export const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex");

export function mintToken() {
  /* prefix: 9 random bytes -> 12 chars; secret: 32 random bytes -> 43 chars */
  const prefix = b64u(randomBytes(9)), secret = b64u(randomBytes(32));
  const token = "rbt_" + prefix + "_" + secret;
  return { token, prefix, hash: hashToken(token) };
}

export function parseToken(t) {
  const m = TOKEN_RE.exec(String(t || ""));
  return m ? { prefix: m[1] } : null;
}

export function sameHash(aHex, bHex) {
  const a = Buffer.from(String(aHex), "hex"), b = Buffer.from(String(bHex), "hex");
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

/* Resolve a presented token to its bot, or null.  `store` supplies the row. */
export async function verifyBotToken(store, presented) {
  const p = parseToken(presented);
  if (!p) return null;
  const row = await store.findActiveToken(p.prefix);
  const given = hashToken(presented);
  /* Compare even when there is no row, so timing does not reveal prefixes. */
  const ok = sameHash(row ? row.token_hash : "0".repeat(64), given);
  if (!row || !ok || row.revoked_at) return null;
  store.touchToken(row.id).catch(() => {});
  return { bot_id: row.bot_id, token_id: row.id };
}
