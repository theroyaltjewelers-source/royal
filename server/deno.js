/* Deno / Supabase Edge Function / Deno Deploy entry.
   Deploy the repository as-is; this file is the entry point.

   Storage note: Deno Deploy and Edge Functions have no durable local disk.
   This entry uses the in-memory store, so decisions and audit do not survive
   a restart, until the
   Postgres store is built: see docs/architecture/INTEGRATION_MODEL.md, section 4. */

import { createHandler, fromEnv } from "./handler.js";
import { MemoryStore } from "../core/store.js";
import { GrokProvider } from "../core/providers/grok.js";
import { UnavailableProvider } from "../core/providers/provider.js";

const env = Deno.env.toObject();
const { royal, auth, allowedOrigins, passcode } = await fromEnv(env, {
  store: new MemoryStore(),
  providerFactory: (e) => (e.XAI_API_KEY || e.ROYAL_GROK_MODEL ? new GrokProvider({ apiKey: e.XAI_API_KEY, model: e.ROYAL_GROK_MODEL }) : new UnavailableProvider("XAI_API_KEY and ROYAL_GROK_MODEL are not set.")),
});
Deno.serve(createHandler({ royal, auth, passcode, allowedOrigins }));
