# ROYAL: SKILL LIBRARY

Version: 0.1
Memory layer: Institutional (Layer 3)
Source of truth: `skills/index.js`. The table below is generated from the live catalog (`royal.skills()`, `GET /v1/skills`).

---

## What a Skill Is

(a) A skill is a named, versioned procedure. Each one declares: id, name, version, agent, purpose, trigger, required inputs, required sources, procedure, output schema, escalation rules, permission requirements, completion criteria, evaluation metrics and status.

(b) Skills can be called by name before they are automated. In the API: `POST /v1/command {"skill": "can_i_step_away"}`. The router is only a way to reach a skill from plain language.

(c) Every skill returns the same shape: `{summary, status, findings[], surface, data}`. `surface` tells the interface what to draw (a briefing, a money view, a decision list, a project answer) instead of adding one more paragraph.

(d) A skill never calls a model to get a fact. The only skill that uses the language provider is the open-question fallback, and it gets labelled facts, never raw records.

## Catalog

| id | Name | Status | Consults | Permission |
|---|---|---|---|---|
| `what_needs_me` | Executive Triage | ACTIVE | ACE, GRACE, LEDGER, FORGE | READ, ANALYZE |
| `can_i_step_away` | Can I Step Away? | ACTIVE | ACE, GRACE, LEDGER, FORGE | READ, ANALYZE |
| `state_of_house` | State of the House | ACTIVE | ACE, GRACE, LEDGER, FORGE | READ, ANALYZE |
| `morning_briefing` | Morning Briefing | ACTIVE | ACE, GRACE, LEDGER, FORGE | READ, ANALYZE |
| `who_owes_us` | Cash Arrival Review | ACTIVE | LEDGER | READ, ANALYZE |
| `waiting_for` | Waiting-For Audit | ACTIVE | GRACE | READ, ANALYZE |
| `commitments` | Commitment Audit | ACTIVE | GRACE | READ, ANALYZE |
| `production_status` | Production Risk Audit | ACTIVE | GRACE, LEDGER | READ, ANALYZE |
| `clients_at_risk` | Client Risk Audit | ACTIVE | GRACE, LEDGER, ACE | READ, ANALYZE |
| `revenue_leakage` | Revenue Leakage Review | ACTIVE | LEDGER | READ, ANALYZE |
| `sales_pipeline` | Sales Pipeline | ACTIVE | ACE | READ, ANALYZE |
| `system_status` | System Status | ACTIVE | FORGE | READ, ANALYZE |
| `what_changed` | What Changed? | ACTIVE | ROYAL only | READ, ANALYZE |
| `decisions_open` | Decision Brief | ACTIVE | ROYAL only | READ, ANALYZE |
| `project_status` | Project Status | ACTIVE | GRACE, LEDGER, ACE | READ, ANALYZE |
| `handle_it` | Handle It | ACTIVE | ACE, GRACE, LEDGER, FORGE | DRAFT, INTERNAL_WRITE, APPROVAL_REQUIRED |
| `personal` | Personal Intelligence | ACTIVE | ROYAL only | READ, ANALYZE |
| `other_business` | Other Business Lines | ACTIVE | ROYAL only | READ, ANALYZE |
| `pickup_readiness` | Pickup Readiness | PLANNED | ROYAL only | READ, ANALYZE |
| `event_deadline_protection` | Event Deadline Protection | PLANNED | ROYAL only | READ, ANALYZE |
| `end_of_day_close` | End-of-Day Close | PLANNED | ROYAL only | READ, ANALYZE |
| `weekly_ceo_review` | Weekly CEO Review | PLANNED | ROYAL only | READ, ANALYZE |
| `deadline_radar` | Deadline Radar | PLANNED | ROYAL only | READ, ANALYZE |
| `open_loop_audit` | Open Loop Audit | PLANNED | ROYAL only | READ, ANALYZE |
| `house_standards_audit` | House Standards Audit | PLANNED | ROYAL only | READ, ANALYZE |
| `contradiction_audit` | Contradiction Audit | PLANNED | ROYAL only | READ, ANALYZE |
| `tahir_bottleneck_audit` | Tahir Bottleneck Audit | PLANNED | ROYAL only | READ, ANALYZE |


`PLANNED` skills are registered and callable, and say plainly that they are not built yet.

## The Flagship Skills

**State of the House** (`state_of_house`). One headline, then Money, Production, Sales, Commitments and Systems in a line each, then the top three items. Not a database dump. When nothing needs Tahir, the headline is "The House is operating normally."

**Can I Step Away?** (`can_i_step_away`). Consults all four specialists and open Decisions. CLEAR only when there is no P0 or P1 item needing Tahir to decide, approve or do, and the calculator's data is not stale. Otherwise it lists at most five items to clear first. It always says what it could not check.

**Morning Briefing** (`morning_briefing`). This is the home screen. Sections: Top 3 priorities, Also needs you, Open decisions, The House, Today, Client watchlist, Money, Production, Sales, Systems, Commitments, Waiting for, Agent report. An item appears once, in the first section that claims it. Empty sections are left out. Long sections show their first few items and a count.

**Executive Triage** (`what_needs_me`). Everything whose need is DECIDE, APPROVE or DO at P2 or above, plus open Decisions, sorted by priority, then risk, then deadline, then amount.

**Project Status** (`project_status`). The fixed answer format: current state, why (when asked), verified facts with source and age, unknowns, owner, next action, deadline, risk, and whether Tahir is required. The verdict line leads with what needs Tahir, or what is holding the piece.

**Handle It** (`handle_it`). Takes the last answer's actionable items. It drafts client messages and turns each into a SEND_CLIENT_MESSAGE Decision, and turns to-dos into internal tasks (or approval requests while internal writes are off). It ends by saying nothing was sent. Idempotent: asking twice creates no duplicate cards.

## Adding a Skill

(a) Register it in `skills/index.js` with `meta(...)` and a `run(ctx)` function.

(b) Read only through `ctx.read(agent, tool)` or `ctx.consult([...agents])`, so every read passes the permission gate and the audit.

(c) Every finding carries an evidence label and an owner.

(d) Add a routing rule in `core/router.js` if it should answer plain language, and a test in `tests/royal.test.js`.
