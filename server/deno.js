/* Deno / Supabase Edge Function / Deno Deploy entry.
   Deploy the repository as-is; this file is the entry point.

   Storage note: Deno Deploy and Edge Functions have no durable local disk,
   and this entry loads no Postgres driver, so it uses the in-memory store:
   decisions and audit do not survive a restart here.  The Postgres store
   (core/pgstore.js, ADR-013) runs on the Node entry only. */

import { createHandler, fromEnv } from "./handler.js";
import { MemoryStore } from "../core/store.js";
import { GrokProvider } from "../core/providers/grok.js";
import { UnavailableProvider } from "../core/providers/provider.js";
import { createBridge } from "../core/grokbot/bridge.js";
import { intelligenceFromEnv } from "./intelligence-env.js";

const env = Deno.env.toObject();
/* The Grok Bot bridge runs in memory here: no Postgres driver in this entry. */
const bridge = createBridge({ env });
/* The same intelligence parts as the Node entry (House knowledge, safe
   fetching, contact and email providers, metrics). */
const intel = await intelligenceFromEnv(env, { docsDir: new URL("../docs", import.meta.url).pathname });
const { royal, auth, allowedOrigins, passcode } = await fromEnv(env, {
  store: new MemoryStore(), extras: { ...intel, bridge },
  providerFactory: (e) => (e.XAI_API_KEY || e.ROYAL_GROK_MODEL ? new GrokProvider({ apiKey: e.XAI_API_KEY, model: e.ROYAL_GROK_MODEL, fastModel: e.ROYAL_GROK_FAST_MODEL,
    voiceModel: e.ROYAL_VOICE_MODEL || "grok-voice-latest", voice: e.ROYAL_VOICE || "eve", metrics: intel.metrics }) : new UnavailableProvider("XAI_API_KEY and ROYAL_GROK_MODEL are not set.")),
});
Deno.serve(createHandler({ royal, auth, passcode, bridge, allowedOrigins }));
