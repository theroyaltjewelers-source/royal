/* ROYAL's voice conversation: one state machine, and the only thing that
   decides whether ROYAL is listening, hearing, thinking or speaking.

     IDLE -> CONNECTING -> LISTENING -> USER_SPEAKING -> END_OF_TURN
          -> PROCESSING -> ROYAL_SPEAKING -> LISTENING -> ...

   plus INTERRUPTED (Tahir talked over ROYAL), MUTED, RECONNECTING (the
   microphone went away), ERROR_RECOVERY and SESSION_ENDED.  Every part
   reads this state: the microphone keeps running, the turn detector decides
   turns (web/js/turn.js), transcription turns a finished turn into words,
   ROYAL answers through the same /v1/command as typing (one intelligence,
   one orchestrator, every bot), the speaker says the answer, and the page
   draws the state.  Illegal transitions are refused.

   Activate once.  After ROYAL finishes speaking she is listening again,
   with no touch.  Talking over her stops her at once and the new words are
   kept, from just before they began (a 400 ms pre-roll).  A turn ends when
   Tahir has finished, not after a fixed silence: a pause first raises a
   tentative end, the words so far are transcribed, and how finished they
   sound decides how long to wait (web/js/turn.js).  Nothing stays stuck:
   every state has a watchdog, and a failure always comes back to
   LISTENING, or ends the session plainly. */

import { SpeechDetector, TurnDetector, completeness, WAIT_AFTER, wavFrom, FRAME_MS } from "./turn.js";

export const VSTATE = Object.freeze({
  IDLE: "IDLE", CONNECTING: "CONNECTING", LISTENING: "LISTENING", USER_SPEAKING: "USER_SPEAKING", END_OF_TURN: "END_OF_TURN",
  PROCESSING: "PROCESSING", ROYAL_SPEAKING: "ROYAL_SPEAKING", INTERRUPTED: "INTERRUPTED", MUTED: "MUTED",
  RECONNECTING: "RECONNECTING", ERROR_RECOVERY: "ERROR_RECOVERY", SESSION_ENDED: "SESSION_ENDED",
});
const S = VSTATE;
const LIVE = [S.LISTENING, S.USER_SPEAKING, S.END_OF_TURN, S.PROCESSING, S.ROYAL_SPEAKING, S.INTERRUPTED, S.MUTED];
const ENDS = [S.SESSION_ENDED, S.ERROR_RECOVERY, S.RECONNECTING];
export const LEGAL = {
  IDLE: [S.CONNECTING],
  SESSION_ENDED: [S.CONNECTING],
  CONNECTING: [S.LISTENING, S.ERROR_RECOVERY, S.SESSION_ENDED],
  LISTENING: [S.USER_SPEAKING, S.ROYAL_SPEAKING, S.MUTED, ...ENDS],
  USER_SPEAKING: [S.END_OF_TURN, S.LISTENING, S.PROCESSING, S.MUTED, ...ENDS],
  END_OF_TURN: [S.USER_SPEAKING, S.PROCESSING, S.LISTENING, S.MUTED, ...ENDS],
  PROCESSING: [S.ROYAL_SPEAKING, S.LISTENING, S.USER_SPEAKING, S.MUTED, ...ENDS],
  ROYAL_SPEAKING: [S.LISTENING, S.INTERRUPTED, S.MUTED, ...ENDS],
  INTERRUPTED: [S.USER_SPEAKING, S.LISTENING, ...ENDS],
  MUTED: [S.LISTENING, S.ROYAL_SPEAKING, ...ENDS],
  RECONNECTING: [S.LISTENING, S.ERROR_RECOVERY, S.SESSION_ENDED],
  ERROR_RECOVERY: [S.LISTENING, S.CONNECTING, S.SESSION_ENDED],
};
/* How long a state may last before its watchdog acts. */
const WATCHDOG = { CONNECTING: 12000, END_OF_TURN: 6000, PROCESSING: 60000, ROYAL_SPEAKING: 120000, INTERRUPTED: 1500, RECONNECTING: 15000, ERROR_RECOVERY: 4000 };
const PREROLL_MS = 400;

