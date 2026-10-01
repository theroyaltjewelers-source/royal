# VOICE ARCHITECTURE

*1 October 2026: the speech-output and playback parts are superseded by `ROYAL_VOICE_RUNTIME.md` and `ROYAL_AUDIO_PIPELINE.md` (voice by sentence, one playback queue for both voice paths, tuned turn detection).*

Supersedes VOICE_FUTURE.md for the web client. Browser speech: `web/js/voice.js`. Realtime voice: `web/js/realtime.js`, `web/js/pcm-worklet.js`, `POST /v1/voice/session` in `server/handler.js`. Updated 30 September 2026 from the code on branch feature/intelligence, after the security review.

## 1. Principle

Voice is another way into the same ROYAL. A spoken sentence becomes a command with `modality: "voice"` and goes through the same interpreter, permission gate, composer and audit as typing. This holds for both voice paths: the realtime voice model only speaks and listens, and asks ROYAL for every answer.

## 2. Two Paths

| Path | When it is used | Recognition | Speech |
|---|---|---|---|
| Realtime voice | `intelligence.status().realtime_voice` is AVAILABLE: flag `realtime_voice` on and the provider reports `realtime_voice` (`XAI_API_KEY` set) | xAI realtime voice, server-side voice activity detection | xAI realtime voice, streamed PCM |
| Browser speech | Every other case, and whenever realtime cannot start | The browser's `SpeechRecognition` | ROYAL's voice from the server (section 5), else the browser's `speechSynthesis` |

`web/js/app.js#loadIntelligence` reads `/v1/intelligence/status` after sign-in and creates a `RealtimeVoice` only when it says AVAILABLE. `realtime_voice` is off by default (`DEFAULT_FLAGS`, `core/permissions.js`), so the default is browser speech. With the flag on but no key, the status is NOT_CONFIGURED.

## 3. Realtime Voice

**Session token.** `POST /v1/voice/session?realm=<REALM>` (owner only):

(a) Flag off: 409 `VOICE_DISABLED`.

(b) `realm=PERSONAL`: 409 `VOICE_BUSINESS_ONLY`, "Realtime voice is available on the Business side only. The browser's own speech works in Personal." The realtime voice model hears the conversation, so it is offered for Business only and nothing from the Personal side reaches it. A realm other than BUSINESS or PERSONAL is refused earlier with 400 `BAD_REALM`; a request with no realm is treated as Business.

(c) No `voiceSession` on the provider, or no `realtime_voice` capability: 409 `VOICE_NOT_CONFIGURED`, "Realtime voice needs XAI_API_KEY on the server."

(d) Otherwise `GrokProvider.voiceSession({ seconds: 600 })` (`core/providers/grok.js`) calls `POST https://api.x.ai/v1/realtime/client_secrets` with `expires_after.seconds` clamped to 60 to 1800. A failure returns 502 with xAI's reason.

(e) On success the route audits `VOICE_SESSION` and returns `token, expires_at, ws_url` (`wss://api.x.ai/v1/realtime?model=<ROYAL_VOICE_MODEL>`, default `grok-voice-latest`), `model`, and `session` from `voiceSessionConfig(voice)` (voice from `ROYAL_VOICE`, default `eve`). The API key never leaves the server; the browser holds only the short-lived token.

**Session configuration** (`server/handler.js#voiceSessionConfig`): server VAD turn detection; PCM at 24 kHz in and out; instructions to be calm and brief, to call `ask_royal` for anything about the House, the world, people, drafts, sending or any action, never to answer those from its own knowledge, never to say anything was sent, done or approved unless `ask_royal` says so, and that approvals happen on screen, never by voice. One tool: `ask_royal({ request })`.

**Client** (`web/js/realtime.js#RealtimeVoice.start`):

(a) Asks for the session, passing the page's current realm (`realm: () => REALM` from `app.js`, sent as `?realm=`). If refused, sets state `unavailable`, reports the server's message, and returns false.

