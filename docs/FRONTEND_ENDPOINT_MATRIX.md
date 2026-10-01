# FRONTEND ENDPOINT MATRIX

*1 October 2026. Every request the page and the calculator embed make, mapped to the route that serves it. Sources: `web/js/*.js`, `web/royal-embed.js`, `server/handler.js` (`ROUTES`, `allowedMethods`).*

(a) The test "every API call the page makes has a route that accepts its method" (`tests/phase1.test.js`) reads the page's own source, finds every `api(...)`, `fetch(...)` and embed `call(...)`, and fails if a call has no route or uses a method the route does not accept. A new caller without a route fails the build.

(b) A known route asked with the wrong method answers **405** with an `Allow` header. Before this pass it answered 404, which hid stale callers. Unknown routes are still 404.

(c) "Production verified" means checked against https://royal-1wx5.onrender.com. This environment's network policy refuses that host (CONNECT 403), so no row is production verified from here. `npm run phase1:verify` with `ROYAL_URL` and `ROYAL_TOKEN` checks the page routes live (gate LIVE_ERROR).

| Caller | Method | Route | Handler | Auth | Expected | Failure statuses | Tested |
|---|---|---|---|---|---|---|---|
| `app.js` boot, refresh, sign-in | GET | `/v1/status` | `royal.status()` | owner | 200 | 401, 403, 429 | server.test.js |
| `app.js` sign-in screen | GET | `/v1/login-methods` | inline | none | 200 | none | server.test.js |
| `app.js` sign-in | POST | `/v1/login` | `passcode.login` | none | 200 | 400 (bad JSON), 401 (wrong), 429 (rate limit), 503 (not configured) | server.test.js, phase1.test.js |
| `app.js` Systems | GET | `/v1/intelligence/status` | `intelligence.status()` | owner | 200 | 401 | intelligence.test.js |
| `app.js` voice output | POST | `/v1/voice/speak?realm=` | inline, `provider.speech` | owner | 200 audio/wav | 400 (empty or over 1200 characters), 409 (off, Personal, no key), 502 (xAI refused) | voice.test.js |
| `app.js` boot sequence | GET | `/v1/boot` | inline | owner | 200 | 401 | server.test.js |
| `app.js` ask | POST | `/v1/command` | `royal.handle` | owner | 200 | 400 (bad JSON), 413 (over 5 MB) | server.test.js, royal.test.js |
| `app.js` decisions | GET | `/v1/decisions?status=&realm=` | `decisions.list` | owner | 200 | 400 (bad realm) | server.test.js |
| `app.js` approve or reject | POST | `/v1/decisions/:id/resolve` | `royal.resolveDecision` | owner | 200 | 409 (already resolved) | server.test.js |
| `app.js` activity | GET | `/v1/activity?realm=` | `audit.executiveLedger` | owner | 200 | 400 (bad realm) | server.test.js |
| `app.js` Systems agents | GET | `/v1/agents` | inline, `royal.currentWork()` | owner | 200 | 401 | phase1.test.js |
| `app.js` Systems "Test" | POST | `/v1/provider/test` | `provider.test()` | owner | 200 | none (failure is a 200 body) | server.test.js |
| `bots.js` list | GET | `/v1/bots?realm=` | `bridge.listBots` | owner | 200 | 400 (bad realm), 503 (no bridge) | grokbot.test.js |
| `bots.js` feed | GET | `/v1/bots/:id/feed?limit=&realm=` | `bridge.getFeed` | owner | 200 | 400, 403 (realm), 404 (unknown bot) | grokbot.test.js |
| `bots.js` live stream (`sse.js`) | GET | `/v1/bots/:id/stream?realm=` | `bridge.stream` | owner | 200 text/event-stream | 403, 404, 429 (too many streams) | grokbot.test.js |
| `bots.js` send | POST | `/v1/bots/:id/message` | `bridge.sendMessage` | owner | 200 | 400, 403, 409 (not configured or off), 413, 429, 502 (webhook failed) | grokbot.test.js |
| `bots.js` Check connection | POST | `/v1/bots/:id/verify?realm=` | `bridge.sendMessage` (connection_check) | owner | 200 | as send | grokbot.test.js |
| `bots.js` issue token | POST | `/v1/bots/:id/token` | `bridge.issueToken` | owner | 201 | 404, 409 | grokbot.test.js |
| `bots.js` revoke token | DELETE | `/v1/bots/:id/token` | `bridge.revokeToken` | owner | 200 | 404 | grokbot.test.js |
| `realtime.js` voice start | POST | `/v1/voice/session?realm=` | `provider.voiceSession` | owner | 200 | 409 (realtime_voice off, Personal, no key), 502 | intelligence.test.js |
| `royal-embed.js` (calculator) | POST | `/v1/ingest/calculator` | `royal.ingestCalculator` | owner or member | 200 | 422 (invalid snapshot) | server.test.js, calculator-contract.test.js |
| `royal-embed.js` (calculator) | POST | `/v1/command` | `royal.handle` | owner | 200 | as above | server.test.js |
| Grok Bot (its token) | POST | `/v1/bots/:id/events` | `bridge.postEvent` | the bot's own token | 201 | 400, 403, 404, 409, 413, 429 | grokbot.test.js |
| Grok Bot (its token) | GET | `/v1/bots/:id/requests/:uuid` | `bridge.getRequest` | the bot's own token | 200 | 403, 404 | grokbot.test.js |
| Render, uptime probes | GET, HEAD | `/v1/health` | inline | none | 200 | none | phase1.test.js |
| Browser, iOS home screen | GET, HEAD | `/`, `/apple-touch-icon.png`, `/apple-touch-icon-precomposed.png`, `/favicon.ico`, `/robots.txt` | `staticFiles` | none | 200 | 404 for anything else | phase1.test.js |

