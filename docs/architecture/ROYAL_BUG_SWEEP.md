# ROYAL BUG SWEEP

*1 October 2026.*

## 1. Found and fixed

| Bug | Effect | Fix |
|---|---|---|
| Bot-activity questions routed to web research | wrong, empty or unrelated answers | team routing to ROYAL's records |
| Bare "stop" cancelled all delegated tasks | bot work lost on an interruption, no reason | cancel only when named; reasons recorded |
| `submit()` dropped a second question while one ran | "while ACE does that..." vanished | numbered turns, newest wins |
| Realtime `ask_royal` had no time limit | silent voice on long work | 25 second limit, answer on screen |
| Skills read missing specialist data | one failed specialist crashed the turn | `unavailable()` in every dependent skill |
| `AgentTasks.update` ignored a lost compare-and-swap | lost task updates | retry with back-off |
| Five retries not enough under contention | ledger undercounted (5 of 12) | 40 attempts with random back-off |
| Fan-out timeout timer never cleared | timer leak per specialist | cleared in `finally` |
| HOUSE consult threw a TypeError | generic failure | NOT_CONNECTED with reason |
| "sales tax" routed to the sales pipeline | tax question answered as a pipeline | router excludes "sales tax" |
| A House definition answered with a production report | wrong answer | House language registry (earlier pass) |
| Reference metadata searchable | metadata returned as an answer | metadata kept off the index |
| Bot shown connected from configuration | false green | round-trip verification, AUTH_FAILED, UNRESPONSIVE |

## 2. Found, documented, not fixed

(a) `intelligence.status().grok_bots` and the gateway's `grokbots` adapter read CONNECTED whenever the bridge exists (`SECURITY_MODEL.md` 7(g)); per-bot `connection` is correct. (b) `AgentTasks.list()` refreshes each open bot task with one bridge read, one after another. (c) A long research request can exceed a proxy's response limit (Cloudflare's is about 100 seconds) before the server's own 60 second search timeout plus fetches finish. (d) Conversation context is in process memory and lost on restart (Jarvis Phase 1). (e) No static type checker or linter is configured in the repository (no build step by design); the test suite is the check.

## 3. Swept with no finding

Event dedupe, append-only logs, realm walls, secret redaction, CSP (`tests/web.test.js`), the voice queue's interruption path, and time zone handling for "today".
