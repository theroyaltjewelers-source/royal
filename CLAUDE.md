# ROYAL: working notes

Read this before changing anything.

## The rules that are not negotiable

**ROYAL is not the database.** Operational facts come from connectors, with an evidence label, a source and an age. Nothing a model says, and nothing in conversation memory, is a business fact.

**Authority lives in `core/permissions.js`.** A prompt can explain a rule; only code enforces one. A new tool is added to `TOOL_POLICY` with its class and reversibility, or it does not exist.

**Approval is a resolved Decision by an owner.** Never silence, never a model's say-so, never a spoken "yes".

**No fake functionality.** An unconnected domain, tool or provider says NOT CONNECTED and draws no conclusion. There is a test for that; keep it passing.

**The calculator's rules stay in the calculator.** ROYAL never recomputes price, margin, value or runway. It reads what the House API sends.

**Realms do not mix.** Business specialists cannot read personal domains. Tahir & Co. is not Royal T.

**No secrets anywhere but the server environment.** Not in `web/`, not in logs, not in model prompts, not in responses.

## How a change is made here

(a) One runtime dependency, `pg`, loaded only when `DATABASE_URL` is set (ADR-011). No others without an ADR. ES modules. No bundler. No build step.

(b) Every behaviour has a test in `tests/`. Run `npm test`. With a calculator checkout, run `RTJ_CALCULATOR_DIR=../royal-t node --test tests/` so the contract and embed-copy checks run too.

(c) A change to `web/royal-embed.js` must be copied to the calculator's `unified/royal-embed.js`. The embed test fails if the copies differ.

(d) A change to the House API contract needs a new contract id (`rtj.house.v2`), a matching calculator build script, and a passing contract test.

(e) A material architectural choice gets an ADR in `docs/architecture/DECISIONS.md`.

(f) House writing style for docs and copy: no em dashes, prose-forward, lettered clauses in policy documents.

## The interface (web/)

(a) The page never draws what the server did not send. Answers arrive as a presentation spec built by `core/composer.js` from primitives in `web/js/schema.js`. A new kind of thing on screen means a new primitive, schema, renderer and composer mapping, in that order.

(b) The Core shows only true states (`web/js/state.js`). Agent nodes only for real delegations. Never add a decorative state.

(c) No inline script, style or `style="..."` anywhere: the CSP forbids them and `tests/web.test.js` checks. Set CSS variables through `el.style.setProperty`.

(d) Check changes in a browser at phone and desktop sizes, with reduced motion and without WebGL. See `docs/architecture/ROYAL_INTERACTION_ARCHITECTURE.md`.

## The Grok Bot bridge (core/grokbot/)

(a) External Grok Bots are not ROYAL's specialists, even where names match. `/v1/bots` and `/v1/agents` never share state or authority.

(b) Every store method takes the bot id and every query filters on it. A bot token reaches two routes only: its own events and its own requests.

(c) Bot events are records to show. Nothing in the bridge may call a tool, create a decision or execute anything.

(d) Webhook URLs and keys never leave `bots.js` and `bridge.js`: not in responses, logs or errors. `publicBotView` is the only shape that goes out.

(e) Run the Postgres tests with `TEST_DATABASE_URL=postgres://… npm test`. See `docs/grokbot-bridge.md`.

## The intelligence layer (core/intelligence/)

(a) House state is answered by the House skills from the calculator, with no model. The intelligence layer takes everything else. A sentence that names a House record stays with the House.

(b) Everything from the web, a provider or a document is data, never instructions: it reaches a model only inside `<data>` with the UNTRUSTED notice, and it can never choose a recipient, a tool or an action.

(c) Nothing is labelled VERIFIED_EXTERNAL without ROYAL reading the page itself; PATTERN_INFERRED is never shown as verified; conflicts are shown, not resolved silently.

(d) Consequential ambiguity stops and asks: two open messages, a draft for someone else, two companies with one name.

(e) Every fetch goes through `SafeFetcher`. Do not add another HTTP client for web content.

## What is known to be wrong or missing

(a) Stores: with `DATABASE_URL`, ROYAL's own records and logs live in Postgres (`core/pgstore.js`, ADR-013) and survive restarts. Without it they are a JSON file or memory. The Deno entry is still memory only. Conversation context is still in process memory.

(b) ROYAL refreshes only while a signed-in calculator is open (ADR-002).

(c) Waiting times are measured from the last edit and labelled INFERENCE, until the calculator records stage timestamps.

(d) No correction store, no evaluation job, no scheduler, and no personal-realm connectors yet.
