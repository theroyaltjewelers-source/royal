/* ROYAL's voice engine: the conversation state machine (web/js/conversation.js)
   and turn detection (web/js/turn.js), driven frame by frame with synthetic
   audio in virtual time.  The microphone, transcription, ROYAL and the
   speaker are stand-ins with realistic delays; the state machine, the
   detector and the turn logic are the real code the page runs. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceConversation, VSTATE as S, LEGAL } from "../web/js/conversation.js";
import { SpeechDetector, TurnDetector, completeness, wavFrom } from "../web/js/turn.js";
import * as A from "./audio_fixtures.js";

/* ----------------------------------------------------------- harness --- */
class Sim {
  constructor() { this.t = 0; this.timers = []; }
  setTimer = (f, ms) => { const id = { at: this.t + ms, f }; this.timers.push(id); return id; };
  clearTimer = (id) => { this.timers = this.timers.filter((x) => x !== id); };
  delay(ms) { return new Promise((r) => this.setTimer(r, ms)); }
  async tick() {
    this.t += 20;
    for (;;) { const due = this.timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at)[0]; if (!due) break; this.timers = this.timers.filter((x) => x !== due); due.f(); }
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  }
}

function world({ texts = [], reply = (t) => "You said " + t + ".", askMs = 300, sttMs = 150, words = 60, failAsk = false, speakOk = true, neverEnds = false, continuous = true, sttFail = null } = {}) {
  const sim = new Sim();
  const log = { asked: [], said: [], states: [], stops: 0, opens: 0, closes: 0, notices: [], heard: [] };
  let speaking = null;
  const queue = texts.slice();
  const mic = { onEnded: null, enabled: true,
    open: async (onFrame, onEnded) => { log.opens++; mic.onEnded = onEnded; if (mic.deny) throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); return { sampleRate: A.SR }; },
    close: () => { log.closes++; }, setEnabled: (on) => { mic.enabled = on; } };
  const transcriber = { kind: "batch", calls: 0, transcribe: async () => {
    transcriber.calls++; await sim.delay(sttMs);
    if (sttFail) { const f = sttFail(transcriber.calls); if (f) return f; }
    return { ok: true, text: queue.length ? (queue[0].tentative && transcriber.lastTentative !== queue[0] ? (transcriber.lastTentative = queue[0], queue[0].tentative) : queue.shift().text || "") : "" };
  } };
  const speaker = {
    speak: (text, { onStart, onEnd }) => {
      log.said.push(text);
      if (!speakOk) return false;
      const n = text.split(/\s+/).length;
      speaking = { start: sim.setTimer(() => onStart && onStart(), 250), end: neverEnds ? null : sim.setTimer(() => { speaking = null; onEnd && onEnd(); }, 250 + n * words) };
      return true;
    },
    stop: () => { if (speaking) { log.stops++; sim.clearTimer(speaking.start); if (speaking.end) sim.clearTimer(speaking.end); speaking = null; } },
    level: () => (speaking ? 0.6 : 0),
    get speaking() { return !!speaking; },
  };
  const ask = async (text) => { log.asked.push(text); await sim.delay(askMs); if (failAsk) throw new Error("network"); return { ok: true, say: reply(text), run_id: "run_" + log.asked.length }; };
  const conv = new VoiceConversation({ mic, transcriber, ask, speaker, continuous, now: () => sim.t, setTimer: sim.setTimer, clearTimer: sim.clearTimer,
    onState: (s) => log.states.push(s), onNotice: (n) => log.notices.push(n), onHeard: (t, f) => log.heard.push([t, f]) });
  /* What the microphone hears: the scene plus, while ROYAL speaks, her
     echo as it survives the browser's echo cancellation (about -40 dBFS). */
  const echo = A.speech(60000, { dbfs: -42, f0: 210 });
  let ei = 0;
  async function play(sig) {
    for (const f of A.frames(sig)) {
      let fr = f;
      if (speaking) { fr = new Float32Array(f.length); for (let i = 0; i < f.length; i++) fr[i] = f[i] + echo[(ei++) % echo.length]; }
      conv.frame(fr); await sim.tick();
    }
  }
  const quiet = (ms) => play(A.room(ms));
  return { sim, conv, log, play, quiet, mic, transcriber, speaker, queue };
}
const sp = (ms, o) => A.speech(ms, o);
async function waitFor(w, pred, ms = 15000) { for (let i = 0; i < ms / 20 && !pred(); i++) await w.quiet(20); assert.ok(pred(), "timed out; state " + w.conv.state); }

