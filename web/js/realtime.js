/* Realtime voice: full-duplex conversation through the configured provider
   (xAI's realtime voice API), with ROYAL doing the thinking.

   The server hands out a short-lived token (POST /v1/voice/session); the
   browser opens the provider's WebSocket with it (subprotocol
   "xai-client-secret.<token>"), streams microphone audio as 24 kHz PCM16,
   and plays the voice's audio as it arrives.

   The voice has one tool, ask_royal.  When it calls it, this client sends
   Tahir's words to ROYAL (/v1/command, modality "voice"), shows ROYAL's
   answer on the stage like any other, and returns ROYAL's sentence for the
   voice to say.  Voice and typing are one intelligence.

   Playback goes through one queue (web/js/playback.js): each chunk starts
   exactly where the last one ends, behind a small adaptive jitter buffer,
   so audio that arrives a little unevenly still plays as one voice.  This
   replaced scheduling each chunk on arrival with no buffer, which left an
   audible gap whenever a chunk came a few milliseconds late.

   Barge-in: when the provider hears Tahir start speaking, playback stops at
   once and the current response is cancelled.  If the connection drops, the
   conversation itself is safe (it lives in ROYAL, keyed by conversation),
   and typing keeps working; nothing reconnects in a loop. */

import { Playback } from "./playback.js";

const RATE = 24000;

function b64FromBytes(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function bytesFromB64(b64) { const s = atob(b64), u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; }

/* Float32 at `from` Hz -> PCM16 little-endian at 24 kHz (linear resampling). */
export function toPcm16(float32, from) {
  const ratio = from / RATE, n = Math.floor(float32.length / ratio), out = new DataView(new ArrayBuffer(n * 2));
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = Math.floor(x), f = x - i0, a = float32[i0] || 0, b = float32[i0 + 1] ?? a;
    const v = Math.max(-1, Math.min(1, a + (b - a) * f));
    out.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}
export function fromPcm16(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), n = Math.floor(u8.byteLength / 2), f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = dv.getInt16(i * 2, true) / 0x8000;
  return f;
}

export class RealtimeVoice {
  constructor({ api, ask, onState, onHeard, onSaid, onLevel, onError, WS = globalThis.WebSocket, realm = () => "BUSINESS" }) {
    Object.assign(this, { api, ask, onState, onHeard, onSaid, onLevel, onError, WS, realm });
    this.ws = null; this.ctx = null; this.stream = null; this.node = null; this.pb = null; this.responding = false; this.said = ""; this.active = false; this.heardAt = null;
  }
  _state(s) { this.state = s; this.onState && this.onState(s); }

  async start() {
    if (this.active) return true;
    this._state("connecting");
    const s = await this.api("POST", "/v1/voice/session?realm=" + encodeURIComponent(this.realm ? this.realm() : "BUSINESS"));
    if (!s.ok) { this._state("unavailable"); this.onError && this.onError(s.message || "Realtime voice isn't available."); return false; }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (_) { this._state("unavailable"); this.onError && this.onError("The microphone is blocked for this site. You can allow it in the browser's settings, or type instead."); return false; }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ sampleRate: RATE });
    this.pb = new Playback(this.ctx, { onLevel: (a) => this.onLevel && this.onLevel(a) });
    await this.ctx.audioWorklet.addModule("js/pcm-worklet.js");
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "royal-pcm");
    src.connect(this.node);
    this.node.port.onmessage = (e) => {
      const f = e.data; let peak = 0; for (let i = 0; i < f.length; i += 16) peak = Math.max(peak, Math.abs(f[i]));
      this.onLevel && this.onLevel(Math.min(1, peak * 2.5));
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64FromBytes(toPcm16(f, this.ctx.sampleRate)) }));
    };
    this.ws = new this.WS(s.ws_url, ["xai-client-secret." + s.token]);
    this.ws.onopen = () => { this.ws.send(JSON.stringify({ type: "session.update", session: s.session })); this.active = true; this._state("live"); };
    this.ws.onmessage = (m) => this._event(m.data);
    this.ws.onerror = () => { this.onError && this.onError("The voice connection had a problem. Typing still works."); };
    this.ws.onclose = () => { const was = this.active; this._teardown(); if (was) this._state("disconnected"); };
    return true;
  }

  async _event(raw) {
    let e; try { e = JSON.parse(raw); } catch (_) { return; }
    switch (e.type) {
      case "input_audio_buffer.speech_started": this.interrupt(); this._state("listening"); break;
      case "input_audio_buffer.speech_stopped": this.heardAt = performance.now(); break;
      case "conversation.item.input_audio_transcription.completed": if (e.transcript) this.onHeard && this.onHeard(e.transcript, true); break;
      case "conversation.item.input_audio_transcription.delta": if (e.delta) this.onHeard && this.onHeard(e.delta, false); break;
      case "response.created": this.responding = true; this.said = ""; if (this.pb) this.pb.begin(this.heardAt); this.heardAt = null; break;
      case "response.output_audio.delta": if (e.delta) this._play(fromPcm16(bytesFromB64(e.delta))); break;
      case "response.output_audio_transcript.delta": this.said += e.delta || ""; this.onSaid && this.onSaid(this.said); break;
      case "response.done": this.responding = false; if (this.pb) this.pb.end(); this._state("live"); break;
      case "response.function_call_arguments.done": await this._tool(e); break;
      case "error": this.onError && this.onError((e.error && e.error.message) || "The voice service reported an error."); break;
    }
  }

  async _tool(e) {
    let args = {}; try { args = JSON.parse(e.arguments || "{}"); } catch (_) { args = {}; }
    let output;
    if (e.name !== "ask_royal" || !args.request) output = { say: "I couldn't use that tool." };
    else {
      this._state("thinking");
      const r = await this.ask(String(args.request).slice(0, 2000));
      output = r ? { say: (r.presentation && r.presentation.speech) || r.summary, status: r.status, needs_approval: !!(r.presentation && r.presentation.surfaces.some((p) => p.type === "DECISION_OBJECT" && p.data.status === "OPEN")),
        note: "Approvals happen on screen. Do not say anything was sent or done unless 'say' says so." } : { say: "I couldn't check that just now." };
    }
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: e.call_id, output: JSON.stringify(output) } }));
    this.ws.send(JSON.stringify({ type: "response.create" }));
  }

  _play(f32) {
    if (!this.ctx || !this.pb) return;
    this.pb.push(f32, RATE);
    if (this.state !== "speaking") this._state("speaking");
  }

  /* Barge-in: silence now, cancel what the voice was saying. */
  interrupt() {
    if (this.pb) this.pb.stop();
    if (this.responding && this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: "response.cancel" }));
    this.responding = false;
  }

  /* Text into the same live conversation (typing while voice is on). */
  sayText(text) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
    this.ws.send(JSON.stringify({ type: "response.create" }));
    return true;
  }

  stop() { this.active = false; try { this.ws && this.ws.close(); } catch (_) {} this._teardown(); this._state("off"); }
  _teardown() {
    this.interrupt();
    if (this.node) { try { this.node.disconnect(); } catch (_) {} this.node = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.ctx) { try { this.ctx.close(); } catch (_) {} this.ctx = null; }
    this.ws = null; this.active = false;
  }
}
