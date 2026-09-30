# INTENT ENGINE

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

The intent engine, `core/intelligence/intent_engine.js`, answers one question: what is Tahir asking for, and what will answering it take? It has two interpreters that produce the same structured intent: a model interpreter validated against a schema, and a rules interpreter that is always available. It sits beside the older House intent layers, `core/intent.js` and `core/router.js`, which it does not replace.

## 1. Vocabulary

`INTENTS` lists eighteen intents:

| Group | Intents |
|---|---|
| House | `house_state`, `house_record`, `house_knowledge` |
| World | `world_knowledge`, `current_research`, `company_research` |
| People | `people_research`, `contact_lookup`, `prospecting` |
| Drafts | `outreach_draft`, `revise_draft`, `send` |
| Conversation | `show_sources`, `cancel` |
| Other | `calculation`, `delegate`, `personal`, `unknown` |

The dispatcher in `core/intelligence/index.js` handles thirteen of them (`calculation`, `house_knowledge`, `world_knowledge`, `current_research`, `company_research`, `people_research`, `contact_lookup`, `outreach_draft`, `revise_draft`, `send`, `show_sources`, `cancel`, `prospecting`), with the three world intents sharing `doWorld()`. `house_state`, `house_record`, `delegate`, `personal` and `unknown` return `null` from `handle()` and are left to the House skills or `openQuestion()`.

## 2. Schema

`INTENT_SCHEMA` is built with the `S` helpers from `jsonschema.js`, so every property is required and `additionalProperties` is false (strict mode needs this; optional values are nullable).

| Field | Type |
|---|---|
| `intent` | one of `INTENTS` |
| `goal` | string, up to 200 |
| `entities` | `{ company, person, role, place, topic }` nullable strings, and `agent`: one of `ace`, `grace`, `ledger`, `house`, `forge`, or null |
| `refers_to_context`, `needs_current_web`, `needs_internal_data`, `needs_house_knowledge` | boolean |
| `action_requested` | `none`, `draft`, `revise`, `send`, `create_task`, `create_lead`, `delegate` |
| `research_depth` | `QUICK`, `STANDARD`, `DEEP` |
| `response_mode` | `brief`, `normal`, `deep`, `decision`, `research`, `instructional` |
| `revision_instruction` | nullable string, up to 300 |
| `count` | nullable number |

Both interpreters add `interpreted_by` (`model` or `rules`) and `confidence`. A model result that fell back to rules also carries `model_failed`.

## 3. Rules interpreter

`classifyByRules(text, context)` is deterministic. `context` is the conversation's active context. First match wins:

(a) `cancel`: the whole message is a bare cancellation: stop, cancel, abort, halt, don't send, do not send, never mind, forget it or forget that, optionally with "please", optionally followed by it, that, this, everything or "the email / draft / message / send / sending / update / approval / request / task / research" (`R.cancel`, anchored at both ends; 0.9). A longer sentence that starts with one of these words ("Stop the Marcus production", "Forget it, what does Marcus owe?") is not a cancellation. What `doCancel` then does is in `APPROVAL_MODEL.md`, section 4.

(b) `show_sources`: "where did you get that", "what are your sources", "how do you know", "cite" (0.9).

(c) `calculation`: `looksArithmetic()` from `calc.js` (0.95). It needs a digit and either a percentage with a number after "of" ("12% of $85,000", "12 percent of 85,000") or a number, an operator or operator word, and another number. "20% of what Marcus owes" has no number after "of" and is not arithmetic, so it stays a House question.

(d) `revise_draft`: an `active_draft` exists, the text has a revision cue (shorter, warmer, rewrite, make it, change the tone, and so on) and no people cue (0.85).

(e) `outreach_draft`: an outreach cue (pitch, intro, reach out to, write them, draft an email) or "have ACE ... write/draft/intro/pitch", and an active person or company, and `focus === "research"`. `entities.agent` is the named agent, or `ace` when none is named (0.85).

(f) `contact_lookup`: an email or contact cue, plus an active person or a role word, and no House words once "email" is removed (0.85).

(g) `people_research`: a role (CFO, CEO, president, founder, head of X, VP X, director of X) and a people cue (who is, find, look up). The company comes from "of/at/for/from <Capitalised Name>", or from `active_company` when the text says their, they, them or that company. No company, no match (0.85, depth STANDARD).

(h) `prospecting`: a find/identify/build/list verb with prospects, leads, companies, firms or buyers, but not "pipeline" or "any leads". Count from a digit or three to ten (default 5, clamped 1 to 10); place from "in/around/near <Name>" (0.8, depth DEEP).

(i) `house_knowledge`: our policy, process, standards, warranty; "how do we handle"; "what is our deposit"; "can Tori approve" (0.8).

(j) `current_research` or `world_knowledge`: a question word at the start, no House words (we, our, us, the house, client, commission, project, production, owe, paid, balance, deposit, order), and no self-directed words (`R.self`: should I, do I, am I, shall I, can I, my day, my schedule, my calls, my list, my team, my week, my meetings, my appointments, my priorities). So "Who should I call today?" is not a world question (tested). `needsCurrentInfo()` from `truth.js` decides current (0.7, depth STANDARD) or stable (0.6, depth QUICK).

