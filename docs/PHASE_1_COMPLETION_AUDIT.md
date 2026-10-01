# PHASE 1 COMPLETION AUDIT

*1 October 2026, at the head of `claude/eloquent-carson-rgtnor` (branched from `main` at ef8eb6e). Every finding points at code. Where a finding was fixed in this pass, the fix is named; `PHASE_1_REPAIR_REPORT.md` has the full account. Baseline before this pass: 271 tests, 252 passed, 0 failed, 19 skipped (Postgres tests skip without a database).*

## 1. Current request architecture

(a) **One entry.** `POST /v1/command` (`server/handler.js`) calls `royal.handle()` (`core/royal.js`), which wraps `handleRequest()` in a trace (`core/trace.js`, AsyncLocalStorage): a `run_id` is minted once per turn and every mark, model call and ledger write in the turn carries it. No later layer mints a competing id for the same turn.

(b) **The decision layers, in order, and who owns what:**

| Step | Code | Owns |
|---|---|---|
| Normalise | `normalizeCommand` in `core/royal.js` | realm, modality, conversation id, content limits |
| Realm wall | `handleRequest` | Personal goes to `handlePersonal` and never reads the House |
| Entity | `resolveEntity` in `core/context.js` | the record named, selected, or under discussion (pronoun or attribute follow-up) |
| Fast rules | `interpret` in `core/intent.js` over `route` in `core/router.js` | fast path (greeting, identity, thanks, House words), the team ledger questions, concepts, House skills |
| Intelligence rules | `classifyByRules` in `core/intelligence/intent_engine.js` (`preclassify`) | research, people, contacts, outreach, drafts, cancel, calculation |
| House follow-up | `houseFollowUp` and `FOLLOW_UP` in `core/royal.js` (new) | keeps questions about the record under discussion with the House |
| Model classify | `intelligence.classify` | only for a sentence no rule placed, and only when the answer cannot come from `openQuestion` |
| Execute | a House skill (`skills/index.js`) or `intelligence.handle` (`core/intelligence/index.js`) or `openQuestion` | the answer |
| Compose | `compose` in `core/composer.js` | the presentation spec and the spoken line |

(c) **Duplicated decision layers.** There are two rule interpreters: `core/intent.js` plus `core/router.js` for the House, and `classifyByRules` for the intelligence layer. They do not compete: `handleRequest` consults `preclassify` only after the House rules, and the ordering is explicit in one function. They were not merged in this pass: merging two tested rule sets is a large change with regression risk and no user-visible gain. Recorded as technical debt (section 22).

(d) **Model round trips.** A House question costs zero model calls; an unplaced question costs one (`openQuestion` answers and says itself if it needs the outside world). No path classifies with a model and then answers with another call in series, except a sentence the rules place in neither layer, which `classify` decides once.

## 2. Current voice architecture

(a) Two output paths share one voice (Ara): spoken replies are WAV per sentence from `POST /v1/voice/speak` (`server/handler.js`, `provider.speech` in `core/providers/grok.js`), and realtime voice is the xAI realtime WebSocket (`web/js/realtime.js`) with a token from `POST /v1/voice/session`. Both play through one queue, `Playback` in `web/js/playback.js` (moving cursor, 60 ms lead growing to 240 ms on underruns).

(b) **One intelligence.** Realtime voice has one tool, `ask_royal`, which calls `/v1/command` with modality voice. Identity, context, permissions and specialists are the same as text. The session instructions start with `identityPrompt()` (`voiceSessionConfig` in `server/handler.js`).

(c) **Defects found and fixed.** After a barge-in, audio frames of the cancelled response already in flight were queued and played; a tool answer arriving after Tahir spoke again started a spoken reply over him (`web/js/realtime.js`, `_current`, `turn`).

(d) **Not verified live.** No test here talks to xAI's realtime service; the tests use a stand-in socket. The realtime flag `realtime_voice` is off by default (`core/permissions.js` DEFAULT_FLAGS); the spoken voice is on.

## 3. Current bot architecture

(a) External Grok Bots are reached only through webhooks (`core/grokbot/bridge.js#callWebhook`) and answer by posting events with per-bot tokens (`core/grokbot/tokens.js`). xAI has no Grok Bot API.

(b) **Defect, fixed.** The registry's `status: CONNECTED` meant configured, and two readers treated it as reachable: routed delegation (`adapterFor`, `core/intelligence/agents.js`) and the Send button (`web/js/bots.js`). Replaced by `config_state`, one `connection_state`, `can_send` and `can_receive_tasks` (`publicBotView`, `core/grokbot/bots.js`).

(c) **Defect, fixed.** Any post from a bot after any message made it CONNECTED_VERIFIED, even a post with no `request_id`. Verification now needs a correlated reply within 15 minutes (`postEvent`, `core/grokbot/bridge.js`).

## 4. Current knowledge architecture

