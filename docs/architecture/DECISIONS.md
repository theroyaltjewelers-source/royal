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

## ADR-010. An ambient interface composed on the server

**Decision.** The dashboard web app is replaced by an ambient interface centred on a living Core (`web/js/core.js`), driven by an explicit state machine (`web/js/state.js`). Answers are shown as primitives from a fixed vocabulary (`web/js/schema.js`), composed deterministically on the server (`core/composer.js`), validated on both sides, and never written by a model. Voice uses the browser's speech services and is optional; typing always works.
**Why.** Tahir's direction: one presence to talk to, not screens to navigate, with nothing on screen that is not true.
**Tradeoffs.** Fewer things visible at once than a dashboard; lists live behind the menu or come from asking. Browser speech recognition sends audio to the browser vendor in Chrome and Edge. WebGL is needed for the full Core; a 2D fallback covers the rest.
**Proved.** `tests/core.test.js` (composer schema), `tests/royal.test.js` (every answer carries a valid presentation; the Marcus conversation), `tests/web.test.js` (page and scripts agree, CSP-clean, no secrets), and browser walkthroughs at five sizes, with reduced motion and without WebGL.
**Reversibility.** High. The API is unchanged; the old app is in git history.

## ADR-011. The Grok Bot bridge, and Postgres with one dependency

**Decision.** ROYAL connects to seven external Grok Bot assistants through `core/grokbot/`. Each bot has its own webhook, its own hashed API token and its own feed; a bot token may only post its own events and read its own requests. Bots are locked to realms (Skill Library both; the rest Business only), enforced on the server. Bot requests, events, tokens and state live in Postgres (`DATABASE_URL`), with migrations in `server/migrations/` and live fan-out across instances by `LISTEN/NOTIFY`. The `pg` package is ROYAL's first runtime dependency; it is loaded only when `DATABASE_URL` is set, so ROYAL without a database still runs with none. The node adapter now streams response bodies so Server-Sent Events work.
**Why.** Tahir's direction: talk to each bot directly from ROYAL and watch each one's feed separately, with nothing mixing. A shared passcode could not tell bots apart, and memory could not survive a deploy or reach a second instance.
**Tradeoffs.** One dependency and a database to run. Bot events are display-only by design, so a bot cannot ask ROYAL to act; that stays a human decision.
**Proved.** `tests/grokbot.test.js` (27 tests: principals, isolation, realms, webhooks, streams, resume, rotation, v1 compatibility, persistence across restart and fan-out across two instances on real Postgres).
**Reversibility.** High. `GROKBOT_ENABLED=false` turns it off; the down migration removes the tables.

## ADR-012. An intelligence layer beside the House skills, not instead of them

**Decision.** ROYAL gains an intelligence layer (`core/intelligence/`) that handles what the deterministic House skills do not: world knowledge, current research, company and executive research, professional contact research, House knowledge, calculation, outreach drafting and revision, sending external email through approval, sources and cancellation. House state still goes through the House skills with no model. The model provider is an interface (`AIProvider`); Grok is one implementation. Research uses the provider's server-side search, then ROYAL fetches the best sources itself to cross-check, and labels every claim. A sentence that names a House record stays with the House; consequential ambiguity stops and asks.
**Why.** Tahir's direction: one intelligence to talk to, able to answer beyond the calculator, research people and companies, delegate, and act only with authority.
**Tradeoffs.** Answers outside the House depend on a paid model provider with search (`XAI_API_KEY`), and contact lookups on paid providers (Hunter, Apollo). None is configured yet, so these paths are built and tested against the providers' documented response shapes but have not run live. Keyword retrieval, not embeddings, for House knowledge.
**Proved.** `tests/intelligence.test.js` (48 tests, including the flagship flows A to H and a regression test for each finding of the independent security review), `tests/server.test.js` (intelligence routes and the voice session).
**Reversibility.** High. Flags keep research, contact discovery, verification, sending, realtime voice and agent orchestration off until each is switched on.

