# MODEL PROVIDER ARCHITECTURE

*Written 30 September 2026 from the code on branch feature/intelligence.*

ROYAL is the product; a model provider is an implementation dependency. Every model call goes through one interface, declared in the header comment of `core/providers/provider.js`. Swapping vendors means a new file in `core/providers/` and nothing else. A provider never decides what ROYAL may do: authority stays in `core/permissions.js`.

## 1. The AIProvider interface

| Member | Returns | Notes |
|---|---|---|
| `id` | string | `"grok"`, `"scripted"` or `"none"` |
| `status()` | `{ status, detail?, model? }` | `status` is a `CONNECTION` value: CONNECTED, NOT_CONNECTED, DEGRADED or ERROR |
| `capabilities()` | object of booleans | See section 2 |
| `complete({ system, messages, max_tokens, timeout_ms, level })` | `{ ok, text, usage }` or a failure | Plain text completion |
| `structured({ system, messages, schema, name, level, timeout_ms })` | `{ ok, value, usage }` or a failure | `value` has already passed `check()` from `jsonschema.js` |
| `search({ query, system, allowed_domains, excluded_domains, x, schema, level, timeout_ms })` | `{ ok, text, citations, usage }` (plus `value` with a schema) | Server-side search |
| `voiceSession({ seconds })` | `{ ok, token, expires_at, ws_url, model }` | Ephemeral browser token |

A failure is `{ ok: false, failed_because, retryable, detail? }`. The header comment names two reasons for a provider that cannot do something: `CAPABILITY_NOT_SUPPORTED` and `PROVIDER_NOT_CONNECTED`. Nothing falls back to pretending.

`parseModelJson()` in the same file strips code fences, tries `JSON.parse`, then tries the first `{...}` span, and otherwise returns `MODEL_REPLY_NOT_JSON`.

## 2. Capability flags

`capabilities()` returns eight flags: `structured_output`, `tool_calling`, `search`, `x_search`, `vision`, `realtime_voice`, `embeddings`, `reasoning_effort`.

| Flag | UnavailableProvider | ScriptedProvider default | GrokProvider |
|---|---|---|---|
| structured_output | false | true | true when status is not NOT_CONNECTED |
| tool_calling | false | true | same |
| search | false | true | same |
| x_search | false | false | same |
| vision | false | false | same |
| realtime_voice | false | false | true whenever a key is set (model not required) |
| embeddings | false | false | false |
| reasoning_effort | false | false | false |

Callers read these flags before calling: `classify()` needs `structured_output`, `ResearchEngine.status()` needs `search`, `doKnowledge()`, `draftOutreach()` and `doRevise()` need `structured_output`, and `POST /v1/voice/session` needs `realtime_voice`. `tool_calling` and `vision` are declared but no caller uses them.

## 3. GrokProvider (core/providers/grok.js)

### 3.1 Configuration

Built in `server/node.js` when `XAI_API_KEY` or `ROYAL_GROK_MODEL` is set, with `fastModel` from `ROYAL_GROK_FAST_MODEL`, `voiceModel` from `ROYAL_VOICE_MODEL` (default `grok-voice-latest`) and `voice` from `ROYAL_VOICE` (default `eve`). Base URL is `https://api.x.ai/v1`; default timeout 45 seconds. `server/deno.js` builds it the same way, with the same variables.

`status()` returns NOT_CONNECTED with the missing variable named (`XAI_API_KEY is not set on the server.` or `ROYAL_GROK_MODEL is not set on the server.`), DEGRADED with `lastError` after a failed call, and CONNECTED otherwise. There is no default model: without `ROYAL_GROK_MODEL` the provider is NOT CONFIGURED.

`modelFor(level)` returns `fastModel` when `level <= 1` and a fast model is set, otherwise `model`. Callers pass explicit levels: `classify()` 1, `doKnowledge()` 1, `doWorld()` 1, `doRevise()` 1, `draftOutreach()` 2, research searches 4. `openQuestion()` passes no level, so it always uses `model`.

### 3.2 Endpoints and request fields

