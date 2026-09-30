/* ROYAL's one voice: the server speaks every reply with the same xAI voice,
   so a phone and a desktop sound alike.  Server route and provider first,
   then the page's player (web/js/voice.js) against a stand-in browser. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, voiceSessionConfig } from "../server/handler.js";
import { createRoyal } from "../core/royal.js";
import { MemoryStore } from "../core/store.js";
import { GrokProvider } from "../core/providers/grok.js";
import { DEFAULT_FLAGS } from "../core/permissions.js";

const KEY = "xai-SECRETSECRETSECRET1234";
const USERS = { "t-owner": { id: "u-tahir", role: "owner" }, "t-staff": { id: "u-staff", role: "none" } };
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 1, 2, 3, 4]);

function speechApp({ flags = {}, apiKey = KEY, reply } = {}) {
  const calls = [];
  const fetchImpl = async (u, init) => {
    calls.push({ url: String(u), init, body: init && init.body ? JSON.parse(init.body) : null });
    if (reply) return reply(u, init);
    return /\/tts$/.test(String(u)) ? new Response(MP3, { status: 200, headers: { "content-type": "audio/mpeg" } }) : new Response("{}", { status: 500 });
  };
  const royal = createRoyal({ store: new MemoryStore(), flags, provider: new GrokProvider({ apiKey, model: "grok-test", fetchImpl }) });
  const h = createHandler({ royal, auth: async (t) => USERS[t] || null });
  const speak = (text, { realm = "BUSINESS", token = "t-owner" } = {}) => h(new Request("https://royal.test/v1/voice/speak" + (realm ? "?realm=" + realm : ""), {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ text }) }));
  return { royal, h, calls, speak };
}

/* ------------------------------------------------------------- server --- */

test("ROYAL's voice is on by default, a woman's voice (Ara), and the same voice realtime uses", () => {
  assert.equal(DEFAULT_FLAGS.spoken_voice, true);
  assert.equal(new GrokProvider({ apiKey: KEY, model: "m" }).voice, "ara");
  assert.equal(voiceSessionConfig().voice, "ara");
});

test("speak: the words go to xAI text to speech and MP3 comes back, with no key in sight", async () => {
  const { speak, calls } = speechApp();
  const r = await speak("Good evening, Tahir. Nothing needs you.");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), MP3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.x.ai/v1/tts");
  assert.equal(calls[0].init.headers.Authorization, "Bearer " + KEY, "the key is used only toward xAI");
  assert.deepEqual(calls[0].body, { text: "Good evening, Tahir. Nothing needs you.", voice_id: "ara", language: "en", output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 128000 } });
});

test("speak: a phrase already said is served from the cache, not paid for again", async () => {
  const { speak, calls } = speechApp();
  assert.equal((await speak("Nothing needs you.")).status, 200);
  assert.equal((await speak("Nothing  needs you. ")).status, 200, "spacing does not make it a new phrase");
  assert.equal(calls.length, 1);
  assert.equal((await speak("Two things need you.")).status, 200);
  assert.equal(calls.length, 2);
});

test("speak: Business only, owner only, and every refusal is a plain sentence", async () => {
  const { speak, calls } = speechApp();
  const personal = await speak("Your dentist is at nine.", { realm: "PERSONAL" });
  assert.equal(personal.status, 409); assert.equal((await personal.json()).error, "SPEECH_BUSINESS_ONLY");
  assert.equal(calls.length, 0, "nothing from the Personal side reaches xAI");
  assert.equal((await speak("x", { token: "t-staff" })).status, 403);
  assert.equal((await speak("x", { token: "nobody" })).status, 401);
  const empty = await speak("   ");
  assert.equal(empty.status, 400); assert.equal((await empty.json()).error, "TEXT_REQUIRED");
  const long = await speak("a".repeat(1201));
  assert.equal(long.status, 400); assert.equal((await long.json()).error, "TEXT_TOO_LONG");
  assert.equal(calls.length, 0);

  const off = speechApp({ flags: { spoken_voice: false } });
  const d = await off.speak("x");
  assert.equal(d.status, 409); assert.equal((await d.json()).error, "SPEECH_DISABLED");
  const nokey = speechApp({ apiKey: null });
  const n = await nokey.speak("x");
  assert.equal(n.status, 409); assert.equal((await n.json()).error, "SPEECH_NOT_CONFIGURED");
});

test("speak: when xAI refuses, the page is told why, without the key, and nothing is cached", async () => {
  let n = 0;
  const { speak, calls } = speechApp({ reply: async () => (++n === 1
    ? new Response(JSON.stringify({ error: { message: "Your team has used all available credits " + KEY } }), { status: 429 })
    : new Response(MP3, { status: 200 })) });
  const r = await speak("Hello.");
  const text = await r.text();
  assert.equal(r.status, 502);
  assert.match(text, /PROVIDER_HTTP_429/); assert.match(text, /credits/);
  assert.ok(!/SECRETSECRET/.test(text), "an error that quotes the key never repeats it");
  assert.equal((await speak("Hello.")).status, 200, "a failure is not remembered");
  assert.equal(calls.length, 2);
});

test("intelligence status says whether ROYAL's voice can speak", async () => {
  const st = (o) => speechApp(o).royal.intelligence.status().spoken_voice;
  assert.equal(st(), "AVAILABLE");
  assert.equal(st({ apiKey: null }), "NOT_CONFIGURED");
  assert.equal(st({ flags: { spoken_voice: false } }), "DISABLED");
});

