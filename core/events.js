/* Business events.  ROYAL does not only exist when Tahir opens it: a new
   snapshot, a decision being raised, a connector failing, each becomes an
   event that subscribers can act on.

   V1 is in-process: one append-only log and synchronous subscribers.  The
   log is the seam where a queue would go if one is ever needed.  Events are
   deduplicated by key, so a retried delivery is recognised and skipped. */

import { EVENT_TYPE } from "./enums.js";

export class EventBus {
  constructor({ store, audit, clock = () => Date.now() }) { this.store = store; this.audit = audit; this.clock = clock; this.subs = []; }

  subscribe(types, fn) { this.subs.push({ types: new Set(types === "*" ? [] : types), all: types === "*", fn }); }

  async publish(e) {
    if (!EVENT_TYPE[e.type]) throw new Error("EVENT_INVALID: unknown type " + e.type);
    if (!e.key) throw new Error("EVENT_INVALID: key is required for dedupe");
    if (await this.store.hasKey("events", e.key)) return { published: false, duplicate: true };
    const rec = { type: e.type, key: e.key, source: e.source || "royal", entity: e.entity || null,
      payload: e.payload || null, occurred_at: e.occurred_at || this.clock(), received_at: this.clock() };
    await this.store.append("events", rec);
    const errors = [];
    for (const s of this.subs) {
      if (!s.all && !s.types.has(e.type)) continue;
      try { await s.fn(rec); } catch (err) { errors.push(String(err.message || err)); }
    }
    if (errors.length) await this.audit.record({ actor: "system", action: "EVENT_HANDLER_FAILED", summary: e.type + " handler failed", error: errors.join("; ") });
    return { published: true, errors };
  }

  async recent({ limit = 100 } = {}) { return (await this.store.readLog("events", { limit })).reverse(); }
}

/* Map a verified state change to a business event. */
export function eventForChange(c, digest) {
  const t = { PAYMENT_RECEIVED: EVENT_TYPE.PAYMENT_RECEIVED, STAGE_CHANGED: EVENT_TYPE.PRODUCTION_STAGE_CHANGED,
    DEADLINE_CHANGED: EVENT_TYPE.COMMITMENT_CREATED, PROJECT_CREATED: EVENT_TYPE.LEAD_CREATED }[c.kind];
  if (!t) return null;
  const type = c.kind === "STAGE_CHANGED" && c.to === "Ready" ? EVENT_TYPE.PROJECT_READY : t;
  return { type, key: type + ":" + (c.project_id || "") + ":" + digest, source: "calculator", entity: c.project_id ? { type: "project", id: c.project_id } : null, payload: c };
}
