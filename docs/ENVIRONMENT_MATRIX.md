# ENVIRONMENT MATRIX

*1 October 2026. Every variable the code reads (found by searching `server/`, `core/` and `realms/` for `env.`), what it does, and what happens without it. Values live in Render's Environment settings only; `.env.example` lists the names with placeholders.*

(a) "Production configured" comes from what Tahir has reported in this project's sessions. This environment cannot read Render's settings or reach the server, so each entry is marked **reported** or **unknown**, never verified. `npm run phase1:verify` against the live server checks the effect of the important ones (MEMORY DURABLE, voice).

(b) No value here is ever sent to the browser, written to a log or put in a model prompt. Webhook URLs and keys stay inside `core/grokbot/bots.js` and `bridge.js`.

| Variable | Required | Feature | Production configured | Safe default | Without it |
|---|---|---|---|---|---|
| `PORT` | set by Render | HTTP listener | yes (Render) | 8787 | listens on 8787 |
| `ROYAL_ENV` | yes | refuses `ROYAL_DEV_OWNER_TOKEN` in production | unknown | none | the dev token guard is not active |
| `XAI_API_KEY` | yes | language model, research, spoken voice, realtime voice | reported | none | every model path says NOT CONNECTED; House answers still work |
| `ROYAL_GROK_MODEL` | no | model id | reported (`grok-4.3`) | provider default | provider default model |
| `ROYAL_GROK_FAST_MODEL` | no | cheaper model for light calls | unknown | same as main | main model used |
| `ROYAL_VOICE` | no | the one voice | should be unset | `ara` | Ara. If `eve` is still set from before, remove it |
| `ROYAL_VOICE_MODEL` | no | realtime voice model | unknown | `grok-voice-latest` | default |
| `ROYAL_FLAGS` | no | JSON feature flags (`core/permissions.js` DEFAULT_FLAGS) | unknown | all defaults | defaults: external send off, realtime voice off, spoken voice on |
| `ROYAL_OWNER_PASSCODE` | yes | sign-in | reported | none | sign-in refused (503 PASSCODE_NOT_CONFIGURED) |
| `ROYAL_SESSION_SECRET` | yes | signs session tokens | reported | none | sign-in off |
| `ROYAL_SESSION_DAYS` | no | session length | unknown | 30 | 30 days |
| `DATABASE_URL` | yes | durable store and bot bridge (Postgres) | reported (added after the database steps) | none | memory store: everything is lost on restart, boot shows MEMORY: TEMPORARY |
| `DATABASE_SSL` | no | TLS to Postgres | unknown | on, except localhost | TLS on |
| `DATABASE_SSL_STRICT` | no | verify the database certificate | unknown | false | certificate not verified (Render internal network) |
| `DATABASE_POOL_MAX` | no | connections per instance | unknown | 5 | 5 |
| `ROYAL_AUTO_MIGRATE` | no | run migrations at start | unknown | true | migrations run at start (003 runs on this deploy) |
| `ROYAL_STORE_PATH` | no | JSON file store when there is no database | no | none | memory |
| `ROYAL_IMPORT_FILE_STORE` | no | one-time import of the file store into Postgres | no | false | no import |
| `ROYAL_ALLOWED_ORIGINS` | if the calculator is on another origin | CORS and frame-ancestors | unknown | none | cross-origin calls refused |
| `ROYAL_TZ_OFFSET_MIN` | no | House day boundaries in older paths | unknown | -240 | Eastern daylight time |
| `ROYAL_ACCESS_LOG` | no | one JSON line per API request | new | on | on; `off` silences it |
| `ROYAL_IDENTITY_URL`, `ROYAL_IDENTITY_ANON_KEY` | if the calculator signs in with Supabase | calculator identity | unknown | none | Supabase tokens refused |
| `ROYAL_OWNER_IDS`, `ROYAL_MEMBER_IDS` | with Supabase | who is owner or member | unknown | none | nobody is owner by Supabase |
| `ROYAL_DEV_OWNER_TOKEN` | never in production | local development | must be unset | none | none (refused at start when ROYAL_ENV=production) |
| `GROKBOT_ENABLED` | for bots | bridge master switch | unknown | false | every bot DISABLED |
| `GROKBOT_BOTS` | no | bot ids | unknown | the seven defaults | defaults |
| `GROKBOT_<ID>_WEBHOOK_URL`, `_WEBHOOK_KEY` | per bot | outbound webhook | unknown | none | that bot NOT_CONFIGURED |
| `GROKBOT_<ID>_KEY_HEADER`, `_NAME`, `_ENABLED`, `_REALMS` | no | per-bot details | unknown | Authorization, default name, on, BUSINESS | defaults |
| `GROKBOT_WEBHOOK_URL`, `_KEY`, `GROKBOT_KEY_HEADER` | no | legacy single bot (skill_library) | unknown | none | none |
| `GROKBOT_ALLOW_INSECURE_WEBHOOKS` | tests only | allow http webhooks | must be unset | false | https required |
| `HUNTER_API_KEY`, `HUNTER_DAILY_LIMIT` | no | paid email discovery | unknown | none, 25 | NOT CONFIGURED; addresses are never guessed as verified |
| `APOLLO_API_KEY`, `APOLLO_DAILY_LIMIT` | no | paid contact discovery | unknown | none, 25 | NOT CONFIGURED |
| `RESEND_API_KEY`, `ROYAL_EMAIL_FROM` | no | sending email | unknown | none | sending NOT CONFIGURED; an approved send says a person must send it |
| `ROYAL_URL`, `ROYAL_TOKEN`, `ROYAL_BENCH_RUNS` | scripts only | `npm run bench`, `npm run phase1:verify` | not a server setting | none | the scripts' live checks do not run |
| `TEST_DATABASE_URL` | tests only | Postgres tests | not a server setting | none | Postgres tests skip; the durability gate fails |
