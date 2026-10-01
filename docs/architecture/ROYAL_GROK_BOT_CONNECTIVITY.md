# ROYAL GROK BOT CONNECTIVITY

*1 October 2026. Sources: `core/grokbot/bots.js` (`connectionOf`), `core/grokbot/bridge.js`, `POST /v1/bots/:id/verify` in `server/handler.js`.*

## 1. The platform fact

xAI publishes no programmatic Grok Bot API: no SDK, no invocation endpoint, no event stream. ROYAL therefore does not call Grok Bots through xAI. It reaches each bot through a webhook that Tahir sets up in that bot, and the bot answers by posting to ROYAL with its own token. Nothing here pretends otherwise.

## 2. Per bot

| | Skill Library, ACE, HOUSE, GRACE, ROYAL, Me Bot, Grok Bot |
|---|---|
| Exists in ROYAL | yes, as configured bots (`GROKBOT_BOTS`) |
| Identifier | the bot id (`ace`, `grace`, ...) |
| Interface | HTTPS webhook out (`GROKBOT_<ID>_WEBHOOK_URL`); events back to `/v1/bots/<id>/events` |
| Authentication | out: the bot's webhook key in a header; back: a per-bot token, stored only as a hash |
| Send | `POST /v1/bots/<id>/message` (owner) or a delegation |
| Receive | the bot posts `progress`, `result`, `alert` or `message` events |
| Async | yes; replies arrive in the bot's feed and live stream |
| Thread id | `request_id` and `conversation_id` on every message |
| Timeout and retry | one retry on webhook failure; a failed delivery is recorded |
| Errors | `last_error` per bot; the request is marked failed |
| Verified here | no: no bot webhooks exist in this environment |

LEDGER and FORGE have no Grok Bot configured by default; they run natively.

## 3. Status model

`connection` on every bot in `GET /v1/bots`: NOT_CONFIGURED, DISABLED, CONFIGURED_UNVERIFIED, CONNECTED_VERIFIED, DEGRADED, FAILED. CONNECTED_VERIFIED requires a real round trip: a message delivered to the bot's webhook and an event posted back with the bot's own token. Configuration alone is never shown as connected; the Bots panel shows the connection, with a hollow light for "set up, not yet verified".

## 4. How to verify a bot

In the menu, open Bots, choose the bot, and press "Check connection". ROYAL sends a connection check (skill `connection_check`) with a `request_id`. When the bot posts a `result` event for that `request_id`, the request completes and the bot shows "Connected, verified". If the webhook fails, it shows "Last delivery failed" or "Not reachable". Tested end to end against stand-in webhooks (`tests/grokbot.test.js`).

## 5. Known limitations

(a) The intelligence status line and the gateway's `grokbots` adapter still report the bridge as connected whenever it exists (`SECURITY_MODEL.md` 7(g)); the per-bot `connection` is the truth. (b) Delegation still attempts a configured but unverified bot; its reply is what verifies it.

## 6. Update, 1 October 2026

Two more states: AUTH_FAILED (the bot's webhook refused ROYAL's key) and UNRESPONSIVE (delivered more than 15 minutes ago, no word back). Full model: `ROYAL_BOT_HEALTH_MODEL.md`. The daily activity review reads each bot's feed on its own, so one unreadable feed is named and the others are still reported. Round trips with the real bots have still not been run from this environment: there are no bot webhooks here.
