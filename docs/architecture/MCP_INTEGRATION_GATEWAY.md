# MCP INTEGRATION GATEWAY

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

## 1. Is MCP Implemented?

No. MCP is NOT IMPLEMENTED. There is no MCP client, server or transport anywhere in the repository; a search of the code and `package.json` finds the word only in a comment in `core/intelligence/gateway.js`.

The reason given there, and borne out by the code, is:

(a) None of the House's systems exposes an MCP server today. The Project Calculator pushes JSON snapshots over ROYAL's own House API; Resend, Hunter, Apollo and xAI are plain HTTPS APIs.

(b) ROYAL's own tools are JavaScript functions called in-process through `ConsequenceGate`. An MCP hop would add a transport and a process boundary without adding a capability or a control.

(c) Authority must stay in `core/permissions.js`. Direct adapters keep every call inside the one permission engine and the one audit log.

The gateway is shaped so that an MCP adapter could be registered later like any other: it would declare the same fields and report its own status.

## 2. The Contract

`IntegrationGateway` in `core/intelligence/gateway.js` is a registry of adapters. `register(a)` throws `ADAPTER_INVALID` unless the adapter declares all of:

| Field | Meaning |
|---|---|
| `id`, `system` | Machine id and human name |
| `entities` | The kinds of record the system holds |
| `reads` | Read actions, named as tools in `TOOL_POLICY` |
| `writes` | Write actions, named as tools in `TOOL_POLICY`; listed, never executed by the gateway |
| `events` | Events the system is expected to produce |
| `status()` | Live status: `{ status, detail }` |
| `transport` (optional) | Defaults to `internal` |

`describe()` returns every adapter with its live status. `read(id, action, args)` refuses an unknown adapter (`UNKNOWN_ADAPTER`), an undeclared read (`UNKNOWN_READ`) and an adapter that is not CONNECTED (`NOT_CONNECTED`), then calls the adapter's `read`.

Two facts about how it is used today:

(a) `read()` is never called. Every read in the product goes through `ConsequenceGate.request` against the tool map in `core/royal.js`. The gateway is descriptive: it feeds `GET /v1/intelligence/status` (`integrations: await royal.gateway.describe()`, in `server/handler.js`).

(b) Writes are declared so the planner and the status page know they exist. The only way a write happens is the approval flow in `APPROVAL_MODEL.md`.

## 3. Adapters as Implemented

`defaultGateway()` registers eleven adapters. Status is what `describe()` returns on a server with no keys and no calculator snapshot (probed).

| Adapter | System | Entities | Reads | Writes | Events | Status with no keys |
|---|---|---|---|---|---|---|
| calculator | Royal T Project Calculator; transport "House API rtj.house.v1 (pushed snapshots)" | Client, Project, Payment, Vendor, ProductionStage, Commitment, Treasury | get_active_projects, get_project, get_client, get_production_status, get_outstanding_balances, get_expected_payments, get_treasury, get_upcoming_deadlines, get_sales_pipeline | none | PAYMENT_RECEIVED, PAYMENT_OVERDUE, PRODUCTION_STAGE_CHANGED, PROJECT_READY, SNAPSHOT_INGESTED | NOT_CONNECTED, "The calculator has not sent its state." |
| research | Public web through the model provider's search | Company, Person, ResearchClaim, ResearchSource | web_search, web_fetch, company_search, person_search | none | none | NOT_CONFIGURED (needs `XAI_API_KEY` and `ROYAL_GROK_MODEL`) |
| contacts | Hunter, Apollo | ProfessionalContact, ContactVerification | email_find, email_verify | none | none | DISABLED (flag `email_discovery`); NOT_CONFIGURED when on without `HUNTER_API_KEY` or `APOLLO_API_KEY` |
| email | Outbound email (Resend) | Message | none | send_email | MESSAGE_SENT, MESSAGE_FAILED | NOT_CONFIGURED (needs `RESEND_API_KEY` and `ROYAL_EMAIL_FROM`) |
| grokbots | External Grok Bots through the bridge | BotRequest, BotEvent | none | delegate_to_bot | BOT_EVENT | CONNECTED whenever a bridge object exists, even with `GROKBOT_ENABLED` off |
| crm | CRM | Lead, Contact, Activity | none | none | none | NOT_CONNECTED, "No adapter yet." |
| calendar | Calendar | Appointment | none | none | none | NOT_CONNECTED |
| gold_buy | Gold Buy | Purchase, Quote | none | none | none | NOT_CONNECTED |
| quickbooks | QuickBooks | Invoice, Payment | none | none | none | NOT_CONNECTED |
| jewel360 | Jewel360 | Client, Sale | none | none | none | NOT_CONNECTED |
| instagram | Instagram / Meta | Post, Message | none | none | none | NOT_CONNECTED |

