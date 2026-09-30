# ROYAL ARCHITECTURE

Version: 0.1 (V1 foundation)

## 1. Shape

```
                                TAHIR
                                  |
                 text / voice (future) / UI action / automation / event
                                  |
                                  v
  +----------------------------------------------------------------+
  |                      ROYAL SERVICE (this repo)                  |
  |                                                                 |
  |  HTTP API  (server/handler.js, fetch standard, owner-only)      |
  |      |                                                          |
  |  ORCHESTRATOR (core/royal.js)                                   |
  |    context -> router -> skill -> delegation -> verify -> answer |
  |      |               |                    |                     |
  |  SKILLS          SPECIALISTS          CONSEQUENCE GATE          |
  |  (skills/)       ACE GRACE LEDGER     permissions -> tool or    |
  |                  FORGE (+ future)     decision -> execute ->    |
  |                                       verify -> audit           |
  |      |                                                          |
  |  REALMS                                                         |
  |   BUSINESS: royal_t (connected) | tahir_and_co | gold_buy |     |
  |             operations                                          |
  |   PERSONAL: wealth | calendar | personal_tasks                  |
  |      |                                                          |
  |  STORE (ROYAL's own): decisions, commitments, waiting, tasks,   |
  |  snapshots, audit (append-only), events (append-only)          |
  |  PROVIDER: Grok | none | future (core/providers/)               |
  +-------------------------------+--------------------------------+
                                  ^
                  rtj.house.v1 snapshot (push) | questions (ask)
                                  |
  +-------------------------------+--------------------------------+
  |        ROYAL T PROJECT CALCULATOR (authoritative, separate)     |
  |   House API: houseSnapshot() from its own canonical functions   |
  |   royal-embed.js loaded only when RTJ_CONFIG.ROYAL_URL is set   |
  +----------------------------------------------------------------+
```

## 2. Principles, and Where Each Is Enforced

| Principle | Enforced by |
|---|---|
| One intelligence | Every command enters `royal.handle()`. The UI has one command bar. The Agent Center is secondary. |
| ROYAL is not the database | Business facts come only from connectors (`realms/`). ROYAL stores its own objects, never its own copy of truth beyond the latest verified snapshot. |
| Permissions in code | `core/permissions.js` + `core/decisions.js#ConsequenceGate`. Prompts explain the rules; code enforces them. |
| Approval is never inferred | `DecisionService.resolve` requires an owner actor and an explicit resolution. |
| No fake functionality | Unconnected domains, tools and providers return NOT_CONNECTED and draw no conclusion (tested). |
| No silent hallucination | A failed provider yields "no answer was made up". A failed tool yields a structured failure with its impact. |
| Evidence labels | Every finding carries `evidence.label`. `validateResult` rejects VERIFIED without a source. |
| Exceptions first | `core/attention.js`. Items with need NONE never reach Tahir's surface. The briefing shows each item once. |
| Provider-agnostic | `core/providers/provider.js` interface. Grok is one file. |
| Modality-independent | `CommandInput {modality, content, context, user, timestamp}`. Voice will enter the same `handle()`. |

## 3. Request Lifecycle

1. `POST /v1/command` (owner token checked against Supabase auth, owner allow-list, rate limit).
2. `normalizeCommand`: modality validated, content capped at 2,000 characters.
3. Context: `resolveEntity` (selected entity, then explicit ID, then names, then conversation). Two equal matches return a clarification. A product-word-only match is weak and cannot hijack a general question.
4. Route: deterministic rules (`core/router.js`). Unmatched questions go to the open-question path.
5. Skill runs and consults specialists **in parallel**. Each consultation is a delegation record (objective, context, required output, 8-second deadline, constraints, approval boundary, verification requirement).
6. Verify: each specialist's result is validated. An invalid or timed-out result is dropped and shown as "did not report". It is never merged.
7. Synthesise into one `AgentResult` with a `surface` for the UI.
8. Audit (developer-level for answers; executive-level for decisions, approvals and executions).

## 4. Deployment

(a) `node server/node.js`: API plus the web app on one origin. Durable storage via `ROYAL_STORE_PATH` (atomic JSON file). Suitable for one small VM or container with a volume.

(b) `server/deno.js`: Deno Deploy or Supabase Edge. The in-memory store until the Postgres store is wired (`INTEGRATION_MODEL.md`).

(c) The calculator is deployed separately and unchanged in behaviour until `ROYAL_URL` is set in its `config.js`.

See `INTEGRATION_MODEL.md` for configuration and `SECURITY_MODEL.md` for the threat model.
