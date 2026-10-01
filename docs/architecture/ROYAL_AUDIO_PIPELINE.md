# ROYAL AUDIO PIPELINE

*Source: `web/js/playback.js`.*

(a) **One queue, one cursor.** Every piece of audio, whether a realtime PCM chunk or a sentence of WAV, is scheduled to start exactly where the previous one ends (`cursor += duration`). Pieces never overlap and never leave a gap while audio keeps arriving. One analyser feeds the Core's light; no audio element per chunk.

(b) **Jitter buffer.** The first piece of a reply starts 60 ms ahead of now. If a piece arrives after the queue has already run dry mid-reply, that is an underrun: it is counted, and the lead grows by 40 ms (up to 240 ms) for the session. A reply that plays without a gap lets it shrink back by 20 ms. Seconds of buffering are never used.

(c) **Measurements.** Per device: replies, pieces, underruns, current lead, and the time from the question to the first sound (from the end of Tahir's speech in realtime, from the request in server voice). Shown in Systems as "ROYAL'S VOICE ... first sound N ms ... N gaps".

(d) **Interruption.** `stop()` stops every scheduled source, clears the queue and starts a new generation, so nothing from before the interruption can play.

(e) **Formats.** Realtime: 24 kHz mono PCM16, base64 decoded on arrival. Server voice: 24 kHz WAV per sentence (MP3 pads each clip with silence, heard as a tick between sentences).

(f) **Not yet handled:** WebSocket reconnects (realtime does not reconnect on its own, by design); packet reordering (WebSocket delivers in order).
