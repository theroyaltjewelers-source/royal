# ROYAL VOICE ENGINE

*2 October 2026. Sources: `web/js/conversation.js` (the state machine), `web/js/turn.js` (speech and turn detection), `web/js/capture.js` (microphone, transcription, speaker), `web/js/voice.js` (ROYAL's spoken voice), `web/js/app.js` (the page), `POST /v1/voice/transcribe` in `server/handler.js`, `GrokProvider.transcribe` in `core/providers/grok.js`. Decision: ADR-018.*

## 1. Why the old voice behaved as it did

Traced in the code before this change:

(a) **Who listened.** With `realtime_voice` off (the default, so in production), a touch started the browser's own speech recognizer (`Voice.listen` in `web/js/voice.js`, `continuous = false`). The browser's speech service decided when Tahir had finished. ROYAL had no voice activity detection and no end-of-turn logic of its own; its only timer stopped listening after 8 seconds in which nothing at all was heard.

(b) **Why it kept recording.** The browser's service keeps a turn open while it hears sound it cannot rule out, so a fan, a television or street noise held it open. Nothing in ROYAL could end the turn.

(c) **Why Tahir had to touch it again.** After every answer, `finish()` in `web/js/app.js` went to COMPLETE and then AWAKE. Nothing started listening again. Each turn was a new touch.

(d) **Three deciders.** `voice.js` (its `listening`, `starting` and `speaking` flags), `realtime.js` (its own `state` and `active`) and the page's `RoyalState` each decided independently whether ROYAL was listening, and the page reconciled them with conditions in `wake()`.

(e) **Barge-in.** Without realtime voice, the only interruption was a touch; listening and speaking never ran at once.

## 2. The engine

One state machine, `VoiceConversation`, is the only thing that decides whether ROYAL is listening, hearing, thinking or speaking. The microphone, the transcriber, the request to ROYAL, the speaker and the page all follow its state.

    IDLE -> CONNECTING -> LISTENING -> USER_SPEAKING -> END_OF_TURN -> PROCESSING -> ROYAL_SPEAKING -> LISTENING
                                ^            |  ^              |                          |
                                |            |  +-- resume ----+                          +-> INTERRUPTED -> USER_SPEAKING  (barge-in)
                                +------------+  (too short, nothing said)
    plus MUTED, RECONNECTING, ERROR_RECOVERY, SESSION_ENDED

(a) **Legal transitions only** (`LEGAL`); anything else is refused and recorded in the diagnostics. Ending is allowed from any state.

(b) **Watchdogs.** Every state that waits has a limit (CONNECTING 12 s, END_OF_TURN 6 s, PROCESSING 60 s, ROYAL_SPEAKING 120 s, INTERRUPTED 1.5 s, RECONNECTING 15 s). When one fires, the engine recovers to LISTENING or ends the session with a plain sentence. The page can never be left showing "Listening", "Thinking" or "Speaking" over a process that has died.

(c) **Activate once.** The first touch opens the microphone and starts listening. After ROYAL finishes speaking, she is listening again in the same frame; measured in the browser, 0 ms. With no speech for 5 minutes the session ends itself to release the microphone, with a sentence saying so.

(d) **The page draws the engine.** `VOICE_LOOK` in `app.js` maps each engine state to the Core's states (USER_SPEAKING and INTERRUPTED show as LISTENING, END_OF_TURN as UNDERSTANDING, PROCESSING as THINKING, ROYAL_SPEAKING as RESPONDING). The control bar shows the engine's own word for its state. During a voice session `submit()` does not move the Core or speak; it only draws the answer.

## 3. Hearing speech, and only speech

`SpeechDetector` in `web/js/turn.js` reads each 20 ms frame. What it is, plainly: an energy, zero-crossing and modulation detector with an adaptive noise floor. It is not a neural voice model and it does not recognise who is speaking.

(a) **Noise floor by minimum statistics:** the quietest smoothed level of the last 2.5 s. Speech always dips between words within that window; steady sound never does. A fan, hiss or hum becomes the floor within 2.5 s, however loud.

(b) **Signal over the floor** must clear a threshold (9 dB, sigmoid).

(c) **Zero crossings** in the range of voiced speech; hum below and hiss above count far less.

(d) **Modulation:** a held tone (sustained music) counts far less than syllables.

(e) **Near-field priority:** once Tahir's own level is known, a voice 15 dB quieter (a television across the room, a distant conversation) counts far less. This is level-based priority, not speaker identification.

(f) **Hangover:** the dips between syllables stay inside the speech.

(g) **The browser's own processing:** the microphone is opened with echo cancellation, noise suppression and automatic gain control. What each browser actually granted is reported in the diagnostics (for example "echo cancellation, noise suppression, gain control").

Measured on synthetic audio (`tests/voice_engine.test.js`, `tests/audio_fixtures.js`): speech 86 to 95% of frames detected, also over a fan; hiss 0%; a sustained chord under 10%; a fan already running 0%; a fan switched on mid-session absorbed within 2.5 s.

## 4. Deciding the turn is over

`TurnDetector` in `web/js/turn.js`, with the transcript's help:

(a) **Onset:** 120 ms of speech within 200 ms. While ROYAL speaks, 240 ms within 300 ms (stricter, see section 6).

(b) **A pause raises a tentative end.** The pause that counts adapts: 380 ms after a short utterance, 550 ms otherwise, and longer for someone who pauses between phrases, from their own pauses in this turn (up to 1.1 s).

(c) **The words decide how long to wait.** At the tentative end, what was said so far is transcribed and judged (`completeness()`):
- a finished sentence, or a short reply ("Yes.", "Why?", "Do it.", "Send it.", "Which one?", "Try again.") ends the turn at once;
- a sentence left hanging ("Royal, I want you to", "and", "um", "can you") waits up to 2.2 s more;
- anything else waits 0.9 s.
If Tahir speaks again inside the wait, it is the same turn ("Royal, I want you to ..." [1 s] "... go through today's sales activity" is one request).

(d) **Noise cannot hold a turn:** only speech frames move the last-speech time; a turn ends at 30 s regardless; and 12 s of "speech" with no pause at all is treated as noise, dropped, and the threshold raised for a while.

(e) **Nothing said, nothing sent:** an onset with under 200 ms of speech, or a transcript that comes back empty, returns to LISTENING without asking ROYAL.

Measured in the browser: from the end of a finished question to ROYAL's first sound, a median of 0.8 to 0.9 s; from her last sound to listening again, 0 ms.

## 5. Transcription

(a) **Server, Business:** at the tentative end, the turn's audio (with a 400 ms pre-roll, so the first syllable is never lost) is sent as a 16 kHz WAV to `POST /v1/voice/transcribe`, which calls xAI's speech-to-text (`POST https://api.x.ai/v1/stt`, multipart `file` and `language`, reply `text`). Owner only, Business only; neither the audio nor the words are logged. If the transcript at the pause is final, it is reused; nothing is transcribed twice.

(b) **Device, fallback and Personal:** the browser's own recognizer, started when the engine hears a turn begin and stopped when it decides the turn is over. It cannot hear the pre-roll, so a first syllable can be missed. It is used in Personal, when the server cannot transcribe (no key, switched off), or from the next turn after the server says it cannot.

(c) **Not verified here:** the call to xAI's speech-to-text. This environment cannot reach api.x.ai. The request shape follows xAI's published REST reference; `ROYAL_STT_MODEL` sets a model if xAI requires one. If the server's transcription fails in a way that will not change, the engine moves to the device recognizer and the diagnostics say why.

## 6. Barge-in, and ROYAL not hearing herself

(a) While ROYAL speaks, the microphone keeps running. The detector raises its bar by an echo margin that grows with the loudness of her own playback (6 to 16 dB, from the playback analyser), on top of the browser's echo cancellation, and onset needs 240 ms of speech. Her echo does not open a turn; Tahir talking over her does.

(b) On barge-in the state moves first (ROYAL_SPEAKING to INTERRUPTED), then her playback stops at once, then the new turn begins with the 400 ms before the onset already captured. "No, Royal, that's not what I meant." keeps its first words.

(c) A touch on the Core while she speaks, typing, or the Stop button stops her the same way.

(d) **Limits, said plainly:** on a device whose echo cancellation is weak (some speakerphones), loud playback can still leak through. The echo margin guards against it, but it is not a guarantee. Headphones remove the problem.

## 7. ROYAL stays the orchestrator

A voice turn is `submit(text, "voice")`: the same `/v1/command`, conversation id and context as typing. "Royal, tell me what every bot accomplished today" goes through the agent orchestrator to the bots. "Which ones are the strongest?" refers to what was just said. A specialist's late answer (`/v1/inbox`) is spoken by the engine only while it is LISTENING, never over Tahir. A question typed during a voice session is answered by voice the same way.

## 8. Resilience

| Event | What happens |
|---|---|
| Microphone track ends, device changes | RECONNECTING; reopened with back-off (0.4, 0.8, 1.6 s); after 3 failures, SESSION_ENDED with a sentence |
| Permission denied | SESSION_ENDED: "The microphone is blocked for this site...", and typing opens |
| ROYAL's server unreachable | "I couldn't reach my server. Nothing was done.", then LISTENING |
| Transcription fails | "I didn't catch that. Say it again?", then LISTENING; a lasting failure moves to the device recognizer |
| ROYAL's voice fails before sound | the device voice speaks (voice.js); if nothing can speak, LISTENING at once |
| Speaking never ends | ROYAL_SPEAKING watchdog, then LISTENING |
| A slow answer (bots working) | PROCESSING up to 60 s; Tahir speaking starts a new turn and the old answer is drawn but not spoken |
| Sign-in expires | the session ends with the sign-in screen |
| Realm switch | the session ends (a conversation belongs to its room) |

## 9. Controls

While a session runs, a bar shows the engine's state word and: Mute (MUTED; the microphone track is disabled), Stop speaking, End voice, and Continuous on/off (on a phone this lives in the menu's preferences). Continuous off ends the session after each answer. Escape stops ROYAL speaking, or ends the session. "Spoken replies" off (the existing switch) keeps the conversation and draws the answers without speaking them.

