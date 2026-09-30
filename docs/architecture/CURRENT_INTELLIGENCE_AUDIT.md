# CURRENT INTELLIGENCE AUDIT

*Written 30 September 2026, before the intelligence layer was built, from the repository at commit b0d1183 (branch `feature/grokbot-bridge`). Section 12 records what changed afterwards.*

## 1. What the repository is

(a) **Frontend.** Plain ES modules in `web/`, no framework, no build. An ambient interface around a WebGL Core (`web/js/core.js`), a state machine (`state.js`), a stage for server-composed primitives (`stage.js`, `primitives.js`, `schema.js`), browser speech in and out (`voice.js`), and a Bots view (`bots.js`).

(b) **Backend.** A fetch-standard handler (`server/handler.js`) run by `node:http` through `server/node-adapter.js` (and by Deno through `server/deno.js`). No web framework.

(c) **Database.** Postgres only for the Grok Bot bridge (`DATABASE_URL`, `server/migrations/001_grokbot.sql`). Everything else (decisions, audit, events, snapshots, conversations) is in memory or a JSON file (`core/store.js`). On Render there is no disk, so that state is lost on restart.

(d) **Auth.** ROYAL's own passcode, HMAC session tokens (`server/passcode.js`), Supabase tokens for calculator ingest, per-bot hashed tokens for Grok Bots.

(e) **Deployment.** Render, one instance, manual deploys, no `render.yaml`.

(f) **Tests.** Node's runner, 125 passing (with Postgres and a calculator checkout).

## 2. What exists and works

| Area | Where | State |
|---|---|---|
| Orchestrator | `core/royal.js` | Works. One `handle()` for every command; realm split; conversation keyed per realm. |
| Intent | `core/intent.js`, `core/router.js` | Works, but it is rules: control verbs, entity follow-ups, then ordered regular expressions. No structured interpretation, no model. |
| Context | `core/context.js` | Works for House records only: entity by selection, ID, name, pronoun. Knows nothing about companies, people or drafts other than one `pending_draft`. |
| Permissions | `core/permissions.js` | Works, server-enforced. Six classes, a tool policy table, charters, realm walls, flags. |
| Approvals | `core/decisions.js` | Works. Owner-only resolve, APPROVE/MODIFY/REJECT, executor registry, verification, NO_EXECUTOR. Idempotent by status. |
| Audit | `core/audit.js` | Works, append-only, redacted, realm-tagged. |
| Events | `core/events.js` | Works for calculator changes; proactive monitoring is off. |
| Source registry | `core/sources.js` | Works for House domains; no external domains. |
| Specialists | `realms/business/royal-t/specialists.js` | ACE, GRACE, LEDGER, FORGE are deterministic code over calculator data. HOUSE is NOT_CONNECTED. |
| Composer | `core/composer.js`, `web/js/schema.js` | Works; validated primitives both sides. |
| Calculator | `realms/business/royal-t/connector.js` | Works when the calculator page pushes a snapshot (House API `rtj.house.v1`). Read-only. |
| Grok provider | `core/providers/grok.js` | Works when `XAI_API_KEY` and `ROYAL_GROK_MODEL` are set. Chat Completions only. Used only for `open_question`, over labelled House facts. |
| Grok Bot bridge | `core/grokbot/` | Works: seven bots, webhooks, tokens, feeds, streams, Postgres. |
| Voice | `web/js/voice.js` | Browser speech recognition and synthesis. Not realtime, not the provider's voice. |

## 3. What is mocked

(a) `ScriptedProvider` in tests stands in for Grok. It is labelled development-only.

(b) Nothing user-facing is mocked. Unconnected domains say NOT CONNECTED.

## 4. What is broken or misrouted

(a) **External questions are misrouted.** "Find five corporate gifting prospects in Raleigh" matches the `sales_pipeline` rule ("prospects") and returns the House pipeline. "Who is the CFO of X?" falls to `open_question`, which answers only from House facts, so it can only say it does not know.

(b) **World questions cannot be answered** even with Grok connected: `open_question` tells the model to answer only from House facts.

(c) **No arithmetic path.** "What is 12% of $85,000?" goes to the model or nowhere.

(d) **No research, knowledge retrieval, people research, contact research, planning, tool metadata, research memory or observability exist.**

## 5. What is not connected

Web search, X search, any search API, people/contact providers (Apollo, Hunter, People Data Labs), email sending, CRM, calendar, Gold Buy, Tahir & Co., QuickBooks, Jewel360, realtime voice, MCP.

## 6. Duplication

(a) `core/intent.js` and `core/router.js` are two layers of the same rules; acceptable, but a third rules layer must not be added.

(b) ROYAL's internal specialists and the external Grok Bots share names (royal, ace, house, grace). They are different things and must stay in separate namespaces.

## 7. Preserve

The permission engine, decision service, audit, realm split, composer and schema, calculator connector, deterministic House skills (they answer the most common questions with no model), the Grok Bot bridge, and the interface.

## 8. Refactor

(a) `GrokProvider`: add the Responses API for structured output and server-side search; keep Chat Completions for plain completion.

(b) `open_question`: becomes one path of an intelligence dispatcher instead of the only fallback.

(c) Conversation context: add companies, people, drafts, research, referents.

(d) The evidence vocabulary: add VERIFIED_INTERNAL, VERIFIED_EXTERNAL and MODEL_KNOWLEDGE alongside the existing labels.

## 9. Replace

Nothing wholesale. The rule router stays as the fast path for House state.

## 10. New infrastructure required

Intent engine with schema-validated model interpretation; reasoning router; truth and provenance; House knowledge engine; research engine with web search, fetching, source quality, cross-checking, conflicts and a TTL cache; executive and contact research with provider adapters; email verification statuses; planner; tool registry metadata; agent router with task follow-through and a Grok Bot adapter; integration gateway; email sending adapter with idempotency; realtime voice provider; observability.

## 11. Risks and blockers

(a) **Security.** Web pages and provider responses are untrusted text reaching a model: prompt injection. Fetching URLs from model output: SSRF. Contact research: privacy. Sending: duplicate or unauthorised sends.

(b) **Data.** Research goes stale; a cached "current CFO" must expire. Pattern-guessed emails must never read as verified.

(c) **Providers.** xAI search, voice and structured outputs depend on the configured model (`grok-4.7` family per current docs). Apollo, Hunter and Resend need paid keys.

(d) **Blockers.** No credentials for any external provider exist in this environment, and the build sandbox cannot reach the public internet except through documentation lookups. Live calls to xAI, Hunter, Apollo and Resend therefore cannot be exercised here; they are built against current official documentation and tested with recorded-shape fakes, and they report NOT CONFIGURED until keys are set.

## 12. After this change

See `ROYAL_INTELLIGENCE_ARCHITECTURE.md` for what was built and the final status table.
