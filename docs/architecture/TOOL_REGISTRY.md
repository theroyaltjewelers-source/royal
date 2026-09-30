# TOOL REGISTRY

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

Every tool ROYAL knows is described in two places, and only one of them carries authority.

(a) `TOOL_POLICY` in `core/permissions.js` is the authority: permission class, reversibility, and the `external`, `money`, `paid` and `external_read` markers. A tool that is not in `TOOL_POLICY` does not exist (`PermissionService.check` returns `UNKNOWN_TOOL`).

(b) `TOOL_META` in `core/intelligence/tools.js` is description only: category, human description, cost, latency, source type, whether it needs credentials, whether it is idempotent, and an audit label. It grants nothing.

The two must list the same tools. `tests/intelligence.test.js` ("every tool has registry metadata and a permission class") fails if either has an entry the other lacks. There are 46 tools today.

## 1. How the Catalogue Is Built

`toolCatalog(configured, { implemented, executors })` in `core/intelligence/tools.js` walks `TOOL_POLICY` and joins each entry to its `TOOL_META`. Risk is not stored per tool; it is derived from the class by the `RISK` map in the same file: READ, ANALYZE and DRAFT are LOW, INTERNAL_WRITE is MEDIUM, APPROVAL_REQUIRED is HIGH, PROHIBITED is PROHIBITED.

`createRoyal().tools()` in `core/royal.js` passes three things:

(a) `configured`, a map of tool id to `true`, `false` or a status string, from the running server:

| Tool | Configured when |
|---|---|
| web_search, company_search, person_search | `ResearchEngine.status()` is CONNECTED: a provider with search capability (`XAI_API_KEY` and `ROYAL_GROK_MODEL`) and `web_research` not switched off (`core/intelligence/research/engine.js`) |
| x_search | flag `x_search` on and the provider reports `x_search` capability |
| email_find | `ContactResearch.status().discovery`: DISABLED unless `email_discovery` is on, then CONNECTED if `HUNTER_API_KEY` or `APOLLO_API_KEY` is set, else NOT_CONFIGURED |
| email_verify | `ContactResearch.status().verification`: DISABLED unless `email_verification` is on, then CONNECTED only with `HUNTER_API_KEY` |
| web_fetch | a `SafeFetcher` was supplied (always, from `server/intelligence-env.js`, on both entries) |
| knowledge_search | a `KnowledgeEngine` was supplied (loaded from `docs/` at start, on both entries) |
| send_email | flag `agent_external_send` on and `ResendEmailProvider.configured()` (both `RESEND_API_KEY` and `ROYAL_EMAIL_FROM`) |
| create_crm_lead | always `false`: no CRM is connected |
| delegate_to_bot | a Grok Bot bridge exists and `advanced_agent_orchestration` is on |

(b) `implemented`: the tools that have code behind the gate (the keys of the tool map, which includes the intelligence `toolImpls`), plus `x_search` and `email_verify`, which run inside other tools.

(c) `executors`: the approval-class tools that have a registered executor in `DecisionService`.

**Status rule** (`toolCatalog`), first match wins:

| Status | When |
|---|---|
| PROHIBITED | the class is PROHIBITED |
| CONNECTED (approval class) | the class is APPROVAL_REQUIRED and the tool is configured `true` or `"CONNECTED"`, or it has an executor and no configuration entry |
| APPROVAL_ONLY | the class is APPROVAL_REQUIRED and nothing is connected to carry it out; `status_note` says "Can be approved; nothing is connected to carry it out, so a person does it." |
| CONNECTED / NOT_CONFIGURED / DISABLED | a configuration entry exists: `true` gives CONNECTED, `false` gives NOT_CONFIGURED, a string (for example DISABLED) is passed through |
| AVAILABLE | no configuration entry and the tool is implemented |
| NOT_IMPLEMENTED | no configuration entry and no code runs it; `status_note` says "Declared with its permission class; no code runs it yet." |