export class VoiceConversation {
  /* mic:         { open(onFrame, onEnded) -> Promise<{ sampleRate }>, close(), setEnabled(on) }
     transcriber: { kind: "batch", transcribe(wav) -> Promise<{ ok, text, error, fatal }> }
                  or { kind: "stream", begin(), text(), finish() -> Promise<{ ok, text }>, abort() }
     ask:         (text, { turn }) -> Promise<{ ok, say, run_id, pending } | { ok: false, say }>
     speaker:     { speak(text, { onStart, onEnd }) -> boolean, stop(), level() -> 0..1 } */
  constructor({ mic, transcriber, fallbackTranscriber = null, ask, speaker, continuous = true, idleMs = 5 * 60000,
    now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t),
    onState = null, onHeard = null, onTurn = null, onNotice = null } = {}) {
    Object.assign(this, { mic, transcriber, fallbackTranscriber, ask, speaker, continuous, idleMs, now, setTimer, clearTimer, onState, onHeard, onTurn, onNotice });
    this.state = S.IDLE; this.history = [];
    this.turnSeq = 0; this.attempt = 0; this.preroll = []; this.utterance = []; this.queue = [];
    this.watch = null; this.idleT = null; this.reconnects = 0;
    this.diag = { state: S.IDLE, vad: null, transcript: "none", eot: null, mic: "closed", tts: "idle", barge_ins: 0, last_barge_in: null,
      request_id: null, bot_requests: [], turns: 0, discarded: 0, errors: [], transcriber: transcriber ? transcriber.kind : null, latency: [] };
  }

  /* ---------------------------------------------------- the one state --- */
  go(next, why = "") {
    if (next === this.state) return true;
    if ((LEGAL[this.state] || []).indexOf(next) < 0) { this._err("refused " + this.state + " -> " + next + (why ? " (" + why + ")" : "")); return false; }
    const prev = this.state; this.state = next; this.diag.state = next;
    this.history.push({ at: this.now(), from: prev, to: next, why }); if (this.history.length > 80) this.history.shift();
    if (this.watch) { this.clearTimer(this.watch); this.watch = null; }
    if (WATCHDOG[next]) this.watch = this.setTimer(() => this._watchdog(next), WATCHDOG[next]);
    if (next === S.LISTENING) this._armIdle(); else if (this.idleT) { this.clearTimer(this.idleT); this.idleT = null; }
    if (this.mic && this.mic.setEnabled) this.mic.setEnabled(next !== S.MUTED);
    try { this.onState && this.onState(next, prev, why); } catch (_) {}
    if (next === S.LISTENING && this.queue.length) { const t = this.queue.shift(); this._say(t, "announce"); }
    return true;
  }
  get active() { return LIVE.indexOf(this.state) >= 0 || this.state === S.CONNECTING || this.state === S.RECONNECTING; }
  _err(e) { this.diag.errors.push({ at: this.now(), e: String(e).slice(0, 200) }); if (this.diag.errors.length > 20) this.diag.errors.shift(); }
  _armIdle() {
    if (this.idleT) this.clearTimer(this.idleT);
    this.idleT = this.setTimer(() => { if (this.state === S.LISTENING) this.end("quiet", "I've stopped listening after a quiet spell. Touch me to talk again."); }, this.idleMs);
  }
  _watchdog(st) {
    if (this.state !== st) return;
    this._err("watchdog: " + st + " took too long");
    if (st === S.END_OF_TURN) return this._finalize("watchdog");
    if (st === S.ROYAL_SPEAKING) { this.diag.tts = "stopped (watchdog)"; this._relisten("watchdog"); try { this.speaker.stop(); } catch (_) {} return; }
    if (st === S.INTERRUPTED) return this.go(S.LISTENING, "watchdog");
    if (st === S.PROCESSING) { this.turnSeq++; return this._say("That's taking too long. I'll put the answer on your screen when it comes.", "timeout"); }
    if (st === S.CONNECTING || st === S.RECONNECTING) return this.end("mic", "I couldn't open the microphone. Touch me to try again, or type.");
    if (st === S.ERROR_RECOVERY) return this.go(S.LISTENING, "recovered");
  }

  /* ------------------------------------------------------- controls --- */
  async start() {
    if (this.active) return true;
    if (!this.go(S.CONNECTING, "start")) return false;
    this.detector = null; this.turn = new TurnDetector(); this.preroll = []; this.utterance = []; this.reconnects = 0;
    return this._open();
  }
  async _open() {
    try {
      const r = await this.mic.open((f) => this.frame(f), (why) => this._micLost(why));
      this.sampleRate = r.sampleRate; this.detector = this.detector || new SpeechDetector({ sampleRate: r.sampleRate });
      this.diag.mic = "open " + r.sampleRate + " Hz" + (r.processing ? " (" + r.processing + ")" : "");
      if (this.state === S.CONNECTING || this.state === S.RECONNECTING) this.go(S.LISTENING, "microphone open");
      return true;
    } catch (e) {
      this.diag.mic = "failed: " + (e && (e.name || e.message));
      const denied = e && /NotAllowed|Permission|Security/i.test(e.name || e.message || "");
      this.end("mic", denied ? "The microphone is blocked for this site. Allow it in the browser's settings, then touch me again, or type." : "I couldn't open the microphone. Touch me to try again, or type.");
      return false;
    }
  }
  _micLost(why) {
    if (!this.active || this.state === S.RECONNECTING) return;
    this.diag.mic = "lost: " + why; this._err("microphone lost: " + why);
    const wasSpeaking = this.state === S.ROYAL_SPEAKING;
    this.go(S.RECONNECTING, why);
    if (wasSpeaking) { try { this.speaker.stop(); } catch (_) {} }
    const tries = ++this.reconnects;
    if (tries > 3) return this.end("mic", "The microphone keeps dropping. Touch me to start again, or type.");
    try { this.mic.close(); } catch (_) {}
    this.setTimer(() => { if (this.state === S.RECONNECTING) this._open(); }, 400 * Math.pow(2, tries - 1));
  }
  end(reason = "user", notice = null) {
    const was = this.state;
    if (this.watch) { this.clearTimer(this.watch); this.watch = null; }
    if (this.idleT) { this.clearTimer(this.idleT); this.idleT = null; }
    this.turnSeq++; this.utterance = []; this.queue = [];
    /* Ending is always allowed, from any state, and happens first, so
       nothing the speaker or microphone reports while closing moves it. */
    if (was !== S.SESSION_ENDED && was !== S.IDLE) {
      this.state = S.SESSION_ENDED; this.diag.state = S.SESSION_ENDED;
      this.history.push({ at: this.now(), from: was, to: S.SESSION_ENDED, why: reason });
    }
    try { this.speaker.stop(); } catch (_) {}
    try { this.mic.close(); } catch (_) {}
    if (this.transcriber && this.transcriber.abort) try { this.transcriber.abort(); } catch (_) {}
    this.diag.mic = "closed"; this.diag.tts = "idle";
    if (was !== S.SESSION_ENDED && was !== S.IDLE) try { this.onState && this.onState(S.SESSION_ENDED, was, reason); } catch (_) {}
    if (notice && this.onNotice) this.onNotice(notice, reason);
  }
  mute(on) {
    if (on && LIVE.indexOf(this.state) >= 0 && this.state !== S.MUTED) {
      if (this.state === S.USER_SPEAKING || this.state === S.END_OF_TURN) { this.utterance = []; this.turn.reset(); this.attempt++; }
      return this.go(S.MUTED, "muted");
    }
    if (!on && this.state === S.MUTED) { this.turn.reset(); return this.go(S.LISTENING, "unmuted"); }
    return false;
  }
  stopSpeaking() {
    if (this.state !== S.ROYAL_SPEAKING) return false;
    this.diag.tts = "stopped by Tahir";
    this._relisten("stopped");
    try { this.speaker.stop(); } catch (_) {}
    return true;
  }
  async restart() { this.end("restart"); return this.start(); }
  setContinuous(on) { this.continuous = !!on; }

  /* Something to say that was not asked for this turn (a specialist's late
     answer): said when ROYAL is listening, never over Tahir. */
  announce(text) { if (!text) return; if (this.state === S.LISTENING) this._say(text, "announce"); else this.queue.push(text); }

  /* --------------------------------------------------- every frame --- */
  frame(samples) {
    if (!this.detector || LIVE.indexOf(this.state) < 0 || this.state === S.MUTED) return;
    const speaking = this.state === S.ROYAL_SPEAKING;
    this.detector.setPlayback(speaking ? this.speaker.level() : 0);
    if (!speaking) this.detector.relax();
    const v = this.detector.frame(samples);
    this.diag.vad = { prob: +v.prob.toFixed(2), speech: v.speech, db: +v.db.toFixed(1), snr: +v.snr.toFixed(1), floor: v.floor == null ? null : +v.floor.toFixed(1), threshold: +v.threshold.toFixed(1) };
    this.preroll.push(samples); if (this.preroll.length > PREROLL_MS / FRAME_MS) this.preroll.shift();
    const capturing = this.state === S.USER_SPEAKING || this.state === S.END_OF_TURN;
    if (capturing) this.utterance.push(samples);
    const ev = this.turn.push(v, { strict: speaking });
    if (!ev) return;
    const t = this.now();
    if (ev === "start") {
      if (this.state === S.LISTENING || this.state === S.PROCESSING) {
        if (this.state === S.PROCESSING) { this.turnSeq++; this.diag.superseded = (this.diag.superseded || 0) + 1; }   /* a new turn replaces the one being answered */
        this._beginTurn(t, "speech");
      } else if (speaking) {
        /* Barge-in: stop ROYAL at once, keep listening, keep the words from
           just before they began.  The state moves first, so her playback's
           own "finished" callback finds her no longer speaking. */
        this.diag.barge_ins++; this.diag.last_barge_in = t; this.diag.tts = "stopped by barge-in";
        this.go(S.INTERRUPTED, "barge-in");
        try { this.speaker.stop(); } catch (_) {}
        this._beginTurn(t, "barge-in");
      }
      return;
    }
    if (!capturing) return;
    if (ev === "tentative") return this._tentative(t);
    if (ev === "resume") { this.attempt++; this.spec = null; this.diag.eot = { decision: "resumed", at: t }; this.go(S.USER_SPEAKING, "resumed"); return; }
    if (ev === "discard") { this.diag.discarded++; this.utterance = []; if (this.transcriber.kind === "stream") this.transcriber.abort(); this.go(S.LISTENING, "too short"); return; }
    if (ev === "final") return this._finalize(this.turn.endReason || "silence");
  }

  _beginTurn(t, why) {
    this._logTurn(why === "barge-in");
    this.utterance = this.preroll.slice(); this.attempt++; this.spec = null;
    this.marks = { speech_start: t };
    if (this.transcriber.kind === "stream") this.transcriber.begin();
    this.go(S.USER_SPEAKING, why);
  }

  /* A pause: transcribe what there is, and let how finished it sounds
     decide how long to wait for more. */
  async _tentative(t) {
    this.go(S.END_OF_TURN, "pause");
    this.marks.speech_end = t - this.turn.silenceMs();
    const my = ++this.attempt, frames = this.utterance.length;
    this.diag.transcript = "transcribing";
    const r = await this._transcribe(false);
    if (my !== this.attempt || this.state !== S.END_OF_TURN) return;          /* Tahir went on talking */
    if (!r.ok) { this.spec = null; this.turn.setWait(WAIT_AFTER.unknown); this.diag.transcript = "failed: " + r.error; return; }
    const c = completeness(r.text);
    this.spec = { text: r.text, frames, at: this.now() };
    this.diag.transcript = "tentative: " + c; this.diag.eot = { decision: c, wait_ms: WAIT_AFTER[c], text_words: r.text.split(/\s+/).filter(Boolean).length };
    if (this.onHeard) this.onHeard(r.text, false);
    if (c === "complete" || c === "empty") return this._finalize("complete");
    this.turn.setWait(WAIT_AFTER[c]);
  }

  async _transcribe(final) {
    const tr = this.transcriber;
    try {
      if (tr.kind === "stream") { const r = final ? await tr.finish() : { ok: true, text: tr.text() }; return r && r.ok ? { ok: true, text: String(r.text || "").trim() } : { ok: false, error: (r && r.error) || "failed" }; }
      const r = await tr.transcribe(wavFrom(this.utterance, this.sampleRate));
      if (r && r.ok) return { ok: true, text: String(r.text || "").trim() };
      /* The server can't transcribe (not set up, or Personal): the device's
         own recognizer takes over from the next turn. */
      if (r && r.fatal && this.fallbackTranscriber) { this._err("server transcription unavailable: " + r.error); this.transcriber = this.fallbackTranscriber; this.fallbackTranscriber = null; this.diag.transcriber = this.transcriber.kind + " (fallback)"; }
      return { ok: false, error: (r && r.error) || "failed" };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  /* The turn is over: final words, then ROYAL. */
  async _finalize(reason) {
    if (this.state !== S.END_OF_TURN && this.state !== S.USER_SPEAKING) return;
    const my = ++this.attempt;
    this.turn.reset();
    this.marks.final = this.now(); this.marks.speech_end = this.marks.speech_end || this.now();
    if (reason === "unbroken") {
      /* Sound with no pause for 12 s is not Tahir: ignore it and listen more strictly. */
      this.detector.stricter(); this.diag.discarded++; this.diag.eot = { decision: "noise", reason }; this.utterance = [];
      if (this.transcriber.kind === "stream") this.transcriber.abort();
      if (this.onNotice) this.onNotice("It's noisy here, so I'm listening more closely for you.", "noise");
      return this.go(S.LISTENING, "noise");
    }
    let text;
    /* Transcribed at the pause and nothing said since: those are the words. */
    if (this.spec && this.transcriber.kind !== "stream") text = this.spec.text;
    else {
      this.diag.transcript = "transcribing (final)";
      const r = await this._transcribe(true);
      if (my !== this.attempt) return;
      if (!r.ok) {
        this.utterance = [];
        this.diag.transcript = "failed: " + r.error;
        if (this.state === S.END_OF_TURN || this.state === S.USER_SPEAKING) { this.go(S.PROCESSING, "transcription failed"); return this._say("I didn't catch that. Say it again?", "transcription failed"); }
        return;
      }
      text = r.text;
    }
    this.utterance = []; this.spec = null;
    this.marks.transcript = this.now();
    if (!text) { this.diag.discarded++; this.diag.transcript = "empty (noise)"; this.diag.eot = { decision: "empty" }; return this.go(S.LISTENING, "nothing said"); }
    this.diag.transcript = "final"; this.diag.eot = { ...(this.diag.eot || {}), final: reason };
    if (this.onHeard) this.onHeard(text, true);
    this.go(S.PROCESSING, reason);
    const turnId = ++this.turnSeq;
    this.diag.turns++;
    this.marks.request = this.now();
    let res;
    try { res = await this.ask(text, { turn: turnId }); } catch (e) { res = { ok: false, say: "I couldn't reach my server. Nothing was done. Say it again when you're ready." }; }
    if (turnId !== this.turnSeq || this.state !== S.PROCESSING) return;          /* replaced by a newer turn, or ended */
    this.marks.response = this.now();
    if (res && res.run_id) this.diag.request_id = res.run_id;
    if (res && res.pending) this.diag.bot_requests = res.pending.map((p) => p.agent + ":" + p.task_id);
    this._say((res && res.say) || "", "answer");
  }

  /* ROYAL speaks; when she is done she is listening again. */
  _say(text, why) {
    if (!text || this.state === S.SESSION_ENDED) return this._relisten("nothing to say");
    const from = this.state;
    if (!this.go(S.ROYAL_SPEAKING, why)) return this._relisten("could not speak");
    this.diag.tts = "requested";
    const marks = this.marks || {};
    const done = (how) => {
      if (this.state !== S.ROYAL_SPEAKING) return;
      marks.spoken = this.now(); this.diag.tts = how;
      this._relisten(how);
    };
    let ok = false;
    try { ok = this.speaker.speak(text, { onStart: () => { marks.first_audio = marks.first_audio || this.now(); this.diag.tts = "speaking"; }, onEnd: () => done("finished") }); }
    catch (e) { this._err("speaker: " + (e && e.message)); ok = false; }
    if (!ok) { this.diag.tts = "silent (muted or unavailable)"; marks.spoken = this.now(); this._relisten("silent"); }
    return from;
  }

  /* One turn's measured stages, written once, whether ROYAL finished
     speaking or was interrupted. */
  _logTurn(interrupted = false) {
    const m = this.marks;
    if (!m || !m.speech_end || m.logged) return;
    m.logged = true; m.relisten = this.now();
    const d = (a, b) => (m[a] != null && m[b] != null ? m[b] - m[a] : null);
    const row = { end_to_transcript: d("speech_end", "transcript"), transcript_to_response: d("request", "response"), response_to_audio: d("response", "first_audio"),
      speech_end_to_audio: d("speech_end", "first_audio"), audio_to_listening: interrupted ? null : d("spoken", "relisten"), interrupted };
    this.diag.latency.push(row); if (this.diag.latency.length > 20) this.diag.latency.shift();
    if (this.onTurn) try { this.onTurn(row); } catch (_) {}
  }

  _relisten(why) {
    if (this.state === S.SESSION_ENDED) return;
    this._logTurn(false);
    if (!this.continuous && why !== "nothing to say" && this.state === S.ROYAL_SPEAKING) return this.end("single turn");
    this.turn.reset();
    if (this.state === S.LISTENING) return;
    this.go(S.LISTENING, why);
  }

  /* p50 of each latency stage over the last turns, for the diagnostics. */
  latencySummary() {
    const keys = ["end_to_transcript", "transcript_to_response", "response_to_audio", "speech_end_to_audio", "audio_to_listening"], out = {};
    for (const k of keys) { const xs = this.diag.latency.map((r) => r[k]).filter((x) => x != null).sort((a, b) => a - b); out[k] = xs.length ? xs[Math.floor(xs.length / 2)] : null; }
    return out;
  }
}
