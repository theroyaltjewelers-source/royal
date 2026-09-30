# MEMORY ARCHITECTURE

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

This supersedes `MEMORY_MODEL.md`. ROYAL keeps four kinds of memory, and they never answer for one another: conversation memory never says what a client paid, and research memory never says what the House's policy is.

| Memory | What | Where | Lifetime | Survives restart |
|---|---|---|---|---|
| Working | What a conversation is about | `ConversationContext`, `core/context.js` | 6 hours from the last turn | No |
| Operational | Snapshots, decisions, tasks, commitments, audit, events | The ROYAL store, `core/store.js` | Durable | Only with `ROYAL_STORE_PATH` |
| Institutional | The House's own documents | `KnowledgeEngine`, `core/intelligence/knowledge.js` | Rebuilt from `docs/` at start | Yes, from git |
| Research | External findings and contacts | Store kinds `research` and `contacts` | By freshness class | Only with `ROYAL_STORE_PATH` |

## 1. Working memory

`ConversationContext` is an in-process `Map` keyed `REALM:conversation_id`, with a six hour TTL set in `createRoyal()` (`core/royal.js`). Its fields are listed in `CONVERSATION_CONTEXT.md`; since the security review they include `active_project` and `open_decisions`, the ids of the Decisions the conversation raised, which a later "stop" withdraws. The Decisions themselves are operational memory; working memory only remembers which ones this conversation asked for. It is never written to the store, so a restart or a second instance forgets every conversation. The realtime voice client relies on this memory too (`web/js/realtime.js` sends each voice turn to `/v1/command`), so it has the same lifetime.

## 2. Operational memory

The store contract (`get`, `put` with compare-and-swap revisions, `list`, `append`) is in `core/store.js`. There is no delete; `audit` and `events` are append-only.

| Store kind | Written by |
|---|---|
| `snapshots` (latest, previous, daily, checkpoint) | `RoyalTConnector` (`realms/business/royal-t/connector.js`) |
| `decisions` | `DecisionService` (`core/decisions.js`) |
| `tasks`, `commitments`, `waiting` | Tools in `createRoyal()` |
| `agent_tasks` | `AgentTasks` (`core/intelligence/agents.js`) |
| `notifications` | Proactive monitoring (off by default) |
| `audit`, `events` | `AuditService`, `EventBus` |

The backend is chosen in `server/node.js`: `fileStore(ROYAL_STORE_PATH)` (one JSON file, mode 0600) when that variable is set, otherwise `MemoryStore`, with a startup warning that decisions and audit will be lost on restart. `server/deno.js` always uses `MemoryStore`. Postgres (`DATABASE_URL`) holds only the Grok Bot bridge; decisions and audit are NOT IMPLEMENTED on Postgres (`CLAUDE.md`, "What is known to be wrong or missing").

## 3. Institutional memory

`intelligenceFromEnv()` in `server/intelligence-env.js` creates a `KnowledgeEngine` and calls `ingestDir(docs)` at startup. `ingestDir()` reads Markdown from `docs/company`, `docs/agents`, `docs/skills` and `docs/training` only; `docs/architecture` is not ingested.

(a) **Chunking.** `chunkMarkdown()` cuts at `##` and `###` headings, at `**POL-XXX-NNN Title.**` policy lines and at `---`, drops pieces under 20 characters and splits pieces over 1,600 characters into about 1,400 with `splitText()`, which cuts an over-long line at a sentence end or a space and drops no text.

(b) **Status.** Each policy chunk carries its `Status:` from the Policy Manual. `search()` returns `binding: true` only for ACTIVE policies. A section whose heading or text says SUPERSEDED is excluded unless `includeSuperseded` is set.

(c) **Namespaces.** `company` (the Bible), `policies` (the Manual), `agents`, `skills`, `real_cases` (training, marked `synthetic` and ranked at 0.7).

(d) **Versions.** Each document gets `version: "v-" + hash` and `updated_at` from the file's mtime. `add()` replaces all passages of a path.

(e) **Retrieval.** BM25 (k1 1.4, b 0.75) with light stemming. A passage must match at least 40 percent of the query terms (and two terms for queries of three or more). Policies score 1.25 times. No embeddings.

The index is memory only and rebuilt on every start, so it always matches the checked-out docs. If ingestion throws, the server logs a warning and continues with an empty index. Both the Node and the Deno entry build it through `intelligenceFromEnv()`.

## 4. Research memory

### 4.1 Freshness classes (truth.js)

`freshnessClass(text)` picks a class from the question's words, unless the caller names one (`research(q, { freshness })`); `FRESHNESS_TTL` gives its lifetime.

| Class | Chosen when the text mentions | TTL |
|---|---|---|
| `realtime` | price, spot, rate, stock, today's, right now, live, score, weather | 5 minutes |
| `news` | news, latest, this week, announc..., recent | 1 day |
| `current_role` | CEO, CFO, president, head of, VP, director, founder, owner, leads (not "founded"); or named by the caller | 7 days |
| `stable` | founded, history, born, invented, origin, established | 365 days |
| `standard` | anything else | 7 days |
| `contact` | (defined, never returned by `freshnessClass()`) | 30 days |

### 4.2 Research reports

`ResearchEngine.research()` (`research/engine.js`) keys each report `rsr_` plus a hash of the lower-cased question, depth, official domain and schema, and stores it in kind `research` with `expires_at = retrieved_at + TTL`.

(a) A fresh hit is returned with `from_cache: true` and no provider call.

(b) An expired hit is re-researched when research is CONNECTED.

(c) An expired hit is returned with `stale: true` and a note only when research is not CONNECTED and `requireFresh` is false. No caller passes `requireFresh`.

(d) The class comes from the question ROYAL itself writes, not from Tahir's words, unless the caller names it. `ExecutiveResearch.roleHolder()` passes `freshness: "current_role"`, so a role-holder report is cached for seven days, matching the `expires_at` its result advertises, even though its question mentions "recent filings or reputable news". Company resolution is classed `standard` (7 days).

### 4.3 Contacts

`ContactResearch.businessEmail()` (`research/contacts.js`) stores each result in kind `contacts` under `ctc_<person_id>`: 30 days for a found address, one day for NOT_FOUND (`_save()`). A cached result is returned with `from_cache: true` and no stale path. The public-web step also goes through research memory under its own key.

### 4.4 What research memory is not

It holds claims with labels, sources and retrieval times. It is never promoted to House fact or policy, and nothing reads it except the research engines and `doSources()`, which shows the sources behind `last_research`.

## 5. What persists across restart

(a) **Always:** institutional memory, rebuilt from `docs/`.

(b) **With `ROYAL_STORE_PATH` (Node only):** operational and research memory, agent tasks and contact results.

(c) **With `DATABASE_URL`:** the Grok Bot bridge's requests, events, bot tokens and bot state (`server/migrations/001_grokbot.sql`).

(d) **Never:** working memory, provider `lastError` and status, Hunter and Apollo quota counters (`Quota` in `contacts.js`), and metrics (`Metrics` in `metrics.js`).

## 6. Not built

A correction store, preference memory beyond server configuration (`ROYAL_OWNER_IDS`, `ROYAL_TZ_OFFSET_MIN`), personal-realm memory, and conversation memory shared across instances are NOT IMPLEMENTED.