## ADR-013. ROYAL's own store on Postgres

**Decision.** When `DATABASE_URL` is set, ROYAL's own records (decisions, tasks, commitments, waiting items, snapshots, notifications, agent tasks, research and contact caches) and its two append-only logs (audit and events) live in Postgres, through `PgStore` (`core/pgstore.js`), which satisfies the existing `Store` contract in `core/store.js` unchanged. The tables are `royal_records` and `royal_log` (`server/migrations/002_royal_store.sql`). A trigger refuses UPDATE, DELETE and TRUNCATE on `royal_log`, so the logs are append-only in the database and not only in code. The store and the Grok Bot bridge share one pool and one migration run (`core/db.js`, `server/store-env.js`). Without `DATABASE_URL`, nothing changes: the JSON file at `ROYAL_STORE_PATH`, or memory. `ROYAL_IMPORT_FILE_STORE=true` moves an existing file into an empty database once, audited with counts only.
**Why.** On a host without a persistent disk (Render's free plan) the file store is lost on every redeploy, so Decisions, the activity list and notifications disappeared. Every later part of the Jarvis work (conversation memory, notifications, connectors) needs records that survive restarts and are shared by instances. Postgres was already a dependency for the bridge (ADR-011), so this adds no new one.
**Tradeoffs.** jsonb does not keep object key order and cannot hold a NUL character; `PgStore` drops NULs, and no caller depends on key order. Log sequence numbers come from one sequence for both logs, so they are increasing within a log but not contiguous. The Deno entry still has no Postgres driver and stays in memory. Conversation context, rate limits and metrics are still per process.
**Proved.** `tests/store.test.js`: the store tests run as one conformance suite against memory, the file store and Postgres (compare-and-swap, copies, append-only, `readLog` windows, dedupe, secrets redacted, concurrent writers where exactly one wins); on Postgres also the database refusing to change the log, migrations applying once, a Decision surviving a restart and resolving once only, `/v1/boot` reporting MEMORY as DURABLE, the one-time import, and the shared pool.
**Reversibility.** High. Unset `DATABASE_URL` to return to the file or memory. `server/migrations/002_royal_store.down.sql` (by hand) removes the tables and everything in them.

## ADR-014. One voice for ROYAL on every device

**Decision.** ROYAL's spoken replies come from the server, not from each device. `POST /v1/voice/speak` (owner only, Business only) turns the sentence ROYAL already wrote into MP3 through xAI text to speech (`GrokProvider.speech()`), and `web/js/voice.js` plays it through Web Audio. The voice is `ara`, a warm woman's voice, set by `ROYAL_VOICE`; realtime voice now defaults to the same voice. Flag `spoken_voice` is on by default. Wherever the server cannot speak (Personal, flag off, no key, a failed request), the device's own voice says the same words.
**Why.** Tahir heard a different voice on his phone and his desktop, because each device picks from its own installed voices, and iOS often had no voice chosen at all. He asked for one voice on every device: elegant, modern, high-end, and a woman.
**Tradeoffs.** Each new sentence is a paid xAI call, and speech starts after a short round trip instead of at once; a 64-phrase cache per process removes the cost of repeated phrases. Unlike the rule in `DEFAULT_FLAGS` (`core/permissions.js`) that anything costing per call starts off, this flag starts on, at Tahir's direct request. Business sentences, which can name clients and amounts, now reach xAI as audio text as well as prompts; Personal sentences never do, so Personal still uses the device voice.
**Proved.** `tests/voice.test.js` (10 tests: route, provider request, cache, refusals, status, and the page player against a stand-in browser, including barge-in and fallback), plus a Chromium check at phone and desktop sizes against a stand-in xAI.
**Reversibility.** High. `ROYAL_FLAGS={"spoken_voice":false}` returns every device to its own voice; `ROYAL_VOICE` picks another xAI voice.

## ADR-015. Route by need: reasoning effort, a fast path, one identity, voice by sentence

**Decision.** (a) Every model call sets reasoning effort from ROYAL's reasoning level: low for conversation, lookups and everyday operations, medium for analysis and research, high only for planning; a model that rejects it is never sent it again. (b) Each conversation's calls carry a prompt cache key (`x-grok-conv-id`, `prompt_cache_key`), behind one stable prefix: ROYAL's identity, then the House language. (c) Greetings, "who are you", thanks and House definitions are answered with no model call (`core/identity.js`, `core/house_language.js`). (d) A sentence the rules cannot place costs one answering call, not a classification call and then an answer. (e) Every request is traced (`core/trace.js`): marks, model calls, effort, cached tokens, total. (f) ROYAL speaks in the first person everywhere. (g) Spoken replies are fetched by sentence and played through one queue with a moving cursor and a small adaptive jitter buffer (`web/js/playback.js`), which realtime voice also uses. (h) A Grok Bot shows CONNECTED_VERIFIED only after a real round trip.
**Why.** Tahir found ROYAL slow, choppy and speaking about itself in the third person, and the Grok Bots unreliable. The audit (`ROYAL_PERFORMANCE_AUDIT.md`) found the causes: the reasoning model's default high effort on every call, two model calls in a row for unplaced sentences, no fast path, no cache affinity, one audio file per whole reply, realtime audio scheduled with no buffer, and bot status taken from configuration.
**Tradeoffs.** Low effort can be less thorough on a hard question routed as a simple one; the reasoning router raises the level for why, trade-off and planning language. Fetching by sentence makes more, smaller voice requests (cached per sentence). The fast path's sentences are fixed patterns; anything else still reaches the model.
**Proved.** `tests/correction.test.js`, `tests/voice.test.js`, `tests/grokbot.test.js` (round-trip status); the benchmark against a simulated xAI: 24 model calls to 12 for the benchmark set, greeting 1,414 ms to 10 ms, open question 1,410 ms to 708 ms.
**Reversibility.** High. Each part is local to its module; `ROYAL_FLAGS={"spoken_voice":false}` returns the device voices.

## ADR-016. ROYAL knows its team's work from its own records

**Decision.** Questions about what the specialists and bots did are answered from ROYAL's own records: an agent activity ledger (`core/agent_ledger.js`) written on every native specialist run, the delegated AgentTasks, and each Grok Bot's feed, read agent by agent so one failure never hides the rest. Delegated work is cancelled only when Tahir names it, and every cancellation and failure carries a reason. Every skill that depends on a specialist names it and its reason when it is missing instead of crashing or showing zeros. The page numbers its turns so a new question is never dropped. A curated executive knowledge fabric (`docs/knowledge/`) answers business concepts below House documents; current law and tax are researched live. The calculator's data is checked against itself and conflicts are reported.
**Why.** "Tell me what each Bot did for work today" was sent to web research, and around it a bare "stop" cancelled all delegated work, a second question was dropped, the voice could wait forever and one failed specialist could crash an answer (`ROYAL_MULTI_AGENT_BUG_AUDIT.md`).
**Tradeoffs.** One ledger write per specialist per request (compare-and-swap with retry). Bot self-reports stay unverified until a cross-check exists. The reference is ROYAL's own text and should be reviewed by Tahir before it guides policy.
**Proved.** `tests/multiagent.test.js` (13, including a 20-request stress run), `tests/knowledge_fabric.test.js` (6), the bot health test, and a Chromium check of concurrent turns.
**Reversibility.** High; each part is its own module.

## ADR-017. One orchestrator for every specialist, whatever runs it

**Decision.** ACE, GRACE, LEDGER, HOUSE and FORGE are each one specialist with up to two backends: the native backend (ROYAL's own logic over the House's data) and the Grok Bot backend (a webhook out, a structured reply back). The agent orchestrator (`core/intelligence/orchestrator.js`) owns all delegation through one call, `delegateToAgent()`. The execution router (`chooseBackend`) picks the backend per request: a specialist Tahir names goes to its bot when the bot can be reached; work that needs a bot's own environment goes to a verified bot; fast reads stay native. Every hand-off carries a task id, a handoff id, the parent request and the conversation. The bot answers with a structured envelope (`core/grokbot/envelope.js`) that repeats the handoff id, and the answer returns to the conversation that asked, inline or through its inbox (`GET /v1/inbox`). The Bots panel stays a direct line for inspection and debugging.
**Why.** "Ask GRACE …" was answered by the client-message drafting skill, the real bot was reached only for an inactive agent with a switched-off flag, and a bot's reply landed only in its feed, so Tahir had to open the Bots panel to work with his bots.
**Tradeoffs.** A question to a bot waits up to `ROYAL_BOT_WAIT_MS` (12 seconds by default) before saying the answer will come later. A bot must reply in the envelope shape; prose alone is kept as a partial answer and never verifies the bot. Specialists may name another specialist they need; ROYAL decides, at most 3 hops, never in a cycle. A bot's proposals and claimed actions are reported, never executed or approved by its say-so.
**Proved.** `tests/royal_to_bot.test.js` (17 tests, stand-in bots at the far end of a real bridge), and the live gate LIVE_ROYAL_TO_BOT run against the real server with five stand-in bots over HTTP and Postgres. Still to prove against Tahir's real bots: `npm run phase1:verify` with `ROYAL_URL` and `ROYAL_TOKEN`.
**Reversibility.** High; the orchestrator is one module, and the bridge change is an added listener and a stricter verification rule.

## ADR-018. One voice engine owns the conversation

**Decision.** A single client-side state machine (`VoiceConversation`, `web/js/conversation.js`) owns voice: IDLE, CONNECTING, LISTENING, USER_SPEAKING, END_OF_TURN, PROCESSING, ROYAL_SPEAKING, INTERRUPTED, MUTED, RECONNECTING, ERROR_RECOVERY, SESSION_ENDED, with legal transitions only and a watchdog on every waiting state. ROYAL detects speech and turn ends herself (`web/js/turn.js`: a minimum-statistics noise floor, zero crossings, modulation, near-field priority, an echo margin while she speaks; adaptive pauses; a tentative end resolved by how finished the transcript sounds). Each finished turn is transcribed on the server (`POST /v1/voice/transcribe`, xAI speech-to-text, Business), with the device recognizer as the fallback and in Personal. Answers come from the same `/v1/command` as typing. After she speaks she listens again without a touch; talking over her stops her, keeping a 400 ms pre-roll. The browser's one-shot recognizer and the realtime client are removed.
**Why.** In production the browser's recognizer decided when Tahir had finished, so noise held turns open; nothing listened again after an answer; and three pieces of code each decided whether ROYAL was listening (`ROYAL_VOICE_ENGINE.md` section 1).
**Tradeoffs.** The detector is signal processing, not a neural voice model or speaker identification; a television at Tahir's own level, or music with vocals, can still be heard as speech, and a turn of it may be transcribed. Weak echo cancellation on some speakerphones can leak ROYAL's voice; the echo margin reduces it, headphones remove it. One server round trip per turn for transcription. The realtime route stays on the server, unused by the page.
**Proved.** `tests/voice_engine.test.js` (18), the transcription route tests, and `tests/manual/voice-browser.mjs` in Chromium at phone and desktop sizes with a fake microphone: one touch, 45 s hands free, 7 to 8 turns, 0 ms to listening again, a median of 0.8 to 0.9 s from the end of a question to ROYAL's voice, barge-in on every overlapping question, no refused transitions. Not yet proved: a human voice in a real room on Tahir's phone, and xAI's live speech-to-text.
**Reversibility.** High; the engine, the detector and the adapters are three modules.
