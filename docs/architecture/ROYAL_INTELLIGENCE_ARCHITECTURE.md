# ROYAL INTELLIGENCE ARCHITECTURE

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

This is the overview of the intelligence layer: the part of ROYAL that answers what the deterministic House skills do not (world knowledge, current research, executive and contact research, House knowledge, arithmetic, outreach drafting, revision and sending through approval, sources, cancellation, prospecting and delegation to external Grok Bots). The companion documents go deeper: `MODEL_PROVIDER_ARCHITECTURE.md`, `MODEL_ROUTING.md`, `INTENT_ENGINE.md`, `CONVERSATION_CONTEXT.md`, `MEMORY_ARCHITECTURE.md` and `PLANNING_ENGINE.md`.

The layer is built by `createIntelligence()` in `core/intelligence/index.js` and wired into the orchestrator by `createRoyal()` in `core/royal.js`. Every handler returns the same shape as a House skill: `{ status, summary, findings, surface, context, delegations }`, where `context` is a patch to the conversation's active context.

## 1. How a request flows

Every command enters `handle()` in `core/royal.js`.

(a) **Normalise.** `normalizeCommand()` clips content to 2,000 characters, checks modality and realm, and defaults the conversation id to `default`.

(b) **Realm split.** A `PERSONAL` command goes to `handlePersonal()` and never reaches the intelligence layer, a business connector or a business specialist. Conversations are keyed `REALM:conversation_id`, so the two realms never share context.

(c) **Entity resolution.** `resolveEntity()` in `core/context.js` resolves a House record from the selection, a `PRJ-` id, names, or a pronoun plus the conversation's last entity.

(d) **House fast path.** `interpret()` in `core/intent.js` (control verbs, delegation, entity follow-ups) and `route()` in `core/router.js` (ordered regular expressions) pick a House skill. These are deterministic and need no model.

(e) **Intelligence classification.** Unless the command named a skill, `intelligence.preclassify()` (the rules in `classifyByRules()`) runs on every command. The order in which it wins over the House path is described in `INTENT_ENGINE.md` section 5. In short: a sentence that names a House record itself stays with the House skills, except for the conversational controls (sources, cancel, revise); a record only carried from the conversation does not keep the early intelligence intents away. Only when the House router falls through to `open_question` is the model interpreter `intelligence.classify()` called. A chosen intelligence intent is audited as `INTENT_CLASSIFIED`.

(f) **Clarify before acting.** An `AMBIGUOUS` House entity (for entity skills or `open_question`) returns `NEEDS_CLARIFICATION`; a `PRJ-` id that is not in the snapshot returns a plain "not in the records" answer. Both are checked before the intelligence layer runs.

(g) **Dispatch.** `intelligence.handle()` computes the reasoning policy (`reasoningPolicy()` in `reasoning.js`, see `MODEL_ROUTING.md`) and switches on the intent to one handler (section 3). `doWorld()` enforces the policy: it reads `use_model`, `model_tier`, `allow_search`, `max_tokens` and `research_depth`. If `handle()` returns `null` (an intent it does not handle), ROYAL falls back to `openQuestion()`.

(h) **Permission gate.** Handlers that produce or cause something go through `ConsequenceGate.request()` in `core/decisions.js`, which calls `PermissionService.check()` in `core/permissions.js`. Today that is `draft_email` (class DRAFT, runs; the writer chosen by `routeAgents()`), `delegate_to_bot` (class DRAFT, runs, audited as a tool call) and `send_email` (class APPROVAL_REQUIRED, becomes a Decision). Research, people and contact lookups are called directly on their engines, not through the gate; they are gated only by flags and configuration.

(i) **Decisions and execution.** A send becomes a Decision (`DecisionService.create()`, deduplicated by `dedupe_key: "email:" + hash`). A Decision already approved or carried out is never reopened, so an email is never sent twice; a refused one can be asked again under a new id. Before raising one, `doSend()` asks when two messages are open or the draft is for someone other than the person under discussion. "Stop" and the other bare cancellations withdraw every open Decision the conversation raised (`APPROVAL_MODEL.md`). Only an owner can resolve a Decision (`DecisionService.resolve()`). On APPROVE or MODIFY, `_execute()` runs the registered executor. `send_email` has an executor only when `agent_external_send` is on and an email provider is configured (`core/royal.js`, `emailExecutor()` in `comms.js`); otherwise execution records `NO_EXECUTOR` and nothing is sent.

