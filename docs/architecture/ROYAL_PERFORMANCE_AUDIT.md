# ROYAL PERFORMANCE AUDIT

*1 October 2026, from the code on branch `claude/eloquent-carson-rgtnor`. Companion to `ROYAL_LATENCY_AUDIT.md` (the waterfalls) and `ROYAL_PERFORMANCE_BUDGET.md` (the targets).*

## 1. Root causes found

(a) **Every model call reasoned at the provider's default, high.** The configured model is `grok-4.3`, a reasoning model whose `reasoning_effort` defaults to `high`. `GrokProvider` never set it, so classifying a greeting, answering "who are you" and every House summary paid for deep reasoning. Fixed: effort follows ROYAL's reasoning level (`effortFor()` in `core/providers/grok.js`).

(b) **Two model calls in a row for anything the rules could not place.** `handle()` asked the model to classify the sentence, then asked it again to answer (`openQuestion()`). "Hey ROYAL" took that path. Fixed: unplaced sentences go to one answering call, which says itself when outside research is needed.

(c) **No fast path.** Greetings, "who are you" and thanks reached the model. Fixed: `core/identity.js`, answered in milliseconds with no model call.

(d) **No prompt cache affinity.** No `x-grok-conv-id` header or `prompt_cache_key`, and the stable instructions were short and scattered, so each call was processed cold. Fixed: one conversation key per conversation; one stable prefix (identity, then House language) on every prompt.

(e) **A silent second call on any 400.** `complete()` retried every 400 without `max_tokens`, on every call. Fixed: an optional setting a model rejects is dropped once and remembered.

(f) **Nothing streamed, and the voice waited for the whole reply.** ROYAL's server voice fetched one audio file for the entire reply before the first sound. Fixed: speech is fetched by sentence, the first sentence alone, the next while the current one plays (`web/js/playback.js`). Text streaming of model output is not built (section 4).

(g) **Realtime voice scheduled each audio chunk on arrival with no buffer.** A chunk a few milliseconds late found the queue already empty, and Tahir heard a gap: the "skippy" voice. Fixed: one playback queue with a moving cursor and a small adaptive jitter buffer, with gaps counted.

(h) **Independent House reads ran one after another** in `openQuestion()`. Fixed: in parallel.

(i) **A House definition was answered with a House report.** "What does production deposit mean?" matched the word "production" and returned the production status. Fixed: definitional questions are answered from the House language registry.

## 2. Measured: before and after

Against a simulated xAI that answers every model call after exactly 700 ms (`server/bench.js`, 3 runs each, same machine). This isolates what ROYAL's own orchestration costs; it cannot show the effect of (a), which depends on xAI.

| Benchmark | Before p50 | After p50 | Model calls before | After |
|---|---|---|---|---|
| Greeting ("Hey ROYAL") | 1,414 ms | 10 ms | 2 | 0 |
| Identity ("Who are you?") | 708 ms | 4 ms | 1 | 0 |
| Simple calculation | 6 ms | 6 ms | 0 | 0 |
| Internal lookup (what Marcus owes) | 3 ms | 4 ms | 0 | 0 |
| House operations (what needs me) | 3 ms | 5 ms | 0 | 0 |
| House definition | 3 ms (wrong answer, cause (i)) | 2 ms | 0 | 0 |
| House policy | 706 ms | 707 ms | 1 | 1 |
| World fact | 705 ms | 706 ms | 1 | 1 |
| Current executive | 705 ms | 706 ms | 1 | 1 |
| Open question | 1,410 ms | 708 ms | 2 | 1 |
| Whole benchmark | | | 24 xAI calls | 12 |

Voice, in Chromium against a stand-in voice service that answers at once: first sound 286 ms (phone size) and 183 ms (desktop, from the server cache), 0 gaps.

## 3. Not measured here

The live numbers depend on xAI and could not be measured from this environment (no `XAI_API_KEY`, and xAI's hosts are not reachable from it). Run on the real server:

`ROYAL_URL=https://royal-1wx5.onrender.com ROYAL_TOKEN=<session token> npm run bench`

and read the Systems view's "ROYAL'S VOICE" line on the phone for first sound and gaps. Not measured: the effect of low reasoning effort, real prompt cache hit rates (now recorded as `provider.cached_tokens`), live time to first audio, a 10-minute voice session, real turn detection.

## 4. Not done in this pass

(a) Streaming model text to the screen (`/v1/command/stream`): planned as Phase 1 of the Jarvis plan; the voice already streams by sentence.

(b) A text-to-speech WebSocket (`wss://api.x.ai/v1/tts`) for word-by-word audio: needs a WebSocket client on the server, which Node 20 lacks without a new dependency (ADR-011).

(c) The live Grok Bot round trips: no bot webhooks exist in this environment. The route and status model are built and tested (`ROYAL_GROK_BOT_CONNECTIVITY.md`).
