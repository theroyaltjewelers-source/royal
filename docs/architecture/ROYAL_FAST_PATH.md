# ROYAL FAST PATH

*Sources: `fastPath()` in `core/identity.js`, `definitionQuery()` in `core/house_language.js`, the skills at the end of `skills/index.js`.*

| Sentence | Skill | Answer | Model calls |
|---|---|---|---|
| "Hey", "Hey ROYAL", "Good morning" | `greeting` | a greeting by the time of day in America/New_York, plus how much needs Tahir when the calculator is connected ("Good evening, Tahir. 4 things need you.") | 0 |
| "Who are you?", "What can you do?" | `identity` | `describeSelf()` from what is connected right now | 0 |
| "Thanks" | `thanks` | "Anytime." | 0 |
| "What does production deposit mean?" | `house_term` | the House definition, with its source and any open question | 0 |
| "What's 20% of 5000?" | `intel:calculation` | exact arithmetic | 0 |
| "What does Marcus owe?" | House skill | from the calculator snapshot | 0 |

The patterns are anchored to the whole sentence, so "Hey, what does Marcus owe?" or "thanks, now send it" are not swallowed by the fast path (tested). Greeting, identity and thanks work in both realms; the Personal versions never mention the business.
