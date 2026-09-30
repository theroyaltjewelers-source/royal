# KNOWLEDGE ENGINE

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

The Knowledge Engine is ROYAL's memory of the House's own written rules: the Company Bible, the Policy Manual, the agent constitutions, the skills catalogue and the real-case training file. It lives in `core/intelligence/knowledge.js` (class `KnowledgeEngine`). It retrieves a few short passages for a question, each with its document, section, version, policy status and a citation. Nothing is stuffed wholesale into a prompt.

## 1. Ingestion

Ingestion happens once, at server start. Both entries call `intelligenceFromEnv` in `server/intelligence-env.js`: `server/node.js` with `join(ROOT, "docs")` and `server/deno.js` with `new URL("../docs", import.meta.url).pathname`. It calls `knowledge.ingestDir(docsDir)` and logs the count of documents and passages. If loading throws (for example, a Deno deployment that does not ship `docs/`), a warning is logged and the engine stays empty. There is no reload route: a changed document is picked up on the next restart.

`ingestDir(root, { include })` reads only the top level of four directories under `docs/` (not recursive, `.md` files only):

| Directory | Files today | Namespace |
|---|---|---|
| `docs/company/` | `HOUSE_COMPANY_BIBLE.md`, `HOUSE_POLICY_MANUAL.md` | `company`, `policies` |
| `docs/agents/` | five `*_CONSTITUTION.md` files | `agents` |
| `docs/skills/` | `ROYAL_SKILLS.md` | `skills` |
| `docs/training/` | `ROYAL_REAL_CASES.md` | `real_cases` |

`docs/architecture/` is never ingested. A probe on this branch loads 9 documents and 97 passages.

Namespaces come from the `NAMESPACES` map through `namespaceOf(rel)`. Only the two named company files are mapped by exact path, so any new file added under `docs/company/` would land in namespace `general`, not `company`.

## 2. Chunking

`chunkMarkdown(md, meta)` cuts a document into passages:

(a) A new passage starts at every `##` or `###` heading, at every `---` rule, and at every policy line.

(b) A policy line is a bold line of the form `**POL-XXX-000 Title.** Status: ACTIVE`. The policy id and status are attached to the passage that follows.

(c) Passages under 20 characters are dropped. Passages over 1,600 characters are split by `splitText(text, 1400)`: lines are gathered into pieces of about 1,400 characters, and a single line longer than that is cut at the last sentence end (". ") before the limit, or else the last space, or else at the limit itself, and the rest carried into the next piece. No text is dropped (tested: "review: long lines in House documents are kept whole", a 3,500-character line kept whole across pieces of at most 1,400 characters).

(d) Each passage records `path`, `namespace`, `title` (the first `#` heading), `section`, `policy_id`, `policy_status`, `doc_status` (the first `Status:` line in the document), `superseded`, `version`, `updated_at`, and `synthetic` (true for the `real_cases` namespace).

(e) The passage id is `kn_` plus a stable hash of path, section, policy id and the first 80 characters.

## 3. Versions

`add(path, md)` gives each document a version of `v-` plus the first ten characters of a hash of its full text. It is a content fingerprint, not a semantic version. `updated_at` is the file's modification time. Re-adding a path removes all of that document's previous passages first, so only the current version is held. There is no version history.

## 4. Policy status, supersession and binding

(a) Policy status is read from the policy line: `ACTIVE`, `DRAFT` or `NEEDS_TAHIR`. The Policy Manual on this branch holds 27 policies: 18 ACTIVE, 7 NEEDS_TAHIR, 2 DRAFT.

(b) A search hit's `binding` is `true` only when it carries a policy id whose status is `ACTIVE`, `false` for any other policy status, and `null` for passages that are not policies (`search`, in the result mapper).

(c) Binding looks only at the policy's own status. The Policy Manual as a document is marked `Status: DRAFT`, and that document status does not affect `binding`.

(d) A passage is `superseded` when its section heading contains the word `SUPERSEDED` or its text contains `Status: SUPERSEDED`. Superseded passages are kept for history and excluded from search unless `includeSuperseded: true` is passed. No House document uses the marker today.

## 5. Retrieval

Retrieval is keyword ranking with BM25 (`search`). There are no embeddings. `core/providers/grok.js#capabilities` reports `embeddings: false`, and nothing in the engine calls a model.

(a) Terms: `terms(text)` lowercases, strips punctuation except `% $ -`, drops a fixed stop-word list and one-letter words, and applies a light suffix stemmer (`stem`: plural `s`, `ies`, `ing`, `ed`, `ment`, `ness`).

(b) Scoring: standard BM25 with `k1 = 1.4` and `b = 0.75`, over the section, policy id and text of each passage.

(c) Relevance floor: a passage is discarded when it matches fewer than 40% of the distinct query terms, or when the query has three or more terms and the passage matches fewer than two. A question the documents do not cover returns an empty list, not the least bad passage.

(d) Adjustments: a policy passage's score is multiplied by 1.25; a training case (`synthetic`) by 0.7.

(e) Filters: `namespaces`, `includeSuperseded` (default false), `includeTraining` (default true), `limit` (default 5).

## 6. Citations

Each hit carries `citation`: the path, then ` § ` and the section, then the policy id and status in brackets when there is one. For example: `company/HOUSE_POLICY_MANUAL.md § Section 3. Payment and Deposit Policies (POL-PAY-001, NEEDS_TAHIR)`.

## 7. The route

`GET /v1/knowledge/search?q=...` in `server/handler.js`:

(a) Requires a signed-in owner, like every route except `/v1/health`.

(b) `q` is required (400 `QUERY_REQUIRED` if empty) and is cut to 300 characters.

(c) It calls `toolImpls.knowledge_search` in `core/intelligence/index.js`, which calls `knowledge.search(query, { namespaces })` with defaults: five hits, all namespaces, training included, superseded excluded.

(d) If the engine is not loaded, it returns `{ ok: true, results: [] }`.

(e) Tested through the handler in `tests/server.test.js` ("intelligence routes: owner only, and no key in any of them"): 401 signed out, 403 for a signed-in user who is not an owner, 200 for the owner, 400 without `q`.

Each result has `id, path, namespace, title, section, text, score, policy_id, policy_status, binding, synthetic, version, updated_at, citation`.

## 8. Answering a House question

`doKnowledge` in `core/intelligence/index.js` handles the `house_knowledge` intent.

(a) No engine loaded: status `NOT_CONNECTED`, "The House documents are not loaded".

(b) No hits: "The House documents don't cover that yet. It isn't written policy, so I won't guess."

(c) No model (provider `NOT_CONNECTED` or no structured output): ROYAL answers from the top passage itself. For a binding policy it quotes the first clause. For a non-binding policy it says it "isn't decided policy yet" and names the status. The surface label is `VERIFIED_INTERNAL`.

(d) With a model: the top five passages go to `provider.structured` (schema `house_answer`) inside a `<data>` envelope with the untrusted-content rules. The model must say when a passage is not ACTIVE. The reply's `used` ids select which passages are shown. The surface label is `INFERENCE`, because the wording is the model's.

The composer (`core/composer.js`, case `knowledge`) turns this into a `KNOWLEDGE_OBJECT` primitive with the answer, label, up to five passages (citation, text, status, binding, synthetic) and unknowns.

## 9. Other callers

`doOutreach` and `doProspecting` in `core/intelligence/index.js` search the engine for the House's offer with `includeTraining: false` and pass the passages to the model as data. The `POLICY` domain in `core/sources.js` names `royal.knowledge` as its adapter.
