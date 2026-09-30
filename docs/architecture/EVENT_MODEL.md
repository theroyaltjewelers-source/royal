# EVENT MODEL

Source: `core/events.js`, `core/royal.js#ingestCalculator`, `core/attention.js`. Tests: "a duplicate event is recognised and handled once" (`tests/core.test.js`), "what changed reports verified deltas and raises events once" (`tests/royal.test.js`). Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.

## 1. V1 Design

(a) An in-process `EventBus` with an append-only `events` log and synchronous subscribers. The log is the seam: a queue can replace it later without changing publishers or subscribers.

(b) Every event has a `key`. A second publish with the same key is recognised and skipped (`{duplicate: true}`). This protects against retried deliveries and repeated snapshots.

(c) A subscriber that throws does not stop other subscribers. The failure is audited (`EVENT_HANDLER_FAILED`).

## 2. Event Types

`PAYMENT_RECEIVED, PAYMENT_OVERDUE, CLIENT_MESSAGE_RECEIVED, CLIENT_UPDATE_DUE, LEAD_CREATED, LEAD_QUALIFIED, CONSULTATION_SCHEDULED, DESIGN_DEPOSIT_RECEIVED, CAD_RECEIVED, CAD_APPROVED, PRODUCTION_STAGE_CHANGED, MATERIALS_RECEIVED, VENDOR_STATUS_CHANGED, SHIPMENT_CREATED, SHIPMENT_DELAYED, QC_COMPLETED, PROJECT_READY, APPOINTMENT_CREATED, COMMITMENT_CREATED, COMMITMENT_DUE, COMMITMENT_OVERDUE, DECISION_REQUIRED, SYSTEM_ERROR, INTEGRATION_FAILED, DATA_CONFLICT_DETECTED, SNAPSHOT_INGESTED, MESSAGE_SENT, MESSAGE_FAILED`.

## 3. What Emits Today

| Source | Event | Key |
|---|---|---|
| Accepted snapshot that differs from the latest (including the first ever) | SNAPSHOT_INGESTED, payload `{ projects }` | snapshot:digest |
| Snapshot diff: payment rose | PAYMENT_RECEIVED | type:project:digest |
| Snapshot diff: stage changed | PRODUCTION_STAGE_CHANGED, or PROJECT_READY when the new stage is Ready | type:project:digest |
| Snapshot diff: target date changed | COMMITMENT_CREATED | type:project:digest |
| Snapshot diff: new project | LEAD_CREATED | type:project:digest |
| Rejected snapshot | INTEGRATION_FAILED | hash of errors plus the hour |
| An approved `send_email` or `send_client_message` that an executor ran (`royal.resolveDecision` in `core/royal.js`) | MESSAGE_SENT when the execution result is EXECUTED, MESSAGE_FAILED when it failed; payload `{ decision_id, tool, status, verified }` | msg:decision id:status |

Events for inbound messages, shipping, CAD and appointments need their integrations and are reserved.

Nothing else publishes. In particular:

(a) `PAYMENT_OVERDUE` is a valid type, is listed as a calculator event by the gateway (`core/intelligence/gateway.js`) and is subscribed to by proactive monitoring, but no code publishes it.

(b) The first snapshot ever ingested publishes `SNAPSHOT_INGESTED` and no diff events, because there is no earlier snapshot to diff against. An identical snapshot (`changed: false`) publishes nothing.

(c) Message events are published only on the resolve path through `royal.resolveDecision` (which `POST /v1/decisions/:id/resolve` uses); calling `DecisionService.resolve` directly publishes none. No event is published for NO_EXECUTOR, REJECT or an approval that has not executed. The type follows the execution result, not delivery: a send accepted by Resend and then read back as bounced is published as MESSAGE_SENT with `status: "FAILED"` and `verified: false`, and a send not yet confirmed is MESSAGE_SENT with `status: "EXECUTED"` and `verified: null` (`APPROVAL_MODEL.md`, section 6).

