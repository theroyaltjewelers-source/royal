# PHASE 1 REPAIR REPORT

*1 October 2026. Branch `claude/eloquent-carson-rgtnor`, from `main` at ef8eb6e. Companion documents: `PHASE_1_COMPLETION_AUDIT.md` (findings with code pointers), `PHASE_1_PERFORMANCE_RESULTS.md`, `PHASE_1_ACCEPTANCE_RESULTS.md`, `FRONTEND_ENDPOINT_MATRIX.md`, `ENVIRONMENT_MATRIX.md`.*

## Phase 1 readiness

**PHASE 1 NOT READY.** Every automated gate passes (17 of 17, `npm run phase1:verify` with Postgres). The six production gates were not run: this environment's network policy refuses the production server and xAI (CONNECT 403). The blockers are exactly these:

(a) Run `ROYAL_URL=https://royal-1wx5.onrender.com ROYAL_TOKEN=<session token> npm run phase1:verify` after this is deployed, and get LIVE_HEALTH, LIVE_DURABILITY, LIVE_BOT, LIVE_MULTI_AGENT, LIVE_VOICE and LIVE_ERROR to pass.

(b) Verify one real Grok Bot round trip (Bots, the bot, Check connection, until it shows "Connected, verified").

(c) Measure the live model paths with `npm run bench` against production.

When (a) to (c) pass, the gate prints PHASE 1 READY.

## Initial production state

Render service `royal` on `main`, no health check path configured, 400, 404 and 405 responses seen during testing (reported in the brief). The production log and settings were not readable from here.

## Root causes found in this pass

(a) **Bot state was configuration, read as connection.** `status: CONNECTED` meant "has a webhook address and key"; delegation and the Send button trusted it.

(b) **Verification without correlation.** Any bot post after any message verified the bot.

(c) **Agent task states with no code path.** WAITING and VERIFIED_COMPLETE were never set; native specialist runs left no task; `/v1/agents` always said `current_task: null`; a filled-in agent was recorded as "named by Tahir".

(d) **Routes.** HEAD on the page was 404; iOS icon requests were 404; wrong-method requests on known routes were 404 instead of 405; no request log existed to trace any of it.

(e) **Conversation.** Project answers did not name the piece; follow-ups about the record under discussion went to world knowledge without the record; "What's the balance?" after a project got a textbook answer; "What happened today?" ignored everything except snapshot differences.

(f) **Knowledge.** Question verbs counted as search terms.

(g) **Voice.** Audio of an interrupted reply still in flight was played after a barge-in; an answer arriving after Tahir spoke again was spoken over him.

(h) **Security.** The sign-in rate limit trusted the client's own `X-Forwarded-For` entry.

## Request architecture before and after

Before: the same pipeline as after, with three gaps. Follow-ups without a pronoun fell to world knowledge; concept-shaped follow-ups ("What's the financial impact?") went to the reference; and an unplaced sentence about a record under discussion got the project card instead of an answer.

After: one function, `handleRequest` in `core/royal.js`, owns the order (audit section 1). Additions: `houseFollowUp` and `FOLLOW_UP` keep follow-ups with the House; `ENTITY_FOLLOW_UP` sends an unplaced question about the record to `openQuestion` when a provider is connected, and `openQuestion` gives the model that record's facts first. Without a provider the record itself is still the answer.

## Routing changes

(a) `daily_digest` rule before `what_changed` (`core/router.js`): "what happened today", "recap", "how did today go".
(b) `ABOUT_ENTITY` adds "stage", "balance", "what happened with".
(c) Attribute follow-ups resolve to the record under discussion (`ATTRIBUTE_FOLLOW_UP`, `core/context.js`).
(d) Provenance on every agent route (`ROUTE_PROVENANCE`, `core/enums.js`).

## Files

