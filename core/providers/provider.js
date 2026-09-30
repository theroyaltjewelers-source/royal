/* The language provider abstraction.  ROYAL's reasoning about the business
   is structured and deterministic; a provider is used for two narrower jobs:
   phrasing a structured result for a person, and answering an open question
   from facts ROYAL hands it.  Swapping Grok for another vendor is a new file
   here and nothing else.

   interface AIProvider {
     id: string
     status(): { status: "CONNECTED"|"NOT_CONNECTED"|"DEGRADED"|"ERROR", detail?: string, model?: string }
     complete({ system, messages, json, max_tokens, timeout_ms }): Promise<
       { ok: true, text, usage? } | { ok: false, failed_because, retryable }>
   }
*/

import { CONNECTION } from "../enums.js";

export class UnavailableProvider {
  constructor(reason = "No language provider is configured.") { this.id = "none"; this.reason = reason; }
  status() { return { status: CONNECTION.NOT_CONNECTED, detail: this.reason }; }
  async complete() { return { ok: false, failed_because: "PROVIDER_NOT_CONNECTED", retryable: false }; }
}

/* For development and tests only.  Returns whatever the script says, and
   records what it was asked, so a test can check that no secret and no
   unlabelled fact ever reached a model. */
export class ScriptedProvider {
  constructor(script) { this.id = "scripted"; this.script = script; this.calls = []; }
  status() { return { status: CONNECTION.CONNECTED, detail: "Scripted development provider", model: "scripted" }; }
  async complete(req) {
    this.calls.push(req);
    const out = typeof this.script === "function" ? await this.script(req) : this.script;
    if (out instanceof Error) return { ok: false, failed_because: out.message, retryable: true };
    return { ok: true, text: typeof out === "string" ? out : JSON.stringify(out) };
  }
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
