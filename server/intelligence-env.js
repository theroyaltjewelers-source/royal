/* Builds the intelligence layer's server-side parts from the environment.
   Keys are read here and nowhere else; none is ever sent to a browser. */

import { KnowledgeEngine } from "../core/intelligence/knowledge.js";
import { SafeFetcher } from "../core/intelligence/research/fetch.js";
import { HunterProvider, ApolloProvider } from "../core/intelligence/research/contacts.js";
import { ResendEmailProvider } from "../core/intelligence/comms.js";
import { Metrics } from "../core/intelligence/metrics.js";

export async function intelligenceFromEnv(env, { docsDir }) {
  const metrics = new Metrics();
  const knowledge = new KnowledgeEngine();
  try { const st = await knowledge.ingestDir(docsDir); console.log("ROYAL: House knowledge loaded: " + st.documents + " documents, " + st.passages + " passages."); }
  catch (e) { console.warn("ROYAL: House knowledge could not be loaded: " + e.message); }
  return {
    metrics, knowledge,
    fetcher: new SafeFetcher({ metrics }),
    hunter: env.HUNTER_API_KEY ? new HunterProvider({ apiKey: env.HUNTER_API_KEY, perDay: Number(env.HUNTER_DAILY_LIMIT || 200), metrics }) : null,
    apollo: env.APOLLO_API_KEY ? new ApolloProvider({ apiKey: env.APOLLO_API_KEY, perDay: Number(env.APOLLO_DAILY_LIMIT || 100), metrics }) : null,
    email: env.RESEND_API_KEY || env.ROYAL_EMAIL_FROM ? new ResendEmailProvider({ apiKey: env.RESEND_API_KEY, from: env.ROYAL_EMAIL_FROM, metrics }) : null,
  };
}