## Known causes of 404, 405 and 400 in production

The production log was not readable from this environment, so these are the causes found in code, each fixed or explained. From the next deploy every API request and every failed request writes one `ROYAL_ACCESS` JSON line (route folded, status, error code, request id, no body, query or token), so any remaining cause can be read from the Render log.

(a) **404, HEAD on the page.** `staticFiles` answered GET only, so a HEAD request (link previews, uptime monitors, some health probes) to `/` got 404. Fixed: HEAD is answered like GET with no body.

(b) **404, iOS icons.** Adding ROYAL to an iPhone home screen requests `/apple-touch-icon.png` and `/apple-touch-icon-precomposed.png` by name; some browsers request `/favicon.ico`. None existed. Fixed: a real icon is served at all three.

(c) **404 that should have been 405.** A known route asked with the wrong method fell through to "No such route". Now 405 with `Allow`.

(d) **405, bot routes.** The only 405 the old code could produce was `ownerBotRoutes` for a bot route with the wrong method (for example GET on `/v1/bots/:id/verify` or `/message`). The page never does this; the likeliest source is a Grok Bot or a person calling a bot URL by hand. The access log now names the route.

(e) **400, valid input checks, kept.** BAD_JSON, BAD_REALM, TEXT_REQUIRED, TEXT_TOO_LONG, QUERY_REQUIRED, and the bridge's field checks (BAD_TYPE, CONTENT_REQUIRED, BAD_REQUEST_ID, REALM_MISMATCH and the rest) reject bad input. The most likely 400 in normal use is a Grok Bot posting an event in the wrong shape (for example a `type` outside progress, result, alert, message, or a `request_id` that is not the one ROYAL sent). The page itself sends none of these in normal use: `speechPieces` keeps spoken pieces under 1200 characters and never empty.

(f) **409, not 4xx errors in the bug sense.** `/v1/voice/speak` answers 409 in Personal or when the voice is off, and the page falls back to the device voice. These are expected and documented.
