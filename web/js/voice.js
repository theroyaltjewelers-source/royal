/* ROYAL's spoken voice: output only.

   Listening, turns and barge-in belong to the voice engine
   (web/js/conversation.js, with web/js/turn.js and web/js/capture.js); this
   file only speaks, and is that engine's speaker.

   ROYAL's own voice comes from the server (POST /v1/voice/speak), the same
   on every device, by sentence, played through Web Audio so its loudness
   moves the Core and tells the engine how loud her echo may be.  Where the
   server cannot speak (Personal, switched off, no key, offline) the
   browser's speech synthesis says it instead, so a reply is never silent.
   Mute: spoken replies can be switched off; text always remains. */

import { Playback, speechPieces } from "./playback.js";

function decode(ac, buf) { return new Promise((ok, no) => { const p = ac.decodeAudioData(buf, ok, no); if (p && p.then) p.then(ok, no); }); }

export class Voice {
  constructor({ onLevel, onSpeechBoundary, onSpeaking, audio = () => null } = {}) {
    this.canSpeak = "speechSynthesis" in window;
    this.cb = { onLevel, onSpeechBoundary, onSpeaking };
    this.speaking = false; this.onSpeakStart = null;
    this.muted = (() => { try { return localStorage.getItem("royal.muted") === "1"; } catch (_) { return false; } })();
    this.voice = null;
    this.audio = audio;          /* the page's unlocked AudioContext, if any */
    this.server = null;          /* { ready(), fetch(text, signal) -> ArrayBuffer | null } */
    this.gen = 0;                /* bumps on every new reply and every stop, so a late answer is dropped */
    if (this.canSpeak) { const pick = () => { this.voice = this._pickVoice(); }; pick(); speechSynthesis.onvoiceschanged = pick; }
  }

  _pickVoice() {
    const vs = speechSynthesis.getVoices() || [];
    const pref = [/Daniel/i, /Google UK English Male/i, /Arthur/i, /Aaron/i, /Google US English/i, /en-GB/i, /en-US/i];
    for (const re of pref) { const v = vs.find((x) => re.test(x.name) || re.test(x.lang)); if (v) return v; }
    return vs[0] || null;
  }

  /* Speak with ROYAL's own voice where the server offers it. */
  useServer(server) { this.server = server || null; }

  setMuted(m) { this.muted = !!m; try { localStorage.setItem("royal.muted", m ? "1" : "0"); } catch (_) {} if (m) this.stopSpeaking(); }

  speak(text, { onEnd } = {}) {
    if (this.muted || !text) { onEnd && onEnd(); return false; }
    if (this.server && this.server.ready()) { this.stopSpeaking(); this._speakServer(text, onEnd); return true; }
    return this._speakBrowser(text, onEnd);
  }

  _speakBrowser(text, onEnd) {
    if (!this.canSpeak || this.muted || !text) { onEnd && onEnd(); return false; }
    this.stopSpeaking();
    /* iOS often has no voice list yet when the page opens, and may never say
       when it arrives: pick again at speaking time rather than keep none. */
    if (!this.voice) this.voice = this._pickVoice();
    const u = new SpeechSynthesisUtterance(text.replace(/\$([\d,]+)/g, "$1 dollars"));
    if (this.voice) u.voice = this.voice;
    u.rate = 1.02; u.pitch = 0.96;
    u.onboundary = () => this.cb.onSpeechBoundary && this.cb.onSpeechBoundary();
    u.onstart = () => this._speakingNow(true);   /* the Core moves when sound actually starts, not before */
    u.onend = () => { this.speaking = false; this._speakingNow(false); onEnd && onEnd(); };
    u.onerror = () => { this.speaking = false; this._speakingNow(false); onEnd && onEnd(); };
    this.speaking = true;
    speechSynthesis.speak(u);
    return true;
  }

