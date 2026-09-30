# ARCHITECTURE DECISION RECORDS

---

## ADR-001. ROYAL is an independent service and repository

**Decision.** ROYAL's intelligence lives in its own repository and deploys on its own. The Project Calculator stays authoritative and exposes a controlled API. ROYAL can be embedded in the calculator through a shared client.
**Context.** Tahir's direction (2026-09-29): ROYAL is the top of a larger tree (Business: Royal T, Tahir & Co., Gold Buy, Operations; Personal: Wealth, Calendar, Personal tasks), not a tab inside a jewelry calculator.
**Options.** (1) Build inside the calculator's single file. (2) A separate service, with the calculator as one connector.
**Chosen.** (2).
**Why.** Personal data must never live inside a business tool. Other business lines need their own connectors. The calculator's single-file discipline and pixel-exact test gates should not absorb an AI system's churn.
**Tradeoffs.** Two deployments. A contract to keep in step (guarded by `tests/calculator-contract.test.js`).
**Reversibility.** Moderate. The core is framework-free and could be embedded, but that would give up the realm separation.

## ADR-002. Calculator truth arrives as a pushed snapshot computed by the calculator

**Decision.** The calculator computes `houseSnapshot()` with its own canonical functions and pushes it to ROYAL. ROYAL never re-derives price, margin, value, paid or runway.
**Context.** `compute()` and the enhancement pricing are coupled to the DOM and to settings (audit G1). A second implementation would drift silently.
**Options.** (1) Re-implement the derivations in ROYAL and read raw `kv_store`. (2) Push derived results from the page. (3) Wait for server-side derivations (E2).
**Chosen.** (2) now, (3) later.
**Why.** It is the only option that is correct today.
**Tradeoffs.** ROYAL refreshes only when a signed-in calculator is open. Freshness labels and FORGE's staleness finding make that visible, and house members can push (ingest-only role).
**Reversibility.** High. Swapping the transport does not change the contract.

## ADR-003. Zero dependencies, standard modules, fetch-standard server

**Decision.** ROYAL uses ES modules, no framework, no bundler, no runtime dependencies. The server is a `(Request) => Response` handler with thin Node and Deno entries.
**Why.** It matches the House's engineering culture, runs on Node, Deno, Workers and Supabase Edge without change, and leaves nothing to patch.
**Tradeoffs.** Hand-rolled routing and rendering.
**Reversibility.** High.

## ADR-004. Deterministic skills first; the model only phrases and answers open questions

**Decision.** Every flagship question is answered by deterministic skills over verified data. The language model is used only for open questions, from labelled facts, with no tools. Its proposed actions pass the gate.
**Why.** "What needs me?" must not depend on a model being available, must not hallucinate, and must cost nothing per page load. It also makes the provider genuinely swappable.
**Tradeoffs.** Plain-language coverage is limited to the router's rules plus the open-question path. The rules are easy to extend.
**Reversibility.** High.

## ADR-005. The calculator ships its own copy of the embed client

**Decision.** `royal-embed.js` is vendored into the calculator. It is not loaded from ROYAL's origin.
**Why.** Loading remote script would let a compromised ROYAL host run code inside the calculator with its session (security review, 2026-09-29).
**Tradeoffs.** Two copies to keep identical. A test fails on drift.
**Reversibility.** High.

## ADR-006. Owner-only, with an ingest-only member role

**Decision.** V1 answers only owners (`ROYAL_OWNER_IDS`). Members (`ROYAL_MEMBER_IDS`) may only send calculator state.
**Why.** ROYAL's answers contain the whole House's economics. Staff visibility needs a designed role model, not a default.
**Reversibility.** High.

## ADR-007. V1 safety mode

**Decision.** Internal writes need approval (`agent_internal_write` off). External sends have no executor (`agent_external_send` off). Money movement is prohibited autonomously.
**Why.** The spec's V1 authority: read, analyse, recommend, draft, request approval.
**Reversibility.** Each flag needs a new ADR before it is turned on.

## ADR-008. ROYAL has its own sign-in

**Decision.** ROYAL signs its owner in with its own passcode (`ROYAL_OWNER_PASSCODE`), checked by ROYAL's server, and issues its own signed session (`ROYAL_SESSION_SECRET`, 30 days). Email sign-in through the calculator's Supabase is removed from the ROYAL app.
**Context.** Sharing the calculator's Supabase login meant every sign-in email returned to the calculator (Site URL), and the free plan cannot edit the email template. Tahir's direction: ROYAL must be separate from the calculator.
**Tradeoffs.** One more secret to keep. No password reset by email: to change the passcode, change the environment variable. Five wrong attempts lock an address out for 15 minutes.
**Reversibility.** High. The calculator still sends its state with its own Supabase token (ingest), which ROYAL continues to verify.

## ADR-009. Business and Personal are separate rooms, enforced by the server

**Decision.** Every command carries a realm. Personal commands are handled by a separate path that never reads a business connector, never resolves a business record, never consults a business specialist and never sends business facts to a model. Business commands refuse personal skills and point to the Personal side. Conversations, decisions, activity and domain lists are keyed or filtered by realm. The web app gives Personal its own colour, home, suggestions and views, and clears the screen on every switch.
**Why.** Tahir's direction: the two sections must be completely separate.
**Proved.** `tests/royal.test.js` ("Business and Personal apart"): personal answers contain no business names, amounts, IDs or specialist consultations; no model call is made from Personal with business facts; conversations do not cross; lists are per realm.
