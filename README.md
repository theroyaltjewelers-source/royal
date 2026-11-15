# ROYAL

The unified intelligence and command layer for Tahir: one intelligence over his Business realm (The House of Royal T, Tahir & Co., Gold Buy, Operations) and his Personal realm (Wealth, Calendar, Personal tasks).

ROYAL is not the database. It reasons over verified facts from the systems that own them, starting with the Royal T Project Calculator. It enforces authority in code, and it never manufactures certainty.

## Run It Locally

```
node --version            # 20 or later; there is nothing to install
npm test                  # 72 tests, zero dependencies
ROYAL_DEV_OWNER_TOKEN=dev ROYAL_STORE_PATH=./royal.json node server/node.js
# open http://localhost:8787, choose "Development token", enter: dev
```

To see it with data, post a House API snapshot to `/v1/ingest/calculator` (the calculator does this itself once `ROYAL_URL` is set), or run the contract test against a calculator checkout:

```
RTJ_CALCULATOR_DIR=../royal-t RTJ_SEED=/tmp/seed.js node --test tests/
```

## Layout

```
core/                 orchestrator, registry, permissions, gate, decisions, audit, store,
                      sources, context, router, attention, events, providers
realms/business/royal-t/
                      contract (rtj.house.v1), connector, specialists (ACE GRACE LEDGER FORGE), changes
skills/               the skill library and client-message drafts
server/               fetch-standard handler; Node and Deno entries
web/                  the ROYAL app, and royal-embed.js (vendored into the calculator)
docs/                 company, agents, training, skills, architecture
tests/                node:test suites
```

## Ask It

"What needs me?", "State of the House", "Can I step away?", "Who owes us money?", "What are we waiting on?", "Which promises are due?", "What changed today?", "Why hasn't Marcus's chain moved?", then "Handle it."

## Read First

`docs/architecture/ROYAL_ARCHITECTURE.md`, `PERMISSION_MODEL.md`, `DECISIONS.md`, and `CLAUDE.md` for the working rules.

## Sync the House to Odoo

I can copy The House into Odoo: a person becomes a contact, an inquiry becomes a CRM lead, and a payment is recorded on that contact. This stays off until you turn it on. If the settings are missing, ROYAL behaves as it does today. Nothing here deletes an Odoo record.

While the server is awake I poll the House feed about once a minute. Render sleeps when nobody is using ROYAL, so a GitHub Action in this repo also calls one protected address once an hour and runs a single pass. The click path is below.

Odoo API keys cannot last more than three months. I checked the Odoo 19.0 and 20.0 external API pages: both say a key's duration is capped at three months. Put a calendar reminder a week before the one you create, and follow "Rotate the Odoo key" at the bottom when it comes due.

### 1. Make two secrets

On your Mac, open Terminal (Applications, Utilities, Terminal). Paste this and press Return. Then paste it again and press Return.

```
openssl rand -hex 32
```

The first line is the feed secret. The second is the run secret. Each is a long string of letters and numbers. Put both in a note you can find again. You will paste them in the next steps. If you lose one, run the command again and update both places that use it.

### 2. Save the feed key on the Repaint page

The feed answers 404 until this is saved.

1. Open the Repaint Odoo sync page: https://dash-8cd467vnv8t7gg6tbh448k87tg.view.repaint.com/settings/odoo
2. In the key id box, type `odoo-1`
3. In the secret box, paste the feed secret (the first one).
4. Save.

That replaces Repaint's temporary key `sandbox-test`. One test event is already waiting there. After the deploy below, it should change to Delivered. It is only an acknowledgement. It does not create an Odoo record.

### 3. Make an Odoo API key

1. Open https://the-house-of-royal-t-design1.odoo.com and sign in as ceo@thehouseofroyaltdesign.com
2. Click your picture or initials at the top right.
3. Click Preferences (it may say My Profile).
4. Open the Account Security section.
5. Click New API Key.
6. Description: `ROYAL`
7. Duration: choose the longest one. It will not be more than three months.
8. Click Generate Key.
9. Copy the key now. Odoo shows it only once. If you close the window without copying it, delete that key and make another.

### 4. Add the settings on Render