(k) Otherwise `unknown` (0.2).

The rules never produce `company_research`, `send`, `delegate`, `house_state`, `house_record` or `personal`; `send` reaches the dispatcher through `core/intent.js` (section 5).

## 4. Model interpreter

`classify(text, { context, provider, useModel, metrics })` always runs the rules first.

(a) **Never for what must be exact.** If the rules say `calculation`, `cancel`, `show_sources` or `revise_draft`, that result is returned and no model is asked.

(b) **Only with a capable provider.** The model is skipped when `useModel` is false (`flags.llm_synthesis === false`), when there is no provider, when it lacks `structured_output`, or when its status is NOT_CONNECTED. The rules result is returned.

(c) **The call.** `provider.structured()` with `name: "royal_intent"`, level 1, 12 second timeout. The request (clipped to 1,000 characters) and a context summary (`active_company` name, `active_person` name and title, `active_project` name, `has_draft`, `focus`) go inside a `<data>` envelope with the instruction that it is data.

(d) **Validation.** A provider failure returns the rules result with `model_failed` set to the reason. The reply is checked again with `check(INTENT_SCHEMA, ...)`; a mismatch returns the rules result with `model_failed: "SCHEMA"`. Nothing is repaired.

(e) **Rules win where a wrong guess is costly.** A model `delegate` becomes `outreach_draft` when the rules said outreach. A model `send` with no `active_draft` becomes `unknown`. A model `people_research` with no company and no `active_company` becomes `current_research` (unless the rules also said `people_research`). A role the code does not recognise (`roleKey()` in `people.js`) is replaced by the rules' role.

The test "model interpretation is used only when valid" shows a valid model reply accepted as `interpreted_by: "model"`, an invalid intent (`delete_everything`) falling back to rules with `model_failed`, and arithmetic never reaching the model.

## 5. Coexistence and ordering in core/royal.js

Three layers run on a business command in `handle()`:

(a) `interpret()` in `core/intent.js`: control verbs, "have <agent> ..." delegation, and follow-ups about a resolved House record. `CLEAR` is clear, reset, start over, that's all, dismiss ("never mind" is no longer here; it is a cancellation). `SEND` is "send it / that / this", "send the message / update / draft / reminder / email / intro / introduction", "go ahead and send", "ship it", optionally after ok, yes or go ahead.

(b) `route()` in `core/router.js`: ordered House rules, then `open_question` with reason `NO_RULE`.

(c) `intelligence.preclassify()`: `classifyByRules()` on every command that did not name a skill.

Write `named` for "a House record resolved from the sentence itself": `resolveEntity()` returned RESOLVED, strong, and not `via: "conversation"`. The intelligence intent is then chosen in this order (`core/royal.js`, the block after "The intelligence layer takes what the House skills don't"):

1. `send_pending` from `interpret()` with an open outreach draft becomes intent `send`, unless a House `pending_draft` is also open and the words name the update ("update", "message to", "the client"). `doSend` then asks if both are open and the words do not say which (`CONVERSATION_CONTEXT.md`, section 4).
2. Any other CONTROL verb (clear, back, send with no open outreach draft) stays with the House.
3. A rules intent in `INTEL_EARLY` (`calculation`, `show_sources`, `cancel`, `revise_draft`, `people_research`, `contact_lookup`, `outreach_draft`, `prospecting`, `house_knowledge`) wins. The conversational controls (`show_sources`, `cancel`, `revise_draft`, the `INTEL_CONTROL` list) win always; the others win only when the sentence is not `named`. So "Find me leads for Marcus" stays with the House, while "Find their business email" after a House record was discussed still reaches the intelligence layer.
4. A rules `current_research` or `world_knowledge` wins when no House record was strongly resolved (by the sentence or from the conversation) and the House router found no skill.
5. If the House router fell through to `open_question`, the model interpreter runs, and its intent is used if it is in `INTEL_ANY` (the early list plus `world_knowledge`, `current_research`, `company_research`, `send`).
6. Otherwise the House skill runs.

So "Any leads in the pipeline?" stays `sales_pipeline`, "What's happening with Marcus Hill's Cuban link chain?" stays `project_status`, "What is 20% of what Marcus owes?" stays with the House, and "Find five strong corporate gifting prospects in Raleigh" goes to `intel:prospecting` even though the House router would have matched "prospects". The House-side cases are tested in "review: House sentences stay with the House; bare controls still work".

The model interpreter only runs on step 5, which means at most one interpretation call per command, and none for anything a House rule or an early intelligence rule recognised.

Note that step 4 still treats a record carried from the conversation as blocking: a world question containing a pronoun right after a House record was discussed ("What is it worth at today's gold price?") is not taken by step 4, and reaches the intelligence layer only if the House router falls through and the model interpreter in step 5 claims it.
