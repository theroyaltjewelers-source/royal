# TEST PLAN

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

## 1. How to Run

(a) Everything: `npm test`, which runs `node --test tests/*.test.js` (Node 20 or later, no framework, no network).

(b) One file: `node --test tests/intelligence.test.js`.

(c) Postgres tests for the Grok Bot bridge: set `TEST_DATABASE_URL` to a disposable database. Without it, three tests in `tests/grokbot.test.js` are skipped.

(d) Calculator tests: set `RTJ_CALCULATOR_DIR` to a Project Calculator checkout with `node_modules` installed (and `RTJ_SEED` to a seed, default `/tmp/seed.js`), for `tests/calculator-contract.test.js`. `RTJ_CALCULATOR_DIR` alone enables the embed copy check in `tests/embed.test.js`. Without them, two tests are skipped.

(e) One test binds port 80 ("review: a slow-drip server cannot hold a fetch past its total deadline", because fetches are limited to ports 80 and 443). Where port 80 cannot be bound it skips itself and says so.

(f) External services are never called. xAI, Hunter and Resend are replaced by fakes returning their documented response shapes (`tests/intelligence.test.js`, "fakes" section); bot webhooks by a fake `fetchImpl`. `tests/fixtures.js` supplies the House snapshot and the fixed clock `NOW`.

## 2. Current Result

Run on 30 September 2026, after the security review, with a local Postgres and a calculator checkout:

```
cd /home/claude/royal && TEST_DATABASE_URL=postgres://royal:royal-test@localhost:5432/royal_test RTJ_CALCULATOR_DIR=/home/claude/royal-t npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
# tests 171
# pass 171
# fail 0
# skipped 0
```

171 tests, all passing, none skipped: the three Postgres tests, the two calculator tests and the port 80 test all ran. Without `TEST_DATABASE_URL` and `RTJ_CALCULATOR_DIR` the same run skips five (166 pass). Before the review there were 152 tests; the review added 17 regression tests in `tests/intelligence.test.js` and 2 route tests in `tests/server.test.js`.

## 3. The Test Files

| File | Tests | What it proves |
|---|---|---|
| `tests/core.test.js` | 35 | The permission engine (charters, prohibited tools, unknown tools and agents, the realm wall, internal writes behind a flag); the gate (reads execute and audit, refusals are recorded, failures carry impact, unconnected tools fail honestly); decisions (one per question, owner only, reject, modify, execution and verification failure, no executor, no double resolution); the store's revision check; append-only audit and secret redaction; snapshot contract validation; event dedupe; routing, name resolution, freshness, conflicts; result and presentation schemas. |
| `tests/royal.test.js` | 31 | The House skills end to end through `royal.handle()`: what needs me, can I step away, who owes us, project status, follow-ups, ambiguity, missing and stale data, rejected snapshots, what changed, handle it (drafts and decisions, sends nothing), approval without a messenger, open questions with no or a failing provider, model proposals through the gate, a throwing specialist, realms kept apart, the send-it conversation, clear. |
| `tests/intelligence.test.js` | 44 | The intelligence layer (27): deterministic calculation, strict schemas, the intent engine and when the model may interpret, the reasoning router, the tool registry, provenance labels, House knowledge retrieval, plans, title classification, research with cross-checks, conflicts and caching, prompt injection, contact research, the xAI request shapes, SSRF-safe fetching, the realtime voice client, and flagship flows A to H. The security review's regression tests (17), section 5. |
| `tests/grokbot.test.js` | 27 | The Grok Bot bridge: bot listing without secrets, bot-token scope, per-bot webhooks, request status from events, per-bot streams and resume, webhook failure and retry, token rotation and revocation, v1 compatibility, realms, input validation, rate limits, events as records only, the master switch, hashed tokens, stream limits, upload caps; and with `TEST_DATABASE_URL`, migrations, durability and LISTEN/NOTIFY across instances (3). |
| `tests/server.test.js` | 22 | The HTTP handler: public health only, owner sign-in on every other route, identity outage refuses, ingest then ask, invalid and oversized bodies, decisions through the API, CORS, no provider key in any response, Supabase and member roles, the dev token refused in production, file store permissions, passcode sign-in and lockout, sessions, the Grok test endpoint, boot states; and, new with the review, the intelligence routes and the voice session (section 5). |
| `tests/web.test.js` | 7 | The page: every looked-up element exists, CSP compliance (no inline script, style or handlers), every loaded file exists, no secret in `web/`, one composer node per specialist, safe body attributes, safe bot markdown. |
| `tests/embed.test.js` | 4 | The calculator embed: pushes snapshots, stays off without an address, escapes HTML; with `RTJ_CALCULATOR_DIR`, the calculator's copy is identical (1). |
| `tests/calculator-contract.test.js` | 1 | With a calculator checkout, its House API satisfies contract `rtj.house.v1`. |