## 4. What Is Connected

**Project Calculator.** Connected in the sense that it works end to end: the calculator's page pushes a snapshot to `POST /v1/ingest/calculator`, `RoyalTConnector.ingest` validates it against contract `rtj.house.v1` (`realms/business/royal-t/contract.js`) and keeps the last good one. The adapter reports CONNECTED once any snapshot has been accepted (`RoyalTConnector.status`), with its age as the detail; freshness is judged separately and stale data blocks a clean bill of health (tested in `tests/royal.test.js`). The contract against a real calculator checkout is tested in `tests/calculator-contract.test.js`, which is skipped unless `RTJ_CALCULATOR_DIR` and `RTJ_SEED` are set.

**Research.** When research is CONNECTED, the `world` domain in `/v1/domains` reports CONNECTED too (`core/royal.js#domainState`). Real code against the xAI Responses API with server-side web search (`core/providers/grok.js`, `core/intelligence/research/engine.js`), plus `SafeFetcher` for cross-checking pages. NOT CONFIGURED without `XAI_API_KEY` and `ROYAL_GROK_MODEL`. Tested only against scripted providers.

**Contacts.** Real clients for Hunter (`https://api.hunter.io/v2/`, key in the `X-API-KEY` header) and Apollo (`https://api.apollo.io/api/v1/people/match`, with `reveal_personal_emails: false`) in `core/intelligence/research/contacts.js`, each with a daily quota (`HUNTER_DAILY_LIMIT`, default 200; `APOLLO_DAILY_LIMIT`, default 100). Off by default and NOT CONFIGURED without keys. Tested against fakes of Hunter's documented responses; Apollo has no test.

**Email.** `ResendEmailProvider` in `core/intelligence/comms.js`. NOT CONFIGURED without both keys, and even when configured nothing is sent unless `agent_external_send` is on. The status reports CONNECTED when the keys are set regardless of that flag; `intelligence.status().sending` reports the flag separately.

**Grok Bots.** The bridge in `core/grokbot/` is real and heavily tested (`tests/grokbot.test.js`). Both entries always build a bridge (`server/node.js` with `bridgeFromEnv`, `server/deno.js` with an in-memory `createBridge`). `intelligence.status().grok_bots` reads DISABLED when the bridge's master switch is off (`bridge.enabled()`), but this adapter's `status()` does not consult it and still reads CONNECTED. The adapter's status is therefore misleading when `GROKBOT_ENABLED` is not `true`. Delegation itself goes through the permission gate (`AGENT_ORCHESTRATION.md`, section 5), not through the gateway.

**CRM, Calendar, Gold Buy, QuickBooks, Jewel360, Instagram.** NOT CONNECTED. Placeholders with entities only; no reads, writes, events or code.

## 5. Events Declared but Not Produced

The `events` lists are declarations, not wiring.

(a) The calculator adapter lists `PAYMENT_OVERDUE`, which nothing publishes. `SNAPSHOT_INGESTED` is now published by `core/royal.js#ingestCalculator` on every accepted snapshot that changed (`EVENT_MODEL.md`).

(b) The email adapter lists `MESSAGE_SENT` and `MESSAGE_FAILED`. Both are in `EVENT_TYPE` (`core/enums.js`) and are published by `royal.resolveDecision` after an approved send executes. They come from ROYAL's own execution record, not from Resend: no Resend webhook receiver exists, so bounces reported later are NOT IMPLEMENTED.

(c) `BOT_EVENT` is the bridge's own feed record, carried by `core/grokbot/pubsub.js`, not the core `EventBus`.

## 6. Tests

The gateway itself has no dedicated test. `/v1/intelligence/status`, which returns `describe()` as `integrations`, is called through the handler in `tests/server.test.js` (owner only, no key in the body, research status one of NOT_CONFIGURED, DISABLED or CONNECTED, sending DISABLED by default); nothing asserts on the adapters' entries.
