# Grok Bot bridge

ROYAL talks to seven external Grok Bot assistants directly, and shows each one's live feed on its own. Nothing mixes between bots, and nothing mixes between Business and Personal.

These bots are not ROYAL's internal specialists, even where the names match (Royal, Ace, House, Grace). The specialists are ROYAL's own code under `/v1/agents`. The bots are separate assistants on the Grok Bot side, reached under `/v1/bots`. They share no state and no authority.

## 1. How it works

(a) **Tahir to a bot.** In ROYAL, open the menu, then Bots, pick a bot's tab and send a message. ROYAL stores a request, then POSTs to that bot's own webhook with that bot's own key. The bot wakes up.

(b) **A bot to ROYAL.** The bot does the work and POSTs its progress and results to `https://royal-1wx5.onrender.com/v1/bots/<its id>/events`, signed with its own ROYAL token. ROYAL stores the event and pushes it to that bot's tab live.

(c) **Records only.** Bot events are shown, never acted on. No bot can send a client message, refund, pay a vendor, change a price or policy, deploy, or approve anything in ROYAL. A bot token can post its own events and read its own requests, and gets 403 everywhere else.

(d) **Realms.** Royal, Ace, House, Grace, Me Bot and Grok Bot are Business only. Skill Library works in both. A Business-only bot never receives a Personal message (403 `REALM_FORBIDDEN`), cannot post a Personal event, and is hidden from the Personal view entirely.

## 2. Environment variables (Render, Environment tab only)

Never put any of these in `web/config.js`; that file is public.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none | Postgres connection string (Render Postgres "Internal Database URL"). Without it the bridge runs in memory and loses everything on restart. |
| `ROYAL_AUTO_MIGRATE` | `true` | Apply migrations on start. Set `false` to run `npm run migrate` by hand instead. |
| `DATABASE_SSL` | on for remote hosts | `false` turns TLS off (local only). |
| `GROKBOT_ENABLED` | off | Master switch. Must be `true` or every bot shows Switched off. |
| `GROKBOT_BOTS` | all seven | `skill_library,royal,ace,house,grace,me_bot,grok_bot` |
| `GROKBOT_<ID>_WEBHOOK_URL` | none | That bot's inbound webhook. https only. |
| `GROKBOT_<ID>_WEBHOOK_KEY` | none | That webhook's secret sender key. |
| `GROKBOT_<ID>_KEY_HEADER` | `Authorization` | Header the key goes in. `Authorization` is sent as `Bearer <key>`; any other header gets the key as is. |
| `GROKBOT_<ID>_NAME` | built in | Display name. |
| `GROKBOT_<ID>_ENABLED` | on | `false` switches one bot off. |
| `GROKBOT_<ID>_REALMS` | `BUSINESS` (Skill Library: `BUSINESS,PERSONAL`) | Comma list. |
| `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY`, `GROKBOT_KEY_HEADER` | none | Legacy single-bot settings; used for Skill Library if its own are missing. |

`<ID>` is the bot id in capitals: `me_bot` becomes `GROKBOT_ME_BOT_WEBHOOK_URL`.

The Render build command must be `npm install` (the bridge uses the `pg` package).

## 3. Endpoints

| Method and path | Who | What |
|---|---|---|
| `GET /v1/bots?realm=` | owner | Bots in that realm: id, name, status, realms, last_seen, last_message_at, last_error, storage. Never a URL, key or header. |
| `POST /v1/bots/:id/token` | owner | Mint or rotate that bot's token. The plaintext is returned once. The old token stops working. |
| `DELETE /v1/bots/:id/token` | owner | Revoke that bot's token. |
| `POST /v1/bots/:id/message` | owner | `{content (1 to 2000), skill?, conversation_id?, realm?}`. Stores the request, calls the webhook (15 s timeout, one retry on a network error or 5xx). Returns `{ok, request_id, status}`, or 502 with an error code and no address. |
| `POST /v1/bots/:id/events` | that bot only | `{request_id?, type: progress, result, alert or message, content_markdown (up to 100 KB), status?, realm?}`. 400 if a `bot_id` in the body differs from the path; 403 if the request belongs to another bot. |
| `GET /v1/bots/:id/feed?since=&limit=&realm=` | owner | That bot's events only. |
| `GET /v1/bots/:id/requests/:requestId` | owner, or that bot | One request. |
| `GET /v1/bots/:id/stream?realm=` | owner | Server-Sent Events for that bot only. Resume with `Last-Event-ID` or `?since=`. Heartbeat every 25 s. |
| `GET /v1/feed/stream?realm=` | owner | Combined overview; every event carries `bot_id`. |
| `POST /v1/integrations/grokbot/run` | owner | v1: `{skill, request}` to Skill Library. |
| `POST /v1/integrations/grokbot/result` | Skill Library's token only | v1: `{request_id, skill, status, result_markdown}`. A v1 routine that signed in with Tahir's passcode must switch to Skill Library's own token (403 otherwise). |
| `GET /v1/integrations/grokbot/result/:id` | owner | v1 result shape. |