  /* ROYAL's own voice, streamed by sentence.  The reply is split into
     pieces (the first sentence alone, so the voice starts as soon as one
     sentence is ready), each piece is fetched while the one before it
     plays, and every piece goes into one playback queue (web/js/playback.js)
     that schedules it exactly where the last one ends: no gaps between
     pieces, no overlap.  A failure before the first sound hands the words
     to the device's voice; a failure later hands it the words not yet
     spoken.  An interruption silences everything at once. */
  async _speakServer(text, onEnd) {
    const gen = ++this.gen, ctl = new AbortController();
    this.abort = ctl; this.speaking = true;
    let ended = false, allQueued = false, played = 0;
    const finish = () => { if (ended) return; ended = true; if (this.endCurrent === finish) this.endCurrent = null; if (this.gen === gen) { this.speaking = false; this._speakingNow(false); } onEnd && onEnd(); };
    const handOff = (rest) => { if (ended) return; ended = true; if (this.endCurrent === finish) this.endCurrent = null; if (this.gen !== gen) { onEnd && onEnd(); return; } this.speaking = false; this._speakBrowser(rest, onEnd); };
    this.endCurrent = finish;
    const ac = this._ctx();
    if (!ac) return handOff(text);
    const pb = this._playback(ac);
    pb.begin(typeof performance !== "undefined" ? performance.now() : null);
    pb.onIdle = () => { if (allQueued && this.gen === gen) finish(); };
    const pieces = speechPieces(text), got = [];
    const get = (i) => got[i] || (got[i] = Promise.resolve().then(() => this.server.fetch(pieces[i], ctl.signal)).then((buf) => (buf ? decode(ac, buf) : null)).catch(() => null));
    for (let i = 0; i < pieces.length; i++) {
      const now = get(i);
      if (i + 1 < pieces.length) get(i + 1);                    /* the next piece is fetched while this one plays */
      const audio = await now;
      if (this.gen !== gen) return finish();                    /* stopped while the voice was on its way */
      if (!audio) {
        const rest = pieces.slice(i).join(" ");
        if (!played) return handOff(rest);
        /* Part of it played: the device voice says the rest once the queue drains. */
        pb.onIdle = () => { if (this.gen === gen) handOff(rest); };
        if (!pb.playing) handOff(rest);
        return;
      }
      pb.push(audio); played++;
      if (played === 1) this._speakingNow(true);
    }
    allQueued = true; pb.end();
    if (!pb.playing) finish();
  }

  _playback(ac) {
    if (!this.pb || this.pb.ctx !== ac) {
      let last = 0;
      this.pb = new Playback(ac, { onLevel: (a) => {
        /* Loudness moves the Core, and a rising syllable pulses it, the way
           word boundaries do for the device voice. */
        this.cb.onLevel && this.cb.onLevel(a);
        if (a - last > 0.18) this.cb.onSpeechBoundary && this.cb.onSpeechBoundary();
        last = a;
      } });
    }
    return this.pb;
  }

  /* How the voice is doing: first-audio times and gaps, for the Systems view. */
  get stats() { return this.pb ? this.pb.stats : null; }

  /* The page's AudioContext (unlocked by the first touch), or one of our own. */
  _ctx() {
    let ac = this.audio && this.audio();
    if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; try { this.ac = this.ac || new AC(); } catch (_) { return null; } ac = this.ac; }
    if (ac.state === "suspended" || ac.state === "interrupted") { try { const p = ac.resume(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
    return ac;
  }

  /* Barge-in: stop mid-sentence, whichever voice is speaking. */
  stopSpeaking() {
    this.gen++;
    if (this.abort) { try { this.abort.abort(); } catch (_) {} this.abort = null; }
    if (this.pb) this.pb.stop();
    const f = this.endCurrent; this.endCurrent = null;
    if (this.canSpeak && (this.speaking || speechSynthesis.speaking)) speechSynthesis.cancel();
    this.speaking = false; this._speakingNow(false);
    if (f) f();
  }
  _speakingNow(on) { if (this._sp === on) return; this._sp = on; if (on && this.onSpeakStart) { const f = this.onSpeakStart; this.onSpeakStart = null; f(); } this.cb.onSpeaking && this.cb.onSpeaking(on); }
}