/* --------------------------------------------------------------- page --- */

/* A stand-in browser: Web Audio, speech synthesis and animation frames,
   recording what voice.js does with them. */
async function page() {
  const log = { played: 0, stopped: 0, said: [], cancels: 0 };
  class Source { connect() {} start() { log.played++; } stop() { log.stopped++; if (this.onended) this.onended(); } }
  class AC {
    constructor() { this.state = "running"; this.destination = {}; }
    createBufferSource() { const s = new Source(); log.last = s; return s; }
    createAnalyser() { return { fftSize: 512, connect() {}, getByteTimeDomainData(a) { a.fill(170); } }; }
    decodeAudioData(buf, ok) { ok({ duration: 1, bytes: buf.byteLength }); }
    resume() { this.state = "running"; return Promise.resolve(); }
  }
  class Utterance { constructor(t) { this.text = t; } }
  const synth = {
    speaking: false, getVoices: () => [],
    speak(u) { log.said.push(u.text); log.utterance = u; this.speaking = true; if (u.onstart) u.onstart(); },
    cancel() { log.cancels++; this.speaking = false; const u = log.utterance; log.utterance = null; if (u && u.onerror) u.onerror(); },
  };
  const shims = { window: { speechSynthesis: synth, AudioContext: AC }, speechSynthesis: synth, SpeechSynthesisUtterance: Utterance,
    localStorage: { getItem: () => null, setItem: () => {} }, navigator: { language: "en-US" },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };
  const saved = {};
  for (const [k, v] of Object.entries(shims)) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
  const restore = () => { for (const k of Object.keys(shims)) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; } };
  const { Voice } = await import("../web/js/voice.js?one=" + Math.random());
  const events = { speaking: [] };
  const v = new Voice({ onSpeaking: (on) => events.speaking.push(on), onLevel: (a) => { events.level = a; } });
  return { v, log, events, synth, restore };
}
const tickOver = () => new Promise((r) => setTimeout(r, 0));

test("page: Business replies play ROYAL's voice from the server, not the device's", async () => {
  const { v, log, events, restore } = await page();
  try {
    const asked = [];
    v.useServer({ ready: () => true, fetch: async (text) => { asked.push(text); return MP3.buffer.slice(0); } });
    let ended = 0;
    assert.equal(v.speak("You have $4,200 outstanding.", { onEnd: () => ended++ }), true);
    await tickOver();
    assert.deepEqual(asked, ["You have $4,200 outstanding."], "the server gets ROYAL's own words");
    assert.equal(log.played, 1); assert.deepEqual(log.said, [], "the device voice stays quiet");
    assert.deepEqual(events.speaking.slice(-1), [true]); assert.ok(events.level > 0, "the Core moves with the voice");
    log.last.onended();
    assert.equal(ended, 1); assert.equal(v.speaking, false); assert.deepEqual(events.speaking.slice(-2), [true, false]);
  } finally { restore(); }
});

test("page: in Personal, or when the server cannot speak, the device's voice says it", async () => {
  const { v, log, restore } = await page();
  try {
    let fetched = 0;
    let business = false;
    v.useServer({ ready: () => business, fetch: async () => { fetched++; return null; } });
    v.speak("Nothing is connected on the Personal side yet.");
    assert.equal(fetched, 0); assert.deepEqual(log.said, ["Nothing is connected on the Personal side yet."]);
    log.utterance.onend();

    business = true;
    let ended = 0;
    v.speak("One thing needs you.", { onEnd: () => ended++ });
    await tickOver();
    assert.equal(fetched, 1); assert.equal(log.played, 0);
    assert.deepEqual(log.said.slice(-1), ["One thing needs you."], "a failed fetch hands the same words to the device voice");
    log.utterance.onend();
    assert.equal(ended, 1, "the reply ends once, not twice");
  } finally { restore(); }
});

test("page: speaking over ROYAL stops her at once, before or during the sound", async () => {
  const { v, log, restore } = await page();
  try {
    let release, signal;
    v.useServer({ ready: () => true, fetch: (text, s) => { signal = s; return new Promise((r) => { release = r; }); } });
    let ended = 0;
    v.speak("A long answer.", { onEnd: () => ended++ });
    await tickOver();
    v.stopSpeaking();
    assert.equal(signal.aborted, true, "the request on its way is cancelled");
    release(MP3.buffer.slice(0)); await tickOver();
    assert.equal(log.played, 0, "a voice that arrives late is never played");
    assert.equal(ended, 1);

    v.useServer({ ready: () => true, fetch: async () => MP3.buffer.slice(0) });
    ended = 0;
    v.speak("Another long answer.", { onEnd: () => ended++ });
    await tickOver();
    assert.equal(log.played, 1);
    v.stopSpeaking();
    assert.equal(log.stopped, 1); assert.equal(ended, 1); assert.equal(v.speaking, false);
  } finally { restore(); }
});

test("page: muted means silent, whichever voice would have spoken", async () => {
  const { v, log, restore } = await page();
  try {
    let fetched = 0;
    v.useServer({ ready: () => true, fetch: async () => { fetched++; return MP3.buffer.slice(0); } });
    v.muted = true;
    let ended = 0;
    assert.equal(v.speak("Hello.", { onEnd: () => ended++ }), false);
    await tickOver();
    assert.equal(fetched, 0); assert.equal(log.played, 0); assert.deepEqual(log.said, []); assert.equal(ended, 1);
  } finally { restore(); }
});
