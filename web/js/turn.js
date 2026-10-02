/* Turn-taking for ROYAL's voice: is someone speaking, and have they finished?

   Pure: frames of samples in, decisions out.  No browser objects, so it is
   tested in Node with synthetic audio (tests/voice_engine.test.js).

   1. SpeechDetector, per 20 ms frame.  What it is, plainly: an energy,
      zero-crossing and modulation detector with an adaptive noise floor.
      It is not a neural voice model and it does not know who is speaking.
        (a) noise floor by minimum statistics: the quietest level of the
            last 2.5 s, so HVAC, hiss, hum and any steady sound become the
            floor within 2.5 s and stop counting as speech;
        (b) signal over floor: speech must stand clear of the floor;
        (c) zero crossings in the range voiced speech has, which hiss and
            hum do not;
        (d) modulation: the loudness of speech rises and falls with
            syllables, steady noise does not;
        (e) near-field priority: once the primary speaker's level is known,
            much quieter voices (a television across the room, a distant
            conversation) count far less;
        (f) while ROYAL is speaking, the bar is raised by an echo margin
            that grows with the loudness of her own playback, on top of the
            browser's echo cancellation, so her voice does not open a turn
            but Tahir talking over her does.

   2. TurnDetector: when a turn starts, pauses, resumes and ends.
        (a) onset needs 120 ms of speech in 200 ms (240 in 300 while ROYAL
            speaks), so a click or a cough does not start a turn;
        (b) the pause that may end a turn adapts: shorter after a short
            utterance ("Yes."), longer for someone who pauses between
            phrases, measured from their own pauses in this turn;
        (c) a pause first raises a TENTATIVE end; the transcript decides how
            long to wait for more (completeness() below): finished
            sentences end at once, a sentence left hanging ("I want you
            to...") waits up to 2.2 s, then ends;
        (d) noise cannot keep a turn open: only speech frames move the
            last-speech time, and a turn ends at 30 s regardless;
        (e) an onset with almost no speech in it is discarded, not sent. */

export const FRAME_MS = 20;

const db = (rms) => 20 * Math.log10(rms + 1e-9);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class SpeechDetector {
  constructor({ sampleRate = 16000, threshold = 9, floorWindowMs = 2500 } = {}) {
    this.sr = sampleRate; this.threshold = threshold; this.baseThreshold = threshold;
    this.win = Math.round(floorWindowMs / FRAME_MS);
    this.smooth = null; this.hist = []; this.floor = null; this.env = []; this.userLevel = null; this.since = 99;
    this.echoMargin = 0; this.last = { prob: 0, speech: false, db: -120, snr: 0, zcrps: 0, mod: 0, floor: null, threshold };
  }

  /* ROYAL's own playback loudness (0..1): raises the bar while she speaks. */
  setPlayback(level) { this.echoMargin = level > 0.02 ? clamp(6 + 14 * level, 6, 16) : 0; }
  /* A noisy room (sound that kept a turn open with no pause): listen more strictly for a while. */
  stricter(db = 6) { this.threshold = Math.min(this.baseThreshold + 12, this.threshold + db); }
  relax() { this.threshold = Math.max(this.baseThreshold, this.threshold - 0.02); }

  frame(samples) {
    let s = 0, z = 0, prev = samples[0] || 0;
    for (let i = 0; i < samples.length; i++) { const x = samples[i]; s += x * x; if ((x >= 0) !== (prev >= 0)) z++; prev = x; }
    const level = db(Math.sqrt(s / Math.max(1, samples.length)));
    const zcrps = (z / Math.max(1, samples.length)) * this.sr;
    /* The floor, by minimum statistics: the quietest smoothed level of the
       last 2.5 s.  Speech always dips between words inside that window,
       steady noise never does, so a fan switched on becomes the floor
       within 2.5 s, whatever its loudness. */
    this.smooth = this.smooth === null ? level : this.smooth + (level - this.smooth) * 0.3;
    this.hist.push(this.smooth); if (this.hist.length > this.win) this.hist.shift();
    let m = Infinity; for (const x of this.hist) if (x < m) m = x;
    this.floor = m;
    this.env.push(level); if (this.env.length > 15) this.env.shift();
    const mean = this.env.reduce((a, b) => a + b, 0) / this.env.length;
    const mod = Math.sqrt(this.env.reduce((a, b) => a + (b - mean) * (b - mean), 0) / this.env.length);
    const thr = this.threshold + this.echoMargin;
    if (this.hist.length < 15) { this.last = { prob: 0, speech: false, db: level, snr: 0, zcrps, mod, floor: this.floor, threshold: thr }; return this.last; }
    const snr = level - this.floor;
    let prob = 1 / (1 + Math.exp(-(snr - thr) / 2));
    if (!(zcrps > 60 && zcrps < 4200)) prob *= 0.3;                       /* hum below, hiss above */
    const steady = this.env.length >= 10 && mod < 1.0;
    if (steady) prob *= 0.3;                                              /* a held tone, not syllables */
    if (this.userLevel !== null && level < this.userLevel - 15) prob *= 0.4;   /* far quieter than Tahir */
    /* Hangover: the dips between syllables stay inside the speech. */
    this.since = prob >= 0.5 ? 0 : this.since + 1;
    const speech = prob >= 0.5 || (prob >= 0.2 && this.since <= 10 && !steady);
    if (prob >= 0.5) this.userLevel = this.userLevel === null ? level : this.userLevel + (level - this.userLevel) * 0.05;
    this.last = { prob, speech, db: level, snr, zcrps, mod, floor: this.floor, threshold: thr };
    return this.last;
  }
}

