# OBSERVABILITY

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

ROYAL has two developer views: the audit log (what happened, and who did it) and metrics (how long it took, how often it failed, how many tokens it used). Neither reaches Tahir's executive interface. Both are behind owner sign-in.

## 1. Metrics

`Metrics` in `core/intelligence/metrics.js` is a small in-process recorder.

(a) `observe(name, ms, { ok, tokens })` adds a sample to a named series: count, error count, token total, and the last 500 latency samples (`max`, the oldest dropped first).

(b) `count(name, by)` increments a named counter.

(c) `snapshot()` returns `{ since, series: { <name>: { count, errors, tokens, p50_ms, p95_ms } }, counters }`. Percentiles are computed over the retained samples only; counts and token totals are cumulative since start.

(d) It holds names, numbers and outcomes. It never holds content, arguments, addresses or keys.

One `Metrics` object is created in `server/intelligence-env.js`, which both the Node entry and the Deno entry now call, and passed to `createRoyal`, `GrokProvider`, `SafeFetcher`, `HunterProvider`, `ApolloProvider` and `ResendEmailProvider`. Without it (for example in most tests) nothing is recorded and every `observe` call is skipped.

## 2. What Is Recorded

| Series or counter | Recorded in | Meaning |
|---|---|---|
| `provider.complete` | `core/providers/grok.js#_metric` | xAI chat completion latency, success, tokens |
| `provider.structured`, `provider.search`, `provider.respond` | `core/providers/grok.js#_metric` | xAI Responses API calls: with a schema, with the search tools, or plain; latency, success, tokens |
| `intent.model` | `core/intelligence/intent_engine.js#classify` | Model intent classification latency and whether it returned a valid result |
| `intent.<intent>` | `core/intelligence/index.js#handle` | Latency of each intelligence handler (`intent.people_research`, `intent.send`, and so on); an error is a missing result or status FAILED |
| `route.level.<n>` (counter) | `core/intelligence/index.js#handle` | How often each reasoning level (0 to 5, `core/intelligence/reasoning.js`) was chosen |
| `tool.web_fetch` | `core/intelligence/research/fetch.js#SafeFetcher._done` | Page fetch latency and success, including refusals |
| `provider.hunter.<path>` | `core/intelligence/research/contacts.js` | Hunter calls (email-finder, email-verifier, domain-search) |
| `provider.apollo.match` | `core/intelligence/research/contacts.js` | Apollo people match |
| `provider.resend.send` | `core/intelligence/comms.js#ResendEmailProvider.send` | The send POST only |

Token counts use `usage.total_tokens`, or input plus output tokens when only those are reported.

## 3. Routes

**`GET /v1/developer/metrics`** (`server/handler.js`) returns `{ ok: true, metrics: royal.metrics.snapshot() }`, or `metrics: null` when ROYAL was built without a `Metrics` object.

**`GET /v1/developer/log`** returns the last 500 audit entries, newest first (`AuditService.developerLog`, `core/audit.js`). This is the whole log: tool calls, permission denials, classifications, decisions, execution, server errors. Each entry has `at, actor, agent, run_id, trigger, action, summary, tool, entities, permission, approval, result, verification, error, executive, key, realm`. Every entry passes through `redact()` (`core/util.js`) before storage, so secret-named fields and key- or token-shaped values are replaced.

**`GET /v1/activity`** is the executive ledger: only entries marked `executive`, filterable by realm. **`GET /v1/intelligence/status`** reports the live configuration of each intelligence part and the gateway's adapters (`MCP_INTEGRATION_GATEWAY.md`). **`GET /v1/agents`** adds each agent's last audited action and a health word (DEGRADED when that action was a failure or denial).

## 4. Audit Actions Worth Knowing

| Action | Source |
|---|---|
| INTENT_CLASSIFIED | `core/royal.js#handle` (summary names the intent and whether rules or the model chose it) |
| TOOL_CALLED, TOOL_FAILED, TOOL_UNAVAILABLE, PERMISSION_DENIED | `core/decisions.js#ConsequenceGate.request`, including Grok Bot delegation (`delegate_to_bot`) |
| DECISION_CREATED, DECISION_CANCELLED, DECISION_APPROVED / MODIFIED / REJECTED, ACTION_* | `core/decisions.js#DecisionService`; DECISION_CANCELLED carries the reason ("Tahir said stop", "the draft was revised", "replaced by a new draft") |
| CONTACT_RESEARCH | `core/intelligence/research/contacts.js` (status only) |
| RESEARCH_RUN | `core/intelligence/research/engine.js` (question, first 120 characters, with claim and source counts) |
| VOICE_SESSION | `server/handler.js`, when a realtime voice token is issued |
| COMMAND_ANSWERED, SKILL_FAILED, COMPOSER_REJECTED | `core/royal.js` |
| BOT_MESSAGE_SENT, BOT_TOKEN_ISSUED, BOT_TOKEN_REVOKED | `server/handler.js` (owner actions on the bridge) |

## 5. What Is Not Measured Yet

(a) End-to-end command latency. `handle()` in `core/royal.js` is not timed, and neither are House skills or the specialists consulted through `ctx.consult` (their timeouts are recorded only as failed delegations on the result).

(b) Gate tool calls as a series. They appear in the audit log, not in metrics.

(c) Decisions: time to resolution, approval rate, execution failures. Only visible by reading the log, and for sends as `MESSAGE_SENT` and `MESSAGE_FAILED` events on the core `EventBus` (`EVENT_MODEL.md`), which are recorded but not counted.

(d) The Resend read-back (`check()`), the xAI realtime token request (`voiceSession()`), and anything in the browser, including realtime voice connection time, barge-in and dropped sessions.

(e) The Grok Bot bridge: webhook latency and retries are recorded on the bot's own state (`last_error`), not in metrics.

(f) Cache hit rates for research (`ResearchEngine` caches in the store but does not count hits).

(g) Persistence and scale. Metrics live in one process's memory, are lost on restart, and are per instance. There is no export (no Prometheus, OpenTelemetry or log shipping), no alerting and no dashboards. NOT IMPLEMENTED.

## 6. Tests

`Metrics` is constructed in `tests/intelligence.test.js` so the instrumented code paths run, but no test asserts on `snapshot()`. `/v1/developer/metrics` is called through the handler in `tests/server.test.js` ("intelligence routes: owner only, and no key in any of them"): 401 signed out, 403 for a non-owner, 200 for the owner, no key in the body. `/v1/developer/log` is covered only by the check that no response carries the provider key.