(d) Bounce and delivery webhooks from Resend are NOT IMPLEMENTED. There is no receiver, so no later delivery or bounce ever becomes an event. `MESSAGE_BOUNCED` does not exist.

(e) The rest of the intelligence layer (research, drafts, cancellation, delegation) publishes no events. Its record is the audit log.

(f) No test asserts `SNAPSHOT_INGESTED`, `MESSAGE_SENT` or `MESSAGE_FAILED`.

## 3a. Grok Bot Events Are a Separate Stream

The Grok Bot bridge (`core/grokbot/`) keeps its own event feed: outbound messages and each bot's posted events, stored per bot and streamed to the owner over server-sent events (`GET /v1/bots/:id/stream`, `GET /v1/feed/stream`). With `DATABASE_URL` set, instances share it through Postgres LISTEN/NOTIFY (`core/grokbot/pubsub.js`). These never enter the core `EventBus`, never create decisions and never call tools (tested in `tests/grokbot.test.js`, "bot events are records only").

## 4. State Deltas ("What changed?")

`realms/business/royal-t/changes.js#diffSnapshots` compares two verified snapshots: payments recorded or voided, stage changes, target date changes, value changes, health worsening or recovering, projects added or removed, Treasury exceptions new or resolved. Baseline: the "last seen" checkpoint, otherwise the first snapshot of the day (Eastern), otherwise the previous snapshot. "Mark as seen" moves the checkpoint.

## 5. Proactive Intelligence

`proactive_monitoring` is off by default (`core/permissions.js`). With it off, nothing subscribes to the bus and ROYAL speaks only when asked.

With it on, `core/royal.js` subscribes to `SNAPSHOT_INGESTED, PAYMENT_OVERDUE, PRODUCTION_STAGE_CHANGED, PAYMENT_RECEIVED, PROJECT_READY`. Each matching event runs the `what_needs_me` triage, and each P0 finding becomes a `notifications` record with `delivered: false` (deduplicated by item id). Of those five types, all but `PAYMENT_OVERDUE` are published (section 3); `SNAPSHOT_INGESTED` fires on every changed snapshot, so with monitoring on, triage runs on each one.

Delivery is NOT IMPLEMENTED. No code reads the `notifications` collection: there is no in-app, push, email or voice channel, and no route that lists notifications. Proactive monitoring has no test.

## 6. Interrupt Policy, P0 to P4

Priorities and their labels are in `core/enums.js` (`PRIORITY_LABEL`): P0 Critical, P1 Action today, P2 Action this week, P3 Monitor, P4 Information. What is implemented:

| Priority | In answers today (`core/attention.js`, used by `skills/index.js`) | Push policy (`deliveryFor`) | Push implemented? |
|---|---|---|---|
| P0 | Shown in "what needs me" when the need is DECIDE, APPROVE or DO | IMMEDIATE | Stored as a notification only with `proactive_monitoring` on; never delivered |
| P1 | Same; blocks "can I step away" | IMMEDIATE if `time_critical`, otherwise NEXT_BRIEFING | No |
| P2 | Same | NEXT_BRIEFING | No |
| P3 | Kept in the drill-down, never in "needs you" | ON_REQUEST | Not applicable |
| P4 | Kept in the drill-down | ON_REQUEST | Not applicable |

(a) `needsTahir()` surfaces only DECIDE, APPROVE or DO items at P2 or above. `executive()` drops anything whose need is NONE. `byAttention()` orders by priority, then risk, then due date, then amount.

(b) `deliveryFor()` is exported but nothing calls it. It is the written policy for when delivery exists, not running behaviour.

(c) Within a conversation, interruption is Tahir's: speaking over realtime voice cancels the voice's response, and touching, typing or Escape stops browser speech (`VOICE_ARCHITECTURE.md`). ROYAL never interrupts Tahir.