(a) `KnowledgeEngine` (`core/intelligence/knowledge.js`) ingests `docs/` at start (`server/intelligence-env.js`): 18 documents, 195 passages here. BM25 with namespaces (`company`, `agents`, `skills`, `training`, `fabric`). House documents outrank the reference (fabric weighted 0.6); House policy questions never fall back to the reference (`HOUSE_NAMESPACES`).

(b) Retrieval is proven by tests for every pack's benchmark questions (`tests/knowledge_fabric.test.js`).

(c) **Defect, fixed.** Question verbs ("makes", "mean") counted as search terms and sank short questions ("What makes an operational bottleneck?" found nothing).

(d) **Gaps.** Knowledge is reloaded only at start; no refresh endpoint. No embeddings; lexical search only.

## 5. Current memory architecture

| Layer | Where | Survives restart |
|---|---|---|
| Working conversation (entity, last items, active draft, research context) | `ConversationContext` in `core/context.js`, process memory, 6 hours | no |
| Native runs in flight | `running` in `core/royal.js` | no (by design) |
| Live operational state | calculator snapshots, `snapshots` kind | yes with `DATABASE_URL` |
| Institutional memory | `docs/` and the knowledge index | yes (files) |
| Research memory | `research`, `contacts` kinds, with expiry | yes with `DATABASE_URL` |
| Decisions, tasks, commitments, waiting, agent ledger | `royal_records` (`core/pgstore.js`) | yes with `DATABASE_URL` |
| Audit and business events | `royal_log`, append-only by trigger | yes with `DATABASE_URL` |
| Bot requests, events, tokens, state | `grokbot_*` tables | yes with `DATABASE_URL` |
| Speech cache, metrics, rate limits | process memory | no (by design) |

The one operational gap is conversation context: an open draft or the record under discussion is lost on restart. Not fixed in this pass (section 21).

## 6. Current research architecture

`ResearchEngine` (`core/intelligence/research/engine.js`) over xAI search, `SafeFetcher` (`research/fetch.js`) for every page read (private, loopback, link-local and metadata addresses refused, including after redirects), cross-checks and conflict detection, cache with expiry. Current tax and law questions go to live research only (`TIME_SENSITIVE_RULE`). Without a provider every research path says NOT CONNECTED. Not run live from here.

## 7. Current tool architecture

Every tool is in `TOOL_POLICY` (`core/permissions.js`) with a class and reversibility, and is called through `ConsequenceGate` (`core/decisions.js`), which audits every call. The catalogue (`core/intelligence/tools.js`) reports each tool's real configuration.

## 8. Current source-of-truth architecture

`SOURCE_REGISTRY.md` and `core/sources.js`: projects, clients, payments and production come from the calculator snapshot; agent activity from the ledger and tasks; business events from the event log; policy from the House documents; current executives and tax from live research. Disagreements between statements of one fact in the snapshot are reported by `core/congruence.js` (RECEIVABLE_MISMATCH, PAYABLE_MISMATCH, PROJECT_BALANCE_MISMATCH, MISSING_CLIENT, POSSIBLE_DUPLICATE_CLIENT) and never resolved silently.

## 9. Current business-data architecture

The calculator pushes snapshots (`POST /v1/ingest/calculator`, contract `rtj.house.v1`, `realms/business/royal-t/contract.js`) while a signed-in calculator is open (ADR-002). Freshness is labelled (`freshness()` in `core/sources.js`); stale data is said to be stale (the digest says when the calculator last reported). The calculator does not send stage timestamps, so waiting times are inferred from the last edit (CLAUDE.md, known issue (c)).

## 10. Current permissions

Server-side only (`core/permissions.js`). Approval is a resolved Decision by an owner (`core/decisions.js`); approving one action does not approve another (decisions carry the exact action and arguments; a modified approval executes the modified arguments; revising a draft withdraws the old approval). Voice cannot approve. Bot events cannot call tools or create decisions.

## 11. Current failure modes

(a) Specialist failure, timeout or malformed result: contained per agent (`consult`, `core/royal.js`), recorded with a reason, and the answer still comes.

(b) Bot webhook failure: recorded, one retry on 5xx and network errors, the task FAILED with `BOT_FAILURE`.

(c) Provider failure: a first-person sentence, nothing invented.

(d) Store write failure in the ledger: never fails the request.

## 12. Current performance

See `PHASE_1_PERFORMANCE_RESULTS.md`. House paths answer in under 13 ms at p95 against Postgres with no model call. Model paths were not measurable here.

## 13. Known production errors

The production log could not be read from this environment. The causes found in code are in `FRONTEND_ENDPOINT_MATRIX.md`: HEAD on the page (404), iOS icons (404), wrong-method requests answered 404 instead of 405, bot routes with the wrong method (405), and bot events in the wrong shape (400). From this deploy every request is logged as a `ROYAL_ACCESS` line.

## 14. Duplicated logic