## 4. Flagship Flows

All in `tests/intelligence.test.js` unless noted.

| Flow | Request | Covered by |
|---|---|---|
| A | "Who is the CFO of Acme?": research, cross-check, cite | "TEST A" (VERIFIED_EXTERNAL, former and regional roles excluded, uncited candidate dropped, no specialist); "TEST A (failure)" (conflict reported, ambiguous company asks, no provider says so) |
| B | "Find their business email" | "TESTS A to E" (verified deliverable by Hunter); "contact research: statuses are honest..." (webmail refused, pattern guesses labelled, opt-out, quota, bad key) |
| C | "Have ACE write the introduction" | "TESTS A to E" (ACE delegated, structured handoff carries person, company, address and sources, nothing sent) |
| D | "Make it shorter" | "TESTS A to E" (same recipient, new wording); "TEST E (failure)" (the old approval is withdrawn) |
| E | "Send it": approval, once | "TESTS A to E" (one Decision however often asked, nothing sent before approval, exactly one Resend POST with the idempotency key and the approved wording, VERIFIED against a fake reporting "delivered", a second approval sends nothing, audit entries); "TEST E (failure)" (no draft asks, unverified address flagged, stop withdraws, no executor without flag and provider); the review tests on sending twice, rejection and cancellation |
| F | A House project | "TEST F" (answered by `project_status` from the calculator; no web search) |
| G | "Who founded Rolex?" | "TEST G" (world knowledge labelled MODEL_KNOWLEDGE, no specialist) |
| H | "Why is this project behind?" | "TEST H" (GRACE and LEDGER consulted over House data) |

Related: "routing: arithmetic, House knowledge, prospecting and the pipeline..." and "'Where did you get that?'..." cover routing edges and sources; "every intelligence answer carries a valid presentation" runs the whole A to E conversation through the presentation schema; "Grok Bot delegation happens only when switched on" covers the bot path.

## 5. Security Review Regression Tests

Each test reproduces an issue found by the review of 30 September 2026 and proves it stays fixed. The letters are the review's change list.

**In `tests/intelligence.test.js`:**

