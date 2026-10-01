# ROYAL AGENT ACTIVITY LEDGER

*Source: `core/agent_ledger.js`.*

## 1. What it records

(a) **`agent_day`**, one record per specialist per day (America/New_York): runs, finished, failed, timed out, not connected, findings, runs by kind of request, first and last time, and the 12 most recent runs with their skill, status, reason, findings count, run id, duration and error. Written for every native specialist run in the fan-out.

(b) **`agent_tasks`** (already persisted, `core/intelligence/agents.js`): every task delegated to a Grok Bot, with objective, adapter, deadline, constraints, approval boundary, request id, status history with reasons, result, cancel or fail reason.

(c) **Grok Bot feeds** (`core/grokbot/`): what each bot posted to ROYAL. A bot's own post is REPORTED, never VERIFIED.

## 2. How it is read

`review({ day, agents })` reads each agent on its own (`Promise.allSettled`): one that cannot be read is reported as such, the rest still are. The skill `agent_activity` turns it into a first-person report: what each worked on, delegated tasks by status, what each bot reported (stripped of markdown and links), failures that need Tahir, and what is unverified. "What are you working on?" (`active_work`) lists open delegated tasks and the last day's results.

## 3. Writes

Compare-and-swap with up to 40 attempts and random back-off, so runs finishing together are all counted (tested with 12 at once). A failure to record never fails the request that did the work; writes are awaited before the answer returns.

## 4. Not yet recorded

Tool calls, approvals and artifacts per agent are in the audit log, not yet joined into the ledger. Bot self-reports are not yet cross-checked against tools or records (`ROYAL_VERIFICATION.md`).