/* --------------------------------------------------- turn detection --- */
test("detector: speech is speech; hiss, a held chord and a fan are not (after the floor learns them)", () => {
  const rate = (sig, pre) => { const d = new SpeechDetector({ sampleRate: A.SR }); for (const f of A.frames(pre || A.room(600))) d.frame(f); const fs = A.frames(sig); return fs.filter((f) => d.frame(f).speech).length / fs.length; };
  assert.ok(rate(sp(3000)) > 0.85, "speech");
  assert.ok(rate(A.mix(sp(3000), A.hvac(3000)), A.hvac(800)) > 0.8, "speech over a fan");
  assert.equal(rate(A.hiss(4000)), 0, "hiss");
  assert.ok(rate(A.pad(4000)) < 0.1, "sustained music");
  assert.equal(rate(A.hvac(4000), A.hvac(800)), 0, "a fan that was already on");
});

test("completeness: finished sentences and short replies end now; a sentence left hanging waits", () => {
  for (const t of ["Yes.", "no", "Why?", "Continue.", "Do it.", "Send it.", "Which one?", "Explain.", "Try again.", "Royal, tell me what every bot accomplished today."]) assert.equal(completeness(t), "complete", t);
  for (const t of ["Royal, I want you to", "go through today's sales and", "um", "Can you", "the deposit for the"]) assert.equal(completeness(t), "incomplete", t);
  assert.equal(completeness(""), "empty");
});

test("wav: a turn is sent as a 16 kHz mono WAV", () => {
  const w = wavFrom([new Float32Array(48000)], 48000);
  assert.equal(String.fromCharCode(...w.subarray(0, 4)), "RIFF"); assert.equal(new DataView(w.buffer).getUint32(24, true), 16000); assert.equal(w.length, 44 + 32000);
});

/* --------------------------------------------- the conversation loop --- */
test("activate once: question, answer, and ROYAL is listening again; the follow-up needs no touch", async () => {
  const w = world({ texts: [{ text: "How many leads did we get today?" }, { text: "Which ones are the strongest?" }] });
  await w.conv.start(); assert.equal(w.conv.state, S.LISTENING);
  await w.quiet(400); await w.play(sp(1800)); await waitFor(w, () => w.log.said.length === 1);
  assert.equal(w.conv.state, S.ROYAL_SPEAKING);
  await waitFor(w, () => w.conv.state === S.LISTENING);
  await w.quiet(1500);
  await w.play(sp(1500)); await waitFor(w, () => w.log.asked.length === 2);
  assert.deepEqual(w.log.asked, ["How many leads did we get today?", "Which ones are the strongest?"]);
  assert.equal(w.log.opens, 1, "the microphone was opened once");
  const seq = w.log.states.join(">");
  assert.match(seq, /LISTENING>USER_SPEAKING>END_OF_TURN>PROCESSING>ROYAL_SPEAKING>LISTENING>USER_SPEAKING/);
});

test("a finished request ends quickly; a short reply ends even faster", async () => {
  const w = world({ texts: [{ text: "Royal, tell me what every bot accomplished today." }, { text: "Yes." }] });
  await w.conv.start(); await w.quiet(400);
  await w.play(sp(2500));
  const endAt = w.sim.t; await waitFor(w, () => w.log.asked.length === 1);
  const lat1 = w.sim.t - endAt;
  assert.ok(lat1 <= 1100, "full request finalized " + lat1 + " ms after speech ended");
  await waitFor(w, () => w.conv.state === S.LISTENING); await w.quiet(600);
  await w.play(sp(380));
  const end2 = w.sim.t; await waitFor(w, () => w.log.asked.length === 2);
  assert.ok(w.sim.t - end2 <= 800, "\"Yes.\" finalized " + (w.sim.t - end2) + " ms after it ended");
});

