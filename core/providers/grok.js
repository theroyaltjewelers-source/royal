/* xAI Grok.

   Two xAI APIs are used, per current xAI documentation (September 2026):
     POST /v1/chat/completions   plain completion (complete())
     POST /v1/responses          structured output (text.format json_schema),
                                 server-side web_search and x_search tools,
                                 citations (response.citations and url_citation
                                 annotations on output_text)
     POST /v1/realtime/client_secrets   short-lived browser token for the
                                 realtime voice WebSocket (voiceSession())

   Server side only.  The key is read from the environment by the server and
   passed in here; it never reaches a browser, a log or a response.  If either
   the key or the model name is missing, the provider reports NOT_CONNECTED
   rather than guessing at a model.

   Transport.  complete() uses Chat Completions with the fewest parameters
   that work across Grok models (no temperature, no response_format); if the
   endpoint rejects the request shape, ROYAL retries once with only model and
   messages, and reports xAI's own reason if that fails too.  structured()
   and search() use the Responses API with a strict json_schema text format,
   and every reply is validated against the schema again here before use. */

import { CONNECTION } from "../enums.js";
import { check } from "../intelligence/jsonschema.js";
import { parseModelJson } from "./provider.js";

function clip(s, n = 240) { return String(s || "").replace(/\s+/g, " ").slice(0, n); }