**Modified:** `core/grokbot/bots.js`, `core/grokbot/bridge.js`, `core/grokbot/store.js`, `core/intelligence/agents.js`, `core/intelligence/index.js`, `core/intelligence/knowledge.js`, `core/agent_ledger.js`, `core/enums.js`, `core/royal.js`, `core/router.js`, `core/context.js`, `skills/index.js`, `server/handler.js`, `server/node.js`, `server/passcode.js`, `web/js/bots.js`, `web/js/realtime.js`, `web/css/royal.css`, `web/index.html`, `docs/knowledge/coo.md`, `docs/architecture/AGENT_ORCHESTRATION.md`, `docs/architecture/ROYAL_GROK_BOT_CONNECTIVITY.md`, `CLAUDE.md`, `package.json`, `tests/grokbot.test.js`, `tests/multiagent.test.js`, `tests/server.test.js`, `tests/store.test.js`.

**Created:** `server/migrations/003_bot_verification.sql` and `.down.sql`, `server/phase1-verify.js`, `tests/phase1.test.js`, `web/apple-touch-icon.png`, `web/robots.txt`, `.env.example`, and the six Phase 1 documents.

**Removed:** nothing.

## Database migrations

`003_bot_verification.sql`: adds `last_verified_at`, `last_roundtrip_ms`, `last_failure_at`, `pending_verify_at`, `recent_outcomes` to `grokbot_bot_state`; widens the `grokbot_requests` status check to allow `waiting`. Additive; existing rows read as unverified. Rollback in `003_bot_verification.down.sql` (run by hand). Tested on a disposable PostgreSQL 16 database; applies once and a second start changes nothing.

## Bot, model and agent architecture

(a) **Grok model** (`GrokProvider`, `core/providers/grok.js`): language, research, spoken voice, realtime voice. Not a bot.
(b) **Native specialists** (`realms/business/royal-t/specialists.js`): ACE, GRACE, LEDGER, FORGE run inside ROYAL over the House's data. Adapter `native`.
(c) **Durable Grok Bots** (`core/grokbot/`): external assistants reached by webhook. Adapter `grokbot`. Routed work only with a verified round trip; explicit delegation when configured.
(d) **Stable identity**: an AgentTask records `agent` and `adapter`; GRACE is GRACE whichever ran the work.

| Agent | Native runtime | Durable bot | Status after this pass |
|---|---|---|---|
| ACE | yes: leads, pipeline, outreach | if configured | native verified by tests; bot unverified live |
| GRACE | yes: production, waiting, commitments | if configured | native verified by tests; bot unverified live |
| LEDGER | yes: receivables, cash, leakage | none by default | native verified by tests |
| HOUSE | none | if configured | NOT CONNECTED natively; said plainly, never shown as working |
| FORGE | yes: systems and data health | none by default | native verified by tests; reads ROYAL's own diagnostics |

## Agent activity ledger and agent tasks

(a) Every native run writes the ledger rollup and, now, an AgentTask (`adapter: native`) in a bounded ring of 20 per agent. OK runs are VERIFIED_COMPLETE (`verification_state: VERIFIED_INTERNAL`): I ran them on the calculator's data and validated the result.
(b) Every task status is reachable by code, and a test fails if one is not.
(c) `/v1/agents` returns `current_task` (runs in flight, then open delegations), `active_count` and `last_task`.
(d) The daily review counts native runs once (ledger) and bot tasks separately.

## Bot connection verification

See `ROYAL_GROK_BOT_CONNECTIVITY.md` section 7. One state; verification needs the bot's own token, the `request_id` ROYAL sent, and an answer within 15 minutes; VERIFYING while a check is pending; evidence stored (round trip time, last failure, success rate over the last 20 deliveries).

## Multi-bot cancellation

**Root cause (fixed in the earlier pass, re-verified here).** "Tell me what each Bot did for work today" was routed to web research because of "today"; a bare "stop" cancelled every delegated task; the page dropped a second question while one was running; the realtime voice could wait forever; skills crashed on a specialist's missing data.

**Fix, and what this pass adds.** The question is answered from the ledger, tasks and bot feeds (`agent_activity`), each agent read on its own, with no model. Fan-out is fault-isolated (`Promise.allSettled`, per-agent deadline, reason per failure). This pass adds typed task outcomes (TIMED_OUT with AGENT_TIMEOUT is never USER_CANCELLED), the expanded `CANCEL_REASON` set (USER_BARGE_IN, REQUEST_REPLACED, AGENT_TIMEOUT, PROVIDER_TIMEOUT, REALM_SWITCH, AUTH_EXPIRED, SERVER_SHUTDOWN and the rest), and "Why didn't GRACE finish that?" answered with the recorded reason. The stress test (20 mixed requests at once, with a timeout, a malformed result and a failing bot) passes.

