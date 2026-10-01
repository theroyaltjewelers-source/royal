# PHASE 1 PERFORMANCE RESULTS

*1 October 2026. Measured in this environment with the real code, 30 runs per category, against the House fixture (`tests/fixtures.js`). Script: the same questions as `npm run bench`, run in process. Nothing here is a production measurement.*

## What could and could not be measured

(a) **Measured:** ROYAL's own time for every path that needs no model: routing, context, the calculator snapshot, the specialists, the ledger, the event log, knowledge search and composition. Measured twice: with the memory store, and with the real Postgres store (PostgreSQL 16 on this machine), which is what production uses when `DATABASE_URL` is set.

(b) **Not measured:** anything with xAI in it (time to first token, time to first audio, research, realtime voice). This environment's network policy refuses both api.x.ai and the production server (CONNECT 403). Those numbers must come from `npm run bench` against production:

    ROYAL_URL=https://royal-1wx5.onrender.com ROYAL_TOKEN=<session token> npm run bench

(c) **From the earlier correction pass** (`ROYAL_PERFORMANCE_AUDIT.md`), with a simulated 700 ms xAI: a greeting went from 1,414 ms to 10 ms (no model call); an open question from 1,410 ms to 708 ms (one call instead of a classify call and an answer call); 24 model calls for the benchmark set became 12.

## ROYAL's own time, Postgres store (production configuration)

| Category | Question | p50 ms | p95 ms | model calls |
|---|---|---|---|---|
| GREETING | Hey ROYAL | 12.1 | 21.2 | 0 |
| IDENTITY | Who are you? | 2.1 | 3.5 | 0 |
| CALCULATION | What's 12% of 85,000? | 3.0 | 8.3 | 0 |
| INTERNAL READ | What does Marcus owe? | 3.8 | 6.0 | 0 |
| HOUSE OPERATIONS | What needs me? | 8.2 | 12.7 | 0 |
| HOUSE KNOWLEDGE | What does production deposit mean? | 2.1 | 3.8 | 0 |
| BUSINESS CONCEPT | What is working capital? | 2.6 | 4.9 | 0 |
| MULTI-AGENT | Tell me what each Bot did for work today. | 4.8 | 7.6 | 0 |
| DAILY DIGEST | What happened today? | 6.7 | 10.7 | 0 |
| SELF DIAGNOSTIC | Diagnose yourself | 4.6 | 8.2 | 0 |

## ROYAL's own time, memory store

| Category | Question | p50 ms | p95 ms | model calls |
|---|---|---|---|---|
| GREETING | Hey ROYAL | 2.0 | 4.2 | 0 |
| IDENTITY | Who are you? | 0.1 | 0.7 | 0 |
| CALCULATION | What's 12% of 85,000? | 0.3 | 3.4 | 0 |
| INTERNAL READ | What does Marcus owe? | 0.2 | 1.4 | 0 |
| HOUSE OPERATIONS | What needs me? | 1.7 | 2.7 | 0 |
| HOUSE KNOWLEDGE | What does production deposit mean? | 0.2 | 0.8 | 0 |
| BUSINESS CONCEPT | What is working capital? | 0.4 | 1.0 | 0 |
| MULTI-AGENT | Tell me what each Bot did for work today. | 0.9 | 2.7 | 0 |
| DAILY DIGEST | What happened today? | 1.1 | 1.6 | 0 |
| SELF DIAGNOSTIC | Diagnose yourself | 0.9 | 1.5 | 0 |

## Reading the numbers

(a) Every House path answers in under 13 ms at p95 against Postgres, with **zero model calls**. On these paths the wait Tahir feels is the network to Render and back, not ROYAL.

(b) The greeting is the slowest fast path (p95 21 ms) because it reads the triage count ("4 things need you"), which consults the specialists and writes their runs to the ledger and the task ring. That is deliberate: the greeting says something true.

(c) The extra time against Postgres is the record writes: each specialist run writes the ledger rollup and one native task record, inside the request, so the record is complete when the answer returns.

(d) Model paths cost one model call each (open questions, follow-ups about a record, world questions without a reference answer). Their latency is xAI's and was not measurable here.

## Compute

Nothing here points at CPU or memory. The brief reports Render's metrics showed no CPU or memory pressure, and ROYAL's own work per request is milliseconds. Upgrading the instance would not change what Tahir feels; the model round trip and the network do. No compute change is recommended.

## Instrumentation in production

(a) Every answer carries `timing` (total, marks for intent, context and first model request, `model_calls`, `path`). `GET /v1/developer/metrics` returns p50 and p95 per path from the running server.

(b) From this deploy, every API request writes a `ROYAL_ACCESS` line with its duration, so slow routes show in the Render log.
