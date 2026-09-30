# PROVIDER CONFIGURATION

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

This is every environment variable the server reads, found by searching `server/` and `core/` for `process.env`, `Deno.env` and `env.`. Values are read in five places: `server/node.js` (the Node entry), `server/deno.js` (the Deno entry), `server/handler.js#fromEnv`, `server/intelligence-env.js#intelligenceFromEnv`, and the Grok Bot bridge (`core/grokbot/bots.js#loadBotRegistry`, `core/grokbot/bridge.js#bridgeFromEnv`, `core/grokbot/store.js#poolConfig`). `server/migrate.js` reads the database variables too.

## 1. Where secrets live

Secrets live only in the server's environment, which in production is Render's environment settings. They never go in `web/config.js`, which is served to every browser. That file holds only the API origin, the identity URL and the Supabase anon key, which Supabase designs to be public. No provider key is ever sent to a browser, a log or a response: `GrokProvider.toJSON` omits the key, a test checks the key is never serialised, and `publicBotView` never includes a bot's URL, key or header.

## 2. Core

| Variable | Default | Meaning | Secret |
|---|---|---|---|
| `PORT` | 8787 | HTTP port (`server/node.js`) | no |
| `ROYAL_ENV` | unset | If `production`, the server refuses to start with `ROYAL_DEV_OWNER_TOKEN` set | no |
| `ROYAL_STORE_PATH` | unset (memory) | File path for ROYAL's store, used when `DATABASE_URL` is not set. Without either, decisions, audit, research cache and contact cache are lost on restart | no |
| `ROYAL_IMPORT_FILE_STORE` | off | `true` imports the file at `ROYAL_STORE_PATH` into an empty Postgres store once, at start (section 11) | no |
| `ROYAL_TZ_OFFSET_MIN` | -240 | House time zone offset in minutes | no |
| `ROYAL_ALLOWED_ORIGINS` | empty | Comma list of origins for CORS; also added to the CSP `frame-ancestors` | no |

## 3. Auth

| Variable | Default | Meaning | Secret |
|---|---|---|---|
| `ROYAL_OWNER_PASSCODE` | unset | Owner passcode, 10 or more characters (`server/passcode.js`) | yes |
| `ROYAL_SESSION_SECRET` | unset | HMAC key for session tokens, 32 or more characters | yes |
| `ROYAL_SESSION_DAYS` | 30 | Session length in days | no |
| `ROYAL_IDENTITY_URL` | unset | Supabase project URL for calculator sign-in (`supabaseAuth`) | no |
| `ROYAL_IDENTITY_ANON_KEY` | unset | Supabase anon key | no (public by design) |
| `ROYAL_OWNER_IDS` | empty | Comma list of Supabase user ids treated as owner | no |
| `ROYAL_MEMBER_IDS` | empty | Comma list of user ids that may only post calculator snapshots | no |
| `ROYAL_DEV_OWNER_TOKEN` | unset | Local development only: a fixed owner token. Refused when `ROYAL_ENV=production` | yes |

Passcode sign-in is off, with a warning logged, unless both the passcode and the secret meet their minimum lengths.

## 4. Calculator

There is no calculator variable. The calculator pushes snapshots to `POST /v1/ingest/calculator`, authenticated as an owner or a member.

## 5. Language model (xAI)

| Variable | Default | Meaning | Secret |
|---|---|---|---|
| `XAI_API_KEY` | unset | xAI key (`GrokProvider`) | yes |
| `ROYAL_GROK_MODEL` | unset | Main model. Required: without it the provider is `NOT_CONNECTED` | no |
| `ROYAL_GROK_FAST_MODEL` | unset | Optional cheaper model for reasoning levels 0 and 1 (`modelFor`) | no |

If neither the key nor the model is set, the entry installs `UnavailableProvider`. If only one is set, `GrokProvider.status()` reports `NOT_CONNECTED` and names the missing variable. `server/node.js` and `server/deno.js` now build `GrokProvider` the same way, with the key, the main model, the fast model, `ROYAL_VOICE_MODEL`, `ROYAL_VOICE` and the shared metrics.

## 6. Research

Web research has no variables of its own. It is NOT CONFIGURED until `XAI_API_KEY` and `ROYAL_GROK_MODEL` are set, and is controlled by flags `web_research`, `x_search` and `people_research` (section 12).

## 7. Contacts

| Variable | Default | Meaning | Secret |
|---|---|---|---|
| `HUNTER_API_KEY` | unset | Hunter Email Finder, Domain Search and Email Verifier | yes |
| `HUNTER_DAILY_LIMIT` | 200 | Hunter calls a day, per process | no |
| `APOLLO_API_KEY` | unset | Apollo People Match | yes |
| `APOLLO_DAILY_LIMIT` | 100 | Apollo calls a day, per process | no |

Keys alone do nothing: flags `email_discovery` and `email_verification` are off by default. Both entries read these through `intelligenceFromEnv()`.

## 8. Email

| Variable | Default | Meaning | Secret |
|---|---|---|---|
| `RESEND_API_KEY` | unset | Resend key (`ResendEmailProvider`) | yes |
| `ROYAL_EMAIL_FROM` | unset | Sender address | no |

Both are needed for `configured()`. Sending also needs flag `agent_external_send`, and every send goes through an approved Decision (`core/royal.js` registers the `send_email` executor only when all three hold).

## 9. Voice

