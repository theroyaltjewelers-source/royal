# ROYAL RESEARCH ROUTING

*Sources: `core/intelligence/intent_engine.js` (rules), `core/intelligence/reasoning.js`, `core/intelligence/truth.js` (`needsCurrentInfo`).*

(a) **Internal** ("What does Marcus owe?"): the calculator snapshot, through the House skills. Never searched, never asked of a model. ROYAL checks without asking "would you like me to check?".

(b) **World, stable** ("Who founded Nike?"): one model call at low effort, labelled as the model's general knowledge, not checked against a source.

(c) **World, current** ("Who is Nike's current CFO?", prices, news, roles): research with web search at medium effort, sources fetched by ROYAL itself to cross-check, every claim labelled. If research is not connected, ROYAL says so and does not answer from memory as if current.

(d) **Mixed** ("Would Nike be a good corporate gifting prospect?"): research plus House knowledge plus reasoning, through the intelligence layer.

(e) **Unplaced**: one answering call over House facts; when it says the question needs the outside world, it goes to (c).

(f) **When to search:** freshness matters, a current role or price, news, verification asked for, or ROYAL lacks a reliable answer. Not for House records, definitions, arithmetic or greetings.
