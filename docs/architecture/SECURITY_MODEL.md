# SECURITY MODEL

Review date: 2026-09-29. Reviewed against the running code, not only the design. Findings that were fixed during the review are marked **fixed**.

## 1. Assets

Client identities and what they bought, project economics, payments and receivables, Treasury (debts, capital, runway), decisions and drafted messages, the provider API key, Supabase credentials.

## 2. Trust Boundaries

| Boundary | Control |
|---|---|
| Owner sign-in | ROYAL passcode (`ROYAL_OWNER_PASSCODE`), compared in constant time; five failures per address per 15 minutes; sessions signed with HMAC-SHA256 (`ROYAL_SESSION_SECRET`) and expiring after 30 days (ADR-008). Tested: wrong passcode, lockout, forged and expired sessions. |
| Internet to ROYAL API | ROYAL session, or a bearer token verified with Supabase auth (`/auth/v1/user`). Owner allow-list `ROYAL_OWNER_IDS`. Every route except `/v1/health` requires it. Knowing the URL grants nothing. |
| House member to ROYAL | `ROYAL_MEMBER_IDS` may **only** `POST /v1/ingest/calculator`. They cannot read answers, decisions or activity. **Fixed:** without this, only Tahir's open calculator could keep ROYAL current. |
| Browser origin | CORS granted only to `ROYAL_ALLOWED_ORIGINS`. Static pages send CSP, nosniff and no-referrer. |
| Calculator page to ROYAL | The calculator ships its **own copy** of `royal-embed.js` and only makes API calls to ROYAL. **Fixed:** the first design loaded the script from ROYAL's origin, which would have let a compromised ROYAL host run code inside the calculator with its session. A test fails if the two copies drift. |
| ROYAL to model | The model sees labelled facts inside `<data>`, told they are data. It has no tools. Its proposed actions pass the permission gate (prohibited tools refused, consequential ones become Decisions). Tested with an injection attempt. |
| Snapshot content | Contract validation rejects credential-, address- and account-like field names. The calculator bridge whitelists fields (client name and `has_email`, never the email itself). |

## 3. Secrets

(a) `XAI_API_KEY` lives only in the server environment. `GrokProvider` keeps it in a private field and serialises without it. A test asserts no API response (status, agents, command, open question, developer log, activity) contains it.

(b) The Supabase anon key is public by design (RLS protects the data). The service-role key is not used by ROYAL at all.

(c) The audit log passes through `redact()`: secret-named keys and JWT- or key-shaped values are replaced before storage (tested).

(d) `ROYAL_DEV_OWNER_TOKEN` is for local development and is refused when `ROYAL_ENV=production` (tested). Set `ROYAL_ENV=production` on every deployed instance.

## 4. Data at Rest

The file store is written with mode 0600 (**fixed**, tested) and atomically (write, then rename). It holds client names and money. Put it on an encrypted volume. There is no delete API. Audit and event logs are append-only in code.

## 5. Abuse Limits

Request bodies are capped at 5 MB. Commands at 2,000 characters. Rate limit: 120 requests per minute per token. Delegations time out after 8 seconds. An open question makes at most three action proposals, each gated.

## 6. Failure Posture

An identity-service outage returns 503 and refuses. It never fails open (tested). Provider failure yields no answer rather than an invented one. Tool failure yields a structured failure with its impact.

## 7. Known Limitations

(a) The in-memory and file stores suit a single instance. A multi-instance deployment needs the Postgres store (next phase).

(b) The per-token rate limiter is per process.

(c) Owner status is an allow-list of user IDs. Staff roles beyond ingest-only are not designed yet.

(d) In the calculator, `window.RTJ_HOUSE.snapshot()` is readable by any script on the calculator's own origin. Those scripts can already read the same data through `RTJBackend`, so this adds no new exposure.

(e) Carried over from the calculator's notes and not ROYAL's to change: rotate the Bloom webhook secret.
