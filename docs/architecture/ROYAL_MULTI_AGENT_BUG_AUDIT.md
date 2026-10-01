# ROYAL MULTI-AGENT BUG AUDIT

*1 October 2026. Reproduced on the code as it was, traced, fixed, and covered by `tests/multiagent.test.js`.*

## 1. The request

"Tell me what each Bot did for work today."

## 2. What actually happened (reproduced)

(a) **Routing.** No rule in `core/router.js` recognised the sentence, so it fell to the intelligence layer's rules, where the word "today" (`needsCurrentInfo()`) made it `current_research`. The request went to web research.

(b) **With a provider connected:** one Responses API call with the `web_search` tool, searching the internet for the literal sentence. Against a stand-in xAI the research reply failed its schema and the answer was "The research didn't complete... Nothing was made up in its place." With real xAI it returns whatever the web says about "bots" today: incomplete, generic, unrelated or failed answers. Up to 60 seconds per search.

(c) **Without a provider:** "That needs current information, and web research isn't available."

(d) **Nothing consulted the bots, the agent tasks or any record of their work.** No such record existed.

So the observed failure (Failure A, B, C) is not a bot crash: the intent was lost at routing, and the request was answered by the wrong machinery.

## 3. Adjacent causes found on the same path

(a) **A bare "stop" cancelled every delegated task.** `doCancel()` called `tasks.cancelOpen(conversation_id)` for any "stop", "never mind" or "cancel that", which is also what an interruption sounds like in voice. Every bot task in the conversation became CANCELLED with no reason (Failure D, and the "cancelled" Tahir saw).

(b) **The page dropped a second question.** `submit()` in `web/js/app.js` began `if (busy) return;`, so "while they do that, what needs me?" vanished while the first request ran (Failure J).

(c) **The voice waited forever.** Realtime voice's `ask_royal` had no time limit; a long request left the voice silent.

(d) **One specialist could break a whole answer.** Skills read `results.<agent>.data` without checking it; a specialist that timed out or returned something invalid made the pipeline answer throw "Cannot read properties of null" (found by the stress test).

(e) **Lost task updates.** `AgentTasks.update()` ignored the result of its compare-and-swap, so a refresh and a cancel landing together could silently lose one.

(f) **A timer leak** in the specialist fan-out (`Promise.race` with a timeout never cleared), and **a HOUSE consult would throw** a TypeError (no native HOUSE), recorded as a generic failure.

## 4. Fixes

(a) Team, activity, active-work and diagnostic questions route to ROYAL's own records (`teamRoute()` in `core/router.js`, reason LEDGER), never to research or a model.

(b) `AGENT_DAILY_ACTIVITY_REVIEW` is the skill `agent_activity`, reading the agent activity ledger, delegated tasks and Grok Bot feeds, each agent on its own (`ROYAL_AGENT_ACTIVITY_LEDGER.md`).

(c) Delegated tasks are cancelled only when Tahir names them ("stop the tasks", "cancel everything"); every cancellation and failure carries a reason (`CANCEL_REASON` in `core/enums.js`). A bare "stop" says the tasks are still running.

(d) Turns are numbered: every question goes through, the newest is drawn, and an older answer arriving late never overwrites it.

(e) The voice gives up waiting after 25 seconds and says the answer will appear on screen.

(f) Every skill checks the specialists it depends on (`unavailable()` in `skills/index.js`): a missing one is named with its reason, never replaced by zeros.

(g) Compare-and-swap with retry and random back-off in the ledger and in AgentTasks; the fan-out uses `Promise.allSettled`, a per-agent reason (TIMEOUT, ERROR, INVALID_RESULT, NOT_CONNECTED) and clears its timer.

## 5. Proof

`tests/multiagent.test.js`: the original sentence answered with 0 model calls and no search; routing of eight phrasings; one specialist failing; one timing out; an unreadable bot feed; delegated tasks in the review and in active work; stop semantics; 12 concurrent ledger writes all counted; concurrent task updates; the House day; diagnostics; a 20-request stress run with a stalling GRACE, a malformed ACE and a failed bot (no turn throws, unique run ids, every run accounted for); a skill with a failed specialist. Chromium: a second question sent while the first ran reached the server and its answer stayed on screen.
