# CONVERSATION CONTEXT

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

Conversation context is what lets Tahir say "find their business email", "make it shorter" or "send it" without repeating himself. It resolves references. It is never a source of business facts (`core/context.js`, comment on `ConversationContext`).

## 1. Where it lives

`ConversationContext` in `core/context.js` is an in-process `Map`, created in `createRoyal()` with a six hour TTL (`6 * 3600000`). `get(id)` returns `{ entity: null, last_skill: null, last_items: [] }` for an unknown or expired key, and deletes the expired entry. `set(id, patch)` merges the patch into the current value and restamps it, so the TTL runs from the last turn.

Keys are `BUSINESS:<conversation_id>` and `PERSONAL:<conversation_id>` (`core/royal.js`), so the two realms never share context. The Personal realm stores only `entity: null`, `last_skill` and `last_items: []`.

## 2. Fields actually stored (Business realm)

After every business command, `handle()` in `core/royal.js` writes:

| Field | Set by | Holds |
|---|---|---|
| `entity` | `royal.js` | `{ id }` of the House project used, or the previous one |
| `active_project` | `royal.js` | `{ id, name, client_name }` of the House project used, or the previous one |
| `last_skill` | `royal.js` | Skill or `intel:<intent>` just run (kept on `handle_it`) |
| `last_items` | `royal.js` | Up to twelve findings (kept on `handle_it` and `go_back`) |
| `pending_draft` | House skills; cleared by `doCancel()` | A House client-message draft, stamped with `created_at` |
| `open_decisions` | `royal.js`; emptied by `doCancel()` | Ids of every Decision this conversation raised (any `decision_pending` surface), House and outreach alike, last twenty kept |
| `focus` | Handler patch, else `house` when a record was used, else the previous focus | `house` or `research` |
| `active_company` | `doPeople()` | `{ company_id, name, domain }` |
| `active_person` | `doPeople()`, `doContact()` | `{ person_id, name, title, company, company_id, domain }`, plus `email` and `email_status` after a contact lookup |
| `last_research` | `doResearch()`, `doPeople()`, `doProspecting()` | `{ question, sources, claims, retrieved_at }` (and `report_id`, `confidence` from `brief()`) |
| `active_draft` | `doOutreach()`, `doRevise()`, `doSend()`, `doCancel()` | The intelligence draft (section 4) |
| `conversation_goal` | `doOutreach()` | The outreach objective |
| `prospects` | `doProspecting()` | `{ company, domain, person, title }` per prospect |

The handler's `context` patch is spread over the record (`...(out.context || {})`), so a handler only changes the fields it names.

(a) `prospects` is written but nothing reads it: "the second one" is not resolved. NOT IMPLEMENTED.

(b) `classify()` sends the `active_project` name to the model as part of its context summary.

(c) The `clear` skill resets every field above to null or empty, including `prospects` and `active_project`, except `open_decisions`, which it keeps so that a later "stop" can still withdraw what this conversation asked for.

## 3. Referent resolution

(a) **House records.** `resolveEntity()` in `core/context.js`, strongest first: the entity selected in the interface, a `PRJ-YYYY-NNNNN` id, names in the text (client name worth 3, piece name 2; a tie is AMBIGUOUS), then a pronoun (`it`, `this`, `that`, `he`, `him`, `his`, `she`, `her`, `they`, `them`, `their`, `the same`, `the client`) with the conversation's `entity`, which returns `via: "conversation"`. `ENTITY_SKILLS` (`project_status`, `project_money`, `delegate_draft`) fall back to the conversation's entity when the text names none.