export class GrokProvider {
  constructor({ apiKey, model, fastModel = null, voiceModel = "grok-voice-latest", voice = "eve", baseUrl = "https://api.x.ai/v1", fetchImpl = globalThis.fetch, timeoutMs = 45000, metrics = null }) {
    this.id = "grok";
    this._key = apiKey || null;
    this.model = model || null;
    this.fastModel = fastModel || null;      /* optional cheaper model for quick levels */
    this.voiceModel = voiceModel; this.voice = voice;
    this.metrics = metrics;
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

  /* What this provider can do.  Search, structured output and voice depend
     on the model family; xAI documents them for the Grok 4 family. */
  capabilities() {
    const on = this.status().status !== CONNECTION.NOT_CONNECTED;
    return { structured_output: on, tool_calling: on, search: on, x_search: on, vision: on, realtime_voice: !!this._key, embeddings: false, reasoning_effort: false };
  }

  modelFor(level) { return level !== undefined && level <= 1 && this.fastModel ? this.fastModel : this.model; }

  async _post(body, timeout, path = "/chat/completions") {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout || this.timeoutMs);
    try {
      const r = await this.fetch(this.baseUrl + path, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this._key },
        body: JSON.stringify(body),
      });
      let j = null; try { j = await r.json(); } catch (_) { j = null; }
      return { r, j };
    } finally { clearTimeout(timer); }
  }

  async complete({ system, messages = [], max_tokens = 900, timeout_ms, level }) {
    const st = this.status();
    if (st.status === CONNECTION.NOT_CONNECTED) return { ok: false, failed_because: "PROVIDER_NOT_CONNECTED", retryable: false };
    const msgs = (system ? [{ role: "system", content: system }] : []).concat(messages);
    const model = this.modelFor(level), t0 = Date.now();
    try {
      let { r, j } = await this._post({ model, messages: msgs, max_tokens }, timeout_ms);
      if (r.status === 400) ({ r, j } = await this._post({ model, messages: msgs }, timeout_ms));
      this._metric("complete", t0, r.ok, j && j.usage);
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

  _metric(kind, t0, ok, usage) {
    if (this.metrics) this.metrics.observe("provider." + kind, Date.now() - t0, { ok: !!ok, tokens: usage ? (usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0)) : 0 });
  }

  /* One call to the Responses API.  Returns the text, xAI's citations and
     the url_citation annotations, or a failure with xAI's reason. */
  async respond({ system, messages = [], tools = null, schema = null, name = "royal_output", level, timeout_ms, include = null }) {
    const st = this.status();
    if (st.status === CONNECTION.NOT_CONNECTED) return { ok: false, failed_because: "PROVIDER_NOT_CONNECTED", retryable: false };
    const input = (system ? [{ role: "system", content: system }] : []).concat(messages);
    const body = { model: this.modelFor(level), input };
    if (tools && tools.length) body.tools = tools;
    if (schema) body.text = { format: { type: "json_schema", name, schema, strict: true } };
    if (include) body.include = include;
    const t0 = Date.now();
    try {
      const { r, j } = await this._post(body, timeout_ms, "/responses");
      this._metric(tools ? "search" : schema ? "structured" : "respond", t0, r.ok, j && j.usage);
      if (!r.ok) {
        const why = clip((j && (j.error && (j.error.message || j.error) || j.message)) || "");
        this.lastError = "HTTP " + r.status + (why ? ": " + why : "");
        return { ok: false, failed_because: "PROVIDER_HTTP_" + r.status, detail: why || null, retryable: r.status >= 500 || r.status === 429 };
      }
      const parts = [], annotations = [];
      for (const item of (j && j.output) || []) {
        if (item.type !== "message") continue;
        for (const c of item.content || []) {
          if (c.type === "output_text" && typeof c.text === "string") { parts.push(c.text); for (const a of c.annotations || []) if (a && a.type === "url_citation" && a.url) annotations.push({ url: a.url, title: a.title || null, start: a.start_index, end: a.end_index }); }
        }
      }
      if (!parts.length && j && typeof j.output_text === "string") parts.push(j.output_text);
      const citations = ((j && j.citations) || []).map((c) => (typeof c === "string" ? { url: c, title: null } : { url: c.url, title: c.title || null })).filter((c) => c.url);
      for (const a of annotations) if (!citations.some((c) => c.url === a.url)) citations.push({ url: a.url, title: null });
      const text = parts.join("\n").trim();
      if (!text) { this.lastError = "empty reply"; return { ok: false, failed_because: "PROVIDER_EMPTY_REPLY", retryable: true }; }
      this.lastError = null; this.lastOkAt = Date.now();
      return { ok: true, text, citations, annotations, usage: (j && j.usage) || null, tool_usage: (j && (j.server_side_tool_usage || j.tool_usage)) || null };
    } catch (e) {
      this.lastError = e.name === "AbortError" ? "timeout" : "network";
      return { ok: false, failed_because: e.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK", retryable: true };
    }
  }

  /* Structured output: the reply must match `schema`, checked again here. */
  async structured({ system, messages, schema, name, level, timeout_ms, tools = null }) {
    const r = await this.respond({ system, messages, schema, name, level, timeout_ms, tools });
    if (!r.ok) return r;
    const p = parseModelJson(r.text);
    if (!p.ok) return { ok: false, failed_because: "MODEL_REPLY_NOT_JSON", retryable: false };
    const c = check(schema, p.value);
    if (!c.ok) return { ok: false, failed_because: "MODEL_REPLY_FAILED_SCHEMA", detail: c.errors.slice(0, 5).join("; "), retryable: false };
    return { ok: true, value: p.value, citations: r.citations, usage: r.usage };
  }

  /* Server-side search.  xAI runs the searches; ROYAL gets the answer text and
     every source xAI saw.  With a schema the answer is structured as well. */
  async search({ query, system, allowed_domains = null, excluded_domains = null, x = false, schema = null, name = "research", level, timeout_ms = 60000 }) {
    const web = { type: "web_search" };
    if (allowed_domains && allowed_domains.length) web.filters = { allowed_domains: allowed_domains.slice(0, 5) };
    else if (excluded_domains && excluded_domains.length) web.filters = { excluded_domains: excluded_domains.slice(0, 5) };
    const tools = [web].concat(x ? [{ type: "x_search" }] : []);
    const messages = [{ role: "user", content: query }];
    if (schema) {
      const r = await this.respond({ system, messages, tools, schema, name, level, timeout_ms });
      if (!r.ok) return r;
      const p = parseModelJson(r.text);
      if (!p.ok) return { ok: false, failed_because: "MODEL_REPLY_NOT_JSON", retryable: false };
      const c = check(schema, p.value);
      if (!c.ok) return { ok: false, failed_because: "MODEL_REPLY_FAILED_SCHEMA", detail: c.errors.slice(0, 5).join("; "), retryable: false };
      return { ok: true, value: p.value, text: r.text, citations: r.citations, usage: r.usage };
    }
    return this.respond({ system, messages, tools, level, timeout_ms });
  }

  /* A short-lived token the browser uses to open the realtime voice
     WebSocket itself.  The API key never leaves the server. */
  async voiceSession({ seconds = 300 } = {}) {
    if (!this._key) return { ok: false, failed_because: "PROVIDER_NOT_CONNECTED", retryable: false };
    try {
      const { r, j } = await this._post({ expires_after: { seconds: Math.max(60, Math.min(1800, seconds)) } }, 15000, "/realtime/client_secrets");
      if (!r.ok) return { ok: false, failed_because: "PROVIDER_HTTP_" + r.status, detail: clip(j && j.error && (j.error.message || j.error)), retryable: r.status >= 500 };
      const token = j && (j.value || (j.client_secret && (j.client_secret.value || j.client_secret)) || j.token);
      if (!token || typeof token !== "string") return { ok: false, failed_because: "PROVIDER_REPLY_UNEXPECTED", retryable: false };
      const expires = j.expires_at || (j.client_secret && j.client_secret.expires_at) || null;
      return { ok: true, token, expires_at: expires, ws_url: "wss://api.x.ai/v1/realtime?model=" + encodeURIComponent(this.voiceModel), model: this.voiceModel, voice: this.voice };
    } catch (e) {
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