`configured` is true only for CONNECTED and AVAILABLE. Nothing is shown as AVAILABLE unless code exists to run it (tested: "review: the tool catalogue shows nothing as available that has no code behind it").

**`runs_inside`.** Two tools run only as part of another: `x_search` inside `web_search` (research adds X search when the flag is on) and `email_verify` inside `email_find` (verification runs inside `ContactResearch.businessEmail`). Their entries carry `runs_inside: "web_search"` and `runs_inside: "email_find"`; every other tool has `runs_inside: null`. Called through the gate on their own, they have no implementation and return `TOOL_NOT_CONNECTED`.

## 2. The Tools

Key: Idem. is `supports_idempotency` from `TOOL_META`. Audit is the `audit_behavior` label. Status is what `/v1/tools` reports with no keys and default flags (probed with `createRoyal({ store })`); where the server differs, both are given.

| Tool | Category | Class | Risk | Reversibility | Idem. | Audit | Status (no keys) |
|---|---|---|---|---|---|---|---|
| get_active_projects, get_project, get_client, get_production_status, get_upcoming_deadlines, get_open_commitments, get_waiting_items, get_recent_activity, get_sales_pipeline, get_decisions | HOUSE | READ | LOW | Reversible | yes | log | AVAILABLE |
| get_outstanding_balances, get_expected_payments, get_treasury | FINANCE | READ | LOW | Reversible | yes | log | AVAILABLE |
| get_system_status | ENGINEERING | READ | LOW | Reversible | yes | log | AVAILABLE |
| web_search | RESEARCH | READ (external_read) | LOW | Reversible | yes | log_query_and_sources | NOT_CONFIGURED |
| web_fetch | RESEARCH | READ (external_read) | LOW | Reversible | yes | log_url | NOT_CONFIGURED in a bare probe; CONNECTED on the server |
| x_search | RESEARCH | READ (external_read) | LOW | Reversible | yes | log | NOT_CONFIGURED; runs inside web_search |
| company_search, person_search | RESEARCH | READ (external_read) | LOW | Reversible | yes | log | NOT_CONFIGURED |
| email_find | RESEARCH | READ (external_read, paid) | LOW | Reversible | yes | log_status_only | DISABLED |
| email_verify | RESEARCH | READ (external_read, paid) | LOW | Reversible | yes | log_status_only | DISABLED; runs inside email_find |
| knowledge_search | HOUSE | READ | LOW | Reversible | yes | log | NOT_CONFIGURED in a bare probe; CONNECTED on the server |
| calculate | HOUSE | ANALYZE | LOW | Reversible | yes | log | AVAILABLE |
| analyze_project_risk, get_production_risk | HOUSE | ANALYZE | LOW | Reversible | yes | log | NOT_IMPLEMENTED |
| draft_client_update, draft_email | COMMUNICATION | DRAFT | LOW | Reversible | yes | log | AVAILABLE |
| draft_client_message | COMMUNICATION | DRAFT | LOW | Reversible | yes | log | NOT_IMPLEMENTED |
| delegate_to_bot | AGENTS | DRAFT | LOW | Reversible | no | log | NOT_CONFIGURED; CONNECTED with a bridge and `advanced_agent_orchestration` |
| request_approval | HOUSE | INTERNAL_WRITE (alwaysAllowed) | MEDIUM | Reversible | yes | log | NOT_IMPLEMENTED (Decisions are raised by the gate itself) |
| create_internal_task, record_commitment, record_waiting | HOUSE | INTERNAL_WRITE | MEDIUM | Reversible | yes | executive | AVAILABLE |
| send_client_message | COMMUNICATION | APPROVAL_REQUIRED (external) | HIGH | Irreversible | yes | executive | APPROVAL_ONLY |
| send_email | COMMUNICATION | APPROVAL_REQUIRED (external) | HIGH | Irreversible | yes | executive | APPROVAL_ONLY; CONNECTED with the flag and both Resend variables |
| create_crm_lead | HOUSE | APPROVAL_REQUIRED | HIGH | Reversible | yes | executive | APPROVAL_ONLY |
| issue_refund, vendor_payment | FINANCE | APPROVAL_REQUIRED (external, money) | HIGH | Difficult to reverse | no | executive | APPROVAL_ONLY |
| change_project_price | FINANCE | APPROVAL_REQUIRED | HIGH | Partially reversible | yes | executive | APPROVAL_ONLY |
| approve_rush_request | HOUSE | APPROVAL_REQUIRED | HIGH | Partially reversible | yes | executive | APPROVAL_ONLY |
| production_change | HOUSE | APPROVAL_REQUIRED | HIGH | Difficult to reverse | yes | executive | APPROVAL_ONLY |
| deploy_production | ENGINEERING | APPROVAL_REQUIRED | HIGH | Partially reversible | yes | executive | APPROVAL_ONLY |
| change_policy | HOUSE | APPROVAL_REQUIRED | HIGH | Reversible | yes | executive | APPROVAL_ONLY |
| delete_financial_record, move_money_autonomously | FINANCE | PROHIBITED | PROHIBITED | Irreversible | yes | log | PROHIBITED |
| delete_client_record | HOUSE | PROHIBITED | PROHIBITED | Irreversible | yes | log | PROHIBITED |

