# ROYAL AGENT ORCHESTRATOR

*Sources: `consult()` in `makeCtx()` (`core/royal.js`), `AgentTasks` and `GrokBotAdapter` (`core/intelligence/agents.js`).*

## 1. Native fan-out (synchronous, within a request)

(a) Each requested specialist runs on its own with its own deadline (8 seconds by default, `delegationTimeoutMs`), under `Promise.allSettled`.

(b) Each handoff carries `handoff_id` (`run_id:agent`), objective, entity, required output, deadline, constraints ("read only"), approval boundary and verification requirement.

(c) Each ends with a status and a reason: OK, or FAILED with TIMEOUT, ERROR or INVALID_RESULT, or NOT_CONNECTED. The deadline timer is always cleared. An invalid result is never used.

(d) Each run is written to the agent activity ledger.

(e) The skill then synthesizes; if a specialist it depends on is missing, it names it and its reason (`unavailable()`), and the turn continues.

## 2. Delegation to a Grok Bot (asynchronous)

An AgentTask is created, the bot's webhook gets a structured handoff with the task id and a `request_id`, and the request returns at once ("I've handed it to..."). The bot's answer arrives later in its feed; the task moves to REPORTED_COMPLETE, never VERIFIED_COMPLETE on the bot's word. ROYAL stays free for the next question. A bot whose connection is AUTH_FAILED or FAILED is not sent work; ROYAL says why.

## 3. Correlation

`run_id` per request, `handoff_id` per native specialist run, `task.id` and `request_id` per delegated task, `conversation_id` on all. A late bot answer attaches to its own request id, not to whatever turn is current. The page numbers its turns, so a late answer never overwrites a newer one.

## 4. Cancellation

Only Tahir cancels delegated work, and only by naming it ("stop the tasks"). Every cancellation records a reason from `CANCEL_REASON`: USER_CANCELLED, BARGE_IN_REPLACED_REQUEST, PARENT_CANCELLED, TIMEOUT, NETWORK_FAILURE, PROVIDER_FAILURE, BOT_FAILURE, TOOL_FAILURE, COMPONENT_DISPOSED, SYSTEM_SHUTDOWN, UNKNOWN.

## 5. Not built

Duplicate-work detection before assigning a task; parallel dispatch of several bots in one request (each delegation is one bot); a retry policy for failed bot deliveries beyond the bridge's single retry.
