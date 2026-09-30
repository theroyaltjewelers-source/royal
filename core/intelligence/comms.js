/* External email.  Sending is consequential: it only happens as the executor
   of an approved Decision, and only when the agent_external_send flag is on
   and a provider is configured.  Otherwise the approval is recorded and ROYAL
   says plainly that nothing was sent.

   Provider: Resend (POST https://api.resend.com/emails, Bearer key,
   Idempotency-Key header, reply {id}).  The idempotency key is the Decision's
   id, so a retry can never send twice; ROYAL also refuses to execute a
   Decision that is not OPEN.  "Sent" is only said after the provider returns
   a message id.  Verification reads the message back (GET /emails/{id}):
   "delivered" is verified, a bounce, failure or complaint is a failure, and
   anything else means accepted but not yet confirmed. */

import { stableHash } from "../util.js";

export class ResendEmailProvider {
  constructor({ apiKey, from, fetchImpl = globalThis.fetch, metrics = null }) { this.id = "resend"; this._key = apiKey || null; this.from = from || null; this.fetch = fetchImpl; this.metrics = metrics; }
  configured() { return !!(this._key && this.from); }
  status() { return this.configured() ? { status: "CONNECTED", detail: "from " + this.from } : { status: "NOT_CONFIGURED", detail: "RESEND_API_KEY and ROYAL_EMAIL_FROM are not set." }; }
  async send({ to, subject, text, idempotencyKey }) {
    if (!this.configured()) return { ok: false, failed_because: "EMAIL_NOT_CONFIGURED" };
    const t0 = Date.now();
    try {
      const r = await this.fetch("https://api.resend.com/emails", { method: "POST", signal: AbortSignal.timeout(20000),
        headers: { Authorization: "Bearer " + this._key, "Content-Type": "application/json", "Idempotency-Key": String(idempotencyKey).slice(0, 256) },
        body: JSON.stringify({ from: this.from, to: [to], subject, text }) });
      const j = await r.json().catch(() => null);
      if (this.metrics) this.metrics.observe("provider.resend.send", Date.now() - t0, { ok: r.ok });
      if (!r.ok || !j || !j.id) return { ok: false, failed_because: "EMAIL_PROVIDER_HTTP_" + r.status, detail: j && (j.message || j.name) ? String(j.message || j.name).slice(0, 200) : null };
      return { ok: true, message_id: j.id };
    } catch (e) { return { ok: false, failed_because: "EMAIL_PROVIDER_UNREACHABLE", retryable: true }; }
  }
  async check(messageId) {
    try {
      const r = await this.fetch("https://api.resend.com/emails/" + encodeURIComponent(messageId), { headers: { Authorization: "Bearer " + this._key }, signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => null);
      return r.ok && j ? { ok: true, last_event: j.last_event || null } : { ok: false };
    } catch (_) { return { ok: false }; }
  }
}

/* The executor registered for send_email.  Checks that what it is about to
   send is exactly what was approved (the args hash recorded when the
   Decision was created, or the modified args Tahir approved). */
export function emailExecutor(provider, { clock = () => Date.now() } = {}) {
  return async (args, { decision } = {}) => {
    const d = args && args.draft;
    if (!d || !d.to || !d.subject || !d.body) return { ok: false, detail: "The approved message is incomplete; nothing was sent." };
    /* An edited-and-approved message (MODIFY) is exactly what Tahir approved; otherwise the
       content must match what the Decision showed when it was created. */
    if (args.args_hash && !(decision && decision.status === "MODIFIED") && args.args_hash !== emailHash(d)) return { ok: false, detail: "The message changed after approval; nothing was sent." };
    const r = await provider.send({ to: d.to, subject: d.subject, text: d.body, idempotencyKey: "royal-" + (decision ? decision.id : emailHash(d)) });
    if (!r.ok) return { ok: false, detail: r.failed_because + (r.detail ? ": " + r.detail : "") };
    return {
      ok: true, detail: "Accepted by " + provider.id + " as message " + r.message_id + " at " + new Date(clock()).toISOString() + ".", message_id: r.message_id,
      /* true only when the provider reports it delivered; false on a bounce,
         failure or complaint; null (accepted, delivery not yet confirmed)
         for "sent", "queued", "delivery_delayed" or an unreadable status. */
      verify: async () => {
        const c = await provider.check(r.message_id);
        if (!c.ok) return null;
        const e = String(c.last_event || "").toLowerCase();
        return e === "delivered" ? true : /bounced|failed|complained/.test(e) ? false : null;
      },
    };
  };
}

export const emailHash = (d) => stableHash([String(d.to).toLowerCase(), d.subject, d.body]);
