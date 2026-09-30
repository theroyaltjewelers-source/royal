/* xAI Grok.

   Server side only.  The key is read from the environment by the server and
   passed in here; it never reaches a browser, a log or a response.  If either
   the key or the model name is missing, the provider reports NOT_CONNECTED
   rather than guessing at a model.

   Transport: the OpenAI-compatible chat completions endpoint, sent with the
   fewest parameters that work across Grok models.  Reasoning models can reject
   sampling and formatting options, so ROYAL does not send temperature or
   response_format; it asks for JSON in the instructions and parses the reply
   defensively.  If the endpoint rejects the request shape, ROYAL retries once
   with only model and messages, and reports xAI's own reason if that fails too. */

import { CONNECTION } from "../enums.js";

function clip(s, n = 240) { return String(s || "").replace(/\s+/g, " ").slice(0, n); }

export class GrokProvider {
  constructor({ apiKey, model, baseUrl = "https://api.x.ai/v1", fetchImpl = globalThis.fetch, timeoutMs = 45000 }) {
    this.id = "grok";
    this._key = apiKey || null;
    this.model = model || null;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.lastError = null;
    this.lastOkAt = null;
  }

  status() {
    if (!this._key) return { status: CONNECTION.NOT_CONNECTED, detail: "XAI_API_KEY is not set on the server." };
    if (!this.model) return { status: CONNECTION.NOT_CONNECTED, detail: "ROYAL_GROK_MODEL is not set on the server." };
    if (this.lastError) return { status: CONNECTION.DEGRADED, detail: "Last call failed: " + this.lastError, model: this.model };
    return { status: CONNECTION.CONNECTED, model: this.model, last_ok_at: this.lastOkAt };
  }

  async _post(body, timeout) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout || this.timeoutMs);
    try {
      const r = await this.fetch(this.baseUrl + "/chat/completions", {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this._key },
        body: JSON.stringify(body),
      });
      let j = null; try { j = await r.json(); } catch (_) { j = null; }
      return { r, j };
    } finally { clearTimeout(timer); }
  }

  async complete({ system, messages = [], max_tokens = 900, timeout_ms }) {
    const st = this.status();
    if (st.status === CONNECTION.NOT_CONNECTED) return { ok: false, failed_because: "PROVIDER_NOT_CONNECTED", retryable: false };
    const msgs = (system ? [{ role: "system", content: system }] : []).concat(messages);
    try {
      let { r, j } = await this._post({ model: this.model, messages: msgs, max_tokens }, timeout_ms);
      if (r.status === 400) ({ r, j } = await this._post({ model: this.model, messages: msgs }, timeout_ms));
      if (!r.ok) {
        const why = clip((j && (j.error && (j.error.message || j.error) || j.message)) || "");
        this.lastError = "HTTP " + r.status + (why ? ": " + why : "");
        return { ok: false, failed_because: "PROVIDER_HTTP_" + r.status, detail: why || null, retryable: r.status >= 500 || r.status === 429 };
      }
      const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof text !== "string" || !text.trim()) { this.lastError = "empty reply"; return { ok: false, failed_because: "PROVIDER_EMPTY_REPLY", retryable: true }; }
      this.lastError = null; this.lastOkAt = Date.now();
      return { ok: true, text, usage: j.usage || null };
    } catch (e) {
      this.lastError = e.name === "AbortError" ? "timeout" : "network";
      return { ok: false, failed_because: e.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK", retryable: true };
    }
  }

  /* A tiny real call, so Tahir can see the connection work (or see xAI's
     reason why not) without waiting for an open question. */
  async test() {
    const t0 = Date.now();
    const r = await this.complete({ system: "Reply with the single word READY.", messages: [{ role: "user", content: "Status check." }], max_tokens: 20, timeout_ms: 30000 });
    return r.ok ? { ok: true, model: this.model, ms: Date.now() - t0, reply: clip(r.text, 40) }
      : { ok: false, model: this.model, failed_because: r.failed_because, detail: r.detail || null };
  }

  /* Never serialise the key. */
  toJSON() { return { id: this.id, model: this.model, status: this.status().status }; }
}
