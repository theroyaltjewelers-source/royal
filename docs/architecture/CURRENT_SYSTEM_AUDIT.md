# CURRENT SYSTEM AUDIT

Date: 2026-09-29
Subject: Royal T Project Calculator, as uploaded (`ROYAL-T-COMPLETE_4.zip`, build "2026-09-29 18:44 UTC · recovery, storage and concurrency")
Auditor: Claude, before any ROYAL code was written

---

## 1. What Exists

| Area | Finding |
|---|---|
| Shape | One static page, `unified/index.html`: 10,780 lines, about 560 KB. Markup, CSS and JS in one file, with the script wrapped in an IIFE. No framework, no bundler, no build step, and the working notes say none is to be introduced. |
| Other pages | `proposal.html` (client proposal), `repair.html`, `proposal-link.html`: the client-facing surfaces. |
| Hosting | Cloudflare Pages (`_headers` sets `no-cache`; `_redirects` keeps legacy `.html` links working). App URL `https://royal-t-9e9.pages.dev`. |
| Backend | Supabase, reached through `backend.js`, which exposes `window.RTJBackend`. |
| Data model | A key-value table `kv_store (owner_id, path, data jsonb, updated_at)`. Paths: `projects/<id>`, `clients/<id>`, `repairs/<id>`, `quotes/<id>`, `treasury/main`, `config/settings`. Plus a `proposals` table for client links (`public_token`, `status`). |
| Tenancy | A "house account" owns every row (`house_owner`, RPC `join_house`), so every member sees the same House. |
| Auth | Supabase magic link. RLS is assumed on `kv_store` (its SQL is not in the upload). |
| Concurrency | `Doc.setIf`: compare-and-swap on `data._rev` inside the UPDATE's WHERE clause. The loser gets `{conflict, current}`, and the page shows both versions (`CONFLICTS`, `renderConflicts`). |
| Money rules | Price is derived: `price = landed / (1 - margin)`. Money is voided, never deleted (`livePays`, `liveExps`). The client never sees the economics (enforced at serialisation, guarded by `tests/run.js`). |
| Project stages | `Inquiry, Design, CAD, Awaiting approval, Deposit due, Production, Quality control, Balance due, Ready, Delivered, Archived`. |
| Existing intelligence | `attentionList()` (per-project exceptions, with `sev` and `sec`), `healthOf()`, `nextActionFor()`, `houseFinances()`, the Treasury exception queue `trInboxItems()` ("computed, never stored"), `trRunway()`, `trPromises()`. |
| Existing AI | A read-only "Royal Intelligence" side panel (`#ri`, `RI_QUESTIONS`): six keyword-matched questions answered from canonical functions. No language model. No Grok, xAI or OpenAI code anywhere. |
| Recovery | Snapshot, verify, and guarded restore in Settings, with canonical-JSON fingerprints (E0). |
| Tests | `tests/`: golden (pricing), treasury, debt-allocation, party, nav (Playwright), recovery, storage, concurrency (fake DB with a real CAS), run (constitution checks), visual (full-page pixel diff at 1920, 1440, 900 and 390 across 13 surfaces). |
| Engineering rules | Every edit to `index.html` is a Python script that counts its anchors and writes nothing unless every count matches, with a backup to `/tmp/pre-<name>.html`. |

## 2. What Is Authoritative

(a) The calculator is authoritative for projects, clients, pricing, payments, expenses, production stage, target dates, the Treasury (bills, debts, capital, overhead, vendors) and settings.

(b) Its derived figures (value, paid, health, next action, available cash, runway) are authoritative **as computed by its own functions**. `compute()` is coupled to the DOM (a known issue), so these rules cannot be run outside the page today.

## 3. What ROYAL Reuses, Extends, and Leaves Alone

| Reuse as-is | Extend (minimal) | Do not touch |
|---|---|---|
| `attentionList`, `healthOf`, `nextActionFor`, `houseFinances`, `trInboxItems`, `trRunway`, `partialDataNotes`, the CAS save path | `attentionList` items gain a machine `code`. A read-only House API (`houseSnapshot`, `window.RTJ_HOUSE`). The existing Intelligence panel asks ROYAL when connected, and falls back to its own answers. | Pricing (`compute`, bands, margin), tax, the proposal pages, the client boundary, recovery, the Treasury rules, the stylesheet |

## 4. Integration Points Available

(a) **In-page**: the IIFE's canonical functions. This is the only place the calculator's derived truth can be computed today, so this is where the House API lives.

(b) **Supabase**: `kv_store` under RLS with the user's token (raw records only, no derivations), `functions/v1/*` via `RTJBackend.fn`, and the auth service (used by ROYAL to verify the same accounts).

## 5. Technical Debt and Gaps Found

