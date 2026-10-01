# ROYAL INTELLIGENCE EVALUATIONS

Automated checks by category, each in `npm test`:

| Category | Where | What is scored |
|---|---|---|
| Identity, first person | `tests/correction.test.js` | no third person across 13 questions; identity built from live state |
| House knowledge | `tests/correction.test.js`, `tests/intelligence.test.js` | definitions from House sources; right policy with status |
| Live House state | `tests/royal.test.js` | answers from the snapshot, valid presentation |
| Business concepts | `tests/knowledge_fabric.test.js` | 14 benchmark questions answered from the right pack, no model |
| Current law and tax | `tests/knowledge_fabric.test.js` | routed to live research; never answered from the reference |
| Agent routing and reporting | `tests/multiagent.test.js` | bot questions to records; per-agent isolation; unverified marked |
| Failure handling | `tests/multiagent.test.js` | timeout, malformed result, unreadable feed, 20-request stress |
| Speed by construction | `tests/correction.test.js` | model calls per path, reasoning effort |
| Voice | `tests/voice.test.js` | streaming, barge-in, fallback, gaps |
| Verification | `tests/grokbot.test.js` | bot round trip before CONNECTED_VERIFIED |
| No fake data | `tests/royal.test.js` | NOT CONNECTED without a calculator or provider |

Unsupported claims are tested by construction (labels, sources, NOT CONNECTED), not by a single quality score. Not automated: answer quality with the live model, which needs `npm run bench` and the conversation checks in `ROYAL_ACCEPTANCE_TESTS.md`.
