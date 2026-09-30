# VOICE ARCHITECTURE

Supersedes VOICE_FUTURE.md for the web client. `web/js/voice.js`.

## 1. Principle

Voice is another way into the same ROYAL. A spoken sentence becomes a command with `modality: "voice"` and goes through the same interpreter, permission gate, composer and audit as typing.

## 2. Input

(a) The browser's speech recognition, feature-detected. Partial transcripts appear above the caption as Tahir speaks; the final transcript is submitted.

(b) Listening stops on its own after eight seconds without speech.

(c) While listening, the microphone level drives the Core's amplitude.

(d) Errors are named plainly: microphone blocked, no microphone, speech service unreachable or turned off. Each offers typing. Nothing is ever shown as heard that was not heard.

(e) Where recognition is missing (Firefox, some embedded browsers), touching the Core opens typing instead.

(f) Privacy: in Chrome and Edge, recognition audio is processed by the browser vendor's speech service, not by ROYAL. This is stated here and should be stated to anyone else who uses ROYAL.

## 3. Output

(a) The browser's speech synthesis speaks ROYAL's sentence (the spec's `speech`). Dollar amounts are read as dollars. Word boundaries pulse the Core.

(b) Spoken replies can be turned off (the corner mark or the menu). The words always remain on screen.

## 4. Barge-in

Touching the Core, pressing Escape, typing, or starting to listen stops ROYAL mid-sentence.

## 5. Approval

A spoken "yes" never approves a decision. "Send it" by voice creates the decision; approving it is a deliberate touch on the decision itself.

## 6. Next

Server-side recognition and a better voice (for example a streaming speech service behind ROYAL's server) would remove the dependence on the browser. That needs a new ADR, a key kept on the server, and the same "nothing pretends to have heard" rule.