(j) **Verification.** An executor may return `verify()`. For email it reads the message back from Resend (`GET /emails/{id}`): `last_event` "delivered" marks the Decision `VERIFIED`; bounced, failed or complained marks it `FAILED`; anything else, or an unreadable reply, leaves it `EXECUTED` (accepted, not yet confirmed). `royal.resolveDecision` then publishes `MESSAGE_SENT` or `MESSAGE_FAILED`. Bounce webhooks are NOT IMPLEMENTED.

(k) **Context update.** `conversations.set()` merges the handler's `context` patch (active person, company, draft, research, focus, goal). See `CONVERSATION_CONTEXT.md`.

(l) **Composer and audit.** `attachPresentation()` calls `compose()` in `core/composer.js`; rejected primitives are dropped and audited as `COMPOSER_REJECTED`. The result carries `skill: "intel:<intent>"`, `route.reason` (`MODEL` or `RULES`), `intent` and `reasoning`. Every answer is audited as `COMMAND_ANSWERED`. Research runs and contact lookups also write `RESEARCH_RUN` and `CONTACT_RESEARCH`.

## 2. Knowledge priority as implemented

`core/intelligence/truth.js` declares the priority order in `PRIORITY` and exposes `rank()`. Nothing calls `rank()`: the order is enforced by routing, not by merging answers. In practice it works like this.

| Order | Source | Where | Label on the answer |
|---|---|---|---|
| 1 | Live House data from the calculator | House skills via `skills/index.js`; chosen first whenever a House rule or a strong House entity matches | `VERIFIED` with the calculator's `verified_at` |
| 2 | House documents | `doKnowledge()` over `KnowledgeEngine.search()` | `VERIFIED_INTERNAL` for the passage; `INFERENCE` when a model wrote the summary; policies not marked ACTIVE are reported as not decided |
| 3 | Fresh external research | `doResearch()`, `doPeople()`, `doProspecting()` through `ResearchEngine` | `VERIFIED_EXTERNAL` only when ROYAL fetched a source of quality 4 or 5 and found the value in it; otherwise `REPORTED_UNVERIFIED` |
| 4 | Model background knowledge | `doWorld()` for non-current world questions | `MODEL_KNOWLEDGE`, with the note that it was not checked |
| 5 | Inference over labelled House facts | `openQuestion()` in `core/royal.js` | `INFERENCE` when it cites facts, else `UNKNOWN` |
| 6 | Unknown | Any handler without a source | NOT_CONNECTED, NOT_FOUND or "I won't guess" |

Three rules follow from `doWorld()`. (a) A question that needs current information (`intent.needs_current_web` or intent `current_research`) is never answered from model knowledge: without research it returns NOT_CONNECTED. Current questions run STANDARD research, with up to two verification fetches. (b) A stable world question goes to the model first, when the policy's `use_model` allows it, and falls back to research only if the model call fails and the policy's `allow_search` allows it. (c) With no connected model, a stable world question goes to research when research is connected, without consulting `allow_search`.

## 3. Module map