## 3. What the Statuses Do Not Mean

(a) AVAILABLE means code exists behind the gate. It is not a promise the data behind it exists: the House read tools show AVAILABLE even when the Project Calculator has sent nothing. The calculator's live state is in `/v1/status` and in the gateway (`MCP_INTEGRATION_GATEWAY.md`), not here.

(b) `send_client_message` shows APPROVAL_ONLY: its executor is registered only when `agent_external_send` is on and a messenger is supplied (`core/royal.js`), and no messenger exists in this version.

(c) `x_search` with the flag off shows NOT_CONFIGURED rather than DISABLED, because its configuration entry is a plain `false` for either cause.

(d) `delegate_to_bot` is configured from the bridge's presence and the flag, not from `GROKBOT_ENABLED`: with the flag on and the bridge's master switch off, it reads CONNECTED, and a delegation then fails at the bridge.

## 4. Audit Labels Are Descriptive

The `audit` value in `TOOL_META` is a label, not enforced behaviour. What actually happens is uniform and lives in `core/decisions.js`:

(a) Every allowed call is recorded by `ConsequenceGate.request` as `TOOL_CALLED` (or `TOOL_FAILED`, `TOOL_UNAVAILABLE`) with the tool, the permission verdict and the result. Arguments are not recorded, so no query or URL is logged by the gate, whatever the label says. Grok Bot delegation now goes through the gate, so it is recorded this way too (`AGENT_ORCHESTRATION.md`, section 5).

(b) Refusals are recorded as `PERMISSION_DENIED`, marked executive only when the reason is PROHIBITED.

(c) Approval-class requests create a Decision, recorded as executive `DECISION_CREATED`; resolution and execution are recorded as executive entries (`APPROVAL_MODEL.md`).

(d) `ContactResearch` records its own `CONTACT_RESEARCH` entry with the status only, never the address (`core/intelligence/research/contacts.js`), which matches the `log_status_only` label.

(e) `ResearchEngine.research` records its own `RESEARCH_RUN` entry with the first 120 characters of the question and the number of claims and sources, but not the source URLs (`core/intelligence/research/engine.js`). `SafeFetcher` records no audit entry for the URL it fetched.

## 5. The Route

`GET /v1/tools` (`server/handler.js`) returns `{ ok: true, tools: royal.tools() }`. Each entry has `id, name, description, category, permission_level, reversibility, risk_level, external, money, cost_hint, latency_hint, source_type, requires_auth, supports_idempotency, audit_behavior, runs_inside, configured, status, status_note`. Owner sign-in is required, like every route except `/v1/health`. `tests/server.test.js` ("intelligence routes: owner only, and no key in any of them") calls it through the handler: 401 signed out, 403 for a non-owner, 200 for the owner, no key in the body, and `send_email` reported as APPROVAL_REQUIRED.
