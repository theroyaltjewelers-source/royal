/* The browser side of ROYAL's voice engine: the microphone, transcription
   and the speaker, as the adapters web/js/conversation.js drives.  None of
   them decides anything about turns; the conversation does.

     Microphone   getUserMedia with the browser's echo cancellation, noise
                  suppression and automatic gain (each reported back as it
                  was actually granted), 20 ms frames from an AudioWorklet
                  (web/js/pcm-worklet.js), or a ScriptProcessor where
                  worklets are missing.  A track that ends, or a device
                  change, is reported so the conversation can reconnect.
     Transcribers ServerTranscriber: one finished turn as a WAV to
                  POST /v1/voice/transcribe (xAI speech-to-text, Business).
                  DeviceTranscriber: the browser's own recognizer, started
                  when the conversation hears a turn begin and stopped when
                  it decides the turn is over; used in Personal, or when the
                  server cannot transcribe.  It begins at the onset, so the
                  first syllable can be missed; the server path keeps a
                  400 ms pre-roll and does not.
     Speaker      ROYAL's existing voice (web/js/voice.js): her own voice from
                  the server by sentence, the device voice as a fallback,
                  with the playback loudness the detector uses to tell her
                  echo from Tahir. */

export class Microphone {
  constructor({ audio = () => null, worklet = "js/pcm-worklet.js" } = {}) { this.audio = audio; this.worklet = worklet; this.stream = null; this.node = null; this.src = null; }
  async open(onFrame, onEnded) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error("No microphone access in this browser"), { name: "NotSupportedError" });
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const track = this.stream.getAudioTracks()[0];
    const st = track && track.getSettings ? track.getSettings() : {};
    const processing = ["echoCancellation", "noiseSuppression", "autoGainControl"].filter((k) => st[k] === true).map((k) => ({ echoCancellation: "echo cancellation", noiseSuppression: "noise suppression", autoGainControl: "gain control" }[k])).join(", ") || "none reported";
    let ac = this.audio && this.audio();
    if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; this.own = ac = new AC(); }
    if (ac.state === "suspended") { try { await ac.resume(); } catch (_) {} }
    this.ac = ac;
    this.src = ac.createMediaStreamSource(this.stream);
    const frameLen = Math.round(ac.sampleRate / 50);
    if (ac.audioWorklet && window.AudioWorkletNode) {
      if (!Microphone.loaded || Microphone.loaded !== ac) { await ac.audioWorklet.addModule(this.worklet); Microphone.loaded = ac; }
      this.node = new AudioWorkletNode(ac, "royal-pcm");
      this.node.port.onmessage = (e) => onFrame(e.data);
      this.src.connect(this.node);
    } else {
      /* Older Safari: a ScriptProcessor, cut into the same 20 ms frames. */
      const sp = ac.createScriptProcessor(1024, 1, 1); let buf = new Float32Array(0);
      sp.onaudioprocess = (e) => {
        const x = e.inputBuffer.getChannelData(0), joined = new Float32Array(buf.length + x.length); joined.set(buf); joined.set(x, buf.length); buf = joined;
        while (buf.length >= frameLen) { onFrame(buf.slice(0, frameLen)); buf = buf.slice(frameLen); }
      };
      this.src.connect(sp); sp.connect(ac.destination); this.node = sp;
    }
    this.ended = () => onEnded && onEnded("microphone ended");
    if (track) track.addEventListener("ended", this.ended);
    this.devices = () => onEnded && onEnded("audio device changed");
    if (navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", this.devices);
    return { sampleRate: ac.sampleRate, processing };
  }
  setEnabled(on) { if (this.stream) this.stream.getAudioTracks().forEach((t) => { t.enabled = !!on; }); }
  close() {
    if (this.devices && navigator.mediaDevices && navigator.mediaDevices.removeEventListener) navigator.mediaDevices.removeEventListener("devicechange", this.devices);
    if (this.node) { try { this.node.disconnect(); } catch (_) {} if (this.node.port) this.node.port.onmessage = null; this.node = null; }
    if (this.src) { try { this.src.disconnect(); } catch (_) {} this.src = null; }
    if (this.stream) { this.stream.getAudioTracks().forEach((t) => { if (this.ended) t.removeEventListener("ended", this.ended); t.stop(); }); this.stream = null; }
    if (this.own) { try { this.own.close(); } catch (_) {} this.own = null; }
  }
}

/* One finished turn to words, on the server. */
export class ServerTranscriber {
  constructor({ api, realm = () => "BUSINESS" }) { this.kind = "batch"; this.api = api; this.realm = realm; }
  async transcribe(wav) {
    const r = await this.api(wav, this.realm());
    if (r && r.ok) return { ok: true, text: r.text || "" };
    const code = (r && r.error) || "TRANSCRIPTION_FAILED";
    /* Not set up, switched off or the wrong realm: no point asking again. */
    return { ok: false, error: code, fatal: /NOT_CONFIGURED|DISABLED|BUSINESS_ONLY|AUDIO_NOT_WAV/.test(code) || (r && r.status === 409) };
  }
}

/* The browser's own recognizer, steered by the conversation's turns. */
export class DeviceTranscriber {
  constructor() {
    this.kind = "stream";
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this.available = !!this.SR; this.rec = null; this.finalText = ""; this.interim = ""; this.ended = null;
  }
  begin() {
    if (!this.SR) return;
    this.abort();
    const rec = new this.SR(); this.rec = rec; this.finalText = ""; this.interim = "";
    rec.lang = navigator.language && /^en/.test(navigator.language) ? navigator.language : "en-US";
    rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
    rec.onresult = (e) => { let f = "", i = ""; for (const r of e.results) { if (r.isFinal) f += r[0].transcript; else i += r[0].transcript; } this.finalText = f; this.interim = i; };
    rec.onerror = (e) => { this.error = e.error; };
    rec.onend = () => { if (this.rec === rec) this.rec = null; if (this.ended) { const f = this.ended; this.ended = null; f(); } };
    try { rec.start(); } catch (_) { this.rec = null; }
  }
  text() { return (this.finalText + " " + this.interim).trim(); }
  finish() {
    return new Promise((ok) => {
      if (!this.rec) return ok(this.error && !this.text() ? { ok: false, error: this.error } : { ok: true, text: this.text() });
      const timer = setTimeout(() => { this.ended = null; ok({ ok: true, text: this.text() }); this.abort(); }, 900);
      this.ended = () => { clearTimeout(timer); ok({ ok: true, text: this.text() }); };
      try { this.rec.stop(); } catch (_) { clearTimeout(timer); ok({ ok: true, text: this.text() }); }
    });
  }
  abort() { if (this.rec) { const r = this.rec; this.rec = null; try { r.abort(); } catch (_) {} } this.ended = null; }
}

/* ROYAL's voice, as the conversation's speaker. */
export class Speaker {
  constructor(voice) { this.voice = voice; this.lvl = 0; }
  speak(text, { onStart, onEnd } = {}) {
    let started = false;
    this.voice.onSpeakStart = () => { if (!started) { started = true; onStart && onStart(); } };
    return this.voice.speak(text, { onEnd: () => { this.lvl = 0; onEnd && onEnd(); } });
  }
  stop() { this.voice.stopSpeaking(); this.lvl = 0; }
  setLevel(a) { this.lvl = a; }
  level() { return this.voice.speaking ? Math.max(this.lvl, 0.15) : 0; }
}
