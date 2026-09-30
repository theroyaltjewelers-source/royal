# ROYAL INTELLIGENCE: IMPLEMENTATION REPORT

*30 September 2026. Branch `feature/intelligence` (commit after `b0d1183`). Every statement here was checked against the code and the test run.*

## 1. Executive summary

ROYAL now has an intelligence layer beside its House skills. It decides whether a request is House state (answered from the calculator with no model), House policy (answered from the House documents with citations), arithmetic (a deterministic calculator), world knowledge, current research, executive or contact research, outreach, or an action that needs approval. Research, people and contact lookups, sending email and realtime voice are fully built but **not configured**: no provider key exists yet, so they report NOT CONFIGURED and have never run against the live services. They were built against the providers' current documentation and tested against fakes that return the documented shapes. An independent security review found fourteen issues and a second pass found nine more; all are fixed and each has a regression test. 175 tests pass.

## 2. Repository findings

See `docs/architecture/CURRENT_INTELLIGENCE_AUDIT.md`. In short: no framework, a fetch-standard handler, Postgres only for the Grok Bot bridge, ROYAL's own passcode auth, a working permission engine, decision service, audit, realm split and composer. External questions were misrouted (prospecting matched the House pipeline; world questions could only be answered from House facts), and nothing existed for research, knowledge retrieval, contacts, planning, tool metadata or observability.

## 3. Architecture before

One `handle()`: rule-based intent, entity resolution against calculator projects, deterministic House skills, and an `open_question` fallback that asked Grok (Chat Completions) to answer from House facts only.

## 4. Architecture after

`handle()` splits by realm (Personal never touches the intelligence layer), resolves House entities, and routes: a sentence naming a House record stays with the House skills; conversational controls (sources, stop, revise, send) act on what is under discussion; everything else goes through the intent engine to a handler in `core/intelligence/index.js`. Every tool call passes the permission gate; anything consequential becomes a Decision; execution is verified and audited; every answer is composed into validated primitives. See `docs/architecture/ROYAL_INTELLIGENCE_ARCHITECTURE.md`.

## 5. Files created

`core/intelligence/`: `index.js`, `intent_engine.js`, `reasoning.js`, `truth.js`, `knowledge.js`, `calc.js`, `jsonschema.js`, `planner.js`, `tools.js`, `agents.js`, `gateway.js`, `comms.js`, `metrics.js`, `research/engine.js`, `research/people.js`, `research/contacts.js`, `research/fetch.js`. `server/intelligence-env.js`. `web/js/realtime.js`, `web/js/pcm-worklet.js`. `tests/intelligence.test.js`. Documents: `CURRENT_INTELLIGENCE_AUDIT`, `ROYAL_INTELLIGENCE_ARCHITECTURE`, `MODEL_PROVIDER_ARCHITECTURE`, `MODEL_ROUTING`, `INTENT_ENGINE`, `CONVERSATION_CONTEXT`, `MEMORY_ARCHITECTURE`, `KNOWLEDGE_ENGINE`, `RESEARCH_ENGINE`, `PEOPLE_COMPANY_RESEARCH`, `TRUTH_AND_PROVENANCE`, `PLANNING_ENGINE`, `TOOL_REGISTRY`, `AGENT_ORCHESTRATION`, `MCP_INTEGRATION_GATEWAY`, `APPROVAL_MODEL`, `SOURCE_REGISTRY`, `PROVIDER_CONFIG`, `OBSERVABILITY`, `TEST_PLAN`, and this report.

## 6. Files modified

`core/royal.js`, `core/context.js`, `core/intent.js`, `core/decisions.js`, `core/permissions.js`, `core/enums.js`, `core/registry.js`, `core/composer.js`, `core/providers/provider.js`, `core/providers/grok.js`, `core/grokbot/bridge.js`, `skills/index.js`, `server/handler.js`, `server/node.js`, `server/deno.js`, `web/js/app.js`, `web/js/primitives.js`, `web/js/schema.js`, `web/css/royal.css`, `tests/server.test.js`, `CLAUDE.md`, and the documents `DECISIONS` (ADR-012), `PERMISSION_MODEL`, `EVENT_MODEL`, `SECURITY_MODEL`, `VOICE_ARCHITECTURE`, `AGENT_ARCHITECTURE`, `MEMORY_MODEL`.

## 7. Database and schema changes

None. Research memory, contacts, agent tasks and conversation context use ROYAL's existing store (memory or JSON file). The Grok Bot bridge's Postgres tables are unchanged. Moving decisions, audit and research memory onto Postgres is the next step for durability on Render.

## 8. Provider architecture

`AIProvider` with capability flags (`complete`, `structured`, `search`, `x_search`, `realtime_voice`, and so on). `GrokProvider` uses xAI Chat Completions for plain completion, the Responses API with strict `json_schema` output and server-side `web_search` / `x_search` tools (citations read from the response), and `POST /v1/realtime/client_secrets` for the browser's short-lived voice token. `ScriptedProvider` is for tests only. See `MODEL_PROVIDER_ARCHITECTURE.md`.

## 9. Reasoning system

Levels 0 to 5 (`reasoning.js`) decide whether a model is used, which tier, whether search is allowed, research depth, token budget and whether a plan is made. Enforced on world and research answers.

## 10. Research system

Server-side search through the provider, citations only from what the provider reported, ROYAL's own fetch of the best sources to confirm values, source-quality scoring, conflict detection, confidence (a report is as strong as its weakest claim), a cache with freshness classes (realtime 5 minutes, role 7 days, contact 30 days, stable a year). `SafeFetcher` blocks private addresses in every notation, re-checks the connected socket, enforces a total deadline and parses HTML in linear time.

## 11. Knowledge system