| Method | Endpoint | Body sent |
|---|---|---|
| `complete()` | `POST /v1/chat/completions` | `{ model, messages, max_tokens }`; on HTTP 400 retried once as `{ model, messages }` |
| `respond()` (internal) | `POST /v1/responses` | `{ model, input }`, plus `tools`, `text.format` and `include` when given |
| `structured()` | `POST /v1/responses` | `text: { format: { type: "json_schema", name, schema, strict: true } }` |
| `search()` | `POST /v1/responses` | `tools: [{ type: "web_search", filters? }]`, plus `{ type: "x_search" }` when `x` is true; `text.format` when a schema is given |
| `voiceSession()` | `POST /v1/realtime/client_secrets` | `{ expires_after: { seconds } }`, clamped to 60 to 1800 |
| `test()` | `POST /v1/chat/completions` | A "Reply with READY" call, used by `POST /v1/provider/test` |

Headers are `Content-Type: application/json` and `Authorization: Bearer <key>`. `system` becomes the first `{ role: "system" }` message or input item. `search()` puts `allowed_domains` (up to five) in `web.filters`, or else `excluded_domains` (up to five); `ResearchEngine` always passes `allowed_domains: null`.

### 3.3 Reading replies and citations

From the Responses API, `respond()` concatenates every `output_text` in every `message` item, falling back to a top-level `output_text`. Citations are the union of `j.citations` (strings or `{url, title}`) and every `url_citation` annotation on `output_text`. It also returns `annotations`, `usage` and `tool_usage` (`server_side_tool_usage` or `tool_usage`). `structured()` and `search()` with a schema parse the text with `parseModelJson()` and check it with `check()`: a reply that fails is `MODEL_REPLY_FAILED_SCHEMA`, never repaired.

### 3.4 How failures are reported

| failed_because | When | retryable |
|---|---|---|
| `PROVIDER_NOT_CONNECTED` | No key or no model (no key only, for voice) | no |
| `PROVIDER_HTTP_<status>` | Non-2xx; `detail` carries xAI's error message clipped to 240 characters | 429 and 5xx |
| `PROVIDER_EMPTY_REPLY` | No text in the reply | yes |
| `PROVIDER_TIMEOUT`, `PROVIDER_NETWORK` | Abort or network error | yes |
| `MODEL_REPLY_NOT_JSON`, `MODEL_REPLY_FAILED_SCHEMA` | Structured reply unusable | no |
| `PROVIDER_REPLY_UNEXPECTED` | Voice reply without a token string | no |

Every failed call sets `lastError`, which turns `status()` to DEGRADED until the next success. The key is held in `_key`; `toJSON()` serialises only `id`, `model` and `status`, and a test checks that no result or status contains the key.

Note: the header comment of `grok.js` still says ROYAL "does not send temperature or response_format" and "asks for JSON in the instructions". That describes `complete()` only; `structured()` and `search()` do send `text.format` with strict JSON Schema.

### 3.5 Realtime voice

`voiceSession()` returns the ephemeral token (read from `value`, `client_secret.value`, `client_secret` or `token`), its expiry, and `ws_url: wss://api.x.ai/v1/realtime?model=<voiceModel>`. `POST /v1/voice/session` in `server/handler.js` requires the `realtime_voice` flag (off by default, else 409 `VOICE_DISABLED`) and the capability (else 409 `VOICE_NOT_CONFIGURED`), audits `VOICE_SESSION`, and returns the session config from `voiceSessionConfig()`: server VAD, 24 kHz PCM in and out, and one function tool, `ask_royal`. `web/js/realtime.js` opens the WebSocket with subprotocol `xai-client-secret.<token>`, sends `session.update`, streams `input_audio_buffer.append`, answers `ask_royal` by posting to `/v1/command` with modality `voice`, and cancels the response on barge-in.

### 3.6 What is untested live

No `XAI_API_KEY` is set in this environment. Every GrokProvider path above is tested only against a fake `fetch` that returns the documented response shapes (`tests/intelligence.test.js`, "the Grok provider speaks the documented Responses API shapes"). Model names, the availability of `web_search`, `x_search` and strict structured output on a given model, and the realtime event names are UNTESTED LIVE.

## 4. ScriptedProvider (tests only)

`ScriptedProvider` in `core/providers/provider.js` is labelled development and test only and is not constructed by any server entry. Its `script` is a value, an `Error`, or a function `(req, kind)` where `kind` is `complete`, `structured` or `search`. Every call is recorded in `calls`, so a test can assert what reached the model. `structured()` and schema `search()` run the same `check()` as the real provider and fail with `MODEL_REPLY_FAILED_SCHEMA`. `voiceSession()` always returns `CAPABILITY_NOT_SUPPORTED`. `UnavailableProvider` is the production default when no key is set; every call returns `PROVIDER_NOT_CONNECTED`.
