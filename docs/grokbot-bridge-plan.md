# Grok Bot bridge: plan

*Step 0 of the multi-bot bridge. Written 30 September 2026 before the change.*

## 1. What the repository actually is

(a) **Server.** No framework. `server/handler.js` exports `createHandler()`, a fetch-standard function `(Request) => Response`. `server/node.js` adapts it to `node:http` and also serves `web/`; `server/deno.js` hands it to `Deno.serve`. Routing is a chain of `if (method && path)` tests inside the handler.

(b) **Auth.** Also in the handler. A request without `Authorization: Bearer` gets 401 `AUTH_REQUIRED`. The token is tried first against the passcode verifier (`server/passcode.js`: `rs1.` tokens, HMAC with `ROYAL_SESSION_SECRET`, 30 days) and then against Supabase (`supabaseAuth`, calculator ingest). The result is a `user` with a role; only `owner` may use the API, `member` may only ingest. There is one per-token rate limit (120 a minute).

(c) **Passcode login** is `POST /v1/login {passcode}`; `passcode.login()` compares in constant time, locks an address out after five failures, and mints the `rs1.` token.

(d) **Database.** None. ROYAL's decisions and audit use `MemoryStore` or a JSON file (`core/store.js`). On Render there is no disk, so they are temporary.

(e) **Migrations.** None exist.

(f) **Tests.** Node's built-in runner, `npm test` = `node --test tests/*.test.js`. 97 passing on master.

(g) **Render.** No `render.yaml`; the service was set up by hand. Start command `node server/node.js` (`npm start`). One instance. No Render webhook: deploys are manual.

(h) **Runtime dependencies.** None, by rule (CLAUDE.md (a)).

## 2. What changes

| File | Change |
|---|---|
| `core/grokbot/bots.js` | New. Bot registry from `GROKBOT_*` env, realms per bot, public view without secrets. |
| `core/grokbot/tokens.js` | New. Mint, hash (SHA-256), look up by prefix, compare in constant time. |
| `core/grokbot/store.js` | New. `MemoryBridgeStore` (tests, no database) and `PgBridgeStore` (Postgres). Same async interface; every query filtered by `bot_id`. |
| `core/grokbot/pubsub.js` | New. In-process bus plus Postgres `LISTEN/NOTIFY` so streams work across instances. |
| `core/grokbot/bridge.js` | New. Send, events, feeds, requests, SSE streams, v1 compatibility. Returns plain `{status, body}` so it stays framework-neutral. |
| `server/migrations/001_grokbot.sql`, `server/migrate.js` | New. Tables, checks, the same-bot foreign key, indexes. Runner records applied migrations. |
| `server/handler.js` | Additive. Bot-token principals, the bot allow-list, the `/v1/bots/*`, `/v1/feed/stream` and `/v1/integrations/grokbot/*` routes. Existing routes untouched. |
| `server/node.js` | Streams response bodies instead of buffering them (SSE needs it), aborts on client disconnect, builds the bridge. |
| `web/js/bots.js`, `web/index.html`, `web/js/app.js`, `web/css/royal.css` | A Bots view in the menu: a tab per bot, safe markdown, a fetch-based stream reader, a composer. |
| `package.json` | Adds `pg`, loaded only when `DATABASE_URL` is set (ADR-011). |
| `tests/grokbot.test.js` | New. Step 8. |
| `docs/grokbot-bridge.md`, `docs/architecture/DECISIONS.md` | Setup and ADR-011. |

## 3. Schema

```
grokbot_requests  (id uuid pk, bot_id, realm, conversation_id, skill, content, status, requested_by,
                   created_at, updated_at, last_error, unique (id, bot_id))
grokbot_events    (id bigserial pk, bot_id, realm, request_id uuid null, type, content_markdown, status, author,
                   created_at, foreign key (request_id, bot_id) references grokbot_requests (id, bot_id))
                   index (bot_id, id), index (realm, id)
grokbot_bot_tokens(id uuid pk, bot_id, prefix unique, token_hash, created_at, last_used_at, revoked_at)
                   unique index on bot_id where revoked_at is null   (one active token per bot)
grokbot_bot_state (bot_id pk, last_seen, last_message_at, last_error)
```

Check constraints hold the status and type vocabularies and the realm values. The composite foreign key makes it impossible, at the database level, for an event to point at another bot's request.

## 4. Risks

(a) **A dependency.** `pg` breaks the zero-dependency rule. It is loaded lazily, only with `DATABASE_URL`, so ROYAL without a database still runs with none. Render must build with `npm install`. ADR-011 records the exception.

(b) **Name overlap.** Four external bot ids (`royal`, `ace`, `house`, `grace`) match ROYAL's internal specialists. They are different things: the specialists are ROYAL's own code, the bots are Grok Bot assistants outside ROYAL. They live in separate namespaces (`/v1/agents` and `/v1/bots`) and share no state or authority.

(c) **Streaming through the adapter.** `server/node.js` buffers every body today. Changing it to stream must not change any existing response. Tested by the existing suite plus stream tests.

(d) **Proxy buffering.** Render and Cloudflare do not buffer `text/event-stream` with `Cache-Control: no-transform` and a 25 second heartbeat, but this can only be confirmed on the live service. It is on the post-deploy checklist.

(e) **Memory fallback.** Without `DATABASE_URL` the bridge uses memory and says so in `/v1/bots` (`storage: "TEMPORARY"`). Tokens minted then are lost on restart.

(f) **Safety.** Bot events are records to read. Nothing in the bridge calls ROYAL's tools, decisions or executors, and bots cannot reach any other route.