test("thinking pauses stay inside one turn: “Royal, I want you to …” [1 s] “… go through today's sales activity.”", async () => {
  const w = world({ texts: [{ tentative: "Royal, I want you to", text: "Royal, I want you to go through today's sales activity." }] });
  await w.conv.start(); await w.quiet(400);
  await w.play(sp(1400)); await w.quiet(1000); await w.play(sp(1600));
  await waitFor(w, () => w.log.asked.length === 1);
  assert.deepEqual(w.log.asked, ["Royal, I want you to go through today's sales activity."]);
  assert.ok(w.log.states.includes(S.END_OF_TURN) && w.log.states.join(">").includes("END_OF_TURN>USER_SPEAKING"), "it paused, then resumed the same turn");
});

test("background noise never opens or holds a turn: a fan, music, hiss", async () => {
  const w = world({ texts: [{ text: "What needs me?" }] });
  await w.conv.start(); await w.quiet(400);
  await w.play(A.hiss(3000)); await w.play(A.pad(4000));
  assert.equal(w.log.asked.length, 0); assert.equal(w.conv.state, S.LISTENING);
  /* Tahir speaks with the fan running: the turn still ends on time */
  await w.play(A.hvac(1500, -40));
  await w.play(A.mix(sp(1800), A.hvac(1800, -40)));
  const endAt = w.sim.t;
  for (let i = 0; i < 200 && w.log.asked.length === 0; i++) await w.play(A.hvac(20, -40));
  assert.deepEqual(w.log.asked, ["What needs me?"]);
  assert.ok(w.sim.t - endAt < 3500, "ended " + (w.sim.t - endAt) + " ms after he stopped, with the fan still on");
});

test("a loud, continuous sound (a tone with a beat) cannot hold a turn open: the floor absorbs it, the turn ends, and a transcript of nothing is dropped", async () => {
  const w = world({ texts: [{ text: "" }, { text: "" }, { text: "" }, { text: "" }] });
  await w.conv.start(); await w.quiet(400);
  const loud = new Float32Array(14000 * 16); for (let i = 0; i < loud.length; i++) { const t = i / 16000; loud[i] = 0.1 * (0.4 + 0.6 * Math.abs(Math.sin(Math.PI * 4.5 * t))) * Math.sin(2 * Math.PI * 150 * t); }
  const ends = [];
  const before = w.log.states.length;
  await w.play(loud); await w.quiet(1500);
  const seq = w.log.states.slice(before);
  assert.ok(seq.includes(S.END_OF_TURN), "the turn ended while the sound went on: " + seq.join(">"));
  assert.equal(w.log.asked.length, 0, "nothing was sent to ROYAL");
  assert.equal(w.conv.state, S.LISTENING);
});

test("the 12-second rule: a turn with no pause at all is ended and dropped, and ROYAL listens more strictly", () => {
  const t = new TurnDetector();
  let ev = null;
  for (let i = 0; i < 700 && ev !== "final"; i++) { ev = t.push({ speech: true }); }
  assert.equal(ev, "final"); assert.equal(t.endReason, "unbroken");
  const d = new SpeechDetector({ sampleRate: A.SR }); d.stricter(); assert.equal(d.threshold, 15);
});

test("barge-in: Tahir talks over ROYAL; she stops at once, his words are kept, and her own voice never opens a turn", async () => {
  const w = world({ texts: [{ text: "Tell me about the pipeline." }, { text: "No, Royal, that's not what I meant." }], words: 400 });
  await w.conv.start(); await w.quiet(400);
  await w.play(sp(1500)); await waitFor(w, () => w.conv.state === S.ROYAL_SPEAKING);
  await w.quiet(2000);   /* her echo alone, for two seconds */
  assert.equal(w.conv.state, S.ROYAL_SPEAKING, "her own voice did not interrupt her");
  await w.play(sp(1800));
  assert.ok(w.log.stops >= 1, "playback stopped");
  await waitFor(w, () => w.log.asked.length === 2);
  assert.equal(w.log.asked[1], "No, Royal, that's not what I meant.");
  assert.match(w.log.states.join(">"), /ROYAL_SPEAKING>INTERRUPTED>USER_SPEAKING/);
  assert.equal(w.conv.diag.barge_ins, 1);
});

