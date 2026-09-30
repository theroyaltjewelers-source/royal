# PLANNING ENGINE

*Written 30 September 2026 from the code on branch feature/intelligence.*

The planning engine, `core/intelligence/planner.js`, breaks a goal into steps and says honestly which of them ROYAL can do now, which need Tahir, and which cannot run because something is not configured. It is small on purpose: plans come from templates, are validated like any model output would be, and grant no authority.

## 1. What a plan is

A plan is `{ template, goal, steps }`. Each step is:

| Field | Meaning |
|---|---|
| `id` | Unique within the plan |
| `do` | The capability: `reason`, or a tool id from `TOOL_POLICY` in `core/permissions.js` |
| `after` | Ids of steps it depends on (optional) |
| `args` | Arguments known at planning time (optional) |
| `optional` | The goal can be met without it |
| `why` | One sentence, shown to Tahir |

After annotation each step also has `requires` and `available` (section 4).

## 2. Templates

`TEMPLATES` holds three plans. `planFor(intent, { configured })` picks one by intent.

| Template | Chosen for | Steps (optional ones in brackets) |
|---|---|---|
| `prospecting` | `prospecting` | `knowledge_search` (offer), `reason` (criteria), `web_search` (candidates), `person_search` (buyers), [`email_find`], [`email_verify`], [`create_crm_lead`], `reason` (synthesis) |
| `executive_contact` | `people_research`, `contact_lookup` | `company_search`, `person_search`, [`email_find`], [`email_verify`] |
| `outreach` | `outreach_draft` | `reason` (handoff), `draft_email`, `send_email`, [`create_crm_lead`] |

Any other intent returns `null`.

The prospecting template carries the intent's topic, count (default 5) and place into its step args; the executive-contact template carries company and role.

## 3. Validation

`validatePlan(plan)` returns `{ ok: true }` or `{ ok: false, errors }`. A plan fails when:

(a) it has no steps, or more than 20;

(b) a step id is missing or repeated;

(c) a step's `do` is neither `reason` nor a key of `TOOL_POLICY` (so a plan cannot name a tool that does not exist);

(d) a step depends on a step that is unknown or comes later (dependencies must point backwards, which also rules out cycles).

`planFor()` validates every template it builds and throws `PLAN_INVALID` if one fails. That is a programming error, not a runtime condition; the shipped templates pass (test "plans validate and never grant authority").

## 4. Annotation with configured tools

`annotate(plan, { configured })` adds two fields to every step.

(a) **`requires`**, read from `TOOL_POLICY`: `approval` for APPROVAL_REQUIRED, `prohibited` for PROHIBITED, `internal_write` for INTERNAL_WRITE, `none` for READ, ANALYZE, DRAFT and for `reason`.

(b) **`available`**: `configured[step.do]` coerced to a boolean when the caller supplied it, and `true` when it did not.

The only live caller is `doProspecting()` in `core/intelligence/index.js`, which passes:

| Key | Value |
|---|---|
| `web_search`, `person_search` | research status is CONNECTED (`ResearchEngine.status()`) |
| `email_find` | contact discovery is CONNECTED (`email_discovery` flag on and `HUNTER_API_KEY` or `APOLLO_API_KEY` set) |
| `email_verify` | verification is CONNECTED (`email_verification` flag on and `HUNTER_API_KEY` set) |
| `create_crm_lead` | always `false`: no CRM is connected |

`knowledge_search` is not passed, so it is always shown as available, even when no knowledge engine is loaded.

The plan is returned on the answer's surface (`type: "plan"` when research is not available, and inside `type: "prospects"` when it is), so Tahir sees the steps, what each would need, and what is missing. The test "routing: arithmetic, House knowledge, prospecting..." checks that with no provider the answer is NOT_CONNECTED and still shows a `PLAN_OBJECT`.

## 5. Planning grants no authority

This is the rule in the header comment of `planner.js`, and it holds in code for three reasons.

(a) **A plan is data.** Nothing in `planner.js` calls a tool, the gate or the Decision service. `annotate()` reads `TOOL_POLICY`; it never writes it and never calls `PermissionService.check()`.

(b) **Execution is separate.** Every step that acts would still go through `ConsequenceGate.request()` when it runs, where the permission engine decides. An APPROVAL_REQUIRED step (`send_email`, `create_crm_lead`) can only ever become a Decision for an owner. `requires: "approval"` in a plan is a description of that fact, not a grant.

(c) **Validation limits the vocabulary.** A plan can only name tools that already exist in `TOOL_POLICY`, so a plan (including a future model-proposed one) cannot invent a capability.

## 6. What is not built

(a) **Plan execution.** No code walks a plan's steps. `doProspecting()` runs its own fixed sequence (House offer search, one DEEP research call with two extra angles, one fetch per candidate to confirm the buyer's name) and attaches the plan for display. NOT IMPLEMENTED: a step runner, retries, or per-step status.

(b) **Model-proposed plans.** The header comment allows for them "through the same schema, validated the same way". No schema for plans exists and no model is asked for one. NOT IMPLEMENTED.

(c) **The other templates in the live path.** `executive_contact` and `outreach` are built only if `planFor()` is called with those intents, and nothing in `index.js` or `royal.js` does so. They are reachable from tests and future callers only.

(d) **The reasoning policy's `plan` flag.** `reasoningPolicy()` sets `plan: true` at level 5, but no code reads it (see `MODEL_ROUTING.md`).