| Module | File | What it does |
|---|---|---|
| Dispatcher | `core/intelligence/index.js` | `createIntelligence()`: handlers per intent, `handle()`, `status()`, tool implementations for the gate |
| Intent engine | `core/intelligence/intent_engine.js` | `INTENTS`, `INTENT_SCHEMA`, `classifyByRules()`, `classify()` |
| Reasoning router | `core/intelligence/reasoning.js` | `reasoningPolicy()`: level 0 to 5 and derived limits |
| Truth | `core/intelligence/truth.js` | Claims, conflicts, source quality, confidence, freshness classes and TTLs |
| House knowledge | `core/intelligence/knowledge.js` | `KnowledgeEngine`: Markdown chunking, BM25 search, policy status |
| Calculator | `core/intelligence/calc.js` | Recursive-descent arithmetic; `calculate()`, `looksArithmetic()` |
| Schema check | `core/intelligence/jsonschema.js` | Strict JSON Schema subset; `S` builders; `check()` |
| Planner | `core/intelligence/planner.js` | Plan templates, `validatePlan()`, `annotate()`, `planFor()` |
| Tool registry | `core/intelligence/tools.js` | `TOOL_META` and `toolCatalog()`; descriptive only |
| Agents | `core/intelligence/agents.js` | `routeAgents()` (used by `doOutreach()`), `AgentTasks` (with `overdue`), `GrokBotAdapter` |
| Gateway | `core/intelligence/gateway.js` | `IntegrationGateway` and `defaultGateway()` adapters |
| Email | `core/intelligence/comms.js` | `ResendEmailProvider`, `emailExecutor()`, `emailHash()` |
| Metrics | `core/intelligence/metrics.js` | Latency, counts, errors, tokens; `GET /v1/developer/metrics` |
| Research | `core/intelligence/research/engine.js` | `ResearchEngine`: search, source filtering, cross-check, conflicts, cache |
| People | `core/intelligence/research/people.js` | `ExecutiveResearch`: company resolution, role holder, `classifyTitle()` |
| Contacts | `core/intelligence/research/contacts.js` | `ContactResearch`, `HunterProvider`, `ApolloProvider` |
| Fetching | `core/intelligence/research/fetch.js` | `SafeFetcher`: SSRF-guarded page fetch, `htmlToText()` |
| Provider | `core/providers/provider.js`, `core/providers/grok.js` | `AIProvider` interface, `GrokProvider`, `ScriptedProvider` |
| Server wiring | `server/intelligence-env.js`, `server/handler.js` | Builds knowledge, fetcher, Hunter, Apollo, Resend, metrics; intelligence routes |
| Voice client | `web/js/realtime.js` | Realtime voice over xAI's WebSocket, with one tool, `ask_royal` |

The handlers in `index.js` are `doCalculation`, `doKnowledge`, `doWorld` (world, current and company research), `doResearch`, `doPeople`, `doContact`, `doOutreach` (with `draftOutreach`), `doRevise`, `doSend`, `doSources`, `doCancel`, `doProspecting` and `doBotDelegation`.

## 4. Server routes added

`server/handler.js` adds, for a signed-in owner: `GET /v1/intelligence/status`, `GET /v1/tools`, `GET /v1/agents/tasks`, `GET /v1/developer/metrics`, `GET /v1/knowledge/search` and `POST /v1/voice/session` (Business realm only; `realm=PERSONAL` gets 409 `VOICE_BUSINESS_ONLY`). All six are called through the handler in `tests/server.test.js`. Both entries call `intelligenceFromEnv()`: `server/node.js` and `server/deno.js` build the same parts (House knowledge, the safe fetcher, Hunter, Apollo, Resend, metrics) and pass them, with the Grok Bot bridge, to `createRoyal()`; the Deno entry also passes the fast and voice model settings to `GrokProvider`. The Deno entry still keeps ROYAL's store and the bridge in memory.

## 5. What is not built

(a) **Live provider calls.** No `XAI_API_KEY`, `HUNTER_API_KEY`, `APOLLO_API_KEY` or `RESEND_API_KEY` exists in this environment. The xAI, Hunter, Apollo and Resend adapters are tested only against recorded-shape fakes in `tests/intelligence.test.js`.

(b) **General agent routing.** `routeAgents()` chooses the outreach writer in `doOutreach()`. It is not used to route any other request; Grok Bot delegation happens only through the House `delegate_draft` path when the named agent is not ACTIVE. NOT IMPLEMENTED as general routing.

(c) **Model-proposed plans.** `planner.js` only has templates; only `doProspecting()` calls `planFor()`. NOT IMPLEMENTED: plan execution, model plans, the executive-contact and outreach templates in the live path.

(d) **CRM, calendar, Gold Buy, QuickBooks, Jewel360, Instagram.** Registered in `defaultGateway()` as NOT_CONNECTED placeholders. `create_crm_lead` has no executor.

(e) **`email_verify` and `x_search` as gate tools.** They have policy and metadata, but no entry in `toolImpls`; verification runs only inside `ContactResearch.businessEmail()`, and X search only as a flag on research. The tool catalogue says so with `runs_inside`.

(f) **Semantic retrieval.** Knowledge search is BM25 keyword ranking; `embeddings` is `false` on every provider.

(g) **Persistence of conversation context.** In process only (see `MEMORY_ARCHITECTURE.md`).

## Status