test("rapid interruptions, a long wait before answering, and a change of subject all stay in one session", async () => {
  const w = world({ texts: [{ text: "One." }, { text: "Two." }, { text: "Three." }, { text: "New subject: what's the cash position?" }], words: 500 });
  await w.conv.start(); await w.quiet(400);
  await w.play(sp(800)); await waitFor(w, () => w.conv.state === S.ROYAL_SPEAKING);
  await w.play(sp(800)); await waitFor(w, () => w.log.asked.length === 2 && w.conv.state === S.ROYAL_SPEAKING);
  await w.play(sp(800)); await waitFor(w, () => w.log.asked.length === 3 && w.conv.state === S.ROYAL_SPEAKING);
  await waitFor(w, () => w.conv.state === S.LISTENING, 30000);
  await w.quiet(8000);   /* he thinks for eight seconds */
  assert.equal(w.conv.state, S.LISTENING, "still listening");
  await w.play(sp(2200)); await waitFor(w, () => w.log.asked.length === 4);
  assert.equal(w.conv.diag.barge_ins, 2); assert.equal(w.log.opens, 1);
});

test("a slow answer (bots working) keeps PROCESSING without timing out; speaking during it starts a new turn", async () => {
  const w = world({ texts: [{ text: "Talk to each of the bots." }, { text: "Actually, what needs me?" }], askMs: 9000 });
  await w.conv.start(); await w.quiet(400);
  await w.play(sp(1500)); await waitFor(w, () => w.conv.state === S.PROCESSING);
  await w.quiet(3000); assert.equal(w.conv.state, S.PROCESSING);
  await w.play(sp(1500)); await waitFor(w, () => w.log.asked.length === 2);
  await waitFor(w, () => w.log.said.length >= 1, 20000);
  assert.deepEqual(w.log.said, ["You said Actually, what needs me?."], "only the newest answer is spoken");
});