| # | Finding | Effect on ROYAL |
|---|---|---|
| G1 | `compute()` is DOM-coupled. | Derived figures cannot be produced server-side. ROYAL receives them from the page (House API push), so the calculator must be opened to refresh ROYAL. |
| G2 | The upload is missing `supabase/functions/` (at least `accept-proposal`), `ai/ROYAL_T_CONSTITUTION.md`, `build/`, `ref/`, `package.json`, and `/tmp/seed.js`. | `tests/run.js`, `recovery.js` and `storage.js` cannot run from this upload. The Supabase schema and RLS could not be audited. |
| G3 | `tests/debt-allocation.js` "earmarked and paid are reported separately" fails on the **unpatched** build after 00:00 UTC on the last day of the month. It passed an hour earlier. | Pre-existing and clock-dependent. Not changed; reported. |
| G4 | No record of when a project entered its stage. | GRACE measures waiting from the last edit and labels it INFERENCE. Recording a `stageAt` timestamp on stage change would make it VERIFIED. |
| G5 | No calendar, CRM (Jewel360), vendor or bank connection. | APPOINTMENT, CRM and bank verification are NOT CONNECTED in ROYAL. |
| G6 | Known from the working notes: the Bloom webhook secret needs rotating; the Wake County rate is set at 7.5% against a county rate of 7.25%. | Not ROYAL's to change. Listed for Tahir. |
| G7 | `config.js` carries the Supabase anon key. | This is by design (the anon key is public; RLS protects the data). The service-role key must never appear there. |
| G8 | Everything loads twice on boot (known). | ROYAL waits for both projects and treasury to load before sending anything, so a half-loaded House is never reported. |

## 6. Decision

ROYAL is built as an **independent service and repository** (per Tahir, 2026-09-29), with the calculator exposing a controlled, read-only House API. See `DECISIONS.md` ADR-001 through ADR-004.

---

# Part 2. ROYAL itself, audited before the interaction rebuild

Date: 2026-09-30. Read from the code at commit `19fb4d1`, not from memory.

## What exists

| Layer | Implementation | State |
|---|---|---|
| Stack | ES modules, zero runtime dependencies, no build step. Node 20+ server (`server/node.js`) or Deno (`server/deno.js`) over one fetch-standard handler. Deployed on Render. | Works |
| Auth | ROYAL passcode, HMAC-signed 30-day sessions (`server/passcode.js`); Supabase tokens accepted for calculator ingest and owners | Works, tested |
| Orchestrator | `core/royal.js`: normalize command, resolve entity, route, run skill, consult specialists in parallel through the gate, validate results, synthesise, audit | Works |
| Realms | Business and Personal separated on the server (commands, conversations, decisions, activity, domains) | Works, tested |
| Specialists | ACE, GRACE, LEDGER, FORGE, deterministic over calculator snapshots | Works |
| Registry | `core/registry.js`, validated registration, realm wall | Works. HOUSE (brand and marketing) is **missing** |
| Permissions, gate, decisions | Server-side classes, approval objects, executors, verification, idempotent dedupe | Works, tested |
| Sources, freshness, evidence labels | `core/sources.js`, labels on every finding | Works |
| Events | In-process bus, dedupe by key, snapshot diffs raise events | Works |
| Language | Grok via chat completions, resilient request shape, Test Grok | Built; live use depends on the key |
| Calculator | Pushed House API snapshots (`rtj.house.v1`) | Works when a signed-in calculator is open |
| Web app | `web/app.js` (391 lines, one file): passcode sign-in, tabs (Home, Decisions, Activity, Agents, Systems), a Business/Personal toggle, command-center dashboard, fixed bottom command dock, browser speech input | Works, but it is the thing being replaced |
| Tests | 81 node tests plus calculator contract and embed checks | Pass |

## What is partial

(a) Conversation context resolves "his project" but not "he", "him" or "they", and a money question with a pronoun ("what does he owe?") is routed to the whole-House receivables list instead of the person under discussion.
(b) There is no "Have GRACE prepare an update" or "Send it": drafts exist only inside "Handle it".
(c) Skills return ad-hoc `surface` objects that only the current web app understands. No schema, no validation, no primitive vocabulary.
(d) Voice is input only, through the browser's speech service. No spoken replies, no barge-in, no mute.
(e) No boot sequence and no single place that reports what is actually true about ROYAL's own systems.

## What is broken or wrong for the new direction

(a) The primary experience is a dashboard: tabs, KPI tiles, a permanent system diagram, a permanent Ask bar. The product direction rejects all of these as the dominant hierarchy.
(b) Lime is used as a general accent (buttons, borders, underlines), not as energy.
(c) The command-center "network" is always on screen, so infrastructure is permanently visible.

## What is preserved

Everything under `core/`, `realms/`, `skills/` and `server/`: auth, realms, permissions, decisions, executors, audit, events, sources, connector, specialists, Grok. Their tests are the regression gate for the rebuild.

## What is replaced

`web/index.html`, `web/app.js` and `web/styles.css`. The dashboard views survive as secondary surfaces, reachable from a quiet menu and the keyboard, not as the home.

## What is missing and gets built

Intent grammar with structured output; pronoun and money follow-ups; delegate-and-draft and send-pending skills; the HOUSE agent registered honestly as not connected; a server-side UI Composer with a validated primitive schema; a boot endpoint that reports only true states; the living Core with a state machine, quality tiers and a 2D fallback; a primitive renderer; delegation visuals driven by real delegation records; spoken replies with barge-in and mute; a restrained audio and haptic layer.

## What is risky

(a) WebGL on low-end phones: mitigated by quality tiers, a frame budget, a 2D fallback and reduced motion.
(b) Browser speech recognition sends audio to the browser vendor's service and is missing in some browsers: labelled in the interface, feature-detected, typing always available.
(c) The Render instance has no disk yet, so decisions and snapshots are lost on restart. Unchanged by this rebuild; flagged again.