(b) **Surnames that are everyday words.** `COMMON_WORDS` lists surnames such as Price, Gold, Rose, Brooks, King and Miller. A match on one of them still scores, but it counts as naming the client (and so as a strong match) unless it is written in lower case and used as a word: after an article or qualifier (the, a, an, this, that, its, their, our, your, spot, gold, silver, stock, share, market, current, today's, best, lowest, highest) or followed by "of" or "per". So "the spot price of gold" does not name a client called Price or Gold, while "Did brooks pay?" and "Did Brooks pay?" both name Brooks (tested in "review: House sentences stay with the House").

(c) **Companies.** In `classifyByRules()`, `people_research` uses `active_company` when the text says their, they, them, that company, this company or the company, and names no company. `doPeople()` uses `active_company` when `refers_to_context` is set, and reuses the resolved company (skipping resolution) when the names match.

(d) **People.** `contact_lookup` and `outreach_draft` read `active_person` directly; there is no name matching. "Find their business email" works only because a previous people search set `active_person`.

(e) **Drafts.** `revise_draft`, `send` and `cancel` act on `active_draft`; `cancel` also acts on `pending_draft` and `open_decisions`.

(f) **Model interpretation** receives a summary (company name, person name and title, project name, `has_draft`, `focus`) and is told to set `refers_to_context` for pronouns. It never supplies ids.

(g) **A carried entity does not claim a sentence.** A House record resolved only from the conversation (`via: "conversation"`) does not keep the early intelligence intents (calculation, people and contact research, outreach, prospecting, House knowledge) away from the intelligence layer. A record named in the sentence itself does (`INTENT_ENGINE.md`, section 5).

## 4. The draft lifecycle

An open draft is one with `active_draft` set, `sent` falsy and `cancelled` falsy (`OPEN_DRAFT` in `index.js`, `openDraft` in `royal.js`).

(a) **Created** by `doOutreach()`: id `drf_...`, version 1, `agent`, `person_id`, `to` only if the person's email is a business address on their domain and not INVALID or NOT_FOUND, `to_status`, subject, body, `method` (`model` or `template`), objective, `handoff_id`. If an earlier outreach draft was still open, its open Decision is cancelled ("replaced by a new draft"). The reply says nothing has been sent.

(b) **Revised** by `doRevise()`: a new id, `version + 1`, `previous` pointing at the old id. With a model the text is rewritten; without one only "shorter" works (by rule). Any open Decision for the old wording is cancelled (`decisions.cancel(..., "the draft was revised")`) and `decision_id` is dropped.

(c) **Sent for approval** by `doSend()`: a Decision through the gate with `dedupe_key: "email:" + emailHash`, and `decision_id` stored on the draft. Asking again while it is OPEN returns the same Decision.

(d) **Already decided.** Once that Decision is APPROVED, MODIFIED, EXECUTED or VERIFIED, "send it" answers that the email was already sent or approved and that ROYAL won't send it twice; the record is never reopened (`APPROVAL_MODEL.md`, section 3). When the gate reports `already_decided` for identical content under a different draft, the draft is marked `sent: true` if the Decision was EXECUTED or VERIFIED.

(e) **Cancelled** by `doCancel()`: every open Decision in `open_decisions` and the draft's own are cancelled, open delegated tasks for the conversation are cancelled, the draft is marked `cancelled: true` and `pending_draft` is cleared.

(f) **Cleared** by the `clear` skill: `active_draft` and `pending_draft` become null.

**Which draft "send it" means.** `interpret()` in `core/intent.js` reads "send it", "send the email", "send the update" and similar as `send_pending`. `core/royal.js` gives it to the intelligence `send` whenever an outreach draft is open, unless a House `pending_draft` is also open and the words name the update ("update", "message to", "the client"), in which case the House skill sends the House draft. With both open and nothing to tell them apart, `doSend()` asks (section 5).

## 5. When ROYAL stops and asks

ROYAL returns `NEEDS_CLARIFICATION` rather than guess in these cases:

| Situation | Where | Reply |
|---|---|---|
| Several House records match a name | `royal.js` | "More than one commission matches. Which one?" with candidates |
| People question with no company | `doPeople()` | "Which company?" |
| More than one distinct company for the name | `doPeople()` via `resolveCompany()` | "More than one company goes by X. Which one?" Always asked, whatever the model's `is_ambiguous` says |
| Email asked with no person in context | `doContact()` | "Whose email?" |
| Outreach with no person or company | `doOutreach()` | "Who is it for?" |
| Revision with no open draft | `doRevise()` | "There's no draft open to change." |
| Send with no open draft | `doSend()` | "Send what?" |
| Send with an outreach email and a House update both open | `doSend()` | "Two messages are open ... Say "send the email" or "send the update"." |
| Send when the draft is to someone other than the person now discussed | `doSend()` | "The open draft is to X, but we've since been talking about Y." |
| Send with no usable address | `doSend()` | "I don't have an address for X." |

Two further rules do not ask but refuse to choose. (a) When sources name different people for one role, `doPeople()` reports the conflict and says it won't pick one. (b) A model reading of `send` with no active draft is downgraded to `unknown` in `classify()`, and a model `people_research` with no company becomes `current_research`.

Approval is never inferred from conversation. "Send it" only ever creates a Decision; only an owner resolving it (`DecisionService.resolve()`) can cause a send, and the voice session is told that approvals happen on screen (`voiceSessionConfig()` in `server/handler.js`).
