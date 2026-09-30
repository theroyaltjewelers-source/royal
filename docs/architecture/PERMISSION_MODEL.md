# PERMISSION MODEL

Source: `core/permissions.js`. Tests: `tests/core.test.js` ("permission", "gate", "decisions" groups).

## 1. Classes

| Class | Meaning | V1 behaviour |
|---|---|---|
| READ | Retrieve a fact | Executes if the agent's charter lists it and the domain is inside its realm |
| ANALYZE | Derive an assessment | Same as READ |
| DRAFT | Produce text; send nothing | Executes |
| INTERNAL_WRITE | Change ROYAL's own records (tasks, recorded commitments, waiting items) | Becomes a Decision while `agent_internal_write` is off (the default). Executes when on. `request_approval` itself is always allowed. |
| APPROVAL_REQUIRED | Consequential action | Always becomes a Decision, whatever the flags |
| PROHIBITED | Never | Refused to every agent, ROYAL included, and audited |

## 2. Tool Policy

| Tool | Class | Reversibility |
|---|---|---|
| get_active_projects, get_project, get_client, get_production_status, get_outstanding_balances, get_expected_payments, get_treasury, get_upcoming_deadlines, get_open_commitments, get_waiting_items, get_recent_activity, get_sales_pipeline, get_decisions, get_system_status | READ | Reversible |
| analyze_project_risk, get_production_risk | ANALYZE | Reversible |
| draft_client_update, draft_client_message | DRAFT | Reversible |
| request_approval, create_internal_task, record_commitment, record_waiting | INTERNAL_WRITE | Reversible |
| send_client_message | APPROVAL_REQUIRED | Irreversible |
| issue_refund, vendor_payment | APPROVAL_REQUIRED | Difficult to reverse |
| production_change | APPROVAL_REQUIRED | Difficult to reverse |
| change_project_price, approve_rush_request, deploy_production | APPROVAL_REQUIRED | Partially reversible |
| change_policy | APPROVAL_REQUIRED | Reversible |
| delete_financial_record, delete_client_record, move_money_autonomously | PROHIBITED | Irreversible |

A tool not in this table does not exist (`UNKNOWN_TOOL`).

## 3. The Check, in Order

1. The tool exists. Otherwise `UNKNOWN_TOOL`.
2. The tool is not PROHIBITED. Otherwise `PROHIBITED` (and an executive audit entry).
3. The agent exists and is ACTIVE. Otherwise `UNKNOWN_AGENT` or `AGENT_INACTIVE`.
4. The tool is in the agent's charter (directly or via `*read`, `*analyze`, `*draft`). Otherwise `TOOL_NOT_IN_CHARTER`.
5. The domain is inside the agent's realms and domains. Otherwise `REALM_BOUNDARY`.
6. APPROVAL_REQUIRED means `requiresApproval`, and the gate creates a Decision.
7. INTERNAL_WRITE with the flag off means `requiresApproval` (`INTERNAL_WRITE_DISABLED`).
8. Otherwise allowed, and the gate executes, then audits.

## 4. Decisions and Approval

(a) A Decision is created idempotently from a dedupe key. The same open question never produces two cards.

(b) Only an actor with `role: "owner"` can resolve. On the server, `role` comes from the owner allow-list (`ROYAL_OWNER_IDS`), never from the request body.

(c) Resolutions: APPROVE, MODIFY (with changed arguments, for example an edited draft), REJECT. Silence, expiry and ambiguous text resolve nothing.

(d) After approval: execute through the registered executor, then run its `verify()`, then audit. Statuses: EXECUTED, VERIFIED, FAILED (execution or verification), or APPROVED with `NO_EXECUTOR` when nothing connected can carry it out. In that case ROYAL says a person must do it.

(e) V1 executors: `create_internal_task` only. `send_client_message` gets an executor only when `agent_external_send` is on **and** a messenger integration is supplied. Neither is true in V1.

(f) A second resolution attempt returns `ALREADY_<STATUS>` (HTTP 409).

## 5. Flags (V1 defaults)

| Flag | Default | Effect |
|---|---|---|
| agent_internal_write | off | Internal writes need approval |
| agent_external_send | off | No client message is ever sent by ROYAL |
| proactive_monitoring | off | No proactive notifications are created |
| voice_input | off | Reserved |
| automated_followup | off | Reserved |
| production_risk_engine | on | Read-only analysis |
| llm_synthesis | on | Use the language provider for open questions when one is connected |

Set with `ROYAL_FLAGS='{"agent_internal_write":true}'`.

## 6. Reversibility and Scrutiny

Decision cards show reversibility beside the approve button. Approval-class tools that are irreversible or hard to reverse carry the highest risk label from their source item, and never gain an executor without a recorded ADR.