## Context, memory, knowledge and business intelligence

(a) Context: attribute follow-ups, House follow-ups with the record given to the model, named project answers.
(b) Memory: unchanged; conversation context is still process memory (audit section 5).
(c) Knowledge: question verbs are stop words; the COO pack names operational bottlenecks.
(d) Business intelligence: the daily House digest from events, decisions, the ledger and calculator freshness. Trend analytics remain blocked on history the calculator does not send.

## Research status

Unchanged in code; routing, cross-checking, prompt-injection containment and the approval chain pass with a stand-in xAI. Not run live.

## Voice

**Root causes:** late frames of a cancelled reply were queued; stale tool answers were spoken over a new turn. **Fixes:** `_current()` drops frames not of the current response (and counts them in `dropped`); a tool answer after a new turn closes the call without `response.create`. **Underruns:** the queue's own test (underrun counted, lead grows 60 to at most 240 ms) passes; live underrun counts must be read on Tahir's phone (`stats` on the voice line in Systems). **Barge-in:** stops queued audio at once, cancels the provider response, drops late audio; tested with a stand-in socket, not against xAI.

## Performance before and after

See `PHASE_1_PERFORMANCE_RESULTS.md`. House paths: under 13 ms p95 with Postgres, zero model calls. Model calls per request unchanged by this pass except follow-ups about a record, which now cost one call with the record instead of one world-knowledge call without it.

## 400, 404 and 405 root causes

See `FRONTEND_ENDPOINT_MATRIX.md`, "Known causes". Fixed: HEAD 404, icon 404s, wrong-method 404 now 405 with Allow. Explained and kept: input validation 400s; bot-route 405s from manual or bot calls. From this deploy every one is logged as a `ROYAL_ACCESS` line.

## Production errors remaining

Unknown until the access log is read after deploy.

## Health check status

`/v1/health` is liveness only (now with `uptime_s`) and answers HEAD. Set it in Render: Settings, Health Check Path, `/v1/health`. Deep state stays behind sign-in ("diagnose yourself", `/v1/status`).

## Security findings and fixes

Fixed: the sign-in rate limit bypass (audit section 23 (a)). Checked with no change needed: markdown, SQL, SSRF, secrets, CSP, prompt injection. Open, low: session tokens cannot be revoked early except by rotating `ROYAL_SESSION_SECRET`.

## Tests

Added `tests/phase1.test.js`, 23 tests: the route contract from the page's own source, 405 and HEAD, the access log (no secrets), liveness, `canSendTo`, no old status reads, native tasks, TIMED_OUT, current work in `/v1/agents`, the bounded ring, provenance, WAITING and REPORTED_COMPLETE, every task state reachable, named project answers, House follow-ups with the record, the daily digest, why GRACE didn't finish, barge-in late audio, stale spoken answers, the rate limit, the balance follow-up, the bottleneck search. Updated bot tests for the new contract and correlated verification.

**Totals:** 294 tests (271 at the start of the pass). Without a database: 275 pass, 0 fail, 19 skip (the Postgres tests and the two calculator-checkout tests). With `TEST_DATABASE_URL` against PostgreSQL 16: 292 pass, 0 fail, 2 skip (the two tests that need a calculator checkout, `RTJ_CALCULATOR_DIR`).

## Production smoke test results

Not run: the production server is unreachable from this environment. The same live checks were run against a local production-shaped server (Node, Postgres, a configured bot): LIVE_HEALTH, LIVE_DURABILITY, LIVE_BOT, LIVE_MULTI_AGENT and LIVE_ERROR passed; LIVE_VOICE failed as it should without an xAI key.

## Known limitations and unconfigured providers

Web research, people research and voice need `XAI_API_KEY` (reported configured). Email discovery and sending need Hunter, Apollo and Resend keys plus flags (off). HOUSE has no native runtime. Personal-realm connectors do not exist. Stage timestamps are not sent by the calculator.

## Technical debt

Two rule interpreters; conversation context in memory; large single files; no text streaming. See the audit, section 24.
