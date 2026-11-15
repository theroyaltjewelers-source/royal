/* The House (Repaint) Odoo event feed, contract v1.
   Signing follows the feed contract exactly: six canonical lines, no trailing
   newline, HMAC-SHA256 of that string, key = the secret's UTF-8 bytes as-is
   (never hex-decoded). A GET has an empty body, whose SHA-256 is the
   well-known empty digest. */

import { createHash, createHmac, randomBytes } from "node:crypto";

export const FEED_VERSION = "RT-ODOO-FEED/1";
export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const DEFAULT_FEED_BASE = "https://thehouseofroyaltdesign.com/api/odoo-bridge/v1";

export function contentSha256(body) {
  const raw = body == null || body === "" ? "" : String(body);
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/* RFC 3339 in UTC, whole seconds, matching the feed's own example
   (2026-11-15T20:05:00Z) so the signed timestamp has no fractional part. */
export function feedTimestamp(date = new Date()) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function feedNonce() {
  return randomBytes(16).toString("hex");
}

export function canonicalString({ method, target, timestamp, nonce, contentSha256: digest }) {
  return [FEED_VERSION, String(method || "").toUpperCase(), target, timestamp, nonce, digest].join("\n");
}

export function signFeed({ secret, method, target, timestamp, nonce, body }) {
  const digest = contentSha256(body == null ? "" : body);
  const canonical = canonicalString({ method, target, timestamp, nonce, contentSha256: digest });
  const signature = createHmac("sha256", String(secret)).update(canonical, "utf8").digest("hex");
  return { contentSha256: digest, canonical, signature };
}

export function feedHeaders({ keyId, secret, method, target, body, timestamp, nonce }) {
  const signed = signFeed({ secret, method, target, timestamp, nonce, body });
  const headers = {
    "X-RT-Feed-Version": "1",
    "X-RT-Key-Id": keyId,
    "X-RT-Timestamp": timestamp,
    "X-RT-Nonce": nonce,
    "X-RT-Content-SHA256": signed.contentSha256,
    "X-RT-Signature": signed.signature,
  };
  if (String(method).toUpperCase() !== "GET") headers["Content-Type"] = "application/json";
  return { headers, ...signed };
}

/* Ack bodies are limited to 100 ids in each list. */
export function chunkAck(delivered, failed, size = 100) {
  const d = (delivered || []).slice();
  const f = (failed || []).slice();
  const chunks = [];
  while (d.length || f.length) chunks.push({ delivered: d.splice(0, size), failed: f.splice(0, size) });
  return chunks;
}

function feedInt(n, label) {
  const x = Number(n);
  if (!Number.isInteger(x) || x < 0 || x > 1e15) throw new Error("The House feed " + label + " is not a whole number.");
  return String(x);
}

export function feedPath(baseUrl) {
  const u = new URL(baseUrl);
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("The House feed URL must be https, with no password in it.");
  return { origin: u.origin, path: u.pathname.replace(/\/+$/, "") || "" };
}

/* One signed request. `clock` and `nonce` are injectable so tests can pin
   the canonical string. Nothing here logs the secret or the signature. */
export function createFeedClient({ baseUrl, keyId, secret, fetchImpl = globalThis.fetch, clock = () => new Date(), nonce = feedNonce, timeoutMs = 20000 }) {
  const { origin, path } = feedPath(baseUrl);

  /* status and retryAfter stay visible so the changes adapter can back off
     on 429 and 503. Ack and the event pull still treat any refusal as an error. */
  async function exchange(method, target, bodyObj) {
    const timestamp = feedTimestamp(clock());
    const n = nonce();
    if (typeof n !== "string" || n.length < 16 || n.length > 100) throw new Error("The feed nonce must be 16 to 100 characters.");
    const raw = bodyObj == null ? "" : JSON.stringify(bodyObj);
    const { headers } = feedHeaders({ keyId, secret, method, target, body: raw, timestamp, nonce: n });
    const res = await fetchImpl(origin + target, {
      method, headers, body: method === "GET" ? undefined : raw, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { status: res.status, retryAfter: res.headers.get("retry-after"), json, body: raw };
  }

  async function request(method, target, bodyObj) {
    const got = await exchange(method, target, bodyObj);
    const json = got.json;
    if (got.status === 404) throw new Error("The House feed returned 404. Save the same key id and secret on the Repaint Odoo sync page.");
    if (got.status < 200 || got.status >= 300 || (json && json.ok === false)) {
      const why = (json && typeof json.error === "string" && json.error) || ("HTTP " + got.status);
      const hint = got.status === 401 ? " Check that REPAINT_FEED_KEY_ID and REPAINT_FEED_SECRET match the Repaint Odoo sync page." : "";
      const err = new Error("The House feed refused the request (" + got.status + "): " + why + "." + hint);
      err.status = got.status;
      err.retryAfter = got.retryAfter;
      throw err;
    }
    return json || {};
  }

  return {
    /* Oldest undelivered page. The query string is built here and signed
       byte for byte; nothing reorders or re-encodes it afterwards. */
    getEvents(after = 0, limit = 50) {
      const target = path + "/events?after=" + feedInt(after, "cursor") + "&limit=" + feedInt(limit, "limit");
      return request("GET", target, null);
    },
    ack(body) {
      return request("POST", path + "/ack", { delivered: body.delivered || [], failed: body.failed || [] });
    },
    /* Inbound dashboard changes. Returns the status instead of throwing, so
       the caller can retry 429 and 503. The body is whatever the adapter built. */
    changes(body) {
      return exchange("POST", path + "/changes", body);
    },
  };
}
