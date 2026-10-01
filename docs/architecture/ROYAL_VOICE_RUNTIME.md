# ROYAL VOICE RUNTIME

*Supersedes the speech-output parts of `VOICE_ARCHITECTURE.md` where they differ. Sources: `web/js/voice.js`, `web/js/realtime.js`, `web/js/playback.js`, `POST /v1/voice/speak` and `voiceSessionConfig()` in `server/handler.js`.*

## 1. Before

(a) **Device voice:** the browser's speech synthesis, different on every device (Google voices in Chrome on a computer, Apple's on iPhone); Chrome's network voices cut long replies.

(b) **Server voice** (ROYAL's own, added the day before): browser speech recognition, then text, then `/v1/command`, then one MP3 for the whole reply, then playback. Nothing played until the whole reply's audio arrived.

(c) **Realtime voice** (off by default, `realtime_voice`): xAI speech to speech over a WebSocket, each audio chunk scheduled on arrival with no buffer, so a late chunk was a gap.

## 2. After

(a) **Server voice, streamed by sentence.** The spoken text (`presentation.speech`, already shortened to a sentence or two) is split into pieces, the first sentence alone. Each piece is fetched from `/v1/voice/speak` as 24 kHz WAV while the one before it plays, and all pieces go through one playback queue. Failure before the first sound hands the words to the device voice; failure later hands it the words not yet spoken. The server caches the last 160 sentences.

(b) **Realtime voice** plays through the same queue, keeps the identity doctrine (its session instructions start with it), acknowledges briefly ("I'll check.") before calling ROYAL, and returns ROYAL's short spoken line, not the full summary.

(c) **Turn detection:** server VAD with threshold 0.5, 300 ms prefix padding and 450 ms of silence (xAI's default of 200 ms cut Tahir off mid-thought). To be tuned by ear.

(d) **One voice:** Ara (`ROYAL_VOICE`) for both server and realtime voice.

## 3. Interruption

Speaking (realtime), touching the Core, typing or Escape stops ROYAL: every queued piece is stopped at once, any request on its way is aborted, and audio that arrives late is never played. Tested in `tests/voice.test.js`.

## 4. Spoken and shown

`presentation.speech` is what is said; the screen keeps the full answer. A long answer is spoken as its first sentence or two plus "The rest is on your screen."

## 5. Update, 1 October 2026

Realtime voice waits at most 25 seconds for ROYAL's answer to a tool call; past that it says "That's taking a moment. I'll put it on your screen when it's ready." and the answer still appears on the stage when it arrives. Voice turns and typed turns are numbered on the page, so a new question is never dropped while an earlier one runs.