| Test | Issue it proves fixed |
|---|---|
| "review: 'send it' after an approved send never sends twice or reopens the record" | (a) A second "send it" after an approved, delivered send reopened the same Decision as OPEN and reused its idempotency key. Now `doSend` answers "already sent. I won't send it twice", the record stays VERIFIED, Resend is called once, and `DecisionService.create` with the same key returns `already_decided`. |
| "review: a rejected send may be asked again, under a new identity, keeping the old record" | (a) Re-asking after a refusal overwrote the refused record. Now a new id is used and the old one stays REJECTED. |
| "review: 'stop' and 'never mind' withdraw every approval this conversation asked for, House messages included" | (b) "Never mind" only cleared the screen and left the approval OPEN, and "stop" withdrew only the outreach email's approval. Now "Don't send it" and "Never mind" withdraw an open House client update, and "Stop" with nothing open says nothing was waiting. |
| "review: a new draft withdraws the old draft's approval" | (c) An approval raised for an earlier outreach draft stayed OPEN after a new draft replaced it. |
| "review: House sentences stay with the House; bare controls still work" | (b) and (e) "Stop the Marcus production" and "Forget it, what does Marcus owe?" were cancellations; "What is 20% of what Marcus owes?" was arithmetic; "Find me leads for Marcus" was prospecting; "Who should I call today?" was world research; "Did brooks pay?" lost the client. Bare "Cancel that" and "never mind" still cancel, and "12% of $85,000" still calculates. |
| "review: 'send it' asks when two messages are open, and when the draft is for someone else" | (d) With an outreach email and a House update both open, "send it" guessed. Now it asks, raises nothing, and "Send the email" and "Send the update" each reach the right path. The body asserts only the two-message case; the different-person case is not asserted. |
| "review: an ambiguous company name is asked about, never picked" | (d) Two distinct companies for one name were resolved to the first when the model did not flag ambiguity. |
| "review: a company's domain is never taken on the model's word" | (f) A model-named domain with no reported source on it became the official domain. Now it is null and kept as `domain_unconfirmed`. |
| "review: name and title must appear together, not as someone else's or a former title" | (f) A page confirmed a person when the name and the role appeared anywhere on it. Now `nameWithRole` requires them together, not former or interim, not another person's title. |
| "review: an opt-out (451) stops every other way of finding the address" | (g) After a Hunter 451, the pattern and verification still ran. |
| "review: an address found off the company's site is UNVERIFIED, not PUBLICLY_LISTED; mail.acme.com is business" | (g) A third-party page gave PUBLICLY_LISTED, and webmail matching discarded a business's own `mail.` host. |
| "review: email is verified only when the provider says delivered" | (h) "sent" counted as verified. Now delivered is `true`, bounced and complained `false`, sent, queued and delivery_delayed `null`. |
| "review: fetcher refuses IPv6 forms of private addresses and parses hostile HTML in linear time" | (i) `[::ffff:127.0.0.1]` (which the URL parser rewrites to `[::ffff:7f00:1]`) and the NAT64 and 6to4 forms passed the check, and hostile HTML could stall the parser. The test also covers compatible, site-local and unique-local forms and decimal and octal IPv4. |
| "review: a slow-drip server cannot hold a fetch past its total deadline" | (i) Only an idle timeout existed, so a server writing a byte every 50 ms held a fetch open. Binds port 80; skips if it cannot. |
| "review: long lines in House documents are kept whole" | (m) Splitting a long passage dropped the text of a single over-long line. |
| "review: the tool catalogue shows nothing as available that has no code behind it" | (j) Tools with no implementation or no executor read AVAILABLE. Now APPROVAL_ONLY, NOT_IMPLEMENTED and PROHIBITED are reported, and `x_search` carries `runs_inside`. |
| "review: bot delegation goes through the permission gate and is audited" | (k) Delegation skipped the gate. The test reads the source of `doBotDelegation` for the gate call and for no direct `bots.delegate(` call; it is a source check, not a behavioural one. |

**In `tests/server.test.js`:**

| Test | Issue it proves fixed |
|---|---|
| "intelligence routes: owner only, and no key in any of them" | (n) The new routes had no handler tests. `/v1/intelligence/status`, `/v1/tools`, `/v1/agents/tasks`, `/v1/developer/metrics` and `/v1/knowledge/search` answer 401 signed out, 403 to a non-owner and 200 to the owner, never carry a key, report sending DISABLED by default, list `send_email` as APPROVAL_REQUIRED, and require `q` for knowledge search. |
| "voice session: off by default, Business only, and only a short-lived token ever leaves" | (n) The voice route had no test and accepted the Personal realm. Now 409 with the flag off, 409 `VOICE_BUSINESS_ONLY` for `realm=PERSONAL`, and 200 with only the short-lived token for Business. |

## 6. Failure Cases Covered

