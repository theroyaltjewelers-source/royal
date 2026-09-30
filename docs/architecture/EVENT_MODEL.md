# EVENT MODEL

Source: `core/events.js`. Tests: duplicate event, ingest change events.

## 1. V1 Design

(a) An in-process `EventBus` with an append-only `events` log and synchronous subscribers. The log is the seam: a queue can replace it later without changing publishers or subscribers.

(b) Every event has a `key`. A second publish with the same key is recognised and skipped (`{duplicate: true}`). This protects against retried deliveries and repeated snapshots.

(c) A subscriber that throws does not stop other subscribers. The failure is audited (`EVENT_HANDLER_FAILED`).

## 2. Event Types

`PAYMENT_RECEIVED, PAYMENT_OVERDUE, CLIENT_MESSAGE_RECEIVED, CLIENT_UPDATE_DUE, LEAD_CREATED, LEAD_QUALIFIED, CONSULTATION_SCHEDULED, DESIGN_DEPOSIT_RECEIVED, CAD_RECEIVED, CAD_APPROVED, PRODUCTION_STAGE_CHANGED, MATERIALS_RECEIVED, VENDOR_STATUS_CHANGED, SHIPMENT_CREATED, SHIPMENT_DELAYED, QC_COMPLETED, PROJECT_READY, APPOINTMENT_CREATED, COMMITMENT_CREATED, COMMITMENT_DUE, COMMITMENT_OVERDUE, DECISION_REQUIRED, SYSTEM_ERROR, INTEGRATION_FAILED, DATA_CONFLICT_DETECTED, SNAPSHOT_INGESTED`.

## 3. What Emits Today

| Source | Event | Key |
|---|---|---|
| Snapshot diff: payment rose | PAYMENT_RECEIVED | type:project:digest |
| Snapshot diff: stage changed | PRODUCTION_STAGE_CHANGED, or PROJECT_READY when the new stage is Ready | type:project:digest |
| Snapshot diff: target date changed | COMMITMENT_CREATED | type:project:digest |
| Snapshot diff: new project | LEAD_CREATED | type:project:digest |
| Rejected snapshot | INTEGRATION_FAILED | hash of errors plus the hour |

Events for messages, shipping, CAD and appointments need their integrations and are reserved.

## 4. State Deltas ("What changed?")

`realms/business/royal-t/changes.js#diffSnapshots` compares two verified snapshots: payments recorded or voided, stage changes, target date changes, value changes, health worsening or recovering, projects added or removed, Treasury exceptions new or resolved. Baseline: the "last seen" checkpoint, otherwise the first snapshot of the day (Eastern), otherwise the previous snapshot. "Mark as seen" moves the checkpoint.

## 5. Proactive Intelligence

With `proactive_monitoring` on, change events trigger a triage, and each P0 item becomes a `notifications` record (deduplicated by item). Delivery channels (in-app, push, email, voice) read from that store. The notification policy is in `core/attention.js#deliveryFor`: P0 immediately; P1 immediately only if time-critical; P2 at the next briefing; P3 and P4 on request.