## 10. Diagnostics

`?voicedebug=1` (or `localStorage royal.voicedebug = 1`) shows a panel that never takes a touch:
- the state and the recent transitions;
- the detector (speech probability, level, floor, threshold, signal over floor);
- the transcript status and the end-of-turn decision, with its reason and wait;
- the microphone and the processing it was granted;
- the speaker;
- barge-ins, with the last one's time;
- the last ROYAL request id and the bot hand-offs it started;
- the median of each latency stage over the last 20 turns (speech end to transcript, transcript to response, response to first audio, speech end to first audio, last audio to listening);
- refused transitions and errors.

The Systems view shows the median from Tahir stopping to ROYAL's voice.

## 11. What was removed

`web/js/realtime.js` (the realtime client) and the listening half of `web/js/voice.js` are gone, with their tests; their guarantees are covered by the engine's tests. The server's `POST /v1/voice/session` route remains and is tested, but the page no longer uses it.

## 12. Tests

(a) **`tests/voice_engine.test.js`** (18 tests): the real state machine and detector driven frame by frame in virtual time. It covers:
- question, answer, hands-free follow-up;
- a finished request, and a short reply, ending fast;
- thinking pauses kept in one turn;
- a fan, music and hiss;
- loud continuous sound;
- the 12-second rule;
- barge-in with ROYAL's echo present, and rapid interruptions;
- an eight-second wait before answering;
- a slow answer while bots work;
- ROYAL, the network, the transcription and the voice each failing;
- falling back to the device recognizer;
- the microphone dropping, permission denied, mute, stop, end and restart;
- twenty turns in a row with latency, and no refused transitions;
- late specialist answers, continuous off;
- illegal transitions.

(b) **`tests/voice.test.js`**: the transcription route (multipart to xAI, nothing logged, Business and owner only, WAV only, refusals without the key).

(c) **`tests/manual/voice-browser.mjs`**: Chromium with a fake microphone playing a synthetic voice, one touch, 45 s, no further touch. Run at phone and desktop sizes:
- with 1.5 s answers: 7 to 8 turns, listening again on her own after each;
- with 6 s answers: every next question interrupted her (8 barge-ins);
- in both: no errors and no refused transitions.

(d) **Not tested here:** a human voice in a real room, a phone's speaker and microphone together, and xAI's live speech-to-text. These need Tahir's phone after deploy.