The webhook payload each bot receives:

```json
{ "bot_id": "ace", "realm": "BUSINESS", "content": "…", "request": "…", "skill": null,
  "request_id": "uuid", "conversation_id": "…", "reply_endpoint": "/v1/bots/ace/events",
  "requested_by": "tahir", "sent_at": "2026-09-30T12:00:00.000Z" }
```

## 4. Giving each bot its token

(a) Sign in to ROYAL. Open the menu, then Bots, then the bot's tab, then Token, then Issue new token, and confirm.

(b) Copy the token that appears. It is shown once.

(c) In that bot's Grok Bot settings, paste it into the bot's secure secret input (never into a chat, a document or GitHub). Tell the bot to call:

```
POST https://royal-1wx5.onrender.com/v1/bots/<its id>/events
Authorization: Bearer <its token>
Content-Type: application/json

{ "request_id": "<the request_id ROYAL sent>", "type": "result", "content_markdown": "…" }
```

(d) Repeat for each of the seven bots. Each gets its own token; a token only ever works for its own bot.

The same can be done from a terminal: `curl -X POST https://royal-1wx5.onrender.com/v1/bots/ace/token -H "Authorization: Bearer <your ROYAL session>"`.

## 5. Limits

(a) Message to a bot: 2,000 characters. Event from a bot: 100 KB. Any request body: 5 MB, refused while it is still arriving.

(b) Per bot: 30 messages and 120 events a minute. Ten open streams per bot, 100 in all.

(c) A switched-off bot's events are refused (409 `BOT_DISABLED`). Tokens can still be issued, so bots can be set up before they are switched on.

(d) A stream that reconnects replays up to 5,000 missed events; beyond that it tells the page to reload the tab rather than skip anything.

(e) Known edge: Postgres numbers events before they commit, so two events written in the same instant can commit out of order. Live streams handle this; a client that reconnects in exactly that instant could miss the earlier one until the tab is reloaded. Negligible at this volume; a commit-ordered sequence would remove it.

## 6. Storage

Four tables (`server/migrations/001_grokbot.sql`): `grokbot_requests`, `grokbot_events`, `grokbot_bot_tokens`, `grokbot_bot_state`. Every query filters by `bot_id`. The database itself refuses an event whose request belongs to a different bot or realm, and allows one active token per bot. Tokens are stored as SHA-256 hashes with a lookup prefix.

Live updates across instances use Postgres `LISTEN/NOTIFY` on channel `grokbot_events`. The message carries only `{bot_id, event_id}`; each instance re-reads the row.

## 7. Rollback

(a) Set `GROKBOT_ENABLED=false`. Every bot stops receiving and the tabs show Switched off. Nothing else in ROYAL depends on the bridge.

(b) To remove the code, redeploy the previous commit. The tables can stay; nothing reads them.

(c) To remove the tables too: `psql "$DATABASE_URL" -f server/migrations/001_grokbot.down.sql`. This deletes all bot history and tokens.

## 8. Post-deploy checklist

1. Create a Render Postgres database (same region as ROYAL). Copy its Internal Database URL into ROYAL's `DATABASE_URL`.
2. Make sure the build command is `npm install`.
3. Set `GROKBOT_ENABLED=true` and, for each bot, `GROKBOT_<ID>_WEBHOOK_URL` and `GROKBOT_<ID>_WEBHOOK_KEY` (and `_KEY_HEADER` if the bot expects a header other than Authorization).
4. Manual Deploy. The log should show the migration being applied once (`applied migrations: 001_grokbot.sql`). Or set `ROYAL_AUTO_MIGRATE=false` and run `npm run migrate` from the Render shell.
5. Open ROYAL, then Menu, then Bots. Every tab should show a green dot (Connected) and the subtitle should not say "temporary".
6. Mint seven tokens (section 4) and give each to its bot through its secure secret input.
7. In the Skill Library tab, send `morning briefing` with skill `001` (or `POST /v1/bots/skill_library/message {"content":"morning briefing","skill":"001"}`). Confirm the result appears in the Skill Library tab only, and the tab says "live".
8. Check live delivery through Cloudflare: keep a bot's tab open and have that bot post an event; it should appear within a second or two. If it only appears on reload, the stream is being buffered, so tell Claude.
9. Switch to Personal. Only Skill Library should be listed.