(b) Opens the microphone with echo cancellation, noise suppression and auto gain. A blocked microphone is reported plainly and returns false.

(c) Creates an `AudioContext` at 24 kHz and loads `js/pcm-worklet.js`. The worklet (`RoyalPcm`, registered as `royal-pcm`) posts 20 ms mono frames; `toPcm16` resamples to 24 kHz PCM16 and each frame is sent as `input_audio_buffer.append`.

(d) Opens the WebSocket at `ws_url` with subprotocol `xai-client-secret.<token>` and sends `session.update` on open.

(e) Handles `input_audio_buffer.speech_started`, input transcription deltas and completions (shown as heard text), `response.created`, `response.output_audio.delta` (played), `response.output_audio_transcript.delta` (caption), `response.done`, `response.function_call_arguments.done` (tool call) and `error`.

**The tool loop.** On `ask_royal`, the client calls `askFromVoice` in `app.js`, which submits the words to `/v1/command` with modality `voice` and `speak: false`, shows ROYAL's answer on the stage like any other, and returns `{ say, status, needs_approval, note }` as the `function_call_output`, followed by `response.create`. `needs_approval` is true when the answer shows an OPEN decision. Any other tool name, or a missing request, gets "I couldn't use that tool."

**Interruption.** When the provider reports `input_audio_buffer.speech_started`, `interrupt()` stops every scheduled audio buffer at once and, if a response is in progress, sends `response.cancel`. Touching the Core while realtime is live ends the session (`rt.stop()`).

**Realm switch.** `switchRealm()` in `app.js` stops a live realtime session (`rt.stop()`) before it clears the stage, because a live voice conversation belongs to the room it started in. Starting voice again in Personal asks for a session with `realm=PERSONAL`, is refused, and falls through to browser speech.

**Disconnection.** On close the client tears down the microphone, worklet and audio context, sets state `disconnected`, and the page says the conversation is kept and typing works. It does not reconnect on its own. The conversation lives in ROYAL, keyed by conversation id, so nothing is lost.

**Fallback.** In `app.js#wake`, if `rt.start()` returns false, the touch falls through to browser speech. Realtime is also skipped while spoken replies are muted. While realtime is active, browser speech synthesis stays silent so ROYAL is not heard twice.

**Content Security Policy.** `server/node.js` allows `connect-src wss://api.x.ai` for this socket.

**Privacy.** In realtime mode the microphone audio goes from the browser directly to xAI.

## 4. Browser Speech: Input

(a) The browser's speech recognition, feature-detected. Partial transcripts appear above the caption as Tahir speaks; the final transcript is submitted.

(b) Listening stops on its own after eight seconds without speech.

(c) While listening, the microphone level drives the Core's amplitude.

(d) Errors are named plainly: microphone blocked, no microphone, speech service unreachable or turned off. Each offers typing. Nothing is ever shown as heard that was not heard.

(e) Where recognition is missing (Firefox, some embedded browsers), touching the Core opens typing instead.

(f) Privacy: in Chrome and Edge, recognition audio is processed by the browser vendor's speech service, not by ROYAL. This should be stated to anyone else who uses ROYAL.

## 5. Browser Speech: Output

ROYAL has one voice on every device (ADR-014). Before this, each device spoke with its own installed voices, so an iPhone and a desktop sounded different.