| Variable | Default | Meaning | Secret |
|---|---|---|---|
| `ROYAL_VOICE_MODEL` | `grok-voice-latest` | Realtime voice model | no |
| `ROYAL_VOICE` | `ara` | ROYAL's voice, for spoken replies and realtime voice alike. xAI voices: `ara` (warm, conversational, female), `eve` (energetic, female), `leo`, `rex`, `sal` (male) | no |

ROYAL's spoken replies (`POST /v1/voice/speak`, flag `spoken_voice`, on) and realtime voice (`POST /v1/voice/session`, flag `realtime_voice`, off) both need `XAI_API_KEY` and both are Business only (409 `SPEECH_BUSINESS_ONLY` and `VOICE_BUSINESS_ONLY` for `realm=PERSONAL`). Spoken replies cost per reply at xAI; set `ROYAL_FLAGS={"spoken_voice":false}` to return every device to its own voice. If `ROYAL_VOICE` is set to `eve` in Render from before, remove it (or set it to `ara`) to hear the new voice.

## 10. Grok Bot bridge

| Variable | Default | Meaning | Secret |
|---|---|---|---|
| `GROKBOT_ENABLED` | off | Master switch; must be `true`. When it is not, `GET /v1/intelligence/status` reports `grok_bots: "DISABLED"` (`bridge.enabled()`) | no |
| `GROKBOT_BOTS` | `skill_library,royal,ace,house,grace,me_bot,grok_bot` | Bot ids (`skill_library` is always added) | no |
| `GROKBOT_<ID>_WEBHOOK_URL` | unset | The bot's inbound webhook; https only | no |
| `GROKBOT_<ID>_WEBHOOK_KEY` | unset | Key ROYAL sends to the bot | yes |
| `GROKBOT_<ID>_KEY_HEADER` | `Authorization` | Header name; `Authorization` is sent as `Bearer <key>` | no |
| `GROKBOT_<ID>_NAME` | built-in name | Display name | no |
| `GROKBOT_<ID>_ENABLED` | on | `false` switches one bot off | no |
| `GROKBOT_<ID>_REALMS` | `BUSINESS` (`skill_library`: both) | Comma list of realms | no |
| `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY`, `GROKBOT_KEY_HEADER` | unset | Legacy v1 names, used for `skill_library` only | key: yes |
| `GROKBOT_ALLOW_INSECURE_WEBHOOKS` | off | `true` permits http webhooks; for tests | no |

## 11. Database

| Variable | Default | Meaning | Secret |
|---|---|---|---|
| `DATABASE_URL` | unset (memory) | Postgres for ROYAL's own store and the Grok Bot bridge. It usually contains a password | yes |
| `DATABASE_SSL` | on | `false` disables TLS (also off for localhost or `sslmode=disable`) | no |
| `DATABASE_SSL_STRICT` | off | `true` verifies the server certificate | no |
| `DATABASE_POOL_MAX` | 5 | Pool size, shared by the store and the bridge | no |
| `ROYAL_AUTO_MIGRATE` | on | `false` skips migrations on start | no |

`DATABASE_URL` holds both ROYAL's own store (decisions, tasks, commitments, snapshots, notifications, research and contact caches, the audit and events logs; ADR-013) and the Grok Bot bridge, on the Node entry only. One pool serves both. `server/deno.js` loads no Postgres driver, so there both run in memory.

Use a database separate from the calculator's Supabase project: ROYAL is a separate service (ADR-001). When `DATABASE_URL` is set, `ROYAL_STORE_PATH` is ignored except as the source of a one-time import (`ROYAL_IMPORT_FILE_STORE=true`, run while the database holds none of ROYAL's records). Rollback: `server/migrations/002_royal_store.down.sql`, run by hand, destroys every record and log entry.

## 12. Flags

`ROYAL_FLAGS` is a JSON object merged over `DEFAULT_FLAGS` (`core/permissions.js`) in `createRoyal` and in `PermissionService`. It is parsed with `JSON.parse` in `fromEnv`, so invalid JSON stops the server at start. Example: `ROYAL_FLAGS={"email_discovery":true}`.

| Flag | Default | Effect |
|---|---|---|
| `agent_internal_write` | false | Off: internal writes become approval requests |
| `agent_external_send` | false | Off: approved sends have no executor, so nothing is sent |
| `proactive_monitoring` | false | On: `core/royal.js` runs `what_needs_me` on business events and raises a notification for each P0 finding |
| `voice_input` | false | Not read by any code on this branch |
| `automated_followup` | false | Not read by any code on this branch |
| `production_risk_engine` | true | Not read by any code on this branch |
| `llm_synthesis` | true | Use the model for synthesis and intent classification when connected |
| `web_research` | true | Off: research status `DISABLED` |
| `x_search` | false | Adds xAI `x_search` to research |
| `people_research` | true | Off: the people-research intent is refused |
| `email_discovery` | false | Allows paid Hunter and Apollo lookups |
| `email_verification` | false | Allows paid Hunter verification |
| `realtime_voice` | false | Allows `POST /v1/voice/session` |
| `spoken_voice` | true | ROYAL's one voice: spoken replies come from `POST /v1/voice/speak` (xAI text to speech) on every device, Business only; off, each device uses its own voice |
| `advanced_agent_orchestration` | false | Allows delegation to external Grok Bots; each delegation still passes the permission gate as `delegate_to_bot` |

`GET /v1/intelligence/status` shows the merged flags and each part's status.
