# PHASE 1 ACCEPTANCE RESULTS

*1 October 2026. The acceptance conversations from the Phase 1 brief, run against the real code with House knowledge loaded (18 documents), the House fixture, and no language provider. The answers below are copied from the run, not written by hand. Each conversation keeps one conversation id, so follow-ups use real context.*

## What this run proves and what it does not

(a) It proves the deterministic paths: identity, the House's records, the agent ledger, the daily digest, knowledge retrieval, cash analysis, routing, context, and that nothing is invented when a provider is missing.

(b) It does not prove the model paths in production: "What's the financial impact?", "What would you do?", current research ("Who is the CFO of [company]?" then "What's their email?"), outreach drafting and revision. Those need xAI, which this environment cannot reach. Their routing and context are proven by tests with a stand-in xAI (`tests/phase1.test.js`, "follow-ups about the record under discussion stay with the House", and `tests/intelligence.test.js`, TESTS A to E: research, email, ACE drafts, shorter, send through approval, once).

(c) "NOT_CONNECTED" in a row below is the correct answer for this run: the question needs a provider that is not configured here, and ROYAL says so instead of guessing.

### Business conversation

| Tahir | Route | Status | Model calls | ROYAL (first 220 characters) |
|---|---|---|---|---|
| Hey ROYAL. | greeting | OK | 0 | Good morning, Tahir. 4 things need you. |
| Who are you? | identity | OK | 0 | I'm ROYAL, your operating intelligence for The House of Royal T. I work across what's connected, coordinate ACE, GRACE, LEDGER and FORGE, and bring you what needs you. Right now I can see the Project Calculator. I can't  |
| What happened today? | daily_digest | OK | 0 | Here's today. My specialists ran 4 times. |
| What did every Bot do today? | agent_activity | OK | 0 | I checked today's record for all five. ACE worked 1 request for you: the greeting; all finished. GRACE worked 1 request for you: the greeting; all finished. LEDGER worked 1 request for you: the greeting; all finished. HO |
| Why didn't GRACE finish that? | agent_activity | OK | 0 | Nothing GRACE was given today failed or was left unfinished, by the record. |
| What needs me today? | what_needs_me | OK | 0 | 4 things need you. |
| What are you working on? | active_work | OK | 0 | Nothing is running in the background right now. Everything I've been asked today has been answered. |

### House data

| Tahir | Route | Status | Model calls | ROYAL (first 220 characters) |
|---|---|---|---|---|
| Pull up Marcus. | project_status | OK | 0 | Marcus Hill's Cuban link chain. It's in production, target 2026-09-20. $13,000 still owed. Needs you: past its target date by 9 days. |
| What's the balance? | project_money | OK | 0 | Marcus Hill owes $13,000 on the Cuban link chain. $5,000 of $18,000 is paid. |
| What stage is it in? | project_status | OK | 0 | Marcus Hill's Cuban link chain. It's in production, target 2026-09-20. |
| Why hasn't it moved? | project_status | OK | 0 | Marcus Hill's Cuban link chain: Production is not fully funded: $4,000 short of the production cost. Waiting on the manufacturer for 2 days. Needs you: past its target date by 9 days. |
| Who are we waiting on? | waiting_for | OK | 0 | 4 things waiting, 1 past their expected time. |

### Knowledge

