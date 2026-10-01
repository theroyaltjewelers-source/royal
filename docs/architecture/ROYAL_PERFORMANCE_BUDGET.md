# ROYAL PERFORMANCE BUDGET

*Request and voice budget. The rendering budget for the Core is in `PERFORMANCE_BUDGET.md`.*

| Interaction | Target | Measured here (simulated xAI at 700 ms per call) | Live |
|---|---|---|---|
| Visual acknowledgement | under 100 ms | the Core answers on pointer down | to check on the phone |
| Greeting, identity, thanks, definitions | first useful output under 1 s | 2 to 10 ms, no model | `npm run bench` |
| House records and operations | under 1 s | 2 to 5 ms, no model | `npm run bench` |
| One-model-call answers | one call at low effort | about 705 ms (the simulated call) | `npm run bench` |
| Research | acknowledge at once, then the answer | one round of parallel searches | `npm run bench` |
| First sound, server voice | as soon as the first sentence is ready | 183 to 286 ms beyond the voice service | Systems view, "ROYAL'S VOICE" |
| Gaps in speech | none | 0 | Systems view |

Rules: no longer timeouts as a fix; no filler audio; no large audio buffers (60 to 240 ms); no model where code decides reliably; independent reads in parallel; effort low unless the request needs more.