As of 30 September 2026, after the independent security review and its fixes. 175 tests pass (with Postgres and a calculator checkout). "NOT CONFIGURED" means the code is built and tested against recorded-shape fakes of the provider's documented API, but no key is set, so it has never run against the live service.

| Capability | Status | Notes |
|---|---|---|
| Model provider abstraction | IMPLEMENTED | `core/providers/provider.js`; `GrokProvider` NOT CONFIGURED until `XAI_API_KEY` and `ROYAL_GROK_MODEL` are set |
| Reasoning router | PARTIAL | Levels 0 to 5 as a policy (`reasoning.js`); enforced on world and research answers; House skills need no model |
| Intent Engine | IMPLEMENTED | Schema-validated model interpretation when a model is configured; deterministic rules otherwise |
| Conversation Context | IMPLEMENTED | Person, company, project, draft, research, open approvals; consequential ambiguity asks |
| Memory architecture | PARTIAL | Working and research memory live in the store, which is not durable on Render without a disk or database |
| House Knowledge Engine | PARTIAL | Keyword (BM25) retrieval over `docs/` with policy status and citations; no embeddings |
| Web Research Engine | IMPLEMENTED, NOT CONFIGURED | xAI server-side `web_search` / `x_search`; cross-checking with a hardened fetcher; cache with freshness classes |
| Company Research | IMPLEMENTED, NOT CONFIGURED | Needs web research |
| People Research | IMPLEMENTED, NOT CONFIGURED | Role classification in code; name and title confirmed together |
| Contact Research interface | IMPLEMENTED, NOT CONFIGURED | Public page, Hunter, Apollo, pattern (labelled); `HUNTER_API_KEY`, `APOLLO_API_KEY`; flags off by default |
| Email Verification interface | IMPLEMENTED, NOT CONFIGURED | Hunter Email Verifier; `email_verification` flag off by default |
| Truth / provenance | IMPLEMENTED | Labels, claims, conflicts, source quality; pattern-inferred never verified |
| Planning Engine | PARTIAL | Validated templates (prospecting in use); no general goal decomposition |
| Tool Registry | IMPLEMENTED | `/v1/tools`; honest statuses (AVAILABLE, NOT_CONFIGURED, APPROVAL_ONLY, NOT_IMPLEMENTED, PROHIBITED) |
| Agent Registry | IMPLEMENTED | `/v1/agents` with capabilities and health |
| Agent Router | PARTIAL | Capability routing for outreach and Grok Bot delegation; House specialists are consulted by the House skills |
| Grok Bot adapter | IMPLEMENTED, off by default | Through the permission gate; `advanced_agent_orchestration` and `GROKBOT_ENABLED` both needed |
| Integration Gateway | PARTIAL | Entities, reads, writes and events per system; calculator connected; CRM, calendar, Gold Buy, QuickBooks, Jewel360, Instagram NOT CONNECTED; MCP NOT IMPLEMENTED |
| Project Calculator adapter | PARTIAL | Read-only, push-based House API; no writes |
| Permissions | IMPLEMENTED | Server-enforced, per agent charter |
| Approvals | IMPLEMENTED | Specific to exact arguments; never reopened once decided; "stop" withdraws |
| Action execution | PARTIAL | Email through Resend when `agent_external_send`, `RESEND_API_KEY`, `ROYAL_EMAIL_FROM` are set (NOT CONFIGURED); client messages have no executor |
| Action verification | PARTIAL | Email read back from Resend (delivered only counts); no bounce webhook |
| Realtime voice | IMPLEMENTED, NOT CONFIGURED | xAI ephemeral token route and client; off by default (`realtime_voice`); never run live |
| Voice interruption | PARTIAL | Browser barge-in works; realtime cancel on speech is built but untested live |
| UI integration | IMPLEMENTED | New primitives for people, research, sources, prospects, knowledge, drafts |
| Event architecture | PARTIAL | Calculator changes, snapshots and message outcomes are published; proactive monitoring off; no scheduler |
| Audit | IMPLEMENTED | Every tool call, decision, research run and send |
| Observability | PARTIAL | In-memory latency, error and token metrics at `/v1/developer/metrics`; no cost accounting, no persistence |
| Security | IMPLEMENTED | Reviewed twice; findings fixed and covered by tests (see `SECURITY_MODEL.md`) |
| Tests | IMPLEMENTED | 175 passing; see `TEST_PLAN.md` |
