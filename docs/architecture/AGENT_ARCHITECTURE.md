# AGENT ARCHITECTURE

See AGENT_ORCHESTRATION.md for routing, tasks and Grok Bot delegation.

## 1. Components

| Component (spec name) | Implementation |
|---|---|
| AgentRegistry | `core/registry.js#AgentRegistry`. Registration validates required fields and rejects duplicates. `covers(agent, domain)` is the realm wall. |
| AgentRouter | `core/router.js#route` (intent) + `core/context.js#resolveEntity` (target). |
| AgentRuntime | `core/royal.js#makeCtx().consult`: parallel delegation with deadline, validation and containment. |
| AgentContext | The `ctx` object: run id, text, now, entity, conversation, owners, read, consult, gate, store, provider, domains. |
| AgentToolRegistry | `tools` map in `core/royal.js`, fed by connectors (`RoyalTConnector.tools()`) and ROYAL's own internal tools. |
| AgentPermissionService | `core/permissions.js#PermissionService`. |
| AgentResult | `core/result.js#agentResult` and `validateResult`. |
| AgentRun | `run_id` on every result, delegation and audit record. |
| AgentAction | A gate request `{agentId, tool, args, domain, run_id}`. |
| AgentHandoff | Delegation records on `result.delegations`. The ACE to GRACE business handoff is described in the constitutions. |
| AgentMemoryService | `core/context.js#ConversationContext` (Layer 1) + store kinds (Layer 2). See `MEMORY_MODEL.md`. |
| AgentAuditService | `core/audit.js#AuditService`. |
| AgentEvaluationService | `tests/` (behavioural suite) and `docs/training/ROYAL_REAL_CASES.md`. Online metrics are future work (see section 5). |
| AIProvider | `core/providers/provider.js` (interface, `UnavailableProvider`, `ScriptedProvider`), `grok.js`. |

## 2. Registry (V1)

| id | Realms | Domains | Can request (becomes a Decision) |
|---|---|---|---|
| royal | Business, Personal | all | send_client_message, issue_refund, vendor_payment, change_project_price, approve_rush_request, production_change, change_policy |
| ace | Business | royal_t, tahir_and_co | send_client_message |
| grace | Business | royal_t, tahir_and_co | send_client_message, production_change |
| ledger | Business | royal_t, tahir_and_co, gold_buy | send_client_message, issue_refund, vendor_payment |
| forge | Business | all | deploy_production |
| house | Business | royal_t | none. Status NOT_CONNECTED: brand and marketing, registered so ROYAL can say plainly that it is not connected yet. |

There is no personal-realm specialist yet. The registry accepts one (tested with a hypothetical `vault` agent scoped to `wealth`). [TAHIR TO NAME]

### Registry metadata

`GET /v1/agents` returns, for each specialist, its capabilities, the tools it may use now, the time of its last recorded activity (from the audit ledger) and a health of OK, DEGRADED or NOT_CONNECTED. The interface shows a specialist as a node only when it took part in the current answer, and lists them all in the menu under Specialists.

## 3. The Agent Result Contract

```json
{
  "agent": "grace", "run_id": "run_...", "status": "OK | PARTIAL | NEEDS_CLARIFICATION | FAILED | NOT_CONNECTED",
  "summary": "one sentence",
  "findings": [{
    "id": "itm_...", "kind": "RISK | COMMITMENT | WAITING | RECEIVABLE | TREASURY | SALES | SYSTEM | DATA | DECISION",
    "code": "PAST_TARGET", "agent": "grace", "title": "...", "detail": "...",
    "entity": {"type": "project", "id": "PRJ-...", "name": "...", "client_name": "...", "client_id": "..."},
    "priority": "P0..P4", "risk": "GREEN..BLACK", "need": "KNOW|DECIDE|APPROVE|DO|DELEGATE|MONITOR|NONE",
    "owner": "Tahir", "next_action": "...", "due_at": 0, "verification": "...", "amount": 0,
    "evidence": {"label": "VERIFIED|REPORTED_UNVERIFIED|INFERENCE|RECOMMENDATION|UNKNOWN", "source": "calculator", "verified_at": 0, "freshness": "CURRENT"},
    "link": {"project": "PRJ-...", "section": "financials"}
  }],
  "priority": "P1", "risk": "RED", "confidence": null,
  "requires_tahir": true, "requires_approval": false,
  "sources": [], "entities": [], "next_actions": [], "delegated_actions": [], "unresolved_questions": [],
  "timestamp": 0, "surface": {"type": "..."}, "data": {}
}
```

`requires_tahir` and `requires_approval` are derived from the findings' `need`, never from prose.

## 4. Adding an Agent

1. Register it with realms, domains, allowed tools, profile, escalation target and version.
2. Implement `async (ctx) => agentResult(...)`, reading only through `ctx.read`.
3. Add it to `SPECIALISTS` and to the skills that should consult it.
4. Write its constitution in `docs/agents/`.
5. Add permission tests for its charter and its realm wall.

## 5. Evaluation (Prepared, Not Yet Automated)

The metrics named in the spec (routing accuracy, source accuracy, false and missed escalation, verification rate, approval accuracy, latency, failures) map to data ROYAL already records: route reason and confidence on each result, delegation verification flags, decision resolutions (approve or modify or reject rates by type), and tool failures in the developer log. A nightly evaluation job over the audit log is next-phase work.
