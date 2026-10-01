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
import { currentTrace, recordModelCall } from "../trace.js";

/* How hard the model thinks, by ROYAL's reasoning level (core/intelligence/
   reasoning.js): 0 to 2 (lookups, quick answers, everyday operations) low,
   3 and 4 (deep analysis, research) medium, 5 (planning) high.  A call with
   no level is conversation and gets low.  Reasoning models such as grok-4.3
   default to high, which made every call, even classifying a greeting, slow. */
export const EFFORT_BY_LEVEL = ["low", "low", "low", "medium", "medium", "high"];
export function effortFor(level) { return level === undefined || level === null ? "low" : EFFORT_BY_LEVEL[Math.max(0, Math.min(5, level))]; }
const REJECTS_EFFORT = /reasoning|effort/i;

function clip(s, n = 240) { return String(s || "").replace(/\s+/g, " ").slice(0, n); }
function errText(j) { return String((j && (j.error && (j.error.message || j.error) || j.message)) || ""); }

export class GrokProvider {
  constructor({ apiKey, model, fastModel = null, voiceModel = "grok-voice-latest", voice = "ara", baseUrl = "https://api.x.ai/v1", fetchImpl = globalThis.fetch, timeoutMs = 45000, metrics = null }) {
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
    /* null until a call shows whether this model accepts reasoning effort;
       false after it rejects it once, so no call pays for that again. */
    this.effortOk = null;
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
    return { structured_output: on, tool_calling: on, search: on, x_search: on, vision: on, realtime_voice: !!this._key, speech: !!this._key, embeddings: false, reasoning_effort: false };
  }

  modelFor(level) { return level !== undefined && level <= 1 && this.fastModel ? this.fastModel : this.model; }

  async _post(body, timeout, path = "/chat/completions") {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout || this.timeoutMs);
    /* Prompt cache affinity: one conversation's calls go to the same xAI
       server, so its stable prefix (ROYAL's identity, the House language)
       is served from cache instead of processed cold each turn. */
    const t = currentTrace(), conv = t && t.conversation ? String(t.conversation).slice(0, 120) : null;
    const headers = { "Content-Type": "application/json", Authorization: "Bearer " + this._key };
    if (conv) { headers["x-grok-conv-id"] = conv; if (path === "/responses" && !body.prompt_cache_key) body = { ...body, prompt_cache_key: conv }; }
    try {
      const r = await this.fetch(this.baseUrl + path, {
        method: "POST", signal: ctl.signal, headers,
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
      const effort = this.effortOk === false ? null : effortFor(level);
      const req = { model, messages: msgs };
      if (this.maxTokensOk !== false) req.max_tokens = max_tokens;
      if (effort) req.reasoning_effort = effort;
      let { r, j } = await this._post(req, timeout_ms);
      /* A model that rejects an optional setting (reasoning effort, or a
         token cap) says so once; the setting is dropped and never sent to
         this model again, so later calls do not pay for a failed attempt. */
      if (r.status === 400 && effort && REJECTS_EFFORT.test(errText(j))) { this.effortOk = false; delete req.reasoning_effort; ({ r, j } = await this._post(req, timeout_ms)); }
      if (r.status === 400 && req.max_tokens !== undefined) { this.maxTokensOk = false; delete req.max_tokens; ({ r, j } = await this._post(req, timeout_ms)); }
      if (r.ok && req.reasoning_effort) this.effortOk = true;
      this._metric("complete", t0, r.ok, j && j.usage, req.reasoning_effort);
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

  _metric(kind, t0, ok, usage, effort) {
    const ms = Date.now() - t0, tokens = usage ? (usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0)) : 0;
    const det = usage && (usage.prompt_tokens_details || usage.input_tokens_details);
    const cached = det ? det.cached_tokens || 0 : 0;
    if (this.metrics) { this.metrics.observe("provider." + kind, ms, { ok: !!ok, tokens }); if (cached) this.metrics.count("provider.cached_tokens", cached); }
    recordModelCall({ kind, ms, ok: !!ok, effort: effort || null, tokens, cached_tokens: cached });
  }

  /* One call to the Responses API.  Returns the text, xAI's citations and
     the url_citation annotations, or a failure with xAI's reason. */
  async respond({ system, messages = [], tools = null, schema = null, name = "royal_output", level, timeout_ms, include = null }) {
    const st = this.status();
    if (st.status === CONNECTION.NOT_CONNECTED) return { ok: false, failed_because: "PROVIDER_NOT_CONNECTED", retryable: false };
    const input = (system ? [{ role: "system", content: system }] : []).concat(messages);
    const body = { model: this.modelFor(level), input };
    const effort = this.effortOk === false ? null : effortFor(level);
    if (effort) body.reasoning = { effort };
    if (tools && tools.length) body.tools = tools;
    if (schema) body.text = { format: { type: "json_schema", name, schema, strict: true } };
    if (include) body.include = include;
    const t0 = Date.now();
    try {
      let { r, j } = await this._post(body, timeout_ms, "/responses");
      if (r.status === 400 && effort && REJECTS_EFFORT.test(errText(j))) { this.effortOk = false; delete body.reasoning; ({ r, j } = await this._post(body, timeout_ms, "/responses")); }
      else if (r.ok && effort) this.effortOk = true;
      this._metric(tools ? "search" : schema ? "structured" : "respond", t0, r.ok, j && j.usage, body.reasoning && body.reasoning.effort);
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

  /* ROYAL's spoken voice: text in, MP3 out, through xAI text to speech
     (POST /v1/tts).  The same voice as realtime voice, so ROYAL sounds the
     same on every device and in both voice modes.  Returns the audio bytes;
     the key never leaves the server. */
  async speech({ text, voice = this.voice, timeout_ms = 20000 } = {}) {
    if (!this._key) return { ok: false, failed_because: "PROVIDER_NOT_CONNECTED", retryable: false };
    const words = String(text || "").trim();
    if (!words) return { ok: false, failed_because: "SPEECH_EMPTY", retryable: false };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout_ms);
    const t0 = Date.now();
    try {
      const r = await this.fetch(this.baseUrl + "/tts", {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this._key, Accept: "audio/mpeg" },
        body: JSON.stringify({ text: words, voice_id: voice, language: "en", output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 128000 } }),
      });
      if (!r.ok) {
        let j = null; try { j = await r.json(); } catch (_) { j = null; }
        /* xAI's reason goes to the page, so a key quoted in it is removed first. */
        const detail = clip(j && j.error && (j.error.message || j.error)).split(this._key).join("[key]").replace(/xai-[A-Za-z0-9]{8,}/g, "[key]");
        return { ok: false, failed_because: "PROVIDER_HTTP_" + r.status, detail, retryable: r.status >= 500 || r.status === 429 };
      }
      const audio = new Uint8Array(await r.arrayBuffer());
      if (!audio.length) return { ok: false, failed_because: "PROVIDER_REPLY_UNEXPECTED", retryable: true };
      if (this.metrics) this.metrics.observe("provider.speech", Date.now() - t0);
      return { ok: true, audio, type: "audio/mpeg", voice };
    } catch (e) {
      return { ok: false, failed_because: e.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK", retryable: true };
    } finally { clearTimeout(timer); }
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
