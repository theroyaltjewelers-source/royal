/* ROYAL's audio playback queue: one continuous voice from pieces that
   arrive over the network.

   Both voice paths use it: realtime voice (PCM chunks from the WebSocket)
   and ROYAL's own voice (one WAV per sentence from /v1/voice/speak).  Each
   piece is scheduled to start exactly where the last one ends (a moving
   playback cursor), so pieces never overlap and never leave a gap while
   audio keeps arriving.

   Jitter buffer: the first piece of a reply starts a short lead ahead of
   now (60 ms).  If a piece arrives after the cursor has already run dry
   (an underrun: the listener would hear a gap), the gap is counted and the
   lead grows a little (up to 240 ms) for the rest of the session; smooth
   replies let it shrink back.  Small enough not to feel delayed, adaptive
   enough not to stutter on a weak connection.

   stop() silences everything at once and forgets the queue: after an
   interruption no old audio can play.  Loudness is read by an analyser for
   the Core. */

const LEAD_MIN = 0.06, LEAD_MAX = 0.24, LEAD_STEP = 0.04;

export class Playback {
  constructor(ctx, { onLevel = null, onIdle = null } = {}) {
    this.ctx = ctx; this.onLevel = onLevel; this.onIdle = onIdle;
    this.cursor = 0; this.lead = LEAD_MIN; this.live = new Set(); this.gen = 0;
    this.stats = { pieces: 0, underruns: 0, replies: 0, first_audio_ms: [], lead_ms: Math.round(LEAD_MIN * 1000) };
    this.analyser = null; this.replyStarted = null;
  }

  _out() {
    if (!this.analyser) {
      try { this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 512; this.analyser.connect(this.ctx.destination); } catch (_) { this.analyser = null; }
    }
    return this.analyser || this.ctx.destination;
  }

  /* A new reply is about to arrive: remember when it was asked for, so the
     time to its first sound can be measured. */
  begin(askedAt = null) { this.replyStarted = askedAt; }

  /* Queue a piece: an AudioBuffer, or mono Float32 samples at `rate`. */
  push(piece, rate) {
    const ctx = this.ctx;
    let buf = piece;
    if (!(typeof AudioBuffer !== "undefined" && piece instanceof AudioBuffer) && !(piece && piece.getChannelData)) {
      buf = ctx.createBuffer(1, piece.length, rate); buf.copyToChannel(piece, 0);
    }
    const now = ctx.currentTime;
    if (this.live.size === 0 && this.cursor <= now) {
      /* Nothing playing: this starts a reply, or the queue ran dry mid-reply. */
      if (this.stats.pieces && this.midReply) { this.stats.underruns++; this.lead = Math.min(LEAD_MAX, this.lead + LEAD_STEP); }
      this.cursor = now + this.lead;
    }
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(this._out());
    src.start(this.cursor);
    if (!this.midReply) {
      this.midReply = true; this.stats.replies++;
      if (this.replyStarted !== null) this.stats.first_audio_ms.push(Math.round((this.cursor - now) * 1000 + (performance.now() - this.replyStarted)));
      if (this.stats.first_audio_ms.length > 20) this.stats.first_audio_ms.shift();
    }
    this.cursor += buf.duration; this.stats.pieces++; this.stats.lead_ms = Math.round(this.lead * 1000);
    const gen = this.gen;
    this.live.add(src);
    src.onended = () => {
      this.live.delete(src);
      if (gen === this.gen && this.live.size === 0 && this.cursor <= ctx.currentTime + 0.01 && this.onIdle) this.onIdle();
    };
    this._meter();
    return src;
  }

  /* The reply is complete: the next piece starts a new reply, and a reply
     that played without a gap lets the lead shrink back a little. */
  end() {
    if (this.midReply && this.lead > LEAD_MIN) this.lead = Math.max(LEAD_MIN, this.lead - LEAD_STEP / 2);
    this.midReply = false; this.replyStarted = null;
  }

  get playing() { return this.live.size > 0; }

  /* Barge-in: silence now, drop everything queued. */
  stop() {
    this.gen++;
    for (const s of this.live) { try { s.onended = null; s.stop(); } catch (_) {} }
    this.live.clear(); this.cursor = 0; this.midReply = false; this.replyStarted = null;
  }

  _meter() {
    if (!this.analyser || !this.onLevel || this._raf) return;
    const data = new Uint8Array(this.analyser.fftSize);
    const tick = () => {
      if (!this.live.size) { this._raf = null; this.onLevel(0); return; }
      this.analyser.getByteTimeDomainData(data); let s = 0; for (const v of data) { const x = (v - 128) / 128; s += x * x; }
      this.onLevel(Math.min(1, Math.sqrt(s / data.length) * 4));
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }
}

/* Split a reply into speakable pieces: the first sentence alone (so the
   voice starts as soon as possible), then the rest in pieces of about 220
   characters on sentence boundaries. */
export function speechPieces(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const sentences = t.match(/[^.!?]+[.!?]+["”’)]?(\s|$)|[^.!?]+$/g) || [t];
  const out = [sentences[0].trim()];
  let cur = "";
  for (const s of sentences.slice(1)) {
    if (cur && (cur + s).length > 220) { out.push(cur.trim()); cur = ""; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}
