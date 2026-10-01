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

## 7. Phase 1 correction, 1 October 2026

(a) **One state, not two.** The registry used to carry `status: CONNECTED` for any bot with a webhook address and key, beside the real `connection`. Two readers trusted the old field: routed delegation (`adapterFor` in `core/intelligence/agents.js`) and the Bots panel's Send button (`bot.status === "CONNECTED"` in `web/js/bots.js`). The old field is gone. Every bot in `GET /v1/bots` now carries:

| Field | Meaning |
|---|---|
| `config_state` | NOT_CONFIGURED, DISABLED or CONFIGURED: what may be attempted, never "connected" |
| `connection_state` (and `connection`, the same value) | the one connection state, below |
| `can_send` | ROYAL may deliver a message (configured and switched on) |
| `can_receive_tasks` | ROYAL may route work to it: the latest word from it is a verified round trip |
| `last_verified_at`, `last_roundtrip_ms` | the last verified round trip and how long it took |
| `last_failure_at`, `recent_success_rate` | the last failed delivery, and the share of the last 20 deliveries that went through |

The page reads `can_send` and `connection_state` and infers nothing (`canSendTo` in `web/js/bots.js`).

(b) **What verifies.** A round trip is verified only when the bot posts, with its own token, an event carrying the `request_id` of a message ROYAL delivered to it, within 15 minutes. A post with no `request_id` proves the bot can reach ROYAL, not that it received anything, and no longer verifies. Before this change any post after any message counted.

(c) **States.** NOT_CONFIGURED, DISABLED, CONFIGURED_UNVERIFIED, VERIFYING (a connection check was delivered, the answer is pending, for up to 2 minutes), CONNECTED_VERIFIED, DEGRADED, AUTH_FAILED, UNRESPONSIVE (including a check unanswered after 2 minutes) and FAILED.

(d) **Storage.** Migration `003_bot_verification.sql` adds the evidence columns to `grokbot_bot_state`. It is additive, with a rollback in `003_bot_verification.down.sql`.

(e) Section 5 (b) still holds for explicit delegation: Tahir may hand work to a configured, unverified bot, because answering it is what verifies it. Routed work goes only to a bot with `can_receive_tasks`.

(f) Still not run: a round trip with Tahir's real bots. This environment cannot reach them or the production server. `npm run phase1:verify` with `ROYAL_URL` and `ROYAL_TOKEN` lists each bot's live state.

## 8. ROYAL to the bots from the conversation, 1 October 2026

(a) Tahir no longer needs the Bots panel. "Ask GRACE …", "Have GRACE and LEDGER look at Marcus together" and "Talk to each of the bots" go through the agent orchestrator, which reaches each bot through the bridge and brings its answer back to the conversation (ADR-017, `core/intelligence/orchestrator.js`).

(b) **Verification is stricter.** A round trip verifies only when the bot's `result` event carries a valid envelope that names the bot and repeats the `handoff_id` ROYAL sent, and for a connection test the `nonce`, its name and role. Prose, a wrong nonce, or a post with no `request_id` does not verify. "Check connection" now sends that nonce test through the orchestrator, so the test is an AgentTask and a ledger entry like any other hand-off.

(c) **Set-up** for Tahir: `docs/GROK_BOT_SETUP.md`. LEDGER and FORGE need adding to `GROKBOT_BOTS` with their own webhooks.

(d) **Proven here:** the gate tests (`tests/royal_to_bot.test.js`) and the live gate LIVE_ROYAL_TO_BOT, run against the real server over HTTP with five stand-in bots. **Not yet proven:** the same with Tahir's real Grok Bots.
