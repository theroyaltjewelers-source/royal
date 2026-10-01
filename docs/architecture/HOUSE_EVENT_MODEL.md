# HOUSE EVENT MODEL

*Sources: `core/events.js`, `EVENT_TYPE` in `core/enums.js`, `diffSnapshots()` in `realms/business/royal-t/changes.js`. The general event design is in `EVENT_MODEL.md`.*

Business events are appended to the `events` log with a type, a dedupe key, source, entity, payload, `occurred_at` and `received_at`. A type not in `EVENT_TYPE` is refused; a repeated key is recognised and handled once.

**Emitted today:** SNAPSHOT_INGESTED, INTEGRATION_FAILED, and from snapshot changes PAYMENT_RECEIVED, PRODUCTION_STAGE_CHANGED, PROJECT_READY, COMMITMENT_CREATED and LEAD_CREATED.

**Defined, not emitted yet:** the rest of `EVENT_TYPE`, including CLIENT_MESSAGE_RECEIVED, APPOINTMENT_CREATED and DECISION_REQUIRED.

**Not built:** events for agent tasks (AGENT_TASK_ASSIGNED, COMPLETED, FAILED: today in AgentTasks history and the activity ledger instead), a correlation id on each event, a `verified` flag, and a daily digest engine beyond "what changed".

**Three ledgers, kept apart:** audit (what ROYAL did), agent activity (what specialists worked on), business events (what changed in the business).

**Time:** stored as epoch milliseconds; "today" is the America/New_York day everywhere (`dayOf()` in `core/agent_ledger.js`).