House documents under `docs/` are chunked by section and policy, with namespace, version, policy status (ACTIVE, NEEDS_TAHIR, SUPERSEDED) and citations. Keyword (BM25) retrieval with a relevance floor. No embeddings. Answers say plainly when a policy is not yet decided.

## 12. People and company research

Company resolution (ambiguity always asked; a domain accepted only if a reported source is on it), role holder research with title classification in code (former, acting, interim, regional, subsidiary, VP Finance and Controller are never read as CFO), and confirmation that the name and title appear together on a page ROYAL fetched.

## 13. Contact and email system

Order: the company's own published page, Hunter Email Finder, Apollo People Enrichment (business email only, `reveal_personal_emails: false`), then Hunter's domain pattern (always labelled PATTERN_INFERRED). Verification by Hunter Email Verifier. Business addresses on the company's domain only; webmail discarded; a 451 opt-out stops every other method. Sending by Resend only after an owner approves the exact message, with an idempotency key, verified only when Resend reports delivery.

## 14. Tool system

`TOOL_POLICY` (authority) plus `TOOL_META` (description, cost, latency, idempotency, audit), served at `/v1/tools` with live statuses: AVAILABLE, CONNECTED, NOT_CONFIGURED, DISABLED, NOT_IMPLEMENTED, APPROVAL_ONLY, PROHIBITED.

## 15. Agent system

Registry with capabilities and health; capability routing (outreach goes to ACE unless Tahir names another); agent tasks with statuses and an overdue mark; structured result contract; least-privilege charters.

## 16. Grok Bot status

The bridge is built (previous branch). Delegation from ROYAL to a Grok Bot goes through the permission gate as `delegate_to_bot`, is audited and tracked as a task, and needs both `advanced_agent_orchestration` and `GROKBOT_ENABLED`. Off by default. Bots reply as records; nothing they say becomes an action.

## 17. MCP and integration status

The Integration Gateway registers each system's entities, reads, writes, events and status. Connected: the Project Calculator (read), email (when configured), Grok Bots (when enabled). NOT CONNECTED: CRM, calendar, Gold Buy, QuickBooks, Jewel360, Instagram/Meta. MCP is NOT IMPLEMENTED: direct adapters were simpler for the systems that exist.

## 18. Project Calculator status

Read-only, push-based (`rtj.house.v1`), refreshed while a signed-in calculator is open. No write tools. Changes publish business events.

## 19. Voice status

Browser speech works everywhere it is supported. Realtime voice (xAI) is built end to end (server token route, WebSocket client, PCM worklet, interruption, the `ask_royal` tool so the voice model never answers on its own), off by default, Business only, and NOT CONFIGURED. It has never run against the live service.

## 20. Permission and approval status

Server-enforced classes and charters. Approval is specific to the exact arguments; a decided decision is never reopened; revising or replacing a draft withdraws its approval; "stop", "cancel that" and "never mind" withdraw every approval the conversation asked for. Silence and speech never approve.

## 21. Security work

Prompt-injection containment (all outside text in a data envelope, never able to pick a recipient, tool or action), SSRF protection, ReDoS-safe parsing, secrets only in the server environment, contact privacy, idempotent sends, realm separation including voice. Two independent reviews; every confirmed finding fixed with a regression test. See `SECURITY_MODEL.md`.

## 22. Tests written

`tests/intelligence.test.js` (48 tests: units for every part, the flagship flows A to H, failure cases, and one test per review finding) and two new handler tests in `tests/server.test.js`. See `TEST_PLAN.md`.

## 23. Test results

175 tests, 175 pass, 0 fail, 0 skipped (with `TEST_DATABASE_URL` and `RTJ_CALCULATOR_DIR`). Without them, 5 are skipped and the rest pass. The flagship flows were also run in a browser at phone and desktop sizes against a scripted provider (screenshots checked; no layout overflow, no console errors).

## 24. Performance

House answers use no model and no network beyond the store. World and research answers depend on the provider (not measured live). Metrics record latency, errors and tokens per provider call, tool and intent at `/v1/developer/metrics`. Hostile HTML parses in under 10 ms where it previously took minutes.

## 25. Configuration and keys still required

`XAI_API_KEY` and `ROYAL_GROK_MODEL` (language, research, realtime voice); `HUNTER_API_KEY` (email finding, verification, patterns); `APOLLO_API_KEY` (optional second finder); `RESEND_API_KEY` and `ROYAL_EMAIL_FROM` (sending). Flags, all off by default: `email_discovery`, `email_verification`, `agent_external_send`, `realtime_voice`, `advanced_agent_orchestration`, `x_search`. See `PROVIDER_CONFIG.md`.

## 26. Real capabilities available now

House state, House policy with citations, arithmetic, conversation context over House records, approvals and cancellation, the Grok Bot bridge, the interface, audit and metrics. With `XAI_API_KEY` set: world questions, current research with sources, executive research, outreach drafting and revision by model.

## 27. Capabilities not yet available

Live research, contact finding, email verification and sending (keys needed); realtime voice (key and flag); CRM record creation (no CRM); calendar; proactive alerts (monitoring off, no scheduler); embeddings; MCP; vision and screen context; bounce webhooks; client-message sending.

## 28. Technical debt

Decisions, audit and research memory are not durable on Render; the planner has templates, not general decomposition; the knowledge engine has no semantic retrieval; two rule layers (`core/intent.js` and `intent_engine.js`) overlap by design; live provider behaviour is unverified until keys exist.

## 29. Next recommended milestone

Set `XAI_API_KEY` and `ROYAL_GROK_MODEL` on Render and run the flagship flows live (CFO of a real public company, a current price, a House policy); then move decisions, audit and research memory to the Postgres database the bridge already uses; then add Hunter and turn on `email_discovery` and `email_verification`; sending last, after a supervised trial.
