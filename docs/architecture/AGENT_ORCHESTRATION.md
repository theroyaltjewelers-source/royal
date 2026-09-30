# AGENT ORCHESTRATION

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

This document covers who does the work (the agent registry), how a request is matched to an agent, how delegated work is tracked, and how external Grok Bots are reached. The agent components and constitutions are in `AGENT_ARCHITECTURE.md`.

## 1. The Agent Registry

`AgentRegistry` in `core/registry.js` holds `AGENTS_V1`. `register()` refuses an agent missing any of `id, name, role, realms, domains, allowed_tools, permission_profile, escalation_target, status, version`, and refuses a duplicate id (tested: "a registered agent must be complete and unique", `tests/core.test.js`). Registered agents are deep-frozen.

| Agent | Status | Realms | Domains | Capabilities |
|---|---|---|---|---|
| royal | ACTIVE | BUSINESS, PERSONAL | * | route, delegate, synthesise, brief, triage, request_approval, research, knowledge, calculate, plan |
| ace | ACTIVE | BUSINESS | royal_t, tahir_and_co, world | pipeline, lead_followup, qualification, handoff, outreach, prospecting |
| grace | ACTIVE | BUSINESS | royal_t, tahir_and_co | production, client_updates, pickup, qc |
| ledger | ACTIVE | BUSINESS | royal_t, tahir_and_co, gold_buy | receivables, cash, margins, leakage |
| house | NOT_CONNECTED | BUSINESS | royal_t, tahir_and_co | content, campaigns, brand_standards |
| forge | ACTIVE | BUSINESS | * | connector_health, data_integrity, incidents |

`covers(agentId, domainId)` is the realm wall: an agent may touch a domain only if the domain's realm is in the agent's realms and the domain is listed (or the agent has `*`).

## 2. Least Privilege per Agent

Each agent's `allowed_tools` is its charter. `PermissionService.check` in `core/permissions.js` refuses anything not listed (`TOOL_NOT_IN_CHARTER`), with wildcards `*read`, `*analyze`, `*draft` expanding to a whole class.

(a) ROYAL holds the three wildcards, the internal writes, and a list of approval-class tools it may request. Requesting one only creates a Decision.

(b) ACE may read the pipeline, projects and clients, draft (`draft_client_update`, `draft_email`), search House knowledge, and request `send_client_message`, `send_email` and `create_crm_lead`. It cannot read money tools.

(c) GRACE reads production, waiting items, commitments and deadlines, drafts client updates, and may request `send_client_message` and `production_change`.

(d) LEDGER reads balances, expected payments and Treasury, and may request `send_client_message`, `issue_refund` and `vendor_payment`. It holds no draft tool, which is why "LEDGER does not write client messages" (`tests/royal.test.js`).

(e) FORGE reads system status and the activity log and may request `deploy_production`.

(f) HOUSE has an empty charter and is NOT_CONNECTED, so the check refuses it with `AGENT_INACTIVE` before its charter is read.

(g) No agent holds a PROHIBITED tool; the check refuses those before looking at the agent.

## 3. Routing

There are two routing paths.

**House skills.** `createRoyal().handle()` in `core/royal.js` picks a skill (`core/intent.js#interpret`), and each skill names its specialists in its definition (`skills/index.js`). `ctx.consult(agentIds)` runs them in parallel with an 8 second timeout (`DELEGATION_TIMEOUT_MS`), validates each result, and records a delegation entry per agent. TEST H ("Why is this project behind?") proves GRACE and LEDGER are consulted over House data.

**Capability routing.** `routeAgents(intent, text, { registry, bots, flags })` in `core/intelligence/agents.js` decides from data, not per-request branches:

(a) If the intent names an agent (`intent.entities.agent`), that agent is returned with reason "named by Tahir".

(b) Otherwise the intent maps to a capability through the `NEED` table (`outreach_draft` to `outreach`, `prospecting` to `prospecting`; research, knowledge, calculation and House state map to `null`, meaning ROYAL answers itself).

(c) For `unknown` or `delegate` intents, the text is matched against `TOPIC_CAPS` (campaigns, production, receivables, outreach, connector_health).

(d) The registry is filtered for specialists holding that capability, at most two, and each is given an adapter by `adapterFor`.

**Where it runs.** `doOutreach` in `core/intelligence/index.js` picks its writer with `routeAgents({ ...intent, intent: "outreach_draft" }, text, { registry, flags })`: the agent Tahir named, or else the first specialist with the `outreach` capability (ACE, the only one that holds it). If no route comes back it falls back to ACE. If the chosen agent is not ACTIVE, ROYAL says it isn't connected and that ACE can write it. The rules interpreter fills `entities.agent` with `ace` when no agent is named (`INTENT_ENGINE.md`, section 3 (e)), so for rule-classified outreach the route is recorded as "named by Tahir" even when Tahir named no one; the capability path is taken when the model interpreter leaves the agent null.

Grok Bot delegation is triggered separately, in `handle()`, by the House `delegate_draft` skill naming an agent that is not ACTIVE (section 5). `routeAgents` is also exposed as `intelligence.routeAgents`. It has no test of its own; the outreach flows in TESTS A to E exercise it through `doOutreach`.

## 4. Adapters

`adapterFor` in `core/intelligence/agents.js`:

(a) An ACTIVE agent uses the `internal` adapter: ROYAL's own specialists in `realms/business/royal-t/specialists.js` (`ace, grace, ledger, forge`).

(b) A non-active agent uses `grokbot` only when `advanced_agent_orchestration` is on and the bridge lists a bot with the same id whose status is CONNECTED.

