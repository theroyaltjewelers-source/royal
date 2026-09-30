# UI COMPOSER

`core/composer.js`. Runs on the server for every answer, in both realms.

## 1. Contract

Input: a ROYAL result (summary, surface, delegations, status, risk). Output: a presentation spec, version 1.

```
{ version: 1, mode, realm, tone, speech, focus_entity, agents: [{id, name, state}], surfaces: [{type, data}] }
```

(a) `mode` is one of the modes in `web/js/schema.js` and tells the stage what kind of answer this is (exceptions, focus, money, draft, decision, systems, ambient, back, and so on).

(b) `speech` is the sentence ROYAL says and shows. It is the result's summary, written to be read aloud.

(c) `tone` is calm, attention or alert, from the result's risk and whether Tahir is needed.

(d) `agents` lists each specialist that took part, once, with state reported, did_not_report or not_connected.

(e) `surfaces` are primitives, at most sixteen.

## 2. Rules

(a) **Deterministic.** The same result always gives the same spec.

(b) **Only known primitives.** Each surface type from the skills maps to primitives by a fixed table. A result with nothing to show gives a spec with no surfaces, and the stage stays at rest.

(c) **No model-written specs.** A model's answer can only become a STATEMENT, labelled INFERENCE.

(d) **Validated before it leaves.** `validateSpec` drops any primitive that fails its schema, never repairs it, and reports the rejection. A rejection is audited as `COMPOSER_REJECTED`. The page validates again before rendering.

(e) **Failures are objects.** A failed result produces an ERROR_OBJECT: what was attempted, why it failed, the impact, the next action.

## 3. Adding a surface

Add the primitive to `web/js/schema.js` with its schema, its renderer to `web/js/primitives.js`, and its mapping to `fromSurface` in the composer. The test "every answer carries a valid presentation" covers the rest.
