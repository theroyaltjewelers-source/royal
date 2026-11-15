/* What to do with one feed envelope, before any Odoo call.
   Already-applied event ids are decided by the worker (it has the store).
   This decides the rest: bridge.test is ack only, a test flag is skipped
   unless ODOO_SYNC_ALLOW_TEST is on, and a record_version lower than the
   last one applied for that House id is ignored. Equal or higher versions
   are applied. A resend is a new event id with a higher version, so it
   applies on its own. */

export function recordKey(event) {
  const d = (event && event.data) || {};
  const id = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
  switch (event && event.event_type) {
    case "client.created":
    case "client.updated": return id(d.client_id) ? "client:" + id(d.client_id) : "";
    case "inquiry.created":
    case "inquiry.updated": return id(d.inquiry_id) ? "inquiry:" + id(d.inquiry_id) : "";
    case "payment.recorded":
    case "payment.updated":
    case "payment.voided": return id(d.payment_id) ? "payment:" + id(d.payment_id) : "";
    case "payment.refunded": return id(d.refund_id) ? "refund:" + id(d.refund_id) : "";
    default: return "";
  }
}

export function planEvent(event, { previousVersion = null, allowTest = false } = {}) {
  if (!event || typeof event.event_id !== "string" || !event.event_id.trim()) {
    return { action: "fail", error: "The event has no event_id." };
  }
  if (event.event_type === "bridge.test") return { action: "skip", reason: "bridge.test" };
  /* A change we pushed comes back as a feed event. Writing it again would
     loop. The tag is origin "odoo" on the envelope or inside data. */
  if (event.origin === "odoo" || (event.data && event.data.origin === "odoo")) return { action: "skip", reason: "origin-odoo" };
  const isTest = event.test === true || !!(event.data && event.data.test === true);
  if (isTest && !allowTest) return { action: "skip", reason: "test" };
  const key = recordKey(event);
  if (!key) return { action: "fail", error: "I don't recognise event type " + String(event.event_type || "") + "." };
  const version = Number(event.record_version);
  const v = Number.isFinite(version) ? version : 0;
  if (previousVersion != null && v < previousVersion) return { action: "skip", reason: "stale-version", version: v, key };
  return { action: "apply", key, version: v };
}
