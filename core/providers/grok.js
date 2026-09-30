/* xAI Grok, through its OpenAI-compatible chat completions endpoint.

   Server side only.  The key is read from the environment by the server and
   passed in here; it never reaches a browser, a log or a response.  If either
   the key or the model name is missing, the provider reports NOT_CONNECTED
   rather than guessing at a model. */

import { CONNECTION } from "../enums.js";

export class GrokProvider {
  constructor({ apiKey, model, baseUrl = "https://api.x.ai/v1", fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
    this.id = "grok";
    this._key = apiKey || null;
    this.model = model || null;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.lastError = null;
  }

  status() {
    if (!this._key) return { status: CONNECTION.NOT_CONNECTED, detail: "XAI_API_KEY is not set on the server." };
    if (!this.model) return { status: CONNECTION.NOT_CONNECTED, detail: "ROYAL_GROK_MODEL is not set on the server." };
    if (this.lastError) return { status: CONNECTION.DEGRADED, detail: "Last call failed: " + this.lastError, model: this.model };
    return { status: CONNECTION.CONNECTED, model: this.model };
  }

  async complete({ system, messages = [], json = false, max_tokens = 900, timeout_ms }) {
    const st = this.status();
    if (st.status === CONNECTION.NOT_CONNECTED) return { ok: false, failed_because: "PROVIDER_NOT_CONNECTED", retryable: false };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout_ms || this.timeoutMs);
    try {
      const body = { model: this.model, max_tokens, temperature: 0.2,
        messages: (system ? [{ role: "system", content: system }] : []).concat(messages) };
      if (json) body.response_format = { type: "json_object" };
      const r = await this.fetch(this.baseUrl + "/chat/completions", {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this._key },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        this.lastError = "HTTP " + r.status;
        return { ok: false, failed_because: "PROVIDER_HTTP_" + r.status, retryable: r.status >= 500 || r.status === 429 };
      }
      const j = await r.json();
      const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof text !== "string") { this.lastError = "empty reply"; return { ok: false, failed_because: "PROVIDER_EMPTY_REPLY", retryable: true }; }
      this.lastError = null;
      return { ok: true, text, usage: j.usage || null };
    } catch (e) {
      this.lastError = e.name === "AbortError" ? "timeout" : "network";
      return { ok: false, failed_because: e.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK", retryable: true };
    } finally { clearTimeout(timer); }
  }

  /* Never serialise the key. */
  toJSON() { return { id: this.id, model: this.model, status: this.status().status }; }
}
