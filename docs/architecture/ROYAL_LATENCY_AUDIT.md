# ROYAL LATENCY AUDIT

*1 October 2026. Durations measured against a simulated xAI at 700 ms per call (`ROYAL_PERFORMANCE_AUDIT.md`, section 2). Every request now carries `result.timing` with these marks.*

## 1. Before: an unplaced sentence ("Hey ROYAL")

| Stage | Duration | Required? | Parallelizable? | Cacheable? | Avoidable? | Blocking? | Optimization |
|---|---|---|---|---|---|---|---|
| Normalize command, read latest snapshot | 1 ms | yes | no | in memory | no | yes | none needed |
| Resolve entity, route by rules | 1 ms | yes | no | no | no | yes | none needed |
| Model: classify intent (high effort) | 700 ms + reasoning | no | no | no | yes | yes | fast path; skipped for unplaced sentences |
| House reads: state of the House, then what needs me | 2 ms | yes for open questions | yes | no | no | yes | run in parallel |
| Model: answer (high effort) | 700 ms + reasoning | for open questions | no | prefix cacheable | no | yes | low effort, cache key |
| Compose presentation, audit | 1 ms | yes | no | no | no | yes | none needed |
| Voice: fetch audio for the whole reply | whole reply | yes | no | per process | no | yes | by sentence, pipelined |
| Voice: play | reply length | yes | no | no | no | no | queue with jitter buffer |

Total before the first sound: two model calls at high effort, plus the audio for the entire reply.

## 2. After

| Request | Path | Model calls | What happens |
|---|---|---|---|
| Greeting, who are you, thanks | `house:greeting`, `house:identity`, `house:thanks` | 0 | answered from the identity doctrine and live connection state |
| What a House word means | `house:house_term` | 0 | House language registry |
| House state and records | `house:<skill>` | 0 | deterministic skills over the calculator snapshot |
| Arithmetic | `intel:calculation` | 0 | the calculator in `core/intelligence/calc.js` |
| Unplaced question | `open_question` | 1 (low effort) | parallel House reads, one answer; a second step only if it needs the world |
| World fact, House policy | `intel:world_knowledge`, `intel:house_knowledge` | 1 (low effort) | one call |
| Current research | `intel:current_research` | search calls at medium effort | parallel searches |

Voice after: the first sentence is requested alone and plays as soon as it arrives; the next is fetched while it plays; pieces are scheduled back to back.

## 3. The marks

`request_received`, `intent_complete`, `context_complete`, `first_model_request`, `final`, plus each model call's kind, duration, effort, tokens and cached tokens (`core/trace.js`). Metrics keep p50 and p95 per path (`GET /v1/developer/metrics`). The page keeps first-sound times and gaps per device (Systems view).
