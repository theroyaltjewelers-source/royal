# UI PRIMITIVES

The complete vocabulary of things ROYAL can put on screen. Schemas live in `web/js/schema.js`; drawings in `web/js/primitives.js`. Everything is escaped; nothing in a spec is treated as markup.

| Primitive | Shows | Actions |
|---|---|---|
| STATEMENT | A sentence, with its evidence label | none |
| ENTITY_CORE | One project: name, client, stage, risk, target, why, next, verified facts, what ROYAL doesn't know | Balance; What's holding it up; Have GRACE prepare an update |
| RISK_OBJECT | Something needing attention | Open |
| RECEIVABLE_OBJECT | Money owed | Open |
| COMMITMENT_OBJECT | A promise and its date | Open |
| WAITING_OBJECT | Something waiting on someone | Open |
| LEAD_OBJECT | A sales lead | Open |
| DECISION_OBJECT | What, why, who asked, source, expected result, risk, money, reversibility, deadline, if we wait, verified facts, unknowns, draft | Approve; Edit (drafts); Reject; Ask ROYAL |
| MONEY_FLOW | A total and its parts | Open a part |
| PRODUCTION_FLOW | Counts by stage, with attention | none |
| TIMELINE | Ordered events | none |
| CLEAR_STATE | Whether Tahir can step away, and what was and wasn't checked | none |
| SYSTEM_HEALTH | Each system, connected or not | none |
| MESSAGE_VIEW | A draft message, clearly unsent | Send it (creates a decision) |
| SEARCH_RESULTS | Candidates when a name is ambiguous | Choose |
| ACTION_CONFIRMATION | Done, waiting, refused counts | none |
| NOT_CONNECTED | What isn't connected and what it would add | none |
| ERROR_OBJECT | Attempted, why it failed, impact, next | none |
| UNKNOWN_OBJECT | Used only if a primitive cannot be drawn | none |

## Evidence

Every item carries a quiet evidence line: Verified, Reported (not verified), Inferred, Recommendation or Unknown, with source and age. Inference is italic with a dotted underline and never looks like verified fact. Unknown is amber.

## Actions

Actions are declared with data attributes and handled in one place (`app.js`): `data-q` asks ROYAL a question as if Tahir said it; `data-res` resolves the decision it sits in; `data-edit` makes the draft editable and changes the approval to MODIFY. No primitive can trigger anything else.