1. Open https://dashboard.render.com and sign in.
2. Open the ROYAL service (the site https://royal-1wx5.onrender.com).
3. Click Environment in the left hand menu.
4. For each row below, click Add Environment Variable. Type the name on the left exactly, and paste the value on the right. Leave a row out only when the note says you may.
5. Click Save Changes. Render starts a new deploy. Wait until it says Live. The first wake after a sleep can take about a minute.

| Name | Value |
|---|---|
| `ODOO_SYNC_ENABLED` | `true` |
| `ODOO_URL` | `https://the-house-of-royal-t-design1.odoo.com` |
| `ODOO_DB` | `the-house-of-royal-t-design1` |
| `ODOO_API_KEY` | The key Odoo just showed you |
| `ODOO_PAYMENT_JOURNAL_ID` | Leave this out. I use the first bank journal. To force one, open Accounting, Configuration, Journals, open the bank journal, and use the number at the end of the address bar. |
| `REPAINT_FEED_BASE_URL` | `https://thehouseofroyaltdesign.com/api/odoo-bridge/v1` (you can leave this out; this is the default) |
| `REPAINT_FEED_KEY_ID` | `odoo-1` (the same id you typed on the Repaint page) |
| `REPAINT_FEED_SECRET` | The feed secret (the same one you saved on the Repaint page) |
| `ODOO_SYNC_ALLOW_TEST` | `false` |
| `ODOO_SYNC_RUN_SECRET` | The run secret (the second one) |

`ODOO_SYNC_ALLOW_TEST` matters when Repaint is in Testing, or when a record itself is marked test. I acknowledge those events and I do not write them to Odoo while this is `false`. A `bridge.test` event is never written, whatever this is set to. Set this to `true` only for a short time if you want a test client, inquiry or payment to appear in Odoo, save on Render, send a new test, then set it back to `false`. An event I have already acknowledged is not sent again.

### 5. Let GitHub wake ROYAL once an hour

The workflow file is `.github/workflows/odoo-sync.yml`. It runs at minute 17 of every hour. Once an hour stays inside GitHub's free minutes for a private repository (about 2,000 minutes a month). Every 5 minutes would use more than that free allowance, because GitHub counts each run as at least one minute. If you want every 5 minutes anyway, change the line `17 * * * *` in that file to `*/5 * * * *`.

1. Open this repository on GitHub.
2. Click Settings, then Secrets and variables, then Actions.
3. Click New repository secret. Name: `ROYAL_ODOO_SYNC_URL`. Value: `https://royal-1wx5.onrender.com/v1/odoo-sync/run`. Add secret.
4. Click New repository secret again. Name: `ROYAL_ODOO_SYNC_SECRET`. Value: the same run secret you put in `ODOO_SYNC_RUN_SECRET`. Add secret.
5. Click the Actions tab, then Odoo sync. Until those two secrets exist, the run prints a skip line and does not call ROYAL. It still uses about one minute each hour. If you do not want that yet, open Odoo sync, click the three dots, and choose Disable workflow. Enable it again after the secrets are saved.
6. To try it once by hand: Actions, Odoo sync, Run workflow, Run workflow.

A paid Render cron job can call the same address if you would rather not use GitHub. The address and the header are the same as the curl in the next step. You do not need both.

### 6. Check that it worked

1. Wait until the Render deploy says Live.
2. Open Terminal. Paste the line below, replace `PASTE_THE_RUN_SECRET` with the run secret, and press Return. If it sits there or fails, Render was probably asleep. Wait a minute and run it again.

```
curl -sS --max-time 120 -H "X-Royal-Sync-Secret: PASTE_THE_RUN_SECRET" https://royal-1wx5.onrender.com/v1/odoo-sync/status
```

You want `"enabled": true`. After a pass, `last_run` is present and `"ok": true`. `counts` shows how many events I delivered, skipped or failed. `last_errors` lists the last failures. The answer never includes the secrets.

3. To run a pass right now, paste this the same way:

```
curl -sS --max-time 120 -X POST -H "X-Royal-Sync-Secret: PASTE_THE_RUN_SECRET" -H "Content-Type: application/json" -d "{}" https://royal-1wx5.onrender.com/v1/odoo-sync/run
```

4. Open the Repaint Odoo sync page again. The waiting test event should say Delivered. Click Send test event. Within about a minute while ROYAL is awake (or within the hour if it had to be woken) that one should say Delivered too. Delivered on a test event means I acknowledged it. It does not, by itself, mean a contact was created. With `ODOO_SYNC_ALLOW_TEST` left at `false`, a test record is Delivered and not written.

5. For a real check, create an inquiry in the House while the feed is in Live mode (or in Testing with `ODOO_SYNC_ALLOW_TEST=true`, using a new inquiry after you turned that on). In Odoo, open CRM. The lead name looks like `Custom Crown Pendant - Jordan Reyes`. The contact's reference looks like `RT:` followed by the House client id. A payment's memo starts with `RT:` and the House payment id, and the payment is posted.

### What I write

(a) A client becomes a contact. I store the House id in the contact's reference as `RT:` plus the id. If that email already belongs to a contact, I update that contact instead of making a second one. Phone, the address text, and a note with Instagram, source and the dashboard link go on the contact. It is marked as a customer. An archived client is deactivated. I do not delete it.

(b) An inquiry becomes a CRM lead named `piece - customer`, linked to the contact, with the inquiry details and the dashboard link in the description. Status converted marks it won. Status closed marks it lost. Any other status leaves it open. If it is already won or already lost, I do not fire that action again.

(c) A payment becomes an inbound customer payment on that contact. The memo contains `RT:` and the House payment id. I post it. The journal is `ODOO_PAYMENT_JOURNAL_ID` or, if you left that out, the first bank journal (or the first cash journal if there is no bank journal). If a posted payment's amount or date changes, I reset it to draft, update it, and post it again. If Odoo will not reset it (it is often already reconciled), I report that failure and leave the posted payment as it is. A void cancels the payment. A refund becomes a separate outbound payment keyed by the refund id.

(d) A `bridge.test` event is acknowledged and nothing is written to Odoo.

Applied event ids, the latest record version, and the Odoo ids are stored in ROYAL's own database, the same store the boot screen calls DURABLE.

### Rotate the Odoo key

1. In Odoo, make a new API key the same way as step 3. Do this before you delete the old one.
2. On Render, change `ODOO_API_KEY` to the new key and save. Wait until the deploy is Live.
3. Run the status curl in step 6 and confirm `"enabled": true` and a successful `last_run`.
4. In Odoo, delete the old key.