(a) **ROYAL's voice.** When `/v1/intelligence/status` reports `spoken_voice: AVAILABLE` (flag `spoken_voice`, on by default, and `XAI_API_KEY` set), `web/js/voice.js` sends ROYAL's sentence (the spec's `speech`) to `POST /v1/voice/speak?realm=BUSINESS` and plays the MP3 that comes back through Web Audio. The server calls xAI text to speech (`GrokProvider.speech()`, `POST https://api.x.ai/v1/tts`) with the voice in `ROYAL_VOICE`, default `ara`, a warm woman's voice. Realtime voice uses the same voice, so both paths sound alike. The loudness of the voice moves the Core, and a rising syllable pulses it. The audio plays through the page's `AudioContext`, which the first touch unlocks, so it also plays on iPhone.

(b) **The route.** Owner only. Text is collapsed to single spaces, required, and at most 1,200 characters. Refusals, each a plain sentence: 409 `SPEECH_DISABLED` (flag off), 409 `SPEECH_BUSINESS_ONLY` (`realm=PERSONAL`: nothing from the Personal side reaches xAI), 409 `SPEECH_NOT_CONFIGURED` (no key), 400 `TEXT_REQUIRED` or `TEXT_TOO_LONG`, 502 with xAI's reason. The API key stays on the server. The last 64 phrases are cached in memory per process, so a phrase ROYAL says often is paid for once; failures are not cached. Nothing is audited: a spoken reply repeats an answer that is already recorded.

(c) **The device's voice** takes over for the same words whenever ROYAL's voice cannot speak: in Personal, with the flag off or no key, or when the request or decoding fails before the first sound. A reply is never silent because of the server. The device voice is chosen from a preference list (Daniel, Google UK English Male, Arthur, Aaron, Google US English, then any English voice) at speaking time, because iOS often has no voice list when the page opens. Dollar amounts are read as dollars. Word boundaries pulse the Core.

(b) Spoken replies can be turned off (the corner mark or the menu). The words always remain on screen.

## 6. Browser Speech: Barge-in

Touching the Core, pressing Escape, typing, or starting to listen stops ROYAL mid-sentence, whichever voice is speaking. With ROYAL's voice, a request still on its way is cancelled and its audio is never played if it arrives late.

## 7. Approval

A spoken "yes" never approves a decision, on either path. "Send it" by voice creates the decision; approving it is a deliberate touch on the decision itself. See `APPROVAL_MODEL.md`.

## 8. Flags

`realtime_voice` (default off) gates the realtime path. `spoken_voice` (default on) gates ROYAL's voice from the server; off, every device uses its own voice again. `voice_input` (default off) is reserved: no code reads it, and browser speech works regardless.

## 9. What Is Tested, and What Is Not

Tested (`tests/intelligence.test.js`, "realtime voice client: PCM conversion and the ask_royal tool loop"): PCM16 round trip and 48 kHz to 24 kHz resampling; an `ask_royal` call producing `function_call_output` with ROYAL's sentence, then `response.create`; `speech_started` during a response sending `response.cancel`; `start()` returning false when the server refuses a session. The socket is a fake.

Tested through the handler (`tests/server.test.js`, "voice session: off by default, Business only, and only a short-lived token ever leaves"): 409 with the flag off; 409 `VOICE_BUSINESS_ONLY` for `realm=PERSONAL`; with the flag on and a fake xAI, `realm=BUSINESS` returns 200 with the short-lived token and without the API key.

Untested without an `XAI_API_KEY`: the `client_secrets` request against the live service, the WebSocket subprotocol and event names, the audio worklet, playback scheduling, echo cancellation, real barge-in timing and dropped connections. `VOICE_NOT_CONFIGURED` and the 502 path have no test. The client's realm parameter and the stop on a realm switch have no automated test. Browser speech recognition has no automated test beyond the double-start guard in `tests/web.test.js`.

Tested for ROYAL's voice (`tests/voice.test.js`): the default voice (Ara) and the flag; the exact request sent to xAI and the MP3 returned; the cache; Business only, owner only and every refusal; a 502 carrying xAI's reason without the key, and failures not cached; the status line; and, in `web/js/voice.js` against a stand-in browser, playback from the server with the device voice silent, the device voice in Personal and after a failed fetch (ending once), barge-in before and during the sound, and mute. Checked by hand in Chromium at 390x844 and 1366x768 against a stand-in xAI: the phone requested voice `ara`, the desktop replayed the same sentence from the cache, and Personal used the device voice. Untested without an `XAI_API_KEY`: the live `/v1/tts` service and its audio quality and speed.

`RealtimeVoice.sayText()` (typing into the live voice conversation) exists but nothing calls it: typing while realtime is on goes to `/v1/command` as usual.
