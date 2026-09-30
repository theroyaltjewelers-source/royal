# MODEL ROUTING

*Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.*

Not every request deserves the same amount of thinking. The reasoning router, `reasoningPolicy(intent, text)` in `core/intelligence/reasoning.js`, gives each intelligence request a level from 0 to 5 and derives limits from it. The level names are the frozen enum `REASONING_LEVEL` in `core/enums.js`.

This document describes what is implemented. The policy is enforced for world and research questions in `doWorld()`; two derived fields are still computed without being read, and are marked NOT USED.

## 1. The levels

| Level | Name | Meant for | Example in the header comment |
|---|---|---|---|
| 0 | DIRECT_RETRIEVAL | Read authoritative data, no model | "What does Marcus owe?" |
| 1 | QUICK | Arithmetic, a policy, a stable fact | "12% of $85,000" |
| 2 | OPERATIONAL | Several House facts together | "Why is this project behind?" |
| 3 | DEEP | Many variables, trade-offs | "Sequence these obligations" |
| 4 | AGENTIC_RESEARCH | Search, resolve, cross-check | "Find the CFO of X" |
| 5 | EXECUTION_PLANNING | Decompose, delegate, act, verify | Prospect lists |

## 2. How a level is chosen

(a) **By intent.** `BY_INTENT` maps each intent to a base level:

| Level | Intents |
|---|---|
| 0 | `house_state`, `house_record`, `show_sources`, `cancel`, `send`, `personal` |
| 1 | `calculation`, `house_knowledge`, `world_knowledge`, `revise_draft` |
| 2 | `outreach_draft`, `delegate`, `unknown` |
| 4 | `current_research`, `company_research`, `people_research`, `contact_lookup` |
| 5 | `prospecting` |

An intent not in the table gets level 2.

(b) **Why questions.** A `house_record` intent whose text matches `WHY` (`why`, `what's holding`, `what's blocking`, `explain`, `cause`, `behind`, `late`) is raised to 2.

(c) **Deep questions.** An `unknown` or `world_knowledge` intent whose text matches `DEEP` (`sequence`, `prioritise`/`prioritize`, `trade-off`, `should we`, `should I`, `best way`, `strategy`, `plan for`, `without hurting`, `scenario`) is raised to 3. Self-directed questions such as "should I" are not classified as `world_knowledge` by the rules in the first place (`INTENT_ENGINE.md`, section 3 (j)); a model can still classify one that way.

Nothing selects level 3 or 5 any other way, and nothing lowers a level.

## 3. What each level sets

`reasoningPolicy()` returns:

| Field | Rule | Read by |
|---|---|---|
| `level`, `name` | As above | `handle()` in `index.js` attaches `{ level, name, interpreted_by }` to the result as `reasoning`; metrics count `route.level.<n>` |
| `use_model` | Level 1 or above, except `calculation`, `show_sources`, `cancel` | `doWorld()`: the model answers a world question only when this is true |
| `model_tier` | `fast` at level 0 or 1, else `reasoning` | `doWorld()`: `fast` passes level 1 to the provider; `reasoning` passes the policy's own level |
| `max_tokens` | `[300, 400, 700, 1200, 1200, 1600][level]` | `doWorld()`, for the model-knowledge completion |
| `allow_search` | Level 4 or above, or `needs_current_web` | `doWorld()`: web research runs for a current question, or as the fallback after a failed model call, only when this is true |
| `research_depth` | DEEP at level 5; at level 4 the intent's `research_depth` or STANDARD; otherwise null | `doResearch()`, first: `policy.research_depth || intent.research_depth || "QUICK"` |
| `allow_agents` | Level 2 or above | NOT USED |
| `plan` | Level 5 | NOT USED (prospecting calls `planFor()` itself) |

**How `doWorld()` applies it** (`core/intelligence/index.js`):

(a) A current question (`needs_current_web`, or intent `current_research`) with `allow_search` goes to research. If research is not CONNECTED it answers NOT_CONNECTED and says it won't answer from memory as if current.

(b) Otherwise, with a connected provider and `use_model`, the model answers from general knowledge at the tier and token limit above, labelled `MODEL_KNOWLEDGE`. If the call fails and research is connected and `allow_search` is true, research runs instead; otherwise ROYAL says the provider did not answer.

(c) Otherwise (no provider, or `use_model` false), research runs if it is CONNECTED, without consulting `allow_search`; if it is not, ROYAL says world questions need the language provider.

**Depth for current questions.** A rules `current_research` carries `research_depth: "STANDARD"` and sits at level 4, so it runs one search and up to two cross-check fetches. A model classification may set its own `research_depth`, which the level 4 policy honours.

## 4. Which model actually runs

Each call passes a `level` to the provider, and `GrokProvider.modelFor(level)` returns `ROYAL_GROK_FAST_MODEL` for levels 0 and 1 when that variable is set, and `ROYAL_GROK_MODEL` otherwise (`core/providers/grok.js`).

| Call | Level passed | Model with a fast model set |
|---|---|---|
| Intent interpretation, `classify()` | 1 | fast |
| House knowledge answer, `doKnowledge()` | 1 | fast |
| World knowledge, `doWorld()` | 1 when `model_tier` is `fast`, else the policy level | fast at level 1; main when a DEEP question raised it to 3 |
| Draft revision, `doRevise()` | 1 | fast |
| Outreach draft, `draftOutreach()` | 2 | main |
| Every research search, `ResearchEngine.research()` | 4 | main |
| Open question, `openQuestion()` in `core/royal.js` | none | main |

So a `world_knowledge` question raised to level 3 by the DEEP rule runs on the main model with 1,200 tokens. With `ROYAL_GROK_FAST_MODEL` unset, every call uses `ROYAL_GROK_MODEL`. With `ROYAL_GROK_MODEL` unset the provider is NOT CONFIGURED and no model runs at all.

## 5. Levels that never reach a model

(a) `calculation` (level 1) is handled by `calculate()` in `calc.js`; the test "routing: arithmetic..." asserts that "What is 12% of $85,000?" returns `$10,200.` with zero provider calls.

(b) `show_sources`, `cancel` and `send` (level 0) read the conversation and the Decision service only.

(c) `house_state` and `house_record` are level 0 in the table, but the intelligence dispatcher has no handler for them: they are answered by the deterministic House skills before the intelligence layer is consulted.

## 6. Examples from the tests

The test "the reasoning router gives each request the right level" in `tests/intelligence.test.js` asserts:

| Intent | Text | Level |
|---|---|---|
| `house_state` | | 0 |
| `calculation` | | 1 (and `use_model` is false) |
| `house_record` | "Why is this project behind?" | 2 |
| `unknown` | "How should we sequence these obligations without hurting production?" | 3 |
| `people_research` | | 4 |
| `prospecting` | | 5 |

End to end, the level travels on the result as `result.reasoning` (the tests do not assert it there): "Who is the CFO of Acme?" is answered by `intel:people_research` at level 4, and "Find five strong corporate gifting prospects in Raleigh..." by `intel:prospecting` at level 5, which the tests show returns its plan even when research is NOT CONNECTED. No test asserts the `use_model`, `model_tier` or `allow_search` branches of `doWorld()` directly.