(a) Two rule interpreters (section 1 (c)).
(b) Status words: `CONNECTION` (`core/enums.js`) is used for providers and domains; bots now have their own `CONNECTION_STATES` (`core/grokbot/bots.js`). Kept apart on purpose: a domain is connected or not; a bot's reachability has nine evidence-based states.
(c) `web/js/bots.js` keeps a copy of the bot state labels for display only. It no longer decides anything from them.

## 15. Dead logic

(a) The registry `status` field (`CONNECTED`, `NOT_CONNECTED`) for bots: removed.
(b) `CANCEL_REASON` spellings `BARGE_IN_REPLACED_REQUEST`, `SYSTEM_SHUTDOWN` and `UNKNOWN`: kept only so stored records still read; new code uses `USER_BARGE_IN`, `SERVER_SHUTDOWN`, `UNKNOWN_SYSTEM_CANCEL`.

## 16. Stale logic

`AGENT_ORCHESTRATION.md` said WAITING and VERIFIED_COMPLETE were never set, `current_task` was always null, and a filled-in agent was "named by Tahir". All four were true at the start of this pass and are now fixed in code and in the document.

## 17. Partially implemented logic

(a) VERIFIED_COMPLETE for Grok Bot tasks: a bot's report stays REPORTED_COMPLETE; there is no check ROYAL can make of an external bot's claimed work yet.
(b) Business analytics over time (cycle time, vendor lateness, conversion): the calculator sends no history, so only point-in-time analysis exists (`cash_analysis`, congruence).
(c) Root-cause analysis: "why" questions about a project list the recorded blockers; there is no general timeline-and-hypothesis engine.

## 18. Fake or unverified connectivity

None claimed. The tool catalogue and the gateway's bot adapter report the bridge as present when it exists, which is the bridge, not any bot; each bot's own state is evidence-based. Production round trips with Tahir's bots, xAI and realtime voice were not verified from here.

## 19. Mock-only functionality

`ScriptedProvider` and fixtures live under `tests/` and `core/providers/provider.js` (ScriptedProvider for tests); production builds `GrokProvider` or `UnavailableProvider` only (`server/node.js`). No fake search, fake bot or placeholder record is reachable from a production path.

## 20. Data durability

With `DATABASE_URL`, everything operational survives a restart (section 5). Proven by the Postgres tests (a Decision survives a restart; events, requests and tokens survive a restart; boot reports DURABLE), run here against PostgreSQL 16. Whether production has `DATABASE_URL` set is checked by `npm run phase1:verify` (LIVE_DURABILITY).

## 21. Database state

Migrations: `001_grokbot.sql`, `002_royal_store.sql`, and new `003_bot_verification.sql` (additive columns; one wider status check), each with a hand-run rollback. Applied in order at start unless `ROYAL_AUTO_MIGRATE=false`. Tested on a disposable local database.

## 22. Deployment state

Render service `royal`, branch `main`, start command `node server/node.js`. No health check path is configured. `/v1/health` is a pure liveness check (no provider, store or bot), so it is safe to set as Render's health check path: Settings, Health Check Path, `/v1/health`. This cannot be set from the repository: the service is not a Render Blueprint, and adding a `render.yaml` would not change it.

## 23. Security findings

(a) **Fixed, high.** The sign-in rate limit keyed on the first `X-Forwarded-For` entry, which the client writes: a new invented address per try made passcode guessing unlimited; and past 1000 tracked addresses every count was cleared. Now the proxy's entry, expired entries only are forgotten, and a global pause after 30 wrong passcodes in 15 minutes.
(b) Checked, no change: bot markdown is escaped before links are formed, and only http(s) links are made (`web/js/markdown.js`); SQL is parameterised throughout (`core/pgstore.js`, `core/grokbot/store.js`); `SafeFetcher` refuses private and metadata addresses after redirects; webhook URLs and keys never leave the bridge (tested); the CSP forbids inline script and style (tested); research text reaches a model only inside `<data>` with the UNTRUSTED notice (tested).
(c) Open, low: session tokens cannot be revoked before expiry except by rotating `ROYAL_SESSION_SECRET`.

## 24. Technical debt

(a) Two rule interpreters (section 1 (c)).
(b) Conversation context in process memory (section 5).
(c) `core/royal.js` and `skills/index.js` are large single files.
(d) No streaming of model text to the screen (CLAUDE.md, known issue (e)).

## 25. Critical Phase 1 blockers

(a) **Production verification not done.** Every production gate (health, durability, bot states, the each-bot question, the voice, the page's routes) needs `npm run phase1:verify` against the live server, which this environment cannot reach.
(b) **No verified round trip with a real Grok Bot.** Needs Tahir's bots and their webhooks.
(c) **Live xAI paths unmeasured** (first token, first audio, research). Needs `npm run bench` against production.

Nothing else found blocks Phase 1. The automated gates all pass (`npm run phase1:verify`, 17 of 17 with Postgres).