| Tahir | Route | Status | Model calls | ROYAL (first 220 characters) |
|---|---|---|---|---|
| What is working capital? | intel:world_knowledge | OK | 0 | Working capital is current assets minus current liabilities. Operating working capital is mainly receivables plus inventory minus payables. Deposits taken before work begins are a source of cash (a liability until earned |
| What's the difference between profit and cash flow? | intel:world_knowledge | OK | 0 | Profit is earned when work is delivered and recognized; cash moves when money is received or paid. A profitable business can run out of cash when it pays for materials and labor before clients pay. Cash is the constraint |
| How does A/R affect cash? | intel:world_knowledge | OK | 0 | A/R is money clients owe for work billed or delivered. Every dollar in A/R is cash not yet in the bank. Aging (current, 30, 60, 90+ days) shows collection risk; the older a balance, the less likely it is collected in ful |
| What is contribution margin? | intel:world_knowledge | OK | 0 | Gross margin is revenue minus direct costs (materials, stones, direct labor, outside casting and setting), divided by revenue. Contribution margin also subtracts other variable costs (card fees, shipping). Operating marg |
| What does idempotency mean? | intel:world_knowledge | OK | 0 | An operation is idempotent when doing it twice has the same effect as doing it once. Payments, sends and creates need idempotency keys so a retry after a timeout does not charge or send twice. |
| What makes an operational bottleneck? | intel:world_knowledge | OK | 0 | An operational bottleneck is the step that limits how much work the whole operation can finish: throughput is limited by the slowest step (the constraint). Improving any other step does not increase output. Find the cons |
| How should a luxury brand think about scarcity? | intel:world_knowledge | OK | 0 | Brand equity is the extra value clients attach because of the name: trust, desirability, willingness to pay. It is built by consistent experience, craftsmanship, story and scarcity over time, and lost quickly by inconsis |
| What does CAD approved mean? | house_term | OK | 0 | CAD approval is the client approving the design, in a recorded form. |

### Accounting and cash

| Tahir | Route | Status | Model calls | ROYAL (first 220 characters) |
|---|---|---|---|---|
| Why have we been tight on cash? | cash_analysis | OK | 0 | The calculator shows $21,000 available, $30,400 owed to us and $0 we owe vendors, with 62 days of runway by its calculation. What it means: $3,700 of what we're owed is on finished pieces, so it's collectable now without |
| What is the sales tax rate in North Carolina? | intel:current_research | NOT_CONNECTED | 0 | That's a current tax or legal rule, which changes, so I only answer it from current official sources, and web research isn't available (Web research needs a provider with search (xAI: XAI_API_KEY and ROYAL_GROK_MODEL).). |

### Self knowledge

| Tahir | Route | Status | Model calls | ROYAL (first 220 characters) |
|---|---|---|---|---|
| Diagnose yourself | self_diagnostic | OK | 0 | I checked 11 parts of myself. Working: Project Calculator, House knowledge, Permission engine, Event store, Native specialists. Degraded: Data congruence (2 issues: The treasury says $30,400 is owed to us, but the projec |
| Stop. | intel:cancel | OK | 0 | Nothing was waiting to be sent or done. |

## Defects this run found, all fixed in this pass

(a) "Pull up Marcus" answered only "Needs you: past its target date by 9 days", without naming the piece or its stage. Fixed: the piece, the stage, the date and the balance, then the verdict.

(b) "What's the balance?" right after "Pull up Marcus" answered the textbook meaning of A/R. Fixed: a short attribute question refers to the record under discussion.

(c) "What's the financial impact?", "Does it affect Saturday?" and "What would you do?" after a project went to world knowledge, where the model never saw the project. Fixed: they stay with the House and the model is given that record's facts.

(d) "What happened today?" said "Nothing has changed since the start of today" while the specialists had run and payments had come in. Fixed: a daily digest from events, decisions, the ledger and calculator freshness.

(e) "What makes an operational bottleneck?" found nothing. Fixed: question verbs are stop words, and the COO pack names the term.

## The flows from the brief, gate by gate

| Flow | Result |
|---|---|
| Business conversation (section 96) | Greeting, identity, today, each bot, why GRACE didn't finish, what needs me: pass, no model. Financial impact and "what would you do": routed to the House with the record (stand-in xAI test); live answer not run. "Have GRACE do that": asks which client when nothing is under discussion; delegation itself is tested. |
| External research (section 97) | Routing, context, cross-checking and the approval chain pass with a stand-in xAI (TESTS A to E). Not run against live xAI. Sending stays off until `agent_external_send` and a provider are configured, and says so. |
| House data (section 98) | Pass, no model. "When did that start?" answers from the waiting record (days waiting); stage timestamps are not sent by the calculator yet (CLAUDE.md, known issue (c)). "What happens if it slips three days?" is a model question about the record (routed with the record). |
| Knowledge (section 99) | Pass for all seven concepts from the reference, labelled general reference, no model. "How does that apply to the House?" needs the model. |
| Accounting and CFO (section 100) | The CFO and accounting packs keep revenue, cash collected, profit, gross margin, A/R, A/P, COGS, working capital and owner distributions apart (`docs/knowledge/cfo.md`, `accounting.md`); the benchmark test checks the key definitions. |