/* How finished a transcript sounds.  "complete": end now.  "incomplete":
   it stops mid-thought, wait longer.  "unknown": wait a little. */
const SHORT = /^(yes|yeah|yep|no|nope|why|how|when|where|who|continue|go on|go ahead|do it|send it|stop|wait|thanks|thank you|okay|ok|sure|right|correct|exactly|explain|which one|what|try again|again|cancel|never ?mind|repeat that|say that again|hello|hi|hey( royal)?|royal)[.!?]*$/i;
const HANGING = /(\b(and|or|but|so|because|to|the|a|an|of|for|with|about|from|into|on|in|at|by|than|then|if|that|which|who|like|um+|uh+|er+|hmm+|i|i'm|we|we're|you|my|our|your|can you|could you|i want|i need|let me|tell me|what about|is|are|was|were|will|would|should|please)|,|-|\.\.\.|…)\s*$/i;
export function completeness(text) {
  const t = String(text || "").trim();
  if (!t) return "empty";
  if (SHORT.test(t)) return "complete";
  if (HANGING.test(t)) return "incomplete";
  if (/[.!?]["”’)]?$/.test(t)) return "complete";
  return t.split(/\s+/).length >= 4 ? "complete" : "unknown";
}
export const WAIT_AFTER = { complete: 0, unknown: 900, incomplete: 2200, empty: 0 };

export class TurnDetector {
  constructor({ maxTurnMs = 30000, maxUnbrokenMs = 12000 } = {}) { this.maxTurnMs = maxTurnMs; this.maxUnbrokenMs = maxUnbrokenMs; this.reset(); }
  reset() {
    this.recent = []; this.inTurn = false; this.startAt = 0; this.lastSpeechAt = 0; this.speechMs = 0; this.pauses = []; this.gapStart = null;
    this.tentative = false; this.waitMs = null; this.now = this.now || 0; this.endReason = null;
  }

  /* The pause that may end this turn, adapted to the speaker. */
  silenceMs() {
    const base = this.speechMs < 900 ? 450 : 700;
    if (this.pauses.length < 2) return base;
    const p = this.pauses.slice().sort((a, b) => a - b), med = p[Math.floor(p.length / 2)];
    return clamp(Math.max(base, med * 1.6), 450, 1200);
  }

  /* The transcript said how finished it sounds: how long to wait now. */
  setWait(ms) { this.waitMs = ms; }

  /* One frame's verdict in; at most one event out:
     start | tentative | resume | final | discard | null.
     `strict` while ROYAL is speaking: a longer onset is needed. */
  push(v, { strict = false } = {}) {
    this.now += FRAME_MS;
    this.recent.push(v.speech); if (this.recent.length > 15) this.recent.shift();
    const win = strict ? 15 : 10, need = strict ? 12 : 6;
    const onset = this.recent.slice(-win).filter(Boolean).length >= need;
    if (!this.inTurn) {
      if (onset) {
        this.inTurn = true; this.startAt = this.now - win * FRAME_MS; this.lastSpeechAt = this.now; this.speechMs = need * FRAME_MS; this.pauses = []; this.gapStart = null; this.tentative = false; this.waitMs = null;
        return "start";
      }
      return null;
    }
    if (v.speech) {
      if (this.gapStart !== null) { const g = this.now - this.gapStart; if (g >= 150) this.pauses.push(g); this.gapStart = null; }
      this.speechMs += FRAME_MS; this.lastSpeechAt = this.now;
      if (this.tentative && this.recent.slice(-5).filter(Boolean).length >= 3) { this.tentative = false; this.waitMs = null; return "resume"; }
    } else if (this.gapStart === null) this.gapStart = this.now;
    if (this.now - this.startAt >= this.maxTurnMs) { this.inTurn = false; this.endReason = "max_turn"; return "final"; }
    /* People pause.  "Speech" with no pause for 12 seconds is a sound that
       fooled the detector (music with a beat, a television): end the turn. */
    if (this.gapStart === null && this.pauses.length === 0 && this.now - this.startAt >= this.maxUnbrokenMs) { this.inTurn = false; this.endReason = "unbroken"; return "final"; }
    const quiet = this.now - this.lastSpeechAt;
    if (!this.tentative && quiet >= this.silenceMs()) {
      if (this.speechMs < 200) { this.inTurn = false; return "discard"; }
      this.tentative = true; return "tentative";
    }
    if (this.tentative && this.waitMs !== null && quiet >= this.silenceMs() + this.waitMs) { this.inTurn = false; this.endReason = "silence"; return "final"; }
    return null;
  }

  stats() { return { in_turn: this.inTurn, speech_ms: this.speechMs, quiet_ms: this.inTurn ? this.now - this.lastSpeechAt : null, silence_ms: this.silenceMs(), wait_ms: this.waitMs, pauses: this.pauses.slice(-5) }; }
}

/* Float32 frames at `from` Hz -> a 16 kHz mono PCM16 WAV, for transcription. */
export function wavFrom(chunks, from, to = 16000) {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(total); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = from / to, n = Math.floor(total / ratio);
  const buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const w = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, to, true); dv.setUint32(28, to * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0, a = all[i0] || 0, b = all[i0 + 1] ?? a;
    const v = clamp(a + (b - a) * f, -1, 1);
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(buf);
}
