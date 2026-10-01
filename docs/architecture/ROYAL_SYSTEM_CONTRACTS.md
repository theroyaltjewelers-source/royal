# ROYAL SYSTEM CONTRACTS

(a) **Store** (`core/store.js`): get, put with compare-and-swap, list, append-only logs, readLog, hasKey. Conformance suite over memory, file and Postgres (`tests/store.test.js`).

(b) **AgentResult** (`core/result.js`, `validateResult`): every specialist result is validated before use; an invalid one is recorded as INVALID_RESULT and never used.

(c) **Tool result:** `{ ok, data, evidence: { label, source, verified_at, freshness } }` or `{ ok: false, failed_because, impact }` for every read tool (`RoyalTConnector.tools()`), through the permission gate.

(d) **Calculator snapshot** (`realms/business/royal-t/contract.js`, `rtj.house.v1`): validated on ingest; forbidden fields refused.

(e) **Grok Bot bridge:** webhook payload with `request_id` and `reply_endpoint`; events of four types with optional `request_id`; per-bot tokens; `publicBotView` the only shape that leaves.

(f) **Presentation spec** (`web/js/schema.js`): every answer's screen form is validated; rejected primitives never render.

(g) **Connection states:** systems report CONNECTED, DEGRADED, NOT_CONNECTED or DISABLED from observation; bots use the model in `ROYAL_BOT_HEALTH_MODEL.md`; self-diagnosis uses HEALTHY, DEGRADED, FAILED, NOT_CONFIGURED with evidence.

(h) **Mock data:** fixtures live only under `tests/`; with no provider or calculator, production reports NOT CONNECTED, never sample data (`ROYAL_INTELLIGENCE_EVALUATIONS.md`).
