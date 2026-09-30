/* Voice: another channel into the same ROYAL, not a separate assistant.

   Input:  the browser's speech recognition (feature-detected).  Partial and
           final transcripts, silence detection, cancellation, errors named
           plainly.  While listening, the microphone level drives the Core.
   Output: the browser's speech synthesis.  Word boundaries pulse the Core.
   Barge-in: speaking, tapping the Core or typing stops ROYAL mid-sentence.
   Mute:   spoken replies can be switched off; text always remains.

   What this is not: server-side or real-time streamed speech.  Recognition
   runs in the browser, which in Chrome and Edge sends audio to the browser
   vendor's speech service.  Where recognition is missing, ROYAL says so and
   typing is offered.  Nothing here pretends to have heard anything. */

export class Voice {
  constructor({ onPartial, onFinal, onState, onLevel, onError, onSpeechBoundary, onSpeaking } = {}) {
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this.canListen = !!this.SR;
    this.canSpeak = "speechSynthesis" in window;
    this.cb = { onPartial, onFinal, onState, onLevel, onError, onSpeechBoundary, onSpeaking };
    this.rec = null; this.listening = false; this.starting = false; this.speaking = false;
    this.muted = (() => { try { return localStorage.getItem("royal.muted") === "1"; } catch (_) { return false; } })();
    this.voice = null;
    if (this.canSpeak) { const pick = () => { this.voice = this._pickVoice(); }; pick(); speechSynthesis.onvoiceschanged = pick; }
  }

  _pickVoice() {
    const vs = speechSynthesis.getVoices() || [];
    const pref = [/Daniel/i, /Google UK English Male/i, /Arthur/i, /Aaron/i, /Google US English/i, /en-GB/i, /en-US/i];
    for (const re of pref) { const v = vs.find((x) => re.test(x.name) || re.test(x.lang)); if (v) return v; }
    return vs[0] || null;
  }

  setMuted(m) { this.muted = !!m; try { localStorage.setItem("royal.muted", m ? "1" : "0"); } catch (_) {} if (m) this.stopSpeaking(); }

  async listen() {
    if (!this.canListen) { this.cb.onError && this.cb.onError("unsupported", "Voice input isn't available in this browser. You can type instead."); return false; }
    this.stopSpeaking();
    /* Already listening, or starting to (the microphone can take a moment):
       a second touch must not start a second recognizer, which fails and
       drops Tahir into typing with an error. */
    if (this.listening || this.starting) return true;
    const rec = new this.SR(); this.rec = rec;
    rec.lang = navigator.language && /^en/.test(navigator.language) ? navigator.language : "en-US";
    rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let finalText = "", heard = false;
    const silence = setTimeout(() => { if (!heard) rec.stop(); }, 8000);
    rec.onstart = () => { this.starting = false; this.listening = true; this.cb.onState && this.cb.onState("listening"); this._meter(); };
    rec.onresult = (e) => {
      heard = true; let t = "";
      for (const r of e.results) { t += r[0].transcript; if (r.isFinal) finalText = t; }
      this.cb.onPartial && this.cb.onPartial(t);
    };
    rec.onerror = (e) => {
      const msg = { "not-allowed": "The microphone is blocked for this site. You can allow it in the browser's site settings, or type instead.",
        "service-not-allowed": "The browser's speech service is turned off. You can type instead.",
        "no-speech": "", "aborted": "", "network": "The speech service couldn't be reached. You can type instead.",
        "audio-capture": "No microphone was found. You can type instead." }[e.error];
      if (msg) this.cb.onError && this.cb.onError(e.error, msg);
    };
    rec.onend = () => {
      clearTimeout(silence); if (this.rec === rec) this.starting = false; this.listening = false; this._stopMeter();
      this.cb.onState && this.cb.onState("idle");
      if (finalText.trim()) this.cb.onFinal && this.cb.onFinal(finalText.trim());
    };
    try { this.starting = true; rec.start(); return true; } catch (e) { this.starting = false; this.cb.onError && this.cb.onError("start", "Voice couldn't start. You can type instead."); return false; }
  }

  cancel() { if (this.rec && (this.listening || this.starting)) { try { this.rec.abort(); } catch (_) {} } this.starting = false; this.listening = false; this._stopMeter(); }

  async _meter() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      /* Listening may have ended while the microphone was opening: close it
         at once rather than leave it running with nothing reading it. */
      if (!this.listening) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      const AC = window.AudioContext || window.webkitAudioContext; this.ac = this.ac || new AC();
      if (this.ac.state === "suspended") { try { const p = this.ac.resume(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }   /* else the level meter reads silence and the Core does not move with the voice */
      const src = this.ac.createMediaStreamSource(this.stream), an = this.ac.createAnalyser(); an.fftSize = 512; src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        if (!this.listening) return;
        an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) { const x = (v - 128) / 128; s += x * x; }
        this.cb.onLevel && this.cb.onLevel(Math.min(1, Math.sqrt(s / buf.length) * 5));
        this._raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (_) { /* no level meter; recognition still works */ }
  }
  _stopMeter() { cancelAnimationFrame(this._raf); if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; } }

  speak(text, { onEnd } = {}) {
    if (!this.canSpeak || this.muted || !text) { onEnd && onEnd(); return false; }
    this.stopSpeaking();
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
  /* Barge-in: stop mid-sentence. */
  stopSpeaking() { if (this.canSpeak && (this.speaking || speechSynthesis.speaking)) speechSynthesis.cancel(); this.speaking = false; this._speakingNow(false); }
  _speakingNow(on) { if (this._sp === on) return; this._sp = on; this.cb.onSpeaking && this.cb.onSpeaking(on); }
}