test("ROYAL failing, the network failing, or the voice failing never leaves her stuck", async () => {
  const a = world({ texts: [{ text: "What needs me?" }], failAsk: true });
  await a.conv.start(); await a.quiet(400); await a.play(sp(1500));
  await waitFor(a, () => a.log.said.length === 1);
  assert.match(a.log.said[0], /couldn't reach my server/); await waitFor(a, () => a.conv.state === S.LISTENING);
  const b = world({ texts: [{ text: "What needs me?" }], speakOk: false });
  await b.conv.start(); await b.quiet(400); await b.play(sp(1500));
  await waitFor(b, () => b.log.asked.length === 1); await waitFor(b, () => b.conv.state === S.LISTENING);
  const c = world({ texts: [{ text: "What needs me?" }], neverEnds: true });
  await c.conv.start(); await c.quiet(400); await c.play(sp(1500));
  await waitFor(c, () => c.conv.state === S.ROYAL_SPEAKING);
  await waitFor(c, () => c.conv.state === S.LISTENING, 125000);   /* the speaking watchdog */
  const d = world({ texts: [], sttFail: () => ({ ok: false, error: "PROVIDER_TIMEOUT" }) });
  await d.conv.start(); await d.quiet(400); await d.play(sp(1500));
  await waitFor(d, () => d.log.said.length === 1); assert.match(d.log.said[0], /didn't catch that/); await waitFor(d, () => d.conv.state === S.LISTENING);
});

test("server transcription unavailable: the device's recognizer takes over from the next turn", async () => {
  const w = world({ texts: [], sttFail: () => ({ ok: false, error: "TRANSCRIPTION_NOT_CONFIGURED", fatal: true }) });
  let begun = 0; const stream = { kind: "stream", begin: () => begun++, text: () => "Send it.", finish: async () => ({ ok: true, text: "Send it." }), abort: () => {} };
  w.conv.fallbackTranscriber = stream;
  await w.conv.start(); await w.quiet(400); await w.play(sp(1200));
  await waitFor(w, () => w.conv.state === S.LISTENING && w.log.said.length === 1);
  await w.play(sp(600)); await waitFor(w, () => w.log.asked.length === 1);
  assert.deepEqual(w.log.asked, ["Send it."]); assert.equal(begun, 1); assert.match(w.conv.diag.transcriber, /fallback/);
});

test("the microphone dropping reconnects; denied permission ends plainly; mute, stop and end do what they say", async () => {
  const w = world({ texts: [{ text: "Hello." }] });
  await w.conv.start(); await w.quiet(400);
  w.mic.onEnded("device changed"); assert.equal(w.conv.state, S.RECONNECTING);
  await waitFor(w, () => w.conv.state === S.LISTENING); assert.equal(w.log.opens, 2);
  w.conv.mute(true); assert.equal(w.conv.state, S.MUTED); assert.equal(w.mic.enabled, false);
  await w.play(sp(1500)); assert.equal(w.log.asked.length, 0, "muted hears nothing");
  w.conv.mute(false); await w.quiet(300); await w.play(sp(1200)); await waitFor(w, () => w.conv.state === S.ROYAL_SPEAKING);
  w.conv.stopSpeaking(); assert.equal(w.conv.state, S.LISTENING);
  w.conv.end("user"); assert.equal(w.conv.state, S.SESSION_ENDED); assert.ok(w.log.closes >= 1);
  await w.conv.start(); assert.equal(w.conv.state, S.LISTENING, "restarted");
  const d = world({}); d.mic.deny = true;
  await d.conv.start(); assert.equal(d.conv.state, S.SESSION_ENDED); assert.match(d.log.notices[0], /microphone is blocked/);
});

test("twenty turns in a row, hands free, with latency recorded for each", async () => {
  const texts = Array.from({ length: 20 }, (_, i) => ({ text: "Question number " + (i + 1) + "." }));
  const w = world({ texts, words: 40 });
  await w.conv.start(); await w.quiet(400);
  for (let i = 0; i < 20; i++) {
    await w.play(sp(1200 + (i % 3) * 300));
    await waitFor(w, () => w.log.asked.length === i + 1);
    await waitFor(w, () => w.conv.state === S.LISTENING);
    await w.quiet(500 + (i % 4) * 400);
  }
  assert.equal(w.log.asked.length, 20); assert.equal(w.log.opens, 1);
  assert.equal(w.conv.diag.latency.length, 20);
  const l = w.conv.latencySummary();
  for (const k of ["end_to_transcript", "transcript_to_response", "response_to_audio", "speech_end_to_audio", "audio_to_listening"]) assert.ok(l[k] != null, k);
  assert.ok(l.audio_to_listening <= 40, "listening again within a frame of ROYAL finishing: " + l.audio_to_listening);
});

test("a specialist's late answer is said only when ROYAL is listening, never over Tahir; continuous off ends after one answer", async () => {
  const w = world({ texts: [{ text: "Long question here please." }] });
  await w.conv.start(); await w.quiet(400);
  await w.play(sp(800));
  w.conv.announce("GRACE came back: it's in setting.");
  assert.equal(w.log.said.length, 0, "not while he is talking");
  await waitFor(w, () => w.log.said.length >= 1);
  await waitFor(w, () => w.log.said.length === 2, 30000);
  assert.ok(w.log.said.includes("GRACE came back: it's in setting."));
  const o = world({ texts: [{ text: "Just this." }], continuous: false });
  await o.conv.start(); await o.quiet(400); await o.play(sp(900));
  await waitFor(o, () => o.conv.state === S.SESSION_ENDED, 20000);
});

test("one state machine: illegal transitions are refused; every state has a way back", () => {
  const c = new VoiceConversation({ mic: {}, transcriber: { kind: "batch" }, ask: async () => null, speaker: { stop() {}, level: () => 0 } });
  assert.equal(c.go(S.ROYAL_SPEAKING), false, "IDLE cannot speak");
  for (const [from, tos] of Object.entries(LEGAL)) if (from !== "IDLE" && from !== "SESSION_ENDED") assert.ok(tos.includes(S.LISTENING) || tos.includes(S.SESSION_ENDED), from);
});
