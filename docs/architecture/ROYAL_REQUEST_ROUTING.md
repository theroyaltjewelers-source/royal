# ROYAL REQUEST ROUTING

*Source: `handle()` in `core/royal.js`, `core/router.js`, `core/intent.js`, `core/intelligence/intent_engine.js`.*

## 1. Order of decisions

(a) **Realm.** Personal requests go to `handlePersonal()`: no business reads, no model call.

(b) **Controls:** clear, back, send, stop.

(c) **Fast path** (`ROYAL_FAST_PATH.md`): greeting, who are you, thanks, a House word. No model.

(d) **A named record.** A sentence that resolves to a House record stays with the House skills.

(e) **House rules.** What needs me, who owes us, waiting, commitments, production, and the rest: deterministic skills over the calculator snapshot. No model.

(f) **Intelligence by rules.** Arithmetic, sources, cancel, revise, people research, contacts, outreach, prospecting, House knowledge, world knowledge and current research, recognised by rules without a model.

(g) **Unplaced.** One answering call (`openQuestion`) over House facts read in parallel. If the answer needs the outside world, the call says so and the request goes to research.

(h) **Classification by model** only when the rules recognised a kind of request but the router did not place it.

## 2. The routing decision

Each request ends with `result.route`, `result.intent` and `result.timing.path`. In the terms of the correction brief: answer_directly is the fast path and House skills; needs_internal_retrieval is every House path; needs_external_research is `intel:current_research` and friends; agents are listed in `result.delegations`; reasoning effort per call is in `result.timing.calls`. None of this is shown to Tahir by default.

## 3. Rules that hold

(a) House state never comes from a model. (b) A sentence naming a House record stays with the House. (c) Consequential ambiguity stops and asks. (d) Nothing runs because it exists: no planner, agent, search or model unless the path needs it.
