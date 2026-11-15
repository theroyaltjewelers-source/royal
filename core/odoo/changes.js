/* POST /api/odoo-bridge/v1/changes, contract of 2026-11-15 6:07 PM ET.
   Body is only {"changes":[...]}, 1 to 50. There is no dry run on the House
   side. Signing is the feed's RT-ODOO-FEED/1 HMAC, done by the feed client.
   This file is the only place that builds a change or reads a result. */

import { retryWaitMs } from "./client.js";

export const CHANGES_MAX = 50;
export const PAYMENT_METHODS = ["cash", "card", "zelle", "wire", "check", "other"];
export const INQUIRY_STATUSES = ["new", "contacted", "quoting", "converted", "closed"];

export function chunkChanges(changes, size = CHANGES_MAX) {
  const out = [];
  const list = changes.slice();
  while (list.length) out.push(list.splice(0, size));
  return out;
}

/* The body the contract requires. Nothing else is added. */
export function toBatchPayload(changes) {
  return { changes: changes.slice(0, CHANGES_MAX) };
}

/* One result per change, in order. ok is true for applied, unchanged and duplicate. */
export function readChangeResults(body, sent) {
  const list = Array.isArray(body && body.results) ? body.results : [];
  return sent.map((change, i) => {
    const row = list.find((item) => item && change.ref && item.ref === change.ref) || (list.length === sent.length ? list[i] : null);
    if (!row) return { ref: change.ref || "", type: change.type, ok: false, status: "rejected", code: "invalid", error: "The dashboard did not return a result for this change.", house_id: "", version: null, event_id: "", event_origin: "" };
    const status = typeof row.status === "string" ? row.status : "";
    const ok = status === "applied" || status === "unchanged" || status === "duplicate";
    const version = Number.isFinite(row.version) ? row.version : null;
    return {
      ref: row.ref || change.ref || "", type: row.type || change.type, ok, status: status || (ok ? "applied" : "rejected"),
      house_id: row.house_id ? String(row.house_id) : "", version, event_id: row.event_id || "",
      event_origin: row.event_origin || "", code: row.code || "", error: typeof row.error === "string" ? row.error : "",
    };
  });
}

/* post(body) -> { status, retryAfter, json }. 429 and 503 wait and retry.
   A rejected item is a result, not a thrown error. */
export async function pushChanges(post, changes, { maxRetries = 5, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() } = {}) {
  if (!changes.length) return { results: [], batches: 0 };
  const results = [];
  let batches = 0;
  for (const batch of chunkChanges(changes)) {
    const body = toBatchPayload(batch);
    let attempt = 0;
    let parsed = null;
    for (;;) {
      const got = await post(body);
      batches++;
      if ((got.status === 429 || got.status === 503) && attempt < maxRetries) {
        await sleep(retryWaitMs(attempt, got.retryAfter, now()));
        attempt++;
        continue;
      }
      const whole = got.json && got.json.ok === false && !Array.isArray(got.json.results);
      if (got.status < 200 || got.status >= 300 || whole) {
        const why = (got.json && got.json.error) || ("HTTP " + got.status);
        for (const change of batch) results.push({ ref: change.ref || "", type: change.type, ok: false, status: "rejected", code: got.status === 409 ? "out_of_scope" : "invalid", error: String(why).slice(0, 300), house_id: "", version: null, event_id: "", event_origin: "" });
        break;
      }
      parsed = got.json;
      break;
    }
    if (parsed) results.push(...readChangeResults(parsed, batch));
  }
  return { results, batches };
}