(a) Permission: prohibited, unknown tool, unknown agent, outside charter, outside realm, internal write with the flag off (`tests/core.test.js`).

(b) Approval: non-owner resolve, double resolve, reject, modify, executor failure, verification failure, no executor (`tests/core.test.js`, `tests/royal.test.js`, "TEST E (failure)"); never reopening a decided Decision, re-asking after a refusal, withdrawal by every bare cancellation including House messages, withdrawal on a new or revised draft, asking when two messages are open (section 5).

(c) Providers: no provider, a failing provider, invalid model output discarded (`tests/royal.test.js`, "model interpretation is used only when valid").

(d) Research: conflicting sources, ambiguous companies (including ones the model did not flag), uncited candidates, model-named domains with no source on them, name and title apart or qualified, prompt injection in results (`tests/intelligence.test.js`).

(e) Contacts: webmail, pattern guesses, opt-out stopping every other step, third-party pages, quota, bad key.

(f) Email verification: delivered, sent, queued, delivery_delayed, bounced and complained read-backs (at the `verify()` level).

(g) Fetching: private and metadata addresses, IPv6 loopback, every embedded-IPv4 IPv6 form, site-local and unique-local IPv6, decimal and octal IPv4, bad schemes, ports, credentials, DNS rebinding at connect time, non-text bodies, hostile HTML, a slow-drip server (`tests/intelligence.test.js`).

(h) Server: identity outage, bad and oversized bodies, CORS, key leakage (including the intelligence and voice routes), dev token in production, passcode lockout, forged sessions, the voice session's Business-only rule (`tests/server.test.js`).

(i) Bridge: webhook failure and retry, unreachable webhook, wrong-bot access, rate limits, disabled bots, replay gaps (`tests/grokbot.test.js`).

## 7. Failure Cases Not Covered

(a) "Send it" when the open draft is to a different person than the one now under discussion (the review test's name mentions it; its body does not assert it).

(b) Email end to end: a Resend HTTP error or timeout, a bounced read-back ending FAILED on the Decision, an unconfirmed one ending EXECUTED, a MODIFY of an email Decision, and the "message changed after approval" refusal.

(c) Events: `SNAPSHOT_INGESTED`, `MESSAGE_SENT` and `MESSAGE_FAILED` are published but not asserted.

(d) The reasoning policy's branches in `doWorld()` (`use_model`, `model_tier`, `allow_search`), STANDARD depth for current research, a caller-named freshness class, a report's weakest-claim confidence, and `accept_all` or a low score giving RISKY.

(e) Agents: `routeAgents` on its own and its capability path (rule-classified outreach always names ACE), `overdue` on a task past its deadline, `refresh()` to REPORTED_COMPLETE or FAILED, `grok_bots: "DISABLED"` in the status, and delegation through the gate as behaviour (only the source is checked).

(f) The gateway (`read`, and the content of `describe()`); `Metrics.snapshot()`; the `world` domain reading CONNECTED.

(g) Apollo, `x_search`, and prospecting with research connected (only the NOT_CONNECTED path is tested), including its domain and buyer checks.

(h) The Deno entry (`server/deno.js`), which now builds the same intelligence parts as Node.

(i) Realtime voice against xAI: the token request, the WebSocket, the audio worklet and playback; `VOICE_NOT_CONFIGURED` and the 502 path; the client passing its realm and stopping on a realm switch. Only the client's PCM conversion, tool loop and barge-in message are tested, with a fake socket. Browser speech (`web/js/voice.js`) has no test.

(j) The connected socket's second address check in `SafeFetcher` (the test server relaxes the guard).

(k) Concurrent resolution of one Decision (`CONFLICT`); the store-level revision check is tested, the resolve path is not.

(l) The House `send_pending` skill after its Decision was already approved (`APPROVAL_MODEL.md`, section 9).

(m) Every real external service. All provider tests use fakes of documented shapes; a live run needs keys and is manual.
