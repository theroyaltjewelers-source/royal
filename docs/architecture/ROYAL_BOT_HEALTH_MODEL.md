# ROYAL BOT HEALTH MODEL

*Source: `connectionOf()` in `core/grokbot/bots.js`.*

| State | Means |
|---|---|
| NOT_CONFIGURED | no webhook address and key, or an invalid one |
| DISABLED | switched off |
| CONFIGURED_UNVERIFIED | configured; no round trip yet |
| CONNECTED_VERIFIED | a message was delivered to its webhook and the bot posted back with its own token, and nothing has failed since |
| DEGRADED | it worked before, but the last delivery failed |
| AUTH_FAILED | its webhook refused ROYAL's key (HTTP 401 or 403) |
| UNRESPONSIVE | a message was delivered more than 15 minutes ago with no word back |
| FAILED | the last delivery failed and it has never answered |

AUTHENTICATING and CONNECTING are not used: the bridge has no long-lived connection to a bot; each message is one webhook call.

**Verification:** "Check connection" in the Bots panel (`POST /v1/bots/:id/verify`) sends a `connection_check` request; the bot must post a result for that `request_id`. Health is derived from recorded deliveries and replies; ROYAL does not ping bots on a schedule.

**Not recorded yet:** per-bot latency percentiles, schema failure rates and error rates; bot state holds the last delivery, last reply and last error only.

**Used by:** the Bots panel, `GET /v1/bots`, self-diagnosis, the daily activity review, and delegation (no work is sent to AUTH_FAILED or FAILED bots).
