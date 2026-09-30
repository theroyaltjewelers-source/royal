# PERMISSION MODEL

Source: `core/permissions.js`. Tests: `tests/core.test.js` ("permission", "gate", "decisions" groups) and `tests/intelligence.test.js` ("every tool has registry metadata and a permission class"). Updated 30 September 2026 for branch feature/intelligence. Tool descriptions, risk and live configuration are in `TOOL_REGISTRY.md`; the full approval flow is in `APPROVAL_MODEL.md`.

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
| web_search, web_fetch, x_search, company_search, person_search | READ, marked `external_read` | Reversible |
| email_find, email_verify | READ, marked `external_read` and `paid` | Reversible |
| knowledge_search | READ | Reversible |
| calculate, analyze_project_risk, get_production_risk | ANALYZE | Reversible |
| draft_client_update, draft_client_message, draft_email | DRAFT | Reversible |
| delegate_to_bot | DRAFT | Reversible |
| request_approval, create_internal_task, record_commitment, record_waiting | INTERNAL_WRITE | Reversible |
| send_client_message, send_email | APPROVAL_REQUIRED, marked `external` | Irreversible |
| create_crm_lead | APPROVAL_REQUIRED | Reversible |
| issue_refund, vendor_payment | APPROVAL_REQUIRED, marked `external` and `money` | Difficult to reverse |
| production_change | APPROVAL_REQUIRED | Difficult to reverse |
| change_project_price, approve_rush_request, deploy_production | APPROVAL_REQUIRED | Partially reversible |
| change_policy | APPROVAL_REQUIRED | Reversible |
| delete_financial_record, delete_client_record, move_money_autonomously | PROHIBITED | Irreversible |

A tool not in this table does not exist (`UNKNOWN_TOOL`).

The markers `external`, `money`, `paid` and `external_read` describe the tool; the check itself decides only by class. `external` and `money` are copied into the tool catalogue. `paid` and `external_read` are not read by any code today; paid contact lookups are held back by their own flags instead (section 5).

`delegate_to_bot` (DRAFT class) is checked like any other tool: `core/intelligence/index.js#doBotDelegation` calls `gate.request({ agentId: "royal", tool: "delegate_to_bot" })`, and the tool implementation hands the work to the bridge (see `AGENT_ORCHESTRATION.md`).

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

(e) Executors (`core/royal.js`): `create_internal_task` always. `send_client_message` only when `agent_external_send` is on **and** a messenger integration is supplied; no messenger exists in this version. `send_email` only when `agent_external_send` is on **and** Resend is configured (`RESEND_API_KEY` and `ROYAL_EMAIL_FROM`). Executors are registered once, when ROYAL is built, so changing a flag needs a restart.

(f) A second resolution attempt returns `ALREADY_<STATUS>` (HTTP 409).

(g) An approval is for the exact action. The email executor refuses to send if the message differs from the one the Decision was raised for, unless Tahir approved a modified version (`APPROVAL_MODEL.md`, section 2).

## 5. Flags (V1 defaults)

| Flag | Default | Effect |
|---|---|---|
| agent_internal_write | off | Internal writes need approval |
| agent_external_send | off | No client message or email is ever sent by ROYAL: approved sends record `NO_EXECUTOR` |
| proactive_monitoring | off | No proactive notifications are created |
| voice_input | off | Reserved; no code reads it |
| automated_followup | off | Reserved; no code reads it |
| production_risk_engine | on | Read-only analysis. No code reads this flag today |
| llm_synthesis | on | Use the language provider for open questions, and for model intent classification, when one is connected |
| web_research | on | Research may run; it still needs `XAI_API_KEY` and `ROYAL_GROK_MODEL`. Off makes research DISABLED |
| x_search | off | Adds X search to research when the provider supports it |
| people_research | on | Executive research ("Who is the CFO of ...?"). Off returns "People research is switched off." |
| email_discovery | off | Paid contact discovery through Hunter or Apollo (`HUNTER_API_KEY`, `APOLLO_API_KEY`) |
| email_verification | off | Paid deliverability checks through Hunter |
| realtime_voice | off | Allows `POST /v1/voice/session`; needs `XAI_API_KEY` (`VOICE_ARCHITECTURE.md`) |
| advanced_agent_orchestration | off | Allows delegation to external Grok Bots through the bridge |

Set with `ROYAL_FLAGS='{"agent_internal_write":true}'`.

## 6. Reversibility and Scrutiny

Decision cards show reversibility beside the approve button. Approval-class tools that are irreversible or hard to reverse carry the highest risk label from their source item, and never gain an executor without a recorded ADR.
