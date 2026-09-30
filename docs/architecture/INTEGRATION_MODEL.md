# INTEGRATION MODEL

## 1. Connectors

| Domain | Connector | Status | Transport |
|---|---|---|---|
| royal_t | `realms/business/royal-t/connector.js` | Built | Calculator pushes `rtj.house.v1` snapshots |
| tahir_and_co | none | NOT CONNECTED | Must stay a separate connector and store |
| gold_buy | none | NOT CONNECTED | [TAHIR TO DESCRIBE the business line] |
| operations | none | NOT CONNECTED | |
| wealth, calendar, personal_tasks | none | NOT CONNECTED | Personal realm; its own specialist when built |
| Language | `core/providers/grok.js` | Built; needs `XAI_API_KEY` and `ROYAL_GROK_MODEL` | xAI chat completions (OpenAI-compatible), JSON mode |
| Jewel360, QuickBooks, Cash App, Apple Pay, bank | none | NOT CONNECTED | Would add CLIENT and PAYMENT fallbacks, and SOURCE_CONFLICT |
| Client messaging (SMS or email) | none | NOT CONNECTED | Would become the `send_client_message` executor, behind `agent_external_send` |

A connector exposes read tools returning `{ok, data, evidence}`, or `{ok:false, failed_because, impact}`, and reports its health to `SourceHealth`.

## 2. Turning ROYAL On for the Calculator

1. Deploy ROYAL (Node): `ROYAL_ENV=production PORT=8787 ROYAL_STORE_PATH=/data/royal.json node server/node.js`.
2. Configure identity to the calculator's Supabase: `ROYAL_IDENTITY_URL`, `ROYAL_IDENTITY_ANON_KEY` (the same public anon key the calculator uses).
3. `ROYAL_OWNER_IDS=<Tahir's Supabase user id>`. Optionally `ROYAL_MEMBER_IDS=<staff ids>` so their open calculators keep ROYAL current.
4. `ROYAL_ALLOWED_ORIGINS=https://royal-t-9e9.pages.dev,<ROYAL's own origin>`.
5. Language (optional): `XAI_API_KEY`, `ROYAL_GROK_MODEL` (the exact xAI model id you want; ROYAL does not guess one).
6. In the ROYAL web app's `web/config.js`, set `IDENTITY_URL` and `IDENTITY_ANON_KEY` to the same Supabase project.
7. In the calculator's `config.js`, set `ROYAL_URL` to ROYAL's https address and deploy. With it empty, the calculator behaves exactly as before.

## 3. Environment Reference

| Variable | Required | Meaning |
|---|---|---|
| ROYAL_ENV | yes in production | `production` refuses the development token |
| PORT | no | Default 8787 |
| ROYAL_STORE_PATH | yes for durability | JSON store file; memory only if unset (warned) |
| ROYAL_IDENTITY_URL, ROYAL_IDENTITY_ANON_KEY | yes | Supabase project used to verify sign-ins |
| ROYAL_OWNER_IDS | yes | Comma-separated owner user ids |
| ROYAL_MEMBER_IDS | no | Ingest-only user ids |
| ROYAL_ALLOWED_ORIGINS | yes when embedded | CORS and frame-ancestors |
| XAI_API_KEY, ROYAL_GROK_MODEL | no | Language provider |
| ROYAL_FLAGS | no | JSON of feature flags |
| ROYAL_TZ_OFFSET_MIN | no | Day boundary offset, default -240 (Eastern daylight) |
| ROYAL_DEV_OWNER_TOKEN | dev only | Fixed owner token for local work |

## 4. Next Integration Phase

(a) **Postgres store** for multi-instance and Edge deployments: tables `royal_records (kind, id, data jsonb, rev int, primary key (kind, id))` with compare-and-swap on `rev`, and `royal_log (log, seq bigserial, record jsonb)` with no UPDATE or DELETE grants. The `Store` contract in `core/store.js` is what it must satisfy. The existing store tests become its conformance suite.

(b) **Server-side calculator derivations** (calculator engineering item E2: decouple `compute()` from the DOM). Once the calculator's rules can run headlessly, a Supabase function can serve the House API directly, and ROYAL no longer depends on a calculator tab being open.

(c) **Stage timestamps** in the calculator (`stageAt` on stage change) to make waiting times VERIFIED instead of INFERENCE.