(c) Otherwise it is unavailable, with a plain reason: the flag is off, the bot's status, or "not connected yet".

## 5. GrokBotAdapter

`GrokBotAdapter` wraps the existing bridge (`core/grokbot/bridge.js`, documented in `docs/grokbot-bridge.md`).

**Through the gate.** `doBotDelegation` in `core/intelligence/index.js` first checks the bot's status with `bots.status(agentId)` and stops unless it is CONNECTED. It then calls `gate.request({ agentId: "royal", tool: "delegate_to_bot", domain: "world", args: { agent, objective, handoff, conversation_id } })`, so the delegation is permission-checked by `PermissionService.check` (`delegate_to_bot` is DRAFT class, held by ROYAL through `*draft`) and audited as `TOOL_CALLED` or `TOOL_FAILED`. The gate's tool implementation (`toolImpls.delegate_to_bot`) calls the adapter. A refusal is reported ("I can't hand that to X") and nothing is sent. The test "review: bot delegation goes through the permission gate and is audited" checks the source of `doBotDelegation` for the gate call and for the absence of a direct `bots.delegate(` call; the behaviour itself is exercised by "Grok Bot delegation happens only when switched on".

**What is real.** `delegate()` creates an AgentTask, then calls `bridge.sendMessage(agent, { content, skill: "royal_task", conversation_id: task.id })`, which POSTs to that bot's webhook (`GROKBOT_<ID>_WEBHOOK_URL` with `GROKBOT_<ID>_WEBHOOK_KEY`). The message says "Do not contact anyone or take any action; ROYAL and Tahir decide actions" and carries the structured handoff as data. The bot answers later by posting events with its own token; those events are records only (tested in `tests/grokbot.test.js`, "bot events are records only").

**What the statuses mean.** `status(botId)` returns NOT_CONNECTED when there is no bridge or the bot is not in the realm. The bridge's own CONNECTED (`core/grokbot/bots.js`) means a webhook URL is configured and the bot is enabled; it does not mean the bot has answered or is reachable. `intelligence.status().grok_bots` is NOT_CONNECTED with no bridge, DISABLED when the bridge's master switch is off (`bridge.enabled()` is false, which is the case unless `GROKBOT_ENABLED` is `true`), and CONNECTED otherwise. The gateway's `grokbots` adapter and the tool catalogue do not consult `bridge.enabled()` and still read CONNECTED whenever a bridge exists (`MCP_INTEGRATION_GATEWAY.md`, `TOOL_REGISTRY.md`).

## 6. AgentTasks

`AgentTasks` in `core/intelligence/agents.js` stores tasks in the `agent_tasks` collection. Each has `objective, handoff, deadline` (default 24 hours), `constraints` ("no external action", "no money", "report only"), `approval_boundary`, `verification_method`, `conversation_id`, `request_id` and a `history` of status changes.

| Status | Set by |
|---|---|
| ASSIGNED | `create()`; also `refresh()` when the bridge request is `requested` |
| IN_PROGRESS | `delegate()` on a delivered webhook; `refresh()` on `delivered` or `in_progress` |
| WAITING | NOT IMPLEMENTED: nothing sets it |
| REPORTED_COMPLETE | `refresh()` when the bridge request is `completed` |
| FAILED | `delegate()` when the webhook fails; `refresh()` on `failed` |
| CANCELLED | `cancelOpen(conversation_id)`, called by "stop" and the other cancellations (`APPROVAL_MODEL.md`, section 4) |
| VERIFIED_COMPLETE | NOT IMPLEMENTED: nothing sets it |

**Overdue.** A task past its deadline keeps its status and gets `overdue: true` from `refresh()`, as long as it is not REPORTED_COMPLETE, FAILED or CANCELLED. The two facts are kept apart: an overdue task is still, for example, IN_PROGRESS. Overdue is not tested.

`refresh()` only applies to `grokbot` tasks and reads `bridge.getRequest`, so `overdue` is only ever set on bot tasks. Cancelling a task changes ROYAL's record only; nothing is sent to the bot. Internal specialists do not create AgentTasks; their work is recorded as delegation entries on the result.

`GET /v1/agents/tasks` (`server/handler.js`) returns `tasks.list({})`, refreshed from the bridge; it is called through the handler in `tests/server.test.js` (owner only, no key in the body). `GET /v1/agents` returns registry metadata plus the last audit entry per agent; its `current_task` is always `null`. The delegation test ("Grok Bot delegation happens only when switched on", `tests/intelligence.test.js`) checks the task is IN_PROGRESS with adapter `grokbot`.

## 7. The Structured Result Contract

`agentResult()` in `core/result.js` builds every result: `agent, run_id, status, summary, findings, priority, risk, confidence, requires_tahir, requires_approval, sources, entities, next_actions, delegated_actions, unresolved_questions, timestamp, surface, data`. Priority is the highest finding priority (P4 when none), risk the highest finding risk (GREEN when none). `requires_tahir` is true when any finding needs something other than NONE or MONITOR; `requires_approval` when any needs APPROVE.

`validateResult()` requires the core fields, known status, priority and risk, a title and evidence label on each finding, and a source on any VERIFIED finding. In `consult()`, an invalid result is replaced by a FAILED result and marked `verified: false`; a throw or timeout is contained the same way (tested: "a specialist that throws is contained", "a result claiming VERIFIED with no source is invalid").

A Grok Bot's report is never verified: the delegation entry is `verified: false`, and its content is a feed record, not a finding.
