# ROYAL CONTEXT ASSEMBLY

*Sources: `systemPrompt()` in `core/identity.js`, `houseLanguagePrompt()` in `core/house_language.js`, `_post()` in `core/providers/grok.js`.*

## 1. Order of every model prompt

(a) ROYAL identity (stable). (b) House language (stable). (c) The task's rules and output schema (stable per kind of call). (d) Untrusted data, inside `<data>` with the UNTRUSTED notice (dynamic). (e) Tahir's request (dynamic).

Nothing volatile (dates, records, ids, timestamps) is placed in (a) to (c). Research prompts carry today's date in their task block, after the stable prefix.

## 2. Prompt cache affinity

The trace for each request (`core/trace.js`) carries the conversation id, `REALM:conversation_id`. The provider sends it as the `x-grok-conv-id` header on Chat Completions and as `prompt_cache_key` on the Responses API, as xAI recommends, so one conversation's calls reach the same server and the stable prefix is served from cache. Cached tokens are recorded per call and as the metric `provider.cached_tokens`.

## 3. What is loaded per path

Selective, never everything: open questions get the state-of-the-House lines and up to 12 findings; House knowledge answers get the top 5 retrieved passages; world answers get only the question; research gets the question and its angles. The whole Company Bible, every constitution and the whole conversation are never loaded. Canonical ids stay in the conversation context, outside any model summary.
