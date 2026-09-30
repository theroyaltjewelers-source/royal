/* The model provider abstraction.  ROYAL is the product; a model provider is
   an implementation dependency.  Swapping Grok for another vendor is a new
   file here and nothing else.

   interface AIProvider {
     id: string
     status(): { status: CONNECTED|NOT_CONNECTED|DEGRADED|ERROR, detail?, model? }
     capabilities(): { structured_output, tool_calling, search, x_search, vision,
                       realtime_voice, embeddings, reasoning_effort }

     complete({ system, messages, max_tokens, timeout_ms, level })
       -> { ok, text, usage } | { ok: false, failed_because, retryable, detail }
     structured({ system, messages, schema, name, level, timeout_ms })
       -> { ok, value, usage } | failure        (value already schema-checked)
     search({ query, system, allowed_domains, excluded_domains, x, level, timeout_ms })
       -> { ok, text, citations: [{url, title}], usage } | failure
     voiceSession({ seconds })
       -> { ok, token, expires_at, ws_url, model } | failure
   }

   A provider that cannot do something says so with a failure whose reason is
   CAPABILITY_NOT_SUPPORTED or PROVIDER_NOT_CONNECTED.  Nothing falls back to
   pretending. */

import { CONNECTION } from "../enums.js";
import { check } from "../intelligence/jsonschema.js";

const NONE = Object.freeze({ structured_output: false, tool_calling: false, search: false, x_search: false, vision: false, realtime_voice: false, embeddings: false, reasoning_effort: false });
const notConnected = { ok: false, failed_because: "PROVIDER_NOT_CONNECTED", retryable: false };

export class UnavailableProvider {
  constructor(reason = "No language provider is configured.") { this.id = "none"; this.reason = reason; }
  status() { return { status: CONNECTION.NOT_CONNECTED, detail: this.reason }; }
  capabilities() { return NONE; }
  async complete() { return notConnected; }
  async structured() { return notConnected; }
  async search() { return notConnected; }
  async voiceSession() { return notConnected; }
}

/* For development and tests only.  `script` answers every kind of call:
   a value, an Error, or a function (req, kind) -> value.  Every call is
   recorded, so a test can check what reached the model. */
export class ScriptedProvider {
  constructor(script, { caps = {} } = {}) {
    this.id = "scripted"; this.script = script; this.calls = [];
    this.caps = { structured_output: true, tool_calling: true, search: true, x_search: false, vision: false, realtime_voice: false, embeddings: false, reasoning_effort: false, ...caps };
  }
  status() { return { status: CONNECTION.CONNECTED, detail: "Scripted development provider", model: "scripted" }; }
  capabilities() { return this.caps; }
  async _run(req, kind) {
    this.calls.push({ ...req, kind });
    const out = typeof this.script === "function" ? await this.script(req, kind) : this.script;
    return out;
  }
  async complete(req) {
    const out = await this._run(req, "complete");
    if (out instanceof Error) return { ok: false, failed_because: out.message, retryable: true };
    return { ok: true, text: typeof out === "string" ? out : JSON.stringify(out) };
  }
  async structured(req) {
    if (!this.caps.structured_output) return { ok: false, failed_because: "CAPABILITY_NOT_SUPPORTED", retryable: false };
    const out = await this._run(req, "structured");
    if (out instanceof Error) return { ok: false, failed_because: out.message, retryable: true };
    const value = typeof out === "string" ? parseModelJson(out).value : out;
    const c = check(req.schema, value);
    return c.ok ? { ok: true, value } : { ok: false, failed_because: "MODEL_REPLY_FAILED_SCHEMA", detail: c.errors.slice(0, 5).join("; "), retryable: false };
  }
  async search(req) {
    if (!this.caps.search) return { ok: false, failed_because: "CAPABILITY_NOT_SUPPORTED", retryable: false };
    const out = await this._run(req, "search");
    if (out instanceof Error) return { ok: false, failed_because: out.message, retryable: true };
    if (req.schema) {
      const c = check(req.schema, out.value);
      if (!c.ok) return { ok: false, failed_because: "MODEL_REPLY_FAILED_SCHEMA", detail: c.errors.slice(0, 5).join("; "), retryable: false };
    }
    return { ok: true, text: out.text || JSON.stringify(out.value || ""), value: out.value, citations: out.citations || [] };
  }
  async voiceSession() { return { ok: false, failed_because: "CAPABILITY_NOT_SUPPORTED", retryable: false }; }
}

/* Parse a model's JSON reply defensively.  A reply that is not the promised
   shape is a failure, not something to be guessed at. */
export function parseModelJson(text) {
  const s = String(text || "").trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try { return { ok: true, value: JSON.parse(s) }; }
  catch (e) {
    const m = /\{[\s\S]*\}/.exec(s);
    if (m) { try { return { ok: true, value: JSON.parse(m[0]) }; } catch (_) { /* fall through */ } }
    return { ok: false, failed_because: "MODEL_REPLY_NOT_JSON" };
  }
}
