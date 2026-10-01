# ROYAL AGENT RUNTIME

*Sources: `makeCtx().consult()` in `core/royal.js`, `realms/business/royal-t/specialists.js`, `AgentTasks` in `core/intelligence/agents.js`.*

## 1. Native specialists

`consult(agentIds)` runs the requested specialists in parallel (`Promise.all`), each against an 8 second deadline. Each handoff records its objective, context (the entity id), required output (an AgentResult), deadline, constraints ("read only"), approval boundary and verification requirement. Each result is validated (`validateResult`); an invalid or late result is recorded as FAILED and its findings are not used. ROYAL then synthesizes and speaks in the first person.

## 2. Asynchronous tasks (Grok Bots)

A delegation to a Grok Bot is an AgentTask, kept in the store (kind `agent_tasks`), with an objective, deadline, boundaries and a status: ASSIGNED, IN_PROGRESS, WAITING, REPORTED_COMPLETE, VERIFIED_COMPLETE, FAILED, CANCELLED. A bot saying it is done is REPORTED_COMPLETE; VERIFIED_COMPLETE needs a check ROYAL can make. ROYAL does not wait on a bot: the conversation continues, and the bot's reply arrives in its feed.

## 3. Contracts

Handoff: `handoff_id`/`request_id`, agent, objective, entity ids, context, constraints, required output, deadline, permission boundary, verification requirement. Response: agent, the same id, status, summary, findings with evidence labels, sources, next actions, whether Tahir is needed. Bot events are records to show: nothing in the bridge can call a tool or create a decision.
